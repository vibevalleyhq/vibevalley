use std::fmt;

use serde::{Deserialize, Serialize};

/// Seven orthogonal domain-agnostic error categories used across `vibevalley-kit`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorClass {
    InvalidInput,
    NotFound,
    Unauthorized,
    Conflict,
    RateLimited,
    Unavailable,
    Internal,
}

impl ErrorClass {
    pub const fn is_retryable(self) -> bool {
        matches!(self, Self::RateLimited | Self::Unavailable)
    }

    pub const fn http_status(self) -> u16 {
        match self {
            Self::InvalidInput => 400,
            Self::Unauthorized => 401,
            Self::NotFound => 404,
            Self::Conflict => 409,
            Self::RateLimited => 429,
            Self::Unavailable => 503,
            Self::Internal => 500,
        }
    }
}

/// Lightweight serializable error envelope carrying an [`ErrorClass`] and message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireError {
    pub class: ErrorClass,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
}

impl WireError {
    pub fn new(class: ErrorClass, message: impl Into<String>) -> Self {
        Self {
            class,
            message: message.into(),
            retry_after_ms: None,
        }
    }

    pub fn with_retry_after_ms(mut self, retry_after_ms: u64) -> Self {
        self.retry_after_ms = Some(retry_after_ms);
        self
    }
}

impl fmt::Display for WireError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.class, self.message)
    }
}

impl std::error::Error for WireError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_class_retryability_and_http_mapping() {
        assert!(ErrorClass::RateLimited.is_retryable());
        assert!(ErrorClass::Unavailable.is_retryable());
        assert!(!ErrorClass::InvalidInput.is_retryable());
        assert_eq!(ErrorClass::Conflict.http_status(), 409);
        let err = WireError::new(ErrorClass::RateLimited, "slow down").with_retry_after_ms(1500);
        assert_eq!(err.retry_after_ms, Some(1500));
        assert!(err.to_string().contains("slow down"));
    }
}
