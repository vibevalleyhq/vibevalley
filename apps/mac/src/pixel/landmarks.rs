use std::path::Path;

use image::GrayImage;

use super::level::{Box2, Point, pt};

const SPOTS: [&str; 3] = ["skills", "manager", "runtimes"];

pub struct Landmarks {
    ids: GrayImage,
    pub depth: GrayImage,
    bounds: [Option<Box2>; 3],
}

impl Landmarks {
    pub fn load(path: &Path) -> Result<Self, String> {
        let image = image::open(path).map_err(|e| format!("{}: {e}", path.display()))?.into_rgb8();
        let (width, height) = image.dimensions();
        if (width, height) != (384, 256) {
            return Err(format!("{}: expected 384×256 landmark mask", path.display()));
        }
        let mut bounds: [Option<Box2>; 3] = [None; 3];
        let mut ids = GrayImage::new(width, height);
        let mut depth = GrayImage::new(width, height);
        for (x, y, pixel) in image.enumerate_pixels() {
            let id = pixel[0];
            if id == 0 {
                continue;
            }
            let Some(b) = bounds.get_mut(usize::from(id - 1)) else {
                return Err(format!("{}: unknown landmark {id} at ({x}, {y})", path.display()));
            };
            ids.put_pixel(x, y, image::Luma([id]));
            depth.put_pixel(x, y, image::Luma([pixel[1]]));
            let (x, y) = (x as f32, y as f32);
            let b = b.get_or_insert(Box2 {
                x0: x,
                y0: y,
                x1: x + 1.,
                y1: y + 1.,
            });
            b.x0 = b.x0.min(x);
            b.y0 = b.y0.min(y);
            b.x1 = b.x1.max(x + 1.);
            b.y1 = b.y1.max(y + 1.);
        }
        Ok(Self { ids, depth, bounds })
    }

    pub fn at(&self, p: Point) -> Option<(&'static str, f32)> {
        if !(p.x >= 0. && p.y >= 0.) {
            return None;
        }
        let (x, y) = (p.x as u32, p.y as u32);
        let id = self.ids.get_pixel_checked(x, y)?[0].checked_sub(1)?;
        Some((SPOTS[usize::from(id)], f32::from(self.depth.get_pixel(x, y)[0])))
    }

    pub fn pin(&self, id: &str) -> Option<Point> {
        let b = self.bounds[SPOTS.iter().position(|s| *s == id)?]?;
        Some(pt((b.x0 + b.x1) * 0.5, b.y0 + (b.y1 - b.y0) * 0.3))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regression_roofs_and_doors_share_a_destination_but_the_gap_is_clear() {
        let mask = Landmarks::load(&crate::pixel::assets_dir().join("pixel/yard-landmarks.png")).unwrap();
        for (spot, roof, door) in [
            ("skills", pt(133., 37.), pt(115., 63.)),
            ("manager", pt(225., 79.), pt(207., 105.)),
            ("runtimes", pt(294., 102.), pt(292., 120.)),
        ] {
            for p in [roof, door] {
                let (id, depth) = mask.at(p).unwrap();
                assert_eq!(id, spot);
                assert!(depth > p.y);
            }
        }
        for p in [pt(174., 65.), pt(355., 151.), pt(-1., 15.)] {
            assert_eq!(mask.at(p), None);
        }
    }
}
