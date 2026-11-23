//! Unified diagnostics redactor: scrubs live `Setting` secrets, sensitive
//! key names, and common credential token prefixes before anything leaves the
//! server or is written into a debug bundle.

use std::borrow::Cow;
use std::sync::LazyLock;

use regex::{Captures, Regex};
use serde_json::Value;
use vibevalley_protocol::SessionEvent;

use crate::modules::infra::setting::Setting;

pub const REDACTED: &str = "[REDACTED]";

static BEARER_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bBearer\s+(?:\[REDACTED\]|[A-Za-z0-9\-._~+/=]{4,})").expect("valid bearer regex"));

static TOKEN_PREFIX_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:sk-[A-Za-z0-9_\-]{4,}|ghp_[A-Za-z0-9_\-]{4,}|gho_[A-Za-z0-9_\-]{4,}|xoxb-[A-Za-z0-9_\-]{4,}|AIza[A-Za-z0-9_\-]{4,})")
        .expect("valid token prefix regex")
});

static QUOTED_KV_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)(["']?(?:apiKey|api_key|accessToken|access_token|refreshToken|refresh_token|privateKey|private_key|secret|password|authorization|cookie)["']?\s*[:=]\s*["'])([^"'\r\n]+)(["'])"#,
    )
    .expect("valid quoted kv regex")
});

static UNQUOTED_KV_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(api_?key|access_?token|refresh_?token|private_?key|secret|password|authorization|cookie)\s*=\s*([^\s,&;}\]]+)")
        .expect("valid unquoted kv regex")
});

pub(crate) fn contains_ascii_ci(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() {
        return true;
    }
    haystack.windows(needle.len()).any(|w| w.eq_ignore_ascii_case(needle))
}

fn is_sensitive_key_normalized(lower: &str, compact: &str) -> bool {
    if compact == "tokens" || compact.ends_with("tokens") {
        return false;
    }
    if matches!(
        compact,
        "apikey"
            | "token"
            | "secret"
            | "password"
            | "passwd"
            | "authorization"
            | "cookie"
            | "setcookie"
            | "accesstoken"
            | "refreshtoken"
            | "idtoken"
            | "authtoken"
            | "bearertoken"
            | "sessiontoken"
            | "privatekey"
            | "secretkey"
            | "clientsecret"
            | "deepseekapikey"
    ) {
        return true;
    }
    compact.ends_with("apikey")
        || compact.ends_with("secret")
        || compact.ends_with("password")
        || compact.ends_with("privatekey")
        || compact.ends_with("accesstoken")
        || compact.ends_with("refreshtoken")
        || compact.ends_with("authtoken")
        || compact.ends_with("bearertoken")
        || compact.ends_with("cookie")
        || lower.ends_with("_token")
        || lower.ends_with("-token")
}

/// Returns true when a JSON object key name denotes a secret or credential.
/// Intentionally excludes LLM token-count keys (`tokens`, `inputTokens`, ...).
pub fn is_sensitive_key(key: &str) -> bool {
    if key.len() <= 64 && key.is_ascii() {
        let mut lower_buf = [0u8; 64];
        let mut compact_buf = [0u8; 64];
        let mut compact_len = 0usize;
        for (i, &b) in key.as_bytes().iter().enumerate() {
            let lb = b.to_ascii_lowercase();
            lower_buf[i] = lb;
            if lb != b'_' && lb != b'-' {
                compact_buf[compact_len] = lb;
                compact_len += 1;
            }
        }
        let lower = std::str::from_utf8(&lower_buf[..key.len()]).unwrap_or("");
        let compact = std::str::from_utf8(&compact_buf[..compact_len]).unwrap_or("");
        return is_sensitive_key_normalized(lower, compact);
    }
    let lower = key.to_ascii_lowercase();
    let compact: String = lower.chars().filter(|c| *c != '_' && *c != '-').collect();
    is_sensitive_key_normalized(&lower, &compact)
}

#[derive(Debug, Clone, Default)]
pub struct Redactor {
    secrets: Vec<String>,
}

impl Redactor {
    pub fn from_setting(setting: &Setting) -> Self {
        Self {
            secrets: setting.live_secrets(),
        }
    }

    pub fn with_secrets(raw: impl IntoIterator<Item = String>) -> Self {
        let mut secrets = Vec::new();
        for item in raw {
            let trimmed = item.trim();
            if trimmed.chars().count() >= 6 && !secrets.iter().any(|s: &String| s == trimmed) {
                secrets.push(trimmed.to_string());
            }
        }
        secrets.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
        Self { secrets }
    }

