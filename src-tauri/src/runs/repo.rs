//! Reading Gossamr's clones, and names for new worktrees.
//!
//! Git is read here, and writes only to remove a finished run's worktree and branch. Every call runs with the settings that could run a program switched off, the captured shell
//! environment and a time limit, because a clone's own config can be changed by the agents working in it.

use std::collections::HashSet;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::process::Command;

use super::env::RunEnv;
use super::archive::contained;
use super::fresh::{agents_root, is_work_path, newest_clone_per_owner, real};
use super::limits::{OwnerAddress, WorkFolderGit};
use crate::domain::Run;

/// How long one git command may take. The app runs them one repository at a time, where 5 seconds is generous; the test
/// suite runs hundreds of tests at once on a loaded CI runner, where a plain `git remote get-url` has taken longer, so tests wait
/// longer rather than fail on the machine's load.
const GIT_TIMEOUT: Duration = if cfg!(test) { Duration::from_secs(30) } else { Duration::from_secs(5) };
/// `git worktree remove` and `git branch -d` write. Killing one partway leaves a half-deleted worktree that git then refuses to remove.
const GIT_WRITE_TIMEOUT: Duration = Duration::from_secs(120);
const WORD_LIMIT: usize = 16;
const CONFIG_VALUE_LIMIT: usize = 200;
/// How many owners' folders Settings reads an address in.
const OWNERS_SHOWN: usize = 6;

