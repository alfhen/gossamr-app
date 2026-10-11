//! What the person sees, before approving, about whether a run can start and what it will run as.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use super::failure::Failure;
use super::index::RunIndex;
use super::repo::{inspect, Git};
use super::toolchain::ToolchainSource;
use super::trust::is_trusted;
use crate::domain::{CodeChange, RunKind, RunSpec};

const PATH_SHOWN: usize = 300;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    Green,
    Amber,
    Red,
}

/// A step the page offers beside a row.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RowAction {
    TrustFolder { path: PathBuf },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Row {
    pub level: Level,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<RowAction>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Preflight {
    pub rows: Vec<Row>,
    /// A red row: starting would fail.
    pub blocking: bool,
}

struct Rows(Vec<Row>);

impl Rows {
    fn add(&mut self, level: Level, text: impl Into<String>) {
        self.0.push(Row { level, text: text.into(), action: None });
    }

    fn add_with(&mut self, level: Level, text: impl Into<String>, action: RowAction) {
        self.0.push(Row { level, text: text.into(), action: Some(action) });
    }

    fn red(&mut self, why: &Failure) {
        self.add(Level::Red, why.to_string());
    }
}

/// The permission mode the person's own Claude settings give a session, read without writing anything. Absent is fine.
fn default_mode(config_dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(config_dir.join("settings.json")).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let mode = v.get("defaultMode").or_else(|| v.get("permissions")?.get("defaultMode"))?;
    mode.as_str().map(str::to_owned)
}

fn push_explanation(mode: Option<&str>) -> String {
    match mode {
        Some("auto") => "with auto mode, anything Claude's classifier approves runs without asking".into(),
        Some("bypassPermissions") => "nothing asks before it runs".into(),
        Some(_) | None => "your allow rules decide whether a push asks first".into(),
    }
}

fn review_row(rows: &mut Rows, spec: &RunSpec, found: &Result<CodeChange, String>) {
    let number = spec.pr.unwrap_or_default();
    match found {
        Ok(c) => rows.add(Level::Green, format!("Reviews pull request #{number} in {}. Its branch is in {}, the same repository.", spec.repo, c.head_repo.as_deref().unwrap_or(&spec.repo))),
        Err(why) => rows.add(Level::Red, why.clone()),
    }
}

/// Checks, in the order the person would fix them. Without a `spec` only the environment and capacity are checked.
/// `pr` is what GitHub says about a review's pull request.
pub async fn preflight(spec: Option<&RunSpec>, tools: &dyn ToolchainSource, index: &RunIndex, cap: usize, pr: Option<Result<CodeChange, String>>) -> Preflight {
    let mut rows = Rows(Vec::new());
    let live = index.live().len();
    match tools.get().await {
        Err(e) => rows.red(&e.into()),
        Ok(tc) => {
            match tc.cli.version().await {
                Ok(v) => rows.add(Level::Green, format!("Claude Code {}", v.trim())),
                Err(e) => rows.red(&Failure::from_cli(e, Path::new(""))),
            }
            let mut config_dir = None;
            match tc.cli.auth_status().await {
                Ok(auth) if auth.logged_in => {
                    rows.add(Level::Green, "Signed in to Claude");
                    config_dir = auth.config_directory;
                }
                Ok(_) => rows.red(&Failure::NotSignedIn),
                Err(e) => rows.red(&Failure::from_cli(e, Path::new(""))),
            }
            match tc.cli.supports_bg().await {
                Ok(true) => rows.add(Level::Green, "Background agents are supported"),
                Ok(false) => rows.red(&Failure::TooOld),
                Err(e) => rows.red(&Failure::from_cli(e, Path::new(""))),
            }
            let read_only = spec.and_then(RunSpec::read_only);
            if read_only.is_some() {
                match tc.cli.supports_read_only().await {
                    Ok(true) => rows.add(Level::Green, "Read-only steps are supported"),
                    Ok(false) => rows.red(&Failure::CantRestrict),
                    Err(e) => rows.red(&Failure::from_cli(e, Path::new(""))),
                }
            }
            let path = tc.env.get("PATH").map(|p| p.to_string_lossy().chars().take(PATH_SHOWN).collect::<String>()).unwrap_or_default();
            rows.add(Level::Green, format!("Shell environment read ({} variables). Agents get this PATH: {path}", tc.env.len()));
            if let Some(spec) = spec {
                clone_row(&mut rows, &Git::new(tc.env.clone()), spec).await;
                trust_row(&mut rows, config_dir.as_deref(), &spec.clone_path);
            }
            let mode = config_dir.as_deref().and_then(default_mode);
            if let Some(ro) = &read_only {
                let yours = mode.as_deref().map(|m| format!("Your own mode, {m}, applies to a Build.")).unwrap_or_else(|| "Your own settings apply to a Build.".into());
                rows.add(Level::Green, format!("This step runs read-only, in permission mode {}, without your or the repository's Claude settings and MCP servers: only the commands listed are allowed. {yours}", ro.mode));
            } else if let Some(mode) = &mode {
                let level = if mode == "bypassPermissions" { Level::Amber } else { Level::Green };
                rows.add(level, format!("Agents run as you, in your permission mode: {mode}"));
            } else if config_dir.is_some() {
                rows.add(Level::Green, "Agents run as you, with your Claude settings (no default permission mode is set)");
            }
            if let Some(spec) = spec {
                plan_row(&mut rows, spec);
            }
            if let Some(from) = spec.and_then(|s| s.build_from_run.as_deref().zip(s.build_account.as_deref())) {
                rows.add(Level::Green, format!("This review carries the builder's account from run {} in the prompt ({} characters), as a claim to check against the diff.", from.0, from.1.chars().count()));
            }
            if spec.is_some_and(|s| s.kind == RunKind::Build && s.allow_push) {
                let shown = mode.as_deref().unwrap_or("not set");
                rows.add(
                    Level::Amber,
                    format!("This agent may push a branch and open a draft pull request if your Claude settings allow it. Your permission mode is {shown}: {}.", push_explanation(mode.as_deref())),
                );
            }
        }
    }
    if let (Some(spec), Some(found)) = (spec, &pr) {
        review_row(&mut rows, spec, found);
    }
    if live >= cap {
        // Not red: an approved run over the cap stays queued and starts by itself once a slot frees.
        rows.add(Level::Amber, format!("{live} of {cap} agents are running. This one will wait for a slot and start when one finishes."));
    } else {
        rows.add(Level::Green, format!("{live} of {cap} agents running"));
    }
    if let Some(spec) = spec {
        rows.add(Level::Green, format!("What runs: {}", &spec.digest()[..12]));
    }
    let blocking = rows.0.iter().any(|r| r.level == Level::Red);
    Preflight { rows: rows.0, blocking }
}

/// Green for a plan a person settled; amber, never red, for the planning run's own answer, which the person may still
/// choose to build from.
fn plan_row(rows: &mut Rows, spec: &RunSpec) {
    let Some((from, plan)) = spec.plan_from_run.as_deref().zip(spec.plan.as_deref()) else { return };
    if spec.plan_approved {
        rows.add(Level::Green, format!("This build follows the plan from run {from} as written in the prompt ({} characters). If the plan is wrong it is told to stop and say so.", plan.chars().count()));
    } else {
        rows.add(Level::Amber, format!("This build follows run {from}'s own plan, which nobody edited or approved on the ticket. Approve the Gossamr Plan draft first, or edit the plan below."));
    }
}

/// Amber, not red: the config is read as Claude writes it today, and a folder it doesn't list may still be trusted.
fn trust_row(rows: &mut Rows, config_dir: Option<&Path>, folder: &Path) {
    if config_dir.and_then(|dir| is_trusted(dir, folder)) == Some(false) {
        rows.add_with(
            Level::Amber,
            format!("Claude hasn't been opened in {} yet: trust it once. Claude asks before a repository's own settings, hooks and tools run with the agent, and the launch is refused until you accept.", folder.display()),
            RowAction::TrustFolder { path: folder.to_path_buf() },
        );
    }
}

async fn clone_row(rows: &mut Rows, git: &Git, spec: &RunSpec) {
    let path = &spec.clone_path;
    if !(path.is_dir() && path.join(".git").exists()) {
        return rows.red(&Failure::NoClone(format!("{} isn't a git clone", path.display())));
    }
    let Some(clone) = inspect(git, path).await else {
        return rows.red(&Failure::NoClone(format!("Git couldn't read {}", path.display())));
    };
    let note = if clone.dirty {
        format!("It has uncommitted changes. The agent won't touch your files, but its worktree starts from your current HEAD ({}).", clone.branch)
    } else if clone.branch != spec.base {
        format!("It is on {}, not {}. The agent's worktree starts from your current HEAD and is told to switch to {}.", clone.branch, spec.base, spec.base)
    } else {
        String::new()
    };
    let level = if note.is_empty() { Level::Green } else { Level::Amber };
    rows.add(level, format!("Clone: {} on {}. {note}", path.display(), clone.branch).trim_end().to_owned());
}
