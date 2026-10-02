//! The `claude` command line for background sessions, and parsers for what it prints.
//!
//! Never read `intent` or `providerEnv` from a job's `state.json` (prompts can hold pasted secrets), and never list
//! the `jobs` directory: it can be tens of GB. Reads are by id only.

use std::fmt;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::process::Command;

use super::env::RunEnv;
use crate::error::Error;

const QUICK: Duration = Duration::from_secs(15);
const LAUNCH: Duration = Duration::from_secs(60);
const STATE_JSON_MAX: u64 = 1 << 20;
const TIMELINE_TAIL: u64 = 4 << 20;
const STDERR_KEPT: usize = 2048;
const STDOUT_KEPT: usize = 500;

#[derive(Debug, thiserror::Error)]
pub enum CliError {
    #[error("Couldn't run claude: {0}")]
    Spawn(#[from] std::io::Error),
    #[error("claude took too long to answer")]
    TimedOut,
    #[error("claude failed: {}", last_line(.stderr))]
    Failed { code: Option<i32>, stderr: String },
    #[error("claude started a session but printed nothing recognisable")]
    Unparseable { stdout: String },
    #[error("Unexpected output from claude: {0}")]
    Output(String),
}

impl CliError {
    pub fn stderr_mentions(&self, needle: &str) -> bool {
        matches!(self, CliError::Failed { stderr, .. } if stderr.contains(needle))
    }
}

impl From<CliError> for Error {
    fn from(e: CliError) -> Self {
        Error::Claude(e.to_string())
    }
}

pub type CliResult<T> = std::result::Result<T, CliError>;

fn last_line(s: &str) -> &str {
    s.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("no message")
}

fn cut(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// The eight hex characters `claude` uses to name a background session. Validated so it can't carry a path or
/// shell syntax into a file name or command.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct ShortId(String);

impl TryFrom<String> for ShortId {
    type Error = String;

    fn try_from(s: String) -> Result<Self, String> {
        Self::parse(&s).ok_or_else(|| format!("not a session id: {s}"))
    }
}

impl ShortId {
    pub fn parse(s: &str) -> Option<Self> {
        (s.len() == 8 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))).then(|| Self(s.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ShortId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// One row of `claude agents --json`. Every field is optional because interactive sessions lack several and newer
/// versions add and rename things; `state` and `status` stay strings so an unknown value is carried, not rejected.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AgentEntry {
    pub id: Option<String>,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub kind: Option<String>,
    pub started_at: Option<i64>,
    pub name: Option<String>,
    pub state: Option<String>,
    pub status: Option<String>,
    pub waiting_for: Option<String>,
    pub needs: Option<String>,
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct AuthStatus {
    pub logged_in: bool,
    pub auth_method: Option<String>,
    pub api_provider: Option<String>,
    pub config_directory: Option<PathBuf>,
    pub projects_directory: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct JobChild {
    pub id: Option<String>,
    pub href: Option<String>,
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TimelineLine {
    pub at: Option<String>,
    pub state: Option<String>,
    pub detail: Option<String>,
    pub text: Option<String>,
}

/// Words and counters from a job's files. Lags `claude agents --json`, so it never decides a session's state.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct JobInfo {
    pub state: Option<String>,
    pub detail: Option<String>,
    pub tempo: Option<String>,
    pub needs: Option<String>,
    pub suggested_reply: Option<String>,
    pub tokens: Option<u64>,
    pub result: Option<String>,
    pub children: Vec<JobChild>,
    pub worktree_path: Option<String>,
    pub worktree_branch: Option<String>,
    pub updated_at: Option<String>,
    pub timeline: Vec<TimelineLine>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launched {
    pub short_id: ShortId,
    pub name: Option<String>,
}

#[derive(Debug, Clone)]
pub struct LaunchRequest {
    pub cwd: PathBuf,
    pub name: String,
    pub worktree: String,
    pub guard: String,
    pub prompt: String,
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key)?.as_str().map(str::to_owned)
}

fn stamp(v: &Value, key: &str) -> Option<String> {
    match v.get(key)? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn number(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => n.as_u64(),
        Value::Object(o) => o.values().filter_map(Value::as_u64).reduce(u64::saturating_add),
        _ => None,
    }
}

/// `backgrounded · <8 hex>[ · <name>]`, found on any line since a `Starting background service…` line can come first.
pub fn parse_launch_stdout(stdout: &str) -> Option<ShortId> {
    parse_launch(stdout).map(|l| l.short_id)
}

fn parse_launch(stdout: &str) -> Option<Launched> {
    stdout.lines().find_map(|line| {
        let rest = line.trim().strip_prefix("backgrounded \u{b7} ")?;
        let (id, name) = match rest.split_once(" \u{b7} ") {
            Some((id, name)) => (id, Some(name.to_owned())),
            None => (rest, None),
        };
        Some(Launched { short_id: ShortId::parse(id)?, name })
    })
}

pub fn parse_agents(json: &str) -> CliResult<Vec<AgentEntry>> {
    let v: Value = serde_json::from_str(json).map_err(|e| CliError::Output(e.to_string()))?;
    let rows = v.as_array().ok_or_else(|| CliError::Output("expected a list of sessions".into()))?;
    Ok(rows
        .iter()
        .filter(|r| r.is_object())
        .map(|r| AgentEntry {
            id: text(r, "id"),
            session_id: text(r, "sessionId"),
            cwd: text(r, "cwd"),
            kind: text(r, "kind"),
            started_at: r.get("startedAt").and_then(Value::as_i64),
            name: text(r, "name"),
            state: text(r, "state"),
            status: text(r, "status"),
            waiting_for: text(r, "waitingFor"),
            needs: text(r, "needs"),
            pid: r.get("pid").and_then(Value::as_u64).and_then(|p| u32::try_from(p).ok()),
        })
        .collect())
}

pub fn parse_auth_status(json: &str) -> CliResult<AuthStatus> {
    let v: Value = serde_json::from_str(json).map_err(|e| CliError::Output(e.to_string()))?;
    Ok(AuthStatus {
        logged_in: v.get("loggedIn").and_then(Value::as_bool).unwrap_or(false),
        auth_method: text(&v, "authMethod"),
        api_provider: text(&v, "apiProvider"),
        config_directory: text(&v, "configDirectory").map(PathBuf::from),
        projects_directory: text(&v, "projectsDirectory").map(PathBuf::from),
    })
}

/// Unreadable input gives an empty `JobInfo`, and bad timeline lines are skipped: these files are an internal format.
pub fn parse_job(state_json: &str, timeline: &str) -> JobInfo {
    let mut job = JobInfo::default();
    if let Ok(v) = serde_json::from_str::<Value>(state_json) {
        job.state = text(&v, "state");
        job.detail = text(&v, "detail");
        job.tempo = text(&v, "tempo");
        job.needs = text(&v, "needs");
        job.suggested_reply = text(&v, "suggestedReply");
        job.tokens = v.get("tokens").and_then(number);
        job.result = v.get("output").and_then(|o| text(o, "result"));
        job.children = v
            .get("children")
            .and_then(Value::as_array)
            .map(|c| {
                c.iter()
                    .filter(|c| c.is_object())
                    .map(|c| JobChild { id: text(c, "id"), href: text(c, "href"), kind: text(c, "kind") })
                    .collect()
            })
            .unwrap_or_default();
        job.worktree_path = text(&v, "worktreePath");
        job.worktree_branch = text(&v, "worktreeBranch");
        job.updated_at = stamp(&v, "updatedAt");
    }
    job.timeline = timeline
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(Value::is_object)
        .map(|l| TimelineLine { at: stamp(&l, "at"), state: text(&l, "state"), detail: text(&l, "detail"), text: text(&l, "text") })
        .collect();
    job
}

pub fn is_uuid(s: &str) -> bool {
    s.len() == 36 && s.bytes().enumerate().all(|(i, b)| if matches!(i, 8 | 13 | 18 | 23) { b == b'-' } else { b.is_ascii_hexdigit() })
}

/// `2.1.286 (Claude Code)` gives `(2, 1, 286)`.
pub fn parse_version(s: &str) -> Option<(u32, u32, u32)> {
    let mut parts = s.split_whitespace().next()?.split('.').map(|p| p.parse::<u32>().ok());
    Some((parts.next()??, parts.next()??, parts.next()??))
}

#[async_trait]
pub trait ClaudeCli: Send + Sync {
    async fn version(&self) -> CliResult<String>;
    async fn auth_status(&self) -> CliResult<AuthStatus>;
    async fn supports_bg(&self) -> CliResult<bool>;
    async fn launch(&self, req: &LaunchRequest) -> CliResult<Launched>;
    async fn agents(&self, all: bool) -> CliResult<Vec<AgentEntry>>;
    /// Wakes a stopped session with `message`. Carries no other flag: any flag makes `claude` start a copy.
    async fn resume(&self, session_id: &str, message: &str, cwd: Option<&Path>) -> CliResult<Launched>;
    async fn stop(&self, id: &ShortId) -> CliResult<()>;
    async fn rm(&self, id: &ShortId) -> CliResult<()>;
    async fn job(&self, config_dir: &Path, id: &ShortId) -> CliResult<Option<JobInfo>>;
    /// The text of the session's last assistant message, read from its transcript under `projects`.
    async fn final_answer(&self, projects: &Path, session_id: &str, cwds: &[PathBuf]) -> Option<String>;
    /// The `claude` this runs, for a command that has to start the same one in a terminal.
    fn binary(&self) -> Option<PathBuf> {
        None
    }
}

pub struct SystemCli {
    binary: PathBuf,
    env: Arc<RunEnv>,
}

struct Output {
    ok: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

impl Output {
    /// `claude rm` explains a refusal on stdout and leaves stderr empty, so fall back to it.
    fn failure(&self) -> CliError {
        let message = if self.stderr.trim().is_empty() { &self.stdout } else { &self.stderr };
        CliError::Failed { code: self.code, stderr: tail(message) }
    }
}

impl SystemCli {
    pub fn new(binary: PathBuf, env: Arc<RunEnv>) -> Self {
        Self { binary, env }
    }

    pub fn binary(&self) -> &Path {
        &self.binary
    }

    async fn run(&self, args: &[&str], cwd: Option<&Path>, limit: Duration) -> CliResult<Output> {
        let mut cmd = Command::new(&self.binary);
        cmd.args(args);
        self.env.apply(cmd.as_std_mut());
        if let Some(cwd) = cwd {
            cmd.current_dir(cwd);
        }
        // stdin must be closed: with it open, claude treats it as the prompt.
        let child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).spawn()?;
        let out = tokio::time::timeout(limit, child.wait_with_output()).await.map_err(|_| CliError::TimedOut)??;
        Ok(Output {
            ok: out.status.success(),
            code: out.status.code(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        })
    }

    async fn succeed(&self, args: &[&str]) -> CliResult<Output> {
        let out = self.run(args, None, QUICK).await?;
        if out.ok {
            Ok(out)
        } else {
            Err(out.failure())
        }
    }
}

fn tail(s: &str) -> String {
    let skip = s.chars().count().saturating_sub(STDERR_KEPT);
    s.chars().skip(skip).collect()
}

#[async_trait]
impl ClaudeCli for SystemCli {
    async fn version(&self) -> CliResult<String> {
        Ok(self.succeed(&["--version"]).await?.stdout.trim().to_owned())
    }

    async fn auth_status(&self) -> CliResult<AuthStatus> {
        // Signed out may exit non-zero while still printing the JSON.
        let out = self.run(&["auth", "status", "--json"], None, QUICK).await?;
        parse_auth_status(&out.stdout).map_err(|e| if out.ok { e } else { out.failure() })
    }

    async fn supports_bg(&self) -> CliResult<bool> {
        Ok(self.succeed(&["--help"]).await?.stdout.contains("--bg"))
    }

    async fn launch(&self, req: &LaunchRequest) -> CliResult<Launched> {
        // `--` keeps a prompt that starts with a dash from being read as a flag.
        let args = ["--bg", "--name", &req.name, "--worktree", &req.worktree, "--append-system-prompt", &req.guard, "--", &req.prompt];
        let out = self.run(&args, Some(&req.cwd), LAUNCH).await?;
        if !out.ok {
            return Err(out.failure());
        }
        parse_launch(&out.stdout).ok_or_else(|| CliError::Unparseable { stdout: cut(&out.stdout, STDOUT_KEPT) })
    }

    async fn agents(&self, all: bool) -> CliResult<Vec<AgentEntry>> {
        let args: &[&str] = if all { &["agents", "--json", "--all"] } else { &["agents", "--json"] };
        parse_agents(&self.succeed(args).await?.stdout)
    }

    async fn resume(&self, session_id: &str, message: &str, cwd: Option<&Path>) -> CliResult<Launched> {
        if !is_uuid(session_id) {
            return Err(CliError::Output(format!("not a session id: {session_id}")));
        }
        let out = self.run(&["--bg", "--resume", session_id, "--", message], cwd, LAUNCH).await?;
        if !out.ok {
            return Err(out.failure());
        }
        parse_launch(&out.stdout).ok_or_else(|| CliError::Unparseable { stdout: cut(&out.stdout, STDOUT_KEPT) })
    }

    async fn stop(&self, id: &ShortId) -> CliResult<()> {
        self.succeed(&["stop", id.as_str()]).await.map(drop)
    }

    async fn rm(&self, id: &ShortId) -> CliResult<()> {
        self.succeed(&["rm", id.as_str()]).await.map(drop)
    }

    async fn job(&self, config_dir: &Path, id: &ShortId) -> CliResult<Option<JobInfo>> {
        let dir = config_dir.join("jobs").join(id.as_str());
        tokio::task::spawn_blocking(move || read_job(&dir))
            .await
            .map_err(|e| CliError::Spawn(std::io::Error::other(e)))?
    }

    async fn final_answer(&self, projects: &Path, session_id: &str, cwds: &[PathBuf]) -> Option<String> {
        let (projects, session_id, cwds) = (projects.to_path_buf(), session_id.to_owned(), cwds.to_vec());
        tokio::task::spawn_blocking(move || super::transcript::final_answer(&projects, &session_id, &cwds)).await.ok().flatten()
    }

    fn binary(&self) -> Option<PathBuf> {
        Some(self.binary.clone())
    }
}

fn read_job(dir: &Path) -> CliResult<Option<JobInfo>> {
    let state = match read_capped(&dir.join("state.json"), STATE_JSON_MAX, false) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let timeline = read_capped(&dir.join("timeline.jsonl"), TIMELINE_TAIL, true).unwrap_or_default();
    Ok(Some(parse_job(&state, &timeline)))
}

/// At most `max` bytes. For a log, keep the end and drop the partial first line.
fn read_capped(path: &Path, max: u64, keep_end: bool) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let truncated = len > max;
    if truncated && keep_end {
        file.seek(SeekFrom::Start(len - max))?;
    }
    let mut buf = Vec::new();
    file.take(max).read_to_end(&mut buf)?;
    let s = String::from_utf8_lossy(&buf).into_owned();
    if truncated && keep_end {
        return Ok(s.split_once('\n').map(|(_, rest)| rest.to_owned()).unwrap_or_default());
    }
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/test-fixtures/agents/").to_owned() + name).unwrap()
    }

    const DOT: &str = "\u{b7}";

    #[test]
    fn launch_stdout_with_and_without_the_service_line_and_the_name() {
        let hints = "  claude attach 1a2b3c4d\n  claude logs 1a2b3c4d\n";
        for stdout in [
            format!("backgrounded {DOT} 1a2b3c4d {DOT} CE-1 investigate\n{hints}"),
            format!("Starting background service\u{2026}\nbackgrounded {DOT} 1a2b3c4d {DOT} CE-1 investigate\n{hints}"),
            format!("backgrounded {DOT} 1a2b3c4d\n{hints}"),
            format!("Starting background service\u{2026}\r\nbackgrounded {DOT} 1a2b3c4d\r\n"),
        ] {
            assert_eq!(parse_launch_stdout(&stdout).unwrap().as_str(), "1a2b3c4d", "{stdout}");
        }
        let named = parse_launch(&format!("backgrounded {DOT} 1a2b3c4d {DOT} a {DOT} b")).unwrap();
        assert_eq!(named.name.as_deref(), Some("a \u{b7} b"));
        assert_eq!(parse_launch(&format!("backgrounded {DOT} 1a2b3c4d")).unwrap().name, None);
    }

    #[test]
    fn launch_stdout_that_is_not_a_launch_is_rejected() {
        for stdout in [
            "",
            "Starting background service\u{2026}\n",
            &format!("backgrounded {DOT} ../../etc"),
            &format!("backgrounded {DOT} 1A2B3C4D"),
            &format!("backgrounded {DOT} 1a2b3c4"),
            &format!("backgrounded {DOT} 1a2b3c4d5"),
            &format!("backgrounded {DOT} 1a2b3c4dx {DOT} n"),
            &format!("backgrounded {DOT} 1a2b3c4d{DOT}n"),
            "backgrounded 1a2b3c4d",
        ] {
            assert!(parse_launch_stdout(stdout).is_none(), "{stdout:?}");
        }
    }

    #[test]
    fn short_ids_are_eight_lowercase_hex_and_nothing_path_like() {
        assert!(ShortId::parse("0123abcd").is_some());
        for bad in ["", "0123abc", "0123abcde", "0123ABCD", "../abcd1", "abcd/123", "abcd 123", "0123abc\n", "\u{e9}123abcd", "-rf00000"] {
            assert!(ShortId::parse(bad).is_none(), "{bad:?}");
        }
        assert_eq!(serde_json::to_string(&ShortId::parse("0123abcd").unwrap()).unwrap(), "\"0123abcd\"");
    }

    #[test]
    fn agents_fixture_from_2_1_286() {
        let rows = parse_agents(&fixture("agents-2.1.286.json")).unwrap();
        assert_eq!(rows.len(), 8);
        let working = &rows[0];
        assert_eq!(working.id.as_deref(), Some("1a2b3c4d"));
        assert_eq!(working.cwd.as_deref(), Some("/work/example/.claude/worktrees/ce-1-fix-login-9f3a"));
        assert_eq!((working.state.as_deref(), working.status.as_deref(), working.pid), (Some("working"), Some("busy"), Some(51001)));
        let question = &rows[1];
        assert_eq!((question.state.as_deref(), question.status.as_deref()), (Some("blocked"), Some("idle")));
        let permission = &rows[2];
        assert_eq!((permission.status.as_deref(), permission.waiting_for.as_deref()), (Some("waiting"), Some("permission prompt")));
        assert_eq!(rows[3].state.as_deref(), Some("done"));
        assert_eq!((rows[4].state.as_deref(), rows[4].pid), (Some("stopped"), None));
        assert_eq!((rows[5].state.as_deref(), rows[5].status.as_deref(), rows[5].pid), (Some("blocked"), None, None));
        let interactive = &rows[6];
        assert_eq!((interactive.kind.as_deref(), interactive.id.as_deref(), interactive.state.as_deref()), (Some("interactive"), None, None));
        for r in rows.iter().filter(|r| r.id.is_some()) {
            assert_eq!(&r.session_id.as_deref().unwrap()[..8], r.id.as_deref().unwrap(), "the short id is the session id's first eight characters");
        }
    }

    #[test]
    fn agents_tolerates_unknown_missing_and_mistyped_fields() {
        let rows = parse_agents(&fixture("agents-unknown.json")).unwrap();
        assert_eq!(rows.len(), 3, "non-objects are skipped");
        assert_eq!((rows[0].state.as_deref(), rows[0].status.as_deref()), (Some("paused-by-quota"), Some("throttled")));
        assert_eq!(rows[0].needs.as_deref(), Some("login required \u{2014} run /login"));
        assert_eq!(rows[1], AgentEntry { id: Some("adbecfd0".into()), kind: Some("background".into()), ..Default::default() });
        assert_eq!((rows[2].started_at, rows[2].pid, rows[2].state.clone()), (None, None, None));
        assert!(parse_agents("[]").unwrap().is_empty());
        assert!(parse_agents("{\"agents\":[]}").is_err());
        assert!(parse_agents("not json").is_err());
        assert!(parse_agents("").is_err());
    }

    #[test]
    fn auth_status_reads_only_what_is_needed() {
        let signed_in = parse_auth_status(
            r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"a@b.c","orgId":"o","configDirectory":"/home/x/.claude","projectsDirectory":"/home/x/.claude/projects"}"#,
        )
        .unwrap();
        assert!(signed_in.logged_in);
        assert_eq!(signed_in.config_directory.as_deref(), Some(Path::new("/home/x/.claude")));
        assert!(!format!("{signed_in:?}").contains("a@b.c"));
        let out = parse_auth_status(r#"{"loggedIn":false}"#).unwrap();
        assert!(!out.logged_in && out.config_directory.is_none());
        assert!(parse_auth_status("nope").is_err());
    }

    #[test]
    fn job_files_new_shape_and_the_secrets_we_never_read() {
        let job = parse_job(&fixture("state-question.json"), &fixture("timeline.jsonl"));
        assert_eq!(job.state.as_deref(), Some("blocked"));
        assert_eq!(job.tempo.as_deref(), Some("blocked"));
        assert_eq!(job.needs.as_deref(), Some("Should the fix keep the old column, or migrate it?"));
        assert_eq!(job.suggested_reply.as_deref(), Some("Migrate it"));
        assert_eq!(job.tokens, Some(412000));
        assert_eq!(job.worktree_branch.as_deref(), Some("worktree-ce-2-slow-export-0c1d"));
        assert_eq!(job.updated_at.as_deref(), Some("2026-09-30T10:15:00.000Z"));
        let dump = format!("{job:?}");
        assert!(!dump.contains("MUST-NEVER-BE-READ"), "intent and providerEnv stay out");

        let permission = parse_job(&fixture("state-permission.json"), "");
        assert_eq!((permission.state.as_deref(), permission.tempo.as_deref()), (Some("working"), Some("blocked")));
        assert!(permission.needs.unwrap().starts_with("approve Bash: "));
        assert!(permission.timeline.is_empty());

        let done = parse_job(&fixture("state-done.json"), "");
        assert!(done.result.clone().unwrap().contains("For Jira:"));
        assert_eq!(done.children.len(), 2);
        assert_eq!(done.children[0], JobChild { id: Some("c0ffee01".into()), href: Some("claude://session/c0ffee01".into()), kind: Some("subagent".into()) });
        assert_eq!(done.children[1].href, None);
        assert!(!format!("{done:?}").contains("MUST-NEVER-BE-READ"));
    }

    #[test]
    fn job_files_old_shape_with_most_fields_missing() {
        let job = parse_job(&fixture("state-old-2.1.236.json"), "");
        assert_eq!(job.needs.as_deref(), Some("login required \u{2014} run /login"));
        assert_eq!(job.tokens, Some(1500), "a token breakdown is summed");
        assert_eq!(job.updated_at.as_deref(), Some("1780000000000"));
        assert_eq!((&job.detail, &job.tempo, &job.result, &job.worktree_path), (&None, &None, &None, &None));
        assert!(job.children.is_empty());
        assert!(!format!("{job:?}").contains("MUST-NEVER-BE-READ"));
    }

    #[test]
    fn job_files_that_are_garbage_give_an_empty_job() {
        assert_eq!(parse_job("", ""), JobInfo::default());
        assert_eq!(parse_job("[1]", "{{"), JobInfo::default());
        assert_eq!(parse_job("{\"tokens\":\"many\",\"children\":7,\"output\":3}", ""), JobInfo::default());
    }

    #[test]
    fn timeline_skips_bad_lines_and_keeps_order() {
        let lines = parse_job("{}", &fixture("timeline.jsonl")).timeline;
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[1].text.as_deref(), Some("grep -rn export src"));
        assert_eq!(lines[2].at.as_deref(), Some("1790000500000"), "a numeric timestamp is kept as text");
        assert_eq!(lines[3].at, None);
    }

    #[test]
    fn versions_parse_from_the_banner() {
        assert_eq!(parse_version("2.1.286 (Claude Code)"), Some((2, 1, 286)));
        assert_eq!(parse_version("2.1.286"), Some((2, 1, 286)));
        assert_eq!(parse_version("2.1"), None);
        assert_eq!(parse_version("dev"), None);
        assert_eq!(parse_version(""), None);
    }

    mod through_the_real_spawner {
        use super::*;
        use std::collections::BTreeSet;

        const FAKE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/test-support/fake-claude.sh");

        struct Rig {
            dir: PathBuf,
            repo: PathBuf,
            cli: SystemCli,
        }

        impl Rig {
            fn new(tag: &str, scenario: &str) -> Self {
                let dir = std::env::temp_dir().join(format!("gossamr-runs-cli-{tag}-{}", std::process::id()));
                let _ = std::fs::remove_dir_all(&dir);
                let repo = dir.join("repo");
                std::fs::create_dir_all(&repo).unwrap();
                let file = dir.join("scenario");
                std::fs::write(&file, scenario).unwrap();
                let env = RunEnv::from_pairs([
                    ("PATH", "/usr/bin:/bin".to_string()),
                    ("HOME", dir.to_string_lossy().into_owned()),
                    ("FAKE_CLAUDE_SCENARIO", file.to_string_lossy().into_owned()),
                ]);
                Self { cli: SystemCli::new(PathBuf::from(FAKE), Arc::new(env)), dir, repo }
            }

            fn request(&self, name: &str) -> LaunchRequest {
                LaunchRequest {
                    cwd: self.repo.clone(),
                    name: format!("{name} investigate"),
                    worktree: name.to_string(),
                    guard: "guard text".into(),
                    prompt: "-- look at it; \"quoted\" $(not run) `nor this`".into(),
                }
            }

            fn calls(&self) -> String {
                std::fs::read_to_string(self.dir.join("calls.log")).unwrap_or_default()
            }
        }

        impl Drop for Rig {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.dir);
            }
        }

        #[tokio::test]
        async fn version_auth_and_bg_support() {
            let rig = Rig::new("basics", "version=2.1.286 (Claude Code)\n");
            assert_eq!(rig.cli.version().await.unwrap(), "2.1.286 (Claude Code)");
            assert!(rig.cli.supports_bg().await.unwrap());
            let auth = rig.cli.auth_status().await.unwrap();
            assert!(auth.logged_in);
            assert_eq!(auth.config_directory.unwrap(), rig.dir.join("config"));
        }

        #[tokio::test]
        async fn supports_bg_is_false_when_help_lacks_it() {
            let rig = Rig::new("nobg", "help_bg=0\n");
            assert!(!rig.cli.supports_bg().await.unwrap());
        }

        #[tokio::test]
        async fn signed_out_still_reports_its_config_directory() {
            let rig = Rig::new("signedout", "logged_in=0\n");
            let auth = rig.cli.auth_status().await.unwrap();
            assert!(!auth.logged_in);
            assert!(auth.config_directory.is_some());
        }

        #[tokio::test]
        async fn launch_list_stop_rm_round_trip() {
            let rig = Rig::new("lifecycle", "service_line=1\ninteractive=1\n");
            let launched = rig.cli.launch(&rig.request("ce-1-fix-ab12")).await.unwrap();
            assert_eq!(launched.name.as_deref(), Some("ce-1-fix-ab12 investigate"));

            let worktree = std::fs::canonicalize(&rig.repo).unwrap().join(".claude/worktrees/ce-1-fix-ab12");
            let rows = rig.cli.agents(false).await.unwrap();
            let mine = rows.iter().find(|r| r.id.as_deref() == Some(launched.short_id.as_str())).unwrap();
            assert_eq!(mine.cwd.as_deref().map(Path::new), Some(worktree.as_path()));
            assert_eq!((mine.state.as_deref(), mine.pid), (Some("working"), Some(4242)));
            assert!(rows.iter().any(|r| r.kind.as_deref() == Some("interactive")));

            let job = rig.cli.job(&rig.dir.join("config"), &launched.short_id).await.unwrap().unwrap();
            assert_eq!(job.worktree_branch.as_deref(), Some("worktree-ce-1-fix-ab12"));
            assert!(!format!("{job:?}").contains("look at it"), "the prompt in intent is never read");

            rig.cli.stop(&launched.short_id).await.unwrap();
            assert!(!rig.cli.agents(false).await.unwrap().iter().any(|r| r.id.as_deref() == Some(launched.short_id.as_str())));
            let all = rig.cli.agents(true).await.unwrap();
            assert_eq!(all.iter().find(|r| r.id.as_deref() == Some(launched.short_id.as_str())).unwrap().state.as_deref(), Some("stopped"));

            rig.cli.rm(&launched.short_id).await.unwrap();
            assert!(!rig.cli.agents(true).await.unwrap().iter().any(|r| r.id.as_deref() == Some(launched.short_id.as_str())));
            assert!(rig.cli.job(&rig.dir.join("config"), &launched.short_id).await.unwrap().is_none());
            assert!(rig.cli.stop(&launched.short_id).await.is_err(), "an unknown session is an error");
        }

        #[tokio::test]
        async fn the_final_answer_is_read_from_the_transcript_the_session_wrote_under_the_projects_folder() {
            let rig = Rig::new("transcript", "transcript=Done. For Jira: it works\n");
            let launched = rig.cli.launch(&rig.request("ce-9-answer-ab12")).await.unwrap();
            let rows = rig.cli.agents(false).await.unwrap();
            let mine = rows.iter().find(|r| r.id.as_deref() == Some(launched.short_id.as_str())).unwrap();
            let (session, cwd) = (mine.session_id.clone().unwrap(), PathBuf::from(mine.cwd.clone().unwrap()));
            let projects = rig.cli.auth_status().await.unwrap().projects_directory.unwrap();
            assert_eq!(projects, rig.dir.join("config/projects"));

            let answer = rig.cli.final_answer(&projects, &session, std::slice::from_ref(&cwd)).await;
            assert!(answer.as_deref().is_some_and(|a| a == "Done. For Jira: it works"), "{answer:?}");
            assert_eq!(rig.cli.final_answer(&projects, &session, &[PathBuf::from("/elsewhere")]).await, answer, "found by its session id when the folder differs");
            assert_eq!(rig.cli.final_answer(&projects, "00000000-0000-4000-8000-000000000000", &[cwd]).await, None);
        }

        #[tokio::test]
        async fn a_session_name_with_a_colon_and_spaces_reaches_claude_whole_and_is_listed_unchanged() {
            let rig = Rig::new("prefixed", "");
            let mut req = rig.request("ce-5-name-ab12");
            req.name = "Gossamr: CE-5 investigate".into();
            let launched = rig.cli.launch(&req).await.unwrap();
            assert_eq!(launched.name.as_deref(), Some("Gossamr: CE-5 investigate"));
            assert!(rig.calls().lines().any(|l| l == "Gossamr: CE-5 investigate"), "one argument, not split: {}", rig.calls());
            let rows = rig.cli.agents(false).await.unwrap();
            let mine = rows.iter().find(|r| r.id.as_deref() == Some(launched.short_id.as_str())).unwrap();
            assert_eq!(mine.name.as_deref(), Some("Gossamr: CE-5 investigate"));
            let worktree = std::fs::canonicalize(&rig.repo).unwrap().join(".claude/worktrees/ce-5-name-ab12");
            assert_eq!(mine.cwd.as_deref().map(Path::new), Some(worktree.as_path()), "the folder keeps the plain slug");
        }

        #[tokio::test]
        async fn launch_runs_in_the_clone_with_the_exact_flags_and_nothing_else_in_the_environment() {
            let rig = Rig::new("flags", "");
            rig.cli.launch(&rig.request("ce-2-x-cd34")).await.unwrap();
            let calls = rig.calls();
            let args: Vec<&str> = calls.lines().skip(2).collect();
            assert_eq!(
                args,
                [
                    "--bg",
                    "--name",
                    "ce-2-x-cd34 investigate",
                    "--worktree",
                    "ce-2-x-cd34",
                    "--append-system-prompt",
                    "guard text",
                    "--",
                    "-- look at it; \"quoted\" $(not run) `nor this`",
                ]
            );
            assert!(calls.contains(&format!("cwd={}", std::fs::canonicalize(&rig.repo).unwrap().display())));

            let seen: BTreeSet<String> = std::fs::read_to_string(rig.dir.join("env.last")).unwrap().lines().map(String::from).collect();
            let captured: BTreeSet<String> = ["PATH", "HOME", "FAKE_CLAUDE_SCENARIO"].map(String::from).into();
            let shell_added: BTreeSet<String> = ["PWD", "SHLVL", "_", "OLDPWD"].map(String::from).into();
            assert!(captured.is_subset(&seen));
            assert!(seen.difference(&captured).all(|k| shell_added.contains(k)), "unexpected variables: {seen:?}");
        }

        #[tokio::test]
        async fn launch_failures_are_typed() {
            let untrusted = Rig::new("untrusted", "launch_fail=untrusted\n");
            let err = untrusted.cli.launch(&untrusted.request("ce-3-x-ef56")).await.unwrap_err();
            assert!(matches!(err, CliError::Failed { code: Some(1), .. }));
            assert!(err.stderr_mentions("Workspace not trusted"));

            let broken = Rig::new("broken", "launch_fail=exit\n");
            let err = broken.cli.launch(&broken.request("ce-3-x-ef56")).await.unwrap_err();
            assert_eq!(err.to_string(), "claude failed: something broke");

            let garbage = Rig::new("garbage", "launch_fail=garbage\n");
            let err = garbage.cli.launch(&garbage.request("ce-3-x-ef56")).await.unwrap_err();
            assert!(matches!(&err, CliError::Unparseable { stdout } if stdout.contains("whatever")));
        }

        #[tokio::test]
        async fn resume_of_a_running_session_starts_a_copy_and_of_a_stopped_one_keeps_the_id() {
            let rig = Rig::new("resume", "");
            let first = rig.cli.launch(&rig.request("ce-4-x-0a1b")).await.unwrap();
            let session = rig.cli.agents(false).await.unwrap().remove(0).session_id.unwrap();
            let copy = rig.cli.resume(&session, "say OK", Some(&rig.repo)).await.unwrap();
            assert_ne!(copy.short_id, first.short_id, "a running session is copied");

            rig.cli.stop(&first.short_id).await.unwrap();
            let again = rig.cli.resume(&session, "-- say OK again; $(not run)", Some(&rig.repo)).await.unwrap();
            assert_eq!(again.short_id, first.short_id);
            let calls = rig.calls();
            let last: Vec<&str> = calls.rsplit("---\n").next().unwrap().lines().skip(1).collect();
            assert_eq!(last, ["--bg", "--resume", session.as_str(), "--", "-- say OK again; $(not run)"], "no flag but --bg and --resume");
            let seen: BTreeSet<String> = std::fs::read_to_string(rig.dir.join("env.last")).unwrap().lines().map(String::from).collect();
            let allowed: BTreeSet<String> = ["PATH", "HOME", "FAKE_CLAUDE_SCENARIO", "PWD", "SHLVL", "_", "OLDPWD"].map(String::from).into();
            assert!(seen.is_subset(&allowed), "unexpected variables: {seen:?}");
        }

        #[tokio::test]
        async fn resume_refuses_anything_but_a_session_uuid_and_reports_a_missing_session() {
            let rig = Rig::new("resume-bad", "");
            for bad in ["", "--bg", "../../x", "b0000001-0000-4000-8000-00000000000g", "b0000001000040008000000000000000"] {
                assert!(matches!(rig.cli.resume(bad, "hi", None).await, Err(CliError::Output(_))), "{bad}");
            }
            assert!(rig.calls().is_empty(), "nothing was run");
            let err = rig.cli.resume("b0000009-0000-4000-8000-000000000000", "hi", None).await.unwrap_err();
            assert!(err.to_string().contains("No session"), "{err}");
        }

        #[tokio::test]
        async fn a_binary_that_cannot_run_is_a_spawn_error() {
            let cli = SystemCli::new(PathBuf::from("/nonexistent/claude"), Arc::new(RunEnv::from_pairs([("PATH", "/usr/bin")])));
            assert!(matches!(cli.version().await, Err(CliError::Spawn(_))));
        }
    }

    #[test]
    fn job_reads_are_capped_and_a_log_keeps_its_end() {
        let dir = std::env::temp_dir().join(format!("gossamr-runs-cap-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("t.jsonl");
        let line = format!("{{\"text\":\"{}\"}}\n", "x".repeat(1000));
        std::fs::write(&log, line.repeat(10)).unwrap();
        let kept = read_capped(&log, 3500, true).unwrap();
        assert!(kept.len() <= 3500 && kept.lines().all(|l| l == line.trim_end()), "no partial first line");
        assert_eq!(kept.lines().count(), 3);
        assert_eq!(read_capped(&log, 3500, false).unwrap().len(), 3500);
        assert_eq!(read_capped(&log, 1 << 20, true).unwrap().lines().count(), 10);
        let _ = std::fs::remove_dir_all(dir);
    }
}
