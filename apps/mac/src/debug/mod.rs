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
use std::sync::atomic::{AtomicBool, Ordering};

use gpui::{App, Entity, WindowHandle};
use parking_lot::Mutex;
use serde_json::Value;
use vibevalley_protocol::{VdpLogEntry, VdpLogLevel, VdpNotification, VdpPageFrameEvent, VdpUiConsoleEvent};

use crate::shell::Shell;

pub use vdp::{VdpServer, call_remote_vdp};

static VDP_CONFIGURED_PORT: Mutex<Option<u16>> = Mutex::new(None);
static VDP_ENABLED: AtomicBool = AtomicBool::new(false);
static VDP_LOG_ACTIVE: AtomicBool = AtomicBool::new(false);

struct RunningVdp {
    server: VdpServer,
    dispatcher: Arc<vdp::GpuiVdpDispatcher>,
}

impl gpui::Global for RunningVdp {}

/// Parses `--remote-debugging-port=<port>` / `--remote-debugging-port <port>` from CLI args,
/// falling back to `VIBEVALLEY_DEBUG_PORT=<port>`. Returns `None` when disabled or invalid.
pub fn parse_debug_port_from<I, S>(args: I, env_port: Option<&str>) -> Option<u16>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        let s = arg.as_ref();
        if let Some(raw) = s.strip_prefix("--remote-debugging-port=") {
            return raw.trim().parse::<u16>().ok();
        }
        if s == "--remote-debugging-port" {
            return iter.next().and_then(|next| next.as_ref().trim().parse::<u16>().ok());
        }
    }
    env_port.map(str::trim).filter(|s| !s.is_empty()).and_then(|raw| raw.parse::<u16>().ok())
}

/// Captures `--remote-debugging-port` / `VIBEVALLEY_DEBUG_PORT` once at startup so
/// hosted views created before the main window opens know whether VDP is enabled.
pub fn configure_from_env_and_args() {
    let env_port = std::env::var("VIBEVALLEY_DEBUG_PORT").ok();
    let port = parse_debug_port_from(std::env::args().skip(1), env_port.as_deref());
    *VDP_CONFIGURED_PORT.lock() = port;
    VDP_ENABLED.store(port.is_some(), Ordering::Release);
}

/// Whether VDP remote debugging is enabled for this process.
pub fn vdp_enabled() -> bool {
    VDP_ENABLED.load(Ordering::Acquire)
}

/// Whether VDP live log / frame / UI console streaming is currently active.
pub fn is_vdp_log_active() -> bool {
    VDP_LOG_ACTIVE.load(Ordering::Relaxed)
}

pub(crate) fn set_vdp_log_active(active: bool) {
    VDP_LOG_ACTIVE.store(active, Ordering::Release);
}

/// Starts the opt-in live VDP host server when configured via `--remote-debugging-port` or `VIBEVALLEY_DEBUG_PORT`.
pub fn start(shell: Entity<Shell>, window: WindowHandle<Shell>, cx: &mut App) {
    let Some(port) = *VDP_CONFIGURED_PORT.lock() else {
        return;
    };

    let (cmd_tx, cmd_rx) = flume::unbounded::<vdp::GpuiCommand>();
    vdp::spawn_gpui_command_loop(shell, window, cmd_rx, cx);

    if let Some(running) = cx.try_global::<RunningVdp>() {
        running.dispatcher.rebind_window(cmd_tx);
        return;
    }

    let server_bridge = cx.try_global::<crate::hosted::BridgeHub>().map(|b| b.0.server().clone());
    let dispatcher = Arc::new(vdp::GpuiVdpDispatcher::new(cmd_tx, server_bridge));
    let home = crate::hosted::server_home();
    let channel = vibevalley_protocol::home::current_channel().as_str().to_string();
    let app_version = crate::update::bundle_version().to_string();

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
            vdp::install_active_hub(server.hub());
            cx.set_global(RunningVdp { server, dispatcher });
        }
        Err(err) => {
            tracing::error!(target: "vibevalley::vdp", error = %err, "failed to start VDP server");
            VDP_ENABLED.store(false, Ordering::Release);
        }
    }
}

/// Gracefully shuts down the VDP server and removes `$VIBEVALLEY_HOME/debug.json`.
pub fn shutdown(cx: &mut App) {
    VDP_LOG_ACTIVE.store(false, Ordering::Release);
    vdp::clear_active_hub();
    if cx.has_global::<RunningVdp>() {
        let running = cx.remove_global::<RunningVdp>();
        running.server.shutdown();
    }
}

/// Resolves an in-flight `UI.*` VDP probe response arriving from a `HostedView`'s engine thread.
pub fn resolve_ui_response(value: &Value) {
    vdp::resolve_ui_response(value);
}

/// Forwards a `vdp_ui_log` console message emitted by `vdpProbe.ts` to active VDP subscribers.
pub fn emit_ui_console(view: &str, value: &Value) {
    if !vdp_enabled() {
        return;
    }
    let level = value["level"].as_str().map(VdpLogLevel::from_console_level).unwrap_or(VdpLogLevel::Info);
    let message = value["message"].as_str().unwrap_or_default().to_string();
    let timestamp = value["time"].as_i64().unwrap_or_else(vdp::now_millis);
    vdp::emit_notification(VdpNotification::UiConsole(VdpUiConsoleEvent {
        view: view.to_string(),
        level,
        message,
        timestamp,
    }));
}

/// Forwards an engine error reported by a `HostedView` when VDP is active.
pub fn emit_ui_error(view: &str, message: &str) {
    if !vdp_enabled() {
        return;
    }
    vdp::emit_notification(VdpNotification::UiConsole(VdpUiConsoleEvent {
        view: view.to_string(),
        level: VdpLogLevel::Error,
        message: message.to_string(),
        timestamp: vdp::now_millis(),
    }));
}

/// Forwards a host tracing event to VDP `Log.entry` subscribers when `Log.enable` is active.
pub fn emit_log_entry(level: VdpLogLevel, source: &str, message: String, fields: Option<Value>) {
    if !is_vdp_log_active() {
        return;
    }
    vdp::emit_notification(VdpNotification::LogEntry(VdpLogEntry {
        level,
        source: source.to_string(),
        message,
        timestamp: vdp::now_millis(),
        fields,
    }));
}

/// Forwards a GPUI frame timing sample to VDP `Page.frame` subscribers when `Log.enable` is active.
pub fn emit_page_frame(frame_ms: f64, width: f32, height: f32) {
    if !is_vdp_log_active() {
        return;
    }
    vdp::emit_notification(VdpNotification::PageFrame(VdpPageFrameEvent {
        frame_ms,
        timestamp: vdp::now_millis(),
        width: Some(width),
        height: Some(height),
    }));
}
