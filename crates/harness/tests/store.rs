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
    store.set_provider_session("a", Some("p-1")).unwrap();
    drop(store);
    assert_eq!(user_version(&dir), 3, "user_version counts the steps");
    let store = Store::open(&dir).unwrap();
    let row = store.session("a").unwrap();
    assert_eq!((row.provider.as_str(), row.locked, row.model.as_deref(), row.provider_session.as_deref()), ("mock", true, Some("haiku"), Some("p-1")));
    drop(store);
    assert_eq!(user_version(&dir), 3);

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

#[test]
fn retention_a_withheld_event_keeps_its_fields_with_their_json_types_at_clean_up_and_in_the_sweep() {
    use harness::event::{Decision, FailKind, PermissionKind, TurnEnd};
    let (_tmp, dir) = data_dir();
    let store = Store::open(&dir).unwrap();
    let bodies = [
        Body::Started { provider_session: "p1".into(), resumed: true },
        Body::Started { provider_session: "p2".into(), resumed: false },
        Body::ToolResult { id: "t1".into(), output: serde_json::json!("private"), error: true },
        Body::ToolResult { id: "t2".into(), output: serde_json::json!("private"), error: false },
        Body::Permission { id: "p1".into(), kind: PermissionKind::Command, tool: "Bash".into(), input: serde_json::json!({}) },
        Body::Answered { id: "p1".into(), decision: Decision::Allow, message: None },
        Body::TurnEnded { how: TurnEnd::Done },
        Body::Failed { kind: FailKind::Provider, reason: "private".into() },
    ];
    let old = now_ms() - KEEP_MS - 60_000;
    for (session, ms) in [("cleaned", now_ms()), ("aged", old)] {
        store.create_session(session, "mock", false, Path::new("/a"), None).unwrap();
        for body in &bodies {
            store.append(session, body, ms).unwrap();
        }
    }
    store.clean_up("cleaned").unwrap();
    assert_eq!(store.sweep(now_ms()).unwrap(), bodies.len());
    let expected: Vec<Body> = bodies.iter().map(Body::withheld).collect();
    for session in ["cleaned", "aged"] {
        let got: Vec<Body> = store.events(session, 0).unwrap().into_iter().map(|event| event.body).collect();
        assert_eq!(got, expected, "{session}: booleans stay booleans and strings stay strings");
    }
}

#[test]
fn tokens_the_store_keeps_stored_keys_once_each_and_never_a_token() {
    let (_tmp, dir) = data_dir();
    let store = Store::open(&dir).unwrap();
    let token = harness::auth::Token::random();
    store.add_client_token(&token.stored_key()).unwrap();
    store.add_client_token(&token.stored_key()).unwrap();
    assert_eq!(store.client_tokens().unwrap().iter().map(|token| token.stored_key).collect::<Vec<_>>(), [token.stored_key()]);
    drop(store);
    let disk = bytes_on_disk(&dir);
    assert!(!disk.windows(32).any(|window| window == harness::auth::decode(&token.hex()).unwrap()), "the token's bytes are nowhere on disk");
    assert!(!String::from_utf8_lossy(&disk).contains(&token.hex()), "nor its hex");
}

#[tokio::test(start_paused = true)]
async fn sweep_runs_on_its_timer_with_no_read_or_open() {
    let (_tmp, dir) = data_dir();
    let store = Store::open(&dir).unwrap();
    store.create_session("a", "mock", false, Path::new("/a"), None).unwrap();
    store.append("a", &text("old"), now_ms() - KEEP_MS - 1).unwrap();
    let harness = harness::session::Harness::new(store, vec![], settings(4));
    let payload = || -> String {
        let raw = rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap();
        raw.query_row("SELECT payload FROM events WHERE session = 'a'", [], |row| row.get(0)).unwrap()
    };
    assert!(payload().contains("old"), "nothing has swept yet");
    let (task, mut swept) = harness.sweep_on_timer(std::time::Duration::from_secs(3600));
    // The clock is paused and moves on only when every task waits, so this returns once the timer has fired.
    swept.changed().await.unwrap();
    assert!(!payload().contains("old"), "the timer's sweep dropped the payload with no read or open");
    task.abort();
}

