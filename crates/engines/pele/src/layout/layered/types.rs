pub(super) const IN_LINE: f64 = 0.5;
pub(super) const TWIN: f64 = 1.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Node,
    Dummy,
    Label,
    StartPort,
    EndPort,
}

impl Kind {
    #[inline]
    pub fn as_u8(self) -> u8 {
        match self {
            Kind::Node => 0,
            Kind::Dummy => 1,
            Kind::Label => 2,
            Kind::StartPort => 3,
            Kind::EndPort => 4,
        }
    }

    #[inline]
    pub(super) fn is_dummy(self) -> bool {
        match self {
            Kind::Dummy | Kind::Label => true,
            Kind::Node | Kind::StartPort | Kind::EndPort => false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct LNode {
    pub w: f64,
    pub h: f64,
    pub kind: Kind,
    pub pin: i32,
    /// Port's cross-flow destination; NaN if unknown. Fully hinted port ranks keep this order.
    pub hint: f64,
    /// Initial cross-flow position; NaN if unknown. Used only when every node in a rank has one.
    pub key: f64,
    /// How much of the side that edges meet may be shared out between them; 0 keeps them all at its middle.
    pub span: f64,
    pub x: f64,
    pub y: f64,
    pub rank: usize,
}

#[derive(Debug, Clone)]
pub struct LEdge {
    pub tail: usize,
    pub head: usize,
    pub minlen: i32,
    pub label_w: f64,
    pub label_h: f64,
    pub tail_dx: f64,
    pub head_dx: f64,
    /// An end held where its offset puts it, taking no part in sharing out a node's side.
    pub tail_fixed: bool,
    pub head_fixed: bool,
    pub reversed: bool,
    pub points: Vec<f64>,
    pub label_x: f64,
    pub label_y: f64,
}

#[derive(Debug, Clone)]
pub struct Groups {
    pub of: Vec<i32>,
    pub parent: Vec<i32>,
}

#[derive(Debug, Clone)]
pub struct LayeredOptions {
    pub node_sep: f64,
    pub edge_sep: f64,
    pub rank_sep: f64,
    pub port_sep: f64,
    pub tracks: bool,
    pub straight: bool,
    pub apart: bool,
    pub head_room: f64,
    pub groups: Option<Groups>,
    pub order_only: bool,
}

impl Default for LayeredOptions {
    fn default() -> Self {
        Self {
            node_sep: 50.0,
            edge_sep: 20.0,
            rank_sep: 50.0,
            port_sep: 20.0,
            tracks: false,
            straight: false,
            apart: false,
            head_room: 0.0,
            groups: None,
            order_only: false,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct LayeredResult {
    pub width: f64,
    pub height: f64,
    pub crossings: Option<usize>,
    pub declared: Option<usize>,
}

pub fn lnode(w: f64, h: f64, kind: Kind) -> LNode {
    LNode {
        w,
        h,
        kind,
        pin: 0,
        hint: f64::NAN,
        key: f64::NAN,
        span: 0.0,
        x: 0.0,
        y: 0.0,
        rank: 0,
    }
}

pub fn ledge(tail: usize, head: usize, minlen: i32, label_w: f64, label_h: f64) -> LEdge {
    LEdge {
        tail,
        head,
        minlen,
        label_w,
        label_h,
        tail_dx: 0.0,
        head_dx: 0.0,
        tail_fixed: false,
        head_fixed: false,
        reversed: false,
        points: Vec::new(),
        label_x: 0.0,
        label_y: 0.0,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum End {
    Held,
    Leaves,
    Arrives,
}

pub(super) struct Pieces {
    pub(super) from: Vec<f64>,
    pub(super) to: Vec<f64>,
    pub(super) rank: Vec<usize>,
    pub(super) lower: Vec<i32>,
    pub(super) track: Vec<i32>,
    pub(super) levels: Vec<i32>,
    pub(super) wide: Vec<u8>,
}

pub(super) struct Graph<'a> {
    pub(super) n: usize,
    pub(super) real: usize,
    pub(super) max_rank: usize,
    pub(super) w: Vec<f64>,
    pub(super) kind: Vec<Kind>,
    pub(super) rank: Vec<usize>,
    pub(super) ef: Vec<usize>,
    pub(super) et: Vec<usize>,
    pub(super) efd: Vec<f64>,
    pub(super) etd: Vec<f64>,
    pub(super) succ_start: Vec<usize>,
    pub(super) succ_e: Vec<usize>,
    pub(super) pred_start: Vec<usize>,
    pub(super) pred_e: Vec<usize>,
    pub(super) layer_start: Vec<usize>,
    pub(super) order: Vec<usize>,
    pub(super) pos: Vec<i32>,
    pub(super) offsets: bool,
    pub(super) fixed: Vec<bool>,
    pub(super) grp: Option<Vec<i32>>,
    pub(super) group_parent: Option<&'a [i32]>,
}

pub(super) fn set_positions(g: &mut Graph<'_>) {
    for r in 0..=g.max_rank {
        let s = g.layer_start[r];
        for i in s..g.layer_start[r + 1] {
            g.pos[g.order[i]] = (i - s) as i32;
        }
    }
}

pub(super) fn half_room(g: &Graph<'_>, opt: &LayeredOptions, v: usize) -> f64 {
    let sep = if g.kind[v] == Kind::Node { opt.node_sep } else { opt.edge_sep };
    g.w[v] / 2.0 + sep / 2.0
}

pub(super) fn empty_ranks(g: &Graph<'_>) -> Option<Vec<bool>> {
    let mut empty = vec![false; g.max_rank + 1];
    let mut any = false;
    for (r, slot) in empty.iter_mut().enumerate().take(g.max_rank).skip(1) {
        let mut only = g.layer_start[r + 1] > g.layer_start[r];
        for i in g.layer_start[r]..g.layer_start[r + 1] {
            if !only {
                break;
            }
            if g.kind[g.order[i]] != Kind::Dummy {
                only = false;
            }
        }
        if only {
            *slot = true;
            any = true;
        }
    }
    if any { Some(empty) } else { None }
}
