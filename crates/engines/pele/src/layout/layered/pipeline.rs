use std::collections::HashSet;

use super::crossing::reduce_crossings;
use super::ports::{align_labels, align_ports, free_ends, settle, snap, spread};
use super::position::position;
use super::ranking::{orient, rank};
use super::routing::{assign_tracks, past_labels, straighten};
use super::types::{End, Graph, Kind, LEdge, LNode, LayeredOptions, LayeredResult, Pieces, empty_ranks, set_positions};

const MAX_DUMMIES: usize = 20_000;
const MIN_SLOPE: f64 = 0.125;
const MAX_GAP: f64 = 3.0;
const TRACK_MARGIN: f64 = 18.0;
const TRACK_PITCH: f64 = 10.0;
const TRACK_SPREAD: f64 = 14.0;
const LEVEL_WIDE: f64 = 2.0;
const LEVEL_MARGIN: f64 = 28.0;
const LEVEL_PITCH: f64 = 12.0;

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