#[test]
fn sweep_deletes_the_rows_of_old_cleaned_and_old_idle_sessions() {
    let (_tmp, dir) = data_dir();
    let store = Store::open(&dir).unwrap();
    let day = 24 * 60 * 60 * 1000;
    let now = now_ms();
    // a: cleaned 31 days ago. b: never cleaned, last event 91 days ago. c and d: a day short of each.
    for (id, last_event) in [("a", now - day), ("b", now - 91 * day), ("c", now - day), ("d", now - 89 * day)] {
        store.create_session(id, "mock", false, Path::new("/x"), None).unwrap();
        store.append(id, &text("one"), last_event - 1).unwrap();
        store.append(id, &text("two"), last_event).unwrap();
    }
    store.clean_up("a").unwrap();
    store.clean_up("c").unwrap();
    let raw = rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap();
    raw.execute("UPDATE sessions SET cleaned_ms = ?1 WHERE id = 'a'", [now - 31 * day]).unwrap();
    raw.execute("UPDATE sessions SET cleaned_ms = ?1 WHERE id = 'c'", [now - 29 * day]).unwrap();
    store.sweep(now).unwrap();
    let rows = |id: &str| -> i64 { raw.query_row("SELECT COUNT(*) FROM events WHERE session = ?1", [id], |row| row.get(0)).unwrap() };
    assert_eq!((rows("a"), rows("b"), rows("c"), rows("d")), (0, 0, 2, 2));
    assert_eq!(store.append("b", &text("three"), now).unwrap().seq, 3, "the numbers go on after the rows are gone");
    assert_eq!(store.sessions().unwrap().iter().map(|row| row.last_seq).collect::<Vec<_>>(), [2, 3, 2, 2]);
}

#[test]
fn tokens_past_the_cap_are_refused_and_the_last_one_cannot_be_revoked() {
    let (_tmp, dir) = data_dir();
    let store = Store::open(&dir).unwrap();
    let max = harness::store::MAX_CLIENT_TOKENS;
    for _ in 0..max {
        store.add_client_token(&harness::auth::Token::random().stored_key()).unwrap();
    }
    let kept = store.client_tokens().unwrap();
    assert!(matches!(store.add_client_token(&harness::auth::Token::random().stored_key()), Err(Error::Refused(_))), "one past the cap");
    store.add_client_token(&kept[0].stored_key).expect("adding one it has is not a new one");
    assert_eq!(store.client_tokens().unwrap().len(), max);
    for token in &kept[1..] {
        store.revoke_client_token(token.id).unwrap();
    }
    assert!(matches!(store.revoke_client_token(kept[0].id), Err(Error::Refused(_))), "the last one stays");
    assert!(matches!(store.revoke_client_token(9_999), Err(Error::Refused(_))), "no such token");
    assert_eq!(store.client_tokens().unwrap(), kept[..1]);
}

#[test]
fn sweep_finds_idle_sessions_without_reading_their_events() {
    let (_tmp, dir) = data_dir();
    drop(Store::open(&dir).unwrap());
    let raw = rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap();
    let plan: Vec<String> = raw
        .prepare(&format!("EXPLAIN QUERY PLAN {}", harness::store::SWEEP_ROWS))
        .unwrap()
        .query_map(rusqlite::params![0, 0, "[]"], |row| row.get::<_, String>(3))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert!(!plan.iter().any(|step| step.contains("CORRELATED")), "no read of a session's events to choose it: {plan:?}");
}

#[test]
fn tokens_an_id_is_never_used_again_and_a_refusal_says_which_it_is() {
    let (_tmp, dir) = data_dir();
    let store = Store::open(&dir).unwrap();
    for _ in 0..2 {
        store.add_client_token(&harness::auth::Token::random().stored_key()).unwrap();
    }
    let ids: Vec<i64> = store.client_tokens().unwrap().iter().map(|token| token.id).collect();
    store.revoke_client_token(ids[1]).unwrap();
    store.add_client_token(&harness::auth::Token::random().stored_key()).unwrap();
    let after: Vec<i64> = store.client_tokens().unwrap().iter().map(|token| token.id).collect();
    assert_eq!(after, [ids[0], ids[1] + 1], "the revoked id is not handed out again");
    let unknown = store.revoke_client_token(ids[1]).unwrap_err().to_string();
    assert!(unknown.contains(&format!("no client token {}", ids[1])), "{unknown}");
    store.revoke_client_token(after[1]).unwrap();
    let last = store.revoke_client_token(after[0]).unwrap_err().to_string();
    assert!(last.contains("last client token"), "{last}");
}

#[test]
fn sweep_an_event_stored_with_an_earlier_time_does_not_make_a_session_look_idle() {
    let (_tmp, dir) = data_dir();
    let store = Store::open(&dir).unwrap();
    let now = now_ms();
    store.create_session("a", "mock", false, Path::new("/a"), None).unwrap();
    store.append("a", &text("today"), now).unwrap();
    // The clock stepped back 91 days for the next event.
    store.append("a", &text("long ago"), now - 91 * 24 * 60 * 60 * 1000).unwrap();
    store.sweep(now).unwrap();
    assert_eq!(store.events("a", 0).unwrap().len(), 2, "its newest event is today, so its rows stay");
}

#[test]
fn store_a_body_already_withheld_keeps_its_type_through_clean_up() {
    let (_tmp, dir) = data_dir();
    let store = Store::open(&dir).unwrap();
    store.create_session("a", "mock", false, Path::new("/a"), None).unwrap();
    let dropped = Body::Withheld { of: "permission".into(), kept: Default::default() };
    store.append("a", &dropped, now_ms()).unwrap();
    store.clean_up("a").unwrap();
    assert_eq!(store.events("a", 0).unwrap()[0].body, dropped, "still a withheld permission, not a withheld withheld");
}
