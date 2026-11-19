use std::collections::{BTreeMap, HashMap};

use indexmap::IndexMap;

use crate::config::DiagramConfig;
use crate::diagram::RenderContext;
use crate::diagram::common::{icon_svg, parse_generic_types, runs_across, turn_to_fit};
use crate::layout::compound::{CEdge, CNode, Dir, cedge, cnode, compound_layout, direction, shift_layout};
use crate::layout::layered::LayeredOptions;
use crate::measure::TextStyle;
use crate::svg::builder::{esc, esc_text, label_svg, num, shared_style, span_style, text_style};
use crate::svg::cluster::{Crossings, cluster_title_x, mark_crossings};
use crate::svg::edges::{Fill, FillRelation, casing, casings_svg, edge_label_svg, fill_under, route_path};
use crate::svg::ink::{InkTone, extract_css_prop, ink, ink_fill, ink_tone, paints};
use crate::svg::root::{Accessible, svg_document};
use crate::svg::theme::{ResolvedStyle, SvgTheme, class_names, resolve_style, sets_fill};
use crate::svg::title::title_label;
use crate::text::entities::decode_entities;
use crate::text::label::{Label, Span, layout_label};
use crate::util::chars::is_space_char;
use crate::util::url::{internal_link, rel_attr};
use crate::util::yaml::YamlValue;
use crate::{IconResolver, LinkInfo, MonospacePart, Rendered};

use super::db::ErDb;
use super::graph::{EdgePattern, ErGraphEdge, ErGraphNode, build_er_graph};
use super::markers::{MARKER_LENGTH, er_marker};

const NODE_SEP: f64 = 48.0;
const EDGE_SEP: f64 = 20.0;
const RANK_SEP: f64 = 64.0;
const GROUP_PAD: f64 = 20.0;
const LOOP: f64 = 28.0;
const LOOP_BAND: f64 = 38.0;
const MIN_WIDTH: f64 = 96.0;
const BOX_PAD_X: f64 = 18.0;
const BOX_PAD_Y: f64 = 12.0;
const HEAD_PAD_Y: f64 = 9.0;
const CELL_PAD_X: f64 = 12.0;
const CELL_GAP: f64 = 16.0;
const ROW_PAD: f64 = 9.0;
const COMMENT_WRAP: f64 = 260.0;
const NO_WRAP: f64 = 1e6;
const PORT_GAP: f64 = 18.0;
const PORT_MARGIN: f64 = 14.0;

fn number_option(config: &DiagramConfig, key: &str, fallback: f64) -> f64 {
    match config.section("er").and_then(|s| s.get(key)).and_then(YamlValue::as_f64) {
        Some(v) if v > 0.0 => v.min(2000.0),
        _ => fallback,
    }
}

struct Row {
    cells: [Label; 4],
    h: f64,
}

struct NodeView {
    node: ErGraphNode,
    style: ResolvedStyle,
    label: Label,
    w: f64,
    h: f64,
    head_h: f64,
    rows: Vec<Row>,
    /// Left edge of each column, measured from the left edge of the box.
    cols: [f64; 4],
    row_size: f64,
    key_size: f64,
    mono: TextStyle,
    /// Whether self-relationships loop out of the bottom side rather than the right.
    below: bool,
}

#[derive(Debug, Clone, Copy)]
struct Loop {
    band: f64,
    at: f64,
}

fn line_has_math(line: &[Span]) -> bool {
    line.iter().any(|span| span.math.is_some())
}

