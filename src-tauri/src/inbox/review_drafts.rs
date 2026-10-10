//! The GitHub review a finished Review run leaves for the person: a summary plus one inline comment per finding at the
//! line it cites, built here from the run's verdict and findings, never from its prose. Nothing is posted: the draft
//! waits for the person, and only their approval posts it, as a plain comment review (`Core::post_review_draft`).

use chrono::Utc;

use super::run_results::label_of;
use super::Core;
use crate::codehost::diff::{commentable, parse_where, relative_path};
use crate::domain::{
    clip, without_markers, Actor, Basis, ChangedFile, CreatedBy, DiffSide, Intent, Origin, Proposal, ProposalQuery, ProposalState, ReviewComment, Run, RunKind,
    RunState, WorkstreamEvent,
};
use crate::auth::Scope;
use crate::error::{Error, Result};
use crate::proposals::{self, Draft, REVIEW_COMMENTS_MAX, REVIEW_COMMENT_LIMIT, REVIEW_SUMMARY_LIMIT};

/// The error a review draft keeps when GitHub said its lines no longer match the pull request. The card reads this
/// exact text as the draft being outdated.
pub const REVIEW_OUTDATED_NOTE: &str =
    "GitHub says this review's lines no longer match the pull request; it is outdated. Discard it or edit the comments and try again.";
/// The error a review draft keeps when a post may have reached GitHub though no answer said so. Its next post looks for
/// the review on GitHub first. The card reads text starting with this as the review maybe being there already.
pub const REVIEW_MAYBE_POSTED_NOTE: &str = "GitHub may have posted this review already; Gossamr checks the pull request before sending it again.";
/// Why a post of a review draft that changed since the person looked at it is refused.
pub const REVIEW_CHANGED: &str = "this review changed since you looked at it; read it again before posting";
use crate::runs::report::{Finding, ReviewVerdict, Severity, FINDING_TEXT_LIMIT};

/// Whether a draft's error says its last post may have gone through: noted so here, or left posting when Gossamr closed.
fn maybe_posted(error: &str) -> bool {
    error.starts_with(REVIEW_MAYBE_POSTED_NOTE) || error == crate::db::INTERRUPTED_NOTE
}

/// Whether a failed post may still have reached GitHub: the request may have been sent (anything in transit but a
/// refused connection), GitHub failed on its side, or it answered with success in words that don't read.
fn outcome_unknown(e: &Error) -> bool {
    match e {
        Error::Http(e) => !e.is_connect() && !e.is_builder(),
        Error::Json(_) => true,
        Error::CodeHost { status, .. } => (500..600).contains(status),
        _ => false,
    }
}

/// The most of a finding's `where` a review repeats.
const WHERE_LIMIT: usize = 300;
/// Room kept at the end of a summary for the line that says some findings were left out.
const MORE_ROOM: usize = 200;

/// A review draft's text: what goes in its summary and the comments that sit on lines of the diff.
#[derive(Clone, Debug, PartialEq)]
pub struct ReviewText {
    pub summary: String,
    pub comments: Vec<ReviewComment>,
}

fn label(severity: Severity) -> &'static str {
    match severity {
        Severity::Blocking => "Blocking",
        Severity::ShouldFix => "Should fix",
        Severity::Nit => "Nit",
    }
}

/// The agent's text as a review may carry it: on one line, without NULs or the markers Gossamr reserves, cut at `limit`.
fn cleaned(text: &str, limit: usize) -> String {
    let flat = without_markers(&text.replace('\0', "")).split_whitespace().collect::<Vec<_>>().join(" ");
    clip(&flat, limit)
}

/// Whether `path` names a file: its last part has an extension of letters and digits.
fn file_like(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.rsplit_once('.').is_some_and(|(stem, ext)| !stem.is_empty() && (1..=10).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_alphanumeric()))
}

/// A written finding has no `where`, but often opens with it: `src/a.ts:42: the text`. That place, and the text after
/// it; else no place and the text as it was.
fn leading_place(text: &str) -> (Option<String>, String) {
    let (first, rest) = text.split_once(' ').unwrap_or((text, ""));
    let Some(place) = first.strip_suffix(':').map(|p| p.trim_matches('`')).filter(|p| !p.is_empty() && !rest.trim().is_empty()) else { return (None, text.into()) };
    if parse_where(place).is_some() || (relative_path(place) && file_like(place)) {
        return (Some(place.into()), rest.trim().into());
    }
    (None, text.into())
}

