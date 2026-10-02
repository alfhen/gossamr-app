use std::sync::Arc;

use chrono::Duration as Span;

use super::*;
use crate::runs::cli::TimelineLine;
use crate::runs::index::RunIndex;
use crate::runs::rig::{line, ready, Rig};
use crate::runs::state::{quiet_for, QUIET_AFTER};
use crate::runs::testing::FakeCli;

const FAKE_TOKEN: &str = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

fn permission(entry: &mut AgentEntry) {
    entry.status = Some("waiting".into());
    entry.waiting_for = Some("permission prompt".into());
}

fn working(entry: &mut AgentEntry) {
    entry.state = Some("working".into());
    entry.status = Some("busy".into());
    entry.waiting_for = None;
    entry.pid = Some(4242);
}

async fn launched() -> (Rig, Run) {
    let rig = ready().await;
    let run = rig.launched(1).await;
    (rig, run)
}

#[tokio::test]
async fn a_run_follows_its_session_from_working_to_a_permission_prompt_and_back_to_done() {
    let (rig, run) = launched().await;
    let id = run.short_id.clone().unwrap();
    assert_eq!(run.state, RunState::Launching);

    rig.poll().await;
    let now = rig.get(&run).await;
    assert_eq!(now.state, RunState::Working);
    assert_eq!(now.session_id.as_deref(), Some("b0000001-0000-4000-8000-000000000000"));
    assert!(rig.noticed().is_empty());

    rig.job(&id, |j| j.needs = Some("approve Bash: touch /work/scratch.txt".into()));
    rig.session(&run, permission);
    rig.poll().await;
    let asked = rig.get(&run).await;
    assert_eq!((asked.state, asked.needs.as_deref()), (RunState::NeedsPermission, Some("approve Bash: touch /work/scratch.txt")));
    assert_eq!(rig.noticed(), [(Attention::Needs, RunState::NeedsPermission)]);

    rig.poll().await;
    assert_eq!(rig.noticed().len(), 1, "the same prompt doesn't notify again");

    rig.job(&id, |j| j.needs = None);
    rig.session(&run, working);
    rig.poll().await;
    let resumed = rig.get(&run).await;
    assert_eq!((resumed.state, resumed.needs), (RunState::Working, None));

    rig.job(&id, |j| {
        j.result = Some("It is the cart rounding.\nFor Jira: close as duplicate.".into());
        j.worktree_branch = Some("worktree-eng-1-fix-cart-0001".into());
        j.tokens = Some(578_000);
    });
    rig.session(&run, |e| {
        e.state = Some("done".into());
        e.status = Some("idle".into());
    });
    rig.poll().await;
    let done = rig.get(&run).await;
    assert_eq!(done.state, RunState::Done);
    assert_eq!(done.result.as_deref(), Some("It is the cart rounding.\nFor Jira: close as duplicate."));
    assert_eq!((done.tokens, done.branch.as_deref()), (Some(578_000), Some("worktree-eng-1-fix-cart-0001")));
    assert!(done.ended_at.is_some());
    assert_eq!(rig.noticed().last(), Some(&(Attention::Drafted, RunState::Done)));
    assert!(rig.svc.index.live().is_empty(), "a finished run leaves the index's live list");
    assert!(!rig.changes.lock().unwrap().is_empty());

    let polls = rig.cli.0.lock().unwrap().listings;
    rig.poll().await;
    assert_eq!(rig.cli.0.lock().unwrap().listings, polls, "nothing unfinished, so claude isn't asked");
}

#[tokio::test]
async fn a_listing_that_is_ahead_of_a_lagging_state_file_wins() {
    let (rig, run) = launched().await;
    rig.job(&run.short_id.clone().unwrap(), |j| j.state = Some("working".into()));
    rig.session(&run, |e| e.state = Some("done".into()));
    rig.poll().await;
    assert_eq!(rig.get(&run).await.state, RunState::Done);
}

