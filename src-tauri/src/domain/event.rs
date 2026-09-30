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

/// Where the next page of a feed starts: strictly after this entry in newest-first order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedCursor {
    pub at: String,
    pub id: String,
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
