//! Best-effort removal of secrets from text an agent produced, before it is stored or shown.
//!
//! It catches the usual token shapes and `NAME=value` pairs with a secret-looking name. It cannot know a secret that
//! looks like ordinary text, so it limits damage rather than guaranteeing anything.

use std::ops::Range;

const MASK: &str = "[redacted]";
const SECRET_NAMES: [&str; 8] = ["secret", "token", "password", "passwd", "api_key", "api-key", "apikey", "private"];
const HEADERS: [&str; 2] = ["authorization:", "cookie:"];

pub fn redact(text: &str) -> String {
    text.split_inclusive('\n').map(redact_line).collect()
}

fn redact_line(line: &str) -> String {
    let body = line.trim_end_matches(['\n', '\r']);
    let mut spans = Vec::new();
    header_spans(body, &mut spans);
    word_spans(body, &mut spans);
    let mut out = apply(body, spans);
    out.push_str(&line[body.len()..]);
    out
}

fn header_spans(body: &str, spans: &mut Vec<Range<usize>>) {
    let lower = body.to_ascii_lowercase();
    for header in HEADERS {
        if let Some(at) = lower.find(header) {
            let after = at + header.len();
            let start = after + (body[after..].len() - body[after..].trim_start().len());
            if start < body.len() {
                spans.push(start..body.len());
            }
        }
    }
}

fn is_delimiter(c: char) -> bool {
    c.is_whitespace() || matches!(c, '"' | '\'' | '`' | ',' | ';' | '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>' | '&' | '|')
}

fn words(s: &str) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut start = None;
    for (i, c) in s.char_indices() {
        match (is_delimiter(c), start) {
            (true, Some(st)) => {
                out.push(st..i);
                start = None;
            }
            (false, None) => start = Some(i),
            _ => {}
        }
    }
    if let Some(st) = start {
        out.push(st..s.len());
    }
    out
}

fn is_secret_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    SECRET_NAMES.iter().any(|n| lower.contains(n))
}

fn word_spans(body: &str, spans: &mut Vec<Range<usize>>) {
    let words = words(body);
    for (i, word) in words.iter().enumerate() {
        let text = &body[word.clone()];
        if text.eq_ignore_ascii_case("bearer") {
            spans.extend(words.get(i + 1).cloned());
            continue;
        }
        match text.split_once('=') {
            Some((name, value)) if is_secret_name(name) => {
                if value.is_empty() {
                    quoted_value(body, word.end, spans);
                } else {
                    spans.push(word.start + name.len() + 1..word.end);
                }
            }
            Some((name, value)) => known_shapes(value, word.start + name.len() + 1, spans),
            None => {
                known_shapes(text, word.start, spans);
                if is_jwt(text) {
                    spans.push(word.clone());
                }
            }
        }
    }
}

/// `NAME="two words"`: the quote is a delimiter, so the value is found here, up to the closing quote.
fn quoted_value(body: &str, after_equals: usize, spans: &mut Vec<Range<usize>>) {
    let Some(quote) = body[after_equals..].chars().next().filter(|c| matches!(c, '"' | '\'')) else { return };
    let from = after_equals + 1;
    let to = body[from..].find(quote).map_or(body.len(), |n| from + n);
    if to > from {
        spans.push(from..to);
    }
}

fn is_jwt(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    s.len() >= 20
        && parts.len() == 3
        && parts[0].starts_with("eyJ")
        && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'=')))
}

/// A prefix, then at least `min` characters from the allowed set, anywhere in the word (so `https://ghp_…@host` counts).
fn prefixed(word: &str, base: usize, prefix: &str, min: usize, allowed: fn(u8) -> bool, spans: &mut Vec<Range<usize>>) {
    let mut from = 0;
    while let Some(at) = word[from..].find(prefix) {
        let start = from + at;
        let run = word.as_bytes()[start + prefix.len()..].iter().take_while(|b| allowed(**b)).count();
        let end = start + prefix.len() + run;
        if run >= min {
            spans.push(base + start..base + end);
        }
        from = end.max(start + prefix.len());
    }
}

fn known_shapes(word: &str, base: usize, spans: &mut Vec<Range<usize>>) {
    let alnum = |b: u8| b.is_ascii_alphanumeric();
    for prefix in ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"] {
        prefixed(word, base, prefix, 20, alnum, spans);
    }
    prefixed(word, base, "github_pat_", 20, |b| b.is_ascii_alphanumeric() || b == b'_', spans);
    for prefix in ["AKIA", "ASIA"] {
        prefixed(word, base, prefix, 16, |b| b.is_ascii_uppercase() || b.is_ascii_digit(), spans);
    }
    for kind in ["xoxb-", "xoxa-", "xoxp-", "xoxr-", "xoxs-"] {
        prefixed(word, base, kind, 10, |b| b.is_ascii_alphanumeric() || b == b'-', spans);
    }
}

