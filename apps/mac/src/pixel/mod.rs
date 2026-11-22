//! GPU-painted pixel scenes carried over from VibeValley: the farm, the map
//! of islands, the memory tree, the opening and the catalog. Each scene is
//! plain Rust that turns the server's frame into a [`draw::DrawList`]; the
//! GPUI element ([`element`]) paints it with nearest-neighbour sprites, and
//! [`draw::raster`] paints the same list on the CPU for checks.

pub mod atlas;
pub mod catalog;
pub mod draw;
pub mod element;
pub mod farm;
mod font;
pub mod level;
pub mod nav;
pub mod opening;
pub mod sky;
pub mod tree;
pub mod view;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use atlas::Atlas;
use farm::world::VillageWorld;
use level::Level;

/// Where the processed art is: `VIBEVALLEY_ASSETS`, else the repo's `assets/`.
pub fn assets_dir() -> PathBuf {
    std::env::var_os("VIBEVALLEY_ASSETS")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../assets"))
}

fn atlas_cache() -> &'static Mutex<HashMap<PathBuf, Arc<Atlas>>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Arc<Atlas>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn village_cache() -> &'static Mutex<HashMap<PathBuf, Arc<VillageWorld>>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Arc<VillageWorld>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Non-blocking cache lookup for the sprite atlas; returns `Some` in 0ms once loaded.
pub fn try_cached_atlas() -> Option<Arc<Atlas>> {
    let dir = assets_dir();
    atlas_cache().lock().ok()?.get(&dir).cloned()
}

/// Non-blocking cache lookup for the farm world and atlas; returns `Some` in 0ms once loaded.
pub fn try_cached_village() -> Option<(VillageWorld, Arc<Atlas>)> {
    let dir = assets_dir();
    let atlas = atlas_cache().lock().ok()?.get(&dir).cloned()?;
    let world = village_cache().lock().ok()?.get(&dir).cloned()?;
    Some(((*world).clone(), atlas))
}

/// The sprites alone. Cached process-wide per `assets_dir()` so decoded PNGs and
/// computed normals persist across Farm / Map / Tree switches. Blocking on cold miss.
pub fn load_atlas() -> Result<Arc<Atlas>, String> {
    let dir = assets_dir();
    if let Some(cached) = atlas_cache().lock().ok().and_then(|map| map.get(&dir).cloned()) {
        return Ok(cached);
    }
    let loaded = Arc::new(Atlas::load(&dir.join("pixel"), 2.0)?);
    if let Ok(mut map) = atlas_cache().lock() {
        return Ok(map.entry(dir).or_insert_with(|| loaded.clone()).clone());
    }
    Ok(loaded)
}

/// The village and its sprites. Cached process-wide per `assets_dir()`.
/// Blocking (reads and parses files on cold miss): call off the UI thread.
pub fn load_village() -> Result<(VillageWorld, Arc<Atlas>), String> {
    let dir = assets_dir();
    let atlas = load_atlas()?;
    if let Some(cached) = village_cache().lock().ok().and_then(|map| map.get(&dir).cloned()) {
        return Ok(((*cached).clone(), atlas));
    }
    let ldtk = std::fs::read_to_string(dir.join("village.ldtk")).map_err(|e| format!("{}: {e}", dir.join("village.ldtk").display()))?;
    let world = Arc::new(VillageWorld::new(Level::parse(&ldtk)?)?);
    if let Ok(mut map) = village_cache().lock() {
        let stored = map.entry(dir).or_insert_with(|| world.clone()).clone();
        return Ok(((*stored).clone(), atlas));
    }
    Ok(((*world).clone(), atlas))
}

#[cfg(test)]
mod tests;
