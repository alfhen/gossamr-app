//! Everything that runs the user's `claude` binary for background agent runs.
#![allow(dead_code)]

pub mod answer;
pub mod binary;
pub mod cleanup;
pub mod cli;
pub mod control;
pub mod enable;
pub mod env;
pub mod failure;
mod final_answer;
mod finder;
pub mod fresh;
pub mod index;
pub mod launcher;
pub mod limits;
pub mod pr;
pub mod preflight;
pub mod redact;
pub mod repo;
pub mod result;
pub mod service;
pub mod state;
pub mod toolchain;
pub mod transcript;
pub mod tracker;
pub mod trust;

#[cfg(test)]
mod real_tests;
#[cfg(test)]
pub(crate) mod rig;
#[cfg(test)]
mod testing;
