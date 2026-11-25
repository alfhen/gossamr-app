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
