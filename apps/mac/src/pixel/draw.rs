//! What a pixel scene draws, as data: sprites, images, rects and glows in art
//! pixels, plus text and boxes over it in view pixels. The GPUI element
//! paints a [`DrawList`]; [`raster`] paints the same list on the CPU, so a
//! scene can be checked as a PNG without a screen.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use image::{Rgba, RgbaImage};

use super::atlas::Atlas;

pub type Color = [f32; 4];

pub const fn rgba(hex: u32, a: f32) -> Color {
    [
        ((hex >> 16) & 0xff) as f32 / 255.0,
        ((hex >> 8) & 0xff) as f32 / 255.0,
        (hex & 0xff) as f32 / 255.0,
        a,
    ]
}

#[derive(Clone)]
pub enum Op {
    /// An atlas sprite, its top left at (`x`, `y`) art pixels.
    Sprite {
        name: String,
        x: f32,
        y: f32,
        flip: bool,
        alpha: f32,
    },
    /// Any picture (a title layer…) stretched over the box, art pixels;
    /// `key` names it for caching.
    Image {
        key: String,
        image: Arc<RgbaImage>,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        alpha: f32,
    },
    Rect {
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        color: Color,
    },
    /// A soft round light: `color` at the centre fading out at `r`.
    Glow {
        x: f32,
        y: f32,
        r: f32,
        color: Color,
    },
}

/// Over the picture, in view pixels from the picture's view box's top left.
#[derive(Clone)]
pub enum HudOp {
    Bitmap {
        key: String,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        render: Arc<dyn Fn(u32, u32) -> RgbaImage + Send + Sync>,
    },
    Text {
        x: f32,
        y: f32,
        text: String,
        size: f32,
        color: Color,
    },
    Rect {
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        color: Color,
        border: Option<Color>,
    },
    /// One line placed in a box `w` wide by its measured width; cut with an
    /// ellipsis when it does not fit.
    TextIn {
        x: f32,
        y: f32,
        w: f32,
        text: String,
        size: f32,
        color: Color,
    },
    /// A picture among the boxes and text, in their order; `key` names it for caching.
    Image {
        key: String,
        image: Arc<RgbaImage>,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
    },
    /// What follows is cut to this box (x, y, w, h), until the next `Clip`.
    Clip(Option<[f32; 4]>),
}

#[derive(Clone)]
pub struct FarmLight {
    pub lighting: vibevalley_pixel::Lighting,
    pub foreground: std::ops::Range<usize>,
}

#[derive(Clone, Default)]
pub struct DrawList {
    /// Consecutive, depth-sorted yard sprite groups and their projected ground Y.
    pub occludable: Vec<(std::ops::Range<usize>, f32)>,
    /// Art pixels of the picture (the framing fits this).
    pub width: f32,
    pub height: f32,
    pub background: Color,
    /// Optional seamless paper grid `(step_art_px, color)` painted edge-to-edge across the pane.
    pub grid: Option<(f32, Color)>,
    pub ops: Vec<Op>,
    pub hud: Vec<HudOp>,
    /// Labels centred on art points, drawn as view text.
    pub hud_art: Vec<(f32, f32, String)>,
    /// Fit the whole picture in the view (half steps) instead of covering it whole-pixel.
    pub fit: bool,
    /// HUD positions count from the view's bottom centre instead of the picture's top left.
    pub hud_center: bool,
    /// Pictures in the HUD, view pixels: (key, picture, x, y, w, h).
    pub hud_images: Vec<(String, Arc<RgbaImage>, f32, f32, f32, f32)>,
    /// HUD positions count from the view's top left: a HUD laid out in the pane, not on the picture.
    pub hud_view: bool,
    /// The sky's light: the first `lit` ops are multiplied by it, the rest
    /// (what shines by itself) are drawn as painted. `None` is full light.
    pub farm_light: Option<FarmLight>,
    pub light: Option<[f32; 3]>,
    pub lit: usize,
}

impl DrawList {
    pub fn new(width: f32, height: f32, background: Color) -> DrawList {
        DrawList {
            occludable: Vec::new(),
            width,
            height,
            background,
            grid: None,
            ops: Vec::new(),
            hud: Vec::new(),
            hud_art: Vec::new(),
            fit: false,
            hud_center: false,
            hud_images: Vec::new(),
            hud_view: false,
            farm_light: None,
            light: None,
            lit: 0,
        }
    }

