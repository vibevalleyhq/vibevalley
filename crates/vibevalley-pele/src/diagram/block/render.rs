use std::collections::{HashMap, HashSet};
use std::f64::consts::{FRAC_1_SQRT_2, FRAC_PI_2, FRAC_PI_4, PI};

use indexmap::IndexMap;

use crate::Rendered;
use crate::diagram::RenderContext;
use crate::diagram::common::{tighten, title_room};
use crate::measure::TextStyle;
use crate::svg::builder::{esc_text, label_svg, num};
use crate::svg::edges::{ARROW, EdgePath, Fill, OverFill, casings_svg, edge_casing, edge_label_svg, marker, marker_trim, over_fills};
use crate::svg::ink::{ink_fill, paints};
use crate::svg::root::{Accessible, svg_document};
use crate::svg::shapes::{ShapeKind, draw_shape, shape_filled, shape_inset, shape_size};
use crate::svg::theme::{ResolvedStyle, class_names, resolve_style, sets_fill};
use crate::svg::title::title_label;
use crate::text::label::{Label, layout_label};
use crate::util::yaml::YamlValue;

use super::arrows::{ArrowAxis, OVERHANG, arrow_axis, arrow_mask, arrow_size, draw_arrow};
use super::db::BlockDb;
use super::layout::{Cell, cell, layout};
use super::types::Block;

const GAP: f64 = 12.0;
const WRAP: f64 = 200.0;
const CORNER: f64 = 8.0;
const OBSTACLE_BUDGET: usize = 2_000_000;
const LABEL_GAP: f64 = 4.0;
const SPOTS: [f64; 5] = [0.5, 0.3, 0.7, 0.15, 0.85];

fn block_shape(block_type: &str) -> ShapeKind {
    match block_type {
        "square" => ShapeKind::Rect,
        "round" => ShapeKind::Rounded,
        "circle" => ShapeKind::Circle,
        "doublecircle" => ShapeKind::DblCirc,
        "diamond" => ShapeKind::Diam,
        "hexagon" => ShapeKind::Hex,
        "stadium" => ShapeKind::Stadium,
        "subroutine" => ShapeKind::FrRect,
        "cylinder" => ShapeKind::Cyl,
        "rect_left_inv_arrow" => ShapeKind::Odd,
        "lean_right" => ShapeKind::LeanR,
        "lean_left" => ShapeKind::LeanL,
        "trapezoid" => ShapeKind::TrapB,
        "inv_trapezoid" => ShapeKind::TrapT,
        _ => ShapeKind::Rect,
    }
}

fn is_fixed(shape: ShapeKind) -> bool {
    matches!(shape, ShapeKind::Circle | ShapeKind::DblCirc | ShapeKind::Diam)
}

