//! Reading Gossamr's clones, and names for new worktrees.
//!
//! Git is only read here. Every call runs with the settings that could run a program switched off, the captured shell
//! environment and a time limit, because a clone's own config can be changed by the agents working in it.

use std::collections::HashSet;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::process::Command;

use super::env::RunEnv;

/// How long one git command may take. The app runs them one repository at a time, where 5 seconds is generous; the test
/// suite runs hundreds of tests at once on a loaded CI runner, where a plain `git remote get-url` has taken longer, so tests wait
/// longer rather than fail on the machine's load.
const GIT_TIMEOUT: Duration = if cfg!(test) { Duration::from_secs(30) } else { Duration::from_secs(5) };
const WORD_LIMIT: usize = 16;

/// Switches off what a repository's own config could use to run a program, on every call Gossamr makes in a clone.
pub(super) const PINNED: [&str; 6] = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never"];

#[derive(Clone)]
pub struct Git {
    program: PathBuf,
    env: Arc<RunEnv>,
}

impl Git {
    pub fn new(env: Arc<RunEnv>) -> Self {
        let program = find_in_path(&env, "git").unwrap_or_else(|| PathBuf::from("/usr/bin/git"));
        Self { program, env }
    }

    /// Trimmed stdout, or `None` when git fails, times out or can't start.
    async fn out(&self, dir: &Path, args: &[&str]) -> Option<String> {
        self.out_or_why(dir, args).await.ok()
    }

    /// Like `out`, but says why it failed: git couldn't start, ran past the limit, or exited with this last stderr line.
    async fn out_or_why(&self, dir: &Path, args: &[&str]) -> Result<String, String> {
        let mut cmd = Command::new(&self.program);
        cmd.args(PINNED).arg("-C").arg(dir).arg("--no-optional-locks").args(args);
        self.env.apply(cmd.as_std_mut());
        let child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).spawn().map_err(|e| format!("{} didn't start: {e}", self.program.display()))?;
        let out = tokio::time::timeout(GIT_TIMEOUT, child.wait_with_output())
            .await
            .map_err(|_| format!("git took longer than {} seconds", GIT_TIMEOUT.as_secs()))?
            .map_err(|e| format!("git couldn't be waited for: {e}"))?;
        if out.status.success() {
            return Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned());
        }
        let stderr = String::from_utf8_lossy(&out.stderr);
        let last = stderr.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("no message");
        Err(format!("git {}: {last}", out.status))
    }

    pub async fn origin(&self, dir: &Path) -> Option<String> {
        self.origin_or_why(dir).await.ok()
    }

    pub async fn origin_or_why(&self, dir: &Path) -> Result<String, String> {
        self.out_or_why(dir, &["remote", "get-url", "origin"]).await
    }

    pub(super) fn git_program(&self) -> &Path {
        &self.program
    }

    /// A program on the captured PATH, such as `gh`.
    pub(super) fn tool(&self, name: &str) -> Option<PathBuf> {
        find_in_path(&self.env, name)
    }

    /// Runs `program` with the captured environment plus `extra` (for this process only) and a time limit. The error
    /// is the last line of stderr.
    pub(super) async fn run(&self, program: &Path, args: impl IntoIterator<Item = impl AsRef<std::ffi::OsStr>>, extra: &[(&str, &str)], limit: Duration) -> Result<(), String> {
        self.run_stdout(program, args, extra, limit).await.map(drop)
    }

    /// `run`, with what the program printed.
    pub(super) async fn run_stdout(&self, program: &Path, args: impl IntoIterator<Item = impl AsRef<std::ffi::OsStr>>, extra: &[(&str, &str)], limit: Duration) -> Result<String, String> {
        let mut cmd = Command::new(program);
        cmd.args(args);
        self.env.apply(cmd.as_std_mut());
        cmd.envs(extra.iter().copied());
        let child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).spawn().map_err(|e| e.to_string())?;
        let out = tokio::time::timeout(limit, child.wait_with_output())
            .await
            .map_err(|_| format!("took longer than {} seconds", limit.as_secs()))?
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned());
        }
        let stderr = String::from_utf8_lossy(&out.stderr);
        Err(stderr.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("it exited without a message").to_owned())
    }

    /// What `origin/HEAD` points at in the clone, when it knows.
    pub async fn default_branch(&self, clone: &Path) -> Option<String> {
        let name = self.out(clone, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).await?;
        Some(name.strip_prefix("origin/").unwrap_or(&name).to_owned()).filter(|b| !b.is_empty())
    }

    /// The names, never the values, of the settings in the clone's own `.git/config`. They are read NUL-separated and
    /// by name only, so text inside a value can never be taken for a name.
    pub async fn local_config_keys(&self, clone: &Path) -> Option<Vec<String>> {
        let list = self.out(clone, &["config", "--local", "--list", "--name-only", "-z"]).await?;
        Some(list.split('\0').filter(|k| !k.is_empty()).map(str::to_owned).collect())
    }

    /// Every value `key` has in the clone's own `.git/config`; none when it is unset.
    pub async fn local_config_values(&self, clone: &Path, key: &str) -> Vec<String> {
        let list = self.out(clone, &["config", "--local", "--get-all", key]).await.unwrap_or_default();
        list.lines().map(str::to_owned).collect()
    }
}

