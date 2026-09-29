//! Finds the user's recent Claude Code sessions (CLI and desktop) so the panel can continue one.

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::Value;

const CANDIDATES: usize = 60;
/// Titles and the working directory are written near the top of a transcript; never read whole files (some are 40MB).
const HEAD_LINES: usize = 300;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub updated: String,
    /// `cli`, `desktop` or `app` (started from Gossamr).
    pub source: String,
}

pub fn projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

/// Recent interactive sessions, newest first. Headless runs are skipped unless listed in `own_ids`, which holds
/// sessions this app started.
pub fn recent(root: &Path, own_ids: &[String], limit: usize) -> Vec<SessionInfo> {
    let mut files: Vec<(SystemTime, PathBuf)> = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|d| d.path().is_dir())
        .flat_map(|d| std::fs::read_dir(d.path()).into_iter().flatten().flatten())
        .filter(|f| f.path().extension().is_some_and(|e| e == "jsonl"))
        .filter_map(|f| Some((f.metadata().ok()?.modified().ok()?, f.path())))
        .collect();
    files.sort_by_key(|f| std::cmp::Reverse(f.0));

    files
        .into_iter()
        .take(CANDIDATES)
        .filter_map(|(modified, path)| {
            let id = path.file_stem()?.to_str()?.to_string();
            let head = read_head(&path)?;
            let own = own_ids.contains(&id);
            let source = match head.entrypoint.as_deref() {
                _ if own => "app",
                Some("claude-desktop") => "desktop",
                Some("cli") => "cli",
                _ => return None,
            };
            Some(SessionInfo {
                title: head.title.unwrap_or_else(|| "Untitled session".into()),
                cwd: head.cwd?,
                updated: DateTime::<Utc>::from(modified).to_rfc3339_opts(SecondsFormat::Secs, true),
                source: source.into(),
                id,
            })
        })
        .take(limit)
        .collect()
}

#[derive(Default)]
struct Head {
    cwd: Option<String>,
    title: Option<String>,
    entrypoint: Option<String>,
}

fn read_head(path: &Path) -> Option<Head> {
    let reader = BufReader::new(File::open(path).ok()?);
    let mut head = Head::default();
    for line in reader.lines().take(HEAD_LINES).map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        match v["type"].as_str() {
            // A title the user set wins over the generated one.
            Some("custom-title") => head.title = v["customTitle"].as_str().map(String::from),
            Some("ai-title") if head.title.is_none() => head.title = v["aiTitle"].as_str().map(String::from),
            Some("user" | "assistant") => {
                if head.cwd.is_none() {
                    head.cwd = v["cwd"].as_str().map(String::from);
                }
                if head.entrypoint.is_none() {
                    head.entrypoint = v["entrypoint"].as_str().map(String::from);
                }
            }
            _ => {}
        }
    }
    Some(head)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(dir: &Path, project: &str, id: &str, lines: &[&str]) {
        let p = dir.join(project);
        std::fs::create_dir_all(&p).unwrap();
        let mut f = File::create(p.join(format!("{id}.jsonl"))).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
    }

    #[test]
    fn lists_interactive_sessions_and_own_headless_ones() {
        let dir = std::env::temp_dir().join(format!("gossamr-sessions-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write(&dir, "p1", "cli-1", &[
            r#"{"type":"ai-title","aiTitle":"Generated"}"#,
            r#"{"type":"user","cwd":"/code/a","entrypoint":"cli"}"#,
            r#"{"type":"custom-title","customTitle":"My title"}"#,
        ]);
        write(&dir, "p2", "desk-1", &[r#"{"type":"user","cwd":"/code/b","entrypoint":"claude-desktop"}"#]);
        write(&dir, "p2", "sdk-1", &[r#"{"type":"user","cwd":"/code/b","entrypoint":"sdk-cli"}"#]);
        write(&dir, "p2", "sdk-own", &[r#"{"type":"user","cwd":"/code/b","entrypoint":"sdk-cli"}"#]);
        write(&dir, "p3", "broken", &["not json"]);

        let mut found = recent(&dir, &["sdk-own".into()], 10);
        found.sort_by(|a, b| a.id.cmp(&b.id));
        let ids: Vec<_> = found.iter().map(|s| (s.id.as_str(), s.source.as_str())).collect();
        assert_eq!(ids, vec![("cli-1", "cli"), ("desk-1", "desktop"), ("sdk-own", "app")]);
        assert_eq!(found[0].title, "My title");
        assert_eq!(found[0].cwd, "/code/a");
        assert_eq!(found[1].title, "Untitled session");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_missing_projects_folder_is_empty() {
        assert!(recent(Path::new("/definitely/not/here"), &[], 10).is_empty());
    }
}
