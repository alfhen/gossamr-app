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
fn a_store_holds_client_tokens_only_once_one_is_added_and_one_it_cannot_read_counts_as_holding_some() {
    let (_tmp, dir) = data_dir();
    assert!(!harness::store::holds_client_tokens(&dir), "no store");
    let store = Store::open(&dir).unwrap();
    assert!(!harness::store::holds_client_tokens(&dir), "a store a harness made and refused to serve, with no token");
    store.add_client_token(&[7; 32]).unwrap();
    assert!(harness::store::holds_client_tokens(&dir), "read while the store is open and locked");
    drop(store);
    std::fs::write(dir.join("harness.sqlite"), "not a database, but not empty either: sqlite reads its first page").unwrap();
    assert!(harness::store::holds_client_tokens(&dir));
}

#[test]
fn a_store_in_a_folder_that_cannot_be_searched_counts_as_holding_client_tokens() {
    let (_tmp, dir) = data_dir();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o600)).unwrap();
    let held = harness::store::holds_client_tokens(&dir);
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(held, "its store's metadata can't be read, so it may hold some");
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
    assert_eq!(user_version(&dir), 11, "user_version counts the steps");
    let store = Store::open(&dir).unwrap();
    let row = store.session("a").unwrap();
    assert_eq!((row.provider.as_str(), row.locked, row.model.as_deref(), row.provider_session.as_deref()), ("mock", true, Some("haiku"), Some("p-1")));
    drop(store);
    assert_eq!(user_version(&dir), 11);

    rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap().pragma_update(None, "user_version", 12).unwrap();
    assert!(matches!(Store::open(&dir), Err(Error::NewerStore(12))), "a store from a newer harness is not opened");
}

#[test]
fn store_a_store_of_three_steps_gets_step_four_and_its_sessions_have_no_login_effort_or_work() {
    let (_tmp, dir) = data_dir();
    let store = Store::open(&dir).unwrap();
    store.create_session("old", "mock", false, Path::new("/a"), Some("haiku")).unwrap();
    drop(store);
    let conn = rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap();
    conn.execute_batch("ALTER TABLE sessions DROP COLUMN agent_tree; ALTER TABLE sessions DROP COLUMN permissions; ALTER TABLE sessions DROP COLUMN agent_boot; ALTER TABLE sessions DROP COLUMN given_up_why; ALTER TABLE sessions DROP COLUMN agent_pid; ALTER TABLE sessions DROP COLUMN agent_started; DROP TABLE questions; ALTER TABLE sessions DROP COLUMN no_carry_on; ALTER TABLE sessions DROP COLUMN given_up").unwrap();
    for column in ["login", "effort", "repo", "base", "branch", "clone", "endpoint", "tools", "result_schema"] {
        conn.execute_batch(&format!("ALTER TABLE sessions DROP COLUMN {column}")).unwrap();
    }
    conn.pragma_update(None, "user_version", 3).unwrap();
    drop(conn);
    let store = Store::open(&dir).unwrap();
    assert_eq!(user_version(&dir), 11);
    let row = store.session("old").unwrap();
    assert_eq!((row.model.as_deref(), row.login, row.effort, row.work), (Some("haiku"), None, None, None));
}

