//! The terminal pane: owns one `TermSession`, turns GPUI input into session
//! calls, and repaints when the session says it is dirty.

mod element;
mod keys;
mod preview;
mod status;
mod view;

#[cfg(test)]
mod tests;

#[cfg(test)]
pub use element::Geometry;
pub(crate) use status::first_command_token;
pub use status::{
    HookToggleAction, RunningState, SpawnSpec, TerminalEvent, TerminalHookStatus, TerminalStatus, agent_display_name, classify_hook_toggle_action,
    hook_badge_label, hook_badge_tooltip, hook_names_csv,
};
pub use view::TerminalView;

gpui::actions!(terminal, [Copy, Paste, Clear, ScrollPageUp, ScrollPageDown, ScrollToBottom]);
