//! Sets `HARNESS_BUILD_ID`: the value of that variable when the build has one, otherwise the commit the crate was
//! compiled at, with `-dirty` when the crate's own files had changes, otherwise `unknown` (no git, or not a checkout).
//! The id is one word, because the harness hands it to clients as a token.

use std::path::Path;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=HARNESS_BUILD_ID");
    // Every file in the crate's folder counts for `-dirty`, so the whole folder is watched. Builds go to the
    // workspace's `target/`, outside it.
    println!("cargo:rerun-if-changed=.");
    let id = std::env::var("HARNESS_BUILD_ID").ok().map(|id| id.trim().to_owned()).filter(|id| !id.is_empty()).or_else(from_git).unwrap_or_else(|| "unknown".into());
    assert!(!id.contains(char::is_whitespace), "HARNESS_BUILD_ID must be one word, not {id:?}");
    println!("cargo:rustc-env=HARNESS_BUILD_ID={id}");
}

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok().filter(|out| out.status.success())?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

fn from_git() -> Option<String> {
    let commit = git(&["rev-parse", "--short=12", "HEAD"])?;
    // A commit or a checkout moves HEAD, the branch's ref (loose or packed) and HEAD's log. Cargo counts a watched file
    // that is missing as changed, so only the files that exist are watched; HEAD's log changes even when refs are packed.
    // With reflogs off and the branch ref packed, a commit changes none of these, and the id stays at the old commit.
    let branch = git(&["symbolic-ref", "-q", "HEAD"]);
    for name in ["HEAD", "logs/HEAD", "packed-refs"].into_iter().map(str::to_owned).chain(branch) {
        if let Some(path) = git(&["rev-parse", "--git-path", &name]).filter(|path| Path::new(path).exists()) {
            println!("cargo:rerun-if-changed={path}");
        }
    }
    let dirty = git(&["status", "--porcelain", "--", "."]).is_some_and(|changes| !changes.is_empty());
    Some(if dirty { format!("{commit}-dirty") } else { commit })
}