/// The review of pull request `number` at `commit_sha` that `findings` come to. `files` is the pull request's files, or
/// `None` when its diff at `commit_sha` couldn't be read (it failed, or the head has moved on): then every finding goes in the summary. A finding goes inline only when its
/// `where` names a file and a line the diff shows on the new side; the others are listed in the summary. `run` names
/// the run in its last line. `src/backend/mockReviewDraft.ts` mirrors this, and both pass
/// `src/lib/reviewDraft.fixtures.json`.
pub fn review_text(number: u64, commit_sha: &str, verdict: ReviewVerdict, findings: &[Finding], files: Option<&[ChangedFile]>, run: &str) -> ReviewText {
    let count = |s: Severity| findings.iter().filter(|f| f.severity == s).count();
    let nits = count(Severity::Nit);
    let verdict = match verdict {
        ReviewVerdict::Pass => "pass",
        ReviewVerdict::Blocking => "blocking",
    };
    let header = format!(
        "Gossamr review of #{number} at {}: {verdict} ({} blocking, {} should-fix, {nits} {}).",
        clip(commit_sha, 8),
        count(Severity::Blocking),
        count(Severity::ShouldFix),
        if nits == 1 { "nit" } else { "nits" }
    );
    let footer = format!("Drafted from agent run {run}; posted only after a person approved it in Gossamr.");

    let mut comments: Vec<ReviewComment> = Vec::new();
    let mut listed: Vec<String> = Vec::new();
    for f in findings {
        let text = cleaned(&f.text, FINDING_TEXT_LIMIT);
        let (place, text) = match f.where_.as_deref().map(|w| cleaned(w, WHERE_LIMIT)).filter(|w| !w.is_empty()) {
            Some(w) => (Some(w), text),
            None => leading_place(&text),
        };
        let body = format!("**{}:** {text}", label(f.severity));
        let at = place.as_deref().and_then(parse_where).filter(|(path, line)| {
            files.is_some_and(|files| files.iter().any(|file| file.path == *path && file.patch.as_deref().is_some_and(|p| commentable(p, *line, DiffSide::Right))))
        });
        if let Some((path, line)) = at {
            if let Some(same) = comments.iter_mut().find(|c| c.path == path && c.line == line) {
                // Findings on one line share its comment while it stays within a comment's length.
                if same.body.chars().count() + body.chars().count() + 2 <= REVIEW_COMMENT_LIMIT {
                    same.body = format!("{}\n\n{body}", same.body);
                    continue;
                }
            } else if comments.len() < REVIEW_COMMENTS_MAX {
                comments.push(ReviewComment { path, line, side: DiffSide::Right, body });
                continue;
            }
        }
        listed.push(match place {
            Some(w) => format!("- {body} ({w})"),
            None => format!("- {body}"),
        });
    }

    let mut parts = vec![header];
    if files.is_none() {
        parts.push("The pull request's diff at this commit couldn't be read, so every finding is listed here.".into());
    }
    if !listed.is_empty() {
        let mut used = parts.iter().chain([&footer]).map(|p| p.chars().count() + 2).sum::<usize>() + 40;
        let mut lines = Vec::new();
        for (i, line) in listed.iter().enumerate() {
            let len = line.chars().count() + 1;
            if used + len > REVIEW_SUMMARY_LIMIT - MORE_ROOM {
                lines.push(format!("- …and {} more; the whole review is in agent run {run}.", listed.len() - i));
                break;
            }
            used += len;
            lines.push(line.clone());
        }
        parts.push(format!("Findings without a line in the diff:\n{}", lines.join("\n")));
    }
    parts.push(footer);
    ReviewText { summary: parts.join("\n\n"), comments }
}

/// Whether `p` is the review draft made from run `run_id`.
fn of_run(p: &Proposal, run_id: &str) -> bool {
    matches!(&p.intent, Intent::GithubReview { run_id: r, .. } if r == run_id)
}

impl Core {
    /// The GitHub review draft of a Review run that reached Done with its whole answer read, the pull request and the
    /// commit it read, and a verdict. Built from the verdict and findings alone. `None` for any other run, and for a
    /// review that already has a review draft in any state, even a skipped one. Nothing is posted.
    pub async fn auto_draft_run_review(&self, id: &str) -> Result<Option<Proposal>> {
        let Some(run) = self.run(id).await? else { return Ok(None) };
        if run.spec.kind != RunKind::Review || run.state != RunState::Done || !run.result_complete {
            return Ok(None);
        }
        let (Some(number), Some(sha)) = (run.spec.pr, run.spec.pr_sha.clone()) else { return Ok(None) };
        let resolved = self.resolved_of(&run).await?;
        let Some(verdict) = resolved.verdict else { return Ok(None) };
        let scope = self.scope().await?;
        if self.with_db_for(&scope, |db| db.proposals(&ProposalQuery::default())).await?.iter().any(|p| of_run(p, &run.id)) {
            return Ok(None);
        }
        let (connection_id, repo) = self.code_connection_for(&run.spec.repo)?;
        let files = match self.diff_at(&connection_id, &repo, number, &sha).await {
            Ok(files) => Some(files),
            Err(e) => {
                eprintln!("couldn't read the diff of {repo}#{number} at {sha} for the review draft of run {}: {e}", run.id);
                None
            }
        };
        let text = review_text(number, &sha, verdict, &resolved.findings, files.as_deref(), &short_of(&run));
        let intent = Intent::GithubReview {
            connection_id,
            item: run.item.clone(),
            run_id: run.id.clone(),
            repo,
            number,
            commit_sha: sha,
            summary: text.summary,
            comments: text.comments,
        };
        let mut draft = Draft { origin: Origin::of_run(&run), created_by: CreatedBy::Agent, intent, label: Some(label_of(&run)), basis: None };
        // Looking and storing happen under one lock, so two callers can't both make one.
        self.with_db_for(&scope, |db| {
            if db.proposals(&ProposalQuery::default())?.iter().any(|p| of_run(p, &run.id)) {
                return Ok(None);
            }
            if let Some(target) = draft.intent.target() {
                draft.basis = db.item(target)?.as_ref().map(Basis::of);
            }
            Ok(Some(proposals::create(db, draft, Utc::now())?))
        })
        .await
    }
}

impl Core {
    /// The files of pull request `number` as its diff shows them at `commit_sha`, the commit a review is posted against,
    /// whose diff is the one GitHub places the review's lines on. Only the head's diff is read, so once the head has moved
    /// on from `commit_sha` this refuses rather than offer lines of a diff the review won't be posted on.
    async fn diff_at(&self, connection_id: &str, repo: &str, number: u64, commit_sha: &str) -> Result<Vec<ChangedFile>> {
        let host = self.code_host(connection_id).await?;
        let head = host.pull_request_change(repo, number).await?.sha;
        if head.as_deref() != Some(commit_sha) {
            return Err(Error::Proposal(format!("the pull request has moved on from {} since the review read it", clip(commit_sha, 8))));
        }
        host.pull_files(repo, number).await
    }
}

