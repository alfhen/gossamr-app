//! Finding a process again by its pid, and telling it from a later process that reused the number.

use serde::{Deserialize, Serialize};

/// A process the harness or the app started itself, and so has to find again by its pid.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Process {
    pub pid: u32,
    /// The process start time, to tell a reused pid from the original: in seconds on macOS, in clock ticks since boot on
    /// Linux. It is compared only within one boot.
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

/// Field 22 of `/proc/<pid>/stat`, in clock ticks since boot, which no clock step moves: a record kept across a
/// reboot is told apart by `boot_id`. Unlike `etimes`, it does not move between calls. None for a zombie, as macOS
/// gives, so a process that has exited is never taken for a running one.
#[cfg(target_os = "linux")]
pub fn started_of(pid: u32) -> Option<u64> {
    let stat = std::fs::read(format!("/proc/{pid}/stat")).ok()?;
    let mut fields = stat_tail(&stat)?.split_whitespace();
    if fields.next()? == "Z" {
        return None;
    }
    fields.nth(18)?.parse().ok()
}

/// The fields of a `/proc/<pid>/stat` after the command name, which may hold any bytes, `)` and spaces among them.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn stat_tail(stat: &[u8]) -> Option<&str> {
    let named = stat.iter().rposition(|b| *b == b')')?;
    std::str::from_utf8(stat.get(named + 2..)?).ok()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn started_of(pid: u32) -> Option<u64> {
    let out = std::process::Command::new("ps").args(["-o", "etimes=", "-p", &pid.to_string()]).output().ok()?;
    let elapsed: u64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    Some(now.saturating_sub(elapsed))
}

/// When `pid` started, in whole seconds since the epoch, as a file's times are kept; none when there is no such
/// process.
#[cfg(target_os = "linux")]
pub fn started_at(pid: u32) -> Option<u64> {
    let ticks = started_of(pid)?;
    // SAFETY: sysconf only reads a limit.
    let hz = u64::try_from(unsafe { libc::sysconf(libc::_SC_CLK_TCK) }).ok().filter(|hz| *hz > 0)?;
    let stat = std::fs::read_to_string("/proc/stat").ok()?;
    let booted: u64 = stat.lines().find_map(|line| line.strip_prefix("btime "))?.trim().parse().ok()?;
    Some(booted + ticks / hz)
}

/// When `pid` started, in whole seconds since the epoch, as a file's times are kept; none when there is no such
/// process.
#[cfg(not(target_os = "linux"))]
pub fn started_at(pid: u32) -> Option<u64> {
    started_of(pid)
}

/// Whether the run's own process is still there: the pid answers and started when the run says it did.
pub fn alive(process: &Process) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    let answers = unsafe { libc::kill(process.pid as libc::pid_t, 0) } == 0;
    answers && started_of(process.pid).is_some_and(|started| started == process.started)
}

/// Whether `process` may still run: it is alive, or it answers that it may not be signalled, as another user's process
/// does (a command an agent ran with sudo). Such a process cannot be told from gone, so it is taken as running.
pub fn may_run(process: &Process) -> bool {
    alive(process) || refuses_signals(process.pid)
}

