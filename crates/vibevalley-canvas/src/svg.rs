use std::collections::HashSet;
use std::fmt::Write as _;

use crate::geometry::{ArrowConfig, CubicBezier, Point, Rect, compute_edge_geometry};
use crate::hit::{GROUP_LABEL_GAP, GROUP_LABEL_HEIGHT, group_label_rect};
use crate::model::{BackgroundStyle, Canvas, CanvasColor, Edge, EdgeId, FileNode, GroupNode, LinkNode, Node, PresetColor, Rgba8, TextNode};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PresetSwatch {
    pub border: Rgba8,
    pub fill: Rgba8,
    pub fill_opacity: f64,
    pub label: Rgba8,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ThemePalette {
    pub background: Rgba8,
    pub dot_color: Rgba8,
    pub card_fill: Rgba8,
    pub card_border: Rgba8,
    pub group_fill: Rgba8,
    pub group_fill_opacity: f64,
    pub group_border: Rgba8,
    pub group_label_bg: Rgba8,
    pub text: Rgba8,
    pub muted: Rgba8,
    pub link: Rgba8,
    pub edge: Rgba8,
    pub edge_label_bg: Rgba8,
    pub presets: [PresetSwatch; 6],
}

impl ThemePalette {
    pub fn light() -> Self {
        Self {
            background: Rgba8::from_hex_u32(0xfafafa),
            dot_color: Rgba8::from_hex_u32(0xdedee2),
            card_fill: Rgba8::from_hex_u32(0xffffff),
            card_border: Rgba8::from_hex_u32(0xd4d4d8),
            group_fill: Rgba8::from_hex_u32(0xf0f0f3),
            group_fill_opacity: 0.65,
            group_border: Rgba8::from_hex_u32(0xc4c4cc),
            group_label_bg: Rgba8::from_hex_u32(0xededf0),
            text: Rgba8::from_hex_u32(0x171717),
            muted: Rgba8::from_hex_u32(0x6b6b6b),
            link: Rgba8::from_hex_u32(0x0060e2),
            edge: Rgba8::from_hex_u32(0x71717a),
            edge_label_bg: Rgba8::from_hex_u32(0xffffff),
            presets: [
                PresetSwatch {
                    border: Rgba8::from_hex_u32(0xd9383a),
                    fill: Rgba8::from_hex_u32(0xd9383a),
                    fill_opacity: 0.09,
                    label: Rgba8::from_hex_u32(0xa61f22),
                },
                PresetSwatch {
                    border: Rgba8::from_hex_u32(0xe6730e),
                    fill: Rgba8::from_hex_u32(0xe6730e),
                    fill_opacity: 0.10,
                    label: Rgba8::from_hex_u32(0xa84e00),
                },
                PresetSwatch {
                    border: Rgba8::from_hex_u32(0xd4a017),
                    fill: Rgba8::from_hex_u32(0xd4a017),
                    fill_opacity: 0.12,
                    label: Rgba8::from_hex_u32(0x8a6500),
                },
                PresetSwatch {
                    border: Rgba8::from_hex_u32(0x1e8a4f),
                    fill: Rgba8::from_hex_u32(0x1e8a4f),
                    fill_opacity: 0.09,
                    label: Rgba8::from_hex_u32(0x146338),
                },
                PresetSwatch {
                    border: Rgba8::from_hex_u32(0x0b8576),
                    fill: Rgba8::from_hex_u32(0x0b8576),
                    fill_opacity: 0.09,
                    label: Rgba8::from_hex_u32(0x075e54),
                },
                PresetSwatch {
                    border: Rgba8::from_hex_u32(0x8a35d6),
                    fill: Rgba8::from_hex_u32(0x8a35d6),
                    fill_opacity: 0.09,
                    label: Rgba8::from_hex_u32(0x6421a3),
                },
            ],
        }
    }

    pub fn dark() -> Self {
        Self {
            background: Rgba8::from_hex_u32(0x111113),
            dot_color: Rgba8::from_hex_u32(0x27272b),
            card_fill: Rgba8::from_hex_u32(0x1b1b1f),
            card_border: Rgba8::from_hex_u32(0x323238),
            group_fill: Rgba8::from_hex_u32(0x18181c),
            group_fill_opacity: 0.72,
            group_border: Rgba8::from_hex_u32(0x3a3a42),
            group_label_bg: Rgba8::from_hex_u32(0x242429),
            text: Rgba8::from_hex_u32(0xededed),
            muted: Rgba8::from_hex_u32(0x94949c),
            link: Rgba8::from_hex_u32(0x6ea8fe),
            edge: Rgba8::from_hex_u32(0x8e8e98),
            edge_label_bg: Rgba8::from_hex_u32(0x1b1b1f),
            presets: [
                PresetSwatch {
                    border: Rgba8::from_hex_u32(0xff6b6b),
                    fill: Rgba8::from_hex_u32(0xff6b6b),
                    fill_opacity: 0.14,
                    label: Rgba8::from_hex_u32(0xffa496),
                },
                PresetSwatch {
                    border: Rgba8::from_hex_u32(0xf28a2e),
                    fill: Rgba8::from_hex_u32(0xf28a2e),
                    fill_opacity: 0.14,
                    label: Rgba8::from_hex_u32(0xf7b06e),
                },
                PresetSwatch {
                    border: Rgba8::from_hex_u32(0xe8c547),
                    fill: Rgba8::from_hex_u32(0xe8c547),
                    fill_opacity: 0.14,
                    label: Rgba8::from_hex_u32(0xf2da7e),
                },
                PresetSwatch {
                    border: Rgba8::from_hex_u32(0x41bd74),
                    fill: Rgba8::from_hex_u32(0x41bd74),
                    fill_opacity: 0.14,
                    label: Rgba8::from_hex_u32(0x7ae0a3),
                },
                PresetSwatch {
                    border: Rgba8::from_hex_u32(0x4fc3b4),
                    fill: Rgba8::from_hex_u32(0x4fc3b4),
                    fill_opacity: 0.14,
                    label: Rgba8::from_hex_u32(0x85dfd3),
                },
                PresetSwatch {
                    border: Rgba8::from_hex_u32(0xb48ef5),
                    fill: Rgba8::from_hex_u32(0xb48ef5),
                    fill_opacity: 0.15,
                    label: Rgba8::from_hex_u32(0xd5bcf9),
                },
            ],
        }
    }

    pub fn preset(&self, color: PresetColor) -> &PresetSwatch {
        &self.presets[color.index()]
    }

    pub fn resolve_color(&self, color: &CanvasColor) -> Rgba8 {
        match color {
            CanvasColor::Preset(preset) => self.preset(*preset).border,
            CanvasColor::Hex(_) => color.to_hex_rgba().unwrap_or(self.card_border),
        }
    }

    fn resolve_swatch(&self, color: Option<&CanvasColor>, default_border: Rgba8) -> (Rgba8, Option<(Rgba8, f64)>, Rgba8) {
        match color {
            None => (default_border, None, self.text),
            Some(CanvasColor::Preset(preset)) => {
                let s = self.preset(*preset);
                (s.border, Some((s.fill, s.fill_opacity)), s.label)
            }
            Some(CanvasColor::Hex(_)) => {
                let rgba = color.and_then(CanvasColor::to_hex_rgba).unwrap_or(default_border);
                let tint_opacity = (0.12 * rgba.opacity()).clamp(0.04, 0.28);
                (rgba, Some((rgba, tint_opacity)), rgba)
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum SvgTheme {
    Light,
    Dark,
    Custom(Box<ThemePalette>),
}

impl SvgTheme {
    pub fn palette(&self) -> ThemePalette {
        match self {
            SvgTheme::Light => ThemePalette::light(),
            SvgTheme::Dark => ThemePalette::dark(),
            SvgTheme::Custom(palette) => (**palette).clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum EdgeStrokeStyle {
    Solid,
    Dashed { dash: f64, gap: f64 },
}

#[derive(Debug, Clone, PartialEq)]
pub struct SvgRenderOptions {
    pub theme: SvgTheme,
    pub padding: f64,
    pub show_grid: bool,
    pub grid_spacing: f64,
    pub edge_stroke: EdgeStrokeStyle,
    pub dashed_edges: HashSet<EdgeId>,
    pub edge_stroke_width: f64,
    pub corner_radius: f64,
    pub font_family: String,
    pub font_size: f64,
    pub arrow_config: ArrowConfig,
    pub explicit_size: Option<(u32, u32)>,
}

impl Default for SvgRenderOptions {
    fn default() -> Self {
        Self {
            theme: SvgTheme::Light,
            padding: 40.0,
            show_grid: true,
            grid_spacing: 20.0,
            edge_stroke: EdgeStrokeStyle::Solid,
            dashed_edges: HashSet::new(),
            edge_stroke_width: 2.0,
            corner_radius: 8.0,
            font_family: "-apple-system, BlinkMacSystemFont, Helvetica Neue, Arial, sans-serif".to_owned(),
            font_size: 14.0,
            arrow_config: ArrowConfig::default(),
            explicit_size: None,
        }
    }
}

impl SvgRenderOptions {
    pub fn light() -> Self {
        Self::default()
    }

    pub fn dark() -> Self {
        Self {
            theme: SvgTheme::Dark,
            ..Self::default()
        }
    }
}

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

fn render_node(node: &Node, index: usize, palette: &ThemePalette, options: &SvgRenderOptions, defs: &mut String, out: &mut String) {
    match node {
        Node::Group(g) => render_group_node(g, index, palette, options, defs, out),
        Node::Text(t) => render_text_node(t, index, palette, options, defs, out),
        Node::File(f) => render_file_node(f, index, palette, options, defs, out),
        Node::Link(l) => render_link_node(l, index, palette, options, defs, out),
    }
}

fn render_group_node(group: &GroupNode, index: usize, palette: &ThemePalette, options: &SvgRenderOptions, defs: &mut String, out: &mut String) {
    let (border, tint, label_color) = palette.resolve_swatch(group.color.as_ref(), palette.group_border);
    let x = group.x as f64;
    let y = group.y as f64;
    let w = group.width as f64;
    let h = group.height as f64;
    let r = (options.corner_radius + 2.0).min(w * 0.5).min(h * 0.5);

    let (fill_color, fill_opacity) = match tint {
        Some((tint_rgb, tint_op)) => (tint_rgb, (tint_op + 0.04).min(0.35)),
        None => (palette.group_fill, palette.group_fill_opacity),
    };

    let _ = write!(out, r#"<g data-node-type="group" data-node-id="{}">"#, escape_xml(group.id.as_str()));
    let _ = write!(
        out,
        r#"<rect x="{x:.2}" y="{y:.2}" width="{w:.2}" height="{h:.2}" rx="{r:.2}" ry="{r:.2}" fill="{}" fill-opacity="{fill_opacity:.3}" stroke="{}" stroke-width="1.5"/>"#,
        fill_color.to_hex_rgb(),
        border.to_hex_rgb(),
    );

    if let Some(bg_path) = group.background.as_deref()
        && !bg_path.is_empty()
    {
        render_group_background_hint(group, index, border, palette, options, defs, out, bg_path);
    }

    if let Some(label) = group.label.as_deref()
        && !label.is_empty()
    {
        let label_rect = group_label_rect(group).unwrap_or_else(|| Rect::new(x, y - GROUP_LABEL_HEIGHT - GROUP_LABEL_GAP, 80.0, GROUP_LABEL_HEIGHT));
        let pill_bg = match tint {
            Some((tint_rgb, _)) => tint_rgb.to_hex_rgb(),
            None => palette.group_label_bg.to_hex_rgb(),
        };
        let pill_opacity = if tint.is_some() { 0.16 } else { 1.0 };
        let _ = write!(
            out,
            r#"<rect x="{:.2}" y="{:.2}" width="{:.2}" height="{:.2}" rx="5" ry="5" fill="{pill_bg}" fill-opacity="{pill_opacity:.3}" stroke="{}" stroke-opacity="0.45" stroke-width="1"/>"#,
            label_rect.x,
            label_rect.y,
            label_rect.width,
            label_rect.height,
            border.to_hex_rgb(),
        );
        let text_x = label_rect.x + 8.0;
        let text_y = label_rect.y + label_rect.height * 0.68;
        let _ = write!(
            out,
            r#"<text x="{text_x:.2}" y="{text_y:.2}" font-family="{}" font-size="12.5" font-weight="600" fill="{}">{}</text>"#,
            escape_xml(&options.font_family),
            label_color.to_hex_rgb(),
            escape_xml(label),
        );
    }

    out.push_str("</g>");
}

#[allow(clippy::too_many_arguments)]
fn render_group_background_hint(
    group: &GroupNode,
    index: usize,
    border: Rgba8,
    palette: &ThemePalette,
    options: &SvgRenderOptions,
    defs: &mut String,
    out: &mut String,
    bg_path: &str,
) {
    let x = group.x as f64;
    let y = group.y as f64;
    let w = group.width as f64;
    let h = group.height as f64;
    let clip_id = format!("vv-gbg-{index}");
    let _ = write!(
        defs,
        r#"<clipPath id="{clip_id}"><rect x="{x:.2}" y="{y:.2}" width="{w:.2}" height="{h:.2}" rx="{r:.2}" ry="{r:.2}"/></clipPath>"#,
        r = options.corner_radius + 2.0,
    );

    let style = group.background_style.unwrap_or(BackgroundStyle::Cover);
    let _ = write!(out, r#"<g clip-path="url(#{clip_id})" opacity="0.22">"#);
    match style {
        BackgroundStyle::Cover => {
            let _ = write!(
                out,
                r#"<line x1="{x:.2}" y1="{y:.2}" x2="{:.2}" y2="{:.2}" stroke="{}" stroke-width="1"/>"#,
                x + w,
                y + h,
                border.to_hex_rgb(),
            );
            let _ = write!(
                out,
                r#"<line x1="{:.2}" y1="{y:.2}" x2="{x:.2}" y2="{:.2}" stroke="{}" stroke-width="1"/>"#,
                x + w,
                y + h,
                border.to_hex_rgb(),
            );
        }
        BackgroundStyle::Ratio => {
            let inset_x = w * 0.12;
            let inset_y = h * 0.12;
            let _ = write!(
                out,
                r#"<rect x="{:.2}" y="{:.2}" width="{:.2}" height="{:.2}" fill="none" stroke="{}" stroke-width="1" stroke-dasharray="4 4"/>"#,
                x + inset_x,
                y + inset_y,
                (w - inset_x * 2.0).max(1.0),
                (h - inset_y * 2.0).max(1.0),
                border.to_hex_rgb(),
            );
        }
        BackgroundStyle::Repeat => {
            let pat_id = format!("vv-gpat-{index}");
            let _ = write!(
                defs,
                r#"<pattern id="{pat_id}" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M 0 12 L 24 12 M 12 0 L 12 24" stroke="{}" stroke-width="0.75"/></pattern>"#,
                border.to_hex_rgb(),
            );
            let _ = write!(out, r#"<rect x="{x:.2}" y="{y:.2}" width="{w:.2}" height="{h:.2}" fill="url(#{pat_id})"/>"#,);
        }
    }
    out.push_str("</g>");

    let badge_y = y + h - 10.0;
    let badge_x = x + 10.0;
    let name = bg_path.rsplit('/').next().unwrap_or(bg_path);
    let _ = write!(
        out,
        r#"<text x="{badge_x:.2}" y="{badge_y:.2}" font-family="{}" font-size="10.5" fill="{}" opacity="0.75">{}</text>"#,
        escape_xml(&options.font_family),
        palette.muted.to_hex_rgb(),
        escape_xml(name),
    );
}

fn render_card_frame(rect: Rect, color: Option<&CanvasColor>, palette: &ThemePalette, options: &SvgRenderOptions, out: &mut String) -> Rgba8 {
    let (border, tint, _) = palette.resolve_swatch(color, palette.card_border);
    let x = rect.x;
    let y = rect.y;
    let w = rect.width;
    let h = rect.height;
    let r = options.corner_radius.min(w * 0.5).min(h * 0.5);
    let _ = write!(
        out,
        r#"<rect x="{x:.2}" y="{y:.2}" width="{w:.2}" height="{h:.2}" rx="{r:.2}" ry="{r:.2}" fill="{}" stroke="{}" stroke-width="1.5"/>"#,
        palette.card_fill.to_hex_rgb(),
        border.to_hex_rgb(),
    );
    if let Some((tint_rgb, tint_opacity)) = tint {
        let _ = write!(
            out,
            r#"<rect x="{:.2}" y="{:.2}" width="{:.2}" height="{:.2}" rx="{r:.2}" ry="{r:.2}" fill="{}" fill-opacity="{tint_opacity:.3}"/>"#,
            x + 0.75,
            y + 0.75,
            (w - 1.5).max(0.0),
            (h - 1.5).max(0.0),
            tint_rgb.to_hex_rgb(),
        );
    }
    border
}

fn render_text_node(node: &TextNode, index: usize, palette: &ThemePalette, options: &SvgRenderOptions, defs: &mut String, out: &mut String) {
    let x = node.x as f64;
    let y = node.y as f64;
    let w = node.width as f64;
    let h = node.height as f64;
    let pad = 14.0;
    let clip_id = format!("vv-clip-{index}");
    let _ = write!(
        defs,
        r#"<clipPath id="{clip_id}"><rect x="{:.2}" y="{:.2}" width="{:.2}" height="{:.2}"/></clipPath>"#,
        x + 4.0,
        y + 4.0,
        (w - 8.0).max(1.0),
        (h - 8.0).max(1.0),
    );

    let _ = write!(out, r#"<g data-node-type="text" data-node-id="{}">"#, escape_xml(node.id.as_str()));
    render_card_frame(Rect::new(x, y, w, h), node.color.as_ref(), palette, options, out);

    let inner_w = (w - pad * 2.0).max(20.0);
    let styled_lines = layout_markdown_lines(&node.text, inner_w, options.font_size);

    let _ = write!(out, r#"<g clip-path="url(#{clip_id})">"#);
    let mut cursor_y = y + pad;
    let max_y = y + h - 6.0;
    for line in styled_lines {
        let line_height = line.font_size * 1.4;
        cursor_y += line.font_size;
        if cursor_y > max_y {
            break;
        }
        if !line.text.is_empty() {
            let weight = if line.bold { "600" } else { "400" };
            let _ = write!(
                out,
                r#"<text x="{:.2}" y="{cursor_y:.2}" font-family="{}" font-size="{:.1}" font-weight="{weight}" fill="{}">{}</text>"#,
                x + pad,
                escape_xml(&options.font_family),
                line.font_size,
                palette.text.to_hex_rgb(),
                escape_xml(&line.text),
            );
        }
        cursor_y += line_height - line.font_size;
    }
    out.push_str("</g></g>");
}

fn render_file_node(node: &FileNode, index: usize, palette: &ThemePalette, options: &SvgRenderOptions, defs: &mut String, out: &mut String) {
    let x = node.x as f64;
    let y = node.y as f64;
    let w = node.width as f64;
    let h = node.height as f64;
    let pad = 14.0;
    let clip_id = format!("vv-clip-{index}");
    let _ = write!(
        defs,
        r#"<clipPath id="{clip_id}"><rect x="{:.2}" y="{:.2}" width="{:.2}" height="{:.2}"/></clipPath>"#,
        x + 4.0,
        y + 4.0,
        (w - 8.0).max(1.0),
        (h - 8.0).max(1.0),
    );

    let _ = write!(out, r#"<g data-node-type="file" data-node-id="{}">"#, escape_xml(node.id.as_str()));
    let accent = render_card_frame(Rect::new(x, y, w, h), node.color.as_ref(), palette, options, out);

    let _ = write!(out, r#"<g clip-path="url(#{clip_id})">"#);
    let ix = x + pad;
    let iy = y + pad;
    let _ = write!(
        out,
        r#"<path d="M {ix:.2} {iy:.2} L {:.2} {iy:.2} L {:.2} {:.2} L {:.2} {:.2} L {ix:.2} {:.2} Z M {:.2} {iy:.2} L {:.2} {:.2} L {:.2} {:.2}" fill="none" stroke="{}" stroke-width="1.4" stroke-linejoin="round"/>"#,
        ix + 9.0,
        ix + 13.0,
        iy + 4.0,
        ix + 13.0,
        iy + 16.0,
        iy + 16.0,
        ix + 9.0,
        ix + 9.0,
        iy + 4.0,
        ix + 13.0,
        iy + 4.0,
        accent.to_hex_rgb(),
    );

    let name = node.file.rsplit('/').next().unwrap_or(&node.file);
    let _ = write!(
        out,
        r#"<text x="{:.2}" y="{:.2}" font-family="{}" font-size="{:.1}" font-weight="600" fill="{}">{}</text>"#,
        ix + 20.0,
        iy + 13.0,
        escape_xml(&options.font_family),
        options.font_size,
        palette.text.to_hex_rgb(),
        escape_xml(name),
    );

    let mut next_y = iy + 34.0;
    if node.file != name {
        let wrapped = wrap_text(&node.file, (w - pad * 2.0).max(24.0), options.font_size * 0.85);
        for line in wrapped.into_iter().take(2) {
            if next_y > y + h - 8.0 {
                break;
            }
            let _ = write!(
                out,
                r#"<text x="{ix:.2}" y="{next_y:.2}" font-family="{}" font-size="{:.1}" fill="{}">{}</text>"#,
                escape_xml(&options.font_family),
                options.font_size * 0.85,
                palette.muted.to_hex_rgb(),
                escape_xml(&line),
            );
            next_y += options.font_size * 1.25;
        }
    }

    if let Some(subpath) = &node.subpath
        && next_y + 10.0 <= y + h - 6.0
    {
        let pill_w = (estimate_text_width(subpath, options.font_size * 0.8) + 14.0).min((w - pad * 2.0).max(32.0));
        let pill_y = next_y - 4.0;
        let _ = write!(
            out,
            r#"<rect x="{ix:.2}" y="{pill_y:.2}" width="{pill_w:.2}" height="20" rx="4" ry="4" fill="{}" fill-opacity="0.14"/>"#,
            accent.to_hex_rgb(),
        );
        let _ = write!(
            out,
            r#"<text x="{:.2}" y="{:.2}" font-family="{}" font-size="{:.1}" fill="{}">{}</text>"#,
            ix + 7.0,
            pill_y + 14.0,
            escape_xml(&options.font_family),
            options.font_size * 0.8,
            palette.text.to_hex_rgb(),
            escape_xml(subpath),
        );
    }

    out.push_str("</g></g>");
}

fn render_link_node(node: &LinkNode, index: usize, palette: &ThemePalette, options: &SvgRenderOptions, defs: &mut String, out: &mut String) {
    let x = node.x as f64;
    let y = node.y as f64;
    let w = node.width as f64;
    let h = node.height as f64;
    let pad = 14.0;
    let clip_id = format!("vv-clip-{index}");
    let _ = write!(
        defs,
        r#"<clipPath id="{clip_id}"><rect x="{:.2}" y="{:.2}" width="{:.2}" height="{:.2}"/></clipPath>"#,
        x + 4.0,
        y + 4.0,
        (w - 8.0).max(1.0),
        (h - 8.0).max(1.0),
    );

    let _ = write!(out, r#"<g data-node-type="link" data-node-id="{}">"#, escape_xml(node.id.as_str()));
    render_card_frame(Rect::new(x, y, w, h), node.color.as_ref(), palette, options, out);

    let _ = write!(out, r#"<g clip-path="url(#{clip_id})">"#);
    let ix = x + pad;
    let iy = y + pad;
    let _ = write!(
        out,
        r#"<circle cx="{:.2}" cy="{:.2}" r="6" fill="none" stroke="{}" stroke-width="1.4"/><line x1="{:.2}" y1="{:.2}" x2="{:.2}" y2="{:.2}" stroke="{}" stroke-width="1.2"/>"#,
        ix + 7.0,
        iy + 8.0,
        palette.link.to_hex_rgb(),
        ix + 1.5,
        iy + 8.0,
        ix + 12.5,
        iy + 8.0,
        palette.link.to_hex_rgb(),
    );

    let host = extract_url_host(&node.url).unwrap_or(&node.url);
    let _ = write!(
        out,
        r#"<text x="{:.2}" y="{:.2}" font-family="{}" font-size="{:.1}" font-weight="600" fill="{}">{}</text>"#,
        ix + 20.0,
        iy + 12.5,
        escape_xml(&options.font_family),
        options.font_size,
        palette.link.to_hex_rgb(),
        escape_xml(host),
    );

    let mut cursor_y = iy + 34.0;
    for line in wrap_text(&node.url, (w - pad * 2.0).max(24.0), options.font_size * 0.82).into_iter().take(3) {
        if cursor_y > y + h - 8.0 {
            break;
        }
        let _ = write!(
            out,
            r#"<text x="{ix:.2}" y="{cursor_y:.2}" font-family="{}" font-size="{:.1}" fill="{}">{}</text>"#,
            escape_xml(&options.font_family),
            options.font_size * 0.82,
            palette.muted.to_hex_rgb(),
            escape_xml(&line),
        );
        cursor_y += options.font_size * 1.2;
    }

    out.push_str("</g></g>");
}

fn render_edge(canvas: &Canvas, edge: &Edge, palette: &ThemePalette, options: &SvgRenderOptions, out: &mut String) {
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

struct StyledLine {
    text: String,
    font_size: f64,
    bold: bool,
}

fn layout_markdown_lines(text: &str, max_width: f64, base_font_size: f64) -> Vec<StyledLine> {
    let mut out = Vec::new();
    for raw in text.replace("\r\n", "\n").split('\n') {
        let trimmed = raw.trim_end();
        if trimmed.is_empty() {
            out.push(StyledLine {
                text: String::new(),
                font_size: base_font_size * 0.7,
                bold: false,
            });
            continue;
        }
        let (clean, font_size, bold) = if let Some(rest) = trimmed.strip_prefix("### ") {
            (simplify_markdown_inline(rest), base_font_size * 1.05, true)
        } else if let Some(rest) = trimmed.strip_prefix("## ") {
            (simplify_markdown_inline(rest), base_font_size * 1.15, true)
        } else if let Some(rest) = trimmed.strip_prefix("# ") {
            (simplify_markdown_inline(rest), base_font_size * 1.28, true)
        } else if let Some(rest) = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* ")) {
            (format!("• {}", simplify_markdown_inline(rest)), base_font_size, false)
        } else {
            (simplify_markdown_inline(trimmed), base_font_size, false)
        };

        for wrapped in wrap_text(&clean, max_width, font_size) {
            out.push(StyledLine {
                text: wrapped,
                font_size,
                bold,
            });
        }
    }
    out
}

/// Replaces inline Markdown `[label](url)` links with `label` for clean SVG text cards.
fn simplify_markdown_inline(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(open_bracket) = rest.find('[') {
        out.push_str(&rest[..open_bracket]);
        let after_open = &rest[open_bracket + 1..];
        if let Some(close_bracket) = after_open.find("](") {
            let label = &after_open[..close_bracket];
            let after_mid = &after_open[close_bracket + 2..];
            if let Some(close_paren) = after_mid.find(')') {
                out.push_str(label);
                rest = &after_mid[close_paren + 1..];
                continue;
            }
        }
        out.push('[');
        rest = after_open;
    }
    out.push_str(rest);
    out
}

fn char_width_factor(ch: char) -> f64 {
    if ch.is_ascii() {
        match ch {
            'i' | 'l' | 'I' | '!' | '.' | ',' | ':' | ';' | '|' | '\'' => 0.32,
            'm' | 'w' | 'M' | 'W' => 0.85,
            _ => 0.56,
        }
    } else {
        1.0
    }
}

fn estimate_text_width(text: &str, font_size: f64) -> f64 {
    text.chars().map(char_width_factor).sum::<f64>() * font_size
}

fn wrap_text(text: &str, max_width: f64, font_size: f64) -> Vec<String> {
    if text.is_empty() {
        return vec![String::new()];
    }
    let mut lines = Vec::new();
    let mut current = String::new();
    let mut current_w = 0.0_f64;

    for word in text.split_inclusive(|c: char| c.is_whitespace()) {
        let word_w = estimate_text_width(word, font_size);
        if !current.is_empty() && current_w + word_w > max_width {
            lines.push(current.trim_end().to_owned());
            current.clear();
            current_w = 0.0;
        }
        if word_w <= max_width {
            current.push_str(word);
            current_w += word_w;
        } else {
            // Break long tokens (URLs, paths, CJK runs) safely at Unicode scalar boundaries.
            for ch in word.chars() {
                let cw = char_width_factor(ch) * font_size;
                if !current.is_empty() && current_w + cw > max_width {
                    lines.push(current.trim_end().to_owned());
                    current.clear();
                    current_w = 0.0;
                }
                current.push(ch);
                current_w += cw;
            }
        }
    }

    if !current.is_empty() || lines.is_empty() {
        lines.push(current.trim_end().to_owned());
    }
    lines
}

fn extract_url_host(url: &str) -> Option<&str> {
    let (_, after_scheme) = url.split_once("://")?;
    let host_port = after_scheme.split(['/', '?', '#']).next()?;
    let host = host_port.rsplit('@').next().unwrap_or(host_port);
    (!host.is_empty()).then_some(host)
}

fn escape_xml(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simplify_markdown_inline_strips_links_and_keeps_broken_brackets() {
        assert_eq!(
            simplify_markdown_inline("See [Spec](spec/1.0.md) and [Apps](/docs/apps.md)!"),
            "See Spec and Apps!"
        );
        assert_eq!(simplify_markdown_inline("Array [1, 2] stays"), "Array [1, 2] stays");
    }

    #[test]
    fn wrap_text_splits_long_unicode_and_urls_safely() {
        let lines = wrap_text("https://example.com/very/long/path/without/spaces", 80.0, 12.0);
        assert!(lines.len() >= 3);
        assert_eq!(lines.concat(), "https://example.com/very/long/path/without/spaces");

        let cjk = wrap_text("一二三四五六七八九十", 50.0, 14.0);
        assert!(cjk.len() >= 3);
        assert_eq!(cjk.concat(), "一二三四五六七八九十");
    }

    #[test]
    fn extract_url_host_handles_user_port_and_non_authority_schemes() {
        assert_eq!(extract_url_host("https://github.com/obsidianmd/jsoncanvas"), Some("github.com"));
        assert_eq!(extract_url_host("http://user@127.0.0.1:8787/api"), Some("127.0.0.1:8787"));
        assert_eq!(extract_url_host("mailto:hello@vibevalley.dev"), None);
    }
}