#[tokio::test]
async fn an_entry_that_disappears_makes_the_run_unknown_and_it_recovers_when_it_returns() {
    let (rig, run) = launched().await;
    rig.poll().await;
    rig.cli.with(|s| s.sessions.clear());
    rig.poll().await;
    let lost = rig.get(&run).await;
    assert_eq!((lost.state, lost.error.as_deref()), (RunState::Unknown, Some("This session isn't listed any more")));
    assert!(rig.noticed().is_empty(), "unknown doesn't interrupt");
    assert_eq!(rig.svc.index.live().len(), 1, "it may still come back");

    rig.cli.with(|s| s.sessions.push(AgentEntry { name: None, ..FakeCli::session("b0000001", &run.expected_worktree) }));
    rig.poll().await;
    let back = rig.get(&run).await;
    assert_eq!((back.state, back.error), (RunState::Working, None));
}

#[tokio::test]
async fn a_session_that_stays_unlisted_fails_after_ten_minutes_frees_its_slot_and_is_noticed() {
    let (rig, run) = launched().await;
    rig.poll().await;
    rig.cli.with(|s| s.sessions.clear());
    rig.poll().await;
    let lost = rig.get(&run).await;
    assert_eq!(lost.state, RunState::Unknown);
    assert!(lost.last_progress_at > Utc::now() - Span::seconds(5), "the clock starts when it first goes missing");
    assert_eq!(rig.svc.index.live().len(), 1);

    rig.set(&run, |r| r.last_progress_at = Utc::now() - Span::minutes(9)).await;
    rig.poll().await;
    assert_eq!(rig.get(&run).await.state, RunState::Unknown);

    rig.set(&run, |r| r.last_progress_at = Utc::now() - Span::minutes(11)).await;
    rig.poll().await;
    let failed = rig.get(&run).await;
    assert_eq!((failed.state, failed.error.as_deref()), (RunState::Failed, Some(crate::runs::state::LOST)));
    assert!(failed.ended_at.is_some());
    assert!(rig.svc.index.live().is_empty(), "the slot is free again");
    assert_eq!(rig.noticed(), [(Attention::Failed, RunState::Failed)]);
}

#[tokio::test]
async fn an_odd_state_that_later_disappears_gets_its_own_ten_minutes() {
    let (rig, run) = launched().await;
    rig.session(&run, |e| e.state = Some("paused-by-quota".into()));
    rig.poll().await;
    assert_eq!(rig.get(&run).await.state, RunState::Unknown);
    rig.set(&run, |r| r.last_progress_at = Utc::now() - Span::hours(3)).await;
    rig.poll().await;
    assert_eq!(rig.get(&run).await.state, RunState::Unknown, "still listed, so it stays unknown");

    rig.cli.with(|s| s.sessions.clear());
    rig.poll().await;
    rig.poll().await;
    let after = rig.get(&run).await;
    assert_eq!((after.state, after.error.as_deref()), (RunState::Unknown, Some(crate::runs::state::NOT_LISTED)));
}

#[tokio::test]
async fn a_launch_that_never_shows_up_fails_after_90_seconds_and_is_noticed() {
    let rig = ready().await;
    let queued = rig.queued(1).await;
    rig.poll().await;
    assert_eq!(rig.get(&queued).await.state, RunState::Queued, "a queued run is left alone");

    let run = rig.launched(2).await;
    rig.cli.with(|s| s.sessions.clear());
    rig.set(&run, |r| r.launched_at = Some(Utc::now() - Span::seconds(60))).await;
    rig.poll().await;
    assert_eq!(rig.get(&run).await.state, RunState::Launching);

    rig.set(&run, |r| r.launched_at = Some(Utc::now() - Span::seconds(91))).await;
    rig.poll().await;
    let lost = rig.get(&run).await;
    assert_eq!((lost.state, lost.error.as_deref()), (RunState::Failed, Some("Launch wasn't found")));
    assert_eq!(rig.noticed(), [(Attention::Failed, RunState::Failed)]);
}

