//! Masks secrets in an event before it is stored or sent: the session's own secrets, and token shapes. It masks
//! shapes, not private text, which is why a locked session stores no payload at all.
//!
//! Live text fails closed. Every shape starts with a marker; [`LiveText`] sends streamed text only up to the earliest
//! marker, or the start of one, and holds the rest until it is decided: a secret is sent as the mask, anything else as
//! it is. What is still undecided when the block ends is sent as the mask, never raw. The end of a piece that could
//! begin a copy of the session's token waits for the next piece too, so a copy cut between them is masked whole.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::event::Body;

pub const MASK: &str = "<redacted>";

/// How much text after a marker live output holds while it waits to decide. Past it, everything from the marker is
/// sent as the mask, and the rest of that run (to the end of a private key) is dropped from live output.
pub const HOLD_BACK: usize = 2048;

/// The characters a token is made of. After a match, the rest of the run they form is masked with it, so two secrets
/// written with nothing between them are masked whole.
fn in_run(c: char) -> bool {
    c.is_ascii_alphanumeric() || "._~+/=-".contains(c)
}

/// One kind of secret.
pub struct Shape {
    pub name: &'static str,
    /// What the secret starts with. A shape is only looked for from one of these.
    pub markers: &'static [&'static str],
    /// The markers match in any case.
    pub any_case: bool,
    /// The whole secret, from its marker.
    pub pattern: &'static str,
    /// The most text that can still belong to the secret, from its marker. While it reaches the end of the text, the
    /// secret may still be growing.
    pub run: &'static str,
    /// Once the pattern matches the secret is complete: a private key ends with its footer.
    pub closed: bool,
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
        run: r"sk-ant-[A-Za-z0-9_-]*",
        closed: false,
        example: || format!("sk-ant-api03-{}AA", noise(1, 93, B64URL)),
    },
    Shape {
        name: "OpenAI key",
        markers: &["sk-"],
        any_case: false,
        pattern: r"sk-(?:proj-)?[A-Za-z0-9_-]{32,}",
        run: r"sk-[A-Za-z0-9_-]*",
        closed: false,
        example: || format!("sk-proj-{}", noise(2, 156, B64URL)),
    },
    Shape {
        name: "GitHub token",
        markers: &["ghp_", "gho_", "ghu_", "ghs_", "ghr_"],
        any_case: false,
        pattern: r"gh[pousr]_[A-Za-z0-9]{30,}",
        run: r"gh[pousr]_[A-Za-z0-9]*",
        closed: false,
        example: || format!("ghs_{}", noise(3, 36, ALNUM)),
    },
    Shape {
        name: "GitHub fine-grained token",
        markers: &["github_pat_"],
        any_case: false,
        pattern: r"github_pat_[A-Za-z0-9_]{30,}",
        run: r"github_pat_[A-Za-z0-9_]*",
        closed: false,
        example: || format!("github_pat_11{}_{}", noise(4, 20, ALNUM), noise(5, 59, ALNUM)),
    },
    Shape {
        name: "Atlassian API token",
        markers: &["ATATT"],
        any_case: false,
        pattern: r"ATATT[A-Za-z0-9_=-]{20,}",
        run: r"ATATT[A-Za-z0-9_=-]*",
        closed: false,
        example: || format!("ATATT3xFfGF0{}={}", noise(6, 170, B64URL), noise(7, 8, "0123456789ABCDEF")),
    },
    Shape {
        name: "GitLab token",
        markers: &["glpat-"],
        any_case: false,
        pattern: r"glpat-[A-Za-z0-9_-]{20,}",
        run: r"glpat-[A-Za-z0-9_-]*",
        closed: false,
        example: || format!("glpat-{}", noise(8, 20, B64URL)),
    },
    Shape {
        name: "npm token",
        markers: &["npm_"],
        any_case: false,
        pattern: r"npm_[A-Za-z0-9]{36}",
        run: r"npm_[A-Za-z0-9]*",
        closed: false,
        example: || format!("npm_{}", noise(9, 36, ALNUM)),
    },
    Shape {
        name: "Stripe key",
        markers: &["sk_live_", "rk_live_"],
        any_case: false,
        pattern: r"[sr]k_live_[A-Za-z0-9]{20,}",
        run: r"[sr]k_live_[A-Za-z0-9]*",
        closed: false,
        example: || format!("sk_live_{}", noise(10, 99, ALNUM)),
    },
    Shape {
        name: "Slack token",
        markers: &["xoxa-", "xoxb-", "xoxp-", "xoxr-", "xoxs-"],
        any_case: false,
        pattern: r"xox[abprs]-[A-Za-z0-9-]{10,}",
        run: r"xox[abprs]-[A-Za-z0-9-]*",
        closed: false,
        example: || format!("xox{}-{}-{}-{}", "b", noise(11, 12, "0123456789"), noise(12, 13, "0123456789"), noise(13, 24, ALNUM)),
    },
    Shape {
        name: "Google API key",
        markers: &["AIza"],
        any_case: false,
        pattern: r"AIza[0-9A-Za-z_-]{35}",
        run: r"AIza[0-9A-Za-z_-]*",
        closed: false,
        example: || format!("AIza{}", noise(14, 35, B64URL)),
    },
    Shape {
        name: "Google OAuth token",
        markers: &["ya29."],
        any_case: false,
        pattern: r"ya29\.[0-9A-Za-z_-]{20,}",
        run: r"ya29\.[0-9A-Za-z_-]*",
        closed: false,
        example: || format!("ya29.{}", noise(15, 150, B64URL)),
    },
    Shape {
        name: "AWS access key",
        markers: &["AKIA"],
        any_case: false,
        pattern: r"AKIA[0-9A-Z]{16}",
        run: r"AKIA[0-9A-Z]*",
        closed: false,
        example: || format!("AKIA{}", noise(16, 16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")),
    },
    Shape {
        name: "JWT",
        markers: &["eyJ"],
        any_case: false,
        pattern: r"eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}",
        run: r"eyJ[A-Za-z0-9_.-]*",
        closed: false,
        example: || jwt(300),
    },
    Shape {
        name: "Bearer header",
        markers: &["bearer"],
        any_case: true,
        pattern: r"(?i:bearer)\s+[A-Za-z0-9._~+/=-]{20,}",
        run: r"(?i:bearer)\s*[A-Za-z0-9._~+/=-]*",
        closed: false,
        example: || format!("Bearer {}", noise(17, 48, B64URL)),
    },
    Shape {
        name: "Private key",
        markers: &["-----BEGIN"],
        any_case: false,
        pattern: r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
        run: r"-----BEGIN[\s\S]*",
        closed: true,
        example: || {
            let base64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            let lines: Vec<String> = (0..5).map(|n| noise(18 + n, 70, base64)).collect();
            format!("-----BEGIN OPENSSH PRIVATE KEY-----\n{}\n-----END OPENSSH PRIVATE KEY-----", lines.join("\n"))
        },
    },
];

/// A JWT of about `len` characters, its parts in the shape the pattern wants.
pub fn jwt(len: usize) -> String {
    let body = len.saturating_sub(84).max(20);
    format!("eyJ{}.eyJ{}.{}", noise(30, 33, B64URL), noise(31, body, B64URL), noise(32, 43, B64URL))
}

static ALL: LazyLock<Regex> = LazyLock::new(|| {
    let alternation: Vec<String> = SHAPES.iter().map(|shape| format!("(?:{})", shape.pattern)).collect();
    Regex::new(&alternation.join("|")).expect("the shapes compile")
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
    let mut last = 0;
    for found in ALL.find_iter(&out) {
        if found.end() <= last {
            continue;
        }
        // One that begins inside the mask before it (a key or a bearer header glued to a token) extends that mask.
        if found.start() >= last {
            masked.push_str(&out[last..found.start()]);
            masked.push_str(MASK);
        }
        last = found.end();
        if !found.as_str().starts_with("-----BEGIN") {
            last += out[last..].find(|c| !in_run(c)).unwrap_or(out.len() - last);
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

struct Compiled {
    markers: Vec<String>,
    any_case: bool,
    pattern: Regex,
    run: Regex,
    closed: bool,
    /// White space can follow the marker inside the secret, so a token run ends before the secret does.
    spaced: bool,
}

impl Compiled {
    fn marker(&self, marker: &str) -> String {
        if self.any_case { marker.to_ascii_lowercase() } else { marker.to_owned() }
    }
}

static COMPILED: LazyLock<Vec<Compiled>> = LazyLock::new(|| {
    SHAPES
        .iter()
        .map(|shape| {
            let run = Regex::new(&format!("^(?:{})", shape.run)).expect("the run compiles");
            let spaced = shape.markers.iter().any(|marker| run.find(&format!("{marker} x")).is_some_and(|found| found.end() > marker.len()));
            Compiled {
                markers: shape.markers.iter().map(|marker| marker.to_string()).collect(),
                any_case: shape.any_case,
                pattern: Regex::new(&format!("^(?:{})", shape.pattern)).expect("the shape compiles"),
                run,
                closed: shape.closed,
                spaced,
            }
        })
        .collect()
});

static KEY_FOOTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"-----END [A-Z ]*PRIVATE KEY-----").expect("compiles"));

/// How many characters of the session's own token mark it in live text.
pub const TOKEN_MARKER: usize = 8;

enum Masking {
    /// The rest of a token run is dropped, and first any white space when `spaces` (a bearer header held too long).
    Run { spaces: bool },
    /// Everything up to the end of a private key is dropped.
    Key,
}

enum Decision {
    Secret { end: usize, closed: bool },
    Not,
    Undecided { key: bool },
}

/// One session's streamed text on its way to live clients. `push` takes each piece and gives what may be sent now;
/// `end`, at the end of the block, gives the rest, with anything undecided masked.
pub struct LiveText {
    /// The session's own tokens, looked for from their first `TOKEN_MARKER` characters, beside the shapes.
    secrets: Vec<String>,
    held: String,
    masking: Option<Masking>,
}

impl LiveText {
    pub fn new(secrets: &[String]) -> LiveText {
        LiveText { secrets: secrets.to_vec(), held: String::new(), masking: None }
    }

    fn tokens(&self) -> impl Iterator<Item = &str> {
        self.secrets.iter().map(String::as_str).filter(|secret| secret.len() >= TOKEN_MARKER)
    }

    pub fn push(&mut self, piece: &str) -> String {
        self.held.push_str(piece);
        self.release(false)
    }

    /// The block ended: what was held goes out, decided now that no more of it can come.
    pub fn end(&mut self) -> String {
        let out = self.release(true);
        self.held.clear();
        self.masking = None;
        out
    }

    fn release(&mut self, at_end: bool) -> String {
        let mut out = String::new();
        loop {
            match self.masking {
                Some(Masking::Run { spaces }) => {
                    if spaces {
                        let start = self.held.find(|c: char| !c.is_whitespace()).unwrap_or(self.held.len());
                        self.held.drain(..start);
                        if self.held.is_empty() {
                            break;
                        }
                        self.masking = Some(Masking::Run { spaces: false });
                    }
                    let end = self.held.find(|c| !in_run(c)).unwrap_or(self.held.len());
                    let growing = end == self.held.len();
                    let spaced = self.held[end..].starts_with(char::is_whitespace);
                    let keep = spaced_marker_at_end(&self.held[..end], growing, spaced);
                    self.held.drain(..end - keep);
                    if growing {
                        break;
                    }
                    self.masking = None;
                }
                Some(Masking::Key) => match KEY_FOOTER.find(&self.held) {
                    Some(footer) => {
                        self.held.drain(..footer.end());
                        self.masking = None;
                    }
                    None => {
                        // Enough to find a footer that is cut between this piece and the next.
                        let mut keep = self.held.len().saturating_sub(64);
                        while !self.held.is_char_boundary(keep) {
                            keep -= 1;
                        }
                        self.held.drain(..keep);
                        break;
                    }
                },
                None => {}
            }
            let Some((at, whole)) = self.earliest_marker() else {
                let cut = if at_end { self.held.len() } else { self.held.len() - self.token_tail() };
                out.push_str(&self.held[..cut]);
                self.held.drain(..cut);
                break;
            };
            let at = if whole || at_end { at } else { at.min(self.held.len() - self.token_tail()) };
            out.push_str(&self.held[..at]);
            self.held.drain(..at);
            if !whole {
                // Only the start of a marker: at the end of the block it never became one.
                if at_end {
                    out.push_str(&self.held);
                    self.held.clear();
                }
                break;
            }
            match self.decide(at_end) {
                Decision::Secret { end, closed } => {
                    out.push_str(MASK);
                    self.held.drain(..end);
                    if !closed {
                        self.masking = Some(Masking::Run { spaces: false });
                    }
                }
                Decision::Not => {
                    let first = self.held.chars().next().expect("a marker is held").len_utf8();
                    out.push_str(&self.held[..first]);
                    self.held.drain(..first);
                }
                Decision::Undecided { .. } if at_end => {
                    out.push_str(MASK);
                    self.held.clear();
                    break;
                }
                Decision::Undecided { key: true } if self.held.len() > HOLD_BACK => {
                    out.push_str(MASK);
                    self.masking = Some(Masking::Key);
                }
                Decision::Undecided { key: false } if self.held.len() > HOLD_BACK => {
                    // All that is held belongs to the run still growing; what comes next goes on with it.
                    out.push_str(MASK);
                    let spaces = self.held.ends_with(char::is_whitespace);
                    self.held.clear();
                    self.masking = Some(Masking::Run { spaces });
                    break;
                }
                Decision::Undecided { .. } => break,
            }
        }
        text(&out, &self.secrets)
    }

    /// How much of the end of what is held could be the start of a copy of one of the session's tokens: it waits, so a
    /// copy cut between two pieces is masked whole, as in stored text.
    fn token_tail(&self) -> usize {
        let held = self.held.as_str();
        self.secrets
            .iter()
            .filter(|secret| secret.len() >= PARTIAL)
            .filter_map(|secret| (1..=held.len().min(secret.len())).rev().find(|n| held.is_char_boundary(held.len() - n) && secret.contains(&held[held.len() - n..])))
            .max()
            .unwrap_or(0)
    }

    /// The first place in what is held where a marker starts, and whether it is whole there or only begun at the end.
    fn earliest_marker(&self) -> Option<(usize, bool)> {
        let lower = self.held.to_ascii_lowercase();
        let mut best: Option<(usize, bool)> = None;
        let mut look = |haystack: &str, marker: &str| {
            let found = haystack.find(marker).map(|at| (at, true)).or_else(|| {
                (1..marker.len()).rev().find(|part| haystack.ends_with(&marker[..*part])).map(|part| (haystack.len() - part, false))
            });
            if let Some(found) = found
                && best.is_none_or(|best| found.0 < best.0 || (found.0 == best.0 && found.1))
            {
                best = Some(found);
            }
        };
        for shape in COMPILED.iter() {
            let haystack = if shape.any_case { &lower } else { &self.held };
            for marker in &shape.markers {
                look(haystack, &shape.marker(marker));
            }
        }
        for token in self.tokens() {
            look(&self.held, &token[..TOKEN_MARKER]);
        }
        best
    }

    /// What the text held from a whole marker is: a secret, not one, or not known yet.
    fn decide(&self, at_end: bool) -> Decision {
        let lower = self.held.to_ascii_lowercase();
        let (mut secret, mut undecided, mut key): (Option<(usize, bool)>, bool, bool) = (None, false, false);
        let held = self.held.as_str();
        let mut weigh = |found: Option<usize>, run_end: usize, closed: bool| {
            let growing = run_end == held.len();
            match found {
                Some(end) if closed || !growing || at_end => {
                    if secret.is_none_or(|(longest, _)| end > longest) {
                        secret = Some((end, closed));
                    }
                }
                _ if growing => {
                    undecided = true;
                    key |= closed;
                }
                _ => {}
            }
        };
        for shape in COMPILED.iter() {
            let haystack = if shape.any_case { &lower } else { held };
            if shape.markers.iter().any(|marker| haystack.starts_with(&shape.marker(marker))) {
                let run_end = shape.run.find(held).map_or(0, |run| run.end());
                weigh(shape.pattern.find(held).map(|found| found.end()), run_end, shape.closed);
            }
        }
        for token in self.tokens().filter(|token| held.starts_with(&token[..TOKEN_MARKER])) {
            let rest = &held[TOKEN_MARKER..];
            let run_end = TOKEN_MARKER + rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-')).unwrap_or(rest.len());
            weigh(held.starts_with(token).then_some(token.len()), run_end, false);
        }
        match (secret, undecided) {
            (Some((end, closed)), _) => Decision::Secret { end, closed },
            (None, true) => Decision::Undecided { key },
            (None, false) => Decision::Not,
        }
    }
}

/// How many bytes at the end of a dropped token run must stay held: a marker there whose secret goes on past white
/// space (a key or a bearer header glued to a token) is looked at on its own. While the run grows, so may a marker.
fn spaced_marker_at_end(run: &str, growing: bool, spaced: bool) -> usize {
    let lower = run.to_ascii_lowercase();
    let mut keep = 0;
    for shape in COMPILED.iter().filter(|shape| shape.spaced) {
        let haystack = if shape.any_case { &lower } else { run };
        for marker in shape.markers.iter().map(|marker| shape.marker(marker)) {
            let found = if growing {
                (1..=marker.len()).rev().find(|n| haystack.ends_with(&marker[..*n])).unwrap_or(0)
            } else if spaced && haystack.ends_with(&marker) {
                marker.len()
            } else {
                0
            };
            keep = keep.max(found);
        }
    }
    keep
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
    fn redact_live_text_without_a_marker_goes_out_at_once_and_a_marker_waits() {
        let mut live = LiveText::new(&[]);
        assert_eq!(live.push("ready to go "), "ready to go ");
        assert_eq!(live.push("see sk-"), "see ", "a marker waits");
        assert_eq!(live.push("learn now"), "sk-learn now", "decided not a secret");
        assert_eq!(live.push(" yes"), " ye", "a possible marker start (`s`) waits");
        assert_eq!(live.end(), "s", "and goes out at the end, since it never became a marker");
        assert_eq!(live.push("key sk-ant-api03-abc"), "key ");
        assert_eq!(live.end(), MASK, "undecided at the end is masked, never sent raw");
    }
}
