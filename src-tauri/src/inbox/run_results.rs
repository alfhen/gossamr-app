//! What a finished run leaves behind for the person: the change it produced, and drafts they can approve.
//!
//! Everything here makes drafts only. The text in them is the agent's, so each draft says which run it came from
//! and the person reads and edits it like any other before anything is posted.

use super::Core;
use serde::Serialize;

use crate::domain::{CodeChange, CodeChangeKind, CreatedBy, Intent, ItemRef, LinkKind, Origin, Proposal, ProposalQuery, Run, RunKind, RunState, StateKind};
use crate::error::{Error, Result};
use crate::proposals::Draft;
use crate::runs::pr;
use crate::runs::result::{jira_note, ticket_keys, JiraNote};
use crate::tracker::{self, Connection};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOutcome {
    pub note: Option<JiraNote>,
    pub keys: Vec<String>,
    pub change: Option<CodeChange>,
}

fn refuse(message: impl Into<String>) -> Error {
    Error::Proposal(message.into())
}

fn intro(kind: RunKind) -> &'static str {
    match kind {
        RunKind::Investigate => "Looked into this with an agent (it was asked to only read code and change nothing).",
        _ => "An agent worked on this.",
    }
}

/// The comment as it is first drafted. The person edits it before posting.
pub fn comment_text(run: &Run, note: &JiraNote, change: Option<&CodeChange>) -> String {
    let mut parts = vec![intro(run.spec.kind).to_string()];
    if !note.from_marker {
        parts.push("The agent didn't mark anything for Jira, so this is its whole answer, shortened:".into());
    }
    parts.push(note.text.clone());
    if let Some(pull) = change.filter(|c| c.kind == CodeChangeKind::PullRequest) {
        parts.push(format!("Pull request: {}", pull.url));
    }
    parts.join("\n\n")
}

fn label_of(run: &Run) -> String {
    match &run.short_id {
        Some(short) => format!("From agent run {short}"),
        None => "From an agent run".into(),
    }
}

impl Core {
    fn change_of(&self, run: &Run) -> Result<Option<CodeChange>> {
        let branches = pr::branches_of(run);
        let mut found = Vec::new();
        for id in self.code.connection_ids() {
            let Some(repo) = self.watched_repos(&id)?.into_iter().find(|r| r.eq_ignore_ascii_case(&run.spec.repo)) else { continue };
            found.extend(self.with_code_db(&id, |db| db.code_changes_for_branch(&id, &repo, &branches))?);
        }
        Ok(pr::change_for(run, &found))
    }

    /// What the sheet shows about a run's result: the part meant for Jira, the tickets it names, and the pull request
    /// or branch it produced as far as a sync has cached them.
    pub async fn run_outcome(&self, id: &str) -> Result<RunOutcome> {
        let run = self.run(id).await?.ok_or_else(|| refuse("that run no longer exists"))?;
        let own = run.item.as_ref().map(|i| i.key.to_uppercase());
        let result = run.result.as_deref().map(str::trim).filter(|r| !r.is_empty());
        Ok(RunOutcome {
            note: result.map(jira_note),
            keys: result.map(ticket_keys).unwrap_or_default().into_iter().filter(|k| Some(k) != own.as_ref()).collect(),
            change: self.change_of(&run)?,
        })
    }

    async fn finished_run(&self, id: &str) -> Result<(Run, ItemRef)> {
        let run = self.run(id).await?.ok_or_else(|| refuse("that run no longer exists"))?;
        if run.state != RunState::Done {
            return Err(refuse("that run hasn't finished"));
        }
        let item = run.item.clone().ok_or_else(|| refuse("that run isn't about a ticket"))?;
        Ok((run, item))
    }

    /// Stores a draft the person made from a run's result, after checking the ticket is on the signed-in connection.
    async fn draft_from_run(&self, run: &Run, intent: Intent, label: String) -> Result<Proposal> {
        let scope = self.scope().await?;
        if intent.target().is_none_or(|t| t.connection_id != Connection::jira_id(&scope)) {
            return Err(refuse("that item belongs to another connection"));
        }
        let origin = Origin::Run { run_id: run.id.clone(), short_id: run.short_id.as_ref().map(ToString::to_string) };
        self.propose(&scope, Draft { origin, created_by: CreatedBy::User, intent, label: Some(label), basis: None }).await
    }

