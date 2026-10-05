//! Whether Claude has already asked about a folder, read from its own config and never written.

use std::path::{Path, PathBuf};

use serde_json::Value;

/// Claude keeps this file beside `settings.json` when `CLAUDE_CONFIG_DIR` is set, and next to a default `~/.claude`
/// otherwise.
fn config_file(config_dir: &Path) -> Option<PathBuf> {
    let inside = config_dir.join(".claude.json");
    if inside.is_file() {
        return Some(inside);
    }
    let beside = (config_dir.file_name()? == ".claude").then(|| config_dir.parent().map(|p| p.join(".claude.json")))??;
    beside.is_file().then_some(beside)
}

fn accepted(config: &Value, folder: &Path) -> bool {
    let Some(projects) = config.get("projects").and_then(Value::as_object) else { return false };
    folder.ancestors().any(|dir| projects.get(dir.to_string_lossy().as_ref()).and_then(|p| p.get("hasTrustDialogAccepted")).and_then(Value::as_bool) == Some(true))
}

/// `Some(false)` when Claude's config is readable and neither `folder` nor a folder above it was accepted. `None` when
/// the config can't be read or understood, which is no evidence either way.
pub fn is_trusted(config_dir: &Path, folder: &Path) -> Option<bool> {
    let text = std::fs::read_to_string(config_file(config_dir)?).ok()?;
    let config: Value = serde_json::from_str(&text).ok()?;
    config.get("projects")?.as_object()?;
    let real = folder.canonicalize().ok();
    Some(accepted(&config, folder) || real.is_some_and(|r| accepted(&config, &r)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gossamr-trust-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(dir: &Path, json: &str) {
        std::fs::write(dir.join(".claude.json"), json).unwrap();
    }

    #[test]
    fn a_folder_is_trusted_when_it_or_one_above_it_was_accepted() {
        let dir = scratch("accepted");
        let folder = dir.join("agents/hobbii/plugins");
        std::fs::create_dir_all(&folder).unwrap();
        let key = |p: &Path| p.canonicalize().unwrap().to_string_lossy().into_owned();
        write(&dir, &serde_json::json!({ "projects": { key(&folder): { "hasTrustDialogAccepted": true } } }).to_string());
        assert_eq!(is_trusted(&dir, &folder), Some(true));
        write(&dir, &serde_json::json!({ "projects": { key(&dir.join("agents")): { "hasTrustDialogAccepted": true } } }).to_string());
        assert_eq!(is_trusted(&dir, &folder), Some(true), "a parent counts");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_folder_without_an_accepted_entry_is_untrusted() {
        let dir = scratch("untrusted");
        let folder = dir.join("clone");
        std::fs::create_dir_all(&folder).unwrap();
        write(&dir, r#"{"projects":{"/elsewhere":{"hasTrustDialogAccepted":true},"/other":{"hasTrustDialogAccepted":false}}}"#);
        assert_eq!(is_trusted(&dir, &folder), Some(false));
        write(&dir, &serde_json::json!({ "projects": { folder.to_string_lossy(): { "allowedTools": [] } } }).to_string());
        assert_eq!(is_trusted(&dir, &folder), Some(false), "an entry that never accepted the prompt");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn nothing_is_claimed_when_the_config_is_missing_or_not_understood() {
        let dir = scratch("unknown");
        assert_eq!(is_trusted(&dir, &dir), None, "no file");
        write(&dir, "not json");
        assert_eq!(is_trusted(&dir, &dir), None);
        for odd in [r#"{"projects": null}"#, r#"{"projects": []}"#, r#"{"projects": "x"}"#] {
            write(&dir, odd);
            assert_eq!(is_trusted(&dir, &dir), None, "{odd}: projects that isn't an object");
        }
        write(&dir, r#"{"numStartups": 3}"#);
        assert_eq!(is_trusted(&dir, &dir), None, "no projects at all: not a config this reads");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_default_claude_folder_keeps_its_file_beside_it() {
        let home = scratch("default");
        let dot_claude = home.join(".claude");
        std::fs::create_dir_all(&dot_claude).unwrap();
        write(&home, r#"{"projects":{}}"#);
        assert_eq!(config_file(&dot_claude), Some(home.join(".claude.json")));
        assert_eq!(is_trusted(&dot_claude, &home.join("x")), Some(false));
        let _ = std::fs::remove_dir_all(home);
    }
}
