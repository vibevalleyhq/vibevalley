use std::collections::{BTreeSet, HashMap};
use std::fmt::Write as _;

use nsh_core::prelude::{Bounds, Painter, point, px, size};

use crate::engine::canvas::{Canvas, CanvasColor, Edge, End, Node as CanvasNode, NodeBounds, PresetColor, Side};
use crate::engine::whiteboard::codec::encode_element_json;
use crate::engine::whiteboard::geometry::{
    CubicSegment, HeadShape, RouteShape, arrowhead_geometry, catmull_rom_cubics, cubics_to_svg_path, route_arrow, sample_polyline,
};
use crate::engine::whiteboard::ink::build_ink_outline;
use crate::engine::whiteboard::layout::{layout_card, layout_table, locate_highlight_span, measure_text_span, wrap_text};
use crate::engine::whiteboard::model::{
    AnchorSide, ArrowEndpoint, ArrowHead, BoardDoc, ElementId, ElementKind, ElementRecord, GridStyle, InkMode, MilestoneKind, Point2, PresenceColor, Rect2,
    ShapeKind, StrokeStyle, TextAlign, TextVariant, WbFill,
};
use crate::engine::whiteboard::paint::{WhiteboardPalette, paint_board_into_painter, paint_grid, paint_presences_into_painter, parse_hex_hsla};
use crate::engine::whiteboard::stickers::resolve_sticker_svg;
use crate::theme::DIAGRAM_FONT_SANS;

const FONT_SERIF: &str = "Georgia, Songti SC, STSong, Times New Roman, serif";

struct SvgColors {
    page: &'static str,
    side: &'static str,
    ink: &'static str,
    muted: &'static str,
    faint: &'static str,
    line: &'static str,
    grid_minor: &'static str,
    grid_major: &'static str,
    grid_dot: &'static str,
    tl_start: &'static str,
    tl_mid: &'static str,
    tl_end: &'static str,
    pill_bg: &'static str,
    pill_ink: &'static str,
    minor_bg: &'static str,
    minor_border: &'static str,
    highlight_bg: &'static str,
    highlight_ink: &'static str,
    arrow_default: &'static str,
    arrow_label_bg: &'static str,
    container_bg: &'static str,
    container_border: &'static str,
    container_header_bg: &'static str,
    table_header_bg: &'static str,
    shadow_color: &'static str,
    shadow_opacity: &'static str,
}

impl SvgColors {
    const LIGHT: Self = Self {
        page: "#fcfcfb",
        side: "#f6f5f3",
        ink: "#1c1917",
        muted: "#5e5852",
        faint: "#716a64",
        line: "#ded8ce",
        grid_minor: "#f2efe9",
        grid_major: "#e6e2da",
        grid_dot: "#d6cfc5",
        tl_start: "#dd6f57",
        tl_mid: "#ec9658",
        tl_end: "#e5864c",
        pill_bg: "#d86c51",
        pill_ink: "#fefefe",
        minor_bg: "#fcfcfb",
        minor_border: "#d4cdc3",
        highlight_bg: "#e0ebf9",
        highlight_ink: "#2c5ea8",
        arrow_default: "#8a8178",
        arrow_label_bg: "#fcfcfb",
        container_bg: "#ffffff",
        container_border: "#e5e1db",
        container_header_bg: "#ebe6de",
        table_header_bg: "#f3f0eb",
        shadow_color: "#1c1917",
        shadow_opacity: "0.09",
    };

