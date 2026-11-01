//! The rules for a provider instance's config folder that need nothing changed on disk (section 6.2 of
//! docs/connections-proposal.md). Each problem is a sentence for the person.

use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use super::env::RunEnv;
use crate::connections::{Driver, ProviderInstance};

#[derive(Clone, Copy)]
pub struct Places<'a> {
    /// The canonical home folder, when there is one.
    pub home: Option<&'a Path>,
    pub data_dir: &'a Path,
}

/// `~` and `~/…` start at the home folder. Anything else is taken as typed.
pub fn expand(typed: &str, home: &Path) -> PathBuf {
    let path = match typed.strip_prefix('~') {
        Some("") => home.to_path_buf(),
        Some(rest) if rest.starts_with('/') => home.join(rest.trim_start_matches('/')),
        _ => PathBuf::from(typed),
    };
    path.components().collect()
}

/// What stays the same however a folder is spelled: where it really is, and its device and inode once it exists.
struct Located {
    real: PathBuf,
    inode: Option<(u64, u64)>,
}

impl Located {
    fn of(real: PathBuf) -> Self {
        let inode = real.metadata().ok().map(|m| (m.dev(), m.ino()));
        Self { real, inode }
    }

    /// APFS ignores case, so paths are compared without it.
    fn is(&self, other: &Located) -> bool {
        (self.inode.is_some() && self.inode == other.inode) || lower(&self.real) == lower(&other.real)
    }
}

fn lower(path: &Path) -> PathBuf {
    PathBuf::from(path.to_string_lossy().to_lowercase())
}

fn inside(path: &Path, base: &Path) -> bool {
    lower(path).starts_with(lower(base))
}

/// The deepest part of `path` that exists is resolved, and the rest added back, so `..` and symlinked parents can't hide
/// where it points.
fn resolve(path: &Path) -> Result<PathBuf, String> {
    let (mut head, mut rest) = (path, Vec::new());
    loop {
        if let Ok(real) = head.canonicalize() {
            return Ok(rest.iter().rev().fold(real, |acc, part| acc.join(part)));
        }
        if !rest.is_empty() && head.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("It goes through a link to a folder that doesn't exist.".into());
        }
        let (Some(name), Some(parent)) = (head.file_name(), head.parent()) else {
            return Err("It has a .. in a part that doesn't exist yet.".into());
        };
        rest.push(name);
        head = parent;
    }
}

fn locate(typed: &str, places: &Places) -> Result<Located, String> {
    if typed.trim().is_empty() {
        return Err("The folder is empty.".into());
    }
    if typed.chars().any(|c| c == '\'' || c.is_control()) {
        return Err("It has a quote or an unusual character in it.".into());
    }
    let home = places.home.ok_or("Gossamr can't find your home folder.")?;
    let path = expand(typed, home);
    if !path.is_absolute() {
        return Err("It must be a full path, or start with ~.".into());
    }
    let real = resolve(&path)?;
    if !inside(&real, home) || lower(&real) == lower(home) {
        return Err("It must be inside your home folder, and not the home folder itself.".into());
    }
    match path.symlink_metadata() {
        Ok(m) if m.file_type().is_symlink() => return Err("It is a link to another folder. Use the folder itself.".into()),
        Ok(m) if !m.is_dir() => return Err("It isn't a folder.".into()),
        _ => {}
    }
    if resolve(places.data_dir).is_ok_and(|data| inside(&real, &data)) {
        return Err("It is inside Gossamr's own data folder.".into());
    }
    Ok(Located::of(real))
}

const DRIVERS: [Driver; 2] = [Driver::Claude, Driver::Codex];

