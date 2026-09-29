use std::collections::HashSet;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use super::{Category, ContainerRef, Identity, ItemRef, LinkKind, PersonRef, WorkItem};

/// The connector-neutral query language behind views, chips and Pip's search.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Filter {
    NeedsMe,
    Mine,
    Unassigned,
    Blocked,
    Open,
    Assignee { person: PersonRef },
    Status { name: String },
    Category { category: Category },
    Stale { days: u32 },
    Container { container: ContainerRef },
    Parent { item: ItemRef },
    Text { text: String },
    /// A lens: exactly these items.
    Items { items: Vec<ItemRef> },
    And { filters: Vec<Filter> },
}

pub struct FilterContext {
    pub me: Identity,
    pub now: DateTime<Utc>,
    /// Items flagged as waiting on the user, computed from events and reviews by the caller.
    pub needs_me: HashSet<ItemRef>,
}

impl Filter {
    pub fn select<'a>(&self, items: &'a [WorkItem], ctx: &FilterContext) -> Vec<&'a WorkItem> {
        items.iter().filter(|i| self.matches(i, items, ctx)).collect()
    }

    /// `all` is the wider slice used to resolve links; a blocker missing from it counts as still blocking.
    pub fn matches(&self, item: &WorkItem, all: &[WorkItem], ctx: &FilterContext) -> bool {
        let open = item.status.category != Category::Done;
        match self {
            Filter::NeedsMe => ctx.needs_me.contains(&item.item),
            Filter::Mine => item.assignee.as_ref().is_some_and(|a| ctx.me.owns(a)),
            Filter::Unassigned => item.assignee.is_none(),
            Filter::Blocked => open && is_blocked(item, all),
            Filter::Open => open,
            Filter::Assignee { person } => item.assignee.as_ref() == Some(person),
            Filter::Status { name } => item.status.name.eq_ignore_ascii_case(name),
            Filter::Category { category } => item.status.category == *category,
            Filter::Stale { days } => open && ctx.now - item.updated >= Duration::days(i64::from(*days)),
            Filter::Container { container } => item.container == *container,
            Filter::Parent { item: parent } => item.parent.as_ref() == Some(parent),
            Filter::Text { text } => {
                let needle = text.to_lowercase();
                item.title.to_lowercase().contains(&needle)
                    || item.item.key.to_lowercase().contains(&needle)
                    || item.body.plain_text().to_lowercase().contains(&needle)
            }
            Filter::Items { items } => items.contains(&item.item),
            Filter::And { filters } => filters.iter().all(|f| f.matches(item, all, ctx)),
        }
    }
}