    /// The light on op `index`, when it is not full.
    pub fn light_on(&self, index: usize) -> Option<[f32; 3]> {
        self.light.filter(|_| index < self.lit)
    }

    pub fn sprite(&mut self, atlas: &Atlas, name: &str, feet_x: f32, feet_y: f32, flip: bool, alpha: f32) {
        if let Some((x, y)) = atlas.top_left(name, feet_x, feet_y, flip) {
            self.ops.push(Op::Sprite {
                name: name.to_string(),
                x,
                y,
                flip,
                alpha,
            });
        }
    }

    pub fn rect(&mut self, x: f32, y: f32, w: f32, h: f32, color: Color) {
        self.ops.push(Op::Rect { x, y, w, h, color });
    }

    /// How many ops of each kind: for the dump.
    pub fn census(&self) -> serde_json::Value {
        let mut sprites = 0;
        let mut images = 0;
        let mut rects = 0;
        let mut glows = 0;
        for op in &self.ops {
            match op {
                Op::Sprite { .. } => sprites += 1,
                Op::Image { .. } => images += 1,
                Op::Rect { .. } => rects += 1,
                Op::Glow { .. } => glows += 1,
            }
        }
        let texts: Vec<&str> = self
            .hud
            .iter()
            .filter_map(|h| match h {
                HudOp::Text { text, .. } | HudOp::TextIn { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .chain(self.hud_art.iter().map(|l| l.2.as_str()))
            .collect();
        serde_json::json!({ "sprites": sprites, "images": images, "rects": rects, "glows": glows, "texts": texts })
    }
}

/// Nearest-neighbour resample of `src` to `w`×`h`, mirrored when `flip`,
/// alpha times `alpha`. Straight RGBA in, straight RGBA out.
pub fn resample(src: &RgbaImage, w: u32, h: u32, flip: bool, alpha: f32) -> RgbaImage {
    let mut out = vibevalley_pixel::nearest(src, w.max(1), h.max(1), false);
    if flip {
        image::imageops::flip_horizontal_in_place(&mut out);
    }
    if alpha < 1.0 {
        for pixel in out.pixels_mut() {
            pixel.0[3] = (pixel.0[3] as f32 * alpha).round() as u8;
        }
    }
    out
}

/// Multiplies the colours by `light`, in place.
pub fn shade(img: &mut RgbaImage, light: [f32; 3]) {
    let k = light.map(|c| (c.clamp(0.0, 1.0) * 256.0) as u32);
    for p in img.pixels_mut() {
        for (c, k) in p.0.iter_mut().zip(k) {
            *c = ((*c as u32 * k) >> 8) as u8;
        }
    }
}

pub fn shade_color(c: Color, light: Option<[f32; 3]>) -> Color {
    match light {
        Some(l) => [c[0] * l[0], c[1] * l[1], c[2] * l[2], c[3]],
        None => c,
    }
}

/// A round glow's picture, `size`×`size`, straight RGBA.
pub fn glow_image(size: u32, color: Color) -> RgbaImage {
    let mut out = RgbaImage::new(size.max(1), size.max(1));
    let c = size as f32 / 2.0;
    for y in 0..out.height() {
        for x in 0..out.width() {
            let d = ((x as f32 + 0.5 - c).hypot(y as f32 + 0.5 - c) / c).min(1.0);
            let k = (1.0 - d) * (1.0 - d);
            out.put_pixel(x, y, to_rgba([color[0], color[1], color[2], color[3] * k]));
        }
    }
    out
}

const GLOW_CACHE_CAP: usize = 256;

/// Cached round glow quantized per RGBA channel byte so pulsing lights reuse generated bitmaps.
pub fn cached_glow_image(size: u32, color: Color) -> Arc<RgbaImage> {
    type GlowCache = OnceLock<Mutex<HashMap<(u32, [u8; 4]), Arc<RgbaImage>>>>;
    static CACHE: GlowCache = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let size = size.max(1);
    let q = color.map(|c| (c.clamp(0.0, 1.0) * 255.0).round() as u8);
    let key = (size, q);
    {
        let guard = cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(hit) = guard.get(&key) {
            return Arc::clone(hit);
        }
    }
    let quantized = q.map(|b| b as f32 / 255.0);
    let img = Arc::new(glow_image(size, quantized));
    let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
    if guard.len() >= GLOW_CACHE_CAP {
        guard.clear();
    }
    guard.insert(key, Arc::clone(&img));
    img
}

fn to_rgba(c: Color) -> Rgba<u8> {
    let b = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    Rgba([b(c[0]), b(c[1]), b(c[2]), b(c[3])])
}

fn blend(dst: &mut Rgba<u8>, src: Rgba<u8>) {
    let a = src.0[3] as f32 / 255.0;
    if a <= 0.0 {
        return;
    }
    for i in 0..3 {
        dst.0[i] = (src.0[i] as f32 * a + dst.0[i] as f32 * (1.0 - a)).round() as u8;
    }
    dst.0[3] = 255;
}

fn blit(target: &mut RgbaImage, img: &RgbaImage, x: i64, y: i64) {
    let (tw, th) = (target.width() as i64, target.height() as i64);
    for (ix, iy, p) in img.enumerate_pixels() {
        let (tx, ty) = (x + ix as i64, y + iy as i64);
        if tx >= 0 && ty >= 0 && tx < tw && ty < th {
            blend(target.get_pixel_mut(tx as u32, ty as u32), *p);
        }
    }
}

pub fn farm_picture(list: &DrawList, atlas: &Atlas, light: &FarmLight) -> RgbaImage {
    use vibevalley_pixel::{Brush, Surface};
    let mut surface = Surface::new(list.width as u32, list.height as u32, atlas.density as u32, to_rgba(list.background));
    let paint = |surface: &mut Surface, op: &Op, lit: bool, tint: [f32; 3], feet: Option<f32>| {
        let occlusion = feet.and_then(|y| atlas.landmarks.as_ref().map(|mask| (&mask.depth, y)));
        match op {
            Op::Sprite { name, x, y, flip, alpha } => {
                if let (Some(info), Some(image)) = (atlas.get(name), atlas.image(name)) {
                    let normal = lit.then(|| atlas.normals(name, &image));
                    surface.paint_with_depth(
                        &image,
                        normal.as_deref(),
                        Brush {
                            flip: *flip,
                            alpha: *alpha,
                            tint,
                            ..Brush::at(*x, *y, info.w, info.h)
                        },
                        occlusion,
                    );
                }
            }
            Op::Image { key, image, x, y, w, h, alpha } => {
                let normal = (lit && atlas.has(key)).then(|| atlas.normals(key, image));
                surface.paint_with_depth(
                    image,
                    normal.as_deref(),
                    Brush {
                        alpha: *alpha,
                        tint,
                        ..Brush::at(*x, *y, *w, *h)
                    },
                    occlusion,
                );
            }
            Op::Rect { x, y, w, h, color } => surface.paint(&RgbaImage::from_pixel(1, 1, to_rgba(*color)), None, Brush::at(*x, *y, *w, *h)),
            Op::Glow { x, y, r, color } => {
                let size = (r * 2.).round().max(1.) as u32;
                let glow = cached_glow_image(size, *color);
                surface.paint(
                    &glow,
                    None,
                    Brush {
                        additive: true,
                        ..Brush::at(x - r, y - r, r * 2., r * 2.)
                    },
                );
            }
        }
    };
    let mut groups = list.occludable.iter().peekable();
    for (index, op) in list.ops[..light.foreground.start].iter().enumerate() {
        while groups.peek().is_some_and(|(r, _)| r.end <= index) {
            groups.next();
        }
        let feet = groups.peek().and_then(|(r, y)| r.contains(&index).then_some(*y));
        paint(&mut surface, op, true, [1.; 3], feet);
    }
    surface.shade(&light.lighting);
    for op in &list.ops[light.foreground.end..] {
        paint(&mut surface, op, false, [1.; 3], None);
    }
    let tint = list.light.unwrap_or([1.; 3]).map(|c| (c * 0.82 * 255.).round().clamp(0., 255.) / 255.);
    for op in &list.ops[light.foreground.clone()] {
        paint(&mut surface, op, false, tint, None);
    }
    surface.finish()
}

fn paint_grid(target: &mut RgbaImage, step: f32, color: Color, light: Option<[f32; 3]>, k: f32, ox: f32, oy: f32) {
    if step <= 0.0 || k <= 0.0 {
        return;
    }
    let pitch = step * k;
    let line = to_rgba(shade_color(color, light));
    let thickness = k.round().max(1.0) as i64;
    let (tw, th) = (target.width() as i64, target.height() as i64);
    let kx0 = (-ox / pitch).ceil() as i32;
    let kx1 = ((tw as f32 - ox) / pitch).floor() as i32;
    for i in kx0..=kx1 {
        let x0 = (ox + i as f32 * pitch).round() as i64;
        for dx in 0..thickness {
            let x = x0 + dx;
            if x >= 0 && x < tw {
                for y in 0..th {
                    blend(target.get_pixel_mut(x as u32, y as u32), line);
                }
            }
        }
    }
    let ky0 = (-oy / pitch).ceil() as i32;
    let ky1 = ((th as f32 - oy) / pitch).floor() as i32;
    for j in ky0..=ky1 {
        let y0 = (oy + j as f32 * pitch).round() as i64;
        for dy in 0..thickness {
            let y = y0 + dy;
            if y >= 0 && y < th {
                for x in 0..tw {
                    blend(target.get_pixel_mut(x as u32, y as u32), line);
                }
            }
        }
    }
}

fn paint_ops(target: &mut RgbaImage, list: &DrawList, atlas: Option<&Atlas>, k: f32, ox: f32, oy: f32) {
    let px = |o: f32, v: f32| (o + v * k).round() as i64;
    for (index, op) in list.ops.iter().enumerate() {
        let light = list.light_on(index);
        match op {
            Op::Sprite { name, x, y, flip, alpha } => {
                let (Some(atlas), true) = (atlas, *alpha > 0.0) else { continue };
                let (Some(src), Some(info)) = (atlas.image(name), atlas.get(name)) else {
                    continue;
                };
                let mut img = resample(&src, (info.w * k).round() as u32, (info.h * k).round() as u32, *flip, *alpha);
                if let Some(l) = light {
                    shade(&mut img, l);
                }
                blit(target, &img, px(ox, *x), px(oy, *y));
            }
            Op::Image { image, x, y, w, h, alpha, .. } => {
                let mut img = resample(image, (w * k).round() as u32, (h * k).round() as u32, false, *alpha);
                if let Some(l) = light {
                    shade(&mut img, l);
                }
                blit(target, &img, px(ox, *x), px(oy, *y));
            }
            Op::Rect { x, y, w, h, color } => {
                let color = &shade_color(*color, light);
                let img = RgbaImage::from_pixel((w * k).round().max(1.0) as u32, (h * k).round().max(1.0) as u32, to_rgba(*color));
                blit(target, &img, px(ox, *x), px(oy, *y));
            }
            Op::Glow { x, y, r, color } => {
                let img = glow_image((r * 2.0 * k).round() as u32, *color);
                blit(target, &img, px(ox, x - r), px(oy, y - r));
            }
        }
    }
}

/// The list's art layer at `k` pixels per art pixel, on the CPU (no HUD
/// text; HUD boxes are drawn). For checking scenes without a screen.
pub fn raster(list: &DrawList, atlas: Option<&Atlas>, k: f32) -> RgbaImage {
    let (w, h) = ((list.width * k).round() as u32, (list.height * k).round() as u32);
    if let (Some(light), Some(atlas)) = (&list.farm_light, atlas) {
        return vibevalley_pixel::nearest(&farm_picture(list, atlas, light), w, h, false);
    }
    let mut target = RgbaImage::from_pixel(w.max(1), h.max(1), to_rgba([list.background[0], list.background[1], list.background[2], 1.0]));
    if let Some(l) = list.light {
        shade(&mut target, l);
    }
    if let Some((step, color)) = list.grid {
        paint_grid(&mut target, step, color, list.light, k, 0.0, 0.0);
    }
    paint_ops(&mut target, list, atlas, k, 0.0, 0.0);
    target
}

/// The list as a pane `view` pixels big shows it: the picture framed as the
/// painter frames it, then the HUD's boxes and pictures (no text). For
/// checking a HUD's layout without a screen.
#[cfg(test)]
pub fn raster_view(list: &DrawList, atlas: Option<&Atlas>, view: (f32, f32)) -> RgbaImage {
    let f = if list.fit {
        super::sky::fit_framing(view, (list.width, list.height))
    } else {
        super::sky::frame_cover(view, (list.width, list.height), super::sky::FARM_CUT)
    };
    let bg = shade_color(list.background, list.light);
    let mut target = RgbaImage::from_pixel(view.0.round().max(1.0) as u32, view.1.round().max(1.0) as u32, to_rgba(bg));
    if let (Some(light), Some(atlas)) = (&list.farm_light, atlas) {
        let art = vibevalley_pixel::nearest(
            &farm_picture(list, atlas, light),
            f.bx.w.round().max(1.0) as u32,
            f.bx.h.round().max(1.0) as u32,
            false,
        );
        blit(&mut target, &art, f.bx.x.round() as i64, f.bx.y.round() as i64);
    } else {
        if let Some((step, color)) = list.grid {
            paint_grid(&mut target, step, color, list.light, f.scale, f.bx.x, f.bx.y);
        }
        paint_ops(&mut target, list, atlas, f.scale, f.bx.x, f.bx.y);
    }
    let (ox, oy) = if list.hud_view { (0.0, 0.0) } else { (f.bx.x, f.bx.y) };
    let mut clip: Option<[f32; 4]> = None;
    let put = |target: &mut RgbaImage, img: &RgbaImage, x: f32, y: f32, clip: Option<[f32; 4]>| {
        let (x, y) = ((ox + x).round() as i64, (oy + y).round() as i64);
        let Some([cx, cy, cw, ch]) = clip else { return blit(target, img, x, y) };
        let (x0, y0) = ((ox + cx).round() as i64, (oy + cy).round() as i64);
        let (x1, y1) = (x0 + cw.round() as i64, y0 + ch.round() as i64);
        let (tw, th) = (target.width() as i64, target.height() as i64);
        for (ix, iy, p) in img.enumerate_pixels() {
            let (tx, ty) = (x + ix as i64, y + iy as i64);
            if tx >= x0.max(0) && ty >= y0.max(0) && tx < x1.min(tw) && ty < y1.min(th) {
                blend(target.get_pixel_mut(tx as u32, ty as u32), *p);
            }
        }
    };
    for op in &list.hud {
        match op {
            HudOp::Rect { x, y, w, h, color, border } => {
                let (w, h) = (w.round().max(1.0) as u32, h.round().max(1.0) as u32);
                let mut img = RgbaImage::from_pixel(w, h, to_rgba(*color));
                if let Some(b) = border {
                    let b = to_rgba(*b);
                    for i in 0..w {
                        img.put_pixel(i, 0, b);
                        img.put_pixel(i, h - 1, b);
                    }
                    for j in 0..h {
                        img.put_pixel(0, j, b);
                        img.put_pixel(w - 1, j, b);
                    }
                }
                put(&mut target, &img, *x, *y, clip);
            }
            HudOp::Bitmap { render, x, y, w, h, .. } => {
                put(&mut target, &render(w.round() as u32, h.round() as u32), *x, *y, clip);
            }
            HudOp::Image { image, x, y, w, h, .. } => {
                let img = vibevalley_pixel::css_pixelated(image, w.round() as u32, h.round() as u32);
                put(&mut target, &img, *x, *y, clip);
            }
            HudOp::Clip(c) => clip = *c,
            HudOp::Text { .. } | HudOp::TextIn { .. } => {}
        }
    }
    target
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regression_scaled_sprites_sample_the_destination_pixel_centres() {
        let src = RgbaImage::from_fn(4, 4, |x, y| Rgba([x as u8, y as u8, 0, 255]));
        let small = resample(&src, 2, 2, false, 1.0);
        assert_eq!(small.get_pixel(0, 0).0, [1, 1, 0, 255]);
        assert_eq!(small.get_pixel(1, 1).0, [3, 3, 0, 255]);
        let flipped = resample(&src, 2, 2, true, 0.5);
        assert_eq!(flipped.get_pixel(0, 1).0, [3, 3, 0, 128]);
    }

    #[test]
    fn resample_is_nearest_and_flips() {
        let mut src = RgbaImage::new(2, 1);
        src.put_pixel(0, 0, Rgba([255, 0, 0, 255]));
        src.put_pixel(1, 0, Rgba([0, 0, 255, 255]));
        let out = resample(&src, 4, 2, false, 1.0);
        assert_eq!(out.get_pixel(1, 1).0, [255, 0, 0, 255]);
        assert_eq!(out.get_pixel(2, 0).0, [0, 0, 255, 255]);
        let flipped = resample(&src, 2, 1, true, 0.5);
        assert_eq!(flipped.get_pixel(0, 0).0, [0, 0, 255, 128]);
    }

    #[test]
    fn rects_blend_over_the_background() {
        let mut list = DrawList::new(4.0, 4.0, rgba(0x000000, 1.0));
        list.rect(1.0, 1.0, 2.0, 2.0, rgba(0xffffff, 0.5));
        let img = raster(&list, None, 2.0);
        assert_eq!(img.dimensions(), (8, 8));
        assert_eq!(img.get_pixel(0, 0).0, [0, 0, 0, 255]);
        assert_eq!(img.get_pixel(3, 3).0, [128, 128, 128, 255]);
    }
}
