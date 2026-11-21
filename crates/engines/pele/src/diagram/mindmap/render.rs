use crate::Rendered;
use crate::diagram::RenderContext;
use crate::diagram::common::{icon_svg, title_room, turn_to_fit};
use crate::measure::TextStyle;
use crate::svg::builder::{esc_text, label_svg, num};
use crate::svg::root::{Accessible, svg_document};
use crate::svg::shapes::{ShapeKind, draw_shape, shape_inset, shape_size};
use crate::svg::theme::class_names;
use crate::svg::title::title_label;
use crate::text::label::{Label, layout_label};
use crate::util::yaml::YamlValue;

use super::db::{MindmapModel, MindmapNode};
use super::outline::NodeShape;

const GAP_X: f64 = 36.0;
const GAP_Y: f64 = 8.0;
const GROUP_GAP: f64 = 18.0;
const BRANCH_GAP_X: f64 = 52.0;
const BRANCH_GAP_Y: f64 = 28.0;
const TEXT_PAD: f64 = 6.0;
const PILL_PAD: f64 = 12.0;
const TINT: f64 = 0.22;
const ICON_GAP: f64 = 6.0;
const INDENT: f64 = 28.0;
const STEM: f64 = 12.0;
const BEND: f64 = 8.0;
const ROW_GAP: f64 = 10.0;

fn shape_for(node_shape: NodeShape, is_root: bool) -> Option<ShapeKind> {
    match node_shape {
        NodeShape::Default => is_root.then_some(ShapeKind::Stadium),
        NodeShape::RoundedRect => Some(ShapeKind::Rounded),
        NodeShape::Rect => Some(ShapeKind::Rect),
        NodeShape::Circle => Some(ShapeKind::Circle),
        NodeShape::Cloud => Some(ShapeKind::Cloud),
        NodeShape::Bang => Some(ShapeKind::Bang),
        NodeShape::Hexagon => Some(ShapeKind::Hex),
    }
}

