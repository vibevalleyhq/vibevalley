//! Host-agnostic domain synchronization & player intent contracts for `vibevalley-diorama`.
//!
//! Pure Rust + `serde` (zero UI-host dependencies) so macOS, iOS, Android, Windows, and Web hosts
//! can push live ticket/agent state into [`crate::DioramaWorld`] and receive structured player intents.

use crate::foley::SoundKind;
use crate::world::{PlotStage, TimeOfDay};
use serde::{Deserialize, Serialize};

/// Incremental state snapshot of one farm plot synced from the host workspace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotTicketSync {
    pub index: usize,
    pub stage: PlotStage,
    pub title: String,
    #[serde(default)]
    pub locked: Option<bool>,
}

/// Incremental assignment update of one animal helper synced from the host workspace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperTaskSync {
    pub id: String,
    #[serde(default)]
    pub home_plot: Option<usize>,
    #[serde(default)]
    pub default_spot: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
}

/// Unlocked yard decoration synced from the farm shop ledger into the 3D scene.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecorationSync {
    pub id: String,
    pub asset: String,
    pub x: f32,
    pub z: f32,
    pub yaw_deg: f32,
    pub scale: f32,
}

/// Idempotent host-to-diorama snapshot payload applied via [`crate::DioramaWorld::apply_domain_sync`].
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YardSnapshotSync {
    #[serde(default)]
    pub plots: Vec<PlotTicketSync>,
    #[serde(default)]
    pub helpers: Vec<HelperTaskSync>,
    #[serde(default)]
    pub decorations: Vec<DecorationSync>,
    #[serde(default)]
    pub time_of_day: Option<TimeOfDay>,
}

/// Structured player gameplay intent emitted back to the embedding VibeValley host.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "intent", rename_all = "camelCase")]
pub enum PlayerIntent {
    HarvestPlot { index: usize, title: String, harvest_count: u32 },
    ResolveAskingPlot { index: usize, title: String },
    RepairPlot { index: usize, title: String },
    CleanWeedsPlot { index: usize, title: String },
    SeedPlot { index: usize, title: String },
    InspectBuilding { id: String, label: String, cutaway: bool },
    GreetHelper { id: String, name: String },
}

/// Result of executing a semantic Play Mode plot interaction (`DioramaWorld::interact_plot`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotActionOutcome {
    pub index: usize,
    pub prev_stage: PlotStage,
    pub next_stage: PlotStage,
    pub harvest_delta: u32,
    pub harvest_count: u32,
    pub summary: String,
    pub sound: SoundKind,
    pub intent: PlayerIntent,
}

/// Screen-space projected anchor for lightweight viewport status bubbles & building hover plaques.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenAnchor {
    pub kind: String,
    pub id: String,
    pub label: String,
    pub badge: String,
    pub tone: String,
    /// Normalized viewport coordinates in `[0.0, 1.0]` (top-left origin).
    pub x: f32,
    pub y: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plot_index: Option<usize>,
    pub urgent: bool,
}
