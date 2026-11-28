use std::collections::{BTreeSet, HashMap};

use nsh_core::canvas::{CanvasTextAlign, CanvasTextBaseline, Drawing};
use nsh_core::prelude::{Bounds, Hsla, Painter, Points, Size, point, px, radians, size};

use crate::engine::whiteboard::geometry::{Camera, anchor_point, rotate_point, route_arrow};
use crate::engine::whiteboard::hit::{ResizeHandle8, anchor_port_pos, can_host_anchor_port, container_header_rect, rotate_handle_pos};
use crate::engine::whiteboard::interaction::{AnimatedPresencePose, InteractionMode, WhiteboardController, live_anchor_point};
use crate::engine::whiteboard::layout::measure_text_span;
use crate::engine::whiteboard::model::{AnchorSide, BoardDoc, ElementId, ElementKind, InkMode, Point2, Presence, PresenceKind, Rect2};
use crate::engine::whiteboard::snap::{SnapAxis, SnapGuide};

use super::cards::paint_ink_stroke;
use super::palette::WhiteboardPalette;
use super::primitives::{fill_and_stroke_circle, fill_and_stroke_rect, fill_and_stroke_round_rect, fill_round_rect_shadowed};

pub fn paint_overlay_layer(controller: &WhiteboardController, viewport_size: (f32, f32), dark: bool) -> Drawing {
    paint_overlay_layer_painter(controller, viewport_size, dark).finish()
}

pub fn paint_overlay_layer_painter(controller: &WhiteboardController, viewport_size: (f32, f32), dark: bool) -> Painter {
    paint_overlay_layer_painter_filtered(controller, viewport_size, dark, &BTreeSet::new())
}

pub fn paint_overlay_layer_painter_filtered(
    controller: &WhiteboardController,
    viewport_size: (f32, f32),
    dark: bool,
    dismissed_notes: &BTreeSet<String>,
) -> Painter {
    let pal = WhiteboardPalette::for_mode(dark);
    let zoom = controller.camera.zoom;
    let painter = Painter::new()
        .save()
        .translate(controller.camera.pan_x as f32, controller.camera.pan_y as f32)
        .scale(zoom as f32, zoom as f32);
    let painter = paint_overlay_world_contents(painter, controller, &pal, zoom, dismissed_notes, false).restore();
    let _ = viewport_size;
    painter
}

