//! Unified desktop debugging and live VDP (VibeValley DevTools Protocol) host.
//!
//! Live loopback VDP (`--remote-debugging-port=<port>` or `VIBEVALLEY_DEBUG_PORT=<port>`)
//! lives in [`vdp`] and delegates window/shell inspection & automation to [`executor`].
//! Disabled by default: when no debug port is configured, zero sockets open, zero
//! `debug.json` files are written, and zero per-frame/log overhead is incurred.

pub(crate) mod executor;
pub(crate) mod vdp;

#[cfg(test)]
mod tests;

use std::sync::Arc;

use gpui::{App, Entity, WindowHandle};

use crate::shell::Shell;

pub use crate::vdp_bus::configure_from_env_and_args;
#[cfg(test)]
pub use crate::vdp_bus::parse_debug_port_from;
pub(crate) use crate::vdp_bus::set_vdp_log_active;
pub use vdp::VdpServer;

struct RunningVdp {
    server: VdpServer,
    dispatcher: Arc<vdp::GpuiVdpDispatcher>,
}

impl gpui::Global for RunningVdp {}

/// Starts the opt-in live VDP host server when configured via `--remote-debugging-port` or `VIBEVALLEY_DEBUG_PORT`.
pub fn start(shell: Entity<Shell>, window: WindowHandle<Shell>, cx: &mut App) {
    let Some(port) = crate::vdp_bus::configured_port() else {
        return;
    };

    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel::<vdp::GpuiCommand>();
    vdp::spawn_gpui_command_loop(shell, window, cmd_rx, cx);

    if let Some(running) = cx.try_global::<RunningVdp>() {
        running.dispatcher.rebind_window(cmd_tx);
        return;
    }

    let server_bridge = cx.try_global::<crate::hosted::BridgeHub>().map(|b| b.0.server().clone());
    let dispatcher = Arc::new(vdp::GpuiVdpDispatcher::new(cmd_tx, server_bridge));
    let home = crate::env::server_home();
    let channel = vibevalley_protocol::home::current_channel().as_str().to_string();
    let app_version = crate::env::bundle_version();

    match VdpServer::start(port, home, channel, app_version, dispatcher.clone()) {
        Ok(server) => {
            let info = server.endpoint_info();
            tracing::info!(
                target: "vibevalley::vdp",
                port = info.port,
                ws_url = %info.ws_url,
                home = %info.home,
                "VDP remote debugging server listening"
            );
            let hub = server.hub();
            crate::vdp_bus::install_active_vdp(Arc::new(move |notification| hub.emit(notification)), dispatcher.clone());
            cx.set_global(RunningVdp { server, dispatcher });
        }
        Err(err) => {
            tracing::error!(target: "vibevalley::vdp", error = %err, "failed to start VDP server");
            crate::vdp_bus::set_vdp_enabled(false);
        }
    }
}

/// Gracefully shuts down the VDP server and removes `$VIBEVALLEY_HOME/debug.json`.
pub fn shutdown(cx: &mut App) {
    set_vdp_log_active(false);
    crate::vdp_bus::clear_active_vdp();
    if cx.has_global::<RunningVdp>() {
        let running = cx.remove_global::<RunningVdp>();
        running.server.shutdown();
    }
}
