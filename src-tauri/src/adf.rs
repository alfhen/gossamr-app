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

fn push_line(line: &str, mentions: &[&MentionRef], content: &mut Vec<Value>) {
    let mut plain = String::new();
    let mut rest = line;
    while !rest.is_empty() {
        let hit = rest.strip_prefix('@').and_then(|after| {
            mentions.iter().find(|m| {
                after.starts_with(m.name.as_str())
                    && after[m.name.len()..].chars().next().is_none_or(|c| !c.is_alphanumeric())
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
}
