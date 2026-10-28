//! Notices for new items in Needs you. The board remembers the items it has announced while they remain open.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::domain::{Run, RunState};
use crate::notify::Notice;

pub const GENERAL: &str = "General";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoticeMode {
    #[default]
    #[serde(alias = "digest")]
    Workstream,
    Off,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Group {
    Approve,
    Unblock,
    Decide,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Need {
    pub key: String,
    pub group: Group,
    pub run_id: Option<String>,
    pub what: String,
    pub since: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Waiting {
    pub key: Key,
    pub needs: Vec<Need>,
}

pub type Key = Option<String>;

impl Waiting {
    pub fn top(&self) -> Option<&Need> {
        self.needs.iter().max_by(|a, b| a.group.cmp(&b.group).then(b.since.cmp(&a.since)).then(b.key.cmp(&a.key)))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settings {
    pub mode: NoticeMode,
}

#[derive(Debug, PartialEq)]
pub struct Outgoing {
    pub notice: Notice,
    pub open_run: Option<String>,
}

#[derive(Default)]
pub struct Board {
    streams: BTreeMap<Key, BTreeSet<String>>,
}

fn waiting_notice(name: &str, need: &Need) -> Outgoing {
    Outgoing { notice: Notice { title: format!("{name} is waiting on you"), body: need.what.clone() }, open_run: need.run_id.clone() }
}

impl Board {
    pub fn tick(
        &mut self,
        _now: DateTime<Utc>,
        settings: &Settings,
        watching: bool,
        waiting: &[Waiting],
        name_of: &dyn Fn(&Key) -> String,
        deliver: &mut dyn FnMut(&Outgoing) -> bool,
    ) {
        let current: BTreeMap<_, _> = waiting.iter().map(|w| (w.key.clone(), w.needs.iter().map(|n| n.key.clone()).collect::<BTreeSet<_>>())).collect();
        self.streams.retain(|key, _| current.contains_key(key));
        for (key, seen) in &mut self.streams {
            seen.retain(|item| current[key].contains(item));
        }
        for w in waiting {
            let seen = self.streams.entry(w.key.clone()).or_default();
            let mut fresh: Vec<_> = w.needs.iter().filter(|n| !seen.contains(&n.key)).collect();
            fresh.sort_by(|a, b| b.group.cmp(&a.group).then(a.since.cmp(&b.since)).then(a.key.cmp(&b.key)));
            for need in fresh {
                if watching || settings.mode == NoticeMode::Off || deliver(&waiting_notice(&name_of(&w.key), need)) {
                    seen.insert(need.key.clone());
                }
            }
        }
    }
}

/// The latest failed run of each role and ticket is a need until it is dealt with.
pub fn stuck_runs(runs: &[Run], _now: DateTime<Utc>) -> Vec<&Run> {
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
    runs.iter().filter(|r| r.state == RunState::Failed && r.archived_at.is_none()).filter(|r| newest[&work(r)].1 == r.id).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn now() -> DateTime<Utc> { Utc.with_ymd_and_hms(2026, 10, 12, 9, 0, 0).unwrap() }
    fn need(key: &str) -> Need { Need { key: key.into(), group: Group::Unblock, run_id: Some(key.into()), what: format!("{key} asks a question"), since: now() } }
    fn waiting(needs: Vec<Need>) -> Vec<Waiting> { vec![Waiting { key: Some("w1".into()), needs }] }
    fn tick(board: &mut Board, needs: &[Waiting], watching: bool, delivered: bool) -> Vec<Outgoing> {
        let mut out = Vec::new();
        board.tick(now(), &Settings { mode: NoticeMode::Workstream }, watching, needs, &|_| "CA-401".into(), &mut |n| { out.push(Outgoing { notice: Notice { title: n.notice.title.clone(), body: n.notice.body.clone() }, open_run: n.open_run.clone() }); delivered });
        out
    }

    #[test]
    fn each_new_need_notifies_once_while_it_remains_open() {
        let mut board = Board::default();
        assert_eq!(tick(&mut board, &waiting(vec![need("r1")]), false, true).len(), 1);
        assert!(tick(&mut board, &waiting(vec![need("r1")]), false, true).is_empty());
        assert_eq!(tick(&mut board, &waiting(vec![need("r1"), need("r2")]), false, true)[0].open_run.as_deref(), Some("r2"));
        assert!(tick(&mut board, &[], false, true).is_empty());
        assert_eq!(tick(&mut board, &waiting(vec![need("r1")]), false, true).len(), 1);
    }

    #[test]
    fn a_failed_delivery_is_retried_and_a_visible_need_is_counted_as_seen() {
        let mut board = Board::default();
        assert_eq!(tick(&mut board, &waiting(vec![need("r1")]), false, false).len(), 1);
        assert_eq!(tick(&mut board, &waiting(vec![need("r1")]), false, true).len(), 1);
        assert!(tick(&mut board, &waiting(vec![need("r1")]), false, true).is_empty());
        assert!(tick(&mut board, &waiting(vec![need("r2")]), true, true).is_empty());
        assert!(tick(&mut board, &waiting(vec![need("r2")]), false, true).is_empty());
    }

    #[test]
    fn old_digest_settings_load_as_notifications_on() {
        assert_eq!(serde_json::from_str::<NoticeMode>("\"digest\"").unwrap(), NoticeMode::Workstream);
        assert_eq!(serde_json::to_string(&NoticeMode::Workstream).unwrap(), "\"workstream\"");
    }
}
