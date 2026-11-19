use image::{Pixel, Rgba, RgbaImage, imageops};
use std::sync::Arc;

/// A 22-point helper portrait with its runtime badge extending three points beyond it.
#[derive(Clone)]
pub(super) struct HelperFace {
    pub head: Option<Arc<RgbaImage>>,
    pub logo: Option<Arc<RgbaImage>>,
}

impl HelperFace {
    pub const SIZE: f32 = 25.;

    pub fn paint(&self, width: u32) -> RgbaImage {
        let scale = width as f32 / Self::SIZE;
        let px = |points: f32| (points * scale).round() as u32;
        let mut tile = RgbaImage::new(width, width);
        let mut face = RgbaImage::from_pixel(px(22.), px(22.), Rgba([180, 203, 124, 153]));
        if let Some(source) = &self.head {
            let w = 44. * source.width() as f32 / source.height() as f32;
            let left = ((22. - w) / 2.).round();
            let right = ((22. + w) / 2.).round();
            let head = vibevalley_pixel::css_pixelated(source, px(right - left), px(44.));
            imageops::overlay(&mut face, &head, (left * scale).round() as i64, -(px(1.) as i64));
        }
        round_corners(&mut face, 4. * scale);
        imageops::overlay(&mut tile, &face, 0, 0);
        let mut ring = RgbaImage::from_pixel(px(12.), px(12.), Rgba([58, 42, 24, 255]));
        round_corners(&mut ring, 4. * scale);
        imageops::overlay(&mut tile, &ring, px(13.) as i64, px(13.) as i64);
        let mut badge = RgbaImage::from_pixel(px(10.), px(10.), Rgba([247, 232, 196, 255]));
        round_corners(&mut badge, 3. * scale);
        imageops::overlay(&mut tile, &badge, px(14.) as i64, px(14.) as i64);
        if let Some(source) = &self.logo {
            let fit = 8. / source.width().max(source.height()) as f32;
            let w = source.width() as f32 * fit;
            let h = source.height() as f32 * fit;
            let (left, top) = ((19. - w / 2.).round(), (19. - h / 2.).round());
            let (right, bottom) = ((19. + w / 2.).round(), (19. + h / 2.).round());
            let logo = vibevalley_pixel::css_pixelated(source, px(right - left), px(bottom - top));
            imageops::overlay(&mut tile, &logo, px(left) as i64, px(top) as i64);
        }
        tile
    }
}

fn round_corners(image: &mut RgbaImage, radius: f32) {
    let half = image.width() as f32 / 2.;
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        let dx = ((x as f32 + 0.5 - half).abs() - half + radius).max(0.);
        let dy = ((y as f32 + 0.5 - half).abs() - half + radius).max(0.);
        let coverage = (radius + 0.5 - dx.hypot(dy)).clamp(0., 1.);
        pixel.channels_mut()[3] = (f32::from(pixel[3]) * coverage).round() as u8;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regression_the_helper_and_its_badge_keep_their_rounded_edges_at_both_densities() {
        let face = HelperFace { head: None, logo: None };
        for scale in [1, 2] {
            let tile = face.paint(25 * scale);
            assert_eq!(tile.get_pixel(0, 0)[3], 0);
            assert_eq!(tile.get_pixel(10 * scale, 10 * scale)[3], 153);
            assert_eq!(tile.get_pixel(19 * scale, 24 * scale).0, [58, 42, 24, 255]);
            assert_eq!(tile.get_pixel(19 * scale, 19 * scale).0, [247, 232, 196, 255]);
            assert_eq!(tile.get_pixel(25 * scale - 1, 25 * scale - 1)[3], 0);
        }
    }
}
