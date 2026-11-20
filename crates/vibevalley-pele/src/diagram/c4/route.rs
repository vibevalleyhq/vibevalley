use std::collections::HashMap;

use crate::svg::builder::num;
use crate::svg::shapes::ShapeKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum C4Form {
    Rect,
    Person,
    Cyl,
    HCyl,
}

impl C4Form {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Rect => "rect",
            Self::Person => "person",
            Self::Cyl => "cyl",
            Self::HCyl => "h-cyl",
        }
    }

    pub const fn shape_kind(self) -> ShapeKind {
        match self {
            Self::Rect => ShapeKind::Rect,
            Self::Person => ShapeKind::Person,
            Self::Cyl => ShapeKind::Cyl,
            Self::HCyl => ShapeKind::HCyl,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct C4Box {
    pub id: usize,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub form: C4Form,
}

#[derive(Debug, Clone)]
pub struct Route {
    pub d: String,
    pub sx: f64,
    pub sy: f64,
    pub sdx: f64,
    pub sdy: f64,
    pub ex: f64,
    pub ey: f64,
    pub edx: f64,
    pub edy: f64,
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    pub nx: f64,
    pub ny: f64,
    pub lean: f64,
    pub room: f64,
    pub points: Vec<f64>,
}

const LOOP: f64 = 28.0;
pub const LANE: f64 = 20.0;
const LANE_STEP: f64 = 7.0;
const CORNER: f64 = 8.0;
const LEAN: f64 = 30.0;
pub const NARROW: f64 = 88.0;
const WIDE: f64 = 160.0;
pub const LABEL_PAD: f64 = 8.0;
pub const HEAD: f64 = 26.0;
const NEAR: f64 = 6.0;
const FRAME_NEAR: f64 = 3.0;
const PORT_STEP: f64 = 12.0;

pub fn cyl_ry(w: f64) -> f64 {
    12.0f64.min(6.0f64.max(w / 14.0))
}

pub fn queue_rx(h: f64) -> f64 {
    12.0f64.min(h / 4.0)
}

#[inline]
fn sign_zero(v: f64) -> f64 {
    if v > 0.0 {
        1.0
    } else if v < 0.0 {
        -1.0
    } else {
        0.0
    }
}

fn hit_rect([x0, y0, x1, y1]: [f64; 4], [px, py, dx, dy]: [f64; 4]) -> f64 {
    let mut enter = 0.0f64;
    let mut leave = 1.0f64;
    if dx == 0.0 {
        if px < x0 || px > x1 {
            return f64::INFINITY;
        }
    } else {
        let a = (x0 - px) / dx;
        let b = (x1 - px) / dx;
        enter = enter.max(a.min(b));
        leave = leave.min(a.max(b));
    }
    if dy == 0.0 {
        if py < y0 || py > y1 {
            return f64::INFINITY;
        }
    } else {
        let a = (y0 - py) / dy;
        let b = (y1 - py) / dy;
        enter = enter.max(a.min(b));
        leave = leave.min(a.max(b));
    }
    if enter <= leave { enter } else { f64::INFINITY }
}

fn hit_ellipse([cx, cy, rx, ry]: [f64; 4], [px, py, dx, dy]: [f64; 4]) -> f64 {
    let ux = dx / rx;
    let uy = dy / ry;
    let vx = (px - cx) / rx;
    let vy = (py - cy) / ry;
    let a = ux * ux + uy * uy;
    let b = 2.0 * (ux * vx + uy * vy);
    let c = vx * vx + vy * vy - 1.0;
    let disc = b * b - 4.0 * a * c;
    if a == 0.0 || disc < 0.0 {
        return f64::INFINITY;
    }
    let t = (-b - disc.sqrt()) / (2.0 * a);
    if (0.0..=1.0).contains(&t) {
        t
    } else if c <= 0.0 {
        0.0
    } else {
        f64::INFINITY
    }
}

fn hit(b: &C4Box, px: f64, py: f64, qx: f64, qy: f64) -> f64 {
    let ray = [px, py, qx - px, qy - py];
    match b.form {
        C4Form::Person => hit_rect([b.x, b.y + HEAD, b.x + b.w, b.y + b.h], ray).min(hit_ellipse([b.x + b.w / 2.0, b.y + 14.0, 13.0, 13.0], ray)),
        C4Form::Cyl => {
            let ry = cyl_ry(b.w);
            hit_rect([b.x, b.y + ry, b.x + b.w, b.y + b.h - ry], ray)
                .min(hit_ellipse([b.x + b.w / 2.0, b.y + ry, b.w / 2.0, ry], ray))
                .min(hit_ellipse([b.x + b.w / 2.0, b.y + b.h - ry, b.w / 2.0, ry], ray))
        }
        C4Form::HCyl => {
            let rx = queue_rx(b.h);
            hit_rect([b.x + rx, b.y, b.x + b.w - rx, b.y + b.h], ray)
                .min(hit_ellipse([b.x + rx, b.y + b.h / 2.0, rx, b.h / 2.0], ray))
                .min(hit_ellipse([b.x + b.w - rx, b.y + b.h / 2.0, rx, b.h / 2.0], ray))
        }
        C4Form::Rect => hit_rect([b.x, b.y, b.x + b.w, b.y + b.h], ray),
    }
}

pub fn crosses(points: &[f64], x0: f64, y0: f64, x1: f64, y1: f64) -> bool {
    let mut i = 2;
    while i + 1 < points.len() {
        let px = points[i - 2];
        let py = points[i - 1];
        if hit_rect([x0, y0, x1, y1], [px, py, points[i] - px, points[i + 1] - py]) <= 1.0 {
            return true;
        }
        i += 2;
    }
    false
}

fn contains(outer: &C4Box, inner: &C4Box) -> bool {
    outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.w >= inner.x + inner.w && outer.y + outer.h >= inner.y + inner.h
}

fn connect(a: &C4Box, b: &C4Box, shift: f64) -> [f64; 4] {
    let ax = a.x + a.w / 2.0;
    let ay = a.y + a.h / 2.0;
    let bx = b.x + b.w / 2.0;
    let by = b.y + b.h / 2.0;
    let down = contains(a, b);
    if down || contains(b, a) {
        let (outer, inner) = if down { (a, b) } else { (b, a) };
        let ix = inner.x + inner.w / 2.0;
        let iy = inner.y + inner.h / 2.0;
        let left = inner.x - outer.x;
        let right = outer.x + outer.w - inner.x - inner.w;
        let top = inner.y - outer.y;
        let bottom = outer.y + outer.h - inner.y - inner.h;
        let least = left.min(right).min(top).min(bottom);
        let ox = if least == left {
            outer.x
        } else if least == right {
            outer.x + outer.w
        } else {
            ix
        };
        let oy = if least == left || least == right {
            iy
        } else if least == bottom {
            outer.y + outer.h
        } else {
            outer.y
        };
        let t = hit(inner, ox, oy, ix, iy).min(1.0);
        let mx = ox + (ix - ox) * t;
        let my = oy + (iy - oy) * t;
        return if down { [ox, oy, mx, my] } else { [mx, my, ox, oy] };
    }

    let mut px = ax;
    let mut py = ay;
    let mut qx = bx;
    let mut qy = by;
    let x0 = a.x.max(b.x);
    let x1 = (a.x + a.w).min(b.x + b.w);
    let y0 = a.y.max(b.y);
    let y1 = (a.y + a.h).min(b.y + b.h);
    if x0 < x1 {
        let mid = (x0 + x1) / 2.0;
        px = mid;
        qx = mid;
    } else if y0 < y1 {
        let mid = (y0 + y1) / 2.0;
        py = mid;
        qy = mid;
    }
    let raw_len = (qx - px).hypot(qy - py);
    let len = if raw_len == 0.0 { 1.0 } else { raw_len };
    let nx = (-(qy - py) / len) * shift;
    let ny = ((qx - px) / len) * shift;
    let mut ta = hit(a, qx + nx, qy + ny, px + nx, py + ny);
    let mut tb = hit(b, px + nx, py + ny, qx + nx, qy + ny);
    if ta <= 1.0 && tb <= 1.0 {
        px += nx;
        py += ny;
        qx += nx;
        qy += ny;
    } else {
        px = ax;
        py = ay;
        qx = bx;
        qy = by;
        ta = hit(a, qx, qy, px, py).min(1.0);
        tb = hit(b, px, py, qx, qy).min(1.0);
    }
    [qx + (px - qx) * ta, qy + (py - qy) * ta, px + (qx - px) * tb, py + (qy - py) * tb]
}

#[derive(Default)]
pub struct Lanes {
    upright: Vec<f64>,
    level: Vec<f64>,
    frames_v: Vec<f64>,
    frames_h: Vec<f64>,
    taken: HashMap<usize, Vec<(u8, f64)>>,
    pub squeezed: usize,
}

impl Lanes {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn free(&self, upright: bool, at: f64, a0: f64, a1: f64) -> bool {
        let lo = a0.min(a1);
        let hi = a0.max(a1);
        let near = |list: &[f64], gap: f64| -> bool {
            let mut i = 0;
            while i + 2 < list.len() {
                if (list[i] - at).abs() < gap && list[i + 1] < hi && list[i + 2] > lo {
                    return true;
                }
                i += 3;
            }
            false
        };
        !near(if upright { &self.upright } else { &self.level }, NEAR) && !near(if upright { &self.frames_v } else { &self.frames_h }, FRAME_NEAR)
    }

    pub fn crossings(&self, points: &[f64]) -> usize {
        let mut count = 0;
        let mut i = 2;
        while i + 1 < points.len() {
            let upright = points[i] == points[i - 2];
            let at = if upright { points[i] } else { points[i + 1] };
            let (a, b) = if upright {
                (points[i - 1], points[i + 1])
            } else {
                (points[i - 2], points[i])
            };
            let lo = a.min(b);
            let hi = a.max(b);
            let list = if upright { &self.level } else { &self.upright };
            let mut j = 0;
            while j + 2 < list.len() {
                if list[j] > lo && list[j] < hi && list[j + 1] < at && list[j + 2] > at {
                    count += 1;
                }
                j += 3;
            }
            i += 2;
        }
        count
    }

    pub fn frame(&mut self, b: &C4Box) {
        self.frames_v.extend_from_slice(&[b.x, b.y, b.y + b.h, b.x + b.w, b.y, b.y + b.h]);
        self.frames_h.extend_from_slice(&[b.y, b.x, b.x + b.w, b.y + b.h, b.x, b.x + b.w]);
    }

    pub fn take(&mut self, points: &[f64]) {
        let mut i = 2;
        while i + 1 < points.len() {
            if points[i] == points[i - 2] {
                self.upright
                    .extend_from_slice(&[points[i], points[i - 1].min(points[i + 1]), points[i - 1].max(points[i + 1])]);
            } else if points[i + 1] == points[i - 1] {
                self.level
                    .extend_from_slice(&[points[i + 1], points[i - 2].min(points[i]), points[i - 2].max(points[i])]);
            }
            i += 2;
        }
    }

    pub fn ports(&self, box_id: usize, side: u8, want: f64, lo: f64, hi: f64) -> Vec<f64> {
        let used = self.taken.get(&box_id).map(Vec::as_slice).unwrap_or(&[]);
        let mut out = Vec::new();
        for k in 0..9usize {
            if out.len() >= 4 {
                break;
            }
            let dir = if k & 1 != 0 { 1.0 } else { -1.0 };
            let at = want + dir * (k.div_ceil(2) as f64) * PORT_STEP;
            if at < lo || at > hi {
                continue;
            }
            let clear = used.iter().all(|&(s, pos)| s != side || (pos - at).abs() >= PORT_STEP);
            if clear {
                out.push(at);
            }
        }
        if out.is_empty() { vec![want] } else { out }
    }

    pub fn claim(&mut self, box_id: usize, side: u8, at: f64) {
        self.taken.entry(box_id).or_default().push((side, at));
    }
}

fn build_path(points: &[f64], start_trim: f64, end_trim: f64) -> String {
    let n = points.len();
    let ux = sign_zero(points[2] - points[0]);
    let uy = sign_zero(points[3] - points[1]);
    let mut d = format!("M{},{}", num(points[0] + ux * start_trim), num(points[1] + uy * start_trim));
    let mut i = 2;
    while i < n - 2 {
        let x = points[i];
        let y = points[i + 1];
        let ix = sign_zero(x - points[i - 2]);
        let iy = sign_zero(y - points[i - 1]);
        let ox = sign_zero(points[i + 2] - x);
        let oy = sign_zero(points[i + 3] - y);
        let r = CORNER
            .min((x - points[i - 2] + y - points[i - 1]).abs() / 2.0)
            .min((points[i + 2] - x + points[i + 3] - y).abs() / 2.0);
        if ix != 0.0 {
            d.push('H');
            d.push_str(&num(x - ix * r));
        } else {
            d.push('V');
            d.push_str(&num(y - iy * r));
        }
        d.push_str(&format!("Q{},{} {},{}", num(x), num(y), num(x + ox * r), num(y + oy * r)));
        i += 2;
    }
    let lx = sign_zero(points[n - 2] - points[n - 4]);
    let ly = sign_zero(points[n - 1] - points[n - 3]);
    if lx != 0.0 {
        d.push('H');
        d.push_str(&num(points[n - 2] - lx * end_trim));
    } else {
        d.push('V');
        d.push_str(&num(points[n - 1] - ly * end_trim));
    }
    d
}

fn clear_of(points: &[f64], others: &[C4Box], a_id: usize, b_id: usize) -> bool {
    for other in others {
        if other.id != a_id && other.id != b_id && crosses(points, other.x, other.y, other.x + other.w, other.y + other.h) {
            return false;
        }
    }
    true
}

fn bent(points: Vec<f64>, along: usize, trims: (f64, f64), normal: (f64, f64), lean: f64, room: f64) -> Route {
    let n = points.len();
    let d = build_path(&points, trims.0, trims.1);
    Route {
        d,
        sx: points[0],
        sy: points[1],
        sdx: -sign_zero(points[2] - points[0]),
        sdy: -sign_zero(points[3] - points[1]),
        ex: points[n - 2],
        ey: points[n - 1],
        edx: sign_zero(points[n - 2] - points[n - 4]),
        edy: sign_zero(points[n - 1] - points[n - 3]),
        x0: points[along],
        y0: points[along + 1],
        x1: points[along + 2],
        y1: points[along + 3],
        nx: normal.0,
        ny: normal.1,
        lean,
        room,
        points,
    }
}

fn across(lo: f64, hi: f64) -> Vec<f64> {
    let mut out = Vec::new();
    let mid = (lo + hi) / 2.0;
    let step = LANE_STEP.max((hi - lo) / 4.0);
    for k in 0..9usize {
        let dir = if k & 1 != 0 { 1.0 } else { -1.0 };
        let at = mid + dir * (k.div_ceil(2) as f64) * step;
        if at >= lo + NEAR && at <= hi - NEAR {
            out.push(at);
        }
    }
    out
}

fn elbow(a: &C4Box, b: &C4Box, others: &[C4Box], lanes: &mut Lanes, start_trim: f64, end_trim: f64) -> Option<Route> {
    let ax = a.x + a.w / 2.0;
    let ay = a.y + a.h / 2.0;
    let bx = b.x + b.w / 2.0;
    let by = b.y + b.h / 2.0;
    struct Best {
        points: Vec<f64>,
        cost: f64,
        upright: bool,
        sides: [u8; 2],
    }
    let mut best: Option<Best> = None;
    let consider = |best: &mut Option<Best>, points: Vec<f64>, upright: bool, sides: [u8; 2]| -> bool {
        if !clear_of(&points, others, a.id, b.id) {
            return false;
        }
        let mut i = 2;
        while i + 1 < points.len() {
            let up = points[i] == points[i - 2];
            let at = if up { points[i] } else { points[i + 1] };
            let (p0, p1) = if up { (points[i - 1], points[i + 1]) } else { (points[i - 2], points[i]) };
            if !lanes.free(up, at, p0, p1) {
                return false;
            }
            i += 2;
        }
        let mut cost = lanes.crossings(&points) as f64 * 1e6;
        let mut i = 2;
        while i + 1 < points.len() {
            cost += (points[i] - points[i - 2]).abs() + (points[i + 1] - points[i - 1]).abs();
            i += 2;
        }
        if best.as_ref().is_none_or(|cur| cost < cur.cost) {
            *best = Some(Best { points, cost, upright, sides });
            true
        } else {
            false
        }
    };

    if a.x + a.w <= b.x || b.x + b.w <= a.x {
        let right = bx > ax;
        let down = sign_zero(by - ay);
        let sides = if right { [1, 0] } else { [0, 1] };
        let lanes_across = across(if right { a.x + a.w } else { b.x + b.w }, if right { b.x } else { a.x });
        let ports_a = lanes.ports(a.id, sides[0], ay + (down * a.h) / 4.0, a.y + 8.0, a.y + a.h - 8.0);
        let ports_b = lanes.ports(b.id, sides[1], by - (down * b.h) / 4.0, b.y + 8.0, b.y + b.h - 8.0);
        'search_h: for &y0 in &ports_a {
            for &y1 in &ports_b {
                for &lane in &lanes_across {
                    let x0 = lane + (ax - lane) * hit(a, lane, y0, ax, y0).min(1.0);
                    let x1 = lane + (bx - lane) * hit(b, lane, y1, bx, y1).min(1.0);
                    if consider(&mut best, vec![x0, y0, lane, y0, lane, y1, x1, y1], true, sides) {
                        break 'search_h;
                    }
                }
            }
        }
    }
    if a.y + a.h <= b.y || b.y + b.h <= a.y {
        let below = by > ay;
        let sideways = sign_zero(bx - ax);
        let sides = if below { [3, 2] } else { [2, 3] };
        let lanes_across = across(if below { a.y + a.h } else { b.y + b.h }, if below { b.y } else { a.y });
        let ports_a = lanes.ports(a.id, sides[0], ax + (sideways * a.w) / 4.0, a.x + 8.0, a.x + a.w - 8.0);
        let ports_b = lanes.ports(b.id, sides[1], bx - (sideways * b.w) / 4.0, b.x + 8.0, b.x + b.w - 8.0);
        'search_v: for &x0 in &ports_a {
            for &x1 in &ports_b {
                for &lane in &lanes_across {
                    let y0 = lane + (ay - lane) * hit(a, x0, lane, x0, ay).min(1.0);
                    let y1 = lane + (by - lane) * hit(b, x1, lane, x1, by).min(1.0);
                    if consider(&mut best, vec![x0, y0, x0, lane, x1, lane, x1, y1], false, sides) {
                        break 'search_v;
                    }
                }
            }
        }
    }

    let best = best?;
    lanes.take(&best.points);
    lanes.claim(a.id, best.sides[0], if best.upright { best.points[1] } else { best.points[0] });
    lanes.claim(b.id, best.sides[1], if best.upright { best.points[7] } else { best.points[6] });
    Some(bent(
        best.points,
        2,
        (start_trim, end_trim),
        (0.0, 0.0),
        0.0,
        if best.upright { NARROW } else { WIDE },
    ))
}

