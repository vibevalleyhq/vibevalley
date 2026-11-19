use image::{Rgba, RgbaImage};

#[derive(Clone, Copy)]
pub enum Normals {
    Ground,
    Plot,
    Sprite,
}

pub fn normals(src: &RgbaImage, shape: Normals) -> RgbaImage {
    let (w, h) = (src.width() as usize, src.height() as usize);
    let (bevel, relief, strength): (f32, f32, f32) = match shape {
        Normals::Ground => (0., 0.6, 0.6),
        Normals::Plot => (1.5, 0.3, 0.8),
        Normals::Sprite => (3., 0.35, 1.),
    };
    let mut height: Vec<f32> = src.pixels().map(|p| if p[3] >= 128 { bevel } else { 0. }).collect();
    if bevel > 0. {
        for forward in [true, false] {
            for i in 0..height.len() {
                let i = if forward { i } else { height.len() - 1 - i };
                let (x, y) = (i % w, i / w);
                let dx: isize = if forward { -1 } else { 1 };
                let prev = |ox: isize, oy: isize| {
                    let (px, py) = (x.wrapping_add_signed(ox), y.wrapping_add_signed(oy));
                    if px < w && py < h { height[py * w + px] } else { 0. }
                };
                height[i] = height[i]
                    .min(prev(dx, 0).min(prev(0, dx)) + 1.)
                    .min(prev(dx, dx).min(prev(-dx, dx)) + std::f32::consts::SQRT_2);
            }
        }
    }
    for (i, p) in src.pixels().enumerate() {
        if p[3] >= 128 {
            let pillow = if bevel > 0. { (height[i] / bevel).sqrt() } else { 0. };
            height[i] = pillow + relief * (0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32) / 255.;
        }
    }
    RgbaImage::from_fn(src.width(), src.height(), |x, y| {
        let (x, y) = (x as usize, y as usize);
        let alpha = src.get_pixel(x as u32, y as u32)[3];
        if alpha < 128 {
            return Rgba([128, 128, 255, alpha]);
        }
        let (l, r) = (x.saturating_sub(1), (x + 1).min(w - 1));
        let (u, b) = (y.saturating_sub(1), (y + 1).min(h - 1));
        let at = |x, y| height[y * w + x];
        let nx: f32 = (at(l, u) + 2. * at(l, y) + at(l, b) - at(r, u) - 2. * at(r, y) - at(r, b)) * strength * 0.25;
        let ny: f32 = (at(l, u) + 2. * at(x, u) + at(r, u) - at(l, b) - 2. * at(x, b) - at(r, b)) * strength * 0.25;
        let inv = 1. / (nx * nx + ny * ny + 1.).sqrt();
        let byte = |v: f32| ((v * inv * 0.5 + 0.5) * 255.).round() as u8;
        Rgba([byte(nx), byte(ny), byte(1.), alpha])
    })
}
