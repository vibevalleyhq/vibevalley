//! VibeValley's sprites: `pixel/sprites.json` (sizes and feet in the PNGs'
//! pixels) and one PNG per name, drawn at `density` PNG pixels per art pixel.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

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
    sprites: HashMap<String, SpriteInfo>,
    yards: HashMap<String, super::level::Box2>,
    pub density: f32,
    normals: Mutex<HashMap<String, Arc<RgbaImage>>>,
    images: Mutex<HashMap<String, Option<Arc<RgbaImage>>>>,
}

impl Atlas {
    /// `dir/sprites.json` with the PNGs beside it. `density` is taken from
    /// the sprite named `map` when there is one, else `fallback_density`.
    pub fn load(dir: &Path, fallback_density: f32) -> Result<Atlas, String> {
        let text = std::fs::read_to_string(dir.join("sprites.json")).map_err(|e| format!("{}: {e}", dir.display()))?;
        Atlas::parse(dir, &text, fallback_density)
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
        Ok(Atlas {
            dir: dir.to_path_buf(),
            sprites,
            yards,
            density,
            normals: Mutex::new(HashMap::new()),
            images: Mutex::new(HashMap::new()),
        })
    }

    pub fn has(&self, name: &str) -> bool {
        self.sprites.contains_key(name)
    }

    pub fn get(&self, name: &str) -> Option<SpriteInfo> {
        self.sprites.get(name).copied()
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

    /// The decoded PNG (straight RGBA, `density` pixels per art pixel); `None`
    /// when it is not in the atlas or cannot be read. Decoded once.
    pub fn image(&self, name: &str) -> Option<Arc<RgbaImage>> {
        if let Some(found) = self.images.lock().ok()?.get(name) {
            return found.clone();
        }
        let decoded = self
            .sprites
            .contains_key(name)
            .then(|| decode(&self.dir.join(format!("{name}.png"))))
            .flatten()
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
                } else if name.starts_with("plot-") {
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
