//! Unified diffs as a pull request's files carry them, and where in one a review comment may sit. Pure: no I/O.
//!
//! A review comment can only go on a line the diff shows: on the right an added or unchanged line of the new file, on
//! the left a deleted or unchanged line of the old one. A patch cut short shows nothing past the cut, so nothing there
//! is commentable. `src/lib/diffHunks.ts` mirrors this, and both pass `src/lib/diffHunks.fixtures.json`.

use crate::domain::DiffSide;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineKind {
    Context,
    Added,
    Deleted,
}

/// One line of a hunk, with its number in the old file (`left`) and the new one (`right`) where it has one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffLine {
    pub kind: LineKind,
    pub left: Option<u32>,
    pub right: Option<u32>,
    /// The line as the patch has it, with its leading `+`, `-` or space.
    pub raw: String,
}

/// One `@@` section: where it starts on either side, how many lines its header says it covers there, and the lines
/// that arrived, which a cut patch leaves short.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hunk {
    pub left_start: u32,
    pub left_lines: u32,
    pub right_start: u32,
    pub right_lines: u32,
    pub lines: Vec<DiffLine>,
}

/// `-12,7` or `+12` as (start, count); a count left out is 1.
fn range(text: &str, sign: char) -> Option<(u32, u32)> {
    let text = text.strip_prefix(sign)?;
    let (start, count) = match text.split_once(',') {
        Some((s, c)) => (s.parse().ok()?, c.parse().ok()?),
        None => (text.parse().ok()?, 1),
    };
    Some((start, count))
}

/// `@@ -a,b +c,d @@ anything` as a hunk with no lines yet.
fn header(line: &str) -> Option<Hunk> {
    let rest = line.strip_prefix("@@ ")?;
    let (ranges, _) = rest.split_once(" @@")?;
    let (left, right) = ranges.split_once(' ')?;
    let (left_start, left_lines) = range(left, '-')?;
    let (right_start, right_lines) = range(right, '+')?;
    Some(Hunk { left_start, left_lines, right_start, right_lines, lines: Vec::new() })
}

/// The hunks of a file's patch. Lines outside a hunk, `\ No newline at end of file` and anything past what a hunk's
/// header promised are left out.
pub fn parse_patch(patch: &str) -> Vec<Hunk> {
    let mut hunks: Vec<Hunk> = Vec::new();
    let (mut left, mut right, mut left_left, mut right_left) = (0u32, 0u32, 0u32, 0u32);
    for line in patch.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(h) = header(line) {
            (left, right, left_left, right_left) = (h.left_start, h.right_start, h.left_lines, h.right_lines);
            hunks.push(h);
            continue;
        }
        let Some(hunk) = hunks.last_mut() else { continue };
        let kind = match line.chars().next() {
            Some(' ') | None => LineKind::Context,
            Some('+') => LineKind::Added,
            Some('-') => LineKind::Deleted,
            _ => continue,
        };
        let fits = match kind {
            LineKind::Context => left_left > 0 && right_left > 0,
            LineKind::Added => right_left > 0,
            LineKind::Deleted => left_left > 0,
        };
        if !fits {
            continue;
        }
        let (l, r) = match kind {
            LineKind::Context => (Some(left), Some(right)),
            LineKind::Added => (None, Some(right)),
            LineKind::Deleted => (Some(left), None),
        };
        if l.is_some() {
            left += 1;
            left_left -= 1;
        }
        if r.is_some() {
            right += 1;
            right_left -= 1;
        }
        hunk.lines.push(DiffLine { kind, left: l, right: r, raw: line.to_string() });
    }
    hunks
}

fn number(l: &DiffLine, side: DiffSide) -> Option<u32> {
    match side {
        DiffSide::Left => l.left,
        DiffSide::Right => l.right,
    }
}

/// Where `line` on `side` is in the patch: its hunk and its index in that hunk's lines.
fn find(hunks: &[Hunk], line: u32, side: DiffSide) -> Option<(usize, usize)> {
    hunks.iter().enumerate().find_map(|(h, hunk)| hunk.lines.iter().position(|l| number(l, side) == Some(line)).map(|i| (h, i)))
}

/// Whether a review comment may sit at `line` on `side`: the patch shows that line there.
pub fn commentable(patch: &str, line: u32, side: DiffSide) -> bool {
    line > 0 && find(&parse_patch(patch), line, side).is_some()
}