#[test]
fn tools_endpoint_a_store_of_four_steps_gets_step_five_and_its_sessions_have_no_endpoint_tools_or_schema_yet() {
    let (_tmp, dir) = data_dir();
    let store = Store::open(&dir).unwrap();
    store.create_session("old", "mock", false, Path::new("/a"), Some("haiku")).unwrap();
    drop(store);
    let conn = rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap();
    conn.execute_batch("ALTER TABLE sessions DROP COLUMN agent_tree; ALTER TABLE sessions DROP COLUMN permissions; ALTER TABLE sessions DROP COLUMN agent_boot; ALTER TABLE sessions DROP COLUMN given_up_why; ALTER TABLE sessions DROP COLUMN agent_pid; ALTER TABLE sessions DROP COLUMN agent_started; DROP TABLE questions; ALTER TABLE sessions DROP COLUMN no_carry_on; ALTER TABLE sessions DROP COLUMN given_up").unwrap();
    for column in ["endpoint", "tools", "result_schema"] {
        conn.execute_batch(&format!("ALTER TABLE sessions DROP COLUMN {column}")).unwrap();
    }
    conn.pragma_update(None, "user_version", 4).unwrap();
    drop(conn);
    let store = Store::open(&dir).unwrap();
    assert_eq!(user_version(&dir), 11);
    let row = store.session("old").unwrap();
    assert_eq!((row.model.as_deref(), row.endpoint, row.tools, row.result_schema), (Some("haiku"), None, vec![], None));
    store.set_endpoint("old", "k3x9").unwrap();
    store.set_endpoint("old", "other").unwrap();
    assert_eq!(store.session("old").unwrap().endpoint.as_deref(), Some("k3x9"), "a name once given is kept");
}