#[tokio::test]
async fn blocked_on_a_login_is_a_system_block_and_a_plain_block_is_a_question() {
    let (rig, run) = launched().await;
    rig.session(&run, |e| {
        e.state = Some("blocked".into());
        e.status = Some("idle".into());
        e.needs = Some("login required \u{2014} run /login".into());
    });
    rig.poll().await;
    assert_eq!(rig.get(&run).await.state, RunState::SystemBlocked);

    rig.session(&run, |e| {
        e.pid = None;
        e.needs = None;
    });
    rig.job(&run.short_id.clone().unwrap(), |j| j.needs = Some("Which environment should I look at?".into()));
    rig.poll().await;
    let asked = rig.get(&run).await;
    assert_eq!((asked.state, asked.needs.as_deref()), (RunState::NeedsAnswer, Some("Which environment should I look at?")));
    assert_eq!(rig.noticed(), [(Attention::Needs, RunState::SystemBlocked), (Attention::Needs, RunState::NeedsAnswer)]);
}

#[tokio::test]
async fn a_working_session_without_a_process_fails_on_the_second_poll_in_a_row() {
    let (rig, run) = launched().await;
    rig.poll().await;
    rig.session(&run, |e| e.pid = None);
    rig.poll().await;
    assert_eq!(rig.get(&run).await.state, RunState::Working);
    rig.session(&run, |e| e.pid = Some(1));
    rig.poll().await;
    rig.session(&run, |e| e.pid = None);
    rig.poll().await;
    assert_eq!(rig.get(&run).await.state, RunState::Working, "a poll with a process starts the count again");
    rig.poll().await;
    let died = rig.get(&run).await;
    assert_eq!((died.state, died.error.as_deref()), (RunState::Failed, Some("The agent process ended unexpectedly")));
    assert_eq!(rig.noticed(), [(Attention::Failed, RunState::Failed)]);
}

#[tokio::test]
async fn a_stop_done_in_terminal_shows_as_stopped_without_a_notice() {
    let (rig, run) = launched().await;
    rig.poll().await;
    rig.session(&run, |e| {
        e.state = Some("stopped".into());
        e.pid = None;
    });
    rig.poll().await;
    assert_eq!(rig.get(&run).await.state, RunState::Stopped);
    assert!(rig.noticed().is_empty());
}

#[tokio::test]
async fn sessions_that_match_no_run_are_ignored() {
    let (rig, run) = launched().await;
    rig.cli.with(|s| {
        s.sessions.push(FakeCli::session("f0f0f0f0", std::path::Path::new("/tmp/foreign")));
        s.sessions.push(AgentEntry { kind: Some("interactive".into()), id: None, ..FakeCli::session("00000000", &run.expected_worktree) });
    });
    rig.poll().await;
    assert_eq!(rig.get(&run).await.state, RunState::Working);
    assert_eq!(rig.fx.core.runs_list(&RunQuery::default()).await.unwrap().len(), 1);
}

#[tokio::test]
async fn a_run_found_by_its_worktree_path_gets_the_short_id_and_goes_in_the_index() {
    let rig = ready().await;
    let run = rig.queued(1).await;
    rig.set(&run, |r| r.state = RunState::Launching).await;
    rig.cli.with(|s| s.sessions.push(FakeCli::session("c0ffee01", &run.expected_worktree)));
    rig.poll().await;
    let found = rig.get(&run).await;
    assert_eq!((found.state, found.short_id.as_ref().map(ShortId::as_str)), (RunState::Working, Some("c0ffee01")));
    let [entry] = rig.svc.index.live().try_into().unwrap();
    assert_eq!(entry.short_id, found.short_id);
}

#[tokio::test]
async fn timeline_lines_become_events_once() {
    let (rig, run) = launched().await;
    let id = run.short_id.clone().unwrap();
    rig.job(&id, |j| j.timeline = vec![line("2026-09-30T10:00:00Z", "working", "Started"), line("2026-09-30T10:01:00Z", "working", "grep -rn cart src")]);
    rig.poll().await;
    rig.poll().await;
    let events = rig.fx.core.run_events(&run.id).await.unwrap();
    assert_eq!(events.iter().map(|e| e.text.as_str()).collect::<Vec<_>>(), ["Started", "grep -rn cart src"]);
    assert_eq!(events[1].kind, "working");

    rig.job(&id, |j| j.timeline.push(line("2026-09-30T10:02:00Z", "working", "Reading cart.rs")));
    rig.poll().await;
    let events = rig.fx.core.run_events(&run.id).await.unwrap();
    assert_eq!(events.iter().map(|e| e.seq).collect::<Vec<_>>(), [0, 1, 2]);
    assert_eq!(events[2].text, "Reading cart.rs");
}

