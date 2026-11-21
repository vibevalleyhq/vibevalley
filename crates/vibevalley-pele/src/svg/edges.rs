use std::collections::HashMap;
use std::f64::consts::PI;

use crate::IconResolver;
use crate::layout::layered::ease;
use crate::svg::builder::{esc_text, label_svg, num};
use crate::svg::ink::{extract_css_prop, ink};
use crate::svg::theme::SvgTheme;
use crate::text::label::Label;

pub const ARROW: f64 = 8.0;
const CORNER: f64 = 12.0;
const HANDLE: f64 = 0.62;
pub const LEAD: f64 = 6.0;
const CASE: f64 = 4.0;

#[derive(Debug, Clone)]
pub struct EdgePath {
    pub d: String,
    pub tokens: Option<Vec<f64>>,
    pub sx: f64,
    pub sy: f64,
    pub sdx: f64,
    pub sdy: f64,
    pub ex: f64,
    pub ey: f64,
    pub edx: f64,
    pub edy: f64,
}

#[derive(Debug, Default)]
pub struct SideReach {
    reach: HashMap<usize, f64>,
}

impl SideReach {
    pub fn add(&mut self, node: usize, side: i32, marker_type: &str) {
        if side < 0 {
            return;
        }
        let trim = marker_trim(marker_type);
        if trim > 0.0 {
            let key = node * 4 + side as usize;
            let wanted = trim + LEAD;
            let cur = self.reach.entry(key).or_insert(0.0);
            if wanted > *cur {
                *cur = wanted;
            }
        }
    }

    pub fn of(&self, node: usize, side: i32) -> f64 {
        if side < 0 {
            0.0
        } else {
            self.reach.get(&(node * 4 + side as usize)).copied().unwrap_or(0.0)
        }
    }
}

pub fn marker_trim(marker_type: &str) -> f64 {
    match marker_type {
        "arrow_point" => ARROW - 1.0,
        "arrow_circle" => ARROW,
        "arrow_cross" => 4.0,
        _ => 0.0,
    }
}

fn written(v: f64) -> f64 {
    let n = (v * 100.0).round();
    if n == 0.0 { 0.0 } else { n / 100.0 }
}

fn sign_or_one(v: f64) -> f64 {
    if v < 0.0 { -1.0 } else { 1.0 }
}

fn sign_zero(v: f64) -> f64 {
    if v > 0.0 {
        1.0
    } else if v < 0.0 {
        -1.0
    } else {
        0.0
    }
}

