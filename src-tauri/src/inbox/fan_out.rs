//! The reads that merge across the Jira connections that are on, and the reads that follow the connection of the
//! thing they are about.

use super::testing::{fixture_with_two_jira, Fixture};
use crate::auth::Scope;
use crate::domain::{FeedQuery, Filter, ItemRef, WatchChange};
use crate::error::Error;
use crate::events::NewEvent;
use crate::inbox::tracker;
use crate::model::{EventKind, Person};
use crate::tracker::testing::sample_ticket;

fn everything() -> Filter {
    Filter::And { filters: vec![] }
}

/// Adds `key` to the second account's cache, as the sample ticket in container `container`, updated at `updated`.
async fn add_to(fx: &Fixture, scope: &Scope, key: &str, container: &str, updated: &str) -> ItemRef {
    let connection = fx.core.connection(scope).unwrap();
    let mut item = tracker::item_from_ticket(&connection, &sample_ticket()).unwrap();
    item.item = connection.item(key);
    item.container.external_id = container.into();
    item.title = format!("{key} on {}", scope.connection_id);
    item.updated = updated.parse().unwrap();
    let at = item.item.clone();
    fx.core.with_db_for(scope, |db| db.upsert_items(&[item], "2026-09-29T12:00:00Z").map(|_| ())).await.unwrap();
    at
}

async fn event_in(fx: &Fixture, scope: &Scope, id: &str, key: &str, at: &str) {
    let actor = Person { account_id: "sam".into(), name: "Sam".into(), avatar_url: None };
    let event = NewEvent { id: id.into(), kind: EventKind::Comment, ticket_key: key.into(), actor, at: at.into(), text: "hi".into(), field: None };
    let connection_id = scope.connection_id.clone();
    fx.core
        .with_db_for(scope, |db| {
            db.insert_events(std::slice::from_ref(&event), "2000-01-01T00:00:00Z")?;
            db.insert_cache_events(&crate::sync::domain_event(&connection_id, &event).into_iter().collect::<Vec<_>>())
        })
        .await
        .unwrap();
}

fn titles(items: &[crate::domain::WorkItem]) -> Vec<&str> {
    items.iter().map(|i| i.title.as_str()).collect()
}

#[tokio::test]
async fn a_search_merges_the_items_of_every_connection_that_is_on_newest_first() {
    let (fx, second) = fixture_with_two_jira().await;
    fx.edit_item("CA-1", |i| i.updated = "2026-09-29T08:00:00Z".parse().unwrap()).await;
    add_to(&fx, &second, "CA-1", "CA", "2026-09-29T10:00:00Z").await;
    add_to(&fx, &second, "CA-2", "CA", "2026-09-29T07:00:00Z").await;

    let found = fx.core.cache_search(&everything(), false).await.unwrap();

    let keys: Vec<(&str, &str)> = found.iter().map(|i| (i.item.connection_id.as_str(), i.item.key.as_str())).collect();
    assert_eq!(keys, [("jira:beta:bo", "CA-1"), ("jira:site:me", "CA-1"), ("jira:beta:bo", "CA-2")], "the same key on two sites is two items");
    assert!(found.iter().all(|i| i.extra.is_null()), "the tracker payload stays in Core");
}

#[tokio::test]
async fn a_connection_that_is_off_is_left_out_of_every_merged_read_until_it_is_on_again() {
    let (fx, second) = fixture_with_two_jira().await;
    fx.core.adopt_instances().await;
    add_to(&fx, &second, "BO-1", "BO", "2026-09-29T10:00:00Z").await;
    event_in(&fx, &second, "c:1", "BO-1", "2026-09-29T10:00:00Z").await;
    assert_eq!(fx.core.cache_search(&everything(), true).await.unwrap().len(), 2);

    fx.core.set_instance_enabled("jira_2", false).await.unwrap();

    assert_eq!(titles(&fx.core.cache_search(&everything(), true).await.unwrap()), ["Ticket 1"]);
    assert_eq!(fx.core.cache_feed(&FeedQuery::default()).await.unwrap().entries.len(), 0);
    assert_eq!(fx.core.cache_feed_unread(&[]).await.unwrap(), 0);
    let me = fx.core.cache_me().await.unwrap();
    assert_eq!(me.accounts.iter().map(|a| a.account_id.as_str()).collect::<Vec<_>>(), ["me"]);
    let watching: Vec<String> = fx.core.watch_state().await.unwrap().into_iter().map(|w| w.connection_id).collect();
    assert_eq!(watching, ["jira:site:me"]);

    fx.core.set_instance_enabled("jira_2", true).await.unwrap();
    assert_eq!(fx.core.cache_search(&everything(), true).await.unwrap().len(), 2);
}

