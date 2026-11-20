use std::cmp::Ordering;
use std::collections::HashMap;

use crate::config::DiagramConfig;
use crate::diagram::RenderContext;
use crate::diagram::common::{runs_across, turn_to_fit};
use crate::layout::compound::{CEdge, CNode, Dir, cedge, cnode, compound_layout, direction};
use crate::layout::layered::LayeredOptions;
use crate::measure::TextStyle;
use crate::svg::builder::{esc, esc_text, label_svg, num};
use crate::svg::cluster::Crossings;
use crate::svg::edges::{EdgePath, Fill, OverFill, SideReach, casings_svg, edge_casing, edge_label_svg, marker, marker_trim, over_fills, route_path};
use crate::svg::ink::{ink_fill, paints};
use crate::svg::root::{Accessible, svg_document};
use crate::svg::shapes::end_side;
use crate::svg::theme::{ResolvedStyle, class_names, resolve_style, sets_fill};
use crate::svg::title::with_title;
use crate::text::entities::decode_entities;
use crate::text::label::{Label, layout_label};
use crate::util::url::{linked, safe_url};
use crate::util::yaml::YamlValue;
use crate::{LinkInfo, Rendered};

use super::db::StateDb;
use super::graph::{EdgePattern, StateEdge, StateNode, StateNodeShape};

const NODE_SEP: f64 = 40.0;
const EDGE_SEP: f64 = 16.0;
const RANK_SEP: f64 = 44.0;
const GROUP_PAD: f64 = 16.0;
const REGION_PAD: f64 = 10.0;
const PAD_X: f64 = 16.0;
const PAD_Y: f64 = 10.0;
const LOOP: f64 = 26.0;
const FOLD: f64 = 8.0;
const NOTE_WRAP: f64 = 320.0;
const CORNER: f64 = 10.0;
const BAR: f64 = 8.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RenderKind {
    State,
    Described,
    Start,
    End,
    Choice,
    Fork,
    Join,
    Note,
    Composite,
    Region,
    Hidden,
}

