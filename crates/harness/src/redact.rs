//! Masks secrets in an event before it is stored or sent: the session's own secrets, and token shapes. It masks
//! shapes, not private text, which is why a locked session stores no payload at all.
//!
//! Live text fails closed. [`LiveText`] sends a block's streamed text only up to the earliest marker that could still
//! become a secret, or the start of one, and holds the rest until more text decides it. What it sends is masked by
//! [`text`], cut where the rest of the block cannot change how it is masked, so the pieces joined are the block as
//! it is stored.

use std::sync::LazyLock;

use regex::Regex;
use regex_automata::hybrid::dfa::{Cache, DFA};
use regex_automata::{Anchored, Input};
use serde_json::Value;

use crate::event::Body;

pub const MASK: &str = "<redacted>";

/// The characters a token is made of. After a match, the rest of the run they form is masked with it, so two secrets
/// written with nothing between them are masked whole.
fn in_run(c: char) -> bool {
    c.is_ascii_alphanumeric() || "._~+/=-".contains(c)
}

/// The one marker that is common inside words (`task-list`, `disk-image`). Every other marker counts wherever it
/// stands, since a secret is often escaped, encoded or glued on. When in doubt the redactor masks.
pub const WORD_MARKER: &str = "sk-";

/// How much of a key's body [`key_starts`] reads, so a long run is not read again from each `sk-` in it.
const KEY_LOOK: usize = 64;

/// Whether bare `sk-` at `at` starts a key. Where a word starts it does: at the start, after anything but a letter or
/// digit, or after a `%XX` escape or a `\n`, `\t` or `\r` escape. Anywhere else it does when the key's body holds an
/// upper-case letter and a digit, as the random characters of a real key almost always do and a readable word such as
/// `task-list-rendering-in-the-sidebar-panel` does not. The list of escapes cannot be complete (`=3D`, `\x3d`,
/// `ESC[32m`), which is why the body decides after any other letter or digit. A later edit could break this property
/// either way: a looser body test masks readable paths, and dropping it stores a key raw after an escape not listed.
fn key_starts(s: &str, at: usize) -> bool {
    match s.as_bytes()[..at] {
        [] | [.., b'%', b'0'..=b'9' | b'A'..=b'F' | b'a'..=b'f', b'0'..=b'9' | b'A'..=b'F' | b'a'..=b'f'] | [.., b'\\', b'n' | b't' | b'r'] => return true,
        [.., last] if !last.is_ascii_alphanumeric() => return true,
        _ => {}
    }
    let rest = &s[at + WORD_MARKER.len()..];
    let body = rest.strip_prefix("proj-").unwrap_or(rest).bytes().take(KEY_LOOK).take_while(|b| b.is_ascii_alphanumeric() || b"_-".contains(b));
    let (upper, digit) = body.fold((false, false), |(upper, digit), b| (upper || b.is_ascii_uppercase(), digit || b.is_ascii_digit()));
    upper && digit
}

/// One kind of secret.
pub struct Shape {
    pub name: &'static str,
    /// What the secret starts with. A shape is only looked for from one of these, wherever it stands, except
    /// [`WORD_MARKER`].
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
    /// The secret can hold characters a token run does not (a bearer header's space, a key's lines), so it can reach
    /// past the end of a run it starts inside.
    crosses: bool,
}

