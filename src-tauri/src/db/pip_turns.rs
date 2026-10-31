//! Pip's conversations as stored. A turn is two rows under its request id: what started it (the person's question, role
//! `user`, or the supervisor's event lines, role `wake`) and Pip's answer. Only `insert_pip_turn` inserts; every later
//! write is an update, so a turn whose rows were cleared stays gone.

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::Db;
use crate::agent::{TurnMeta, TurnUsage};
use crate::domain::{Actor, WorkstreamEvent};
use crate::error::Result;

/// Why a turn that was running when the app last closed is shown as failed.
pub const INTERRUPTED: &str = "Gossamr closed before Pip finished";
/// Why a turn that was still waiting its turn when the app last closed is shown as failed: it never started.
pub const NEVER_RAN: &str = "Gossamr closed before this question ran";

/// What a wake turn's `meta` holds: the `(run, key)` facts its event lines tell of.
#[derive(Serialize, Deserialize)]
struct WakeMeta {
    wakes: Vec<(String, String)>,
}

fn wake_facts_json(facts: &[(String, String)]) -> Result<String> {
    Ok(serde_json::to_string(&WakeMeta { wakes: facts.to_vec() })?)
}

fn wake_facts_of(meta: &str) -> Vec<(String, String)> {
    serde_json::from_str::<WakeMeta>(meta).map(|m| m.wakes).unwrap_or_default()
}

/// One question and its answer, as the page shows it again.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipTurn {
    pub request_id: String,
    pub conversation: String,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub looking: Option<String>,
    /// The short line the bubble shows in place of an instruction the page wrote; none for a question as typed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shown: Option<String>,
    /// How many images were sent. The images themselves are not kept.
    pub image_count: u32,
    pub text: String,
    pub steps: Vec<String>,
    /// `queued`, `running`, `done` or `failed`.
    pub status: String,
    pub error: Option<String>,
    pub session_id: Option<String>,
    pub usage: Option<TurnUsage>,
    pub created_at: String,
    /// `user` for a question the person sent, `wake` for a turn the supervisor started.
    pub kind: String,
}

/// The roles a turn can start with.
pub const ROLE_USER: &str = "user";
pub const ROLE_WAKE: &str = "wake";

impl Db {
    /// Records a question and Pip's empty answer. Returns false when a turn with this request id is already stored.
    pub fn begin_pip_turn(&self, conversation: &str, request_id: &str, prompt: &str, meta: &TurnMeta, status: &str, at: &str) -> Result<bool> {
        self.insert_pip_turn(conversation, request_id, ROLE_USER, prompt, &serde_json::to_string(meta)?, status, at)
    }