#[tokio::test]
async fn every_connection_off_leaves_the_reads_empty_and_the_person_known_as_the_primary() {
    let (fx, _second) = fixture_with_two_jira().await;
    fx.core.adopt_instances().await;
    fx.core.set_instance_enabled("jira", false).await.unwrap();
    fx.core.set_instance_enabled("jira_2", false).await.unwrap();

    assert!(fx.core.cache_search(&everything(), true).await.unwrap().is_empty());
    assert!(fx.core.cache_containers(true).await.unwrap().is_empty());
    assert!(fx.core.watch_state().await.unwrap().is_empty());
    assert_eq!(fx.core.cache_me().await.unwrap().display_name, "Me");
}

#[tokio::test]
async fn containers_people_and_the_person_cover_every_connection_that_is_on() {
    let (fx, second) = fixture_with_two_jira().await;
    add_to(&fx, &second, "BO-1", "BO", "2026-09-29T10:00:00Z").await;
    let container = fx.core.cache_containers(true).await.unwrap().into_iter().next().unwrap();
    fx.core.with_db_for(&second, |db| db.replace_containers("jira:beta:bo", &[container], "2026-09-29T12:00:00Z")).await.unwrap();

    let containers = fx.core.cache_containers(true).await.unwrap();
    let owners: Vec<&str> = containers.iter().map(|c| c.container_ref.connection_id.as_str()).collect();
    assert_eq!(owners, ["jira:site:me", "jira:beta:bo"]);

    let me = fx.core.cache_me().await.unwrap();
    assert_eq!(me.display_name, "Me");
    assert_eq!(me.accounts.iter().map(|a| (a.connection_id.as_str(), a.account_id.as_str())).collect::<Vec<_>>(), [("jira:site:me", "me"), ("jira:beta:bo", "bo")]);

    let names: Vec<String> = fx.core.cache_people().await.unwrap().into_iter().map(|p| p.name).collect();
    assert!(names.contains(&"Sam".to_string()), "{names:?}");
}

#[tokio::test]
async fn the_feed_merges_by_time_and_id_and_pages_through_both_connections() {
    let (fx, second) = fixture_with_two_jira().await;
    add_to(&fx, &second, "CA-1", "CA", "2026-09-29T10:00:00Z").await;
    event_in(&fx, &fx.scope, "c:1", "CA-1", "2026-09-29T09:00:00Z").await;
    event_in(&fx, &second, "c:7", "CA-1", "2026-09-29T11:00:00Z").await;
    event_in(&fx, &fx.scope, "c:2", "CA-1", "2026-09-29T12:00:00Z").await;
    event_in(&fx, &second, "c:8", "CA-1", "2026-09-29T08:00:00Z").await;

    let first = fx.core.cache_feed(&FeedQuery { limit: 3, ..Default::default() }).await.unwrap();
    let seen = |page: &crate::domain::FeedPage| page.entries.iter().map(|e| format!("{}/{}", e.connection_id, e.id)).collect::<Vec<_>>();
    assert_eq!(seen(&first), ["jira:site:me/c:2", "jira:beta:bo/c:7", "jira:site:me/c:1"]);

    let rest = fx.core.cache_feed(&FeedQuery { limit: 3, before: first.next, ..Default::default() }).await.unwrap();
    assert_eq!(seen(&rest), ["jira:beta:bo/c:8"]);
    assert_eq!(rest.next, None);
}

#[tokio::test]
async fn one_event_seen_by_two_connections_is_not_lost_when_a_page_ends_between_them() {
    let (fx, second) = fixture_with_two_jira().await;
    add_to(&fx, &second, "CA-1", "CA", "2026-09-29T10:00:00Z").await;
    event_in(&fx, &fx.scope, "c:10500", "CA-1", "2026-09-29T09:00:00Z").await;
    event_in(&fx, &second, "c:10500", "CA-1", "2026-09-29T09:00:00Z").await;
    let seen = |page: &crate::domain::FeedPage| page.entries.iter().map(|e| e.connection_id.clone()).collect::<Vec<_>>();

    let first = fx.core.cache_feed(&FeedQuery { limit: 1, ..Default::default() }).await.unwrap();
    let rest = fx.core.cache_feed(&FeedQuery { limit: 1, before: first.next.clone(), ..Default::default() }).await.unwrap();

    let mut both = seen(&first);
    both.extend(seen(&rest));
    both.sort();
    assert_eq!(both, ["jira:beta:bo", "jira:site:me"]);
    assert_eq!(rest.next, None);
}

