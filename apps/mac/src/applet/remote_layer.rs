//! Objective-C `CAContext` + detached `GPUIView` wrapper for Plan B2 cross-process rendering.
//!
//! Keeps `GPUIView` retained after `[ns_view removeFromSuperview]` so AppKit layout/resize passes
//! never wipe `ca_ctx.layer`, and dispatches `[ns_view displayLayer: layer]` asynchronously on
//! `_dispatch_main_q` outside GPUI's `AppCell` mutable borrow.

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2::{class, msg_send};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

unsafe extern "C" {
    static _dispatch_main_q: c_void;
    fn dispatch_async_f(queue: *const c_void, context: *mut c_void, work: extern "C" fn(*mut c_void));
}

struct DisplayLayerWork {
    ns_view: *mut AnyObject,
    alive: Arc<AtomicBool>,
}

extern "C" fn display_layer_on_main_queue(ctx: *mut c_void) {
    // SAFETY: `ctx` was allocated by `Box::into_raw` in `RemoteLayer::schedule_display` and
    // `ns_view` was retained via `Retained::into_raw`.
    let work = unsafe { Box::from_raw(ctx.cast::<DisplayLayerWork>()) };
    let ns_view = unsafe { Retained::from_raw(work.ns_view) };
    if !work.alive.load(Ordering::Acquire) {
        return;
    }
    let Some(ns_view) = ns_view else {
        return;
    };
    unsafe {
        let layer: *mut AnyObject = msg_send![&*ns_view, layer];
        if !layer.is_null() {
            let _: () = msg_send![&*ns_view, displayLayer: layer];
            let _: () = msg_send![class!(CATransaction), flush];
        }
    }
}

pub struct RemoteLayer {
    ca_ctx: Retained<AnyObject>,
    ns_view: Retained<AnyObject>,
    layer: Retained<AnyObject>,
    context_id: u32,
    alive: Arc<AtomicBool>,
}

impl RemoteLayer {
    /// Detaches `GPUIView` from `NSWindow.contentView` and binds its backing `CALayer`
    /// (`CAMetalLayer`) to a fresh `CAContext` for cross-process `CALayerHost` hosting.
    pub fn attach(window: &gpui::Window, width: f64, height: f64, scale: f64) -> Result<Self, String> {
        let handle = <gpui::Window as HasWindowHandle>::window_handle(window).map_err(|e| format!("failed to get GPUI window handle: {e}"))?;
        let ns_view_ptr: NonNull<AnyObject> = match handle.as_raw() {
            RawWindowHandle::AppKit(appkit) => appkit.ns_view.cast(),
            other => return Err(format!("expected AppKit window handle, got {other:?}")),
        };

        // SAFETY: Called on the main thread while `window` is alive; `ns_view_ptr` points to
        // `GPUIView`, which we retain before removing from `NSWindow.contentView`.
        unsafe {
            let ns_view = Retained::retain(ns_view_ptr.as_ptr()).ok_or("null GPUIView pointer")?;
            let _: () = msg_send![&*ns_view, setWantsLayer: Bool::YES];
            let layer_ptr: *mut AnyObject = msg_send![&*ns_view, layer];
            let layer = Retained::retain(layer_ptr).ok_or("GPUIView has no backing CALayer")?;

            let ca_ctx_cls = AnyClass::get(c"CAContext").ok_or("QuartzCore CAContext class unavailable")?;
            let opts: Retained<AnyObject> = msg_send![class!(NSDictionary), dictionary];
            let ca_ctx: Option<Retained<AnyObject>> = msg_send![ca_ctx_cls, remoteContextWithOptions: &*opts];
            let ca_ctx = ca_ctx.ok_or("CAContext remoteContextWithOptions returned nil")?;
            let context_id: u32 = msg_send![&*ca_ctx, contextId];
            if context_id == 0 {
                return Err("CAContext returned contextId 0".to_string());
            }

            // Stage 0 verified fix: detaching `GPUIView` from `contentView` prevents AppKit from
            // resetting `ca_ctx.layer` to nil on the next layout/resize pass.
            let _: () = msg_send![&*ns_view, removeFromSuperview];
            let _: () = msg_send![&*ca_ctx, setLayer: &*layer];

            let remote = Self {
                ca_ctx,
                ns_view,
                layer,
                context_id,
                alive: Arc::new(AtomicBool::new(true)),
            };
            remote.resize(width, height, scale);
            Ok(remote)
        }
    }

    pub fn context_id(&self) -> u32 {
        self.context_id
    }

    pub fn resize(&self, width: f64, height: f64, scale: f64) {
        let w = width.max(1.0);
        let h = height.max(1.0);
        // SAFETY: Main thread access to retained `GPUIView` and its backing `CALayer`.
        unsafe {
            let _: () = msg_send![&*self.ns_view, setFrameSize: NSSize { width: w, height: h }];
            let frame = NSRect {
                origin: NSPoint { x: 0.0, y: 0.0 },
                size: NSSize { width: w, height: h },
            };
            let _: () = msg_send![&*self.layer, setFrame: frame];
            if scale > 0.0 {
                let _: () = msg_send![&*self.layer, setContentsScale: scale];
            }
        }
    }

    /// Schedules `[ns_view displayLayer: layer]` asynchronously on `_dispatch_main_q`.
    /// Must only be called outside GPUI `cx.update` / `window.update` closures.
    pub fn schedule_display(&self) {
        if !self.alive.load(Ordering::Acquire) {
            return;
        }
        let work = Box::new(DisplayLayerWork {
            ns_view: Retained::into_raw(self.ns_view.clone()),
            alive: self.alive.clone(),
        });
        // SAFETY: `_dispatch_main_q` is Apple's static main dispatch queue and `work` ownership
        // transfers to `display_layer_on_main_queue`.
        unsafe {
            dispatch_async_f(
                (&raw const _dispatch_main_q).cast::<c_void>(),
                Box::into_raw(work).cast::<c_void>(),
                display_layer_on_main_queue,
            );
        }
    }

    pub fn teardown(&mut self) {
        if !self.alive.swap(false, Ordering::AcqRel) {
            return;
        }
        // SAFETY: Clear `ca_ctx.layer` before the owning GPUI window closes.
        unsafe {
            let _: () = msg_send![&*self.ca_ctx, setLayer: std::ptr::null_mut::<AnyObject>()];
        }
    }
}

impl Drop for RemoteLayer {
    fn drop(&mut self) {
        self.teardown();
    }
}
