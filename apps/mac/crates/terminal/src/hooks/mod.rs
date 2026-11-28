//! Declarative, opt-in scoped terminal hooks (all OFF by default).
//!
//! Hooks inject environment variables, scoped `PATH` shims, and/or isolated
//! `ZDOTDIR` zsh snippets strictly into the spawned PTY for tabs/workspaces
//! that opt in. Global dotfiles (`~/.zshrc`, `~/.bashrc`), global `PATH`, and
//! external system terminals are never mutated.

mod config;
mod runtime;

#[cfg(test)]
mod tests;

pub const ENV_ACTIVE_HOOKS: &str = "VV_ACTIVE_HOOKS";
pub const ENV_TERM_HOOK_ZSH: &str = "VV_TERM_HOOK_ZSH";
pub const ENV_IDEGRAPH_HOOK: &str = "IDEGRAPH_HOOK";
pub const ENV_IDEGRAPH_SCOPED: &str = "IDEGRAPH_SCOPED";
pub const ENV_IDEGRAPH_WORKSPACE: &str = "IDEGRAPH_WORKSPACE";
pub const ENV_HOOK_IDEGRAPH: &str = "VV_HOOK_IDEGRAPH";
pub const ENV_HOOK_IDEGRAPH_ZSH: &str = "VV_HOOK_IDEGRAPH_ZSH";

pub use config::{
    ActiveHookInfo, BuiltinHookPreset, HookSource, PathShimSpec, ResolvedTerminalHooks, TabHookOverrides, TerminalHookTemplate, TerminalHooksConfig,
    WorkspaceHookConfig, is_reserved_env_key, is_valid_shim_name, normalize_hook_id, normalize_workspace_key,
};
pub(crate) use runtime::{HookRuntime, apply_pty_hooks};
