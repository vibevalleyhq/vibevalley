use std::collections::HashMap;

use crate::diagram::RenderContext;
use crate::diagram::common::{runs_across, turn_to_fit};
use crate::layout::compound::{CEdge, CNode, Dir, cedge, cnode, compound_layout, direction, shift_layout};
use crate::layout::layered::LayeredOptions;
use crate::measure::TextStyle;
use crate::svg::builder::{esc, esc_text, label_svg, num};
use crate::svg::cluster::{Crossings, mark_crossings};
use crate::svg::edges::{EdgePath, Fill, FillRelation, casing, casings_svg, edge_label_svg, fill_under, marker, marker_trim, route_path};
use crate::svg::ink::{extract_css_prop, ink, ink_fill, paints};
use crate::svg::root::{Accessible, svg_document};
use crate::svg::theme::{ResolvedStyle, SvgTheme, class_names, resolve_style, sets_fill};
use crate::svg::title::title_label;
use crate::text::label::{Label, layout_label};
use crate::util::yaml::YamlValue;
use crate::{IconResolver, Rendered};

use super::graph::{EdgePattern, UsecaseEdgeKind, UsecaseGraphEdge, UsecaseGraphNode, UsecaseNodeShape, build_usecase_graph};
use super::types::{ActorType, BoundaryType, LabelType, UsecaseModel};

const NODE_SEP: f64 = 32.0;
const EDGE_SEP: f64 = 16.0;
const RANK_SEP: f64 = 72.0;
const GROUP_PAD: f64 = 20.0;
const LOOP: f64 = 26.0;
const FIGURE_W: f64 = 40.0;
const FIGURE_H: f64 = 60.0;
const FIGURE_GAP: f64 = 6.0;
const TAB_PAD: f64 = 6.0;
const CELL_PAD: f64 = 10.0;
const ROW_PAD: f64 = 8.0;
const FOLD: f64 = 9.0;
const EXTENSION: f64 = 12.0;
const PORT_GAP: f64 = 14.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ViewKind {
    Actor,
    Ellipse,
    Box,
    Json,
    Boundary,
}

struct View {
    node: UsecaseGraphNode,
    kind: ViewKind,
    style: ResolvedStyle,
    label: Label,
    stereotype: Label,
    w: f64,
    h: f64,
    rows: Vec<(Label, Label)>,
    key_w: f64,
    head_h: f64,
}

fn number_option(ctx: &RenderContext<'_>, key: &str, fallback: f64) -> f64 {
    match ctx.config.section("usecase").and_then(|s| s.get(key)).and_then(YamlValue::as_f64) {
        Some(v) if v > 0.0 => v.min(2000.0),
        _ => fallback,
    }
}

/// A plain label is shown as written: no tags, no markdown, no `\n` breaks.
fn literal(text: &str) -> String {
    if !text.chars().any(|c| matches!(c, '&' | '<' | '>' | '\\')) {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len() + 16);
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&#38;"),
            '<' => out.push_str("&#60;"),
            '>' => out.push_str("&#62;"),
            '\\' => out.push_str("&#92;"),
            other => out.push(other),
        }
    }
    out
}

fn text_label(raw: Option<&str>, markdown: bool, ctx: &RenderContext<'_>, size: f64, wrap: f64, base: TextStyle) -> Label {
    let owned;
    let input = match raw {
        Some(s) if !s.is_empty() && !markdown => {
            owned = literal(s);
            Some(owned.as_str())
        }
        other => other,
    };
    layout_label(input, markdown, ctx.measurer, size, wrap, base, ctx.icons, ctx.math)
}

/// The point of a node's outline on one of its four sides (0 top, 1 right, 2 bottom, 3 left),
/// `along` away from the middle of that side. Lines meet an actor at its figure, not at its label.
fn anchor(view: &View, c: &CNode, side: usize, along: f64) -> (f64, f64) {
    let sign = if side == 1 || side == 2 { 1.0 } else { -1.0 };
    let upright = side == 1 || side == 3;
    let mut reach = if upright { view.w } else { view.h } / 2.0;
    let mut middle = 0.0;
    match view.kind {
        ViewKind::Actor => {
            if upright {
                reach = FIGURE_W / 2.0 + 3.0;
                middle = (FIGURE_H - view.h) / 2.0;
            } else {
                reach += 2.0;
            }
        }
        ViewKind::Ellipse => {
            let span = if upright { view.h } else { view.w } / 2.0;
            reach *= (1.0 - (along / span).powi(2)).max(0.0).sqrt();
        }
        ViewKind::Box | ViewKind::Json | ViewKind::Boundary => {}
    }
    if upright {
        (c.x + sign * reach, c.y + middle + along)
    } else {
        (c.x + along, c.y + sign * reach)
    }
}

