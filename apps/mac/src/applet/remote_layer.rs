//! Safe facade over [`crate::platform::remote_layer_ffi::RemoteLayerHandle`] for
//! cross-process `CALayerHost` rendering.

#![forbid(unsafe_code)]

use crate::platform::remote_layer_ffi::RemoteLayerHandle;

pub struct RemoteLayer(RemoteLayerHandle);

impl RemoteLayer {
    /// Detaches `GPUIView` from `NSWindow.contentView` and binds its backing `CALayer`
    /// (`CAMetalLayer`) to a fresh `CAContext` for cross-process `CALayerHost` hosting.
    pub fn attach(window: &gpui::Window, width: f64, height: f64, scale: f64) -> Result<Self, String> {
        RemoteLayerHandle::attach(window, width, height, scale).map(Self)
    }

    pub fn context_id(&self) -> u32 {
        self.0.context_id()
    }

    pub fn resize(&self, width: f64, height: f64, scale: f64) {
        self.0.resize(width, height, scale);
    }

    /// Schedules `[ns_view displayLayer: layer]` asynchronously on `_dispatch_main_q`.
    /// Must only be called outside GPUI `cx.update` / `window.update` closures.
    pub fn schedule_display(&self) {
        self.0.schedule_display();
    }

    pub fn teardown(&mut self) {
        self.0.teardown();
    }
}
