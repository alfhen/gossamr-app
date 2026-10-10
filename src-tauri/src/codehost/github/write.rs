//! The one write Gossamr makes to GitHub: a plain comment review of a pull request, posted once when the person
//! approves a review draft. Never an approval or a request for changes, and no other endpoint.

use chrono::Utc;
use reqwest::header::HeaderMap;
use serde_json::json;

use super::http::{error_for, error_message, Api};
use super::wire::ReviewPosted;
use crate::domain::{PostedReview, ReviewComment};
use crate::error::{Error, Result};

/// The only kind of review Gossamr posts. It is fixed here and never taken from a caller.
const EVENT: &str = "COMMENT";

/// What a 403 refusing a review says: the token can't write to pull requests in `repo`. Only a refusal in these words
/// is remembered as the repository not taking reviews (`GithubHost::post_review`); a rate limit or a single sign-on
/// demand is worded otherwise, and says nothing lasting about the token's access.
pub(super) fn no_write_access(repo: &str) -> String {
    format!("GitHub refused to post the review: the token can't write to pull requests in {repo}. Open the PR view instead, or reconnect GitHub with write access.")
}

/// The error a refused review becomes, worded for the person. A 422 whose errors name a line, a position or the commit
/// means GitHub couldn't place the review on the pull request as it is now (`Error::ReviewOutdated`); any other 422 is
/// GitHub refusing it for another reason, in its own words.
fn refusal(status: u16, h: &HeaderMap, body: &str, repo: &str, number: u64) -> Error {
    let general = error_for(status, h, body, Utc::now().timestamp());
    match status {
        // A rate limit or a single sign-on demand says something else, and its own words are the right ones.
        403 if matches!(general, Error::CodeHost { .. }) && h.get("x-github-sso").is_none() => Error::CodeHost { status, message: no_write_access(repo) },
        404 => Error::CodeHost { status, message: format!("GitHub couldn't find pull request #{number} in {repo}, or the token can't see it.") },
        422 => {
            let said = said(body);
            if misplaced(&said) {
                Error::ReviewOutdated(format!("GitHub couldn't place this review on the pull request as it is now ({said})."))
            } else {
                Error::CodeHost { status, message: format!("GitHub didn't accept the review: {said}.") }
            }
        }
        _ => general,
    }
}

/// Whether what a 422 said is about where the review sits: a line, position or path of the diff, or its commit.
fn misplaced(said: &str) -> bool {
    let said = said.to_ascii_lowercase();
    ["line", "position", "commit", "diff", "could not be resolved", "path"].iter().any(|w| said.contains(w))
}

/// What a 422 says: its errors when it lists them, else its message.
fn said(body: &str) -> String {
    let value: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    let details: Vec<String> = value
        .get("errors")
        .and_then(|e| e.as_array())
        .map(|errors| {
            errors
                .iter()
                .filter_map(|e| e.as_str().map(String::from).or_else(|| e.get("message").and_then(|m| m.as_str()).map(String::from)))
                .filter(|m| !m.trim().is_empty())
                .collect()
        })
        .unwrap_or_default();
    let said = if details.is_empty() { error_message(body) } else { details.join("; ") };
    said.trim().trim_end_matches('.').to_string()
}

/// Posts one comment review of pull request `number` in `repo` at `commit_sha`, with `summary` as its body and
/// `comments` on their lines. Sent once, never repeated.
pub(super) async fn post_review(api: &Api, repo: &str, number: u64, commit_sha: &str, summary: &str, comments: &[ReviewComment]) -> Result<PostedReview> {
    let body = json!({
        "commit_id": commit_sha,
        "body": summary,
        "event": EVENT,
        "comments": comments.iter().map(|c| json!({ "path": c.path, "line": c.line, "side": c.side, "body": c.body })).collect::<Vec<_>>(),
    });
    let (status, h, text) = api.post_json(&format!("/repos/{repo}/pulls/{number}/reviews"), &body).await?;
    if !(200..300).contains(&status) {
        return Err(refusal(status, &h, &text, repo, number));
    }
    let posted: ReviewPosted = serde_json::from_str(&text)?;
    let url = if posted.html_url.is_empty() { format!("https://github.com/{repo}/pull/{number}#pullrequestreview-{}", posted.id) } else { posted.html_url };
    Ok(PostedReview { id: posted.id, url, at: Utc::now() })
}