    pub fn redact_cow<'a>(&self, input: &'a str, count: &mut u32) -> Cow<'a, str> {
        if input.is_empty() {
            return Cow::Borrowed(input);
        }
        let mut text = Cow::Borrowed(input);
        for secret in &self.secrets {
            if text.contains(secret.as_str()) {
                let hits = text.match_indices(secret.as_str()).count();
                text = Cow::Owned(text.replace(secret.as_str(), REDACTED));
                *count = count.saturating_add(hits as u32);
            }
        }
        if text.len() >= 11 && (!text.is_ascii() || contains_ascii_ci(text.as_bytes(), b"bearer")) {
            let mut changed = false;
            let replaced = BEARER_RE.replace_all(&text, |caps: &Captures<'_>| {
                let matched = &caps[0];
                if matched.ends_with(REDACTED) {
                    matched.to_string()
                } else {
                    changed = true;
                    *count = count.saturating_add(1);
                    REDACTED.to_string()
                }
            });
            if changed && let Cow::Owned(next) = replaced {
                text = Cow::Owned(next);
            }
        }
        if text.len() >= 7
            && let Cow::Owned(next) = TOKEN_PREFIX_RE.replace_all(&text, |_caps: &Captures<'_>| {
                *count = count.saturating_add(1);
                REDACTED
            })
        {
            text = Cow::Owned(next);
        }
        if text.len() >= 10 && text.as_bytes().iter().any(|&b| b == b':' || b == b'=') && text.as_bytes().iter().any(|&b| b == b'"' || b == b'\'') {
            let mut changed = false;
            let replaced = QUOTED_KV_RE.replace_all(&text, |caps: &Captures<'_>| {
                if &caps[2] == REDACTED {
                    caps[0].to_string()
                } else {
                    changed = true;
                    *count = count.saturating_add(1);
                    format!("{}{REDACTED}{}", &caps[1], &caps[3])
                }
            });
            if changed && let Cow::Owned(next) = replaced {
                text = Cow::Owned(next);
            }
        }
        if text.len() >= 8 && text.as_bytes().contains(&b'=') {
            let mut changed = false;
            let replaced = UNQUOTED_KV_RE.replace_all(&text, |caps: &Captures<'_>| {
                let val = &caps[2];
                if val == REDACTED || val.starts_with('"') || val.starts_with('\'') {
                    caps[0].to_string()
                } else {
                    changed = true;
                    *count = count.saturating_add(1);
                    format!("{}={REDACTED}", &caps[1])
                }
            });
            if changed && let Cow::Owned(next) = replaced {
                text = Cow::Owned(next);
            }
        }
        text
    }

    pub fn redact_owned(&self, input: String, count: &mut u32) -> String {
        match self.redact_cow(&input, count) {
            Cow::Borrowed(_) => input,
            Cow::Owned(clean) => clean,
        }
    }

    pub fn redact_str(&self, input: &str, count: &mut u32) -> String {
        self.redact_cow(input, count).into_owned()
    }

    pub fn redact_opt_str(&self, input: Option<String>, count: &mut u32) -> Option<String> {
        input.map(|s| self.redact_owned(s, count))
    }

    fn redact_sensitive_value(&self, value: Value, count: &mut u32) -> Value {
        match value {
            Value::Null => Value::Null,
            Value::String(s) => {
                if s.is_empty() || s == REDACTED {
                    Value::String(s)
                } else {
                    *count = count.saturating_add(1);
                    Value::String(REDACTED.to_string())
                }
            }
            Value::Array(mut items) => {
                for item in &mut items {
                    let orig = std::mem::replace(item, Value::Null);
                    *item = self.redact_sensitive_value(orig, count);
                }
                Value::Array(items)
            }
            Value::Object(mut map) => {
                for (_, v) in &mut map {
                    let orig = std::mem::replace(v, Value::Null);
                    *v = self.redact_sensitive_value(orig, count);
                }
                Value::Object(map)
            }
            Value::Bool(_) | Value::Number(_) => {
                *count = count.saturating_add(1);
                Value::String(REDACTED.to_string())
            }
        }
    }

    pub fn redact_value(&self, value: Value, count: &mut u32) -> Value {
        match value {
            Value::Null | Value::Bool(_) | Value::Number(_) => value,
            Value::String(s) => Value::String(self.redact_owned(s, count)),
            Value::Array(mut items) => {
                for item in &mut items {
                    let orig = std::mem::replace(item, Value::Null);
                    *item = self.redact_value(orig, count);
                }
                Value::Array(items)
            }
            Value::Object(mut map) => {
                for (k, v) in &mut map {
                    let orig = std::mem::replace(v, Value::Null);
                    *v = if is_sensitive_key(k) {
                        self.redact_sensitive_value(orig, count)
                    } else {
                        self.redact_value(orig, count)
                    };
                }
                Value::Object(map)
            }
        }
    }

    pub fn redact_session_event(&self, mut ev: SessionEvent, count: &mut u32) -> SessionEvent {
        ev.text = self.redact_owned(ev.text, count);
        ev.input = self.redact_opt_str(ev.input, count);
        ev.output = self.redact_opt_str(ev.output, count);
        if let Some(perm) = &mut ev.permission {
            perm.summary = self.redact_owned(std::mem::take(&mut perm.summary), count);
            perm.input = self.redact_opt_str(perm.input.take(), count);
        }
        if let Some(interaction) = &mut ev.interaction {
            interaction.question = self.redact_owned(std::mem::take(&mut interaction.question), count);
            for opt in &mut interaction.options {
                opt.label = self.redact_owned(std::mem::take(&mut opt.label), count);
                opt.description = self.redact_opt_str(opt.description.take(), count);
            }
        }
        if let Some(res) = &mut ev.interaction_resolution {
            res.choice = self.redact_opt_str(res.choice.take(), count);
        }
        ev
    }

    /// Scans raw bytes for any unredacted live secret or credential token prefix.
    pub fn contains_leak(&self, bytes: &[u8]) -> Option<String> {
        let text = String::from_utf8_lossy(bytes);
        for secret in &self.secrets {
            if text.contains(secret.as_str()) {
                return Some("live secret found in export bytes".into());
            }
        }
        for m in BEARER_RE.find_iter(&text) {
            if !m.as_str().ends_with(REDACTED) {
                return Some("unredacted Bearer token found in export bytes".into());
            }
        }
        if TOKEN_PREFIX_RE.is_match(&text) {
            return Some("unredacted credential prefix found in export bytes".into());
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn redacts_live_secrets_sensitive_keys_and_token_prefixes_without_corrupting_token_counts() {
        let redactor = Redactor::with_secrets(vec!["my-super-live-secret-999".into(), "short".into()]);
        let mut count = 0;
        let val = redactor.redact_value(
            json!({
                "apiKey": "plain-api-key",
                "api_key": "snake-api-key",
                "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.payload",
                "nested": {
                    "accessToken": "acc-123",
                    "refreshToken": "ref-456",
                    "privateKey": "-----BEGIN PRIVATE KEY-----",
                    "cookie": "sid=abc123",
                    "password": "hunter2"
                },
                "note": "leaked my-super-live-secret-999 and sk-live123456 and ghp_abcdefghij and gho_klmnopqrst and xoxb-12345-abc and AIzaSyDummyKey12345 and Bearer rawtok1234 and task-1234",
                "tokens": {
                    "input": 1200,
                    "output": 340,
                    "inputTokens": 1200
                }
            }),
            &mut count,
        );

        assert!(count >= 12, "expected >=12 redactions, got {count}");
        assert_eq!(val["apiKey"], REDACTED);
        assert_eq!(val["api_key"], REDACTED);
        assert_eq!(val["authorization"], REDACTED);
        assert_eq!(val["nested"]["accessToken"], REDACTED);
        assert_eq!(val["nested"]["refreshToken"], REDACTED);
        assert_eq!(val["nested"]["privateKey"], REDACTED);
        assert_eq!(val["nested"]["cookie"], REDACTED);
        assert_eq!(val["nested"]["password"], REDACTED);
        // Token usage counters must remain intact.
        assert_eq!(val["tokens"]["input"], 1200);
        assert_eq!(val["tokens"]["output"], 340);
        assert_eq!(val["tokens"]["inputTokens"], 1200);
        let note = val["note"].as_str().unwrap();
        assert!(note.contains("task-1234"), "non-secret word ending in sk- must not be falsely scrubbed");
        for secret in [
            "my-super-live-secret-999",
            "sk-live123456",
            "ghp_abcdefghij",
            "gho_klmnopqrst",
            "xoxb-12345-abc",
            "AIzaSyDummyKey12345",
            "rawtok1234",
            "plain-api-key",
            "hunter2",
        ] {
            assert!(!val.to_string().contains(secret), "secret leaked: {secret}");
        }
        assert!(redactor.contains_leak(val.to_string().as_bytes()).is_none());
    }

    #[test]
    fn empty_secrets_and_clean_input_borrows_without_allocating() {
        let redactor = Redactor::default();
        let mut count = 0;
        let clean = redactor.redact_cow("GET /issues/42 -> 0 (1.2ms)", &mut count);
        assert!(matches!(clean, Cow::Borrowed(_)));
        assert_eq!(count, 0);

        let already = redactor.redact_cow("Authorization: Bearer [REDACTED]", &mut count);
        assert!(matches!(already, Cow::Borrowed(_)));
        assert_eq!(count, 0);
    }
}
