use keyring::Entry;
use serde::{de::DeserializeOwned, Serialize};

use crate::error::Result;

const SERVICE: &str = "dk.hobbii.gossamr";

pub fn load<T: DeserializeOwned>(account: &str) -> Result<Option<T>> {
    match Entry::new(SERVICE, account)?.get_password() {
        Ok(json) => Ok(Some(serde_json::from_str(&json)?)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn save<T: Serialize>(account: &str, value: &T) -> Result<()> {
    Entry::new(SERVICE, account)?.set_password(&serde_json::to_string(value)?)?;
    Ok(())
}

pub fn delete(account: &str) -> Result<()> {
    match Entry::new(SERVICE, account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
