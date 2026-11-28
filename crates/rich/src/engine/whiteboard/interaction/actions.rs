use std::collections::{BTreeMap, BTreeSet};

use crate::engine::whiteboard::codec::encode_element_write;
use crate::engine::whiteboard::geometry::{route_arrow, sample_polyline};
use crate::engine::whiteboard::model::{
    ArrowEndpoint, ElementId, ElementKind, ElementRecord, MilestoneKind, Point2, Rect2, ShapeKind, StrokeStyle, TextAlign, TextVariant, TimelineMilestone,
    Vec2, WbFill,
};
use crate::engine::whiteboard::ops::{ApplyResult, BoardCommand, ElementDelta, HistoryEntry, apply_command, apply_history_step, make_sticky_or_shape};
use crate::engine::whiteboard::snap::{compute_align_deltas, compute_distribute_deltas, compute_tidy_grid_deltas};
use crate::engine::whiteboard::templates::{TemplateCopy, build_template_doc};

use super::WhiteboardController;
use super::animation::camera_close;
use super::types::{BoardAction, ControllerEffect, InlineEditTarget, Tool};

impl WhiteboardController {
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

    pub(super) fn nudge_selection(&mut self, dx: f64, dy: f64) -> Vec<ControllerEffect> {
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
                    writes.push(encode_element_write(el, true));
                    deltas.push(ElementDelta {
                        id: el.id.clone(),
                        before: Some(before),
                        after: Some(el.clone()),
                    });
                }
            }
        }
        if !deltas.is_empty() {
            self.history.push(HistoryEntry {
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

    pub(super) fn finish_create(&mut self, res: ApplyResult, effects: &mut Vec<ControllerEffect>) {
        self.emit_apply_effects(res, effects);
        if !matches!(self.tool, Tool::Pen | Tool::Highlighter | Tool::Eraser | Tool::Select | Tool::Hand) {
            self.tool = Tool::Select;
            effects.push(ControllerEffect::ToolChanged(Tool::Select));
        }
    }

    pub(super) fn emit_apply_effects(&mut self, res: ApplyResult, effects: &mut Vec<ControllerEffect>) {
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

    pub(super) fn push_history_effect(&self, effects: &mut Vec<ControllerEffect>) {
        effects.push(ControllerEffect::HistoryChanged {
            can_undo: self.history.can_undo(),
            can_redo: self.history.can_redo(),
        });
    }

    pub(super) fn update_selection_on_click(&mut self, id: &ElementId, shift: bool, effects: &mut Vec<ControllerEffect>) {
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

    pub(super) fn expand_group_and_selection(&self) -> Vec<ElementId> {
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

    pub(super) fn build_new_element_in_box(&mut self, tool: &Tool, rect: Rect2) -> Option<ElementRecord> {
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

    pub(super) fn build_inline_target(&self, id: &ElementId, milestone_index: Option<usize>) -> Option<InlineEditTarget> {
        let el = self.doc.element(id)?;
        let world_rect = match &el.kind {
            ElementKind::Arrow { from, to, bends, curve, .. } => {
                let g = route_arrow(from, to, bends, *curve, &self.lookup)?;
                Rect2::new(g.label_pos.x - 80.0, g.label_pos.y - 16.0, 160.0, 32.0)
            }
            ElementKind::Timeline { points, milestones, .. } => {
                let idx = milestone_index?;
                let m = milestones.get(idx)?;
                let pt = m.pos.unwrap_or_else(|| sample_polyline(points, m.t.unwrap_or(0.5)));
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
