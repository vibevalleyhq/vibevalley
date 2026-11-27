//! Silent, host-side `WKWebView` cover capture for macOS visual notes.
//!
//! Captures the active visible `WKWebView` directly through WebKit's native
//! `takeSnapshotWithConfiguration:completionHandler:` API, completely outside
//! JS origin/CSP boundaries and without requiring Screen Recording permission.

use std::ffi::{CStr, c_char, c_void};
use std::time::Duration;

use base64::Engine as _;
use futures_util::future::{Either, select};
use image::ImageEncoder as _;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType as PngFilterType, PngEncoder};
use image::imageops::{self, FilterType};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use vibevalley_protocol::HostCapturedImage;

pub const DEFAULT_COVER_WIDTH: u32 = 640;
pub const DEFAULT_COVER_HEIGHT: u32 = 400;

const MIN_COVER_DIM: u32 = 64;
const MAX_COVER_WIDTH: u32 = 1280;
const MAX_COVER_HEIGHT: u32 = 800;
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PNG_BYTES: usize = 300 * 1024;
const JPEG_FALLBACK_QUALITY: u8 = 85;

#[derive(Debug)]
pub struct RawRgba {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

type SnapshotCb = extern "C" fn(ctx: *mut c_void, rgba: *const u8, width: u32, height: u32, error: *const c_char);

unsafe extern "C" {
    fn vv_capture_webview_snapshot(parent_ns_view: *mut c_void, target_width: f64, target_height: f64, callback: SnapshotCb, ctx: *mut c_void);
}

extern "C" fn on_webview_snapshot(ctx: *mut c_void, rgba: *const u8, width: u32, height: u32, error: *const c_char) {
    // SAFETY: `ctx` was allocated with `Box::into_raw` in `start_webview_capture` and
    // WebKit / `vv_capture_webview_snapshot` invokes this callback exactly once.
    let tx = unsafe { Box::from_raw(ctx.cast::<flume::Sender<Result<RawRgba, String>>>()) };
    let result = if !error.is_null() {
        // SAFETY: `vv_capture_webview_snapshot` passes a valid NUL-terminated UTF-8 string.
        let msg = unsafe { CStr::from_ptr(error) }.to_string_lossy().into_owned();
        Err(msg)
    } else if rgba.is_null() || width == 0 || height == 0 {
        Err("empty webview snapshot".into())
    } else {
        match (width as usize).checked_mul(height as usize).and_then(|n| n.checked_mul(4)) {
            Some(len) => {
                // SAFETY: Objective-C buffer is valid for `width * height * 4` bytes for the duration of this callback.
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

pub fn normalize_dimensions(width: Option<u32>, height: Option<u32>) -> (u32, u32) {
    let w = width.unwrap_or(DEFAULT_COVER_WIDTH).clamp(MIN_COVER_DIM, MAX_COVER_WIDTH);
    let h = height.unwrap_or(DEFAULT_COVER_HEIGHT).clamp(MIN_COVER_DIM, MAX_COVER_HEIGHT);
    (w, h)
}

/// Computes a cover crop rectangle anchored to the top edge (preserving headers/heroes)
/// when the source is taller than the target aspect, or centered horizontally when wider.
pub fn top_cover_crop_rect(src_w: u32, src_h: u32, dst_w: u32, dst_h: u32) -> (u32, u32, u32, u32) {
    let lhs = u64::from(src_w) * u64::from(dst_h);
    let rhs = u64::from(dst_w) * u64::from(src_h);
    if lhs > rhs {
        let crop_w = ((u64::from(src_h) * u64::from(dst_w)) / u64::from(dst_h)).clamp(1, u64::from(src_w)) as u32;
        let x = (src_w - crop_w) / 2;
        (x, 0, crop_w, src_h)
    } else {
        let crop_h = ((u64::from(src_w) * u64::from(dst_h)) / u64::from(dst_w)).clamp(1, u64::from(src_h)) as u32;
        (0, 0, src_w, crop_h)
    }
}

/// Converts premultiplied sRGB RGBA8888 (from CoreGraphics `kCGImageAlphaPremultipliedLast`)
/// to straight RGBA8888 in place.
pub fn unpremultiply_rgba(rgba: &mut [u8]) {
    for px in rgba.as_chunks_mut::<4>().0 {
        let a = u16::from(px[3]);
        if a == 0 || a == 255 {
            continue;
        }
        let half = a / 2;
        px[0] = ((u16::from(px[0]) * 255 + half) / a).min(255) as u8;
        px[1] = ((u16::from(px[1]) * 255 + half) / a).min(255) as u8;
        px[2] = ((u16::from(px[2]) * 255 + half) / a).min(255) as u8;
    }
}

/// Crops, resizes, and encodes a raw premultiplied RGBA snapshot to a compact cover payload.
/// Uses PNG for sharp UI edges and falls back to JPEG when PNG exceeds `MAX_PNG_BYTES`.
pub fn encode_cover(mut raw: RawRgba, dst_w: u32, dst_h: u32) -> Result<HostCapturedImage, String> {
    let expected_len = (raw.width as usize)
        .checked_mul(raw.height as usize)
        .and_then(|n| n.checked_mul(4))
        .ok_or_else(|| "snapshot dimensions overflow".to_string())?;
    if raw.width == 0 || raw.height == 0 || raw.rgba.len() != expected_len {
        return Err("invalid raw RGBA snapshot buffer".into());
    }

    unpremultiply_rgba(&mut raw.rgba);
    let source = image::RgbaImage::from_raw(raw.width, raw.height, raw.rgba).ok_or_else(|| "failed to construct RGBA image".to_string())?;
    let (x, y, crop_w, crop_h) = top_cover_crop_rect(raw.width, raw.height, dst_w, dst_h);
    let cropped = imageops::crop_imm(&source, x, y, crop_w, crop_h).to_image();
    let resized = if cropped.width() == dst_w && cropped.height() == dst_h {
        cropped
    } else {
        imageops::resize(&cropped, dst_w, dst_h, FilterType::CatmullRom)
    };

    let mut png = Vec::new();
    PngEncoder::new_with_quality(&mut png, CompressionType::Fast, PngFilterType::Adaptive)
        .write_image(resized.as_raw(), dst_w, dst_h, image::ExtendedColorType::Rgba8)
        .map_err(|e| format!("PNG encode failed: {e}"))?;

    let (mime, bytes) = if png.len() <= MAX_PNG_BYTES {
        ("image/png", png)
    } else {
        let mut rgb = Vec::with_capacity((dst_w as usize) * (dst_h as usize) * 3);
        for px in resized.as_raw().as_chunks::<4>().0 {
            let a = u16::from(px[3]);
            let inv = 255 - a;
            rgb.push(((u16::from(px[0]) * a + 255 * inv + 127) / 255) as u8);
            rgb.push(((u16::from(px[1]) * a + 255 * inv + 127) / 255) as u8);
            rgb.push(((u16::from(px[2]) * a + 255 * inv + 127) / 255) as u8);
        }
        let mut jpg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpg, JPEG_FALLBACK_QUALITY)
            .write_image(&rgb, dst_w, dst_h, image::ExtendedColorType::Rgb8)
            .map_err(|e| format!("JPEG encode failed: {e}"))?;
        if jpg.len() < png.len() { ("image/jpeg", jpg) } else { ("image/png", png) }
    };

    Ok(HostCapturedImage {
        mime: mime.to_string(),
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
        width: dst_w,
        height: dst_h,
    })
}

struct PendingCapture {
    rx: flume::Receiver<Result<RawRgba, String>>,
    dst_w: u32,
    dst_h: u32,
}

fn start_webview_capture(window: &gpui::Window, width: Option<u32>, height: Option<u32>) -> Result<PendingCapture, String> {
    let (dst_w, dst_h) = normalize_dimensions(width, height);
    let handle = HasWindowHandle::window_handle(window).map_err(|e| format!("window handle unavailable: {e}"))?;
    let ns_view = match handle.as_raw() {
        RawWindowHandle::AppKit(appkit) => appkit.ns_view.as_ptr(),
        _ => return Err("webview capture is only supported on AppKit windows".into()),
    };

    let (tx, rx) = flume::bounded::<Result<RawRgba, String>>(1);
    let ctx = Box::into_raw(Box::new(tx)).cast::<c_void>();
    // SAFETY: `ns_view` is a live `NSView *` owned by GPUI's window on the main thread,
    // and `on_webview_snapshot` reclaims `ctx` exactly once.
    unsafe {
        vv_capture_webview_snapshot(ns_view, f64::from(dst_w), f64::from(dst_h), on_webview_snapshot, ctx);
    }
    Ok(PendingCapture { rx, dst_w, dst_h })
}

/// Asynchronously captures the active visible `WKWebView` in `window` and resolves
/// the returned oneshot with the encoded cover image (or an error reason).
pub fn capture_webview_cover(
    window: &gpui::Window,
    width: Option<u32>,
    height: Option<u32>,
    cx: &mut gpui::App,
) -> tokio::sync::oneshot::Receiver<Result<HostCapturedImage, String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let PendingCapture { rx: snap_rx, dst_w, dst_h } = match start_webview_capture(window, width, height) {
        Ok(started) => started,
        Err(reason) => {
            let _ = tx.send(Err(reason));
            return rx;
        }
    };

    cx.spawn(async move |cx| {
        let timer = cx.background_executor().timer(SNAPSHOT_TIMEOUT);
        let raw = match select(Box::pin(snap_rx.recv_async()), Box::pin(timer)).await {
            Either::Left((Ok(Ok(raw)), _)) => raw,
            Either::Left((Ok(Err(reason)), _)) => {
                let _ = tx.send(Err(reason));
                return;
            }
            Either::Left((Err(_), _)) => {
                let _ = tx.send(Err("webview capture channel closed".into()));
                return;
            }
            Either::Right((_, _)) => {
                let _ = tx.send(Err("webview capture timed out".into()));
                return;
            }
        };

        let encoded = cx.background_executor().spawn(async move { encode_cover(raw, dst_w, dst_h) }).await;
        let _ = tx.send(encoded);
    })
    .detach();

    rx
}

/// Asynchronously captures the active visible `WKWebView` in `window` and sends
/// `Envelope::ok(HostCapturedImage)` (or `Envelope::ok(null)` on graceful no-op).
pub fn capture_webview_for_reply(
    window: &gpui::Window,
    width: Option<u32>,
    height: Option<u32>,
    reply: crate::hosted::Replier,
    cx: &mut gpui::Context<crate::shell::Shell>,
) {
    use serde_json::Value;
    use vibevalley_server::gateway::bridge::Envelope;

    let PendingCapture { rx, dst_w, dst_h } = match start_webview_capture(window, width, height) {
        Ok(started) => started,
        Err(reason) => {
            tracing::debug!(target: "vibevalley::capture", %reason, "skipping webview capture");
            reply.send(Envelope::ok(Value::Null));
            return;
        }
    };

    cx.spawn(async move |_, cx| {
        let timer = cx.background_executor().timer(SNAPSHOT_TIMEOUT);
        let raw = match select(Box::pin(rx.recv_async()), Box::pin(timer)).await {
            Either::Left((Ok(Ok(raw)), _)) => raw,
            Either::Left((Ok(Err(reason)), _)) => {
                tracing::debug!(target: "vibevalley::capture", %reason, "webview capture skipped");
                reply.send(Envelope::ok(Value::Null));
                return;
            }
            Either::Left((Err(_), _)) => {
                tracing::debug!(target: "vibevalley::capture", "webview capture channel closed");
                reply.send(Envelope::ok(Value::Null));
                return;
            }
            Either::Right((_, _)) => {
                tracing::debug!(target: "vibevalley::capture", "webview capture timed out");
                reply.send(Envelope::ok(Value::Null));
                return;
            }
        };

        let encoded = cx.background_executor().spawn(async move { encode_cover(raw, dst_w, dst_h) }).await;
        match encoded {
            Ok(cover) => reply.send(Envelope::ok(serde_json::json!(cover))),
            Err(reason) => {
                tracing::debug!(target: "vibevalley::capture", %reason, "webview cover encode failed");
                reply.send(Envelope::ok(Value::Null));
            }
        }
    })
    .detach();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_dimensions_applies_defaults_and_clamps() {
        assert_eq!(normalize_dimensions(None, None), (640, 400));
        assert_eq!(normalize_dimensions(Some(10), Some(10)), (64, 64));
        assert_eq!(normalize_dimensions(Some(4000), Some(3000)), (1280, 800));
        assert_eq!(normalize_dimensions(Some(800), Some(500)), (800, 500));
    }

    #[test]
    fn top_cover_crop_anchors_top_for_tall_and_centers_for_wide() {
        // Tall mobile viewport (390x800) cropped to 16:10 keeps top header (y = 0).
        assert_eq!(top_cover_crop_rect(390, 800, 640, 400), (0, 0, 390, 243));
        // Wide desktop viewport (1600x500) cropped to 16:10 centers horizontally.
        assert_eq!(top_cover_crop_rect(1600, 500, 640, 400), (400, 0, 800, 500));
        // Exact 16:10 needs no crop.
        assert_eq!(top_cover_crop_rect(1280, 800, 640, 400), (0, 0, 1280, 800));
    }

    #[test]
    fn unpremultiply_rgba_restores_straight_color() {
        // Straight (200, 100, 50) at alpha 128 -> premultiplied ~(100, 50, 25, 128).
        let mut buf = vec![100, 50, 25, 128, 10, 20, 30, 255, 0, 0, 0, 0];
        unpremultiply_rgba(&mut buf);
        assert_eq!(&buf[0..4], &[199, 100, 50, 128]);
        assert_eq!(&buf[4..8], &[10, 20, 30, 255]);
        assert_eq!(&buf[8..12], &[0, 0, 0, 0]);
    }

    #[test]
    fn encode_cover_produces_valid_png_with_top_aligned_crop() {
        // 400x500 image: top half red, bottom half blue.
        // Cropping to 640x400 (aspect 1.6 -> top 400x250) should stay purely red!
        let (w, h) = (400u32, 500u32);
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            let color = if y < 250 { [220, 40, 40, 255] } else { [40, 40, 220, 255] };
            for x in 0..w {
                let idx = ((y * w + x) * 4) as usize;
                rgba[idx..idx + 4].copy_from_slice(&color);
            }
        }

        let cover = encode_cover(RawRgba { rgba, width: w, height: h }, 320, 200).expect("encode cover");
        assert_eq!(cover.mime, "image/png");
        assert_eq!((cover.width, cover.height), (320, 200));

        let decoded_bytes = base64::engine::general_purpose::STANDARD.decode(&cover.data).expect("valid base64");
        let img = image::load_from_memory(&decoded_bytes).expect("valid PNG").to_rgba8();
        assert_eq!(img.dimensions(), (320, 200));
        let bottom_px = img.get_pixel(160, 199);
        assert!(bottom_px[0] > 200 && bottom_px[2] < 60, "expected top red half only, got {bottom_px:?}");
    }

    #[test]
    fn encode_cover_falls_back_to_jpeg_for_noisy_large_frames() {
        // High-entropy noise image at 640x400 produces PNG > 300 KiB, triggering JPEG fallback.
        let (w, h) = (640u32, 400u32);
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
        for px in rgba.as_chunks_mut::<4>().0 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            px[0] = (state & 0xff) as u8;
            px[1] = ((state >> 8) & 0xff) as u8;
            px[2] = ((state >> 16) & 0xff) as u8;
            px[3] = 255;
        }

        let cover = encode_cover(RawRgba { rgba, width: w, height: h }, w, h).expect("encode noisy cover");
        assert_eq!(cover.mime, "image/jpeg");
        assert_eq!((cover.width, cover.height), (640, 400));
        let decoded_bytes = base64::engine::general_purpose::STANDARD.decode(&cover.data).expect("valid base64");
        assert!(
            decoded_bytes.len() < 512 * 1024,
            "expected compact JPEG fallback, got {} bytes",
            decoded_bytes.len()
        );
        let img = image::load_from_memory(&decoded_bytes).expect("valid JPEG");
        assert_eq!((img.width(), img.height()), (640, 400));
    }

    #[test]
    fn encode_cover_rejects_mismatched_buffer() {
        let err = encode_cover(
            RawRgba {
                rgba: vec![0; 12],
                width: 10,
                height: 10,
            },
            64,
            64,
        )
        .expect_err("should reject mismatched buffer");
        assert!(err.contains("invalid"));
    }
}
