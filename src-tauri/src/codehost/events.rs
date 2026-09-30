//! Neutral events for the Activity feed, derived by comparing a change with what was cached before.

use chrono::{DateTime, Utc};
use serde_json::json;

use crate::domain::{CheckState, CodeChange, CodeChangeState, Event, EventKind, Notice, PersonRef, ReviewInfo, ReviewState, Subject};

#[cfg(test)]
fn person(change: &CodeChange, login: &str) -> PersonRef {
    PersonRef { connection_id: change.connection_id.clone(), account_id: login.into() }
}

fn is_me(p: &PersonRef, me: &str) -> bool {
    p.account_id.eq_ignore_ascii_case(me)
}

fn stamp(at: DateTime<Utc>) -> i64 {
    at.timestamp()
}

fn event(change: &CodeChange, suffix: &str, at: DateTime<Utc>, kind: EventKind, actor: Option<PersonRef>, verb: &str, extra: serde_json::Value) -> Event {
    let text = match &actor {
        Some(a) => format!("{} {verb} {}: {}", a.account_id, change.label(), change.title),
        None => format!("{verb} {}: {}", change.label(), change.title),
    };
    let mut payload = json!({
        "text": text,
        "repo": change.repo,
        "number": change.number,
        "title": change.title,
        "url": change.url,
    });
    if let (Some(map), Some(more)) = (payload.as_object_mut(), extra.as_object()) {
        map.extend(more.clone());
    }
    Event {
        id: format!("{}:{suffix}", change.external_id),
        connection_id: change.connection_id.clone(),
        at,
        kind,
        subject: Subject::CodeChange { repo: change.repo.clone(), number: change.number.unwrap_or_default() },
        actor,
        payload,
    }
}

/// What happened to a pull request between `prev` (as cached, or `None` when it is new) and `now`. `reviews` are its
/// reviews as just read. Ids are built from what happened, so deriving the same thing twice stores it once.
pub fn derive(me: &str, prev: Option<&CodeChange>, now: &CodeChange, reviews: &[ReviewInfo]) -> Vec<Event> {
    let mut out = Vec::new();
    let author = now.author.clone();
    let mine = author.as_ref().is_some_and(|a| is_me(a, me));

    if prev.is_none() {
        out.push(event(now, "opened", now.created_at.unwrap_or(now.updated_at), EventKind::PrOpened, author.clone(), "opened", json!({})));
    }
    if now.state == CodeChangeState::Merged && prev.is_none_or(|p| p.state != CodeChangeState::Merged) {
        out.push(event(now, "merged", now.merged_at.unwrap_or(now.updated_at), EventKind::PrMerged, author.clone(), "merged", json!({})));
    }
    if now.state == CodeChangeState::Closed && prev.is_none_or(|p| p.state != CodeChangeState::Closed) {
        out.push(event(now, "closed", now.updated_at, EventKind::PrClosed, author.clone(), "closed", json!({})));
    }
    if now.state == CodeChangeState::Open && prev.is_some_and(|p| p.state == CodeChangeState::Draft) {
        out.push(event(now, &format!("ready:{}", stamp(now.updated_at)), now.updated_at, EventKind::PrReadyForReview, author.clone(), "marked ready for review", json!({})));
    }
    let active = matches!(now.state, CodeChangeState::Open | CodeChangeState::Draft);
    if active && now.reviewers.iter().any(|r| is_me(r, me)) && prev.is_none_or(|p| !p.reviewers.iter().any(|r| is_me(r, me))) {
        let suffix = format!("review-requested:{}:{}", me.to_ascii_lowercase(), stamp(now.updated_at));
        let mut e = event(now, &suffix, now.updated_at, EventKind::ReviewRequested, author.clone(), "asked you to review", json!({ "mention": true }));
        e.actor = author.clone();
        out.push(e);
    }
    if mine {
        for r in reviews.iter().filter(|r| !is_me(&r.reviewer, me) && matches!(r.state, ReviewState::Approved | ReviewState::ChangesRequested | ReviewState::Commented)) {
            let verb = match r.state {
                ReviewState::Approved => "approved",
                ReviewState::ChangesRequested => "requested changes on",
                _ => "reviewed",
            };
            let state = serde_json::to_value(r.state).unwrap_or_default();
            out.push(event(now, &format!("review:{}", r.id), r.at.unwrap_or(now.updated_at), EventKind::ReviewSubmitted, Some(r.reviewer.clone()), verb, json!({ "review": state })));
        }
        if now.checks == CheckState::Failing && active && prev.is_none_or(|p| p.checks != CheckState::Failing || p.sha != now.sha) {
            let sha = now.sha.as_deref().unwrap_or_default();
            out.push(event(now, &format!("checks-failed:{sha}"), now.updated_at, EventKind::CheckFailed, None, "Checks failed on", json!({ "sha": sha })));
        }
    }
    out
}