fn refuses_signals(pid: u32) -> bool {
    #[cfg(any(test, feature = "testing"))]
    if seam::refusing(pid) {
        return true;
    }
    // SAFETY: signal 0 only checks that the process exists and may be signalled.
    let answered = unsafe { libc::kill(pid as libc::pid_t, 0) };
    answered != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// This boot's id, which no clock step changes: `kern.bootsessionuuid`, or `/proc/sys/kernel/random/boot_id`.
pub fn boot_id() -> Option<String> {
    static BOOT: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    BOOT.get_or_init(read_boot_id).clone()
}

#[cfg(target_os = "macos")]
fn read_boot_id() -> Option<String> {
    let mut id = [0u8; 64];
    let mut size = id.len();
    // SAFETY: the name is a C string, and `id` is as large as `size` says.
    let got = unsafe { libc::sysctlbyname(c"kern.bootsessionuuid".as_ptr(), id.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0) };
    let id = std::str::from_utf8(id.get(..size)?).ok()?.trim_end_matches('\0').trim();
    (got == 0 && !id.is_empty()).then(|| id.to_owned())
}

#[cfg(target_os = "linux")]
fn read_boot_id() -> Option<String> {
    let id = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
    Some(id.trim().to_owned()).filter(|id| !id.is_empty())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn read_boot_id() -> Option<String> {
    None
}

/// Whether neither a process nor a process group answers to `pid`: nothing of what it led can run.
pub fn nothing_has(pid: u32) -> bool {
    no_process_at(pid) && unanswered(-(pid as libc::pid_t))
}

/// Whether no process, running or not yet reaped, has `pid`.
pub fn no_process_at(pid: u32) -> bool {
    let pid = pid as libc::pid_t;
    pid > 0 && unanswered(pid)
}

fn unanswered(target: libc::pid_t) -> bool {
    // SAFETY: signal 0 only checks that the target exists.
    let answered = unsafe { libc::kill(target, 0) };
    answered != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

/// The folder `pid` works in.
#[cfg(target_os = "macos")]
fn cwd_of(pid: u32) -> Option<std::path::PathBuf> {
    use std::os::unix::ffi::OsStringExt;
    let mut info = std::mem::MaybeUninit::<libc::proc_vnodepathinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    // SAFETY: `info` is as large as `size` says, and the call fills at most that much.
    let got = unsafe { libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDVNODEPATHINFO, 0, info.as_mut_ptr().cast(), size) };
    if got != size {
        return None;
    }
    // SAFETY: the call filled the whole struct.
    let info = unsafe { info.assume_init() };
    let path: Vec<u8> = info.pvi_cdir.vip_path.iter().flatten().map(|c| *c as u8).take_while(|b| *b != 0).collect();
    (!path.is_empty()).then(|| std::ffi::OsString::from_vec(path).into())
}

#[cfg(not(target_os = "macos"))]
fn cwd_of(pid: u32) -> Option<std::path::PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
}

/// A process other than `ours` that still holds a session: one whose arguments hold its provider id `id`, as
/// `claude --resume <id>` in Terminal does, or a provider's program working inside its `folder` but not inside `skip`, the
/// folders of other sessions there. A shell left in the folder is no holder. Only this user's processes are read; one
/// of `ours` counts as ours only while it is the same process, so a reused pid is a stranger. `markers` name the
/// providers' programs: a name matches the program's file name, and a path part (one with a `/`) any argument of an
/// interpreter, as a shim's `node <prefix>/@anthropic-ai/claude-code/cli.js` shows.
pub fn holding(id: &str, folder: &std::path::Path, markers: &[&str], ours: &[Process], skip: &[std::path::PathBuf]) -> Option<u32> {
    let (paths, programs): (Vec<&str>, Vec<&str>) = markers.iter().partition(|marker| marker.contains('/'));
    let real = |path: &std::path::Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_owned());
    let folder = real(folder);
    let skip: Vec<std::path::PathBuf> = skip.iter().map(|path| real(path)).collect();
    let me = std::process::id();
    let named = |path: &std::path::Path| path.file_name().and_then(|name| name.to_str()).is_some_and(|name| programs.contains(&name));
    let one_of_ours = |pid: u32| ours.iter().any(|agent| agent.pid == pid && started_of(pid) == Some(agent.started));
    // What an agent of ours started counts as ours too, as the `claude` a launcher runs as its child does.
    let is_ours = |pid: u32| std::iter::successors(Some(pid), |pid| parent_of(*pid).filter(|parent| *parent > 1)).take(32).any(one_of_ours);
    all_pids().into_iter().filter(|pid| *pid != me && !is_ours(*pid)).find(|pid| {
        let args = args_of(*pid).unwrap_or_default();
        // Anywhere in an argument: the script Terminal runs for a hand-over is named by the id too, so its shell holds
        // the session from before it starts `claude`.
        // An id too short to be told from an ordinary word names nothing; a provider's is a UUID.
        let by_id = id.len() >= ID_LEAST && args.iter().skip(1).any(|arg| holds_word(arg, id));
        // By the name it was started as too: an installed `claude` is a link to a file named by its version, and npm's
        // is a script `node` runs.
        let in_package = |path: &str| paths.iter().any(|part| path.contains(part));
        // The script as the system finds it too: a bin linked under another name to the package's `cli.js`.
        let resolved = || {
            let script = std::path::Path::new(interpreted(&args)?);
            let script = if script.is_absolute() { script.to_owned() } else { cwd_of(*pid)?.join(script) };
            std::fs::canonicalize(script).ok()
        };
        // The script it runs alone: an argument after it is the script's own.
        let packaged = interpreted(&args).is_some_and(in_package) || resolved().is_some_and(|path| in_package(&path.to_string_lossy()));
        let provider = args.first().is_some_and(|first| named(std::path::Path::new(first))) || program_of(*pid).is_some_and(|path| named(&path)) || interpreted(&args).is_some_and(|script| named(std::path::Path::new(script))) || packaged;
        by_id || provider && cwd_of(*pid).map(|cwd| real(&cwd)).is_some_and(|cwd| cwd.starts_with(&folder) && !skip.iter().any(|other| cwd.starts_with(other)))
    })
}

