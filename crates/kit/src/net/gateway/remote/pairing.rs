use std::collections::VecDeque;

use sha2::{Digest as _, Sha256};

use crate::core::secret::{Secret, constant_time_eq, has_token_prefix, sha256_hex, verify_sha256_hex};

/// Unambiguous 32-character Crockford-like pairing code alphabet (no O/0/I/1).
/// Because 256 is a multiple of 32, masking 5 bits has zero modulo bias.
pub const DEFAULT_PAIR_CODE_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/// Derives 32 uniform OS-random bytes from three UUID v4 values (366 bits of CSPRNG input).
pub fn random_32_bytes() -> [u8; 32] {
    let mut hasher = Sha256::new();
    for _ in 0..3 {
        hasher.update(uuid::Uuid::new_v4().as_bytes());
    }
    hasher.finalize().into()
}

/// Generates a random pairing code of `len` characters from [`DEFAULT_PAIR_CODE_ALPHABET`].
pub fn generate_pair_code(len: usize) -> String {
    let mut out = String::with_capacity(len);
    while out.len() < len {
        let bytes = random_32_bytes();
        for b in bytes {
            if out.len() == len {
                break;
            }
            out.push(DEFAULT_PAIR_CODE_ALPHABET[(b & 0x1f) as usize] as char);
        }
    }
    out
}

/// Generates a prefixed 256-bit hex device token wrapped in a redacted [`Secret`].
pub fn generate_prefixed_token(prefix: &str) -> Secret {
    let bytes = random_32_bytes();
    Secret::new(format!("{prefix}{}", hex::encode(bytes)))
}

/// Lowercase hex SHA-256 digest of a raw Bearer token.
pub fn hash_token(token: &str) -> String {
    sha256_hex(token.as_bytes())
}

/// Validates that `token` carries `prefix` followed by at least `min_body_len` non-whitespace chars.
pub fn verify_token_format(token: &str, prefix: &str, min_body_len: usize) -> bool {
    has_token_prefix(token, prefix, min_body_len)
}

/// Constant-time verification of `raw_token` against an expected lowercase hex SHA-256 digest.
pub fn verify_token_hash(raw_token: &str, expected_sha256_hex: &str) -> bool {
    verify_sha256_hex(raw_token, expected_sha256_hex)
}

/// Builds a pairing deep-link URL (`<base>?url=<url>&code=<code>[&scope=<scope>]`).
pub fn build_pair_deep_link(scheme_base: &str, url: &str, code: &str, scope: Option<&str>) -> Result<String, url::ParseError> {
    let mut deep = url::Url::parse(scheme_base)?;
    {
        let mut pairs = deep.query_pairs_mut();
        pairs.append_pair("url", url).append_pair("code", code);
        if let Some(scope) = scope
            && !scope.is_empty()
        {
            pairs.append_pair("scope", scope);
        }
    }
    Ok(deep.to_string())
}

/// Configuration for [`PairingStore`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PairingConfig {
    pub code_len: usize,
    pub ttl_ms: i64,
    pub expired_retention_ms: i64,
    pub max_active_codes: usize,
    pub max_retained_expired: usize,
    pub rate_limit_window_ms: i64,
    pub max_failed_attempts: usize,
}

impl Default for PairingConfig {
    fn default() -> Self {
        Self {
            code_len: 6,
            ttl_ms: 5 * 60 * 1000,
            expired_retention_ms: 30 * 60 * 1000,
            max_active_codes: 8,
            max_retained_expired: 16,
            rate_limit_window_ms: 60 * 1000,
            max_failed_attempts: 10,
        }
    }
}

/// Newly issued single-use pairing code and expiration timestamp (Unix ms).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuedPairCode {
    pub code: String,
    pub expires_at: i64,
}

/// Failure modes for [`PairingStore::redeem`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairingError {
    RateLimited,
    InvalidCode,
    ExpiredCode,
}

#[derive(Debug, Clone)]
struct PairEntry<M> {
    code: String,
    meta: M,
    expires_at: i64,
}

/// Bounded, constant-time, rate-limited single-use pairing code store.
pub struct PairingStore<M> {
    config: PairingConfig,
    codes: Vec<PairEntry<M>>,
    failed_attempts: VecDeque<i64>,
}

impl<M> Default for PairingStore<M> {
    fn default() -> Self {
        Self::new(PairingConfig::default())
    }
}

