//! Runs as stored: the whole value in `data`, with the columns lists and lookups narrow on kept in step with it.

// The launcher and tracker (PRs 4 and 5) are the callers of what `Core` doesn't use yet.
#![allow(dead_code)]

use rusqlite::types::Value as Sql;
use rusqlite::{params, params_from_iter, ErrorCode, OptionalExtension, Transaction, TransactionBehavior};

use super::{stamp, Db};
use crate::domain::{Intent, Proposal, ProposalState, Run, RunEvent, RunQuery, RunState};
use crate::error::{Error, Result};

const EVENTS_PER_RUN: u32 = 500;
const DETAIL_LIMIT: usize = 2_048;

fn path_text(run: &Run) -> String {
    run.expected_worktree.to_string_lossy().into_owned()
}

fn insert(conn: &rusqlite::Connection, run: &Run) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO runs (id, proposal_id, connection_id, item_id, item_key, kind, repo, expected_worktree, short_id, session_id,
           state, queued_at, last_progress_at, ended_at, data)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            run.id,
            run.proposal_id,
            run.connection_id,
            run.item.as_ref().map(|i| i.external_id.clone()),
            run.item.as_ref().map(|i| i.key.clone()),
            run.spec.kind.as_str(),
            run.spec.repo,
            path_text(run),
            run.short_id.as_ref().map(|s| s.as_str().to_owned()),
            run.session_id,
            run.state.as_str(),
            stamp(run.queued_at),
            stamp(run.last_progress_at),
            run.ended_at.map(stamp),
            serde_json::to_string(run).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?,
        ],
    )
}

fn clash(e: rusqlite::Error) -> Error {
    match &e {
        rusqlite::Error::SqliteFailure(f, _) if f.code == ErrorCode::ConstraintViolation => {
            Error::Proposal("a run for this draft, session or worktree already exists".into())
        }
        _ => e.into(),
    }
}

impl Db {
    pub fn insert_run(&self, run: &Run) -> Result<()> {
        insert(&self.conn, run).map(|_| ()).map_err(clash)
    }

