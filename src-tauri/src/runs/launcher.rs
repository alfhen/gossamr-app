//! What starts a queued run. Queuing commits first; starting is a separate step that belongs to the run.

use async_trait::async_trait;

use crate::error::Result;

#[async_trait]
pub trait RunLauncher: Send + Sync {
    async fn launch(&self, run_id: &str) -> Result<()>;
}