fn find_in_path(env: &RunEnv, program: &str) -> Option<PathBuf> {
    let path = env.get("PATH")?.to_str()?;
    path.split(':')
        .map(|dir| Path::new(dir).join(program))
        .find(|p| p.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
}

/// Whether a remote URL names `repo` (`owner/name`) on GitHub, over https or ssh, with or without `.git`.
pub fn origin_matches(url: &str, repo: &str) -> bool {
    let url = url.trim();
    let Some((before, after)) = url.split_once("github.com") else { return false };
    if !(before.is_empty() || before.ends_with('/') || before.ends_with('@')) {
        return false;
    }
    let Some(path) = after.strip_prefix(':').or_else(|| after.strip_prefix('/')) else { return false };
    let path = match path.split_once('/') {
        Some((port, rest)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) && after.starts_with(':') => rest,
        _ => path,
    };
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let parts: Vec<&str> = path.split('/').collect();
    let want: Vec<&str> = repo.split('/').collect();
    parts.len() == 2 && want.len() == 2 && parts.iter().zip(&want).all(|(a, b)| !a.is_empty() && a.eq_ignore_ascii_case(b))
}

/// Worktree folder names and `worktree-*` branches already in the clone. A branch left behind by a removed worktree
/// would otherwise be reused at its old commit.
pub async fn existing_names(git: &Git, clone: &Path) -> HashSet<String> {
    let mut names = HashSet::new();
    if let Some(list) = git.out(clone, &["worktree", "list", "--porcelain"]).await {
        names.extend(
            list.lines()
                .filter_map(|l| l.strip_prefix("worktree "))
                .filter_map(|p| Path::new(p).file_name())
                .map(|n| n.to_string_lossy().into_owned()),
        );
    }
    if let Some(list) = git.out(clone, &["branch", "--list", "worktree-*", "--format=%(refname:short)"]).await {
        names.extend(list.lines().filter_map(|b| b.trim().strip_prefix("worktree-")).map(str::to_owned));
    }
    names
}

fn words(text: &str, limit: usize) -> Vec<String> {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .take(limit)
        .map(|w| w.to_ascii_lowercase().chars().take(WORD_LIMIT).collect())
        .collect()
}

pub(super) fn random_hex(digits: usize) -> String {
    let mut bytes = vec![0u8; digits.div_ceil(2)];
    // Without randomness the name falls back to a clock-derived value; the collision check still applies.
    if getrandom::fill(&mut bytes).is_err() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos());
        bytes.iter_mut().enumerate().for_each(|(i, b)| *b = (nanos >> (i % 4 * 8)) as u8);
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect::<String>().chars().take(digits).collect()
}

/// `<key>-<up to three words of the title>-<4 hex>`, made of `[a-z0-9-]` and not in `existing`.
pub fn new_name(key: &str, title: &str, existing: &HashSet<String>) -> String {
    let mut stem = words(key, 2);
    stem.extend(words(title, 3));
    let stem = stem.join("-");
    for attempt in 0.. {
        let digits = if attempt < 20 { 4 } else { 8 };
        let name = if stem.is_empty() { format!("agent-{}", random_hex(digits)) } else { format!("{stem}-{}", random_hex(digits)) };
        if !existing.contains(&name) {
            return name;
        }
    }
    unreachable!("the loop only ends by returning")
}

