//! Outbound WebSocket machine daemon (`vibevalley machine up`) managing local OAR runtimes,
//! disconnect-resilient sessions with `seq`-indexed ring buffers, idempotent inputs,
//! ephemeral local `/mcp` reverse proxying, and isolated git worktrees.

mod auth;
pub mod mcp_proxy;
mod runner;
mod runtime_probe;
pub mod session;
mod transport;
pub mod worktree;

pub use auth::{
    MACHINE_AUTH_FILE, MachineAgentConfig, MachineAuthConfig, detect_platform, load_machine_auth, machine_auth_path, machine_ws_url, save_machine_auth,
};
pub use runner::MachineAgent;
pub use runtime_probe::{build_runtime_registry, probe_runtime_summaries_async};
pub use transport::TransportSlot;
pub use vibevalley_protocol::Secret;
