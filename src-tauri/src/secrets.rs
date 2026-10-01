//! Every secret lives in one Keychain item, read once per run and kept in memory, so the person is asked for access
//! at most once instead of once per value.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Mutex;

#[cfg(not(test))]
use keyring::Entry;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;

use crate::error::{Error, Result};

#[cfg(not(test))]
const SERVICE: &str = "dk.alfhen.gossamr";
const VAULT_ACCOUNT: &str = "vault";

/// The raw Keychain calls, swappable so tests never reach the real one.
pub trait Backend: Send + Sync {
    fn read(&self, account: &str) -> Result<Option<String>>;
    fn write(&self, account: &str, value: &str) -> Result<()>;
    fn remove(&self, account: &str) -> Result<()>;
}

#[cfg(not(test))]
struct Keychain;

#[cfg(not(test))]
impl Backend for Keychain {
    fn read(&self, account: &str) -> Result<Option<String>> {
        match Entry::new(SERVICE, account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn write(&self, account: &str, value: &str) -> Result<()> {
        Ok(Entry::new(SERVICE, account)?.set_password(value)?)
    }

    fn remove(&self, account: &str) -> Result<()> {
        match Entry::new(SERVICE, account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

/// What the vault item holds. `probed` names the accounts whose pre-vault item has already been looked for, so an
/// account that was never stored costs no Keychain read on later launches.
#[derive(Clone, Default, Serialize, Deserialize)]
struct Doc {
    #[serde(default)]
    secrets: BTreeMap<String, Value>,
    #[serde(default)]
    probed: BTreeSet<String>,
}

struct Ready {
    doc: Doc,
    /// Pre-vault items that could not be read this run; they are not asked for again.
    legacy_failed: HashMap<String, String>,
}

enum State {
    Unread,
    Ready(Ready),
    /// The vault could not be read. Nothing else touches the Keychain this run: a denied prompt must not come back on
    /// every call, and writing a partial vault over an unread one would lose what it holds.
    Unavailable(String),
}

pub struct Vault {
    backend: Box<dyn Backend>,
    state: Mutex<State>,
}

impl std::fmt::Debug for Vault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Vault").finish_non_exhaustive()
    }
}

impl Vault {
    pub fn new(backend: Box<dyn Backend>) -> Self {
        Self { backend, state: Mutex::new(State::Unread) }
    }

    fn with_ready<R>(&self, f: impl FnOnce(&dyn Backend, &mut Ready) -> Result<R>) -> Result<R> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(*state, State::Unread) {
            *state = match self.read_vault() {
                Ok(doc) => State::Ready(Ready { doc, legacy_failed: HashMap::new() }),
                Err(e) => State::Unavailable(e.to_string()),
            };
        }
        match &mut *state {
            State::Ready(ready) => f(self.backend.as_ref(), ready),
            State::Unavailable(reason) => Err(Error::KeychainUnavailable(reason.clone())),
            State::Unread => unreachable!("the vault was just read"),
        }
    }

    fn read_vault(&self) -> Result<Doc> {
        match self.backend.read(VAULT_ACCOUNT)? {
            Some(json) => Ok(serde_json::from_str(&json)?),
            None => Ok(Doc::default()),
        }
    }

    pub fn load<T: DeserializeOwned>(&self, account: &str) -> Result<Option<T>> {
        self.with_ready(|backend, ready| {
            if let Some(reason) = ready.legacy_failed.get(account) {
                return Err(Error::KeychainUnavailable(reason.clone()));
            }
            if !ready.doc.secrets.contains_key(account) && !ready.doc.probed.contains(account) {
                migrate(backend, ready, account)?;
            }
            Ok(ready.doc.secrets.get(account).map(|v| serde_json::from_value(v.clone())).transpose()?)
        })
    }

    pub fn save<T: Serialize>(&self, account: &str, value: &T) -> Result<()> {
        self.with_ready(|backend, ready| {
            let value = serde_json::to_value(value)?;
            if ready.doc.secrets.get(account) == Some(&value) {
                return Ok(());
            }
            let first_touch = !ready.doc.probed.contains(account);
            let mut next = ready.doc.clone();
            next.secrets.insert(account.into(), value);
            next.probed.insert(account.into());
            write_vault(backend, &next)?;
            ready.doc = next;
            if first_touch {
                forget_legacy(backend, account);
            }
            Ok(())
        })
    }

    pub fn delete(&self, account: &str) -> Result<()> {
        self.with_ready(|backend, ready| {
            let first_touch = !ready.doc.probed.contains(account);
            if ready.doc.secrets.contains_key(account) || first_touch {
                let mut next = ready.doc.clone();
                next.secrets.remove(account);
                next.probed.insert(account.into());
                write_vault(backend, &next)?;
                ready.doc = next;
            }
            if first_touch {
                forget_legacy(backend, account);
            }
            Ok(())
        })
    }
}

fn write_vault(backend: &dyn Backend, doc: &Doc) -> Result<()> {
    backend.write(VAULT_ACCOUNT, &serde_json::to_string(doc)?)
}

fn forget_legacy(backend: &dyn Backend, account: &str) {
    if let Err(e) = backend.remove(account) {
        eprintln!("couldn't remove the old Keychain item for {account}: {e}");
    }
}

/// Moves one pre-vault item into the vault. The old item goes only after the vault holds the value, so a failure
/// part-way loses nothing.
fn migrate(backend: &dyn Backend, ready: &mut Ready, account: &str) -> Result<()> {
    let read = backend.read(account).and_then(|found| Ok(found.map(|json| serde_json::from_str::<Value>(&json)).transpose()?));
    let value = match read {
        Ok(value) => value,
        Err(e) => {
            let reason = e.to_string();
            ready.legacy_failed.insert(account.into(), reason.clone());
            return Err(Error::KeychainUnavailable(reason));
        }
    };
    let mut next = ready.doc.clone();
    next.probed.insert(account.into());
    let migrated = value.is_some();
    if let Some(value) = value {
        next.secrets.insert(account.into(), value);
    }
    let written = write_vault(backend, &next);
    if let Err(e) = &written {
        eprintln!("couldn't save the Keychain vault: {e}");
    }
    ready.doc = next;
    if migrated && written.is_ok() {
        forget_legacy(backend, account);
    }
    Ok(())
}

#[cfg(not(test))]
fn with_global<R>(f: impl FnOnce(&Vault) -> R) -> R {
    static VAULT: std::sync::OnceLock<Vault> = std::sync::OnceLock::new();
    f(VAULT.get_or_init(|| Vault::new(Box::new(Keychain))))
}

#[cfg(test)]
thread_local! {
    static TEST_VAULT: std::cell::RefCell<Option<std::rc::Rc<Vault>>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn with_global<R>(f: impl FnOnce(&Vault) -> R) -> R {
    let vault = TEST_VAULT.with(|slot| slot.borrow_mut().get_or_insert_with(|| std::rc::Rc::new(Vault::new(Box::new(fake::Fake::default())))).clone());
    f(&vault)
}

pub fn load<T: DeserializeOwned>(account: &str) -> Result<Option<T>> {
    with_global(|v| v.load(account))
}

pub fn save<T: Serialize>(account: &str, value: &T) -> Result<()> {
    with_global(|v| v.save(account, value))
}

pub fn delete(account: &str) -> Result<()> {
    with_global(|v| v.delete(account))
}

#[cfg(test)]
pub(crate) mod fake {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    use super::*;

    #[derive(Default)]
    struct Inner {
        items: HashMap<String, String>,
        reads: usize,
        writes: usize,
        removes: usize,
        fail_reads_of: Option<String>,
        fail_writes: bool,
        fail_removes: bool,
    }

    /// An in-memory Keychain that counts its calls. Clones share one store.
    #[derive(Clone, Default)]
    pub struct Fake(Arc<Mutex<Inner>>);

    fn denied() -> Error {
        Error::Keychain(keyring::Error::NoStorageAccess("denied".into()))
    }

    impl Fake {
        pub fn put(&self, account: &str, value: &str) {
            self.0.lock().unwrap().items.insert(account.into(), value.into());
        }
        pub fn get(&self, account: &str) -> Option<String> {
            self.0.lock().unwrap().items.get(account).cloned()
        }
        pub fn reads(&self) -> usize {
            self.0.lock().unwrap().reads
        }
        pub fn writes(&self) -> usize {
            self.0.lock().unwrap().writes
        }
        pub fn removes(&self) -> usize {
            self.0.lock().unwrap().removes
        }
        pub fn reset_counts(&self) {
            let mut inner = self.0.lock().unwrap();
            (inner.reads, inner.writes, inner.removes) = (0, 0, 0);
        }
        pub fn deny_reads_of(&self, account: &str) {
            self.0.lock().unwrap().fail_reads_of = Some(account.into());
        }
        pub fn deny_writes(&self, on: bool) {
            self.0.lock().unwrap().fail_writes = on;
        }
        pub fn deny_removes(&self, on: bool) {
            self.0.lock().unwrap().fail_removes = on;
        }
    }

    impl Backend for Fake {
        fn read(&self, account: &str) -> Result<Option<String>> {
            let mut inner = self.0.lock().unwrap();
            inner.reads += 1;
            if inner.fail_reads_of.as_deref() == Some(account) {
                return Err(denied());
            }
            Ok(inner.items.get(account).cloned())
        }
        fn write(&self, account: &str, value: &str) -> Result<()> {
            let mut inner = self.0.lock().unwrap();
            inner.writes += 1;
            if inner.fail_writes {
                return Err(denied());
            }
            inner.items.insert(account.into(), value.into());
            Ok(())
        }
        fn remove(&self, account: &str) -> Result<()> {
            let mut inner = self.0.lock().unwrap();
            inner.removes += 1;
            if inner.fail_removes {
                return Err(denied());
            }
            inner.items.remove(account);
            Ok(())
        }
    }

    /// Routes the free `load`/`save`/`delete` on this thread to a fresh vault over `fake` until dropped.
    pub struct Installed;

    pub fn install(fake: &Fake) -> Installed {
        TEST_VAULT.with(|slot| *slot.borrow_mut() = Some(std::rc::Rc::new(Vault::new(Box::new(fake.clone())))));
        Installed
    }

    impl Drop for Installed {
        fn drop(&mut self) {
            TEST_VAULT.with(|slot| *slot.borrow_mut() = None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::Fake;
    use super::*;

    fn vault(fake: &Fake) -> Vault {
        Vault::new(Box::new(fake.clone()))
    }

    fn text(v: &str) -> Value {
        Value::String(v.into())
    }

    #[test]
    fn the_keychain_is_read_once_and_later_loads_come_from_memory() {
        let fake = Fake::default();
        let v = vault(&fake);
        v.save("a", &"one").unwrap();
        v.save("b", &"two").unwrap();
        fake.reset_counts();
        let v = vault(&fake);
        assert_eq!(v.load::<String>("a").unwrap().as_deref(), Some("one"));
        assert_eq!(v.load::<String>("b").unwrap().as_deref(), Some("two"));
        assert_eq!(v.load::<String>("a").unwrap().as_deref(), Some("one"));
        assert_eq!((fake.reads(), fake.writes()), (1, 0));
    }

    #[test]
    fn everything_is_stored_in_one_item() {
        let fake = Fake::default();
        let v = vault(&fake);
        v.save("a", &"one").unwrap();
        v.save("b", &"two").unwrap();
        let item: Value = serde_json::from_str(&fake.get(VAULT_ACCOUNT).unwrap()).unwrap();
        assert_eq!(item["secrets"], serde_json::json!({"a": "one", "b": "two"}));
        assert_eq!(fake.get("a"), None);
    }

    #[test]
    fn saving_an_unchanged_value_writes_nothing() {
        let fake = Fake::default();
        let v = vault(&fake);
        v.save("a", &"one").unwrap();
        let writes = fake.writes();
        v.save("a", &"one").unwrap();
        assert_eq!(fake.writes(), writes);
        v.save("a", &"changed").unwrap();
        assert_eq!(fake.writes(), writes + 1);
    }

    #[test]
    fn delete_forgets_the_value_and_survives_a_relaunch() {
        let fake = Fake::default();
        let v = vault(&fake);
        v.save("a", &"one").unwrap();
        v.save("b", &"two").unwrap();
        v.delete("a").unwrap();
        let v = vault(&fake);
        assert_eq!(v.load::<String>("a").unwrap(), None);
        assert_eq!(v.load::<String>("b").unwrap().as_deref(), Some("two"));
    }

    #[test]
    fn a_failed_write_leaves_the_cache_as_it_was() {
        let fake = Fake::default();
        let v = vault(&fake);
        v.save("a", &"one").unwrap();
        fake.deny_writes(true);
        assert!(v.save("a", &"two").is_err());
        assert!(v.save("b", &"new").is_err());
        assert!(v.delete("a").is_err());
        assert_eq!(v.load::<String>("a").unwrap().as_deref(), Some("one"));
        assert_eq!(v.load::<String>("b").unwrap(), None);
    }

    #[test]
    fn a_legacy_item_is_moved_into_the_vault_and_removed() {
        let fake = Fake::default();
        fake.put("session", "{\"n\":1}");
        let v = vault(&fake);
        assert_eq!(v.load::<Value>("session").unwrap(), Some(serde_json::json!({"n": 1})));
        assert_eq!(fake.get("session"), None);
        assert!(fake.get(VAULT_ACCOUNT).unwrap().contains("\"n\":1"));
        fake.reset_counts();
        assert!(v.load::<Value>("session").unwrap().is_some());
        assert_eq!(fake.reads(), 0);
        let v = vault(&fake);
        assert_eq!(v.load::<Value>("session").unwrap(), Some(serde_json::json!({"n": 1})));
        assert_eq!((fake.reads(), fake.writes()), (1, 0));
    }

    #[test]
    fn a_failed_removal_of_the_legacy_item_does_not_fail_the_load() {
        let fake = Fake::default();
        fake.put("session", "\"s\"");
        fake.deny_removes(true);
        let v = vault(&fake);
        assert_eq!(v.load::<String>("session").unwrap().as_deref(), Some("s"));
        assert!(fake.get(VAULT_ACCOUNT).is_some());
    }

    #[test]
    fn a_failed_vault_write_keeps_the_legacy_item_and_still_serves_the_value() {
        let fake = Fake::default();
        fake.put("session", "\"s\"");
        fake.deny_writes(true);
        let v = vault(&fake);
        assert_eq!(v.load::<String>("session").unwrap().as_deref(), Some("s"));
        assert_eq!(fake.get("session").as_deref(), Some("\"s\""));
        fake.reset_counts();
        assert_eq!(v.load::<String>("session").unwrap().as_deref(), Some("s"));
        assert_eq!(fake.reads(), 0);
    }

    #[test]
    fn a_vault_next_to_unmigrated_legacy_items_serves_both() {
        let fake = Fake::default();
        let v = vault(&fake);
        v.save("new", &"n").unwrap();
        fake.put("old", "\"o\"");
        let v = vault(&fake);
        assert_eq!(v.load::<String>("new").unwrap().as_deref(), Some("n"));
        assert_eq!(v.load::<String>("old").unwrap().as_deref(), Some("o"));
        assert_eq!(fake.get("old"), None);
        let doc: Doc = serde_json::from_str(&fake.get(VAULT_ACCOUNT).unwrap()).unwrap();
        assert_eq!(doc.secrets.get("old"), Some(&text("o")));
        assert_eq!(doc.secrets.get("new"), Some(&text("n")));
    }

    #[test]
    fn nothing_stored_costs_one_read_per_launch_once_the_first_launch_has_looked() {
        let fake = Fake::default();
        let first = vault(&fake);
        for account in ["session", "oauth-app", "github-logins"] {
            assert!(first.load::<Value>(account).unwrap().is_none());
        }
        fake.reset_counts();
        let second = vault(&fake);
        for account in ["session", "oauth-app", "github-logins"] {
            assert!(second.load::<Value>(account).unwrap().is_none());
        }
        assert_eq!((fake.reads(), fake.writes()), (1, 0));
    }

    #[test]
    fn a_denied_vault_read_is_remembered_and_nothing_is_written_over_it() {
        let fake = Fake::default();
        fake.put(VAULT_ACCOUNT, "{\"secrets\":{\"a\":\"one\"}}");
        fake.deny_reads_of(VAULT_ACCOUNT);
        let v = vault(&fake);
        let first = v.load::<String>("a").unwrap_err().to_string();
        assert!(first.contains("won't ask again"));
        assert!(v.load::<String>("b").is_err());
        assert!(v.save("c", &"x").is_err());
        assert!(v.delete("a").is_err());
        assert_eq!((fake.reads(), fake.writes(), fake.removes()), (1, 0, 0));
    }

    #[test]
    fn a_denied_legacy_read_is_not_asked_again() {
        let fake = Fake::default();
        fake.put("session", "\"s\"");
        fake.deny_reads_of("session");
        let v = vault(&fake);
        assert!(v.load::<String>("session").is_err());
        assert!(v.load::<String>("session").is_err());
        assert_eq!(fake.reads(), 2);
        assert_eq!(v.load::<String>("other").unwrap(), None);
    }

    #[test]
    fn a_corrupt_vault_is_an_error_and_is_left_alone() {
        let fake = Fake::default();
        fake.put(VAULT_ACCOUNT, "not json");
        let v = vault(&fake);
        assert!(v.load::<String>("a").is_err());
        assert!(v.save("a", &"x").is_err());
        assert_eq!(fake.get(VAULT_ACCOUNT).as_deref(), Some("not json"));
    }

    #[test]
    fn debug_output_shows_no_values() {
        let fake = Fake::default();
        let v = vault(&fake);
        v.save("a", &"hunter2").unwrap();
        assert!(!format!("{v:?}").contains("hunter2"));
    }
}
