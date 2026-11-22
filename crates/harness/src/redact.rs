//! Masks secrets in an event before it is stored or sent: the session's own secrets, and token shapes. It masks
//! shapes, not private text, which is why a locked session stores no payload at all.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::event::Body;

pub const MASK: &str = "<redacted>";

/// The longest token the shapes are meant to catch whole in streamed text. A longer one (a long JWT) is masked in the
/// stored text, which is whole, but its start can show in live text deltas.
pub const LONGEST_SHAPE: usize = 512;

const PRIVATE_KEY: &str = "-----BEGIN";

static SHAPES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"sk-ant-[A-Za-z0-9_-]{16,}",
        r"|sk-(?:proj-)?[A-Za-z0-9_-]{32,}",
        r"|gh[pousr]_[A-Za-z0-9]{30,}",
        r"|github_pat_[A-Za-z0-9_]{30,}",
        r"|ATATT[A-Za-z0-9_=-]{20,}",
        r"|glpat-[A-Za-z0-9_-]{20,}",
        r"|npm_[A-Za-z0-9]{36}",
        r"|[sr]k_live_[A-Za-z0-9]{20,}",
        r"|xox[abprs]-[A-Za-z0-9-]{10,}",
        r"|AIza[0-9A-Za-z_-]{35}",
        r"|ya29\.[0-9A-Za-z_-]{20,}",
        r"|AKIA[0-9A-Z]{16}",
        r"|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}",
        r"|(?i:bearer\s+)[A-Za-z0-9._~+/=-]{20,}",
        r"|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
    ))
    .expect("the shapes compile")
});

pub fn text(s: &str, secrets: &[String]) -> String {
    let mut out = s.to_owned();
    for secret in secrets.iter().filter(|secret| !secret.is_empty()) {
        out = out.replace(secret.as_str(), MASK);
    }
    match SHAPES.replace_all(&out, MASK) {
        std::borrow::Cow::Borrowed(_) => out,
        std::borrow::Cow::Owned(masked) => masked,
    }
}

/// Where streamed text can be cut so that what comes before it is masked as well as it can be: no later piece can
/// complete a secret that starts before the cut. It keeps back the last `LONGEST_SHAPE` characters, and everything
/// from a private key that has not ended yet.
pub fn safe_cut(masked: &str) -> usize {
    let mut cut = masked.len().saturating_sub(LONGEST_SHAPE);
    while !masked.is_char_boundary(cut) {
        cut -= 1;
    }
    match masked.rfind(PRIVATE_KEY) {
        Some(key) if !masked[key..].contains("-----END") => cut.min(key),
        _ => cut,
    }
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
        let shapes = [
            format!("sk-ant-api03-{}", "a".repeat(30)),
            format!("sk-proj-{}", "b".repeat(40)),
            format!("ghp_{}", "c".repeat(36)),
            format!("github_pat_{}", "d".repeat(40)),
            "xoxb-123456789012-abcdef".to_owned(),
            format!("AIza{}", "e".repeat(35)),
            format!("ya29.{}", "f".repeat(30)),
            "AKIAABCDEFGHIJKLMNOP".to_owned(),
            format!("eyJ{0}.eyJ{0}.{0}", "g".repeat(12)),
            format!("bearer {}", "h".repeat(24)),
            "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----".to_owned(),
            format!("ATATT3xFfGF0{}", "i".repeat(30)),
            format!("glpat-{}", "j".repeat(20)),
            format!("npm_{}", "k".repeat(36)),
            format!("sk_live_{}", "l".repeat(24)),
            format!("rk_live_{}", "m".repeat(24)),
        ];
        for shape in &shapes {
            assert_eq!(text(&format!("x {shape} y"), &[]), format!("x {MASK} y"), "{shape}");
        }
        assert_eq!(text("the token is 0123abcd here", &["0123abcd".into()]), format!("the token is {MASK} here"));
        let plain = "Ran `ls -la` in /tmp; sk-short and ghp_ and Bearer x are not tokens. The id is toolu_01KX85.";
        assert_eq!(text(plain, &["".into()]), plain, "an empty secret masks nothing");
    }

    #[test]
    fn redact_masks_every_string_of_a_body_its_keys_among_them_and_keeps_its_shape() {
        let secret = "s3cr3t-value".to_owned();
        let input = serde_json::json!({ "args": ["-H", "x s3cr3t-value"], "n": 3, "s3cr3t-value": true });
        let masked = super::body(Body::ToolCall { id: "t1".into(), name: "curl".into(), input }, &[secret]);
        let expected = serde_json::json!({ "args": ["-H", format!("x {MASK}")], "n": 3, MASK: true });
        assert_eq!(masked, Body::ToolCall { id: "t1".into(), name: "curl".into(), input: expected });
    }
}

#[cfg(test)]
mod cut_tests {
    use super::*;

    #[test]
    fn redact_a_cut_keeps_back_the_longest_shape_and_an_unfinished_private_key() {
        let text = "a".repeat(1000);
        assert_eq!(safe_cut(&text), 1000 - LONGEST_SHAPE);
        assert_eq!(safe_cut("short"), 0);
        let key = format!("{}-----BEGIN RSA PRIVATE KEY-----\n{}", "b".repeat(600), "c".repeat(900));
        assert_eq!(safe_cut(&key), 600, "an unfinished key is held back whole");
        let wide = "é".repeat(600);
        assert!(wide.is_char_boundary(safe_cut(&wide)));
    }
}