/// The script an interpreter runs: the first of its arguments that is no option (nor, for `env`, a variable), when
/// its first names an interpreter.
fn interpreted(args: &[String]) -> Option<&str> {
    let name = std::path::Path::new(args.first()?).file_name()?.to_str()?;
    let interpreter = matches!(name, "node" | "bun" | "deno" | "sh" | "bash" | "zsh" | "env") || name.to_ascii_lowercase().starts_with("python");
    if !interpreter {
        return None;
    }
    // The options that take the next argument as their value, which is not the script.
    let takes_value: &[&str] = match name {
        "node" | "bun" | "deno" => &["-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file", "-C", "--conditions", "--title", "--inspect-port"],
        "env" => &["-u", "--unset", "-S", "--split-string", "-C", "--chdir", "-P"],
        "sh" | "bash" | "zsh" => &["-o", "+o", "-O", "+O"],
        _ => &["-W", "-X"],
    };
    let mut rest = args.iter().skip(1).map(String::as_str);
    while let Some(arg) = rest.next() {
        if takes_value.contains(&arg) {
            rest.next();
        } else if !arg.starts_with('-') && !(name == "env" && arg.contains('=')) {
            return Some(arg);
        }
    }
    None
}

/// What `pid` was started as, by the name you would see in `ps`: its first argument's file name, else its program's.
pub fn program_name(pid: u32) -> Option<String> {
    let file_name = |path: &std::path::Path| path.file_name().and_then(|name| name.to_str()).map(str::to_owned);
    args_of(pid).and_then(|args| args.first().and_then(|first| file_name(std::path::Path::new(first)))).or_else(|| program_of(pid).and_then(|path| file_name(&path)))
}

/// Whether `pid`'s arguments name the session id `id`, as a word of their own.
pub fn names_id(pid: u32, id: &str) -> bool {
    id.len() >= ID_LEAST && args_of(pid).is_some_and(|args| args.iter().skip(1).any(|arg| holds_word(arg, id)))
}

/// Whether `pid`'s arguments may name the session id `id`: they do, or they can't be read, as for some milliseconds
/// while it becomes another program.
pub fn may_name_id(pid: u32, id: &str) -> bool {
    id.len() >= ID_LEAST && args_of(pid).is_none_or(|args| args.iter().skip(1).any(|arg| holds_word(arg, id)))
}

/// The shortest provider id the check looks for in other processes' arguments.
pub const ID_LEAST: usize = 16;

/// Whether `text` holds `word` with no letter or digit on either side, as a path or a `--resume=` names an id, and
/// not as a part of a longer word does.
fn holds_word(text: &str, word: &str) -> bool {
    !word.is_empty()
        && text.match_indices(word).any(|(at, _)| {
            let before = text[..at].chars().next_back();
            let after = text[at + word.len()..].chars().next();
            !before.is_some_and(|c| c.is_alphanumeric()) && !after.is_some_and(|c| c.is_alphanumeric())
        })
}

/// The parent of `pid`.
#[cfg(target_os = "macos")]
fn parent_of(pid: u32) -> Option<u32> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: `info` is as large as `size` says, and the call fills at most that much.
    let got = unsafe { libc::proc_pidinfo(libc::c_int::try_from(pid).ok()?, libc::PROC_PIDTBSDINFO, 0, info.as_mut_ptr().cast(), size) };
    if got != size {
        return None;
    }
    // SAFETY: the call filled the whole struct.
    Some(unsafe { info.assume_init() }.pbi_ppid)
}

