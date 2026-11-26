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

/// A process in a group of its own, as an agent is started.
fn agent() -> (Child, Process) {
    let child = Command::new("/bin/sleep").arg("60").process_group(0).spawn().unwrap();
    let pid = child.id();
    (child, Process { pid, started: process::started_of(pid).expect("it runs") })
}

/// How `child` ended, within 10 s; a child still running then is killed, and None says so.
fn ended(mut child: Child) -> Option<i32> {
    let (done, waited) = std::sync::mpsc::channel();
    let pid = child.id();
    let waiter = std::thread::spawn(move || {
        let status = child.wait().unwrap();
        let _ = done.send(());
        status.signal()
    });
    if waited.recv_timeout(Duration::from_secs(10)).is_err() {
        // SAFETY: our own child, not yet reaped, so the pid is still the one we started.
        unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
        waiter.join().unwrap();
        return None;
    }
    waiter.join().unwrap()
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

/// As `left_by_a_shutdown`, for a session opened in `folder`, which names no repo.
fn left_in_folder(dir: &Path, agent: Option<&Process>, folder: &Path) {
    let store = opened(dir);
    store.create_session("s", "mock", false, folder, None).unwrap();
    store.set_agent("s", agent).unwrap();
    store.set_given_up("s").unwrap();
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
    matches!(said, [.., Body::Failed { kind: FailKind::AgentStopped, reason }, Body::Closed { by: ClosedBy::Harness }] if reason.contains(how))
}

fn row(harness: Harness, dir: &Path) -> (bool, Vec<(String, Process)>) {
    drop(harness);
    let store = opened(dir);
    (store.session("s").unwrap().given_up, store.agents().unwrap())
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
    assert_eq!(said(&dir), [closed], "the shutdown's closed stays the last word");
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

#[test]
fn leftover_given_up_with_no_agent_on_record_stays_given_up() {
    let (_tmp, dir) = data_dir();
    left_by_a_shutdown(&dir, None);
    let harness = started_harness(&dir);
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

/// The reviewer's probe: a leader in a group of its own starts `sleep 60` in the background and exits, reaped. Its
/// record, taken while it ran, and the sleep, which keeps the group. Both work in `cwd`.
fn a_leader_gone_with_its_work_left(cwd: &Path) -> (Process, Process) {
    let (leader, mut work) = a_leader_gone_leaving(cwd, 1);
    (leader, work.remove(0))
}

/// As `a_leader_gone_with_its_work_left`, with `count` sleeps left.
fn a_leader_gone_leaving(cwd: &Path, count: usize) -> (Process, Vec<Process>) {
    let mut leader = Command::new("/bin/sh")
        .args(["-c", &format!("{} read go", "sleep 60 & echo $!;".repeat(count))])
        .current_dir(cwd)
        .process_group(0)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let record = Process { pid: leader.id(), started: process::started_of(leader.id()).expect("it runs") };
    let mut said = std::io::BufRead::lines(std::io::BufReader::new(leader.stdout.take().unwrap()));
    let work = (0..count)
        .map(|_| {
            let pid: u32 = said.next().unwrap().unwrap().trim().parse().unwrap();
            Process { pid, started: process::started_of(pid).expect("the sleep runs") }
        })
        .collect();
    drop(leader.stdin.take());
    leader.wait().unwrap();
    (record, work)
}

fn kill(process: &Process) {
    // SAFETY: a sleep's own pid, read while it ran; it may be gone, and nothing else took it within the test.
    unsafe { libc::kill(process.pid as libc::pid_t, libc::SIGKILL) };
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
    let (mut older, older_record) = agent();
    let mut gone = Command::new("/usr/bin/true").process_group(0).spawn().unwrap();
    let leader = Process { pid: gone.id(), started: older_record.started + 1 };
    gone.wait().unwrap();
    left_by_a_shutdown(&dir, Some(&leader));
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
    // SAFETY: the sleep's own pid, read while it runs.
    unsafe { libc::kill(work.pid as libc::pid_t, libc::SIGKILL) };
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
    for (record, member) in [(&leader, &work), (&live, &live)] {
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
    for refused in [harness.resume("s").await.err(), harness.clean_up("s").await.err()] {
        let refused = refused.map(|e| e.to_string()).unwrap_or_default();
        assert!(refused.contains(&format!("may still run (its process group is {})", leader.pid)) && refused.ends_with("end it, then try again"), "{refused}");
    }
    assert!(process::alive(&work), "checked again, still not the harness's to kill");
    kill(&work);
    while process::may_run(&work) {
        tokio::task::yield_now().await;
    }
    let refused = harness.resume("s").await.err().map(|e| e.to_string()).unwrap_or_default();
    assert!(!refused.contains("may still run"), "freed in this harness: {refused}");
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
        let agents: Vec<(Child, Process)> = (0..count).map(|_| agent()).collect();
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
        self.children.lock().unwrap().push(child);
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
    while events.recv().await.is_ok_and(|event| !matches!(event.body, Body::Closed { .. })) {}
    assert_eq!(closes(&harness), 1, "one closed for its start");
    for mut child in sleeper.children.lock().unwrap().drain(..) {
        let _ = child.kill();
        child.wait().unwrap();
    }
}