    const DARK: Self = Self {
        page: "#151413",
        side: "#1b1a18",
        ink: "#ecebe8",
        muted: "#a9a49e",
        faint: "#8b867f",
        line: "#3a3732",
        grid_minor: "#201e1b",
        grid_major: "#2b2824",
        grid_dot: "#3b3732",
        tl_start: "#e48369",
        tl_mid: "#ef9f64",
        tl_end: "#e8925c",
        pill_bg: "#d87158",
        pill_ink: "#fcfcfb",
        minor_bg: "#262421",
        minor_border: "#524d47",
        highlight_bg: "#263952",
        highlight_ink: "#8ec1f2",
        arrow_default: "#9e978f",
        arrow_label_bg: "#1b1a18",
        container_bg: "#1d1c19",
        container_border: "#3a3732",
        container_header_bg: "#262420",
        table_header_bg: "#23211e",
        shadow_color: "#000000",
        shadow_opacity: "0.34",
    };

    fn for_mode(dark: bool) -> &'static Self {
        if dark { &Self::DARK } else { &Self::LIGHT }
    }
}

fn fill_tone_hex(fill: &WbFill, dark: bool) -> (&str, &str, &str) {
    if dark {
        match fill {
            WbFill::Default => ("#23211e", "#3e3a35", "#ecebe8"),
            WbFill::Sun => ("#4a3d1f", "#8a6f2e", "#f9ecc2"),
            WbFill::Peach => ("#4d3121", "#9e633f", "#fadbc4"),
            WbFill::Leaf => ("#253b25", "#4d7a44", "#d7eec7"),
            WbFill::Water => ("#1f344b", "#4a7bad", "#d2e7fc"),
            WbFill::Lavender => ("#322848", "#7861aa", "#e7defc"),
            WbFill::Berry => ("#492825", "#a85b52", "#fad8d2"),
            WbFill::Side => ("#1b1a18", "#383530", "#ecebe8"),
            WbFill::Custom(c) => (c.as_str(), "#4a4640", "#ecebe8"),
        }
    } else {
        match fill {
            WbFill::Default => ("#fffdf9", "#ded8ce", "#1c1917"),
            WbFill::Sun => ("#ffe57f", "#e8c456", "#1c1917"),
            WbFill::Peach => ("#f9ba7b", "#e29a57", "#1c1917"),
            WbFill::Leaf => ("#cce6b6", "#9ac17a", "#1c1917"),
            WbFill::Water => ("#cde2f8", "#94bae2", "#1c1917"),
            WbFill::Lavender => ("#dfd4f8", "#b39de4", "#1c1917"),
            WbFill::Berry => ("#f8d0ca", "#de9a90", "#1c1917"),
            WbFill::Side => ("#f6f5f3", "#d8d2c7", "#1c1917"),
            WbFill::Custom(c) => (c.as_str(), "#cfc9bf", "#1c1917"),
        }
    }
}

fn shape_tone_hex(shape: ShapeKind, fill: &WbFill, dark: bool) -> (&str, &str, &str) {
    if shape == ShapeKind::Sticky {
        if dark {
            return match fill {
                WbFill::Sun => ("#5b4814", "#9d7b22", "#fceeae"),
                WbFill::Peach => ("#59351a", "#ab6b39", "#ffe2c7"),
                WbFill::Leaf => ("#1f4a24", "#458c4d", "#d7f6d9"),
                WbFill::Water => ("#1b3b5c", "#4482bf", "#d8ecff"),
                WbFill::Lavender => ("#382b59", "#7c63bd", "#e9e0ff"),
                WbFill::Berry => ("#542239", "#a64d75", "#ffdce9"),
                WbFill::Side => ("#2d2c28", "#47453f", "#ecebe8"),
                WbFill::Default | WbFill::Custom(_) => fill_tone_hex(fill, dark),
            };
        }
        return match fill {
            WbFill::Sun => ("#f7d02c", "#e0b918", "#1c1917"),
            WbFill::Peach => ("#f8b16e", "#de9450", "#241911"),
            WbFill::Leaf => ("#6ed16f", "#55b856", "#152015"),
            WbFill::Water => ("#69aef4", "#4f95dc", "#141d26"),
            WbFill::Lavender => ("#b39bf2", "#957bd9", "#1d172c"),
            WbFill::Berry => ("#f080ae", "#d76594", "#23141c"),
            WbFill::Side => ("#d8d6d2", "#c5c2bc", "#1c1917"),
            WbFill::Default | WbFill::Custom(_) => fill_tone_hex(fill, dark),
        };
    }
    if matches!(shape, ShapeKind::Pill | ShapeKind::Rounded) {
        if dark {
            return match fill {
                WbFill::Side => ("#2c2b28", "#45423d", "#ecebe8"),
                WbFill::Lavender => ("#3d2e66", "#7d64c2", "#efeaff"),
                _ => fill_tone_hex(fill, dark),
            };
        }
        return match fill {
            WbFill::Side => ("#d6d5d2", "#c4c2be", "#1c1917"),
            WbFill::Lavender => ("#b5a2f2", "#947de0", "#1c1917"),
            _ => fill_tone_hex(fill, dark),
        };
    }
    fill_tone_hex(fill, dark)
}

