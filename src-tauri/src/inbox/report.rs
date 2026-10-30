//! The part of `Core` the agent tools reach, and the bookkeeping around it. A report call can store one validated
//! report on one run; the other tools read what the run was already told.

use chrono::Utc;
use serde_json::Value;

use super::Core;
use crate::domain::Run;
use crate::error::Result;
use crate::runs::report::{Reply, StoredReport};

impl Core {
    /// Stores a call's report, if the token is the one minted for that run and the run is still open to it.
    pub async fn report_call(&self, run_id: &str, token_hash: &str, args: &Value) -> Reply {
        match self.with_app_db(|db| db.record_report(run_id, token_hash, args, Utc::now())).await {
            Ok(reply) => reply,
            Err(_) => Reply::Unavailable,
        }
    }

    /// The run a tool call may act for: `token_hash` was minted for it and it is in a state that takes calls.
    pub async fn agent_run(&self, run_id: &str, token_hash: &str) -> Result<Option<Run>> {
        self.with_app_db(|db| db.agent_run(run_id, token_hash)).await
    }

    /// Notes that a launch of `run_id` was given a token. Earlier tokens of the run stay valid.
    pub async fn report_reserve(&self, run_id: &str, token_hash: &str, tool_version: u32) -> Result<()> {
        self.with_app_db(|db| db.reserve_report_token(run_id, token_hash, tool_version, Utc::now())).await
    }

    /// The run's report row; `None` when it was never offered the tools.
    pub async fn report_stored(&self, run_id: &str) -> Result<Option<StoredReport>> {
        self.with_app_db(|db| db.report(run_id)).await
    }

    /// A report made before the person answered or carried on no longer stands for the run.
    pub async fn report_stale(&self, run_id: &str) -> Result<()> {
        self.with_app_db(|db| db.mark_report_stale(run_id)).await
    }

    pub async fn report_forget(&self, run_id: &str) -> Result<()> {
        self.with_app_db(|db| db.forget_report_tokens(run_id)).await
    }
}

#[cfg(test)]
mod tests;
