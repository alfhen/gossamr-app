//! Core's proposals service: stores drafts in the signed-in connection's database and is the only caller of
//! `WorkTracker::apply` on behalf of an approval.

use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::Deserialize;

use super::{db_file, identity_of, Core};
use crate::auth::Scope;
use crate::db::Db;
use crate::domain::{
    ticket_snapshot, Basis, ContainerRef, CreatedBy, Doc, Intent, ItemKind, ItemRef, Origin, Proposal, ProposalQuery, ProposalState, Run, RunKind,
    RunQuery, RunReview, RunSpec, INVESTIGATE_INSTRUCTION,
};
use crate::error::{Error, Result};
use crate::model::MentionRef;
use crate::proposals::{self, Draft};
use crate::tracker;

/// A person's change to a draft, in the terms the editor works in.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Edit {
    Comment {
        body: String,
        #[serde(default)]
        mentions: Vec<MentionRef>,
        /// The comment being answered, quoted after the first paragraph.
        #[serde(default)]
        quote: Option<String>,
    },
    Subtasks {
        summaries: Vec<String>,
    },
    /// A new item's fields; the ones left out stay as they are.
    Create {
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        body: Option<String>,
        #[serde(default)]
        mentions: Vec<MentionRef>,
        #[serde(default)]
        kind: Option<ItemKind>,
        #[serde(default)]
        container: Option<ContainerRef>,
    },
    /// A run's settings; the ones left out stay as they are. Only the person edits these.
    #[serde(rename_all = "camelCase")]
    Run {
        #[serde(default)]
        instruction: Option<String>,
        #[serde(default)]
        base: Option<String>,
        #[serde(default)]
        clone_path: Option<PathBuf>,
        #[serde(default)]
        kind: Option<RunKind>,
        #[serde(default)]
        name: Option<String>,
    },
}

impl Edit {
    fn apply_to(&self, current: &Intent) -> Result<Intent> {
        match (self, current) {
            (Edit::Comment { body, mentions, quote }, Intent::Comment { item, .. }) => {
                let people: Vec<_> = mentions
                    .iter()
                    .map(|m| (crate::domain::PersonRef { connection_id: item.connection_id.clone(), account_id: m.account_id.clone() }, m.name.clone()))
                    .collect();
                let doc = tracker::comment_doc(body.trim(), &people);
                let doc = match quote.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
                    Some(q) => doc.with_quote_after_first(q),
                    None => doc,
                };
                Ok(Intent::Comment { item: item.clone(), body: doc })
            }
            (Edit::Subtasks { summaries }, Intent::Subtasks { parent, .. }) => Ok(Intent::Subtasks {
                parent: parent.clone(),
                summaries: summaries.iter().map(|s| s.trim().to_string()).collect(),
            }),
            (Edit::Create { title, body, mentions, kind, container }, Intent::Create { container: was, fields, link }) => {
                let container = container.clone().unwrap_or_else(|| was.clone());
                if container.connection_id != was.connection_id {
                    return Err(Error::Proposal("a new item can't move to another connection".into()));
                }
                let mut fields = fields.clone();
                if let Some(title) = title {
                    fields.title = title.trim().to_string();
                }
                if let Some(body) = body {
                    let people: Vec<_> = mentions
                        .iter()
                        .map(|m| (crate::domain::PersonRef { connection_id: container.connection_id.clone(), account_id: m.account_id.clone() }, m.name.clone()))
                        .collect();
                    fields.body = Doc::from_text(body.trim(), &people);
                }
                if let Some(kind) = kind {
                    fields.kind = *kind;
                }
                Ok(Intent::Create { container, fields, link: link.clone() })
            }
            (Edit::Run { instruction, base, clone_path, kind, name }, Intent::StartRun { connection_id, item, spec }) => {
                let mut spec = spec.clone();
                if let Some(v) = instruction {
                    spec.instruction = v.clone();
                }
                if let Some(v) = base {
                    spec.base = v.trim().to_string();
                }
                if let Some(v) = clone_path {
                    spec.clone_path = v.clone();
                }
                if let Some(v) = kind {
                    spec.kind = *v;
                }
                if let Some(v) = name {
                    spec.name = v.trim().to_string();
                }
                Ok(Intent::StartRun { connection_id: connection_id.clone(), item: item.clone(), spec })
            }
            _ => Err(Error::Proposal("that edit doesn't fit this draft".into())),
        }
    }
}

fn not_a_run() -> Error {
    Error::Proposal("that draft doesn't start a run".into())
}

fn run_of(p: &Proposal) -> Result<(&String, &Option<ItemRef>, &RunSpec)> {
    match &p.intent {
        Intent::StartRun { connection_id, item, spec } => Ok((connection_id, item, spec)),
        _ => Err(not_a_run()),
    }
}

