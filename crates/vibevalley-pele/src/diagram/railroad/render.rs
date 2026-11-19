use crate::Rendered;
use crate::config::DiagramConfig;
use crate::diagram::RenderContext;
use crate::diagram::common::{tighten, title_room};
use crate::measure::{TextMeasurer, TextStyle};
use crate::svg::builder::{esc, esc_text, label_svg, num};
use crate::svg::root::{Accessible, svg_document};
use crate::text::entities::decode_entities;
use crate::text::label::layout_label;
use crate::util::yaml::YamlValue;

use super::types::{RailroadModel, RailroadNode};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Terminal,
    NonTerminal,
    Special,
    Sequence,
    Choice,
    Bypass,
    Loop,
    Folded,
}

struct LayoutBox {
    kind: Kind,
    width: f64,
    up: f64,
    down: f64,
    kids: Vec<usize>,
    text: String,
    id: String,
    reach: f64,
}

struct Metrics<'a> {
    measurer: &'a dyn TextMeasurer,
    size: f64,
    padding: f64,
    height: f64,
    gap: f64,
    sep: f64,
    arc: f64,
}

const LEAD: f64 = 12.0;
const HEAD_GAP: f64 = 6.0;
const RULE_GAP: f64 = 18.0;
const COUNT_SIZE: f64 = 12.0;
const ARROW: f64 = 7.0;

fn option(config: &DiagramConfig, key: &str, fallback: f64, max: f64) -> f64 {
    let val = config.section("railroad").and_then(|s| s.get(key)).and_then(YamlValue::as_f64);
    match val {
        Some(v) if v.is_finite() && v >= 0.0 => v.min(max),
        _ => fallback,
    }
}

