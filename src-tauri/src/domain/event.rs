use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{ItemRef, PersonRef};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodeChangeState {
    Draft,
    Open,
    Merged,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckState {
    None,
    Pending,
    Passing,
    Failing,
}

/// A pull request.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeChange {
    pub connection_id: String,
    pub repo: String,
    pub number: u64,
    pub title: String,
    pub branch: String,
    pub state: CodeChangeState,
    pub author: PersonRef,
    #[serde(default)]
    pub reviewers: Vec<PersonRef>,
    pub checks: CheckState,
    /// Item keys found in the title and branch.
    #[serde(default)]
    pub linked_keys: Vec<String>,
}

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
