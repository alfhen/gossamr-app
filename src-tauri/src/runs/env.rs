//! The person's interactive shell environment, captured once.
//!
//! The Claude daemon is shared and inherits the environment of whichever `claude` starts it, so every `claude` we
//! run gets exactly this environment and nothing per launch.

use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::OsStringExt;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

use crate::error::{Error, Result};

const CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);
const FALLBACK_SHELL: &str = "/bin/zsh";
/// Printed before `env -0` so banner text from an rc file can't be glued onto the first variable.
const MARKER: &str = "GOSSAMR_ENV_BEGIN";

#[derive(Clone, PartialEq, Eq)]
pub struct RunEnv {
    vars: Vec<(OsString, OsString)>,
}

// Values can hold secrets, so nothing prints them.
impl std::fmt::Debug for RunEnv {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "RunEnv({} variables)", self.vars.len())
    }
}

impl RunEnv {
    pub fn from_pairs<K: Into<OsString>, V: Into<OsString>>(pairs: impl IntoIterator<Item = (K, V)>) -> Self {
        Self { vars: pairs.into_iter().map(|(k, v)| (k.into(), v.into())).collect() }
    }

    #[cfg(test)]
    pub fn with(mut self, key: &str, value: &str) -> Self {
        self.vars.retain(|(k, _)| k != OsStr::new(key));
        self.vars.push((key.into(), value.into()));
        self
    }

    pub fn len(&self) -> usize {
        self.vars.len()
    }

    pub fn get(&self, key: &str) -> Option<&OsStr> {
        self.vars.iter().find(|(k, _)| k == OsStr::new(key)).map(|(_, v)| v.as_os_str())
    }

    /// Replaces the command's whole environment. Adding anything afterwards would reach the shared daemon.
    pub fn apply(&self, cmd: &mut std::process::Command) {
        cmd.env_clear();
        cmd.envs(self.vars.iter().map(|(k, v)| (k, v)));
    }

    fn parse(raw: &[u8]) -> Option<Self> {
        let marker = [b'\0'].into_iter().chain(MARKER.bytes()).chain([b'\0']).collect::<Vec<u8>>();
        let at = raw.windows(marker.len()).position(|w| w == marker.as_slice())?;
        let vars = raw[at + marker.len()..]
            .split(|b| *b == 0)
            .filter_map(|entry| {
                let eq = entry.iter().position(|b| *b == b'=')?;
                let key = &entry[..eq];
                valid_key(key).then(|| (OsString::from_vec(key.to_vec()), OsString::from_vec(entry[eq + 1..].to_vec())))
            })
            .collect();
        Some(Self { vars })
    }
}

fn valid_key(key: &[u8]) -> bool {
    let mut it = key.iter();
    matches!(it.next(), Some(b) if b.is_ascii_alphabetic() || *b == b'_') && it.all(|b| b.is_ascii_alphanumeric() || *b == b'_')
}

/// `shell` is `$SHELL`; an empty value falls back to zsh. Interactive and login, so `.zshrc` PATH additions count.
pub async fn capture(shell: &str) -> Result<RunEnv> {
    let shell = if shell.trim().is_empty() { FALLBACK_SHELL } else { shell };
    let script = format!("printf '\\0{MARKER}\\0'; env -0");
    let child = Command::new(shell)
        .args(["-ilc", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let out = tokio::time::timeout(CAPTURE_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| Error::Claude("Couldn't read your shell environment: your shell took too long to start.".into()))??;
    if !out.status.success() {
        return Err(Error::Claude("Couldn't read your shell environment: your shell exited with an error.".into()));
    }
    RunEnv::parse(&out.stdout)
        .filter(|e| e.len() > 0)
        .ok_or_else(|| Error::Claude("Couldn't read your shell environment: it printed no variables.".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn nul(parts: &[&str]) -> Vec<u8> {
        parts.iter().flat_map(|p| p.bytes().chain([0])).collect()
    }

    fn script(dir: &Path, name: &str, body: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("gossamr-runs-env-{tag}-{}", std::process::id()))
    }

    #[test]
    fn parses_nul_separated_pairs_after_the_marker() {
        let mut raw = b"Welcome back\n\0".to_vec();
        raw.extend(nul(&[MARKER, "PATH=/usr/bin:/opt/x", "EMPTY=", "MULTI=a\nb=c", "bad key=1", "=x", "9X=1"]));
        let env = RunEnv::parse(&raw).unwrap();
        assert_eq!(env.get("PATH").unwrap(), "/usr/bin:/opt/x");
        assert_eq!(env.get("EMPTY").unwrap(), "");
        assert_eq!(env.get("MULTI").unwrap(), "a\nb=c", "only the first = splits");
        assert_eq!(env.len(), 3, "entries with invalid names are dropped");
        assert!(RunEnv::parse(&nul(&["PATH=/x"])).is_none(), "without the marker nothing can be trusted");
    }

    #[test]
    fn apply_leaves_only_the_captured_variables() {
        let env = RunEnv::from_pairs([("PATH", "/usr/bin:/bin"), ("HOME", "/home/x")]);
        let mut cmd = std::process::Command::new("/usr/bin/env");
        cmd.env("LEAK", "1").env("CLAUDE_CODE_X", "1");
        env.apply(&mut cmd);
        let set: Vec<_> = cmd.get_envs().map(|(k, v)| (k.to_owned(), v.map(OsStr::to_owned))).collect();
        assert_eq!(set.len(), 2);
        assert!(set.iter().all(|(_, v)| v.is_some()));
        let out = cmd.output().unwrap();
        let mut lines: Vec<_> = String::from_utf8(out.stdout).unwrap().lines().map(String::from).collect();
        lines.sort();
        assert_eq!(lines, ["HOME=/home/x", "PATH=/usr/bin:/bin"], "the child sees exactly the capture");
    }

    #[test]
    fn debug_never_prints_values() {
        let env = RunEnv::from_pairs([("API_KEY", "super-secret-value")]);
        assert_eq!(format!("{env:?}"), "RunEnv(1 variables)");
    }

    #[tokio::test]
    async fn captures_from_the_given_shell_ignoring_banner_output() {
        let dir = scratch("ok");
        let sh = script(&dir, "fakeshell", "echo 'hello from rc'; printf '\\0GOSSAMR_ENV_BEGIN\\0PATH=/p\\0FOO=bar\\0'");
        let env = capture(&sh).await.unwrap();
        assert_eq!(env.get("FOO").unwrap(), "bar");
        assert_eq!(env.len(), 2);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn failure_modes_are_errors_not_empty_environments() {
        let dir = scratch("bad");
        let silent = script(&dir, "silent", "exit 0");
        assert!(capture(&silent).await.is_err());
        let failing = script(&dir, "failing", "printf '\\0GOSSAMR_ENV_BEGIN\\0A=1\\0'; exit 3");
        assert!(capture(&failing).await.is_err());
        assert!(capture("/nonexistent/shell").await.is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_real_shell_yields_a_path() {
        let env = capture("/bin/sh").await.unwrap();
        assert!(env.get("PATH").is_some_and(|p| !p.is_empty()));
    }
}
