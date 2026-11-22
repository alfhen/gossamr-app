//! Redaction. A line is redacted before it is written; a whole file is redacted again when the run ends,
//! because a streamed value (a path, a name) can be split across several deltas that no single line shows.

use regex::Regex;
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub struct Redactor {
    literals: Vec<(String, String)>,
    patterns: Vec<(Regex, &'static str)>,
    keys: Regex,
    account: Regex,
}

/// The spike's own names: MCP servers it starts and agents it defines. Everything else in an inventory list is the
/// person's own setup and is counted, not kept.
const OWN: [&str; 6] = [
    "spike",
    "gossamr",
    "projspike",
    "limited",
    "reader",
    "locked",
];
/// Agent types every Claude Code install has.
const BUILTIN_AGENTS: [&str; 7] = [
    "claude",
    "Explore",
    "general-purpose",
    "Plan",
    "statusline-setup",
    "web-fetch",
    "claude-code-guide",
];

impl Redactor {
    /// `env_names` are variables whose values are secrets for this run (the MCP token).
    pub fn new(env_names: &[String]) -> Self {
        let mut literals = Vec::new();
        for name in env_names {
            if let Ok(v) = std::env::var(name)
                && v.len() >= 8
            {
                literals.push((v, format!("<redacted:{name}>")));
            }
        }
        // Secret-looking values in the driver's own environment, whatever their name.
        for (k, v) in std::env::vars() {
            let k_up = k.to_uppercase();
            if v.len() >= 8
                && [
                    "TOKEN", "SECRET", "KEY", "UUID", "EMAIL", "PASSWORD", "AUTH",
                ]
                .iter()
                .any(|w| k_up.contains(w))
            {
                literals.push((v, format!("<redacted:{k}>")));
            }
        }
        // The scratch root and the home folder carry the user name; the scratch root first, it is longer.
        if let Ok(s) = std::env::var("SPIKE_SCRATCH") {
            if let Ok(real) = std::fs::canonicalize(&s) {
                literals.push((real.to_string_lossy().into_owned(), "$SCRATCH".into()));
            }
            literals.push((s, "$SCRATCH".into()));
        }
        if let Ok(h) = std::env::var("HOME") {
            literals.push((h, "$HOME".into()));
        }
        // Words the person wants masked (an employer, a client), comma-separated; never committed.
        for w in std::env::var("SPIKE_REDACT_WORDS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|w| w.len() >= 3)
        {
            literals.push((w.to_string(), "<masked>".into()));
            literals.push((w.to_lowercase(), "<masked>".into()));
        }
        // The host name often carries the person's name.
        if let Ok(o) = std::process::Command::new("hostname").output() {
            let h = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if h.len() >= 3 {
                literals.push((h.trim_end_matches(".local").to_string(), "<host>".into()));
            }
        }
        // The git user name (a signing key's comment and commit authors carry it).
        if let Ok(o) = std::process::Command::new("git")
            .args(["config", "--global", "user.name"])
            .output()
        {
            let n = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if n.len() >= 3 {
                literals.push((n, "<git-user>".into()));
            }
        }
        if let Ok(u) = std::env::var("USER")
            && u.len() >= 3
        {
            literals.push((u, "<user>".into()));
        }
        let p = |re: &str, rep: &'static str| (Regex::new(re).unwrap(), rep);
        let patterns = vec![
            p(r"sk-ant-[A-Za-z0-9_\-]{8,}", "<redacted:sk-ant>"),
            p(r"\bsk-[A-Za-z0-9_\-]{20,}", "<redacted:sk>"),
            p(
                r"eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+",
                "<redacted:jwt>",
            ),
            p(r"ya29\.[A-Za-z0-9_\-\.]+", "<redacted:google>"),
            p(r"1//[A-Za-z0-9_\-]{20,}", "<redacted:google-refresh>"),
            p(r"gsr_[0-9a-f]{48}", "<redacted:gsr>"),
            p(
                r"(ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-[a-z0-9]+|sk-ssh-[a-z0-9@.]+) [A-Za-z0-9+/=]{16,}( [^\s\\]+)*",
                "$1 <key>",
            ),
            p(r"spk_[0-9a-f]{16,}", "<redacted:spk>"),
            p(r"(?i)bearer\s+[A-Za-z0-9._\-]{8,}", "Bearer <redacted>"),
            p(
                r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}",
                "<email>",
            ),
            // The person's own folder layout under the home folder (dot folders such as .claude stay), as a path
            // and in the dashed form Claude uses for project folder names.
            p(
                r#"\$HOME/(?:<path>|[^.<\s"'\\)\]>`])[^\s"'\\)\]>`]*"#,
                "$$HOME/<path>",
            ),
            // `<user>` and `<path>` are what the per-line pass left; a joined run can carry more path after them.
            p(
                r#"/Users/(?:<user>|<path>|[^<\s"'\\)\]>`])[^\s"'\\)\]>`]*"#,
                "/Users/<path>",
            ),
            p(
                r#"-Users-(?:<user>|<path>|[^<\s"'/\\)\]>`])[^\s"'/\\)\]>`]*"#,
                "-Users-<path>",
            ),
            // Plan names in labels.
            p(
                r"\b(ChatGPT|Claude|Google AI) (Plus|Pro|Max|Ultra|Team|Business|Enterprise|Edu|Free|Go)\b",
                "$1 <plan>",
            ),
            // The person's claude.ai connectors and the tools they bring.
            // `<` and `>` too: the word list may already have put `<masked>` inside the name.
            p(r"mcp__claude_ai_[A-Za-z0-9_\-<>]+", "mcp__<connector>"),
            // The numeric user id in the temp folder's name.
            p(r"\bclaude-[0-9]{2,}\b", "claude-<uid>"),
            // The rest of a scratch path that an earlier pass cut after `-Users-<path>` (a run split across deltas).
            p(
                r#"(?:(?:/private)?/tmp/claude-<uid>/-Users-<path>|\$SCRATCH/<path>)[^\s"'\\)\]>`]*"#,
                "$$SCRATCH/<path>",
            ),
            p(r"claude\.ai [A-Z][A-Za-z0-9 <>]+", "claude.ai <connector>"),
        ];
        let keys = Regex::new(r"(?i)^(email|e_mail|emailaddress|account_?uuid|account_?id|chatgpt_?account_?id|installation_?id|org(anization)?(_?(id|uuid|name))?|user_?id|access_?token|refresh_?token|id_?token|api_?key)$").unwrap();
        // Subscription, plan, rate-limit and overage details, whatever their type.
        let account = Regex::new(r"(?i)(^|[/_.])(subscription\w*|plan_?type|chatgpt_?plan_?type|tier|rate_?limit\w*|overage\w*|is_?using_?overage|utilization|unified_?windows|credits?\w*|upgrade_?uri)$").unwrap();
        Redactor {
            literals,
            patterns,
            keys,
            account,
        }
    }

    pub fn text(&self, s: &str) -> String {
        let mut out = s.to_string();
        for (lit, rep) in &self.literals {
            out = out.replace(lit.as_str(), rep);
        }
        for (re, rep) in &self.patterns {
            out = re.replace_all(&out, *rep).into_owned();
        }
        out
    }

    pub fn value(&self, v: &Value) -> Value {
        match v {
            Value::String(s) => Value::String(self.text(s)),
            Value::Array(a) => Value::Array(a.iter().map(|x| self.value(x)).collect()),
            Value::Object(o) => Value::Object(
                o.iter()
                    .map(|(k, x)| {
                        let secret = self.keys.is_match(k)
                            && !matches!(
                                x,
                                Value::Null | Value::Bool(_) | Value::Object(_) | Value::Array(_)
                            );
                        // Booleans too (`isUsingOverage`), except `tier: true`, which is a capability flag.
                        let account = (self.account.is_match(k)
                            && !(k == "tier" && x.is_boolean()))
                            || (k == "plan" && x.is_string());
                        let out = if secret || account {
                            Value::String("<redacted>".into())
                        } else if let Some(trimmed) = trim_inventory(k, x) {
                            self.value(&trimmed)
                        } else {
                            self.value(x)
                        };
                        (self.text(k), out)
                    })
                    .collect(),
            ),
            other => other.clone(),
        }
    }
}

fn entry_name(v: &Value) -> Option<&str> {
    v.as_str().or_else(|| v.get("name").and_then(Value::as_str))
}

fn is_own(name: &str) -> bool {
    // Check servers the spike names per session start with `spk` (letters and digits only, so no prefix of theirs
    // can be a person's server joined with an underscore).
    name.starts_with("spk")
        || name.starts_with("mcp__spk")
        || name.starts_with("mcp_spk")
        || OWN.iter().any(|o| {
            name == *o
                || name.contains(&format!("mcp__{o}__"))
                || name.contains(&format!("mcp_{o}_"))
        })
}

/// The person's tools, connectors, plugins, skills and MCP servers, as listed by `init` and its kin, cut down to
/// the spike's own entries and what every install has, with a count of the rest.
fn trim_inventory(key: &str, v: &Value) -> Option<Value> {
    let list = v.as_array()?;
    let keep: fn(&str) -> bool = match key {
        // Built-in tool names have no `__`; MCP tools do, and only the spike's own stay.
        "tools" => |n| !n.contains("__") || is_own(n),
        "mcp_servers" | "mcpServers" => is_own,
        "plugins" => |n| n.starts_with("agent-pr-pipeline") || n.starts_with("cc-plugin-"),
        "skills" | "slash_commands" | "commands" | "availableCommands" => {
            |n| n.starts_with("agent-pr-pipeline")
        }
        // codex app-server mcpServerStatus/list: one entry per MCP server, each with its tools.
        "data" if list.iter().all(|e| e.get("tools").is_some()) => is_own,
        "agents" => {
            |n| n.starts_with("agent-pr-pipeline") || BUILTIN_AGENTS.contains(&n) || is_own(n)
        }
        _ => return None,
    };
    if !list.iter().all(|e| entry_name(e).is_some()) {
        return None;
    }
    let kept: Vec<Value> = list
        .iter()
        .filter(|e| keep(entry_name(e).unwrap()))
        .cloned()
        .collect();
    let removed = list.len() - kept.len();
    let mut out = kept;
    if removed > 0 {
        let note = format!("<{removed} of the person's own removed>");
        out.push(if list.iter().any(Value::is_string) {
            json!(note)
        } else {
            json!({ "name": note })
        });
    }
    Some(Value::Array(out))
}

/// Where a streamed fragment sits in one transcript line, and which run it belongs to.
fn fragment(data: &Value, msg: u64, turn: u64) -> Option<(String, Vec<&'static str>)> {
    // Claude stream-json: content_block_delta, one run per message and block.
    if data["type"] == "stream_event" && data["event"]["type"] == "content_block_delta" {
        for f in ["text", "partial_json", "thinking"] {
            if data["event"]["delta"][f].is_string() {
                let key = format!("claude:{msg}:{}:{f}", data["event"]["index"]);
                return Some((key, vec!["event", "delta", f]));
            }
        }
    }
    // ACP: *_chunk updates, one run per session, kind and prompt.
    if data["method"] == "session/update" {
        let u = &data["params"]["update"];
        if u["sessionUpdate"]
            .as_str()
            .is_some_and(|k| k.ends_with("_chunk"))
            && u["content"]["text"].is_string()
        {
            let key = format!(
                "acp:{}:{}:{turn}",
                data["params"]["sessionId"], u["sessionUpdate"]
            );
            return Some((key, vec!["params", "update", "content", "text"]));
        }
    }
    // codex app-server: any *delta notification, one run per method and item.
    if data["method"]
        .as_str()
        .is_some_and(|m| m.to_lowercase().ends_with("delta"))
        && data["params"]["delta"].is_string()
    {
        let key = format!("codex:{}:{}", data["method"], data["params"]["itemId"]);
        return Some((key, vec!["params", "delta"]));
    }
    // agy stream-json: step_update text_delta, one run per conversation and step.
    if data["event"] == "step_update" && data["step_update"]["text_delta"].is_string() {
        let s = &data["step_update"];
        let key = format!("agy:{}:{}", s["conversation_id"], s["step_index"]);
        return Some((key, vec!["step_update", "text_delta"]));
    }
    None
}

fn get_mut<'a>(v: &'a mut Value, path: &[&str]) -> Option<&'a mut Value> {
    path.iter().try_fold(v, |v, p| v.get_mut(*p))
}

