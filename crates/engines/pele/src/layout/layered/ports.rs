use super::types::{End, Graph, IN_LINE, Kind, LNode, LayeredOptions, TWIN, half_room};

const PORT_PITCH: f64 = 16.0;
const MIN_PITCH: f64 = 8.0;
const SNAP: f64 = 12.0;
const BEND_SNAP: f64 = 24.0;
const LEAN_CLEAR: f64 = 40.0;

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

pub(super) fn spread(g: &mut Graph<'_>, nodes: &[LNode], efk: &[End], etk: &[End]) {
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

pub(super) fn align_ports(g: &Graph<'_>, xs: &mut [f64], empty: Option<&[bool]>) {
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

pub(super) fn free_ends(g: &Graph<'_>, efk: &[End], etk: &[End]) -> [Vec<i32>; 2] {
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

pub(super) fn align_labels(g: &Graph<'_>, nodes: &[LNode], xs: &mut [f64], free: &[Vec<i32>; 2], opt: &LayeredOptions, empty: Option<&[bool]>) {
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

pub(super) fn settle(g: &mut Graph<'_>, nodes: &[LNode], xs: &[f64], efk: &[End], etk: &[End], free: &[Vec<i32>; 2], empty: Option<&[bool]>) {
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

pub(super) fn snap(g: &Graph<'_>, xs: &mut [f64], empty: Option<&[bool]>, opt: &LayeredOptions) {
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
