use serde::{Deserialize, Serialize};

use crate::model::{Canvas, Edge, End, NodeBounds, NodeId, Side};

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    pub const ZERO: Point = Point { x: 0.0, y: 0.0 };

    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    pub fn distance(self, other: Point) -> f64 {
        self.distance_squared(other).sqrt()
    }

    pub fn distance_squared(self, other: Point) -> f64 {
        let dx = self.x - other.x;
        let dy = self.y - other.y;
        dx * dx + dy * dy
    }

    pub fn offset(self, delta: Vec2) -> Point {
        Point {
            x: self.x + delta.x,
            y: self.y + delta.y,
        }
    }
}

impl std::ops::Sub<Point> for Point {
    type Output = Vec2;

    fn sub(self, other: Point) -> Vec2 {
        Vec2 {
            x: self.x - other.x,
            y: self.y - other.y,
        }
    }
}

impl std::ops::Add<Vec2> for Point {
    type Output = Point;

    fn add(self, delta: Vec2) -> Point {
        self.offset(delta)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

impl Vec2 {
    pub const ZERO: Vec2 = Vec2 { x: 0.0, y: 0.0 };

    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    pub fn length(self) -> f64 {
        (self.x * self.x + self.y * self.y).sqrt()
    }

    pub fn normalized(self) -> Option<Vec2> {
        let len = self.length();
        if len <= 1e-9 {
            None
        } else {
            Some(Vec2 {
                x: self.x / len,
                y: self.y / len,
            })
        }
    }

    pub fn scale(self, factor: f64) -> Vec2 {
        Vec2 {
            x: self.x * factor,
            y: self.y * factor,
        }
    }

    pub fn negate(self) -> Vec2 {
        Vec2 { x: -self.x, y: -self.y }
    }

    pub fn perp(self) -> Vec2 {
        Vec2 { x: -self.y, y: self.x }
    }

    pub fn dot(self, other: Vec2) -> f64 {
        self.x * other.x + self.y * other.y
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

impl Size {
    pub const fn new(width: f64, height: f64) -> Self {
        Self { width, height }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self { x, y, width, height }
    }

    pub fn from_corners(a: Point, b: Point) -> Self {
        let min_x = a.x.min(b.x);
        let min_y = a.y.min(b.y);
        let max_x = a.x.max(b.x);
        let max_y = a.y.max(b.y);
        Self {
            x: min_x,
            y: min_y,
            width: max_x - min_x,
            height: max_y - min_y,
        }
    }

    pub fn right(self) -> f64 {
        self.x + self.width
    }

    pub fn bottom(self) -> f64 {
        self.y + self.height
    }

    pub fn center(self) -> Point {
        Point {
            x: self.x + self.width * 0.5,
            y: self.y + self.height * 0.5,
        }
    }

    pub fn contains_point(self, pt: Point) -> bool {
        pt.x >= self.x && pt.x <= self.right() && pt.y >= self.y && pt.y <= self.bottom()
    }

    pub fn contains_rect(self, other: Rect) -> bool {
        other.x >= self.x && other.y >= self.y && other.right() <= self.right() && other.bottom() <= self.bottom()
    }

    pub fn intersects(self, other: Rect) -> bool {
        self.x <= other.right() && self.right() >= other.x && self.y <= other.bottom() && self.bottom() >= other.y
    }

    pub fn union(self, other: Rect) -> Rect {
        let min_x = self.x.min(other.x);
        let min_y = self.y.min(other.y);
        let max_x = self.right().max(other.right());
        let max_y = self.bottom().max(other.bottom());
        Rect {
            x: min_x,
            y: min_y,
            width: max_x - min_x,
            height: max_y - min_y,
        }
    }

    pub fn expand(self, margin: f64) -> Rect {
        Rect {
            x: self.x - margin,
            y: self.y - margin,
            width: self.width + margin * 2.0,
            height: self.height + margin * 2.0,
        }
    }
}

/// Camera mapping between infinite world coordinates and screen pixels via
/// `screen = world * zoom + pan`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Viewport {
    pub pan: Vec2,
    pub zoom: f64,
    pub min_zoom: f64,
    pub max_zoom: f64,
}

impl Default for Viewport {
    fn default() -> Self {
        Self {
            pan: Vec2::ZERO,
            zoom: 1.0,
            min_zoom: 0.05,
            max_zoom: 5.0,
        }
    }
}

impl Viewport {
    pub fn new(pan: Vec2, zoom: f64) -> Self {
        let mut vp = Self::default();
        vp.pan = pan;
        vp.zoom = zoom.clamp(vp.min_zoom, vp.max_zoom);
        vp
    }

    pub fn with_zoom_limits(mut self, min_zoom: f64, max_zoom: f64) -> Self {
        let min_z = min_zoom.max(1e-4);
        let max_z = max_zoom.max(min_z);
        self.min_zoom = min_z;
        self.max_zoom = max_z;
        self.zoom = self.zoom.clamp(min_z, max_z);
        self
    }

    pub fn reset(&mut self) {
        self.pan = Vec2::ZERO;
        self.zoom = 1.0_f64.clamp(self.min_zoom, self.max_zoom);
    }

    pub fn world_to_screen(&self, world: Point) -> Point {
        Point {
            x: world.x * self.zoom + self.pan.x,
            y: world.y * self.zoom + self.pan.y,
        }
    }

    pub fn screen_to_world(&self, screen: Point) -> Point {
        Point {
            x: (screen.x - self.pan.x) / self.zoom,
            y: (screen.y - self.pan.y) / self.zoom,
        }
    }

    pub fn world_rect_to_screen(&self, rect: Rect) -> Rect {
        let origin = self.world_to_screen(Point::new(rect.x, rect.y));
        Rect {
            x: origin.x,
            y: origin.y,
            width: rect.width * self.zoom,
            height: rect.height * self.zoom,
        }
    }

    pub fn screen_rect_to_world(&self, rect: Rect) -> Rect {
        let origin = self.screen_to_world(Point::new(rect.x, rect.y));
        Rect {
            x: origin.x,
            y: origin.y,
            width: rect.width / self.zoom,
            height: rect.height / self.zoom,
        }
    }

    pub fn visible_world_rect(&self, viewport_size: Size) -> Rect {
        self.screen_rect_to_world(Rect::new(0.0, 0.0, viewport_size.width, viewport_size.height))
    }

    pub fn pan_by_screen(&mut self, delta: Vec2) {
        self.pan.x += delta.x;
        self.pan.y += delta.y;
    }

    pub fn pan_by_world(&mut self, delta: Vec2) {
        self.pan.x += delta.x * self.zoom;
        self.pan.y += delta.y * self.zoom;
    }

    /// Scales zoom around `screen_pivot`, keeping the world point under the cursor fixed.
    pub fn zoom_at(&mut self, screen_pivot: Point, factor: f64) {
        if !factor.is_finite() || factor <= 0.0 {
            return;
        }
        self.set_zoom_at(screen_pivot, self.zoom * factor);
    }

    pub fn set_zoom_at(&mut self, screen_pivot: Point, target_zoom: f64) {
        if !target_zoom.is_finite() || target_zoom <= 0.0 {
            return;
        }
        let world_pivot = self.screen_to_world(screen_pivot);
        let next_zoom = target_zoom.clamp(self.min_zoom, self.max_zoom);
        self.zoom = next_zoom;
        self.pan = Vec2 {
            x: screen_pivot.x - world_pivot.x * next_zoom,
            y: screen_pivot.y - world_pivot.y * next_zoom,
        };
    }

    pub fn fit_rect(&mut self, world_bounds: Rect, viewport_size: Size, padding: f64, max_fit_zoom: Option<f64>) {
        let avail_w = (viewport_size.width - padding * 2.0).max(1.0);
        let avail_h = (viewport_size.height - padding * 2.0).max(1.0);
        let scale_x = avail_w / world_bounds.width.max(1.0);
        let scale_y = avail_h / world_bounds.height.max(1.0);
        let raw_zoom = scale_x.min(scale_y);
        let capped = match max_fit_zoom {
            Some(cap) => raw_zoom.min(cap),
            None => raw_zoom,
        };
        self.zoom = capped.clamp(self.min_zoom, self.max_zoom);
        self.pan = Vec2 {
            x: (viewport_size.width - world_bounds.width * self.zoom) * 0.5 - world_bounds.x * self.zoom,
            y: (viewport_size.height - world_bounds.height * self.zoom) * 0.5 - world_bounds.y * self.zoom,
        };
    }

    pub fn fit_content(&mut self, canvas: &Canvas, viewport_size: Size, padding: f64, max_fit_zoom: Option<f64>) -> bool {
        let Some(bounds) = canvas.content_bounds() else {
            self.zoom = 1.0_f64.clamp(self.min_zoom, self.max_zoom);
            self.pan = Vec2 {
                x: viewport_size.width * 0.5,
                y: viewport_size.height * 0.5,
            };
            return false;
        };
        self.fit_rect(bounds, viewport_size, padding, max_fit_zoom);
        true
    }

    pub fn fit_selection(&mut self, canvas: &Canvas, ids: &[NodeId], viewport_size: Size, padding: f64, max_fit_zoom: Option<f64>) -> bool {
        let Some(bounds) = canvas.nodes_bounds(ids) else {
            return false;
        };
        self.fit_rect(bounds, viewport_size, padding, max_fit_zoom);
        true
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResizeHandle {
    NorthWest,
    North,
    NorthEast,
    East,
    SouthEast,
    South,
    SouthWest,
    West,
}

impl ResizeHandle {
    pub const ALL: [ResizeHandle; 8] = [
        ResizeHandle::NorthWest,
        ResizeHandle::North,
        ResizeHandle::NorthEast,
        ResizeHandle::East,
        ResizeHandle::SouthEast,
        ResizeHandle::South,
        ResizeHandle::SouthWest,
        ResizeHandle::West,
    ];

    pub fn position_on(self, rect: Rect) -> Point {
        match self {
            ResizeHandle::NorthWest => Point::new(rect.x, rect.y),
            ResizeHandle::North => Point::new(rect.x + rect.width * 0.5, rect.y),
            ResizeHandle::NorthEast => Point::new(rect.right(), rect.y),
            ResizeHandle::East => Point::new(rect.right(), rect.y + rect.height * 0.5),
            ResizeHandle::SouthEast => Point::new(rect.right(), rect.bottom()),
            ResizeHandle::South => Point::new(rect.x + rect.width * 0.5, rect.bottom()),
            ResizeHandle::SouthWest => Point::new(rect.x, rect.bottom()),
            ResizeHandle::West => Point::new(rect.x, rect.y + rect.height * 0.5),
        }
    }
}

pub fn anchor_point(rect: Rect, side: Side) -> Point {
    match side {
        Side::Top => Point::new(rect.x + rect.width * 0.5, rect.y),
        Side::Right => Point::new(rect.right(), rect.y + rect.height * 0.5),
        Side::Bottom => Point::new(rect.x + rect.width * 0.5, rect.bottom()),
        Side::Left => Point::new(rect.x, rect.y + rect.height * 0.5),
    }
}

/// Resolves omitted `fromSide`/`toSide` to the closest facing ports (or adjacent
/// clockwise ports for self-loops), matching Obsidian Canvas routing.
pub fn resolve_edge_sides(from: Rect, to: Rect, from_side: Option<Side>, to_side: Option<Side>, is_self_loop: bool) -> (Side, Side) {
    if let (Some(fs), Some(ts)) = (from_side, to_side) {
        return (fs, ts);
    }

    if is_self_loop {
        return match (from_side, to_side) {
            (Some(fs), None) => (fs, fs.clockwise()),
            (None, Some(ts)) => (ts.clockwise().clockwise().clockwise(), ts),
            (None, None) => (Side::Right, Side::Bottom),
            (Some(fs), Some(ts)) => (fs, ts),
        };
    }

    // Horizontal sides precede vertical sides so exact 45-degree ties prefer left-to-right flow.
    const ORDER: [Side; 4] = [Side::Right, Side::Left, Side::Bottom, Side::Top];
    let from_candidates: &[Side] = match from_side {
        Some(Side::Top) => &[Side::Top],
        Some(Side::Right) => &[Side::Right],
        Some(Side::Bottom) => &[Side::Bottom],
        Some(Side::Left) => &[Side::Left],
        None => &ORDER,
    };
    let to_candidates: &[Side] = match to_side {
        Some(Side::Top) => &[Side::Top],
        Some(Side::Right) => &[Side::Right],
        Some(Side::Bottom) => &[Side::Bottom],
        Some(Side::Left) => &[Side::Left],
        None => &ORDER,
    };

    let mut best = (from_candidates[0], to_candidates[0]);
    let mut best_dist = f64::INFINITY;
    for &fs in from_candidates {
        let fp = anchor_point(from, fs);
        for &ts in to_candidates {
            let tp = anchor_point(to, ts);
            let dist = fp.distance_squared(tp);
            if dist + 1e-6 < best_dist {
                best_dist = dist;
                best = (fs, ts);
            }
        }
    }
    best
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CubicBezier {
    pub p0: Point,
    pub p1: Point,
    pub p2: Point,
    pub p3: Point,
}

impl CubicBezier {
    pub fn point_at(self, t: f64) -> Point {
        let u = 1.0 - t;
        let uu = u * u;
        let tt = t * t;
        let uuu = uu * u;
        let ttt = tt * t;
        Point {
            x: uuu * self.p0.x + 3.0 * uu * t * self.p1.x + 3.0 * u * tt * self.p2.x + ttt * self.p3.x,
            y: uuu * self.p0.y + 3.0 * uu * t * self.p1.y + 3.0 * u * tt * self.p2.y + ttt * self.p3.y,
        }
    }

    pub fn tangent_at(self, t: f64) -> Vec2 {
        let u = 1.0 - t;
        let dx = 3.0 * u * u * (self.p1.x - self.p0.x) + 6.0 * u * t * (self.p2.x - self.p1.x) + 3.0 * t * t * (self.p3.x - self.p2.x);
        let dy = 3.0 * u * u * (self.p1.y - self.p0.y) + 6.0 * u * t * (self.p2.y - self.p1.y) + 3.0 * t * t * (self.p3.y - self.p2.y);
        let v = Vec2::new(dx, dy);
        if v.length() > 1e-9 {
            return v;
        }
        if t <= 0.0 {
            let alt = self.p2 - self.p0;
            if alt.length() > 1e-9 { alt } else { self.p3 - self.p0 }
        } else if t >= 1.0 {
            let alt = self.p3 - self.p1;
            if alt.length() > 1e-9 { alt } else { self.p3 - self.p0 }
        } else {
            self.p3 - self.p0
        }
    }

    pub fn midpoint(self) -> Point {
        self.point_at(0.5)
    }

    pub fn bounding_box(self) -> Rect {
        let (min_x, max_x) = cubic_axis_extrema(self.p0.x, self.p1.x, self.p2.x, self.p3.x);
        let (min_y, max_y) = cubic_axis_extrema(self.p0.y, self.p1.y, self.p2.y, self.p3.y);
        Rect {
            x: min_x,
            y: min_y,
            width: max_x - min_x,
            height: max_y - min_y,
        }
    }

    pub fn sample(self, segments: usize) -> Vec<Point> {
        let steps = segments.max(1);
        (0..=steps).map(|i| self.point_at(i as f64 / steps as f64)).collect()
    }

    pub fn distance_to_point(self, target: Point) -> f64 {
        const SEGMENTS: usize = 32;
        let mut best_dist_sq = f64::INFINITY;
        let mut best_t = 0.0_f64;

        let mut prev = self.p0;
        for i in 1..=SEGMENTS {
            let t1 = i as f64 / SEGMENTS as f64;
            let curr = self.point_at(t1);
            let (seg_dist_sq, frac) = point_to_segment_dist_sq(target, prev, curr);
            if seg_dist_sq < best_dist_sq {
                best_dist_sq = seg_dist_sq;
                let t0 = (i - 1) as f64 / SEGMENTS as f64;
                best_t = t0 + frac * (t1 - t0);
            }
            prev = curr;
        }

        let mut lo = (best_t - 1.0 / SEGMENTS as f64).max(0.0);
        let mut hi = (best_t + 1.0 / SEGMENTS as f64).min(1.0);
        for _ in 0..10 {
            let m1 = lo + (hi - lo) / 3.0;
            let m2 = hi - (hi - lo) / 3.0;
            let d1 = self.point_at(m1).distance_squared(target);
            let d2 = self.point_at(m2).distance_squared(target);
            if d1 < d2 {
                hi = m2;
                if d1 < best_dist_sq {
                    best_dist_sq = d1;
                }
            } else {
                lo = m1;
                if d2 < best_dist_sq {
                    best_dist_sq = d2;
                }
            }
        }
        best_dist_sq.sqrt()
    }

    pub fn svg_path_data(self) -> String {
        format!(
            "M {:.2} {:.2} C {:.2} {:.2}, {:.2} {:.2}, {:.2} {:.2}",
            self.p0.x, self.p0.y, self.p1.x, self.p1.y, self.p2.x, self.p2.y, self.p3.x, self.p3.y
        )
    }
}

fn cubic_axis_extrema(p0: f64, p1: f64, p2: f64, p3: f64) -> (f64, f64) {
    let mut min_v = p0.min(p3);
    let mut max_v = p0.max(p3);

    let eval = |t: f64| {
        let u = 1.0 - t;
        u * u * u * p0 + 3.0 * u * u * t * p1 + 3.0 * u * t * t * p2 + t * t * t * p3
    };

    let a = p3 - 3.0 * p2 + 3.0 * p1 - p0;
    let b = p2 - 2.0 * p1 + p0;
    let c = p1 - p0;

    let mut consider = |t: f64| {
        if t > 0.0 && t < 1.0 {
            let v = eval(t);
            min_v = min_v.min(v);
            max_v = max_v.max(v);
        }
    };

    if a.abs() < 1e-12 {
        if b.abs() > 1e-12 {
            consider(-c / (2.0 * b));
        }
    } else {
        let disc = b * b - a * c;
        if disc >= 0.0 {
            let root = disc.sqrt();
            consider((-b - root) / a);
            consider((-b + root) / a);
        }
    }
    (min_v, max_v)
}

fn point_to_segment_dist_sq(p: Point, a: Point, b: Point) -> (f64, f64) {
    let ab = b - a;
    let len_sq = ab.x * ab.x + ab.y * ab.y;
    if len_sq <= 1e-12 {
        return (p.distance_squared(a), 0.0);
    }
    let ap = p - a;
    let frac = (ap.dot(ab) / len_sq).clamp(0.0, 1.0);
    let proj = Point::new(a.x + ab.x * frac, a.y + ab.y * frac);
    (p.distance_squared(proj), frac)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ArrowConfig {
    pub length: f64,
    pub width: f64,
}

impl Default for ArrowConfig {
    fn default() -> Self {
        Self { length: 10.0, width: 8.0 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Arrowhead {
    pub tip: Point,
    pub left: Point,
    pub right: Point,
}

impl Arrowhead {
    pub fn compute(tip: Point, incoming_dir: Vec2, config: ArrowConfig) -> Option<Self> {
        let dir = incoming_dir.normalized()?;
        let base = Point::new(tip.x - dir.x * config.length, tip.y - dir.y * config.length);
        let half_w = config.width * 0.5;
        let perp = dir.perp();
        Some(Self {
            tip,
            left: Point::new(base.x + perp.x * half_w, base.y + perp.y * half_w),
            right: Point::new(base.x - perp.x * half_w, base.y - perp.y * half_w),
        })
    }

    pub fn svg_points(self) -> String {
        format!(
            "{:.2},{:.2} {:.2},{:.2} {:.2},{:.2}",
            self.tip.x, self.tip.y, self.left.x, self.left.y, self.right.x, self.right.y
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EdgeGeometry {
    pub from_side: Side,
    pub to_side: Side,
    pub curve: CubicBezier,
    pub label_anchor: Point,
    pub from_arrow: Option<Arrowhead>,
    pub to_arrow: Option<Arrowhead>,
}

pub fn compute_edge_geometry_between(from: Rect, to: Rect, edge: &Edge, arrow_config: ArrowConfig) -> EdgeGeometry {
    let is_self_loop = edge.from_node == edge.to_node;
    let (from_side, to_side) = resolve_edge_sides(from, to, edge.from_side, edge.to_side, is_self_loop);

    let p0 = anchor_point(from, from_side);
    let p3 = anchor_point(to, to_side);
    let n0 = from_side.normal();
    let n3 = to_side.normal();

    let offset = if is_self_loop {
        80.0
    } else {
        let dist = p0.distance(p3);
        let facing_short = from_side.opposite() == to_side && dist < 80.0;
        if facing_short {
            (dist * 0.5).max(8.0)
        } else {
            (dist * 0.45).clamp(32.0, 240.0)
        }
    };

    let curve = CubicBezier {
        p0,
        p1: p0.offset(n0.scale(offset)),
        p2: p3.offset(n3.scale(offset)),
        p3,
    };

    let from_arrow = match edge.effective_from_end() {
        End::Arrow => Arrowhead::compute(p0, curve.tangent_at(0.0).negate(), arrow_config),
        End::None => None,
    };
    let to_arrow = match edge.effective_to_end() {
        End::Arrow => Arrowhead::compute(p3, curve.tangent_at(1.0), arrow_config),
        End::None => None,
    };

    EdgeGeometry {
        from_side,
        to_side,
        curve,
        label_anchor: curve.midpoint(),
        from_arrow,
        to_arrow,
    }
}

pub fn compute_edge_geometry(canvas: &Canvas, edge: &Edge, arrow_config: ArrowConfig) -> Option<EdgeGeometry> {
    let from = canvas.node(&edge.from_node)?.rect();
    let to = canvas.node(&edge.to_node)?.rect();
    Some(compute_edge_geometry_between(from, to, edge, arrow_config))
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SnapConfig {
    pub grid_size: Option<i64>,
    pub snap_to_nodes: bool,
    pub threshold: f64,
}

impl Default for SnapConfig {
    fn default() -> Self {
        Self {
            grid_size: Some(20),
            snap_to_nodes: true,
            threshold: 8.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapGuide {
    Vertical { x: i64, from_y: i64, to_y: i64 },
    Horizontal { y: i64, from_x: i64, to_x: i64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapMoveResult {
    pub x: i64,
    pub y: i64,
    pub guides: Vec<SnapGuide>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResizeSnapResult {
    pub bounds: NodeBounds,
    pub guides: Vec<SnapGuide>,
}

pub fn snap_scalar_to_grid(value: i64, grid: i64) -> i64 {
    if grid <= 0 {
        return value;
    }
    ((value as f64 / grid as f64).round() as i64).saturating_mul(grid)
}

pub fn snap_point_to_grid(x: i64, y: i64, grid: i64) -> (i64, i64) {
    (snap_scalar_to_grid(x, grid), snap_scalar_to_grid(y, grid))
}

pub fn snap_node_move(moving: NodeBounds, peers: &[NodeBounds], config: &SnapConfig) -> SnapMoveResult {
    let mut snapped_x = moving.x;
    let mut snapped_y = moving.y;
    let mut guides = Vec::new();
    let threshold = config.threshold.max(0.0);

    let mut x_snapped_to_peer = false;
    let mut y_snapped_to_peer = false;

    if config.snap_to_nodes && !peers.is_empty() {
        let moving_xs = [moving.x, moving.center_x(), moving.right()];
        let mut best_dx: Option<(i64, i64)> = None;

        for peer in peers {
            let peer_xs = [peer.x, peer.center_x(), peer.right()];
            for &mx in &moving_xs {
                for &px in &peer_xs {
                    let delta = px - mx;
                    if (delta as f64).abs() <= threshold {
                        let replace = match best_dx {
                            Some((cur, _)) => delta.abs() < cur.abs(),
                            None => true,
                        };
                        if replace {
                            best_dx = Some((delta, px));
                        }
                    }
                }
            }
        }

        if let Some((dx, line_x)) = best_dx {
            snapped_x = moving.x.saturating_add(dx);
            x_snapped_to_peer = true;
            let mut min_y = moving.y;
            let mut max_y = moving.bottom();
            for peer in peers {
                if peer.x == line_x || peer.center_x() == line_x || peer.right() == line_x {
                    min_y = min_y.min(peer.y);
                    max_y = max_y.max(peer.bottom());
                }
            }
            guides.push(SnapGuide::Vertical {
                x: line_x,
                from_y: min_y,
                to_y: max_y,
            });
        }

        let moving_ys = [moving.y, moving.center_y(), moving.bottom()];
        let mut best_dy: Option<(i64, i64)> = None;

        for peer in peers {
            let peer_ys = [peer.y, peer.center_y(), peer.bottom()];
            for &my in &moving_ys {
                for &py in &peer_ys {
                    let delta = py - my;
                    if (delta as f64).abs() <= threshold {
                        let replace = match best_dy {
                            Some((cur, _)) => delta.abs() < cur.abs(),
                            None => true,
                        };
                        if replace {
                            best_dy = Some((delta, py));
                        }
                    }
                }
            }
        }

        if let Some((dy, line_y)) = best_dy {
            snapped_y = moving.y.saturating_add(dy);
            y_snapped_to_peer = true;
            let mut min_x = snapped_x;
            let mut max_x = snapped_x.saturating_add(moving.width);
            for peer in peers {
                if peer.y == line_y || peer.center_y() == line_y || peer.bottom() == line_y {
                    min_x = min_x.min(peer.x);
                    max_x = max_x.max(peer.right());
                }
            }
            guides.push(SnapGuide::Horizontal {
                y: line_y,
                from_x: min_x,
                to_x: max_x,
            });
        }
    }

    if let Some(grid) = config.grid_size
        && grid > 0
    {
        if !x_snapped_to_peer {
            snapped_x = snap_scalar_to_grid(snapped_x, grid);
        }
        if !y_snapped_to_peer {
            snapped_y = snap_scalar_to_grid(snapped_y, grid);
        }
    }

    SnapMoveResult {
        x: snapped_x,
        y: snapped_y,
        guides,
    }
}

#[allow(clippy::too_many_arguments)]
pub fn snap_node_resize(
    original: NodeBounds,
    handle: ResizeHandle,
    dx: i64,
    dy: i64,
    min_width: i64,
    min_height: i64,
    peers: &[NodeBounds],
    config: &SnapConfig,
) -> ResizeSnapResult {
    let min_w = min_width.max(1);
    let min_h = min_height.max(1);

    let (mut left, mut right, mut top, mut bottom) = (original.x, original.right(), original.y, original.bottom());

    let moves_left = matches!(handle, ResizeHandle::NorthWest | ResizeHandle::West | ResizeHandle::SouthWest);
    let moves_right = matches!(handle, ResizeHandle::NorthEast | ResizeHandle::East | ResizeHandle::SouthEast);
    let moves_top = matches!(handle, ResizeHandle::NorthWest | ResizeHandle::North | ResizeHandle::NorthEast);
    let moves_bottom = matches!(handle, ResizeHandle::SouthWest | ResizeHandle::South | ResizeHandle::SouthEast);

    if moves_left {
        left = left.saturating_add(dx).min(right - min_w);
    }
    if moves_right {
        right = right.saturating_add(dx).max(left + min_w);
    }
    if moves_top {
        top = top.saturating_add(dy).min(bottom - min_h);
    }
    if moves_bottom {
        bottom = bottom.saturating_add(dy).max(top + min_h);
    }

    let mut guides = Vec::new();
    let threshold = config.threshold.max(0.0);

    let snap_x_edge = |edge: i64, guides: &mut Vec<SnapGuide>| -> i64 {
        if config.snap_to_nodes {
            let mut best: Option<(i64, i64)> = None;
            for peer in peers {
                for &px in &[peer.x, peer.center_x(), peer.right()] {
                    let delta = px - edge;
                    if (delta as f64).abs() <= threshold && best.is_none_or(|(d, _)| delta.abs() < d.abs()) {
                        best = Some((delta, px));
                    }
                }
            }
            if let Some((_, line_x)) = best {
                let mut min_y = top;
                let mut max_y = bottom;
                for peer in peers {
                    if peer.x == line_x || peer.center_x() == line_x || peer.right() == line_x {
                        min_y = min_y.min(peer.y);
                        max_y = max_y.max(peer.bottom());
                    }
                }
                guides.push(SnapGuide::Vertical {
                    x: line_x,
                    from_y: min_y,
                    to_y: max_y,
                });
                return line_x;
            }
        }
        if let Some(grid) = config.grid_size
            && grid > 0
        {
            return snap_scalar_to_grid(edge, grid);
        }
        edge
    };

    let snap_y_edge = |edge: i64, left: i64, right: i64, guides: &mut Vec<SnapGuide>| -> i64 {
        if config.snap_to_nodes {
            let mut best: Option<(i64, i64)> = None;
            for peer in peers {
                for &py in &[peer.y, peer.center_y(), peer.bottom()] {
                    let delta = py - edge;
                    if (delta as f64).abs() <= threshold && best.is_none_or(|(d, _)| delta.abs() < d.abs()) {
                        best = Some((delta, py));
                    }
                }
            }
            if let Some((_, line_y)) = best {
                let mut min_x = left;
                let mut max_x = right;
                for peer in peers {
                    if peer.y == line_y || peer.center_y() == line_y || peer.bottom() == line_y {
                        min_x = min_x.min(peer.x);
                        max_x = max_x.max(peer.right());
                    }
                }
                guides.push(SnapGuide::Horizontal {
                    y: line_y,
                    from_x: min_x,
                    to_x: max_x,
                });
                return line_y;
            }
        }
        if let Some(grid) = config.grid_size
            && grid > 0
        {
            return snap_scalar_to_grid(edge, grid);
        }
        edge
    };

    if moves_left {
        left = snap_x_edge(left, &mut guides).min(right - min_w);
    }
    if moves_right {
        right = snap_x_edge(right, &mut guides).max(left + min_w);
    }
    if moves_top {
        top = snap_y_edge(top, left, right, &mut guides).min(bottom - min_h);
    }
    if moves_bottom {
        bottom = snap_y_edge(bottom, left, right, &mut guides).max(top + min_h);
    }

    ResizeSnapResult {
        bounds: NodeBounds::new(left, top, right - left, bottom - top),
        guides,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AlignKind {
    Left,
    CenterHorizontal,
    Right,
    Top,
    CenterVertical,
    Bottom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DistributeAxis {
    Horizontal,
    Vertical,
}

/// Computes target `(x, y)` coordinates to align the selected nodes.
pub fn compute_alignment(canvas: &Canvas, ids: &[NodeId], align: AlignKind) -> Vec<(NodeId, i64, i64)> {
    let nodes: Vec<_> = ids.iter().filter_map(|id| canvas.node(id)).collect();
    if nodes.len() < 2 {
        return Vec::new();
    }

    let min_x = nodes.iter().map(|n| n.x()).min().unwrap_or(0);
    let max_right = nodes.iter().map(|n| n.bounds().right()).max().unwrap_or(0);
    let min_y = nodes.iter().map(|n| n.y()).min().unwrap_or(0);
    let max_bottom = nodes.iter().map(|n| n.bounds().bottom()).max().unwrap_or(0);
    let center_x = (min_x + max_right) / 2;
    let center_y = (min_y + max_bottom) / 2;

    let mut out = Vec::new();
    for node in nodes {
        let (target_x, target_y) = match align {
            AlignKind::Left => (min_x, node.y()),
            AlignKind::CenterHorizontal => (center_x - node.width() / 2, node.y()),
            AlignKind::Right => (max_right - node.width(), node.y()),
            AlignKind::Top => (node.x(), min_y),
            AlignKind::CenterVertical => (node.x(), center_y - node.height() / 2),
            AlignKind::Bottom => (node.x(), max_bottom - node.height()),
        };
        if target_x != node.x() || target_y != node.y() {
            out.push((node.id().clone(), target_x, target_y));
        }
    }
    out
}

/// Computes target `(x, y)` coordinates to evenly space 3 or more nodes along `axis`.
pub fn compute_distribution(canvas: &Canvas, ids: &[NodeId], axis: DistributeAxis) -> Vec<(NodeId, i64, i64)> {
    let mut nodes: Vec<_> = ids.iter().filter_map(|id| canvas.node(id)).collect();
    if nodes.len() < 3 {
        return Vec::new();
    }

    match axis {
        DistributeAxis::Horizontal => {
            nodes.sort_by_key(|n| (n.x(), n.y()));
            let first_x = nodes[0].x();
            let last_right = nodes[nodes.len() - 1].bounds().right();
            let total_widths: i64 = nodes.iter().map(|n| n.width()).sum();
            let gap = (last_right - first_x - total_widths) as f64 / (nodes.len() - 1) as f64;

            let mut cursor = first_x as f64 + nodes[0].width() as f64 + gap;
            let mut out = Vec::new();
            for node in &nodes[1..nodes.len() - 1] {
                let target_x = cursor.round() as i64;
                if target_x != node.x() {
                    out.push((node.id().clone(), target_x, node.y()));
                }
                cursor += node.width() as f64 + gap;
            }
            out
        }
        DistributeAxis::Vertical => {
            nodes.sort_by_key(|n| (n.y(), n.x()));
            let first_y = nodes[0].y();
            let last_bottom = nodes[nodes.len() - 1].bounds().bottom();
            let total_heights: i64 = nodes.iter().map(|n| n.height()).sum();
            let gap = (last_bottom - first_y - total_heights) as f64 / (nodes.len() - 1) as f64;

            let mut cursor = first_y as f64 + nodes[0].height() as f64 + gap;
            let mut out = Vec::new();
            for node in &nodes[1..nodes.len() - 1] {
                let target_y = cursor.round() as i64;
                if target_y != node.y() {
                    out.push((node.id().clone(), node.x(), target_y));
                }
                cursor += node.height() as f64 + gap;
            }
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cubic_extrema_handles_linear_and_degenerate_cases() {
        let (min_v, max_v) = cubic_axis_extrema(0.0, 1.0, 1.0, 0.0);
        assert!((min_v - 0.0).abs() < 1e-9);
        assert!((max_v - 0.75).abs() < 1e-9);

        let (c_min, c_max) = cubic_axis_extrema(5.0, 5.0, 5.0, 5.0);
        assert!((c_min - 5.0).abs() < 1e-9);
        assert!((c_max - 5.0).abs() < 1e-9);
    }

    #[test]
    fn point_to_segment_handles_zero_length_segment() {
        let p = Point::new(3.0, 4.0);
        let a = Point::ZERO;
        let (d_sq, frac) = point_to_segment_dist_sq(p, a, a);
        assert!((d_sq - 25.0).abs() < 1e-9);
        assert_eq!(frac, 0.0);
    }
}