#[cfg(test)]
pub(crate) mod testing {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    /// A `git` that answers from `.fake-*` files in the directory it is given with `-C`, and logs every call.
    pub const FAKE_GIT: &str = r#"#!/bin/sh
[ -n "$FAKE_GIT_LOG" ] && echo "$*" >> "$FAKE_GIT_LOG"
while [ "$1" = -c ]; do shift 2; done
if [ "$1" = clone ]; then
  for last; do :; done
  parent=$(dirname "$last")
  [ -f "$parent/.slow" ] && sleep 1
  if [ -f "$parent/.clone-fails" ]; then mkdir -p "$last/.git"; echo "fatal: unable to access: Could not resolve host" >&2; exit 128; fi
  mkdir -p "$last/.git" && echo "$3" > "$last/.fake-origin"
  exit 0
fi
dir=.
[ "$1" = -C ] && { dir=$2; shift 2; }
[ "$1" = --no-optional-locks ] && shift
case "$*" in
  "remote get-url origin") cat "$dir/.fake-origin" 2>/dev/null || exit 2 ;;
  "rev-parse --abbrev-ref HEAD") cat "$dir/.fake-branch" 2>/dev/null || echo main ;;
  "status --porcelain") cat "$dir/.fake-dirty" 2>/dev/null ;;
  "symbolic-ref --short refs/remotes/origin/HEAD") echo origin/main ;;
  "fetch --prune --quiet origin +refs/heads/*:refs/remotes/origin/*") [ ! -f "$dir/.fake-fetch-fails" ] || { echo "fatal: unable to access: Could not resolve host" >&2; exit 128; } ;;
  "ls-remote --symref -- "*) printf 'ref: refs/heads/main\tHEAD\nabc\tHEAD\n' ;;
  "config --local --list --name-only -z") sed 's/=.*//' "$dir/.fake-config" 2>/dev/null | tr '\n' '\0' ;;
  "config --local --get-all "*) sed -n "s/^$4=//p" "$dir/.fake-config" 2>/dev/null; true ;;
  "worktree list --porcelain") cat "$dir/.fake-worktrees" 2>/dev/null ;;
  "branch --list worktree-* --format=%(refname:short)") cat "$dir/.fake-branches" 2>/dev/null ;;
  *) echo "unexpected git call: $*" >&2; exit 99 ;;
