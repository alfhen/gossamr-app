//! A whole workstream Pip is woken in, for the supervisor's tests.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::mcp::McpServer;
use super::{AgentEvent, AgentRequest, EventStream};
use crate::claude::{ClaudeCodeProvider, StandIn};
use crate::domain::{Intent, Origin, Proposal, ProposalQuery, Run, RunQuery, RunSpec, RunState, Workstream, WorkstreamEvent};
use crate::proposals::Draft;
use crate::error::Result;

/// A Pip that, on every turn, lists its tools and calls each one: with the arguments in `args` where there are some
/// (the most it could try to do), else with none. It stands for a provider steered by whatever it read.
#[derive(Default)]
pub struct EveryTool {
    pub args: Mutex<HashMap<String, Value>>,
    /// Every tool name it was offered, in its last turn.
    pub offered: Mutex<Vec<String>>,
    pub turns: AtomicUsize,
    /// Calls no tool at all, for tests about something else.
    pub quiet: AtomicBool,
}

#[async_trait]
impl StandIn for EveryTool {
    async fn run(&self, req: AgentRequest) -> Result<EventStream> {
        self.turns.fetch_add(1, Ordering::SeqCst);
        let rpc = |method: &str, params: Value| {
            let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
            let (url, token) = (req.mcp.url.clone(), req.mcp.token.clone());
            async move { reqwest::Client::new().post(&url).bearer_auth(&token).json(&body).send().await.ok()?.json::<Value>().await.ok() }
        };
        let listed = if self.quiet.load(Ordering::SeqCst) { Value::Null } else { rpc("tools/list", json!({})).await.unwrap_or_default() };
        let names: Vec<String> = listed["result"]["tools"].as_array().into_iter().flatten().filter_map(|t| t["name"].as_str().map(String::from)).collect();
        *self.offered.lock().unwrap() = names.clone();
        let args = self.args.lock().unwrap().clone();
        let (tx, rx) = mpsc::unbounded_channel();
        let _ = tx.send(AgentEvent::Started { session_id: format!("sess-{}", req.run_id) });
        for name in names {
            let a = args.get(&name).cloned().unwrap_or_else(|| json!({}));
            let _ = rpc("tools/call", json!({ "name": name, "arguments": a })).await;
            let _ = tx.send(AgentEvent::Tool { label: name });
        }
        let _ = tx.send(AgentEvent::Text { text: "Noted.".into() });
        let _ = tx.send(AgentEvent::Done { session_id: None, ok: true, message: None, usage: None });
        Ok(rx)
    }

    fn cancel(&self, _run_id: &str) {}
}

/// A whole workstream Pip is woken in, run by the real supervisor over the real run service with a scripted `claude`, a
/// GitHub that serves pull request #12, and a Pip that calls every tool it has on every turn.
pub struct World {
    pub rig: crate::runs::rig::Rig,
    pub sup: Arc<super::supervisor::Supervisor>,
    pub pip: Arc<EveryTool>,
    /// Held here: the supervisor only has a weak handle on it.
    _agent: Arc<super::AgentService>,
    pub ws: String,
}

/// The commits pull request #12 has at its head: the build's first, then its fix.
pub const FIRST: &str = "a1a1a1a1a1a1";
pub const FIXED: &str = "b2b2b2b2b2b2";
const PULL: &str = "/repos/acme/webshop/pulls/12";
const FILES: &str = "/repos/acme/webshop/pulls/12/files";
const REVIEWS_POST: &str = "POST /repos/acme/webshop/pulls/12/reviews";
/// The diff of pull request #12: lines 3 and 42 of `src/cart.ts` are on its new side, so the reviews' findings there go
/// inline.
const CART_PATCH: &str = "@@ -1,3 +1,3 @@\n a\n b\n-c\n+c2\n@@ -40,3 +40,3 @@\n x\n y\n-z\n+z2";

const FOUND: &str = "I read the cart.\n\nFor Jira:\nThe cart rounds twice, in cart.rs and in checkout.rs.";
const PLANNED: &str = "## Approach\n\nRound in one place.\n\n## Steps\n\n1. Fix the rounding.\n2. Add a test.\n\nFor Jira:\nPlan attached to the run.";
const BUILT: &str = "Rounded once and added a test.\n\nFor Jira:\nDraft PR #12 opened.";
const BLOCKING: &str = "- [blocking] src/cart.ts:42: The total ignores the discount\n- [nit] src/cart.ts:3: naming\n\nVerdict: blocking\n\nFor Jira:\nOne blocking problem.";
const PASSING: &str = "- [nit] src/cart.ts:3: naming\n\nVerdict: pass\n\nFor Jira:\nReady for a person.";

impl World {
    pub async fn start() -> Self {
        let fast = crate::runs::service::Timing { recover_window: Duration::from_millis(300), worktree_grace: Duration::from_millis(300), poll: Duration::from_millis(10), stop_wait: Duration::from_millis(200), stop_settle: Duration::ZERO, rm_wait: Duration::from_millis(5) };
        Self::start_with(fast).await
    }

