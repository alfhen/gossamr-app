//! Everything that runs the user's `claude` binary for background agent runs.
#![allow(dead_code)]

pub mod binary;
pub mod cli;
pub mod env;
pub mod launcher;

#[cfg(test)]
mod real_tests;
