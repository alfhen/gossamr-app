//! Which containers a person follows on each connection. Only watched containers are synced, shown, counted, given
//! to Pip, and (once it exists) drafted for by autopilot.
//!
//! Autopilot and triage must call `WatchSet::is_watched` (or `Core::is_item_watched`) with the container of the item
//! they are about to act on, and skip it when that is false. The read paths already filter, so this is the one check
//! a future writer has to remember.

use serde::{Deserialize, Serialize};

use super::ContainerRef;

/// A catalog this small is watched whole without asking.
pub const AUTO_EVERYTHING_MAX: usize = 12;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WatchMode {
    /// Nothing chosen yet. Behaves like `Everything` so nothing breaks before the person decides.
    #[default]
    Unset,
    Everything,
    Selected,
}

impl WatchMode {
    pub fn as_str(self) -> &'static str {
        match self {
            WatchMode::Unset => "unset",
            WatchMode::Everything => "everything",
            WatchMode::Selected => "selected",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "everything" => WatchMode::Everything,
            "selected" => WatchMode::Selected,
            _ => WatchMode::Unset,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Depth {
    /// Items assigned to, reported by or watched by the person, plus ones they commented on or were mentioned in.
    #[default]
    Involved,
    /// Everything in the container within the sync window.
    Whole,
}

impl Depth {
    pub fn as_str(self) -> &'static str {
        match self {
            Depth::Involved => "involved",
            Depth::Whole => "whole",
        }
    }

    pub fn parse(s: &str) -> Self {
        if s == "whole" {
            Depth::Whole
        } else {
            Depth::Involved
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WatchSource {
    #[default]
    Manual,
    Footprint,
    Auto,
    Everything,
}

impl WatchSource {
    pub fn as_str(self) -> &'static str {
        match self {
            WatchSource::Manual => "manual",
            WatchSource::Footprint => "footprint",
            WatchSource::Auto => "auto",
            WatchSource::Everything => "everything",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "footprint" => WatchSource::Footprint,
            "auto" => WatchSource::Auto,
            "everything" => WatchSource::Everything,
            _ => WatchSource::Manual,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Watch {
    pub container: ContainerRef,
    pub depth: Depth,
    pub pinned: bool,
    pub source: WatchSource,
    pub added_at: String,
    /// Set when the person stopped watching it; the data stays until the grace period ends.
    pub unwatched_at: Option<String>,
    /// The tracker refused the container (deleted, or no access). Its cached items stay visible.
    pub inaccessible: bool,
}

/// What one sync may touch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ContainerScope {
    Everything,
    Only(Vec<Watch>),
}

impl ContainerScope {
    pub fn allows(&self, container_id: &str) -> bool {
        match self {
            ContainerScope::Everything => true,
            ContainerScope::Only(w) => w.iter().any(|w| w.container.external_id == container_id),
        }
    }
}

/// Which containers a read may return.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Visible {
    All,
    Only(Vec<String>),
}

impl Visible {
    pub fn allows(&self, container_id: &str) -> bool {
        match self {
            Visible::All => true,
            Visible::Only(ids) => ids.iter().any(|i| i == container_id),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WatchSet {
    pub mode: WatchMode,
    pub watches: Vec<Watch>,
}

impl WatchSet {
    fn active(&self) -> impl Iterator<Item = &Watch> {
        self.watches.iter().filter(|w| w.unwatched_at.is_none())
    }

    pub fn is_watched(&self, container_id: &str) -> bool {
        self.mode != WatchMode::Selected || self.active().any(|w| w.container.external_id == container_id)
    }

    pub fn visible(&self) -> Visible {
        match self.mode {
            WatchMode::Selected => Visible::Only(self.active().map(|w| w.container.external_id.clone()).collect()),
            _ => Visible::All,
        }
    }

    /// Unavailable containers are left out of what a sync asks for, since one of them fails the whole query.
    pub fn sync_scope(&self) -> ContainerScope {
        match self.mode {
            WatchMode::Selected => ContainerScope::Only(self.active().filter(|w| !w.inaccessible).cloned().collect()),
            _ => ContainerScope::Everything,
        }
    }

    pub fn watch(&self, container_id: &str) -> Option<&Watch> {
        self.watches.iter().find(|w| w.container.external_id == container_id)
    }

    /// What a sync would ask for; a change means containers need a backfill.
    pub fn signature(&self) -> (bool, Vec<(String, Depth)>) {
        match self.sync_scope() {
            ContainerScope::Everything => (true, Vec::new()),
            ContainerScope::Only(w) => {
                let mut v: Vec<_> = w.iter().map(|w| (w.container.external_id.clone(), w.depth)).collect();
                v.sort();
                (false, v)
            }
        }
    }
}

/// One edit to a container's watch. Fields left out keep their value.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WatchChange {
    pub container_id: String,
    pub watched: Option<bool>,
    pub depth: Option<Depth>,
    pub pinned: Option<bool>,
    pub source: Option<WatchSource>,
}

/// A container in the catalog, cheap enough to list for thousands.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerSummary {
    #[serde(rename = "ref")]
    pub container_ref: ContainerRef,
    pub key: String,
    pub name: String,
    pub kind: Option<String>,
    pub archived: bool,
    /// When something in it last changed (RFC 3339), if the tracker says.
    pub last_active: Option<String>,
    /// How many items it holds, if the tracker says.
    pub item_hint: Option<u32>,
}

#[derive(Clone, Debug, Default)]
pub struct ContainerQuery {
    pub query: String,
    pub cursor: Option<String>,
    pub limit: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerPage {
    pub containers: Vec<ContainerSummary>,
    pub next: Option<String>,
}

/// How much the person has been involved in one container recently.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Footprint {
    pub container: ContainerRef,
    pub key: String,
    pub name: String,
    pub assigned: u32,
    pub reported: u32,
    pub watching: u32,
    /// `None` when the tracker has no way to count them.
    pub commented: Option<u32>,
    pub mentioned: Option<u32>,
    pub last_touch: Option<String>,
}

/// An open item assigned to the person in a container they don't watch.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stray {
    pub container: ContainerRef,
    pub container_name: String,
    pub keys: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn watch(id: &str, unwatched: bool) -> Watch {
        Watch {
            container: ContainerRef { connection_id: "c".into(), external_id: id.into() },
            depth: Depth::Involved,
            pinned: false,
            source: WatchSource::Manual,
            added_at: "2026-09-01T00:00:00Z".into(),
            unwatched_at: unwatched.then(|| "2026-09-02T00:00:00Z".into()),
            inaccessible: false,
        }
    }

    #[test]
    fn unset_and_everything_see_every_container_and_selected_only_its_own() {
        let rows = vec![watch("A", false), watch("B", true)];
        for mode in [WatchMode::Unset, WatchMode::Everything] {
            let s = WatchSet { mode, watches: rows.clone() };
            assert!(s.is_watched("Z") && s.visible() == Visible::All && s.sync_scope() == ContainerScope::Everything);
        }
        let s = WatchSet { mode: WatchMode::Selected, watches: rows };
        assert!(s.is_watched("A") && !s.is_watched("B") && !s.is_watched("Z"));
        assert_eq!(s.visible(), Visible::Only(vec!["A".into()]));
    }

    #[test]
    fn an_inaccessible_container_stays_visible_but_is_not_asked_for() {
        let mut bad = watch("A", false);
        bad.inaccessible = true;
        let s = WatchSet { mode: WatchMode::Selected, watches: vec![bad, watch("B", false)] };
        assert!(s.is_watched("A"));
        let ContainerScope::Only(asked) = s.sync_scope() else { panic!("selected mode scopes the sync") };
        assert_eq!(asked.len(), 1);
        assert!(!s.sync_scope().allows("A"));
    }

    #[test]
    fn the_signature_changes_only_when_what_a_sync_asks_for_changes() {
        let mut s = WatchSet { mode: WatchMode::Selected, watches: vec![watch("A", false)] };
        let before = s.signature();
        s.watches[0].pinned = true;
        assert_eq!(s.signature(), before, "pinning needs no backfill");
        s.watches[0].depth = Depth::Whole;
        assert_ne!(s.signature(), before);
    }
}
