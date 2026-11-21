// Layout for swimlanes. Every top-level group is a lane: a band that runs the length of the
// diagram along the flow. Ranks are shared by all lanes, so a step sits level with the steps
// that happen at the same time in other lanes, and each node stays inside its own lane.

use std::collections::HashSet;

use super::compound::{CEdge, CNode, CompoundResult, Dir};
use super::layered::{Kind, LEdge, LNode, LayeredOptions, ledge, lnode, orient, rank};

const LANE_HEAD: f64 = 34.0;
const LANE_PAD: f64 = 24.0;
const SWEEPS: usize = 8;
const MAX_DUMMIES: usize = 20_000;
const MAX_HOPS: usize = 10_000;
const ROUTE_BUDGET: usize = 2_000_000;
// Parallel lines closer than this are drawn as one.
const NEAR: f64 = 4.0;
const ROUNDS: usize = 3;
const RELAY: usize = 8;
const TURN: f64 = 20.0;
// The room a lane keeps beside a handoff along its margin, and how much of it is between the
// handoff and the lane's items.
const MARGIN: f64 = 20.0;
const LEG: f64 = 14.0;
const CLOSE: f64 = 3.0;

#[inline]
fn js_sign(v: f64) -> f64 {
    if v > 0.0 {
        1.0
    } else if v < 0.0 {
        -1.0
    } else {
        0.0
    }
}

#[inline]
fn js_round(v: f64) -> isize {
    (v + 0.5).floor() as isize
}

struct PlaceResult {
    width: f64,
    height: f64,
    routed: Vec<bool>,
    margins: Vec<bool>,
    work: usize,
}