fn is_wide(shape: ShapeKind) -> bool {
    matches!(
        shape,
        ShapeKind::Stadium | ShapeKind::Hex | ShapeKind::Odd | ShapeKind::LeanR | ShapeKind::LeanL | ShapeKind::TrapB | ShapeKind::TrapT
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Leaf,
    Arrow,
    Composite,
    Space,
}

struct View {
    block_idx: usize,
    kind: Kind,
    shape: ShapeKind,
    label: Label,
    style: ResolvedStyle,
    mask: u8,
    dx: f64,
    dy: f64,
    bw: f64,
    bh: f64,
}

#[derive(Debug, Clone, Copy)]
struct BoxBounds {
    owner: Option<usize>,
    x: f64,
    y: f64,
    bw: f64,
    bh: f64,
}

struct Route {
    edge_idx: usize,
    points: Vec<f64>,
    loop_k: usize,
    label: Label,
    lx: f64,
    ly: f64,
}

fn is_round(v: &View) -> bool {
    v.kind == Kind::Leaf && matches!(v.shape, ShapeKind::Circle | ShapeKind::DblCirc)
}

fn edge_y(v: &View, c: &Cell, x: f64, sign: f64) -> f64 {
    let hw = v.bw / 2.0;
    let hh = v.bh / 2.0;
    let dx = (x - c.x).abs();
    let reach = if is_round(v) {
        (hw * hw - dx * dx).max(0.0).sqrt()
    } else if v.kind == Kind::Leaf && v.shape == ShapeKind::Diam {
        if hw == 0.0 { 0.0 } else { hh * (1.0 - dx / hw).max(0.0) }
    } else if v.kind == Kind::Leaf {
        hh - shape_inset(v.shape, v.bw, v.bh, if sign > 0.0 { 2 } else { 0 }, 0.0)
    } else if v.kind == Kind::Arrow && arrow_axis(v.mask) == ArrowAxis::X {
        hh - OVERHANG
    } else {
        hh
    };
    c.y + sign * reach
}

fn edge_x(v: &View, c: &Cell, y: f64, sign: f64) -> f64 {
    let hw = v.bw / 2.0;
    let hh = v.bh / 2.0;
    let dy = (y - c.y).abs();
    let reach = if is_round(v) {
        (hh * hh - dy * dy).max(0.0).sqrt()
    } else if v.kind == Kind::Leaf && v.shape == ShapeKind::Diam {
        if hh == 0.0 { 0.0 } else { hw * (1.0 - dy / hh).max(0.0) }
    } else if v.kind == Kind::Leaf {
        hw - shape_inset(v.shape, v.bw, v.bh, if sign > 0.0 { 1 } else { 3 }, 0.0)
    } else if v.kind == Kind::Arrow && arrow_axis(v.mask) == ArrowAxis::Y {
        hw - OVERHANG
    } else {
        hw
    };
    c.x + sign * reach
}

fn border(v: &View, c: &Cell, tx: f64, ty: f64, out: &mut Vec<f64>) {
    let dx = tx - c.x;
    let dy = ty - c.y;
    let hw = v.bw / 2.0;
    let hh = v.bh / 2.0;
    let mut k = if is_round(v) {
        let len = dx.hypot(dy);
        hw / if len == 0.0 { 1.0 } else { len }
    } else if v.kind == Kind::Leaf && v.shape == ShapeKind::Diam {
        let denom = if hw == 0.0 || hh == 0.0 {
            1.0
        } else {
            let sum = dx.abs() / hw + dy.abs() / hh;
            if sum == 0.0 { 1.0 } else { sum }
        };
        1.0 / denom
    } else {
        let kx = if dx == 0.0 { f64::INFINITY } else { hw / dx.abs() };
        let ky = if dy == 0.0 { f64::INFINITY } else { hh / dy.abs() };
        kx.min(ky)
    };
    if !k.is_finite() {
        k = 0.0;
    }
    out.push(c.x + dx * k);
    out.push(c.y + dy * k);
}

fn sign_zero(v: f64) -> i8 {
    if v > 0.0 {
        1
    } else if v < 0.0 {
        -1
    } else {
        0
    }
}

fn crosses_box(x1: f64, y1: f64, x2: f64, y2: f64, b: &BoxBounds) -> bool {
    let l = b.x - b.bw / 2.0 + 1.0;
    let r = b.x + b.bw / 2.0 - 1.0;
    let t = b.y - b.bh / 2.0 + 1.0;
    let bot = b.y + b.bh / 2.0 - 1.0;
    if (x1 < l && x2 < l) || (x1 > r && x2 > r) || (y1 < t && y2 < t) || (y1 > bot && y2 > bot) {
        return false;
    }
    if x1 == x2 || y1 == y2 {
        return true;
    }
    let dx = x2 - x1;
    let dy = y2 - y1;
    let side = |x: f64, y: f64| -> i8 { sign_zero(dx * (y - y1) - dy * (x - x1)) };
    let first = side(l, t);
    first == 0 || side(r, t) != first || side(r, bot) != first || side(l, bot) != first
}

fn hits(points: &[f64], s_idx: usize, t_idx: usize, obstacles: &[BoxBounds]) -> usize {
    let mut count = 0usize;
    for b in obstacles {
        if b.owner == Some(s_idx) || b.owner == Some(t_idx) {
            continue;
        }
        let mut i = 0;
        while i + 3 < points.len() {
            if crosses_box(points[i], points[i + 1], points[i + 2], points[i + 3], b) {
                count += 1;
                break;
            }
            i += 2;
        }
    }
    count
}

fn route_edge(views: &[View], cells: &[Cell], s_idx: usize, t_idx: usize, shift: f64, obstacles: Option<&[BoxBounds]>) -> Vec<f64> {
    let sv = &views[s_idx];
    let sc = &cells[s_idx];
    let tv = &views[t_idx];
    let tc = &cells[t_idx];

    let sl = sc.x - sv.bw / 2.0;
    let sr = sc.x + sv.bw / 2.0;
    let st = sc.y - sv.bh / 2.0;
    let sb = sc.y + sv.bh / 2.0;
    let tl = tc.x - tv.bw / 2.0;
    let tr = tc.x + tv.bw / 2.0;
    let tt = tc.y - tv.bh / 2.0;
    let tb = tc.y + tv.bh / 2.0;
    let x1 = sl.max(tl);
    let x2 = sr.min(tr);
    let y1 = st.max(tt);
    let y2 = sb.min(tb);
    let over_x = x2 - x1 > 6.0;
    let over_y = y2 - y1 > 6.0;

    if over_x && over_y {
        let s_inner = sv.bw * sv.bh <= tv.bw * tv.bh;
        let (iv, ic, ov, oc) = if s_inner { (sv, sc, tv, tc) } else { (tv, tc, sv, sc) };
        let up = (ic.y - iv.bh / 2.0) - (oc.y - ov.bh / 2.0);
        let down = (oc.y + ov.bh / 2.0) - (ic.y + iv.bh / 2.0);
        let left = (ic.x - iv.bw / 2.0) - (oc.x - ov.bw / 2.0);
        let right = (oc.x + ov.bw / 2.0) - (ic.x + iv.bw / 2.0);
        let least = up.min(down).min(left).min(right);
        let points = if least == down {
            vec![ic.x, edge_y(iv, ic, ic.x, 1.0), ic.x, oc.y + ov.bh / 2.0]
        } else if least == up {
            vec![ic.x, edge_y(iv, ic, ic.x, -1.0), ic.x, oc.y - ov.bh / 2.0]
        } else if least == right {
            vec![edge_x(iv, ic, ic.y, 1.0), ic.y, oc.x + ov.bw / 2.0, ic.y]
        } else {
            vec![edge_x(iv, ic, ic.y, -1.0), ic.y, oc.x - ov.bw / 2.0, ic.y]
        };
        return if s_inner { points } else { vec![points[2], points[3], points[0], points[1]] };
    }
    if over_x {
        let margin = 6.0f64.min((x2 - x1) / 2.0);
        let x = ((x1 + x2) / 2.0 + shift).clamp(x1 + margin, x2 - margin);
        let down = if tc.y > sc.y { 1.0 } else { -1.0 };
        return vec![x, edge_y(sv, sc, x, down), x, edge_y(tv, tc, x, -down)];
    }
    if over_y {
        let margin = 6.0f64.min((y2 - y1) / 2.0);
        let y = ((y1 + y2) / 2.0 + shift).clamp(y1 + margin, y2 - margin);
        let right = if tc.x > sc.x { 1.0 } else { -1.0 };
        return vec![edge_x(sv, sc, y, right), y, edge_x(tv, tc, y, -right), y];
    }

    let right = if tc.x > sc.x { 1.0 } else { -1.0 };
    let down = if tc.y > sc.y { 1.0 } else { -1.0 };
    let across = vec![edge_x(sv, sc, sc.y, right), sc.y, tc.x, sc.y, tc.x, edge_y(tv, tc, tc.x, -down)];
    let along = vec![sc.x, edge_y(sv, sc, sc.x, down), sc.x, tc.y, edge_x(tv, tc, tc.y, -right), tc.y];
    let wide = (tc.x - sc.x).abs() >= (tc.y - sc.y).abs();
    let (mut best, other) = if wide { (across, along) } else { (along, across) };
    let Some(obs) = obstacles else {
        return best;
    };
    let mut least = hits(&best, s_idx, t_idx, obs);
    if least == 0 {
        return best;
    }
    let count = hits(&other, s_idx, t_idx, obs);
    if count < least {
        best = other;
        least = count;
    }
    if least == 0 {
        return best;
    }
    let mut direct = Vec::with_capacity(4);
    border(sv, sc, tc.x, tc.y, &mut direct);
    border(tv, tc, sc.x, sc.y, &mut direct);
    if hits(&direct, s_idx, t_idx, obs) < least { direct } else { best }
}

fn trace(p: &[f64], mut start_trim: f64, mut end_trim: f64) -> EdgePath {
    let n = p.len();
    let sx = p[0];
    let sy = p[1];
    let ex = p[n - 2];
    let ey = p[n - 1];
    let mut ax = p[2] - sx;
    let mut ay = p[3] - sy;
    let first = ax.hypot(ay);
    let first_div = if first == 0.0 { 1.0 } else { first };
    ax /= first_div;
    ay /= first_div;
    let mut bx = ex - p[n - 4];
    let mut by = ey - p[n - 3];
    let last = bx.hypot(by);
    let last_div = if last == 0.0 { 1.0 } else { last };
    bx /= last_div;
    by /= last_div;
    if n == 4 && start_trim + end_trim > first && (start_trim + end_trim) > 0.0 {
        let scale = first / (start_trim + end_trim);
        start_trim *= scale;
        end_trim *= scale;
    }
    start_trim = start_trim.min(first);
    end_trim = end_trim.min(last);
    let mut d = format!("M{},{}", num(sx + ax * start_trim), num(sy + ay * start_trim));
    if n == 6 {
        let r = CORNER.min(first - start_trim).min(last - end_trim).max(0.0);
        d.push_str(&format!(
            "L{},{}Q{},{} {},{}",
            num(p[2] - ax * r),
            num(p[3] - ay * r),
            num(p[2]),
            num(p[3]),
            num(p[2] + bx * r),
            num(p[3] + by * r),
        ));
    }
    d.push_str(&format!("L{},{}", num(ex - bx * end_trim), num(ey - by * end_trim)));
    EdgePath {
        d,
        tokens: None,
        sx,
        sy,
        sdx: -ax,
        sdy: -ay,
        ex,
        ey,
        edx: bx,
        edy: by,
    }
}

fn loop_arc(v: &View, c: &Cell, k: usize) -> (f64, f64, f64, f64, f64) {
    let hw = v.bw / 2.0;
    let hh = v.bh / 2.0;
    let r = (10.0 + 5.0 * ((k - 1) as f64)).min(hw).min(hh).max(1.0);
    if is_round(v) {
        let px = c.x + hw * FRAC_1_SQRT_2;
        let py = c.y - hw * FRAC_1_SQRT_2;
        let ratio = if hw == 0.0 { 1.0 } else { (r / (2.0 * hw)).min(1.0) };
        let half = 2.0 * ratio.asin();
        let angle = |at: f64| -> f64 { (c.y - hw * at.sin() - py).atan2(c.x + hw * at.cos() - px) };
        return (px, py, r, angle(FRAC_PI_4 + half), angle(FRAC_PI_4 - half));
    }
    if v.kind == Kind::Leaf && v.shape == ShapeKind::Diam {
        let slope = hh.atan2(hw);
        return (c.x + hw / 2.0, c.y - hh / 2.0, r, slope + PI, slope);
    }
    (c.x + hw, c.y - hh, r, PI, FRAC_PI_2)
}

fn loop_path(v: &View, c: &Cell, k: usize, start_trim: f64, end_trim: f64) -> EdgePath {
    let (px, py, r, a1, a2) = loop_arc(v, c, k);
    let from = a1 + start_trim / r;
    let to = a2 - end_trim / r;
    let mut sweep = (to - from) % (2.0 * PI);
    if sweep <= 0.0 {
        sweep += 2.0 * PI;
    }
    let x1 = px + r * from.cos();
    let y1 = py + r * from.sin();
    let x2 = px + r * to.cos();
    let y2 = py + r * to.sin();
    let sx = px + r * a1.cos();
    let sy = py + r * a1.sin();
    let ex = px + r * a2.cos();
    let ey = py + r * a2.sin();
    let sl = (sx - x1).hypot(sy - y1);
    let el = (ex - x2).hypot(ey - y2);
    EdgePath {
        d: format!(
            "M{},{}A{},{} 0 {} 1 {},{}",
            num(x1),
            num(y1),
            num(r),
            num(r),
            if sweep > PI { 1 } else { 0 },
            num(x2),
            num(y2),
        ),
        tokens: None,
        sx,
        sy,
        sdx: if sl > 0.0 { (sx - x1) / sl } else { a1.sin() },
        sdy: if sl > 0.0 { (sy - y1) / sl } else { -a1.cos() },
        ex,
        ey,
        edx: if el > 0.0 { (ex - x2) / el } else { -a2.sin() },
        edy: if el > 0.0 { (ey - y2) / el } else { a2.cos() },
    }
}

fn covers(x: f64, y: f64, w: f64, h: f64, s_idx: usize, t_idx: usize, obstacles: Option<&[BoxBounds]>) -> bool {
    let Some(obs) = obstacles else {
        return false;
    };
    for v in obs {
        if v.owner != Some(s_idx) && v.owner != Some(t_idx) && (x - v.x).abs() < (w + v.bw) / 2.0 && (y - v.y).abs() < (h + v.bh) / 2.0 {
            return true;
        }
    }
    false
}

fn label_spot(p: &[f64], at: usize, w: f64, h: f64, s_idx: usize, t_idx: usize, obstacles: Option<&[BoxBounds]>) -> f64 {
    if obstacles.is_none() {
        return 0.5;
    }
    for spot in SPOTS {
        let x = p[at] + (p[at + 2] - p[at]) * spot;
        let y = p[at + 1] + (p[at + 3] - p[at + 1]) * spot;
        if !covers(x, y, w, h, s_idx, t_idx, obstacles) {
            return spot;
        }
    }
    0.5
}

fn stack_labels(stack: &[usize], routes: &mut [Route], legs: &[Option<[f64; 4]>], s_idx: usize, t_idx: usize, obstacles: Option<&[BoxBounds]>) -> f64 {
    let first_leg = legs[stack[0]].unwrap();
    let vertical = first_leg[0] == first_leg[2];
    let mut lo = f64::NEG_INFINITY;
    let mut hi = f64::INFINITY;
    let mut need = -LABEL_GAP;
    let mut crowded = false;
    for a in 0..stack.len() {
        let leg = legs[stack[a]].unwrap();
        if if vertical { leg[0] != leg[2] } else { leg[1] != leg[3] } {
            return 0.0;
        }
        lo = lo.max(if vertical { leg[1].min(leg[3]) } else { leg[0].min(leg[2]) });
        hi = hi.min(if vertical { leg[1].max(leg[3]) } else { leg[0].max(leg[2]) });
        let p = &routes[stack[a]];
        need += (if vertical { p.label.height } else { p.label.width + 8.0 }) + LABEL_GAP;
        for b in 0..a {
            let q = &routes[stack[b]];
            if (p.lx - q.lx).abs() < (p.label.width + q.label.width) / 2.0 + 8.0 && (p.ly - q.ly).abs() < (p.label.height + q.label.height) / 2.0 {
                crowded = true;
            }
        }
    }
    if !crowded {
        return 0.0;
    }
    if need > hi - lo - 2.0 * ARROW {
        return need - (hi - lo - 2.0 * ARROW);
    }
    let mut along: Vec<f64> = Vec::with_capacity(stack.len());
    let mut next = (lo + hi - need) / 2.0;
    for &i in stack {
        let r = &routes[i];
        let size = if vertical { r.label.height } else { r.label.width + 8.0 };
        let at = next + size / 2.0;
        let (cx, cy) = if vertical { (r.lx, at) } else { (at, r.ly) };
        if covers(cx, cy, r.label.width + 8.0, r.label.height, s_idx, t_idx, obstacles) {
            return 0.0;
        }
        along.push(at);
        next += size + LABEL_GAP;
    }
    for (&i, pos) in stack.iter().zip(along) {
        if vertical {
            routes[i].ly = pos;
        } else {
            routes[i].lx = pos;
        }
    }
    0.0
}

fn widen(
    cells: &mut [Cell],
    parents: &[Option<usize>],
    s_idx: usize,
    t_idx: usize,
    vertical: bool,
    short: f64,
    base: &mut HashMap<(usize, bool), Vec<f64>>,
) -> bool {
    let mut chain = HashSet::new();
    let mut cur = Some(s_idx);
    while let Some(v) = cur {
        chain.insert(v);
        cur = parents[v];
    }
    let mut tb: Option<usize> = None;
    let mut box_opt = Some(t_idx);
    while let Some(b) = box_opt {
        if chain.contains(&b) {
            break;
        }
        tb = Some(b);
        box_opt = parents[b];
    }
    let (Some(box_idx), Some(tb_idx)) = (box_opt, tb) else {
        return false;
    };
    if box_idx == s_idx {
        return false;
    }
    let mut sb_idx = s_idx;
    while parents[sb_idx] != Some(box_idx) {
        let Some(p) = parents[sb_idx] else {
            return false;
        };
        sb_idx = p;
    }
    let at = if vertical {
        if cells[sb_idx].row == cells[tb_idx].row {
            return false;
        }
        cells[sb_idx].row.max(cells[tb_idx].row) - 1
    } else {
        let (l, r) = if cells[sb_idx].col < cells[tb_idx].col {
            (sb_idx, tb_idx)
        } else {
            (tb_idx, sb_idx)
        };
        if cells[r].col < cells[l].col + cells[l].span {
            return false;
        }
        cells[r].col - 1
    };
    let gaps = if vertical {
        &mut cells[box_idx].row_gaps
    } else {
        &mut cells[box_idx].col_gaps
    };
    let base_entry = base.entry((box_idx, vertical)).or_insert_with(|| gaps.clone());
    let base_val = base_entry.get(at).copied().unwrap_or(0.0);
    if gaps.len() <= at {
        gaps.resize(at + 1, 0.0);
    }
    gaps[at] = gaps[at].max(base_val + short);
    true
}

pub fn render_block(model: &BlockDb, ctx: &RenderContext<'_>) -> Rendered {
    tighten(ctx.options, |tight| draw(model, ctx, tight))
}

fn style_of(model: &BlockDb, block: &Block) -> ResolvedStyle {
    let mut declarations: Vec<String> = Vec::new();
    let add = |styles: &[String], out: &mut Vec<String>| {
        for s in styles {
            for part in s.split(';') {
                out.push(part.to_string());
            }
        }
    };
    if block.classes.is_empty() {
        if let Some(def) = model.classes.get("default") {
            add(&def.styles, &mut declarations);
        }
    } else {
        for name in &block.classes {
            if let Some(def) = model.classes.get(name) {
                add(&def.styles, &mut declarations);
            }
        }
    }
    if !block.styles.is_empty() {
        add(&block.styles, &mut declarations);
    }
    resolve_style(&declarations)
}

fn draw(model: &BlockDb, ctx: &RenderContext<'_>, tight: bool) -> Rendered {
    let size = ctx.options.font_size.unwrap_or(16.0);
    let edge_size = (size * 0.875).round();
    let pad = ctx.options.padding.unwrap_or(8.0);
    let configured = ctx.config.section("block").and_then(|s| s.get("padding")).and_then(YamlValue::as_f64);
    let base_gap = match configured {
        Some(v) if v >= 0.0 => v.min(200.0),
        _ => GAP,
    };
    let gap = if tight { base_gap.min(6.0) } else { base_gap };
    let wrap = if tight { 80.0 } else { WRAP };

    let make_view = |block_idx: usize| -> (View, Cell) {
        let block = &model.nodes[block_idx];
        let btype = block.block_type.as_deref().unwrap_or("");
        let style = if btype == "space" { ResolvedStyle::default() } else { style_of(model, block) };
        let mut text_style = TextStyle::NONE;
        if style.bold {
            text_style |= TextStyle::BOLD;
        }
        if style.italic {
            text_style |= TextStyle::ITALIC;
        }
        let font_size = style.font_size.unwrap_or(size);
        let mut kind = Kind::Leaf;
        let mut shape = ShapeKind::Rect;
        let label: Label;
        let mut nw = 0.0;
        let mut nh = 0.0;
        let mut head = 0.0;
        let mut mask = 0u8;
        let mut dx = 0.0;
        let mut dy = 0.0;

        if btype == "space" {
            kind = Kind::Space;
            label = layout_label(None, false, ctx.measurer, font_size, wrap, TextStyle::NONE, ctx.icons, ctx.math);
        } else if btype == "composite" {
            kind = Kind::Composite;
            let max_w = if tight { title_room(ctx.options) } else { 4000.0 };
            label = layout_label(block.label.as_deref(), false, ctx.measurer, font_size, max_w, text_style, ctx.icons, ctx.math);
            head = if label.height > 0.0 { label.height + 4.0 } else { 0.0 };
            nw = label.width + 2.0 * gap;
            nh = head + 2.0 * gap;
        } else if btype == "block_arrow" {
            kind = Kind::Arrow;
            label = layout_label(block.label.as_deref(), false, ctx.measurer, font_size, wrap, text_style, ctx.icons, ctx.math);
            let mut blank = true;
            for line in &label.lines {
                for part in line {
                    if part.icon.is_some() || !part.text.trim().is_empty() {
                        blank = false;
                    }
                }
            }
            mask = arrow_mask(&block.directions);
            let s = if blank {
                arrow_size(mask, 0.0, 0.0)
            } else {
                arrow_size(mask, label.width, label.height)
            };
            nw = s.w;
            nh = s.h;
            dx = s.dx;
            dy = s.dy;
        } else {
            shape = block_shape(btype);
            label = layout_label(block.label.as_deref(), false, ctx.measurer, font_size, wrap, text_style, ctx.icons, ctx.math);
            let s = shape_size(shape, label.width, label.height);
            nw = s.w;
            nh = if shape == ShapeKind::Cyl { s.h.max(label.height + 40.0) } else { s.h };
            dy = s.dy;
        }

        let span = if kind == Kind::Space { 1 } else { block.width_in_columns.unwrap_or(1) };
        let mut c = cell(nw, nh, span);
        c.columns = if kind == Kind::Composite { block.columns.unwrap_or(-1.0) } else { -1.0 };
        c.space = kind == Kind::Space;
        c.head = head;

        let view = View {
            block_idx,
            kind,
            shape,
            label,
            style,
            mask,
            dx,
            dy,
            bw: 0.0,
            bh: 0.0,
        };
        (view, c)
    };

    let (root_view, mut root_cell) = make_view(0);
    root_cell.nw = 0.0;
    root_cell.nh = 0.0;
    let mut views = vec![root_view];
    let mut cells = vec![root_cell];
    let mut parents: Vec<Option<usize>> = vec![None];
    let mut by_id: HashMap<String, usize> = HashMap::new();

    let mut i = 0;
    while i < views.len() {
        if views[i].kind == Kind::Composite {
            let b_idx = views[i].block_idx;
            for &child_block_idx in &model.nodes[b_idx].children {
                let (v, c) = make_view(child_block_idx);
                let v_idx = views.len();
                let is_space = v.kind == Kind::Space;
                views.push(v);
                cells.push(c);
                parents.push(Some(i));
                cells[i].children.push(v_idx);
                if !is_space {
                    by_id.insert(model.nodes[child_block_idx].id.clone(), v_idx);
                }
            }
        }
        i += 1;
    }

    let widths: Vec<f64> = cells.iter().map(|c| c.nw).collect();
    let mut obstacles: Vec<BoxBounds> = Vec::new();
    let mut titles: Vec<BoxBounds> = Vec::new();

    let place = |views: &mut [View], cells: &mut [Cell], obstacles: &mut Vec<BoxBounds>, titles: &mut Vec<BoxBounds>| -> (f64, f64) {
        for (idx, &w) in widths.iter().enumerate() {
            cells[idx].nw = w;
        }
        let content = layout(cells, 0, gap).unwrap_or((0.0, 0.0));
        obstacles.clear();
        titles.clear();
        for idx in 0..views.len() {
            let c = &cells[idx];
            let v = &mut views[idx];
            if v.kind == Kind::Leaf && is_fixed(v.shape) {
                v.bw = c.nw;
                v.bh = c.nh;
            } else if v.kind == Kind::Arrow {
                v.bw = if c.span > 1 { c.w } else { c.nw };
                v.bh = c.nh;
            } else {
                v.bw = c.w;
                v.bh = if v.kind == Kind::Leaf && is_wide(v.shape) { c.nh } else { c.h };
            }
            if v.kind == Kind::Leaf && v.shape == ShapeKind::Cyl {
                v.dy = (v.bw / 14.0).clamp(6.0, 12.0) / 2.0;
            }
            if matches!(v.kind, Kind::Leaf | Kind::Arrow) {
                obstacles.push(BoxBounds {
                    owner: Some(idx),
                    x: c.x,
                    y: c.y,
                    bw: v.bw,
                    bh: v.bh,
                });
            } else if c.head > 0.0 {
                titles.push(BoxBounds {
                    owner: None,
                    x: c.x,
                    y: c.y - c.h / 2.0 + (c.head + gap) / 2.0 + 2.0,
                    bw: v.label.width,
                    bh: v.label.height,
                });
            }
        }
        content
    };

    let mut content = place(&mut views, &mut cells, &mut obstacles, &mut titles);

    let mut pairs: HashMap<usize, usize> = HashMap::new();
    let mut labelled: HashSet<usize> = HashSet::new();
    let mut ends: Vec<(usize, usize)> = Vec::new();
    let mut drawn: Vec<usize> = Vec::new();
    let order_len = views.len();

    for (edge_idx, edge) in model.edges.iter().enumerate() {
        let Some(&s) = edge.start.as_deref().and_then(|id| by_id.get(id)) else {
            continue;
        };
        let Some(&t) = edge.end.as_deref().and_then(|id| by_id.get(id)) else {
            continue;
        };
        let key = s.min(t) * order_len + s.max(t);
        *pairs.entry(key).or_insert(0) += 1;
        if edge.label.as_deref().is_some_and(|l| !l.is_empty()) {
            labelled.insert(key);
        }
        ends.push((s, t));
        drawn.push(edge_idx);
    }

    let use_check = drawn.len().saturating_mul(obstacles.len()) <= OBSTACLE_BUDGET;
    let mut routes: Vec<Route> = Vec::new();
    let mut stacks: IndexMap<usize, Vec<usize>> = IndexMap::new();
    let mut legs: Vec<Option<[f64; 4]>> = vec![None; drawn.len()];

    let compute_routes = |views: &[View],
                          cells: &[Cell],
                          obstacles: &[BoxBounds],
                          routes: &mut Vec<Route>,
                          stacks: &mut IndexMap<usize, Vec<usize>>,
                          legs: &mut [Option<[f64; 4]>]| {
        let check = if use_check { Some(obstacles) } else { None };
        let mut seen: HashMap<usize, usize> = HashMap::new();
        routes.clear();
        stacks.clear();
        for leg in legs.iter_mut() {
            *leg = None;
        }
        for i in 0..drawn.len() {
            let (s, t) = ends[i];
            let edge = &model.edges[drawn[i]];
            let key = s.min(t) * order_len + s.max(t);
            let total_pair = pairs.get(&key).copied().unwrap_or(1);
            let k = seen.get(&key).copied().unwrap_or(0);
            seen.insert(key, k + 1);
            let label = layout_label(
                edge.label.as_deref(),
                false,
                ctx.measurer,
                edge_size,
                WRAP,
                TextStyle::NONE,
                ctx.icons,
                ctx.math,
            );
            let (points, lx, ly) = if s == t {
                let (px, py, r, _, _) = loop_arc(&views[s], &cells[s], k + 1);
                (Vec::new(), px + r + 6.0 + label.width / 2.0, py - r / 2.0)
            } else {
                let step = if labelled.contains(&key) { (edge_size * 1.5).round() + 2.0 } else { 14.0 };
                let shift = (k as f64 - (total_pair as f64 - 1.0) / 2.0) * step;
                let points = route_edge(views, cells, s, t, shift, check);
                let n = points.len();
                let first_leg = (points[2] - points[0]).abs() + (points[3] - points[1]).abs();
                let last_leg = (points[n - 2] - points[n - 4]).abs() + (points[n - 1] - points[n - 3]).abs();
                let at = if n == 6 && last_leg > first_leg { 2 } else { 0 };
                let spot = if label.width > 0.0 {
                    label_spot(&points, at, label.width + 8.0, label.height, s, t, check)
                } else {
                    0.5
                };
                let lx = points[at] + (points[at + 2] - points[at]) * spot;
                let ly = points[at + 1] + (points[at + 3] - points[at + 1]) * spot;
                if label.width > 0.0 && total_pair > 1 {
                    legs[i] = Some([points[at], points[at + 1], points[at + 2], points[at + 3]]);
                    stacks.entry(key).or_default().push(i);
                }
                (points, lx, ly)
            };
            routes.push(Route {
                edge_idx: drawn[i],
                points,
                loop_k: if s == t { k + 1 } else { 0 },
                label,
                lx,
                ly,
            });
        }
    };

    let settle = |grow: bool,
                  views: &[View],
                  cells: &mut [Cell],
                  obstacles: &[BoxBounds],
                  titles: &[BoxBounds],
                  routes: &mut Vec<Route>,
                  stacks: &mut IndexMap<usize, Vec<usize>>,
                  legs: &mut [Option<[f64; 4]>]|
     -> bool {
        compute_routes(views, cells, obstacles, routes, stacks, legs);
        let blocked_vec: Option<Vec<BoxBounds>> = if use_check {
            let mut v = Vec::with_capacity(obstacles.len() + titles.len());
            v.extend_from_slice(obstacles);
            v.extend_from_slice(titles);
            Some(v)
        } else {
            None
        };
        let blocked = blocked_vec.as_deref();
        let mut base: HashMap<(usize, bool), Vec<f64>> = HashMap::new();
        let mut grown = false;
        for stack in stacks.values() {
            if stack.len() < 2 {
                continue;
            }
            let (s, t) = ends[stack[0]];
            let short = stack_labels(stack, routes, legs, s, t, blocked);
            let leg0 = legs[stack[0]].unwrap();
            let vertical = leg0[0] == leg0[2];
            if grow && short > 0.0 && (vertical || !tight) && widen(cells, &parents, s, t, vertical, short.ceil(), &mut base) {
                grown = true;
            }
        }
        grown
    };

    let overlap = |routes: &[Route]| -> f64 {
        let mut area = 0.0;
        for i in 0..routes.len() {
            let p = &routes[i];
            if p.label.width <= 0.0 {
                continue;
            }
            let pw = (p.label.width + 8.0) / 2.0;
            for q in &routes[i + 1..] {
                if q.label.width <= 0.0 {
                    continue;
                }
                let qw = (q.label.width + 8.0) / 2.0;
                let w = (p.lx + pw).min(q.lx + qw) - (p.lx - pw).max(q.lx - qw);
                let h = (p.ly + p.label.height / 2.0).min(q.ly + q.label.height / 2.0) - (p.ly - p.label.height / 2.0).max(q.ly - q.label.height / 2.0);
                if w > 0.0 && h > 0.0 {
                    area += w * h;
                }
            }
        }
        area
    };

    let bound = |content: (f64, f64), views: &[View], cells: &[Cell], routes: &[Route]| -> (f64, f64, f64, f64) {
        let mut min_x = 0.0f64;
        let mut min_y = 0.0f64;
        let mut max_x = content.0;
        let mut max_y = content.1;
        let mut grow_box = |x: f64, y: f64, w: f64, h: f64| {
            min_x = min_x.min(x - w / 2.0);
            max_x = max_x.max(x + w / 2.0);
            min_y = min_y.min(y - h / 2.0);
            max_y = max_y.max(y + h / 2.0);
        };
        for (i, r) in routes.iter().enumerate() {
            if r.loop_k > 0 {
                let s = ends[i].0;
                let (px, py, rad, _, _) = loop_arc(&views[s], &cells[s], r.loop_k);
                grow_box(px, py, 2.0 * rad + 2.0, 2.0 * rad + 2.0);
            }
            if r.label.width > 0.0 {
                grow_box(r.lx, r.ly, r.label.width + 8.0, r.label.height);
            }
        }
        (min_x, min_y, max_x, max_y)
    };

    let can_grow = drawn.len().saturating_mul(drawn.len()) <= OBSTACLE_BUDGET;
    if settle(can_grow, &views, &mut cells, &obstacles, &titles, &mut routes, &mut stacks, &mut legs) {
        let before = overlap(&routes);
        let (bmin_x, _, bmax_x, _) = bound(content, &views, &cells, &routes);
        let narrow = bmax_x - bmin_x;
        let mut grown = true;
        for round in 0..3 {
            if !grown {
                break;
            }
            content = place(&mut views, &mut cells, &mut obstacles, &mut titles);
            grown = settle(round < 2, &views, &mut cells, &obstacles, &titles, &mut routes, &mut stacks, &mut legs);
        }
        let (wmin_x, _, wmax_x, _) = bound(content, &views, &cells, &routes);
        let wide = wmax_x - wmin_x;
        let room = match ctx.options.max_width {
            Some(mw) if mw > 0.0 => mw,
            _ => f64::INFINITY,
        };
        if overlap(&routes) > before - 1.0 || (wide > narrow && (wide + 2.0 * pad).ceil() > room) {
            for c in &mut cells {
                c.row_gaps.clear();
                c.col_gaps.clear();
            }
            content = place(&mut views, &mut cells, &mut obstacles, &mut titles);
            let _ = settle(false, &views, &mut cells, &obstacles, &titles, &mut routes, &mut stacks, &mut legs);
        }
    }

    let (min_x, min_y, max_x, max_y) = bound(content, &views, &cells, &routes);
    let title = title_label(model.title.as_deref(), ctx.measurer, size, if tight { title_room(ctx.options) } else { 4000.0 });
    let title_height = if title.height > 0.0 { title.height + 12.0 } else { 0.0 };
    let inner = (max_x - min_x).max(title.width);
    let ox = pad - min_x + (inner - (max_x - min_x)) / 2.0;
    let oy = pad + title_height - min_y;
    for c in &mut cells {
        c.x += ox;
        c.y += oy;
    }
    let width = (inner + 2.0 * pad).ceil();
    let height = (max_y - min_y + title_height + 2.0 * pad).ceil();

    let shape_attrs = ctx.theme.shape_attrs();
    let line_attrs = ctx.theme.line_attrs();
    let mut clusters = String::new();
    let mut nodes_out = String::new();
    let mut fills: Vec<Fill> = Vec::new();

    for idx in 1..views.len() {
        let v = &views[idx];
        if v.kind == Kind::Space {
            continue;
        }
        let c = &cells[idx];
        let block = &model.nodes[v.block_idx];
        let classes = class_names(&block.classes.join(" "));
        let id = esc_text(&block.id);

        if v.kind == Kind::Composite {
            let top = c.y - c.h / 2.0;
            if paints(&v.style.shape) {
                fills.push(Fill {
                    bounds: [c.x - c.w / 2.0, top, c.x + c.w / 2.0, top + c.h],
                    shape: v.style.shape.clone(),
                });
            }
            let fill_opacity = if sets_fill(&v.style.shape) { "" } else { r#" fill-opacity="0.5""# };
            let title_fill = ink_fill(&v.style.shape, &v.style.text, ctx.theme, Some(ctx.theme.muted()));
            clusters.push_str(&format!(
                r#"<g class="pele-cluster{classes}" data-id="{id}"><rect x="{}" y="{}" width="{}" height="{}" fill="{}"{fill_opacity} stroke="{}"{}/>{}</g>"#,
                num(c.x - c.w / 2.0),
                num(top),
                num(c.w),
                num(c.h),
                ctx.theme.surface_alt(),
                ctx.theme.border(),
                ctx.theme.rounded(&v.style.shape),
                label_svg(
                    &v.label,
                    c.x,
                    top + (c.head + gap) / 2.0 + 2.0,
                    &format!(r#" class="pele-cluster-label"{title_fill}{}"#, v.style.text),
                    ctx.theme,
                    ctx.icons,
                ),
            ));
            continue;
        }

        let arrow = v.kind == Kind::Arrow;
        let rewrapped: Option<Label> = if c.span > 1 && v.label.width > 0.0 && v.label.lines.len() > 1 && v.bw > c.nw && (arrow || !is_fixed(v.shape)) {
            let mut text_style = TextStyle::NONE;
            if v.style.bold {
                text_style |= TextStyle::BOLD;
            }
            if v.style.italic {
                text_style |= TextStyle::ITALIC;
            }
            let room = v.label.width + (v.bw - c.nw);
            Some(layout_label(
                block.label.as_deref(),
                false,
                ctx.measurer,
                v.label.size,
                room,
                text_style,
                ctx.icons,
                ctx.math,
            ))
        } else {
            None
        };
        let drawn_label = rewrapped.as_ref().unwrap_or(&v.label);
        let shape_full = format!("{shape_attrs}{}", v.style.shape);
        let line_full = format!("{line_attrs}{}", v.style.line);
        let shape_svg = if arrow {
            draw_arrow(v.mask, v.bw, v.bh, &shape_full)
        } else {
            draw_shape(v.shape, v.bw, v.bh, &shape_full, &line_full, ctx.theme)
        };
        let ink = if arrow || shape_filled(v.shape) {
            ink_fill(&v.style.shape, &v.style.text, ctx.theme, None)
        } else {
            String::new()
        };
        let shape_name = if arrow { "block-arrow" } else { v.shape.as_str() };
        nodes_out.push_str(&format!(
            r#"<g class="pele-node pele-shape-{shape_name}{classes}" data-id="{id}" transform="translate({},{})">{shape_svg}{}</g>"#,
            num(c.x),
            num(c.y),
            label_svg(
                drawn_label,
                v.dx,
                v.dy,
                &format!(r#" class="pele-label"{ink}{}"#, v.style.text),
                ctx.theme,
                ctx.icons,
            ),
        ));
    }

    let mut casings = String::new();
    let mut edges_out = String::new();
    let mut labels_out = String::new();

    for (i, r) in routes.iter_mut().enumerate() {
        let edge = &model.edges[r.edge_idx];
        let start_type = edge.arrow_type_start.as_deref().unwrap_or("");
        let end_type = edge.arrow_type_end.as_deref().unwrap_or("");
        let path = if r.loop_k > 0 {
            let s = ends[i].0;
            loop_path(&views[s], &cells[s], r.loop_k, marker_trim(start_type), marker_trim(end_type))
        } else {
            let mut k = 0;
            while k + 1 < r.points.len() {
                r.points[k] += ox;
                r.points[k + 1] += oy;
                k += 2;
            }
            trace(&r.points, marker_trim(start_type), marker_trim(end_type))
        };
        let over = over_fills(&path.d, &[path.sx, path.sy, path.ex, path.ey], &fills, "", path.tokens.as_deref(), ctx.theme);
        let (color, stroke_override) = match &over {
            OverFill::Ink(c) => (c.clone(), format!(r#" stroke="{c}""#)),
            OverFill::Casing => {
                casings.push_str(&edge_casing(
                    &path,
                    start_type,
                    end_type,
                    "",
                    edge.thickness.as_deref() == Some("thick"),
                    ctx.theme,
                ));
                (ctx.theme.line().to_string(), String::new())
            }
            OverFill::None => (ctx.theme.line().to_string(), String::new()),
        };
        let thick_attr = if edge.thickness.as_deref() == Some("thick") {
            r#" stroke-width="2.5""#
        } else {
            ""
        };
        let dash_attr = if edge.pattern.as_deref() == Some("dotted") {
            r#" stroke-dasharray="3 4""#
        } else {
            ""
        };
        let bg = ctx.theme.bg();
        edges_out.push_str(&format!(
            r#"<g class="pele-edge" data-id="{}"{stroke_override}><path d="{}"{thick_attr}{dash_attr}/>{}{}</g>"#,
            esc_text(&edge.id),
            path.d,
            marker(start_type, path.sx, path.sy, path.sdx, path.sdy, &color, bg),
            marker(end_type, path.ex, path.ey, path.edx, path.edy, &color, bg),
        ));
        if r.label.width > 0.0 {
            let x = r.lx + ox;
            let y = r.ly + oy;
            labels_out.push_str(&edge_label_svg(&edge.id, &r.label, x, y, "", ctx.theme, ctx.icons));
        }
    }

    let title_attrs = format!(r#" class="pele-title" font-weight="{}""#, ctx.theme.title_weight());
    let mut svg_body = String::new();
    svg_body.push_str(&label_svg(&title, width / 2.0, pad + title.height / 2.0, &title_attrs, ctx.theme, ctx.icons));
    if !clusters.is_empty() {
        svg_body.push_str(&format!(r#"<g class="pele-clusters">{clusters}</g>"#));
    }
    svg_body.push_str(&casings_svg(&casings, ctx.theme));
    if !edges_out.is_empty() {
        svg_body.push_str(&format!(
            r#"<g class="pele-edges" fill="none" stroke="{}" stroke-linecap="round">{edges_out}</g>"#,
            ctx.theme.line(),
        ));
    }
    svg_body.push_str(&format!(r#"<g class="pele-nodes">{nodes_out}</g>"#));
    if !labels_out.is_empty() {
        svg_body.push_str(&format!(r#"<g class="pele-edge-labels" font-size="{}">{labels_out}</g>"#, num(edge_size)));
    }

    let svg = svg_document(
        "block",
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
        &svg_body,
    );

    Rendered {
        svg,
        width,
        height,
        links: Vec::new(),
    }
}
