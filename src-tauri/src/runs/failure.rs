//! Why a run didn't start, in words the person can act on. Stored on the run as its `error`.

use std::fmt;
use std::path::PathBuf;

use super::cli::CliError;
use super::toolchain::ToolchainError;
use crate::domain::RunFailure;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    ClaudeMissing,
    TooOld,
    NotSignedIn,
    NoEnvironment(String),
    /// The clone is gone, isn't a clone of the repository, or can't be read.
    NoClone(String),
    /// The approved spec no longer passes validation.
    Invalid(String),
    CapReached(usize),
    NeedsTrust { folder: PathBuf },
    CommandFailed(String),
    Unparseable(String),
    Interrupted,
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Failure::ClaudeMissing => write!(f, "Claude Code isn't installed, or Gossamr can't find it."),
            Failure::TooOld => write!(f, "Your Claude Code is too old to run background agents. Update it, then retry."),
            Failure::NotSignedIn => write!(f, "Claude isn't signed in. Run `claude` in Terminal and sign in, then retry."),
            Failure::NoEnvironment(why) => write!(f, "{why}"),
            Failure::NoClone(why) | Failure::Invalid(why) => write!(f, "{why}"),
            Failure::CapReached(n) => write!(f, "{n} agents are already running. Stop one or wait for one to finish, then retry."),
            Failure::NeedsTrust { folder } => write!(
                f,
                "Claude doesn't trust {} yet. Open Terminal in that folder, run `claude`, accept the trust prompt, then retry.",
                folder.display()
            ),
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
            ToolchainError::ClaudeMissing => Failure::ClaudeMissing,
            ToolchainError::NoEnvironment(why) => Failure::NoEnvironment(why),
        }
    }
}

impl From<&Failure> for RunFailure {
    fn from(why: &Failure) -> Self {
        match why {
            Failure::ClaudeMissing => RunFailure::ClaudeMissing,
            Failure::NotSignedIn => RunFailure::NotSignedIn,
            Failure::NoClone(_) => RunFailure::NoClone,
            Failure::CapReached(_) => RunFailure::CapReached,
            Failure::NeedsTrust { folder } => RunFailure::UntrustedFolder { path: folder.clone() },
            Failure::TooOld | Failure::NoEnvironment(_) | Failure::Invalid(_) | Failure::CommandFailed(_) | Failure::Unparseable(_) | Failure::Interrupted => RunFailure::Other,
        }
    }
}

impl Failure {
    /// What a failed `claude` call means. `folder` is where the launch ran.
    pub fn from_cli(e: CliError, folder: &std::path::Path) -> Self {
        if e.stderr_mentions("Workspace not trusted") {
            return Failure::NeedsTrust { folder: folder.to_path_buf() };
        }
        match e {
            CliError::Spawn(io) if io.kind() == std::io::ErrorKind::NotFound => Failure::ClaudeMissing,
            CliError::Unparseable { stdout } => Failure::Unparseable(stdout),
            CliError::Failed { stderr, .. } => {
                Failure::CommandFailed(stderr.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("no message").to_owned())
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
        assert_eq!(Failure::from_cli(failed("Workspace not trusted. Run `claude` in /x once"), folder), Failure::NeedsTrust { folder: folder.into() });
        assert_eq!(Failure::from_cli(failed("boom\nsomething broke"), folder), Failure::CommandFailed("something broke".into()));
        assert_eq!(Failure::from_cli(CliError::Unparseable { stdout: "hm".into() }, folder), Failure::Unparseable("hm".into()));
        assert_eq!(Failure::from_cli(CliError::TimedOut, folder), Failure::CommandFailed("claude took too long to answer".into()));
        let missing = CliError::Spawn(std::io::Error::from(std::io::ErrorKind::NotFound));
        assert_eq!(Failure::from_cli(missing, folder), Failure::ClaudeMissing);
        assert!(Failure::NeedsTrust { folder: folder.into() }.to_string().contains("/Users/me/Code/webshop"));
        assert_eq!(Failure::Interrupted.to_string(), "Launch was interrupted");
    }

    fn every_failure(folder: &std::path::Path) -> Vec<(Failure, RunFailure)> {
        vec![
            (Failure::ClaudeMissing, RunFailure::ClaudeMissing),
            (Failure::TooOld, RunFailure::Other),
            (Failure::NotSignedIn, RunFailure::NotSignedIn),
            (Failure::NoEnvironment("Couldn't read your shell environment.".into()), RunFailure::Other),
            (Failure::NoClone("/x isn't a git clone any more".into()), RunFailure::NoClone),
            (Failure::Invalid("the base branch name isn't valid".into()), RunFailure::Other),
            (Failure::CapReached(3), RunFailure::CapReached),
            (Failure::NeedsTrust { folder: folder.into() }, RunFailure::UntrustedFolder { path: folder.into() }),
            (Failure::CommandFailed("boom".into()), RunFailure::Other),
            (Failure::Unparseable("hm".into()), RunFailure::Other),
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
            let known = matches!(kind, RunFailure::UntrustedFolder { .. } | RunFailure::NotSignedIn | RunFailure::ClaudeMissing | RunFailure::CapReached);
            let expected = if known { kind } else { RunFailure::Other };
            assert_eq!(RunFailure::from_message(&why.to_string()), expected, "{why:?}");
        }
    }
}
