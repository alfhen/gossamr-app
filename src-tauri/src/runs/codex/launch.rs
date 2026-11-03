//! Starting a Codex run: its worktree, its run folder and the `codex exec` process.

use std::ffi::OsString;
use std::io::Write;
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::process::ExitStatusExt;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use super::process::{signal_group, started_of};
use super::{create_private, events, events_file, exit_file, process_file, run_folder, stderr_file, CodexBackend, CODEX_GUARD, FINAL_FILE, MODEL_FILE, PROGRAM, SHORT_ID_FILE, TOKEN_VARIABLE};
use crate::domain::{worktree_in, RunProcess, AGENT_CALL_TIMEOUT_MS, AGENT_GUARD, AGENT_SERVER, GUARD};
use crate::runs::backend::{LaunchRequest, Session, ToolsOffer};
use crate::runs::failure::Failure;
use crate::runs::redact::redact;
use crate::runs::repo::Git;

const POLL: Duration = Duration::from_millis(50);

/// A string as TOML writes it between double quotes, for a `-c key=value` argument.
pub(super) fn toml_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The `-c` settings every turn gets: Gossamr's tools when offered, and the guard.
fn settings(tools: Option<&ToolsOffer>, guard: &str) -> Vec<OsString> {
    let mut args: Vec<OsString> = Vec::new();
    let mut config = |setting: String| args.extend(["-c".into(), setting.into()]);
    let mut guard = guard.to_owned();
    if let Some(offer) = tools {
        config(format!("mcp_servers.{AGENT_SERVER}.url={}", toml_string(&offer.url)));
        config(format!("mcp_servers.{AGENT_SERVER}.bearer_token_env_var={}", toml_string(TOKEN_VARIABLE)));
        config(format!("mcp_servers.{AGENT_SERVER}.default_tools_approval_mode=\"approve\""));
        // Codex cuts a tool call at 300 s by default, below how long `ask` waits.
        config(format!("mcp_servers.{AGENT_SERVER}.tool_timeout_sec={}", AGENT_CALL_TIMEOUT_MS / 1000));
        guard = format!("{guard} {AGENT_GUARD}");
    }
    config(format!("developer_instructions={}", toml_string(&format!("{guard} {CODEX_GUARD}"))));
    args
}

/// The arguments of the first turn. No sandbox or approval flag: the person's own Codex settings decide what the agent can do.
fn exec_args(req: &LaunchRequest, worktree: &Path, final_answer: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["exec".into(), "--json".into(), "-C".into(), worktree.into(), "-o".into(), final_answer.into()];
    if let Some(model) = &req.model {
        args.extend(["-m".into(), model.into()]);
    }
    args.extend(settings(req.tools.as_ref(), &req.guard));
    args.extend(["--".into(), req.prompt.clone().into()]);
    args
}

/// The arguments of a turn that carries on in `thread`. `exec resume` takes no `-C`; the caller sets the working folder.
pub(super) fn resume_args(thread: &str, final_answer: &Path, model: Option<&str>, tools: Option<&ToolsOffer>, message: &str) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["exec".into(), "resume".into(), thread.into(), "--json".into(), "-o".into(), final_answer.into()];
    if let Some(model) = model {
        args.extend(["-m".into(), model.into()]);
    }
    args.extend(settings(tools, GUARD));
    args.extend(["--".into(), message.into()]);
    args
}

fn make_folder(root: &Path, folder: &Path) -> std::io::Result<()> {
    let private = |dir: &Path| match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        other => other,
    };
    std::fs::create_dir_all(root.parent().unwrap_or(root))?;
    private(root)?;
    // A folder left by an earlier try at this launch holds files `create_new` would trip over.
    if folder.symlink_metadata().is_ok() {
        std::fs::remove_dir_all(folder)?;
    }
    private(folder)
}

/// The last line Codex wrote to stderr, with anything secret masked.
fn last_stderr_line(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let line = text.lines().rev().map(str::trim).find(|l| !l.is_empty())?;
    Some(redact(line).chars().take(300).collect())
}

fn failure(why: impl std::fmt::Display) -> Failure {
    Failure::Invalid(format!("Codex couldn't start the agent: {why}"))
}

/// What a launch needs undone when it fails.
struct Made<'a> {
    git: &'a Git,
    clone: &'a Path,
    worktree: &'a Path,
    branch: &'a str,
    start: &'a str,
    folder: Option<&'a Path>,
    process: Option<RunProcess>,
}

impl Made<'_> {
    async fn undo(self) {
        if let Some(process) = &self.process {
            let _ = signal_group(process, libc::SIGKILL);
        }
        if let Some(folder) = self.folder {
            let _ = std::fs::remove_dir_all(folder);
        }
        self.git.discard_untouched_worktree(self.clone, self.worktree, self.branch, self.start).await;
    }
}