impl RenderKind {
    const fn class_name(self) -> &'static str {
        match self {
            Self::State | Self::Described => "pele-node pele-state",
            Self::Start => "pele-node pele-state-start",
            Self::End => "pele-node pele-state-end",
            Self::Choice => "pele-node pele-state-choice",
            Self::Fork => "pele-node pele-state-fork",
            Self::Join => "pele-node pele-state-join",
            Self::Note => "pele-note",
            Self::Composite => "pele-cluster pele-state-composite",
            Self::Region | Self::Hidden => "",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum AppearOrder {
    First,
    At(usize),
    Never,
}

struct View<'a> {
    node: Option<&'a StateNode>,
    kind: RenderKind,
    style: Option<ResolvedStyle>,
    label: Label,
    lines: Vec<Label>,
    w: f64,
    h: f64,
    title_h: f64,
}

fn number_option(config: &DiagramConfig, key: &str, fallback: f64) -> f64 {
    match config.section("state").and_then(|s| s.get(key)).and_then(YamlValue::as_f64) {
        Some(v) if v > 0.0 => v.min(2000.0),
        Some(_) | None => fallback,
    }
}

/// Mermaid keeps the quotes of a click statement's strings and strips them when it draws.
fn unquote(text: &str) -> &str {
    text.trim_matches('"')
}

fn sign_zero(v: f64) -> f64 {
    if v > 0.0 {
        1.0
    } else if v < 0.0 {
        -1.0
    } else {
        0.0
    }
}

fn rect_svg(x: f64, y: f64, w: f64, h: f64, rest: &str) -> String {
    format!(r#"<rect x="{}" y="{}" width="{}" height="{}"{rest}/>"#, num(x), num(y), num(w), num(h))
}

fn group_cnode(dir: Dir, pad_x: f64, pad_top: f64, pad_bottom: f64) -> CNode {
    let mut c = cnode(0.0, 0.0, -1);
    c.is_group = true;
    c.dir = Some(dir);
    c.pad_x = pad_x;
    c.pad_top = pad_top;
    c.pad_bottom = pad_bottom;
    c
}

fn strip_mermaid_classes(raw: &str) -> String {
    raw.split(' ')
        .filter(|tok| {
            !matches!(
                *tok,
                "statediagram-state" | "statediagram-cluster-alt" | "statediagram-cluster" | "statediagram-note"
            )
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn shape_to_kind(node: &StateNode) -> RenderKind {
    if node.is_group {
        return match node.shape {
            Some(StateNodeShape::Divider) => RenderKind::Region,
            Some(
                StateNodeShape::Rect
                | StateNodeShape::RectWithTitle
                | StateNodeShape::StateStart
                | StateNodeShape::StateEnd
                | StateNodeShape::Choice
                | StateNodeShape::Fork
                | StateNodeShape::Join
                | StateNodeShape::RoundedWithTitle
                | StateNodeShape::Note
                | StateNodeShape::NoteGroup,
            )
            | None => RenderKind::Composite,
        };
    }
    match node.shape {
        Some(StateNodeShape::RectWithTitle) => RenderKind::Described,
        Some(StateNodeShape::StateStart) => RenderKind::Start,
        Some(StateNodeShape::StateEnd) => RenderKind::End,
        Some(StateNodeShape::Choice) => RenderKind::Choice,
        Some(StateNodeShape::Fork) => RenderKind::Fork,
        Some(StateNodeShape::Join) => RenderKind::Join,
        Some(StateNodeShape::Note) => RenderKind::Note,
        Some(StateNodeShape::Divider) => RenderKind::Hidden,
        Some(StateNodeShape::Rect | StateNodeShape::RoundedWithTitle | StateNodeShape::NoteGroup) | None => RenderKind::State,
    }
}

pub fn render_state(db: &StateDb, ctx: &RenderContext<'_>) -> Rendered {
    if !runs_across(Some(db.direction())) {
        return draw(db, ctx, false);
    }
    turn_to_fit(ctx.options, |down| draw(db, ctx, down))
}

/// `turned` draws a diagram that runs across as one that runs down.
fn draw(db: &StateDb, ctx: &RenderContext<'_>, turned: bool) -> Rendered {
    let graph = &db.graph;
    // State diagrams follow the flowchart curve.
    let curve = ctx.config.flowchart.curve.as_deref();
    let size = ctx.options.font_size.unwrap_or(16.0);
    let small = (size * 0.875).round();
    let wrap_width = number_option(ctx.config, "wrappingWidth", 200.0);
    let pad = ctx.options.padding.unwrap_or(8.0);
    let root_dir = if turned { Dir::TB } else { direction(Some(db.direction())) };
    let surface_attrs = ctx.theme.shape_attrs();
    let rule_attrs = format!(r#" fill="none" stroke="{}""#, ctx.theme.border());

    let text = |raw: Option<&str>, font_size: f64, wrap: f64, style: TextStyle| -> Label {
        layout_label(raw, true, ctx.measurer, font_size, wrap, style, ctx.icons, ctx.math)
    };

    let mut index: HashMap<&str, usize> = HashMap::new();
    let mut views: Vec<View<'_>> = Vec::new();
    let mut cnodes: Vec<CNode> = Vec::new();

    for node in &graph.nodes {
        if node.shape == Some(StateNodeShape::NoteGroup) {
            continue;
        }
        let kind = shape_to_kind(node);
        let idx = views.len();
        views.push(View {
            node: Some(node),
            kind,
            style: None,
            label: Label::empty(),
            lines: Vec::new(),
            w: 0.0,
            h: 0.0,
            title_h: 0.0,
        });
        index.insert(node.id.as_str(), idx);
    }
    let states = views.len();

    let mut logical: Vec<i32> = Vec::with_capacity(states);
    for (i, view) in views.iter().enumerate() {
        let parent = view.node.and_then(|n| n.parent_id.as_deref()).and_then(|pid| index.get(pid).copied());
        let valid_parent = parent.filter(|&p| p != i && views[p].node.is_some_and(|n| n.is_group));
        logical.push(valid_parent.map_or(-1, |p| p as i32));
    }

    // Composites that are redeclared inside each other form a ring with no way in from the root.
    // One member of each ring moves to the root, which leaves a tree.
    {
        let mut kids: Vec<Vec<usize>> = vec![Vec::new(); states];
        let mut queue: Vec<usize> = Vec::with_capacity(states);
        let mut placed = vec![false; states];
        for i in 0..states {
            if logical[i] == -1 {
                placed[i] = true;
                queue.push(i);
            } else {
                kids[logical[i] as usize].push(i);
            }
        }
        let mut done = 0usize;
        let settle = |done: &mut usize, queue: &mut Vec<usize>, placed: &mut [bool], kids: &[Vec<usize>]| {
            while *done < queue.len() {
                let cur = queue[*done];
                *done += 1;
                for &kid in &kids[cur] {
                    if placed[kid] {
                        continue;
                    }
                    placed[kid] = true;
                    queue.push(kid);
                }
            }
        };
        settle(&mut done, &mut queue, &mut placed, &kids);
        let mut seen = vec![-1i32; states];
        for i in 0..states {
            if placed[i] {
                continue;
            }
            let mut ring = i;
            let mark = i as i32;
            while seen[ring] != mark {
                seen[ring] = mark;
                ring = logical[ring] as usize;
            }
            logical[ring] = -1;
            placed[ring] = true;
            queue.push(ring);
            settle(&mut done, &mut queue, &mut placed, &kids);
        }
    }

    let mut owners = vec![-1i32; states];
    for i in 0..states {
        if let Some(note_for) = views[i].node.and_then(|n| n.note_for.as_deref())
            && let Some(&owner) = index.get(note_for)
        {
            owners[i] = owner as i32;
            logical[i] = logical[owner];
        }
    }

    // As in Mermaid, a composite that sets no direction runs top to bottom whatever surrounds it.
    let inner_dir = |composite: usize, views: &[View<'_>]| -> Dir { direction(views[composite].node.and_then(|n| n.dir.as_deref())) };
    // Whether the flow around a state runs top to bottom or bottom to top.
    let across = |i: usize, logical: &[i32], views: &[View<'_>]| -> bool {
        let dir = if logical[i] == -1 { root_dir } else { inner_dir(logical[i] as usize, views) };
        dir.is_vertical()
    };

    let mut degree = vec![0i32; states];
    let mut noted = vec![false; states];
    // When each state first takes part in a transition. Layout follows this order rather than
    // the order of declaration, so a state declared up front does not become the top of the flow.
    let mut appear = vec![AppearOrder::Never; states];
    let mut appeared = 0usize;
    let mut counts = vec![0i32; 2 * states];
    for edge in &graph.edges {
        let (Some(&src), Some(&dst)) = (index.get(edge.start.as_str()), index.get(edge.end.as_str())) else {
            continue;
        };
        if edge.pattern == Some(EdgePattern::Dashed) {
            let target = if views[src].kind == RenderKind::Note { dst } else { src };
            noted[target] = true;
            continue;
        }
        counts[2 * src] += 1;
        degree[src] = degree[src].max(counts[2 * src]);
        counts[2 * dst + 1] += 1;
        degree[dst] = degree[dst].max(counts[2 * dst + 1]);
        if appear[src] == AppearOrder::Never {
            appear[src] = AppearOrder::At(appeared);
            appeared += 1;
        }
        if appear[dst] == AppearOrder::Never {
            appear[dst] = AppearOrder::At(appeared);
            appeared += 1;
        }
    }

    for i in 0..states {
        let node = views[i].node.expect("state view has node");
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
        let font_size = style.font_size.unwrap_or(size);
        let is_across = across(i, &logical, &views);
        let kind = views[i].kind;
        let comp_dir = inner_dir(i, &views);

        let view = &mut views[i];
        view.style = Some(style);
        let mut c_opt: Option<CNode> = None;
        match kind {
            RenderKind::Composite => {
                view.label = text(node.label.as_deref(), font_size, 4000.0, text_style);
                view.title_h = if view.label.height > 0.0 { view.label.height + 12.0 } else { 0.0 };
                let mut g = group_cnode(comp_dir, GROUP_PAD, view.title_h + GROUP_PAD, GROUP_PAD);
                g.min_w = view.label.width + 2.0 * GROUP_PAD;
                c_opt = Some(g);
            }
            RenderKind::Region => {
                c_opt = Some(group_cnode(comp_dir, REGION_PAD, REGION_PAD, REGION_PAD));
            }
            RenderKind::Start => {
                view.w = 14.0;
                view.h = 14.0;
            }
            RenderKind::End => {
                view.w = 18.0;
                view.h = 18.0;
            }
            RenderKind::Choice => {
                view.w = 30.0;
                view.h = 30.0;
            }
            RenderKind::Fork | RenderKind::Join => {
                let length = (40.0 * degree[i] as f64 + 16.0).clamp(72.0, 320.0);
                view.w = if is_across { length } else { BAR };
                view.h = if is_across { BAR } else { length };
            }
            RenderKind::Hidden => {}
            RenderKind::Note => {
                view.label = text(node.label.as_deref(), small, wrap_width.max(NOTE_WRAP), TextStyle::NONE);
                view.w = view.label.width + 24.0;
                view.h = view.label.height + 16.0;
            }
            RenderKind::State | RenderKind::Described => {
                view.label = text(node.label.as_deref(), font_size, wrap_width, text_style);
                let mut width = view.label.width;
                let mut height = view.label.height + 2.0 * PAD_Y;
                if kind == RenderKind::Described {
                    height += 14.0;
                    for line in &node.description {
                        let raw = if line.is_empty() { " " } else { line.as_str() };
                        let label = text(Some(raw), small, wrap_width, text_style);
                        if label.width > width {
                            width = label.width;
                        }
                        height += label.height;
                        view.lines.push(label);
                    }
                }
                view.w = (width + 2.0 * PAD_X).max(56.0);
                view.h = height;
            }
        }
        let mut c = c_opt.unwrap_or_else(|| cnode(view.w, view.h, -1));
        // The transitions on one side of a state's box spread along it, clear of its corners.
        if matches!(kind, RenderKind::State | RenderKind::Described) {
            c.span = (if is_across { view.w } else { view.h }) - 24.0;
        }
        cnodes.push(c);
    }

    let mut cedges: Vec<CEdge> = Vec::with_capacity(graph.edges.len());
    let mut edge_labels: Vec<Label> = Vec::with_capacity(graph.edges.len());
    let mut drawn: Vec<&StateEdge> = Vec::with_capacity(graph.edges.len());
    let mut loop_count = vec![0usize; states];
    let mut loop_width = vec![0.0f64; states];
    let mut loop_height = vec![0.0f64; states];

    // A transition between a composite and a state inside it runs between that state and a point
    // just inside the composite, and is then drawn on to the composite's border.
    let mut anchors: HashMap<usize, usize> = HashMap::new();
    let encloses = |composite: usize, item: usize, cnodes: &[CNode], logical: &[i32]| -> bool {
        if !cnodes[composite].is_group {
            return false;
        }
        let mut p = logical[item];
        while p != -1 {
            if p as usize == composite {
                return true;
            }
            p = logical[p as usize];
        }
        false
    };

    for edge in &graph.edges {
        let (Some(&raw_src), Some(&raw_dst)) = (index.get(edge.start.as_str()), index.get(edge.end.as_str())) else {
            continue;
        };
        let mut src = raw_src;
        let mut dst = raw_dst;
        let label = text(Some(edge.label.as_str()), small, wrap_width, TextStyle::NONE);
        let label_w = if label.width > 0.0 { label.width + 12.0 } else { 0.0 };
        let label_h = if label.height > 0.0 { label.height + 4.0 } else { 0.0 };
        if src == dst {
            loop_count[src] += 1;
            loop_width[src] = loop_width[src].max(label_w);
            loop_height[src] += label.height;
        } else if encloses(src, dst, &cnodes, &logical) {
            anchors.insert(cedges.len(), src);
            appear.push(AppearOrder::First);
            let idx = views.len();
            views.push(View {
                node: None,
                kind: RenderKind::Hidden,
                style: None,
                label: Label::empty(),
                lines: Vec::new(),
                w: 0.0,
                h: 0.0,
                title_h: 0.0,
            });
            cnodes.push(cnode(0.0, 0.0, src as i32));
            src = idx;
        } else if encloses(dst, src, &cnodes, &logical) {
            anchors.insert(cedges.len(), dst);
            appear.push(AppearOrder::Never);
            let idx = views.len();
            views.push(View {
                node: None,
                kind: RenderKind::Hidden,
                style: None,
                label: Label::empty(),
                lines: Vec::new(),
                w: 0.0,
                h: 0.0,
                title_h: 0.0,
            });
            cnodes.push(cnode(0.0, 0.0, dst as i32));
            dst = idx;
        }
        drawn.push(edge);
        edge_labels.push(label);
        cedges.push(cedge(src, dst, 1, label_w, label_h));
    }

    // A state with notes, or a composite with self-transitions, sits in an unseen group of its
    // own: the notes go beside the state, across the flow, without disturbing its transitions.
    for i in 0..states {
        if owners[i] != -1 {
            continue;
        }
        let is_across = across(i, &logical, &views);
        let mut room = 0.0;
        if loop_count[i] > 0 {
            let reach = LOOP + (loop_count[i] - 1) as f64 * 8.0;
            room = if is_across {
                reach + loop_width[i]
            } else {
                reach * 0.75 + 4.0 + loop_height[i]
            };
            if !cnodes[i].is_group {
                if is_across {
                    cnodes[i].w += 2.0 * room;
                    cnodes[i].h = cnodes[i].h.max(loop_height[i]);
                } else {
                    cnodes[i].h += 2.0 * room;
                    cnodes[i].w = cnodes[i].w.max(loop_width[i]);
                }
                room = 0.0;
            }
        }
        if !noted[i] && room == 0.0 {
            cnodes[i].parent = logical[i];
            continue;
        }
        let mut c = if is_across {
            group_cnode(Dir::LR, room, 0.0, 0.0)
        } else {
            group_cnode(Dir::TB, 0.0, room, room)
        };
        c.parent = logical[i];
        appear.push(appear[i]);
        let idx = views.len();
        views.push(View {
            node: None,
            kind: RenderKind::Hidden,
            style: None,
            label: Label::empty(),
            lines: Vec::new(),
            w: 0.0,
            h: 0.0,
            title_h: 0.0,
        });
        cnodes.push(c);
        cnodes[i].parent = idx as i32;
    }
    for i in 0..states {
        if owners[i] != -1 {
            cnodes[i].parent = cnodes[owners[i] as usize].parent;
        }
    }

    {
        // Numbers the tree so that, at every level, initial states come first and the rest follow
        // in the order the transitions introduce them.
        let mut members: Vec<Vec<usize>> = vec![Vec::new(); cnodes.len()];
        let mut top: Vec<usize> = Vec::new();
        for (i, c) in cnodes.iter().enumerate() {
            if c.parent >= 0 {
                members[c.parent as usize].push(i);
            } else {
                top.push(i);
            }
        }
        let by_flow = |&a: &usize, &b: &usize| -> Ordering {
            let init_a = u8::from(views[a].kind != RenderKind::Start);
            let init_b = u8::from(views[b].kind != RenderKind::Start);
            init_a.cmp(&init_b).then_with(|| appear[a].cmp(&appear[b])).then_with(|| a.cmp(&b))
        };
        let mut seq = 0usize;
        top.sort_by(by_flow);
        top.reverse();
        let mut pending = top;
        while let Some(i) = pending.pop() {
            cnodes[i].seq = seq;
            seq += 1;
            members[i].sort_by(by_flow);
            for &child in members[i].iter().rev() {
                pending.push(child);
            }
        }
    }

    let layout = compound_layout(
        &mut cnodes,
        &mut cedges,
        root_dir,
        &LayeredOptions {
            node_sep: number_option(ctx.config, "nodeSpacing", NODE_SEP),
            edge_sep: EDGE_SEP,
            rank_sep: number_option(ctx.config, "rankSpacing", RANK_SEP),
            port_sep: 20.0,
            tracks: matches!(curve, Some("step" | "stepBefore" | "stepAfter")),
            straight: curve == Some("linear"),
            apart: false,
            head_room: marker_trim("arrow_point"),
            groups: None,
            order_only: false,
        },
    );

    let width = (layout.width + 2.0 * pad).ceil();
    let height = (layout.height + 2.0 * pad).ceil();
    let mut links: Vec<LinkInfo> = Vec::new();

    // Route points by rounded y, to find the edges that cross a composite's title bar.
    let mut crossings: Crossings = HashMap::new();
    for e in &cedges {
        let route = &e.route;
        let mut k = 3usize;
        while k + 3 < route.len() {
            let key = route[k + 1].round() as i64;
            crossings.entry(key).or_default().push(route[k]);
            k += 3;
        }
    }

    let mut children: Vec<Vec<usize>> = vec![Vec::new(); cnodes.len()];
    let mut order: Vec<usize> = Vec::with_capacity(cnodes.len());
    for (i, c) in cnodes.iter().enumerate() {
        if c.parent >= 0 {
            children[c.parent as usize].push(i);
        } else {
            order.push(i);
        }
    }
    let roots = order.clone();
    let mut q = 0usize;
    while q < order.len() {
        let cur = order[q];
        q += 1;
        order.extend_from_slice(&children[cur]);
    }

    let mut clusters = String::new();
    let mut fills: Vec<Fill> = Vec::new();
    let mut dividers = String::new();
    let mut nodes_out = String::new();
    let mut notes_out = String::new();

    let divide = |items: &[usize], left: f64, top: f64, right: f64, bottom: f64, dividers: &mut String| {
        let regions: Vec<usize> = items.iter().copied().filter(|&i| views[i].kind == RenderKind::Region).collect();
        if regions.len() < 2 {
            return;
        }
        let lo = |i: usize, x: bool| -> f64 {
            if x {
                cnodes[i].x - cnodes[i].w / 2.0
            } else {
                cnodes[i].y - cnodes[i].h / 2.0
            }
        };
        let hi = |i: usize, x: bool| -> f64 {
            if x {
                cnodes[i].x + cnodes[i].w / 2.0
            } else {
                cnodes[i].y + cnodes[i].h / 2.0
            }
        };
        for x in [true, false] {
            let mut sorted = regions.clone();
            sorted.sort_by(|&a, &b| lo(a, x).total_cmp(&lo(b, x)).then_with(|| a.cmp(&b)));
            let mut apart = true;
            for k in 1..sorted.len() {
                if hi(sorted[k - 1], x) > lo(sorted[k], x) + 0.5 {
                    apart = false;
                    break;
                }
            }
            if !apart {
                continue;
            }
            for k in 1..sorted.len() {
                let at = num((hi(sorted[k - 1], x) + lo(sorted[k], x)) / 2.0 + pad);
                if x {
                    dividers.push_str(&format!(r#"<path class="pele-divider" d="M{at},{}V{}"/>"#, num(top), num(bottom)));
                } else {
                    dividers.push_str(&format!(r#"<path class="pele-divider" d="M{},{at}H{}"/>"#, num(left), num(right)));
                }
            }
            return;
        }
        // Regions that sit neither side by side nor in a stack each get an outline.
        for i in regions {
            let c = &cnodes[i];
            dividers.push_str(&rect_svg(
                c.x - c.w / 2.0 + pad,
                c.y - c.h / 2.0 + pad,
                c.w,
                c.h,
                &format!(r#" class="pele-divider" rx="{}""#, num(CORNER)),
            ));
        }
    };
    divide(&roots, pad / 2.0, pad / 2.0, width - pad / 2.0, height - pad / 2.0, &mut dividers);

    for &i in &order {
        let view = &views[i];
        let (Some(node), Some(style)) = (view.node, view.style.as_ref()) else {
            continue;
        };
        let c = &cnodes[i];
        let x = c.x + pad;
        let y = c.y + pad;
        let w = view.w;
        let h = view.h;
        let ink = ink_fill(&style.shape, &style.text, ctx.theme, None);
        let label_attrs = format!(r#" class="pele-label"{ink}{}"#, style.text);

        let mut body = match view.kind {
            RenderKind::Composite => {
                let left = x - c.w / 2.0;
                let top = y - c.h / 2.0;
                if paints(&style.shape) {
                    fills.push(Fill {
                        bounds: [left, top, left + c.w, top + c.h],
                        shape: style.shape.clone(),
                    });
                }
                let fill_opacity = if sets_fill(&style.shape) { "" } else { r#" fill-opacity="0.5""# };
                let mut out = rect_svg(
                    left,
                    top,
                    c.w,
                    c.h,
                    &format!(
                        r#" rx="{}" fill="{}"{fill_opacity} stroke="{}"{}"#,
                        num(CORNER),
                        ctx.theme.surface_alt(),
                        ctx.theme.border(),
                        style.shape,
                    ),
                );
                if view.title_h > 0.0 {
                    out.push_str(&format!(
                        r#"<path d="M{},{}H{}"{rule_attrs}{}/>"#,
                        num(left),
                        num(top + view.title_h),
                        num(left + c.w),
                        style.line,
                    ));
                    out.push_str(&label_svg(
                        &view.label,
                        title_x(c, view.label.width, &crossings) + pad,
                        top + view.title_h / 2.0,
                        &format!(r#" class="pele-cluster-label"{ink}{}"#, style.text),
                        ctx.theme,
                        ctx.icons,
                    ));
                }
                divide(&children[i], left, top + view.title_h, left + c.w, top + c.h, &mut dividers);
                out
            }
            RenderKind::Start => {
                format!(r#"<circle r="7" fill="{}"{}/>"#, ctx.theme.line(), style.shape)
            }
            RenderKind::End => {
                format!(
                    r#"<circle r="8.5" fill="{}" stroke="{}"{}/><circle r="5" fill="{}"{}/>"#,
                    ctx.theme.bg(),
                    ctx.theme.line(),
                    style.line,
                    ctx.theme.line(),
                    style.shape,
                )
            }
            RenderKind::Choice => {
                format!(
                    r#"<polygon points="0,{} {},0 0,{} {},0"{surface_attrs}{}/>"#,
                    num(-h / 2.0),
                    num(w / 2.0),
                    num(h / 2.0),
                    num(-w / 2.0),
                    style.shape,
                )
            }
            RenderKind::Fork | RenderKind::Join => rect_svg(-w / 2.0, -h / 2.0, w, h, &format!(r#" rx="2" fill="{}"{}"#, ctx.theme.line(), style.shape)),
            RenderKind::Note => {
                let r = num(w / 2.0);
                let b = num(h / 2.0);
                let fold = num(w / 2.0 - FOLD);
                let corner = num(FOLD - h / 2.0);
                format!(
                    r#"<path d="M-{r},-{b}H{fold}L{r},{corner}V{b}H-{r}Z" fill="{}" stroke="{}"/><path d="M{fold},-{b}V{corner}H{r}"{rule_attrs}/>{}"#,
                    ctx.theme.bg(),
                    ctx.theme.border(),
                    label_svg(
                        &view.label,
                        0.0,
                        0.0,
                        &format!(r#" class="pele-label" font-size="{}" fill="{}""#, num(small), ctx.theme.muted()),
                        ctx.theme,
                        ctx.icons,
                    ),
                )
            }
            RenderKind::State => {
                let mut out = rect_svg(
                    -w / 2.0,
                    -h / 2.0,
                    w,
                    h,
                    &format!(r#" rx="{}"{surface_attrs}{}"#, num(CORNER.min(h / 2.0)), style.shape),
                );
                out.push_str(&label_svg(&view.label, 0.0, 0.0, &label_attrs, ctx.theme, ctx.icons));
                out
            }
            RenderKind::Described => {
                let mut out = rect_svg(
                    -w / 2.0,
                    -h / 2.0,
                    w,
                    h,
                    &format!(r#" rx="{}"{surface_attrs}{}"#, num(CORNER.min(h / 2.0)), style.shape),
                );
                let mut at = PAD_Y - h / 2.0 + view.label.height;
                out.push_str(&format!(
                    r#"<path d="M{},{}H{}"{rule_attrs}{}/>"#,
                    num(-w / 2.0),
                    num(at + 6.0),
                    num(w / 2.0),
                    style.line,
                ));
                out.push_str(&label_svg(&view.label, 0.0, at - view.label.height / 2.0, &label_attrs, ctx.theme, ctx.icons));
                at += 14.0;
                let desc_attrs = format!(r#" class="pele-state-description" font-size="{}"{ink}{}"#, num(small), style.text);
                for line in &view.lines {
                    out.push_str(&label_svg(line, 0.0, at + line.height / 2.0, &desc_attrs, ctx.theme, ctx.icons));
                    at += line.height;
                }
                out
            }
            RenderKind::Region | RenderKind::Hidden => continue,
        };

        if let Some(link) = db.links.get(&node.id) {
            // Entity codes are resolved first, so the URL is checked in the form a browser would follow.
            let tooltip = decode_entities(unquote(&link.tooltip));
            if !tooltip.is_empty() {
                body = format!("<title>{}</title>{body}", esc(&tooltip));
            }
            let safe = safe_url(unquote(&link.url));
            body = linked(&body, &safe, &node.id, &mut links, ctx.options, r#" target="_blank""#);
        }

        let extra_classes = class_names(&strip_mermaid_classes(&node.css_classes));
        let open = format!(r#"<g class="{}{extra_classes}" data-id="{}""#, view.kind.class_name(), esc_text(&node.id));
        match view.kind {
            RenderKind::Composite => clusters.push_str(&format!("{open}>{body}</g>")),
            RenderKind::Note => notes_out.push_str(&format!(r#"{open} transform="translate({},{})">{body}</g>"#, num(x), num(y))),
            RenderKind::State | RenderKind::Described | RenderKind::Start | RenderKind::End | RenderKind::Choice | RenderKind::Fork | RenderKind::Join => {
                nodes_out.push_str(&format!(r#"{open} transform="translate({},{})">{body}</g>"#, num(x), num(y)))
            }
            RenderKind::Region | RenderKind::Hidden => {}
        }
    }

    // Moves a route end from the layout box onto the drawn shape, and spreads the ends along a bar.
    let attach = |route: &mut [f64], at: usize, i: usize| {
        let c = &cnodes[i];
        if c.is_group {
            return;
        }
        let view = &views[i];
        let bar = matches!(view.kind, RenderKind::Fork | RenderKind::Join);
        let other = if at == 0 { 3 } else { at - 3 };
        // 0 is the x axis and 1 the y axis; the end sits on a side that faces along `axis`.
        for axis in [1usize, 0usize] {
            let extent = if axis == 1 { c.h } else { c.w };
            let drawn_extent = if axis == 1 { view.h } else { view.w };
            let breadth = if axis == 1 { view.w } else { view.h };
            let center = (if axis == 1 { c.y } else { c.x }) + pad;
            let cross = (if axis == 1 { c.x } else { c.y }) + pad;
            let delta = route[at + axis] - center;
            if (delta.abs() - extent / 2.0).abs() >= 0.5 {
                continue;
            }
            route[at + axis] -= (sign_zero(delta) * (extent - drawn_extent)) / 2.0;
            if bar && breadth > drawn_extent {
                route[at + 1 - axis] = route[other + 1 - axis].clamp(cross - breadth / 2.0 + 6.0, cross + breadth / 2.0 - 6.0);
            }
            return;
        }
    };

    let mut reach = SideReach::default();
    for (i, ce) in cedges.iter().enumerate() {
        if ce.src == ce.dst || ce.route.len() < 6 || drawn[i].pattern == Some(EdgePattern::Dashed) {
            continue;
        }
        reach.add(ce.dst, end_side(&ce.route, ce.route.len() - 3, &cnodes[ce.dst]), "arrow_point");
    }

    let mut casings = String::new();
    let mut edges_out = String::new();
    let mut labels_out = String::new();
    let mut loop_seen = vec![0usize; states];
    let mut loop_text = vec![0.0f64; states];

    for (i, ce) in cedges.iter_mut().enumerate() {
        let edge = drawn[i];
        let label = &edge_labels[i];
        let note = edge.pattern == Some(EdgePattern::Dashed);
        let end_type = if note { "none" } else { "arrow_point" };
        let path: EdgePath = if ce.src == ce.dst {
            let a = &cnodes[ce.src];
            let view = &views[ce.src];
            let k = loop_seen[ce.src];
            loop_seen[ce.src] += 1;
            // The loop hangs off a side the flow does not use: the right, or below when the flow is horizontal.
            let side = across(ce.src, &logical, &views);
            let w = if a.is_group { a.w } else { view.w };
            let h = if a.is_group { a.h } else { view.h };
            let out = (if side { w } else { h }) / 2.0;
            let spread = ((if side { h } else { w }) / 2.0 - 4.0).min(8.0 + k as f64 * 6.0).max(2.0);
            let loop_reach = LOOP + k as f64 * 8.0;
            let hypot = loop_reach.hypot(spread);
            let trim = marker_trim(end_type) / if hypot == 0.0 { 1.0 } else { hypot };
            // Offsets are given for a loop on the right and turned a quarter for one below.
            let px = |dx: f64, dy: f64| -> f64 { a.x + pad + if side { out + dx } else { -dy } };
            let py = |dx: f64, dy: f64| -> f64 { a.y + pad + if side { dy } else { out + dx } };
            let at = |dx: f64, dy: f64| -> String { format!("{},{}", num(px(dx, dy)), num(py(dx, dy))) };
            let mut edx = px(-loop_reach, -spread) - px(0.0, 0.0);
            let mut edy = py(-loop_reach, -spread) - py(0.0, 0.0);
            let len = edx.hypot(edy);
            let len = if len == 0.0 { 1.0 } else { len };
            edx /= len;
            edy /= len;
            // Labels stack beyond the outermost loop, in the order of their transitions.
            let furthest = LOOP + (loop_count[ce.src] - 1) as f64 * 8.0;
            let below = loop_text[ce.src] + label.height / 2.0;
            loop_text[ce.src] += label.height;
            ce.label_x = if side { a.x + out + furthest + 4.0 + ce.label_w / 2.0 } else { a.x };
            ce.label_y = if side {
                a.y - loop_height[ce.src] / 2.0 + below
            } else {
                a.y + out + furthest * 0.75 + 4.0 + below
            };
            EdgePath {
                d: format!(
                    "M{}C{} {} {}",
                    at(0.0, -spread),
                    at(loop_reach, -2.0 * spread),
                    at(loop_reach, 2.0 * spread),
                    at(loop_reach * trim, spread + spread * trim),
                ),
                tokens: None,
                sx: 0.0,
                sy: 0.0,
                sdx: 0.0,
                sdy: 0.0,
                ex: px(0.0, spread),
                ey: py(0.0, spread),
                edx,
                edy,
            }
        } else {
            let mut route = ce.route.clone();
            if route.len() < 6 {
                continue;
            }
            let leaves = reach.of(ce.src, end_side(&route, 0, &cnodes[ce.src]));
            let arrives = reach.of(ce.dst, end_side(&route, route.len() - 3, &cnodes[ce.dst]));
            let mut k = 0usize;
            while k + 1 < route.len() {
                route[k] += pad;
                route[k + 1] += pad;
                k += 3;
            }
            attach(&mut route, 0, ce.src);
            let last_idx = route.len() - 3;
            attach(&mut route, last_idx, ce.dst);
            if let Some(&composite) = anchors.get(&i)
                && route.len() >= 6
            {
                let g = &cnodes[composite];
                let inward = views[ce.src].kind == RenderKind::Hidden;
                let at = if inward { 0 } else { route.len() - 3 };
                let g_dir = g.dir.unwrap_or(Dir::TB);
                let near = matches!(g_dir, Dir::TB | Dir::LR) == inward;
                let point = if g_dir.is_vertical() {
                    [route[at], g.y + pad + if near { views[composite].title_h - g.h / 2.0 } else { g.h / 2.0 }, 0.0]
                } else {
                    [g.x + pad + if near { -g.w / 2.0 } else { g.w / 2.0 }, route[at + 1], 1.0]
                };
                if inward {
                    let mut next_route = Vec::with_capacity(route.len() + 3);
                    next_route.extend_from_slice(&point);
                    next_route.extend_from_slice(&route);
                    route = next_route;
                } else {
                    route.extend_from_slice(&point);
                }
            }
            route_path(&route, curve, 0.0, marker_trim(end_type), Some(leaves), Some(arrives))
        };

        let over = over_fills(&path.d, &[path.ex, path.ey], &fills, "", path.tokens.as_deref(), ctx.theme);
        let (marker_color, kind_attr) = match over {
            OverFill::Ink(color) => {
                let attr = if note {
                    format!(r#"pele-note-edge" stroke="{color}" stroke-dasharray="3 4"#)
                } else {
                    format!(r#"pele-transition" stroke="{color}"#)
                };
                (color, attr)
            }
            OverFill::Casing => {
                casings.push_str(&edge_casing(&path, "none", end_type, "", false, ctx.theme));
                let attr = if note {
                    format!(r#"pele-note-edge" stroke="{}" stroke-dasharray="3 4"#, ctx.theme.border())
                } else {
                    "pele-transition".to_string()
                };
                (ctx.theme.line().to_string(), attr)
            }
            OverFill::None => {
                let attr = if note {
                    format!(r#"pele-note-edge" stroke="{}" stroke-dasharray="3 4"#, ctx.theme.border())
                } else {
                    "pele-transition".to_string()
                };
                (ctx.theme.line().to_string(), attr)
            }
        };
        edges_out.push_str(&format!(
            r#"<g class="pele-edge {kind_attr}" data-id="{}"><path d="{}"/>{}</g>"#,
            esc_text(&edge.id),
            path.d,
            marker(end_type, path.ex, path.ey, path.edx, path.edy, &marker_color, ctx.theme.bg()),
        ));
        if label.width > 0.0 {
            let lx = ce.label_x + pad;
            let ly = ce.label_y + pad;
            labels_out.push_str(&edge_label_svg(&edge.id, label, lx, ly, "", ctx.theme, ctx.icons));
        }
    }

    let mut content = String::new();
    if !clusters.is_empty() {
        content.push_str(&format!(r#"<g class="pele-clusters">{clusters}</g>"#));
    }
    if !dividers.is_empty() {
        content.push_str(&format!(r#"<g class="pele-dividers" stroke-dasharray="4 4"{rule_attrs}>{dividers}</g>"#));
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
    content.push_str(&format!(r#"<g class="pele-nodes">{nodes_out}{notes_out}</g>"#));

    let titled = with_title(db.title.as_deref(), ctx.measurer, size, pad, width, height, content, ctx.theme);
    let svg = svg_document(
        "state",
        titled.width,
        titled.height,
        size,
        ctx.options,
        ctx.responsive,
        ctx.theme,
        ctx.palette,
        Accessible {
            acc_title: db.acc_title.as_deref(),
            acc_descr: db.acc_descr.as_deref(),
        },
        &titled.content,
    );

    Rendered {
        svg,
        width: titled.width,
        height: titled.height,
        links,
    }
}

/// Picks where a composite's title sits in its title bar so edges entering from above do not cross it.
fn title_x(c: &CNode, width: f64, crossings: &Crossings) -> f64 {
    if width == 0.0 {
        return c.x;
    }
    let Some(xs) = crossings.get(&((c.y - c.h / 2.0).round() as i64)) else {
        return c.x;
    };
    let left = c.x - c.w / 2.0;
    let half = width / 2.0;
    let mut best = c.x;
    let mut best_gap = -1.0;
    for x in [c.x, left + GROUP_PAD + half, left + c.w - GROUP_PAD - half] {
        let mut gap = f64::INFINITY;
        for &cx in xs {
            if cx > left && cx < left + c.w {
                gap = gap.min((cx - x).abs() - half);
            }
        }
        if gap >= 6.0 {
            return x;
        }
        if gap > best_gap + 0.5 {
            best_gap = gap;
            best = x;
        }
    }
    best
}