impl<M> PairingStore<M> {
    pub fn new(config: PairingConfig) -> Self {
        Self {
            config,
            codes: Vec::new(),
            failed_attempts: VecDeque::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.codes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.codes.is_empty()
    }

    pub fn clear_codes(&mut self) {
        self.codes.clear();
    }

    /// Issues a new single-use pairing code associated with `meta`, pruning stale
    /// entries and enforcing active/expired retention bounds.
    pub fn issue(&mut self, now_ms: i64, meta: M) -> IssuedPairCode {
        let expires_at = now_ms + self.config.ttl_ms;
        self.codes.retain(|entry| entry.expires_at > now_ms - self.config.expired_retention_ms);

        let expired_count = self.codes.iter().filter(|e| e.expires_at <= now_ms).count();
        if expired_count > self.config.max_retained_expired {
            let mut drop_n = expired_count - self.config.max_retained_expired;
            self.codes.retain(|e| {
                if e.expires_at <= now_ms && drop_n > 0 {
                    drop_n -= 1;
                    false
                } else {
                    true
                }
            });
        }

        while self.codes.iter().filter(|e| e.expires_at > now_ms).count() >= self.config.max_active_codes {
            if let Some(pos) = self.codes.iter().position(|e| e.expires_at > now_ms) {
                self.codes.remove(pos);
            } else {
                break;
            }
        }

        let mut candidate = generate_pair_code(self.config.code_len);
        while self.codes.iter().any(|e| e.code == candidate) {
            candidate = generate_pair_code(self.config.code_len);
        }
        self.codes.push(PairEntry {
            code: candidate.clone(),
            meta,
            expires_at,
        });
        IssuedPairCode { code: candidate, expires_at }
    }

    /// Redeems `raw_code` in constant time, enforcing rate limits and expiry.
    pub fn redeem(&mut self, now_ms: i64, raw_code: &str) -> Result<M, PairingError> {
        while self
            .failed_attempts
            .front()
            .is_some_and(|&ts| now_ms.saturating_sub(ts) >= self.config.rate_limit_window_ms)
        {
            self.failed_attempts.pop_front();
        }
        if self.failed_attempts.len() >= self.config.max_failed_attempts {
            return Err(PairingError::RateLimited);
        }

        let submitted = raw_code.trim().to_ascii_uppercase();
        let mut matched = None;
        for (idx, entry) in self.codes.iter().enumerate() {
            if constant_time_eq(entry.code.as_bytes(), submitted.as_bytes()) {
                matched = Some(idx);
            }
        }
        let Some(pos) = matched else {
            self.failed_attempts.push_back(now_ms);
            return Err(PairingError::InvalidCode);
        };
        let entry = self.codes.remove(pos);
        if entry.expires_at <= now_ms {
            self.failed_attempts.push_back(now_ms);
            return Err(PairingError::ExpiredCode);
        }
        Ok(entry.meta)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_generation_hashing_and_constant_time_verification_work() {
        let secret = generate_prefixed_token("vv_dev_");
        let raw = secret.expose();
        assert_eq!(raw.len(), "vv_dev_".len() + 64);
        assert!(verify_token_format(raw, "vv_dev_", 1));
        assert!(!verify_token_format("vv_dev_", "vv_dev_", 1));

        let digest = hash_token(raw);
        assert_eq!(digest.len(), 64);
        assert!(verify_token_hash(raw, &digest));
        assert!(!verify_token_hash("vv_dev_wrong", &digest));
    }

    #[test]
    fn pairing_store_enforces_cap_expiry_one_time_use_and_rate_limit() {
        let mut store = PairingStore::<&'static str>::new(PairingConfig {
            code_len: 6,
            ttl_ms: 1_000,
            expired_retention_ms: 5_000,
            max_active_codes: 2,
            max_retained_expired: 2,
            rate_limit_window_ms: 10_000,
            max_failed_attempts: 3,
        });

        let c1 = store.issue(100, "first");
        let c2 = store.issue(101, "second");
        let c3 = store.issue(102, "third");
        assert_eq!(store.len(), 2);
        assert_eq!(store.redeem(103, &c1.code), Err(PairingError::InvalidCode));

        assert_eq!(store.redeem(200, &c2.code.to_lowercase()), Ok("second"));
        assert_eq!(store.redeem(201, &c2.code), Err(PairingError::InvalidCode));

        assert_eq!(store.redeem(1102, &c3.code), Err(PairingError::ExpiredCode));
        let c4 = store.issue(1200, "fourth");
        assert_eq!(store.redeem(1201, &c4.code), Err(PairingError::RateLimited));

        let c5 = store.issue(10_200, "fifth");
        assert_eq!(store.redeem(10_201, &c5.code), Ok("fifth"));
    }
}