impl CodexBackend {
    pub(super) async fn start(&self, req: &LaunchRequest) -> Result<Session, Failure> {
        let folder = run_folder(&self.runs_root, &req.run_id).ok_or_else(|| failure("the run has no usable id"))?;
        let worktree = worktree_in(&req.cwd, &req.worktree);
        let (branch, start) = (format!("worktree-{}", req.worktree), format!("origin/{}", req.base));
        let git = Git::new(self.git_env.clone());
        git.add_worktree(&req.cwd, &worktree, &branch, &start).await.map_err(|why| failure(format!("the worktree: {why}")))?;
        let mut made = Made { git: &git, clone: &req.cwd, worktree: &worktree, branch: &branch, start: &start, folder: None, process: None };

        if let Err(e) = make_folder(&self.runs_root, &folder) {
            made.undo().await;
            return Err(failure(format!("the run folder: {e}")));
        }
        made.folder = Some(&folder);
        // A launch whose answer is lost is found again by this id (`find`).
        if let Err(e) = create_private(&folder.join(SHORT_ID_FILE)).and_then(|mut f| f.write_all(req.fresh_id.as_str().as_bytes())) {
            made.undo().await;
            return Err(failure(format!("the run folder: {e}")));
        }

        if let Some(model) = &req.model {
            if let Err(e) = create_private(&folder.join(MODEL_FILE)).and_then(|mut f| f.write_all(model.as_bytes())) {
                made.undo().await;
                return Err(failure(format!("the run folder: {e}")));
            }
        }

        let process = match self.spawn(req, &worktree, &folder) {
            Ok(process) => process,
            Err(why) => {
                made.undo().await;
                return Err(failure(why));
            }
        };
        made.process = Some(process.clone());

        match self.wait_for_thread(&folder, 1).await {
            Ok(thread) => Ok(Session { short_id: req.fresh_id.clone(), session_id: Some(thread), process: Some(process) }),
            Err(why) => {
                // The words are read before the folder goes.
                let failed = failure(why);
                made.undo().await;
                Err(failed)
            }
        }
    }

    fn spawn(&self, req: &LaunchRequest, worktree: &Path, folder: &Path) -> Result<RunProcess, String> {
        self.start_turn(folder, 1, exec_args(req, worktree, &folder.join(FINAL_FILE)), worktree, req.tools.as_ref())
    }

    /// Starts `codex` for turn `turn` in its own session, with its output in the run folder, and records the process
    /// before anything waits on it so a quit leaves it findable.
    pub(super) fn start_turn(&self, folder: &Path, turn: u32, args: Vec<OsString>, cwd: &Path, tools: Option<&ToolsOffer>) -> Result<RunProcess, String> {
        let events = create_private(&events_file(folder, turn)).map_err(|e| format!("the events file: {e}"))?;
        let stderr = create_private(&stderr_file(folder, turn)).map_err(|e| format!("the error file: {e}"))?;
        let mut command = std::process::Command::new(&self.binary);
        command.args(args).current_dir(cwd).stdin(Stdio::null()).stdout(events).stderr(stderr);
        self.login_env.apply(&mut command);
        match tools {
            Some(offer) => command.env(TOKEN_VARIABLE, &offer.token),
            None => command.env_remove(TOKEN_VARIABLE),
        };
        let mut command = tokio::process::Command::from(command);
        // The process leads a group of its own, so a stop can reach what it started and a Ctrl-C at the app does not.
        // SAFETY: `setsid` is async-signal-safe and the closure touches nothing else.
        unsafe {
            command.pre_exec(|| if libc::setsid() == -1 { Err(std::io::Error::last_os_error()) } else { Ok(()) });
        }
        command.kill_on_drop(false);
        let mut child = command.spawn().map_err(|e| format!("couldn't run {PROGRAM}: {e}"))?;
        let pid = child.id().ok_or("it exited as it started")?;
        // A child that is already gone has no start time; the exit file then says so.
        let process = RunProcess { pid, started: started_of(pid).unwrap_or(0) };

        let exit = exit_file(folder, turn);
        tokio::spawn(async move {
            let code = match child.wait().await {
                Ok(status) => status.code().or_else(|| status.signal().map(|n| 128 + n)).unwrap_or(-1),
                Err(_) => -1,
            };
            if let Ok(mut file) = create_private(&exit) {
                let _ = write!(file, "{code}");
            }
        });

        let record = serde_json::json!({ "pid": process.pid, "started": process.started });
        let written = create_private(&process_file(folder, turn)).and_then(|mut f| f.write_all(record.to_string().as_bytes()));
        if let Err(e) = written {
            let _ = signal_group(&process, libc::SIGKILL);
            return Err(format!("the process file: {e}"));
        }
        Ok(process)
    }

    pub(super) async fn wait_for_thread(&self, folder: &Path, turn: u32) -> Result<String, String> {
        let (events, exit, stderr) = (events_file(folder, turn), exit_file(folder, turn), stderr_file(folder, turn));
        let deadline = Instant::now() + self.launch_wait;
        loop {
            if let Some(thread) = events::read(&events).thread {
                return Ok(thread);
            }
            // The reaper writes the exit file after the process is gone, so a launch that fails has nothing left to write into the folder it removes.
            if exit.exists() {
                // Output written just before the exit may have landed after the look above.
                if let Some(thread) = events::read(&events).thread {
                    return Ok(thread);
                }
                let code = std::fs::read_to_string(&exit).ok();
                return Err(last_stderr_line(&stderr).unwrap_or_else(|| match code {
                    Some(code) => format!("it exited with code {code} before it started a session."),
                    None => "it exited before it started a session.".into(),
                }));
            }
            if Instant::now() >= deadline {
                return Err(format!("it didn't start a session within {} seconds.", self.launch_wait.as_secs()));
            }
            tokio::time::sleep(POLL).await;
        }
    }
}