/// Paints world-space interactive chrome (presence viewports/regions/cursors, drag previews,
/// anchor ports, selection handles, and snap guides) into a painter already transformed to world space.
pub(super) fn paint_overlay_world_contents(
    mut painter: Painter,
    controller: &WhiteboardController,
    pal: &WhiteboardPalette,
    zoom: f64,
    dismissed_notes: &BTreeSet<String>,
    fast_shadows: bool,
) -> Painter {
    // Remote collaborator viewport outlines, highlight/claim boxes, and element claim outlines.
    for p in &controller.doc.presences {
        let p_color = pal.resolve_presence_color(p);
        let pose = controller.displayed_pose(p);
        let is_followed = controller.follow_actor.as_deref() == Some(p.id.as_str());

        if let Some(vp) = pose.viewport
            && let Some(r) = vp.rect()
        {
            painter = paint_presence_viewport(painter, r, p, p_color, zoom as f32, is_followed, pal);
        }

        if let Some(r) = pose.region_rect(p.kind) {
            painter = paint_presence_region(painter, r, p, p_color, zoom as f32, pal, fast_shadows);
        }

        for sel_id in &p.selected_ids {
            if let Some(r) = controller.lookup.get(sel_id) {
                let b = Bounds::new(point(px(r.x as f32), px(r.y as f32)), size(px(r.w as f32), px(r.h as f32)));
                painter = painter
                    .save()
                    .stroke_color(p_color)
                    .line_width(2.0 / zoom as f32)
                    .line_dash(&[px(4.0 / zoom as f32), px(3.0 / zoom as f32)])
                    .begin_path()
                    .round_rect(b, px(10.0))
                    .stroke()
                    .restore();
            }
        }
    }

    // Active drag / create / draw previews.
    match &controller.mode {
        InteractionMode::DrawingBox { start_world, cur_world } => {
            let r = Rect2::from_corners(*start_world, *cur_world);
            let b = Bounds::new(point(px(r.x as f32), px(r.y as f32)), size(px(r.w as f32), px(r.h as f32)));
            painter = fill_and_stroke_round_rect(painter, b, 8.0, pal.selection_soft, pal.selection, 1.6 / zoom as f32);
        }
        InteractionMode::DrawingInk { points, mode } => {
            let width = if *mode == InkMode::Highlighter {
                (controller.active_stroke_width * 4.5).max(14.0)
            } else {
                controller.active_stroke_width
            };
            let stroke = if *mode == InkMode::Highlighter {
                "#e5a93c"
            } else {
                controller.active_ink_color.as_str()
            };
            painter = paint_ink_stroke(painter, points, stroke, width, *mode, pal);
        }
        InteractionMode::ConnectingArrow { from, cur_world, snap_target } => {
            if let Some(start) = live_anchor_point(from, &controller.lookup) {
                let end = snap_target.as_ref().map_or(*cur_world, |(_, _, p)| *p);
                painter = painter
                    .save()
                    .stroke_color(pal.selection)
                    .line_width(2.0 / zoom as f32)
                    .line_dash(&[px(5.0 / zoom as f32), px(4.0 / zoom as f32)])
                    .begin_path()
                    .move_to(start.x as f32, start.y as f32)
                    .line_to(end.x as f32, end.y as f32)
                    .stroke()
                    .restore();
            }
            if let Some((_, _, snap_pt)) = snap_target {
                let pr = (7.0 / zoom) as f32;
                painter = painter
                    .begin_path()
                    .fill_color(pal.selection)
                    .ellipse(
                        point(px(snap_pt.x as f32), px(snap_pt.y as f32)),
                        size(px(pr), px(pr)),
                        radians(0.0),
                        radians(0.0),
                        radians(std::f32::consts::TAU),
                        false,
                    )
                    .fill();
            }
        }
        InteractionMode::Marquee { start_world, cur_world } => {
            let r = Rect2::from_corners(*start_world, *cur_world);
            let intersect_mode = cur_world.x < start_world.x;
            let b = Bounds::new(point(px(r.x as f32), px(r.y as f32)), size(px(r.w as f32), px(r.h as f32)));
            painter = painter
                .save()
                .begin_path()
                .fill_color(pal.selection_soft)
                .rect(b)
                .fill()
                .stroke_color(pal.selection)
                .line_width(1.3 / zoom as f32);
            if intersect_mode {
                painter = painter.line_dash(&[px(5.0 / zoom as f32), px(4.0 / zoom as f32)]);
            }
            painter = painter.begin_path().rect(b).stroke().restore();
        }
        InteractionMode::Erasing { points, .. } => {
            if let Some(last) = points.last() {
                let r = (14.0 / zoom) as f32;
                painter = painter
                    .begin_path()
                    .stroke_color(pal.snap_guide)
                    .line_width(1.5 / zoom as f32)
                    .ellipse(
                        point(px(last.x as f32), px(last.y as f32)),
                        size(px(r), px(r)),
                        radians(0.0),
                        radians(0.0),
                        radians(std::f32::consts::TAU),
                        false,
                    )
                    .stroke();
            }
        }
        InteractionMode::Idle
        | InteractionMode::Panning { .. }
        | InteractionMode::Dragging { .. }
        | InteractionMode::Resizing { .. }
        | InteractionMode::Rotating { .. }
        | InteractionMode::DraggingArrowEndpoint { .. }
        | InteractionMode::DraggingTimelineControl { .. }
        | InteractionMode::DraggingTimelineMilestone { .. } => {}
    }

    // Hovered / Selected N/E/S/W anchor connection ports.
    for cand_id in controller.selection.iter().chain(controller.hovered.as_ref()) {
        let Some(el) = controller.doc.element(cand_id) else {
            continue;
        };
        if !can_host_anchor_port(&el.kind) {
            continue;
        }
        let Some(&rect) = controller.lookup.get(&el.id) else {
            continue;
        };
        let port_offset = 14.0 / zoom;
        let port_r = (4.2 / zoom) as f32;
        for side in AnchorSide::ALL {
            let p = rotate_point(anchor_port_pos(rect, side, port_offset), rect.center(), el.rotation_deg);
            painter = fill_and_stroke_circle(painter, p.x as f32, p.y as f32, port_r, pal.page, pal.selection, 1.4 / zoom as f32);
        }
    }

    // Selection frame + 8 resize handles + top rotation handle.
    if controller.selection.len() == 1
        && let Some(id) = controller.selection.first()
        && let Some(el) = controller.doc.element(id)
    {
        if let ElementKind::Arrow { from, to, bends, curve, .. } = &el.kind {
            if let Some(geom) = route_arrow(from, to, bends, *curve, &controller.lookup) {
                let hr = (5.0 / zoom) as f32;
                for pt in [geom.start, geom.end].into_iter().chain(bends.iter().copied()) {
                    painter = fill_and_stroke_circle(painter, pt.x as f32, pt.y as f32, hr, pal.page, pal.selection, 1.6 / zoom as f32);
                }
            }
        } else if let Some(&rect) = controller.lookup.get(id) {
            let b = Bounds::new(point(px(rect.x as f32), px(rect.y as f32)), size(px(rect.w as f32), px(rect.h as f32)));
            painter = painter
                .save()
                .translate(rect.center().x as f32, rect.center().y as f32)
                .rotate(radians(el.rotation_deg.to_radians() as f32))
                .translate(-rect.center().x as f32, -rect.center().y as f32)
                .stroke_color(pal.selection)
                .line_width(1.5 / zoom as f32)
                .begin_path()
                .rect(b)
                .stroke();

            let hs = (7.0 / zoom) as f32;
            for h in ResizeHandle8::ALL {
                let hp = h.position_on(rect);
                let hb = Bounds::new(point(px(hp.x as f32 - hs * 0.5), px(hp.y as f32 - hs * 0.5)), size(px(hs), px(hs)));
                painter = fill_and_stroke_rect(painter, hb, pal.page, pal.selection, 1.4 / zoom as f32);
            }

            let top_mid = Point2::new(rect.x + rect.w * 0.5, rect.y);
            let rot_pt = rotate_handle_pos(rect, 0.0, 26.0 / zoom);
            let rr = (4.5 / zoom) as f32;
            painter = painter
                .begin_path()
                .stroke_color(pal.selection)
                .line_width(1.3 / zoom as f32)
                .move_to(top_mid.x as f32, top_mid.y as f32)
                .line_to(rot_pt.x as f32, rot_pt.y as f32)
                .stroke();
            painter = fill_and_stroke_circle(painter, rot_pt.x as f32, rot_pt.y as f32, rr, pal.page, pal.selection, 1.3 / zoom as f32).restore();
        }
    } else if controller.selection.len() > 1
        && let Some(group_rect) = controller.selection_bbox(&controller.selection)
    {
        let gb = Bounds::new(
            point(px(group_rect.x as f32), px(group_rect.y as f32)),
            size(px(group_rect.w as f32), px(group_rect.h as f32)),
        );
        painter = painter.stroke_color(pal.selection).line_width(1.5 / zoom as f32).begin_path().rect(gb).stroke();
    }

    // Active snap alignment & equal-spacing guides.
    for guide in &controller.active_guides {
        match guide {
            SnapGuide::Align {
                axis,
                coord,
                span_min,
                span_max,
            } => {
                painter = painter.stroke_color(pal.snap_guide).line_width(1.2 / zoom as f32).begin_path();
                match axis {
                    SnapAxis::X => {
                        painter = painter.move_to(*coord as f32, *span_min as f32).line_to(*coord as f32, *span_max as f32);
                    }
                    SnapAxis::Y => {
                        painter = painter.move_to(*span_min as f32, *coord as f32).line_to(*span_max as f32, *coord as f32);
                    }
                }
                painter = painter.stroke();
            }
            SnapGuide::Spacing {
                axis,
                cross_coord,
                start,
                end,
                gap,
            } => {
                painter = painter.stroke_color(pal.snap_guide).line_width(1.3 / zoom as f32).begin_path();
                let (lx, ly) = match axis {
                    SnapAxis::X => {
                        painter = painter.move_to(*start as f32, *cross_coord as f32).line_to(*end as f32, *cross_coord as f32);
                        ((start + end) * 0.5, *cross_coord)
                    }
                    SnapAxis::Y => {
                        painter = painter.move_to(*cross_coord as f32, *start as f32).line_to(*cross_coord as f32, *end as f32);
                        (*cross_coord, (start + end) * 0.5)
                    }
                };
                painter = painter.stroke();
                let txt = format!("{:.0}", gap);
                painter = painter
                    .fill_color(pal.snap_guide)
                    .font("600 10.5px 'PingFang SC', system-ui, sans-serif")
                    .text_align(CanvasTextAlign::Center)
                    .text_baseline(CanvasTextBaseline::Bottom)
                    .fill_text(&txt, lx as f32, (ly - 3.0) as f32);
            }
        }
    }

    // Collaborator cursors (using smoothly interpolated poses).
    painter = paint_presences_for_controller(painter, controller, pal, zoom as f32, dismissed_notes, fast_shadows);

    let _ = container_header_rect;
    let _ = Size::<Points>::default();
    let _ = anchor_point;
    painter
}