/// Field 4 of `/proc/<pid>/stat`.
#[cfg(not(target_os = "macos"))]
fn parent_of(pid: u32) -> Option<u32> {
    let stat = std::fs::read(format!("/proc/{pid}/stat")).ok()?;
    stat_tail(&stat)?.split_whitespace().nth(1)?.parse().ok()
}

/// Every pid this user may see.
#[cfg(target_os = "macos")]
fn all_pids() -> Vec<u32> {
    // SAFETY: a null buffer asks only for the count.
    let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    let Ok(count) = usize::try_from(count) else { return Vec::new() };
    // Room for processes that start between the two calls.
    let mut pids = vec![0 as libc::pid_t; count + 64];
    let size = libc::c_int::try_from(std::mem::size_of_val(pids.as_slice())).unwrap_or(libc::c_int::MAX);
    // SAFETY: `pids` is as large as `size` says, and the call fills at most that much.
    let got = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), size) };
    pids.truncate(usize::try_from(got).unwrap_or(0));
    pids.into_iter().filter_map(|pid| u32::try_from(pid).ok()).filter(|pid| *pid > 0).collect()
}

#[cfg(not(target_os = "macos"))]
fn all_pids() -> Vec<u32> {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: getuid has no preconditions.
    let me = unsafe { libc::getuid() };
    let Ok(all) = std::fs::read_dir("/proc") else { return Vec::new() };
    all.flatten().filter(|entry| entry.metadata().is_ok_and(|meta| meta.uid() == me)).filter_map(|entry| entry.file_name().to_str()?.parse().ok()).collect()
}

/// The arguments `pid` was started with, its program's name first. Another user's process gives none.
#[cfg(target_os = "macos")]
fn args_of(pid: u32) -> Option<Vec<String>> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, libc::c_int::try_from(pid).ok()?];
    let mut size: libc::size_t = 0;
    // SAFETY: a null buffer asks only for the size.
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, std::ptr::null_mut(), &mut size, std::ptr::null_mut(), 0) } != 0 {
        return None;
    }
    let mut buffer = vec![0u8; size];
    // SAFETY: `buffer` is `size` bytes, and the call fills at most that much and says how much in `size`.
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, buffer.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0) } != 0 {
        return None;
    }
    buffer.truncate(size);
    // The argument count, the program's path, padding, then the arguments, each ended by a zero byte.
    let count = usize::try_from(i32::from_ne_bytes(buffer.get(..4)?.try_into().ok()?)).ok()?;
    let mut rest = buffer.get(4..)?.split(|b| *b == 0).skip(1).skip_while(|part| part.is_empty());
    Some((0..count).map_while(|_| rest.next()).map(|arg| String::from_utf8_lossy(arg).into_owned()).collect())
}

#[cfg(not(target_os = "macos"))]
fn args_of(pid: u32) -> Option<Vec<String>> {
    let line = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    Some(line.split(|b| *b == 0).filter(|arg| !arg.is_empty()).map(|arg| String::from_utf8_lossy(arg).into_owned()).collect())
}

/// The program `pid` runs.
#[cfg(target_os = "macos")]
fn program_of(pid: u32) -> Option<std::path::PathBuf> {
    use std::os::unix::ffi::OsStringExt;
    let mut path = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: `path` is as large as the size passed, and the call fills at most that much.
    let got = unsafe { libc::proc_pidpath(libc::c_int::try_from(pid).ok()?, path.as_mut_ptr().cast(), path.len() as u32) };
    let got = usize::try_from(got).ok().filter(|got| *got > 0)?;
    path.truncate(got);
    Some(std::ffi::OsString::from_vec(path).into())
}

#[cfg(not(target_os = "macos"))]
fn program_of(pid: u32) -> Option<std::path::PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/exe")).ok()
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
    /// Members that run, each started at or after the leader in a folder inside the agent's own, so plausibly its work:
    /// a background task or a command.
    Ours(Vec<Process>),
    /// A listing that proves nothing, or a member that may not be the agent's: one that started before the leader, works
    /// outside its folder, or cannot be read. The leader's pid can lead another group by now, such as a pipeline whose
    /// first command exited, and what this would kill is the person's own. With which of these it is.
    Unknown(&'static str),
}

