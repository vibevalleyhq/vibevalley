use std::collections::{HashMap, HashSet};
use std::f64::consts::{PI, TAU};

use indexmap::IndexMap;

use super::types::VennSubset;

#[derive(Debug, Clone, PartialEq)]
pub struct Circle {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub r: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Spot {
    pub x: f64,
    pub y: f64,
    pub margin: f64,
}

/// For every overlap of three or more sets, adds any unstated pairwise overlaps (a quarter of the smaller set).
pub fn ensure_pairwise_subsets(subsets: &[VennSubset]) -> Vec<VennSubset> {
    let mut present: HashSet<Vec<String>> = HashSet::new();
    let mut sizes: HashMap<String, f64> = HashMap::new();
    for subset in subsets {
        let mut sorted = subset.sets.clone();
        sorted.sort();
        present.insert(sorted);
        if subset.sets.len() == 1 {
            sizes.insert(subset.sets[0].clone(), subset.size);
        }
    }
    let mut added = Vec::new();
    for subset in subsets {
        if subset.sets.len() < 3 {
            continue;
        }
        let mut members = subset.sets.clone();
        members.sort();
        for i in 0..members.len().saturating_sub(1) {
            for j in i + 1..members.len() {
                let pair = vec![members[i].clone(), members[j].clone()];
                if present.contains(&pair) {
                    continue;
                }
                present.insert(pair.clone());
                let size = match (sizes.get(&pair[0]), sizes.get(&pair[1])) {
                    (Some(&a), Some(&b)) => a.min(b) / 4.0,
                    _ => 2.5,
                };
                added.push(VennSubset {
                    sets: pair,
                    size,
                    label: Some(String::new()),
                });
            }
        }
    }
    if added.is_empty() {
        subsets.to_vec()
    } else {
        let mut combined = subsets.to_vec();
        combined.extend(added);
        combined
    }
}

/// Area shared by two circles of radii `r1`, `r2` whose centers are `d` apart.
pub fn lens_area(r1: f64, r2: f64, d: f64) -> f64 {
    if d >= r1 + r2 {
        return 0.0;
    }
    let small = r1.min(r2);
    if d <= (r1 - r2).abs() {
        return PI * small * small;
    }
    let a1 = r1 * r1 * ((d * d + r1 * r1 - r2 * r2) / (2.0 * d * r1)).clamp(-1.0, 1.0).acos();
    let a2 = r2 * r2 * ((d * d + r2 * r2 - r1 * r1) / (2.0 * d * r2)).clamp(-1.0, 1.0).acos();
    let a3 = 0.5 * ((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2)).max(0.0).sqrt();
    a1 + a2 - a3
}

/// Center distance producing the given overlap area via bisection.
pub fn distance_for_overlap(r1: f64, r2: f64, area: f64) -> f64 {
    let mut low = (r1 - r2).abs();
    let mut high = r1 + r2;
    if area.is_nan() || area <= 0.0 {
        return high;
    }
    let small = r1.min(r2);
    if area >= PI * small * small {
        return low;
    }
    for _ in 0..48 {
        let middle = (low + high) / 2.0;
        if lens_area(r1, r2, middle) > area {
            low = middle;
        } else {
            high = middle;
        }
    }
    (low + high) / 2.0
}

fn margin(circles: &[Circle], inside: &[usize], outside: &[usize], x: f64, y: f64, floor: f64) -> f64 {
    let mut best = f64::INFINITY;
    for &i in inside {
        let c = &circles[i];
        let dx = x - c.x;
        let dy = y - c.y;
        let room = c.r - (dx * dx + dy * dy).sqrt();
        if room < best {
            if room < floor {
                return room;
            }
            best = room;
        }
    }
    for &i in outside {
        let c = &circles[i];
        let dx = x - c.x;
        let dy = y - c.y;
        let room = (dx * dx + dy * dy).sqrt() - c.r;
        if room < best {
            if room < floor {
                return room;
            }
            best = room;
        }
    }
    best
}

/// Finds the roomiest interior point inside `inside` and outside `outside`.
pub fn find_spot(circles: &[Circle], inside: &[usize], outside: &[usize]) -> Spot {
    let mut cx = 0.0f64;
    let mut cy = 0.0f64;
    let mut smallest = &circles[inside[0]];
    for &i in inside {
        let c = &circles[i];
        cx += c.x / (inside.len() as f64);
        cy += c.y / (inside.len() as f64);
        if c.r < smallest.r {
            smallest = c;
        }
    }
    let r = smallest.r;
    let mut x = cx;
    let mut y = cy;
    let mut best = margin(circles, inside, outside, x, y, f64::NEG_INFINITY);
    let mut off = 0.0f64;

    let try_point = |x: &mut f64, y: &mut f64, best: &mut f64, off: &mut f64, px: f64, py: f64| -> bool {
        let m = margin(circles, inside, outside, px, py, *best - r * 1e-9);
        if m.is_nan() || m <= *best - r * 1e-9 {
            return false;
        }
        let distance = (px - cx).hypot(py - cy);
        if m > *best + r * 1e-9 || distance < *off - r * 1e-9 {
            *best = m;
            *off = distance;
            *x = px;
            *y = py;
            return true;
        }
        false
    };

    const GRID: i32 = 10;
    for gy in -GRID..=GRID {
        for gx in -GRID..=GRID {
            if gx * gx + gy * gy <= GRID * GRID {
                try_point(
                    &mut x,
                    &mut y,
                    &mut best,
                    &mut off,
                    smallest.x + ((gx as f64) * r) / (GRID as f64),
                    smallest.y + ((gy as f64) * r) / (GRID as f64),
                );
            }
        }
    }

    let mut step = r / (GRID as f64);
    for _round in 0..40 {
        if step <= r * 1e-6 {
            break;
        }
        let mut moved = false;
        for k in 0..8 {
            let angle = ((k as f64) * TAU) / 8.0;
            let nx = x + angle.cos() * step;
            let ny = y + angle.sin() * step;
            if try_point(&mut x, &mut y, &mut best, &mut off, nx, ny) {
                moved = true;
            }
        }
        if !moved {
            step /= 2.0;
        }
    }

    Spot { x, y, margin: best }
}

pub fn layout_circles(subsets: &[VennSubset]) -> Vec<Circle> {
    let mut sizes: IndexMap<String, f64> = IndexMap::new();
    for subset in subsets {
        for id in &subset.sets {
            sizes.entry(id.clone()).or_insert(10.0);
        }
    }
    for subset in subsets {
        if subset.sets.len() == 1 {
            sizes.insert(subset.sets[0].clone(), subset.size);
        }
    }

    let mut index: HashMap<String, usize> = HashMap::new();
    let mut circles: Vec<Circle> = Vec::with_capacity(sizes.len());
    let mut largest = 0.0f64;
    for &size in sizes.values() {
        if size.is_finite() && size > largest {
            largest = size;
        }
    }
    if largest == 0.0 {
        largest = 10.0;
    }
    let widest = (largest / PI).sqrt();
    for (id, size) in sizes {
        index.insert(id.clone(), circles.len());
        let r = if size.is_finite() && size > 0.0 { (size / PI).sqrt() } else { 0.0 };
        circles.push(Circle {
            id,
            x: 0.0,
            y: 0.0,
            r: r.max(widest * 0.3),
        });
    }
    let n = circles.len();
    if n < 2 {
        return circles;
    }

    let mut overlaps: HashMap<(usize, usize), f64> = HashMap::new();
    for subset in ensure_pairwise_subsets(subsets) {
        if subset.sets.len() != 2 {
            continue;
        }
        let a = index[&subset.sets[0]];
        let b = index[&subset.sets[1]];
        if a != b {
            overlaps.insert((a.min(b), a.max(b)), subset.size);
        }
    }
    let mut wanted: HashMap<(usize, usize), f64> = HashMap::new();
    for (&(a, b), &area) in &overlaps {
        wanted.insert((a, b), distance_for_overlap(circles[a].r, circles[b].r, area));
    }
    let gap = widest * 0.15;
    let distance = |a: usize, b: usize| -> f64 { wanted.get(&(a, b)).copied().unwrap_or_else(|| circles[a].r + circles[b].r + gap) };

    if n == 2 {
        circles[1].x = distance(0, 1);
        return circles;
    }

    if n == 3 {
        let mut ab = distance(0, 1);
        let mut ac = distance(0, 2);
        let mut bc = distance(1, 2);
        let triple = subsets.iter().any(|s| s.sets.iter().collect::<HashSet<_>>().len() == 3);
        for _attempt in 0..40 {
            let x = if ab > 0.0 { (ab * ab + ac * ac - bc * bc) / (2.0 * ab) } else { 0.0 };
            circles[1].x = ab;
            circles[2].x = x.clamp(-ac, ac);
            circles[2].y = (ac * ac - x * x).max(0.0).sqrt();
            if !triple || find_spot(&circles, &[0, 1, 2], &[]).margin > widest * 0.12 {
                break;
            }
            ab *= 0.94;
            ac *= 0.94;
            bc *= 0.94;
        }
        return circles;
    }

    let total: f64 = circles.iter().map(|c| 2.0 * c.r + gap).sum();
    let rounds = 300usize.min((3_000_000.0 / ((n * n) as f64)).floor() as usize);
    if n <= 64 {
        let ring = total / TAU;
        for (i, c) in circles.iter_mut().enumerate() {
            let angle = ((i as f64) * TAU) / (n as f64) - PI / 2.0;
            c.x = angle.cos() * ring;
            c.y = angle.sin() * ring;
        }
    } else {
        let columns = (n as f64).sqrt().ceil() as usize;
        let cell = 2.0 * widest + gap;
        for (i, c) in circles.iter_mut().enumerate() {
            c.x = ((i % columns) as f64) * cell;
            c.y = ((i / columns) as f64) * cell;
        }
    }

    let mut dx = vec![0.0f64; n];
    let mut dy = vec![0.0f64; n];
    let mut pulls = vec![0usize; n];
    for _round in 0..rounds {
        dx.fill(0.0);
        dy.fill(0.0);
        pulls.fill(0);
        for a in 0..n {
            for b in a + 1..n {
                let overlap = wanted.get(&(a, b)).copied();
                let apart = circles[a].r + circles[b].r + gap;
                let ux = circles[b].x - circles[a].x;
                let uy = circles[b].y - circles[a].y;
                let length = ux.hypot(uy);
                if overlap.is_none() && length >= apart {
                    continue;
                }
                let (nx, ny) = if length < widest * 1e-9 {
                    (((a + b) as f64).cos(), ((a + b) as f64).sin())
                } else {
                    (ux / length, uy / length)
                };
                let mv = (length - overlap.unwrap_or(apart)) / 2.0;
                dx[a] += nx * mv;
                dy[a] += ny * mv;
                dx[b] -= nx * mv;
                dy[b] -= ny * mv;
                pulls[a] += 1;
                pulls[b] += 1;
            }
        }
        for i in 0..n {
            if pulls[i] == 0 {
                continue;
            }
            circles[i].x += dx[i] / (pulls[i] as f64);
            circles[i].y += dy[i] / (pulls[i] as f64);
        }
    }
    circles
}

struct Corner {
    x: f64,
    y: f64,
    a: usize,
    b: usize,
}

/// SVG path outlining the intersection of all `circles`, or empty string when disjoint.
pub fn region_path<F>(circles: &[Circle], format: F) -> String
where
    F: Fn(f64) -> String,
{
    let whole = |c: &Circle| -> String {
        let r = format(c.r);
        let left = format(c.x - c.r);
        let right = format(c.x + c.r);
        let cy = format(c.y);
        format!("M{left},{cy}A{r},{r} 0 1 1 {right},{cy}A{r},{r} 0 1 1 {left},{cy}Z")
    };
    if circles.is_empty() {
        return String::new();
    }
    if circles.len() == 1 {
        return whole(&circles[0]);
    }
    let within = |x: f64, y: f64, skip: usize, other: usize| -> bool {
        for (idx, c) in circles.iter().enumerate() {
            if idx != skip && idx != other && (x - c.x).hypot(y - c.y) > c.r * (1.0 + 1e-9) {
                return false;
            }
        }
        true
    };

    let mut corners: Vec<Corner> = Vec::new();
    for i in 0..circles.len() {
        for j in i + 1..circles.len() {
            let a = &circles[i];
            let b = &circles[j];
            let d = (b.x - a.x).hypot(b.y - a.y);
            if d >= a.r + b.r || d <= (a.r - b.r).abs() || d == 0.0 {
                continue;
            }
            let along = (a.r * a.r - b.r * b.r + d * d) / (2.0 * d);
            let up = (a.r * a.r - along * along).max(0.0).sqrt();
            let mx = a.x + ((b.x - a.x) * along) / d;
            let my = a.y + ((b.y - a.y) * along) / d;
            for sign in [1.0f64, -1.0] {
                let x = mx + (sign * up * (b.y - a.y)) / d;
                let y = my - (sign * up * (b.x - a.x)) / d;
                if within(x, y, i, j) {
                    corners.push(Corner { x, y, a: i, b: j });
                }
            }
        }
    }

    if corners.len() < 2 {
        let mut smallest_idx = 0usize;
        for (idx, c) in circles.iter().enumerate() {
            if c.r < circles[smallest_idx].r {
                smallest_idx = idx;
            }
        }
        let smallest = &circles[smallest_idx];
        for (idx, c) in circles.iter().enumerate() {
            if idx != smallest_idx && (c.x - smallest.x).hypot(c.y - smallest.y) + smallest.r > c.r * (1.0 + 1e-9) {
                return String::new();
            }
        }
        return whole(smallest);
    }

    let cx: f64 = corners.iter().map(|p| p.x).sum::<f64>() / (corners.len() as f64);
    let cy: f64 = corners.iter().map(|p| p.y).sum::<f64>() / (corners.len() as f64);
    corners.sort_by(|p, q| (p.y - cy).atan2(p.x - cx).total_cmp(&(q.y - cy).atan2(q.x - cx)));

    let mut d = String::new();
    for i in 0..corners.len() {
        let from = &corners[i];
        let to = &corners[(i + 1) % corners.len()];
        if i == 0 {
            d = format!("M{},{}", format(from.x), format(from.y));
        }
        let mut arc: Option<&Circle> = None;
        let mut large = 0u8;
        let mut narrowest = f64::INFINITY;
        for &cid in &[from.a, from.b] {
            if cid != to.a && cid != to.b {
                continue;
            }
            let c = &circles[cid];
            let start = (from.y - c.y).atan2(from.x - c.x);
            let mut sweep = (to.y - c.y).atan2(to.x - c.x) - start;
            if sweep <= 0.0 {
                sweep += TAU;
            }
            let mx = c.x + c.r * (start + sweep / 2.0).cos();
            let my = c.y + c.r * (start + sweep / 2.0).sin();
            let width = (mx - (from.x + to.x) / 2.0).hypot(my - (from.y + to.y) / 2.0);
            if width < narrowest {
                narrowest = width;
                arc = Some(c);
                large = u8::from(sweep > PI);
            }
        }
        match arc {
            None => d.push_str(&format!("L{},{}", format(to.x), format(to.y))),
            Some(c) => {
                let r = format(c.r);
                d.push_str(&format!("A{r},{r} 0 {large} 1 {},{}", format(to.x), format(to.y)));
            }
        }
    }
    d.push('Z');
    d
}
