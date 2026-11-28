//! Zero-I/O foundational primitives: wall clock, secrets, resilience, UTF-16 text, and orthogonal fault types.

pub mod fault;
pub mod resilience;
pub mod secret;
pub mod text;
pub mod time;

pub use fault::{DirtyMask, ErrorClass, WireError};
pub use resilience::{RetryPolicy, parse_retry_after, sleep_cancelable};
pub use secret::{Secret, constant_time_eq, sha256_hex, verify_sha256_hex};
pub use text::{clip_utf16, collapse_whitespace, head, within};
pub use time::{Clock, ManualClock, SharedClock, SystemClock, system_clock};
