use std::fmt::Write as _;

use crate::engine::whiteboard::geometry::{HeadShape, RouteShape, cubics_to_svg_path};
use crate::engine::whiteboard::layout::measure_text_span;
use crate::engine::whiteboard::model::{BoardDoc, ElementKind, GridStyle, Presence, PresenceKind, Rect2, ShapeKind};
use crate::theme::DIAGRAM_FONT_SANS;

use super::export_bounds;
use super::palette::{SvgColors, presence_hex};
use super::svg_elements::write_svg_element;

pub fn export_svg(doc: &BoardDoc, dark: bool) -> String {
    let colors = SvgColors::for_mode(dark);
    let bounds = export_bounds(doc);
    let lookup = doc.rect_lookup();
    let page_fill = doc.meta.background.as_deref().unwrap_or(colors.page);

    let mut out = String::with_capacity(16 * 1024);
    let _ = writeln!(
        out,
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{}" height="{}" viewBox="{} {} {} {}">"#,
        bounds.w.ceil(),
        bounds.h.ceil(),
        bounds.x,
        bounds.y,
        bounds.w,
        bounds.h
    );

    let _ = writeln!(
        out,
        r#"<defs><filter id="wb-shadow" x="-15%" y="-15%" width="130%" height="140%"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="{}" flood-opacity="{}"/></filter>"#,
        colors.shadow_color, colors.shadow_opacity
    );
    let _ = writeln!(
        out,
        r#"<linearGradient id="wb-tl-grad" x1="0%" y1="50%" x2="100%" y2="50%"><stop offset="0%" stop-color="{}"/><stop offset="55%" stop-color="{}"/><stop offset="100%" stop-color="{}"/></linearGradient></defs>"#,
        colors.tl_start, colors.tl_mid, colors.tl_end
    );

    let _ = writeln!(
        out,
        r#"<rect x="{}" y="{}" width="{}" height="{}" fill="{}"/>"#,
        bounds.x,
        bounds.y,
        bounds.w,
        bounds.h,
        esc_attr(page_fill)
    );

    write_svg_grid(&mut out, doc.meta.grid, bounds, colors);

    // Same 7-pass layering as paint: Containers/Claims -> Arrows -> Timelines -> Shapes/Tables -> Text -> Stickers/Svg -> Ink -> Presences.
    for pass in 0..7 {
        for el in &doc.elements {
            let matches_pass = match pass {
                0 => matches!(el.kind, ElementKind::Container { .. } | ElementKind::Claim { .. }),
                1 => matches!(el.kind, ElementKind::Arrow { .. }),
                2 => matches!(el.kind, ElementKind::Timeline { .. }),
                3 => matches!(
                    el.kind,
                    ElementKind::Shape { .. } | ElementKind::Table { .. } | ElementKind::Image { .. } | ElementKind::HtmlEmbed { .. }
                ),
                4 => matches!(el.kind, ElementKind::Text { .. }),
                5 => matches!(el.kind, ElementKind::Sticker { .. } | ElementKind::Svg { .. }),
                _ => matches!(el.kind, ElementKind::Path { .. }),
            };
            if matches_pass {
                write_svg_element(&mut out, el, &lookup, colors, dark);
            }
        }
    }

    write_svg_presences(&mut out, &doc.presences, colors, dark);

    out.push_str("</svg>");
    out
}

