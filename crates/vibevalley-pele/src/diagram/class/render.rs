use std::collections::HashMap;

use indexmap::IndexMap;

use crate::diagram::RenderContext;
use crate::diagram::common::{parse_generic_types, runs_across, tighten, turn_to_fit};
use crate::layout::components::wrap_components;
use crate::layout::compound::{CEdge, CNode, Dir, cedge, cnode, compound_layout, direction};
use crate::layout::layered::LayeredOptions;
use crate::measure::{TextMeasurer, TextStyle};
use crate::svg::builder::{esc, esc_text, label_svg, num};
use crate::svg::cluster::{Crossings, cluster_title_x, mark_crossings, struck_title, title_crossed};
use crate::svg::edges::{EdgePath, edge_label_svg, route_path};
use crate::svg::ink::ink_fill;
use crate::svg::root::{Accessible, svg_document};
use crate::svg::shapes::end_side;
use crate::svg::theme::{ResolvedStyle, class_names, resolve_style};
use crate::svg::title::with_title;
use crate::text::entities::decode_entities;
use crate::text::label::{Label, Span, layout_label};
use crate::util::chars::is_space_char;
use crate::util::url::linked;
use crate::util::yaml::YamlValue;
use crate::{LinkInfo, MonospacePart, Rendered};

use super::db::ClassDb;
use super::graph::{EdgePattern, GraphEdge, GraphNode, NodeShape, build_class_graph};
use super::markers::{class_marker, class_marker_trim};
use super::members::{ClassMember, Classifier};
use super::types::ClassNode;

const NODE_SEP: f64 = 40.0;
const EDGE_SEP: f64 = 16.0;
const RANK_SEP: f64 = 56.0;
const GROUP_PAD: f64 = 20.0;
const LOOP: f64 = 26.0;
const PAD_X: f64 = 12.0;
const TITLE_PAD: f64 = 8.0;
const SECTION_PAD: f64 = 6.0;
const EMPTY_SECTION: f64 = 10.0;
const MIN_WIDTH: f64 = 64.0;
const FOLD: f64 = 8.0;

fn number_option(section: Option<&IndexMap<String, YamlValue>>, key: &str, fallback: f64) -> f64 {
    match section.and_then(|s| s.get(key)).and_then(YamlValue::as_f64) {
        Some(v) if v > 0.0 => v.min(2000.0),
        _ => fallback,
    }
}

fn has_math_line(line: &[Span]) -> bool {
    line.iter().any(|s| s.math.is_some())
}