#[tokio::test]
async fn timeline_lines_without_a_time_or_text_are_handled_and_not_repeated() {
    let (rig, run) = launched().await;
    rig.job(&run.short_id.clone().unwrap(), |j| {
        j.timeline = vec![
            line("2026-09-30T10:00:00Z", "working", "Started"),
            TimelineLine { at: None, state: Some("blocked".into()), detail: Some("Needs a decision".into()), text: None },
            TimelineLine::default(),
            TimelineLine { at: Some("1790000500000".into()), state: None, detail: Some("a detail".into()), text: Some("a title".into()) },
        ]
    });
    rig.poll().await;
    rig.poll().await;
    let events = rig.fx.core.run_events(&run.id).await.unwrap();
    assert_eq!(events.iter().map(|e| e.text.as_str()).collect::<Vec<_>>(), ["Started", "Needs a decision", "a title"]);
    assert_eq!(events[2].detail.as_deref(), Some("a detail"));
    assert_eq!(events[2].kind, "update");
}

#[tokio::test]
async fn at_most_500_events_are_kept_and_the_501st_is_dropped() {
    let (rig, run) = launched().await;
    let many = |n: usize| (0..n).map(|i| line(&format!("2026-09-30T10:{:02}:{:02}Z", i / 60, i % 60), "working", &format!("step {i}"))).collect::<Vec<_>>();
    rig.job(&run.short_id.clone().unwrap(), |j| j.timeline = many(501));
    rig.poll().await;
    rig.poll().await;
    let events = rig.fx.core.run_events(&run.id).await.unwrap();
    assert_eq!(events.len(), 500);
    assert_eq!(events.last().unwrap().text, "step 499");
}

#[tokio::test]
async fn secrets_are_redacted_before_anything_is_stored() {
    let (rig, run) = launched().await;
    let id = run.short_id.clone().unwrap();
    rig.job(&id, |j| {
        j.timeline = vec![TimelineLine {
            at: Some("2026-09-30T10:00:00Z".into()),
            state: Some("working".into()),
            detail: Some(format!("git push https://{FAKE_TOKEN}@github.com/acme/webshop")),
            text: Some(format!("export GITHUB_TOKEN={FAKE_TOKEN}")),
        }];
        j.detail = Some(format!("using {FAKE_TOKEN}"));
        j.needs = Some(format!("approve Bash: curl -H 'Authorization: Bearer {FAKE_TOKEN}' x"));
    });
    rig.session(&run, permission);
    rig.poll().await;
    rig.job(&id, |j| j.result = Some(format!("found AKIAIOSFODNN7EXAMPLE and {FAKE_TOKEN}")));
    rig.session(&run, |e| {
        e.state = Some("done".into());
        e.status = None;
        e.waiting_for = None;
    });
    rig.poll().await;

    let stored = serde_json::to_string(&(rig.get(&run).await, rig.fx.core.run_events(&run.id).await.unwrap())).unwrap();
    assert!(!stored.contains("abcdefghijklmnop") && !stored.contains("AKIAIOSFODNN7EXAMPLE"), "{stored}");
    assert!(stored.contains("[redacted]"));
}

#[tokio::test]
async fn words_from_a_job_are_capped() {
    let (rig, run) = launched().await;
    let long = "x".repeat(5_000);
    rig.job(&run.short_id.clone().unwrap(), |j| {
        j.detail = Some(long.clone());
        j.needs = Some(long.clone());
        j.timeline = vec![TimelineLine { at: Some("2026-09-30T10:00:00Z".into()), state: None, detail: Some(long.clone()), text: Some(long.clone()) }];
    });
    rig.session(&run, permission);
    rig.poll().await;
    let now = rig.get(&run).await;
    assert_eq!((now.needs.unwrap().len(), now.last_detail.unwrap().len()), (500, 500));
    let event = rig.fx.core.run_events(&run.id).await.unwrap().remove(0);
    assert_eq!((event.text.len(), event.detail.unwrap().len()), (500, 2_048));
}

