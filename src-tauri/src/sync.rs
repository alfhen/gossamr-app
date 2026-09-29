//! Keeps the cache fresh: what to ask a tracker for, when to ask, and how to back off after a failure.

use chrono::{DateTime, Duration, Utc};

use crate::db::{stamp, Db, SyncState, Upserted};
use crate::domain::{Container, Event, EventKind, ItemKind, ItemRef, PersonRef, Subject, WorkItem};
use crate::error::Result;
use crate::events::{derive, my_actions, NewEvent};
use crate::inbox::tickets_of;
use crate::model::EventKind as InboxKind;
use crate::tracker::{SearchOptions, WorkTracker};

/// Tickets the user follows are those they are involved in that changed this recently. Anything else only appears
/// as context, e.g. the children of an epic they watch.
pub const TRACKED_WINDOW_DAYS: u32 = 30;
/// Tickets the inbox tracks. Anything past this drops out of the inbox, so it is a sanity bound, not a page size.
pub const TRACKED_LIMIT: usize = 2000;
/// Tickets read for context, such as an epic's children, so a very broad query can't stall a sync.
pub const CONTEXT_LIMIT: usize = 300;
/// Leeway for clock differences between this machine and the tracker when deciding what changed since a cursor.
pub const CLOCK_SKEW_MINUTES: u32 = 10;

pub const POLL_INTERVAL: Duration = Duration::seconds(60);
/// How soon after the last attempt a window focus may trigger another.
const FOCUS_MIN_GAP: Duration = Duration::seconds(15);
const BACKOFF_BASE: Duration = Duration::seconds(30);
const MAX_BACKOFF: Duration = Duration::minutes(15);
/// Incremental syncs only refresh what changed, so every item is refreshed this often. That is what keeps items
/// that are still followed from looking like ones that dropped out of every query.
const FULL_REFRESH: Duration = Duration::hours(6);
const CONTAINERS_REFRESH: Duration = Duration::hours(12);
/// Items not refreshed for this long are deleted from the cache.
const KEEP_DAYS: i64 = 90;

/// What one sync asks the tracker for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Plan {
    /// Everything followed within the window.
    Full,
    /// Only what changed in the last `minutes`, which already includes the clock-skew leeway.
    Since { minutes: u32 },
}

fn parse(s: &Option<String>) -> Option<DateTime<Utc>> {
    s.as_deref().and_then(|s| DateTime::parse_from_rfc3339(s).ok()).map(|d| d.with_timezone(&Utc))
}

pub fn plan(state: &SyncState, now: DateTime<Utc>) -> Plan {
    let (Some(cursor), Some(full_at)) = (parse(&state.cursor), parse(&state.full_at)) else { return Plan::Full };
    let behind = now - cursor;
    let beyond_window = behind >= Duration::days(i64::from(TRACKED_WINDOW_DAYS));
    if now - full_at >= FULL_REFRESH || behind < Duration::zero() || beyond_window {
        return Plan::Full;
    }
    let minutes = (behind.num_seconds() as u64).div_ceil(60) + u64::from(CLOCK_SKEW_MINUTES);
    Plan::Since { minutes: u32::try_from(minutes).unwrap_or(u32::MAX) }
}

pub struct Pulled {
    /// Followed items, which produce inbox events.
    pub tracked: Vec<WorkItem>,
    /// Children of followed epics, kept only as context.
    pub context: Vec<WorkItem>,
    /// Present when they were due for a refresh and the tracker returned them.
    pub containers: Option<Vec<Container>>,
}

