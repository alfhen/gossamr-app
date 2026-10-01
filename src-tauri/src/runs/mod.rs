//! Everything that runs the user's `claude` binary for background agent runs.
#![allow(dead_code)]

pub mod binary;
pub mod cli;
pub mod control;
pub mod enable;
pub mod env;
pub mod failure;
mod finder;
pub mod fresh;
pub mod index;
pub mod launcher;
pub mod pr;
pub mod preflight;
pub mod redact;
pub mod repo;
pub mod result;
pub mod service;
pub mod state;
pub mod toolchain;
pub mod tracker;

#[cfg(test)]
mod real_tests;
#[cfg(test)]
mod rig;
#[cfg(test)]
mod testing;
