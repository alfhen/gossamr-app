//! Everything that runs the user's `claude` binary for background agent runs.
#![allow(dead_code)]

pub mod agent_config;
pub mod answer;
pub mod ask;
pub mod archive;
pub mod binary;
pub mod cleanup;
pub mod cli;
mod continuation;
pub mod control;
pub mod env;
pub mod failure;
pub mod message;
mod final_answer;
mod finder;
mod offer;
pub mod fresh;
pub mod index;
pub mod launcher;
pub mod limits;
pub mod notices;
pub mod pr;
pub mod redact;
pub mod report;
pub mod repo;
pub mod result;
pub mod service;
pub mod state;
pub mod toolchain;
pub mod transcript;
pub mod tracker;

#[cfg(test)]
mod real_tests;
#[cfg(test)]
pub(crate) mod rig;
#[cfg(test)]
mod testing;