/// Byte spans of `joined` that redaction would change, each with its replacement, earliest first, not overlapping.
fn spans(r: &Redactor, joined: &str) -> Vec<(usize, usize, String)> {
    let mut found: Vec<(usize, usize, String)> = Vec::new();
    for (lit, rep) in &r.literals {
        for (i, _) in joined.match_indices(lit.as_str()) {
            found.push((i, i + lit.len(), rep.clone()));
        }
    }
    for (re, rep) in &r.patterns {
        for m in re.find_iter(joined) {
            found.push((
                m.start(),
                m.end(),
                re.replace(m.as_str(), *rep).into_owned(),
            ));
        }
    }
    found.sort_by_key(|(s, e, _)| (*s, std::cmp::Reverse(*e)));
    let mut out: Vec<(usize, usize, String)> = Vec::new();
    for f in found {
        match out.last_mut() {
            // An overlapping match widens the last span; its text is redacted again as a whole below.
            Some(last) if f.0 < last.1 => last.1 = last.1.max(f.1),
            _ => out.push(f),
        }
    }
    for s in &mut out {
        s.2 = r.text(&joined[s.0..s.1]);
    }
    out
}

/// Redacts a run of fragments as one text and splits it back: a replacement goes where its match starts, and the
/// rest of the match is dropped from the fragments it spanned.
pub fn redact_run(r: &Redactor, parts: &[String]) -> Vec<String> {
    let joined: String = parts.concat();
    let spans = spans(r, &joined);
    let mut out = Vec::with_capacity(parts.len());
    let mut offset = 0;
    for p in parts {
        let (start, end) = (offset, offset + p.len());
        let mut s = String::new();
        let mut i = start;
        while i < end {
            if let Some((a, b, rep)) = spans.iter().find(|(a, b, _)| *a <= i && i < *b) {
                // A match that began in an earlier fragment left its replacement there.
                if *a == i {
                    s.push_str(rep);
                }
                i = (*b).min(end);
            } else {
                let next = spans
                    .iter()
                    .map(|(a, _, _)| *a)
                    .filter(|a| *a > i)
                    .min()
                    .unwrap_or(end)
                    .min(end);
                s.push_str(&joined[i..next]);
                i = next;
            }
        }
        out.push(s);
        offset = end;
    }
    out
}

