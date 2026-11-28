use nsh_core::canvas::{CanvasTextAlign, CanvasTextBaseline};
use nsh_core::prelude::{Bounds, Hsla, Painter, Points, point, px, radians, rgb, size};
use nsh_core::{Color, PaintStyle};

use crate::engine::whiteboard::ink::build_ink_outline;
use crate::engine::whiteboard::layout::{layout_card, layout_table, locate_highlight_span, measure_text_span, wrap_text};
use crate::engine::whiteboard::model::{InkMode, Rect2, ShapeKind, StrokePoint, StrokeStyle, TextAlign, TextVariant, WbFill};
use crate::engine::whiteboard::stickers::{cached_svg_drawing, resolve_sticker_svg};

use super::palette::{WhiteboardPalette, parse_hex_hsla};
use super::primitives::{fast_shadow_color, fill_and_stroke_round_rect, fill_round_rect_shadowed};

#[allow(clippy::too_many_arguments)]
pub(super) fn paint_shape(
    mut painter: Painter,
    rect: Rect2,
    shape: ShapeKind,
    title: &str,
    body: &str,
    fill: &WbFill,
    stroke: Option<&str>,
    stroke_style: StrokeStyle,
    corner_radius: Option<f32>,
    sticker: Option<&str>,
    sticker_svg_custom: Option<&str>,
    badge: Option<&str>,
    align: TextAlign,
    pal: &WhiteboardPalette,
    hide_text: bool,
    fast_shadows: bool,
) -> Painter {
    let tone = pal.shape_tone(shape, fill);
    let border = stroke.and_then(parse_hex_hsla).unwrap_or(tone.border);
    let bounds = Bounds::new(point(px(rect.x as f32), px(rect.y as f32)), size(px(rect.w as f32), px(rect.h as f32)));
    let r = corner_radius.unwrap_or(match shape {
        ShapeKind::Card | ShapeKind::Sticky | ShapeKind::Rounded => 10.0,
        ShapeKind::Rect => 2.0,
        ShapeKind::Pill => (rect.h.min(rect.w) * 0.5) as f32,
        _ => 10.0,
    });

    // 1. Fill shape (with soft warm drop shadow on Cards & Stickies; zero-blur silhouette while navigating).
    let use_shadow = matches!(shape, ShapeKind::Card | ShapeKind::Sticky);
    if use_shadow && fast_shadows {
        let shadow_rect = Rect2::new(rect.x, rect.y + 3.0, rect.w, rect.h);
        let shadow_bounds = Bounds::new(
            point(px(shadow_rect.x as f32), px(shadow_rect.y as f32)),
            size(px(shadow_rect.w as f32), px(shadow_rect.h as f32)),
        );
        painter = painter.fill_color(fast_shadow_color(pal));
        painter = trace_shape_path(painter.begin_path(), shadow_rect, shadow_bounds, shape, r).fill();
        painter = painter.fill_color(tone.fill);
        painter = trace_shape_path(painter.begin_path(), rect, bounds, shape, r).fill();
    } else {
        painter = painter.save().fill_color(tone.fill);
        if use_shadow {
            painter = painter.shadow(pal.card_shadow, px(12.0), point(px(0.0), px(3.0)));
        }
        painter = trace_shape_path(painter.begin_path(), rect, bounds, shape, r).fill().restore();
    }

    // 2. Stroke outline.
    painter = painter.save().stroke_color(border).line_width(1.2);
    match stroke_style {
        StrokeStyle::Solid => {}
        StrokeStyle::Dashed => painter = painter.line_dash(&[px(6.0), px(4.0)]),
        StrokeStyle::Dotted => painter = painter.line_dash(&[px(2.0), px(4.0)]),
    }
    painter = trace_shape_path(painter.begin_path(), rect, bounds, shape, r).stroke().restore();

    // Extra visual detail for Cylinder top ellipse.
    if shape == ShapeKind::Cylinder {
        let rx = (rect.w * 0.5) as f32;
        let ry = (rect.h * 0.16).clamp(8.0, 18.0) as f32;
        let cx = rect.center().x as f32;
        let top_cy = rect.y as f32 + ry;
        painter = painter
            .begin_path()
            .stroke_color(border)
            .line_width(1.25)
            .ellipse(
                point(px(cx), px(top_cy)),
                size(px(rx), px(ry)),
                radians(0.0),
                radians(0.0),
                radians(std::f32::consts::TAU),
                false,
            )
            .stroke();
    }

    // 3. Perched editorial sticker overhanging top edge (matching reference aesthetic).
    let has_sticker = resolve_sticker_svg(sticker, sticker_svg_custom);
    if let Some(svg_src) = has_sticker {
        let sw = 58.0;
        let sh = 58.0;
        let sx = rect.x + (rect.w - sw) * 0.5;
        let sy = rect.y - 24.0;
        painter = paint_embedded_svg(painter, sx, sy, sw, sh, svg_src, tone.ink);
    }

    // 4. Optional top-right badge pill.
    if let Some(b) = badge
        && !b.trim().is_empty()
    {
        let bw = (measure_text_span(b, 9.5, true) + 12.0).max(28.0);
        let bb = Bounds::new(
            point(px((rect.right() - bw - 8.0) as f32), px((rect.y + 8.0) as f32)),
            size(px(bw as f32), px(18.0)),
        );
        painter = painter
            .begin_path()
            .fill_color(pal.pill_bg)
            .round_rect(bb, px(9.0))
            .fill()
            .fill_color(pal.pill_ink)
            .font("600 9.5px 'PingFang SC', system-ui, sans-serif")
            .text_align(CanvasTextAlign::Center)
            .text_baseline(CanvasTextBaseline::Middle)
            .fill_text(b, (rect.right() - bw * 0.5 - 8.0) as f32, (rect.y + 17.0) as f32);
    }

    // 5. Card / Shape typography.
    if !hide_text && (!title.trim().is_empty() || !body.trim().is_empty()) {
        let layout = layout_card(rect, title, body, has_sticker.is_some());
        let (text_x, canvas_align) = match align {
            TextAlign::Left => ((rect.x + 12.0) as f32, CanvasTextAlign::Left),
            TextAlign::Center => (rect.center().x as f32, CanvasTextAlign::Center),
            TextAlign::Right => ((rect.right() - 12.0) as f32, CanvasTextAlign::Right),
        };
        let compact = rect.h <= 44.0;
        let title_font = if compact {
            "400 12.5px 'PingFang SC', system-ui, sans-serif"
        } else if body.trim().is_empty() {
            "500 13px 'PingFang SC', system-ui, sans-serif"
        } else {
            "600 13px 'PingFang SC', system-ui, sans-serif"
        };
        painter = painter
            .fill_color(tone.ink)
            .font(title_font)
            .text_align(canvas_align)
            .text_baseline(CanvasTextBaseline::Top);
        for (i, line) in layout.title_lines.iter().enumerate() {
            let y = (layout.title_y + i as f64 * layout.line_height_title) as f32;
            painter = painter.fill_text(line, text_x, y);
        }

        let body_color = Hsla { a: 0.84, ..tone.ink };
        painter = painter.fill_color(body_color).font("400 11.5px 'PingFang SC', system-ui, sans-serif");
        for (i, line) in layout.body_lines.iter().enumerate() {
            let y = (layout.body_y + i as f64 * layout.line_height_body) as f32;
            painter = painter.fill_text(line, text_x, y);
        }
    }

    painter
}