fn paint_presence_viewport(mut painter: Painter, rect: Rect2, p: &Presence, color: Hsla, zoom: f32, is_followed: bool, pal: &WhiteboardPalette) -> Painter {
    let inv = 1.0 / zoom.max(0.25);
    let b = Bounds::new(point(px(rect.x as f32), px(rect.y as f32)), size(px(rect.w as f32), px(rect.h as f32)));
    let fill_alpha = if is_followed { 0.045 } else { 0.018 };
    let stroke_alpha = if is_followed { 0.56 } else { 0.28 };
    let stroke_w = (if is_followed { 1.8 } else { 1.25 }) * inv;
    let radius = 8.0 * inv;
    painter = painter
        .save()
        .begin_path()
        .fill_color(Hsla { a: fill_alpha, ..color })
        .round_rect(b, px(radius))
        .fill()
        .stroke_color(Hsla { a: stroke_alpha, ..color })
        .line_width(stroke_w)
        .line_dash(&[px(8.0 * inv), px(6.0 * inv)])
        .begin_path()
        .round_rect(b, px(radius))
        .stroke()
        .restore();

    let tag_text = match (p.kind == PresenceKind::Viewport, p.status.as_deref().map(str::trim).filter(|s| !s.is_empty())) {
        (true, Some(st)) => format!("{} · {st}", p.name),
        _ => p.name.clone(),
    };
    let pill_w = (measure_text_span(&tag_text, 10.5, true) + 14.0).max(36.0) as f32;
    let pill_h = 18.0_f32;
    let chip = Bounds::new(point(px(6.0), px(-pill_h - 4.0)), size(px(pill_w), px(pill_h)));
    painter
        .save()
        .translate(rect.x as f32, rect.y as f32)
        .scale(inv, inv)
        .global_alpha(if is_followed { 0.92 } else { 0.68 })
        .begin_path()
        .fill_color(color)
        .round_rect(chip, px(9.0))
        .fill()
        .fill_color(pal.pill_ink)
        .font("600 10.5px 'PingFang SC', system-ui, sans-serif")
        .text_align(CanvasTextAlign::Center)
        .text_baseline(CanvasTextBaseline::Middle)
        .fill_text(&tag_text, 6.0 + pill_w * 0.5, -pill_h * 0.5 - 4.0)
        .restore()
}

