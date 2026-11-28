//! Domain-agnostic remote gateway primitives: constant-time pairing code store,
//! prefixed device token generation & SHA-256 verification (via [`crate::core::secret`]),
//! Bearer / loopback HTTP header guards, and private LAN/CGNAT IP classification.

mod network;
mod pairing;

pub use network::{
    detect_lan_ipv4, is_allowed_private_bind_ip, is_cgnat_ipv4, is_lan_ipv4, is_loopback_host, is_same_origin_loopback, parse_bearer_header, probe_lan_ipv4,
};
pub use pairing::{
    DEFAULT_PAIR_CODE_ALPHABET, IssuedPairCode, PairingConfig, PairingError, PairingStore, build_pair_deep_link, generate_pair_code, generate_prefixed_token,
    hash_token, random_32_bytes, verify_token_format, verify_token_hash,
};
