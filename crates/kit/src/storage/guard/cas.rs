//! Content-addressed storage (CAS) SHA-256 verification and token extraction helpers.

use std::collections::HashSet;
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::core::secret::sha256_hex;

/// Errors returned by CAS content verification helpers.
#[derive(Debug, thiserror::Error)]
pub enum CasError {
    #[error("CAS hash mismatch (expected `{expected}`, actual `{actual}`)")]
    HashMismatch { expected: String, actual: String },

    #[error("CAS size mismatch (expected {expected} bytes, actual {actual} bytes)")]
    SizeMismatch { expected: u64, actual: u64 },

    #[error("CAS I/O error: {0}")]
    Io(#[from] std::io::Error),
}

fn is_lower_hex(b: u8) -> bool {
    matches!(b, b'0'..=b'9' | b'a'..=b'f')
}

/// Returns `true` when `s` is a canonical 64-character lowercase hexadecimal SHA-256 digest.
pub fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(is_lower_hex)
}

/// Verifies that `bytes` has SHA-256 hex equal to `expected_hash`, returning the actual hash on success.
pub fn verify_expected_hash(bytes: &[u8], expected_hash: &str) -> Result<String, CasError> {
    let actual = sha256_hex(bytes);
    if actual != expected_hash {
        return Err(CasError::HashMismatch {
            expected: expected_hash.to_owned(),
            actual,
        });
    }
    Ok(actual)
}

/// Streams a file from disk in 64 KiB chunks to verify its exact byte length and SHA-256 digest.
pub async fn verify_file_cas_async(path: &Path, expected_size: u64, expected_hash: &str) -> Result<(), CasError> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut digest = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = tokio::io::AsyncReadExt::read(&mut file, &mut buffer).await?;
        if n == 0 {
            break;
        }
        size = size.saturating_add(n as u64);
        if size > expected_size {
            return Err(CasError::SizeMismatch {
                expected: expected_size,
                actual: size,
            });
        }
        digest.update(&buffer[..n]);
    }
    if size != expected_size {
        return Err(CasError::SizeMismatch {
            expected: expected_size,
            actual: size,
        });
    }
    let actual = hex::encode(digest.finalize());
    if actual != expected_hash {
        return Err(CasError::HashMismatch {
            expected: expected_hash.to_owned(),
            actual,
        });
    }
    Ok(())
}

/// Scans `text` for 64-character lowercase hexadecimal tokens (SHA-256 content hashes)
/// delimited by non-hex characters.
pub fn extract_sha256_tokens(text: &str, out: &mut HashSet<String>) {
    let bytes = text.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if is_lower_hex(bytes[i]) {
            let start = i;
            while i < bytes.len() && is_lower_hex(bytes[i]) {
                i += 1;
            }
            if i - start == 64 && !bytes.get(i).is_some_and(u8::is_ascii_hexdigit) {
                out.insert(text[start..i].to_owned());
            }
        } else {
            i += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cas_verify_and_extract_tokens() {
        let payload = b"hello-cas";
        let hash = sha256_hex(payload);
        assert!(is_sha256_hex(&hash));
        assert!(!is_sha256_hex(&hash.to_uppercase()));
        assert!(!is_sha256_hex("abc"));

        assert_eq!(verify_expected_hash(payload, &hash).unwrap(), hash);
        assert!(matches!(verify_expected_hash(b"tampered", &hash), Err(CasError::HashMismatch { .. })));

        let text = format!("ref=/{hash} short={} long={} upper={}", "a".repeat(63), "b".repeat(65), "C".repeat(64));
        let mut found = HashSet::new();
        extract_sha256_tokens(&text, &mut found);
        assert_eq!(found, HashSet::from([hash]));
    }

    #[tokio::test]
    async fn verify_file_cas_async_checks_size_and_hash() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blob");
        let payload = b"streamed-cas-content";
        let hash = sha256_hex(payload);
        tokio::fs::write(&path, payload).await.unwrap();

        verify_file_cas_async(&path, payload.len() as u64, &hash).await.unwrap();
        assert!(matches!(
            verify_file_cas_async(&path, (payload.len() + 1) as u64, &hash).await,
            Err(CasError::SizeMismatch { .. })
        ));
        assert!(matches!(
            verify_file_cas_async(&path, payload.len() as u64, &"0".repeat(64)).await,
            Err(CasError::HashMismatch { .. })
        ));
    }
}
