//! Redacted credential wrapper (`Secret`): serializes transparently as a JSON string,
//! never exposes raw bytes in `Debug` or `Display`, and masks short secrets (`<= 8` chars)
//! as `[redacted]` while showing only the last 4 characters (`…xxxx`) for longer tokens.

use std::convert::Infallible;
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::contract::{KeySource, KeyStatus};

/// A key or token: serializes transparently as a string, never reveals its raw value in `Debug` or `Display`.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(raw: impl Into<String>) -> Self {
        Self(raw.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.trim().is_empty()
    }

    pub fn trimmed(&self) -> Option<Self> {
        let trimmed = self.0.trim();
        (!trimmed.is_empty()).then(|| Self(trimmed.to_string()))
    }

    /// Safe redacted suffix hint: `"none"` when blank, `"[redacted]"` for short secrets (`<= 8` chars),
    /// otherwise `"…<last 4 chars>"`.
    pub fn hint(&self) -> String {
        let trimmed = self.0.trim();
        if trimmed.is_empty() {
            return "none".into();
        }
        if trimmed.chars().count() <= 8 {
            return "[redacted]".into();
        }
        let tail: String = trimmed.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
        format!("…{tail}")
    }

    pub fn status(&self, source: KeySource) -> KeyStatus {
        if self.is_empty() {
            KeyStatus { source: None, hint: None }
        } else {
            KeyStatus {
                source: Some(source),
                hint: Some(self.hint()),
            }
        }
    }
}

impl From<String> for Secret {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for Secret {
    fn from(value: &str) -> Self {
        Self(value.to_string())
    }
}

impl FromStr for Secret {
    type Err = Infallible;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Self(s.to_string()))
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.is_empty() {
            f.write_str("Secret(none)")
        } else {
            write!(f, "Secret({})", self.hint())
        }
    }
}

impl fmt::Display for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.hint())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_redacts_in_debug_display_hint_and_status() {
        let blank = Secret::new("   ");
        assert!(blank.is_empty());
        assert_eq!(blank.trimmed(), None);
        assert_eq!(blank.hint(), "none");
        assert_eq!(format!("{blank:?}"), "Secret(none)");
        assert_eq!(format!("{blank}"), "none");
        assert_eq!(blank.status(KeySource::Settings), KeyStatus { source: None, hint: None });

        let short = Secret::new("short123");
        assert!(!short.is_empty());
        assert_eq!(short.hint(), "[redacted]");
        assert_eq!(format!("{short:?}"), "Secret([redacted])");
        assert_eq!(format!("{short}"), "[redacted]");
        assert!(!format!("{short:?}").contains("short123"));
        assert_eq!(
            short.status(KeySource::Config),
            KeyStatus {
                source: Some(KeySource::Config),
                hint: Some("[redacted]".into()),
            }
        );

        let long_raw = "vv_dev_0123456789abcdef";
        let long = Secret::from(long_raw);
        assert_eq!(long.expose(), long_raw);
        assert_eq!(long.hint(), "…cdef");
        assert_eq!(format!("{long:?}"), "Secret(…cdef)");
        assert_eq!(format!("{long}"), "…cdef");
        assert!(!format!("{long:?}").contains(long_raw));
        assert_eq!(
            long.status(KeySource::Settings),
            KeyStatus {
                source: Some(KeySource::Settings),
                hint: Some("…cdef".into()),
            }
        );
    }

    #[test]
    fn secret_serializes_transparently_and_parses_from_str() {
        let parsed: Secret = "  sk-secret-9876  ".parse().unwrap();
        assert_eq!(parsed.trimmed().unwrap().expose(), "sk-secret-9876");
        let json = serde_json::to_string(&parsed).unwrap();
        assert_eq!(json, "\"  sk-secret-9876  \"");
        let roundtrip: Secret = serde_json::from_str(&json).unwrap();
        assert_eq!(roundtrip, parsed);
    }
}
