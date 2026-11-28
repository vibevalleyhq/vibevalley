use std::collections::{BTreeSet, HashMap};

use nsh_core::canvas::{CanvasGradient, CanvasTextAlign, CanvasTextBaseline, LineCap, LineJoin};
use nsh_core::prelude::{Bounds, Hsla, Painter, Percentage, point, px, radians, size};

use crate::engine::whiteboard::geometry::{
    ArrowGeometry, CubicSegment, HeadShape, RouteShape, arrowhead_geometry, catmull_rom_cubics, route_arrow, sample_polyline,
};
use crate::engine::whiteboard::layout::measure_text_span;
use crate::engine::whiteboard::model::{
    ArrowHead, BoardDoc, ElementId, ElementKind, ElementRecord, MilestoneKind, Point2, Rect2, StrokeStyle, TimelineMilestone, Vec2, WbFill,
};
use crate::engine::whiteboard::stickers::resolve_sticker_svg;

use super::cards::{paint_embedded_svg, paint_html_card, paint_image_card, paint_ink_stroke, paint_shape, paint_table, paint_text};
use super::palette::{WhiteboardPalette, parse_hex_hsla};
use super::primitives::{fill_and_stroke_circle, fill_and_stroke_round_rect, fill_round_rect_shadowed};

pub fn paint_board_into_painter(
    painter: Painter,
    doc: &BoardDoc,
    lookup: &HashMap<ElementId, Rect2>,
    pal: &WhiteboardPalette,
    visible_indices: Option<&BTreeSet<usize>>,
    editing_id: Option<&ElementId>,
    anim_hidden_ids: &BTreeSet<ElementId>,
) -> Painter {
    paint_board_into_painter_ex(painter, doc, lookup, pal, visible_indices, editing_id, None, anim_hidden_ids, false)
}

#[allow(clippy::too_many_arguments)]
pub fn paint_board_into_painter_ex(
    mut painter: Painter,
    doc: &BoardDoc,
    lookup: &HashMap<ElementId, Rect2>,
    pal: &WhiteboardPalette,
    visible_indices: Option<&BTreeSet<usize>>,
    editing_id: Option<&ElementId>,
    editing_milestone: Option<usize>,
    anim_hidden_ids: &BTreeSet<ElementId>,
    fast_shadows: bool,
) -> Painter {
    let should_draw = |idx: usize, el: &ElementRecord| -> bool {
        if anim_hidden_ids.contains(&el.id) {
            return false;
        }
        visible_indices.is_none_or(|vis| vis.contains(&idx))
    };

    // Pass 1: Containers & Claims
    for (idx, el) in doc.elements.iter().enumerate() {
        if !should_draw(idx, el) {
            continue;
        }
        if matches!(el.kind, ElementKind::Container { .. } | ElementKind::Claim { .. }) {
            let hide_text = editing_id == Some(&el.id);
            painter = paint_element(painter, el, lookup, pal, hide_text, None, fast_shadows);
        }
    }

    // Pass 2: Arrows (strictly BEFORE Timelines so stems tuck under milestone pills cleanly)
    for (idx, el) in doc.elements.iter().enumerate() {
        if !should_draw(idx, el) {
            continue;
        }
        if matches!(el.kind, ElementKind::Arrow { .. }) {
            let hide_text = editing_id == Some(&el.id);
            painter = paint_element(painter, el, lookup, pal, hide_text, None, fast_shadows);
        }
    }

    // Pass 3: Timelines
    for (idx, el) in doc.elements.iter().enumerate() {
        if !should_draw(idx, el) {
            continue;
        }
        if matches!(el.kind, ElementKind::Timeline { .. }) {
            let is_editing = editing_id == Some(&el.id);
            let hide_ms = if is_editing { editing_milestone } else { None };
            painter = paint_element(painter, el, lookup, pal, is_editing && editing_milestone.is_none(), hide_ms, fast_shadows);
        }
    }

    // Pass 4: Shapes, Tables, Images, HtmlEmbeds
    for (idx, el) in doc.elements.iter().enumerate() {
        if !should_draw(idx, el) {
            continue;
        }
        if matches!(
            el.kind,
            ElementKind::Shape { .. } | ElementKind::Table { .. } | ElementKind::Image { .. } | ElementKind::HtmlEmbed { .. }
        ) {
            let hide_text = editing_id == Some(&el.id);
            painter = paint_element(painter, el, lookup, pal, hide_text, None, fast_shadows);
        }
    }

    // Pass 5: Text (Title, Subtitle, Callout, Body)
    for (idx, el) in doc.elements.iter().enumerate() {
        if !should_draw(idx, el) {
            continue;
        }
        if matches!(el.kind, ElementKind::Text { .. }) {
            let hide_text = editing_id == Some(&el.id);
            painter = paint_element(painter, el, lookup, pal, hide_text, None, fast_shadows);
        }
    }

    // Pass 6: Standalone Stickers & Custom SVGs
    for (idx, el) in doc.elements.iter().enumerate() {
        if !should_draw(idx, el) {
            continue;
        }
        if matches!(el.kind, ElementKind::Sticker { .. } | ElementKind::Svg { .. }) {
            painter = paint_element(painter, el, lookup, pal, false, None, fast_shadows);
        }
    }

    // Pass 7: Pressure Ink Paths
    for (idx, el) in doc.elements.iter().enumerate() {
        if !should_draw(idx, el) {
            continue;
        }
        if matches!(el.kind, ElementKind::Path { .. }) {
            painter = paint_element(painter, el, lookup, pal, false, None, fast_shadows);
        }
    }

    painter
}

