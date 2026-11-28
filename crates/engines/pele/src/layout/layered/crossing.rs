use super::types::{Graph, LNode};

const MAX_SWEEPS: usize = 24;

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

pub(super) fn reduce_crossings(g: &mut Graph<'_>, nodes: &[LNode]) -> (usize, usize) {
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
