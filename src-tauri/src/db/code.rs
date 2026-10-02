//! What a code host connection keeps: the last answer to each request, so polling can be conditional.

use rusqlite::{params, OptionalExtension};

use super::Db;
use crate::domain::{CodeChange, DevLink, ItemRef, LinkSource};
use crate::error::Result;

/// An answer to a GET and the validators it came with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CachedHttp {
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    /// The `rel="next"` link, which a 304 doesn't repeat.
    pub next: Option<String>,
    pub body: String,
}

impl Db {
    pub fn http_cache_get(&self, connection_id: &str, url: &str) -> Result<Option<CachedHttp>> {
        Ok(self
            .conn
            .query_row("SELECT etag, last_modified, link_next, body FROM http_cache WHERE connection_id = ?1 AND url = ?2", params![connection_id, url], |r| {
                Ok(CachedHttp { etag: r.get(0)?, last_modified: r.get(1)?, next: r.get(2)?, body: r.get(3)? })
            })
            .optional()?)
    }

    pub fn http_cache_put(&self, connection_id: &str, url: &str, entry: &CachedHttp, at: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO http_cache (connection_id, url, etag, last_modified, link_next, body, fetched_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![connection_id, url, entry.etag, entry.last_modified, entry.next, entry.body, at],
        )?;
        Ok(())
    }