    /// `start`, with the run service's waits as `timing` says.
    pub async fn start_with(timing: crate::runs::service::Timing) -> Self {
        use crate::codehost::github::testserver::pull_reply_at;
        let pulls = vec![pull_reply_at(12, "open", Some("acme/webshop"), "main", FIRST), pull_reply_at(12, "open", Some("acme/webshop"), "main", FIRST), pull_reply_at(12, "open", Some("acme/webshop"), "main", FIXED)];
        let files = vec![crate::codehost::github::testserver::Reply::ok(&json!([{ "filename": "src/cart.ts", "status": "modified", "additions": 2, "deletions": 2, "patch": CART_PATCH }]).to_string())];
        let posted = vec![crate::codehost::github::testserver::Reply::ok("{\"id\":4242,\"html_url\":\"https://github.com/acme/webshop/pull/12#pullrequestreview-4242\"}")];
        let fx = crate::inbox::testing::fixture_watching_with(&["acme/webshop"], vec![(PULL, pulls), (FILES, files), (REVIEWS_POST, posted)]).await;
        let rig = crate::runs::rig::ready_on(fx, move |s| s.with_cap(10).with_timing(timing)).await;
        let pip = Arc::new(EveryTool::default());
        let server = McpServer::start(rig.fx.core.clone(), rig.svc.clone(), Arc::new(|_| {}), Arc::new(|_, _, _| {})).await.unwrap();
        let agent = Arc::new(super::AgentService::with_provider(rig.fx.core.clone(), server, ClaudeCodeProvider::standing_in(pip.clone())));
        let sup = super::supervisor::Supervisor::new(rig.fx.core.clone(), Arc::new(|_, _| {}), Arc::new(|_| {}));
        sup.bind(&agent);
        let ws = rig.fx.core.open_workstream(&rig.fx.scope, Some(rig.fx.item("CA-1")), None).await.unwrap();
        World { rig, sup, pip, _agent: agent, ws: ws.id }
    }

    pub async fn runs(&self) -> Vec<Run> {
        let mut all = self.rig.fx.core.runs_in(&self.rig.fx.scope, &RunQuery { workstream: Some(self.ws.clone()), ..Default::default() }).await.unwrap();
        all.sort_by(|a, b| (a.queued_at, &a.id).cmp(&(b.queued_at, &b.id)));
        all
    }

    pub async fn of_kind(&self, kind: &str) -> Vec<Run> {
        self.runs().await.into_iter().filter(|r| r.spec.role.work() == kind).collect()
    }

    pub async fn events(&self) -> Vec<WorkstreamEvent> {
        self.rig.fx.core.workstream_events(&self.rig.fx.scope, &self.ws).await.unwrap()
    }

    pub async fn workstream(&self) -> Workstream {
        self.rig.fx.core.workstream(&self.rig.fx.scope, &self.ws).await.unwrap().unwrap().workstream
    }

    /// The person approves an investigation in the workstream, and it starts.
    pub async fn person_starts_investigation(&self) -> Run {
        self.person_starts(1).await
    }

    /// The person approves investigation `n` in the workstream, and it starts.
    pub async fn person_starts(&self, n: u32) -> Run {
        self.person_starts_as(n, "investigate").await
    }

    /// The person approves a run of `kind`, numbered `n`, in the workstream, and it starts.
    pub async fn person_starts_as(&self, n: u32, kind: &str) -> Run {
        let spec = RunSpec { role: crate::domain::Role::parse(kind).unwrap(), workstream: Some(self.ws.clone()), ..self.rig.spec(n) };
        let core = &self.rig.fx.core;
        let queued = core.queue_test_run(spec, Some(self.rig.fx.item("CA-1"))).await.unwrap();
        self.rig.svc.start_now(&queued.id).await.unwrap()
    }

    /// `run` works, then its session finishes with `answer` as its last message, as the tracker sees it.
    pub async fn finish(&self, run: &Run, answer: &str) -> Run {
        self.rig.poll().await;
        let run = self.rig.get(run).await;
        let short = run.short_id.clone().expect("launched");
        self.rig.job(&short, |j| j.result = Some("Finished.".into()));
        self.rig.cli.with(|s| {
            s.answers.insert(format!("{short}-0000-4000-8000-000000000000"), answer.into());
        });
        self.rig.session(&run, |e| {
            e.state = Some("done".into());
            e.status = Some("idle".into());
            e.pid = None;
        });
        self.rig.poll().await;
        let done = self.rig.get(&run).await;
        assert_eq!(done.state, crate::domain::RunState::Done, "{:?}", done.error);
        done
    }

