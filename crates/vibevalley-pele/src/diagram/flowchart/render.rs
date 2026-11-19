use std::collections::HashMap;

use crate::diagram::RenderContext;
use crate::diagram::common::{runs_across, tighten, title_room, turn_to_fit};
use crate::layout::compound::{CEdge, CNode, CompoundResult, Dir, cedge, cnode, compound_layout, direction, inherit_crossed_directions, shift_layout};
use crate::layout::layered::LayeredOptions;
use crate::measure::TextStyle;
use crate::svg::builder::{esc, esc_text, label_svg, num};
use crate::svg::cluster::{Crossings, cluster_title_x, mark_crossings, struck_title, title_crossed};
use crate::svg::edges::{
    EdgePath, Fill, OverFill, SideReach, casings_svg, edge_casing, edge_label_svg, loop_path, marker, marker_trim, over_fills, route_path,
};
use crate::svg::ink::{ink_fill, paints};
use crate::svg::root::{Accessible, svg_document};
use crate::svg::shapes::{ShapeKind, draw_shape, end_side, inset_route, shape_filled, shape_has_label, shape_size, shape_span};
use crate::svg::theme::{ResolvedStyle, SvgTheme, class_names, resolve_style, sets_fill};
use crate::svg::title::title_label;
use crate::text::entities::decode_entities;
use crate::text::label::{Label, layout_label};
use crate::util::url::{image_url, internal_link, linked, rel_attr, safe_url};
use crate::util::yaml::YamlValue;
use crate::{IconResolver, LinkInfo, Rendered};

use super::db::FlowDb;
use super::graph::{FlowGraph, GraphEdge, GraphNode, build_flow_graph};
use super::shapes::canonical_shape;
use super::types::LabelType;

const NODE_SEP: f64 = 40.0;
const EDGE_SEP: f64 = 16.0;
const RANK_SEP: f64 = 48.0;
const GROUP_PAD: f64 = 20.0;
const LOOP: f64 = 26.0;

/// Extension hook allowing diagram types like `swimlane` to reuse flowchart parsing and rendering
/// with a custom layout and optional top-level group renderer.
pub trait FlowVariant {
    fn diagram_type(&self) -> &'static str;
    fn prepare(&self, graph: &mut FlowGraph);
    fn layout(&self, nodes: &mut [CNode], edges: &mut [CEdge], dir: Dir, opt: &LayeredOptions, tight: bool) -> CompoundResult;
    #[allow(clippy::too_many_arguments)]
    fn draw_group(
        &self,
        _c: &CNode,
        _label: &Label,
        _style: &ResolvedStyle,
        _classes: &str,
        _id: &str,
        _dir: Dir,
        _theme: &SvgTheme,
        _icons: Option<&IconResolver<'_>>,
    ) -> Option<String> {
        None
    }
    fn filled_box(&self, _c: &CNode, _dir: Dir) -> Option<[f64; 4]> {
        None
    }
}

fn clamp_number_opt(value: Option<f64>, fallback: f64) -> f64 {
    match value {
        Some(v) if v > 0.0 => v.min(2000.0),
        _ => fallback,
    }
}

fn asset_size(value: Option<f64>, fallback: f64) -> f64 {
    match value {
        Some(v) if v > 0.0 && v <= 4000.0 => v,
        _ => fallback,
    }
}

struct NodeView {
    node: GraphNode,
    style: ResolvedStyle,
    label: Label,
    shape: ShapeKind,
    shape_name: &'static str,
    w: f64,
    h: f64,
    dy: f64,
}

pub fn render_flowchart(db: &FlowDb, ctx: &RenderContext<'_>, variant: Option<&dyn FlowVariant>) -> Rendered {
    let fitted = |down: bool| -> Rendered { tighten(ctx.options, |tight| draw(db, ctx, variant, down, tight)) };
    if runs_across(db.direction.as_deref()) {
        turn_to_fit(ctx.options, fitted)
    } else {
        fitted(false)
    }
}