    async fn pending_same(&self, same: impl Fn(&Intent) -> bool) -> Result<Option<Proposal>> {
        let waiting = self.proposals(&ProposalQuery { states: Some(vec![StateKind::Pending]), ..Default::default() }).await?;
        Ok(waiting.into_iter().find(|p| same(&p.intent)))
    }

    /// A comment on the run's ticket made from the `For Jira:` part of its result. Built here, without Pip.
    pub async fn draft_run_comment(&self, id: &str) -> Result<Proposal> {
        let (run, item) = self.finished_run(id).await?;
        let note = jira_note(run.result.as_deref().unwrap_or(""));
        if note.text.is_empty() {
            return Err(refuse("the run finished without a written answer, so there is nothing to draft"));
        }
        let change = self.change_of(&run)?;
        let text = comment_text(&run, &note, change.as_ref());
        let body = tracker::comment_doc(&text, &[]);
        let same = |i: &Intent| matches!(i, Intent::Comment { item: it, body: b } if *it == item && b.plain_text() == body.plain_text());
        if let Some(existing) = self.pending_same(same).await? {
            return Err(refuse(format!("that comment is already waiting as a draft on {} (draft {})", item.key, existing.id)));
        }
        self.draft_from_run(&run, Intent::Comment { item, body }, label_of(&run)).await
    }