fn left_label(label: &Label, left: f64, cy: f64, ctx: &RenderContext<'_>) -> String {
    if label.lines.len() < 2 {
        return label_svg(label, left + label.width / 2.0, cy, r#" class="pele-label""#, ctx.theme, ctx.icons);
    }
    let mut out = String::new();
    let top = cy - label.height / 2.0;
    for k in 0..label.lines.len() {
        let single = label.single_line(k);
        out.push_str(&label_svg(
            &single,
            left + label.widths[k] / 2.0,
            top + label.line_middle(k),
            r#" class="pele-label""#,
            ctx.theme,
            ctx.icons,
        ));
    }
    out
}

pub fn render_mindmap(model: &MindmapModel, ctx: &RenderContext<'_>) -> Rendered {
    turn_to_fit(ctx.options, |down| draw(model, ctx, down))
}

fn draw(model: &MindmapModel, ctx: &RenderContext<'_>, down: bool) -> Rendered {
    let size = ctx.options.font_size.unwrap_or(16.0);
    let pad = ctx.options.padding.unwrap_or(8.0);
    let max_node_width = ctx.config.section("mindmap").and_then(|s| s.get("maxNodeWidth")).and_then(YamlValue::as_f64);
    let wrap = match max_node_width {
        Some(v) if v.is_finite() && v > 0.0 => v.min(2000.0),
        _ => 200.0,
    };
    let glyph = size * 1.25;

    let nodes = &model.nodes;
    let n = nodes.len();
    let mut parent = vec![0usize; n];
    let mut depth = vec![0usize; n];
    for (i, node) in nodes.iter().enumerate() {
        for &child_id in &node.children {
            parent[child_id] = i;
            depth[child_id] = depth[i] + 1;
        }
    }

    let room = if down
        && let Some(mw) = ctx.options.max_width
        && mw > 0.0
    {
        mw - 2.0 * pad
    } else {
        f64::INFINITY
    };

    let mut labels: Vec<Label> = Vec::with_capacity(n);
    let mut shapes: Vec<Option<ShapeKind>> = Vec::with_capacity(n);
    let mut w = vec![0.0f64; n];
    let mut h = vec![0.0f64; n];
    let mut dy = vec![0.0f64; n];
    let mut anchor = vec![0.0f64; n];
    let mut drawn = vec![false; n];

    let has_icon = |name: Option<&str>| -> bool { name.is_some_and(|n| !n.is_empty() && ctx.icons.and_then(|f| f(n)).is_some_and(|m| !m.is_empty())) };

    for (i, node) in nodes.iter().enumerate() {
        drawn[i] = has_icon(node.icon.as_deref());
        let icon_room = if drawn[i] { glyph + ICON_GAP } else { 0.0 };
        let fit = wrap.min(72.0f64.max(room - (depth[i] as f64) * INDENT - 2.0 * TEXT_PAD - icon_room));
        let label = layout_label(Some(&node.descr), true, ctx.measurer, size, fit, TextStyle::NONE, ctx.icons, ctx.math);
        let tw = label.width
            + if drawn[i] {
                glyph + if label.width > 0.0 { ICON_GAP } else { 0.0 }
            } else {
                0.0
            };
        let th = label.height.max((size * 1.5).round());
        let mut shape = shape_for(node.shape, i == 0);
        if down && i == 0 && !matches!(shape, Some(ShapeKind::Rect | ShapeKind::Rounded)) {
            shape = Some(ShapeKind::Stadium);
        }
        shapes.push(shape);
        if let Some(sk) = shape {
            let s = shape_size(sk, tw, th);
            w[i] = s.w;
            h[i] = s.h;
            dy[i] = s.dy;
            anchor[i] = s.h / 2.0;
        } else {
            let pill = !node.children.is_empty();
            w[i] = tw + 2.0 * if pill { PILL_PAD } else { TEXT_PAD };
            h[i] = th + if pill { 6.0 } else { 0.0 };
            anchor[i] = h[i] / 2.0;
        }
        labels.push(label);
    }

    let mut extent = vec![0.0f64; n];
    let mut rel = vec![0.0f64; n];
    let mut own = vec![0.0f64; n];
    let mut kids = vec![0.0f64; n];

    let stack_children =
        |nodes: &[MindmapNode], list: &[usize], from: usize, to: usize, gap: f64, extent: &[f64], rel: &mut [f64], own: &[f64], anchor: &[f64]| -> (f64, f64) {
            let mut y = 0.0f64;
            let mut last = 0.0f64;
            for k in from..to {
                let c = list[k];
                rel[c] = y;
                let grouped = !nodes[c].children.is_empty() || (k + 1 < to && !nodes[list[k + 1]].children.is_empty());
                last = if grouped { gap.max(GROUP_GAP) } else { gap };
                y += extent[c] + last;
            }
            let stacked = y - last;
            let a = list[from];
            let b = list[to - 1];
            let mid = (rel[a] + own[a] + anchor[a] + rel[b] + own[b] + anchor[b]) / 2.0;
            (stacked, mid)
        };

    for i in (1..n).rev() {
        let children = &nodes[i].children;
        if children.is_empty() {
            extent[i] = h[i];
            continue;
        }
        let (stacked, mid) = stack_children(nodes, children, 0, children.len(), GAP_Y, &extent, &mut rel, &own, &anchor);
        let top = mid - anchor[i];
        let low = top.min(0.0);
        extent[i] = stacked.max(top + h[i]) - low;
        own[i] = top - low;
        kids[i] = -low;
    }

    let mut x = vec![0.0f64; n];
    let mut y = vec![0.0f64; n];
    let mut band = vec![0.0f64; n];
    let mut side = vec![0i8; n];
    let mut trunk = vec![0.0f64; n];

    if down {
        let mut row = 0.0f64;
        for i in 0..n {
            if i > 0 && parent[i] == 0 {
                row += ROW_GAP;
            }
            x[i] = (depth[i] as f64) * INDENT + w[i] / 2.0;
            y[i] = row;
            row += h[i] + ROW_GAP;
        }
    } else if n > 0 {
        let branches = &nodes[0].children;
        let count = branches.len();
        let total: f64 = branches.iter().map(|&id| extent[id]).sum();
        let mut split = count;
        let mut best = f64::INFINITY;
        let mut right = 0.0f64;
        for k in 1..count {
            right += extent[branches[k - 1]];
            let diff = (2.0 * right - total + ((2 * k) as isize - count as isize) as f64 * BRANCH_GAP_Y).abs();
            if diff < best {
                best = diff;
                split = k;
            }
        }
        for (from, to, dir) in [(0, split, 1i8), (split, count, -1i8)] {
            if from >= to {
                continue;
            }
            let (_, middle) = stack_children(nodes, branches, from, to, BRANCH_GAP_Y, &extent, &mut rel, &own, &anchor);
            for &c in &branches[from..to] {
                band[c] = rel[c] - middle;
                side[c] = dir;
            }
        }
        y[0] = -h[0] / 2.0;
        for i in 0..n {
            if i > 0 {
                y[i] = band[i] + own[i];
            }
            for &c in &nodes[i].children {
                if i > 0 {
                    side[c] = side[i];
                    band[c] = band[i] + kids[i] + rel[c];
                }
                x[c] = x[i] + (side[c] as f64) * (w[i] / 2.0 + if i > 0 { GAP_X } else { BRANCH_GAP_X } + w[c] / 2.0);
            }
        }
    }

    let mut min_x = 0.0f64;
    let mut max_x = 0.0f64;
    let mut min_y = 0.0f64;
    let mut max_y = 0.0f64;
    let mut out = String::new();
    let mut edges = String::new();
    let mut body = String::new();
    let mut color = String::new();

    let flush = |out: &mut String, edges: &mut String, body: &mut String, color: &str, section: Option<usize>| {
        if body.is_empty() {
            return;
        }
        out.push_str(&format!(
            r#"<g class="pele-branch pele-section-{}"><g class="pele-edges" fill="none" stroke="{color}" stroke-width="1.5">{edges}</g>{body}</g>"#,
            section.unwrap_or(0),
        ));
        edges.clear();
        body.clear();
    };

    let root_shape_attrs = ctx.theme.shape_attrs();
    let root_line_attrs = ctx.theme.line_attrs();

    for k in 1..=n {
        let i = k % n;
        let node = &nodes[i];
        let shape = shapes[i];
        let label = &labels[i];
        let cx = x[i];
        let top = y[i];
        min_x = min_x.min(cx - w[i] / 2.0);
        max_x = max_x.max(cx + w[i] / 2.0);
        min_y = min_y.min(top);
        max_y = max_y.max(top + h[i]);

        if i == 0 || parent[i] == 0 {
            flush(&mut out, &mut edges, &mut body, &color, nodes[k - 1].section);
        }
        if i > 0 && down {
            if parent[i] == 0 {
                color = ctx.theme.series_color(node.section.unwrap_or(0), ctx.palette).into_owned();
            }
            let p = parent[i];
            let stem = if p == 0 { STEM.max(h[0] / 2.0).min(INDENT - BEND) } else { STEM };
            let x1 = x[p] - w[p] / 2.0 + stem.min(w[p] / 2.0);
            let y1 = if trunk[p] != 0.0 { trunk[p] } else { y[p] + h[p] };
            let left = cx - w[i] / 2.0;
            let x2 = left + shape.map_or(0.0, |sk| shape_inset(sk, w[i], h[i], 3, 0.0));
            let y2 = top + anchor[i];
            let bend = 0.0f64.max(BEND.min(x2 - x1).min(y2 - y1));
            trunk[p] = y2 - bend;
            edges.push_str(&format!(
                r#"<path class="pele-edge" d="M{},{}V{}Q{},{} {},{}H{}"/>"#,
                num(x1),
                num(y1),
                num(y2 - bend),
                num(x1),
                num(y2),
                num(x1 + bend),
                num(y2),
                num(x2),
            ));
        } else if i > 0 {
            if parent[i] == 0 {
                color = ctx.theme.series_color(node.section.unwrap_or(0), ctx.palette).into_owned();
            }
            let p = parent[i];
            let dir = side[i] as f64;
            let from_side = if side[i] > 0 { 1 } else { 3 };
            let x1 = x[p] + dir * (w[p] / 2.0 - shapes[p].map_or(0.0, |sk| shape_inset(sk, w[p], h[p], from_side, 0.0)));
            let y1 = y[p] + anchor[p];
            let near = cx - (dir * w[i]) / 2.0;
            let x2 = near + shape.map_or(0.0, |sk| dir * shape_inset(sk, w[i], h[i], 4 - from_side, 0.0));
            let y2 = top + anchor[i];
            let mid = num((x1 + x2) / 2.0);
            edges.push_str(&format!(
                r#"<path class="pele-edge" d="M{},{}C{mid},{} {mid},{} {},{}"/>"#,
                num(x1),
                num(y1),
                num(y1),
                num(y2),
                num(x2),
                num(y2),
            ));
        }

        let pill = shape.is_none() && !node.children.is_empty();
        let tint = format!(r#" fill="{color}" fill-opacity="{TINT}" stroke="{color}""#);
        let mut inner = if let Some(sk) = shape {
            if i > 0 {
                draw_shape(sk, w[i], h[i], &tint, &format!(r#" stroke="{color}""#), ctx.theme)
            } else {
                draw_shape(sk, w[i], h[i], &root_shape_attrs, &root_line_attrs, ctx.theme)
            }
        } else if pill {
            format!(
                r#"<rect x="{}" y="{}" width="{}" height="{}" rx="{}"{tint}/>"#,
                num(-w[i] / 2.0),
                num(-h[i] / 2.0),
                num(w[i]),
                num(h[i]),
                num(h[i] / 2.0),
            )
        } else {
            String::new()
        };

        let mut shift = 0.0f64;
        if drawn[i]
            && let Some(icon_name) = &node.icon
        {
            shift = (glyph + if label.width > 0.0 { ICON_GAP } else { 0.0 }) / 2.0;
            inner.push_str(&icon_svg(icon_name, -shift - label.width / 2.0, dy[i] - glyph / 2.0, glyph, ctx.icons));
        }

        let shape_cls = shape.map_or(if pill { "branch" } else { "text" }, ShapeKind::as_str);
        let root_cls = if i == 0 { " pele-root" } else { "" };
        let extra_cls = class_names(node.class.as_deref().unwrap_or(""));
        let lbl_svg = if down && shape.is_none() {
            left_label(label, shift - label.width / 2.0, dy[i], ctx)
        } else {
            label_svg(label, shift, dy[i], r#" class="pele-label""#, ctx.theme, ctx.icons)
        };
        let group = format!(
            r#"<g class="pele-node pele-shape-{shape_cls}{root_cls}{extra_cls}" data-id="{}" transform="translate({},{})">{inner}{lbl_svg}</g>"#,
            esc_text(&node.node_id),
            num(cx),
            num(top + h[i] / 2.0),
        );
        if i > 0 {
            body.push_str(&group);
        } else {
            out.push_str(&group);
        }
    }

    let title = title_label(model.title.as_deref(), ctx.measurer, size, title_room(ctx.options));
    let title_height = if title.height > 0.0 { title.height + 16.0 } else { 0.0 };
    let width = (max_x - min_x).max(title.width);
    let total_width = (width + 2.0 * pad).ceil();
    let total_height = (max_y - min_y + title_height + 2.0 * pad).ceil();
    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let content = format!(
        r#"{}<g transform="translate({},{})">{out}</g>"#,
        label_svg(&title, total_width / 2.0, pad + title.height / 2.0, &title_attrs, ctx.theme, ctx.icons),
        num(pad - min_x + (width - max_x + min_x) / 2.0),
        num(pad + title_height - min_y),
    );

    let svg = svg_document(
        "mindmap",
        total_width,
        total_height,
        size,
        ctx.options,
        ctx.responsive,
        ctx.theme,
        ctx.palette,
        Accessible::default(),
        &content,
    );
    Rendered {
        svg,
        width: total_width,
        height: total_height,
        links: Vec::new(),
    }
}
