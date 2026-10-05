//! The part of `Core` the run-report tool reaches, and the bookkeeping around it. A call here can store one validated
//! report on one run; it can't read a ticket, make a draft or touch a tracker.

use async_trait::async_trait;
use chrono::Utc;
use serde_json::Value;

use super::Core;
use crate::error::Result;
use crate::runs::report::{Reply, ReportSink, StoredReport};

#[async_trait]
impl ReportSink for Core {
    async fn call(&self, run_id: &str, token_hash: &str, args: &Value) -> Reply {
        match self.with_db(|db| db.record_report(run_id, token_hash, args, Utc::now())).await {
            Ok(reply) => reply,
            Err(_) => Reply::Unavailable,
        }
    }
}

impl Core {
    /// Notes that a launch of `run_id` was given a token. Earlier tokens of the run stay valid.
    pub async fn report_reserve(&self, run_id: &str, token_hash: &str, tool_version: u32) -> Result<()> {
        self.with_db(|db| db.reserve_report_token(run_id, token_hash, tool_version, Utc::now())).await
    }

    /// The run's report row; `None` when it was never offered the tool.
    pub async fn report_stored(&self, run_id: &str) -> Result<Option<StoredReport>> {
        self.with_db(|db| db.report(run_id)).await
    }

    /// A report made before the person answered or carried on no longer stands for the run.
    pub async fn report_stale(&self, run_id: &str) -> Result<()> {
        self.with_db(|db| db.mark_report_stale(run_id)).await
    }

    pub async fn report_forget(&self, run_id: &str) -> Result<()> {
        self.with_db(|db| db.forget_report_tokens(run_id)).await
    }
}

#[cfg(test)]
mod tests;