pub fn route(a: &C4Box, b: &C4Box, shift: f64, others: Option<&[C4Box]>, lanes: &mut Lanes, start_trim: f64, end_trim: f64) -> Route {
    if a.id == b.id {
        let spread = (a.h / 2.0 - 4.0).min(10.0);
        let len = LOOP.hypot(spread);
        let x = a.x + a.w;
        let cy = a.y + a.h / 2.0;
        let ux = LOOP / len;
        let uy = spread / len;
        return Route {
            d: format!(
                "M{},{}C{},{} {},{} {},{}",
                num(x + ux * start_trim),
                num(cy - spread - uy * start_trim),
                num(x + LOOP),
                num(cy - spread * 2.0),
                num(x + LOOP),
                num(cy + spread * 2.0),
                num(x + ux * end_trim),
                num(cy + spread + uy * end_trim),
            ),
            sx: x,
            sy: cy - spread,
            sdx: -ux,
            sdy: uy,
            ex: x,
            ey: cy + spread,
            edx: -ux,
            edy: -uy,
            x0: x + LOOP + 4.0,
            y0: cy,
            x1: x + LOOP + 4.0,
            y1: cy,
            nx: 1.0,
            ny: 0.0,
            lean: 0.0,
            room: 64.0,
            points: Vec::new(),
        };
    }

    let [sx, sy, ex, ey] = connect(a, b, shift);
    let upright = sx == ex;
    let mut blocked = false;
    if let Some(others) = others
        && !contains(a, b)
        && !contains(b, a)
    {
        for other in others {
            if other.id != a.id && other.id != b.id && hit_rect([other.x, other.y, other.x + other.w, other.y + other.h], [sx, sy, ex - sx, ey - sy]) <= 1.0 {
                blocked = true;
            }
        }
    }
    if let Some(others) = others
        && blocked
        && !upright
        && sy != ey
    {
        if let Some(around) = elbow(a, b, others, lanes, start_trim, end_trim) {
            return around;
        }
        lanes.squeezed += 1;
    }
    if let Some(others) = others
        && blocked
        && (upright || sy == ey)
    {
        let lane_on = |forward: bool| -> f64 {
            let mut lane = if forward { f64::NEG_INFINITY } else { f64::INFINITY };
            let mut widen = |bx: &C4Box| {
                let edge = if upright { bx.x } else { bx.y };
                lane = if forward {
                    lane.max(edge + if upright { bx.w } else { bx.h })
                } else {
                    lane.min(edge)
                };
            };
            widen(a);
            widen(b);
            for other in others {
                if other.id != a.id && other.id != b.id && hit_rect([other.x, other.y, other.x + other.w, other.y + other.h], [sx, sy, ex - sx, ey - sy]) <= 1.0
                {
                    widen(other);
                }
            }
            lane
        };
        let lo = if upright { a.y.min(b.y) } else { a.x.min(b.x) };
        let hi = if upright { (a.y + a.h).max(b.y + b.h) } else { (a.x + a.w).max(b.x + b.w) };
        let outside = |forward: bool, lane: f64| -> bool {
            for other in others {
                if other.id == a.id || other.id == b.id {
                    continue;
                }
                let near = if upright {
                    other.y < hi && other.y + other.h > lo
                } else {
                    other.x < hi && other.x + other.w > lo
                };
                let start = if upright { other.x } else { other.y };
                let end = start + if upright { other.w } else { other.h };
                if near && if forward { end > lane } else { start < lane } {
                    return false;
                }
            }
            true
        };
        let ax = a.x + a.w / 2.0;
        let ay = a.y + a.h / 2.0;
        let bx = b.x + b.w / 2.0;
        let by = b.y + b.h / 2.0;
        let towards = if upright { sign_zero(by - ay) } else { sign_zero(bx - ax) };

        struct Way {
            points: Vec<f64>,
            side: u8,
            p0: f64,
            p1: f64,
            step: usize,
        }
        let along = |forward: bool, lanes_ref: &Lanes| -> Way {
            let lane = lane_on(forward);
            let sign = if forward { 1.0 } else { -1.0 };
            let side = if upright {
                if forward { 1 } else { 0 }
            } else if forward {
                3
            } else {
                2
            };
            let p0 = if upright {
                lanes_ref.ports(a.id, side, ay + (towards * a.h) / 4.0, a.y + 8.0, a.y + a.h - 8.0)[0]
            } else {
                lanes_ref.ports(a.id, side, ax + (towards * a.w) / 4.0, a.x + 8.0, a.x + a.w - 8.0)[0]
            };
            let p1 = if upright {
                lanes_ref.ports(b.id, side, by - (towards * b.h) / 4.0, b.y + 8.0, b.y + b.h - 8.0)[0]
            } else {
                lanes_ref.ports(b.id, side, bx - (towards * b.w) / 4.0, b.x + 8.0, b.x + b.w - 8.0)[0]
            };
            let points_at = |at: f64| -> Vec<f64> {
                if upright {
                    let x0 = at + (ax - at) * hit(a, at, p0, ax, p0).min(1.0);
                    let x1 = at + (bx - at) * hit(b, at, p1, bx, p1).min(1.0);
                    vec![x0, p0, at, p0, at, p1, x1, p1]
                } else {
                    let y0 = at + (ay - at) * hit(a, p0, at, p0, ay).min(1.0);
                    let y1 = at + (by - at) * hit(b, p1, at, p1, by).min(1.0);
                    vec![p0, y0, p0, at, p1, at, p1, y1]
                }
            };
            let mut points = points_at(lane + sign * LANE);
            for k in 0..=4usize {
                let at = lane + sign * (LANE + k as f64 * LANE_STEP);
                let tried = points_at(at);
                if !clear_of(&tried, others, a.id, b.id) {
                    continue;
                }
                points = tried;
                if lanes_ref.free(upright, at, p0, p1) {
                    return Way { points, side, p0, p1, step: k };
                }
            }
            Way { points, side, p0, p1, step: 5 }
        };

        let natural = if upright { ey > sy } else { ex < sx };
        let out = outside(natural, lane_on(natural));
        let back = outside(!natural, lane_on(!natural));
        let first = along(natural, lanes);
        let other = if out == back { Some(along(!natural, lanes)) } else { None };
        let cost = |way: &Way| lanes.crossings(&way.points) * 8 + way.step;
        let forward = if (back && !out) || other.as_ref().is_some_and(|o| cost(o) < cost(&first)) {
            !natural
        } else {
            natural
        };
        let chosen = if forward == natural {
            first
        } else {
            other.unwrap_or_else(|| along(!natural, lanes))
        };
        let sign = if forward { 1.0 } else { -1.0 };
        if chosen.step > 4 {
            lanes.squeezed += 1;
        }
        lanes.take(&chosen.points);
        lanes.claim(a.id, chosen.side, chosen.p0);
        lanes.claim(b.id, chosen.side, chosen.p1);
        return if upright {
            bent(chosen.points, 2, (start_trim, end_trim), (sign, 0.0), LEAN, NARROW)
        } else {
            bent(chosen.points, 2, (start_trim, end_trim), (0.0, 0.0), 0.0, WIDE)
        };
    }

    let raw_len = (ex - sx).hypot(ey - sy);
    let len = if raw_len == 0.0 { 1.0 } else { raw_len };
    let dx = (ex - sx) / len;
    let dy = (ey - sy) / len;
    if upright || sy == ey {
        lanes.take(&[sx, sy, ex, ey]);
    }
    Route {
        d: format!(
            "M{},{}L{},{}",
            num(sx + dx * start_trim),
            num(sy + dy * start_trim),
            num(ex - dx * end_trim),
            num(ey - dy * end_trim),
        ),
        sx,
        sy,
        sdx: -dx,
        sdy: -dy,
        ex,
        ey,
        edx: dx,
        edy: dy,
        x0: sx,
        y0: sy,
        x1: ex,
        y1: ey,
        nx: if shift != 0.0 { -dy } else { 0.0 },
        ny: if shift != 0.0 { dx } else { 0.0 },
        lean: 0.0,
        room: if dx.abs() > dy.abs() { NARROW } else { WIDE },
        points: vec![sx, sy, ex, ey],
    }
}
