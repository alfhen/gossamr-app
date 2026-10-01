//! What a run is doing, from what `claude agents --json` says. The public JSON decides the state; a job's
//! `state.json` lags it and only supplies words.

use std::time::Duration;

use chrono::{DateTime, Utc};

use super::cli::{AgentEntry, JobInfo};
use crate::domain::{Run, RunState};

/// How long a launch may go unlisted before it is called lost.
pub const LAUNCH_WAIT: Duration = Duration::from_secs(90);
pub const QUIET_AFTER: Duration = Duration::from_secs(30 * 60);
/// A working session without a process on this many polls in a row has died.
const MISSES_TO_FAIL: u32 = 2;

pub const WAITING_FOR_YOU: &str = "It is waiting for you";
const NOT_LISTED: &str = "This session isn't listed any more";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Observed {
    pub state: RunState,
    /// The question or the command awaiting permission.
    pub text: Option<String>,
    /// Why the run failed, or why it is unknown.
    pub error: Option<String>,
    pub result: Option<String>,
    /// Consecutive polls a working session had no process; the caller passes it back next time.
    pub pid_misses: u32,
}

impl Observed {
    fn new(state: RunState) -> Self {
        Self { state, text: None, error: None, result: None, pid_misses: 0 }
    }

    fn text(state: RunState, text: Option<String>) -> Self {
        Self { text, ..Self::new(state) }
    }

    fn because(state: RunState, why: impl Into<String>) -> Self {
        Self { error: Some(why.into()), ..Self::new(state) }
    }
}