impl Core {
    /// Stores a draft for `scope`'s connection, noting how its item looks now so a later sync can tell what changed.
    pub async fn propose(&self, scope: &Scope, mut draft: Draft) -> Result<Proposal> {
        let at = Utc::now();
        self.with_db_for(scope, |db| {
            if draft.basis.is_none() {
                if let Some(target) = draft.intent.target() {
                    draft.basis = db.item(target)?.as_ref().map(Basis::of);
                }
            }
            proposals::create(db, draft, at)
        })
        .await
    }

    /// A draft the person made themselves, such as dropping a card on a board column. Nothing is written until it is
    /// approved. Only an existing item of the signed-in connection can be the target, or a project of it for a new item.
    pub async fn draft_as_user(&self, intent: Intent, label: Option<String>) -> Result<Proposal> {
        let scope = self.scope().await?;
        let connection_id = tracker::Connection::jira_id(&scope);
        if matches!(intent, Intent::StartRun { .. }) {
            return Err(Error::Proposal("a run is drafted with its own command".into()));
        }
        let drafted_in = match &intent {
            Intent::Create { container, .. } => &container.connection_id,
            other => &other.target().ok_or_else(|| Error::Proposal("a draft made by hand has to be about an existing item".into()))?.connection_id,
        };
        if *drafted_in != connection_id {
            return Err(Error::Proposal("that item belongs to another connection".into()));
        }
        let draft = Draft { origin: Origin::Board, created_by: CreatedBy::User, intent, label, basis: None };
        self.propose(&scope, draft).await
    }

    async fn with_proposals<T>(&self, f: impl FnOnce(&Db) -> Result<T>) -> Result<T> {
        let scope = self.scope().await?;
        self.with_db_for(&scope, f).await
    }

    pub async fn proposals(&self, query: &ProposalQuery) -> Result<Vec<Proposal>> {
        self.with_proposals(|db| db.proposals(query)).await
    }

    /// Drafts in `scope`'s connection, for the assistant's tools.
    pub async fn proposals_in(&self, scope: &Scope, query: &ProposalQuery) -> Result<Vec<Proposal>> {
        self.with_db_for(scope, |db| db.proposals(query)).await
    }

    pub async fn proposal_in(&self, scope: &Scope, id: &str) -> Result<Option<Proposal>> {
        self.with_db_for(scope, |db| db.proposal(id)).await
    }

    /// Pip's own change to one of its pending drafts. Anyone else's, and anything already decided, is refused here
    /// whatever the caller checked.
    pub async fn revise_as_pip(&self, scope: &Scope, id: &str, intent: Intent) -> Result<Proposal> {
        self.with_db_for(scope, |db| {
            proposals::require_pip_pending(&db.proposal(id)?.ok_or_else(|| Error::Proposal("that draft no longer exists".into()))?)?;
            proposals::edit_noted(db, id, intent, "Revised by Pip", Utc::now())
        })
        .await
    }

    pub async fn retire_as_pip(&self, scope: &Scope, id: &str, reason: &str) -> Result<Proposal> {
        self.with_db_for(scope, |db| {
            proposals::require_pip_pending(&db.proposal(id)?.ok_or_else(|| Error::Proposal("that draft no longer exists".into()))?)?;
            proposals::retire(db, id, reason, Utc::now())
        })
        .await
    }

    pub async fn proposal(&self, id: &str) -> Result<Option<Proposal>> {
        self.with_proposals(|db| db.proposal(id)).await
    }

    pub async fn edit_proposal(&self, id: &str, edit: &Edit) -> Result<Proposal> {
        self.with_proposals(|db| {
            let current = db.proposal(id)?.ok_or_else(|| Error::Proposal("that draft no longer exists".into()))?;
            let mut intent = edit.apply_to(&current.intent)?;
            if let (Edit::Run { clone_path: Some(_), .. }, Intent::StartRun { spec, .. }) = (edit, &mut intent) {
                spec.clone_path = self.resolve_clone(&spec.clone_path)?;
            }
            proposals::edit(db, id, intent, Utc::now())
        })
        .await
    }

    pub async fn skip_proposal(&self, id: &str) -> Result<Proposal> {
        self.with_proposals(|db| proposals::skip(db, id, Utc::now())).await
    }

    /// The clone as the run will use it: an existing folder with a `.git`, under the person's home, by its real path.
    fn resolve_clone(&self, path: &Path) -> Result<PathBuf> {
        let refused = |why: &str| Error::Proposal(format!("{} {why}", path.display()));
        let real = path.canonicalize().map_err(|_| refused("isn't a folder that exists"))?;
        if !real.is_dir() || !real.join(".git").exists() {
            return Err(refused("isn't a git clone"));
        }
        match &self.home {
            Some(home) if real.starts_with(home) && real != *home => Ok(real),
            _ => Err(refused("isn't inside your home folder")),
        }
    }