/// What runs on in the group `leader` led, once it is gone, where the agent worked in `worktree`, a repository's
/// worktree; with none, any member that runs is Unknown. Its group is never signalled for this: the leader's pid may
/// lead another group by now.
pub fn left_of(leader: &Process, worktree: Option<&std::path::Path>) -> Left {
    let group = leader.pid as libc::pid_t;
    let within = worktree.and_then(|worktree| std::fs::canonicalize(worktree).ok());
    // A member can fork and exit between a listing and its check, its child unlisted: nothing is left only when a
    // listing is empty, or two in a row list the same processes and none of them runs.
    let mut before = None;
    for _ in 0..4 {
        #[cfg(any(test, feature = "testing"))]
        let listing = seam::listing(group).unwrap_or_else(|| members_left(group));
        #[cfg(not(any(test, feature = "testing")))]
        let listing = members_left(group);
        let mut pids = match listing {
            Listing::Full => return Left::Unknown("its process group could not be listed in full"),
            // A member the harness may not see, as `hidepid` hides another user's, keeps the group.
            Listing::Nothing if group_answers(group) => return Left::Unknown("its group still answers, but none of it can be listed"),
            Listing::Nothing => return Left::Nothing,
            Listing::Members(pids) => pids,
        };
        pids.sort_unstable();
        match members_check(leader, worktree.is_some(), within.as_deref(), &pids) {
            Some(left) => return left,
            // Only exited processes, twice: where a listing can hide a member, a group that still answers may hold one
            // that runs, so it is kept until they are reaped.
            None if before.as_ref() == Some(&pids) && listing_may_hide() && group_answers(group) => {
                return Left::Unknown("only exited processes of its group could be listed, and the group still answers")
            }
            None if before.as_ref() == Some(&pids) => return Left::Nothing,
            None => before = Some(pids),
        }
    }
    Left::Unknown("its group kept changing while it was listed")
}

/// Whether a listing of a group can miss a member that runs: `/proc` mounted with `hidepid`, which hides another user's
/// processes, or makes them unreadable.
fn listing_may_hide() -> bool {
    #[cfg(any(test, feature = "testing"))]
    if let Some(hides) = seam::hides() {
        return hides;
    }
    hidepid()
}

#[cfg(target_os = "linux")]
fn hidepid() -> bool {
    static HIDES: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *HIDES.get_or_init(|| {
        let Ok(mounts) = std::fs::read_to_string("/proc/self/mountinfo") else { return true };
        // `<id> <parent> <dev> <root> <mount point> <options> ... - <type> <source> <super options>`
        mounts.lines().filter(|line| line.split(' ').nth(4) == Some("/proc")).any(|line| {
            let options = line.rsplit(' ').next().unwrap_or_default();
            options.split(',').filter_map(|option| option.strip_prefix("hidepid=")).any(|value| value != "0" && value != "off")
        })
    })
}

#[cfg(not(target_os = "linux"))]
fn hidepid() -> bool {
    false
}

