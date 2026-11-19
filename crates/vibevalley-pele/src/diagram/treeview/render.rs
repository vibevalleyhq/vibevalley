use std::collections::HashMap;

use crate::config::DiagramConfig;
use crate::diagram::RenderContext;
use crate::diagram::common::{tighten, title_room};
use crate::measure::TextStyle;
use crate::svg::builder::{esc, esc_text, label_svg, num};
use crate::svg::root::{Accessible, svg_document};
use crate::svg::theme::class_names;
use crate::text::entities::decode_entities;
use crate::text::label::{Label, layout_label};
use crate::text::literal::{left_label_svg, literal_label};
use crate::util::yaml::YamlValue;
use crate::{MonospacePart, Rendered};

use super::icons::{BUILTIN_PACK, FILE_GLYPH, FOLDER_GLYPH, get_node_icon, glyph_for, icon_config};
use super::model::{NodeType, TreeNode, TreeViewModel};

const ICON_GAP: f64 = 6.0;
const DESC_GAP: f64 = 16.0;
const GUIDE_INSET: f64 = 7.0;
const ELBOW: f64 = 4.0;
const HIGHLIGHT_OVERHANG: f64 = 4.0;

#[derive(Debug, Clone, Copy)]
pub struct TreeSettings {
    pub padding_x: f64,
    pub padding_y: f64,
    pub row_indent: f64,
    pub line_thickness: f64,
}

fn setting(config: &DiagramConfig, key: &str, fallback: f64, min: f64, max: f64) -> f64 {
    let val = config.section("treeView").and_then(|s| s.get(key)).and_then(YamlValue::as_f64);
    match val {
        Some(v) if v.is_finite() && v >= min && v <= max => v,
        _ => fallback,
    }
}

pub fn tree_settings(config: &DiagramConfig) -> TreeSettings {
    TreeSettings {
        padding_x: setting(config, "paddingX", 5.0, 0.0, 100.0),
        padding_y: setting(config, "paddingY", 2.0, 0.0, 100.0),
        row_indent: setting(config, "rowIndent", 15.0, 0.0, 400.0),
        line_thickness: setting(config, "lineThickness", 1.0, 0.25, 12.0),
    }
}

struct Row<'a> {
    node: &'a TreeNode,
    x: f64,
    cy: f64,
    icon: Option<String>,
    text: String,
    label_x: f64,
    highlighted: bool,
    label: Option<Label>,
    description: Option<Label>,
    top: f64,
    height: f64,
}

pub fn render_tree_view(model: &TreeViewModel, ctx: &RenderContext<'_>) -> Rendered {
    tighten(ctx.options, |tight| draw(model, ctx, tight))
}

