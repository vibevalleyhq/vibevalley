//! Paints a [`DrawList`] with GPUI. GPUI samples images linearly, so every
//! picture is resampled nearest-neighbour on the CPU to exactly the device
//! pixels it covers (whole art pixels × whole scale × the screen's scale)
//! and drawn 1:1; pixels stay sharp. Resampled pictures are cached per
//! (name, flip, alpha step, device size) and dropped when the scale changes.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::Arc;

use gpui::{
    App, Bounds, Corners, Font, FontFeatures, FontStyle, FontWeight, Hsla, Pixels, RenderImage, Rgba, ShapedLine, SharedString, TextAlign, TextRun, Window,
    fill, outline, point, px, size,
};
use image::RgbaImage;
use smallvec::SmallVec;

use super::atlas::Atlas;
use super::draw::{Color, DrawList, HudOp, Op, glow_image, resample, shade, shade_color};
use super::sky::{FARM_CUT, Framing, frame_whole};

pub const PIXEL_FONT: &str = "Fusion Pixel 12px Prop zh-Hans";

/// Registers VibeValley's pixel font once; false when it is not there.
pub fn load_font(cx: &mut App) -> bool {
    super::font::bytes().is_some_and(|bytes| cx.text_system().add_fonts(vec![Cow::Borrowed(bytes)]).is_ok())
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
enum KeyKind {
    Sprite { name: String, lit: bool },
    Image { key: String, lit: bool },
    Glow([u8; 3]),
    Hud(String),
}

#[derive(Hash, PartialEq, Eq, Clone)]
struct Key {
    kind: KeyKind,
    flip: bool,
    alpha: u8,
    w: u32,
    h: u32,
}

#[derive(Hash, PartialEq, Eq, Clone)]
struct TextKey {
    text: String,
    size_tenths: u16,
    color: [u32; 4],
    max_w_tenths: Option<u32>,
}

const TEXT_CACHE_CAP: usize = 512;

#[derive(Default)]
pub struct SpriteCache {
    images: HashMap<Key, Arc<RenderImage>>,
    text_cache: HashMap<TextKey, Arc<ShapedLine>>,
    farm_texture: Option<gpui::DynamicTexture>,
    farm_size: (u32, u32),
    /// Pictures made per frame (Op::Image): dropped once a paint does not use them.
    dynamic: HashMap<Key, bool>,
    device_scale: f32,
    /// The light the lit pictures were shaded with; they are remade when it changes.
    light: Option<[u8; 3]>,
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

impl Drop for SpriteCache {
    fn drop(&mut self) {
        if let Some(texture) = self.farm_texture {
            texture.remove();
        }
    }
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

    fn reset(&mut self, device_scale: f32, light: Option<[u8; 3]>, window: &mut Window) {
        if self.device_scale != device_scale {
            for (_, img) in self.images.drain() {
                let _ = window.drop_image(img);
            }
            self.dynamic.clear();
            self.text_cache.clear();
            self.device_scale = device_scale;
        }
        if self.light != light {
            let old: Vec<Key> = self
                .images
                .keys()
                .filter(|k| matches!(k.kind, KeyKind::Sprite { lit: true, .. } | KeyKind::Image { lit: true, .. }))
                .cloned()
                .collect();
            for k in old {
                self.dynamic.remove(&k);
                if let Some(img) = self.images.remove(&k) {
                    let _ = window.drop_image(img);
                }
            }
            self.light = light;
        }
    }

    fn paint_farm(&mut self, picture: &RgbaImage, bounds: Bounds<Pixels>, window: &mut Window) -> bool {
        use gpui::DevicePixels;
        let w = (f32::from(bounds.size.width) * window.scale_factor()).round() as u32;
        let h = (f32::from(bounds.size.height) * window.scale_factor()).round() as u32;
        if w == 0 || h == 0 {
            return false;
        }
        let sz = size(DevicePixels(w as i32), DevicePixels(h as i32));
        if self.farm_size != (w, h) {
            if let Some(texture) = self.farm_texture.take() {
                window.remove_dynamic_texture(texture);
            }
            self.farm_size = (w, h);
        }
        let bgra = vibevalley_pixel::nearest(picture, w, h, true);
        let texture = if let Some(texture) = self.farm_texture {
            if window
                .update_dynamic_texture(texture, Bounds::new(point(DevicePixels(0), DevicePixels(0)), sz), bgra.as_raw(), w * 4)
                .is_err()
            {
                return false;
            }
            texture
        } else {
            let Ok(texture) = window.create_dynamic_texture(sz, bgra.as_raw(), w * 4) else {
                return false;
            };
            self.farm_texture = Some(texture);
            texture
        };
        window.paint_dynamic_texture(bounds, texture).is_ok()
    }

    pub fn len(&self) -> usize {
        self.images.len()
    }
}

fn shape_hud_line(text: &str, font_size: f32, color: Color, window: &mut Window) -> ShapedLine {
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
        color: hsla(color),
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    window
        .text_system()
        .shape_line(SharedString::from(text.to_string()), px(font_size), &[run], None)
}

fn color_bits(color: Color) -> [u32; 4] {
    color.map(|c| if c == 0.0 { 0 } else { c.to_bits() })
}

fn cached_hud_line(cache: &mut SpriteCache, text: &str, font_size: f32, color: Color, max_w: Option<f32>, window: &mut Window) -> Arc<ShapedLine> {
    let key = TextKey {
        text: text.to_owned(),
        size_tenths: (font_size * 10.0).round().clamp(0.0, u16::MAX as f32) as u16,
        color: color_bits(color),
        max_w_tenths: max_w.map(|w| (w * 10.0).round().max(0.0) as u32),
    };
    if let Some(hit) = cache.text_cache.get(&key) {
        return Arc::clone(hit);
    }
    let line = if let Some(max_w) = max_w {
        let mut shaped = shape_hud_line(text, font_size, color, window);
        if f32::from(shaped.width) > max_w {
            let ends: Vec<usize> = text.char_indices().map(|(i, _)| i).collect();
            let (mut lo, mut hi) = (0, ends.len());
            while lo < hi {
                let mid = (lo + hi) / 2;
                let candidate = shape_hud_line(&format!("{}…", &text[..ends[mid]]), font_size, color, window);
                if f32::from(candidate.width) <= max_w {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
            let end = if lo == 0 { 0 } else { ends[lo - 1] };
            shaped = shape_hud_line(&format!("{}…", &text[..end]), font_size, color, window);
        }
        Arc::new(shaped)
    } else {
        Arc::new(shape_hud_line(text, font_size, color, window))
    };
    if cache.text_cache.len() >= TEXT_CACHE_CAP {
        cache.text_cache.clear();
    }
    cache.text_cache.insert(key, Arc::clone(&line));
    line
}

fn paint_hud_picture(
    cache: &mut SpriteCache,
    hud_origin: gpui::Point<Pixels>,
    key: &str,
    raster: &dyn Fn(u32, u32) -> RgbaImage,
    [x, y, w, h]: [f32; 4],
    window: &mut Window,
) {
    let (dw, dh) = ((w * window.scale_factor()).round() as u32, (h * window.scale_factor()).round() as u32);
    let k = Key {
        kind: KeyKind::Hud(key.to_owned()),
        flip: false,
        alpha: 8,
        w: dw,
        h: dh,
    };
    cache.dynamic.insert(k.clone(), true);
    if let Some(img) = cache.get(k, || Some(raster(dw, dh))) {
        let b = Bounds::new(hud_origin + point(px(x), px(y)), size(px(w), px(h)));
        let _ = window.paint_image(b, b, Corners::default(), img, 0, false);
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
    cache.reset(device, list.light.map(|l| l.map(|c| (c.clamp(0.0, 1.0) * 255.0).round() as u8)), window);
    let background = shade_color(list.background, list.light);
    window.paint_quad(fill(bounds, hsla([background[0] * 0.7, background[1] * 0.7, background[2] * 0.7, 1.0])));
    let origin = bounds.origin + point(px(f.bx.x), px(f.bx.y));
    let at = |x: f32, y: f32| origin + point(px(x * s), px(y * s));
    let dev = |v: f32| (v * device).round().max(1.0) as u32;
    window.with_content_mask(Some(gpui::ContentMask { bounds }), |window| {
        let pic = Bounds::new(at(0.0, 0.0), size(px(list.width * s), px(list.height * s)));
        if list.farm_light.is_some()
            && let Some(atlas) = atlas
            && let Some(map) = atlas.image("map")
        {
            window.paint_quad(fill(bounds, hsla(list.background)));
            let cover = (f32::from(bounds.size.width) / list.width).max(f32::from(bounds.size.height) / list.height);
            let (mw, mh) = (list.width * cover, list.height * cover);
            let (dw, dh) = (
                (mw * window.scale_factor()).round().max(1.) as u32,
                (mh * window.scale_factor()).round().max(1.) as u32,
            );
            let key = Key {
                kind: KeyKind::Hud("village-backdrop".into()),
                flip: false,
                alpha: 8,
                w: dw,
                h: dh,
            };
            cache.dynamic.insert(key.clone(), true);
            if let Some(image) = cache.get(key, || Some(vibevalley_pixel::nearest(&map, dw, dh, false))) {
                let back = Bounds::new(bounds.center() - point(px(mw / 2.), px(mh / 2.)), size(px(mw), px(mh)));
                let _ = window.paint_image(back, back, Corners::default(), image, 0, false);
            }
            let mut veil = list.background;
            veil[3] = 0.7;
            window.paint_quad(fill(bounds, hsla(veil)));
        }
        window.paint_quad(fill(pic, hsla(background)));
        let painted = if let (Some(light), Some(atlas)) = (&list.farm_light, atlas) {
            cache.paint_farm(&super::draw::farm_picture(list, atlas, light), pic, window)
        } else {
            false
        };
        for (index, op) in list.ops.iter().enumerate().filter(|_| !painted) {
            let light = list.light_on(index);
            let is_lit = light.is_some();
            let shaded = |mut img: RgbaImage| {
                if let Some(l) = light {
                    shade(&mut img, l);
                }
                img
            };
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
                        kind: KeyKind::Sprite {
                            name: name.clone(),
                            lit: is_lit,
                        },
                        flip: *flip,
                        alpha: a,
                        w,
                        h,
                    };
                    let img = cache.get(key, || atlas.image(name).map(|src| shaded(resample(&src, w, h, *flip, a as f32 / 8.0))));
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
                        kind: KeyKind::Image { key: key.clone(), lit: is_lit },
                        flip: false,
                        alpha: a,
                        w: dw,
                        h: dh,
                    };
                    cache.dynamic.insert(k.clone(), true);
                    let img = cache.get(k, || Some(shaded(resample(image, dw, dh, false, a as f32 / 8.0))));
                    if let Some(img) = img {
                        let b = Bounds::new(at(*x, *y), size(px(dw as f32 / window.scale_factor()), px(dh as f32 / window.scale_factor())));
                        let _ = window.paint_image(b, b, Corners::default(), img, 0, false);
                    }
                }
                Op::Rect { x, y, w, h, color } => {
                    window.paint_quad(fill(Bounds::new(at(*x, *y), size(px(w * s), px(h * s))), hsla(shade_color(*color, light))));
                }
                Op::Glow { x, y, r, color } => {
                    let step = (color[3].clamp(0.0, 1.0) * 16.0).round() as u8;
                    if step == 0 {
                        continue;
                    }
                    let d = dev(r * 2.0);
                    let qrgb = [
                        (color[0].clamp(0.0, 1.0) * 255.0).round() as u8,
                        (color[1].clamp(0.0, 1.0) * 255.0).round() as u8,
                        (color[2].clamp(0.0, 1.0) * 255.0).round() as u8,
                    ];
                    let k = Key {
                        kind: KeyKind::Glow(qrgb),
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
        } else if list.hud_view {
            bounds.origin
        } else {
            origin
        };
        for (key, image, x, y, w, h) in &list.hud_images {
            paint_hud_picture(
                cache,
                hud_origin,
                key,
                &|w, h| vibevalley_pixel::css_pixelated(image, w, h),
                [*x, *y, *w, *h],
                window,
            );
        }
        let mut pre_shaped: Vec<Option<Arc<ShapedLine>>> = Vec::new();
        let labels = super::farm::islands::label_ops(list, s);
        for op in list.hud.iter().chain(labels.iter()) {
            let shaped = match op {
                HudOp::Text { text, size, color, .. } => Some(cached_hud_line(cache, text, *size, *color, None, window)),
                HudOp::TextIn { text, size, color, w, .. } => Some(cached_hud_line(cache, text, *size, *color, Some(*w), window)),
                _ => None,
            };
            pre_shaped.push(shaped);
        }
        let mut clip: Option<Bounds<Pixels>> = None;
        for (op, shaped) in list.hud.iter().chain(labels.iter()).zip(pre_shaped.iter()) {
            if let HudOp::Clip(c) = op {
                clip = c.map(|[x, y, w, h]| Bounds::new(hud_origin + point(px(x), px(y)), size(px(w), px(h))).intersect(&bounds));
                continue;
            }
            let mask = gpui::ContentMask {
                bounds: clip.unwrap_or(bounds),
            };
            window.with_content_mask(Some(mask), |window| match op {
                HudOp::Rect { x, y, w, h, color, border } => {
                    let b = Bounds::new(hud_origin + point(px(*x), px(*y)), size(px(*w), px(*h)));
                    window.paint_quad(fill(b, hsla(*color)));
                    if let Some(border) = border {
                        window.paint_quad(outline(b, hsla(*border), gpui::BorderStyle::Solid));
                    }
                }
                HudOp::Text { x, y, size: font_size, .. } => {
                    if let Some(line) = shaped {
                        let _ = line.paint(hud_origin + point(px(*x), px(*y)), px(font_size * 1.25), TextAlign::Left, None, window, cx);
                    }
                }
                HudOp::TextIn { x, y, w, size: font_size, .. } => {
                    if let Some(line) = shaped {
                        let at = hud_origin + point(px(*x), px(*y));
                        let text_bounds = Bounds::new(at, size(px(w.max(0.0)), px(font_size * 1.25))).intersect(&mask.bounds);
                        window.with_content_mask(Some(gpui::ContentMask { bounds: text_bounds }), |window| {
                            let _ = line.paint(at, px(font_size * 1.25), TextAlign::Left, None, window, cx);
                        });
                    }
                }
                HudOp::Image { key, image, x, y, w, h } => paint_hud_picture(
                    cache,
                    hud_origin,
                    key,
                    &|w, h| vibevalley_pixel::css_pixelated(image, w, h),
                    [*x, *y, *w, *h],
                    window,
                ),
                HudOp::Bitmap { key, render, x, y, w, h } => paint_hud_picture(cache, hud_origin, key, render.as_ref(), [*x, *y, *w, *h], window),
                HudOp::Clip(_) => {}
            });
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
