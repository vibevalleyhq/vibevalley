//! VibeValley's sprites: `pixel/sprites.json` (sizes and feet in the PNGs'
//! pixels) and one PNG per name, drawn at `density` PNG pixels per art pixel.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use super::glb::{SpriteCanvas, helper_standing, painted_sprite};
use image::RgbaImage;
use serde::Deserialize;

/// VibeValley's level width in art pixels; the map's PNG width over it is the density.
pub const LEVEL_WIDTH: f32 = 384.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpriteInfo {
    /// Art pixels.
    pub w: f32,
    pub h: f32,
    /// The pixel that stands on the ground, art pixels from the top left.
    pub ax: f32,
    pub ay: f32,
}

#[derive(Deserialize)]
struct RawSprite {
    w: f32,
    h: f32,
    #[serde(default)]
    ax: f32,
    #[serde(default)]
    ay: f32,
    yard: Option<[f32; 4]>,
}

pub struct Atlas {
    dir: PathBuf,
    pub(super) landmarks: Option<super::landmarks::Landmarks>,
    sprites: HashMap<String, SpriteInfo>,
    yards: HashMap<String, super::level::Box2>,
    pub density: f32,
    models: Mutex<super::glb::ModelLibrary>,
    model_sizes: Mutex<HashMap<String, SpriteCanvas>>,
    ink: Mutex<HashMap<String, super::level::Box2>>,
    normals: Mutex<HashMap<String, Arc<RgbaImage>>>,
    images: Mutex<HashMap<String, Option<Arc<RgbaImage>>>>,
}

impl Atlas {
    /// `dir/sprites.json` with the PNGs beside it. `density` is taken from
    /// the sprite named `map` when there is one, else `fallback_density`.
    pub fn load(dir: &Path, fallback_density: f32) -> Result<Atlas, String> {
        let text = std::fs::read_to_string(dir.join("sprites.json")).map_err(|e| format!("{}: {e}", dir.display()))?;
        let mut atlas = Atlas::parse(dir, &text, fallback_density)?;
        let mask = dir.join("yard-landmarks.png");
        if mask.try_exists().map_err(|e| format!("{}: {e}", mask.display()))? {
            atlas.landmarks = Some(super::landmarks::Landmarks::load(&mask)?);
        }
        Ok(atlas)
    }

    pub fn parse(dir: &Path, text: &str, fallback_density: f32) -> Result<Atlas, String> {
        let raw: HashMap<String, RawSprite> = serde_json::from_str(text).map_err(|e| format!("sprites.json: {e}"))?;
        let density = raw.get("map").map(|m| m.w / LEVEL_WIDTH).unwrap_or(fallback_density);
        let yards = raw
            .iter()
            .filter_map(|(name, v)| {
                let [x0, y0, x1, y1] = v.yard?;
                let d = density;
                Some((
                    name.clone(),
                    super::level::Box2 {
                        x0: x0 / d,
                        y0: y0 / d,
                        x1: x1 / d,
                        y1: y1 / d,
                    },
                ))
            })
            .collect();
        let sprites = raw
            .into_iter()
            .map(|(name, v)| {
                let d = density;
                (
                    name,
                    SpriteInfo {
                        w: v.w / d,
                        h: v.h / d,
                        ax: v.ax / d,
                        ay: v.ay / d,
                    },
                )
            })
            .collect();
        let models_dir = dir.parent().map(|p| p.join("models")).unwrap_or_else(|| dir.join("models"));
        Ok(Atlas {
            landmarks: None,
            dir: dir.to_path_buf(),
            sprites,
            yards,
            density,
            models: Mutex::new(super::glb::ModelLibrary::new(models_dir)),
            model_sizes: Mutex::new(HashMap::new()),
            ink: Mutex::new(HashMap::new()),
            normals: Mutex::new(HashMap::new()),
            images: Mutex::new(HashMap::new()),
        })
    }

    pub fn has(&self, name: &str) -> bool {
        self.sprites.contains_key(painted_sprite(name, false).as_ref())
    }

    pub fn landmark_at(&self, screen: super::level::Point) -> Option<(&'static str, f32)> {
        self.landmarks.as_ref()?.at(screen)
    }

    fn canvas(&self, name: &str) -> Option<SpriteCanvas> {
        let source = self.sprites.get(painted_sprite(name, false).as_ref())?;
        let painted = SpriteCanvas {
            width: (source.w * self.density).round().max(1.0) as u32,
            height: (source.h * self.density).round().max(1.0) as u32,
            foot_x: source.ax * self.density,
            foot_y: source.ay * self.density + 1.0,
            density: self.density,
            pixels_per_unit: None,
        };
        let key = name.split_once('@').map_or(name, |(clip, _)| clip);
        let mut sizes = self.model_sizes.lock().ok()?;
        if let Some(size) = sizes.get(key) {
            return Some(*size);
        }
        let standing_height = helper_standing(name)
            .and_then(|standing| self.sprites.get(&standing))
            .map(|standing| standing.h * self.density);
        let size = if standing_height.is_some() || key.starts_with("plot-") || key.starts_with("island/plot-") {
            self.models.lock().ok()?.model_canvas(name, painted, standing_height).unwrap_or(painted)
        } else {
            painted
        };
        sizes.insert(key.into(), size);
        Some(size)
    }

    pub fn get(&self, name: &str) -> Option<SpriteInfo> {
        let canvas = self.canvas(name)?;
        Some(SpriteInfo {
            w: canvas.width as f32 / self.density,
            h: canvas.height as f32 / self.density,
            ax: canvas.foot_x / self.density,
            ay: (canvas.foot_y - 1.0) / self.density,
        })
    }

