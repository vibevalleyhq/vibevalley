use std::fmt::Write as _;

use crate::engine::canvas::model::{Canvas, Edge};

use super::geometry::{CubicBezier, Point, compute_edge_geometry};
use super::text::{escape_xml, estimate_text_width};
use super::theme::{EdgeStrokeStyle, SvgRenderOptions, ThemePalette};

pub(super) fn render_edge(canvas: &Canvas, edge: &Edge, palette: &ThemePalette, options: &SvgRenderOptions, out: &mut String) {
    let Some(geom) = compute_edge_geometry(canvas, edge, options.arrow_config) else {
        return;
    };
    let stroke_color = match &edge.color {
        Some(c) => palette.resolve_color(c),
        None => palette.edge,
    };
    let stroke_hex = stroke_color.to_hex_rgb();
    let style = if options.dashed_edges.contains(&edge.id) {
        match options.edge_stroke {
            EdgeStrokeStyle::Dashed { dash, gap } => EdgeStrokeStyle::Dashed { dash, gap },
            EdgeStrokeStyle::Solid => EdgeStrokeStyle::Dashed { dash: 6.0, gap: 4.0 },
        }
    } else {
        options.edge_stroke
    };

    let dash_attr = match style {
        EdgeStrokeStyle::Solid => String::new(),
        EdgeStrokeStyle::Dashed { dash, gap } => format!(r#" stroke-dasharray="{dash:.1} {gap:.1}""#),
    };

    // Trim endpoints slightly when arrowheads are present so the stroke does not poke past the tip.
    let drawn_curve = trim_curve_for_arrows(
        geom.curve,
        geom.from_arrow.is_some(),
        geom.to_arrow.is_some(),
        options.arrow_config.length * 0.55,
    );

    let _ = write!(out, r#"<g data-edge-id="{}">"#, escape_xml(edge.id.as_str()));
    let _ = write!(
        out,
        r#"<path d="{}" fill="none" stroke="{stroke_hex}" stroke-width="{:.2}" stroke-linecap="butt"{dash_attr}/>"#,
        drawn_curve.svg_path_data(),
        options.edge_stroke_width,
    );

    if let Some(arrow) = geom.from_arrow {
        let _ = write!(out, r#"<polygon points="{}" fill="{stroke_hex}"/>"#, arrow.svg_points());
    }
    if let Some(arrow) = geom.to_arrow {
        let _ = write!(out, r#"<polygon points="{}" fill="{stroke_hex}"/>"#, arrow.svg_points());
    }

    if let Some(label) = edge.label.as_deref()
        && !label.is_empty()
    {
        let label_font = (options.font_size * 0.86).max(10.0);
        let text_w = estimate_text_width(label, label_font);
        let pill_w = text_w + 14.0;
        let pill_h = label_font + 10.0;
        let px = geom.label_anchor.x - pill_w * 0.5;
        let py = geom.label_anchor.y - pill_h * 0.5;
        let _ = write!(
            out,
            r#"<rect x="{px:.2}" y="{py:.2}" width="{pill_w:.2}" height="{pill_h:.2}" rx="4" ry="4" fill="{}" stroke="{stroke_hex}" stroke-opacity="0.4" stroke-width="1"/>"#,
            palette.edge_label_bg.to_hex_rgb(),
        );
        let _ = write!(
            out,
            r#"<text x="{:.2}" y="{:.2}" text-anchor="middle" font-family="{}" font-size="{label_font:.1}" fill="{}">{}</text>"#,
            geom.label_anchor.x,
            geom.label_anchor.y + label_font * 0.35,
            escape_xml(&options.font_family),
            palette.text.to_hex_rgb(),
            escape_xml(label),
        );
    }

    out.push_str("</g>");
}

fn trim_curve_for_arrows(mut curve: CubicBezier, trim_start: bool, trim_end: bool, amount: f64) -> CubicBezier {
    if curve.p0.distance(curve.p3) <= amount * 2.5 {
        return curve;
    }
    if trim_start && let Some(dir) = curve.tangent_at(0.0).normalized() {
        curve.p0 = Point::new(curve.p0.x + dir.x * amount, curve.p0.y + dir.y * amount);
    }
    if trim_end && let Some(dir) = curve.tangent_at(1.0).normalized() {
        curve.p3 = Point::new(curve.p3.x - dir.x * amount, curve.p3.y - dir.y * amount);
    }
    curve
}
