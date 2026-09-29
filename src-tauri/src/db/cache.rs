//! The connector-neutral cache: domain values stored per connection and read back by filter.

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rusqlite::types::Value as Sql;
use rusqlite::{params, params_from_iter, OptionalExtension};
use serde::Serialize;

use super::Db;
use crate::domain::{Container, ContainerRef, Event, Filter, FilterContext, ItemRef, Subject, WorkItem, Workflow};
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
    pub fn items_synced_since(&self, connection_id: &str, since: &str) -> Result<Vec<WorkItem>> {
        self.read_items(
            "SELECT data FROM items WHERE connection_id = ?1 AND synced_at >= ?2",
            vec![Sql::Text(connection_id.into()), Sql::Text(since.into())],
        )
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
    pub fn search(&self, connection_id: &str, filter: &Filter, ctx: &FilterContext) -> Result<Vec<WorkItem>> {
        let mut narrowing = Narrowing::default();
        Narrowing::from(filter, ctx.now, &mut narrowing);
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
            everything = self.read_items(
                "SELECT data FROM items WHERE connection_id = ?1 ORDER BY updated DESC, external_id",
                vec![Sql::Text(connection_id.into())],
            )?;
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
        assert_eq!(db.items_synced_since("c", "").unwrap().len(), 1);
        assert!(db.items_synced_since("c", "t4").unwrap().is_empty());
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
        let run = |f: Filter| ids(&db.search("c", &f, &ctx()).unwrap()).into_iter().map(String::from).collect::<Vec<_>>();
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
    fn filter_matches_is_the_final_authority_for_what_columns_cannot_say() {
        let db = Db::in_memory().unwrap();
        let mut ctx = ctx();
        ctx.needs_me = HashSet::from([item_ref("2")]);
        seed(&db);
        assert_eq!(ids(&db.search("c", &Filter::NeedsMe, &ctx).unwrap()), ["2"]);
        assert_eq!(ids(&db.search("c", &Filter::Text { text: "task 3".into() }, &ctx).unwrap()), ["3"]);
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
        assert_eq!(ids(&db.search("c", &f, &ctx()).unwrap()), ["2"]);
    }

    #[test]
    fn pruning_drops_only_items_not_refreshed_since() {
        let db = Db::in_memory().unwrap();
        db.upsert_items(&[work_item("1", "todo")], "2026-01-01T00:00:00Z").unwrap();
        db.upsert_items(&[work_item("2", "todo")], "2026-09-01T00:00:00Z").unwrap();
        assert_eq!(db.prune_items("c", "2026-06-01T00:00:00Z").unwrap(), 1);
        assert_eq!(ids(&db.search("c", &Filter::And { filters: vec![] }, &ctx()).unwrap()), ["2"]);
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
