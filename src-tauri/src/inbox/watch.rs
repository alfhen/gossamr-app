//! Core's watch service: what each connection follows, the catalog it is chosen from, and suggestions for choosing.

use std::collections::HashSet;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use super::{now_iso, unread_cutoff, without_extra, Core, LAST_SYNC};
use crate::auth::Scope;
use crate::db::Db;
use crate::domain::{
    ContainerQuery, ContainerRef, ContainerSummary, Footprint, ItemRef, Stray, Watch, WatchChange, WatchMode, WatchSet, WorkItem, AUTO_EVERYTHING_MAX,
};
use crate::error::{Error, Result};
use crate::tracker::{Connection, WorkTracker};

const CATALOG_SIZE: &str = "watch_catalog_size";
const CATALOG_PROBED: &str = "watch_catalog_probed_at";
const FOOTPRINT: &str = "watch_footprint";
const STRAYS: &str = "watch_strays";
const STRAYS_DISMISSED: &str = "watch_strays_dismissed";
const PROBE_EVERY: Duration = Duration::hours(12);
const FOOTPRINT_TTL: Duration = Duration::hours(6);
const FOOTPRINT_DAYS: u32 = 90;
/// How often unwatched containers are checked for items assigned to the person.
pub const RADAR_EVERY: Duration = Duration::minutes(15);
const CATALOG_PAGE: usize = 50;

/// One watched container as Settings lists it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchRow {
    #[serde(flatten)]
    pub watch: Watch,
    pub key: String,
    pub name: String,
    /// Items of it in the local cache.
    pub cached_items: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchState {
    pub connection_id: String,
    pub mode: WatchMode,
    /// Nothing is chosen and the catalog is too big to watch whole, so the person must pick.
    pub needs_choice: bool,
    /// Containers seen when the catalog was last probed; 13 means "more than 12".
    pub catalog_size: Option<usize>,
    /// Every row, including soft-unwatched ones (`unwatchedAt` set) that are still inside their grace period.
    pub watches: Vec<WatchRow>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    #[serde(flatten)]
    pub summary: ContainerSummary,
    pub watched: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPage {
    pub containers: Vec<CatalogEntry>,
    pub next: Option<String>,
    /// True when the tracker couldn't be reached and this came from what was seen before.
    pub offline: bool,
}

#[derive(Serialize, Deserialize)]
struct CachedFootprint {
    at: String,
    rows: Vec<Footprint>,
}

fn parse_time(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s).ok().map(|d| d.with_timezone(&Utc))
}

fn meta_json<T: for<'de> Deserialize<'de>>(db: &Db, key: &str) -> Result<Option<T>> {
    Ok(db.meta(key)?.and_then(|s| serde_json::from_str(&s).ok()))
}

impl Core {
    fn own_connection(&self, scope: &Scope, connection_id: &str) -> Result<Connection> {
        let c = self.connection(scope)?;
        if c.id != connection_id {
            return Err(Error::SiteChanged);
        }
        Ok(c)
    }

    /// What `scope`'s connection follows. Autopilot and other writers ask this before acting on an item.
    pub async fn watch_set_of(&self, scope: &Scope) -> Result<WatchSet> {
        let id = Connection::jira_id(scope);
        self.with_db_for(scope, |db| db.watch_set(&id)).await
    }

    /// Whether `key` is cached in a container that is watched. An item that isn't cached has no known container, so
    /// it counts as not watched.
    pub async fn is_item_watched(&self, scope: &Scope, key: &str) -> Result<bool> {
        let item = Self::item(scope, key);
        self.with_db_for(scope, |db| Ok(db.item(&item)?.is_some_and(|i| db.watch_set(&item.connection_id).is_ok_and(|w| w.is_watched(&i.container.external_id))))).await
    }

    pub async fn watch_state(&self) -> Result<Vec<WatchState>> {
        let mut states = self.jira_watch_state().await?;
        states.extend(self.code_watch_states().await?);
        Ok(states)
    }

