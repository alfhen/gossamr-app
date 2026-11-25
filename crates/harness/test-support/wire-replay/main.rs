//! The wire replay: a fake provider CLI that plays an H0 recording over stdio. It writes the recording's `from_agent`
//! lines with the recorded run's ids mapped to this run's, and checks each line the driver sends against the recorded
//! `to_agent` line on what a replay needs (`docs/plan-harness.md`, H6). A driver run against it is then compared with
//! H2's converter. Only test builds have it (`required-features = ["testing"]`).
//!
//! `WIRE_REPLAY_FIXTURE` names the recording. `WIRE_REPLAY_OUT` names a folder that gets `argv.json`, `env.json`,
//! `sent.jsonl` (each line received) and, on a mismatch, `report.txt`, which names the recorded line and the field and
//! never a payload. A mismatch exits 3.
//!
//! What is compared, for Claude's native stream: the line's `type`, a control request's subtype, a prompt's text, an
//! answer's decision, and every id by the mapping. Config requests (a control request other than `initialize` and
//! `interrupt`, `mcp_set_servers` among them) are not compared: the replay answers each one it is sent with success
//! and skips the recording's own, with their answers. A recorded endpoint's server name becomes the driver's when both
//! name exactly one server. Codex's and Gemini's wires add their rules with H7a and H8.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use serde_json::{Map, Value, json};

/// What the replay does once the recording has been played.
#[derive(Debug, PartialEq)]
enum End {
    Exit,
    /// The recorded agent outlived its stdin (a background task, or a driver killed mid-turn): stay until signalled.
    Stay,
}

fn main() -> ExitCode {
    let (Some(fixture), Some(out)) = (std::env::var_os("WIRE_REPLAY_FIXTURE"), std::env::var_os("WIRE_REPLAY_OUT")) else {
        eprintln!("wire-replay: WIRE_REPLAY_FIXTURE and WIRE_REPLAY_OUT must be set");
        return ExitCode::from(2);
    };
    let out = PathBuf::from(out);
    let argv: Vec<String> = std::env::args_os().skip(1).map(|arg| arg.to_string_lossy().into_owned()).collect();
    let env: Map<String, Value> = std::env::vars_os().map(|(k, v)| (k.to_string_lossy().into_owned(), Value::from(v.to_string_lossy().into_owned()))).collect();
    let written = std::fs::write(out.join("argv.json"), Value::from(argv).to_string()).and_then(|()| std::fs::write(out.join("env.json"), Value::Object(env).to_string()));
    let recording = match (written, load(Path::new(&fixture))) {
        (Ok(()), Ok(recording)) => recording,
        (Err(e), _) => return refuse(&out, &format!("cannot write the out folder: {e}")),
        (_, Err(e)) => return refuse(&out, &e),
    };
    let sent = std::fs::File::create(out.join("sent.jsonl"));
    let Ok(mut sent) = sent else { return refuse(&out, "cannot write sent.jsonl") };
    let stdin = std::io::stdin().lock().lines().map(|line| line.map_err(|e| e.to_string()));
    let stdin = stdin.inspect(|line| {
        if let Ok(line) = line {
            let _ = writeln!(sent, "{line}");
        }
    });
    match Replay::new(recording).play(stdin, &mut std::io::stdout().lock(), &mut std::io::stderr().lock()) {
        Ok(End::Exit) => ExitCode::SUCCESS,
        Ok(End::Stay) => {
            // Tests read this line to know the replay stays, rather than waiting to see that it did not exit.
            eprintln!("wire-replay: staying until signalled");
            loop {
                std::thread::park();
            }
        }
        Err(mismatch) => refuse(&out, &mismatch),
    }
}

fn refuse(out: &Path, why: &str) -> ExitCode {
    let _ = std::fs::write(out.join("report.txt"), format!("{why}\n"));
    eprintln!("wire-replay: {why}");
    ExitCode::from(3)
}

/// One line of an H0 transcript.
#[derive(Debug, Clone)]
struct Recorded {
    seq: u64,
    dir: String,
    data: Value,
}

fn load(path: &Path) -> Result<Vec<Recorded>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("cannot read the recording: {e}"))?;
    text.lines()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty())
        .map(|(at, line)| {
            let line: Value = serde_json::from_str(line).map_err(|_| format!("line {} of the recording is not JSON", at + 1))?;
            let seq = line["seq"].as_u64().unwrap_or(at as u64 + 1);
            Ok(Recorded { seq, dir: line["dir"].as_str().unwrap_or_default().to_owned(), data: line["data"].clone() })
        })
        .collect()
}

