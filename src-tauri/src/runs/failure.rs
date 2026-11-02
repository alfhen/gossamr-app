//! Why a run didn't start, in words the person can act on. Stored on the run as its `error`.

use std::fmt;
use std::path::PathBuf;

use super::cli::CliError;
use super::fresh::{tilde, CloneError};
use super::toolchain::ToolchainError;
use crate::domain::{RefusedMode, RunFailure};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    ClaudeMissing { instance: String },
    TooOld,
    NotSignedIn { instance: String },
    NoEnvironment(String),
    /// The clone is gone, isn't a clone of the repository, or can't be read.
    NoClone(String),
    /// A new session was asked for in a folder Gossamr didn't make: a run set up before agents moved to the work folder.
    OutsideWorkFolder { path: PathBuf },
    /// Something that isn't a clone of the repository is where Gossamr's clone goes.
    CloneOccupied { repo: String, path: PathBuf },
    /// The approved spec no longer passes validation.
    Invalid(String),
    CapReached(usize),
    NeedsTrust { folder: PathBuf, instance: String },
    /// `--bg` won't start in the person's permission mode until they accept it once in Terminal; Claude's own words.
    ModeRefused { mode: RefusedMode, message: String },
    CommandFailed(String),
    Unparseable(String),
    Interrupted,
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Failure::ClaudeMissing { instance } => write!(f, "Claude Code isn't installed, or Gossamr can't find it for {instance}."),
            Failure::TooOld => write!(f, "Your Claude Code is too old to run background agents. Update it, then retry."),
            Failure::NotSignedIn { instance } => write!(f, "{instance} isn't signed in. Run `claude` in Terminal and sign in, then retry."),
            Failure::NoEnvironment(why) => write!(f, "{why}"),
            Failure::NoClone(why) | Failure::Invalid(why) => write!(f, "{why}"),
            Failure::OutsideWorkFolder { path } => write!(f, "This agent was set up in {}, before Gossamr kept its own clones. Ask Pip to start it again, and it will use Gossamr's clone.", tilde(path)),
            Failure::CloneOccupied { repo, path } => write!(f, "{}", CloneError::Occupied { repo: repo.clone(), path: path.clone() }),
            Failure::CapReached(n) => write!(f, "{n} agents are already running. Stop one or wait for one to finish, then retry."),
            Failure::NeedsTrust { folder, instance } => write!(
                f,
                "{instance} doesn't trust {} yet. Open Terminal in that folder, run `claude`, accept the trust prompt, then retry.",
                folder.display()
            ),
            Failure::ModeRefused { message, .. } => write!(f, "{message}"),
            Failure::CommandFailed(line) => write!(f, "Claude couldn't start the agent: {line}"),
            Failure::Unparseable(stdout) => write!(
                f,
                "Claude may have started a session, but its answer wasn't recognised. Retry looks for that session before starting another. It printed: {stdout}"
            ),
            Failure::Interrupted => write!(f, "Launch was interrupted"),
        }
    }
}

impl From<ToolchainError> for Failure {
    fn from(e: ToolchainError) -> Self {
        match e {
            ToolchainError::ClaudeMissing { instance } => Failure::ClaudeMissing { instance },
            ToolchainError::NoEnvironment(why) | ToolchainError::Unusable(why) => Failure::NoEnvironment(why),
            ToolchainError::UnknownInstance(id) => Failure::NoEnvironment(format!("There is no Claude called {id}. Pick another.")),
        }
    }
}

impl From<&Failure> for RunFailure {
    fn from(why: &Failure) -> Self {
        match why {
            Failure::ClaudeMissing { .. } => RunFailure::ClaudeMissing,
            Failure::NotSignedIn { .. } => RunFailure::NotSignedIn,
            Failure::NoClone(_) => RunFailure::NoClone,
            Failure::OutsideWorkFolder { path } => RunFailure::OutsideWorkFolder { path: path.clone() },
            Failure::CloneOccupied { path, .. } => RunFailure::CloneOccupied { path: path.clone() },
            Failure::CapReached(_) => RunFailure::CapReached,
            Failure::ModeRefused { mode, .. } => RunFailure::ModeRefused { mode: *mode },
            Failure::NeedsTrust { folder, .. } => RunFailure::UntrustedFolder { path: folder.clone() },
            Failure::TooOld | Failure::NoEnvironment(_) | Failure::Invalid(_) | Failure::CommandFailed(_) | Failure::Unparseable(_) | Failure::Interrupted => RunFailure::Other,
        }
    }
}

