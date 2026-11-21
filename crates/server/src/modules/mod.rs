//! VibeValley's server modules, grouped into six domain areas.

use crate::Hub;

pub mod collab;
pub mod content;
pub mod infra;
pub mod skin;
pub mod team;
pub mod work;

/// Every module this build serves.
pub fn install(hub: &Hub) {
    infra::install_health(hub);
}
