//! The per-run config file that points a session at Gossamr's MCP server, and where it is kept.
//!
//! The server address and the run's token live in the file and nowhere on a command line or in an environment
//! variable: argv is visible to every process of the user, and the daemon that runs `--bg` sessions is shared, so a
//! per-launch variable could not reach the session anyway.

use std::path::{Path, PathBuf};

use serde_json::json;

use crate::domain::{AGENT_CALL_TIMEOUT_MS, AGENT_SERVER};

/// What a launch needs to offer the tools to a session: the config file that names the server and carries the token.
#[derive(Clone, PartialEq, Eq)]
pub struct AgentLaunch {
    pub config: PathBuf,
}

impl std::fmt::Debug for AgentLaunch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "AgentLaunch({})", self.config.display())
    }
}

/// Where the server listens and where per-run config files are kept.
#[derive(Debug)]
pub struct AgentChannel {
    port: u16,
    dir: PathBuf,
}

pub fn plain_id(run_id: &str) -> bool {
    (1..=64).contains(&run_id.len()) && run_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

impl AgentChannel {
    pub fn new(port: u16, dir: PathBuf) -> Self {
        Self { port, dir }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn url_for(&self, run_id: &str) -> String {
        format!("http://127.0.0.1:{}/agent/{run_id}", self.port)
    }

    fn config_path(&self, run_id: &str) -> Option<PathBuf> {
        plain_id(run_id).then(|| self.dir.join(format!("{run_id}.json")))
    }

    /// Writes the run's MCP config where only this user can read it. A second call for the same run replaces the file,
    /// and every token minted for the run stays valid on the server.
    pub fn write_config(&self, run_id: &str, token: &str) -> std::io::Result<AgentLaunch> {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let path = self.config_path(run_id).ok_or_else(|| std::io::Error::other("not a run id"))?;
        std::fs::create_dir_all(&self.dir)?;
        std::fs::set_permissions(&self.dir, std::fs::Permissions::from_mode(0o700))?;
        let config = json!({ "mcpServers": { AGENT_SERVER: { "type": "http", "url": self.url_for(run_id), "headers": { "Authorization": format!("Bearer {token}") }, "timeout": AGENT_CALL_TIMEOUT_MS } } });
        let temp = path.with_extension("json.tmp");
        let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&temp)?;
        file.write_all(config.to_string().as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&temp, &path).inspect_err(|_| {
            let _ = std::fs::remove_file(&temp);
        })?;
        Ok(AgentLaunch { config: path })
    }

    pub fn remove_config(&self, run_id: &str) {
        if let Some(path) = self.config_path(run_id) {
            let _ = std::fs::remove_file(path);
        }
    }

    /// The runs that have a config file.
    pub fn configured(&self) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return Vec::new() };
        entries.filter_map(|e| e.ok()?.file_name().to_str()?.strip_suffix(".json").filter(|id| plain_id(id)).map(str::to_owned)).collect()
    }
}

/// The folder per-run config files and the server's remembered port live in, under the app's data folder.
pub fn config_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("agents")
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use serde_json::Value;

    use super::*;
    use crate::runs::report::{new_token, well_formed};

    #[test]
    fn a_runs_config_is_readable_by_its_owner_alone_and_holds_the_token_the_cli_is_given_nowhere_else() {
        let dir = std::env::temp_dir().join(format!("gossamr-agent-config-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let channel = AgentChannel::new(4321, dir.join("agents"));
        let token = new_token().unwrap();
        assert!(well_formed(&token));
        let launch = channel.write_config("run-1", &token).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!((mode(&launch.config), mode(&dir.join("agents"))), (0o600, 0o700));
        let config: Value = serde_json::from_str(&std::fs::read_to_string(&launch.config).unwrap()).unwrap();
        let server = &config["mcpServers"]["gossamr"];
        assert_eq!((server["type"].as_str(), server["url"].as_str()), (Some("http"), Some("http://127.0.0.1:4321/agent/run-1")));
        assert_eq!(server["headers"]["Authorization"], format!("Bearer {token}"));
        assert_eq!(server["timeout"], 600_000, "above how long ask waits");
        assert!(!format!("{launch:?}").contains(&token[4..]), "the launch prints a path, never the token");

        let newer = new_token().unwrap();
        channel.write_config("run-1", &newer).unwrap();
        assert!(std::fs::read_to_string(&launch.config).unwrap().contains(&newer[4..]));
        assert_eq!(channel.configured(), ["run-1"]);
        channel.remove_config("run-1");
        assert!(channel.configured().is_empty() && !launch.config.exists());
        for bad in ["", "../x", "a/b", "a b", "..", &"a".repeat(65)] {
            assert!(channel.write_config(bad, &token).is_err(), "{bad:?}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
