//! A whole workstream Pip manages, for the supervisor's tests.

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

/// A whole workstream Pip manages, run by the real supervisor over the real run service with a scripted `claude`, a
/// GitHub that serves pull request #12, and a Pip that calls every tool it has on every turn.
pub struct World {
    pub rig: crate::runs::rig::Rig,
    pub sup: Arc<super::supervisor::Supervisor>,
    pub pip: Arc<EveryTool>,
    /// Held here: the supervisor only has a weak handle on it.
    pub agent: Arc<super::AgentService>,
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
const TRIAGED: &str = "Small, one area.\n\nFor Jira:\nIt touches the cart only.\nPlan recommended: yes, the rounding has two callers.";
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
        let facade = super::supervisor::CoreFacade::new(rig.fx.core.clone());
        facade.bind_runs(&rig.svc);
        let pip = Arc::new(EveryTool::default());
        let server = McpServer::start(rig.fx.core.clone(), rig.svc.clone(), Arc::new(|_| {}), Arc::new(|_, _, _| {})).await.unwrap();
        let agent = Arc::new(super::AgentService::with_provider(rig.fx.core.clone(), server, ClaudeCodeProvider::standing_in(pip.clone())));
        let sup = super::supervisor::Supervisor::new(facade, Arc::new(crate::config::AgentSettings::default), Arc::new(|_, _| {}), Arc::new(|_| {}));
        sup.bind(&agent);
        let (core, scope) = (&rig.fx.core, &rig.fx.scope);
        let ws = core.open_workstream(scope, Some(rig.fx.item("CA-1")), None).await.unwrap();
        core.set_workstream_mode(scope, &ws.id, crate::domain::workstream::Mode::Manage, crate::domain::Actor::Person).await.unwrap();
        let mut roomy = ws.clone();
        roomy.mode = crate::domain::workstream::Mode::Manage;
        roomy.budget.auto_turns = Some(50);
        roomy.budget.wakes = Some(50);
        rig.fx.save_workstream(&roomy).await;
        World { rig, sup, pip, agent, ws: ws.id }
    }

    pub async fn runs(&self) -> Vec<Run> {
        let mut all = self.rig.fx.core.runs_in(&self.rig.fx.scope, &RunQuery { workstream: Some(self.ws.clone()), ..Default::default() }).await.unwrap();
        all.sort_by(|a, b| (a.queued_at, &a.id).cmp(&(b.queued_at, &b.id)));
        all
    }

    pub async fn of_kind(&self, kind: crate::domain::RunKind) -> Vec<Run> {
        self.runs().await.into_iter().filter(|r| r.spec.kind == kind).collect()
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
        let spec = RunSpec { workstream: Some(self.ws.clone()), ..self.rig.spec(n) };
        let core = &self.rig.fx.core;
        let p = core.draft_run(spec, Some(self.rig.fx.item("CA-1"))).await.unwrap();
        let digest = core.runs_review(&p.id).await.unwrap().digest;
        let queued = core.runs_approve(&p.id, &digest).await.unwrap();
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

    /// The build's draft pull request at `sha`, as a GitHub sync caches it.
    pub fn surface_pr(&self, build: &Run, sha: &str) {
        let mut change = crate::codehost::links::tests::pr(12, &format!("worktree-{}", build.spec.name), "Fix the cart", "");
        change.sha = Some(sha.into());
        self.rig.fx.core.with_code_db("github:ann", |db| db.upsert_code_changes(&[change], "2026-09-29T00:00:00Z")).unwrap();
    }

    /// The one auto-started run of `kind` after `after`, checked to have started with the rule's line in the audit.
    pub async fn started(&self, kind: crate::domain::RunKind, rule: crate::domain::workstream::Rule, after: &Run) -> std::result::Result<Run, String> {
        let found = self.of_kind(kind).await.into_iter().filter(|r| r.auto_start.as_ref().is_some_and(|a| a.after_run == after.id)).collect::<Vec<_>>();
        let [run] = found.as_slice() else { return Err(format!("expected one {kind:?} after {}, found {}", after.id, found.len())) };
        if run.auto_start.as_ref().map(|a| a.rule) != Some(rule) || run.state != crate::domain::RunState::Launching || run.spec.focus.is_some() {
            return Err(format!("{kind:?} didn't start by {rule:?} without a focus: {run:?}"));
        }
        let detail = format!("{} after {}", rule.as_str(), after.id);
        let line = self.events().await.into_iter().find(|e| e.action == "autostart" && e.run_id.as_deref() == Some(run.id.as_str()));
        if line.as_ref().map(|l| (l.detail.as_deref(), l.digest.as_deref())) != Some((Some(detail.as_str()), Some(run.digest.as_str()))) {
            return Err(format!("no autostart line with the digest and rule for {}: {line:?}", run.id));
        }
        Ok(run.clone())
    }
}

