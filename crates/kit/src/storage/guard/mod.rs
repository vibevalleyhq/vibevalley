//! Path traversal guards and content-addressed SHA-256 verification helpers.

pub mod cas;
pub mod path;

pub use cas::{CasError, extract_sha256_tokens, is_sha256_hex, verify_expected_hash, verify_file_cas_async};
pub use path::{normalize_key, normalize_prefix, safe_join};
