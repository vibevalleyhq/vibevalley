//! Single typed executor for shell inspection, input dispatch, screenshots, and commands.
//!
//! Live VDP WebSocket requests (`vdp.rs`) and DevTools Canvas Inspector execute through
//! this module so inspection and automation behavior share one source of truth.

mod commands;
mod input;
mod inspect;

use serde_json::Value;
use vibevalley_protocol::{HostCapturedImage, VdpError};

pub(crate) use crate::vdp_bus::{hit_from_hosted_node, select_deepest_hit};
pub(crate) use commands::{
    exec_close_pane, exec_dispatch_action, exec_get_terminal_grid, exec_get_update_state, exec_navigate, exec_open_pane, exec_page_draw, exec_resize,
    exec_run_command, exec_save, exec_send_terminal_input, exec_set_diorama_clock, exec_set_theme, exec_ui_highlight, exec_ui_set_inspector_mode,
};
pub(crate) use input::{dispatch_keys, dispatch_mouse, dispatch_text};
#[cfg(feature = "shot")]
pub(crate) use inspect::encode_shell_png;
pub(crate) use inspect::{capture_screenshot, collect_targets, page_metrics, resolve_hosted_view};
pub use inspect::{dump, step_unpainted_dioramas};

/// Result of executing a GPUI-thread VDP command; heavy encoding or async webview
/// captures return a pending handle so neither the GPUI thread nor Tokio blocks.
pub(crate) enum GpuiExecResult {
    Ready(Result<Value, VdpError>),
    PendingWebviewCapture(tokio::sync::oneshot::Receiver<Result<HostCapturedImage, String>>),
    #[cfg(feature = "shot")]
    PendingShellPng {
        image: image::RgbaImage,
        width: Option<u32>,
        height: Option<u32>,
    },
}
