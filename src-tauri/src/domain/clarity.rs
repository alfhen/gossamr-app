//! A free, deterministic check of a ticket's description for what a plan needs: what done looks like, what is in and out
//! of scope, and who is waiting on it. It reads words, never judges, and runs no agent: it only makes Pip and the page
//! speak up early about a ticket that looks thin. The Triage's verdict (`Ready to plan:`) stays the authority.
//! Mirrored by src/lib/ticketClarity.ts; both run `ticketClarity.fixtures.json`.

use serde::{Deserialize, Serialize};

/// A description shorter than this (trimmed, in characters) is very short.
pub const SHORT_LIMIT: usize = 80;

/// Words that say what done looks like.
const DONE_WORDS: &[&str] = &["acceptance", "criteria", "done when", "definition of done", "should", "must", "checklist"];
/// Words that say what is in or out of scope.
const SCOPE_WORDS: &[&str] = &["scope", "out of", "only", "not include", "won't", "exclude", "excluding", "non-goal"];
/// Words that say who asked for it or who is waiting on it.
const WHO_WORDS: &[&str] = &["asked", "requested", "waiting", "stakeholder", "needs it", "needed by", "team", "customer"];
/// What a checklist item looks like in plain text.
const CHECKLIST: &[&str] = &["[ ]", "[x]", "\u{2610}", "\u{2611}"];

/// One thing a ticket's description leaves out.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClarityGap {
    /// There is no description at all.
    Empty,
    /// There is one, but it is a line or so.
    Short,
    Done,
    Scope,
    Who,
}

impl ClarityGap {
    /// The gap as a phrase that follows "it": "doesn't say what done looks like".
    pub fn phrase(self) -> &'static str {
        match self {
            ClarityGap::Empty => "has no description",
            ClarityGap::Short => "has a very short description",
            ClarityGap::Done => "doesn't say what done looks like",
            ClarityGap::Scope => "doesn't say what's in or out of scope",
            ClarityGap::Who => "doesn't say who is waiting on it",
        }
    }

    /// The question that asks the reporter for what the gap leaves out.
    pub fn question(self) -> &'static str {
        match self {
            ClarityGap::Empty | ClarityGap::Short => "What is the goal?",
            ClarityGap::Done => "How will we know it is done (the acceptance criteria)?",
            ClarityGap::Scope => "What is in scope, and what is out?",
            ClarityGap::Who => "Who asked for it, and who is waiting on it?",
        }
    }
}

/// Whether `word` is in `text` (already lower case) as whole words: not inside a longer word.
fn has_word(text: &str, word: &str) -> bool {
    text.match_indices(word).any(|(at, _)| {
        let before = text[..at].chars().next_back().is_none_or(|c| !c.is_alphanumeric());
        let after = text[at + word.len()..].chars().next().is_none_or(|c| !c.is_alphanumeric());
        before && after
    })
}

fn mentions(text: &str, words: &[&str]) -> bool {
    words.iter().any(|w| has_word(text, w))
}

/// What the description `text` of a ticket leaves out, in the order the gaps are listed. An empty description is one
/// gap (it has nothing to read); anything else is read for the three signals, so a thin description lists several.
pub fn clarity_gaps(text: &str) -> Vec<ClarityGap> {
    let text = text.trim();
    if text.is_empty() {
        return vec![ClarityGap::Empty];
    }
    let lower = text.to_lowercase();
    let mut gaps = Vec::new();
    if text.chars().count() < SHORT_LIMIT {
        gaps.push(ClarityGap::Short);
    }
    if !mentions(&lower, DONE_WORDS) && !CHECKLIST.iter().any(|c| lower.contains(c)) {
        gaps.push(ClarityGap::Done);
    }
    if !mentions(&lower, SCOPE_WORDS) {
        gaps.push(ClarityGap::Scope);
    }
    if !mentions(&lower, WHO_WORDS) {
        gaps.push(ClarityGap::Who);
    }
    gaps
}

/// The gaps as one phrase after "it": `has no description`, or `doesn't say a, doesn't say b, and doesn't say c`.
pub fn gaps_phrase(gaps: &[ClarityGap]) -> String {
    let phrases: Vec<&str> = gaps.iter().map(|g| g.phrase()).collect();
    match phrases.as_slice() {
        [] => String::new(),
        [one] => (*one).to_string(),
        [a, b] => format!("{a} and {b}"),
        [init @ .., last] => format!("{}, and {last}", init.join(", ")),
    }
}

