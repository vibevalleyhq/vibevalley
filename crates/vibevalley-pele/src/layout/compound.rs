use std::collections::{HashMap, HashSet};

use super::layered::{Groups, Kind, LEdge, LNode, LayeredOptions, LayeredResult, ease, layered, ledge, lnode, orient, rank};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dir {
    TB,
    BT,
    LR,
    RL,
}

impl Dir {
    #[inline]
    pub fn is_vertical(self) -> bool {
        match self {
            Dir::TB | Dir::BT => true,
            Dir::LR | Dir::RL => false,
        }
    }

    #[inline]
    pub fn is_flipped(self) -> bool {
        match self {
            Dir::BT | Dir::RL => true,
            Dir::TB | Dir::LR => false,
        }
    }
}

/// The direction a diagram names, or top-to-bottom for anything else.
pub fn direction(dir: Option<&str>) -> Dir {
    match dir {
        Some("BT") => Dir::BT,
        Some("LR") => Dir::LR,
        Some("RL") => Dir::RL,
        _ => Dir::TB,
    }
}

#[derive(Debug, Clone)]
pub struct CNode {
    pub w: f64,
    pub h: f64,
    pub parent: i32,
    pub is_group: bool,
    pub dir: Option<Dir>,
    pub pad_x: f64,
    pub pad_top: f64,
    pub pad_bottom: f64,
    pub min_w: f64,
    /// Declaration order; a group takes the smallest value among its members.
    pub seq: usize,
    /// How much of a side its edges may spread along, measured across the flow; 0 keeps them at its middle.
    pub span: f64,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone)]