#[tokio::test]
async fn being_quiet_never_notifies_and_new_tokens_reset_the_clock() {
    let (rig, run) = launched().await;
    let id = run.short_id.clone().unwrap();
    rig.svc.set_settings(crate::config::AgentSettings { wall_clock_minutes: 0, ..Default::default() }).unwrap();
    rig.poll().await;
    rig.set(&run, |r| {
        r.launched_at = Some(Utc::now() - Span::hours(3));
        r.last_progress_at = Utc::now() - Span::minutes(45);
        r.tokens = Some(100);
    })
    .await;
    rig.job(&id, |j| j.tokens = Some(100));
    rig.poll().await;
    let quiet = rig.get(&run).await;
    assert_eq!(quiet.state, RunState::Working);
    assert!(quiet_for(&quiet, Utc::now()).is_some_and(|d| d >= QUIET_AFTER));
    assert!(rig.noticed().is_empty());

    rig.job(&id, |j| j.tokens = Some(101));
    rig.poll().await;
    assert_eq!(quiet_for(&rig.get(&run).await, Utc::now()), None);
    assert!(rig.noticed().is_empty());
}

#[tokio::test]
async fn a_poll_that_cannot_list_sessions_changes_nothing() {
    let (rig, run) = launched().await;
    rig.cli.with(|s| s.list_fails = true);
    let polled = rig.svc.poll_at(Utc::now()).await;
    assert!(polled.busy);
    assert_eq!(rig.get(&run).await.state, RunState::Launching);
}

#[tokio::test]
async fn nothing_is_tracked_while_agents_are_off() {
    let (rig, run) = launched().await;
    let off = Arc::new(RunService::new(rig.fx.core.clone(), Arc::new(crate::runs::toolchain::SystemToolchain::default()), RunIndex::load(&rig.fx.dir.join("off")), vec![], Arc::new(|_| {})));
    assert!(!off.poll().await.busy);
    assert_eq!(rig.get(&run).await.state, RunState::Launching);
}

#[test]
fn notices_say_what_the_plan_says() {
    let run = |state: RunState, needs: Option<&str>, error: Option<&str>| {
        let mut r = Run::queued("r".into(), "p".into(), "c".into(), Some(crate::domain::ItemRef { connection_id: "c".into(), external_id: "10".into(), key: "CE-806".into() }), crate::domain::fixtures::run_spec(), "db".into(), Utc::now());
        (r.state, r.needs, r.error) = (state, needs.map(Into::into), error.map(Into::into));
        r
    };
    let n = notice_text(&run(RunState::NeedsPermission, Some("approve Bash: rm x"), None), Attention::Needs);
    assert_eq!((n.title.as_str(), n.body.as_str()), ("CE-806 needs you", "Claude wants to run a command"));
    let n = notice_text(&run(RunState::NeedsAnswer, Some("Which environment?"), None), Attention::Needs);
    assert_eq!(n.body, "Which environment?");
    assert_eq!(notice_text(&run(RunState::NeedsAnswer, None, None), Attention::Needs).body, "It is waiting for you");
    assert_eq!(notice_text(&run(RunState::SystemBlocked, None, None), Attention::Needs).body, "Claude needs you to sign in");
    let n = notice_text(&run(RunState::Done, None, None), Attention::Done);
    assert_eq!((n.title.as_str(), n.body.as_str()), ("CE-806 finished", "Open it to see what it found"));
    let n = notice_text(&run(RunState::Failed, None, Some("Claude isn't signed in.")), Attention::Failed);
    assert_eq!((n.title.as_str(), n.body.as_str()), ("CE-806 couldn't start", "Claude isn't signed in."));
    let n = notice_text(&run(RunState::Failed, None, Some("The agent process ended unexpectedly")), Attention::Failed);
    assert_eq!(n.title, "CE-806 stopped unexpectedly");
    let n = notice_text(&run(RunState::Failed, None, Some("This session hasn't been listed for 10 minutes")), Attention::Failed);
    assert_eq!(n.title, "CE-806 lost its session");
}

