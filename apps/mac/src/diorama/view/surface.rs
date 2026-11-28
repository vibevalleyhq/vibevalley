use gpui::{Bounds, DevicePixels, Pixels, Window, point, size};

/// Uploads the off-thread wgpu BGRA8 framebuffer into a persistent GPUI dynamic texture.
#[derive(Default)]
pub(super) struct FrameSurface {
    texture: Option<gpui::DynamicTexture>,
    dims: (u32, u32),
    uploaded_gen: u64,
}

impl Drop for FrameSurface {
    fn drop(&mut self) {
        if let Some(texture) = self.texture {
            texture.remove();
        }
    }
}

impl FrameSurface {
    pub(super) fn paint_bgra_frame(&mut self, bgra: &[u8], w: u32, h: u32, frame_gen: u64, bounds: Bounds<Pixels>, window: &mut Window) -> bool {
        if w == 0 || h == 0 || bgra.len() < (w as usize) * (h as usize) * 4 {
            return false;
        }
        if self.dims == (w, h)
            && self.uploaded_gen == frame_gen
            && frame_gen != 0
            && let Some(texture) = self.texture
        {
            return window.paint_dynamic_texture(bounds, texture).is_ok();
        }
        let sz = size(DevicePixels(w as i32), DevicePixels(h as i32));
        if self.dims != (w, h) {
            if let Some(texture) = self.texture.take() {
                window.remove_dynamic_texture(texture);
            }
            self.dims = (w, h);
        }
        let byte_len = (w as usize) * (h as usize) * 4;
        let pixels = &bgra[..byte_len];
        let texture = if let Some(texture) = self.texture {
            if window
                .update_dynamic_texture(texture, Bounds::new(point(DevicePixels(0), DevicePixels(0)), sz), pixels, w * 4)
                .is_err()
            {
                return false;
            }
            texture
        } else {
            let Ok(texture) = window.create_dynamic_texture(sz, pixels, w * 4) else {
                return false;
            };
            self.texture = Some(texture);
            texture
        };
        self.uploaded_gen = frame_gen;
        window.paint_dynamic_texture(bounds, texture).is_ok()
    }
}
