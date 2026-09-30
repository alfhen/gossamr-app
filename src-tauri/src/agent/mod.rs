//! Pip's assistant runs. An `AgentProvider` drives one agent (a CLI, an API) against Pip's local MCP tools and reports
//! neutral events; `AgentService` prepares each run's prompt and screen context and routes events to the page.

pub mod context;
mod github;
pub mod mcp;

#[cfg(test)]
pub(crate) mod conformance;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::config::AppConfig;
use crate::domain::{ProposalQuery, StateKind};
use crate::error::{Error, Result};
use crate::inbox::Core;
use context::ScreenContext;
use mcp::McpServer;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AgentEvent {
    Started { session_id: String },
    Text { text: String },
    /// A step the agent took, in words a person can read.
    Tool { label: String },
    Done { session_id: Option<String>, ok: bool, message: Option<String> },
}

/// Pip's local MCP server, the only tool surface a run is given.
#[derive(Debug, Clone)]
pub struct McpEndpoint {
    pub url: String,
    pub token: String,
}

pub struct AgentRequest {
    pub run_id: String,
    pub system: String,
    /// Screen context, open drafts and the person's request, already composed.
    pub prompt: String,
    pub mcp: McpEndpoint,
    pub cwd: PathBuf,
    /// Continues an earlier session where the provider can. Never needed for correctness: the prompt is complete.
    pub session: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentCaps {
    pub mcp: bool,
    pub resume: bool,
    pub streaming: bool,
    pub reads_code: bool,
    /// The agent starts with no way to change files or reach anything but the MCP endpoint.
    pub read_only_sandbox: bool,
}

pub type EventStream = mpsc::UnboundedReceiver<AgentEvent>;

/// Every provider must pass the suite in `conformance.rs`.
#[async_trait]
pub trait AgentProvider: Send + Sync {
    fn id(&self) -> &'static str;

    fn capabilities(&self) -> AgentCaps;

    /// Starts a run. The stream ends with exactly one `Done`, including after a cancel or a crash, and once it has
    /// ended nothing of the run is still executing.
    async fn run(&self, req: AgentRequest) -> Result<EventStream>;

    /// Stops the run; its stream then ends with a failed `Done`. Unknown or finished runs are ignored.
    fn cancel(&self, run_id: &str);
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskRequest {
    pub request_id: String,
    pub prompt: String,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub context: ScreenContext,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    pub request_id: String,
    #[serde(flatten)]
    pub event: AgentEvent,
}

pub type UpdateSink = Arc<dyn Fn(Update) + Send + Sync>;

pub struct AgentService {
    core: Arc<Core>,
    mcp: McpServer,
    providers: HashMap<&'static str, Arc<dyn AgentProvider>>,
    config: Mutex<AppConfig>,
    running: Mutex<HashMap<String, Arc<dyn AgentProvider>>>,
}

impl AgentService {
    pub fn new(core: Arc<Core>, mcp: McpServer, providers: Vec<Arc<dyn AgentProvider>>, config: AppConfig) -> Self {
        let providers = providers.into_iter().map(|p| (p.id(), p)).collect();
        Self { core, mcp, providers, config: Mutex::new(config), running: Mutex::new(HashMap::new()) }
    }

    pub fn cancel(&self, request_id: &str) {
        let provider = self.running.lock().expect("lock poisoned").get(request_id).cloned();
        if let Some(p) = provider {
            p.cancel(request_id);
        }
    }

    pub async fn ask(self: &Arc<Self>, req: AskRequest, sink: UpdateSink) -> Result<()> {
        let id = self.config.lock().expect("lock poisoned").agent_provider.clone();
        let provider = self
            .providers
            .get(id.as_str())
            .cloned()
            .ok_or_else(|| Error::Claude(format!("The assistant provider “{id}” isn't available.")))?;

        let scope = self.core.scope().await?;
        let mut context = req.context.in_connection(&crate::tracker::Connection::jira_id(&scope));
        let mut handed: std::collections::HashSet<String> = context::keys_in(&req.prompt).into_iter().collect();
        if let Some(r) = &context.item {
            handed.insert(r.key.to_uppercase());
            context.unwatched_item = !self.core.is_item_watched(&scope, &r.key).await?;
        }
        let item = match &context.item {
            Some(r) => Some(mcp::describe(&self.core.ticket(&scope, &r.key).await?)),
            None => None,
        };
        let links = match &context.item {
            Some(r) => self.core.dev_links(r).unwrap_or_default(),
            None => Vec::new(),
        };
        let open = ProposalQuery { states: Some(vec![StateKind::Pending, StateKind::Applying]), ..Default::default() };
        let drafts = self.core.proposals_in(&scope, &open).await?;
        let cwd = req
            .cwd
            .as_ref()
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .or_else(dirs::home_dir)
            .ok_or_else(|| Error::Claude("no working folder for the assistant".into()))?;

        let run_id = req.request_id.clone();
        let agent_req = AgentRequest {
            run_id: run_id.clone(),
            system: context::system_prompt(provider.capabilities().reads_code),
            prompt: context::compose(&context, item.as_deref(), &links, &drafts, &req.prompt),
            mcp: self.mcp.endpoint(&run_id),
            cwd: cwd.clone(),
            session: req.session_id.filter(|_| provider.capabilities().resume),
        };

        // Registered before the run starts, since the agent may call the tools straight away.
        self.mcp.runs.lock().expect("lock poisoned").insert(run_id.clone(), mcp::Run { scope, handed });
        self.running.lock().expect("lock poisoned").insert(run_id.clone(), provider.clone());
        let mut events = match provider.run(agent_req).await {
            Ok(e) => e,
            Err(e) => {
                self.finish(&run_id);
                return Err(e);
            }
        };

        let this = self.clone();
        let key = context.item.map(|r| r.key);
        tokio::spawn(async move {
            let mut session = None;
            while let Some(event) = events.recv().await {
                match &event {
                    AgentEvent::Started { session_id } => session = Some(session_id.clone()),
                    AgentEvent::Done { session_id: Some(id), .. } => session = Some(id.clone()),
                    _ => {}
                }
                sink(Update { request_id: run_id.clone(), event });
            }
            if let (Some(id), Some(key)) = (session, key) {
                let _ = this.core.remember_claude_session(&key, &id, &cwd.to_string_lossy()).await;
            }
            this.finish(&run_id);
        });
        Ok(())
    }

    fn finish(&self, run_id: &str) {
        self.running.lock().expect("lock poisoned").remove(run_id);
        self.mcp.runs.lock().expect("lock poisoned").remove(run_id);
    }
}
