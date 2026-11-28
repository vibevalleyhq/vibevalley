mod domain_sync;
mod editor;
mod history;
mod presets;
mod render_batch;
mod serialize;
mod simulation;
mod types;

#[cfg(test)]
mod tests;

pub use types::{
    BuildingState, DioramaHit, EditorCursor, EntityKind, HelperAnimSummary, HelperState, PlotStage, PlotState, PropState, RenderInstance, SelectedTransform,
    TimeOfDay, building_display_info, helper_display_info, is_cutaway_building, prop_display_label,
};

use std::collections::{BTreeMap, BTreeSet};

use crate::asset::{BoneDesc, SceneSpec};
use crate::camera::CameraRig;
use crate::foley::SoundKind;
use crate::nav::NavGraph;
use crate::spring::FlapSpring;

use types::{AtlasSnapshot, EditAction};

pub struct DioramaWorld {
    pub plots: Vec<PlotState>,
    pub buildings: Vec<BuildingState>,
    pub props: Vec<PropState>,
    pub helpers: Vec<HelperState>,
    pub camera: CameraRig,
    pub time_of_day: TimeOfDay,
    pub prev_tod: TimeOfDay,
    pub tod_blend: f32,
    pub hovered: Option<DioramaHit>,
    pub selected: Option<DioramaHit>,
    pub editor_cursor: Option<EditorCursor>,
    pub elapsed: f32,
    pub pending_sounds: Vec<SoundKind>,
    pub ground_size: f32,
    pub active_preset: String,
    pub roof_cutaway_open: bool,
    pub roof_cutaway_spring: FlapSpring,
    pub show_routes: bool,
    pub nav: NavGraph,
    pub harvest_count: u32,
    pub focused_building: Option<String>,
    available_meshes: BTreeSet<String>,
    mesh_bones: BTreeMap<String, Vec<BoneDesc>>,
    base_scene: SceneSpec,
    undo_stack: Vec<EditAction>,
    redo_stack: Vec<EditAction>,
    atlas_cache: BTreeMap<String, AtlasSnapshot>,
    next_dynamic_seq: u32,
}
