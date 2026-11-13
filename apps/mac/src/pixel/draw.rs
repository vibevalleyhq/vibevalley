//! What a pixel scene draws, as data: sprites, images, rects and glows in art
//! pixels, plus text and boxes over it in view pixels. The GPUI element
//! paints a [`DrawList`]; [`raster`] paints the same list on the CPU, so a
//! scene can be checked as a PNG without a screen.

use std::sync::Arc;

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
}

#[derive(Clone, Default)]
pub struct DrawList {
    /// Art pixels of the picture (the framing fits this).
    pub width: f32,
    pub height: f32,
    pub background: Color,
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
}

impl DrawList {
    pub fn new(width: f32, height: f32, background: Color) -> DrawList {
        DrawList {
            width,
            height,
            background,
            ops: Vec::new(),
            hud: Vec::new(),
            hud_art: Vec::new(),
            fit: false,
            hud_center: false,
            hud_images: Vec::new(),
        }
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

    pub fn text(&mut self, x: f32, y: f32, text: impl Into<String>, size: f32, color: Color) {
        self.hud.push(HudOp::Text {
            x,
            y,
            text: text.into(),
            size,
            color,
        });
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
                HudOp::Text { text, .. } => Some(text.as_str()),
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
    let (sw, sh) = src.dimensions();
    let mut out = RgbaImage::new(w.max(1), h.max(1));
    if sw == 0 || sh == 0 {
        return out;
    }
    for y in 0..out.height() {
        let sy = ((y as u64 * sh as u64) / h.max(1) as u64).min(sh as u64 - 1) as u32;
        for x in 0..out.width() {
            let mut sx = ((x as u64 * sw as u64) / w.max(1) as u64).min(sw as u64 - 1) as u32;
            if flip {
                sx = sw - 1 - sx;
            }
            let mut p = *src.get_pixel(sx, sy);
            if alpha < 1.0 {
                p.0[3] = (p.0[3] as f32 * alpha).round() as u8;
            }
            out.put_pixel(x, y, p);
        }
    }
    out
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

/// The list's art layer at `k` pixels per art pixel, on the CPU (no HUD
/// text; HUD boxes are drawn). For checking scenes without a screen.
pub fn raster(list: &DrawList, atlas: Option<&Atlas>, k: f32) -> RgbaImage {
    let (w, h) = ((list.width * k).round() as u32, (list.height * k).round() as u32);
    let mut target = RgbaImage::from_pixel(w.max(1), h.max(1), to_rgba([list.background[0], list.background[1], list.background[2], 1.0]));
    let px = |v: f32| (v * k).round() as i64;
    for op in &list.ops {
        match op {
            Op::Sprite { name, x, y, flip, alpha } => {
                let (Some(atlas), true) = (atlas, *alpha > 0.0) else { continue };
                let (Some(src), Some(info)) = (atlas.image(name), atlas.get(name)) else {
                    continue;
                };
                let img = resample(&src, (info.w * k).round() as u32, (info.h * k).round() as u32, *flip, *alpha);
                blit(&mut target, &img, px(*x), px(*y));
            }
            Op::Image { image, x, y, w, h, alpha, .. } => {
                let img = resample(image, (w * k).round() as u32, (h * k).round() as u32, false, *alpha);
                blit(&mut target, &img, px(*x), px(*y));
            }
            Op::Rect { x, y, w, h, color } => {
                let img = RgbaImage::from_pixel((w * k).round().max(1.0) as u32, (h * k).round().max(1.0) as u32, to_rgba(*color));
                blit(&mut target, &img, px(*x), px(*y));
            }
            Op::Glow { x, y, r, color } => {
                let img = glow_image((r * 2.0 * k).round() as u32, *color);
                blit(&mut target, &img, px(x - r), px(y - r));
            }
        }
    }
    target
}

#[cfg(test)]
mod tests {
    use super::*;

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