    async fn jira_watch_state(&self) -> Result<Vec<WatchState>> {
        let Some((site, me)) = self.auth.identity().await else { return Ok(Vec::new()) };
        let scope = Scope::of(&site, &me);
        let id = self.connection(&scope)?.id;
        let state = self
            .with_db_for(&scope, |db| {
                let set = db.watch_set(&id)?;
                let counts = db.item_counts(&id)?;
                let known: std::collections::HashMap<String, (String, String)> =
                    db.containers(&id)?.into_iter().map(|c| (c.container_ref.external_id, (c.key, c.name))).collect();
                let size: Option<usize> = db.meta(CATALOG_SIZE)?.and_then(|s| s.parse().ok());
                let watches = set
                    .watches
                    .iter()
                    .map(|w| {
                        let ext = &w.container.external_id;
                        let (key, name) = known
                            .get(ext)
                            .cloned()
                            .or_else(|| db.catalog_search(&id, ext, 5).ok()?.into_iter().find(|c| &c.container_ref.external_id == ext).map(|c| (c.key, c.name)))
                            .unwrap_or_else(|| (ext.clone(), ext.clone()));
                        WatchRow { watch: w.clone(), key, name, cached_items: counts.get(ext).copied().unwrap_or(0) }
                    })
                    .collect();
                let needs_choice = set.mode == WatchMode::Unset && size.is_some_and(|n| n > AUTO_EVERYTHING_MAX);
                Ok(WatchState { connection_id: id.clone(), mode: set.mode, needs_choice, catalog_size: size, watches })
            })
            .await?;
        Ok(vec![state])
    }

    /// Makes the next sync read everything in the window again and refresh the containers, which is how a container
    /// that was just watched is backfilled.
    fn backfill_next_sync(db: &Db, connection_id: &str) -> Result<()> {
        let mut state = db.sync_state(connection_id)?;
        state.full_at = None;
        state.containers_at = None;
        db.save_sync_state(connection_id, &state)
    }

    async fn changed_watch(&self, scope: &Scope, connection_id: &str, edit: impl FnOnce(&Db) -> Result<()>) -> Result<()> {
        let changed = self
            .with_db_for(scope, |db| {
                let before = db.watch_set(connection_id)?.signature();
                edit(db)?;
                let changed = db.watch_set(connection_id)?.signature() != before;
                if changed {
                    Self::backfill_next_sync(db, connection_id)?;
                }
                Ok(changed)
            })
            .await?;
        if changed {
            self.wake.notify_one();
        }
        Ok(())
    }

    pub async fn watch_set_mode(&self, connection_id: &str, mode: WatchMode) -> Result<()> {
        if super::code::is_code_connection(connection_id) {
            return self.code_watch_set_mode(connection_id, mode).await;
        }
        let scope = self.scope().await?;
        self.own_connection(&scope, connection_id)?;
        self.changed_watch(&scope, connection_id, |db| db.set_watch_mode(connection_id, mode, &now_iso())).await
    }

    pub async fn watch_set_containers(&self, connection_id: &str, changes: &[WatchChange]) -> Result<()> {
        if super::code::is_code_connection(connection_id) {
            return self.code_watch_set_containers(connection_id, changes).await;
        }
        let scope = self.scope().await?;
        self.own_connection(&scope, connection_id)?;
        self.changed_watch(&scope, connection_id, |db| db.apply_watch_changes(connection_id, changes, &now_iso())).await
    }

    /// One page of the catalog matching `query`, straight from the tracker, remembering what it lists. Without a
    /// connection to the tracker it searches what was listed before.
    pub async fn watch_catalog(&self, connection_id: &str, query: &str, cursor: Option<String>) -> Result<CatalogPage> {
        if super::code::is_code_connection(connection_id) {
            return self.code_watch_catalog(connection_id, query, cursor).await;
        }
        let scope = self.scope().await?;
        self.own_connection(&scope, connection_id)?;
        let set = self.watch_set_of(&scope).await?;
        let q = ContainerQuery { query: query.trim().into(), cursor, limit: CATALOG_PAGE };
        let entry = |summary: ContainerSummary| {
            let watched = set.is_watched(&summary.container_ref.external_id);
            CatalogEntry { summary, watched }
        };
        match self.tracker(&scope)?.list_containers(&q).await {
            Ok(page) => {
                self.with_db_for(&scope, |db| db.catalog_upsert(connection_id, &page.containers, &now_iso())).await?;
                Ok(CatalogPage { containers: page.containers.into_iter().map(entry).collect(), next: page.next, offline: false })
            }
            Err(Error::Http(_)) if q.cursor.is_none() => {
                let cached = self.with_db_for(&scope, |db| db.catalog_search(connection_id, &q.query, CATALOG_PAGE)).await?;
                Ok(CatalogPage { containers: cached.into_iter().map(entry).collect(), next: None, offline: true })
            }
            Err(e) => Err(e),
        }
    }