    pub fn visible_box(&self, name: &str, x: f32, y: f32, flip: bool) -> Option<super::level::Box2> {
        let info = self.get(name)?;
        let (x, y) = self.top_left(name, x, y, flip)?;
        let mut cache = self.ink.lock().ok()?;
        let ink = match cache.get(name) {
            Some(&ink) => ink,
            None => {
                let image = self.image(name)?;
                let mut ink = super::level::Box2 {
                    x0: info.w,
                    y0: info.h,
                    x1: 0.0,
                    y1: 0.0,
                };
                for (px, py, _) in image.enumerate_pixels().filter(|(_, _, pixel)| pixel[3] >= 128) {
                    ink.x0 = ink.x0.min(px as f32 / self.density);
                    ink.y0 = ink.y0.min(py as f32 / self.density);
                    ink.x1 = ink.x1.max((px + 1) as f32 / self.density);
                    ink.y1 = ink.y1.max((py + 1) as f32 / self.density);
                }
                if ink.x0 >= ink.x1 || ink.y0 >= ink.y1 {
                    return None;
                }
                cache.insert(name.into(), ink);
                ink
            }
        };
        let (left, right) = if flip { (info.w - ink.x1, info.w - ink.x0) } else { (ink.x0, ink.x1) };
        Some(super::level::Box2 {
            x0: x + left,
            y0: y + ink.y0,
            x1: x + right,
            y1: y + ink.y1,
        })
    }

    /// The box of the yard a building's or island's picture covers, art pixels from its top left.
    pub fn yard(&self, name: &str) -> Option<super::level::Box2> {
        self.yards.get(name).copied()
    }

    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.sprites.keys().map(String::as_str)
    }

    /// The first of `names` the atlas has, else the last.
    pub fn first<'a>(&self, names: &[&'a str]) -> &'a str {
        names.iter().copied().find(|n| self.has(n)).or(names.last().copied()).unwrap_or("")
    }

    /// The decoded sprite (straight RGBA, `density` pixels per art pixel);
    /// renders from `assets/models/*.glb` when a 3D voxel model exists, else
    /// decodes the PNG beside `sprites.json`. Cached after first use.
    pub fn image(&self, name: &str) -> Option<Arc<RgbaImage>> {
        if let Some(found) = self.images.lock().ok()?.get(name) {
            return found.clone();
        }
        let canvas = self.canvas(name)?;
        let rendered = self.models.lock().ok().and_then(|mut lib| lib.render_sprite(name, canvas));
        let decoded = rendered
            .or_else(|| {
                let painted = painted_sprite(name, true);
                let image = decode(&self.dir.join(format!("{painted}.png")))?;
                let original = self.sprites.get(painted.as_ref())?;
                if canvas.width == image.width()
                    && canvas.height == image.height()
                    && canvas.foot_x == original.ax * self.density
                    && canvas.foot_y == original.ay * self.density + 1.0
                {
                    return Some(image);
                }
                let mut aligned = RgbaImage::new(canvas.width, canvas.height);
                image::imageops::replace(
                    &mut aligned,
                    &image,
                    (canvas.foot_x - original.ax * self.density).round() as i64,
                    (canvas.foot_y - 1.0 - original.ay * self.density).round() as i64,
                );
                Some(aligned)
            })
            .map(Arc::new);
        self.images.lock().ok()?.insert(name.to_string(), decoded.clone());
        decoded
    }

    pub fn normals(&self, name: &str, img: &RgbaImage) -> Arc<RgbaImage> {
        let mut cache = self.normals.lock().expect("sprite normals");
        cache
            .entry(name.to_owned())
            .or_insert_with(|| {
                let shape = if name == "map" {
                    vibevalley_pixel::Normals::Ground
                } else if name.starts_with("plot-") || name.starts_with("island/plot-") {
                    vibevalley_pixel::Normals::Plot
                } else {
                    vibevalley_pixel::Normals::Sprite
                };
                Arc::new(vibevalley_pixel::normals(img, shape))
            })
            .clone()
    }

    /// The top left of `name` stood with its feet on (`x`, `y`), art pixels;
    /// mirrored about `x` when `flip`. Pixi's anchor puts the feet pixel's
    /// bottom edge on the point.
    pub fn top_left(&self, name: &str, x: f32, y: f32, flip: bool) -> Option<(f32, f32)> {
        let s = self.get(name)?;
        let left = if flip { x - (s.w - s.ax) } else { x - s.ax };
        Some((left, y - (s.ay + 1.0 / self.density)))
    }
}

pub fn decode(path: &Path) -> Option<RgbaImage> {
    image::open(path).ok().map(|i| i.into_rgba8())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn density_comes_from_the_map() {
        let a = Atlas::parse(
            Path::new("/x"),
            r#"{"map":{"w":768,"h":512,"ax":0,"ay":0},"bear-farmer-down":{"w":24,"h":36,"ax":12,"ay":35}}"#,
            1.0,
        )
        .unwrap();
        assert_eq!(a.density, 2.0);
        assert_eq!(
            a.get("bear-farmer-down"),
            Some(SpriteInfo {
                w: 12.0,
                h: 18.0,
                ax: 6.0,
                ay: 17.5
            })
        );
        assert_eq!(a.top_left("bear-farmer-down", 100.0, 50.0, false), Some((94.0, 32.0)));
        assert_eq!(a.top_left("bear-farmer-down", 100.0, 50.0, true), Some((94.0, 32.0)));
        assert_eq!(a.first(&["nope", "bear-farmer-down"]), "bear-farmer-down");
    }
}
