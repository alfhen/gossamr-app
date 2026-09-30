//! Turns cached tickets into inbox events and "since you last looked" changes.

use crate::model::{CachedTicket, EventKind, FieldChange, MyAction, Person};

/// Changelog fields worth surfacing, with the label shown to the user. Everything else (rank, links, description
/// edits, worklogs…) is noise for an inbox.
const FIELDS: &[(&str, &str)] = &[
    ("status", "Status"),
    ("assignee", "Assignee"),
    ("priority", "Priority"),
    ("duedate", "Due date"),
    ("summary", "Summary"),
    ("Sprint", "Sprint"),
    ("resolution", "Resolution"),
    ("labels", "Labels"),
    ("Fix Version", "Fix version"),
    ("IssueParentAssociation", "Parent"),
];

fn label(field: &str) -> Option<&'static str> {
    FIELDS.iter().find(|(f, _)| f.eq_ignore_ascii_case(field)).map(|(_, l)| *l)
}

/// The field a change event is about, with the values exactly as Jira recorded them.
#[derive(Debug, Clone, PartialEq)]
pub struct FieldEdit {
    pub label: &'static str,
    pub from: Option<String>,
    pub to: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NewEvent {
    /// Stable across syncs, so inserting the same event twice is a no-op.
    pub id: String,
    pub kind: EventKind,
    pub ticket_key: String,
    pub actor: Person,
    pub at: String,
    pub text: String,
    /// Set on field changes, so consumers don't have to read the values back out of `text`.
    pub field: Option<FieldEdit>,
}

const EXCERPT_CHARS: usize = 280;

fn excerpt(s: &str) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= EXCERPT_CHARS {
        return flat;
    }
    format!("{}…", flat.chars().take(EXCERPT_CHARS).collect::<String>())
}

/// Events for things other people did on a ticket. Your own changes never show up in your inbox.
pub fn derive(t: &CachedTicket, me: &str) -> Vec<NewEvent> {
    let mut out = Vec::new();
    for h in t.history.iter().filter(|h| h.author.account_id != me) {
        for item in &h.items {
            let Some(label) = label(&item.field) else { continue };
            let from = item.from.as_deref().unwrap_or("None");
            let to = item.to.as_deref().unwrap_or("None");
            let (kind, text) = match label {
                "Status" => (EventKind::Status, format!("{from} → {to}")),
                "Assignee" if item.to_id.as_deref() == Some(me) => (EventKind::Assigned, "Assigned to you".to_string()),
                _ => (EventKind::Field, format!("{label} {from} → {to}")),
            };
            let field = (kind == EventKind::Field).then(|| FieldEdit { label, from: item.from.clone(), to: item.to.clone() });
            out.push(NewEvent {
                id: format!("h:{}:{}", h.id, item.field),
                kind,
                ticket_key: t.key.clone(),
                actor: h.author.clone(),
                at: h.at.clone(),
                text,
                field,
            });
        }
    }
    for c in t.comments.iter().filter(|c| c.author.account_id != me) {
        let kind = if c.mentions.iter().any(|m| m == me) { EventKind::Mention } else { EventKind::Comment };
        out.push(NewEvent {
            id: format!("c:{}", c.id),
            kind,
            ticket_key: t.key.clone(),
            actor: c.author.clone(),
            at: c.created.clone(),
            text: excerpt(&c.body),
            field: None,
        });
    }
    out
}

/// The user's own status changes and comments on a ticket, and its creation if they created it, keyed by an id that's stable
/// across syncs so storing them twice is a no-op.
pub fn my_actions(t: &CachedTicket, me: &str) -> Vec<(String, MyAction)> {
    let action = |kind: &str, at: &str, text: String| MyAction { ticket_key: t.key.clone(), at: at.to_string(), kind: kind.into(), text };
    let mut out: Vec<(String, MyAction)> = t
        .history
        .iter()
        .filter(|h| h.author.account_id == me)
        .flat_map(|h| {
            h.items.iter().filter(|i| i.field == "status").map(move |i| {
                let text = format!("{} → {}", i.from.as_deref().unwrap_or("None"), i.to.as_deref().unwrap_or("None"));
                (format!("h:{}:status", h.id), action("transition", &h.at, text))
            })
        })
        .collect();
    out.extend(t.comments.iter().filter(|c| c.author.account_id == me).map(|c| (format!("c:{}", c.id), action("comment", &c.created, String::new()))));
    if let (Some(creator), Some(created)) = (&t.creator, &t.created) {
        if creator.account_id == me {
            out.push((format!("created:{}", t.key), action("created", created, String::new())));
        }
    }
    out
}