#[allow(clippy::too_many_arguments)]
pub fn route_path(route: &[f64], curve: Option<&str>, start_trim: f64, end_trim: f64, start_reach: Option<f64>, end_reach: Option<f64>) -> EdgePath {
    let start_reach = start_reach.unwrap_or(if start_trim > 0.0 { start_trim + LEAD } else { 0.0 });
    let end_reach = end_reach.unwrap_or(if end_trim > 0.0 { end_trim + LEAD } else { 0.0 });
    let linear = curve == Some("linear");
    let stepped = matches!(curve, Some("step" | "stepBefore" | "stepAfter"));
    let mut xs: Vec<f64> = Vec::new();
    let mut ys: Vec<f64> = Vec::new();
    let mut axes: Vec<f64> = Vec::new();
    let near = |ax: f64, ay: f64, bx: f64, by: f64| (ax - bx).abs() < 0.01 && (ay - by).abs() < 0.01;

    let mut idx = 0;
    while idx + 2 < route.len() {
        let x = route[idx];
        let y = route[idx + 1];
        let axis = route[idx + 2];
        if stepped && !xs.is_empty() {
            let last = xs.len() - 1;
            if (x - xs[last]).abs() >= 0.01 && (y - ys[last]).abs() >= 0.01 {
                let px = xs[last];
                let py = ys[last];
                let my = match curve {
                    Some("stepBefore") => py,
                    Some("stepAfter") => y,
                    _ => (py + y) / 2.0,
                };
                let mx = match curve {
                    Some("stepBefore") => px,
                    Some("stepAfter") => x,
                    _ => (px + x) / 2.0,
                };
                let turns = if axis == 0.0 { [px, my, x, my] } else { [mx, py, mx, y] };
                for k in (0..4).step_by(2) {
                    if near(turns[k], turns[k + 1], px, py) || near(turns[k], turns[k + 1], x, y) {
                        continue;
                    }
                    xs.push(turns[k]);
                    ys.push(turns[k + 1]);
                    axes.push(axis);
                }
            }
        }
        xs.push(x);
        ys.push(y);
        axes.push(axis);
        idx += 3;
    }

    let mut last = xs.len() - 1;
    let aligned = |xs: &[f64], ys: &[f64], i: usize| -> bool { (xs[i] - xs[i - 1]).abs() < 0.01 || (ys[i] - ys[i - 1]).abs() < 0.01 };
    let straight = |xs: &[f64], ys: &[f64], i: usize| -> bool { linear || aligned(xs, ys, i) };
    let unit = |xs: &[f64], ys: &[f64], i: usize, j: usize, axis: f64| -> (f64, f64) {
        if !straight(xs, ys, i.max(j)) {
            return if axis == 0.0 {
                (0.0, sign_or_one(ys[j] - ys[i]))
            } else {
                (sign_or_one(xs[j] - xs[i]), 0.0)
            };
        }
        let dx = xs[j] - xs[i];
        let dy = ys[j] - ys[i];
        let len = dx.hypot(dy);
        let len = if len == 0.0 { 1.0 } else { len };
        (dx / len, dy / len)
    };

    let (sdx, sdy) = unit(&xs, &ys, 0, 1, axes[1]);
    let (edx, edy) = unit(&xs, &ys, last - 1, last, axes[last]);
    let sx = xs[0];
    let sy = ys[0];
    let ex = xs[last];
    let ey = ys[last];
    xs[0] += sdx * start_trim;
    ys[0] += sdy * start_trim;
    xs[last] -= edx * end_trim;
    ys[last] -= edy * end_trim;

    let seg_len = |xs: &[f64], ys: &[f64], i: usize| -> f64 { (xs[i] - xs[i - 1]).abs() + (ys[i] - ys[i - 1]).abs() };
    let turns = |xs: &[f64], ys: &[f64], last: usize, i: usize| -> bool {
        !linear
            && i > 0
            && i < last
            && aligned(xs, ys, i)
            && aligned(xs, ys, i + 1)
            && seg_len(xs, ys, i) >= 0.01
            && seg_len(xs, ys, i + 1) >= 0.01
            && ((xs[i] - xs[i - 1]).abs() < 0.01) != ((xs[i + 1] - xs[i]).abs() < 0.01)
    };
    let along = |xs: &[f64], ys: &[f64], i: usize, ux: f64, uy: f64| -> f64 { (xs[i] - xs[i - 1]).abs() * ux.abs() + (ys[i] - ys[i - 1]).abs() * uy.abs() };
    let lead = |reach: f64, trim: f64, run: f64| -> f64 {
        let room = (reach - LEAD - trim).max(0.0).min(run / 4.0);
        room + (reach - trim - room).min((run - room) / 4.0)
    };

    let arrives = if end_reach > end_trim && (!straight(&xs, &ys, last) || turns(&xs, &ys, last, last - 1)) {
        lead(end_reach, end_trim, along(&xs, &ys, last, edx, edy))
    } else {
        0.0
    };
    let leaves = if start_reach > start_trim && (!straight(&xs, &ys, 1) || turns(&xs, &ys, last, 1)) {
        lead(start_reach, start_trim, along(&xs, &ys, 1, sdx, sdy))
    } else {
        0.0
    };
    if arrives >= 1.0 {
        let nx = xs[last] - edx * arrives;
        let ny = ys[last] - edy * arrives;
        let ax = axes[last];
        xs.insert(last, nx);
        ys.insert(last, ny);
        axes.insert(last, ax);
        last += 1;
    }
    if leaves >= 1.0 {
        let nx = xs[0] + sdx * leaves;
        let ny = ys[0] + sdy * leaves;
        let ax = axes[1];
        xs.insert(1, nx);
        ys.insert(1, ny);
        axes.insert(1, ax);
        last += 1;
    }

    let mut tokens: Vec<f64> = Vec::new();
    let tok = |tokens: &mut Vec<f64>, v: f64| -> String {
        tokens.push(written(v));
        num(v)
    };
    tokens.push(77.0);
    tokens.push(2.0);
    let mut d = format!("M{},{}", tok(&mut tokens, xs[0]), tok(&mut tokens, ys[0]));
    let mut at_x = xs[0];
    let mut at_y = ys[0];

    let line_to = |d: &mut String, tokens: &mut Vec<f64>, at_x: &mut f64, at_y: &mut f64, x: f64, y: f64| {
        if near(x, y, *at_x, *at_y) {
            return;
        }
        tokens.push(76.0);
        tokens.push(2.0);
        d.push('L');
        d.push_str(&tok(tokens, x));
        d.push(',');
        d.push_str(&tok(tokens, y));
        *at_x = x;
        *at_y = y;
    };

    for i in 1..=last {
        let x = xs[i];
        let y = ys[i];
        if !straight(&xs, &ys, i) {
            let down = axes[i] == 0.0;
            let along_d = if down { y - at_y } else { x - at_x };
            let k = along_d.abs() * ease(if down { x - at_x } else { y - at_y }, along_d);
            let ux = if down { 0.0 } else { sign_zero(along_d) * k };
            let uy = if down { sign_zero(along_d) * k } else { 0.0 };
            tokens.push(67.0);
            tokens.push(6.0);
            d.push_str(&format!(
                "C{},{} {},{} {},{}",
                tok(&mut tokens, at_x + ux),
                tok(&mut tokens, at_y + uy),
                tok(&mut tokens, x - ux),
                tok(&mut tokens, y - uy),
                tok(&mut tokens, x),
                tok(&mut tokens, y),
            ));
            at_x = x;
            at_y = y;
            continue;
        }
        if !turns(&xs, &ys, last, i) {
            if i < last && aligned(&xs, &ys, i) && aligned(&xs, &ys, i + 1) && (x - xs[i - 1]) * (xs[i + 1] - x) + (y - ys[i - 1]) * (ys[i + 1] - y) > 0.0 {
                continue;
            }
            line_to(&mut d, &mut tokens, &mut at_x, &mut at_y, x, y);
            continue;
        }
        let mut before = if turns(&xs, &ys, last, i - 1) {
            seg_len(&xs, &ys, i) / 2.0
        } else {
            seg_len(&xs, &ys, i)
        };
        let mut after = if turns(&xs, &ys, last, i + 1) {
            seg_len(&xs, &ys, i + 1) / 2.0
        } else {
            seg_len(&xs, &ys, i + 1)
        };
        if stepped {
            let c = CORNER.min(before).min(after);
            before = c;
            after = c;
        }
        let (ux, uy) = unit(&xs, &ys, i - 1, i, axes[i]);
        let (vx, vy) = unit(&xs, &ys, i, i + 1, axes[i + 1]);
        line_to(&mut d, &mut tokens, &mut at_x, &mut at_y, x - ux * before, y - uy * before);
        at_x = x + vx * after;
        at_y = y + vy * after;
        if stepped {
            tokens.push(81.0);
            tokens.push(4.0);
            d.push_str(&format!(
                "Q{},{} {},{}",
                tok(&mut tokens, x),
                tok(&mut tokens, y),
                tok(&mut tokens, at_x),
                tok(&mut tokens, at_y),
            ));
        } else {
            tokens.push(67.0);
            tokens.push(6.0);
            d.push_str(&format!(
                "C{},{} {},{} {},{}",
                tok(&mut tokens, x - ux * before * (1.0 - HANDLE)),
                tok(&mut tokens, y - uy * before * (1.0 - HANDLE)),
                tok(&mut tokens, x + vx * after * (1.0 - HANDLE)),
                tok(&mut tokens, y + vy * after * (1.0 - HANDLE)),
                tok(&mut tokens, at_x),
                tok(&mut tokens, at_y),
            ));
        }
    }

    EdgePath {
        d,
        tokens: Some(tokens),
        sx,
        sy,
        sdx: -sdx,
        sdy: -sdy,
        ex,
        ey,
        edx,
        edy,
    }
}