fn paint_element(
    mut painter: Painter,
    el: &ElementRecord,
    lookup: &HashMap<ElementId, Rect2>,
    pal: &WhiteboardPalette,
    hide_text: bool,
    hide_milestone: Option<usize>,
    fast_shadows: bool,
) -> Painter {
    let has_rot = el.rotation_deg.abs() > 1e-4 && !el.is_arrow();
    let has_alpha = el.opacity < 0.995;
    let center = el.bbox(lookup).center();

    if has_rot || has_alpha {
        painter = painter.save();
        if has_alpha {
            painter = painter.global_alpha(el.opacity.clamp(0.05, 1.0));
        }
        if has_rot {
            painter = painter
                .translate(center.x as f32, center.y as f32)
                .rotate(radians(el.rotation_deg.to_radians() as f32))
                .translate(-center.x as f32, -center.y as f32);
        }
    }

    painter = match &el.kind {
        ElementKind::Container {
            x,
            y,
            w,
            h,
            title,
            fill,
            stroke,
            collapsed,
        } => paint_container(
            painter,
            Rect2::new(*x, *y, *w, *h),
            (!hide_text).then_some(title.as_str()),
            fill,
            stroke.as_deref(),
            *collapsed,
            pal,
        ),
        ElementKind::Claim {
            x,
            y,
            w,
            h,
            label,
            agent_id,
            status,
        } => paint_claim(painter, Rect2::new(*x, *y, *w, *h), label, agent_id.as_deref(), status.as_deref(), pal),
        ElementKind::Arrow {
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
        } => {
            if let Some(geom) = route_arrow(from, to, bends, *curve, lookup) {
                let color = stroke.as_deref().and_then(parse_hex_hsla).unwrap_or(pal.arrow_default);
                paint_arrow_geom(
                    painter,
                    &geom,
                    *style,
                    *start_head,
                    *end_head,
                    color,
                    *stroke_width,
                    if hide_text { None } else { label.as_deref() },
                    pal,
                )
            } else {
                painter
            }
        }
        ElementKind::Timeline {
            x,
            y,
            w,
            h,
            fill: _,
            points,
            milestones,
        } => paint_timeline(
            painter,
            Rect2::new(*x, *y, *w, *h),
            points,
            milestones,
            pal,
            hide_text,
            hide_milestone,
            fast_shadows,
        ),
        ElementKind::Shape {
            x,
            y,
            w,
            h,
            shape,
            title,
            body,
            fill,
            stroke,
            stroke_style,
            corner_radius,
            sticker,
            sticker_svg,
            badge,
            align,
        } => paint_shape(
            painter,
            Rect2::new(*x, *y, *w, *h),
            *shape,
            title,
            body,
            fill,
            stroke.as_deref(),
            *stroke_style,
            *corner_radius,
            sticker.as_deref(),
            sticker_svg.as_deref(),
            badge.as_deref(),
            *align,
            pal,
            hide_text,
            fast_shadows,
        ),
        ElementKind::Table {
            x,
            y,
            w,
            h,
            headers,
            rows,
            fill,
        } => paint_table(painter, Rect2::new(*x, *y, *w, *h), headers, rows, fill, pal, fast_shadows),
        ElementKind::Image { x, y, w, h, alt, uri, .. } => paint_image_card(painter, Rect2::new(*x, *y, *w, *h), alt.as_deref(), uri, pal),
        ElementKind::HtmlEmbed { x, y, w, h, title, .. } => paint_html_card(painter, Rect2::new(*x, *y, *w, *h), title.as_deref(), pal),
        ElementKind::Text {
            x,
            y,
            w,
            h,
            variant,
            label,
            highlight,
            icon,
            align,
            font_size,
            fill,
            color,
        } => paint_text(
            painter,
            Rect2::new(*x, *y, *w, *h),
            *variant,
            label,
            highlight.as_deref(),
            icon.as_deref(),
            *align,
            *font_size,
            fill.as_ref(),
            color.as_deref(),
            pal,
            hide_text,
        ),
        ElementKind::Sticker { x, y, w, h, sticker, svg, .. } => {
            if let Some(svg_src) = resolve_sticker_svg(Some(sticker.as_str()), svg.as_deref()) {
                paint_embedded_svg(painter, *x, *y, *w, *h, svg_src, pal.ink)
            } else {
                painter
            }
        }
        ElementKind::Svg { x, y, w, h, svg, .. } => paint_embedded_svg(painter, *x, *y, *w, *h, svg, pal.ink),
        ElementKind::Path {
            points,
            stroke,
            stroke_width,
            mode,
        } => paint_ink_stroke(painter, points, stroke, *stroke_width, *mode, pal),
    };

    if has_rot || has_alpha {
        painter = painter.restore();
    }
    painter
}

