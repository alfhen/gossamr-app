//! Translates the neutral filter into JQL.

use crate::domain::{Category, Depth, Filter, Watch};

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
        Filter::Label { label } => format!("labels = {}", quote(label)),
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

/// How far back a query reaches. Relative units, since a literal date would be read in the user's time zone.
fn since_clause(window_days: Option<u32>, updated_since_minutes: Option<u32>) -> Option<String> {
    let days = window_days.map(|d| u64::from(d) * 24 * 60);
    let minutes = match (days, updated_since_minutes.map(u64::from)) {
        (Some(d), Some(m)) => Some(d.min(m)),
        (d, m) => d.or(m),
    }?;
    Some(format!("updated >= -{minutes}m"))
}

/// The window a followed query reaches back over: `window_days`, or the last `updated_since_minutes` when that is less.
fn window(window_days: u32, updated_since_minutes: Option<u32>) -> String {
    match updated_since_minutes {
        None => format!("updated >= -{window_days}d"),
        Some(_) => since_clause(Some(window_days), updated_since_minutes).expect("bounded"),
    }
}

const INVOLVED: &str = "assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()";

/// Issues the signed-in person is involved in that changed within `window_days`, and within the last
/// `updated_since_minutes` when given.
pub(super) fn followed(window_days: u32, updated_since_minutes: Option<u32>) -> String {
    ordered(&format!("({INVOLVED}) AND {}", window(window_days, updated_since_minutes)))
}

fn project_list(watches: &[&Watch]) -> String {
    format!("project in ({})", watches.iter().map(|w| quote(&w.container.external_id)).collect::<Vec<_>>().join(", "))
}

/// Issues in the watched containers that changed within the window: the ones the person is involved in for a
/// container watched as `Involved` (`mentions` adds comments that mention them; Jira has no cheaper test for that),
/// all of them for one watched as `Whole`. `None` when nothing is watched.
pub(super) fn followed_in(window_days: u32, updated_since_minutes: Option<u32>, watches: &[Watch], mentions: bool) -> Option<String> {
    let involved: Vec<&Watch> = watches.iter().filter(|w| w.depth == Depth::Involved).collect();
    let whole: Vec<&Watch> = watches.iter().filter(|w| w.depth == Depth::Whole).collect();
    let who = if mentions { format!("{INVOLVED} OR comment ~ currentUser()") } else { INVOLVED.to_string() };
    let mut parts = Vec::new();
    if !involved.is_empty() {
        parts.push(format!("({} AND ({who}))", project_list(&involved)));
    }
    if !whole.is_empty() {
        parts.push(project_list(&whole));
    }
    (!parts.is_empty()).then(|| ordered(&format!("({}) AND {}", parts.join(" OR "), window(window_days, updated_since_minutes))))
}

/// The project named in a Jira 400 about a project that doesn't exist or can't be read, if it is one of `keys`.
/// Jira words it as `The value 'KEY' does not exist for the field 'project'.`
pub(super) fn bad_project(message: &str, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find(|k| ["'", "\\\"", "\""].iter().any(|q| message.contains(&format!("{q}{k}{q}"))))
        .map(|k| k.to_string())
}

/// Open items assigned to the person outside the watched projects.
pub(super) fn assigned_outside(watched: &[&str]) -> String {
    let outside = if watched.is_empty() {
        String::new()
    } else {
        format!(" AND project not in ({})", watched.iter().map(|k| quote(k)).collect::<Vec<_>>().join(", "))
    };
    ordered(&format!("assignee = currentUser() AND statusCategory != {}{outside}", quote(category_name(Category::Done))))
}