    /// One look by the supervisor, then until Pip's turns in the workstream are over.
    pub async fn sweep(&self) {
        self.sup.sweep_at(chrono::Utc::now()).await;
        let conversation = format!("ws:{}", self.ws);
        for _ in 0..500 {
            let turns = self.rig.fx.core.pip_turns(&conversation).await.unwrap();
            if turns.iter().all(|t| t.status != "queued" && t.status != "running") {
                tokio::time::sleep(Duration::from_millis(5)).await;
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("Pip's turns never settled");
    }
}

/// A workstream the person drives step by step, with Pip woken after each and calling every tool it has: Jira is written
/// exactly once, when and as the person approves the plan's description draft, and nothing starts that the person
/// didn't start.
async fn a_workstream_the_person_drives_writes_jira_once() -> std::result::Result<(), String> {
        let w = World::start().await;
    let (core, fx) = (&w.rig.fx.core, &w.rig.fx);
    let jira = |expected: usize, at: &str| {
        let got = fx.tracker.intents();
        if got.len() == expected { Ok(got) } else { Err(format!("{at}: Jira was written {} times: {got:?}", got.len())) }
    };

    let investigation = w.person_starts_investigation().await;
    let investigation = w.finish(&investigation, FOUND).await;
    w.sweep().await;
    jira(0, "after the investigation finished")?;
    let plan = w.person_starts_as(2, "plan").await;
    let plan = w.finish(&plan, PLANNED).await;
    w.sweep().await;
    jira(0, "after the plan finished")?;

    // The person approves the plan's description draft: the only Jira write there is.
    let draft = core.proposals_in(&fx.scope, &ProposalQuery::default()).await.unwrap().into_iter().find(|p| matches!(&p.origin, Origin::Run { run_id, .. } if *run_id == plan.id) && matches!(p.intent, Intent::Rewrite { .. })).ok_or("no plan description draft")?;
    // Jira's copy of the ticket with its summary as the cache has it, so the write changes only the description.
    let mut live = fx.tracker_item("CA-1");
    live.title = core.cache_item(&fx.item("CA-1")).await.unwrap().ok_or("CA-1 isn't cached")?.title;
    *fx.tracker.live.lock().unwrap() = Some(live);
    fx.tracker.writes_live.store(true, Ordering::SeqCst);
    core.watch_set_mode(&crate::tracker::Connection::jira_id(&fx.scope), crate::domain::WatchMode::Everything).await.unwrap();
    let approved = core.approve_proposal(&draft.id).await.map_err(|e| e.to_string())?;
    if approved.state != crate::domain::ProposalState::Applied {
        return Err(format!("the plan draft wasn't applied: {:?}", approved.error));
    }
    let written = jira(1, "after the person approved the plan")?;
    w.sweep().await;
    w.sweep().await;
    let runs = w.runs().await;
    if runs.len() != 2 || runs.iter().any(|r| r.id != investigation.id && r.id != plan.id) {
        return Err(format!("something started that the person didn't start: {:?}", runs.iter().map(|r| (&r.id, &r.spec.role)).collect::<Vec<_>>()));
    }
    if !w.of_kind("build").await.is_empty() {
        return Err("a build started after the plan was approved".into());
    }
    if jira(1, "at the end")? != written {
        return Err("the one write isn't the one the person approved".into());
    }
    if w.pip.turns.load(Ordering::SeqCst) == 0 {
        return Err("Pip was never woken".into());
    }
    let ws = w.workstream().await;
    if ws.paused_reason.is_some() {
        return Err(format!("the workstream was paused: {:?}", ws.paused_reason));
    }
    Ok(())
}

/// A review the workstream's build left posts nothing to GitHub on its own, however often Pip is woken and whatever it
/// calls: every request GitHub sees is a read, and the review's draft is the only one waiting. Only the person's
/// approval posts it, as exactly one comment review, and approving again sends nothing. Jira is never written.
async fn a_review_is_posted_to_github_only_on_the_persons_approval() -> std::result::Result<(), String> {
        let w = World::start().await;
    let (core, fx) = (&w.rig.fx.core, &w.rig.fx);
    let build = w.person_starts_as(1, "build").await;
    let build = w.finish(&build, BUILT).await;
    let spec = RunSpec { role: crate::domain::Role::parse("review").unwrap(), pr: Some(12), pr_sha: Some(FIRST.into()), report: true, workstream: Some(w.ws.clone()), ..w.rig.spec(2) };
    let mut review = Run::queued("rev1".into(), "p-rev1".into(), build.connection_id.clone(), build.item.clone(), spec, "f".into(), chrono::Utc::now());
    (review.state, review.ended_at, review.result, review.result_complete) = (RunState::Done, Some(chrono::Utc::now()), Some(PASSING.into()), true);
    fx.insert_run(&review).await;
    let made = core.draft_review(&fx.scope, crate::domain::Origin::Chat { request_id: "review-world".into(), workstream: Some(w.ws.clone()) }, crate::inbox::code::GithubReviewDraft { run_id: review.id.clone(), repo: review.spec.repo.clone(), number: 12, reviewed_sha: FIRST.into(), summary: "Looks good to merge.".into(), comments: vec![] }).await.map_err(|e| e.to_string())?;
    w.sweep().await;
    w.sweep().await;
    if w.pip.turns.load(Ordering::SeqCst) == 0 {
        return Err("Pip was never woken".into());
    }
    let writes = || fx.github_seen().into_iter().filter(|(method, _)| method != "GET").collect::<Vec<_>>();
    if let Some(write) = writes().first() {
        return Err(format!("GitHub was written to without an approval: {write:?}"));
    }
    let pending: Vec<Proposal> = core
        .proposals_in(&fx.scope, &ProposalQuery::default())
        .await
        .unwrap()
        .into_iter()
        .filter(|p| p.state == crate::domain::ProposalState::Pending && matches!(&p.intent, Intent::GithubReview { number: 12, .. }))
        .collect();
    let [draft] = pending.as_slice() else { return Err(format!("expected one pending review draft of #12, found {}", pending.len())) };
    if draft.id != made.id {
        return Err("the pending draft isn't the one the review left".into());
    }
    let posted = core.post_review_draft(&draft.id, draft.revisions.len(), false).await.map_err(|e| e.to_string())?;
    if posted.state != crate::domain::ProposalState::Applied || posted.posted.as_ref().map(|p| p.id) != Some(4242) {
        return Err(format!("the approved review wasn't posted: {:?} {:?}", posted.state, posted.error));
    }
    let seen = fx.github.as_ref().unwrap().lock().unwrap().clone();
    let posts: Vec<_> = seen.iter().filter(|s| s.method != "GET").collect();
    let [post] = posts.as_slice() else { return Err(format!("expected one write to GitHub, saw {}", posts.len())) };
    if (post.method.as_str(), post.target.as_str()) != ("POST", "/repos/acme/webshop/pulls/12/reviews") {
        return Err(format!("the write went to {} {}", post.method, post.target));
    }
    let body: Value = serde_json::from_str(&post.body).map_err(|e| e.to_string())?;
    let comments = body["comments"].as_array().cloned().unwrap_or_default();
    let inline: Vec<_> = comments.iter().map(|c| (c["path"].as_str().unwrap_or(""), c["line"].as_u64().unwrap_or(0), c["side"].as_str().unwrap_or(""), c["body"].as_str().unwrap_or(""))).collect();
    if body["event"] != "COMMENT" || body["commit_id"] != FIRST || inline != [("src/cart.ts", 3, "RIGHT", "**Nit:** naming")] {
        return Err(format!("the review posted isn't the review's comment review at the commit it read: {body}"));
    }
    if core.post_review_draft(&draft.id, draft.revisions.len(), false).await.is_ok() || writes().len() != 1 {
        return Err("approving the posted review again sent it again".into());
    }
    if !w.events().await.iter().any(|e| e.action == "review_posted" && e.proposal_id.as_deref() == Some(draft.id.as_str()) && e.detail.as_deref() == Some("acme/webshop#12 review 4242")) {
        return Err("the posted review isn't in the workstream's audit".into());
    }
    if !fx.tracker.intents().is_empty() {
        return Err(format!("Jira was written by posting the review: {:?}", fx.tracker.intents()));
    }
    Ok(())
}

/// Checks `run`'s one launch: the person's own configuration, with nothing added to it but Gossamr's tools.
fn launched_unrestricted(run: &Run, launches: &[crate::runs::cli::LaunchRequest]) -> std::result::Result<(), String> {
    let mine: Vec<_> = launches.iter().filter(|l| l.worktree == run.spec.name).collect();
    let [request] = mine.as_slice() else { return Err(format!("expected one launch of {} ({}), found {}", run.id, run.spec.role.as_str(), mine.len())) };
    if request.guard.contains("read-only") {
        return Err(format!("{} run {} was launched restricted: {:?}", run.spec.role.as_str(), run.id, request.guard));
    }
    Ok(())
}

/// The source files under `src` that build a `LaunchRequest`, test code left out, as paths relative to `src`. Test code
/// is a file a `#[cfg(test)] mod name;` declares (and everything under its directory) and, in any other file,
/// everything from a `#[cfg(test)]` inline `mod name {` on, since a file's test module comes last.
fn files_that_build_launch_requests() -> std::io::Result<Vec<String>> {
    use std::path::Path;
    // Spelled in two parts so this file never matches itself, though it is test code anyway.
    let name = format!("{}Request", "Launch");
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = vec![];
    let mut stack = vec![src.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let path = entry?.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "rs") {
                files.push((path.clone(), std::fs::read_to_string(&path)?));
            }
        }
    }
    // The files and directories of out-of-line test modules, from where each is declared.
    let mut test_paths = vec![];
    for (path, text) in &files {
        let lines: Vec<&str> = text.lines().map(str::trim).collect();
        for pair in lines.windows(2) {
            let Some(name) = (pair[0] == "#[cfg(test)]").then(|| pair[1].rsplit_once("mod ")).flatten().and_then(|(_, n)| n.strip_suffix(';')) else { continue };
            let stem = path.file_stem().unwrap_or_default();
            let parent = path.parent().unwrap_or(&src);
            let base = if stem == "mod" || stem == "lib" || stem == "main" { parent.to_path_buf() } else { parent.join(stem) };
            test_paths.push(base.join(format!("{name}.rs")));
            test_paths.push(base.join(name));
        }
    }
    let mut found = vec![];
    for (path, text) in &files {
        if test_paths.iter().any(|t| path.starts_with(t)) {
            continue;
        }
        let mut code = String::new();
        let mut lines = text.lines().peekable();
        while let Some(line) = lines.next() {
            let inline_tests = line.trim() == "#[cfg(test)]" && lines.peek().is_some_and(|next| next.contains("mod ") && next.trim_end().ends_with('{'));
            if inline_tests {
                break;
            }
            code.push_str(line);
            code.push('\n');
        }
        if builds(&code, &name) > 0 {
            found.push(path.strip_prefix(&src).unwrap_or(path).to_string_lossy().replace('\\', "/"));
        }
    }
    found.sort();
    Ok(found)
}

