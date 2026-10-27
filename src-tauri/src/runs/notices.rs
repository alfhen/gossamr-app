//! When a run's news is worth a system notification: one per workstream that starts waiting on the person, not one per
//! event. Pure: the caller says what waits and when it is, and gets back the notices to show.
//!
//! What waits is what the page counts as Needs you (docs/needs-you.md, `src/lib/needs.ts`); a finished run is not one, so it
//! never notifies. A workstream notifies when a need appears in it, or a need of a higher group does (`Group`: decide over
//! unblock over approve). While it stays waiting, anything else that happens in it is quiet; once nothing waits in it any
//! more, the next need notifies again. Runs in no workstream are one stream, `GENERAL`.
//! Digest mode sends one notice at most every `digest_every` instead, naming the workstreams that wait.

use std::collections::BTreeMap;

use chrono::{DateTime, Duration, Utc};

use serde::{Deserialize, Serialize};

use crate::domain::{Run, RunState};
use crate::notify::Notice;

/// The name of the stream of runs that belong to no workstream.
pub const GENERAL: &str = "General";
/// How long after it ended a failed or limit-stopped run still notifies. It stays in the page's list however long it is
/// left, but past this it is no news, and must not keep its workstream "waiting" and so quiet about what comes next.
pub const FAILURE_NEWS: Duration = Duration::minutes(30);
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
    /// Something is stuck until they act: a run's question, permission or sign-in, or a pause.
    Unblock,
    /// A choice only they make: a plan or description approval.
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
}

#[derive(Default)]
pub struct Board {
    streams: BTreeMap<Key, Stream>,
    last_digest: Option<DateTime<Utc>>,
}

fn waiting_notice(name: &str, w: &Waiting) -> Option<Outgoing> {
    let top = w.top()?;
    let more = w.needs.len() - 1;
    let body = if more == 0 { top.what.clone() } else { format!("{} (+{more} more)", top.what) };
    Some(Outgoing { notice: Notice { title: format!("{name} is waiting on you"), body }, open_run: top.run_id.clone() })
}

