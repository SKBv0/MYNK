//! OpenRouter API key in the OS credential store. Blocking; call through `state::run_blocking`.
//! Never logged or included in error messages.

use keyring::Entry;

use crate::error::{AppError, AppResult};

const SERVICE: &str = "MYNK Desktop";
const ACCOUNT: &str = "openrouter_api_key";

fn entry() -> AppResult<Entry> {
    entry_for(SERVICE)
}

fn entry_for(service: &str) -> AppResult<Entry> {
    Entry::new(service, ACCOUNT)
        .map_err(|e| AppError::Keyring(format!("Could not open the credential store: {e}")))
}

pub fn get_api_key() -> AppResult<Option<String>> {
    read_key(entry()?)
}

fn read_key(entry: Entry) -> AppResult<Option<String>> {
    match entry.get_password() {
        Ok(value) if value.trim().is_empty() => Ok(None),
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Keyring(format!(
            "Could not read the OpenRouter API key: {e}"
        ))),
    }
}

pub fn set_api_key(api_key: &str) -> AppResult<()> {
    entry()?
        .set_password(api_key)
        .map_err(|e| AppError::Keyring(format!("Could not save the OpenRouter API key: {e}")))
}

pub fn clear_api_key() -> AppResult<()> {
    delete_key(entry()?)
}

fn delete_key(entry: Entry) -> AppResult<()> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Keyring(format!(
            "Could not remove the OpenRouter API key: {e}"
        ))),
    }
}

// Gated as a whole: an empty `mod tests` off Windows makes `use super::*` a clippy error.
#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// Guards the `windows-native` feature; without it keyring 3 mocks storage and loses the key.
    /// The pid-suffixed throwaway service name keeps the developer's real key untouched.
    #[test]
    fn the_windows_credential_store_persists_across_entries() {
        let service = format!("MYNK Desktop test {}", std::process::id());
        let secret = "mynk-test-secret-not-a-real-key";

        entry_for(&service)
            .expect("entry")
            .set_password(secret)
            .expect("write to Windows Credential Manager");
        let read_back = read_key(entry_for(&service).expect("fresh entry"));
        let cleanup = delete_key(entry_for(&service).expect("fresh entry"));

        assert_eq!(
            read_back.expect("read").as_deref(),
            Some(secret),
            "a fresh entry must see the stored value; is keyring's windows-native feature on?"
        );
        cleanup.expect("delete");
        assert_eq!(
            read_key(entry_for(&service).expect("fresh entry")).expect("read after delete"),
            None
        );
    }
}
