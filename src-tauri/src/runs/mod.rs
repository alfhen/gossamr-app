//! Everything that runs the user's `claude` binary for background agent runs.
#![allow(dead_code)]

pub mod agent_config;
pub mod answer;
pub mod archive;
pub mod backend;
pub mod cleanup;
pub mod cli;
pub mod codex;
mod continuation;
pub mod control;
pub mod failure;
pub mod message;
mod final_answer;
mod finder;
mod offer;
pub mod index;
pub mod launcher;
pub mod limits;
pub mod notices;
pub mod pr;
pub mod redact;
pub mod report;
pub mod result;
pub mod service;
pub mod state;
pub mod toolchain;
pub mod transcript;
pub mod tracker;
pub mod trust;

/// Clones, git, the shell environment and the provider logins belong to the harness; the app reaches them by these paths.
pub use harness::{ask, binary, codex_models, env, fresh, provider_env, provider_folder, repo};

#[cfg(test)]
mod real_tests;
#[cfg(test)]
pub(crate) mod rig;
#[cfg(test)]
mod testing;