#[tokio::test]
async fn a_feed_of_one_container_reads_only_the_connection_that_container_belongs_to() {
    let (fx, second) = fixture_with_two_jira().await;
    add_to(&fx, &second, "CA-1", "CA", "2026-09-29T10:00:00Z").await;
    event_in(&fx, &fx.scope, "c:1", "CA-1", "2026-09-29T09:00:00Z").await;
    event_in(&fx, &second, "c:2", "CA-1", "2026-09-29T09:00:00Z").await;
    let ca = crate::domain::ContainerRef { connection_id: "jira:site:me".into(), external_id: "CA".into() };

    let page = fx.core.cache_feed(&FeedQuery { container: Some(ca), ..Default::default() }).await.unwrap();

    assert_eq!(page.entries.iter().map(|e| e.connection_id.as_str()).collect::<Vec<_>>(), ["jira:site:me"]);
}

#[tokio::test]
async fn unread_counts_add_up_and_marking_an_event_read_touches_only_its_own_connection() {
    let (fx, second) = fixture_with_two_jira().await;
    add_to(&fx, &second, "CA-1", "CA", "2026-09-29T10:00:00Z").await;
    event_in(&fx, &fx.scope, "c:1", "CA-1", "2026-09-29T09:00:00Z").await;
    event_in(&fx, &second, "c:1", "CA-1", "2026-09-29T09:00:00Z").await;
    assert_eq!(fx.core.cache_feed_unread(&[]).await.unwrap(), 2);

    fx.core.set_unread("jira:beta:bo", "c:1", false).await.unwrap();

    assert_eq!(fx.core.cache_feed_unread(&[]).await.unwrap(), 1);
    let unread = fx.core.cache_feed(&FeedQuery { unread_only: true, ..Default::default() }).await.unwrap();
    assert_eq!(unread.entries.iter().map(|e| e.connection_id.as_str()).collect::<Vec<_>>(), ["jira:site:me"]);
}

#[tokio::test]
async fn a_read_that_names_an_item_goes_to_the_connection_of_that_item() {
    let (fx, second) = fixture_with_two_jira().await;
    let theirs = add_to(&fx, &second, "BO-9", "BO", "2026-09-29T10:00:00Z").await;
    event_in(&fx, &second, "c:5", "BO-9", "2026-09-29T09:00:00Z").await;

    assert_eq!(fx.core.cache_item(&theirs).await.unwrap().unwrap().item, theirs);
    assert!(fx.core.with_db_for(&fx.scope, |db| db.item(&fx.item("BO-9"))).await.unwrap().is_none(), "the first account never saw it");
    assert_eq!(fx.core.cache_events(&theirs, 10).await.unwrap().len(), 1);
    assert!(fx.core.cache_events(&fx.item("BO-9"), 10).await.unwrap().is_empty());
    assert_eq!(fx.core.cache_comments(&theirs, false).await.unwrap().len(), 1);

    let asked = fx.core.mentionable(&theirs, "ann").await.unwrap();
    assert_eq!(asked.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["ann on jira:beta:bo"], "the people are asked of the item's own site");
    let unknown = ItemRef { connection_id: "jira:gone:x".into(), external_id: "X-1".into(), key: "X-1".into() };
    assert!(matches!(fx.core.mentionable(&unknown, "ann").await, Err(Error::SiteChanged)));
    assert!(matches!(fx.core.cache_events(&unknown, 10).await, Err(Error::SiteChanged)));
    assert!(matches!(fx.core.set_unread("jira:gone:x", "c:5", false).await, Err(Error::SiteChanged)));
}

#[tokio::test]
async fn watching_is_read_for_every_connection_and_changed_on_the_one_named() {
    let (fx, _second) = fixture_with_two_jira().await;
    let watch = |id: &str| WatchChange { container_id: id.into(), watched: Some(true), ..Default::default() };

    let before: Vec<String> = fx.core.watch_state().await.unwrap().into_iter().map(|w| w.connection_id).collect();
    assert_eq!(before, ["jira:site:me", "jira:beta:bo"]);

    fx.core.watch_set_containers("jira:beta:bo", &[watch("BO")]).await.unwrap();

    let states = fx.core.watch_state().await.unwrap();
    let watched: Vec<(&str, usize)> = states.iter().map(|w| (w.connection_id.as_str(), w.watches.len())).collect();
    assert_eq!(watched, [("jira:site:me", 0), ("jira:beta:bo", 1)]);
    assert!(matches!(fx.core.watch_set_containers("jira:gone:x", &[watch("X")]).await, Err(Error::SiteChanged)));
}

#[tokio::test]
async fn settings_list_one_row_per_jira_connection_in_the_order_they_were_added() {
    let (fx, _second) = fixture_with_two_jira().await;
    fx.core.adopt_instances().await;

    let rows = fx.core.connections().await.unwrap();

    let listed: Vec<(&str, &str, &str)> = rows.iter().map(|r| (r.id.as_str(), r.instance_id.as_str(), r.account.as_str())).collect();
    assert_eq!(listed, [("jira:site:me", "jira", "Me"), ("jira:beta:bo", "jira_2", "Bo")]);
}