    /// Records a wake turn: its event lines in place of a question, and the `(run, key)` facts they tell of.
    pub fn begin_pip_wake(&self, conversation: &str, request_id: &str, lines: &str, facts: &[(String, String)], status: &str, at: &str) -> Result<bool> {
        self.insert_pip_turn(conversation, request_id, ROLE_WAKE, lines, &wake_facts_json(facts)?, status, at)
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_pip_turn(&self, conversation: &str, request_id: &str, role: &str, prompt: &str, meta: &str, status: &str, at: &str) -> Result<bool> {
        let tx = self.conn.unchecked_transaction()?;
        let n = tx.execute(
            "INSERT OR IGNORE INTO pip_turns (conversation, request_id, role, prompt, status, meta, created_at)
             VALUES (?1, ?2, ?6, ?3, 'done', ?4, ?5)",
            params![conversation, request_id, prompt, meta, at, role],
        )?;
        if n == 0 {
            return Ok(false);
        }
        tx.execute(
            "INSERT OR IGNORE INTO pip_turns (conversation, request_id, role, status, created_at) VALUES (?1, ?2, 'pip', ?3, ?4)",
            params![conversation, request_id, status, at],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// Rewrites a wake turn's event lines and facts, as when more were merged into it while it waited.
    pub fn set_pip_wake(&self, request_id: &str, lines: &str, facts: &[(String, String)]) -> Result<()> {
        self.conn.execute("UPDATE pip_turns SET prompt = ?2, meta = ?3 WHERE request_id = ?1 AND role = 'wake'", params![request_id, lines, wake_facts_json(facts)?])?;
        Ok(())
    }

    /// Forgets a turn that was recorded but never queued.
    pub fn delete_pip_turn(&self, request_id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM pip_turns WHERE request_id = ?1", params![request_id])?;
        Ok(())
    }

    /// How each wake turn recorded at or after `at` stands, as its (status, error): those of `conversation`, or of every
    /// conversation when none is given.
    pub fn wake_turn_outcomes_since(&self, conversation: Option<&str>, at: &str) -> Result<Vec<(String, Option<String>)>> {
        let mut stmt = self.conn.prepare(
            "SELECT p.status, p.error FROM pip_turns w JOIN pip_turns p ON p.request_id = w.request_id AND p.role = 'pip'
             WHERE w.role = 'wake' AND w.created_at >= ?1 AND (?2 IS NULL OR w.conversation = ?2)",
        )?;
        let rows = stmt.query_map(params![at, conversation], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn set_pip_turn_status(&self, request_id: &str, status: &str) -> Result<()> {
        self.conn.execute("UPDATE pip_turns SET status = ?2 WHERE request_id = ?1 AND role = 'pip'", params![request_id, status])?;
        Ok(())
    }

    pub fn push_pip_turn_step(&self, request_id: &str, step: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE pip_turns SET steps = json_insert(steps, '$[#]', ?2) WHERE request_id = ?1 AND role = 'pip'",
            params![request_id, step],
        )?;
        Ok(())
    }

    /// Writes Pip's whole answer and how the turn ended.
    pub fn finish_pip_turn(&self, request_id: &str, text: &str, ok: bool, error: Option<&str>, session: Option<&str>, usage: Option<&TurnUsage>) -> Result<()> {
        let usage = usage.map(serde_json::to_string).transpose()?;
        self.conn.execute(
            "UPDATE pip_turns SET text = ?2, status = ?3, error = ?4, session_id = COALESCE(?5, session_id), usage = ?6
             WHERE request_id = ?1 AND role = 'pip'",
            params![request_id, text, if ok { "done" } else { "failed" }, if ok { None } else { error }, session, usage],
        )?;
        Ok(())
    }

    /// The turns of `conversation`, oldest first. A question whose answer row is missing is left out.
    pub fn pip_turns(&self, conversation: &str) -> Result<Vec<PipTurn>> {
        let mut stmt = self.conn.prepare(
            "SELECT u.request_id, u.prompt, u.meta, p.text, p.steps, p.status, p.error, p.session_id, p.usage, u.created_at, u.role
             FROM pip_turns u JOIN pip_turns p ON p.request_id = u.request_id AND p.role = 'pip'
             WHERE u.role IN ('user', 'wake') AND u.conversation = ?1
             ORDER BY u.created_at, u.request_id",
        )?;
        let rows = stmt.query_map(params![conversation], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, Option<String>>(8)?,
                r.get::<_, String>(9)?,
                r.get::<_, String>(10)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (request_id, prompt, meta, text, steps, status, error, session_id, usage, created_at, role) = row?;
            // A part that no longer parses reads as empty rather than hiding the turn.
            let meta: TurnMeta = meta.and_then(|m| serde_json::from_str(&m).ok()).unwrap_or_default();
            out.push(PipTurn {
                request_id,
                conversation: conversation.into(),
                prompt,
                quote: meta.quote,
                looking: meta.looking,
                shown: meta.shown,
                image_count: meta.image_count,
                text,
                steps: serde_json::from_str(&steps).unwrap_or_default(),
                status,
                error,
                session_id,
                usage: usage.and_then(|u| serde_json::from_str(&u).ok()),
                created_at,
                kind: if role == ROLE_WAKE { ROLE_WAKE.into() } else { ROLE_USER.into() },
            });
        }
        Ok(out)
    }

    /// Forgets turns asked before `before`. Both rows of a turn carry the time it was asked, so they go together.
    pub fn prune_pip_turns(&self, before: &str) -> Result<usize> {
        Ok(self.conn.execute("DELETE FROM pip_turns WHERE created_at < ?1", params![before])?)
    }

    /// Forgets every conversation, including the copies a cache file kept from before they moved to the app database.
    pub fn clear_pip_turns(&self) -> Result<()> {
        self.conn.execute("DELETE FROM main.pip_turns", [])?;
        let in_cache = self.conn.query_row("SELECT 1 FROM cache.sqlite_master WHERE type = 'table' AND name = 'pip_turns'", [], |_| Ok(())).optional()?;
        if in_cache.is_some() {
            self.conn.execute("DELETE FROM cache.pip_turns", [])?;
        }
        Ok(())
    }

    /// Forgets every conversation in the app database, for a database opened without a cache file.
    pub fn clear_app_pip_turns(&self) -> Result<()> {
        self.conn.execute("DELETE FROM main.pip_turns", [])?;
        Ok(())
    }

    /// Marks turns that were waiting or running when the app last closed as failed; nothing is left to finish them. A
    /// wake that never ran gives its facts back with a supervisor `wake_dropped` line each, so Pip is woken for them again.
    pub fn fail_interrupted_pip_turns(&self) -> Result<usize> {
        self.fail_pip_turns(None)
    }

    /// `fail_interrupted_pip_turns` for just the turns `request_ids` names: the ones copied in from a cache file. Not the
    /// others, which this launch may be running right now.
    pub(super) fn fail_copied_pip_turns(&self, request_ids: &[String]) -> Result<usize> {
        self.fail_pip_turns(Some(request_ids))
    }

    fn fail_pip_turns(&self, only: Option<&[String]>) -> Result<usize> {
        let wanted = |id: &str| only.is_none_or(|ids| ids.iter().any(|i| i == id));
        self.atomically(|db| {
            let mut stmt = db.conn.prepare(
                "SELECT w.request_id, w.conversation, w.meta FROM pip_turns w JOIN pip_turns p ON p.request_id = w.request_id AND p.role = 'pip'
                 WHERE w.role = 'wake' AND p.status = 'queued'",
            )?;
            let never_ran = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            drop(stmt);
            let now = chrono::Utc::now();
            for (_, conversation, meta) in never_ran.into_iter().filter(|(id, ..)| wanted(id)) {
                let Some(workstream) = conversation.strip_prefix(crate::agent::WORKSTREAM_PREFIX) else { continue };
                for (run, key) in meta.as_deref().map(wake_facts_of).unwrap_or_default() {
                    db.append_workstream_event(&WorkstreamEvent::new(workstream, Actor::Supervisor, "wake_dropped", now).run(&run).detail(&key))?;
                }
            }
            let mut stmt = db.conn.prepare("SELECT request_id, status FROM pip_turns WHERE role = 'pip' AND status IN ('running', 'queued')")?;
            let open = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            drop(stmt);
            let mut failed = 0;
            for (request_id, status) in open.into_iter().filter(|(id, _)| wanted(id)) {
                let error = if status == "queued" { NEVER_RAN } else { INTERRUPTED };
                failed += db.conn.execute("UPDATE pip_turns SET status = 'failed', error = ?2 WHERE request_id = ?1 AND role = 'pip'", params![request_id, error])?;
            }
            Ok(failed)
        })
    }

    #[cfg(test)]
    fn pip_turn_rows(&self) -> Result<usize> {
        Ok(self.conn.query_row("SELECT count(*) FROM pip_turns", [], |r| r.get::<_, i64>(0))? as usize)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(quote: Option<&str>, images: u32) -> TurnMeta {
        TurnMeta { quote: quote.map(String::from), looking: Some("CA-1".into()), image_count: images, ..Default::default() }
    }

    fn usage() -> TurnUsage {
        TurnUsage { input_tokens: 10, output_tokens: 4, cache_creation_tokens: 0, cache_read_tokens: 2, cost_usd: Some(0.01) }
    }

    #[test]
    fn a_turn_is_begun_given_steps_and_finished() {
        let db = Db::in_memory().unwrap();
        assert!(db.begin_pip_turn("workspace", "q1", "What changed?", &meta(Some("the text"), 2), "running", "2026-10-01T10:00:00.000Z").unwrap());
        db.push_pip_turn_step("q1", "Looked up CA-1").unwrap();
        db.push_pip_turn_step("q1", "Listed the drafts").unwrap();
        let mid = db.pip_turns("workspace").unwrap();
        assert_eq!((mid[0].status.as_str(), mid[0].text.as_str()), ("running", ""));
        assert_eq!(mid[0].steps, ["Looked up CA-1", "Listed the drafts"]);

        db.finish_pip_turn("q1", "Two things changed.", true, Some("ignored"), Some("s1"), Some(&usage())).unwrap();
        let turns = db.pip_turns("workspace").unwrap();
        assert_eq!(
            turns,
            vec![PipTurn {
                request_id: "q1".into(),
                conversation: "workspace".into(),
                prompt: "What changed?".into(),
                quote: Some("the text".into()),
                looking: Some("CA-1".into()),
                shown: None,
                image_count: 2,
                text: "Two things changed.".into(),
                steps: vec!["Looked up CA-1".into(), "Listed the drafts".into()],
                status: "done".into(),
                error: None,
                session_id: Some("s1".into()),
                usage: Some(usage()),
                created_at: "2026-10-01T10:00:00.000Z".into(),
                kind: "user".into(),
            }]
        );
        let v = serde_json::to_value(&turns[0]).unwrap();
        assert_eq!((v["requestId"].as_str(), v["imageCount"].as_u64(), v["usage"]["inputTokens"].as_u64()), (Some("q1"), Some(2), Some(10)));
        assert!(v.get("shown").is_none(), "a question as typed has no short line");
    }

    #[test]
    fn the_short_line_a_bubble_shows_comes_back_from_the_stored_meta() {
        let db = Db::in_memory().unwrap();
        let shown = TurnMeta { shown: Some("Discuss this review".into()), ..Default::default() };
        db.begin_pip_turn("general", "q1", "Let's talk about the GitHub review draft p-1 ...", &shown, "running", "t1").unwrap();
        db.begin_pip_turn("general", "q2", "What changed?", &TurnMeta::default(), "running", "t2").unwrap();
        let turns = db.pip_turns("general").unwrap();
        assert_eq!((turns[0].shown.as_deref(), turns[0].prompt.as_str()), (Some("Discuss this review"), "Let's talk about the GitHub review draft p-1 ..."));
        assert_eq!(turns[1].shown, None);
        assert_eq!(serde_json::to_value(&turns[0]).unwrap()["shown"], "Discuss this review");
        let stored: String = db.conn.query_row("SELECT meta FROM pip_turns WHERE request_id = 'q2' AND role = 'user'", [], |r| r.get(0)).unwrap();
        assert!(!stored.contains("shown"), "nothing is stored for a question as typed: {stored}");
    }

    #[test]
    fn a_failed_turn_keeps_its_error_and_the_session_it_had() {
        let db = Db::in_memory().unwrap();
        db.begin_pip_turn("workspace", "q1", "p", &TurnMeta::default(), "running", "t1").unwrap();
        db.finish_pip_turn("q1", "half", false, Some("Stopped"), None, None).unwrap();
        let t = &db.pip_turns("workspace").unwrap()[0];
        assert_eq!((t.status.as_str(), t.error.as_deref(), t.text.as_str(), t.usage.as_ref()), ("failed", Some("Stopped"), "half", None));
        assert_eq!((t.quote.as_ref(), t.image_count), (None, 0));
    }

    #[test]
    fn turns_come_back_oldest_first_paired_and_per_conversation() {
        let db = Db::in_memory().unwrap();
        db.begin_pip_turn("workspace", "b", "second", &TurnMeta::default(), "running", "2026-10-01T10:00:02.000Z").unwrap();
        db.begin_pip_turn("workspace", "a", "first", &TurnMeta::default(), "running", "2026-10-01T10:00:01.000Z").unwrap();
        db.begin_pip_turn("CA-1", "c", "elsewhere", &TurnMeta::default(), "running", "2026-10-01T10:00:00.000Z").unwrap();
        db.finish_pip_turn("a", "answer a", true, None, None, None).unwrap();
        db.finish_pip_turn("b", "answer b", true, None, None, None).unwrap();
        let turns = db.pip_turns("workspace").unwrap();
        let pairs: Vec<(&str, &str)> = turns.iter().map(|t| (t.prompt.as_str(), t.text.as_str())).collect();
        assert_eq!(pairs, [("first", "answer a"), ("second", "answer b")]);
        assert_eq!(db.pip_turns("CA-1").unwrap().len(), 1);
        assert!(db.pip_turns("nothing").unwrap().is_empty());

        assert!(!db.begin_pip_turn("workspace", "a", "again", &TurnMeta::default(), "running", "t").unwrap(), "a request id is stored once");
        assert_eq!(db.pip_turns("workspace").unwrap()[0].prompt, "first");
        assert_eq!(db.pip_turn_rows().unwrap(), 6);
    }

    #[test]
    fn turns_older_than_the_horizon_are_pruned_and_clear_forgets_all() {
        let db = Db::in_memory().unwrap();
        db.begin_pip_turn("workspace", "old", "p", &TurnMeta::default(), "running", "2026-06-01T00:00:00Z").unwrap();
        db.begin_pip_turn("workspace", "new", "p", &TurnMeta::default(), "running", "2026-09-30T00:00:00Z").unwrap();
        assert_eq!(db.prune_pip_turns("2026-07-01T00:00:00Z").unwrap(), 2);
        let left: Vec<String> = db.pip_turns("workspace").unwrap().into_iter().map(|t| t.request_id).collect();
        assert_eq!(left, ["new"]);
        db.clear_pip_turns().unwrap();
        assert_eq!(db.pip_turn_rows().unwrap(), 0);
    }

    #[test]
    fn turns_left_waiting_or_running_become_failed() {
        let db = Db::in_memory().unwrap();
        db.begin_pip_turn("workspace", "r", "p", &TurnMeta::default(), "running", "t1").unwrap();
        db.begin_pip_turn("workspace", "q", "p", &TurnMeta::default(), "queued", "t2").unwrap();
        db.begin_pip_turn("workspace", "d", "p", &TurnMeta::default(), "running", "t3").unwrap();
        db.finish_pip_turn("d", "fine", true, None, None, None).unwrap();
        assert_eq!(db.fail_interrupted_pip_turns().unwrap(), 2);
        let turns = db.pip_turns("workspace").unwrap();
        let states: Vec<(&str, Option<&str>)> = turns.iter().map(|t| (t.status.as_str(), t.error.as_deref())).collect();
        assert_eq!(states, [("failed", Some(INTERRUPTED)), ("failed", Some(NEVER_RAN)), ("done", None)]);
        assert_eq!(db.fail_interrupted_pip_turns().unwrap(), 0);
    }

    #[test]
    fn a_wake_that_never_ran_gives_its_facts_back_once() {
        let db = Db::in_memory().unwrap();
        db.begin_pip_wake("ws:w1", "w1", "[Event] run r1 (triage) Done", &[("r1".into(), "done".into()), ("r2".into(), "failed".into())], "queued", "t1").unwrap();
        db.begin_pip_wake("ws:w1", "w2", "[Event] run r3 (plan) Done", &[("r3".into(), "done".into())], "running", "t2").unwrap();
        db.fail_interrupted_pip_turns().unwrap();
        let dropped: Vec<(Option<String>, Option<String>)> =
            db.workstream_events("w1").unwrap().into_iter().filter(|e| e.action == "wake_dropped").map(|e| (e.run_id, e.detail)).collect();
        assert_eq!(dropped, [(Some("r1".into()), Some("done".into())), (Some("r2".into()), Some("failed".into()))]);
        db.fail_interrupted_pip_turns().unwrap();
        assert_eq!(db.workstream_events("w1").unwrap().len(), 2, "a second open adds nothing");
    }

    #[test]
    fn a_wake_turn_loads_as_a_wake_and_old_rows_as_the_person_s() {
        let db = Db::in_memory().unwrap();
        db.begin_pip_turn("ws:w1", "q1", "Carry on", &TurnMeta::default(), "running", "2026-10-01T10:00:00.000Z").unwrap();
        db.begin_pip_wake("ws:w1", "w1", "[Event] run r1 (triage) Done", &[("r1".into(), "done".into())], "queued", "2026-10-01T10:00:01.000Z").unwrap();
        db.set_pip_wake("w1", "[Event] run r1 (triage) Done\n[Event] run r2 (plan) Done", &[("r1".into(), "done".into()), ("r2".into(), "done".into())]).unwrap();
        db.set_pip_wake("q1", "rewritten", &[]).unwrap();
        let turns = db.pip_turns("ws:w1").unwrap();
        let kinds: Vec<(&str, &str, &str)> = turns.iter().map(|t| (t.request_id.as_str(), t.kind.as_str(), t.prompt.as_str())).collect();
        assert_eq!(kinds, [("q1", "user", "Carry on"), ("w1", "wake", "[Event] run r1 (triage) Done\n[Event] run r2 (plan) Done")], "only a wake's prompt is rewritten");
        assert_eq!(serde_json::to_value(&turns[1]).unwrap()["kind"], "wake");
        let outcomes = |conversation: Option<&str>, at: &str| db.wake_turn_outcomes_since(conversation, at).unwrap();
        assert_eq!(outcomes(None, "2026-10-01T10:00:00.000Z"), [("queued".to_string(), None)]);
        assert!(outcomes(None, "2026-10-01T10:00:02.000Z").is_empty());
        assert_eq!(outcomes(Some("ws:w1"), "2026-10-01T10:00:00.000Z").len(), 1);
        assert!(outcomes(Some("ws:other"), "2026-10-01T10:00:00.000Z").is_empty());
        db.delete_pip_turn("w1").unwrap();
        assert_eq!(db.pip_turns("ws:w1").unwrap().len(), 1);

        // A row stored before wakes existed has no other role than `user`, and reads as the person's.
        db.conn.execute("INSERT INTO pip_turns (conversation, request_id, role, prompt, status, created_at) VALUES ('general', 'old', 'user', 'Hi', 'done', 't0')", []).unwrap();
        db.conn.execute("INSERT INTO pip_turns (conversation, request_id, role, status, created_at) VALUES ('general', 'old', 'pip', 'done', 't0')", []).unwrap();
        assert_eq!(db.pip_turns("general").unwrap()[0].kind, "user");
    }

    #[test]
    fn writes_after_a_clear_do_not_bring_a_turn_back() {
        let db = Db::in_memory().unwrap();
        db.begin_pip_turn("workspace", "q", "p", &TurnMeta::default(), "running", "t").unwrap();
        db.clear_pip_turns().unwrap();
        db.push_pip_turn_step("q", "step").unwrap();
        db.set_pip_turn_status("q", "running").unwrap();
        db.finish_pip_turn("q", "late", true, None, Some("s"), None).unwrap();
        assert_eq!(db.pip_turn_rows().unwrap(), 0);
    }
}
