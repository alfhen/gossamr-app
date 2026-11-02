//! The models a Codex login offers, read from `codex debug models`.
//!
//! The output is a debugging dump, not a contract: it is about 750 KB because each model carries its full
//! instructions, and only `slug`, `display_name`, `visibility` and `priority` are read. Anything unexpected makes the
//! caller fall back to its built-in list.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tokio::io::AsyncReadExt;

use super::env::RunEnv;
use crate::model_choice::{valid_model_id, ModelOption};

const TIMEOUT: Duration = Duration::from_secs(20);
const OUTPUT_LIMIT: u64 = 8 * 1024 * 1024;
const MODEL_LIMIT: usize = 50;
const LABEL_LIMIT: usize = 60;

pub async fn discover(binary: &Path, env: &RunEnv) -> Option<Vec<ModelOption>> {
    discover_within(binary, env, TIMEOUT).await
}

async fn discover_within(binary: &Path, env: &RunEnv, limit: Duration) -> Option<Vec<ModelOption>> {
    let mut command = std::process::Command::new(binary);
    command.args(["debug", "models"]);
    env.apply(&mut command);
    // A Codex that finds stdin open waits on it (docs/agents-cli-findings.md), so it is closed.
    let mut child = tokio::process::Command::from(command).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true).spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let read = async {
        let mut raw = Vec::new();
        (&mut stdout).take(OUTPUT_LIMIT + 1).read_to_end(&mut raw).await.ok()?;
        let finished = raw.len() as u64 <= OUTPUT_LIMIT && child.wait().await.ok()?.success();
        finished.then_some(raw)
    };
    parse(&tokio::time::timeout(limit, read).await.ok()??)
}

/// The listed models, best first. `None` when the output is not a catalog with at least one usable model.
pub fn parse(raw: &[u8]) -> Option<Vec<ModelOption>> {
    let catalog: Value = serde_json::from_slice(raw).ok()?;
    let mut entries: Vec<(i64, ModelOption)> = Vec::new();
    for entry in catalog.get("models")?.as_array()? {
        let Some(slug) = entry.get("slug").and_then(Value::as_str).filter(|s| valid_model_id(s)) else { continue };
        if entry.get("visibility").and_then(Value::as_str).is_some_and(|v| v != "list") || entries.iter().any(|(_, m)| m.id.eq_ignore_ascii_case(slug)) {
            continue;
        }
        let label = entry.get("display_name").and_then(Value::as_str).map(clean_label).filter(|l| !l.is_empty()).unwrap_or_else(|| slug.into());
        entries.push((entry.get("priority").and_then(Value::as_i64).unwrap_or(i64::MAX), ModelOption { id: slug.into(), label }));
    }
    entries.sort_by_key(|(priority, _)| *priority);
    let models: Vec<_> = entries.into_iter().take(MODEL_LIMIT).map(|(_, m)| m).collect();
    (!models.is_empty()).then_some(models)
}

