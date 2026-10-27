//! `start_agent`, `message_agent` and `stop_agent` as Pip calls them, over the real run service with a scripted `claude`.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::*;
use crate::agent::mcp::{call_tool, PipRuns};
use crate::codehost::github::testserver::{draft_pull_reply, pull_reply_at};
use crate::domain::workstream::PauseReason;
use crate::domain::{CodeChangeState, ContainerRef, CreatedBy, Origin, Proposal, ProposalQuery, ProposalState, INVESTIGATE_INSTRUCTION};
use crate::inbox::testing::fixture_watching_with;
use crate::runs::rig::{ready_on, Rig};
use crate::runs::service::Timing;

const FAST: Timing = Timing { recover_window: Duration::from_millis(300), worktree_grace: Duration::from_millis(300), poll: Duration::from_millis(10), stop_wait: Duration::from_millis(200), stop_settle: Duration::ZERO, rm_wait: Duration::from_millis(5) };

const PLAN: &str = "## Approach\n\nRound in one place.\n\n## Steps\n\n1. Fix the rounding.\n2. Add a test.\n\nFor Jira:\nRound once, in cart.rs, then test it.";
const BUILT: &str = "Fixed the rounding in cart.rs and added a test.\n\nFor Jira:\nDraft PR opened: https://github.com/acme/webshop/pull/12";
const FOUND: &str = "I read the consumer.\n\nFor Jira:\nThe cart rounds twice, in cart.rs and in checkout.rs.";
const EXTRA: &str = "Marker: also check the refund path.";
const FORK_SHA: &str = "c0ffee1234567";

struct Drive {
    rig: Rig,
    st: McpState,
    changes: Arc<AtomicUsize>,
    ws: String,
}

async fn drive() -> Drive {
    drive_with(10).await
}

/// A workstream on CA-1 and Pip in it, over a run service that lets `cap` agents run at once.
async fn drive_with(cap: usize) -> Drive {
    let pulls = vec![
        ("/repos/acme/webshop/pulls/12", vec![draft_pull_reply(12, Some("acme/webshop"), "main")]),
        ("/repos/acme/webshop/pulls/13", vec![pull_reply_at(13, "open", Some("evil/webshop"), "main", FORK_SHA)]),
    ];
    let fx = fixture_watching_with(&["acme/webshop"], pulls).await;
    fx.add_item(2).await;
    let ws = fx.core.open_workstream(&fx.scope, Some(fx.item("CA-1")), None).await.unwrap().id;
    let rig = ready_on(fx, move |svc| svc.with_cap(cap).with_timing(FAST)).await;
    let runs: PipRuns = Arc::default();
    let changes = Arc::new(AtomicUsize::new(0));
    let counter = changes.clone();
    let st = McpState {
        core: rig.fx.core.clone(),
        tokens: Default::default(),
        sink: Arc::new(|_| {}),
        workstreams: Arc::new(move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
        }),
        view: Arc::new(|_, _, _| {}),
        runs,
        driver: rig.svc.clone(),
    };
    let d = Drive { rig, st, changes, ws };
    d.join("in-ws");
    d
}

impl Drive {
    /// Pip's turn `request` in the workstream's conversation.
    fn join(&self, request: &str) {
        self.st.runs.lock().unwrap().insert(request.into(), PipRun::in_workstream(self.rig.fx.scope.clone(), &self.ws));
    }

    fn join_wake(&self, request: &str) {
        self.st.runs.lock().unwrap().insert(request.into(), PipRun { wake: true, ..PipRun::in_workstream(self.rig.fx.scope.clone(), &self.ws) });
    }

    /// Pip's turn `request` outside any workstream.
    fn join_general(&self, request: &str) {
        self.st.runs.lock().unwrap().insert(request.into(), PipRun::new(self.rig.fx.scope.clone()));
    }

    async fn call(&self, request: &str, name: &str, args: Value) -> (String, bool) {
        let r = call_tool(&self.st, request, &json!({ "name": name, "arguments": args })).await;
        (r["content"][0]["text"].as_str().unwrap().to_string(), r["isError"].as_bool().unwrap())
    }

    async fn ok(&self, request: &str, name: &str, args: Value) -> String {
        let (text, error) = self.call(request, name, args).await;
        assert!(!error, "{name}: {text}");
        text
    }