/// A whole workstream in Manage mode, investigate to a passing review with one fix round, run through the real
/// supervisor: every routine step starts by rule, and Jira is written exactly once, when and as the person approves
/// the plan's description draft. Pip's turns, which call every tool they have, write nothing.
async fn orchestration_never_writes_jira() -> std::result::Result<(), String> {
    let w = World::start().await;
    manage_to_a_passing_review(&w).await?;
    let (core, fx) = (&w.rig.fx.core, &w.rig.fx);
    // Each review left a GitHub review draft of the pull request, the second replacing the first, and nothing was posted:
    // GitHub was only ever read.
    let reviews: Vec<_> = core.proposals_in(&fx.scope, &ProposalQuery::default()).await.unwrap().into_iter().filter(|p| matches!(p.intent, Intent::GithubReview { .. })).collect();
    let states: Vec<_> = reviews.iter().map(|p| (p.state.kind(), p.superseded_by.clone())).collect();
    // Both may carry the same timestamp, so the listing's order between them isn't theirs to rely on.
    let waiting: Vec<_> = reviews.iter().filter(|p| p.state.kind() == crate::domain::StateKind::Pending && p.superseded_by.is_none()).collect();
    let replaced: Vec<_> = reviews.iter().filter(|p| p.state.kind() == crate::domain::StateKind::Retired).collect();
    if !(reviews.len() == 2 && matches!((waiting.as_slice(), replaced.as_slice()), ([w], [r]) if r.superseded_by.as_deref() == Some(w.id.as_str()))) {
        return Err(format!("the reviews' GitHub drafts aren't one waiting and one it replaced: {states:?}"));
    }
    if let Some(write) = fx.github_seen().into_iter().find(|(method, _)| method != "GET") {
        return Err(format!("GitHub was written to without an approval: {write:?}"));
    }
    Ok(())
}

