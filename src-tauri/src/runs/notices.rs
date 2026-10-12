//! When a run's news is worth a system notification: one per workstream that starts waiting on the person, not one per
//! event. Pure: the caller says what waits and when it is, and gets back the notices to show.
//!
//! A workstream notifies when a need appears in it, or a need of a higher group does (`Group`: decide over unblock over
//! approve, as docs/needs-you.md ranks them). While it stays waiting, anything else that happens in it is quiet; once nothing waits in it any more, the
//! next need notifies again. Runs in no workstream are one stream, `GENERAL`. Finished and failed runs are held for
//! `FINISH_HOLD` and sent as one notice with a count, at most one per workstream until the person looks (`looked`).
//! Digest mode sends one notice at most every `digest_every` instead, naming the workstreams that wait.

use std::collections::BTreeMap;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::notify::Notice;

/// The name of the stream of runs that belong to no workstream.
pub const GENERAL: &str = "General";
/// How long the first finished run of a workstream waits for others to join it in one notice.
pub const FINISH_HOLD: Duration = Duration::seconds(20);
pub const DIGEST_MINUTES: u32 = 30;
pub const DIGEST_MINUTES_MAX: u32 = 24 * 60;

/// Which system notifications the person gets.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoticeMode {
    /// One when a workstream starts waiting on them.
    #[default]
    Workstream,
    /// One summary at most every `digest_minutes`.
    Digest,
    Off,
}

/// What kind of wait a need is, lowest first: a higher one in a workstream that already waits is worth a new notice.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Group {
    /// A draft waits for approval, or a run start.
    Approve,
    /// Something is stuck until they act: a run's question, permission or sign-in, or a hold.
    Unblock,
    /// A choice only they make: a review escalation, a plan or description approval.
    Decide,
}

/// One thing that waits on the person. `what` reads after the run's name: "R5 wants to run a command".
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Need {
    pub group: Group,
    /// The run to open for it, when it has one.
    pub run_id: Option<String>,
    pub what: String,
    pub since: DateTime<Utc>,
}

/// Everything that waits in one stream: a workstream id, or `None` for General.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Waiting {
    pub key: Key,
    pub needs: Vec<Need>,
}

pub type Key = Option<String>;

