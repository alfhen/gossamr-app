//! What a Codex run is doing, from its run folder, its process and the processes the person has open.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Utc};

use super::events::{self, Events, Outcome};
use super::process::alive;
use super::{asked_file, create_private, events_file, process_file, read_file, run_folder, CodexBackend, FINAL_FILE, SHORT_ID_FILE, TERMINAL_FILE, TERMINAL_SEEN_FILE};
use crate::domain::{Run, RunProcess, RunState};
use crate::runs::backend::{Observation, Observations, Session, Watched};
use crate::runs::redact::redact;
use crate::runs::result::cut;
use crate::runs::state::{Observed, LAUNCH_WAIT, PROCESS_ENDED};

pub const CARRIED_ON: &str = "Carried on in Terminal";
pub const OPEN_IN_TERMINAL: &str = "Open in Terminal";
pub const GIT_SANDBOX: &str = "Codex's sandbox kept git from committing here. Only danger-full-access commits and pushes from a worktree.";

const ANSWER_MAX: u64 = 2 << 20;
const ASKED_MAX: u64 = 64 << 10;
const PROCESS_FILE_MAX: u64 = 4096;
const QUESTION_KEPT: usize = 4000;
const FAILURE_KEPT: usize = 300;
const PS_WAIT: Duration = Duration::from_secs(5);

fn turn_of(name: &str, prefix: &str, suffix: &str) -> Option<u32> {
    name.strip_prefix(prefix)?.strip_suffix(suffix)?.parse().ok()
}

/// The number of the newest turn that has an events file.
pub(super) fn newest_turn(folder: &Path) -> Option<u32> {
    std::fs::read_dir(folder).ok()?.filter_map(|e| turn_of(e.ok()?.file_name().to_str()?, "events-", ".jsonl")).max()
}

/// The process the launch or a resume recorded for `turn`.
pub(super) fn recorded_process(folder: &Path, turn: u32) -> Option<RunProcess> {
    let text = read_file(&process_file(folder, turn), PROCESS_FILE_MAX, false)?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some(RunProcess { pid: u32::try_from(value["pid"].as_u64()?).ok()?, started: value["started"].as_u64()? })
}

fn marked(folder: &Path, name: &str) -> bool {
    folder.join(name).symlink_metadata().is_ok()
}

/// The question a turn waited with, none for a file that is missing, empty, over 64 KB or a symlink.
pub(super) fn asked(folder: &Path, turn: u32) -> Option<String> {
    let path = asked_file(folder, turn);
    if path.symlink_metadata().ok()?.len() > ASKED_MAX {
        return None;
    }
    let text = read_file(&path, ASKED_MAX, false)?;
    Some(text.trim().to_owned()).filter(|t| !t.is_empty())
}

/// Keeps the held question of turn `turn` in its run folder, unless it is already there.
fn remember_ask(folder: &Path, turn: u32, question: &str) {
    let question = cut(redact(question).trim(), QUESTION_KEPT);
    if asked(folder, turn).as_deref() == Some(question.as_str()) {
        return;
    }
    let path = asked_file(folder, turn);
    let _ = std::fs::remove_file(&path);
    if let Err(e) = create_private(&path).and_then(|mut f| f.write_all(question.as_bytes())) {
        eprintln!("couldn't keep the question of a Codex run: {e}");
    }
}

/// The `codex` processes that have `thread` among their arguments, from `ps` output (`pid pgid args`): their pids.
/// Whatever runs in the group `own_group` is the run's own, such as the native binary an npm launcher starts.
pub(super) fn processes_on(listing: &str, thread: &str, own_group: Option<u32>) -> Vec<u32> {
    listing
        .lines()
        .filter_map(|line| {
            let (pid, rest) = line.trim_start().split_once(char::is_whitespace)?;
            let (group, args) = rest.trim_start().split_once(char::is_whitespace)?;
            if own_group.is_some() && group.parse().ok() == own_group {
                return None;
            }
            let words: Vec<&str> = args.split_whitespace().collect();
            let runs_codex = words.iter().take(2).any(|w| w.rsplit('/').next().is_some_and(|name| name.contains("codex")));
            (runs_codex && words.contains(&thread)).then(|| pid.parse().ok()).flatten()
        })
        .collect()
}

async fn process_listing() -> String {
    let run = tokio::process::Command::new("ps").args(["-axo", "pid=,pgid=,args="]).kill_on_drop(true).output();
    match tokio::time::timeout(PS_WAIT, run).await {
        Ok(Ok(out)) => String::from_utf8_lossy(&out.stdout).into_owned(),
        _ => String::new(),
    }
}

fn seen(state: RunState) -> Observed {
    Observed { state, text: None, error: None, result: None, pid_misses: 0, idle_polls: 0 }
}

/// The answer of the newest turn: the `-o` file, else the last message the agent printed.
fn answer_in(folder: &Path, events: &Events) -> Option<String> {
    let from_file = read_file(&folder.join(FINAL_FILE), ANSWER_MAX, false).map(|t| t.trim().to_owned()).filter(|t| !t.is_empty());
    from_file.or_else(|| events.last_message.clone())
}

struct Look<'a> {
    run: &'a Run,
    folder: PathBuf,
    turn: u32,
    events: Events,
    process: Option<RunProcess>,
}

