// Layered (Sugiyama-style) layout of one flat graph. Ranks run down the y axis; callers
// rotate the result for other directions.

use indexmap::IndexMap;
use std::collections::HashSet;

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
    fn is_dummy(self) -> bool {
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

const MAX_SWEEPS: usize = 24;
const MAX_DUMMIES: usize = 20_000;
const PORT_PITCH: f64 = 16.0;
const MIN_PITCH: f64 = 8.0;
const MIN_SLOPE: f64 = 0.125;
const MAX_GAP: f64 = 3.0;
const TRACK_MARGIN: f64 = 18.0;
const TRACK_PITCH: f64 = 10.0;
const TRACK_SPREAD: f64 = 14.0;
const LEVEL_WIDE: f64 = 2.0;
const LEVEL_MARGIN: f64 = 28.0;
const LEVEL_PITCH: f64 = 12.0;
const LEVEL_LEAD: f64 = 12.0;
const LEVEL_CLEAR: f64 = 8.0;
const LEVEL_TOUCH: f64 = 4.0;
const CROSSED_SLOPE: f64 = 0.5;
const IN_LINE: f64 = 0.5;
const TWIN: f64 = 1.0;
const SNAP: f64 = 12.0;
const BEND_SNAP: f64 = 24.0;
const LEAN_CLEAR: f64 = 40.0;
const MAX_WEIGHED: usize = 400;
const SAMPLES: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum End {
    Held,
    Leaves,
    Arrives,
}

fn sort_range_i32(list: &mut [usize], from: usize, to: usize, key: &[i32]) {
    for i in (from + 1)..to {
        let item = list[i];
        let k = key[item];
        let mut j = i;
        while j > from && (key[list[j - 1]] > k || (key[list[j - 1]] == k && list[j - 1] > item)) {
            list[j] = list[j - 1];
            j -= 1;
        }
        list[j] = item;
    }
}

fn sort_by_bary(list: &mut [usize], count: usize, bary: &[f64], pos: &[i32], right: bool, spare: &mut [usize]) {
    let before = |a: usize, b: usize| -> bool { bary[a] < bary[b] || (bary[a] == bary[b] && if right { pos[a] > pos[b] } else { pos[a] < pos[b] }) };
    const RUN: usize = 8;
    let mut s = 0;
    while s < count {
        let end = count.min(s + RUN);
        for i in (s + 1)..end {
            let item = list[i];
            let mut j = i;
            while j > s && before(item, list[j - 1]) {
                list[j] = list[j - 1];
                j -= 1;
            }
            list[j] = item;
        }
        s += RUN;
    }
    let mut into_spare = true;
    let mut width = RUN;
    while width < count {
        let (src, dst): (&[usize], &mut [usize]) = if into_spare {
            (&list[..count], &mut spare[..count])
        } else {
            (&spare[..count], &mut list[..count])
        };
        let mut start = 0;
        while start < count {
            let mid = count.min(start + width);
            let end = count.min(start + 2 * width);
            let mut i = start;
            let mut j = mid;
            let mut k = start;
            while i < mid && j < end {
                if before(src[j], src[i]) {
                    dst[k] = src[j];
                    j += 1;
                } else {
                    dst[k] = src[i];
                    i += 1;
                }
                k += 1;
            }
            while i < mid {
                dst[k] = src[i];
                i += 1;
                k += 1;
            }
            while j < end {
                dst[k] = src[j];
                j += 1;
                k += 1;
            }
            start += 2 * width;
        }
        into_spare = !into_spare;
        width *= 2;
    }
    if !into_spare {
        list[..count].copy_from_slice(&spare[..count]);
    }
}

struct Pieces {
    from: Vec<f64>,
    to: Vec<f64>,
    rank: Vec<usize>,
    lower: Vec<i32>,
    track: Vec<i32>,
    levels: Vec<i32>,
    wide: Vec<u8>,
}

struct Graph<'a> {
    n: usize,
    real: usize,
    max_rank: usize,
    w: Vec<f64>,
    kind: Vec<Kind>,
    rank: Vec<usize>,
    ef: Vec<usize>,
    et: Vec<usize>,
    efd: Vec<f64>,
    etd: Vec<f64>,
    succ_start: Vec<usize>,
    succ_e: Vec<usize>,
    pred_start: Vec<usize>,
    pred_e: Vec<usize>,
    layer_start: Vec<usize>,
    order: Vec<usize>,
    pos: Vec<i32>,
    offsets: bool,
    fixed: Vec<bool>,
    grp: Option<Vec<i32>>,
    group_parent: Option<&'a [i32]>,
}

