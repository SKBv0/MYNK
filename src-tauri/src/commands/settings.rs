use tauri::{AppHandle, Runtime};

use crate::error::{AppError, AppResult};
use crate::settings::{self, AISettings, AISettingsUpdate, PersistedSettings};

/// Upper bound for a pasted OpenRouter key (real keys are well under 100 characters).
pub const MAX_API_KEY_CHARS: usize = 1024;

/// The settings screen must open even when the OS credential store is unreachable. The failure
/// is logged and reported as "no key"; using or saving the key still surfaces the real error.
fn key_presence(result: AppResult<bool>) -> bool {
    result.unwrap_or_else(|error| {
        log::warn!("Could not check the credential store for an OpenRouter key: {error}");
        false
    })
}

#[tauri::command]
pub async fn get_ai_settings<R: Runtime>(app: AppHandle<R>) -> AppResult<AISettings> {
    let stored = settings::load(&app).await?;
    let has_key = key_presence(settings::has_api_key().await);
    Ok(AISettings::from_persisted(stored, has_key))
}

/// Saves settings; only the base URL is validated here. The key check runs before the save and
/// cannot fail the command, so an error here always means nothing was saved.
#[tauri::command]
pub async fn update_ai_settings<R: Runtime>(
    app: AppHandle<R>,
    payload: AISettingsUpdate,
) -> AppResult<AISettings> {
    let updated = PersistedSettings::try_from(payload)?;
    let has_key = key_presence(settings::has_api_key().await);
    settings::save(&app, updated.clone()).await?;
    Ok(AISettings::from_persisted(updated, has_key))
}

fn validate_api_key(api_key: &str) -> AppResult<String> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return Err(AppError::invalid_input(
            "The OpenRouter API key cannot be empty.",
        ));
    }
    if trimmed.chars().count() > MAX_API_KEY_CHARS {
        return Err(AppError::invalid_input(format!(
            "The OpenRouter API key is too long (max {MAX_API_KEY_CHARS} characters). Check that only the key was pasted."
        )));
    }
    Ok(trimmed.to_string())
}

#[tauri::command]
pub async fn set_openrouter_api_key(api_key: String) -> AppResult<()> {
    let key = validate_api_key(&api_key)?;
    settings::set_api_key(key).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_keyring_failure_reads_as_no_key() {
        assert!(key_presence(Ok(true)));
        assert!(!key_presence(Ok(false)));
        assert!(!key_presence(Err(AppError::Keyring("locked".into()))));
    }

    #[test]
    fn api_keys_are_trimmed_and_bounded() {
        assert_eq!(validate_api_key("  sk-or-1  ").expect("ok"), "sk-or-1");
        assert_eq!(
            validate_api_key("   ").expect_err("empty").kind(),
            "invalidInput"
        );
        let limit = "k".repeat(MAX_API_KEY_CHARS);
        assert!(validate_api_key(&limit).is_ok());
        let error = validate_api_key(&format!("{limit}k")).expect_err("too long");
        assert_eq!(error.kind(), "invalidInput");
        assert!(error.to_string().contains("1024"), "{error}");
    }
}

#[tauri::command]
pub async fn clear_openrouter_api_key() -> AppResult<()> {
    settings::clear_api_key().await
}
