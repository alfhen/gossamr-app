//! The person's local clones of a repository, and names for new worktrees.
//!
//! Git is only read here. Every call runs with hooks switched off, the captured shell environment and a time limit,
//! because the repository is the person's and may hold anything.

use std::collections::{HashMap, HashSet};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::process::Command;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use super::env::RunEnv;

const GIT_TIMEOUT: Duration = Duration::from_secs(5);
const CACHE_TTL: Duration = Duration::from_secs(600);
const PARALLEL_GIT: usize = 8;
const WORD_LIMIT: usize = 16;

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
        let mut cmd = Command::new(&self.program);
        cmd.args(["-c", "core.hooksPath=/dev/null", "-C"]).arg(dir).arg("--no-optional-locks").args(args);
        self.env.apply(cmd.as_std_mut());
        let child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true).spawn().ok()?;
        let out = tokio::time::timeout(GIT_TIMEOUT, child.wait_with_output()).await.ok()?.ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
    }

    pub async fn origin(&self, dir: &Path) -> Option<String> {
        self.out(dir, &["remote", "get-url", "origin"]).await
    }
}

fn find_in_path(env: &RunEnv, program: &str) -> Option<PathBuf> {
    let path = env.get("PATH")?.to_str()?;
    path.split(':')
        .map(|dir| Path::new(dir).join(program))
        .find(|p| p.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalClone {
    pub path: PathBuf,
    pub branch: String,
    pub dirty: bool,
    /// What `origin/HEAD` points at, when the clone knows.
    pub default_branch: Option<String>,
}

/// Where people keep clones, one level deep.
pub fn default_roots(home: &Path) -> Vec<PathBuf> {
    ["Code", "Developer", "src"].iter().map(|d| home.join(d)).collect()
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

pub async fn inspect(git: &Git, path: &Path) -> Option<LocalClone> {
    let branch = git.out(path, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
    let dirty = git.out(path, &["status", "--porcelain"]).await.is_some_and(|s| !s.is_empty());
    let default_branch = git
        .out(path, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        .await
        .map(|b| b.strip_prefix("origin/").unwrap_or(&b).to_owned())
        .filter(|b| !b.is_empty());
    Some(LocalClone { path: path.canonicalize().unwrap_or_else(|_| path.to_path_buf()), branch, dirty, default_branch })
}

fn candidate_dirs(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = roots
        .iter()
        .filter_map(|r| std::fs::read_dir(r).ok())
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir() && p.join(".git").exists())
        .collect();
    dirs.sort();
    dirs
}

/// Clones of `repo` one level inside `roots`, matched by their `origin` URL, in path order.
pub async fn find_clones(git: &Git, repo: &str, roots: &[PathBuf]) -> Vec<LocalClone> {
    let roots = roots.to_vec();
    let dirs = tokio::task::spawn_blocking(move || candidate_dirs(&roots)).await.unwrap_or_default();
    let gate = Arc::new(Semaphore::new(PARALLEL_GIT));
    let mut tasks = JoinSet::new();
    for dir in dirs {
        let (git, gate, repo) = (git.clone(), gate.clone(), repo.to_owned());
        tasks.spawn(async move {
            let _slot = gate.acquire().await.ok()?;
            let url = git.origin(&dir).await?;
            if origin_matches(&url, &repo) {
                inspect(&git, &dir).await
            } else {
                None
            }
        });
    }
    let mut found = Vec::new();
    while let Some(done) = tasks.join_next().await {
        found.extend(done.ok().flatten());
    }
    found.sort_by(|a, b| a.path.cmp(&b.path));
    found
}

/// Clone lists kept for ten minutes, so opening the setup sheet repeatedly doesn't rescan the disk.
#[derive(Default)]
pub struct CloneCache {
    entries: Mutex<HashMap<String, (Instant, Vec<LocalClone>)>>,
}

impl CloneCache {
    pub fn get(&self, repo: &str) -> Option<Vec<LocalClone>> {
        let entries = self.entries.lock().expect("clone cache poisoned");
        entries.get(&repo.to_ascii_lowercase()).filter(|(at, _)| at.elapsed() < CACHE_TTL).map(|(_, c)| c.clone())
    }

    pub fn put(&self, repo: &str, clones: Vec<LocalClone>) {
        self.entries.lock().expect("clone cache poisoned").insert(repo.to_ascii_lowercase(), (Instant::now(), clones));
    }

    pub fn clear(&self) {
        self.entries.lock().expect("clone cache poisoned").clear();
    }
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

fn random_hex(digits: usize) -> String {
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
[ "$1" = -c ] && shift 2
dir=.
[ "$1" = -C ] && { dir=$2; shift 2; }
[ "$1" = --no-optional-locks ] && shift
case "$*" in
  "remote get-url origin") cat "$dir/.fake-origin" 2>/dev/null || exit 2 ;;
  "rev-parse --abbrev-ref HEAD") cat "$dir/.fake-branch" 2>/dev/null || echo main ;;
  "status --porcelain") cat "$dir/.fake-dirty" 2>/dev/null ;;
  "symbolic-ref --short refs/remotes/origin/HEAD") echo origin/main ;;
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
        bin
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
    async fn finds_clones_one_level_down_by_origin_and_reports_branch_and_dirt() {
        let dir = scratch("find");
        let git = fake_git(&dir);
        let code = dir.join("Code");
        let dev = dir.join("Developer");
        clone_with_origin(&code.join("webshop"), "git@github.com:acme/webshop.git");
        clone_with_origin(&code.join("other"), "https://github.com/acme/other");
        clone_with_origin(&dev.join("webshop-copy"), "https://github.com/acme/webshop");
        std::fs::write(dev.join("webshop-copy/.fake-dirty"), " M cart.js\n").unwrap();
        std::fs::write(dev.join("webshop-copy/.fake-branch"), "feature/x\n").unwrap();
        clone_with_origin(&code.join("deep/nested/webshop"), "https://github.com/acme/webshop");
        std::fs::create_dir_all(code.join("not-a-clone")).unwrap();
        std::fs::write(code.join("a-file"), "x").unwrap();

        let found = find_clones(&git, "acme/webshop", &[code.clone(), dev.clone(), dir.join("src-missing")]).await;
        assert_eq!(found.iter().map(|c| c.path.clone()).collect::<Vec<_>>(), [code.join("webshop"), dev.join("webshop-copy")]);
        assert_eq!((found[0].branch.as_str(), found[0].dirty, found[0].default_branch.as_deref()), ("main", false, Some("main")));
        assert_eq!((found[1].branch.as_str(), found[1].dirty), ("feature/x", true));
        assert!(find_clones(&git, "acme/none", &[code, dev]).await.is_empty());

        let log = std::fs::read_to_string(dir.join("git.log")).unwrap();
        assert!(log.lines().all(|l| l.starts_with("-c core.hooksPath=/dev/null -C ") && l.contains(" --no-optional-locks ")), "{log}");
        assert!(log.lines().all(|l| !l.contains("fetch") && !l.contains("checkout") && !l.contains("pull")));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_git_that_fails_or_is_missing_finds_nothing() {
        let dir = scratch("nogit");
        let code = dir.join("Code");
        std::fs::create_dir_all(code.join("webshop/.git")).unwrap();
        let git = fake_git(&dir);
        assert!(find_clones(&git, "acme/webshop", std::slice::from_ref(&code)).await.is_empty(), "no origin file: git exits 2");
        let gone = Git::new(Arc::new(RunEnv::from_pairs([("PATH", "/nonexistent")])));
        assert!(find_clones(&gone, "acme/webshop", &[code]).await.is_empty());
        let _ = std::fs::remove_dir_all(dir);
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

    #[test]
    fn clone_lists_are_cached_by_repo_without_regard_to_case() {
        let cache = CloneCache::default();
        assert!(cache.get("acme/webshop").is_none());
        cache.put("Acme/WebShop", vec![]);
        assert_eq!(cache.get("acme/webshop"), Some(vec![]));
        cache.clear();
        assert!(cache.get("acme/webshop").is_none());
    }
}
