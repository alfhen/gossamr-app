//! The only folder an assistant process is ever started in.

use std::path::{Path, PathBuf};

use crate::error::Result;

/// An empty folder inside the app's data directory. It is a fixed place, not a choice, so Claude Code (which keys
/// session resume by folder) can continue a session while the run has no user files within reach of its working folder.
#[derive(Debug, Clone, PartialEq)]
pub struct Sandbox(PathBuf);

impl Sandbox {
    pub const DIR: &'static str = "pip-sandbox";

    pub fn prepare(data_dir: &Path) -> Result<Self> {
        let dir = data_dir.join(Self::DIR);
        std::fs::create_dir_all(&dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(Self(dir.canonicalize()?))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gossamr-sandbox-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn it_is_a_private_folder_under_the_data_dir_and_is_made_on_demand() {
        let data = scratch("new");
        let sandbox = Sandbox::prepare(&data.join("not-yet")).unwrap();
        assert!(sandbox.path().is_dir());
        assert!(sandbox.path().ends_with(Sandbox::DIR));
        assert!(sandbox.path().starts_with(data.join("not-yet").canonicalize().unwrap()));
        assert_eq!(std::fs::read_dir(sandbox.path()).unwrap().count(), 0);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(sandbox.path()).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn preparing_again_keeps_the_folder_and_tightens_loose_permissions() {
        let data = scratch("again");
        std::fs::create_dir_all(&data).unwrap();
        let first = Sandbox::prepare(&data).unwrap();
        std::fs::write(first.path().join("kept"), "x").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(first.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let second = Sandbox::prepare(&data).unwrap();
        assert_eq!(first, second);
        assert!(second.path().join("kept").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(second.path()).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let _ = std::fs::remove_dir_all(&data);
    }
}
