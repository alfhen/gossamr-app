//! What a code host connection keeps: the last answer to each request, so polling can be conditional.

use rusqlite::{params, OptionalExtension};

use super::Db;
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

    /// Marks an answer as refreshed without changing it, as when the host says it is still current.
    pub fn http_cache_touch(&self, connection_id: &str, url: &str, at: &str) -> Result<()> {
        self.conn.execute("UPDATE http_cache SET fetched_at = ?3 WHERE connection_id = ?1 AND url = ?2", params![connection_id, url, at])?;
        Ok(())
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