    /// Containers matching `query` in the tracker's whole catalog, each with whether it is watched.
    pub async fn find_containers(&self, scope: &Scope, query: &str, limit: usize) -> Result<Vec<(ContainerSummary, bool)>> {
        let id = Connection::jira_id(scope);
        let set = self.watch_set_of(scope).await?;
        let q = ContainerQuery { query: query.trim().into(), cursor: None, limit };
        let found = match self.tracker(scope)?.list_containers(&q).await {
            Ok(page) => {
                self.with_db_for(scope, |db| db.catalog_upsert(&id, &page.containers, &now_iso())).await?;
                page.containers
            }
            Err(Error::Http(_)) => self.with_db_for(scope, |db| db.catalog_search(&id, &q.query, limit)).await?,
            Err(e) => return Err(e),
        };
        Ok(found
            .into_iter()
            .map(|c| {
                let watched = set.is_watched(&c.container_ref.external_id);
                (c, watched)
            })
            .collect())
    }

    /// The container a person or Pip means by its id or key, watched or not.
    pub async fn container_named(&self, scope: &Scope, name: &str) -> Result<Option<ContainerRef>> {
        let same = |id: &str, key: &str| id == name || key.eq_ignore_ascii_case(name);
        if let Some(c) = self.containers_in(scope).await?.into_iter().find(|c| same(&c.container_ref.external_id, &c.key)) {
            return Ok(Some(c.container_ref));
        }
        let found = self.find_containers(scope, name, CATALOG_PAGE).await?;
        Ok(found.into_iter().map(|(c, _)| c).find(|c| same(&c.container_ref.external_id, &c.key)).map(|c| c.container_ref))
    }

    /// Where the person has been involved lately, for choosing what to watch. Kept for a few hours, since answering
    /// costs several searches.
    pub async fn watch_suggestions(&self, connection_id: &str, refresh: bool) -> Result<Vec<Footprint>> {
        if super::code::is_code_connection(connection_id) {
            return self.code_watch_suggestions(connection_id, refresh).await;
        }
        let scope = self.scope().await?;
        self.own_connection(&scope, connection_id)?;
        let cached: Option<CachedFootprint> = self.with_db_for(&scope, |db| meta_json(db, FOOTPRINT)).await?;
        if let Some(c) = cached.filter(|c| !refresh && parse_time(&c.at).is_some_and(|at| Utc::now() - at < FOOTPRINT_TTL)) {
            return Ok(c.rows);
        }
        let rows = self.tracker(&scope)?.footprint(FOOTPRINT_DAYS).await?;
        let stored = serde_json::to_string(&CachedFootprint { at: now_iso(), rows: rows.clone() })?;
        self.with_db_for(&scope, |db| db.set_meta(FOOTPRINT, &stored)).await?;
        Ok(rows)
    }

    /// Open items assigned to the person in containers they don't watch, as the last check found them.
    pub async fn watch_unwatched_assigned(&self, connection_id: &str, refresh: bool) -> Result<Vec<Stray>> {
        if super::code::is_code_connection(connection_id) {
            return Ok(Vec::new());
        }
        let scope = self.scope().await?;
        self.own_connection(&scope, connection_id)?;
        if refresh {
            self.check_assigned_elsewhere(&scope).await?;
        }
        self.with_db_for(&scope, visible_strays).await
    }

    /// Hides the suggestion for a container until the person is next assigned something in a different one.
    pub async fn watch_dismiss_assigned(&self, connection_id: &str, container_id: &str) -> Result<()> {
        if super::code::is_code_connection(connection_id) {
            return Ok(());
        }
        let scope = self.scope().await?;
        self.own_connection(&scope, connection_id)?;
        self.with_db_for(&scope, |db| {
            let mut dismissed: Vec<String> = meta_json(db, STRAYS_DISMISSED)?.unwrap_or_default();
            if !dismissed.iter().any(|d| d == container_id) {
                dismissed.push(container_id.into());
            }
            db.set_meta(STRAYS_DISMISSED, &serde_json::to_string(&dismissed)?)
        })
        .await
    }

