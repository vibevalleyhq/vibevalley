use std::collections::{HashMap, HashSet};

use crate::layout::layered::{LEdge, LNode, LayeredResult};

pub(super) const IN_LINE: f64 = 0.5;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Side {
    Top,
    Right,
    Bottom,
    Left,
}

impl Side {
    pub(super) fn opposite(self) -> Self {
        match self {
            Side::Top => Side::Bottom,
            Side::Right => Side::Left,
            Side::Bottom => Side::Top,
            Side::Left => Side::Right,
        }
    }
}

pub(super) fn start_side(dir: Dir) -> Side {
    match dir {
        Dir::TB => Side::Top,
        Dir::BT => Side::Bottom,
        Dir::LR => Side::Left,
        Dir::RL => Side::Right,
    }
}

#[derive(Debug, Clone)]
pub(super) struct PortEdge {
    pub(super) e: usize,
    pub(super) inner: usize,
    pub(super) out: bool,
    pub(super) side: Side,
    pub(super) hint: f64,
    pub(super) px: f64,
    pub(super) py: f64,
    pub(super) route: Vec<f64>,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct LevelEdge {
    pub(super) e: usize,
    pub(super) a: usize,
    pub(super) b: usize,
}

#[derive(Debug, Clone)]
pub(super) struct Level {
    pub(super) id: i32,
    pub(super) dir: Dir,
    pub(super) items: Vec<usize>,
    pub(super) edges: Vec<LevelEdge>,
    pub(super) ports: Vec<PortEdge>,
    pub(super) port_of: HashMap<usize, usize>,
    pub(super) routes: HashMap<usize, Vec<f64>>,
    pub(super) x: f64,
    pub(super) y: f64,
}

impl Level {
    pub(super) fn new(id: i32, dir: Dir) -> Self {
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

pub(super) struct Snapshot {
    nodes: Vec<f64>,
    routes: Vec<Vec<f64>>,
    labels: Vec<f64>,
    levels: Vec<f64>,
    total: CompoundResult,
}

pub(super) fn snapshot(nodes: &[CNode], edges: &[CEdge], levels: &[Level], total: CompoundResult) -> Snapshot {
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

pub(super) fn restore(s: Snapshot, nodes: &mut [CNode], edges: &mut [CEdge], levels: &mut [Level]) -> CompoundResult {
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

pub(super) struct FlatGuide {
    pub(super) ledge_of: Vec<i32>,
    pub(super) ledges: Vec<LEdge>,
    pub(super) last: Vec<i32>,
}

pub(super) struct CachedLayout {
    pub(super) given: Vec<f64>,
    pub(super) lnodes: Vec<LNode>,
    pub(super) ledges: Vec<LEdge>,
    pub(super) size: LayeredResult,
}

pub(super) fn same_f64_bits(a: f64, b: f64) -> bool {
    (a.is_nan() && b.is_nan()) || a.to_bits() == b.to_bits()
}

pub(super) fn endpoint_below(item: usize, e: &CEdge, out: bool) -> bool {
    (if out { e.src } else { e.dst }) != item
}
