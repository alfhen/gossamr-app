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

/// Builds an ADF document from plain text: blank lines separate paragraphs, single newlines become hard breaks.
pub fn from_text(text: &str) -> Value {
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
                if !line.is_empty() {
                    content.push(json!({ "type": "text", "text": line }));
                }
            }
            json!({ "type": "paragraph", "content": content })
        })
        .collect();
    json!({ "type": "doc", "version": 1, "content": paragraphs })
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
        let adf = from_text("Hello\nthere\n\nSecond");
        assert_eq!(adf["content"].as_array().unwrap().len(), 2);
        assert_eq!(adf["content"][0]["content"][1]["type"], "hardBreak");
        assert_eq!(to_text(&adf), "Hello\nthere\n\nSecond");
    }

    #[test]
    fn tolerates_missing_or_odd_nodes() {
        assert_eq!(to_text(&Value::Null), "");
        assert_eq!(to_text(&json!({"type":"doc","content":[{"type":"unknown"}]})), "");
    }
}
