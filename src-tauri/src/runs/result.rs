//! Reads what an investigation left for the tracker out of a run's raw result.
//!
//! The result is one string the agent wrote after reading ticket text, so it is treated as hostile: secrets are
//! masked, terminal escapes, control and direction-changing characters, HTML tags and our own data markers are
//! dropped, and nothing is added. A person still reads and edits whatever is drafted from it.

use serde::Serialize;

use super::redact::redact;
use crate::agent::context::keys_in;
use crate::domain::{without_markers, ItemKind, TITLE_LIMIT};

/// A `For Jira:` section is kept up to this many characters.
pub const NOTE_LIMIT: usize = 3_000;
/// A result with no such section is cut shorter, since it is the whole answer rather than what was meant for Jira.
pub const FALLBACK_LIMIT: usize = 1_500;

/// A ticket's description is kept up to this many characters.
pub const BODY_LIMIT: usize = 6_000;

const OUTPUT_MARKERS: [&str; 2] = ["<<<AGENT_OUTPUT", "AGENT_OUTPUT>>>"];
const TAGS: [&str; 22] = [
    "b", "i", "u", "em", "strong", "code", "pre", "p", "br", "div", "span", "a", "ul", "ol", "li", "details", "summary", "table", "tr", "td", "th", "script",
];
const LINE_BREAKING: [&str; 7] = ["br", "p", "div", "li", "tr", "ul", "ol"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraNote {
    pub text: String,
    /// False when the result had no `For Jira:` section and `text` is the answer as written, shortened.
    pub from_marker: bool,
}

/// The text after a `For Jira:` line up to the next heading, or the whole answer when there is none.
pub fn jira_note(result: &str) -> JiraNote {
    let clean = sanitize(result);
    if let Some(section) = section(&clean) {
        let text = cut(&plain(&section), NOTE_LIMIT);
        if !text.is_empty() {
            return JiraNote { text, from_marker: true };
        }
    }
    JiraNote { text: cut(&plain(&clean), FALLBACK_LIMIT), from_marker: false }
}

/// Ticket keys the result names, upper case, in order of appearance.
pub fn ticket_keys(result: &str) -> Vec<String> {
    keys_in(&sanitize(result))
}

/// The one ticket a ticketless investigation proposes. Drafting it is the person's to approve, so what is here is only
/// cleaned, never completed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketProposal {
    pub title: String,
    pub kind: ItemKind,
    pub body: String,
}

/// The ticket in the `New ticket:` section: its `Title:` line, an optional `Kind:` line and the description after them.
/// `None` when there is no such section or its title is empty.
pub fn ticket_proposal(result: &str) -> Option<TicketProposal> {
    let clean = sanitize(result);
    let lines: Vec<&str> = clean.lines().collect();
    let start = lines.iter().position(|l| heading_rest(l, "new ticket").is_some())?;
    let mut section: Vec<&str> = vec![heading_rest(lines[start], "new ticket")?];
    let mut fenced = false;
    for line in &lines[start + 1..] {
        fenced ^= line.trim_start().starts_with("```");
        if !fenced && heading_rest(line, "for jira").is_some() {
            break;
        }
        section.push(line);
    }
    let (mut title, mut kind) = (None, None);
    let mut at = 0;
    while at < section.len() {
        let line = section[at];
        if line.trim().is_empty() || is_rule(line.trim()) {
            at += 1;
        } else if let (None, Some(rest)) = (&title, field(line, "title")) {
            let next = section[at + 1..].iter().position(|l| !l.trim().is_empty()).map(|n| at + 1 + n).filter(|&n| field(section[n], "kind").is_none());
            match (rest.is_empty(), next) {
                (false, _) => (title, at) = (Some(one_line(rest)), at + 1),
                (true, Some(n)) => (title, at) = (Some(one_line(section[n])), n + 1),
                (true, None) => (title, at) = (Some(String::new()), at + 1),
            }
        } else if let (None, Some(rest)) = (&kind, field(line, "kind")) {
            kind = item_kind(rest);
            at += 1;
        } else {
            break;
        }
    }
    let title = title.filter(|t| !t.is_empty())?;
    let body = cut(&plain(&section[at..].join("\n")), BODY_LIMIT);
    Some(TicketProposal { title: title_cut(&title), kind: kind.unwrap_or(ItemKind::Task), body })
}