impl Core {
    /// Posts the pending review draft `id` to GitHub as one comment review, on the person's approval: the only path by
    /// which anything is written to GitHub. `seen` is how many revisions the draft had when the person looked at it: one
    /// revised since (by Pip, say) is refused, so only what they read is posted. The draft is claimed first, so it is
    /// posted at most once. It never goes through the tracker. A refusal leaves it pending with the reason as its error;
    /// GitHub saying its lines no longer match marks it outdated (`REVIEW_OUTDATED_NOTE`). A post whose outcome isn't
    /// known (a failure in transit, a 5xx, an answer that doesn't read) is noted as maybe posted (`REVIEW_MAYBE_POSTED_NOTE`),
    /// and the next attempt first looks on GitHub for the review it may have left, which is then recorded as posted
    /// instead of being sent again.
    pub async fn post_review_draft(&self, id: &str, seen: usize) -> Result<Proposal> {
        let scope = self.scope().await?;
        let (claimed, unsure) = self
            .with_db_for(&scope, |db| {
                let current = db.proposal(id)?.ok_or_else(|| Error::Proposal("that draft no longer exists".into()))?;
                if current.state == ProposalState::Pending && current.revisions.len() != seen {
                    return Err(Error::Proposal(REVIEW_CHANGED.into()));
                }
                let unsure = current.error.as_deref().is_some_and(maybe_posted);
                match db.begin_posting_review(id, Utc::now())? {
                    Some(p) => Ok((p, unsure)),
                    None => Err(proposals::not_pending(&current)),
                }
            })
            .await?;
        let Intent::GithubReview { connection_id, repo, number, commit_sha, summary, comments, .. } = &claimed.intent else {
            unreachable!("only a review draft is claimed for posting")
        };
        let posted = match self.code_host(connection_id).await {
            Ok(host) if unsure => match host.posted_review(repo, *number, commit_sha, summary).await {
                Ok(Some(review)) => Ok(review),
                Ok(None) => host.post_review(repo, *number, commit_sha, summary, comments).await,
                // Nothing is sent while it can't be told whether the last attempt went through.
                Err(e) => Err(Error::Proposal(format!("{REVIEW_MAYBE_POSTED_NOTE} Gossamr couldn't check just now ({e})."))),
            },
            Ok(host) => host.post_review(repo, *number, commit_sha, summary, comments).await,
            Err(e) => Err(e),
        };
        let label = format!("{repo}#{number}");
        self.with_db_for(&scope, |db| {
            let at = Utc::now();
            let mut p = db.proposal(id)?.ok_or_else(|| Error::Proposal("that draft no longer exists".into()))?;
            p.updated_at = at;
            match posted {
                Ok(review) => {
                    let detail = format!("{label} review {}", review.id);
                    (p.state, p.error, p.posted) = (ProposalState::Applied, None, Some(review));
                    db.save_proposal(&p)?;
                    proposals::record(db, &p, Actor::Person, "draft_approved", at);
                    if let Some(ws) = p.workstream().filter(|ws| db.workstream(ws).ok().flatten().is_some()) {
                        if let Err(e) = db.append_workstream_event(&WorkstreamEvent::new(ws, Actor::Person, "review_posted", at).proposal(&p.id).detail(detail)) {
                            eprintln!("couldn't record the posted review of draft {} in workstream {ws}: {e}", p.id);
                        }
                    }
                }
                Err(Error::ReviewOutdated(said)) => {
                    eprintln!("GitHub refused review draft {id} on {label} as outdated: {said}");
                    (p.state, p.error) = (ProposalState::Pending, Some(REVIEW_OUTDATED_NOTE.into()));
                    db.save_proposal(&p)?;
                }
                Err(e) if outcome_unknown(&e) => {
                    eprintln!("posting review draft {id} on {label} may have gone through: {e}");
                    (p.state, p.error) = (ProposalState::Pending, Some(format!("{REVIEW_MAYBE_POSTED_NOTE} ({e})")));
                    db.save_proposal(&p)?;
                }
                Err(e) => {
                    (p.state, p.error) = (ProposalState::Pending, Some(e.to_string()));
                    db.save_proposal(&p)?;
                }
            }
            Ok(p)
        })
        .await
    }

    /// Whether the token of `connection_id` may post a review on `repo`, which must be watched.
    pub async fn code_review_access(&self, connection_id: &str, repo: &str) -> Result<crate::codehost::ReviewAccess> {
        self.require_watched(connection_id, repo)?;
        self.code_host(connection_id).await?.review_access(repo).await
    }

    /// The files of pull request `number` with patches long enough for a review's comments, in a watched repository.
    pub async fn code_pull_files(&self, connection_id: &str, repo: &str, number: u64) -> Result<Vec<ChangedFile>> {
        self.require_watched(connection_id, repo)?;
        self.code_host(connection_id).await?.pull_files(repo, number).await
    }

    /// The reviews and inline comments already on pull request `number` in a watched repository. Reads only.
    pub async fn code_review_comments(&self, connection_id: &str, repo: &str, number: u64) -> Result<crate::codehost::ReviewComments> {
        self.require_watched(connection_id, repo)?;
        self.code_host(connection_id).await?.review_comments(repo, number).await
    }

