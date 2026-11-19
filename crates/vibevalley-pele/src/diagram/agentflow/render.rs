use std::collections::HashMap;

use crate::config::DiagramConfig;
use crate::diagram::RenderContext;
use crate::diagram::common::{runs_across, turn_to_fit};
use crate::diagram::flowchart::canonical_shape;
use crate::layout::compound::{CEdge, CNode, Dir, cedge, cnode, compound_layout, direction, inherit_crossed_directions, shift_layout};
use crate::layout::layered::LayeredOptions;
use crate::measure::TextStyle;
use crate::svg::builder::{esc, esc_text, label_svg, num};
use crate::svg::cluster::{Crossings, cluster_title_x, mark_crossings};
use crate::svg::edges::{EdgePath, Fill, OverFill, casings_svg, edge_casing, edge_label_svg, loop_path, marker, marker_trim, over_fills, route_path};
use crate::svg::ink::{ink_fill, paints};
use crate::svg::palette::PaletteOverrides;
use crate::svg::root::{Accessible, svg_document};
use crate::svg::shapes::{PAD_X, PAD_Y, ShapeKind, draw_shape, inset_route, shape_filled, shape_size};
use crate::svg::theme::{ResolvedStyle, SvgTheme, class_names, resolve_style, sets_fill};
use crate::svg::title::title_label;
use crate::text::entities::decode_entities;
use crate::text::label::{Label, layout_label};
use crate::util::url::{internal_link, linked, rel_attr};
use crate::util::yaml::YamlValue;
use crate::{LinkInfo, Rendered};

use super::color_slots::{KIND_COUNT, kind_slot};
use super::db::AgentflowDb;
use super::graph::{AgentGraph, GraphEdge, GraphNode, build_agent_graph};
use super::types::{LabelType, VertexKind};

/// Number of series tokens used for Mermaid's agentflow color slot rules.
pub const PALETTE: usize = 8;

const NODE_SEP: f64 = 40.0;
const EDGE_SEP: f64 = 16.0;
const RANK_SEP: f64 = 48.0;
const GROUP_PAD: f64 = 20.0;
const LOOP: f64 = 26.0;
const DOTS: f64 = 14.0;

fn flow_end(dir: Dir) -> i32 {
    match dir {
        Dir::TB => 2,
        Dir::RL => 3,
        Dir::BT => 0,
        Dir::LR => 1,
    }
}

fn number_option(config: &DiagramConfig, key: &str, fallback: f64) -> f64 {
    match config.section("agentflow").and_then(|s| s.get(key)).and_then(YamlValue::as_f64) {
        Some(v) if v > 0.0 => v.min(2000.0),
        _ => fallback,
    }
}

fn tint(slot: usize, wash: &str, style: &ResolvedStyle, theme: &SvgTheme, palette: &PaletteOverrides) -> String {
    let color = theme.series_color(slot, palette);
    if sets_fill(&style.shape) {
        format!(r#" fill="{color}" stroke="{color}""#)
    } else {
        format!(r#" fill="{color}" fill-opacity="{wash}" stroke="{color}""#)
    }
}

struct NodeView<'a> {
    node: &'a GraphNode,
    style: ResolvedStyle,
    label: Label,
    shape: ShapeKind,
    shape_name: &'static str,
    is_collapsed: bool,
    w: f64,
    h: f64,
    dy: f64,
}

struct HeldEdge<'a> {
    edge: &'a GraphEdge,
    label: Label,
    src: usize,
    dst: usize,
}

pub fn render_agentflow(db: &AgentflowDb, ctx: &RenderContext<'_>) -> Rendered {
    let fallback_graph: Option<AgentGraph> = if db.cached_graph.is_none() {
        let mut cloned = db.clone();
        Some(build_agent_graph(&mut cloned, PALETTE, ctx.config.flowchart.curve.as_deref()))
    } else {
        None
    };
    let graph = db.cached_graph.as_ref().or(fallback_graph.as_ref()).unwrap();
    if !runs_across(db.direction.as_deref()) {
        return draw(db, graph, ctx, false);
    }
    turn_to_fit(ctx.options, |down| draw(db, graph, ctx, down))
}

