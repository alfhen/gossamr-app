//! A harness that starts stops the agents a harness before it left running, by pid and start time.

mod common;

use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::*;
use harness::driver::{Capabilities, Driver, Launch, Link, OpenError};
use harness::event::Body;
use harness::process::{self, Listing, Process};
use harness::session::{Harness, Open};
use harness::store::Store;

/// A child the test started, killed and reaped when it is dropped still running, as when an assertion fails first.
struct Owned(Option<Child>);

impl Owned {
    fn take(mut self) -> Child {
        self.0.take().expect("owned")
    }
}

impl std::ops::Deref for Owned {
    type Target = Child;
    fn deref(&self) -> &Child {
        self.0.as_ref().expect("owned")
    }
}

impl std::ops::DerefMut for Owned {
    fn deref_mut(&mut self) -> &mut Child {
        self.0.as_mut().expect("owned")
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// A process in a group of its own, as an agent is started.
fn agent() -> (Owned, Process) {
    agent_in(Path::new("."))
}

/// As `agent`, working in `cwd`.
fn agent_in(cwd: &Path) -> (Owned, Process) {
    let child = Command::new("/bin/sleep").arg("60").current_dir(cwd).process_group(0).spawn().unwrap();
    let pid = child.id();
    (Owned(Some(child)), Process { pid, started: process::started_of(pid).expect("it runs") })
}

/// How `child` ended, within 10 s; a child still running then is killed, and None says so. Waited for here alone, so
/// no other thread can reap it and free its pid before the kill.
fn ended(child: Owned) -> Option<i32> {
    let mut child = child.take();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status.signal();
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Until the start whose events `events` gives closes, within 10 s; an error or silence fails.
async fn closed(events: &mut tokio::sync::broadcast::Receiver<harness::event::Event>) {
    let waited = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match events.recv().await {
                Ok(event) if matches!(event.body, Body::Closed { .. }) => return Ok(()),
                Ok(_) => {}
                Err(e) => return Err(e),
            }
        }
    })
    .await;
    assert!(matches!(waited, Ok(Ok(()))), "closed within 10 s: {waited:?}");
}

fn running(child: &mut Child) -> bool {
    child.try_wait().unwrap().is_none()
}

/// The store in `dir`, once its lock is free: a child another test forks holds a copy of it until it execs, as
/// `common::reopen` says.
fn opened(dir: &Path) -> Store {
    for _ in 0..200 {
        match Store::open(dir) {
            Err(harness::error::Error::InUse(_)) => std::thread::sleep(Duration::from_millis(10)),
            opened => return opened.unwrap(),
        }
    }
    panic!("the store stayed locked");
}

/// A store with session `s`, given up on by a shutdown, whose agent is `agent`.
fn left_by_a_shutdown(dir: &Path, agent: Option<&Process>) {
    left_in(dir, agent, Path::new("/a"));
}

/// As `left_by_a_shutdown`, for an agent that worked in `worktree`, a repo's.
fn left_in(dir: &Path, agent: Option<&Process>, worktree: &Path) {
    left_in_folder(dir, agent, worktree);
    sql(dir, "UPDATE sessions SET repo = 'acme/webshop' WHERE id = 's'");
}

/// As `left_by_a_shutdown`, for a session opened in `folder`, which names no repo. Its agent was in a turn.
fn left_in_folder(dir: &Path, agent: Option<&Process>, folder: &Path) {
    let store = opened(dir);
    store.create_session("s", "mock", false, folder, None).unwrap();
    store.append("s", &harness::event::Body::TurnStarted, harness::store::now_ms()).unwrap();
    store.set_agent("s", agent).unwrap();
    store.set_given_up("s", "a shutdown stopped waiting for it").unwrap();
}

/// Changes the store's file as only a test may.
fn sql(dir: &Path, statement: &str) {
    rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap().execute_batch(statement).unwrap();
}

/// Read from the file, as the harness that holds the store runs on.
fn is_given_up(dir: &Path) -> bool {
    let raw = rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap();
    raw.query_row("SELECT given_up FROM sessions WHERE id = 's'", [], |row| row.get(0)).unwrap()
}

fn started_harness(dir: &Path) -> Harness {
    Harness::new(opened(dir), vec![], settings(4))
}

/// Session `s`'s events, read once the harness is gone.
fn said(dir: &Path) -> Vec<harness::event::Body> {
    opened(dir).events("s", 0).unwrap().into_iter().map(|event| event.body).collect()
}

/// What a start that its next harness ended says last: a `failed` that says how, and a `closed` by the harness.
fn ended_by_the_next_harness(said: &[harness::event::Body], how: &str) -> bool {
    use harness::event::{Body, ClosedBy, FailKind};
    matches!(said, [.., Body::Failed { kind: FailKind::AgentStopped, reason }, Body::Closed { by: ClosedBy::HarnessWent }] if reason.contains(how))
}

fn row(harness: Harness, dir: &Path) -> (bool, Vec<(String, Process)>) {
    drop(harness);
    let store = opened(dir);
    (store.session("s").unwrap().given_up.is_some(), store.agents().unwrap())
}

#[test]
fn leftover_a_new_harness_stops_an_agent_on_record_and_its_session_may_be_resumed() {
    let (_tmp, dir) = data_dir();
    let (child, agent) = agent();
    left_by_a_shutdown(&dir, Some(&agent));
    let harness = started_harness(&dir);
    assert_eq!(ended(child), Some(libc::SIGKILL), "the leftover was killed, by its group");
    assert_eq!(row(harness, &dir), (false, vec![]), "no agent on record, and the session is no longer given up on");
    assert!(ended_by_the_next_harness(&said(&dir), "stopped it"), "its start ends in its events: {:?}", said(&dir));
}

#[test]
fn leftover_a_start_that_already_closed_gets_no_second_end() {
    let (_tmp, dir) = data_dir();
    let (child, agent) = agent();
    left_by_a_shutdown(&dir, Some(&agent));
    let closed = harness::event::Body::Closed { by: harness::event::ClosedBy::Shutdown };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    opened(&dir).append("s", &closed, now).unwrap();
    let harness = started_harness(&dir);
    assert_eq!(ended(child), Some(libc::SIGKILL));
    drop(harness);
    assert_eq!(said(&dir), [harness::event::Body::TurnStarted, closed], "the shutdown's closed stays the last word");
}

