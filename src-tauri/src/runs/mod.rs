//! Everything that runs the user's `claude` binary for background agent runs.
#![allow(dead_code)]

pub mod binary;
pub mod cli;
pub mod env;
pub mod failure;
pub mod index;
pub mod launcher;
pub mod preflight;
pub mod repo;
pub mod service;
pub mod toolchain;

#[cfg(test)]
mod real_tests;
#[cfg(test)]
mod testing;
