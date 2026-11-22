mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use common::*;
use harness::error::Error;
use harness::event::Body;
use harness::store::{KEEP_MS, Store, now_ms};

fn text(s: &str) -> Body {
    Body::Text { text: s.into() }
}

fn withheld_text() -> Body {
    Body::Withheld { of: "text".into(), kept: Default::default() }
}

fn user_version(dir: &Path) -> i64 {
    let conn = rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap();
    conn.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap()
}

#[test]
fn lock_a_second_harness_on_the_same_data_folder_is_refused() {
    let (_tmp, dir) = data_dir();
    let first = Store::open(&dir).unwrap();
    match Store::open(&dir) {
        Err(Error::InUse(at)) => assert_eq!(at, dir),
        Err(e) => panic!("expected the folder to be in use, got {e}"),
        Ok(_) => panic!("a second store opened on a locked data folder"),
    }
    drop(first);
    Store::open(&dir).expect("the folder is free once the first harness lets go");
}

#[test]
fn seq_events_are_numbered_from_one_per_session_and_go_on_after_a_reopen() {
    let (_tmp, dir) = data_dir();
    let store = Store::open(&dir).unwrap();
    store.create_session("a", "mock", false, Path::new("/a"), None).unwrap();
    store.create_session("b", "mock", false, Path::new("/b"), None).unwrap();
    let seqs: Vec<u64> = ["a", "b", "a", "a", "b"].iter().map(|s| store.append(s, &text(s), now_ms()).unwrap().seq).collect();
    assert_eq!(seqs, [1, 1, 2, 3, 2]);
    drop(store);
    let store = Store::open(&dir).unwrap();
    assert_eq!(store.append("a", &text("after"), now_ms()).unwrap().seq, 4);
    let later: Vec<(u64, Body)> = store.events("a", 2).unwrap().into_iter().map(|event| (event.seq, event.body)).collect();
    assert_eq!(later, [(3, text("a")), (4, text("after"))]);
    assert!(store.events("a", 4).unwrap().is_empty());
    assert!(matches!(store.append("nobody", &text("x"), now_ms()), Err(Error::NoSuchSession(_))));
}

#[test]
fn retention_clean_up_drops_the_payload_and_keeps_the_numbers() {
    let (_tmp, dir) = data_dir();
    let store = Store::open(&dir).unwrap();
    store.create_session("a", "mock", false, Path::new("/a"), None).unwrap();
    store.create_session("b", "mock", false, Path::new("/b"), None).unwrap();
    store.append("a", &text("quince-before"), now_ms()).unwrap();
    for n in 0..20 {
        store.append("b", &text(&format!("kept {n} {}", "x".repeat(200))), now_ms()).unwrap();
    }
    store.clean_up("a").unwrap();
    store.append("a", &text("quince-after"), now_ms()).unwrap();
    let events = store.events("a", 0).unwrap();
    assert_eq!(events.iter().map(|event| (event.seq, event.body.clone())).collect::<Vec<_>>(), [
        (1, withheld_text()),
        (2, withheld_text())
    ]);
    assert_eq!(store.events("b", 0).unwrap()[0].body, text(&format!("kept 0 {}", "x".repeat(200))), "another session keeps its payload");
    assert!(store.session("a").unwrap().cleaned);
    drop(store);
    assert!(!contains(&bytes_on_disk(&dir), "quince"), "the dropped payload is overwritten in the file");
}

#[test]
fn retention_payload_older_than_30_days_is_dropped() {
    let (_tmp, dir) = data_dir();
    let store = Store::open(&dir).unwrap();
    store.create_session("a", "mock", false, Path::new("/a"), None).unwrap();
    let now = now_ms();
    store.append("a", &text("old"), now - KEEP_MS - 1).unwrap();
    store.append("a", &text("young"), now - KEEP_MS + 60_000).unwrap();
    drop(store);
    // Opening the store sweeps it.
    let store = Store::open(&dir).unwrap();
    let bodies: Vec<Body> = store.events("a", 0).unwrap().into_iter().map(|event| event.body).collect();
    assert_eq!(bodies, [withheld_text(), text("young")]);
    assert_eq!(store.sweep(now + 2 * 60_000).unwrap(), 1, "the sweep drops what has aged since");
    assert_eq!(store.events("a", 0).unwrap()[1].body, withheld_text());
    assert_eq!(KEEP_MS, 30 * 24 * 60 * 60 * 1000);
}