fn presence_hex(color: PresenceColor, dark: bool) -> &'static str {
    if dark {
        match color {
            PresenceColor::Coral => "#d96d3d",
            PresenceColor::Teal => "#3ab2a4",
            PresenceColor::Blue => "#6aa6dc",
            PresenceColor::Leaf => "#8dbb5c",
            PresenceColor::Wheat => "#e5a93c",
            PresenceColor::Lavender => "#b48ef5",
        }
    } else {
        match color {
            PresenceColor::Coral => "#c8561f",
            PresenceColor::Teal => "#1a7f74",
            PresenceColor::Blue => "#2c6aa3",
            PresenceColor::Leaf => "#4d7a2a",
            PresenceColor::Wheat => "#c48b20",
            PresenceColor::Lavender => "#7c52a8",
        }
    }
}

fn export_bounds(doc: &BoardDoc) -> Rect2 {
    let raw = doc.content_bounds().unwrap_or(Rect2::new(0.0, 0.0, 960.0, 540.0));
    let mut out = raw.expand(48.0);
    for el in &doc.elements {
        if let ElementKind::Container { x, y, w, h, title, .. } = &el.kind
            && !title.trim().is_empty()
        {
            out = out.union(Rect2::new(*x - 12.0, *y - 34.0, *w + 24.0, *h + 46.0));
        }
    }
    for p in &doc.presences {
        let status_msg = p.status.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let pill_w = match status_msg {
            Some(msg) if msg.chars().count() > 14 => (measure_text_span(msg, 12.5, false) + 56.0).clamp(160.0, 580.0),
            Some(st) => (measure_text_span(&format!("{} · {st}", p.name), 11.5, true) + 28.0).max(70.0),
            None => (measure_text_span(&p.name, 11.5, true) + 28.0).max(70.0),
        };
        let pr = Rect2::new(p.x - 16.0, p.y - 16.0, pill_w + 36.0, 62.0);
        out = out.union(pr);
    }
    Rect2::new(out.x.floor(), out.y.floor(), out.w.max(320.0).ceil(), out.h.max(240.0).ceil())
}

pub fn build_export_painter(doc: &BoardDoc, dark: bool) -> (Painter, f32, f32) {
    let bounds = export_bounds(doc);
    let pal = WhiteboardPalette::for_mode(dark);
    let lookup = doc.rect_lookup();
    let hidden = BTreeSet::new();
    let w = bounds.w as f32;
    let h = bounds.h as f32;

    let bg = doc.meta.background.as_deref().and_then(parse_hex_hsla).unwrap_or(pal.page);

    let mut painter = Painter::new()
        .begin_path()
        .fill_color(bg)
        .rect(Bounds::new(point(px(0.0), px(0.0)), size(px(w), px(h))))
        .fill();

    let cam = crate::engine::whiteboard::geometry::Camera {
        pan_x: -bounds.x,
        pan_y: -bounds.y,
        zoom: 1.0,
    };
    painter = paint_grid(painter, doc.meta.grid, cam, w, h, &pal);
    painter = painter.save().translate(-bounds.x as f32, -bounds.y as f32);
    let empty_dismissed = BTreeSet::new();
    painter = paint_board_into_painter(painter, doc, &lookup, &pal, None, None, &hidden);
    painter = paint_presences_into_painter(painter, doc, &pal, 1.0, &empty_dismissed);
    painter = painter.restore();

    (painter, w, h)
}

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

    // Same 7-pass layering as paint.rs: Containers/Claims -> Arrows -> Timelines -> Shapes/Tables -> Text -> Stickers/Svg -> Ink -> Presences.
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

