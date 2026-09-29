use std::collections::{HashSet, VecDeque};

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    Todo,
    Active,
    Done,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusDef {
    pub id: String,
    pub name: String,
    pub category: Category,
}

/// A status as carried on an item.
pub type StatusRef = StatusDef;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Transition {
    pub from: String,
    pub to: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "moves", rename_all = "camelCase")]
pub enum Transitions {
    Any,
    Graph(Vec<Transition>),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub statuses: Vec<StatusDef>,
    pub transitions: Transitions,
}

impl Workflow {
    pub fn status(&self, id: &str) -> Option<&StatusDef> {
        self.statuses.iter().find(|s| s.id == id)
    }

    /// Whether a single move is allowed. Staying put is never a move.
    pub fn can_move(&self, from: &str, to: &str) -> bool {
        if from == to || self.status(from).is_none() || self.status(to).is_none() {
            return false;
        }
        match &self.transitions {
            Transitions::Any => true,
            Transitions::Graph(moves) => moves.iter().any(|m| m.from == from && m.to == to),
        }
    }

    pub fn next_statuses(&self, from: &str) -> Vec<&StatusDef> {
        self.statuses.iter().filter(|s| self.can_move(from, &s.id)).collect()
    }

    /// The shortest chain of statuses to pass through, excluding `from` and ending at `to`.
    /// `None` when unreachable. Empty when already there.
    pub fn path(&self, from: &str, to: &str) -> Option<Vec<String>> {
        if from == to {
            return self.status(to).map(|_| vec![]);
        }
        let mut seen: HashSet<&str> = HashSet::from([from]);
        let mut queue: VecDeque<(&str, Vec<&str>)> = VecDeque::from([(from, vec![])]);
        while let Some((at, trail)) = queue.pop_front() {
            for next in self.next_statuses(at) {
                if !seen.insert(&next.id) {
                    continue;
                }
                let mut trail = trail.clone();
                trail.push(&next.id);
                if next.id == to {
                    return Some(trail.into_iter().map(String::from).collect());
                }
                queue.push_back((&next.id, trail));
            }
        }
        None
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn linear() -> Workflow {
        let s = |id: &str, category| StatusDef { id: id.into(), name: id.to_uppercase(), category };
        let m = |from: &str, to: &str| Transition { from: from.into(), to: to.into() };
        Workflow {
            statuses: vec![
                s("todo", Category::Todo),
                s("doing", Category::Active),
                s("review", Category::Active),
                s("done", Category::Done),
            ],
            transitions: Transitions::Graph(vec![
                m("todo", "doing"),
                m("doing", "review"),
                m("review", "done"),
                m("review", "doing"),
            ]),
        }
    }

    #[test]
    fn graph_only_allows_listed_moves() {
        let w = linear();
        assert!(w.can_move("todo", "doing"));
        assert!(!w.can_move("todo", "done"));
        assert!(!w.can_move("done", "todo"));
        assert!(!w.can_move("doing", "doing"));
        assert!(!w.can_move("doing", "nope"));
    }

    #[test]
    fn any_allows_every_known_status_but_not_itself() {
        let w = Workflow { transitions: Transitions::Any, ..linear() };
        assert!(w.can_move("done", "todo"));
        assert!(!w.can_move("done", "done"));
        assert!(!w.can_move("done", "ghost"));
        assert_eq!(w.next_statuses("done").len(), 3);
    }

    #[test]
    fn path_is_shortest_and_none_when_unreachable() {
        let w = linear();
        assert_eq!(w.path("todo", "done"), Some(vec!["doing".into(), "review".into(), "done".into()]));
        assert_eq!(w.path("review", "review"), Some(vec![]));
        assert_eq!(w.path("done", "todo"), None);
        assert_eq!(w.path("todo", "ghost"), None);
    }

    #[test]
    fn serialises_with_a_kind_tag() {
        let json = serde_json::to_value(Workflow { transitions: Transitions::Any, ..linear() }).unwrap();
        assert_eq!(json["transitions"]["kind"], "any");
    }
}