fn trace_shape_path(mut painter: Painter, rect: Rect2, bounds: Bounds<Points>, shape: ShapeKind, r: f32) -> Painter {
    match shape {
        ShapeKind::Card | ShapeKind::Sticky | ShapeKind::Rect | ShapeKind::Rounded | ShapeKind::Pill => {
            painter = painter.round_rect(bounds, px(r));
        }
        ShapeKind::Ellipse => {
            let c = rect.center();
            painter = painter.ellipse(
                point(px(c.x as f32), px(c.y as f32)),
                size(px((rect.w * 0.5) as f32), px((rect.h * 0.5) as f32)),
                radians(0.0),
                radians(0.0),
                radians(std::f32::consts::TAU),
                false,
            );
        }
        ShapeKind::Diamond => {
            let c = rect.center();
            painter = painter
                .move_to(c.x as f32, rect.y as f32)
                .line_to(rect.right() as f32, c.y as f32)
                .line_to(c.x as f32, rect.bottom() as f32)
                .line_to(rect.x as f32, c.y as f32)
                .close_path();
        }
        ShapeKind::Triangle => {
            let c = rect.center();
            painter = painter
                .move_to(c.x as f32, rect.y as f32)
                .line_to(rect.right() as f32, rect.bottom() as f32)
                .line_to(rect.x as f32, rect.bottom() as f32)
                .close_path();
        }
        ShapeKind::Cylinder => {
            let ry = (rect.h * 0.16).clamp(8.0, 18.0);
            let x0 = rect.x as f32;
            let x1 = rect.right() as f32;
            let y0 = (rect.y + ry) as f32;
            let y1 = (rect.bottom() - ry) as f32;
            let cx = rect.center().x as f32;
            painter = painter
                .move_to(x0, y0)
                .bezier_curve_to(point(px(x0), px(rect.y as f32)), point(px(x1), px(rect.y as f32)), point(px(x1), px(y0)))
                .line_to(x1, y1)
                .bezier_curve_to(
                    point(px(x1), px(rect.bottom() as f32)),
                    point(px(x0), px(rect.bottom() as f32)),
                    point(px(x0), px(y1)),
                )
                .close_path();
            let _ = cx;
        }
    }
    painter
}