esac
"#;

    pub fn install_fake_git(dir: &Path) -> PathBuf {
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let path = bin.join("git");
        std::fs::write(&path, FAKE_GIT).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        wait_until_executable(&path);
        bin
    }

    /// A thread that forks while the script is open for writing keeps that handle until it execs, and running the
    /// script meanwhile fails with ETXTBSY. Try it until it runs.
    pub(crate) fn wait_until_executable(path: &Path) {
        for _ in 0..500 {
            match std::process::Command::new(path).arg("--version").output() {
                Err(e) if e.raw_os_error() == Some(26) => std::thread::sleep(std::time::Duration::from_millis(10)),
                _ => return,
            }
        }
        panic!("{} is still busy for writing after 5 s", path.display());
    }

    pub fn fake_git(dir: &Path) -> Git {
        let bin = install_fake_git(dir);
        let env = RunEnv::from_pairs([
            ("PATH", format!("{}:/usr/bin:/bin", bin.display())),
            ("FAKE_GIT_LOG", dir.join("git.log").to_string_lossy().into_owned()),
        ]);
        Git::new(Arc::new(env))
    }

    /// A folder with `.git` that the fake git reports as a clone of `origin`.
    pub fn clone_with_origin(path: &Path, origin: &str) {
        std::fs::create_dir_all(path.join(".git")).unwrap();
        std::fs::write(path.join(".fake-origin"), origin).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gossamr-runs-repo-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn origin_urls_match_in_every_common_form_and_nothing_else() {
        for url in [
            "https://github.com/acme/webshop",
            "https://github.com/acme/webshop.git",
            "https://github.com/Acme/WebShop.git/",
            "https://x-access-token:abc@github.com/acme/webshop.git",
            "git@github.com:acme/webshop.git",
            "git@github.com:acme/webshop",
            "ssh://git@github.com/acme/webshop.git",
            "ssh://git@github.com:22/acme/webshop.git",
            "  https://github.com/acme/webshop\n",
        ] {
            assert!(origin_matches(url, "acme/webshop"), "{url}");
        }
        for url in [
            "",
            "https://github.com/acme/other",
            "https://github.com/acme/webshop-extra",
            "https://github.com/other/webshop",
            "https://notgithub.com/acme/webshop",
            "https://github.com.evil.example/acme/webshop",
            "https://gitlab.com/acme/webshop",
            "https://github.com/acme/webshop/extra",
            "https://github.com/acme",
            "/Users/me/Code/webshop",
        ] {
            assert!(!origin_matches(url, "acme/webshop"), "{url}");
        }
    }

    #[tokio::test]
    async fn the_default_branch_and_config_keys_come_from_the_clone_with_unsafe_settings_pinned_off() {
        let dir = scratch("read");
        let git = fake_git(&dir);
        let clone = dir.join("webshop");
        clone_with_origin(&clone, "https://github.com/acme/webshop.git");
        std::fs::write(clone.join(".fake-config"), "core.filemode=true\nremote.origin.url=https://github.com/acme/webshop.git\n").unwrap();
        assert_eq!(git.default_branch(&clone).await.as_deref(), Some("main"));
        assert_eq!(git.local_config_keys(&clone).await.unwrap(), ["core.filemode", "remote.origin.url"]);
        let log = std::fs::read_to_string(dir.join("git.log")).unwrap();
        let pinned = PINNED.join(" ");
        assert!(log.lines().all(|l| l.starts_with(&format!("{pinned} -C ")) && l.contains(" --no-optional-locks ")), "{log}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_git_that_is_missing_reads_nothing() {
        let gone = Git::new(Arc::new(RunEnv::from_pairs([("PATH", "/nonexistent")])));
        assert!(gone.default_branch(Path::new("/tmp")).await.is_none());
    }

    #[tokio::test]
    async fn existing_names_come_from_worktrees_and_leftover_branches() {
        let dir = scratch("names");
        let git = fake_git(&dir);
        let clone = dir.join("webshop");
        clone_with_origin(&clone, "https://github.com/acme/webshop");
        std::fs::write(clone.join(".fake-worktrees"), format!("worktree {0}\nHEAD abc\n\nworktree {0}/.claude/worktrees/eng-1-a-0001\nHEAD def\n", clone.display())).unwrap();
        std::fs::write(clone.join(".fake-branches"), "worktree-eng-2-b-0002\nworktree-eng-1-a-0001\n").unwrap();
        let names = existing_names(&git, &clone).await;
        assert_eq!(names, ["webshop", "eng-1-a-0001", "eng-2-b-0002"].map(String::from).into());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn names_are_key_words_and_four_hex_in_the_allowed_alphabet() {
        let none = HashSet::new();
        let valid = |n: &str| (3..=70).contains(&n.len()) && !n.starts_with('-') && n.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        let name = new_name("ENG-12", "Fix the cart total on checkout page", &none);
        assert!(name.starts_with("eng-12-fix-the-cart-"), "{name}");
        let hex = name.rsplit('-').next().unwrap();
        assert!(hex.len() == 4 && hex.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "{name}");
        for (key, title) in [("", ""), ("ENG-1", "Überraschung: \"quotes\" && $(rm -rf /) `x` ../../etc"), ("  ", "---"), ("A".repeat(200).as_str(), "word ".repeat(40).as_str()), ("ENG-1", "日本語のタイトル")] {
            let n = new_name(key, title, &none);
            assert!(valid(&n), "{n:?}");
        }
    }

    #[test]
    fn a_taken_name_is_never_returned() {
        let first = new_name("ENG-1", "x", &HashSet::new());
        let mut taken = HashSet::new();
        taken.insert(first);
        for _ in 0..200 {
            let n = new_name("ENG-1", "x", &taken);
            assert!(!taken.contains(&n));
            taken.insert(n);
        }
        assert!(taken.len() > 200);
    }
}