pub fn marker(marker_type: &str, x: f64, y: f64, dx: f64, dy: f64, color: &str, stroke: &str) -> String {
    let nx = -dy;
    let ny = dx;
    match marker_type {
        "arrow_point" => {
            let bx = x - dx * ARROW;
            let by = y - dy * ARROW;
            let half = ARROW * 0.42;
            format!(
                r#"<path class="pele-marker" d="M{},{}L{},{}L{},{}Z" fill="{color}" stroke="{stroke}"/>"#,
                num(x),
                num(y),
                num(bx + nx * half),
                num(by + ny * half),
                num(bx - nx * half),
                num(by - ny * half)
            )
        }
        "arrow_circle" => format!(
            r#"<circle class="pele-marker" cx="{}" cy="{}" r="3.5" fill="{color}" stroke="{stroke}"/>"#,
            num(x - dx * 4.0),
            num(y - dy * 4.0)
        ),
        "arrow_cross" => {
            let cx = x - dx * 4.0;
            let cy = y - dy * 4.0;
            let a = 3.5;
            let ux = (dx + nx) * a;
            let uy = (dy + ny) * a;
            let vx = (dx - nx) * a;
            let vy = (dy - ny) * a;
            format!(
                r#"<path class="pele-marker" d="M{},{}L{},{}M{},{}L{},{}"/>"#,
                num(cx - ux),
                num(cy - uy),
                num(cx + ux),
                num(cy + uy),
                num(cx - vx),
                num(cy - vy),
                num(cx + vx),
                num(cy + vy)
            )
        }
        _ => String::new(),
    }
}

