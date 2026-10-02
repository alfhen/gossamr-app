//! The agent's final answer, from the tail of its session transcript.
//!
//! A job's `state.json` only holds Claude's one-line summary of a run. The conversation lives in
//! `<projects>/<cwd with every character outside [A-Za-z0-9] as '-'>/<sessionId>.jsonl`, one JSON object per line,
//! one content block per assistant line. Only that one file is opened, never a listing's contents: the expected path
//! is computed, and only if it is missing are the entries of `projects` checked for `<sessionId>.jsonl`. Only the
//! text blocks of the last assistant message are kept; user lines, tool inputs and outputs, thinking and system lines
//! are parsed past and dropped.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use super::cli::is_uuid;

/// A transcript can be tens of MB; the answer is at the end.
const TAIL: u64 = 2 << 20;
const PROBE_MAX: usize = 500;

/// Claude's folder name for a working directory. JavaScript counts UTF-16 units, so a character outside the basic
/// plane gives two dashes.
pub fn encode_cwd(cwd: &Path) -> String {
    cwd.to_string_lossy().chars().flat_map(|c| std::iter::repeat_n(if c.is_ascii_alphanumeric() { c } else { '-' }, c.len_utf16())).collect()
}

/// Where the session's transcript is: under the folder of one of `cwds`, else under any folder of `projects`. Claude
/// shortens the folder name for a very long path, so the second look is what finds those.
pub fn locate(projects: &Path, session_id: &str, cwds: &[PathBuf]) -> Option<PathBuf> {
    if !is_uuid(session_id) {
        return None;
    }
    let file = format!("{session_id}.jsonl");
    let is_file = |p: &Path| std::fs::symlink_metadata(p).is_ok_and(|m| m.is_file());
    let expected = cwds.iter().map(|cwd| projects.join(encode_cwd(cwd)).join(&file)).find(|p| is_file(p));
    expected.or_else(|| {
        std::fs::read_dir(projects).ok()?.filter_map(Result::ok).take(PROBE_MAX).map(|entry| entry.path().join(&file)).find(|p| is_file(p))
    })
}

/// The text of the session's last assistant message, `None` when the transcript can't be found or read, or that
/// message wrote no text (it ended on a tool call).
pub fn final_answer(projects: &Path, session_id: &str, cwds: &[PathBuf]) -> Option<String> {
    answer_in(&read_tail(&locate(projects, session_id, cwds)?).ok()?)
}

fn read_tail(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let cut = len > TAIL;
    if cut {
        file.seek(SeekFrom::Start(len - TAIL))?;
    }
    let mut buf = Vec::new();
    file.take(TAIL).read_to_end(&mut buf)?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    // The first line is partial when the file was cut mid-line.
    Ok(if cut { text.split_once('\n').map(|(_, rest)| rest.to_owned()).unwrap_or_default() } else { text })
}

#[derive(Deserialize)]
struct Line {
    #[serde(rename = "type")]
    kind: Option<String>,
    #[serde(rename = "isSidechain")]
    sidechain: Option<bool>,
    message: Option<Message>,
}

#[derive(Deserialize)]
struct Message {
    id: Option<String>,
    content: Option<Value>,
}

