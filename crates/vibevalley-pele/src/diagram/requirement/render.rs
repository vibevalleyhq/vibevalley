use std::collections::HashMap;

use crate::Rendered;
use crate::diagram::RenderContext;
use crate::diagram::common::{runs_across, turn_to_fit};
use crate::layout::compound::{CEdge, CNode, Dir, cedge, cnode, compound_layout, direction};
use crate::layout::layered::LayeredOptions;
use crate::measure::{TextMeasurer, TextStyle};
use crate::svg::builder::{esc, esc_text, label_svg, num, shared_style, span_style, text_style};
use crate::svg::edges::{EdgePath, edge_label_svg, route_path};
use crate::svg::ink::ink_fill;
use crate::svg::root::{Accessible, svg_document};
use crate::svg::theme::{ResolvedStyle, SvgTheme, class_names, resolve_style};
use crate::svg::title::title_label;
use crate::text::label::{Label, Span, layout_label};

use super::db::RequirementDb;
use super::graph::{GraphEdge, GraphNode, ReqNodeKind, build_requirement_graph};

const NODE_SEP: f64 = 40.0;
const EDGE_SEP: f64 = 16.0;
const RANK_SEP: f64 = 56.0;
const PAD_X: f64 = 14.0;
const PAD_Y: f64 = 10.0;
const ROW_GAP: f64 = 2.0;
const COLUMN_GAP: f64 = 12.0;
const MIN_WIDTH: f64 = 120.0;
const NAME_WRAP: f64 = 280.0;
const VALUE_WRAP: f64 = 240.0;
const LOOP: f64 = 26.0;
const CONTAINS_RADIUS: f64 = 6.0;
const ARROW_LENGTH: f64 = 9.0;
const ARROW_HALF: f64 = 4.5;
const END_STEP: f64 = 28.0;
const END_MARGIN: f64 = 14.0;

struct Row {
    key: Label,
    value: Label,
    height: f64,
}

struct NodeView<'a> {
    node: GraphNode<'a>,
    style: ResolvedStyle,
    kind: Label,
    name: Label,
    rows: Vec<Row>,
    key_width: f64,
    head_height: f64,
    w: f64,
    h: f64,
}

// Adds bold or italic to a whole label after its markdown is read, since emphasis markers only
// toggle styles the label does not start with.
fn restyle(mut label: Label, bits: TextStyle, measurer: &dyn TextMeasurer) -> Label {
    if bits.is_empty() || label.lines.is_empty() {
        return label;
    }
    let mut width = 0.0f64;
    let mut widths = Vec::with_capacity(label.lines.len());
    for line in &mut label.lines {
        let mut total = 0.0;
        for span in line.iter_mut() {
            let style = span.style | bits;
            let w = if span.icon.is_some() || span.math.is_some() {
                span.width
            } else {
                measurer.width(&span.text, label.size, style)
            };
            span.style = style;
            span.width = w;
            total += w;
        }
        widths.push(total);
        if total > width {
            width = total;
        }
    }
    label.widths = widths;
    label.width = width;
    label
}

fn line_has_math(line: &[Span]) -> bool {
    line.iter().any(|s| s.math.is_some())
}