fn is_blocked(item: &WorkItem, all: &[WorkItem]) -> bool {
    let blocker_is_open = |blocker: &ItemRef| {
        all.iter()
            .find(|i| i.item == *blocker)
            .is_none_or(|b| b.status.category != Category::Done)
    };
    let incoming = item.links.iter().chain(all.iter().flat_map(|i| i.links.iter()));
    incoming
        .filter(|l| l.kind == LinkKind::Blocks && l.to == item.item)
        .any(|l| blocker_is_open(&l.from))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::fixtures::*;
    use crate::domain::{Doc, Link};

    fn ctx() -> FilterContext {
        FilterContext {
            me: Identity { display_name: "Me".into(), accounts: vec![person("me"), PersonRef { connection_id: "gh".into(), account_id: "me-gh".into() }] },
            now: now(),
            needs_me: HashSet::from([item_ref("3")]),
        }
    }

    fn ids(items: Vec<&WorkItem>) -> Vec<&str> {
        items.iter().map(|i| i.item.external_id.as_str()).collect()
    }

    fn run(filter: Filter, items: &[WorkItem]) -> Vec<String> {
        ids(filter.select(items, &ctx())).into_iter().map(String::from).collect()
    }

    #[test]
    fn mine_matches_any_account_of_the_identity() {
        let mut a = work_item("1", "todo");
        a.assignee = Some(person("me"));
        let mut b = work_item("2", "todo");
        b.assignee = Some(PersonRef { connection_id: "gh".into(), account_id: "me-gh".into() });
        let mut c = work_item("3", "todo");
        c.assignee = Some(person("other"));
        let d = work_item("4", "todo");
        let items = [a, b, c, d];
        assert_eq!(run(Filter::Mine, &items), ["1", "2"]);
        assert_eq!(run(Filter::Unassigned, &items), ["4"]);
        assert_eq!(run(Filter::Assignee { person: person("other") }, &items), ["3"]);
    }

    #[test]
    fn needs_me_uses_the_supplied_set() {
        let items = [work_item("1", "todo"), work_item("3", "todo")];
        assert_eq!(run(Filter::NeedsMe, &items), ["3"]);
    }

    #[test]
    fn open_status_and_category() {
        let items = [work_item("1", "todo"), work_item("2", "review"), work_item("3", "done")];
        assert_eq!(run(Filter::Open, &items), ["1", "2"]);
        assert_eq!(run(Filter::Status { name: "review".into() }, &items), ["2"]);
        assert_eq!(run(Filter::Category { category: Category::Done }, &items), ["3"]);
    }

    #[test]
    fn stale_counts_only_open_items_past_the_threshold() {
        let mut old = work_item("1", "doing");
        old.updated = now() - Duration::days(10);
        let mut old_done = work_item("2", "done");
        old_done.updated = now() - Duration::days(10);
        let mut edge = work_item("3", "doing");
        edge.updated = now() - Duration::days(7);
        let fresh = work_item("4", "doing");
        let items = [old, old_done, edge, fresh];
        assert_eq!(run(Filter::Stale { days: 7 }, &items), ["1", "3"]);
    }

    #[test]
    fn blocked_clears_once_the_blocker_is_done() {
        let blocks = |from: &str, to: &str| Link { from: item_ref(from), to: item_ref(to), kind: LinkKind::Blocks };
        let mut blocker = work_item("1", "doing");
        blocker.links.push(blocks("1", "2"));
        let blocked = work_item("2", "todo");
        assert_eq!(run(Filter::Blocked, &[blocker.clone(), blocked.clone()]), ["2"]);

        blocker.status = status("done");
        assert!(run(Filter::Blocked, &[blocker, blocked.clone()]).is_empty());

        let mut dangling = work_item("5", "todo");
        dangling.links.push(blocks("99", "5"));
        assert_eq!(run(Filter::Blocked, &[dangling]), ["5"]);
    }

    #[test]
    fn container_parent_and_lens() {
        let mut child = work_item("2", "todo");
        child.parent = Some(item_ref("1"));
        let mut elsewhere = work_item("3", "todo");
        elsewhere.container.external_id = "other".into();
        let items = [work_item("1", "todo"), child, elsewhere];
        assert_eq!(run(Filter::Container { container: items[2].container.clone() }, &items), ["3"]);
        assert_eq!(run(Filter::Parent { item: item_ref("1") }, &items), ["2"]);
        assert_eq!(run(Filter::Items { items: vec![item_ref("3"), item_ref("1")] }, &items), ["1", "3"]);
    }

    #[test]
    fn text_searches_title_key_and_body_case_insensitively() {
        let mut a = work_item("1", "todo");
        a.title = "Fix Checkout".into();
        let mut b = work_item("2", "todo");
        b.body = Doc::paragraph("the checkout is slow");
        let c = work_item("3", "todo");
        let items = [a, b, c];
        assert_eq!(run(Filter::Text { text: "CHECKOUT".into() }, &items), ["1", "2"]);
        assert_eq!(run(Filter::Text { text: "eng-3".into() }, &items), ["3"]);
    }

    #[test]
    fn and_requires_all_and_empty_matches_everything() {
        let mut a = work_item("1", "todo");
        a.assignee = Some(person("me"));
        let mut b = work_item("2", "done");
        b.assignee = Some(person("me"));
        let items = [a, b];
        let both = Filter::And { filters: vec![Filter::Mine, Filter::Open] };
        assert_eq!(run(both, &items), ["1"]);
        assert_eq!(run(Filter::And { filters: vec![] }, &items), ["1", "2"]);
    }

    #[test]
    fn round_trips_through_json() {
        let f = Filter::And { filters: vec![Filter::Stale { days: 3 }, Filter::Text { text: "x".into() }] };
        let back: Filter = serde_json::from_value(serde_json::to_value(&f).unwrap()).unwrap();
        assert_eq!(f, back);
    }
}
