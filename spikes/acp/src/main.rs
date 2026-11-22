//! H0 spike. Each subcommand drives one provider path and writes a redacted transcript of the wire.
//! See README.md for the checks and the scripts that run them.

mod acp;
mod agent;
mod app_server;
mod claude;
mod lines;
mod mcp;
mod redact;
mod rpc;
mod transcript;

use clap::{Parser, Subcommand, ValueEnum};
use serde_json::json;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use transcript::Transcript;

#[derive(Parser)]
#[command(name = "acp-spike", version)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// An ACP client (agy acp, claude-agent-acp, codex-acp).
    Acp(Common),
    /// `claude -p --input-format stream-json --output-format stream-json`, with the control protocol.
    Claude(Common),
    /// `codex app-server` over stdio.
    AppServer(Common),
    /// `agy -p` with stream-json both ways.
    AgyStream(Common),
    /// Any one-shot command (`codex exec --json`, `agy -p "..."`): records stdout and stderr until exit.
    Raw(Common),
    /// Redacts transcript files again, in place (after the word list or patterns changed).
    Redact { files: Vec<PathBuf> },
    /// A loopback MCP server over streamable HTTP with a bearer token and two tools.
    Mcp(mcp::Opts),
}

#[derive(Clone, Copy, Debug, ValueEnum, PartialEq)]
pub enum Policy {
    /// Never answer a permission request (the turn waits until cancel or timeout).
    None,
    Allow,
    Deny,
    /// Allow the first request, deny the second, and so on.
    Alt,
}

#[derive(clap::Args, Clone)]
pub struct Common {
    /// Working folder of the agent.
    #[arg(long)]
    pub cwd: PathBuf,
    /// Where the redacted transcript goes (JSON lines).
    #[arg(long)]
    pub transcript: PathBuf,
    /// One turn per prompt, in order, in the same session.
    #[arg(long)]
    pub prompt: Vec<String>,
    #[arg(long, value_enum, default_value = "alt")]
    pub permission: Policy,
    /// Cancel the first turn this many seconds after it started.
    #[arg(long)]
    pub cancel_after: Option<f64>,
    /// Resume this session or thread id instead of starting a new one.
    #[arg(long)]
    pub resume: Option<String>,
    /// ACP only: `load`, `resume`, or `auto` (load if the agent says it can, else resume).
    #[arg(long, default_value = "auto")]
    pub resume_method: String,
    #[arg(long)]
    pub model: Option<String>,
    #[arg(long)]
    pub effort: Option<String>,
    /// ACP: a session mode to set (`session/set_mode`). app-server: an approval policy for the thread.
    #[arg(long)]
    pub mode: Option<String>,
    /// ACP: `ID=VALUE` for `session/set_config_option`. app-server: `key=json` for the thread's `config`.
    #[arg(long)]
    pub set_config: Vec<String>,
    /// An HTTP MCP server to give the session (ACP `mcpServers`, app-server `config.mcp_servers`).
    #[arg(long)]
    pub mcp_url: Option<String>,
    /// The variable that holds the MCP bearer token. Its value is masked in the transcript.
    #[arg(long)]
    pub mcp_token_env: Option<String>,
    /// More MCP servers, `NAME=URL`, each with the same token. `--mcp-url` is the server named `spike`.
    #[arg(long)]
    pub mcp_server: Vec<String>,
    /// The server the driver treats as the session's own endpoint (Codex `default_tools_approval_mode`).
    #[arg(long, default_value = "spike")]
    pub own_server: String,
    /// claude: give the MCP server by the `mcp_set_servers` control request on stdin instead of `--mcp-config`.
    #[arg(long)]
    pub mcp_via_control: bool,
    /// app-server and claude: MCP tool timeout in seconds for the spike server.
    #[arg(long)]
    pub mcp_tool_timeout: Option<u64>,
    /// ACP: a JSON object sent as `_meta` of `session/new` (claude-agent-acp reads `claudeCode.options` there).
    #[arg(long)]
    pub session_meta: Option<String>,
    /// Stop after setup (initialize and session): lists models, tools and capabilities.
    #[arg(long)]
    pub list_only: bool,
    /// Seconds to keep stdin open after the last turn, to see what the agent does while idle.
    #[arg(long, default_value_t = 0.0)]
    pub keep_open: f64,
    /// Seconds to wait for the agent to exit after stdin is closed, before it is killed.
    #[arg(long, default_value_t = 20.0)]
    pub exit_wait: f64,
    #[arg(long, default_value_t = 600.0)]
    pub turn_timeout: f64,
    /// Writes `{"driver": pid, "agent": pid}` here once the agent is spawned.
    #[arg(long)]
    pub pid_file: Option<PathBuf>,
    /// More variables whose values are secrets and must be masked.
    #[arg(long)]
    pub redact_env: Vec<String>,
    /// `KEY=VALUE` set in the agent's environment.
    #[arg(long)]
    pub env: Vec<String>,
    /// The agent's command line.
    #[arg(last = true, required = true)]
    pub command: Vec<String>,
}

