//! Claude Code. `driver` runs it for the harness; `pip` is Pip's locked launch, which the app runs; `stream` reads
//! what `claude -p` prints for Pip.

pub mod driver;
pub mod pip;
pub mod stream;