fn paint_presence_region(mut painter: Painter, rect: Rect2, p: &Presence, color: Hsla, zoom: f32, pal: &WhiteboardPalette, fast_shadows: bool) -> Painter {
    let inv = 1.0 / zoom.max(0.25);
    let b = Bounds::new(point(px(rect.x as f32), px(rect.y as f32)), size(px(rect.w as f32), px(rect.h as f32)));
    let tint = Hsla { a: 0.09, ..color };
    painter = painter
        .save()
        .begin_path()
        .fill_color(tint)
        .round_rect(b, px(12.0))
        .fill()
        .stroke_color(color)
        .line_width(1.8 * inv)
        .line_dash(&[px(6.0 * inv), px(4.0 * inv)])
        .begin_path()
        .round_rect(b, px(12.0))
        .stroke()
        .restore();

    let status_opt = p.status.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let badge = match status_opt {
        Some(st) => format!("{} · {st}", p.name),
        None => p.name.clone(),
    };
    let bw = (measure_text_span(&badge, 11.0, true) + 18.0).max(48.0) as f32;
    let bh = 22.0_f32;
    let chip = Bounds::new(point(px(10.0), px(-bh * 0.5)), size(px(bw), px(bh)));
    painter = painter.save().translate(rect.x as f32, rect.y as f32).scale(inv, inv);
    painter = fill_round_rect_shadowed(painter, chip, 11.0, color, pal, fast_shadows, 4.0, 1.5);
    painter
        .fill_color(pal.pill_ink)
        .font("600 11px 'PingFang SC', system-ui, sans-serif")
        .text_align(CanvasTextAlign::Center)
        .text_baseline(CanvasTextBaseline::Middle)
        .fill_text(&badge, 10.0 + bw * 0.5, 0.0)
        .restore()
}

