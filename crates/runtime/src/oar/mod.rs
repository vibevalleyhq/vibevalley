//! A Rust implementation of the oar (Open Agent Runtime) interface:
//! one API to drive many local coding agents. See https://github.com/botiverse/oar
//!
//! Async Tokio-native API: events and voyage records arrive on
//! `tokio::sync::mpsc::UnboundedReceiver` channels and I/O-bearing runtime and
//! session operations return `BoxFuture`.
//!
//! CONTRACT: the items in this file are the public API other crates compile
//! against. The owner may add items; do not rename or remove existing ones.

pub use crate::BoxFuture;

mod accounting;
pub mod acp;
mod claude;
mod codex;
pub mod core;
mod frames;
pub mod mcp_install;
mod process;
pub mod record;
mod registry;
pub mod scripted;
mod sdk;
mod specs;
pub mod subagent;
mod traits;
mod types;
pub mod voyage;

pub use crate::oar::core::{OarObserver, StatusFold, derive_status, has_observer, rejection, set_observer};
pub(crate) use crate::oar::process::reap_process_group;
pub use crate::oar::process::{CommandOutput, run_output_with_timeout};
pub use crate::oar::record::{RecordHeader, read_record_with_header};
pub use accounting::TokenTotals;
pub use mcp_install::{
    McpHostId, McpHostReport, McpInstallError, McpInstallState, install_mcp_host, install_mcp_host_in, list_mcp_hosts, list_mcp_hosts_in, mcp_status,
    mcp_status_in, uninstall_mcp_host, uninstall_mcp_host_in,
};
pub use registry::{Registry, default_runtimes, read_record, set_binary};
pub use specs::{BUILTIN_RUNTIME_SPECS, RuntimeSpec, runtime_refused_options, runtime_spec};
pub(crate) use traits::find_runtime;
pub use traits::{Runtime, Session};
pub use types::{
    AccountUsage, AgentError, Capabilities, ChildToolCall, ChildTranscriptStep, ContentBlock, ControlAction, ControlOutcome, ControlStatus, Event, EventKind,
    FileChangeKind, Installation, InteractionDecision, InteractionOption, McpServer, ModelInfo, PermissionDecision, PermissionMode, RefusableOption, Result,
    SessionOptions, SessionStatus, StopReason, SubagentPlanStatus, SubagentPlanStep, SubagentSnapshot, SubagentStatus, SwarmMember, SwarmMemberState,
    SwarmMessage, SwarmPlan, SwarmPlanThread, SwarmSnapshot, ToolAction, TurnOptions, Usage, UsageWindow, mcp_config, tool_action,
};

#[cfg(test)]
mod tests;