/// Whether the group answers to a signal 0: it has a member, maybe one the harness may not signal.
fn group_answers(group: libc::pid_t) -> bool {
    // SAFETY: signal 0 only checks that the group exists.
    let answered = unsafe { libc::kill(-group, 0) };
    answered == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// What one listing of the group shows, or None when none of it runs.
fn members_check(leader: &Process, has_worktree: bool, within: Option<&std::path::Path>, pids: &[libc::pid_t]) -> Option<Left> {
    let mut ours = vec![];
    for pid in pids.iter().filter_map(|pid| u32::try_from(*pid).ok()) {
        match started_of(pid) {
            None if refuses_signals(pid) => return Some(Left::Unknown("a process in its group may not be signalled by the harness")),
            // A zombie, or reaped since the listing.
            None => {}
            // The leader's pid is another process's: no pid is given out while it names a group that has members, so
            // the agent's group is gone and this one is another's.
            Some(started) if pid == leader.pid && started != leader.started => return Some(Left::Nothing),
            Some(started) if started >= leader.started && cwd_of(pid).zip(within).is_some_and(|(cwd, within)| cwd.starts_with(within)) => {
                ours.push(Process { pid, started })
            }
            Some(started) if started < leader.started => return Some(Left::Unknown("a process in its group started before the agent")),
            Some(_) if !has_worktree => return Some(Left::Unknown("its session names no repo, so no process in its group can be told for the agent's")),
            Some(_) => return Some(Left::Unknown("a process in its group works outside the session's worktree")),
        }
    }
    (!ours.is_empty()).then_some(Left::Ours(ours))
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
        let stat = std::fs::read(format!("/proc/{pid}/stat")).ok()?;
        stat_tail(&stat)?.split_whitespace().nth(2)?.parse::<libc::pid_t>().ok().filter(|of| *of == group)
    };
    let members: Vec<libc::pid_t> = all.flatten().filter_map(|entry| entry.file_name().to_str()?.parse().ok()).filter(|pid| in_group(*pid).is_some()).collect();
    if members.is_empty() { Listing::Nothing } else { Listing::Members(members) }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn members_left(_group: libc::pid_t) -> Listing {
    Listing::Full
}

/// Kills the group `process` led, if it led one, as a command an agent started in a group of its own does: what that
/// command started lives on in its group after it exits. While it runs, only when it is its group's leader; once it has
/// exited, only while no running process has its pid (it may be a zombie its parent has not reaped), since no pid is
/// given out again while it names a group that has members.
pub fn kill_led_group(process: &Process) {
    let pid = process.pid as libc::pid_t;
    let exited = started_of(process.pid).is_none() && !refuses_signals(process.pid);
    // SAFETY: getpgid only reads the process's group.
    let leads = if alive(process) { (unsafe { libc::getpgid(pid) }) == pid } else { exited };
    if leads {
        let _ = deliver(-pid, libc::SIGKILL);
    }
}

/// Every process `process` started, and theirs, each with its start time, while `process` is still the run's. Taken
/// before it goes: once it has, its children belong to the system and no longer lead back to it.
pub fn descendants(process: &Process) -> Vec<Process> {
    if !alive(process) {
        return vec![];
    }
    let (mut found, mut parents) = (vec![], vec![process.pid]);
    while let Some(parent) = parents.pop() {
        for pid in children_of(parent) {
            if let Some(started) = started_of(pid).filter(|_| found.iter().all(|seen: &Process| seen.pid != pid)) {
                found.push(Process { pid, started });
                parents.push(pid);
            }
        }
    }
    found
}

#[cfg(target_os = "macos")]
fn children_of(parent: u32) -> Vec<u32> {
    const MAX: usize = 1024;
    let mut pids = [0 as libc::pid_t; MAX];
    let size = std::mem::size_of_val(&pids) as libc::c_int;
    // SAFETY: `pids` is as large as `size` says, and the call fills at most that much.
    let count = unsafe { libc::proc_listchildpids(parent as libc::pid_t, pids.as_mut_ptr().cast(), size) };
    pids[..usize::try_from(count).unwrap_or(0).min(MAX)].iter().filter_map(|pid| u32::try_from(*pid).ok()).filter(|pid| *pid > 0).collect()
}

/// Every process whose parent, field 4 of `/proc/<pid>/stat`, is `parent`.
#[cfg(target_os = "linux")]
fn children_of(parent: u32) -> Vec<u32> {
    let Ok(all) = std::fs::read_dir("/proc") else { return vec![] };
    let parent_of = |pid: u32| {
        let stat = std::fs::read(format!("/proc/{pid}/stat")).ok()?;
        stat_tail(&stat)?.split_whitespace().nth(1)?.parse::<u32>().ok()
    };
    all.flatten().filter_map(|entry| entry.file_name().to_str()?.parse().ok()).filter(|pid| parent_of(*pid) == Some(parent)).collect()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn children_of(_parent: u32) -> Vec<u32> {
    vec![]
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
        static LISTINGS: RefCell<Vec<(libc::pid_t, Listing, bool)>> = const { RefCell::new(Vec::new()) };
        static SWALLOWED: RefCell<HashSet<libc::pid_t>> = RefCell::new(HashSet::new());
        static HIDES: RefCell<Option<bool>> = const { RefCell::new(None) };
        static REFUSING: RefCell<HashSet<libc::pid_t>> = RefCell::new(HashSet::new());
    }

    /// Makes `pid` answer as a process the harness may not signal, as another user's does, once it has gone too.
    pub fn refuse_signals_from(pid: u32) {
        REFUSING.with(|set| set.borrow_mut().insert(pid as libc::pid_t));
    }

    pub(super) fn refusing(pid: u32) -> bool {
        REFUSING.with(|set| set.borrow().contains(&(pid as libc::pid_t)))
    }

    /// Whether a group's listing may hide a member that runs, as with `hidepid`, in place of asking the system.
    pub fn listing_hides(hides: bool) {
        HIDES.with(|set| *set.borrow_mut() = Some(hides));
    }

    pub(super) fn hides() -> Option<bool> {
        HIDES.with(|set| *set.borrow())
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
        LISTINGS.with(|all| {
            let mut all = all.borrow_mut();
            let at = all.iter().position(|(g, _, _)| *g == group)?;
            Some(if all[at].2 { all.remove(at).1 } else { all[at].1.clone() })
        })
    }

    /// Makes the next `times` SIGKILLs to the group `pid` leads fail with EPERM, as macOS answers for a group of zombies.
    pub fn refuse_group_kills(pid: u32, times: usize) {
        REFUSED_GROUPS.with(|left| left.borrow_mut().insert(pid as libc::pid_t, times));
    }

    /// What listing the members of the group `pid` leads gives, in place of asking the system.
    pub fn list_group_as(pid: u32, listing: Listing) {
        LISTINGS.with(|all| all.borrow_mut().push((pid as libc::pid_t, listing, false)));
    }

    /// As `list_group_as`, for the next listing only: the ones after it ask the system.
    pub fn list_group_once_as(pid: u32, listing: Listing) {
        LISTINGS.with(|all| all.borrow_mut().push((pid as libc::pid_t, listing, true)));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_process_started_at_is_on_the_clock_a_files_times_are_kept_by() {
        let before = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        let mut child = std::process::Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let started = started_at(child.id());
        let after = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        let _ = child.kill();
        let _ = child.wait();
        // Whole seconds, and a boot time Linux keeps in whole seconds too.
        assert!(started.is_some_and(|started| started + 1 >= before && started <= after), "{started:?} not in {before}..={after}");
        assert_eq!(started_at(child.id()), None, "none once it has gone");
    }

    #[test]
    fn every_providers_session_id_is_long_enough_for_the_check_to_look_for_it() {
        for provider in crate::provider::Provider::ALL {
            assert!(provider.session_id_example().len() >= ID_LEAST, "{}: a shorter id turns the id match off", provider.name());
        }
    }

    #[test]
    fn an_id_is_held_only_as_a_word_of_its_own() {
        let id = "1b2c3d4e-0000-4000-8000-000000000001";
        assert!(holds_word(id, id));
        assert!(holds_word(&format!("--resume={id}"), id));
        assert!(holds_word(&format!("/data/attach/{id}-0123abcd.command"), id), "Terminal's script is named by it");
        assert!(holds_word("--enable-features=Pen,hand", "hand"));
        assert!(!holds_word("--enable-features=Handwriting,handwriting", "hand"), "part of a longer word");
        assert!(!holds_word(&format!("{id}9"), id));
    }

    #[test]
    fn the_script_an_interpreter_runs_is_its_first_word_that_is_no_option_nor_an_options_value() {
        let script = |args: &[&str]| interpreted(&args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>()).map(str::to_owned);
        assert_eq!(script(&["node", "/opt/bin/claude", "--continue"]).as_deref(), Some("/opt/bin/claude"));
        assert_eq!(script(&["node", "--require", "/tmp/preload.cjs", "/opt/bin/claude", "--continue"]).as_deref(), Some("/opt/bin/claude"), "the preload is no script");
        assert_eq!(script(&["/usr/bin/env", "-u", "NAME", "FOO=1", "claude"]).as_deref(), Some("claude"));
        assert_eq!(script(&["python3", "-W", "ignore", "/x/claude"]).as_deref(), Some("/x/claude"));
        assert_eq!(script(&["bash", "-o", "pipefail", "/x/claude"]).as_deref(), Some("/x/claude"));
        assert_eq!(script(&["/opt/bin/claude", "--continue"]), None, "no interpreter");
    }

    #[test]
    fn a_stat_line_is_read_past_a_command_name_of_any_bytes() {
        let stat = b"4242 (sl\xffe) p)  S 1 4242 4242 0 -1 4194560 100 0 0 0 0 0 0 0 20 0 1 0 98765 1000 100";
        let tail = stat_tail(stat).expect("read past the name");
        assert_eq!(tail.split_whitespace().nth(2), Some("4242"), "the group");
        assert_eq!(tail.split_whitespace().nth(19), Some("98765"), "the start");
    }
}
