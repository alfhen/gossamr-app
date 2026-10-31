//! Proposals: writes drafted by a person or Pip that only an approval turns into a change in a tracker.
//! `approve` is the single route from here to `WorkTracker::apply`.

use std::collections::HashMap;
use std::mem::discriminant;

use chrono::{DateTime, Utc};

use crate::db::Db;
use crate::domain::{
    reconcile, without_markers, Actor, Basis, BodyChange, ContainerRef, CreatedBy, Identity, Intent, ItemRef, Origin, Proposal, ProposalQuery,
    ProposalState, ReconcileContext, Revision, StateKind, TitleChange, Transitions, Workflow, WorkstreamEvent, Write, DESCRIPTION_LIMIT,
    SUMMARY_LIMIT,
};
use crate::error::{Error, Result};
use crate::tracker::WorkTracker;

pub struct Draft {
    pub origin: Origin,
    pub created_by: CreatedBy,
    pub intent: Intent,
    pub label: Option<String>,
    pub basis: Option<Basis>,
}

impl Draft {
    /// What Pip drafts while answering `request_id`, in the conversation of `workstream` when it has one.
    pub fn from_pip(request_id: &str, workstream: Option<&str>, intent: Intent, label: Option<String>) -> Self {
        let origin = Origin::Chat { request_id: request_id.into(), workstream: workstream.map(Into::into) };
        Self { origin, created_by: CreatedBy::Pip, intent, label, basis: None }
    }
}

/// Who a draft's maker is in a workstream's audit.
pub fn actor_of(by: CreatedBy) -> Actor {
    match by {
        CreatedBy::Pip => Actor::Pip,
        CreatedBy::Agent => Actor::Run,
        CreatedBy::User => Actor::Person,
    }
}

/// Appends `action` on `p` to the audit of its workstream, when it has one that is stored. Nothing for a draft outside
/// any workstream. The draft has already changed by then, so a line that can't be written is logged, not returned.
pub fn record(db: &Db, p: &Proposal, actor: Actor, action: &str, at: DateTime<Utc>) {
    record_detailed(db, p, actor, action, None, at);
}

/// `record` with a detail on the line, such as the id of the draft that replaced `p`.
pub fn record_detailed(db: &Db, p: &Proposal, actor: Actor, action: &str, detail: Option<&str>, at: DateTime<Utc>) {
    let Some(id) = p.workstream() else { return };
    let appended = db.workstream(id).and_then(|ws| match ws {
        Some(mut ws) => {
            let event = WorkstreamEvent::new(id, actor, action, at).proposal(&p.id);
            db.append_workstream_event(&match detail {
                Some(d) => event.detail(d),
                None => event,
            })?;
            // The person changed the ticket through the workstream's own draft: what it wrote isn't drift. Only the
            // fields it wrote are taken again from the ticket once the write is in the cache; a change anyone else made
            // to the others still trips the workstream.
            let on_ticket = p.target().is_some_and(|t| ws.item_key.as_deref().is_some_and(|k| k.eq_ignore_ascii_case(&t.key)));
            if action == "draft_approved" && actor == Actor::Person && on_ticket {
                if let Some(basis) = ws.basis.as_mut() {
                    let before = basis.changing.len();
                    for field in basis_fields(&p.intent) {
                        if !basis.changing.iter().any(|f| f == field) {
                            basis.changing.push(field.to_string());
                        }
                    }
                    if basis.changing.len() != before {
                        db.save_workstream(&ws)?;
                    }
                }
            }
            Ok(())
        }
        None => Ok(()),
    });
    if let Err(e) = appended {
        eprintln!("couldn't record {action} of draft {} in workstream {id}: {e}", p.id);
    }
}

/// The fields of a workstream's basis that writing `intent` changes: a move its status, an assignee change its
/// assignee, a rewrite its summary and/or description. A comment, subtasks or a link change none of them.
pub fn basis_fields(intent: &Intent) -> Vec<&'static str> {
    use crate::domain::workstream::{BASIS_ASSIGNEE, BASIS_DESCRIPTION, BASIS_STATUS, BASIS_SUMMARY};
    match intent {
        Intent::Transition { .. } => vec![BASIS_STATUS],
        Intent::Update { patch, .. } if patch.assignee.is_some() => vec![BASIS_ASSIGNEE],
        Intent::Rewrite { title, body, .. } => {
            let mut fields = Vec::new();
            if title.is_some() {
                fields.push(BASIS_SUMMARY);
            }
            if body.is_some() {
                fields.push(BASIS_DESCRIPTION);
            }
            fields
        }
        _ => Vec::new(),
    }
}

/// The note on a revision the person made.
pub const EDITED_NOTE: &str = "Edited";

/// Why Pip can't change a review draft the person edited.
pub const REVIEW_IS_THE_USERS: &str = "the user edited this review draft, so Pip can't change it any more";

/// Why a person's edit of a review draft can't put a comment somewhere new.
pub const REVIEW_EDIT_KEEPS_POSITIONS: &str = "an edit can't move a comment or add one at a new line; ask Pip to add it";

/// The note on a revision Pip made.
pub const REVISED_BY_PIP: &str = "Revised by Pip";

fn refuse(message: impl Into<String>) -> Error {
    Error::Proposal(message.into())
}

/// Why a draft to start, message or answer an agent is refused: Pip does those itself.
pub const AGENTS_DIRECT: &str = "Pip starts and messages agents directly now";

pub const REVIEW_OWN_BUTTON: &str = "a review is posted to GitHub with its own button";

/// Why approving this draft never reaches a tracker, or `None` when it is a tracker write.
pub(crate) fn untracked_reason(intent: &Intent) -> Option<&'static str> {
    match intent {
        Intent::StartRun { .. } | Intent::FollowUp { .. } | Intent::RunAnswer { .. } => Some(AGENTS_DIRECT),
        Intent::GithubReview { .. } => Some(REVIEW_OWN_BUTTON),
        _ => None,
    }
}

pub(crate) fn new_id() -> Result<String> {
    let mut bytes = [0u8; 12];
    getrandom::fill(&mut bytes).map_err(|e| refuse(format!("no randomness available: {e}")))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// The longest summary a review draft posts, the most inline comments it carries, and the longest of each.
pub const REVIEW_SUMMARY_LIMIT: usize = 10_000;
pub const REVIEW_COMMENTS_MAX: usize = 50;
pub const REVIEW_COMMENT_LIMIT: usize = 5_000;
/// The longest file path a review comment may name.
pub const REVIEW_PATH_LIMIT: usize = 500;

/// A review draft's own text and where its comments sit. Whether each comment's line is in the pull request's diff needs
/// the diff, so Core checks that where it has it, not here.
fn check_review(intent: &Intent) -> Result<()> {
    let Intent::GithubReview { connection_id, item, run_id, repo, number, commit_sha, summary, comments } = intent else { return Ok(()) };
    if connection_id.trim().is_empty() || item.as_ref().is_some_and(|i| i.connection_id == *connection_id) {
        return Err(refuse("a review belongs to the code host's connection, and its ticket to the tracker's"));
    }
    if run_id.trim().is_empty() {
        return Err(refuse("a review draft names the run it came from"));
    }
    if !crate::domain::valid_repo(repo) || *number == 0 {
        return Err(refuse("a review is of a pull request in an owner/name repository"));
    }
    if !(7..=40).contains(&commit_sha.len()) || !commit_sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(refuse("a review is pinned to the commit it read, as 7 to 40 hex characters"));
    }
    let clean = |text: &str, what: &str, limit: usize| -> Result<()> {
        if text.trim().is_empty() {
            return Err(refuse(format!("a review's {what} can't be empty")));
        }
        if text.contains('\0') || text.chars().count() > limit {
            return Err(refuse(format!("a review's {what} is up to {limit} characters of plain text")));
        }
        if without_markers(text) != text {
            return Err(refuse(format!("the review's {what} contains text Gossamr reserves; remove it")));
        }
        Ok(())
    };
    clean(summary, "summary", REVIEW_SUMMARY_LIMIT)?;
    if comments.len() > REVIEW_COMMENTS_MAX {
        return Err(refuse(format!("a review carries at most {REVIEW_COMMENTS_MAX} inline comments; put the rest in its summary")));
    }
    let mut seen = std::collections::HashSet::new();
    for c in comments {
        clean(&c.body, "comment", REVIEW_COMMENT_LIMIT)?;
        if c.path.chars().count() > REVIEW_PATH_LIMIT || !crate::codehost::diff::relative_path(&c.path) {
            return Err(refuse(format!("a review comment sits in a file of the repository, named by a relative path of at most {REVIEW_PATH_LIMIT} characters")));
        }
        if c.line == 0 {
            return Err(refuse("a review comment sits on a line, counted from 1"));
        }
        if !seen.insert((c.path.as_str(), c.line, c.side)) {
            return Err(refuse(format!("there are two comments on {}:{}; merge them into one", c.path, c.line)));
        }
    }
    Ok(())
}

fn check(intent: &Intent) -> Result<()> {
    let blank = |s: &str| s.trim().is_empty();
    match intent {
        Intent::Comment { body, .. } if blank(&body.plain_text()) => Err(refuse("a comment can't be empty")),
        Intent::Transition { to, .. } if blank(to) => Err(refuse("a transition needs a target status")),
        Intent::Subtasks { summaries, .. } if summaries.is_empty() || summaries.iter().any(|s| blank(s)) => {
            Err(refuse("list at least one subtask, and none of them blank"))
        }
        Intent::Update { patch, .. } if patch.is_empty() => Err(refuse("an update has to change something")),
        Intent::Create { fields, .. } if blank(&fields.title) => Err(refuse("a new item needs a title")),
        Intent::Rewrite { title, body, .. } => check_rewrite(title.as_ref(), body.as_ref()),
        Intent::GithubReview { .. } => check_review(intent),
        Intent::StartRun { .. } | Intent::FollowUp { .. } | Intent::RunAnswer { .. } => Err(refuse(AGENTS_DIRECT)),
        _ => Ok(()),
    }
}

fn check_rewrite(title: Option<&TitleChange>, body: Option<&BodyChange>) -> Result<()> {
    if title.is_none() && body.is_none() {
        return Err(refuse("a rewrite has to change the title or the description"));
    }
    if let Some(t) = title {
        let to = t.to.trim();
        if to.is_empty() || to.contains('\n') {
            return Err(refuse("a title is one line and can't be empty"));
        }
        if to.chars().count() > SUMMARY_LIMIT {
            return Err(refuse(format!("a title is at most {SUMMARY_LIMIT} characters")));
        }
        if without_markers(to) != to {
            return Err(refuse("the title contains text Gossamr reserves; remove it"));
        }
        if to == t.from.trim() {
            return Err(refuse("the new title is the same as the old one"));
        }
    }
    if let Some(b) = body {
        let to = b.to.to_markdown();
        if to.trim().is_empty() {
            return Err(refuse("a description can't be emptied; draft a comment or clear it in Jira"));
        }
        if to.chars().count() > DESCRIPTION_LIMIT {
            return Err(refuse(format!("a description is at most {DESCRIPTION_LIMIT} characters")));
        }
        if without_markers(&to) != to {
            return Err(refuse("the description contains text Gossamr reserves; remove it"));
        }
        if to == b.from.to_markdown() {
            return Err(refuse("the new description is the same as the old one"));
        }
    }
    Ok(())
}