    /// Runs the check for assigned items in unwatched containers when it is due, and returns the ones that are new
    /// since the last check. It only reads keys, and never adds a container to the watch set.
    pub async fn radar_if_due(&self) -> Result<Option<(String, Vec<Stray>)>> {
        let Some((site, me)) = self.auth.identity().await else { return Ok(None) };
        let scope = Scope::of(&site, &me);
        let id = Connection::jira_id(&scope);
        let now = Utc::now();
        {
            let mut last = self.radar.lock().expect("radar lock poisoned");
            if last.get(&id).is_some_and(|at| now - *at < RADAR_EVERY) {
                return Ok(None);
            }
            last.insert(id.clone(), now);
        }
        Ok(self.check_assigned_elsewhere(&scope).await?.map(|new| (id, new)))
    }

    async fn check_assigned_elsewhere(&self, scope: &Scope) -> Result<Option<Vec<Stray>>> {
        let set = self.watch_set_of(scope).await?;
        if set.mode != WatchMode::Selected {
            self.with_db_for(scope, |db| db.set_meta(STRAYS, "[]")).await?;
            return Ok(None);
        }
        let refs: Vec<_> = set.watches.iter().filter(|w| w.unwatched_at.is_none()).map(|w| w.container.clone()).collect();
        let found = self.tracker(scope)?.assigned_outside(&refs).await?;
        self.with_db_for(scope, |db| {
            let before: Vec<Stray> = meta_json(db, STRAYS)?.unwrap_or_default();
            let known: HashSet<&str> = before.iter().flat_map(|s| s.keys.iter().map(String::as_str)).collect();
            let new: Vec<Stray> = found
                .iter()
                .filter_map(|s| {
                    let keys: Vec<String> = s.keys.iter().filter(|k| !known.contains(k.as_str())).cloned().collect();
                    (!keys.is_empty()).then(|| Stray { keys, ..s.clone() })
                })
                .collect();
            db.set_meta(STRAYS, &serde_json::to_string(&found)?)?;
            let dismissed: Vec<String> = meta_json(db, STRAYS_DISMISSED)?.unwrap_or_default();
            let new: Vec<Stray> = new.into_iter().filter(|s| !dismissed.contains(&s.container.external_id)).collect();
            Ok((!new.is_empty()).then_some(new))
        })
        .await
    }

    /// Chooses `Everything` for a connection that hasn't chosen and whose catalog is small, and notes how big the
    /// catalog is so the page knows whether to ask. One small request, repeated only every few hours.
    pub(super) async fn settle_watch_mode(&self, scope: &Scope, tracker: &dyn WorkTracker, set: WatchSet) -> Result<(WatchSet, bool)> {
        if set.mode != WatchMode::Unset {
            return Ok((set, false));
        }
        let id = Connection::jira_id(scope);
        let due = self
            .with_db_for(scope, |db| Ok(db.meta(CATALOG_PROBED)?.and_then(|s| parse_time(&s)).is_none_or(|at| Utc::now() - at >= PROBE_EVERY)))
            .await?;
        if !due {
            return Ok((set, false));
        }
        let probe = ContainerQuery { query: String::new(), cursor: None, limit: AUTO_EVERYTHING_MAX + 1 };
        // A catalog that can't be read leaves the choice for later; syncing carries on as before.
        let Ok(page) = tracker.list_containers(&probe).await else { return Ok((set, false)) };
        let small = page.containers.len() <= AUTO_EVERYTHING_MAX && page.next.is_none();
        let seen = page.containers.len().min(AUTO_EVERYTHING_MAX + 1);
        self.with_db_for(scope, |db| {
            db.catalog_upsert(&id, &page.containers, &now_iso())?;
            db.set_meta(CATALOG_SIZE, &seen.to_string())?;
            db.set_meta(CATALOG_PROBED, &now_iso())?;
            if small {
                db.set_watch_mode(&id, WatchMode::Everything, &now_iso())?;
            }
            Ok(())
        })
        .await?;
        Ok((WatchSet { mode: if small { WatchMode::Everything } else { set.mode }, ..set }, small))
    }

