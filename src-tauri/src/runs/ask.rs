//! Questions an agent put through the `ask` tool and is still waiting on, and how many calls each run has made to the
//! tools that read or wait. They live in memory: when the app quits the call fails in the agent, whose tool description
//! says to end its turn with the question instead, and the counts start again.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{oneshot, Notify};

/// How long one `ask` call waits. It has to stay under `AGENT_CALL_TIMEOUT_MS`, which is when the session gives up.
pub const ASK_WAIT: Duration = Duration::from_secs(9 * 60);

struct Pending {
    id: u64,
    question: String,
    reply: oneshot::Sender<String>,
}

struct Inner {
    pending: Mutex<HashMap<String, Pending>>,
    calls: Mutex<HashMap<String, u32>>,
    wait: Mutex<Duration>,
    next: AtomicU64,
    opened: Notify,
}

#[derive(Clone)]
pub struct Asks {
    inner: Arc<Inner>,
}

impl Default for Asks {
    fn default() -> Self {
        Self { inner: Arc::new(Inner { pending: Mutex::new(HashMap::new()), calls: Mutex::new(HashMap::new()), wait: Mutex::new(ASK_WAIT), next: AtomicU64::new(1), opened: Notify::new() }) }
    }
}

/// One call's wait. Dropping it, as when the session hangs up, takes the question back.
pub struct Waiting {
    run_id: String,
    id: u64,
    reply: oneshot::Receiver<String>,
    inner: Arc<Inner>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Answered(String),
    TimedOut,
    /// The run ended or was stopped while it waited.
    Cancelled,
}

#[derive(Debug, PartialEq, Eq)]
pub struct AlreadyAsking;

impl Asks {
    /// Puts `question` up for run `run_id`. A run has one question at a time.
    pub fn open(&self, run_id: &str, question: &str) -> Result<Waiting, AlreadyAsking> {
        let (reply, receiver) = oneshot::channel();
        let id = self.inner.next.fetch_add(1, Ordering::Relaxed);
        {
            let mut pending = self.inner.pending.lock().expect("asks lock poisoned");
            if pending.contains_key(run_id) {
                return Err(AlreadyAsking);
            }
            pending.insert(run_id.to_owned(), Pending { id, question: question.to_owned(), reply });
        }
        self.inner.opened.notify_one();
        Ok(Waiting { run_id: run_id.to_owned(), id, reply: receiver, inner: self.inner.clone() })
    }

    /// What the run is asking now, if it is waiting on an answer.
    pub fn question(&self, run_id: &str) -> Option<String> {
        self.inner.pending.lock().expect("asks lock poisoned").get(run_id).map(|p| p.question.clone())
    }

    /// Hands `text` to the waiting call. False when nothing was waiting.
    pub fn answer(&self, run_id: &str, text: &str) -> bool {
        let taken = self.inner.pending.lock().expect("asks lock poisoned").remove(run_id);
        taken.is_some_and(|p| p.reply.send(text.to_owned()).is_ok())
    }

    /// Counts one more call by the run and returns how many it has made.
    pub fn count_call(&self, run_id: &str) -> u32 {
        let mut calls = self.inner.calls.lock().expect("asks lock poisoned");
        let made = calls.entry(run_id.to_owned()).or_insert(0);
        *made += 1;
        *made
    }

    /// Drops what is kept for a run that is gone.
    pub fn forget(&self, run_id: &str) {
        self.inner.calls.lock().expect("asks lock poisoned").remove(run_id);
        self.cancel(run_id);
    }

    /// Ends the wait without an answer.
    pub fn cancel(&self, run_id: &str) {
        self.inner.pending.lock().expect("asks lock poisoned").remove(run_id);
    }

    pub fn wait(&self) -> Duration {
        *self.inner.wait.lock().expect("ask wait lock poisoned")
    }

    #[cfg(test)]
    pub fn set_wait(&self, wait: Duration) {
        *self.inner.wait.lock().expect("ask wait lock poisoned") = wait;
    }

    /// Resolves once a question has been put up since the last time it did, so the tracker looks at the run now.
    pub async fn opened(&self) {
        self.inner.opened.notified().await;
    }
}

impl Waiting {
    pub async fn until(mut self, wait: Duration) -> Outcome {
        match tokio::time::timeout(wait, &mut self.reply).await {
            Ok(Ok(text)) => Outcome::Answered(text),
            Ok(Err(_)) => Outcome::Cancelled,
            Err(_) => {
                // Closing first makes a late `answer` fail instead of reaching a call that has already given up.
                self.reply.close();
                match self.reply.try_recv() {
                    Ok(text) => Outcome::Answered(text),
                    Err(_) => Outcome::TimedOut,
                }
            }
        }
    }
}

impl Drop for Waiting {
    fn drop(&mut self) {
        let mut pending = self.inner.pending.lock().expect("asks lock poisoned");
        if pending.get(&self.run_id).is_some_and(|p| p.id == self.id) {
            pending.remove(&self.run_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_question_waits_for_its_answer_and_a_run_has_one_at_a_time() {
        let asks = Asks::default();
        let waiting = asks.open("r1", "Which branch?").unwrap();
        assert_eq!(asks.question("r1").as_deref(), Some("Which branch?"));
        assert_eq!(asks.open("r1", "Again?").err(), Some(AlreadyAsking));
        assert!(asks.open("r2", "Other run").is_ok(), "another run is not held up");
        assert!(asks.answer("r1", "main"));
        assert_eq!(waiting.until(Duration::from_secs(1)).await, Outcome::Answered("main".into()));
        assert_eq!(asks.question("r1"), None);
        assert!(!asks.answer("r1", "late"), "nothing is waiting any more");
    }

    #[tokio::test]
    async fn a_wait_that_runs_out_or_is_cancelled_or_dropped_leaves_nothing_behind() {
        let asks = Asks::default();
        let timed_out = asks.open("r1", "q").unwrap();
        assert_eq!(timed_out.until(Duration::from_millis(20)).await, Outcome::TimedOut);
        assert_eq!(asks.question("r1"), None);

        let cancelled = asks.open("r1", "q").unwrap();
        asks.cancel("r1");
        assert_eq!(cancelled.until(Duration::from_secs(1)).await, Outcome::Cancelled);

        drop(asks.open("r1", "q").unwrap());
        assert_eq!(asks.question("r1"), None, "a call that hung up takes its question with it");
        let first = asks.open("r1", "q").unwrap();
        asks.cancel("r1");
        let second = asks.open("r1", "q2").unwrap();
        drop(first);
        assert_eq!(asks.question("r1").as_deref(), Some("q2"), "an old call never takes a newer question");
        drop(second);
    }
}