#[allow(clippy::too_many_arguments)]
pub(super) fn paint_text(
    mut painter: Painter,
    rect: Rect2,
    variant: TextVariant,
    label: &str,
    highlight: Option<&str>,
    _icon: Option<&str>,
    align: TextAlign,
    font_size: Option<f32>,
    fill: Option<&WbFill>,
    color: Option<&str>,
    pal: &WhiteboardPalette,
    hide_text: bool,
) -> Painter {
    if let Some(bg_fill) = fill {
        let tone = pal.tone(bg_fill);
        let b = Bounds::new(point(px(rect.x as f32), px(rect.y as f32)), size(px(rect.w as f32), px(rect.h as f32)));
        painter = fill_and_stroke_round_rect(painter, b, 8.0, tone.fill, tone.border, 1.0);
    }

    let ink = color.and_then(parse_hex_hsla).unwrap_or(match variant {
        TextVariant::Subtitle => pal.muted,
        _ => pal.ink,
    });

    match variant {
        TextVariant::Title => {
            if hide_text {
                return painter;
            }
            let fs = font_size.unwrap_or(30.0);
            let font_str = format!("400 {fs}px Georgia, Songti SC, STSong, Times New Roman, serif");
            let x = match align {
                TextAlign::Left => rect.x as f32,
                TextAlign::Center => rect.center().x as f32,
                TextAlign::Right => rect.right() as f32,
            };
            let ta = match align {
                TextAlign::Left => CanvasTextAlign::Left,
                TextAlign::Center => CanvasTextAlign::Center,
                TextAlign::Right => CanvasTextAlign::Right,
            };
            painter
                .fill_color(ink)
                .font(&font_str)
                .text_align(ta)
                .text_baseline(CanvasTextBaseline::Top)
                .fill_text(label, x, (rect.y + 4.0) as f32)
        }
        TextVariant::Subtitle => {
            if hide_text {
                return painter;
            }
            let fs = font_size.unwrap_or(13.5);
            let font_str = format!("400 {fs}px 'PingFang SC', system-ui, sans-serif");
            if let Some(hl) = highlight
                && let Some(span) = locate_highlight_span(label, hl, f64::from(fs), rect.w, align)
            {
                let pill_x = (rect.x + span.box_offset_x) as f32;
                let pill_y = rect.y as f32;
                let pill_b = Bounds::new(point(px(pill_x), px(pill_y)), size(px(span.box_width as f32), px(21.0)));
                painter = painter.begin_path().fill_color(pal.highlight_bg).round_rect(pill_b, px(4.0)).fill();

                let before_x = match align {
                    TextAlign::Left => rect.x as f32,
                    TextAlign::Center | TextAlign::Right => (rect.x + span.box_offset_x + 5.0 - measure_text_span(&span.before, f64::from(fs), false)) as f32,
                };
                let text_y = (rect.y + 3.0) as f32;
                if !span.before.is_empty() {
                    painter = painter
                        .fill_color(ink)
                        .font(&font_str)
                        .text_align(CanvasTextAlign::Left)
                        .text_baseline(CanvasTextBaseline::Top)
                        .fill_text(&span.before, before_x, text_y);
                }
                painter = painter
                    .fill_color(pal.highlight_ink)
                    .font(&format!("500 {fs}px 'PingFang SC', system-ui, sans-serif"))
                    .text_align(CanvasTextAlign::Left)
                    .text_baseline(CanvasTextBaseline::Top)
                    .fill_text(&span.highlighted, pill_x + 5.0, text_y);
                if !span.after.is_empty() {
                    painter = painter
                        .fill_color(ink)
                        .font(&font_str)
                        .text_align(CanvasTextAlign::Left)
                        .text_baseline(CanvasTextBaseline::Top)
                        .fill_text(&span.after, pill_x + span.box_width as f32 - 5.0, text_y);
                }
                painter
            } else {
                painter
                    .fill_color(ink)
                    .font(&font_str)
                    .text_align(CanvasTextAlign::Left)
                    .text_baseline(CanvasTextBaseline::Top)
                    .fill_text(label, rect.x as f32, (rect.y + 3.0) as f32)
            }
        }
        TextVariant::Callout => {
            // Crisp warning triangle badge stays visible during inline editing; only the body text hides.
            let ix = (rect.x + 12.0) as f32;
            let iy = (rect.y + 15.0) as f32;
            painter = painter
                .begin_path()
                .fill_color(rgb(0xffe380).to_hsla())
                .move_to(ix, iy - 9.0)
                .line_to(ix + 9.0, iy + 7.0)
                .line_to(ix - 9.0, iy + 7.0)
                .close_path()
                .fill()
                .stroke_color(pal.ink)
                .line_width(1.5)
                .begin_path()
                .move_to(ix, iy - 9.0)
                .line_to(ix + 9.0, iy + 7.0)
                .line_to(ix - 9.0, iy + 7.0)
                .close_path()
                .stroke()
                .fill_color(rgb(0x1c1917).to_hsla())
                .font("700 10px 'PingFang SC', system-ui, sans-serif")
                .text_align(CanvasTextAlign::Center)
                .text_baseline(CanvasTextBaseline::Middle)
                .fill_text("!", ix, iy + 1.5);

            if !hide_text {
                let lines = wrap_text(label, (rect.w - 34.0).max(60.0), 12.0, false, 3);
                painter = painter
                    .fill_color(pal.ink)
                    .font("500 12px 'PingFang SC', system-ui, sans-serif")
                    .text_align(CanvasTextAlign::Left)
                    .text_baseline(CanvasTextBaseline::Top);
                for (i, line) in lines.iter().enumerate() {
                    painter = painter.fill_text(line, (rect.x + 28.0) as f32, (rect.y + 6.0 + i as f64 * 16.0) as f32);
                }
            }
            painter
        }
        TextVariant::Body => {
            if hide_text {
                return painter;
            }
            let fs = font_size.unwrap_or(13.0);
            let lines = wrap_text(label, (rect.w - 16.0).max(48.0), f64::from(fs), false, 6);
            let font_str = format!("400 {fs}px 'PingFang SC', system-ui, sans-serif");
            let (tx, ca) = match align {
                TextAlign::Left => ((rect.x + 8.0) as f32, CanvasTextAlign::Left),
                TextAlign::Center => (rect.center().x as f32, CanvasTextAlign::Center),
                TextAlign::Right => ((rect.right() - 8.0) as f32, CanvasTextAlign::Right),
            };
            painter = painter.fill_color(ink).font(&font_str).text_align(ca).text_baseline(CanvasTextBaseline::Top);
            for (i, line) in lines.iter().enumerate() {
                painter = painter.fill_text(line, tx, (rect.y + 6.0 + i as f64 * (f64::from(fs) + 5.0)) as f32);
            }
            painter
        }
    }
}

