//! Pip's conversations, kept in the app database. Every write names the scope the turn was asked in and is refused
//! once that connection is no longer registered, so a turn that ends after a sign-out lands nowhere.

use super::{now_millis, Core};
use crate::agent::{conversation_id, TurnMeta, TurnUsage};
use crate::auth::Scope;
use crate::db::PipTurn;
use crate::error::Result;

impl Core {
    /// Records a question in `conversation`; the legacy `workspace` is kept as `general`.
    pub async fn pip_turn_begin(&self, scope: &Scope, conversation: &str, request_id: &str, prompt: &str, meta: &TurnMeta, status: &str) -> Result<()> {
        let at = now_millis();
        let conversation = conversation_id(conversation);
        self.with_app_db_for(scope, |db| db.begin_pip_turn(&conversation, request_id, prompt, meta, status, &at).map(|_| ())).await
    }

    /// Records a wake turn in `conversation`: its event lines in place of a question, and the `(run, key)` facts they tell of.
    pub async fn pip_wake_begin(&self, scope: &Scope, conversation: &str, request_id: &str, lines: &str, facts: &[(String, String)], status: &str) -> Result<()> {
        let at = now_millis();
        let conversation = conversation_id(conversation);
        self.with_app_db_for(scope, |db| db.begin_pip_wake(&conversation, request_id, lines, facts, status, &at).map(|_| ())).await
    }

    /// Rewrites a waiting wake turn's event lines and facts after more were merged into it.
    pub async fn pip_wake_lines(&self, scope: &Scope, request_id: &str, lines: &str, facts: &[(String, String)]) -> Result<()> {
        self.with_app_db_for(scope, |db| db.set_pip_wake(request_id, lines, facts)).await
    }

    /// Forgets a turn recorded but never queued.
    pub async fn pip_turn_forget(&self, scope: &Scope, request_id: &str) -> Result<()> {
        self.with_app_db_for(scope, |db| db.delete_pip_turn(request_id)).await
    }

    pub async fn pip_turn_status(&self, scope: &Scope, request_id: &str, status: &str) -> Result<()> {
        self.with_app_db_for(scope, |db| db.set_pip_turn_status(request_id, status)).await
    }

    pub async fn pip_turn_step(&self, scope: &Scope, request_id: &str, step: &str) -> Result<()> {
        self.with_app_db_for(scope, |db| db.push_pip_turn_step(request_id, step)).await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn pip_turn_finish(
        &self,
        scope: &Scope,
        request_id: &str,
        text: &str,
        ok: bool,
        error: Option<&str>,
        session: Option<&str>,
        usage: Option<&TurnUsage>,
    ) -> Result<()> {
        self.with_app_db_for(scope, |db| db.finish_pip_turn(request_id, text, ok, error, session, usage)).await
    }

    /// The turns in `conversation`, oldest first, signed in or not. Asked for `workspace`, it gives `general`'s, which is
    /// where those turns now are.
    pub async fn pip_turns(&self, conversation: &str) -> Result<Vec<PipTurn>> {
        let conversation = conversation_id(conversation);
        self.with_app_db(|db| db.pip_turns(&conversation)).await
    }
}

#[cfg(test)]
mod tests {
    use crate::agent::TurnMeta;
    use crate::auth::Scope;
    use crate::error::Error;

    #[tokio::test]
    async fn a_turn_is_recorded_in_the_signed_in_account_and_read_back() {
        let fx = crate::inbox::testing::fixture().await;
        fx.core.pip_turn_begin(&fx.scope, "workspace", "q1", "Hi", &TurnMeta::default(), "running").await.unwrap();
        fx.core.pip_turn_step(&fx.scope, "q1", "Looked up CA-1").await.unwrap();
        fx.core.pip_turn_finish(&fx.scope, "q1", "Hello", true, None, Some("s1"), None).await.unwrap();
        let turns = fx.core.pip_turns("workspace").await.unwrap();
        assert_eq!((turns[0].text.as_str(), turns[0].steps.len(), turns[0].session_id.as_deref()), ("Hello", 1, Some("s1")));
    }

    #[tokio::test]
    async fn the_legacy_workspace_conversation_reads_the_turns_adopted_as_general() {
        let fx = crate::inbox::testing::fixture().await;
        fx.core.pip_turn_begin(&fx.scope, "general", "q1", "Before", &TurnMeta::default(), "done").await.unwrap();
        fx.core.pip_turn_begin(&fx.scope, "workspace", "q2", "From an old page", &TurnMeta::default(), "done").await.unwrap();
        fx.core.pip_turn_begin(&fx.scope, "ws:w1", "q3", "In a workstream", &TurnMeta::default(), "done").await.unwrap();
        let ids = |turns: Vec<crate::db::PipTurn>| turns.into_iter().map(|t| (t.conversation, t.request_id)).collect::<Vec<_>>();
        let general = vec![("general".to_string(), "q1".to_string()), ("general".into(), "q2".into())];
        assert_eq!(ids(fx.core.pip_turns("workspace").await.unwrap()), general);
        assert_eq!(ids(fx.core.pip_turns("general").await.unwrap()), general);
        assert_eq!(ids(fx.core.pip_turns("ws:w1").await.unwrap()), [("ws:w1".to_string(), "q3".to_string())]);
    }

