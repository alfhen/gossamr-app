//! The connector-neutral cache: domain values stored per connection and read back by filter.

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rusqlite::types::Value as Sql;
use rusqlite::{params, params_from_iter, OptionalExtension};
use serde::Serialize;

use super::watch::in_list;
use super::Db;
use crate::domain::{Container, ContainerRef, Event, FeedEntry, FeedPage, FeedQuery, Filter, FilterContext, ItemRef, Subject, Visible, WorkItem, Workflow};
use crate::domain::Transitions;
use crate::error::Result;

/// Most ids sent in one `IN` list; a longer lens is narrowed by the filter alone.
const IN_LIST_LIMIT: usize = 500;

pub fn stamp(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// A unit-variant enum's serialised name, which is how the schema stores kinds and categories.
fn name_of<T: Serialize>(v: &T) -> String {
    serde_json::to_value(v).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default()
}


const FEED_PAGE: usize = 50;
const FEED_MAX: usize = 200;

/// The inbox's `events` row shares the cache event's id and holds what the person did with it. A stored
/// mention flag covers events that don't come from the inbox.
const MENTION: &str = "(e.kind = 'mention' OR json_extract(c.data, '$.payload.mention') = 1)";

const FEED_SELECT: &str = "SELECT c.id, c.connection_id, c.at, c.data, i.title, e.actor, COALESCE(e.unread, 0), e.done_at IS NOT NULL,
  (e.kind = 'mention' OR json_extract(c.data, '$.payload.mention') = 1)
  FROM cache_events c
  LEFT JOIN events e ON e.id = c.id
  LEFT JOIN items i ON i.connection_id = c.connection_id AND i.external_id = c.item_id";

type FeedRow = (String, String, String, String, Option<String>, Option<String>, bool, bool, Option<bool>);

fn read_feed_row(r: &rusqlite::Row) -> rusqlite::Result<FeedRow> {
    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?))
}

fn feed_entry((id, connection_id, at, data, item_title, actor, unread, done, mention): FeedRow) -> Result<Option<FeedEntry>> {
    let event: Event = serde_json::from_str(&data)?;
    let Subject::Item { item } = event.subject else { return Ok(None) };
    let actor_name = actor.and_then(|a| serde_json::from_str::<crate::model::Person>(&a).ok()).map(|p| p.name);
    let text = event.payload.get("text").and_then(|t| t.as_str()).unwrap_or_default().to_string();
    Ok(Some(FeedEntry {
        id,
        connection_id,
        at,
        kind: event.kind,
        item,
        item_title,
        actor: event.actor,
        actor_name,
        text,
        mention: mention.unwrap_or(false),
        unread,
        done,
    }))
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Upserted {
    pub inserted: usize,
    /// Items already cached whose `updated` moved.
    pub changed: usize,
}

impl Upserted {
    pub fn any(&self) -> bool {
        self.inserted + self.changed > 0
    }
}

/// Where a connection's sync stands, so the next one can ask only for what changed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SyncState {
    /// When the last successful sync began. Items changed since then are the only ones an incremental sync fetches.
    pub cursor: Option<String>,
    /// When the last sync that refreshed every item began.
    pub full_at: Option<String>,
    pub containers_at: Option<String>,
}

#[derive(Default)]
struct Narrowing {
    clauses: Vec<String>,
    args: Vec<Sql>,
}

impl Narrowing {
    fn add(&mut self, clause: &str, args: impl IntoIterator<Item = Sql>) {
        self.clauses.push(clause.to_string());
        self.args.extend(args);
    }

    /// Clauses that hold for every item the filter matches. A filter that can't be expressed in columns adds
    /// nothing, and `Filter::matches` decides.
    fn from(filter: &Filter, now: DateTime<Utc>, out: &mut Self) {
        let text = |s: &str| Sql::Text(s.to_string());
        match filter {
            Filter::Container { container } => out.add("container_id = ?", [text(&container.external_id)]),
            Filter::Assignee { person } => out.add("assignee = ?", [text(&person.account_id)]),
            Filter::Unassigned => out.add("assignee IS NULL", []),
            Filter::Status { name } => out.add("status_name = ? COLLATE NOCASE", [text(name)]),
            Filter::Category { category } => out.add("status_category = ?", [text(&name_of(category))]),
            Filter::Open => out.add("status_category != 'done'", []),
            Filter::Parent { item } => out.add("parent_id = ?", [text(&item.external_id)]),
            Filter::Stale { days } => {
                let cutoff = stamp(now - Duration::days(i64::from(*days)));
                out.add("status_category != 'done' AND updated <= ?", [Sql::Text(cutoff)]);
            }
            Filter::Items { items } if items.len() <= IN_LIST_LIMIT => {
                let marks = vec!["?"; items.len()].join(",");
                out.add(&format!("external_id IN ({marks})"), items.iter().map(|i| text(&i.external_id)));
            }
            Filter::And { filters } => filters.iter().for_each(|f| Self::from(f, now, out)),
            _ => {}
        }
    }
}