impl Failure {
    /// What a failed `claude` call means. `folder` is where the launch ran, and `instance` is the name of the one it ran as.
    pub fn from_cli(e: CliError, folder: &std::path::Path, instance: &str) -> Self {
        if e.stderr_mentions("Workspace not trusted") {
            return Failure::NeedsTrust { folder: folder.to_path_buf(), instance: instance.into() };
        }
        match e {
            CliError::Spawn(io) if io.kind() == std::io::ErrorKind::NotFound => Failure::ClaudeMissing { instance: instance.into() },
            CliError::Unparseable { stdout } => Failure::Unparseable(stdout),
            CliError::Failed { stderr, .. } => {
                let line = stderr.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("no message");
                match stderr.lines().find_map(|l| RefusedMode::reads(l).map(|mode| (mode, l.trim()))) {
                    Some((mode, message)) => Failure::ModeRefused { mode, message: message.to_owned() },
                    None => Failure::CommandFailed(line.to_owned()),
                }
            }
            other => Failure::CommandFailed(other.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_errors_map_to_what_the_person_can_do() {
        let folder = std::path::Path::new("/Users/me/Code/webshop");
        let failed = |stderr: &str| CliError::Failed { code: Some(1), stderr: stderr.into() };
        assert_eq!(Failure::from_cli(failed("Workspace not trusted. Run `claude` in /x once"), folder, "Claude"), Failure::NeedsTrust { folder: folder.into(), instance: "Claude".into() });
        assert_eq!(Failure::from_cli(failed("boom\nsomething broke"), folder, "Claude"), Failure::CommandFailed("something broke".into()));
        assert_eq!(Failure::from_cli(CliError::Unparseable { stdout: "hm".into() }, folder, "Claude"), Failure::Unparseable("hm".into()));
        assert_eq!(Failure::from_cli(CliError::TimedOut, folder, "Claude"), Failure::CommandFailed("claude took too long to answer".into()));
        let auto = "--bg with auto mode requires opting in first. Run `claude --permission-mode auto` once interactively.";
        let bypass = "--bg with bypassPermissions requires accepting the disclaimer first. Run `claude --dangerously-skip-permissions` once interactively.";
        assert_eq!(Failure::from_cli(failed(auto), folder, "Claude"), Failure::ModeRefused { mode: RefusedMode::Auto, message: auto.into() });
        assert_eq!(Failure::from_cli(failed(&format!("Starting background service\n{bypass}\n")), folder, "Claude"), Failure::ModeRefused { mode: RefusedMode::Bypass, message: bypass.into() });
        assert_eq!(Failure::from_cli(failed(auto), folder, "Claude").to_string(), auto, "Claude's own words, nothing added");
        let missing = CliError::Spawn(std::io::Error::from(std::io::ErrorKind::NotFound));
        assert_eq!(Failure::from_cli(missing, folder, "Claude"), Failure::ClaudeMissing { instance: "Claude".into() });
        assert!(Failure::NeedsTrust { folder: folder.into(), instance: "Claude".into() }.to_string().contains("/Users/me/Code/webshop"));
        assert_eq!(Failure::Interrupted.to_string(), "Launch was interrupted");
    }

    #[test]
    fn the_three_failures_that_depend_on_a_login_name_the_instance_and_are_still_recognised_from_their_text() {
        let folder = std::path::Path::new("/Users/me/My Code/web shop");
        let named = [
            (Failure::NotSignedIn { instance: "Claude personal".into() }, RunFailure::NotSignedIn),
            (Failure::ClaudeMissing { instance: "Claude personal".into() }, RunFailure::ClaudeMissing),
            (Failure::NeedsTrust { folder: folder.into(), instance: "Claude personal".into() }, RunFailure::UntrustedFolder { path: folder.into() }),
        ];
        for (why, kind) in named {
            assert!(why.to_string().contains("Claude personal"), "{why:?}");
            assert_eq!(RunFailure::from_message(&why.to_string()), kind, "{why:?}");
        }
    }

    fn every_failure(folder: &std::path::Path) -> Vec<(Failure, RunFailure)> {
        vec![
            (Failure::ClaudeMissing { instance: "Claude".into() }, RunFailure::ClaudeMissing),
            (Failure::TooOld, RunFailure::Other),
            (Failure::NotSignedIn { instance: "Claude".into() }, RunFailure::NotSignedIn),
            (Failure::NoEnvironment("Couldn't read your shell environment.".into()), RunFailure::Other),
            (Failure::NoClone("/x isn't a git clone any more".into()), RunFailure::NoClone),
            (Failure::OutsideWorkFolder { path: folder.into() }, RunFailure::OutsideWorkFolder { path: folder.into() }),
            (Failure::CloneOccupied { repo: "acme/webshop".into(), path: folder.into() }, RunFailure::CloneOccupied { path: folder.into() }),
            (Failure::Invalid("the base branch name isn't valid".into()), RunFailure::Other),
            (Failure::CapReached(3), RunFailure::CapReached),
            (Failure::NeedsTrust { folder: folder.into(), instance: "Claude".into() }, RunFailure::UntrustedFolder { path: folder.into() }),
            (Failure::CommandFailed("boom".into()), RunFailure::Other),
            (Failure::Unparseable("hm".into()), RunFailure::Other),
            (Failure::ModeRefused { mode: RefusedMode::Auto, message: "--bg with auto mode requires opting in first. Run `claude --permission-mode auto` once interactively.".into() }, RunFailure::ModeRefused { mode: RefusedMode::Auto }),
            (Failure::ModeRefused { mode: RefusedMode::Bypass, message: "--bg with bypassPermissions requires accepting the disclaimer first. Run `claude --dangerously-skip-permissions` once interactively.".into() }, RunFailure::ModeRefused { mode: RefusedMode::Bypass }),
            (Failure::Interrupted, RunFailure::Other),
        ]
    }

    #[test]
    fn each_launch_failure_has_a_kind_the_page_can_act_on() {
        for (why, kind) in every_failure(std::path::Path::new("/Users/me/Code/webshop")) {
            assert_eq!(RunFailure::from(&why), kind, "{why:?}");
        }
    }

    #[test]
    fn a_failure_stored_as_text_alone_is_recognised_by_its_fixed_wording() {
        let folder = std::path::Path::new("/Users/me/My Code/web shop");
        for (why, kind) in every_failure(folder) {
            let known = matches!(kind, RunFailure::UntrustedFolder { .. } | RunFailure::ModeRefused { .. } | RunFailure::NotSignedIn | RunFailure::ClaudeMissing | RunFailure::CapReached);
            let expected = if known { kind } else { RunFailure::Other };
            assert_eq!(RunFailure::from_message(&why.to_string()), expected, "{why:?}");
        }
    }
}
