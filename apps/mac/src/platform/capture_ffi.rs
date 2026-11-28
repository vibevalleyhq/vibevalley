//! Safe wrapper around WebKit's native `WKWebView` snapshot Objective-C shim.

use std::ffi::{CStr, c_char, c_void};

use raw_window_handle::{HasWindowHandle, RawWindowHandle};

#[derive(Debug)]
pub struct RawRgba {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

type SnapshotCb = extern "C" fn(ctx: *mut c_void, rgba: *const u8, width: u32, height: u32, error: *const c_char);

// SAFETY: `vv_capture_webview_snapshot` is statically linked from the native Objective-C shim
// compiled by `build.rs` and invokes `callback(ctx, ...)` exactly once.
unsafe extern "C" {
    fn vv_capture_webview_snapshot(parent_ns_view: *mut c_void, target_width: f64, target_height: f64, callback: SnapshotCb, ctx: *mut c_void);
}

extern "C" fn on_webview_snapshot(ctx: *mut c_void, rgba: *const u8, width: u32, height: u32, error: *const c_char) {
    // SAFETY: `ctx` was allocated with `Box::into_raw` in `start_webview_snapshot` and
    // WebKit / `vv_capture_webview_snapshot` invokes this callback exactly once.
    let tx = unsafe { Box::from_raw(ctx.cast::<tokio::sync::oneshot::Sender<Result<RawRgba, String>>>()) };
    let result = if !error.is_null() {
        // SAFETY: `vv_capture_webview_snapshot` passes a valid NUL-terminated UTF-8 string when non-null.
        let msg = unsafe { CStr::from_ptr(error) }.to_string_lossy().into_owned();
        Err(msg)
    } else if rgba.is_null() || width == 0 || height == 0 {
        Err("empty webview snapshot".into())
    } else {
        match (width as usize).checked_mul(height as usize).and_then(|n| n.checked_mul(4)) {
            Some(len) => {
                // SAFETY: The Objective-C snapshot buffer is valid for `width * height * 4` bytes for the duration of this callback.
                let slice = unsafe { std::slice::from_raw_parts(rgba, len) };
                Ok(RawRgba {
                    rgba: slice.to_vec(),
                    width,
                    height,
                })
            }
            None => Err("snapshot byte length overflow".into()),
        }
    };
    let _ = tx.send(result);
}

/// Starts an asynchronous native `WKWebView` snapshot for the given AppKit `window`.
pub fn start_webview_snapshot(window: &gpui::Window, dst_w: u32, dst_h: u32) -> Result<tokio::sync::oneshot::Receiver<Result<RawRgba, String>>, String> {
    let handle = HasWindowHandle::window_handle(window).map_err(|e| format!("window handle unavailable: {e}"))?;
    let ns_view = match handle.as_raw() {
        RawWindowHandle::AppKit(appkit) => appkit.ns_view.as_ptr(),
        _ => return Err("webview capture is only supported on AppKit windows".into()),
    };

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<RawRgba, String>>();
    let ctx = Box::into_raw(Box::new(tx)).cast::<c_void>();
    // SAFETY: `ns_view` is a live `NSView *` owned by GPUI's window on the main thread,
    // and `on_webview_snapshot` reclaims `ctx` exactly once.
    unsafe {
        vv_capture_webview_snapshot(ns_view, f64::from(dst_w), f64::from(dst_h), on_webview_snapshot, ctx);
    }
    Ok(rx)
}
