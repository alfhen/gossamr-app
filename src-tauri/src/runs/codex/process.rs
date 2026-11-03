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

#[cfg(not(target_os = "macos"))]
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
    send(process, process.pid as libc::pid_t, signal)
}

/// Sends `signal` to the process group the run's process leads, when the process is still the run's.
pub fn signal_group(process: &RunProcess, signal: libc::c_int) -> std::io::Result<bool> {
    // The process was started with `setsid`, so its pid is its group's id.
    send(process, -(process.pid as libc::pid_t), signal)
}

fn send(process: &RunProcess, target: libc::pid_t, signal: libc::c_int) -> std::io::Result<bool> {
    if !alive(process) {
        return Ok(false);
    }
    // SAFETY: the target was derived from a pid that was checked just above to be the run's own process.
    match unsafe { libc::kill(target, signal) } {
        0 => Ok(true),
        _ => Err(std::io::Error::last_os_error()),
    }
}