pub(super) fn paint_table(
    mut painter: Painter,
    rect: Rect2,
    headers: &[String],
    rows: &[Vec<String>],
    fill: &WbFill,
    pal: &WhiteboardPalette,
    fast_shadows: bool,
) -> Painter {
    let tone = pal.tone(fill);
    let layout = layout_table(rect, headers, rows);
    let table_bounds = Bounds::new(point(px(rect.x as f32), px(rect.y as f32)), size(px(rect.w as f32), px(rect.h as f32)));

    painter = fill_round_rect_shadowed(painter, table_bounds, 8.0, tone.fill, pal, fast_shadows, 8.0, 2.0);

    if layout.header_height > 0.0 {
        let hb = Bounds::new(
            point(px(rect.x as f32), px(rect.y as f32)),
            size(px(rect.w as f32), px(layout.header_height as f32)),
        );
        painter = painter.begin_path().fill_color(pal.table_header_bg).round_rect(hb, px(8.0)).fill();
    }

    painter = painter
        .begin_path()
        .stroke_color(tone.border)
        .line_width(1.2)
        .round_rect(table_bounds, px(8.0))
        .stroke();

    // Grid dividers.
    for c in 1..layout.col_count {
        let cx = (rect.x + c as f64 * layout.col_width) as f32;
        painter = painter
            .begin_path()
            .stroke_color(pal.line)
            .line_width(1.0)
            .move_to(cx, rect.y as f32)
            .line_to(cx, rect.bottom() as f32)
            .stroke();
    }
    if layout.header_height > 0.0 {
        let hy = (rect.y + layout.header_height) as f32;
        painter = painter
            .begin_path()
            .stroke_color(tone.border)
            .line_width(1.1)
            .move_to(rect.x as f32, hy)
            .line_to(rect.right() as f32, hy)
            .stroke();
    }
    for r_idx in 1..rows.len() {
        let ry = (rect.y + layout.header_height + r_idx as f64 * layout.row_height) as f32;
        if ry < rect.bottom() as f32 {
            painter = painter
                .begin_path()
                .stroke_color(pal.line)
                .line_width(1.0)
                .move_to(rect.x as f32, ry)
                .line_to(rect.right() as f32, ry)
                .stroke();
        }
    }

    // Header text.
    if layout.header_height > 0.0 {
        painter = painter
            .fill_color(pal.ink)
            .font("600 12px 'PingFang SC', system-ui, sans-serif")
            .text_align(CanvasTextAlign::Left)
            .text_baseline(CanvasTextBaseline::Middle);
        for (c, h) in headers.iter().take(layout.col_count).enumerate() {
            let x = (rect.x + c as f64 * layout.col_width + 10.0) as f32;
            let y = (rect.y + layout.header_height * 0.5) as f32;
            painter = painter.fill_text(h, x, y);
        }
    }

    // Row cell text.
    painter = painter
        .fill_color(pal.muted)
        .font("400 11.5px 'PingFang SC', system-ui, sans-serif")
        .text_align(CanvasTextAlign::Left)
        .text_baseline(CanvasTextBaseline::Middle);
    for (r_idx, row) in rows.iter().enumerate() {
        let cy = rect.y + layout.header_height + (r_idx as f64 + 0.5) * layout.row_height;
        if cy > rect.bottom() - 4.0 {
            break;
        }
        for (c, cell) in row.iter().take(layout.col_count).enumerate() {
            let cx = (rect.x + c as f64 * layout.col_width + 10.0) as f32;
            painter = painter.fill_text(cell, cx, cy as f32);
        }
    }

    painter
}

