use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicBool, Ordering};

use super::*;

const FAST: Timing = Timing { retry: Duration::from_millis(2), give_up: Duration::from_millis(60), confirm: Duration::from_millis(5) };

fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("gossamr-runs-trust-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
}

/// A settings file `.claude.json` holding `text`, and a clone folder to trust.
struct Login {
    root: PathBuf,
    file: PathBuf,
    clone: PathBuf,
}

fn login(tag: &str, text: &str) -> Login {
    let root = scratch(tag);
    let (file, clone) = (root.join("config/.claude.json"), root.join("agents/acme/webshop"));
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::create_dir_all(&clone).unwrap();
    std::fs::write(&file, text.replace("CLONE", &clone.to_string_lossy())).unwrap();
    Login { root, file, clone }
}

impl Login {
    fn text(&self) -> String {
        std::fs::read_to_string(&self.file).unwrap()
    }

    fn lock(&self) -> PathBuf {
        PathBuf::from(format!("{}.lock", self.file.display()))
    }

    fn leftovers(&self) -> Vec<String> {
        let mut found: Vec<String> = std::fs::read_dir(self.file.parent().unwrap()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        found.retain(|n| n != ".claude.json");
        found
    }

    async fn trust(&self) -> Result<bool, Refusal> {
        trust_with(&self.file, &self.clone, FAST).await
    }
}

fn entry(clone: &Path, flag: &str) -> String {
    format!(r#"{{"projects": {{"{}": {{"hasTrustDialogAccepted": {flag}}}}}}}"#, clone.display())
}

fn auth(dir: &Path) -> AuthStatus {
    AuthStatus { logged_in: true, config_directory: Some(dir.to_path_buf()), ..AuthStatus::default() }
}

#[test]
fn the_file_is_the_one_the_environment_names() {
    let home = scratch("env-home");
    let other = scratch("env-other");
    let env = |pairs: &[(&str, &Path)]| RunEnv::from_pairs(pairs.iter().map(|(k, v)| (k.to_string(), v.as_os_str().to_owned())));
    let usual = home.join(".claude");

    assert_eq!(config_file(&env(&[("HOME", &home)]), &auth(&usual)), Ok(home.join(".claude.json")));
    assert_eq!(config_file(&env(&[("HOME", &home), ("CLAUDE_CONFIG_DIR", &other)]), &auth(&other)), Ok(other.join(".claude.json")));
    assert_eq!(config_file(&env(&[("HOME", &home), ("CLAUDE_CONFIG_DIR", &usual)]), &auth(&usual)), Ok(usual.join(".claude.json")), "set on purpose to ~/.claude, the folder's own file");
    let empty = RunEnv::from_pairs([("HOME", home.as_os_str().to_owned()), ("CLAUDE_CONFIG_DIR", "".into())]);
    assert_eq!(config_file(&empty, &auth(&usual)), Ok(home.join(".claude.json")), "an empty variable reads as unset");
}

#[test]
fn a_custom_sign_in_address_or_ignored_trust_gives_no_file() {
    let home = scratch("env-none");
    for variable in ["CLAUDE_CODE_CUSTOM_OAUTH_URL", "CLAUDE_CODE_IGNORE_PERSISTED_TRUST"] {
        let env = RunEnv::from_pairs([("HOME", home.to_string_lossy().into_owned()), (variable, "1".into())]);
        assert_eq!(config_file(&env, &auth(&home.join(".claude"))), Err(Refusal::CantTell), "{variable}");
    }
}

#[test]
fn a_config_directory_that_disagrees_or_a_dot_config_json_gives_no_file() {
    let home = scratch("env-disagree");
    let env = RunEnv::from_pairs([("HOME", home.to_string_lossy().into_owned())]);
    assert_eq!(config_file(&env, &auth(&home.join(".claude-work"))), Err(Refusal::CantTell));
    assert_eq!(config_file(&env, &AuthStatus::default()), Err(Refusal::CantTell), "no configDirectory in the answer");
    assert_eq!(config_file(&RunEnv::from_pairs::<&str, &str>([]), &auth(&home.join(".claude"))), Err(Refusal::CantTell), "no HOME");
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    assert!(config_file(&env, &auth(&home.join(".claude"))).is_ok());
    std::fs::write(home.join(".claude/.config.json"), "{}").unwrap();
    assert_eq!(config_file(&env, &auth(&home.join(".claude"))), Err(Refusal::CantTell));
}

#[test]
fn reading_says_whether_the_entry_is_true_and_changes_nothing() {
    let l = login("read", "");
    let folder = &l.clone;
    let cases = [
        (entry(folder, "true"), Some(true)),
        (entry(folder, "false"), Some(false)),
        ("{}".to_string(), Some(false)),
        (r#"{"projects": {}}"#.to_string(), Some(false)),
        (r#"{"projects": {"/elsewhere": {"hasTrustDialogAccepted": true}}}"#.to_string(), Some(false)),
        ("[1]".to_string(), None),
        ("not json".to_string(), None),
        (r#"{"projects": []}"#.to_string(), None),
        (format!(r#"{{"projects": {{"{}": {{"hasTrustDialogAccepted": "yes"}}}}}}"#, folder.display()), None),
    ];
    for (text, expected) in cases {
        std::fs::write(&l.file, &text).unwrap();
        assert_eq!(trusted(&l.file, folder), expected, "{text}");
        assert_eq!(l.text(), text);
    }
    assert_eq!(trusted(&l.root.join("missing.json"), folder), None);
}

#[test]
fn a_trusted_folder_above_is_seen_apart_from_the_folders_own_entry() {
    let l = login("above", "");
    let text = format!(r#"{{"projects": {{"{}": {{"hasTrustDialogAccepted": true}}}}}}"#, l.root.join("agents").display());
    std::fs::write(&l.file, text).unwrap();
    assert_eq!((trusted(&l.file, &l.clone), trusted_above(&l.file, &l.clone)), (Some(false), true));
    std::fs::write(&l.file, entry(&l.clone, "false")).unwrap();
    assert!(!trusted_above(&l.file, &l.clone));
}

#[tokio::test]
async fn trusting_adds_one_entry_and_keeps_every_other_key_in_its_place() {
    let l = login("add", "{\n  \"numStartups\": 12,\n  \"tail\": {\"a\":   1}\n}");
    assert_eq!(l.trust().await, Ok(true));
    let expected = format!("{{\n  \"numStartups\": 12,\n  \"tail\": {{\"a\":   1}},\n  \"projects\": {{\n    \"{}\": {{\n      \"hasTrustDialogAccepted\": true\n    }}\n  }}\n}}", l.clone.display());
    assert_eq!(l.text(), expected);
    assert_eq!(trusted(&l.file, &l.clone), Some(true));
    assert!(l.leftovers().is_empty(), "{:?}", l.leftovers());
}

#[tokio::test]
async fn a_false_entry_turns_true_in_place_and_the_other_projects_keep_their_bytes() {
    let before = "{\n  \"first\": [1,2,   3],\n  \"projects\": {\n    \"/other\": {\"allowedTools\": [],   \"hasTrustDialogAccepted\": true},\n    \"CLONE\": {\n      \"history\": [ 1 ],\n      \"hasTrustDialogAccepted\": false,\n      \"last\": null\n    },\n    \"/after\": 7\n  },\n  \"last\": \"\\u00e9\"\n}\n";
    let l = login("flip", before);
    assert_eq!(l.trust().await, Ok(true));
    let after = l.text();
    let expected = before.replace("CLONE", &l.clone.to_string_lossy()).replace("\"hasTrustDialogAccepted\": false", "\"hasTrustDialogAccepted\": true");
    assert_eq!(after, expected);
}

#[tokio::test]
async fn an_entry_that_is_already_true_writes_nothing() {
    let l = login("already", "");
    std::fs::write(&l.file, entry(&l.clone, "true")).unwrap();
    let before = std::fs::metadata(&l.file).unwrap().modified().unwrap();
    assert_eq!(l.trust().await, Ok(false));
    assert_eq!(l.text(), entry(&l.clone, "true"));
    assert_eq!(std::fs::metadata(&l.file).unwrap().modified().unwrap(), before);
    assert!(!l.lock().exists());
}

#[tokio::test]
async fn the_files_mode_is_kept() {
    for mode in [0o600, 0o644] {
        let l = login(&format!("mode-{mode:o}"), "{}");
        std::fs::set_permissions(&l.file, std::fs::Permissions::from_mode(mode)).unwrap();
        assert_eq!(l.trust().await, Ok(true));
        assert_eq!(std::fs::metadata(&l.file).unwrap().permissions().mode() & 0o7777, mode);
    }
}

#[tokio::test]
async fn a_missing_file_a_link_or_a_file_over_the_limit_is_refused_and_left_alone() {
    let l = login("refuse-file", "{}");
    std::fs::remove_file(&l.file).unwrap();
    assert_eq!(l.trust().await, Err(Refusal::Missing));
    assert!(!l.file.exists());

    let real = l.root.join("dotfiles.json");
    std::fs::write(&real, "{}").unwrap();
    std::os::unix::fs::symlink(&real, &l.file).unwrap();
    assert_eq!(l.trust().await, Err(Refusal::UnsafeFile));
    assert_eq!(std::fs::read_to_string(&real).unwrap(), "{}");
    std::fs::remove_file(&l.file).unwrap();

    std::fs::write(&l.file, "{}").unwrap();
    std::fs::OpenOptions::new().write(true).open(&l.file).unwrap().set_len(LIMIT + 1).unwrap();
    assert_eq!(l.trust().await, Err(Refusal::UnsafeFile));
    assert!(!l.lock().exists());
}

#[tokio::test]
async fn each_wrong_shape_is_refused_with_the_file_and_the_lock_left_as_they_were() {
    let l = login("shapes", "");
    let key = l.clone.display().to_string();
    let shapes = [
        "[]".to_string(),
        "\"text\"".to_string(),
        "{".to_string(),
        r#"{"projects": null}"#.to_string(),
        r#"{"projects": [1]}"#.to_string(),
        format!(r#"{{"projects": {{"{key}": "trusted"}}}}"#),
        format!(r#"{{"projects": {{"{key}": null}}}}"#),
        format!(r#"{{"projects": {{"{key}": {{"hasTrustDialogAccepted": 1}}}}}}"#),
        format!(r#"{{"projects": {{"{key}": {{"hasTrustDialogAccepted": "true"}}}}}}"#),
    ];
    for text in shapes {
        std::fs::write(&l.file, &text).unwrap();
        assert_eq!(l.trust().await, Err(Refusal::UnsafeFile), "{text}");
        assert_eq!(l.text(), text);
        assert!(!l.lock().exists(), "{text}");
        assert!(l.leftovers().is_empty());
    }
}

#[tokio::test]
async fn a_lock_claude_holds_makes_it_wait_then_refuse_and_the_lock_is_left_alone() {
    let l = login("held", "{}");
    std::fs::create_dir(l.lock()).unwrap();
    let started = std::time::Instant::now();
    assert_eq!(l.trust().await, Err(Refusal::Busy));
    assert!(started.elapsed() >= FAST.give_up);
    assert!(l.lock().is_dir(), "a lock Gossamr didn't make is never removed");
    assert_eq!(l.text(), "{}");
    assert!(l.leftovers().iter().all(|n| n.ends_with(".lock")), "{:?}", l.leftovers());
}

#[tokio::test]
async fn it_waits_for_a_lock_that_is_let_go_and_then_writes() {
    let l = login("released", "{}");
    std::fs::create_dir(l.lock()).unwrap();
    let lock = l.lock();
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(20));
        std::fs::remove_dir(lock).unwrap();
    });
    assert_eq!(trust_with(&l.file, &l.clone, Timing { give_up: Duration::from_secs(10), ..FAST }).await, Ok(true));
    release.join().unwrap();
    assert!(!l.lock().exists());
}

/// Claude's own save, as the lock package and the settings writer do it: take the folder lock, read the file again, add
/// a key, write a temp file and rename it over the file.
fn claude_saves(file: &Path, key: &str, value: usize) {
    let lock = PathBuf::from(format!("{}.lock", file.display()));
    while std::fs::create_dir(&lock).is_err() {
        std::thread::sleep(Duration::from_millis(1));
    }
    let text = std::fs::read_to_string(file).unwrap();
    std::thread::sleep(Duration::from_millis(1));
    let end = text.rfind('}').unwrap();
    let next = format!("{},\n  \"{key}\": {value}\n}}", text[..end].trim_end());
    let temp = file.with_file_name(format!(".claude.json.tmp-{key}"));
    std::fs::write(&temp, next).unwrap();
    std::fs::rename(&temp, file).unwrap();
    std::fs::remove_dir(&lock).unwrap();
}

#[tokio::test]
async fn a_writer_using_the_same_lock_folder_never_loses_either_change() {
    const ROUNDS: usize = 25;
    let l = login("race", "{\n  \"numStartups\": 1\n}");
    let clones: Vec<PathBuf> = (0..ROUNDS).map(|n| l.root.join(format!("agents/acme/repo{n}"))).collect();
    clones.iter().for_each(|c| std::fs::create_dir_all(c).unwrap());
    let timing = Timing { give_up: Duration::from_secs(20), ..FAST };

    let file = l.file.clone();
    let claude = std::thread::spawn(move || (0..ROUNDS).for_each(|n| claude_saves(&file, &format!("claudeKey{n}"), n)));
    for clone in &clones {
        assert!(trust_with(&l.file, clone, timing).await.unwrap_or_else(|why| panic!("{why:?}")));
    }
    claude.join().unwrap();

    let saved: serde_json::Value = serde_json::from_str(&l.text()).unwrap();
    for (n, clone) in clones.iter().enumerate() {
        assert_eq!(saved["projects"][clone.to_str().unwrap()]["hasTrustDialogAccepted"], true, "clone {n}");
        assert_eq!(saved[format!("claudeKey{n}")], n, "Claude's key {n}");
    }
    assert!(!l.lock().exists());
}

#[tokio::test]
async fn two_trusts_at_once_for_one_file_both_land() {
    let l = login("pair", "{}");
    let second = l.root.join("agents/acme/other");
    std::fs::create_dir_all(&second).unwrap();
    let (a, b) = tokio::join!(trust_with(&l.file, &l.clone, FAST), trust_with(&l.file, &second, FAST));
    assert_eq!((a, b), (Ok(true), Ok(true)));
    assert_eq!((trusted(&l.file, &l.clone), trusted(&l.file, &second)), (Some(true), Some(true)));
}

#[tokio::test]
async fn an_entry_that_keeps_disappearing_is_tried_once_more_then_refused_with_the_lock_removed() {
    let before = entry(Path::new("/nowhere"), "true");
    let l = login("vanish", &before);
    let (file, stop) = (l.file.clone(), Arc::new(AtomicBool::new(false)));
    let flag = stop.clone();
    let stale = before.clone();
    let stomper = std::thread::spawn(move || {
        while !flag.load(Ordering::SeqCst) {
            let lock = PathBuf::from(format!("{}.lock", file.display()));
            if std::fs::create_dir(&lock).is_ok() {
                if std::fs::read_to_string(&file).unwrap().contains("webshop") {
                    std::fs::write(&file, &stale).unwrap();
                }
                std::fs::remove_dir(&lock).unwrap();
            }
            std::thread::sleep(Duration::from_micros(200));
        }
    });
    let timing = Timing { give_up: Duration::from_secs(5), confirm: Duration::from_millis(40), ..FAST };
    let outcome = trust_with(&l.file, &l.clone, timing).await;
    stop.store(true, Ordering::SeqCst);
    stomper.join().unwrap();
    assert_eq!(outcome, Err(Refusal::Busy));
    assert!(!l.lock().exists());
    assert!(l.leftovers().is_empty(), "{:?}", l.leftovers());
}

#[tokio::test]
async fn a_temp_file_a_crash_left_is_removed_and_other_files_are_not() {
    let l = login("stale", "{}");
    let dir = l.file.parent().unwrap();
    std::fs::write(dir.join(".claude.json.gossamr-0a1b2c"), "{\"apiKey\":\"x\"}").unwrap();
    std::fs::write(dir.join(".claude.json.backup"), "kept").unwrap();
    assert_eq!(l.trust().await, Ok(true));
    assert_eq!(l.leftovers(), vec![".claude.json.backup".to_string()]);

    std::fs::write(dir.join(".claude.json.gossamr-ffff"), "").unwrap();
    clean_folder(dir);
    assert_eq!(l.leftovers(), vec![".claude.json.backup".to_string()], "start-up clean-up removes them too");
}

#[test]
fn the_error_words_never_carry_anything_from_the_file() {
    for why in [Refusal::NotOurClone, Refusal::Missing, Refusal::UnsafeFile, Refusal::CantTell, Refusal::Busy] {
        let words = why.words("Claude personal");
        assert!(words.ends_with('.'), "{words}");
    }
    assert_eq!(Refusal::CantTell.words("Claude personal"), "Gossamr can't tell which settings file Claude personal uses. Trust it in Terminal.");
    assert_eq!(Refusal::Missing.words("Claude personal"), "Claude hasn't made its settings for Claude personal yet. Trust it in Terminal.");
}
