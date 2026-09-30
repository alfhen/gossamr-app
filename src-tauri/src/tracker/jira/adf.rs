//! Conversion between Atlassian Document Format, plain text and the portable `Doc`.

use serde_json::{json, Value};

use crate::domain::{Block, Doc, Inline, Mark, PersonRef};

/// Flattens an ADF document to readable plain text. Mentions become `@Name`.
pub fn to_text(doc: &Value) -> String {
    let mut out = String::new();
    walk(doc, &mut out);
    out.trim().to_string()
}

fn walk(node: &Value, out: &mut String) {
    match node.get("type").and_then(Value::as_str).unwrap_or_default() {
        "text" => out.push_str(node.get("text").and_then(Value::as_str).unwrap_or_default()),
        "mention" => out.push_str(node.pointer("/attrs/text").and_then(Value::as_str).unwrap_or("@someone")),
        "emoji" => out.push_str(node.pointer("/attrs/text").and_then(Value::as_str).unwrap_or_default()),
        "inlineCard" | "blockCard" => out.push_str(node.pointer("/attrs/url").and_then(Value::as_str).unwrap_or_default()),
        "hardBreak" => out.push('\n'),
        "listItem" => {
            out.push_str("• ");
            children(node, out);
            ensure_newline(out);
        }
        "paragraph" | "heading" | "codeBlock" | "blockquote" | "rule" | "panel" | "tableRow" => {
            children(node, out);
            ensure_blank_line(out);
        }
        _ => children(node, out),
    }
}

fn children(node: &Value, out: &mut String) {
    for c in node.get("content").and_then(Value::as_array).into_iter().flatten() {
        walk(c, out);
    }
}

fn ensure_newline(out: &mut String) {
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
}

fn ensure_blank_line(out: &mut String) {
    ensure_newline(out);
    if !out.is_empty() && !out.ends_with("\n\n") {
        out.push('\n');
    }
}

/// People mentioned in the document, with the name as written (without the leading `@`).
pub fn mentioned(doc: &Value) -> Vec<crate::model::Mentioned> {
    let mut out = Vec::new();
    collect_mentioned(doc, &mut out);
    out
}

fn collect_mentioned(node: &Value, out: &mut Vec<crate::model::Mentioned>) {
    if node.get("type").and_then(Value::as_str) == Some("mention") {
        if let (Some(id), Some(text)) = (node.pointer("/attrs/id").and_then(Value::as_str), node.pointer("/attrs/text").and_then(Value::as_str)) {
            if !out.iter().any(|m| m.account_id == id) {
                out.push(crate::model::Mentioned { account_id: id.into(), name: text.trim_start_matches('@').into() });
            }
        }
    }
    for c in node.get("content").and_then(Value::as_array).into_iter().flatten() {
        collect_mentioned(c, out);
    }
}

/// Account ids mentioned anywhere in the document.
pub fn mentions(doc: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    collect_mentions(doc, &mut ids);
    ids
}

fn collect_mentions(node: &Value, ids: &mut Vec<String>) {
    if node.get("type").and_then(Value::as_str) == Some("mention") {
        if let Some(id) = node.pointer("/attrs/id").and_then(Value::as_str) {
            ids.push(id.to_string());
        }
    }
    for c in node.get("content").and_then(Value::as_array).into_iter().flatten() {
        collect_mentions(c, ids);
    }
}

/// Appends uploaded files to a comment: images inline, other files as cards, and files without a media id by name.
/// Jira only displays media inside `mediaSingle` when it has a width and height, so an image without a known size
/// becomes a card instead.
pub fn with_files(mut doc: Value, files: &[crate::model::Uploaded]) -> Value {
    let media = |f: &crate::model::Uploaded, id: &str| {
        json!({ "type": "media", "attrs": { "type": "file", "id": id, "collection": "", "alt": f.filename } })
    };
    let mut cards = Vec::new();
    let content = doc["content"].as_array_mut().expect("from_doc builds a doc with content");
    // Consecutive cards share one group; anything else closes it, so files keep the order they were attached in.
    let flush = |cards: &mut Vec<Value>, content: &mut Vec<Value>| {
        if !cards.is_empty() {
            content.push(json!({ "type": "mediaGroup", "content": std::mem::take(cards) }));
        }
    };
    for f in files {
        match (&f.media_id, f.width.zip(f.height)) {
            (Some(id), Some((width, height))) if f.mime_type.starts_with("image/") => {
                let mut node = media(f, id);
                node["attrs"]["width"] = json!(width);
                node["attrs"]["height"] = json!(height);
                flush(&mut cards, content);
                content.push(json!({ "type": "mediaSingle", "attrs": { "layout": "center" }, "content": [node] }))
            }
            (Some(id), _) => cards.push(media(f, id)),
            (None, _) => {
                flush(&mut cards, content);
                content.push(json!({ "type": "paragraph", "content": [{ "type": "text", "text": format!("📎 {}", f.filename) }] }))
            }
        }
    }
    flush(&mut cards, content);
    doc
}