pub(super) fn paint_image_card(mut painter: Painter, rect: Rect2, alt: Option<&str>, uri: &str, pal: &WhiteboardPalette) -> Painter {
    let bounds = Bounds::new(point(px(rect.x as f32), px(rect.y as f32)), size(px(rect.w as f32), px(rect.h as f32)));
    painter = fill_and_stroke_round_rect(painter, bounds, 10.0, pal.tone_side.fill, pal.tone_side.border, 1.25);

    // Landscape mountain glyph in center when bitmap is async/external.
    let cx = rect.center().x as f32;
    let cy = (rect.center().y - 6.0) as f32;
    painter = painter
        .begin_path()
        .fill_color(pal.faint)
        .move_to(cx - 22.0, cy + 14.0)
        .line_to(cx - 7.0, cy - 6.0)
        .line_to(cx + 6.0, cy + 8.0)
        .line_to(cx + 14.0, cy - 1.0)
        .line_to(cx + 24.0, cy + 14.0)
        .close_path()
        .fill();

    let caption = alt.filter(|s| !s.is_empty()).unwrap_or(uri);
    if !caption.is_empty() {
        painter = painter
            .fill_color(pal.muted)
            .font("500 11px 'PingFang SC', system-ui, sans-serif")
            .text_align(CanvasTextAlign::Center)
            .text_baseline(CanvasTextBaseline::Bottom)
            .fill_text(caption, rect.center().x as f32, (rect.bottom() - 8.0) as f32);
    }
    painter
}

