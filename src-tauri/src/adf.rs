//! Conversion between Atlassian Document Format and plain text.

use serde_json::{json, Value};

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

/// Someone to @mention: `@{name}` in the text becomes a mention node for `account_id`.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MentionRef {
    pub account_id: String,
    pub name: String,
}

/// Builds an ADF document from plain text: blank lines separate paragraphs, single newlines become hard breaks, and
/// `@Name` for each of `mentions` becomes a real mention, so Jira notifies that person.
pub fn from_text(text: &str, mentions: &[MentionRef]) -> Value {
    let mut by_length: Vec<&MentionRef> = mentions.iter().collect();
    by_length.sort_by_key(|m| std::cmp::Reverse(m.name.chars().count()));
    let paragraphs: Vec<Value> = text
        .trim()
        .split("\n\n")
        .filter(|p| !p.trim().is_empty())
        .map(|p| {
            let mut content = Vec::new();
            for (i, line) in p.lines().enumerate() {
                if i > 0 {
                    content.push(json!({ "type": "hardBreak" }));
                }
                push_line(line, &by_length, &mut content);
            }
            json!({ "type": "paragraph", "content": content })
        })
        .collect();
    json!({ "type": "doc", "version": 1, "content": paragraphs })
}

/// Appends uploaded files to a comment: images inline, other files as cards, and files without a media id by name.
/// Jira only displays media inside `mediaSingle` when it has a width and height, so an image without a known size
/// becomes a card instead.
pub fn with_files(mut doc: Value, files: &[crate::model::Uploaded]) -> Value {
    let media = |f: &crate::model::Uploaded, id: &str| {
        json!({ "type": "media", "attrs": { "type": "file", "id": id, "collection": "", "alt": f.filename } })
    };
    let mut cards = Vec::new();
    let content = doc["content"].as_array_mut().expect("from_text builds a doc with content");
    for f in files {
        match (&f.media_id, f.width.zip(f.height)) {
            (Some(id), Some((width, height))) if f.mime_type.starts_with("image/") => {
                let mut node = media(f, id);
                node["attrs"]["width"] = json!(width);
                node["attrs"]["height"] = json!(height);
                content.push(json!({ "type": "mediaSingle", "attrs": { "layout": "center" }, "content": [node] }))
            }
            (Some(id), _) => cards.push(media(f, id)),
            (None, _) => content.push(json!({ "type": "paragraph", "content": [{ "type": "text", "text": format!("📎 {}", f.filename) }] })),
        }
    }
    if !cards.is_empty() {
        content.push(json!({ "type": "mediaGroup", "content": cards }));
    }
    doc
}

fn push_line(line: &str, mentions: &[&MentionRef], content: &mut Vec<Value>) {
    let mut plain = String::new();
    let mut rest = line;
    while !rest.is_empty() {
        // Same rules as the composer's highlighting: `@` starts a token (not `team@Sam`), and the name must end there.
        let starts_token = line[..line.len() - rest.len()].chars().next_back().is_none_or(|c| c.is_whitespace() || "([{\"'".contains(c));
        let hit = rest.strip_prefix('@').filter(|_| starts_token).and_then(|after| {
            mentions.iter().find(|m| {
                after.starts_with(m.name.as_str())
                    && after[m.name.len()..].chars().next().is_none_or(|c| !c.is_alphanumeric() && c != '_')
            })
        });
        match hit {
            Some(m) => {
                if !plain.is_empty() {
                    content.push(json!({ "type": "text", "text": std::mem::take(&mut plain) }));
                }
                content.push(json!({ "type": "mention", "attrs": { "id": m.account_id, "text": format!("@{}", m.name) } }));
                rest = &rest[1 + m.name.len()..];
            }
            None => {
                let ch = rest.chars().next().expect("non-empty");
                plain.push(ch);
                rest = &rest[ch.len_utf8()..];
            }
        }
    }
    if !plain.is_empty() {
        content.push(json!({ "type": "text", "text": plain }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn builds_paragraphs_and_breaks_from_text() {
        let adf = from_text("Hello\nthere\n\nSecond", &[]);
        assert_eq!(adf["content"].as_array().unwrap().len(), 2);
        assert_eq!(adf["content"][0]["content"][1]["type"], "hardBreak");
        assert_eq!(to_text(&adf), "Hello\nthere\n\nSecond");
    }

    #[test]
    fn turns_known_names_into_mention_nodes() {
        let people = [
            MentionRef { account_id: "a1".into(), name: "Sam Holt".into() },
            MentionRef { account_id: "a2".into(), name: "Søren Ødegård".into() },
        ];
        let adf = from_text("@Sam Holt and @Søren Ødegård, not @Sam Holtz or me@x.com", &people);
        let nodes = adf["content"][0]["content"].as_array().unwrap();
        let mentions: Vec<&str> = nodes.iter().filter(|n| n["type"] == "mention").map(|n| n["attrs"]["id"].as_str().unwrap()).collect();
        assert_eq!(mentions, vec!["a1", "a2"]);
        assert_eq!(super::mentions(&adf), vec!["a1", "a2"]);
        assert_eq!(mentioned(&adf)[1].name, "Søren Ødegård");
        assert_eq!(to_text(&adf), "@Sam Holt and @Søren Ødegård, not @Sam Holtz or me@x.com");
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
            from_text("See attached", &[]),
            &[file("shot.png", "image/png", Some("m1")), file("log.txt", "text/plain", Some("m2")), file("x.pdf", "application/pdf", None)],
        );
        let types: Vec<&str> = doc["content"].as_array().unwrap().iter().map(|n| n["type"].as_str().unwrap()).collect();
        assert_eq!(types, ["paragraph", "mediaSingle", "paragraph", "mediaGroup"]);
        assert_eq!(doc["content"][1]["content"][0]["attrs"]["id"], "m1");
        assert_eq!(doc["content"][2]["content"][0]["text"], "📎 x.pdf");
        assert_eq!(doc["content"][3]["content"][0]["attrs"]["id"], "m2");
        assert_eq!(doc["content"][1]["content"][0]["attrs"]["width"], 640);

        let unsized_image = crate::model::Uploaded { width: None, height: None, ..file("shot.png", "image/png", Some("m1")) };
        let doc = with_files(from_text("", &[]), &[unsized_image]);
        assert_eq!(doc["content"][0]["type"], "mediaGroup", "an image Jira can't size inline goes in as a card");
    }

    #[test]
    fn only_mentions_whole_tokens() {
        let sam = [MentionRef { account_id: "sam".into(), name: "Sam Holt".into() }];
        let kinds = |text: &str| -> Vec<String> {
            from_text(text, &sam)["content"][0]["content"].as_array().unwrap().iter().map(|n| n["type"].as_str().unwrap().to_string()).collect()
        };
        assert_eq!(kinds("(@Sam Holt)"), ["text", "mention", "text"]);
        assert_eq!(kinds("team@Sam Holt"), ["text"]);
        assert_eq!(kinds("@Sam Holt_2"), ["text"]);
    }
}