/// A notification thread as an event: what GitHub says is aimed at the person. Other reasons are chatter the feed
/// doesn't need.
pub fn from_notice(connection_id: &str, n: &Notice) -> Option<Event> {
    let (kind, text) = match n.reason.as_str() {
        "review_requested" => (EventKind::ReviewRequested, "Review requested"),
        "mention" | "team_mention" => (EventKind::PrMentioned, "You were mentioned"),
        "assign" => (EventKind::Assigned, "You were assigned"),
        "ci_activity" => (EventKind::CheckFailed, "CI activity"),
        _ => return None,
    };
    Some(Event {
        id: format!("notif:{}:{}", n.id, n.updated_at.timestamp()),
        connection_id: connection_id.into(),
        at: n.updated_at,
        kind,
        subject: Subject::CodeChange { repo: n.repo.clone(), number: n.number.unwrap_or_default() },
        actor: None,
        payload: json!({ "text": format!("{text}: {} ({})", n.title, n.repo), "repo": n.repo, "number": n.number, "title": n.title, "url": n.url, "mention": n.reason.contains("mention"), "source": "notification" }),
    })
}

/// Only what happened since `since` is worth telling about, so a first sync of old pull requests stays quiet in the feed.
pub fn recent(events: Vec<Event>, since: DateTime<Utc>) -> Vec<Event> {
    events.into_iter().filter(|e| e.at >= since).collect()
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::super::links::tests::pr;
    use super::*;

    fn by(login: &str, mut c: CodeChange) -> CodeChange {
        c.author = Some(person(&c, login));
        c
    }

    fn review(id: &str, who: &str, state: ReviewState) -> ReviewInfo {
        ReviewInfo { id: id.into(), reviewer: PersonRef { connection_id: "github:ann".into(), account_id: who.into() }, state, at: Some(Utc.with_ymd_and_hms(2026, 9, 29, 10, 0, 0).unwrap()) }
    }

    fn kinds(events: &[Event]) -> Vec<EventKind> {
        events.iter().map(|e| e.kind).collect()
    }

    #[test]
    fn a_new_pull_request_is_opened_and_a_new_merged_one_is_opened_and_merged() {
        let open = by("bob", pr(1, "b", "T", ""));
        assert_eq!(kinds(&derive("ann", None, &open, &[])), [EventKind::PrOpened]);
        let mut merged = open.clone();
        merged.state = CodeChangeState::Merged;
        merged.merged_at = Some(merged.updated_at);
        assert_eq!(kinds(&derive("ann", None, &merged, &[])), [EventKind::PrOpened, EventKind::PrMerged]);
        let e = &derive("ann", None, &open, &[])[0];
        assert_eq!(e.id, "pr:acme/webshop#1:opened");
        assert_eq!(e.payload["text"], "bob opened acme/webshop#1: T");
        assert_eq!(e.subject, Subject::CodeChange { repo: "acme/webshop".into(), number: 1 });
    }

    #[test]
    fn transitions_are_found_by_comparing_with_the_cached_copy() {
        let open = by("bob", pr(1, "b", "T", ""));
        let mut merged = open.clone();
        merged.state = CodeChangeState::Merged;
        assert_eq!(kinds(&derive("ann", Some(&open), &merged, &[])), [EventKind::PrMerged]);
        let mut closed = open.clone();
        closed.state = CodeChangeState::Closed;
        assert_eq!(kinds(&derive("ann", Some(&open), &closed, &[])), [EventKind::PrClosed]);
        assert!(derive("ann", Some(&merged), &merged, &[]).is_empty(), "nothing changed, nothing to say");
        let mut draft = open.clone();
        draft.state = CodeChangeState::Draft;
        assert_eq!(kinds(&derive("ann", Some(&draft), &open, &[])), [EventKind::PrReadyForReview]);
    }

    #[test]
    fn a_review_request_for_the_person_is_an_event_once_and_again_when_asked_again() {
        let before = by("bob", pr(1, "b", "T", ""));
        let mut asked = before.clone();
        asked.reviewers = vec![person(&asked, "Ann")];
        let first = derive("ann", Some(&before), &asked, &[]);
        assert_eq!(kinds(&first), [EventKind::ReviewRequested]);
        assert!(derive("ann", Some(&asked), &asked, &[]).is_empty());
        let mut again = asked.clone();
        again.updated_at += chrono::Duration::hours(1);
        let ids = |e: &[Event]| e.iter().map(|e| e.id.clone()).collect::<Vec<_>>();
        assert!(derive("ann", Some(&before), &again, &[]).iter().all(|e| !ids(&first).contains(&e.id)), "a later request is a new event");
        let mut other = before.clone();
        other.reviewers = vec![person(&other, "cy")];
        assert!(derive("ann", Some(&before), &other, &[]).is_empty(), "someone else's request is not the person's news");
        let mut merged = asked.clone();
        merged.state = CodeChangeState::Merged;
        assert!(!kinds(&derive("ann", Some(&before), &merged, &[])).contains(&EventKind::ReviewRequested));
    }

    #[test]
    fn reviews_of_the_persons_own_pull_request_are_events_by_review_id_and_their_own_reviews_are_not() {
        let mine = by("ann", pr(1, "b", "T", ""));
        let reviews = [review("r1", "bob", ReviewState::Approved), review("r2", "ann", ReviewState::Commented), review("r3", "cy", ReviewState::ChangesRequested), review("r4", "dee", ReviewState::Requested)];
        let events = derive("ann", Some(&mine), &mine, &reviews);
        assert_eq!(events.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["pr:acme/webshop#1:review:r1", "pr:acme/webshop#1:review:r3"]);
        assert_eq!(events[0].payload["text"], "bob approved acme/webshop#1: T");
        assert_eq!(events[1].payload["review"], "changesRequested");
        let theirs = by("bob", pr(2, "b", "T", ""));
        assert!(derive("ann", Some(&theirs), &theirs, &reviews).is_empty(), "reviews of other people's pull requests aren't news");
    }

    #[test]
    fn failing_checks_on_the_persons_pull_request_are_reported_once_per_commit() {
        let mut passing = by("ann", pr(1, "b", "T", ""));
        passing.checks = CheckState::Passing;
        let mut failing = passing.clone();
        failing.checks = CheckState::Failing;
        let events = derive("ann", Some(&passing), &failing, &[]);
        assert_eq!(kinds(&events), [EventKind::CheckFailed]);
        assert_eq!(events[0].id, "pr:acme/webshop#1:checks-failed:abc1234def");
        assert!(derive("ann", Some(&failing), &failing, &[]).is_empty());
        let mut pushed = failing.clone();
        pushed.sha = Some("fff".into());
        assert_eq!(derive("ann", Some(&failing), &pushed, &[])[0].id, "pr:acme/webshop#1:checks-failed:fff");
        let mut theirs = failing.clone();
        theirs.author = Some(person(&theirs, "bob"));
        assert!(derive("ann", Some(&passing), &theirs, &[]).is_empty());
        let mut merged = failing.clone();
        merged.state = CodeChangeState::Merged;
        assert!(!kinds(&derive("ann", Some(&passing), &merged, &[])).contains(&EventKind::CheckFailed));
    }

    #[test]
    fn notifications_aimed_at_the_person_become_events_and_chatter_does_not() {
        let notice = |reason: &str| Notice {
            id: "t1".into(),
            reason: reason.into(),
            repo: "acme/webshop".into(),
            title: "Fix it".into(),
            subject: "PullRequest".into(),
            number: Some(7),
            url: "u".into(),
            updated_at: Utc.with_ymd_and_hms(2026, 9, 29, 10, 0, 0).unwrap(),
            unread: true,
        };
        let kind = |r: &str| from_notice("github:ann", &notice(r)).map(|e| e.kind);
        assert_eq!(kind("review_requested"), Some(EventKind::ReviewRequested));
        assert_eq!(kind("mention"), Some(EventKind::PrMentioned));
        assert_eq!(kind("team_mention"), Some(EventKind::PrMentioned));
        assert_eq!(kind("assign"), Some(EventKind::Assigned));
        assert_eq!(kind("ci_activity"), Some(EventKind::CheckFailed));
        assert_eq!(kind("subscribed"), None);
        assert_eq!(kind("comment"), None);
        let e = from_notice("github:ann", &notice("mention")).unwrap();
        assert_eq!((e.id.as_str(), e.payload["mention"].as_bool()), ("notif:t1:1790676000", Some(true)));
        assert_eq!(e.subject, Subject::CodeChange { repo: "acme/webshop".into(), number: 7 });
    }

    #[test]
    fn a_first_sync_keeps_only_what_is_recent() {
        let open = by("bob", pr(1, "b", "T", ""));
        let events = derive("ann", None, &open, &[]);
        let cutoff = Utc.with_ymd_and_hms(2026, 9, 26, 0, 0, 0).unwrap();
        assert!(recent(events.clone(), cutoff).is_empty(), "opened on the 25th");
        assert_eq!(recent(events, Utc.with_ymd_and_hms(2026, 9, 1, 0, 0, 0).unwrap()).len(), 1);
    }
}
