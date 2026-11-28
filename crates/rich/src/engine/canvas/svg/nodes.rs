use std::fmt::Write as _;

use crate::engine::canvas::model::{BackgroundStyle, CanvasColor, FileNode, GroupNode, LinkNode, Node, Rect, Rgba8, TextNode};

use super::geometry::{GROUP_LABEL_GAP, GROUP_LABEL_HEIGHT, group_label_rect};
use super::text::{escape_xml, estimate_text_width, extract_url_host, layout_markdown_lines, wrap_text};
use super::theme::{SvgRenderOptions, ThemePalette};

pub(super) fn render_node(node: &Node, index: usize, palette: &ThemePalette, options: &SvgRenderOptions, defs: &mut String, out: &mut String) {
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

#[allow(clippy::too_many_arguments)]
fn begin_clipped_card(
    node_type: &str,
    id: &str,
    rect: Rect,
    color: Option<&CanvasColor>,
    index: usize,
    palette: &ThemePalette,
    options: &SvgRenderOptions,
    defs: &mut String,
    out: &mut String,
) -> Rgba8 {
    let clip_id = format!("vv-clip-{index}");
    let _ = write!(
        defs,
        r#"<clipPath id="{clip_id}"><rect x="{:.2}" y="{:.2}" width="{:.2}" height="{:.2}"/></clipPath>"#,
        rect.x + 4.0,
        rect.y + 4.0,
        (rect.width - 8.0).max(1.0),
        (rect.height - 8.0).max(1.0),
    );
    let _ = write!(out, r#"<g data-node-type="{node_type}" data-node-id="{}">"#, escape_xml(id));
    let accent = render_card_frame(rect, color, palette, options, out);
    let _ = write!(out, r#"<g clip-path="url(#{clip_id})">"#);
    accent
}

fn render_text_node(node: &TextNode, index: usize, palette: &ThemePalette, options: &SvgRenderOptions, defs: &mut String, out: &mut String) {
    let x = node.x as f64;
    let y = node.y as f64;
    let w = node.width as f64;
    let h = node.height as f64;
    let pad = 14.0;
    begin_clipped_card(
        "text",
        node.id.as_str(),
        Rect::new(x, y, w, h),
        node.color.as_ref(),
        index,
        palette,
        options,
        defs,
        out,
    );

    let inner_w = (w - pad * 2.0).max(20.0);
    let styled_lines = layout_markdown_lines(&node.text, inner_w, options.font_size);

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
    let accent = begin_clipped_card(
        "file",
        node.id.as_str(),
        Rect::new(x, y, w, h),
        node.color.as_ref(),
        index,
        palette,
        options,
        defs,
        out,
    );

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
    begin_clipped_card(
        "link",
        node.id.as_str(),
        Rect::new(x, y, w, h),
        node.color.as_ref(),
        index,
        palette,
        options,
        defs,
        out,
    );

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