fn shown(text: &str) -> String {
    let decoded = if text.contains("¶ß") {
        decode_entities(&text.replace('&', "&amp;"))
    } else {
        text.to_string()
    };
    if !decoded.contains(['\n', '\r', '\t']) {
        return decoded;
    }
    let mut out = String::with_capacity(decoded.len() + 4);
    for ch in decoded.chars() {
        match ch {
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out
}

fn even(value: f64) -> f64 {
    (value / 2.0).ceil() * 2.0
}

fn format_count_num(v: f64) -> String {
    if !v.is_finite() {
        return "∞".to_string();
    }
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

fn count_label(min: f64, max: f64) -> String {
    if max.is_infinite() && min <= 1.0 {
        return String::new();
    }
    if min == max {
        return format!("{}×", format_count_num(min));
    }
    if max.is_infinite() {
        return format!("≥{}×", format_count_num(min));
    }
    if min == 0.0 {
        format!("≤{}×", format_count_num(max))
    } else {
        format!("{}–{}×", format_count_num(min), format_count_num(max))
    }
}

fn below(offset: f64, above: &LayoutBox, branch: &LayoutBox, m: &Metrics<'_>) -> f64 {
    (offset + above.down + m.sep + branch.up).max(2.0 * m.arc)
}

fn push_leaf(arena: &mut Vec<LayoutBox>, kind: Kind, text: String, id: String, style: TextStyle, m: &Metrics<'_>) -> usize {
    let half = m.height / 2.0;
    let width = even(m.measurer.width(&text, m.size, style) + 2.0 * m.padding).max(m.height);
    let idx = arena.len();
    arena.push(LayoutBox {
        kind,
        width,
        up: half,
        down: half,
        kids: Vec::new(),
        text,
        id,
        reach: 0.0,
    });
    idx
}

fn push_bypass(arena: &mut Vec<LayoutBox>, kid_id: usize, m: &Metrics<'_>) -> usize {
    let kid = &arena[kid_id];
    let reach = (kid.up + m.sep).max(2.0 * m.arc);
    let width = kid.width + 4.0 * m.arc;
    let down = kid.down;
    let idx = arena.len();
    arena.push(LayoutBox {
        kind: Kind::Bypass,
        width,
        up: reach,
        down,
        kids: vec![kid_id],
        text: String::new(),
        id: String::new(),
        reach,
    });
    idx
}

fn child_budget(node: &RailroadNode, room: f64, m: &Metrics<'_>) -> f64 {
    if !room.is_finite() {
        return f64::INFINITY;
    }
    let around = match node {
        RailroadNode::Choice(_) | RailroadNode::Optional(_) => 4.0 * m.arc,
        RailroadNode::Repetition { min, .. } => (if *min == 0.0 { 6.0 } else { 2.0 }) * m.arc,
        RailroadNode::Sequence(_) => 6.0 * m.arc,
        RailroadNode::Terminal(_) | RailroadNode::NonTerminal(_) | RailroadNode::Special(_) => 0.0,
    };
    40.0f64.max(room - around)
}

fn node_children(node: &RailroadNode) -> &[RailroadNode] {
    match node {
        RailroadNode::Sequence(elems) | RailroadNode::Choice(elems) => elems,
        RailroadNode::Optional(inner) | RailroadNode::Repetition { element: inner, .. } => std::slice::from_ref(inner.as_ref()),
        RailroadNode::Terminal(_) | RailroadNode::NonTerminal(_) | RailroadNode::Special(_) => &[],
    }
}

fn measure(root: &RailroadNode, m: &Metrics<'_>, initial_room: f64) -> (Vec<LayoutBox>, usize) {
    struct Frame<'a> {
        node: &'a RailroadNode,
        room: f64,
        next_child: usize,
        kids: Vec<usize>,
    }

    let mut arena: Vec<LayoutBox> = Vec::new();
    let mut stack: Vec<Frame<'_>> = vec![Frame {
        node: root,
        room: initial_room,
        next_child: 0,
        kids: Vec::new(),
    }];

    loop {
        let top = stack.last_mut().unwrap();
        let children = node_children(top.node);
        if top.next_child < children.len() {
            let child = &children[top.next_child];
            let next_room = child_budget(top.node, top.room, m);
            top.next_child += 1;
            stack.push(Frame {
                node: child,
                room: next_room,
                next_child: 0,
                kids: Vec::new(),
            });
            continue;
        }
        let done = stack.pop().unwrap();
        let box_id = match done.node {
            RailroadNode::Terminal(val) => {
                let text = shown(val);
                let display = if !text.is_empty() && text.bytes().all(|b| b == b' ') {
                    "␣".repeat(text.len())
                } else {
                    text
                };
                push_leaf(&mut arena, Kind::Terminal, display, String::new(), TextStyle::MONO, m)
            }
            RailroadNode::NonTerminal(name) => push_leaf(&mut arena, Kind::NonTerminal, shown(name), name.clone(), TextStyle::NONE, m),
            RailroadNode::Special(text) => push_leaf(&mut arena, Kind::Special, format!("? {} ?", shown(text)), String::new(), TextStyle::ITALIC, m),
            RailroadNode::Sequence(_) => {
                let kids = done.kids;
                let mut width = (kids.len().saturating_sub(1) as f64) * m.gap;
                let mut up = 0.0f64;
                let mut down = 0.0f64;
                for &k in &kids {
                    width += arena[k].width;
                    up = up.max(arena[k].up);
                    down = down.max(arena[k].down);
                }
                if width <= done.room || kids.len() < 2 {
                    let id = arena.len();
                    arena.push(LayoutBox {
                        kind: Kind::Sequence,
                        width,
                        up,
                        down,
                        kids,
                        text: String::new(),
                        id: String::new(),
                        reach: 0.0,
                    });
                    id
                } else {
                    let row_limit = 40.0f64.max(done.room - 6.0 * m.arc);
                    let mut rows: Vec<(Vec<usize>, f64)> = Vec::new();
                    let mut row: Vec<usize> = Vec::new();
                    let mut row_w = 0.0f64;
                    for &k in &kids {
                        let kw = arena[k].width;
                        if !row.is_empty() && row_w + m.gap + kw > row_limit {
                            rows.push((std::mem::take(&mut row), row_w));
                            row_w = 0.0;
                        }
                        if !row.is_empty() {
                            row_w += m.gap;
                        }
                        row_w += kw;
                        row.push(k);
                    }
                    if !row.is_empty() {
                        rows.push((row, row_w));
                    }
                    if rows.len() < 2 {
                        let id = arena.len();
                        arena.push(LayoutBox {
                            kind: Kind::Sequence,
                            width,
                            up,
                            down,
                            kids,
                            text: String::new(),
                            id: String::new(),
                            reach: 0.0,
                        });
                        id
                    } else {
                        let mut row_ids: Vec<usize> = Vec::with_capacity(rows.len());
                        for (r_kids, r_w) in rows {
                            let mut r_up = 0.0f64;
                            let mut r_down = 0.0f64;
                            for &k in &r_kids {
                                r_up = r_up.max(arena[k].up);
                                r_down = r_down.max(arena[k].down);
                            }
                            let rid = arena.len();
                            arena.push(LayoutBox {
                                kind: Kind::Sequence,
                                width: r_w,
                                up: r_up,
                                down: r_down,
                                kids: r_kids,
                                text: String::new(),
                                id: String::new(),
                                reach: 0.0,
                            });
                            row_ids.push(rid);
                        }
                        let mut folded_w = 0.0f64;
                        let mut offset = 0.0f64;
                        let row_gap = m.sep.max(2.0 * m.arc);
                        for (i, &rid) in row_ids.iter().enumerate() {
                            folded_w = folded_w.max(arena[rid].width);
                            if i > 0 {
                                offset += arena[row_ids[i - 1]].down + row_gap + arena[rid].up;
                            }
                        }
                        let f_up = arena[row_ids[0]].up;
                        let f_down = offset + arena[*row_ids.last().unwrap()].down;
                        let fid = arena.len();
                        arena.push(LayoutBox {
                            kind: Kind::Folded,
                            width: folded_w + 6.0 * m.arc,
                            up: f_up,
                            down: f_down,
                            kids: row_ids,
                            text: String::new(),
                            id: String::new(),
                            reach: 0.0,
                        });
                        fid
                    }
                }
            }
            RailroadNode::Choice(_) => {
                let kids = done.kids;
                let mut inner = 0.0f64;
                let mut offset = 0.0f64;
                for (i, &k) in kids.iter().enumerate() {
                    inner = inner.max(arena[k].width);
                    if i > 0 {
                        offset = below(offset, &arena[kids[i - 1]], &arena[k], m);
                    }
                }
                let c_up = kids.first().map_or(0.0, |&k| arena[k].up);
                let c_down = kids.last().map_or(0.0, |&k| offset + arena[k].down);
                let id = arena.len();
                arena.push(LayoutBox {
                    kind: Kind::Choice,
                    width: inner + 4.0 * m.arc,
                    up: c_up,
                    down: c_down,
                    kids,
                    text: String::new(),
                    id: String::new(),
                    reach: 0.0,
                });
                id
            }
            RailroadNode::Optional(_) => push_bypass(&mut arena, done.kids[0], m),
            RailroadNode::Repetition { min, max, .. } => {
                let kid_id = done.kids[0];
                if *min == 1.0 && *max == 1.0 {
                    kid_id
                } else {
                    let text = count_label(*min, *max);
                    let kid_w = arena[kid_id].width;
                    let kid_up = arena[kid_id].up;
                    let kid_down = arena[kid_id].down;
                    let reach = (kid_down + m.sep).max(2.0 * m.arc);
                    let label_w = if text.is_empty() {
                        0.0
                    } else {
                        even(m.measurer.width(&text, COUNT_SIZE, TextStyle::NONE))
                    };
                    let loop_down = reach + if text.is_empty() { ARROW / 2.0 + 1.0 } else { COUNT_SIZE + 6.0 };
                    let loop_id = arena.len();
                    arena.push(LayoutBox {
                        kind: Kind::Loop,
                        width: kid_w.max(label_w) + 2.0 * m.arc,
                        up: kid_up,
                        down: loop_down,
                        kids: vec![kid_id],
                        text,
                        id: String::new(),
                        reach,
                    });
                    if *min == 0.0 { push_bypass(&mut arena, loop_id, m) } else { loop_id }
                }
            }
        };
        if let Some(parent) = stack.last_mut() {
            parent.kids.push(box_id);
        } else {
            return (arena, box_id);
        }
    }
}

