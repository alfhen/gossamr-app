//! Where a session runs and as whom: the shell environment the harness last captured, the login folder a session
//! names, and the clone and worktree of a session that names a repo.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::binary::CliPlaces;
use crate::env::{RunEnv, capture};
use crate::error::{Error, Result};
use crate::fresh::{Fetched, agents_root, ensure_clone, lock_repo, real, remote_default_branch, remove_stale_temps, valid_repo};
use crate::provider::{Login, Provider};
use crate::provider_env::{ProviderState, states};
use crate::provider_folder::{Places, expand};
use crate::repo::{Git, Worktree, remove_with_git};

/// The clone and branch of a session that named a repo. Its `cwd` is the worktree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Work {
    pub repo: String,
    /// The branch on the remote the worktree started from.
    pub base: String,
    pub branch: String,
    pub clone: PathBuf,
}

/// What the harness knows of the machine it runs on: the home folder (the work root, `~/Gossamr/agents`, is in it),
/// its own data folder, where CLIs are installed, and the shell environment it last captured.
pub struct Setup {
    home: Option<PathBuf>,
    /// The home the work root is under when it is not `home`: a debug build's `HARNESS_WORK_HOME`.
    work_home: Option<PathBuf>,
    data_dir: PathBuf,
    places: CliPlaces,
    /// The shell `capture` runs; None captures nothing, so sessions run in the harness's own environment.
    shell_program: Option<String>,
    shell: Mutex<Option<Arc<RunEnv>>>,
}

/// No home folder, no CLI folder of the machine and no shell: sessions run in the harness's own environment, on
/// their provider's usual login.
impl Default for Setup {
    fn default() -> Setup {
        Setup { home: None, work_home: None, data_dir: PathBuf::new(), places: CliPlaces::none(), shell_program: None, shell: Mutex::new(None) }
    }
}

impl Setup {
    /// `home` is made real, so a linked home folder gives the paths git and the CLIs see.
    pub fn new(home: Option<PathBuf>, data_dir: PathBuf) -> Setup {
        Setup { home: home.and_then(|home| home.canonicalize().ok()), data_dir, ..Setup::default() }
    }

    /// The machine's home folder, as `dirs` finds it, the folders installers put CLIs in, and the person's shell,
    /// `$SHELL` (zsh when it is unset).
    pub fn of_this_machine(data_dir: PathBuf) -> Setup {
        let setup = Setup::new(dirs::home_dir(), data_dir);
        let places = CliPlaces::of_this_mac(setup.home.clone());
        Setup { places, ..setup }.with_work_home(work_home_from(debug_work_home())).with_shell_program(&std::env::var("SHELL").unwrap_or_default())
    }

    /// The work root under `home` in place of the home folder. Nothing else moves: the agent's own `HOME`, the shell
    /// capture, where CLIs are found and where a login folder's `~` points stay the machine's.
    pub fn with_work_home(self, home: Option<PathBuf>) -> Setup {
        Setup { work_home: home.and_then(|home| home.canonicalize().ok()), ..self }
    }

    /// The home the work root, `~/Gossamr/agents`, is under.
    fn work_root_home(&self) -> Option<&Path> {
        self.work_home.as_deref().or(self.home.as_deref())
    }

    pub fn with_shell_program(self, program: &str) -> Setup {
        Setup { shell_program: Some(program.into()), ..self }
    }

    /// A capture that already holds `env`, as if the shell printed it.
    #[cfg(any(test, feature = "testing"))]
    pub fn with_shell_env(self, env: RunEnv) -> Setup {
        Setup { shell: Mutex::new(Some(Arc::new(env))), ..self }
    }

    /// Where a CLI is looked for besides the shell's PATH.
    pub fn places(&self) -> &CliPlaces {
        &self.places
    }

    pub fn home(&self) -> Option<&Path> {
        self.home.as_deref()
    }

