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

/// A URL's `user:password@`, as a proxy URL carries it. A user alone (`ssh://git@host`) is no secret and stays.
static USERINFO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)\b([a-z][a-z0-9+.-]*://)[^\s/?#@:"'<>]*:[^\s/?#@"'<>]*@"#).expect("a valid pattern"));

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_urls_user_and_password_are_masked_and_text_that_only_looks_like_one_is_kept() {
        for (said, want) in [
            ("proxy http://me:hunter2@proxy.test:8080 refused", "proxy http://<redacted>@proxy.test:8080 refused"),
            ("HTTPS_PROXY=https://me:p%40ss@proxy.test", "HTTPS_PROXY=https://<redacted>@proxy.test"),
            ("socks5h://u:pw@127.0.0.1:1080", "socks5h://<redacted>@127.0.0.1:1080"),
            ("\"ALL_PROXY\":\"socks://:pw@h\"", "\"ALL_PROXY\":\"socks://<redacted>@h\""),
        ] {
            assert_eq!(text(said, &[]), want);
        }
        for kept in ["ssh://git@example.test/repo.git", "mail a:b@example.test", "http://example.test/a:b@c", "see http://example.test:8080/@me", "time 10:30@home"] {
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
}
