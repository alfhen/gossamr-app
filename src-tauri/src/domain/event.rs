use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{ContainerRef, ItemRef, PersonRef};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EventKind {
    CommentAdded,
    StatusChanged,
    Assigned,
    ItemCreated,
    PrOpened,
    PrMerged,
    CheckFailed,
    ReviewRequested,
    PrClosed,
    PrReadyForReview,
    ReviewSubmitted,
    /// The person was mentioned on a pull request or issue.
    PrMentioned,
    /// Another field of an item changed: priority, labels, due date, summary and the like.
    FieldChanged,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Subject {
    Item { item: ItemRef },
    CodeChange { repo: String, number: u64 },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    pub connection_id: String,
    pub at: DateTime<Utc>,
    pub kind: EventKind,
    pub subject: Subject,
    pub actor: Option<PersonRef>,
    #[serde(default)]
    pub payload: Value,
}

/// Where the next page of a feed starts: strictly after this entry in newest-first order. Two accounts on one site
/// store the same event under the same `at` and `id`, so the connection breaks the tie.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedCursor {
    pub at: String,
    pub id: String,
    #[serde(default)]
    pub connection_id: String,
}

impl FeedCursor {
    pub fn of(entry: &FeedEntry) -> Self {
        Self { at: entry.at.clone(), id: entry.id.clone(), connection_id: entry.connection_id.clone() }
    }
}

/// What a feed shows. Empty `kinds` means every kind.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FeedQuery {
    pub kinds: Vec<EventKind>,
    /// Only comments that mention the signed-in person.
    pub mentions_only: bool,
    pub unread_only: bool,
    pub container: Option<ContainerRef>,
    /// Also entries about items in containers that aren't watched.
    pub include_unwatched: bool,
    pub before: Option<FeedCursor>,
    /// Zero asks for the default page size.
    pub limit: usize,
}

/// One event about an item, with the state the person has given it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedEntry {
    pub id: String,
    pub connection_id: String,
    /// As stored, so it can be sent back in a `FeedCursor`.
    pub at: String,
    pub kind: EventKind,
    pub item: ItemRef,
    /// `None` once the item has left the cache.
    pub item_title: Option<String>,
    pub actor: Option<PersonRef>,
    pub actor_name: Option<String>,
    pub text: String,
    pub mention: bool,
    pub unread: bool,
    pub done: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedPage {
    pub entries: Vec<FeedEntry>,
    /// Present when more entries follow.
    pub next: Option<FeedCursor>,
}

impl FeedPage {
    /// One page of up to `limit` entries from `pages`, each a page of the same query on its own connection. The
    /// cursor is the last entry kept, so whatever a connection had beyond it comes with the next page.
    pub fn merge(pages: Vec<FeedPage>, limit: usize) -> FeedPage {
        let more = pages.iter().any(|p| p.next.is_some());
        let mut entries: Vec<FeedEntry> = pages.into_iter().flat_map(|p| p.entries).collect();
        entries.sort_by(|a, b| (&b.at, &b.id, &b.connection_id).cmp(&(&a.at, &a.id, &a.connection_id)));
        let cut = entries.len() > limit;
        entries.truncate(limit);
        let next = (cut || more).then(|| entries.last().map(FeedCursor::of)).flatten();
        FeedPage { entries, next }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(connection: &str, id: &str, at: &str) -> FeedEntry {
        FeedEntry {
            id: id.into(),
            connection_id: connection.into(),
            at: at.into(),
            kind: EventKind::CommentAdded,
            item: ItemRef { connection_id: connection.into(), external_id: "CA-1".into(), key: "CA-1".into() },
            item_title: None,
            actor: None,
            actor_name: None,
            text: String::new(),
            mention: false,
            unread: true,
            done: false,
        }
    }

    fn page(entries: Vec<FeedEntry>, next: bool) -> FeedPage {
        let next = next.then(|| entries.last().map(FeedCursor::of)).flatten();
        FeedPage { entries, next }
    }

    fn ids(page: &FeedPage) -> Vec<String> {
        page.entries.iter().map(|e| format!("{}/{}", e.connection_id, e.id)).collect()
    }

    #[test]
    fn merged_pages_interleave_by_time_then_id_newest_first() {
        let a = page(vec![entry("a", "c:2", "2026-09-30T10:00:00Z"), entry("a", "c:1", "2026-09-30T08:00:00Z")], false);
        let b = page(vec![entry("b", "c:9", "2026-09-30T09:00:00Z"), entry("b", "c:3", "2026-09-30T08:00:00Z")], false);
        let merged = FeedPage::merge(vec![a, b], 10);
        assert_eq!(ids(&merged), ["a/c:2", "b/c:9", "b/c:3", "a/c:1"]);
        assert_eq!(merged.next, None);
    }

    #[test]
    fn a_merged_page_is_cut_at_the_limit_and_the_cursor_is_the_last_entry_kept() {
        let a = page(vec![entry("a", "c:2", "2026-09-30T10:00:00Z"), entry("a", "c:1", "2026-09-30T07:00:00Z")], false);
        let b = page(vec![entry("b", "c:9", "2026-09-30T09:00:00Z"), entry("b", "c:3", "2026-09-30T08:00:00Z")], false);
        let merged = FeedPage::merge(vec![a, b], 3);
        assert_eq!(ids(&merged), ["a/c:2", "b/c:9", "b/c:3"]);
        assert_eq!(merged.next, Some(FeedCursor { at: "2026-09-30T08:00:00Z".into(), id: "c:3".into(), connection_id: "b".into() }));
    }

    #[test]
    fn a_connection_with_more_pages_keeps_the_merged_feed_going_even_when_nothing_was_cut() {
        let a = page(vec![entry("a", "c:2", "2026-09-30T10:00:00Z")], true);
        let merged = FeedPage::merge(vec![a, page(Vec::new(), false)], 1);
        assert_eq!(merged.next, Some(FeedCursor { at: "2026-09-30T10:00:00Z".into(), id: "c:2".into(), connection_id: "a".into() }));
    }

    #[test]
    fn the_same_event_on_two_connections_is_ordered_by_connection_and_the_cursor_names_the_one_kept() {
        let a = page(vec![entry("a", "c:7", "2026-09-30T10:00:00Z")], false);
        let b = page(vec![entry("b", "c:7", "2026-09-30T10:00:00Z")], false);
        let merged = FeedPage::merge(vec![a, b], 1);
        assert_eq!(ids(&merged), ["b/c:7"]);
        assert_eq!(merged.next, Some(FeedCursor { at: "2026-09-30T10:00:00Z".into(), id: "c:7".into(), connection_id: "b".into() }));
    }

    #[test]
    fn no_pages_make_an_empty_feed_with_nothing_after_it() {
        assert_eq!(FeedPage::merge(Vec::new(), 50), FeedPage { entries: Vec::new(), next: None });
    }
}