    /// A link saying the run's ticket is blocked by `blocker_key`. The blocker is the end that blocks, so it is the
    /// draft's `from`, and the draft shows on the blocker's ticket.
    pub async fn draft_run_blocker(&self, id: &str, blocker_key: &str) -> Result<Proposal> {
        let (run, item) = self.finished_run(id).await?;
        let key = blocker_key.trim().to_uppercase();
        if ticket_keys(&key) != [key.clone()] {
            return Err(refuse(format!("\"{}\" doesn't look like a ticket key", blocker_key.trim())));
        }
        if key.eq_ignore_ascii_case(&item.key) {
            return Err(refuse("a ticket can't block itself"));
        }
        let wanted = ItemRef { connection_id: item.connection_id.clone(), external_id: key.clone(), key: key.clone() };
        let blocker = self.cache_item(&wanted).await?.ok_or_else(|| refuse(format!("{key} wasn't found in Jira, so it can't be linked")))?.item;
        let same = |i: &Intent| matches!(i, Intent::Link { from, to, kind: LinkKind::Blocks } if *from == blocker && *to == item);
        if let Some(existing) = self.pending_same(same).await? {
            return Err(refuse(format!("that link is already waiting as a draft (draft {})", existing.id)));
        }
        let label = format!("Blocked by {key}");
        self.draft_from_run(&run, Intent::Link { from: blocker, to: item, kind: LinkKind::Blocks }, label).await
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::*;
    use crate::domain::fixtures::run_spec;
    use crate::domain::{CodeChangeState, RunSpec};
    use crate::inbox::testing::{fixture_watching, Fixture};

    const RESULT: &str = "The lag comes from one consumer.\n\nFor Jira:\nAdd a backoff to the consumer.";

    async fn run_with(fx: &Fixture, edit: impl FnOnce(&mut Run)) -> Run {
        let clone = fx.home.join("webshop");
        std::fs::create_dir_all(clone.join(".git")).unwrap();
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let name = format!("eng-1-fix-cart-{n:04x}");
        let spec = RunSpec { clone_path: clone, name, ..run_spec() };
        let p = fx.core.draft_run(spec, Some(fx.item("CA-1"))).await.unwrap();
        let digest = fx.core.runs_review(&p.id).await.unwrap().digest;
        let mut run = fx.core.runs_approve(&p.id, &digest).await.unwrap();
        run.state = RunState::Done;
        run.result = Some(RESULT.into());
        run.short_id = crate::runs::cli::ShortId::parse(&format!("ab12{n:04x}"));
        run.ended_at = Some(Utc::now());
        edit(&mut run);
        fx.core.save_run(&run).await.unwrap();
        run
    }

    async fn cache_change(fx: &Fixture, change: CodeChange) {
        fx.core.with_code_db("github:ann", |db| db.upsert_code_changes(&[change], "2026-09-29T00:00:00Z")).unwrap();
    }

    fn pull(n: u64, head: &str, state: CodeChangeState) -> CodeChange {
        let mut c = crate::codehost::links::tests::pr(n, head, "T", "");
        c.state = state;
        c
    }

    fn body_of(p: &Proposal) -> String {
        match &p.intent {
            Intent::Comment { body, .. } => body.plain_text(),
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn a_comment_is_drafted_from_the_for_jira_part_marked_as_from_the_run_and_nothing_is_posted() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = run_with(&fx, |_| {}).await;
        let p = fx.core.draft_run_comment(&run.id).await.unwrap();
        assert_eq!((p.state.clone(), p.created_by), (crate::domain::ProposalState::Pending, CreatedBy::User));
        assert_eq!(p.origin, Origin::Run { run_id: run.id.clone(), short_id: run.short_id.as_ref().map(ToString::to_string) });
        assert_eq!(p.label, Some(format!("From agent run {}", run.short_id.as_ref().unwrap())));
        assert_eq!(body_of(&p), "Looked into this with an agent (it was asked to only read code and change nothing).\nAdd a backoff to the consumer.");
        assert!(matches!(&p.intent, Intent::Comment { item, .. } if *item == fx.item("CA-1")));
        assert!(fx.tracker.intents().is_empty(), "a draft writes nothing");
    }

    #[tokio::test]
    async fn without_a_for_jira_section_the_draft_says_so() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = run_with(&fx, |r| r.result = Some("It is the rounding.".into())).await;
        let text = body_of(&fx.core.draft_run_comment(&run.id).await.unwrap());
        assert!(text.contains("didn't mark anything for Jira") && text.ends_with("It is the rounding."), "{text}");
    }

    #[tokio::test]
    async fn the_pull_request_link_is_added_only_when_a_cached_pull_request_has_the_runs_branch() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = run_with(&fx, |_| {}).await;
        cache_change(&fx, pull(7, "unrelated", CodeChangeState::Open)).await;
        assert!(!body_of(&fx.core.draft_run_comment(&run.id).await.unwrap()).contains("Pull request"));

        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = run_with(&fx, |_| {}).await;
        cache_change(&fx, pull(7, &format!("worktree-{}", run.spec.name), CodeChangeState::Open)).await;
        let text = body_of(&fx.core.draft_run_comment(&run.id).await.unwrap());
        assert!(text.ends_with("Pull request: https://github.com/acme/webshop/pull/7"), "{text}");
        assert_eq!(fx.core.run_outcome(&run.id).await.unwrap().change.unwrap().number, Some(7));
    }