// Writes a measured label with its lines starting at x, the first line's box starting at top.
fn start_text(label: &Label, x: f64, top: f64, attrs: &str, theme: &SvgTheme) -> String {
    let shared = shared_style(label);
    let mut body = String::new();
    let mut math = String::new();
    for (i, line) in label.lines.iter().enumerate() {
        let middle = top + label.line_middle(i);
        if line_has_math(line) {
            math.push_str(&label_svg(&label.single_line(i), x + label.widths[i] / 2.0, middle, attrs, theme, None));
            continue;
        }
        let y = middle + label.size * 0.35;
        let mut first = true;
        for span in line {
            if span.icon.is_some() || span.text.is_empty() {
                continue;
            }
            let pos = if first { format!(r#" x="{}" y="{}""#, num(x), num(y)) } else { String::new() };
            body.push_str(&format!("<tspan{pos}{}>{}</tspan>", span_style(span.style & !shared, theme), esc(&span.text)));
            first = false;
        }
    }
    let mut out = if body.is_empty() {
        String::new()
    } else {
        format!(
            r#"<text{} text-anchor="start" xml:space="preserve">{body}</text>"#,
            text_style(attrs, shared, theme)
        )
    };
    out.push_str(&math);
    out
}

// The containment mark: a circled plus whose rim touches (x, y), where (dx, dy) points at the node.
fn contains_marker(x: f64, y: f64, dx: f64, dy: f64) -> String {
    let r = CONTAINS_RADIUS;
    let cx = x - dx * r;
    let cy = y - dy * r;
    format!(
        r#"<circle class="pele-marker" cx="{}" cy="{}" r="{}"/><path class="pele-marker" d="M{},{}L{},{}M{},{}L{},{}"/>"#,
        num(cx),
        num(cy),
        num(r),
        num(cx - dx * r),
        num(cy - dy * r),
        num(cx + dx * r),
        num(cy + dy * r),
        num(cx + dy * r),
        num(cy - dx * r),
        num(cx - dy * r),
        num(cy + dx * r),
    )
}

// An open arrowhead with its tip at (x, y), pointing along (dx, dy).
fn arrow_marker(x: f64, y: f64, dx: f64, dy: f64) -> String {
    let bx = x - dx * ARROW_LENGTH;
    let by = y - dy * ARROW_LENGTH;
    format!(
        r#"<path class="pele-marker" d="M{},{}L{},{}L{},{}" stroke-linejoin="round"/>"#,
        num(bx - dy * ARROW_HALF),
        num(by + dx * ARROW_HALF),
        num(x),
        num(y),
        num(bx + dy * ARROW_HALF),
        num(by - dx * ARROW_HALF),
    )
}

// The layout attaches every edge to the middle of a node's side. Ends that share a side are
// spread along it, in the order of where they head, so their markers do not sit on each other.
fn spread_ends(cnodes: &[CNode], cedges: &mut [CEdge], views: &[NodeView<'_>]) {
    let mut sides: HashMap<usize, Vec<(usize, usize, f64)>> = HashMap::new();
    for (ei, edge) in cedges.iter().enumerate() {
        let route = &edge.route;
        if edge.src == edge.dst || route.len() < 6 {
            continue;
        }
        for at in [0usize, route.len() - 3] {
            let node = if at == 0 { edge.src } else { edge.dst };
            let c = &cnodes[node];
            let dx = route[at] - c.x;
            let dy = route[at + 1] - c.y;
            let next = if at == 0 { 3 } else { at - 3 };
            let side = if (dy.abs() - c.h / 2.0).abs() < 0.5 {
                if dy < 0.0 { 0usize } else { 2usize }
            } else if (dx.abs() - c.w / 2.0).abs() < 0.5 {
                if dx < 0.0 { 3usize } else { 1usize }
            } else {
                continue;
            };
            let key = node * 4 + side;
            let toward = route[if side.is_multiple_of(2) { next } else { next + 1 }];
            sides.entry(key).or_default().push((ei, at, toward));
        }
    }
    for (key, mut list) in sides {
        if list.len() < 2 {
            continue;
        }
        let node = key >> 2;
        let vertical = key % 2 == 1;
        let span = (if vertical { views[node].h } else { views[node].w }) - 2.0 * END_MARGIN;
        let step = 0.0f64.max(END_STEP.min(span / (list.len() - 1) as f64));
        list.sort_by(|a, b| a.2.total_cmp(&b.2));
        for (j, &(ei, at, _)) in list.iter().enumerate() {
            let offset = (j as f64 - (list.len() - 1) as f64 / 2.0) * step;
            if vertical {
                cedges[ei].route[at + 1] = cnodes[node].y + offset;
            } else {
                cedges[ei].route[at] = cnodes[node].x + offset;
            }
        }
    }
}

pub fn render_requirement(model: &RequirementDb, ctx: &RenderContext<'_>) -> Rendered {
    if !runs_across(Some(model.direction.as_str())) {
        return draw(model, ctx, false);
    }
    turn_to_fit(ctx.options, |down| draw(model, ctx, down))
}

fn draw(model: &RequirementDb, ctx: &RenderContext<'_>, turned: bool) -> Rendered {
    let graph = build_requirement_graph(model);
    let size = ctx.options.font_size.unwrap_or(16.0);
    let small = (size * 0.875).round();
    let pad = ctx.options.padding.unwrap_or(8.0);

    let mut index: HashMap<&str, usize> = HashMap::new();
    let mut views: Vec<NodeView<'_>> = Vec::with_capacity(graph.nodes.len());
    let mut cnodes: Vec<CNode> = Vec::with_capacity(graph.nodes.len());

    for node in graph.nodes {
        let style = resolve_style(node.css_styles);
        let mut base = TextStyle::NONE;
        if style.bold {
            base |= TextStyle::BOLD;
        }
        if style.italic {
            base |= TextStyle::ITALIC;
        }
        let name_size = style.font_size.unwrap_or(size);
        let body_size = style.font_size.unwrap_or(small);
        let kind_str = match &node.kind {
            ReqNodeKind::Requirement(r) => format!("«{}»", r.req_type),
            ReqNodeKind::Element(_) => "«Element»".to_string(),
        };
        let kind = restyle(
            layout_label(Some(&kind_str), false, ctx.measurer, body_size, 4000.0, TextStyle::NONE, None, ctx.math),
            base,
            ctx.measurer,
        );
        let name = restyle(
            layout_label(Some(node.id), true, ctx.measurer, name_size, NAME_WRAP, TextStyle::NONE, None, ctx.math),
            base | TextStyle::BOLD,
            ctx.measurer,
        );
        let fields: Vec<(&str, &str)> = match &node.kind {
            ReqNodeKind::Requirement(r) => vec![
                ("ID", r.requirement_id.as_str()),
                ("Text", r.text.as_str()),
                ("Risk", r.risk.as_str()),
                ("Verification", r.verify_method.as_str()),
            ],
            ReqNodeKind::Element(e) => vec![("Type", e.elem_type.as_str()), ("Doc Ref", e.doc_ref.as_str())],
        };
        let mut rows: Vec<Row> = Vec::new();
        let mut key_width = 0.0f64;
        let mut value_width = 0.0f64;
        let mut body_height = 0.0f64;
        for (label_name, text) in fields {
            if text.is_empty() {
                continue;
            }
            let key = restyle(
                layout_label(Some(label_name), false, ctx.measurer, body_size, 4000.0, TextStyle::NONE, None, ctx.math),
                base,
                ctx.measurer,
            );
            let value = restyle(
                layout_label(Some(text), true, ctx.measurer, body_size, VALUE_WRAP, TextStyle::NONE, None, ctx.math),
                base,
                ctx.measurer,
            );
            let height = key.height.max(value.height);
            key_width = key_width.max(key.width);
            value_width = value_width.max(value.width);
            body_height += height + ROW_GAP;
            rows.push(Row { key, value, height });
        }
        if !rows.is_empty() {
            body_height += 2.0 * PAD_Y - ROW_GAP;
        }
        let head_height = 2.0 * PAD_Y + kind.height + name.height;
        let w = MIN_WIDTH.max(kind.width.max(name.width) + 2.0 * PAD_X).max(if !rows.is_empty() {
            key_width + COLUMN_GAP + value_width + 2.0 * PAD_X
        } else {
            0.0
        });
        // A requirement and an element may share a name; relationships then go to the requirement.
        index.entry(node.id).or_insert(views.len());
        let h = head_height + body_height;
        let mut c = cnode(w, h, -1);
        c.seq = views.len();
        views.push(NodeView {
            node,
            style,
            kind,
            name,
            rows,
            key_width,
            head_height,
            w,
            h,
        });
        cnodes.push(c);
    }

    let root_dir = if turned { Dir::TB } else { direction(Some(graph.direction)) };
    let sideways = root_dir == Dir::LR || root_dir == Dir::RL;
    let mut cedges: Vec<CEdge> = Vec::new();
    let mut edge_labels: Vec<Label> = Vec::new();
    let mut drawn: Vec<GraphEdge> = Vec::new();
    for edge in graph.edges {
        let (Some(start), Some(end)) = (edge.start.as_deref(), edge.end.as_deref()) else {
            continue;
        };
        let (Some(&src), Some(&dst)) = (index.get(start), index.get(end)) else {
            continue;
        };
        let label_text = format!("«{}»", edge.rel_type);
        let label = layout_label(Some(&label_text), false, ctx.measurer, small, 4000.0, TextStyle::NONE, None, ctx.math);
        if src == dst {
            if sideways {
                cnodes[src].h += 2.0 * (LOOP + label.height + 8.0);
            } else {
                cnodes[src].w += 2.0 * (LOOP + label.width + 12.0);
            }
        }
        let lw = label.width + 12.0;
        let lh = label.height + 4.0;
        drawn.push(edge);
        edge_labels.push(label);
        cedges.push(cedge(src, dst, 1, lw, lh));
    }

    let layout = compound_layout(
        &mut cnodes,
        &mut cedges,
        root_dir,
        &LayeredOptions {
            node_sep: NODE_SEP,
            edge_sep: EDGE_SEP,
            rank_sep: RANK_SEP,
            port_sep: 20.0,
            tracks: false,
            straight: false,
            apart: false,
            head_room: 0.0,
            groups: None,
            order_only: false,
        },
    );

    spread_ends(&cnodes, &mut cedges, &views);

    let title = title_label(model.title.as_deref(), ctx.measurer, size, 4000.0);
    let title_height = if title.height > 0.0 { title.height + 12.0 } else { 0.0 };
    let inner = layout.width.max(title.width);
    let ox = pad + (inner - layout.width) / 2.0;
    let oy = pad + title_height;
    let width = (inner + 2.0 * pad).ceil();
    let height = (layout.height + title_height + 2.0 * pad).ceil();

    let mut nodes_out = String::new();
    for (i, view) in views.iter().enumerate() {
        let w = view.w;
        let h = view.h;
        let style = &view.style;
        let color = ink_fill(&style.shape, &style.text, ctx.theme, None);
        let muted = if color.is_empty() {
            format!(r#" fill="{}""#, ctx.theme.muted())
        } else {
            color.clone()
        };
        let left = -w / 2.0;
        let top = -h / 2.0;
        let mut body = format!(
            r#"<rect x="{}" y="{}" width="{}" height="{}" fill="{}" stroke="{}"{}/>"#,
            num(left),
            num(top),
            num(w),
            num(h),
            ctx.theme.surface(),
            ctx.theme.border(),
            ctx.theme.rounded(&style.shape),
        );
        body.push_str(&label_svg(
            &view.kind,
            0.0,
            top + PAD_Y + view.kind.height / 2.0,
            &format!(r#" class="pele-stereotype" font-size="{}"{muted}{}"#, num(view.kind.size), style.text),
            ctx.theme,
            None,
        ));
        body.push_str(&label_svg(
            &view.name,
            0.0,
            top + PAD_Y + view.kind.height + view.name.height / 2.0,
            &format!(
                r#" class="pele-label" font-size="{}" font-weight="{}"{color}{}"#,
                num(view.name.size),
                ctx.theme.heading_weight(),
                style.text,
            ),
            ctx.theme,
            None,
        ));
        if !view.rows.is_empty() {
            let divider = top + view.head_height;
            body.push_str(&format!(
                r#"<path class="pele-divider" d="M{},{}H{}" stroke="{}"{}/>"#,
                num(left),
                num(divider),
                num(-left),
                ctx.theme.border(),
                style.line,
            ));
            let mut y = divider + PAD_Y;
            let mut rows_svg = String::new();
            for row in &view.rows {
                rows_svg.push_str(&start_text(
                    &row.key,
                    left + PAD_X,
                    y,
                    &format!(r#" class="pele-field"{muted}{}"#, style.text),
                    ctx.theme,
                ));
                rows_svg.push_str(&start_text(
                    &row.value,
                    left + PAD_X + view.key_width + COLUMN_GAP,
                    y,
                    &format!(r#" class="pele-value"{color}{}"#, style.text),
                    ctx.theme,
                ));
                y += row.height + ROW_GAP;
            }
            body.push_str(&format!(r#"<g class="pele-fields" font-size="{}">{rows_svg}</g>"#, num(view.rows[0].key.size)));
        }
        let kind_cls = match view.node.kind {
            ReqNodeKind::Requirement(_) => "pele-requirement",
            ReqNodeKind::Element(_) => "pele-element",
        };
        let trimmed_cls = view
            .node
            .css_classes
            .strip_prefix("default ")
            .or_else(|| view.node.css_classes.strip_prefix("default"))
            .unwrap_or(&view.node.css_classes);
        nodes_out.push_str(&format!(
            r#"<g class="pele-node {kind_cls}{}" data-id="{}" transform="translate({},{})">{body}</g>"#,
            class_names(trimmed_cls),
            esc_text(view.node.id),
            num(cnodes[i].x + ox),
            num(cnodes[i].y + oy),
        ));
    }

    let mut edges_out = String::new();
    let mut labels_out = String::new();
    let mut loop_seen: HashMap<usize, usize> = HashMap::new();
    for (i, ce) in cedges.iter().enumerate() {
        let edge = &drawn[i];
        let label = &edge_labels[i];
        let start_trim = if edge.contains { 2.0 * CONTAINS_RADIUS } else { 0.0 };
        let mut label_x = ce.label_x + ox;
        let mut label_y = ce.label_y + oy;
        let path = if ce.src == ce.dst {
            let view = &views[ce.src];
            let cx = cnodes[ce.src].x + ox;
            let cy = cnodes[ce.src].y + oy;
            let k = *loop_seen.get(&ce.src).unwrap_or(&0);
            loop_seen.insert(ce.src, k + 1);
            let half = if sideways { view.w } else { view.h } / 2.0;
            let spread = (half - 4.0).min(12.0 + (k as f64) * 6.0);
            let reach = LOOP + (k as f64) * 8.0;
            let at = |out: f64, along: f64| -> String {
                if sideways {
                    format!("{},{}", num(cx + along), num(cy + view.h / 2.0 + out))
                } else {
                    format!("{},{}", num(cx + view.w / 2.0 + out), num(cy + along))
                }
            };
            let pull = reach / 0.75;
            if sideways {
                label_x = cx;
                label_y = cy + view.h / 2.0 + reach + 4.0 + ce.label_h / 2.0;
            } else {
                label_x = cx + view.w / 2.0 + reach + 4.0 + ce.label_w / 2.0;
                label_y = cy;
            }
            EdgePath {
                d: format!("M{}C{} {} {}", at(start_trim, -spread), at(pull, -spread), at(pull, spread), at(0.0, spread)),
                tokens: None,
                sx: if sideways { cx - spread } else { cx + view.w / 2.0 },
                sy: if sideways { cy + view.h / 2.0 } else { cy - spread },
                sdx: if sideways { 0.0 } else { -1.0 },
                sdy: if sideways { -1.0 } else { 0.0 },
                ex: if sideways { cx + spread } else { cx + view.w / 2.0 },
                ey: if sideways { cy + view.h / 2.0 } else { cy + spread },
                edx: if sideways { 0.0 } else { -1.0 },
                edy: if sideways { -1.0 } else { 0.0 },
            }
        } else {
            let mut route = ce.route.clone();
            let mut k = 0;
            while k < route.len() {
                route[k] += ox;
                route[k + 1] += oy;
                k += 3;
            }
            route_path(&route, None, start_trim, 0.0, None, None)
        };
        let rel_cls = if edge.contains { "contains" } else { "arrow" };
        let dash = if edge.contains { "" } else { r#" stroke-dasharray="5 4""# };
        let mark = if edge.contains {
            contains_marker(path.sx, path.sy, path.sdx, path.sdy)
        } else {
            arrow_marker(path.ex, path.ey, path.edx, path.edy)
        };
        edges_out.push_str(&format!(
            r#"<g class="pele-edge pele-relationship-{rel_cls}" data-id="{}"><path d="{}"{dash}/>{mark}</g>"#,
            esc_text(&edge.id),
            path.d,
        ));
        labels_out.push_str(&edge_label_svg(&edge.id, label, label_x, label_y, "", ctx.theme, None));
    }

    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let mut content = label_svg(&title, width / 2.0, pad + title.height / 2.0, &title_attrs, ctx.theme, None);
    if !edges_out.is_empty() {
        content.push_str(&format!(
            r#"<g class="pele-edges" fill="none" stroke="{}" stroke-linecap="round">{edges_out}</g>"#,
            ctx.theme.line(),
        ));
    }
    if !labels_out.is_empty() {
        content.push_str(&format!(
            r#"<g class="pele-edge-labels" font-size="{}" fill="{}">{labels_out}</g>"#,
            num(small),
            ctx.theme.muted(),
        ));
    }
    content.push_str(&format!(r#"<g class="pele-nodes">{nodes_out}</g>"#));

    let svg = svg_document(
        "requirement",
        width,
        height,
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
        width,
        height,
        links: Vec::new(),
    }
}
