//! Translates the neutral filter into JQL.

use crate::domain::{Category, Filter};

#[derive(Debug, PartialEq)]
pub(super) enum Clause {
    /// Nothing the filter says can be asked of Jira.
    Everything,
    /// The filter can never match.
    Nothing,
    Jql(String),
}

const ORDER: &str = "ORDER BY updated DESC";

fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn category_name(c: Category) -> &'static str {
    match c {
        Category::Todo => "To Do",
        Category::Active => "In Progress",
        Category::Done => "Done",
    }
}

pub(super) fn compile(filter: &Filter) -> Clause {
    let jql = match filter {
        Filter::Mine => "assignee = currentUser()".to_string(),
        Filter::Unassigned => "assignee is EMPTY".to_string(),
        Filter::Open => format!("statusCategory != {}", quote(category_name(Category::Done))),
        Filter::Assignee { person } => format!("assignee = {}", quote(&person.account_id)),
        Filter::Status { name } => format!("status = {}", quote(name)),
        Filter::Category { category } => format!("statusCategory = {}", quote(category_name(*category))),
        Filter::Stale { days } => format!("statusCategory != {} AND updated <= -{days}d", quote(category_name(Category::Done))),
        Filter::Container { container } => format!("project = {}", quote(&container.external_id)),
        Filter::Parent { item } => format!("parent = {}", quote(&item.external_id)),
        Filter::Text { text } => format!("text ~ {}", quote(text)),
        Filter::Items { items } if items.is_empty() => return Clause::Nothing,
        Filter::Items { items } => {
            format!("key in ({})", items.iter().map(|i| quote(&i.external_id)).collect::<Vec<_>>().join(", "))
        }
        Filter::And { filters } => {
            let mut parts = Vec::new();
            for f in filters {
                match compile(f) {
                    Clause::Nothing => return Clause::Nothing,
                    Clause::Everything => {}
                    Clause::Jql(j) => parts.push(j),
                }
            }
            if parts.is_empty() {
                return Clause::Everything;
            }
            parts.join(" AND ")
        }
        // Views compute these from the cache: they depend on events and on links Jira can't filter by.
        Filter::NeedsMe | Filter::Blocked => return Clause::Everything,
    };
    Clause::Jql(jql)
}

pub(super) fn ordered(jql: &str) -> String {
    format!("{jql} {ORDER}")
}

/// Issues the signed-in person is involved in that changed within `window_days`.
pub(super) fn followed(window_days: u32) -> String {
    ordered(&format!(
        "(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= -{window_days}d"
    ))
}

pub(super) fn children(parent_keys: &[&str]) -> String {
    ordered(&format!("parent in ({})", parent_keys.join(",")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{ContainerRef, ItemRef, PersonRef};

    fn jql(f: Filter) -> String {
        match compile(&f) {
            Clause::Jql(j) => j,
            other => panic!("expected JQL, got {other:?}"),
        }
    }

    fn item(key: &str) -> ItemRef {
        ItemRef { connection_id: "c".into(), external_id: key.into(), key: key.into() }
    }

    #[test]
    fn translates_each_filter_it_can() {
        assert_eq!(jql(Filter::Mine), "assignee = currentUser()");
        assert_eq!(jql(Filter::Unassigned), "assignee is EMPTY");
        assert_eq!(jql(Filter::Open), "statusCategory != \"Done\"");
        assert_eq!(jql(Filter::Category { category: Category::Active }), "statusCategory = \"In Progress\"");
        assert_eq!(jql(Filter::Status { name: "In Review".into() }), "status = \"In Review\"");
        assert_eq!(jql(Filter::Assignee { person: PersonRef { connection_id: "c".into(), account_id: "712020:ab".into() } }), "assignee = \"712020:ab\"");
        assert_eq!(jql(Filter::Container { container: ContainerRef { connection_id: "c".into(), external_id: "CA".into() } }), "project = \"CA\"");
        assert_eq!(jql(Filter::Parent { item: item("CA-1") }), "parent = \"CA-1\"");
        assert_eq!(jql(Filter::Stale { days: 7 }), "statusCategory != \"Done\" AND updated <= -7d");
        assert_eq!(jql(Filter::Items { items: vec![item("CA-1"), item("CA-2")] }), "key in (\"CA-1\", \"CA-2\")");
    }

    #[test]
    fn quotes_user_text() {
        assert_eq!(jql(Filter::Text { text: r#"say "hi" \ now"#.into() }), r#"text ~ "say \"hi\" \\ now""#);
    }

    #[test]
    fn and_keeps_what_jira_can_express_and_drops_the_rest() {
        let f = Filter::And { filters: vec![Filter::Mine, Filter::NeedsMe, Filter::Open] };
        assert_eq!(jql(f), "assignee = currentUser() AND statusCategory != \"Done\"");
        assert_eq!(compile(&Filter::And { filters: vec![Filter::NeedsMe, Filter::Blocked] }), Clause::Everything);
        assert_eq!(compile(&Filter::And { filters: vec![] }), Clause::Everything);
    }

    #[test]
    fn a_filter_that_cannot_match_asks_nothing() {
        assert_eq!(compile(&Filter::Items { items: vec![] }), Clause::Nothing);
        assert_eq!(compile(&Filter::And { filters: vec![Filter::Mine, Filter::Items { items: vec![] }] }), Clause::Nothing);
    }

    #[test]
    fn client_side_filters_are_left_to_the_cache() {
        assert_eq!(compile(&Filter::NeedsMe), Clause::Everything);
        assert_eq!(compile(&Filter::Blocked), Clause::Everything);
    }

    #[test]
    fn the_inbox_queries_are_unchanged() {
        assert_eq!(
            followed(30),
            "(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= -30d ORDER BY updated DESC"
        );
        assert_eq!(children(&["CA-1", "CA-2"]), "parent in (CA-1,CA-2) ORDER BY updated DESC");
    }
}
