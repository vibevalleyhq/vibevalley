//! Any agent that speaks the Agent Client Protocol (ACP) on stdio.
//!
//! Generic ACP agents use ACP v1 via `agent-client-protocol`'s `Client.v1()`
//! over a line transport bound to a child process we manage directly.
//! `AcpFlavor::Antigravity` extends the flow for `agy >= 1.5.0` (ACP v2
//! handshake, stdout auth-URL pre-filtering, `_meta.antigravity.systemPrompt`,
//! client-side permissions with non-auto-approved `interaction_*` questions,
//! payload normalization, mid-turn `session/prompt` steering, background
//! continuation, and read-only SQLite silent-error detection).

pub(crate) mod antigravity;
pub(crate) mod antigravity_db;
pub(crate) mod antigravity_swarm;
mod projector;
mod runtime;
mod session;
mod spec;
mod turn_state;

#[cfg(test)]
pub(crate) use self::projector::Projector;
pub use self::runtime::AcpRuntime;
#[cfg(test)]
pub(crate) use self::spec::models_of;
pub use self::spec::{AcpAgentSpec, builtin_agents};