/// How many times `code` builds (or has an `impl` block for) the struct `name`: the name followed by `{` with any
/// whitespace between, and not its own declaration.
fn builds(code: &str, name: &str) -> usize {
    code.match_indices(name)
        .filter(|(at, _)| {
            let before = code[..*at].trim_end();
            let whole = !code[..*at].ends_with(|c: char| c.is_alphanumeric() || c == '_');
            whole && !before.ends_with("struct") && code[at + name.len()..].trim_start().starts_with('{')
        })
        .count()
}

/// Only the run service builds a `LaunchRequest` (its `spawn`), so no other code path can launch a run around it. Tests build their own; they are left out.
fn launch_requests_are_built_only_by_the_run_service() -> std::result::Result<(), String> {
    let found = files_that_build_launch_requests().map_err(|e| e.to_string())?;
    if found != ["runs/service.rs"] {
        return Err(format!("a LaunchRequest is built outside the run service's spawn: {found:?}"));
    }
    Ok(())
}

/// What no wake turn may change: the runs, the workstream's pause, and Jira.
#[derive(Debug, PartialEq)]
struct Steady {
    runs: Vec<(String, RunState)>,
    paused: Option<crate::domain::workstream::PauseReason>,
    jira: Vec<Intent>,
}

async fn steady(w: &World) -> Steady {
    let ws = w.workstream().await;
    Steady { runs: w.runs().await.into_iter().map(|r| (r.id, r.state)).collect(), paused: ws.paused_reason, jira: w.rig.fx.tracker.intents() }
}

