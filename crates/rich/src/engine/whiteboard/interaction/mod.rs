mod actions;
mod animation;
mod pointer;
mod types;

use std::collections::HashMap;

use crate::engine::whiteboard::geometry::Camera;
use crate::engine::whiteboard::hit::HitConfig;
use crate::engine::whiteboard::model::{BoardDoc, ElementId, ElementRecord, Rect2, WbFill};
use crate::engine::whiteboard::ops::UndoHistory;
use crate::engine::whiteboard::snap::{SnapConfig, SnapGuide};
use crate::engine::whiteboard::spatial::SpatialIndex;

pub use pointer::live_anchor_point;
pub use types::{
    AnimatedPresencePose, AnimationStepResult, BoardAction, ControllerEffect, ExportFormat, InlineEditTarget, InteractionMode, Modifiers, PointerButton,
    PointerInput, Tool,
};

pub struct WhiteboardController {
    pub doc: BoardDoc,
    pub spatial: SpatialIndex,
    pub lookup: HashMap<ElementId, Rect2>,
    pub camera: Camera,
    pub viewport_size: (f64, f64),
    pub tool: Tool,
    pub mode: InteractionMode,
    pub selection: Vec<ElementId>,
    pub hovered: Option<ElementId>,
    pub active_guides: Vec<SnapGuide>,
    pub snap_config: SnapConfig,
    pub history: UndoHistory,
    pub clipboard: Vec<ElementRecord>,
    pub active_fill: WbFill,
    pub active_ink_color: String,
    pub active_stroke_width: f32,
    pub follow_actor: Option<String>,
    pub presence_poses: HashMap<String, AnimatedPresencePose>,
    pub element_appear: HashMap<ElementId, f32>,
    pub smooth_animations: bool,
    pub(super) camera_target: Option<Camera>,
    pub(super) next_id_seq: u64,
    pub(super) gesture_seq: u64,
    pub(super) user_moved_camera: bool,
}

impl Default for WhiteboardController {
    fn default() -> Self {
        Self::new(BoardDoc::default())
    }
}

impl WhiteboardController {
    pub fn new(doc: BoardDoc) -> Self {
        let lookup = doc.rect_lookup();
        let spatial = SpatialIndex::build(&doc);
        let presence_poses = doc.presences.iter().map(|p| (p.id.clone(), AnimatedPresencePose::from_presence(p))).collect();
        Self {
            doc,
            spatial,
            lookup,
            camera: Camera::default(),
            viewport_size: (1100.0, 720.0),
            tool: Tool::Select,
            mode: InteractionMode::Idle,
            selection: Vec::new(),
            hovered: None,
            active_guides: Vec::new(),
            snap_config: SnapConfig::default(),
            history: UndoHistory::default(),
            clipboard: Vec::new(),
            active_fill: WbFill::Sun,
            active_ink_color: "#a83a2c".to_owned(),
            active_stroke_width: 3.0,
            follow_actor: None,
            presence_poses,
            element_appear: HashMap::new(),
            smooth_animations: false,
            camera_target: None,
            next_id_seq: 1,
            gesture_seq: 1,
            user_moved_camera: false,
        }
    }

    pub fn mark_user_moved_camera(&mut self) {
        self.user_moved_camera = true;
    }

    pub fn rebuild_index(&mut self) {
        self.lookup = self.doc.rect_lookup();
        self.spatial = SpatialIndex::build(&self.doc);
    }

    pub fn set_tool(&mut self, tool: Tool) -> Vec<ControllerEffect> {
        self.tool = tool.clone();
        vec![ControllerEffect::ToolChanged(tool)]
    }

    pub fn selection_bbox(&self, ids: &[ElementId]) -> Option<Rect2> {
        let mut iter = ids.iter().filter_map(|id| self.lookup.get(id).copied());
        let first = iter.next()?;
        Some(iter.fold(first, Rect2::union))
    }

    pub(super) fn fresh_id(&mut self, prefix: &str) -> ElementId {
        loop {
            let candidate = ElementId::new(format!("{prefix}-{}", self.next_id_seq));
            self.next_id_seq += 1;
            if self.doc.element(&candidate).is_none() {
                return candidate;
            }
        }
    }

    pub(super) fn next_coalesce_key(&mut self, kind: &str) -> String {
        let k = format!("{kind}-{}", self.gesture_seq);
        self.gesture_seq += 1;
        k
    }

    pub(super) fn hit_cfg(&self) -> HitConfig {
        HitConfig {
            zoom: self.camera.zoom,
            show_ports: matches!(self.tool, Tool::Select | Tool::Arrow),
            ..HitConfig::default()
        }
    }
}
