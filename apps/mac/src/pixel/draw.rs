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
            width,
            height,
            background,
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
    let paint = |surface: &mut Surface, op: &Op, lit: bool, tint: [f32; 3]| match op {
        Op::Sprite { name, x, y, flip, alpha } => {
            if let (Some(info), Some(image)) = (atlas.get(name), atlas.image(name)) {
                let normal = lit.then(|| atlas.normals(name, &image));
                surface.paint(
                    &image,
                    normal.as_deref(),
                    Brush {
                        flip: *flip,
                        alpha: *alpha,
                        tint,
                        ..Brush::at(*x, *y, info.w, info.h)
                    },
                );
            }
        }
        Op::Image { key, image, x, y, w, h, alpha } => {
            let normal = (lit && atlas.has(key)).then(|| atlas.normals(key, image));
            surface.paint(
                image,
                normal.as_deref(),
                Brush {
                    alpha: *alpha,
                    tint,
                    ..Brush::at(*x, *y, *w, *h)
                },
            );
        }
        Op::Rect { x, y, w, h, color } => surface.paint(&RgbaImage::from_pixel(1, 1, to_rgba(*color)), None, Brush::at(*x, *y, *w, *h)),
        Op::Glow { x, y, r, color } => {
            let size = (r * 2.).round().max(1.) as u32;
            surface.paint(
                &glow_image(size, *color),
                None,
                Brush {
                    additive: true,
                    ..Brush::at(x - r, y - r, r * 2., r * 2.)
                },
            );
        }
    };
    for op in &list.ops[..light.foreground.start] {
        paint(&mut surface, op, true, [1.; 3]);
    }
    surface.shade(&light.lighting);
    for op in &list.ops[light.foreground.end..] {
        paint(&mut surface, op, false, [1.; 3]);
    }
    let tint = list.light.unwrap_or([1.; 3]).map(|c| (c * 0.82 * 255.).round().clamp(0., 255.) / 255.);
    for op in &list.ops[light.foreground.clone()] {
        paint(&mut surface, op, false, tint);
    }
    surface.finish()
}

/// The list's art layer at `k` pixels per art pixel, on the CPU (no HUD
/// text; HUD boxes are drawn). For checking scenes without a screen.
pub fn raster(list: &DrawList, atlas: Option<&Atlas>, k: f32) -> RgbaImage {
    let (w, h) = ((list.width * k).round() as u32, (list.height * k).round() as u32);
    if let (Some(light), Some(atlas)) = (&list.farm_light, atlas) {
        return vibevalley_pixel::nearest(&farm_picture(list, atlas, light), w, h, false);
    }
    let mut target = RgbaImage::from_pixel(w.max(1), h.max(1), to_rgba([list.background[0], list.background[1], list.background[2], 1.0]));
    let px = |v: f32| (v * k).round() as i64;
    if let Some(l) = list.light {
        shade(&mut target, l);
    }
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
                blit(&mut target, &img, px(*x), px(*y));
            }
            Op::Image { image, x, y, w, h, alpha, .. } => {
                let mut img = resample(image, (w * k).round() as u32, (h * k).round() as u32, false, *alpha);
                if let Some(l) = light {
                    shade(&mut img, l);
                }
                blit(&mut target, &img, px(*x), px(*y));
            }
            Op::Rect { x, y, w, h, color } => {
                let color = &shade_color(*color, light);
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

/// The list as a pane `view` pixels big shows it: the picture framed as the
/// painter frames it, then the HUD's boxes and pictures (no text). For
/// checking a HUD's layout without a screen.
#[cfg(test)]
pub fn raster_view(list: &DrawList, atlas: Option<&Atlas>, view: (f32, f32)) -> RgbaImage {
    let f = super::sky::frame_whole(view, (list.width, list.height), super::sky::FARM_CUT);
    let art = raster(list, atlas, f.scale);
    let bg = shade_color(list.background, list.light);
    let dim = to_rgba([bg[0] * 0.7, bg[1] * 0.7, bg[2] * 0.7, 1.0]);
    let mut target = RgbaImage::from_pixel(view.0.round().max(1.0) as u32, view.1.round().max(1.0) as u32, dim);
    blit(&mut target, &art, f.bx.x.round() as i64, f.bx.y.round() as i64);
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