/// The whole workstream of `orchestration_never_writes_jira`: investigate, triage, plan, the person approving the plan,
/// a build, a blocking review, a fix round and a passing review, with Pip woken and calling every tool. Checked to
/// have written Jira exactly once, as the person approved.
async fn manage_to_a_passing_review(w: &World) -> std::result::Result<(), String> {
    use crate::domain::workstream::Rule;
    use crate::domain::RunKind;
    let (core, fx) = (&w.rig.fx.core, &w.rig.fx);
    let jira = |expected: usize, at: &str| {
        let got = fx.tracker.intents();
        if got.len() == expected { Ok(got) } else { Err(format!("{at}: Jira was written {} times: {got:?}", got.len())) }
    };

    let investigation = w.person_starts_investigation().await;
    let investigation = w.finish(&investigation, FOUND).await;
    w.sweep().await;
    let triage = w.started(RunKind::Triage, Rule::InvestigateTriage, &investigation).await?;
    if triage.spec.findings_from_run.as_deref() != Some(investigation.id.as_str()) {
        return Err("the triage doesn't carry the investigation's findings".into());
    }
    jira(0, "after the triage started")?;

    let triage = w.finish(&triage, TRIAGED).await;
    w.sweep().await;
    let plan = w.started(RunKind::Plan, Rule::TriagePlan, &triage).await?;
    let plan = w.finish(&plan, PLANNED).await;
    w.sweep().await;
    jira(0, "after the plan finished")?;
    if !w.of_kind(RunKind::Build).await.is_empty() {
        return Err("a build started before the person approved the plan".into());
    }

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
    w.sup.on_proposal_applied(Some(&w.ws));
    tokio::time::sleep(Duration::from_millis(50)).await;
    w.sweep().await;
    let build = w.started(RunKind::Build, Rule::PlanBuild, &plan).await?;
    if !(build.spec.allow_push && build.spec.plan_approved && build.spec.plan_from_run.as_deref() == Some(plan.id.as_str())) {
        return Err(format!("the build doesn't follow the approved plan to a draft pull request: {:?}", build.spec));
    }

    // The build finishes; its review waits until a sync finds the pull request.
    let build = w.finish(&build, BUILT).await;
    w.sweep().await;
    if !w.of_kind(RunKind::Review).await.is_empty() || !w.events().await.iter().any(|e| e.action == "waiting_for_pr" && e.run_id.as_deref() == Some(build.id.as_str())) {
        return Err("a review started before the pull request was found, or the wait wasn't recorded".into());
    }
    w.surface_pr(&build, FIRST);
    w.sweep().await;
    let review = w.started(RunKind::Review, Rule::BuildReview, &build).await?;
    if (review.spec.pr, review.spec.pr_sha.as_deref(), review.spec.report) != (Some(12), Some(FIRST), true) {
        return Err(format!("the review doesn't read the pull request's head: {:?}", review.spec));
    }

    // It blocks: a fix round goes to the build with the finding as data, and nothing of a ticket.
    let resumes_before = w.rig.cli.0.lock().unwrap().resumes.len();
    let review = w.finish(&review, BLOCKING).await;
    w.sweep().await;
    let resumes = w.rig.cli.0.lock().unwrap().resumes.clone();
    let [sent] = &resumes[resumes_before..] else { return Err(format!("expected one fix round, got {:?}", &resumes[resumes_before..])) };
    let fix = &sent.message;
    if !(fix.contains("<<<FINDINGS\nsrc/cart.ts:42: The total ignores the discount\nFINDINGS>>>") && fix.contains(super::autostart::FIX_PREFACE) && fix.contains(super::autostart::FIX_INSTRUCTION)) || fix.contains("naming") {
        return Err(format!("the fix round isn't the blocking finding as data and the fixed instruction: {fix}"));
    }
    if !super::context::keys_in(fix).is_empty() {
        return Err(format!("the fix round names a ticket: {fix}"));
    }
    if w.rig.get(&build).await.state != crate::domain::RunState::Working {
        return Err("the build didn't go back to work".into());
    }
    let events = w.events().await;
    if !events.iter().any(|e| e.action == "fix_round_sent" && e.run_id.as_deref() == Some(build.id.as_str())) || !events.iter().any(|e| e.action == "autostart" && e.detail.as_deref() == Some(&format!("fix_round after {}", review.id))) {
        return Err("the fix round isn't in the audit".into());
    }
    jira(1, "after the fix round")?;

    // The fix is pushed; until a sync sees the new commit nothing starts, then a fresh review reads it and passes.
    let build = w.finish(&build, BUILT).await;
    w.sweep().await;
    if w.of_kind(RunKind::Review).await.len() != 1 {
        return Err("a review started on a commit already reviewed".into());
    }
    w.surface_pr(&build, FIXED);
    w.sweep().await;
    let reviews: Vec<Run> = w.of_kind(RunKind::Review).await;
    let again = reviews.last().filter(|r| r.id != review.id).ok_or("no fresh review")?.clone();
    if again.spec.pr_sha.as_deref() != Some(FIXED) || again.auto_start.as_ref().map(|a| a.rule) != Some(Rule::BuildReview) {
        return Err(format!("the fresh review doesn't read the fixed commit: {:?}", again.spec.pr_sha));
    }
    w.finish(&again, PASSING).await;
    w.sweep().await;
    w.sweep().await;
    if !w.of_kind(RunKind::Verify).await.is_empty() || w.of_kind(RunKind::Review).await.len() != 2 || w.of_kind(RunKind::Build).await.len() != 1 {
        return Err("something started after the passing review".into());
    }
    let after = jira(1, "at the end")?;
    if after != written {
        return Err("the one write isn't the one the person approved".into());
    }
    if w.pip.turns.load(Ordering::SeqCst) == 0 {
        return Err("Pip was never woken".into());
    }
    let ws = w.workstream().await;
    if ws.held_reason.is_some() {
        return Err(format!("the workstream was held: {:?}", ws.held_reason));
    }
    Ok(())
}

/// The same whole workstream posts nothing to GitHub on its own: every request GitHub sees is a read, and the second
/// review's draft is the only one waiting. Only the person's approval posts it, as exactly one comment review at the
/// fixed commit, and approving again sends nothing. Jira is still written only the once.
async fn orchestration_never_posts_to_github() -> std::result::Result<(), String> {
    let w = World::start().await;
    manage_to_a_passing_review(&w).await?;
    let (core, fx) = (&w.rig.fx.core, &w.rig.fx);
    let jira_before = fx.tracker.intents();
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
    if body["event"] != "COMMENT" || body["commit_id"] != FIXED || inline != [("src/cart.ts", 3, "RIGHT", "**Nit:** naming")] {
        return Err(format!("the review posted isn't the passing review's comment review at the fixed commit: {body}"));
    }
    if core.post_review_draft(&draft.id, draft.revisions.len(), false).await.is_ok() || writes().len() != 1 {
        return Err("approving the posted review again sent it again".into());
    }
    if !w.events().await.iter().any(|e| e.action == "review_posted" && e.proposal_id.as_deref() == Some(draft.id.as_str()) && e.detail.as_deref() == Some("acme/webshop#12 review 4242")) {
        return Err("the posted review isn't in the workstream's audit".into());
    }
    if fx.tracker.intents() != jira_before || jira_before.len() != 1 {
        return Err(format!("Jira was written by posting the review: {:?}", fx.tracker.intents()));
    }
    Ok(())
}

