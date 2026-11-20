use crate::Lighting;
use image::{GrayImage, Rgba, RgbaImage};

pub type Tint = [f32; 3];
#[derive(Clone, Copy)]
pub struct Brush {
    pub bounds: [f32; 4],
    pub alpha: f32,
    pub flip: bool,
    pub tint: Tint,
    pub additive: bool,
}

impl Brush {
    pub fn at(x: f32, y: f32, w: f32, h: f32) -> Self {
        Self {
            bounds: [x, y, w, h],
            alpha: 1.,
            flip: false,
            tint: [1.; 3],
            additive: false,
        }
    }
}

pub struct Surface {
    color: RgbaImage,
    normal: RgbaImage,
    density: u32,
}

impl Surface {
    pub fn new(w: u32, h: u32, density: u32, bg: Rgba<u8>) -> Self {
        assert!(density > 0);
        Self {
            color: RgbaImage::from_pixel(w * density, h * density, bg),
            normal: RgbaImage::from_pixel(w, h, Rgba([128, 128, 255, 255])),
            density,
        }
    }
    pub fn paint(&mut self, image: &RgbaImage, normal: Option<&RgbaImage>, brush: Brush) {
        self.paint_with_depth(image, normal, brush, None);
    }
    /// The baked depth is measured at ground level in logical pixels, just like the sprite's feet.
    pub fn paint_with_depth(&mut self, image: &RgbaImage, normal: Option<&RgbaImage>, brush: Brush, occlusion: Option<(&GrayImage, f32)>) {
        blit(&mut self.color, self.density, image, brush, false, occlusion);
        if let Some(normal) = normal {
            blit(
                &mut self.normal,
                1,
                normal,
                Brush {
                    tint: [1.; 3],
                    additive: false,
                    ..brush
                },
                true,
                occlusion,
            );
        }
    }
    pub fn shade(&mut self, lighting: &Lighting) {
        lighting.shade(&mut self.color, &self.normal, self.density as usize);
    }
    pub fn finish(self) -> RgbaImage {
        self.color
    }
}

fn byte(v: f32) -> u8 {
    v.round().clamp(0., 255.) as u8
}

fn blit(out: &mut RgbaImage, scale: u32, src: &RgbaImage, b: Brush, normal: bool, occlusion: Option<(&GrayImage, f32)>) {
    if src.width() == 0 || src.height() == 0 || b.alpha <= 0. {
        return;
    }
    let s = scale as f32;
    let [x, y, w, h] = b.bounds.map(|n| n * s);
    if w <= 0. || h <= 0. {
        return;
    }
    let x0 = (x - 0.5).ceil().max(0.) as u32;
    let y0 = (y - 0.5).ceil().max(0.) as u32;
    let x1 = ((x + w - 0.5).ceil() as u32).min(out.width());
    let y1 = ((y + h - 0.5).ceil() as u32).min(out.height());
    let identity = b.tint == [1.; 3] && !b.flip && b.alpha == 1. && !b.additive;
    for oy in y0..y1 {
        let sy = (((oy as f32 + 0.5 - y) * src.height() as f32 / h) as u32).min(src.height() - 1);
        for ox in x0..x1 {
            let sx = (((ox as f32 + 0.5 - x) * src.width() as f32 / w) as u32).min(src.width() - 1);
            let sx = if b.flip { src.width() - 1 - sx } else { sx };
            let p = src.get_pixel(sx, sy);
            if p[3] == 0 {
                continue;
            }
            if let Some((mask, feet)) = occlusion
                && mask
                    .get_pixel_checked(ox / scale, oy / scale)
                    .is_some_and(|d| d[0] > 0 && f32::from(d[0]) > feet)
            {
                continue;
            }
            let d = out.get_pixel_mut(ox, oy);
            if identity && p[3] == 255 {
                *d = *p;
                continue;
            }
            let a = b.alpha * (p[3] as f32 / 255.);
            for c in 0..3 {
                let s = if normal && b.flip && c == 0 { 255 - p[c] } else { p[c] };
                let dst = if b.additive { d[c] as f32 } else { d[c] as f32 * (1. - a) };
                d[c] = byte(dst + s as f32 * a * b.tint[c]);
            }
        }
    }
}

/// The screen transform samples the 2× render target at output-pixel centres.
pub fn nearest(src: &RgbaImage, w: u32, h: u32, bgra: bool) -> RgbaImage {
    sample_centres(src, w, h, bgra, false)
}

/// A CSS pixelated image picks the preceding texel when a sample falls exactly on an edge.
pub fn css_pixelated(src: &RgbaImage, w: u32, h: u32) -> RgbaImage {
    sample_centres(src, w, h, false, true)
}

fn sample_centres(src: &RgbaImage, w: u32, h: u32, bgra: bool, preceding_on_edge: bool) -> RgbaImage {
    let mut out = RgbaImage::new(w, h);
    if src.width() == 0 || src.height() == 0 || w == 0 || h == 0 {
        return out;
    }
    let texel = |p: u32, src: u32, dst: u32| (((2 * u64::from(p) + 1) * u64::from(src) - u64::from(preceding_on_edge)) / (2 * u64::from(dst))) as usize;
    let columns: Vec<_> = (0..w).map(|x| texel(x, src.width(), w)).collect();
    for (y, row) in out.as_mut().chunks_exact_mut(4 * w as usize).enumerate() {
        let sy = texel(y as u32, src.height(), h);
        let start = 4 * sy * src.width() as usize;
        let src = &src.as_raw()[start..];
        for (&sx, dst) in columns.iter().zip(row.as_chunks_mut::<4>().0) {
            dst.copy_from_slice(&src[sx * 4..sx * 4 + 4]);
            if bgra {
                dst.swap(0, 2);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regression_baked_wall_hides_only_pixels_behind_it_at_both_densities() {
        let mask = GrayImage::from_raw(2, 1, vec![7, 0]).unwrap();
        let red = RgbaImage::from_pixel(1, 1, Rgba([255, 0, 0, 255]));
        for density in [1, 2] {
            let mut surface = Surface::new(2, 1, density, Rgba([0, 0, 0, 255]));
            let brush = Brush::at(0., 0., 2., 1.);
            surface.paint_with_depth(&red, None, brush, Some((&mask, 6.)));
            assert_eq!(surface.color.get_pixel(0, 0)[0], 0);
            assert_eq!(surface.color.get_pixel(density, 0)[0], 255);
            surface.paint_with_depth(&red, None, brush, Some((&mask, 8.)));
            assert_eq!(surface.finish().get_pixel(0, 0)[0], 255);
        }
    }

    #[test]
    fn regression_css_and_world_images_resolve_exact_pixel_edges_separately() {
        let src = RgbaImage::from_fn(4, 4, |x, y| image::Rgba([x as u8, y as u8, 0, 255]));
        let css = css_pixelated(&src, 2, 2);
        let world = nearest(&src, 2, 2, false);
        assert_eq!(css.get_pixel(1, 1).0, [2, 2, 0, 255]);
        assert_eq!(world.get_pixel(1, 1).0, [3, 3, 0, 255]);
        assert_eq!(css_pixelated(&src, 4, 4), src);
    }
}