#[test]
fn leftover_a_pid_that_another_process_took_is_never_signalled() {
    let (_tmp, dir) = data_dir();
    let (mut child, agent) = agent();
    let other = Process { started: agent.started + 1, ..agent.clone() };
    left_by_a_shutdown(&dir, Some(&other));
    let harness = started_harness(&dir);
    assert!(running(&mut child), "the process that has the pid now runs on");
    assert_eq!(process::seam::sent_to(agent.pid), Vec::<i32>::new(), "no signal was sent to it or its group");
    assert_eq!(row(harness, &dir), (false, vec![]), "the agent on record is gone, since its pid is another's");
    assert!(ended_by_the_next_harness(&said(&dir), "was gone too"), "{:?}", said(&dir));
    // Ended by the test's own SIGTERM: a SIGKILL the harness sent past the seam would have come first.
    // SAFETY: our own child, not yet reaped.
    unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) };
    assert_eq!(ended(child), Some(libc::SIGTERM), "nothing else ended it");
}

#[tokio::test]
async fn leftover_given_up_with_no_agent_on_record_stays_given_up_and_says_there_is_no_way_back() {
    let (_tmp, dir) = data_dir();
    left_by_a_shutdown(&dir, None);
    let harness = started_harness(&dir);
    let refused = harness.resume("s").await.err().map(|e| e.to_string()).unwrap_or_default();
    assert!(refused.contains("no record of its process to check, so it is never resumed: open a new session for its work"), "{refused}");
    assert_eq!(row(harness, &dir), (true, vec![]), "nothing says its agent is gone");
}

#[test]
fn leftover_an_agent_whose_kill_is_refused_stays_on_record_and_given_up() {
    let (_tmp, dir) = data_dir();
    let (mut child, agent) = agent();
    left_by_a_shutdown(&dir, Some(&agent));
    // A refused group kill whose listing proves nothing stands (`process.rs`).
    process::seam::refuse_group_kills(agent.pid, 1);
    process::seam::list_group_as(agent.pid, Listing::Full);
    let harness = started_harness(&dir);
    assert!(running(&mut child));
    assert_eq!(row(harness, &dir), (true, vec![("s".to_owned(), agent)]), "still on record, and no resume may start beside it");
    child.kill().unwrap();
    child.wait().unwrap();
}

/// A store with session `s`, left by a harness that crashed: not given up on, its agent on record.
fn left_by_a_crash(dir: &Path, agent: &Process) {
    let store = opened(dir);
    store.create_session("s", "mock", false, Path::new("/a"), None).unwrap();
    store.set_agent("s", Some(agent)).unwrap();
}

#[tokio::test]
async fn leftover_no_resume_while_a_leftover_that_was_sent_its_kill_may_still_run() {
    // The rule, from the leftover stop's side: a kill sent is not an agent gone.
    let (_tmp, dir) = data_dir();
    let (mut child, agent) = agent();
    left_by_a_crash(&dir, &agent);
    process::seam::swallow_group_kills(agent.pid);
    let harness = started_harness(&dir);
    assert!(running(&mut child), "the kill did not reach it");
    let refused = harness.resume("s").await.err().map(|e| e.to_string()).unwrap_or_default();
    assert!(refused.contains("may still run"), "no resume beside it: {refused}");
    assert_eq!(row(harness, &dir), (true, vec![("s".to_owned(), agent)]), "still on record, and given up on");
    child.kill().unwrap();
    child.wait().unwrap();
}

#[tokio::test]
async fn leftover_no_resume_while_the_leftovers_could_not_be_listed_and_a_client_sees_why() {
    let (_tmp, dir) = data_dir();
    let (child, agent) = agent();
    left_by_a_crash(&dir, &agent);
    // A record the store cannot read back as a process.
    let raw = rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap();
    raw.execute("UPDATE sessions SET agent_pid = -1 WHERE id = 's'", []).unwrap();
    let harness = started_harness(&dir);
    let given_up: bool = raw.query_row("SELECT given_up FROM sessions WHERE id = 's'", [], |row| row.get(0)).unwrap();
    assert!(given_up, "a session whose record could not be read is given up on");
    let held = harness.sessions().unwrap().into_iter().map(|session| session.held).collect::<Vec<_>>();
    assert!(matches!(&held[..], [Some(why)] if why.contains("could not check")), "{held:?}");
    for refused in [harness.resume("s").await.err(), harness.take_back("s").await.err()] {
        let refused = refused.map(|e| e.to_string()).unwrap_or_default();
        assert!(refused.contains("could not check for agents an earlier harness left running"), "{refused}");
    }
    // Once the store reads again, the next resume checks, stops the leftover and goes on to its own reasons.
    raw.execute("UPDATE sessions SET agent_pid = ?1 WHERE id = 's'", [agent.pid]).unwrap();
    let refused = harness.resume("s").await.err().map(|e| e.to_string()).unwrap_or_default();
    assert!(!refused.contains("could not check"), "{refused}");
    assert_eq!(harness.sessions().unwrap()[0].held, None);
    assert_eq!(ended(child), Some(libc::SIGKILL), "the leftover was stopped by that check");
    // That retry did not wait for its kill, so the session was given up on; the next resume finds the agent gone.
    let refused = harness.resume("s").await.err().map(|e| e.to_string()).unwrap_or_default();
    assert!(!refused.contains("may still run"), "{refused}");
    assert!(!is_given_up(&dir), "freed");
}

/// A worktree folder beside the data folder.
fn worktree(dir: &Path) -> PathBuf {
    let worktree = dir.with_file_name("worktree");
    std::fs::create_dir_all(&worktree).unwrap();
    worktree
}

/// What a gone leader left running: a `cat` that reads a pipe this test holds, so it ends when the test lets go of the
/// pipe, or ends, and is never signalled by a pid that may have been reused.
struct Work {
    process: Process,
    hold: Arc<Mutex<Option<std::io::PipeWriter>>>,
}

impl std::ops::Deref for Work {
    type Target = Process;
    fn deref(&self) -> &Process {
        &self.process
    }
}

