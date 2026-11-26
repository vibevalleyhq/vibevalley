//! `debug.*`: built-in DevTools diagnostics module (timeline collector,
//! fault-injection overrides, read-only trajectory inspector, live topology
//! graph, state/cache telemetry, and redacted `debug-bundle.zip` exporter).
//!
//! Disabled by default (`debug_enabled = false`): all 9 `debug.*` endpoints
//! refuse with `BizCode::Refused`, and zero observer/fault-gate hooks are
//! attached to `Router` or `oar`.

pub mod bundle;
pub mod collector;
pub mod redact;
mod service;
pub mod trajectory;
mod types;

pub use service::DebugKit;
pub use types::{DebugDataSource, DebugParts, DebugStateSnapshot, EmptyDebugDataSource, RuntimeProbeSnapshot};
