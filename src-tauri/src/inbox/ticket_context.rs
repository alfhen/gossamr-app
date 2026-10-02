//! Gathers what an agent is told about a ticket from what is already cached: the item with its comments, the titles of
//! the tickets it points at, and the pull requests and branches the code index has linked to it. Nothing here asks the
//! network.

use chrono::{DateTime, Utc};

use super::Core;
use crate::db::Db;
use crate::domain::{ticket_snapshot, CheckState, CodeChange, CodeChangeKind, CodeChangeState, DevLink, ItemRef, LinkKind, SnapComment, TicketFacts, WorkItem};
use crate::model::CachedTicket;

impl Core {
    /// The code changes linked to `item`, or none when the code index can't be read: a missing link must not stop a draft.
    pub(super) fn ticket_dev_links(&self, item: &ItemRef) -> Vec<DevLink> {
        self.dev_links(item).unwrap_or_default()
    }
}

/// The text the agent is shown for `work`. `links` come from `Core::ticket_dev_links`, read before the database is locked.
pub(super) fn snapshot(db: &Db, work: &WorkItem, links: &[DevLink]) -> String {
    ticket_snapshot(&facts(db, work, links))
}

fn facts(db: &Db, work: &WorkItem, links: &[DevLink]) -> TicketFacts {
    // The cache keeps the whole ticket in `extra`, with the names the item itself only has as account ids.
    let cached: Option<CachedTicket> = serde_json::from_value(work.extra.clone()).ok();
    let title_of = |item: &ItemRef| db.item(item).ok().flatten().map(|w| w.title);
    let with_title = |item: &ItemRef| match title_of(item) {
        Some(title) => format!("{} {}", item.key, title),
        None => item.key.clone(),
    };
    TicketFacts {
        key: work.item.key.clone(),
        title: work.title.clone(),
        kind: Some(work.kind),
        status: cached.as_ref().map_or_else(|| work.status.name.clone(), |t| t.status.name.clone()),
        priority: cached.as_ref().and_then(|t| t.priority.clone()).or_else(|| work.priority.map(|p| format!("{p:?}"))),
        assignee: cached.as_ref().and_then(|t| t.assignee.as_ref()).map(|p| p.name.clone()),
        reporter: cached.as_ref().and_then(|t| t.reporter.as_ref()).map(|p| p.name.clone()),
        labels: work.labels.clone(),
        parent: work.parent.as_ref().map(with_title),
        linked: work
            .links
            .iter()
            .filter(|l| l.kind != LinkKind::ImplementedBy)
            .map(|l| {
                let outward = l.from == work.item;
                let other = if outward { &l.to } else { &l.from };
                format!("{} {}", relation(l.kind, outward), with_title(other))
            })
            .collect(),
        code: links.iter().map(|l| change_line(&l.change)).collect(),
        description: work.body.plain_text(),
        comments: cached.as_ref().map(|t| t.comments.iter().map(|c| SnapComment { author: c.author.name.clone(), at: parse_time(&c.created), text: c.body.clone() }).collect()),
    }
}

fn relation(kind: LinkKind, outward: bool) -> &'static str {
    match (kind, outward) {
        (LinkKind::Blocks, true) => "blocks",
        (LinkKind::Blocks, false) => "is blocked by",
        (LinkKind::Duplicates, true) => "duplicates",
        (LinkKind::Duplicates, false) => "is duplicated by",
        _ => "relates to",
    }
}

fn change_line(c: &CodeChange) -> String {
    let state = match c.state {
        CodeChangeState::Draft => "draft",
        CodeChangeState::Open => "open",
        CodeChangeState::Merged => "merged",
        CodeChangeState::Closed => "closed",
    };
    match c.kind {
        CodeChangeKind::PullRequest => {
            let checks = match c.checks {
                CheckState::None => "",
                CheckState::Pending => ", checks pending",
                CheckState::Passing => ", checks passing",
                CheckState::Failing => ", checks failing",
            };
            format!("pull request {} ({state}{checks}), branch {}: {}", c.label(), c.head_ref, c.title)
        }
        CodeChangeKind::Branch => format!("branch {} ({state})", c.label()),
        CodeChangeKind::Commit => format!("commit {}: {}", c.label(), c.title),
    }
}

fn parse_time(text: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(text).ok().map(|t| t.with_timezone(&Utc))
}
