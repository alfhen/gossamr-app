//! The person's limits on a run: how many at once, how long, how many tokens.

use chrono::{DateTime, Duration, Utc};

use super::service::RunService;
use crate::config::AgentSettings;
use crate::domain::{Run, RunState};
use crate::error::Result;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Overrun {
    Wall,
    Tokens,
}

impl Overrun {
    pub fn reason(self, settings: &AgentSettings) -> String {
        match self {
            Overrun::Wall => format!("Stopped by Gossamr: it passed the {} minute limit", settings.wall_clock_minutes),
            Overrun::Tokens => format!("Stopped by Gossamr: it passed the {} token limit", grouped(settings.token_cap)),
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

/// Which limit a run has reached, if any. Only a run that is under way counts: a queued, launching or finished one
/// is exempt, and a limit of zero is off.
pub fn exceeded(run: &Run, now: DateTime<Utc>, settings: &AgentSettings) -> Option<Overrun> {
    let under_way = matches!(run.state, RunState::Working | RunState::NeedsAnswer | RunState::NeedsPermission | RunState::SystemBlocked);
    if !under_way {
        return None;
    }
    let wall = settings.wall_clock_minutes;
    if wall > 0 && run.launched_at.is_some_and(|at| now - at >= Duration::minutes(i64::from(wall))) {
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
        Ok(settings)
    }
}

#[cfg(test)]
mod tests;