fn write_svg_grid(out: &mut String, grid: GridStyle, bounds: Rect2, colors: &SvgColors) {
    match grid {
        GridStyle::None => {}
        GridStyle::Architectural => {
            let step = 24.0;
            let major = 120.0;
            let start_x = (bounds.x / step).floor() * step;
            let start_y = (bounds.y / step).floor() * step;
            let mut x = start_x;
            while x <= bounds.right() {
                let is_major = (x / major).fract().abs() < 0.01 || ((x / major).fract().abs() - 1.0).abs() < 0.01;
                let stroke = if is_major { colors.grid_major } else { colors.grid_minor };
                let _ = writeln!(
                    out,
                    r#"<line x1="{x:.1}" y1="{:.1}" x2="{x:.1}" y2="{:.1}" stroke="{stroke}" stroke-width="1"/>"#,
                    bounds.y,
                    bounds.bottom()
                );
                x += step;
            }
            let mut y = start_y;
            while y <= bounds.bottom() {
                let is_major = (y / major).fract().abs() < 0.01 || ((y / major).fract().abs() - 1.0).abs() < 0.01;
                let stroke = if is_major { colors.grid_major } else { colors.grid_minor };
                let _ = writeln!(
                    out,
                    r#"<line x1="{:.1}" y1="{y:.1}" x2="{:.1}" y2="{y:.1}" stroke="{stroke}" stroke-width="1"/>"#,
                    bounds.x,
                    bounds.right()
                );
                y += step;
            }
        }
        GridStyle::Dots => {
            let step = 24.0;
            let start_x = (bounds.x / step).floor() * step;
            let start_y = (bounds.y / step).floor() * step;
            let mut x = start_x;
            while x <= bounds.right() {
                let mut y = start_y;
                while y <= bounds.bottom() {
                    let _ = writeln!(out, r#"<circle cx="{x:.1}" cy="{y:.1}" r="1.2" fill="{}"/>"#, colors.grid_dot);
                    y += step;
                }
                x += step;
            }
        }
    }
}

pub(super) fn write_svg_shape_geom(
    out: &mut String,
    rect: Rect2,
    shape: ShapeKind,
    (r, dash_attr): (f32, &str),
    (fill, border, filter_attr): (&str, &str, &str),
) {
    match shape {
        ShapeKind::Card | ShapeKind::Sticky | ShapeKind::Rect | ShapeKind::Rounded | ShapeKind::Pill => {
            let _ = writeln!(
                out,
                r#"<rect x="{:.1}" y="{:.1}" width="{:.1}" height="{:.1}" rx="{r:.1}" fill="{fill}" stroke="{border}" stroke-width="1.2"{dash_attr}{filter_attr}/>"#,
                rect.x, rect.y, rect.w, rect.h
            );
        }
        ShapeKind::Ellipse => {
            let _ = writeln!(
                out,
                r#"<ellipse cx="{:.1}" cy="{:.1}" rx="{:.1}" ry="{:.1}" fill="{fill}" stroke="{border}" stroke-width="1.25"{dash_attr}/>"#,
                rect.center().x,
                rect.center().y,
                rect.w * 0.5,
                rect.h * 0.5
            );
        }
        ShapeKind::Diamond => {
            let c = rect.center();
            let _ = writeln!(
                out,
                r#"<polygon points="{:.1},{:.1} {:.1},{:.1} {:.1},{:.1} {:.1},{:.1}" fill="{fill}" stroke="{border}" stroke-width="1.25" stroke-linejoin="round"{dash_attr}/>"#,
                c.x,
                rect.y,
                rect.right(),
                c.y,
                c.x,
                rect.bottom(),
                rect.x,
                c.y
            );
        }
        ShapeKind::Triangle => {
            let c = rect.center();
            let _ = writeln!(
                out,
                r#"<polygon points="{:.1},{:.1} {:.1},{:.1} {:.1},{:.1}" fill="{fill}" stroke="{border}" stroke-width="1.25" stroke-linejoin="round"{dash_attr}/>"#,
                c.x,
                rect.y,
                rect.right(),
                rect.bottom(),
                rect.x,
                rect.bottom()
            );
        }
        ShapeKind::Cylinder => {
            let ry = (rect.h * 0.16).clamp(8.0, 18.0);
            let _ = writeln!(
                out,
                r#"<path d="M {:.1} {:.1} C {:.1} {:.1} {:.1} {:.1} {:.1} {:.1} L {:.1} {:.1} C {:.1} {:.1} {:.1} {:.1} {:.1} {:.1} Z" fill="{fill}" stroke="{border}" stroke-width="1.25"{dash_attr}/>"#,
                rect.x,
                rect.y + ry,
                rect.x,
                rect.y,
                rect.right(),
                rect.y,
                rect.right(),
                rect.y + ry,
                rect.right(),
                rect.bottom() - ry,
                rect.right(),
                rect.bottom(),
                rect.x,
                rect.bottom(),
                rect.x,
                rect.bottom() - ry,
            );
            let _ = writeln!(
                out,
                r#"<ellipse cx="{:.1}" cy="{:.1}" rx="{:.1}" ry="{ry:.1}" fill="none" stroke="{border}" stroke-width="1.25"/>"#,
                rect.center().x,
                rect.y + ry,
                rect.w * 0.5
            );
        }
    }
}

pub(super) fn write_svg_head(out: &mut String, shape: HeadShape, color: &str) {
    match shape {
        HeadShape::Triangle([a, b, c]) => {
            let _ = writeln!(
                out,
                r#"<polygon points="{:.1},{:.1} {:.1},{:.1} {:.1},{:.1}" fill="{color}"/>"#,
                a.x, a.y, b.x, b.y, c.x, c.y
            );
        }
        HeadShape::Diamond([a, b, c, d]) => {
            let _ = writeln!(
                out,
                r#"<polygon points="{:.1},{:.1} {:.1},{:.1} {:.1},{:.1} {:.1},{:.1}" fill="{color}"/>"#,
                a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y
            );
        }
        HeadShape::Circle { center, radius } => {
            let _ = writeln!(out, r#"<circle cx="{:.1}" cy="{:.1}" r="{radius:.1}" fill="{color}"/>"#, center.x, center.y);
        }
    }
}

fn write_svg_presences(out: &mut String, presences: &[Presence], colors: &SvgColors, dark: bool) {
    for p in presences {
        let color = p.custom_color.as_deref().unwrap_or_else(|| presence_hex(p.color, dark));
        let status_opt = p.status.as_deref().map(str::trim).filter(|s| !s.is_empty());

        if let Some(r) = p.region_rect() {
            let _ = writeln!(
                out,
                r#"<rect x="{:.1}" y="{:.1}" width="{:.1}" height="{:.1}" rx="12" fill="{}" fill-opacity="0.09" stroke="{}" stroke-width="1.6" stroke-dasharray="6 4"/>"#,
                r.x,
                r.y,
                r.w,
                r.h,
                esc_attr(color),
                esc_attr(color)
            );
            let badge = match status_opt {
                Some(st) => format!("{} · {st}", p.name),
                None => p.name.clone(),
            };
            let bw = (measure_text_span(&badge, 11.0, true) + 18.0).max(48.0);
            let _ = writeln!(
                out,
                r#"<rect x="{:.1}" y="{:.1}" width="{bw:.1}" height="22" rx="11" fill="{}"/>"#,
                r.x + 10.0,
                r.y - 11.0,
                esc_attr(color)
            );
            let _ = writeln!(
                out,
                r#"<text x="{:.1}" y="{:.1}" text-anchor="middle" dominant-baseline="central" font-family="{DIAGRAM_FONT_SANS}" font-size="11" font-weight="600" fill="{}">{}</text>"#,
                r.x + 10.0 + bw * 0.5,
                r.y,
                colors.pill_ink,
                esc_text(&badge)
            );
            if matches!(p.kind, PresenceKind::Highlight | PresenceKind::Claim) {
                continue;
            }
        }

        if !p.has_cursor {
            continue;
        }
        let _ = writeln!(out, r#"<g transform="translate({:.1} {:.1})">"#, p.x, p.y);
        let _ = writeln!(
            out,
            r#"<polygon points="0,0 11,5.5 6,7.2 4.2,12.2" fill="{}" stroke="{}" stroke-width="1.2"/>"#,
            esc_attr(color),
            colors.page
        );
        if let Some(msg) = status_opt
            && msg.chars().count() > 14
        {
            let pill_w = (measure_text_span(msg, 12.5, false) + 52.0).clamp(160.0, 580.0);
            let close_cx = 10.0 + pill_w - 17.0;
            let close_cy = 26.0;
            let _ = writeln!(
                out,
                r#"<rect x="10" y="10" width="{pill_w:.1}" height="32" rx="10" fill="{color}" filter="url(#wb-shadow)"/>"#
            );
            let _ = writeln!(
                out,
                r#"<text x="24" y="26" text-anchor="start" dominant-baseline="central" font-family="{DIAGRAM_FONT_SANS}" font-size="12.5" font-weight="500" fill="{}">{}</text>"#,
                colors.pill_ink,
                esc_text(msg)
            );
            let _ = writeln!(
                out,
                r#"<path d="M {:.1} {:.1} L {:.1} {:.1} M {:.1} {:.1} L {:.1} {:.1}" stroke="{}" stroke-opacity="0.85" stroke-width="1.4" stroke-linecap="round"/>"#,
                close_cx - 3.5,
                close_cy - 3.5,
                close_cx + 3.5,
                close_cy + 3.5,
                close_cx + 3.5,
                close_cy - 3.5,
                close_cx - 3.5,
                close_cy + 3.5,
                colors.pill_ink
            );
        } else {
            let label = match status_opt {
                Some(st) => format!("{} · {st}", p.name),
                None => p.name.clone(),
            };
            let pill_w = (measure_text_span(&label, 11.5, true) + 18.0).max(40.0);
            let _ = writeln!(
                out,
                r#"<rect x="10" y="10" width="{pill_w:.1}" height="22" rx="11" fill="{color}" filter="url(#wb-shadow)"/>"#
            );
            let _ = writeln!(
                out,
                r#"<text x="{:.1}" y="21" text-anchor="middle" dominant-baseline="central" font-family="{DIAGRAM_FONT_SANS}" font-size="11.5" font-weight="600" fill="{}">{}</text>"#,
                10.0 + pill_w * 0.5,
                colors.pill_ink,
                esc_text(&label)
            );
        }
        out.push_str("</g>");
    }
}

pub(super) fn route_shape_svg_d(shape: &RouteShape) -> String {
    match shape {
        RouteShape::Polyline(pts) => {
            let mut d = String::new();
            for (i, p) in pts.iter().enumerate() {
                if i == 0 {
                    let _ = write!(d, "M {:.1} {:.1}", p.x, p.y);
                } else {
                    let _ = write!(d, " L {:.1} {:.1}", p.x, p.y);
                }
            }
            d
        }
        RouteShape::Cubics(segs) => cubics_to_svg_path(segs),
    }
}

pub(super) fn write_nested_svg(out: &mut String, x: f64, y: f64, w: f64, h: f64, raw: &str) {
    let trimmed = raw.trim();
    if let (Some(open_end), Some(close_start)) = (trimmed.find('>'), trimmed.rfind("</svg>"))
        && open_end < close_start
    {
        let open_tag = &trimmed[..open_end];
        let inner = &trimmed[open_end + 1..close_start];
        let view_box = extract_attr(open_tag, "viewBox").unwrap_or("0 0 64 64");
        let _ = writeln!(
            out,
            r#"<svg x="{x:.1}" y="{y:.1}" width="{w:.1}" height="{h:.1}" viewBox="{}">{inner}</svg>"#,
            esc_attr(view_box)
        );
    }
}

fn extract_attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let needle_dq = format!("{name}=\"");
    if let Some(idx) = tag.find(&needle_dq) {
        let rest = &tag[idx + needle_dq.len()..];
        if let Some(end) = rest.find('"') {
            return Some(&rest[..end]);
        }
    }
    let needle_sq = format!("{name}='");
    if let Some(idx) = tag.find(&needle_sq) {
        let rest = &tag[idx + needle_sq.len()..];
        if let Some(end) = rest.find('\'') {
            return Some(&rest[..end]);
        }
    }
    None
}

pub(super) fn esc_text(raw: &str) -> String {
    quick_xml::escape::partial_escape(raw).into_owned()
}

pub(super) fn esc_attr(raw: &str) -> String {
    quick_xml::escape::escape(raw).into_owned()
}
