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

    pub fn plain_text(&self) -> String {
        let mut out = String::new();
        push_blocks(&self.blocks, &mut out);
        out.trim_end().to_string()
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
