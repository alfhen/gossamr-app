//! Types sent to the frontend. They mirror `src/types.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    /// Account ids mentioned in the comment.
    #[serde(default)]
    pub mentions: Vec<String>,
    /// The same people with the name shown in the text, so the UI can highlight `@Name`.
    #[serde(default)]
    pub mentioned: Vec<Mentioned>,
    /// The body as Jira's document (ADF), for rich rendering. `body` is its plain-text form.
    #[serde(default)]
    pub doc: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mentioned {
    pub account_id: String,
    pub name: String,
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
    #[serde(default)]
    pub description_doc: Option<Value>,
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
    pub description_doc: Option<Value>,
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

impl Snapshot {
    /// Unread events currently in the Inbox view, i.e. not done and not snoozed past `now` (RFC 3339).
    pub fn inbox_unread(&self, now: &str) -> usize {
        // Compared as instants: snooze times come from the webview with milliseconds, so string order isn't time order.
        let instant = |s: &str| chrono::DateTime::parse_from_rfc3339(s).ok();
        let now = instant(now);
        self.events
            .iter()
            .filter(|e| e.unread && e.done_at.is_none())
            .filter(|e| match (e.snoozed_until.as_deref().and_then(instant), now) {
                (Some(until), Some(now)) => until <= now,
                _ => true,
            })
            .count()
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Transition {
    pub id: String,
    pub name: String,
    pub to: Status,
}

/// A file uploaded to a ticket. `media_id` is its id in Atlassian's media service, which a comment needs to show it
/// inline; it's `None` when Jira didn't reveal it, and the comment then names the file instead.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Uploaded {
    pub id: String,
    pub filename: String,
    pub mime_type: String,
    pub media_id: Option<String>,
}

/// Keys created, in the order the summaries were given. `error` is set when creation stopped part-way.
#[derive(Clone, Debug, Serialize)]
pub struct CreatedSubtasks {
    pub created: Vec<String>,
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(unread: bool, done_at: Option<&str>, snoozed_until: Option<&str>) -> InboxEvent {
        InboxEvent {
            id: "1".into(),
            kind: EventKind::Comment,
            ticket_key: "A-1".into(),
            actor: Person { account_id: "s".into(), name: "S".into(), avatar_url: None },
            at: "2026-09-28T10:00:00Z".into(),
            text: String::new(),
            unread,
            done_at: done_at.map(String::from),
            snoozed_until: snoozed_until.map(String::from),
        }
    }

    #[test]
    fn inbox_unread_skips_read_done_and_snoozed_items() {
        let snap = Snapshot {
            me: Person { account_id: "me".into(), name: "Me".into(), avatar_url: None },
            site: String::new(),
            tickets: Default::default(),
            events: vec![
                event(true, None, None),
                event(false, None, None),
                event(true, Some("2026-09-28T11:00:00Z"), None),
                event(true, None, Some("2026-09-28T13:00:00Z")),
                event(true, None, Some("2026-09-28T11:00:00Z")),
            ],
            watching: vec![],
            last_sync_at: None,
            sync_error: None,
        };
        assert_eq!(snap.inbox_unread("2026-09-28T12:00:00Z"), 2);
    }

    #[test]
    fn inbox_unread_compares_snoozes_as_instants() {
        let snap = |until: &str| Snapshot {
            me: Person { account_id: "me".into(), name: "Me".into(), avatar_url: None },
            site: String::new(),
            tickets: Default::default(),
            events: vec![event(true, None, Some(until))],
            watching: vec![],
            last_sync_at: None,
            sync_error: None,
        };
        assert_eq!(snap("2026-09-28T12:00:00.000Z").inbox_unread("2026-09-28T12:00:00Z"), 1, "a snooze ending now is over");
        assert_eq!(snap("2026-09-28T14:30:00+02:00").inbox_unread("2026-09-28T12:00:00Z"), 0, "12:30 UTC is still ahead");
    }
}
