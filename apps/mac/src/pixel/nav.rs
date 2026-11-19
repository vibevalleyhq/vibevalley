//! Grid A* with edge clearance and corner cutting, and a walker that follows
//! its routes: VibeValley's `@vibevalley/engine/nav` and `Walker`.

use std::cmp::Ordering;
use std::collections::BinaryHeap;

use super::level::{Point, pt};

const SQRT2: f32 = std::f32::consts::SQRT_2;

pub struct NavMap {
    cols: usize,
    rows: usize,
    cell: f32,
    free: Vec<bool>,
    weight: Vec<f32>,
}

#[derive(PartialEq)]
struct Open(f32, usize);
impl Eq for Open {}
impl Ord for Open {
    fn cmp(&self, o: &Self) -> Ordering {
        o.0.partial_cmp(&self.0).unwrap_or(Ordering::Equal).then(o.1.cmp(&self.1))
    }
}
impl PartialOrd for Open {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}

impl NavMap {
    pub fn new(w: f32, h: f32, cell: f32, clearance: f32, walkable: impl Fn(Point) -> bool) -> NavMap {
        let cols = (w / cell).ceil() as usize;
        let rows = (h / cell).ceil() as usize;
        let n = cols * rows;
        let centre = |i: usize| pt(((i % cols) as f32 + 0.5) * cell, ((i / cols) as f32 + 0.5) * cell);
        let free: Vec<bool> = (0..n).map(|i| walkable(centre(i))).collect();
        let mut far: Vec<f32> = free.iter().map(|&f| if f { 1e9 } else { 0.0 }).collect();
        let relax = |far: &mut Vec<f32>, i: usize, j: usize, d: f32| {
            let next = far[j] + d;
            if next < far[i] {
                far[i] = next;
            }
        };
        for r in 0..rows {
            for c in 0..cols {
                let i = r * cols + c;
                if c > 0 {
                    relax(&mut far, i, i - 1, 1.0);
                }
                if r > 0 {
                    relax(&mut far, i, i - cols, 1.0);
                    if c > 0 {
                        relax(&mut far, i, i - cols - 1, SQRT2);
                    }
                    if c < cols - 1 {
                        relax(&mut far, i, i - cols + 1, SQRT2);
                    }
                }
            }
        }
        for r in (0..rows).rev() {
            for c in (0..cols).rev() {
                let i = r * cols + c;
                if c < cols - 1 {
                    relax(&mut far, i, i + 1, 1.0);
                }
                if r < rows - 1 {
                    relax(&mut far, i, i + cols, 1.0);
                    if c < cols - 1 {
                        relax(&mut far, i, i + cols + 1, SQRT2);
                    }
                    if c > 0 {
                        relax(&mut far, i, i + cols - 1, SQRT2);
                    }
                }
            }
        }
        let room = clearance / cell;
        let weight = far.iter().map(|&f| 1.0 + if f < room { (room - f) / room } else { 0.0 }).collect();
        NavMap {
            cols,
            rows,
            cell,
            free,
            weight,
        }
    }

    fn centre(&self, i: usize) -> Point {
        pt(((i % self.cols) as f32 + 0.5) * self.cell, ((i / self.cols) as f32 + 0.5) * self.cell)
    }

    fn index(&self, p: Point) -> usize {
        let c = ((p.x / self.cell).floor() as i64).clamp(0, self.cols as i64 - 1) as usize;
        let r = ((p.y / self.cell).floor() as i64).clamp(0, self.rows as i64 - 1) as usize;
        r * self.cols + c
    }

    fn nearest_free(&self, i: usize) -> usize {
        if self.free[i] {
            return i;
        }
        let (c0, r0) = ((i % self.cols) as i64, (i / self.cols) as i64);
        for ring in 1..self.cols.max(self.rows) as i64 {
            let mut best = None;
            let mut best_d = i64::MAX;
            for r in r0 - ring..=r0 + ring {
                for c in c0 - ring..=c0 + ring {
                    if r < 0 || c < 0 || r >= self.rows as i64 || c >= self.cols as i64 {
                        continue;
                    }
                    if (r - r0).abs().max((c - c0).abs()) != ring {
                        continue;
                    }
                    let j = (r as usize) * self.cols + c as usize;
                    let d = (r - r0).pow(2) + (c - c0).pow(2);
                    if self.free[j] && d < best_d {
                        best = Some(j);
                        best_d = d;
                    }
                }
            }
            if let Some(j) = best {
                return j;
            }
        }
        i
    }

    fn search(&self, start: usize, goal: usize) -> Option<Vec<usize>> {
        let n = self.free.len();
        let cols = self.cols;
        let mut g = vec![f32::INFINITY; n];
        let mut came = vec![usize::MAX; n];
        let mut closed = vec![false; n];
        let mut heap = BinaryHeap::new();
        let (gc, gr) = ((goal % cols) as i64, (goal / cols) as i64);
        let h = |i: usize| {
            let dx = ((i % cols) as i64 - gc).abs() as f32;
            let dy = ((i / cols) as i64 - gr).abs() as f32;
            dx.max(dy) + (SQRT2 - 1.0) * dx.min(dy)
        };
        g[start] = 0.0;
        heap.push(Open(h(start), start));
        while let Some(Open(_, i)) = heap.pop() {
            if i == goal {
                let mut cells = vec![i];
                let mut k = came[i];
                while k != usize::MAX {
                    cells.push(k);
                    k = came[k];
                }
                cells.reverse();
                return Some(cells);
            }
            if closed[i] {
                continue;
            }
            closed[i] = true;
            let (c, r) = ((i % cols) as i64, (i / cols) as i64);
            for dr in -1..=1i64 {
                for dc in -1..=1i64 {
                    if dr == 0 && dc == 0 {
                        continue;
                    }
                    let (nc, nr) = (c + dc, r + dr);
                    if nc < 0 || nr < 0 || nc >= cols as i64 || nr >= self.rows as i64 {
                        continue;
                    }
                    let j = nr as usize * cols + nc as usize;
                    if !self.free[j] || closed[j] {
                        continue;
                    }
                    if dr != 0 && dc != 0 && (!self.free[r as usize * cols + nc as usize] || !self.free[nr as usize * cols + c as usize]) {
                        continue;
                    }
                    let step = if dr != 0 && dc != 0 { SQRT2 } else { 1.0 } * (self.weight[i] + self.weight[j]) * 0.5;
                    let tentative = g[i] + step;
                    if tentative < g[j] {
                        g[j] = tentative;
                        came[j] = i;
                        heap.push(Open(tentative + h(j), j));
                    }
                }
            }
        }
        None
    }