/// How the person touches work, one query each, over the last `days`. `mentioned` is an approximation: Jira has no
/// query for "comments that mention me", and text search over a comment finds the account.
pub(super) fn footprint(days: u32) -> [(&'static str, String); 4] {
    let q = |clause: &str| ordered(&format!("{clause} AND updated >= -{days}d"));
    [
        ("assigned", q("assignee = currentUser()")),
        ("reported", q("reporter = currentUser()")),
        ("watching", q("watcher = currentUser()")),
        ("mentioned", q("comment ~ currentUser()")),
    ]
}

pub(super) fn children(parent_keys: &[&str], updated_since_minutes: Option<u32>) -> String {
    let parents = format!("parent in ({})", parent_keys.join(","));
    match since_clause(None, updated_since_minutes) {
        Some(since) => ordered(&format!("{parents} AND {since}")),
        None => ordered(&parents),
    }
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
            followed(30, None),
            "(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= -30d ORDER BY updated DESC"
        );
        assert_eq!(children(&["CA-1", "CA-2"], None), "parent in (CA-1,CA-2) ORDER BY updated DESC");
    }

    #[test]
    fn an_updated_since_cursor_narrows_to_minutes_but_never_past_the_window() {
        assert!(followed(30, Some(15)).ends_with("AND updated >= -15m ORDER BY updated DESC"));
        assert!(followed(1, Some(5000)).ends_with("AND updated >= -1440m ORDER BY updated DESC"));
        assert_eq!(children(&["CA-1"], Some(20)), "parent in (CA-1) AND updated >= -20m ORDER BY updated DESC");
    }

    fn watch(key: &str, depth: Depth) -> Watch {
        Watch {
            container: ContainerRef { connection_id: "c".into(), external_id: key.into() },
            depth,
            pinned: false,
            source: crate::domain::WatchSource::Manual,
            added_at: String::new(),
            unwatched_at: None,
            inaccessible: false,
        }
    }

    #[test]
    fn a_scoped_query_limits_projects_and_separates_involved_from_whole() {
        let w = [watch("CA", Depth::Involved), watch("WEB", Depth::Whole), watch("OPS", Depth::Involved)];
        assert_eq!(
            followed_in(30, None, &w, false).unwrap(),
            "((project in (\"CA\", \"OPS\") AND (assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser())) OR project in (\"WEB\")) AND updated >= -30d ORDER BY updated DESC"
        );
        assert!(followed_in(30, None, &w[..1], true).unwrap().contains("OR comment ~ currentUser()))"));
        assert!(followed_in(30, Some(15), &w[1..2], true).unwrap().ends_with("(project in (\"WEB\")) AND updated >= -15m ORDER BY updated DESC"));
        assert_eq!(followed_in(30, None, &[], true), None);
    }

    #[test]
    fn the_project_jira_names_in_a_400_is_found_among_the_watched_keys() {
        let body = r#"{"errorMessages":["The value 'OLD' does not exist for the field 'project'."],"errors":{}}"#;
        assert_eq!(bad_project(body, &["CA", "OLD"]).as_deref(), Some("OLD"));
        assert_eq!(bad_project(body, &["CA"]), None);
        assert_eq!(bad_project(r#"[\"The value \"OLD\" does not exist\"]"#, &["OLD"]).as_deref(), Some("OLD"));
        assert_eq!(bad_project("Error in the JQL Query: bad", &["CA"]), None);
    }

    #[test]
    fn the_radar_query_excludes_watched_projects_and_done_items() {
        assert_eq!(
            assigned_outside(&["CA", "WEB"]),
            "assignee = currentUser() AND statusCategory != \"Done\" AND project not in (\"CA\", \"WEB\") ORDER BY updated DESC"
        );
        assert!(!assigned_outside(&[]).contains("project not in"));
    }

    #[test]
    fn the_footprint_asks_four_bounded_questions() {
        let qs = footprint(90);
        assert_eq!(qs.iter().map(|(k, _)| *k).collect::<Vec<_>>(), ["assigned", "reported", "watching", "mentioned"]);
        assert!(qs.iter().all(|(_, q)| q.contains("updated >= -90d")));
    }

    #[test]
    fn labels_are_quoted() {
        assert_eq!(jql(Filter::Label { label: "a b".into() }), "labels = \"a b\"");
    }
}