fn paint_presences_for_controller(
    mut painter: Painter,
    controller: &WhiteboardController,
    pal: &WhiteboardPalette,
    zoom: f32,
    dismissed_notes: &BTreeSet<String>,
    fast_shadows: bool,
) -> Painter {
    for p in &controller.doc.presences {
        let pose = controller.displayed_pose(p);
        painter = paint_presence_cursor(painter, p, pose, pal, zoom, dismissed_notes, fast_shadows);
    }
    painter
}

pub fn paint_presences_into_painter(mut painter: Painter, doc: &BoardDoc, pal: &WhiteboardPalette, zoom: f32, dismissed_notes: &BTreeSet<String>) -> Painter {
    for p in &doc.presences {
        let color = pal.resolve_presence_color(p);
        let pose = AnimatedPresencePose::from_presence(p);
        if let Some(vp) = pose.viewport
            && let Some(r) = vp.rect()
        {
            painter = paint_presence_viewport(painter, r, p, color, zoom, false, pal);
        }
        if let Some(r) = pose.region_rect(p.kind) {
            painter = paint_presence_region(painter, r, p, color, zoom, pal, false);
        }
        painter = paint_presence_cursor(painter, p, pose, pal, zoom, dismissed_notes, false);
    }
    painter
}

fn paint_presence_cursor(
    mut painter: Painter,
    p: &Presence,
    pose: AnimatedPresencePose,
    pal: &WhiteboardPalette,
    zoom: f32,
    dismissed_notes: &BTreeSet<String>,
    fast_shadows: bool,
) -> Painter {
    // Viewport-only presences or highlight/claim regions with an explicit box already render their own badge.
    if !p.has_cursor || (matches!(p.kind, PresenceKind::Highlight | PresenceKind::Claim) && pose.region_rect(p.kind).is_some()) {
        return painter;
    }

    let inv_scale = 1.0 / zoom.max(0.25);
    let color = pal.resolve_presence_color(p);
    let px_x = pose.x as f32;
    let px_y = pose.y as f32;
    let s = inv_scale;

    // Crisp vector cursor pointer.
    painter = painter
        .save()
        .translate(px_x, px_y)
        .scale(s, s)
        .begin_path()
        .fill_color(color)
        .move_to(0.0, 0.0)
        .line_to(11.0, 5.5)
        .line_to(6.0, 7.2)
        .line_to(4.2, 12.2)
        .close_path()
        .fill()
        .stroke_color(pal.page)
        .line_width(1.2)
        .begin_path()
        .move_to(0.0, 0.0)
        .line_to(11.0, 5.5)
        .line_to(6.0, 7.2)
        .line_to(4.2, 12.2)
        .close_path()
        .stroke();

    let status_opt = (!dismissed_notes.contains(&p.id))
        .then_some(p.status.as_deref())
        .flatten()
        .map(str::trim)
        .filter(|t| !t.is_empty());

    if let Some(msg) = status_opt
        && msg.chars().count() > 14
    {
        // Full conversational proposal speech bubble with inline dismiss × mark.
        let pill_w = (measure_text_span(msg, 12.5, false) + 52.0).clamp(160.0, 580.0) as f32;
        let pill_h = 32.0_f32;
        let pb = Bounds::new(point(px(10.0), px(10.0)), size(px(pill_w), px(pill_h)));
        let close_cx = 10.0 + pill_w - 17.0;
        let close_cy = 10.0 + pill_h * 0.5;
        painter = fill_round_rect_shadowed(painter, pb, 10.0, color, pal, fast_shadows, 7.0, 2.0);
        painter = painter
            .fill_color(pal.pill_ink)
            .font("500 12.5px 'PingFang SC', system-ui, sans-serif")
            .text_align(CanvasTextAlign::Left)
            .text_baseline(CanvasTextBaseline::Middle)
            .fill_text(msg, 24.0, close_cy)
            .stroke_color(Hsla { a: 0.85, ..pal.pill_ink })
            .line_width(1.4)
            .begin_path()
            .move_to(close_cx - 3.5, close_cy - 3.5)
            .line_to(close_cx + 3.5, close_cy + 3.5)
            .move_to(close_cx + 3.5, close_cy - 3.5)
            .line_to(close_cx - 3.5, close_cy + 3.5)
            .stroke()
            .restore();
    } else {
        let label = match status_opt {
            Some(st) => format!("{} · {st}", p.name),
            None => p.name.clone(),
        };
        let pill_w = (measure_text_span(&label, 11.5, true) + 18.0).max(40.0) as f32;
        let pill_h = 22.0_f32;
        let pb = Bounds::new(point(px(10.0), px(10.0)), size(px(pill_w), px(pill_h)));
        painter = fill_round_rect_shadowed(painter, pb, 11.0, color, pal, fast_shadows, 5.0, 2.0);
        painter = painter
            .fill_color(pal.pill_ink)
            .font("600 11.5px 'PingFang SC', system-ui, sans-serif")
            .text_align(CanvasTextAlign::Center)
            .text_baseline(CanvasTextBaseline::Middle)
            .fill_text(&label, 10.0 + pill_w * 0.5, 10.0 + pill_h * 0.5)
            .restore();
    }
    painter
}

