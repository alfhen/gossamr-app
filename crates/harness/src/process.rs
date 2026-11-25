//! Finding a process again by its pid, and telling it from a later process that reused the number.

use serde::{Deserialize, Serialize};

/// A process the harness or the app started itself, and so has to find again by its pid.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Process {
    pub pid: u32,
    /// The process start time in seconds, to tell a reused pid from the original.
    pub started: u64,
}

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

/// Field 22 of `/proc/<pid>/stat`, in clock ticks since boot, plus the boot time in ticks, so a record kept across a
/// reboot never matches a process of the next boot. Unlike `etimes`, it does not move between calls. None for a
/// zombie, as macOS gives, so a process that has exited is never taken for a running one.
#[cfg(target_os = "linux")]
pub fn started_of(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let mut fields = stat[stat.rfind(')')? + 2..].split_whitespace();
    if fields.next()? == "Z" {
        return None;
    }
    let since_boot: u64 = fields.nth(18)?.parse().ok()?;
    Some(booted_ticks()? + since_boot)
}

/// When the machine booted, in clock ticks since the epoch: `btime` of `/proc/stat`, which is in seconds.
#[cfg(target_os = "linux")]
fn booted_ticks() -> Option<u64> {
    static BOOTED: std::sync::OnceLock<Option<u64>> = std::sync::OnceLock::new();
    *BOOTED.get_or_init(|| {
        let stat = std::fs::read_to_string("/proc/stat").ok()?;
        let btime: u64 = stat.lines().find_map(|line| line.strip_prefix("btime "))?.trim().parse().ok()?;
        // SAFETY: sysconf has no preconditions.
        let per_second = u64::try_from(unsafe { libc::sysconf(libc::_SC_CLK_TCK) }).ok().filter(|ticks| *ticks > 0)?;
        Some(btime * per_second)
    })
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn started_of(pid: u32) -> Option<u64> {
    let out = std::process::Command::new("ps").args(["-o", "etimes=", "-p", &pid.to_string()]).output().ok()?;
    let elapsed: u64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    Some(now.saturating_sub(elapsed))
}

/// Whether the run's own process is still there: the pid answers and started when the run says it did.
pub fn alive(process: &Process) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    let answers = unsafe { libc::kill(process.pid as libc::pid_t, 0) } == 0;
    answers && started_of(process.pid).is_some_and(|started| started == process.started)
}

/// Sends `signal` to the process alone. Returns false, and sends nothing, when the pid is no longer the run's.
pub fn signal(process: &Process, signal: libc::c_int) -> std::io::Result<bool> {
    if !alive(process) {
        return Ok(false);
    }
    deliver(process.pid as libc::pid_t, signal).map(|()| true)
}

/// Sends `signal` to the process group the run's process leads, when the process is still the run's.
pub fn signal_group(process: &Process, signal: libc::c_int) -> std::io::Result<bool> {
    if !alive(process) {
        return Ok(false);
    }
    // The process was started with `setsid`, so its pid is its group's id.
    deliver(-(process.pid as libc::pid_t), signal).map(|()| true)
}

/// What is left of the group a leader led, once the leader is gone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Left {
    /// Nothing that runs.
    Nothing,
    /// Members that run, each started at or after the leader, so the agent's own work: a background task or a command.
    Ours(Vec<Process>),
    /// A listing that proves nothing, or a member that started before the leader and so is not the agent's.
    Unknown,
}

/// What runs on in the group `leader` led, once it is gone. Its group is never signalled for this: the leader's pid may
/// lead another group by now.
pub fn left_of(leader: &Process) -> Left {
    let group = leader.pid as libc::pid_t;
    #[cfg(any(test, feature = "testing"))]
    let listing = seam::listing(group).unwrap_or_else(|| members_left(group));
    #[cfg(not(any(test, feature = "testing")))]
    let listing = members_left(group);
    let pids = match listing {
        Listing::Full => return Left::Unknown,
        Listing::Nothing => return Left::Nothing,
        Listing::Members(pids) => pids,
    };
    let mut ours = vec![];
    for pid in pids.into_iter().filter_map(|pid| u32::try_from(pid).ok()) {
        match started_of(pid) {
            // A zombie, or reaped since the listing.
            None => {}
            // The leader's pid is another process's: no pid is given out while it names a group that has members, so
            // the agent's group is gone and this one is another's.
            Some(started) if pid == leader.pid && started != leader.started => return Left::Nothing,
            Some(started) if started >= leader.started => ours.push(Process { pid, started }),
            Some(_) => return Left::Unknown,
        }
    }
    if ours.is_empty() { Left::Nothing } else { Left::Ours(ours) }
}