#[test]
fn focusing_within_30_seconds_opens_the_run_once_and_later_opens_nothing() {
    let open = OpenOnFocus::default();
    let t0 = Instant::now();
    assert_eq!(open.take(t0), None, "nothing pending");
    open.record("run-1", t0);
    assert_eq!(open.take(t0 + Duration::from_secs(29)).as_deref(), Some("run-1"));
    assert_eq!(open.take(t0 + Duration::from_secs(29)), None, "once");

    open.record("run-2", t0);
    assert_eq!(open.take(t0 + Duration::from_secs(31)), None, "too late");
    assert_eq!(open.take(t0 + Duration::from_secs(1)), None, "and it is gone");

    open.record("run-3", t0);
    open.record("run-4", t0 + Duration::from_secs(5));
    assert_eq!(open.take(t0 + Duration::from_secs(10)).as_deref(), Some("run-4"), "the latest notification wins");
}

#[tokio::test]
async fn a_run_past_the_time_limit_is_stopped_once_with_the_reason_recorded_and_one_notice() {
    let (rig, run) = launched().await;
    rig.poll().await;
    rig.svc.set_settings(crate::config::AgentSettings { wall_clock_minutes: 30, ..Default::default() }).unwrap();
    let id = run.short_id.clone().unwrap();

    rig.svc.poll_at(Utc::now() + Span::minutes(29)).await;
    assert_eq!(rig.get(&run).await.state, RunState::Working);
    assert!(rig.cli.0.lock().unwrap().stops.is_empty());

    rig.svc.poll_at(Utc::now() + Span::minutes(31)).await;
    let stopped = rig.get(&run).await;
    assert_eq!(stopped.state, RunState::Stopped);
    assert_eq!(stopped.error.as_deref(), Some("Stopped by Gossamr: it passed the 30 minute limit"));
    assert!(stopped.ended_at.is_some());
    assert_eq!(rig.cli.0.lock().unwrap().stops, [id.to_string()]);
    let events = rig.fx.core.run_events(&run.id).await.unwrap();
    assert_eq!(events.last().map(|e| (e.kind.as_str(), e.text.as_str())), Some(("limit", "Stopped by Gossamr: it passed the 30 minute limit")));
    assert_eq!(rig.noticed(), [(Attention::Limit, RunState::Stopped)]);
    assert!(rig.svc.index.live().is_empty());

    rig.svc.poll_at(Utc::now() + Span::minutes(90)).await;
    assert_eq!(rig.cli.0.lock().unwrap().stops.len(), 1, "a stopped run is not stopped again");
    assert_eq!(rig.noticed().len(), 1);
}

#[tokio::test]
async fn a_run_past_the_token_limit_is_stopped_and_one_waiting_on_you_is_too() {
    let (rig, run) = launched().await;
    let id = run.short_id.clone().unwrap();
    rig.svc.set_settings(crate::config::AgentSettings { token_cap: 2_000, wall_clock_minutes: 0, ..Default::default() }).unwrap();
    rig.job(&id, |j| j.tokens = Some(1_999));
    rig.poll().await;
    assert_eq!(rig.get(&run).await.state, RunState::Working);

    rig.job(&id, |j| j.tokens = Some(2_000));
    rig.session(&run, permission);
    rig.poll().await;
    let stopped = rig.get(&run).await;
    assert_eq!((stopped.state, stopped.needs), (RunState::Stopped, None));
    assert_eq!(stopped.error.as_deref(), Some("Stopped by Gossamr: it passed the 2,000 token limit"));
}

