//! What each connection follows, and the catalog of containers it could follow.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, OptionalExtension};

use super::Db;
use crate::domain::{ContainerRef, ContainerSummary, Depth, Visible, Watch, WatchChange, WatchMode, WatchSet, WatchSource};
use crate::error::Result;

/// `col IN (?, ?, …)` over `n` ids, or a clause that never matches when there are none.
pub(super) fn in_list(col: &str, n: usize) -> String {
    if n == 0 {
        return "0 = 1".into();
    }
    format!("{col} IN ({})", vec!["?"; n].join(","))
}

impl Db {
    pub fn watch_mode(&self, connection_id: &str) -> Result<WatchMode> {
        let mode: Option<String> =
            self.conn.query_row("SELECT mode FROM watch_settings WHERE connection_id = ?1", params![connection_id], |r| r.get(0)).optional()?;
        Ok(mode.map(|m| WatchMode::parse(&m)).unwrap_or_default())
    }

    pub fn set_watch_mode(&self, connection_id: &str, mode: WatchMode, at: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO watch_settings (connection_id, mode, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(connection_id) DO UPDATE SET mode = ?2, updated_at = ?3",
            params![connection_id, mode.as_str(), at],
        )?;
        Ok(())
    }

    pub fn watch_set(&self, connection_id: &str) -> Result<WatchSet> {
        let mut stmt = self.conn.prepare(
            "SELECT container_id, depth, pinned, source, added_at, unwatched_at, inaccessible FROM watched_containers
             WHERE connection_id = ?1 ORDER BY container_id",
        )?;
        let rows = stmt.query_map(params![connection_id], |r| {
            Ok(Watch {
                container: ContainerRef { connection_id: connection_id.into(), external_id: r.get(0)? },
                depth: Depth::parse(&r.get::<_, String>(1)?),
                pinned: r.get(2)?,
                source: WatchSource::parse(&r.get::<_, String>(3)?),
                added_at: r.get(4)?,
                unwatched_at: r.get(5)?,
                inaccessible: r.get(6)?,
            })
        })?;
        Ok(WatchSet { mode: self.watch_mode(connection_id)?, watches: rows.collect::<rusqlite::Result<_>>()? })
    }

