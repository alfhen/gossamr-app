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
/// `.zshrc` adds (an npm `codex` under nvm), then the copy an app bundles. A copy on PATH wins over a bundled one
/// because the person put it there.
pub fn find_binary(driver: Driver, shell: &RunEnv) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let apps = [PathBuf::from("/Applications"), home.join("Applications")];
    find_with(driver, &home, &apps, shell.get("PATH"))
}

fn find_with(driver: Driver, home: &Path, apps: &[PathBuf], path: Option<&OsStr>) -> Option<PathBuf> {
    find_in(&installed(driver, home), driver.binary(), path).or_else(|| bundled(driver, apps))
}

/// Where apps that ship the Codex CLI keep it. ChatGPT.app is the one the owner's Mac has, and it is not on PATH.
const BUNDLED_CODEX: [&str; 2] = ["Contents/Resources/codex-cli/bin/codex", "Contents/Resources/bin/codex"];
const PREFERRED_APP: &str = "ChatGPT.app";

/// The Codex CLI inside an app under `roots`: ChatGPT.app first, then the others in name order.
fn bundled(driver: Driver, roots: &[PathBuf]) -> Option<PathBuf> {
    if driver != Driver::Codex {
        return None;
    }
    let apps = roots.iter().flat_map(|root| {
        let mut apps: Vec<PathBuf> = std::fs::read_dir(root).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "app")).collect();
        apps.sort();
        apps
    });
    let (preferred, others): (Vec<_>, Vec<_>) = apps.partition(|app| app.file_name().is_some_and(|n| n == PREFERRED_APP));
    preferred.into_iter().chain(others).flat_map(|app| BUNDLED_CODEX.map(|inside| app.join(inside))).find(|p| runnable(p))
}

fn runnable(path: &Path) -> bool {
    path.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
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
    fixed.iter().cloned().chain(on_path).find(|p| runnable(p))
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

    fn app(root: &Path, name: &str, inside: &str) -> PathBuf {
        tool(&root.join(name).join(Path::new(inside).parent().unwrap()), "codex", "#!/bin/sh\n")
    }

    #[test]
    fn a_codex_bundled_in_chatgpt_is_found_when_nothing_else_has_one() {
        let dir = scratch("chatgpt");
        let wanted = app(&dir, "ChatGPT.app", BUNDLED_CODEX[0]);
        app(&dir, "Conductor.app", BUNDLED_CODEX[1]);
        assert_eq!(bundled(Driver::Codex, std::slice::from_ref(&dir)), Some(wanted));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn chatgpt_is_preferred_over_other_apps_even_in_a_later_folder() {
        let dir = scratch("order");
        let (system, user) = (dir.join("Applications"), dir.join("home/Applications"));
        app(&system, "Conductor.app", BUNDLED_CODEX[1]);
        let wanted = app(&user, "ChatGPT.app", BUNDLED_CODEX[0]);
        assert_eq!(bundled(Driver::Codex, &[system.clone(), user]), Some(wanted));
        let other = app(&system, "Another.app", BUNDLED_CODEX[0]);
        assert_eq!(bundled(Driver::Codex, &[system]).as_deref(), Some(other.as_path()), "without ChatGPT the apps go in name order");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_bundled_file_that_cannot_run_a_missing_folder_and_claude_find_nothing() {
        let dir = scratch("none");
        let plain = app(&dir, "ChatGPT.app", BUNDLED_CODEX[0]);
        std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(bundled(Driver::Codex, std::slice::from_ref(&dir)), None);
        assert_eq!(bundled(Driver::Codex, &[dir.join("missing")]), None);
        std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(bundled(Driver::Claude, std::slice::from_ref(&dir)), None, "only Codex ships inside other apps");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_codex_on_the_shell_path_wins_over_a_bundled_one() {
        let dir = scratch("pathfirst");
        app(&dir.join("Applications"), "ChatGPT.app", BUNDLED_CODEX[0]);
        let on_path = tool(&dir.join("nvm"), "codex", "#!/bin/sh\n");
        let path = std::env::join_paths([dir.join("nvm")]).unwrap();
        let apps = [dir.join("Applications")];
        let nowhere = dir.join("home");
        assert_eq!(find_with(Driver::Codex, &nowhere, &apps, Some(&path)), Some(on_path));
        assert_eq!(find_with(Driver::Codex, &nowhere, &apps, None), bundled(Driver::Codex, &apps));
        assert_eq!(find_with(Driver::Claude, &nowhere, &apps, None), None);
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