    fn line_cost(&self, a: Point, b: Point) -> f32 {
        let length = (b.x - a.x).hypot(b.y - a.y);
        let steps = ((length / (self.cell * 0.5)).ceil() as usize).max(1);
        let mut sum = 0.0;
        for s in 0..=steps {
            let k = s as f32 / steps as f32;
            let i = self.index(pt(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k));
            if !self.free[i] {
                return f32::INFINITY;
            }
            sum += self.weight[i];
        }
        (sum / (steps + 1) as f32) * (length / self.cell)
    }

    fn step_cost(&self, a: Point, b: Point) -> f32 {
        let c = self.line_cost(a, b);
        if c.is_finite() { c } else { (b.x - a.x).hypot(b.y - a.y) / self.cell }
    }

    /// From `from` to `to` (both kept as given), corners cut.
    pub fn route(&self, from: Point, to: Point) -> Vec<Point> {
        let start = self.nearest_free(self.index(from));
        let goal = self.nearest_free(self.index(to));
        let Some(cells) = self.search(start, goal) else { return vec![from, to] };
        let mut points: Vec<Point> = cells.iter().map(|&i| self.centre(i)).collect();
        points[0] = from;
        let last = points.len() - 1;
        points[last] = to;
        let mut spent = vec![0.0f32];
        for k in 1..points.len() {
            spent.push(spent[k - 1] + self.step_cost(points[k - 1], points[k]));
        }
        let mut kept = vec![points[0]];
        let mut at = 0;
        while at < points.len() - 1 {
            let mut next = at + 1;
            for k in (at + 2..points.len()).rev() {
                if self.line_cost(points[at], points[k]) <= (spent[k] - spent[at]) * 1.03 {
                    next = k;
                    break;
                }
            }
            kept.push(points[next]);
            at = next;
        }
        kept
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Facing {
    Up,
    Down,
    Left,
    Right,
}

pub struct Walker {
    pub x: f32,
    pub y: f32,
    pub facing: Facing,
    path: Vec<Point>,
    target: Point,
    speed: f32,
}

impl Walker {
    pub fn new(from: Point, speed: f32) -> Walker {
        Walker {
            x: from.x,
            y: from.y,
            facing: Facing::Down,
            path: Vec::new(),
            target: from,
            speed,
        }
    }

    pub fn walking(&self) -> bool {
        !self.path.is_empty()
    }

    pub fn go(&mut self, to: Point, nav: &NavMap) {
        if (to.x - self.target.x).abs() < 0.5 && (to.y - self.target.y).abs() < 0.5 {
            return;
        }
        self.target = to;
        self.path = nav.route(pt(self.x, self.y), to).split_off(1);
    }

    pub fn step(&mut self, dt: f32) {
        let mut left = self.speed * dt;
        while left > 0.0 {
            let Some(&next) = self.path.first() else { break };
            let (dx, dy) = (next.x - self.x, next.y - self.y);
            let d = dx.hypot(dy);
            if d > 0.01 {
                self.facing = if dx.abs() > dy.abs() {
                    if dx > 0.0 { Facing::Right } else { Facing::Left }
                } else if dy > 0.0 {
                    Facing::Down
                } else {
                    Facing::Up
                };
            }
            if d <= left {
                self.x = next.x;
                self.y = next.y;
                self.path.remove(0);
                left -= d;
            } else {
                self.x += dx / d * left;
                self.y += dy / d * left;
                left = 0.0;
            }
        }
    }
}

/// Which frame of a looping animation shows at `t` seconds.
pub fn frame_at(t: impl Into<f64>, frames: usize, fps: f32) -> usize {
    if frames == 0 {
        0
    } else {
        ((t.into() * f64::from(fps)).floor().max(0.0) as usize) % frames
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_around_a_wall() {
        // A wall at x in [40, 50) with a gap at the bottom.
        let nav = NavMap::new(100.0, 100.0, 2.0, 2.0, |p| !(p.x >= 40.0 && p.x < 50.0 && p.y < 80.0));
        let path = nav.route(pt(10.0, 10.0), pt(90.0, 10.0));
        assert_eq!(path.first(), Some(&pt(10.0, 10.0)));
        assert_eq!(path.last(), Some(&pt(90.0, 10.0)));
        assert!(path.iter().any(|p| p.y >= 80.0), "{path:?}");
        let mut w = Walker::new(pt(10.0, 10.0), 42.0);
        w.go(pt(90.0, 10.0), &nav);
        for _ in 0..400 {
            w.step(0.05);
        }
        assert!(!w.walking());
        assert_eq!((w.x, w.y), (90.0, 10.0));
    }
}