    #[tokio::test]
    async fn the_recording_helpers_refuse_to_write_into_another_scope() {
        let fx = crate::inbox::testing::fixture().await;
        fx.core.pip_turn_begin(&fx.scope, "workspace", "q1", "Hi", &TurnMeta::default(), "running").await.unwrap();
        let other = Scope { connection_id: "jira:site:someone-else".into(), account_id: "someone-else".into() };
        let refused = |r: crate::error::Result<()>| assert!(matches!(r, Err(Error::SiteChanged)), "{r:?}");
        refused(fx.core.pip_turn_begin(&other, "workspace", "q2", "Hi", &TurnMeta::default(), "running").await);
        refused(fx.core.pip_turn_step(&other, "q1", "step").await);
        refused(fx.core.pip_turn_status(&other, "q1", "failed").await);
        refused(fx.core.pip_turn_finish(&other, "q1", "theirs", true, None, None, None).await);
        let turns = fx.core.pip_turns("workspace").await.unwrap();
        assert_eq!(turns.len(), 1);
        assert_eq!((turns[0].status.as_str(), turns[0].text.as_str(), turns[0].steps.len()), ("running", "", 0));
    }

    #[tokio::test]
    async fn a_restart_fails_the_turns_it_cut_off_and_says_which_never_ran() {
        let fx = crate::inbox::testing::fixture().await;
        fx.core.pip_turn_begin(&fx.scope, "workspace", "q1", "Running", &TurnMeta::default(), "running").await.unwrap();
        fx.core.pip_turn_begin(&fx.scope, "workspace", "q2", "Waiting", &TurnMeta::default(), "queued").await.unwrap();
        fx.core.pip_turn_begin(&fx.scope, "workspace", "q3", "Answered", &TurnMeta::default(), "running").await.unwrap();
        fx.core.pip_turn_finish(&fx.scope, "q3", "Fine", true, None, None, None).await.unwrap();
        let before: Vec<String> = fx.core.pip_turns("workspace").await.unwrap().into_iter().map(|t| t.status).collect();
        assert_eq!(before, ["running", "queued", "done"], "an open database leaves turns alone");

        fx.core.restart();
        let after: Vec<(String, Option<String>)> = fx.core.pip_turns("workspace").await.unwrap().into_iter().map(|t| (t.status, t.error)).collect();
        assert_eq!(
            after,
            [
                ("failed".into(), Some(crate::db::INTERRUPTED.into())),
                ("failed".into(), Some(crate::db::NEVER_RAN.into())),
                ("done".into(), None),
            ]
        );
    }

    #[tokio::test]
    async fn sign_out_fails_a_queued_turn() {
        let fx = crate::inbox::testing::fixture().await;
        fx.core.pip_turn_begin(&fx.scope, "general", "q1", "Hi", &TurnMeta::default(), "queued").await.unwrap();
        fx.core.sign_out().await.unwrap();
        let q1 = fx.core.pip_turns("general").await.unwrap().remove(0);
        assert_eq!((q1.status.as_str(), q1.error.as_deref()), ("failed", Some(crate::db::SIGNED_OUT)));
    }

    async fn request_ids(fx: &crate::inbox::testing::Fixture, conversation: &str) -> Vec<String> {
        fx.core.pip_turns(conversation).await.unwrap().into_iter().map(|t| t.request_id).collect()
    }

    #[tokio::test]
    async fn signing_out_keeps_the_conversations_and_a_late_finish_writes_nothing() {
        let fx = crate::inbox::testing::fixture().await;
        fx.core.pip_turn_begin(&fx.scope, "workspace", "q1", "Hi", &TurnMeta::default(), "running").await.unwrap();
        fx.core.pip_turn_begin(&fx.scope, "CA-1", "q2", "Hi", &TurnMeta::default(), "done").await.unwrap();
        fx.core.sign_out().await.unwrap();

        assert!(fx.core.pip_turn_finish(&fx.scope, "q1", "late", true, None, None, None).await.is_err());
        assert_eq!(request_ids(&fx, "general").await, ["q1"]);
        assert_eq!(request_ids(&fx, "CA-1").await, ["q2"]);
        let q1 = fx.core.pip_turns("general").await.unwrap().remove(0);
        assert_eq!(q1.text, "", "the late answer was not written");
        assert_eq!((q1.status.as_str(), q1.error.as_deref()), ("failed", Some(crate::db::SIGNED_OUT)), "a turn cut off is not left running");
        assert_eq!(fx.core.pip_turns("CA-1").await.unwrap()[0].status, "done");
    }

    #[tokio::test]
    async fn a_database_that_cannot_open_does_not_stop_signing_out() {
        let fx = crate::inbox::testing::fixture().await;
        fx.core.close_db();
        // Something that is not a database where the account's file should be.
        let path = fx.dir.join("inbox-site-me.sqlite");
        let _ = std::fs::remove_file(&path);
        std::fs::create_dir_all(&path).unwrap();
        assert!(fx.core.with_db_for(&fx.scope, |_| Ok(())).await.is_err(), "the broken file must really fail to open");

        fx.core.sign_out().await.unwrap();
        assert!(matches!(fx.core.with_db(|_| Ok(())).await, Err(crate::error::Error::NotSignedIn)), "the person is signed out");
    }
}