    /// Reads the shell's environment again. A failed capture keeps the last good one, so sessions can still start.
    pub async fn capture(&self) -> std::result::Result<(), String> {
        let Some(program) = &self.shell_program else { return Ok(()) };
        let found = capture(program).await.map_err(|e| e.to_string())?;
        *self.shell.lock().unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(found));
        Ok(())
    }

    pub fn shell(&self) -> Option<Arc<RunEnv>> {
        self.shell.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// The environment before any login: the captured shell's, else the harness's own.
    fn base(&self) -> RunEnv {
        self.shell().map_or_else(|| RunEnv::from_pairs(std::env::vars_os()), |shell| (*shell).clone())
    }

    /// Git with the base environment, which holds the person's credentials and `gh`.
    pub fn git(&self) -> Git {
        Git::new(Arc::new(self.base()))
    }

    fn clone_refused(&self, e: crate::fresh::CloneError) -> Error {
        Error::Refused(self.masked(&e.to_string()))
    }

    /// `text` with the home folder written `~`, so a refusal names the rule and not the person's paths.
    pub fn masked(&self, text: &str) -> String {
        match &self.home {
            Some(home) => text.replace(&*home.to_string_lossy(), "~"),
            None => text.to_owned(),
        }
    }

    /// The agent's whole environment for `provider` on `login`, a login folder as typed. A provider of the table
    /// follows `provider_env`: a folder sets its variable and removes every other login variable, and no folder takes
    /// the shell's own. The folder's rules are `provider_folder`'s; the work root is refused too, and the folder must
    /// already exist: the harness never makes a login folder. A provider outside the table has no logins.
    ///
    /// With a shell to capture (`serve`), nothing starts before a capture has worked, an open or a resume alike: each
    /// client's connection captures the shell, and its `open` waits for that. A resume, which H6's drivers bring, waits
    /// the same way; until a capture has worked it is refused, never run in the harness's own environment.
    pub fn agent_env(&self, provider: &str, login: Option<&str>) -> Result<RunEnv> {
        let refused = |why: String| Error::Refused(format!("this login can't be used: {why}"));
        // A provider outside the table, the mock, runs on no login and needs no shell.
        let Some(row) = Provider::named(provider) else {
            return match login {
                Some(_) => Err(refused(format!("{provider} has no logins"))),
                None => Ok(self.base()),
            };
        };
        if self.shell_program.is_some() && self.shell().is_none() {
            return Err(Error::Refused("the shell's environment hasn't been read yet, so no agent starts: connect a client, or fix the shell's startup files".into()));
        }
        let shell = self.shell();
        let places = Places { home: self.home.as_deref(), data_dir: &self.data_dir };
        let asked = Login { id: String::new(), provider: row, name: String::new(), enabled: true, folder: login.map(str::to_owned) };
        let env = match states(&[asked], &places, shell.as_deref()).remove(0).1 {
            ProviderState::Ready(env) => env,
            ProviderState::Error(problem) => return Err(refused(problem)),
            ProviderState::Unavailable(why) => return Err(refused(why.message().into())),
            ProviderState::Off => unreachable!("a login asked for at open is on"),
        };
        if let (Some(typed), Some(home), Some(work)) = (login, self.home.as_deref(), self.work_root_home()) {
            let folder = expand(typed, home);
            let (folder_real, root) = (real(&folder), real(&agents_root(work)));
            if folder_real.starts_with(&root) || root.starts_with(&folder_real) {
                return Err(refused("it is the harness's work root, where the clones are, or inside it or holds it".into()));
            }
            if !folder.is_dir() {
                return Err(refused("the folder isn't there, and the harness never makes a login folder".into()));
            }
        }
        Ok(env.over(&self.base()))
    }

    /// Clones `repo` into the work root, or fetches the clone there, and adds a worktree on the new `branch` from
    /// `origin/<base>`, the remote's default branch when `base` is None. Nothing is forced, and a folder or branch
    /// that is already there is refused (`Git::add_worktree`). With the work, a note for the session when the fetch
    /// did not happen, so it starts from what was fetched before.
    pub async fn prepare(&self, repo: &str, base: Option<&str>, branch: &str) -> Result<(Work, PathBuf, Option<String>)> {
        let home = self.work_root_home().ok_or_else(|| Error::Refused("the harness doesn't know the home folder, so it has no work root".into()))?;
        let git = self.git();
        let _lock = lock_repo(home, repo).await.map_err(|e| self.clone_refused(e))?;
        remove_stale_temps(&git, home, repo).await;
        let ensured = ensure_clone(&git, home, repo, true).await.map_err(|e| self.clone_refused(e))?;
        let note = match ensured.fetched {
            Some(Fetched::Not(why)) => Some(self.masked(&format!("The harness couldn't update its clone of {repo}, so this session starts from what was fetched before: {why}"))),
            _ => None,
        };
        let clone = ensured.path;
        let base = match base {
            Some(base) => base.to_owned(),
            None => match git.default_branch(&clone).await {
                Some(base) => base,
                None => remote_default_branch(&git, repo).await.map_err(|e| self.clone_refused(e))?,
            },
        };
        check_ref("base", &base)?;
        let worktree = worktree_path(&clone, branch)?;
        // The worktrees folder can be a link that leads out, as the owner folder can (`make_parent`).
        if !worktree.parent().is_some_and(|folder| real(folder).starts_with(real(&agents_root(home)))) {
            return Err(Error::Refused(format!("the worktrees folder of {repo} leads out of the work root, so no worktree is made there")));
        }
        // `add_worktree` takes back an untouched worktree of an earlier try; a session never shares one.
        if worktree.symlink_metadata().is_ok() || git.branch_exists(&clone, branch).await.map_err(Error::Refused)? {
            return Err(Error::Refused(format!("the branch {branch} or its worktree is already there")));
        }
        git.add_worktree(&clone, &worktree, branch, &format!("origin/{base}")).await.map_err(|e| Error::Refused(self.masked(&format!("the worktree can't be made: {e}"))))?;
        Ok((Work { repo: repo.to_owned(), base, branch: branch.to_owned(), clone }, worktree, note))
    }

    /// Removes the worktree and branch of a start that never ran, while nothing was done in them.
    pub async fn discard(&self, work: &Work, worktree: &Path) {
        let Some(home) = self.work_root_home() else { return };
        let Ok(_lock) = lock_repo(home, &work.repo).await else { return };
        self.git().discard_untouched_worktree(&work.clone, worktree, &work.branch, &format!("origin/{}", work.base)).await;
    }

    /// Removes a session's worktree and branch through git alone, never forcing. What git refuses (changes not
    /// committed, commits not merged or pushed) stays, and is the refusal.
    pub async fn remove(&self, work: &Work, worktree: &Path) -> Result<()> {
        // In turns with an open of the same repo, whose fetch and worktree add would race this fetch and removal.
        let home = self.work_root_home().ok_or_else(|| Error::Refused("the harness doesn't know the home folder, so it has no work root".into()))?;
        let _lock = lock_repo(home, &work.repo).await.map_err(|e| self.clone_refused(e))?;
        let at = Worktree { repo: &work.repo, clone: &work.clone, path: worktree, branch: &work.branch, base: &work.base };
        match remove_with_git(&self.git(), self.work_root_home(), at).await {
            Ok(None) => Ok(()),
            Ok(Some(kept)) if kept.starts_with("nothing was removed") => Err(Error::Refused(self.masked(&kept))),
            Ok(Some(kept)) => Err(Error::Refused(self.masked(&format!("git keeps the worktree: {kept}")))),
            Err(why) => Err(Error::Refused(self.masked(&why))),
        }
    }
}

