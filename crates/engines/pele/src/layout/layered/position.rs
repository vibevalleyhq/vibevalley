use super::types::{Graph, LayeredOptions, half_room};

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

pub(super) fn position(g: &mut Graph<'_>, opt: &LayeredOptions) -> Vec<f64> {
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
