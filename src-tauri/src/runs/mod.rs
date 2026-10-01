//! Everything that runs the user's `claude` binary for background agent runs.
#![allow(dead_code)]

pub mod binary;
pub mod cli;
pub mod control;
pub mod env;
pub mod failure;
pub mod index;
pub mod launcher;
pub mod preflight;
pub mod redact;
pub mod repo;
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