impl Db {
    /// Stores items as fetched at `synced_at`. Storing an item again replaces it, so a sync can be repeated.
    pub fn upsert_items(&self, items: &[WorkItem], synced_at: &str) -> Result<Upserted> {
        let tx = self.conn.unchecked_transaction()?;
        let mut result = Upserted::default();
        for i in items {
            let updated = stamp(i.updated);
            let prior: Option<String> = tx
                .query_row(
                    "SELECT updated FROM items WHERE connection_id = ?1 AND external_id = ?2",
                    params![i.item.connection_id, i.item.external_id],
                    |r| r.get(0),
                )
                .optional()?;
            match prior {
                None => result.inserted += 1,
                Some(p) if p != updated => result.changed += 1,
                Some(_) => {}
            }
            tx.execute(
                "INSERT OR REPLACE INTO items (connection_id, external_id, key, container_id, kind, title, status_id,
                   status_name, status_category, assignee, reporter, priority, parent_id, created, updated, data, synced_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
                params![
                    i.item.connection_id,
                    i.item.external_id,
                    i.item.key,
                    i.container.external_id,
                    name_of(&i.kind),
                    i.title,
                    i.status.id,
                    i.status.name,
                    name_of(&i.status.category),
                    i.assignee.as_ref().map(|p| &p.account_id),
                    i.reporter.as_ref().map(|p| &p.account_id),
                    i.priority.as_ref().map(name_of),
                    i.parent.as_ref().map(|p| &p.external_id),
                    stamp(i.created),
                    updated,
                    serde_json::to_string(i)?,
                    synced_at,
                ],
            )?;
        }
        tx.commit()?;
        Ok(result)
    }

    fn read_items(&self, sql: &str, args: Vec<Sql>) -> Result<Vec<WorkItem>> {
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map(params_from_iter(args), |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(serde_json::from_str(&row?)?);
        }
        Ok(out)
    }

    pub fn item(&self, item: &ItemRef) -> Result<Option<WorkItem>> {
        let args = vec![Sql::Text(item.connection_id.clone()), Sql::Text(item.external_id.clone())];
        Ok(self.read_items("SELECT data FROM items WHERE connection_id = ?1 AND external_id = ?2", args)?.into_iter().next())
    }

    /// Items refreshed at or after `since`; older ones have dropped out of every query.
    pub fn items_synced_since(&self, connection_id: &str, since: &str, visible: &Visible) -> Result<Vec<WorkItem>> {
        let mut sql = String::from("SELECT data FROM items WHERE connection_id = ?1 AND synced_at >= ?2");
        let mut args = vec![Sql::Text(connection_id.into()), Sql::Text(since.into())];
        if let Visible::Only(ids) = visible {
            sql.push_str(&format!(" AND {}", in_list("container_id", ids.len())));
            args.extend(ids.iter().map(|i| Sql::Text(i.clone())));
        }
        self.read_items(&sql, args)
    }