struct Replay {
    lines: Vec<Recorded>,
    ids: Ids,
    /// Recorded request ids whose answers are not played: answers to config requests.
    skipped: HashSet<String>,
}

impl Replay {
    fn new(lines: Vec<Recorded>) -> Replay {
        Replay { lines, ids: Ids::default(), skipped: HashSet::new() }
    }

    fn play(mut self, mut stdin: impl Iterator<Item = Result<String, String>>, stdout: &mut impl Write, stderr: &mut impl Write) -> Result<End, String> {
        let (mut closed, mut stays) = (false, false);
        let lines = std::mem::take(&mut self.lines);
        for line in &lines {
            match (line.dir.as_str(), line.data["note"].as_str()) {
                ("from_agent", _) => {
                    if self.skipped.contains(&request_id(&line.data)) {
                        continue;
                    }
                    let mut data = line.data.clone();
                    self.ids.agent(&mut data);
                    writeln!(stdout, "{data}").and_then(|()| stdout.flush()).map_err(|e| format!("cannot write stdout: {e}"))?;
                }
                ("stderr", _) => {
                    let text = line.data.as_str().map_or_else(|| line.data.to_string(), str::to_owned);
                    let _ = writeln!(stderr, "{text}");
                }
                ("to_agent", _) if is_config(&line.data) => {
                    // A recorded config request the driver may or may not send; its answer is the replay's own.
                    self.skipped.insert(request_id(&line.data));
                    self.ids.servers(&line.data);
                }
                ("to_agent", _) => {
                    let Some(sent) = self.next(&mut stdin, stdout)? else {
                        return Err(format!("line {}: stdin closed where the recording has {}", line.seq, what(&line.data)));
                    };
                    self.compare(line, &sent)?;
                }
                ("driver", Some("close_stdin")) => {
                    if let Some(sent) = self.next(&mut stdin, stdout)? {
                        return Err(format!("line {}: the driver sent {} where the recording closes stdin", line.seq, what(&sent)));
                    }
                    closed = true;
                }
                ("driver", Some("still_running_killing")) => stays = true,
                // What came after a signal is the signal's doing, not the driver's.
                ("driver", Some("signal")) => break,
                _ => {}
            }
        }
        if !closed {
            if let Some(sent) = self.next(&mut stdin, stdout)? {
                return Err(format!("the driver sent {} after the recording ended", what(&sent)));
            }
            stays = true;
        }
        Ok(if stays { End::Stay } else { End::Exit })
    }

    /// The driver's next line that is not a config request, answering each config request on the way; None at EOF.
    fn next(&mut self, stdin: &mut impl Iterator<Item = Result<String, String>>, stdout: &mut impl Write) -> Result<Option<Value>, String> {
        for line in stdin.by_ref() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let sent: Value = serde_json::from_str(&line).map_err(|_| "the driver sent a line that is not JSON".to_owned())?;
            if !is_config(&sent) {
                return Ok(Some(sent));
            }
            self.ids.sent_servers(&sent);
            let answer = json!({"type": "control_response", "response": {"subtype": "success", "request_id": sent["request_id"], "response": config_answer(&sent)}});
            writeln!(stdout, "{answer}").and_then(|()| stdout.flush()).map_err(|e| format!("cannot write stdout: {e}"))?;
        }
        Ok(None)
    }

    fn compare(&mut self, recorded: &Recorded, sent: &Value) -> Result<(), String> {
        let (want, at) = (&recorded.data, recorded.seq);
        let differs = |field: &str| Err(format!("line {at}: {field} differs from the recording's {}", what(want)));
        if want["type"] != sent["type"] {
            return Err(format!("line {at}: the driver sent {} where the recording has {}", what(sent), what(want)));
        }
        match want["type"].as_str() {
            Some("control_request") => {
                if want["request"]["subtype"] != sent["request"]["subtype"] {
                    return differs("the subtype");
                }
                self.ids.bind(&want["request_id"], &sent["request_id"]).map_err(|why| format!("line {at}: {why}"))
            }
            Some("control_response") => {
                let (want, sent) = (&want["response"], &sent["response"]);
                if !self.ids.maps(&want["request_id"], &sent["request_id"]) {
                    return differs("the request id");
                }
                if want["subtype"] != sent["subtype"] {
                    return differs("the answer's subtype");
                }
                if want["response"]["behavior"] != sent["response"]["behavior"] {
                    return differs("the decision");
                }
                Ok(())
            }
            Some("user") => match texts(&want["message"]["content"]) == texts(&sent["message"]["content"]) {
                true => Ok(()),
                false => differs("the prompt's text"),
            },
            _ => Ok(()),
        }
    }
}