fn has_font_family_css(text_style: &str) -> bool {
    text_style.contains(r#""font-family:"#) || text_style.contains(";font-family:")
}

fn is_allowed_target(target: &str) -> bool {
    matches!(target, "_self" | "_blank" | "_parent" | "_top")
}

struct Line {
    text: String,
    width: f64,
    classifier: Classifier,
}

enum AnnotationItem {
    Plain(String),
    Math(Label),
}

struct View {
    node: GraphNode,
    style: ResolvedStyle,
    label: Label,
    w: f64,
    h: f64,
    loops: usize,
    annotations: Vec<AnnotationItem>,
    attributes: Vec<Line>,
    methods: Vec<Line>,
    title_h: f64,
    attributes_h: f64,
    font_size: f64,
}

#[derive(Clone, Copy)]
struct End {
    edge_idx: usize,
    at: usize,
    toward: f64,
    order: usize,
    room: f64,
    side: i32,
    /// Whether the text of this end goes on the right of, or below, its line.
    after: bool,
}

struct Card {
    text: String,
    math: Option<Label>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    parent: i32,
}

fn member_line(member: &ClassMember, measurer: &dyn TextMeasurer, size: f64, mono: bool) -> Line {
    let decoded = decode_entities(&member.get_display_details().display_text);
    let text = decoded.trim_matches(is_space_char).to_string();
    let mut style = TextStyle::NONE;
    if member.classifier == Classifier::Abstract {
        style |= TextStyle::ITALIC;
    }
    if mono {
        style |= TextStyle::MONO;
    }
    let width = measurer.width(&text, size, style);
    Line {
        text,
        width,
        classifier: member.classifier,
    }
}

pub fn render_class(db: &ClassDb, ctx: &RenderContext<'_>) -> Rendered {
    let fitted = |down: bool| -> Rendered { tighten(ctx.options, |tight| draw(db, ctx, down, tight)) };
    if runs_across(Some(&db.direction)) {
        turn_to_fit(ctx.options, fitted)
    } else {
        fitted(false)
    }
}

/// `turned` draws a horizontal diagram top-to-bottom. `tight` drops the extra namespace title room.
fn draw(db: &ClassDb, ctx: &RenderContext<'_>, turned: bool, tight: bool) -> Rendered {
    let conf = ctx.config.section("class");
    let hierarchical = conf.and_then(|c| c.get("hierarchicalNamespaces")).and_then(YamlValue::as_bool) != Some(false);
    let hide_empty = conf.and_then(|c| c.get("hideEmptyMembersBox")).and_then(YamlValue::as_bool) == Some(true);
    let graph = build_class_graph(db, hierarchical);

    let monospaced = ctx.options.monospace.contains(&MonospacePart::Members);
    let mono = |style: &ResolvedStyle| -> bool { monospaced && !has_font_family_css(&style.text) };
    let size = ctx.options.font_size.unwrap_or(16.0);
    let small = (size * 0.875).round();
    let tiny = (size * 0.8).round();
    let tiny_height = (tiny * 1.4).round();
    let pad = ctx.options.padding.unwrap_or(8.0);

    // Keep annotations and cardinalities literal unless math is typeset.
    let math_text = |raw: &str, font_size: f64| -> Option<Label> {
        if !raw.contains("$$") {
            return None;
        }
        let label = layout_label(Some(raw), false, ctx.measurer, font_size, 4000.0, TextStyle::NONE, ctx.icons, ctx.math);
        label.lines.iter().any(|line| has_math_line(line)).then_some(label)
    };
    let card_width = |raw: &str| -> f64 {
        if raw.is_empty() {
            0.0
        } else if let Some(m) = math_text(raw, tiny) {
            m.width
        } else {
            ctx.measurer.width(&decode_entities(raw), tiny, TextStyle::NONE)
        }
    };
    let root_dir = if turned { Dir::TB } else { direction(Some(&db.direction)) };

    // A class may carry the declarations of many classDefs many times over. Each distinct
    // declaration is checked once, and only the last value of each effective property is kept.
    let mut effect: HashMap<String, String> = HashMap::new();
    let mut from_defs: HashMap<String, Vec<(String, String)>> = HashMap::new();
    let mut kept: IndexMap<String, String> = IndexMap::new();

    let keep = |decl: &str, effect: &mut HashMap<String, String>, kept: &mut IndexMap<String, String>| {
        let prop = match effect.get(decl) {
            Some(p) => p.clone(),
            None => {
                let one = resolve_style(&[decl.to_string()]);
                let p = if one.shape.is_empty() && one.text.is_empty() {
                    String::new()
                } else {
                    let colon = decl.find(':').unwrap_or(0);
                    decl[..colon].trim().to_ascii_lowercase()
                };
                effect.insert(decl.to_string(), p.clone());
                p
            }
        };
        if !prop.is_empty() {
            kept.insert(prop, decl.to_string());
        }
    };

    let mut class_style = |cls: &ClassNode| -> ResolvedStyle {
        kept.clear();
        if let Some(base) = from_defs.get(&cls.css_classes) {
            for (prop, decl) in base {
                kept.insert(prop.clone(), decl.clone());
            }
        } else {
            for name in cls.css_classes.split(' ') {
                if let Some(def) = db.style_classes.get(name) {
                    for s in &def.styles {
                        for part in s.split(',') {
                            keep(part, &mut effect, &mut kept);
                        }
                    }
                }
            }
            let snapshot: Vec<(String, String)> = kept.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            from_defs.insert(cls.css_classes.clone(), snapshot);
        }
        for s in &cls.styles {
            keep(s, &mut effect, &mut kept);
        }
        if kept.is_empty() {
            ResolvedStyle::default()
        } else {
            let decls: Vec<String> = kept.values().cloned().collect();
            resolve_style(&decls)
        }
    };

    let mut children = vec![0i32; graph.nodes.len()];
    for node in &graph.nodes {
        if node.parent >= 0 {
            children[node.parent as usize] += 1;
        }
    }

    // Namespaces that an edge may cross into are widened so the title fits beside it.
    let mut crossed = vec![false; graph.nodes.len()];
    for edge in &graph.edges {
        if edge.source < 0 || edge.target < 0 {
            continue;
        }
        let a = graph.nodes[edge.source as usize].parent;
        let b = graph.nodes[edge.target as usize].parent;
        if a == b {
            continue;
        }
        let mut g = a;
        while g >= 0 && !crossed[g as usize] {
            crossed[g as usize] = true;
            g = graph.nodes[g as usize].parent;
        }
        let mut g = b;
        while g >= 0 && !crossed[g as usize] {
            crossed[g as usize] = true;
            g = graph.nodes[g as usize].parent;
        }
    }

    let make_base = |node: GraphNode, label: Label, w: f64, h: f64, font_size: f64| -> View {
        View {
            node,
            style: ResolvedStyle::default(),
            label,
            w,
            h,
            loops: 0,
            annotations: Vec::new(),
            attributes: Vec::new(),
            methods: Vec::new(),
            title_h: 0.0,
            attributes_h: 0.0,
            font_size,
        }
    };

    let mut views: Vec<View> = Vec::with_capacity(graph.nodes.len());
    let mut cnodes: Vec<CNode> = Vec::with_capacity(graph.nodes.len());
    for (i, node) in graph.nodes.into_iter().enumerate() {
        let parent = node.parent;
        let (view, mut c) = if node.is_group {
            let label = layout_label(Some(&node.label), false, ctx.measurer, size, 4000.0, TextStyle::NONE, ctx.icons, ctx.math);
            if children[i] > 0 {
                let mut c = cnode(0.0, 0.0, -1);
                c.is_group = true;
                c.pad_x = GROUP_PAD;
                c.pad_top = if label.height > 0.0 { label.height + 16.0 } else { GROUP_PAD };
                c.pad_bottom = GROUP_PAD;
                c.min_w = label.width + 2.0 * GROUP_PAD - 12.0 + if crossed[i] && !tight { (label.width + 24.0).min(240.0) } else { 0.0 };
                (make_base(node, label, 0.0, 0.0, size), c)
            } else {
                let w = (label.width + 2.0 * GROUP_PAD).max(80.0);
                let h = label.height + 2.0 * GROUP_PAD;
                let c = cnode(w, h, -1);
                (make_base(node, label, w, h, size), c)
            }
        } else if let Some(cls) = node.class_node.clone() {
            let style = class_style(&cls);
            let font_size = style.font_size.unwrap_or(size);
            let member_size = (font_size * 0.875).round();
            let line_height = (member_size * 1.5).round();
            // Escape generic angle brackets so `<T>` is not parsed as HTML markup.
            let generic = if cls.generic_type.is_empty() {
                String::new()
            } else {
                let parsed = parse_generic_types(&cls.generic_type);
                let escaped = parsed.replace('<', "&lt;").replace('>', "&gt;");
                format!("&lt;{escaped}&gt;")
            };
            let title_text = format!("{}{generic}", cls.label);
            let mut title_style = TextStyle::BOLD;
            if style.italic {
                title_style |= TextStyle::ITALIC;
            }
            let label = layout_label(Some(&title_text), false, ctx.measurer, font_size, 4000.0, title_style, ctx.icons, ctx.math);
            let annotations: Vec<AnnotationItem> = cls
                .annotations
                .iter()
                .map(|a| {
                    let raw = format!("«{}»", a.trim_matches(is_space_char));
                    match math_text(&raw, tiny) {
                        Some(m) => AnnotationItem::Math(m),
                        None => AnnotationItem::Plain(format!("«{}»", decode_entities(a).trim_matches(is_space_char))),
                    }
                })
                .collect();
            let is_mono = mono(&style);
            let attributes: Vec<Line> = cls.members.iter().map(|m| member_line(m, ctx.measurer, member_size, is_mono)).collect();
            let methods: Vec<Line> = cls.methods.iter().map(|m| member_line(m, ctx.measurer, member_size, is_mono)).collect();

            let mut inner = label.width;
            let mut annotations_h = 0.0;
            for ann in &annotations {
                match ann {
                    AnnotationItem::Plain(text) => {
                        inner = inner.max(ctx.measurer.width(text, tiny, TextStyle::NONE));
                        annotations_h += tiny_height;
                    }
                    AnnotationItem::Math(lbl) => {
                        inner = inner.max(lbl.width);
                        annotations_h += tiny_height.max(lbl.height);
                    }
                }
            }
            for line in &attributes {
                inner = inner.max(line.width);
            }
            for line in &methods {
                inner = inner.max(line.width);
            }

            let sections = !(hide_empty && attributes.is_empty() && methods.is_empty());
            let section_h = |count: usize| -> f64 {
                if !sections {
                    0.0
                } else if count > 0 {
                    2.0 * SECTION_PAD + (count as f64) * line_height
                } else {
                    EMPTY_SECTION
                }
            };
            let title_h = 2.0 * TITLE_PAD + annotations_h + label.height.max((font_size * 1.5).round());
            let attributes_h = section_h(attributes.len());
            let w = (inner + 2.0 * PAD_X).max(MIN_WIDTH);
            let h = title_h + attributes_h + section_h(methods.len());
            let view = View {
                node,
                style,
                label,
                w,
                h,
                loops: 0,
                annotations,
                attributes,
                methods,
                title_h,
                attributes_h,
                font_size,
            };
            let c = cnode(w, h, -1);
            (view, c)
        } else {
            match node.shape {
                NodeShape::Note => {
                    let label = layout_label(Some(&node.label), true, ctx.measurer, small, 260.0, TextStyle::NONE, ctx.icons, ctx.math);
                    let w = (label.width + 2.0 * PAD_X).max(40.0);
                    let h = label.height + 2.0 * TITLE_PAD;
                    let c = cnode(w, h, -1);
                    (make_base(node, label, w, h, small), c)
                }
                NodeShape::Interface | NodeShape::Rect | NodeShape::ClassBox => {
                    let label = layout_label(Some(&node.label), false, ctx.measurer, small, 200.0, TextStyle::NONE, ctx.icons, ctx.math);
                    let w = label.width.max(12.0) + 4.0;
                    let h = label.height.max(12.0);
                    let c = cnode(w, h, -1);
                    (make_base(node, label, w, h, small), c)
                }
            }
        };
        c.parent = parent;
        c.seq = i;
        views.push(view);
        cnodes.push(c);
    }

    let mut cedges: Vec<CEdge> = Vec::new();
    let mut drawn: Vec<GraphEdge> = Vec::new();
    let mut edge_labels: Vec<Label> = Vec::new();
    let mut start_room: Vec<f64> = Vec::new();
    let mut end_room: Vec<f64> = Vec::new();
    let mut crowd = vec![0.0f64; views.len() * 4];
    let mut meet = |item: usize, slot: usize, room: f64| {
        crowd[item * 4 + slot] += 1.0;
        if room > crowd[item * 4 + slot + 1] {
            crowd[item * 4 + slot + 1] = room;
        }
    };

    for edge in graph.edges {
        if edge.source < 0 || edge.target < 0 {
            continue;
        }
        let src = edge.source as usize;
        let dst = edge.target as usize;
        let label = layout_label(edge.label.as_deref(), true, ctx.measurer, small, 200.0, TextStyle::NONE, ctx.icons, ctx.math);
        let start_w = card_width(&edge.start_label_right);
        let end_w = card_width(&edge.end_label_left);
        if src == dst {
            views[src].loops += 1;
            cnodes[src].w += 2.0 * (LOOP + if label.width > 0.0 { label.width + 12.0 } else { 0.0 });
        } else {
            meet(src, 0, start_w);
            meet(dst, 2, end_w);
        }
        let lw = if label.width > 0.0 { label.width + 12.0 } else { 0.0 };
        let lh = if label.height > 0.0 { label.height + 4.0 } else { 0.0 };
        start_room.push(start_w);
        end_room.push(end_w);
        drawn.push(edge);
        edge_labels.push(label);
        cedges.push(cedge(src, dst, 1, lw, lh));
    }

    if root_dir.is_vertical() {
        for i in 0..views.len() {
            if views[i].node.class_node.is_none() {
                continue;
            }
            let mut need = 0.0f64;
            for slot in [0usize, 2usize] {
                let count = crowd[i * 4 + slot];
                let room = crowd[i * 4 + slot + 1];
                if count > 1.0 {
                    need = need.max((count - 1.0) * if room > 0.0 { room + 24.0 } else { 14.0 } + 24.0);
                }
            }
            need = need.min(480.0);
            if need > views[i].w {
                cnodes[i].w += need - views[i].w;
                views[i].w = need;
            }
        }
    }

    let lettered = (0..drawn.len()).any(|i| start_room[i] > 0.0 || end_room[i] > 0.0);
    let mut tall_cards = 0.0f64;
    if root_dir.is_vertical() {
        let card_height = |raw: &str| -> f64 {
            if raw.is_empty() {
                0.0
            } else {
                tiny_height.max(math_text(raw, tiny).map_or(0.0, |m| m.height))
            }
        };
        for edge in &drawn {
            tall_cards = tall_cards.max(card_height(&edge.start_label_right) + card_height(&edge.end_label_left) - 2.0 * tiny_height);
        }
    }

    let opt = LayeredOptions {
        node_sep: number_option(conf, "nodeSpacing", NODE_SEP),
        edge_sep: EDGE_SEP,
        rank_sep: number_option(conf, "rankSpacing", if lettered { RANK_SEP + 16.0 } else { RANK_SEP }) + tall_cards,
        port_sep: 20.0,
        apart: true,
        ..LayeredOptions::default()
    };
    let layout = compound_layout(&mut cnodes, &mut cedges, root_dir, &opt);

    // Spread multiple edges sharing a side and pull cardinalities clear of neighboring edges.
    let mut sides: IndexMap<usize, Vec<End>> = IndexMap::new();
    let mut starts: Vec<Option<End>> = Vec::with_capacity(cedges.len());
    let mut ends: Vec<Option<End>> = Vec::with_capacity(cedges.len());

    let attach = |cedges: &mut [CEdge],
                  edge_idx: usize,
                  at: usize,
                  item: usize,
                  room: f64,
                  order: usize,
                  cnodes: &[CNode],
                  views: &[View],
                  sides: &mut IndexMap<usize, Vec<End>>|
     -> Option<End> {
        let route = &mut cedges[edge_idx].route;
        let c = &cnodes[item];
        let side = end_side(route, at, c);
        if side < 0 {
            return None;
        }
        let slack = (c.w - views[item].w) / 2.0;
        if side == 1 {
            route[at] -= slack;
        } else if side == 3 {
            route[at] += slack;
        }
        let across = (side & 1) as usize;
        let neighbor = if at == 0 { 3 } else { at - 3 };
        let toward = route[neighbor + across];
        let bend = toward - route[at + across];
        let end = End {
            edge_idx,
            at,
            toward,
            order,
            room,
            side,
            after: if across != 0 { bend > 0.0 } else { bend >= 0.0 },
        };
        let key = item * 4 + (side as usize);
        sides.entry(key).or_default().push(end);
        Some(end)
    };

    for i in 0..cedges.len() {
        let src = cedges[i].src;
        let dst = cedges[i].dst;
        let len = cedges[i].route.len();
        let routed = src != dst && len >= 6;
        let s = if routed {
            attach(&mut cedges, i, 0, src, start_room[i], i, &cnodes, &views, &mut sides)
        } else {
            None
        };
        let e = if routed {
            attach(&mut cedges, i, len - 3, dst, end_room[i], i, &cnodes, &views, &mut sides)
        } else {
            None
        };
        starts.push(s);
        ends.push(e);
    }

    let on_border = |item: usize, x: f64, y: f64| -> bool {
        let mut g = cnodes[item].parent;
        let mut hops = 0;
        while g >= 0 && hops < 10_000 {
            let c = &cnodes[g as usize];
            let dx = (x - c.x).abs();
            let dy = (y - c.y).abs();
            if ((dy - c.h / 2.0).abs() < 0.5 && dx <= c.w / 2.0 + 0.5) || ((dx - c.w / 2.0).abs() < 0.5 && dy <= c.h / 2.0 + 0.5) {
                return true;
            }
            g = c.parent;
            hops += 1;
        }
        false
    };

    let mut gaps: Vec<f64> = Vec::new();
    for (key, mut list) in sides {
        if list.len() < 2 {
            continue;
        }
        let item = key >> 2;
        let across = key & 1;
        let length = if across != 0 { views[item].h } else { views[item].w };
        list.sort_by(|a, b| a.toward.total_cmp(&b.toward).then_with(|| a.order.cmp(&b.order)));
        gaps.clear();
        let mut total = 0.0f64;
        for j in 0..list.len() - 1 {
            let a = list[j];
            let b = list[j + 1];
            let mut gap = if across != 0 { 20.0 } else { 24.0 };
            if a.room > 0.0 && a.after {
                gap += if across != 0 { tiny_height + 6.0 } else { a.room };
            }
            if b.room > 0.0 && !b.after {
                gap += if across != 0 { tiny_height + 6.0 } else { b.room };
            }
            gaps.push(gap);
            total += gap;
        }
        let scale = 1.0f64.min((length - 24.0) / total);
        if scale <= 0.0 {
            continue;
        }
        let mut at_pos = (if across != 0 { cnodes[item].y } else { cnodes[item].x }) - (total * scale) / 2.0;
        for j in 0..list.len() {
            let entry = list[j];
            let route = &mut cedges[entry.edge_idx].route;
            let end = entry.at as isize;
            let step: isize = if end == 0 { 3 } else { -3 };
            let first = end + step;
            let mut border: isize = -1;
            let mut k = first;
            while k >= 0 && (k as usize) < route.len() && (route[k as usize + across] - route[first as usize + across]).abs() < 0.5 {
                if on_border(item, route[k as usize], route[k as usize + 1]) {
                    border = k;
                    break;
                }
                k += step;
            }
            if border >= 0 && (route[first as usize + across] - at_pos).abs() <= 24.0 {
                let mut k = first;
                while k != border + step {
                    route[k as usize + across] = at_pos;
                    k += step;
                }
            }
            route[entry.at + across] = at_pos;
            if j < gaps.len() {
                at_pos += gaps[j] * scale;
            }
        }
    }

    let straighten = |route: &mut Vec<f64>, end: Option<End>, room: f64, first: bool| {
        let Some(end) = end else {
            return;
        };
        if room <= 0.0 {
            return;
        }
        let across = (end.side & 1) as usize;
        let at = if first { 0 } else { route.len() - 3 };
        let along = at + 1 - across;
        let neighbor = if first { 3 } else { at - 3 };
        let reach = (route[neighbor + 1 - across] - route[along]).abs();
        let length = (if across != 0 { room + 10.0 } else { tiny_height + 6.0 }).min(reach * 0.35);
        if length < 4.0 {
            return;
        }
        let mut point = [route[at], route[at + 1], route[at + 2]];
        let dir_sign = if end.side == 0 || end.side == 3 { -1.0 } else { 1.0 };
        point[1 - across] += dir_sign * length;
        let insert_at = if first { 3 } else { at };
        route.splice(insert_at..insert_at, point);
    };

    for i in 0..cedges.len() {
        straighten(&mut cedges[i].route, starts[i], start_room[i], true);
        straighten(&mut cedges[i].route, ends[i], end_room[i], false);
    }

    let mut min_x = 0.0f64;
    let mut min_y = 0.0f64;
    let mut max_x = layout.width;
    let mut max_y = layout.height;
    let mut cards: Vec<Card> = Vec::new();
    let mut add_card = |parent: i32, raw: &str, width: f64, x: f64, y: f64, side: i32, after: bool| {
        if raw.is_empty() {
            return;
        }
        let math = math_text(raw, tiny);
        let h = math.as_ref().map_or(tiny_height, |m| tiny_height.max(m.height));
        let mut cx = x;
        let mut cy = y;
        if (side & 1) != 0 {
            cx += if side == 3 { -1.0 } else { 1.0 } * (5.0 + width / 2.0);
            cy += if after { 1.0 } else { -1.0 } * (7.0 + h / 2.0);
        } else {
            cx += if after { 1.0 } else { -1.0 } * (9.0 + width / 2.0);
            cy += if side == 0 { -1.0 } else { 1.0 } * (3.0 + h / 2.0);
        }
        cards.push(Card {
            text: decode_entities(raw),
            math,
            x: cx,
            y: cy,
            w: width,
            h,
            parent,
        });
        min_x = min_x.min(cx - width / 2.0);
        max_x = max_x.max(cx + width / 2.0);
        min_y = min_y.min(cy - h / 2.0);
        max_y = max_y.max(cy + h / 2.0);
    };

    let mut loop_seen: HashMap<usize, usize> = HashMap::new();
    let mut loop_at = vec![0usize; cedges.len()];
    for i in 0..cedges.len() {
        let src = cedges[i].src;
        let dst = cedges[i].dst;
        if src == dst {
            let k = *loop_seen.get(&src).unwrap_or(&0);
            loop_seen.insert(src, k + 1);
            loop_at[i] = k;
            let c = &cnodes[src];
            let view = &views[src];
            let x = c.x + view.w / 2.0;
            let spread = (view.h / 2.0 - 4.0).min(8.0 + (k as f64) * 6.0);
            add_card(src as i32, &drawn[i].start_label_right, start_room[i], x, c.y - spread, 1, false);
            add_card(dst as i32, &drawn[i].end_label_left, end_room[i], x, c.y + spread, 1, true);
            cedges[i].label_x = c.x + view.w / 2.0 + LOOP + (k as f64) * 8.0 + 4.0 + cedges[i].label_w / 2.0;
            cedges[i].label_y = c.y;
        } else if cedges[i].route.len() >= 6 {
            let route = &cedges[i].route;
            let last = route.len() - 3;
            let from = starts[i];
            let to = ends[i];
            add_card(
                src as i32,
                &drawn[i].start_label_right,
                start_room[i],
                route[0],
                route[1],
                from.map_or(2, |e| e.side),
                from.is_none_or(|e| e.after),
            );
            add_card(
                dst as i32,
                &drawn[i].end_label_left,
                end_room[i],
                route[last],
                route[last + 1],
                to.map_or(0, |e| e.side),
                to.is_none_or(|e| e.after),
            );
        }
    }

    if let Some(available) = ctx.options.max_width
        && available > 0.0
        && max_x - min_x + 2.0 * pad > available
    {
        let node_count = cnodes.len();
        for item in &cards {
            let mut cn = cnode(item.w, item.h, item.parent);
            cn.x = item.x;
            cn.y = item.y;
            cnodes.push(cn);
        }
        let wrapped = wrap_components(
            &mut cnodes,
            &mut cedges,
            1.0f64.max(available - 2.0 * pad),
            number_option(conf, "nodeSpacing", NODE_SEP),
        );
        if let Some(res) = wrapped {
            for (idx, item) in cards.iter_mut().enumerate() {
                item.x = cnodes[node_count + idx].x;
                item.y = cnodes[node_count + idx].y;
            }
            min_x = 0.0;
            min_y = 0.0;
            max_x = res.width;
            max_y = res.height;
        }
        cnodes.truncate(node_count);
    }

    let ox = pad - min_x;
    let oy = pad - min_y;
    let width = (max_x - min_x + 2.0 * pad).ceil();
    let height = (max_y - min_y + 2.0 * pad).ceil();
    let mut links: Vec<LinkInfo> = Vec::new();

    let mut crossings: Crossings = HashMap::new();
    if !views.is_empty() && views[0].node.is_group {
        for e in &cedges {
            mark_crossings(&mut crossings, &e.route);
        }
    }

    let mut clusters = String::new();
    let mut struck_titles = String::new();
    let mut nodes_out = String::new();
    let rounded_standalone = ctx.theme.rounded_standalone();

    for i in 0..views.len() {
        let view = &views[i];
        let c = &cnodes[i];
        let node = &view.node;
        let x = c.x + ox;
        let y = c.y + oy;
        let id = esc_text(&node.id);
        let w = if c.is_group { c.w } else { view.w };
        let h = if c.is_group { c.h } else { view.h };

        if node.is_group {
            let title_x = if c.is_group {
                cluster_title_x(c, view.label.width, &crossings, GROUP_PAD)
            } else {
                c.x
            };
            let title_y = y - h / 2.0 + 8.0 + view.label.height / 2.0;
            let title_attrs = format!(r#" class="pele-cluster-label" fill="{}""#, ctx.theme.muted());
            let struck = c.is_group && title_crossed(c, view.label.width, title_x, &crossings);
            if struck {
                struck_titles.push_str(&struck_title(
                    &view.label,
                    title_x + ox,
                    title_y,
                    &title_attrs,
                    &id,
                    &cnodes,
                    i,
                    ctx.theme,
                    ctx.icons,
                ));
            }
            clusters.push_str(&format!(
                r#"<g class="pele-cluster pele-namespace" data-id="{id}"><rect x="{}" y="{}" width="{}" height="{}" fill="{}" fill-opacity="0.5" stroke="{}"{rounded_standalone}/>{}</g>"#,
                num(x - w / 2.0),
                num(y - h / 2.0),
                num(w),
                num(h),
                ctx.theme.surface_alt(),
                ctx.theme.border(),
                if struck {
                    String::new()
                } else {
                    label_svg(&view.label, title_x + ox, title_y, &title_attrs, ctx.theme, ctx.icons)
                }
            ));
            continue;
        }

        let at = format!(r#" transform="translate({},{})""#, num(x), num(y));
        if let Some(ref cls) = node.class_node {
            let left = -w / 2.0;
            let top = -h / 2.0;
            let member_size = (view.font_size * 0.875).round();
            let line_height = (member_size * 1.5).round();
            let mut body = format!(
                r#"<rect x="{}" y="{}" width="{}" height="{}" fill="{}" stroke="{}"{}/>"#,
                num(left),
                num(top),
                num(w),
                num(h),
                ctx.theme.surface(),
                ctx.theme.border(),
                ctx.theme.rounded(&view.style.shape),
            );
            let ink = ink_fill(&view.style.shape, &view.style.text, ctx.theme, None);
            let ann_ink = ink_fill(&view.style.shape, &view.style.text, ctx.theme, Some(ctx.theme.muted()));
            let first = top + view.title_h;
            let second = first + view.attributes_h;
            if h > view.title_h {
                let stroke = view
                    .style
                    .stroke
                    .as_deref()
                    .map_or_else(String::new, |s| format!(r#" style="stroke:{}""#, esc(s)));
                body.push_str(&format!(
                    r#"<path class="pele-divider" d="M{},{}H{}M{},{}H{}" fill="none" stroke="{}"{stroke}/>"#,
                    num(left),
                    num(first),
                    num(-left),
                    num(left),
                    num(second),
                    num(-left),
                    ctx.theme.border(),
                ));
            }
            let mut cur_y = top + TITLE_PAD;
            for ann in &view.annotations {
                match ann {
                    AnnotationItem::Plain(text) => {
                        body.push_str(&format!(
                            r#"<text class="pele-annotation" x="0" y="{}" text-anchor="middle" font-size="{}"{ann_ink}>{}</text>"#,
                            num(cur_y + tiny_height / 2.0 + tiny * 0.35),
                            num(tiny),
                            esc(text),
                        ));
                        cur_y += tiny_height;
                    }
                    AnnotationItem::Math(lbl) => {
                        let ah = tiny_height.max(lbl.height);
                        let attrs = format!(r#" class="pele-annotation" font-size="{}"{ann_ink}"#, num(tiny));
                        body.push_str(&label_svg(lbl, 0.0, cur_y + ah / 2.0, &attrs, ctx.theme, ctx.icons));
                        cur_y += ah;
                    }
                }
            }
            let title_size = if (view.font_size - size).abs() < f64::EPSILON {
                String::new()
            } else {
                format!(r#" font-size="{}""#, num(view.font_size))
            };
            let title_attrs = format!(
                r#" class="pele-label"{title_size} font-weight="{}"{ink}{}"#,
                ctx.theme.heading_weight(),
                view.style.text
            );
            body.push_str(&label_svg(
                &view.label,
                0.0,
                (cur_y + first - TITLE_PAD) / 2.0,
                &title_attrs,
                ctx.theme,
                ctx.icons,
            ));

            let render_lines = |list: &[Line], kind: &str, from: f64| -> String {
                let mut out = String::new();
                let mut baseline = from + SECTION_PAD + line_height / 2.0 + member_size * 0.35;
                for line in list {
                    let mark = match line.classifier {
                        Classifier::Static => {
                            if view.style.text.is_empty() {
                                r#" pele-static" style="text-decoration:underline""#.to_string()
                            } else {
                                format!(r#" pele-static"{}text-decoration:underline""#, &view.style.text[..view.style.text.len() - 1])
                            }
                        }
                        Classifier::Abstract => format!(r#" pele-abstract" font-style="italic"{}"#, view.style.text),
                        Classifier::None => format!(r#""{}"#, view.style.text),
                    };
                    out.push_str(&format!(
                        r#"<text class="pele-member pele-{kind}{mark} x="{}" y="{}">{}</text>"#,
                        num(left + PAD_X),
                        num(baseline),
                        esc(&line.text),
                    ));
                    baseline += line_height;
                }
                out
            };

            if !view.attributes.is_empty() || !view.methods.is_empty() {
                let font_family = if mono(&view.style) {
                    format!(r#" font-family="{}""#, ctx.theme.font_mono())
                } else {
                    String::new()
                };
                body.push_str(&format!(
                    r#"<g class="pele-members" font-size="{}"{ink}{font_family}>{}{}</g>"#,
                    num(member_size),
                    render_lines(&view.attributes, "attribute", first),
                    render_lines(&view.methods, "method", second),
                ));
            }

            if let Some(ref tip) = cls.tooltip
                && !tip.is_empty()
            {
                body = format!("<title>{}</title>{body}", esc_text(tip));
            }
            if let Some(ref href) = cls.link
                && !href.is_empty()
            {
                let target_attr = match cls.link_target.as_deref() {
                    Some(t) if is_allowed_target(t) => format!(r#" target="{t}""#),
                    _ => String::new(),
                };
                body = linked(&body, href, &cls.id, &mut links, ctx.options, &target_attr);
            }
            let stripped_classes = cls
                .css_classes
                .strip_prefix("default ")
                .or_else(|| cls.css_classes.strip_prefix("default"))
                .unwrap_or(&cls.css_classes);
            nodes_out.push_str(&format!(
                r#"<g class="pele-node pele-class{}" data-id="{id}"{at}>{body}</g>"#,
                class_names(stripped_classes),
            ));
        } else {
            match node.shape {
                NodeShape::Note => {
                    let r = w / 2.0;
                    let t = -h / 2.0;
                    let lbl_attrs = format!(r#" class="pele-label" font-size="{}""#, num(small));
                    nodes_out.push_str(&format!(
                        r#"<g class="pele-node pele-note" data-id="{id}"{at}><path d="M{},{}H{}L{},{}V{}H{}Z" fill="{}" stroke="{}" stroke-linejoin="round"/><path d="M{},{}V{}H{}" fill="none" stroke="{}" stroke-linejoin="round"/>{}</g>"#,
                        num(-r),
                        num(t),
                        num(r - FOLD),
                        num(r),
                        num(t + FOLD),
                        num(-t),
                        num(-r),
                        ctx.theme.surface_alt(),
                        ctx.theme.border(),
                        num(r - FOLD),
                        num(t),
                        num(t + FOLD),
                        num(r),
                        ctx.theme.border(),
                        label_svg(&view.label, 0.0, 0.0, &lbl_attrs, ctx.theme, ctx.icons),
                    ));
                }
                NodeShape::Interface | NodeShape::Rect | NodeShape::ClassBox => {
                    let lbl_attrs = format!(r#" class="pele-label" font-size="{}""#, num(small));
                    nodes_out.push_str(&format!(
                        r#"<g class="pele-node pele-interface" data-id="{id}"{at}>{}</g>"#,
                        label_svg(&view.label, 0.0, 0.0, &lbl_attrs, ctx.theme, ctx.icons),
                    ));
                }
            }
        }
    }

    let line_color = ctx.theme.line();
    let bg_color = ctx.theme.bg();
    let mut edges_out = String::new();
    let mut labels_out = String::new();
    for i in 0..cedges.len() {
        let ce = &mut cedges[i];
        let edge = &drawn[i];
        let label = &edge_labels[i];
        let start_type = edge.arrow_type_start;
        let end_type = edge.arrow_type_end;
        let start_trim = class_marker_trim(start_type);
        let end_trim = class_marker_trim(end_type);
        let path: EdgePath = if ce.src == ce.dst {
            let c = &cnodes[ce.src];
            let view = &views[ce.src];
            let k = loop_at[i];
            let x = c.x + ox + view.w / 2.0;
            let y = c.y + oy;
            let spread = (view.h / 2.0 - 4.0).min(8.0 + (k as f64) * 6.0);
            let reach = LOOP + (k as f64) * 8.0;
            EdgePath {
                d: format!(
                    "M{},{}C{},{} {},{} {},{}",
                    num(x + start_trim),
                    num(y - spread),
                    num(x + reach + start_trim),
                    num(y - spread),
                    num(x + reach + end_trim),
                    num(y + spread),
                    num(x + end_trim),
                    num(y + spread),
                ),
                tokens: None,
                sx: x,
                sy: y - spread,
                sdx: -1.0,
                sdy: 0.0,
                ex: x,
                ey: y + spread,
                edx: -1.0,
                edy: 0.0,
            }
        } else {
            let mut k = 0;
            while k + 1 < ce.route.len() {
                ce.route[k] += ox;
                ce.route[k + 1] += oy;
                k += 3;
            }
            route_path(&ce.route, None, start_trim, end_trim, None, None)
        };
        let attrs = match edge.pattern {
            EdgePattern::Dashed => r#" stroke-dasharray="6 4""#,
            EdgePattern::Dotted => r#" stroke-dasharray="2 4""#,
            EdgePattern::Solid => "",
        };
        let edge_class = match edge.pattern {
            EdgePattern::Dotted => " pele-note-edge",
            EdgePattern::Solid | EdgePattern::Dashed => " pele-relation",
        };
        edges_out.push_str(&format!(
            r#"<g class="pele-edge{edge_class}" data-id="{}"><path d="{}"{attrs}/>{}{}</g>"#,
            esc_text(&edge.id),
            path.d,
            class_marker(start_type, path.sx, path.sy, path.sdx, path.sdy, line_color, bg_color),
            class_marker(end_type, path.ex, path.ey, path.edx, path.edy, line_color, bg_color),
        ));
        if label.width > 0.0 {
            let x = ce.label_x + ox;
            let y = ce.label_y + oy;
            labels_out.push_str(&edge_label_svg(&edge.id, label, x, y, "", ctx.theme, ctx.icons));
        }
    }

    let mut cards_out = String::new();
    for item in &cards {
        if let Some(ref math_lbl) = item.math {
            cards_out.push_str(&label_svg(
                math_lbl,
                item.x + ox,
                item.y + oy,
                r#" class="pele-cardinality""#,
                ctx.theme,
                ctx.icons,
            ));
        } else {
            cards_out.push_str(&format!(
                r#"<text class="pele-cardinality" x="{}" y="{}" text-anchor="middle">{}</text>"#,
                num(item.x + ox),
                num(item.y + oy + tiny * 0.35),
                esc(&item.text),
            ));
        }
    }

    let mut body = String::new();
    if !clusters.is_empty() {
        body.push_str(&format!(r#"<g class="pele-clusters">{clusters}</g>"#));
    }
    if !edges_out.is_empty() {
        body.push_str(&format!(
            r#"<g class="pele-edges" fill="none" stroke="{line_color}" stroke-linecap="round">{edges_out}</g>"#
        ));
    }
    if !struck_titles.is_empty() {
        body.push_str(&format!(r#"<g class="pele-cluster-titles">{struck_titles}</g>"#));
    }
    if !labels_out.is_empty() {
        body.push_str(&format!(r#"<g class="pele-edge-labels" font-size="{}">{labels_out}</g>"#, num(small)));
    }
    if !cards_out.is_empty() {
        body.push_str(&format!(
            r#"<g class="pele-cardinalities" font-size="{}" fill="{}">{cards_out}</g>"#,
            num(tiny),
            ctx.theme.muted(),
        ));
    }
    body.push_str(&format!(r#"<g class="pele-nodes">{nodes_out}</g>"#));

    let titled = with_title(db.title.as_deref(), ctx.measurer, size, pad, width, height, body, ctx.theme);
    let svg = svg_document(
        "class",
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