pub fn layered(nodes: &mut [LNode], edges: &mut [LEdge], opt: &LayeredOptions) -> LayeredResult {
    let real = nodes.len();
    if real == 0 {
        return LayeredResult {
            width: 0.0,
            height: 0.0,
            crossings: None,
            declared: None,
        };
    }
    let m = edges.len();
    if real == 1 && m == 0 && nodes[0].kind == Kind::Node {
        let node = &mut nodes[0];
        node.rank = 0;
        node.x = node.w / 2.0;
        node.y = node.h / 2.0;
        return LayeredResult {
            width: node.w,
            height: node.h,
            crossings: None,
            declared: None,
        };
    }

    // Every edge gets a middle rank of its own when labels or parallel edges need the room.
    let mut step: usize = 1;
    if m > 0 {
        let mut seen: HashSet<u64> = HashSet::with_capacity(m);
        for e in edges.iter() {
            let a = e.tail.min(e.head) as u64;
            let b = e.tail.max(e.head) as u64;
            let key = a * (real as u64) + b;
            if e.label_w > 0.0 || !seen.insert(key) {
                step = 2;
                break;
            }
        }
    }

    orient(nodes, edges);
    rank(nodes, edges, step as i32);

    let mut span = vec![0usize; m];
    let mut dummies: usize = 0;
    for (ei, e) in edges.iter().enumerate() {
        let d = nodes[e.head].rank.abs_diff(nodes[e.tail].rank);
        span[ei] = d;
        if d > 1 {
            dummies += d - 1;
        }
    }
    let mut direct = vec![false; m];
    if dummies > MAX_DUMMIES {
        let mut longest: Vec<usize> = (0..m).filter(|&ei| span[ei] > 1).collect();
        longest.sort_by(|&a, &b| span[b].cmp(&span[a]).then_with(|| a.cmp(&b)));
        for ei in longest {
            if dummies <= MAX_DUMMIES {
                break;
            }
            direct[ei] = true;
            dummies -= span[ei] - 1;
        }
    }

    let n = real + dummies;
    let mut w = vec![0.0f64; n];
    let mut h = vec![0.0f64; n];
    let mut kind = vec![Kind::Dummy; n];
    let mut rank_arr = vec![0usize; n];
    let mut max_rank: usize = 0;
    for (i, node) in nodes.iter().enumerate() {
        w[i] = node.w;
        h[i] = node.h;
        kind[i] = node.kind;
        rank_arr[i] = node.rank;
        if node.rank > max_rank {
            max_rank = node.rank;
        }
    }

    let mut segments: usize = 0;
    for ei in 0..m {
        if !direct[ei] {
            segments += span[ei];
        }
    }
    let mut ef = vec![0usize; segments];
    let mut et = vec![0usize; segments];
    let mut efd = vec![0.0f64; segments];
    let mut etd = vec![0.0f64; segments];
    let mut first_dummy = vec![-1i32; m];
    let mut heads = vec![0u8; max_rank + 1];
    let mut label_node = vec![-1i32; m];
    let spans = nodes.iter().any(|nd| nd.span > 0.0 && nd.kind == Kind::Node);
    let mut efk = if spans { Some(vec![End::Held; segments]) } else { None };
    let mut etk = if spans { Some(vec![End::Held; segments]) } else { None };
    let mut first_seg = vec![0usize; m];
    let mut last_seg = vec![0usize; m];
    let mut key_arr = vec![f64::NAN; n];
    for i in 0..real {
        key_arr[i] = nodes[i].key;
    }
    let mut offsets = false;
    {
        let mut next = real;
        let mut ce: usize = 0;
        for (ei, e) in edges.iter().enumerate() {
            if direct[ei] {
                continue;
            }
            let (a, b, a_dx, b_dx) = if e.reversed {
                (e.head, e.tail, e.head_dx, e.tail_dx)
            } else {
                (e.tail, e.head, e.tail_dx, e.head_dx)
            };
            if a_dx != 0.0 || b_dx != 0.0 {
                offsets = true;
            }
            let ra = rank_arr[a];
            let rb = rank_arr[b];
            let mut label_rank: Option<usize> = None;
            if e.label_w > 0.0 {
                let mut lr = ra + ((rb - ra) >> 1);
                if step == 2 && rb - ra >= 4 {
                    if (lr & 1) == 1 {
                        if e.reversed {
                            lr += 1;
                        } else {
                            lr -= 1;
                        }
                    }
                } else if step == 2 && (lr & 1) == 0 {
                    if e.reversed {
                        lr += 1;
                    } else {
                        lr -= 1;
                    }
                }
                label_rank = Some(lr);
            }
            let mut prev = a;
            if rb - ra > 1 {
                first_dummy[ei] = next as i32;
            }
            first_seg[ei] = ce;
            if let Some(ref mut efk_vec) = efk {
                let fixed = if e.reversed { e.head_fixed } else { e.tail_fixed };
                if !fixed {
                    efk_vec[ce] = if e.reversed { End::Arrives } else { End::Leaves };
                }
            }
            for (r, head_slot) in heads.iter_mut().enumerate().take(rb).skip(ra + 1) {
                let d = next;
                next += 1;
                rank_arr[d] = r;
                key_arr[d] = key_arr[a] + ((key_arr[b] - key_arr[a]) * (r - ra) as f64) / (rb - ra) as f64;
                if label_rank == Some(r) {
                    w[d] = e.label_w;
                    h[d] = e.label_h;
                    kind[d] = Kind::Label;
                    label_node[ei] = d as i32;
                    *head_slot |= if e.reversed { 2 } else { 1 };
                } else {
                    kind[d] = Kind::Dummy;
                }
                ef[ce] = prev;
                et[ce] = d;
                efd[ce] = if prev == a { a_dx } else { 0.0 };
                ce += 1;
                prev = d;
            }
            ef[ce] = prev;
            et[ce] = b;
            efd[ce] = if prev == a { a_dx } else { 0.0 };
            etd[ce] = b_dx;
            if let Some(ref mut etk_vec) = etk {
                let fixed = if e.reversed { e.tail_fixed } else { e.head_fixed };
                if !fixed {
                    etk_vec[ce] = if e.reversed { End::Leaves } else { End::Arrives };
                }
            }
            last_seg[ei] = ce;
            ce += 1;
        }
    }

    // Bends belong to the innermost group containing both edge endpoints.
    let grp: Option<Vec<i32>> = opt.groups.as_ref().map(|groups| {
        let of = &groups.of;
        let parent = &groups.parent;
        let mut g_vec = vec![0i32; n];
        g_vec[..real].copy_from_slice(&of[..real]);
        let depth = |mut gr: i32| -> usize {
            let mut d = 0;
            while gr >= 0 {
                d += 1;
                gr = parent[gr as usize];
            }
            d
        };
        let lca = |mut x: i32, mut y: i32| -> i32 {
            let mut dx = depth(x);
            let mut dy = depth(y);
            while dx > dy {
                x = parent[x as usize];
                dx -= 1;
            }
            while dy > dx {
                y = parent[y as usize];
                dy -= 1;
            }
            while x != y {
                x = parent[x as usize];
                y = parent[y as usize];
            }
            x
        };
        for (ei, e) in edges.iter().enumerate() {
            if first_dummy[ei] < 0 {
                continue;
            }
            let gr = lca(of[e.tail], of[e.head]);
            let d0 = first_dummy[ei] as usize;
            for item in &mut g_vec[d0..(d0 + span[ei] - 1)] {
                *item = gr;
            }
        }
        g_vec
    });

    let mut succ_start = vec![0usize; n + 1];
    let mut pred_start = vec![0usize; n + 1];
    for e in 0..segments {
        succ_start[ef[e] + 1] += 1;
        pred_start[et[e] + 1] += 1;
    }
    for i in 0..n {
        succ_start[i + 1] += succ_start[i];
        pred_start[i + 1] += pred_start[i];
    }
    let mut succ_e = vec![0usize; segments];
    let mut pred_e = vec![0usize; segments];
    {
        let mut sf = succ_start[..n].to_vec();
        let mut pf = pred_start[..n].to_vec();
        for e in 0..segments {
            let u = ef[e];
            succ_e[sf[u]] = e;
            sf[u] += 1;
            let v = et[e];
            pred_e[pf[v]] = e;
            pf[v] += 1;
        }
    }

    let mut layer_start = vec![0usize; max_rank + 2];
    for &r in &rank_arr {
        layer_start[r + 1] += 1;
    }
    for r in 0..=max_rank {
        layer_start[r + 1] += layer_start[r];
    }
    let mut order = vec![0usize; n];
    let pos = vec![0i32; n];

    // Initial order: depth-first from the top so that subtrees start out contiguous.
    {
        let mut by_rank = vec![0usize; n];
        let mut fill = layer_start[..=max_rank].to_vec();
        for (i, &r) in rank_arr.iter().enumerate() {
            by_rank[fill[r]] = i;
            fill[r] += 1;
        }
        fill.copy_from_slice(&layer_start[..=max_rank]);
        let mut visited = vec![false; n];
        let mut stack: Vec<usize> = Vec::new();
        for &start_v in &by_rank {
            if visited[start_v] {
                continue;
            }
            stack.push(start_v);
            while let Some(v) = stack.pop() {
                if visited[v] {
                    continue;
                }
                visited[v] = true;
                let r = rank_arr[v];
                order[fill[r]] = v;
                fill[r] += 1;
                for j in (succ_start[v]..succ_start[v + 1]).rev() {
                    let next_w = et[succ_e[j]];
                    if !visited[next_w] {
                        stack.push(next_w);
                    }
                }
            }
        }
    }

    let sort_rank = |order: &mut [usize], r: usize, key: &dyn Fn(usize) -> f64| -> bool {
        let s = layer_start[r];
        let e = layer_start[r + 1];
        if e - s < 2 {
            return false;
        }
        for &v in &order[s..e] {
            if key(v).is_nan() {
                return false;
            }
        }
        order[s..e].sort_by(|&a, &b| key(a).total_cmp(&key(b)));
        true
    };
    for r in 0..=max_rank {
        sort_rank(&mut order, r, &|v| key_arr[v]);
    }

    let pinned = nodes.iter().any(|nd| nd.pin != 0);
    if pinned {
        for r in 0..=max_rank {
            let s = layer_start[r];
            let e = layer_start[r + 1];
            let pin_of = |v: usize| -> i32 { if v < real { nodes[v].pin } else { 0 } };
            order[s..e].sort_by_key(|&v| pin_of(v));
        }
    }

    let mut fixed = vec![false; max_rank + 1];
    let hint_fn = |v: usize| -> f64 {
        if v < real && (nodes[v].kind == Kind::StartPort || nodes[v].kind == Kind::EndPort) {
            nodes[v].hint
        } else {
            f64::NAN
        }
    };
    for r in [0usize, max_rank] {
        if sort_rank(&mut order, r, &hint_fn) {
            fixed[r] = true;
        }
    }

    let mut g = Graph {
        n,
        real,
        max_rank,
        w,
        kind,
        rank: rank_arr,
        ef,
        et,
        efd,
        etd,
        succ_start,
        succ_e,
        pred_start,
        pred_e,
        layer_start,
        order,
        pos,
        offsets,
        fixed,
        grp,
        group_parent: opt.groups.as_ref().map(|gr| gr.parent.as_slice()),
    };
    set_positions(&mut g);

    let mut crossings = 0usize;
    let mut declared = 0usize;
    if segments > 0 && max_rank > 0 {
        let res = reduce_crossings(&mut g, nodes);
        crossings = res.0;
        declared = res.1;
        set_positions(&mut g);
    }

    if opt.order_only {
        let at = position(&mut g, opt);
        for i in 0..real {
            nodes[i].x = at[i];
        }
        for (ei, e) in edges.iter_mut().enumerate() {
            let (a, b) = if e.reversed { (e.head, e.tail) } else { (e.tail, e.head) };
            let mut pts = vec![g.rank[a] as f64, at[a]];
            if !direct[ei] && first_dummy[ei] >= 0 {
                let d0 = first_dummy[ei] as usize;
                for (d, &at_d) in at.iter().enumerate().take(d0 + span[ei] - 1).skip(d0) {
                    pts.push(g.rank[d] as f64);
                    pts.push(at_d);
                }
            }
            pts.push(g.rank[b] as f64);
            pts.push(at[b]);
            e.points = pts;
        }
        return LayeredResult {
            width: 0.0,
            height: 0.0,
            crossings: Some(crossings),
            declared: Some(declared),
        };
    }

    if let (Some(efk_ref), Some(etk_ref)) = (efk.as_deref(), etk.as_deref()) {
        spread(&mut g, nodes, efk_ref, etk_ref);
    }

    let mut xs = position(&mut g, opt);

    let empty = empty_ranks(&g);
    if let (Some(efk_ref), Some(etk_ref)) = (efk.as_deref(), etk.as_deref()) {
        let free = free_ends(&g, efk_ref, etk_ref);
        align_labels(&g, nodes, &mut xs, &free, opt, empty.as_deref());
        settle(&mut g, nodes, &xs, efk_ref, etk_ref, &free, empty.as_deref());
        snap(&g, &mut xs, empty.as_deref(), opt);
        for (ei, e) in edges.iter_mut().enumerate() {
            if direct[ei] {
                continue;
            }
            let a_dx = g.efd[first_seg[ei]];
            let b_dx = g.etd[last_seg[ei]];
            if e.reversed {
                e.tail_dx = b_dx;
                e.head_dx = a_dx;
            } else {
                e.tail_dx = a_dx;
                e.head_dx = b_dx;
            }
        }
    }

    align_ports(&g, &mut xs, empty.as_deref());

    let mut on_line = vec![false; n];
    if let Some(ref empty_vec) = empty
        && !opt.tracks
    {
        straighten(
            &g,
            &mut xs,
            empty_vec,
            &first_dummy,
            &span,
            if opt.apart { 0.0 } else { opt.edge_sep },
            &mut on_line,
        );
    }
    if !opt.tracks {
        past_labels(&g, &mut xs, &first_dummy, &span, opt.edge_sep, &mut on_line);
    }

    let mut piece_start = vec![0usize; m + 1];
    let mut pieces = if opt.tracks || (efk.is_some() && !opt.straight) {
        Some(Pieces {
            from: Vec::new(),
            to: Vec::new(),
            rank: Vec::new(),
            lower: Vec::new(),
            track: Vec::new(),
            levels: Vec::new(),
            wide: Vec::new(),
        })
    } else {
        None
    };
    let mut track_count = vec![0i32; max_rank + 1];
    if let Some(ref mut pcs) = pieces {
        for ei in 0..m {
            piece_start[ei] = pcs.from.len();
            if direct[ei] {
                continue;
            }
            let d0 = first_dummy[ei];
            let mut twin = false;
            if d0 >= 0 {
                let d0u = d0 as usize;
                for d in d0u..(d0u + span[ei] - 1) {
                    let bare = empty.as_ref().is_some_and(|em| em[g.rank[d]]);
                    if !opt.tracks && bare != on_line[d] {
                        twin = true;
                    }
                }
            }
            if twin {
                continue;
            }
            let mut x = xs[g.ef[first_seg[ei]]] + g.efd[first_seg[ei]];
            let mut cur_rank = g.rank[g.ef[first_seg[ei]]];
            if d0 >= 0 {
                let d0u = d0 as usize;
                for d in d0u..(d0u + span[ei] - 1) {
                    if empty.as_ref().is_some_and(|em| em[g.rank[d]]) {
                        continue;
                    }
                    pcs.from.push(x);
                    pcs.to.push(xs[d]);
                    pcs.rank.push(cur_rank);
                    pcs.lower.push(d as i32);
                    x = xs[d];
                    cur_rank = g.rank[d];
                }
            }
            pcs.from.push(x);
            pcs.to.push(xs[g.et[last_seg[ei]]] + g.etd[last_seg[ei]]);
            pcs.rank.push(cur_rank);
            pcs.lower.push(-1);
        }
        piece_start[m] = pcs.from.len();
    }

    let port_only = |r: usize, target_kind: Kind| -> bool {
        let mut found = false;
        for i in g.layer_start[r]..g.layer_start[r + 1] {
            let k = g.kind[g.order[i]];
            if k == target_kind {
                found = true;
            } else if k != Kind::Dummy {
                return false;
            }
        }
        found
    };
    let start_ranks = if port_only(0, Kind::StartPort) { step } else { 0 };
    let end_ranks = if port_only(max_rank, Kind::EndPort) { step } else { 0 };

    let mut run = vec![0.0f64; max_rank + 1];
    for e in 0..segments {
        let across = (xs[g.ef[e]] + g.efd[e] - xs[g.et[e]] - g.etd[e]).abs();
        let r = g.rank[g.ef[e]];
        if across > run[r] {
            run[r] = across;
        }
    }
    let mut band_top = vec![0.0f64; max_rank + 1];
    let mut band_bottom = vec![0.0f64; max_rank + 1];
    let usual = |r: usize| -> f64 {
        let sep = if r < start_ranks || r + end_ranks >= max_rank {
            opt.port_sep
        } else {
            opt.rank_sep
        };
        sep / (step as f64)
    };
    let mut gap_under = vec![0.0f64; max_rank + 1];
    for r in 0..max_rank {
        gap_under[r] = if pieces.is_some() {
            usual(r)
        } else {
            usual(r).max((MAX_GAP * opt.rank_sep / (step as f64)).min(run[r] * MIN_SLOPE))
        };
    }

    let mut between = vec![true; max_rank + 1];
    for i in 0..real {
        between[g.rank[i]] = false;
    }
    for r in 1..max_rank {
        if opt.tracks || !between[r] || (heads[r] != 1 && heads[r] != 2) {
            continue;
        }
        let target_gap = if heads[r] == 1 { gap_under[r - 1] } else { gap_under[r] };
        let shift = (opt.head_room / 2.0).min(target_gap / 2.0);
        if heads[r] == 1 {
            gap_under[r - 1] -= shift;
            gap_under[r] += shift;
        } else {
            gap_under[r - 1] += shift;
            gap_under[r] -= shift;
        }
    }

    let margin = if opt.tracks { TRACK_MARGIN } else { LEVEL_MARGIN };
    let least_pitch = if opt.tracks { TRACK_PITCH } else { LEVEL_PITCH };
    let most_pitch = if opt.tracks { TRACK_SPREAD } else { LEVEL_PITCH };
    let mut below = vec![0usize; max_rank + 1];
    if let Some(ref mut pcs) = pieces {
        let mut room = vec![0.0f64; max_rank + 1];
        for r in 0..max_rank {
            if empty.as_ref().is_some_and(|em| em[r]) {
                continue;
            }
            let mut next = r + 1;
            room[r] = gap_under[r];
            while next < max_rank && empty.as_ref().is_some_and(|em| em[next]) {
                room[r] += gap_under[next];
                next += 1;
            }
            below[r] = next;
        }
        for k in 0..pcs.from.len() {
            let is_wide = (pcs.from[k] - pcs.to[k]).abs() > LEVEL_WIDE * room[pcs.rank[k]];
            pcs.wide.push(u8::from(is_wide));
        }
        let mut tall = vec![0.0f64; max_rank + 1];
        assign_tracks(pcs, &mut track_count, !opt.tracks, &room, &mut tall);
        for r in 0..max_rank {
            if track_count[r] > 0 {
                let need = 2.0 * margin + ((track_count[r] - 1) as f64) * least_pitch;
                gap_under[r] += (need - room[r]).max(0.0);
            } else if tall[r] > 0.0 {
                gap_under[r] += ((MAX_GAP * opt.rank_sep).min(tall[r]) - room[r]).max(0.0);
            }
        }
    }

    let mut y = 0.0f64;
    for r in 0..=max_rank {
        let mut rh = 0.0f64;
        for i in g.layer_start[r]..g.layer_start[r + 1] {
            let hi = h[g.order[i]];
            if hi > rh {
                rh = hi;
            }
        }
        band_top[r] = y;
        band_bottom[r] = y + rh;
        y += rh + gap_under[r];
    }
    let height = y;

    let inset = |d: usize| -> f64 {
        if g.kind[d] == Kind::Dummy && between[g.rank[d]] && !opt.tracks {
            (band_bottom[g.rank[d]] - band_top[g.rank[d]]) / 4.0
        } else {
            0.0
        }
    };

    let track_y = |pcs: &Pieces, piece: usize, on_track: i32| -> f64 {
        let r = pcs.rank[piece];
        let top = band_bottom[r];
        let bottom = band_top[below[r]];
        let count = if opt.tracks { track_count[r] } else { pcs.levels[piece] };
        let pitch = if count > 1 {
            most_pitch.min((bottom - top - 2.0 * margin) / ((count - 1) as f64))
        } else {
            0.0
        };
        (top + bottom) / 2.0 + (on_track as f64 - ((count - 1) as f64) / 2.0) * pitch
    };

    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    for (i, &x_i) in xs.iter().enumerate().take(n) {
        let half = g.w[i] / 2.0;
        if x_i - half < min_x {
            min_x = x_i - half;
        }
        if x_i + half > max_x {
            max_x = x_i + half;
        }
    }

    let mut arrives = vec![false; max_rank + 1];
    let mut leaves = vec![false; max_rank + 1];
    if efk.is_some() {
        for i in 0..real {
            if g.kind[i] != Kind::Node {
                continue;
            }
            if g.pred_start[i + 1] > g.pred_start[i] {
                arrives[g.rank[i]] = true;
            }
            if g.succ_start[i + 1] > g.succ_start[i] {
                leaves[g.rank[i]] = true;
            }
        }
    }
    for (i, node) in nodes.iter_mut().enumerate() {
        let r = node.rank;
        node.x = xs[i] - min_x;
        if g.kind[i] == Kind::Node && leaves[r] && !arrives[r] {
            node.y = band_bottom[r] - node.h / 2.0;
        } else if g.kind[i] == Kind::Node && arrives[r] && !leaves[r] {
            node.y = band_top[r] + node.h / 2.0;
        } else {
            node.y = (band_top[r] + band_bottom[r]) / 2.0;
        }
    }

    for (ei, e) in edges.iter_mut().enumerate() {
        let first = &nodes[if e.reversed { e.head } else { e.tail }];
        let last = &nodes[if e.reversed { e.tail } else { e.head }];
        let mut pts = vec![first.x + if e.reversed { e.head_dx } else { e.tail_dx }, first.y + first.h / 2.0];
        let d0 = first_dummy[ei];
        if let Some(ref pcs) = pieces
            && piece_start[ei + 1] > piece_start[ei]
        {
            for k in piece_start[ei]..piece_start[ei + 1] {
                if pcs.track[k] >= 0 && (opt.tracks || pcs.wide[k] == 1) {
                    let across = track_y(pcs, k, pcs.track[k]);
                    pts.push(pcs.from[k] - min_x);
                    pts.push(across);
                    pts.push(pcs.to[k] - min_x);
                    pts.push(across);
                } else if pcs.track[k] > 0 {
                    pts.push(pcs.from[k] - min_x);
                    pts.push(track_y(pcs, k, pcs.track[k] - 1));
                }
                let d_signed = pcs.lower[k];
                if d_signed < 0 {
                    continue;
                }
                let d = d_signed as usize;
                let top = band_top[g.rank[d]];
                let bottom = band_bottom[g.rank[d]];
                let ins = inset(d);
                pts.push(xs[d] - min_x);
                pts.push(top + ins);
                if bottom > top {
                    pts.push(xs[d] - min_x);
                    pts.push(bottom - ins);
                }
            }
        } else if d0 >= 0 {
            let d0u = d0 as usize;
            for d in d0u..(d0u + span[ei] - 1) {
                if on_line[d] {
                    continue;
                }
                let x = xs[d] - min_x;
                let top = band_top[g.rank[d]];
                let bottom = band_bottom[g.rank[d]];
                let ins = inset(d);
                pts.push(x);
                pts.push(top + ins);
                if bottom > top {
                    pts.push(x);
                    pts.push(bottom - ins);
                }
            }
        }
        pts.push(last.x + if e.reversed { e.tail_dx } else { e.head_dx });
        pts.push(last.y - last.h / 2.0);
        if e.reversed {
            let mut i = 0usize;
            let mut j = pts.len() - 2;
            while i < j {
                pts.swap(i, j);
                pts.swap(i + 1, j + 1);
                i += 2;
                j -= 2;
            }
        }
        let ln = label_node[ei];
        if ln >= 0 {
            let lnu = ln as usize;
            e.label_x = xs[lnu] - min_x;
            e.label_y = (band_top[g.rank[lnu]] + band_bottom[g.rank[lnu]]) / 2.0;
        } else if e.label_w > 0.0 {
            e.label_x = (pts[0] + pts[pts.len() - 2]) / 2.0;
            e.label_y = (pts[1] + pts[pts.len() - 1]) / 2.0;
        }
        e.points = pts;
    }

    LayeredResult {
        width: max_x - min_x,
        height,
        crossings: None,
        declared: None,
    }
}