fn clean_label(name: &str) -> String {
    name.chars().filter(|c| !c.is_control()).take(LABEL_LIMIT).collect::<String>().trim().into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    const CATALOG: &str = r#"{"models":[
        {"slug":"gpt-6-astra","display_name":"GPT-6-Astra","visibility":"list","priority":2,"base_instructions":"long"},
        {"slug":"gpt-6.1-sol","display_name":"GPT-6.1-Sol","visibility":"list","priority":1},
        {"slug":"gpt-daybreak-blue-latest","display_name":"Daybreak Blue","visibility":"hide","priority":11},
        {"slug":"gpt-5.5","display_name":"GPT-5.5","visibility":"list","priority":13}
    ]}"#;

    fn ids(models: &[ModelOption]) -> Vec<&str> {
        models.iter().map(|m| m.id.as_str()).collect()
    }

    fn fake_codex(tag: &str, body: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("gossamr-codex-models-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("codex");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        (dir, path)
    }

    fn env() -> RunEnv {
        RunEnv::from_pairs([("PATH", "/usr/bin:/bin"), ("CODEX_HOME", "/work/codex")])
    }

    #[test]
    fn listed_models_come_best_first_with_their_display_names_and_hidden_ones_are_left_out() {
        let models = parse(CATALOG.as_bytes()).unwrap();
        assert_eq!(ids(&models), ["gpt-6.1-sol", "gpt-6-astra", "gpt-5.5"]);
        assert_eq!(models[0].label, "GPT-6.1-Sol");
    }

    #[test]
    fn a_model_without_a_name_or_priority_is_still_listed_last_under_its_id() {
        let models = parse(br#"{"models":[{"slug":"plain"},{"slug":"first","priority":1,"display_name":"  "}]}"#).unwrap();
        assert_eq!(models.iter().map(|m| (m.id.as_str(), m.label.as_str())).collect::<Vec<_>>(), [("first", "first"), ("plain", "plain")]);
    }

    #[test]
    fn an_entry_that_cannot_be_read_or_breaks_the_id_rule_is_skipped_and_the_rest_are_kept() {
        let raw = br#"{"models":[5,null,{"slug":7},{"slug":"--dangerously-bypass"},{"slug":"a b"},{"slug":"ok"},{"slug":"OK"},{"slug":"also","priority":"high","visibility":5}]}"#;
        assert_eq!(ids(&parse(raw).unwrap()), ["ok", "also"]);
    }

    #[test]
    fn a_label_loses_control_characters_and_stops_at_60_characters() {
        let raw = format!(r#"{{"models":[{{"slug":"m","display_name":"A\u001b[31mB\nC{}"}}]}}"#, "x".repeat(100));
        let label = parse(raw.as_bytes()).unwrap().remove(0).label;
        assert_eq!(label.chars().count(), 60);
        assert!(label.starts_with("A[31mBC"), "{label}");
    }

    #[test]
    fn the_list_stops_at_50_models() {
        let entries: Vec<_> = (0..80).map(|n| format!(r#"{{"slug":"m{n}","priority":{n}}}"#)).collect();
        let models = parse(format!(r#"{{"models":[{}]}}"#, entries.join(",")).as_bytes()).unwrap();
        assert_eq!((models.len(), models[0].id.as_str(), models[49].id.as_str()), (50, "m0", "m49"));
    }

    #[test]
    fn output_that_is_not_a_usable_catalog_gives_nothing() {
        for raw in ["", "not json", "[]", "{}", r#"{"models":{}}"#, r#"{"models":[]}"#, r#"{"models":[{"slug":"h","visibility":"hide"}]}"#, r#"{"models":[{"display_name":"x"}]}"#] {
            assert_eq!(parse(raw.as_bytes()), None, "{raw:?}");
        }
    }

    #[tokio::test]
    async fn the_catalog_is_read_from_debug_models_run_with_stdin_closed_and_the_instances_environment() {
        let body = format!(
            "[ \"$1 $2\" = \"debug models\" ] || exit 2\n[ \"$CODEX_HOME\" = /work/codex ] || exit 3\nif read -r _line; then exit 5; fi\ncat <<'JSON'\n{CATALOG}\nJSON"
        );
        let (dir, codex) = fake_codex("run", &body);
        let models = discover(&codex, &env()).await;
        assert_eq!(models.as_deref().map(ids), Some(vec!["gpt-6.1-sol", "gpt-6-astra", "gpt-5.5"]));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_codex_that_fails_prints_rubbish_or_is_missing_gives_nothing() {
        for (tag, body) in [("exit", "echo '{\"models\":[{\"slug\":\"x\"}]}'\nexit 1"), ("rubbish", "echo 'Error: not signed in'")] {
            let (dir, codex) = fake_codex(tag, body);
            assert_eq!(discover(&codex, &env()).await, None, "{tag}");
            let _ = std::fs::remove_dir_all(dir);
        }
        assert_eq!(discover(Path::new("/nonexistent/codex"), &env()).await, None);
    }

    #[tokio::test]
    async fn a_codex_that_hangs_or_prints_too_much_is_given_up_on() {
        let (dir, slow) = fake_codex("slow", "exec sleep 30");
        let started = std::time::Instant::now();
        assert_eq!(discover_within(&slow, &env(), Duration::from_millis(300)).await, None);
        assert!(started.elapsed() < Duration::from_secs(5));
        let (big_dir, big) = fake_codex("big", "head -c 9000000 /dev/zero | tr '\\0' ' '");
        assert_eq!(discover(&big, &env()).await, None);
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(big_dir);
    }
}