    pub fn epic_ids_synced_since(&self, connection_id: &str, since: &str) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT external_id FROM items WHERE connection_id = ?1 AND kind = 'epic' AND synced_at >= ?2")?;
        let rows = stmt.query_map(params![connection_id, since], |r| r.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The connection's items that match `filter`, newest first. Columns narrow the candidates and
    /// `Filter::matches` has the last word.
    pub fn search(&self, connection_id: &str, filter: &Filter, ctx: &FilterContext, visible: &Visible) -> Result<Vec<WorkItem>> {
        let mut narrowing = Narrowing::default();
        Narrowing::from(filter, ctx.now, &mut narrowing);
        if let Visible::Only(ids) = visible {
            narrowing.add(&in_list("container_id", ids.len()), ids.iter().map(|i| Sql::Text(i.clone())));
        }
        let mut sql = String::from("SELECT data FROM items WHERE connection_id = ?");
        for c in &narrowing.clauses {
            sql.push_str(&format!(" AND ({c})"));
        }
        sql.push_str(" ORDER BY updated DESC, external_id");
        let mut args = vec![Sql::Text(connection_id.into())];
        args.extend(narrowing.args);
        let candidates = self.read_items(&sql, args)?;
        let everything;
        let all: &[WorkItem] = if filter.needs_all_items() {
            let mut sql = String::from("SELECT data FROM items WHERE connection_id = ?");
            let mut args = vec![Sql::Text(connection_id.into())];
            if let Visible::Only(ids) = visible {
                sql.push_str(&format!(" AND {}", in_list("container_id", ids.len())));
                args.extend(ids.iter().map(|i| Sql::Text(i.clone())));
            }
            sql.push_str(" ORDER BY updated DESC, external_id");
            everything = self.read_items(&sql, args)?;
            &everything
        } else {
            &candidates
        };
        Ok(candidates.iter().filter(|i| filter.matches(i, all, ctx)).cloned().collect())
    }

    /// Removes items not refreshed since `before`, which no query has returned for a long while.
    pub fn prune_items(&self, connection_id: &str, before: &str) -> Result<usize> {
        Ok(self.conn.execute("DELETE FROM items WHERE connection_id = ?1 AND synced_at < ?2", params![connection_id, before])?)
    }

    /// Replaces the connection's containers and their workflows.
    pub fn replace_containers(&self, connection_id: &str, containers: &[Container], synced_at: &str) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM containers WHERE connection_id = ?1", params![connection_id])?;
        tx.execute("DELETE FROM workflows WHERE connection_id = ?1", params![connection_id])?;
        for c in containers {
            tx.execute(
                "INSERT INTO containers (connection_id, external_id, key, name, synced_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![connection_id, c.container_ref.external_id, c.key, c.name, synced_at],
            )?;
            tx.execute(
                "INSERT INTO workflows (connection_id, container_id, data, synced_at) VALUES (?1, ?2, ?3, ?4)",
                params![connection_id, c.container_ref.external_id, serde_json::to_string(&c.workflow)?, synced_at],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn containers(&self, connection_id: &str) -> Result<Vec<Container>> {
        let mut stmt = self.conn.prepare(
            "SELECT c.external_id, c.key, c.name, w.data FROM containers c
             LEFT JOIN workflows w ON w.connection_id = c.connection_id AND w.container_id = c.external_id
             WHERE c.connection_id = ?1 ORDER BY c.key",
        )?;
        let rows = stmt.query_map(params![connection_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<String>>(3)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, key, name, workflow) = row?;
            let workflow = match workflow {
                Some(w) => serde_json::from_str(&w)?,
                None => Workflow { statuses: vec![], transitions: Transitions::Graph(vec![]) },
            };
            out.push(Container { container_ref: ContainerRef { connection_id: connection_id.into(), external_id: id }, key, name, workflow });
        }
        Ok(out)
    }

    pub fn workflow(&self, container: &ContainerRef) -> Result<Option<Workflow>> {
        let data: Option<String> = self
            .conn
            .query_row(
                "SELECT data FROM workflows WHERE connection_id = ?1 AND container_id = ?2",
                params![container.connection_id, container.external_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(data.map(|d| serde_json::from_str(&d)).transpose()?)
    }

    /// Stores events that aren't stored yet and returns how many were new.
    pub fn insert_cache_events(&self, events: &[Event]) -> Result<usize> {
        let tx = self.conn.unchecked_transaction()?;
        let mut inserted = 0;
        for e in events {
            let item_id = match &e.subject {
                Subject::Item { item } => Some(item.external_id.as_str()),
                Subject::CodeChange { .. } => None,
            };
            inserted += tx.execute(
                "INSERT OR IGNORE INTO cache_events (connection_id, id, at, kind, item_id, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![e.connection_id, e.id, stamp(e.at), name_of(&e.kind), item_id, serde_json::to_string(e)?],
            )?;
        }
        tx.commit()?;
        Ok(inserted)
    }

    /// The item's events, newest first.
    pub fn events_for_item(&self, item: &ItemRef, limit: usize) -> Result<Vec<Event>> {
        let mut stmt = self.conn.prepare(
            "SELECT data FROM cache_events WHERE connection_id = ?1 AND item_id = ?2 ORDER BY at DESC, id LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![item.connection_id, item.external_id, limit as i64], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(serde_json::from_str(&row?)?);
        }
        Ok(out)
    }

    /// Events across the connection's items, newest first, with the read state the inbox keeps under the same id.
    pub fn feed(&self, connection_id: &str, q: &FeedQuery, visible: &Visible) -> Result<FeedPage> {
        let limit = if q.limit == 0 { FEED_PAGE } else { q.limit.min(FEED_MAX) };
        let mut sql = String::from(FEED_SELECT);
        sql.push_str(" WHERE c.connection_id = ? AND c.item_id IS NOT NULL");
        let mut args = vec![Sql::Text(connection_id.into())];
        if !q.kinds.is_empty() {
            let marks = vec!["?"; q.kinds.len()].join(",");
            sql.push_str(&format!(" AND c.kind IN ({marks})"));
            args.extend(q.kinds.iter().map(|k| Sql::Text(name_of(k))));
        }
        if q.mentions_only {
            sql.push_str(&format!(" AND {MENTION}"));
        }
        if q.unread_only {
            sql.push_str(" AND COALESCE(e.unread, 0) = 1");
        }
        if let Some(container) = &q.container {
            sql.push_str(" AND i.container_id = ?");
            args.push(Sql::Text(container.external_id.clone()));
        }
        if let Visible::Only(ids) = visible {
            sql.push_str(&format!(" AND {}", in_list("i.container_id", ids.len())));
            args.extend(ids.iter().map(|i| Sql::Text(i.clone())));
        }
        if let Some(cursor) = &q.before {
            sql.push_str(" AND (c.at < ? OR (c.at = ? AND c.id < ?))");
            args.extend([Sql::Text(cursor.at.clone()), Sql::Text(cursor.at.clone()), Sql::Text(cursor.id.clone())]);
        }
        sql.push_str(" ORDER BY c.at DESC, c.id DESC LIMIT ?");
        args.push(Sql::Integer(limit as i64 + 1));

        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(args), read_feed_row)?;
        let mut entries = Vec::new();
        for row in rows {
            entries.extend(feed_entry(row?)?);
        }
        let next = (entries.len() > limit).then(|| {
            entries.truncate(limit);
            let last = entries.last().expect("a full page has a last entry");
            crate::domain::FeedCursor { at: last.at.clone(), id: last.id.clone() }
        });
        Ok(FeedPage { entries, next })
    }

    /// How many events in the connection are unread.
    pub fn feed_unread(&self, connection_id: &str, visible: &Visible) -> Result<usize> {
        let (join, ids) = match visible {
            Visible::All => (String::new(), &[][..]),
            Visible::Only(ids) => (
                format!("JOIN items i ON i.connection_id = c.connection_id AND i.external_id = c.item_id AND {}", in_list("i.container_id", ids.len())),
                ids.as_slice(),
            ),
        };
        let sql = format!(
            "SELECT count(*) FROM cache_events c LEFT JOIN events e ON e.id = c.id {join}
             WHERE c.connection_id = ? AND c.item_id IS NOT NULL AND COALESCE(e.unread, 0) = 1"
        );
        // The join's placeholders come first in the statement, so their values do too.
        let args = ids.iter().map(String::as_str).chain(std::iter::once(connection_id));
        let n: i64 = self.conn.query_row(&sql, rusqlite::params_from_iter(args), |r| r.get(0))?;
        Ok(n as usize)
    }

    pub fn sync_state(&self, connection_id: &str) -> Result<SyncState> {
        let state = self
            .conn
            .query_row(
                "SELECT cursor, full_at, containers_at FROM sync_state WHERE connection_id = ?1",
                params![connection_id],
                |r| Ok(SyncState { cursor: r.get(0)?, full_at: r.get(1)?, containers_at: r.get(2)? }),
            )
            .optional()?;
        Ok(state.unwrap_or_default())
    }

    pub fn save_sync_state(&self, connection_id: &str, s: &SyncState) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO sync_state (connection_id, cursor, full_at, containers_at) VALUES (?1, ?2, ?3, ?4)",
            params![connection_id, s.cursor, s.full_at, s.containers_at],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;
    use crate::domain::fixtures::{item_ref, now, person, work_item};
    use crate::domain::{Category, EventKind, Identity, Link, LinkKind, StatusDef, Transition};

    fn ctx() -> FilterContext {
        FilterContext { me: Identity { display_name: "Me".into(), accounts: vec![person("me")] }, now: now(), needs_me: HashSet::new() }
    }

    fn ids(items: &[WorkItem]) -> Vec<&str> {
        items.iter().map(|i| i.item.external_id.as_str()).collect()
    }

    fn seed(db: &Db) {
        let mut a = work_item("1", "doing");
        a.assignee = Some(person("me"));
        a.labels = vec!["backend".into()];
        a.updated = now() - Duration::days(1);
        let mut b = work_item("2", "todo");
        b.container.external_id = "q".into();
        b.parent = Some(item_ref("1"));
        b.updated = now() - Duration::days(20);
        let mut c = work_item("3", "done");
        c.updated = now() - Duration::days(30);
        let mut other_site = work_item("1", "todo");
        other_site.item.connection_id = "d".into();
        db.upsert_items(&[a, b, c, other_site], "2026-09-29T11:00:00Z").unwrap();
    }

    #[test]
    fn storing_an_item_again_replaces_it_and_only_reports_real_changes() {
        let db = Db::in_memory().unwrap();
        let mut a = work_item("1", "todo");
        assert_eq!(db.upsert_items(&[a.clone()], "t1").unwrap(), Upserted { inserted: 1, changed: 0 });
        assert_eq!(db.upsert_items(&[a.clone()], "t2").unwrap(), Upserted { inserted: 0, changed: 0 });
        a.updated += Duration::minutes(5);
        a.title = "Renamed".into();
        assert_eq!(db.upsert_items(&[a.clone()], "t3").unwrap(), Upserted { inserted: 0, changed: 1 });
        assert_eq!(db.item(&a.item).unwrap().unwrap().title, "Renamed");
        assert_eq!(db.items_synced_since("c", "", &Visible::All).unwrap().len(), 1);
        assert!(db.items_synced_since("c", "t4", &Visible::All).unwrap().is_empty());
    }

    #[test]
    fn the_same_id_on_two_connections_is_two_items() {
        let db = Db::in_memory().unwrap();
        seed(&db);
        let other = ItemRef { connection_id: "d".into(), external_id: "1".into(), key: "ENG-1".into() };
        assert_eq!(db.item(&other).unwrap().unwrap().status.id, "todo");
        assert_eq!(db.item(&item_ref("1")).unwrap().unwrap().status.id, "doing");
        assert!(db.item(&item_ref("9")).unwrap().is_none());
    }

    #[test]
    fn filters_read_from_the_cache_and_stay_within_one_connection() {
        let db = Db::in_memory().unwrap();
        seed(&db);
        let run = |f: Filter| ids(&db.search("c", &f, &ctx(), &Visible::All).unwrap()).into_iter().map(String::from).collect::<Vec<_>>();
        assert_eq!(run(Filter::And { filters: vec![] }), ["1", "2", "3"]);
        assert_eq!(run(Filter::Mine), ["1"]);
        assert_eq!(run(Filter::Assignee { person: person("me") }), ["1"]);
        assert_eq!(run(Filter::Open), ["1", "2"]);
        assert_eq!(run(Filter::Unassigned), ["2", "3"]);
        assert_eq!(run(Filter::Status { name: "DOING".into() }), ["1"]);
        assert_eq!(run(Filter::Category { category: Category::Done }), ["3"]);
        assert_eq!(run(Filter::Container { container: work_item("2", "todo").container.clone() }), ["1", "3"]);
        assert_eq!(run(Filter::Container { container: ContainerRef { connection_id: "c".into(), external_id: "q".into() } }), ["2"]);
        assert_eq!(run(Filter::Parent { item: item_ref("1") }), ["2"]);
        assert_eq!(run(Filter::Stale { days: 14 }), ["2"]);
        assert_eq!(run(Filter::Label { label: "Backend".into() }), ["1"]);
        assert_eq!(run(Filter::Items { items: vec![item_ref("3"), item_ref("1")] }), ["1", "3"]);
        assert_eq!(run(Filter::And { filters: vec![Filter::Open, Filter::Unassigned] }), ["2"]);
    }

    #[test]
    fn a_search_sees_only_the_visible_containers_even_for_filters_that_read_across_items() {
        let db = Db::in_memory().unwrap();
        seed(&db);
        let only = |ids: &[&str]| Visible::Only(ids.iter().map(|s| s.to_string()).collect());
        let run = |f: Filter, v: &Visible| ids(&db.search("c", &f, &ctx(), v).unwrap()).into_iter().map(String::from).collect::<Vec<_>>();
        assert_eq!(run(Filter::And { filters: vec![] }, &only(&["q"])), ["2"]);
        assert_eq!(run(Filter::Open, &only(&["p"])), ["1"]);
        assert!(run(Filter::And { filters: vec![] }, &only(&[])).is_empty());
        assert_eq!(db.items_synced_since("c", "", &only(&["q"])).unwrap().len(), 1);
        let mut blocker = work_item("8", "doing");
        blocker.container.external_id = "hidden".into();
        blocker.links.push(Link { from: item_ref("8"), to: item_ref("2"), kind: LinkKind::Blocks });
        db.upsert_items(&[blocker], "t").unwrap();
        assert_eq!(run(Filter::Blocked, &Visible::All), ["2"]);
        assert!(run(Filter::Blocked, &only(&["q"])).is_empty(), "a blocker nobody can see doesn't block");
    }

    #[test]
    fn the_feed_and_its_unread_count_leave_out_items_of_containers_that_are_not_visible() {
        let db = feed_db();
        let actor = serde_json::to_string(&crate::model::Person { account_id: "sam".into(), name: "Sam".into(), avatar_url: None }).unwrap();
        for id in ["e2", "e3", "e5"] {
            db.conn
                .execute("INSERT INTO events (id, ticket_key, kind, actor, at, text, unread) VALUES (?1, 'K', 'status', ?2, 't', 'x', 1)", params![id, actor])
                .unwrap();
        }
        let p = Visible::Only(vec!["p".into()]);
        let ids = |v: &Visible, q: &FeedQuery| db.feed("c", q, v).unwrap().entries.into_iter().map(|e| e.id).collect::<Vec<_>>();
        assert_eq!(ids(&p, &FeedQuery::default()), ["e2", "e1"], "no events of q, and none of an item that left the cache");
        assert_eq!(ids(&p, &FeedQuery { unread_only: true, ..Default::default() }), ["e2"]);
        assert_eq!((db.feed_unread("c", &Visible::All).unwrap(), db.feed_unread("c", &p).unwrap()), (3, 1));
        assert_eq!(db.feed_unread("c", &Visible::Only(vec![])).unwrap(), 0);
    }

    #[test]
    fn filter_matches_is_the_final_authority_for_what_columns_cannot_say() {
        let db = Db::in_memory().unwrap();
        let mut ctx = ctx();
        ctx.needs_me = HashSet::from([item_ref("2")]);
        seed(&db);
        assert_eq!(ids(&db.search("c", &Filter::NeedsMe, &ctx, &Visible::All).unwrap()), ["2"]);
        assert_eq!(ids(&db.search("c", &Filter::Text { text: "task 3".into() }, &ctx, &Visible::All).unwrap()), ["3"]);
    }

    #[test]
    fn blocked_sees_blockers_outside_the_narrowed_set() {
        let db = Db::in_memory().unwrap();
        let mut blocker = work_item("1", "doing");
        blocker.container.external_id = "elsewhere".into();
        blocker.links.push(Link { from: item_ref("1"), to: item_ref("2"), kind: LinkKind::Blocks });
        let blocked = work_item("2", "todo");
        db.upsert_items(&[blocker, blocked], "t").unwrap();
        let f = Filter::And { filters: vec![Filter::Container { container: work_item("2", "todo").container }, Filter::Blocked] };
        assert_eq!(ids(&db.search("c", &f, &ctx(), &Visible::All).unwrap()), ["2"]);
    }

    #[test]
    fn pruning_drops_only_items_not_refreshed_since() {
        let db = Db::in_memory().unwrap();
        db.upsert_items(&[work_item("1", "todo")], "2026-01-01T00:00:00Z").unwrap();
        db.upsert_items(&[work_item("2", "todo")], "2026-09-01T00:00:00Z").unwrap();
        assert_eq!(db.prune_items("c", "2026-06-01T00:00:00Z").unwrap(), 1);
        assert_eq!(ids(&db.search("c", &Filter::And { filters: vec![] }, &ctx(), &Visible::All).unwrap()), ["2"]);
    }

    fn container(id: &str, statuses: &[&str]) -> Container {
        Container {
            container_ref: ContainerRef { connection_id: "c".into(), external_id: id.into() },
            key: id.to_uppercase(),
            name: format!("Project {id}"),
            workflow: Workflow {
                statuses: statuses.iter().map(|s| StatusDef { id: (*s).into(), name: s.to_uppercase(), category: Category::Active }).collect(),
                transitions: Transitions::Graph(vec![Transition { from: "a".into(), to: "b".into() }]),
            },
        }
    }

    #[test]
    fn containers_come_back_with_their_workflows_and_are_replaced_as_a_set() {
        let db = Db::in_memory().unwrap();
        db.replace_containers("c", &[container("b", &["a", "b"]), container("a", &["x"])], "t1").unwrap();
        let got = db.containers("c").unwrap();
        assert_eq!(got.iter().map(|c| c.key.as_str()).collect::<Vec<_>>(), ["A", "B"]);
        assert_eq!(got[1], container("b", &["a", "b"]));
        assert_eq!(db.workflow(&got[0].container_ref).unwrap().unwrap().statuses.len(), 1);

        db.replace_containers("c", &[container("b", &["a"])], "t2").unwrap();
        assert_eq!(db.containers("c").unwrap().len(), 1);
        assert!(db.workflow(&container("a", &[]).container_ref).unwrap().is_none());
        assert!(db.containers("other").unwrap().is_empty());
    }

    #[test]
    fn events_are_stored_once_and_read_per_item() {
        let db = Db::in_memory().unwrap();
        let ev = |id: &str, item: &str, minutes: i64| Event {
            id: id.into(),
            connection_id: "c".into(),
            at: now() + Duration::minutes(minutes),
            kind: EventKind::CommentAdded,
            subject: Subject::Item { item: item_ref(item) },
            actor: Some(person("sam")),
            payload: serde_json::json!({"text": "hi"}),
        };
        let events = [ev("e1", "1", 0), ev("e2", "1", 5), ev("e3", "2", 1)];
        assert_eq!(db.insert_cache_events(&events).unwrap(), 3);
        assert_eq!(db.insert_cache_events(&events).unwrap(), 0);
        let got = db.events_for_item(&item_ref("1"), 10).unwrap();
        assert_eq!(got.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["e2", "e1"]);
        assert_eq!(db.events_for_item(&item_ref("1"), 1).unwrap().len(), 1);
    }

    fn feed_event(id: &str, item: &str, kind: EventKind, minutes: i64, payload: serde_json::Value) -> Event {
        Event {
            id: id.into(),
            connection_id: "c".into(),
            at: now() + Duration::minutes(minutes),
            kind,
            subject: Subject::Item { item: item_ref(item) },
            actor: Some(person("sam")),
            payload,
        }
    }

    fn feed_db() -> Db {
        let db = Db::in_memory().unwrap();
        let mut a = work_item("1", "doing");
        a.title = "Retry queue".into();
        let mut b = work_item("2", "todo");
        b.container.external_id = "q".into();
        db.upsert_items(&[a, b], "t").unwrap();
        let text = |t: &str| serde_json::json!({ "text": t });
        db.insert_cache_events(&[
            feed_event("e1", "1", EventKind::CommentAdded, 0, text("first")),
            feed_event("e2", "1", EventKind::StatusChanged, 5, text("To Do → Doing")),
            feed_event("e3", "2", EventKind::CommentAdded, 10, serde_json::json!({ "text": "hey @me", "mention": true })),
            feed_event("e4", "2", EventKind::Assigned, 10, text("Assigned to you")),
            feed_event("e5", "gone", EventKind::CommentAdded, 20, text("orphan")),
        ])
        .unwrap();
        db
    }

    fn feed_ids(db: &Db, q: &FeedQuery) -> Vec<String> {
        db.feed("c", q, &Visible::All).unwrap().entries.into_iter().map(|e| e.id).collect()
    }

    #[test]
    fn the_feed_is_newest_first_across_items_and_names_the_item() {
        let db = feed_db();
        let page = db.feed("c", &FeedQuery::default(), &Visible::All).unwrap();
        assert_eq!(page.entries.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["e5", "e4", "e3", "e2", "e1"]);
        assert!(page.next.is_none());
        let e2 = page.entries.iter().find(|e| e.id == "e2").unwrap();
        assert_eq!((e2.item_title.as_deref(), e2.text.as_str()), (Some("Retry queue"), "To Do → Doing"));
        assert!(page.entries[0].item_title.is_none(), "an item that left the cache has no title");
        assert!(db.feed("other", &FeedQuery::default(), &Visible::All).unwrap().entries.is_empty());
    }

    #[test]
    fn pages_follow_the_cursor_without_skipping_entries_that_share_a_time() {
        let db = feed_db();
        let first = db.feed("c", &FeedQuery { limit: 2, ..Default::default() }, &Visible::All).unwrap();
        assert_eq!(first.entries.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["e5", "e4"]);
        let second = db.feed("c", &FeedQuery { limit: 2, before: first.next, ..Default::default() }, &Visible::All).unwrap();
        assert_eq!(second.entries.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["e3", "e2"]);
        let third = db.feed("c", &FeedQuery { limit: 2, before: second.next, ..Default::default() }, &Visible::All).unwrap();
        assert_eq!(third.entries.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["e1"]);
        assert!(third.next.is_none());
    }

    #[test]
    fn the_feed_narrows_by_kind_mention_and_project() {
        let db = feed_db();
        assert_eq!(feed_ids(&db, &FeedQuery { kinds: vec![EventKind::Assigned], ..Default::default() }), ["e4"]);
        assert_eq!(feed_ids(&db, &FeedQuery { kinds: vec![EventKind::CommentAdded, EventKind::StatusChanged], ..Default::default() }), ["e5", "e3", "e2", "e1"]);
        assert_eq!(feed_ids(&db, &FeedQuery { mentions_only: true, ..Default::default() }), ["e3"]);
        let q = ContainerRef { connection_id: "c".into(), external_id: "q".into() };
        assert_eq!(feed_ids(&db, &FeedQuery { container: Some(q), ..Default::default() }), ["e4", "e3"]);
    }

    #[test]
    fn read_state_comes_from_the_inbox_row_with_the_same_id() {
        let db = feed_db();
        let actor = serde_json::to_string(&crate::model::Person { account_id: "sam".into(), name: "Sam".into(), avatar_url: None }).unwrap();
        for (id, unread, kind) in [("e2", 1, "status"), ("e3", 0, "mention")] {
            db.conn
                .execute(
                    "INSERT INTO events (id, ticket_key, kind, actor, at, text, unread) VALUES (?1, 'K', ?2, ?3, 't', 'x', ?4)",
                    params![id, kind, actor, unread],
                )
                .unwrap();
        }
        assert_eq!(db.feed_unread("c", &Visible::All).unwrap(), 1);
        let about_code = Event { subject: Subject::CodeChange { repo: "r".into(), number: 1 }, ..feed_event("pr1", "1", EventKind::PrOpened, 30, serde_json::json!({})) };
        db.insert_cache_events(&[about_code]).unwrap();
        db.conn
            .execute("INSERT INTO events (id, ticket_key, kind, actor, at, text, unread) VALUES ('pr1', 'K', 'comment', '{}', 't', 'x', 1)", [])
            .unwrap();
        assert_eq!(db.feed_unread("c", &Visible::All).unwrap(), 1, "an event the feed can't show doesn't count");
        assert_eq!(feed_ids(&db, &FeedQuery { unread_only: true, ..Default::default() }), ["e2"]);
        let page = db.feed("c", &FeedQuery::default(), &Visible::All).unwrap();
        let e2 = page.entries.iter().find(|e| e.id == "e2").unwrap();
        assert!(e2.unread && e2.actor_name.as_deref() == Some("Sam"));
        assert!(!page.entries.iter().find(|e| e.id == "e1").unwrap().unread, "events without an inbox row arrive read");
        db.set_unread("e2", false).unwrap();
        assert_eq!(db.feed_unread("c", &Visible::All).unwrap(), 0);
        db.set_done("e3", Some("2026-09-29T12:00:00Z")).unwrap();
        assert!(db.feed("c", &FeedQuery::default(), &Visible::All).unwrap().entries.iter().find(|e| e.id == "e3").unwrap().done);
    }

    #[test]
    fn mentions_stored_before_the_flag_existed_still_count() {
        let db = feed_db();
        db.conn
            .execute(
                "INSERT INTO events (id, ticket_key, kind, actor, at, text, unread) VALUES ('e1', 'K', 'mention', '{\"accountId\":\"sam\",\"name\":\"Sam\"}', 't', 'x', 0)",
                [],
            )
            .unwrap();
        assert_eq!(feed_ids(&db, &FeedQuery { mentions_only: true, ..Default::default() }), ["e3", "e1"]);
    }

    #[test]
    fn sync_state_round_trips_per_connection() {
        let db = Db::in_memory().unwrap();
        assert_eq!(db.sync_state("c").unwrap(), SyncState::default());
        let s = SyncState { cursor: Some("a".into()), full_at: Some("b".into()), containers_at: None };
        db.save_sync_state("c", &s).unwrap();
        assert_eq!(db.sync_state("c").unwrap(), s);
        assert_eq!(db.sync_state("d").unwrap(), SyncState::default());
    }

    #[test]
    fn a_legacy_ticket_row_without_labels_or_links_still_reads() {
        let db = Db::in_memory().unwrap();
        let t = crate::tracker::testing::sample_ticket();
        let mut stored = serde_json::to_value(&t).unwrap();
        stored.as_object_mut().unwrap().retain(|k, _| k != "labels" && k != "links");
        db.conn
            .execute(
                "INSERT INTO tickets (key, data, synced_at) VALUES (?1, ?2, '2026-09-28T10:00:00Z')",
                params![t.key, stored.to_string()],
            )
            .unwrap();
        db.conn.execute("INSERT INTO tickets (key, data, synced_at) VALUES ('bad', 'not json', 'x')", []).unwrap();
        let legacy = db.legacy_tickets().unwrap();
        assert_eq!(legacy.len(), 1);
        assert_eq!((legacy[0].0.key.as_str(), legacy[0].1.as_str()), ("CA-1", "2026-09-28T10:00:00Z"));
        assert!(legacy[0].0.labels.is_empty(), "old rows predate labels and links");
    }
}