fn side_length(view: &View, side: usize) -> f64 {
    let upright = side == 1 || side == 3;
    if view.kind == ViewKind::Actor {
        return if upright { FIGURE_H * 0.5 } else { FIGURE_W * 0.6 };
    }
    let length = if upright { view.h } else { view.w };
    if view.kind == ViewKind::Ellipse { length * 0.6 } else { length - 16.0 }
}

fn attach_ends(cedges: &mut [CEdge], cnodes: &[CNode], views: &[View]) {
    let mut sides: HashMap<usize, Vec<(usize, usize, f64)>> = HashMap::new();
    for (ei, e) in cedges.iter().enumerate() {
        if e.src == e.dst || e.route.len() < 6 {
            continue;
        }
        let last = e.route.len() - 3;
        for (node_idx, at, next) in [(e.src, 0usize, 3usize), (e.dst, last, last - 3)] {
            let c = &cnodes[node_idx];
            if c.is_group {
                continue;
            }
            let dx = e.route[at] - c.x;
            let dy = e.route[at + 1] - c.y;
            let side = if (dy.abs() - c.h / 2.0).abs() < 0.5 {
                if dy < 0.0 { 0usize } else { 2usize }
            } else if (dx.abs() - c.w / 2.0).abs() < 0.5 {
                if dx < 0.0 { 3usize } else { 1usize }
            } else {
                continue;
            };
            let key = node_idx * 4 + side;
            let toward = e.route[next + (side & 1)];
            sides.entry(key).or_default().push((ei, at, toward));
        }
    }
    for (key, mut ends) in sides {
        let index = key >> 2;
        let side = key & 3;
        let view = &views[index];
        let step = if ends.len() > 1 {
            PORT_GAP.min(side_length(view, side) / (ends.len() - 1) as f64)
        } else {
            0.0
        };
        ends.sort_by(|a, b| a.2.total_cmp(&b.2));
        for (i, &(ei, at, _)) in ends.iter().enumerate() {
            let (x, y) = anchor(view, &cnodes[index], side, (i as f64 - (ends.len() - 1) as f64 / 2.0) * step);
            cedges[ei].route[at] = x;
            cedges[ei].route[at + 1] = y;
        }
    }
}

fn extension_marker(x: f64, y: f64, dx: f64, dy: f64, color: &str, bg: &str) -> String {
    let bx = x - dx * EXTENSION;
    let by = y - dy * EXTENSION;
    let half = EXTENSION * 0.5;
    format!(
        r#"<path class="pele-marker" d="M{},{}L{},{}L{},{}Z" fill="{bg}" stroke="{color}" stroke-linejoin="round"/>"#,
        num(x),
        num(y),
        num(bx - dy * half),
        num(by + dx * half),
        num(bx + dy * half),
        num(by - dx * half),
    )
}

fn trim(marker_type: &str) -> f64 {
    if marker_type == "extension" { EXTENSION } else { marker_trim(marker_type) }
}

fn mark(marker_type: &str, tip: (f64, f64), dir: (f64, f64), color: &str, stroke: &str, bg: &str) -> String {
    if marker_type == "extension" {
        extension_marker(tip.0, tip.1, dir.0, dir.1, color, bg)
    } else {
        marker(marker_type, tip.0, tip.1, dir.0, dir.1, color, stroke)
    }
}

