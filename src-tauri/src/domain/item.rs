use std::hash::{Hash, Hasher};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Doc, StatusRef};

/// Address of a work item. Identity is the connection plus the opaque id; `key` is display only.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemRef {
    pub connection_id: String,
    pub external_id: String,
    pub key: String,
}

impl PartialEq for ItemRef {
    fn eq(&self, other: &Self) -> bool {
        self.connection_id == other.connection_id && self.external_id == other.external_id
    }
}
impl Eq for ItemRef {}
impl Hash for ItemRef {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.connection_id.hash(state);
        self.external_id.hash(state);
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerRef {
    pub connection_id: String,
    pub external_id: String,
}

/// A Jira project or a Linear team.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    #[serde(rename = "ref")]
    pub container_ref: ContainerRef,
    pub key: String,
    pub name: String,
    pub workflow: super::Workflow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemKind {
    Task,
    Bug,
    Story,
    Epic,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Priority {
    Lowest,
    Low,
    Medium,
    High,
    Highest,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonRef {
    pub connection_id: String,
    pub account_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    #[serde(rename = "ref")]
    pub person_ref: PersonRef,
    pub display_name: String,
    pub avatar_url: Option<String>,
}

/// One human across connections, so "assigned to me" works for every connector.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub display_name: String,
    pub accounts: Vec<PersonRef>,
}

impl Identity {
    pub fn owns(&self, person: &PersonRef) -> bool {
        self.accounts.contains(person)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub author: PersonRef,
    pub body: Doc,
    pub created: DateTime<Utc>,
    #[serde(default)]
    pub mentions: Vec<PersonRef>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkKind {
    Blocks,
    Relates,
    Duplicates,
}

/// Either end may live in another container or connection.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Link {
    pub from: ItemRef,
    pub to: ItemRef,
    pub kind: LinkKind,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItem {
    pub item: ItemRef,
    pub container: ContainerRef,
    pub kind: ItemKind,
    pub title: String,
    pub body: Doc,
    pub status: StatusRef,
    pub assignee: Option<PersonRef>,
    pub reporter: Option<PersonRef>,
    pub priority: Option<Priority>,
    pub parent: Option<ItemRef>,
    #[serde(default)]
    pub labels: Vec<String>,
    pub created: DateTime<Utc>,
    pub updated: DateTime<Utc>,
    #[serde(default)]
    pub links: Vec<Link>,
    pub comment_count: u32,
    pub last_commenter: Option<PersonRef>,
    /// The raw connector payload.
    #[serde(default)]
    pub extra: Value,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn item_ref_identity_ignores_the_display_key() {
        let a = ItemRef { connection_id: "c".into(), external_id: "1".into(), key: "ENG-1".into() };
        let b = ItemRef { key: "ENG-9".into(), ..a.clone() };
        let other_site = ItemRef { connection_id: "d".into(), ..a.clone() };
        assert_eq!(a, b);
        assert_ne!(a, other_site);
    }
}