    /// Pip's revision of review draft `id`: `summary` when given, and `comments` as its complete new list (any left out
    /// are dropped). The same rule as for any revision applies (`proposals::require_pip_may_revise`): a draft the
    /// person edited stays theirs, and one of a workstream only changes from that workstream's conversation. A comment
    /// at a position the draft already had keeps it; one at a new position must sit on a line the pull request's diff
    /// shows at the reviewed commit, so none can be added once the head has moved on. Nothing is posted: the revision is still a draft for the person to approve.
    pub async fn revise_review_as_pip(&self, scope: &Scope, workstream: Option<&str>, id: &str, summary: Option<String>, comments: Vec<ReviewComment>) -> Result<Proposal> {
        let current = self.proposal_in(scope, id).await?.ok_or_else(|| Error::Proposal("that draft no longer exists".into()))?;
        proposals::require_pip_may_revise(&current, workstream)?;
        let Intent::GithubReview { connection_id, item, run_id, repo, number, commit_sha, summary: was, comments: had } = &current.intent else {
            return Err(Error::Proposal("that draft isn't a GitHub review".into()));
        };
        let at = |c: &ReviewComment| (c.path.clone(), c.line, c.side);
        let new: Vec<&ReviewComment> = comments.iter().filter(|c| !had.iter().any(|h| at(h) == at(c))).collect();
        if !new.is_empty() {
            self.require_watched(connection_id, repo)?;
            let files = self
                .diff_at(connection_id, repo, *number, commit_sha)
                .await
                .map_err(|e| Error::Proposal(format!("couldn't read the pull request's diff at the reviewed commit to place the new comments ({e}); reword or drop the comments it has instead, or try again later")))?;
            if let Some(c) = new.iter().find(|c| !files.iter().any(|f| f.path == c.path && f.patch.as_deref().is_some_and(|p| commentable(p, c.line, c.side)))) {
                return Err(Error::Proposal(format!("{}:{} isn't a line the pull request's diff shows; call get_proposal to see the lines it has", c.path, c.line)));
            }
        }
        let intent = Intent::GithubReview {
            connection_id: connection_id.clone(),
            item: item.clone(),
            run_id: run_id.clone(),
            repo: repo.clone(),
            number: *number,
            commit_sha: commit_sha.clone(),
            summary: summary.unwrap_or_else(|| was.clone()),
            comments,
        };
        self.revise_as_pip(scope, workstream, id, intent).await
    }

    /// Pull request `number` in a watched repository with the files it changes, for the in-app pull request view.
    pub async fn code_pull_diff(&self, connection_id: &str, repo: &str, number: u64) -> Result<crate::codehost::PullDiff> {
        self.require_watched(connection_id, repo)?;
        self.code_host(connection_id).await?.pull_diff(repo, number).await
    }
}