    /// Agents work only in repositories the person watches, whoever drafted the run.
    pub(crate) fn require_watched_repo(&self, repo: &str) -> Result<()> {
        if self.watched_code_repos()?.iter().any(|(_, r)| r.eq_ignore_ascii_case(repo)) {
            Ok(())
        } else {
            Err(Error::Proposal(format!("{repo} isn't a repository you watch. Watch it in Settings first.")))
        }
    }

    /// A run the person drafted by hand. The ticket text is taken from the cache here, never from the caller. Nothing
    /// starts until `runs_approve`.
    pub async fn draft_run(&self, mut spec: RunSpec, item: Option<ItemRef>) -> Result<Proposal> {
        let scope = self.scope().await?;
        let connection_id = tracker::Connection::jira_id(&scope);
        if item.as_ref().is_some_and(|i| i.connection_id != connection_id) {
            return Err(Error::Proposal("that item belongs to another connection".into()));
        }
        self.require_watched_repo(&spec.repo)?;
        spec.clone_path = self.resolve_clone(&spec.clone_path)?;
        if spec.instruction.trim().is_empty() {
            spec.instruction = INVESTIGATE_INSTRUCTION.into();
        }
        let intent = self
            .with_db_for(&scope, |db| {
                spec.ticket_block = item.as_ref().map(|i| db.item(i)).transpose()?.flatten().map(|w| ticket_snapshot(&w));
                Ok(Intent::StartRun { connection_id: connection_id.clone(), item: item.clone(), spec })
            })
            .await?;
        let draft = Draft { origin: Origin::Board, created_by: CreatedBy::User, intent, label: None, basis: None };
        self.propose(&scope, draft).await
    }

    /// What would run if the draft were approved now. While the draft is pending, the ticket text is re-read from
    /// the cache and a change is stored as a revision, so the digest returned is of the text shown.
    pub async fn runs_review(&self, id: &str) -> Result<RunReview> {
        self.with_proposals(|db| {
            let mut p = db.proposal(id)?.ok_or_else(|| Error::Proposal("that draft no longer exists".into()))?;
            let (connection_id, item, spec) = run_of(&p)?;
            if p.state == ProposalState::Pending {
                if let Some(work) = item.as_ref().map(|i| db.item(i)).transpose()?.flatten() {
                    let fresh = Some(ticket_snapshot(&work));
                    if fresh != spec.ticket_block {
                        let intent = Intent::StartRun {
                            connection_id: connection_id.clone(),
                            item: item.clone(),
                            spec: RunSpec { ticket_block: fresh, ..spec.clone() },
                        };
                        p = proposals::edit_noted(db, id, intent, "Ticket text updated", Utc::now())?;
                    }
                }
            }
            Ok(RunReview::of(run_of(&p)?.2))
        })
        .await
    }

    /// Approves a run draft: the proposal becomes applied and a queued run exists, in one transaction. `digest` is
    /// what the person read in `runs_review`; a draft that changed since is refused. Starting the run is the
    /// caller's next step.
    pub async fn runs_approve(&self, id: &str, digest: &str) -> Result<Run> {
        let scope = self.scope().await?;
        let file = db_file(&self.connection(&scope)?);
        self.with_db_for(&scope, |db| {
            let p = db.proposal(id)?.ok_or_else(|| Error::Proposal("that draft no longer exists".into()))?;
            let (connection_id, item, spec) = run_of(&p)?;
            self.require_watched_repo(&spec.repo)?;
            // A draft from Pip isn't resolved when it is stored, and a path through a symlink can be repointed.
            if self.resolve_clone(&spec.clone_path)? != spec.clone_path {
                return Err(Error::Proposal("the clone path isn't its real path; edit the draft and review it again".into()));
            }
            let (connection_id, item, spec) = (connection_id.clone(), item.clone(), spec.clone());
            let run_id = proposals::new_id()?;
            db.approve_start_run(id, digest, |p| Run::queued(run_id, p.id.clone(), connection_id, item, spec, file, Utc::now()))
        })
        .await
    }

    pub async fn runs_list(&self, query: &RunQuery) -> Result<Vec<Run>> {
        self.with_proposals(|db| db.runs(query)).await
    }

    pub async fn run(&self, id: &str) -> Result<Option<Run>> {
        self.with_proposals(|db| db.run(id)).await
    }

    /// Stores a run's new state. Only the run service writes runs after approval.
    pub async fn save_run(&self, run: &Run) -> Result<()> {
        let stored = self.with_proposals(|db| db.save_run(run)).await?;
        if stored {
            Ok(())
        } else {
            Err(Error::Proposal("that run no longer exists".into()))
        }
    }