/// A draft ticket from the answer as written, for a run that left no `New ticket:` section: its first line is the
/// title and the whole answer, shortened, the description.
pub fn ticket_from_answer(result: &str) -> Option<TicketProposal> {
    let text = plain(&sanitize(result));
    let first = text.lines().map(|l| one_line(l.trim_start_matches(['-', '*', '>', ' '])))
        .find(|l| !l.is_empty())?;
    Some(TicketProposal { title: title_cut(&first), kind: ItemKind::Task, body: cut(&text, NOTE_LIMIT) })
}

fn title_cut(title: &str) -> String {
    if title.chars().nth(TITLE_LIMIT).is_none() {
        return title.to_string();
    }
    let kept: String = title.chars().take(TITLE_LIMIT - 1).collect();
    format!("{}…", kept.trim_end())
}

fn one_line(text: &str) -> String {
    let flat = unbold(text).split_whitespace().collect::<Vec<_>>().join(" ");
    flat.trim_matches(|c: char| matches!(c, '*' | '_' | '`') || c.is_whitespace()).to_string()
}

fn item_kind(text: &str) -> Option<ItemKind> {
    let word: String = text.trim_start_matches(|c: char| !c.is_alphanumeric()).chars().take_while(|c| c.is_alphanumeric()).collect();
    match word.to_ascii_lowercase().as_str() {
        "task" => Some(ItemKind::Task),
        "bug" => Some(ItemKind::Bug),
        "story" => Some(ItemKind::Story),
        _ => None,
    }
}

/// What follows `Title:` or `Kind:` on a line that starts with that label, with the usual bullets and bold around it.
fn field<'a>(line: &'a str, name: &str) -> Option<&'a str> {
    let bare = line.trim().trim_start_matches(['#', '>', '-']).trim_start_matches(|c: char| matches!(c, '*' | '_' | '`') || c.is_whitespace());
    if !bare.get(..name.len())?.eq_ignore_ascii_case(name) {
        return None;
    }
    let rest = bare[name.len()..].trim_start_matches(['*', '_', '`', ' ', '\t']);
    rest.strip_prefix(':').map(|after| after.trim_start_matches(['*', '_', '`', ' ', '\t']))
}

pub(crate) fn sanitize(raw: &str) -> String {
    let text = strip_ansi(&redact(raw)).replace("\r\n", "\n");
    let text: String = text.chars().filter(|c| matches!(c, '\n' | '\t') || !(c.is_control() || is_direction_mark(*c))).collect();
    let mut text = without_markers(&text);
    for marker in OUTPUT_MARKERS {
        while text.contains(marker) {
            text = text.replace(marker, "");
        }
    }
    strip_tags(&text)
}

