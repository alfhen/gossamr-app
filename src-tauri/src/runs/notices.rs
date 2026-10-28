//! Notices for new items in Needs you (docs/needs-you.md): one per item, once, while it stays open. Pure: the caller says what
//! waits, and gets back the notices to show.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::domain::{Run, RunState};
use crate::notify::Notice;

/// The name of the stream of runs that belong to no workstream.
pub const GENERAL: &str = "General";
/// How long after it ended a failed run still notifies. It stays in Needs you however long it is left, but past this it is
/// no news, and a restart must not announce it again.
pub const FAILURE_NEWS: Duration = Duration::minutes(30);

/// Whether system notifications are shown. Settings saved with the removed digest choice read as on.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoticeMode {
    #[default]
    #[serde(alias = "digest")]
    Workstream,
    Off,
}

/// One item of Needs you. `key` is the same for the same item at every poll, so it notifies once.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Need {
    pub key: String,
    /// The run to open for it, when it has one.
    pub run_id: Option<String>,
    /// Reads after the stream's name: "R5 wants to run a command".
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settings {
    pub mode: NoticeMode,
}

/// A notice to show, and the run to open if the window is focused soon after.
#[derive(Debug, PartialEq)]
pub struct Outgoing {
    pub notice: Notice,
    pub open_run: Option<String>,
}

/// The items already announced that still wait; one that is dealt with is forgotten, so it notifies again if it returns.
/// The caller keeps the set across restarts (`seen`, `restore`), so a restart announces only what is new since.
#[derive(Default)]
pub struct Board {
    seen: BTreeSet<String>,
    restored: bool,
}

fn waiting_notice(name: &str, need: &Need) -> Outgoing {
    Outgoing { notice: Notice { title: format!("{name} is waiting on you"), body: need.what.clone() }, open_run: need.run_id.clone() }
}

impl Board {
    /// Whether the set of announced items was loaded yet.
    pub fn restored(&self) -> bool {
        self.restored
    }

    /// Takes the items announced before this launch. With no record at all (the first launch with this record), what
    /// waits now counts as announced, so an upgrade does not announce everything that was already open.
    pub fn restore(&mut self, record: Option<BTreeSet<String>>, waiting: &[Waiting]) {
        self.seen = record.unwrap_or_else(|| waiting.iter().flat_map(|w| w.needs.iter().map(|n| n.key.clone())).collect());
        self.restored = true;
    }

    /// The items announced and still waiting, as kept between launches.
    pub fn seen(&self) -> &BTreeSet<String> {
        &self.seen
    }

    /// What to show now. `waiting` is everything in Needs you at this poll. `watching` is the person looking at the app:
    /// nothing is shown, but what they could see counts as announced, as it does with notifications off. `deliver` shows a
    /// notice and says whether it got through: an item counts as announced only once it was, so a failed one is offered
    /// again at the next poll.
    pub fn tick(&mut self, settings: &Settings, watching: bool, waiting: &[Waiting], name_of: &dyn Fn(&Key) -> String, deliver: &mut dyn FnMut(&Outgoing) -> bool) {
        let open: BTreeSet<&str> = waiting.iter().flat_map(|w| w.needs.iter().map(|n| n.key.as_str())).collect();
        self.seen.retain(|key| open.contains(key.as_str()));
        let quiet = watching || settings.mode == NoticeMode::Off;
        let mut fresh: Vec<(&Waiting, &Need)> = waiting.iter().flat_map(|w| w.needs.iter().map(move |n| (w, n))).filter(|(_, n)| !self.seen.contains(&n.key)).collect();
        fresh.sort_by(|(_, a), (_, b)| a.since.cmp(&b.since).then_with(|| a.key.cmp(&b.key)));
        for (w, need) in fresh {
            if quiet || deliver(&waiting_notice(&name_of(&w.key), need)) {
                self.seen.insert(need.key.clone());
            }
        }
    }
}