    async fn err(&self, request: &str, name: &str, args: Value) -> String {
        let (text, error) = self.call(request, name, args).await;
        assert!(error, "{name} should have failed: {text}");
        text
    }

    /// `start_agent` in the workstream, with `args` besides the workstream and role.
    fn start_args(&self, role: &str, extra: Value) -> Value {
        let mut args = json!({ "workstream": self.ws, "role": role });
        if let (Some(all), Some(more)) = (args.as_object_mut(), extra.as_object()) {
            all.extend(more.clone());
        }
        args
    }

    async fn started(&self, request: &str, role: &str, extra: Value) -> Run {
        let reply = self.ok(request, "start_agent", self.start_args(role, extra)).await;
        self.run_named(&reply).await
    }

    async fn refused(&self, request: &str, role: &str, extra: Value) -> String {
        self.err(request, "start_agent", self.start_args(role, extra)).await
    }

    async fn run_by_id(&self, id: &str) -> Run {
        self.rig.fx.core.run(id).await.unwrap().unwrap()
    }

    /// The run a reply says it started or already had.
    async fn run_named(&self, reply: &str) -> Run {
        self.run_by_id(reply.split("(run ").nth(1).unwrap().split(')').next().unwrap()).await
    }

    /// The run once it has left the queue, as the launcher it was handed to moves it.
    async fn launched(&self, run: &Run) -> Run {
        for _ in 0..400 {
            let now = self.run_by_id(&run.id).await;
            if now.state != RunState::Queued && (now.short_id.is_some() || now.state == RunState::Failed) {
                return now;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("run {} was never launched", run.id);
    }

    async fn runs(&self) -> Vec<Run> {
        self.rig.fx.core.runs_in(&self.rig.fx.scope, &RunQuery::default()).await.unwrap()
    }

    async fn drafts(&self) -> Vec<Proposal> {
        self.rig.fx.core.proposals_in(&self.rig.fx.scope, &ProposalQuery::default()).await.unwrap()
    }

    async fn audit(&self) -> Vec<(Actor, String, Option<String>)> {
        let events = self.rig.fx.core.workstream_events(&self.rig.fx.scope, &self.ws).await.unwrap();
        events.into_iter().map(|e| (e.actor, e.action, e.detail)).collect()
    }

    /// A finished run of `kind` on `key`, in workstream `ws` or none, whose whole answer is `result`.
    async fn finished(&self, n: u32, key: &str, kind: RunKind, ws: Option<&str>, result: &str) -> Run {
        let spec = RunSpec { kind, instruction: String::new(), name: format!("eng-1-chain-{n:04x}"), workstream: ws.map(Into::into), ..self.rig.spec(n) };
        let p = self.rig.fx.core.draft_run(spec, Some(self.rig.fx.item(key))).await.unwrap();
        let digest = self.rig.fx.core.runs_review(&p.id).await.unwrap().digest;
        let mut run = self.rig.fx.core.runs_approve(&p.id, &digest).await.unwrap();
        run.state = RunState::Done;
        run.result = Some(result.into());
        run.result_complete = true;
        run.short_id = crate::runs::cli::ShortId::parse(&format!("cd34{n:04x}"));
        run.ended_at = Some(chrono::Utc::now());
        self.rig.fx.core.save_run(&run).await.unwrap();
        run
    }

    /// The build's draft pull request, as a GitHub sync caches it.
    fn found_pr(&self, build: &Run) {
        let mut change = crate::codehost::links::tests::pr(12, &format!("worktree-{}", build.spec.name), "T", "");
        change.state = CodeChangeState::Open;
        self.rig.fx.core.with_code_db("github:ann", |db| db.upsert_code_changes(&[change], "2026-09-29T00:00:00Z")).unwrap();
    }

    /// The plan run's Gossamr Plan description draft, made as the run finished.
    async fn plan_draft(&self, plan: &Run) -> Proposal {
        self.rig.fx.core.auto_draft_run_plan_description(&plan.id).await.unwrap().unwrap()
    }

    /// The person adds `EXTRA` to the plan run's Gossamr Plan draft and approves it.
    async fn settle(&self, made: &Proposal) {
        let Intent::Rewrite { body: Some(b), .. } = &made.intent else { panic!() };
        let body = b.to.to_markdown().replacen("\n\n</details>", &format!("\n\n{EXTRA}\n\n</details>"), 1);
        self.rig.fx.core.edit_proposal(&made.id, &crate::inbox::Edit::Rewrite { title: None, body: Some(body) }).await.unwrap();
        assert_eq!(self.rig.fx.core.approve_proposal(&made.id).await.unwrap().state, ProposalState::Applied);
    }

    /// Only `CA` watched, with another project's ticket `OTH-1` cached and a workstream open on it.
    async fn workstream_out_of_reach(&self) -> String {
        let fx = &self.rig.fx;
        fx.add_in("OTH-1", "OTH").await;
        let ca = fx.core.containers_in(&fx.scope).await.unwrap().remove(0);
        let oth = crate::domain::Container {
            container_ref: ContainerRef { connection_id: ca.container_ref.connection_id.clone(), external_id: "OTH".into() },
            key: "OTH".into(),
            name: "Other".into(),
            workflow: ca.workflow.clone(),
        };
        let id = ca.container_ref.connection_id.clone();
        fx.set_containers(&[ca, oth]).await;
        fx.core.watch_set_mode(&id, crate::domain::WatchMode::Selected).await.unwrap();
        let change = crate::domain::WatchChange { container_id: "CA".into(), watched: Some(true), ..Default::default() };
        fx.core.watch_set_containers(&id, &[change]).await.unwrap();
        fx.core.open_workstream(&fx.scope, Some(fx.item("OTH-1")), None).await.unwrap().id
    }
}

fn spec_of(run: &Run) -> &RunSpec {
    &run.spec
}

#[tokio::test]
async fn start_agent_starts_an_investigation_with_no_draft_and_hands_it_to_the_launcher() {
    let d = drive().await;
    let reply = d.ok("in-ws", "start_agent", d.start_args("investigate", json!({ "brief": "  Look at the retry loop  " }))).await;
    assert!(reply.starts_with("Started R1 (run ") && reply.ends_with("investigate on CA-1 in acme/webshop."), "{reply}");
    let run = d.run_named(&reply).await;

    assert_eq!((run.created_by, run.proposal_id.as_str()), (CreatedBy::Pip, ""));
    assert_eq!(run.origin, Some(Origin::Chat { request_id: "in-ws".into(), workstream: Some(d.ws.clone()) }));
    let spec = spec_of(&run);
    assert_eq!((spec.kind, spec.repo.as_str(), spec.base.as_str(), spec.clone_path.clone()), (RunKind::Investigate, "acme/webshop", "main", d.rig.clone.clone()));
    assert_eq!((spec.instruction.as_str(), spec.focus.as_deref(), spec.report, spec.workstream.as_deref()), (INVESTIGATE_INSTRUCTION, Some("Look at the retry loop"), true, Some(d.ws.as_str())));
    assert!(spec.ticket_block.as_deref().unwrap().starts_with("CA-1: Ticket 1"));
    assert_eq!(run.item, Some(d.rig.fx.item("CA-1")));
    assert!(d.drafts().await.is_empty(), "no draft was made for it");
    assert_eq!(d.audit().await.last(), Some(&(Actor::Pip, "agent_started".to_string(), Some("investigate · conversation".to_string()))));
    assert!(d.changes.load(Ordering::SeqCst) >= 1, "the page hears of the workstream");

    let launched = d.launched(&run).await;
    assert_eq!(launched.state, RunState::Launching);
    assert!(launched.short_id.is_some() && d.rig.cli.launches() == 1);
    assert!(d.rig.cli.0.lock().unwrap().launches[0].prompt.contains("Look at the retry loop"));
}

#[tokio::test]
async fn a_start_in_a_wake_turn_says_so_in_the_audit() {
    let d = drive().await;
    d.join_wake("wake-1");
    d.started("wake-1", "triage", json!({})).await;
    assert_eq!(d.audit().await.last(), Some(&(Actor::Pip, "agent_started".to_string(), Some("triage · wake turn".to_string()))));
}

#[tokio::test]
async fn triage_plan_and_verify_start_with_their_own_templates() {
    let d = drive().await;
    for (n, kind) in [RunKind::Triage, RunKind::Plan, RunKind::Verify].into_iter().enumerate() {
        let request = format!("t{n}");
        d.join(&request);
        let run = d.started(&request, kind.as_str(), json!({})).await;
        let spec = spec_of(&run);
        assert_eq!((spec.kind, spec.instruction.as_str(), spec.pr, spec.allow_push), (kind, crate::domain::default_instruction(kind), None, false));
    }
    assert_eq!(d.runs().await.len(), 3);
}

#[tokio::test]
async fn a_triage_after_an_investigation_carries_its_findings() {
    let d = drive().await;
    let investigation = d.finished(1, "CA-1", RunKind::Investigate, Some(&d.ws), FOUND).await;
    let triage = d.started("in-ws", "triage", json!({})).await;
    assert_eq!((spec_of(&triage).findings.as_deref(), spec_of(&triage).findings_from_run.as_deref()), (Some("The cart rounds twice, in cart.rs and in checkout.rs."), Some(investigation.id.as_str())));
}

#[tokio::test]
async fn a_build_follows_a_settled_plan_and_carries_it_with_a_draft_pull_request() {
    let d = drive().await;
    let plan = d.finished(1, "CA-1", RunKind::Plan, Some(&d.ws), PLAN).await;
    assert_eq!(d.refused("in-ws", "build", json!({})).await, START_BUILD_NEEDS_PLAN);
    let draft = d.plan_draft(&plan).await;
    assert!(d.refused("in-ws", "build", json!({ "from_run": plan.id })).await.contains("the person hasn't settled the plan yet"));
    d.settle(&draft).await;

    let build = d.started("in-ws", "build", json!({ "from_run": plan.id, "brief": "Keep the diff small" })).await;
    let spec = spec_of(&build);
    assert_eq!((spec.kind, spec.instruction.as_str(), spec.repo.as_str()), (RunKind::Build, default_instruction(RunKind::Build), "acme/webshop"));
    assert_eq!((spec.plan_from_run.as_deref(), spec.plan_approved, spec.allow_push), (Some(plan.id.as_str()), true, true));
    assert_eq!((spec.focus.as_deref(), spec.focus_from_run.as_deref(), spec.workstream.as_deref()), (Some("Keep the diff small"), Some(plan.id.as_str()), Some(d.ws.as_str())));
    assert!(spec.plan.as_deref().unwrap().ends_with(EXTRA));
    assert_eq!(build.created_by, CreatedBy::Pip);
}

#[tokio::test]
async fn a_chain_step_gossamr_refuses_is_recorded_as_pips_without_its_text() {
    let d = drive().await;
    let triage = d.finished(1, "CA-1", RunKind::Triage, Some(&d.ws), FOUND).await;
    d.err("in-ws", "start_agent", d.start_args("build", json!({ "from_run": triage.id }))).await;
    d.err("in-ws", "start_agent", d.start_args("review", json!({ "from_run": triage.id }))).await;
    let refused: Vec<_> = d.audit().await.into_iter().filter(|(_, action, _)| action == "chain_refused").collect();
    assert_eq!(refused, [(Actor::Pip, "chain_refused".to_string(), Some("build".to_string())), (Actor::Pip, "chain_refused".to_string(), Some("review".to_string()))]);
    assert!(d.runs().await.iter().all(|r| r.created_by != CreatedBy::Pip), "nothing was started");
}

#[tokio::test]
async fn a_review_follows_a_finished_build_pinned_to_the_commit_of_its_pull_request() {
    let d = drive().await;
    let build = d.finished(1, "CA-1", RunKind::Build, Some(&d.ws), BUILT).await;
    let refused = d.refused("in-ws", "review", json!({ "from_run": build.id })).await;
    assert!(refused.contains("that build has no pull request in this repository yet"), "{refused}");
    d.found_pr(&build);
    assert_eq!(d.refused("in-ws", "review", json!({ "from_run": build.id, "brief": "the tests" })).await, "A review judges the change on its own; it takes no focus note.");
    assert_eq!(d.refused("in-ws", "review", json!({ "from_run": build.id, "pr": 12 })).await, "Pass pr or from_run for a review, not both.");
    assert_eq!(d.refused("in-ws", "review", json!({})).await, START_REVIEW_NEEDS_TARGET);

    let review = d.started("in-ws", "review", json!({ "from_run": build.id })).await;
    let spec = spec_of(&review);
    assert_eq!((spec.kind, spec.pr, spec.pr_sha.as_deref(), spec.base.as_str()), (RunKind::Review, Some(12), Some("a1b2c3d4e5f6"), "main"));
    assert_eq!((spec.build_from_run.as_deref(), spec.report, spec.focus.as_deref(), spec.allow_push), (Some(build.id.as_str()), true, None, false));
    assert!(spec.build_account.as_deref().unwrap().starts_with("Fixed the rounding"));
    let launched = d.launched(&review).await;
    assert!(d.rig.cli.0.lock().unwrap().launches.last().unwrap().prompt.contains("Review pull request #12 in acme/webshop at commit a1b2c3d4e5f6."), "{launched:?}");
}

#[tokio::test]
async fn a_review_or_verify_of_a_pull_request_pins_its_head_and_a_fork_is_refused() {
    let d = drive().await;
    let review = d.started("in-ws", "review", json!({ "pr": 12 })).await;
    let spec = spec_of(&review);
    assert_eq!((spec.pr, spec.pr_sha.as_deref(), spec.build_from_run.clone()), (Some(12), Some("a1b2c3d4e5f6"), None));
    d.join("v");
    let verify = d.started("v", "verify", json!({ "pr": 12 })).await;
    assert_eq!((spec_of(&verify).pr, spec_of(&verify).pr_sha.as_deref()), (Some(12), Some("a1b2c3d4e5f6")));

    d.join("fork");
    for role in ["review", "verify"] {
        let refused = d.refused("fork", role, json!({ "pr": 13 })).await;
        assert!(refused.contains("fork"), "{role}: {refused}");
    }
    assert!(d.refused("fork", "investigate", json!({ "pr": 12 })).await.contains("only a review or a verify takes a pull request"));
    assert!(d.refused("fork", "review", json!({ "pr": "twelve" })).await.contains("pr must be a pull request number"));
    assert_eq!(d.runs().await.len(), 2);
}

#[tokio::test]
async fn an_investigation_in_a_workstream_with_no_ticket_takes_a_watched_repository_and_the_question() {
    let d = drive().await;
    let fx = &d.rig.fx;
    let open = fx.core.open_workstream(&fx.scope, None, Some("Why is the cart slow".into())).await.unwrap().id;
    let args = |extra: Value| {
        let mut all = json!({ "workstream": open, "role": "investigate" });
        all.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        all
    };
    d.join_general("g");
    let reply = d.ok("g", "start_agent", args(json!({ "repo": "ACME/webshop", "brief": "Why does the cart take 4 s to load?" }))).await;
    assert!(reply.ends_with("investigate in acme/webshop with no ticket."), "{reply}");
    let run = d.run_named(&reply).await;
    assert_eq!((run.item.clone(), spec_of(&run).instruction.as_str(), spec_of(&run).workstream.as_deref()), (None, "Why does the cart take 4 s to load?", Some(open.as_str())));
    assert!(spec_of(&run).project.is_some() && spec_of(&run).ends_as_ticket());

    assert!(d.err("g", "start_agent", args(json!({ "brief": "q" }))).await.contains("repo is required with no ticket"));
    assert!(d.err("g", "start_agent", args(json!({ "repo": "acme/webshop" }))).await.contains("brief is required with no ticket"));
    assert!(d.err("g", "start_agent", args(json!({ "repo": "acme/other", "brief": "q" }))).await.contains("isn't a repository the user watches"));
    assert!(d.err("g", "start_agent", args(json!({ "repo": "acme/webshop", "brief": "x".repeat(2_001) }))).await.contains("the most is 2000"));
    let mut plan = args(json!({ "repo": "acme/webshop", "brief": "q" }));
    plan["role"] = "plan".into();
    assert!(d.err("g", "start_agent", plan).await.contains("Only an investigation can run in a workstream with no ticket"));
    assert_eq!(d.runs().await.len(), 1);
}

#[tokio::test]
async fn start_agent_refuses_what_pip_may_not_do_and_starts_nothing() {
    let d = drive().await;
    let go = |args: Value| async { d.err("in-ws", "start_agent", args).await };
    assert!(go(json!({ "workstream": d.ws, "role": "deploy" })).await.contains("role must be investigate, triage, plan, build, review, verify, not deploy"));
    assert!(go(json!({ "workstream": d.ws })).await.contains("role is required"));
    assert!(go(json!({ "role": "plan" })).await.contains("workstream is required"));
    assert!(go(json!({ "workstream": "nope", "role": "plan" })).await.contains("There is no workstream nope"));
    assert!(go(d.start_args("plan", json!({ "brief": "x".repeat(301) }))).await.contains("301 characters; the most is 300"));
    assert!(go(d.start_args("plan", json!({ "brief": "one\ntwo" }))).await.contains("one line"));
    assert!(go(d.start_args("plan", json!({ "from_run": "missing" }))).await.contains("no run missing"));
    assert!(go(d.start_args("plan", json!({ "repo": "acme/other" }))).await.contains("isn't a repository the user watches"));
    assert!(d.runs().await.is_empty() && d.rig.cli.launches() == 0);

    d.rig.fx.core.pause_workstream(&d.rig.fx.scope, &d.ws, PauseReason::Person, Actor::Person).await.unwrap();
    assert!(go(d.start_args("plan", json!({}))).await.contains("is paused; only the person resumes it"));
    d.rig.fx.core.resume_workstream(&d.rig.fx.scope, &d.ws).await.unwrap();
    d.rig.fx.core.close_workstream(&d.rig.fx.scope, &d.ws).await.unwrap();
    assert!(go(d.start_args("plan", json!({}))).await.contains("is closed"));
    assert!(d.runs().await.is_empty());
}

#[tokio::test]
async fn a_ticket_out_of_reach_is_refused_until_the_person_hands_it_over() {
    let d = drive().await;
    let out = d.workstream_out_of_reach().await;
    let args = json!({ "workstream": out, "role": "investigate" });
    assert!(d.err("in-ws", "start_agent", args.clone()).await.contains("out of reach"));
    d.st.runs.lock().unwrap().get_mut("in-ws").unwrap().handed = ["OTH-1".to_string()].into();
    assert!(d.ok("in-ws", "start_agent", args).await.contains("OTH-1"));
}

#[tokio::test]
async fn at_most_three_agents_start_in_one_turn_and_a_refused_call_costs_none_of_them() {
    let d = drive().await;
    for _ in 0..4 {
        d.refused("in-ws", "deploy", json!({})).await;
    }
    for brief in ["one", "two", "three"] {
        d.started("in-ws", "investigate", json!({ "brief": brief })).await;
    }
    let fourth = d.refused("in-ws", "investigate", json!({ "brief": "four" })).await;
    assert!(fourth.contains("You have started 3 agents in this turn already"), "{fourth}");
    assert_eq!(d.runs().await.len(), 3);

    d.join("next-turn");
    d.started("next-turn", "investigate", json!({ "brief": "four" })).await;
    assert_eq!(d.runs().await.len(), 4);
}

#[tokio::test]
async fn a_repeated_identical_call_in_one_turn_returns_the_run_it_already_started() {
    let d = drive().await;
    let args = d.start_args("investigate", json!({ "brief": "the retry loop" }));
    let first = d.ok("in-ws", "start_agent", args.clone()).await;
    let again = d.ok("in-ws", "start_agent", args.clone()).await;
    let id = d.run_named(&first).await.id;
    assert_eq!(again, format!("Already started in this turn: R1 (run {id})."));
    assert_eq!(d.runs().await.len(), 1);
    d.launched(&d.run_by_id(&id).await).await;
    assert_eq!(d.rig.cli.launches(), 1, "it was handed to the launcher once");
    assert_eq!(d.audit().await.iter().filter(|(_, action, _)| action == "agent_started").count(), 1);

    // Other words in the same turn are another start, and so is the same call in another turn.
    d.started("in-ws", "investigate", json!({ "brief": "the cache" })).await;
    d.join("later");
    d.started("later", "investigate", json!({ "brief": "the retry loop" })).await;
    assert_eq!(d.runs().await.len(), 3);

    // A retry never counts against the turn's three.
    d.started("in-ws", "investigate", json!({ "brief": "a third" })).await;
    assert!(d.ok("in-ws", "start_agent", args).await.starts_with("Already started"));
}

#[tokio::test]
async fn an_agent_over_the_cap_waits_for_a_slot_and_the_reply_says_so() {
    let d = drive_with(0).await;
    let reply = d.ok("in-ws", "start_agent", d.start_args("investigate", json!({}))).await;
    assert!(reply.ends_with("It waits for a free slot."), "{reply}");
    let run = d.run_named(&reply).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    let waiting = d.run_by_id(&run.id).await;
    assert_eq!(waiting.state, RunState::Queued);
    assert!(waiting.slot_wait_since.is_some() && d.rig.cli.launches() == 0);
}

/// An agent Pip started in the workstream, listed as working and seen so by the tracker.
async fn working(d: &Drive, request: &str, brief: &str) -> Run {
    let run = d.started(request, "investigate", json!({ "brief": brief })).await;
    let run = d.launched(&run).await;
    d.rig.poll().await;
    let run = d.run_by_id(&run.id).await;
    assert_eq!(run.state, RunState::Working);
    run
}

#[tokio::test]
async fn message_agent_says_what_became_of_the_message() {
    let d = drive().await;
    let run = working(&d, "in-ws", "the cart").await;
    let id = run.id.clone();
    let say = |text: &str| json!({ "id": id, "text": text });

    let waiting = d.rig.fx.core.asks().open(&run.id, "Which database?").unwrap();
    assert_eq!(d.ok("in-ws", "message_agent", say("Use staging.")).await, "Answered R1's question.");
    assert_eq!(waiting.until(Duration::from_secs(1)).await, crate::runs::ask::Outcome::Answered("Use staging.".into()));

    assert_eq!(d.ok("in-ws", "message_agent", say("Also the refund path.")).await, "Queued for R1: it gets it at its next question, or when its turn ends.");
    assert_eq!(d.rig.fx.core.run_message(&run.id).await.unwrap().as_deref(), Some("Also the refund path."));

    d.rig.set(&run, |r| r.state = RunState::NeedsPermission).await;
    let refused = d.err("in-ws", "message_agent", say("Go on.")).await;
    assert!(refused.contains("permission prompt; the person answers it in Terminal"), "{refused}");
    assert!(d.err("in-ws", "message_agent", json!({ "id": run.id })).await.contains("text is required"));
    assert!(d.err("in-ws", "message_agent", json!({ "id": "nope", "text": "Hi" })).await.contains("There is no run nope"));
}

#[tokio::test]
async fn message_agent_wakes_a_finished_agent() {
    let d = drive().await;
    let run = working(&d, "in-ws", "the cart").await;
    d.rig.session(&run, |e| {
        e.state = Some("done".into());
        e.status = None;
        e.pid = None;
    });
    d.rig.set(&run, |r| (r.state, r.ended_at) = (RunState::Done, Some(chrono::Utc::now()))).await;
    std::fs::create_dir_all(&run.expected_worktree).unwrap();
    assert_eq!(d.ok("in-ws", "message_agent", json!({ "id": run.id, "text": "One more thing." })).await, "Sent it to R1, which is working on it again.");
    let after = d.run_by_id(&run.id).await;
    assert_eq!((after.state, after.passes), (RunState::Working, 2));
    assert_eq!(d.audit().await.last(), Some(&(Actor::Pip, "run_resumed".to_string(), Some("15".to_string()))));
}

#[tokio::test]
async fn stop_agent_stops_it_as_pip_and_a_run_waiting_for_the_slot_takes_the_slot() {
    let d = drive_with(1).await;
    let first = working(&d, "in-ws", "one").await;
    let reply = d.ok("in-ws", "start_agent", d.start_args("investigate", json!({ "brief": "two" }))).await;
    assert!(reply.ends_with("It waits for a free slot."), "{reply}");
    let second = d.run_named(&reply).await;

    assert_eq!(d.ok("in-ws", "stop_agent", json!({ "id": first.id })).await, "Stopped R1.");
    assert_eq!(d.run_by_id(&first.id).await.state, RunState::Stopped);
    assert!(d.audit().await.contains(&(Actor::Pip, "run_stopped".to_string(), None)));
    assert!(d.audit().await.iter().all(|(actor, action, _)| *actor != Actor::Person || action == "opened"), "nothing is recorded as the person's");
    assert!(d.launched(&second).await.short_id.is_some(), "the freed slot went to the waiting agent");

    let again = d.err("in-ws", "stop_agent", json!({ "id": first.id })).await;
    assert!(again.contains("is stopped, so there is nothing to stop"), "{again}");
    assert!(d.err("in-ws", "stop_agent", json!({})).await.contains("id is required"));
}
