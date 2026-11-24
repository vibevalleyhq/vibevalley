use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::engine::whiteboard::codec::{WhiteboardEntry, WhiteboardWriteInput, merge_live_presences};
use crate::engine::whiteboard::geometry::{Camera, MAX_ZOOM, MIN_ZOOM, anchor_point, project_point_to_polyline, route_arrow};
use crate::engine::whiteboard::hit::{HitConfig, HitTarget, ResizeHandle8, hit_test, marquee_select, snap_anchor_endpoint};
use crate::engine::whiteboard::ink::{simplify_stroke_points, strokes_hit_by_eraser};
use crate::engine::whiteboard::model::{
    AnchorSide, ArrowCurve, ArrowEndpoint, ArrowHead, BoardDoc, ElementId, ElementKind, ElementRecord, GridStyle, InkMode, MilestoneKind, Point2, Presence,
    PresenceViewport, Rect2, ShapeKind, StrokePoint, StrokeStyle, TextAlign, TextVariant, TimelineMilestone, Vec2, WbFill,
};
use crate::engine::whiteboard::ops::{BoardCommand, UndoHistory, ZOrderDir, apply_command, apply_history_step, apply_remote_entries, make_sticky_or_shape};
use crate::engine::whiteboard::snap::{
    AlignOp, DistributeAxis, SnapConfig, SnapGuide, compute_align_deltas, compute_distribute_deltas, compute_move_snap, compute_resize_snap,
    compute_tidy_grid_deltas, nudge_step,
};
use crate::engine::whiteboard::spatial::SpatialIndex;
use crate::engine::whiteboard::templates::{TemplateCopy, TemplateKind, build_template_doc};

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Tool {
    #[default]
    Select,
    Hand,
    Text,
    Callout,
    Container,
    Card,
    Sticky,
    Shape(ShapeKind),
    Pen,
    Highlighter,
    Eraser,
    Sticker(String),
    Arrow,
    Timeline,
    Table,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Modifiers {
    pub shift: bool,
    pub alt: bool,
    pub accel: bool,
    pub space: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointerButton {
    Primary,
    Secondary,
    Middle,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PointerInput {
    pub screen_pos: Point2,
    pub clicks: u32,
    pub button: PointerButton,
    pub modifiers: Modifiers,
    pub pressure: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    Svg,
    Png,
    Json,
    JsonCanvas,
}

#[derive(Debug, Clone, PartialEq)]
pub struct InlineEditTarget {
    pub id: ElementId,
    pub screen_rect: Rect2,
    pub title: String,
    pub body: String,
    pub milestone_index: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AnimatedPresencePose {
    pub x: f64,
    pub y: f64,
    pub w: Option<f64>,
    pub h: Option<f64>,
    pub viewport: Option<PresenceViewport>,
}

impl AnimatedPresencePose {
    pub fn from_presence(p: &Presence) -> Self {
        Self {
            x: p.x,
            y: p.y,
            w: p.w,
            h: p.h,
            viewport: p.viewport,
        }
    }

    pub fn region_rect(self, kind: crate::engine::whiteboard::model::PresenceKind) -> Option<Rect2> {
        let w = self.w.filter(|v| v.is_finite() && *v > 1.0)?;
        let h = self.h.filter(|v| v.is_finite() && *v > 1.0)?;
        if !self.x.is_finite() || !self.y.is_finite() || kind == crate::engine::whiteboard::model::PresenceKind::Viewport {
            return None;
        }
        Some(Rect2::new(self.x, self.y, w, h))
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AnimationStepResult {
    pub presence_moved: bool,
    pub camera_moved: bool,
    pub still_animating: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ControllerEffect {
    FlushBatch(Vec<WhiteboardWriteInput>),
    SelectionChanged(Vec<ElementId>),
    ToolChanged(Tool),
    ViewportChanged {
        zoom: f64,
    },
    FollowChanged(Option<String>),
    OpenInlineEditor(InlineEditTarget),
    OpenContextMenu {
        screen_pos: Point2,
        world_pos: Point2,
        target_id: Option<ElementId>,
    },
    OpenChatWithSelection(Vec<ElementId>),
    RequestExport(ExportFormat),
    GridChanged(GridStyle),
    HistoryChanged {
        can_undo: bool,
        can_redo: bool,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum BoardAction {
    Undo,
    Redo,
    DeleteSelection,
    DuplicateSelection,
    CopySelection,
    CutSelection,
    Paste,
    SelectAll,
    Align(AlignOp),
    Distribute(DistributeAxis),
    TidyGrid,
    Reorder(ZOrderDir),
    GroupSelection,
    UngroupSelection,
    ToggleLockSelection,
    WrapInContainer(String),
    FitToContent,
    ZoomToSelection,
    ResetZoom,
    ZoomBy(f64),
    SetGrid(GridStyle),
    SetFillSelection(WbFill),
    SetShapeSelection(ShapeKind),
    SetArrowCurveSelection(ArrowCurve),
    SetStrokeStyleSelection(StrokeStyle),
    SetStickerSelection(Option<String>),
    ApplyTemplate(TemplateKind, bool),
    FollowActor(Option<String>),
    AskOrchestrator,
    Export(ExportFormat),
}

#[derive(Debug, Clone, PartialEq)]
pub enum InteractionMode {
    Idle,
    Panning {
        last_screen: Point2,
    },
    Marquee {
        start_world: Point2,
        cur_world: Point2,
    },
    Dragging {
        start_world: Point2,
        prev_world: Point2,
        anchor_rect: Rect2,
        ids: Vec<ElementId>,
        moved_any: bool,
        op_key: String,
    },
    Resizing {
        id: ElementId,
        handle: ResizeHandle8,
        start_rect: Rect2,
        start_world: Point2,
        changed: bool,
        op_key: String,
    },
    Rotating {
        id: ElementId,
        center: Point2,
        start_angle_deg: f64,
        initial_rotation_deg: f64,
        changed: bool,
        op_key: String,
    },
    DrawingBox {
        start_world: Point2,
        cur_world: Point2,
    },
    DrawingInk {
        points: Vec<StrokePoint>,
        mode: InkMode,
    },
    Erasing {
        points: Vec<Point2>,
        erased_ids: Vec<ElementId>,
    },
    ConnectingArrow {
        from: ArrowEndpoint,
        cur_world: Point2,
        snap_target: Option<(ElementId, AnchorSide, Point2)>,
    },
    DraggingArrowEndpoint {
        id: ElementId,
        is_start: bool,
        snap_target: Option<(ElementId, AnchorSide, Point2)>,
        op_key: String,
    },
    DraggingTimelineControl {
        id: ElementId,
        index: usize,
        op_key: String,
    },
    DraggingTimelineMilestone {
        id: ElementId,
        index: usize,
        op_key: String,
    },
}

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
    pub smooth_animations: bool,
    camera_target: Option<Camera>,
    next_id_seq: u64,
    gesture_seq: u64,
    user_moved_camera: bool,
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

    pub fn cancel_follow(&mut self, effects: &mut Vec<ControllerEffect>) -> bool {
        self.camera_target = None;
        if self.follow_actor.take().is_some() {
            effects.push(ControllerEffect::FollowChanged(None));
            true
        } else {
            false
        }
    }

    pub fn displayed_pose(&self, p: &Presence) -> AnimatedPresencePose {
        self.presence_poses
            .get(&p.id)
            .copied()
            .unwrap_or_else(|| AnimatedPresencePose::from_presence(p))
    }

    pub fn compute_follow_camera(&self, p: &Presence) -> Camera {
        let vw = self.viewport_size.0.max(120.0);
        let vh = self.viewport_size.1.max(120.0);
        if let Some(vp) = p.viewport
            && let Some(rect) = vp.rect()
        {
            let mut cam = self.camera;
            let max_zoom = vp.zoom.filter(|z| z.is_finite() && *z > 0.0).map_or(2.0, |z| z.clamp(MIN_ZOOM, MAX_ZOOM));
            cam.fit_bounds(rect, vw, vh, 24.0, max_zoom);
            return cam;
        }
        if let Some(rect) = p.region_rect() {
            let mut cam = self.camera;
            let max_zoom = cam.zoom.clamp(MIN_ZOOM, MAX_ZOOM);
            if rect.w * max_zoom > (vw - 96.0).max(40.0) || rect.h * max_zoom > (vh - 96.0).max(40.0) {
                cam.fit_bounds(rect, vw, vh, 48.0, max_zoom);
            } else {
                let c = rect.center();
                cam.pan_x = vw * 0.5 - c.x * cam.zoom;
                cam.pan_y = vh * 0.5 - c.y * cam.zoom;
            }
            return cam;
        }
        let mut cam = self.camera;
        if let Some(vp) = p.viewport
            && let Some(z) = vp.zoom.filter(|z| z.is_finite() && *z > 0.0)
        {
            cam.zoom = z.clamp(MIN_ZOOM, MAX_ZOOM);
        }
        let focus = p.focus_point();
        cam.pan_x = vw * 0.5 - focus.x * cam.zoom;
        cam.pan_y = vh * 0.5 - focus.y * cam.zoom;
        cam
    }

    pub fn sync_presence_targets(&mut self, instant: bool) {
        let active_ids: BTreeSet<&str> = self.doc.presences.iter().map(|p| p.id.as_str()).collect();
        self.presence_poses.retain(|id, _| active_ids.contains(id.as_str()));
        for p in &self.doc.presences {
            let target = AnimatedPresencePose::from_presence(p);
            if instant {
                self.presence_poses.insert(p.id.clone(), target);
            } else {
                self.presence_poses.entry(p.id.clone()).or_insert(target);
            }
        }
    }

    pub fn needs_animation(&self) -> bool {
        if self.camera_target.is_some() {
            return true;
        }
        for p in &self.doc.presences {
            if let Some(pose) = self.presence_poses.get(&p.id)
                && !pose_close(*pose, AnimatedPresencePose::from_presence(p))
            {
                return true;
            }
        }
        false
    }

    pub fn step_animations(&mut self, dt_secs: f64, instant: bool) -> AnimationStepResult {
        let dt = dt_secs.clamp(0.001, 0.1);
        let alpha_cursor = if instant { 1.0 } else { (1.0 - (-dt / 0.065).exp()).clamp(0.12, 1.0) };
        let alpha_cam = if instant { 1.0 } else { (1.0 - (-dt / 0.10).exp()).clamp(0.08, 1.0) };

        let mut presence_moved = false;
        for p in &self.doc.presences {
            let target = AnimatedPresencePose::from_presence(p);
            let entry = self.presence_poses.entry(p.id.clone()).or_insert(target);
            if !pose_close(*entry, target) {
                let next = if instant { target } else { lerp_pose(*entry, target, alpha_cursor) };
                let settled = pose_close(next, target);
                *entry = if settled { target } else { next };
                presence_moved = true;
            }
        }

        let mut camera_moved = false;
        if let Some(target_cam) = self.camera_target {
            if instant || camera_close(self.camera, target_cam) {
                if !camera_close(self.camera, target_cam) {
                    camera_moved = true;
                }
                self.camera = target_cam;
                self.camera_target = None;
            } else {
                let next = lerp_camera(self.camera, target_cam, alpha_cam);
                if camera_close(next, target_cam) {
                    self.camera = target_cam;
                    self.camera_target = None;
                } else {
                    self.camera = next;
                }
                camera_moved = true;
            }
        }

        AnimationStepResult {
            presence_moved,
            camera_moved,
            still_animating: self.needs_animation(),
        }
    }

    fn sync_follow_camera(&mut self, effects: &mut Vec<ControllerEffect>) {
        let Some(actor) = self.follow_actor.clone() else {
            return;
        };
        let found = self.doc.presences.iter().find(|p| p.id == actor || p.name == actor).cloned();
        match found {
            Some(p) => {
                let target = self.compute_follow_camera(&p);
                if camera_close(self.camera, target) {
                    self.camera_target = None;
                } else if self.smooth_animations {
                    self.camera_target = Some(target);
                } else {
                    self.camera = target;
                    self.camera_target = None;
                    effects.push(ControllerEffect::ViewportChanged { zoom: self.camera.zoom });
                }
            }
            None => {
                self.follow_actor = None;
                self.camera_target = None;
                effects.push(ControllerEffect::FollowChanged(None));
            }
        }
    }

    pub fn apply_live_presences(&mut self, store_presences: &[Presence], live: Vec<Presence>) -> Vec<ControllerEffect> {
        self.doc.presences = store_presences.to_vec();
        merge_live_presences(&mut self.doc, live);
        self.sync_presence_targets(!self.smooth_animations);
        let mut effects = Vec::new();
        self.sync_follow_camera(&mut effects);
        effects
    }

    pub fn set_viewport_size(&mut self, w: f64, h: f64) {
        self.viewport_size = (w.max(120.0), h.max(120.0));
        if !self.user_moved_camera
            && !self.doc.elements.is_empty()
            && let Some(bounds) = self.doc.content_bounds()
        {
            self.camera.fit_bounds(bounds, self.viewport_size.0, self.viewport_size.1, 68.0, 1.0);
        } else if let Some(actor) = self.follow_actor.as_deref()
            && let Some(p) = self.doc.presences.iter().find(|p| p.id == actor || p.name == actor).cloned()
        {
            let target = self.compute_follow_camera(&p);
            if self.smooth_animations {
                self.camera_target = Some(target);
            } else {
                self.camera = target;
                self.camera_target = None;
            }
        }
    }

    pub fn rebuild_index(&mut self) {
        self.lookup = self.doc.rect_lookup();
        self.spatial = SpatialIndex::build(&self.doc);
    }

    pub fn apply_remote_snapshot(&mut self, next_doc: BoardDoc) -> Vec<ControllerEffect> {
        // Keep active local tool, camera, and selection intact while updating remote elements.
        self.doc = next_doc;
        let existing: BTreeSet<ElementId> = self.doc.elements.iter().map(|e| e.id.clone()).collect();
        self.selection.retain(|id| existing.contains(id));
        self.rebuild_index();
        self.sync_presence_targets(!self.smooth_animations);

        let mut effects = Vec::new();
        if !self.user_moved_camera
            && !self.doc.elements.is_empty()
            && let Some(bounds) = self.doc.content_bounds()
        {
            self.camera.fit_bounds(bounds, self.viewport_size.0, self.viewport_size.1, 68.0, 1.0);
            effects.push(ControllerEffect::ViewportChanged { zoom: self.camera.zoom });
        }
        self.sync_follow_camera(&mut effects);
        effects
    }

    pub fn apply_remote_delta(&mut self, updated: &[WhiteboardEntry], deleted: &[String], seq: i64) -> Vec<ControllerEffect> {
        let removed = apply_remote_entries(&mut self.doc, updated, deleted, seq);
        if !removed.is_empty() {
            let rem_set: BTreeSet<ElementId> = removed.into_iter().collect();
            self.selection.retain(|id| !rem_set.contains(id));
        }
        self.rebuild_index();
        self.sync_presence_targets(!self.smooth_animations);
        let mut effects = Vec::new();
        self.sync_follow_camera(&mut effects);
        effects
    }

    pub fn set_tool(&mut self, tool: Tool) -> Vec<ControllerEffect> {
        self.tool = tool.clone();
        vec![ControllerEffect::ToolChanged(tool)]
    }

    fn fresh_id(&mut self, prefix: &str) -> ElementId {
        loop {
            let candidate = ElementId::new(format!("{prefix}-{}", self.next_id_seq));
            self.next_id_seq += 1;
            if self.doc.element(&candidate).is_none() {
                return candidate;
            }
        }
    }

    fn next_coalesce_key(&mut self, kind: &str) -> String {
        let k = format!("{kind}-{}", self.gesture_seq);
        self.gesture_seq += 1;
        k
    }

    fn hit_cfg(&self) -> HitConfig {
        HitConfig {
            zoom: self.camera.zoom,
            show_ports: matches!(self.tool, Tool::Select | Tool::Arrow),
            ..HitConfig::default()
        }
    }

    pub fn handle_pointer_down(&mut self, input: PointerInput) -> Vec<ControllerEffect> {
        let mut effects = Vec::new();
        let world_pt = self.camera.screen_to_world(input.screen_pos);

        if input.button == PointerButton::Secondary {
            let hit = hit_test(&self.doc, &self.lookup, &self.selection, self.hovered.as_ref(), world_pt, &self.hit_cfg());
            let target_id = hit_element_id(&hit);
            if let Some(id) = &target_id
                && !self.selection.contains(id)
            {
                self.selection = vec![id.clone()];
                effects.push(ControllerEffect::SelectionChanged(self.selection.clone()));
            }
            effects.push(ControllerEffect::OpenContextMenu {
                screen_pos: input.screen_pos,
                world_pos: world_pt,
                target_id,
            });
            return effects;
        }

        if input.button == PointerButton::Middle || input.modifiers.space || matches!(self.tool, Tool::Hand) {
            self.cancel_follow(&mut effects);
            self.mode = InteractionMode::Panning { last_screen: input.screen_pos };
            return effects;
        }

        match &self.tool.clone() {
            Tool::Pen => {
                self.mode = InteractionMode::DrawingInk {
                    points: vec![StrokePoint::new(world_pt.x, world_pt.y, input.pressure)],
                    mode: InkMode::Pen,
                };
                return effects;
            }
            Tool::Highlighter => {
                self.mode = InteractionMode::DrawingInk {
                    points: vec![StrokePoint::new(world_pt.x, world_pt.y, 0.7)],
                    mode: InkMode::Highlighter,
                };
                return effects;
            }
            Tool::Eraser => {
                let hit = strokes_hit_by_eraser(&self.doc, &[world_pt], 14.0 / self.camera.zoom);
                self.mode = InteractionMode::Erasing {
                    points: vec![world_pt],
                    erased_ids: hit,
                };
                return effects;
            }
            Tool::Arrow => {
                let snap = snap_anchor_endpoint(&self.doc, &self.lookup, world_pt, None, 22.0 / self.camera.zoom);
                let from = match &snap {
                    Some((id, side, _)) => ArrowEndpoint::Bound {
                        id: id.clone(),
                        side: Some(*side),
                    },
                    None => ArrowEndpoint::Free(world_pt),
                };
                self.mode = InteractionMode::ConnectingArrow {
                    from,
                    cur_world: world_pt,
                    snap_target: snap,
                };
                return effects;
            }
            Tool::Sticker(sticker_id) => {
                let id = self.fresh_id("s");
                let el = ElementRecord::new(
                    id,
                    ElementKind::Sticker {
                        x: (world_pt.x - 36.0).round(),
                        y: (world_pt.y - 36.0).round(),
                        w: 72.0,
                        h: 72.0,
                        sticker: sticker_id.clone(),
                        svg: None,
                        label: None,
                    },
                );
                let res = apply_command(&mut self.doc, Some(&mut self.history), BoardCommand::CreateElements(vec![el]), None, false);
                self.finish_create(res, &mut effects);
                return effects;
            }
            Tool::Text | Tool::Callout | Tool::Container | Tool::Card | Tool::Sticky | Tool::Shape(_) | Tool::Timeline | Tool::Table => {
                self.mode = InteractionMode::DrawingBox {
                    start_world: world_pt,
                    cur_world: world_pt,
                };
                return effects;
            }
            Tool::Select | Tool::Hand => {}
        }

        // Select tool interaction: hit-test handles, ports, elements, headers, background.
        let hit = hit_test(&self.doc, &self.lookup, &self.selection, self.hovered.as_ref(), world_pt, &self.hit_cfg());
        match hit {
            HitTarget::RotateHandle(id) => {
                if let Some(&rect) = self.lookup.get(&id)
                    && let Some(initial_rotation_deg) = self.doc.element(&id).map(|el| el.rotation_deg)
                {
                    let center = rect.center();
                    let angle = (world_pt.y - center.y).atan2(world_pt.x - center.x).to_degrees();
                    let op_key = self.next_coalesce_key("rot");
                    self.mode = InteractionMode::Rotating {
                        id,
                        center,
                        start_angle_deg: angle,
                        initial_rotation_deg,
                        changed: false,
                        op_key,
                    };
                }
            }
            HitTarget::ResizeHandle { id, handle } => {
                if let Some(&start_rect) = self.lookup.get(&id) {
                    let op_key = self.next_coalesce_key("res");
                    self.mode = InteractionMode::Resizing {
                        id,
                        handle,
                        start_rect,
                        start_world: world_pt,
                        changed: false,
                        op_key,
                    };
                }
            }
            HitTarget::AnchorPort { id, side } => {
                self.mode = InteractionMode::ConnectingArrow {
                    from: ArrowEndpoint::Bound { id, side: Some(side) },
                    cur_world: world_pt,
                    snap_target: None,
                };
            }
            HitTarget::ArrowEndpoint { id, is_start } => {
                let op_key = self.next_coalesce_key("arrow-ep");
                self.mode = InteractionMode::DraggingArrowEndpoint {
                    id,
                    is_start,
                    snap_target: None,
                    op_key,
                };
            }
            HitTarget::ArrowBend { .. } => {}
            HitTarget::TimelineControl { id, index } => {
                let op_key = self.next_coalesce_key("tl-ctrl");
                self.mode = InteractionMode::DraggingTimelineControl { id, index, op_key };
            }
            HitTarget::TimelineMilestone { id, index } => {
                if input.clicks >= 2
                    && let Some(inline) = self.build_inline_target(&id, Some(index))
                {
                    effects.push(ControllerEffect::OpenInlineEditor(inline));
                    return effects;
                }
                let op_key = self.next_coalesce_key("tl-ms");
                self.mode = InteractionMode::DraggingTimelineMilestone { id, index, op_key };
            }
            HitTarget::ContainerHeader(id) | HitTarget::Element(id) => {
                if input.clicks >= 2
                    && let Some(inline) = self.build_inline_target(&id, None)
                {
                    effects.push(ControllerEffect::OpenInlineEditor(inline));
                    return effects;
                }
                self.update_selection_on_click(&id, input.modifiers.shift, &mut effects);
                let moving_ids = self.expand_group_and_selection();
                let anchor_rect = self
                    .selection_bbox(&moving_ids)
                    .unwrap_or_else(|| self.lookup.get(&id).copied().unwrap_or(Rect2::ZERO));
                let op_key = self.next_coalesce_key("drag");
                self.mode = InteractionMode::Dragging {
                    start_world: world_pt,
                    prev_world: world_pt,
                    anchor_rect,
                    ids: moving_ids,
                    moved_any: false,
                    op_key,
                };
            }
            HitTarget::Background => {
                if !input.modifiers.shift && !self.selection.is_empty() {
                    self.selection.clear();
                    effects.push(ControllerEffect::SelectionChanged(Vec::new()));
                }
                self.mode = InteractionMode::Marquee {
                    start_world: world_pt,
                    cur_world: world_pt,
                };
            }
        }
        effects
    }

    pub fn handle_pointer_move(&mut self, input: PointerInput) -> Vec<ControllerEffect> {
        let mut effects = Vec::new();
        let world_pt = self.camera.screen_to_world(input.screen_pos);

        if matches!(self.mode, InteractionMode::Idle) {
            let hit = hit_test(&self.doc, &self.lookup, &self.selection, self.hovered.as_ref(), world_pt, &self.hit_cfg());
            self.hovered = hit_element_id(&hit);
            return effects;
        }

        let mode = std::mem::replace(&mut self.mode, InteractionMode::Idle);
        match mode {
            InteractionMode::Panning { last_screen } => {
                self.user_moved_camera = true;
                self.camera.pan_x += input.screen_pos.x - last_screen.x;
                self.camera.pan_y += input.screen_pos.y - last_screen.y;
                self.mode = InteractionMode::Panning { last_screen: input.screen_pos };
            }
            InteractionMode::Marquee { start_world, .. } => {
                let picked = marquee_select(&self.doc, &self.spatial, &self.lookup, start_world, world_pt);
                if picked != self.selection {
                    self.selection = picked;
                    effects.push(ControllerEffect::SelectionChanged(self.selection.clone()));
                }
                self.mode = InteractionMode::Marquee {
                    start_world,
                    cur_world: world_pt,
                };
            }
            InteractionMode::Dragging {
                start_world,
                prev_world,
                anchor_rect,
                ids,
                moved_any,
                op_key,
            } => {
                let mut total_delta = world_pt - start_world;
                if input.modifiers.shift {
                    if total_delta.x.abs() >= total_delta.y.abs() {
                        total_delta.y = 0.0;
                    } else {
                        total_delta.x = 0.0;
                    }
                }
                let proposed_rect = Rect2::new(anchor_rect.x + total_delta.x, anchor_rect.y + total_delta.y, anchor_rect.w, anchor_rect.h);
                let (snap_offset, guides) = compute_move_snap(&self.doc, &self.lookup, &ids, proposed_rect, &self.snap_config);
                self.active_guides = guides;
                let target_world = Point2::new(start_world.x + total_delta.x + snap_offset.x, start_world.y + total_delta.y + snap_offset.y);
                let step_delta = target_world - prev_world;
                let did_move = moved_any || step_delta.length() > 0.25;
                if step_delta.length() > 1e-4 {
                    let deltas: Vec<(ElementId, Vec2)> = ids.iter().map(|id| (id.clone(), step_delta)).collect();
                    let _ = apply_command(
                        &mut self.doc,
                        Some(&mut self.history),
                        BoardCommand::MoveElements {
                            deltas,
                            include_container_children: true,
                        },
                        Some(op_key.clone()),
                        true,
                    );
                    self.rebuild_index();
                }
                self.mode = InteractionMode::Dragging {
                    start_world,
                    prev_world: target_world,
                    anchor_rect,
                    ids,
                    moved_any: did_move,
                    op_key,
                };
            }
            InteractionMode::Resizing {
                id,
                handle,
                start_rect,
                start_world,
                changed,
                op_key,
            } => {
                let mut next = compute_resized_rect(start_rect, handle, world_pt - start_world, input.modifiers.shift, input.modifiers.alt);
                if !input.modifiers.shift {
                    let (snapped, guides) = compute_resize_snap(&self.doc, &self.lookup, &id, handle, next, &self.snap_config);
                    next = snapped;
                    self.active_guides = guides;
                } else {
                    self.active_guides.clear();
                }
                let _ = apply_command(
                    &mut self.doc,
                    Some(&mut self.history),
                    BoardCommand::SetBounds { id: id.clone(), rect: next },
                    Some(op_key.clone()),
                    true,
                );
                self.rebuild_index();
                self.mode = InteractionMode::Resizing {
                    id,
                    handle,
                    start_rect,
                    start_world,
                    changed: changed || next != start_rect,
                    op_key,
                };
            }
            InteractionMode::Rotating {
                id,
                center,
                start_angle_deg,
                initial_rotation_deg,
                changed,
                op_key,
            } => {
                let cur_angle = (world_pt.y - center.y).atan2(world_pt.x - center.x).to_degrees();
                let mut next_rot = initial_rotation_deg + (cur_angle - start_angle_deg);
                if input.modifiers.shift {
                    next_rot = (next_rot / 15.0).round() * 15.0;
                }
                let _ = apply_command(
                    &mut self.doc,
                    Some(&mut self.history),
                    BoardCommand::SetRotation {
                        changes: vec![(id.clone(), next_rot)],
                    },
                    Some(op_key.clone()),
                    true,
                );
                self.rebuild_index();
                self.mode = InteractionMode::Rotating {
                    id,
                    center,
                    start_angle_deg,
                    initial_rotation_deg,
                    changed: changed || (next_rot - initial_rotation_deg).abs() > 0.1,
                    op_key,
                };
            }
            InteractionMode::DrawingBox { start_world, .. } => {
                self.mode = InteractionMode::DrawingBox {
                    start_world,
                    cur_world: world_pt,
                };
            }
            InteractionMode::DrawingInk { mut points, mode } => {
                if points.last().is_none_or(|p| p.point2().distance_sq(world_pt) >= 3.0) {
                    points.push(StrokePoint::new(world_pt.x, world_pt.y, input.pressure));
                }
                self.mode = InteractionMode::DrawingInk { points, mode };
            }
            InteractionMode::Erasing { mut points, mut erased_ids } => {
                points.push(world_pt);
                let newly_hit = strokes_hit_by_eraser(&self.doc, &[world_pt], 14.0 / self.camera.zoom);
                for hid in newly_hit {
                    if !erased_ids.contains(&hid) {
                        erased_ids.push(hid);
                    }
                }
                self.mode = InteractionMode::Erasing { points, erased_ids };
            }
            InteractionMode::ConnectingArrow { from, .. } => {
                let exclude = match &from {
                    ArrowEndpoint::Bound { id, .. } => Some(id),
                    ArrowEndpoint::Free(_) => None,
                };
                let snap = snap_anchor_endpoint(&self.doc, &self.lookup, world_pt, exclude, 24.0 / self.camera.zoom);
                self.mode = InteractionMode::ConnectingArrow {
                    from,
                    cur_world: world_pt,
                    snap_target: snap,
                };
            }
            InteractionMode::DraggingArrowEndpoint { id, is_start, op_key, .. } => {
                let snap = snap_anchor_endpoint(&self.doc, &self.lookup, world_pt, Some(&id), 24.0 / self.camera.zoom);
                let next_ep = match &snap {
                    Some((tid, side, _)) => ArrowEndpoint::Bound {
                        id: tid.clone(),
                        side: Some(*side),
                    },
                    None => ArrowEndpoint::Free(world_pt),
                };
                if let Some(el) = self.doc.element(&id).cloned()
                    && let ElementKind::Arrow {
                        mut from,
                        mut to,
                        bends,
                        curve,
                        style,
                        start_head,
                        end_head,
                        stroke,
                        stroke_width,
                        label,
                    } = el.kind.clone()
                {
                    if is_start {
                        from = next_ep;
                    } else {
                        to = next_ep;
                    }
                    let mut next = el;
                    next.kind = ElementKind::Arrow {
                        from,
                        to,
                        bends,
                        curve,
                        style,
                        start_head,
                        end_head,
                        stroke,
                        stroke_width,
                        label,
                    };
                    let _ = apply_command(
                        &mut self.doc,
                        Some(&mut self.history),
                        BoardCommand::UpdateElement(Box::new(next)),
                        Some(op_key.clone()),
                        true,
                    );
                }
                self.mode = InteractionMode::DraggingArrowEndpoint {
                    id,
                    is_start,
                    snap_target: snap,
                    op_key,
                };
            }
            InteractionMode::DraggingTimelineControl { id, index, op_key } => {
                if let Some(el) = self.doc.element(&id).cloned()
                    && let ElementKind::Timeline {
                        x,
                        y,
                        w,
                        h,
                        fill,
                        mut points,
                        milestones,
                    } = el.kind.clone()
                    && let Some(p) = points.get_mut(index)
                {
                    *p = world_pt;
                    let mut next = el;
                    next.kind = ElementKind::Timeline {
                        x,
                        y,
                        w,
                        h,
                        fill,
                        points,
                        milestones,
                    };
                    let _ = apply_command(
                        &mut self.doc,
                        Some(&mut self.history),
                        BoardCommand::UpdateElement(Box::new(next)),
                        Some(op_key.clone()),
                        true,
                    );
                    self.rebuild_index();
                }
                self.mode = InteractionMode::DraggingTimelineControl { id, index, op_key };
            }
            InteractionMode::DraggingTimelineMilestone { id, index, op_key } => {
                if let Some(el) = self.doc.element(&id).cloned()
                    && let ElementKind::Timeline {
                        x,
                        y,
                        w,
                        h,
                        fill,
                        points,
                        mut milestones,
                    } = el.kind.clone()
                    && let Some(m) = milestones.get_mut(index)
                {
                    m.t = Some(project_point_to_polyline(&points, world_pt));
                    m.pos = None;
                    let mut next = el;
                    next.kind = ElementKind::Timeline {
                        x,
                        y,
                        w,
                        h,
                        fill,
                        points,
                        milestones,
                    };
                    let _ = apply_command(
                        &mut self.doc,
                        Some(&mut self.history),
                        BoardCommand::UpdateElement(Box::new(next)),
                        Some(op_key.clone()),
                        true,
                    );
                }
                self.mode = InteractionMode::DraggingTimelineMilestone { id, index, op_key };
            }
            InteractionMode::Idle => {}
        }

        effects
    }

    pub fn handle_pointer_up(&mut self, input: PointerInput) -> Vec<ControllerEffect> {
        let mut effects = Vec::new();
        let world_pt = self.camera.screen_to_world(input.screen_pos);
        self.active_guides.clear();
        let mode = std::mem::replace(&mut self.mode, InteractionMode::Idle);

        match mode {
            InteractionMode::Panning { .. } => {
                effects.push(ControllerEffect::ViewportChanged { zoom: self.camera.zoom });
            }
            InteractionMode::Dragging { ids, moved_any, .. } => {
                if moved_any {
                    let writes = ids
                        .iter()
                        .filter_map(|id| self.doc.element(id))
                        .map(|el| crate::engine::whiteboard::codec::encode_element_write(el, true))
                        .collect();
                    effects.push(ControllerEffect::FlushBatch(writes));
                    self.push_history_effect(&mut effects);
                }
            }
            InteractionMode::Resizing { id, changed, .. } | InteractionMode::Rotating { id, changed, .. } => {
                if changed && let Some(el) = self.doc.element(&id) {
                    effects.push(ControllerEffect::FlushBatch(vec![crate::engine::whiteboard::codec::encode_element_write(
                        el, true,
                    )]));
                    self.push_history_effect(&mut effects);
                }
            }
            InteractionMode::DraggingArrowEndpoint { id, .. }
            | InteractionMode::DraggingTimelineControl { id, .. }
            | InteractionMode::DraggingTimelineMilestone { id, .. } => {
                if let Some(el) = self.doc.element(&id) {
                    effects.push(ControllerEffect::FlushBatch(vec![crate::engine::whiteboard::codec::encode_element_write(
                        el, true,
                    )]));
                    self.push_history_effect(&mut effects);
                }
            }
            InteractionMode::DrawingBox { start_world, cur_world } => {
                let raw = Rect2::from_corners(start_world, cur_world);
                let is_click = raw.w < 10.0 && raw.h < 10.0;
                let rect = if is_click {
                    let (dw, dh) = default_box_size(&self.tool);
                    Rect2::new((start_world.x - dw * 0.5).round(), (start_world.y - dh * 0.5).round(), dw, dh)
                } else {
                    Rect2::new(raw.x.round(), raw.y.round(), raw.w.max(48.0).round(), raw.h.max(36.0).round())
                };
                let created_tool = self.tool.clone();
                if let Some(el) = self.build_new_element_in_box(&created_tool, rect) {
                    let created_id = el.id.clone();
                    let res = apply_command(&mut self.doc, Some(&mut self.history), BoardCommand::CreateElements(vec![el]), None, false);
                    self.finish_create(res, &mut effects);
                    if matches!(created_tool, Tool::Text | Tool::Card | Tool::Sticky | Tool::Callout)
                        && let Some(inline) = self.build_inline_target(&created_id, None)
                    {
                        effects.push(ControllerEffect::OpenInlineEditor(inline));
                    }
                }
            }
            InteractionMode::DrawingInk { mut points, mode } => {
                if points.len() == 1 {
                    points.push(StrokePoint::new(world_pt.x + 1.0, world_pt.y + 1.0, input.pressure));
                }
                let simplified = simplify_stroke_points(&points, 1.8);
                let id = self.fresh_id("p");
                let (stroke, width) = if mode == InkMode::Highlighter {
                    ("#e5a93c".to_owned(), (self.active_stroke_width * 4.5).max(14.0))
                } else {
                    (self.active_ink_color.clone(), self.active_stroke_width)
                };
                let el = ElementRecord::new(
                    id,
                    ElementKind::Path {
                        points: simplified,
                        stroke,
                        stroke_width: width,
                        mode,
                    },
                );
                let res = apply_command(&mut self.doc, Some(&mut self.history), BoardCommand::CreateElements(vec![el]), None, false);
                self.finish_create(res, &mut effects);
            }
            InteractionMode::Erasing { erased_ids, .. } => {
                if !erased_ids.is_empty() {
                    let res = apply_command(&mut self.doc, Some(&mut self.history), BoardCommand::DeleteElements(erased_ids), None, true);
                    self.emit_apply_effects(res, &mut effects);
                }
            }
            InteractionMode::ConnectingArrow { from, cur_world, snap_target } => {
                let to = match snap_target {
                    Some((id, side, _)) => ArrowEndpoint::Bound { id, side: Some(side) },
                    None => ArrowEndpoint::Free(cur_world),
                };
                if !is_tiny_free_arrow(&from, &to) {
                    let id = self.fresh_id("a");
                    let el = ElementRecord::new(
                        id,
                        ElementKind::Arrow {
                            from,
                            to,
                            bends: Vec::new(),
                            curve: ArrowCurve::Smooth,
                            style: StrokeStyle::Solid,
                            start_head: ArrowHead::None,
                            end_head: ArrowHead::Arrow,
                            stroke: None,
                            stroke_width: 1.75,
                            label: None,
                        },
                    );
                    let res = apply_command(&mut self.doc, Some(&mut self.history), BoardCommand::CreateElements(vec![el]), None, false);
                    self.finish_create(res, &mut effects);
                }
            }
            InteractionMode::Marquee { .. } | InteractionMode::Idle => {}
        }

        effects
    }

    pub fn handle_wheel(&mut self, screen_pos: Point2, delta_x: f64, delta_y: f64, precise: bool, modifiers: Modifiers) -> Vec<ControllerEffect> {
        if delta_x.abs() < 1e-6 && delta_y.abs() < 1e-6 {
            return Vec::new();
        }
        let mut effects = Vec::new();
        self.user_moved_camera = true;
        self.cancel_follow(&mut effects);
        if modifiers.accel {
            let scaled_dy = if precise { delta_y } else { delta_y * 22.0 };
            let factor = (-scaled_dy * 0.004).exp().clamp(0.75, 1.35);
            self.camera.zoom_at(screen_pos, factor);
        } else {
            let scale = if precise { 1.0 } else { 22.0 };
            self.camera.pan_x -= delta_x * scale;
            self.camera.pan_y -= delta_y * scale;
        }
        effects.push(ControllerEffect::ViewportChanged { zoom: self.camera.zoom });
        effects
    }

    pub fn handle_pinch(&mut self, screen_pos: Point2, delta_fraction: f64) -> Vec<ControllerEffect> {
        if delta_fraction.abs() < 1e-6 {
            return Vec::new();
        }
        let mut effects = Vec::new();
        self.user_moved_camera = true;
        self.cancel_follow(&mut effects);
        self.camera.zoom_at(screen_pos, (1.0 + delta_fraction).clamp(0.5, 1.8));
        effects.push(ControllerEffect::ViewportChanged { zoom: self.camera.zoom });
        effects
    }

    pub fn handle_key_down(&mut self, key: &str, modifiers: Modifiers) -> Vec<ControllerEffect> {
        let lower = key.trim().to_ascii_lowercase();
        if modifiers.accel {
            return match lower.as_str() {
                "z" => self.run_action(if modifiers.shift { BoardAction::Redo } else { BoardAction::Undo }),
                "y" => self.run_action(BoardAction::Redo),
                "d" => self.run_action(BoardAction::DuplicateSelection),
                "c" => self.run_action(BoardAction::CopySelection),
                "x" => self.run_action(BoardAction::CutSelection),
                "v" => self.run_action(BoardAction::Paste),
                "a" => self.run_action(BoardAction::SelectAll),
                "g" => self.run_action(if modifiers.shift {
                    BoardAction::UngroupSelection
                } else {
                    BoardAction::GroupSelection
                }),
                "l" => self.run_action(BoardAction::ToggleLockSelection),
                "0" => self.run_action(BoardAction::ResetZoom),
                "1" => self.run_action(BoardAction::FitToContent),
                "2" => self.run_action(BoardAction::ZoomToSelection),
                _ => Vec::new(),
            };
        }

        match lower.as_str() {
            "backspace" | "delete" => self.run_action(BoardAction::DeleteSelection),
            "escape" => {
                if !matches!(self.tool, Tool::Select) {
                    self.set_tool(Tool::Select)
                } else if !self.selection.is_empty() {
                    self.selection.clear();
                    vec![ControllerEffect::SelectionChanged(Vec::new())]
                } else if self.follow_actor.is_some() {
                    let mut effects = Vec::new();
                    self.cancel_follow(&mut effects);
                    effects
                } else {
                    Vec::new()
                }
            }
            "[" => self.run_action(BoardAction::Reorder(if modifiers.shift { ZOrderDir::Back } else { ZOrderDir::Backward })),
            "]" => self.run_action(BoardAction::Reorder(if modifiers.shift { ZOrderDir::Front } else { ZOrderDir::Forward })),
            "arrowleft" => self.nudge_selection(-nudge_step(modifiers.shift), 0.0),
            "arrowright" => self.nudge_selection(nudge_step(modifiers.shift), 0.0),
            "arrowup" => self.nudge_selection(0.0, -nudge_step(modifiers.shift)),
            "arrowdown" => self.nudge_selection(0.0, nudge_step(modifiers.shift)),
            "v" => self.set_tool(Tool::Select),
            "h" => self.set_tool(Tool::Hand),
            "t" => self.set_tool(Tool::Text),
            "f" => self.set_tool(Tool::Container),
            "c" => self.set_tool(Tool::Card),
            "s" => self.set_tool(Tool::Sticky),
            "r" => self.set_tool(Tool::Shape(ShapeKind::Rect)),
            "o" => self.set_tool(Tool::Shape(ShapeKind::Ellipse)),
            "d" => self.set_tool(Tool::Shape(ShapeKind::Diamond)),
            "p" => self.set_tool(Tool::Pen),
            "b" => self.set_tool(Tool::Highlighter),
            "e" => self.set_tool(Tool::Eraser),
            "a" => self.set_tool(Tool::Arrow),
            "l" => self.set_tool(Tool::Timeline),
            "1" => self.run_action(BoardAction::FitToContent),
            "2" => self.run_action(BoardAction::ZoomToSelection),
            "0" => self.run_action(BoardAction::ResetZoom),
            _ => Vec::new(),
        }
    }

    pub fn commit_inline_edit(&mut self, id: &ElementId, title: String, body: String, milestone_index: Option<usize>) -> Vec<ControllerEffect> {
        let Some(mut el) = self.doc.element(id).cloned() else {
            return Vec::new();
        };
        match &mut el.kind {
            ElementKind::Text { label, .. } => *label = title,
            ElementKind::Shape { title: t, body: b, .. } => {
                *t = title;
                *b = body;
            }
            ElementKind::Container { title: t, .. } => *t = title,
            ElementKind::Arrow { label, .. } => {
                let clean = title.trim().to_owned();
                *label = (!clean.is_empty()).then_some(clean);
            }
            ElementKind::Timeline { milestones, .. } => {
                if let Some(idx) = milestone_index
                    && let Some(m) = milestones.get_mut(idx)
                {
                    m.label = title;
                }
            }
            _ => return Vec::new(),
        }
        let res = apply_command(&mut self.doc, Some(&mut self.history), BoardCommand::UpdateElement(Box::new(el)), None, true);
        let mut effects = Vec::new();
        self.emit_apply_effects(res, &mut effects);
        effects
    }

    pub fn run_action(&mut self, action: BoardAction) -> Vec<ControllerEffect> {
        let mut effects = Vec::new();
        match action {
            BoardAction::Undo => {
                if let Some(entry) = self.history.pop_undo() {
                    let writes = apply_history_step(&mut self.doc, &entry, true, true);
                    self.rebuild_index();
                    effects.push(ControllerEffect::FlushBatch(writes));
                    self.push_history_effect(&mut effects);
                }
            }
            BoardAction::Redo => {
                if let Some(entry) = self.history.pop_redo() {
                    let writes = apply_history_step(&mut self.doc, &entry, false, true);
                    self.rebuild_index();
                    effects.push(ControllerEffect::FlushBatch(writes));
                    self.push_history_effect(&mut effects);
                }
            }
            BoardAction::DeleteSelection => {
                if !self.selection.is_empty() {
                    let res = apply_command(
                        &mut self.doc,
                        Some(&mut self.history),
                        BoardCommand::DeleteElements(self.selection.clone()),
                        None,
                        true,
                    );
                    self.emit_apply_effects(res, &mut effects);
                }
            }
            BoardAction::DuplicateSelection => {
                if !self.selection.is_empty() {
                    let res = apply_command(
                        &mut self.doc,
                        Some(&mut self.history),
                        BoardCommand::DuplicateSelection(self.selection.clone()),
                        None,
                        false,
                    );
                    self.emit_apply_effects(res, &mut effects);
                }
            }
            BoardAction::CopySelection => {
                let sel_set: BTreeSet<ElementId> = self.selection.iter().cloned().collect();
                self.clipboard = self.doc.elements.iter().filter(|e| sel_set.contains(&e.id)).cloned().collect();
            }
            BoardAction::CutSelection => {
                let sel_set: BTreeSet<ElementId> = self.selection.iter().cloned().collect();
                self.clipboard = self.doc.elements.iter().filter(|e| sel_set.contains(&e.id)).cloned().collect();
                if !self.selection.is_empty() {
                    let res = apply_command(
                        &mut self.doc,
                        Some(&mut self.history),
                        BoardCommand::DeleteElements(self.selection.clone()),
                        None,
                        true,
                    );
                    self.emit_apply_effects(res, &mut effects);
                }
            }
            BoardAction::Paste => {
                if !self.clipboard.is_empty() {
                    let mut id_map = BTreeMap::new();
                    let base = self.next_id_seq;
                    for (idx, item) in self.clipboard.iter().enumerate() {
                        id_map.insert(item.id.clone(), ElementId::new(format!("{}-p-{}", item.id, base + idx as u64)));
                    }
                    self.next_id_seq += self.clipboard.len() as u64;
                    let mut items = Vec::with_capacity(self.clipboard.len());
                    for mut item in self.clipboard.clone() {
                        if let Some(nid) = id_map.get(&item.id) {
                            item.id = nid.clone();
                        }
                        item.rev = 0;
                        item.z = 0;
                        item.translate(32.0, 32.0);
                        if let ElementKind::Arrow { from, to, .. } = &mut item.kind {
                            if let ArrowEndpoint::Bound { id, .. } = from
                                && let Some(mapped) = id_map.get(id)
                            {
                                *id = mapped.clone();
                            }
                            if let ArrowEndpoint::Bound { id, .. } = to
                                && let Some(mapped) = id_map.get(id)
                            {
                                *id = mapped.clone();
                            }
                        }
                        items.push(item);
                    }
                    self.clipboard = items.clone();
                    let res = apply_command(&mut self.doc, Some(&mut self.history), BoardCommand::CreateElements(items), None, false);
                    self.emit_apply_effects(res, &mut effects);
                }
            }
            BoardAction::SelectAll => {
                self.selection = self.doc.elements.iter().map(|e| e.id.clone()).collect();
                effects.push(ControllerEffect::SelectionChanged(self.selection.clone()));
            }
            BoardAction::Align(op) => {
                let deltas = compute_align_deltas(&self.doc, &self.selection, op);
                if !deltas.is_empty() {
                    let res = apply_command(
                        &mut self.doc,
                        Some(&mut self.history),
                        BoardCommand::MoveElements {
                            deltas,
                            include_container_children: false,
                        },
                        None,
                        true,
                    );
                    self.emit_apply_effects(res, &mut effects);
                }
            }
            BoardAction::Distribute(axis) => {
                let deltas = compute_distribute_deltas(&self.doc, &self.selection, axis);
                if !deltas.is_empty() {
                    let res = apply_command(
                        &mut self.doc,
                        Some(&mut self.history),
                        BoardCommand::MoveElements {
                            deltas,
                            include_container_children: false,
                        },
                        None,
                        true,
                    );
                    self.emit_apply_effects(res, &mut effects);
                }
            }
            BoardAction::TidyGrid => {
                let deltas = compute_tidy_grid_deltas(&self.doc, &self.selection, 36.0);
                if !deltas.is_empty() {
                    let res = apply_command(
                        &mut self.doc,
                        Some(&mut self.history),
                        BoardCommand::MoveElements {
                            deltas,
                            include_container_children: false,
                        },
                        None,
                        true,
                    );
                    self.emit_apply_effects(res, &mut effects);
                }
            }
            BoardAction::Reorder(dir) => {
                if !self.selection.is_empty() {
                    let res = apply_command(
                        &mut self.doc,
                        Some(&mut self.history),
                        BoardCommand::ReorderZOrder {
                            ids: self.selection.clone(),
                            dir,
                        },
                        None,
                        true,
                    );
                    self.emit_apply_effects(res, &mut effects);
                }
            }
            BoardAction::GroupSelection => {
                let res = apply_command(
                    &mut self.doc,
                    Some(&mut self.history),
                    BoardCommand::GroupSelection(self.selection.clone()),
                    None,
                    true,
                );
                self.emit_apply_effects(res, &mut effects);
            }
            BoardAction::UngroupSelection => {
                let res = apply_command(
                    &mut self.doc,
                    Some(&mut self.history),
                    BoardCommand::UngroupSelection(self.selection.clone()),
                    None,
                    true,
                );
                self.emit_apply_effects(res, &mut effects);
            }
            BoardAction::ToggleLockSelection => {
                let any_unlocked = self.selection.iter().filter_map(|id| self.doc.element(id)).any(|e| !e.locked);
                let res = apply_command(
                    &mut self.doc,
                    Some(&mut self.history),
                    BoardCommand::SetLocked {
                        ids: self.selection.clone(),
                        locked: any_unlocked,
                    },
                    None,
                    true,
                );
                self.emit_apply_effects(res, &mut effects);
            }
            BoardAction::WrapInContainer(title) => {
                let res = apply_command(
                    &mut self.doc,
                    Some(&mut self.history),
                    BoardCommand::WrapInContainer {
                        ids: self.selection.clone(),
                        title,
                    },
                    None,
                    true,
                );
                self.emit_apply_effects(res, &mut effects);
            }
            BoardAction::FitToContent => {
                self.user_moved_camera = true;
                self.cancel_follow(&mut effects);
                if let Some(bounds) = self.doc.content_bounds() {
                    self.camera.fit_bounds(bounds, self.viewport_size.0, self.viewport_size.1, 68.0, 1.0);
                    effects.push(ControllerEffect::ViewportChanged { zoom: self.camera.zoom });
                }
            }
            BoardAction::ZoomToSelection => {
                self.user_moved_camera = true;
                self.cancel_follow(&mut effects);
                let ids = self.selection.clone();
                if let Some(bounds) = self.selection_bbox(&ids) {
                    self.camera.fit_bounds(bounds, self.viewport_size.0, self.viewport_size.1, 72.0, 1.8);
                    effects.push(ControllerEffect::ViewportChanged { zoom: self.camera.zoom });
                }
            }
            BoardAction::ResetZoom => {
                self.user_moved_camera = true;
                self.cancel_follow(&mut effects);
                self.camera.set_zoom_centered(self.viewport_size.0, self.viewport_size.1, 1.0);
                effects.push(ControllerEffect::ViewportChanged { zoom: self.camera.zoom });
            }
            BoardAction::ZoomBy(delta) => {
                self.user_moved_camera = true;
                self.cancel_follow(&mut effects);
                let next = (self.camera.zoom + delta).clamp(0.1, 4.0);
                self.camera.set_zoom_centered(self.viewport_size.0, self.viewport_size.1, next);
                effects.push(ControllerEffect::ViewportChanged { zoom: self.camera.zoom });
            }
            BoardAction::SetGrid(grid) => {
                let mut meta = self.doc.meta.clone();
                meta.grid = grid;
                let res = apply_command(&mut self.doc, Some(&mut self.history), BoardCommand::UpdateMeta(meta), None, false);
                self.emit_apply_effects(res, &mut effects);
                effects.push(ControllerEffect::GridChanged(grid));
            }
            BoardAction::SetFillSelection(fill) => {
                self.active_fill = fill.clone();
                self.mutate_selection(&mut effects, |el| match &mut el.kind {
                    ElementKind::Shape { fill: f, .. }
                    | ElementKind::Container { fill: f, .. }
                    | ElementKind::Timeline { fill: f, .. }
                    | ElementKind::Table { fill: f, .. } => {
                        *f = fill.clone();
                        true
                    }
                    ElementKind::Text { fill: f, .. } => {
                        *f = Some(fill.clone());
                        true
                    }
                    _ => false,
                });
            }
            BoardAction::SetShapeSelection(shape) => {
                self.mutate_selection(&mut effects, |el| match &mut el.kind {
                    ElementKind::Shape { shape: s, .. } => {
                        *s = shape;
                        true
                    }
                    _ => false,
                });
            }
            BoardAction::SetArrowCurveSelection(curve) => {
                self.mutate_selection(&mut effects, |el| match &mut el.kind {
                    ElementKind::Arrow { curve: c, .. } => {
                        *c = curve;
                        true
                    }
                    _ => false,
                });
            }
            BoardAction::SetStrokeStyleSelection(style) => {
                self.mutate_selection(&mut effects, |el| match &mut el.kind {
                    ElementKind::Shape { stroke_style: s, .. } | ElementKind::Arrow { style: s, .. } => {
                        *s = style;
                        true
                    }
                    _ => false,
                });
            }
            BoardAction::SetStickerSelection(sticker) => {
                self.mutate_selection(&mut effects, |el| match &mut el.kind {
                    ElementKind::Shape { sticker: s, sticker_svg, .. } => {
                        *s = sticker.clone();
                        *sticker_svg = None;
                        true
                    }
                    ElementKind::Sticker { sticker: s, .. } => {
                        if let Some(next_s) = &sticker {
                            *s = next_s.clone();
                            true
                        } else {
                            false
                        }
                    }
                    _ => false,
                });
            }
            BoardAction::ApplyTemplate(kind, zh) => {
                self.cancel_follow(&mut effects);
                let copy = if zh { TemplateCopy::zh() } else { TemplateCopy::en() };
                let doc = build_template_doc(kind, &copy);
                let res = apply_command(&mut self.doc, Some(&mut self.history), BoardCommand::ApplyDoc(doc), None, true);
                self.emit_apply_effects(res, &mut effects);
                self.sync_presence_targets(true);
                self.user_moved_camera = false;
                if let Some(bounds) = self.doc.content_bounds() {
                    self.camera.fit_bounds(bounds, self.viewport_size.0, self.viewport_size.1, 68.0, 1.0);
                    effects.push(ControllerEffect::ViewportChanged { zoom: self.camera.zoom });
                }
            }
            BoardAction::FollowActor(actor) => {
                let Some(name) = actor else {
                    self.cancel_follow(&mut effects);
                    return effects;
                };
                let found = self.doc.presences.iter().find(|p| p.id == name || p.name == name).cloned();
                let canonical = found.as_ref().map_or(name, |p| p.id.clone());
                self.follow_actor = Some(canonical.clone());
                effects.push(ControllerEffect::FollowChanged(Some(canonical)));
                if let Some(p) = found {
                    self.user_moved_camera = true;
                    let target = self.compute_follow_camera(&p);
                    if camera_close(self.camera, target) {
                        self.camera_target = None;
                    } else if self.smooth_animations {
                        self.camera_target = Some(target);
                    } else {
                        self.camera = target;
                        self.camera_target = None;
                        effects.push(ControllerEffect::ViewportChanged { zoom: self.camera.zoom });
                    }
                }
            }
            BoardAction::AskOrchestrator => {
                effects.push(ControllerEffect::OpenChatWithSelection(self.selection.clone()));
            }
            BoardAction::Export(fmt) => {
                effects.push(ControllerEffect::RequestExport(fmt));
            }
        }
        effects
    }

    fn nudge_selection(&mut self, dx: f64, dy: f64) -> Vec<ControllerEffect> {
        if self.selection.is_empty() {
            return Vec::new();
        }
        let deltas: Vec<(ElementId, Vec2)> = self.selection.iter().map(|id| (id.clone(), Vec2::new(dx, dy))).collect();
        let res = apply_command(
            &mut self.doc,
            Some(&mut self.history),
            BoardCommand::MoveElements {
                deltas,
                include_container_children: true,
            },
            None,
            true,
        );
        let mut effects = Vec::new();
        self.emit_apply_effects(res, &mut effects);
        effects
    }

    fn mutate_selection(&mut self, effects: &mut Vec<ControllerEffect>, mut f: impl FnMut(&mut ElementRecord) -> bool) {
        let mut writes = Vec::new();
        let mut deltas = Vec::new();
        for id in &self.selection {
            if let Some(el) = self.doc.element_mut(id) {
                let before = el.clone();
                if f(el) {
                    writes.push(crate::engine::whiteboard::codec::encode_element_write(el, true));
                    deltas.push(crate::engine::whiteboard::ops::ElementDelta {
                        id: el.id.clone(),
                        before: Some(before),
                        after: Some(el.clone()),
                    });
                }
            }
        }
        if !deltas.is_empty() {
            self.history.push(crate::engine::whiteboard::ops::HistoryEntry {
                label: "Style".to_owned(),
                coalesce_key: None,
                element_deltas: deltas,
                meta_change: None,
            });
            self.rebuild_index();
            effects.push(ControllerEffect::FlushBatch(writes));
            self.push_history_effect(effects);
        }
    }

    fn finish_create(&mut self, res: crate::engine::whiteboard::ops::ApplyResult, effects: &mut Vec<ControllerEffect>) {
        self.emit_apply_effects(res, effects);
        if !matches!(self.tool, Tool::Pen | Tool::Highlighter | Tool::Eraser | Tool::Select | Tool::Hand) {
            self.tool = Tool::Select;
            effects.push(ControllerEffect::ToolChanged(Tool::Select));
        }
    }

    fn emit_apply_effects(&mut self, res: crate::engine::whiteboard::ops::ApplyResult, effects: &mut Vec<ControllerEffect>) {
        self.rebuild_index();
        if let Some(sel) = res.selected_ids {
            self.selection = sel.clone();
            effects.push(ControllerEffect::SelectionChanged(sel));
        }
        if !res.writes.is_empty() {
            effects.push(ControllerEffect::FlushBatch(res.writes));
        }
        self.push_history_effect(effects);
    }

    fn push_history_effect(&self, effects: &mut Vec<ControllerEffect>) {
        effects.push(ControllerEffect::HistoryChanged {
            can_undo: self.history.can_undo(),
            can_redo: self.history.can_redo(),
        });
    }

    fn update_selection_on_click(&mut self, id: &ElementId, shift: bool, effects: &mut Vec<ControllerEffect>) {
        if shift {
            if let Some(pos) = self.selection.iter().position(|x| x == id) {
                self.selection.remove(pos);
            } else {
                self.selection.push(id.clone());
            }
            effects.push(ControllerEffect::SelectionChanged(self.selection.clone()));
        } else if !self.selection.contains(id) {
            self.selection = vec![id.clone()];
            effects.push(ControllerEffect::SelectionChanged(self.selection.clone()));
        }
    }

    fn expand_group_and_selection(&self) -> Vec<ElementId> {
        let mut group_ids = BTreeSet::new();
        for id in &self.selection {
            if let Some(gid) = self.doc.element(id).and_then(|e| e.group_id.as_ref()) {
                group_ids.insert(gid.clone());
            }
        }
        if group_ids.is_empty() {
            return self.selection.clone();
        }
        let mut set: BTreeSet<ElementId> = self.selection.iter().cloned().collect();
        for el in &self.doc.elements {
            if let Some(gid) = &el.group_id
                && group_ids.contains(gid)
            {
                set.insert(el.id.clone());
            }
        }
        set.into_iter().collect()
    }

    pub fn selection_bbox(&self, ids: &[ElementId]) -> Option<Rect2> {
        let mut iter = ids.iter().filter_map(|id| self.lookup.get(id).copied());
        let first = iter.next()?;
        Some(iter.fold(first, Rect2::union))
    }

    fn build_new_element_in_box(&mut self, tool: &Tool, rect: Rect2) -> Option<ElementRecord> {
        let el = match tool {
            Tool::Text => ElementRecord::new(
                self.fresh_id("t"),
                ElementKind::Text {
                    x: rect.x,
                    y: rect.y,
                    w: rect.w.max(220.0),
                    h: rect.h.max(40.0),
                    variant: TextVariant::Title,
                    label: "Title".to_owned(),
                    highlight: None,
                    icon: None,
                    align: TextAlign::Left,
                    font_size: None,
                    fill: None,
                    color: None,
                },
            ),
            Tool::Callout => ElementRecord::new(
                self.fresh_id("co"),
                ElementKind::Text {
                    x: rect.x,
                    y: rect.y,
                    w: rect.w.max(220.0),
                    h: rect.h.max(48.0),
                    variant: TextVariant::Callout,
                    label: "Key note or blocker".to_owned(),
                    highlight: None,
                    icon: Some("!".to_owned()),
                    align: TextAlign::Left,
                    font_size: None,
                    fill: None,
                    color: None,
                },
            ),
            Tool::Container => ElementRecord::new(
                self.fresh_id("z"),
                ElementKind::Container {
                    x: rect.x,
                    y: rect.y,
                    w: rect.w.max(280.0),
                    h: rect.h.max(180.0),
                    title: "Section".to_owned(),
                    fill: WbFill::Side,
                    stroke: None,
                    collapsed: false,
                },
            ),
            Tool::Card => make_sticky_or_shape(
                self.fresh_id("c").as_str(),
                rect.x,
                rect.y,
                ShapeKind::Card,
                "Milestone",
                "Details",
                self.active_fill.clone(),
            ),
            Tool::Sticky => make_sticky_or_shape(
                self.fresh_id("st").as_str(),
                rect.x,
                rect.y,
                ShapeKind::Sticky,
                "Note",
                "",
                self.active_fill.clone(),
            ),
            Tool::Shape(kind) => ElementRecord::new(
                self.fresh_id("sh"),
                ElementKind::Shape {
                    x: rect.x,
                    y: rect.y,
                    w: rect.w.max(140.0),
                    h: rect.h.max(84.0),
                    shape: *kind,
                    title: "Node".to_owned(),
                    body: String::new(),
                    fill: self.active_fill.clone(),
                    stroke: None,
                    stroke_style: StrokeStyle::Solid,
                    corner_radius: None,
                    sticker: None,
                    sticker_svg: None,
                    badge: None,
                    align: TextAlign::Center,
                },
            ),
            Tool::Timeline => {
                let y = rect.center().y;
                let x0 = rect.x;
                let x1 = rect.right().max(rect.x + 560.0);
                ElementRecord::new(
                    self.fresh_id("tl"),
                    ElementKind::Timeline {
                        x: x0,
                        y: y - 40.0,
                        w: x1 - x0,
                        h: 80.0,
                        fill: WbFill::Peach,
                        points: vec![Point2::new(x0, y + 18.0), Point2::new(x0 + (x1 - x0) * 0.5, y - 4.0), Point2::new(x1, y - 22.0)],
                        milestones: vec![
                            TimelineMilestone {
                                t: Some(0.1),
                                pos: None,
                                label: "Day 1".to_owned(),
                                kind: MilestoneKind::Major,
                                tone: None,
                                caption: None,
                            },
                            TimelineMilestone {
                                t: Some(0.5),
                                pos: None,
                                label: "2".to_owned(),
                                kind: MilestoneKind::Minor,
                                tone: None,
                                caption: Some("Milestone".to_owned()),
                            },
                            TimelineMilestone {
                                t: Some(0.9),
                                pos: None,
                                label: "Day 7".to_owned(),
                                kind: MilestoneKind::Major,
                                tone: None,
                                caption: None,
                            },
                        ],
                    },
                )
            }
            Tool::Table => ElementRecord::new(
                self.fresh_id("tb"),
                ElementKind::Table {
                    x: rect.x,
                    y: rect.y,
                    w: rect.w.max(360.0),
                    h: rect.h.max(150.0),
                    headers: vec!["Item".to_owned(), "Status".to_owned(), "Notes".to_owned()],
                    rows: vec![
                        vec!["Step 1".to_owned(), "Ready".to_owned(), "Scoped".to_owned()],
                        vec!["Step 2".to_owned(), "Active".to_owned(), "In review".to_owned()],
                    ],
                    fill: WbFill::Default,
                },
            ),
            _ => return None,
        };
        Some(el)
    }

    fn build_inline_target(&self, id: &ElementId, milestone_index: Option<usize>) -> Option<InlineEditTarget> {
        let el = self.doc.element(id)?;
        let world_rect = match &el.kind {
            ElementKind::Arrow { from, to, bends, curve, .. } => {
                let g = route_arrow(from, to, bends, *curve, &self.lookup)?;
                Rect2::new(g.label_pos.x - 80.0, g.label_pos.y - 16.0, 160.0, 32.0)
            }
            ElementKind::Timeline { points, milestones, .. } => {
                let idx = milestone_index?;
                let m = milestones.get(idx)?;
                let pt = m
                    .pos
                    .unwrap_or_else(|| crate::engine::whiteboard::geometry::sample_polyline(points, m.t.unwrap_or(0.5)));
                Rect2::new(pt.x - 70.0, pt.y - 18.0, 140.0, 36.0)
            }
            _ => self.lookup.get(id).copied()?,
        };
        let tl = self.camera.world_to_screen(Point2::new(world_rect.x, world_rect.y));
        let br = self.camera.world_to_screen(Point2::new(world_rect.right(), world_rect.bottom()));
        let screen_rect = Rect2::from_corners(tl, br);
        let (title, body) = match &el.kind {
            ElementKind::Text { label, .. } => (label.clone(), String::new()),
            ElementKind::Shape { title, body, .. } => (title.clone(), body.clone()),
            ElementKind::Container { title, .. } => (title.clone(), String::new()),
            ElementKind::Arrow { label, .. } => (label.clone().unwrap_or_default(), String::new()),
            ElementKind::Timeline { milestones, .. } => {
                let idx = milestone_index?;
                let m = milestones.get(idx)?;
                (m.label.clone(), m.caption.clone().unwrap_or_default())
            }
            _ => return None,
        };
        Some(InlineEditTarget {
            id: id.clone(),
            screen_rect,
            title,
            body,
            milestone_index,
        })
    }
}

fn hit_element_id(hit: &HitTarget) -> Option<ElementId> {
    match hit {
        HitTarget::RotateHandle(id)
        | HitTarget::ResizeHandle { id, .. }
        | HitTarget::AnchorPort { id, .. }
        | HitTarget::ArrowEndpoint { id, .. }
        | HitTarget::ArrowBend { id, .. }
        | HitTarget::TimelineControl { id, .. }
        | HitTarget::TimelineMilestone { id, .. }
        | HitTarget::ContainerHeader(id)
        | HitTarget::Element(id) => Some(id.clone()),
        HitTarget::Background => None,
    }
}

fn default_box_size(tool: &Tool) -> (f64, f64) {
    match tool {
        Tool::Text => (320.0, 44.0),
        Tool::Callout => (220.0, 52.0),
        Tool::Container => (420.0, 260.0),
        Tool::Card | Tool::Sticky => (184.0, 114.0),
        Tool::Timeline => (640.0, 88.0),
        Tool::Table => (360.0, 160.0),
        _ => (160.0, 92.0),
    }
}

fn is_tiny_free_arrow(from: &ArrowEndpoint, to: &ArrowEndpoint) -> bool {
    matches!((from, to), (ArrowEndpoint::Free(a), ArrowEndpoint::Free(b)) if a.distance(*b) < 8.0)
}

fn compute_resized_rect(start: Rect2, handle: ResizeHandle8, delta: Vec2, keep_aspect: bool, from_center: bool) -> Rect2 {
    let min_side = 28.0;
    let mut x = start.x;
    let mut y = start.y;
    let mut r = start.right();
    let mut b = start.bottom();

    match handle {
        ResizeHandle8::Nw => {
            x += delta.x;
            y += delta.y;
        }
        ResizeHandle8::N => y += delta.y,
        ResizeHandle8::Ne => {
            r += delta.x;
            y += delta.y;
        }
        ResizeHandle8::E => r += delta.x,
        ResizeHandle8::Se => {
            r += delta.x;
            b += delta.y;
        }
        ResizeHandle8::S => b += delta.y,
        ResizeHandle8::Sw => {
            x += delta.x;
            b += delta.y;
        }
        ResizeHandle8::W => x += delta.x,
    }

    if from_center {
        let cx = start.center().x;
        let cy = start.center().y;
        let half_w = match handle {
            ResizeHandle8::N | ResizeHandle8::S => start.w * 0.5,
            ResizeHandle8::Nw | ResizeHandle8::Sw | ResizeHandle8::W => (cx - x).abs(),
            ResizeHandle8::Ne | ResizeHandle8::Se | ResizeHandle8::E => (r - cx).abs(),
        }
        .max(min_side * 0.5);
        let half_h = match handle {
            ResizeHandle8::E | ResizeHandle8::W => start.h * 0.5,
            ResizeHandle8::Nw | ResizeHandle8::N | ResizeHandle8::Ne => (cy - y).abs(),
            ResizeHandle8::Sw | ResizeHandle8::S | ResizeHandle8::Se => (b - cy).abs(),
        }
        .max(min_side * 0.5);
        x = cx - half_w;
        r = cx + half_w;
        y = cy - half_h;
        b = cy + half_h;
    }

    if (r - x) < min_side {
        if matches!(handle, ResizeHandle8::Nw | ResizeHandle8::W | ResizeHandle8::Sw) {
            x = r - min_side;
        } else {
            r = x + min_side;
        }
    }
    if (b - y) < min_side {
        if matches!(handle, ResizeHandle8::Nw | ResizeHandle8::N | ResizeHandle8::Ne) {
            y = b - min_side;
        } else {
            b = y + min_side;
        }
    }

    let mut out = Rect2::new(x, y, r - x, b - y);
    if keep_aspect && start.h > 0.0 && start.w > 0.0 && matches!(handle, ResizeHandle8::Nw | ResizeHandle8::Ne | ResizeHandle8::Se | ResizeHandle8::Sw) {
        let aspect = start.w / start.h;
        if out.w / out.h > aspect {
            out.w = out.h * aspect;
        } else {
            out.h = out.w / aspect;
        }
        if from_center {
            let c = start.center();
            out.x = c.x - out.w * 0.5;
            out.y = c.y - out.h * 0.5;
        } else {
            if matches!(handle, ResizeHandle8::Nw | ResizeHandle8::Sw) {
                out.x = r - out.w;
            }
            if matches!(handle, ResizeHandle8::Nw | ResizeHandle8::Ne) {
                out.y = b - out.h;
            }
        }
    }
    out
}

pub fn live_anchor_point(ep: &ArrowEndpoint, lookup: &HashMap<ElementId, Rect2>) -> Option<Point2> {
    match ep {
        ArrowEndpoint::Free(p) => Some(*p),
        ArrowEndpoint::Bound { id, side } => lookup.get(id).map(|r| anchor_point(*r, side.unwrap_or(AnchorSide::E))),
    }
}

const POSE_EPS: f64 = 0.4;
const ZOOM_EPS: f64 = 0.002;

fn lerp_f64(a: f64, b: f64, alpha: f64) -> f64 {
    a + (b - a) * alpha
}

fn opt_f64_close(a: Option<f64>, b: Option<f64>, eps: f64) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => (x - y).abs() <= eps,
        _ => false,
    }
}

fn lerp_opt_f64(a: Option<f64>, b: Option<f64>, alpha: f64) -> Option<f64> {
    match (a, b) {
        (Some(x), Some(y)) => Some(lerp_f64(x, y, alpha)),
        (_, target) => target,
    }
}

fn viewport_close(a: Option<PresenceViewport>, b: Option<PresenceViewport>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(va), Some(vb)) => {
            (va.x - vb.x).abs() <= POSE_EPS
                && (va.y - vb.y).abs() <= POSE_EPS
                && (va.w - vb.w).abs() <= POSE_EPS
                && (va.h - vb.h).abs() <= POSE_EPS
                && opt_f64_close(va.zoom, vb.zoom, ZOOM_EPS)
        }
        _ => false,
    }
}

fn lerp_viewport(a: Option<PresenceViewport>, b: Option<PresenceViewport>, alpha: f64) -> Option<PresenceViewport> {
    match (a, b) {
        (Some(va), Some(vb)) => Some(PresenceViewport {
            x: lerp_f64(va.x, vb.x, alpha),
            y: lerp_f64(va.y, vb.y, alpha),
            w: lerp_f64(va.w, vb.w, alpha),
            h: lerp_f64(va.h, vb.h, alpha),
            zoom: lerp_opt_f64(va.zoom, vb.zoom, alpha),
        }),
        (_, target) => target,
    }
}

fn pose_close(a: AnimatedPresencePose, b: AnimatedPresencePose) -> bool {
    (a.x - b.x).abs() <= POSE_EPS
        && (a.y - b.y).abs() <= POSE_EPS
        && opt_f64_close(a.w, b.w, POSE_EPS)
        && opt_f64_close(a.h, b.h, POSE_EPS)
        && viewport_close(a.viewport, b.viewport)
}

fn lerp_pose(a: AnimatedPresencePose, b: AnimatedPresencePose, alpha: f64) -> AnimatedPresencePose {
    AnimatedPresencePose {
        x: lerp_f64(a.x, b.x, alpha),
        y: lerp_f64(a.y, b.y, alpha),
        w: lerp_opt_f64(a.w, b.w, alpha),
        h: lerp_opt_f64(a.h, b.h, alpha),
        viewport: lerp_viewport(a.viewport, b.viewport, alpha),
    }
}

fn camera_close(a: Camera, b: Camera) -> bool {
    (a.pan_x - b.pan_x).abs() <= 0.5 && (a.pan_y - b.pan_y).abs() <= 0.5 && (a.zoom - b.zoom).abs() <= ZOOM_EPS
}

fn lerp_camera(a: Camera, b: Camera, alpha: f64) -> Camera {
    Camera {
        pan_x: lerp_f64(a.pan_x, b.pan_x, alpha),
        pan_y: lerp_f64(a.pan_y, b.pan_y, alpha),
        zoom: lerp_f64(a.zoom, b.zoom, alpha).clamp(MIN_ZOOM, MAX_ZOOM),
    }
}