/// A line's kind, for a report: its type and a control line's subtype. Never its payload.
fn what(data: &Value) -> String {
    let kind = data["type"].as_str().unwrap_or("a line with no type");
    match data["request"]["subtype"].as_str() {
        Some(subtype) => format!("{kind} {subtype}"),
        None => kind.to_owned(),
    }
}

fn request_id(data: &Value) -> String {
    data["request_id"].as_str().or(data["response"]["request_id"].as_str()).unwrap_or_default().to_owned()
}

/// A control request the driver chooses to send or not, which a replay does not compare.
fn is_config(data: &Value) -> bool {
    data["type"] == "control_request" && !matches!(data["request"]["subtype"].as_str(), Some("initialize" | "interrupt"))
}

fn config_answer(sent: &Value) -> Value {
    match sent["request"]["subtype"].as_str() {
        Some("mcp_set_servers") => {
            let added: Vec<&String> = sent["request"]["servers"].as_object().map(|servers| servers.keys().collect()).unwrap_or_default();
            json!({"added": added, "removed": [], "errors": {}})
        }
        _ => json!({}),
    }
}

/// A user message's text: its string content, or its text blocks joined.
fn texts(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks.iter().filter(|block| block["type"] == "text").filter_map(|block| block["text"].as_str()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/// The recorded run's ids and this run's. An id first seen from the agent gets a fresh one of the same shape; an id
/// the driver chose is bound when its line is compared.
#[derive(Default)]
struct Ids {
    to: HashMap<String, String>,
    /// Ids the driver chose, so it cannot answer two requests with one id.
    chosen: HashSet<String>,
    /// The recorded config's server names, and the driver's.
    recorded_servers: Vec<String>,
    sent_servers: Vec<String>,
}

fn is_id_field(key: &str) -> bool {
    matches!(key, "id" | "uuid") || ["_id", "Id", "_ids", "Ids"].iter().any(|end| key.ends_with(end))
}

impl Ids {
    fn bind(&mut self, recorded: &Value, sent: &Value) -> Result<(), String> {
        let (Some(recorded), Some(sent)) = (recorded.as_str(), sent.as_str()) else {
            return match recorded == sent {
                true => Ok(()),
                false => Err("the request id differs in kind".into()),
            };
        };
        if !self.chosen.insert(sent.to_owned()) {
            return Err("the driver used a request id twice".into());
        }
        self.to.insert(recorded.to_owned(), sent.to_owned());
        Ok(())
    }

    fn maps(&self, recorded: &Value, sent: &Value) -> bool {
        recorded.as_str().and_then(|recorded| self.to.get(recorded)).is_some_and(|live| Some(live.as_str()) == sent.as_str())
    }

    fn servers(&mut self, recorded: &Value) {
        if let Some(servers) = recorded["request"]["servers"].as_object() {
            self.recorded_servers = servers.keys().cloned().collect();
        }
    }

    fn sent_servers(&mut self, sent: &Value) {
        if let Some(servers) = sent["request"]["servers"].as_object() {
            self.sent_servers = servers.keys().cloned().collect();
        }
    }

    /// The recorded endpoint's name and the driver's, when each side names one server.
    fn server(&self) -> Option<(&str, &str)> {
        match (self.recorded_servers.as_slice(), self.sent_servers.as_slice()) {
            ([recorded], [sent]) => Some((recorded, sent)),
            _ => None,
        }
    }

    /// Maps an agent line in place.
    fn agent(&mut self, value: &mut Value) {
        self.name(value, "");
        // Longest first, so an id inside a longer one (a run id in a script's file name) is not cut.
        let mut known: Vec<(String, String)> = self.to.iter().filter(|(recorded, _)| recorded.len() >= 8).map(|(r, l)| (r.clone(), l.clone())).collect();
        known.sort_by_key(|(recorded, _)| std::cmp::Reverse(recorded.len()));
        let server = self.server().map(|(recorded, sent)| (recorded.to_owned(), sent.to_owned()));
        rewrite(value, "", &known, server.as_ref());
    }

    /// Gives every id in an id field its live id, a fresh one where the recording first names it here.
    fn name(&mut self, value: &mut Value, key: &str) {
        match value {
            Value::Object(fields) => fields.iter_mut().for_each(|(key, field)| self.name(field, key)),
            Value::Array(items) => items.iter_mut().for_each(|item| self.name(item, key)),
            Value::String(text) if is_id_field(key) && !text.is_empty() => {
                let live = self.to.entry(text.clone()).or_insert_with(|| fresh(text));
                *text = live.clone();
            }
            _ => {}
        }
    }
}

/// Maps the ids the recording named in map keys (`wire_tool_inputs`) and in free text (a transcript's path, a tool's
/// output), and the recorded endpoint's name in its tool names.
fn rewrite(value: &mut Value, key: &str, known: &[(String, String)], server: Option<&(String, String)>) {
    match value {
        Value::Object(fields) => {
            if fields.keys().any(|key| known.iter().any(|(recorded, _)| recorded == key)) {
                let live = |key: String| known.iter().find(|(recorded, _)| *recorded == key).map_or(key, |(_, live)| live.clone());
                *fields = std::mem::take(fields).into_iter().map(|(key, field)| (live(key), field)).collect();
            }
            fields.iter_mut().for_each(|(key, field)| rewrite(field, key, known, server))
        }
        Value::Array(items) => items.iter_mut().for_each(|item| rewrite(item, key, known, server)),
        Value::String(_) if is_id_field(key) => {}
        Value::String(text) => {
            for (recorded, live) in known {
                if text.contains(recorded.as_str()) {
                    *text = text.replace(recorded.as_str(), live);
                }
            }
            if let Some((recorded, sent)) = server {
                *text = match *text == *recorded {
                    true => sent.clone(),
                    false => text.replace(&format!("mcp__{recorded}__"), &format!("mcp__{sent}__")),
                };
            }
        }
        _ => {}
    }
}

/// A new id of `recorded`'s shape: a lowercase prefix before `_` is kept, and every other letter or digit is drawn
/// again from its own class, so a UUID stays a UUID and `toolu_…` stays `toolu_…`.
fn fresh(recorded: &str) -> String {
    let (prefix, rest) = match recorded.split_once('_') {
        Some((prefix, rest)) if !prefix.is_empty() && prefix.bytes().all(|b| b.is_ascii_lowercase()) => (format!("{prefix}_"), rest),
        _ => (String::new(), recorded),
    };
    let mut random = vec![0u8; rest.len()];
    getrandom::fill(&mut random).expect("the operating system has a secure random source");
    let drawn: String = rest
        .chars()
        .zip(random)
        .map(|(c, r)| {
            let pick = |set: &[u8]| set[r as usize % set.len()] as char;
            match c {
                '0'..='9' | 'a'..='f' if rest.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase() || b == b'-') => pick(b"0123456789abcdef"),
                '0'..='9' => pick(b"0123456789"),
                'a'..='z' => pick(b"abcdefghijklmnopqrstuvwxyz"),
                'A'..='Z' => pick(b"ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
                other => other,
            }
        })
        .collect();
    format!("{prefix}{drawn}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_id_keeps_its_shape_and_is_new() {
        let uuid = "3fea6374-c3ed-4254-8d20-6333b6edce26";
        let new = fresh(uuid);
        assert_ne!(new, uuid);
        assert!(new.len() == uuid.len() && new.chars().zip(uuid.chars()).all(|(a, b)| (a == '-') == (b == '-')), "a UUID stays a UUID");
        assert!(new.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase() || b == b'-'));
        let tool = fresh("toolu_01KX85KeVuBaHQoR3pzBhj2M");
        assert!(tool.starts_with("toolu_") && tool.len() == "toolu_01KX85KeVuBaHQoR3pzBhj2M".len() && tool != "toolu_01KX85KeVuBaHQoR3pzBhj2M");
    }

    #[test]
    fn a_report_names_the_kind_and_never_the_payload() {
        assert_eq!(what(&json!({"type": "control_request", "request": {"subtype": "interrupt"}})), "control_request interrupt");
        assert_eq!(what(&json!({"type": "user", "message": {"content": "a secret prompt"}})), "user");
    }
}
