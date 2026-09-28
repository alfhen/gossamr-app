use crate::events::NewEvent;
use crate::model::EventKind;

/// More new events than this in one sync are summarised in a single notification.
const MAX_INDIVIDUAL: usize = 3;

#[derive(Debug, PartialEq)]
pub struct Notice {
    pub title: String,
    pub body: String,
}

/// Field edits (priority, labels…) stay in the inbox but don't interrupt.
fn interrupts(e: &NewEvent) -> bool {
    e.kind != EventKind::Field
}

fn first_name(name: &str) -> &str {
    name.split_whitespace().next().unwrap_or(name)
}

fn single(e: &NewEvent) -> Notice {
    let who = &e.actor.name;
    let title = match e.kind {
        EventKind::Mention => format!("{who} mentioned you · {}", e.ticket_key),
        EventKind::Assigned => format!("{who} assigned you {}", e.ticket_key),
        EventKind::Comment => format!("{who} commented on {}", e.ticket_key),
        EventKind::Status => format!("{} moved {}", first_name(who), e.ticket_key),
        EventKind::Field => format!("{} updated {}", first_name(who), e.ticket_key),
    };
    Notice { title, body: e.text.clone() }
}

/// What to show for the events a sync found, most important first.
pub fn notices(events: &[NewEvent]) -> Vec<Notice> {
    let mut picked: Vec<&NewEvent> = events.iter().filter(|e| interrupts(e)).collect();
    picked.sort_by_key(|e| match e.kind {
        EventKind::Mention => 0,
        EventKind::Assigned => 1,
        EventKind::Comment => 2,
        _ => 3,
    });
    if picked.len() <= MAX_INDIVIDUAL {
        return picked.into_iter().map(single).collect();
    }
    let mentions = picked.iter().filter(|e| e.kind == EventKind::Mention).count();
    let mut keys: Vec<&str> = Vec::new();
    for e in &picked {
        if !keys.contains(&e.ticket_key.as_str()) {
            keys.push(&e.ticket_key);
        }
    }
    let title = if mentions > 0 {
        format!("{} updates, {mentions} mentioning you", picked.len())
    } else {
        format!("{} updates on your tickets", picked.len())
    };
    let mut body = keys.iter().take(6).copied().collect::<Vec<_>>().join(", ");
    if keys.len() > 6 {
        body.push_str(&format!(" and {} more", keys.len() - 6));
    }
    vec![Notice { title, body }]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Person;

    fn ev(kind: EventKind, key: &str) -> NewEvent {
        NewEvent {
            id: format!("{key}-{kind:?}"),
            kind,
            ticket_key: key.into(),
            actor: Person { account_id: "s".into(), name: "Sam Holt".into(), avatar_url: None },
            at: "2026-09-28T10:00:00Z".into(),
            text: "text".into(),
        }
    }

    #[test]
    fn a_few_events_get_their_own_notice_mentions_first() {
        let n = notices(&[ev(EventKind::Status, "A-1"), ev(EventKind::Mention, "A-2")]);
        assert_eq!(n.len(), 2);
        assert_eq!(n[0].title, "Sam Holt mentioned you · A-2");
        assert_eq!(n[1].title, "Sam moved A-1");
    }

    #[test]
    fn a_ticket_appears_once_in_a_summary() {
        let evs = vec![
            ev(EventKind::Comment, "A-1"),
            ev(EventKind::Status, "A-2"),
            ev(EventKind::Mention, "A-1"),
            ev(EventKind::Status, "A-1"),
        ];
        assert_eq!(notices(&evs)[0].body, "A-1, A-2");
    }

    #[test]
    fn field_edits_do_not_interrupt() {
        assert!(notices(&[ev(EventKind::Field, "A-1")]).is_empty());
    }

    #[test]
    fn many_events_are_summarised() {
        let evs: Vec<_> = (1..=5).map(|i| ev(EventKind::Comment, &format!("A-{i}"))).chain([ev(EventKind::Mention, "B-1")]).collect();
        let n = notices(&evs);
        assert_eq!(n.len(), 1);
        assert_eq!(n[0].title, "6 updates, 1 mentioning you");
        assert!(n[0].body.starts_with("B-1, A-1"));
    }
}