fn paint_container(
    mut painter: Painter,
    rect: Rect2,
    title: Option<&str>,
    fill: &WbFill,
    stroke: Option<&str>,
    collapsed: bool,
    pal: &WhiteboardPalette,
) -> Painter {
    let tone = pal.tone(fill);
    let box_bg = if matches!(fill, WbFill::Side | WbFill::Default) {
        pal.container_bg
    } else {
        Hsla { a: 0.22, ..tone.fill }
    };
    let box_border = stroke.and_then(parse_hex_hsla).unwrap_or(pal.container_border);
    let draw_h = if collapsed { 36.0 } else { rect.h };
    let bounds = Bounds::new(point(px(rect.x as f32), px(rect.y as f32)), size(px(rect.w as f32), px(draw_h as f32)));

    painter = painter.begin_path().fill_color(box_bg).round_rect(bounds, px(12.0)).fill();

    painter = painter.save().stroke_color(box_border).line_width(1.2);
    if collapsed {
        painter = painter.line_dash(&[px(5.0), px(4.0)]);
    }
    painter = painter.begin_path().round_rect(bounds, px(12.0)).stroke().restore();

    if let Some(title) = title.filter(|t| !t.trim().is_empty()) {
        painter = painter
            .fill_color(pal.muted)
            .font("500 12.5px 'PingFang SC', system-ui, sans-serif")
            .text_align(CanvasTextAlign::Left)
            .text_baseline(CanvasTextBaseline::Bottom)
            .fill_text(title, (rect.x + 2.0) as f32, (rect.y - 9.0) as f32);
    }

    painter
}

fn paint_claim(mut painter: Painter, rect: Rect2, label: &str, agent_id: Option<&str>, status: Option<&str>, pal: &WhiteboardPalette) -> Painter {
    let bounds = Bounds::new(point(px(rect.x as f32), px(rect.y as f32)), size(px(rect.w as f32), px(rect.h as f32)));
    let tint = Hsla { a: 0.08, ..pal.presence_coral };
    painter = painter
        .save()
        .begin_path()
        .fill_color(tint)
        .round_rect(bounds, px(12.0))
        .fill()
        .stroke_color(pal.presence_coral)
        .line_width(1.6)
        .line_dash(&[px(6.0), px(4.0)])
        .begin_path()
        .round_rect(bounds, px(12.0))
        .stroke()
        .restore();

    let badge_text = match (agent_id, status) {
        (Some(a), Some(s)) => format!("{a} · {s} · {label}"),
        (Some(a), None) => format!("{a} · {label}"),
        (None, _) => label.to_owned(),
    };
    let bw = (measure_text_span(&badge_text, 11.0, true) + 18.0).min(rect.w.max(80.0));
    let chip = Bounds::new(point(px((rect.x + 10.0) as f32), px((rect.y - 11.0) as f32)), size(px(bw as f32), px(22.0)));
    painter
        .begin_path()
        .fill_color(pal.presence_coral)
        .round_rect(chip, px(11.0))
        .fill()
        .fill_color(pal.pill_ink)
        .font("600 10.5px 'PingFang SC', system-ui, sans-serif")
        .text_align(CanvasTextAlign::Left)
        .text_baseline(CanvasTextBaseline::Middle)
        .fill_text(&badge_text, (rect.x + 19.0) as f32, rect.y as f32)
}

