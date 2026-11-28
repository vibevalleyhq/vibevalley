use std::collections::HashMap;
use std::fmt::Write as _;

use crate::engine::whiteboard::geometry::{CubicSegment, arrowhead_geometry, catmull_rom_cubics, cubics_to_svg_path, route_arrow, sample_polyline};
use crate::engine::whiteboard::ink::build_ink_outline;
use crate::engine::whiteboard::layout::{layout_card, layout_table, locate_highlight_span, measure_text_span, wrap_text};
use crate::engine::whiteboard::model::{
    ElementId, ElementKind, ElementRecord, InkMode, MilestoneKind, Point2, PresenceColor, Rect2, ShapeKind, StrokeStyle, TextAlign, TextVariant, WbFill,
};
use crate::engine::whiteboard::stickers::resolve_sticker_svg;
use crate::theme::DIAGRAM_FONT_SANS;

use super::palette::{FONT_SERIF, SvgColors, fill_tone_hex, presence_hex, shape_tone_hex};
use super::svg::{esc_attr, esc_text, route_shape_svg_d, write_nested_svg, write_svg_head, write_svg_shape_geom};

pub(super) fn write_svg_element(out: &mut String, el: &ElementRecord, lookup: &HashMap<ElementId, Rect2>, colors: &SvgColors, dark: bool) {
    let has_rot = el.rotation_deg.abs() > 1e-4 && !el.is_arrow();
    let has_alpha = el.opacity < 0.995;
    if has_rot || has_alpha {
        let c = el.bbox(lookup).center();
        out.push_str("<g");
        if has_alpha {
            let _ = write!(out, r#" opacity="{:.3}""#, el.opacity.clamp(0.05, 1.0));
        }
        if has_rot {
            let _ = write!(out, r#" transform="rotate({:.2} {:.2} {:.2})""#, el.rotation_deg, c.x, c.y);
        }
        out.push('>');
    }

    match &el.kind {
        ElementKind::Container {
            x,
            y,
            w,
            h,
            title,
            fill,
            stroke,
            collapsed,
        } => {
            let (tone_fill, _, _) = fill_tone_hex(fill, dark);
            let bg = if matches!(fill, WbFill::Side | WbFill::Default) {
                colors.container_bg
            } else {
                tone_fill
            };
            let bg_op = if matches!(fill, WbFill::Side | WbFill::Default) {
                if dark { "0.80" } else { "0.72" }
            } else {
                "0.22"
            };
            let border = stroke.as_deref().unwrap_or(colors.container_border);
            let draw_h = if *collapsed { 36.0 } else { *h };
            let dash = if *collapsed { r#" stroke-dasharray="5 4""# } else { "" };
            let _ = writeln!(
                out,
                r#"<rect x="{x:.1}" y="{y:.1}" width="{w:.1}" height="{draw_h:.1}" rx="12" fill="{bg}" fill-opacity="{bg_op}" stroke="{border}" stroke-width="1.2"{dash}/>"#,
            );
            if !title.trim().is_empty() {
                let _ = writeln!(
                    out,
                    r#"<text x="{:.1}" y="{:.1}" font-family="{DIAGRAM_FONT_SANS}" font-size="12.5" font-weight="500" fill="{}">{}</text>"#,
                    x + 2.0,
                    y - 9.0,
                    colors.muted,
                    esc_text(title)
                );
            }
        }
        ElementKind::Claim {
            x,
            y,
            w,
            h,
            label,
            agent_id,
            status,
        } => {
            let accent = presence_hex(PresenceColor::Coral, dark);
            let _ = writeln!(
                out,
                r#"<rect x="{x:.1}" y="{y:.1}" width="{w:.1}" height="{h:.1}" rx="12" fill="{accent}" fill-opacity="0.08" stroke="{accent}" stroke-width="1.6" stroke-dasharray="6 4"/>"#,
            );
            let badge_text = match (agent_id.as_deref(), status.as_deref()) {
                (Some(a), Some(s)) => format!("{a} · {s} · {label}"),
                (Some(a), None) => format!("{a} · {label}"),
                (None, _) => label.clone(),
            };
            let bw = (measure_text_span(&badge_text, 11.0, true) + 18.0).min(w.max(80.0));
            let _ = writeln!(
                out,
                r#"<rect x="{:.1}" y="{:.1}" width="{bw:.1}" height="22" rx="11" fill="{accent}"/>"#,
                x + 10.0,
                y - 11.0
            );
            let _ = writeln!(
                out,
                r#"<text x="{:.1}" y="{y:.1}" dominant-baseline="central" font-family="{DIAGRAM_FONT_SANS}" font-size="10.5" font-weight="600" fill="{}">{}</text>"#,
                x + 19.0,
                colors.pill_ink,
                esc_text(&badge_text)
            );
        }
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
                let color = stroke.as_deref().unwrap_or(colors.arrow_default);
                let dash = match style {
                    StrokeStyle::Solid => "",
                    StrokeStyle::Dashed => r#" stroke-dasharray="7 5""#,
                    StrokeStyle::Dotted => r#" stroke-dasharray="2 5""#,
                };
                let d = route_shape_svg_d(&geom.shape);
                let _ = writeln!(
                    out,
                    r#"<path d="{d}" fill="none" stroke="{color}" stroke-width="{stroke_width:.2}" stroke-linecap="round" stroke-linejoin="round"{dash}/>"#
                );
                let scale = (f64::from(*stroke_width) / 1.75).clamp(0.85, 1.45);
                if let Some(hs) = arrowhead_geometry(
                    geom.start,
                    crate::engine::whiteboard::model::Vec2::new(-geom.start_dir.x, -geom.start_dir.y),
                    *start_head,
                    scale,
                ) {
                    write_svg_head(out, hs, color);
                }
                if let Some(hs) = arrowhead_geometry(geom.end, geom.end_dir, *end_head, scale) {
                    write_svg_head(out, hs, color);
                }
                if let Some(txt) = label
                    && !txt.trim().is_empty()
                {
                    let lw = measure_text_span(txt, 11.5, true) + 16.0;
                    let _ = writeln!(
                        out,
                        r#"<rect x="{:.1}" y="{:.1}" width="{lw:.1}" height="22" rx="6" fill="{}" stroke="{}" stroke-width="1"/>"#,
                        geom.label_pos.x - lw * 0.5,
                        geom.label_pos.y - 11.0,
                        colors.arrow_label_bg,
                        colors.line
                    );
                    let _ = writeln!(
                        out,
                        r#"<text x="{:.1}" y="{:.1}" text-anchor="middle" dominant-baseline="central" font-family="{DIAGRAM_FONT_SANS}" font-size="11" font-weight="600" fill="{}">{}</text>"#,
                        geom.label_pos.x,
                        geom.label_pos.y,
                        colors.ink,
                        esc_text(txt)
                    );
                }
            }
        }
        ElementKind::Timeline {
            x,
            y,
            w,
            h,
            points,
            milestones,
            ..
        } => {
            let ribbon_pts: Vec<Point2> = if points.len() >= 2 {
                points.clone()
            } else {
                vec![
                    Point2::new(*x, y + h * 0.5 + 10.0),
                    Point2::new(x + w * 0.5, y + h * 0.5 - 4.0),
                    Point2::new(x + w, y + h * 0.5 - 16.0),
                ]
            };
            let segs: Vec<CubicSegment> = catmull_rom_cubics(&ribbon_pts, 0.55);
            let d = cubics_to_svg_path(&segs);
            let halo_color = colors.page;
            let _ = writeln!(
                out,
                r#"<path d="{d}" fill="none" stroke="{halo_color}" stroke-opacity="0.78" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>"#
            );
            let _ = writeln!(
                out,
                r#"<path d="{d}" fill="none" stroke="url(#wb-tl-grad)" stroke-width="11.5" stroke-linecap="round" stroke-linejoin="round"/>"#
            );
            let total = milestones.len().max(1);
            for (idx, m) in milestones.iter().enumerate() {
                let pt = m
                    .pos
                    .unwrap_or_else(|| sample_polyline(&ribbon_pts, m.t.unwrap_or((idx + 1) as f64 / (total + 1) as f64)));
                match m.kind {
                    MilestoneKind::Minor => {
                        let _ = writeln!(
                            out,
                            r#"<circle cx="{:.1}" cy="{:.1}" r="10.5" fill="{}" stroke="{}" stroke-width="1.6"/>"#,
                            pt.x, pt.y, colors.minor_bg, colors.minor_border
                        );
                        if !m.label.is_empty() {
                            let _ = writeln!(
                                out,
                                r#"<text x="{:.1}" y="{:.1}" text-anchor="middle" dominant-baseline="central" font-family="{DIAGRAM_FONT_SANS}" font-size="10.5" font-weight="600" fill="{}">{}</text>"#,
                                pt.x,
                                pt.y,
                                colors.muted,
                                esc_text(&m.label)
                            );
                        }
                    }
                    MilestoneKind::Major => {
                        let pw = (measure_text_span(&m.label, 12.0, true) + 22.0).max(52.0);
                        let ph = 26.0;
                        let fill = m.tone.as_deref().unwrap_or(colors.pill_bg);
                        let _ = writeln!(
                            out,
                            r#"<rect x="{:.1}" y="{:.1}" width="{pw:.1}" height="{ph:.1}" rx="13" fill="{fill}" filter="url(#wb-shadow)"/>"#,
                            pt.x - pw * 0.5,
                            pt.y - ph * 0.5
                        );
                        if !m.label.is_empty() {
                            let _ = writeln!(
                                out,
                                r#"<text x="{:.1}" y="{:.1}" text-anchor="middle" dominant-baseline="central" font-family="{DIAGRAM_FONT_SANS}" font-size="12" font-weight="600" fill="{}">{}</text>"#,
                                pt.x,
                                pt.y,
                                colors.pill_ink,
                                esc_text(&m.label)
                            );
                        }
                    }
                }
                if let Some(cap) = &m.caption
                    && !cap.trim().is_empty()
                {
                    let _ = writeln!(
                        out,
                        r#"<text x="{:.1}" y="{:.1}" text-anchor="middle" font-family="{DIAGRAM_FONT_SANS}" font-size="12" font-weight="600" fill="{}">{}</text>"#,
                        pt.x,
                        pt.y + 28.0,
                        colors.ink,
                        esc_text(cap)
                    );
                }
            }
        }
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
        } => {
            let rect = Rect2::new(*x, *y, *w, *h);
            let (tone_fill, tone_border, tone_ink) = shape_tone_hex(*shape, fill, dark);
            let border = stroke.as_deref().unwrap_or(tone_border);
            let r = corner_radius.unwrap_or(match shape {
                ShapeKind::Card | ShapeKind::Sticky | ShapeKind::Rounded => 10.0,
                ShapeKind::Rect => 2.0,
                ShapeKind::Pill => (rect.h.min(rect.w) * 0.5) as f32,
                _ => 10.0,
            });
            let filter_attr = if matches!(shape, ShapeKind::Card | ShapeKind::Sticky) {
                r#" filter="url(#wb-shadow)""#
            } else {
                ""
            };
            let dash = match stroke_style {
                StrokeStyle::Solid => "",
                StrokeStyle::Dashed => r#" stroke-dasharray="6 4""#,
                StrokeStyle::Dotted => r#" stroke-dasharray="2 4""#,
            };
            write_svg_shape_geom(out, rect, *shape, (r, dash), (tone_fill, border, filter_attr));

            let has_sticker = resolve_sticker_svg(sticker.as_deref(), sticker_svg.as_deref());
            if let Some(svg_src) = has_sticker {
                let sw = 58.0;
                let sh = 58.0;
                write_nested_svg(out, x + (w - sw) * 0.5, y - 24.0, sw, sh, svg_src);
            }

            if let Some(b) = badge
                && !b.trim().is_empty()
            {
                let bw = (measure_text_span(b, 9.5, true) + 12.0).max(28.0);
                let _ = writeln!(
                    out,
                    r#"<rect x="{:.1}" y="{:.1}" width="{bw:.1}" height="18" rx="9" fill="{}"/>"#,
                    rect.right() - bw - 8.0,
                    rect.y + 8.0,
                    colors.pill_bg
                );
                let _ = writeln!(
                    out,
                    r#"<text x="{:.1}" y="{:.1}" text-anchor="middle" dominant-baseline="central" font-family="{DIAGRAM_FONT_SANS}" font-size="9.5" font-weight="600" fill="{}">{}</text>"#,
                    rect.right() - bw * 0.5 - 8.0,
                    rect.y + 17.0,
                    colors.pill_ink,
                    esc_text(b)
                );
            }

            if !title.trim().is_empty() || !body.trim().is_empty() {
                let layout = layout_card(rect, title, body, has_sticker.is_some());
                let (tx, anchor) = match align {
                    TextAlign::Left => (rect.x + 12.0, "start"),
                    TextAlign::Center => (rect.center().x, "middle"),
                    TextAlign::Right => (rect.right() - 12.0, "end"),
                };
                let compact = rect.h <= 44.0;
                let (fs, fw) = if compact {
                    ("12.5", "400")
                } else if body.trim().is_empty() {
                    ("13", "500")
                } else {
                    ("13", "600")
                };
                let baseline_off = if compact { 11.0 } else { 11.5 };
                for (i, line) in layout.title_lines.iter().enumerate() {
                    let ly = layout.title_y + i as f64 * layout.line_height_title + baseline_off;
                    let _ = writeln!(
                        out,
                        r#"<text x="{tx:.1}" y="{ly:.1}" text-anchor="{anchor}" font-family="{DIAGRAM_FONT_SANS}" font-size="{fs}" font-weight="{fw}" fill="{tone_ink}">{}</text>"#,
                        esc_text(line)
                    );
                }
                for (i, line) in layout.body_lines.iter().enumerate() {
                    let ly = layout.body_y + i as f64 * layout.line_height_body + 10.5;
                    let _ = writeln!(
                        out,
                        r#"<text x="{tx:.1}" y="{ly:.1}" text-anchor="{anchor}" font-family="{DIAGRAM_FONT_SANS}" font-size="11.5" fill="{tone_ink}" fill-opacity="0.84">{}</text>"#,
                        esc_text(line)
                    );
                }
            }
        }
        ElementKind::Table {
            x,
            y,
            w,
            h,
            headers,
            rows,
            fill,
        } => {
            let rect = Rect2::new(*x, *y, *w, *h);
            let (tone_fill, tone_border, _) = fill_tone_hex(fill, dark);
            let layout = layout_table(rect, headers, rows);
            let _ = writeln!(
                out,
                r#"<rect x="{x:.1}" y="{y:.1}" width="{w:.1}" height="{h:.1}" rx="8" fill="{tone_fill}" stroke="{tone_border}" stroke-width="1.2" filter="url(#wb-shadow)"/>"#
            );
            if layout.header_height > 0.0 {
                let _ = writeln!(
                    out,
                    r#"<rect x="{x:.1}" y="{y:.1}" width="{w:.1}" height="{:.1}" rx="8" fill="{}"/>"#,
                    layout.header_height, colors.table_header_bg
                );
                let _ = writeln!(
                    out,
                    r#"<line x1="{x:.1}" y1="{:.1}" x2="{:.1}" y2="{:.1}" stroke="{tone_border}" stroke-width="1.1"/>"#,
                    y + layout.header_height,
                    rect.right(),
                    y + layout.header_height
                );
            }
            for c in 1..layout.col_count {
                let cx = x + c as f64 * layout.col_width;
                let _ = writeln!(
                    out,
                    r#"<line x1="{cx:.1}" y1="{y:.1}" x2="{cx:.1}" y2="{:.1}" stroke="{}" stroke-width="1"/>"#,
                    rect.bottom(),
                    colors.line
                );
            }
            for r_idx in 1..rows.len() {
                let ry = y + layout.header_height + r_idx as f64 * layout.row_height;
                if ry < rect.bottom() {
                    let _ = writeln!(
                        out,
                        r#"<line x1="{x:.1}" y1="{ry:.1}" x2="{:.1}" y2="{ry:.1}" stroke="{}" stroke-width="1"/>"#,
                        rect.right(),
                        colors.line
                    );
                }
            }
            for (c, hdr) in headers.iter().take(layout.col_count).enumerate() {
                let _ = writeln!(
                    out,
                    r#"<text x="{:.1}" y="{:.1}" dominant-baseline="central" font-family="{DIAGRAM_FONT_SANS}" font-size="12" font-weight="600" fill="{}">{}</text>"#,
                    x + c as f64 * layout.col_width + 10.0,
                    y + layout.header_height * 0.5,
                    colors.ink,
                    esc_text(hdr)
                );
            }
            for (r_idx, row) in rows.iter().enumerate() {
                let cy = y + layout.header_height + (r_idx as f64 + 0.5) * layout.row_height;
                if cy > rect.bottom() - 4.0 {
                    break;
                }
                for (c, cell) in row.iter().take(layout.col_count).enumerate() {
                    let _ = writeln!(
                        out,
                        r#"<text x="{:.1}" y="{cy:.1}" dominant-baseline="central" font-family="{DIAGRAM_FONT_SANS}" font-size="11.5" fill="{}">{}</text>"#,
                        x + c as f64 * layout.col_width + 10.0,
                        colors.muted,
                        esc_text(cell)
                    );
                }
            }
        }
        ElementKind::Image { x, y, w, h, alt, uri, .. } => {
            let _ = writeln!(
                out,
                r#"<rect x="{x:.1}" y="{y:.1}" width="{w:.1}" height="{h:.1}" rx="10" fill="{}" stroke="{}" stroke-width="1.25"/>"#,
                colors.side, colors.container_border
            );
            let cx = x + w * 0.5;
            let cy = y + h * 0.5 - 6.0;
            let _ = writeln!(
                out,
                r#"<polygon points="{:.1},{:.1} {:.1},{:.1} {:.1},{:.1} {:.1},{:.1} {:.1},{:.1}" fill="{}"/>"#,
                cx - 22.0,
                cy + 14.0,
                cx - 7.0,
                cy - 6.0,
                cx + 6.0,
                cy + 8.0,
                cx + 14.0,
                cy - 1.0,
                cx + 24.0,
                cy + 14.0,
                colors.faint
            );
            let caption = alt.as_deref().filter(|s| !s.is_empty()).unwrap_or(uri);
            if !caption.is_empty() {
                let _ = writeln!(
                    out,
                    r#"<text x="{cx:.1}" y="{:.1}" text-anchor="middle" font-family="{DIAGRAM_FONT_SANS}" font-size="11" fill="{}">{}</text>"#,
                    y + h - 10.0,
                    colors.muted,
                    esc_text(caption)
                );
            }
        }
        ElementKind::HtmlEmbed { x, y, w, h, title, .. } => {
            let _ = writeln!(
                out,
                r#"<rect x="{x:.1}" y="{y:.1}" width="{w:.1}" height="{h:.1}" rx="10" fill="{}" stroke="{}" stroke-width="1.25"/>"#,
                fill_tone_hex(&WbFill::Default, dark).0,
                colors.container_border
            );
            let _ = writeln!(
                out,
                r#"<rect x="{x:.1}" y="{y:.1}" width="{w:.1}" height="26" rx="10" fill="{}"/>"#,
                colors.container_header_bg
            );
            let _ = writeln!(
                out,
                r#"<text x="{:.1}" y="{:.1}" dominant-baseline="central" font-family="{DIAGRAM_FONT_SANS}" font-size="11" font-weight="600" fill="{}">{}</text>"#,
                x + 10.0,
                y + 13.0,
                colors.ink,
                esc_text(title.as_deref().unwrap_or("Embed"))
            );
        }
        ElementKind::Text {
            x,
            y,
            w,
            h,
            variant,
            label,
            highlight,
            align,
            font_size,
            fill,
            color,
            ..
        } => {
            if let Some(bg_fill) = fill {
                let (bf, bb, _) = fill_tone_hex(bg_fill, dark);
                let _ = writeln!(
                    out,
                    r#"<rect x="{x:.1}" y="{y:.1}" width="{w:.1}" height="{h:.1}" rx="8" fill="{bf}" stroke="{bb}" stroke-width="1"/>"#
                );
            }
            let ink = color.as_deref().unwrap_or(match variant {
                TextVariant::Subtitle => colors.muted,
                _ => colors.ink,
            });
            match variant {
                TextVariant::Title => {
                    let fs = font_size.unwrap_or(30.0);
                    let (tx, anchor) = match align {
                        TextAlign::Left => (*x, "start"),
                        TextAlign::Center => (x + w * 0.5, "middle"),
                        TextAlign::Right => (x + w, "end"),
                    };
                    let _ = writeln!(
                        out,
                        r#"<text x="{tx:.1}" y="{:.1}" text-anchor="{anchor}" font-family="{FONT_SERIF}" font-size="{fs:.1}" fill="{ink}">{}</text>"#,
                        y + f64::from(fs) * 0.92,
                        esc_text(label)
                    );
                }
                TextVariant::Subtitle => {
                    let fs = font_size.unwrap_or(13.5);
                    if let Some(hl) = highlight.as_deref()
                        && let Some(span) = locate_highlight_span(label, hl, f64::from(fs), *w, *align)
                    {
                        let pill_x = x + span.box_offset_x;
                        let _ = writeln!(
                            out,
                            r#"<rect x="{pill_x:.1}" y="{y:.1}" width="{:.1}" height="21" rx="4" fill="{}"/>"#,
                            span.box_width, colors.highlight_bg
                        );
                        let (tx, anchor) = match align {
                            TextAlign::Left => (*x, "start"),
                            TextAlign::Center => (x + w * 0.5, "middle"),
                            TextAlign::Right => (x + w, "end"),
                        };
                        let ty = y + 14.5;
                        let _ = writeln!(
                            out,
                            r#"<text x="{tx:.1}" y="{ty:.1}" text-anchor="{anchor}" font-family="{DIAGRAM_FONT_SANS}" font-size="{fs:.1}" fill="{ink}"><tspan>{}</tspan><tspan fill="{}" font-weight="500">{}</tspan><tspan>{}</tspan></text>"#,
                            esc_text(&span.before),
                            colors.highlight_ink,
                            esc_text(&span.highlighted),
                            esc_text(&span.after)
                        );
                    } else {
                        let _ = writeln!(
                            out,
                            r#"<text x="{x:.1}" y="{:.1}" font-family="{DIAGRAM_FONT_SANS}" font-size="{fs:.1}" fill="{ink}">{}</text>"#,
                            y + 14.5,
                            esc_text(label)
                        );
                    }
                }
                TextVariant::Callout => {
                    let ix = x + 12.0;
                    let iy = y + 15.0;
                    let _ = writeln!(
                        out,
                        r##"<polygon points="{ix:.1},{:.1} {:.1},{:.1} {:.1},{:.1}" fill="#ffe380" stroke="{}" stroke-width="1.5" stroke-linejoin="round"/>"##,
                        iy - 9.0,
                        ix + 9.0,
                        iy + 7.0,
                        ix - 9.0,
                        iy + 7.0,
                        colors.ink
                    );
                    let _ = writeln!(
                        out,
                        r##"<text x="{ix:.1}" y="{:.1}" text-anchor="middle" dominant-baseline="central" font-family="{DIAGRAM_FONT_SANS}" font-size="10" font-weight="700" fill="#1c1917">!</text>"##,
                        iy + 1.5
                    );
                    let lines = wrap_text(label, (w - 34.0).max(60.0), 12.0, false, 3);
                    for (i, line) in lines.iter().enumerate() {
                        let _ = writeln!(
                            out,
                            r#"<text x="{:.1}" y="{:.1}" font-family="{DIAGRAM_FONT_SANS}" font-size="12" font-weight="500" fill="{}">{}</text>"#,
                            x + 28.0,
                            y + 16.5 + i as f64 * 16.0,
                            colors.ink,
                            esc_text(line)
                        );
                    }
                }
                TextVariant::Body => {
                    let fs = font_size.unwrap_or(13.0);
                    let lines = wrap_text(label, (w - 16.0).max(48.0), f64::from(fs), false, 6);
                    let (tx, anchor) = match align {
                        TextAlign::Left => (x + 8.0, "start"),
                        TextAlign::Center => (x + w * 0.5, "middle"),
                        TextAlign::Right => (x + w - 8.0, "end"),
                    };
                    for (i, line) in lines.iter().enumerate() {
                        let _ = writeln!(
                            out,
                            r#"<text x="{tx:.1}" y="{:.1}" text-anchor="{anchor}" font-family="{DIAGRAM_FONT_SANS}" font-size="{fs:.1}" fill="{ink}">{}</text>"#,
                            y + 16.0 + i as f64 * (f64::from(fs) + 5.0),
                            esc_text(line)
                        );
                    }
                }
            }
        }
        ElementKind::Sticker { x, y, w, h, sticker, svg, .. } => {
            if let Some(svg_src) = resolve_sticker_svg(Some(sticker.as_str()), svg.as_deref()) {
                write_nested_svg(out, *x, *y, *w, *h, svg_src);
            }
        }
        ElementKind::Svg { x, y, w, h, svg, .. } => {
            write_nested_svg(out, *x, *y, *w, *h, svg);
        }
        ElementKind::Path {
            points,
            stroke,
            stroke_width,
            mode,
        } => {
            let outline = build_ink_outline(points, *stroke_width, *mode);
            if !outline.is_empty() {
                let op = if *mode == InkMode::Highlighter { "0.34" } else { "0.95" };
                let mut d = String::with_capacity(outline.len() * 16);
                for (i, pt) in outline.iter().enumerate() {
                    if i == 0 {
                        let _ = write!(d, "M {:.2} {:.2}", pt.x, pt.y);
                    } else {
                        let _ = write!(d, " L {:.2} {:.2}", pt.x, pt.y);
                    }
                }
                d.push_str(" Z");
                let _ = writeln!(out, r#"<path d="{d}" fill="{}" fill-opacity="{op}"/>"#, esc_attr(stroke));
            }
        }
    }

    if has_rot || has_alpha {
        out.push_str("</g>");
    }
}