#[tokio::test]
async fn limits_of_zero_never_stop_a_run() {
    let (rig, run) = launched().await;
    rig.svc.set_settings(crate::config::AgentSettings { token_cap: 0, wall_clock_minutes: 0, ..Default::default() }).unwrap();
    rig.job(run.short_id.as_ref().unwrap(), |j| j.tokens = Some(u64::MAX / 2));
    rig.svc.poll_at(Utc::now() + Span::days(3)).await;
    assert_eq!(rig.get(&run).await.state, RunState::Working);
    assert!(rig.cli.0.lock().unwrap().stops.is_empty());
}

fn finish_with(rig: &Rig, run: &Run, result: &str) {
    rig.job(run.short_id.as_ref().unwrap(), |j| j.result = Some(result.into()));
    rig.session(run, |e| {
        e.state = Some("done".into());
        e.status = Some("idle".into());
    });
}

async fn comment_drafts(rig: &Rig) -> Vec<crate::domain::Proposal> {
    let all = rig.fx.core.proposals(&crate::domain::ProposalQuery::default()).await.unwrap();
    all.into_iter().filter(|p| matches!(p.intent, crate::domain::Intent::Comment { .. })).collect()
}

#[tokio::test]
async fn a_finished_run_with_a_for_jira_section_leaves_one_comment_draft_and_a_restart_does_not_make_another() {
    let (rig, run) = launched().await;
    rig.poll().await;
    finish_with(&rig, &run, "Found the cause.\n\nFor Jira:\nThe consumer retries without a backoff.");
    rig.poll().await;
    let drafts = comment_drafts(&rig).await;
    let [draft] = drafts.as_slice() else { panic!("{drafts:?}") };
    assert_eq!((draft.state.clone(), draft.created_by), (crate::domain::ProposalState::Pending, crate::domain::CreatedBy::User));
    assert!(matches!(&draft.origin, crate::domain::Origin::Run { run_id, .. } if *run_id == run.id));
    assert!(matches!(&draft.intent, crate::domain::Intent::Comment { body, .. } if body.plain_text().contains("The consumer retries without a backoff.")));
    assert!(rig.fx.tracker.intents().is_empty(), "a draft writes nothing to Jira");
    assert_eq!(rig.drafted.lock().unwrap().len(), 1);
    assert_eq!(rig.noticed().last(), Some(&(Attention::Drafted, RunState::Done)));
    assert_eq!(notice_text(&rig.get(&run).await, Attention::Drafted).title, "Draft ready on CA-1");

    rig.poll().await;
    assert_eq!(comment_drafts(&rig).await.len(), 1);
    rig.fx.core.skip_proposal(&draft.id).await.unwrap();
    rig.set(&run, |r| r.state = RunState::Working).await;
    rig.session(&run, working);
    rig.poll().await;
    finish_with(&rig, &run, "Found the cause.\n\nFor Jira:\nThe consumer retries without a backoff.");
    rig.poll().await;
    assert_eq!(comment_drafts(&rig).await.len(), 1, "a skipped draft is not made again when the run finishes again");
    assert_eq!(rig.noticed().last(), Some(&(Attention::Done, RunState::Done)));
}

#[tokio::test]
async fn a_result_without_a_for_jira_section_is_not_drafted() {
    let (rig, run) = launched().await;
    rig.poll().await;
    finish_with(&rig, &run, "It is the rounding, nothing marked for Jira.");
    rig.poll().await;
    assert!(comment_drafts(&rig).await.is_empty());
    assert!(rig.drafted.lock().unwrap().is_empty());
    assert_eq!(rig.noticed().last(), Some(&(Attention::Done, RunState::Done)));
}

#[tokio::test]
async fn turning_the_setting_off_stops_the_automatic_draft() {
    let (rig, run) = launched().await;
    rig.svc.set_settings(crate::config::AgentSettings { draft_on_finish: false, ..rig.svc.settings() }).unwrap();
    rig.poll().await;
    finish_with(&rig, &run, "For Jira: done.");
    rig.poll().await;
    assert!(comment_drafts(&rig).await.is_empty());
    assert_eq!(rig.noticed().last(), Some(&(Attention::Done, RunState::Done)));
}
