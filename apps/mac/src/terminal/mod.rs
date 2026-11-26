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
pub use status::{RunningState, SpawnSpec, TerminalEvent, TerminalStatus, agent_display_name};
pub use view::TerminalView;

gpui::actions!(terminal, [Copy, Paste, Clear, ScrollPageUp, ScrollPageDown, ScrollToBottom]);
