use indexmap::IndexMap;
use std::collections::HashSet;

use super::types::{Graph, IN_LINE, Kind, Pieces, TWIN};

const LEVEL_LEAD: f64 = 12.0;
const LEVEL_CLEAR: f64 = 8.0;
const LEVEL_TOUCH: f64 = 4.0;
const CROSSED_SLOPE: f64 = 0.5;
const MAX_WEIGHED: usize = 400;
const SAMPLES: usize = 16;

/// Share of along-flow travel reached by plain S-curve handles.
pub fn ease(across: f64, along: f64) -> f64 {
    let denom = across.abs();
    let denom = if denom == 0.0 { 1.0 } else { denom };
    ((4.0 * along.abs()) / denom).clamp(0.25, 0.5)
}

pub(super) fn assign_tracks(pieces: &mut Pieces, track_count: &mut [i32], curved: bool, room: &[f64], tall: &mut [f64]) {
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

pub(super) fn straighten(g: &Graph<'_>, xs: &mut [f64], empty: &[bool], first_dummy: &[i32], span: &[usize], sep: f64, on_line: &mut [bool]) {
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

pub(super) fn past_labels(g: &Graph<'_>, xs: &mut [f64], first_dummy: &[i32], span: &[usize], clear: f64, on_line: &mut [bool]) {
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
