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

use std::path::PathBuf;
use std::sync::Arc;

use atlas::Atlas;
use farm::world::VillageWorld;
use level::Level;

/// Where the processed art is: `VIBEVALLEY_ASSETS`, else the repo's `assets/`.
pub fn assets_dir() -> PathBuf {
    std::env::var_os("VIBEVALLEY_ASSETS")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../assets"))
}

/// The sprites alone. Blocking.
pub fn load_atlas() -> Result<Arc<Atlas>, String> {
    Atlas::load(&assets_dir().join("pixel"), 2.0).map(Arc::new).map_err(|e| e.to_string())
}

/// The village and its sprites. Blocking (reads and parses files): call off the UI thread.
pub fn load_village() -> Result<(VillageWorld, Arc<Atlas>), String> {
    let dir = assets_dir();
    let ldtk = std::fs::read_to_string(dir.join("village.ldtk")).map_err(|e| format!("{}: {e}", dir.join("village.ldtk").display()))?;
    let atlas = Atlas::load(&dir.join("pixel"), 2.0)?;
    Ok((VillageWorld::new(Level::parse(&ldtk)?)?, Arc::new(atlas)))
}

#[cfg(test)]
mod tests;
