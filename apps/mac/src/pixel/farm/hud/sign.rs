use std::sync::Arc;

use crate::pixel::draw::HudOp;
use image::{Pixel, Rgba, RgbaImage};

#[derive(Clone, Copy)]
pub(super) enum Plaque {
    Repository,
    Building,
}

impl Plaque {
    /// The browser paints each sign at whole CSS pixels, then translates its layers to the map anchor.
    pub fn background(self, x: f32, y: f32, width: f32, height: f32) -> HudOp {
        let (board_height, paper, ink, kind) = match self {
            Self::Repository => (40, [127, 91, 59, 255], [47, 31, 19, 255], "repo"),
            Self::Building => (30, [176, 122, 69, 255], [58, 42, 24, 255], "place"),
        };

        let left = x.floor();
        let shift = x - left;
        let w = width.round() as i32;
        let post_left = ((width - 6.) / 2.).round() as i32;
        let post_height = height.round() as i32;
        let total = w + 3;
        HudOp::Bitmap {
            key: format!("plaque:{kind}:{w}:{post_height}:{post_left}:{}", shift.to_bits()),
            x: left,
            y,
            w: total as f32,
            h: height,
            render: Arc::new(move |dw, dh| {
                let scale = dw as f32 / total as f32;
                RgbaImage::from_fn(dw, dh, |px, py| {
                    let x = px as f32 / scale - shift;
                    let y = (py as f32 / scale).floor() as i32;
                    let cover = |left: i32, right: i32| ((x + 1. / scale).min(right as f32) - x.max(left as f32)).clamp(0., 1. / scale) * scale;
                    let mut pixel = Rgba([0; 4]);
                    let mut paint = |coverage: f32, mut color: [u8; 4]| {
                        color[3] = (color[3] as f32 * coverage).round() as u8;
                        pixel.blend(&Rgba(color));
                    };
                    if (2..board_height + 2).contains(&y) {
                        paint(cover(2, w + 2), [58, 42, 24, 153]);
                    }
                    if y < board_height {
                        // CSS paints the background under the border. At a translated edge both have partial coverage.
                        let outer = cover(0, w);
                        paint(outer, paper);
                        let border = if (2..board_height - 2).contains(&y) { outer - cover(2, w - 2) } else { outer };
                        paint(border, ink);
                    } else if matches!(self, Self::Repository) {
                        paint(cover(post_left, post_left + 6), ink);
                    }
                    pixel
                })
            }),
        }
    }
}

/// Snap the icon inside the marker before applying the marker's own fractional translation.
pub(super) fn marker_icon(name: &str, source: Arc<RgbaImage>, x: f32, y: f32, width: f32) -> HudOp {
    let left = x.floor();
    let shift = x - left;
    let width = width.round();
    HudOp::Bitmap {
        key: format!("marker:{name}:{}", shift.to_bits()),
        x: left,
        y,
        w: width + 1.,
        h: 22.,
        render: Arc::new(move |dw, dh| {
            let scale = dw as f32 / (width + 1.);
            let image = vibevalley_pixel::css_pixelated(&source, (width * scale).round() as u32, dh);
            let offset = shift * scale;
            RgbaImage::from_fn(dw, dh, |px, py| {
                let pos = px as f32 - offset;
                let col = pos.floor() as i32;
                let part = pos - pos.floor();
                let get = |i: i32| image.get_pixel_checked(i as u32, py).copied().unwrap_or(Rgba([0; 4]));
                let (a, b) = (get(col), get(col + 1));
                let wa = f32::from(a[3]) * (1. - part);
                let wb = f32::from(b[3]) * part;
                let alpha = wa + wb;
                if alpha == 0. {
                    return Rgba([0; 4]);
                }
                let channel = |i: usize| ((f32::from(a[i]) * wa + f32::from(b[i]) * wb) / alpha).round() as u8;
                Rgba([channel(0), channel(1), channel(2), alpha.round() as u8])
            })
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regression_a_fractional_sign_edge_blends_the_background_below_the_border() {
        let HudOp::Bitmap { render, .. } = Plaque::Repository.background(0.25, 0., 36., 45.) else {
            panic!("missing plaque")
        };
        for scale in [1, 2] {
            let image = render(39 * scale, 45 * scale);
            let edge = image.get_pixel(0, scale)[3];
            let coverage = 1. - 0.25 * scale as f32;
            let expected = ((1. - (1. - coverage).powi(2)) * 255.).round() as u8;
            assert!(edge.abs_diff(expected) <= 1);
            assert_eq!(image.get_pixel(4 * scale, scale)[3], 255);
            assert_eq!(image.get_pixel(4 * scale, 44 * scale)[3], 0);
        }
    }
}
