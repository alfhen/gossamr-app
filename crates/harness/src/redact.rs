//! Masks secrets in an event before it is stored or sent: the session's own secrets, and token shapes. It masks
//! shapes, not private text, which is why a locked session stores no payload at all.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::event::Body;

pub const MASK: &str = "<redacted>";

/// The characters a token is made of. After a match, the rest of the run they form is masked with it, so two secrets
/// written with nothing between them are masked whole.
fn in_run(c: char) -> bool {
    c.is_ascii_alphanumeric() || "._~+/=-".contains(c)
}

/// One kind of secret.
pub struct Shape {
    pub name: &'static str,
    /// What the secret starts with. A shape is only looked for from one of these, where no letter or digit comes right
    /// before it: a real key starts at a boundary, and a word such as `task-list` is no key.
    pub markers: &'static [&'static str],
    /// The markers match in any case.
    pub any_case: bool,
    /// The whole secret, from its marker.
    pub pattern: &'static str,
    /// A realistic secret of this shape, for tests. Built, not written out, so no scanner mistakes it for a real one.
    pub example: fn() -> String,
}

/// A deterministic string of `len` characters from `alphabet`, for examples.
fn noise(seed: u64, len: usize, alphabet: &str) -> String {
    let chars: Vec<char> = alphabet.chars().collect();
    let mut state = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    (0..len)
        .map(|_| {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            chars[(state >> 33) as usize % chars.len()]
        })
        .collect()
}

const B64URL: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const ALNUM: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