    /// An item read live, for a container that may not be watched. Nothing is stored. `None` when the tracker says
    /// it doesn't exist or can't be seen.
    pub async fn peek_item(&self, item: &ItemRef) -> Result<Option<WorkItem>> {
        let scope = self.scope().await?;
        if item.connection_id != self.connection(&scope)?.id {
            return Err(Error::SiteChanged);
        }
        let (set, last_sync) = self.with_db_for(&scope, |db| Ok((db.watch_set(&item.connection_id)?, db.meta(LAST_SYNC)?))).await?;
        let fetched = match self.tracker(&scope)?.item(item, &unread_cutoff(last_sync.as_deref())).await {
            Ok(i) => i,
            Err(Error::Api { status: 404, .. }) => return Ok(None),
            Err(e) => return Err(e),
        };
        let mut peeked = without_extra(fetched);
        peeked.unwatched = !set.is_watched(&peeked.container.external_id);
        Ok(Some(peeked))
    }

    /// The watched cached item, or a live read of it. A failed read is `None`: this stands in for a cache lookup.
    pub async fn cache_item(&self, item: &ItemRef) -> Result<Option<WorkItem>> {
        let scope = self.scope().await?;
        let cached = self
            .with_db_for(&scope, |db| Ok(db.item(item)?.filter(|i| db.watch_set(&item.connection_id).is_ok_and(|w| w.is_watched(&i.container.external_id)))))
            .await?;
        match cached {
            Some(i) => Ok(Some(without_extra(i))),
            None => Ok(self.peek_item(item).await.ok().flatten()),
        }
    }
}