pub fn render_railroad(model: &RailroadModel, ctx: &RenderContext<'_>) -> Rendered {
    tighten(ctx.options, |tight| draw(model, ctx, tight))
}

fn draw(model: &RailroadModel, ctx: &RenderContext<'_>, tight: bool) -> Rendered {
    let base = ctx.options.font_size.unwrap_or(16.0);
    let font_size = option(ctx.config, "fontSize", 0.0, 200.0);
    let size = if font_size > 0.0 { font_size } else { (base * 0.875).round() };
    let head_size = if font_size > 0.0 { font_size } else { base };
    let padding_cfg = ctx
        .config
        .section("railroad")
        .and_then(|s| s.get("padding"))
        .and_then(YamlValue::as_f64)
        .filter(|&v| v.is_finite() && v >= 0.0)
        .map(|v| v.min(200.0));
    let line_height = (size * 1.5).round();
    let m = Metrics {
        measurer: ctx.measurer,
        size,
        padding: padding_cfg.unwrap_or(12.0),
        height: even(line_height + padding_cfg.map_or(9.0, |p| 2.0 * p)),
        gap: option(ctx.config, "horizontalSeparation", 16.0, 500.0).min(if tight { 12.0 } else { f64::INFINITY }),
        sep: option(ctx.config, "verticalSeparation", 10.0, 500.0),
        arc: option(ctx.config, "arcRadius", 10.0, 200.0).min(if tight { 6.0 } else { f64::INFINITY }),
    };
    let show_markers = ctx.config.section("railroad").and_then(|s| s.get("showMarkers")).and_then(YamlValue::as_bool) != Some(false);
    let radius = if show_markers { option(ctx.config, "markerRadius", 4.0, 50.0) } else { 0.0 };
    let stroke_width = option(ctx.config, "strokeWidth", 0.0, 20.0);
    let stroke_attr = if stroke_width > 0.0 {
        format!(r#" stroke-width="{}""#, num(stroke_width))
    } else {
        String::new()
    };
    let pad = ctx.options.padding.unwrap_or(8.0);
    let arc = m.arc;

    let a_str = num(arc);
    let turn = |sweep: u8, dx: &str, dy: &str| format!("a{a_str},{a_str} 0 0 {sweep} {dx}{a_str},{dy}{a_str}");
    let east_to_south = turn(1, "", "");
    let south_to_east = turn(0, "", "");
    let east_to_north = turn(0, "", "-");
    let north_to_east = turn(1, "", "-");
    let loop_down = turn(0, "-", "");
    let loop_up = turn(0, "-", "-");

    let title = layout_label(
        model.title.as_deref(),
        false,
        ctx.measurer,
        base,
        if tight { title_room(ctx.options) } else { 4000.0 },
        TextStyle::BOLD,
        ctx.icons,
        None,
    );
    let title_height = if title.height > 0.0 { title.height + 16.0 } else { 0.0 };
    let head_height = (head_size * 1.5).round();
    let text_shift = size * 0.35;
    let box_top = m.height / 2.0;

    let rounded = ctx.theme.rounded_standalone();
    let font_mono = ctx.theme.font_mono();
    let surface = ctx.theme.surface();
    let bg = ctx.theme.bg();
    let border = ctx.theme.border();
    let line_color = ctx.theme.line();
    let muted = ctx.theme.muted();
    let heading_w = ctx.theme.heading_weight();

    let mut rules_svg = String::new();
    let mut width = title.width;
    let mut top = pad + title_height;
    let mut bottom = pad + title.height;

    let room = if tight {
        80.0f64.max(ctx.options.max_width.unwrap_or(320.0) - 2.0 * pad - 4.0 * radius - 2.0 * LEAD - 1.0)
    } else {
        f64::INFINITY
    };

    for rule in &model.rules {
        let (arena, root_id) = measure(&rule.definition, &m, room);
        let root_box = &arena[root_id];
        let name = shown(&rule.name);
        let baseline = top + head_height + HEAD_GAP + root_box.up;
        let start = pad + 2.0 * radius;
        let left = start + LEAD;
        let end = left + root_box.width + LEAD;

        let mut track = String::new();
        let mut arrows = String::new();
        let mut nodes_svg = String::new();

        let add_line = |track: &mut String, x1: f64, y: f64, x2: f64| {
            if x2 > x1 {
                track.push_str(&format!("M{},{}H{}", num(x1), num(y), num(x2)));
            }
        };

        add_line(&mut track, start, baseline, left);
        add_line(&mut track, left + root_box.width, baseline, end);

        let mut work: Vec<(usize, f64, f64)> = vec![(root_id, left, baseline)];
        while let Some((box_id, x, y)) = work.pop() {
            let b = &arena[box_id];
            let right = x + b.width;
            match b.kind {
                Kind::Sequence => {
                    let mut kx = right;
                    for (i, &kid_id) in b.kids.iter().enumerate().rev() {
                        kx -= arena[kid_id].width;
                        work.push((kid_id, kx, y));
                        if i > 0 {
                            add_line(&mut track, kx - m.gap, y, kx);
                        }
                        kx -= m.gap;
                    }
                }
                Kind::Folded => {
                    let start_x = x + 2.0 * arc;
                    let from = work.len();
                    let mut offset = 0.0f64;
                    let row_gap = m.sep.max(2.0 * arc);
                    add_line(&mut track, x, y, start_x);
                    for (i, &kid_id) in b.kids.iter().enumerate() {
                        let kid = &arena[kid_id];
                        let ky = y + offset;
                        work.push((kid_id, start_x, ky));
                        if i + 1 < b.kids.len() {
                            let next = &arena[b.kids[i + 1]];
                            let next_offset = offset + kid.down + row_gap + next.up;
                            let mid = y + offset + kid.down + row_gap / 2.0;
                            track.push_str(&format!(
                                "M{},{}H{}V{}H{}V{}H{}",
                                num(start_x + kid.width),
                                num(ky),
                                num(right - 2.0 * arc),
                                num(mid),
                                num(x + arc),
                                num(y + next_offset),
                                num(start_x),
                            ));
                            arrows.push_str(&format!(
                                "M{},{}l{},{}l{},{}z",
                                num(start_x - ARROW),
                                num(y + next_offset - ARROW / 2.0),
                                num(ARROW),
                                num(ARROW / 2.0),
                                num(-ARROW),
                                num(ARROW / 2.0),
                            ));
                            offset = next_offset;
                        } else {
                            track.push_str(&format!(
                                "M{},{}H{}V{}H{}",
                                num(start_x + kid.width),
                                num(ky),
                                num(right - arc),
                                num(y),
                                num(right),
                            ));
                        }
                    }
                    work[from..].reverse();
                }
                Kind::Choice => {
                    let inner = b.width - 4.0 * arc;
                    let rail_in = x + arc;
                    let rail_out = right - arc;
                    let from = work.len();
                    let mut offset = 0.0f64;
                    for (i, &kid_id) in b.kids.iter().enumerate() {
                        let kid = &arena[kid_id];
                        if i > 0 {
                            offset = below(offset, &arena[b.kids[i - 1]], kid, &m);
                        }
                        let ky = y + offset;
                        let kx = x + 2.0 * arc + (inner - kid.width) / 2.0;
                        let last = i == b.kids.len() - 1;
                        if i == 0 {
                            add_line(&mut track, x, y, kx);
                            add_line(&mut track, kx + kid.width, y, right);
                        } else {
                            if last {
                                track.push_str(&format!("M{},{}{east_to_south}V{}", num(x), num(y), num(ky - arc)));
                            } else {
                                track.push_str(&format!("M{},{}", num(rail_in), num(ky - arc)));
                            }
                            track.push_str(&south_to_east);
                            if kx > rail_in + arc {
                                track.push_str(&format!("H{}", num(kx)));
                            }
                            track.push_str(&format!("M{},{}", num(kx + kid.width), num(ky)));
                            if kx > rail_in + arc {
                                track.push_str(&format!("H{}", num(rail_out - arc)));
                            }
                            track.push_str(&east_to_north);
                            if last {
                                track.push_str(&format!("V{}{north_to_east}", num(y + arc)));
                            }
                        }
                        work.push((kid_id, kx, ky));
                    }
                    work[from..].reverse();
                }
                Kind::Bypass => {
                    let kid_id = b.kids[0];
                    let kid = &arena[kid_id];
                    let kx = x + 2.0 * arc;
                    add_line(&mut track, x, y, kx);
                    add_line(&mut track, kx + kid.width, y, right);
                    track.push_str(&format!(
                        "M{},{}{east_to_north}V{}{north_to_east}H{}{east_to_south}V{}{south_to_east}",
                        num(x),
                        num(y),
                        num(y - b.reach + arc),
                        num(right - 2.0 * arc),
                        num(y - arc),
                    ));
                    work.push((kid_id, kx, y));
                }
                Kind::Loop => {
                    let kid_id = b.kids[0];
                    let kid = &arena[kid_id];
                    let kx = x + (b.width - kid.width) / 2.0;
                    let loop_y = y + b.reach;
                    let middle = x + b.width / 2.0;
                    add_line(&mut track, x, y, kx);
                    add_line(&mut track, kx + kid.width, y, right);
                    track.push_str(&format!(
                        "M{},{}{loop_down}V{}{south_to_east}H{}{east_to_north}V{}{loop_up}",
                        num(x + arc),
                        num(y),
                        num(loop_y - arc),
                        num(right - arc),
                        num(y + arc),
                    ));
                    arrows.push_str(&format!(
                        "M{},{}l{},{}v{}z",
                        num(middle - ARROW / 2.0),
                        num(loop_y),
                        num(ARROW),
                        num(-ARROW / 2.0),
                        num(ARROW),
                    ));
                    if !b.text.is_empty() {
                        nodes_svg.push_str(&format!(
                            r#"<text class="pele-edge-label pele-count" x="{}" y="{}" font-size="{}" fill="{muted}">{}</text>"#,
                            num(middle),
                            num(loop_y + COUNT_SIZE + 3.0),
                            num(COUNT_SIZE),
                            esc(&b.text),
                        ));
                    }
                    work.push((kid_id, kx, y));
                }
                Kind::Terminal | Kind::NonTerminal | Kind::Special => {
                    let text = &b.text;
                    let space = if text.starts_with(' ') || text.ends_with(' ') || text.contains("  ") {
                        r#" xml:space="preserve""#
                    } else {
                        ""
                    };
                    let shape = format!(
                        r#"<rect x="{}" y="{}" width="{}" height="{}""#,
                        num(x),
                        num(y - box_top),
                        num(b.width),
                        num(m.height),
                    );
                    let lbl = format!(r#"<text x="{}" y="{}"{space}"#, num(x + b.width / 2.0), num(y + text_shift));
                    match b.kind {
                        Kind::Terminal => {
                            nodes_svg.push_str(&format!(
                                r#"<g class="pele-node pele-terminal">{shape} rx="{}" fill="{surface}" stroke="{border}"{stroke_attr}/>{lbl} font-family="{font_mono}">{}</text></g>"#,
                                num(box_top),
                                esc(text),
                            ));
                        }
                        Kind::NonTerminal => {
                            nodes_svg.push_str(&format!(
                                r#"<g class="pele-node pele-nonterminal" data-id="{}">{shape} fill="{bg}" stroke="{border}"{stroke_attr}{rounded}/>{lbl}>{}</text></g>"#,
                                esc_text(&b.id),
                                esc(text),
                            ));
                        }
                        Kind::Special => {
                            let inner = &text[2..text.len() - 2];
                            nodes_svg.push_str(&format!(
                                r#"<g class="pele-node pele-special">{shape} fill="{bg}" stroke="{border}" stroke-dasharray="4 3"{stroke_attr}{rounded}/>{lbl} font-style="italic"><tspan fill="{muted}">? </tspan>{}<tspan fill="{muted}"> ?</tspan></text></g>"#,
                                esc(inner),
                            ));
                        }
                        Kind::Sequence | Kind::Choice | Kind::Bypass | Kind::Loop | Kind::Folded => unreachable!(),
                    }
                }
            }
        }

        let markers = if radius > 0.0 {
            format!(
                r#"<circle class="pele-marker pele-start" cx="{}" cy="{}" r="{}" fill="{line_color}"/><circle class="pele-marker pele-end" cx="{}" cy="{}" r="{}" fill="{line_color}"/>"#,
                num(pad + radius),
                num(baseline),
                num(radius),
                num(end + radius),
                num(baseline),
                num(radius),
            )
        } else {
            String::new()
        };
        let arrows_el = if arrows.is_empty() {
            String::new()
        } else {
            format!(r#"<path class="pele-marker" d="{arrows}" fill="{line_color}"/>"#)
        };
        rules_svg.push_str(&format!(
            r#"<g class="pele-rule" data-id="{}"><text class="pele-rule-name" x="{}" y="{}" font-size="{}" font-weight="{heading_w}" text-anchor="start">{}</text><path class="pele-edge pele-track" d="{track}" fill="none" stroke="{line_color}"{stroke_attr}/>{arrows_el}{markers}{nodes_svg}</g>"#,
            esc_text(&rule.name),
            num(pad),
            num(top + head_height / 2.0 + head_size * 0.35),
            num(head_size),
            esc(&name),
        ));
        width = width.max(end + 2.0 * radius - pad).max(ctx.measurer.width(&name, head_size, TextStyle::BOLD));
        bottom = baseline + root_box.down;
        top = bottom + m.sep + RULE_GAP;
    }

    let total_width = (width + 2.0 * pad).ceil();
    let total_height = (bottom + pad).ceil();
    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let mut content = label_svg(&title, total_width / 2.0, pad + title.height / 2.0, &title_attrs, ctx.theme, ctx.icons);
    if !rules_svg.is_empty() {
        content.push_str(&format!(
            r#"<g class="pele-rules" transform="translate(0.5,0.5)" font-size="{}" text-anchor="middle">{rules_svg}</g>"#,
            num(size),
        ));
    }

    let svg = svg_document(
        "railroad",
        total_width,
        total_height,
        base,
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