#[test]
fn store_a_new_file_gets_every_step_and_a_reopen_runs_none_again() {
    let (_tmp, dir) = data_dir();
    let store = Store::open(&dir).unwrap();
    store.create_session("a", "mock", true, Path::new("/a"), Some("haiku")).unwrap();
    store.set_provider_session("a", "p-1").unwrap();
    drop(store);
    assert_eq!(user_version(&dir), 1, "user_version counts the steps");
    let store = Store::open(&dir).unwrap();
    let row = store.session("a").unwrap();
    assert_eq!((row.provider.as_str(), row.locked, row.model.as_deref(), row.provider_session.as_deref()), ("mock", true, Some("haiku"), Some("p-1")));
    drop(store);
    assert_eq!(user_version(&dir), 1);

    rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap().pragma_update(None, "user_version", 9).unwrap();
    assert!(matches!(Store::open(&dir), Err(Error::NewerStore(9))), "a store from a newer harness is not opened");
}

#[test]
fn store_the_data_folder_is_private_to_the_user() {
    let (tmp, dir) = data_dir();
    drop(Store::open(&dir).unwrap());
    let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&dir), 0o700);
    assert_eq!(mode(&dir.join("harness.sqlite")), 0o600);
    assert_eq!(mode(&dir.join("lock")), 0o600);

    let open = tmp.path().join("open");
    std::fs::create_dir(&open).unwrap();
    std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(Store::open(&open), Err(Error::NotPrivate(_))), "a folder others can open is refused");
    assert!(!open.join("harness.sqlite").exists(), "and nothing is written into it");
}

#[test]
fn store_a_sessions_folder_comes_back_byte_for_byte_even_when_it_is_not_utf8() {
    use std::os::unix::ffi::OsStrExt;
    let (_tmp, dir) = data_dir();
    let store = Store::open(&dir).unwrap();
    let cwd = Path::new(std::ffi::OsStr::from_bytes(b"/work/caf\xe9"));
    store.create_session("a", "mock", false, cwd, None).unwrap();
    assert_eq!(store.session("a").unwrap().cwd, cwd);
}

#[test]
fn store_an_event_of_a_type_this_build_does_not_know_reads_as_withheld() {
    let (_tmp, dir) = data_dir();
    let store = Store::open(&dir).unwrap();
    store.create_session("a", "mock", false, Path::new("/a"), None).unwrap();
    store.append("a", &text("before"), now_ms()).unwrap();
    let raw = rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap();
    raw.execute(
        "INSERT INTO events (session, seq, ms, type, payload, withheld) VALUES ('a', 2, 0, 'from_the_future', '{\"type\":\"from_the_future\"}', 0)",
        [],
    )
    .unwrap();
    store.append("a", &text("after"), now_ms()).unwrap();
    let bodies: Vec<Body> = store.events("a", 0).unwrap().into_iter().map(|event| event.body).collect();
    let unknown = Body::Withheld { of: "from_the_future".into(), kept: Default::default() };
    assert_eq!(bodies, [text("before"), unknown, text("after")], "the read does not fail");
}

#[test]
fn store_the_sweep_has_an_index_and_foreign_keys_hold_after_migrating() {
    let (_tmp, dir) = data_dir();
    let store = Store::open(&dir).unwrap();
    let raw = rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap();
    let index: String = raw
        .query_row("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'events_kept_by_age'", [], |row| row.get(0))
        .unwrap();
    assert!(index.contains("(ms) WHERE withheld = 0"), "{index}");
    let plan: String = raw
        .query_row("EXPLAIN QUERY PLAN UPDATE events SET withheld = 1 WHERE withheld = 0 AND ms < 5", [], |row| row.get(3))
        .unwrap();
    assert!(plan.contains("events_kept_by_age"), "{plan}");
    assert!(matches!(store.append("nobody", &text("x"), now_ms()), Err(Error::NoSuchSession(_))));
}

#[test]
fn store_a_link_to_nothing_is_named_and_a_file_others_could_read_is_made_private() {
    let (tmp, dir) = data_dir();
    let link = tmp.path().join("link");
    std::os::unix::fs::symlink(tmp.path().join("missing"), &link).unwrap();
    assert!(matches!(Store::open(&link), Err(Error::DanglingLink(_))));
    assert_eq!(Error::DanglingLink(link.clone()).to_string(), format!("the data folder {} is a link to nothing", link.display()));

    drop(Store::open(&dir).unwrap());
    let file = dir.join("harness.sqlite");
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
    drop(Store::open(&dir).unwrap());
    assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
}
