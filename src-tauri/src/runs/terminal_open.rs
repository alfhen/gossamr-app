//! Whether Claude still runs a session handed over to Terminal, before Resume here takes it back, as Claude's own
//! listing on the run's login says. The harness's own check, on every process, is the main one; this one also finds a
//! `/resume` started from another folder, when Claude lists it (`docs/agents-cli-findings.md`).

use super::cli::AgentEntry;

/// Why Resume here waits, in the harness's words (`harness::session::STILL_IN_TERMINAL`).
pub fn still_open(pid: u32) -> String {
    format!("Claude {} (pid {pid}). Quit it there, then Resume here.", harness::session::STILL_IN_TERMINAL)
}

/// The pid of an interactive `claude` that Claude lists for `session`, and that still runs.
pub fn listed_open(listed: &[AgentEntry], session: &str, alive: impl Fn(u32) -> bool) -> Option<u32> {
    listed.iter().filter(|row| row.kind.as_deref() == Some("interactive") && row.session_id.as_deref() == Some(session)).find_map(|row| row.pid.filter(|pid| alive(*pid)))
}

/// Whether `pid` runs: a process of another user that refuses the probe runs too.
pub fn alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else { return false };
    // SAFETY: signal 0 sends nothing; it only asks whether the process exists.
    unsafe { libc::kill(pid, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "1b2c3d4e-0000-4000-8000-000000000001";

    fn row(kind: &str, session: &str, pid: Option<u32>) -> AgentEntry {
        AgentEntry { kind: Some(kind.into()), session_id: Some(session.into()), pid, ..AgentEntry::default() }
    }

    #[test]
    fn hand_over_check_finds_an_interactive_claude_claude_lists_for_the_session_that_still_runs() {
        let runs = |pid: u32| pid != 9;
        assert_eq!(listed_open(&[row("interactive", ID, Some(41))], ID, runs), Some(41));
        assert_eq!(listed_open(&[row("interactive", ID, Some(9))], ID, runs), None, "it has exited");
        assert_eq!(listed_open(&[row("interactive", ID, None)], ID, runs), None, "no process");
        assert_eq!(listed_open(&[row("background", ID, Some(43))], ID, runs), None, "a background session is no Terminal");
        assert_eq!(listed_open(&[row("interactive", "other", Some(44))], ID, runs), None, "another session");
    }
}