    #[tokio::test]
    async fn a_pull_request_in_an_unwatched_repository_is_not_matched() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = run_with(&fx, |r| r.spec.repo = "acme/gateway".into()).await;
        let mut c = pull(7, &format!("worktree-{}", run.spec.name), CodeChangeState::Open);
        c.repo = "acme/gateway".into();
        cache_change(&fx, c).await;
        assert_eq!(fx.core.run_outcome(&run.id).await.unwrap().change, None);
    }

    #[tokio::test]
    async fn drafting_is_refused_unless_the_run_is_done_has_a_ticket_and_an_answer() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let working = run_with(&fx, |r| r.state = RunState::Working).await;
        assert!(fx.core.draft_run_comment(&working.id).await.unwrap_err().to_string().contains("hasn't finished"));
        assert!(fx.core.draft_run_blocker(&working.id, "CA-2").await.is_err());

        let fx = fixture_watching(&["acme/webshop"]).await;
        let blank = run_with(&fx, |r| r.result = Some(" \n".into())).await;
        assert!(fx.core.draft_run_comment(&blank.id).await.unwrap_err().to_string().contains("nothing to draft"));
        let none = run_with(&fx, |r| r.result = None).await;
        assert!(fx.core.draft_run_comment(&none.id).await.is_err());

        let fx = fixture_watching(&["acme/webshop"]).await;
        let no_ticket = run_with(&fx, |r| r.item = None).await;
        assert!(fx.core.draft_run_comment(&no_ticket.id).await.unwrap_err().to_string().contains("isn't about a ticket"));
        assert!(fx.core.draft_run_comment("missing").await.is_err());
        assert!(fx.core.proposals(&ProposalQuery::default()).await.unwrap().iter().all(|p| !matches!(p.intent, Intent::Comment { .. })));
    }

    #[tokio::test]
    async fn a_run_of_another_connection_cannot_draft_here() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = run_with(&fx, |r| r.item.as_mut().unwrap().connection_id = "elsewhere".into()).await;
        let err = fx.core.draft_run_comment(&run.id).await.unwrap_err();
        assert!(err.to_string().contains("another connection"), "{err}");
        assert!(fx.core.proposals(&ProposalQuery::default()).await.unwrap().iter().all(|p| !matches!(p.intent, Intent::Comment { .. })));
    }

    #[tokio::test]
    async fn the_same_comment_is_not_drafted_twice_while_the_first_waits() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = run_with(&fx, |_| {}).await;
        let first = fx.core.draft_run_comment(&run.id).await.unwrap();
        let err = fx.core.draft_run_comment(&run.id).await.unwrap_err();
        assert!(err.to_string().contains(&first.id), "{err}");
        fx.core.skip_proposal(&first.id).await.unwrap();
        assert!(fx.core.draft_run_comment(&run.id).await.is_ok(), "once it is decided a new one may be drafted");
    }

    #[tokio::test]
    async fn a_blocker_draft_links_the_blocking_ticket_to_the_runs_ticket_and_applies_nothing() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        fx.add_item(2).await;
        let run = run_with(&fx, |_| {}).await;
        let p = fx.core.draft_run_blocker(&run.id, " ca-2 ").await.unwrap();
        assert!(matches!(&p.intent, Intent::Link { from, to, kind: LinkKind::Blocks } if *from == fx.item("CA-2") && *to == fx.item("CA-1")));
        assert_eq!((p.label.as_deref(), p.created_by), (Some("Blocked by CA-2"), CreatedBy::User));
        assert_eq!(p.origin, Origin::Run { run_id: run.id.clone(), short_id: run.short_id.as_ref().map(ToString::to_string) });
        assert!(fx.tracker.intents().is_empty());
        let err = fx.core.draft_run_blocker(&run.id, "CA-2").await.unwrap_err();
        assert!(err.to_string().contains(&p.id), "{err}");
    }

    #[tokio::test]
    async fn a_blocker_must_look_like_a_ticket_and_not_be_the_runs_own() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = run_with(&fx, |_| {}).await;
        for bad in ["", "not a key", "CA-1", "ca-1", "CA-2 CA-3", "CA-"] {
            assert!(fx.core.draft_run_blocker(&run.id, bad).await.is_err(), "{bad:?}");
        }
        assert!(fx.core.proposals(&ProposalQuery::default()).await.unwrap().iter().all(|p| !matches!(p.intent, Intent::Link { .. })));
    }

    #[tokio::test]
    async fn the_outcome_offers_the_note_and_the_other_tickets_the_result_names() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = run_with(&fx, |r| r.result = Some("Blocked by CA-9, related to CA-1.\n\nFor Jira: waiting on CA-9 and CA-12.".into())).await;
        let outcome = fx.core.run_outcome(&run.id).await.unwrap();
        assert_eq!(outcome.keys, ["CA-9", "CA-12"], "the run's own ticket is not offered");
        assert_eq!(outcome.note.unwrap(), JiraNote { text: "waiting on CA-9 and CA-12.".into(), from_marker: true });
        let empty = run_with(&fx, |r| r.result = None).await;
        assert_eq!(fx.core.run_outcome(&empty.id).await.unwrap().note, None);
    }
}