pub(super) fn paint_html_card(mut painter: Painter, rect: Rect2, title: Option<&str>, pal: &WhiteboardPalette) -> Painter {
    let bounds = Bounds::new(point(px(rect.x as f32), px(rect.y as f32)), size(px(rect.w as f32), px(rect.h as f32)));
    painter = fill_and_stroke_round_rect(painter, bounds, 10.0, pal.tone_default.fill, pal.tone_default.border, 1.25);

    let bar = Bounds::new(point(px(rect.x as f32), px(rect.y as f32)), size(px(rect.w as f32), px(26.0)));
    painter = painter
        .begin_path()
        .fill_color(pal.container_header_bg)
        .round_rect(bar, px(10.0))
        .fill()
        .fill_color(pal.ink)
        .font("600 11px 'PingFang SC', system-ui, sans-serif")
        .text_align(CanvasTextAlign::Left)
        .text_baseline(CanvasTextBaseline::Middle)
        .fill_text(title.unwrap_or("Embed"), (rect.x + 10.0) as f32, (rect.y + 13.0) as f32);
    painter
}

pub(super) fn paint_embedded_svg(mut painter: Painter, x: f64, y: f64, w: f64, h: f64, svg_src: &str, ink: Hsla) -> Painter {
    let Some(drawing) = cached_svg_drawing(svg_src) else {
        return painter;
    };
    let resolved = drawing.painted(
        &PaintStyle::default(),
        Color::from(ink),
        Color::TRANSPARENT,
        &[],
        size(px(w as f32), px(h as f32)),
    );
    painter = painter.save().translate(x as f32, y as f32);
    for op in resolved.ops {
        painter = painter.op(op);
    }
    painter.restore()
}

pub(super) fn paint_ink_stroke(
    mut painter: Painter,
    points: &[StrokePoint],
    stroke: &str,
    stroke_width: f32,
    mode: InkMode,
    pal: &WhiteboardPalette,
) -> Painter {
    let contour = build_ink_outline(points, stroke_width, mode);
    let Some(first) = contour.first() else {
        return painter;
    };
    let color = parse_hex_hsla(stroke).unwrap_or(pal.ink);
    let alpha = if mode == InkMode::Highlighter { 0.34 } else { 0.95 };

    painter = painter
        .save()
        .global_alpha(alpha)
        .fill_color(color)
        .begin_path()
        .move_to(first.x as f32, first.y as f32);
    for pt in &contour[1..] {
        painter = painter.line_to(pt.x as f32, pt.y as f32);
    }
    painter.close_path().fill().restore()
}
