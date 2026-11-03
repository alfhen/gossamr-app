//! Finding a process again by its pid, and telling it from a later process that reused the number.

use crate::domain::RunProcess;

/// The process start time in seconds, or none when there is no such process.
#[cfg(target_os = "macos")]
pub fn started_of(pid: u32) -> Option<u64> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: `info` is as large as `size` says, and the call fills at most that much.
    let got = unsafe { libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDTBSDINFO, 0, info.as_mut_ptr().cast(), size) };
    if got != size {
        return None;
    }
    // SAFETY: the call filled the whole struct.
    let info = unsafe { info.assume_init() };
    Some(info.pbi_start_tvsec)
}

/// Field 22 of `/proc/<pid>/stat`, in clock ticks since boot. Unlike `etimes`, it does not move between calls.
#[cfg(target_os = "linux")]
pub fn started_of(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after_name = &stat[stat.rfind(')')? + 2..];
    after_name.split_whitespace().nth(19)?.parse().ok()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn started_of(pid: u32) -> Option<u64> {
    let out = std::process::Command::new("ps").args(["-o", "etimes=", "-p", &pid.to_string()]).output().ok()?;
    let elapsed: u64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    Some(now.saturating_sub(elapsed))
}

/// Whether the run's own process is still there: the pid answers and started when the run says it did.
pub fn alive(process: &RunProcess) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    let answers = unsafe { libc::kill(process.pid as libc::pid_t, 0) } == 0;
    answers && started_of(process.pid).is_some_and(|started| started == process.started)
}

/// Sends `signal` to the process alone. Returns false, and sends nothing, when the pid is no longer the run's.
pub fn signal(process: &RunProcess, signal: libc::c_int) -> std::io::Result<bool> {
    if !alive(process) {
        return Ok(false);
    }
    deliver(process.pid as libc::pid_t, signal).map(|()| true)
}

/// Sends `signal` to the process group the run's process leads, when the process is still the run's.
pub fn signal_group(process: &RunProcess, signal: libc::c_int) -> std::io::Result<bool> {
    if !alive(process) {
        return Ok(false);
    }
    // The process was started with `setsid`, so its pid is its group's id.
    deliver(-(process.pid as libc::pid_t), signal).map(|()| true)
}

/// Kills the group `process` led, even when its leader is gone: a launcher that exited on SIGINT leaves its child in the
/// group. Only for a stop that found the leader alive and the run's own at its start, so the group id is still the run's.
pub fn kill_group(process: &RunProcess) -> std::io::Result<()> {
    match deliver(-(process.pid as libc::pid_t), libc::SIGKILL) {
        Err(e) if e.raw_os_error() == Some(libc::ESRCH) => Ok(()),
        other => other,
    }
}

fn deliver(target: libc::pid_t, signal: libc::c_int) -> std::io::Result<()> {
    #[cfg(test)]
    if let Some(result) = seam::intercept(target, signal) {
        return result;
    }
    // SAFETY: every caller derives the target from a process it checked to be the run's own.
    match unsafe { libc::kill(target, signal) } {
        0 => Ok(()),
        _ => Err(std::io::Error::last_os_error()),
    }
}

/// Lets a test see which signals were sent to a pid and make them fail.
#[cfg(test)]
pub mod seam {
    use std::collections::HashSet;
    use std::sync::Mutex;

    static SENT: Mutex<Vec<(libc::pid_t, libc::c_int)>> = Mutex::new(Vec::new());
    static FAILING: Mutex<Option<HashSet<libc::pid_t>>> = Mutex::new(None);

    pub(super) fn intercept(target: libc::pid_t, signal: libc::c_int) -> Option<std::io::Result<()>> {
        SENT.lock().unwrap().push((target, signal));
        let fails = signal != libc::SIGKILL && FAILING.lock().unwrap().as_ref().is_some_and(|set| set.contains(&target.abs()));
        fails.then(|| Err(std::io::Error::from_raw_os_error(libc::EPERM)))
    }

    /// Every signal that was aimed at `pid` or its group.
    pub fn sent_to(pid: u32) -> Vec<libc::c_int> {
        SENT.lock().unwrap().iter().filter(|(target, _)| target.unsigned_abs() == pid).map(|(_, signal)| *signal).collect()
    }

    /// Makes every signal but SIGKILL to `pid` fail, so a test can still end the process.
    pub fn fail_signals_to(pid: u32) {
        FAILING.lock().unwrap().get_or_insert_with(HashSet::new).insert(pid as libc::pid_t);
    }
}