/// Redacts a whole transcript: every line, then every streamed run joined.
pub fn redact_lines(r: &Redactor, lines: Vec<Value>) -> Vec<Value> {
    // Streamed runs first, on the text as it came: a value split across deltas (a scratch path) is whole only there,
    // and the per-line pass would break it up before the run could match it.
    let mut lines = lines;
    let (mut msg, mut turn) = (0u64, 0u64);
    let mut runs: BTreeMap<String, Vec<(usize, Vec<&'static str>)>> = BTreeMap::new();
    for (i, l) in lines.iter().enumerate() {
        let data = &l["data"];
        if data["type"] == "stream_event" && data["event"]["type"] == "message_start" {
            msg += 1;
        }
        if l["dir"] == "to_agent" && data["method"] == "session/prompt" {
            turn += 1;
        }
        if let Some((key, path)) = fragment(data, msg, turn) {
            runs.entry(key).or_default().push((i, path));
        }
    }
    for (_, run) in runs {
        let parts: Vec<String> = run
            .iter()
            .map(|(i, p)| {
                let mut path = vec!["data"];
                path.extend(p);
                get_mut(&mut lines[*i], &path)
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_default()
            })
            .collect();
        for ((i, p), new) in run.iter().zip(redact_run(r, &parts)) {
            let mut path = vec!["data"];
            path.extend(p);
            if let Some(v) = get_mut(&mut lines[*i], &path) {
                *v = Value::String(new);
            }
        }
    }
    lines.iter().map(|l| r.value(l)).collect()
}

/// Redacts a transcript file in place. Lines that are not JSON (observation files) are redacted as text.
pub fn redact_file(r: &Redactor, path: &std::path::Path) -> std::io::Result<()> {
    let text = std::fs::read_to_string(path)?;
    let parsed: Vec<Option<Value>> = text.lines().map(|l| serde_json::from_str(l).ok()).collect();
    let transcript = parsed
        .iter()
        .all(|p| p.as_ref().is_some_and(|v| v.get("dir").is_some()));
    let out: Vec<String> = if transcript && !parsed.is_empty() {
        redact_lines(r, parsed.into_iter().flatten().collect())
            .iter()
            .map(Value::to_string)
            .collect()
    } else {
        text.lines()
            .map(|l| match serde_json::from_str::<Value>(l) {
                Ok(v) => r.value(&v).to_string(),
                Err(_) => r.text(l),
            })
            .collect()
    };
    std::fs::write(path, out.join("\n") + "\n")
}

/// The texts of every streamed run in a transcript, joined, for a check that redaction held across deltas.
#[cfg_attr(not(test), allow(dead_code))]
pub fn joined_runs(lines: &[Value]) -> Vec<String> {
    let (mut msg, mut turn) = (0u64, 0u64);
    let mut runs: BTreeMap<String, String> = BTreeMap::new();
    for l in lines {
        let data = &l["data"];
        if data["type"] == "stream_event" && data["event"]["type"] == "message_start" {
            msg += 1;
        }
        if l["dir"] == "to_agent" && data["method"] == "session/prompt" {
            turn += 1;
        }
        if let Some((key, path)) = fragment(data, msg, turn) {
            let mut v = data;
            for p in &path {
                v = &v[*p];
            }
            runs.entry(key)
                .or_default()
                .push_str(v.as_str().unwrap_or(""));
        }
    }
    runs.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn redactor_with_user(user: &str) -> Redactor {
        let mut r = Redactor::new(&[]);
        r.literals.push((user.to_string(), "<user>".into()));
        r
    }

    #[test]
    fn a_token_shape_an_email_and_a_secret_key_are_masked() {
        let r = Redactor::new(&[]);
        let v = json!({"a": "Bearer abcdefgh12345", "email": "x@y.io", "t": "sk-ant-oat01-abcdefghijk", "note": "mail me at a.b@c.com"});
        let out = r.value(&v).to_string();
        assert!(
            !out.contains("abcdefgh12345")
                && !out.contains("x@y.io")
                && !out.contains("oat01")
                && !out.contains("a.b@c.com"),
            "{out}"
        );
    }

    #[test]
    fn a_name_split_over_two_deltas_is_redacted_in_the_joined_text() {
        let r = redactor_with_user("zebraname");
        let line = |seq: u64, text: &str| {
            json!({"seq": seq, "ms": 0, "dir": "from_agent", "data": {"type": "stream_event",
                "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}}}})
        };
        let start = json!({"seq": 0, "ms": 0, "dir": "from_agent", "data": {"type": "stream_event", "event": {"type": "message_start"}}});
        let out = redact_lines(
            &r,
            vec![
                start,
                line(1, "folder /tmp/zebra"),
                line(2, "name/work done"),
            ],
        );
        let joined = joined_runs(&out).concat();
        assert!(!joined.contains("zebraname"), "{joined}");
        assert!(
            joined.contains("<user>") && joined.ends_with("/work done"),
            "{joined}"
        );
    }

    #[test]
    fn a_scratch_path_split_across_deltas_is_masked_whole() {
        let mut r = Redactor::new(&[]);
        r.literals.insert(
            0,
            (
                "/tmp/claude-77/-Users-zebra-x/sess/scratchpad/h0".into(),
                "$SCRATCH".into(),
            ),
        );
        r.literals.push(("zebra".into(), "<user>".into()));
        let acp = |t: &str| {
            json!({"dir": "from_agent", "data": {"method": "session/update", "params": {"sessionId": "s",
            "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": t}}}}})
        };
        let out = redact_lines(
            &r,
            vec![
                acp("see /tmp/claude-77/-Users-zeb"),
                acp("ra-x/sess/scr"),
                acp("atchpad/h0/wt/a.txt done"),
            ],
        );
        let joined = joined_runs(&out).concat();
        assert_eq!(joined, "see $SCRATCH/wt/a.txt done");
        // A fixture an earlier redactor cut after `-Users-<path>` loses the rest of the path too.
        let old = redact_lines(
            &r,
            vec![
                acp("at /private/tmp/claude-<uid>/-Users-<path>"),
                acp("/sess/scratchpad/h0/wt/a.txt"),
            ],
        );
        assert_eq!(joined_runs(&old).concat(), "at $SCRATCH/<path>");
        // And one a live pass already turned into `$SCRATCH/<path>` before the rest of the path arrived.
        let live = redact_lines(
            &r,
            vec![
                acp("at $SCRATCH/<path>"),
                acp("app-x/sess/scratchpad/h0/wt/a.txt)"),
            ],
        );
        assert_eq!(joined_runs(&live).concat(), "at $SCRATCH/<path>)");
    }

    #[test]
    fn a_split_name_is_redacted_in_acp_codex_and_agy_runs_too() {
        let r = redactor_with_user("zebraname");
        let acp = |t: &str| {
            json!({"dir": "from_agent", "data": {"method": "session/update", "params": {"sessionId": "s",
            "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": t}}}}})
        };
        let codex = |t: &str| json!({"dir": "from_agent", "data": {"method": "item/agentMessage/delta", "params": {"itemId": "i", "delta": t}}});
        let agy = |t: &str| json!({"dir": "from_agent", "data": {"event": "step_update", "step_update": {"conversation_id": "c", "step_index": 1, "text_delta": t}}});
        for make in [&acp as &dyn Fn(&str) -> Value, &codex, &agy] {
            let out = redact_lines(&r, vec![make("a zeb"), make("ra"), make("name b")]);
            let joined = joined_runs(&out).concat();
            assert_eq!(joined, "a <user> b");
        }
    }

    #[test]
    fn the_home_layout_connectors_and_plan_details_are_masked() {
        let r = Redactor::new(&[]);
        let v = json!({
            "p": "$HOME/Code/someone/repo/file", "q": "$HOME/.claude/plugins", "d": "-Users-someone-Code-repo",
            "s": "claude.ai Quillmark", "t": "mcp__claude_ai_Zorbit_Hub__widget_tool",
            "account": {"subscriptionType": "Ultra"}, "rate_limit_info": {"utilization": 0.2}, "tier": {"name": "Pro"},
            "dashed": "-Users-<user>-Code-someone-repo", "label": "ChatGPT Plus", "x": {"plan": "plus"},
            "_meta": {"_claude/rateLimit": {"status": "allowed", "isUsingOverage": false}}, "overageEnabled": true,
            "tmp": "/private/tmp/claude-987/x"
        });
        let out = r.value(&v).to_string();
        for bad in [
            "someone",
            "Quillmark",
            "Zorbit_Hub",
            "allowed",
            "false",
            "true",
            "987",
            "Ultra",
            "0.2",
            "Pro",
            "Plus",
            "plus",
        ] {
            assert!(!out.contains(bad), "{bad} in {out}");
        }
        assert!(out.contains("$HOME/.claude/plugins"), "{out}");
    }

    #[test]
    fn inventory_lists_keep_the_spikes_own_entries_and_count_the_rest() {
        let r = Redactor::new(&[]);
        let v = json!({
            "tools": ["Bash", "mcp__spike__ping", "mcp__someones_server__tool"],
            "mcp_servers": [{"name": "spike", "status": "connected"}, {"name": "someones-server", "status": "pending"}],
            "skills": ["agent-pr-pipeline:pr-pipeline", "someones-style"]
        });
        let out = r.value(&v);
        assert_eq!(
            out["tools"],
            json!([
                "Bash",
                "mcp__spike__ping",
                "<1 of the person's own removed>"
            ])
        );
        assert_eq!(
            out["mcp_servers"][1]["name"],
            "<1 of the person's own removed>"
        );
        assert_eq!(
            out["skills"],
            json!([
                "agent-pr-pipeline:pr-pipeline",
                "<1 of the person's own removed>"
            ])
        );
    }

    /// Every committed fixture, with streamed runs joined, holds nothing of the machine it was recorded on.
    #[test]
    fn the_fixtures_hold_no_private_data_even_with_deltas_joined() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures");
        let mut bad: Vec<String> = Vec::new();
        let mut words: Vec<String> = std::env::var("SPIKE_REDACT_WORDS")
            .unwrap_or_default()
            .split(',')
            .map(|w| w.trim().to_lowercase())
            .filter(|w| w.len() >= 3)
            .collect();
        if let Ok(u) = std::env::var("USER")
            && u.len() >= 3
        {
            words.push(u.to_lowercase());
        }
        if let Ok(o) = std::process::Command::new("hostname").output() {
            let h = String::from_utf8_lossy(&o.stdout).trim().to_lowercase();
            for w in [
                h.clone(),
                h.trim_end_matches(".local").to_string(),
                h.split('.').next().unwrap_or("").to_string(),
            ] {
                if w.len() >= 3 {
                    words.push(w);
                }
            }
        }
        let forbidden = Regex::new(
            r#"(?i)/Users/[^<]|-Users-[^<]|\$HOME/[^.<]|claude\.ai [^<]|mcp__claude_ai_|spk_[0-9a-f]{16}|sk-ant-[a-z0-9]|ya29\.|/tmp/claude-[0-9]|-tmp-claude-[0-9]|[0-9a-f-]{36}/scratchpad|"[^"]*(subscription|plan_?type|rate_?limit|overage|utilization)[^"]*"\s*:\s*([^"\s]|"[^<])"#,
        )
        .unwrap();
        // Any email address, except the spike's own commit identity and the attribution address.
        let email =
            Regex::new(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}")
                .unwrap();
        let allowed_email =
            |m: &str| m.ends_with("@example.invalid") || m == "noreply@anthropic.com";
        let mut files = Vec::new();
        let mut stack = vec![root];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p)
                } else {
                    files.push(p)
                }
            }
        }
        for f in files {
            let text = std::fs::read_to_string(&f).unwrap_or_default();
            let lines: Vec<Value> = text
                .lines()
                .filter_map(|l| serde_json::from_str(l).ok())
                .collect();
            let all = format!("{text}\n{}", joined_runs(&lines).join("\n"));
            let lower = all.to_lowercase();
            if let Some(m) = forbidden.find(&all) {
                bad.push(format!("{}: {}", f.display(), m.as_str()));
            }
            if let Some(m) = email.find_iter(&all).find(|m| !allowed_email(m.as_str())) {
                bad.push(format!(
                    "{}: an email address {}",
                    f.display(),
                    m.as_str().len()
                ));
            }
            for w in &words {
                if lower.contains(w.as_str()) {
                    bad.push(format!("{}: a masked word", f.display()));
                }
            }
        }
        assert!(bad.is_empty(), "{}", bad.join("\n"));
    }
}
