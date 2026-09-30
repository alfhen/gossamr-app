//! Turns write intents into the requests Jira expects, and picks Jira's own ids for the neutral ones.

use serde_json::{json, Map, Value};

use super::adf;
use super::client::{IssueType, RawTransition};
use crate::domain::{ItemKind, ItemRef, LinkKind, NewItem, Patch, Priority};

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

/// The transition that leads to `status_id`. Jira may offer several; the first is taken.
pub(super) fn transition_to<'a>(transitions: &'a [RawTransition], status_id: &str) -> Option<&'a RawTransition> {
    transitions.iter().find(|t| t.to.id == status_id)
}

/// The body of the request that performs `transition`.
pub(super) fn transition_body(transition: &RawTransition) -> Value {
    json!({ "transition": { "id": transition.id } })
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
        RawTransition { id: id.into(), name: name.into(), to: StatusDef { id: to.into(), name: name.into(), category: Category::Active } }
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
        assert_eq!(transition_body(chosen), json!({ "transition": { "id": "31" } }));
        assert!(transition_to(&available, "31").is_none(), "a transition id is not a status id");
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