/// The failed runs that are Needs you and news: the latest run of their role's work on their ticket (their repository when
/// they have none), not archived, ended within `FAILURE_NEWS`. A newer run in any state supersedes an older one, as
/// `latestRuns` in `src/lib/needs.ts` does for the page's list.
pub fn stuck_runs(runs: &[Run], now: DateTime<Utc>) -> Vec<&Run> {
    let work = |r: &Run| {
        let place = r.item.as_ref().map_or_else(|| format!("{}\n{}", r.connection_id, r.spec.repo), |i| format!("{}\n{}", i.connection_id, i.external_id));
        (place, r.spec.role.work().to_string())
    };
    let mut newest: BTreeMap<(String, String), (DateTime<Utc>, &str)> = BTreeMap::new();
    for r in runs {
        let seen = newest.entry(work(r)).or_insert((r.queued_at, &r.id));
        if (r.queued_at, r.id.as_str()) > *seen {
            *seen = (r.queued_at, &r.id);
        }
    }
    runs.iter()
        .filter(|r| r.state == RunState::Failed && r.archived_at.is_none())
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

    fn need(key: &str, since: i64) -> Need {
        Need { key: key.into(), run_id: Some(key.into()), what: format!("{key} asks a question"), since: t(since) }
    }

    fn ws(key: &str, needs: Vec<Need>) -> Waiting {
        Waiting { key: Some(key.into()), needs }
    }

    fn name(key: &Key) -> String {
        match key.as_deref() {
            Some("w1") => "CA-401".into(),
            Some("w2") => "CA-388".into(),
            Some(other) => other.into(),
            None => GENERAL.into(),
        }
    }

    fn on() -> Settings {
        Settings { mode: NoticeMode::Workstream }
    }

    /// The notices a poll asked to deliver, as "title: body"; delivery succeeds or fails as told.
    fn tick(board: &mut Board, settings: &Settings, watching: bool, waiting: &[Waiting], delivered: bool) -> Vec<String> {
        let mut asked = Vec::new();
        board.tick(settings, watching, waiting, &name, &mut |o| {
            asked.push(format!("{}: {}", o.notice.title, o.notice.body));
            delivered
        });
        asked
    }

    #[test]
    fn a_new_item_notifies_with_its_workstream_and_opens_its_run() {
        let mut board = Board::default();
        let mut shown = Vec::new();
        board.tick(&on(), false, &[ws("w1", vec![need("r5", 0)])], &name, &mut |o| {
            shown.push(Outgoing { notice: Notice { title: o.notice.title.clone(), body: o.notice.body.clone() }, open_run: o.open_run.clone() });
            true
        });
        assert_eq!(shown, vec![Outgoing { notice: Notice { title: "CA-401 is waiting on you".into(), body: "r5 asks a question".into() }, open_run: Some("r5".into()) }]);
    }

    #[test]
    fn nothing_waiting_sends_nothing() {
        assert!(tick(&mut Board::default(), &on(), false, &[], true).is_empty());
    }

    #[test]
    fn each_item_notifies_once_while_it_stays_open_even_beside_others_in_its_workstream() {
        let mut board = Board::default();
        assert_eq!(tick(&mut board, &on(), false, &[ws("w1", vec![need("r5", 0)])], true).len(), 1);
        assert!(tick(&mut board, &on(), false, &[ws("w1", vec![need("r5", 0)])], true).is_empty());
        let both = [ws("w1", vec![need("r5", 0), need("r6", 5)])];
        assert_eq!(tick(&mut board, &on(), false, &both, true), ["CA-401 is waiting on you: r6 asks a question"], "only the new one");
        assert!(tick(&mut board, &on(), false, &both, true).is_empty());
    }

    #[test]
    fn several_new_items_notify_oldest_first() {
        let mut board = Board::default();
        let out = tick(&mut board, &on(), false, &[ws("w2", vec![need("late", 20)]), ws("w1", vec![need("early", 10)])], true);
        assert_eq!(out, ["CA-401 is waiting on you: early asks a question", "CA-388 is waiting on you: late asks a question"]);
    }

    #[test]
    fn an_item_dealt_with_notifies_again_when_it_comes_back() {
        let mut board = Board::default();
        let waiting = [ws("w1", vec![need("r5", 0)])];
        assert_eq!(tick(&mut board, &on(), false, &waiting, true).len(), 1);
        assert!(tick(&mut board, &on(), false, &[], true).is_empty());
        assert_eq!(tick(&mut board, &on(), false, &waiting, true).len(), 1);
    }

    #[test]
    fn dealing_with_one_of_two_items_does_not_announce_the_other_again() {
        let mut board = Board::default();
        tick(&mut board, &on(), false, &[ws("w1", vec![need("r5", 0), need("r6", 5)])], true);
        assert!(tick(&mut board, &on(), false, &[ws("w1", vec![need("r6", 5)])], true).is_empty());
        assert!(tick(&mut board, &on(), false, &[ws("w1", vec![need("r6", 5)])], true).is_empty());
    }

    #[test]
    fn items_in_no_workstream_are_announced_under_general() {
        let mut board = Board::default();
        let out = tick(&mut board, &on(), false, &[Waiting { key: None, needs: vec![need("g1", 0)] }], true);
        assert_eq!(out, ["General is waiting on you: g1 asks a question"]);
    }

    #[test]
    fn a_failed_delivery_is_offered_again_until_it_gets_through() {
        let mut board = Board::default();
        let waiting = [ws("w1", vec![need("r5", 0)])];
        assert_eq!(tick(&mut board, &on(), false, &waiting, false).len(), 1);
        assert_eq!(tick(&mut board, &on(), false, &waiting, false).len(), 1, "offered again");
        assert_eq!(tick(&mut board, &on(), false, &waiting, true).len(), 1);
        assert!(tick(&mut board, &on(), false, &waiting, true).is_empty(), "delivered once, then quiet");
    }

    #[test]
    fn one_failed_notice_does_not_hold_back_the_others() {
        let mut board = Board::default();
        let both = [ws("w1", vec![need("r5", 0)]), ws("w2", vec![need("r7", 5)])];
        let mut fail_first = true;
        let mut asked = 0;
        board.tick(&on(), false, &both, &name, &mut |_| {
            asked += 1;
            !std::mem::take(&mut fail_first)
        });
        assert_eq!(asked, 2);
        assert_eq!(tick(&mut board, &on(), false, &both, true), ["CA-401 is waiting on you: r5 asks a question"]);
    }

    #[test]
    fn what_the_person_could_see_or_silenced_counts_as_announced_without_a_notice() {
        let off = Settings { mode: NoticeMode::Off };
        let waiting = [ws("w1", vec![need("r5", 0)])];
        for (settings, watching) in [(on(), true), (off, false)] {
            let mut board = Board::default();
            assert!(tick(&mut board, &settings, watching, &waiting, false).is_empty(), "nothing is asked to be delivered");
            assert!(tick(&mut board, &on(), false, &waiting, true).is_empty(), "the item counts as announced");
        }
    }

    #[test]
    fn the_mode_reads_and_writes_as_a_camel_case_word_and_the_removed_digest_reads_as_on() {
        assert_eq!(serde_json::to_string(&NoticeMode::Workstream).unwrap(), "\"workstream\"");
        assert_eq!(serde_json::from_str::<NoticeMode>("\"off\"").unwrap(), NoticeMode::Off);
        assert_eq!(serde_json::from_str::<NoticeMode>("\"digest\"").unwrap(), NoticeMode::Workstream);
        assert_eq!(NoticeMode::default(), NoticeMode::Workstream);
    }

    mod stuck {
        use super::*;
        use crate::domain::fixtures::run_spec;
        use crate::domain::ItemRef;

        fn run(id: &str, kind: &str, state: RunState, queued: i64, ended: Option<i64>) -> Run {
            let mut spec = run_spec();
            spec.role = crate::domain::Role::parse(kind).unwrap();
            let mut r = Run::queued(id.into(), "p".into(), "c".into(), Some(ItemRef { connection_id: "c".into(), external_id: "1".into(), key: "CA-1".into() }), spec, "db".into(), t(queued));
            r.state = state;
            r.ended_at = ended.map(t);
            r
        }

        fn ids(runs: &[Run], now: i64) -> Vec<&str> {
            stuck_runs(runs, t(now)).iter().map(|r| r.id.as_str()).collect()
        }

        #[test]
        fn a_recent_failure_is_stuck() {
            let runs = [run("failed", "plan", RunState::Failed, 0, Some(10))];
            assert_eq!(ids(&runs, 60), ["failed"]);
        }

        #[test]
        fn finished_stopped_by_you_and_waiting_runs_are_not() {
            let runs = [
                run("done", "plan", RunState::Done, 0, Some(10)),
                run("stopped", "build", RunState::Stopped, 0, Some(10)),
                run("asking", "triage", RunState::NeedsAnswer, 0, None),
            ];
            assert!(ids(&runs, 60).is_empty());
        }

        #[test]
        fn several_failures_of_one_kind_on_a_ticket_are_one_on_the_latest_run() {
            let runs = [run("p1", "plan", RunState::Failed, 0, Some(10)), run("p3", "plan", RunState::Failed, 200, Some(210)), run("p2", "plan", RunState::Failed, 100, Some(110))];
            assert_eq!(ids(&runs, 300), ["p3"]);
        }

        #[test]
        fn a_newer_run_in_any_state_supersedes_it_but_another_kind_does_not() {
            for state in [RunState::Working, RunState::Done, RunState::Queued, RunState::Failed] {
                let runs = [run("old", "plan", RunState::Failed, 0, Some(10)), run("new", "plan", state, 100, None)];
                assert!(!ids(&runs, 150).contains(&"old"), "{state:?}");
            }
            let runs = [run("old", "plan", RunState::Failed, 0, Some(10)), run("other", "build", RunState::Done, 100, Some(120))];
            assert_eq!(ids(&runs, 150), ["old"]);
        }

        #[test]
        fn a_newer_run_under_the_other_name_of_the_same_kind_supersedes_it() {
            let mut newer = run("new", "plan", RunState::Done, 100, Some(120));
            newer.spec.role = crate::domain::Role::parse("planner").unwrap();
            let runs = [run("old", "plan", RunState::Failed, 0, Some(10)), newer];
            assert!(ids(&runs, 150).is_empty());
        }

        #[test]
        fn tickets_of_different_connections_sharing_a_key_do_not_supersede_each_other() {
            let mut newer = run("new", "plan", RunState::Done, 100, Some(120));
            newer.item = Some(ItemRef { connection_id: "other".into(), external_id: "9".into(), key: "CA-1".into() });
            let runs = [run("old", "plan", RunState::Failed, 0, Some(10)), newer];
            assert_eq!(ids(&runs, 150), ["old"]);
        }

        #[test]
        fn a_failure_left_for_longer_than_the_news_window_is_not_news() {
            let runs = [run("old", "plan", RunState::Failed, 0, Some(0))];
            assert_eq!(ids(&runs, 29 * 60), ["old"]);
            assert!(ids(&runs, 31 * 60).is_empty());
        }

        #[test]
        fn an_archived_failure_is_closed_and_still_supersedes_an_older_one() {
            let mut archived = run("new", "plan", RunState::Failed, 100, Some(110));
            archived.archived_at = Some(t(120));
            let runs = [run("old", "plan", RunState::Failed, 0, Some(10)), archived];
            assert!(ids(&runs, 150).is_empty());
        }
    }
}