fn set_positions(g: &mut Graph<'_>) {
    for r in 0..=g.max_rank {
        let s = g.layer_start[r];
        for i in s..g.layer_start[r + 1] {
            g.pos[g.order[i]] = (i - s) as i32;
        }
    }
}

/// Reverses the edges that close a cycle, found by depth-first search in declaration order.
pub fn orient(nodes: &[LNode], edges: &mut [LEdge]) {
    let n = nodes.len();
    let mut start = vec![0usize; n + 1];
    for e in edges.iter_mut() {
        e.reversed = nodes[e.head].kind == Kind::StartPort || nodes[e.tail].kind == Kind::EndPort;
        if !e.reversed {
            start[e.tail + 1] += 1;
        }
    }
    for i in 0..n {
        start[i + 1] += start[i];
    }
    let mut out = vec![0usize; start[n]];
    {
        let mut fill = start[..n].to_vec();
        for (i, e) in edges.iter().enumerate() {
            if !e.reversed {
                out[fill[e.tail]] = i;
                fill[e.tail] += 1;
            }
        }
    }
    let mut state = vec![0u8; n];
    let mut cursor = start[..n].to_vec();
    let mut stack: Vec<usize> = Vec::new();
    for root in 0..n {
        if state[root] != 0 {
            continue;
        }
        stack.push(root);
        state[root] = 1;
        while let Some(&v) = stack.last() {
            if cursor[v] < start[v + 1] {
                let ei = out[cursor[v]];
                cursor[v] += 1;
                let w = edges[ei].head;
                if state[w] == 1 {
                    edges[ei].reversed = true;
                } else if state[w] == 0 {
                    state[w] = 1;
                    stack.push(w);
                }
            } else {
                state[v] = 2;
                stack.pop();
            }
        }
    }
}

