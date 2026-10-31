//! The token the GitHub CLI holds, asked for each time one is needed. `gh` may renew an expiring token on its own, so
//! Gossamr never keeps a copy.

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use async_trait::async_trait;

use crate::error::{Error, Result};
use crate::probe::{run_gh, Ran, TIMEOUT};

/// A GUI app's PATH is minimal, so the usual places for `gh` are tried as well.
const GH_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];

pub fn path_dirs() -> Vec<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path).chain(GH_DIRS.iter().map(PathBuf::from)).collect()
}

pub fn find_gh_in(dirs: &[PathBuf]) -> Option<PathBuf> {
    dirs.iter().map(|d| d.join("gh")).find(|p| p.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
}

/// Where a request gets its token from.
#[async_trait]
pub trait CredentialSource: Send + Sync {
    /// The token to send now. A failure to get one is a 401 when the account has none to give.
    async fn token(&self) -> Result<String>;
}

/// The token `gh` holds for one account.
pub struct GhCredentials {
    gh_dirs: Vec<PathBuf>,
    host: String,
    login: String,
}

impl GhCredentials {
    pub fn new(gh_dirs: &[PathBuf], host: &str, login: &str) -> Self {
        Self { gh_dirs: gh_dirs.to_vec(), host: host.into(), login: login.into() }
    }
}

#[async_trait]
impl CredentialSource for GhCredentials {
    async fn token(&self) -> Result<String> {
        gh_token(&self.gh_dirs, &self.host, Some(&self.login)).await
    }
}

fn unauthorized(message: String) -> Error {
    Error::CodeHost { status: 401, message }
}

fn is_login(login: &str) -> bool {
    !login.is_empty() && !login.starts_with('-') && login.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Runs `gh auth token` for `login`, or for the active account when none is named. It reads one account and never
/// switches to it, and `gh`'s own files are never read.
pub async fn gh_token(gh_dirs: &[PathBuf], host: &str, login: Option<&str>) -> Result<String> {
    let login_command = format!("gh auth login -h {host}");
    let Some(gh) = find_gh_in(gh_dirs) else { return Err(unauthorized("gh isn't installed here.".into())) };
    let mut args = vec!["auth", "token", "-h", host];
    if let Some(login) = login {
        // A login that starts with a dash would be read as a flag.
        if !is_login(login) {
            return Err(Error::Input(format!("{login} isn't a GitHub login.")));
        }
        args.extend(["-u", login]);
    }
    match run_gh(&gh, &args, TIMEOUT).await {
        Ran::TimedOut => Err(Error::CodeHost { status: 504, message: "gh didn't answer in time. If macOS is asking for Keychain access, allow it, then try again.".into() }),
        Ran::Failed => Err(Error::CodeHost { status: 503, message: "Gossamr couldn't run gh.".into() }),
        Ran::Output { ok, stdout } => {
            let token = stdout.trim();
            if !ok || token.is_empty() {
                let whose = login.map_or_else(|| format!("on {host}"), |l| format!("for {l} on {host}"));
                return Err(unauthorized(format!("gh has no token {whose}. Run `{login_command}` in a terminal.")));
            }
            Ok(token.into())
        }
    }
}

/// A token that never changes, for tests that don't run `gh`.
#[cfg(test)]
pub struct FixedToken(pub &'static str);

#[cfg(test)]
#[async_trait]
impl CredentialSource for FixedToken {
    async fn token(&self) -> Result<String> {
        Ok(self.0.into())
    }
}

/// A folder whose `gh` prints `token` for `auth token`, and nothing for anything else.
#[cfg(test)]
pub fn fake_gh(token: &str) -> Vec<PathBuf> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static N: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!("gossamr-fake-gh-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("gh");
    std::fs::write(&path, format!("#!/bin/sh\n[ \"$1 $2\" = \"auth token\" ] && echo '{token}'\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    vec![dir]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gh(script: &str) -> Vec<PathBuf> {
        let dirs = fake_gh("unused");
        std::fs::write(dirs[0].join("gh"), format!("#!/bin/sh\n{script}\n")).unwrap();
        dirs
    }

    #[tokio::test]
    async fn a_named_login_gets_its_own_token_and_never_the_active_one() {
        let dirs = gh("if [ \"$*\" = \"auth token -h github.com -u work\" ]; then echo gho_work; else echo gho_active; fi");
        assert_eq!(gh_token(&dirs, "github.com", Some("work")).await.unwrap(), "gho_work");
        assert_eq!(gh_token(&dirs, "github.com", None).await.unwrap(), "gho_active");
    }

    #[tokio::test]
    async fn an_enterprise_managed_login_with_an_underscore_is_accepted() {
        let dirs = gh("if [ \"$*\" = \"auth token -h github.com -u octocat_acme\" ]; then echo gho_emu; fi");
        assert_eq!(gh_token(&dirs, "github.com", Some("octocat_acme")).await.unwrap(), "gho_emu");
    }

    #[tokio::test]
    async fn a_login_that_could_pass_for_a_flag_is_refused_before_gh_runs() {
        let dirs = gh("echo gho_x");
        for login in ["--hostname", "-u", "a b", "", "a;b", "a/b"] {
            assert!(gh_token(&dirs, "github.com", Some(login)).await.unwrap_err().to_string().contains("isn't a GitHub login"), "{login}");
        }
    }

    #[tokio::test]
    async fn gh_missing_or_without_the_login_is_unauthorised_and_names_the_command_to_run() {
        let missing = gh_token(&[PathBuf::from("/nonexistent")], "github.com", Some("ann")).await.unwrap_err();
        assert!(missing.is_unauthorized() && missing.to_string().contains("isn't installed"), "{missing}");
        for script in ["echo 'no oauth token found' >&2; exit 1", "exit 0"] {
            let out = gh_token(&gh(script), "github.com", Some("ann")).await.unwrap_err();
            assert!(out.is_unauthorized() && out.to_string().contains("gh auth login -h github.com"), "{out}");
        }
    }

    #[tokio::test]
    async fn the_variables_that_override_gh_s_stored_token_are_cleared() {
        let dirs = gh("[ -n \"$GH_TOKEN$GITHUB_TOKEN$GH_HOST\" ] && exit 1\necho gho_stored");
        std::env::set_var("GITHUB_TOKEN", "from-the-environment");
        let token = gh_token(&dirs, "github.com", Some("ann")).await;
        std::env::remove_var("GITHUB_TOKEN");
        assert_eq!(token.unwrap(), "gho_stored");
    }

    #[tokio::test]
    async fn the_credential_source_asks_gh_each_time_and_sees_a_renewed_token() {
        let dirs = gh("echo gho_one");
        let source = GhCredentials::new(&dirs, "github.com", "ann");
        assert_eq!(source.token().await.unwrap(), "gho_one");
        std::fs::write(dirs[0].join("gh"), "#!/bin/sh\necho gho_two\n").unwrap();
        assert_eq!(source.token().await.unwrap(), "gho_two");
    }
}