#[cfg(target_os = "macos")]
fn members_left(group: libc::pid_t) -> Listing {
    members_of(group)
}

/// Every process whose group, field 5 of `/proc/<pid>/stat`, is `group`.
#[cfg(target_os = "linux")]
fn members_left(group: libc::pid_t) -> Listing {
    let Ok(all) = std::fs::read_dir("/proc") else { return Listing::Full };
    let in_group = |pid: libc::pid_t| {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        stat[stat.rfind(')')? + 2..].split_whitespace().nth(2)?.parse::<libc::pid_t>().ok().filter(|of| *of == group)
    };
    let members: Vec<libc::pid_t> = all.flatten().filter_map(|entry| entry.file_name().to_str()?.parse().ok()).filter(|pid| in_group(*pid).is_some()).collect();
    if members.is_empty() { Listing::Nothing } else { Listing::Members(members) }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn members_left(_group: libc::pid_t) -> Listing {
    Listing::Full
}

/// Kills the group `process` led, even when its leader is gone: a launcher that exited on SIGINT leaves its child in the
/// group. Only for a stop that found the leader alive and the run's own at its start, so the group id is still the run's.
pub fn kill_group(process: &Process) -> std::io::Result<()> {
    let group = process.pid as libc::pid_t;
    match deliver(-group, libc::SIGKILL) {
        Err(e) if e.raw_os_error() == Some(libc::ESRCH) => Ok(()),
        Err(e) if e.raw_os_error() == Some(libc::EPERM) => after_a_refused_group_kill(group, e),
        other => other,
    }
}

/// macOS refuses a signal to a group with EPERM when every process left in it is a zombie, as a leader is between its
/// exit and the app reaping it. So a refused group kill is done when the group lists only zombies, and when a second
/// kill finds the group gone or kills what it holds. A listed member that is still running keeps the refusal, and a
/// listing that may be cut short proves nothing.
fn after_a_refused_group_kill(group: libc::pid_t, refused: std::io::Error) -> std::io::Result<()> {
    match group_members(group) {
        Listing::Full => Err(refused),
        Listing::Members(members) => {
            let states: Vec<Member> = members.iter().map(|pid| member(*pid)).collect();
            if states.contains(&Member::Running) {
                Err(refused)
            } else if states.iter().all(|m| *m == Member::Zombie) {
                Ok(())
            } else {
                // A member was reaped after the listing.
                kill_group_again(group, refused)
            }
        }
        // An empty group and a failed listing look the same.
        Listing::Nothing => kill_group_again(group, refused),
    }
}

/// Done when the group is gone or takes the kill. Refused again, it is listed again: a zombie that is still there
/// beside the member reaped meanwhile refuses every kill, so a group of zombies and reaped members, with a zombie
/// among them, is done. Otherwise the first refusal stands.
fn kill_group_again(group: libc::pid_t, refused: std::io::Error) -> std::io::Result<()> {
    match deliver(-group, libc::SIGKILL) {
        Err(e) if e.raw_os_error() == Some(libc::ESRCH) => Ok(()),
        Ok(()) => Ok(()),
        Err(_) => match group_members(group) {
            Listing::Members(members) => {
                let states: Vec<Member> = members.iter().map(|pid| member(*pid)).collect();
                let done = states.contains(&Member::Zombie) && !states.contains(&Member::Running);
                if done { Ok(()) } else { Err(refused) }
            }
            Listing::Nothing | Listing::Full => Err(refused),
        },
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Member {
    /// Exited and not reaped: it takes a signal sent to it alone, and has no start time any more, which is how `alive`
    /// reads it as gone.
    Zombie,
    /// No such process: reaped since it was listed.
    Gone,
    /// Anything else, including a process that refuses a signal.
    Running,
}

fn member(pid: libc::pid_t) -> Member {
    // SAFETY: signal 0 only checks that the process exists and may be signalled.
    match unsafe { libc::kill(pid, 0) } {
        0 if u32::try_from(pid).is_ok_and(|pid| started_of(pid).is_none()) => Member::Zombie,
        0 => Member::Running,
        _ if std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) => Member::Gone,
        _ => Member::Running,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Listing {
    Members(Vec<libc::pid_t>),
    /// The call listed nobody, or failed: libproc answers 0 for both.
    Nothing,
    /// As many as the buffer holds, so there may be more.
    Full,
}

/// The members of the group `group` leads, or what a test said they are.
fn group_members(group: libc::pid_t) -> Listing {
    #[cfg(any(test, feature = "testing"))]
    if let Some(listing) = seam::listing(group) {
        return listing;
    }
    members_of(group)
}

#[cfg(target_os = "macos")]
fn members_of(group: libc::pid_t) -> Listing {
    const MEMBERS_MAX: usize = 256;
    let mut members = [0 as libc::pid_t; MEMBERS_MAX];
    let size = std::mem::size_of_val(&members) as libc::c_int;
    // SAFETY: `members` is as large as `size` says, and the call fills at most that much.
    let count = unsafe { libc::proc_listpgrppids(group, members.as_mut_ptr().cast(), size) };
    match usize::try_from(count) {
        Ok(0) | Err(_) => Listing::Nothing,
        Ok(n) if n >= MEMBERS_MAX => Listing::Full,
        Ok(n) => Listing::Members(members[..n].to_vec()),
    }
}

/// Only macOS refuses a group of zombies, so elsewhere a refusal stands.
#[cfg(not(target_os = "macos"))]
fn members_of(_group: libc::pid_t) -> Listing {
    Listing::Full
}

fn deliver(target: libc::pid_t, signal: libc::c_int) -> std::io::Result<()> {
    #[cfg(any(test, feature = "testing"))]
    if let Some(result) = seam::intercept(target, signal) {
        return result;
    }
    // SAFETY: every caller derives the target from a process it checked to be the run's own.
    match unsafe { libc::kill(target, signal) } {
        0 => Ok(()),
        _ => Err(std::io::Error::last_os_error()),
    }
}

/// Lets a test see which signals were sent to a pid and make them fail. State is per thread: each test runs on its
/// own thread, and a pid freed by one test can be reused by another.
#[cfg(any(test, feature = "testing"))]
pub mod seam {
    use std::cell::RefCell;
    use std::collections::{HashMap, HashSet};

    use super::Listing;

    thread_local! {
        static SENT: RefCell<Vec<(libc::pid_t, libc::c_int)>> = const { RefCell::new(Vec::new()) };
        static FAILING: RefCell<HashSet<libc::pid_t>> = RefCell::new(HashSet::new());
        static REFUSED_GROUPS: RefCell<HashMap<libc::pid_t, usize>> = RefCell::new(HashMap::new());
        static LISTINGS: RefCell<Vec<(libc::pid_t, Listing)>> = const { RefCell::new(Vec::new()) };
        static SWALLOWED: RefCell<HashSet<libc::pid_t>> = RefCell::new(HashSet::new());
    }

    pub(super) fn intercept(target: libc::pid_t, signal: libc::c_int) -> Option<std::io::Result<()>> {
        SENT.with(|sent| sent.borrow_mut().push((target, signal)));
        let fails = signal != libc::SIGKILL && FAILING.with(|set| set.borrow().contains(&target.abs()));
        let refused = signal == libc::SIGKILL
            && target < 0
            && REFUSED_GROUPS.with(|left| left.borrow_mut().get_mut(&-target).is_some_and(|n| n.checked_sub(1).map(|rest| *n = rest).is_some()));
        if signal == libc::SIGKILL && target < 0 && SWALLOWED.with(|swallowed| swallowed.borrow().contains(&-target)) {
            return Some(Ok(()));
        }
        (fails || refused).then(|| Err(std::io::Error::from_raw_os_error(libc::EPERM)))
    }

    /// Makes every SIGKILL to the group `pid` leads succeed without reaching it, as a process stuck in the kernel goes
    /// only later.
    pub fn swallow_group_kills(pid: u32) {
        SWALLOWED.with(|swallowed| swallowed.borrow_mut().insert(pid as libc::pid_t));
    }

    pub(super) fn listing(group: libc::pid_t) -> Option<Listing> {
        LISTINGS.with(|all| all.borrow().iter().find(|(g, _)| *g == group).map(|(_, listing)| listing.clone()))
    }

    /// Makes the next `times` SIGKILLs to the group `pid` leads fail with EPERM, as macOS answers for a group of zombies.
    pub fn refuse_group_kills(pid: u32, times: usize) {
        REFUSED_GROUPS.with(|left| left.borrow_mut().insert(pid as libc::pid_t, times));
    }

    /// What listing the members of the group `pid` leads gives, in place of asking the system.
    pub fn list_group_as(pid: u32, listing: Listing) {
        LISTINGS.with(|all| all.borrow_mut().push((pid as libc::pid_t, listing)));
    }

    /// Every signal that was aimed at `pid` or its group.
    pub fn sent_to(pid: u32) -> Vec<libc::c_int> {
        SENT.with(|sent| sent.borrow().iter().filter(|(target, _)| target.unsigned_abs() == pid).map(|(_, signal)| *signal).collect())
    }

    /// Makes every signal but SIGKILL to `pid` fail, so a test can still end the process.
    pub fn fail_signals_to(pid: u32) {
        FAILING.with(|set| set.borrow_mut().insert(pid as libc::pid_t));
    }
}