pub fn paint_minimap(
    doc: &BoardDoc,
    lookup: &HashMap<ElementId, Rect2>,
    camera: Camera,
    viewport_size: (f32, f32),
    minimap_size: (f32, f32),
    dark: bool,
) -> Drawing {
    paint_minimap_painter(doc, lookup, camera, viewport_size, minimap_size, dark).finish()
}

pub fn paint_minimap_painter(
    doc: &BoardDoc,
    lookup: &HashMap<ElementId, Rect2>,
    camera: Camera,
    viewport_size: (f32, f32),
    minimap_size: (f32, f32),
    dark: bool,
) -> Painter {
    let pal = WhiteboardPalette::for_mode(dark);
    let mw = minimap_size.0.max(60.0);
    let mh = minimap_size.1.max(40.0);

    let mut painter = fill_and_stroke_round_rect(
        Painter::new(),
        Bounds::new(point(px(0.0), px(0.0)), size(px(mw), px(mh))),
        8.0,
        pal.side,
        pal.line,
        1.0,
    );

    let world_view = camera.visible_world_rect(f64::from(viewport_size.0.max(1.0)), f64::from(viewport_size.1.max(1.0)));
    let world_bounds = doc.content_bounds().map_or(world_view, |c| c.union(world_view)).expand(60.0);

    let sx = f64::from(mw - 12.0) / world_bounds.w.max(1.0);
    let sy = f64::from(mh - 12.0) / world_bounds.h.max(1.0);
    let s = sx.min(sy);
    let ox = 6.0 + (f64::from(mw - 12.0) - world_bounds.w * s) * 0.5 - world_bounds.x * s;
    let oy = 6.0 + (f64::from(mh - 12.0) - world_bounds.h * s) * 0.5 - world_bounds.y * s;

    for el in &doc.elements {
        if el.is_arrow() {
            continue;
        }
        let r = el.bbox(lookup);
        let fill = match &el.kind {
            ElementKind::Shape { shape, fill, .. } => pal.shape_tone(*shape, fill).fill,
            ElementKind::Timeline { .. } => pal.timeline_start,
            ElementKind::Container { .. } => pal.container_header_bg,
            _ => pal.muted,
        };
        let mb = Bounds::new(
            point(px((r.x * s + ox) as f32), px((r.y * s + oy) as f32)),
            size(px((r.w * s).max(3.0) as f32), px((r.h * s).max(2.0) as f32)),
        );
        painter = painter.begin_path().fill_color(fill).round_rect(mb, px(1.5)).fill();
    }

    let vx = (world_view.x * s + ox).clamp(2.0, f64::from(mw - 6.0)) as f32;
    let vy = (world_view.y * s + oy).clamp(2.0, f64::from(mh - 6.0)) as f32;
    let vw = (world_view.w * s).clamp(8.0, f64::from(mw) - f64::from(vx) - 2.0) as f32;
    let vh = (world_view.h * s).clamp(8.0, f64::from(mh) - f64::from(vy) - 2.0) as f32;
    let vb = Bounds::new(point(px(vx), px(vy)), size(px(vw), px(vh)));

    fill_and_stroke_rect(painter, vb, pal.selection_soft, pal.selection, 1.2)
}
