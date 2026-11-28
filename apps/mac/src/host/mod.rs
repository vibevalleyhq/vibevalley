//! Native halves of VibeValley's host capabilities (packages/protocol/src/host.ts).
//!
//! All raw OS/ObjC/C FFI is isolated under `crate::platform`; this module and its
//! children contain zero `unsafe`.

#![forbid(unsafe_code)]

mod editors;
mod files;
mod ops;
mod oslog;
#[cfg(test)]
mod tests;

pub use crate::platform::system_observer_ffi::SystemObserver;
pub use editors::{EditorOption, EditorTarget, cached_editor_options, detect_editors_blocking, open_with_app};
pub(crate) use files::percent_decode;
pub use files::{Storage, copy_file, file_info, folder_info, open, read_file, reveal, worktree_file};
pub use ops::{cached_mono_fonts, decode_host_op, disable_default_font_smoothing, handle_stateless_op, mono_fonts, random_seed_hex, set_app_icon};
pub use oslog::OsLogLayer;

#[cfg(test)]
use ops::{filter_mono_fonts, random_bytes_hex, sha256_hex};

/// Whether this application is currently active in the macOS foreground.
pub fn is_app_active() -> bool {
    crate::platform::objc_app::is_app_active()
}

/// Delivers a native macOS notification via `UNUserNotificationCenter` without shelling out.
/// When running unpackaged (no `CFBundleIdentifier`, e.g. `cargo run` / tests), logs instead
/// of invoking `UNUserNotificationCenter` which aborts outside an `.app` bundle.
pub fn notify(title: &str, body: &str) -> Result<(), String> {
    crate::platform::objc_app::deliver_notification(title, body)
}

/// Returns macOS keyboard focus from an embedded native child view (such as a
/// `WKWebView`) back to GPUI's `contentView` when the user clicks a GPUI surface.
pub fn restore_window_first_responder() {
    crate::platform::objc_app::restore_window_first_responder();
}

/// Convenience hook for wiring macOS wake and network-recovery events directly into
/// `Hub::on_system_wake()`.
pub fn observe_system_wake(on_wake: impl Fn() + Send + Sync + 'static) -> SystemObserver {
    use crate::platform::system_observer_ffi::{SystemEvent, observe_system_events};

    observe_system_events(move |event| match event {
        SystemEvent::Wake | SystemEvent::NetworkChanged { reachable: true } => on_wake(),
        SystemEvent::NetworkChanged { reachable: false } => {}
    })
}