#[allow(clippy::too_many_arguments)]
fn paint_arrow_geom(
    mut painter: Painter,
    geom: &ArrowGeometry,
    style: StrokeStyle,
    start_head: ArrowHead,
    end_head: ArrowHead,
    color: Hsla,
    width: f32,
    label: Option<&str>,
    pal: &WhiteboardPalette,
) -> Painter {
    painter = painter
        .save()
        .stroke_color(color)
        .line_width(width.max(1.2))
        .line_cap(LineCap::Round)
        .line_join(LineJoin::Round);

    match style {
        StrokeStyle::Solid => {}
        StrokeStyle::Dashed => painter = painter.line_dash(&[px(7.0), px(5.0)]),
        StrokeStyle::Dotted => painter = painter.line_dash(&[px(2.0), px(5.0)]),
    }

    painter = trace_route_shape(painter.begin_path(), &geom.shape).stroke().restore();

    let head_scale = (f64::from(width) / 1.75).clamp(0.85, 1.45);
    if let Some(shape) = arrowhead_geometry(geom.start, vec2_neg(geom.start_dir), start_head, head_scale) {
        painter = paint_head_shape(painter, shape, color);
    }
    if let Some(shape) = arrowhead_geometry(geom.end, geom.end_dir, end_head, head_scale) {
        painter = paint_head_shape(painter, shape, color);
    }

    if let Some(text) = label
        && !text.trim().is_empty()
    {
        let lw = measure_text_span(text, 11.5, true) + 16.0;
        let lb = Bounds::new(
            point(px((geom.label_pos.x - lw * 0.5) as f32), px((geom.label_pos.y - 11.0) as f32)),
            size(px(lw as f32), px(22.0)),
        );
        painter = fill_and_stroke_round_rect(painter, lb, 6.0, pal.arrow_label_bg, pal.line, 1.0)
            .fill_color(pal.ink)
            .font("600 11px 'PingFang SC', system-ui, sans-serif")
            .text_align(CanvasTextAlign::Center)
            .text_baseline(CanvasTextBaseline::Middle)
            .fill_text(text, geom.label_pos.x as f32, geom.label_pos.y as f32);
    }

    painter
}

fn vec2_neg(v: Vec2) -> Vec2 {
    Vec2::new(-v.x, -v.y)
}

fn trace_route_shape(mut painter: Painter, shape: &RouteShape) -> Painter {
    match shape {
        RouteShape::Polyline(pts) => {
            if let Some(first) = pts.first() {
                painter = painter.move_to(first.x as f32, first.y as f32);
                for p in &pts[1..] {
                    painter = painter.line_to(p.x as f32, p.y as f32);
                }
            }
        }
        RouteShape::Cubics(segs) => {
            if let Some(first) = segs.first() {
                painter = painter.move_to(first.p0.x as f32, first.p0.y as f32);
                for seg in segs {
                    painter = painter.bezier_curve_to(
                        point(px(seg.c1.x as f32), px(seg.c1.y as f32)),
                        point(px(seg.c2.x as f32), px(seg.c2.y as f32)),
                        point(px(seg.p3.x as f32), px(seg.p3.y as f32)),
                    );
                }
            }
        }
    }
    painter
}

fn paint_head_shape(mut painter: Painter, shape: HeadShape, color: Hsla) -> Painter {
    painter = painter.fill_color(color).begin_path();
    match shape {
        HeadShape::Triangle([a, b, c]) => {
            painter = painter
                .move_to(a.x as f32, a.y as f32)
                .line_to(b.x as f32, b.y as f32)
                .line_to(c.x as f32, c.y as f32)
                .close_path();
        }
        HeadShape::Diamond([a, b, c, d]) => {
            painter = painter
                .move_to(a.x as f32, a.y as f32)
                .line_to(b.x as f32, b.y as f32)
                .line_to(c.x as f32, c.y as f32)
                .line_to(d.x as f32, d.y as f32)
                .close_path();
        }
        HeadShape::Circle { center, radius } => {
            painter = painter.ellipse(
                point(px(center.x as f32), px(center.y as f32)),
                size(px(radius as f32), px(radius as f32)),
                radians(0.0),
                radians(0.0),
                radians(std::f32::consts::TAU),
                false,
            );
        }
    }
    painter.fill()
}