pub fn create(db: &Db, draft: Draft, at: DateTime<Utc>) -> Result<Proposal> {
    check(&draft.intent)?;
    let p = Proposal {
        id: new_id()?,
        created_at: at,
        updated_at: at,
        origin: draft.origin,
        created_by: draft.created_by,
        intent: draft.intent,
        label: draft.label,
        basis: draft.basis,
        state: ProposalState::Pending,
        revisions: vec![],
        created: vec![],
        error: None,
        run: None,
        superseded_by: None,
        posted: None,
        maybe_posted: None,
    };
    // Everything that can refuse the draft is decided before anything is written.
    db.insert_proposal(&p)?;
    record(db, &p, actor_of(p.created_by), "draft_created", at);
    settle(db, &p, at)?;
    Ok(p)
}

/// Retires the pending drafts `p` replaces, and records the ones it leaves standing. `create` and `unskip` both do this,
/// so bringing a skip back cannot leave two unedited drafts of the same kind and target pending.
fn settle(db: &Db, p: &Proposal, at: DateTime<Utc>) -> Result<()> {
    let Tidied { replaced, kept } = tidy(db, p)?;
    for mut old in replaced {
        old.state = ProposalState::Retired(REPLACED_REASON.into());
        old.superseded_by = Some(p.id.clone());
        old.updated_at = at;
        db.save_proposal(&old)?;
        record_beside(db, &old, p, "draft_superseded", at);
    }
    for (old, action) in kept {
        record_beside(db, &old, p, action, at);
    }
    Ok(())
}

/// Records `action` on the older draft `old` that the new draft `new` replaced or left standing, with the new one's id:
/// in `old`'s workstream, or, for a draft in none, in `new`'s, so the workstream the new draft is in says what happened.
fn record_beside(db: &Db, old: &Proposal, new: &Proposal, action: &str, at: DateTime<Utc>) {
    let actor = actor_of(new.created_by);
    if old.workstream().is_some() {
        return record_detailed(db, old, actor, action, Some(&new.id), at);
    }
    let Some(ws) = new.workstream() else { return };
    let appended = db.workstream(ws).and_then(|stored| match stored {
        Some(_) => db.append_workstream_event(&WorkstreamEvent::new(ws, actor, action, at).proposal(&old.id).detail(&new.id)).map(|_| ()),
        None => Ok(()),
    });
    if let Err(e) = appended {
        eprintln!("couldn't record {action} of draft {} in workstream {ws}: {e}", old.id);
    }
}

pub const REPLACED_REASON: &str = "Replaced by a newer draft";
pub const KEPT_EDITED: &str = "draft_kept_edited";
pub const KEPT_MAYBE_POSTED: &str = "draft_kept_maybe_posted";
pub const KEPT_PARTIAL: &str = "draft_kept_partial";
pub const KEPT_UNCONFIRMED: &str = "draft_kept_unconfirmed";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Supersession {
    Unrelated,
    Supersede,
    Alongside,
}

pub fn supersession(older: &Proposal, newer: &Proposal) -> Supersession {
    if older.id == newer.id || older.state != ProposalState::Pending || newer.state != ProposalState::Pending {
        return Supersession::Unrelated;
    }
    let Some(key) = newer.intent.supersession_key() else { return Supersession::Unrelated };
    if older.intent.supersession_key().as_ref() != Some(&key) {
        return Supersession::Unrelated;
    }
    if person_owned(older) || older.maybe_posted.is_some() || !older.created.is_empty() || attempt_unconfirmed(older) {
        return Supersession::Alongside;
    }
    Supersession::Supersede
}

/// The last attempt may have written something: the app closed while it was being applied, or the tracker answered
/// after the write was sent. A refusal that says nothing was written, or that this tracker can't edit text, is not
/// one of these, so the next draft of the same kind replaces it.
fn attempt_unconfirmed(p: &Proposal) -> bool {
    p.error.as_deref().is_some_and(|e| !e.contains("nothing was written") && !e.contains("can't change a ticket's title or description"))
}