#[test]
fn store_a_store_of_ten_steps_gets_step_eleven_and_its_agent_on_record_has_no_tree_until_one_is_noted() {
    use harness::process::Process;
    let (_tmp, dir) = data_dir();
    let store = Store::open(&dir).unwrap();
    store.create_session("old", "codex", false, Path::new("/a"), None).unwrap();
    let agent = Process { pid: 4_000_001, started: 7 };
    store.set_agent("old", Some(&agent)).unwrap();
    drop(store);
    let conn = rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap();
    conn.execute_batch("ALTER TABLE sessions DROP COLUMN agent_tree").unwrap();
    conn.pragma_update(None, "user_version", 10).unwrap();
    drop(conn);
    let store = Store::open(&dir).unwrap();
    assert_eq!(user_version(&dir), 11);
    assert_eq!(store.agent("old").unwrap().map(|found| (found.agent, found.tree)), Some((agent.clone(), vec![])), "the agent is kept, with no tree");
    let command = Process { pid: 4_000_002, started: 8 };
    store.set_agent_tree("old", std::slice::from_ref(&command)).unwrap();
    assert_eq!(store.agent("old").unwrap().unwrap().tree, std::slice::from_ref(&command), "a noted tree is kept beside its agent");
    store.set_agent("old", Some(&agent)).unwrap();
    assert_eq!(store.agent("old").unwrap().unwrap().tree, [command], "and stays while the agent is kept on record");
    store.set_agent_of_start("old", Some(&Process { pid: 4_000_003, started: 9 }), false).unwrap();
    assert_eq!(store.agent("old").unwrap().unwrap().tree, vec![], "a new start's agent has started nothing yet");
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
fn store_a_session_whose_folder_is_not_utf8_does_not_fail_the_listing_of_them_all() {
    use std::os::unix::ffi::OsStrExt;
    let (_tmp, dir) = data_dir();
    let store = Store::open(&dir).unwrap();
    store.create_session("a", "mock", false, Path::new(std::ffi::OsStr::from_bytes(b"/work/caf\xe9")), None).unwrap();
    store.create_session("b", "mock", false, Path::new("/work/plain"), None).unwrap();
    let listed = serde_json::to_value(store.sessions().unwrap()).expect("the listing serialises");
    let cwds: Vec<&str> = listed.as_array().unwrap().iter().map(|row| row["cwd"].as_str().unwrap()).collect();
    assert!(cwds.contains(&"/work/caf\u{fffd}") && cwds.contains(&"/work/plain"), "{cwds:?}");
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

#[test]
fn ask_a_store_of_five_steps_gets_step_six_and_a_question_stays_open_until_it_is_closed() {
    let (_tmp, dir) = data_dir();
    let store = Store::open(&dir).unwrap();
    store.create_session("s", "mock", false, Path::new("/a"), None).unwrap();
    drop(store);
    let conn = rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap();
    conn.execute_batch("ALTER TABLE sessions DROP COLUMN agent_tree; ALTER TABLE sessions DROP COLUMN permissions; ALTER TABLE sessions DROP COLUMN agent_boot; ALTER TABLE sessions DROP COLUMN given_up_why; ALTER TABLE sessions DROP COLUMN agent_pid; ALTER TABLE sessions DROP COLUMN agent_started; DROP TABLE questions; ALTER TABLE sessions DROP COLUMN no_carry_on; ALTER TABLE sessions DROP COLUMN given_up").unwrap();
    conn.pragma_update(None, "user_version", 5).unwrap();
    drop(conn);
    let store = Store::open(&dir).unwrap();
    assert_eq!(user_version(&dir), 11);
    assert_eq!(store.open_question("s").unwrap(), None);
    store.ask("s", "q1", now_ms()).unwrap();
    drop(store);
    let store = Store::open(&dir).unwrap();
    assert_eq!(store.open_question("s").unwrap().as_deref(), Some("q1"), "open after a reopen");
    store.close_question("s", "q1", harness::event::QuestionEnd::Answered, now_ms()).unwrap();
    assert_eq!(store.open_question("s").unwrap(), None);
    store.close_question("s", "q1", harness::event::QuestionEnd::Stopped, now_ms()).unwrap();
    let how: String = rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap().query_row("SELECT closed FROM questions", [], |row| row.get(0)).unwrap();
    assert_eq!(how, "answered", "a closed question is not closed again");
}

#[test]
fn carry_on_a_store_of_six_steps_gets_step_seven_with_nothing_forbidden_or_given_up() {
    let (_tmp, dir) = data_dir();
    let store = Store::open(&dir).unwrap();
    store.create_session("s", "mock", false, Path::new("/a"), None).unwrap();
    drop(store);
    let conn = rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap();
    conn.execute_batch("ALTER TABLE sessions DROP COLUMN agent_tree; ALTER TABLE sessions DROP COLUMN permissions; ALTER TABLE sessions DROP COLUMN agent_boot; ALTER TABLE sessions DROP COLUMN given_up_why; ALTER TABLE sessions DROP COLUMN agent_pid; ALTER TABLE sessions DROP COLUMN agent_started; ALTER TABLE sessions DROP COLUMN no_carry_on; ALTER TABLE sessions DROP COLUMN given_up").unwrap();
    conn.pragma_update(None, "user_version", 6).unwrap();
    drop(conn);
    let store = Store::open(&dir).unwrap();
    assert_eq!(user_version(&dir), 11);
    let row = store.session("s").unwrap();
    assert_eq!((row.no_carry_on, row.given_up), (None, None));
    store.set_no_carry_on("s", Some("it was stopped")).unwrap();
    store.set_given_up("s", "a shutdown stopped waiting for it").unwrap();
    let row = store.session("s").unwrap();
    assert_eq!((row.no_carry_on.as_deref(), row.given_up.as_deref()), (Some("it was stopped"), Some("a shutdown stopped waiting for it")));
}

#[test]
fn leftover_a_store_of_seven_steps_gets_steps_eight_and_nine_and_keeps_an_agent_and_its_boot_until_it_is_gone() {
    let (_tmp, dir) = data_dir();
    let store = Store::open(&dir).unwrap();
    store.create_session("s", "mock", false, Path::new("/a"), None).unwrap();
    drop(store);
    let conn = rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap();
    conn.execute_batch("ALTER TABLE sessions DROP COLUMN agent_tree; ALTER TABLE sessions DROP COLUMN permissions; ALTER TABLE sessions DROP COLUMN agent_pid; ALTER TABLE sessions DROP COLUMN agent_started; ALTER TABLE sessions DROP COLUMN agent_boot; ALTER TABLE sessions DROP COLUMN given_up_why").unwrap();
    conn.pragma_update(None, "user_version", 7).unwrap();
    drop(conn);
    let store = Store::open(&dir).unwrap();
    assert_eq!(user_version(&dir), 11);
    assert_eq!(store.agents().unwrap(), [], "a session from before the step has no agent on record");
    let agent = harness::process::Process { pid: 4242, started: 1_700_000_000 };
    store.set_agent("s", Some(&agent)).unwrap();
    store.set_given_up("s", "a shutdown stopped waiting for it").unwrap();
    assert_eq!(store.agents().unwrap(), [("s".to_owned(), agent.clone())]);
    let recorded = store.agent("s").unwrap().unwrap();
    assert_eq!((recorded.agent, recorded.boot), (agent, harness::process::boot_id()), "recorded with this boot");
    assert_eq!(recorded.worktree, None, "a session that names no repo has no worktree to bound its leftovers");
    store.set_agent("s", None).unwrap();
    assert_eq!(store.agents().unwrap(), []);
    assert_eq!(store.session("s").unwrap().given_up, None, "its agent gone, the session is no longer given up on");
}

#[test]
fn permissions_a_store_of_nine_steps_gets_step_ten_and_its_sessions_ask_for_each_step() {
    let (_tmp, dir) = data_dir();
    let store = Store::open(&dir).unwrap();
    store.create_session("old", "mock", false, Path::new("/a"), None).unwrap();
    drop(store);
    let conn = rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap();
    conn.execute_batch("ALTER TABLE sessions DROP COLUMN agent_tree; ALTER TABLE sessions DROP COLUMN permissions").unwrap();
    conn.pragma_update(None, "user_version", 9).unwrap();
    drop(conn);
    let store = Store::open(&dir).unwrap();
    assert_eq!(user_version(&dir), 11);
    assert_eq!(store.session("old").unwrap().permissions, harness::driver::Permissions::Ask, "a session from before the step started with no mode");
    let new = harness::store::NewSession { provider: "mock", locked: false, cwd: Path::new("/b"), model: None, login: None, effort: None, permissions: harness::driver::Permissions::Auto, work: None, endpoint: None, tools: &[], result_schema: None };
    store.insert_session("new", &new).unwrap();
    assert_eq!(store.session("new").unwrap().permissions, harness::driver::Permissions::Auto);
    let mut listed: Vec<_> = store.sessions().unwrap().into_iter().map(|row| (row.id, row.permissions)).collect();
    listed.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(listed, [("new".to_owned(), harness::driver::Permissions::Auto), ("old".to_owned(), harness::driver::Permissions::Ask)]);
}

#[test]
fn leftover_a_record_from_before_step_nine_has_no_boot_and_was_given_up_on_by_a_shutdown() {
    let (_tmp, dir) = data_dir();
    let store = Store::open(&dir).unwrap();
    store.create_session("s", "mock", false, Path::new("/a"), None).unwrap();
    store.set_agent("s", Some(&harness::process::Process { pid: 4242, started: 7 })).unwrap();
    drop(store);
    let conn = rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap();
    conn.execute_batch("ALTER TABLE sessions DROP COLUMN agent_tree; ALTER TABLE sessions DROP COLUMN permissions; ALTER TABLE sessions DROP COLUMN agent_boot; ALTER TABLE sessions DROP COLUMN given_up_why; UPDATE sessions SET given_up = 1").unwrap();
    conn.pragma_update(None, "user_version", 8).unwrap();
    drop(conn);
    let store = Store::open(&dir).unwrap();
    assert_eq!(user_version(&dir), 11);
    assert_eq!(store.agent("s").unwrap().unwrap().boot, None);
    // Before the step only a shutdown gave up on a session.
    assert_eq!(store.session("s").unwrap().given_up.as_deref(), Some("a shutdown stopped waiting for it"));
    assert_eq!(store.sessions().unwrap()[0].given_up.as_deref(), Some("a shutdown stopped waiting for it"));
}
