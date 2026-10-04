//! Turns write intents into the requests Jira expects, and picks Jira's own ids for the neutral ones.

use serde_json::{json, Map, Value};

use super::adf;
use super::client::{IssueType, RawTransition, RequiredField};
use crate::domain::{BodyChange, ItemKind, ItemRef, LinkKind, NewItem, Patch, Priority, TitleChange};

fn priority_name(p: Priority) -> &'static str {
    match p {
        Priority::Lowest => "Lowest",
        Priority::Low => "Low",
        Priority::Medium => "Medium",
        Priority::High => "High",
        Priority::Highest => "Highest",
    }
}

fn issue_type_name(kind: ItemKind) -> &'static str {
    match kind {
        ItemKind::Task => "Task",
        ItemKind::Bug => "Bug",
        ItemKind::Story => "Story",
        ItemKind::Epic => "Epic",
    }
}

/// The project's issue type for `kind`, matched by name, ignoring sub-task types.
pub(super) fn pick_type(kind: ItemKind, types: &[IssueType]) -> Option<&IssueType> {
    types.iter().filter(|t| !t.subtask).find(|t| t.name.eq_ignore_ascii_case(issue_type_name(kind)))
}

pub(super) fn update_fields(patch: &Patch) -> Value {
    let mut fields = Map::new();
    if let Some(a) = &patch.assignee {
        fields.insert("assignee".into(), json!({ "accountId": a.account_id }));
    }
    if let Some(p) = &patch.parent {
        fields.insert("parent".into(), json!({ "key": p.external_id }));
    }
    if let Some(p) = patch.priority {
        fields.insert("priority".into(), json!({ "name": priority_name(p) }));
    }
    Value::Object(fields)
}

/// The fields a rewrite sets. Only what changed is sent, so a title-only rewrite can't touch the description.
pub(super) fn rewrite_fields(title: Option<&TitleChange>, body: Option<&BodyChange>) -> Value {
    let mut fields = Map::new();
    if let Some(t) = title {
        fields.insert("summary".into(), json!(t.to.trim()));
    }
    if let Some(b) = body {
        fields.insert("description".into(), adf::from_doc(&b.to));
    }
    Value::Object(fields)
}

pub(super) fn create_fields(project: &str, issue_type: &IssueType, item: &NewItem) -> Value {
    let mut fields = match update_fields(&Patch { assignee: item.assignee.clone(), parent: item.parent.clone(), priority: item.priority }) {
        Value::Object(f) => f,
        _ => Map::new(),
    };
    fields.insert("project".into(), json!({ "key": project }));
    fields.insert("issuetype".into(), json!({ "id": issue_type.id }));
    fields.insert("summary".into(), json!(item.title));
    if !item.body.blocks.is_empty() {
        fields.insert("description".into(), adf::from_doc(&item.body));
    }
    if !item.labels.is_empty() {
        fields.insert("labels".into(), json!(item.labels));
    }
    Value::Object(fields)
}

/// `from` blocks / relates to / duplicates `to`. Jira names the ends by their link description, so the issue that
/// does the blocking is the inward one. `None` for kinds that aren't issue links, which must never reach Jira.
pub(super) fn link_body(from: &ItemRef, to: &ItemRef, kind: LinkKind) -> Option<Value> {
    let name = match kind {
        LinkKind::Blocks => "Blocks",
        LinkKind::Relates => "Relates",
        LinkKind::Duplicates => "Duplicate",
        LinkKind::ImplementedBy => return None,
    };
    Some(json!({ "type": { "name": name }, "inwardIssue": { "key": from.external_id }, "outwardIssue": { "key": to.external_id } }))
}

/// What Gossamr can fill in for a required field: only `resolution`, preferring "Done", since closing an issue is the one
/// move that routinely demands it.
fn fill(field: &RequiredField) -> Option<Value> {
    if field.id != "resolution" {
        return None;
    }
    let (id, _) = field.allowed.iter().find(|(_, name)| name.eq_ignore_ascii_case("done")).or_else(|| field.allowed.first())?;
    Some(json!({ "id": id }))
}