pub static SHAPES: &[Shape] = &[
    Shape {
        name: "Anthropic key",
        markers: &["sk-ant-"],
        any_case: false,
        pattern: r"sk-ant-[A-Za-z0-9_-]{16,}",
        example: || format!("sk-ant-api03-{}AA", noise(1, 93, B64URL)),
    },
    Shape {
        name: "OpenAI key",
        markers: &["sk-"],
        any_case: false,
        pattern: r"sk-(?:proj-)?[A-Za-z0-9_-]{32,}",
        example: || format!("sk-proj-{}", noise(2, 156, B64URL)),
    },
    Shape {
        name: "GitHub token",
        markers: &["ghp_", "gho_", "ghu_", "ghs_", "ghr_"],
        any_case: false,
        pattern: r"gh[pousr]_[A-Za-z0-9]{30,}",
        example: || format!("ghs_{}", noise(3, 36, ALNUM)),
    },
    Shape {
        name: "GitHub fine-grained token",
        markers: &["github_pat_"],
        any_case: false,
        pattern: r"github_pat_[A-Za-z0-9_]{30,}",
        example: || format!("github_pat_11{}_{}", noise(4, 20, ALNUM), noise(5, 59, ALNUM)),
    },
    Shape {
        name: "Atlassian API token",
        markers: &["ATATT"],
        any_case: false,
        pattern: r"ATATT[A-Za-z0-9_=-]{20,}",
        example: || format!("ATATT3xFfGF0{}={}", noise(6, 170, B64URL), noise(7, 8, "0123456789ABCDEF")),
    },
    Shape {
        name: "GitLab token",
        markers: &["glpat-"],
        any_case: false,
        pattern: r"glpat-[A-Za-z0-9_-]{20,}",
        example: || format!("glpat-{}", noise(8, 20, B64URL)),
    },
    Shape {
        name: "npm token",
        markers: &["npm_"],
        any_case: false,
        pattern: r"npm_[A-Za-z0-9]{36}",
        example: || format!("npm_{}", noise(9, 36, ALNUM)),
    },
    Shape {
        name: "Stripe key",
        markers: &["sk_live_", "rk_live_"],
        any_case: false,
        pattern: r"[sr]k_live_[A-Za-z0-9]{20,}",
        example: || format!("sk_live_{}", noise(10, 99, ALNUM)),
    },
    Shape {
        name: "Slack token",
        markers: &["xoxa-", "xoxb-", "xoxp-", "xoxr-", "xoxs-"],
        any_case: false,
        pattern: r"xox[abprs]-[A-Za-z0-9-]{10,}",
        example: || format!("xox{}-{}-{}-{}", "b", noise(11, 12, "0123456789"), noise(12, 13, "0123456789"), noise(13, 24, ALNUM)),
    },
    Shape {
        name: "Google API key",
        markers: &["AIza"],
        any_case: false,
        pattern: r"AIza[0-9A-Za-z_-]{35}",
        example: || format!("AIza{}", noise(14, 35, B64URL)),
    },
    Shape {
        name: "Google OAuth token",
        markers: &["ya29."],
        any_case: false,
        pattern: r"ya29\.[0-9A-Za-z_-]{20,}",
        example: || format!("ya29.{}", noise(15, 150, B64URL)),
    },
    Shape {
        name: "AWS access key",
        markers: &["AKIA"],
        any_case: false,
        pattern: r"AKIA[0-9A-Z]{16}",
        example: || format!("AKIA{}", noise(16, 16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")),
    },
    Shape {
        name: "JWT",
        markers: &["eyJ"],
        any_case: false,
        pattern: r"eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}",
        example: || format!("eyJ{}.eyJ{}.{}", noise(30, 33, B64URL), noise(31, 216, B64URL), noise(32, 43, B64URL)),
    },
    Shape {
        name: "Bearer header",
        markers: &["bearer"],
        any_case: true,
        pattern: r"(?i:bearer)\s+[A-Za-z0-9._~+/=-]{20,}",
        example: || format!("Bearer {}", noise(17, 48, B64URL)),
    },
    Shape {
        name: "Private key",
        markers: &["-----BEGIN"],
        any_case: false,
        pattern: r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
        example: || {
            let base64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            let lines: Vec<String> = (0..5).map(|n| noise(18 + n, 70, base64)).collect();
            format!("-----BEGIN OPENSSH PRIVATE KEY-----\n{}\n-----END OPENSSH PRIVATE KEY-----", lines.join("\n"))
        },
    },
];

struct Compiled {
    markers: &'static [&'static str],
    any_case: bool,
    pattern: Regex,
}

static COMPILED: LazyLock<Vec<Compiled>> = LazyLock::new(|| {
    SHAPES
        .iter()
        .map(|shape| Compiled {
            markers: shape.markers,
            any_case: shape.any_case,
            pattern: Regex::new(&format!("^(?:{})", shape.pattern)).expect("the shape compiles"),
        })
        .collect()
});

static MARKERS: LazyLock<Regex> = LazyLock::new(|| {
    let markers: Vec<String> = SHAPES
        .iter()
        .flat_map(|shape| shape.markers.iter().map(move |marker| if shape.any_case { format!("(?i:{})", regex::escape(marker)) } else { regex::escape(marker) }))
        .collect();
    Regex::new(&markers.join("|")).expect("the markers compile")
});

/// How many characters of the session's own token, in a row, count as a copy of it.
const PARTIAL: usize = 16;

pub fn text(s: &str, secrets: &[String]) -> String {
    let mut out = s.to_owned();
    for secret in secrets.iter().filter(|secret| !secret.is_empty()) {
        out = out.replace(secret.as_str(), MASK);
        out = mask_partial(&out, secret);
    }
    let mut masked = String::with_capacity(out.len());
    let (mut last, mut from) = (0, 0);
    while let Some(start) = MARKERS.find_at(&out, from).map(|found| found.start()) {
        let at_boundary = out[..start].chars().next_back().is_none_or(|c| !c.is_ascii_alphanumeric());
        match match_at(&out, start).filter(|_| at_boundary) {
            Some(end) => {
                let end = mask_end(&out, start, end);
                masked.push_str(&out[last..start]);
                masked.push_str(MASK);
                (last, from) = (end, end);
            }
            None => from = start + out[start..].chars().next().map_or(1, char::len_utf8),
        }
    }
    masked.push_str(&out[last..]);
    masked
}

/// Masks every stretch of `PARTIAL` or more characters that is part of `secret`.
fn mask_partial(s: &str, secret: &str) -> String {
    if secret.len() < PARTIAL {
        return s.to_owned();
    }
    let bytes = s.as_bytes();
    let (mut out, mut copied, mut at) = (String::with_capacity(s.len()), 0, 0);
    while at + PARTIAL <= s.len() {
        let window = &bytes[at..at + PARTIAL];
        if window.is_ascii() && secret.contains(std::str::from_utf8(window).expect("ascii")) {
            let mut end = at + PARTIAL;
            while end < s.len() && bytes[end].is_ascii() && secret.contains(&s[at..=end]) {
                end += 1;
            }
            out.push_str(&s[copied..at]);
            out.push_str(MASK);
            (copied, at) = (end, end);
        } else {
            at += 1;
        }
    }
    out.push_str(&s[copied..]);
    out
}

/// The end of the longest secret that starts at `at`.
fn match_at(s: &str, at: usize) -> Option<usize> {
    let rest = &s[at..];
    COMPILED
        .iter()
        .filter(|shape| {
            shape.markers.iter().any(|marker| {
                rest.get(..marker.len()).is_some_and(|head| if shape.any_case { head.eq_ignore_ascii_case(marker) } else { head == *marker })
            })
        })
        .filter_map(|shape| shape.pattern.find(rest).map(|found| at + found.end()))
        .max()
}

/// Where the mask over a secret from `start` to `end` ends: past the rest of its token run, so two secrets written
/// with nothing between them are masked whole, but not past a key's footer. A secret that starts inside the mask and
/// reaches past it (a bearer header or a key run straight onto a token) takes the mask on to its own end.
fn mask_end(s: &str, start: usize, mut end: usize) -> usize {
    let after_run = |s: &str, end: usize, from: usize| {
        if s[from..].starts_with("-----BEGIN") { end } else { end + s[end..].find(|c| !in_run(c)).unwrap_or(s.len() - end) }
    };
    end = after_run(s, end, start);
    let mut at = start + 1;
    while at < end {
        if s.is_char_boundary(at)
            && let Some(inner) = match_at(s, at)
            && inner > end
        {
            end = after_run(s, inner, at);
        }
        at += 1;
    }
    end
}

/// Calls `f` on every string in `value`, object keys among them: an agent's tool input can hold a secret as a key.
/// An event's own field names are fixed words that no secret or token shape matches.
pub fn each_string(value: &mut Value, f: &mut impl FnMut(&mut String)) {
    match value {
        Value::String(s) => f(s),
        Value::Array(items) => items.iter_mut().for_each(|item| each_string(item, f)),
        Value::Object(fields) => {
            *fields = std::mem::take(fields)
                .into_iter()
                .map(|(mut key, mut field)| {
                    f(&mut key);
                    each_string(&mut field, f);
                    (key, field)
                })
                .collect();
        }
        _ => {}
    }
}

pub fn body(body: Body, secrets: &[String]) -> Body {
    let mut value = serde_json::to_value(&body).expect("a body always serializes");
    each_string(&mut value, &mut |s| *s = text(s, secrets));
    serde_json::from_value(value).expect("masking a string keeps the body's shape")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_masks_each_token_shape_and_the_sessions_own_secrets_and_leaves_plain_text_alone() {
        for shape in SHAPES {
            let secret = (shape.example)();
            assert_eq!(text(&format!("x {secret} y"), &[]), format!("x {MASK} y"), "{}", shape.name);
        }
        assert_eq!(text("the token is 0123abcd here", &["0123abcd".into()]), format!("the token is {MASK} here"));
        let plain = "Ran `ls -la` in /tmp; sk-short and ghp_ and Bearer x are not tokens. The id is toolu_01KX85.";
        assert_eq!(text(plain, &["".into()]), plain, "an empty secret masks nothing");
    }

    #[test]
    fn redact_a_partial_copy_of_the_sessions_token_is_masked_and_two_glued_secrets_are_masked_whole() {
        let token = "0123456789abcdef".repeat(4);
        assert_eq!(text(&format!("a {} b", &token[10..40]), std::slice::from_ref(&token)), format!("a {MASK} b"));
        let short = &token[10..25];
        assert_eq!(text(&format!("a {short} b"), std::slice::from_ref(&token)), format!("a {short} b"), "15 is not a copy");
        let glued = format!("{}{}", (SHAPES[2].example)(), (SHAPES[6].example)());
        assert_eq!(text(&format!("x {glued} y"), &[]), format!("x {MASK} y"));
    }

    #[test]
    fn redact_masks_every_string_of_a_body_its_keys_among_them_and_keeps_its_shape() {
        let secret = "s3cr3t-value".to_owned();
        let input = serde_json::json!({ "args": ["-H", "x s3cr3t-value"], "n": 3, "s3cr3t-value": true });
        let masked = super::body(Body::ToolCall { id: "t1".into(), name: "curl".into(), input }, &[secret]);
        let expected = serde_json::json!({ "args": ["-H", format!("x {MASK}")], "n": 3, MASK: true });
        assert_eq!(masked, Body::ToolCall { id: "t1".into(), name: "curl".into(), input: expected });
    }

    #[test]
    fn redact_a_marker_inside_a_word_is_no_key_so_a_path_is_stored_as_it_is() {
        let path = "Edited .claude/worktrees/fix-task-list-rendering-in-the-sidebar-panel/src/main.rs today";
        assert_eq!(text(path, &[]), path);
        let key = (SHAPES[1].example)();
        assert_eq!(text(&format!("key={key}, {key}"), &[]), format!("key={MASK}, {MASK}"), "after punctuation or a space it counts");
    }
}