fn draw(db: &FlowDb, ctx: &RenderContext<'_>, variant: Option<&dyn FlowVariant>, turned: bool, tight: bool) -> Rendered {
    let group_pad = if tight { 12.0 } else { GROUP_PAD };
    let own_sec = variant.and_then(|v| ctx.config.section(v.diagram_type()));
    let curve_opt: Option<&str> = match own_sec {
        Some(sec) => sec.get("curve").and_then(YamlValue::as_str),
        None => ctx.config.flowchart.curve.as_deref(),
    };
    let wrapping_opt = match own_sec {
        Some(sec) => sec.get("wrappingWidth").and_then(YamlValue::as_f64),
        None => ctx.config.flowchart.wrapping_width,
    };
    let node_spacing_opt = match own_sec {
        Some(sec) => sec.get("nodeSpacing").and_then(YamlValue::as_f64),
        None => ctx.config.flowchart.node_spacing,
    };
    let rank_spacing_opt = match own_sec {
        Some(sec) => sec.get("rankSpacing").and_then(YamlValue::as_f64),
        None => ctx.config.flowchart.rank_spacing,
    };

    let mut graph = build_flow_graph(db, curve_opt);
    if let Some(v) = variant {
        v.prepare(&mut graph);
    }

    let size = ctx.options.font_size.unwrap_or(16.0);
    let edge_size = (size * 0.875).round();
    let wrap_width = clamp_number_opt(wrapping_opt, 200.0).min(if variant.is_some() && tight { 100.0 } else { f64::INFINITY });
    let pad = ctx.options.padding.unwrap_or(8.0);
    let shape_attrs = ctx.theme.shape_attrs();
    let line_attrs = ctx.theme.line_attrs();

    let mut index: HashMap<String, usize> = HashMap::with_capacity(graph.nodes.len());
    for (i, node) in graph.nodes.iter().enumerate() {
        index.insert(node.id.clone(), i);
    }

    let mut views: Vec<NodeView> = Vec::with_capacity(graph.nodes.len());
    let mut cnodes: Vec<CNode> = Vec::with_capacity(graph.nodes.len());

    for node in graph.nodes {
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
            let max_w = if variant.is_some() && tight {
                80.0f64.max(title_room(ctx.options) / 2.0)
            } else {
                4000.0
            };
            let label = layout_label(node.label.as_deref(), markdown, ctx.measurer, font_size, max_w, text_style, ctx.icons, ctx.math);
            let mut c = cnode(0.0, 0.0, -1);
            c.is_group = true;
            c.dir = node.dir.as_deref().map(|d| direction(Some(d)));
            c.pad_x = group_pad;
            c.pad_top = if label.height > 0.0 { label.height + 16.0 } else { GROUP_PAD };
            c.pad_bottom = group_pad;
            c.min_w = label.width + 2.0 * group_pad - 12.0;
            let view = NodeView {
                node,
                style,
                label,
                shape: ShapeKind::Rect,
                shape_name: "group",
                w: 0.0,
                h: 0.0,
                dy: 0.0,
            };
            (view, c)
        } else {
            let shape_name = canonical_shape(Some(node.shape.as_str()));
            let shape = ShapeKind::from_canonical(shape_name);
            let has_text = node.img.is_some() || node.icon.is_some() || shape_has_label(shape);
            let text = if has_text { node.label.as_deref() } else { None };
            let label = layout_label(text, markdown, ctx.measurer, font_size, wrap_width, text_style, ctx.icons, ctx.math);
            let (w, h, dy) = if node.img.is_some() || node.icon.is_some() {
                let box_sz = if node.img.is_some() { 80.0 } else { 48.0 };
                let aw = asset_size(node.asset_width, box_sz);
                let ah = asset_size(node.asset_height, box_sz);
                let w = aw.max(label.width + 8.0);
                let h = ah + if label.height > 0.0 { label.height + 6.0 } else { 0.0 };
                let dy = if label.height == 0.0 {
                    0.0
                } else if node.pos.as_deref() == Some("t") {
                    -ah / 2.0
                } else {
                    ah / 2.0
                };
                (w, h, dy)
            } else {
                let s = shape_size(shape, label.width, label.height);
                (s.w, s.h, s.dy)
            };
            let c = cnode(w, h, -1);
            let view = NodeView {
                node,
                style,
                label,
                shape,
                shape_name,
                w,
                h,
                dy,
            };
            (view, c)
        };
        c.seq = views.len();
        views.push(view);
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
    let edge_ends: Vec<(usize, usize)> = graph.edges.iter().filter_map(|e| Some((*index.get(&e.start)?, *index.get(&e.end)?))).collect();
    inherit_crossed_directions(&mut cnodes, edge_ends);

    let root_dir = if turned { Dir::TB } else { direction(db.direction.as_deref()) };
    let flows_sideways = |cnodes: &[CNode], i: usize| -> bool {
        let mut dir: Option<Dir> = None;
        let mut p = cnodes[i].parent;
        let mut hops = 0;
        while p >= 0 && dir.is_none() && hops < 10_000 {
            dir = cnodes[p as usize].dir;
            p = cnodes[p as usize].parent;
            hops += 1;
        }
        !dir.unwrap_or(root_dir).is_vertical()
    };

    for (i, view) in views.iter().enumerate() {
        if view.node.is_group {
            cnodes[i].span = f64::INFINITY;
        } else if view.node.img.is_none() && view.node.icon.is_none() {
            cnodes[i].span = shape_span(view.shape, view.w, view.h, flows_sideways(&cnodes, i));
        }
    }

    let mut cedges: Vec<CEdge> = Vec::with_capacity(graph.edges.len());
    let mut edge_labels: Vec<Label> = Vec::with_capacity(graph.edges.len());
    let mut drawn: Vec<GraphEdge> = Vec::with_capacity(graph.edges.len());

    for edge in graph.edges {
        let (Some(&src), Some(&dst)) = (index.get(&edge.start), index.get(&edge.end)) else {
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
        if src == dst {
            if flows_sideways(&cnodes, src) {
                cnodes[src].h += 2.0 * (LOOP + if label.height > 0.0 { label.height + 8.0 } else { 0.0 });
            } else {
                cnodes[src].w += 2.0 * (LOOP + if label.width > 0.0 { label.width + 12.0 } else { 0.0 });
            }
        }
        let lw = if label.width > 0.0 { label.width + 12.0 } else { 0.0 };
        let lh = if label.height > 0.0 { label.height + 4.0 } else { 0.0 };
        let minlen = edge.minlen.unwrap_or(1);
        drawn.push(edge);
        edge_labels.push(label);
        cedges.push(cedge(src, dst, minlen, lw, lh));
    }

    let layout_options = LayeredOptions {
        node_sep: clamp_number_opt(node_spacing_opt, NODE_SEP) * if tight { 0.5 } else { 1.0 },
        edge_sep: EDGE_SEP,
        rank_sep: clamp_number_opt(rank_spacing_opt, RANK_SEP) * if tight { 0.75 } else { 1.0 },
        port_sep: 20.0,
        tracks: curve_opt.is_some_and(|c| c.starts_with("step")),
        straight: curve_opt == Some("linear"),
        apart: false,
        head_room: marker_trim("arrow_point"),
        groups: None,
        order_only: false,
    };

    let layout = match variant {
        Some(v) => v.layout(&mut cnodes, &mut cedges, root_dir, &layout_options, tight),
        None => compound_layout(&mut cnodes, &mut cedges, root_dir, &layout_options),
    };

    let title = title_label(db.title.as_deref(), ctx.measurer, size, if tight { title_room(ctx.options) } else { 4000.0 });
    let title_height = if title.height > 0.0 { title.height + 12.0 } else { 0.0 };
    let inner = layout.width.max(title.width);
    let ox = pad + (inner - layout.width) / 2.0;
    let oy = pad + title_height;
    shift_layout(&mut cnodes, &mut cedges, ox, oy);
    let width = (inner + 2.0 * pad).ceil();
    let height = (layout.height + title_height + 2.0 * pad).ceil();
    let mut links: Vec<LinkInfo> = Vec::new();

    let mut crossings: Crossings = HashMap::new();
    if cnodes.iter().any(|c| c.is_group) {
        for e in &cedges {
            mark_crossings(&mut crossings, &e.route);
        }
    }

    let mut clusters = String::new();
    let mut struck_titles = String::new();
    let mut nodes_out = String::new();
    let mut fills: Vec<Fill> = Vec::new();

    for (i, view) in views.iter().enumerate() {
        let c = &cnodes[i];
        let node = &view.node;
        let x = c.x;
        let y = c.y;
        let trimmed_classes = node
            .css_classes
            .strip_prefix("default ")
            .or_else(|| node.css_classes.strip_prefix("default"))
            .unwrap_or(&node.css_classes);
        let classes = class_names(trimmed_classes);
        let id = esc_text(&node.id);

        if c.is_group
            && c.parent < 0
            && let Some(v) = variant
            && let Some(custom_group) = v.draw_group(c, &view.label, &view.style, &classes, &id, root_dir, ctx.theme, ctx.icons)
        {
            if paints(&view.style.shape)
                && let Some(bounds) = v.filled_box(c, root_dir)
            {
                fills.push(Fill {
                    bounds,
                    shape: view.style.shape.clone(),
                });
            }
            clusters.push_str(&custom_group);
            continue;
        }

        if c.is_group {
            if paints(&view.style.shape) {
                fills.push(Fill {
                    bounds: [x - c.w / 2.0, y - c.h / 2.0, x + c.w / 2.0, y + c.h / 2.0],
                    shape: view.style.shape.clone(),
                });
            }
            let title_x = cluster_title_x(c, view.label.width, &crossings, group_pad);
            let title_y = y - c.h / 2.0 + 8.0 + view.label.height / 2.0;
            let struck = title_crossed(c, view.label.width, title_x, &crossings);
            let title_fill = if struck {
                format!(r#" fill="{}""#, ctx.theme.muted())
            } else {
                ink_fill(&view.style.shape, &view.style.text, ctx.theme, Some(ctx.theme.muted()))
            };
            let title_attrs = format!(r#" class="pele-cluster-label"{title_fill}{}"#, view.style.text);
            if struck {
                struck_titles.push_str(&struck_title(
                    &view.label,
                    title_x,
                    title_y,
                    &title_attrs,
                    &id,
                    &cnodes,
                    i,
                    ctx.theme,
                    ctx.icons,
                ));
            }
            let fill_opacity = if sets_fill(&view.style.shape) { "" } else { r#" fill-opacity="0.5""# };
            let label_part = if struck {
                String::new()
            } else {
                label_svg(&view.label, title_x, title_y, &title_attrs, ctx.theme, ctx.icons)
            };
            clusters.push_str(&format!(
                r#"<g class="pele-cluster{classes}" data-id="{id}"><rect x="{}" y="{}" width="{}" height="{}" fill="{}"{fill_opacity} stroke="{}"{}/>{label_part}</g>"#,
                num(x - c.w / 2.0),
                num(y - c.h / 2.0),
                num(c.w),
                num(c.h),
                ctx.theme.surface_alt(),
                ctx.theme.border(),
                ctx.theme.rounded(&view.style.shape),
            ));
            continue;
        }

        let w = view.w;
        let h = view.h;
        let mut ink = String::new();
        let inner = if let Some(ref img) = node.img {
            let aw = asset_size(node.asset_width, 80.0);
            let ah = asset_size(node.asset_height, 80.0);
            let top = if view.label.height > 0.0 {
                if node.pos.as_deref() == Some("t") { h / 2.0 - ah } else { -h / 2.0 }
            } else {
                -ah / 2.0
            };
            let safe = safe_url(img);
            match image_url(&safe, ctx.options) {
                None => String::new(),
                Some(src) => format!(
                    r#"<image href="{}" x="{}" y="{}" width="{}" height="{}" preserveAspectRatio="{}"/>"#,
                    esc(src),
                    num(-aw / 2.0),
                    num(top),
                    num(aw),
                    num(ah),
                    if node.constraint.as_deref() == Some("on") { "xMidYMid meet" } else { "none" },
                ),
            }
        } else if let Some(ref icon) = node.icon {
            let box_sz = asset_size(node.asset_height, 48.0);
            let top = if view.label.height > 0.0 {
                if node.pos.as_deref() == Some("t") { h / 2.0 - box_sz } else { -h / 2.0 }
            } else {
                -box_sz / 2.0
            };
            let frame = match node.shape.as_str() {
                "icon" => String::new(),
                "iconCircle" => format!(
                    r#"<circle cy="{}" r="{}"{shape_attrs}{}/>"#,
                    num(top + box_sz / 2.0),
                    num(box_sz / 2.0),
                    view.style.shape,
                ),
                other => format!(
                    r#"<rect x="{}" y="{}" width="{}" height="{}" rx="{}"{shape_attrs}{}/>"#,
                    num(-box_sz / 2.0),
                    num(top),
                    num(box_sz),
                    num(box_sz),
                    if other == "iconRounded" { "8" } else { "0" },
                    view.style.shape,
                ),
            };
            let glyph = box_sz * 0.6;
            let icon_inner = ctx.icons.and_then(|f| f(icon)).unwrap_or_default();
            format!(
                r#"{frame}<svg class="pele-icon" data-icon="{}" x="{}" y="{}" width="{}" height="{}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{icon_inner}</svg>"#,
                esc_text(icon),
                num(-glyph / 2.0),
                num(top + (box_sz - glyph) / 2.0),
                num(glyph),
                num(glyph),
            )
        } else {
            let shape_full = format!("{shape_attrs}{}", view.style.shape);
            let line_full = format!("{line_attrs}{}", view.style.line);
            if shape_filled(view.shape) {
                ink = ink_fill(&view.style.shape, &view.style.text, ctx.theme, None);
            }
            draw_shape(view.shape, w, h, &shape_full, &line_full, ctx.theme)
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
        let mut body = format!("{inner}{text}");
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
            r#"<g class="pele-node pele-shape-{}{classes}" data-id="{id}" transform="translate({},{})">{body}</g>"#,
            view.shape_name,
            num(x),
            num(y),
        ));
    }

    let mut reach = SideReach::default();
    for (i, ce) in cedges.iter().enumerate() {
        if ce.src == ce.dst || drawn[i].thickness.as_deref() == Some("invisible") || ce.route.len() < 6 {
            continue;
        }
        reach.add(ce.src, end_side(&ce.route, 0, &cnodes[ce.src]), &drawn[i].arrow_type_start);
        reach.add(ce.dst, end_side(&ce.route, ce.route.len() - 3, &cnodes[ce.dst]), &drawn[i].arrow_type_end);
    }

    let mut casings = String::new();
    let mut edges_out = String::new();
    let mut labels_out = String::new();
    let mut loop_seen: HashMap<usize, usize> = HashMap::new();

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
        if edge.thickness.as_deref() != Some("invisible") {
            let start_type = edge.arrow_type_start.as_str();
            let end_type = edge.arrow_type_end.as_str();
            let path: EdgePath = if ce.src == ce.dst {
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
                let leaves = reach.of(ce.src, end_side(&route, 0, &cnodes[ce.src]));
                let arrives = reach.of(ce.dst, end_side(&route, route.len() - 3, &cnodes[ce.dst]));
                inset_route(&mut route, 0, views[ce.src].shape, views[ce.src].w, views[ce.src].h, &cnodes[ce.src]);
                let last_idx = route.len() - 3;
                inset_route(&mut route, last_idx, views[ce.dst].shape, views[ce.dst].w, views[ce.dst].h, &cnodes[ce.dst]);
                route_path(
                    &route,
                    edge.curve.as_deref(),
                    marker_trim(start_type),
                    marker_trim(end_type),
                    Some(leaves),
                    Some(arrives),
                )
            };
            let over = over_fills(
                &path.d,
                &[path.sx, path.sy, path.ex, path.ey],
                &fills,
                line_style,
                path.tokens.as_deref(),
                ctx.theme,
            );
            let default_stroke = style
                .as_ref()
                .and_then(|s| s.stroke.as_deref())
                .map(esc)
                .unwrap_or_else(|| ctx.theme.line().to_string());
            let (color, stroke_override) = match &over {
                OverFill::Ink(c) => (c.clone(), format!(r#" stroke="{c}""#)),
                OverFill::Casing => {
                    casings.push_str(&edge_casing(
                        &path,
                        start_type,
                        end_type,
                        line_style,
                        edge.thickness.as_deref() == Some("thick"),
                        ctx.theme,
                    ));
                    (default_stroke, String::new())
                }
                OverFill::None => (default_stroke, String::new()),
            };
            let path_attrs = match edge.thickness.as_deref() {
                Some("thick") => r#" stroke-width="2.5""#,
                Some("dotted") => r#" stroke-dasharray="3 4""#,
                _ => "",
            };
            let filtered_cls: String = edge
                .classes
                .split_ascii_whitespace()
                .filter(|c| !matches!(*c, "edge-thickness-normal" | "edge-pattern-solid" | "flowchart-link"))
                .collect::<Vec<_>>()
                .join(" ");
            let classes = class_names(&filtered_cls);
            let bg = ctx.theme.bg();
            edges_out.push_str(&format!(
                r#"<g class="pele-edge{classes}" data-id="{}"{stroke_override}{line_style}><path d="{}"{path_attrs}/>{}{}</g>"#,
                esc_text(&edge.id),
                path.d,
                marker(start_type, path.sx, path.sy, path.sdx, path.sdy, &color, bg),
                marker(end_type, path.ex, path.ey, path.edx, path.edy, &color, bg),
            ));
        }
        if label.width > 0.0 {
            let text_style = style.as_ref().map_or("", |s| s.text.as_str());
            labels_out.push_str(&edge_label_svg(&edge.id, label, ce.label_x, ce.label_y, text_style, ctx.theme, ctx.icons));
        }
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
    if !struck_titles.is_empty() {
        content.push_str(&format!(r#"<g class="pele-cluster-titles">{struck_titles}</g>"#));
    }
    if !labels_out.is_empty() {
        content.push_str(&format!(r#"<g class="pele-edge-labels" font-size="{}">{labels_out}</g>"#, num(edge_size),));
    }
    content.push_str(&format!(r#"<g class="pele-nodes">{nodes_out}</g>"#));

    let svg = svg_document(
        variant.map_or("flowchart", FlowVariant::diagram_type),
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