impl Board {
    /// What to show now. `waiting` is everything that waits on the person at `now`, so a stream missing from it has been
    /// dealt with and is armed again. `watching` is the person looking at the app: nothing is shown, but what they could
    /// see counts as announced. `name_of` is how a stream is called ("CA-401"). `deliver` shows a notice and says whether
    /// it got through: state moves on only for what was delivered, so a notice that failed is offered again at the next
    /// tick, once per tick however long it keeps failing.
    pub fn tick(
        &mut self,
        now: DateTime<Utc>,
        settings: &Settings,
        watching: bool,
        waiting: &[Waiting],
        name_of: &dyn Fn(&Key) -> String,
        deliver: &mut dyn FnMut(&Outgoing) -> bool,
    ) {
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
        if quiet {
            self.mark(&waiting);
        } else if settings.mode == NoticeMode::Workstream {
            for w in fresh {
                if waiting_notice(&name_of(&w.key), w).is_some_and(|o| deliver(&o)) {
                    self.mark(&[w]);
                }
            }
        } else if !fresh.is_empty() && self.last_digest.is_none_or(|at| now - at >= settings.digest_every) && digest(&waiting, name_of).is_some_and(|o| deliver(&o)) {
            self.mark(&waiting);
            self.last_digest = Some(now);
        }
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

/// The failed or limit-stopped runs that are Needs you and news: the latest run of their kind on their ticket (their
/// repository when they have none), ended within `FAILURE_NEWS`. A newer run in any state supersedes an older one, as
/// `latestRuns` in `src/lib/needs.ts` does for the page's list.
pub fn stuck_runs(runs: &[Run], now: DateTime<Utc>) -> Vec<&Run> {
    let work = |r: &Run| {
        let place = r.item.as_ref().map_or_else(|| format!("{}\n{}", r.connection_id, r.spec.repo), |i| format!("{}\n{}", i.connection_id, i.external_id));
        (place, r.spec.role.as_str().to_string())
    };
    let mut newest: BTreeMap<(String, String), (DateTime<Utc>, &str)> = BTreeMap::new();
    for r in runs {
        let seen = newest.entry(work(r)).or_insert((r.queued_at, &r.id));
        if (r.queued_at, r.id.as_str()) > *seen {
            *seen = (r.queued_at, &r.id);
        }
    }
    runs.iter()
        .filter(|r| matches!(r.state, RunState::Failed) || (r.state == RunState::Stopped && r.stopped_by_limit))
        .filter(|r| r.ended_at.is_some_and(|at| now - at <= FAILURE_NEWS))
        .filter(|r| newest[&work(r)].1 == r.id)
        .collect()
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
        let mut shown = Vec::new();
        b.tick(t(at), s, false, waiting, &name, &mut |o| {
            shown.push(Outgoing { notice: Notice { title: o.notice.title.clone(), body: o.notice.body.clone() }, open_run: o.open_run.clone() });
            true
        });
        shown
    }

    /// A tick whose delivery succeeds or fails as told, and the notices it was asked to deliver.
    fn tick_delivering(b: &mut Board, at: i64, s: &Settings, watching: bool, waiting: &[Waiting], works: bool) -> Vec<String> {
        let mut asked = Vec::new();
        b.tick(t(at), s, watching, waiting, &name, &mut |o| {
            asked.push(o.notice.title.clone());
            works
        });
        asked
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
        let hold = Need { group: Group::Unblock, run_id: None, what: "It is paused until you resume it".into(), since: t(0) };
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
    fn off_sends_nothing() {
        let off = Settings { mode: NoticeMode::Off, digest_every: Duration::minutes(30) };
        let mut b = Board::default();
        assert!(tick(&mut b, 100, &off, &[ws("w1", vec![need(Group::Decide, "r5", "a")]), general(vec![need(Group::Unblock, "g", "b")])]).is_empty());
        assert!(tick(&mut b, 200, &each(), &[ws("w1", vec![need(Group::Decide, "r5", "a")])]).is_empty(), "switching on doesn't announce what was already waiting");
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
    fn a_digest_uses_its_own_interval() {
        let mut b = Board::default();
        let every_ten = Settings { mode: NoticeMode::Digest, digest_every: Duration::minutes(10) };
        assert!(tick(&mut b, 100, &every_ten, &[]).is_empty());
        assert_eq!(tick(&mut b, 200, &every_ten, &[ws("w1", vec![need(Group::Decide, "r5", "c")])]).len(), 1);
        assert_eq!(tick(&mut b, 200 + 600, &every_ten, &[ws("w1", vec![need(Group::Decide, "r5", "c"), need(Group::Decide, "r6", "d")]), general(vec![need(Group::Approve, "g", "e")])]).len(), 1);
    }

    #[test]
    fn a_failed_delivery_is_retried_once_per_tick_and_then_counts_as_told() {
        let mut b = Board::default();
        let waiting = [ws("w1", vec![need(Group::Unblock, "r5", "a")])];
        assert_eq!(tick_delivering(&mut b, 0, &each(), false, &waiting, false), ["CA-401 is waiting on you"]);
        assert_eq!(tick_delivering(&mut b, 5, &each(), false, &waiting, false), ["CA-401 is waiting on you"], "offered again");
        assert_eq!(tick_delivering(&mut b, 10, &each(), false, &waiting, true), ["CA-401 is waiting on you"]);
        assert!(tick_delivering(&mut b, 15, &each(), false, &waiting, true).is_empty(), "delivered once, then quiet");
    }

    #[test]
    fn a_failed_digest_is_retried_without_waiting_out_the_interval() {
        let mut b = Board::default();
        let one = [ws("w1", vec![need(Group::Decide, "r5", "c")])];
        assert_eq!(tick_delivering(&mut b, 0, &digest_mode(), false, &one, false), ["1 workstream waits on you"]);
        assert_eq!(tick_delivering(&mut b, 5, &digest_mode(), false, &one, true), ["1 workstream waits on you"]);
        assert!(tick_delivering(&mut b, 10, &digest_mode(), false, &one, true).is_empty());
    }

    #[test]
    fn one_failed_workstream_does_not_hold_back_the_others() {
        let mut b = Board::default();
        let both = [ws("w1", vec![need(Group::Unblock, "r5", "a")]), ws("w2", vec![need(Group::Unblock, "r7", "b")])];
        let mut fail_first = true;
        let mut asked = Vec::new();
        b.tick(t(0), &each(), false, &both, &name, &mut |o| {
            asked.push(o.notice.title.clone());
            !std::mem::take(&mut fail_first)
        });
        assert_eq!(asked, ["CA-401 is waiting on you", "CA-388 is waiting on you"]);
        assert_eq!(tick_delivering(&mut b, 5, &each(), false, &both, true), ["CA-401 is waiting on you"]);
    }

    #[test]
    fn watching_and_off_advance_state_without_delivering() {
        let off = Settings { mode: NoticeMode::Off, digest_every: Duration::minutes(30) };
        let waiting = [ws("w1", vec![need(Group::Unblock, "r5", "a")])];
        for (settings, watching) in [(each(), true), (off, false)] {
            let mut b = Board::default();
            assert!(tick_delivering(&mut b, 30, &settings, watching, &waiting, false).is_empty(), "nothing is asked to be delivered");
            assert!(tick_delivering(&mut b, 35, &each(), false, &waiting, true).is_empty(), "the need counts as announced");
        }
    }

    mod stuck {
        use super::*;
        use crate::domain::fixtures::run_spec;
        use crate::domain::{ItemRef, ResultKind};

        fn run(id: &str, kind: ResultKind, state: RunState, queued: i64, ended: Option<i64>) -> Run {
            let mut spec = run_spec();
            spec.role = kind.role();
            let mut r = Run::queued(id.into(), "p".into(), "c".into(), Some(ItemRef { connection_id: "c".into(), external_id: "1".into(), key: "CA-1".into() }), spec, "db".into(), t(queued));
            r.state = state;
            r.ended_at = ended.map(t);
            r
        }

        fn ids(runs: &[Run], now: i64) -> Vec<&str> {
            stuck_runs(runs, t(now)).iter().map(|r| r.id.as_str()).collect()
        }

        #[test]
        fn a_recent_failure_and_a_limit_stop_are_stuck() {
            let mut limit = run("limit", ResultKind::Build, RunState::Stopped, 0, Some(10));
            limit.stopped_by_limit = true;
            let runs = [run("failed", ResultKind::Plan, RunState::Failed, 0, Some(10)), limit];
            assert_eq!(ids(&runs, 60), ["failed", "limit"]);
        }

        #[test]
        fn finished_stopped_by_you_and_waiting_runs_are_not() {
            let runs = [
                run("done", ResultKind::Plan, RunState::Done, 0, Some(10)),
                run("stopped", ResultKind::Build, RunState::Stopped, 0, Some(10)),
                run("asking", ResultKind::Triage, RunState::NeedsAnswer, 0, None),
            ];
            assert!(ids(&runs, 60).is_empty());
        }

        #[test]
        fn several_failures_of_one_kind_on_a_ticket_are_one_on_the_latest_run() {
            let runs = [run("p1", ResultKind::Plan, RunState::Failed, 0, Some(10)), run("p3", ResultKind::Plan, RunState::Failed, 200, Some(210)), run("p2", ResultKind::Plan, RunState::Failed, 100, Some(110))];
            assert_eq!(ids(&runs, 300), ["p3"]);
        }

        #[test]
        fn a_newer_run_in_any_state_supersedes_it_but_another_kind_does_not() {
            for state in [RunState::Working, RunState::Done, RunState::Queued, RunState::Failed] {
                let runs = [run("old", ResultKind::Plan, RunState::Failed, 0, Some(10)), run("new", ResultKind::Plan, state, 100, None)];
                assert!(!ids(&runs, 150).contains(&"old"), "{state:?}");
            }
            let runs = [run("old", ResultKind::Plan, RunState::Failed, 0, Some(10)), run("other", ResultKind::Build, RunState::Done, 100, Some(120))];
            assert_eq!(ids(&runs, 150), ["old"]);
        }

        #[test]
        fn tickets_of_different_connections_sharing_a_key_do_not_supersede_each_other() {
            let mut newer = run("new", ResultKind::Plan, RunState::Done, 100, Some(120));
            newer.item = Some(ItemRef { connection_id: "other".into(), external_id: "9".into(), key: "CA-1".into() });
            let runs = [run("old", ResultKind::Plan, RunState::Failed, 0, Some(10)), newer];
            assert_eq!(ids(&runs, 150), ["old"]);
        }

        #[test]
        fn a_failure_left_for_longer_than_the_news_window_is_not_news() {
            let runs = [run("old", ResultKind::Plan, RunState::Failed, 0, Some(0))];
            assert_eq!(ids(&runs, 29 * 60), ["old"]);
            assert!(ids(&runs, 31 * 60).is_empty());
        }
    }

    #[test]
    fn the_mode_reads_and_writes_as_a_camel_case_word() {
        assert_eq!(serde_json::to_string(&NoticeMode::Workstream).unwrap(), "\"workstream\"");
        assert_eq!(serde_json::from_str::<NoticeMode>("\"digest\"").unwrap(), NoticeMode::Digest);
        assert_eq!(NoticeMode::default(), NoticeMode::Workstream);
    }
}