/// The reviewer's probe: a leader in a group of its own starts work in the background and exits, reaped. Its record,
/// taken while it ran, and the work, which keeps the group. Both work in `cwd`.
fn a_leader_gone_with_its_work_left(cwd: &Path) -> (Process, Work) {
    let (leader, mut work) = a_leader_gone_leaving(cwd, 1);
    (leader, work.remove(0))
}

/// As `a_leader_gone_with_its_work_left`, with `count` processes left, which all end once the pipe is let go of.
fn a_leader_gone_leaving(cwd: &Path, count: usize) -> (Process, Vec<Work>) {
    let (held, hold) = std::io::pipe().unwrap();
    let held = std::os::fd::OwnedFd::from(held);
    let at = std::os::fd::AsRawFd::as_raw_fd(&held);
    let mut leader = Command::new("/bin/sh");
    leader
        .args(["-c", &format!("{} read go", "cat <&3 >/dev/null & echo $!;".repeat(count))])
        .current_dir(cwd)
        .process_group(0)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped());
    // SAFETY: dup2 and fcntl are async-signal-safe; the pipe's end is open in this process until the spawn returns.
    // When the end already is fd 3, dup2 leaves it close-on-exec, so the flag is cleared instead.
    unsafe {
        leader.pre_exec(move || {
            let kept = if at == 3 { libc::fcntl(3, libc::F_SETFD, 0) } else { libc::dup2(at, 3) - 3 };
            if kept == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
        });
    }
    let mut leader = leader.spawn().unwrap();
    drop(held);
    let record = Process { pid: leader.id(), started: process::started_of(leader.id()).expect("it runs") };
    let mut said = std::io::BufRead::lines(std::io::BufReader::new(leader.stdout.take().unwrap()));
    let hold = Arc::new(Mutex::new(Some(hold)));
    let work = (0..count)
        .map(|_| {
            let pid: u32 = said.next().unwrap().unwrap().trim().parse().unwrap();
            Work { process: Process { pid, started: process::started_of(pid).expect("the work runs") }, hold: hold.clone() }
        })
        .collect();
    drop(leader.stdin.take());
    leader.wait().unwrap();
    (record, work)
}