fn write_svg_element(out: &mut String, el: &ElementRecord, lookup: &HashMap<ElementId, Rect2>, colors: &SvgColors, dark: bool) {
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

fn write_svg_shape_geom(out: &mut String, rect: Rect2, shape: ShapeKind, (r, dash_attr): (f32, &str), (fill, border, filter_attr): (&str, &str, &str)) {
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

fn write_svg_head(out: &mut String, shape: HeadShape, color: &str) {
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

fn write_svg_presences(out: &mut String, presences: &[crate::engine::whiteboard::model::Presence], colors: &SvgColors, dark: bool) {
    for p in presences {
        let color = presence_hex(p.color, dark);
        let status_opt = p.status.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let _ = writeln!(out, r#"<g transform="translate({:.1} {:.1})">"#, p.x, p.y);
        let _ = writeln!(
            out,
            r#"<polygon points="0,0 11,5.5 6,7.2 4.2,12.2" fill="{color}" stroke="{}" stroke-width="1.2"/>"#,
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

fn route_shape_svg_d(shape: &RouteShape) -> String {
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

fn write_nested_svg(out: &mut String, x: f64, y: f64, w: f64, h: f64, raw: &str) {
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

fn esc_text(raw: &str) -> String {
    raw.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn esc_attr(raw: &str) -> String {
    esc_text(raw).replace('"', "&quot;")
}

pub fn export_json(doc: &BoardDoc) -> Result<String, serde_json::Error> {
    let elements: Vec<serde_json::Value> = doc
        .elements
        .iter()
        .filter_map(|el| serde_json::from_str(&encode_element_json(el)).ok())
        .collect();
    let payload = serde_json::json!({
        "meta": doc.meta,
        "elements": elements,
        "presences": doc.presences,
        "seq": doc.seq,
    });
    serde_json::to_string_pretty(&payload)
}

pub fn export_json_canvas(doc: &BoardDoc) -> Result<String, serde_json::Error> {
    let mut canvas = Canvas::new();
    let lookup = doc.rect_lookup();
    let mut valid_nodes: BTreeSet<ElementId> = BTreeSet::new();

    for el in &doc.elements {
        match &el.kind {
            ElementKind::Container { x, y, w, h, title, fill, .. } => {
                let bounds = NodeBounds::new(x.round() as i64, y.round() as i64, w.max(40.0).round() as i64, h.max(40.0).round() as i64);
                let mut node = CanvasNode::group(el.id.as_str(), bounds, (!title.is_empty()).then(|| title.clone()));
                if let Some(c) = wb_fill_to_canvas(fill) {
                    node = node.with_color(c);
                }
                valid_nodes.insert(el.id.clone());
                canvas.nodes.push(node);
            }
            ElementKind::Shape {
                x, y, w, h, title, body, fill, ..
            } => {
                let bounds = NodeBounds::new(x.round() as i64, y.round() as i64, w.max(40.0).round() as i64, h.max(40.0).round() as i64);
                let text = match (title.trim().is_empty(), body.trim().is_empty()) {
                    (false, false) => format!("{title}\n{body}"),
                    (false, true) => title.clone(),
                    (true, false) => body.clone(),
                    (true, true) => String::new(),
                };
                let mut node = CanvasNode::text(el.id.as_str(), bounds, text);
                if let Some(c) = wb_fill_to_canvas(fill) {
                    node = node.with_color(c);
                }
                valid_nodes.insert(el.id.clone());
                canvas.nodes.push(node);
            }
            ElementKind::Text { x, y, w, h, label, fill, .. } => {
                let bounds = NodeBounds::new(x.round() as i64, y.round() as i64, w.max(40.0).round() as i64, h.max(32.0).round() as i64);
                let mut node = CanvasNode::text(el.id.as_str(), bounds, label.clone());
                if let Some(f) = fill
                    && let Some(c) = wb_fill_to_canvas(f)
                {
                    node = node.with_color(c);
                }
                valid_nodes.insert(el.id.clone());
                canvas.nodes.push(node);
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
                let bounds = NodeBounds::new(x.round() as i64, y.round() as i64, w.max(80.0).round() as i64, h.max(60.0).round() as i64);
                let mut md = headers.join(" | ");
                for row in rows {
                    md.push('\n');
                    md.push_str(&row.join(" | "));
                }
                let mut node = CanvasNode::text(el.id.as_str(), bounds, md);
                if let Some(c) = wb_fill_to_canvas(fill) {
                    node = node.with_color(c);
                }
                valid_nodes.insert(el.id.clone());
                canvas.nodes.push(node);
            }
            ElementKind::Claim { x, y, w, h, label, .. } => {
                let bounds = NodeBounds::new(x.round() as i64, y.round() as i64, w.max(40.0).round() as i64, h.max(40.0).round() as i64);
                valid_nodes.insert(el.id.clone());
                canvas
                    .nodes
                    .push(CanvasNode::text(el.id.as_str(), bounds, label.clone()).with_color(CanvasColor::preset(PresetColor::Red)));
            }
            _ => {}
        }
    }

    for el in &doc.elements {
        if let ElementKind::Arrow {
            from,
            to,
            start_head,
            end_head,
            label,
            ..
        } = &el.kind
            && let ArrowEndpoint::Bound { id: fid, side: fside } = from
            && let ArrowEndpoint::Bound { id: tid, side: tside } = to
            && valid_nodes.contains(fid)
            && valid_nodes.contains(tid)
        {
            let mut edge = Edge::new(el.id.as_str(), fid.as_str(), tid.as_str())
                .with_sides(fside.map(map_anchor_side), tside.map(map_anchor_side))
                .with_ends(Some(map_head(*start_head)), Some(map_head(*end_head)));
            if let Some(lbl) = label {
                edge = edge.with_label(lbl);
            }
            canvas.edges.push(edge);
        }
    }

    let _ = lookup;
    serde_json::to_string_pretty(&canvas)
}

fn wb_fill_to_canvas(fill: &WbFill) -> Option<CanvasColor> {
    match fill {
        WbFill::Berry => Some(CanvasColor::preset(PresetColor::Red)),
        WbFill::Peach => Some(CanvasColor::preset(PresetColor::Orange)),
        WbFill::Sun => Some(CanvasColor::preset(PresetColor::Yellow)),
        WbFill::Leaf => Some(CanvasColor::preset(PresetColor::Green)),
        WbFill::Water => Some(CanvasColor::preset(PresetColor::Cyan)),
        WbFill::Lavender => Some(CanvasColor::preset(PresetColor::Purple)),
        WbFill::Custom(h) => CanvasColor::hex(h).ok(),
        WbFill::Default | WbFill::Side => None,
    }
}

fn map_anchor_side(side: AnchorSide) -> Side {
    match side {
        AnchorSide::N => Side::Top,
        AnchorSide::E => Side::Right,
        AnchorSide::S => Side::Bottom,
        AnchorSide::W => Side::Left,
    }
}

fn map_head(head: ArrowHead) -> End {
    match head {
        ArrowHead::None => End::None,
        ArrowHead::Arrow | ArrowHead::Diamond | ArrowHead::Dot => End::Arrow,
    }
}
