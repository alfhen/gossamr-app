//! Proposals as stored: the whole value in `data`, with the columns lists narrow on kept in step with it.

use chrono::{DateTime, Utc};
use rusqlite::types::Value as Sql;
use rusqlite::{params, params_from_iter, OptionalExtension};

use super::{stamp, Db};
use crate::domain::{Intent, Proposal, ProposalQuery, ProposalState, StateKind};
use crate::error::{Error, Result};

fn connection_of(p: &Proposal) -> String {
    match &p.intent {
        Intent::Create { container, .. } => container.connection_id.clone(),
        Intent::StartRun { connection_id, .. } | Intent::FollowUp { connection_id, .. } => connection_id.clone(),
        other => other.target().map(|t| t.connection_id.clone()).unwrap_or_default(),
    }
}

impl Db {
    pub fn insert_proposal(&self, p: &Proposal) -> Result<()> {
        let item_id = p.target().map(|t| t.external_id.clone());
        self.conn.execute(
            "INSERT INTO proposals (id, connection_id, item_id, state, created_at, updated_at, data)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![p.id, connection_of(p), item_id, p.state.kind().as_str(), stamp(p.created_at), stamp(p.updated_at), serde_json::to_string(p)?],
        )?;
        Ok(())
    }

    /// Replaces a stored proposal. Returns false when there is none with that id.
    pub fn save_proposal(&self, p: &Proposal) -> Result<bool> {
        let n = self.conn.execute(
            "UPDATE proposals SET state = ?2, updated_at = ?3, data = ?4 WHERE id = ?1",
            params![p.id, p.state.kind().as_str(), stamp(p.updated_at), serde_json::to_string(p)?],
        )?;
        Ok(n > 0)
    }

    pub fn proposal(&self, id: &str) -> Result<Option<Proposal>> {
        let data: Option<String> =
            self.conn.query_row("SELECT data FROM proposals WHERE id = ?1", params![id], |r| r.get(0)).optional()?;
        Ok(data.map(|d| serde_json::from_str(&d)).transpose()?)
    }

    /// Proposals matching the query, newest first.
    pub fn proposals(&self, q: &ProposalQuery) -> Result<Vec<Proposal>> {
        let mut sql = String::from("SELECT data FROM proposals WHERE 1 = 1");
        let mut args: Vec<Sql> = Vec::new();
        if let Some(states) = &q.states {
            let marks = vec!["?"; states.len()].join(",");
            sql.push_str(&format!(" AND state IN ({marks})"));
            args.extend(states.iter().map(|s| Sql::Text(s.as_str().into())));
        }
        if let Some(item) = &q.item {
            sql.push_str(" AND connection_id = ? AND item_id = ?");
            args.push(Sql::Text(item.connection_id.clone()));
            args.push(Sql::Text(item.external_id.clone()));
        }
        if let Some(c) = &q.connection_id {
            sql.push_str(" AND connection_id = ?");
            args.push(Sql::Text(c.clone()));
        }
        sql.push_str(" ORDER BY created_at DESC, id");
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(args), |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(serde_json::from_str(&row?)?);
        }
        Ok(out)
    }

    /// Moves a pending proposal to `Applying` and returns it, or `None` when it wasn't pending. The state column is
    /// the guard, so two callers can't both start the same proposal.
    pub fn begin_applying(&self, id: &str, at: DateTime<Utc>) -> Result<Option<Proposal>> {
        let tx = self.conn.unchecked_transaction()?;
        let claimed = tx.execute(
            "UPDATE proposals SET state = 'applying' WHERE id = ?1 AND state = 'pending'",
            params![id],
        )?;
        if claimed == 0 {
            return Ok(None);
        }
        let data: String = tx.query_row("SELECT data FROM proposals WHERE id = ?1", params![id], |r| r.get(0))?;
        let mut p: Proposal = serde_json::from_str(&data)?;
        if matches!(p.intent, Intent::StartRun { .. }) {
            return Err(Error::Proposal("a run is approved with its own button".into()));
        }
        if matches!(p.intent, Intent::FollowUp { .. }) {
            return Err(Error::Proposal("a follow-up is sent back with its own button".into()));
        }
        p.state = ProposalState::Applying;
        p.updated_at = at;
        p.error = None;
        tx.execute(
            "UPDATE proposals SET updated_at = ?2, data = ?3 WHERE id = ?1",
            params![id, stamp(at), serde_json::to_string(&p)?],
        )?;
        tx.commit()?;
        Ok(Some(p))
    }

    /// Puts proposals left `Applying` by a run that never finished back to pending, with a note that the write may
    /// have gone through. A `StartRun` is left alone: it is approved by one transaction and never passes through
    /// `Applying`, so there is no write to doubt.
    pub fn release_interrupted(&self, at: DateTime<Utc>) -> Result<usize> {
        let stuck = self.proposals(&ProposalQuery { states: Some(vec![StateKind::Applying]), ..Default::default() })?;
        let stuck: Vec<Proposal> = stuck.into_iter().filter(|p| !matches!(p.intent, Intent::StartRun { .. } | Intent::FollowUp { .. })).collect();
        for mut p in stuck.iter().cloned() {
            p.state = ProposalState::Pending;
            p.updated_at = at;
            p.error = Some("Gossamr closed while this was being applied. Check whether it went through before trying again.".into());
            self.save_proposal(&p)?;
        }
        Ok(stuck.len())
    }
}