fn draw(db: &AgentflowDb, graph: &AgentGraph, ctx: &RenderContext<'_>, turned: bool) -> Rendered {
    let size = ctx.options.font_size.unwrap_or(16.0);
    let edge_size = (size * 0.875).round();
    let wrap_width = number_option(ctx.config, "wrappingWidth", 120.0);
    let min_width = number_option(ctx.config, "minNodeWidth", 120.0);
    let pad = ctx.options.padding.unwrap_or(8.0);

    let mut index: HashMap<&str, usize> = HashMap::with_capacity(graph.nodes.len());
    for (i, node) in graph.nodes.iter().enumerate() {
        index.insert(node.id.as_str(), i);
    }

    let mut views: Vec<NodeView<'_>> = Vec::with_capacity(graph.nodes.len());
    let mut cnodes: Vec<CNode> = Vec::with_capacity(graph.nodes.len());

    for node in &graph.nodes {
        let style = if node.css_styles.is_empty() {
            resolve_style(&node.css_compiled_styles)
        } else {
            let mut combined = node.css_compiled_styles.clone();
            combined.extend(node.css_styles.iter().cloned());
            resolve_style(&combined)
        };
        let mut text_style = TextStyle::NONE;
        if style.bold {
            text_style |= TextStyle::BOLD;
        }
        if style.italic {
            text_style |= TextStyle::ITALIC;
        }
        let markdown = node.label_type == LabelType::Markdown;
        let font_size = style.font_size.unwrap_or(size);

        let (view, mut c) = if node.is_group {
            let label = layout_label(
                node.label.as_deref(),
                markdown,
                ctx.measurer,
                font_size,
                4000.0,
                text_style,
                ctx.icons,
                ctx.math,
            );
            let mut c = cnode(0.0, 0.0, -1);
            c.is_group = true;
            c.dir = node.dir.as_deref().map(|d| direction(Some(d)));
            c.pad_x = GROUP_PAD;
            c.pad_top = if label.height > 0.0 { label.height + 16.0 } else { GROUP_PAD };
            c.pad_bottom = GROUP_PAD;
            c.min_w = label.width + 2.0 * GROUP_PAD - 12.0;
            let view = NodeView {
                node,
                style,
                label,
                shape: ShapeKind::Rect,
                shape_name: "group",
                is_collapsed: false,
                w: 0.0,
                h: 0.0,
                dy: 0.0,
            };
            (view, c)
        } else if node.shape == "collapsedGroup" {
            let label = layout_label(
                node.label.as_deref(),
                markdown,
                ctx.measurer,
                font_size,
                wrap_width,
                text_style,
                ctx.icons,
                ctx.math,
            );
            let w = label.width.max(min_width) + 2.0 * PAD_X;
            let h = label.height + 2.0 * PAD_Y + DOTS;
            let c = cnode(w, h, -1);
            let view = NodeView {
                node,
                style,
                label,
                shape: ShapeKind::CollapsedGroup,
                shape_name: "collapsed",
                is_collapsed: true,
                w,
                h,
                dy: -DOTS / 2.0,
            };
            (view, c)
        } else {
            let shape_name = canonical_shape(Some(node.shape.as_str()));
            let shape = ShapeKind::from_canonical(shape_name);
            let label = layout_label(
                node.label.as_deref(),
                markdown,
                ctx.measurer,
                font_size,
                wrap_width,
                text_style,
                ctx.icons,
                ctx.math,
            );
            let inner_w = if shape == ShapeKind::Diam { label.width } else { label.width.max(min_width) };
            let s = shape_size(shape, inner_w, label.height);
            let c = cnode(s.w, s.h, -1);
            let view = NodeView {
                node,
                style,
                label,
                shape,
                shape_name,
                is_collapsed: false,
                w: s.w,
                h: s.h,
                dy: s.dy,
            };
            (view, c)
        };
        c.seq = views.len();
        views.push(view);
        cnodes.push(c);
    }

    for (i, node) in graph.nodes.iter().enumerate() {
        cnodes[i].parent = node.parent_id.as_deref().and_then(|pid| index.get(pid).copied()).map_or(-1, |idx| idx as i32);
    }
    let edge_ends: Vec<(usize, usize)> = graph
        .edges
        .iter()
        .filter_map(|e| Some((*index.get(e.start.as_str())?, *index.get(e.end.as_str())?)))
        .collect();
    inherit_crossed_directions(&mut cnodes, edge_ends);

    let root_dir = if turned { Dir::TB } else { direction(db.direction.as_deref()) };
    let flow_of = |cnodes: &[CNode], i: usize| -> Dir {
        let mut dir: Option<Dir> = None;
        let mut p = cnodes[i].parent;
        let mut hops = 0;
        while p >= 0 && dir.is_none() && hops < 10_000 {
            dir = cnodes[p as usize].dir;
            p = cnodes[p as usize].parent;
            hops += 1;
        }
        dir.unwrap_or(root_dir)
    };
    let flows_sideways = |cnodes: &[CNode], i: usize| -> bool { !flow_of(cnodes, i).is_vertical() };

    let mut depth = vec![-1i32; cnodes.len()];
    for i in 0..cnodes.len() {
        let mut chain: Vec<usize> = Vec::new();
        let mut j = i as i32;
        while j >= 0 && depth[j as usize] < 0 && chain.len() <= cnodes.len() {
            chain.push(j as usize);
            j = cnodes[j as usize].parent;
        }
        let base = if j >= 0 { depth[j as usize] + 1 } else { 0 };
        for (offset, &node_idx) in chain.iter().rev().enumerate() {
            depth[node_idx] = base + offset as i32;
        }
    }
    let contains = |cnodes: &[CNode], group: usize, i: usize| -> bool {
        if i == group || depth[i] <= depth[group] {
            return false;
        }
        let mut j = i as i32;
        let mut d = depth[i];
        while d > depth[group] && j >= 0 {
            j = cnodes[j as usize].parent;
            d -= 1;
        }
        j == group as i32
    };

    let mut cedges: Vec<CEdge> = Vec::with_capacity(graph.edges.len());
    let mut edge_labels: Vec<Label> = Vec::with_capacity(graph.edges.len());
    let mut drawn: Vec<&GraphEdge> = Vec::with_capacity(graph.edges.len());
    let mut held: Vec<HeldEdge<'_>> = Vec::new();

    for edge in &graph.edges {
        let (Some(&src), Some(&dst)) = (index.get(edge.start.as_str()), index.get(edge.end.as_str())) else {
            continue;
        };
        let label = layout_label(
            Some(edge.label.as_str()),
            edge.label_type == LabelType::Markdown,
            ctx.measurer,
            edge_size,
            wrap_width,
            TextStyle::NONE,
            ctx.icons,
            ctx.math,
        );
        if contains(&cnodes, src, dst) || contains(&cnodes, dst, src) {
            held.push(HeldEdge { edge, label, src, dst });
            continue;
        }
        if src == dst {
            if flows_sideways(&cnodes, src) {
                cnodes[src].h += 2.0 * (LOOP + if label.height > 0.0 { label.height + 8.0 } else { 0.0 });
            } else {
                cnodes[src].w += 2.0 * (LOOP + if label.width > 0.0 { label.width + 12.0 } else { 0.0 });
            }
        }
        let lw = if label.width > 0.0 { label.width + 12.0 } else { 0.0 };
        let lh = if label.height > 0.0 { label.height + 4.0 } else { 0.0 };
        drawn.push(edge);
        edge_labels.push(label);
        cedges.push(cedge(src, dst, edge.minlen.unwrap_or(1) as i32, lw, lh));
    }

    let layout_options = LayeredOptions {
        node_sep: number_option(ctx.config, "nodeSpacing", NODE_SEP),
        edge_sep: EDGE_SEP,
        rank_sep: number_option(ctx.config, "rankSpacing", RANK_SEP),
        port_sep: 20.0,
        tracks: false,
        straight: false,
        apart: false,
        head_room: 0.0,
        groups: None,
        order_only: false,
    };

    let layout = compound_layout(&mut cnodes, &mut cedges, root_dir, &layout_options);

    let title = title_label(db.title.as_deref(), ctx.measurer, size, 4000.0);
    let title_height = if title.height > 0.0 { title.height + 12.0 } else { 0.0 };
    let inner = layout.width.max(title.width);
    let ox = pad + (inner - layout.width) / 2.0;
    let oy = pad + title_height;
    shift_layout(&mut cnodes, &mut cedges, ox, oy);
    let width = (inner + 2.0 * pad).ceil();
    let height = (layout.height + title_height + 2.0 * pad).ceil();
    let mut links: Vec<LinkInfo> = Vec::new();

    let mut held_paths: Vec<EdgePath> = Vec::with_capacity(held.len());
    let mut held_labels: Vec<(f64, f64)> = Vec::with_capacity(held.len());
    let mut held_routes: Vec<[f64; 6]> = Vec::with_capacity(held.len());
    let careful = held.len().saturating_mul(cnodes.len()) < 2_000_000;

    for h in &held {
        let out = contains(&cnodes, h.dst, h.src);
        let outer = if out { h.dst } else { h.src };
        let i = if out { h.src } else { h.dst };
        let g = &cnodes[outer];
        let n = &cnodes[i];
        let end = flow_end(g.dir.unwrap_or_else(|| flow_of(&cnodes, outer)));
        let first = if out { end } else { (end + 2) & 3 };
        let toward = |side: i32| -> [f64; 6] {
            let upright = (side & 1) == 0;
            let sign = if side == 0 || side == 3 { -1.0 } else { 1.0 };
            let nx = if upright { n.x } else { n.x + (sign * n.w) / 2.0 };
            let ny = if upright { n.y + (sign * n.h) / 2.0 } else { n.y };
            let bx = if upright { n.x } else { g.x + (sign * g.w) / 2.0 };
            let by = if upright { g.y + (sign * g.h) / 2.0 } else { n.y };
            let axis = if upright { 0.0 } else { 1.0 };
            if out { [nx, ny, axis, bx, by, axis] } else { [bx, by, axis, nx, ny, axis] }
        };
        let blocked = |r: &[f64; 6]| -> bool {
            let min_x = r[0].min(r[3]) - 1.0;
            let max_x = r[0].max(r[3]) + 1.0;
            let min_y = r[1].min(r[4]) - 1.0;
            let max_y = r[1].max(r[4]) + 1.0;
            for (k, c) in cnodes.iter().enumerate() {
                if k != i && !c.is_group && c.x + c.w / 2.0 > min_x && c.x - c.w / 2.0 < max_x && c.y + c.h / 2.0 > min_y && c.y - c.h / 2.0 < max_y {
                    return true;
                }
            }
            false
        };
        let mut route = toward(first);
        if careful && blocked(&route) {
            for side in [(first + 1) & 3, (first + 3) & 3, (first + 2) & 3] {
                let other = toward(side);
                if !blocked(&other) {
                    route = other;
                    break;
                }
            }
        }
        held_routes.push(route);
        held_labels.push(((route[0] + route[3]) / 2.0, (route[1] + route[4]) / 2.0));
        let mut drawn_route = route;
        inset_route(&mut drawn_route, if out { 0 } else { 3 }, views[i].shape, views[i].w, views[i].h, n);
        held_paths.push(route_path(&drawn_route, Some("linear"), 0.0, marker_trim(&h.edge.arrow_type_end), None, None));
    }

    let mut crossings: Crossings = HashMap::new();
    if cnodes.iter().any(|c| c.is_group) {
        for e in &cedges {
            mark_crossings(&mut crossings, &e.route);
        }
        for route in &held_routes {
            mark_crossings(&mut crossings, route);
        }
    }

    let mut clusters = String::new();
    let mut nodes_out = String::new();
    let mut fills: Vec<Fill> = Vec::new();

    for (i, view) in views.iter().enumerate() {
        let c = &cnodes[i];
        let node = view.node;
        let x = c.x;
        let y = c.y;
        let trimmed_classes = node
            .css_classes
            .strip_prefix("default ")
            .or_else(|| node.css_classes.strip_prefix("default"))
            .unwrap_or(&node.css_classes);
        let classes = class_names(trimmed_classes);
        let id = esc_text(&node.id);

        if c.is_group {
            if paints(&view.style.shape) {
                fills.push(Fill {
                    bounds: [x - c.w / 2.0, y - c.h / 2.0, x + c.w / 2.0, y + c.h / 2.0],
                    shape: view.style.shape.clone(),
                });
            }
            let title_x = cluster_title_x(c, view.label.width, &crossings, GROUP_PAD);
            let slot = node.color_index.unwrap_or(KIND_COUNT);
            let rect_attrs = format!("{}{}", tint(slot, "0.06", &view.style, ctx.theme, ctx.palette), view.style.shape);
            let title_fill = ink_fill(&view.style.shape, &view.style.text, ctx.theme, Some(ctx.theme.muted()));
            clusters.push_str(&format!(
                r#"<g class="pele-cluster pele-flow{classes}" data-id="{id}"><rect x="{}" y="{}" width="{}" height="{}"{}/>{}</g>"#,
                num(x - c.w / 2.0),
                num(y - c.h / 2.0),
                num(c.w),
                num(c.h),
                ctx.theme.rounded(&rect_attrs),
                label_svg(
                    &view.label,
                    title_x,
                    y - c.h / 2.0 + 8.0 + view.label.height / 2.0,
                    &format!(r#" class="pele-cluster-label"{title_fill}{}"#, view.style.text),
                    ctx.theme,
                    ctx.icons,
                ),
            ));
            continue;
        }

        let w = view.w;
        let h = view.h;
        let mut kind_cls = String::new();
        let shape_svg = if view.is_collapsed {
            let slot = node.color_index.unwrap_or(KIND_COUNT);
            let color = ctx.theme.series_color(slot, ctx.palette);
            let line_y = h / 2.0 - DOTS - 2.0;
            let dots_y = line_y + (DOTS + 2.0) / 2.0;
            let rect_attrs = format!("{}{}", tint(slot, "0.06", &view.style, ctx.theme, ctx.palette), view.style.shape);
            format!(
                r#"<rect x="{}" y="{}" width="{}" height="{}"{}/><path d="M{},{}H{}" fill="none" stroke="{color}" stroke-dasharray="3 3"{}/><path class="pele-collapsed-mark" d="{}{}{}" fill="{color}" stroke="none"/>"#,
                num(-w / 2.0),
                num(-h / 2.0),
                num(w),
                num(h),
                ctx.theme.rounded(&rect_attrs),
                num(-w / 2.0 + 10.0),
                num(line_y),
                num(w / 2.0 - 10.0),
                view.style.line,
                dot(-9.0, dots_y),
                dot(0.0, dots_y),
                dot(9.0, dots_y),
            )
        } else {
            let kind = node.kind.unwrap_or(VertexKind::Task);
            let slot = kind_slot(kind);
            kind_cls = format!(" pele-kind-{}", kind.as_str());
            let shape_full = format!("{}{}", tint(slot, "0.14", &view.style, ctx.theme, ctx.palette), view.style.shape);
            let line_full = format!(r#" stroke="{}"{}"#, ctx.theme.series_color(slot, ctx.palette), view.style.line);
            draw_shape(view.shape, w, h, &shape_full, &line_full, ctx.theme)
        };

        let ink = if view.is_collapsed || shape_filled(view.shape) {
            ink_fill(&view.style.shape, &view.style.text, ctx.theme, None)
        } else {
            String::new()
        };
        let mut text = label_svg(
            &view.label,
            0.0,
            view.dy,
            &format!(r#" class="pele-label"{ink}{}"#, view.style.text),
            ctx.theme,
            ctx.icons,
        );
        let is_internal = classes.split_ascii_whitespace().any(|c| c == "internal-link");
        if is_internal
            && let Some(ref lbl) = node.label
            && !lbl.is_empty()
            && ctx.options.links
        {
            let name = decode_entities(lbl);
            let safe = internal_link(&name, ctx.options);
            let target = esc(&name);
            let href_attr = if safe {
                format!(r#" href="{target}"{}"#, rel_attr(ctx.options))
            } else {
                String::new()
            };
            text = format!(r#"<a class="internal-link"{href_attr} data-href="{target}">{text}</a>"#);
            links.push(LinkInfo {
                id: node.id.clone(),
                href: name,
                internal: true,
            });
        }
        let mut body = format!("{shape_svg}{text}");
        if let Some(ref tip) = node.tooltip
            && !tip.is_empty()
        {
            body = format!("<title>{}</title>{body}", esc_text(tip));
        }
        if let Some(ref url) = node.link
            && !url.is_empty()
        {
            let target_attr = node.link_target.as_deref().map_or_else(String::new, |t| format!(r#" target="{}""#, esc(t)));
            body = linked(&body, url, &node.id, &mut links, ctx.options, &target_attr);
        }
        nodes_out.push_str(&format!(
            r#"<g class="pele-node pele-shape-{}{kind_cls}{classes}" data-id="{id}" transform="translate({},{})">{body}</g>"#,
            view.shape_name,
            num(x),
            num(y),
        ));
    }

    let mut casings = String::new();
    let mut edges_out = String::new();
    let mut labels_out = String::new();

    let mut put = |edge: &GraphEdge, label: &Label, path: &EdgePath, x: f64, y: f64| {
        let style = if !edge.style.is_empty() || !edge.css_compiled_styles.is_empty() {
            let mut combined = edge.css_compiled_styles.clone();
            combined.extend(edge.style.iter().cloned());
            Some(resolve_style(&combined))
        } else {
            None
        };
        let line_style = style.as_ref().map_or("", |s| s.line.as_str());
        let end_type = edge.arrow_type_end.as_str();
        let over = over_fills(&path.d, &[path.ex, path.ey], &fills, line_style, path.tokens.as_deref(), ctx.theme);
        let default_stroke = style
            .as_ref()
            .and_then(|s| s.stroke.as_deref())
            .map(esc)
            .unwrap_or_else(|| ctx.theme.line().to_string());
        let (color, stroke_override) = match &over {
            OverFill::Ink(c) => (c.clone(), format!(r#" stroke="{c}""#)),
            OverFill::Casing => {
                casings.push_str(&edge_casing(path, "none", end_type, line_style, false, ctx.theme));
                (default_stroke, String::new())
            }
            OverFill::None => (default_stroke, String::new()),
        };
        let kind = if edge.thickness.as_deref() == Some("dotted") {
            "reference"
        } else if end_type == "arrow_cross" {
            "failure"
        } else {
            "sequence"
        };
        let filtered_cls: String = edge
            .classes
            .split_ascii_whitespace()
            .filter(|c| !matches!(*c, "edge-thickness-normal" | "edge-pattern-solid" | "flowchart-link"))
            .collect::<Vec<_>>()
            .join(" ");
        let classes = class_names(&filtered_cls);
        let dash = if edge.thickness.as_deref() == Some("dotted") {
            r#" stroke-dasharray="3 4""#
        } else {
            ""
        };
        edges_out.push_str(&format!(
            r#"<g class="pele-edge pele-edge-{kind}{classes}" data-id="{}"{stroke_override}{line_style}><path d="{}"{dash}/>{}</g>"#,
            esc_text(&edge.id),
            path.d,
            marker(end_type, path.ex, path.ey, path.edx, path.edy, &color, ctx.theme.bg()),
        ));
        if label.width > 0.0 {
            let text_style = style.as_ref().map_or("", |s| s.text.as_str());
            labels_out.push_str(&edge_label_svg(&edge.id, label, x, y, text_style, ctx.theme, ctx.icons));
        }
    };

    let mut loop_seen: HashMap<usize, usize> = HashMap::new();
    for (i, ce) in cedges.iter_mut().enumerate() {
        let edge = drawn[i];
        let label = &edge_labels[i];
        let end_type = edge.arrow_type_end.as_str();
        let path = if ce.src == ce.dst {
            let view = &views[ce.src];
            let k = *loop_seen.get(&ce.src).unwrap_or(&0);
            loop_seen.insert(ce.src, k + 1);
            loop_path(
                cnodes[ce.src].x,
                cnodes[ce.src].y,
                view.w,
                view.h,
                k,
                flows_sideways(&cnodes, ce.src),
                LOOP,
                marker_trim(end_type),
                ce.label_w,
                ce.label_h,
                &mut ce.label_x,
                &mut ce.label_y,
            )
        } else {
            let mut route = ce.route.clone();
            inset_route(&mut route, 0, views[ce.src].shape, views[ce.src].w, views[ce.src].h, &cnodes[ce.src]);
            let last_idx = route.len() - 3;
            inset_route(&mut route, last_idx, views[ce.dst].shape, views[ce.dst].w, views[ce.dst].h, &cnodes[ce.dst]);
            route_path(&route, edge.curve.as_deref(), 0.0, marker_trim(end_type), None, None)
        };
        put(edge, label, &path, ce.label_x, ce.label_y);
    }
    for (i, h) in held.iter().enumerate() {
        let (lx, ly) = held_labels[i];
        put(h.edge, &h.label, &held_paths[i], lx, ly);
    }

    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let mut content = String::new();
    content.push_str(&label_svg(&title, width / 2.0, pad + title.height / 2.0, &title_attrs, ctx.theme, ctx.icons));
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
        content.push_str(&format!(r#"<g class="pele-edge-labels" font-size="{}">{labels_out}</g>"#, num(edge_size)));
    }
    content.push_str(&format!(r#"<g class="pele-nodes">{nodes_out}</g>"#));

    let svg = svg_document(
        "agentflow",
        width,
        height,
        size,
        ctx.options,
        ctx.responsive,
        ctx.theme,
        ctx.palette,
        Accessible {
            acc_title: db.acc_title.as_deref(),
            acc_descr: db.acc_descr.as_deref(),
        },
        &content,
    );

    Rendered { svg, width, height, links }
}

fn dot(x: f64, y: f64) -> String {
    format!("M{},{}a1.75,1.75 0 1 0 3.5,0a1.75,1.75 0 1 0 -3.5,0Z", num(x - 1.75), num(y))
}