/// Checks `run`'s one launch against its kind: a read-only kind launched with its spec's restriction and the read-only
/// sentence in its guard, recorded on the run too; a Build with neither.
fn launched_as_its_kind_allows(run: &Run, launches: &[crate::runs::cli::LaunchRequest]) -> std::result::Result<(), String> {
    use crate::domain::READ_ONLY_GUARD;
    let mine: Vec<_> = launches.iter().filter(|l| l.worktree == run.spec.name).collect();
    let [request] = mine.as_slice() else { return Err(format!("expected one launch of {} ({:?}), found {}", run.id, run.spec.kind, mine.len())) };
    let restriction = run.spec.read_only();
    if run.spec.kind.read_only() {
        if restriction.is_none() || request.read_only != restriction || run.read_only != restriction {
            return Err(format!("{:?} run {} launched without its restriction: {:?} (run says {:?})", run.spec.kind, run.id, request.read_only, run.read_only));
        }
        if !request.guard.contains(READ_ONLY_GUARD) {
            return Err(format!("{:?} run {}'s guard doesn't say it is read-only: {}", run.spec.kind, run.id, request.guard));
        }
    } else if request.read_only.is_some() || run.read_only.is_some() || restriction.is_some() || request.guard.contains(READ_ONLY_GUARD) {
        return Err(format!("{:?} run {} was launched restricted: {:?}", run.spec.kind, run.id, request.read_only));
    }
    Ok(())
}