fn tokenize_path(d: &str) -> Vec<f64> {
    let mut out = Vec::new();
    let bytes = d.as_bytes();
    let mut at: Option<usize> = None;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c.is_ascii_uppercase() && c != b'E' {
            at = Some(out.len() + 1);
            out.push(c as f64);
            out.push(0.0);
            i += 1;
        } else if c == b'-' || c == b'.' || c.is_ascii_digit() {
            let start = i;
            if c == b'-' {
                i += 1;
            }
            let mut dot = false;
            while i < bytes.len() {
                let k = bytes[i];
                if k.is_ascii_digit() {
                    i += 1;
                } else if k == b'.' && !dot {
                    dot = true;
                    i += 1;
                } else {
                    break;
                }
            }
            if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
                i += 1;
                if i < bytes.len() && matches!(bytes[i], b'+' | b'-') {
                    i += 1;
                }
                while i < bytes.len() && bytes[i].is_ascii_digit() {
                    i += 1;
                }
            }
            if let Some(count_idx) = at
                && let Ok(v) = d[start..i].parse::<f64>()
            {
                out.push(v);
                out[count_idx] += 1.0;
            }
        } else {
            i += 1;
        }
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn sample_arc(out: &mut Vec<f64>, x1: f64, y1: f64, mut rx: f64, mut ry: f64, large: f64, sweep: f64, x2: f64, y2: f64) {
    let hx = (x1 - x2) / 2.0;
    let hy = (y1 - y2) / 2.0;
    if rx == 0.0 || ry == 0.0 || (hx == 0.0 && hy == 0.0) {
        out.push(x2);
        out.push(y2);
        return;
    }
    let scale = 1.0f64.max(((hx * hx) / (rx * rx) + (hy * hy) / (ry * ry)).sqrt());
    rx *= scale;
    ry *= scale;
    let num_k = rx * rx * ry * ry - rx * rx * hy * hy - ry * ry * hx * hx;
    let den_k = rx * rx * hy * hy + ry * ry * hx * hx;
    let k = (if large == sweep { -1.0 } else { 1.0 }) * (num_k / den_k).max(0.0).sqrt();
    let cx = (k * rx * hy) / ry + (x1 + x2) / 2.0;
    let cy = (-k * ry * hx) / rx + (y1 + y2) / 2.0;
    let from = ((y1 - cy) / ry).atan2((x1 - cx) / rx);
    let mut turn = ((y2 - cy) / ry).atan2((x2 - cx) / rx) - from;
    if sweep != 0.0 && turn < 0.0 {
        turn += 2.0 * PI;
    } else if sweep == 0.0 && turn > 0.0 {
        turn -= 2.0 * PI;
    }
    for i in 1..=8 {
        let ang = from + (turn * i as f64) / 8.0;
        out.push(cx + rx * ang.cos());
        out.push(cy + ry * ang.sin());
    }
}

