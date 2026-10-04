//! A small Markdown dialect for ticket descriptions: what Pip reads and writes, and what a person edits in the draft.
//!
//! It covers what `Doc` can hold: paragraphs, headings, nested lists, quotes, fenced code and rules, with bold, italic,
//! strike, code, links and mentions inline. A single newline inside a paragraph is a line break, as in `Doc::from_text`.
//! `\` escapes punctuation. Anything else is plain text.

use super::{push_line, Block, Doc, Inline, Mark};
use crate::domain::PersonRef;

type Mentions<'a> = [&'a (PersonRef, String)];

impl Doc {
    pub fn to_markdown(&self) -> String {
        blocks_markdown(&self.blocks)
    }

    /// The document `text` stands for. `@Name` for each of `mentions` becomes a mention. Only http, https and mailto
    /// links are kept as links.
    pub fn from_markdown(text: &str, mentions: &[(PersonRef, String)]) -> Self {
        let mut by_length: Vec<&(PersonRef, String)> = mentions.iter().collect();
        by_length.sort_by_key(|(_, name)| std::cmp::Reverse(name.chars().count()));
        let normalised = text.replace("\r\n", "\n").replace('\r', "\n");
        let lines: Vec<&str> = normalised.lines().collect();
        Doc { blocks: parse_blocks(&lines, &by_length) }
    }