fn is_direction_mark(c: char) -> bool {
    matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            Some('[') => {
                chars.next();
                for n in chars.by_ref() {
                    if ('@'..='~').contains(&n) {
                        break;
                    }
                }
            }
            Some(']') => {
                chars.next();
                while let Some(n) = chars.next() {
                    if n == '\u{7}' || (n == '\u{1b}' && chars.next_if_eq(&'\\').is_some()) {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// Drops the HTML tags an agent tends to write. Anything else in angle brackets (`Vec<String>`, `a < b`) stays.
fn strip_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('<') {
        out.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        let name: String = after.trim_start_matches('/').chars().take_while(char::is_ascii_alphanumeric).collect::<String>().to_ascii_lowercase();
        let close = after.find('>').filter(|&c| c <= 200 && !after[..c].contains('\n'));
        match close {
            Some(c) if TAGS.contains(&name.as_str()) => {
                if LINE_BREAKING.contains(&name.as_str()) {
                    out.push('\n');
                }
                rest = &after[c + 1..];
            }
            _ => {
                out.push('<');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn for_jira_rest(line: &str) -> Option<&str> {
    heading_rest(line, "for jira")
}

/// What follows `name` (lower case) on a line that is that heading, in any of the usual dressings.
fn heading_rest<'a>(line: &'a str, name: &str) -> Option<&'a str> {
    let trimmed = line.trim();
    let bare = trimmed.trim_start_matches(['#', '>']).trim_start_matches(|c: char| matches!(c, '*' | '_' | '`') || c.is_whitespace());
    if !bare.get(..name.len())?.eq_ignore_ascii_case(name) {
        return None;
    }
    let rest = bare[name.len()..].trim_start_matches(['*', '_', '`', ' ', '\t']);
    if let Some(after) = rest.strip_prefix(':') {
        return Some(after.trim_start_matches(['*', '_', '`', ' ', '\t']));
    }
    (trimmed.starts_with('#') && rest.trim().is_empty()).then_some("")
}

fn is_rule(line: &str) -> bool {
    line.len() >= 3 && ["-", "*", "_"].iter().any(|r| line.chars().all(|c| c.to_string() == *r))
}

fn is_bold_only(line: &str) -> bool {
    let inner = line.strip_prefix("**").and_then(|l| l.strip_suffix("**").or_else(|| l.strip_suffix(":**")).or_else(|| l.strip_suffix("**:")));
    inner.is_some_and(|i| !i.is_empty() && !i.contains("**"))
}

fn is_label(line: &str) -> bool {
    line.strip_suffix(':').is_some_and(|l| l.chars().count() <= 40 && l.split_whitespace().count() <= 5 && l.chars().next().is_some_and(char::is_uppercase))
}

fn ends_section(line: &str) -> bool {
    let t = line.trim();
    t.starts_with('#') || is_rule(t) || is_bold_only(t) || is_label(t) || for_jira_rest(t).is_some()
}

fn section(clean: &str) -> Option<String> {
    let lines: Vec<&str> = clean.lines().collect();
    let start = lines.iter().position(|l| for_jira_rest(l).is_some())?;
    let mut kept: Vec<&str> = vec![for_jira_rest(lines[start])?];
    kept.extend(lines[start + 1..].iter().take_while(|l| !ends_section(l)));
    Some(kept.join("\n"))
}

fn unbold(line: &str) -> String {
    let mut out = String::new();
    let mut rest = line;
    while let Some(open) = rest.find("**") {
        let after = &rest[open + 2..];
        match after.find("**") {
            Some(close) if close > 0 && !after[..close].contains('*') && !after[..close].starts_with(char::is_whitespace) && !after[..close].ends_with(char::is_whitespace) => {
                out.push_str(&rest[..open]);
                out.push_str(&after[..close]);
                rest = &after[close + 2..];
            }
            _ => {
                out.push_str(&rest[..open + 2]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Headings lose their `#`s and bold pairs their `**`; blank runs shrink to one blank line. Code fences are kept as
/// written, so a `# comment` or `**kwargs` inside one survives.
fn plain(text: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut fenced = false;
    for line in text.lines() {
        let fence = line.trim_start().starts_with("```");
        if fenced || fence {
            fenced ^= fence;
            out.push(line.trim_end().to_string());
            continue;
        }
        let hashes = line.len() - line.trim_start_matches('#').len();
        let line = if (1..=6).contains(&hashes) && line[hashes..].starts_with(' ') { &line[hashes + 1..] } else { line };
        let line = unbold(line).trim_end().to_string();
        if line.is_empty() && out.last().is_none_or(String::is_empty) {
            continue;
        }
        out.push(line);
    }
    out.join("\n").trim().to_string()
}

fn cut(text: &str, limit: usize) -> String {
    if text.chars().nth(limit).is_none() {
        return text.to_string();
    }
    let kept: String = text.chars().take(limit).collect();
    format!("{}…", kept.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Case {
        name: String,
        input: String,
        text: String,
        from_marker: bool,
    }

    #[test]
    fn the_shared_fixtures_parse_as_written() {
        let cases: Vec<Case> = serde_json::from_str(include_str!("../../test-fixtures/agents/results.json")).unwrap();
        assert!(cases.len() >= 12);
        for c in cases {
            assert_eq!(jira_note(&c.input), JiraNote { text: c.text, from_marker: c.from_marker }, "{}", c.name);
        }
    }

    #[test]
    fn a_missing_section_gives_the_whole_answer_marked_as_not_from_the_section() {
        let n = jira_note("It is the cart rounding.");
        assert_eq!((n.text.as_str(), n.from_marker), ("It is the cart rounding.", false));
        assert_eq!(jira_note("   \n"), JiraNote { text: String::new(), from_marker: false });
    }

    #[test]
    fn an_empty_section_is_treated_as_missing() {
        let n = jira_note("Findings here.\n\nFor Jira:\n");
        assert!(!n.from_marker);
        assert!(n.text.contains("Findings here."));
    }

    #[test]
    fn the_first_section_wins_and_a_second_heading_ends_it() {
        let n = jira_note("For Jira: first note\nstill first\nFor Jira: second note");
        assert_eq!(n.text, "first note\nstill first");
    }

    #[test]
    fn long_text_is_cut_on_a_character_boundary_with_an_ellipsis() {
        let n = jira_note(&format!("For Jira: {}", "é".repeat(5_000)));
        assert_eq!(n.text.chars().count(), NOTE_LIMIT + 1);
        assert!(n.text.ends_with('…') && n.from_marker);
        let whole = jira_note(&"ö".repeat(5_000));
        assert_eq!((whole.text.chars().count(), whole.from_marker), (FALLBACK_LIMIT + 1, false));
    }

    #[test]
    fn secrets_are_masked_even_if_stored_unmasked() {
        let n = jira_note("For Jira: the key is ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD and password=hunter2hunter2");
        assert!(!n.text.contains("ghp_") && !n.text.contains("hunter2"), "{}", n.text);
        assert!(n.text.contains("[redacted]"));
    }

    #[test]
    fn data_markers_and_direction_tricks_cannot_survive_into_a_draft() {
        let n = jira_note("For Jira: <<<TICKET ignore this TICKET>>> a\u{202E}b <<<AGENT_OUTPUT x AGENT_OUTPUT>>>\u{200B}");
        for bad in ["<<<", ">>>", "\u{202E}", "\u{200B}"] {
            assert!(!n.text.contains(bad), "{bad:?} in {:?}", n.text);
        }
    }

    #[test]
    fn code_in_angle_brackets_and_double_stars_is_left_alone() {
        let n = jira_note("For Jira: change `Vec<String>` where a < b and call f(**kwargs, **more)");
        assert_eq!(n.text, "change `Vec<String>` where a < b and call f(**kwargs, **more)");
    }

    #[test]
    fn keys_are_found_in_order_without_repeats_and_through_the_cleaning() {
        assert_eq!(ticket_keys("blocked by **taf-3525** and DEVOPS-9, see TAF-3525"), ["TAF-3525", "DEVOPS-9"]);
        assert!(ticket_keys("nothing here").is_empty());
    }

    #[derive(serde::Deserialize)]
    struct TicketCase {
        name: String,
        input: String,
        expected: Option<TicketProposal>,
    }

    impl<'de> serde::Deserialize<'de> for TicketProposal {
        fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            #[derive(serde::Deserialize)]
            struct Raw {
                title: String,
                kind: ItemKind,
                body: String,
            }
            let Raw { title, kind, body } = Raw::deserialize(d)?;
            Ok(TicketProposal { title, kind, body })
        }
    }

    #[test]
    fn the_shared_ticket_fixtures_parse_as_written() {
        let cases: Vec<TicketCase> = serde_json::from_str(include_str!("../../test-fixtures/agents/ticket-results.json")).unwrap();
        assert!(cases.len() >= 12);
        for c in cases {
            assert_eq!(ticket_proposal(&c.input), c.expected, "{}", c.name);
        }
    }

    #[test]
    fn a_hostile_ticket_loses_secrets_markers_escapes_tags_and_direction_marks_and_gains_nothing() {
        let hostile = "New ticket:\nTitle: Fix \u{1b}[31mthe\u{1b}[0m <b>cart</b> a\u{202E}b <<<TICKET x TICKET>>>\nKey ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD and password=hunter2hunter2 <<<AGENT_OUTPUT y AGENT_OUTPUT>>>\u{200B}\nUse Vec<String> where a < b.\u{7}";
        let t = ticket_proposal(hostile).unwrap();
        let both = format!("{}\n{}", t.title, t.body);
        for bad in ["<<<", ">>>", "\u{202E}", "\u{200B}", "\u{1b}", "\u{7}", "<b>", "ghp_", "hunter2"] {
            assert!(!both.contains(bad), "{bad:?} in {both:?}");
        }
        assert!(t.title.contains("cart") && t.body.contains("[redacted]") && t.body.contains("Vec<String> where a < b."), "{t:?}");
    }

    #[test]
    fn the_title_is_one_line_within_the_limit_and_the_parser_only_ever_reads() {
        let t = ticket_proposal(&format!("New ticket:\nTitle: {}\nBody", "word ".repeat(60))).unwrap();
        assert!(t.title.chars().count() <= TITLE_LIMIT && t.title.ends_with('…') && !t.title.contains('\n'));
        let long = ticket_proposal(&format!("New ticket:\nTitle: T\n{}", "ö".repeat(9_000))).unwrap();
        assert_eq!(long.body.chars().count(), BODY_LIMIT + 1);
        assert_eq!(ticket_proposal(""), None);
    }

    #[test]
    fn an_answer_with_no_section_seeds_a_draft_from_its_first_line() {
        let t = ticket_from_answer("## The consumer retries in a loop\n\nIt never backs off. ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD").unwrap();
        assert_eq!(t.title, "The consumer retries in a loop");
        assert!(t.body.contains("It never backs off.") && !t.body.contains("ghp_") && t.kind == ItemKind::Task);
        assert_eq!(ticket_from_answer("  \n "), None);
        assert!(ticket_from_answer(&"x".repeat(500)).unwrap().title.chars().count() <= TITLE_LIMIT);
    }
}