fn draw(model: &TreeViewModel, ctx: &RenderContext<'_>, tight: bool) -> Rendered {
    let size = ctx.options.font_size.unwrap_or(16.0);
    let pad = ctx.options.padding.unwrap_or(8.0);
    let icons = icon_config(ctx.config);
    let mono = ctx.options.monospace.contains(&MonospacePart::Files);
    let family = if mono {
        format!(r#" font-family="{}""#, ctx.theme.font_mono())
    } else {
        String::new()
    };

    let settings = tree_settings(ctx.config);
    let mut max_depth = 0usize;
    if tight {
        let mut depths: Vec<(&TreeNode, usize)> = model.root.children.iter().map(|n| (n, 0)).collect();
        let mut idx = 0usize;
        while idx < depths.len() {
            let (node, depth) = depths[idx];
            max_depth = max_depth.max(depth);
            for child in &node.children {
                depths.push((child, depth + 1));
            }
            idx += 1;
        }
    }

    let step = if tight {
        let avail = (ctx.options.max_width.unwrap_or(320.0) - 120.0) / (max_depth.max(1) as f64);
        (settings.row_indent + settings.padding_x).min(2.0f64.max(avail))
    } else {
        settings.row_indent + settings.padding_x
    };
    let row_height = (size * 1.5).round() + 2.0 * settings.padding_y;
    let icon_size = size;

    let title = layout_label(
        model.title.as_deref(),
        false,
        ctx.measurer,
        size,
        if tight { title_room(ctx.options) } else { 4000.0 },
        TextStyle::BOLD,
        ctx.icons,
        None,
    );
    let title_height = if title.height > 0.0 { title.height + 12.0 } else { 0.0 };

    let mut rows: Vec<Row<'_>> = Vec::new();
    let mut row_of: HashMap<usize, usize> = HashMap::new();
    let mut pending: Vec<(&TreeNode, usize, bool)> = Vec::new();
    fn push<'a>(pending: &mut Vec<(&'a TreeNode, usize, bool)>, list: &'a [TreeNode], depth: usize, icons: &super::icons::IconConfig) {
        let slot = list
            .iter()
            .any(|child| get_node_icon(child.icon.as_deref(), &child.name, child.node_type, icons).is_some());
        for child in list.iter().rev() {
            pending.push((child, depth, slot));
        }
    }
    push(&mut pending, &model.root.children, 0, &icons);

    let mut label_right = 0.0f64;
    let mut any_highlight = false;
    let mut rows_height = 0.0f64;

    while let Some((node, depth, slot)) = pending.pop() {
        let x = (depth as f64) * step;
        let text = decode_entities(&node.name);
        let label_x = x + if slot { icon_size + ICON_GAP } else { 0.0 };
        let room = 40.0f64.max(ctx.options.max_width.unwrap_or(320.0) - 2.0 * pad - 2.0 * HIGHLIGHT_OVERHANG - label_x);
        let mut style = TextStyle::NONE;
        if node.node_type == NodeType::Directory {
            style |= TextStyle::BOLD;
        }
        if mono {
            style |= TextStyle::MONO;
        }
        let label = if tight {
            Some(literal_label(&text, ctx.measurer, size, room, style))
        } else {
            None
        };
        let description = if tight {
            node.description
                .as_deref()
                .map(|d| literal_label(&decode_entities(d), ctx.measurer, size, room, TextStyle::ITALIC))
        } else {
            None
        };
        let w = label.as_ref().map_or_else(|| ctx.measurer.width(&text, size, style), |l| l.width);
        if label_x + w > label_right {
            label_right = label_x + w;
        }
        let highlighted = node.css_class.as_deref().is_some_and(|c| c.split_whitespace().any(|w| w == "highlight"));
        if highlighted {
            any_highlight = true;
        }
        let h = if tight {
            row_height.max(label.as_ref().map_or(0.0, |l| l.height) + description.as_ref().map_or(0.0, |d| d.height) + 2.0 * settings.padding_y)
        } else {
            row_height
        };
        let cy = rows_height
            + if tight {
                settings.padding_y + icon_size.max(label.as_ref().map_or(0.0, |l| l.height)) / 2.0
            } else {
                h / 2.0
            };
        let icon = get_node_icon(node.icon.as_deref(), &node.name, node.node_type, &icons);
        let row_idx = rows.len();
        rows.push(Row {
            node,
            x,
            cy,
            icon,
            text,
            label_x,
            highlighted,
            label,
            description,
            top: rows_height,
            height: h,
        });
        row_of.insert(node.id, row_idx);
        rows_height += h;
        push(&mut pending, &node.children, depth + 1, &icons);
    }

    let desc_x = label_right + DESC_GAP;
    let mut width = label_right;
    for row in &rows {
        if let Some(desc_raw) = row.node.description.as_deref() {
            let w = row
                .description
                .as_ref()
                .map_or_else(|| ctx.measurer.width(&decode_entities(desc_raw), size, TextStyle::ITALIC), |d| d.width);
            width = width.max((if tight { row.label_x } else { desc_x }) + w);
        }
    }
    width = width.max(title.width);

    let inset = pad + if any_highlight { HIGHLIGHT_OVERHANG } else { 0.0 };
    let top = pad + title_height;
    let total_width = (width + 2.0 * inset).ceil();
    let total_height = (top + rows_height + pad).ceil();

    let mut guides = String::new();
    for row in &rows {
        let children = &row.node.children;
        if children.is_empty() {
            continue;
        }
        let gx = inset + row.x + GUIDE_INSET;
        let tick = gx.max(inset + row.x + step - settings.padding_x);
        let last_row = &rows[row_of[&children.last().unwrap().id]];
        let last = top + last_row.cy;
        let r = ELBOW.min(tick - gx);
        let mut d = format!("M{},{}V{}", num(gx), num(top + row.top + row.height - 2.0), num(last - r));
        if r > 0.0 {
            d.push_str(&format!("Q{},{} {},{}H{}", num(gx), num(last), num(gx + r), num(last), num(tick)));
        }
        if tick > gx {
            for child in &children[..children.len() - 1] {
                let child_row = &rows[row_of[&child.id]];
                d.push_str(&format!("M{},{}H{}", num(gx), num(top + child_row.cy), num(tick)));
            }
        }
        guides.push_str(&format!(r#"<path d="{d}"/>"#));
    }

    let baseline = size * 0.35;
    let rounded = ctx.theme.rounded_standalone();
    let dir_weight = format!(r#" font-weight="{}""#, ctx.theme.heading_weight());
    let desc_attrs = format!(r#" class="pele-tree-description" font-style="italic" fill="{}""#, ctx.theme.muted());
    let pack_prefix = format!("{BUILTIN_PACK}:");
    let mut body = String::new();

    for row in &rows {
        let node = row.node;
        let cy = top + row.cy;
        let directory = node.node_type == NodeType::Directory;
        let mut inner = String::new();
        if row.highlighted {
            let hx = inset + row.x - HIGHLIGHT_OVERHANG;
            inner.push_str(&format!(
                r#"<rect class="pele-tree-highlight" x="{}" y="{}" width="{}" height="{}" fill="{}" fill-opacity="0.14"{rounded}/>"#,
                num(hx),
                num(top + row.top + 1.0),
                num(total_width - inset + HIGHLIGHT_OVERHANG - hx),
                num(row.height - 2.0),
                ctx.theme.accent(),
            ));
        }
        if let Some(icon_name) = &row.icon {
            let short = icon_name.strip_prefix(&pack_prefix).unwrap_or("");
            let glyph = glyph_for(short).unwrap_or(if directory { FOLDER_GLYPH } else { FILE_GLYPH });
            let drawn = ctx
                .icons
                .and_then(|f| f(icon_name))
                .unwrap_or_else(|| format!(r#"<path d="{glyph}" stroke="{}" stroke-width="1.5"/>"#, ctx.theme.muted()));
            inner.push_str(&format!(
                r#"<svg class="pele-icon" data-icon="{}" x="{}" y="{}" width="{}" height="{}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{drawn}</svg>"#,
                esc_text(icon_name),
                num(inset + row.x),
                num(cy - icon_size / 2.0),
                num(icon_size),
                num(icon_size),
            ));
        }
        let weight_attr = if directory { dir_weight.as_str() } else { "" };
        if let Some(lbl) = &row.label {
            let attrs = format!(r#" class="pele-label"{weight_attr}{family}"#);
            inner.push_str(&left_label_svg(lbl, inset + row.label_x, top + row.top + settings.padding_y, &attrs, ctx.theme));
        } else if !row.text.is_empty() {
            inner.push_str(&format!(
                r#"<text class="pele-label" x="{}" y="{}"{weight_attr}{family} xml:space="preserve">{}</text>"#,
                num(inset + row.label_x),
                num(cy + baseline),
                esc(&row.text),
            ));
        }
        if let Some(desc_lbl) = &row.description {
            let lbl_h = row.label.as_ref().map_or(0.0, |l| l.height);
            inner.push_str(&left_label_svg(
                desc_lbl,
                inset + row.label_x,
                top + row.top + settings.padding_y + lbl_h,
                &desc_attrs,
                ctx.theme,
            ));
        } else if let Some(desc_raw) = &node.description {
            inner.push_str(&format!(
                r#"<text class="pele-tree-description" x="{}" y="{}" font-style="italic" fill="{}" xml:space="preserve">{}</text>"#,
                num(inset + desc_x),
                num(cy + baseline),
                ctx.theme.muted(),
                esc(&decode_entities(desc_raw)),
            ));
        }
        let kind_cls = if directory { "dir" } else { "file" };
        let extra_cls = class_names(node.css_class.as_deref().unwrap_or(""));
        body.push_str(&format!(
            r#"<g class="pele-node pele-tree-{kind_cls}{extra_cls}" data-id="{}">{inner}</g>"#,
            esc_text(&node.name),
        ));
    }

    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let mut content = label_svg(&title, total_width / 2.0, pad + title.height / 2.0, &title_attrs, ctx.theme, ctx.icons);
    if !guides.is_empty() {
        content.push_str(&format!(
            r#"<g class="pele-tree-guides" fill="none" stroke="{}" stroke-width="{}">{guides}</g>"#,
            ctx.theme.border(),
            num(settings.line_thickness),
        ));
    }
    content.push_str(&body);

    let svg = svg_document(
        "treeView",
        total_width,
        total_height,
        size,
        ctx.options,
        ctx.responsive,
        ctx.theme,
        ctx.palette,
        Accessible {
            acc_title: model.acc_title.as_deref(),
            acc_descr: model.acc_descr.as_deref(),
        },
        &content,
    );
    Rendered {
        svg,
        width: total_width,
        height: total_height,
        links: Vec::new(),
    }
}