fn hollow_on(marks: &str, fill_shape: &str, theme: &SvgTheme) -> String {
    if let Some(color) = extract_css_prop(fill_shape, "fill").map(str::trim)
        && !color.is_empty()
    {
        let needle = format!(r#" fill="{}""#, theme.bg());
        return marks.replace(&needle, &format!(r#" fill="{color}""#));
    }
    marks.to_string()
}

fn figure(view: &View, theme: &SvgTheme, icons: Option<&IconResolver<'_>>) -> String {
    let node = &view.node;
    let shape = &view.style.shape;
    let shape_attrs = theme.shape_attrs();
    let line = format!(r#" fill="none" stroke="{}"{}"#, theme.border(), view.style.line);
    let mut head = -21.0f64;
    let mut radius = 9.0f64;
    let mut out = match node.actor_type.unwrap_or(ActorType::Normal) {
        ActorType::Hollow => {
            radius = 8.0;
            format!(
                r#"<circle cy="-21" r="8" fill="{}" stroke="{}"{shape}/><path d="M-20,-9H20V0H5.5L20,15.5L12,25.5L0,12L-12,25.5L-20,15.5L-5.5,0H-20Z" fill="{}" stroke="{}" stroke-linejoin="round"{shape}/>"#,
                theme.bg(),
                theme.border(),
                theme.bg(),
                theme.border(),
            )
        }
        ActorType::Awesome => format!(
            r#"<path d="M0,-30A11,11 0 1 1 0,-8A11,11 0 1 1 0,-30ZM-20,25C-20,9 -12,-3 0,-3C12,-3 20,9 20,25C20,28 18,30 15,30H-15C-18,30 -20,28 -20,25Z" fill="{}"{shape}/>"#,
            theme.border(),
        ),
        ActorType::Icon => {
            head = -14.0;
            radius = 12.0;
            let icon_name = node.icon.as_deref().unwrap_or("");
            let inner = icons.and_then(|f| f(icon_name)).unwrap_or_default();
            format!(
                r#"<rect x="-22" y="-26" width="44" height="44"{}/><svg class="pele-icon" data-icon="{}" x="-14" y="-18" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{inner}</svg>"#,
                theme.rounded(&format!("{shape_attrs}{shape}")),
                esc_text(icon_name),
            )
        }
        ActorType::Normal => format!(r#"<circle cy="-21" r="9"{shape_attrs}{shape}/><path d="M0,-12V10M-14,-3H14M0,10L-12,30M0,10L12,30"{line}/>"#),
    };
    if node.business {
        out.push_str(&format!(
            r#"<path class="pele-business" d="M{},{}L{},{}"{line}/>"#,
            num(0.12 * radius),
            num(head + 0.99 * radius),
            num(0.92 * radius),
            num(head - 0.39 * radius),
        ));
    }
    out
}

fn title_x(c: &CNode, width: f64, crossings: &Crossings) -> f64 {
    let Some(xs) = crossings.get(&((c.y - c.h / 2.0).round() as i64)) else {
        return c.x;
    };
    if width == 0.0 {
        return c.x;
    }
    let left = c.x - c.w / 2.0 + 6.0;
    let right = c.x + c.w / 2.0 - 6.0;
    let mut cuts: Vec<f64> = xs.iter().copied().filter(|&x| x > left && x < right).collect();
    cuts.sort_by(f64::total_cmp);
    cuts.push(right);
    let need = width / 2.0 + 6.0;
    let mut best = c.x;
    let mut best_off = f64::INFINITY;
    let mut widest = 0.0f64;
    let mut from = left;
    for cut in cuts {
        if cut - from >= 2.0 * need {
            let x = c.x.max(from + need).min(cut - need);
            if (x - c.x).abs() < best_off {
                best_off = (x - c.x).abs();
                best = x;
            }
        } else if best_off == f64::INFINITY && cut - from > widest {
            widest = cut - from;
            best = (from + cut) / 2.0;
        }
        from = cut;
    }
    best
}

fn left_label(label: &Label, x: f64, cy: f64, attrs: &str, theme: &SvgTheme, icons: Option<&IconResolver<'_>>) -> String {
    if label.lines.len() < 2 {
        return label_svg(label, x + label.width / 2.0, cy, attrs, theme, icons);
    }
    let mut out = String::new();
    for i in 0..label.lines.len() {
        out.push_str(&label_svg(
            &label.single_line(i),
            x + label.widths[i] / 2.0,
            cy - label.height / 2.0 + label.line_middle(i),
            attrs,
            theme,
            icons,
        ));
    }
    out
}

pub fn render_usecase(model: &UsecaseModel, ctx: &RenderContext<'_>) -> Rendered {
    if !runs_across(Some(model.direction.as_str())) {
        return draw(model, ctx, false);
    }
    turn_to_fit(ctx.options, |down| draw(model, ctx, down))
}

fn draw(model: &UsecaseModel, ctx: &RenderContext<'_>, turned: bool) -> Rendered {
    let graph = build_usecase_graph(model);
    let size = ctx.options.font_size.unwrap_or(16.0);
    let small = (size * 0.875).round();
    let tiny = (size * 0.8125).round();
    let pad = ctx.options.padding.unwrap_or(8.0);
    let root_dir = if turned { Dir::TB } else { direction(Some(model.direction.as_str())) };
    let sideways = root_dir == Dir::LR || root_dir == Dir::RL;
    let shape_attrs = ctx.theme.shape_attrs();

    let mut index: HashMap<String, usize> = HashMap::with_capacity(graph.nodes.len());
    for (i, node) in graph.nodes.iter().enumerate() {
        index.insert(node.id.clone(), i);
    }

    let mut views: Vec<View> = Vec::with_capacity(graph.nodes.len());
    let mut cnodes: Vec<CNode> = Vec::with_capacity(graph.nodes.len());

    for node in graph.nodes {
        let style = if node.css_styles.is_empty() {
            resolve_style(&node.css_compiled_styles)
        } else {
            let mut combined = node.css_compiled_styles.clone();
            combined.extend(node.css_styles.iter().cloned());
            resolve_style(&combined)
        };
        let mut base = TextStyle::NONE;
        if style.bold {
            base |= TextStyle::BOLD;
        }
        if style.italic {
            base |= TextStyle::ITALIC;
        }
        let font_size = style.font_size.unwrap_or(size);
        let markdown = node.label_type == LabelType::Markdown;
        let stereo_text = node.stereotype.as_deref().map(|s| format!("«{s}»"));
        let stereotype = text_label(stereo_text.as_deref(), false, ctx, tiny, 200.0, base);

        let mut kind = ViewKind::Box;
        let label;
        let mut w = 0.0;
        let mut h = 0.0;
        let mut rows: Vec<(Label, Label)> = Vec::new();
        let mut key_w = 0.0f64;
        let mut head_h = 0.0f64;
        let mut c;

        if node.is_group {
            kind = ViewKind::Boundary;
            label = text_label(Some(node.label.as_str()), markdown, ctx, font_size, 4000.0, base);
            let title_h = label.height;
            c = cnode(0.0, 0.0, -1);
            c.is_group = true;
            c.pad_x = GROUP_PAD;
            c.pad_bottom = GROUP_PAD;
            c.pad_top = if node.boundary_type == Some(BoundaryType::Package) {
                title_h + 2.0 * TAB_PAD + 16.0
            } else if title_h > 0.0 {
                title_h + 16.0
            } else {
                GROUP_PAD
            };
            c.min_w = label.width + 2.0 * GROUP_PAD;
        } else {
            if let Some(ref json_rows) = node.json_rows {
                kind = ViewKind::Json;
                label = text_label(Some(node.label.as_str()), false, ctx, font_size, 4000.0, base | TextStyle::BOLD);
                let mut value_w = 0.0f64;
                for row in json_rows {
                    let key_lbl = text_label(Some(row.key.as_str()), false, ctx, small, 4000.0, base);
                    let val_lbl = text_label(Some(row.value.as_str()), false, ctx, small, 260.0, base);
                    key_w = key_w.max(key_lbl.width);
                    value_w = value_w.max(val_lbl.width);
                    h += key_lbl.height.max(val_lbl.height).max((small * 1.5).round()) + ROW_PAD;
                    rows.push((key_lbl, val_lbl));
                }
                if key_w > 0.0 {
                    key_w += 2.0 * CELL_PAD;
                }
                head_h = label.height.max((font_size * 1.5).round()) + ROW_PAD;
                w = (label.width + 2.0 * CELL_PAD)
                    .max(if !rows.is_empty() { key_w + value_w + 2.0 * CELL_PAD } else { 0.0 })
                    .max(72.0);
                h += head_h;
            } else if node.actor_type.is_some() {
                kind = ViewKind::Actor;
                label = text_label(Some(node.label.as_str()), markdown, ctx, font_size, 140.0, base);
                w = FIGURE_W.max(label.width).max(stereotype.width);
                h = FIGURE_H + FIGURE_GAP + stereotype.height + label.height;
            } else {
                let lbl_size = if node.shape == UsecaseNodeShape::Note { small } else { font_size };
                label = text_label(Some(node.label.as_str()), markdown, ctx, lbl_size, 180.0, base);
                let tw = label.width.max(stereotype.width);
                let th = label.height + stereotype.height;
                match node.shape {
                    UsecaseNodeShape::UsecaseEllipse | UsecaseNodeShape::UsecaseBusiness => {
                        kind = ViewKind::Ellipse;
                        w = (tw + 2.0 * node.padding + if node.business { 16.0 } else { 4.0 }).max(88.0);
                        h = (th + 28.0).max(48.0);
                    }
                    UsecaseNodeShape::Note => {
                        w = tw + 2.0 * node.padding + 6.0;
                        h = th + 18.0;
                    }
                    UsecaseNodeShape::Rect
                    | UsecaseNodeShape::UsecaseActor
                    | UsecaseNodeShape::UsecaseActorHollow
                    | UsecaseNodeShape::UsecaseActorAwesome
                    | UsecaseNodeShape::UsecaseActorIcon
                    | UsecaseNodeShape::UsecaseJsonTable
                    | UsecaseNodeShape::UsecaseSystemBoundary => {
                        w = (tw + 2.0 * node.padding + 12.0).max(80.0);
                        h = (th + 24.0).max(44.0);
                    }
                }
            }
            c = cnode(w, h, -1);
        }
        c.seq = views.len();
        views.push(View {
            node,
            kind,
            style,
            label,
            stereotype,
            w,
            h,
            rows,
            key_w,
            head_h,
        });
        cnodes.push(c);
    }

    for (i, view) in views.iter().enumerate() {
        cnodes[i].parent = view
            .node
            .parent_id
            .as_deref()
            .and_then(|pid| index.get(pid).copied())
            .map_or(-1, |idx| idx as i32);
    }

    let mut cedges: Vec<CEdge> = Vec::new();
    let mut edge_labels: Vec<Label> = Vec::new();
    let mut drawn: Vec<UsecaseGraphEdge> = Vec::new();
    for edge in graph.edges {
        let (Some(&src), Some(&dst)) = (index.get(&edge.start), index.get(&edge.end)) else {
            continue;
        };
        let semantic = matches!(edge.relationship_type, UsecaseEdgeKind::Include | UsecaseEdgeKind::Extend);
        let owned_label;
        let lbl_str = if semantic {
            owned_label = format!("«{}»", edge.label.as_deref().unwrap_or(""));
            Some(owned_label.as_str())
        } else {
            edge.label.as_deref()
        };
        let label = text_label(lbl_str, edge.label_type == Some(LabelType::Markdown), ctx, small, 200.0, TextStyle::NONE);
        if src == dst {
            if sideways {
                cnodes[src].h += 2.0 * (LOOP + if label.height > 0.0 { label.height + 8.0 } else { 0.0 });
            } else {
                cnodes[src].w += 2.0 * (LOOP + if label.width > 0.0 { label.width + 12.0 } else { 0.0 });
            }
        }
        let lw = if label.width > 0.0 { label.width + 12.0 } else { 0.0 };
        let lh = if label.height > 0.0 { label.height + 4.0 } else { 0.0 };
        let minlen = edge.minlen;
        drawn.push(edge);
        edge_labels.push(label);
        cedges.push(cedge(src, dst, minlen, lw, lh));
    }

    let layout = compound_layout(
        &mut cnodes,
        &mut cedges,
        root_dir,
        &LayeredOptions {
            node_sep: number_option(ctx, "nodeSpacing", NODE_SEP),
            edge_sep: EDGE_SEP,
            rank_sep: number_option(ctx, "rankSpacing", RANK_SEP),
            port_sep: 20.0,
            tracks: false,
            straight: false,
            apart: false,
            head_room: 0.0,
            groups: None,
            order_only: false,
        },
    );

    let title = title_label(model.title.as_deref(), ctx.measurer, size, 4000.0);
    let title_height = if title.height > 0.0 { title.height + 12.0 } else { 0.0 };
    let inner = layout.width.max(title.width);
    let ox = pad + (inner - layout.width) / 2.0;
    let oy = pad + title_height;
    shift_layout(&mut cnodes, &mut cedges, ox, oy);
    let width = (inner + 2.0 * pad).ceil();
    let height = (layout.height + title_height + 2.0 * pad).ceil();

    let mut crossings: Crossings = HashMap::new();
    for e in &cedges {
        mark_crossings(&mut crossings, &e.route);
    }
    attach_ends(&mut cedges, &cnodes, &views);

    let mut clusters = String::new();
    let mut fills: Vec<Fill> = Vec::new();
    let mut nodes_out = String::new();

    for (i, view) in views.iter().enumerate() {
        let c = &cnodes[i];
        let node = &view.node;
        let trimmed_cls = node
            .css_classes
            .strip_prefix("default ")
            .or_else(|| node.css_classes.strip_prefix("default"))
            .unwrap_or(&node.css_classes);
        let classes = class_names(trimmed_cls);
        let id = esc_text(&node.id);
        let text_attrs = &view.style.text;
        let shape = &view.style.shape;
        let color = ink_fill(shape, text_attrs, ctx.theme, None);
        let muted = if color.is_empty() {
            format!(r#" fill="{}""#, ctx.theme.muted())
        } else {
            color.clone()
        };
        let w = view.w;
        let h = view.h;

        if view.kind == ViewKind::Boundary {
            let x = c.x - c.w / 2.0;
            let y = c.y - c.h / 2.0;
            if paints(shape) {
                fills.push(Fill {
                    bounds: [x, y, x + c.w, y + c.h],
                    shape: shape.clone(),
                });
            }
            let fill_op = if sets_fill(shape) { "" } else { r#" fill-opacity="0.5""# };
            let box_attrs = format!(r#" fill="{}"{fill_op} stroke="{}"{shape}"#, ctx.theme.surface_alt(), ctx.theme.border());
            let title_attrs = format!(r#" class="pele-cluster-label"{muted}{text_attrs}"#);
            let body = if node.boundary_type == Some(BoundaryType::Package) {
                let tab_w = (view.label.width + 2.0 * TAB_PAD + 8.0).min(c.w);
                let tab_h = view.label.height + 2.0 * TAB_PAD;
                format!(
                    r#"<rect class="pele-boundary-tab" x="{}" y="{}" width="{}" height="{}"{box_attrs}/><rect x="{}" y="{}" width="{}" height="{}"{box_attrs}/>{}"#,
                    num(x),
                    num(y),
                    num(tab_w),
                    num(tab_h),
                    num(x),
                    num(y + tab_h),
                    num(c.w),
                    num(c.h - tab_h),
                    label_svg(&view.label, x + tab_w / 2.0, y + tab_h / 2.0, &title_attrs, ctx.theme, ctx.icons),
                )
            } else {
                format!(
                    r#"<rect x="{}" y="{}" width="{}" height="{}"{}/>{}"#,
                    num(x),
                    num(y),
                    num(c.w),
                    num(c.h),
                    ctx.theme.rounded(&box_attrs),
                    label_svg(
                        &view.label,
                        title_x(c, view.label.width, &crossings),
                        y + 8.0 + view.label.height / 2.0,
                        &title_attrs,
                        ctx.theme,
                        ctx.icons,
                    ),
                )
            };
            clusters.push_str(&format!(r#"<g class="pele-cluster pele-boundary{classes}" data-id="{id}">{body}</g>"#));
            continue;
        }

        let (kind_cls, body) = match view.kind {
            ViewKind::Actor => {
                let top = -h / 2.0;
                let stereotype_y = top + FIGURE_H + FIGURE_GAP + view.stereotype.height / 2.0;
                let body = format!(
                    r#"<g class="pele-actor-figure" transform="translate(0,{})">{}</g>{}{}"#,
                    num(top + FIGURE_H / 2.0),
                    figure(view, ctx.theme, ctx.icons),
                    label_svg(
                        &view.stereotype,
                        0.0,
                        stereotype_y,
                        &format!(r#" class="pele-stereotype" font-size="{}" fill="{}""#, num(tiny), ctx.theme.muted()),
                        ctx.theme,
                        ctx.icons,
                    ),
                    label_svg(
                        &view.label,
                        0.0,
                        h / 2.0 - view.label.height / 2.0,
                        &format!(r#" class="pele-label"{text_attrs}"#),
                        ctx.theme,
                        ctx.icons,
                    ),
                );
                ("pele-actor", body)
            }
            ViewKind::Json => {
                let x0 = -w / 2.0;
                let mut y = -h / 2.0 + view.head_h;
                let mut cells = String::new();
                let mut lines = format!("M{},{}H{}", num(x0), num(y), num(x0 + w));
                if view.key_w > 0.0 {
                    lines.push_str(&format!("M{},{}V{}", num(x0 + view.key_w), num(y), num(h / 2.0)));
                }
                for (key_lbl, val_lbl) in &view.rows {
                    let row_h = key_lbl.height.max(val_lbl.height).max((small * 1.5).round()) + ROW_PAD;
                    cells.push_str(&label_svg(
                        key_lbl,
                        x0 + CELL_PAD + key_lbl.width / 2.0,
                        y + row_h / 2.0,
                        &format!(r#" class="pele-json-key"{muted}"#),
                        ctx.theme,
                        ctx.icons,
                    ));
                    cells.push_str(&left_label(
                        val_lbl,
                        x0 + view.key_w + CELL_PAD,
                        y + row_h / 2.0,
                        &format!(r#" class="pele-json-value"{color}{text_attrs}"#),
                        ctx.theme,
                        ctx.icons,
                    ));
                    y += row_h;
                }
                let body = format!(
                    r#"<rect x="{}" y="{}" width="{}" height="{}"{}/><path class="pele-json-lines" d="{lines}" fill="none" stroke="{}"{}/>{}<g font-size="{}">{cells}</g>"#,
                    num(x0),
                    num(-h / 2.0),
                    num(w),
                    num(h),
                    ctx.theme.rounded(&format!("{shape_attrs}{shape}")),
                    ctx.theme.border(),
                    view.style.line,
                    label_svg(
                        &view.label,
                        0.0,
                        -h / 2.0 + view.head_h / 2.0,
                        &format!(r#" class="pele-label" font-weight="{}"{color}{text_attrs}"#, ctx.theme.heading_weight()),
                        ctx.theme,
                        ctx.icons,
                    ),
                    num(small),
                );
                ("pele-json", body)
            }
            ViewKind::Ellipse | ViewKind::Box => {
                let label_y = view.stereotype.height / 2.0;
                let (k_cls, outline) = if view.kind == ViewKind::Ellipse {
                    let mut out = format!(r#"<ellipse rx="{}" ry="{}"{shape_attrs}{shape}/>"#, num(w / 2.0), num(h / 2.0));
                    if node.business {
                        let from = w / 2.0 - 15.0;
                        let to = w / 2.0 - 5.0;
                        let arc = |at: f64| -> f64 { (h / 2.0) * (1.0 - (at / (w / 2.0)).powi(2)).max(0.0).sqrt() };
                        out.push_str(&format!(
                            r#"<path class="pele-business" d="M{},{}L{},{}" fill="none" stroke="{}"{}/>"#,
                            num(from),
                            num(arc(from)),
                            num(to),
                            num(-arc(to)),
                            ctx.theme.border(),
                            view.style.line,
                        ));
                    }
                    ("pele-usecase", out)
                } else if node.shape == UsecaseNodeShape::Note {
                    let r = w / 2.0;
                    let b = h / 2.0;
                    let out = format!(
                        r#"<path d="M{},{}H{}L{},{}V{}H{}Z" fill="{}" stroke="{}" stroke-linejoin="round"{shape}/><path d="M{},{}V{}H{}" fill="none" stroke="{}" stroke-linejoin="round"{}/>"#,
                        num(-r),
                        num(-b),
                        num(r - FOLD),
                        num(r),
                        num(FOLD - b),
                        num(b),
                        num(-r),
                        ctx.theme.surface_alt(),
                        ctx.theme.border(),
                        num(r - FOLD),
                        num(-b),
                        num(FOLD - b),
                        num(r),
                        ctx.theme.border(),
                        view.style.line,
                    );
                    ("pele-note", out)
                } else {
                    let out = format!(
                        r#"<rect x="{}" y="{}" width="{}" height="{}"{}/>"#,
                        num(-w / 2.0),
                        num(-h / 2.0),
                        num(w),
                        num(h),
                        ctx.theme.rounded(&format!("{shape_attrs}{shape}")),
                    );
                    ("pele-usecase", out)
                };
                let note_size_attr = if node.shape == UsecaseNodeShape::Note {
                    format!(r#" font-size="{}""#, num(small))
                } else {
                    String::new()
                };
                let body = format!(
                    "{outline}{}{}",
                    label_svg(
                        &view.stereotype,
                        0.0,
                        -view.label.height / 2.0,
                        &format!(r#" class="pele-stereotype" font-size="{}"{muted}"#, num(tiny)),
                        ctx.theme,
                        ctx.icons,
                    ),
                    label_svg(
                        &view.label,
                        0.0,
                        label_y,
                        &format!(r#" class="pele-label"{note_size_attr}{color}{text_attrs}"#),
                        ctx.theme,
                        ctx.icons,
                    ),
                );
                (k_cls, body)
            }
            ViewKind::Boundary => unreachable!(),
        };

        nodes_out.push_str(&format!(
            r#"<g class="pele-node {kind_cls}{classes}" data-id="{id}" transform="translate({},{})">{body}</g>"#,
            num(c.x),
            num(c.y),
        ));
    }

    let mut casings = String::new();
    let mut edges_out = String::new();
    let mut labels_out = String::new();
    let mut loop_seen: HashMap<usize, usize> = HashMap::new();
    let bg = ctx.theme.bg();

    for (i, ce) in cedges.iter_mut().enumerate() {
        let edge = &drawn[i];
        let label = &edge_labels[i];
        let style = if !edge.style.is_empty() || !edge.css_compiled_styles.is_empty() {
            let mut combined = edge.css_compiled_styles.clone();
            combined.extend(edge.style.iter().cloned());
            Some(resolve_style(&combined))
        } else {
            None
        };
        let line_style = style.as_ref().map_or("", |s| s.line.as_str());
        let start_type = edge.arrow_type_start;
        let end_type = edge.arrow_type_end;

        let path = if ce.src == ce.dst {
            let c = &cnodes[ce.src];
            let view = &views[ce.src];
            let k = *loop_seen.get(&ce.src).unwrap_or(&0);
            loop_seen.insert(ce.src, k + 1);
            let side = if sideways { 2usize } else { 1usize };
            let spread = (side_length(view, side) / 2.0).min(8.0 + (k as f64) * 6.0);
            let reach = LOOP + (k as f64) * 8.0;
            let (ax, ay) = anchor(view, c, side, -spread);
            let (bx, by) = anchor(view, c, side, spread);
            let len = reach.hypot(spread);
            let len = if len > 0.0 { len } else { 1.0 };
            let ux = if sideways { spread / len } else { reach / len };
            let uy = if sideways { reach / len } else { spread / len };
            let st = trim(start_type);
            let et = trim(end_type);
            let out_pt = |x: f64, y: f64, sign: f64, far: f64| -> String {
                let s_off = if far != 0.0 { sign * spread } else { 0.0 };
                if sideways {
                    format!("{},{}", num(x + s_off), num(y + far))
                } else {
                    format!("{},{}", num(x + far), num(y + s_off))
                }
            };
            let sx = if sideways { ax - ux * st } else { ax + ux * st };
            let sy = if sideways { ay + uy * st } else { ay - uy * st };
            let ex = bx + ux * et;
            let ey = by + uy * et;
            if sideways {
                ce.label_x = c.x;
                ce.label_y = ay.max(by) + reach * 0.75 + 6.0 + label.height / 2.0;
            } else {
                ce.label_x = ax.max(bx) + reach * 0.75 + 8.0 + label.width / 2.0;
                ce.label_y = c.y;
            }
            EdgePath {
                d: format!(
                    "M{},{}C{} {} {},{}",
                    num(sx),
                    num(sy),
                    out_pt(ax, ay, -1.0, reach),
                    out_pt(bx, by, 1.0, reach),
                    num(ex),
                    num(ey)
                ),
                tokens: None,
                sx: ax,
                sy: ay,
                sdx: if sideways { ux } else { -ux },
                sdy: if sideways { -uy } else { uy },
                ex: bx,
                ey: by,
                edx: -ux,
                edy: -uy,
            }
        } else {
            if ce.route.len() < 6 {
                continue;
            }
            route_path(&ce.route, None, trim(start_type), trim(end_type), None, None)
        };

        let under = fill_under(&path.d, &[path.sx, path.sy, path.ex, path.ey], &fills, path.tokens.as_deref());
        let (over_ink, inside_fill, needs_casing) = match under {
            FillRelation::Outside => (None, None, false),
            FillRelation::CrossesBorder => (None, None, true),
            FillRelation::Inside(fill) => {
                if extract_css_prop(line_style, "stroke").is_some() {
                    (None, Some(fill), true)
                } else if let Some(c) = ink(&fill.shape, "", ctx.theme) {
                    (Some(c.to_string()), Some(fill), false)
                } else {
                    (None, Some(fill), true)
                }
            }
        };

        let default_stroke = style
            .as_ref()
            .and_then(|s| s.stroke.as_deref())
            .map(esc)
            .unwrap_or_else(|| ctx.theme.line().to_string());
        let color = over_ink.clone().unwrap_or(default_stroke);
        if needs_casing {
            let casing_marks = format!(
                "{}{}",
                mark(start_type, (path.sx, path.sy), (path.sdx, path.sdy), bg, bg, bg),
                mark(end_type, (path.ex, path.ey), (path.edx, path.edy), bg, bg, bg),
            );
            casings.push_str(&casing(&path.d, &casing_marks, line_style, false));
        }

        let dashes = if edge.internal {
            "2 3"
        } else if edge.pattern == EdgePattern::Dotted {
            "5 4"
        } else if edge.animate {
            "9 5"
        } else {
            ""
        };
        let dash_attr = if dashes.is_empty() {
            String::new()
        } else {
            format!(r#" stroke-dasharray="{dashes}""#)
        };
        let marks = format!(
            "{}{}",
            mark(start_type, (path.sx, path.sy), (path.sdx, path.sdy), &color, "none", bg),
            mark(end_type, (path.ex, path.ey), (path.edx, path.edy), &color, "none", bg),
        );
        let marks_final = match (inside_fill, &over_ink) {
            (Some(fill), Some(_)) => hollow_on(&marks, &fill.shape, ctx.theme),
            _ => marks,
        };
        let stroke_override = over_ink.as_deref().map_or_else(String::new, |c| format!(r#" stroke="{c}""#));
        let extra_classes = strip_edge_prefix(&edge.classes);
        edges_out.push_str(&format!(
            r#"<g class="pele-edge pele-{}{}" data-id="{}"{stroke_override}{line_style}><path d="{}"{dash_attr}/>{marks_final}</g>"#,
            edge.relationship_type.as_str(),
            class_names(extra_classes),
            esc_text(&edge.id),
            path.d,
        ));

        if label.width > 0.0 {
            let semantic = matches!(edge.relationship_type, UsecaseEdgeKind::Include | UsecaseEdgeKind::Extend);
            let lbl_fill = if semantic {
                format!(r#" fill="{}""#, ctx.theme.muted())
            } else {
                String::new()
            };
            let text_style = style.as_ref().map_or("", |s| s.text.as_str());
            labels_out.push_str(&edge_label_svg(
                &edge.id,
                label,
                ce.label_x,
                ce.label_y,
                &format!("{lbl_fill}{text_style}"),
                ctx.theme,
                ctx.icons,
            ));
        }
    }

    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let mut content = label_svg(&title, width / 2.0, pad + title.height / 2.0, &title_attrs, ctx.theme, None);
    if !clusters.is_empty() {
        content.push_str(&format!(r#"<g class="pele-clusters">{clusters}</g>"#));
    }
    content.push_str(&casings_svg(&casings, ctx.theme));
    if !edges_out.is_empty() {
        content.push_str(&format!(
            r#"<g class="pele-edges" fill="none" stroke="{}" stroke-linecap="round">{edges_out}</g>"#,
            ctx.theme.line(),
        ));
    }
    if !labels_out.is_empty() {
        content.push_str(&format!(r#"<g class="pele-edge-labels" font-size="{}">{labels_out}</g>"#, num(small)));
    }
    content.push_str(&format!(r#"<g class="pele-nodes">{nodes_out}</g>"#));

    let svg = svg_document(
        "usecase",
        width,
        height,
        size,
        ctx.options,
        ctx.responsive,
        ctx.theme,
        ctx.palette,
        Accessible {
            acc_title: (!model.acc_title.is_empty()).then_some(model.acc_title.as_str()),
            acc_descr: (!model.acc_descr.is_empty()).then_some(model.acc_descr.as_str()),
        },
        &content,
    );

    Rendered {
        svg,
        width,
        height,
        links: Vec::new(),
    }
}

fn strip_edge_prefix(classes: &str) -> &str {
    let Some(rest) = classes.strip_prefix("default relationship relationship-") else {
        return classes;
    };
    let end = rest.find(|c: char| c.is_whitespace()).unwrap_or(rest.len());
    let after = &rest[end..];
    after.strip_prefix(' ').unwrap_or(after)
}
