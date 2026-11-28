//! Isolated macOS FFI and OS/Objective-C safety boundaries.
//!
//! All raw C, CoreFoundation, CoreText, AppKit, QuartzCore, Network.framework,
//! and `os_log` `unsafe` calls for the desktop host live in these leaf modules
//! so upper host and UI modules compile with `#![forbid(unsafe_code)]`.

pub mod audio_ffi;
pub mod capture_ffi;
pub mod objc_app;
pub mod oslog_ffi;
pub mod remote_layer_ffi;
pub mod system_observer_ffi;
pub mod tray_ffi;
