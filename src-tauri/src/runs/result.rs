//! Cleans agent text before it is stored or shown. Reports remain prose, never instructions or draft templates.

use super::redact::redact;
use crate::domain::{has_markers, without_markers};

const OUTPUT_MARKERS: [&str; 2] = ["<<<AGENT_OUTPUT", "AGENT_OUTPUT>>>"];
const TAGS: [&str; 22] = [
    "b", "i", "u", "em", "strong", "code", "pre", "p", "br", "div", "span", "a", "ul", "ol", "li", "details", "summary", "table", "tr", "td", "th", "script",
];
const LINE_BREAKING: [&str; 7] = ["br", "p", "div", "li", "tr", "ul", "ol"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fitted {
    pub text: String,
    /// Characters the whole text had before it was cut; `cut` says whether it was.
    pub total: usize,
    pub cut: bool,
}

/// `text` within `limit` characters. When it has to be cut, the cut falls at the end of a paragraph or sentence, and
/// `note(total)` is added after it so nobody takes the rest for missing.
pub fn fit(text: &str, limit: usize, note: impl Fn(usize) -> String) -> Fitted {
    let total = text.chars().count();
    if total <= limit {
        return Fitted { text: text.to_string(), total, cut: false };
    }
    let note = note(total);
    let room = limit.saturating_sub(note.chars().count());
    Fitted { text: format!("{}\n\n{note}", at_boundary(text, room)), total, cut: true }
}

pub fn keep_within(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

fn at_boundary(text: &str, room: usize) -> String {
    let end = text.char_indices().nth(room).map_or(text.len(), |(i, _)| i);
    let window = &text[..end];
    let floor = window.char_indices().nth(room / 2).map_or(0, |(i, _)| i);
    let paragraph = window.rfind("\n\n").filter(|&i| i >= floor);
    let sentence = || window.char_indices().filter(|&(i, c)| i >= floor && matches!(c, '.' | '!' | '?') && text[i + 1..].starts_with(char::is_whitespace)).map(|(i, _)| i + 1).next_back();
    let word = || window.rfind(char::is_whitespace).filter(|&i| i >= floor);
    let at = paragraph.or_else(sentence).or_else(word).unwrap_or(end);
    window[..at].trim_end().to_string()
}

pub(crate) fn sanitize(raw: &str) -> String {
    let mut text = strip_tags(&scrub(raw));
    // Taking a tag out can join the halves of a marker (`FIND<b>INGS>>>`); `scrub` then takes it out for good.
    if has_markers(&text) || has_output_markers(&text) {
        text = scrub(&text);
    }
    text
}

/// Whether `text` holds the markers that fence an agent's output wherever Pip reads it.
pub(crate) fn has_output_markers(text: &str) -> bool {
    OUTPUT_MARKERS.iter().any(|m| text.contains(m))
}

/// `sanitize` without the removal of HTML-like tags, for text that is going into a ticket and may legitimately name them.
pub(crate) fn scrub(raw: &str) -> String {
    let mut text = visible(&strip_ansi(&redact(raw)).replace("\r\n", "\n"));
    // Taking one kind of marker out can join the halves of the other (`FINDI<<<AGENT_OUTPUTNGS>>>`), so both are taken
    // out until neither is left. Each pass that changes anything shortens the text, so this ends.
    loop {
        let mut next = without_markers(&text);
        for marker in OUTPUT_MARKERS {
            while next.contains(marker) {
                next = next.replace(marker, "");
            }
        }
        if next == text {
            return text;
        }
        text = next;
    }
}

/// `text` without the characters that don't show: control characters other than newlines and tabs, and direction and
/// zero-width marks. A marker split by one of them reads as the marker once they are gone.
pub(crate) fn visible(text: &str) -> String {
    text.chars().filter(|c| matches!(c, '\n' | '\t') || !(c.is_control() || is_direction_mark(*c))).collect()
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

pub(crate) fn cut(text: &str, limit: usize) -> String {
    if text.chars().nth(limit).is_none() {
        return text.to_string();
    }
    let kept: String = text.chars().take(limit).collect();
    format!("{}…", kept.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_headings_are_kept_as_prose_not_interpreted() {
        let text = "# Plan\nA plan.\n\nFor Jira:\nA note.\n\nVerdict: pass";
        assert_eq!(sanitize(text), text);
        assert_eq!(keep_within(text, 12), text.chars().take(12).collect::<String>());
    }

    #[test]
    fn hostile_text_loses_secrets_markers_controls_and_terminal_escapes() {
        let text = format!("\x1b[31m<b>hello</b>\u{202e} <<<TICKET data TICKET>>> gsr_{}", "a".repeat(48));
        let cleaned = sanitize(&text);
        assert!(cleaned.contains("hello"));
        assert!(!cleaned.contains("\x1b") && !cleaned.contains("\u{202e}") && !cleaned.contains("<<<TICKET"));
        assert!(!cleaned.contains(&"a".repeat(48)));
    }

    #[test]
    fn text_fitting_keeps_unicode_boundaries_and_says_when_cut() {
        let fitted = fit(&"é".repeat(100), 30, |_| "cut".into());
        assert!(fitted.cut);
        assert_eq!(fitted.total, 100);
        assert!(fitted.text.ends_with("cut"));
    }
}
