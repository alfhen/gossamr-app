use std::ffi::OsStr;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use super::env::RunEnv;
use crate::connections::Driver;

/// GUI apps on macOS don't inherit the shell PATH, so look where installers put `claude` before asking a login shell.
pub fn find_claude() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    if let Some(found) = installed(Driver::Claude, &home).into_iter().find(|p| p.is_file()) {
        return Some(found);
    }
    let out = std::process::Command::new("/bin/zsh").args(["-lc", "command -v claude"]).output().ok()?;
    let path = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

/// The CLI of `driver`: where installers put it, then the PATH of the captured shell environment, which holds what
/// `.zshrc` adds (an npm `codex` under nvm).
pub fn find_binary(driver: Driver, shell: &RunEnv) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    find_in(&installed(driver, &home), driver.binary(), shell.get("PATH"))
}

fn installed(driver: Driver, home: &Path) -> Vec<PathBuf> {
    let name = driver.binary();
    let mut paths = vec![home.join(".local/bin").join(name)];
    if driver == Driver::Claude {
        paths.push(home.join(".claude/local/claude"));
    }
    paths.extend([PathBuf::from("/opt/homebrew/bin").join(name), PathBuf::from("/usr/local/bin").join(name)]);
    paths
}

fn find_in(fixed: &[PathBuf], name: &str, path: Option<&OsStr>) -> Option<PathBuf> {
    let on_path = path.into_iter().flat_map(std::env::split_paths).filter(|dir| dir.is_absolute()).map(|dir| dir.join(name));
    fixed.iter().cloned().chain(on_path).find(|p| p.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn tool(dir: &Path, name: &str, body: &str) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gossamr-binary-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_fixed_install_path_wins_over_the_shell_path() {
        let dir = scratch("fixed");
        let fixed = tool(&dir.join("fixed"), "codex", "#!/bin/sh\n");
        tool(&dir.join("shell"), "codex", "#!/bin/sh\n");
        let path = std::env::join_paths([dir.join("shell")]).unwrap();
        assert_eq!(find_in(std::slice::from_ref(&fixed), "codex", Some(&path)), Some(fixed));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_tool_only_the_shell_path_has_is_found_there_and_files_that_cant_run_are_skipped() {
        let dir = scratch("path");
        tool(&dir.join("plain"), "codex", "#!/bin/sh\n");
        std::fs::set_permissions(dir.join("plain/codex"), std::fs::Permissions::from_mode(0o644)).unwrap();
        let wanted = tool(&dir.join("nvm"), "codex", "#!/bin/sh\n");
        let path = std::env::join_paths([PathBuf::from("relative/bin"), dir.join("plain"), dir.join("nvm")]).unwrap();
        assert_eq!(find_in(&[], "codex", Some(&path)), Some(wanted));
        assert_eq!(find_in(&[], "codex", None), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_node_launcher_codex_is_found_on_the_captured_path_and_runs_with_it() {
        let dir = scratch("node");
        tool(&dir.join("node/bin"), "node", "#!/bin/sh\necho codex-cli 9.9.9\n");
        let codex = tool(&dir.join("nvm/bin"), "codex", "#!/usr/bin/env node\nconsole.log('unused');\n");
        let path = format!("{}:{}", dir.join("nvm/bin").display(), dir.join("node/bin").display());
        let shell = RunEnv::from_pairs([("PATH", path.as_str())]);

        let found = find_in(&[], "codex", shell.get("PATH")).unwrap();
        assert_eq!(found, codex);
        let mut cmd = Command::new(&found);
        cmd.arg("--version");
        shell.apply(&mut cmd);
        let out = cmd.output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "codex-cli 9.9.9", "the launcher needs node from the shell's PATH");
        let _ = std::fs::remove_dir_all(dir);
    }
}
