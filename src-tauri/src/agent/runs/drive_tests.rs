//! `start_agent`, `message_agent` and `stop_agent` as Pip calls them, over the real run service with a scripted `claude`.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::*;
use crate::agent::mcp::{call_tool, PipRuns};
use crate::codehost::github::testserver::{draft_pull_reply, pull_reply_at};
use crate::domain::workstream::PauseReason;
use crate::domain::{Actor, ContainerRef, CreatedBy, Origin, Proposal, ProposalQuery, RunSpec};
use crate::inbox::testing::fixture_watching_with;
use crate::runs::rig::{ready_on, Rig};
use crate::runs::service::Timing;

const FAST: Timing = Timing { recover_window: Duration::from_millis(300), worktree_grace: Duration::from_millis(300), poll: Duration::from_millis(10), stop_wait: Duration::from_millis(200), stop_settle: Duration::ZERO, rm_wait: Duration::from_millis(5) };

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

    fn join_wake(&self, request: &str, wake: &str) {
        self.st.runs.lock().unwrap().insert(request.into(), PipRun { wake: Some(wake.into()), ..PipRun::in_workstream(self.rig.fx.scope.clone(), &self.ws) });
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

    /// `start_agent` in the workstream, with `args` besides the workstream, role and a brief that `extra` may replace.
    fn start_args(&self, role: &str, extra: Value) -> Value {
        let mut args = json!({ "workstream": self.ws, "role": role, "brief": "Look at the cart." });
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
async fn start_agent_starts_a_run_with_pips_role_and_brief_and_no_draft_and_hands_it_to_the_launcher() {
    let d = drive().await;
    let reply = d.ok("in-ws", "start_agent", d.start_args("  Investigator ", json!({ "brief": "  Look at the retry loop  " }))).await;
    assert!(reply.starts_with("Started R1 (run ") && reply.ends_with("investigator on CA-1 in acme/webshop."), "{reply}");
    let run = d.run_named(&reply).await;

    assert_eq!((run.created_by, run.proposal_id.as_str()), (CreatedBy::Pip, ""));
    assert_eq!(run.origin, Some(Origin::Chat { request_id: "in-ws".into(), workstream: Some(d.ws.clone()) }));
    let spec = spec_of(&run);
    assert_eq!((spec.role.as_str(), spec.repo.as_str(), spec.base.as_str(), spec.clone_path.clone()), ("investigator", "acme/webshop", "main", d.rig.clone.clone()));
    assert_eq!((spec.brief.as_str(), spec.ticket.as_deref(), spec.report, spec.workstream.as_deref()), ("Look at the retry loop", Some("CA-1"), true, Some(d.ws.as_str())));
    assert!(spec.ticket_block.as_deref().unwrap().starts_with("CA-1: Ticket 1"));
    assert_eq!(run.item, Some(d.rig.fx.item("CA-1")));
    assert!(d.drafts().await.is_empty(), "no draft was made for it");
    assert_eq!(d.audit().await.last(), Some(&(Actor::Pip, "agent_started".to_string(), Some("investigator · conversation".to_string()))));
    assert!(d.changes.load(Ordering::SeqCst) >= 1, "the page hears of the workstream");

    let launched = d.launched(&run).await;
    assert_eq!(launched.state, RunState::Launching);
    assert!(launched.short_id.is_some() && d.rig.cli.launches() == 1);
    let request = d.rig.cli.0.lock().unwrap().launches[0].clone();
    assert!(request.name.ends_with("CA-1 investigator"), "{}", request.name);
    assert!(request.prompt.starts_with("You are working as an investigator on CA-1.") && request.prompt.contains("Look at the retry loop"), "{}", request.prompt);
}

#[tokio::test]
async fn a_start_in_a_wake_turn_says_so_in_the_audit() {
    let d = drive().await;
    d.join_wake("wake-1", "facts-1");
    d.started("wake-1", "triager", json!({})).await;
    assert_eq!(d.audit().await.last(), Some(&(Actor::Pip, "agent_started".to_string(), Some("triager · wake turn".to_string()))));
}

#[tokio::test]
async fn any_role_starts_with_the_same_base_brief_and_only_pips_words_differ() {
    let d = drive().await;
    for (n, role) in ["planner", "Build Lead", "ui-tester"].into_iter().enumerate() {
        let request = format!("t{n}");
        d.join(&request);
        let run = d.started(&request, role, json!({ "brief": format!("Task {n}") })).await;
        let spec = spec_of(&run);
        assert_eq!((spec.role.as_str(), spec.brief.as_str(), spec.pr, spec.pr_sha.as_deref()), (role.to_lowercase().as_str(), format!("Task {n}").as_str(), None, None));
        assert_eq!(spec.earlier, crate::domain::LegacySpec::default(), "nothing of the kinds' typed fields");
    }
    assert_eq!(d.runs().await.len(), 3);
}

#[tokio::test]
async fn a_pull_request_is_pinned_to_its_head_for_any_role_and_a_fork_is_refused() {
    let d = drive().await;
    for (n, role) in ["reviewer", "builder", "verifier"].into_iter().enumerate() {
        let request = format!("p{n}");
        d.join(&request);
        let run = d.started(&request, role, json!({ "pr": 12 })).await;
        let spec = spec_of(&run);
        assert_eq!((spec.pr, spec.pr_sha.as_deref(), spec.base.as_str()), (Some(12), Some("a1b2c3d4e5f6"), "main"), "{role}");
        d.launched(&run).await;
        let prompt = d.rig.cli.0.lock().unwrap().launches.last().unwrap().prompt.clone();
        assert!(prompt.contains("`git fetch origin pull/12/head` then `git checkout --detach a1b2c3d4e5f6`"), "{prompt}");
    }

    d.join("fork");
    for role in ["reviewer", "builder"] {
        let refused = d.refused("fork", role, json!({ "pr": 13 })).await;
        assert!(refused.contains("fork"), "{role}: {refused}");
    }
    assert!(d.refused("fork", "reviewer", json!({ "pr": "twelve" })).await.contains("pr must be a pull request number"));
    assert!(d.refused("fork", "reviewer", json!({ "pr": 0 })).await.contains("pr must be a pull request number"));
    assert_eq!(d.runs().await.len(), 3);
}

#[tokio::test]
async fn a_run_in_a_workstream_with_no_ticket_takes_a_watched_repository_and_the_task_for_any_role() {
    let d = drive().await;
    let fx = &d.rig.fx;
    let open = fx.core.open_workstream(&fx.scope, None, Some("Why is the cart slow".into())).await.unwrap().id;
    let args = |extra: Value| {
        let mut all = json!({ "workstream": open, "role": "investigator" });
        all.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        all
    };
    d.join_general("g");
    let reply = d.ok("g", "start_agent", args(json!({ "repo": "ACME/webshop", "brief": "Why does the cart take 4 s to load?" }))).await;
    assert!(reply.ends_with("investigator in acme/webshop with no ticket."), "{reply}");
    let run = d.run_named(&reply).await;
    assert_eq!((run.item.clone(), spec_of(&run).brief.as_str(), spec_of(&run).workstream.as_deref()), (None, "Why does the cart take 4 s to load?", Some(open.as_str())));
    assert!(spec_of(&run).ticket.is_none() && !spec_of(&run).ends_as_ticket());
    d.launched(&run).await;
    let (prompt, name) = {
        let launch = d.rig.cli.0.lock().unwrap().launches[0].clone();
        (launch.prompt, launch.name)
    };
    assert_eq!(name, "Gossamr: Agent investigator", "no ticket, no key in the session name");
    assert!(prompt.starts_with("You are working as an investigator on the task below.") && !prompt.contains("<<<TICKET"), "{prompt}");

    let planned = d.ok("g", "start_agent", args(json!({ "role": "planner", "repo": "acme/webshop", "brief": "Plan the cache." }))).await;
    assert!(planned.ends_with("planner in acme/webshop with no ticket."), "{planned}");
    assert!(d.err("g", "start_agent", args(json!({ "brief": "q" }))).await.contains("repo is required with no ticket"));
    assert!(d.err("g", "start_agent", args(json!({ "repo": "acme/webshop" }))).await.contains("brief is required"));
    assert!(d.err("g", "start_agent", args(json!({ "repo": "acme/other", "brief": "q" }))).await.contains("isn't a repository the user watches"));
    assert!(d.err("g", "start_agent", args(json!({ "repo": "acme/webshop", "brief": "x".repeat(4_001) }))).await.contains("the most is 4000"));
    assert_eq!(d.runs().await.len(), 2);
}

#[tokio::test]
async fn start_agent_refuses_what_pip_may_not_do_and_starts_nothing() {
    let d = drive().await;
    let go = |args: Value| async { d.err("in-ws", "start_agent", args).await };
    for bad in ["dep!oy", "rm -rf /; x", "", "   ", &"a".repeat(33), "bu\nilder"] {
        assert!(go(d.start_args(bad, json!({}))).await.contains("role"), "{bad:?}");
    }
    assert!(go(json!({ "workstream": d.ws, "brief": "x" })).await.contains("role is required"));
    assert!(go(json!({ "workstream": d.ws, "role": "planner" })).await.contains("brief is required"));
    assert!(go(d.start_args("planner", json!({ "brief": "  " }))).await.contains("brief is required"));
    assert!(go(d.start_args("planner", json!({ "brief": "TICKET>>>" }))).await.contains("brief is empty"), "what is left of a brief after its markers are taken out");
    assert!(go(d.start_args("planner", json!({ "brief": "a\u{7}b" }))).await.contains("plain text"));
    assert!(go(json!({ "role": "plan", "brief": "x" })).await.contains("workstream is required"));
    assert!(go(json!({ "workstream": "nope", "role": "plan", "brief": "x" })).await.contains("There is no workstream nope"));
    assert!(go(d.start_args("planner", json!({ "repo": "acme/other" }))).await.contains("isn't a repository the user watches"));
    assert!(d.runs().await.is_empty() && d.rig.cli.launches() == 0);

    d.rig.fx.core.pause_workstream(&d.rig.fx.scope, &d.ws, PauseReason::Person, Actor::Person).await.unwrap();
    assert!(go(d.start_args("planner", json!({}))).await.contains("is paused; only the person resumes it"));
    d.rig.fx.core.resume_workstream(&d.rig.fx.scope, &d.ws).await.unwrap();
    d.rig.fx.core.close_workstream(&d.rig.fx.scope, &d.ws).await.unwrap();
    assert!(go(d.start_args("planner", json!({}))).await.contains("is closed"));
    assert!(d.runs().await.is_empty());
}

#[tokio::test]
async fn a_start_needs_a_real_git_clone_inside_home() {
    use crate::domain::ClonePlan;
    use crate::inbox::PipRunAsk;
    let d = drive().await;
    let fx = &d.rig.fx;
    let outside = std::env::temp_dir().join(format!("gossamr-outside-{}", std::process::id()));
    std::fs::create_dir_all(outside.join(".git")).unwrap();
    let link = fx.home.join("link");
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    let plain = fx.home.join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    let ask = || PipRunAsk { role: crate::domain::Role::parse("investigator").unwrap(), brief: "Look.".into(), pr: None };
    let plan = |path: &std::path::Path| ClonePlan { path: path.to_path_buf(), base: "main".into(), name: "eng-1-cart-0001".into() };
    let ws = d.ws.clone();
    let build = |path: std::path::PathBuf| {
        let ws = ws.clone();
        async move { fx.core.build_pip_run(&fx.scope, &ws, Some("CA-1"), ask(), "acme/webshop".into(), plan(&path)).await }
    };

    for (bad, why) in [(fx.home.join("missing"), "isn't a folder that exists"), (plain, "isn't a git clone"), (outside.clone(), "isn't inside your home folder"), (link, "isn't inside your home folder")] {
        let err = build(bad.clone()).await.unwrap_err().to_string();
        assert!(err.contains(why), "{bad:?}: {err}");
    }
    let (spec, _) = build(d.rig.clone.clone()).await.unwrap();
    assert_eq!(spec.clone_path, d.rig.clone);
    std::fs::remove_dir_all(outside).unwrap();
}

#[tokio::test]
async fn a_ticket_out_of_reach_is_refused_until_the_person_hands_it_over() {
    let d = drive().await;
    let out = d.workstream_out_of_reach().await;
    let args = json!({ "workstream": out, "role": "investigator", "brief": "Look." });
    d.join_general("general");
    assert!(d.err("general", "start_agent", args.clone()).await.contains("out of reach"));
    d.st.runs.lock().unwrap().get_mut("general").unwrap().handed = ["OTH-1".to_string()].into();
    assert!(d.ok("general", "start_agent", args).await.contains("OTH-1"));
}

#[tokio::test]
async fn at_most_three_agents_start_in_one_turn_and_a_refused_call_costs_none_of_them() {
    let d = drive().await;
    for _ in 0..4 {
        d.refused("in-ws", "dep!oy", json!({})).await;
    }
    for brief in ["one", "two", "three"] {
        d.started("in-ws", "investigator", json!({ "brief": brief })).await;
    }
    let fourth = d.refused("in-ws", "investigate", json!({ "brief": "four" })).await;
    assert!(fourth.contains("You have started 3 agents in this turn already"), "{fourth}");
    assert_eq!(d.runs().await.len(), 3);

    d.join("next-turn");
    d.started("next-turn", "investigator", json!({ "brief": "four" })).await;
    assert_eq!(d.runs().await.len(), 4);
}

#[tokio::test]
async fn a_repeated_identical_call_in_one_turn_returns_the_run_it_already_started() {
    let d = drive().await;
    let args = d.start_args("investigator", json!({ "brief": "the retry loop" }));
    let first = d.ok("in-ws", "start_agent", args.clone()).await;
    let again = d.ok("in-ws", "start_agent", args.clone()).await;
    let id = d.run_named(&first).await.id;
    assert_eq!(again, format!("Already started: R1 (run {id})."));
    assert_eq!(d.runs().await.len(), 1);
    d.launched(&d.run_by_id(&id).await).await;
    assert_eq!(d.rig.cli.launches(), 1, "it was handed to the launcher once");
    assert_eq!(d.audit().await.iter().filter(|(_, action, _)| action == "agent_started").count(), 1);

    // Other words in the same turn are another start, and so is the same call in another turn.
    d.started("in-ws", "investigator", json!({ "brief": "the cache" })).await;
    d.join("later");
    d.started("later", "investigator", json!({ "brief": "the retry loop" })).await;
    assert_eq!(d.runs().await.len(), 3);

    // A retry never counts against the turn's three.
    d.started("in-ws", "investigator", json!({ "brief": "a third" })).await;
    assert!(d.ok("in-ws", "start_agent", args).await.starts_with("Already started"));
}

#[tokio::test]
async fn a_wake_given_back_and_run_again_does_not_start_the_same_agent_twice() {
    let d = drive().await;
    let args = d.start_args("triager", json!({}));
    d.join_wake("wake-1", "facts-1");
    let first = d.ok("wake-1", "start_agent", args.clone()).await;
    d.join_wake("wake-2", "facts-1");
    let again = d.ok("wake-2", "start_agent", args.clone()).await;
    assert_eq!(again, format!("Already started: R1 (run {}).", d.run_named(&first).await.id));
    assert_eq!(d.runs().await.len(), 1);

    d.join_wake("wake-3", "facts-2");
    d.started("wake-3", "triager", json!({})).await;
    assert_eq!(d.runs().await.len(), 2, "a wake for other facts starts its own");
}

#[tokio::test]
async fn closing_a_workstream_is_refused_while_an_agent_in_it_is_still_going() {
    let d = drive().await;
    let run = working(&d, "in-ws", "the cart").await;
    let refused = d.err("in-ws", "close_workstream", json!({ "workstream": d.ws })).await;
    assert!(refused.contains("1 of its agents are still going") && refused.contains("stop_agent"), "{refused}");
    assert!(d.rig.fx.core.workstream(&d.rig.fx.scope, &d.ws).await.unwrap().unwrap().workstream.closed_at.is_none());

    d.ok("in-ws", "stop_agent", json!({ "id": run.id })).await;
    assert!(d.ok("in-ws", "close_workstream", json!({ "workstream": d.ws })).await.starts_with("Closed"));
}

#[tokio::test]
async fn waking_agents_counts_against_the_turns_three() {
    let d = drive().await;
    let mut finished = Vec::new();
    for n in 1..=4 {
        let request = format!("s{n}");
        d.join(&request);
        let run = working(&d, &request, &format!("look {n}")).await;
        d.rig.session(&run, |e| {
            e.state = Some("done".into());
            e.status = None;
            e.pid = None;
        });
        d.rig.set(&run, |r| (r.state, r.ended_at) = (RunState::Done, Some(chrono::Utc::now()))).await;
        std::fs::create_dir_all(&run.expected_worktree).unwrap();
        finished.push(run);
    }
    for run in &finished[..3] {
        d.ok("in-ws", "message_agent", json!({ "id": run.id, "text": "Again." })).await;
    }
    let over = d.err("in-ws", "message_agent", json!({ "id": finished[3].id, "text": "Again." })).await;
    assert!(over.contains("You have started 3 agents in this turn already"), "{over}");
    assert_eq!(d.run_by_id(&finished[3].id).await.state, RunState::Done);
}

#[tokio::test]
async fn an_agent_over_the_cap_waits_for_a_slot_and_the_reply_says_so() {
    let d = drive_with(0).await;
    let reply = d.ok("in-ws", "start_agent", d.start_args("investigator", json!({}))).await;
    assert!(reply.ends_with("It waits for a free slot."), "{reply}");
    let run = d.run_named(&reply).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    let waiting = d.run_by_id(&run.id).await;
    assert_eq!(waiting.state, RunState::Queued);
    assert!(waiting.slot_wait_since.is_some() && d.rig.cli.launches() == 0);
}

/// An agent Pip started in the workstream, listed as working and seen so by the tracker.
async fn working(d: &Drive, request: &str, brief: &str) -> Run {
    let run = d.started(request, "investigator", json!({ "brief": brief })).await;
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
    let reply = d.ok("in-ws", "start_agent", d.start_args("investigator", json!({ "brief": "two" }))).await;
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

#[tokio::test]
async fn a_workstreams_conversation_drives_only_its_own_agents_and_general_drives_any() {
    let d = drive().await;
    let other = d.rig.fx.core.open_workstream(&d.rig.fx.scope, Some(d.rig.fx.item("CA-2")), None).await.unwrap().id;
    d.join_general("general");
    let reply = d.ok("general", "start_agent", json!({ "workstream": other, "role": "investigator", "brief": "the other ticket" })).await;
    let run = d.run_named(&reply).await;

    let elsewhere = d.err("in-ws", "start_agent", json!({ "workstream": other, "role": "investigator", "brief": "more" })).await;
    assert!(elsewhere.contains("drives the agents of workstream"), "{elsewhere}");
    assert!(d.err("in-ws", "message_agent", json!({ "id": run.id, "text": "Hi" })).await.contains("drives the agents of workstream"));
    assert!(d.err("in-ws", "stop_agent", json!({ "id": run.id })).await.contains("drives the agents of workstream"));
}

#[tokio::test]
async fn an_agent_queued_for_a_workstream_that_is_paused_is_not_launched_until_it_is_resumed() {
    use crate::runs::launcher::RunLauncher;
    let d = drive().await;
    let spec = RunSpec { workstream: Some(d.ws.clone()), ..d.rig.spec(1) };
    let queued = d.rig.fx.core.queue_test_run(spec, Some(d.rig.fx.item("CA-1"))).await.unwrap();
    d.rig.fx.core.pause_workstream(&d.rig.fx.scope, &d.ws, PauseReason::Person, Actor::Person).await.unwrap();
    d.rig.svc.launch(&queued.id).await.unwrap();
    assert_eq!((d.run_by_id(&queued.id).await.state, d.rig.cli.launches()), (RunState::Queued, 0));

    d.rig.fx.core.resume_workstream(&d.rig.fx.scope, &d.ws).await.unwrap();
    d.rig.svc.launch_waiting().await.unwrap();
    assert_eq!(d.rig.cli.launches(), 1);
}