impl Common {
    pub fn env_pairs(&self) -> Vec<(String, String)> {
        self.env
            .iter()
            .filter_map(|e| {
                e.split_once('=')
                    .map(|(k, v)| (k.to_string(), v.to_string()))
            })
            .collect()
    }

    pub fn transcript(&self) -> Transcript {
        let mut names = self.redact_env.clone();
        names.extend(self.mcp_token_env.clone());
        Transcript::create(&self.transcript, &names).expect("transcript file")
    }

    pub fn spawn(&self, t: Transcript) -> agent::Agent {
        self.spawn_without(t, &[])
    }

    /// Spawns the agent with `remove` taken out of its environment.
    pub fn spawn_without(&self, t: Transcript, remove: &[String]) -> agent::Agent {
        let a = agent::spawn(&self.command, &self.cwd, &self.env_pairs(), remove, t)
            .expect("spawn agent");
        if let Some(p) = &self.pid_file {
            std::fs::write(
                p,
                json!({ "driver": std::process::id(), "agent": a.child.id() }).to_string(),
            )
            .expect("pid file");
        }
        a
    }

    /// Every MCP server to give the session, by name.
    pub fn servers(&self) -> Vec<(String, String)> {
        self.mcp_url
            .iter()
            .map(|u| ("spike".to_string(), u.clone()))
            .chain(self.mcp_server.iter().filter_map(|s| {
                s.split_once('=')
                    .map(|(n, u)| (n.to_string(), u.to_string()))
            }))
            .collect()
    }

    pub fn mcp_token(&self) -> Option<String> {
        self.mcp_token_env
            .as_ref()
            .and_then(|n| std::env::var(n).ok())
    }
}

/// Per turn: when to cancel, and the first text seen (time to first token).
pub struct Turn {
    pub index: usize,
    pub started: Instant,
    pub cancel_at: Option<Duration>,
    pub cancelled: bool,
    pub first_text: bool,
    pub permissions: usize,
}

impl Turn {
    pub fn new(index: usize, o: &Common) -> Self {
        let cancel_at = if index == 0 {
            o.cancel_after.map(Duration::from_secs_f64)
        } else {
            None
        };
        Turn {
            index,
            started: Instant::now(),
            cancel_at,
            cancelled: false,
            first_text: false,
            permissions: 0,
        }
    }

    pub fn due_to_cancel(&self) -> bool {
        !self.cancelled && self.cancel_at.is_some_and(|d| self.started.elapsed() >= d)
    }

    pub fn saw_text(&mut self, t: &Transcript) {
        if !self.first_text {
            self.first_text = true;
            t.note("first_text", json!({ "turn": self.index, "ms_after_prompt": self.started.elapsed().as_millis() as u64 }));
        }
    }

    /// Allow or deny for the next permission request under `policy`; None means leave it unanswered.
    pub fn decide(&mut self, policy: Policy) -> Option<bool> {
        let n = self.permissions;
        self.permissions += 1;
        match policy {
            Policy::None => None,
            Policy::Allow => Some(true),
            Policy::Deny => Some(false),
            Policy::Alt => Some(n.is_multiple_of(2)),
        }
    }
}

fn main() {
    let cli = Cli::parse();
    // A driver's transcript is redacted again as a whole when the run ends: a value split across streamed
    // deltas is only visible joined. A driver killed on purpose leaves this to the script's exit trap.
    let finished = |o: &Common| {
        let r = redact::Redactor::new(
            &o.redact_env
                .iter()
                .cloned()
                .chain(o.mcp_token_env.clone())
                .collect::<Vec<_>>(),
        );
        redact::redact_file(&r, &o.transcript).expect("redact the transcript");
    };
    match cli.cmd {
        Cmd::Acp(o) => {
            acp::run(&o);
            finished(&o)
        }
        Cmd::Claude(o) => {
            claude::run(&o);
            finished(&o)
        }
        Cmd::AppServer(o) => {
            app_server::run(&o);
            finished(&o)
        }
        Cmd::AgyStream(o) => {
            lines::agy_stream(&o);
            finished(&o)
        }
        Cmd::Raw(o) => {
            lines::raw(&o);
            finished(&o)
        }
        Cmd::Mcp(o) => mcp::serve(&o),
        Cmd::Redact { files } => {
            let r = redact::Redactor::new(&["SPIKE_MCP_TOKEN".to_string()]);
            for f in files {
                redact::redact_file(&r, &f).expect("redact");
            }
        }
    }
}
