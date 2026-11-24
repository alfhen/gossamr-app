//! Fakes for tests of this crate and of crates that use it.

use std::path::{Path, PathBuf};

/// The one executable every fake CLI links to. It runs the script kept beside the link as `<link>.body`.
pub const RUN_BODY: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/test-support/run-body.sh");

/// A launcher that starts the way an npm-installed CLI does: `env` runs `node` with it.
pub const NODE_LAUNCHER: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/test-support/node-launcher");

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

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    /// A mode set or a write made through a fake's link changes these files for every fake, and git keeps the change.
    #[test]
    fn the_shared_fake_scripts_keep_their_content_and_mode() {
        let expected = [
            (super::RUN_BODY, "exec /bin/sh \"$0.body\" \"$@\"\n"),
            (super::NODE_LAUNCHER, "#!/usr/bin/env node\n"),
        ];
        for (path, part) in expected {
            let text = std::fs::read_to_string(path).unwrap();
            assert!(text.contains(part) && text.len() < 600, "{} changed", path.rsplit('/').next().unwrap());
            let mode = std::fs::metadata(path).unwrap().permissions().mode();
            assert!(mode & 0o100 != 0, "{} can't be run by its owner any more", path.rsplit('/').next().unwrap());
        }
    }
}
