use std::sync::Arc;

use chrono::Duration as Span;

use super::*;
use crate::runs::cli::TimelineLine;
use crate::runs::index::RunIndex;
use crate::runs::rig::{line, ready, Rig};
use crate::runs::state::{quiet_for, QUIET_AFTER};
use crate::runs::testing::FakeCli;

const FAKE_TOKEN: &str = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

const SUMMARY: &str = "Triage complete: one line.";

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

    rig.cli.with(|s| {
        s.answers.insert("b0000001-0000-4000-8000-000000000000".into(), "It is the cart rounding.\nFor Jira: close as duplicate.".into());
    });
    rig.job(&id, |j| {
        j.result = Some(SUMMARY.into());
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
    assert_eq!((done.summary.as_deref(), done.result_complete), (Some(SUMMARY), true));
    assert_eq!((done.tokens, done.branch.as_deref()), (Some(578_000), Some("worktree-eng-1-fix-cart-0001")));
    assert!(done.ended_at.is_some());
    assert_eq!(rig.noticed().last(), Some(&(Attention::Drafted, RunState::Done)));
    assert!(rig.svc.index.live().is_empty(), "a finished run leaves the index's live list");
    assert!(!rig.changes.lock().unwrap().is_empty());

    rig.set(&run, |r| r.ended_at = Some(Utc::now() - Span::hours(7))).await;
    let polls = rig.cli.0.lock().unwrap().listings;
    rig.poll().await;
    assert_eq!(rig.cli.0.lock().unwrap().listings, polls, "nothing unfinished or lately finished, so claude isn't asked");
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

/// The session ends with `result` as its last message and `state.json` holds only the one-line summary.
fn finish_with(rig: &Rig, run: &Run, result: &str) {
    let short = run.short_id.as_ref().unwrap();
    rig.job(short, |j| j.result = Some(SUMMARY.into()));
    rig.cli.with(|s| {
        s.answers.insert(format!("{short}-0000-4000-8000-000000000000"), result.into());
    });
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

async fn ticket_drafts(rig: &Rig) -> Vec<crate::domain::Proposal> {
    let all = rig.fx.core.proposals(&crate::domain::ProposalQuery::default()).await.unwrap();
    all.into_iter().filter(|p| matches!(p.intent, crate::domain::Intent::Create { .. })).collect()
}

const TICKET_ANSWER: &str = "I read the consumer.\n\nNew ticket:\nTitle: Add a backoff to the order consumer\nKind: bug\nIt retries in a tight loop.";

#[tokio::test]
async fn a_finished_investigation_with_no_ticket_leaves_one_draft_ticket_and_a_restart_does_not_make_another() {
    let rig = ready().await;
    let run = rig.launched_ticketless(1).await;
    rig.poll().await;
    finish_with(&rig, &run, TICKET_ANSWER);
    rig.poll().await;
    let drafts = ticket_drafts(&rig).await;
    let [draft] = drafts.as_slice() else { panic!("{drafts:?}") };
    assert_eq!((draft.state.clone(), draft.created_by), (crate::domain::ProposalState::Pending, crate::domain::CreatedBy::User));
    assert!(matches!(&draft.origin, crate::domain::Origin::Run { run_id, .. } if *run_id == run.id));
    assert!(matches!(&draft.intent, crate::domain::Intent::Create { fields, .. } if fields.title == "Add a backoff to the order consumer"));
    assert!(comment_drafts(&rig).await.is_empty() && rig.fx.tracker.intents().is_empty(), "nothing is posted or created");
    assert_eq!(rig.drafted.lock().unwrap().len(), 1);
    assert_eq!(rig.noticed().last(), Some(&(Attention::DraftedTicket, RunState::Done)));
    assert_eq!(notice_text(&rig.get(&run).await, Attention::DraftedTicket).title, "Draft ticket ready");

    rig.fx.core.skip_proposal(&draft.id).await.unwrap();
    rig.set(&run, |r| r.state = RunState::Working).await;
    rig.session(&run, working);
    rig.poll().await;
    finish_with(&rig, &run, TICKET_ANSWER);
    rig.poll().await;
    assert_eq!(ticket_drafts(&rig).await.len(), 1, "a skipped draft is not made again when the run finishes again");
    assert_eq!(rig.noticed().last(), Some(&(Attention::Done, RunState::Done)));
}

#[tokio::test]
async fn an_investigation_with_no_ticket_and_no_section_is_not_drafted_and_the_setting_applies_too() {
    let rig = ready().await;
    let run = rig.launched_ticketless(1).await;
    rig.poll().await;
    finish_with(&rig, &run, "It is the rounding, nothing marked.");
    rig.poll().await;
    assert!(ticket_drafts(&rig).await.is_empty() && rig.drafted.lock().unwrap().is_empty());
    assert_eq!(rig.noticed().last(), Some(&(Attention::Done, RunState::Done)));

    let rig = ready().await;
    rig.svc.set_settings(crate::config::AgentSettings { draft_on_finish: false, ..rig.svc.settings() }).unwrap();
    let run = rig.launched_ticketless(1).await;
    rig.poll().await;
    finish_with(&rig, &run, TICKET_ANSWER);
    rig.poll().await;
    assert!(ticket_drafts(&rig).await.is_empty());
}

async fn subtask_drafts(rig: &Rig) -> Vec<crate::domain::Proposal> {
    let all = rig.fx.core.proposals(&crate::domain::ProposalQuery::default()).await.unwrap();
    all.into_iter().filter(|p| matches!(p.intent, crate::domain::Intent::Subtasks { .. })).collect()
}

const BREAKDOWN_ANSWER: &str = "Sizing: large.\n\nSubtasks:\n- Add a backoff to the consumer\n- Report the consumer lag\n- Survive a restart\n\nFor Jira:\nToo big for one piece; a breakdown is proposed below.";

#[tokio::test]
async fn a_triage_that_proposes_a_breakdown_leaves_subtasks_beside_its_comment_and_a_restart_does_not_make_another() {
    let rig = ready().await;
    let run = rig.launched_as(1, crate::domain::RunKind::Triage).await;
    rig.poll().await;
    finish_with(&rig, &run, BREAKDOWN_ANSWER);
    rig.poll().await;
    let drafts = subtask_drafts(&rig).await;
    let [draft] = drafts.as_slice() else { panic!("{drafts:?}") };
    assert_eq!((draft.state.clone(), draft.created_by), (crate::domain::ProposalState::Pending, crate::domain::CreatedBy::User));
    assert!(matches!(&draft.origin, crate::domain::Origin::Run { run_id, .. } if *run_id == run.id));
    assert!(matches!(&draft.intent, crate::domain::Intent::Subtasks { parent, summaries } if parent.key == "CA-1" && summaries == &["Add a backoff to the consumer", "Report the consumer lag", "Survive a restart"]));
    assert_eq!(comment_drafts(&rig).await.len(), 1, "the status comment is still drafted");
    assert!(rig.fx.tracker.intents().is_empty(), "nothing is created or posted");
    assert_eq!(rig.drafted.lock().unwrap().len(), 1);
    assert_eq!(rig.noticed().last(), Some(&(Attention::Breakdown, RunState::Done)));
    assert_eq!(notice_text(&rig.get(&run).await, Attention::Breakdown).title, "Breakdown proposed on CA-1");

    rig.fx.core.skip_proposal(&draft.id).await.unwrap();
    rig.fx.core.skip_proposal(&comment_drafts(&rig).await[0].id).await.unwrap();
    rig.set(&run, |r| r.state = RunState::Working).await;
    rig.session(&run, working);
    rig.poll().await;
    finish_with(&rig, &run, BREAKDOWN_ANSWER);
    rig.poll().await;
    assert_eq!(subtask_drafts(&rig).await.len(), 1, "a skipped breakdown is not proposed again when the run finishes again");
    assert_eq!(rig.noticed().last(), Some(&(Attention::Done, RunState::Done)));
}

#[tokio::test]
async fn only_a_triage_with_a_subtasks_section_proposes_one_and_the_setting_applies() {
    let rig = ready().await;
    let plain = rig.launched_as(1, crate::domain::RunKind::Triage).await;
    rig.poll().await;
    finish_with(&rig, &plain, "It fits as one piece.\n\nFor Jira:\nSmall; do it as one ticket.");
    rig.poll().await;
    assert!(subtask_drafts(&rig).await.is_empty());
    assert_eq!(rig.noticed().last(), Some(&(Attention::Drafted, RunState::Done)));

    let rig = ready().await;
    let investigate = rig.launched(1).await;
    rig.poll().await;
    finish_with(&rig, &investigate, BREAKDOWN_ANSWER);
    rig.poll().await;
    assert!(subtask_drafts(&rig).await.is_empty(), "a breakdown is Triage's");

    let rig = ready().await;
    rig.svc.set_settings(crate::config::AgentSettings { draft_on_finish: false, ..rig.svc.settings() }).unwrap();
    let triage = rig.launched_as(1, crate::domain::RunKind::Triage).await;
    rig.poll().await;
    finish_with(&rig, &triage, BREAKDOWN_ANSWER);
    rig.poll().await;
    assert!(subtask_drafts(&rig).await.is_empty() && comment_drafts(&rig).await.is_empty());
}

async fn description_drafts(rig: &Rig) -> Vec<crate::domain::Proposal> {
    let all = rig.fx.core.proposals(&crate::domain::ProposalQuery::default()).await.unwrap();
    all.into_iter().filter(|p| matches!(p.intent, crate::domain::Intent::Rewrite { .. })).collect()
}

const PLAN_ANSWER: &str = "## Approach\n\nRound once.\n\n## Steps\n\n1. Fix cart.rs\n\nFor Jira:\nPlan attached to the run.";
const SECOND_PLAN_ANSWER: &str = "## Approach\n\nRound twice.\n\nFor Jira:\nPlan attached to the run, revised.";

#[tokio::test]
async fn a_plan_that_finishes_leaves_its_status_comment_and_a_description_update_and_says_so_once() {
    let rig = ready().await;
    let run = rig.launched_as(1, crate::domain::RunKind::Plan).await;
    rig.poll().await;
    finish_with(&rig, &run, PLAN_ANSWER);
    rig.poll().await;
    let drafts = description_drafts(&rig).await;
    let [draft] = drafts.as_slice() else { panic!("{drafts:?}") };
    assert!(matches!(&draft.origin, crate::domain::Origin::Run { run_id, .. } if *run_id == run.id));
    assert_eq!(draft.created_by, crate::domain::CreatedBy::User);
    assert!(matches!(&draft.intent, crate::domain::Intent::Rewrite { body: Some(b), .. } if b.to.to_markdown().contains("## Gossamr Plan") && b.to.to_markdown().contains("Round once.") && !b.to.to_markdown().contains("For Jira")));
    assert_eq!(comment_drafts(&rig).await.len(), 1, "the status comment is still drafted");
    assert!(rig.fx.tracker.intents().is_empty(), "nothing is written");
    assert_eq!(rig.drafted.lock().unwrap().len(), 1);
    assert_eq!(rig.noticed(), [(Attention::PlanDrafted, RunState::Done)]);
    let notice = notice_text(&rig.get(&run).await, Attention::PlanDrafted);
    assert_eq!((notice.title.as_str(), notice.body.starts_with("Description update ready")), ("Plan finished on CA-1", true));
    rig.poll().await;
    assert_eq!(description_drafts(&rig).await.len(), 1, "polling again makes no second");
}

#[tokio::test]
async fn a_continued_plan_that_finishes_again_replaces_the_waiting_description_update() {
    let rig = ready().await;
    let run = rig.launched_as(1, crate::domain::RunKind::Plan).await;
    rig.poll().await;
    finish_with(&rig, &run, PLAN_ANSWER);
    rig.poll().await;
    rig.set(&run, |r| r.state = RunState::Working).await;
    rig.session(&run, working);
    rig.poll().await;
    finish_with(&rig, &run, SECOND_PLAN_ANSWER);
    rig.poll().await;
    let drafts = description_drafts(&rig).await;
    let waiting: Vec<_> = drafts.iter().filter(|p| p.state == crate::domain::ProposalState::Pending).collect();
    let [now] = waiting.as_slice() else { panic!("{drafts:?}") };
    assert!(matches!(&now.intent, crate::domain::Intent::Rewrite { body: Some(b), .. } if b.to.to_markdown().contains("Round twice.") && !b.to.to_markdown().contains("Round once.")));
    assert_eq!(drafts.len(), 2, "the first was retired, not duplicated");
}

#[tokio::test]
async fn a_plan_on_a_tracker_that_cannot_edit_text_notifies_like_any_other_and_the_setting_applies() {
    let rig = ready().await;
    rig.fx.tracker.cannot_edit_text.store(true, std::sync::atomic::Ordering::SeqCst);
    let run = rig.launched_as(1, crate::domain::RunKind::Plan).await;
    rig.poll().await;
    finish_with(&rig, &run, PLAN_ANSWER);
    rig.poll().await;
    assert!(description_drafts(&rig).await.is_empty());
    assert_eq!(rig.noticed().last(), Some(&(Attention::Drafted, RunState::Done)));

    let rig = ready().await;
    rig.svc.set_settings(crate::config::AgentSettings { draft_on_finish: false, ..rig.svc.settings() }).unwrap();
    let run = rig.launched_as(1, crate::domain::RunKind::Plan).await;
    rig.poll().await;
    finish_with(&rig, &run, PLAN_ANSWER);
    rig.poll().await;
    assert!(description_drafts(&rig).await.is_empty() && comment_drafts(&rig).await.is_empty());
}

fn finish_without_a_transcript(rig: &Rig, run: &Run, summary: &str) {
    rig.job(run.short_id.as_ref().unwrap(), |j| j.result = Some(summary.into()));
    rig.session(run, |e| {
        e.state = Some("done".into());
        e.status = Some("idle".into());
    });
}

fn session_of(run: &Run) -> String {
    format!("{}-0000-4000-8000-000000000000", run.short_id.as_ref().unwrap())
}

#[tokio::test]
async fn a_run_whose_transcript_never_appears_keeps_the_summary_says_so_and_drafts_nothing() {
    let (rig, run) = launched().await;
    rig.poll().await;
    finish_without_a_transcript(&rig, &run, "Triage complete. For Jira:\nA marker inside a summary.");
    rig.poll().await;
    let done = rig.get(&run).await;
    assert_eq!(done.state, RunState::Done);
    assert_eq!((done.result.as_deref(), done.summary.as_deref(), done.result_complete), (done.summary.as_deref(), Some("Triage complete. For Jira:\nA marker inside a summary."), false));
    assert_eq!(rig.cli.0.lock().unwrap().answer_reads.len(), 1, "one look at the transition, no sleeping while the tracker holds its lock");
    assert!(comment_drafts(&rig).await.is_empty(), "a bare summary is never drafted from, whatever it says");
    assert!(rig.drafted.lock().unwrap().is_empty());
    assert_eq!(rig.noticed().last(), Some(&(Attention::Done, RunState::Done)));
}

#[tokio::test]
async fn a_final_message_that_lands_after_the_session_is_listed_done_is_found_by_a_later_poll_and_drafted_then() {
    let (rig, run) = launched().await;
    rig.poll().await;
    rig.cli.with(|s| s.answer_misses = 2);
    finish_with(&rig, &run, "Found it.\n\nFor Jira:\nAdd a backoff.");
    rig.poll().await;
    assert!(!rig.get(&run).await.result_complete && comment_drafts(&rig).await.is_empty());
    rig.poll().await;
    assert!(!rig.get(&run).await.result_complete);

    rig.poll().await;
    let done = rig.get(&run).await;
    assert_eq!((done.result.as_deref(), done.result_complete), (Some("Found it.\n\nFor Jira:\nAdd a backoff."), true));
    assert_eq!(done.summary.as_deref(), Some(SUMMARY));
    assert_eq!(rig.cli.0.lock().unwrap().answer_reads.len(), 3);
    assert_eq!(comment_drafts(&rig).await.len(), 1);
    assert_eq!(rig.noticed().last(), Some(&(Attention::Drafted, RunState::Done)));
}

#[tokio::test]
async fn the_transcript_is_looked_for_by_session_id_under_the_runs_worktree_and_reported_folder() {
    let (rig, run) = launched().await;
    rig.poll().await;
    rig.job(run.short_id.as_ref().unwrap(), |j| j.worktree_path = Some("/reported/by/state/json".into()));
    finish_with(&rig, &run, "Fine.");
    rig.poll().await;
    let reads = rig.cli.0.lock().unwrap().answer_reads.clone();
    let [(session, folders), ..] = reads.as_slice() else { panic!("{reads:?}") };
    assert_eq!(session, &session_of(&run));
    assert!(folders.contains(&PathBuf::from("/reported/by/state/json")) && folders.contains(&run.expected_worktree), "{folders:?}");
}

#[tokio::test]
async fn the_timelines_done_text_stands_in_when_the_transcript_cannot_be_read() {
    let (rig, run) = launched().await;
    rig.poll().await;
    let answer = "Done.\n\nFor Jira:\nThe consumer needs a backoff.";
    rig.job(run.short_id.as_ref().unwrap(), |j| {
        j.result = Some(SUMMARY.into());
        j.timeline.push(line("2026-01-01T00:05:00Z", "done", answer));
    });
    rig.session(&run, |e| e.state = Some("done".into()));
    rig.poll().await;
    let done = rig.get(&run).await;
    assert_eq!((done.result.as_deref(), done.result_complete), (Some(answer), true));
    assert_eq!(comment_drafts(&rig).await.len(), 1);

    let (rig, run) = launched().await;
    rig.poll().await;
    rig.job(run.short_id.as_ref().unwrap(), |j| {
        j.result = Some(SUMMARY.into());
        j.timeline.push(line("2026-01-01T00:05:00Z", "done", SUMMARY));
    });
    rig.session(&run, |e| e.state = Some("done".into()));
    rig.poll().await;
    assert!(!rig.get(&run).await.result_complete, "a done line equal to the summary proves nothing");
}

#[tokio::test]
async fn the_stored_answer_is_cleaned_like_any_other_agent_text() {
    let (rig, run) = launched().await;
    rig.poll().await;
    finish_with(&rig, &run, &format!("Found it. {FAKE_TOKEN}\n\nFor Jira:\nAdd a backoff."));
    rig.poll().await;
    let done = rig.get(&run).await;
    let result = done.result.unwrap();
    assert!(!result.contains(FAKE_TOKEN) && result.contains("Add a backoff."), "{result}");
    let drafts = comment_drafts(&rig).await;
    assert!(matches!(&drafts[0].intent, crate::domain::Intent::Comment { body, .. } if !body.plain_text().contains(FAKE_TOKEN)));
}

#[tokio::test]
async fn a_very_long_answer_is_cut_to_the_stored_limit() {
    let (rig, run) = launched().await;
    rig.poll().await;
    finish_with(&rig, &run, &"word ".repeat(10_000));
    rig.poll().await;
    assert_eq!(rig.get(&run).await.result.unwrap().chars().count(), RESULT_KEPT);
}

#[tokio::test]
async fn opening_a_run_that_finished_with_only_a_summary_fills_in_the_answer_once_it_can_be_read_and_drafts_nothing() {
    let (rig, run) = launched().await;
    rig.poll().await;
    finish_without_a_transcript(&rig, &run, SUMMARY);
    rig.poll().await;
    rig.set(&run, |r| r.ended_at = Some(Utc::now() - Span::hours(2))).await;
    assert!(!rig.svc.refresh_result(&run.id).await, "nothing to read yet");
    assert!(!rig.get(&run).await.result_complete);

    rig.cli.with(|s| {
        s.answers.insert(session_of(&run), "Found it.\n\nFor Jira:\nAdd a backoff.".into());
    });
    let told = rig.changes.lock().unwrap().len();
    assert!(rig.svc.refresh_result(&run.id).await);
    let healed = rig.get(&run).await;
    assert_eq!((healed.result.as_deref(), healed.summary.as_deref(), healed.result_complete), (Some("Found it.\n\nFor Jira:\nAdd a backoff."), Some(SUMMARY), true));
    assert_eq!(rig.changes.lock().unwrap().len(), told + 1, "the page is told to re-read the run");
    assert!(comment_drafts(&rig).await.is_empty(), "an old run isn't drafted from behind the person's back");
    assert!(!rig.svc.refresh_result(&run.id).await, "a complete result is left alone");
}

#[tokio::test]
async fn a_run_stored_before_summaries_were_kept_separately_gets_its_old_result_as_the_summary() {
    let (rig, run) = launched().await;
    rig.poll().await;
    finish_without_a_transcript(&rig, &run, SUMMARY);
    rig.poll().await;
    rig.set(&run, |r| (r.summary, r.ended_at) = (None, Some(Utc::now() - Span::hours(1)))).await;
    rig.cli.with(|s| {
        s.answers.insert(session_of(&run), "Full.".into());
    });
    assert!(rig.svc.refresh_result(&run.id).await);
    assert_eq!(rig.get(&run).await.summary.as_deref(), Some(SUMMARY));
}

#[tokio::test]
async fn a_run_that_finished_a_moment_ago_is_polled_for_its_answer_and_then_drafted() {
    let (rig, run) = launched().await;
    rig.poll().await;
    finish_without_a_transcript(&rig, &run, SUMMARY);
    rig.poll().await;
    assert!(comment_drafts(&rig).await.is_empty());
    assert_eq!(rig.noticed().last(), Some(&(Attention::Done, RunState::Done)));

    rig.cli.with(|s| {
        s.answers.insert(session_of(&run), "Found it.\n\nFor Jira:\nAdd a backoff.".into());
    });
    assert!(rig.svc.poll_at(Utc::now()).await.busy, "a run waiting for its answer keeps the next look soon");
    assert!(rig.get(&run).await.result_complete);
    assert_eq!(comment_drafts(&rig).await.len(), 1);
    assert_eq!(rig.noticed().last(), Some(&(Attention::Drafted, RunState::Done)));

    rig.poll().await;
    assert_eq!(comment_drafts(&rig).await.len(), 1, "once complete it is left alone");
}

#[tokio::test]
async fn a_run_stops_being_polled_for_its_answer_after_two_minutes() {
    let (rig, run) = launched().await;
    rig.poll().await;
    finish_without_a_transcript(&rig, &run, SUMMARY);
    rig.poll().await;
    rig.set(&run, |r| r.ended_at = Some(Utc::now() - Span::minutes(3))).await;
    let reads = rig.cli.0.lock().unwrap().answer_reads.len();
    assert!(!rig.svc.poll_at(Utc::now()).await.busy);
    assert_eq!(rig.cli.0.lock().unwrap().answer_reads.len(), reads);
}

#[tokio::test]
async fn timeline_lines_with_fractions_of_a_second_are_stored_once_however_often_the_run_is_polled() {
    let (rig, run) = launched().await;
    rig.job(run.short_id.as_ref().unwrap(), |j| {
        j.timeline = vec![
            TimelineLine { at: Some("2026-10-02T12:22:45.174Z".into()), state: Some("working".into()), detail: Some("Running git fetch origin main -q".into()), text: Some(String::new()) },
            line("2026-10-02T12:22:46.900Z", "working", "Reading the cart module"),
        ];
    });
    for _ in 0..5 {
        rig.poll().await;
    }
    let texts: Vec<String> = rig.fx.core.run_events(&run.id).await.unwrap().into_iter().map(|e| e.text).collect();
    assert_eq!(texts, ["Running git fetch origin main -q", "Reading the cart module"]);

    rig.job(run.short_id.as_ref().unwrap(), |j| j.timeline.push(line("2026-10-02T12:23:09.612Z", "working", "Done reading")));
    rig.poll().await;
    rig.poll().await;
    assert_eq!(rig.fx.core.run_events(&run.id).await.unwrap().len(), 3, "a new line is added once");
}

const ANSWER: &str = "Built it.\n\nFor Jira:\nPass-through rules added.";
const SECOND_ANSWER: &str = "Fixed the review comment.\n\nFor Jira:\nA different note.";

fn attached_idle(entry: &mut AgentEntry) {
    entry.state = Some("working".into());
    entry.status = Some("idle".into());
    entry.waiting_for = None;
    entry.pid = Some(4242);
}

/// Claude's answer to the person: in the transcript, and as the newest timeline line.
fn answered(rig: &Rig, run: &Run, at: &str, text: &str) {
    rig.cli.with(|s| {
        s.answers.insert(session_of(run), text.into());
    });
    rig.job(run.short_id.as_ref().unwrap(), |j| j.timeline.push(line(at, "working", text)));
}

/// The person typed a follow-up: a line with a detail and no text.
fn typed(rig: &Rig, run: &Run, at: &str) {
    let follow_up = TimelineLine { at: Some(at.into()), state: Some("working".into()), detail: Some("one more thing".into()), text: None };
    rig.job(run.short_id.as_ref().unwrap(), |j| j.timeline.push(follow_up));
}

async fn polls(rig: &Rig, n: u32) {
    for _ in 0..n {
        rig.poll().await;
    }
}

async fn attached_and_answered() -> (Rig, Run) {
    let (rig, run) = launched().await;
    rig.poll().await;
    answered(&rig, &run, "2026-01-01T00:05:00Z", ANSWER);
    rig.session(&run, attached_idle);
    rig.poll().await;
    rig.poll().await;
    (rig, run)
}

#[tokio::test]
async fn a_session_left_open_at_its_prompt_after_answering_is_done_on_the_second_idle_poll() {
    let (rig, run) = launched().await;
    rig.poll().await;
    answered(&rig, &run, "2026-01-01T00:05:00Z", ANSWER);
    rig.session(&run, attached_idle);

    rig.poll().await;
    assert_eq!(rig.get(&run).await.state, RunState::Working, "one idle look is not enough");
    assert!(rig.noticed().is_empty() && comment_drafts(&rig).await.is_empty());

    rig.poll().await;
    let done = rig.get(&run).await;
    assert_eq!((done.state, done.result.as_deref(), done.result_complete), (RunState::Done, Some(ANSWER), true));
    assert!(done.ended_at.is_some() && done.continued_at.is_none());
    assert_eq!(rig.noticed(), [(Attention::Drafted, RunState::Done)]);
    assert_eq!(comment_drafts(&rig).await.len(), 1);
    assert!(rig.svc.index.live().is_empty());

    for _ in 0..3 {
        rig.poll().await;
    }
    assert_eq!(rig.get(&run).await, done, "an idle session leaves a finished run alone");
    assert_eq!((rig.noticed().len(), comment_drafts(&rig).await.len()), (1, 1));

    let tally = rig.svc.stop_all().await.unwrap();
    assert_eq!(tally.stopped, 0);
    assert!(rig.cli.0.lock().unwrap().stops.is_empty(), "stop all never touches a finished run");
}

#[tokio::test]
async fn an_idle_session_that_has_not_answered_or_is_asking_or_has_work_in_the_background_stays_working() {
    let (rig, run) = launched().await;
    rig.poll().await;
    rig.session(&run, attached_idle);
    let id = run.short_id.clone().unwrap();

    rig.job(&id, |j| j.timeline.push(TimelineLine { at: Some("2026-01-01T00:01:00Z".into()), state: Some("working".into()), detail: Some("Running ls".into()), text: None }));
    polls(&rig, 4).await;
    assert_eq!(rig.get(&run).await.state, RunState::Working, "between tool calls the newest line has no text");

    rig.job(&id, |j| j.timeline.push(line("2026-01-01T00:02:00Z", "blocked", "Which one?")));
    polls(&rig, 4).await;
    assert_eq!(rig.get(&run).await.state, RunState::Working, "a question is not an answer");

    answered(&rig, &run, "2026-01-01T00:03:00Z", ANSWER);
    rig.job(&id, |j| j.in_flight = Some(2));
    polls(&rig, 4).await;
    assert_eq!(rig.get(&run).await.state, RunState::Working, "background tasks are still going");
    assert!(rig.noticed().is_empty());

    rig.job(&id, |j| j.in_flight = Some(0));
    polls(&rig, 4).await;
    assert_eq!(rig.get(&run).await.state, RunState::Done);
}

#[tokio::test]
async fn a_busy_look_between_two_idle_looks_starts_the_count_again() {
    let (rig, run) = launched().await;
    rig.poll().await;
    answered(&rig, &run, "2026-01-01T00:05:00Z", ANSWER);
    rig.session(&run, attached_idle);
    rig.poll().await;
    rig.session(&run, working);
    rig.poll().await;
    rig.session(&run, attached_idle);
    rig.poll().await;
    assert_eq!(rig.get(&run).await.state, RunState::Working);
    rig.poll().await;
    assert_eq!(rig.get(&run).await.state, RunState::Done);
}

#[tokio::test]
async fn a_finished_run_whose_session_carries_on_goes_back_to_working_and_finishes_again_without_a_second_notice_or_draft() {
    let (rig, run) = attached_and_answered().await;
    assert_eq!(rig.get(&run).await.state, RunState::Done);

    typed(&rig, &run, "2026-01-01T00:10:00Z");
    rig.session(&run, working);
    let polled = rig.svc.poll_at(Utc::now()).await;
    assert!(polled.busy, "a finished run being worked on again is watched closely");
    let again = rig.get(&run).await;
    assert_eq!(again.state, RunState::Working);
    assert!(again.continued_at.is_some() && again.ended_at.is_none());
    assert_eq!(again.result.as_deref(), Some(ANSWER), "the earlier answer stays until there is a new one");
    assert_eq!(rig.svc.index.live().len(), 1, "it counts as running again");

    answered(&rig, &run, "2026-01-01T00:15:00Z", SECOND_ANSWER);
    rig.session(&run, attached_idle);
    rig.poll().await;
    assert_eq!(rig.get(&run).await.state, RunState::Working);
    rig.poll().await;
    let second = rig.get(&run).await;
    assert_eq!((second.state, second.result.as_deref()), (RunState::Done, Some(SECOND_ANSWER)));
    assert!(second.ended_at.is_some() && second.continued_at.is_some());
    assert!(rig.svc.index.live().is_empty());
    assert_eq!(rig.noticed(), [(Attention::Drafted, RunState::Done)], "no second notice");
    assert_eq!((comment_drafts(&rig).await.len(), rig.drafted.lock().unwrap().len()), (1, 1), "no second draft");
}

#[tokio::test]
async fn a_finished_run_that_is_asked_something_or_blocked_after_carrying_on_notifies_like_any_other() {
    let (rig, run) = attached_and_answered().await;
    typed(&rig, &run, "2026-01-01T00:10:00Z");
    rig.session(&run, |e| {
        working(e);
        permission(e);
    });
    rig.job(run.short_id.as_ref().unwrap(), |j| j.needs = Some("approve Bash: ls".into()));
    rig.poll().await;
    let asked = rig.get(&run).await;
    assert_eq!((asked.state, asked.needs.as_deref()), (RunState::NeedsPermission, Some("approve Bash: ls")));
    assert_eq!(rig.noticed().last(), Some(&(Attention::Needs, RunState::NeedsPermission)));
}

#[tokio::test]
async fn limits_never_stop_a_finished_idle_session_or_one_the_person_carried_on() {
    let (rig, run) = attached_and_answered().await;
    rig.svc.set_settings(crate::config::AgentSettings { wall_clock_minutes: 30, token_cap: 1, ..Default::default() }).unwrap();
    rig.set(&run, |r| {
        r.launched_at = Some(Utc::now() - Span::hours(5));
        r.tokens = Some(900_000);
    })
    .await;
    for _ in 0..3 {
        rig.poll().await;
    }
    assert_eq!(rig.get(&run).await.state, RunState::Done);

    typed(&rig, &run, "2026-01-01T00:10:00Z");
    rig.session(&run, working);
    rig.job(run.short_id.as_ref().unwrap(), |j| j.tokens = Some(950_000));
    rig.poll().await;
    rig.poll().await;
    assert_eq!(rig.get(&run).await.state, RunState::Working);
    assert!(rig.cli.0.lock().unwrap().stops.is_empty(), "the session was never stopped for a limit");
    assert!(!rig.noticed().iter().any(|(why, _)| *why == Attention::Limit));
}

#[tokio::test]
async fn a_finished_run_is_only_reopened_by_a_live_session_that_is_working_or_asking() {
    let (rig, run) = attached_and_answered().await;
    let before = rig.get(&run).await;
    for change in [
        (|e: &mut AgentEntry| e.state = Some("done".into())) as fn(&mut AgentEntry),
        |e| {
            e.state = Some("working".into());
            e.status = Some("busy".into());
            e.pid = None;
        },
        |e| {
            e.state = Some("stopped".into());
            e.pid = None;
        },
    ] {
        rig.session(&run, |e| {
            attached_idle(e);
            change(e);
        });
        rig.poll().await;
        assert_eq!(rig.get(&run).await, before);
    }
    rig.cli.with(|s| s.sessions.clear());
    rig.poll().await;
    assert_eq!(rig.get(&run).await, before, "an unlisted finished run stays finished");
}

#[tokio::test]
async fn a_finished_run_that_ended_long_ago_or_lost_its_worktree_is_not_watched() {
    let (rig, run) = attached_and_answered().await;
    typed(&rig, &run, "2026-01-01T00:10:00Z");
    rig.session(&run, working);
    rig.set(&run, |r| r.worktree_removed_at = Some(Utc::now())).await;
    rig.poll().await;
    assert_eq!(rig.get(&run).await.state, RunState::Done);
    rig.set(&run, |r| {
        r.worktree_removed_at = None;
        r.ended_at = Some(Utc::now() - Span::hours(7));
    })
    .await;
    rig.poll().await;
    assert_eq!(rig.get(&run).await.state, RunState::Done);
}

#[tokio::test]
async fn the_second_answer_of_a_continued_session_is_read_from_its_newest_timeline_line_when_the_transcript_is_unreadable() {
    let (rig, run) = launched().await;
    rig.poll().await;
    rig.job(run.short_id.as_ref().unwrap(), |j| j.timeline.push(line("2026-01-01T00:05:00Z", "done", ANSWER)));
    rig.session(&run, |e| e.state = Some("done".into()));
    rig.poll().await;
    assert_eq!(rig.get(&run).await.result.as_deref(), Some(ANSWER));

    typed(&rig, &run, "2026-01-01T00:10:00Z");
    rig.session(&run, working);
    rig.poll().await;
    rig.job(run.short_id.as_ref().unwrap(), |j| j.timeline.push(line("2026-01-01T00:15:00Z", "working", SECOND_ANSWER)));
    rig.session(&run, attached_idle);
    polls(&rig, 2).await;
    assert_eq!(rig.get(&run).await.result.as_deref(), Some(SECOND_ANSWER));
}

fn asking(entry: &mut AgentEntry) {
    entry.state = Some("blocked".into());
    entry.status = None;
    entry.pid = None;
}

/// A second start of the app: same accounts and listing, none of the first one's memory.
fn restarted(rig: &Rig) -> RunService {
    RunService::new(rig.fx.core.clone(), rig.svc.tools.clone(), RunIndex::load(&rig.fx.dir.join("index")), vec![], Arc::new(|_| {})).enabled(true).with_settings(rig.svc.settings())
}

#[tokio::test]
async fn a_run_that_waits_three_hours_for_an_answer_and_then_works_ten_minutes_is_not_stopped_by_the_hour_limit() {
    let (rig, run) = launched().await;
    rig.svc.set_settings(crate::config::AgentSettings { wall_clock_minutes: 60, ..Default::default() }).unwrap();
    let t0 = Utc::now();
    let at = |minutes: i64| t0 + Span::minutes(minutes);
    rig.poll().await;
    rig.svc.poll_at(at(5)).await;

    rig.session(&run, asking);
    rig.svc.poll_at(at(6)).await;
    assert_eq!(rig.get(&run).await.state, RunState::NeedsAnswer);

    rig.svc.poll_at(at(60 + 6)).await;
    rig.svc.poll_at(at(180)).await;
    let waiting = rig.get(&run).await;
    assert_eq!((waiting.state, waiting.error), (RunState::NeedsAnswer, None), "three hours of waiting is not three hours of work");
    assert!(rig.cli.0.lock().unwrap().stops.is_empty());

    let app = restarted(&rig);
    let kept = rig.get(&run).await;
    assert_eq!(kept.waiting_since.map(|s| (s - t0).num_minutes()), Some(6), "the wait is stored on the run, not in memory");
    rig.session(&run, working);
    app.poll_at(at(186)).await;
    let back = rig.get(&run).await;
    assert_eq!((back.state, back.waiting_since), (RunState::Working, None));
    assert_eq!(back.waited_secs / 60, 180, "the wait was added to the run once it was back at work");

    app.poll_at(at(196)).await;
    assert_eq!(rig.get(&run).await.state, RunState::Working, "15 minutes of work in 196");
    app.poll_at(at(186 + 55)).await;
    let over = rig.get(&run).await;
    assert_eq!(over.state, RunState::Stopped, "an hour of work in 241 minutes");
    assert_eq!(over.error.as_deref(), Some("Stopped by Gossamr: it passed the 60 minute limit"));
    assert!(over.stopped_by_limit);
}

#[tokio::test]
async fn waiting_for_a_permission_or_a_sign_in_pauses_the_clock_as_well() {
    for waiting in [permission as fn(&mut AgentEntry), |e| {
        e.state = Some("blocked".into());
        e.needs = Some("login required \u{2014} run /login".into());
    }] {
        let (rig, run) = launched().await;
        rig.svc.set_settings(crate::config::AgentSettings { wall_clock_minutes: 30, ..Default::default() }).unwrap();
        rig.poll().await;
        rig.session(&run, waiting);
        rig.svc.poll_at(Utc::now() + Span::minutes(1)).await;
        rig.svc.poll_at(Utc::now() + Span::hours(5)).await;
        let held = rig.get(&run).await;
        assert!(matches!(held.state, RunState::NeedsPermission | RunState::SystemBlocked), "{:?}", held.state);
    }
}

#[tokio::test]
async fn a_listing_read_while_an_answer_is_in_flight_is_not_applied_over_the_answer() {
    let (rig, run) = launched().await;
    rig.poll().await;
    rig.session(&run, asking);
    rig.poll().await;
    assert_eq!(rig.get(&run).await.state, RunState::NeedsAnswer);

    let answering = rig.svc.launching.lock().await;
    rig.session(&run, |e| e.state = Some("stopped".into()));
    let svc = rig.svc.clone();
    let polling = tokio::spawn(async move { svc.poll().await });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    rig.set(&run, |r| {
        r.state = RunState::Working;
        r.needs = None;
        r.ended_at = None;
    })
    .await;
    rig.session(&run, working);
    drop(answering);
    polling.await.unwrap();

    let after = rig.get(&run).await;
    assert_eq!((after.state, after.ended_at), (RunState::Working, None), "the poll read the listing after the answer finished");
}

async fn stopped_by_the_person() -> (Rig, Run) {
    let (rig, run) = launched().await;
    rig.poll().await;
    rig.svc.stop(&run.id).await.unwrap();
    let stopped = rig.get(&run).await;
    assert_eq!(stopped.state, RunState::Stopped);
    (rig, stopped)
}

#[tokio::test]
async fn a_stopped_run_whose_session_is_live_again_is_picked_up_and_follows_it() {
    let (rig, run) = stopped_by_the_person().await;
    rig.svc.poll_at(Utc::now() + Span::minutes(5)).await;
    assert_eq!(rig.get(&run).await.state, RunState::Stopped, "a session listed as stopped stays stopped");

    rig.session(&run, |e| {
        e.state = Some("blocked".into());
        e.status = Some("idle".into());
        e.pid = Some(777);
    });
    rig.svc.poll_at(Utc::now() + Span::seconds(20)).await;
    assert_eq!(rig.get(&run).await.state, RunState::Stopped, "a stop is given a minute to settle before a live pid means anything");

    rig.job(run.short_id.as_ref().unwrap(), |j| j.needs = Some("Which branch?".into()));
    rig.svc.poll_at(Utc::now() + Span::minutes(2)).await;
    let asking = rig.get(&run).await;
    assert_eq!((asking.state, asking.needs.as_deref(), asking.ended_at), (RunState::NeedsAnswer, Some("Which branch?"), None));
    assert!(asking.continued_at.is_some() && asking.error.is_none() && !asking.stopped_by_limit);
    assert_eq!(rig.noticed().last(), Some(&(Attention::Needs, RunState::NeedsAnswer)));
    assert!(rig.svc.index.live().iter().any(|e| e.run_id == run.id));

    rig.session(&run, working);
    rig.svc.poll_at(Utc::now() + Span::minutes(3)).await;
    assert_eq!(rig.get(&run).await.state, RunState::Working);
}

#[tokio::test]
async fn a_stopped_run_is_not_picked_up_while_its_answer_is_unsent_or_it_was_removed() {
    let (rig, run) = stopped_by_the_person().await;
    rig.session(&run, working);
    rig.set(&run, |r| r.unsent_answer = Some("Yes".into())).await;
    rig.svc.poll_at(Utc::now() + Span::minutes(5)).await;
    assert_eq!(rig.get(&run).await.state, RunState::Stopped);
    rig.set(&run, |r| {
        r.unsent_answer = None;
        r.worktree_removed_at = Some(Utc::now());
    })
    .await;
    rig.svc.poll_at(Utc::now() + Span::minutes(5)).await;
    assert_eq!(rig.get(&run).await.state, RunState::Stopped);
}

#[tokio::test]
async fn a_run_stopped_for_a_limit_is_picked_up_when_the_person_carries_on_and_is_then_theirs() {
    let (rig, run) = launched().await;
    rig.svc.set_settings(crate::config::AgentSettings { wall_clock_minutes: 30, ..Default::default() }).unwrap();
    rig.poll().await;
    rig.svc.poll_at(Utc::now() + Span::minutes(31)).await;
    let stopped = rig.get(&run).await;
    assert!(stopped.state == RunState::Stopped && stopped.stopped_by_limit);

    rig.session(&run, working);
    rig.svc.poll_at(Utc::now() + Span::minutes(40)).await;
    let carried = rig.get(&run).await;
    assert_eq!(carried.state, RunState::Working);
    assert!(!carried.stopped_by_limit && carried.continued_at.is_some() && carried.error.is_none());
    rig.svc.poll_at(Utc::now() + Span::hours(9)).await;
    assert_eq!(rig.get(&run).await.state, RunState::Working, "the limit doesn't stop it a second time");
    assert_eq!(rig.cli.0.lock().unwrap().stops.len(), 1);
}