#[derive(Debug, Default)]
struct Tidied {
    replaced: Vec<Proposal>,
    kept: Vec<(Proposal, &'static str)>,
}

fn tidy(db: &Db, p: &Proposal) -> Result<Tidied> {
    let pending = db.proposals(&ProposalQuery { states: Some(vec![StateKind::Pending]), ..Default::default() })?;
    let mut tidied = Tidied::default();
    for older in pending {
        match supersession(&older, p) {
            Supersession::Supersede => tidied.replaced.push(older),
            Supersession::Alongside => {
                let reason = if person_owned(&older) {
                    KEPT_EDITED
                } else if older.maybe_posted.is_some() {
                    KEPT_MAYBE_POSTED
                } else if !older.created.is_empty() {
                    KEPT_PARTIAL
                } else {
                    KEPT_UNCONFIRMED
                };
                tidied.kept.push((older, reason));
            }
            Supersession::Unrelated => {}
        }
    }
    Ok(tidied)
}

fn load(db: &Db, id: &str) -> Result<Proposal> {
    db.proposal(id)?.ok_or_else(|| refuse("that draft no longer exists"))
}

pub(crate) fn not_pending(p: &Proposal) -> Error {
    refuse(match &p.state {
        ProposalState::Pending => "that draft is pending",
        ProposalState::Applying => "that draft is being applied right now",
        ProposalState::Applied => "that draft has already been applied",
        ProposalState::Skipped => "that draft was skipped",
        ProposalState::Retired(_) => "that draft is out of date and was retired",
    })
}

/// Replaces a pending proposal's payload with the person's edit. What it is about and what kind of change it is stay
/// fixed, and subtasks already created stay in front so a retry still lines up.
pub fn edit(db: &Db, id: &str, intent: Intent, at: DateTime<Utc>) -> Result<Proposal> {
    edit_noted(db, id, intent, EDITED_NOTE, at)
}

pub fn edit_noted(db: &Db, id: &str, intent: Intent, note: &str, at: DateTime<Utc>) -> Result<Proposal> {
    let mut p = load(db, id)?;
    if p.state != ProposalState::Pending {
        return Err(not_pending(&p));
    }
    if discriminant(&p.intent) != discriminant(&intent) || p.intent.target() != intent.target() {
        return Err(refuse("an edit can't change what the draft is about"));
    }
    check(&intent)?;
    if let (Intent::GithubReview { connection_id: a, run_id: x, repo: r, number: n, commit_sha: c, .. }, Intent::GithubReview { connection_id: b, run_id: y, repo: s, number: m, commit_sha: d, .. }) = (&p.intent, &intent) {
        if a != b || x != y || r != s || n != m || c != d {
            return Err(refuse("an edit can't change which pull request, commit or run a review is for"));
        }
    }
    if let (Intent::GithubReview { comments: old, .. }, Intent::GithubReview { comments: new, .. }) = (&p.intent, &intent) {
        // The person rewords and drops comments; a new position is Pip's to draft, where it is checked against the diff.
        if note == EDITED_NOTE && new.iter().any(|c| !old.iter().any(|o| (o.path.as_str(), o.line, o.side) == (c.path.as_str(), c.line, c.side))) {
            return Err(refuse(REVIEW_EDIT_KEEPS_POSITIONS));
        }
    }
    if let (Intent::Subtasks { summaries: old, .. }, Intent::Subtasks { summaries: new, .. }) = (&p.intent, &intent) {
        let made = p.created.len().min(old.len());
        if new.len() < made || new[..made] != old[..made] {
            return Err(refuse("subtasks that were already created can't be changed"));
        }
    }
    if let (Intent::Rewrite { title: ot, body: ob, .. }, Intent::Rewrite { title: nt, body: nb, .. }) = (&p.intent, &intent) {
        let title_basis = |t: &Option<TitleChange>| t.as_ref().map(|t| t.from.clone());
        let body_basis = |b: &Option<BodyChange>| b.as_ref().map(|b| b.from.clone());
        if title_basis(ot) != title_basis(nt) || body_basis(ob) != body_basis(nb) {
            return Err(refuse("an edit can't change which text the rewrite was drafted against"));
        }
    }
    // A transition's label named the old target, so the approve button falls back to the new status's name.
    if matches!((&p.intent, &intent), (Intent::Transition { to: a, .. }, Intent::Transition { to: b, .. }) if a != b) {
        p.label = None;
    }
    p.revisions.push(Revision { at, note: note.into(), intent: intent.clone() });
    p.intent = intent;
    p.updated_at = at;
    if p.error.as_deref() != Some(crate::inbox::code::REVIEW_HEAD_MOVED_NOTE) {
        p.error = None;
    }
    db.save_proposal(&p)?;
    Ok(p)
}

/// Pip may change only what it drafted itself, and only while nobody has decided it.
pub fn require_pip_pending(p: &Proposal) -> Result<()> {
    if p.created_by != CreatedBy::Pip {
        return Err(refuse("that draft wasn't made by Pip, so Pip can't change it"));
    }
    if p.state != ProposalState::Pending {
        return Err(not_pending(p));
    }
    Ok(())
}

/// Whether the person has changed the draft's text at all.
pub fn person_edited(p: &Proposal) -> bool {
    p.revisions.iter().any(|r| r.note == EDITED_NOTE)
}

fn person_owned(p: &Proposal) -> bool {
    person_edited(p) || (p.created_by == CreatedBy::User && !matches!(p.origin, Origin::Run { .. }))
}

/// Whether the person has changed a rewrite's text. Their words are theirs to keep.
pub fn person_edited_rewrite(p: &Proposal) -> bool {
    matches!(p.intent, Intent::Rewrite { .. }) && p.revisions.iter().any(|r| r.note == EDITED_NOTE)
}

/// Whether the draft is a comment, new ticket, breakdown into subtasks, description update or review an agent run left. Drafts
/// stored before `CreatedBy::Agent` existed say `User` for these.
pub fn left_by_run(p: &Proposal) -> bool {
    matches!((&p.origin, &p.intent), (Origin::Run { .. }, Intent::Comment { .. } | Intent::Create { .. } | Intent::Subtasks { .. } | Intent::Rewrite { .. } | Intent::GithubReview { .. }))
        && matches!(p.created_by, CreatedBy::Agent | CreatedBy::User)
}

/// What Pip may revise: its own pending drafts, and a pending comment, new ticket, breakdown into subtasks or description
/// update without a Gossamr Plan the person's agent run left for them. The person made none of these by hand, and all stay theirs to approve.
/// A draft that belongs to a workstream is revised only from that workstream's conversation (`workstream`); one in no
/// workstream from any conversation.
pub fn require_pip_may_revise(p: &Proposal, workstream: Option<&str>) -> Result<()> {
    if matches!(p.intent, Intent::GithubReview { .. }) && person_edited(p) {
        return Err(refuse(REVIEW_IS_THE_USERS));
    }
    if person_edited_rewrite(p) {
        return Err(refuse("the user edited this description draft, so Pip can't change it any more"));
    }
    // Person edits are final: a comment, new ticket or breakdown an agent left is the person's once they have edited it.
    if left_by_run(p) && person_edited(p) {
        return Err(refuse("the user edited this draft, so Pip can't change it any more"));
    }
    if p.created_by != CreatedBy::Pip && !left_by_run(p) {
        return Err(refuse("that draft wasn't made by Pip or from an agent run's result, so Pip can't change it"));
    }
    require_same_workstream(p, workstream)?;
    if p.state != ProposalState::Pending {
        return Err(not_pending(p));
    }
    Ok(())
}

/// A draft that belongs to a workstream is Pip's to change only from that workstream's conversation (`workstream`); one
/// in no workstream from any conversation.
pub fn require_same_workstream(p: &Proposal, workstream: Option<&str>) -> Result<()> {
    if p.workstream().is_some_and(|w| Some(w) != workstream) {
        return Err(refuse("that draft belongs to another workstream"));
    }
    Ok(())
}

pub fn skip(db: &Db, id: &str, at: DateTime<Utc>) -> Result<Proposal> {
    let mut p = load(db, id)?;
    match p.state {
        ProposalState::Skipped => return Ok(p),
        ProposalState::Pending => {}
        _ => return Err(not_pending(&p)),
    }
    p.state = ProposalState::Skipped;
    p.updated_at = at;
    db.save_proposal(&p)?;
    Ok(p)
}

/// How long after a skip the person may take it back. The page's Undo toast lasts about 8 seconds; this leaves room for a
/// slow click and a busy machine, and no more: a skip that old stands.
pub const UNSKIP_WINDOW_SECS: i64 = 60;

/// The person's Undo of a skip: a draft skipped within `UNSKIP_WINDOW_SECS` goes back to pending, as it was (a skip changes
/// nothing else). A later unedited draft of the same kind and target is retired, so the two are not both pending. One
/// that is pending already is returned as it is; any other state, or a skip that old, is refused.
pub fn unskip(db: &Db, id: &str, at: DateTime<Utc>) -> Result<Proposal> {
    let mut p = load(db, id)?;
    match p.state {
        ProposalState::Pending => return Ok(p),
        ProposalState::Skipped => {}
        _ => return Err(refuse("only a skipped draft can be brought back")),
    }
    if at.signed_duration_since(p.updated_at).num_seconds() > UNSKIP_WINDOW_SECS {
        return Err(refuse("that draft was skipped too long ago to bring back"));
    }
    p.state = ProposalState::Pending;
    p.updated_at = at;
    db.save_proposal(&p)?;
    settle(db, &p, at)?;
    Ok(p)
}

pub fn retire(db: &Db, id: &str, reason: &str, at: DateTime<Utc>) -> Result<Proposal> {
    let mut p = load(db, id)?;
    if p.state != ProposalState::Pending {
        return Err(not_pending(&p));
    }
    p.state = ProposalState::Retired(reason.into());
    p.updated_at = at;
    db.save_proposal(&p)?;
    Ok(p)
}

/// First half of an approval: claims the proposal so nothing else can apply it, and returns it.
pub fn begin(db: &Db, id: &str, at: DateTime<Utc>) -> Result<Proposal> {
    match db.begin_applying(id, at)? {
        Some(p) => Ok(p),
        None => Err(not_pending(&load(db, id)?)),
    }
}

/// What an attempt did. Creating several things can stop part-way, so `error` accompanies whatever was created.
#[derive(Debug, Default)]
pub struct Outcome {
    pub created: Vec<ItemRef>,
    pub error: Option<Error>,
}

/// A rewrite replaces text outright, and Jira can't make a write conditional on what the text was. So the ticket is read
/// again just before writing, and a ticket that moved on is left alone.
async fn guard_rewrite(tracker: &dyn WorkTracker, item: &ItemRef, title: Option<&TitleChange>, body: Option<&BodyChange>) -> Result<()> {
    if !tracker.capabilities().edit_text {
        return Err(refuse("this tracker can't change a ticket's title or description"));
    }
    let now = tracker.item(item, &Utc::now().to_rfc3339()).await?;
    if title.is_some_and(|t| t.from != now.title) || body.is_some_and(|b| b.from != now.body) {
        return Err(refuse(format!(
            "{} changed since this was drafted, so nothing was written. Skip this draft and ask Pip to draft it again from the current text.",
            item.key
        )));
    }
    Ok(())
}

/// Hands the proposal's intent to the tracker. Subtasks a previous attempt created are left out.
pub async fn execute(tracker: &dyn WorkTracker, p: &Proposal) -> Outcome {
    if let Intent::Rewrite { item, title, body, .. } = &p.intent {
        if let Err(error) = guard_rewrite(tracker, item, title.as_ref(), body.as_ref()).await {
            return Outcome { created: vec![], error: Some(error) };
        }
    }
    let write = match &p.intent {
        Intent::Subtasks { parent, summaries } => {
            let rest = &summaries[p.created.len().min(summaries.len())..];
            if rest.is_empty() {
                return Outcome::default();
            }
            Some(Write::Subtasks { parent: parent.clone(), summaries: rest.to_vec() })
        }
        other => other.write(),
    };
    let Some(write) = write else {
        let reason = untracked_reason(&p.intent).unwrap_or("this draft has nothing for a tracker to apply");
        return Outcome { created: vec![], error: Some(Error::Proposal(reason.into())) };
    };
    match tracker.apply(&write).await {
        Ok(applied) => Outcome { created: applied.created, error: applied.error },
        Err(error) => Outcome { created: vec![], error: Some(error) },
    }
}

/// Second half: a failed attempt goes back to pending with the error, keeping what it created; otherwise it is applied.
pub fn finish(db: &Db, id: &str, outcome: Outcome, at: DateTime<Utc>) -> Result<Proposal> {
    let mut p = load(db, id)?;
    if p.state != ProposalState::Applying {
        return Err(not_pending(&p));
    }
    p.created.extend(outcome.created);
    match outcome.error {
        Some(e) => {
            p.state = ProposalState::Pending;
            p.error = Some(e.to_string());
        }
        None => {
            p.state = ProposalState::Applied;
            p.error = None;
        }
    }
    p.updated_at = at;
    db.save_proposal(&p)?;
    Ok(p)
}

/// Runs `reconcile` over every pending proposal against the cache and stores what it decides. Returns how many changed.
pub fn reconcile_pending(db: &Db, me: &Identity, now: DateTime<Utc>) -> Result<usize> {
    let pending = db.proposals(&ProposalQuery { states: Some(vec![StateKind::Pending]), ..Default::default() })?;
    let (pending, mut changed) = retire_moved_siblings(db, pending, now)?;
    let mut items = Vec::new();
    let mut workflows: HashMap<ContainerRef, Workflow> = HashMap::new();
    for target in pending.iter().filter_map(Proposal::target) {
        // A ticket that was never cached, or has aged out, can't be judged; retiring its drafts would lose them.
        let Some(item) = db.item(target)? else { continue };
        if !workflows.contains_key(&item.container) {
            // A tracker that lists moves per item leaves the graph empty, which would read as "nothing is reachable".
            if let Some(w) = db.workflow(&item.container)?.filter(|w| !matches!(&w.transitions, Transitions::Graph(m) if m.is_empty())) {
                workflows.insert(item.container.clone(), w);
            }
        }
        items.push(item);
    }
    let ctx = ReconcileContext { me, workflows: &workflows };
    for mut p in pending {
        let Some(target) = p.target() else { continue };
        if !items.iter().any(|i| i.item == *target) {
            continue;
        }
        let verdict = reconcile(&p, &items, &ctx);
        let before = p.clone();
        p.absorb(verdict, now);
        if p != before {
            db.save_proposal(&p)?;
            changed += 1;
        }
    }
    Ok(changed)
}

/// Once one move of a ticket is approved, the other moves of it drafted before then are out of date whoever made them:
/// each is retired, so approving one transition settles its siblings. Needs no cached copy of the ticket. Returns the
/// drafts still pending and how many were retired.
fn retire_moved_siblings(db: &Db, pending: Vec<Proposal>, now: DateTime<Utc>) -> Result<(Vec<Proposal>, usize)> {
    let mut approved: HashMap<(String, String), Vec<DateTime<Utc>>> = HashMap::new();
    let mut kept = Vec::with_capacity(pending.len());
    let mut retired = 0;
    for mut p in pending {
        let Intent::Transition { item, .. } = &p.intent else {
            kept.push(p);
            continue;
        };
        let id = (item.connection_id.clone(), item.external_id.clone());
        if !approved.contains_key(&id) {
            let query = ProposalQuery { states: Some(vec![StateKind::Applied]), item: Some(item.clone()), ..Default::default() };
            let moves = db.proposals(&query)?.into_iter().filter(|a| matches!(a.intent, Intent::Transition { .. })).map(|a| a.updated_at).collect();
            approved.insert(id.clone(), moves);
        }
        if !approved[&id].iter().any(|at| *at >= p.created_at) {
            kept.push(p);
            continue;
        }
        p.state = ProposalState::Retired(format!("Another move of {} was approved", item.key));
        p.updated_at = now;
        db.save_proposal(&p)?;
        record(db, &p, Actor::Supervisor, "draft_retired", now);
        retired += 1;
    }
    Ok((kept, retired))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::fixtures::{item_ref, now, person, work_item};
    use crate::domain::{BodyChange, Category, Container, Doc, StatusDef, TitleChange, Transition};
    use crate::tracker::testing::Recorder;
    use crate::tracker::Applied;

    fn comment_draft(id: &str) -> Draft {
        Draft::from_pip("run", None, Intent::Comment { item: item_ref(id), body: Doc::paragraph("hello") }, None)
    }



    fn subtasks_draft(summaries: &[&str]) -> Draft {
        let summaries = summaries.iter().map(|s| s.to_string()).collect();
        Draft::from_pip("run", None, Intent::Subtasks { parent: item_ref("1"), summaries }, None)
    }

    fn made(db: &Db, draft: Draft) -> Proposal {
        create(db, draft, now()).unwrap()
    }

    async fn approve(db: &Db, tracker: &Recorder, id: &str) -> Result<Proposal> {
        let claimed = begin(db, id, now())?;
        let outcome = execute(tracker, &claimed).await;
        finish(db, id, outcome, now())
    }

    fn down() -> Result<Applied> {
        Err(Error::Api { status: 503, message: "down".into() })
    }

    fn created(keys: &[&str]) -> Vec<ItemRef> {
        keys.iter().map(|k| ItemRef { connection_id: "c".into(), external_id: (*k).into(), key: (*k).into() }).collect()
    }

    #[test]
    fn drafts_are_stored_and_listed_by_state_item_and_connection() {
        let db = Db::in_memory().unwrap();
        let a = made(&db, comment_draft("1"));
        let b = made(&db, comment_draft("2"));
        skip(&db, &b.id, now()).unwrap();

        assert_eq!(db.proposal(&a.id).unwrap().unwrap(), a);
        assert_eq!(db.proposals(&ProposalQuery::default()).unwrap().len(), 2);
        let pending = ProposalQuery { states: Some(vec![StateKind::Pending]), ..Default::default() };
        assert_eq!(db.proposals(&pending).unwrap(), vec![a.clone()]);
        let on_two = ProposalQuery { item: Some(item_ref("2")), ..Default::default() };
        assert_eq!(db.proposals(&on_two).unwrap()[0].id, b.id);
        let other = ProposalQuery { connection_id: Some("elsewhere".into()), ..Default::default() };
        assert!(db.proposals(&other).unwrap().is_empty());
        assert!(db.proposal("nope").unwrap().is_none());
    }

    #[test]
    fn blank_drafts_are_refused() {
        let db = Db::in_memory().unwrap();
        let empty = Draft::from_pip("r", None, Intent::Comment { item: item_ref("1"), body: Doc::paragraph("  ") }, None);
        assert!(create(&db, empty, now()).is_err());
        assert!(create(&db, subtasks_draft(&[]), now()).is_err());
        assert!(create(&db, subtasks_draft(&["a", " "]), now()).is_err());
    }

    #[test]
    fn an_edit_replaces_the_payload_but_not_what_it_is_about() {
        let db = Db::in_memory().unwrap();
        let p = made(&db, comment_draft("1"));
        let new_body = Intent::Comment { item: item_ref("1"), body: Doc::paragraph("better") };
        let edited = edit(&db, &p.id, new_body.clone(), now()).unwrap();
        assert_eq!(edited.intent, new_body);
        assert_eq!(edited.revisions.len(), 1);
        assert_eq!(db.proposal(&p.id).unwrap().unwrap().intent, new_body);

        let elsewhere = Intent::Comment { item: item_ref("2"), body: Doc::paragraph("x") };
        assert!(edit(&db, &p.id, elsewhere, now()).is_err());
        let other_kind = Intent::Transition { item: item_ref("1"), to: "done".into() };
        assert!(edit(&db, &p.id, other_kind, now()).is_err());
        let blank = Intent::Comment { item: item_ref("1"), body: Doc::paragraph("") };
        assert!(edit(&db, &p.id, blank, now()).is_err());
    }

    #[test]
    fn skipped_drafts_cannot_be_edited_or_applied_and_skipping_twice_is_harmless() {
        let db = Db::in_memory().unwrap();
        let p = made(&db, comment_draft("1"));
        skip(&db, &p.id, now()).unwrap();
        assert_eq!(skip(&db, &p.id, now()).unwrap().state, ProposalState::Skipped);
        assert!(edit(&db, &p.id, p.intent.clone(), now()).is_err());
        assert!(begin(&db, &p.id, now()).is_err());
    }

    #[test]
    fn a_fresh_skip_is_taken_back_to_pending_exactly_and_only_from_skipped() {
        let db = Db::in_memory().unwrap();
        let p = made(&db, comment_draft("1"));
        let skipped_at = now();
        skip(&db, &p.id, skipped_at).unwrap();
        let back = unskip(&db, &p.id, skipped_at + chrono::Duration::seconds(8)).unwrap();
        assert_eq!(back.state, ProposalState::Pending);
        assert_eq!(Proposal { updated_at: p.updated_at, ..back.clone() }, p, "nothing but the state (and when it changed) moved");
        assert_eq!(load(&db, &p.id).unwrap().state, ProposalState::Pending, "stored, not only returned");
        assert_eq!(unskip(&db, &p.id, now()).unwrap().state, ProposalState::Pending, "bringing back what is pending is harmless");
        // Pending again, it can be edited and decided as before.
        assert!(edit(&db, &p.id, p.intent.clone(), now()).is_ok());
        assert!(begin(&db, &p.id, now()).is_ok());
    }

    #[test]
    fn a_skip_older_than_the_window_stands_and_so_does_any_other_state() {
        let db = Db::in_memory().unwrap();
        let old = made(&db, comment_draft("1"));
        let skipped_at = now();
        skip(&db, &old.id, skipped_at).unwrap();
        let late = skipped_at + chrono::Duration::seconds(UNSKIP_WINDOW_SECS + 1);
        let err = unskip(&db, &old.id, late).unwrap_err().to_string();
        assert!(err.contains("too long ago"), "{err}");
        assert_eq!(load(&db, &old.id).unwrap().state, ProposalState::Skipped);
        assert!(unskip(&db, &old.id, skipped_at + chrono::Duration::seconds(UNSKIP_WINDOW_SECS)).is_ok(), "the window's last second still counts");

        let retired = made(&db, comment_draft("2"));
        retire(&db, &retired.id, "superseded", now()).unwrap();
        assert!(unskip(&db, &retired.id, now()).is_err(), "a retired draft is not brought back");
        let applying = made(&db, comment_draft("3"));
        begin(&db, &applying.id, now()).unwrap();
        assert!(unskip(&db, &applying.id, now()).is_err(), "nor one being applied");
        assert!(unskip(&db, "nope", now()).is_err());
    }

    #[tokio::test]
    async fn approving_applies_the_intent_once_and_only_once() {
        let db = Db::in_memory().unwrap();
        let tracker = Recorder::default();
        let p = made(&db, comment_draft("1"));

        let done = approve(&db, &tracker, &p.id).await.unwrap();
        assert_eq!(done.state, ProposalState::Applied);
        assert_eq!(tracker.intents(), vec![p.intent.clone()]);

        assert!(approve(&db, &tracker, &p.id).await.is_err());
        assert_eq!(tracker.intents().len(), 1);
        assert!(skip(&db, &p.id, now()).is_err(), "an applied draft can't be skipped");
    }

    #[test]
    fn a_draft_being_applied_cannot_be_claimed_again() {
        let db = Db::in_memory().unwrap();
        let p = made(&db, comment_draft("1"));
        assert_eq!(begin(&db, &p.id, now()).unwrap().state, ProposalState::Applying);
        let again = begin(&db, &p.id, now()).unwrap_err().to_string();
        assert!(again.contains("being applied"), "{again}");
        assert!(edit(&db, &p.id, p.intent.clone(), now()).is_err());
        assert!(begin(&db, "missing", now()).is_err());
    }

    #[tokio::test]
    async fn a_failed_attempt_is_recorded_and_can_be_retried() {
        let db = Db::in_memory().unwrap();
        let tracker = Recorder::default();
        tracker.will(down());
        let p = made(&db, comment_draft("1"));

        let failed = approve(&db, &tracker, &p.id).await.unwrap();
        assert_eq!(failed.state, ProposalState::Pending);
        assert!(failed.error.as_deref().unwrap().contains("down"));
        assert_eq!(db.proposal(&p.id).unwrap().unwrap().error, failed.error);

        let retried = approve(&db, &tracker, &p.id).await.unwrap();
        assert_eq!(retried.state, ProposalState::Applied);
        assert_eq!(retried.error, None);
        assert_eq!(tracker.intents().len(), 2);
    }

    #[tokio::test]
    async fn a_subtask_retry_creates_only_what_is_left() {
        let db = Db::in_memory().unwrap();
        let tracker = Recorder::default();
        tracker.will(Ok(Applied { created: created(&["S-1"]), error: Some(Error::Api { status: 500, message: "boom".into() }) }));
        tracker.will(Ok(Applied { created: created(&["S-2", "S-3"]), error: None }));
        let p = made(&db, subtasks_draft(&["a", "b", "c"]));

        let partial = approve(&db, &tracker, &p.id).await.unwrap();
        assert_eq!(partial.state, ProposalState::Pending);
        assert_eq!(partial.created, created(&["S-1"]));

        let done = approve(&db, &tracker, &p.id).await.unwrap();
        assert_eq!(done.state, ProposalState::Applied);
        assert_eq!(done.created, created(&["S-1", "S-2", "S-3"]));
        let sent: Vec<Vec<String>> = tracker
            .intents()
            .into_iter()
            .map(|i| match i {
                Intent::Subtasks { summaries, .. } => summaries,
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(sent, vec![vec!["a", "b", "c"], vec!["b", "c"]]);
    }

    #[test]
    fn subtasks_already_created_cannot_be_edited_away_but_the_rest_can() {
        let db = Db::in_memory().unwrap();
        let p = made(&db, subtasks_draft(&["a", "b", "c"]));
        let mut stored = db.proposal(&p.id).unwrap().unwrap();
        stored.created = created(&["S-1"]);
        db.save_proposal(&stored).unwrap();

        let with = |summaries: &[&str]| Intent::Subtasks { parent: item_ref("1"), summaries: summaries.iter().map(|s| s.to_string()).collect() };
        assert!(edit(&db, &p.id, with(&["x", "b", "c"]), now()).is_err());
        assert!(edit(&db, &p.id, with(&[]), now()).is_err());
        assert_eq!(edit(&db, &p.id, with(&["a", "c"]), now()).unwrap().state, ProposalState::Pending);
    }

    #[test]
    fn a_draft_left_applying_by_a_closed_app_is_released_with_a_warning() {
        let db = Db::in_memory().unwrap();
        let p = made(&db, comment_draft("1"));
        begin(&db, &p.id, now()).unwrap();
        assert_eq!(db.release_interrupted(now()).unwrap(), 1);
        let back = db.proposal(&p.id).unwrap().unwrap();
        assert_eq!(back.state, ProposalState::Pending);
        assert!(back.error.unwrap().contains("Check whether it went through"));
    }

    #[test]
    fn a_draft_whose_post_may_have_gone_through_is_not_replaced() {
        let db = Db::in_memory().unwrap();
        let p = made(&db, comment_draft("1"));
        begin(&db, &p.id, now()).unwrap();
        db.release_interrupted(now()).unwrap();
        let newer = made(&db, comment_draft("1"));
        assert_eq!(load(&db, &p.id).unwrap().state, ProposalState::Pending, "the warning stays for the person to check");
        assert_eq!(load(&db, &newer.id).unwrap().state, ProposalState::Pending);
    }

    #[test]
    fn a_rewrite_that_wrote_nothing_is_replaced_by_the_next_draft() {
        let db = Db::in_memory().unwrap();
        let p = made(&db, Draft::from_pip("r", None, rewrite(Some(("Old", "New")), None), None));
        let mut stored = load(&db, &p.id).unwrap();
        stored.error = Some("CA-1 changed since this was drafted, so nothing was written. Skip this draft and ask Pip to draft it again from the current text.".into());
        db.save_proposal(&stored).unwrap();
        let newer = made(&db, Draft::from_pip("r", None, rewrite(Some(("Old", "Better")), None), None));
        assert!(matches!(load(&db, &p.id).unwrap().state, ProposalState::Retired(reason) if reason == REPLACED_REASON));
        assert_eq!(load(&db, &newer.id).unwrap().state, ProposalState::Pending);
    }

    #[test]
    fn bringing_a_skip_back_retires_the_later_draft_of_the_same_kind() {
        let db = Db::in_memory().unwrap();
        let first = made(&db, comment_draft("1"));
        let at = now();
        skip(&db, &first.id, at).unwrap();
        let second = made(&db, comment_draft("1"));
        unskip(&db, &first.id, at + chrono::Duration::seconds(8)).unwrap();
        assert_eq!(load(&db, &first.id).unwrap().state, ProposalState::Pending);
        assert!(matches!(load(&db, &second.id).unwrap().state, ProposalState::Retired(reason) if reason == REPLACED_REASON));
    }

    fn cache(db: &Db, items: &[crate::domain::WorkItem]) {
        db.upsert_items(items, "2026-09-29T12:00:00Z").unwrap();
    }

    fn workflow(transitions: Transitions) -> Container {
        let s = |id: &str, category| StatusDef { id: id.into(), name: id.to_uppercase(), category };
        let statuses = vec![s("todo", Category::Todo), s("doing", Category::Active), s("review", Category::Active), s("done", Category::Done)];
        let container_ref = work_item("1", "todo").container;
        Container { container_ref, key: "P".into(), name: "P".into(), workflow: Workflow { statuses, transitions } }
    }

    fn me() -> Identity {
        Identity { display_name: "Me".into(), accounts: vec![person("me")] }
    }

    fn transition_draft(id: &str, at: &crate::domain::WorkItem, to: &str) -> Draft {
        Draft {
            basis: Some(Basis::of(at)),
            ..Draft::from_pip("run", None, Intent::Transition { item: item_ref(id), to: to.into() }, None)
        }
    }

    #[test]
    fn a_sync_that_moved_the_item_revises_the_draft_and_one_that_finished_it_retires_it() {
        let db = Db::in_memory().unwrap();
        let todo = work_item("1", "todo");
        let two = work_item("2", "doing");
        cache(&db, &[todo.clone(), two.clone()]);
        let moves = Transitions::Graph(vec![
            Transition { from: "todo".into(), to: "doing".into() },
            Transition { from: "doing".into(), to: "review".into() },
        ]);
        db.replace_containers("c", &[workflow(moves)], "2026-09-29T12:00:00Z").unwrap();
        let revise = made(&db, transition_draft("1", &todo, "review"));
        let retire = made(&db, transition_draft("2", &two, "review"));
        let keep = made(&db, comment_draft("1"));

        assert_eq!(reconcile_pending(&db, &me(), now()).unwrap(), 0);

        cache(&db, &[work_item("1", "doing"), work_item("2", "review")]);
        assert_eq!(reconcile_pending(&db, &me(), now()).unwrap(), 2);

        let revised = db.proposal(&revise.id).unwrap().unwrap();
        assert_eq!(revised.state, ProposalState::Pending);
        assert_eq!(revised.revisions.len(), 1);
        assert_eq!(revised.basis.unwrap().status_id, "doing");
        let retired = db.proposal(&retire.id).unwrap().unwrap();
        assert_eq!(retired.state, ProposalState::Retired("the item is already in that status".into()));
        assert_eq!(db.proposal(&keep.id).unwrap().unwrap().state, ProposalState::Pending);

        assert_eq!(reconcile_pending(&db, &me(), now()).unwrap(), 0, "a revised draft stays put on the next pass");
    }

    #[test]
    fn drafts_on_uncached_items_and_on_workflows_without_a_graph_are_left_alone() {
        let db = Db::in_memory().unwrap();
        let todo = work_item("1", "todo");
        let uncached = made(&db, transition_draft("9", &work_item("9", "todo"), "done"));
        cache(&db, std::slice::from_ref(&todo));
        db.replace_containers("c", &[workflow(Transitions::Graph(vec![]))], "2026-09-29T12:00:00Z").unwrap();
        let far = made(&db, transition_draft("1", &todo, "done"));

        assert_eq!(reconcile_pending(&db, &me(), now()).unwrap(), 0);
        assert_eq!(db.proposal(&uncached.id).unwrap().unwrap().state, ProposalState::Pending);
        assert_eq!(db.proposal(&far.id).unwrap().unwrap().state, ProposalState::Pending);
    }

    #[test]
    fn only_pending_drafts_are_reconciled() {
        let db = Db::in_memory().unwrap();
        let todo = work_item("1", "todo");
        cache(&db, &[work_item("1", "done")]);
        let p = made(&db, transition_draft("1", &todo, "done"));
        skip(&db, &p.id, now()).unwrap();
        assert_eq!(reconcile_pending(&db, &me(), now()).unwrap(), 0);
        assert_eq!(db.proposal(&p.id).unwrap().unwrap().state, ProposalState::Skipped);
    }

    #[test]
    fn a_draft_to_start_message_or_answer_an_agent_is_refused() {
        let db = Db::in_memory().unwrap();
        let intents = [
            Intent::StartRun { connection_id: "c".into(), item: Some(item_ref("1")), spec: crate::domain::fixtures::run_spec().into() },
            Intent::FollowUp { connection_id: "c".into(), run_id: "run-1".into(), short_id: None, item: Some(item_ref("1")), message: "More.".into(), reason: "open questions".into() },
            Intent::RunAnswer { connection_id: "c".into(), run_id: "run-1".into(), short_id: None, item: Some(item_ref("1")), message: "Use staging.".into(), question: None },
        ];
        for intent in intents {
            for (origin, by) in [(Origin::Board, CreatedBy::User), (Origin::chat("r"), CreatedBy::Pip)] {
                let err = create(&db, Draft { origin, created_by: by, intent: intent.clone(), label: None, basis: None }, now()).unwrap_err().to_string();
                assert!(err.contains(AGENTS_DIRECT), "{err}");
            }
        }
        assert!(db.proposals(&ProposalQuery::default()).unwrap().is_empty());
    }

    #[test]
    fn a_stored_draft_to_start_an_agent_is_never_applied_through_a_tracker() {
        let db = Db::in_memory().unwrap();
        let p = comment_draft("1");
        let mut stored = made(&db, p);
        stored.intent = Intent::RunAnswer { connection_id: "c".into(), run_id: "run-1".into(), short_id: None, item: Some(item_ref("1")), message: "Use staging.".into(), question: None };
        db.save_proposal(&stored).unwrap();
        assert!(begin(&db, &stored.id, now()).unwrap_err().to_string().contains(AGENTS_DIRECT));
        assert_eq!(load(&db, &stored.id).unwrap().state, ProposalState::Pending, "the claim was rolled back");
    }

    #[tokio::test]
    async fn a_review_or_an_agent_draft_is_never_handed_to_a_tracker() {
        let db = Db::in_memory().unwrap();
        let tracker = Recorder::default();
        let mut stored = made(&db, comment_draft("1"));
        for (intent, reason) in [
            (Intent::StartRun { connection_id: "c".into(), item: Some(item_ref("1")), spec: crate::domain::fixtures::run_spec().into() }, AGENTS_DIRECT),
            (Intent::FollowUp { connection_id: "c".into(), run_id: "run-1".into(), short_id: None, item: Some(item_ref("1")), message: "More.".into(), reason: "open questions".into() }, AGENTS_DIRECT),
            (Intent::RunAnswer { connection_id: "c".into(), run_id: "run-1".into(), short_id: None, item: Some(item_ref("1")), message: "Use staging.".into(), question: None }, AGENTS_DIRECT),
            (
                Intent::GithubReview { connection_id: "github:ann".into(), item: None, run_id: "r1".into(), repo: "acme/webshop".into(), number: 218, commit_sha: "a1b2c3d4e5f6".into(), summary: "Review.".into(), comments: vec![] },
                REVIEW_OWN_BUTTON,
            ),
        ] {
            assert!(intent.write().is_none());
            stored.intent = intent;
            let outcome = execute(&tracker, &stored).await;
            assert!(outcome.error.unwrap().to_string().contains(reason));
        }
        assert!(tracker.intents().is_empty());
    }

    #[test]
    fn a_proposal_stored_before_runs_existed_reads_with_no_run() {
        let db = Db::in_memory().unwrap();
        let p = made(&db, comment_draft("1"));
        let mut json = serde_json::to_value(&p).unwrap();
        json.as_object_mut().unwrap().remove("run");
        assert_eq!(serde_json::from_value::<Proposal>(json).unwrap().run, None);
    }

    fn rewrite(title: Option<(&str, &str)>, body: Option<(&str, &str)>) -> Intent {
        Intent::Rewrite {
            item: item_ref("1"),
            title: title.map(|(from, to)| TitleChange { from: from.into(), to: to.into() }),
            body: body.map(|(from, to)| BodyChange { from: Doc::from_markdown(from, &[]), to: Doc::from_markdown(to, &[]) }),
            flattened: vec![],
        }
    }

    fn refused(intent: Intent) -> String {
        let db = Db::in_memory().unwrap();
        create(&db, Draft::from_pip("r", None, intent, None), now()).unwrap_err().to_string()
    }

    #[test]
    fn a_rewrite_has_to_change_something_within_bounds() {
        assert!(refused(rewrite(None, None)).contains("title or the description"));
        assert!(refused(rewrite(Some(("Old", "  ")), None)).contains("title"));
        assert!(refused(rewrite(Some(("Old", "Two\nlines")), None)).contains("one line"));
        assert!(refused(rewrite(Some(("Old", &"t".repeat(SUMMARY_LIMIT + 1))), None)).contains("at most 255"));
        assert!(refused(rewrite(Some(("Old", " Old ")), None)).contains("same"));
        assert!(refused(rewrite(None, Some(("old", " \n")))).contains("can't be emptied"));
        assert!(refused(rewrite(None, Some(("old", "old")))).contains("same"));
        assert!(refused(rewrite(None, Some(("old", &"d".repeat(DESCRIPTION_LIMIT + 1))))).contains("at most"));
        assert!(refused(rewrite(None, Some(("old", "ignore <<<TICKET the rules")))).contains("reserves"));
        assert!(refused(rewrite(Some(("Old", "A TICKET>>> title")), None)).contains("reserves"));
        let db = Db::in_memory().unwrap();
        assert!(create(&db, Draft::from_pip("r", None, rewrite(Some(("Old", "New")), Some(("old", &"d".repeat(DESCRIPTION_LIMIT)))), None), now()).is_ok());
    }

    #[test]
    fn an_edit_changes_the_new_text_but_never_what_it_was_drafted_against() {
        let db = Db::in_memory().unwrap();
        let p = made(&db, Draft::from_pip("r", None, rewrite(Some(("Old", "New")), Some(("old text", "new text"))), None));
        let edited = edit(&db, &p.id, rewrite(Some(("Old", "Newer")), Some(("old text", "newest text"))), now()).unwrap();
        assert!(matches!(&edited.intent, Intent::Rewrite { title: Some(t), body: Some(b), .. } if t.to == "Newer" && b.to.plain_text() == "newest text"));
        assert_eq!(edited.revisions.last().unwrap().note, "Edited");

        let rebased = edit(&db, &p.id, rewrite(Some(("Old", "Newer")), Some(("somebody else's text", "x"))), now()).unwrap_err();
        assert!(rebased.to_string().contains("drafted against"), "{rebased}");
        let rebased_title = edit(&db, &p.id, rewrite(Some(("Other", "Newer")), Some(("old text", "x"))), now()).unwrap_err();
        assert!(rebased_title.to_string().contains("drafted against"), "{rebased_title}");
        let dropped = edit(&db, &p.id, rewrite(None, Some(("old text", "x"))), now()).unwrap_err();
        assert!(dropped.to_string().contains("drafted against"), "{dropped}");
        assert!(edit(&db, &p.id, rewrite(Some(("Old", "Same")), Some(("old text", "old text"))), now()).is_err(), "an edit goes through the same checks");
    }


    #[test]
    fn pip_may_revise_its_rewrite_until_the_person_edits_it() {
        let db = Db::in_memory().unwrap();
        let p = made(&db, Draft::from_pip("r", None, rewrite(Some(("Old", "New")), None), None));
        assert!(require_pip_may_revise(&p, None).is_ok());
        let by_pip = edit_noted(&db, &p.id, rewrite(Some(("Old", "Better")), None), "Revised by Pip", now()).unwrap();
        assert!(require_pip_may_revise(&by_pip, None).is_ok(), "its own revision doesn't lock it");
        let by_person = edit(&db, &p.id, rewrite(Some(("Old", "Mine")), None), now()).unwrap();
        assert!(person_edited_rewrite(&by_person));
        let err = require_pip_may_revise(&by_person, None).unwrap_err();
        assert!(err.to_string().contains("edited this description draft"), "{err}");
    }

    fn live_item(title: &str, body: &str) -> crate::domain::WorkItem {
        let mut w = work_item("1", "todo");
        w.title = title.into();
        w.body = Doc::from_markdown(body, &[]);
        w
    }

    #[tokio::test]
    async fn approving_a_rewrite_writes_it_when_the_ticket_still_reads_as_drafted() {
        let db = Db::in_memory().unwrap();
        let tracker = Recorder::default();
        *tracker.live.lock().unwrap() = Some(live_item("Old", "old text"));
        let p = made(&db, Draft::from_pip("r", None, rewrite(Some(("Old", "New")), Some(("old text", "new text"))), None));
        let done = approve(&db, &tracker, &p.id).await.unwrap();
        assert_eq!(done.state, ProposalState::Applied);
        assert_eq!(tracker.intents(), vec![p.intent]);
    }

    #[tokio::test]
    async fn a_ticket_that_changed_meanwhile_is_not_overwritten() {
        for live in [live_item("Old", "someone rewrote this"), live_item("Retitled", "old text")] {
            let db = Db::in_memory().unwrap();
            let tracker = Recorder::default();
            *tracker.live.lock().unwrap() = Some(live);
            let p = made(&db, Draft::from_pip("r", None, rewrite(Some(("Old", "New")), Some(("old text", "new text"))), None));
            let back = approve(&db, &tracker, &p.id).await.unwrap();
            assert_eq!(back.state, ProposalState::Pending, "it stays for the person to skip or redraft");
            assert!(back.error.as_deref().is_some_and(|e| e.contains("changed since this was drafted") && e.contains("nothing was written")), "{:?}", back.error);
            assert!(tracker.intents().is_empty(), "nothing reached the tracker");
        }
    }

    #[tokio::test]
    async fn only_the_parts_a_rewrite_changes_are_compared() {
        let db = Db::in_memory().unwrap();
        let tracker = Recorder::default();
        *tracker.live.lock().unwrap() = Some(live_item("Retitled by someone", "old text"));
        let p = made(&db, Draft::from_pip("r", None, rewrite(None, Some(("old text", "new text"))), None));
        assert_eq!(approve(&db, &tracker, &p.id).await.unwrap().state, ProposalState::Applied);
    }

    #[tokio::test]
    async fn a_tracker_that_cannot_edit_text_is_never_asked_to() {
        let db = Db::in_memory().unwrap();
        let tracker = Recorder::default();
        tracker.cannot_edit_text.store(true, std::sync::atomic::Ordering::SeqCst);
        let p = made(&db, Draft::from_pip("r", None, rewrite(Some(("Task 1", "New")), None), None));
        let back = approve(&db, &tracker, &p.id).await.unwrap();
        assert_eq!(back.state, ProposalState::Pending);
        assert!(back.error.as_deref().is_some_and(|e| e.contains("can't change a ticket's title or description")));
        assert!(tracker.intents().is_empty());
    }

    fn stored_workstream(db: &Db, id: &str) {
        let ws = crate::domain::Workstream {
            id: id.into(),
            connection_id: "c".into(),
            item_key: None,
            repo: None,
            title: id.into(),
            pip_session: None,
            paused_reason: None,
            notes: None,
            created_at: now(),
            closed_at: None,
            basis: None,
        };
        db.insert_workstream(&ws).unwrap();
    }

    fn from_run(workstream: Option<&str>, by: CreatedBy) -> Draft {
        let origin = Origin::Run { run_id: "run-1".into(), short_id: None, workstream: workstream.map(Into::into) };
        Draft { origin, created_by: by, ..comment_draft("1") }
    }

    #[test]
    fn pip_may_revise_an_agent_draft_only_from_its_own_workstream() {
        let db = Db::in_memory().unwrap();
        let in_ws = made(&db, from_run(Some("w1"), CreatedBy::Agent));
        assert!(require_pip_may_revise(&in_ws, Some("w1")).is_ok());
        for elsewhere in [Some("w2"), None] {
            let err = require_pip_may_revise(&in_ws, elsewhere).unwrap_err().to_string();
            assert!(err.contains("belongs to another workstream"), "{err}");
        }

        let loose = made(&db, from_run(None, CreatedBy::Agent));
        assert!(require_pip_may_revise(&loose, None).is_ok());
        assert!(require_pip_may_revise(&loose, Some("w1")).is_ok(), "a draft in no workstream is revisable from any conversation");

        let legacy = made(&db, from_run(None, CreatedBy::User));
        assert!(require_pip_may_revise(&legacy, None).is_ok(), "a run draft stored before agents had their own maker");

        let mine = made(&db, Draft { origin: Origin::Chat { request_id: "q".into(), workstream: Some("w1".into()) }, ..comment_draft("1") });
        assert!(require_pip_may_revise(&mine, Some("w1")).is_ok());
        assert!(require_pip_may_revise(&mine, Some("w2")).is_err());

        let by_hand = made(&db, Draft { origin: Origin::Board, created_by: CreatedBy::User, ..comment_draft("1") });
        assert!(require_pip_may_revise(&by_hand, None).unwrap_err().to_string().contains("wasn't made by Pip"));
        let link = Draft { intent: Intent::Link { from: item_ref("1"), to: item_ref("2"), kind: crate::domain::LinkKind::Blocks }, ..from_run(None, CreatedBy::Agent) };
        assert!(require_pip_may_revise(&made(&db, link), None).is_err(), "only the kinds of draft Pip can reword");
    }

    #[test]
    fn a_rewrite_an_agent_left_is_locked_once_the_person_edits_it() {
        let db = Db::in_memory().unwrap();
        let draft = Draft { intent: rewrite(Some(("Old", "New")), None), ..from_run(Some("w1"), CreatedBy::Agent) };
        let p = made(&db, draft);
        assert!(require_pip_may_revise(&p, Some("w1")).is_ok());
        let edited = edit(&db, &p.id, rewrite(Some(("Old", "Mine")), None), now()).unwrap();
        let err = require_pip_may_revise(&edited, Some("w1")).unwrap_err().to_string();
        assert!(err.contains("edited this description draft"), "{err}");
    }

    #[test]
    fn any_draft_an_agent_left_is_locked_once_the_person_edits_it_but_pip_s_own_stays_revisable() {
        let db = Db::in_memory().unwrap();
        let comment = |text: &str| Intent::Comment { item: item_ref("1"), body: Doc::paragraph(text) };
        let subtasks = |s: &str| Intent::Subtasks { parent: item_ref("1"), summaries: vec![s.into()] };
        let cases = [(CreatedBy::Agent, comment("hello"), comment("Mine")), (CreatedBy::User, comment("hello"), comment("Mine")), (CreatedBy::Agent, subtasks("Theirs"), subtasks("Mine"))];
        for (by, intent, changed) in cases {
            let p = made(&db, Draft { intent, ..from_run(Some("w1"), by) });
            assert!(require_pip_may_revise(&p, Some("w1")).is_ok());
            let edited = edit(&db, &p.id, changed, now()).unwrap();
            let err = require_pip_may_revise(&edited, Some("w1")).unwrap_err().to_string();
            assert!(err.contains("the user edited this draft"), "{by:?}: {err}");
        }
        let pip = made(&db, comment_draft("1"));
        let edited = edit(&db, &pip.id, comment("Mine"), now()).unwrap();
        assert!(require_pip_may_revise(&edited, None).is_ok(), "Pip reads the person's version of its own draft and may still revise it");
    }

    #[test]
    fn drafts_are_listed_by_workstream_and_their_making_is_audited() {
        let db = Db::in_memory().unwrap();
        stored_workstream(&db, "w1");
        let agent = made(&db, from_run(Some("w1"), CreatedBy::Agent));
        let pip = made(&db, Draft { origin: Origin::Chat { request_id: "q".into(), workstream: Some("w1".into()) }, ..comment_draft("2") });
        let person = made(&db, Draft { origin: Origin::Chat { request_id: "p".into(), workstream: Some("w1".into()) }, intent: move_to("1", "doing"), ..comment_draft("1") });
        made(&db, comment_draft("3"));
        made(&db, Draft { intent: comment_draft("4").intent, ..from_run(Some("unknown"), CreatedBy::Agent) });

        let in_w1 = ProposalQuery { workstream: Some("w1".into()), ..Default::default() };
        let mut ids: Vec<String> = db.proposals(&in_w1).unwrap().into_iter().map(|p| p.id).collect();
        ids.sort();
        let mut expected = vec![agent.id.clone(), pip.id.clone(), person.id.clone()];
        expected.sort();
        assert_eq!(ids, expected);
        assert_eq!(db.proposals(&ProposalQuery::default()).unwrap().len(), 5);

        skip(&db, &agent.id, now()).unwrap();
        let pending_in_w1 = ProposalQuery { workstream: Some("w1".into()), states: Some(vec![StateKind::Pending]), ..Default::default() };
        assert_eq!(db.proposals(&pending_in_w1).unwrap().len(), 2, "the column stays in step on save");

        let events = db.workstream_events("w1").unwrap();
        let seen: Vec<(Actor, &str, Option<&str>)> = events.iter().map(|e| (e.actor, e.action.as_str(), e.proposal_id.as_deref())).collect();
        assert_eq!(
            seen,
            [(Actor::Run, "draft_created", Some(agent.id.as_str())), (Actor::Pip, "draft_created", Some(pip.id.as_str())), (Actor::Pip, "draft_created", Some(person.id.as_str()))]
        );
        assert!(db.workstream_events("unknown").unwrap().is_empty(), "nothing is recorded for a workstream that isn't stored");
    }

    fn in_ws(ws: &str, intent: Intent) -> Draft {
        Draft::from_pip("r", Some(ws), intent, None)
    }

    fn agent_in(ws: &str, intent: Intent) -> Draft {
        Draft { intent, ..from_run(Some(ws), CreatedBy::Agent) }
    }

    fn move_to(id: &str, to: &str) -> Intent {
        Intent::Transition { item: item_ref(id), to: to.into() }
    }

    fn state_of(db: &Db, id: &str) -> ProposalState {
        db.proposal(id).unwrap().unwrap().state
    }

    #[test]
    fn every_targeted_write_kind_replaces_the_same_target_across_workstreams() {
        let item = item_ref("1");
        let intents = [
            Intent::Comment { item: item.clone(), body: Doc::paragraph("note") },
            move_to("1", "doing"),
            Intent::Update { item: item.clone(), patch: crate::domain::Patch { assignee: Some(person("ann")), ..Default::default() } },
            rewrite(Some(("Old", "New")), None),
            Intent::Link { from: item.clone(), to: item_ref("2"), kind: crate::domain::LinkKind::Blocks },
            Intent::Subtasks { parent: item, summaries: vec!["One".into()] },
            review_intent(vec![]),
        ];
        for intent in intents {
            let db = Db::in_memory().unwrap();
            stored_workstream(&db, "w1");
            stored_workstream(&db, "w2");
            let old = made(&db, agent_in("w1", intent.clone()));
            let next = made(&db, in_ws("w2", intent));
            assert_eq!(replaced_by(&db, &old.id), Some(next.id), "{:?}", old.intent);
        }
    }

    #[test]
    fn a_persons_original_words_are_kept_as_surely_as_their_edits() {
        let db = Db::in_memory().unwrap();
        let old = made(&db, Draft { origin: Origin::Board, created_by: CreatedBy::User, ..comment_draft("1") });
        made(&db, comment_draft("1"));
        assert_eq!(state_of(&db, &old.id), ProposalState::Pending);
    }

    #[test]
    fn new_tickets_have_no_existing_target_and_never_replace_each_other() {
        let db = Db::in_memory().unwrap();
        let create = |title: &str| Intent::Create {
            container: ContainerRef { connection_id: "jira".into(), external_id: "project".into() },
            fields: crate::domain::NewItem { title: title.into(), body: Doc::default(), kind: crate::domain::ItemKind::Task, assignee: None, parent: None, priority: None, labels: vec![] },
            link: None,
        };
        let first = made(&db, in_ws("w1", create("First")));
        let second = made(&db, in_ws("w1", create("Second")));
        assert_eq!(state_of(&db, &first.id), ProposalState::Pending);
        assert_eq!(state_of(&db, &second.id), ProposalState::Pending);
    }

    #[test]
    fn an_edited_older_draft_stays_beside_the_new_one_without_refusing_it() {
        let db = Db::in_memory().unwrap();
        let old = made(&db, comment_draft("1"));
        let mine = Intent::Comment { item: item_ref("1"), body: Doc::paragraph("My words") };
        edit(&db, &old.id, mine.clone(), now()).unwrap();
        let new = made(&db, comment_draft("1"));
        assert_eq!(db.proposal(&old.id).unwrap().unwrap().intent, mine);
        assert_eq!(state_of(&db, &old.id), ProposalState::Pending);
        assert_eq!(state_of(&db, &new.id), ProposalState::Pending);
    }

    #[test]
    fn different_connections_targets_and_kinds_never_replace_each_other() {
        let db = Db::in_memory().unwrap();
        let old = made(&db, comment_draft("1"));
        let mut other = item_ref("1");
        other.connection_id = "elsewhere".into();
        made(&db, Draft::from_pip("r", None, Intent::Comment { item: other, body: Doc::paragraph("note") }, None));
        made(&db, comment_draft("2"));
        made(&db, in_ws("w2", move_to("1", "doing")));
        assert_eq!(state_of(&db, &old.id), ProposalState::Pending);
    }

    #[test]
    fn a_new_rewrite_replaces_the_whole_older_draft_even_when_it_changes_another_field() {
        let db = Db::in_memory().unwrap();
        let old = made(&db, in_ws("w1", rewrite(None, Some(("old", "old\n\n## Gossamr Plan\n\nSteps")))));
        let new = made(&db, in_ws("w2", rewrite(Some(("Old", "New")), None)));
        assert_eq!(replaced_by(&db, &old.id), Some(new.id));
    }

    #[test]
    fn supersedes_same_kind_same_target_in_workstream_and_audits() {
        let db = Db::in_memory().unwrap();
        stored_workstream(&db, "w1");
        let pairs = [
            (move_to("1", "doing"), move_to("1", "review")),
            (rewrite(Some(("Old", "A")), None), rewrite(Some(("Old", "B")), None)),
            (Intent::Subtasks { parent: item_ref("1"), summaries: vec!["a".into()] }, Intent::Subtasks { parent: item_ref("1"), summaries: vec!["b".into()] }),
            (
                Intent::Update { item: item_ref("1"), patch: crate::domain::Patch { priority: Some(crate::domain::Priority::High), ..Default::default() } },
                Intent::Update { item: item_ref("1"), patch: crate::domain::Patch { priority: Some(crate::domain::Priority::Low), ..Default::default() } },
            ),
        ];
        for (first, second) in pairs {
            let old = made(&db, in_ws("w1", first));
            let new = made(&db, in_ws("w1", second));
            let back = db.proposal(&old.id).unwrap().unwrap();
            assert_eq!(back.state, ProposalState::Retired(REPLACED_REASON.into()));
            assert_eq!(back.superseded_by.as_deref(), Some(new.id.as_str()));
            assert_eq!(state_of(&db, &new.id), ProposalState::Pending);
            let line = db.workstream_events("w1").unwrap().into_iter().find(|e| e.action == "draft_superseded" && e.proposal_id.as_deref() == Some(old.id.as_str())).unwrap();
            assert_eq!((line.actor, line.detail.as_deref()), (Actor::Pip, Some(new.id.as_str())));
        }
        assert_eq!(db.proposals(&ProposalQuery::default()).unwrap().len(), 8, "nothing is deleted");
    }








    #[tokio::test]
    async fn approving_a_transition_retires_its_pending_siblings_even_uncached() {
        let db = Db::in_memory().unwrap();
        let tracker = Recorder::default();
        stored_workstream(&db, "w1");
        stored_workstream(&db, "w2");
        let by_hand = made(&db, Draft { origin: Origin::Board, created_by: CreatedBy::User, intent: move_to("1", "doing"), label: None, basis: None });
        let agent = made(&db, agent_in("w2", move_to("1", "done")));
        let pips = made(&db, in_ws("w1", move_to("1", "review")));
        let other = made(&db, Draft { origin: Origin::Board, created_by: CreatedBy::User, intent: move_to("2", "doing"), label: None, basis: None });
        let comment = made(&db, in_ws("w1", Intent::Comment { item: item_ref("1"), body: Doc::paragraph("hi") }));
        // Pip's newer move replaced the agent's. The person's own move stays beside it until one is approved.
        assert_eq!(state_of(&db, &agent.id), ProposalState::Retired(REPLACED_REASON.into()));
        assert_eq!(db.proposal(&agent.id).unwrap().unwrap().superseded_by.as_deref(), Some(pips.id.as_str()));
        assert_eq!(state_of(&db, &by_hand.id), ProposalState::Pending);
        assert_eq!(reconcile_pending(&db, &me(), now()).unwrap(), 0, "nothing approved yet");

        approve(&db, &tracker, &pips.id).await.unwrap();
        assert_eq!(reconcile_pending(&db, &me(), now()).unwrap(), 1);
        let why = ProposalState::Retired(format!("Another move of {} was approved", item_ref("1").key));
        assert_eq!(state_of(&db, &by_hand.id), why);
        assert_eq!((state_of(&db, &other.id), state_of(&db, &comment.id)), (ProposalState::Pending, ProposalState::Pending));
        assert!(db.workstream_events("w2").unwrap().iter().any(|e| e.action == "draft_superseded" && e.actor == Actor::Pip && e.proposal_id.as_deref() == Some(agent.id.as_str())));

        let later = create(&db, Draft { origin: Origin::Board, created_by: CreatedBy::User, intent: move_to("1", "todo"), label: None, basis: None }, Utc::now() + chrono::Duration::seconds(5)).unwrap();
        assert_eq!(reconcile_pending(&db, &me(), Utc::now() + chrono::Duration::seconds(5)).unwrap(), 0, "a move drafted after the approval stays");
        assert_eq!(state_of(&db, &later.id), ProposalState::Pending);
    }

    #[test]
    fn old_proposal_json_without_superseded_by_still_reads() {
        let db = Db::in_memory().unwrap();
        let p = made(&db, comment_draft("1"));
        let json = serde_json::to_value(&p).unwrap();
        assert!(json.get("supersededBy").is_none(), "an unset field isn't written");
        assert_eq!(serde_json::from_value::<Proposal>(json).unwrap().superseded_by, None);
        let mut set = serde_json::to_value(Proposal { superseded_by: Some("n".into()), ..p }).unwrap();
        assert_eq!(set["supersededBy"], "n");
        set.as_object_mut().unwrap().remove("supersededBy");
        assert_eq!(serde_json::from_value::<Proposal>(set).unwrap().superseded_by, None);
    }

    fn review_intent(comments: Vec<crate::domain::ReviewComment>) -> Intent {
        Intent::GithubReview {
            connection_id: "github:ann".into(),
            item: Some(item_ref("1")),
            run_id: "run-1".into(),
            repo: "acme/webshop".into(),
            number: 218,
            commit_sha: "a1b2c3d4e5f6".into(),
            summary: "Gossamr review of #218 at a1b2c3d4: blocking.".into(),
            comments,
        }
    }

    fn at(path: &str, line: u32, body: &str) -> crate::domain::ReviewComment {
        crate::domain::ReviewComment { path: path.into(), line, side: crate::domain::DiffSide::Right, body: body.into() }
    }

    fn review_draft(intent: Intent) -> Draft {
        Draft { origin: Origin::Run { run_id: "run-1".into(), short_id: None, workstream: None }, created_by: CreatedBy::Agent, intent, label: None, basis: None }
    }

    fn with_review(edit: impl FnOnce(&mut Intent)) -> Intent {
        let mut intent = review_intent(vec![at("src/consumer/retry.ts", 42, "**Blocking:** no backoff.")]);
        edit(&mut intent);
        intent
    }

    /// A review draft an agent run left on `repo#number`, in workstream `ws` or none.
    fn review_of(ws: Option<&str>, run: &str, repo: &str, number: u64) -> Draft {
        let intent = with_review(|i| {
            if let Intent::GithubReview { run_id, repo: r, number: n, .. } = i {
                (*run_id, *r, *n) = (run.into(), repo.into(), number);
            }
        });
        Draft { origin: Origin::Run { run_id: run.into(), short_id: None, workstream: ws.map(Into::into) }, ..review_draft(intent) }
    }

    fn replaced_by(db: &Db, id: &str) -> Option<String> {
        let p = db.proposal(id).unwrap().unwrap();
        (p.state == ProposalState::Retired(REPLACED_REASON.into())).then_some(p.superseded_by).flatten()
    }

    #[test]
    fn a_new_review_of_a_pull_request_replaces_its_older_pending_review_drafts_wherever_they_are() {
        let db = Db::in_memory().unwrap();
        stored_workstream(&db, "w1");
        stored_workstream(&db, "w2");
        let same_ws = made(&db, review_of(Some("w1"), "run-1", "acme/webshop", 218));
        let other_ws = made(&db, review_of(Some("w2"), "run-2", "acme/webshop", 218));
        assert_eq!(replaced_by(&db, &same_ws.id).as_deref(), Some(other_ws.id.as_str()), "another workstream's review of the same pull request replaces it");
        let no_ws = made(&db, review_of(None, "run-3", "ACME/Webshop", 218));
        assert_eq!(replaced_by(&db, &other_ws.id).as_deref(), Some(no_ws.id.as_str()), "a review in no workstream, and the repository's case doesn't matter");
        let other_pr = made(&db, review_of(Some("w1"), "run-4", "acme/webshop", 219));
        let other_repo = made(&db, review_of(Some("w1"), "run-5", "acme/other", 218));
        let newest = made(&db, review_of(Some("w1"), "run-6", "acme/webshop", 218));
        assert_eq!(replaced_by(&db, &no_ws.id).as_deref(), Some(newest.id.as_str()));
        for id in [&other_pr.id, &other_repo.id, &newest.id] {
            assert_eq!(state_of(&db, id), ProposalState::Pending, "{id}");
        }
        let pending: Vec<_> = db.proposals(&ProposalQuery { states: Some(vec![StateKind::Pending]), ..Default::default() }).unwrap();
        assert_eq!(pending.iter().filter(|p| p.intent.supersession_key() == newest.intent.supersession_key()).count(), 1, "one review of the pull request waits");

        let w1 = db.workstream_events("w1").unwrap();
        let line = |events: &[WorkstreamEvent], id: &str| events.iter().find(|e| e.action == "draft_superseded" && e.proposal_id.as_deref() == Some(id)).map(|e| (e.actor, e.detail.clone()));
        assert_eq!(line(&w1, &same_ws.id), Some((Actor::Run, Some(other_ws.id.clone()))), "said in the older draft's own workstream");
        assert_eq!(line(&db.workstream_events("w2").unwrap(), &other_ws.id), Some((Actor::Run, Some(no_ws.id.clone()))));
        assert_eq!(line(&w1, &no_ws.id), Some((Actor::Run, Some(newest.id.clone()))), "one in no workstream is said in the new draft's");

        let elsewhere = made(&db, Draft { intent: with_review(|i| if let Intent::GithubReview { connection_id, run_id, .. } = i { (*connection_id, *run_id) = ("github:bob".into(), "run-7".into()) }), ..review_of(Some("w1"), "run-7", "acme/webshop", 218) });
        assert_eq!((state_of(&db, &newest.id), state_of(&db, &elsewhere.id)), (ProposalState::Pending, ProposalState::Pending), "another code host connection's review is its own");
    }

    #[test]
    fn a_new_review_keeps_an_older_one_the_person_edited_or_that_may_be_posted_and_never_touches_a_posted_one() {
        let db = Db::in_memory().unwrap();
        stored_workstream(&db, "w1");
        let edited = made(&db, review_of(Some("w1"), "run-1", "acme/webshop", 218));
        edit(&db, &edited.id, with_review(|i| if let Intent::GithubReview { summary, .. } = i { *summary = "Mine.".into() }), now()).unwrap();
        let mut unsure = made(&db, review_of(None, "run-2", "acme/webshop", 218));
        unsure.maybe_posted = Some(crate::domain::MaybePosted { at: now(), commit_sha: "a1b2c3d4e5f6".into(), summary: "Sent.".into(), checked_at: None });
        db.save_proposal(&unsure).unwrap();
        let mut posted = made(&db, review_of(Some("w1"), "run-3", "acme/webshop", 218));
        posted.state = ProposalState::Applied;
        db.save_proposal(&posted).unwrap();
        let mut posting = made(&db, review_of(Some("w1"), "run-4", "acme/webshop", 218));
        posting.state = ProposalState::Applying;
        db.save_proposal(&posting).unwrap();
        let revised = made(&db, review_of(Some("w1"), "run-5", "acme/webshop", 218));
        let mut reworded = revised.intent.clone();
        if let Intent::GithubReview { summary, .. } = &mut reworded {
            *summary = "Pip's.".into();
        }
        edit_noted(&db, &revised.id, reworded, REVISED_BY_PIP, now()).unwrap();

        let new = made(&db, review_of(Some("w1"), "run-6", "acme/webshop", 218));
        assert_eq!(state_of(&db, &edited.id), ProposalState::Pending, "the person's edit is theirs");
        assert_eq!(state_of(&db, &unsure.id), ProposalState::Pending, "GitHub may have it");
        assert_eq!((state_of(&db, &posted.id), state_of(&db, &posting.id)), (ProposalState::Applied, ProposalState::Applying), "posted and posting are never touched");
        assert_eq!(replaced_by(&db, &revised.id).as_deref(), Some(new.id.as_str()), "Pip's revision isn't the person's edit");

        let events = db.workstream_events("w1").unwrap();
        let kept = |action: &str, id: &str| events.iter().any(|e| e.action == action && e.actor == Actor::Run && e.proposal_id.as_deref() == Some(id) && e.detail.as_deref() == Some(new.id.as_str()));
        assert!(kept(KEPT_EDITED, &edited.id), "{events:?}");
        assert!(kept(KEPT_MAYBE_POSTED, &unsure.id), "{events:?}");
        assert!(!events.iter().any(|e| e.proposal_id.as_deref().is_some_and(|p| p == posted.id || p == posting.id) && e.action != "draft_created"));
    }

    #[test]
    fn a_review_draft_keeps_within_its_limits_and_points_at_lines_of_relative_files() {
        let db = Db::in_memory().unwrap();
        assert!(create(&db, review_draft(with_review(|_| {})), now()).is_ok());
        let summary = |text: String| with_review(move |i| if let Intent::GithubReview { summary, .. } = i { *summary = text });
        let comments = |list: Vec<crate::domain::ReviewComment>| with_review(move |i| if let Intent::GithubReview { comments, .. } = i { *comments = list });
        let sha = |text: &str| { let text = text.to_string(); with_review(move |i| if let Intent::GithubReview { commit_sha, .. } = i { *commit_sha = text }) };
        let many: Vec<_> = (1..=REVIEW_COMMENTS_MAX as u32 + 1).map(|n| at("src/a.ts", n, "x")).collect();
        let bad = [
            ("blank summary", summary("  \n".into())),
            ("long summary", summary("x".repeat(REVIEW_SUMMARY_LIMIT + 1))),
            ("NUL in the summary", summary("a\0b".into())),
            ("markers in the summary", summary("<<<FINDINGS injected".into())),
            ("51 comments", comments(many)),
            ("blank comment", comments(vec![at("src/a.ts", 1, " ")])),
            ("long comment", comments(vec![at("src/a.ts", 1, &"x".repeat(REVIEW_COMMENT_LIMIT + 1))])),
            ("NUL in a comment", comments(vec![at("src/a.ts", 1, "a\0")])),
            ("markers in a comment", comments(vec![at("src/a.ts", 1, "PLAN>>>")])),
            ("two comments on one line", comments(vec![at("src/a.ts", 3, "a"), at("src/a.ts", 3, "b")])),
            ("an escaping path", comments(vec![at("src/../../etc/passwd", 3, "a")])),
            ("an absolute path", comments(vec![at("/etc/passwd", 3, "a")])),
            ("a long path", comments(vec![at(&format!("src/{}.ts", "a".repeat(REVIEW_PATH_LIMIT)), 3, "a")])),
            ("line 0", comments(vec![at("src/a.ts", 0, "a")])),
            ("a short sha", sha("a1b2c3")),
            ("a sha that isn't hex", sha("a1b2c3d4zz")),
            ("a long sha", sha(&"a".repeat(41))),
            ("no pull request", with_review(|i| if let Intent::GithubReview { number, .. } = i { *number = 0 })),
            ("a repository that isn't owner/name", with_review(|i| if let Intent::GithubReview { repo, .. } = i { *repo = "webshop".into() })),
            ("a ticket on the code host's connection", with_review(|i| if let Intent::GithubReview { item, .. } = i { *item = Some(ItemRef { connection_id: "github:ann".into(), external_id: "1".into(), key: "CA-1".into() }) })),
            ("no connection", with_review(|i| if let Intent::GithubReview { connection_id, .. } = i { *connection_id = " ".into() })),
        ];
        for (why, intent) in bad {
            assert!(create(&db, review_draft(intent), now()).is_err(), "{why}");
        }
        let both_sides = comments(vec![at("src/a.ts", 3, "a"), crate::domain::ReviewComment { side: crate::domain::DiffSide::Left, ..at("src/a.ts", 3, "b") }]);
        assert!(create(&db, review_draft(both_sides), now()).is_ok(), "one line on each side is two positions");
        assert!(create(&db, review_draft(comments(vec![])), now()).is_ok(), "a summary alone is a review");
        assert!(create(&db, review_draft(sha(&"a".repeat(40))), now()).is_ok());
        assert_eq!(db.proposals(&ProposalQuery::default()).unwrap().len(), 4);
    }

    #[test]
    fn an_edit_changes_a_review_s_words_but_never_which_pull_request_commit_or_run_it_is_for() {
        let db = Db::in_memory().unwrap();
        let p = made(&db, review_draft(with_review(|_| {})));
        let reworded = with_review(|i| if let Intent::GithubReview { comments, .. } = i { comments[0].body = "Softer.".into() });
        assert_eq!(edit(&db, &p.id, reworded.clone(), now()).unwrap().intent, reworded);
        let dropped = with_review(|i| if let Intent::GithubReview { comments, .. } = i { comments.clear() });
        assert!(edit(&db, &p.id, dropped, now()).is_ok());
        let moved: [(&str, Intent); 5] = [
            ("repo", with_review(|i| if let Intent::GithubReview { repo, .. } = i { *repo = "acme/other".into() })),
            ("number", with_review(|i| if let Intent::GithubReview { number, .. } = i { *number = 219 })),
            ("commit", with_review(|i| if let Intent::GithubReview { commit_sha, .. } = i { *commit_sha = "ffffffffffff".into() })),
            ("connection", with_review(|i| if let Intent::GithubReview { connection_id, .. } = i { *connection_id = "github:bob".into() })),
            ("run", with_review(|i| if let Intent::GithubReview { run_id, .. } = i { *run_id = "run-2".into() })),
        ];
        for (what, intent) in moved {
            assert!(edit(&db, &p.id, intent, now()).unwrap_err().to_string().contains("can't change which pull request"), "{what}");
        }
    }

    #[test]
    fn a_review_is_never_applied_through_a_tracker_and_once_the_person_edits_it_pip_can_t_revise_it() {
        let db = Db::in_memory().unwrap();
        let p = made(&db, review_draft(with_review(|_| {})));
        assert!(begin(&db, &p.id, now()).unwrap_err().to_string().contains(REVIEW_OWN_BUTTON));
        assert_eq!(load(&db, &p.id).unwrap().state, ProposalState::Pending, "the refused claim leaves it pending");
        assert!(left_by_run(&p));
        assert!(require_pip_may_revise(&p, None).is_ok(), "what a run left is Pip's to revise");
        let edited = edit(&db, &p.id, with_review(|i| if let Intent::GithubReview { summary, .. } = i { *summary = "Mine.".into() }), now()).unwrap();
        assert_eq!(require_pip_may_revise(&edited, None).unwrap_err().to_string(), REVIEW_IS_THE_USERS);
    }

    #[test]
    fn a_person_s_review_edit_keeps_every_comment_where_it_was_but_pip_s_revision_may_add_one() {
        let db = Db::in_memory().unwrap();
        let p = made(&db, review_draft(with_review(|i| if let Intent::GithubReview { comments, .. } = i { comments.push(at("src/consumer/retry.ts", 17, "Nit.")) })));
        let to = |list: Vec<crate::domain::ReviewComment>| with_review(move |i| if let Intent::GithubReview { comments, .. } = i { *comments = list });
        let left = crate::domain::ReviewComment { side: crate::domain::DiffSide::Left, ..at("src/consumer/retry.ts", 42, "x") };
        for (why, intent) in [
            ("a new line", to(vec![at("src/consumer/retry.ts", 43, "x")])),
            ("another file", to(vec![at("src/consumer/index.ts", 42, "x")])),
            ("the other side", to(vec![left])),
        ] {
            assert_eq!(edit(&db, &p.id, intent, now()).unwrap_err().to_string(), REVIEW_EDIT_KEEPS_POSITIONS, "{why}");
        }
        assert!(load(&db, &p.id).unwrap().revisions.is_empty());
        let dropped = edit(&db, &p.id, to(vec![at("src/consumer/retry.ts", 17, "Only the nit, reworded.")]), now()).unwrap();
        assert_eq!(dropped.revisions.last().unwrap().note, EDITED_NOTE);
        assert!(person_edited(&dropped));
        let by_pip = edit_noted(&db, &p.id, to(vec![at("src/consumer/retry.ts", 17, "a"), at("src/consumer/retry.ts", 18, "b")]), REVISED_BY_PIP, now());
        assert!(by_pip.is_ok(), "the position rule is the person's; Pip's revision is checked against the diff where Core has it");
    }
}
