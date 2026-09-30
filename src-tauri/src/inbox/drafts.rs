//! Core's proposals service: stores drafts in the signed-in connection's database and is the only caller of
//! `WorkTracker::apply` on behalf of an approval.

use chrono::Utc;
use serde::Deserialize;

use super::{identity_of, Core};
use crate::auth::Scope;
use crate::db::Db;
use crate::domain::{Basis, CreatedBy, Intent, Origin, Proposal, ProposalQuery, ProposalState};
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
    },
    Subtasks {
        summaries: Vec<String>,
    },
}

impl Edit {
    fn apply_to(&self, current: &Intent) -> Result<Intent> {
        match (self, current) {
            (Edit::Comment { body, mentions }, Intent::Comment { item, .. }) => {
                let people: Vec<_> = mentions
                    .iter()
                    .map(|m| (crate::domain::PersonRef { connection_id: item.connection_id.clone(), account_id: m.account_id.clone() }, m.name.clone()))
                    .collect();
                Ok(Intent::Comment { item: item.clone(), body: tracker::comment_doc(body.trim(), &people) })
            }
            (Edit::Subtasks { summaries }, Intent::Subtasks { parent, .. }) => Ok(Intent::Subtasks {
                parent: parent.clone(),
                summaries: summaries.iter().map(|s| s.trim().to_string()).collect(),
            }),
            _ => Err(Error::Proposal("that edit doesn't fit this draft".into())),
        }
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
    /// approved. Only an existing item of the signed-in connection can be the target.
    pub async fn draft_as_user(&self, intent: Intent, label: Option<String>) -> Result<Proposal> {
        let scope = self.scope().await?;
        let connection_id = tracker::Connection::jira_id(&scope);
        let target = intent.target().ok_or_else(|| Error::Proposal("a draft made by hand has to be about an existing item".into()))?;
        if target.connection_id != connection_id {
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
            proposals::edit(db, id, edit.apply_to(&current.intent)?, Utc::now())
        })
        .await
    }

    pub async fn skip_proposal(&self, id: &str) -> Result<Proposal> {
        self.with_proposals(|db| proposals::skip(db, id, Utc::now())).await
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
    use crate::domain::Doc;

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
        let edit = Edit::Comment { body: " Thanks @Sam ".into(), mentions: vec![MentionRef { account_id: "sam".into(), name: "Sam".into() }] };
        let Intent::Comment { item, body } = edit.apply_to(&current).unwrap() else { panic!() };
        assert_eq!(item, item_ref("1"));
        assert_eq!(body.plain_text(), "Thanks @Sam");
        let has_mention = |d: &Doc| format!("{d:?}").contains("Mention");
        assert!(has_mention(&body));
    }

    #[test]
    fn an_edit_of_the_wrong_kind_is_refused() {
        let current = Intent::Transition { item: item_ref("1"), to: "done".into() };
        assert!(Edit::Subtasks { summaries: vec!["a".into()] }.apply_to(&current).is_err());
    }

    #[test]
    fn edits_read_the_way_the_page_sends_them() {
        let edit: Edit = serde_json::from_str(r#"{"type":"comment","body":"hi","mentions":[{"accountId":"a","name":"A"}]}"#).unwrap();
        assert!(matches!(edit, Edit::Comment { mentions, .. } if mentions.len() == 1));
        assert!(matches!(serde_json::from_str::<Edit>(r#"{"type":"subtasks","summaries":["x"]}"#).unwrap(), Edit::Subtasks { .. }));
    }
}