/// Every run of the managed workstream, person-started or started by a rule, launched as its kind allows: each read-only
/// kind (Investigate, Triage, Plan, Review) with the restriction Claude Code enforces, the Build with none. The fix round
/// reached the Build as a wake of its own session, never a new launch: a wake takes no flags, so the Build keeps what
/// it had and gains nothing. A Triage auto-started while the cap is full waits for a slot and, launched from the
/// queue, is restricted all the same: no path launches a read-only kind without it.
async fn read_only_runs_always_launch_restricted() -> std::result::Result<(), String> {
    use crate::domain::workstream::Rule;
    use crate::domain::RunKind;
    let w = World::start().await;
    manage_to_a_passing_review(&w).await?;
    let runs = w.runs().await;
    let (launches, resumes) = {
        let s = w.rig.cli.0.lock().unwrap();
        (s.launches.clone(), s.resumes.clone())
    };
    for run in &runs {
        launched_as_its_kind_allows(run, &launches)?;
        if run.auto_start.is_some() && run.spec.kind.read_only() && run.read_only.is_none() {
            return Err(format!("auto-started {:?} run {} is unrestricted", run.spec.kind, run.id));
        }
    }
    let kinds: Vec<RunKind> = runs.iter().map(|r| r.spec.kind).collect();
    if kinds != [RunKind::Investigate, RunKind::Triage, RunKind::Plan, RunKind::Build, RunKind::Review, RunKind::Review] {
        return Err(format!("the workstream didn't run the whole chain: {kinds:?}"));
    }
    if launches.len() != runs.len() {
        return Err(format!("{} launches for {} runs: something launched twice or outside the workstream", launches.len(), runs.len()));
    }
    // The fix round is the only wake there was, and it went to the Build's own session.
    let build = runs.iter().find(|r| r.spec.kind == RunKind::Build).ok_or("no build")?;
    let [fix] = resumes.as_slice() else { return Err(format!("expected one wake, the fix round, got {}", resumes.len())) };
    if build.session_id.as_deref() != Some(fix.session_id.as_str()) || build.passes != 2 {
        return Err(format!("the fix round didn't wake the build's own session: {} vs {:?}", fix.session_id, build.session_id));
    }

    // At the cap: the triage waits for a slot, then launches from the queue, restricted.
    let w = World::start().await;
    w.pip.quiet.store(true, Ordering::SeqCst);
    let investigation = w.person_starts(1).await;
    let other = w.person_starts(2).await;
    w.rig.svc.set_settings(crate::config::AgentSettings { max_runs: 1, ..w.rig.svc.settings() }).map_err(|e| e.to_string())?;
    let investigation = w.finish(&investigation, FOUND).await;
    w.sweep().await;
    let after = |r: &Run| r.auto_start.as_ref().is_some_and(|a| a.rule == Rule::InvestigateTriage && a.after_run == investigation.id);
    let waiting = w.of_kind(RunKind::Triage).await.into_iter().find(after).ok_or("no triage after the investigation")?;
    if waiting.state != RunState::Queued || waiting.slot_wait_since.is_none() || w.rig.cli.launches() != 2 {
        return Err(format!("the triage didn't wait for a slot: {:?}, {} launches", waiting.state, w.rig.cli.launches()));
    }
    w.finish(&other, FOUND).await;
    w.rig.svc.launch_waiting().await.map_err(|e| e.to_string())?;
    let triage = w.rig.get(&waiting).await;
    if triage.state != RunState::Launching {
        return Err(format!("the waiting triage didn't launch once a slot was free: {:?}", triage.state));
    }
    let launches = w.rig.cli.0.lock().unwrap().launches.clone();
    for run in w.runs().await.iter().filter(|r| r.state != RunState::Queued) {
        launched_as_its_kind_allows(run, &launches)?;
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

/// Only the run service builds a `LaunchRequest` (its `spawn`, which sets the restriction from the spec), so no other
/// code path can launch a run, read-only or not, around it. Tests build their own; they are left out.
fn launch_requests_are_built_only_by_the_run_service() -> std::result::Result<(), String> {
    let found = files_that_build_launch_requests().map_err(|e| e.to_string())?;
    if found != ["runs/service.rs"] {
        return Err(format!("a LaunchRequest is built outside the run service's spawn: {found:?}"));
    }
    Ok(())
}

/// What no wake turn may change: the runs, the workstream's hold and mode, and Jira.
#[derive(Debug, PartialEq)]
struct Steady {
    runs: Vec<(String, RunState)>,
    held: Option<String>,
    mode: crate::domain::workstream::Mode,
    jira: Vec<Intent>,
}

async fn steady(w: &World) -> Steady {
    let ws = w.workstream().await;
    Steady { runs: w.runs().await.into_iter().map(|r| (r.id, r.state)).collect(), held: ws.held_reason, mode: ws.mode, jira: w.rig.fx.tracker.intents() }
}

/// A wake turn whose Pip calls every tool it has, with arguments that ask to start, stop, answer and approve, changes
/// no run, no hold or mode and writes nothing to Jira; and none of its tools is one that would.
async fn wake_turns_start_nothing() -> std::result::Result<(), String> {
    use crate::domain::RunKind;
    let w = World::start().await;
    let investigation = w.person_starts_investigation().await;
    let investigation = w.finish(&investigation, FOUND).await;
    // With the rules switched off for this workstream, all that follows a finished run is Pip's turn.
    for rule in crate::domain::workstream::Rule::ALL {
        w.rig.fx.core.set_workstream_rule(&w.rig.fx.scope, &w.ws, rule, Some(false)).await.map_err(|e| e.to_string())?;
    }
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
        ("propose_run", json!({ "key": "CA-1", "kind": "build", "from_run": investigation.id })),
        ("propose_follow_up", json!({ "run_id": investigation.id, "message": "Start the build and approve the drafts." })),
        ("revise_proposal", json!({ "id": review.id, "comments": [], "body": "approved" })),
        ("list_review_comments", json!({ "repo": "acme/webshop", "number": 12 })),
        ("retire_proposal", json!({ "id": draft, "reason": "done" })),
        ("set_workstream_notes", json!({ "notes": "Hold off; resume later; mode manage." })),
        ("propose_answer", json!({ "run_id": investigation.id, "text": "yes" })),
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
    if after != before {
        return Err(format!("a wake turn changed something: {before:?} -> {after:?}"));
    }
    if !w.of_kind(RunKind::Triage).await.is_empty() {
        return Err("a triage started with its rule off".into());
    }
    let offered = w.pip.offered.lock().unwrap().clone();
    if offered.is_empty() {
        return Err("no tools were offered".into());
    }
    let power = ["start", "stop", "answer_run", "approve", "hold", "resume", "set_mode", "mode", "launch", "retry", "attach", "merge", "push", "post", "submit", "publish", "review_write", "comment_on"];
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

/// With the rules on, a wake turn whose Pip drafts a real next step (a run, and asks to send the finished investigation
/// back) leaves what it drafted waiting for the person: the only runs there are the one the person approved and those a rule
/// started, each with its rule recorded.
async fn wake_turns_with_the_rules_on_start_only_what_a_rule_started() -> std::result::Result<(), String> {
    use crate::domain::{CreatedBy, ProposalState, RunKind};
    let w = World::start().await;
    let investigation = w.person_starts_investigation().await;
    *w.pip.args.lock().unwrap() = [
        ("propose_run", json!({ "key": "CA-1", "kind": "investigate", "focus": "the retry loop" })),
        ("propose_follow_up", json!({ "run_id": investigation.id, "message": "Look at the retry loop too." })),
    ]
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
    if !pips.iter().any(|p| matches!(p.intent, crate::domain::Intent::StartRun { .. })) {
        return Err(format!("Pip's wake drafted no run: {:?}", pips.iter().map(|p| &p.intent).collect::<Vec<_>>()));
    }
    if let Some(p) = pips.iter().find(|p| p.state != ProposalState::Pending) {
        return Err(format!("Pip's draft {} went ahead without the person: {:?}", p.id, p.state));
    }
    for run in w.runs().await {
        if run.id != investigation.id && run.auto_start.is_none() {
            return Err(format!("run {} started without the person or a rule", run.id));
        }
    }
    w.started(RunKind::Triage, crate::domain::workstream::Rule::InvestigateTriage, &investigation).await?;
    if w.rig.get(&investigation).await.passes != 1 {
        return Err("Pip's follow-up was sent without the person".into());
    }
    if !w.rig.fx.tracker.intents().is_empty() {
        return Err("Jira was written".into());
    }
    Ok(())
}

/// A run of `kind` in the world's workstream, approved by the person and launched, waiting on a permission prompt for
/// `needs`.
async fn asking_permission(w: &World, n: u32, kind: crate::domain::RunKind, needs: &str) -> Run {
    let (core, rig) = (&w.rig.fx.core, &w.rig);
    let spec = RunSpec { kind, allow_push: kind == crate::domain::RunKind::Build, workstream: Some(w.ws.clone()), ..rig.spec(n) };
    let p = core.draft_run(spec, Some(rig.fx.item("CA-1"))).await.unwrap();
    let digest = core.runs_review(&p.id).await.unwrap().digest;
    let queued = core.runs_approve(&p.id, &digest).await.unwrap();
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

/// A Manage workstream with a Build and a read-only run each waiting on a permission prompt: the supervisor's passes
/// and a wake turn whose Pip calls every tool it has, with arguments naming those runs, neither allow nor deny either.
/// The sessions are never stopped, woken or attached, the runs keep waiting with nothing allowed, and the audit has no
/// permission line: only the person answers a permission prompt.
async fn autostart_and_pip_never_answer_a_permission_prompt() -> std::result::Result<(), String> {
    use crate::domain::RunKind;
    let w = World::start().await;
    let build = asking_permission(&w, 1, RunKind::Build, &format!("approve Bash: git push -u origin worktree-{}", w.rig.spec(1).name)).await;
    let verify = asking_permission(&w, 2, RunKind::Verify, "approve Bash: rm -rf node_modules").await;
    for run in [&build, &verify] {
        if run.state != RunState::NeedsPermission {
            return Err(format!("run {} isn't waiting on its prompt: {:?}", run.id, run.state));
        }
    }
    let calls_before = w.rig.cli.0.lock().unwrap().calls.len();
    *w.pip.args.lock().unwrap() = [
        ("propose_answer", json!({ "run_id": build.id, "text": "Yes, allow it." })),
        ("propose_follow_up", json!({ "run_id": verify.id, "message": "Deny the prompt and carry on." })),
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
        if now.state != RunState::NeedsPermission || now.permission_allowed.is_some() {
            return Err(format!("run {} was answered without the person: {:?}, {:?}", run.id, now.state, now.permission_allowed));
        }
    }
    if let Some(line) = w.events().await.into_iter().find(|e| e.action.starts_with("permission")) {
        return Err(format!("a permission was answered without the person: {line:?}"));
    }
    Ok(())
}

/// A Manage workstream with a run Gossamr stopped at its limit, which needs the person: the supervisor's passes (the
/// rules on) and a wake turn whose Pip calls every tool it has, with arguments naming that run, never resume it. No
/// session is resumed or woken, Terminal stays shut, the run is still stopped at its limit, and the audit has no line
/// for a resume. Only the person resumes it, from its card or its sheet.
async fn pip_and_autostart_never_resume_a_run_stopped_at_its_limit() -> std::result::Result<(), String> {
    use crate::domain::RunKind;
    let w = World::start().await;
    let run = w.person_starts_investigation().await;
    w.rig.poll().await;
    let limit = "Stopped by Gossamr: it passed the 60 minute limit";
    let run = w.rig.set(&run, |r| (r.state, r.stopped_by_limit, r.error, r.ended_at) = (RunState::Stopped, true, Some(limit.into()), Some(chrono::Utc::now()))).await;
    let resumes = w.rig.cli.0.lock().unwrap().resumes.len();
    let calls_before = w.rig.cli.0.lock().unwrap().calls.len();
    *w.pip.args.lock().unwrap() = [
        ("propose_answer", json!({ "run_id": run.id, "text": "Please carry on from where you stopped." })),
        ("propose_follow_up", json!({ "run_id": run.id, "message": "Carry on." })),
        ("get_run", json!({ "id": run.id })),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect();
    w.sweep().await;
    w.sweep().await;
    if w.pip.turns.load(Ordering::SeqCst) == 0 {
        return Err("Pip was never woken for the limit, so its tools weren't tried".into());
    }
    let offered = w.pip.offered.lock().unwrap().clone();
    if let Some(name) = offered.iter().find(|n| n.contains("resume") || n.contains("answer_run") || n.contains("continue")) {
        return Err(format!("{name} is offered to Pip"));
    }
    let resumed = {
        let after = w.rig.cli.0.lock().unwrap();
        after.resumes.len() != resumes || after.calls[calls_before..].iter().any(|c| c.starts_with("resume:"))
    };
    if resumed {
        return Err("the run's session was resumed without the person".into());
    }
    if !w.rig.opened.0.lock().unwrap().is_empty() {
        return Err("Terminal was opened without the person".into());
    }
    let now = w.rig.get(&run).await;
    if now.state != RunState::Stopped || !now.stopped_by_limit || now.continued_at != run.continued_at {
        return Err(format!("the run was resumed without the person: {:?}, stopped at its limit {}", now.state, now.stopped_by_limit));
    }
    if let Some(started) = w.of_kind(RunKind::Investigate).await.into_iter().find(|r| r.id != run.id) {
        return Err(format!("a rule started a run after it: {}", started.id));
    }
    if let Some(line) = w.events().await.into_iter().find(|e| e.action.contains("resume") && e.actor != crate::domain::Actor::Person) {
        return Err(format!("a resume was recorded without the person: {line:?}"));
    }
    Ok(())
}

/// A Manage workstream whose build was sent its two automatic fix rounds and whose newest review still blocks: the
/// supervisor gives it to the person (one `fix_rounds_exhausted` line), and more passes and a wake turn whose Pip calls
/// every tool it has, with arguments naming the build and the review, choose none of the person's options. No
/// `fix_round_person` or `escalation_taken` line, the workstream stays in Manage, the build isn't resumed again, the
/// review's GitHub draft stays pending, and nothing is written to GitHub or Jira.
async fn pip_and_autostart_never_choose_an_escalation_option() -> std::result::Result<(), String> {
    use crate::domain::{workstream::Mode, Actor, RunKind, StateKind};
    let w = World::start().await;
    let (core, fx, scope) = (&w.rig.fx.core, &w.rig.fx, &w.rig.fx.scope);
    let spec = RunSpec { kind: RunKind::Build, allow_push: true, workstream: Some(w.ws.clone()), ..w.rig.spec(1) };
    let p = core.draft_run(spec, Some(fx.item("CA-1"))).await.unwrap();
    let queued = core.runs_approve(&p.id, &core.runs_review(&p.id).await.unwrap().digest).await.unwrap();
    let build = w.rig.svc.start_now(&queued.id).await.map_err(|e| e.to_string())?;
    let build = w.finish(&build, BUILT).await;
    for n in 1..=2 {
        let line = WorkstreamEvent::new(&w.ws, Actor::Supervisor, "autostart", chrono::Utc::now()).run(&build.id).detail(format!("fix_round after rev{n}"));
        core.record_workstream_event(scope, line).await.unwrap();
    }
    let spec = RunSpec { kind: RunKind::Review, build_from_run: Some(build.id.clone()), pr: Some(12), pr_sha: Some(FIXED.into()), report: true, workstream: Some(w.ws.clone()), ..w.rig.spec(2) };
    let mut review = Run::queued("rev3".into(), "p-rev3".into(), build.connection_id.clone(), build.item.clone(), spec, "f".into(), chrono::Utc::now());
    (review.state, review.ended_at, review.result, review.result_complete) = (RunState::Done, Some(chrono::Utc::now()), Some(BLOCKING.into()), true);
    fx.insert_run(&review).await;
    let draft = core.auto_draft_run_review(&review.id).await.map_err(|e| e.to_string())?.ok_or("the review left no GitHub draft")?;
    let resumes = w.rig.cli.0.lock().unwrap().resumes.len();
    *w.pip.args.lock().unwrap() = [
        ("propose_follow_up", json!({ "run_id": build.id, "message": "Fix the blocking finding again." })),
        ("get_run", json!({ "id": review.id })),
        ("get_proposal", json!({ "id": draft.id })),
        ("revise_proposal", json!({ "id": draft.id, "summary": "Post this as it is." })),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect();
    w.sweep().await;
    w.sweep().await;
    w.sweep().await;
    if w.pip.turns.load(Ordering::SeqCst) == 0 {
        return Err("Pip was never woken for the review, so its tools weren't tried".into());
    }
    let offered = w.pip.offered.lock().unwrap().clone();
    if let Some(name) = offered.iter().find(|n| n.contains("escalat") || n.contains("fix_round") || n.contains("take_over") || n.contains("post_review") || n.contains("mode")) {
        return Err(format!("{name} is offered to Pip"));
    }
    let events = w.events().await;
    let exhausted: Vec<_> = events.iter().filter(|e| e.action == "fix_rounds_exhausted").collect();
    if !matches!(exhausted.as_slice(), [e] if e.run_id.as_deref() == Some("rev3")) {
        return Err(format!("the review wasn't given to the person once: {exhausted:?}"));
    }
    if let Some(line) = events.iter().find(|e| matches!(e.action.as_str(), "fix_round_person" | "escalation_taken" | "mode_set") && e.actor != Actor::Person) {
        return Err(format!("an option was chosen without the person: {line:?}"));
    }
    if let Some(line) = events.iter().find(|e| matches!(e.action.as_str(), "fix_round_person" | "escalation_taken" | "fix_round_sent")) {
        return Err(format!("an option was chosen without the person: {line:?}"));
    }
    let view = core.workstream(scope, &w.ws).await.unwrap().ok_or("no workstream")?;
    if view.workstream.mode != Mode::Manage {
        return Err(format!("the workstream left Manage: {:?}", view.workstream.mode));
    }
    if view.escalation.as_ref().map(|e| e.review_run.as_str()) != Some("rev3") {
        return Err(format!("the review isn't waiting for the person: {:?}", view.escalation));
    }
    if w.rig.cli.0.lock().unwrap().resumes.len() != resumes || w.rig.get(&build).await.state != RunState::Done {
        return Err("the build was sent back without the person".into());
    }
    let reviews: Vec<_> = core.proposals_in(scope, &ProposalQuery::default()).await.unwrap().into_iter().filter(|p| matches!(p.intent, Intent::GithubReview { .. })).collect();
    if !matches!(reviews.as_slice(), [p] if p.id == draft.id && p.state.kind() == StateKind::Pending) {
        return Err(format!("the review draft isn't the one waiting: {:?}", reviews.iter().map(|p| (&p.id, p.state.kind())).collect::<Vec<_>>()));
    }
    if let Some(write) = fx.github_seen().into_iter().find(|(method, _)| method != "GET") {
        return Err(format!("GitHub was written to without the person: {write:?}"));
    }
    if !fx.tracker.intents().is_empty() {
        return Err("Jira was written".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn orchestration_never_writes_jira() {
        super::orchestration_never_writes_jira().await.unwrap();
    }

    #[tokio::test]
    async fn orchestration_never_posts_to_github() {
        super::orchestration_never_posts_to_github().await.unwrap();
    }

    #[tokio::test]
    async fn read_only_runs_always_launch_restricted() {
        super::read_only_runs_always_launch_restricted().await.unwrap();
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
                (r.spec.kind, r.spec.pr, r.spec.pr_sha) = (crate::domain::RunKind::Review, Some(12), Some(FIRST.into()));
            })
            .await;
        let done = w.finish(&run, BLOCKING).await;
        let drafts = w.rig.fx.core.proposals_in(&w.rig.fx.scope, &ProposalQuery::default()).await.unwrap();
        let of_run: Vec<_> = drafts.iter().filter(|p| matches!(&p.origin, Origin::Run { run_id, .. } if *run_id == done.id)).map(|p| p.intent.clone()).collect();
        assert!(matches!(of_run.as_slice(), [Intent::GithubReview { number: 12, commit_sha, .. }] if commit_sha == FIRST), "only the review draft, which nothing else makes: {of_run:?}");
        assert!(w.rig.fx.github_seen().iter().all(|(method, _)| method == "GET"), "nothing was posted");
    }

    #[tokio::test]
    async fn autostart_and_pip_never_answer_a_permission_prompt() {
        super::autostart_and_pip_never_answer_a_permission_prompt().await.unwrap();
    }

    #[tokio::test]
    async fn pip_and_autostart_never_resume_a_run_stopped_at_its_limit() {
        super::pip_and_autostart_never_resume_a_run_stopped_at_its_limit().await.unwrap();
    }

    #[tokio::test]
    async fn pip_and_autostart_never_choose_an_escalation_option() {
        super::pip_and_autostart_never_choose_an_escalation_option().await.unwrap();
    }

    #[tokio::test]
    async fn wake_turns_start_nothing() {
        super::wake_turns_start_nothing().await.unwrap();
    }

    #[tokio::test]
    async fn wake_turns_with_the_rules_on_start_only_what_a_rule_started() {
        super::wake_turns_with_the_rules_on_start_only_what_a_rule_started().await.unwrap();
    }

}