fn nonblank(s: Option<&str>) -> Option<String> {
    s.map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn is_terminal(state: RunState) -> bool {
    matches!(state, RunState::Done | RunState::Failed | RunState::Stopped)
}

/// First match wins. `prior_misses` is `pid_misses` from the previous poll of this run.
pub fn map_state(entry: Option<&AgentEntry>, job: Option<&JobInfo>, run: &Run, now: DateTime<Utc>, prior_misses: u32) -> Observed {
    let Some(entry) = entry else {
        return match run.state {
            RunState::Queued => Observed::new(RunState::Queued),
            RunState::Launching => {
                let since = run.launched_at.unwrap_or(run.last_progress_at);
                if (now - since).to_std().is_ok_and(|waited| waited >= LAUNCH_WAIT) {
                    Observed::because(RunState::Failed, "Launch wasn't found")
                } else {
                    Observed::new(RunState::Launching)
                }
            }
            s if is_terminal(s) => Observed::new(s),
            _ => Observed::because(RunState::Unknown, NOT_LISTED),
        };
    };
    let needs = nonblank(entry.needs.as_deref()).or_else(|| nonblank(job.and_then(|j| j.needs.as_deref())));
    let state = entry.state.as_deref();
    if entry.status.as_deref() == Some("waiting") && entry.waiting_for.as_deref() == Some("permission prompt") {
        return Observed::text(RunState::NeedsPermission, needs);
    }
    if state == Some("blocked") {
        let system = needs.as_deref().is_some_and(|n| n.contains("login required") || n.contains("/login"));
        return if system {
            Observed::text(RunState::SystemBlocked, needs)
        } else {
            Observed::text(RunState::NeedsAnswer, Some(needs.unwrap_or_else(|| WAITING_FOR_YOU.into())))
        };
    }
    match state {
        Some("working") if entry.pid.is_some() => Observed::new(RunState::Working),
        Some("working") => {
            let misses = prior_misses + 1;
            if misses >= MISSES_TO_FAIL {
                Observed::because(RunState::Failed, "The agent process ended unexpectedly")
            } else {
                Observed { pid_misses: misses, ..Observed::new(RunState::Working) }
            }
        }
        Some("done") => Observed { result: nonblank(job.and_then(|j| j.result.as_deref())), ..Observed::new(RunState::Done) },
        Some("stopped") => Observed::new(RunState::Stopped),
        other => Observed::because(RunState::Unknown, format!("Claude reported {}. Open in Terminal to look.", other.map_or("no state".to_owned(), |s| format!("the state \"{s}\"")))),
    }
}

/// How long a working run has gone without a new timeline line or token growth, once that reaches 30 minutes.
pub fn quiet_for(run: &Run, now: DateTime<Utc>) -> Option<Duration> {
    if run.state != RunState::Working {
        return None;
    }
    let since = run.launched_at.map_or(run.last_progress_at, |l| l.max(run.last_progress_at));
    (now - since).to_std().ok().filter(|d| *d >= QUIET_AFTER)
}

/// Timeline lines carry an ISO string or milliseconds since the epoch, depending on the version.
pub fn parse_at(at: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(at).map(|d| d.with_timezone(&Utc)).ok().or_else(|| DateTime::from_timestamp_millis(at.parse().ok()?))
}

/// The run's new `last_progress_at`: the newest timeline line, or now when the token count grew.
pub fn progress_at(run: &Run, job: &JobInfo, now: DateTime<Utc>) -> DateTime<Utc> {
    let newest_line = job.timeline.iter().filter_map(|l| l.at.as_deref().and_then(parse_at)).max().map(|t| t.min(now));
    let grew = job.tokens.is_some_and(|t| run.tokens.is_none_or(|before| t > before));
    let mut at = run.last_progress_at;
    if let Some(line) = newest_line {
        at = at.max(line);
    }
    if grew {
        at = now;
    }
    at
}

#[cfg(test)]
mod tests {
    use chrono::Duration as Span;

    use super::*;
    use crate::domain::fixtures::run_spec;
    use crate::runs::cli::{parse_agents, parse_job, TimelineLine};

    fn now() -> DateTime<Utc> {
        "2026-09-30T12:00:00Z".parse().unwrap()
    }

    fn run(state: RunState) -> Run {
        let mut r = Run::queued("r1".into(), "p1".into(), "c1".into(), None, run_spec(), "db".into(), now() - Span::hours(3));
        r.state = state;
        r.launched_at = (state != RunState::Queued).then(|| now() - Span::minutes(5));
        r
    }

    fn entry(state: &str, status: Option<&str>, waiting_for: Option<&str>, pid: Option<u32>) -> AgentEntry {
        AgentEntry {
            id: Some("1a2b3c4d".into()),
            kind: Some("background".into()),
            state: Some(state.into()),
            status: status.map(Into::into),
            waiting_for: waiting_for.map(Into::into),
            pid,
            ..AgentEntry::default()
        }
    }

    fn job(f: impl FnOnce(&mut JobInfo)) -> JobInfo {
        let mut j = JobInfo::default();
        f(&mut j);
        j
    }

    fn observe(e: Option<&AgentEntry>, j: Option<&JobInfo>, r: &Run) -> Observed {
        map_state(e, j, r, now(), 0)
    }

    #[test]
    fn row_1_no_entry_for_a_queued_run_stays_queued() {
        assert_eq!(observe(None, None, &run(RunState::Queued)).state, RunState::Queued);
    }

    #[test]
    fn row_2_a_launch_with_no_entry_waits_for_90_seconds_then_is_lost() {
        let mut r = run(RunState::Launching);
        r.launched_at = Some(now() - Span::seconds(89));
        assert_eq!(observe(None, None, &r).state, RunState::Launching);
        r.launched_at = Some(now() - Span::seconds(90));
        let lost = observe(None, None, &r);
        assert_eq!((lost.state, lost.error.as_deref()), (RunState::Failed, Some("Launch wasn't found")));
    }

    #[test]
    fn row_3_a_permission_prompt_is_needs_permission_whatever_the_state() {
        let mut j = JobInfo { needs: Some("approve Bash: touch /x".into()), ..JobInfo::default() };
        for state in ["working", "blocked", "done", "unheard-of"] {
            let e = entry(state, Some("waiting"), Some("permission prompt"), None);
            let o = observe(Some(&e), Some(&j), &run(RunState::Working));
            assert_eq!((o.state, o.text.as_deref()), (RunState::NeedsPermission, Some("approve Bash: touch /x")), "{state}");
        }
        j.needs = None;
        let e = entry("working", Some("waiting"), Some("permission prompt"), Some(1));
        assert_eq!(observe(Some(&e), Some(&j), &run(RunState::Working)).text, None);
        let idle = entry("working", Some("waiting"), Some("something else"), Some(1));
        assert_eq!(observe(Some(&idle), None, &run(RunState::Working)).state, RunState::Working);
    }

    #[test]
    fn row_3_the_public_json_wins_when_state_json_still_says_working() {
        let lagging = job(|j| {
            j.state = Some("working".into());
            j.tempo = Some("active".into());
            j.needs = Some("approve Bash: rm -rf build".into());
        });
        let e = entry("working", Some("waiting"), Some("permission prompt"), Some(77));
        assert_eq!(observe(Some(&e), Some(&lagging), &run(RunState::Working)).state, RunState::NeedsPermission);
    }

    #[test]
    fn row_4_login_required_is_a_system_block_not_a_question() {
        let mut e = entry("blocked", Some("idle"), None, Some(5));
        e.needs = Some("login required \u{2014} run /login".into());
        assert_eq!(observe(Some(&e), None, &run(RunState::Launching)).state, RunState::SystemBlocked);
        e.needs = None;
        let on_disk = job(|j| j.needs = Some("please run /login".into()));
        assert_eq!(observe(Some(&e), Some(&on_disk), &run(RunState::Working)).state, RunState::SystemBlocked);
    }

    #[test]
    fn row_5_blocked_otherwise_is_a_question_and_a_missing_pid_is_normal() {
        let e = entry("blocked", None, None, None);
        let asked = job(|j| j.needs = Some("Which environment?".into()));
        let o = observe(Some(&e), Some(&asked), &run(RunState::Working));
        assert_eq!((o.state, o.text.as_deref(), o.pid_misses), (RunState::NeedsAnswer, Some("Which environment?"), 0));
        let silent = observe(Some(&e), None, &run(RunState::Working));
        assert_eq!((silent.state, silent.text.as_deref()), (RunState::NeedsAnswer, Some(WAITING_FOR_YOU)));
        let blank = job(|j| j.needs = Some("  ".into()));
        assert_eq!(observe(Some(&e), Some(&blank), &run(RunState::Working)).text.as_deref(), Some(WAITING_FOR_YOU));
    }

    #[test]
    fn row_6_working_needs_a_process_and_two_misses_in_a_row_fail() {
        let alive = entry("working", Some("busy"), None, Some(9));
        assert_eq!(observe(Some(&alive), None, &run(RunState::Working)), Observed::new(RunState::Working));
        let gone = entry("working", Some("busy"), None, None);
        let first = map_state(Some(&gone), None, &run(RunState::Working), now(), 0);
        assert_eq!((first.state, first.pid_misses), (RunState::Working, 1));
        let second = map_state(Some(&gone), None, &run(RunState::Working), now(), first.pid_misses);
        assert_eq!((second.state, second.error.as_deref()), (RunState::Failed, Some("The agent process ended unexpectedly")));
        assert_eq!(map_state(Some(&alive), None, &run(RunState::Working), now(), 1).pid_misses, 0, "a process resets the count");
    }

    #[test]
    fn row_7_done_carries_the_result_and_the_public_value_beats_a_lagging_file() {
        let e = entry("done", Some("idle"), None, None);
        let finished = job(|j| j.result = Some("Found it in cart.rs".into()));
        let o = observe(Some(&e), Some(&finished), &run(RunState::Working));
        assert_eq!((o.state, o.result.as_deref()), (RunState::Done, Some("Found it in cart.rs")));
        let lagging = job(|j| j.state = Some("working".into()));
        assert_eq!(observe(Some(&e), Some(&lagging), &run(RunState::Working)).state, RunState::Done);
        assert_eq!(observe(Some(&e), None, &run(RunState::Working)).result, None);
    }

    #[test]
    fn row_8_stopped_covers_a_stop_done_in_terminal() {
        assert_eq!(observe(Some(&entry("stopped", None, None, None)), None, &run(RunState::Working)).state, RunState::Stopped);
    }

    #[test]
    fn row_9_any_other_state_is_unknown_and_says_which() {
        let o = observe(Some(&entry("paused-by-quota", Some("throttled"), None, Some(1))), None, &run(RunState::Working));
        assert_eq!(o.state, RunState::Unknown);
        assert!(o.error.unwrap().contains("paused-by-quota"));
        let none = AgentEntry { id: Some("1a2b3c4d".into()), ..AgentEntry::default() };
        assert_eq!(observe(Some(&none), None, &run(RunState::Working)).state, RunState::Unknown);
    }

    #[test]
    fn row_10_a_session_seen_before_that_is_no_longer_listed_is_unknown() {
        for state in [RunState::Working, RunState::NeedsAnswer, RunState::NeedsPermission, RunState::SystemBlocked, RunState::Unknown] {
            let o = observe(None, None, &run(state));
            assert_eq!((o.state, o.error.as_deref()), (RunState::Unknown, Some("This session isn't listed any more")), "{state:?}");
        }
        for state in [RunState::Done, RunState::Failed, RunState::Stopped] {
            assert_eq!(observe(None, None, &run(state)).state, state);
        }
    }

    #[test]
    fn the_real_fixtures_map_as_the_plan_says() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/test-fixtures/agents/");
        let rows = parse_agents(&std::fs::read_to_string(format!("{dir}agents-2.1.286.json")).unwrap()).unwrap();
        let r = run(RunState::Working);
        let states: Vec<RunState> = rows.iter().filter(|e| e.kind.as_deref() == Some("background")).map(|e| observe(Some(e), None, &r).state).collect();
        assert_eq!(
            states,
            [RunState::Working, RunState::NeedsAnswer, RunState::NeedsPermission, RunState::Done, RunState::Stopped, RunState::NeedsAnswer]
        );
        let on_disk = parse_job(&std::fs::read_to_string(format!("{dir}state-permission.json")).unwrap(), "");
        assert_eq!(on_disk.needs.as_deref(), Some("approve Bash: touch /work/example/scratch.txt"));
    }

    #[test]
    fn quiet_is_none_below_30_minutes_and_some_at_30() {
        let mut r = run(RunState::Working);
        r.launched_at = Some(now() - Span::hours(2));
        r.last_progress_at = now() - Span::minutes(29) - Span::seconds(59);
        assert_eq!(quiet_for(&r, now()), None);
        r.last_progress_at = now() - Span::minutes(30);
        assert_eq!(quiet_for(&r, now()), Some(QUIET_AFTER));
        r.last_progress_at = now() - Span::minutes(95);
        assert_eq!(quiet_for(&r, now()), Some(Duration::from_secs(95 * 60)));
    }

    #[test]
    fn quiet_counts_from_the_launch_when_that_is_later() {
        let mut r = run(RunState::Working);
        r.last_progress_at = now() - Span::hours(3);
        r.launched_at = Some(now() - Span::minutes(10));
        assert_eq!(quiet_for(&r, now()), None);
    }

    #[test]
    fn quiet_is_only_for_working_runs() {
        for state in [RunState::Queued, RunState::Launching, RunState::NeedsAnswer, RunState::NeedsPermission, RunState::SystemBlocked, RunState::Done, RunState::Failed, RunState::Stopped, RunState::Unknown] {
            let mut r = run(state);
            r.last_progress_at = now() - Span::hours(5);
            r.launched_at = Some(now() - Span::hours(5));
            assert_eq!(quiet_for(&r, now()), None, "{state:?}");
        }
    }

    #[test]
    fn a_newer_timeline_line_or_token_growth_resets_the_quiet_clock() {
        let mut r = run(RunState::Working);
        r.last_progress_at = now() - Span::minutes(45);
        r.tokens = Some(1000);
        let line = |at: &str| TimelineLine { at: Some(at.into()), ..TimelineLine::default() };

        let same = job(|j| {
            j.tokens = Some(1000);
            j.timeline = vec![line("2026-09-30T11:00:00Z")];
        });
        assert_eq!(progress_at(&r, &same, now()), r.last_progress_at, "an old line and the same tokens change nothing");

        let newer = job(|j| j.timeline = vec![line("2026-09-30T11:50:00Z"), line("2026-09-30T10:00:00Z")]);
        assert_eq!(progress_at(&r, &newer, now()), "2026-09-30T11:50:00Z".parse::<DateTime<Utc>>().unwrap());

        let grew = job(|j| j.tokens = Some(1001));
        assert_eq!(progress_at(&r, &grew, now()), now());
        let shrank = job(|j| j.tokens = Some(10));
        assert_eq!(progress_at(&r, &shrank, now()), r.last_progress_at);

        let future = job(|j| j.timeline = vec![line("2099-01-01T00:00:00Z")]);
        assert_eq!(progress_at(&r, &future, now()), now(), "a clock far ahead can't push progress into the future");
    }

    #[test]
    fn timeline_stamps_are_iso_or_milliseconds() {
        assert_eq!(parse_at("2026-09-30T10:00:00.000Z"), "2026-09-30T10:00:00Z".parse().ok());
        assert_eq!(parse_at("1790000500000").map(|t| t.timestamp()), Some(1_790_000_500));
        assert_eq!(parse_at("yesterday"), None);
    }
}
