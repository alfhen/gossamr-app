//! Sets `HARNESS_BUILD_ID`: the value of that variable when the build has one, otherwise the commit the crate was
//! compiled at, with `-dirty` when the crate's own files had changes, otherwise `unknown` (no git, or not a checkout).

use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=HARNESS_BUILD_ID");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=src");
    let id = std::env::var("HARNESS_BUILD_ID").ok().filter(|id| !id.trim().is_empty()).or_else(from_git).unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=HARNESS_BUILD_ID={}", id.trim());
}

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok().filter(|out| out.status.success())?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

fn from_git() -> Option<String> {
    let commit = git(&["rev-parse", "--short=12", "HEAD"])?;
    // A commit moves HEAD, or the branch HEAD names, or the packed refs.
    let branch = git(&["symbolic-ref", "-q", "HEAD"]);
    for name in ["HEAD", "packed-refs"].into_iter().map(str::to_owned).chain(branch) {
        if let Some(path) = git(&["rev-parse", "--git-path", &name]) {
            println!("cargo:rerun-if-changed={path}");
        }
    }
    let dirty = git(&["status", "--porcelain", "--", "."]).is_some_and(|changes| !changes.is_empty());
    Some(if dirty { format!("{commit}-dirty") } else { commit })
}
