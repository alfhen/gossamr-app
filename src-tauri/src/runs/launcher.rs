//! What starts an approved run. The approval commits first; starting is a separate step that belongs to the run.

use async_trait::async_trait;

use crate::error::Result;

#[async_trait]
pub trait RunLauncher: Send + Sync {
    async fn launch(&self, run_id: &str) -> Result<()>;
}

/// Leaves the run queued.
pub struct NoopLauncher;

#[async_trait]
impl RunLauncher for NoopLauncher {
    async fn launch(&self, _run_id: &str) -> Result<()> {
        Ok(())
    }
}