/// The lines of the patch around `line` on `side`, up to `context` either side within its hunk, as the patch has them.
/// `None` when the patch doesn't show that line.
pub fn hunk_around(patch: &str, line: u32, side: DiffSide, context: usize) -> Option<String> {
    let hunks = parse_patch(patch);
    let (h, i) = find(&hunks, line, side)?;
    let lines = &hunks[h].lines;
    let (from, to) = (i.saturating_sub(context), (i + context).min(lines.len() - 1));
    Some(lines[from..=to].iter().map(|l| l.raw.as_str()).collect::<Vec<_>>().join("\n"))
}

/// Whether `path` is a plain relative path inside the repository: no spaces, not absolute, no `..`, not a URL.
pub fn relative_path(path: &str) -> bool {
    !path.is_empty()
        && !path.contains(char::is_whitespace)
        && !path.contains("://")
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.split('/').any(|seg| seg == ".." || seg.is_empty())
}

/// The file and line a finding's `where` names: `path:N`, `path:N-M` (taking N) or `path:N:col`. Anything else, a path
/// with spaces, a URL, an absolute or escaping path, or line 0, names none.
pub fn parse_where(text: &str) -> Option<(String, u32)> {
    let text = text.trim().trim_matches('`').trim();
    if text.contains("://") {
        return None;
    }
    let (path, rest) = text.split_once(':')?;
    let path = path.strip_prefix("./").unwrap_or(path);
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let line = match (rest.split_once('-'), rest.split_once(':')) {
        (Some((n, m)), None) if digits(n) && digits(m) => n,
        (None, Some((n, col))) if digits(n) && digits(col) => n,
        (None, None) if digits(rest) => rest,
        _ => return None,
    };
    let line: u32 = line.parse().ok().filter(|n| *n > 0)?;
    relative_path(path).then(|| (path.to_string(), line))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixtures() -> Value {
        serde_json::from_str(include_str!("../../../src/lib/diffHunks.fixtures.json")).unwrap()
    }

    fn patch<'a>(f: &'a Value, name: &Value) -> &'a str {
        f["patches"][name.as_str().unwrap()].as_str().unwrap()
    }

    fn side(v: &Value) -> DiffSide {
        serde_json::from_value(v.clone()).unwrap()
    }

    #[test]
    fn hunks_parse_as_the_shared_fixtures_say() {
        let f = fixtures();
        for case in f["parse"].as_array().unwrap() {
            let got = parse_patch(patch(&f, &case["patch"]));
            let want = case["hunks"].as_array().unwrap();
            assert_eq!(got.len(), want.len(), "{}", case["patch"]);
            for (h, w) in got.iter().zip(want) {
                let header = [h.left_start, h.left_lines, h.right_start, h.right_lines].map(u64::from);
                let wanted = ["leftStart", "leftLines", "rightStart", "rightLines"].map(|k| w[k].as_u64().unwrap());
                assert_eq!(header, wanted, "{}", case["patch"]);
                let lines: Vec<Value> = h
                    .lines
                    .iter()
                    .map(|l| {
                        let kind = match l.kind {
                            LineKind::Context => "context",
                            LineKind::Added => "added",
                            LineKind::Deleted => "deleted",
                        };
                        serde_json::json!([kind, l.left, l.right])
                    })
                    .collect();
                assert_eq!(Value::Array(lines), w["lines"], "{}", case["patch"]);
            }
        }
    }

    #[test]
    fn commentable_lines_are_the_ones_the_shared_fixtures_say() {
        let f = fixtures();
        for case in f["commentable"].as_array().unwrap() {
            let got = commentable(patch(&f, &case["patch"]), case["line"].as_u64().unwrap() as u32, side(&case["side"]));
            assert_eq!(got, case["expect"].as_bool().unwrap(), "{}", case["name"]);
        }
    }

    #[test]
    fn the_hunk_around_a_line_is_what_the_shared_fixtures_say() {
        let f = fixtures();
        for case in f["hunkAround"].as_array().unwrap() {
            let got = hunk_around(patch(&f, &case["patch"]), case["line"].as_u64().unwrap() as u32, side(&case["side"]), case["context"].as_u64().unwrap() as usize);
            assert_eq!(got.as_deref(), case["expect"].as_str(), "{}", case["name"]);
        }
    }

    #[test]
    fn where_a_finding_points_is_read_as_the_shared_fixtures_say() {
        for case in fixtures()["where"].as_array().unwrap() {
            let got = parse_where(case["text"].as_str().unwrap()).map(|(p, n)| serde_json::json!([p, n]));
            assert_eq!(got.unwrap_or(Value::Null), case["expect"], "{}", case["text"]);
        }
    }
}