/// What "Ask the reporter now" asks: one question per gap, with none repeated. An empty description asks all four things a
/// ticket needs, as a Triage that listed no questions does.
pub fn clarity_questions(gaps: &[ClarityGap]) -> Vec<String> {
    let all = [ClarityGap::Short, ClarityGap::Done, ClarityGap::Scope, ClarityGap::Who];
    let wanted: &[ClarityGap] = if gaps.contains(&ClarityGap::Empty) { &all } else { gaps };
    let mut out: Vec<String> = Vec::new();
    for g in wanted {
        let q = g.question().to_string();
        if !out.contains(&q) {
            out.push(q);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLEAR: &str = "Retries should cap at five attempts. Only the payment webhooks are in scope, not refunds. The payments team is waiting on it.";

    #[test]
    fn an_empty_description_is_one_gap_and_a_blank_one_too() {
        assert_eq!(clarity_gaps(""), vec![ClarityGap::Empty]);
        assert_eq!(clarity_gaps("  \n\t "), vec![ClarityGap::Empty]);
    }

    #[test]
    fn a_thin_line_lists_what_it_leaves_out() {
        assert_eq!(clarity_gaps("Make the winback flow better."), vec![ClarityGap::Short, ClarityGap::Done, ClarityGap::Scope, ClarityGap::Who]);
    }

    #[test]
    fn a_description_that_says_all_three_has_no_gaps() {
        assert_eq!(clarity_gaps(CLEAR), vec![]);
    }

    #[test]
    fn each_signal_is_read_on_its_own() {
        let text = |t: &str| format!("{t} {}", "x".repeat(SHORT_LIMIT));
        assert_eq!(clarity_gaps(&text("Done when the mail goes out.")), vec![ClarityGap::Scope, ClarityGap::Who]);
        assert_eq!(clarity_gaps(&text("It must be fast. Out of scope: refunds.")), vec![ClarityGap::Who]);
        assert_eq!(clarity_gaps(&text("The shop team asked for it.")), vec![ClarityGap::Done, ClarityGap::Scope]);
        assert_eq!(clarity_gaps(&text("- [ ] the form saves")), vec![ClarityGap::Scope, ClarityGap::Who]);
    }

    #[test]
    fn words_count_whole_and_in_any_case() {
        let text = |t: &str| format!("{t} {}", "x".repeat(SHORT_LIMIT));
        // "lonely" is not "only", "shoulder" is not "should".
        assert_eq!(clarity_gaps(&text("A lonely shoulder.")), vec![ClarityGap::Done, ClarityGap::Scope, ClarityGap::Who]);
        assert_eq!(clarity_gaps(&text("ACCEPTANCE: ONLY mail. Stakeholder: ops.")), vec![]);
    }

    #[test]
    fn the_shared_cases_read_the_same_here_and_in_the_page() {
        let all: serde_json::Value = serde_json::from_str(include_str!("../../../src/lib/ticketClarity.fixtures.json")).unwrap();
        for case in all["cases"].as_array().unwrap() {
            let got = serde_json::to_value(clarity_gaps(case["text"].as_str().unwrap())).unwrap();
            assert_eq!(got, case["gaps"], "{}", case["name"]);
        }
    }

    #[test]
    fn the_gaps_read_as_one_phrase_and_ask_each_question_once() {
        assert_eq!(gaps_phrase(&[ClarityGap::Empty]), "has no description");
        assert_eq!(gaps_phrase(&[ClarityGap::Done, ClarityGap::Who]), "doesn't say what done looks like and doesn't say who is waiting on it");
        assert_eq!(
            gaps_phrase(&[ClarityGap::Short, ClarityGap::Done, ClarityGap::Scope]),
            "has a very short description, doesn't say what done looks like, and doesn't say what's in or out of scope"
        );
        assert_eq!(clarity_questions(&[ClarityGap::Short, ClarityGap::Done]), vec!["What is the goal?", "How will we know it is done (the acceptance criteria)?"]);
        assert_eq!(clarity_questions(&[ClarityGap::Empty]).len(), 4);
    }
}
