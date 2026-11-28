use sha2::{Digest as _, Sha256};
use subtle::ConstantTimeEq as _;

/// Computes lowercase hex-encoded SHA-256 digest of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    hex::encode(digest)
}

/// Constant-time equality comparison for arbitrary byte slices.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && bool::from(a.ct_eq(b))
}

/// Verifies `raw_token` against an expected lowercase hex SHA-256 digest in constant time.
pub fn verify_sha256_hex(raw_token: &str, expected_hex: &str) -> bool {
    let actual = sha256_hex(raw_token.as_bytes());
    constant_time_eq(actual.as_bytes(), expected_hex.as_bytes())
}

/// Checks whether `token` starts with `prefix` and has at least `min_body_len` non-whitespace chars after it.
pub fn has_token_prefix(token: &str, prefix: &str, min_body_len: usize) -> bool {
    token
        .strip_prefix(prefix)
        .is_some_and(|rest| rest.len() >= min_body_len && !rest.chars().any(char::is_whitespace))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_and_constant_time_verification_work() {
        let token = "vv_dev_token_1234567890";
        let digest = sha256_hex(token.as_bytes());
        assert_eq!(digest.len(), 64);
        assert!(verify_sha256_hex(token, &digest));
        assert!(!verify_sha256_hex("vv_dev_wrong_1234567890", &digest));
        assert!(has_token_prefix(token, "vv_dev_", 8));
        assert!(!has_token_prefix("vv_dev_short", "vv_dev_", 8));
    }
}
