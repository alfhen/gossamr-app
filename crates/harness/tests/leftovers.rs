//! A harness that starts stops the agents a harness before it left running, by pid and start time.

mod common;

use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::Path;
use std::process::{Child, Command};
use std::time::Duration;

use common::*;
use harness::process::{self, Listing, Process};
use harness::session::Harness;
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

/// A store with session `s`, given up on by a shutdown, whose agent is `agent`.
fn left_by_a_shutdown(dir: &Path, agent: Option<&Process>) {
    let store = Store::open(dir).unwrap();
    store.create_session("s", "mock", false, Path::new("/a"), None).unwrap();
    store.set_agent("s", agent).unwrap();
    store.set_given_up("s").unwrap();
}

fn started_harness(dir: &Path) -> Harness {
    Harness::new(Store::open(dir).unwrap(), vec![], settings(4))
}

fn row(harness: Harness, dir: &Path) -> (bool, Vec<(String, Process)>) {
    drop(harness);
    let store = Store::open(dir).unwrap();
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
    child.kill().unwrap();
    child.wait().unwrap();
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
    let store = Store::open(dir).unwrap();
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
    assert!(refused.contains("gave up"), "no resume beside it: {refused}");
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
}

/// The reviewer's probe: a leader in a group of its own starts `sleep 60` in the background and exits, reaped. Its
/// record, taken while it ran, and the sleep, which keeps the group.
fn a_leader_gone_with_its_work_left() -> (Process, Process) {
    let mut leader = Command::new("/bin/sh")
        .args(["-c", "sleep 60 & echo $!; read go"])
        .process_group(0)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let record = Process { pid: leader.id(), started: process::started_of(leader.id()).expect("it runs") };
    let mut said = String::new();
    std::io::BufRead::read_line(&mut std::io::BufReader::new(leader.stdout.take().unwrap()), &mut said).unwrap();
    let pid: u32 = said.trim().parse().unwrap();
    let work = Process { pid, started: process::started_of(pid).expect("the sleep runs") };
    drop(leader.stdin.take());
    leader.wait().unwrap();
    (record, work)
}

#[test]
fn leftover_whose_leader_is_gone_has_what_it_left_in_its_group_stopped_before_its_session_is_freed() {
    let (_tmp, dir) = data_dir();
    let (leader, work) = a_leader_gone_with_its_work_left();
    left_by_a_shutdown(&dir, Some(&leader));
    let harness = started_harness(&dir);
    assert!(!process::alive(&work), "the work its group kept was killed");
    assert_eq!(row(harness, &dir), (false, vec![]), "and only then is the session free");
}

#[test]
fn leftover_whose_leader_is_gone_and_whose_group_cannot_be_read_stays_given_up_and_nothing_is_signalled() {
    let (_tmp, dir) = data_dir();
    let (leader, work) = a_leader_gone_with_its_work_left();
    left_by_a_shutdown(&dir, Some(&leader));
    process::seam::list_group_as(leader.pid, Listing::Full);
    let harness = started_harness(&dir);
    assert!(process::alive(&work), "a listing that proves nothing signals nothing");
    assert_eq!(process::seam::sent_to(leader.pid), Vec::<i32>::new());
    assert_eq!(row(harness, &dir), (true, vec![("s".to_owned(), leader)]), "kept on record, and given up on");
    // SAFETY: the sleep's own pid, read while it runs.
    unsafe { libc::kill(work.pid as libc::pid_t, libc::SIGKILL) };
}