/// Fetches what `plan` calls for. `known_epics` are epics already cached, whose children may have changed even when
/// the epic hasn't.
pub async fn pull(
    tracker: &dyn WorkTracker,
    connection_id: &str,
    plan: Plan,
    state: &SyncState,
    known_epics: &[String],
    history_since: &str,
    now: DateTime<Utc>,
) -> Result<Pulled> {
    let updated_since_minutes = match plan {
        Plan::Full => None,
        Plan::Since { minutes } => Some(minutes),
    };
    let opts = SearchOptions { limit: TRACKED_LIMIT, history_since: Some(history_since.into()), updated_since_minutes };
    let tracked = tracker.followed(TRACKED_WINDOW_DAYS, &opts).await?;

    let mut epics: Vec<ItemRef> = Vec::new();
    let known = known_epics.iter().map(String::as_str);
    let fresh = tracked.iter().filter(|i| i.kind == ItemKind::Epic).map(|i| i.item.external_id.as_str());
    for id in fresh.chain(known) {
        if !epics.iter().any(|e| e.external_id == id) {
            epics.push(ItemRef { connection_id: connection_id.into(), external_id: id.into(), key: id.into() });
        }
    }
    let context = if epics.is_empty() {
        Vec::new()
    } else {
        let opts = SearchOptions { limit: CONTEXT_LIMIT, history_since: None, updated_since_minutes };
        tracker.children(&epics, &opts).await?
    };

    let containers_due = parse(&state.containers_at).is_none_or(|at| now - at >= CONTAINERS_REFRESH);
    // Containers are context for the views; a failure to list them must not fail the sync of the items.
    let containers = if containers_due { tracker.containers().await.ok() } else { None };
    Ok(Pulled { tracked, context, containers })
}

pub struct Stored {
    pub upserted: Upserted,
    /// Inbox events that are new since the last sync and unread, or none on a connection's first sync.
    pub new_events: Vec<NewEvent>,
}

/// Writes a pull to the cache and advances the connection's cursor. `announce` is false for a connection's first
/// sync, so connecting doesn't fire a burst of notifications.
#[allow(clippy::too_many_arguments)]
pub fn store(
    db: &Db,
    connection_id: &str,
    me: &str,
    pulled: &Pulled,
    plan: Plan,
    started: DateTime<Utc>,
    unread_after: &str,
    announce: bool,
) -> Result<Stored> {
    let at = stamp(started);
    let tickets = tickets_of(&pulled.tracked)?;
    let extra_context = pulled.context.iter().filter(|c| !pulled.tracked.iter().any(|t| t.item == c.item));
    let items: Vec<WorkItem> = pulled.tracked.iter().chain(extra_context).cloned().collect();
    let upserted = db.upsert_items(&items, &at)?;

    let derived: Vec<NewEvent> = tickets.iter().flat_map(|t| derive(t, me)).collect();
    let fresh = db.insert_events(&derived, unread_after)?;
    db.insert_cache_events(&derived.iter().filter_map(|e| domain_event(connection_id, e)).collect::<Vec<_>>())?;
    db.insert_activity(&tickets.iter().flat_map(|t| my_actions(t, me)).collect::<Vec<_>>())?;

    let mut state = db.sync_state(connection_id)?;
    state.cursor = Some(at.clone());
    if plan == Plan::Full {
        state.full_at = Some(at.clone());
        db.prune_items(connection_id, &stamp(started - Duration::days(KEEP_DAYS)))?;
    }
    if let Some(containers) = &pulled.containers {
        db.replace_containers(connection_id, containers, &at)?;
        state.containers_at = Some(at.clone());
    }
    db.save_sync_state(connection_id, &state)?;
    Ok(Stored { upserted, new_events: if announce { fresh } else { Vec::new() } })
}

