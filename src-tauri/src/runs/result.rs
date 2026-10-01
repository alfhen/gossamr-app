//! Reads what an investigation left for the tracker out of a run's raw result.
//!
//! The result is one string the agent wrote after reading ticket text, so it is treated as hostile: secrets are
//! masked, terminal escapes, control and direction-changing characters, HTML tags and our own data markers are
//! dropped, and nothing is added. A person still reads and edits whatever is drafted from it.

use serde::Serialize;

use super::redact::redact;
use crate::agent::context::keys_in;
use crate::domain::without_markers;

/// A `For Jira:` section is kept up to this many characters.
pub const NOTE_LIMIT: usize = 3_000;
/// A result with no such section is cut shorter, since it is the whole answer rather than what was meant for Jira.
pub const FALLBACK_LIMIT: usize = 1_500;

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

fn sanitize(raw: &str) -> String {
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

/// What follows `For Jira` on a line that is that heading, in any of the usual dressings.
fn for_jira_rest(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    let bare = trimmed.trim_start_matches(['#', '>']).trim_start_matches(|c: char| matches!(c, '*' | '_' | '`') || c.is_whitespace());
    if !bare.get(..8)?.eq_ignore_ascii_case("for jira") {
        return None;
    }
    let rest = bare[8..].trim_start_matches(['*', '_', '`', ' ', '\t']);
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

/// Headings lose their `#`s and bold pairs their `**`; blank runs shrink to one blank line.
fn plain(text: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
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
}
