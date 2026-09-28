//! Types sent to the frontend. They mirror `src/types.ts`.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub account_id: String,
    pub name: String,
    pub avatar_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Status {
    pub name: String,
    /// Jira's status category key: `new`, `indeterminate` or `done`.
    pub category: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Comment {
    pub id: String,
    pub author: Person,
    pub created: String,
    pub body: String,
    #[serde(default)]
    pub mentions: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FieldChange {
    pub field: String,
    pub from: Option<String>,
    pub to: Option<String>,
    pub author: Person,
    pub at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SubtaskRef {
    pub key: String,
    pub summary: String,
    pub done: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ParentRef {
    pub key: String,
    pub summary: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HistoryItem {
    pub field: String,
    pub from: Option<String>,
    pub to: Option<String>,
    /// Raw id for the new value, e.g. the account id for assignee changes.
    pub to_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct History {
    pub id: String,
    pub author: Person,
    pub at: String,
    pub items: Vec<HistoryItem>,
}

/// A ticket as cached locally, including the raw history used to derive events and the "since you last looked" diff.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CachedTicket {
    pub key: String,
    pub summary: String,
    pub issue_type: String,
    pub is_epic: bool,
    pub status: Status,
    pub priority: Option<String>,
    pub assignee: Option<Person>,
    pub reporter: Option<Person>,
    pub parent: Option<ParentRef>,
    pub description: String,
    pub comments: Vec<Comment>,
    pub subtasks: Vec<SubtaskRef>,
    pub due_date: Option<String>,
    pub updated: String,
    pub watching: bool,
    pub history: Vec<History>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ticket {
    pub key: String,
    pub summary: String,
    #[serde(rename = "type")]
    pub issue_type: String,
    pub status: Status,
    pub priority: Option<String>,
    pub assignee: Option<Person>,
    pub reporter: Option<Person>,
    pub parent: Option<ParentRef>,
    pub description: String,
    pub comments: Vec<Comment>,
    pub changes: Vec<FieldChange>,
    pub subtasks: Vec<SubtaskRef>,
    pub children: Vec<String>,
    pub due_date: Option<String>,
    pub sprint: Option<String>,
    pub url: String,
    pub updated: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EventKind {
    Mention,
    Comment,
    Status,
    Assigned,
    Field,
}

impl EventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mention => "mention",
            Self::Comment => "comment",
            Self::Status => "status",
            Self::Assigned => "assigned",
            Self::Field => "field",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "mention" => Self::Mention,
            "comment" => Self::Comment,
            "status" => Self::Status,
            "assigned" => Self::Assigned,
            _ => Self::Field,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxEvent {
    pub id: String,
    pub kind: EventKind,
    pub ticket_key: String,
    pub actor: Person,
    pub at: String,
    pub text: String,
    pub unread: bool,
    pub done_at: Option<String>,
    pub snoozed_until: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub me: Person,
    pub site: String,
    pub tickets: std::collections::BTreeMap<String, Ticket>,
    pub events: Vec<InboxEvent>,
    pub watching: Vec<String>,
    pub last_sync_at: Option<String>,
    pub sync_error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Transition {
    pub id: String,
    pub name: String,
    pub to: Status,
}