    /// Stores changes as fetched at `synced_at`, replacing any with the same id.
    pub fn upsert_code_changes(&self, changes: &[CodeChange], synced_at: &str) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        for c in changes {
            tx.execute(
                "INSERT OR REPLACE INTO code_changes (connection_id, external_id, repo, kind, number, state, updated_at, data, synced_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    c.connection_id,
                    c.external_id,
                    c.repo,
                    super::cache::name_of(&c.kind),
                    c.number.map(|n| n as i64),
                    super::cache::name_of(&c.state),
                    super::cache::stamp(c.updated_at),
                    serde_json::to_string(c)?,
                    synced_at
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn code_change(&self, connection_id: &str, external_id: &str) -> Result<Option<CodeChange>> {
        let data: Option<String> = self
            .conn
            .query_row("SELECT data FROM code_changes WHERE connection_id = ?1 AND external_id = ?2", params![connection_id, external_id], |r| r.get(0))
            .optional()?;
        Ok(data.map(|d| serde_json::from_str(&d)).transpose()?)
    }

    /// Every cached change of the connection, newest first.
    pub fn code_changes(&self, connection_id: &str) -> Result<Vec<CodeChange>> {
        let mut stmt = self.conn.prepare("SELECT data FROM code_changes WHERE connection_id = ?1 ORDER BY updated_at DESC, external_id")?;
        let rows = stmt.query_map(params![connection_id], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            // A row that no longer parses is skipped: the next sync stores it again.
            if let Ok(c) = serde_json::from_str(&row?) {
                out.push(c);
            }
        }
        Ok(out)
    }

    /// Pull requests and branches of `repo` (compared without regard to case) whose head is one of `head_refs`.
    pub fn code_changes_for_branch(&self, connection_id: &str, repo: &str, head_refs: &[String]) -> Result<Vec<CodeChange>> {
        let mut stmt = self.conn.prepare("SELECT data FROM code_changes WHERE connection_id = ?1 AND repo = ?2 COLLATE NOCASE AND kind IN ('pullRequest', 'branch')")?;
        let rows = stmt.query_map(params![connection_id, repo], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            if let Ok(c) = serde_json::from_str::<CodeChange>(&row?) {
                if head_refs.contains(&c.head_ref) {
                    out.push(c);
                }
            }
        }
        Ok(out)
    }

    /// Deletes changes of repositories outside `keep` that weren't refreshed since `cutoff`, with their links.
    pub fn prune_code_changes(&self, connection_id: &str, keep: &[String], cutoff: &str) -> Result<usize> {
        let clause = super::watch::in_list("repo", keep.len());
        let args = |first: &str| {
            let mut a = vec![first.to_string(), cutoff.to_string()];
            a.extend(keep.iter().cloned());
            a
        };
        self.conn.execute(
            &format!("DELETE FROM item_links WHERE connection_id = ?1 AND code_id IN (SELECT external_id FROM code_changes WHERE connection_id = ?1 AND synced_at < ?2 AND NOT ({clause}))"),
            rusqlite::params_from_iter(args(connection_id)),
        )?;
        Ok(self.conn.execute(
            &format!("DELETE FROM code_changes WHERE connection_id = ?1 AND synced_at < ?2 AND NOT ({clause})"),
            rusqlite::params_from_iter(args(connection_id)),
        )?)
    }

    /// Replaces every link of the connection's changes with `links`.
    pub fn replace_item_links(&self, connection_id: &str, links: &[DevLink], found_at: &str) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM item_links WHERE connection_id = ?1", params![connection_id])?;
        for l in links {
            tx.execute(
                "INSERT OR REPLACE INTO item_links (item_connection_id, item_id, item_key, connection_id, code_id, provenance, confidence, found_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![l.item.connection_id, l.item.external_id, l.item.key, connection_id, l.change.external_id, l.provenance.as_str(), l.confidence, found_at],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// The links stored for one work item, strongest first, then newest.
    pub fn dev_links(&self, item: &ItemRef) -> Result<Vec<DevLink>> {
        let mut stmt = self.conn.prepare(
            "SELECT l.item_key, l.provenance, l.confidence, c.data FROM item_links l
             JOIN code_changes c ON c.connection_id = l.connection_id AND c.external_id = l.code_id
             WHERE l.item_connection_id = ?1 AND l.item_id = ?2 ORDER BY l.confidence DESC, c.updated_at DESC, c.external_id",
        )?;
        let rows = stmt.query_map(params![item.connection_id, item.external_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, f64>(2)?, r.get::<_, String>(3)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (key, provenance, confidence, data) = row?;
            if let Ok(change) = serde_json::from_str(&data) {
                out.push(DevLink {
                    item: ItemRef { connection_id: item.connection_id.clone(), external_id: item.external_id.clone(), key },
                    change,
                    provenance: LinkSource::parse(&provenance),
                    confidence: confidence as f32,
                });
            }
        }
        Ok(out)
    }

    /// What links are stored, to tell whether a rebuild changed any: `(item id, code id, provenance)`, sorted.
    pub fn link_signature(&self, connection_id: &str) -> Result<Vec<(String, String, String)>> {
        let mut stmt = self.conn.prepare("SELECT item_id, code_id, provenance FROM item_links WHERE connection_id = ?1 ORDER BY item_id, code_id")?;
        let rows = stmt.query_map(params![connection_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The work items linked to pull requests of `repo` (compared without regard to case): `(item key, the pull request's
    /// update time)`, newest first.
    pub fn item_keys_for_repo(&self, item_connection_id: &str, repo: &str) -> Result<Vec<(String, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT l.item_key, c.updated_at FROM item_links l
             JOIN code_changes c ON c.connection_id = l.connection_id AND c.external_id = l.code_id
             WHERE l.item_connection_id = ?1 AND c.repo = ?2 COLLATE NOCASE AND c.kind = 'pullRequest'
             ORDER BY c.updated_at DESC, l.item_key",
        )?;
        let rows = stmt.query_map(params![item_connection_id, repo], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Project keys the connection knows, from its containers and its catalog.
    pub fn project_keys(&self, connection_id: &str) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT key FROM containers WHERE connection_id = ?1 UNION SELECT key FROM container_catalog WHERE connection_id = ?1")?;
        let rows = stmt.query_map(params![connection_id], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Marks an answer as refreshed without changing it, as when the host says it is still current.
    pub fn http_cache_touch(&self, connection_id: &str, url: &str, at: &str) -> Result<()> {
        self.conn.execute("UPDATE http_cache SET fetched_at = ?3 WHERE connection_id = ?1 AND url = ?2", params![connection_id, url, at])?;
        Ok(())
    }

    /// The code events of the connection, newest first.
    pub fn code_events(&self, connection_id: &str, limit: usize) -> Result<Vec<crate::domain::Event>> {
        let mut stmt = self.conn.prepare("SELECT data FROM cache_events WHERE connection_id = ?1 AND item_id IS NULL ORDER BY at DESC, id LIMIT ?2")?;
        let rows = stmt.query_map(params![connection_id, limit as i64], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(serde_json::from_str(&row?)?);
        }
        Ok(out)
    }

    /// Cached pull requests and other changes per repository.
    pub fn code_change_counts(&self, connection_id: &str) -> Result<std::collections::HashMap<String, usize>> {
        let mut stmt = self.conn.prepare("SELECT repo, count(*) FROM code_changes WHERE connection_id = ?1 GROUP BY repo")?;
        let rows = stmt.query_map(params![connection_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Drops answers not refreshed since `before`, so pages nobody asks for any more don't pile up.
    pub fn http_cache_prune(&self, connection_id: &str, before: &str) -> Result<usize> {
        Ok(self.conn.execute("DELETE FROM http_cache WHERE connection_id = ?1 AND fetched_at < ?2", params![connection_id, before])?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(n: u64, repo: &str, at: &str) -> CodeChange {
        let mut c = crate::codehost::links::tests::pr(n, "b", "T", "");
        c.repo = repo.into();
        c.external_id = CodeChange::pr_id(repo, n);
        c.updated_at = chrono::DateTime::parse_from_rfc3339(at).unwrap().with_timezone(&chrono::Utc);
        c
    }

    fn link(item: &str, c: &CodeChange, provenance: LinkSource) -> DevLink {
        DevLink {
            item: ItemRef { connection_id: "jira:s:me".into(), external_id: item.into(), key: item.into() },
            change: c.clone(),
            provenance,
            confidence: provenance.confidence(),
        }
    }

    #[test]
    fn changes_are_stored_replaced_and_listed_newest_first() {
        let db = Db::in_memory().unwrap();
        let (a, b) = (change(1, "acme/webshop", "2026-09-20T00:00:00Z"), change(2, "acme/webshop", "2026-09-25T00:00:00Z"));
        db.upsert_code_changes(&[a.clone(), b.clone()], "2026-09-29T00:00:00Z").unwrap();
        let mut a2 = a.clone();
        a2.title = "Renamed".into();
        db.upsert_code_changes(&[a2], "2026-09-29T00:00:00Z").unwrap();
        assert_eq!(db.code_changes("github:ann").unwrap().iter().map(|c| (c.number.unwrap(), c.title.as_str())).collect::<Vec<_>>(), [(2, "T"), (1, "Renamed")]);
        assert_eq!(db.code_change("github:ann", &b.external_id).unwrap(), Some(b));
        assert_eq!(db.code_change("github:ann", "nope").unwrap(), None);
        assert_eq!(db.code_change_counts("github:ann").unwrap()["acme/webshop"], 2);
    }

    #[test]
    fn changes_are_found_by_repository_and_head_branch_only() {
        let db = Db::in_memory().unwrap();
        let mut branch = change(3, "acme/webshop", "2026-09-26T00:00:00Z");
        branch.kind = crate::domain::CodeChangeKind::Branch;
        branch.external_id = CodeChange::branch_id("acme/webshop", "worktree-x");
        branch.head_ref = "worktree-x".into();
        let (mut a, mut b, other) = (change(1, "acme/webshop", "2026-09-20T00:00:00Z"), change(2, "Acme/WebShop", "2026-09-25T00:00:00Z"), change(4, "acme/gateway", "2026-09-25T00:00:00Z"));
        a.head_ref = "worktree-x".into();
        b.head_ref = "worktree-x".into();
        let mut elsewhere = other.clone();
        elsewhere.head_ref = "worktree-x".into();
        db.upsert_code_changes(&[a, b, branch, elsewhere, other], "t").unwrap();
        let mut found: Vec<u64> = db.code_changes_for_branch("github:ann", "acme/webshop", &["worktree-x".into()]).unwrap().iter().map(|c| c.number.unwrap()).collect();
        found.sort();
        assert_eq!(found, [1, 2, 3], "the branch counts; the other repository is left out");
        assert!(db.code_changes_for_branch("github:ann", "acme/webshop", &["nope".into()]).unwrap().is_empty());
        assert!(db.code_changes_for_branch("github:other", "acme/webshop", &["worktree-x".into()]).unwrap().is_empty());
    }

    #[test]
    fn links_are_replaced_as_a_set_and_read_back_strongest_first() {
        let db = Db::in_memory().unwrap();
        let (a, b) = (change(1, "acme/webshop", "2026-09-20T00:00:00Z"), change(2, "acme/webshop", "2026-09-25T00:00:00Z"));
        db.upsert_code_changes(&[a.clone(), b.clone()], "t").unwrap();
        db.replace_item_links("github:ann", &[link("CA-1", &b, LinkSource::Body), link("CA-1", &a, LinkSource::Branch), link("CA-2", &b, LinkSource::Title)], "t").unwrap();
        let item = ItemRef { connection_id: "jira:s:me".into(), external_id: "CA-1".into(), key: "CA-1".into() };
        let found = db.dev_links(&item).unwrap();
        assert_eq!(found.iter().map(|l| (l.change.number.unwrap(), l.provenance)).collect::<Vec<_>>(), [(1, LinkSource::Branch), (2, LinkSource::Body)]);
        db.replace_item_links("github:ann", &[link("CA-2", &b, LinkSource::Title)], "t").unwrap();
        assert!(db.dev_links(&item).unwrap().is_empty());
        let other = ItemRef { connection_id: "jira:other:me".into(), ..item };
        assert!(db.dev_links(&other).unwrap().is_empty(), "another connection's CA-1 is a different item");
    }

    #[test]
    fn pruning_drops_stale_changes_of_repositories_not_kept_and_their_links() {
        let db = Db::in_memory().unwrap();
        let (a, b, c) = (change(1, "acme/webshop", "2026-09-20T00:00:00Z"), change(2, "acme/gateway", "2026-09-20T00:00:00Z"), change(3, "acme/gateway", "2026-09-20T00:00:00Z"));
        db.upsert_code_changes(&[a.clone(), b.clone()], "2026-08-01T00:00:00Z").unwrap();
        db.upsert_code_changes(std::slice::from_ref(&c), "2026-09-28T00:00:00Z").unwrap();
        db.replace_item_links("github:ann", &[link("CA-1", &a, LinkSource::Branch), link("CA-1", &b, LinkSource::Branch)], "t").unwrap();
        assert_eq!(db.prune_code_changes("github:ann", &["acme/webshop".to_string()], "2026-09-01T00:00:00Z").unwrap(), 1);
        let left: Vec<_> = db.code_changes("github:ann").unwrap().iter().map(|c| c.number.unwrap()).collect();
        assert_eq!(left, [3, 1]);
        let item = ItemRef { connection_id: "jira:s:me".into(), external_id: "CA-1".into(), key: "CA-1".into() };
        assert_eq!(db.dev_links(&item).unwrap().len(), 1);
        assert_eq!(db.prune_code_changes("github:ann", &[], "2026-09-01T00:00:00Z").unwrap(), 1, "the stale one of an unkept repository goes");
        assert_eq!(db.code_changes("github:ann").unwrap().len(), 1, "the fresh one stays");
    }

    #[test]
    fn project_keys_come_from_containers_and_the_catalog() {
        let db = Db::in_memory().unwrap();
        db.conn.execute("INSERT INTO containers (connection_id, external_id, key, name, synced_at) VALUES ('j', '1', 'CA', 'Cats', 't')", []).unwrap();
        db.conn.execute("INSERT INTO container_catalog (connection_id, external_id, key, name, seen_at) VALUES ('j', '2', 'CA', 'Cats', 't'), ('j', '3', 'SRE', 'Sre', 't'), ('x', '4', 'NO', 'No', 't')", []).unwrap();
        let mut keys = db.project_keys("j").unwrap();
        keys.sort();
        assert_eq!(keys, ["CA", "SRE"]);
    }

    #[test]
    fn an_answer_is_replaced_and_old_ones_are_pruned_unless_touched() {
        let db = Db::in_memory().unwrap();
        let entry = |etag: &str| CachedHttp { etag: Some(etag.into()), last_modified: None, next: None, body: "[]".into() };
        assert_eq!(db.http_cache_get("c", "u").unwrap(), None);
        db.http_cache_put("c", "u", &entry("\"a\""), "2026-09-01T00:00:00Z").unwrap();
        db.http_cache_put("c", "u", &entry("\"b\""), "2026-09-02T00:00:00Z").unwrap();
        db.http_cache_put("c", "old", &entry("\"c\""), "2026-08-01T00:00:00Z").unwrap();
        db.http_cache_put("c", "quiet", &entry("\"d\""), "2026-08-01T00:00:00Z").unwrap();
        db.http_cache_touch("c", "quiet", "2026-09-05T00:00:00Z").unwrap();
        assert_eq!(db.http_cache_get("c", "u").unwrap().unwrap().etag.as_deref(), Some("\"b\""));
        assert_eq!(db.http_cache_get("other", "u").unwrap(), None);
        assert_eq!(db.http_cache_prune("c", "2026-09-01T00:00:00Z").unwrap(), 1);
        assert_eq!(db.http_cache_get("c", "old").unwrap(), None);
        assert!(db.http_cache_get("c", "quiet").unwrap().is_some(), "a touched answer is current");
    }
}
