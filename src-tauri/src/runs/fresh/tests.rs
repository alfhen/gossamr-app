use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;

use super::*;
use crate::runs::env::RunEnv;
use crate::runs::repo::testing::wait_until_executable;

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
    fetch) echo fetched >> "$dir/.fetched" ;;
  esac
  exit 0
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
fn paths_and_commands_come_only_from_a_valid_repository_name() {
    let home = Path::new("/Users/me");
    assert_eq!(fresh_path(home, "acme/webshop"), Some(PathBuf::from("/Users/me/Gossamr/agents/acme/webshop")));
    for bad in ["", "acme", "acme/web/shop", "../etc/passwd", "acme/..", "./x", "-x/y", "acme/web shop", "acme/web;rm", "acme/\u{e5}", "/acme/webshop"] {
        assert_eq!(fresh_path(home, bad), None, "{bad:?}");
    }
    assert_eq!(clone_command("acme/webshop", Path::new("/Users/me/Gossamr/agents/acme/webshop")), "git clone https://github.com/acme/webshop.git /Users/me/Gossamr/agents/acme/webshop");
    assert!(clone_command("acme/webshop", Path::new("/Users/o'brien/G/agents/acme/webshop")).ends_with(r"'/Users/o'\''brien/G/agents/acme/webshop'"));
}

#[tokio::test]
async fn a_missing_copy_is_cloned_over_https_with_hooks_off_and_prompts_off_for_git_only() {
    let rig = Rig::new("clone");
    let path = ensure_clone(&rig.git("ok", None), &rig.home, "acme/webshop").await.unwrap();
    assert_eq!(path, agents_root(&rig.home).join("acme/webshop"));
    assert!(path.join(".git").is_dir());
    let log = rig.log();
    let command = format!("git -c core.hooksPath=/dev/null clone -- https://github.com/acme/webshop.git {}", path.display());
    assert_eq!(log.lines().next().unwrap(), command);
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
    assert_eq!(ensure_clone(&rig.git("broken", None), &rig.home, "acme/webshop").await.unwrap(), path);
    assert!(path.join(".fetched").exists());
    assert!(!rig.log().contains(" clone "), "{}", rig.log());
    assert!(rig.log().contains(&format!("-c core.hooksPath=/dev/null -C {} fetch --quiet origin", path.display())));
}

#[tokio::test]
async fn another_repository_or_a_plain_folder_at_the_path_is_refused_and_left_alone() {
    let rig = Rig::new("occupied");
    let path = agents_root(&rig.home).join("acme/webshop");
    std::fs::create_dir_all(path.join(".git")).unwrap();
    std::fs::write(path.join(".fake-origin"), "https://github.com/acme/other").unwrap();
    let git = rig.git("ok", None);
    assert!(matches!(ensure_clone(&git, &rig.home, "acme/webshop").await, Err(CloneError::Occupied { .. })));
    std::fs::remove_dir_all(path.join(".git")).unwrap();
    std::fs::write(path.join("notes.txt"), "mine").unwrap();
    assert!(matches!(ensure_clone(&git, &rig.home, "acme/webshop").await, Err(CloneError::Occupied { .. })));
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
    assert!(matches!(ensure_clone(&rig.git("ok", None), &rig.home, "acme/webshop").await, Err(CloneError::Occupied { .. })));
}

#[tokio::test]
async fn a_failed_clone_removes_the_folder_it_made_and_nothing_else() {
    let rig = Rig::new("cleanup");
    let sibling = agents_root(&rig.home).join("acme/other");
    std::fs::create_dir_all(&sibling).unwrap();
    let err = ensure_clone(&rig.git("broken", None), &rig.home, "acme/webshop").await.unwrap_err();
    assert_eq!(err, CloneError::Failed("fatal: unable to access: Could not resolve host".into()));
    assert!(!agents_root(&rig.home).join("acme/webshop").exists());
    assert!(sibling.exists());
}

#[tokio::test]
async fn a_credential_failure_falls_back_to_a_signed_in_gh_with_hooks_off() {
    let rig = Rig::new("gh");
    let path = ensure_clone(&rig.git("auth", Some("signed-in")), &rig.home, "acme/webshop").await.unwrap();
    assert!(path.join(".git").is_dir(), "the half-made folder from git is replaced by gh's clone");
    let log = rig.log();
    assert!(log.contains(&format!("gh repo clone acme/webshop {}", path.display())), "{log}");
    assert!(log.contains("gh env GIT_TERMINAL_PROMPT=0 hooks=core.hooksPath=/dev/null"), "{log}");
}

#[tokio::test]
async fn without_a_usable_gh_a_credential_failure_says_what_git_said_and_leaves_nothing() {
    let rig = Rig::new("noauth");
    let want = CloneError::Auth("fatal: could not read Username for 'https://github.com': terminal prompts disabled".into());
    for gh in [None, Some("signed-out")] {
        assert_eq!(ensure_clone(&rig.git("auth", gh), &rig.home, "acme/webshop").await.unwrap_err(), want);
        assert!(!agents_root(&rig.home).join("acme/webshop").exists());
    }
    assert!(!rig.log().contains("repo clone"));
}

#[tokio::test]
async fn gh_failing_too_is_reported_and_cleaned_up_but_other_failures_never_try_gh() {
    let rig = Rig::new("ghfail");
    let git = rig.git("auth", Some("signed-in-broken"));
    assert_eq!(ensure_clone(&git, &rig.home, "acme/webshop").await.unwrap_err(), CloneError::Auth("gh: clone failed".into()));
    assert!(!agents_root(&rig.home).join("acme/webshop").exists());

    let rig = Rig::new("nogh");
    assert!(matches!(ensure_clone(&rig.git("broken", Some("signed-in")), &rig.home, "acme/webshop").await, Err(CloneError::Failed(_))));
    assert!(!rig.log().contains("gh "), "a network failure isn't a sign-in problem");
}

#[tokio::test]
async fn names_that_could_leave_the_folder_are_refused_before_anything_is_made() {
    let rig = Rig::new("hostile");
    let git = rig.git("ok", None);
    for bad in ["../evil/x", "acme/..", "a/b/c", "acme", "-c/x", "acme/web;touch"] {
        assert_eq!(ensure_clone(&git, &rig.home, bad).await.unwrap_err(), CloneError::Invalid(bad.into()));
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
    assert!(matches!(ensure_clone(&rig.git("ok", None), &rig.home, "acme/webshop").await, Err(CloneError::Failed(_))));
    assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
    assert!(!rig.log().contains(" clone "));
}