/// An inbox event as the neutral event it is, or `None` for the kinds the neutral model has no name for.
fn domain_event(connection_id: &str, e: &NewEvent) -> Option<Event> {
    let kind = match e.kind {
        InboxKind::Mention | InboxKind::Comment => EventKind::CommentAdded,
        InboxKind::Status => EventKind::StatusChanged,
        InboxKind::Assigned => EventKind::Assigned,
        InboxKind::Field => return None,
    };
    let at = DateTime::parse_from_rfc3339(&e.at).ok()?.with_timezone(&Utc);
    Some(Event {
        id: e.id.clone(),
        connection_id: connection_id.into(),
        at,
        kind,
        subject: Subject::Item { item: ItemRef { connection_id: connection_id.into(), external_id: e.ticket_key.clone(), key: e.ticket_key.clone() } },
        actor: Some(PersonRef { connection_id: connection_id.into(), account_id: e.actor.account_id.clone() }),
        payload: serde_json::json!({ "text": e.text }),
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trigger {
    /// The poll interval elapsed.
    Timer,
    /// The window gained focus or the machine woke.
    Focus,
    /// The person asked, or something just changed that needs a look; skips the wait after a failure.
    Now,
}

/// When one connection is next allowed to sync.
#[derive(Debug, Default)]
pub struct Schedule {
    last_attempt: Option<DateTime<Utc>>,
    failures: u32,
    retry_at: Option<DateTime<Utc>>,
}

impl Schedule {
    pub fn due(&self, now: DateTime<Utc>, trigger: Trigger) -> bool {
        if trigger == Trigger::Now {
            return true;
        }
        if self.retry_at.is_some_and(|at| now < at) {
            return false;
        }
        let gap = if trigger == Trigger::Focus { FOCUS_MIN_GAP } else { POLL_INTERVAL };
        self.last_attempt.is_none_or(|at| now - at >= gap)
    }

    /// Records an attempt. After a failure the next scheduled one waits twice as long as after the one before, up
    /// to a ceiling.
    pub fn finished(&mut self, now: DateTime<Utc>, ok: bool) {
        self.last_attempt = Some(now);
        if ok {
            self.failures = 0;
            self.retry_at = None;
        } else {
            self.failures = self.failures.saturating_add(1);
            let doubled = BACKOFF_BASE * 2_i32.saturating_pow(self.failures.min(16));
            self.retry_at = Some(now + doubled.min(MAX_BACKOFF));
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;

    use super::*;
    use crate::domain::{Comment, ContainerRef, Filter, Intent, Person, Workflow};
    use crate::error::Error;
    use crate::model::Uploaded;
    use crate::tracker::testing::sample_ticket;
    use crate::tracker::{item_from_ticket, Applied, Connection, Move, TrackerCaps};

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn state(cursor: &str, full: &str) -> SyncState {
        SyncState { cursor: Some(cursor.into()), full_at: Some(full.into()), containers_at: None }
    }

    #[test]
    fn a_connection_with_no_history_syncs_everything() {
        assert_eq!(plan(&SyncState::default(), at("2026-09-29T12:00:00Z")), Plan::Full);
        let no_full = SyncState { cursor: Some("2026-09-29T11:59:00Z".into()), ..Default::default() };
        assert_eq!(plan(&no_full, at("2026-09-29T12:00:00Z")), Plan::Full);
    }

    #[test]
    fn a_recent_cursor_asks_for_the_minutes_since_plus_leeway() {
        let s = state("2026-09-29T11:58:30Z", "2026-09-29T08:00:00Z");
        assert_eq!(plan(&s, at("2026-09-29T12:00:00Z")), Plan::Since { minutes: 2 + CLOCK_SKEW_MINUTES });
    }

    #[test]
    fn a_launch_after_a_long_gap_still_catches_up_incrementally_until_a_full_refresh_is_due() {
        let s = state("2026-09-29T05:00:00Z", "2026-09-29T05:00:00Z");
        assert_eq!(plan(&s, at("2026-09-29T10:00:00Z")), Plan::Since { minutes: 300 + CLOCK_SKEW_MINUTES });
        assert_eq!(plan(&s, at("2026-09-29T11:00:00Z")), Plan::Full);
    }

    #[test]
    fn a_cursor_past_the_window_or_in_the_future_starts_over() {
        let old = state("2026-08-01T00:00:00Z", "2026-09-29T11:00:00Z");
        assert_eq!(plan(&old, at("2026-09-29T12:00:00Z")), Plan::Full);
        let future = state("2026-09-30T00:00:00Z", "2026-09-29T11:00:00Z");
        assert_eq!(plan(&future, at("2026-09-29T12:00:00Z")), Plan::Full);
    }

    #[derive(Default)]
    struct Fake {
        followed: Vec<WorkItem>,
        children: Vec<WorkItem>,
        containers_fail: bool,
        calls: Mutex<Vec<String>>,
        opts: Mutex<Vec<SearchOptions>>,
    }

    #[async_trait]
    impl WorkTracker for Fake {
        fn capabilities(&self) -> TrackerCaps {
            unimplemented!()
        }
        async fn search(&self, _: &Filter, _: &SearchOptions) -> Result<Vec<WorkItem>> {
            unimplemented!()
        }
        async fn search_native(&self, _: &str, _: &SearchOptions) -> Result<Vec<WorkItem>> {
            unimplemented!()
        }
        async fn followed(&self, _: u32, opts: &SearchOptions) -> Result<Vec<WorkItem>> {
            self.calls.lock().unwrap().push("followed".into());
            self.opts.lock().unwrap().push(opts.clone());
            Ok(self.followed.clone())
        }
        async fn children(&self, parents: &[ItemRef], opts: &SearchOptions) -> Result<Vec<WorkItem>> {
            let ids: Vec<&str> = parents.iter().map(|p| p.external_id.as_str()).collect();
            self.calls.lock().unwrap().push(format!("children {}", ids.join(",")));
            self.opts.lock().unwrap().push(opts.clone());
            Ok(self.children.clone())
        }
        async fn item(&self, _: &ItemRef, _: &str) -> Result<WorkItem> {
            unimplemented!()
        }
        async fn containers(&self) -> Result<Vec<Container>> {
            self.calls.lock().unwrap().push("containers".into());
            if self.containers_fail {
                return Err(Error::Api { status: 500, message: "down".into() });
            }
            Ok(vec![])
        }
        async fn workflow(&self, _: &ContainerRef) -> Result<Workflow> {
            unimplemented!()
        }
        async fn comments(&self, _: &ItemRef) -> Result<Vec<Comment>> {
            unimplemented!()
        }
        async fn transitions(&self, _: &ItemRef) -> Result<Vec<Move>> {
            unimplemented!()
        }
        async fn people(&self, _: &ItemRef, _: &str) -> Result<Vec<Person>> {
            unimplemented!()
        }
        async fn apply_with_files(&self, _: &Intent, _: &[Uploaded]) -> Result<Applied> {
            unimplemented!()
        }
        async fn attach(&self, _: &ItemRef, _: &str, _: &str, _: Vec<u8>) -> Result<Uploaded> {
            unimplemented!()
        }
        async fn attachment_limit(&self) -> Result<Option<u64>> {
            unimplemented!()
        }
        async fn media_id(&self, _: &str) -> Result<Option<String>> {
            unimplemented!()
        }
        async fn download(&self, _: &str) -> Result<(String, Vec<u8>)> {
            unimplemented!()
        }
    }

    const CONNECTION: &str = "jira:site:me";

    fn item(key: &str, epic: bool) -> WorkItem {
        let mut t = sample_ticket();
        t.key = key.into();
        t.is_epic = epic;
        item_from_ticket(&Connection::jira(&crate::auth::Scope { cloud_id: "site".into(), account_id: "me".into() }, "Site"), &t)
    }

    const NOW: &str = "2026-09-29T12:00:00Z";

    #[tokio::test]
    async fn a_full_pull_sends_no_cursor_and_skips_children_without_epics() {
        let fake = Fake { followed: vec![item("CA-1", false)], ..Default::default() };
        let pulled = pull(&fake, CONNECTION, Plan::Full, &SyncState::default(), &[], "h", at(NOW)).await.unwrap();
        assert_eq!(pulled.tracked.len(), 1);
        assert_eq!(*fake.calls.lock().unwrap(), ["followed", "containers"]);
        assert_eq!(fake.opts.lock().unwrap()[0].updated_since_minutes, None);
    }

    #[tokio::test]
    async fn an_incremental_pull_sends_the_cursor_and_asks_for_children_of_epics_already_cached() {
        let fake = Fake { followed: vec![item("CA-1", true)], children: vec![item("CA-5", false)], ..Default::default() };
        let known = vec!["CA-1".to_string(), "CA-9".to_string()];
        let state = SyncState { containers_at: Some("2026-09-29T11:00:00Z".into()), ..Default::default() };
        let pulled = pull(&fake, CONNECTION, Plan::Since { minutes: 15 }, &state, &known, "h", at(NOW)).await.unwrap();
        assert_eq!(*fake.calls.lock().unwrap(), ["followed", "children CA-1,CA-9"]);
        assert!(fake.opts.lock().unwrap().iter().all(|o| o.updated_since_minutes == Some(15)));
        assert_eq!(pulled.context.len(), 1);
        assert!(pulled.containers.is_none(), "refreshed an hour ago");
    }

    #[tokio::test]
    async fn containers_that_fail_to_load_do_not_fail_the_pull() {
        let fake = Fake { containers_fail: true, ..Default::default() };
        let pulled = pull(&fake, CONNECTION, Plan::Full, &SyncState::default(), &[], "h", at(NOW)).await.unwrap();
        assert!(pulled.containers.is_none());
    }

    #[tokio::test]
    async fn syncing_twice_stores_once_and_moves_from_a_full_pull_to_an_incremental_one() {
        let db = Db::in_memory().unwrap();
        let fake = Fake { followed: vec![item("CA-1", true)], children: vec![item("CA-5", false)], ..Default::default() };
        let run = |plan: Plan, started: &str| {
            let started = at(started);
            let state = db.sync_state(CONNECTION).unwrap();
            let fake = &fake;
            let db = &db;
            async move {
                let pulled = pull(fake, CONNECTION, plan, &state, &[], "2000-01-01T00:00:00Z", started).await.unwrap();
                store(db, CONNECTION, "me", &pulled, plan, started, "2000-01-01T00:00:00Z", true).unwrap()
            }
        };

        let first = run(Plan::Full, "2026-09-29T10:00:00Z").await;
        assert_eq!(first.upserted.inserted, 2);
        assert_eq!(first.new_events.len(), 2);
        let state = db.sync_state(CONNECTION).unwrap();
        assert_eq!(state.cursor.as_deref(), Some("2026-09-29T10:00:00Z"));
        assert_eq!(state.full_at.as_deref(), Some("2026-09-29T10:00:00Z"));
        assert_eq!(state.containers_at.as_deref(), Some("2026-09-29T10:00:00Z"));
        assert_eq!(plan(&state, at("2026-09-29T10:05:00Z")), Plan::Since { minutes: 5 + CLOCK_SKEW_MINUTES });

        let second = run(Plan::Since { minutes: 15 }, "2026-09-29T10:05:00Z").await;
        assert!(!second.upserted.any(), "the same items again change nothing");
        assert!(second.new_events.is_empty(), "events are reported once");
        let state = db.sync_state(CONNECTION).unwrap();
        assert_eq!(state.cursor.as_deref(), Some("2026-09-29T10:05:00Z"));
        assert_eq!(state.full_at.as_deref(), Some("2026-09-29T10:00:00Z"), "only a full pull refreshes every item");
        assert_eq!(db.events_for_item(&ItemRef { connection_id: CONNECTION.into(), external_id: "CA-1".into(), key: "CA-1".into() }, 10).unwrap().len(), 2);
    }

    #[tokio::test]
    async fn the_first_sync_of_a_connection_announces_nothing() {
        let db = Db::in_memory().unwrap();
        let fake = Fake { followed: vec![item("CA-1", false)], ..Default::default() };
        let pulled = pull(&fake, CONNECTION, Plan::Full, &SyncState::default(), &[], "h", at(NOW)).await.unwrap();
        let stored = store(&db, CONNECTION, "me", &pulled, Plan::Full, at(NOW), "2000-01-01T00:00:00Z", false).unwrap();
        assert!(stored.new_events.is_empty());
        assert_eq!(db.events("2000-01-01T00:00:00Z").unwrap().len(), 2, "still stored, just not announced");
    }

    #[tokio::test]
    async fn a_full_sync_prunes_items_nobody_has_refreshed_for_months() {
        let db = Db::in_memory().unwrap();
        db.upsert_items(&[item("CA-9", false)], "2026-01-01T00:00:00Z").unwrap();
        let fake = Fake { followed: vec![item("CA-1", false)], ..Default::default() };
        let pulled = pull(&fake, CONNECTION, Plan::Full, &SyncState::default(), &[], "h", at(NOW)).await.unwrap();
        store(&db, CONNECTION, "me", &pulled, Plan::Full, at(NOW), "2000-01-01T00:00:00Z", true).unwrap();
        let left = db.items_synced_since(CONNECTION, "").unwrap();
        assert_eq!(left.iter().map(|i| i.item.key.as_str()).collect::<Vec<_>>(), ["CA-1"]);
    }

    #[test]
    fn only_kinds_with_a_neutral_name_become_domain_events() {
        let mut t = sample_ticket();
        t.history[0].items.push(crate::model::HistoryItem { field: "priority".into(), from: None, to: Some("High".into()), to_id: None });
        let events = derive(&t, "me");
        assert_eq!(events.len(), 3);
        let mapped: Vec<Event> = events.iter().filter_map(|e| domain_event(CONNECTION, e)).collect();
        assert_eq!(mapped.iter().map(|e| e.kind).collect::<Vec<_>>(), [EventKind::StatusChanged, EventKind::CommentAdded]);
        assert_eq!(mapped[0].id, "h:500:status");
    }

    #[test]
    fn scheduled_syncs_wait_for_the_poll_interval() {
        let mut s = Schedule::default();
        let t0 = at(NOW);
        assert!(s.due(t0, Trigger::Timer), "launch catches up at once");
        s.finished(t0, true);
        assert!(!s.due(t0 + Duration::seconds(59), Trigger::Timer));
        assert!(s.due(t0 + Duration::seconds(60), Trigger::Timer));
    }

    #[test]
    fn a_focus_can_sync_sooner_but_not_in_a_burst() {
        let mut s = Schedule::default();
        let t0 = at(NOW);
        s.finished(t0, true);
        assert!(!s.due(t0 + Duration::seconds(5), Trigger::Focus));
        assert!(s.due(t0 + Duration::seconds(15), Trigger::Focus));
    }

    #[test]
    fn failures_back_off_exponentially_up_to_a_ceiling_and_success_resets() {
        let mut s = Schedule::default();
        let mut now = at(NOW);
        let mut waits = Vec::new();
        for _ in 0..8 {
            s.finished(now, false);
            let wait = s.retry_at.unwrap() - now;
            waits.push(wait.num_seconds());
            assert!(!s.due(now + wait - Duration::seconds(1), Trigger::Timer));
            assert!(!s.due(now + wait - Duration::seconds(1), Trigger::Focus));
            now += wait;
        }
        assert_eq!(waits, [60, 120, 240, 480, 900, 900, 900, 900]);
        s.finished(now, true);
        assert!(!s.due(now + Duration::seconds(30), Trigger::Timer));
        assert!(s.due(now + POLL_INTERVAL, Trigger::Timer));
    }

    #[test]
    fn asking_now_ignores_both_the_interval_and_a_backoff() {
        let mut s = Schedule::default();
        let t0 = at(NOW);
        s.finished(t0, false);
        assert!(!s.due(t0 + Duration::seconds(10), Trigger::Timer));
        assert!(s.due(t0 + Duration::seconds(10), Trigger::Now));
    }
}