fn fillable(t: &RawTransition) -> bool {
    t.required.iter().all(|f| fill(f).is_some())
}

/// The transition that leads to `status_id`. Jira may offer several; the first one whose required fields can be filled
/// is taken, else the first, so `transition_body` can say what is missing.
pub(super) fn transition_to<'a>(transitions: &'a [RawTransition], status_id: &str) -> Option<&'a RawTransition> {
    let mut to = transitions.iter().filter(|t| t.to.id == status_id);
    let first = to.next()?;
    Some(std::iter::once(first).chain(to).find(|t| fillable(t)).unwrap_or(first))
}

/// The body of the request that performs `transition`, or the names of the required fields it can't fill.
pub(super) fn transition_body(transition: &RawTransition) -> std::result::Result<Value, Vec<String>> {
    let mut fields = Map::new();
    let mut missing = Vec::new();
    for f in &transition.required {
        match fill(f) {
            Some(v) => {
                fields.insert(f.id.clone(), v);
            }
            None => missing.push(f.name.clone()),
        }
    }
    if !missing.is_empty() {
        return Err(missing);
    }
    let mut body = json!({ "transition": { "id": transition.id } });
    if !fields.is_empty() {
        body["fields"] = Value::Object(fields);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Category, Doc, PersonRef, StatusDef};

    fn item(key: &str) -> ItemRef {
        ItemRef { connection_id: "c".into(), external_id: key.into(), key: key.into() }
    }

    fn ty(id: &str, name: &str, subtask: bool) -> IssueType {
        IssueType { id: id.into(), name: name.into(), subtask }
    }

    fn transition(id: &str, name: &str, to: &str) -> RawTransition {
        RawTransition { id: id.into(), name: name.into(), to: StatusDef { id: to.into(), name: name.into(), category: Category::Active }, required: vec![] }
    }

    #[test]
    fn maps_a_status_id_to_the_transition_that_reaches_it() {
        let ts = [transition("11", "Start", "3"), transition("21", "Finish", "5"), transition("22", "Also finish", "5")];
        assert_eq!(transition_to(&ts, "5").map(|t| t.id.as_str()), Some("21"));
        assert_eq!(transition_to(&ts, "3").map(|t| t.id.as_str()), Some("11"));
        assert!(transition_to(&ts, "9").is_none());
    }

    #[test]
    fn a_status_id_from_the_page_becomes_jiras_transition_id_in_the_request() {
        let recorded = json!({ "expand": "transitions", "transitions": [
            { "id": "11", "name": "Start Progress", "to": { "id": "3", "name": "In Progress", "statusCategory": { "id": 4, "key": "indeterminate" } }, "hasScreen": false },
            { "id": "31", "name": "Done", "to": { "id": "10001", "name": "Done", "statusCategory": { "id": 3, "key": "done" } }, "isGlobal": true }
        ]});
        let available = super::super::client::parse_transitions(&recorded);
        let chosen = transition_to(&available, "10001").unwrap();
        assert_eq!(transition_body(chosen), Ok(json!({ "transition": { "id": "31" } })));
        assert!(transition_to(&available, "31").is_none(), "a transition id is not a status id");
    }

    fn required(id: &str, name: &str, allowed: &[(&str, &str)]) -> RequiredField {
        RequiredField { id: id.into(), name: name.into(), allowed: allowed.iter().map(|(i, n)| (i.to_string(), n.to_string())).collect() }
    }

    #[test]
    fn a_required_resolution_is_filled_with_done_and_other_required_fields_are_named() {
        let resolutions = [("10000", "Won't Do"), ("10001", "Done")];
        let mut t = transition("31", "Done", "5");
        t.required = vec![required("resolution", "Resolution", &resolutions)];
        assert_eq!(transition_body(&t), Ok(json!({ "transition": { "id": "31" }, "fields": { "resolution": { "id": "10001" } } })));
        t.required = vec![required("resolution", "Resolution", &[("7", "Fixed")])];
        assert_eq!(transition_body(&t).unwrap()["fields"]["resolution"]["id"], "7", "no Done to prefer, so the first");
        t.required = vec![required("customfield_10040", "Root cause", &[]), required("resolution", "Resolution", &resolutions)];
        assert_eq!(transition_body(&t), Err(vec!["Root cause".to_string()]));
    }

    #[test]
    fn a_transition_needing_nothing_unfillable_is_preferred_among_several() {
        let mut blocked = transition("21", "Finish with cause", "5");
        blocked.required = vec![required("customfield_10040", "Root cause", &[])];
        let ts = [blocked, transition("22", "Finish", "5")];
        assert_eq!(transition_to(&ts, "5").map(|t| t.id.as_str()), Some("22"));
        let only = [ts.into_iter().next().unwrap()];
        assert_eq!(transition_to(&only, "5").map(|t| t.id.as_str()), Some("21"), "still found, so the error can name what's missing");
    }

    #[test]
    fn picks_the_issue_type_by_name_and_never_a_subtask() {
        let types = [ty("1", "Sub-task", true), ty("2", "task", false), ty("3", "Bug", false)];
        assert_eq!(pick_type(ItemKind::Task, &types).map(|t| t.id.as_str()), Some("2"));
        assert_eq!(pick_type(ItemKind::Bug, &types).map(|t| t.id.as_str()), Some("3"));
        assert!(pick_type(ItemKind::Epic, &types).is_none());
    }

    #[test]
    fn a_patch_only_sends_what_it_sets() {
        assert_eq!(update_fields(&Patch::default()), json!({}));
        let patch = Patch {
            assignee: Some(PersonRef { connection_id: "c".into(), account_id: "acc".into() }),
            parent: Some(item("CA-9")),
            priority: Some(Priority::High),
        };
        assert_eq!(
            update_fields(&patch),
            json!({ "assignee": { "accountId": "acc" }, "parent": { "key": "CA-9" }, "priority": { "name": "High" } })
        );
    }

    #[test]
    fn a_new_item_carries_project_type_and_only_the_fields_given() {
        let new = NewItem {
            title: "Fix it".into(),
            body: Doc::paragraph("Details"),
            kind: ItemKind::Bug,
            assignee: None,
            parent: None,
            priority: Some(Priority::Low),
            labels: vec!["web".into()],
        };
        let fields = create_fields("CA", &ty("10004", "Bug", false), &new);
        assert_eq!(fields["project"], json!({ "key": "CA" }));
        assert_eq!(fields["issuetype"], json!({ "id": "10004" }));
        assert_eq!(fields["summary"], "Fix it");
        assert_eq!(fields["description"]["content"][0]["content"][0]["text"], "Details");
        assert_eq!(fields["labels"], json!(["web"]));
        assert_eq!(fields["priority"], json!({ "name": "Low" }));
        assert!(fields.get("assignee").is_none() && fields.get("parent").is_none());

        let bare = NewItem { body: Doc::default(), labels: vec![], priority: None, ..new };
        let fields = create_fields("CA", &ty("1", "Bug", false), &bare);
        assert!(fields.get("description").is_none() && fields.get("labels").is_none());
    }

    #[test]
    fn links_name_jiras_own_link_types() {
        let body = link_body(&item("CA-1"), &item("CA-2"), LinkKind::Blocks).unwrap();
        assert_eq!(body["type"]["name"], "Blocks");
        assert_eq!(body["inwardIssue"]["key"], "CA-1", "the blocker is the inward issue");
        assert_eq!(body["outwardIssue"]["key"], "CA-2");
        assert_eq!(link_body(&item("a"), &item("b"), LinkKind::Duplicates).unwrap()["type"]["name"], "Duplicate");
        assert!(link_body(&item("a"), &item("b"), LinkKind::ImplementedBy).is_none(), "code links are never written to Jira");
    }
}
