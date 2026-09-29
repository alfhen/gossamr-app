use serde::{Deserialize, Serialize};

use super::PersonRef;

/// Portable rich text. Connector formats (ADF, Markdown) convert to this at the edge.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Doc {
    pub blocks: Vec<Block>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Block {
    Paragraph { content: Vec<Inline> },
    Heading { level: u8, content: Vec<Inline> },
    List { ordered: bool, items: Vec<Vec<Block>> },
    Quote { content: Vec<Block> },
    Code { language: Option<String>, text: String },
    Rule,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Inline {
    Text { text: String, #[serde(default)] marks: Vec<Mark> },
    Link { href: String, text: String },
    Mention { person: PersonRef, name: String },
    LineBreak,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mark {
    Bold,
    Italic,
    Strike,
    Code,
}

impl Doc {
    pub fn paragraph(text: &str) -> Self {
        Doc {
            blocks: vec![Block::Paragraph {
                content: vec![Inline::Text { text: text.into(), marks: vec![] }],
            }],
        }
    }

    /// Plain text as a document: blank lines separate paragraphs, single newlines become line breaks, and `@Name`
    /// for each of `mentions` becomes a mention when it stands as its own token.
    pub fn from_text(text: &str, mentions: &[(PersonRef, String)]) -> Self {
        let mut by_length: Vec<&(PersonRef, String)> = mentions.iter().collect();
        by_length.sort_by_key(|(_, name)| std::cmp::Reverse(name.chars().count()));
        let normalised = text.replace("\r\n", "\n");
        let blocks = normalised
            .trim()
            .split("\n\n")
            .filter(|p| !p.trim().is_empty())
            .map(|p| {
                let mut content = Vec::new();
                for (i, line) in p.lines().enumerate() {
                    if i > 0 {
                        content.push(Inline::LineBreak);
                    }
                    push_line(line, &by_length, &mut content);
                }
                Block::Paragraph { content }
            })
            .collect();
        Doc { blocks }
    }

    pub fn plain_text(&self) -> String {
        let mut out = String::new();
        push_blocks(&self.blocks, &mut out);
        out.trim_end().to_string()
    }
}

fn push_line(line: &str, mentions: &[&(PersonRef, String)], content: &mut Vec<Inline>) {
    let mut plain = String::new();
    let mut rest = line;
    while !rest.is_empty() {
        // `@` starts a token (not `team@Sam`), and the name must end there.
        let starts_token = line[..line.len() - rest.len()].chars().next_back().is_none_or(|c| c.is_whitespace() || "([{\"'".contains(c));
        let hit = rest.strip_prefix('@').filter(|_| starts_token).and_then(|after| {
            mentions.iter().find(|(_, name)| {
                after.starts_with(name.as_str())
                    && after[name.len()..].chars().next().is_none_or(|c| !c.is_alphanumeric() && c != '_')
            })
        });
        match hit {
            Some((person, name)) => {
                if !plain.is_empty() {
                    content.push(Inline::Text { text: std::mem::take(&mut plain), marks: vec![] });
                }
                content.push(Inline::Mention { person: person.clone(), name: name.clone() });
                rest = &rest[1 + name.len()..];
            }
            None => {
                let ch = rest.chars().next().expect("non-empty");
                plain.push(ch);
                rest = &rest[ch.len_utf8()..];
            }
        }
    }
    if !plain.is_empty() {
        content.push(Inline::Text { text: plain, marks: vec![] });
    }
}

fn push_blocks(blocks: &[Block], out: &mut String) {
    for block in blocks {
        match block {
            Block::Paragraph { content } | Block::Heading { content, .. } => {
                push_inlines(content, out);
                out.push('\n');
            }
            Block::List { items, .. } => items.iter().for_each(|i| push_blocks(i, out)),
            Block::Quote { content } => push_blocks(content, out),
            Block::Code { text, .. } => {
                out.push_str(text);
                out.push('\n');
            }
            Block::Rule => {}
        }
    }
}

fn push_inlines(inlines: &[Inline], out: &mut String) {
    for inline in inlines {
        match inline {
            Inline::Text { text, .. } | Inline::Link { text, .. } => out.push_str(text),
            Inline::Mention { name, .. } => {
                out.push('@');
                out.push_str(name);
            }
            Inline::LineBreak => out.push('\n'),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn who(id: &str, name: &str) -> (PersonRef, String) {
        (PersonRef { connection_id: "c".into(), account_id: id.into() }, name.into())
    }

    fn kinds(doc: &Doc) -> Vec<&'static str> {
        let Block::Paragraph { content } = &doc.blocks[0] else { panic!("paragraph expected") };
        content
            .iter()
            .map(|i| match i {
                Inline::Text { .. } => "text",
                Inline::Mention { .. } => "mention",
                Inline::Link { .. } => "link",
                Inline::LineBreak => "break",
            })
            .collect()
    }

    #[test]
    fn from_text_builds_paragraphs_and_breaks() {
        let doc = Doc::from_text("Hello\nthere\n\nSecond", &[]);
        assert_eq!(doc.blocks.len(), 2);
        assert_eq!(kinds(&doc), ["text", "break", "text"]);
        assert_eq!(doc.plain_text(), "Hello\nthere\nSecond");
        assert!(Doc::from_text("  \n\n ", &[]).blocks.is_empty());
        assert_eq!(Doc::from_text("One\r\n\r\nTwo", &[]).blocks.len(), 2, "CRLF blank lines split paragraphs too");
    }

    #[test]
    fn from_text_turns_known_names_into_mentions() {
        let people = [who("a1", "Sam Holt"), who("a2", "Søren Ødegård")];
        let doc = Doc::from_text("@Sam Holt and @Søren Ødegård, not @Sam Holtz or me@x.com", &people);
        let Block::Paragraph { content } = &doc.blocks[0] else { panic!() };
        let ids: Vec<&str> = content
            .iter()
            .filter_map(|i| match i {
                Inline::Mention { person, .. } => Some(person.account_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(ids, ["a1", "a2"]);
        assert_eq!(doc.plain_text(), "@Sam Holt and @Søren Ødegård, not @Sam Holtz or me@x.com");
    }

    #[test]
    fn from_text_only_mentions_whole_tokens() {
        let sam = [who("sam", "Sam Holt")];
        assert_eq!(kinds(&Doc::from_text("(@Sam Holt)", &sam)), ["text", "mention", "text"]);
        assert_eq!(kinds(&Doc::from_text("team@Sam Holt", &sam)), ["text"]);
        assert_eq!(kinds(&Doc::from_text("@Sam Holt_2", &sam)), ["text"]);
    }

    #[test]
    fn plain_text_flattens_nested_blocks() {
        let doc = Doc {
            blocks: vec![
                Block::Heading { level: 2, content: vec![Inline::Text { text: "Title".into(), marks: vec![Mark::Bold] }] },
                Block::List {
                    ordered: false,
                    items: vec![vec![Block::Paragraph {
                        content: vec![
                            Inline::Text { text: "ping ".into(), marks: vec![] },
                            Inline::Mention {
                                person: PersonRef { connection_id: "c".into(), account_id: "a".into() },
                                name: "Ada".into(),
                            },
                        ],
                    }]],
                },
            ],
        };
        assert_eq!(doc.plain_text(), "Title\nping @Ada");
    }
}