/// Writes a measured label starting at `x`, with the baseline of its first line at `y`.
#[allow(clippy::too_many_arguments)]
fn text_left(label: &Label, x: f64, y: f64, attrs: &str, theme: &SvgTheme, icons: Option<&IconResolver<'_>>, mono: TextStyle) -> String {
    let lines = &label.lines;
    if lines.is_empty() {
        return String::new();
    }
    if lines.len() == 1 && lines[0].len() == 1 {
        let only = &lines[0][0];
        // The short form collapses repeated spaces in monospace text.
        if only.icon.is_none() && only.math.is_none() && only.style == mono && !(mono != TextStyle::NONE && only.text.contains("  ")) {
            return format!(
                r#"<text{} x="{}" y="{}">{}</text>"#,
                text_style(attrs, mono, theme),
                num(x),
                num(y),
                esc(&only.text),
            );
        }
    }
    let shared = shared_style(label);
    let shift = label.size * 0.35;
    let top = y - shift - label.line_height / 2.0;
    let mut body = String::new();
    let mut extra = String::new();
    for (i, line) in lines.iter().enumerate() {
        let middle = top + label.line_middle(i);
        if line_has_math(line) {
            extra.push_str(&label_svg(&label.single_line(i), x + label.widths[i] / 2.0, middle, attrs, theme, icons));
            continue;
        }
        let line_y = middle + shift;
        let has_icon = line.iter().any(|span| span.icon.is_some());
        let mut sx = x;
        let mut placed = false;
        for span in line {
            if let Some(icon) = &span.icon {
                let side = label.size * 1.1;
                extra.push_str(&icon_svg(icon, sx, line_y - label.size * 0.35 - side / 2.0, side, icons));
            } else if !span.text.is_empty() {
                let pos = if has_icon || !placed {
                    format!(r#" x="{}" y="{}""#, num(sx), num(line_y))
                } else {
                    String::new()
                };
                body.push_str(&format!("<tspan{pos}{}>{}</tspan>", span_style(span.style & !shared, theme), esc(&span.text)));
                placed = true;
            }
            sx += span.width;
        }
    }
    format!(r#"<text{} xml:space="preserve">{body}</text>{extra}"#, text_style(attrs, shared, theme))
}

/// Mermaid reads `~` pairs as angle brackets; write them as entities so the label parser does not treat them as HTML tags.
fn cell_text(raw: &str) -> String {
    let converted = parse_generic_types(raw);
    if converted == raw {
        converted
    } else {
        converted.replace('<', "&lt;").replace('>', "&gt;")
    }
}

fn strip_leading_default(raw: &str) -> &str {
    if let Some(rest) = raw.strip_prefix("default") {
        if let Some(ch) = rest.chars().next()
            && is_space_char(ch)
        {
            &rest[ch.len_utf8()..]
        } else {
            rest
        }
    } else {
        raw
    }
}

fn hollow_on(markers: &str, fill: &Fill, bg: &str) -> String {
    match extract_css_prop(&fill.shape, "fill").map(str::trim).filter(|s| !s.is_empty()) {
        Some(color) => markers.replace(&format!(r#" fill="{bg}""#), &format!(r#" fill="{color}""#)),
        None => markers.to_string(),
    }
}

pub fn render_er(db: &ErDb, ctx: &RenderContext<'_>) -> Rendered {
    if !runs_across(Some(db.direction.as_str())) {
        return draw(db, ctx, false);
    }
    turn_to_fit(ctx.options, |down| draw(db, ctx, down))
}

fn draw(db: &ErDb, ctx: &RenderContext<'_>, turned: bool) -> Rendered {
    let graph = build_er_graph(db);
    let monospaced = ctx.options.monospace.contains(&MonospacePart::Attributes);
    let size = ctx.options.font_size.unwrap_or(16.0);
    let small_size = (size * 0.875).round();
    let pad = ctx.options.padding.unwrap_or(8.0);
    let box_attrs = ctx.theme.shape_attrs();

    let mut index: HashMap<String, usize> = HashMap::with_capacity(graph.nodes.len());
    for (i, node) in graph.nodes.iter().enumerate() {
        index.insert(node.id.clone(), i);
    }

    let mut cedges: Vec<CEdge> = Vec::with_capacity(graph.edges.len());
    let mut edge_labels: Vec<Label> = Vec::with_capacity(graph.edges.len());
    let mut drawn: Vec<ErGraphEdge> = Vec::with_capacity(graph.edges.len());
    let mut loops_by_node: IndexMap<usize, Vec<usize>> = IndexMap::new();
    let mut edge_loops: Vec<Option<Loop>> = Vec::with_capacity(graph.edges.len());

    for edge in graph.edges {
        let (Some(&src), Some(&dst)) = (index.get(&edge.start), index.get(&edge.end)) else {
            continue;
        };
        let label = layout_label(
            Some(edge.label.as_str()),
            true,
            ctx.measurer,
            small_size,
            200.0,
            TextStyle::NONE,
            ctx.icons,
            ctx.math,
        );
        let edge_idx = drawn.len();
        let lp = if src == dst {
            loops_by_node.entry(src).or_default().push(edge_idx);
            Some(Loop { band: 0.0, at: 0.0 })
        } else {
            None
        };
        let lw = if label.width > 0.0 { label.width + 12.0 } else { 0.0 };
        let lh = if label.height > 0.0 { label.height + 4.0 } else { 0.0 };
        edge_loops.push(lp);
        drawn.push(edge);
        edge_labels.push(label);
        cedges.push(cedge(src, dst, 1, lw, lh));
    }

    // The direction of the level a node is laid out in: its nearest subgraph that sets one, or the diagram's.
    let horizontal = |i: usize| -> bool {
        let mut at = i;
        for _ in 0..graph.nodes.len() {
            let Some(parent) = graph.nodes[at].parent_id.as_deref() else {
                break;
            };
            let Some(&up) = index.get(parent) else {
                break;
            };
            if let Some(dir) = graph.nodes[up].dir.as_deref() {
                return dir == "LR" || dir == "RL";
            }
            at = up;
        }
        db.direction == "LR" || db.direction == "RL"
    };

    let mut views: Vec<NodeView> = Vec::with_capacity(graph.nodes.len());
    let mut cnodes: Vec<CNode> = Vec::with_capacity(graph.nodes.len());
    let node_count = graph.nodes.len();
    let node_horizontal: Vec<bool> = (0..node_count).map(horizontal).collect();

    for (i, node) in graph.nodes.into_iter().enumerate() {
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
        let has_font_family = style.text.contains(r#""font-family:"#) || style.text.contains(";font-family:");
        let mono = if monospaced && !has_font_family { TextStyle::MONO } else { TextStyle::NONE };
        let name_size = style.font_size.unwrap_or(size);
        let row_size = style.font_size.unwrap_or(small_size);
        let key_size = style.font_size.unwrap_or_else(|| (size * 0.75).round());
        let label = if node.is_group {
            layout_label(Some(node.label.as_str()), true, ctx.measurer, name_size, 4000.0, base, ctx.icons, ctx.math)
        } else {
            let text = if node.alias.is_empty() { node.label.as_str() } else { node.alias.as_str() };
            layout_label(Some(text), true, ctx.measurer, name_size, 240.0, base, ctx.icons, ctx.math)
        };

        let own = loops_by_node.get(&i).map(Vec::as_slice).unwrap_or(&[]);
        // Loops leave by a side the layout keeps free of other edges: the right when ranks run down,
        // the bottom when they run across.
        let below = !own.is_empty() && !node.is_group && node_horizontal[i];
        let mut reach = 0.0f64;
        let mut bands = 0.0f64;
        for &ei in own {
            let lbl = &edge_labels[ei];
            let band = LOOP_BAND.max(if below { lbl.width + 12.0 } else { lbl.height + 6.0 });
            if let Some(lp) = edge_loops[ei].as_mut() {
                lp.band = band;
            }
            bands += band;
            reach = reach.max(if below { lbl.height } else { lbl.width });
        }
        let min_w = MIN_WIDTH.max(if below { bands + 8.0 } else { 0.0 });

        let mut view = NodeView {
            node,
            style,
            label,
            w: 0.0,
            h: 0.0,
            head_h: 0.0,
            rows: Vec::new(),
            cols: [0.0; 4],
            row_size,
            key_size,
            mono,
            below,
        };

        let mut c = if view.node.is_group {
            let mut c = cnode(0.0, 0.0, -1);
            c.is_group = true;
            c.dir = view.node.dir.as_deref().map(|d| direction(Some(d)));
            c.pad_x = GROUP_PAD;
            c.pad_top = if view.label.height > 0.0 { view.label.height + 16.0 } else { GROUP_PAD };
            c.pad_bottom = GROUP_PAD;
            c.min_w = (view.label.width + 2.0 * GROUP_PAD - 12.0).max(MIN_WIDTH);
            c
        } else {
            let name_h = view.label.height.max((name_size * 1.5).round());
            if view.node.attributes.is_empty() {
                view.w = (view.label.width + 2.0 * BOX_PAD_X).max(min_w);
                view.h = (name_h + 2.0 * BOX_PAD_Y).max(if below { 0.0 } else { bands + 8.0 });
            } else {
                let row_line = (row_size * 1.5).round();
                let mut widths = [0.0f64; 4];
                for attribute in &view.node.attributes {
                    let type_str = cell_text(&attribute.attr_type);
                    let name_str = cell_text(&attribute.name);
                    let keys_str = attribute.keys.join(", ");
                    let comment_str = cell_text(&attribute.comment);
                    let cells = [
                        layout_label(Some(type_str.as_str()), true, ctx.measurer, row_size, NO_WRAP, base | mono, ctx.icons, ctx.math),
                        layout_label(Some(name_str.as_str()), true, ctx.measurer, row_size, NO_WRAP, base | mono, ctx.icons, ctx.math),
                        layout_label(
                            Some(keys_str.as_str()),
                            false,
                            ctx.measurer,
                            key_size,
                            NO_WRAP,
                            base | mono,
                            ctx.icons,
                            ctx.math,
                        ),
                        layout_label(
                            Some(comment_str.as_str()),
                            true,
                            ctx.measurer,
                            row_size,
                            COMMENT_WRAP,
                            base,
                            ctx.icons,
                            ctx.math,
                        ),
                    ];
                    let mut h = row_line;
                    for k in 0..4 {
                        if cells[k].width > widths[k] {
                            widths[k] = cells[k].width;
                        }
                        if cells[k].height > h {
                            h = cells[k].height;
                        }
                    }
                    view.rows.push(Row { cells, h: h + ROW_PAD });
                    view.h += h + ROW_PAD;
                }
                let mut columns = 0usize;
                let mut inner = 0.0f64;
                for &w in &widths {
                    if w == 0.0 {
                        continue;
                    }
                    inner += w + if columns > 0 { CELL_GAP } else { 0.0 };
                    columns += 1;
                }
                view.w = (inner + 2.0 * CELL_PAD_X).max(view.label.width + 2.0 * BOX_PAD_X).max(min_w);
                // A box wider than its table shares the spare width between the columns.
                let spare = if columns > 0 {
                    (view.w - inner - 2.0 * CELL_PAD_X) / columns as f64
                } else {
                    0.0
                };
                let mut x = CELL_PAD_X;
                for (col, &w) in view.cols.iter_mut().zip(widths.iter()) {
                    *col = x;
                    if w > 0.0 {
                        x += w + spare + CELL_GAP;
                    }
                }
                view.head_h = name_h + 2.0 * HEAD_PAD_Y;
                view.h += view.head_h;
            }
            // The layout keeps a node centered in its box, so room for loops is added on both sides.
            let room = if !own.is_empty() {
                2.0 * (MARKER_LENGTH + LOOP * 0.75 + 10.0 + reach)
            } else {
                0.0
            };
            if below {
                cnode(view.w, view.h + room, -1)
            } else {
                cnode(view.w + room, view.h, -1)
            }
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

    let root_dir = if turned { Dir::TB } else { direction(Some(db.direction.as_str())) };
    let layout = compound_layout(
        &mut cnodes,
        &mut cedges,
        root_dir,
        &LayeredOptions {
            node_sep: number_option(ctx.config, "nodeSpacing", NODE_SEP),
            edge_sep: EDGE_SEP,
            rank_sep: number_option(ctx.config, "rankSpacing", RANK_SEP),
            port_sep: 24.0,
            ..LayeredOptions::default()
        },
    );

    spread_ends(&mut cedges, &cnodes, &views);

    // A subgraph gets its size from the layout, so its loops hang outside it and may widen the diagram.
    let mut layout_width = layout.width;
    for (&i, own) in &loops_by_node {
        let c = &cnodes[i];
        if !c.is_group {
            continue;
        }
        let mut reach = 0.0f64;
        for &ei in own {
            reach = reach.max(edge_labels[ei].width);
        }
        layout_width = layout_width.max(c.x + c.w / 2.0 + MARKER_LENGTH + LOOP * 0.75 + 10.0 + reach);
    }

    let title = title_label(db.title.as_deref(), ctx.measurer, size, 4000.0);
    let title_height = if title.height > 0.0 { title.height + 12.0 } else { 0.0 };
    let inner = layout_width.max(title.width);
    let ox = pad + (inner - layout_width) / 2.0;
    let oy = pad + title_height;
    shift_layout(&mut cnodes, &mut cedges, ox, oy);
    let width = (inner + 2.0 * pad).ceil();
    let height = (layout.height + title_height + 2.0 * pad).ceil();
    let mut links: Vec<LinkInfo> = Vec::new();

    let mut crossings: Crossings = Crossings::new();
    let any_group = cnodes.iter().any(|c| c.is_group);
    if any_group {
        for e in &cedges {
            mark_crossings(&mut crossings, &e.route);
        }
    }

    let mut clusters = String::new();
    let mut fills: Vec<Fill> = Vec::new();
    let mut nodes_out = String::new();
    for (view, c) in views.iter_mut().zip(cnodes.iter()) {
        let node = &view.node;
        let classes = class_names(strip_leading_default(&node.css_classes));
        if c.is_group {
            view.w = c.w;
            view.h = c.h;
            let x = c.x - c.w / 2.0;
            let y = c.y - c.h / 2.0;
            let title_x = cluster_title_x(c, view.label.width, &crossings, GROUP_PAD);
            if paints(&view.style.shape) {
                fills.push(Fill {
                    bounds: [x, y, x + c.w, y + c.h],
                    shape: view.style.shape.clone(),
                });
            }
            let title_attrs = format!(
                r#" class="pele-cluster-label"{}{}"#,
                ink_fill(&view.style.shape, &view.style.text, ctx.theme, Some(ctx.theme.muted())),
                view.style.text,
            );
            clusters.push_str(&format!(
                r#"<g class="pele-cluster{classes}" data-id="{}"><rect x="{}" y="{}" width="{}" height="{}" fill="{}"{} stroke="{}"{}/>{}</g>"#,
                esc_text(&node.id),
                num(x),
                num(y),
                num(c.w),
                num(c.h),
                ctx.theme.surface_alt(),
                if sets_fill(&view.style.shape) { "" } else { r#" fill-opacity="0.5""# },
                ctx.theme.border(),
                ctx.theme.rounded(&view.style.shape),
                label_svg(&view.label, title_x, y + 8.0 + view.label.height / 2.0, &title_attrs, ctx.theme, ctx.icons),
            ));
            continue;
        }

        let w = view.w;
        let h = view.h;
        let x0 = -w / 2.0;
        let y0 = -h / 2.0;
        let text = &view.style.text;
        let color = ink_fill(&view.style.shape, text, ctx.theme, None);
        let muted = if color.is_empty() {
            format!(r#" fill="{}""#, ctx.theme.muted())
        } else {
            color.clone()
        };
        let shape = format!(r#"x="{}" y="{}" width="{}" height="{}""#, num(x0), num(y0), num(w), num(h));
        let label_attrs = format!(r#" class="pele-label"{color}{text}"#);
        let name_y = if view.rows.is_empty() { 0.0 } else { y0 + view.head_h / 2.0 };
        let mut name = label_svg(&view.label, 0.0, name_y, &label_attrs, ctx.theme, ctx.icons);
        let display_raw = if node.alias.is_empty() { node.label.as_str() } else { node.alias.as_str() };
        let display = decode_entities(display_raw);
        let is_internal_link = classes.split(' ').any(|cls| cls == "internal-link");
        if is_internal_link && !name.is_empty() && ctx.options.links {
            // The name ends up in an href, so it gets the same check as a URL.
            let safe = internal_link(&display, ctx.options);
            let target = esc(&display);
            let href_attr = if safe {
                format!(r#" href="{target}"{}"#, rel_attr(ctx.options))
            } else {
                String::new()
            };
            name = format!(r#"<a class="internal-link"{href_attr} data-href="{target}">{name}</a>"#);
            links.push(LinkInfo {
                id: node.label.clone(),
                href: display,
                internal: true,
            });
        }

        let body = if view.rows.is_empty() {
            let rect_attrs = format!("{box_attrs}{}", view.style.shape);
            format!(r#"<rect {shape}{}/>{name}"#, ctx.theme.rounded(&rect_attrs))
        } else {
            let row_line = (view.row_size * 1.5).round();
            let line_color = match &view.style.stroke {
                Some(s) => esc(s),
                None => ctx.theme.border().to_string(),
            };
            let mut stripes = String::new();
            let mut cells = String::new();
            let mut y = y0 + view.head_h;
            let row_count = view.rows.len();
            let rounded_standalone = ctx.theme.rounded_standalone();
            let type_attrs = format!(r#" class="pele-er-type"{muted}{text}"#);
            let name_attrs = format!(r#" class="pele-er-name"{color}{text}"#);
            let keys_attrs = format!(r#" class="pele-er-keys" font-size="{}"{muted}{text}"#, num(view.key_size));
            let comment_attrs = format!(r#" class="pele-er-comment"{muted}{text}"#);
            for (r, row) in view.rows.iter().enumerate() {
                if r.is_multiple_of(2) {
                    let span = format!(r#"x="{}" width="{}""#, num(x0), num(w));
                    if r == row_count - 1 {
                        // The last row follows the box's rounded bottom corners: a rounded rect, squared off on top.
                        stripes.push_str(&format!(
                            r#"<rect {span} y="{}" height="{}"{rounded_standalone}/><rect {span} y="{}" height="{}"/>"#,
                            num(y),
                            num(row.h),
                            num(y),
                            num(row.h / 2.0),
                        ));
                    } else {
                        stripes.push_str(&format!(r#"<rect {span} y="{}" height="{}"/>"#, num(y), num(row.h)));
                    }
                }
                let baseline = y + ROW_PAD / 2.0 + row_line / 2.0 + view.row_size * 0.35;
                cells.push_str(&text_left(
                    &row.cells[0],
                    x0 + view.cols[0],
                    baseline,
                    &type_attrs,
                    ctx.theme,
                    ctx.icons,
                    view.mono,
                ));
                cells.push_str(&text_left(
                    &row.cells[1],
                    x0 + view.cols[1],
                    baseline,
                    &name_attrs,
                    ctx.theme,
                    ctx.icons,
                    view.mono,
                ));
                cells.push_str(&text_left(
                    &row.cells[2],
                    x0 + view.cols[2],
                    baseline,
                    &keys_attrs,
                    ctx.theme,
                    ctx.icons,
                    view.mono,
                ));
                cells.push_str(&text_left(
                    &row.cells[3],
                    x0 + view.cols[3],
                    baseline,
                    &comment_attrs,
                    ctx.theme,
                    ctx.icons,
                    TextStyle::NONE,
                ));
                y += row.h;
            }
            let divider_y = num(y0 + view.head_h);
            // Keep row shading light on light fills and dark on dark fills to preserve text contrast.
            let shade = match ink_tone(&view.style.shape, "") {
                Some(InkTone::OnLight) => ctx.theme.on_dark(),
                Some(InkTone::OnDark) => ctx.theme.on_light(),
                None => ctx.theme.bg(),
            };
            let stripe_opacity = if view.style.shape.contains("fill:") { r#" opacity="0.6""# } else { "" };
            let rect_attrs = format!("{box_attrs}{}", view.style.shape);
            format!(
                r#"<rect {shape}{}/><g class="pele-er-stripes" fill="{shade}"{stripe_opacity}>{stripes}</g><path class="pele-er-divider" d="M{},{divider_y}H{}" stroke="{line_color}"/><rect {shape} fill="none" stroke="{}"{}/>{name}<g class="pele-er-attributes" font-size="{}">{cells}</g>"#,
                ctx.theme.rounded(&rect_attrs),
                num(x0),
                num(x0 + w),
                ctx.theme.border(),
                ctx.theme.rounded(&view.style.line),
                num(view.row_size),
            )
        };
        nodes_out.push_str(&format!(
            r#"<g class="pele-node pele-entity{classes}" data-id="{}" transform="translate({},{})">{body}</g>"#,
            esc_text(&node.label),
            num(c.x),
            num(c.y),
        ));
    }

    // Self-relationships share the side they loop out of, squeezed together if it is too short for them.
    for (&i, own) in &loops_by_node {
        let view = &views[i];
        let mut total = 0.0f64;
        for &ei in own {
            if let Some(lp) = edge_loops[ei] {
                total += lp.band;
            }
        }
        let avail = (if view.below { view.w } else { view.h } - 8.0).max(0.0);
        let scale = if total > 0.0 { 1.0f64.min(avail / total) } else { 1.0 };
        let mut at = (-total * scale) / 2.0;
        for &ei in own {
            if let Some(lp) = edge_loops[ei].as_mut() {
                lp.band *= scale;
                lp.at = at + lp.band / 2.0;
                at += lp.band;
            }
        }
    }

    let bg = ctx.theme.bg();
    let mut edges_out = String::new();
    let mut casings = String::new();
    let mut labels_out = String::new();
    for i in 0..cedges.len() {
        let ce = &mut cedges[i];
        let edge = &drawn[i];
        let label = &edge_labels[i];
        let (d, mut start, mut end) = if let Some(lp) = edge_loops[i] {
            let c = &cnodes[ce.src];
            let view = &views[ce.src];
            let spread = (lp.band / 2.0 - 6.0).clamp(1.0, 13.0);
            let far = MARKER_LENGTH + LOOP * 0.75 + 6.0;
            if view.below {
                let x = c.x + lp.at;
                let y = c.y + view.h / 2.0;
                let turn = num(y + MARKER_LENGTH);
                let out = num(y + MARKER_LENGTH + LOOP);
                let d = format!(
                    "M{},{}V{turn}C{},{out} {},{out} {},{turn}V{}",
                    num(x - spread),
                    num(y),
                    num(x - spread),
                    num(x + spread),
                    num(x + spread),
                    num(y),
                );
                let start = er_marker(edge.arrow_type_start, x - spread, y, 0.0, -1.0, bg);
                let end = er_marker(edge.arrow_type_end, x + spread, y, 0.0, -1.0, bg);
                ce.label_x = x;
                ce.label_y = y + far + label.height / 2.0;
                (d, start, end)
            } else {
                let x = c.x + view.w / 2.0;
                let y = c.y + lp.at;
                let turn = num(x + MARKER_LENGTH);
                let out = num(x + MARKER_LENGTH + LOOP);
                let d = format!(
                    "M{},{}H{turn}C{out},{} {out},{} {turn},{}H{}",
                    num(x),
                    num(y - spread),
                    num(y - spread),
                    num(y + spread),
                    num(y + spread),
                    num(x),
                );
                let start = er_marker(edge.arrow_type_start, x, y - spread, -1.0, 0.0, bg);
                let end = er_marker(edge.arrow_type_end, x, y + spread, -1.0, 0.0, bg);
                ce.label_x = x + far + label.width / 2.0;
                ce.label_y = y;
                (d, start, end)
            }
        } else {
            let mut route = straighten(&ce.route);
            if route.len() < 6 {
                continue;
            }
            let last = route.len() - 3;
            inset(&mut route, 0, &views[ce.src], &cnodes[ce.src]);
            inset(&mut route, last, &views[ce.dst], &cnodes[ce.dst]);
            // A curve stops short of each box so that the marker sits on a straight run of line.
            let dx = (route[last] - route[0]).abs();
            let dy = (route[last + 1] - route[1]).abs();
            let direct = route.len() == 6 && (dx < 0.01 || dy < 0.01 || dx.hypot(dy) <= 3.0 * MARKER_LENGTH);
            let stub = if direct { 0.0 } else { MARKER_LENGTH };
            let path = route_path(&route, None, stub, stub, None, None);
            let d = if stub > 0.0 {
                let tail = path.d.strip_prefix('M').unwrap_or(&path.d);
                format!("M{},{}L{tail}L{},{}", num(path.sx), num(path.sy), num(path.ex), num(path.ey))
            } else {
                path.d
            };
            let start = er_marker(edge.arrow_type_start, path.sx, path.sy, path.sdx, path.sdy, bg);
            let end = er_marker(edge.arrow_type_end, path.ex, path.ey, path.edx, path.edy, bg);
            (d, start, end)
        };

        let over = match fill_under(&d, &[], &fills, None) {
            FillRelation::Outside => None,
            FillRelation::CrossesBorder => {
                casings.push_str(&casing(&d, &format!("{start}{end}"), "", false));
                None
            }
            FillRelation::Inside(fill) => match ink(&fill.shape, "", ctx.theme) {
                Some(color) => {
                    start = hollow_on(&start, fill, bg);
                    end = hollow_on(&end, fill, bg);
                    Some(color)
                }
                None => {
                    casings.push_str(&casing(&d, &format!("{start}{end}"), "", false));
                    None
                }
            },
        };

        let (cls_suffix, dash_attr) = match edge.pattern {
            EdgePattern::Solid => ("identifying", ""),
            EdgePattern::Dashed => ("non-identifying", r#" stroke-dasharray="4 3""#),
        };
        let stroke_attr = match over {
            Some(color) => format!(r#" stroke="{color}""#),
            None => String::new(),
        };
        edges_out.push_str(&format!(
            r#"<g class="pele-edge pele-er-{cls_suffix}" data-id="{}"{stroke_attr}><path d="{d}"{dash_attr}/>{start}{end}</g>"#,
            esc_text(&edge.id),
        ));
        if label.width > 0.0 {
            labels_out.push_str(&edge_label_svg(&edge.id, label, ce.label_x, ce.label_y, "", ctx.theme, ctx.icons));
        }
    }

    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let content = format!(
        "{}{}{}{}{}<g class=\"pele-nodes\">{nodes_out}</g>",
        label_svg(&title, width / 2.0, pad + title.height / 2.0, &title_attrs, ctx.theme, None),
        if clusters.is_empty() {
            String::new()
        } else {
            format!(r#"<g class="pele-clusters">{clusters}</g>"#)
        },
        casings_svg(&casings, ctx.theme),
        if edges_out.is_empty() {
            String::new()
        } else {
            format!(
                r#"<g class="pele-edges" fill="none" stroke="{}" stroke-linecap="round">{edges_out}</g>"#,
                ctx.theme.line(),
            )
        },
        if labels_out.is_empty() {
            String::new()
        } else {
            format!(r#"<g class="pele-edge-labels" font-size="{}">{labels_out}</g>"#, num(small_size))
        },
    );

    let svg = svg_document(
        "er",
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

fn straighten(route: &[f64]) -> Vec<f64> {
    if route.len() < 3 {
        return route.to_vec();
    }
    let mut out = route[..3].to_vec();
    let mut k = 3usize;
    while k + 2 < route.len() {
        let prev = out.len() - 3;
        let flat = |axis: usize| -> bool { (out[prev + axis] - route[k + axis]).abs() < 0.01 && (route[k + axis] - route[k + 3 + axis]).abs() < 0.01 };
        if k + 3 < route.len() && (flat(0) || flat(1)) {
            k += 3;
            continue;
        }
        out.push(route[k]);
        out.push(route[k + 1]);
        out.push(route[k + 2]);
        k += 3;
    }
    out
}

struct End {
    edge_idx: usize,
    at: usize,
    toward: f64,
}

/// Spaces out edges meeting one side of a box so their cardinality markers do not overlap.
fn spread_ends(cedges: &mut [CEdge], cnodes: &[CNode], views: &[NodeView]) {
    let mut sides: BTreeMap<usize, Vec<End>> = BTreeMap::new();
    let mut add = |node: usize, edge_idx: usize, route: &[f64], at: usize, next: usize| {
        let c = &cnodes[node];
        let dx = route[at] - c.x;
        let dy = route[at + 1] - c.y;
        let side = if (dy.abs() - c.h / 2.0).abs() < 0.5 {
            if dy < 0.0 { 0usize } else { 2usize }
        } else if (dx.abs() - c.w / 2.0).abs() < 0.5 {
            if dx < 0.0 { 3usize } else { 1usize }
        } else {
            return;
        };
        let key = node * 4 + side;
        let toward = route[next + (side & 1)];
        sides.entry(key).or_default().push(End { edge_idx, at, toward });
    };
    for (edge_idx, e) in cedges.iter().enumerate() {
        if e.src == e.dst || e.route.len() < 6 {
            continue;
        }
        let last = e.route.len() - 3;
        add(e.src, edge_idx, &e.route, 0, 3);
        add(e.dst, edge_idx, &e.route, last, last - 3);
    }
    for (key, mut ends) in sides {
        if ends.len() < 2 {
            continue;
        }
        let node = key >> 2;
        let vertical = (key & 1) == 1;
        let length = if cnodes[node].is_group {
            if vertical { cnodes[node].h } else { cnodes[node].w }
        } else if vertical {
            views[node].h
        } else {
            views[node].w
        };
        let step = PORT_GAP.min((length - 2.0 * PORT_MARGIN) / (ends.len() - 1) as f64).max(0.0);
        let center = if vertical { cnodes[node].y } else { cnodes[node].x };
        ends.sort_by(|a, b| a.toward.total_cmp(&b.toward));
        let axis = usize::from(vertical);
        for (i, end) in ends.iter().enumerate() {
            cedges[end.edge_idx].route[end.at + axis] = center + (i as f64 - (ends.len() - 1) as f64 / 2.0) * step;
        }
    }
}

#[inline]
fn sign_zero(v: f64) -> f64 {
    if v > 0.0 {
        1.0
    } else if v < 0.0 {
        -1.0
    } else {
        0.0
    }
}

/// Moves a route end from a self-loop-padded layout box onto the entity's drawn box side.
fn inset(route: &mut [f64], at: usize, view: &NodeView, c: &CNode) {
    if c.is_group {
        return;
    }
    let dx = route[at] - c.x;
    let dy = route[at + 1] - c.y;
    if c.w != view.w && (dx.abs() - c.w / 2.0).abs() < 0.5 {
        route[at] -= (sign_zero(dx) * (c.w - view.w)) / 2.0;
    }
    if c.h != view.h && (dy.abs() - c.h / 2.0).abs() < 0.5 {
        route[at + 1] -= (sign_zero(dy) * (c.h - view.h)) / 2.0;
    }
}
