//! Jira's tickets and comments as domain types.

use chrono::{DateTime, Utc};
use serde_json::Value;

use super::adf;
use crate::domain::{Category, Comment, ContainerRef, ItemKind, ItemRef, Person, PersonRef, Priority, StatusDef, WorkItem};
use crate::model::{self, CachedTicket};

pub(super) fn person_ref(conn: &str, p: &model::Person) -> PersonRef {
    PersonRef { connection_id: conn.into(), account_id: p.account_id.clone() }
}

pub(super) fn person(conn: &str, p: &model::Person) -> Person {
    Person { person_ref: person_ref(conn, p), display_name: p.name.clone(), avatar_url: p.avatar_url.clone() }
}

fn time(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s).map(|d| d.with_timezone(&Utc)).unwrap_or_default()
}

fn kind(t: &CachedTicket) -> ItemKind {
    let name = t.issue_type.to_lowercase();
    if t.is_epic || name == "epic" {
        ItemKind::Epic
    } else if name.contains("bug") {
        ItemKind::Bug
    } else if name.contains("story") {
        ItemKind::Story
    } else {
        ItemKind::Task
    }
}

fn priority(name: &str) -> Option<Priority> {
    match name.to_lowercase().as_str() {
        "highest" | "blocker" | "critical" => Some(Priority::Highest),
        "high" | "major" => Some(Priority::High),
        "medium" => Some(Priority::Medium),
        "low" | "minor" => Some(Priority::Low),
        "lowest" | "trivial" => Some(Priority::Lowest),
        _ => None,
    }
}

fn status(s: &model::Status) -> StatusDef {
    let category = match s.category.as_str() {
        "new" => Category::Todo,
        "done" => Category::Done,
        _ => Category::Active,
    };
    StatusDef { id: s.id.clone(), name: s.name.clone(), category }
}

/// Jira keys are `PROJECT-123`; the project key addresses the container.
fn project_key(issue_key: &str) -> &str {
    issue_key.rsplit_once('-').map_or(issue_key, |(project, _)| project)
}

pub(super) fn comment(conn: &str, c: &model::Comment) -> Comment {
    Comment {
        id: c.id.clone(),
        author: person_ref(conn, &c.author),
        body: c.doc.as_ref().map(|d| adf::to_doc(d, conn)).unwrap_or_else(|| crate::domain::Doc::paragraph(&c.body)),
        created: time(&c.created),
        mentions: c.mentions.iter().map(|id| PersonRef { connection_id: conn.into(), account_id: id.clone() }).collect(),
    }
}

/// The ticket as a work item. The whole ticket rides along in `extra` for the inbox, which still reads it.
pub(super) fn work_item(conn: &str, t: &CachedTicket) -> WorkItem {
    let last = t.comments.last();
    WorkItem {
        item: ItemRef { connection_id: conn.into(), external_id: t.key.clone(), key: t.key.clone() },
        container: ContainerRef { connection_id: conn.into(), external_id: project_key(&t.key).into() },
        kind: kind(t),
        title: t.summary.clone(),
        body: t.description_doc.as_ref().map(|d| adf::to_doc(d, conn)).unwrap_or_default(),
        status: status(&t.status),
        assignee: t.assignee.as_ref().map(|p| person_ref(conn, p)),
        reporter: t.reporter.as_ref().map(|p| person_ref(conn, p)),
        priority: t.priority.as_deref().and_then(priority),
        parent: t.parent.as_ref().map(|p| ItemRef { connection_id: conn.into(), external_id: p.key.clone(), key: p.key.clone() }),
        labels: vec![],
        created: t.created.as_deref().map(time).unwrap_or_else(|| time(&t.updated)),
        updated: time(&t.updated),
        links: vec![],
        comment_count: t.comments.len() as u32,
        last_commenter: last.map(|c| person_ref(conn, &c.author)),
        extra: serde_json::to_value(t).unwrap_or(Value::Null),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tracker::testing::sample_ticket;

    #[test]
    fn reads_a_ticket_as_a_work_item() {
        let w = work_item("jira:s:me", &sample_ticket());
        assert_eq!((w.item.key.as_str(), w.item.connection_id.as_str()), ("CA-1", "jira:s:me"));
        assert_eq!(w.container.external_id, "CA");
        assert_eq!(w.title, "Do the thing");
        assert_eq!(w.kind, ItemKind::Story);
        assert_eq!(w.priority, Some(Priority::High));
        assert_eq!(w.status, StatusDef { id: "3".into(), name: "In Review".into(), category: Category::Active });
        assert_eq!(w.assignee.unwrap().account_id, "me");
        assert!(w.reporter.is_none());
        assert_eq!(w.parent.unwrap().key, "CA-0");
        assert_eq!(w.body.plain_text(), "Hi");
        assert_eq!(w.comment_count, 1);
        assert_eq!(w.last_commenter.unwrap().account_id, "sam");
        assert_eq!(w.updated.to_rfc3339(), "2026-09-28T08:05:00+00:00");
        assert_eq!(w.created.to_rfc3339(), "2026-09-20T07:00:00+00:00");
    }

    #[test]
    fn the_ticket_survives_in_extra() {
        let t = sample_ticket();
        let back: CachedTicket = serde_json::from_value(work_item("c", &t).extra).unwrap();
        assert_eq!(serde_json::to_value(&back).unwrap(), serde_json::to_value(&t).unwrap());
    }

    #[test]
    fn comments_keep_their_mentions_and_structure() {
        let t = sample_ticket();
        let c = comment("c", &t.comments[0]);
        assert_eq!(c.author.account_id, "sam");
        assert_eq!(c.mentions, vec![PersonRef { connection_id: "c".into(), account_id: "me".into() }]);
        assert_eq!(c.body.plain_text(), "@Me");
        assert_eq!(c.created.to_rfc3339(), "2026-09-28T08:00:00+00:00");
    }

    #[test]
    fn maps_kinds_priorities_and_categories() {
        let mut t = sample_ticket();
        t.is_epic = true;
        assert_eq!(kind(&t), ItemKind::Epic);
        t.is_epic = false;
        t.issue_type = "Bug".into();
        assert_eq!(kind(&t), ItemKind::Bug);
        t.issue_type = "Sub-task".into();
        assert_eq!(kind(&t), ItemKind::Task);
        assert_eq!(priority("Blocker"), Some(Priority::Highest));
        assert_eq!(priority("Whatever"), None);
        let done = model::Status { id: "9".into(), name: "Done".into(), category: "done".into() };
        assert_eq!(status(&done).category, Category::Done);
        assert_eq!(status(&model::Status { category: "new".into(), ..done }).category, Category::Todo);
    }
}