impl Waiting {
    /// The need to open first: the highest group, then the one waiting longest.
    pub fn top(&self) -> Option<&Need> {
        self.needs.iter().max_by(|a, b| a.group.cmp(&b.group).then(b.since.cmp(&a.since)).then(b.run_id.cmp(&a.run_id)))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settings {
    pub mode: NoticeMode,
    pub digest_every: Duration,
}

/// A notice to show, and the run to open if the window is focused soon after.
#[derive(Debug, PartialEq)]
pub struct Outgoing {
    pub notice: Notice,
    pub open_run: Option<String>,
}

#[derive(Default)]
struct Stream {
    /// The highest group already announced while the stream has waited.
    notified: Option<Group>,
    done: u32,
    failed: u32,
    first_finished: Option<DateTime<Utc>>,
    last_finished: Option<String>,
    /// A finished notice went out; the rest stay quiet until the person looks.
    announced: bool,
}

impl Stream {
    fn finished(&self) -> u32 {
        self.done + self.failed
    }

    fn forget_finished(&mut self) {
        self.done = 0;
        self.failed = 0;
        self.first_finished = None;
        self.last_finished = None;
    }
}

#[derive(Default)]
pub struct Board {
    streams: BTreeMap<Key, Stream>,
    last_digest: Option<DateTime<Utc>>,
}

fn plural(n: u32, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn waiting_notice(name: &str, w: &Waiting) -> Option<Outgoing> {
    let top = w.top()?;
    let more = w.needs.len() - 1;
    let body = if more == 0 { top.what.clone() } else { format!("{} (+{more} more)", top.what) };
    Some(Outgoing { notice: Notice { title: format!("{name} is waiting on you"), body }, open_run: top.run_id.clone() })
}

fn finished_notice(name: &str, s: &Stream) -> Outgoing {
    let counts = match (s.done, s.failed) {
        (done, 0) => format!("{} finished", plural(done, "run", "runs")),
        (0, failed) => format!("{} failed", plural(failed, "run", "runs")),
        (done, failed) => format!("{} finished, {failed} failed", plural(done, "run", "runs")),
    };
    let body = if s.finished() == 1 { "Open it to see the result" } else { "Open Gossamr to see the results" };
    Outgoing { notice: Notice { title: format!("{name}: {counts}"), body: body.into() }, open_run: s.last_finished.clone() }
}

impl Board {
    /// A run in `key` finished, or failed or was stopped when `failed`.
    pub fn finished(&mut self, key: &Key, run_id: &str, failed: bool, now: DateTime<Utc>) {
        let s = self.streams.entry(key.clone()).or_default();
        if failed {
            s.failed += 1;
        } else {
            s.done += 1;
        }
        s.first_finished.get_or_insert(now);
        s.last_finished = Some(run_id.to_owned());
    }

    /// Whether finished runs are waiting to be told or have been, so their workstream's name is worth looking up.
    pub fn has_finished(&self) -> bool {
        self.streams.values().any(|s| s.finished() > 0)
    }

    /// The person looked at the app: finished runs are seen, so the next one may notify.
    pub fn looked(&mut self) {
        for s in self.streams.values_mut() {
            s.forget_finished();
            s.announced = false;
        }
    }

    /// What to show now. `waiting` is everything that waits on the person at `now`, so a stream missing from it has been
    /// dealt with and is armed again. `watching` is the person looking at the app: nothing is shown, but what they could
    /// see counts as announced. `name_of` is how a stream is called ("CA-401").
    pub fn tick(&mut self, now: DateTime<Utc>, settings: &Settings, watching: bool, waiting: &[Waiting], name_of: &dyn Fn(&Key) -> String) -> Vec<Outgoing> {
        let waiting: Vec<&Waiting> = waiting.iter().filter(|w| w.top().is_some()).collect();
        for (key, s) in &mut self.streams {
            if !waiting.iter().any(|w| &w.key == key) {
                s.notified = None;
            }
        }
        let quiet = watching || settings.mode == NoticeMode::Off;
        let mut fresh = Vec::new();
        for w in &waiting {
            let group = w.top().map(|n| n.group);
            let s = self.streams.entry(w.key.clone()).or_default();
            if s.notified < group {
                fresh.push(*w);
            }
        }
        let mut out = Vec::new();
        if quiet {
            self.mark(&waiting);
        } else if settings.mode == NoticeMode::Workstream {
            out.extend(fresh.iter().filter_map(|w| waiting_notice(&name_of(&w.key), w)));
            self.mark(&fresh);
        } else if !fresh.is_empty() && self.last_digest.is_none_or(|at| now - at >= settings.digest_every) {
            out.extend(digest(&waiting, name_of));
            self.mark(&waiting);
            self.last_digest = Some(now);
        }
        for (key, s) in &mut self.streams {
            if quiet || settings.mode == NoticeMode::Digest {
                s.forget_finished();
                s.announced = s.announced && !watching;
            } else if !s.announced && s.finished() > 0 && s.first_finished.is_some_and(|at| now - at >= FINISH_HOLD) {
                out.push(finished_notice(&name_of(key), s));
                s.forget_finished();
                s.announced = true;
            }
        }
        out
    }

    fn mark(&mut self, ws: &[&Waiting]) {
        for w in ws {
            self.streams.entry(w.key.clone()).or_default().notified = w.top().map(|n| n.group);
        }
    }
}

/// "3 workstreams wait on you", naming them: the ones needing a decision first, General last.
fn digest(waiting: &[&Waiting], name_of: &dyn Fn(&Key) -> String) -> Option<Outgoing> {
    let mut ordered: Vec<&&Waiting> = waiting.iter().collect();
    ordered.sort_by(|a, b| {
        let rank = |w: &Waiting| (w.key.is_none(), std::cmp::Reverse(w.top().map(|n| n.group)), w.top().map(|n| n.since));
        rank(a).cmp(&rank(b))
    });
    let first = ordered.first()?;
    let names: Vec<String> = ordered.iter().map(|w| name_of(&w.key)).collect();
    let title = match names.len() {
        1 => "1 workstream waits on you".to_owned(),
        n => format!("{n} workstreams wait on you"),
    };
    Some(Outgoing { notice: Notice { title, body: names.join(", ") }, open_run: first.top().and_then(|n| n.run_id.clone()) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn t(secs: i64) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 12, 9, 0, 0).unwrap() + Duration::seconds(secs)
    }

    fn need(group: Group, run: &str, what: &str) -> Need {
        Need { group, run_id: Some(run.into()), what: what.into(), since: t(0) }
    }

    fn ws(key: &str, needs: Vec<Need>) -> Waiting {
        Waiting { key: Some(key.into()), needs }
    }

    fn general(needs: Vec<Need>) -> Waiting {
        Waiting { key: None, needs }
    }

    fn name(key: &Key) -> String {
        match key.as_deref() {
            Some("w1") => "CA-401".into(),
            Some("w2") => "CA-388".into(),
            Some(other) => other.into(),
            None => GENERAL.into(),
        }
    }

    fn each() -> Settings {
        Settings { mode: NoticeMode::Workstream, digest_every: Duration::minutes(30) }
    }

    fn digest_mode() -> Settings {
        Settings { mode: NoticeMode::Digest, digest_every: Duration::minutes(30) }
    }

    fn tick(b: &mut Board, at: i64, s: &Settings, waiting: &[Waiting]) -> Vec<Outgoing> {
        b.tick(t(at), s, false, waiting, &name)
    }

    fn titles(out: &[Outgoing]) -> Vec<&str> {
        out.iter().map(|o| o.notice.title.as_str()).collect()
    }

    #[test]
    fn the_first_need_notifies_and_names_the_workstream_and_the_run() {
        let mut b = Board::default();
        let out = tick(&mut b, 0, &each(), &[ws("w1", vec![need(Group::Unblock, "r5", "R5 wants to run a command")])]);
        assert_eq!(out, vec![Outgoing { notice: Notice { title: "CA-401 is waiting on you".into(), body: "R5 wants to run a command".into() }, open_run: Some("r5".into()) }]);
    }

    #[test]
    fn nothing_waiting_sends_nothing() {
        let mut b = Board::default();
        assert!(tick(&mut b, 0, &each(), &[]).is_empty());
    }

    #[test]
    fn a_second_need_in_the_same_workstream_is_silent() {
        let mut b = Board::default();
        tick(&mut b, 0, &each(), &[ws("w1", vec![need(Group::Unblock, "r5", "R5 wants to run a command")])]);
        let both = [ws("w1", vec![need(Group::Unblock, "r5", "R5 wants to run a command"), need(Group::Unblock, "r6", "R6 wants to run a command")])];
        assert!(tick(&mut b, 5, &each(), &both).is_empty());
        assert!(tick(&mut b, 10, &each(), &both).is_empty(), "and stays quiet while it waits");
    }

    #[test]
    fn a_lower_group_need_is_silent() {
        let mut b = Board::default();
        tick(&mut b, 0, &each(), &[ws("w1", vec![need(Group::Decide, "r1", "R1 asks a question")])]);
        let more = [ws("w1", vec![need(Group::Decide, "r1", "R1 asks a question"), need(Group::Approve, "r2", "R2 left a draft")])];
        assert!(tick(&mut b, 5, &each(), &more).is_empty());
    }

    #[test]
    fn a_higher_group_notifies_again_and_names_the_top_need() {
        let mut b = Board::default();
        let approve = need(Group::Approve, "r2", "R2 left a draft");
        assert_eq!(tick(&mut b, 0, &each(), &[ws("w1", vec![approve.clone()])]).len(), 1);
        let unblock = need(Group::Unblock, "r3", "R3 wants to run a command");
        let out = tick(&mut b, 5, &each(), &[ws("w1", vec![approve.clone(), unblock.clone()])]);
        assert_eq!(out.len(), 1);
        assert_eq!((out[0].notice.body.as_str(), out[0].open_run.as_deref()), ("R3 wants to run a command (+1 more)", Some("r3")));
        let decide = need(Group::Decide, "r4", "R4 asks a question");
        let out = tick(&mut b, 10, &each(), &[ws("w1", vec![approve.clone(), unblock.clone(), decide.clone()])]);
        assert_eq!(out[0].open_run.as_deref(), Some("r4"));
        let all = [ws("w1", vec![approve, unblock, decide])];
        assert!(tick(&mut b, 15, &each(), &all).is_empty(), "the top group is already announced");
    }

    #[test]
    fn a_need_without_a_run_notifies_and_opens_nothing() {
        let mut b = Board::default();
        let hold = Need { group: Group::Unblock, run_id: None, what: "It is on hold until you resume it".into(), since: t(0) };
        let out = tick(&mut b, 0, &each(), &[ws("w1", vec![hold])]);
        assert_eq!((titles(&out), out[0].open_run.clone()), (vec!["CA-401 is waiting on you"], None));
    }

    #[test]
    fn the_top_need_is_the_highest_group_then_the_oldest() {
        let mut old = need(Group::Unblock, "old", "x");
        old.since = t(-100);
        let w = ws("w1", vec![need(Group::Unblock, "new", "y"), old, need(Group::Approve, "draft", "z")]);
        assert_eq!(w.top().unwrap().run_id.as_deref(), Some("old"));
    }

    #[test]
    fn once_everything_is_dealt_with_the_workstream_is_armed_again() {
        let mut b = Board::default();
        let waiting = [ws("w1", vec![need(Group::Unblock, "r5", "R5 wants to run a command")])];
        assert_eq!(tick(&mut b, 0, &each(), &waiting).len(), 1);
        assert!(tick(&mut b, 5, &each(), &waiting).is_empty());
        assert!(tick(&mut b, 10, &each(), &[]).is_empty());
        assert_eq!(tick(&mut b, 15, &each(), &waiting).len(), 1);
    }

    #[test]
    fn dealing_with_one_of_two_needs_does_not_re_arm() {
        let mut b = Board::default();
        let two = [ws("w1", vec![need(Group::Unblock, "r5", "a"), need(Group::Unblock, "r6", "b")])];
        tick(&mut b, 0, &each(), &two);
        let one = [ws("w1", vec![need(Group::Unblock, "r6", "b")])];
        assert!(tick(&mut b, 5, &each(), &one).is_empty());
        assert!(tick(&mut b, 10, &each(), &two).is_empty());
    }

    #[test]
    fn workstreams_notify_independently() {
        let mut b = Board::default();
        tick(&mut b, 0, &each(), &[ws("w1", vec![need(Group::Unblock, "r5", "a")])]);
        let out = tick(&mut b, 5, &each(), &[ws("w1", vec![need(Group::Unblock, "r5", "a")]), ws("w2", vec![need(Group::Decide, "r7", "b")])]);
        assert_eq!(titles(&out), ["CA-388 is waiting on you"]);
    }

    #[test]
    fn runs_in_no_workstream_are_grouped_under_general_with_the_same_rule() {
        let mut b = Board::default();
        let a = need(Group::Unblock, "g1", "acme/shop wants to run a command");
        let out = tick(&mut b, 0, &each(), &[general(vec![a.clone()])]);
        assert_eq!(titles(&out), ["General is waiting on you"]);
        let b2 = need(Group::Unblock, "g2", "acme/api wants to run a command");
        assert!(tick(&mut b, 5, &each(), &[general(vec![a.clone(), b2.clone()])]).is_empty());
        let q = need(Group::Decide, "g3", "acme/web asks a question");
        assert_eq!(tick(&mut b, 10, &each(), &[general(vec![a, b2, q])]).len(), 1);
        assert!(tick(&mut b, 15, &each(), &[]).is_empty());
    }

    #[test]
    fn finished_runs_are_held_then_sent_as_one_notice_with_a_count() {
        let mut b = Board::default();
        let key = Some("w1".to_owned());
        b.finished(&key, "r1", false, t(0));
        assert!(tick(&mut b, 5, &each(), &[]).is_empty(), "held for others to join");
        b.finished(&key, "r2", false, t(10));
        let out = tick(&mut b, 20, &each(), &[]);
        assert_eq!(titles(&out), ["CA-401: 2 runs finished"]);
        assert_eq!(out[0].open_run.as_deref(), Some("r2"));
        assert!(tick(&mut b, 60, &each(), &[]).is_empty(), "sent once");
    }

    #[test]
    fn a_single_finish_and_a_failure_read_plainly() {
        let mut b = Board::default();
        let key = Some("w1".to_owned());
        b.finished(&key, "r1", false, t(0));
        assert_eq!(titles(&tick(&mut b, 20, &each(), &[])), ["CA-401: 1 run finished"]);
        b.looked();
        b.finished(&key, "r2", true, t(100));
        assert_eq!(titles(&tick(&mut b, 120, &each(), &[])), ["CA-401: 1 run failed"]);
        b.looked();
        b.finished(&key, "r3", false, t(200));
        b.finished(&key, "r4", false, t(201));
        b.finished(&key, "r5", true, t(202));
        assert_eq!(titles(&tick(&mut b, 220, &each(), &[])), ["CA-401: 2 runs finished, 1 failed"]);
    }

    #[test]
    fn more_finishes_stay_quiet_until_the_person_looks() {
        let mut b = Board::default();
        let key = Some("w1".to_owned());
        b.finished(&key, "r1", false, t(0));
        assert_eq!(tick(&mut b, 20, &each(), &[]).len(), 1);
        b.finished(&key, "r2", false, t(30));
        assert!(tick(&mut b, 60, &each(), &[]).is_empty());
        b.looked();
        assert!(tick(&mut b, 80, &each(), &[]).is_empty(), "what they looked at is seen");
        b.finished(&key, "r3", false, t(100));
        assert_eq!(titles(&tick(&mut b, 130, &each(), &[])), ["CA-401: 1 run finished"]);
    }

    #[test]
    fn finished_runs_coalesce_per_workstream_and_general() {
        let mut b = Board::default();
        b.finished(&Some("w1".into()), "r1", false, t(0));
        b.finished(&Some("w2".into()), "r2", false, t(0));
        b.finished(&None, "r3", false, t(0));
        b.finished(&None, "r4", true, t(1));
        let out = tick(&mut b, 25, &each(), &[]);
        let mut got = titles(&out);
        got.sort_unstable();
        assert_eq!(got, ["CA-388: 1 run finished", "CA-401: 1 run finished", "General: 1 run finished, 1 failed"]);
    }

    #[test]
    fn being_watched_shows_nothing_but_counts_as_seen() {
        let mut b = Board::default();
        let waiting = [ws("w1", vec![need(Group::Unblock, "r5", "a")])];
        b.finished(&Some("w1".into()), "r1", false, t(0));
        assert!(b.tick(t(30), &each(), true, &waiting, &name).is_empty());
        assert!(tick(&mut b, 35, &each(), &waiting).is_empty(), "already seen");
        b.finished(&Some("w1".into()), "r2", false, t(40));
        assert_eq!(titles(&tick(&mut b, 70, &each(), &[])), ["CA-401: 1 run finished"], "looking re-armed finished notices");
    }

    #[test]
    fn off_sends_nothing() {
        let off = Settings { mode: NoticeMode::Off, digest_every: Duration::minutes(30) };
        let mut b = Board::default();
        b.finished(&Some("w1".into()), "r1", false, t(0));
        assert!(tick(&mut b, 100, &off, &[ws("w1", vec![need(Group::Decide, "r5", "a")]), general(vec![need(Group::Unblock, "g", "b")])]).is_empty());
        assert!(tick(&mut b, 200, &each(), &[ws("w1", vec![need(Group::Decide, "r5", "a")])]).is_empty(), "switching on doesn't announce what was already waiting");
        assert!(tick(&mut b, 300, &each(), &[]).is_empty(), "and nothing finished is left over");
    }

    #[test]
    fn a_digest_names_the_waiting_workstreams_and_general_last() {
        let mut b = Board::default();
        let waiting = [
            general(vec![need(Group::Unblock, "g1", "a")]),
            ws("w2", vec![need(Group::Approve, "r8", "b")]),
            ws("w1", vec![need(Group::Decide, "r5", "c")]),
        ];
        let out = tick(&mut b, 0, &digest_mode(), &waiting);
        assert_eq!(out.len(), 1);
        assert_eq!((out[0].notice.title.as_str(), out[0].notice.body.as_str()), ("3 workstreams wait on you", "CA-401, CA-388, General"));
        assert_eq!(out[0].open_run.as_deref(), Some("r5"));
    }

    #[test]
    fn a_digest_for_one_workstream_is_singular() {
        let mut b = Board::default();
        let out = tick(&mut b, 0, &digest_mode(), &[ws("w1", vec![need(Group::Decide, "r5", "c")])]);
        assert_eq!(out[0].notice.title, "1 workstream waits on you");
    }

    #[test]
    fn a_digest_waits_its_interval_and_only_for_something_new() {
        let mut b = Board::default();
        let one = [ws("w1", vec![need(Group::Decide, "r5", "c")])];
        assert_eq!(tick(&mut b, 0, &digest_mode(), &one).len(), 1);
        let two = [ws("w1", vec![need(Group::Decide, "r5", "c")]), ws("w2", vec![need(Group::Unblock, "r7", "d")])];
        assert!(tick(&mut b, 29 * 60, &digest_mode(), &two).is_empty(), "too soon");
        let out = tick(&mut b, 30 * 60, &digest_mode(), &two);
        assert_eq!((out[0].notice.title.as_str(), out[0].notice.body.as_str()), ("2 workstreams wait on you", "CA-401, CA-388"));
        assert!(tick(&mut b, 61 * 60, &digest_mode(), &two).is_empty(), "nothing new to say");
        assert!(tick(&mut b, 62 * 60, &digest_mode(), &[]).is_empty());
        assert_eq!(tick(&mut b, 63 * 60, &digest_mode(), &one).len(), 1, "waiting again is new, and the interval has passed");
        assert!(tick(&mut b, 64 * 60, &digest_mode(), &[]).is_empty());
        assert!(tick(&mut b, 65 * 60, &digest_mode(), &one).is_empty(), "new again, but the last digest was two minutes ago");
        assert_eq!(tick(&mut b, 93 * 60, &digest_mode(), &one).len(), 1);
    }

    #[test]
    fn a_digest_uses_its_own_interval_and_leaves_finished_runs_out() {
        let mut b = Board::default();
        let every_ten = Settings { mode: NoticeMode::Digest, digest_every: Duration::minutes(10) };
        b.finished(&Some("w1".into()), "r1", false, t(0));
        assert!(tick(&mut b, 100, &every_ten, &[]).is_empty());
        assert_eq!(tick(&mut b, 200, &every_ten, &[ws("w1", vec![need(Group::Decide, "r5", "c")])]).len(), 1);
        assert_eq!(tick(&mut b, 200 + 600, &every_ten, &[ws("w1", vec![need(Group::Decide, "r5", "c"), need(Group::Decide, "r6", "d")]), general(vec![need(Group::Approve, "g", "e")])]).len(), 1);
    }

    #[test]
    fn the_mode_reads_and_writes_as_a_camel_case_word() {
        assert_eq!(serde_json::to_string(&NoticeMode::Workstream).unwrap(), "\"workstream\"");
        assert_eq!(serde_json::from_str::<NoticeMode>("\"digest\"").unwrap(), NoticeMode::Digest);
        assert_eq!(NoticeMode::default(), NoticeMode::Workstream);
    }
}