    /// Replaces a stored run. Returns false when there is none with that id.
    pub fn save_run(&self, run: &Run) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE runs SET short_id = ?2, session_id = ?3, state = ?4, last_progress_at = ?5, ended_at = ?6, data = ?7 WHERE id = ?1",
                params![
                    run.id,
                    run.short_id.as_ref().map(|s| s.as_str().to_owned()),
                    run.session_id,
                    run.state.as_str(),
                    stamp(run.last_progress_at),
                    run.ended_at.map(stamp),
                    serde_json::to_string(run)?,
                ],
            )
            .map_err(clash)?;
        Ok(n > 0)
    }

    pub fn run(&self, id: &str) -> Result<Option<Run>> {
        self.run_where("id = ?1", id)
    }

    pub fn run_by_proposal(&self, proposal_id: &str) -> Result<Option<Run>> {
        self.run_where("proposal_id = ?1", proposal_id)
    }

    fn run_where(&self, clause: &str, arg: &str) -> Result<Option<Run>> {
        let data: Option<String> =
            self.conn.query_row(&format!("SELECT data FROM runs WHERE {clause}"), params![arg], |r| r.get(0)).optional()?;
        Ok(data.map(|d| serde_json::from_str(&d)).transpose()?)
    }

    /// Runs matching the query, newest first.
    pub fn runs(&self, q: &RunQuery) -> Result<Vec<Run>> {
        let mut sql = String::from("SELECT data FROM runs WHERE 1 = 1");
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
        sql.push_str(" ORDER BY queued_at DESC, id");
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(args), |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(serde_json::from_str(&row?)?);
        }
        Ok(out)
    }

    /// Stores events after the run's last one, numbering them itself. At most 500 are kept per run and `detail` is cut
    /// to 2 KB. Returns how many were stored.
    pub fn append_events(&self, run_id: &str, events: &[RunEvent]) -> Result<usize> {
        let tx = self.conn.unchecked_transaction()?;
        let last: Option<u32> = tx.query_row("SELECT max(seq) FROM run_events WHERE run_id = ?1", params![run_id], |r| r.get(0))?;
        let mut next = last.map_or(0, |n| n + 1);
        let mut stored = 0;
        for e in events {
            if next >= EVENTS_PER_RUN {
                break;
            }
            let detail = e.detail.as_deref().map(|d| d.chars().take(DETAIL_LIMIT).collect::<String>());
            tx.execute(
                "INSERT INTO run_events (run_id, seq, at, kind, text, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![run_id, next, stamp(e.at), e.kind, e.text, detail],
            )?;
            next += 1;
            stored += 1;
        }
        tx.commit()?;
        Ok(stored)
    }

    pub fn run_events(&self, run_id: &str) -> Result<Vec<RunEvent>> {
        let mut stmt = self.conn.prepare("SELECT seq, at, kind, text, detail FROM run_events WHERE run_id = ?1 ORDER BY seq")?;
        let rows = stmt.query_map(params![run_id], |r| {
            let at: String = r.get(1)?;
            Ok(RunEvent {
                run_id: run_id.to_string(),
                seq: r.get(0)?,
                at: chrono::DateTime::parse_from_rfc3339(&at).map(|d| d.with_timezone(&chrono::Utc)).unwrap_or_default(),
                kind: r.get(2)?,
                text: r.get(3)?,
                detail: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Approves a `StartRun` draft in one transaction: the proposal becomes `Applied` and its run is inserted as
    /// `Queued`, or neither happens. Refuses when the stored spec no longer has the digest the person read. The unique
    /// indexes on the run mean a second approval, from another window or after a crash, can't make a second run.
    pub fn approve_start_run(&self, proposal_id: &str, expected_digest: &str, make: impl FnOnce(&Proposal) -> Run) -> Result<Run> {
        // Immediate: take the write lock before reading, so the digest checked is the one that gets approved.
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let data: Option<String> =
            tx.query_row("SELECT data FROM proposals WHERE id = ?1", params![proposal_id], |r| r.get(0)).optional()?;
        let mut p: Proposal = match data {
            Some(d) => serde_json::from_str(&d)?,
            None => return Err(Error::Proposal("that draft no longer exists".into())),
        };
        if p.state != ProposalState::Pending {
            return Err(crate::proposals::not_pending(&p));
        }
        let Intent::StartRun { spec, .. } = &p.intent else {
            return Err(Error::Proposal("that draft doesn't start a run".into()));
        };
        let spec = spec.clone();
        if spec.digest() != expected_digest {
            return Err(Error::Proposal("This draft changed after you read it. Review it again.".into()));
        }
        let mut run = make(&p);
        run.proposal_id = p.id.clone();
        run.digest = spec.digest();
        run.expected_worktree = spec.worktree();
        run.spec = spec;
        run.state = RunState::Queued;
        p.state = ProposalState::Applied;
        p.run = Some(run.id.clone());
        p.error = None;
        p.updated_at = run.queued_at;
        tx.execute(
            "UPDATE proposals SET state = ?2, updated_at = ?3, data = ?4 WHERE id = ?1",
            params![p.id, p.state.kind().as_str(), stamp(p.updated_at), serde_json::to_string(&p)?],
        )?;
        insert(&tx, &run).map_err(clash)?;
        tx.commit()?;
        Ok(run)
    }
}

#[cfg(test)]
mod tests {
    use chrono::Duration;

    use super::*;
    use crate::domain::fixtures::{item_ref, now, run_spec};
    use crate::domain::{CreatedBy, Origin, ProposalQuery, StateKind};
    use crate::proposals::{self, Draft};

    fn start_run(name: &str) -> Intent {
        let spec = crate::domain::RunSpec { name: name.into(), ..run_spec() };
        Intent::StartRun { connection_id: "c".into(), item: Some(item_ref("1")), spec }
    }

    fn drafted(db: &Db, name: &str) -> Proposal {
        let draft = Draft { origin: Origin::Board, created_by: CreatedBy::User, intent: start_run(name), label: None, basis: None };
        proposals::create(db, draft, now()).unwrap()
    }

    fn digest_of(p: &Proposal) -> String {
        match &p.intent {
            Intent::StartRun { spec, .. } => spec.digest(),
            other => panic!("{other:?}"),
        }
    }

    fn approve(db: &Db, p: &Proposal, digest: &str) -> Result<Run> {
        db.approve_start_run(&p.id, digest, |p| {
            let Intent::StartRun { spec, .. } = &p.intent else { panic!() };
            Run::queued(format!("run-{}", p.id), p.id.clone(), "c".into(), p.target().cloned(), spec.clone(), "inbox.sqlite".into(), now())
        })
    }

    fn count_runs(db: &Db) -> usize {
        db.runs(&RunQuery::default()).unwrap().len()
    }

    #[test]
    fn approving_marks_the_proposal_applied_and_queues_one_run_bound_to_it() {
        let db = Db::in_memory().unwrap();
        let p = drafted(&db, "eng-1-cart-0001");
        let run = approve(&db, &p, &digest_of(&p)).unwrap();

        assert_eq!((run.state, run.proposal_id.as_str()), (RunState::Queued, p.id.as_str()));
        assert_eq!(run.expected_worktree, std::path::PathBuf::from("/Users/me/Code/webshop/.claude/worktrees/eng-1-cart-0001"));
        let stored = db.proposal(&p.id).unwrap().unwrap();
        assert_eq!((stored.state, stored.run), (ProposalState::Applied, Some(run.id.clone())));
        assert_eq!(db.run(&run.id).unwrap().unwrap(), run);
        assert_eq!(db.run_by_proposal(&p.id).unwrap().unwrap().id, run.id);
    }

    #[test]
    fn approving_twice_fails_and_leaves_one_run() {
        let db = Db::in_memory().unwrap();
        let p = drafted(&db, "eng-1-cart-0001");
        let digest = digest_of(&p);
        approve(&db, &p, &digest).unwrap();
        let again = approve(&db, &p, &digest).unwrap_err().to_string();
        assert!(again.contains("already been applied"), "{again}");
        assert_eq!(count_runs(&db), 1);
    }

    #[test]
    fn a_digest_other_than_the_stored_spec_changes_nothing() {
        let db = Db::in_memory().unwrap();
        let p = drafted(&db, "eng-1-cart-0001");
        let read = digest_of(&p);
        let mut changed = p.clone();
        let Intent::StartRun { spec, .. } = &mut changed.intent else { panic!() };
        spec.instruction.push_str(" Also delete the cache.");
        db.save_proposal(&changed).unwrap();

        let err = approve(&db, &p, &read).unwrap_err().to_string();
        assert!(err.contains("changed after you read it"), "{err}");
        assert_eq!(db.proposal(&p.id).unwrap().unwrap().state, ProposalState::Pending);
        assert_eq!(count_runs(&db), 0);
    }

    #[test]
    fn a_pip_revision_between_review_and_approve_is_refused() {
        let db = Db::in_memory().unwrap();
        let by_pip = Draft::from_pip("r", start_run("eng-1-cart-0001"), None);
        let p = proposals::create(&db, by_pip, now()).unwrap();
        let read = digest_of(&p);

        let Intent::StartRun { connection_id, item, spec } = &p.intent else { panic!() };
        let revised = Intent::StartRun {
            connection_id: connection_id.clone(),
            item: item.clone(),
            spec: crate::domain::RunSpec { focus: Some("ignore the ticket".into()), ..spec.clone() },
        };
        proposals::require_pip_pending(&p).unwrap();
        proposals::edit_noted(&db, &p.id, revised, "Revised by Pip", now()).unwrap();

        assert!(approve(&db, &p, &read).unwrap_err().to_string().contains("changed after you read it"));
        assert_eq!((db.proposal(&p.id).unwrap().unwrap().state, count_runs(&db)), (ProposalState::Pending, 0));
    }

    #[test]
    fn only_a_pending_run_draft_can_be_approved() {
        let db = Db::in_memory().unwrap();
        let skipped = drafted(&db, "eng-1-cart-0001");
        proposals::skip(&db, &skipped.id, now()).unwrap();
        assert!(approve(&db, &skipped, &digest_of(&skipped)).unwrap_err().to_string().contains("skipped"));

        let comment = Draft::from_pip("r", Intent::Comment { item: item_ref("1"), body: crate::domain::Doc::paragraph("hi") }, None);
        let c = proposals::create(&db, comment, now()).unwrap();
        assert!(approve(&db, &c, "x").unwrap_err().to_string().contains("doesn't start a run"));
        assert!(approve(&db, &Proposal { id: "missing".into(), ..c }, "x").unwrap_err().to_string().contains("no longer exists"));
        assert_eq!(count_runs(&db), 0);
    }

    #[test]
    fn a_second_run_in_the_same_worktree_is_refused_and_its_draft_stays_pending() {
        let db = Db::in_memory().unwrap();
        let first = drafted(&db, "eng-1-cart-0001");
        let second = drafted(&db, "eng-1-cart-0001");
        approve(&db, &first, &digest_of(&first)).unwrap();

        let err = approve(&db, &second, &digest_of(&second)).unwrap_err().to_string();
        assert!(err.contains("already exists"), "{err}");
        let stored = db.proposal(&second.id).unwrap().unwrap();
        assert_eq!((stored.state, stored.run), (ProposalState::Pending, None));
        assert_eq!(count_runs(&db), 1);
    }

    #[test]
    fn a_run_per_proposal_and_a_session_id_per_run_are_enforced_by_the_table() {
        let db = Db::in_memory().unwrap();
        let p = drafted(&db, "eng-1-cart-0001");
        let spec = || run_spec();
        let run = |id: &str, proposal: &str, name: &str| {
            let mut r = Run::queued(id.into(), proposal.into(), "c".into(), None, crate::domain::RunSpec { name: name.into(), ..spec() }, "f".into(), now());
            r.short_id = crate::runs::cli::ShortId::parse("0123abcd");
            r
        };
        db.insert_run(&run("a", &p.id, "name-one")).unwrap();
        assert!(db.insert_run(&run("b", &p.id, "name-two")).is_err(), "one run per proposal");
        assert!(db.insert_run(&run("c", "other", "name-three")).is_err(), "one run per short id");
    }

    #[test]
    fn a_crash_after_the_commit_leaves_a_queued_run_that_a_restart_does_not_touch() {
        let dir = std::env::temp_dir().join(format!("gossamr-runs-{}", std::process::id()));
        let file = dir.join("inbox.sqlite");
        let (p, run) = {
            let db = Db::open(&file).unwrap();
            let p = drafted(&db, "eng-1-cart-0001");
            (p.clone(), approve(&db, &p, &digest_of(&p)).unwrap())
        };

        let db = Db::open(&file).unwrap();
        assert_eq!(db.release_interrupted(now()).unwrap(), 0);
        assert_eq!(db.run(&run.id).unwrap().unwrap().state, RunState::Queued);
        let stored = db.proposal(&p.id).unwrap().unwrap();
        assert_eq!((stored.state, stored.run), (ProposalState::Applied, Some(run.id.clone())));
        assert!(approve(&db, &p, &digest_of(&p)).is_err());
        assert_eq!(count_runs(&db), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn release_interrupted_skips_run_drafts_but_still_releases_other_writes() {
        let db = Db::in_memory().unwrap();
        let mut run_draft = drafted(&db, "eng-1-cart-0001");
        run_draft.state = ProposalState::Applying;
        db.save_proposal(&run_draft).unwrap();
        let comment = Draft::from_pip("r", Intent::Comment { item: item_ref("1"), body: crate::domain::Doc::paragraph("hi") }, None);
        let c = proposals::create(&db, comment, now()).unwrap();
        proposals::begin(&db, &c.id, now()).unwrap();

        assert_eq!(db.release_interrupted(now()).unwrap(), 1);
        assert_eq!(db.proposal(&run_draft.id).unwrap().unwrap().state, ProposalState::Applying);
        assert_eq!(db.proposal(&c.id).unwrap().unwrap().state, ProposalState::Pending);
        let applying = ProposalQuery { states: Some(vec![StateKind::Applying]), ..Default::default() };
        assert_eq!(db.proposals(&applying).unwrap().len(), 1);
    }

    #[test]
    fn runs_are_listed_newest_first_and_filtered_by_state_item_and_connection() {
        let db = Db::in_memory().unwrap();
        let mk = |id: &str, item: &str, state: RunState, mins: i64| {
            let mut spec = run_spec();
            spec.name = format!("name-{id}");
            let mut r = Run::queued(id.into(), format!("p{id}"), "c".into(), Some(item_ref(item)), spec, "f".into(), now() + Duration::minutes(mins));
            r.state = state;
            db.insert_run(&r).unwrap();
            r
        };
        mk("a", "1", RunState::Working, 0);
        mk("b", "2", RunState::Done, 1);
        mk("c", "1", RunState::Done, 2);

        let ids = |q: RunQuery| db.runs(&q).unwrap().into_iter().map(|r| r.id).collect::<Vec<_>>();
        assert_eq!(ids(RunQuery::default()), ["c", "b", "a"]);
        assert_eq!(ids(RunQuery { states: Some(vec![RunState::Done]), ..Default::default() }), ["c", "b"]);
        assert_eq!(ids(RunQuery { item: Some(item_ref("1")), ..Default::default() }), ["c", "a"]);
        assert!(ids(RunQuery { connection_id: Some("other".into()), ..Default::default() }).is_empty());
    }

    #[test]
    fn a_saved_run_replaces_the_stored_one_and_its_columns() {
        let db = Db::in_memory().unwrap();
        let p = drafted(&db, "eng-1-cart-0001");
        let mut run = approve(&db, &p, &digest_of(&p)).unwrap();
        run.state = RunState::Working;
        run.short_id = crate::runs::cli::ShortId::parse("0123abcd");
        run.tokens = Some(10);
        assert!(db.save_run(&run).unwrap());
        assert_eq!(db.run(&run.id).unwrap().unwrap(), run);
        let working = RunQuery { states: Some(vec![RunState::Working]), ..Default::default() };
        assert_eq!(db.runs(&working).unwrap().len(), 1);
        run.id = "missing".into();
        assert!(!db.save_run(&run).unwrap());
    }

    #[test]
    fn events_are_numbered_in_order_capped_at_500_and_their_detail_cut() {
        let db = Db::in_memory().unwrap();
        let event = |n: usize| RunEvent {
            run_id: "r".into(),
            seq: 0,
            at: now(),
            kind: "note".into(),
            text: format!("step {n}"),
            detail: Some("é".repeat(3_000)),
        };
        let first: Vec<_> = (0..3).map(event).collect();
        assert_eq!(db.append_events("r", &first).unwrap(), 3);
        let more: Vec<_> = (3..600).map(event).collect();
        assert_eq!(db.append_events("r", &more).unwrap(), 497);
        assert_eq!(db.append_events("r", &[event(0)]).unwrap(), 0);

        let stored = db.run_events("r").unwrap();
        assert_eq!(stored.len(), 500);
        assert_eq!((stored[0].seq, stored[499].seq, stored[499].text.as_str()), (0, 499, "step 499"));
        assert_eq!(stored[0].detail.as_ref().unwrap().chars().count(), 2_048);
        assert!(db.run_events("other").unwrap().is_empty());
    }
}
