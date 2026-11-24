//! Fakes for tests of this crate and of crates that use it.

use std::path::{Path, PathBuf};

/// The one executable every fake CLI links to. It runs the script kept beside the link as `<link>.body`.
pub const RUN_BODY: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/test-support/run-body.sh");

/// A fake CLI at `path` that runs `body` with `/bin/sh`. macOS checks each new executable the first time it runs, and
/// with many tests writing fakes at once that check has taken 15 s here, past the limits the code under test sets. So
/// the fake is a link to `RUN_BODY`, which is checked once, and its script is data. A file the test means to make
/// unrunnable is written as a file of its own, never through this link.
pub fn fake_cli(path: &Path, body: &str) -> PathBuf {
    std::fs::create_dir_all(path.parent().expect("a fake has a folder")).unwrap();
    let mut body_path = path.as_os_str().to_owned();
    body_path.push(".body");
    std::fs::write(&body_path, format!("{body}\n")).unwrap();
    if path.symlink_metadata().is_err() {
        std::os::unix::fs::symlink(RUN_BODY, path).unwrap();
    }
    path.to_path_buf()
}
