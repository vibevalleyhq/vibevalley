//! Paints a [`DrawList`] with GPUI. GPUI samples images linearly, so every
//! picture is resampled nearest-neighbour on the CPU to exactly the device
//! pixels it covers (whole art pixels × whole scale × the screen's scale)
//! and drawn 1:1; pixels stay sharp. Resampled pictures are cached per
//! (name, flip, alpha step, device size) and dropped when the scale changes.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::Arc;

use gpui_kit::{
    App, Bounds, Corners, Font, FontFeatures, FontStyle, FontWeight, Hsla, Pixels, RenderImage, Rgba, SharedString, TextAlign, TextRun, Window, fill, outline,
    point, px, size,
};
use image::RgbaImage;
use smallvec::SmallVec;

use super::atlas::Atlas;
use super::draw::{Color, DrawList, HudOp, Op, glow_image, resample};
use super::sky::{FARM_CUT, Framing, frame_whole};

pub const PIXEL_FONT: &str = "Fusion Pixel 12px Prop zh-Hans";

/// Registers VibeValley's pixel font once; false when it is not there.
pub fn load_font(cx: &mut App) -> bool {
    let path = super::assets_dir().join("fonts/fusion-pixel-12px-proportional-zh_hans.otf");
    match std::fs::read(&path) {
        Ok(bytes) => cx.text_system().add_fonts(vec![Cow::Owned(bytes)]).is_ok(),
        Err(_) => false,
    }
}

fn hsla(c: Color) -> Hsla {
    Rgba {
        r: c[0],
        g: c[1],
        b: c[2],
        a: c[3],
    }
    .into()
}

#[derive(Hash, PartialEq, Eq, Clone)]
struct Key {
    name: String,
    flip: bool,
    alpha: u8,
    w: u32,
    h: u32,
}

#[derive(Default)]
pub struct SpriteCache {
    images: HashMap<Key, Arc<RenderImage>>,
    /// Pictures made per frame (Op::Image): dropped once a paint does not use them.
    dynamic: HashMap<Key, bool>,
    device_scale: f32,
    /// Pictures made this frame, for the dump.
    pub made: usize,
    pub last_paint_ms: f32,
}

fn bgra(mut img: RgbaImage) -> Arc<RenderImage> {
    for p in img.pixels_mut() {
        p.0.swap(0, 2);
    }
    Arc::new(RenderImage::new(SmallVec::from_elem(image::Frame::new(img), 1)))
}

impl SpriteCache {
    fn get(&mut self, key: Key, make: impl FnOnce() -> Option<RgbaImage>) -> Option<Arc<RenderImage>> {
        if let Some(found) = self.images.get(&key) {
            return Some(found.clone());
        }
        let img = make()?;
        self.made += 1;
        let render = bgra(img);
        self.images.insert(key, render.clone());
        Some(render)
    }

    fn reset(&mut self, device_scale: f32, window: &mut Window) {
        if self.device_scale != device_scale {
            for (_, img) in self.images.drain() {
                let _ = window.drop_image(img);
            }
            self.dynamic.clear();
            self.device_scale = device_scale;
        }
    }

    pub fn len(&self) -> usize {
        self.images.len()
    }
}

/// How `list` sits in `bounds`: the farm's whole-pixel framing.
pub fn framing(list: &DrawList, bounds: Bounds<Pixels>) -> Framing {
    let view = (f32::from(bounds.size.width), f32::from(bounds.size.height));
    if !list.fit {
        return frame_whole(view, (list.width, list.height), FARM_CUT);
    }
    let fits = (view.0 / list.width).min(view.1 / list.height);
    let scale = if fits >= 1.0 { (fits * 2.0).floor() / 2.0 } else { fits.max(0.1) };
    let (w, h) = (list.width * scale, list.height * scale);
    let bx = super::sky::Rect {
        x: ((view.0 - w) / 2.0).round(),
        y: ((view.1 - h) / 2.0).round(),
        w,
        h,
    };
    Framing { scale, bx, shown: bx }
}