/// The folders the CLI uses when it is not told one, which only the instance without a folder may have. Without the
/// shell its `CODEX_HOME` is unknown, so `~/.codex` is refused rather than risk the login the CLI would use.
fn usual_folders(driver: Driver, home: &Path, shell: Option<&RunEnv>) -> Vec<PathBuf> {
    let from_shell = shell.and_then(|s| s.get(driver.folder_variable())).filter(|v| !v.is_empty()).map(PathBuf::from);
    match (driver, from_shell) {
        (Driver::Claude, shell_folder) => [home.join(".claude")].into_iter().chain(shell_folder).collect(),
        (Driver::Codex, Some(shell_folder)) => vec![shell_folder],
        (Driver::Codex, None) => vec![home.join(".codex")],
    }
}

/// The driver whose usual folder `folder` is. Both drivers' folders count: each CLI keeps files with the same names at
/// the root of its folder.
fn usual_owner(folder: &Located, home: &Path, shell: Option<&RunEnv>) -> Option<Driver> {
    DRIVERS.into_iter().find(|&driver| usual_folders(driver, home, shell).iter().filter_map(|f| resolve(f).ok()).map(Located::of).any(|u| u.is(folder)))
}

/// The problem with each provider instance whose folder can't be used, by instance id. The first instance to claim a
/// folder or the no-folder place keeps it; a later one is the problem. A folder is claimed for every driver, not only
/// the one that took it.
pub fn problems(providers: &[ProviderInstance], places: &Places, shell: Option<&RunEnv>) -> HashMap<String, String> {
    let mut found = HashMap::new();
    let mut taken: Vec<(Driver, Located)> = Vec::new();
    for (at, p) in providers.iter().enumerate() {
        let problem = match p.config.config_dir.as_deref() {
            None => providers[..at].iter().find(|q| q.driver == p.driver && q.config.config_dir.is_none()).map(|q| format!("Your usual setup is already added as {}.", q.display_name)),
            Some(typed) => match locate(typed, places) {
                Err(problem) => Some(problem),
                Ok(folder) => match places.home.and_then(|home| usual_owner(&folder, home, shell)) {
                    Some(owner) if owner == p.driver => Some("That's your usual setup. Choose My usual setup instead.".into()),
                    Some(owner) => Some(format!("That's the usual folder of {}. Choose another folder.", owner.label())),
                    None => match taken.iter().find(|(_, other)| other.is(&folder)) {
                        Some((owner, _)) => Some(format!("Another {} already uses this folder.", owner.label())),
                        None => {
                            taken.push((p.driver, folder));
                            None
                        }
                    },
                },
            },
        };
        if let Some(problem) = problem {
            found.insert(p.id.clone(), problem);
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::ProviderConfig;
    use std::os::unix::fs::symlink;

    struct Rig {
        root: PathBuf,
        home: PathBuf,
        data: PathBuf,
    }

    impl Rig {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!("gossamr-folder-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            let (home, data) = (root.join("home"), root.join("home/Library/Application Support/gossamr"));
            std::fs::create_dir_all(&data).unwrap();
            Self { home: home.canonicalize().unwrap(), data: data.canonicalize().unwrap(), root }
        }

        fn places(&self) -> Places<'_> {
            Places { home: Some(&self.home), data_dir: &self.data }
        }

        fn folder(&self, name: &str) -> String {
            self.home.join(name).display().to_string()
        }

        fn problem(&self, driver: Driver, folder: &str) -> Option<String> {
            self.problem_with(driver, folder, None)
        }

        fn problem_with(&self, driver: Driver, folder: &str, shell: Option<&RunEnv>) -> Option<String> {
            problems(&[provider("p", driver, Some(folder))], &self.places(), shell).remove("p")
        }
    }

    impl Drop for Rig {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn provider(id: &str, driver: Driver, folder: Option<&str>) -> ProviderInstance {
        ProviderInstance { id: id.into(), driver, display_name: format!("{id} name"), enabled: true, config: ProviderConfig { config_dir: folder.map(Into::into), ..Default::default() }, extra: Default::default() }
    }

    #[test]
    fn tilde_starts_at_the_home_folder_and_other_forms_are_left_alone() {
        let home = Path::new("/Users/x");
        assert_eq!(expand("~", home), home);
        assert_eq!(expand("~/.claude-work/", home), Path::new("/Users/x/.claude-work"));
        assert_eq!(expand("~other/x", home), Path::new("~other/x"));
        assert_eq!(expand("/a//b/./c", home), Path::new("/a/b/c"));
    }

    #[test]
    fn a_folder_that_does_not_exist_yet_is_fine_inside_the_home_folder() {
        let rig = Rig::new("fine");
        assert_eq!(rig.problem(Driver::Claude, "~/.claude-new/deeper"), None);
        assert_eq!(rig.problem(Driver::Claude, &rig.folder(".claude-new")), None);
    }

    #[test]
    fn a_folder_outside_the_home_folder_or_the_home_folder_itself_is_refused() {
        let rig = Rig::new("outside");
        for typed in ["/tmp/claude-x", "relative/dir", "~", &rig.home.display().to_string(), "~/../elsewhere", "~/new/../../elsewhere"] {
            assert!(rig.problem(Driver::Claude, typed).is_some(), "{typed}");
        }
    }

    #[test]
    fn a_symlinked_parent_cannot_hide_where_a_folder_points() {
        let rig = Rig::new("parent");
        let elsewhere = rig.root.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        symlink(&elsewhere, rig.home.join("hop")).unwrap();
        assert!(rig.problem(Driver::Claude, "~/hop/inner").unwrap().contains("inside your home folder"));
    }

    #[test]
    fn a_folder_that_is_itself_a_symlink_or_a_file_is_refused() {
        let rig = Rig::new("link");
        std::fs::create_dir_all(rig.home.join("real")).unwrap();
        symlink(rig.home.join("real"), rig.home.join("alias")).unwrap();
        std::fs::write(rig.home.join("file"), "").unwrap();
        assert!(rig.problem(Driver::Claude, "~/alias").unwrap().contains("link"));
        assert!(rig.problem(Driver::Claude, "~/alias/").unwrap().contains("link"), "a trailing slash doesn't follow the link");
        assert!(rig.problem(Driver::Claude, "~/file").unwrap().contains("isn't a folder"));
        assert_eq!(rig.problem(Driver::Claude, "~/real"), None);
    }

    #[test]
    fn a_quote_or_a_control_character_is_refused() {
        let rig = Rig::new("quote");
        for typed in ["~/it's", "~/two\nlines", "~/nul\0byte", "   "] {
            assert!(rig.problem(Driver::Codex, typed).is_some(), "{typed:?}");
        }
    }

    #[test]
    fn the_data_folder_and_anything_in_it_is_refused() {
        let rig = Rig::new("data");
        assert!(rig.problem(Driver::Claude, &rig.data.display().to_string()).unwrap().contains("data folder"));
        assert!(rig.problem(Driver::Claude, &rig.data.join("claude").display().to_string()).unwrap().contains("data folder"));
        assert!(rig.problem(Driver::Claude, &rig.data.display().to_string().to_uppercase()).is_some(), "case doesn't hide it");
    }

    #[test]
    fn claudes_usual_folders_are_refused_in_any_case_and_the_shells_too() {
        let rig = Rig::new("usual");
        let usual = "That's your usual setup. Choose My usual setup instead.";
        assert_eq!(rig.problem(Driver::Claude, "~/.claude").as_deref(), Some(usual));
        assert_eq!(rig.problem(Driver::Claude, &rig.folder(".CLAUDE")).as_deref(), Some(usual));
        let shell = RunEnv::from_pairs([("CLAUDE_CONFIG_DIR", rig.folder(".claude-shell"))]);
        assert_eq!(rig.problem_with(Driver::Claude, "~/.claude-shell", Some(&shell)).as_deref(), Some(usual));
        assert_eq!(rig.problem_with(Driver::Claude, "~/.claude-other", Some(&shell)), None);
    }

    #[test]
    fn codexs_usual_folder_is_the_shells_codex_home_else_dot_codex() {
        let rig = Rig::new("codex");
        let unset = RunEnv::from_pairs([("PATH", "/bin")]);
        assert!(rig.problem_with(Driver::Codex, "~/.codex", Some(&unset)).is_some());
        let set = RunEnv::from_pairs([("CODEX_HOME", rig.folder(".codex-shell"))]);
        assert_eq!(rig.problem_with(Driver::Codex, "~/.codex", Some(&set)), None, "dot-codex is stored as typed when the shell sets another");
        assert!(rig.problem_with(Driver::Codex, "~/.codex-shell", Some(&set)).is_some());
        assert!(rig.problem_with(Driver::Codex, "~/.codex", None).is_some(), "without the shell ~/.codex may be the usual folder");
        assert_eq!(rig.problem_with(Driver::Codex, "~/.codex-work", None), None);
    }

    #[test]
    fn two_instances_cannot_share_a_folder_whatever_its_driver_case_or_spelling() {
        let rig = Rig::new("dup");
        std::fs::create_dir_all(rig.home.join("shared")).unwrap();
        let list = [
            provider("a", Driver::Claude, Some("~/shared")),
            provider("b", Driver::Claude, Some(&rig.folder("SHARED"))),
            provider("c", Driver::Claude, Some("~/shared/../shared")),
            provider("d", Driver::Codex, Some("~/shared")),
            provider("e", Driver::Codex, Some("~/own")),
        ];
        let found = problems(&list, &rig.places(), None);
        let mut ids: Vec<_> = found.keys().cloned().collect();
        ids.sort();
        assert_eq!(ids, ["b", "c", "d"], "the first keeps the folder, whatever driver asks later");
        assert_eq!(found["b"], "Another Claude already uses this folder.");
        assert_eq!(found["d"], "Another Claude already uses this folder.");
    }

    #[test]
    fn a_driver_cannot_take_the_other_drivers_usual_folder() {
        let rig = Rig::new("cross");
        let shell = RunEnv::from_pairs([("CLAUDE_CONFIG_DIR", rig.folder(".claude-shell")), ("CODEX_HOME", rig.folder(".codex-shell"))]);
        for (driver, folder) in [(Driver::Claude, "~/.codex-shell"), (Driver::Codex, "~/.claude"), (Driver::Codex, "~/.claude-shell")] {
            let problem = rig.problem_with(driver, folder, Some(&shell)).unwrap_or_default();
            assert!(problem.starts_with("That's the usual folder of"), "{driver:?} {folder}: {problem}");
        }
        assert!(rig.problem_with(Driver::Claude, "~/.codex", None).is_some(), "without the shell too");
    }

    #[test]
    fn a_dangling_symlinked_parent_is_refused() {
        let rig = Rig::new("dangling");
        symlink(rig.root.join("unmounted"), rig.home.join("hop")).unwrap();
        assert!(rig.problem(Driver::Claude, "~/hop/work").unwrap().contains("link"));
        assert!(rig.problem(Driver::Claude, "~/hop").unwrap().contains("link"));
    }

    #[test]
    fn only_one_instance_per_driver_may_have_no_folder() {
        let rig = Rig::new("nofolder");
        let list = [provider("a", Driver::Claude, None), provider("b", Driver::Claude, None), provider("c", Driver::Codex, None)];
        let found = problems(&list, &rig.places(), None);
        assert_eq!(found.len(), 1);
        assert_eq!(found["b"], "Your usual setup is already added as a name.");
    }

    #[test]
    fn without_a_home_folder_every_folder_is_refused() {
        let rig = Rig::new("nohome");
        let places = Places { home: None, ..rig.places() };
        assert_eq!(problems(&[provider("a", Driver::Claude, Some("/x/y"))], &places, None).len(), 1);
    }
}