    /// Applies the edits in one transaction. Stopping to watch keeps the row and its data until the grace period
    /// ends; watching again clears that. Outside `selected` mode every container is watched already, so a pin or a
    /// depth only records a row.
    pub fn apply_watch_changes(&self, connection_id: &str, changes: &[WatchChange], at: &str) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        let selected = self.watch_mode(connection_id)? == WatchMode::Selected;
        for c in changes {
            let exists: bool = tx
                .query_row(
                    "SELECT 1 FROM watched_containers WHERE connection_id = ?1 AND container_id = ?2",
                    params![connection_id, c.container_id],
                    |_| Ok(true),
                )
                .optional()?
                .unwrap_or(false);
            if c.watched == Some(false) {
                tx.execute(
                    "UPDATE watched_containers SET unwatched_at = COALESCE(unwatched_at, ?3) WHERE connection_id = ?1 AND container_id = ?2",
                    params![connection_id, c.container_id, at],
                )?;
                continue;
            }
            if !exists {
                if selected && c.watched != Some(true) {
                    continue;
                }
                let source = c.source.unwrap_or(if selected { WatchSource::Manual } else { WatchSource::Everything });
                tx.execute(
                    "INSERT INTO watched_containers (connection_id, container_id, depth, pinned, source, added_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![connection_id, c.container_id, c.depth.unwrap_or_default().as_str(), c.pinned.unwrap_or(false), source.as_str(), at],
                )?;
                continue;
            }
            if c.watched == Some(true) {
                tx.execute(
                    "UPDATE watched_containers SET unwatched_at = NULL WHERE connection_id = ?1 AND container_id = ?2",
                    params![connection_id, c.container_id],
                )?;
            }
            if let Some(d) = c.depth {
                tx.execute(
                    "UPDATE watched_containers SET depth = ?3 WHERE connection_id = ?1 AND container_id = ?2",
                    params![connection_id, c.container_id, d.as_str()],
                )?;
            }
            if let Some(p) = c.pinned {
                tx.execute(
                    "UPDATE watched_containers SET pinned = ?3 WHERE connection_id = ?1 AND container_id = ?2",
                    params![connection_id, c.container_id, p],
                )?;
            }
            if let Some(s) = c.source {
                tx.execute(
                    "UPDATE watched_containers SET source = ?3 WHERE connection_id = ?1 AND container_id = ?2",
                    params![connection_id, c.container_id, s.as_str()],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn set_inaccessible(&self, connection_id: &str, container_ids: &[String], inaccessible: bool) -> Result<()> {
        for id in container_ids {
            self.conn.execute(
                "UPDATE watched_containers SET inaccessible = ?3 WHERE connection_id = ?1 AND container_id = ?2",
                params![connection_id, id, inaccessible],
            )?;
        }
        Ok(())
    }

    /// Deletes items of containers that aren't watched and whose grace period is over: the container was unwatched
    /// before `cutoff`, or was never given a row (it only came in while everything was synced) and the item hasn't
    /// been refreshed since `cutoff`. Events, activity and drafts are kept, so watching again brings the history back.
    pub fn prune_unwatched(&self, connection_id: &str, cutoff: &str) -> Result<usize> {
        Ok(self.conn.execute(
            "DELETE FROM items WHERE connection_id = ?1 AND synced_at < ?2 AND container_id NOT IN (
               SELECT container_id FROM watched_containers
               WHERE connection_id = ?1 AND (unwatched_at IS NULL OR unwatched_at >= ?2))",
            params![connection_id, cutoff],
        )?)
    }

    pub fn item_counts(&self, connection_id: &str) -> Result<HashMap<String, usize>> {
        let mut stmt = self.conn.prepare("SELECT container_id, count(*) FROM items WHERE connection_id = ?1 GROUP BY container_id")?;
        let rows = stmt.query_map(params![connection_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Keys of the items in the visible containers, or `None` when every item is visible.
    pub fn visible_keys(&self, connection_id: &str, visible: &Visible) -> Result<Option<HashSet<String>>> {
        let Visible::Only(ids) = visible else { return Ok(None) };
        let sql = format!("SELECT key FROM items WHERE connection_id = ? AND {}", in_list("container_id", ids.len()));
        let mut stmt = self.conn.prepare(&sql)?;
        let args = std::iter::once(connection_id).chain(ids.iter().map(String::as_str));
        let rows = stmt.query_map(rusqlite::params_from_iter(args), |r| r.get::<_, String>(0))?;
        Ok(Some(rows.collect::<rusqlite::Result<_>>()?))
    }

    /// Adds or refreshes catalog entries as the tracker listed them.
    pub fn catalog_upsert(&self, connection_id: &str, entries: &[ContainerSummary], seen_at: &str) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        for e in entries {
            tx.execute(
                "INSERT OR REPLACE INTO container_catalog (connection_id, external_id, key, name, kind, archived, last_active, item_hint, seen_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![connection_id, e.container_ref.external_id, e.key, e.name, e.kind, e.archived, e.last_active, e.item_hint, seen_at],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Catalog entries whose key or name contains `query`, by key.
    pub fn catalog_search(&self, connection_id: &str, query: &str, limit: usize) -> Result<Vec<ContainerSummary>> {
        let like = format!("%{}%", query.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        let mut stmt = self.conn.prepare(
            "SELECT external_id, key, name, kind, archived, last_active, item_hint FROM container_catalog
             WHERE connection_id = ?1 AND (key LIKE ?2 ESCAPE '\\' OR name LIKE ?2 ESCAPE '\\') ORDER BY key LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![connection_id, like, limit as i64], |r| {
            Ok(ContainerSummary {
                container_ref: ContainerRef { connection_id: connection_id.into(), external_id: r.get(0)? },
                key: r.get(1)?,
                name: r.get(2)?,
                kind: r.get(3)?,
                archived: r.get(4)?,
                last_active: r.get(5)?,
                item_hint: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::fixtures::work_item;

    const C: &str = "c";

    fn change(id: &str) -> WatchChange {
        WatchChange { container_id: id.into(), ..Default::default() }
    }

    fn watch(id: &str) -> WatchChange {
        WatchChange { watched: Some(true), ..change(id) }
    }

    fn selected(db: &Db) {
        db.set_watch_mode(C, WatchMode::Selected, "t0").unwrap();
    }

    #[test]
    fn a_connection_that_has_not_chosen_is_unset_and_sees_everything() {
        let db = Db::in_memory().unwrap();
        let s = db.watch_set(C).unwrap();
        assert_eq!((s.mode, s.watches.len(), s.visible()), (WatchMode::Unset, 0, Visible::All));
    }

    #[test]
    fn watching_pinning_and_changing_depth_persist_and_unwatching_is_soft() {
        let db = Db::in_memory().unwrap();
        selected(&db);
        db.apply_watch_changes(C, &[WatchChange { pinned: Some(true), depth: Some(Depth::Whole), ..watch("A") }, watch("B")], "t1").unwrap();
        let s = db.watch_set(C).unwrap();
        let a = s.watch("A").unwrap();
        assert!(a.pinned && a.depth == Depth::Whole && a.source == WatchSource::Manual && a.unwatched_at.is_none());
        assert_eq!(s.visible(), Visible::Only(vec!["A".into(), "B".into()]));

        db.apply_watch_changes(C, &[WatchChange { watched: Some(false), ..change("A") }], "t2").unwrap();
        let s = db.watch_set(C).unwrap();
        assert_eq!(s.watch("A").unwrap().unwatched_at.as_deref(), Some("t2"));
        assert!(s.watch("A").unwrap().pinned, "the choices survive so watching again is an undo");
        assert_eq!(s.visible(), Visible::Only(vec!["B".into()]));

        db.apply_watch_changes(C, &[watch("A")], "t3").unwrap();
        let s = db.watch_set(C).unwrap();
        assert!(s.is_watched("A") && s.watch("A").unwrap().depth == Depth::Whole);
    }

    #[test]
    fn in_selected_mode_a_pin_alone_does_not_start_watching() {
        let db = Db::in_memory().unwrap();
        selected(&db);
        db.apply_watch_changes(C, &[WatchChange { pinned: Some(true), ..change("Z") }], "t1").unwrap();
        assert!(db.watch_set(C).unwrap().watches.is_empty());
    }

    #[test]
    fn outside_selected_mode_a_pin_records_a_row_from_everything() {
        let db = Db::in_memory().unwrap();
        db.set_watch_mode(C, WatchMode::Everything, "t0").unwrap();
        db.apply_watch_changes(C, &[WatchChange { pinned: Some(true), ..change("Z") }], "t1").unwrap();
        let s = db.watch_set(C).unwrap();
        assert_eq!(s.watch("Z").unwrap().source, WatchSource::Everything);
        assert!(s.is_watched("Q"), "everything is still everything");
    }

    #[test]
    fn watch_sets_are_per_connection() {
        let db = Db::in_memory().unwrap();
        db.set_watch_mode("one", WatchMode::Selected, "t").unwrap();
        db.apply_watch_changes("one", &[watch("A")], "t").unwrap();
        assert!(db.watch_set("two").unwrap().watches.is_empty());
        assert_eq!(db.watch_mode("two").unwrap(), WatchMode::Unset);
    }

    fn item_in(db: &Db, id: &str, container: &str, synced: &str) {
        let mut i = work_item(id, "todo");
        i.container.external_id = container.into();
        db.upsert_items(&[i], synced).unwrap();
    }

    #[test]
    fn pruning_waits_out_the_grace_period_and_leaves_watched_items_and_history_alone() {
        let db = Db::in_memory().unwrap();
        selected(&db);
        db.apply_watch_changes(C, &[watch("KEEP"), watch("GONE"), watch("FRESH")], "t1").unwrap();
        db.apply_watch_changes(C, &[WatchChange { watched: Some(false), ..change("GONE") }], "2026-09-01T00:00:00Z").unwrap();
        db.apply_watch_changes(C, &[WatchChange { watched: Some(false), ..change("FRESH") }], "2026-09-20T00:00:00Z").unwrap();
        for (id, container) in [("1", "KEEP"), ("2", "GONE"), ("3", "FRESH"), ("4", "NEVER")] {
            item_in(&db, id, container, "2026-08-01T00:00:00Z");
        }
        item_in(&db, "5", "NEVER", "2026-09-25T00:00:00Z");
        db.insert_activity(&[("a1".into(), crate::model::MyAction { ticket_key: "ENG-2".into(), at: "2026-08-02T00:00:00Z".into(), kind: "transition".into(), text: "x".into() })]).unwrap();

        let removed = db.prune_unwatched(C, "2026-09-15T00:00:00Z").unwrap();

        assert_eq!(removed, 2);
        let left: Vec<String> = db.items_synced_since(C, "", &Visible::All).unwrap().into_iter().map(|i| i.item.external_id).collect();
        assert_eq!(left.iter().filter(|k| ["1", "3", "5"].contains(&k.as_str())).count(), 3, "{left:?}");
        assert_eq!(db.activity("").unwrap().len(), 1, "the person's own history stays");
    }

    #[test]
    fn counts_and_visible_keys_follow_the_visible_containers() {
        let db = Db::in_memory().unwrap();
        item_in(&db, "1", "A", "t");
        item_in(&db, "2", "A", "t");
        item_in(&db, "3", "B", "t");
        assert_eq!(db.item_counts(C).unwrap().get("A"), Some(&2));
        assert_eq!(db.visible_keys(C, &Visible::All).unwrap(), None);
        let only_b = db.visible_keys(C, &Visible::Only(vec!["B".into()])).unwrap().unwrap();
        assert_eq!(only_b.len(), 1);
        assert!(db.visible_keys(C, &Visible::Only(vec![])).unwrap().unwrap().is_empty());
    }

    #[test]
    fn the_catalog_upserts_and_searches_by_key_or_name() {
        let db = Db::in_memory().unwrap();
        let entry = |key: &str, name: &str| ContainerSummary {
            container_ref: ContainerRef { connection_id: C.into(), external_id: key.into() },
            key: key.into(),
            name: name.into(),
            kind: None,
            archived: false,
            last_active: None,
            item_hint: None,
        };
        db.catalog_upsert(C, &[entry("WHS", "Warehouse"), entry("FIN", "Finance ops")], "t1").unwrap();
        db.catalog_upsert(C, &[entry("WHS", "Warehouse 2")], "t2").unwrap();
        assert_eq!(db.catalog_search(C, "ware", 10).unwrap()[0].name, "Warehouse 2");
        assert_eq!(db.catalog_search(C, "fin", 10).unwrap().len(), 1);
        assert!(db.catalog_search(C, "%", 10).unwrap().is_empty(), "wildcards are literal");
    }
}