pub fn lane_layout(nodes: &mut [CNode], edges: &mut [CEdge], dir: Dir, opt: &LayeredOptions, lane_pad: Option<f64>) -> CompoundResult {
    let n = nodes.len();
    if n == 0 {
        return CompoundResult { width: 0.0, height: 0.0 };
    }
    let lane_pad = lane_pad.unwrap_or(LANE_PAD);
    let sideways = dir == Dir::LR || dir == Dir::RL;
    let flipped = dir == Dir::BT || dir == Dir::RL;

    // Lanes in the order they were written. The graph lists groups last-declared first.
    let mut lanes: Vec<usize> = Vec::new();
    for i in (0..n).rev() {
        if nodes[i].parent < 0 && nodes[i].is_group {
            lanes.push(i);
        }
    }
    let lane_count = lanes.len().max(1);
    let mut lane_slot: Vec<i32> = vec![-1; n];
    for (k, &id) in lanes.iter().enumerate() {
        lane_slot[id] = k as i32;
    }
    let mut has_child: Vec<bool> = vec![false; n];
    for c in nodes.iter() {
        if c.parent >= 0 {
            has_child[c.parent as usize] = true;
        }
    }

    // Room a lane keeps around its items, so that the groups drawn around them stay inside it.
    let mut lane_pads: Vec<f64> = vec![lane_pad; lane_count];
    let mut end_pad = lane_pad;
    let mut lane_of = |i: usize| -> usize {
        let mut t = i;
        let mut room = lane_pad;
        let mut hops = 0usize;
        while nodes[t].parent >= 0 && hops < MAX_HOPS {
            t = nodes[t].parent as usize;
            if lane_slot[t] < 0 {
                room += nodes[t].pad_x.max(nodes[t].pad_top).max(nodes[t].pad_bottom);
            }
            hops += 1;
        }
        let lane = lane_slot[t].max(0) as usize;
        if room > lane_pads[lane] {
            lane_pads[lane] = room;
        }
        if room > end_pad {
            end_pad = room;
        }
        lane
    };

    // What gets ranked and placed: nodes, and groups that are empty and so act as nodes.
    let mut item_of: Vec<i32> = vec![-1; n];
    let mut real: Vec<usize> = Vec::new();
    for i in 0..n {
        if lane_slot[i] >= 0 {
            continue;
        }
        if !nodes[i].is_group || !has_child[i] {
            item_of[i] = real.len() as i32;
            real.push(i);
        }
    }
    let along = |c: &CNode| -> f64 { if sideways { c.w } else { c.h } };
    let cross = |c: &CNode| -> f64 { if sideways { c.h } else { c.w } };

    let mut lnodes: Vec<LNode> = real.iter().map(|&i| lnode(cross(&nodes[i]), along(&nodes[i]), Kind::Node)).collect();
    let mut ledges: Vec<LEdge> = Vec::new();
    let mut edge_of: Vec<usize> = Vec::new();
    let mut step = 1i32;
    {
        let mut seen: HashSet<(usize, usize)> = HashSet::new();
        for (ei, e) in edges.iter().enumerate() {
            let a = item_of[e.src];
            let b = item_of[e.dst];
            if a < 0 || b < 0 || a == b {
                continue;
            }
            let au = a as usize;
            let bu = b as usize;
            let key = (au.min(bu), au.max(bu));
            if e.label_w > 0.0 || seen.contains(&key) {
                step = 2;
            }
            seen.insert(key);
            ledges.push(ledge(
                au,
                bu,
                e.minlen,
                if sideways { e.label_h } else { e.label_w },
                if sideways { e.label_w } else { e.label_h },
            ));
            edge_of.push(ei);
        }
    }
    orient(&lnodes, &mut ledges);
    rank(&mut lnodes, &ledges, step);

    let m = ledges.len();
    let item_lane: Vec<usize> = real.iter().map(|&i| lane_of(i)).collect();

    let mut place = |plain: &[bool], margins: &[bool]| -> PlaceResult {
        let pad: Vec<f64> = lane_pads
            .iter()
            .enumerate()
            .map(|(lane, &room)| if margins[lane] { room.max(MARGIN) } else { room })
            .collect();
        let mut used: Vec<bool> = vec![false; lane_count];

        // Items: the real ones, then a dummy for every rank an edge passes through.
        let mut dummies = 0usize;
        let mut span: Vec<usize> = vec![0; m];
        for k in 0..m {
            span[k] = lnodes[ledges[k].head].rank.abs_diff(lnodes[ledges[k].tail].rank);
            if !plain[k] {
                dummies += span[k].saturating_sub(1);
            }
        }
        let direct = dummies > MAX_DUMMIES;
        let total = real.len() + if direct { 0 } else { dummies };
        let mut item_rank: Vec<usize> = vec![0; total];
        let mut lane_of_item: Vec<usize> = vec![0; total];
        let mut size: Vec<f64> = vec![0.0; total];
        let mut depth: Vec<f64> = vec![0.0; total];
        let mut dummy: Vec<bool> = vec![false; total];
        let mut max_rank = 0usize;
        for k in 0..real.len() {
            item_rank[k] = lnodes[k].rank;
            lane_of_item[k] = item_lane[k];
            size[k] = lnodes[k].w;
            depth[k] = lnodes[k].h;
            if item_rank[k] > max_rank {
                max_rank = item_rank[k];
            }
        }

        let mut first_dummy: Vec<i32> = vec![-1; m];
        let mut label_item: Vec<i32> = vec![-1; m];
        let mut links: Vec<usize> = Vec::new();
        {
            let mut next = real.len();
            for k in 0..m {
                let e = &ledges[k];
                let a = if e.reversed { e.head } else { e.tail };
                let b = if e.reversed { e.tail } else { e.head };
                if direct || span[k] < 2 || plain[k] {
                    links.push(a);
                    links.push(b);
                    continue;
                }
                let ra = item_rank[a];
                let rb = item_rank[b];
                let mut label_rank: isize = -1;
                if e.label_w > 0.0 {
                    label_rank = (ra + ((rb - ra) >> 1)) as isize;
                    if step == 2 && (label_rank & 1) == 0 {
                        label_rank -= 1;
                    }
                }
                first_dummy[k] = next as i32;
                let mut prev = a;
                let la_isize = lane_of_item[a] as isize;
                let lb_isize = lane_of_item[b] as isize;
                for r in (ra + 1)..rb {
                    let d = next;
                    next += 1;
                    item_rank[d] = r;
                    // The edge crosses from its first lane to its last one evenly along the way.
                    let interp = ((lb_isize - la_isize) as f64 * (r - ra) as f64) / (rb - ra) as f64;
                    lane_of_item[d] = (la_isize + js_round(interp)).clamp(0, (lane_count - 1) as isize) as usize;
                    dummy[d] = true;
                    if r as isize == label_rank {
                        size[d] = e.label_w;
                        depth[d] = e.label_h;
                        label_item[k] = d as i32;
                    }
                    links.push(prev);
                    links.push(d);
                    prev = d;
                }
                links.push(prev);
                links.push(b);
            }
        }

        let mut up_start: Vec<usize> = vec![0; total + 1];
        let mut down_start: Vec<usize> = vec![0; total + 1];
        for pair in links.as_chunks::<2>().0 {
            down_start[pair[0] + 1] += 1;
            up_start[pair[1] + 1] += 1;
        }
        for i in 0..total {
            up_start[i + 1] += up_start[i];
            down_start[i + 1] += down_start[i];
        }
        let mut up: Vec<usize> = vec![0; links.len() / 2];
        let mut down: Vec<usize> = vec![0; links.len() / 2];
        {
            let mut uf = up_start[..total].to_vec();
            let mut df = down_start[..total].to_vec();
            for pair in links.as_chunks::<2>().0 {
                down[df[pair[0]]] = pair[1];
                df[pair[0]] += 1;
                up[uf[pair[1]]] = pair[0];
                uf[pair[1]] += 1;
            }
        }

        // Order within each rank: by lane first, then by where the item's neighbours sit.
        let mut rows: Vec<Vec<usize>> = (0..=max_rank).map(|_| Vec::new()).collect();
        for (i, &r) in item_rank.iter().enumerate() {
            rows[r].push(i);
        }
        let mut pos: Vec<f64> = vec![0.0; total];
        let mut key: Vec<f64> = vec![0.0; total];
        let settle = |row: &mut [usize], pos: &mut [f64], key: &[f64]| {
            row.sort_by(|&a, &b| {
                lane_of_item[a]
                    .cmp(&lane_of_item[b])
                    .then_with(|| key[a].total_cmp(&key[b]))
                    .then_with(|| a.cmp(&b))
            });
            for (k, &item) in row.iter().enumerate() {
                pos[item] = k as f64;
            }
        };
        for row in &mut rows {
            for (k, &item) in row.iter().enumerate() {
                key[item] = k as f64;
            }
            settle(row, &mut pos, &key);
        }
        for sweep in 0..SWEEPS {
            if max_rank == 0 {
                break;
            }
            let downward = (sweep & 1) == 0;
            for s in 1..=max_rank {
                let row_idx = if downward { s } else { max_rank - s };
                let row = &mut rows[row_idx];
                let (start, list) = if downward { (&up_start, &up) } else { (&down_start, &down) };
                for &i in row.iter() {
                    let mut sum = 0.0;
                    let count = start[i + 1] - start[i];
                    for &nbr in &list[start[i]..start[i + 1]] {
                        sum += pos[nbr];
                    }
                    key[i] = if count > 0 { sum / count as f64 } else { pos[i] };
                }
                settle(row, &mut pos, &key);
            }
        }

        // The items of one rank that share a lane sit side by side as a run.
        let gap = |a: usize, b: usize| -> f64 { if dummy[a] || dummy[b] { opt.edge_sep } else { opt.node_sep } };
        let run_size = |row: &[usize], from: usize, to: usize| -> f64 {
            let mut s = size[row[from]];
            for k in from..to {
                s += gap(row[k], row[k + 1]) + size[row[k + 1]];
            }
            s
        };

        // Lane breadth: enough for its fullest rank, and for its title.
        let mut breadth: Vec<f64> = vec![0.0; lane_count];
        let mut head = if !lanes.is_empty() { LANE_HEAD } else { 0.0 };
        for (k, &lane_idx) in lanes.iter().enumerate() {
            let lane = &nodes[lane_idx];
            breadth[k] = (lane.min_w - 2.0 * pad[k]).max(0.0);
            if lane.pad_top > head {
                head = lane.pad_top;
            }
        }
        for row in &rows {
            let mut from = 0;
            while from < row.len() {
                let mut to = from;
                while to + 1 < row.len() && lane_of_item[row[to + 1]] == lane_of_item[row[from]] {
                    to += 1;
                }
                let s = run_size(row, from, to);
                let l = lane_of_item[row[from]];
                if s > breadth[l] {
                    breadth[l] = s;
                }
                from = to + 1;
            }
        }
        let mut lane_start: Vec<f64> = vec![0.0; lane_count + 1];
        for k in 0..lane_count {
            lane_start[k + 1] = lane_start[k] + breadth[k] + 2.0 * pad[k];
        }

        // Across the flow: each lane's items start centered, then line up with their neighbours in
        // the same lane as far as the lane and the items beside them allow.
        let mut coord: Vec<f64> = vec![0.0; total];
        let mut want: Vec<f64> = vec![0.0; total];
        for row in &rows {
            let mut from = 0;
            while from < row.len() {
                let mut to = from;
                while to + 1 < row.len() && lane_of_item[row[to + 1]] == lane_of_item[row[from]] {
                    to += 1;
                }
                let lane = lane_of_item[row[from]];
                let mut at = (lane_start[lane] + pad[lane] + (lane_start[lane + 1] - pad[lane]) - run_size(row, from, to)) / 2.0;
                for k in from..=to {
                    coord[row[k]] = at + size[row[k]] / 2.0;
                    if k < to {
                        at += size[row[k]] + gap(row[k], row[k + 1]);
                    }
                }
                from = to + 1;
            }
        }
        for pass in 0..4 {
            if max_rank == 0 {
                break;
            }
            let downward = (pass & 1) == 0;
            for s in 1..=max_rank {
                let row = &rows[if downward { s } else { max_rank - s }];
                let (start, list) = if downward { (&up_start, &up) } else { (&down_start, &down) };
                for &i in row {
                    let mut sum = 0.0;
                    let mut count = 0usize;
                    for &nbr in &list[start[i]..start[i + 1]] {
                        if lane_of_item[nbr] != lane_of_item[i] {
                            continue;
                        }
                        sum += coord[nbr];
                        count += 1;
                    }
                    want[i] = if count > 0 { sum / count as f64 } else { coord[i] };
                }
                let mut from = 0;
                while from < row.len() {
                    let mut to = from;
                    while to + 1 < row.len() && lane_of_item[row[to + 1]] == lane_of_item[row[from]] {
                        to += 1;
                    }
                    let lane = lane_of_item[row[from]];
                    let mut floor = lane_start[lane] + pad[lane];
                    for k in from..=to {
                        let i = row[k];
                        coord[i] = want[i].max(floor + size[i] / 2.0);
                        if k < to {
                            floor = coord[i] + size[i] / 2.0 + gap(i, row[k + 1]);
                        }
                    }
                    let mut ceil = lane_start[lane + 1] - pad[lane];
                    for k in (from..=to).rev() {
                        let i = row[k];
                        coord[i] = coord[i].min(ceil - size[i] / 2.0);
                        if k > from {
                            ceil = coord[i] - size[i] / 2.0 - gap(row[k - 1], i);
                        }
                    }
                    from = to + 1;
                }
            }
        }

        // Along the flow: one band per rank, after the lane titles.
        let mut band_start: Vec<f64> = vec![0.0; max_rank + 1];
        let mut band_end: Vec<f64> = vec![0.0; max_rank + 1];
        let mut sep: Vec<f64> = vec![opt.rank_sep / step as f64; max_rank + 1];
        if plain.iter().any(|&on| on) {
            let full = opt.rank_sep / step as f64;
            sep.fill(full / CLOSE);
            for k in 0..m {
                let e = &ledges[k];
                let a = if e.reversed { e.head } else { e.tail };
                let b = if e.reversed { e.tail } else { e.head };
                if plain[k] {
                    if e.label_h <= 0.0 || span[k] > step as usize {
                        continue;
                    }
                    let room = full.min((e.label_h + 2.0 * TURN - depth[a].min(depth[b]) / 2.0) / span[k] as f64);
                    for s_val in &mut sep[item_rank[a]..item_rank[b]] {
                        if room > *s_val {
                            *s_val = room;
                        }
                    }
                    continue;
                }
                let d0 = first_dummy[k];
                if d0 < 0 || span[k] <= (step * e.minlen).max(0) as usize {
                    for s_val in &mut sep[item_rank[a]..item_rank[b]] {
                        *s_val = full;
                    }
                    continue;
                }
                let d0u = d0 as usize;
                let end_d = d0u + span[k] - 1;
                for d_idx in 0..span[k] {
                    let u = if d_idx == 0 { a } else { d0u + d_idx - 1 };
                    let v = if d0u + d_idx < end_d { d0u + d_idx } else { b };
                    if lane_of_item[u] != lane_of_item[v] || (coord[u] - coord[v]).abs() >= 0.5 {
                        sep[item_rank[u]] = full;
                    }
                }
            }
        }
        let mut at = head + end_pad;
        for r in 0..=max_rank {
            let mut band_depth = 0.0;
            for &i in &rows[r] {
                if depth[i] > band_depth {
                    band_depth = depth[i];
                }
            }
            band_start[r] = at;
            band_end[r] = at + band_depth;
            at += band_depth + if r == max_rank { 0.0 } else { sep[r] };
        }
        let length = at + end_pad;
        let breadth_total = lane_start[lane_count];
        let flip = |a: f64| -> f64 { if flipped { head + length - a } else { a } };
        let px = |c: f64, a: f64| -> f64 { if sideways { flip(a) } else { c } };
        let py = |c: f64, a: f64| -> f64 { if sideways { c } else { flip(a) } };
        let axis = if sideways { 1.0 } else { 0.0 };

        for (k, &node_idx) in real.iter().enumerate() {
            let a = (band_start[item_rank[k]] + band_end[item_rank[k]]) / 2.0;
            nodes[node_idx].x = px(coord[k], a);
            nodes[node_idx].y = py(coord[k], a);
        }
        for (k, &lane_idx) in lanes.iter().enumerate() {
            let c = (lane_start[k] + lane_start[k + 1]) / 2.0;
            let sz = lane_start[k + 1] - lane_start[k];
            let lane = &mut nodes[lane_idx];
            lane.x = if sideways { length / 2.0 } else { c };
            lane.y = if sideways { c } else { length / 2.0 };
            lane.w = if sideways { length } else { sz };
            lane.h = if sideways { sz } else { length };
            lane.pad_top = head;
        }

        // Groups inside a lane are drawn around their members, deepest first.
        let mut depth_of: Vec<usize> = vec![0; n];
        let mut inner: Vec<usize> = Vec::new();
        for i in 0..n {
            if !nodes[i].is_group || lane_slot[i] >= 0 || item_of[i] >= 0 {
                continue;
            }
            let mut d = 0usize;
            let mut p = nodes[i].parent;
            while p >= 0 && d < MAX_HOPS {
                d += 1;
                p = nodes[p as usize].parent;
            }
            depth_of[i] = d;
            inner.push(i);
        }
        inner.sort_by(|&a, &b| depth_of[b].cmp(&depth_of[a]).then_with(|| a.cmp(&b)));
        let mut bbox: Vec<[f64; 4]> = vec![[f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY]; n];
        let grow = |bbox: &mut [[f64; 4]], g: usize, c: &CNode| {
            let b = &mut bbox[g];
            if c.x - c.w / 2.0 < b[0] {
                b[0] = c.x - c.w / 2.0;
            }
            if c.y - c.h / 2.0 < b[1] {
                b[1] = c.y - c.h / 2.0;
            }
            if c.x + c.w / 2.0 > b[2] {
                b[2] = c.x + c.w / 2.0;
            }
            if c.y + c.h / 2.0 > b[3] {
                b[3] = c.y + c.h / 2.0;
            }
        };
        for &i in &real {
            let p = nodes[i].parent;
            if p >= 0 && lane_slot[p as usize] < 0 {
                grow(&mut bbox, p as usize, &nodes[i]);
            }
        }
        for g in inner {
            if bbox[g][0] == f64::INFINITY {
                continue;
            }
            let [bx0, by0, bx1, by1] = bbox[g];
            let c = &mut nodes[g];
            let w = (bx1 - bx0 + 2.0 * c.pad_x).max(c.min_w);
            c.x = (bx0 + bx1) / 2.0;
            c.w = w;
            c.y = (by0 - c.pad_top + by1 + c.pad_bottom) / 2.0;
            c.h = by1 - by0 + c.pad_top + c.pad_bottom;
            let p = c.parent;
            if p >= 0 && lane_slot[p as usize] < 0 {
                let copy = c.clone();
                grow(&mut bbox, p as usize, &copy);
            }
        }

        for e in edges.iter_mut() {
            e.route.clear();
        }
        for k in 0..m {
            let e = &ledges[k];
            let out = &mut edges[edge_of[k]];
            let a = if e.reversed { e.head } else { e.tail };
            let b = if e.reversed { e.tail } else { e.head };
            let mut pts: Vec<f64> = vec![
                coord[a],
                band_end[item_rank[a]] - (band_end[item_rank[a]] - band_start[item_rank[a]] - depth[a]) / 2.0,
            ];
            let d0 = first_dummy[k];
            if d0 >= 0 {
                let d0u = d0 as usize;
                for d in d0u..(d0u + span[k] - 1) {
                    pts.push(coord[d]);
                    pts.push(band_start[item_rank[d]]);
                    if band_end[item_rank[d]] > band_start[item_rank[d]] {
                        pts.push(coord[d]);
                        pts.push(band_end[item_rank[d]]);
                    }
                }
            }
            pts.push(coord[b]);
            pts.push(band_start[item_rank[b]] + (band_end[item_rank[b]] - band_start[item_rank[b]] - depth[b]) / 2.0);
            let mut route: Vec<f64> = Vec::with_capacity((pts.len() / 2) * 3);
            for pair in pts.as_chunks::<2>().0 {
                route.push(px(pair[0], pair[1]));
                route.push(py(pair[0], pair[1]));
                route.push(axis);
            }
            if e.reversed {
                let mut i = 0usize;
                let mut j = route.len().saturating_sub(3);
                while i < j {
                    route.swap(i, j);
                    route.swap(i + 1, j + 1);
                    i += 3;
                    j -= 3;
                }
            }
            let rlen = route.len();
            let label = label_item[k];
            if label >= 0 {
                let lu = label as usize;
                let mid = (band_start[item_rank[lu]] + band_end[item_rank[lu]]) / 2.0;
                out.label_x = px(coord[lu], mid);
                out.label_y = py(coord[lu], mid);
            } else if rlen >= 3 {
                out.label_x = (route[0] + route[rlen - 3]) / 2.0;
                out.label_y = (route[1] + route[rlen - 2]) / 2.0;
            }
            out.route = route;
        }

        // An edge that starts or ends at a lane or a group runs straight to its border.
        for e in edges.iter_mut() {
            if !e.route.is_empty() || e.src == e.dst {
                continue;
            }
            let a = &nodes[e.src];
            let b = &nodes[e.dst];
            let (ax, ay) = border(a, b);
            let (bx, by) = border(b, a);
            let flat = if (bx - ax).abs() > (by - ay).abs() { 1.0 } else { 0.0 };
            e.route = vec![ax, ay, flat, bx, by, flat];
            e.label_x = (ax + bx) / 2.0;
            e.label_y = (ay + by) / 2.0;
        }

        // A handoff can leave towards the other lane, then arrive along the flow (or vice versa).
        let mut routed: Vec<bool> = vec![false; m];
        let route_points: usize = edges.iter().map(|e| e.route.len() / 3).sum();
        let work = m.saturating_mul(real.len() + edges.len() + route_points);
        if work <= ROUTE_BUDGET {
            let amid = |i: usize| -> f64 { (band_start[item_rank[i]] + band_end[item_rank[i]]) / 2.0 };
            let mut labels: Vec<[f64; 2]> = edges
                .iter()
                .map(|e| [if sideways { e.label_y } else { e.label_x }, flip(if sideways { e.label_x } else { e.label_y })])
                .collect();
            let overlaps = |c0: f64, a0: f64, c1: f64, a1: f64, lc: f64, la: f64, cw: f64, ah: f64| -> bool {
                c1 > lc - cw / 2.0 && c0 < lc + cw / 2.0 && a1 > la - ah / 2.0 && a0 < la + ah / 2.0
            };

            let is_clear = |edges: &[CEdge], labels: &[[f64; 2]], c0: f64, a0: f64, c1: f64, a1: f64, src: isize, dst: isize, ei: usize| -> bool {
                for i in 0..real.len() {
                    if i as isize != src && i as isize != dst && overlaps(c0, a0, c1, a1, coord[i], amid(i), size[i] + 8.0, depth[i] + 8.0) {
                        return false;
                    }
                }
                for (i, e) in edges.iter().enumerate() {
                    if i != ei
                        && e.label_w > 0.0
                        && e.src != e.dst
                        && overlaps(
                            c0,
                            a0,
                            c1,
                            a1,
                            labels[i][0],
                            labels[i][1],
                            if sideways { e.label_h } else { e.label_w },
                            if sideways { e.label_w } else { e.label_h },
                        )
                    {
                        return false;
                    }
                }
                true
            };

            let crossings = |edges: &[CEdge], x0: f64, y0: f64, x1: f64, y1: f64, ei: usize| -> usize {
                let mut count = 0usize;
                for (i, e) in edges.iter().enumerate() {
                    if i == ei {
                        continue;
                    }
                    let route = &e.route;
                    let mut j = 3;
                    while j < route.len() {
                        if route[j - 3].max(route[j]) > x0
                            && route[j - 3].min(route[j]) < x1
                            && route[j - 2].max(route[j + 1]) > y0
                            && route[j - 2].min(route[j + 1]) < y1
                        {
                            count += 1;
                            break;
                        }
                        j += 3;
                    }
                }
                count
            };

            let meets = |edges: &[CEdge], x: f64, y: f64, ei: usize| -> usize {
                let mut count = 0usize;
                for (i, e) in edges.iter().enumerate() {
                    let route = &e.route;
                    if i == ei || route.is_empty() {
                        continue;
                    }
                    let last = route.len() - 3;
                    if ((route[0] - x).abs() < 1.0 && (route[1] - y).abs() < 1.0) || ((route[last] - x).abs() < 1.0 && (route[last + 1] - y).abs() < 1.0) {
                        count += 1;
                    }
                }
                count
            };

            let retraces = |edges: &[CEdge], x0: f64, y0: f64, x1: f64, y1: f64, ei: usize| -> bool {
                let upright = (x1 - x0).abs() < 0.5;
                let (lo, hi) = if upright { (y0.min(y1), y0.max(y1)) } else { (x0.min(x1), x0.max(x1)) };
                let line = if upright { x0 } else { y0 };
                let cur_src = edges[ei].src;
                let cur_dst = edges[ei].dst;
                for (i, other) in edges.iter().enumerate() {
                    if i == ei || other.src == cur_src || other.dst == cur_dst {
                        continue;
                    }
                    let route = &other.route;
                    let mut j = 3;
                    while j < route.len() {
                        let u_off = if upright { 0 } else { 1 };
                        let v_off = if upright { 1 } else { 0 };
                        let u0 = route[j - 3 + u_off];
                        let u1 = route[j + u_off];
                        if (u0 - line).abs() < NEAR && (u1 - line).abs() < NEAR {
                            let v0 = route[j - 3 + v_off];
                            let v1 = route[j + v_off];
                            if hi.min(v0.max(v1)) - lo.max(v0.min(v1)) > 1.0 {
                                return true;
                            }
                        }
                        j += 3;
                    }
                }
                false
            };

            for k in 0..m {
                let e = &ledges[k];
                let ei = edge_of[k];
                let a = e.tail;
                let b = e.head;
                if lane_of_item[a] == lane_of_item[b] || (coord[b] - coord[a]).abs() < 1.0 {
                    continue;
                }
                let ac = coord[a];
                let bc = coord[b];
                let aa = amid(a);
                let ba = amid(b);
                let dc = js_sign(bc - ac);
                let da = js_sign(ba - aa);

                let attempt = |edges: &mut [CEdge], labels: &mut [[f64; 2]], routed: &mut [bool], pts: &[f64], margin: f64| -> bool {
                    let mut p = 2;
                    while p < pts.len() {
                        if !is_clear(
                            edges,
                            labels,
                            pts[p - 2].min(pts[p]) - margin,
                            pts[p - 1].min(pts[p + 1]) - margin,
                            pts[p - 2].max(pts[p]) + margin,
                            pts[p - 1].max(pts[p + 1]) + margin,
                            a as isize,
                            b as isize,
                            ei,
                        ) {
                            return false;
                        }
                        if retraces(
                            edges,
                            px(pts[p - 2], pts[p - 1]),
                            py(pts[p - 2], pts[p - 1]),
                            px(pts[p], pts[p + 1]),
                            py(pts[p], pts[p + 1]),
                            ei,
                        ) {
                            return false;
                        }
                        p += 2;
                    }
                    let mut lc = 0.0;
                    let mut la = 0.0;
                    let mut longest = -1.0;
                    let out_lw = edges[ei].label_w;
                    let out_lh = edges[ei].label_h;
                    if out_lw > 0.0 {
                        let cw = e.label_w;
                        let ah = e.label_h;
                        let mut p = 2;
                        while p < pts.len() {
                            let cc = (pts[p - 2] + pts[p]) / 2.0;
                            let ca = (pts[p - 1] + pts[p + 1]) / 2.0;
                            let across = (pts[p] - pts[p - 2]).abs();
                            let along_len = (pts[p + 1] - pts[p - 1]).abs();
                            let run = across + along_len;
                            let fits = if across > 0.0 { across >= cw + 8.0 } else { along_len >= ah + 8.0 };
                            if run > longest
                                && fits
                                && cc - cw / 2.0 >= 0.0
                                && cc + cw / 2.0 <= breadth_total
                                && ca - ah / 2.0 >= 0.0
                                && ca + ah / 2.0 <= length
                                && is_clear(edges, labels, cc - cw / 2.0, ca - ah / 2.0, cc + cw / 2.0, ca + ah / 2.0, -1, -1, ei)
                            {
                                let lx = px(cc, ca);
                                let ly = py(cc, ca);
                                if crossings(edges, lx - out_lw / 2.0, ly - out_lh / 2.0, lx + out_lw / 2.0, ly + out_lh / 2.0, ei) == 0 {
                                    lc = cc;
                                    la = ca;
                                    longest = run;
                                }
                            }
                            p += 2;
                        }
                        if longest < 0.0 {
                            return false;
                        }
                    }

                    let mut way: Vec<f64> = vec![pts[0], pts[1]];
                    let mut p = 2;
                    while p < pts.len() {
                        let dx = pts[p] - pts[p - 2];
                        let dy = pts[p + 1] - pts[p - 1];
                        let run = dx.abs() + dy.abs();
                        let first = if p > 2 { TURN } else { 0.0 };
                        let last = if p + 2 < pts.len() { TURN } else { 0.0 };
                        if run > first + last + 1.0 {
                            if first > 0.0 {
                                way.push(pts[p - 2] + (dx / run) * first);
                                way.push(pts[p - 1] + (dy / run) * first);
                            }
                            if last > 0.0 {
                                way.push(pts[p] - (dx / run) * last);
                                way.push(pts[p + 1] - (dy / run) * last);
                            }
                        }
                        way.push(pts[p]);
                        way.push(pts[p + 1]);
                        p += 2;
                    }
                    let mut new_route: Vec<f64> = Vec::with_capacity((way.len() / 2) * 3);
                    let mut wp = 0;
                    while wp < way.len() {
                        let crosswise = if wp == 0 { way[0] != way[2] } else { way[wp] != way[wp - 2] };
                        new_route.push(px(way[wp], way[wp + 1]));
                        new_route.push(py(way[wp], way[wp + 1]));
                        new_route.push(if crosswise { 1.0 - axis } else { axis });
                        wp += 2;
                    }
                    edges[ei].route = new_route;
                    if out_lw > 0.0 {
                        edges[ei].label_x = px(lc, la);
                        edges[ei].label_y = py(lc, la);
                        labels[ei] = [lc, la];
                    }
                    routed[k] = true;
                    true
                };

                let corner_a = [ac + dc * size[a] / 2.0, aa, bc, aa, bc, ba - da * depth[b] / 2.0];
                if attempt(edges, &mut labels, &mut routed, &corner_a, 2.0) {
                    continue;
                }
                let corner_b = [ac, aa + da * depth[a] / 2.0, ac, ba, bc - dc * size[b] / 2.0, ba];
                if attempt(edges, &mut labels, &mut routed, &corner_b, 2.0) {
                    continue;
                }

                if work > ROUTE_BUDGET / RELAY {
                    continue;
                }
                struct Around {
                    pts: [f64; 8],
                    cost: f64,
                    lane: usize,
                }
                let mut around: Vec<Around> = Vec::new();
                let cand_lanes = if lane_of_item[a] < lane_of_item[b] {
                    [lane_of_item[b], lane_of_item[a]]
                } else {
                    [lane_of_item[a], lane_of_item[b]]
                };
                for lane in cand_lanes {
                    let inset = (pad[lane] - LEG).max((pad[lane] / 2.0).min(MARGIN - LEG));
                    for ch in [lane_start[lane] + inset, lane_start[lane + 1] - inset] {
                        if (ch - ac).abs() < size[a] / 2.0 + 4.0 || (ch - bc).abs() < size[b] / 2.0 + 4.0 {
                            continue;
                        }
                        let pts = [
                            ac + js_sign(ch - ac) * size[a] / 2.0,
                            aa,
                            ch,
                            aa,
                            ch,
                            ba,
                            bc + js_sign(ch - bc) * size[b] / 2.0,
                            ba,
                        ];
                        let mut cost =
                            (meets(edges, px(pts[0], pts[1]), py(pts[0], pts[1]), ei) + meets(edges, px(pts[6], pts[7]), py(pts[6], pts[7]), ei)) as f64 * 1e6;
                        let mut p = 2;
                        while p < pts.len() {
                            let x0 = px(pts[p - 2], pts[p - 1]);
                            let y0 = py(pts[p - 2], pts[p - 1]);
                            let x1 = px(pts[p], pts[p + 1]);
                            let y1 = py(pts[p], pts[p + 1]);
                            cost += crossings(edges, x0.min(x1), y0.min(y1), x0.max(x1), y0.max(y1), ei) as f64 * 1e6 + (x1 - x0).abs() + (y1 - y0).abs();
                            p += 2;
                        }
                        around.push(Around { pts, cost, lane });
                    }
                }
                around.sort_by(|p, q| p.cost.total_cmp(&q.cost));
                for way in around {
                    if !attempt(edges, &mut labels, &mut routed, &way.pts, 1.0) {
                        continue;
                    }
                    used[way.lane] = true;
                    break;
                }
            }
        }

        PlaceResult {
            width: if sideways { length } else { breadth_total },
            height: if sideways { breadth_total } else { length },
            routed,
            margins: used,
            work,
        }
    };

    let mut plain: Vec<bool> = vec![false; m];
    let mut margins: Vec<bool> = vec![false; lane_count];
    let mut placed = place(&plain, &margins);
    for round in 0..ROUNDS {
        if placed.work > ROUTE_BUDGET / RELAY {
            break;
        }
        let next: Vec<bool> = if round == 0 {
            placed.routed.clone()
        } else {
            plain.iter().enumerate().map(|(k, &on)| on && placed.routed[k]).collect()
        };
        if next == plain && placed.margins == margins {
            break;
        }
        plain = next;
        margins = placed.margins;
        placed = place(&plain, &margins);
    }
    if plain.iter().enumerate().any(|(k, &on)| on && !placed.routed[k]) {
        placed = place(&vec![false; m], &vec![false; lane_count]);
    }
    CompoundResult {
        width: placed.width,
        height: placed.height,
    }
}

// The point where the line from one box's center to another's leaves the first box. When the
// other center is inside the box, the point is on the nearest side instead.
fn border(from: &CNode, to: &CNode) -> (f64, f64) {
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    let hw = (from.w / 2.0).max(0.5);
    let hh = (from.h / 2.0).max(0.5);
    if dx.abs() < hw && dy.abs() < hh {
        let to_side = hw - dx.abs();
        let to_end = hh - dy.abs();
        return if to_side < to_end {
            (from.x + if dx < 0.0 { -hw } else { hw }, to.y)
        } else {
            (to.x, from.y + if dy < 0.0 { -hh } else { hh })
        };
    }
    let scale = (if dx != 0.0 { hw / dx.abs() } else { f64::INFINITY }).min(if dy != 0.0 { hh / dy.abs() } else { f64::INFINITY });
    (from.x + dx * scale, from.y + dy * scale)
}
