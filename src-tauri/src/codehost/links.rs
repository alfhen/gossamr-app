//! Link discovery: which work items a code change carries out, read from where it names them.

use std::collections::HashMap;

use super::keys::KeyMatcher;
use crate::domain::{CodeChange, DevLink, ItemRef, LinkSource};

/// The work item keys a workspace knows, and the connection each project's items live on.
#[derive(Clone, Debug, Default)]
pub struct KnownKeys {
    matcher: KeyMatcher,
    connections: HashMap<String, String>,
}

impl KnownKeys {
    /// `projects` are `(project key, connection id)` pairs.
    pub fn new<'a>(projects: impl IntoIterator<Item = (&'a str, &'a str)>) -> Self {
        let connections: HashMap<String, String> = projects.into_iter().map(|(k, c)| (k.trim().to_ascii_uppercase(), c.to_string())).collect();
        Self { matcher: KeyMatcher::new(connections.keys()), connections }
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.matcher.is_empty()
    }

    pub fn item(&self, key: &str) -> Option<ItemRef> {
        let connection = self.connections.get(KeyMatcher::prefix_of(key)?)?;
        Some(ItemRef { connection_id: connection.clone(), external_id: key.into(), key: key.into() })
    }

    pub fn find(&self, text: &str) -> Vec<String> {
        self.matcher.find(text)
    }
}

/// Fills in each change's `linked_keys` and returns the links found: one per work item and change, from the
/// place that names it most deliberately (branch, then title, then commit message, then description).
pub fn discover(changes: &mut [CodeChange], known: &KnownKeys) -> Vec<DevLink> {
    let mut links = Vec::new();
    for change in changes.iter_mut() {
        let mut best: Vec<(String, LinkSource)> = Vec::new();
        for (source, text) in change.texts() {
            for key in known.find(text) {
                match best.iter_mut().find(|(k, _)| *k == key) {
                    Some((_, s)) if *s < source => *s = source,
                    Some(_) => {}
                    None => best.push((key, source)),
                }
            }
        }
        change.linked_keys = best.iter().map(|(k, _)| k.clone()).collect();
        for (key, provenance) in best {
            if let Some(item) = known.item(&key) {
                links.push(DevLink { item, change: change.clone(), provenance, confidence: provenance.confidence() });
            }
        }
    }
    links
}

#[cfg(test)]
pub(crate) mod tests {
    use chrono::{TimeZone, Utc};

    use super::*;
    use crate::domain::{CheckState, CodeChangeKind, CodeChangeState, ReviewState};

    pub fn pr(number: u64, branch: &str, title: &str, body: &str) -> CodeChange {
        CodeChange {
            connection_id: "github:ann".into(),
            external_id: CodeChange::pr_id("acme/webshop", number),
            kind: CodeChangeKind::PullRequest,
            repo: "acme/webshop".into(),
            number: Some(number),
            title: title.into(),
            head_ref: branch.into(),
            base_ref: Some("main".into()),
            state: CodeChangeState::Open,
            merged_at: None,
            created_at: Some(Utc.with_ymd_and_hms(2026, 9, 25, 8, 0, 0).unwrap()),
            updated_at: Utc.with_ymd_and_hms(2026, 9, 29, 9, 0, 0).unwrap(),
            author: None,
            reviewers: vec![],
            checks: CheckState::None,
            review: ReviewState::None,
            url: format!("https://github.com/acme/webshop/pull/{number}"),
            sha: Some("abc1234def".into()),
            additions: None,
            deletions: None,
            changed_files: None,
            body: body.into(),
            linked_keys: vec![],
        }
    }

    fn known() -> KnownKeys {
        KnownKeys::new([("CA", "jira:site:me"), ("DEVOPS", "jira:site:me"), ("WEB", "jira:site:me")])
    }

    #[test]
    fn a_branch_a_title_and_a_body_each_link_with_their_own_confidence() {
        let mut changes = vec![pr(1, "ca-208-gateway", "Route checkout", "Rollout in DEVOPS-471."), pr(2, "chore/x", "WEB-9: banner", "")];
        let links = discover(&mut changes, &known());
        let summary: Vec<_> = links.iter().map(|l| (l.item.key.as_str(), l.change.number.unwrap(), l.provenance)).collect();
        assert_eq!(summary, [("CA-208", 1, LinkSource::Branch), ("DEVOPS-471", 1, LinkSource::Body), ("WEB-9", 2, LinkSource::Title)]);
        assert!(links[0].confidence > links[1].confidence);
        assert_eq!(links[0].item.connection_id, "jira:site:me");
        assert_eq!(changes[0].linked_keys, ["CA-208", "DEVOPS-471"]);
    }

    #[test]
    fn the_most_deliberate_place_wins_when_a_key_appears_in_several() {
        let mut changes = vec![pr(1, "feature/CA-208", "CA-208 fix", "closes CA-208")];
        let links = discover(&mut changes, &known());
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].provenance, LinkSource::Branch);
        assert_eq!(changes[0].linked_keys, ["CA-208"]);
    }

    #[test]
    fn only_known_projects_link_and_a_workspace_with_none_links_nothing() {
        let mut changes = vec![pr(1, "utf-8-support", "Upgrade SHA-256 and ISO-8601 handling", "")];
        assert!(discover(&mut changes, &known()).is_empty());
        assert!(changes[0].linked_keys.is_empty());
        let mut changes = vec![pr(1, "ca-208", "", "")];
        assert!(discover(&mut changes, &KnownKeys::default()).is_empty());
        assert!(KnownKeys::default().is_empty());
    }

    #[test]
    fn a_commit_links_from_its_message_and_a_branch_from_its_name() {
        let mut commit = pr(0, "", "CA-300 fix rounding", "also touches WEB-1");
        commit.kind = CodeChangeKind::Commit;
        let mut branch = pr(0, "", "ca-301-spike", "");
        branch.kind = CodeChangeKind::Branch;
        let mut changes = vec![commit, branch];
        let links = discover(&mut changes, &known());
        let summary: Vec<_> = links.iter().map(|l| (l.item.key.as_str(), l.provenance)).collect();
        assert_eq!(summary, [("CA-300", LinkSource::Commit), ("WEB-1", LinkSource::Commit), ("CA-301", LinkSource::Branch)]);
    }

    #[test]
    fn each_project_keeps_its_own_connection() {
        let known = KnownKeys::new([("CA", "jira:a:me"), ("OPS", "jira:b:me")]);
        assert_eq!(known.item("OPS-4").unwrap().connection_id, "jira:b:me");
        assert_eq!(known.item("CA-4").unwrap().connection_id, "jira:a:me");
        assert!(known.item("ZZ-1").is_none());
    }
}