/// The portable form of an ADF document. Nodes it has no place for (media, tables, panels) keep their text but lose
/// their shape.
pub fn to_doc(doc: &Value, connection_id: &str) -> Doc {
    let mut blocks = Vec::new();
    push_block_children(doc, connection_id, &mut blocks);
    Doc { blocks }
}

fn push_block_children(node: &Value, conn: &str, out: &mut Vec<Block>) {
    for child in node.get("content").and_then(Value::as_array).into_iter().flatten() {
        push_block(child, conn, out);
    }
}

fn push_block(node: &Value, conn: &str, out: &mut Vec<Block>) {
    let inlines = || {
        let mut content = Vec::new();
        for c in node.get("content").and_then(Value::as_array).into_iter().flatten() {
            push_inline(c, conn, &mut content);
        }
        content
    };
    let blocks = || {
        let mut content = Vec::new();
        push_block_children(node, conn, &mut content);
        content
    };
    match node.get("type").and_then(Value::as_str).unwrap_or_default() {
        "paragraph" => out.push(Block::Paragraph { content: inlines() }),
        "heading" => {
            let level = node.pointer("/attrs/level").and_then(Value::as_u64).unwrap_or(1).clamp(1, 6) as u8;
            out.push(Block::Heading { level, content: inlines() });
        }
        kind @ ("bulletList" | "orderedList") => {
            let items = node
                .get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|item| {
                    let mut content = Vec::new();
                    push_block_children(item, conn, &mut content);
                    content
                })
                .collect();
            out.push(Block::List { ordered: kind == "orderedList", items });
        }
        "blockquote" | "panel" => out.push(Block::Quote { content: blocks() }),
        "codeBlock" => {
            let language = node.pointer("/attrs/language").and_then(Value::as_str).filter(|l| !l.is_empty()).map(String::from);
            out.push(Block::Code { language, text: to_text(node) });
        }
        "rule" => out.push(Block::Rule),
        _ => out.extend(blocks()),
    }
}

fn push_inline(node: &Value, conn: &str, out: &mut Vec<Inline>) {
    let attr = |k: &str| node.pointer(&format!("/attrs/{k}")).and_then(Value::as_str);
    match node.get("type").and_then(Value::as_str).unwrap_or_default() {
        "text" => {
            let text = node.get("text").and_then(Value::as_str).unwrap_or_default().to_string();
            let marks = node.get("marks").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
            let href = marks.iter().find(|m| m["type"] == "link").and_then(|m| m.pointer("/attrs/href")).and_then(Value::as_str);
            out.push(match href {
                Some(href) => Inline::Link { href: href.into(), text },
                None => Inline::Text {
                    text,
                    marks: marks
                        .iter()
                        .filter_map(|m| match m["type"].as_str()? {
                            "strong" => Some(Mark::Bold),
                            "em" => Some(Mark::Italic),
                            "strike" => Some(Mark::Strike),
                            "code" => Some(Mark::Code),
                            _ => None,
                        })
                        .collect(),
                },
            });
        }
        "mention" => {
            let name = attr("text").unwrap_or("@someone").trim_start_matches('@').to_string();
            match attr("id") {
                Some(id) => out.push(Inline::Mention { person: PersonRef { connection_id: conn.into(), account_id: id.into() }, name }),
                None => out.push(Inline::Text { text: format!("@{name}"), marks: vec![] }),
            }
        }
        "hardBreak" => out.push(Inline::LineBreak),
        "emoji" => out.push(Inline::Text { text: attr("text").unwrap_or_default().into(), marks: vec![] }),
        "inlineCard" => {
            let url = attr("url").unwrap_or_default();
            out.push(Inline::Link { href: url.into(), text: url.into() });
        }
        _ => {}
    }
}

/// An ADF document for a portable one.
pub fn from_doc(doc: &Doc) -> Value {
    json!({ "type": "doc", "version": 1, "content": doc.blocks.iter().map(block).collect::<Vec<_>>() })
}

