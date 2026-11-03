//! The per-run config file that points a session at Gossamr's MCP server, and where it is kept.
//!
//! The server address and the run's token live in the file and nowhere on a command line or in an environment
//! variable: argv is visible to every process of the user, and the daemon that runs `--bg` sessions is shared, so a
//! per-launch variable could not reach the session anyway.

use std::path::{Path, PathBuf};

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

/// The file a run's config is kept in, `None` for an id that isn't a plain run id. Whatever writes the file and
/// `AgentChannel::{remove_config, configured}` must agree on this.
pub fn config_path(dir: &Path, run_id: &str) -> Option<PathBuf> {
    plain_id(run_id).then(|| dir.join(format!("{run_id}.json")))
}

impl AgentChannel {
    pub fn new(port: u16, dir: PathBuf) -> Self {
        Self { port, dir }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn url_for(&self, run_id: &str) -> String {
        format!("http://127.0.0.1:{}/agent/{run_id}", self.port)
    }

    fn config_path(&self, run_id: &str) -> Option<PathBuf> {
        config_path(&self.dir, run_id)
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
    use super::*;

    #[test]
    fn a_config_file_is_named_for_a_plain_run_id_alone() {
        let channel = AgentChannel::new(4321, PathBuf::from("/data/agents"));
        assert_eq!(channel.config_path("run-1"), Some(PathBuf::from("/data/agents/run-1.json")));
        for bad in ["", "../x", "a/b", "a b", "..", &"a".repeat(65)] {
            assert_eq!(channel.config_path(bad), None, "{bad:?}");
        }
        assert_eq!(channel.url_for("run-1"), "http://127.0.0.1:4321/agent/run-1");
    }
}