static COMPILED: LazyLock<Vec<Compiled>> = LazyLock::new(|| {
    SHAPES
        .iter()
        .map(|shape| Compiled {
            markers: shape.markers,
            any_case: shape.any_case,
            pattern: Regex::new(shape.pattern).expect("the shape compiles"),
            crosses: (shape.example)().chars().any(|c| !in_run(c)),
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

/// Where each shape's last search found its next secret, from where. A secret that is not there is then not looked
/// for again from every later marker: a key header with no footer, or `eyJ` all through a run with no dots, would
/// otherwise be read to the end of the text from each of its markers, in time that grows with the square of the text.
struct Scans(Vec<Option<Scan>>);

/// Where a search started, and the start and end of the secret it found next, if any.
type Scan = (usize, Option<(usize, usize)>);

impl Scans {
    fn new() -> Self {
        Scans(vec![None; COMPILED.len()])
    }

    /// The end of the secret of shape `n` that starts at `at`, if one does.
    fn at(&mut self, s: &str, n: usize, at: usize) -> Option<usize> {
        let next = match self.0[n] {
            Some((from, next)) if from <= at && next.is_none_or(|(start, _)| start >= at) => next,
            _ => {
                let next = COMPILED[n].pattern.find_at(s, at).map(|found| (found.start(), found.end()));
                self.0[n] = Some((at, next));
                next
            }
        };
        next.filter(|(start, _)| *start == at).map(|(_, end)| end)
    }
}

/// A URL's `user:password@`, as a proxy URL carries it, to the last `@` before the host: a password may hold `@`, `/`
/// or `#` unescaped, as proxy settings often do. A user alone (`ssh://git@host`) is no secret and stays. A host's port
/// and a path with an `@` (`host:8080/@x`) cannot be told from a password that starts with digits and holds a `/`, so
/// it is masked too.
static USERINFO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)\b([a-z][a-z0-9+.-]*://)[^\s/?#@:"<>]*:[^\s"<>]*@"#).expect("a valid pattern"));

pub fn text(s: &str, secrets: &[String]) -> String {
    let mut out = USERINFO.replace_all(s, format!("${{1}}{MASK}@")).into_owned();
    for secret in secrets.iter().filter(|secret| !secret.is_empty()) {
        out = out.replace(secret.as_str(), MASK);
        out = mask_partial(&out, secret);
    }
    let mut masked = String::with_capacity(out.len());
    let (mut last, mut from) = (0, 0);
    let scans = &mut Scans::new();
    while let Some(start) = MARKERS.find_at(&out, from).map(|found| found.start()) {
        match match_at(&out, start, false, scans) {
            Some(end) => {
                let end = mask_end(&out, start, end, scans);
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

/// The end of the longest secret that starts at `at`. Outside a mask, [`WORD_MARKER`] counts only where
/// [`key_starts`] says. `inside` a mask, where secrets are glued, it counts anywhere, and only shapes that cross white
/// space are looked for: the mask already runs to the end of the token run, so a shape of run characters alone ends
/// inside it, and matching each of them against the rest would take time that grows with the square of a long run.
fn match_at(s: &str, at: usize, inside: bool, scans: &mut Scans) -> Option<usize> {
    let rest = &s[at..];
    COMPILED
        .iter()
        .enumerate()
        .filter(|(_, shape)| !inside || shape.crosses)
        .filter(|(_, shape)| {
            shape.markers.iter().any(|marker| {
                let here = rest.get(..marker.len()).is_some_and(|head| if shape.any_case { head.eq_ignore_ascii_case(marker) } else { head == *marker });
                here && (inside || *marker != WORD_MARKER || key_starts(s, at))
            })
        })
        .filter_map(|(n, _)| scans.at(s, n, at))
        .max()
}

/// Where the mask over a secret from `start` to `end` ends: past the rest of its token run, so two secrets written
/// with nothing between them are masked whole, but not past a key's footer. A secret that starts inside the mask and
/// reaches past it (a bearer header or a key run straight onto a token) takes the mask on to its own end.
fn mask_end(s: &str, start: usize, mut end: usize, scans: &mut Scans) -> usize {
    let after_run = |s: &str, end: usize, from: usize| {
        if s[from..].starts_with("-----BEGIN") { end } else { end + s[end..].find(|c| !in_run(c)).unwrap_or(s.len() - end) }
    };
    end = after_run(s, end, start);
    let mut at = start + 1;
    while at < end {
        if s.is_char_boundary(at)
            && let Some(inner) = match_at(s, at, true, scans)
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
            // Keys the mask leaves as they are keep their names; a key it changes takes its masked name if that is
            // free, or a numbered one, so every entry stays and none is renamed.
            let (mut masked, mut renamed) = (serde_json::Map::new(), vec![]);
            for (key, mut field) in std::mem::take(fields) {
                let mut new = key.clone();
                f(&mut new);
                each_string(&mut field, f);
                if new == key {
                    masked.insert(key, field);
                } else {
                    renamed.push((new, field));
                }
            }
            for (key, field) in renamed {
                let mut free = key.clone();
                for n in 2.. {
                    if !masked.contains_key(&free) {
                        break;
                    }
                    free = format!("{key} {n}");
                }
                masked.insert(free, field);
            }
            *fields = masked;
        }
        _ => {}
    }
}

pub fn body(body: Body, secrets: &[String]) -> Body {
    let mut value = serde_json::to_value(&body).expect("a body always serializes");
    each_string(&mut value, &mut |s| *s = text(s, secrets));
    serde_json::from_value(value).expect("masking a string keeps the body's shape")
}

/// Each shape as a lazy DFA, to tell whether the text from one of its markers could still grow into its secret.
static GROWING: LazyLock<Vec<DFA>> = LazyLock::new(|| SHAPES.iter().map(|shape| DFA::new(shape.pattern).expect("the shape compiles")).collect());

/// What comes before a URL's user and password.
const SCHEME_END: &str = "://";

/// One session's streamed block on its way to live clients. `push` takes each piece and gives what may go out now;
/// `end`, when the block ends, gives the rest.
pub struct LiveText {
    secrets: Vec<String>,
    /// The block so far.
    raw: String,
    /// How much of `raw` has gone out.
    sent: usize,
    caches: Vec<Cache>,
}

impl LiveText {
    pub fn new(secrets: &[String]) -> LiveText {
        let secrets = secrets.iter().filter(|secret| !secret.is_empty()).cloned().collect();
        LiveText { secrets, raw: String::new(), sent: 0, caches: GROWING.iter().map(DFA::create_cache).collect() }
    }

    pub fn push(&mut self, piece: &str) -> String {
        self.raw.push_str(piece);
        let cut = cut(&self.raw, self.sent, &self.secrets, &mut self.caches);
        self.release(cut)
    }

    /// The block ended: the rest goes out, decided now that no more of it can come, as the stored block is.
    pub fn end(&mut self) -> String {
        let out = self.release(self.raw.len());
        self.reset();
        out
    }

    /// Whether `block` goes on from what was streamed, as the block a driver sends after its pieces does.
    pub fn is_start_of(&self, block: &str) -> bool {
        block.starts_with(&self.raw)
    }

    /// The block ended with no text of its own (its turn ended or failed first): what was held is dropped.
    pub fn reset(&mut self) {
        self.raw.clear();
        self.sent = 0;
    }

    fn release(&mut self, cut: usize) -> String {
        if cut <= self.sent {
            return String::new();
        }
        let out = text(&self.raw[self.sent..cut], &self.secrets);
        self.sent = cut;
        out
    }
}

/// How far `raw` may go out now, from `from`. Cut there, the rest of the block cannot change how the part before is
/// masked, so masking the part alone masks it as the whole block is masked:
/// - no secret, nothing that could still grow into one, and no copy of the session's own secret reaches across it;
/// - nothing at the end of the part could start a marker;
/// - the character before it is white space or punctuation that is no part of a word or an escape, so a marker after
///   it starts a word ([`key_starts`]) and a URL's scheme a word boundary, alone as in the whole block.
fn cut(raw: &str, from: usize, secrets: &[String], caches: &mut [Cache]) -> usize {
    let mut cut = held_start(raw, from).unwrap_or(raw.len());
    let mut spans = vec![];
    let scans = &mut Scans::new();
    let mut at = from;
    while let Some(marker) = MARKERS.find_at(raw, at).map(|found| found.start()).filter(|marker| *marker < cut) {
        match marker_span(raw, marker, caches, scans) {
            Some(end) if end >= raw.len() => cut = marker,
            Some(end) => spans.push((marker, end)),
            None => {}
        }
        at = marker + raw[marker..].chars().next().map_or(1, char::len_utf8);
    }
    let mut at = from;
    while let Some(scheme) = raw[at..].find(SCHEME_END).map(|found| at + found).filter(|scheme| *scheme < cut) {
        let in_scheme = |c: char| c.is_ascii_alphanumeric() || "+.-".contains(c);
        let start = raw[from..scheme].char_indices().rfind(|(_, c)| !in_scheme(*c)).map_or(from, |(before, c)| from + before + c.len_utf8());
        match raw[scheme + SCHEME_END.len()..].find(|c: char| c.is_whitespace() || "\"<>".contains(c)) {
            Some(stop) => spans.push((start, scheme + SCHEME_END.len() + stop)),
            None => cut = cut.min(start),
        }
        at = scheme + SCHEME_END.len();
    }
    loop {
        let was = cut;
        while cut > from && !raw[..cut].chars().next_back().is_some_and(neutral) {
            cut -= raw[..cut].chars().next_back().map_or(1, char::len_utf8);
        }
        for secret in secrets {
            cut = cut.min(copy_start(raw, from, cut, secret).unwrap_or(cut));
        }
        for (start, end) in &spans {
            if *start < cut && cut < *end {
                cut = *start;
            }
        }
        if cut == was {
            return cut;
        }
    }
}

/// A character a cut may follow. Not `_`, a word character, nor `%` or a backslash, which start the escapes
/// [`key_starts`] reads before a key.
fn neutral(c: char) -> bool {
    c.is_whitespace() || (c.is_ascii_punctuation() && !"_%\\".contains(c))
}

/// Where the end of `raw` could be the start of a marker, or of a URL's `://`.
fn held_start(raw: &str, from: usize) -> Option<usize> {
    let starts = |tail: &str| {
        SHAPES.iter().flat_map(|shape| shape.markers.iter().map(move |marker| (*marker, shape.any_case))).chain([(SCHEME_END, false)]).any(|(marker, any_case)| {
            marker.len() > tail.len() && if any_case { marker[..tail.len()].eq_ignore_ascii_case(tail) } else { marker.starts_with(tail) }
        })
    };
    let longest = SHAPES.iter().flat_map(|shape| shape.markers.iter()).map(|marker| marker.len()).max().unwrap_or(0);
    (from.max(raw.len().saturating_sub(longest))..raw.len()).filter(|at| raw.is_char_boundary(*at)).find(|at| starts(&raw[*at..]))
}

/// The most that may be masked from the marker at `marker`, as far as `raw` goes, whether or not [`key_starts`] would
/// mask it there: `raw`'s end when it could still grow. None when no shape's secret starts there.
fn marker_span(raw: &str, marker: usize, caches: &mut [Cache], scans: &mut Scans) -> Option<usize> {
    let rest = &raw[marker..];
    let mut most = None;
    for (n, shape) in COMPILED.iter().enumerate() {
        let here = shape.markers.iter().any(|m| rest.get(..m.len()).is_some_and(|head| if shape.any_case { head.eq_ignore_ascii_case(m) } else { head == *m }));
        if !here {
            continue;
        }
        if grows(raw, marker, &GROWING[n], &mut caches[n]) {
            return Some(raw.len());
        }
        if let Some(end) = scans.at(raw, n, marker) {
            most = most.max(Some(mask_end(raw, marker, end, scans)));
        }
    }
    most
}

/// Whether more text after `raw` could still make a longer secret of `dfa`'s shape from `marker`. A DFA that gives up
/// says it could.
fn grows(raw: &str, marker: usize, dfa: &DFA, cache: &mut Cache) -> bool {
    let input = Input::new(raw).range(marker..).anchored(Anchored::Yes);
    let Ok(mut state) = dfa.start_state_forward(cache, &input) else { return true };
    for &byte in &raw.as_bytes()[marker..] {
        match dfa.next_state(cache, state, byte) {
            Ok(next) if next.is_dead() => return false,
            Ok(next) => state = next,
            Err(_) => return true,
        }
    }
    true
}

/// Where a copy of `secret` that reaches across `cut`, or may still grow at `raw`'s end, starts. Any two characters
/// of the secret on either side of the cut, or one of its characters at the end, may be part of one.
fn copy_start(raw: &str, from: usize, cut: usize, secret: &str) -> Option<usize> {
    let (bytes, secret) = (raw.as_bytes(), secret.as_bytes());
    let holds = |part: &[u8]| secret.windows(part.len()).any(|window| window == part);
    let across = cut > from && if cut == raw.len() { holds(&bytes[cut - 1..cut]) } else { holds(&bytes[cut - 1..=cut]) };
    if !across {
        return None;
    }
    let mut start = (from..cut).find(|start| cut - start <= secret.len() && holds(&bytes[*start..cut])).unwrap_or(from);
    while !raw.is_char_boundary(start) {
        start -= 1;
    }
    Some(start)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_urls_user_and_password_are_masked_and_text_that_only_looks_like_one_is_kept() {
        for (said, want) in [
            ("proxy http://me:hunter2@proxy.test:8080 refused", "proxy http://<redacted>@proxy.test:8080 refused"),
            ("HTTPS_PROXY=https://me:p%40ss@proxy.test", "HTTPS_PROXY=https://<redacted>@proxy.test"),
            ("socks5h://u:pw@127.0.0.1:1080", "socks5h://<redacted>@127.0.0.1:1080"),
            ("http://o'neil:it's@proxy.test", "http://<redacted>@proxy.test"),
            ("http://me:p@ss@proxy.test:8080", "http://<redacted>@proxy.test:8080"),
            ("http://user:1234@proxy.test", "http://<redacted>@proxy.test"),
            ("http://me:1234@proxy.test:8080", "http://<redacted>@proxy.test:8080"),
            ("socks5://u:0000@127.0.0.1:1080", "socks5://<redacted>@127.0.0.1:1080"),
            ("http://user:1234/abc@proxy.test", "http://<redacted>@proxy.test"),
            ("see http://example.test:8080/@me", "see http://<redacted>@me"),
            ("http://me:pa/ss@proxy.test", "http://<redacted>@proxy.test"),
            ("http://me:pa#ss@proxy.test/x", "http://<redacted>@proxy.test/x"),
            ("\"ALL_PROXY\":\"socks://:pw@h\"", "\"ALL_PROXY\":\"socks://<redacted>@h\""),
        ] {
            assert_eq!(text(said, &[]), want);
        }
        for kept in ["ssh://git@example.test/repo.git", "mail a:b@example.test", "http://example.test/a:b@c", "time 10:30@home"] {
            assert_eq!(text(kept, &[]), kept);
        }
    }

    #[test]
    fn redact_masks_each_token_shape_and_the_sessions_own_secrets_and_leaves_plain_text_alone() {
        for shape in SHAPES {
            let secret = (shape.example)();
            assert!(text(&format!("x {secret} y"), &[]) == format!("x {MASK} y"), "{} is not masked as expected", shape.name);
        }
        assert!(text("the token is 0123abcd here", &["0123abcd".into()]) == format!("the token is {MASK} here"), "the session's secret");
        let plain = "Ran `ls -la` in /tmp; sk-short and ghp_ and Bearer x are not tokens. The id is toolu_01KX85.";
        assert_eq!(text(plain, &["".into()]), plain, "an empty secret masks nothing");
    }

    #[test]
    fn redact_a_partial_copy_of_the_sessions_token_is_masked_and_two_glued_secrets_are_masked_whole() {
        let token = "0123456789abcdef".repeat(4);
        assert!(text(&format!("a {} b", &token[10..40]), std::slice::from_ref(&token)) == format!("a {MASK} b"), "30 is a copy");
        let short = &token[10..25];
        assert!(text(&format!("a {short} b"), std::slice::from_ref(&token)) == format!("a {short} b"), "15 is not a copy");
        let glued = format!("{}{}", (SHAPES[2].example)(), (SHAPES[6].example)());
        assert!(text(&format!("x {glued} y"), &[]) == format!("x {MASK} y"), "{} then {} is not masked whole", SHAPES[2].name, SHAPES[6].name);
    }

    #[test]
    fn redact_masks_every_string_of_a_body_its_keys_among_them_and_keeps_its_shape() {
        let secret = "s3cr3t-value".to_owned();
        let input = serde_json::json!({ "args": ["-H", "x s3cr3t-value"], "n": 3, "s3cr3t-value": true });
        let masked = super::body(Body::ToolCall { id: "t1".into(), name: "curl".into(), input }, &[secret]);
        let expected = serde_json::json!({ "args": ["-H", format!("x {MASK}")], "n": 3, MASK: true });
        assert!(masked == Body::ToolCall { id: "t1".into(), name: "curl".into(), input: expected }, "the input is not masked as expected");
    }

    #[test]
    fn redact_a_marker_inside_a_word_is_no_key_so_a_path_is_stored_as_it_is() {
        for path in [
            "Edited .claude/worktrees/fix-task-list-rendering-in-the-sidebar-panel/src/main.rs today",
            "docs/risk-assessment-for-the-billing-migration-2024-q3-final.md",
            "Whisk-Together-The-Eggs-And-Flour-In-A-Large-Bowl-Until-Smooth",
            "git switch claude/ask-for-a-review-of-the-pull-request-before-merging-it",
        ] {
            assert_eq!(text(path, &[]), path, "a readable path holds no secret");
        }
        let key = (SHAPES[1].example)();
        assert!(text(&format!("key={key}, {key}"), &[]) == format!("key={MASK}, {MASK}"), "{} after punctuation or a space is not masked", SHAPES[1].name);
    }

    #[test]
    fn redact_keys_that_mask_alike_keep_every_entry() {
        let (one, two) = ((SHAPES[2].example)(), format!("ghp_{}", &(SHAPES[2].example)()[4..]));
        let input = serde_json::json!({ one.clone(): 1, two.clone(): 2, MASK: 3, "plain": 4 });
        let Body::ToolCall { input, .. } = super::body(Body::ToolCall { id: "t1".into(), name: "x".into(), input }, &[]) else { unreachable!() };
        let fields = input.as_object().unwrap();
        assert_eq!(fields.len(), 4, "an entry is lost");
        let mut values: Vec<i64> = fields.values().map(|value| value.as_i64().unwrap()).collect();
        values.sort();
        assert_eq!(values, [1, 2, 3, 4]);
        assert_eq!(fields["plain"], 4);
        assert!(fields.keys().all(|key| !key.contains(&one[4..])), "{} is in a key", SHAPES[2].name);
    }

    #[test]
    fn redact_a_long_token_run_a_key_header_with_no_footer_or_a_run_of_jwt_starts_masks_in_time_that_grows_about_linearly() {
        // Each size's best of five, so a busy machine slows a run without failing it.
        let time = |name: &str, text_of: &dyn Fn(usize) -> String, check: &dyn Fn(&str, &str) -> bool, small: usize| {
            let took = [small, small * 10].map(|len| {
                let s = text_of(len);
                (0..5)
                    .map(|_| {
                        let started = std::time::Instant::now();
                        let masked = text(&s, &[]);
                        let took = started.elapsed();
                        assert!(check(&s, &masked), "{name} is not masked as expected");
                        took
                    })
                    .min()
                    .unwrap()
            });
            // Ten times the text may take ten times as long, and much more for a slow machine, but not a hundred.
            assert!(took[1] < took[0] * 40 + std::time::Duration::from_secs(1), "{name}: {small} in {:?}, ten times that in {:?}", took[0], took[1]);
            assert!(took[1] < std::time::Duration::from_secs(30), "{name}: ten times {small} in {:?}", took[1]);
        };
        let whole = |_: &str, masked: &str| masked == format!("x {MASK} y");
        time("a run of `sk-`", &|len| format!("x {} y", "sk-".repeat(len / 3)), &whole, 300_000);
        // `grep -r` over keys, with no footer.
        let headers = |lines: usize| (0..lines).map(|n| format!("keys/{n}.pem:-----BEGIN RSA PRIVATE KEY-----\n")).collect::<String>();
        time("key headers", &headers, &|s, masked| masked == s, 2_000);
        // base64url JSON with `eyJ` all through it and no dots. A key at its start masks it whole at both sizes, so both
        // take the same path: the mask's end is looked for from every character of the run.
        let blob = |len: usize| {
            let eyjs: String = (0..len / 96).map(|n| format!("eyJ{}", noise(40 + n as u64, 93, B64URL))).collect();
            format!("x {}{eyjs} y", (SHAPES[1].example)())
        };
        time("a run of `eyJ`", &blob, &whole, 150_000);
    }

    #[test]
    fn redact_a_literal_mask_key_keeps_its_value_when_a_key_that_sorts_before_it_masks_to_it() {
        // `0` sorts before `<`, so the session's own secret as a key is visited first.
        let secret = "0123456789abcdef0123".to_owned();
        let input = serde_json::json!({ secret.clone(): "secret's", MASK: "literal" });
        let Body::ToolCall { input, .. } = super::body(Body::ToolCall { id: "t1".into(), name: "x".into(), input }, &[secret]) else { unreachable!() };
        assert!(input[MASK] == "literal", "the literal key lost its value");
        assert!(input[format!("{MASK} 2")] == "secret's", "the masked key is not numbered");
    }

    /// What live clients see of `pieces`, joined, after the block ends with its text.
    fn live(pieces: &[&str], secrets: &[String]) -> String {
        let mut live = LiveText::new(secrets);
        let mut shown: String = pieces.iter().map(|piece| live.push(piece)).collect();
        shown.push_str(&live.end());
        shown
    }

    /// The first 8 characters in a row of `secret` past its marker that `shown` holds.
    fn shows(shown: &str, secret: &str, marker: usize) -> Option<String> {
        let body: Vec<char> = secret.chars().skip(marker).collect();
        body.windows(8).map(|window| window.iter().collect::<String>()).find(|window| shown.contains(window.as_str()))
    }

    #[test]
    fn live_text_goes_out_a_word_at_a_time_and_from_a_marker_waits_until_more_text_decides_it() {
        let mut live = LiveText::new(&[]);
        assert_eq!(live.push("ready to "), "ready to ");
        assert_eq!(live.push("go now"), "go ", "a word goes out once it ends");
        assert_eq!(live.push(" and see sk-"), "now and see ", "a marker waits");
        assert_eq!(live.push("learn more."), "sk-learn more.", "decided: no secret");
        let key = (SHAPES[2].example)();
        assert_eq!(live.push(&format!(" a {key}")), " a ", "{} waits while it may still grow", SHAPES[2].name);
        assert_eq!(live.push(" b"), format!("{MASK} "), "masked once its run ends; `b` could start `bearer`");
        assert_eq!(live.end(), "b", "and goes out at the end, since it never became one");
        assert_eq!(live.push("then -"), "then ", "a new block starts afresh, and `-` could start a key's header");
        live.reset();
        assert_eq!(live.push("fresh "), "fresh ", "a reset drops what was held");
    }

    #[test]
    fn live_text_shows_the_prose_after_a_certificate_and_a_block_that_ends_on_bearer_shows_the_word() {
        let mut live = LiveText::new(&[]);
        let cert = "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ\n-----END CERTIFICATE-----\n";
        let shown = live.push(cert) + &live.push("and then the prose goes on, live.");
        assert_eq!(shown, format!("{cert}and then the prose goes on, live."), "a certificate is no private key");

        let mut live = LiveText::new(&[]);
        assert_eq!(live.push("Send it as a bearer"), "Send it as a ");
        assert_eq!(live.end(), "bearer", "nothing came after it, so it is no secret");
    }

    #[test]
    fn live_text_a_copy_of_the_sessions_token_sent_in_pieces_shows_no_16_characters_of_it() {
        // CodeRabbit's case: the copy starts with the token's first characters again (`1234...` in `90ab...1234...`).
        let token = format!("1234567890abcdef12345678fedcba98{}", "1".repeat(32));
        let shown = live(&["90abcdef", "12345678", " "], std::slice::from_ref(&token));
        assert_eq!(shown, format!("{MASK} "));
        let shown = live(&["see 90ab", "cdef1234", "5678fedc", " then"], std::slice::from_ref(&token));
        assert_eq!(shown, format!("see {MASK} then"));
        let mut live = LiveText::new(std::slice::from_ref(&token));
        assert_eq!(live.push("so: 90abcdef12345678"), "so: ", "a copy that may still grow waits");
    }

    /// The examples of every shape, each with the length of the marker it starts with.
    fn examples() -> Vec<(String, usize)> {
        SHAPES
            .iter()
            .map(|shape| {
                let example = (shape.example)();
                let marker = shape.markers.iter().find(|m| example.get(..m.len()).is_some_and(|head| head.eq_ignore_ascii_case(m)));
                (example.clone(), marker.unwrap_or_else(|| panic!("{} starts with a marker", shape.name)).len())
            })
            .collect()
    }

    /// Every way live clients can see `block` split into two pieces or three, joined. A push gives what it gives from
    /// the text so far and how much of it went out before, never from where the pieces were cut (`cut`), so each first
    /// piece is pushed once, each second piece once from each place a first one left, and each end once from each
    /// place: every split is one path through these. `cross_check` also runs every split from scratch, to show it.
    fn every_split(block: &str, live: &mut LiveText, cross_check: bool) -> std::collections::BTreeSet<String> {
        // From `sent` of `block` gone out, the next piece, to `upto`: what it shows and how much has gone out after it.
        let mut from = |sent: usize, upto: usize| {
            live.reset();
            live.raw.push_str(&block[..sent]);
            live.sent = sent;
            let mut out = live.push(&block[sent..upto]);
            if upto == block.len() {
                out.push_str(&live.end());
            }
            (out, live.sent)
        };
        let cuts: Vec<usize> = (1..block.len()).filter(|at| block.is_char_boundary(*at)).collect();
        let (mut seconds, mut lasts) = (std::collections::HashMap::new(), std::collections::HashMap::new());
        let mut shown = std::collections::BTreeSet::new();
        for &one in &cuts {
            let (first, sent) = from(0, one);
            let last = lasts.entry(sent).or_insert_with(|| from(sent, block.len()).0).clone();
            shown.insert(format!("{first}{last}"));
            for &two in cuts.iter().filter(|two| **two > one) {
                let (second, after) = seconds.entry((sent, two)).or_insert_with(|| from(sent, two)).clone();
                let last = lasts.entry(after).or_insert_with(|| from(after, block.len()).0).clone();
                shown.insert(format!("{first}{second}{last}"));
            }
        }
        if cross_check {
            let mut fresh = std::collections::BTreeSet::new();
            for &one in &cuts {
                fresh.insert(live_pieces(&[&block[..one], &block[one..]]));
                for &two in cuts.iter().filter(|two| **two > one) {
                    fresh.insert(live_pieces(&[&block[..one], &block[one..two], &block[two..]]));
                }
            }
            assert_eq!(fresh, shown, "the paths are not what splitting {block:?} from scratch shows");
        }
        shown
    }

    fn live_pieces(pieces: &[&str]) -> String {
        live(pieces, &[])
    }

    /// Every shape's example, and every two of them glued, in prose, split anywhere into two pieces and into three. No
    /// client sees 8 characters of a secret past its marker, and the pieces joined are the block as it is stored. A
    /// block whose turn ends before its text shows less: only what was pushed, the start of one of these.
    #[test]
    fn live_text_every_secret_and_glued_pair_cut_anywhere_into_two_or_three_shows_nothing_past_its_marker() {
        let examples = examples();
        let mut blocks: Vec<(String, Vec<&(String, usize)>)> = examples.iter().map(|one| (format!("Here: {} and on.", one.0), vec![one])).collect();
        for a in &examples {
            for b in &examples {
                blocks.push((format!("Here: {}{} and on.", a.0, b.0), vec![a, b]));
            }
        }
        let threads = std::thread::available_parallelism().map_or(1, |n| n.get().min(4));
        std::thread::scope(|scope| {
            for part in blocks.chunks(blocks.len().div_ceil(threads)) {
                scope.spawn(move || {
                    let mut live = LiveText::new(&[]);
                    for (block, secrets) in part {
                        let stored = text(block, &[]);
                        let short = secrets.len() == 1 && block.len() <= 60;
                        for shown in every_split(block, &mut live, short) {
                            for (secret, marker) in secrets {
                                assert!(shows(&shown, secret, *marker).is_none(), "{block:?} shows {:?} live", shows(&shown, secret, *marker));
                            }
                            assert!(shown == stored, "a split of {block:?} joined is not the block as stored: {shown:?}");
                        }
                    }
                });
            }
        });
    }
}