fn block(b: &Block) -> Value {
    match b {
        Block::Paragraph { content } => json!({ "type": "paragraph", "content": inlines(content) }),
        Block::Heading { level, content } => json!({ "type": "heading", "attrs": { "level": level }, "content": inlines(content) }),
        Block::List { ordered, items } => json!({
            "type": if *ordered { "orderedList" } else { "bulletList" },
            "content": items.iter().map(|i| json!({ "type": "listItem", "content": i.iter().map(block).collect::<Vec<_>>() })).collect::<Vec<_>>(),
        }),
        Block::Quote { content } => json!({ "type": "blockquote", "content": content.iter().map(block).collect::<Vec<_>>() }),
        Block::Code { language, text } => {
            let mut node = json!({ "type": "codeBlock", "content": if text.is_empty() { vec![] } else { vec![json!({ "type": "text", "text": text })] } });
            if let Some(l) = language {
                node["attrs"] = json!({ "language": l });
            }
            node
        }
        Block::Rule => json!({ "type": "rule" }),
    }
}

/// ADF rejects empty text nodes, so those are dropped.
fn inlines(content: &[Inline]) -> Vec<Value> {
    content
        .iter()
        .filter_map(|i| match i {
            Inline::Text { text, .. } | Inline::Link { text, .. } if text.is_empty() => None,
            Inline::Text { text, marks } => {
                let mut node = json!({ "type": "text", "text": text });
                if !marks.is_empty() {
                    let names = marks.iter().map(|m| {
                        json!({ "type": match m { Mark::Bold => "strong", Mark::Italic => "em", Mark::Strike => "strike", Mark::Code => "code" } })
                    });
                    node["marks"] = Value::Array(names.collect());
                }
                Some(node)
            }
            Inline::Link { href, text } => Some(json!({ "type": "text", "text": text, "marks": [{ "type": "link", "attrs": { "href": href } }] })),
            Inline::Mention { person, name } => Some(json!({ "type": "mention", "attrs": { "id": person.account_id, "text": format!("@{name}") } })),
            Inline::LineBreak => Some(json!({ "type": "hardBreak" })),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc_of(text: &str) -> Value {
        from_doc(&Doc::from_text(text, &[]))
    }

    fn doc() -> Value {
        json!({"type":"doc","version":1,"content":[
            {"type":"paragraph","content":[
                {"type":"mention","attrs":{"id":"acc-1","text":"@Alf Henderson"}},
                {"type":"text","text":" can you check?"}
            ]},
            {"type":"bulletList","content":[
                {"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"one"}]}]},
                {"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"two"}]}]}
            ]}
        ]})
    }

    #[test]
    fn flattens_text_mentions_and_lists() {
        let text = to_text(&doc());
        assert!(text.starts_with("@Alf Henderson can you check?\n\n"));
        assert!(text.contains("• one"));
        assert!(text.contains("• two"));
    }

    #[test]
    fn finds_mentions() {
        assert_eq!(mentions(&doc()), vec!["acc-1".to_string()]);
    }

    #[test]
    fn tolerates_missing_or_odd_nodes() {
        assert_eq!(to_text(&Value::Null), "");
        assert_eq!(to_text(&json!({"type":"doc","content":[{"type":"unknown"}]})), "");
    }

    #[test]
    fn places_images_inline_and_names_files_it_cannot_embed() {
        let file = |name: &str, mime: &str, media: Option<&str>| crate::model::Uploaded {
            id: "1".into(),
            filename: name.into(),
            mime_type: mime.into(),
            media_id: media.map(String::from),
            width: Some(640),
            height: Some(480),
        };
        let doc = with_files(
            doc_of("See attached"),
            &[file("shot.png", "image/png", Some("m1")), file("log.txt", "text/plain", Some("m2")), file("x.pdf", "application/pdf", None)],
        );
        let types: Vec<&str> = doc["content"].as_array().unwrap().iter().map(|n| n["type"].as_str().unwrap()).collect();
        assert_eq!(types, ["paragraph", "mediaSingle", "mediaGroup", "paragraph"], "in the order attached");
        assert_eq!(doc["content"][1]["content"][0]["attrs"]["id"], "m1");
        assert_eq!(doc["content"][2]["content"][0]["attrs"]["id"], "m2");
        assert_eq!(doc["content"][3]["content"][0]["text"], "📎 x.pdf");
        assert_eq!(doc["content"][1]["content"][0]["attrs"]["width"], 640);

        let unsized_image = crate::model::Uploaded { width: None, height: None, ..file("shot.png", "image/png", Some("m1")) };
        let doc = with_files(doc_of(""), &[unsized_image]);
        assert_eq!(doc["content"][0]["type"], "mediaGroup", "an image Jira can't size inline goes in as a card");
    }


    #[test]
    fn a_composed_comment_becomes_the_same_adf_as_before() {
        let who = (PersonRef { connection_id: "c".into(), account_id: "a1".into() }, "Sam Holt".to_string());
        let adf = from_doc(&Doc::from_text("Hi @Sam Holt\nthere\n\nSecond", &[who]));
        assert_eq!(
            adf,
            json!({"type":"doc","version":1,"content":[
                {"type":"paragraph","content":[
                    {"type":"text","text":"Hi "},
                    {"type":"mention","attrs":{"id":"a1","text":"@Sam Holt"}},
                    {"type":"hardBreak"},
                    {"type":"text","text":"there"}
                ]},
                {"type":"paragraph","content":[{"type":"text","text":"Second"}]}
            ]})
        );
        assert_eq!(mentions(&adf), vec!["a1"]);
    }

    #[test]
    fn reads_structure_marks_and_links_into_a_doc() {
        let adf = json!({"type":"doc","content":[
            {"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Plan"}]},
            {"type":"orderedList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[
                {"type":"text","text":"bold","marks":[{"type":"strong"}]},
                {"type":"text","text":" docs","marks":[{"type":"link","attrs":{"href":"https://x.test"}}]}
            ]}]}]},
            {"type":"codeBlock","attrs":{"language":"rust"},"content":[{"type":"text","text":"let a = 1;"}]},
            {"type":"mediaSingle","content":[{"type":"paragraph","content":[{"type":"text","text":"inside"}]}]},
            {"type":"paragraph","content":[{"type":"mention","attrs":{"id":"acc","text":"@Ada"}},{"type":"emoji","attrs":{"text":":)"}}]}
        ]});
        let doc = to_doc(&adf, "conn");
        assert_eq!(doc.blocks.len(), 5);
        assert!(matches!(&doc.blocks[0], Block::Heading { level: 2, .. }));
        let Block::List { ordered: true, items } = &doc.blocks[1] else { panic!("list expected") };
        let Block::Paragraph { content } = &items[0][0] else { panic!() };
        assert_eq!(content[0], Inline::Text { text: "bold".into(), marks: vec![Mark::Bold] });
        assert_eq!(content[1], Inline::Link { href: "https://x.test".into(), text: " docs".into() });
        assert_eq!(doc.blocks[2], Block::Code { language: Some("rust".into()), text: "let a = 1;".into() });
        assert_eq!(doc.blocks[3], Block::Paragraph { content: vec![Inline::Text { text: "inside".into(), marks: vec![] }] });
        let Block::Paragraph { content } = &doc.blocks[4] else { panic!() };
        assert_eq!(content[0], Inline::Mention { person: PersonRef { connection_id: "conn".into(), account_id: "acc".into() }, name: "Ada".into() });
    }

    #[test]
    fn a_doc_survives_a_round_trip_through_adf() {
        let doc = Doc {
            blocks: vec![
                Block::Heading { level: 3, content: vec![Inline::Text { text: "T".into(), marks: vec![Mark::Italic, Mark::Code] }] },
                Block::List { ordered: false, items: vec![vec![Block::Paragraph { content: vec![Inline::Link { href: "https://a.test".into(), text: "a".into() }] }]] },
                Block::Quote { content: vec![Block::Paragraph { content: vec![Inline::Text { text: "q".into(), marks: vec![] }, Inline::LineBreak] }] },
                Block::Code { language: None, text: "x".into() },
                Block::Rule,
            ],
        };
        assert_eq!(to_doc(&from_doc(&doc), "c"), doc);
    }

    #[test]
    fn a_reply_posts_as_a_mention_a_blockquote_and_the_answer() {
        let sam = (PersonRef { connection_id: "c".into(), account_id: "sam".into() }, "Sam".to_string());
        let doc = Doc::from_text("@Sam\n\nAgreed.", &[sam]).with_quote_after_first("Ready for another look");
        let adf = from_doc(&doc);
        let kinds: Vec<_> = adf["content"].as_array().unwrap().iter().map(|n| n["type"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["paragraph", "blockquote", "paragraph"]);
        assert_eq!(adf["content"][0]["content"][0]["type"], "mention");
        assert_eq!(adf["content"][0]["content"][0]["attrs"]["id"], "sam");
        assert_eq!(adf["content"][1]["content"][0]["type"], "paragraph");
        assert_eq!(adf["content"][1]["content"][0]["content"][0]["text"], "Ready for another look");
        assert_eq!(to_doc(&adf, "c"), doc);
    }

    #[test]
    fn empty_text_is_not_sent_to_jira() {
        let doc = Doc { blocks: vec![Block::Paragraph { content: vec![Inline::Text { text: String::new(), marks: vec![] }] }] };
        assert_eq!(from_doc(&doc)["content"][0]["content"], json!([]));
    }
}