fn text_of(content: &Value) -> Vec<String> {
    match content {
        Value::String(s) => vec![s.clone()],
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str).map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

/// Lines that don't parse are skipped. A message's blocks are written as consecutive lines sharing one `message.id`;
/// a line from a subagent (`isSidechain`) is never the run's answer, and a user line ends the message.
fn answer_in(tail: &str) -> Option<String> {
    let mut id: Option<Option<String>> = None;
    let mut blocks: Vec<Vec<String>> = Vec::new();
    for raw in tail.lines().rev() {
        let Ok(line) = serde_json::from_str::<Line>(raw) else { continue };
        if line.sidechain == Some(true) {
            continue;
        }
        match line.kind.as_deref() {
            Some("assistant") => {
                let Some(message) = line.message else { continue };
                match &id {
                    None => id = Some(message.id.clone()),
                    Some(first) if first.is_some() && *first == message.id => {}
                    Some(_) => break,
                }
                blocks.push(message.content.as_ref().map(text_of).unwrap_or_default());
            }
            Some("user") if id.is_some() => break,
            _ => {}
        }
    }
    let text = blocks.into_iter().rev().flatten().collect::<Vec<_>>().join("\n");
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "2850a049-3e8d-466a-8ebf-28e8b6957262";

    fn assistant(id: &str, blocks: &[Value]) -> String {
        serde_json::json!({"type": "assistant", "isSidechain": false, "message": {"id": id, "role": "assistant", "content": blocks}}).to_string()
    }

    fn text(t: &str) -> Value {
        serde_json::json!({"type": "text", "text": t})
    }

    fn tool(input: &str) -> Value {
        serde_json::json!({"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": input}})
    }

    fn user(content: Value) -> String {
        serde_json::json!({"type": "user", "message": {"role": "user", "content": content}}).to_string()
    }

    fn lines(parts: &[String]) -> String {
        parts.join("\n") + "\n"
    }

    #[test]
    fn the_last_assistant_message_wins_over_earlier_text_and_trailing_non_assistant_lines() {
        let tail = lines(&[
            assistant("m1", &[text("Let me look.")]),
            assistant("m2", &[tool("ls")]),
            user(serde_json::json!([{"type": "tool_result", "content": "SECRET-TOOL-OUTPUT"}])),
            assistant("m3", &[text("Triage done.\n\nFor Jira:\n- small PR")]),
            r#"{"type":"system","subtype":"turn_duration"}"#.into(),
            user(serde_json::json!("a trailing note")),
        ]);
        // A user line after the answer is skipped over, not read as the message.
        assert_eq!(answer_in(&tail).as_deref(), Some("Triage done.\n\nFor Jira:\n- small PR"));
    }

    #[test]
    fn blocks_of_one_message_are_joined_and_thinking_and_tool_use_are_dropped() {
        let tail = lines(&[
            assistant("m1", &[serde_json::json!({"type": "thinking", "thinking": "PRIVATE-THOUGHT"})]),
            assistant("m1", &[text("First part.")]),
            assistant("m1", &[tool("echo TOOL-INPUT")]),
            assistant("m1", &[text("Second part.")]),
        ]);
        assert_eq!(answer_in(&tail).as_deref(), Some("First part.\nSecond part."));
    }

    #[test]
    fn a_message_that_wrote_no_text_gives_nothing_rather_than_an_earlier_message() {
        let tail = lines(&[assistant("m1", &[text("Earlier narration.")]), user(serde_json::json!("go on")), assistant("m2", &[tool("ls")])]);
        assert_eq!(answer_in(&tail), None);
    }

    #[test]
    fn subagent_lines_and_garbled_lines_are_skipped() {
        let sub = serde_json::json!({"type": "assistant", "isSidechain": true, "message": {"id": "s1", "content": [text("subagent chatter")]}}).to_string();
        let tail = lines(&[assistant("m1", &[text("The real answer.")]), sub, "{not json".into(), "".into(), "42".into(), r#"{"type":7}"#.into()]);
        assert_eq!(answer_in(&tail).as_deref(), Some("The real answer."));
    }

    #[test]
    fn string_content_is_text_and_an_empty_transcript_has_no_answer() {
        let line = serde_json::json!({"type": "assistant", "message": {"id": "m", "content": "Plain string."}}).to_string();
        assert_eq!(answer_in(&lines(&[line])).as_deref(), Some("Plain string."));
        assert_eq!(answer_in(""), None);
        assert_eq!(answer_in(&lines(&[user(serde_json::json!("only a prompt"))])), None);
    }

    #[test]
    fn folder_names_replace_every_character_outside_ascii_letters_and_digits() {
        assert_eq!(encode_cwd(Path::new("/Users/a/Code/app/.claude/worktrees/ca-1_x")), "-Users-a-Code-app--claude-worktrees-ca-1-x");
        assert_eq!(encode_cwd(Path::new("/work/my project/\u{e6}ble")), "-work-my-project--ble");
        assert_eq!(encode_cwd(Path::new("/w/\u{1f600}")), "-w---");
    }

    struct Scratch(PathBuf);

    impl Scratch {
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn projects() -> Scratch {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!("gossamr-transcript-{}-{}", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    fn write(projects: &Path, folder: &str, body: &str) -> PathBuf {
        let dir = projects.join(folder);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(format!("{SESSION}.jsonl"));
        std::fs::write(&file, body).unwrap();
        file
    }

    #[test]
    fn the_computed_path_is_read_and_a_missing_one_falls_back_to_the_folders_of_projects() {
        let p = projects();
        let body = lines(&[assistant("m", &[text("Found.")])]);
        let cwd = PathBuf::from("/work/app/.claude/worktrees/w1");
        write(p.path(), &encode_cwd(&cwd), &body);
        assert_eq!(final_answer(p.path(), SESSION, std::slice::from_ref(&cwd)).as_deref(), Some("Found."));

        let other = projects();
        write(other.path(), "folder-with-a-shortened-name", &body);
        assert_eq!(final_answer(other.path(), SESSION, std::slice::from_ref(&cwd)).as_deref(), Some("Found."));
        assert_eq!(final_answer(projects().path(), SESSION, std::slice::from_ref(&cwd)), None, "no transcript anywhere");
        assert_eq!(final_answer(p.path(), "not-a-session", std::slice::from_ref(&cwd)), None);
        assert_eq!(final_answer(p.path(), "../../etc/passwd-0000-4000-8000-000000000000", &[cwd]), None);
    }

    #[test]
    fn a_worktree_path_with_spaces_accents_and_punctuation_finds_its_folder() {
        let p = projects();
        let cwd = PathBuf::from("/Users/s\u{f8}ren/My Code/app (v2)/.claude/worktrees/ca-1_\u{1f600}");
        write(p.path(), "-Users-s-ren-My-Code-app--v2---claude-worktrees-ca-1---", &lines(&[assistant("m", &[text("Odd path.")])]));
        assert!(locate(p.path(), SESSION, &[PathBuf::from("/nope"), cwd.clone()]).is_some());
        assert_eq!(final_answer(p.path(), SESSION, &[cwd]).as_deref(), Some("Odd path."));
    }

    #[test]
    fn a_huge_transcript_is_read_from_its_end_only() {
        let p = projects();
        let filler = user(serde_json::json!([{"type": "tool_result", "content": "x".repeat(900_000)}]));
        let body = lines(&[assistant("old", &[text("Very old answer.")]), filler.clone(), filler.clone(), filler.clone(), assistant("m", &[text("The last answer.")])]);
        assert!(body.len() as u64 > TAIL);
        let file = write(p.path(), "-w", &body);
        assert!(read_tail(&file).unwrap().len() as u64 <= TAIL);
        assert_eq!(final_answer(p.path(), SESSION, &[PathBuf::from("/w")]).as_deref(), Some("The last answer."));

        let cut_off = lines(&[assistant("old", &[text("Only before the tail.")]), filler.clone(), filler.clone(), filler]);
        write(p.path(), "-w", &cut_off);
        assert_eq!(final_answer(p.path(), SESSION, &[PathBuf::from("/w")]), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_transcript_is_not_followed() {
        let p = projects();
        let real = projects();
        let target = real.path().join("elsewhere.jsonl");
        std::fs::write(&target, lines(&[assistant("m", &[text("Outside projects.")])])).unwrap();
        std::fs::create_dir_all(p.path().join("-w")).unwrap();
        std::os::unix::fs::symlink(&target, p.path().join("-w").join(format!("{SESSION}.jsonl"))).unwrap();
        assert_eq!(final_answer(p.path(), SESSION, &[PathBuf::from("/w")]), None);
    }
}