impl Look<'_> {
    fn observation(&self, mut seen: Observed, detail: Option<String>, revived: bool) -> Observation {
        let finished = seen.state == RunState::Done;
        let answer = finished.then(|| answer_in(&self.folder, &self.events)).flatten();
        if finished {
            seen.result = answer.clone();
        }
        let thread = self.run.session_id.clone().or_else(|| self.events.thread.clone());
        Observation {
            run_id: self.run.id.clone(),
            session: self.run.short_id.clone().map(|short_id| Session { short_id, session_id: thread, process: self.process.clone() }),
            tokens: Some(self.events.tokens).filter(|t| *t > 0),
            detail: detail.or_else(|| self.events.git_blocked.then(|| GIT_SANDBOX.to_owned())).or_else(|| self.events.detail.clone()),
            branch: Some(format!("worktree-{}", self.run.spec.name)),
            progress_at: std::fs::metadata(events_file(&self.folder, self.turn)).and_then(|m| m.modified()).ok().map(DateTime::<Utc>::from),
            suggested_reply: None,
            timeline: self.events.timeline.clone(),
            seen,
            answer,
            revived,
        }
    }

    fn working(&self, finished: bool, detail: Option<&str>) -> Observation {
        self.observation(seen(RunState::Working), detail.map(str::to_owned), finished)
    }

    fn needs_answer(&self, question: String, revived: bool) -> Observation {
        self.observation(Observed { text: Some(question), ..seen(RunState::NeedsAnswer) }, None, revived)
    }
}

impl CodexBackend {
    pub(super) async fn look(&self, watched: &[Watched], now: DateTime<Utc>) -> Observations {
        let listing = if watched.iter().any(|w| w.run.session_id.is_some()) { process_listing().await } else { String::new() };
        let runs = watched.iter().filter_map(|w| self.look_at(w, &listing, now)).collect();
        Observations { runs, sessions: Vec::new() }
    }

    fn look_at(&self, w: &Watched, listing: &str, now: DateTime<Utc>) -> Option<Observation> {
        let run = &w.run;
        if run.state == RunState::Queued {
            return None;
        }
        let folder = run_folder(&self.runs_root, &run.id)?;
        let turn = newest_turn(&folder).unwrap_or(1);
        let events = events::read(&events_file(&folder, turn));
        let process = recorded_process(&folder, turn).or_else(|| run.process.clone());
        let look = Look { run, folder, turn, events, process };
        let at_rest = matches!(run.state, RunState::Done | RunState::Stopped);
        let own_alive = look.process.as_ref().is_some_and(alive);
        let terminal = marked(&look.folder, TERMINAL_FILE);

        let thread = run.session_id.clone().or_else(|| look.events.thread.clone());
        let own_group = look.process.as_ref().map(|p| p.pid);
        let in_terminal = thread.as_deref().is_some_and(|t| !processes_on(listing, t, own_group).is_empty());
        if in_terminal {
            if terminal && !marked(&look.folder, TERMINAL_SEEN_FILE) {
                let _ = create_private(&look.folder.join(TERMINAL_SEEN_FILE));
            }
            return Some(look.working(at_rest, Some(OPEN_IN_TERMINAL)));
        }
        if own_alive {
            return Some(match &w.ask {
                Some(question) => {
                    remember_ask(&look.folder, turn, question);
                    look.needs_answer(cut(redact(question).trim(), QUESTION_KEPT), at_rest)
                }
                None => look.working(at_rest, None),
            });
        }
        if terminal && marked(&look.folder, TERMINAL_SEEN_FILE) {
            return (run.state != RunState::Done).then(|| look.observation(seen(RunState::Done), Some(CARRIED_ON.to_owned()), false));
        }
        if at_rest {
            return None;
        }
        if look.events.thread.is_none() && look.events.outcome.is_none() && run.state == RunState::Launching {
            let since = run.launched_at.unwrap_or(run.last_progress_at);
            let waited = (now - since).to_std().is_ok_and(|waited| waited >= LAUNCH_WAIT);
            let state = if waited { Observed { error: Some("Codex didn't start a session".into()), ..seen(RunState::Failed) } } else { seen(RunState::Launching) };
            return Some(look.observation(state, None, false));
        }
        Some(match &look.events.outcome {
            Some(Outcome::Completed) => match asked(&look.folder, turn) {
                Some(question) => look.needs_answer(question, false),
                None => look.observation(seen(RunState::Done), None, false),
            },
            Some(Outcome::Failed(message)) => {
                let why = cut(redact(message).trim(), FAILURE_KEPT);
                look.observation(Observed { error: Some(why), ..seen(RunState::Failed) }, None, false)
            }
            None => look.observation(Observed { error: Some(PROCESS_ENDED.into()), ..seen(RunState::Failed) }, None, false),
        })
    }

    /// The run's session as its run folder remembers it: its recorded process while that is alive, or the finished turn
    /// that process left.
    pub(super) fn find_run(&self, run: &Run) -> Option<Session> {
        let folder = run_folder(&self.runs_root, &run.id)?;
        let turn = newest_turn(&folder)?;
        let short_id = run.short_id.clone().or_else(|| crate::runs::cli::ShortId::parse(read_file(&folder.join(SHORT_ID_FILE), 16, false)?.trim()))?;
        let events = events::read(&events_file(&folder, turn));
        let process = recorded_process(&folder, turn);
        let running = process.as_ref().is_some_and(alive);
        (running || events.outcome.is_some()).then(|| Session { short_id, session_id: events.thread.or_else(|| run.session_id.clone()), process })
    }

    pub(super) fn answer_of(&self, run: &Run) -> Option<String> {
        let folder = run_folder(&self.runs_root, &run.id)?;
        let events = events::read(&events_file(&folder, newest_turn(&folder).unwrap_or(1)));
        answer_in(&folder, &events)
    }
}
