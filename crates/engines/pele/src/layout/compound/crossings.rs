use crate::layout::layered::{LayeredOptions, ease};

use super::types::{CEdge, CNode, IN_LINE};

const FAN: f64 = 24.0;
const CURVE_PIECES: usize = 3;
const CORNER_PIECES: usize = 2;
const STEP_PIECES: usize = 3; // max(3, CURVE_PIECES, CORNER_PIECES + 1)
const HANDLE: f64 = 0.62;
const MAX_INSERT: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteStyle {
    Curved,
    Stepped,
    Linear,
}

pub fn style_of(opt: &LayeredOptions) -> RouteStyle {
    if opt.tracks {
        RouteStyle::Stepped
    } else if opt.straight {
        RouteStyle::Linear
    } else {
        RouteStyle::Curved
    }
}

pub fn route_crossings(nodes: &[CNode], edges: &[CEdge], style: RouteStyle) -> usize {
    let mut size = 0usize;
    for e in edges {
        if e.src != e.dst && e.route.len() > 3 {
            size += (e.route.len() / 3 - 1) * STEP_PIECES;
        }
    }
    let mut ax = vec![0.0f64; size];
    let mut ay = vec![0.0f64; size];
    let mut bx = vec![0.0f64; size];
    let mut by = vec![0.0f64; size];
    let mut low = vec![0.0f64; size];
    let mut high = vec![0.0f64; size];
    let mut owner = vec![0usize; size];
    let mut ends = vec![0u8; size];
    let mut count = 0usize;
    let mut top = f64::INFINITY;
    let mut bottom = f64::NEG_INFINITY;
    let mut from_x = f64::NAN;
    let mut from_y = f64::NAN;
    let mut to_x = f64::NAN;
    let mut to_y = f64::NAN;

    let mut add = |ei: usize, part: u8, mut x0: f64, mut y0: f64, x1: f64, y1: f64| {
        if count > 0 {
            let p = count - 1;
            let on = x0 == to_x && y0 == to_y && ((y1 == y0 && from_y == y0) || (x1 == x0 && from_x == x0));
            if on && owner[p] == ei && ends[p] == part && (x0 - from_x) * (x1 - x0) + (y0 - from_y) * (y1 - y0) > 0.0 {
                count -= 1;
                x0 = from_x;
                y0 = from_y;
            }
        }
        from_x = x0;
        from_y = y0;
        to_x = x1;
        to_y = y1;
        ends[count] = part;
        ax[count] = x0.min(x1);
        bx[count] = x0.max(x1);
        ay[count] = if x0 <= x1 { y0 } else { y1 };
        by[count] = if x0 <= x1 { y1 } else { y0 };
        low[count] = y0.min(y1);
        high[count] = y0.max(y1);
        if low[count] < top {
            top = low[count];
        }
        if high[count] > bottom {
            bottom = high[count];
        }
        owner[count] = ei;
        count += 1;
    };

    for (ei, e) in edges.iter().enumerate() {
        if e.src == e.dst || e.route.len() < 6 {
            continue;
        }
        let r = &e.route;
        let aligned = |k: usize| -> bool { (r[k] - r[k - 3]).abs() < 0.01 || (r[k + 1] - r[k - 2]).abs() < 0.01 };
        let length = |k: usize| -> f64 { (r[k] - r[k - 3]).abs() + (r[k + 1] - r[k - 2]).abs() };
        let turns = |k: usize| -> bool {
            style == RouteStyle::Curved
                && k > 0
                && k < r.len() - 3
                && aligned(k)
                && aligned(k + 3)
                && length(k) >= 0.01
                && length(k + 3) >= 0.01
                && ((r[k] - r[k - 3]).abs() < 0.01) != ((r[k + 3] - r[k]).abs() < 0.01)
        };
        let mut at_x = r[0];
        let mut at_y = r[1];
        let mut k = 3usize;
        while k < r.len() {
            let part = u8::from(k == 3) | (u8::from(k == r.len() - 3) << 1);
            let x0 = at_x;
            let y0 = at_y;
            let x1 = r[k];
            let y1 = r[k + 1];
            at_x = x1;
            at_y = y1;
            if aligned(k) || style == RouteStyle::Linear {
                if !turns(k) {
                    add(ei, part, x0, y0, x1, y1);
                    k += 3;
                    continue;
                }
                let lk = length(k);
                let lnext = length(k + 3);
                let before = if k >= 6 && turns(k - 3) { lk / 2.0 } else { lk };
                let after = if turns(k + 3) { lnext / 2.0 } else { lnext };
                let ux = (x1 - r[k - 3]) / lk;
                let uy = (y1 - r[k - 2]) / lk;
                let vx = (r[k + 3] - x1) / lnext;
                let vy = (r[k + 4] - y1) / lnext;
                let sx = x1 - ux * before;
                let sy = y1 - uy * before;
                add(ei, part, x0, y0, sx, sy);
                let c1x = x1 - ux * before * (1.0 - HANDLE);
                let c1y = y1 - uy * before * (1.0 - HANDLE);
                let c2x = x1 + vx * after * (1.0 - HANDLE);
                let c2y = y1 + vy * after * (1.0 - HANDLE);
                at_x = x1 + vx * after;
                at_y = y1 + vy * after;
                let turn = part | (u8::from(k + 3 == r.len() - 3) << 1);
                let mut px = sx;
                let mut py = sy;
                for i in 1..=CORNER_PIECES {
                    let t = (i as f64) / (CORNER_PIECES as f64);
                    let u = 1.0 - t;
                    let x = u * u * u * sx + 3.0 * u * u * t * c1x + 3.0 * u * t * t * c2x + t * t * t * at_x;
                    let y = u * u * u * sy + 3.0 * u * u * t * c1y + 3.0 * u * t * t * c2y + t * t * t * at_y;
                    add(ei, turn, px, py, x, y);
                    px = x;
                    py = y;
                }
                k += 3;
                continue;
            }
            if style == RouteStyle::Stepped {
                let down = r[k + 2] == 0.0;
                let mx = if down { x0 } else { (x0 + x1) / 2.0 };
                let my = if down { (y0 + y1) / 2.0 } else { y0 };
                add(ei, part, x0, y0, mx, my);
                add(ei, part, mx, my, if down { x1 } else { mx }, if down { my } else { y1 });
                add(ei, part, if down { x1 } else { mx }, if down { my } else { y1 }, x1, y1);
                k += 3;
                continue;
            }
            let down = r[k + 2] == 0.0;
            let c = if down { ease(x1 - x0, y1 - y0) } else { ease(y1 - y0, x1 - x0) };
            let mut px = x0;
            let mut py = y0;
            for i in 1..=CURVE_PIECES {
                let t = (i as f64) / (CURVE_PIECES as f64);
                let u = 1.0 - t;
                let across = t * t * (3.0 - 2.0 * t);
                let along = 3.0 * c * t * u * u + 3.0 * (1.0 - c) * t * t * u + t * t * t;
                let x = x0 + (x1 - x0) * if down { across } else { along };
                let y = y0 + (y1 - y0) * if down { along } else { across };
                add(ei, part, px, py, x, y);
                px = x;
                py = y;
            }
            k += 3;
        }
    }

    if count < 2 {
        return 0;
    }

    let bands = if bottom > top { ((count as f64).sqrt().round() as usize).max(1) } else { 1 };
    let scale = if bottom > top { (bands as f64) / (bottom - top) } else { 0.0 };
    let band_of = |y: f64| -> usize {
        let raw = ((y - top) * scale).floor();
        if raw <= 0.0 { 0 } else { (raw as usize).min(bands - 1) }
    };
    let mut first = vec![0usize; count];
    let mut band_start = vec![0usize; bands + 1];
    for p in 0..count {
        first[p] = band_of(low[p]);
        let last = band_of(high[p]);
        for b in first[p]..=last {
            band_start[b + 1] += 1;
        }
    }
    for b in 0..bands {
        band_start[b + 1] += band_start[b];
    }
    let mut fill = band_start[..bands].to_vec();
    let mut in_band = vec![0usize; band_start[bands]];
    for p in 0..count {
        let last = band_of(high[p]);
        for b in first[p]..=last {
            in_band[fill[b]] = p;
            fill[b] += 1;
        }
    }

    let mut runs = vec![0.0f64; edges.len() * 8];
    let in_line_pts = |r: &[f64], a: usize, b: usize, c: usize| -> bool {
        ((r[a] - r[b]).abs() < IN_LINE && (r[a] - r[c]).abs() < IN_LINE) || ((r[a + 1] - r[b + 1]).abs() < IN_LINE && (r[a + 1] - r[c + 1]).abs() < IN_LINE)
    };
    for (ei, e) in edges.iter().enumerate() {
        let r = &e.route;
        if r.len() < 6 {
            continue;
        }
        let mut k = 3usize;
        while k + 3 < r.len() && in_line_pts(r, 0, k, k + 3) {
            k += 3;
        }
        let last = r.len() - 3;
        let mut j = last - 3;
        while j >= 3 && in_line_pts(r, last, j, j - 3) {
            j -= 3;
        }
        let o = ei * 8;
        runs[o] = r[0];
        runs[o + 1] = r[1];
        runs[o + 2] = r[k];
        runs[o + 3] = r[k + 1];
        runs[o + 4] = r[j];
        runs[o + 5] = r[j + 1];
        runs[o + 6] = r[last];
        runs[o + 7] = r[last + 1];
    }
    let on_run = |ei: usize, end: u8, x: f64, y: f64| -> bool {
        let o = ei * 8 + if end == 1 { 0 } else { 4 };
        let x0 = runs[o];
        let y0 = runs[o + 1];
        let dx = runs[o + 2] - x0;
        let dy = runs[o + 3] - y0;
        let len_sq = dx * dx + dy * dy;
        let t = if len_sq > 0.0 {
            (((x - x0) * dx + (y - y0) * dy) / len_sq).clamp(0.0, 1.0)
        } else {
            0.0
        };
        (x - x0 - t * dx).hypot(y - y0 - t * dy) < IN_LINE
    };

    let mut total = 0usize;
    for band in 0..bands {
        let b_start = band_start[band];
        let b_end = band_start[band + 1];
        if b_end - b_start > MAX_INSERT {
            in_band[b_start..b_end].sort_by(|&p, &q| ax[p].total_cmp(&ax[q]).then_with(|| p.cmp(&q)));
        } else {
            for i in (b_start + 1)..b_end {
                let p = in_band[i];
                let mut j = i;
                while j > b_start && ax[in_band[j - 1]] > ax[p] {
                    in_band[j] = in_band[j - 1];
                    j -= 1;
                }
                in_band[j] = p;
            }
        }
        for s in b_start..b_end {
            let p = in_band[s];
            let dx = bx[p] - ax[p];
            let dy = by[p] - ay[p];
            let here = first[p] == band;
            for &q in &in_band[(s + 1)..b_end] {
                if ax[q] > bx[p] {
                    break;
                }
                if high[q] < low[p] || low[q] > high[p] || owner[p] == owner[q] || (!here && first[q] != band) {
                    continue;
                }
                let d1 = dx * (ay[q] - ay[p]) - dy * (ax[q] - ax[p]);
                let d2 = dx * (by[q] - ay[p]) - dy * (bx[q] - ax[p]);
                if (d1 > 0.0) == (d2 > 0.0) {
                    continue;
                }
                let ex = bx[q] - ax[q];
                let ey = by[q] - ay[q];
                let d3 = ex * (ay[p] - ay[q]) - ey * (ax[p] - ax[q]);
                let d4 = ex * (by[p] - ay[q]) - ey * (bx[p] - ax[q]);
                if (d3 > 0.0) == (d4 > 0.0) {
                    continue;
                }
                let ep = &edges[owner[p]];
                let eq = &edges[owner[q]];
                let at = d3 / (d3 - d4);
                let x = ax[p] + at * dx;
                let y = ay[p] + at * dy;
                let fan = |v: usize, pe: u8, qe: u8| -> bool {
                    ((ends[p] & pe) != 0 && (ends[q] & qe) != 0)
                        || ((x - nodes[v].x).abs() < nodes[v].w / 2.0 + FAN && (y - nodes[v].y).abs() < nodes[v].h / 2.0 + FAN)
                        || (on_run(owner[p], pe, x, y) && on_run(owner[q], qe, x, y))
                };
                if ep.src == eq.src && fan(ep.src, 1, 1) {
                    continue;
                }
                if ep.src == eq.dst && fan(ep.src, 1, 2) {
                    continue;
                }
                if ep.dst == eq.src && fan(ep.dst, 2, 1) {
                    continue;
                }
                if ep.dst == eq.dst && fan(ep.dst, 2, 2) {
                    continue;
                }
                total += 1;
            }
        }
    }
    total
}