#[allow(clippy::too_many_arguments)]
fn paint_timeline(
    mut painter: Painter,
    rect: Rect2,
    points: &[Point2],
    milestones: &[TimelineMilestone],
    pal: &WhiteboardPalette,
    hide_text: bool,
    hide_milestone: Option<usize>,
    fast_shadows: bool,
) -> Painter {
    let ribbon_pts: Vec<Point2> = if points.len() >= 2 {
        points.to_vec()
    } else {
        vec![
            Point2::new(rect.x, rect.center().y + 10.0),
            Point2::new(rect.center().x, rect.center().y - 4.0),
            Point2::new(rect.right(), rect.center().y - 16.0),
        ]
    };

    let segs: Vec<CubicSegment> = catmull_rom_cubics(&ribbon_pts, 0.55);
    let first_pt = ribbon_pts[0];
    let last_pt = *ribbon_pts.last().unwrap_or(&first_pt);
    let grad = CanvasGradient::linear(
        point(px(first_pt.x as f32), px(first_pt.y as f32)),
        point(px(last_pt.x as f32), px(last_pt.y as f32)),
    )
    .add_color_stop(Percentage(0.0), pal.timeline_start)
    .add_color_stop(Percentage(0.55), pal.timeline_mid)
    .add_color_stop(Percentage(1.0), pal.timeline_end);

    // Subtle halo underneath so grid lines do not distract behind the ribbon.
    painter = painter
        .save()
        .stroke_color(pal.timeline_halo)
        .line_width(16.0)
        .line_cap(LineCap::Round)
        .line_join(LineJoin::Round);
    painter = trace_route_shape(painter.begin_path(), &RouteShape::Cubics(segs.clone())).stroke().restore();

    // Primary terracotta -> warm amber gradient ribbon.
    painter = painter
        .save()
        .stroke_style(grad)
        .line_width(11.5)
        .line_cap(LineCap::Round)
        .line_join(LineJoin::Round);
    painter = trace_route_shape(painter.begin_path(), &RouteShape::Cubics(segs)).stroke().restore();

    // Milestone badges drawn strictly on top of ribbon (and arrows).
    let total = milestones.len().max(1);
    for (idx, m) in milestones.iter().enumerate() {
        let hide_this = hide_milestone.map_or(hide_text, |target| target == idx);
        let pt = m
            .pos
            .unwrap_or_else(|| sample_polyline(&ribbon_pts, m.t.unwrap_or((idx + 1) as f64 / (total + 1) as f64)));

        match m.kind {
            MilestoneKind::Minor => {
                painter = fill_and_stroke_circle(painter, pt.x as f32, pt.y as f32, 10.5, pal.minor_node_bg, pal.minor_node_border, 1.6);

                if !hide_this && !m.label.is_empty() {
                    painter = painter
                        .fill_color(pal.muted)
                        .font("600 10.5px 'PingFang SC', system-ui, sans-serif")
                        .text_align(CanvasTextAlign::Center)
                        .text_baseline(CanvasTextBaseline::Middle)
                        .fill_text(&m.label, pt.x as f32, pt.y as f32);
                }
            }
            MilestoneKind::Major => {
                let text_w = measure_text_span(&m.label, 12.0, true);
                let pw = (text_w + 22.0).max(52.0);
                let ph = 26.0;
                let pill = Bounds::new(
                    point(px((pt.x - pw * 0.5) as f32), px((pt.y - ph * 0.5) as f32)),
                    size(px(pw as f32), px(ph as f32)),
                );
                let fill_color = m.tone.as_deref().and_then(parse_hex_hsla).unwrap_or(pal.pill_bg);
                painter = fill_round_rect_shadowed(painter, pill, 13.0, fill_color, pal, fast_shadows, 6.0, 2.0);

                if !hide_this && !m.label.is_empty() {
                    painter = painter
                        .fill_color(pal.pill_ink)
                        .font("600 12px 'PingFang SC', system-ui, sans-serif")
                        .text_align(CanvasTextAlign::Center)
                        .text_baseline(CanvasTextBaseline::Middle)
                        .fill_text(&m.label, pt.x as f32, pt.y as f32);
                }
            }
        }

        if !hide_this
            && let Some(caption) = &m.caption
            && !caption.trim().is_empty()
        {
            painter = painter
                .fill_color(pal.ink)
                .font("600 12px 'PingFang SC', system-ui, sans-serif")
                .text_align(CanvasTextAlign::Center)
                .text_baseline(CanvasTextBaseline::Top)
                .fill_text(caption, pt.x as f32, (pt.y + 18.0) as f32);
        }
    }

    painter
}
