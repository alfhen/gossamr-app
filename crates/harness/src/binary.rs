use std::ffi::OsStr;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use crate::env::RunEnv;
use crate::provider::Provider;

/// GUI apps on macOS don't inherit the shell PATH, so look where installers put `claude` before asking a login shell.
pub fn find_claude() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    if let Some(found) = CliPlaces::of_this_mac(Some(home)).installed(Provider::Claude).into_iter().find(|p| p.is_file()) {
        return Some(found);
    }
    let out = std::process::Command::new("/bin/zsh").args(["-lc", "command -v claude"]).output().ok()?;
    let path = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

/// Where installers put the CLIs outside the home folder.
const SYSTEM_BINS: [&str; 2] = ["/opt/homebrew/bin", "/usr/local/bin"];

/// The folders a CLI is looked for in besides the shell's PATH: where installers put it, and the app folders whose apps
/// may bundle one. A test uses `none` or `only_under`, so the CLIs installed on the machine never answer it.
#[derive(Clone, Debug)]
pub struct CliPlaces {
    home: Option<PathBuf>,
    bins: Vec<PathBuf>,
    apps: Vec<PathBuf>,
}

impl CliPlaces {
    /// No folder at all: only the shell's PATH is searched.
    pub fn none() -> Self {
        Self { home: None, bins: Vec::new(), apps: Vec::new() }
    }

    /// The folders under `home`, then Homebrew's and `/usr/local`'s, then the app folders. Without a home folder no
    /// install folder is searched.
    pub fn of_this_mac(home: Option<PathBuf>) -> Self {
        let apps = [Some(PathBuf::from("/Applications")), home.as_ref().map(|h| h.join("Applications"))].into_iter().flatten().collect();
        let bins = if home.is_some() { SYSTEM_BINS.map(PathBuf::from).to_vec() } else { Vec::new() };
        Self { home, bins, apps }
    }

    /// Only `home` and its `Applications` folder.
    #[cfg(any(test, feature = "testing"))]
    pub fn only_under(home: &Path) -> Self {
        Self { home: Some(home.to_path_buf()), bins: Vec::new(), apps: vec![home.join("Applications")] }
    }

    /// The CLI of `driver`: where installers put it, then the PATH of the captured shell environment, which holds what
    /// `.zshrc` adds (an npm `codex` under nvm), then the copy an app bundles. A copy on PATH wins over a bundled one
    /// because the person put it there.
    pub fn find(&self, driver: Provider, shell: &RunEnv) -> Option<PathBuf> {
        self.find_on(driver, shell.get("PATH"))
    }

    /// Whether no folder is searched besides the shell's PATH.
    pub fn searches_no_folder(&self) -> bool {
        self.home.is_none() && self.bins.is_empty() && self.apps.is_empty()
    }

    fn find_on(&self, driver: Provider, path: Option<&OsStr>) -> Option<PathBuf> {
        find_in(&self.installed(driver), driver.binary(), path).or_else(|| bundled(driver, &self.apps))
    }

    fn installed(&self, driver: Provider) -> Vec<PathBuf> {
        let name = driver.binary();
        let mut paths = Vec::new();
        if let Some(home) = &self.home {
            paths.push(home.join(".local/bin").join(name));
            if driver == Provider::Claude {
                paths.push(home.join(".claude/local/claude"));
            }
        }
        paths.extend(self.bins.iter().map(|bin| bin.join(name)));
        paths
    }
}

/// Where apps that ship the Codex CLI keep it. ChatGPT.app is the one the owner's Mac has, and it is not on PATH.
const BUNDLED_CODEX: [&str; 2] = ["Contents/Resources/codex-cli/bin/codex", "Contents/Resources/bin/codex"];
const PREFERRED_APP: &str = "ChatGPT.app";