fn sample_tokens(tokens: &[f64]) -> Vec<f64> {
    let mut out = Vec::new();
    let mut x = 0.0;
    let mut y = 0.0;
    let mut i = 0;
    while i + 1 < tokens.len() {
        let cmd = tokens[i] as u8;
        let count = tokens[i + 1] as usize;
        let s = i + 2;
        let e = (s + count).min(tokens.len());
        i = e;
        if cmd == b'H' || cmd == b'V' {
            for &val in &tokens[s..e] {
                if cmd == b'H' {
                    x = val;
                } else {
                    y = val;
                }
                out.push(x);
                out.push(y);
            }
        } else if cmd == b'C' || cmd == b'Q' {
            let cubic = cmd == b'C';
            let step = if cubic { 6 } else { 4 };
            let mut k = s;
            while k + step <= e {
                let x1 = tokens[k];
                let y1 = tokens[k + 1];
                let x2 = tokens[k + 2];
                let y2 = tokens[k + 3];
                let x3 = if cubic { tokens[k + 4] } else { x2 };
                let y3 = if cubic { tokens[k + 5] } else { y2 };
                for step_i in 1..=8 {
                    let t = step_i as f64 * 0.125;
                    let mut ax = x + (x1 - x) * t;
                    let mut ay = y + (y1 - y) * t;
                    let mut bx = x1 + (x2 - x1) * t;
                    let mut by = y1 + (y2 - y1) * t;
                    if cubic {
                        let cx = x2 + (x3 - x2) * t;
                        let cy = y2 + (y3 - y2) * t;
                        ax += (bx - ax) * t;
                        ay += (by - ay) * t;
                        bx += (cx - bx) * t;
                        by += (cy - by) * t;
                    }
                    out.push(ax + (bx - ax) * t);
                    out.push(ay + (by - ay) * t);
                }
                x = x3;
                y = y3;
                k += step;
            }
        } else if cmd == b'A' {
            let mut k = s;
            while k + 7 <= e {
                sample_arc(
                    &mut out,
                    x,
                    y,
                    tokens[k],
                    tokens[k + 1],
                    tokens[k + 3],
                    tokens[k + 4],
                    tokens[k + 5],
                    tokens[k + 6],
                );
                x = tokens[k + 5];
                y = tokens[k + 6];
                k += 7;
            }
        } else {
            let mut k = s;
            while k + 2 <= e {
                if cmd == b'M' && k == s && !out.is_empty() {
                    out.push(f64::NAN);
                    out.push(f64::NAN);
                }
                x = tokens[k];
                y = tokens[k + 1];
                out.push(x);
                out.push(y);
                k += 2;
            }
        }
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn clips(x: f64, y: f64, dx: f64, dy: f64, l: f64, t: f64, r: f64, b: f64) -> bool {
    let mut lo = 0.0f64;
    let mut hi = 1.0f64;
    let sides = [(-dx, x - l), (dx, r - x), (-dy, y - t), (dy, b - y)];
    for (p, q) in sides {
        if p == 0.0 {
            if q < 0.0 {
                hi = -1.0;
            }
        } else if p < 0.0 {
            lo = lo.max(q / p);
        } else {
            hi = hi.min(q / p);
        }
    }
    lo < hi
}

fn enters(points: &[f64], l: f64, t: f64, r: f64, b: f64) -> bool {
    let mut k = 0;
    while k + 3 < points.len() {
        let x = points[k];
        let y = points[k + 1];
        let x2 = points[k + 2];
        let y2 = points[k + 3];
        k += 2;
        if (x < l && x2 < l) || (x > r && x2 > r) || (y < t && y2 < t) || (y > b && y2 > b) {
            continue;
        }
        if clips(x, y, x2 - x, y2 - y, l, t, r, b) {
            return true;
        }
    }
    false
}

#[derive(Debug, Clone, PartialEq)]
pub struct Fill {
    pub bounds: [f64; 4],
    pub shape: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FillRelation<'a> {
    Outside,
    CrossesBorder,
    Inside(&'a Fill),
}

pub fn fill_under<'a>(d: &str, tips: &[f64], fills: &'a [Fill], tokens: Option<&[f64]>) -> FillRelation<'a> {
    if fills.is_empty() {
        return FillRelation::Outside;
    }
    let owned_tokens;
    let pts = match tokens {
        Some(t) => sample_tokens(t),
        None => {
            owned_tokens = tokenize_path(d);
            sample_tokens(&owned_tokens)
        }
    };
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for &[x, y] in pts.as_chunks::<2>().0.iter().chain(tips.as_chunks::<2>().0) {
        if x < min_x {
            min_x = x;
        }
        if x > max_x {
            max_x = x;
        }
        if y < min_y {
            min_y = y;
        }
        if y > max_y {
            max_y = y;
        }
    }
    let mut holder: Option<&'a Fill> = None;
    let mut least = f64::INFINITY;
    for fill in fills {
        let [l, t, r, b] = fill.bounds;
        if max_x < l + 0.5 || min_x > r - 0.5 || max_y < t + 0.5 || min_y > b - 0.5 {
            continue;
        }
        let mut touched = enters(&pts, l + 0.5, t + 0.5, r - 0.5, b - 0.5);
        if !touched {
            for &[tx, ty] in tips.as_chunks::<2>().0 {
                if tx > l + 0.5 && tx < r - 0.5 && ty > t + 0.5 && ty < b - 0.5 {
                    touched = true;
                    break;
                }
            }
        }
        if !touched {
            continue;
        }
        if min_x < l || max_x > r || min_y < t || max_y > b {
            return FillRelation::CrossesBorder;
        }
        let area = (r - l) * (b - t);
        if area < least {
            least = area;
            holder = Some(fill);
        }
    }
    match holder {
        Some(f) => FillRelation::Inside(f),
        None => FillRelation::Outside,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OverFill {
    None,
    Casing,
    Ink(String),
}

pub fn over_fills(d: &str, tips: &[f64], fills: &[Fill], line: &str, tokens: Option<&[f64]>, theme: &SvgTheme) -> OverFill {
    match fill_under(d, tips, fills, tokens) {
        FillRelation::Outside => OverFill::None,
        FillRelation::CrossesBorder => OverFill::Casing,
        FillRelation::Inside(fill) => {
            if extract_css_prop(line, "stroke").is_some() {
                return OverFill::Casing;
            }
            match ink(&fill.shape, "", theme) {
                Some(color) => OverFill::Ink(color.to_string()),
                None => OverFill::Casing,
            }
        }
    }
}

pub fn casing(d: &str, markers: &str, line: &str, thick: bool) -> String {
    let decl = |prop: &str| -> Option<&str> {
        if line.contains(prop) {
            extract_css_prop(line, prop).map(str::trim)
        } else {
            None
        }
    };
    let stroke = decl("stroke");
    if matches!(stroke, Some("none" | "transparent")) {
        return String::new();
    }
    let width = if thick { Some("2.5") } else { decl("stroke-width") };
    let mut attrs = String::new();
    let mut style = String::new();
    if let Some(w) = width {
        let stripped = w.strip_suffix("px").unwrap_or(w);
        if !stripped.is_empty()
            && stripped.bytes().all(|b| b.is_ascii_digit() || b == b'.')
            && let Ok(parsed) = stripped.parse::<f64>()
        {
            if (parsed - 1.0).abs() > f64::EPSILON {
                attrs = format!(r#" stroke-width="{}""#, num(parsed + CASE));
            }
        } else {
            style.push_str(&format!("stroke-width:calc({w} + {}px);", num(CASE)));
        }
    }
    for prop in ["opacity", "stroke-opacity"] {
        if let Some(val) = decl(prop) {
            style.push_str(&format!("{prop}:{val};"));
        }
    }
    let body = format!(r#"<path d="{d}"/>{}"#, markers.replace(r#" class="pele-marker""#, ""));
    if !attrs.is_empty() || !style.is_empty() {
        let st = if style.is_empty() { String::new() } else { format!(r#" style="{style}""#) };
        format!("<g{attrs}{st}>{body}</g>")
    } else {
        body
    }
}

pub fn edge_casing(path: &EdgePath, start_type: &str, end_type: &str, line: &str, thick: bool, theme: &SvgTheme) -> String {
    let bg = theme.bg();
    let markers = format!(
        "{}{}",
        marker(start_type, path.sx, path.sy, path.sdx, path.sdy, bg, bg),
        marker(end_type, path.ex, path.ey, path.edx, path.edy, bg, bg)
    );
    casing(&path.d, &markers, line, thick)
}

pub fn casings_svg(casings: &str, theme: &SvgTheme) -> String {
    if casings.is_empty() {
        String::new()
    } else {
        format!(
            r#"<g class="pele-casings" fill="none" stroke="{}" stroke-width="{}" stroke-linecap="round" stroke-linejoin="round" pointer-events="none">{casings}</g>"#,
            theme.bg(),
            num(1.0 + CASE)
        )
    }
}

#[allow(clippy::too_many_arguments)]
pub fn edge_label_svg(id: &str, label: &Label, x: f64, y: f64, attrs: &str, theme: &SvgTheme, icons: Option<&IconResolver<'_>>) -> String {
    let w = label.width + 8.0;
    let h = label.height;
    format!(
        r#"<g class="pele-edge-label" data-id="{}"><rect x="{}" y="{}" width="{}" height="{}" rx="3" fill="{}"/>{}</g>"#,
        esc_text(id),
        num(x - w / 2.0),
        num(y - h / 2.0),
        num(w),
        num(h),
        theme.bg(),
        label_svg(label, x, y, attrs, theme, icons)
    )
}

#[allow(clippy::too_many_arguments)]
pub fn loop_path(
    cx: f64,
    cy: f64,
    w: f64,
    h: f64,
    k: usize,
    sideways: bool,
    base: f64,
    trim: f64,
    label_w: f64,
    label_h: f64,
    label_x: &mut f64,
    label_y: &mut f64,
) -> EdgePath {
    let half = (if sideways { w } else { h }) / 2.0;
    let spread = (half - 4.0).min(8.0 + k as f64 * 6.0);
    let reach = base + k as f64 * 8.0;
    let len = reach.hypot(spread);
    let len = if len == 0.0 { 1.0 } else { len };
    let at = |out: f64, along: f64| -> String {
        if sideways {
            format!("{},{}", num(cx + along), num(cy + h / 2.0 + out))
        } else {
            format!("{},{}", num(cx + w / 2.0 + out), num(cy + along))
        }
    };
    let tx = (reach / len) * trim;
    let ty = (spread / len) * trim;
    if sideways {
        *label_x = cx;
        *label_y = cy + h / 2.0 + reach + 4.0 + label_h / 2.0;
    } else {
        *label_x = cx + w / 2.0 + reach + 4.0 + label_w / 2.0;
        *label_y = cy;
    }
    EdgePath {
        d: format!(
            "M{}C{} {} {}",
            at(0.0, -spread),
            at(reach, -spread * 2.0),
            at(reach, spread * 2.0),
            at(tx, spread + ty)
        ),
        tokens: None,
        sx: if sideways { cx - spread } else { cx + w / 2.0 },
        sy: if sideways { cy + h / 2.0 } else { cy - spread },
        sdx: if sideways { 0.0 } else { -1.0 },
        sdy: if sideways { -1.0 } else { 0.0 },
        ex: if sideways { cx + spread } else { cx + w / 2.0 },
        ey: if sideways { cy + h / 2.0 } else { cy + spread },
        edx: if sideways { -spread / len } else { -reach / len },
        edy: if sideways { -reach / len } else { -spread / len },
    }
}