/// Ends what a gone leader left, by letting go of the pipe it reads, and waits until it has gone.
fn kill(work: &Work) {
    work.hold.lock().unwrap().take();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while process::may_run(work) {
        assert!(std::time::Instant::now() < deadline, "the work ended within 10 s");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn leftover_whose_leader_is_gone_has_what_it_left_in_its_group_stopped_before_its_session_is_freed() {
    let (_tmp, dir) = data_dir();
    let worktree = worktree(&dir);
    let (leader, work) = a_leader_gone_with_its_work_left(&worktree);
    left_in(&dir, Some(&leader), &worktree);
    let harness = started_harness(&dir);
    assert!(!process::alive(&work), "the work its group kept was killed");
    assert_eq!(row(harness, &dir), (false, vec![]), "and only then is the session free");
    assert!(ended_by_the_next_harness(&said(&dir), "stopped it"), "{:?}", said(&dir));
}

#[test]
fn leftover_whose_leader_is_gone_and_whose_group_holds_one_older_than_it_stays_given_up_and_nothing_is_signalled() {
    let (_tmp, dir) = data_dir();
    // In the worktree, so its age alone keeps it.
    let worktree = worktree(&dir);
    let (mut older, older_record) = agent_in(&worktree);
    let mut gone = Command::new("/usr/bin/true").process_group(0).spawn().unwrap();
    let leader = Process { pid: gone.id(), started: older_record.started + 1 };
    gone.wait().unwrap();
    left_in(&dir, Some(&leader), &worktree);
    // Its group, as listed, holds a process that started before the leader did, so not the agent's work.
    process::seam::list_group_as(leader.pid, Listing::Members(vec![older_record.pid as libc::pid_t]));
    let harness = started_harness(&dir);
    assert!(running(&mut older), "one older than the leader is never taken for the agent's");
    assert_eq!(process::seam::sent_to(older_record.pid), Vec::<i32>::new());
    assert_eq!(process::seam::sent_to(leader.pid), Vec::<i32>::new());
    assert_eq!(row(harness, &dir), (true, vec![("s".to_owned(), leader)]), "kept on record, and given up on");
    older.kill().unwrap();
    older.wait().unwrap();
}

#[test]
fn leftover_whose_leader_is_gone_and_whose_group_cannot_be_read_stays_given_up_and_nothing_is_signalled() {
    let (_tmp, dir) = data_dir();
    let worktree = worktree(&dir);
    let (leader, work) = a_leader_gone_with_its_work_left(&worktree);
    left_in(&dir, Some(&leader), &worktree);
    process::seam::list_group_as(leader.pid, Listing::Full);
    let harness = started_harness(&dir);
    assert!(process::alive(&work), "a listing that proves nothing signals nothing");
    assert_eq!(process::seam::sent_to(leader.pid), Vec::<i32>::new());
    assert_eq!(row(harness, &dir), (true, vec![("s".to_owned(), leader)]), "kept on record, and given up on");
    kill(&work);
}

#[test]
fn leftover_whose_leader_is_gone_and_whose_group_works_outside_its_worktree_stays_given_up_and_nothing_is_signalled() {
    // The leader's pid may lead another group by now, such as a pipeline whose first command exited: what runs in it
    // outside the agent's worktree is taken for the person's own.
    let (_tmp, dir) = data_dir();
    let elsewhere = dir.with_file_name("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let (leader, work) = a_leader_gone_with_its_work_left(&elsewhere);
    left_in(&dir, Some(&leader), &worktree(&dir));
    let harness = started_harness(&dir);
    assert!(process::alive(&work), "not plausibly the agent's, so not killed");
    assert_eq!(process::seam::sent_to(work.pid), Vec::<i32>::new());
    assert_eq!(row(harness, &dir), (true, vec![("s".to_owned(), leader)]), "kept on record, and given up on");
    kill(&work);
}

#[test]
fn leftover_recorded_in_another_boot_is_gone_with_its_group_and_nothing_is_signalled() {
    // Whatever runs in a group of that id now is another's, even in the worktree, and even a process whose pid and start
    // match: on Linux the start counts from the boot.
    let (_tmp, dir) = data_dir();
    let worktree = worktree(&dir);
    let (leader, work) = a_leader_gone_with_its_work_left(&worktree);
    let (mut child, live) = agent();
    for (record, member) in [(&leader, &work.process), (&live, &live)] {
        left_in(&dir, Some(record), &worktree);
        sql(&dir, "UPDATE sessions SET agent_boot = 'another boot' WHERE id = 's'");
        let harness = started_harness(&dir);
        assert!(process::alive(member), "a group cannot outlive a reboot, so nothing is killed");
        assert_eq!(process::seam::sent_to(record.pid), Vec::<i32>::new());
        assert_eq!(row(harness, &dir), (false, vec![]), "and its session is free");
        assert!(ended_by_the_next_harness(&said(&dir), "gone too"), "{:?}", said(&dir));
        sql(&dir, "DELETE FROM events; DELETE FROM sessions");
    }
    kill(&work);
    child.kill().unwrap();
    child.wait().unwrap();
}

#[tokio::test]
async fn leftover_recorded_with_no_boot_is_kept_and_never_signalled_until_nothing_answers_to_its_pid() {
    // A record from before the store kept the boot: its start time proves nothing.
    let (_tmp, dir) = data_dir();
    let (mut child, agent) = agent();
    left_in(&dir, Some(&agent), &worktree(&dir));
    sql(&dir, "UPDATE sessions SET agent_boot = NULL WHERE id = 's'");
    let harness = started_harness(&dir);
    assert!(running(&mut child), "kept, never killed");
    assert_eq!(process::seam::sent_to(agent.pid), Vec::<i32>::new());
    assert!(is_given_up(&dir));
    // Its pid may be another process's: never named for the person to end.
    let refused = harness.resume("s").await.err().map(|e| e.to_string()).unwrap_or_default();
    assert!(refused.contains("a process in session s's group may still run (it was recorded with no boot") && !refused.contains(&agent.pid.to_string()), "{refused}");
    child.kill().unwrap();
    child.wait().unwrap();
    let refused = harness.clean_up("s").await.err().map(|e| e.to_string()).unwrap_or_default();
    assert!(!refused.contains("may still run"), "once nothing has its pid, it is gone: {refused}");
    assert_eq!(row(harness, &dir), (false, vec![]));
}

#[test]
fn leftover_of_a_session_with_no_repo_is_kept_whatever_folder_its_group_works_in() {
    // Opened in a folder, the folder can be everything: `~` or `/`.
    let (_tmp, dir) = data_dir();
    let worktree = worktree(&dir);
    let (leader, work) = a_leader_gone_with_its_work_left(&worktree);
    left_in_folder(&dir, Some(&leader), &worktree);
    let harness = started_harness(&dir);
    assert!(process::alive(&work), "not killed");
    assert_eq!(process::seam::sent_to(work.pid), Vec::<i32>::new());
    assert_eq!(row(harness, &dir), (true, vec![("s".to_owned(), leader)]), "kept on record, and given up on");
    kill(&work);
}

#[tokio::test]
async fn leftover_kept_is_checked_again_on_a_resume_and_freed_once_what_held_it_is_gone() {
    // The reviewer's first probe: a member outside the worktree keeps it, until the person ends that member.
    let (_tmp, dir) = data_dir();
    let elsewhere = dir.with_file_name("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let (leader, work) = a_leader_gone_with_its_work_left(&elsewhere);
    left_in(&dir, Some(&leader), &worktree(&dir));
    let harness = started_harness(&dir);
    // What holds it and what to do, on its row and in each refusal; no shutdown is named, as none happened.
    // Its leader is gone and no process has its pid, so the group is still the agent's: named by its id.
    let holds = format!("a process in session s's process group {} may still run (a process in its group works outside the session's worktree)", leader.pid);
    let listed = harness.sessions().unwrap()[0].given_up.clone().unwrap_or_default();
    assert!(listed.contains(&holds) && listed.ends_with("so it is not resumed: once it has ended, try again, or restart the harness, in Settings > Harness, to check again"), "{listed}");
    for refused in [harness.resume("s").await.err(), harness.take_back("s").await.err(), harness.clean_up("s").await.err()] {
        let refused = refused.map(|e| e.to_string()).unwrap_or_default();
        assert!(refused.contains(&holds) && refused.ends_with("in Settings > Harness, to check again"), "{refused}");
    }
    assert!(process::alive(&work), "checked again, still not the harness's to kill");
    kill(&work);
    while process::may_run(&work) {
        tokio::task::yield_now().await;
    }
    let refused = harness.resume("s").await.err().map(|e| e.to_string()).unwrap_or_default();
    assert!(!refused.contains("may still run"), "freed in this harness: {refused}");
    assert_eq!(harness.sessions().unwrap()[0].given_up, None);
    assert_eq!(row(harness, &dir), (false, vec![]));
}

#[cfg(target_os = "linux")]
#[test]
fn a_start_time_on_linux_counts_from_the_boot_so_no_clock_step_moves_it() {
    let uptime: f64 = std::fs::read_to_string("/proc/uptime").unwrap().split_whitespace().next().unwrap().parse().unwrap();
    // SAFETY: sysconf has no preconditions.
    let per_second = unsafe { libc::sysconf(libc::_SC_CLK_TCK) } as f64;
    let started = process::started_of(std::process::id()).unwrap() as f64;
    assert!(started <= (uptime + 1.0) * per_second, "{started} ticks, {uptime} s since boot");
}

#[test]
fn leftover_whose_group_gains_a_member_after_its_listing_has_that_one_stopped_too() {
    let (_tmp, dir) = data_dir();
    let worktree = worktree(&dir);
    let (leader, work) = a_leader_gone_leaving(&worktree, 2);
    left_in(&dir, Some(&leader), &worktree);
    // The first listing holds one of them, as when the other forks just after it.
    process::seam::list_group_once_as(leader.pid, Listing::Members(vec![work[0].pid as libc::pid_t]));
    let harness = started_harness(&dir);
    assert!(work.iter().all(|member| !process::alive(member)), "the one the second listing found was killed too");
    assert_eq!(row(harness, &dir), (false, vec![]));
}

#[test]
fn leftover_whose_group_holds_a_process_it_may_not_signal_stays_given_up() {
    // Pid 1 is another user's to anyone but root: a command an agent ran with sudo is the same, running and unreadable.
    // SAFETY: geteuid has no preconditions.
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let (_tmp, dir) = data_dir();
    let worktree = worktree(&dir);
    let (leader, work) = a_leader_gone_with_its_work_left(&worktree);
    kill(&work);
    left_in(&dir, Some(&leader), &worktree);
    process::seam::list_group_as(leader.pid, Listing::Members(vec![1]));
    let harness = started_harness(&dir);
    assert!(process::may_run(&Process { pid: 1, started: 0 }), "a process that refuses signals may run");
    assert_eq!(row(harness, &dir), (true, vec![("s".to_owned(), leader)]), "kept on record, and given up on");
}

#[test]
fn leftover_stops_share_one_deadline_however_many_will_not_go() {
    // Kills that never land: with one deadline for all, three take about as long as one.
    let waited = |count: usize| {
        let (_tmp, dir) = data_dir();
        let store = opened(&dir);
        let agents: Vec<(Owned, Process)> = (0..count).map(|_| agent()).collect();
        for (n, (_, agent)) in agents.iter().enumerate() {
            store.create_session(&format!("s{n}"), "mock", false, Path::new("/a"), None).unwrap();
            store.set_agent(&format!("s{n}"), Some(agent)).unwrap();
            process::seam::swallow_group_kills(agent.pid);
        }
        let begun = std::time::Instant::now();
        let harness = Harness::new(store, vec![], settings(4));
        let waited = begun.elapsed();
        drop(harness);
        for (mut child, _) in agents {
            child.kill().unwrap();
            child.wait().unwrap();
        }
        waited
    };
    let (one, three) = (waited(1), waited(3));
    assert!(three < one * 2, "three waited {three:?}, one {one:?}");
}

/// An agent that is a `sleep` in a group of its own, and goes when it is stopped.
#[derive(Default, Clone)]
struct Sleeper {
    children: Arc<Mutex<Vec<Child>>>,
}

impl Driver for Sleeper {
    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }

    fn open(&self, _launch: Launch) -> Result<Link, OpenError> {
        let (child, agent) = agent();
        let pid = child.id();
        self.children.lock().unwrap().push(child.take());
        let (commands, mut commands_rx) = tokio::sync::mpsc::unbounded_channel();
        let (output, receiver) = tokio::sync::mpsc::unbounded_channel();
        let _ = output.send(Body::Started { provider_session: format!("sleeper-{pid}"), resumed: false });
        tokio::spawn(async move {
            let _ = commands_rx.recv().await;
            // SAFETY: the sleep this driver started, not reaped until the test's end.
            unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
            drop(output);
        });
        Ok(Link { commands, output: receiver, process: Some(agent) })
    }
}

#[tokio::test]
async fn leftover_retried_after_a_record_could_not_be_read_never_touches_an_agent_this_harness_started() {
    let (_tmp, dir) = data_dir();
    let (old_child, old) = agent();
    left_by_a_crash(&dir, &old);
    let raw = rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap();
    raw.execute("UPDATE sessions SET agent_pid = -1 WHERE id = 's'", []).unwrap();
    let sleeper = Sleeper::default();
    let harness = Harness::new(opened(&dir), vec![("sleeper".into(), Arc::new(sleeper.clone()))], settings(4));
    assert!(harness.sessions().unwrap()[0].held.is_some(), "held");
    let (id, mut events) = harness.open(Open { provider: "sleeper".into(), cwd: "/nowhere".into(), ..Open::default() }).await.unwrap();
    events.recv().await.unwrap();
    raw.execute("UPDATE sessions SET agent_pid = ?1 WHERE id = 's'", [old.pid]).unwrap();
    let _ = harness.resume("s").await;
    assert_eq!(ended(old_child), Some(libc::SIGKILL), "the leftover was stopped by that retry");
    let running = sleeper.children.lock().unwrap()[0].try_wait().unwrap().is_none();
    assert!(running, "the agent this harness started runs on");
    let closes = |harness: &Harness| harness.events(&id, 0).unwrap().into_iter().filter(|event| matches!(event.body, Body::Closed { .. })).count();
    assert_eq!(closes(&harness), 0, "its start is not ended for it");
    harness.close(&id).unwrap();
    closed(&mut events).await;
    assert_eq!(closes(&harness), 1, "one closed for its start");
    for mut child in sleeper.children.lock().unwrap().drain(..) {
        let _ = child.kill();
        child.wait().unwrap();
    }
}

#[tokio::test]
async fn leftover_retried_after_the_records_could_not_be_listed_never_touches_an_agent_this_harness_started() {
    let (_tmp, dir) = data_dir();
    let (old_child, old) = agent();
    left_by_a_crash(&dir, &old);
    // An id the store cannot read back as text, so not even which sessions have a record can be listed.
    let raw = rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap();
    raw.execute("UPDATE sessions SET id = CAST(id AS BLOB) WHERE id = 's'", []).unwrap();
    let sleeper = Sleeper::default();
    let harness = Harness::new(opened(&dir), vec![("sleeper".into(), Arc::new(sleeper.clone()))], settings(4));
    let (id, mut events) = harness.open(Open { provider: "sleeper".into(), cwd: "/nowhere".into(), ..Open::default() }).await.unwrap();
    events.recv().await.unwrap();
    // A retry whose listing fails again gives up on every session on record but those that run here.
    let refused = harness.resume("s").await.err().map(|e| e.to_string()).unwrap_or_default();
    assert!(refused.contains("the store could not list them"), "held: {refused}");
    let live_given_up: Option<bool> = raw.query_row("SELECT given_up FROM sessions WHERE id = ?1", [&id], |row| row.get(0)).unwrap();
    assert_eq!(live_given_up, Some(false), "a session that runs here is never given up on");
    raw.execute("UPDATE sessions SET id = CAST(id AS TEXT) WHERE typeof(id) = 'blob'", []).unwrap();
    let _ = harness.resume("s").await;
    assert_eq!(ended(old_child), Some(libc::SIGKILL), "the leftover was stopped by that retry");
    let running = sleeper.children.lock().unwrap()[0].try_wait().unwrap().is_none();
    assert!(running, "the agent this harness started runs on, though it now has a record too");
    harness.close(&id).unwrap();
    closed(&mut events).await;
    for mut child in sleeper.children.lock().unwrap().drain(..) {
        let _ = child.kill();
        child.wait().unwrap();
    }
}

#[tokio::test]
async fn leftover_retried_under_the_locks_waits_for_no_kill_and_says_it_had_not_ended() {
    let (_tmp, dir) = data_dir();
    let (mut child, agent) = agent();
    left_by_a_crash(&dir, &agent);
    let raw = rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap();
    raw.execute("UPDATE sessions SET agent_pid = -1 WHERE id = 's'", []).unwrap();
    let harness = started_harness(&dir);
    raw.execute("UPDATE sessions SET agent_pid = ?1 WHERE id = 's'", [agent.pid]).unwrap();
    // A kill that never lands: a start's wait for it is 2 s, and this retry holds every session's locks.
    process::seam::swallow_group_kills(agent.pid);
    let begun = std::time::Instant::now();
    let refused = harness.resume("s").await.err().map(|e| e.to_string()).unwrap_or_default();
    let took = begun.elapsed();
    assert!(took < Duration::from_secs(1), "the retry waited {took:?}");
    // Its leader runs with its recorded start in this boot, so the group is surely the agent's, and named.
    let holds = format!("session s's agent may still run (its process group is {}; it was sent a kill and had not ended when last checked)", agent.pid);
    assert!(refused.contains(&holds) && refused.ends_with("end it, then try again"), "{refused}");
    assert!(running(&mut child));
    child.kill().unwrap();
    child.wait().unwrap();
}

#[tokio::test]
async fn leftover_whose_giving_up_cannot_be_written_holds_every_resume_until_it_can() {
    let (_tmp, dir) = data_dir();
    let elsewhere = dir.with_file_name("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let (leader, work) = a_leader_gone_with_its_work_left(&elsewhere);
    left_in(&dir, Some(&leader), &worktree(&dir));
    sql(&dir, "UPDATE sessions SET given_up = 0, given_up_why = NULL WHERE id = 's'");
    // The store refuses to mark it given up, as a full disk or a read-only file would.
    sql(&dir, "CREATE TRIGGER no_giving_up BEFORE UPDATE OF given_up ON sessions WHEN NEW.given_up = 1 BEGIN SELECT RAISE(FAIL, 'no'); END");
    let harness = started_harness(&dir);
    assert!(!is_given_up(&dir), "the write failed");
    for refused in [harness.resume("s").await.err(), harness.clean_up("s").await.err()] {
        let refused = refused.map(|e| e.to_string()).unwrap_or_default();
        assert!(refused.contains("could not check for agents an earlier harness left running") && refused.contains("record them"), "{refused}");
    }
    sql(&dir, "DROP TRIGGER no_giving_up");
    let refused = harness.resume("s").await.err().map(|e| e.to_string()).unwrap_or_default();
    assert!(refused.contains(&format!("a process in session s's process group {} may still run", leader.pid)), "{refused}");
    assert!(is_given_up(&dir));
    assert!(process::alive(&work), "never signalled");
    kill(&work);
}

#[test]
fn leftover_whose_listed_member_exits_after_forking_is_listed_again_before_it_counts_as_gone() {
    let (_tmp, dir) = data_dir();
    let worktree = worktree(&dir);
    let (leader, work) = a_leader_gone_with_its_work_left(&worktree);
    left_in(&dir, Some(&leader), &worktree);
    // The first listing holds only a process gone since, as a member that forked its child and exited.
    let mut gone = Command::new("/usr/bin/true").spawn().unwrap();
    let gone_pid = gone.id() as libc::pid_t;
    gone.wait().unwrap();
    process::seam::list_group_once_as(leader.pid, Listing::Members(vec![gone_pid]));
    let harness = started_harness(&dir);
    assert!(!process::alive(&work), "the child the second listing found was stopped");
    assert_eq!(row(harness, &dir), (false, vec![]));
}

#[test]
fn leftover_whose_group_answers_but_lists_nothing_stays_given_up_and_nothing_is_signalled() {
    // As `hidepid` hides another user's member on Linux: the group is there, its members are not listed.
    let (_tmp, dir) = data_dir();
    let worktree = worktree(&dir);
    let (leader, work) = a_leader_gone_with_its_work_left(&worktree);
    left_in(&dir, Some(&leader), &worktree);
    process::seam::list_group_as(leader.pid, Listing::Nothing);
    let harness = started_harness(&dir);
    assert!(process::alive(&work), "not killed");
    assert_eq!(process::seam::sent_to(work.pid), Vec::<i32>::new());
    assert_eq!(row(harness, &dir), (true, vec![("s".to_owned(), leader)]), "kept on record, and given up on");
    kill(&work);
}

#[tokio::test]
async fn leftover_freed_by_a_watched_resume_ends_before_the_watch_begins() {
    let (_tmp, dir) = data_dir();
    let elsewhere = dir.with_file_name("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let (leader, work) = a_leader_gone_with_its_work_left(&elsewhere);
    let store = opened(&dir);
    store.create_session("s", "sleeper", false, &worktree(&dir), None).unwrap();
    store.append("s", &Body::TurnStarted, harness::store::now_ms()).unwrap();
    store.set_agent("s", Some(&leader)).unwrap();
    drop(store);
    sql(&dir, "UPDATE sessions SET repo = 'acme/webshop', provider_session = 'sleeper-old' WHERE id = 's'");
    let sleeper = Sleeper::default();
    let harness = Harness::new(opened(&dir), vec![("sleeper".into(), Arc::new(sleeper.clone()))], settings(4));
    assert!(is_given_up(&dir), "kept: its work runs outside the worktree");
    kill(&work);
    while process::may_run(&work) {
        tokio::task::yield_now().await;
    }
    // The recheck ends the old start in the events; the watch starts after that end, at the new start.
    let (_feed, after) = harness.resume_watched("s", None, false).unwrap();
    let since: Vec<Body> = harness.events("s", 0).unwrap().into_iter().filter(|event| event.seq > after).map(|event| event.body).collect();
    assert!(!since.iter().any(|body| matches!(body, Body::Failed { .. } | Body::Closed { .. })), "the old start's end is before the cursor: {since:?}");
    let before = harness.events("s", 0).unwrap().into_iter().filter(|event| event.seq <= after).map(|event| event.body).collect::<Vec<_>>();
    assert!(ended_by_the_next_harness(&before, "the agent was gone too"), "{before:?}");
    harness.close("s").unwrap();
    for mut child in sleeper.children.lock().unwrap().drain(..) {
        let _ = child.kill();
        child.wait().unwrap();
    }
}

#[test]
fn leftover_whose_group_lists_only_an_exited_process_twice_but_still_answers_where_listings_hide_stays_given_up() {
    // A zombie seen, and a member hidden, as `hidepid` hides another user's: the group still answers for it.
    let (_tmp, dir) = data_dir();
    let worktree = worktree(&dir);
    let (leader, work) = a_leader_gone_with_its_work_left(&worktree);
    left_in(&dir, Some(&leader), &worktree);
    let mut exited = Command::new("/usr/bin/true").spawn().unwrap();
    while process::started_of(exited.id()).is_some() {
        std::thread::sleep(Duration::from_millis(10));
    }
    process::seam::list_group_as(leader.pid, Listing::Members(vec![exited.id() as libc::pid_t]));
    process::seam::listing_hides(true);
    let harness = started_harness(&dir);
    assert!(process::alive(&work), "not killed");
    assert_eq!(process::seam::sent_to(work.pid), Vec::<i32>::new());
    assert_eq!(row(harness, &dir), (true, vec![("s".to_owned(), leader)]), "kept on record, and given up on");
    exited.wait().unwrap();
    kill(&work);
}

#[tokio::test]
async fn leftover_whose_end_cannot_be_written_is_kept_on_record_with_no_half_end_and_ended_once_it_can() {
    let (_tmp, dir) = data_dir();
    left_by_a_crash(&dir, &Process { pid: 4242, started: 7 });
    opened(&dir).append("s", &Body::TurnStarted, harness::store::now_ms()).unwrap();
    sql(&dir, "UPDATE sessions SET agent_boot = 'another boot' WHERE id = 's'");
    // The store takes the `failed` but refuses the `closed`.
    sql(&dir, "CREATE TRIGGER no_closed BEFORE INSERT ON events WHEN NEW.type = 'closed' BEGIN SELECT RAISE(FAIL, 'no'); END");
    let harness = started_harness(&dir);
    let events: Vec<Body> = harness.events("s", 0).unwrap().into_iter().map(|event| event.body).collect();
    assert_eq!(events, [Body::TurnStarted], "neither half of its end");
    let refused = harness.resume("s").await.err().map(|e| e.to_string()).unwrap_or_default();
    assert!(refused.contains("could not check for agents an earlier harness left running"), "{refused}");
    sql(&dir, "DROP TRIGGER no_closed");
    let _ = harness.resume("s").await;
    let said: Vec<Body> = harness.events("s", 0).unwrap().into_iter().map(|event| event.body).collect();
    assert!(ended_by_the_next_harness(&said, "the agent was gone too"), "{said:?}");
    assert_eq!(row(harness, &dir), (false, vec![]));
}

/// An agent whose leader is gone as soon as it starts, leaving its work in its group; its output closes at once.
#[derive(Default, Clone)]
struct Leaver {
    left: Arc<Mutex<Vec<Work>>>,
}

impl Driver for Leaver {
    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }

    fn open(&self, launch: Launch) -> Result<Link, OpenError> {
        let (leader, work) = a_leader_gone_with_its_work_left(&launch.cwd);
        self.left.lock().unwrap().push(work);
        let (commands, _) = tokio::sync::mpsc::unbounded_channel();
        let (output, receiver) = tokio::sync::mpsc::unbounded_channel();
        let _ = output.send(Body::Started { provider_session: format!("leaver-{}", leader.pid), resumed: false });
        Ok(Link { commands, output: receiver, process: Some(leader) })
    }
}

#[tokio::test]
async fn leftover_an_agent_that_ends_with_its_group_still_running_stays_on_record_until_a_recheck_finds_it_gone() {
    let (_tmp, dir) = data_dir();
    let leaver = Leaver::default();
    let harness = Harness::new(opened(&dir), vec![("leaver".into(), Arc::new(leaver.clone()))], settings(4));
    let (id, mut events) = harness.open(Open { provider: "leaver".into(), cwd: worktree(&dir), ..Open::default() }).await.unwrap();
    closed(&mut events).await;
    let listed = harness.sessions().unwrap().into_iter().find(|session| session.id == id).and_then(|session| session.given_up).unwrap_or_default();
    assert!(listed.contains("its agent ended, but its process group still answered when its session closed"), "{listed}");
    // A resume checks it again, and its group is still not the harness's to stop.
    let refused = harness.resume(&id).await.err().map(|e| e.to_string()).unwrap_or_default();
    assert!(refused.contains("may still run"), "{refused}");
    let work = leaver.left.lock().unwrap().remove(0);
    assert!(process::alive(&work), "never signalled");
    kill(&work);
    let refused = harness.resume(&id).await.err().map(|e| e.to_string()).unwrap_or_default();
    assert!(!refused.contains("may still run"), "freed once its group is gone: {refused}");
    harness.close(&id).unwrap_or_default();
    for work in leaver.left.lock().unwrap().drain(..) {
        kill(&work);
    }
}

#[test]
fn leftover_sent_its_kill_waits_for_a_process_that_refuses_signals_as_one_that_may_still_run() {
    // As a command the agent ran with sudo: gone or not, it answers that it may not be signalled.
    let (_tmp, dir) = data_dir();
    let (child, agent) = agent();
    left_by_a_crash(&dir, &agent);
    process::seam::refuse_signals_from(agent.pid);
    let harness = started_harness(&dir);
    assert_eq!(ended(child), Some(libc::SIGKILL), "sent its kill");
    let listed = harness.sessions().unwrap()[0].given_up.clone().unwrap_or_default();
    assert!(listed.contains("it was sent a kill and had not ended when last checked"), "waited for it, and kept: {listed}");
}

#[tokio::test]
async fn leftover_kept_is_not_handed_over_and_each_call_says_what_keeps_it() {
    let (_tmp, dir) = data_dir();
    left_by_a_shutdown(&dir, None);
    let harness = started_harness(&dir);
    let keeps = "session s's agent may still run (a shutdown stopped waiting for it)";
    let refused = harness.hand_over("s").err().map(|e| e.to_string()).unwrap_or_default();
    // With no record to check, nothing frees it (m17): each refusal says so.
    assert!(refused.contains(keeps) && refused.ends_with("so it is never handed over: open a new session for its work"), "{refused}");
    for (refused, what) in [(harness.resume("s").await.err(), "resumed"), (harness.clean_up("s").await.err(), "cleaned up")] {
        let refused = refused.map(|e| e.to_string()).unwrap_or_default();
        assert!(refused.contains(keeps) && refused.contains(&format!("so it is never {what}")), "{refused}");
    }
    drop(harness);
    assert!(!opened(&dir).session("s").unwrap().handed_over && !said(&dir).contains(&Body::HandedOver), "not marked handed over");
}

#[tokio::test]
async fn leftover_kept_after_a_hand_over_is_not_taken_back_or_cleaned_up_and_says_what_keeps_it() {
    // Terminal may work in it, and so may the agent the shutdown left: neither call goes ahead, and each says why.
    let (_tmp, dir) = data_dir();
    left_by_a_shutdown(&dir, None);
    opened(&dir).set_handed_over("s", true).unwrap();
    let harness = started_harness(&dir);
    let keeps = "session s's agent may still run (a shutdown stopped waiting for it)";
    for (refused, what) in [(harness.take_back("s").await.err(), "taken back"), (harness.clean_up("s").await.err(), "cleaned up")] {
        let refused = refused.map(|e| e.to_string()).unwrap_or_default();
        assert!(refused.contains(keeps) && refused.contains(&format!("so it is never {what}")), "{refused}");
    }
    drop(harness);
    assert!(opened(&dir).session("s").unwrap().handed_over, "still handed over");
}

#[tokio::test]
async fn leftover_an_agent_that_ends_with_its_group_running_and_whose_hold_cannot_be_written_holds_every_resume() {
    let (_tmp, dir) = data_dir();
    let leaver = Leaver::default();
    let harness = Harness::new(opened(&dir), vec![("leaver".into(), Arc::new(leaver.clone()))], settings(4));
    sql(&dir, "CREATE TRIGGER no_giving_up BEFORE UPDATE OF given_up ON sessions WHEN NEW.given_up = 1 BEGIN SELECT RAISE(FAIL, 'no'); END");
    let (id, mut events) = harness.open(Open { provider: "leaver".into(), cwd: worktree(&dir), ..Open::default() }).await.unwrap();
    closed(&mut events).await;
    let refused = harness.resume(&id).await.err().map(|e| e.to_string()).unwrap_or_default();
    // Held: that resume checked again, and the store still could not record what it found.
    assert!(refused.contains("could not check for agents an earlier harness left running"), "{refused}");
    // Once the store takes it, the check writes the hold, and the session is given up on.
    sql(&dir, "DROP TRIGGER no_giving_up");
    let refused = harness.resume(&id).await.err().map(|e| e.to_string()).unwrap_or_default();
    assert!(refused.contains("may still run"), "{refused}");
    for work in leaver.left.lock().unwrap().drain(..) {
        kill(&work);
    }
}

#[tokio::test]
async fn leftover_a_start_whose_agent_was_never_recorded_and_whose_group_outlives_it_stays_taken_until_a_shutdown_gives_it_up() {
    let (_tmp, dir) = data_dir();
    let leaver = Leaver::default();
    let harness = Harness::new(opened(&dir), vec![("leaver".into(), Arc::new(leaver.clone()))], settings(4));
    // Nothing can record its agent: not at its start, and not when its group outlives it.
    sql(&dir, "CREATE TRIGGER refuse_agent BEFORE UPDATE OF agent_pid ON sessions WHEN NEW.agent_pid IS NOT NULL BEGIN SELECT RAISE(ABORT, 'refused'); END");
    assert!(harness.open(Open { provider: "leaver".into(), cwd: worktree(&dir), ..Open::default() }).await.is_err());
    let id = harness.sessions().unwrap().into_iter().next().expect("the session's row").id;
    let left = tokio::time::timeout(Duration::from_secs(10), harness.shutdown()).await.expect("shutdown does not wait for ever");
    assert_eq!(left, [id], "still taken when the shutdown came, and given up on by it");
    for work in leaver.left.lock().unwrap().drain(..) {
        kill(&work);
    }
}

#[test]
fn leftover_whose_turn_had_ended_is_closed_with_no_cut_so_nothing_carries_it_on() {
    use harness::event::{Body, ClosedBy, TurnEnd};
    let (_tmp, dir) = data_dir();
    let (child, agent) = agent();
    left_by_a_shutdown(&dir, Some(&agent));
    opened(&dir).append("s", &Body::TurnEnded { how: TurnEnd::Done }, harness::store::now_ms()).unwrap();
    let harness = started_harness(&dir);
    assert_eq!(ended(child), Some(libc::SIGKILL));
    drop(harness);
    assert_eq!(said(&dir), [Body::TurnStarted, Body::TurnEnded { how: TurnEnd::Done }, Body::Closed { by: ClosedBy::HarnessWent }], "an idle start's end, not a cut turn's");
}

#[test]
fn leftover_with_a_permission_request_still_open_may_not_carry_on_as_after_a_shutdown() {
    use harness::event::{Body, Decision, PermissionKind};
    let asked = |id: &str| Body::Permission { id: id.into(), kind: PermissionKind::Tool, tool: "Read".into(), input: serde_json::json!({}) };
    for (answered, open) in [(false, true), (true, false)] {
        let (_tmp, dir) = data_dir();
        let (child, agent) = agent();
        left_by_a_shutdown(&dir, Some(&agent));
        let store = opened(&dir);
        store.append("s", &asked("r1"), harness::store::now_ms()).unwrap();
        if answered {
            store.append("s", &Body::Answered { id: "r1".into(), decision: Decision::Allow, message: None }, harness::store::now_ms()).unwrap();
        }
        drop(store);
        let harness = started_harness(&dir);
        assert_eq!(ended(child), Some(libc::SIGKILL));
        drop(harness);
        assert!(ended_by_the_next_harness(&said(&dir), "stopped it"), "{:?}", said(&dir));
        let marked = opened(&dir).session("s").unwrap().no_carry_on;
        assert_eq!(marked.as_deref(), open.then_some(harness::store::OPEN_REQUEST_STOPPED), "answered {answered}");
    }
}