/// The Codex CLI inside an app under `roots`: ChatGPT.app first, then the others in name order.
fn bundled(driver: Provider, roots: &[PathBuf]) -> Option<PathBuf> {
    if driver != Provider::Codex {
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
        assert_eq!(bundled(Provider::Codex, std::slice::from_ref(&dir)), Some(wanted));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn chatgpt_is_preferred_over_other_apps_even_in_a_later_folder() {
        let dir = scratch("order");
        let (system, user) = (dir.join("Applications"), dir.join("home/Applications"));
        app(&system, "Conductor.app", BUNDLED_CODEX[1]);
        let wanted = app(&user, "ChatGPT.app", BUNDLED_CODEX[0]);
        assert_eq!(bundled(Provider::Codex, &[system.clone(), user]), Some(wanted));
        let other = app(&system, "Another.app", BUNDLED_CODEX[0]);
        assert_eq!(bundled(Provider::Codex, &[system]).as_deref(), Some(other.as_path()), "without ChatGPT the apps go in name order");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_bundled_file_that_cannot_run_a_missing_folder_and_claude_find_nothing() {
        let dir = scratch("none");
        let plain = app(&dir, "ChatGPT.app", BUNDLED_CODEX[0]);
        std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(bundled(Provider::Codex, std::slice::from_ref(&dir)), None);
        assert_eq!(bundled(Provider::Codex, &[dir.join("missing")]), None);
        std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(bundled(Provider::Claude, std::slice::from_ref(&dir)), None, "only Codex ships inside other apps");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_codex_on_the_shell_path_wins_over_a_bundled_one() {
        let dir = scratch("pathfirst");
        app(&dir.join("Applications"), "ChatGPT.app", BUNDLED_CODEX[0]);
        let on_path = tool(&dir.join("nvm"), "codex", "#!/bin/sh\n");
        let path = std::env::join_paths([dir.join("nvm")]).unwrap();
        let apps = [dir.join("Applications")];
        let places = CliPlaces::only_under(&dir);
        assert_eq!(places.find_on(Provider::Codex, Some(&path)), Some(on_path));
        assert_eq!(places.find_on(Provider::Codex, None), bundled(Provider::Codex, &apps));
        assert_eq!(places.find_on(Provider::Claude, None), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn this_macs_places_are_the_home_folder_then_homebrew_then_usr_local_and_both_app_folders_and_none_without_a_home() {
        let home = PathBuf::from("/Users/someone");
        let places = CliPlaces::of_this_mac(Some(home.clone()));
        let claude = ["/Users/someone/.local/bin/claude", "/Users/someone/.claude/local/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
        assert_eq!(places.installed(Provider::Claude), claude.map(PathBuf::from));
        assert_eq!(places.installed(Provider::Codex), ["/Users/someone/.local/bin/codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex"].map(PathBuf::from));
        assert_eq!(places.apps, [PathBuf::from("/Applications"), home.join("Applications")]);
        let homeless = CliPlaces::of_this_mac(None);
        assert_eq!(homeless.installed(Provider::Codex), Vec::<PathBuf>::new(), "without a home folder no install folder is searched");
        assert_eq!(homeless.apps, [PathBuf::from("/Applications")]);
    }

    #[test]
    fn no_places_look_in_no_folder_of_the_machine() {
        let places = CliPlaces::none();
        assert!(places.searches_no_folder(), "{places:?}");
        assert_eq!(places.find_on(Provider::Codex, None), None);
    }

    #[test]
    fn places_under_a_folder_find_nothing_the_machine_has_installed() {
        let dir = scratch("only-under");
        let places = CliPlaces::only_under(&dir);
        assert!(places.installed(Provider::Codex).iter().all(|p| p.starts_with(&dir)), "{:?}", places.installed(Provider::Codex));
        assert_eq!(places.find_on(Provider::Codex, None), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_node_launcher_codex_is_found_on_the_captured_path_and_runs_with_it() {
        let dir = scratch("node");
        crate::testing::fake_cli(&dir.join("node/bin/node"), "echo codex-cli 9.9.9");
        std::fs::create_dir_all(dir.join("nvm/bin")).unwrap();
        let codex = dir.join("nvm/bin/codex");
        std::os::unix::fs::symlink(crate::testing::NODE_LAUNCHER, &codex).unwrap();
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
