use std::convert::Infallible;
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

/// A redacted credential: serializes transparently as a string, never reveals raw bytes in `Debug` or `Display`.
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
    fn secret_redacts_in_debug_display_and_roundtrips_json() {
        let blank = Secret::new("  ");
        assert!(blank.is_empty());
        assert_eq!(blank.hint(), "none");
        assert_eq!(format!("{blank:?}"), "Secret(none)");

        let short = Secret::new("short123");
        assert_eq!(short.hint(), "[redacted]");
        assert!(!format!("{short:?}").contains("short123"));

        let long = Secret::from("vv_dev_0123456789abcdef");
        assert_eq!(long.hint(), "…cdef");
        assert!(!format!("{long:?}").contains("0123456789"));
        let json = serde_json::to_string(&long).unwrap();
        let parsed: Secret = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, long);
    }
}
