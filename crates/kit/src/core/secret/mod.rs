//! Redacted credentials and constant-time SHA-256 token hashing.

mod hash;
mod value;

pub use hash::{constant_time_eq, has_token_prefix, sha256_hex, verify_sha256_hex};
pub use value::Secret;
