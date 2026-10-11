//! Which of Pip's turns may run now. Each conversation answers one turn at a time, in the order the turns were sent,
//! and no more than `PIP_PROCESSES` turns run at once across all conversations. This is the bookkeeping only: it
//! starts and stops nothing, so `AgentService` does that with what it returns.
//!
//! Only questions a person sent are queued today. A later "wake" item, Pip picking a conversation back up on its own,
//! slots in through `Queued::preempted_by_user`: a wake says yes, so a person's message goes ahead of it while it
//! waits, and it never holds a person up.

use std::collections::{HashMap, VecDeque};

use super::{AskRequest, UpdateSink};
use crate::auth::Scope;

/// How many of Pip's agent processes may run at the same time, across every conversation.
pub const PIP_PROCESSES: usize = 2;

/// What the queue needs to know about a waiting item to order it.
pub trait Queued {
    /// Whether a person's message sent later still goes ahead of this item while it waits. A person's own messages
    /// say no, so they keep the order they were sent in.
    fn preempted_by_user(&self) -> bool;
}

/// A turn waiting to run, with all it needs to start.
pub enum QueueItem {
    /// A question a person sent, the account it was asked in, and where its events go.
    User { scope: Scope, req: AskRequest, sink: UpdateSink },
}

impl Queued for QueueItem {
    fn preempted_by_user(&self) -> bool {
        match self {
            QueueItem::User { .. } => false,
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum Enqueued<T> {
    /// Nothing is in the way: start it now. It counts as running from here.
    Start(T),
    /// It waits; `ahead` turns of its own conversation are in front of it, the running one included. Zero means it
    /// only waits for room.
    Waiting { ahead: usize },
}

#[derive(Debug, PartialEq)]
pub enum Removed<T> {
    /// It had not started and never will.
    Waiting(T),
    /// It is running; stopping it is the caller's job, and its end comes through `finished` as usual.
    InFlight,
    Unknown,
}

struct Entry<T> {
    id: String,
    order: u64,
    item: T,
}

struct Lane<T> {
    in_flight: Option<String>,
    waiting: VecDeque<Entry<T>>,
}

impl<T> Default for Lane<T> {
    fn default() -> Self {
        Self { in_flight: None, waiting: VecDeque::new() }
    }
}

pub struct TurnQueue<T> {
    lanes: HashMap<String, Lane<T>>,
    /// The conversation of every turn waiting or running.
    owner: HashMap<String, String>,
    /// The session each conversation's last turn ended with, for a turn sent before it was known.
    sessions: HashMap<String, String>,
    cap: usize,
    next: u64,
}

impl<T: Queued> Default for TurnQueue<T> {
    fn default() -> Self {
        Self::new(PIP_PROCESSES)
    }
}

impl<T: Queued> TurnQueue<T> {
    pub fn new(cap: usize) -> Self {
        Self { lanes: HashMap::new(), owner: HashMap::new(), sessions: HashMap::new(), cap: cap.max(1), next: 0 }
    }

    fn running(&self) -> usize {
        self.lanes.values().filter(|l| l.in_flight.is_some()).count()
    }

    /// Adds a turn to `conversation`. An id already waiting or running is the caller's mistake; it is queued again.
    pub fn enqueue(&mut self, conversation: &str, request_id: &str, item: T) -> Enqueued<T> {
        let room = self.running() < self.cap;
        let lane = self.lanes.entry(conversation.to_string()).or_default();
        self.owner.insert(request_id.to_string(), conversation.to_string());
        if room && lane.in_flight.is_none() && lane.waiting.is_empty() {
            lane.in_flight = Some(request_id.to_string());
            return Enqueued::Start(item);
        }
        self.next += 1;
        let entry = Entry { id: request_id.to_string(), order: self.next, item };
        // A person's message goes ahead of anything waiting that gives way to one; nothing does yet.
        let at = match entry.item.preempted_by_user() {
            true => lane.waiting.len(),
            false => lane.waiting.iter().position(|e| e.item.preempted_by_user()).unwrap_or(lane.waiting.len()),
        };
        lane.waiting.insert(at, entry);
        Enqueued::Waiting { ahead: at + usize::from(lane.in_flight.is_some()) }
    }

    /// Ends the running turn `request_id`, keeping the session it ended with for its conversation, and returns the
    /// turns that may start now, oldest first. They count as running from here. Anything but a running turn is ignored.
    pub fn finished(&mut self, request_id: &str, session: Option<String>) -> Vec<(String, T)> {
        let Some(conversation) = self.owner.get(request_id).cloned() else { return Vec::new() };
        let Some(lane) = self.lanes.get_mut(&conversation) else { return Vec::new() };
        if lane.in_flight.as_deref() != Some(request_id) {
            return Vec::new();
        }
        lane.in_flight = None;
        self.owner.remove(request_id);
        if let Some(s) = session {
            self.sessions.insert(conversation, s);
        }
        let mut started = Vec::new();
        while self.running() < self.cap {
            let next = self
                .lanes
                .iter()
                .filter(|(_, l)| l.in_flight.is_none())
                .filter_map(|(c, l)| l.waiting.front().map(|e| (e.order, c.clone())))
                .min();
            let Some((_, conversation)) = next else { break };
            let lane = self.lanes.get_mut(&conversation).expect("the lane was just found");
            let entry = lane.waiting.pop_front().expect("the lane has a waiting turn");
            lane.in_flight = Some(entry.id.clone());
            started.push((entry.id, entry.item));
        }
        self.lanes.retain(|_, l| l.in_flight.is_some() || !l.waiting.is_empty());
        started
    }

    /// Takes a waiting turn out of the queue. A running one stays where it is.
    pub fn remove(&mut self, request_id: &str) -> Removed<T> {
        let Some(conversation) = self.owner.get(request_id).cloned() else { return Removed::Unknown };
        let Some(lane) = self.lanes.get_mut(&conversation) else { return Removed::Unknown };
        if lane.in_flight.as_deref() == Some(request_id) {
            return Removed::InFlight;
        }
        let Some(at) = lane.waiting.iter().position(|e| e.id == request_id) else { return Removed::Unknown };
        let entry = lane.waiting.remove(at).expect("the position was just found");
        self.owner.remove(request_id);
        self.lanes.retain(|_, l| l.in_flight.is_some() || !l.waiting.is_empty());
        Removed::Waiting(entry.item)
    }

    /// How many turns of its conversation are ahead of `request_id`: 0 for the running one, None when it is neither
    /// waiting nor running.
    pub fn position(&self, request_id: &str) -> Option<usize> {
        let lane = self.lanes.get(self.owner.get(request_id)?)?;
        if lane.in_flight.as_deref() == Some(request_id) {
            return Some(0);
        }
        lane.waiting.iter().position(|e| e.id == request_id).map(|at| at + usize::from(lane.in_flight.is_some()))
    }

    /// The session `conversation`'s last finished turn ended with.
    pub fn session(&self, conversation: &str) -> Option<String> {
        self.sessions.get(conversation).cloned()
    }

    #[cfg(test)]
    fn in_flight(&self) -> usize {
        self.running()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::collections::BTreeMap;

    /// A stand-in for a turn: its id, the session the page sent, and whether it gives way to a person's message.
    #[derive(Debug, Clone, PartialEq)]
    struct Item {
        id: String,
        session: Option<String>,
        wake: bool,
    }

    impl Queued for Item {
        fn preempted_by_user(&self) -> bool {
            self.wake
        }
    }

    fn user(id: &str) -> Item {
        Item { id: id.into(), session: None, wake: false }
    }

    fn ids(started: Vec<(String, Item)>) -> Vec<String> {
        started.into_iter().map(|(id, item)| {
            assert_eq!(id, item.id, "the item started is the one with that id");
            id
        }).collect()
    }

    #[test]
    fn a_conversation_answers_in_order_one_at_a_time() {
        let mut q = TurnQueue::default();
        assert_eq!(q.enqueue("A", "a1", user("a1")), Enqueued::Start(user("a1")));
        assert_eq!(q.enqueue("A", "a2", user("a2")), Enqueued::Waiting { ahead: 1 });
        assert_eq!(q.enqueue("A", "a3", user("a3")), Enqueued::Waiting { ahead: 2 });
        assert_eq!(q.in_flight(), 1, "one per conversation, though there is room for two");
        assert_eq!(ids(q.finished("a1", None)), ["a2"]);
        assert_eq!(ids(q.finished("a2", None)), ["a3"]);
        assert!(q.finished("a3", None).is_empty());
        assert_eq!(q.in_flight(), 0);
    }

    #[test]
    fn three_conversations_share_two_processes() {
        let mut q = TurnQueue::default();
        assert!(matches!(q.enqueue("A", "a1", user("a1")), Enqueued::Start(_)));
        assert!(matches!(q.enqueue("B", "b1", user("b1")), Enqueued::Start(_)));
        assert_eq!(q.enqueue("C", "c1", user("c1")), Enqueued::Waiting { ahead: 0 });
        assert_eq!(q.in_flight(), 2);
        assert_eq!(ids(q.finished("b1", None)), ["c1"]);
        assert_eq!(q.in_flight(), 2);
    }

    #[test]
    fn finishing_releases_the_oldest_waiting_turns_that_may_run() {
        let mut q = TurnQueue::new(2);
        q.enqueue("A", "a1", user("a1"));
        q.enqueue("A", "a2", user("a2"));
        q.enqueue("B", "b1", user("b1"));
        q.enqueue("C", "c1", user("c1"));
        q.enqueue("B", "b2", user("b2"));
        // a2 was sent before c1, and A is free once a1 ends; B still runs b1.
        assert_eq!(ids(q.finished("a1", None)), ["a2"]);
        assert_eq!(ids(q.finished("b1", None)), ["c1"]);
        assert_eq!(ids(q.finished("c1", None)), ["b2"]);
    }

    #[test]
    fn the_cap_is_never_exceeded_whatever_the_order() {
        let mut q = TurnQueue::default();
        let mut running = Vec::new();
        for (i, c) in ["A", "B", "C", "D", "A", "B", "C", "D"].iter().enumerate() {
            let id = format!("{c}{i}");
            if let Enqueued::Start(_) = q.enqueue(c, &id, user(&id)) {
                running.push(id);
            }
            assert!(q.in_flight() <= PIP_PROCESSES);
        }
        while let Some(id) = running.pop() {
            running.extend(ids(q.finished(&id, None)));
            assert!(q.in_flight() <= PIP_PROCESSES && running.len() <= PIP_PROCESSES);
        }
        assert_eq!(q.in_flight(), 0);
    }

    #[test]
    fn a_waiting_turn_can_be_removed_and_a_running_one_is_only_reported() {
        let mut q = TurnQueue::default();
        q.enqueue("A", "a1", user("a1"));
        q.enqueue("A", "a2", user("a2"));
        q.enqueue("A", "a3", user("a3"));
        assert_eq!(q.remove("a2"), Removed::Waiting(user("a2")));
        assert_eq!(q.position("a3"), Some(1));
        assert_eq!(q.remove("a1"), Removed::InFlight);
        assert_eq!(q.position("a1"), Some(0), "still running until it finishes");
        assert_eq!(ids(q.finished("a1", None)), ["a3"]);
    }

    #[test]
    fn unknown_ids_change_nothing() {
        let mut q = TurnQueue::default();
        q.enqueue("A", "a1", user("a1"));
        q.enqueue("A", "a2", user("a2"));
        assert!(q.finished("nope", Some("s".into())).is_empty());
        assert!(q.finished("a2", None).is_empty(), "a waiting turn has not finished");
        assert_eq!(q.remove("nope"), Removed::Unknown);
        assert_eq!(q.position("nope"), None);
        assert_eq!(q.session("A"), None);
        assert_eq!(ids(q.finished("a1", Some("s-a".into()))), ["a2"]);
        assert!(q.finished("a1", None).is_empty(), "finishing twice is a no-op");
        assert_eq!(q.session("A").as_deref(), Some("s-a"));
    }

    #[test]
    fn a_person_goes_ahead_of_anything_that_gives_way_to_them() {
        let wake = |id: &str| Item { id: id.into(), session: None, wake: true };
        let mut q = TurnQueue::default();
        q.enqueue("A", "a1", user("a1"));
        assert_eq!(q.enqueue("A", "w1", wake("w1")), Enqueued::Waiting { ahead: 1 });
        assert_eq!(q.enqueue("A", "a2", user("a2")), Enqueued::Waiting { ahead: 1 }, "the person's message jumps the wake");
        assert_eq!(q.enqueue("A", "a3", user("a3")), Enqueued::Waiting { ahead: 2 }, "and people keep their own order");
        assert_eq!(q.position("w1"), Some(3));
        assert_eq!(ids(q.finished("a1", None)), ["a2"]);
        assert_eq!(ids(q.finished("a2", None)), ["a3"]);
        assert_eq!(ids(q.finished("a3", None)), ["w1"]);
    }

    #[derive(Deserialize)]
    struct Case {
        name: String,
        steps: Vec<Step>,
        statuses: BTreeMap<String, String>,
    }

    #[derive(Deserialize)]
    #[serde(tag = "op", rename_all = "camelCase")]
    enum Step {
        Enqueue { id: String, conversation: String, #[serde(default)] session: Option<String>, expect: Expect },
        Finish { id: String, session: Option<String>, #[serde(default = "yes")] ok: bool, started: Vec<Started> },
        Remove { id: String, expect: String },
        Position { id: String, expect: Option<usize> },
    }

    fn yes() -> bool {
        true
    }

    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Expect {
        Start(String),
        Waiting { waiting: usize },
    }

    #[derive(Deserialize, Debug, PartialEq)]
    struct Started {
        id: String,
        session: Option<String>,
    }

    /// The scripted steps the sample backend's queue runs too (src/backend/mockPipQueue.test.ts), so the two agree.
    #[test]
    fn the_shared_cases_pass() {
        let cases: Vec<Case> = serde_json::from_str(include_str!("../../test-support/pip-queue-cases.json")).unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let mut q = TurnQueue::default();
            let mut statuses = BTreeMap::new();
            let mut conversations = HashMap::new();
            for (n, step) in case.steps.into_iter().enumerate() {
                let at = format!("{} (step {n})", case.name);
                match step {
                    Step::Enqueue { id, conversation, session, expect } => {
                        conversations.insert(id.clone(), conversation.clone());
                        let got = q.enqueue(&conversation, &id, Item { id: id.clone(), session, wake: false });
                        match (got, expect) {
                            (Enqueued::Start(_), Expect::Start(s)) if s == "start" => statuses.insert(id, "running".to_string()),
                            (Enqueued::Waiting { ahead }, Expect::Waiting { waiting }) if ahead == waiting => statuses.insert(id, "queued".to_string()),
                            (got, _) => panic!("{at}: enqueue gave {got:?}"),
                        };
                    }
                    Step::Finish { id, session, ok, started } => {
                        let was_running = q.position(&id) == Some(0) && statuses.get(&id).is_some_and(|s| s == "running");
                        let got: Vec<Started> = q
                            .finished(&id, session)
                            .into_iter()
                            .map(|(id, item)| {
                                let session = item.session.or_else(|| q.session(&conversations[&id]));
                                Started { id, session }
                            })
                            .collect();
                        if was_running {
                            statuses.insert(id, (if ok { "done" } else { "failed" }).to_string());
                        }
                        for s in &got {
                            statuses.insert(s.id.clone(), "running".to_string());
                        }
                        assert_eq!(got, started, "{at}");
                    }
                    Step::Remove { id, expect } => {
                        let got = match q.remove(&id) {
                            Removed::Waiting(_) => {
                                statuses.insert(id, "removed".to_string());
                                "waiting"
                            }
                            Removed::InFlight => "inFlight",
                            Removed::Unknown => "unknown",
                        };
                        assert_eq!(got, expect, "{at}");
                    }
                    Step::Position { id, expect } => assert_eq!(q.position(&id), expect, "{at}"),
                }
                assert!(q.in_flight() <= PIP_PROCESSES, "{at}");
            }
            assert_eq!(statuses, case.statuses, "{}", case.name);
        }
    }
}