pub struct CEdge {
    pub src: usize,
    pub dst: usize,
    pub minlen: i32,
    pub label_w: f64,
    pub label_h: f64,
    /// x, y, axis triples; axis is 0 where the edge runs vertically into the point, 1 horizontally.
    pub route: Vec<f64>,
    pub label_x: f64,
    pub label_y: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct CompoundResult {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Side {
    Top,
    Right,
    Bottom,
    Left,
}

impl Side {
    fn opposite(self) -> Self {
        match self {
            Side::Top => Side::Bottom,
            Side::Right => Side::Left,
            Side::Bottom => Side::Top,
            Side::Left => Side::Right,
        }
    }
}

fn start_side(dir: Dir) -> Side {
    match dir {
        Dir::TB => Side::Top,
        Dir::BT => Side::Bottom,
        Dir::LR => Side::Left,
        Dir::RL => Side::Right,
    }
}

#[derive(Debug, Clone)]
struct PortEdge {
    e: usize,
    inner: usize,
    out: bool,
    side: Side,
    hint: f64,
    px: f64,
    py: f64,
    route: Vec<f64>,
}

#[derive(Debug, Clone, Copy)]
struct LevelEdge {
    e: usize,
    a: usize,
    b: usize,
}

#[derive(Debug, Clone)]
struct Level {
    id: i32,
    dir: Dir,
    items: Vec<usize>,
    edges: Vec<LevelEdge>,
    ports: Vec<PortEdge>,
    port_of: HashMap<usize, usize>,
    routes: HashMap<usize, Vec<f64>>,
    x: f64,
    y: f64,
}

impl Level {
    fn new(id: i32, dir: Dir) -> Self {
        Self {
            id,
            dir,
            items: Vec::new(),
            edges: Vec::new(),
            ports: Vec::new(),
            port_of: HashMap::new(),
            routes: HashMap::new(),
            x: 0.0,
            y: 0.0,
        }
    }
}

const MAX_PORTS: usize = 40_000;
const MAX_ORDERED_PORTS: usize = 400;
const MAX_ORDERED_EDGES: usize = 500;
const FLAT_SLACK: f64 = 1.5;
const FLAT_SPARE: f64 = 4.0;

struct Snapshot {
    nodes: Vec<f64>,
    routes: Vec<Vec<f64>>,
    labels: Vec<f64>,
    levels: Vec<f64>,
    total: CompoundResult,
}

fn snapshot(nodes: &[CNode], edges: &[CEdge], levels: &[Level], total: CompoundResult) -> Snapshot {
    let mut at = Vec::with_capacity(nodes.len() * 4);
    for c in nodes {
        at.push(c.x);
        at.push(c.y);
        at.push(c.w);
        at.push(c.h);
    }
    let mut labels = Vec::with_capacity(edges.len() * 2);
    for e in edges {
        labels.push(e.label_x);
        labels.push(e.label_y);
    }
    let mut places = Vec::new();
    for level in levels {
        places.push(level.x);
        places.push(level.y);
        for port in &level.ports {
            places.push(port.px);
            places.push(port.py);
        }
    }
    Snapshot {
        nodes: at,
        routes: edges.iter().map(|e| e.route.clone()).collect(),
        labels,
        levels: places,
        total,
    }
}

fn restore(s: Snapshot, nodes: &mut [CNode], edges: &mut [CEdge], levels: &mut [Level]) -> CompoundResult {
    for (i, c) in nodes.iter_mut().enumerate() {
        c.x = s.nodes[4 * i];
        c.y = s.nodes[4 * i + 1];
        c.w = s.nodes[4 * i + 2];
        c.h = s.nodes[4 * i + 3];
    }
    for (i, (e, route)) in edges.iter_mut().zip(s.routes).enumerate() {
        e.route = route;
        e.label_x = s.labels[2 * i];
        e.label_y = s.labels[2 * i + 1];
    }
    let mut k = 0;
    for level in levels.iter_mut() {
        level.x = s.levels[k];
        level.y = s.levels[k + 1];
        k += 2;
        for port in &mut level.ports {
            port.px = s.levels[k];
            port.py = s.levels[k + 1];
            k += 2;
        }
    }
    s.total
}

const FAN: f64 = 24.0;
const IN_LINE: f64 = 0.5;
const CURVE_PIECES: usize = 3;
const CORNER_PIECES: usize = 2;
const STEP_PIECES: usize = 3; // max(3, CURVE_PIECES, CORNER_PIECES + 1)
const HANDLE: f64 = 0.62;
const MAX_INSERT: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteStyle {
    Curved,
    Stepped,
    Linear,
}

pub fn style_of(opt: &LayeredOptions) -> RouteStyle {
    if opt.tracks {
        RouteStyle::Stepped
    } else if opt.straight {
        RouteStyle::Linear
    } else {
        RouteStyle::Curved
    }
}

pub fn route_crossings(nodes: &[CNode], edges: &[CEdge], style: RouteStyle) -> usize {
    let mut size = 0usize;
    for e in edges {
        if e.src != e.dst && e.route.len() > 3 {
            size += (e.route.len() / 3 - 1) * STEP_PIECES;
        }
    }
    let mut ax = vec![0.0f64; size];
    let mut ay = vec![0.0f64; size];
    let mut bx = vec![0.0f64; size];
    let mut by = vec![0.0f64; size];
    let mut low = vec![0.0f64; size];
    let mut high = vec![0.0f64; size];
    let mut owner = vec![0usize; size];
    let mut ends = vec![0u8; size];
    let mut count = 0usize;
    let mut top = f64::INFINITY;
    let mut bottom = f64::NEG_INFINITY;
    let mut from_x = f64::NAN;
    let mut from_y = f64::NAN;
    let mut to_x = f64::NAN;
    let mut to_y = f64::NAN;

    let mut add = |ei: usize, part: u8, mut x0: f64, mut y0: f64, x1: f64, y1: f64| {
        if count > 0 {
            let p = count - 1;
            let on = x0 == to_x && y0 == to_y && ((y1 == y0 && from_y == y0) || (x1 == x0 && from_x == x0));
            if on && owner[p] == ei && ends[p] == part && (x0 - from_x) * (x1 - x0) + (y0 - from_y) * (y1 - y0) > 0.0 {
                count -= 1;
                x0 = from_x;
                y0 = from_y;
            }
        }
        from_x = x0;
        from_y = y0;
        to_x = x1;
        to_y = y1;
        ends[count] = part;
        ax[count] = x0.min(x1);
        bx[count] = x0.max(x1);
        ay[count] = if x0 <= x1 { y0 } else { y1 };
        by[count] = if x0 <= x1 { y1 } else { y0 };
        low[count] = y0.min(y1);
        high[count] = y0.max(y1);
        if low[count] < top {
            top = low[count];
        }
        if high[count] > bottom {
            bottom = high[count];
        }
        owner[count] = ei;
        count += 1;
    };

    for (ei, e) in edges.iter().enumerate() {
        if e.src == e.dst || e.route.len() < 6 {
            continue;
        }
        let r = &e.route;
        let aligned = |k: usize| -> bool { (r[k] - r[k - 3]).abs() < 0.01 || (r[k + 1] - r[k - 2]).abs() < 0.01 };
        let length = |k: usize| -> f64 { (r[k] - r[k - 3]).abs() + (r[k + 1] - r[k - 2]).abs() };
        let turns = |k: usize| -> bool {
            style == RouteStyle::Curved
                && k > 0
                && k < r.len() - 3
                && aligned(k)
                && aligned(k + 3)
                && length(k) >= 0.01
                && length(k + 3) >= 0.01
                && ((r[k] - r[k - 3]).abs() < 0.01) != ((r[k + 3] - r[k]).abs() < 0.01)
        };
        let mut at_x = r[0];
        let mut at_y = r[1];
        let mut k = 3usize;
        while k < r.len() {
            let part = u8::from(k == 3) | (u8::from(k == r.len() - 3) << 1);
            let x0 = at_x;
            let y0 = at_y;
            let x1 = r[k];
            let y1 = r[k + 1];
            at_x = x1;
            at_y = y1;
            if aligned(k) || style == RouteStyle::Linear {
                if !turns(k) {
                    add(ei, part, x0, y0, x1, y1);
                    k += 3;
                    continue;
                }
                let lk = length(k);
                let lnext = length(k + 3);
                let before = if k >= 6 && turns(k - 3) { lk / 2.0 } else { lk };
                let after = if turns(k + 3) { lnext / 2.0 } else { lnext };
                let ux = (x1 - r[k - 3]) / lk;
                let uy = (y1 - r[k - 2]) / lk;
                let vx = (r[k + 3] - x1) / lnext;
                let vy = (r[k + 4] - y1) / lnext;
                let sx = x1 - ux * before;
                let sy = y1 - uy * before;
                add(ei, part, x0, y0, sx, sy);
                let c1x = x1 - ux * before * (1.0 - HANDLE);
                let c1y = y1 - uy * before * (1.0 - HANDLE);
                let c2x = x1 + vx * after * (1.0 - HANDLE);
                let c2y = y1 + vy * after * (1.0 - HANDLE);
                at_x = x1 + vx * after;
                at_y = y1 + vy * after;
                let turn = part | (u8::from(k + 3 == r.len() - 3) << 1);
                let mut px = sx;
                let mut py = sy;
                for i in 1..=CORNER_PIECES {
                    let t = (i as f64) / (CORNER_PIECES as f64);
                    let u = 1.0 - t;
                    let x = u * u * u * sx + 3.0 * u * u * t * c1x + 3.0 * u * t * t * c2x + t * t * t * at_x;
                    let y = u * u * u * sy + 3.0 * u * u * t * c1y + 3.0 * u * t * t * c2y + t * t * t * at_y;
                    add(ei, turn, px, py, x, y);
                    px = x;
                    py = y;
                }
                k += 3;
                continue;
            }
            if style == RouteStyle::Stepped {
                let down = r[k + 2] == 0.0;
                let mx = if down { x0 } else { (x0 + x1) / 2.0 };
                let my = if down { (y0 + y1) / 2.0 } else { y0 };
                add(ei, part, x0, y0, mx, my);
                add(ei, part, mx, my, if down { x1 } else { mx }, if down { my } else { y1 });
                add(ei, part, if down { x1 } else { mx }, if down { my } else { y1 }, x1, y1);
                k += 3;
                continue;
            }
            let down = r[k + 2] == 0.0;
            let c = if down { ease(x1 - x0, y1 - y0) } else { ease(y1 - y0, x1 - x0) };
            let mut px = x0;
            let mut py = y0;
            for i in 1..=CURVE_PIECES {
                let t = (i as f64) / (CURVE_PIECES as f64);
                let u = 1.0 - t;
                let across = t * t * (3.0 - 2.0 * t);
                let along = 3.0 * c * t * u * u + 3.0 * (1.0 - c) * t * t * u + t * t * t;
                let x = x0 + (x1 - x0) * if down { across } else { along };
                let y = y0 + (y1 - y0) * if down { along } else { across };
                add(ei, part, px, py, x, y);
                px = x;
                py = y;
            }
            k += 3;
        }
    }

    if count < 2 {
        return 0;
    }

    let bands = if bottom > top { ((count as f64).sqrt().round() as usize).max(1) } else { 1 };
    let scale = if bottom > top { (bands as f64) / (bottom - top) } else { 0.0 };
    let band_of = |y: f64| -> usize {
        let raw = ((y - top) * scale).floor();
        if raw <= 0.0 { 0 } else { (raw as usize).min(bands - 1) }
    };
    let mut first = vec![0usize; count];
    let mut band_start = vec![0usize; bands + 1];
    for p in 0..count {
        first[p] = band_of(low[p]);
        let last = band_of(high[p]);
        for b in first[p]..=last {
            band_start[b + 1] += 1;
        }
    }
    for b in 0..bands {
        band_start[b + 1] += band_start[b];
    }
    let mut fill = band_start[..bands].to_vec();
    let mut in_band = vec![0usize; band_start[bands]];
    for p in 0..count {
        let last = band_of(high[p]);
        for b in first[p]..=last {
            in_band[fill[b]] = p;
            fill[b] += 1;
        }
    }

    let mut runs = vec![0.0f64; edges.len() * 8];
    let in_line_pts = |r: &[f64], a: usize, b: usize, c: usize| -> bool {
        ((r[a] - r[b]).abs() < IN_LINE && (r[a] - r[c]).abs() < IN_LINE) || ((r[a + 1] - r[b + 1]).abs() < IN_LINE && (r[a + 1] - r[c + 1]).abs() < IN_LINE)
    };
    for (ei, e) in edges.iter().enumerate() {
        let r = &e.route;
        if r.len() < 6 {
            continue;
        }
        let mut k = 3usize;
        while k + 3 < r.len() && in_line_pts(r, 0, k, k + 3) {
            k += 3;
        }
        let last = r.len() - 3;
        let mut j = last - 3;
        while j >= 3 && in_line_pts(r, last, j, j - 3) {
            j -= 3;
        }
        let o = ei * 8;
        runs[o] = r[0];
        runs[o + 1] = r[1];
        runs[o + 2] = r[k];
        runs[o + 3] = r[k + 1];
        runs[o + 4] = r[j];
        runs[o + 5] = r[j + 1];
        runs[o + 6] = r[last];
        runs[o + 7] = r[last + 1];
    }
    let on_run = |ei: usize, end: u8, x: f64, y: f64| -> bool {
        let o = ei * 8 + if end == 1 { 0 } else { 4 };
        let x0 = runs[o];
        let y0 = runs[o + 1];
        let dx = runs[o + 2] - x0;
        let dy = runs[o + 3] - y0;
        let len_sq = dx * dx + dy * dy;
        let t = if len_sq > 0.0 {
            (((x - x0) * dx + (y - y0) * dy) / len_sq).clamp(0.0, 1.0)
        } else {
            0.0
        };
        (x - x0 - t * dx).hypot(y - y0 - t * dy) < IN_LINE
    };

    let mut total = 0usize;
    for band in 0..bands {
        let b_start = band_start[band];
        let b_end = band_start[band + 1];
        if b_end - b_start > MAX_INSERT {
            in_band[b_start..b_end].sort_by(|&p, &q| ax[p].total_cmp(&ax[q]).then_with(|| p.cmp(&q)));
        } else {
            for i in (b_start + 1)..b_end {
                let p = in_band[i];
                let mut j = i;
                while j > b_start && ax[in_band[j - 1]] > ax[p] {
                    in_band[j] = in_band[j - 1];
                    j -= 1;
                }
                in_band[j] = p;
            }
        }
        for s in b_start..b_end {
            let p = in_band[s];
            let dx = bx[p] - ax[p];
            let dy = by[p] - ay[p];
            let here = first[p] == band;
            for &q in &in_band[(s + 1)..b_end] {
                if ax[q] > bx[p] {
                    break;
                }
                if high[q] < low[p] || low[q] > high[p] || owner[p] == owner[q] || (!here && first[q] != band) {
                    continue;
                }
                let d1 = dx * (ay[q] - ay[p]) - dy * (ax[q] - ax[p]);
                let d2 = dx * (by[q] - ay[p]) - dy * (bx[q] - ax[p]);
                if (d1 > 0.0) == (d2 > 0.0) {
                    continue;
                }
                let ex = bx[q] - ax[q];
                let ey = by[q] - ay[q];
                let d3 = ex * (ay[p] - ay[q]) - ey * (ax[p] - ax[q]);
                let d4 = ex * (by[p] - ay[q]) - ey * (bx[p] - ax[q]);
                if (d3 > 0.0) == (d4 > 0.0) {
                    continue;
                }
                let ep = &edges[owner[p]];
                let eq = &edges[owner[q]];
                let at = d3 / (d3 - d4);
                let x = ax[p] + at * dx;
                let y = ay[p] + at * dy;
                let fan = |v: usize, pe: u8, qe: u8| -> bool {
                    ((ends[p] & pe) != 0 && (ends[q] & qe) != 0)
                        || ((x - nodes[v].x).abs() < nodes[v].w / 2.0 + FAN && (y - nodes[v].y).abs() < nodes[v].h / 2.0 + FAN)
                        || (on_run(owner[p], pe, x, y) && on_run(owner[q], qe, x, y))
                };
                if ep.src == eq.src && fan(ep.src, 1, 1) {
                    continue;
                }
                if ep.src == eq.dst && fan(ep.src, 1, 2) {
                    continue;
                }
                if ep.dst == eq.src && fan(ep.dst, 2, 1) {
                    continue;
                }
                if ep.dst == eq.dst && fan(ep.dst, 2, 2) {
                    continue;
                }
                total += 1;
            }
        }
    }
    total
}

/// Match Mermaid: groups crossed by edges inherit their parent's direction.
pub fn inherit_crossed_directions<I>(nodes: &mut [CNode], ends: I)
where
    I: IntoIterator<Item = (usize, usize)>,
{
    let ancestors = |nodes: &[CNode], i: usize| -> HashSet<usize> {
        let mut set = HashSet::new();
        let mut p = nodes[i].parent;
        while p >= 0 {
            let pu = p as usize;
            if !set.insert(pu) {
                break;
            }
            p = nodes[pu].parent;
        }
        set
    };
    for (src, dst) in ends {
        if src == dst || src >= nodes.len() || dst >= nodes.len() {
            continue;
        }
        let a = ancestors(nodes, src);
        let b = ancestors(nodes, dst);
        for &g in &a {
            if !b.contains(&g) {
                nodes[g].dir = None;
            }
        }
        for &g in &b {
            if !a.contains(&g) {
                nodes[g].dir = None;
            }
        }
    }
}

pub fn shift_layout(nodes: &mut [CNode], edges: &mut [CEdge], ox: f64, oy: f64) {
    for c in nodes.iter_mut() {
        c.x += ox;
        c.y += oy;
    }
    for e in edges.iter_mut() {
        let mut k = 0;
        while k + 1 < e.route.len() {
            e.route[k] += ox;
            e.route[k + 1] += oy;
            k += 3;
        }
        e.label_x += ox;
        e.label_y += oy;
    }
}

pub fn cnode(w: f64, h: f64, parent: i32) -> CNode {
    CNode {
        w,
        h,
        parent,
        is_group: false,
        dir: None,
        pad_x: 0.0,
        pad_top: 0.0,
        pad_bottom: 0.0,
        min_w: 0.0,
        seq: 0,
        span: 0.0,
        x: 0.0,
        y: 0.0,
    }
}

pub fn cedge(src: usize, dst: usize, minlen: i32, label_w: f64, label_h: f64) -> CEdge {
    CEdge {
        src,
        dst,
        minlen,
        label_w,
        label_h,
        route: Vec::new(),
        label_x: 0.0,
        label_y: 0.0,
    }
}

struct FlatGuide {
    ledge_of: Vec<i32>,
    ledges: Vec<LEdge>,
    last: Vec<i32>,
}

struct CachedLayout {
    given: Vec<f64>,
    lnodes: Vec<LNode>,
    ledges: Vec<LEdge>,
    size: LayeredResult,
}

fn same_f64_bits(a: f64, b: f64) -> bool {
    (a.is_nan() && b.is_nan()) || a.to_bits() == b.to_bits()
}

fn endpoint_below(item: usize, e: &CEdge, out: bool) -> bool {
    (if out { e.src } else { e.dst }) != item
}

pub fn compound_layout(nodes: &mut [CNode], edges: &mut [CEdge], root_dir: Dir, opt: &LayeredOptions) -> CompoundResult {
    let n = nodes.len();
    let mut order: Vec<Level> = Vec::new();
    let mut level_idx: HashMap<i32, usize> = HashMap::new();

    let mut children: Vec<Vec<usize>> = vec![Vec::new(); n];
    let mut root_items: Vec<usize> = Vec::new();
    for i in 0..n {
        let p = nodes[i].parent;
        if p >= 0 && (p as usize) < n && (p as usize) != i && nodes[p as usize].is_group {
            children[p as usize].push(i);
        } else {
            nodes[i].parent = -1;
            root_items.push(i);
        }
    }

    let mut root = Level::new(-1, root_dir);
    root.items = root_items;
    level_idx.insert(-1, 0);
    order.push(root);

    let mut depth = vec![0usize; n];
    let mut placed = vec![false; n];
    let descend = |from: usize,
                   order: &mut Vec<Level>,
                   level_idx: &mut HashMap<i32, usize>,
                   children: &[Vec<usize>],
                   nodes: &[CNode],
                   placed: &mut [bool],
                   depth: &mut [usize]| {
        let mut q = from;
        while q < order.len() {
            let level_id = order[q].id;
            let level_dir = order[q].dir;
            let items = order[q].items.clone();
            for item in items {
                placed[item] = true;
                depth[item] = if level_id < 0 { 0 } else { depth[level_id as usize] + 1 };
                if nodes[item].is_group {
                    let mut child = Level::new(item as i32, nodes[item].dir.unwrap_or(level_dir));
                    child.items = children[item].clone();
                    let idx = order.len();
                    level_idx.insert(item as i32, idx);
                    order.push(child);
                }
            }
            q += 1;
        }
    };
    descend(0, &mut order, &mut level_idx, &children, nodes, &mut placed, &mut depth);

    // Groups that contain each other are unreachable from the root; lift them out.
    for i in 0..n {
        if placed[i] {
            continue;
        }
        let former = nodes[i].parent as usize;
        children[former].retain(|&c| c != i);
        nodes[i].parent = -1;
        order[0].items.push(i);
        placed[i] = true;
        depth[i] = 0;
        if nodes[i].is_group {
            let from = order.len();
            let mut child = Level::new(i as i32, nodes[i].dir.unwrap_or(root_dir));
            child.items = children[i].clone();
            level_idx.insert(i as i32, from);
            order.push(child);
            descend(from, &mut order, &mut level_idx, &children, nodes, &mut placed, &mut depth);
        }
    }

    for q in (1..order.len()).rev() {
        let mut seq = usize::MAX;
        for &item in &order[q].items {
            if nodes[item].seq < seq {
                seq = nodes[item].seq;
            }
        }
        if seq != usize::MAX {
            nodes[order[q].id as usize].seq = seq;
        }
    }
    for level in &mut order {
        level.items.sort_by(|&a, &b| nodes[a].seq.cmp(&nodes[b].seq).then_with(|| a.cmp(&b)));
    }

    let mut ports = 0usize;
    for e in edges.iter_mut() {
        let mut a = e.src;
        let mut b = e.dst;
        let mut crossed = 0usize;
        while depth[a] > depth[b] {
            a = nodes[a].parent as usize;
            crossed += 1;
        }
        while depth[b] > depth[a] {
            b = nodes[b].parent as usize;
            crossed += 1;
        }
        while a != b && nodes[a].parent != nodes[b].parent {
            a = nodes[a].parent as usize;
            b = nodes[b].parent as usize;
            crossed += 2;
        }
        if a == b {
            continue;
        }
        if ports + crossed > MAX_PORTS {
            e.src = a;
            e.dst = b;
        } else {
            ports += crossed;
        }
    }

    let mut loops: Vec<usize> = Vec::new();
    let mut stray: Vec<usize> = Vec::new();
    for (ei, e) in edges.iter_mut().enumerate() {
        e.route.clear();
        if e.src == e.dst {
            loops.push(ei);
            continue;
        }
        let mut a = e.src;
        let mut b = e.dst;
        let mut a_path: Vec<usize> = Vec::new();
        let mut b_path: Vec<usize> = Vec::new();
        while depth[a] > depth[b] {
            a_path.push(a);
            a = nodes[a].parent as usize;
        }
        while depth[b] > depth[a] {
            b_path.push(b);
            b = nodes[b].parent as usize;
        }
        if a == b {
            stray.push(ei);
            continue;
        }
        while nodes[a].parent != nodes[b].parent {
            a_path.push(a);
            b_path.push(b);
            a = nodes[a].parent as usize;
            b = nodes[b].parent as usize;
        }
        let shared_idx = level_idx[&nodes[a].parent];
        order[shared_idx].edges.push(LevelEdge { e: ei, a, b });
        for (path, out) in [(&a_path, true), (&b_path, false)] {
            for &inner in path {
                let lv_idx = level_idx[&nodes[inner].parent];
                let lv = &mut order[lv_idx];
                let port_idx = lv.ports.len();
                lv.ports.push(PortEdge {
                    e: ei,
                    inner,
                    out,
                    side: Side::Top,
                    hint: f64::NAN,
                    px: 0.0,
                    py: 0.0,
                    route: Vec::new(),
                });
                lv.port_of.insert(ei * 2 + usize::from(!out), port_idx);
            }
        }
    }

    let ordered = ports > 1 && ports <= MAX_ORDERED_PORTS && edges.len() <= MAX_ORDERED_EDGES;
    let mut key = vec![f64::NAN; n];
    let mut flat_crossings = 0usize;
    let mut flat_guide: Option<FlatGuide> = None;
    let mut flat = order.len() > 1 && ordered;
    for level in &order {
        if level.dir != root_dir {
            flat = false;
        }
    }
    if flat {
        let vertical = root_dir.is_vertical();
        let mut leaf = vec![-1i32; n];
        let mut group = vec![-1i32; n];
        let mut lnodes: Vec<LNode> = Vec::new();
        let mut of: Vec<i32> = Vec::new();
        let mut parent: Vec<i32> = Vec::new();
        for i in 0..n {
            if !nodes[i].is_group {
                continue;
            }
            group[i] = parent.len() as i32;
            parent.push(-1);
        }
        for i in 0..n {
            let p = nodes[i].parent;
            if nodes[i].is_group {
                parent[group[i] as usize] = if p >= 0 { group[p as usize] } else { -1 };
            } else {
                leaf[i] = lnodes.len() as i32;
                let (w, h) = if vertical { (nodes[i].w, nodes[i].h) } else { (nodes[i].h, nodes[i].w) };
                lnodes.push(lnode(w, h, Kind::Node));
                of.push(if p >= 0 { group[p as usize] } else { -1 });
            }
        }
        let mut ledges: Vec<LEdge> = Vec::new();
        let mut ledge_of = vec![-1i32; edges.len()];
        for (ei, e) in edges.iter().enumerate() {
            if e.src == e.dst || leaf[e.src] < 0 || leaf[e.dst] < 0 {
                continue;
            }
            ledge_of[ei] = ledges.len() as i32;
            let (lw, lh) = if vertical { (e.label_w, e.label_h) } else { (e.label_h, e.label_w) };
            ledges.push(ledge(leaf[e.src] as usize, leaf[e.dst] as usize, e.minlen, lw, lh));
        }
        let mut flat_opt = opt.clone();
        flat_opt.groups = Some(Groups { of, parent });
        flat_opt.order_only = true;
        let flat_layout = layered(&mut lnodes, &mut ledges, &flat_opt);
        flat_crossings = flat_layout.crossings.unwrap_or(0).min(flat_layout.declared.unwrap_or(0));
        let mut sum = vec![0.0f64; n];
        let mut count = vec![0usize; n];
        let mut last = vec![-1i32; n];
        for i in 0..n {
            if leaf[i] < 0 {
                continue;
            }
            let li = leaf[i] as usize;
            key[i] = lnodes[li].x;
            let mut p = nodes[i].parent;
            while p >= 0 {
                let pu = p as usize;
                sum[pu] += key[i];
                count[pu] += 1;
                last[pu] = last[pu].max(lnodes[li].rank as i32);
                p = nodes[pu].parent;
            }
        }
        for i in 0..n {
            if count[i] > 0 {
                key[i] = sum[i] / (count[i] as f64);
            }
        }
        flat_guide = Some(FlatGuide { ledge_of, ledges, last });
    }

    let mut laid: HashMap<i32, Vec<CachedLayout>> = HashMap::new();
    let mut local = vec![0usize; n];
    let mut total = CompoundResult { width: 0.0, height: 0.0 };

    #[allow(clippy::too_many_arguments)]
    let build_level = |level: &Level,
                       all_levels: &[Level],
                       level_idx: &HashMap<i32, usize>,
                       nodes: &[CNode],
                       edges: &[CEdge],
                       local: &mut [usize],
                       keyed: bool,
                       key: &[f64],
                       flat_guide: Option<&FlatGuide>,
                       sized: bool|
     -> (Vec<LNode>, Vec<LEdge>, Vec<i32>) {
        let vertical = level.dir.is_vertical();
        let start = start_side(level.dir);
        let mut lnodes: Vec<LNode> = Vec::with_capacity(level.items.len() + level.ports.len());
        let mut ledges: Vec<LEdge> = Vec::with_capacity(level.edges.len() + level.ports.len());
        for (i, &item) in level.items.iter().enumerate() {
            local[item] = i;
            let node = &nodes[item];
            let mut ln = if sized {
                lnode(if vertical { node.w } else { node.h }, if vertical { node.h } else { node.w }, Kind::Node)
            } else {
                lnode(0.0, 0.0, Kind::Node)
            };
            ln.span = if node.is_group { node.span.min(ln.w - 2.0 * node.pad_x) } else { node.span };
            ln.key = if keyed { key[item] } else { f64::NAN };
            lnodes.push(ln);
        }
        let held = |item: usize, ei: usize, out: bool| -> bool { nodes[item].is_group && endpoint_below(item, &edges[ei], out) };
        let offset = |item: usize, ei: usize, out: bool| -> f64 {
            if !sized || !nodes[item].is_group || !endpoint_below(item, &edges[ei], out) {
                return 0.0;
            }
            let child_lv = &all_levels[level_idx[&(item as i32)]];
            let p_idx = child_lv.port_of[&(ei * 2 + usize::from(!out))];
            let port = &child_lv.ports[p_idx];
            if vertical {
                port.px - nodes[item].w / 2.0
            } else {
                port.py - nodes[item].h / 2.0
            }
        };
        for le in &level.edges {
            let e = &edges[le.e];
            let mut edge = ledge(local[le.a], local[le.b], e.minlen, 0.0, 0.0);
            if sized {
                edge.label_w = if vertical { e.label_w } else { e.label_h };
                edge.label_h = if vertical { e.label_h } else { e.label_w };
                edge.tail_dx = offset(le.a, le.e, true);
                edge.head_dx = offset(le.b, le.e, false);
                edge.tail_fixed = held(le.a, le.e, true);
                edge.head_fixed = held(le.b, le.e, false);
            }
            ledges.push(edge);
        }
        let mut dummies = vec![-1i32; level.ports.len()];
        for (i, port) in level.ports.iter().enumerate() {
            if port.side == start || port.side == start.opposite() {
                let d = lnodes.len();
                let mut ln = lnode(0.0, 0.0, if port.side == start { Kind::StartPort } else { Kind::EndPort });
                ln.key = if keyed {
                    key[if port.out { edges[port.e].dst } else { edges[port.e].src }]
                } else {
                    f64::NAN
                };
                ln.hint = if port.hint.is_nan() && keyed {
                    if let Some(fg) = flat_guide {
                        let le = fg.ledge_of[port.e];
                        if le < 0 || level.id < 0 || !port.out || port.side != start_side(level.dir).opposite() {
                            f64::NAN
                        } else {
                            let points = &fg.ledges[le as usize].points;
                            let mut inside = key[edges[port.e].src];
                            let mut outside = 0.0f64;
                            let last_r = fg.last[level.id as usize] as f64;
                            let mut k = 0;
                            while k + 1 < points.len() {
                                if points[k] == last_r {
                                    inside = points[k + 1];
                                }
                                if points[k] == last_r + 1.0 {
                                    outside = points[k + 1];
                                }
                                k += 2;
                            }
                            inside + outside * 1e-6
                        }
                    } else {
                        f64::NAN
                    }
                } else {
                    port.hint
                };
                lnodes.push(ln);
                dummies[i] = d as i32;
                let mut edge = if port.out {
                    ledge(local[port.inner], d, 1, 0.0, 0.0)
                } else {
                    ledge(d, local[port.inner], 1, 0.0, 0.0)
                };
                if port.out {
                    edge.tail_dx = offset(port.inner, port.e, true);
                    edge.tail_fixed = held(port.inner, port.e, true);
                } else {
                    edge.head_dx = offset(port.inner, port.e, false);
                    edge.head_fixed = held(port.inner, port.e, false);
                }
                ledges.push(edge);
            } else {
                lnodes[local[port.inner]].pin = if port.side == Side::Top || port.side == Side::Left { -1 } else { 1 };
            }
        }
        (lnodes, ledges, dummies)
    };

    #[allow(clippy::too_many_arguments)]
    let place = |order: &mut Vec<Level>,
                 level_idx: &HashMap<i32, usize>,
                 nodes: &mut [CNode],
                 edges: &mut [CEdge],
                 local: &mut [usize],
                 keyed: bool,
                 key: &[f64],
                 flat_guide: Option<&FlatGuide>,
                 laid: &mut HashMap<i32, Vec<CachedLayout>>,
                 total: &mut CompoundResult| {
        // Rank parents first to determine which group sides edges cross.
        for q in 0..order.len() {
            let ports_copy: Vec<(usize, usize, bool, Side)> = order[q].ports.iter().map(|p| (p.inner, p.e, p.out, p.side)).collect();
            for (inner, pe, pout, pside) in ports_copy {
                if nodes[inner].is_group && endpoint_below(inner, &edges[pe], pout) {
                    let child_idx = level_idx[&(inner as i32)];
                    let p_idx = order[child_idx].port_of[&(pe * 2 + usize::from(!pout))];
                    order[child_idx].ports[p_idx].side = pside;
                }
            }
            if order[q].edges.is_empty() {
                continue;
            }
            let needed = order[q].edges.iter().any(|le| {
                let e = &edges[le.e];
                (nodes[le.a].is_group && e.src != le.a) || (nodes[le.b].is_group && e.dst != le.b)
            });
            if !needed {
                continue;
            }
            let (mut lnodes, mut ledges, _) = build_level(&order[q], order, level_idx, nodes, edges, local, keyed, key, flat_guide, false);
            orient(&lnodes, &mut ledges);
            rank(&mut lnodes, &ledges, 1);
            let start = start_side(order[q].dir);
            let level_edges = order[q].edges.clone();
            for (i, le) in level_edges.iter().enumerate() {
                let e = &edges[le.e];
                let a_above = !ledges[i].reversed;
                if nodes[le.a].is_group && e.src != le.a {
                    let child_idx = level_idx[&(le.a as i32)];
                    let p_idx = order[child_idx].port_of[&(le.e * 2)];
                    order[child_idx].ports[p_idx].side = if a_above { start.opposite() } else { start };
                }
                if nodes[le.b].is_group && e.dst != le.b {
                    let child_idx = level_idx[&(le.b as i32)];
                    let p_idx = order[child_idx].port_of[&(le.e * 2 + 1)];
                    order[child_idx].ports[p_idx].side = if a_above { start } else { start.opposite() };
                }
            }
        }

        // Lay out children first so their sizes are known.
        for q in (0..order.len()).rev() {
            let level_id = order[q].id;
            let level_dir = order[q].dir;
            let vertical = level_dir.is_vertical();
            let flip = level_dir.is_flipped();
            let (mut lnodes, mut ledges, dummies) = build_level(&order[q], order, level_idx, nodes, edges, local, keyed, key, flat_guide, true);

            let size = if !ordered {
                layered(&mut lnodes, &mut ledges, opt)
            } else {
                let mut given = Vec::with_capacity(lnodes.len() * 7 + ledges.len() * 9);
                for ln in &lnodes {
                    given.push(ln.w);
                    given.push(ln.h);
                    given.push(ln.kind.as_u8() as f64);
                    given.push(ln.pin as f64);
                    given.push(ln.hint);
                    given.push(ln.key);
                    given.push(ln.span);
                }
                for le in &ledges {
                    given.push(le.tail as f64);
                    given.push(le.head as f64);
                    given.push(le.minlen as f64);
                    given.push(le.label_w);
                    given.push(le.label_h);
                    given.push(le.tail_dx);
                    given.push(le.head_dx);
                    given.push(f64::from(u8::from(le.tail_fixed)));
                    given.push(f64::from(u8::from(le.head_fixed)));
                }
                let past = laid.entry(level_id).or_default();
                let cached = past
                    .iter()
                    .find(|p| p.given.len() == given.len() && p.given.iter().zip(given.iter()).all(|(&a, &b)| same_f64_bits(a, b)));
                if let Some(hit) = cached {
                    lnodes = hit.lnodes.clone();
                    ledges = hit.ledges.clone();
                    hit.size
                } else {
                    let s = layered(&mut lnodes, &mut ledges, opt);
                    past.push(CachedLayout {
                        given,
                        lnodes: lnodes.clone(),
                        ledges: ledges.clone(),
                        size: s,
                    });
                    s
                }
            };

            let content_w = if vertical { size.width } else { size.height };
            let content_h = if vertical { size.height } else { size.width };
            let (pad_x, pad_top, pad_bottom, min_w) = if level_id >= 0 {
                let g = &nodes[level_id as usize];
                (g.pad_x, g.pad_top, g.pad_bottom, g.min_w)
            } else {
                (0.0, 0.0, 0.0, 0.0)
            };
            let box_w = (content_w + 2.0 * pad_x).max(min_w);
            let box_h = content_h + pad_top + pad_bottom;
            let off_x = (box_w - content_w) / 2.0;
            let off_y = pad_top;
            let tx = |lx: f64, ly: f64| -> f64 {
                off_x
                    + if vertical {
                        lx
                    } else if flip {
                        size.height - ly
                    } else {
                        ly
                    }
            };
            let ty = |lx: f64, ly: f64| -> f64 { off_y + if vertical { if flip { size.height - ly } else { ly } } else { lx } };
            let axis = if vertical { 0.0 } else { 1.0 };
            let convert = |points: &[f64]| -> Vec<f64> {
                let mut out = Vec::with_capacity((points.len() / 2) * 3);
                let mut i = 0;
                while i + 1 < points.len() {
                    out.push(tx(points[i], points[i + 1]));
                    out.push(ty(points[i], points[i + 1]));
                    out.push(axis);
                    i += 2;
                }
                out
            };

            for (i, &item) in order[q].items.iter().enumerate() {
                nodes[item].x = tx(lnodes[i].x, lnodes[i].y);
                nodes[item].y = ty(lnodes[i].x, lnodes[i].y);
            }
            let level_edges = order[q].edges.clone();
            for (i, le) in level_edges.iter().enumerate() {
                let edge = &ledges[i];
                order[q].routes.insert(le.e, convert(&edge.points));
                let e = &mut edges[le.e];
                if e.label_w > 0.0 {
                    e.label_x = tx(edge.label_x, edge.label_y);
                    e.label_y = ty(edge.label_x, edge.label_y);
                }
            }
            let mut k = level_edges.len();
            let port_count = order[q].ports.len();
            for (i, &dummy_id) in dummies.iter().enumerate().take(port_count) {
                let port_e = order[q].ports[i].e;
                let port_inner = order[q].ports[i].inner;
                let port_out = order[q].ports[i].out;
                let port_side = order[q].ports[i].side;
                if dummy_id >= 0 {
                    let mut route = convert(&ledges[k].points);
                    k += 1;
                    let at = if port_out { route.len() - 3 } else { 0 };
                    let mut bx = route[at];
                    let mut by = route[at + 1];
                    match port_side {
                        Side::Top => by = 0.0,
                        Side::Bottom => by = box_h,
                        Side::Left => bx = 0.0,
                        Side::Right => bx = box_w,
                    }
                    if port_out {
                        route.push(bx);
                        route.push(by);
                        route.push(axis);
                    } else {
                        route.splice(0..0, [bx, by, axis]);
                    }
                    order[q].ports[i].px = bx;
                    order[q].ports[i].py = by;
                    order[q].ports[i].route = route;
                    continue;
                }
                let item = &nodes[port_inner];
                let mut ix = item.x;
                let mut iy = item.y;
                if item.is_group && endpoint_below(port_inner, &edges[port_e], port_out) {
                    let child_idx = level_idx[&(port_inner as i32)];
                    let inner_p_idx = order[child_idx].port_of[&(port_e * 2 + usize::from(!port_out))];
                    let inner_port = &order[child_idx].ports[inner_p_idx];
                    ix += inner_port.px - item.w / 2.0;
                    iy += inner_port.py - item.h / 2.0;
                } else {
                    match port_side {
                        Side::Top => iy -= item.h / 2.0,
                        Side::Bottom => iy += item.h / 2.0,
                        Side::Left => ix -= item.w / 2.0,
                        Side::Right => ix += item.w / 2.0,
                    }
                }
                let mut bx = ix;
                let mut by = iy;
                match port_side {
                    Side::Top => by = 0.0,
                    Side::Bottom => by = box_h,
                    Side::Left => bx = 0.0,
                    Side::Right => bx = box_w,
                }
                let a = match port_side {
                    Side::Top | Side::Bottom => 0.0,
                    Side::Left | Side::Right => 1.0,
                };
                order[q].ports[i].px = bx;
                order[q].ports[i].py = by;
                order[q].ports[i].route = if port_out { vec![ix, iy, a, bx, by, a] } else { vec![bx, by, a, ix, iy, a] };
            }

            if level_id >= 0 {
                let g = &mut nodes[level_id as usize];
                g.w = box_w;
                g.h = box_h;
            } else {
                *total = CompoundResult { width: box_w, height: box_h };
            }
        }

        for q in 0..order.len() {
            let ox = order[q].x;
            let oy = order[q].y;
            let items = order[q].items.clone();
            for item in items {
                nodes[item].x += ox;
                nodes[item].y += oy;
                if nodes[item].is_group {
                    let child_idx = level_idx[&(item as i32)];
                    order[child_idx].x = nodes[item].x - nodes[item].w / 2.0;
                    order[child_idx].y = nodes[item].y - nodes[item].h / 2.0;
                }
            }
        }

        let append = |route: &mut Vec<f64>, part: &[f64], ox: f64, oy: f64| {
            let mut i = 0;
            while i + 2 < part.len() {
                let x = part[i] + ox;
                let y = part[i + 1] + oy;
                let len = route.len();
                if len >= 3 && (route[len - 3] - x).abs() < 0.01 && (route[len - 2] - y).abs() < 0.01 {
                    i += 3;
                    continue;
                }
                route.push(x);
                route.push(y);
                route.push(part[i + 2]);
                i += 3;
            }
        };

        for q in 0..order.len() {
            let level_id = order[q].id;
            let level_x = order[q].x;
            let level_y = order[q].y;
            for le in &order[q].edges {
                let e = &mut edges[le.e];
                let mut route: Vec<f64> = Vec::new();
                let mut outward: Vec<usize> = Vec::new();
                let mut item = e.src;
                while nodes[item].parent != level_id {
                    let p = nodes[item].parent;
                    outward.push(level_idx[&p]);
                    item = p as usize;
                }
                for lv_idx in outward {
                    let lv = &order[lv_idx];
                    let p_idx = lv.port_of[&(le.e * 2)];
                    append(&mut route, &lv.ports[p_idx].route, lv.x, lv.y);
                }
                append(&mut route, &order[q].routes[&le.e], level_x, level_y);
                let mut inward: Vec<usize> = Vec::new();
                let mut item = e.dst;
                while nodes[item].parent != level_id {
                    let p = nodes[item].parent;
                    inward.push(level_idx[&p]);
                    item = p as usize;
                }
                for lv_idx in inward.into_iter().rev() {
                    let lv = &order[lv_idx];
                    let p_idx = lv.port_of[&(le.e * 2 + 1)];
                    append(&mut route, &lv.ports[p_idx].route, lv.x, lv.y);
                }
                e.route = route;
                if e.label_w > 0.0 {
                    e.label_x += level_x;
                    e.label_y += level_y;
                }
            }
        }
    };

    let style = style_of(opt);
    let mut keyed = flat;
    place(
        &mut order,
        &level_idx,
        nodes,
        edges,
        &mut local,
        keyed,
        &key,
        flat_guide.as_ref(),
        &mut laid,
        &mut total,
    );
    let mut crossings: Option<usize> = None;
    if flat {
        let c = route_crossings(nodes, edges, style);
        crossings = Some(c);
        if (c as f64) > (flat_crossings as f64) * FLAT_SLACK + FLAT_SPARE {
            let first = snapshot(nodes, edges, &order, total);
            keyed = false;
            place(
                &mut order,
                &level_idx,
                nodes,
                edges,
                &mut local,
                keyed,
                &key,
                flat_guide.as_ref(),
                &mut laid,
                &mut total,
            );
            let own = route_crossings(nodes, edges, style);
            if own >= c {
                keyed = true;
                total = restore(first, nodes, edges, &mut order);
            } else {
                crossings = Some(own);
            }
        }
    }

    if keyed == flat && ordered {
        let mut again = false;
        for level in &mut order {
            if level.id < 0 {
                continue;
            }
            let box_node = &nodes[level.id as usize];
            let vertical = level.dir.is_vertical();
            let end = start_side(level.dir).opposite();
            let mut seen: Vec<(f64, f64)> = Vec::new();
            for port in &mut level.ports {
                if port.side != end {
                    continue;
                }
                let route = &edges[port.e].route;
                let bx = level.x + port.px;
                let by = level.y + port.py;
                let mut at: Option<usize> = None;
                let mut k = 0;
                while k + 1 < route.len() && (at.is_none() || port.out) {
                    if (route[k] - bx).abs() < 0.01 && (route[k + 1] - by).abs() < 0.01 {
                        at = Some(k);
                    }
                    k += 3;
                }
                let Some(at_idx) = at else {
                    continue;
                };
                let a = usize::from(!vertical);
                let step_delta: isize = if port.out { 3 } else { -3 };
                let mut next = at_idx as isize + step_delta;
                while next >= 0 && (next as usize) < route.len() && (route[next as usize + a] - route[at_idx + a]).abs() < IN_LINE {
                    next += step_delta;
                }
                if next < 0 || (next as usize) >= route.len() {
                    continue;
                }
                let base = if vertical {
                    box_node.x - box_node.w / 2.0
                } else {
                    box_node.y - box_node.h / 2.0
                };
                port.hint = route[next as usize + a] - base;
                seen.push((if vertical { port.px } else { port.py }, port.hint));
            }
            seen.sort_by(|p, q| p.0.total_cmp(&q.0));
            for i in 1..seen.len() {
                if seen[i - 1].1 > seen[i].1 {
                    again = true;
                }
            }
        }
        if again {
            let before = crossings.unwrap_or_else(|| route_crossings(nodes, edges, style));
            if before > 0 {
                let first = snapshot(nodes, edges, &order, total);
                place(
                    &mut order,
                    &level_idx,
                    nodes,
                    edges,
                    &mut local,
                    keyed,
                    &key,
                    flat_guide.as_ref(),
                    &mut laid,
                    &mut total,
                );
                if route_crossings(nodes, edges, style) >= before {
                    total = restore(first, nodes, edges, &mut order);
                }
            }
        }
    }

    for ei in stray {
        let (ax, ay, bx, by) = {
            let e = &edges[ei];
            let a = &nodes[e.src];
            let b = &nodes[e.dst];
            (a.x, a.y, b.x, b.y)
        };
        let e = &mut edges[ei];
        e.route = vec![ax, ay, 0.0, bx, by, 0.0];
        e.label_x = (ax + bx) / 2.0;
        e.label_y = (ay + by) / 2.0;
    }
    for ei in loops {
        let e = &mut edges[ei];
        let node = &nodes[e.src];
        e.label_x = node.x + node.w / 2.0 + 28.0 + e.label_w / 2.0;
        e.label_y = node.y;
    }

    total
}