fn visible_strays(db: &Db) -> Result<Vec<Stray>> {
    let dismissed: Vec<String> = meta_json(db, STRAYS_DISMISSED)?.unwrap_or_default();
    let all: Vec<Stray> = meta_json(db, STRAYS)?.unwrap_or_default();
    Ok(all.into_iter().filter(|s| !dismissed.contains(&s.container.external_id)).collect())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;

    use super::*;
    use crate::domain::{ContainerSummary, Depth, Filter, WatchSource};
    use crate::inbox::testing::{fixture, Fixture};

    fn summary(key: &str) -> ContainerSummary {
        ContainerSummary {
            container_ref: ContainerRef { connection_id: "jira:site:me".into(), external_id: key.into() },
            key: key.into(),
            name: format!("Project {key}"),
            kind: None,
            archived: false,
            last_active: None,
            item_hint: None,
        }
    }

    fn watch(id: &str) -> WatchChange {
        WatchChange { container_id: id.into(), watched: Some(true), ..Default::default() }
    }

    async fn selected(fx: &Fixture, changes: &[WatchChange]) {
        fx.core.watch_set_mode("jira:site:me", WatchMode::Selected).await.unwrap();
        fx.core.watch_set_containers("jira:site:me", changes).await.unwrap();
    }

    async fn keys(fx: &Fixture, include_unwatched: bool) -> Vec<String> {
        let mut found: Vec<String> =
            fx.core.cache_search(&Filter::And { filters: vec![] }, include_unwatched).await.unwrap().into_iter().map(|i| i.item.key).collect();
        found.sort();
        found
    }

    #[tokio::test]
    async fn a_connection_that_has_not_chosen_keeps_showing_everything() {
        let fx = fixture().await;
        fx.add_in("OTH-1", "OTH").await;
        let state = &fx.core.watch_state().await.unwrap()[0];
        assert_eq!((state.mode, state.needs_choice, state.watches.len()), (WatchMode::Unset, false, 0));
        assert_eq!(keys(&fx, false).await, ["CA-1", "OTH-1"]);
    }

    #[tokio::test]
    async fn selected_mode_shows_only_watched_containers_and_the_escape_shows_the_rest() {
        let fx = fixture().await;
        fx.add_in("OTH-1", "OTH").await;
        selected(&fx, &[watch("CA")]).await;
        assert_eq!(keys(&fx, false).await, ["CA-1"]);
        assert_eq!(keys(&fx, true).await, ["CA-1", "OTH-1"]);
        let found = fx.core.search_cached(&fx.scope, &Filter::And { filters: vec![] }).await.unwrap();
        assert_eq!(found.len(), 1, "Pip's search is scoped the same way");

        let all = fx.core.cache_containers(true).await.unwrap();
        assert_eq!(all.len(), 1);
        fx.core.watch_set_containers("jira:site:me", &[WatchChange { container_id: "CA".into(), watched: Some(false), ..Default::default() }]).await.unwrap();
        assert!(fx.core.cache_containers(false).await.unwrap().is_empty());
        assert_eq!(keys(&fx, false).await, Vec::<String>::new());
        fx.core.watch_set_containers("jira:site:me", &[watch("CA")]).await.unwrap();
        assert_eq!(keys(&fx, false).await, ["CA-1"], "watching again inside the grace period needs no refetch");
    }

    #[tokio::test]
    async fn the_snapshot_the_inbox_reads_is_scoped_too() {
        let fx = fixture().await;
        fx.add_in("OTH-1", "OTH").await;
        let actor = crate::model::Person { account_id: "sam".into(), name: "Sam".into(), avatar_url: None };
        let event = |id: &str, key: &str| crate::events::NewEvent {
            id: id.into(),
            kind: crate::model::EventKind::Comment,
            ticket_key: key.into(),
            actor: actor.clone(),
            at: crate::inbox::now_iso(),
            text: "hi".into(),
            field: None,
        };
        fx.core.with_db_for(&fx.scope, |db| db.insert_events(&[event("a", "CA-1"), event("b", "OTH-1")], "2000-01-01T00:00:00Z").map(|_| ())).await.unwrap();
        let before = fx.core.snapshot().await.unwrap();
        assert_eq!((before.tickets.len(), before.events.len()), (2, 2));
        selected(&fx, &[watch("CA")]).await;
        let after = fx.core.snapshot().await.unwrap();
        assert_eq!(after.tickets.keys().collect::<Vec<_>>(), ["CA-1"]);
        assert_eq!(after.events.iter().map(|e| e.ticket_key.as_str()).collect::<Vec<_>>(), ["CA-1"]);
    }

    #[tokio::test]
    async fn an_unwatched_item_is_read_live_flagged_and_never_stored() {
        let fx = fixture().await;
        selected(&fx, &[]).await;
        let peeked = fx.core.cache_item(&fx.item("CA-99")).await.unwrap().expect("read live");
        assert!(peeked.unwatched && peeked.item.key == "CA-99");
        assert!(fx.core.with_db_for(&fx.scope, |db| db.item(&fx.item("CA-99"))).await.unwrap().is_none());
        let cached_but_unwatched = fx.core.cache_item(&fx.item("CA-1")).await.unwrap().unwrap();
        assert!(cached_but_unwatched.unwatched, "a cached item in an unwatched container is read live, not from the cache");

        fx.core.watch_set_containers("jira:site:me", &[watch("CA")]).await.unwrap();
        let watched = fx.core.cache_item(&fx.item("CA-1")).await.unwrap().unwrap();
        assert!(!watched.unwatched);
        assert!(fx.core.peek_item(&fx.item("CA-1")).await.unwrap().is_some_and(|i| !i.unwatched));
        let mut foreign = fx.item("CA-1");
        foreign.connection_id = "jira:other:me".into();
        assert!(fx.core.peek_item(&foreign).await.is_err());
    }

    #[tokio::test]
    async fn a_write_to_an_unwatched_item_is_not_stored_in_the_cache() {
        let fx = fixture().await;
        selected(&fx, &[]).await;
        fx.core.refresh(&fx.scope, "CA-77").await.unwrap();
        assert!(fx.core.with_db_for(&fx.scope, |db| db.item(&fx.item("CA-77"))).await.unwrap().is_none());
        selected(&fx, &[watch("CA")]).await;
        fx.core.refresh(&fx.scope, "CA-77").await.unwrap();
        assert!(fx.core.with_db_for(&fx.scope, |db| db.item(&fx.item("CA-77"))).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn is_item_watched_is_the_one_check_a_writer_makes() {
        let fx = fixture().await;
        fx.add_in("OTH-1", "OTH").await;
        assert!(fx.core.is_item_watched(&fx.scope, "OTH-1").await.unwrap(), "unset syncs everything, so everything is watched");
        assert!(!fx.core.is_item_watched(&fx.scope, "NOPE-1").await.unwrap(), "an unknown item has no known container");
        selected(&fx, &[watch("CA")]).await;
        assert!(fx.core.is_item_watched(&fx.scope, "CA-1").await.unwrap());
        assert!(!fx.core.is_item_watched(&fx.scope, "OTH-1").await.unwrap());
    }

    #[tokio::test]
    async fn watching_more_or_changing_depth_backfills_but_pinning_does_not() {
        let fx = fixture().await;
        let id = "jira:site:me";
        fx.core
            .with_db_for(&fx.scope, |db| db.save_sync_state(id, &crate::db::SyncState { cursor: Some("c".into()), full_at: Some("f".into()), containers_at: Some("k".into()) }))
            .await
            .unwrap();
        selected(&fx, &[watch("CA")]).await;
        let s = fx.core.with_db_for(&fx.scope, |db| db.sync_state(id)).await.unwrap();
        assert_eq!((s.cursor.as_deref(), s.full_at, s.containers_at), (Some("c"), None, None), "the cursor stays; the next sync is a full one");

        fx.core.with_db_for(&fx.scope, |db| db.save_sync_state(id, &crate::db::SyncState { cursor: Some("c".into()), full_at: Some("f".into()), containers_at: Some("k".into()) })).await.unwrap();
        fx.core.watch_set_containers(id, &[WatchChange { container_id: "CA".into(), pinned: Some(true), ..Default::default() }]).await.unwrap();
        assert_eq!(fx.core.with_db_for(&fx.scope, |db| db.sync_state(id)).await.unwrap().full_at.as_deref(), Some("f"));
        fx.core.watch_set_containers(id, &[WatchChange { container_id: "CA".into(), depth: Some(Depth::Whole), ..Default::default() }]).await.unwrap();
        assert_eq!(fx.core.with_db_for(&fx.scope, |db| db.sync_state(id)).await.unwrap().full_at, None);
    }

    #[tokio::test]
    async fn a_request_for_another_connection_is_refused() {
        let fx = fixture().await;
        assert!(fx.core.watch_set_mode("jira:other:me", WatchMode::Selected).await.is_err());
        assert!(fx.core.watch_set_containers("jira:other:me", &[watch("CA")]).await.is_err());
        assert!(fx.core.watch_catalog("jira:other:me", "", None).await.is_err());
        assert!(fx.core.watch_suggestions("jira:other:me", false).await.is_err());
    }

    #[tokio::test]
    async fn a_small_catalog_is_watched_whole_and_a_big_one_waits_for_a_choice() {
        let fx = fixture().await;
        let set = WatchSet::default();
        *fx.tracker.catalog.lock().unwrap() = (0..12).map(|n| summary(&format!("P{n}"))).collect();
        let (set, changed) = fx.core.settle_watch_mode(&fx.scope, fx.tracker.as_ref(), set).await.unwrap();
        assert!(changed && set.mode == WatchMode::Everything);
        let state = &fx.core.watch_state().await.unwrap()[0];
        assert_eq!((state.mode, state.needs_choice, state.catalog_size), (WatchMode::Everything, false, Some(12)));

        let big = fixture().await;
        *big.tracker.catalog.lock().unwrap() = (0..14).map(|n| summary(&format!("P{n}"))).collect();
        let (set, changed) = big.core.settle_watch_mode(&big.scope, big.tracker.as_ref(), WatchSet::default()).await.unwrap();
        assert!(!changed && set.mode == WatchMode::Unset);
        let state = &big.core.watch_state().await.unwrap()[0];
        assert_eq!((state.mode, state.needs_choice), (WatchMode::Unset, true));
        assert_eq!(big.core.watch_catalog("jira:site:me", "P1", None).await.unwrap().containers.len(), 5);
    }

    #[tokio::test]
    async fn a_chosen_mode_is_never_overridden_by_the_size_of_the_catalog() {
        let fx = fixture().await;
        selected(&fx, &[]).await;
        let set = fx.core.watch_set_of(&fx.scope).await.unwrap();
        let (set, changed) = fx.core.settle_watch_mode(&fx.scope, fx.tracker.as_ref(), set).await.unwrap();
        assert!(!changed && set.mode == WatchMode::Selected);
    }

    #[tokio::test]
    async fn the_catalog_marks_what_is_watched_and_suggestions_are_kept_for_a_while() {
        let fx = fixture().await;
        *fx.tracker.catalog.lock().unwrap() = vec![summary("CA"), summary("WHS")];
        selected(&fx, &[WatchChange { source: Some(WatchSource::Footprint), ..watch("CA") }]).await;
        let page = fx.core.watch_catalog("jira:site:me", "", None).await.unwrap();
        assert_eq!(page.containers.iter().map(|c| (c.summary.key.as_str(), c.watched)).collect::<Vec<_>>(), [("CA", true), ("WHS", false)]);
        let row = &fx.core.watch_state().await.unwrap()[0].watches[0];
        assert_eq!((row.key.as_str(), row.name.as_str(), row.watch.source), ("CA", "Cats", WatchSource::Footprint));

        *fx.tracker.footprint.lock().unwrap() = vec![Footprint { key: "WHS".into(), assigned: 2, ..Default::default() }];
        assert_eq!(fx.core.watch_suggestions("jira:site:me", false).await.unwrap()[0].assigned, 2);
        fx.core.watch_suggestions("jira:site:me", false).await.unwrap();
        assert_eq!(fx.tracker.footprint_calls.load(Ordering::SeqCst), 1, "answered from the stored result");
        fx.core.watch_suggestions("jira:site:me", true).await.unwrap();
        assert_eq!(fx.tracker.footprint_calls.load(Ordering::SeqCst), 2);
    }

    fn stray(container: &str, keys: &[&str]) -> Stray {
        Stray { container: ContainerRef { connection_id: "jira:site:me".into(), external_id: container.into() }, container_name: container.into(), keys: keys.iter().map(|k| k.to_string()).collect() }
    }

    #[tokio::test]
    async fn items_assigned_in_unwatched_containers_are_suggested_once_and_never_watched_for_the_person() {
        let fx = fixture().await;
        *fx.tracker.strays.lock().unwrap() = vec![stray("WHS", &["WHS-1"])];
        assert!(fx.core.check_assigned_elsewhere(&fx.scope).await.unwrap().is_none(), "nothing is unwatched while everything is synced");
        selected(&fx, &[watch("CA")]).await;

        let new = fx.core.check_assigned_elsewhere(&fx.scope).await.unwrap().unwrap();
        assert_eq!(new[0].keys, ["WHS-1"]);
        assert!(fx.core.check_assigned_elsewhere(&fx.scope).await.unwrap().is_none(), "already known, so not announced again");
        *fx.tracker.strays.lock().unwrap() = vec![stray("WHS", &["WHS-1", "WHS-2"]), stray("FIN", &["FIN-4"])];
        let new = fx.core.check_assigned_elsewhere(&fx.scope).await.unwrap().unwrap();
        assert_eq!(new.iter().map(|s| (s.container.external_id.as_str(), s.keys.len())).collect::<Vec<_>>(), [("WHS", 1), ("FIN", 1)]);

        let listed = fx.core.watch_unwatched_assigned("jira:site:me", false).await.unwrap();
        assert_eq!(listed.len(), 2);
        fx.core.watch_dismiss_assigned("jira:site:me", "FIN").await.unwrap();
        assert_eq!(fx.core.watch_unwatched_assigned("jira:site:me", false).await.unwrap().len(), 1);
        let watch_set = fx.core.watch_set_of(&fx.scope).await.unwrap();
        assert!(!watch_set.is_watched("WHS") && !watch_set.is_watched("FIN"), "a suggestion never adds a container");
    }

    #[tokio::test]
    async fn the_radar_runs_at_most_once_per_interval() {
        let fx = fixture().await;
        selected(&fx, &[watch("CA")]).await;
        *fx.tracker.strays.lock().unwrap() = vec![stray("WHS", &["WHS-1"])];
        let first = fx.core.radar_if_due().await.unwrap();
        assert_eq!(first.map(|(id, s)| (id, s.len())), Some(("jira:site:me".to_string(), 1)));
        *fx.tracker.strays.lock().unwrap() = vec![stray("WHS", &["WHS-1"]), stray("FIN", &["FIN-1"])];
        assert!(fx.core.radar_if_due().await.unwrap().is_none(), "asked again within the interval");
    }
}