/// Paints the list into `bounds` framed by `f`.
pub fn paint(list: &DrawList, atlas: Option<&Atlas>, f: Framing, bounds: Bounds<Pixels>, cache: &mut SpriteCache, window: &mut Window, cx: &mut App) {
    let started = std::time::Instant::now();
    cache.made = 0;
    let s = f.scale;
    let device = s * window.scale_factor();
    cache.reset(device, window);
    window.paint_quad(fill(
        bounds,
        hsla([list.background[0] * 0.7, list.background[1] * 0.7, list.background[2] * 0.7, 1.0]),
    ));
    let origin = bounds.origin + point(px(f.bx.x), px(f.bx.y));
    let at = |x: f32, y: f32| origin + point(px(x * s), px(y * s));
    let dev = |v: f32| (v * device).round().max(1.0) as u32;
    window.with_content_mask(Some(gpui_kit::ContentMask { bounds }), |window| {
        let pic = Bounds::new(at(0.0, 0.0), size(px(list.width * s), px(list.height * s)));
        window.paint_quad(fill(pic, hsla(list.background)));
        for op in &list.ops {
            match op {
                Op::Sprite { name, x, y, flip, alpha } => {
                    let Some(atlas) = atlas else { continue };
                    let Some(info) = atlas.get(name) else { continue };
                    let a = (alpha.clamp(0.0, 1.0) * 8.0).round() as u8;
                    if a == 0 {
                        continue;
                    }
                    let (w, h) = (dev(info.w), dev(info.h));
                    let key = Key {
                        name: name.clone(),
                        flip: *flip,
                        alpha: a,
                        w,
                        h,
                    };
                    let img = cache.get(key, || atlas.image(name).map(|src| resample(&src, w, h, *flip, a as f32 / 8.0)));
                    if let Some(img) = img {
                        let b = Bounds::new(at(*x, *y), size(px(w as f32 / window.scale_factor()), px(h as f32 / window.scale_factor())));
                        let _ = window.paint_image(b, b, Corners::default(), img, 0, false);
                    }
                }
                Op::Image { key, image, x, y, w, h, alpha } => {
                    let a = (alpha.clamp(0.0, 1.0) * 8.0).round() as u8;
                    if a == 0 {
                        continue;
                    }
                    let (dw, dh) = (dev(*w), dev(*h));
                    let k = Key {
                        name: key.clone(),
                        flip: false,
                        alpha: a,
                        w: dw,
                        h: dh,
                    };
                    cache.dynamic.insert(k.clone(), true);
                    let img = cache.get(k, || Some(resample(image, dw, dh, false, a as f32 / 8.0)));
                    if let Some(img) = img {
                        let b = Bounds::new(at(*x, *y), size(px(dw as f32 / window.scale_factor()), px(dh as f32 / window.scale_factor())));
                        let _ = window.paint_image(b, b, Corners::default(), img, 0, false);
                    }
                }
                Op::Rect { x, y, w, h, color } => {
                    window.paint_quad(fill(Bounds::new(at(*x, *y), size(px(w * s), px(h * s))), hsla(*color)));
                }
                Op::Glow { x, y, r, color } => {
                    let step = (color[3].clamp(0.0, 1.0) * 16.0).round() as u8;
                    if step == 0 {
                        continue;
                    }
                    let d = dev(r * 2.0);
                    let name = format!("glow:{:.3}:{:.3}:{:.3}", color[0], color[1], color[2]);
                    let k = Key {
                        name,
                        flip: false,
                        alpha: step,
                        w: d,
                        h: d,
                    };
                    let c = [color[0], color[1], color[2], step as f32 / 16.0];
                    if let Some(img) = cache.get(k, || Some(glow_image(d, c))) {
                        let b = Bounds::new(
                            at(x - r, y - r),
                            size(px(d as f32 / window.scale_factor()), px(d as f32 / window.scale_factor())),
                        );
                        let _ = window.paint_image(b, b, Corners::default(), img, 0, false);
                    }
                }
            }
        }
        let hud_origin = if list.hud_center {
            bounds.origin + point(bounds.size.width / 2.0, bounds.size.height)
        } else {
            origin
        };
        for (key, image, x, y, w, h) in &list.hud_images {
            let (dw, dh) = ((w * window.scale_factor()).round() as u32, (h * window.scale_factor()).round() as u32);
            let k = Key {
                name: key.clone(),
                flip: false,
                alpha: 8,
                w: dw,
                h: dh,
            };
            cache.dynamic.insert(k.clone(), true);
            if let Some(img) = cache.get(k, || Some(resample(image, dw, dh, false, 1.0))) {
                let b = Bounds::new(hud_origin + point(px(*x), px(*y)), size(px(*w), px(*h)));
                let _ = window.paint_image(b, b, Corners::default(), img, 0, false);
            }
        }
        let labels = super::farm::islands::label_ops(list, s);
        for op in list.hud.iter().chain(labels.iter()) {
            match op {
                HudOp::Rect { x, y, w, h, color, border } => {
                    let b = Bounds::new(hud_origin + point(px(*x), px(*y)), size(px(*w), px(*h)));
                    window.paint_quad(fill(b, hsla(*color)));
                    if let Some(border) = border {
                        window.paint_quad(outline(b, hsla(*border), gpui_kit::BorderStyle::Solid));
                    }
                }
                HudOp::Text {
                    x,
                    y,
                    text,
                    size: font_size,
                    color,
                } => {
                    let font = Font {
                        family: PIXEL_FONT.into(),
                        features: FontFeatures::default(),
                        fallbacks: None,
                        weight: FontWeight::NORMAL,
                        style: FontStyle::Normal,
                    };
                    let run = TextRun {
                        len: text.len(),
                        font,
                        color: hsla(*color),
                        background_color: None,
                        underline: None,
                        strikethrough: None,
                    };
                    let line = window.text_system().shape_line(SharedString::from(text.clone()), px(*font_size), &[run], None);
                    let _ = line.paint(hud_origin + point(px(*x), px(*y)), px(font_size * 1.25), TextAlign::Left, None, window, cx);
                }
            }
        }
    });
    let stale: Vec<Key> = cache.dynamic.iter().filter(|(_, used)| !**used).map(|(k, _)| k.clone()).collect();
    for k in stale {
        cache.dynamic.remove(&k);
        if let Some(img) = cache.images.remove(&k) {
            let _ = window.drop_image(img);
        }
    }
    for used in cache.dynamic.values_mut() {
        *used = false;
    }
    cache.last_paint_ms = started.elapsed().as_secs_f32() * 1000.0;
}