/// How a review names the run it came from: its session's short id, else the start of its own.
fn short_of(run: &Run) -> String {
    match &run.short_id {
        Some(short) => short.to_string(),
        None => clip(&run.id, 8),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codehost::github::testserver::{pull_reply, pull_reply_at, Reply};
    use crate::domain::ProposalState;
    use crate::inbox::run_results::tests::run_with;
    use crate::inbox::testing::{fixture_watching, fixture_watching_with, Fixture};

    const FILES_ROUTE: &str = "/repos/acme/webshop/pulls/12/files";
    const PULL_ROUTE: &str = "/repos/acme/webshop/pulls/12";

    /// Pull request #12 with its head at the commit the reviews read, `a1b2c3d4e5f6`.
    fn pull_route() -> (&'static str, Vec<Reply>) {
        (PULL_ROUTE, vec![pull_reply(12, "open", Some("acme/webshop"), "main")])
    }

    fn hunks() -> serde_json::Value {
        serde_json::from_str(include_str!("../../../src/lib/diffHunks.fixtures.json")).unwrap()
    }

    #[test]
    fn matches_the_review_draft_fixtures_the_mock_also_passes() {
        let cases: serde_json::Value = serde_json::from_str(include_str!("../../../src/lib/reviewDraft.fixtures.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let findings: Vec<Finding> = serde_json::from_value(case["findings"].clone()).unwrap();
            let files: Option<Vec<ChangedFile>> = case["files"].as_array().map(|list| {
                list.iter()
                    .map(|f| ChangedFile { path: f["path"].as_str().unwrap().into(), status: "modified".into(), additions: 0, deletions: 0, patch: f["patch"].as_str().map(Into::into), truncated: f["truncated"].as_bool().unwrap() })
                    .collect()
            });
            let verdict: ReviewVerdict = serde_json::from_value(case["verdict"].clone()).unwrap();
            let got = review_text(case["number"].as_u64().unwrap(), case["commitSha"].as_str().unwrap(), verdict, &findings, files.as_deref(), case["run"].as_str().unwrap());
            assert_eq!(got.summary, case["expect"]["summary"].as_str().unwrap(), "{name}");
            let comments: Vec<ReviewComment> = serde_json::from_value(case["expect"]["comments"].clone()).unwrap();
            assert_eq!(got.comments, comments, "{name}");
        }
    }

    #[test]
    fn a_long_list_of_findings_is_cut_with_a_note_and_the_summary_stays_within_its_limit() {
        let findings: Vec<Finding> = (0..40).map(|n| Finding { severity: Severity::Nit, text: format!("{n} {}", "x".repeat(590)), where_: Some(format!("src/f{n}.ts")) }).collect();
        let text = review_text(12, "a1b2c3d4e5f6", ReviewVerdict::Pass, &findings, Some(&[][..]), "ab12cd34");
        assert!(text.summary.chars().count() <= REVIEW_SUMMARY_LIMIT, "{}", text.summary.chars().count());
        assert!(text.summary.contains("more; the whole review is in agent run ab12cd34."));
        assert!(text.summary.ends_with("posted only after a person approved it in Gossamr."));
    }

    #[test]
    fn at_most_fifty_findings_go_inline_and_the_rest_are_listed() {
        let patch = format!("@@ -0,0 +1,60 @@\n{}", (1..=60).map(|n| format!("+line {n}")).collect::<Vec<_>>().join("\n"));
        let files = [ChangedFile { path: "src/a.ts".into(), status: "added".into(), additions: 60, deletions: 0, patch: Some(patch), truncated: false }];
        let findings: Vec<Finding> = (1..=55).map(|n| Finding { severity: Severity::Nit, text: format!("n{n}"), where_: Some(format!("src/a.ts:{n}")) }).collect();
        let text = review_text(12, "a1b2c3d4e5f6", ReviewVerdict::Pass, &findings, Some(&files), "ab12cd34");
        assert_eq!(text.comments.len(), REVIEW_COMMENTS_MAX);
        assert!(text.summary.contains("- **Nit:** n51 (src/a.ts:51)") && text.summary.contains("n55"));
    }

    #[test]
    fn findings_on_one_line_share_its_comment_only_while_it_fits() {
        let patch = "@@ -0,0 +1,1 @@\n+line".to_string();
        let files = [ChangedFile { path: "src/a.ts".into(), status: "added".into(), additions: 1, deletions: 0, patch: Some(patch), truncated: false }];
        let findings: Vec<Finding> = (0..12).map(|n| Finding { severity: Severity::Nit, text: format!("{n} {}", "x".repeat(590)), where_: Some("src/a.ts:1".into()) }).collect();
        let text = review_text(12, "a1b2c3d4e5f6", ReviewVerdict::Pass, &findings, Some(&files), "ab12cd34");
        assert_eq!(text.comments.len(), 1);
        assert!(text.comments[0].body.chars().count() <= REVIEW_COMMENT_LIMIT);
        assert!(text.summary.contains("- **Nit:** 11 "), "what didn't fit is listed");
    }

    const WRITTEN: &str = "I ran the tests.\n\n- [blocking] src/consumer/retry.ts:42: the retry loop never backs off.\n- [should-fix] src/consumer/retry.test.ts: no test covers the timeout path.\n- [nit] src/consumer/retry.ts:17: `MAX` doesn't say what it limits.\n- [nit] src/elsewhere.ts:3: not in this change.\n\nVerdict: blocking\n\nFor Jira:\nNot ready.";

    fn files_reply() -> Reply {
        let h = hunks();
        let files = serde_json::json!([
            { "filename": "src/consumer/retry.ts", "status": "modified", "additions": 6, "deletions": 1, "patch": h["patches"]["retry"] },
            { "filename": "src/consumer/index.ts", "status": "modified", "additions": 1, "deletions": 1, "patch": h["patches"]["index"] }
        ]);
        Reply::ok(&files.to_string())
    }

    async fn review(fx: &Fixture, result: &str) -> Run {
        run_with(fx, |r| {
            (r.spec.kind, r.spec.pr, r.spec.pr_sha, r.spec.instruction) = (RunKind::Review, Some(12), Some("a1b2c3d4e5f6".into()), String::new());
            r.result = Some(result.into());
        })
        .await
    }

    fn intent_of(p: &Proposal) -> (&str, &str, u64, &str, &str, &[ReviewComment]) {
        let Intent::GithubReview { connection_id, repo, number, commit_sha, summary, comments, .. } = &p.intent else { panic!("{:?}", p.intent) };
        (connection_id, repo, *number, commit_sha, summary, comments)
    }

    #[tokio::test]
    async fn a_blocking_review_leaves_inline_comments_for_findings_in_the_diff_and_lists_the_rest_and_only_reads_github() {
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()])]).await;
        let run = review(&fx, WRITTEN).await;
        let p = fx.core.auto_draft_run_review(&run.id).await.unwrap().expect("a review draft");
        let (connection, repo, number, sha, summary, comments) = intent_of(&p);
        assert_eq!((connection, repo, number, sha), ("github:ann", "acme/webshop", 12, "a1b2c3d4e5f6"));
        assert_eq!(comments.iter().map(|c| (c.path.as_str(), c.line, c.side)).collect::<Vec<_>>(), [("src/consumer/retry.ts", 42, DiffSide::Right), ("src/consumer/retry.ts", 17, DiffSide::Right)]);
        assert!(comments[0].body.starts_with("**Blocking:** the retry loop never backs off"));
        assert!(summary.starts_with("Gossamr review of #12 at a1b2c3d4: blocking (1 blocking, 1 should-fix, 2 nits)."), "{summary}");
        assert!(summary.contains("Findings without a line in the diff:\n- **Should fix:** no test covers the timeout path. (src/consumer/retry.test.ts)\n- **Nit:** not in this change. (src/elsewhere.ts:3)"), "{summary}");
        assert!(!summary.contains("Not ready") && !summary.contains("I ran the tests"), "never the agent's prose");
        assert!(summary.ends_with(&format!("Drafted from agent run {}; posted only after a person approved it in Gossamr.", run.short_id.as_ref().unwrap())));
        assert_eq!((p.state.clone(), p.created_by, p.origin.clone(), p.label.clone()), (ProposalState::Pending, CreatedBy::Agent, Origin::of_run(&run), Some(label_of(&run))));
        assert_eq!(p.target(), Some(&fx.item("CA-1")));
        assert!(fx.tracker.intents().is_empty(), "a draft writes nothing to Jira");
        let seen = fx.github_seen();
        assert!(seen.iter().all(|(method, _)| method == "GET"), "{seen:?}");
        assert_eq!(seen.iter().filter(|(_, t)| t.starts_with(FILES_ROUTE)).count(), 1, "the files are read once");
        assert!(!seen.iter().any(|(_, t)| t.contains("/reviews")), "nothing is posted");
    }

    #[tokio::test]
    async fn an_unreadable_diff_still_leaves_a_draft_with_every_finding_in_its_summary() {
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![Reply::status(500, "{\"message\":\"boom\"}")])]).await;
        let run = review(&fx, WRITTEN).await;
        let p = fx.core.auto_draft_run_review(&run.id).await.unwrap().expect("a review draft");
        let (.., summary, comments) = intent_of(&p);
        assert!(comments.is_empty());
        assert!(summary.contains("The pull request's diff at this commit couldn't be read, so every finding is listed here."), "{summary}");
        assert!(summary.contains("- **Blocking:** the retry loop never backs off. (src/consumer/retry.ts:42)"), "{summary}");
    }

    #[tokio::test]
    async fn a_review_gets_one_draft_however_often_it_is_asked_even_once_that_one_is_skipped() {
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()])]).await;
        let run = review(&fx, WRITTEN).await;
        let p = fx.core.auto_draft_run_review(&run.id).await.unwrap().unwrap();
        assert_eq!(fx.core.auto_draft_run_review(&run.id).await.unwrap(), None);
        fx.core.with_db_for(&fx.scope, |db| proposals::skip(db, &p.id, Utc::now())).await.unwrap();
        assert_eq!(fx.core.auto_draft_run_review(&run.id).await.unwrap(), None);
        let all = fx.core.proposals(&ProposalQuery::default()).await.unwrap();
        assert_eq!(all.iter().filter(|p| matches!(p.intent, Intent::GithubReview { .. })).count(), 1);
    }

    #[tokio::test]
    async fn only_a_finished_review_with_its_pull_request_commit_and_verdict_gets_a_draft() {
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()])]).await;
        let investigate = run_with(&fx, |r| r.result = Some(WRITTEN.into())).await;
        let unfinished = run_with(&fx, |r| {
            (r.spec.kind, r.spec.pr, r.spec.pr_sha) = (RunKind::Review, Some(12), Some("a1b2c3d4e5f6".into()));
            (r.result, r.state) = (Some(WRITTEN.into()), RunState::Working);
        })
        .await;
        let summary_only = run_with(&fx, |r| {
            (r.spec.kind, r.spec.pr, r.spec.pr_sha) = (RunKind::Review, Some(12), Some("a1b2c3d4e5f6".into()));
            (r.result, r.result_complete) = (Some(WRITTEN.into()), false);
        })
        .await;
        let unpinned = run_with(&fx, |r| {
            (r.spec.kind, r.spec.pr) = (RunKind::Review, Some(12));
            r.result = Some(WRITTEN.into());
        })
        .await;
        let no_verdict = review(&fx, "Looked.\n\nFor Jira: fine.").await;
        for run in [investigate, unfinished, summary_only, unpinned, no_verdict] {
            assert_eq!(fx.core.auto_draft_run_review(&run.id).await.unwrap(), None, "{:?} {:?}", run.spec.kind, run.state);
        }
        assert!(fx.core.proposals(&ProposalQuery::default()).await.unwrap().iter().all(|p| !matches!(p.intent, Intent::GithubReview { .. })));
        assert_eq!(fx.core.auto_draft_run_review("missing").await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_passing_review_with_no_findings_is_a_summary_alone() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = review(&fx, "I tried and found nothing.\n\nVerdict: pass\n\nFor Jira:\nReady.").await;
        let p = fx.core.auto_draft_run_review(&run.id).await.unwrap().unwrap();
        let (.., summary, comments) = intent_of(&p);
        assert!(comments.is_empty());
        assert!(summary.starts_with("Gossamr review of #12 at a1b2c3d4: pass (0 blocking, 0 should-fix, 0 nits)."), "{summary}");
    }

    const POST_ROUTE: &str = "POST /repos/acme/webshop/pulls/12/reviews";

    fn posted_reply() -> Reply {
        Reply::ok("{\"id\":77,\"html_url\":\"https://github.com/acme/webshop/pull/12#pullrequestreview-77\"}")
    }

    async fn drafted(fx: &Fixture) -> Proposal {
        let run = review(fx, WRITTEN).await;
        fx.core.auto_draft_run_review(&run.id).await.unwrap().expect("a review draft")
    }

    fn posts(fx: &Fixture) -> Vec<String> {
        fx.github_seen().into_iter().filter(|(m, _)| m != "GET").map(|(m, t)| format!("{m} {t}")).collect()
    }

    #[tokio::test]
    async fn posting_a_review_draft_sends_one_comment_review_and_records_it() {
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()]), (POST_ROUTE, vec![posted_reply()])]).await;
        let p = drafted(&fx).await;
        assert!(posts(&fx).is_empty(), "drafting posts nothing");
        let done = fx.core.post_review_draft(&p.id, p.revisions.len()).await.unwrap();
        assert_eq!((done.state.clone(), done.error.clone()), (ProposalState::Applied, None));
        let posted = done.posted.clone().expect("posted");
        assert_eq!((posted.id, posted.url.as_str()), (77, "https://github.com/acme/webshop/pull/12#pullrequestreview-77"));
        assert_eq!(posts(&fx), ["POST /repos/acme/webshop/pulls/12/reviews"]);
        let seen = fx.github.as_ref().unwrap().lock().unwrap().iter().find(|s| s.method == "POST").cloned().unwrap();
        let body: serde_json::Value = serde_json::from_str(&seen.body).unwrap();
        assert_eq!((body["event"].as_str(), body["commit_id"].as_str()), (Some("COMMENT"), Some("a1b2c3d4e5f6")));
        assert_eq!(body["comments"].as_array().unwrap().iter().map(|c| (c["path"].as_str().unwrap(), c["line"].as_u64().unwrap())).collect::<Vec<_>>(), [("src/consumer/retry.ts", 42), ("src/consumer/retry.ts", 17)]);
        assert!(fx.tracker.intents().is_empty(), "posting a review writes nothing to Jira");
        assert_eq!(fx.core.proposal(&p.id).await.unwrap(), Some(done));
    }

    #[tokio::test]
    async fn a_review_draft_is_posted_at_most_once_and_never_through_the_tracker() {
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()]), (POST_ROUTE, vec![posted_reply()])]).await;
        let p = drafted(&fx).await;
        let err = fx.core.approve_proposal(&p.id).await.unwrap_err();
        assert!(err.to_string().contains("posted to GitHub with its own button"), "{err}");
        assert!(posts(&fx).is_empty() && fx.tracker.intents().is_empty(), "the approval path sends nothing");
        assert_eq!(fx.core.proposal(&p.id).await.unwrap().unwrap().state, ProposalState::Pending, "and leaves the draft as it was");
        fx.core.post_review_draft(&p.id, p.revisions.len()).await.unwrap();
        let again = fx.core.post_review_draft(&p.id, p.revisions.len()).await.unwrap_err();
        assert!(again.to_string().contains("already been applied"), "{again}");
        assert_eq!(posts(&fx).len(), 1, "the second post sent nothing");
    }

    #[tokio::test]
    async fn only_a_review_draft_can_be_claimed_for_posting() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let comment = fx.core.draft_as_user(Intent::Comment { item: fx.item("CA-1"), body: crate::domain::Doc::paragraph("hi") }, None).await.unwrap();
        let err = fx.core.post_review_draft(&comment.id, 0).await.unwrap_err();
        assert!(err.to_string().contains("only a review draft"), "{err}");
        assert_eq!(fx.core.proposal(&comment.id).await.unwrap().unwrap().state, ProposalState::Pending);
        assert!(posts(&fx).is_empty() && fx.tracker.intents().is_empty());
    }

    #[tokio::test]
    async fn a_review_github_finds_outdated_stays_pending_and_says_so() {
        let fx = fixture_watching_with(
            &["acme/webshop"],
            vec![pull_route(), (FILES_ROUTE, vec![files_reply()]), (POST_ROUTE, vec![Reply::status(422, "{\"message\":\"Unprocessable Entity\",\"errors\":[\"Line could not be resolved\"]}"), posted_reply()])],
        )
        .await;
        let p = drafted(&fx).await;
        let back = fx.core.post_review_draft(&p.id, p.revisions.len()).await.unwrap();
        assert_eq!((back.state.clone(), back.error.as_deref(), back.posted.clone()), (ProposalState::Pending, Some(REVIEW_OUTDATED_NOTE), None));
        let refused = fx.core.post_review_draft(&p.id, p.revisions.len()).await.unwrap();
        assert_eq!(refused.state, ProposalState::Applied, "a later attempt may go through");
        assert_eq!(posts(&fx).len(), 2);
    }

    #[tokio::test]
    async fn a_token_that_cannot_write_leaves_the_draft_pending_with_the_reason() {
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()]), (POST_ROUTE, vec![Reply::status(403, "{\"message\":\"Resource not accessible by personal access token\"}")])]).await;
        let p = drafted(&fx).await;
        let back = fx.core.post_review_draft(&p.id, p.revisions.len()).await.unwrap();
        assert_eq!(back.state, ProposalState::Pending);
        assert!(back.error.as_deref().unwrap().contains("the token can't write to pull requests in acme/webshop"), "{:?}", back.error);
        let access = fx.core.code_review_access("github:ann", "acme/webshop").await.unwrap();
        assert!(!access.can_post, "the refusal is remembered: {access:?}");
    }

    #[tokio::test]
    async fn a_review_left_posting_when_gossamr_closed_is_pending_again() {
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()])]).await;
        let p = drafted(&fx).await;
        let claimed = fx.core.with_db_for(&fx.scope, |db| db.begin_posting_review(&p.id, Utc::now())).await.unwrap().unwrap();
        assert_eq!(claimed.state, ProposalState::Applying);
        assert_eq!(fx.core.with_db_for(&fx.scope, |db| db.begin_posting_review(&p.id, Utc::now())).await.unwrap(), None, "claimed once");
        assert_eq!(fx.core.with_db_for(&fx.scope, |db| db.release_interrupted(Utc::now())).await.unwrap(), 1);
        let back = fx.core.proposal(&p.id).await.unwrap().unwrap();
        assert_eq!(back.state, ProposalState::Pending);
        assert!(back.error.as_deref().unwrap().contains("Check whether it went through"));
    }
    #[tokio::test]
    async fn a_review_of_a_commit_the_pull_request_moved_on_from_lists_every_finding_and_places_no_line() {
        let moved = (PULL_ROUTE, vec![pull_reply_at(12, "open", Some("acme/webshop"), "main", "f00dfeed0000")]);
        let fx = fixture_watching_with(&["acme/webshop"], vec![moved, (FILES_ROUTE, vec![files_reply()])]).await;
        let p = drafted(&fx).await;
        let (.., sha, summary, comments) = intent_of(&p);
        assert_eq!(sha, "a1b2c3d4e5f6", "it is still posted against the commit reviewed");
        assert!(comments.is_empty(), "the head's lines aren't the reviewed commit's: {comments:?}");
        assert!(summary.contains("The pull request's diff at this commit couldn't be read, so every finding is listed here."), "{summary}");
        assert!(!fx.github_seen().iter().any(|(_, t)| t.starts_with(FILES_ROUTE)), "the head's diff isn't read");
    }

    #[tokio::test]
    async fn pip_may_add_a_comment_only_while_the_head_is_the_reviewed_commit() {
        let pulls = vec![pull_reply(12, "open", Some("acme/webshop"), "main"), pull_reply(12, "open", Some("acme/webshop"), "main"), pull_reply_at(12, "open", Some("acme/webshop"), "main", "f00dfeed0000")];
        let fx = fixture_watching_with(&["acme/webshop"], vec![(PULL_ROUTE, pulls), (FILES_ROUTE, vec![files_reply()])]).await;
        let p = drafted(&fx).await;
        let (.., had) = intent_of(&p);
        let at_index = ReviewComment { path: "src/consumer/index.ts".into(), line: 1, side: DiffSide::Right, body: "This export moved.".into() };
        let added = [had.to_vec(), vec![at_index.clone()]].concat();
        let revised = fx.core.revise_review_as_pip(&fx.scope, None, &p.id, None, added.clone()).await.unwrap();
        assert_eq!(intent_of(&revised).5.len(), 3, "the head is the reviewed commit, so a line its diff shows may be added");
        let mut later = had.to_vec();
        later.push(ReviewComment { line: 2, ..at_index });
        let err = fx.core.revise_review_as_pip(&fx.scope, None, &p.id, None, later).await.unwrap_err();
        assert!(err.to_string().contains("has moved on from a1b2c3d4 since the review read it"), "{err}");
        assert_eq!(intent_of(&fx.core.proposal(&p.id).await.unwrap().unwrap()).5, added.as_slice(), "nothing changed");
    }

    #[tokio::test]
    async fn a_review_changed_since_the_person_looked_is_not_posted() {
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()]), (POST_ROUTE, vec![posted_reply()])]).await;
        let p = drafted(&fx).await;
        let (.., comments) = intent_of(&p);
        fx.core.revise_review_as_pip(&fx.scope, None, &p.id, Some("Pip's words.".into()), comments.to_vec()).await.unwrap();
        let err = fx.core.post_review_draft(&p.id, p.revisions.len()).await.unwrap_err();
        assert_eq!(err.to_string(), REVIEW_CHANGED);
        assert!(posts(&fx).is_empty(), "nothing was sent");
        let now = fx.core.proposal(&p.id).await.unwrap().unwrap();
        assert_eq!(now.state, ProposalState::Pending);
        assert_eq!(fx.core.post_review_draft(&p.id, now.revisions.len()).await.unwrap().state, ProposalState::Applied, "posted once read again");
    }

    const REVIEWS_ROUTE: &str = "/repos/acme/webshop/pulls/12/reviews?per_page=100";

    #[tokio::test]
    async fn a_review_that_fails_at_the_gateway_may_be_posted_and_is_found_on_github_rather_than_sent_again() {
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()]), (POST_ROUTE, vec![Reply::status(502, "{\"message\":\"Bad Gateway\"}")])]).await;
        let p = drafted(&fx).await;
        let (.., summary, _) = intent_of(&p);
        let back = fx.core.post_review_draft(&p.id, p.revisions.len()).await.unwrap();
        assert_eq!(back.state, ProposalState::Pending);
        assert!(back.error.as_deref().unwrap().starts_with(REVIEW_MAYBE_POSTED_NOTE), "{:?}", back.error);
        assert_eq!(posts(&fx).len(), 1);

        // It had gone through: the next post finds it and records it, and sends nothing.
        let theirs = serde_json::json!([
            { "id": 5, "user": { "login": "bob" }, "state": "COMMENTED", "commit_id": "a1b2c3d4e5f6", "body": summary, "submitted_at": "2026-10-01T10:00:00Z" },
            { "id": 88, "user": { "login": "ann" }, "state": "COMMENTED", "commit_id": "a1b2c3d4e5f6", "body": summary, "html_url": "https://github.com/acme/webshop/pull/12#pullrequestreview-88", "submitted_at": "2026-10-01T10:00:00Z" }
        ]);
        fx.github_route(REVIEWS_ROUTE, vec![Reply::ok(&theirs.to_string())]);
        let done = fx.core.post_review_draft(&p.id, back.revisions.len()).await.unwrap();
        assert_eq!((done.state.clone(), done.error.clone(), done.posted.as_ref().map(|r| r.id)), (ProposalState::Applied, None, Some(88)));
        assert_eq!(posts(&fx).len(), 1, "it wasn't posted a second time");
    }

    #[tokio::test]
    async fn a_maybe_posted_review_that_isnt_on_github_is_sent_once_more() {
        let fx = fixture_watching_with(
            &["acme/webshop"],
            vec![pull_route(), (FILES_ROUTE, vec![files_reply()]), (POST_ROUTE, vec![Reply::status(504, "{}"), posted_reply()]), (REVIEWS_ROUTE, vec![Reply::ok("[]")])],
        )
        .await;
        let p = drafted(&fx).await;
        let back = fx.core.post_review_draft(&p.id, 0).await.unwrap();
        assert!(back.error.as_deref().unwrap().starts_with(REVIEW_MAYBE_POSTED_NOTE));
        let done = fx.core.post_review_draft(&p.id, 0).await.unwrap();
        assert_eq!((done.state, done.posted.map(|r| r.id)), (ProposalState::Applied, Some(77)));
        assert_eq!(posts(&fx).len(), 2);
        assert!(fx.github_seen().iter().any(|(_, t)| t == REVIEWS_ROUTE), "it looked first");
    }

    #[tokio::test]
    async fn a_422_that_isnt_about_the_lines_keeps_githubs_words_and_isnt_outdated() {
        let refused = Reply::status(422, "{\"message\":\"Unprocessable Entity\",\"errors\":[\"User can only have one pending review per pull request\"]}");
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()]), (POST_ROUTE, vec![refused])]).await;
        let p = drafted(&fx).await;
        let back = fx.core.post_review_draft(&p.id, 0).await.unwrap();
        assert_eq!(back.state, ProposalState::Pending);
        assert_eq!(back.error.as_deref(), Some("GitHub didn't accept the review: User can only have one pending review per pull request."));
    }

    #[tokio::test]
    async fn an_items_drafts_include_the_review_of_its_pull_request() {
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()])]).await;
        let p = drafted(&fx).await;
        let of_item = fx.core.proposals(&ProposalQuery { item: Some(fx.item("CA-1")), ..Default::default() }).await.unwrap();
        assert!(of_item.iter().any(|d| d.id == p.id), "{of_item:?}");
    }
}
