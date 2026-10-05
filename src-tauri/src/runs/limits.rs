//! The person's limits on a run: how many at once, how long, how many tokens.

use chrono::{DateTime, Duration, Utc};

use super::service::RunService;
use crate::config::AgentSettings;
use crate::domain::{Run, RunState, LIMIT_STOP};
use crate::error::Result;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Overrun {
    Wall,
    Tokens,
}

impl Overrun {
    pub fn reason(self, settings: &AgentSettings) -> String {
        match self {
            Overrun::Wall => format!("{LIMIT_STOP}{} minute limit", settings.wall_clock_minutes),
            Overrun::Tokens => format!("{LIMIT_STOP}{} token limit", grouped(settings.token_cap)),
        }
    }
}

fn grouped(n: u64) -> String {
    let digits = n.to_string();
    let first = digits.len() % 3;
    let mut out = digits[..first].to_owned();
    for chunk in digits.as_bytes()[first..].chunks(3) {
        if !out.is_empty() {
            out.push(',');
        }
        out.push_str(std::str::from_utf8(chunk).expect("digits"));
    }
    out
}

/// States in which the run is waiting on the person, not working.
pub fn is_waiting(state: RunState) -> bool {
    matches!(state, RunState::NeedsAnswer | RunState::NeedsPermission | RunState::SystemBlocked)
}

/// How long the run has been at work since it launched: the time it spent waiting on the person is left out.
pub fn worked(run: &Run, now: DateTime<Utc>) -> Option<Duration> {
    let launched = run.launched_at?;
    let open = run.waiting_since.map_or(0, |since| (now - since).num_seconds().max(0));
    let away = i64::try_from(run.waited_secs).unwrap_or(i64::MAX).saturating_add(open);
    Some(((now - launched) - Duration::seconds(away)).max(Duration::zero()))
}

/// Keeps the wait clock in step with the run's state: a wait opens when the run starts waiting and is added to
/// `waited_secs` when it stops. Stored on the run, so a restart picks it up where it was.
pub fn tick(run: &mut Run, now: DateTime<Utc>) {
    if is_waiting(run.state) {
        run.waiting_since.get_or_insert(now);
    } else if let Some(since) = run.waiting_since.take() {
        run.waited_secs = run.waited_secs.saturating_add(u64::try_from((now - since).num_seconds()).unwrap_or(0));
    }
}

/// Which limit a run has reached, if any. Only a run that is under way counts: a queued, launching or finished one
/// is exempt, and so is one the person carried on in Terminal. Time spent waiting on the person doesn't count towards
/// the time limit. A limit of zero is off.
pub fn exceeded(run: &Run, now: DateTime<Utc>, settings: &AgentSettings) -> Option<Overrun> {
    let under_way = matches!(run.state, RunState::Working) || is_waiting(run.state);
    if !under_way || run.continued_at.is_some() {
        return None;
    }
    let wall = settings.wall_clock_minutes;
    if wall > 0 && worked(run, now).is_some_and(|spent| spent >= Duration::minutes(i64::from(wall))) {
        return Some(Overrun::Wall);
    }
    let cap = settings.token_cap;
    (cap > 0 && run.tokens.is_some_and(|t| t >= cap)).then_some(Overrun::Tokens)
}

impl RunService {
    pub fn settings(&self) -> AgentSettings {
        *self.settings.lock().expect("settings lock poisoned")
    }

    pub(super) fn cap(&self) -> usize {
        self.settings().max_runs
    }

    /// Clamps, saves and applies the settings. The saved file is written first, so a failed save changes nothing.
    pub fn set_settings(&self, settings: AgentSettings) -> Result<AgentSettings> {
        let settings = settings.clamped();
        let mut live = self.settings.lock().expect("settings lock poisoned");
        self.update_config(|config| config.agents = settings)?;
        *live = settings;
        self.core.set_report_enabled(settings.report_result);
        Ok(settings)
    }
}

#[cfg(test)]
mod tests;