pub fn rank(nodes: &mut [LNode], edges: &[LEdge], step: i32) {
    let n = nodes.len();
    let m = edges.len();
    let mut from = vec![0usize; m];
    let mut to = vec![0usize; m];
    let mut len = vec![0i32; m];
    let mut out_start = vec![0usize; n + 1];
    let mut in_start = vec![0usize; n + 1];
    for (i, e) in edges.iter().enumerate() {
        let (a, b) = if e.reversed { (e.head, e.tail) } else { (e.tail, e.head) };
        from[i] = a;
        to[i] = b;
        len[i] = e.minlen.max(1) * step;
        out_start[a + 1] += 1;
        in_start[b + 1] += 1;
    }
    for i in 0..n {
        out_start[i + 1] += out_start[i];
        in_start[i + 1] += in_start[i];
    }
    let mut out_e = vec![0usize; m];
    let mut in_e = vec![0usize; m];
    {
        let mut of = out_start[..n].to_vec();
        let mut inf = in_start[..n].to_vec();
        for i in 0..m {
            out_e[of[from[i]]] = i;
            of[from[i]] += 1;
            in_e[inf[to[i]]] = i;
            inf[to[i]] += 1;
        }
    }

    let mut r = vec![0i32; n];
    for (i, node) in nodes.iter().enumerate() {
        if node.kind == Kind::StartPort {
            r[i] = -step;
        }
    }
    let mut indeg = vec![0usize; n];
    for i in 0..n {
        indeg[i] = in_start[i + 1] - in_start[i];
    }
    let mut topo = vec![0usize; n];
    let mut count = 0usize;
    for (i, &deg) in indeg.iter().enumerate() {
        if deg == 0 {
            topo[count] = i;
            count += 1;
        }
    }
    let mut q = 0usize;
    while q < count {
        let v = topo[q];
        q += 1;
        for &ei in &out_e[out_start[v]..out_start[v + 1]] {
            let w = to[ei];
            if r[v] + len[ei] > r[w] {
                r[w] = r[v] + len[ei];
            }
            indeg[w] -= 1;
            if indeg[w] == 0 {
                topo[count] = w;
                count += 1;
            }
        }
    }

    // Tighten loosely attached nodes toward the side with more incident edges.
    for _pass in 0..8 {
        let mut changed = false;
        for q in (0..count).rev() {
            let v = topo[q];
            let ins = in_start[v + 1] - in_start[v];
            let outs = out_start[v + 1] - out_start[v];
            if ins == 0 && outs == 0 {
                continue;
            }
            let mut lo: Option<i32> = None;
            let mut hi: Option<i32> = None;
            for &ei in &in_e[in_start[v]..in_start[v + 1]] {
                let cand = r[from[ei]] + len[ei];
                lo = Some(lo.map_or(cand, |cur| cur.max(cand)));
            }
            for &ei in &out_e[out_start[v]..out_start[v + 1]] {
                let cand = r[to[ei]] - len[ei];
                hi = Some(hi.map_or(cand, |cur| cur.min(cand)));
            }
            let mut next = r[v];
            if outs > ins
                && let Some(h) = hi
            {
                next = h;
            } else if ins > outs
                && let Some(l) = lo
            {
                next = l;
            }
            if next != r[v] {
                r[v] = next;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }

    let mut min_r: Option<i32> = None;
    let mut max_r: Option<i32> = None;
    let mut start_ports = false;
    for (i, node) in nodes.iter().enumerate() {
        match node.kind {
            Kind::StartPort => {
                start_ports = true;
            }
            Kind::EndPort => {}
            Kind::Node | Kind::Dummy | Kind::Label => {
                min_r = Some(min_r.map_or(r[i], |cur| cur.min(r[i])));
                max_r = Some(max_r.map_or(r[i], |cur| cur.max(r[i])));
            }
        }
    }
    let mut min_val = min_r.unwrap_or(0);
    let max_val = max_r.unwrap_or(0);
    for (i, node) in nodes.iter().enumerate() {
        match node.kind {
            Kind::StartPort => r[i] = min_val - step,
            Kind::EndPort => r[i] = max_val + step,
            Kind::Node | Kind::Dummy | Kind::Label => {}
        }
    }
    if start_ports {
        min_val -= step;
    }
    for (i, node) in nodes.iter_mut().enumerate() {
        node.rank = (r[i] - min_val) as usize;
    }
}

fn side_ends(g: &Graph<'_>, v: usize, side: usize, span: f64, kinds: &[End], ids: &mut Vec<usize>, room: &mut Vec<f64>) -> f64 {
    let (start, list, other) = if side == 0 {
        (&g.pred_start, &g.pred_e, &g.ef)
    } else {
        (&g.succ_start, &g.succ_e, &g.et)
    };
    let pos = &g.pos;
    for &e in &list[start[v]..start[v + 1]] {
        if kinds[e] != End::Held {
            ids.push(e);
        }
    }
    if ids.len() < 2 {
        return 0.0;
    }
    ids.sort_by(|&a, &b| pos[other[a]].cmp(&pos[other[b]]).then_with(|| a.cmp(&b)));
    room.resize(ids.len(), 0.0);
    let fill = |room: &mut [f64], share: &dyn Fn(bool, bool) -> f64| -> f64 {
        let mut total = 0.0;
        room[0] = 0.0;
        for k in 1..ids.len() {
            let same = kinds[ids[k]] == kinds[ids[k - 1]];
            room[k] = share(same && kinds[ids[k]] == End::Leaves, same);
            total += room[k];
        }
        total
    };
    let mut total = fill(room, &|_, _| 1.0);
    if span / total < MIN_PITCH {
        total = fill(room, &|leaves, _| if leaves { 0.5 } else { 1.0 });
    }
    if span / total < MIN_PITCH {
        total = fill(room, &|_, same| if same { 0.0 } else { 1.0 });
    }
    if total == 0.0 {
        return 0.0;
    }
    let pitch = PORT_PITCH.min(span / total);
    for item in &mut room[1..ids.len()] {
        *item *= pitch;
    }
    total * pitch
}

fn spread(g: &mut Graph<'_>, nodes: &[LNode], efk: &[End], etk: &[End]) {
    for (v, node) in nodes.iter().enumerate().take(g.real) {
        let span = node.span.min(g.w[v]);
        if span <= 0.0 || node.kind != Kind::Node {
            continue;
        }
        for side in 0..2 {
            let mut ids = Vec::new();
            let mut room = Vec::new();
            let total = side_ends(g, v, side, span, if side == 0 { etk } else { efk }, &mut ids, &mut room);
            if total == 0.0 {
                continue;
            }
            let dx = if side == 0 { &mut g.etd } else { &mut g.efd };
            let mut at = -total / 2.0;
            for (k, &id) in ids.iter().enumerate() {
                at += room[k];
                dx[id] = at;
            }
        }
    }
}

fn follow(g: &Graph<'_>, empty: Option<&[bool]>, mut e: usize, side: usize) -> usize {
    let Some(empty) = empty else {
        return e;
    };
    for _ in 0..100_000 {
        let u = if side == 0 { g.ef[e] } else { g.et[e] };
        if g.kind[u] != Kind::Dummy || !empty[g.rank[u]] {
            break;
        }
        e = if side == 0 { g.pred_e[g.pred_start[u]] } else { g.succ_e[g.succ_start[u]] };
    }
    e
}

fn align_ports(g: &Graph<'_>, xs: &mut [f64], empty: Option<&[bool]>) {
    for (r, target_kind) in [(0usize, Kind::StartPort), (g.max_rank, Kind::EndPort)] {
        let s = g.layer_start[r];
        let end = g.layer_start[r + 1];
        let mut to: Vec<f64> = Vec::with_capacity(end - s);
        let start = target_kind == Kind::StartPort;
        for i in s..end {
            let v = g.order[i];
            let deg = if start {
                g.succ_start[v + 1] - g.succ_start[v]
            } else {
                g.pred_start[v + 1] - g.pred_start[v]
            };
            if g.kind[v] != target_kind || deg != 1 {
                break;
            }
            let seg = if start { g.succ_e[g.succ_start[v]] } else { g.pred_e[g.pred_start[v]] };
            let e = follow(g, empty, seg, if start { 1 } else { 0 });
            let at = if start { xs[g.et[e]] + g.etd[e] } else { xs[g.ef[e]] + g.efd[e] };
            if let Some(&prev) = to.last()
                && at < prev + TWIN
            {
                break;
            }
            to.push(at);
        }
        if to.is_empty() || to.len() != end - s {
            continue;
        }
        for (idx, &at) in to.iter().enumerate() {
            xs[g.order[s + idx]] = at;
        }
    }
}

fn free_ends(g: &Graph<'_>, efk: &[End], etk: &[End]) -> [Vec<i32>; 2] {
    let mut free = [vec![0i32; g.n], vec![0i32; g.n]];
    for e in 0..g.ef.len() {
        if etk[e] != End::Held {
            free[0][g.et[e]] += 1;
        }
        if efk[e] != End::Held {
            free[1][g.ef[e]] += 1;
        }
    }
    free
}

/// Share of along-flow travel reached by plain S-curve handles.
pub fn ease(across: f64, along: f64) -> f64 {
    let denom = across.abs();
    let denom = if denom == 0.0 { 1.0 } else { denom };
    ((4.0 * along.abs()) / denom).clamp(0.25, 0.5)
}

fn align_labels(g: &Graph<'_>, nodes: &[LNode], xs: &mut [f64], free: &[Vec<i32>; 2], opt: &LayeredOptions, empty: Option<&[bool]>) {
    let sep = opt.edge_sep;
    let placed = |v: usize| -> bool { g.kind[v] == Kind::Label || (g.kind[v] == Kind::Dummy && !empty.is_some_and(|em| em[g.rank[v]])) };
    let end_info = |xs: &[f64], e: usize, side: usize| -> (f64, i32) {
        let u = if side == 0 { g.ef[e] } else { g.et[e] };
        let x = if side == 0 { xs[u] + g.efd[e] } else { xs[u] + g.etd[e] };
        let count = if u < g.real && nodes[u].kind == Kind::Node { free[1 - side][u] } else { 0 };
        (x, count)
    };
    let room = |xs: &[f64], v: usize| -> (f64, f64) {
        let s = g.layer_start[g.rank[v]];
        let i = s + g.pos[v] as usize;
        let clear = |other: usize| -> f64 {
            let gap = if g.kind[other] == Kind::Node {
                opt.node_sep / 2.0 + sep / 2.0
            } else if g.kind[other] == g.kind[v] {
                sep
            } else {
                sep / 2.0
            };
            g.w[other] / 2.0 + g.w[v] / 2.0 + gap
        };
        let lo = if i > s {
            xs[g.order[i - 1]] + clear(g.order[i - 1])
        } else {
            f64::NEG_INFINITY
        };
        let hi = if i + 1 < g.layer_start[g.rank[v] + 1] {
            xs[g.order[i + 1]] - clear(g.order[i + 1])
        } else {
            f64::INFINITY
        };
        (lo, hi)
    };
    let choose = |x: f64, up: (f64, i32), down: (f64, i32), lo: f64, hi: f64| -> f64 {
        let up_first = if up.1 != down.1 {
            up.1 < down.1
        } else {
            (up.0 - x).abs() <= (down.0 - x).abs()
        };
        let choices = if up_first { [up.0, down.0] } else { [down.0, up.0] };
        for choice in choices {
            if choice >= lo && choice <= hi {
                return choice;
            }
        }
        choices[0].min(hi).max(lo)
    };
    let mut done = vec![false; g.n];
    let mut chain: Vec<usize> = Vec::new();
    for r in 1..g.max_rank {
        for i in g.layer_start[r]..g.layer_start[r + 1] {
            let v = g.order[i];
            if !placed(v) || done[v] {
                continue;
            }
            let mut top = v;
            while g.kind[g.ef[g.pred_e[g.pred_start[top]]]].is_dummy() {
                top = g.ef[g.pred_e[g.pred_start[top]]];
            }
            let mut bottom = top;
            let mut lo = f64::NEG_INFINITY;
            let mut hi = f64::INFINITY;
            chain.clear();
            let mut d = top;
            while g.kind[d].is_dummy() {
                bottom = d;
                if placed(d) {
                    done[d] = true;
                    chain.push(d);
                    let (least, most) = room(xs, d);
                    if least > lo {
                        lo = least;
                    }
                    if most < hi {
                        hi = most;
                    }
                }
                d = g.et[g.succ_e[g.succ_start[d]]];
            }
            if lo <= hi {
                let up = end_info(xs, g.pred_e[g.pred_start[top]], 0);
                let down = end_info(xs, g.succ_e[g.succ_start[bottom]], 1);
                let x = choose(xs[chain[0]], up, down, lo, hi);
                for &cd in &chain {
                    xs[cd] = x;
                }
                continue;
            }
            for &cd in &chain {
                let (least, most) = room(xs, cd);
                if least > most {
                    continue;
                }
                let up_e = follow(g, empty, g.pred_e[g.pred_start[cd]], 0);
                let down_e = follow(g, empty, g.succ_e[g.succ_start[cd]], 1);
                let up = end_info(xs, up_e, 0);
                let down = end_info(xs, down_e, 1);
                xs[cd] = choose(xs[cd], up, down, least, most);
            }
        }
    }
}

struct SideGroup {
    v: usize,
    side: usize,
    span: f64,
    ids: Vec<usize>,
    room: Vec<f64>,
    all: Vec<usize>,
}

fn settle(g: &mut Graph<'_>, nodes: &[LNode], xs: &[f64], efk: &[End], etk: &[End], free: &[Vec<i32>; 2], empty: Option<&[bool]>) {
    let mut sides: Vec<SideGroup> = Vec::new();
    for v in 0..g.real {
        let span = nodes[v].span.min(g.w[v]);
        if span <= 0.0 || nodes[v].kind != Kind::Node {
            continue;
        }
        for side in 0..2 {
            let (other, start, list, kinds) = if side == 0 {
                (&g.ef, &g.pred_start, &g.pred_e, etk)
            } else {
                (&g.et, &g.succ_start, &g.succ_e, efk)
            };
            let mut ids = Vec::new();
            let mut room = Vec::new();
            side_ends(g, v, side, span, kinds, &mut ids, &mut room);
            if ids.is_empty() {
                continue;
            }
            if ids.len() == 1 {
                room.push(0.0);
            }
            let mut all: Vec<usize> = list[start[v]..start[v + 1]].to_vec();
            all.sort_by(|&a, &b| g.pos[other[a]].cmp(&g.pos[other[b]]).then_with(|| a.cmp(&b)));
            sides.push(SideGroup { v, side, span, ids, room, all });
        }
    }

    for pass in 0..6 {
        let mut moved = false;
        for sg in &sides {
            let v = sg.v;
            let side = sg.side;
            let span = sg.span;
            let kinds = if side == 0 { etk } else { efk };
            let mut k = 0usize;
            let mut lo = -span / 2.0;
            for i in 0..=sg.all.len() {
                let held = i < sg.all.len() && kinds[sg.all[i]] == End::Held;
                if i < sg.all.len() && !held {
                    continue;
                }
                let mut size = 0usize;
                let mut j = i;
                while j > 0 && kinds[sg.all[j - 1]] != End::Held {
                    size += 1;
                    j -= 1;
                }
                let hi = if held {
                    let dx_val = if side == 0 { g.etd[sg.all[i]] } else { g.efd[sg.all[i]] };
                    dx_val - PORT_PITCH
                } else {
                    span / 2.0
                };
                if size > 0 {
                    let mut sum: Vec<f64> = Vec::with_capacity(size);
                    let mut count: Vec<usize> = Vec::with_capacity(size);
                    let mut before = 0.0f64;
                    for j in 0..size {
                        if j > 0 {
                            before += sg.room[k + j];
                        }
                        let w_val = wanted_end(g, nodes, xs, efk, etk, free, empty, sg.ids[k + j], side, v, span, pass > 0);
                        sum.push(w_val - before);
                        count.push(1);
                        let mut together = j > 0 && sg.room[k + j] == 0.0;
                        while sum.len() > 1
                            && (together || sum[sum.len() - 2] / (count[count.len() - 2] as f64) > sum[sum.len() - 1] / (count[count.len() - 1] as f64))
                        {
                            together = false;
                            let top = sum.pop().unwrap();
                            let pooled = count.pop().unwrap();
                            *sum.last_mut().unwrap() += top;
                            *count.last_mut().unwrap() += pooled;
                        }
                    }
                    let total = before;
                    let mut j = 0usize;
                    before = 0.0;
                    let dx = if side == 0 { &mut g.etd } else { &mut g.efd };
                    for b in 0..sum.len() {
                        let level = if hi - total < lo {
                            (lo + hi - total) / 2.0
                        } else {
                            (sum[b] / (count[b] as f64)).clamp(lo, hi - total)
                        };
                        for _ in 0..count[b] {
                            if j > 0 {
                                before += sg.room[k + j];
                            }
                            if (dx[sg.ids[k + j]] - level - before).abs() > 0.01 {
                                moved = true;
                            }
                            dx[sg.ids[k + j]] = level + before;
                            j += 1;
                        }
                    }
                    k += size;
                }
                if held {
                    let dx_val = if side == 0 { g.etd[sg.all[i]] } else { g.efd[sg.all[i]] };
                    lo = dx_val + PORT_PITCH;
                }
            }
        }
        if !moved {
            break;
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn wanted_end(
    g: &Graph<'_>,
    nodes: &[LNode],
    xs: &[f64],
    efk: &[End],
    etk: &[End],
    free: &[Vec<i32>; 2],
    empty: Option<&[bool]>,
    mut e: usize,
    side: usize,
    v: usize,
    span: f64,
    again: bool,
) -> f64 {
    if free[side][v] < 2 {
        return 0.0;
    }
    e = follow(g, empty, e, side);
    let u = if side == 0 { g.ef[e] } else { g.et[e] };
    let point = if side == 0 { xs[u] + g.efd[e] } else { xs[u] + g.etd[e] };
    if again && (point - xs[v]).abs() <= span / 2.0 + IN_LINE {
        return (point - xs[v]).clamp(-span / 2.0, span / 2.0);
    }
    let mut middle = point;
    let mut width = 0.0f64;
    let other_end_kind = if side == 0 { efk[e] } else { etk[e] };
    if u < g.real && nodes[u].kind == Kind::Node && other_end_kind != End::Held && free[1 - side][u] >= 2 {
        width = nodes[u].span.min(g.w[u]).max(0.0);
        if width > 0.0 {
            middle = xs[u];
        }
    }
    let lo = (xs[v] - span / 2.0).max(middle - width / 2.0);
    let hi = (xs[v] + span / 2.0).min(middle + width / 2.0);
    if lo > hi + IN_LINE {
        let lean = (span / 2.0 - LEAN_CLEAR).max(0.0);
        return (point - xs[v]).clamp(-lean, lean);
    }
    let place = (xs[v] * width + middle * span) / (width + span);
    place.min(hi).max(lo) - xs[v]
}

fn snap(g: &Graph<'_>, xs: &mut [f64], empty: Option<&[bool]>, opt: &LayeredOptions) {
    let passed = |u: usize| -> bool { empty.is_some_and(|em| g.kind[u] == Kind::Dummy && em[g.rank[u]]) };
    let mut a: Vec<usize> = Vec::new();
    let mut b: Vec<usize> = Vec::new();
    let mut da: Vec<f64> = Vec::new();
    let mut db: Vec<f64> = Vec::new();
    for e in 0..g.ef.len() {
        if passed(g.ef[e]) {
            continue;
        }
        let f = follow(g, empty, e, 1);
        a.push(g.ef[e]);
        b.push(g.et[f]);
        da.push(g.efd[e]);
        db.push(g.etd[f]);
    }
    let off = |xs: &[f64], k: usize| -> f64 { xs[b[k]] + db[k] - xs[a[k]] - da[k] };

    let mut block: Vec<usize> = (0..g.n).collect();
    let mut members: Vec<Vec<usize>> = (0..g.n).map(|i| vec![i]).collect();
    let join = |block: &mut [usize], members: &mut [Vec<usize>], x: usize, y: usize| {
        let mut keep = block[x];
        let mut drop = block[y];
        if keep == drop {
            return;
        }
        if members[keep].len() < members[drop].len() {
            std::mem::swap(&mut keep, &mut drop);
        }
        let moved = std::mem::take(&mut members[drop]);
        for v in moved {
            block[v] = keep;
            members[keep].push(v);
        }
    };

    let mut near: Vec<usize> = Vec::new();
    for k in 0..a.len() {
        let d = off(xs, k).abs();
        if d < 0.01 {
            join(&mut block, &mut members, a[k], b[k]);
        } else if d <= BEND_SNAP {
            near.push(k);
        }
    }
    if near.is_empty() {
        return;
    }
    near.sort_by(|&x, &y| off(xs, x).abs().total_cmp(&off(xs, y).abs()).then_with(|| x.cmp(&y)));

    let free_move = |xs: &[f64], block: &[usize], members: &[Vec<usize>], id: usize, shift: f64| -> bool {
        for &v in &members[id] {
            let s = g.layer_start[g.rank[v]];
            let end = g.layer_start[g.rank[v] + 1];
            let i = s + g.pos[v] as usize;
            if i > s {
                let left = g.order[i - 1];
                if block[left] != id && xs[v] + shift - xs[left] < half_room(g, opt, v) + half_room(g, opt, left) - 0.01 {
                    return false;
                }
            }
            if i + 1 < end {
                let right = g.order[i + 1];
                if block[right] != id && xs[right] - xs[v] - shift < half_room(g, opt, v) + half_room(g, opt, right) - 0.01 {
                    return false;
                }
            }
        }
        true
    };

    for k in near {
        let d = off(xs, k);
        if d.abs() < 0.01 {
            join(&mut block, &mut members, a[k], b[k]);
            continue;
        }
        if d.abs() > BEND_SNAP || block[a[k]] == block[b[k]] {
            continue;
        }
        let upper = block[a[k]];
        let lower = block[b[k]];
        let first = if members[upper].len() <= members[lower].len() { upper } else { lower };
        let second = if first == upper { lower } else { upper };
        for id in [first, second] {
            let shift = if id == upper { d } else { -d };
            if d.abs() > SNAP && !members[id].iter().all(|&v| g.kind[v] == Kind::Dummy) {
                continue;
            }
            if !free_move(xs, &block, &members, id, shift) {
                continue;
            }
            for &v in &members[id] {
                xs[v] += shift;
            }
            join(&mut block, &mut members, a[k], b[k]);
            break;
        }
    }
}

fn empty_ranks(g: &Graph<'_>) -> Option<Vec<bool>> {
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

fn assign_tracks(pieces: &mut Pieces, track_count: &mut [i32], curved: bool, room: &[f64], tall: &mut [f64]) {
    let total = pieces.from.len();
    let mut by_rank: IndexMap<usize, Vec<usize>> = IndexMap::new();
    for k in 0..total {
        pieces.track.push(-1);
        pieces.levels.push(0);
        if (pieces.from[k] - pieces.to[k]).abs() < IN_LINE {
            continue;
        }
        by_rank.entry(pieces.rank[k]).or_default().push(k);
    }
    if by_rank.is_empty() {
        return;
    }

    let mut lo = vec![0.0f64; total];
    let mut hi = vec![0.0f64; total];
    for k in 0..total {
        lo[k] = pieces.from[k].min(pieces.to[k]);
        hi[k] = pieces.from[k].max(pieces.to[k]);
    }
    let from = &pieces.from;
    let to = &pieces.to;
    let wide = &pieces.wide;

    let within = |x: f64, k: usize| -> i32 { i32::from(x >= lo[k] - IN_LINE && x <= hi[k] + IN_LINE) };
    let mates = |a: usize, b: usize| -> bool { (from[a] - from[b]).abs() < IN_LINE || (to[a] - to[b]).abs() < IN_LINE };
    let overlap = |a: usize, b: usize| -> bool { lo[a] < hi[b] - IN_LINE && lo[b] < hi[a] - IN_LINE };
    let clash = |a: usize, b: usize| -> bool { overlap(a, b) && !mates(a, b) };
    let meet = |a: usize, b: usize| -> bool { overlap(a, b) || within(to[a], b) + within(from[b], a) + within(to[b], a) + within(from[a], b) > 0 };
    let crossings = |a: usize, b: usize| -> i32 { within(to[a], b) + within(from[b], a) };

    let near_pairs = |list: &[usize]| -> Vec<(usize, usize)> {
        let mut by_lo: Vec<usize> = (0..list.len()).collect();
        by_lo.sort_by(|&a, &b| lo[list[a]].total_cmp(&lo[list[b]]));
        let mut pairs = Vec::new();
        for x in 0..by_lo.len() {
            let i = by_lo[x];
            let reach = hi[list[i]] + 4.0 * IN_LINE;
            let mut y = x + 1;
            while y < by_lo.len() && lo[list[by_lo[y]]] <= reach {
                let j = by_lo[y];
                pairs.push((i.min(j), i.max(j)));
                y += 1;
            }
        }
        pairs
    };

    let lay = |list: &mut [usize], track: &mut [i32], levels: &mut [i32]| -> i32 {
        list.sort_by(|&a, &b| {
            (hi[b] - lo[b])
                .total_cmp(&(hi[a] - lo[a]))
                .then_with(|| lo[a].total_cmp(&lo[b]))
                .then_with(|| a.cmp(&b))
        });
        let count = list.len();
        let mut group: Vec<usize> = (0..count).collect();
        let find = |group: &mut [usize], mut i: usize| -> usize {
            while group[i] != i {
                group[i] = group[group[i]];
                i = group[i];
            }
            i
        };
        let weighed = count <= MAX_WEIGHED;
        let pairs = if weighed { near_pairs(list) } else { Vec::new() };
        let mut clashes: Vec<Vec<usize>> = if weighed { vec![Vec::new(); count] } else { Vec::new() };
        for &(i, j) in &pairs {
            if !clash(list[i], list[j]) {
                continue;
            }
            clashes[i].push(j);
            clashes[j].push(i);
        }
        let mut above: Vec<Vec<usize>> = Vec::new();
        let mut sequence: Vec<usize> = (0..count).collect();
        if weighed {
            let mut waiting = vec![0i32; count];
            let mut after: Vec<Vec<usize>> = vec![Vec::new(); count];
            above = vec![Vec::new(); count];
            for &(i, j) in &pairs {
                let a = list[i];
                let b = list[j];
                if !meet(a, b) {
                    continue;
                }
                let ri = find(&mut group, i);
                let rj = find(&mut group, j);
                group[ri] = rj;
                let ab = crossings(a, b);
                let ba = crossings(b, a);
                if ab == ba {
                    continue;
                }
                let (first, second) = if ab < ba { (i, j) } else { (j, i) };
                above[second].push(first);
                after[first].push(second);
                waiting[second] += 1;
            }
            let mut placed = vec![false; count];
            sequence.clear();
            for _ in 0..count {
                let mut pick: Option<usize> = None;
                for i in 0..count {
                    if placed[i] {
                        continue;
                    }
                    if pick.is_none_or(|p| waiting[i] < waiting[p]) {
                        pick = Some(i);
                    }
                    if waiting[i] == 0 {
                        break;
                    }
                }
                let p = pick.unwrap();
                placed[p] = true;
                sequence.push(p);
                for &j in &after[p] {
                    waiting[j] -= 1;
                }
            }
        }
        let mut taken: HashSet<i32> = HashSet::new();
        let mut on_track: Vec<Vec<usize>> = Vec::new();
        let mut rows: i32 = 0;
        for at in sequence {
            let k = list[at];
            let mut t: i32 = 0;
            if let Some(above_at) = above.get(at) {
                for &i in above_at {
                    if track[list[i]] >= t {
                        t = track[list[i]] + 1;
                    }
                }
            }
            if weighed {
                taken.clear();
                for &i in &clashes[at] {
                    taken.insert(track[list[i]]);
                }
                while taken.contains(&t) {
                    t += 1;
                }
            } else {
                while on_track.get(t as usize).is_some_and(|slot| slot.iter().any(|&other| clash(k, other))) {
                    t += 1;
                }
                let tu = t as usize;
                if on_track.len() <= tu {
                    on_track.resize_with(tu + 1, Vec::new);
                }
                on_track[tu].push(k);
            }
            track[k] = t;
            if t >= rows {
                rows = t + 1;
            }
        }
        let mut first = vec![rows; count];
        let mut last = vec![-1i32; count];
        for i in 0..count {
            let root = find(&mut group, i);
            first[root] = first[root].min(track[list[i]]);
            last[root] = last[root].max(track[list[i]]);
        }
        for i in 0..count {
            let root = find(&mut group, i);
            levels[list[i]] = last[root] - first[root] + 1;
            if curved {
                track[list[i]] -= first[root];
            }
        }
        rows
    };

    let sample = |k: usize, h: f64, out: &mut [f64; 2 * SAMPLES + 2]| {
        let c = ease(to[k] - from[k], h);
        for i in 0..=SAMPLES {
            let t = (i as f64) / (SAMPLES as f64);
            let u = 1.0 - t;
            out[2 * i] = from[k] + (to[k] - from[k]) * t * t * (3.0 - 2.0 * t);
            out[2 * i + 1] = h * (3.0 * c * t * u * u + 3.0 * (1.0 - c) * t * t * u + t * t * t);
        }
    };
    let reaches = |points: &[f64; 2 * SAMPLES + 2], line: &[f64; 2 * SAMPLES + 2], limit: f64| -> bool {
        let bound = limit * limit * (1.0 + 1e-9);
        for i in 0..=SAMPLES {
            let px = points[2 * i];
            let py = points[2 * i + 1];
            for j in 0..SAMPLES {
                let dx = line[2 * j + 2] - line[2 * j];
                let dy = line[2 * j + 3] - line[2 * j + 1];
                let denom = dx * dx + dy * dy;
                let denom = if denom == 0.0 { 1.0 } else { denom };
                let t = (((px - line[2 * j]) * dx + (py - line[2 * j + 1]) * dy) / denom).clamp(0.0, 1.0);
                let ex = px - line[2 * j] - t * dx;
                let ey = py - line[2 * j + 1] - t * dy;
                if ex * ex + ey * ey < bound && ex.hypot(ey) < limit {
                    return true;
                }
            }
        }
        false
    };
    let mut line_a = [0.0f64; 2 * SAMPLES + 2];
    let mut line_b = [0.0f64; 2 * SAMPLES + 2];

    for (r, mut all) in by_rank {
        if !curved {
            track_count[r] = lay(&mut all, &mut pieces.track, &mut pieces.levels);
            continue;
        }
        if all.len() > MAX_WEIGHED {
            continue;
        }
        let mut far: Vec<usize> = all.iter().copied().filter(|&k| wide[k] == 1).collect();
        lay(&mut far, &mut pieces.track, &mut pieces.levels);
        let mut level: HashSet<usize> = far.iter().copied().filter(|&k| pieces.levels[k] > 1).collect();
        let pairs = near_pairs(&all);
        for &(pi, pj) in &pairs {
            let a = all[pi];
            let b = all[pj];
            if (level.contains(&a) && level.contains(&b)) || !clash(a, b) || (from[a] < to[a]) != (from[b] < to[b]) {
                continue;
            }
            let limit = if wide[a] == 1 || wide[b] == 1 { LEVEL_CLEAR } else { LEVEL_TOUCH };
            let h = (room[r] / 2.0).max(room[r] - 2.0 * LEVEL_LEAD);
            sample(a, h, &mut line_a);
            sample(b, h, &mut line_b);
            if reaches(&line_a, &line_b, limit) || reaches(&line_b, &line_a, limit) {
                level.insert(a);
                level.insert(b);
            }
        }
        for &k in &far {
            pieces.track[k] = -1;
            pieces.levels[k] = 0;
        }
        if level.is_empty() {
            continue;
        }
        let mut crossing = 0usize;
        let mut alongside = 0usize;
        let mut beside: HashSet<usize> = HashSet::new();
        for &(pi, pj) in &pairs {
            let a = all[pi];
            let b = all[pj];
            let a_in = level.contains(&a);
            let b_in = level.contains(&b);
            if a_in && b_in {
                if !overlap(a, b) {
                    continue;
                }
                if (from[a] < to[a]) != (from[b] < to[b]) {
                    crossing += 1;
                } else if !mates(a, b) {
                    alongside += 1;
                }
            } else if (a_in || b_in) && meet(a, b) {
                beside.insert(a);
                beside.insert(b);
            }
        }
        if crossing > alongside {
            for &k in &all {
                let need = (hi[k] - lo[k]) * CROSSED_SLOPE;
                if need > tall[r] {
                    tall[r] = need;
                }
            }
            continue;
        }
        let mut members: Vec<usize> = all
            .iter()
            .copied()
            .filter(|&k| level.contains(&k) || (wide[k] != 1 && beside.contains(&k)))
            .collect();
        lay(&mut members, &mut pieces.track, &mut pieces.levels);
        let mut most = 0i32;
        for &k in &members {
            if pieces.levels[k] > most {
                most = pieces.levels[k];
            }
        }
        track_count[r] = most;
    }
}

fn straighten(g: &Graph<'_>, xs: &mut [f64], empty: &[bool], first_dummy: &[i32], span: &[usize], sep: f64, on_line: &mut [bool]) {
    let mut want = vec![0.0f64; xs.len()];
    let mut from = vec![0.0f64; xs.len()];
    let mut to = vec![0.0f64; xs.len()];
    for ei in 0..first_dummy.len() {
        let d0_signed = first_dummy[ei];
        if d0_signed < 0 {
            continue;
        }
        let d0 = d0_signed as usize;
        let end = d0 + span[ei] - 1;
        let base = g.rank[d0];
        let mut d = d0;
        while d < end {
            if !empty[base + d - d0] {
                d += 1;
                continue;
            }
            let mut last = d;
            while last + 1 < end && empty[base + last + 1 - d0] {
                last += 1;
            }
            let above = g.pred_e[g.pred_start[d]];
            let below = g.succ_e[g.succ_start[last]];
            let x0 = xs[g.ef[above]] + g.efd[above];
            let x1 = xs[g.et[below]] + g.etd[below];
            let steps = (last - d + 2) as f64;
            for k in d..=last {
                want[k] = x0 + ((x1 - x0) * ((k - d + 1) as f64)) / steps;
                from[k] = x0;
                to[k] = x1;
            }
            d = last + 1;
        }
    }

    let mut twins: Vec<usize> = Vec::new();
    for (r, &is_empty) in empty.iter().enumerate().take(g.max_rank).skip(1) {
        if !is_empty {
            continue;
        }
        let s = g.layer_start[r];
        let end = g.layer_start[r + 1];
        let mut row: Vec<usize> = g.order[s..end].to_vec();
        row.sort_by(|&a, &b| from[a].total_cmp(&from[b]).then_with(|| to[a].total_cmp(&to[b])).then_with(|| a.cmp(&b)));
        let mut i = 0;
        while i < row.len() {
            twins.clear();
            let mut j = i;
            while j < row.len() && (from[row[j]] - from[row[i]]).abs() < TWIN && (to[row[j]] - to[row[i]]).abs() < TWIN {
                twins.push(row[j]);
                j += 1;
            }
            twins.sort_by_key(|&a| g.pos[a]);
            let len = twins.len();
            for (k, &d) in twins.iter().enumerate() {
                xs[d] = want[d] + (k as f64 - ((len - 1) as f64) / 2.0) * sep;
                if len == 1 || sep == 0.0 {
                    on_line[d] = true;
                }
            }
            i = j;
        }
    }
}

fn past_labels(g: &Graph<'_>, xs: &mut [f64], first_dummy: &[i32], span: &[usize], clear: f64, on_line: &mut [bool]) {
    let mut labelled = vec![false; g.max_rank + 1];
    let mut any = false;
    for (r, slot) in labelled.iter_mut().enumerate().take(g.max_rank).skip(1) {
        let mut labels = false;
        let mut others = false;
        for i in g.layer_start[r]..g.layer_start[r + 1] {
            match g.kind[g.order[i]] {
                Kind::Label => labels = true,
                Kind::Dummy => {}
                Kind::Node | Kind::StartPort | Kind::EndPort => others = true,
            }
        }
        if labels && !others {
            *slot = true;
            any = true;
        }
    }
    if !any {
        return;
    }
    for ei in 0..first_dummy.len() {
        let d0_signed = first_dummy[ei];
        if d0_signed < 0 {
            continue;
        }
        let d0 = d0_signed as usize;
        let end = d0 + span[ei] - 1;
        for d in d0..end {
            if g.kind[d] != Kind::Dummy || !labelled[g.rank[d]] {
                continue;
            }
            let mut first = d;
            let mut last = d;
            while first > d0 && on_line[first - 1] {
                first -= 1;
            }
            while last + 1 < end && on_line[last + 1] {
                last += 1;
            }
            let above = g.pred_e[g.pred_start[first]];
            let below = g.succ_e[g.succ_start[last]];
            let from = xs[g.ef[above]] + g.efd[above];
            let to = xs[g.et[below]] + g.etd[below];
            let lo = from.min(to) - clear;
            let hi = from.max(to) + clear;
            let mut free = true;
            let r = g.rank[d];
            for i in g.layer_start[r]..g.layer_start[r + 1] {
                let label = g.order[i];
                if g.kind[label] == Kind::Label && xs[label] + g.w[label] / 2.0 > lo && xs[label] - g.w[label] / 2.0 < hi {
                    free = false;
                    break;
                }
            }
            if !free {
                continue;
            }
            on_line[d] = true;
            let steps = (last - first + 2) as f64;
            for (k, x_slot) in xs.iter_mut().enumerate().take(last + 1).skip(first) {
                *x_slot = from + ((to - from) * ((k - first + 1) as f64)) / steps;
            }
        }
    }
}

fn reduce_crossings(g: &mut Graph<'_>, nodes: &[LNode]) -> (usize, usize) {
    let n = g.n;
    let real = g.real;
    let max_rank = g.max_rank;
    let mut widest = 0usize;
    for r in 0..=max_rank {
        widest = widest.max(g.layer_start[r + 1] - g.layer_start[r]);
    }
    if widest < 2 {
        return (0, 0);
    }

    let seg_count = g.ef.len();
    let mut place = if g.offsets { Some(vec![0usize; seg_count]) } else { None };
    let mut place_in = vec![0usize; if place.is_some() { seg_count } else { 0 }];
    let mut places = vec![0usize; if place.is_some() { n } else { 0 }];
    let mut leaving = if place.is_some() { g.succ_e.clone() } else { Vec::new() };
    let mut mixed = vec![false; if place.is_some() { n } else { 0 }];
    if place.is_some() {
        let mut arriving = g.pred_e.clone();
        let by_offset = |list: &mut [usize], from: usize, to: usize, dx: &[f64]| -> bool {
            for k in (from + 1)..to {
                if dx[list[k]] == dx[list[from]] {
                    continue;
                }
                list[from..to].sort_by(|&a, &b| dx[a].total_cmp(&dx[b]));
                return true;
            }
            false
        };
        for v in 0..n {
            places[v] = 1;
            if by_offset(&mut arriving, g.pred_start[v], g.pred_start[v + 1], &g.etd) {
                for k in (g.pred_start[v] + 1)..g.pred_start[v + 1] {
                    if g.etd[arriving[k]] != g.etd[arriving[k - 1]] {
                        places[v] += 1;
                    }
                    place_in[arriving[k]] = places[v] - 1;
                }
            }
            if by_offset(&mut leaving, g.succ_start[v], g.succ_start[v + 1], &g.efd) {
                mixed[v] = true;
            }
        }
    }

    let mut size = 1usize;
    let limit = if place.is_some() { widest + seg_count } else { widest };
    while size < limit {
        size <<= 1;
    }
    let mut tree = vec![0usize; 2 * size];
    let mut targets = vec![0usize; seg_count];

    let count_crossings = |order: &[usize], pos: &[i32], place: &mut Option<Vec<usize>>, tree: &mut [usize], targets: &mut [usize]| -> usize {
        let mut total = 0usize;
        for r in 0..max_rank {
            let south_len = if let Some(pl) = place.as_mut() {
                let mut next = 0usize;
                for &v in &order[g.layer_start[r + 1]..g.layer_start[r + 2]] {
                    for &pe in &g.pred_e[g.pred_start[v]..g.pred_start[v + 1]] {
                        pl[pe] = next + place_in[pe];
                    }
                    next += places[v];
                }
                next
            } else {
                g.layer_start[r + 2] - g.layer_start[r + 1]
            };
            if south_len < 2 {
                continue;
            }
            let mut t = 0usize;
            for &v in &order[g.layer_start[r]..g.layer_start[r + 1]] {
                let from = g.succ_start[v];
                let to = g.succ_start[v + 1];
                let t0 = t;
                if let Some(pl) = place.as_ref() {
                    for &le in &leaving[from..to] {
                        targets[t] = pl[le];
                        t += 1;
                    }
                } else {
                    for &se in &g.succ_e[from..to] {
                        targets[t] = pos[g.et[se]] as usize;
                        t += 1;
                    }
                }
                let d = t - t0;
                if d < 2 {
                    continue;
                }
                if place.is_some() && mixed[v] {
                    for a in (t0 + 1)..t {
                        let item = targets[a];
                        let dx = g.efd[leaving[from + a - t0]];
                        let mut b = a;
                        while b > t0 && g.efd[leaving[from + b - 1 - t0]] == dx && targets[b - 1] > item {
                            targets[b] = targets[b - 1];
                            b -= 1;
                        }
                        targets[b] = item;
                    }
                } else if d <= 12 {
                    for a in (t0 + 1)..t {
                        let item = targets[a];
                        let mut b = a;
                        while b > t0 && targets[b - 1] > item {
                            targets[b] = targets[b - 1];
                            b -= 1;
                        }
                        targets[b] = item;
                    }
                } else {
                    targets[t0..t].sort_unstable();
                }
            }
            if t < 2 {
                continue;
            }
            let mut leaves = 1usize;
            while leaves < south_len {
                leaves <<= 1;
            }
            tree[..2 * leaves].fill(0);
            for &tgt in &targets[..t] {
                let mut i = tgt + leaves;
                tree[i] += 1;
                while i > 1 {
                    if (i & 1) == 0 {
                        total += tree[i + 1];
                    }
                    i >>= 1;
                    tree[i] += 1;
                }
            }
        }
        total
    };

    let declared = count_crossings(&g.order, &g.pos, &mut place, &mut tree, &mut targets);
    let mut bary = vec![0.0f64; n];
    let mut moving = vec![0usize; widest];
    let mut spare = vec![0usize; widest];

    let group_parent = g.group_parent;
    let groups_len = group_parent.map_or(0, <[i32]>::len);
    let mut depth = vec![0usize; groups_len];
    if let Some(gp) = group_parent {
        for (gr, depth_slot) in depth.iter_mut().enumerate().take(groups_len) {
            let mut p = gr as i32;
            while p >= 0 {
                *depth_slot += 1;
                p = gp[p as usize];
            }
        }
    }
    let mut group_sum = vec![0.0f64; groups_len];
    let mut group_count = vec![0usize; groups_len];
    let mut group_first = vec![0usize; groups_len];

    let arrange = |r: usize, key: &[f64], order: &mut [usize], pos: &mut [i32], group_sum: &mut [f64], group_count: &mut [usize], group_first: &mut [usize]| {
        let grp = g.grp.as_deref().unwrap();
        let gp = group_parent.unwrap();
        let s = g.layer_start[r];
        let e = g.layer_start[r + 1];
        for &v in &order[s..e] {
            let mut gr = grp[v];
            while gr >= 0 {
                let gru = gr as usize;
                group_sum[gru] = 0.0;
                group_count[gru] = 0;
                gr = gp[gru];
            }
        }
        for (idx, &v) in order[s..e].iter().enumerate() {
            let i = s + idx;
            let mut gr = grp[v];
            while gr >= 0 {
                let gru = gr as usize;
                if group_count[gru] == 0 {
                    group_first[gru] = i;
                }
                group_sum[gru] += key[v];
                group_count[gru] += 1;
                gr = gp[gru];
            }
        }
        let value = |item: usize| -> f64 {
            if item >= n {
                group_sum[item - n] / (group_count[item - n] as f64)
            } else {
                key[item]
            }
        };
        let first = |item: usize| -> usize { if item >= n { group_first[item - n] } else { s + pos[item] as usize } };
        let mut row: Vec<usize> = order[s..e].to_vec();
        row.sort_by(|&a, &b| {
            let mut ia = a;
            let mut ib = b;
            let mut ca = grp[a];
            let mut cb = grp[b];
            let mut da = if ca < 0 { 0 } else { depth[ca as usize] };
            let mut db = if cb < 0 { 0 } else { depth[cb as usize] };
            while da > db {
                ia = n + ca as usize;
                ca = gp[ca as usize];
                da -= 1;
            }
            while db > da {
                ib = n + cb as usize;
                cb = gp[cb as usize];
                db -= 1;
            }
            while ca != cb {
                ia = n + ca as usize;
                ca = gp[ca as usize];
                ib = n + cb as usize;
                cb = gp[cb as usize];
            }
            value(ia).total_cmp(&value(ib)).then_with(|| first(ia).cmp(&first(ib)))
        });
        order[s..e].copy_from_slice(&row);
        for i in s..e {
            pos[order[i]] = (i - s) as i32;
        }
    };

    if g.grp.is_some() {
        let mut at = vec![0.0f64; n];
        for r in 0..=max_rank {
            let s = g.layer_start[r];
            for i in s..g.layer_start[r + 1] {
                at[g.order[i]] = (i - s) as f64;
            }
            arrange(r, &at, &mut g.order, &mut g.pos, &mut group_sum, &mut group_count, &mut group_first);
        }
    }
    let mut best = if g.grp.is_some() {
        count_crossings(&g.order, &g.pos, &mut place, &mut tree, &mut targets)
    } else {
        declared
    };
    if best == 0 {
        return (0, declared);
    }
    let mut best_order = g.order.clone();
    let start_bound = best.min(declared);

    let out_of_order = |order: &[usize]| -> usize {
        let mut total = 0usize;
        for r in 0..=max_rank {
            let s = g.layer_start[r];
            let e = g.layer_start[r + 1];
            for i in s..e {
                if order[i] >= real {
                    continue;
                }
                for j in (i + 1)..e {
                    if order[j] < order[i] {
                        total += 1;
                    }
                }
            }
        }
        total
    };

    let pin_of = |v: usize| -> i32 { if v < real { nodes[v].pin } else { 0 } };
    let at_pos = |pos: &[i32], e: usize, up: bool| -> f64 {
        let u = if up { g.ef[e] } else { g.et[e] };
        if g.offsets && g.w[u] > 0.0 {
            let dx = if up { g.efd[e] } else { g.etd[e] };
            pos[u] as f64 + dx / g.w[u]
        } else {
            pos[u] as f64
        }
    };
    let between_pair = |pos: &[i32], a: usize, b: usize| -> usize {
        let mut c = 0usize;
        for &pa in &g.pred_e[g.pred_start[a]..g.pred_start[a + 1]] {
            let x = at_pos(pos, pa, true);
            for &pb in &g.pred_e[g.pred_start[b]..g.pred_start[b + 1]] {
                if x > at_pos(pos, pb, true) {
                    c += 1;
                }
            }
        }
        for &sa in &g.succ_e[g.succ_start[a]..g.succ_start[a + 1]] {
            let x = at_pos(pos, sa, false);
            for &sb in &g.succ_e[g.succ_start[b]..g.succ_start[b + 1]] {
                if x > at_pos(pos, sb, false) {
                    c += 1;
                }
            }
        }
        c
    };

    let settle_positions = |pos: &mut [i32], order: &[usize]| {
        for r in 0..=max_rank {
            let s = g.layer_start[r];
            for i in s..g.layer_start[r + 1] {
                pos[order[i]] = (i - s) as i32;
            }
        }
    };

    let initial = g.order.clone();
    let small = n <= 600;
    let mut chosen = best_order.clone();
    let mut chosen_out = usize::MAX;
    let attempts = if small { 2 } else { 1 };
    for attempt in 0..attempts {
        if attempt > 0 {
            g.order.copy_from_slice(&initial);
            settle_positions(&mut g.pos, &g.order);
        }
        let mut found = start_bound;
        let mut found_order = initial.clone();
        let mut stale = 0usize;
        for i in 0..MAX_SWEEPS {
            if stale >= 4 {
                break;
            }
            stale += 1;
            let down = (i + attempt).is_multiple_of(2);
            let bias_right = (i % 4) >= 2;
            let (start_adj, list_adj, other_adj, other_dx) = if down {
                (&g.pred_start, &g.pred_e, &g.ef, &g.efd)
            } else {
                (&g.succ_start, &g.succ_e, &g.et, &g.etd)
            };
            for step in 1..=max_rank {
                let r = if down { step } else { max_rank - step };
                if g.fixed[r] {
                    continue;
                }
                let s = g.layer_start[r];
                let e = g.layer_start[r + 1];
                let mut movable = 0usize;
                for idx in s..e {
                    let v = g.order[idx];
                    let pin = pin_of(v);
                    if pin != 0 {
                        bary[v] = (pin as f64) * 1e9;
                        moving[movable] = v;
                        movable += 1;
                        continue;
                    }
                    let from = start_adj[v];
                    let to = start_adj[v + 1];
                    if from == to {
                        if g.grp.is_some() {
                            let across = if down {
                                g.layer_start[r] - g.layer_start[r - 1]
                            } else {
                                g.layer_start[r + 2] - g.layer_start[r + 1]
                            };
                            bary[v] = ((idx - s) * across) as f64 / ((e - s) as f64);
                            continue;
                        }
                        bary[v] = -1.0;
                        continue;
                    }
                    let mut sum = 0.0f64;
                    for &edge_idx in &list_adj[from..to] {
                        let u = other_adj[edge_idx];
                        sum += g.pos[u] as f64;
                        if g.offsets && g.w[u] > 0.0 {
                            sum += other_dx[edge_idx] / g.w[u];
                        }
                    }
                    bary[v] = sum / ((to - from) as f64);
                    moving[movable] = v;
                    movable += 1;
                }
                if g.grp.is_some() {
                    arrange(r, &bary, &mut g.order, &mut g.pos, &mut group_sum, &mut group_count, &mut group_first);
                    continue;
                }
                if movable < 2 {
                    continue;
                }
                sort_by_bary(&mut moving, movable, &bary, &g.pos, bias_right, &mut spare);
                let mut k = 0usize;
                for slot in &mut g.order[s..e] {
                    if bary[*slot] != -1.0 {
                        *slot = moving[k];
                        k += 1;
                    }
                }
                for idx in s..e {
                    g.pos[g.order[idx]] = (idx - s) as i32;
                }
            }
            let c = count_crossings(&g.order, &g.pos, &mut place, &mut tree, &mut targets);
            if c < found {
                found = c;
                found_order.copy_from_slice(&g.order);
                stale = 0;
                if c == 0 {
                    break;
                }
            }
        }
        g.order.copy_from_slice(&found_order);
        if small && found > 0 {
            settle_positions(&mut g.pos, &g.order);
            for _pass in 0..8 {
                let mut improved = false;
                for r in 0..=max_rank {
                    if g.fixed[r] {
                        continue;
                    }
                    let s = g.layer_start[r];
                    let e = g.layer_start[r + 1];
                    if e < s + 2 {
                        continue;
                    }
                    for i in s..(e - 1) {
                        let a = g.order[i];
                        let b = g.order[i + 1];
                        if pin_of(a) != pin_of(b) || g.grp.as_ref().is_some_and(|gr| gr[a] != gr[b]) {
                            continue;
                        }
                        if between_pair(&g.pos, b, a) >= between_pair(&g.pos, a, b) {
                            continue;
                        }
                        g.order[i] = b;
                        g.order[i + 1] = a;
                        g.pos[b] = (i - s) as i32;
                        g.pos[a] = (i + 1 - s) as i32;
                        improved = true;
                    }
                }
                if !improved {
                    break;
                }
            }
            let c = count_crossings(&g.order, &g.pos, &mut place, &mut tree, &mut targets);
            if c < found {
                found = c;
                found_order.copy_from_slice(&g.order);
            }
        }
        let out = if small { out_of_order(&g.order) } else { 0 };
        if attempt == 0 || found < best || (found == best && out < chosen_out) {
            best = found;
            chosen = found_order;
            chosen_out = out;
        }
    }

    g.order.copy_from_slice(&chosen);
    settle_positions(&mut g.pos, &g.order);
    best_order.copy_from_slice(&chosen);
    if g.grp.is_some() {
        best = count_crossings(&g.order, &g.pos, &mut place, &mut tree, &mut targets);
    }

    if !small {
        return (best, declared);
    }
    if nodes.iter().any(|nd| nd.pin != 0) {
        return (best, declared);
    }
    if chosen_out == 0 || g.fixed[0] || g.fixed[max_rank] {
        return (best, declared);
    }
    for r in 0..=max_rank {
        g.order[g.layer_start[r]..g.layer_start[r + 1]].reverse();
    }
    settle_positions(&mut g.pos, &g.order);
    let mirror_c = count_crossings(&g.order, &g.pos, &mut place, &mut tree, &mut targets);
    if mirror_c > best || out_of_order(&g.order) >= chosen_out {
        g.order.copy_from_slice(&best_order);
    }
    (best, declared)
}

fn half_room(g: &Graph<'_>, opt: &LayeredOptions, v: usize) -> f64 {
    let sep = if g.kind[v] == Kind::Node { opt.node_sep } else { opt.edge_sep };
    g.w[v] / 2.0 + sep / 2.0
}

fn position(g: &mut Graph<'_>, opt: &LayeredOptions) -> Vec<f64> {
    let n = g.n;
    let max_rank = g.max_rank;
    let segments = g.ef.len();
    let gap: Vec<f64> = (0..n).map(|i| half_room(g, opt, i)).collect();

    let mut key = vec![0i32; segments];
    for (e, slot) in key.iter_mut().enumerate().take(segments) {
        *slot = g.pos[g.et[e]];
    }
    for v in 0..n {
        if g.succ_start[v + 1] - g.succ_start[v] > 1 {
            sort_range_i32(&mut g.succ_e, g.succ_start[v], g.succ_start[v + 1], &key);
        }
    }
    for (e, slot) in key.iter_mut().enumerate().take(segments) {
        *slot = g.pos[g.ef[e]];
    }
    for v in 0..n {
        if g.pred_start[v + 1] - g.pred_start[v] > 1 {
            sort_range_i32(&mut g.pred_e, g.pred_start[v], g.pred_start[v + 1], &key);
        }
    }

    let mut conflict = vec![false; segments];
    for r in 1..=max_rank {
        let prev_len = (g.layer_start[r] - g.layer_start[r - 1]) as i32;
        let s = g.layer_start[r];
        let end = g.layer_start[r + 1];
        let mut k0: i32 = 0;
        let mut scan = s;
        for i in s..end {
            let v = g.order[i];
            let mut inner: Option<usize> = None;
            if g.kind[v].is_dummy() {
                let u = g.ef[g.pred_e[g.pred_start[v]]];
                if g.kind[u].is_dummy() {
                    inner = Some(u);
                }
            }
            let k1 = inner.map_or(prev_len, |u| g.pos[u]);
            if inner.is_some() || i + 1 == end {
                for j in scan..=i {
                    let w = g.order[j];
                    let w_dummy = g.kind[w].is_dummy();
                    for &e in &g.pred_e[g.pred_start[w]..g.pred_start[w + 1]] {
                        let up = g.pos[g.ef[e]];
                        if (up < k0 || k1 < up) && !(w_dummy && g.kind[g.ef[e]].is_dummy()) {
                            conflict[e] = true;
                        }
                    }
                }
                scan = i + 1;
                k0 = k1;
            }
        }
    }

    let mut results: Vec<Vec<f64>> = Vec::with_capacity(4);
    let mut root = vec![0usize; n];
    let mut align = vec![0usize; n];
    let mut shift = vec![0.0f64; n];
    let mut e_from = vec![0usize; n];
    let mut e_to = vec![0usize; n];
    let mut e_w = vec![0.0f64; n];
    let mut indeg = vec![0usize; n];
    let mut out_start = vec![0usize; n + 1];
    let mut out_e = vec![0usize; n];
    let mut fill = vec![0usize; n];
    let mut topo = vec![0usize; n];
    let mut x = vec![0.0f64; n];

    for variant in 0..4usize {
        let up = variant < 2;
        let right = (variant & 1) == 1;
        let (start_adj, list_adj, other_adj, own_dx, other_dx) = if up {
            (&g.pred_start, &g.pred_e, &g.ef, &g.etd, &g.efd)
        } else {
            (&g.succ_start, &g.succ_e, &g.et, &g.efd, &g.etd)
        };
        for i in 0..n {
            root[i] = i;
            align[i] = i;
            shift[i] = 0.0;
            indeg[i] = 0;
            out_start[i + 1] = 0;
            x[i] = 0.0;
        }
        out_start[0] = 0;

        for step in 0..=max_rank {
            let r = if up { step } else { max_rank - step };
            let s = g.layer_start[r];
            let end = g.layer_start[r + 1];
            let adjacent_last: i32 = if up {
                if r > 0 { (g.layer_start[r] - g.layer_start[r - 1]) as i32 - 1 } else { 0 }
            } else if r < max_rank {
                (g.layer_start[r + 2] - g.layer_start[r + 1]) as i32 - 1
            } else {
                0
            };
            let mut prev_idx: i32 = -1;
            let len = end - s;
            for offset in 0..len {
                let i = if right { end - 1 - offset } else { s + offset };
                let v = g.order[i];
                let from = start_adj[v];
                let d = start_adj[v + 1] - from;
                if d == 0 {
                    continue;
                }
                let lo = from + ((d - 1) >> 1);
                let hi = from + (d >> 1);
                for pass in 0..2 {
                    if pass == 1 && lo == hi {
                        break;
                    }
                    let e = list_adj[if (pass == 0) != right { lo } else { hi }];
                    let w = other_adj[e];
                    let idx = if right { adjacent_last - g.pos[w] } else { g.pos[w] };
                    if align[v] == v && prev_idx < idx && !conflict[e] {
                        align[w] = v;
                        root[v] = root[w];
                        align[v] = root[w];
                        shift[v] = shift[w] + other_dx[e] - own_dx[e];
                        prev_idx = idx;
                    }
                }
            }
        }

        let mut block_edges = 0usize;
        for r in 0..=max_rank {
            let s = g.layer_start[r];
            let end = g.layer_start[r + 1];
            for i in (s + 1)..end {
                let (a, b) = if right { (g.order[i], g.order[i - 1]) } else { (g.order[i - 1], g.order[i]) };
                let sep = gap[a] + gap[b];
                e_from[block_edges] = root[a];
                e_to[block_edges] = root[b];
                e_w[block_edges] = if right { sep - shift[a] + shift[b] } else { sep + shift[a] - shift[b] };
                indeg[root[b]] += 1;
                out_start[root[a] + 1] += 1;
                block_edges += 1;
            }
        }
        for i in 0..n {
            out_start[i + 1] += out_start[i];
        }
        fill[..n].copy_from_slice(&out_start[..n]);
        for (e, &u) in e_from.iter().enumerate().take(block_edges) {
            out_e[fill[u]] = e;
            fill[u] += 1;
        }

        let mut count = 0usize;
        for i in 0..n {
            if root[i] == i && indeg[i] == 0 {
                topo[count] = i;
                count += 1;
            }
        }
        let mut q = 0usize;
        while q < count {
            let v = topo[q];
            q += 1;
            for &e in &out_e[out_start[v]..out_start[v + 1]] {
                let w = e_to[e];
                if x[v] + e_w[e] > x[w] {
                    x[w] = x[v] + e_w[e];
                }
                indeg[w] -= 1;
                if indeg[w] == 0 {
                    topo[count] = w;
                    count += 1;
                }
            }
        }
        for q in (0..count).rev() {
            let v = topo[q];
            let mut min_x = f64::INFINITY;
            for &e in &out_e[out_start[v]..out_start[v + 1]] {
                let cand = x[e_to[e]] - e_w[e];
                if cand < min_x {
                    min_x = cand;
                }
            }
            if min_x.is_finite() && min_x > x[v] {
                x[v] = min_x;
            }
        }
        let mut xs = vec![0.0f64; n];
        for i in 0..n {
            xs[i] = (if right { -x[root[i]] } else { x[root[i]] }) + shift[i];
        }
        results.push(xs);
    }

    let mut narrowest = 0usize;
    let mut best_width = f64::INFINITY;
    let mut mins = [0.0f64; 4];
    let mut maxs = [0.0f64; 4];
    for k in 0..4 {
        let mut lo = f64::INFINITY;
        let mut hi = f64::NEG_INFINITY;
        for (i, &val) in results[k].iter().enumerate().take(n) {
            let half = g.w[i] / 2.0;
            if val - half < lo {
                lo = val - half;
            }
            if val + half > hi {
                hi = val + half;
            }
        }
        mins[k] = lo;
        maxs[k] = hi;
        if hi - lo < best_width {
            best_width = hi - lo;
            narrowest = k;
        }
    }
    for k in 0..4 {
        let delta = if (k & 1) == 0 { mins[narrowest] - mins[k] } else { maxs[narrowest] - maxs[k] };
        if delta != 0.0 {
            for val in &mut results[k] {
                *val += delta;
            }
        }
    }

    let mut out = vec![0.0f64; n];
    for i in 0..n {
        let mut a = results[0][i];
        let mut b = results[1][i];
        let mut c = results[2][i];
        let mut d = results[3][i];
        if a > b {
            std::mem::swap(&mut a, &mut b);
        }
        if c > d {
            std::mem::swap(&mut c, &mut d);
        }
        if a > c {
            std::mem::swap(&mut a, &mut c);
        }
        if b > d {
            std::mem::swap(&mut b, &mut d);
        }
        if b > c {
            std::mem::swap(&mut b, &mut c);
        }
        out[i] = (b + c) / 2.0;
    }
    out
}