    /// Applies a pending proposal through its connection's tracker. Whatever the tracker did is recorded: a failed
    /// attempt returns the proposal to pending with `error` set and the subtasks it did create remembered, so
    /// approving again never repeats them.
    pub async fn approve_proposal(&self, id: &str) -> Result<Proposal> {
        let scope = self.scope().await?;
        let tracker = self.tracker(&scope)?;
        let claimed = self.with_db_for(&scope, |db| proposals::begin(db, id, Utc::now())).await?;
        let outcome = proposals::execute(tracker.as_ref(), &claimed).await;
        let wrote = outcome.error.is_none() || !outcome.created.is_empty();
        let done = self.with_db_for(&scope, |db| proposals::finish(db, id, outcome, Utc::now())).await?;
        if wrote {
            match done.target() {
                Some(item) => self.after_write(&scope, &item.key).await,
                None => self.wake.notify_one(),
            }
        }
        // The write went through; a failure to re-judge the other drafts must not read as a failed approval.
        let _ = self.reconcile_proposals(&scope).await;
        debug_assert!(done.state != ProposalState::Applying);
        Ok(done)
    }

    /// Re-judges pending drafts against the cache. Returns how many were revised or retired.
    pub async fn reconcile_proposals(&self, scope: &Scope) -> Result<usize> {
        let (site, me) = self.identity().await?;
        let connection_id = tracker::Connection::jira_id(&Scope::of(&site, &me));
        let identity = identity_of(&connection_id, &me);
        self.with_db_for(scope, |db| proposals::reconcile_pending(db, &identity, Utc::now())).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::fixtures::item_ref;
    use crate::domain::{Block, Doc};

    #[tokio::test]
    async fn a_hand_made_draft_is_pending_by_the_user_and_writes_nothing() {
        let fx = crate::inbox::testing::fixture().await;
        let intent = Intent::Transition { item: fx.item("CA-1"), to: "10001".into() };
        let p = fx.core.draft_as_user(intent.clone(), Some("Done".into())).await.unwrap();
        assert_eq!((p.created_by, p.origin.clone(), p.state.clone()), (CreatedBy::User, Origin::Board, ProposalState::Pending));
        assert_eq!(p.label.as_deref(), Some("Done"));
        assert_eq!(p.basis.as_ref().map(|b| b.item.clone()), Some(fx.item("CA-1")), "the basis is noted so a sync can revise it");
        assert!(fx.tracker.intents().is_empty());
        assert_eq!(fx.core.proposals(&ProposalQuery::default()).await.unwrap(), vec![p]);
    }

    #[tokio::test]
    async fn a_hand_made_draft_is_refused_when_blank_foreign_or_not_about_an_item() {
        let fx = crate::inbox::testing::fixture().await;
        let blank = Intent::Transition { item: fx.item("CA-1"), to: " ".into() };
        assert!(fx.core.draft_as_user(blank, None).await.is_err());
        let mut foreign = fx.item("CA-1");
        foreign.connection_id = "elsewhere".into();
        let err = fx.core.draft_as_user(Intent::Transition { item: foreign, to: "1".into() }, None).await.unwrap_err();
        assert!(err.to_string().contains("another connection"), "{err}");
        assert!(fx.core.proposals(&ProposalQuery::default()).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_hand_made_new_item_draft_is_pending_and_stays_in_its_connection() {
        use crate::domain::{ContainerRef, ItemKind, NewItem};
        let fx = crate::inbox::testing::fixture().await;
        let fields = |title: &str| NewItem { title: title.into(), body: Doc::default(), kind: ItemKind::Task, assignee: None, parent: None, priority: None, labels: vec![] };
        let container = |connection: &str| ContainerRef { connection_id: connection.into(), external_id: "10000".into() };
        let here = fx.item("CA-1").connection_id;

        let p = fx.core.draft_as_user(Intent::Create { container: container(&here), fields: fields("Rotate keys"), link: None }, None).await.unwrap();
        assert_eq!((p.created_by, p.state.clone()), (CreatedBy::User, ProposalState::Pending));
        assert!(fx.tracker.intents().is_empty());

        let elsewhere = fx.core.draft_as_user(Intent::Create { container: container("elsewhere"), fields: fields("x"), link: None }, None).await;
        assert!(elsewhere.unwrap_err().to_string().contains("another connection"));
        assert!(fx.core.draft_as_user(Intent::Create { container: container(&here), fields: fields(" "), link: None }, None).await.is_err());
    }

    #[tokio::test]
    async fn approving_a_dropped_card_applies_the_status_id_through_the_tracker() {
        let fx = crate::inbox::testing::fixture().await;
        fx.tracker.moves.lock().unwrap().push(tracker::Move {
            name: "Finish".into(),
            to: crate::domain::StatusDef { id: "10001".into(), name: "Done".into(), category: crate::domain::Category::Done },
        });
        let offered = fx.core.cache_transitions(&fx.item("CA-1")).await.unwrap();
        assert_eq!(offered[0].to.id, "10001");

        let drafted = fx.core.draft_as_user(Intent::Transition { item: fx.item("CA-1"), to: offered[0].to.id.clone() }, Some("Done".into())).await.unwrap();
        assert!(fx.tracker.intents().is_empty(), "a draft writes nothing");
        let done = fx.core.approve_proposal(&drafted.id).await.unwrap();
        assert_eq!(done.state, ProposalState::Applied);
        assert_eq!(fx.tracker.intents(), vec![Intent::Transition { item: fx.item("CA-1"), to: "10001".into() }]);
    }

    #[tokio::test]
    async fn a_failed_approval_returns_the_draft_to_pending_with_the_reason() {
        let fx = crate::inbox::testing::fixture().await;
        let drafted = fx.core.draft_as_user(Intent::Transition { item: fx.item("CA-1"), to: "10001".into() }, None).await.unwrap();
        fx.tracker.will(Err(Error::Api { status: 400, message: "can't move there".into() }));
        let back = fx.core.approve_proposal(&drafted.id).await.unwrap();
        assert_eq!(back.state, ProposalState::Pending);
        assert!(back.error.as_deref().is_some_and(|e| e.contains("can't move there")));
    }

    #[test]
    fn a_comment_edit_links_the_mentions_it_names() {
        let current = Intent::Comment { item: item_ref("1"), body: Doc::paragraph("old") };
        let edit = Edit::Comment { body: " Thanks @Sam ".into(), mentions: vec![MentionRef { account_id: "sam".into(), name: "Sam".into() }], quote: None };
        let Intent::Comment { item, body } = edit.apply_to(&current).unwrap() else { panic!() };
        assert_eq!(item, item_ref("1"));
        assert_eq!(body.plain_text(), "Thanks @Sam");
        let has_mention = |d: &Doc| format!("{d:?}").contains("Mention");
        assert!(has_mention(&body));
    }

    #[test]
    fn a_reply_edit_quotes_the_original_between_the_mention_and_the_answer() {
        let current = Intent::Comment { item: item_ref("1"), body: Doc::paragraph("old") };
        let edit: Edit = serde_json::from_str(
            r#"{"type":"comment","body":"@Sam\n\nAgreed, will do.","mentions":[{"accountId":"sam","name":"Sam"}],"quote":" Ready for another look "}"#,
        )
        .unwrap();
        let Intent::Comment { body, .. } = edit.apply_to(&current).unwrap() else { panic!() };
        let [Block::Paragraph { content: lead }, Block::Quote { content: quoted }, Block::Paragraph { .. }] = body.blocks.as_slice() else { panic!("{:?}", body.blocks) };
        assert!(matches!(lead[0], crate::domain::Inline::Mention { .. }));
        assert_eq!(Doc { blocks: quoted.clone() }.plain_text(), "Ready for another look");
        assert!(body.plain_text().ends_with("Agreed, will do."));
    }

    #[test]
    fn a_single_paragraph_reply_still_ends_with_the_quote() {
        let current = Intent::Comment { item: item_ref("1"), body: Doc::paragraph("old") };
        let edit = Edit::Comment { body: "Thanks".into(), mentions: vec![], quote: Some("q".into()) };
        let Intent::Comment { body, .. } = edit.apply_to(&current).unwrap() else { panic!() };
        assert!(matches!(body.blocks.as_slice(), [Block::Paragraph { .. }, Block::Quote { .. }]));
    }

    #[test]
    fn an_edit_of_the_wrong_kind_is_refused() {
        let current = Intent::Transition { item: item_ref("1"), to: "done".into() };
        assert!(Edit::Subtasks { summaries: vec!["a".into()] }.apply_to(&current).is_err());
    }

    #[test]
    fn a_create_edit_changes_only_the_fields_it_names() {
        use crate::domain::NewItem;
        let at = |id: &str| ContainerRef { connection_id: "c".into(), external_id: id.into() };
        let fields = NewItem { title: "Old".into(), body: Doc::paragraph("keep"), kind: ItemKind::Task, assignee: None, parent: None, priority: None, labels: vec!["x".into()] };
        let current = Intent::Create { container: at("1"), fields, link: None };

        let edit: Edit = serde_json::from_str(r#"{"type":"create","title":" New ","kind":"bug","container":{"connectionId":"c","externalId":"2"}}"#).unwrap();
        let Intent::Create { container, fields, .. } = edit.apply_to(&current).unwrap() else { panic!() };
        assert_eq!((container, fields.title.as_str(), fields.kind, fields.body.plain_text().as_str(), fields.labels.len()), (at("2"), "New", ItemKind::Bug, "keep", 1));

        let body: Edit = serde_json::from_str(r#"{"type":"create","body":" Fresh text "}"#).unwrap();
        let Intent::Create { fields, .. } = body.apply_to(&current).unwrap() else { panic!() };
        assert_eq!(fields.body.plain_text(), "Fresh text");

        let elsewhere = Edit::Create { title: None, body: None, mentions: vec![], kind: None, container: Some(ContainerRef { connection_id: "other".into(), external_id: "1".into() }) };
        assert!(elsewhere.apply_to(&current).is_err());
        assert!(Edit::Create { title: None, body: None, mentions: vec![], kind: None, container: None }.apply_to(&Intent::Transition { item: item_ref("1"), to: "d".into() }).is_err());
    }

    #[test]
    fn edits_read_the_way_the_page_sends_them() {
        let edit: Edit = serde_json::from_str(r#"{"type":"comment","body":"hi","mentions":[{"accountId":"a","name":"A"}]}"#).unwrap();
        assert!(matches!(edit, Edit::Comment { mentions, .. } if mentions.len() == 1));
        assert!(matches!(serde_json::from_str::<Edit>(r#"{"type":"subtasks","summaries":["x"]}"#).unwrap(), Edit::Subtasks { .. }));
    }

    fn clone_in(fx: &crate::inbox::testing::Fixture, name: &str) -> PathBuf {
        let path = fx.home.join(name);
        std::fs::create_dir_all(path.join(".git")).unwrap();
        path
    }

    fn spec_in(clone: &Path) -> RunSpec {
        RunSpec { clone_path: clone.to_path_buf(), ..crate::domain::fixtures::run_spec() }
    }

    async fn drafted_run(fx: &crate::inbox::testing::Fixture) -> Proposal {
        let clone = clone_in(fx, "webshop");
        fx.core.draft_run(spec_in(&clone), Some(fx.item("CA-1"))).await.unwrap()
    }

    fn spec_of(p: &Proposal) -> RunSpec {
        match &p.intent {
            Intent::StartRun { spec, .. } => spec.clone(),
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn a_run_draft_is_pending_by_the_user_takes_its_ticket_text_from_the_cache_and_starts_nothing() {
        let fx = crate::inbox::testing::fixture_watching(&["acme/webshop"]).await;
        let clone = clone_in(&fx, "webshop");
        let mut spec = spec_in(&clone);
        spec.ticket_block = Some("forged by the caller".into());
        spec.instruction = " ".into();
        let p = fx.core.draft_run(spec, Some(fx.item("CA-1"))).await.unwrap();

        assert_eq!((p.created_by, p.origin.clone(), p.state.clone()), (CreatedBy::User, Origin::Board, ProposalState::Pending));
        let spec = spec_of(&p);
        assert!(spec.ticket_block.as_deref().unwrap().starts_with("CA-1: Ticket 1"));
        assert_eq!(spec.instruction, INVESTIGATE_INSTRUCTION);
        assert_eq!(spec.clone_path, clone.canonicalize().unwrap());
        assert!(fx.tracker.intents().is_empty());
        assert!(fx.core.runs_list(&RunQuery::default()).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_run_draft_needs_a_real_clone_inside_home_and_an_item_of_this_connection() {
        let fx = crate::inbox::testing::fixture_watching(&["acme/webshop"]).await;
        let no_git = fx.home.join("plain");
        std::fs::create_dir_all(&no_git).unwrap();
        let outside = std::env::temp_dir().join(format!("gossamr-outside-{}", std::process::id()));
        std::fs::create_dir_all(outside.join(".git")).unwrap();
        let clone = clone_in(&fx, "webshop");

        for bad in [fx.home.join("missing"), no_git, outside.clone(), fx.home.clone()] {
            assert!(fx.core.draft_run(spec_in(&bad), None).await.is_err(), "{bad:?}");
        }
        let mut foreign = fx.item("CA-1");
        foreign.connection_id = "elsewhere".into();
        let err = fx.core.draft_run(spec_in(&clone), Some(foreign)).await.unwrap_err();
        assert!(err.to_string().contains("another connection"), "{err}");
        assert!(fx.core.proposals(&ProposalQuery::default()).await.unwrap().is_empty());
        std::fs::remove_dir_all(outside).unwrap();
    }

    #[tokio::test]
    async fn a_symlink_out_of_home_does_not_pass_as_a_clone_in_it() {
        let fx = crate::inbox::testing::fixture_watching(&["acme/webshop"]).await;
        let outside = std::env::temp_dir().join(format!("gossamr-link-{}", std::process::id()));
        std::fs::create_dir_all(outside.join(".git")).unwrap();
        let link = fx.home.join("link");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(fx.core.draft_run(spec_in(&link), None).await.is_err());
        std::fs::remove_dir_all(outside).unwrap();
    }

    #[tokio::test]
    async fn the_page_cannot_draft_a_run_through_the_generic_command() {
        let fx = crate::inbox::testing::fixture_watching(&["acme/webshop"]).await;
        let intent = Intent::StartRun { connection_id: fx.item("CA-1").connection_id, item: Some(fx.item("CA-1")), spec: crate::domain::fixtures::run_spec() };
        let err = fx.core.draft_as_user(intent, None).await.unwrap_err();
        assert!(err.to_string().contains("own command"), "{err}");
        assert!(fx.core.proposals(&ProposalQuery::default()).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_generic_approval_refuses_a_run_draft_without_calling_the_tracker() {
        let fx = crate::inbox::testing::fixture_watching(&["acme/webshop"]).await;
        let p = drafted_run(&fx).await;
        let err = fx.core.approve_proposal(&p.id).await.unwrap_err();
        assert!(err.to_string().contains("own button"), "{err}");
        assert!(fx.tracker.intents().is_empty());
        assert_eq!(fx.core.proposal(&p.id).await.unwrap().unwrap().state, ProposalState::Pending);
        assert!(fx.core.runs_list(&RunQuery::default()).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn review_shows_the_prompt_and_its_digest_and_approving_with_that_digest_queues_one_run() {
        let fx = crate::inbox::testing::fixture_watching(&["acme/webshop"]).await;
        let p = drafted_run(&fx).await;
        let review = fx.core.runs_review(&p.id).await.unwrap();
        assert_eq!(review.prompt, crate::domain::render_prompt(&review.spec));
        assert_eq!(review.digest, review.spec.digest());
        assert!(review.prompt.contains("CA-1: Ticket 1"));

        let run = fx.core.runs_approve(&p.id, &review.digest).await.unwrap();
        assert_eq!((run.state, run.connection_id.clone()), (crate::domain::RunState::Queued, fx.item("CA-1").connection_id));
        assert_eq!(run.item, Some(fx.item("CA-1")));
        assert!(run.db_file.starts_with("inbox-") && run.db_file.ends_with(".sqlite"));
        let stored = fx.core.proposal(&p.id).await.unwrap().unwrap();
        assert_eq!((stored.state, stored.run), (ProposalState::Applied, Some(run.id.clone())));
        assert_eq!(fx.core.run(&run.id).await.unwrap().unwrap(), run);
        assert_eq!(fx.core.runs_list(&RunQuery { item: Some(fx.item("CA-1")), ..Default::default() }).await.unwrap().len(), 1);
        assert!(fx.tracker.intents().is_empty());
    }

    #[tokio::test]
    async fn a_second_approval_of_the_same_draft_fails_and_makes_no_second_run() {
        let fx = crate::inbox::testing::fixture_watching(&["acme/webshop"]).await;
        let p = drafted_run(&fx).await;
        let digest = fx.core.runs_review(&p.id).await.unwrap().digest;
        let (a, b) = tokio::join!(fx.core.runs_approve(&p.id, &digest), fx.core.runs_approve(&p.id, &digest));
        assert_eq!([a.is_ok(), b.is_ok()].iter().filter(|ok| **ok).count(), 1);
        assert_eq!(fx.core.runs_list(&RunQuery::default()).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn an_edit_after_reading_changes_the_digest_and_the_old_one_is_refused() {
        let fx = crate::inbox::testing::fixture_watching(&["acme/webshop"]).await;
        let p = drafted_run(&fx).await;
        let read = fx.core.runs_review(&p.id).await.unwrap();

        let edit = Edit::Run { instruction: Some("Also read the billing code.".into()), base: Some(" develop ".into()), clone_path: None, kind: None, name: None };
        let edited = fx.core.edit_proposal(&p.id, &edit).await.unwrap();
        let spec = spec_of(&edited);
        assert_eq!((spec.base.as_str(), spec.instruction.as_str()), ("develop", "Also read the billing code."));

        let err = fx.core.runs_approve(&p.id, &read.digest).await.unwrap_err();
        assert!(err.to_string().contains("changed after you read it"), "{err}");
        let fresh = fx.core.runs_review(&p.id).await.unwrap();
        assert_ne!(fresh.digest, read.digest);
        assert!(fx.core.runs_approve(&p.id, &fresh.digest).await.is_ok());
    }

    #[tokio::test]
    async fn a_pip_revision_after_reading_is_refused_at_approval() {
        let fx = crate::inbox::testing::fixture_watching(&["acme/webshop"]).await;
        let clone = clone_in(&fx, "webshop");
        let by_pip = Draft::from_pip("r", Intent::StartRun { connection_id: fx.item("CA-1").connection_id, item: Some(fx.item("CA-1")), spec: spec_in(&clone) }, None);
        let p = fx.core.propose(&fx.scope, by_pip).await.unwrap();
        let read = fx.core.runs_review(&p.id).await.unwrap();

        let revised = Intent::StartRun {
            connection_id: fx.item("CA-1").connection_id,
            item: Some(fx.item("CA-1")),
            spec: RunSpec { focus: Some("look somewhere else".into()), ..read.spec.clone() },
        };
        fx.core.revise_as_pip(&fx.scope, &p.id, revised).await.unwrap();

        let err = fx.core.runs_approve(&p.id, &read.digest).await.unwrap_err();
        assert!(err.to_string().contains("changed after you read it"), "{err}");
        assert!(fx.core.runs_list(&RunQuery::default()).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn review_refreshes_the_ticket_text_and_notes_a_revision_when_the_cache_changed() {
        let fx = crate::inbox::testing::fixture_watching(&["acme/webshop"]).await;
        let p = drafted_run(&fx).await;
        let first = fx.core.runs_review(&p.id).await.unwrap();
        assert_eq!(fx.core.proposal(&p.id).await.unwrap().unwrap().revisions.len(), 0, "an unchanged ticket adds no revision");

        let mut item = fx.core.cache_item(&fx.item("CA-1")).await.unwrap().unwrap();
        item.title = "Cart total is wrong again".into();
        fx.core.with_db_for(&fx.scope, |db| db.upsert_items(&[item], "2026-09-29T13:00:00Z").map(|_| ())).await.unwrap();

        let second = fx.core.runs_review(&p.id).await.unwrap();
        assert!(second.ticket_block.as_deref().unwrap().contains("Cart total is wrong again"));
        assert_ne!(second.digest, first.digest);
        let stored = fx.core.proposal(&p.id).await.unwrap().unwrap();
        assert_eq!((stored.revisions.len(), stored.revisions[0].note.as_str()), (1, "Ticket text updated"));
        assert_eq!(fx.core.runs_review(&p.id).await.unwrap().digest, second.digest);
    }

    #[tokio::test]
    async fn approval_is_refused_when_the_clone_has_gone_and_review_of_another_kind_of_draft_is_refused() {
        let fx = crate::inbox::testing::fixture_watching(&["acme/webshop"]).await;
        let p = drafted_run(&fx).await;
        let digest = fx.core.runs_review(&p.id).await.unwrap().digest;
        std::fs::remove_dir_all(fx.home.join("webshop")).unwrap();
        assert!(fx.core.runs_approve(&p.id, &digest).await.is_err());
        assert_eq!(fx.core.proposal(&p.id).await.unwrap().unwrap().state, ProposalState::Pending);

        let comment = fx.core.draft_as_user(Intent::Comment { item: fx.item("CA-1"), body: Doc::paragraph("hi") }, None).await.unwrap();
        assert!(fx.core.runs_review(&comment.id).await.is_err());
        assert!(fx.core.runs_approve(&comment.id, "x").await.is_err());
    }

    #[test]
    fn a_run_edit_changes_only_the_fields_it_names_and_reads_the_way_the_page_sends_it() {
        let current = Intent::StartRun { connection_id: "c".into(), item: None, spec: crate::domain::fixtures::run_spec() };
        let edit: Edit = serde_json::from_str(r#"{"type":"run","instruction":"Look at logs","clonePath":"/Users/me/Code/other","kind":"investigate","name":" new-name "}"#).unwrap();
        let Intent::StartRun { spec, .. } = edit.apply_to(&current).unwrap() else { panic!() };
        assert_eq!((spec.instruction.as_str(), spec.name.as_str(), spec.base.as_str(), spec.repo.as_str()), ("Look at logs", "new-name", "main", "acme/webshop"));
        assert_eq!(spec.clone_path, PathBuf::from("/Users/me/Code/other"));
        assert!(Edit::Run { instruction: None, base: None, clone_path: None, kind: None, name: None }.apply_to(&Intent::Transition { item: item_ref("1"), to: "d".into() }).is_err());
    }

    #[tokio::test]
    async fn approval_refuses_a_clone_path_that_is_not_its_real_path_and_accepts_the_real_one() {
        let fx = crate::inbox::testing::fixture_watching(&["acme/webshop"]).await;
        let real = clone_in(&fx, "webshop");
        let link = fx.home.join("shortcut");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let item = || Some(fx.item("CA-1"));
        let connection = fx.item("CA-1").connection_id;
        let by_pip = |name: &str, path: &Path| {
            let spec = RunSpec { clone_path: path.to_path_buf(), name: name.into(), ..crate::domain::fixtures::run_spec() };
            Draft::from_pip("r", Intent::StartRun { connection_id: connection.clone(), item: item(), spec }, None)
        };

        let through_link = fx.core.propose(&fx.scope, by_pip("eng-1-linked-0001", &link)).await.unwrap();
        let digest = fx.core.runs_review(&through_link.id).await.unwrap().digest;
        let err = fx.core.runs_approve(&through_link.id, &digest).await.unwrap_err();
        assert!(err.to_string().contains("real path"), "{err}");
        assert_eq!(fx.core.proposal(&through_link.id).await.unwrap().unwrap().state, ProposalState::Pending);
        assert!(fx.core.runs_list(&RunQuery::default()).await.unwrap().is_empty());

        let canonical = fx.core.propose(&fx.scope, by_pip("eng-1-direct-0002", &real.canonicalize().unwrap())).await.unwrap();
        let digest = fx.core.runs_review(&canonical.id).await.unwrap().digest;
        let run = fx.core.runs_approve(&canonical.id, &digest).await.unwrap();
        assert_eq!(run.spec.clone_path, real.canonicalize().unwrap());
    }
}