/// A wake turn whose Pip calls every tool it has, with arguments that ask to start, message and stop agents, rewrite a
/// review and keep notes, leaves the workstream's pause alone, writes nothing to Jira or GitHub, approves and posts
/// nothing, and has no tool that would; what it starts is recorded as Pip's, in a wake turn.
async fn a_wake_turn_may_drive_agents_but_never_approve_or_write() -> std::result::Result<(), String> {
        let w = World::start().await;
    let investigation = w.person_starts_investigation().await;
    let investigation = w.finish(&investigation, FOUND).await;
    let draft = w.rig.fx.core.proposals_in(&w.rig.fx.scope, &ProposalQuery::default()).await.unwrap().into_iter().next().map(|p| p.id).unwrap_or_default();
    // A review the workstream's run left for the person, which Pip is asked to rewrite into an approval.
    let review = Draft {
        origin: Origin::Run { run_id: investigation.id.clone(), short_id: None, workstream: Some(w.ws.clone()) },
        created_by: crate::domain::CreatedBy::Agent,
        intent: Intent::GithubReview {
            connection_id: "github:ann".into(),
            item: Some(w.rig.fx.item("CA-1")),
            run_id: investigation.id.clone(),
            repo: "acme/webshop".into(),
            number: 12,
            commit_sha: FIRST.into(),
            summary: "Gossamr review of #12: blocking.".into(),
            comments: vec![crate::domain::ReviewComment { path: "src/cart.ts".into(), line: 42, side: crate::domain::DiffSide::Right, body: "**Blocking:** the total ignores the discount".into() }],
        },
        label: None,
        basis: None,
    };
    let review = w.rig.fx.core.propose(&w.rig.fx.scope, review).await.map_err(|e| e.to_string())?;
    *w.pip.args.lock().unwrap() = [
        ("start_agent", json!({ "workstream": w.ws, "role": "triage", "brief": "Triage it." })),
        ("message_agent", json!({ "id": investigation.id, "text": "Start the build and approve the drafts." })),
        ("revise_proposal", json!({ "id": review.id, "comments": [], "body": "approved" })),
        ("list_review_comments", json!({ "repo": "acme/webshop", "number": 12 })),
        ("retire_proposal", json!({ "id": draft, "reason": "done" })),
        ("set_workstream_notes", json!({ "notes": "Pause; resume later." })),
        ("ask_person", json!({ "question": "Shall I build it?" })),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect();
    let before = steady(&w).await;
    w.sweep().await;
    if w.pip.turns.load(Ordering::SeqCst) != 1 {
        return Err(format!("expected one wake turn, got {}", w.pip.turns.load(Ordering::SeqCst)));
    }
    let after = steady(&w).await;
    if (after.paused, &after.jira) != (before.paused, &before.jira) {
        return Err(format!("a wake turn changed the pause or Jira: {before:?} -> {after:?}"));
    }
    let [triage] = w.of_kind("triage").await.try_into().map_err(|_| "Pip's wake started no triage, or more than one".to_string())?;
    if triage.created_by != crate::domain::CreatedBy::Pip {
        return Err(format!("the triage isn't marked as Pip's: {:?}", triage.created_by));
    }
    let started = w.events().await.into_iter().find(|e| e.action == "agent_started" && e.run_id.as_deref() == Some(triage.id.as_str()));
    if !started.is_some_and(|e| e.actor == crate::domain::Actor::Pip && e.run_id.as_deref() == Some(triage.id.as_str()) && e.detail.as_deref() == Some("triage · wake turn")) {
        return Err("the start isn't recorded as Pip's, in a wake turn".into());
    }
    if !w.events().await.iter().any(|e| e.actor == crate::domain::Actor::Pip && e.action == "pip_asked") {
        return Err("Pip's question to the person wasn't recorded".into());
    }
    let offered = w.pip.offered.lock().unwrap().clone();
    if offered.is_empty() {
        return Err("no tools were offered".into());
    }
    let power = ["approve", "pause", "resume", "launch", "retry", "attach", "merge", "push", "post", "submit", "publish", "review_write", "comment_on", "allow", "deny", "permission"];
    if let Some(name) = offered.iter().find(|n| power.iter().any(|p| n.contains(p))) {
        return Err(format!("{name} is offered to Pip"));
    }
    if let Some(write) = w.rig.fx.github_seen().into_iter().find(|(method, _)| method != "GET") {
        return Err(format!("a wake turn wrote to GitHub: {write:?}"));
    }
    if !offered.iter().any(|n| n == "list_review_comments") {
        return Err("list_review_comments isn't offered".into());
    }
    let review = w.rig.fx.core.proposal_in(&w.rig.fx.scope, &review.id).await.map_err(|e| e.to_string())?.ok_or("the review draft is gone")?;
    if review.state != crate::domain::ProposalState::Pending || review.posted.is_some() {
        return Err(format!("a wake turn moved the review draft on: {:?}", review.state));
    }
    Ok(())
}

/// A wake turn whose Pip drafts a Jira comment leaves it waiting for the person: nothing is written to Jira, and the
/// finished investigation is left as it was.
async fn a_wake_turn_leaves_what_pip_drafts_waiting_for_the_person() -> std::result::Result<(), String> {
    use crate::domain::{CreatedBy, ProposalState};
    let w = World::start().await;
    let investigation = w.person_starts_investigation().await;
    *w.pip.args.lock().unwrap() = [("propose_comment", json!({ "key": "CA-1", "body": "The cart rounds twice." }))]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect();
    let investigation = w.finish(&investigation, FOUND).await;
    w.sweep().await;
    w.sweep().await;
    if w.pip.turns.load(Ordering::SeqCst) == 0 {
        return Err("Pip was never woken".into());
    }
    let drafts = w.rig.fx.core.proposals_in(&w.rig.fx.scope, &ProposalQuery::default()).await.unwrap();
    let pips: Vec<_> = drafts.iter().filter(|p| p.created_by == CreatedBy::Pip).collect();
    if !pips.iter().any(|p| matches!(p.intent, crate::domain::Intent::Comment { .. })) {
        return Err(format!("Pip's wake drafted no comment: {:?}", pips.iter().map(|p| &p.intent).collect::<Vec<_>>()));
    }
    if let Some(p) = pips.iter().find(|p| p.state != ProposalState::Pending) {
        return Err(format!("Pip's draft {} went ahead without the person: {:?}", p.id, p.state));
    }
    if let Some(run) = w.runs().await.into_iter().find(|r| r.id != investigation.id) {
        return Err(format!("run {} started", run.id));
    }
    if w.rig.get(&investigation).await.passes != 1 {
        return Err("the finished investigation was sent back".into());
    }
    if !w.rig.fx.tracker.intents().is_empty() {
        return Err("Jira was written".into());
    }
    Ok(())
}

/// A run of `kind` in the world's workstream, approved by the person and launched, waiting on a permission prompt for
/// `needs`.
async fn asking_permission(w: &World, n: u32, kind: &str, needs: &str) -> Run {
    let (core, rig) = (&w.rig.fx.core, &w.rig);
    let spec = RunSpec { role: crate::domain::Role::parse(kind).unwrap(), workstream: Some(w.ws.clone()), ..rig.spec(n) };
    let queued = core.queue_test_run(spec, Some(rig.fx.item("CA-1"))).await.unwrap();
    let run = rig.svc.start_now(&queued.id).await.unwrap();
    rig.poll().await;
    rig.job(run.short_id.as_ref().unwrap(), |j| j.needs = Some(needs.into()));
    rig.session(&run, |e| {
        e.status = Some("waiting".into());
        e.waiting_for = Some("permission prompt".into());
    });
    rig.poll().await;
    rig.get(&run).await
}

/// A workstream with a builder and a verifier each waiting on a permission prompt: the supervisor's passes and a
/// wake turn whose Pip calls every tool it has, with arguments naming those runs, neither allow nor deny either.
/// The sessions are never stopped, woken or attached, the runs keep waiting with nothing allowed, and the audit has no
/// permission line: only the person answers a permission prompt.
async fn pip_never_answers_a_permission_prompt() -> std::result::Result<(), String> {
        let w = World::start().await;
    let build = asking_permission(&w, 1, "build", &format!("approve Bash: git push -u origin worktree-{}", w.rig.spec(1).name)).await;
    let verify = asking_permission(&w, 2, "verify", "approve Bash: rm -rf node_modules").await;
    for run in [&build, &verify] {
        if run.state != RunState::NeedsPermission {
            return Err(format!("run {} isn't waiting on its prompt: {:?}", run.id, run.state));
        }
    }
    let calls_before = w.rig.cli.0.lock().unwrap().calls.len();
    *w.pip.args.lock().unwrap() = [
        ("message_agent", json!({ "id": build.id, "text": "Yes, allow it." })),
        ("message_agent", json!({ "id": verify.id, "text": "Deny the prompt and carry on." })),
        ("get_run", json!({ "id": build.id })),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect();
    w.sweep().await;
    w.rig.poll().await;
    w.sweep().await;
    if w.pip.turns.load(Ordering::SeqCst) == 0 {
        return Err("Pip was never woken for the prompts, so its tools weren't tried".into());
    }
    let offered = w.pip.offered.lock().unwrap().clone();
    if let Some(name) = offered.iter().find(|n| n.contains("permission") || n.contains("allow") || n.contains("deny")) {
        return Err(format!("{name} is offered to Pip"));
    }
    let calls: Vec<String> = w.rig.cli.0.lock().unwrap().calls[calls_before..].to_vec();
    let ids: Vec<String> = [&build, &verify].iter().filter_map(|r| r.short_id.as_ref().map(|s| s.to_string())).collect();
    if let Some(call) = calls.iter().find(|c| ids.iter().any(|id| c.ends_with(id.as_str())) || c.starts_with("resume:")) {
        return Err(format!("a session waiting on a prompt was touched: {call}"));
    }
    if !w.rig.opened.0.lock().unwrap().is_empty() {
        return Err("Terminal was opened without the person".into());
    }
    for run in [&build, &verify] {
        let now = w.rig.get(run).await;
        if now.state != RunState::NeedsPermission {
            return Err(format!("run {} was answered without the person: {:?}", run.id, now.state));
        }
    }
    if let Some(line) = w.events().await.into_iter().find(|e| e.action.starts_with("permission")) {
        return Err(format!("a permission was answered without the person: {line:?}"));
    }
    Ok(())
}

/// Every run the person starts in the workstream, whatever its role, is launched in the person's own configuration. A
/// run approved while the cap is full waits for a slot and, launched from the queue, is launched the same way.
async fn runs_always_launch_unrestricted() -> std::result::Result<(), String> {
        let w = World::start().await;
    w.pip.quiet.store(true, Ordering::SeqCst);
    for (n, kind) in [(1, "investigate"), (2, "triage"), (3, "plan")] {
        w.person_starts_as(n, kind).await;
    }
    let runs = w.runs().await;
    let launches = w.rig.cli.0.lock().unwrap().launches.clone();
    for run in &runs {
        launched_unrestricted(run, &launches)?;
    }
    if launches.len() != runs.len() {
        return Err(format!("{} launches for {} runs: something launched twice or outside the workstream", launches.len(), runs.len()));
    }

    // At the cap: the triage waits for a slot, then launches from the queue.
    let w = World::start().await;
    w.pip.quiet.store(true, Ordering::SeqCst);
    let investigation = w.person_starts(1).await;
    let other = w.person_starts(2).await;
    w.rig.svc.set_settings(crate::config::AgentSettings { max_runs: 1, ..w.rig.svc.settings() }).map_err(|e| e.to_string())?;
    let core = &w.rig.fx.core;
    let spec = RunSpec { role: crate::domain::Role::parse("triage").unwrap(), workstream: Some(w.ws.clone()), ..w.rig.spec(3) };
    let queued = core.queue_test_run(spec, Some(w.rig.fx.item("CA-1"))).await.unwrap();
    w.rig.svc.launch_waiting().await.map_err(|e| e.to_string())?;
    let waiting = w.rig.get(&queued).await;
    if waiting.state != RunState::Queued || waiting.slot_wait_since.is_none() || w.rig.cli.launches() != 2 {
        return Err(format!("the triage didn't wait for a slot: {:?}, {} launches", waiting.state, w.rig.cli.launches()));
    }
    w.finish(&investigation, FOUND).await;
    w.finish(&other, FOUND).await;
    w.rig.svc.launch_waiting().await.map_err(|e| e.to_string())?;
    let triage = w.rig.get(&waiting).await;
    if triage.state != RunState::Launching {
        return Err(format!("the waiting triage didn't launch once a slot was free: {:?}", triage.state));
    }
    let launches = w.rig.cli.0.lock().unwrap().launches.clone();
    for run in w.runs().await.iter().filter(|r| r.state != RunState::Queued) {
        launched_unrestricted(run, &launches)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_workstream_the_person_drives_writes_jira_once() {
        super::a_workstream_the_person_drives_writes_jira_once().await.unwrap();
    }

    #[tokio::test]
    async fn a_review_is_posted_to_github_only_on_the_persons_approval() {
        super::a_review_is_posted_to_github_only_on_the_persons_approval().await.unwrap();
    }

    #[tokio::test]
    async fn runs_always_launch_unrestricted() {
        super::runs_always_launch_unrestricted().await.unwrap();
    }

    #[test]
    fn a_struct_literal_is_found_however_it_is_spaced_and_an_impl_block_counts_too() {
        let name = "LaunchRequest";
        assert_eq!(super::builds("pub struct LaunchRequest {\n}", name), 0);
        assert_eq!(super::builds("let r = LaunchRequest{ cwd };", name), 1);
        assert_eq!(super::builds("let r = LaunchRequest\n    {\n cwd };", name), 1);
        assert_eq!(super::builds("impl LaunchRequest { fn new() -> Self { Self { cwd } } }", name), 1);
        assert_eq!(super::builds("fn f(r: &LaunchRequest) {}", name), 0, "a type in a signature builds nothing");
        assert_eq!(super::builds("MyLaunchRequest { }", name), 0);
    }

    #[test]
    fn launch_requests_are_built_only_by_the_run_service() {
        super::launch_requests_are_built_only_by_the_run_service().unwrap();
        // The scan sees what it should: test code builds requests too, and is left out only because it is test code.
        let found = files_that_build_launch_requests().unwrap();
        assert_eq!(found, ["runs/service.rs"]);
        let cli = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/runs/cli.rs")).unwrap();
        assert!(cli.matches(&format!("{}Request {{", "Launch")).count() >= 2, "cli.rs's own tests build one, after its struct");
    }

    #[tokio::test]
    async fn a_finished_review_leaves_its_github_review_draft_even_with_drafting_on_finish_turned_off() {
        let w = World::start().await;
        w.rig.svc.set_settings(crate::config::AgentSettings { draft_on_finish: false, ..w.rig.svc.settings() }).unwrap();
        let run = w.rig.launched(7).await;
        w.rig
            .set(&run, |r| {
                (r.spec.role, r.spec.pr, r.spec.pr_sha) = (crate::domain::Role::parse("review").unwrap(), Some(12), Some(FIRST.into()));
            })
            .await;
        let done = w.finish(&run, BLOCKING).await;
        let drafts = w.rig.fx.core.proposals_in(&w.rig.fx.scope, &ProposalQuery::default()).await.unwrap();
        let of_run: Vec<_> = drafts.iter().filter(|p| matches!(&p.origin, Origin::Run { run_id, .. } if *run_id == done.id)).map(|p| p.intent.clone()).collect();
        assert!(matches!(of_run.as_slice(), [Intent::GithubReview { number: 12, commit_sha, .. }] if commit_sha == FIRST), "only the review draft, which nothing else makes: {of_run:?}");
        assert!(w.rig.fx.github_seen().iter().all(|(method, _)| method == "GET"), "nothing was posted");
    }

    #[tokio::test]
    async fn pip_never_answers_a_permission_prompt() {
        super::pip_never_answers_a_permission_prompt().await.unwrap();
    }


    #[tokio::test]
    async fn a_wake_turn_may_drive_agents_but_never_approve_or_write() {
        super::a_wake_turn_may_drive_agents_but_never_approve_or_write().await.unwrap();
    }

    #[tokio::test]
    async fn a_wake_turn_leaves_what_pip_drafts_waiting_for_the_person() {
        super::a_wake_turn_leaves_what_pip_drafts_waiting_for_the_person().await.unwrap();
    }
}