/// Worktrees of `<owner>/<repo>` go in `<owner>/<repo>+worktrees/<branch>`, beside the clone and inside the work root.
/// `+` is a character `valid_repo` refuses, so no repository's clone can be that folder.
fn worktree_path(clone: &Path, branch: &str) -> Result<PathBuf> {
    let name = clone.file_name().ok_or_else(|| Error::Refused("the clone has no folder name".into()))?;
    let mut folder = OsString::from(name);
    folder.push("+worktrees");
    Ok(real(&clone.with_file_name(folder)).join(branch))
}

/// A branch or base the harness passes to git and makes a folder for: letters, digits, `.`, `_` and `-`, at most 100,
/// not starting with `-` or `.`, with no `..` and not ending in `.lock`. No slash, so it is one folder name.
pub fn valid_ref(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && !name.starts_with(['-', '.'])
        && !name.contains("..")
        && !name.ends_with(".lock")
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

pub fn check_ref(what: &str, name: &str) -> Result<()> {
    match valid_ref(name) {
        true => Ok(()),
        false => Err(Error::Refused(format!(
            "that {what} isn't a name the harness uses: letters, digits, ., _ and -, at most 100, not starting with - or ., with no .. and no slash"
        ))),
    }
}

/// What `open` refuses of a repo, a base and a branch before anything is cloned.
pub fn check_work(repo: &str, base: Option<&str>, branch: &str) -> Result<()> {
    if !valid_repo(repo) {
        return Err(Error::Refused("that repo isn't one the harness clones: owner/name, each part letters, digits, ., _ and -, not starting with -".into()));
    }
    if let Some(base) = base {
        check_ref("base", base)?;
    }
    check_ref("branch", branch)
}

/// An effort the harness passes to a driver: lowercase letters, at most 16.
pub fn valid_effort(effort: &str) -> bool {
    !effort.is_empty() && effort.len() <= 16 && effort.bytes().all(|b| b.is_ascii_lowercase())
}

/// The variable a debug build of the harness takes its work root's home from, so a test can run the real `serve`
/// without touching `~/Gossamr`. A release build has no such code.
#[cfg(debug_assertions)]
pub const WORK_HOME_VARIABLE: &str = "HARNESS_WORK_HOME";

fn debug_work_home() -> Option<std::ffi::OsString> {
    #[cfg(debug_assertions)]
    return std::env::var_os(WORK_HOME_VARIABLE);
    #[cfg(not(debug_assertions))]
    None
}

/// The work root's home a value of `HARNESS_WORK_HOME` names: none when it is unset or empty.
fn work_home_from(value: Option<std::ffi::OsString>) -> Option<PathBuf> {
    value.filter(|value| !value.is_empty()).map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_work_home_is_taken_only_from_a_value_that_names_a_folder() {
        assert_eq!(work_home_from(None), None, "unset: the home folder's work root");
        assert_eq!(work_home_from(Some("".into())), None);
        assert_eq!(work_home_from(Some("/tmp/elsewhere".into())), Some(PathBuf::from("/tmp/elsewhere")));
        #[cfg(debug_assertions)]
        assert_eq!(WORK_HOME_VARIABLE, "HARNESS_WORK_HOME", "the name CI's strings check looks for in a release build");
    }

    #[test]
    fn a_branch_or_base_is_one_plain_folder_name() {
        for good in ["main", "harness-4f2a", "release-1.2", "a_b"] {
            assert!(valid_ref(good), "{good}");
        }
        for bad in ["", "-x", "--upload-pack=evil", ".hidden", "a..b", "a/b", "../x", "x.lock", "a b", "a\nb", "é", &"x".repeat(101)] {
            assert!(!valid_ref(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_repo_with_a_name_git_could_take_for_an_option_or_a_path_out_is_refused() {
        for bad in ["acme", "acme/web/shop", "-acme/web", "acme/..", "acme/-web", "acme/we b"] {
            assert!(check_work(bad, None, "main").is_err(), "{bad}");
        }
        assert!(check_work("acme/web-shop", Some("main"), "harness-1").is_ok());
        assert!(check_work("acme/web", Some("-main"), "x").is_err());
    }

    #[test]
    fn an_effort_is_a_short_lowercase_word() {
        assert!(valid_effort("high") && valid_effort("xhigh"));
        assert!(!valid_effort("") && !valid_effort("--max") && !valid_effort("High") && !valid_effort(&"a".repeat(17)));
    }

    #[test]
    fn a_worktree_goes_beside_its_clone() {
        let dir = tempfile::tempdir().unwrap();
        let clone = dir.path().join("acme/webshop");
        std::fs::create_dir_all(&clone).unwrap();
        let path = worktree_path(&clone, "harness-1").unwrap();
        assert!(path.ends_with("acme/webshop+worktrees/harness-1"));
        assert!(path.starts_with(dir.path().canonicalize().unwrap()));
    }
}