    /// Everyone mentioned in the document, once each.
    pub fn mentioned(&self) -> Vec<(PersonRef, String)> {
        fn walk(blocks: &[Block], out: &mut Vec<(PersonRef, String)>) {
            for b in blocks {
                match b {
                    Block::Paragraph { content } | Block::Heading { content, .. } => {
                        for i in content {
                            if let Inline::Mention { person, name } = i {
                                if !out.iter().any(|(p, _)| p == person) {
                                    out.push((person.clone(), name.clone()));
                                }
                            }
                        }
                    }
                    Block::List { items, .. } => items.iter().for_each(|i| walk(i, out)),
                    Block::Quote { content } => walk(content, out),
                    Block::Code { .. } | Block::Rule => {}
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.blocks, &mut out);
        out
    }
}

fn blocks_markdown(blocks: &[Block]) -> String {
    blocks.iter().map(block_markdown).collect::<Vec<_>>().join("\n\n")
}

fn block_markdown(block: &Block) -> String {
    match block {
        Block::Paragraph { content } => escape_line_starts(&inlines_markdown(content, false)),
        Block::Heading { level, content } => format!("{} {}", "#".repeat(usize::from((*level).clamp(1, 6))), inlines_markdown(content, true)),
        Block::List { ordered, items } => items
            .iter()
            .enumerate()
            .map(|(i, item)| {
                let marker = if *ordered { format!("{}. ", i + 1) } else { "- ".to_string() };
                let inner = blocks_markdown_tight(item);
                let pad = " ".repeat(marker.len());
                inner.lines().enumerate().map(|(n, l)| if n == 0 { format!("{marker}{l}") } else if l.is_empty() { String::new() } else { format!("{pad}{l}") }).collect::<Vec<_>>().join("\n")
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Block::Quote { content } => blocks_markdown(content).lines().map(|l| if l.is_empty() { ">".to_string() } else { format!("> {l}") }).collect::<Vec<_>>().join("\n"),
        Block::Code { language, text } => {
            // The parser closes a block at any line that is only backticks once trimmed, so count them past leading spaces too.
            let longest = text.lines().map(|l| l.trim_start().chars().take_while(|c| *c == '`').count()).max().unwrap_or(0);
            let fence = "`".repeat((longest + 1).max(3));
            format!("{fence}{}\n{text}\n{fence}", language.as_deref().unwrap_or(""))
        }
        Block::Rule => "---".into(),
    }
}

/// An item's blocks one under another, so a nested list sits right below the text it belongs to.
fn blocks_markdown_tight(blocks: &[Block]) -> String {
    let mut out = String::new();
    for (i, b) in blocks.iter().enumerate() {
        if i > 0 {
            out.push_str(if matches!(b, Block::List { .. }) { "\n" } else { "\n\n" });
        }
        out.push_str(&block_markdown(b));
    }
    out
}

fn inlines_markdown(content: &[Inline], single_line: bool) -> String {
    let mut merged: Vec<Inline> = Vec::new();
    for i in content {
        match (merged.last_mut(), i) {
            (Some(Inline::Text { text: a, marks: ma }), Inline::Text { text: b, marks: mb }) if ma == mb => a.push_str(b),
            _ => merged.push(i.clone()),
        }
    }
    let mut out = String::new();
    for i in &merged {
        match i {
            Inline::Text { text, marks } => out.push_str(&marked(text, marks)),
            Inline::Link { href, text } => out.push_str(&format!("[{}]({})", escape(text), href.replace(')', "%29").replace(' ', "%20"))),
            Inline::Mention { name, .. } => {
                out.push('@');
                out.push_str(name);
            }
            Inline::LineBreak => out.push(if single_line { ' ' } else { '\n' }),
        }
    }
    if single_line {
        out.replace('\n', " ")
    } else {
        out
    }
}

fn marked(text: &str, marks: &[Mark]) -> String {
    if marks.contains(&Mark::Code) {
        let longest = text.split(|c| c != '`').map(str::len).max().unwrap_or(0);
        let fence = "`".repeat(longest + 1);
        let pad = if text.starts_with('`') || text.ends_with('`') { " " } else { "" };
        return format!("{fence}{pad}{text}{pad}{fence}");
    }
    let core = text.trim();
    if core.is_empty() {
        return escape(text);
    }
    let lead = &text[..text.len() - text.trim_start().len()];
    let trail = &text[text.trim_end().len()..];
    let mut out = escape(core);
    for (mark, wrap) in [(Mark::Strike, "~~"), (Mark::Italic, "*"), (Mark::Bold, "**")] {
        if marks.contains(&mark) {
            out = format!("{wrap}{out}{wrap}");
        }
    }
    format!("{lead}{out}{trail}")
}

const ESCAPED: &str = "\\*`[]~";

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if ESCAPED.contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Keeps a paragraph line that happens to start like a block from turning into one when read back.
fn escape_line_starts(text: &str) -> String {
    text.split('\n')
        .map(|line| {
            let rest = line.trim_start();
            let lead = &line[..line.len() - rest.len()];
            if is_block_start(rest) {
                let digits = rest.chars().take_while(char::is_ascii_digit).count();
                if digits > 0 {
                    return format!("{lead}{}\\{}", &rest[..digits], &rest[digits..]);
                }
                return format!("{lead}\\{rest}");
            }
            line.to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn is_block_start(line: &str) -> bool {
    heading(line).is_some() || line.starts_with('>') || fence_char(line).is_some() || is_rule(line) || list_marker(line).is_some()
}

/// The character a line opens a fenced code block with: three or more backticks or tildes.
fn fence_char(line: &str) -> Option<char> {
    ['`', '~'].into_iter().find(|c| line.chars().take_while(|x| x == c).count() >= 3)
}

fn heading(line: &str) -> Option<(u8, &str)> {
    let hashes = line.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let rest = &line[hashes..];
    if rest.is_empty() {
        return Some((hashes as u8, ""));
    }
    rest.strip_prefix(' ').map(|t| (hashes as u8, t.trim()))
}

fn is_rule(line: &str) -> bool {
    let t = line.trim();
    t.len() >= 3 && ["-", "*", "_"].iter().any(|m| t.chars().all(|c| m.starts_with(c)))
}

/// `(ordered, width of the marker with its space)` for a line that begins a list item.
fn list_marker(line: &str) -> Option<(bool, usize)> {
    let mut chars = line.chars();
    match chars.next()? {
        '-' | '*' | '+' if chars.next() == Some(' ') => Some((false, 2)),
        c if c.is_ascii_digit() => {
            let digits = line.chars().take_while(char::is_ascii_digit).count();
            let rest = &line[digits..];
            ((rest.starts_with(". ") || rest.starts_with(") ")) && digits <= 9).then_some((true, digits + 2))
        }
        _ => None,
    }
}

/// Leading whitespace in columns, a tab advancing to the next multiple of four.
fn columns_of(line: &str) -> usize {
    let mut columns = 0;
    for c in line.chars() {
        match c {
            ' ' => columns += 1,
            '\t' => columns += 4 - columns % 4,
            _ => break,
        }
    }
    columns
}

fn indent_of(line: &str) -> usize {
    line.chars().take_while(|c| *c == ' ').count()
}

fn parse_blocks(lines: &[&str], mentions: &Mentions) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim_start();
        if trimmed.trim().is_empty() {
            i += 1;
        } else if let Some(mark) = fence_char(trimmed) {
            let ticks = trimmed.chars().take_while(|c| *c == mark).count();
            let language = trimmed[ticks..].trim();
            let mut body = Vec::new();
            i += 1;
            while i < lines.len() {
                let closing = lines[i].trim();
                // A closing fence is indented by at most three spaces; four make it code.
                if columns_of(lines[i]) <= 3 && closing.len() >= ticks && closing.chars().all(|c| c == mark) {
                    i += 1;
                    break;
                }
                body.push(lines[i]);
                i += 1;
            }
            blocks.push(Block::Code { language: (!language.is_empty()).then(|| language.to_string()), text: body.join("\n") });
        } else if let Some((level, text)) = heading(trimmed) {
            blocks.push(Block::Heading { level, content: inlines(text, mentions) });
            i += 1;
        } else if is_rule(trimmed) {
            blocks.push(Block::Rule);
            i += 1;
        } else if trimmed.starts_with('>') {
            let start = i;
            while i < lines.len() && lines[i].trim_start().starts_with('>') {
                i += 1;
            }
            let inner: Vec<&str> = lines[start..i].iter().map(|l| l.trim_start().trim_start_matches('>').strip_prefix(' ').unwrap_or_else(|| l.trim_start().trim_start_matches('>'))).collect();
            blocks.push(Block::Quote { content: parse_blocks(&inner, mentions) });
        } else if let Some((ordered, _)) = list_marker(trimmed) {
            let (list, next) = parse_list(lines, i, ordered, mentions);
            blocks.push(list);
            i = next;
        } else {
            let mut content = Vec::new();
            let mut first = true;
            while i < lines.len() {
                let t = lines[i].trim_start();
                if t.trim().is_empty() || (!first && is_block_start(t)) {
                    break;
                }
                if !first {
                    content.push(Inline::LineBreak);
                }
                content.extend(inlines(lines[i].trim_end(), mentions));
                first = false;
                i += 1;
            }
            blocks.push(Block::Paragraph { content });
        }
    }
    blocks
}

fn parse_list(lines: &[&str], start: usize, ordered: bool, mentions: &Mentions) -> (Block, usize) {
    let base = indent_of(lines[start]);
    let mut items = Vec::new();
    let mut i = start;
    while i < lines.len() {
        let line = lines[i];
        if indent_of(line) != base {
            break;
        }
        let Some((this_ordered, width)) = list_marker(line.trim_start()) else { break };
        if this_ordered != ordered {
            break;
        }
        let mut inner = vec![&line.trim_start()[width..]];
        i += 1;
        while i < lines.len() {
            let next = lines[i];
            if next.trim().is_empty() {
                let more = lines[i + 1..].iter().find(|l| !l.trim().is_empty());
                if more.is_some_and(|l| indent_of(l) >= base + width) {
                    inner.push("");
                    i += 1;
                    continue;
                }
                break;
            }
            if indent_of(next) >= base + width {
                inner.push(&next[(base + width).min(next.len())..]);
                i += 1;
            } else {
                break;
            }
        }
        items.push(parse_blocks(&inner, mentions));
    }
    (Block::List { ordered, items }, i)
}

fn inlines(text: &str, mentions: &Mentions) -> Vec<Inline> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    spans(&chars, &[], mentions, &mut out);
    out
}

fn push_plain(plain: &mut String, marks: &[Mark], mentions: &Mentions, out: &mut Vec<Inline>) {
    if plain.is_empty() {
        return;
    }
    let mut parts = Vec::new();
    push_line(plain, mentions, &mut parts);
    plain.clear();
    out.extend(parts.into_iter().map(|p| match p {
        Inline::Text { text, .. } => Inline::Text { text, marks: marks.to_vec() },
        other => other,
    }));
}

fn find(chars: &[char], from: usize, pat: &[char]) -> Option<usize> {
    let mut i = from;
    while i + pat.len() <= chars.len() {
        if chars[i] == '\\' {
            i += 2;
            continue;
        }
        if chars[i..i + pat.len()] == *pat {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// The marker that closes a span opened before `from`: the opener must be followed, and the closer preceded, by
/// something other than a space, so `a * b * c` stays text.
fn find_closing(chars: &[char], from: usize, pat: &[char]) -> Option<usize> {
    if chars.get(from).is_none_or(|c| c.is_whitespace()) {
        return None;
    }
    let mut at = from;
    loop {
        let end = find(chars, at, pat)?;
        if end > from && !chars[end - 1].is_whitespace() {
            return Some(end);
        }
        at = end + pat.len();
    }
}

fn spans(chars: &[char], marks: &[Mark], mentions: &Mentions, out: &mut Vec<Inline>) {
    let mut plain = String::new();
    let mut i = 0;
    let with = |m: Mark| {
        let mut next = marks.to_vec();
        if !next.contains(&m) {
            next.push(m);
        }
        next
    };
    while i < chars.len() {
        let c = chars[i];
        let rest = &chars[i..];
        if c == '\\' && chars.get(i + 1).is_some_and(|n| n.is_ascii_punctuation()) {
            plain.push(chars[i + 1]);
            i += 2;
        } else if c == '`' {
            let ticks = rest.iter().take_while(|c| **c == '`').count();
            let fence = vec!['`'; ticks];
            match chars[i + ticks..].windows(ticks).position(|w| w == fence.as_slice()).filter(|p| chars.get(i + ticks + p + ticks) != Some(&'`')) {
                Some(p) => {
                    push_plain(&mut plain, marks, mentions, out);
                    let code: String = chars[i + ticks..i + ticks + p].iter().collect();
                    let padded = code.len() >= 3 && code.starts_with(' ') && code.ends_with(' ') && (code[1..].starts_with('`') || code[..code.len() - 1].ends_with('`'));
                    let code = if padded { code[1..code.len() - 1].to_string() } else { code };
                    out.push(Inline::Text { text: code, marks: vec![Mark::Code] });
                    i += ticks + p + ticks;
                }
                None => {
                    plain.extend(std::iter::repeat_n('`', ticks));
                    i += ticks;
                }
            }
        } else if let Some((pat, mark)) = [("**", Mark::Bold), ("~~", Mark::Strike), ("*", Mark::Italic)].into_iter().find(|(p, _)| rest.starts_with(&p.chars().collect::<Vec<_>>())) {
            let pat: Vec<char> = pat.chars().collect();
            match find_closing(chars, i + pat.len(), &pat) {
                Some(end) => {
                    push_plain(&mut plain, marks, mentions, out);
                    spans(&chars[i + pat.len()..end], &with(mark), mentions, out);
                    i = end + pat.len();
                }
                None => {
                    plain.extend(pat.iter());
                    i += pat.len();
                }
            }
        } else if c == '[' {
            match link_at(chars, i) {
                Some((text, href, next)) => {
                    push_plain(&mut plain, marks, mentions, out);
                    out.push(Inline::Link { href, text });
                    i = next;
                }
                None => {
                    plain.push(c);
                    i += 1;
                }
            }
        } else {
            plain.push(c);
            i += 1;
        }
    }
    push_plain(&mut plain, marks, mentions, out);
}

fn link_at(chars: &[char], start: usize) -> Option<(String, String, usize)> {
    let close = find(chars, start + 1, &[']'])?;
    if chars.get(close + 1) != Some(&'(') {
        return None;
    }
    let end = chars[close + 2..].iter().position(|c| *c == ')')? + close + 2;
    let href: String = chars[close + 2..end].iter().collect();
    let href = href.trim().to_string();
    let lower = href.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")) || href.chars().any(char::is_whitespace) {
        return None;
    }
    let label: String = chars[start + 1..close].iter().collect();
    Some((unescape(&label), href, end + 1))
}

fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match (c, chars.peek()) {
            ('\\', Some(n)) if n.is_ascii_punctuation() => out.push(chars.next().unwrap()),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn who(id: &str, name: &str) -> (PersonRef, String) {
        (PersonRef { connection_id: "c".into(), account_id: id.into() }, name.into())
    }

    fn round(text: &str) -> String {
        Doc::from_markdown(text, &[]).to_markdown()
    }

    #[test]
    fn structure_survives_a_round_trip() {
        let text = "# Scope\n\nFirst **bold** and *italic* and ~~gone~~ and `code`.\nSecond line.\n\n- one\n- two\n  - nested\n\n1. step\n2. step two\n\n> quoted\n> text\n\n```rust\nlet x = 1;\n```\n\n---\n\n[docs](https://example.com/a)";
        assert_eq!(round(text), text);
    }

    #[test]
    fn a_document_reads_back_as_itself() {
        let doc = Doc {
            blocks: vec![
                Block::Heading { level: 2, content: vec![Inline::Text { text: "Plan".into(), marks: vec![] }] },
                Block::Paragraph {
                    content: vec![
                        Inline::Text { text: "Do ".into(), marks: vec![] },
                        Inline::Text { text: "this".into(), marks: vec![Mark::Bold] },
                        Inline::LineBreak,
                        Inline::Link { href: "https://a.test/x".into(), text: "link".into() },
                    ],
                },
                Block::List { ordered: false, items: vec![vec![Block::Paragraph { content: vec![Inline::Text { text: "a".into(), marks: vec![] }] }], vec![Block::Paragraph { content: vec![Inline::Text { text: "b".into(), marks: vec![] }] }]] },
                Block::Code { language: None, text: "x\n\ny".into() },
            ],
        };
        assert_eq!(Doc::from_markdown(&doc.to_markdown(), &[]), doc);
    }

    #[test]
    fn punctuation_in_plain_text_is_escaped_and_comes_back() {
        let doc = Doc::paragraph("2 * 3 = 6, a[0], ~tilde, `tick` and C:\\dir");
        let md = doc.to_markdown();
        assert!(md.contains("2 \\* 3"), "{md}");
        assert_eq!(Doc::from_markdown(&md, &[]).plain_text(), doc.plain_text());
    }

    #[test]
    fn a_line_that_looks_like_a_block_stays_a_paragraph() {
        for text in ["# not a heading", "- not a list", "1. not a list", "> not a quote", "---", "```"] {
            let md = Doc::paragraph(text).to_markdown();
            let back = Doc::from_markdown(&md, &[]);
            assert!(matches!(back.blocks.as_slice(), [Block::Paragraph { .. }]), "{text}: {md:?} -> {back:?}");
            assert_eq!(back.plain_text(), text);
        }
    }

    #[test]
    fn lists_need_no_blank_line_before_them() {
        let doc = Doc::from_markdown("Steps:\n- a\n- b\nAfter", &[]);
        assert!(matches!(doc.blocks[0], Block::Paragraph { .. }));
        assert!(matches!(&doc.blocks[1], Block::List { ordered: false, items } if items.len() == 2));
    }

    #[test]
    fn mentions_and_marks_round_trip() {
        let people = [who("a1", "Sam Holt")];
        let doc = Doc::from_markdown("Ask @Sam Holt about **the thing**, and @Sam Holt again", &people);
        let Block::Paragraph { content } = &doc.blocks[0] else { panic!() };
        assert_eq!(content.iter().filter(|i| matches!(i, Inline::Mention { .. })).count(), 2);
        assert_eq!(doc.mentioned(), vec![people[0].clone()]);
        assert_eq!(Doc::from_markdown(&doc.to_markdown(), &people), doc);
    }

    #[test]
    fn only_web_and_mail_links_are_kept() {
        let doc = Doc::from_markdown("[x](javascript:alert(1)) [y](https://ok.test) [z](mailto:a@b.test)", &[]);
        let Block::Paragraph { content } = &doc.blocks[0] else { panic!() };
        assert_eq!(content.iter().filter(|i| matches!(i, Inline::Link { .. })).count(), 2);
        assert!(doc.plain_text().contains("[x](javascript:alert(1)"));
    }

    #[test]
    fn unclosed_markers_stay_literal() {
        assert_eq!(Doc::from_markdown("a **b and *c", &[]).plain_text(), "a **b and *c");
        assert_eq!(Doc::from_markdown("`open", &[]).plain_text(), "`open");
    }

    #[test]
    fn crlf_and_blank_runs_are_tolerated_and_empty_text_is_an_empty_document() {
        assert_eq!(Doc::from_markdown("a\r\n\r\n\r\nb", &[]).blocks.len(), 2);
        assert!(Doc::from_markdown(" \n\n ", &[]).blocks.is_empty());
    }

    #[test]
    fn code_that_contains_fences_gets_a_longer_one() {
        let doc = Doc { blocks: vec![Block::Code { language: None, text: "```\ninner\n```".into() }] };
        let md = doc.to_markdown();
        assert!(md.starts_with("````"), "{md}");
        assert_eq!(Doc::from_markdown(&md, &[]), doc);
    }

    #[test]
    fn code_with_indented_or_longer_backtick_lines_survives_a_round_trip() {
        for text in ["  ```", "    `````", "```\nx", "a\n  ````\nb", "~~~", "  ~~~~\n```\n``` js", "trailing  \n```   "] {
            let doc = Doc { blocks: vec![Block::Code { language: Some("rust".into()), text: text.into() }, Block::Paragraph { content: vec![Inline::Text { text: "after".into(), marks: vec![] }] }] };
            let md = doc.to_markdown();
            assert_eq!(Doc::from_markdown(&md, &[]), doc, "{text:?} -> {md:?}");
        }
    }

    #[test]
    fn code_inside_a_list_item_keeps_its_backtick_lines() {
        let doc = Doc { blocks: vec![Block::List { ordered: false, items: vec![vec![Block::Code { language: None, text: "  ```\nend".into() }]] }] };
        assert_eq!(Doc::from_markdown(&doc.to_markdown(), &[]), doc, "{}", doc.to_markdown());
    }

    #[test]
    fn tilde_fences_open_and_close_a_code_block_and_do_not_close_a_backtick_one() {
        let doc = Doc::from_markdown("~~~sh\nls\n```\n~~~\n\nafter", &[]);
        assert_eq!(doc.blocks[0], Block::Code { language: Some("sh".into()), text: "ls\n```".into() });
        assert_eq!(doc.blocks.len(), 2);
        let mixed = Doc::from_markdown("```\n~~~\n```", &[]);
        assert_eq!(mixed.blocks, vec![Block::Code { language: None, text: "~~~".into() }]);
    }

    #[test]
    fn a_fence_indented_four_spaces_does_not_close_the_block() {
        for mark in ["~~~", "```"] {
            let doc = Doc::from_markdown(&format!("{mark}\n    {mark}\nstill code\n{mark}\n\nafter"), &[]);
            assert_eq!(doc.blocks[0], Block::Code { language: None, text: format!("    {mark}\nstill code") }, "{mark}");
            assert_eq!(doc.blocks.len(), 2, "{mark}");
        }
        let three = Doc::from_markdown("~~~\ncode\n   ~~~\nafter", &[]);
        assert_eq!((three.blocks.len(), &three.blocks[0]), (2, &Block::Code { language: None, text: "code".into() }));
    }

    #[test]
    fn a_tab_counts_to_the_next_multiple_of_four_columns_so_a_tab_indented_fence_does_not_close() {
        for mark in ["~~~", "```"] {
            for lead in ["\t", " \t", "  \t", "   \t", "\t\t"] {
                let doc = Doc::from_markdown(&format!("{mark}\n{lead}{mark}\nstill code\n{mark}\n\nafter"), &[]);
                assert_eq!(doc.blocks[0], Block::Code { language: None, text: format!("{lead}{mark}\nstill code") }, "{mark} {lead:?}");
                assert_eq!(doc.blocks.len(), 2, "{mark} {lead:?}");
            }
            let closes = Doc::from_markdown(&format!("{mark}\ncode\n   {mark}\nafter"), &[]);
            assert_eq!(closes.blocks[0], Block::Code { language: None, text: "code".into() }, "{mark}");
            assert_eq!(closes.blocks.len(), 2);
        }
        assert_eq!(columns_of("\t x"), 5);
        assert_eq!(columns_of("  \t\tx"), 8);
    }

    #[test]
    fn a_list_item_with_two_paragraphs_keeps_both() {
        let text = "- first\n\n  more of first\n- second";
        let doc = Doc::from_markdown(text, &[]);
        let Block::List { items, .. } = &doc.blocks[0] else { panic!() };
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].len(), 2);
    }
}
