use std::io;
use std::path::Path;

/// Bundle identifiers the app has used before, newest first.
const LEGACY_IDENTIFIERS: &[&str] = &["dk.alfhen.jirainbox"];

/// Moves the data folder of an earlier identifier to `new`, so a rename doesn't strand the local cache and the
/// cleared and snoozed state kept in it. Returns whether anything moved. Never overwrites existing data.
pub fn adopt_legacy_data(new: &Path) -> io::Result<bool> {
    if new.exists() {
        if new.read_dir()?.next().is_some() {
            return Ok(false);
        }
        std::fs::remove_dir(new)?;
    }
    let Some(parent) = new.parent() else { return Ok(false) };
    for id in LEGACY_IDENTIFIERS {
        let old = parent.join(id);
        if old.is_dir() {
            // Same parent, so this is an atomic rename on one filesystem.
            std::fs::rename(&old, new)?;
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("gossamr-legacy-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn legacy_dir(parent: &Path) -> std::path::PathBuf {
        let old = parent.join(LEGACY_IDENTIFIERS[0]);
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("account.db"), "rows").unwrap();
        old
    }

    #[test]
    fn moves_the_old_folder_when_the_new_one_is_missing() {
        let parent = scratch("missing");
        let old = legacy_dir(&parent);
        let new = parent.join("dk.alfhen.gossamr");
        assert!(adopt_legacy_data(&new).unwrap());
        assert_eq!(fs::read_to_string(new.join("account.db")).unwrap(), "rows");
        assert!(!old.exists());
        fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn replaces_an_empty_new_folder() {
        let parent = scratch("empty");
        legacy_dir(&parent);
        let new = parent.join("dk.alfhen.gossamr");
        fs::create_dir_all(&new).unwrap();
        assert!(adopt_legacy_data(&new).unwrap());
        assert!(new.join("account.db").exists());
        fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn never_overwrites_existing_data() {
        let parent = scratch("existing");
        let old = legacy_dir(&parent);
        let new = parent.join("dk.alfhen.gossamr");
        fs::create_dir_all(&new).unwrap();
        fs::write(new.join("account.db"), "newer").unwrap();
        assert!(!adopt_legacy_data(&new).unwrap());
        assert_eq!(fs::read_to_string(new.join("account.db")).unwrap(), "newer");
        assert!(old.join("account.db").exists());
        fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn does_nothing_without_an_old_folder() {
        let parent = scratch("none");
        assert!(!adopt_legacy_data(&parent.join("dk.alfhen.gossamr")).unwrap());
        fs::remove_dir_all(&parent).unwrap();
    }
}
