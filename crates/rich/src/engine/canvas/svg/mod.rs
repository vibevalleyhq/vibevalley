mod edges;
mod geometry;
mod nodes;
mod text;
mod theme;

use std::fmt::Write as _;

use crate::engine::canvas::model::{Canvas, Rect};

pub use self::geometry::ArrowConfig;
pub use self::theme::{EdgeStrokeStyle, PresetSwatch, SvgRenderOptions, SvgTheme, ThemePalette};

use self::edges::render_edge;
use self::geometry::{compute_edge_geometry, group_label_rect};
use self::nodes::render_node;

pub fn render_svg_default(canvas: &Canvas) -> String {
    render_svg(canvas, &SvgRenderOptions::default())
}

/// Renders `canvas` to standalone pure SVG 1.1 without `<foreignObject>`,
/// safe for `resvg` rasterization, previews, thumbnails, and export.
pub fn render_svg(canvas: &Canvas, options: &SvgRenderOptions) -> String {
    let palette = options.theme.palette();
    let view_box = compute_view_box(canvas, options);
    let (svg_w, svg_h) = match options.explicit_size {
        Some((w, h)) => (w.max(1), h.max(1)),
        None => ((view_box.width.ceil() as u32).max(1), (view_box.height.ceil() as u32).max(1)),
    };

    let mut defs = String::new();
    let mut body = String::new();

    if options.show_grid && options.grid_spacing >= 4.0 {
        let s = options.grid_spacing;
        let _ = write!(
            defs,
            r#"<pattern id="vv-grid" width="{s:.2}" height="{s:.2}" patternUnits="userSpaceOnUse"><circle cx="{cx:.2}" cy="{cy:.2}" r="1.1" fill="{dot}"/></pattern>"#,
            cx = s * 0.5,
            cy = s * 0.5,
            dot = palette.dot_color.to_hex_rgb(),
        );
    }

    let _ = write!(
        body,
        r#"<rect x="{:.2}" y="{:.2}" width="{:.2}" height="{:.2}" fill="{}"/>"#,
        view_box.x,
        view_box.y,
        view_box.width,
        view_box.height,
        palette.background.to_hex_rgb(),
    );
    if options.show_grid && options.grid_spacing >= 4.0 {
        let _ = write!(
            body,
            r#"<rect x="{:.2}" y="{:.2}" width="{:.2}" height="{:.2}" fill="url(#vv-grid)"/>"#,
            view_box.x, view_box.y, view_box.width, view_box.height,
        );
    }

    body.push_str(r#"<g id="vv-nodes">"#);
    for (index, node) in canvas.nodes.iter().enumerate() {
        render_node(node, index, &palette, options, &mut defs, &mut body);
    }
    body.push_str("</g>");

    body.push_str(r#"<g id="vv-edges">"#);
    for edge in &canvas.edges {
        render_edge(canvas, edge, &palette, options, &mut body);
    }
    body.push_str("</g>");

    let mut svg = String::with_capacity(defs.len() + body.len() + 256);
    let _ = write!(
        svg,
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{svg_w}" height="{svg_h}" viewBox="{:.2} {:.2} {:.2} {:.2}">"#,
        view_box.x, view_box.y, view_box.width, view_box.height,
    );
    if !defs.is_empty() {
        svg.push_str("<defs>");
        svg.push_str(&defs);
        svg.push_str("</defs>");
    }
    svg.push_str(&body);
    svg.push_str("</svg>");
    svg
}

fn compute_view_box(canvas: &Canvas, options: &SvgRenderOptions) -> Rect {
    let mut bounds: Option<Rect> = None;
    let mut include = |rect: Rect| {
        bounds = Some(match bounds {
            Some(existing) => existing.union(rect),
            None => rect,
        });
    };

    for node in &canvas.nodes {
        include(node.rect());
        if let Some(group) = node.as_group()
            && let Some(label_rect) = group_label_rect(group)
        {
            include(label_rect);
        }
    }

    for edge in &canvas.edges {
        if let Some(geom) = compute_edge_geometry(canvas, edge, options.arrow_config) {
            include(geom.curve.bounding_box().expand(options.arrow_config.length + 12.0));
        }
    }

    match bounds {
        Some(b) => b.expand(options.padding.max(0.0)),
        None => Rect::new(0.0, 0.0, 400.0, 300.0),
    }
}