/// Field changes by other people after `since` (an RFC 3339 timestamp), oldest first.
pub fn changes_since(t: &CachedTicket, me: &str, since: &str) -> Vec<FieldChange> {
    let mut out: Vec<FieldChange> = t
        .history
        .iter()
        .filter(|h| h.author.account_id != me && h.at.as_str() > since)
        .flat_map(|h| {
            h.items.iter().filter_map(|i| {
                Some(FieldChange {
                    field: label(&i.field)?.to_string(),
                    from: i.from.clone(),
                    to: i.to.clone(),
                    author: h.author.clone(),
                    at: h.at.clone(),
                })
            })
        })
        .collect();
    out.sort_by(|a, b| a.at.cmp(&b.at));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tracker::testing::sample_ticket;
    use crate::model::{History, HistoryItem};

    fn ticket() -> CachedTicket {
        sample_ticket()
    }

    fn sam() -> Person {
        Person { account_id: "sam".into(), name: "Sam".into(), avatar_url: None }
    }

    #[test]
    fn a_status_change_and_a_mention_become_events() {
        let events = derive(&ticket(), "me");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, EventKind::Status);
        assert_eq!(events[0].text, "In Progress → In Review");
        assert_eq!(events[0].id, "h:500:status");
        assert_eq!(events[1].kind, EventKind::Mention);
        assert_eq!(events[1].id, "c:10");
    }

    #[test]
    fn a_field_event_carries_the_values_jira_recorded() {
        let mut t = ticket();
        t.history = vec![History {
            id: "8".into(),
            author: sam(),
            at: "2026-09-28T10:00:00Z".into(),
            items: vec![
                HistoryItem { field: "summary".into(), from: Some("A".into()), to: Some("B → C".into()), to_id: None },
                HistoryItem { field: "labels".into(), from: Some("None".into()), to: None, to_id: None },
                HistoryItem { field: "duedate".into(), from: None, to: Some("2026-10-01".into()), to_id: None },
            ],
        }];
        t.comments.clear();
        let edits: Vec<FieldEdit> = derive(&t, "me").into_iter().filter_map(|e| e.field).collect();
        let edit = |label, from: Option<&str>, to: Option<&str>| FieldEdit { label, from: from.map(Into::into), to: to.map(Into::into) };
        assert_eq!(
            edits,
            [edit("Summary", Some("A"), Some("B → C")), edit("Labels", Some("None"), None), edit("Due date", None, Some("2026-10-01"))],
            "an arrow inside a value stays inside it, and a literal \"None\" is a value, not an absence"
        );
    }

    #[test]
    fn my_own_activity_is_not_news() {
        assert!(derive(&ticket(), "sam").is_empty());
    }

    #[test]
    fn being_assigned_is_its_own_kind() {
        let mut t = ticket();
        t.history = vec![History {
            id: "7".into(),
            author: sam(),
            at: "2026-09-28T10:00:00Z".into(),
            items: vec![
                HistoryItem { field: "assignee".into(), from: None, to: Some("Me Myself".into()), to_id: Some("me".into()) },
                HistoryItem { field: "Rank".into(), from: None, to: Some("x".into()), to_id: None },
            ],
        }];
        t.comments.clear();
        let events = derive(&t, "me");
        assert_eq!(events.len(), 1, "rank changes are noise");
        assert_eq!(events[0].kind, EventKind::Assigned);
    }

    #[test]
    fn long_comments_are_shortened() {
        let mut t = ticket();
        t.history.clear();
        t.comments[0].body = "word ".repeat(200);
        t.comments[0].mentions.clear();
        let e = &derive(&t, "me")[0];
        assert_eq!(e.kind, EventKind::Comment);
        assert!(e.text.ends_with('…'));
        assert!(e.text.chars().count() <= EXCERPT_CHARS + 1);
    }

    #[test]
    fn my_actions_are_my_status_changes_comments_and_tickets_i_created() {
        let mut t = ticket();
        t.history.push(History {
            id: "501".into(),
            author: Person { account_id: "me".into(), name: "Me".into(), avatar_url: None },
            at: "2026-09-28T09:30:00Z".into(),
            items: vec![
                HistoryItem { field: "status".into(), from: Some("In Review".into()), to: Some("Done".into()), to_id: None },
                HistoryItem { field: "priority".into(), from: None, to: Some("High".into()), to_id: None },
            ],
        });
        let actions = my_actions(&t, "me");
        let kinds: Vec<(&str, &str, &str)> = actions.iter().map(|(id, a)| (id.as_str(), a.kind.as_str(), a.text.as_str())).collect();
        assert_eq!(kinds, vec![("h:501:status", "transition", "In Review → Done"), ("created:CA-1", "created", "")]);
        assert!(my_actions(&t, "sam").iter().all(|(_, a)| a.kind != "created"), "Sam didn't create it");
    }

    #[test]
    fn changes_since_filters_by_time_and_author() {
        let t = ticket();
        assert_eq!(changes_since(&t, "me", "2026-09-28T06:00:00Z").len(), 1);
        assert!(changes_since(&t, "me", "2026-09-28T07:30:00Z").is_empty());
        assert!(changes_since(&t, "sam", "2026-09-28T06:00:00Z").is_empty());
    }
}
