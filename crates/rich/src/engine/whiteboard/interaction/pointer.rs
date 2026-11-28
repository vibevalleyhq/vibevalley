use std::collections::HashMap;

use crate::engine::whiteboard::codec::encode_element_write;
use crate::engine::whiteboard::geometry::{anchor_point, project_point_to_polyline};
use crate::engine::whiteboard::hit::{HitTarget, ResizeHandle8, hit_test, marquee_select, snap_anchor_endpoint};
use crate::engine::whiteboard::ink::{simplify_stroke_points, strokes_hit_by_eraser};
use crate::engine::whiteboard::model::{
    AnchorSide, ArrowCurve, ArrowEndpoint, ArrowHead, ElementId, ElementKind, ElementRecord, InkMode, Point2, Rect2, ShapeKind, StrokePoint, StrokeStyle, Vec2,
};
use crate::engine::whiteboard::ops::{BoardCommand, ZOrderDir, apply_command};
use crate::engine::whiteboard::snap::{compute_move_snap, compute_resize_snap, nudge_step};

use super::WhiteboardController;
use super::types::{BoardAction, ControllerEffect, InteractionMode, Modifiers, PointerButton, PointerInput, Tool};

impl WhiteboardController {
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
                        .map(|el| encode_element_write(el, true))
                        .collect();
                    effects.push(ControllerEffect::FlushBatch(writes));
                    self.push_history_effect(&mut effects);
                }
            }
            InteractionMode::Resizing { id, changed, .. } | InteractionMode::Rotating { id, changed, .. } => {
                if changed && let Some(el) = self.doc.element(&id) {
                    effects.push(ControllerEffect::FlushBatch(vec![encode_element_write(el, true)]));
                    self.push_history_effect(&mut effects);
                }
            }
            InteractionMode::DraggingArrowEndpoint { id, .. }
            | InteractionMode::DraggingTimelineControl { id, .. }
            | InteractionMode::DraggingTimelineMilestone { id, .. } => {
                if let Some(el) = self.doc.element(&id) {
                    effects.push(ControllerEffect::FlushBatch(vec![encode_element_write(el, true)]));
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
