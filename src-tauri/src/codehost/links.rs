//! Link discovery: which work items a code change carries out, read from where it names them.

use std::collections::{HashMap, HashSet};

use super::keys::KeyMatcher;
use crate::domain::{CodeChange, DevLink, ItemRef, LinkSource};

/// The work item keys a workspace knows, and the connections whose projects have each key.
#[derive(Clone, Debug, Default)]
pub struct KnownKeys {
    matcher: KeyMatcher,
    connections: HashMap<String, Vec<String>>,
    cached: HashSet<(String, String)>,
}

impl KnownKeys {
    /// `projects` are `(project key, connection id)` pairs. Two sites can both have a project `TAF`.
    pub fn new<'a>(projects: impl IntoIterator<Item = (&'a str, &'a str)>) -> Self {
        let mut known = Self::default();
        for (prefix, connection) in projects {
            known.add_project(prefix, connection);
        }
        known
    }

    fn add_project(&mut self, prefix: &str, connection: &str) {
        let connections = self.connections.entry(prefix.trim().to_ascii_uppercase()).or_default();
        if !connections.iter().any(|c| c == connection) {
            connections.push(connection.to_string());
        }
        self.matcher = KeyMatcher::new(self.connections.keys());
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.matcher.is_empty()
    }

    /// The project keys that more than one connection has.
    pub fn shared_prefixes(&self) -> Vec<(&str, &[String])> {
        self.connections.iter().filter(|(_, c)| c.len() > 1).map(|(p, c)| (p.as_str(), c.as_slice())).collect()
    }

    /// Records the keys a connection has cached in watched projects. A key shared by several connections links only
    /// to those that have it.
    pub fn with_cached(mut self, connection: &str, keys: impl IntoIterator<Item = String>) -> Self {
        self.cached.extend(keys.into_iter().map(|k| (connection.to_string(), k.to_ascii_uppercase())));
        self
    }

    /// Makes sure `item`'s own connection is among those a link to its key may name.
    pub fn with_item(mut self, item: &ItemRef) -> Self {
        if let Some(prefix) = KeyMatcher::prefix_of(&item.key) {
            self.add_project(prefix, &item.connection_id);
        }
        self.with_cached(&item.connection_id, [item.key.clone()])
    }

    /// The work items `key` may name: the connections whose cache has it, or all that have its project when none does.
    pub fn items(&self, key: &str) -> Vec<ItemRef> {
        let Some(connections) = KeyMatcher::prefix_of(key).and_then(|p| self.connections.get(&p.to_ascii_uppercase())) else { return Vec::new() };
        let upper = key.to_ascii_uppercase();
        let having: Vec<&String> = connections.iter().filter(|c| self.cached.contains(&((*c).clone(), upper.clone()))).collect();
        let named = if having.is_empty() { connections.iter().collect() } else { having };
        named.into_iter().map(|c| ItemRef { connection_id: c.clone(), external_id: key.into(), key: key.into() }).collect()
    }

    pub fn find(&self, text: &str) -> Vec<String> {
        self.matcher.find(text)
    }
}

/// Fills in each change's `linked_keys` and returns the links found: one per work item and change, from the
/// place that names it most deliberately (branch, then title, then commit message, then description). A key that
/// two sites could own links to each and marks every link `ambiguous`.
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
            let items = known.items(&key);
            let ambiguous = items.len() > 1;
            for item in items {
                links.push(DevLink { item, change: change.clone(), provenance, confidence: provenance.confidence(), ambiguous });
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
            head_repo: None,
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

    fn only_connection(known: &KnownKeys, key: &str) -> String {
        let items = known.items(key);
        assert_eq!(items.len(), 1, "{items:?}");
        items[0].connection_id.clone()
    }

    #[test]
    fn each_project_keeps_its_own_connection() {
        let known = KnownKeys::new([("CA", "jira:a:me"), ("OPS", "jira:b:me")]);
        assert_eq!(only_connection(&known, "OPS-4"), "jira:b:me");
        assert_eq!(only_connection(&known, "CA-4"), "jira:a:me");
        assert!(known.items("ZZ-1").is_empty());
    }

    fn shared() -> KnownKeys {
        KnownKeys::new([("TAF", "jira:acme:me"), ("TAF", "jira:beta:me"), ("CA", "jira:acme:me")])
    }

    fn link_connections(known: &KnownKeys, branch: &str) -> Vec<(String, bool)> {
        let mut changes = vec![pr(1, branch, "", "")];
        discover(&mut changes, known).iter().map(|l| (l.item.connection_id.clone(), l.ambiguous)).collect()
    }

    #[test]
    fn a_key_that_two_sites_could_own_links_to_both_and_marks_each_link_ambiguous_when_neither_has_it_cached() {
        assert_eq!(link_connections(&shared(), "taf-12-fix"), [("jira:acme:me".to_string(), true), ("jira:beta:me".to_string(), true)]);
    }

    #[test]
    fn a_key_links_only_to_the_sites_that_have_the_item_cached() {
        let known = shared().with_cached("jira:beta:me", ["TAF-12".to_string()]).with_cached("jira:acme:me", ["TAF-3".to_string()]);
        assert_eq!(link_connections(&known, "taf-12-fix"), [("jira:beta:me".to_string(), false)]);
        assert_eq!(link_connections(&known, "taf-3-fix"), [("jira:acme:me".to_string(), false)]);
        assert_eq!(link_connections(&known, "taf-99-fix").len(), 2, "cached nowhere, so both stay candidates");
    }

    #[test]
    fn a_key_cached_on_both_sites_links_to_both_and_is_ambiguous() {
        let known = shared().with_cached("jira:beta:me", ["TAF-12".to_string()]).with_cached("jira:acme:me", ["TAF-12".to_string()]);
        assert_eq!(link_connections(&known, "taf-12-fix"), [("jira:acme:me".to_string(), true), ("jira:beta:me".to_string(), true)]);
    }

    #[test]
    fn a_project_only_one_site_has_never_links_ambiguously() {
        assert_eq!(link_connections(&shared(), "ca-5-fix"), [("jira:acme:me".to_string(), false)]);
    }

    #[test]
    fn the_item_being_looked_at_joins_the_sites_a_key_may_name() {
        let item = ItemRef { connection_id: "jira:gamma:me".into(), external_id: "TAF-12".into(), key: "TAF-12".into() };
        let known = shared().with_cached("jira:beta:me", ["TAF-12".to_string()]).with_item(&item);
        assert_eq!(link_connections(&known, "taf-12-fix"), [("jira:beta:me".to_string(), true), ("jira:gamma:me".to_string(), true)]);
    }
}
