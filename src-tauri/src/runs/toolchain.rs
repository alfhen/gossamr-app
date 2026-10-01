//! The `claude` command and the shell environment it runs in, found once and reused.

use std::sync::Arc;

use async_trait::async_trait;

use super::binary::find_claude;
use super::cli::{ClaudeCli, SystemCli};
use super::env::{capture, RunEnv};

#[derive(Clone)]
pub struct Toolchain {
    pub cli: Arc<dyn ClaudeCli>,
    pub env: Arc<RunEnv>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToolchainError {
    ClaudeMissing,
    /// The shell environment couldn't be read. Launching without it would hand the shared Claude daemon the app's
    /// own environment instead, so nothing is started.
    NoEnvironment(String),
}

#[async_trait]
pub trait ToolchainSource: Send + Sync {
    async fn get(&self) -> Result<Toolchain, ToolchainError>;
}

/// Finds `claude` and captures `$SHELL -ilc 'env -0'` on first use. A failure is tried again next time, so fixing the
/// problem doesn't need a restart.
#[derive(Default)]
pub struct SystemToolchain {
    found: tokio::sync::Mutex<Option<Toolchain>>,
}

#[async_trait]
impl ToolchainSource for SystemToolchain {
    async fn get(&self) -> Result<Toolchain, ToolchainError> {
        let mut found = self.found.lock().await;
        if let Some(t) = &*found {
            return Ok(t.clone());
        }
        let binary = tokio::task::spawn_blocking(find_claude).await.ok().flatten().ok_or(ToolchainError::ClaudeMissing)?;
        let env = capture(&std::env::var("SHELL").unwrap_or_default()).await.map_err(|e| ToolchainError::NoEnvironment(e.to_string()))?;
        let env = Arc::new(env);
        let t = Toolchain { cli: Arc::new(SystemCli::new(binary, env.clone())), env };
        *found = Some(t.clone());
        Ok(t)
    }
}

#[cfg(test)]
pub struct FixedToolchain(pub Result<Toolchain, ToolchainError>);

#[cfg(test)]
#[async_trait]
impl ToolchainSource for FixedToolchain {
    async fn get(&self) -> Result<Toolchain, ToolchainError> {
        self.0.clone()
    }
}