fn apply(body: &str, mut spans: Vec<Range<usize>>) -> String {
    spans.sort_by_key(|s| s.start);
    let mut out = String::with_capacity(body.len());
    let mut at = 0;
    for span in spans {
        if span.end <= at {
            continue;
        }
        out.push_str(&body[at..span.start.max(at)]);
        out.push_str(MASK);
        at = span.end;
    }
    out.push_str(&body[at..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gone(input: &str, secret: &str) {
        let out = redact(input);
        assert!(!out.contains(secret), "{input:?} left {out:?}");
        assert!(out.contains(MASK), "{input:?} gave {out:?}");
    }

    #[test]
    fn github_tokens() {
        gone("pushed with ghp_abcdefghijklmnopqrstuvwxyz0123456789 today", "ghp_abcdefghijklmnopqrstuvwxyz0123456789");
        for prefix in ["gho_", "ghu_", "ghs_", "ghr_"] {
            gone(&format!("{prefix}ABCDEFGHIJKLMNOPQRSTUVWXYZ"), "ABCDEFGHIJ");
        }
        gone("github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "11ABCDEFG");
        gone("git clone https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/a/b", "abcdefghijklmnopqrstuvwxyz");
    }

    #[test]
    fn cloud_and_chat_tokens() {
        gone("key AKIAIOSFODNN7EXAMPLE found", "AKIAIOSFODNN7EXAMPLE");
        gone("ASIAIOSFODNN7EXAMPLE", "ASIAIOSFODNN7EXAMPLE");
        gone("slack xoxb-123456789012-abcdefghijkl", "123456789012");
        gone("xoxp-1234567890-abcdefghij", "1234567890");
    }

    #[test]
    fn bearer_values_and_jwt_shapes() {
        gone("curl -H 'Bearer abc123def456' x", "abc123def456");
        gone("bearer sk-live-9999", "sk-live-9999");
        gone("saw eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl in the log", "eyJhbGciOiJIUzI1NiJ9");
    }

    #[test]
    fn header_values_are_removed_to_the_end_of_the_line() {
        let out = redact("Authorization: Basic dXNlcjpwYXNz\nCookie: a=1; session=abc\nset-cookie: id=7\nHost: example.com\n");
        assert_eq!(out, "Authorization: [redacted]\nCookie: [redacted]\nset-cookie: [redacted]\nHost: example.com\n");
    }

    #[test]
    fn names_that_look_secret_lose_their_values() {
        assert_eq!(redact("export API_KEY=abc123"), "export API_KEY=[redacted]");
        assert_eq!(redact("DB_PASSWORD=hunter2 npm test"), "DB_PASSWORD=[redacted] npm test");
        assert_eq!(redact("--token=zzz9 run"), "--token=[redacted] run");
        assert_eq!(redact("GITHUB_TOKEN=\"two words\" next"), "GITHUB_TOKEN=\"[redacted]\" next");
        assert_eq!(redact("PRIVATE_KEY='k1' x"), "PRIVATE_KEY='[redacted]' x");
        assert_eq!(redact("curl 'https://x.test/a?id=1&access_token=s3cr3t&b=2'"), "curl 'https://x.test/a?id=1&access_token=[redacted]&b=2'");
        assert_eq!(redact("MY-API-KEY=k MYAPIKEY=k"), "MY-API-KEY=[redacted] MYAPIKEY=[redacted]");
        assert_eq!(redact("SECRET_SAUCE=ketchup"), "SECRET_SAUCE=[redacted]");
    }

    #[test]
    fn a_known_shape_after_an_innocent_name_is_still_caught() {
        assert_eq!(redact("REMOTE=ghp_abcdefghijklmnopqrstuvwxyz0123"), "REMOTE=[redacted]");
    }

    #[test]
    fn ordinary_text_is_left_alone() {
        for text in [
            "Reading src/main.rs and running cargo test",
            "The token expired after 578k tokens; passwords are hashed.",
            "ghp_short and AKIAshort and xoxb-1 and eyJ.a.b",
            "FOO=bar BAZ=1 PATH=/usr/bin",
            "approve Bash: touch /work/example/scratch.txt",
            "a=b=c",
            "",
            "line one\nline two\r\nlast",
        ] {
            assert_eq!(redact(text), text);
        }
    }

    #[test]
    fn line_endings_and_other_lines_survive() {
        assert_eq!(redact("a\r\nTOKEN=x\r\nb\n"), "a\r\nTOKEN=[redacted]\r\nb\n");
    }

    #[test]
    fn non_ascii_text_does_not_panic_or_shift_spans() {
        assert_eq!(redact("h\u{e5}rd \u{1f512} TOKEN=ab\u{e9}c ok"), "h\u{e5}rd \u{1f512} TOKEN=[redacted] ok");
        assert_eq!(redact("\u{e6}\u{f8}\u{e5} Authorization: Bearer x\u{e9}"), "\u{e6}\u{f8}\u{e5} Authorization: [redacted]");
    }
}