/// Who git commits as in a folder. Either part is `None` when git has no setting for it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommitIdentity {
    pub email: Option<String>,
    pub signing_key: Option<String>,
}

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
        self.out_or_why_within(dir, args, GIT_TIMEOUT).await
    }

    async fn out_or_why_within(&self, dir: &Path, args: &[&str], limit: Duration) -> Result<String, String> {
        let mut cmd = Command::new(&self.program);
        cmd.args(PINNED).arg("-C").arg(dir).arg("--no-optional-locks").args(args);
        self.env.apply(cmd.as_std_mut());
        let child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).spawn().map_err(|e| format!("{} didn't start: {e}", self.program.display()))?;
        let out = tokio::time::timeout(limit, child.wait_with_output())
            .await
            .map_err(|_| format!("git took longer than {} seconds", limit.as_secs()))?
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

    /// Removes a linked worktree the way `git worktree remove` does without `--force`: git refuses one with changes
    /// that were never committed, or that is locked. A worktree folder that is already gone is only forgotten.
    pub async fn remove_worktree(&self, clone: &Path, worktree: &Path) -> Result<(), String> {
        if worktree.symlink_metadata().is_err() {
            return self.out_or_why(clone, &["worktree", "prune"]).await.map(drop);
        }
        let path = worktree.to_string_lossy();
        self.out_or_why_within(clone, &["worktree", "remove", "--", &path], GIT_WRITE_TIMEOUT).await.map(drop)
    }

    /// Makes the worktree at `worktree` on a new `branch` from `start`. Refuses a folder or a branch that exists, except
    /// the worktree of an earlier try at this launch: that one is on `branch`, still at `start`, with nothing changed.
    pub async fn add_worktree(&self, clone: &Path, worktree: &Path, branch: &str, start: &str) -> Result<(), String> {
        let folder = worktree.symlink_metadata().is_ok();
        let branch_there = self.branch_exists(clone, branch).await?;
        if folder || branch_there {
            return if folder && branch_there && self.is_untouched_worktree(clone, worktree, branch, start).await { Ok(()) } else { Err(format!("{} or the branch '{branch}' is already there", worktree.display())) };
        }
        let path = worktree.to_string_lossy();
        self.out_or_why_within(clone, &["worktree", "add", "--no-track", "-b", branch, "--", &path, start], GIT_WRITE_TIMEOUT).await.map(drop)
    }

    async fn is_untouched_worktree(&self, clone: &Path, worktree: &Path, branch: &str, start: &str) -> bool {
        let listed = self.out(clone, &["worktree", "list", "--porcelain"]).await.unwrap_or_default();
        let here = listed.split("\n\n").any(|entry| {
            entry.lines().any(|l| l.strip_prefix("worktree ").is_some_and(|p| super::fresh::real(Path::new(p)) == super::fresh::real(worktree)))
                && entry.lines().any(|l| l.strip_prefix("branch ").is_some_and(|b| b == format!("refs/heads/{branch}")))
        });
        here && self.at_start(clone, branch, start).await && self.out(worktree, &["status", "--porcelain"]).await.is_some_and(|s| s.is_empty())
    }

    async fn at_start(&self, clone: &Path, branch: &str, start: &str) -> bool {
        let tip = self.out(clone, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).await;
        tip.is_some() && tip == self.out(clone, &["rev-parse", "--verify", "--quiet", &format!("{start}^{{commit}}")]).await
    }

    /// Removes a worktree made by `add_worktree` and its branch, when nothing was committed or changed in it. Does
    /// nothing otherwise, so work is never lost.
    pub async fn discard_untouched_worktree(&self, clone: &Path, worktree: &Path, branch: &str, start: &str) {
        if !self.is_untouched_worktree(clone, worktree, branch, start).await {
            return;
        }
        let local = format!("refs/heads/{branch}");
        let Some(tip) = self.out(clone, &["rev-parse", "--verify", "--quiet", &local]).await else { return };
        if self.remove_worktree(clone, worktree).await.is_ok() {
            // Given the tip, git deletes the branch only while it is still the one this launch made.
            let _ = self.out_or_why_within(clone, &["update-ref", "-d", &local, &tip], GIT_WRITE_TIMEOUT).await;
        }
    }

    async fn branch_exists(&self, clone: &Path, branch: &str) -> Result<bool, String> {
        let found = self.out_or_why(clone, &["branch", "--list", "--format=%(refname:short)", "--", branch]).await?;
        Ok(!found.trim().is_empty())
    }

    /// Whether `git branch -d` would take the branch, asked before the worktree goes so a refusal leaves both in place.
    /// Like `-d`, a branch counts as merged when it is in its upstream, or in HEAD when it has none.
    pub async fn check_branch_deletable(&self, clone: &Path, branch: &str) -> Result<(), String> {
        if !self.branch_exists(clone, branch).await? {
            return Ok(());
        }
        let local = format!("refs/heads/{branch}");
        let upstream = format!("{local}@{{upstream}}");
        let into = if self.out(clone, &["rev-parse", "--verify", "--quiet", &upstream]).await.is_some() { upstream } else { "HEAD".to_owned() };
        match self.out_or_why(clone, &["merge-base", "--is-ancestor", &local, &into]).await {
            Ok(_) => Ok(()),
            Err(_) => Err(format!("git: the branch '{branch}' is not fully merged")),
        }
    }

    /// `git branch -d`, never `-D`: git keeps a branch with commits that are neither merged nor on its upstream.
    /// A branch that isn't there counts as removed.
    pub async fn delete_branch(&self, clone: &Path, branch: &str) -> Result<(), String> {
        if !self.branch_exists(clone, branch).await? {
            return Ok(());
        }
        self.out_or_why_within(clone, &["branch", "-d", "--", branch], GIT_WRITE_TIMEOUT).await.map(drop)
    }

    /// What `origin/HEAD` points at in the clone, when it knows.
    pub async fn default_branch(&self, clone: &Path) -> Option<String> {
        let name = self.out(clone, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).await?;
        Some(name.strip_prefix("origin/").unwrap_or(&name).to_owned()).filter(|b| !b.is_empty())
    }

    /// Who git commits as in the work folder under `home`, and whether the person's git settings pick that by folder.
    /// `includeIf` rules apply only inside a repository, so the address is read inside the newest clone of each owner,
    /// never at the folder itself or in `~`. None when git can't be run.
    pub async fn work_folder_git(&self, home: &Path) -> Option<WorkFolderGit> {
        if !self.runs(home).await {
            return None;
        }
        let global_email = self.global_email().await;
        let mut owners = Vec::new();
        for (owner, clone) in newest_clone_per_owner(&agents_root(home)).into_iter().take(OWNERS_SHOWN) {
            owners.push(OwnerAddress { owner, commit_email: self.commit_email(&clone).await });
        }
        let include_if = self.picks_settings_by_folder(home).await && owners.iter().all(|o| o.commit_email == global_email);
        Some(WorkFolderGit { global_email, owners, include_if })
    }

    /// The address and signing key git would commit with in `dir`: the local settings first, then the global ones the
    /// folder's `includeIf` rules choose. Reading them runs no program.
    pub async fn commit_identity(&self, dir: &Path) -> CommitIdentity {
        CommitIdentity { email: self.config_value(dir, &["user.email"]).await, signing_key: self.config_value(dir, &["user.signingkey"]).await }
    }

    /// The address git would commit with in the repository at `dir`.
    pub async fn commit_email(&self, dir: &Path) -> Option<String> {
        self.config_value(dir, &["user.email"]).await
    }

    /// The address in the person's global git settings, which `includeIf` rules can override inside a repository.
    pub async fn global_email(&self) -> Option<String> {
        // `--global` turns `[include]` off unless `--includes` is given. The root has no repository, so no `includeIf` rule applies.
        self.config_value(Path::new("/"), &["--global", "--includes", "user.email"]).await
    }

    /// Whether git runs at all, so a missing address can be told from a git that couldn't be asked.
    pub async fn runs(&self, dir: &Path) -> bool {
        self.out(dir, &["version"]).await.is_some()
    }

    /// Whether `~/.gitconfig` has `includeIf "gitdir:…"` rules, which pick settings by the folder a repository is in.
    /// `dir` is any existing folder.
    pub async fn picks_settings_by_folder(&self, dir: &Path) -> bool {
        self.out(dir, &["config", "--global", "--get-regexp", "^includeif\\.gitdir"]).await.is_some_and(|rules| !rules.is_empty())
    }

    async fn config_value(&self, dir: &Path, args: &[&str]) -> Option<String> {
        let value = self.out(dir, &[&["config", "--get"], args].concat()).await?;
        let value: String = value.chars().filter(|c| !c.is_control()).take(CONFIG_VALUE_LIMIT).collect();
        Some(value).filter(|v| !v.is_empty())
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

/// Removes a run's worktree and branch through git alone. Anything git refuses stays, in git's own words, as `Ok(Some)`.
/// The clone and the worktree must lie in `~/Gossamr/agents`; otherwise the refusal is the `Err`.
pub async fn remove_with_git(git: &Git, home: Option<&Path>, run: &Run) -> Result<Option<String>, String> {
    let home = home.ok_or("Gossamr doesn't know your home folder.")?;
    let clone = &run.spec.clone_path;
    let in_work_folder = contained(&agents_root(home), clone).is_some() || is_work_path(home, &run.spec.repo, clone);
    if !in_work_folder {
        return Err("Its clone isn't in ~/Gossamr/agents, so Gossamr leaves it where it is.".into());
    }
    let outside = || "Its worktree isn't in ~/Gossamr/agents, so Gossamr leaves it where it is.".to_owned();
    let worktree = if run.expected_worktree.symlink_metadata().is_ok() {
        contained(&agents_root(home), &run.expected_worktree).ok_or_else(outside)?
    } else {
        let missing = real(&run.expected_worktree);
        if !missing.starts_with(real(&agents_root(home))) {
            return Err(outside());
        }
        missing
    };
    let branch = run.branch.clone().unwrap_or_else(|| format!("worktree-{}", run.spec.name));
    if let Err(message) = git.check_branch_deletable(clone, &branch).await {
        return Ok(Some(message));
    }
    if let Err(message) = git.remove_worktree(clone, &worktree).await {
        return Ok(Some(message));
    }
    Ok(git.delete_branch(clone, &branch).await.err())
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
  "config --get user.email") cat "$dir/.fake-email" 2>/dev/null || exit 1 ;;
  "config --get user.signingkey") cat "$dir/.fake-signingkey" 2>/dev/null || exit 1 ;;
  "config --get --global --includes user.email") cat "$(dirname "$FAKE_GIT_LOG")/.fake-global-email" 2>/dev/null || exit 1 ;;
  "version") echo "git version 2.0" ;;
  "config --global --get-regexp ^includeif\\.gitdir") cat "$dir/.fake-includeif" 2>/dev/null || exit 1 ;;
  "config --local --list --name-only -z") sed 's/=.*//' "$dir/.fake-config" 2>/dev/null | tr '\n' '\0' ;;
  "config --local --get-all "*) sed -n "s/^$4=//p" "$dir/.fake-config" 2>/dev/null; true ;;
  "worktree list --porcelain") cat "$dir/.fake-worktrees" 2>/dev/null ;;
  "branch --list worktree-* --format=%(refname:short)") cat "$dir/.fake-branches" 2>/dev/null ;;
  "worktree prune") ;;
  "worktree remove -- "*) [ ! -f "$dir/.fake-worktree-dirty" ] || { echo "fatal: '$4' contains modified or untracked files, use --force to delete it" >&2; exit 128; }; rm -rf "$4" ;;
  "branch --list --format=%(refname:short) -- "*) cat "$dir/.fake-branches" 2>/dev/null | grep -Fx -- "$5"; true ;;
  "rev-parse --verify --quiet "*) exit 1 ;;
  "merge-base --is-ancestor "*) [ ! -f "$dir/.fake-branch-unmerged" ] || exit 1 ;;
  "branch -d -- "*) [ ! -f "$dir/.fake-branch-unmerged" ] || { echo "error: the branch '$4' is not fully merged." >&2; exit 1; } ;;
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

    fn git_in(home: &Path) -> Git {
        let env = RunEnv::from_pairs([
            ("PATH", "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin".to_string()),
            ("HOME", home.display().to_string()),
            ("GIT_CONFIG_GLOBAL", home.join(".gitconfig").display().to_string()),
            ("GIT_CONFIG_NOSYSTEM", "1".into()),
        ]);
        Git::new(Arc::new(env))
    }

    fn init(path: &Path) {
        std::fs::create_dir_all(path).unwrap();
        let ok = std::process::Command::new("git").args(["init", "--quiet"]).arg(path).env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1").status().unwrap().success();
        assert!(ok);
    }

    #[tokio::test]
    async fn the_commit_address_is_read_inside_the_clone_so_a_rule_for_code_does_not_reach_it() {
        let home = scratch("identity");
        std::fs::write(home.join("code.gitconfig"), "[user]\n\temail = alf@code.example\n\tsigningkey = CODEKEY\n").unwrap();
        std::fs::write(
            home.join(".gitconfig"),
            format!("[user]\n\temail = alf@global.example\n[includeIf \"gitdir:{}/Code/\"]\n\tpath = {}/code.gitconfig\n", home.display(), home.display()),
        )
        .unwrap();
        let (own, gossamrs) = (home.join("Code/webshop"), home.join("Gossamr/agents/acme/webshop"));
        init(&own);
        init(&gossamrs);
        let git = git_in(&home);
        let in_code = git.commit_identity(&own).await;
        assert_eq!((in_code.email.as_deref(), in_code.signing_key.as_deref()), (Some("alf@code.example"), Some("CODEKEY")), "the rule is in effect in ~/Code");
        let here = git.commit_identity(&gossamrs).await;
        assert_eq!((here.email.as_deref(), here.signing_key), (Some("alf@global.example"), None));
        let _ = std::fs::remove_dir_all(home);
    }

    #[tokio::test]
    async fn a_setting_in_the_clone_itself_decides_the_commit_address() {
        let home = scratch("identity-local");
        std::fs::write(home.join(".gitconfig"), "[user]\n\temail = alf@global.example\n").unwrap();
        let clone = home.join("Gossamr/agents/acme/webshop");
        init(&clone);
        std::fs::write(clone.join(".git/config"), format!("{}[user]\n\temail = alf@clone.example\n", std::fs::read_to_string(clone.join(".git/config")).unwrap())).unwrap();
        assert_eq!(git_in(&home).commit_identity(&clone).await.email.as_deref(), Some("alf@clone.example"));
        let _ = std::fs::remove_dir_all(home);
    }

    #[tokio::test]
    async fn no_address_in_git_settings_gives_none_and_a_long_value_is_cut() {
        let home = scratch("identity-none");
        let clone = home.join("clone");
        init(&clone);
        assert_eq!(git_in(&home).commit_identity(&clone).await, CommitIdentity::default());
        std::fs::write(home.join(".gitconfig"), format!("[user]\n\temail = {}\n", "a".repeat(500))).unwrap();
        assert_eq!(git_in(&home).commit_identity(&clone).await.email.unwrap().len(), CONFIG_VALUE_LIMIT);
        let _ = std::fs::remove_dir_all(home);
    }

    fn rule_for(home: &Path, folder: &str, email: &str) -> String {
        std::fs::write(home.join("acme.gitconfig"), format!("[user]\n\temail = {email}\n")).unwrap();
        format!("[includeIf \"gitdir:{}/{folder}\"]\n\tpath = {}/acme.gitconfig\n", home.display(), home.display())
    }

    #[tokio::test]
    async fn settings_show_the_address_a_rule_for_the_work_folder_gives_inside_its_clones() {
        let home = scratch("work-folder-git");
        let global = "[user]\n\temail = alf@global.example\n";
        std::fs::write(home.join(".gitconfig"), format!("{global}{}", rule_for(&home, "Code/acme/", "alf@code.example"))).unwrap();
        init(&home.join("Gossamr/agents/acme/webshop"));
        let git = git_in(&home);
        let before = git.work_folder_git(&home).await.unwrap();
        assert_eq!(before.global_email.as_deref(), Some("alf@global.example"));
        assert_eq!(before.owners, vec![OwnerAddress { owner: "acme".into(), commit_email: Some("alf@global.example".into()) }]);
        assert!(before.include_if, "rules exist and none reaches the work folder");

        std::fs::write(home.join(".gitconfig"), format!("{global}{}", rule_for(&home, "Gossamr/agents/acme/", "alf@acme.example"))).unwrap();
        let after = git.work_folder_git(&home).await.unwrap();
        assert_eq!(after.owners[0].commit_email.as_deref(), Some("alf@acme.example"), "read inside the clone, where the rule applies");
        assert!(!after.include_if, "the rule the warning asks for clears it");
        let _ = std::fs::remove_dir_all(home);
    }

    #[tokio::test]
    async fn settings_do_not_read_the_address_from_the_folder_itself_or_from_a_repository_in_home() {
        let home = scratch("work-folder-home-repo");
        std::fs::write(home.join(".gitconfig"), "[user]\n\temail = alf@global.example\n").unwrap();
        init(&home);
        std::fs::write(home.join(".git/config"), format!("{}[user]\n\temail = alf@dotfiles.example\n", std::fs::read_to_string(home.join(".git/config")).unwrap())).unwrap();
        std::fs::create_dir_all(agents_root(&home)).unwrap();
        let found = git_in(&home).work_folder_git(&home).await.unwrap();
        assert_eq!((found.global_email.as_deref(), found.owners.is_empty(), found.include_if), (Some("alf@global.example"), true, false));
        let _ = std::fs::remove_dir_all(home);
    }

    #[tokio::test]
    async fn settings_read_a_global_address_that_comes_from_an_included_file() {
        let home = scratch("work-folder-included");
        std::fs::write(home.join("identity.gitconfig"), "[user]\n\temail = alf@included.example\n").unwrap();
        let rule = rule_for(&home, "Code/acme/", "alf@code.example");
        std::fs::write(home.join(".gitconfig"), format!("[include]\n\tpath = {}/identity.gitconfig\n{rule}", home.display())).unwrap();
        init(&home.join("Gossamr/agents/acme/webshop"));
        let found = git_in(&home).work_folder_git(&home).await.unwrap();
        assert_eq!(found.global_email.as_deref(), Some("alf@included.example"));
        assert_eq!(found.owners[0].commit_email.as_deref(), Some("alf@included.example"));
        assert!(found.include_if, "no rule reaches the work folder");
        let _ = std::fs::remove_dir_all(home);
    }

    #[tokio::test]
    async fn settings_read_nothing_when_git_cannot_run() {
        let gone = Git { program: PathBuf::from("/nonexistent/git"), env: Arc::new(RunEnv::from_pairs([("PATH", "/nonexistent")])) };
        assert_eq!(gone.work_folder_git(Path::new("/")).await, None);
    }

    #[test]
    fn the_newest_clone_of_each_owner_is_found_and_links_and_plain_folders_are_not() {
        let root = scratch("newest-clones");
        for clone in ["acme/old", "acme/new", "zeta/only"] {
            std::fs::create_dir_all(root.join(clone).join(".git")).unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }
        std::fs::create_dir_all(root.join("acme/plain")).unwrap();
        std::fs::create_dir_all(root.join("empty")).unwrap();
        std::os::unix::fs::symlink("/tmp", root.join("linked")).unwrap();
        assert_eq!(newest_clone_per_owner(&root), vec![("acme".to_owned(), root.join("acme/new")), ("zeta".to_owned(), root.join("zeta/only"))]);
        assert!(newest_clone_per_owner(&root.join("missing")).is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn rules_that_choose_settings_by_folder_are_found_only_in_the_global_config() {
        let home = scratch("include-if");
        let git = git_in(&home);
        assert!(!git.picks_settings_by_folder(&home).await, "no config file");
        std::fs::write(home.join(".gitconfig"), "[user]\n\temail = a@b.example\n[includeIf \"onbranch:main\"]\n\tpath = x\n").unwrap();
        assert!(!git.picks_settings_by_folder(&home).await, "only gitdir rules count");
        std::fs::write(home.join(".gitconfig"), "[includeIf \"gitdir/i:~/Code/acme/\"]\n\tpath = ~/.gitconfig-acme\n").unwrap();
        assert!(git.picks_settings_by_folder(&home).await);
        let _ = std::fs::remove_dir_all(home);
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
