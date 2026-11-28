use crate::engine::canvas::model::{Canvas, Edge, End, GroupNode, Rect, Side};

/// Group labels float above the top-left corner of the group frame (Obsidian Canvas convention).
pub(super) const GROUP_LABEL_HEIGHT: f64 = 24.0;
pub(super) const GROUP_LABEL_GAP: f64 = 6.0;

pub(super) fn group_label_rect(group: &GroupNode) -> Option<Rect> {
    let label = group.label.as_deref().filter(|s| !s.is_empty())?;
    let estimated_width = (label.chars().count() as f64 * 8.0 + 16.0).clamp(48.0, (group.width as f64).max(48.0));
    Some(Rect::new(
        group.x as f64,
        group.y as f64 - GROUP_LABEL_HEIGHT - GROUP_LABEL_GAP,
        estimated_width,
        GROUP_LABEL_HEIGHT,
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub(super) struct Point {
    pub(super) x: f64,
    pub(super) y: f64,
}

impl Point {
    pub(super) const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    pub(super) fn distance(self, other: Point) -> f64 {
        self.distance_squared(other).sqrt()
    }

    fn distance_squared(self, other: Point) -> f64 {
        let dx = self.x - other.x;
        let dy = self.y - other.y;
        dx * dx + dy * dy
    }

    fn offset(self, delta: Vec2) -> Point {
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

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub(super) struct Vec2 {
    pub(super) x: f64,
    pub(super) y: f64,
}

impl Vec2 {
    const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    fn length(self) -> f64 {
        (self.x * self.x + self.y * self.y).sqrt()
    }

    pub(super) fn normalized(self) -> Option<Vec2> {
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

    fn scale(self, factor: f64) -> Vec2 {
        Vec2 {
            x: self.x * factor,
            y: self.y * factor,
        }
    }

    fn negate(self) -> Vec2 {
        Vec2 { x: -self.x, y: -self.y }
    }

    fn perp(self) -> Vec2 {
        Vec2 { x: -self.y, y: self.x }
    }
}

const fn side_normal(side: Side) -> Vec2 {
    match side {
        Side::Top => Vec2 { x: 0.0, y: -1.0 },
        Side::Right => Vec2 { x: 1.0, y: 0.0 },
        Side::Bottom => Vec2 { x: 0.0, y: 1.0 },
        Side::Left => Vec2 { x: -1.0, y: 0.0 },
    }
}

fn anchor_point(rect: Rect, side: Side) -> Point {
    match side {
        Side::Top => Point::new(rect.x + rect.width * 0.5, rect.y),
        Side::Right => Point::new(rect.right(), rect.y + rect.height * 0.5),
        Side::Bottom => Point::new(rect.x + rect.width * 0.5, rect.bottom()),
        Side::Left => Point::new(rect.x, rect.y + rect.height * 0.5),
    }
}

/// Resolves omitted `fromSide`/`toSide` to the closest facing ports (or adjacent
/// clockwise ports for self-loops), matching Obsidian Canvas routing.
fn resolve_edge_sides(from: Rect, to: Rect, from_side: Option<Side>, to_side: Option<Side>, is_self_loop: bool) -> (Side, Side) {
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
pub(super) struct CubicBezier {
    pub(super) p0: Point,
    pub(super) p1: Point,
    pub(super) p2: Point,
    pub(super) p3: Point,
}

impl CubicBezier {
    fn point_at(self, t: f64) -> Point {
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

    pub(super) fn tangent_at(self, t: f64) -> Vec2 {
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

    fn midpoint(self) -> Point {
        self.point_at(0.5)
    }

    pub(super) fn bounding_box(self) -> Rect {
        let (min_x, max_x) = cubic_axis_extrema(self.p0.x, self.p1.x, self.p2.x, self.p3.x);
        let (min_y, max_y) = cubic_axis_extrema(self.p0.y, self.p1.y, self.p2.y, self.p3.y);
        Rect {
            x: min_x,
            y: min_y,
            width: max_x - min_x,
            height: max_y - min_y,
        }
    }

    pub(super) fn svg_path_data(self) -> String {
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
pub(super) struct Arrowhead {
    tip: Point,
    left: Point,
    right: Point,
}

impl Arrowhead {
    fn compute(tip: Point, incoming_dir: Vec2, config: ArrowConfig) -> Option<Self> {
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

    pub(super) fn svg_points(self) -> String {
        format!(
            "{:.2},{:.2} {:.2},{:.2} {:.2},{:.2}",
            self.tip.x, self.tip.y, self.left.x, self.left.y, self.right.x, self.right.y
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct EdgeGeometry {
    pub(super) curve: CubicBezier,
    pub(super) label_anchor: Point,
    pub(super) from_arrow: Option<Arrowhead>,
    pub(super) to_arrow: Option<Arrowhead>,
}

fn compute_edge_geometry_between(from: Rect, to: Rect, edge: &Edge, arrow_config: ArrowConfig) -> EdgeGeometry {
    let is_self_loop = edge.from_node == edge.to_node;
    let (from_side, to_side) = resolve_edge_sides(from, to, edge.from_side, edge.to_side, is_self_loop);

    let p0 = anchor_point(from, from_side);
    let p3 = anchor_point(to, to_side);
    let n0 = side_normal(from_side);
    let n3 = side_normal(to_side);

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
        curve,
        label_anchor: curve.midpoint(),
        from_arrow,
        to_arrow,
    }
}

pub(super) fn compute_edge_geometry(canvas: &Canvas, edge: &Edge, arrow_config: ArrowConfig) -> Option<EdgeGeometry> {
    let from = canvas.node(&edge.from_node)?.rect();
    let to = canvas.node(&edge.to_node)?.rect();
    Some(compute_edge_geometry_between(from, to, edge, arrow_config))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::canvas::model::Node;

    #[test]
    fn cubic_extrema_and_bounding_box_capture_bulge_and_degenerate_cases() {
        let (min_v, max_v) = cubic_axis_extrema(0.0, 1.0, 1.0, 0.0);
        assert!((min_v - 0.0).abs() < 1e-9);
        assert!((max_v - 0.75).abs() < 1e-9);

        let (c_min, c_max) = cubic_axis_extrema(5.0, 5.0, 5.0, 5.0);
        assert!((c_min - 5.0).abs() < 1e-9);
        assert!((c_max - 5.0).abs() < 1e-9);

        let curve = CubicBezier {
            p0: Point::new(0.0, 0.0),
            p1: Point::new(100.0, 0.0),
            p2: Point::new(100.0, 100.0),
            p3: Point::new(0.0, 100.0),
        };
        let bbox = curve.bounding_box();
        assert!((bbox.x - 0.0).abs() < 1e-6);
        assert!((bbox.right() - 75.0).abs() < 1e-6);
        assert!((bbox.y - 0.0).abs() < 1e-6);
        assert!((bbox.bottom() - 100.0).abs() < 1e-6);
    }

    #[test]
    fn edge_routing_handles_auto_sides_self_loops_and_short_facing_nodes() {
        use crate::engine::canvas::model::NodeBounds;

        let left = Rect::new(0.0, 0.0, 200.0, 100.0);
        let right = Rect::new(360.0, 0.0, 200.0, 100.0);
        let below = Rect::new(0.0, 240.0, 200.0, 100.0);

        assert_eq!(resolve_edge_sides(left, right, None, None, false), (Side::Right, Side::Left));
        assert_eq!(resolve_edge_sides(right, left, None, None, false), (Side::Left, Side::Right));
        assert_eq!(resolve_edge_sides(left, below, None, None, false), (Side::Bottom, Side::Top));
        assert_eq!(resolve_edge_sides(below, left, None, None, false), (Side::Top, Side::Bottom));
        assert_eq!(resolve_edge_sides(left, right, Some(Side::Top), None, false), (Side::Top, Side::Left));
        assert_eq!(resolve_edge_sides(left, left, None, None, true), (Side::Right, Side::Bottom));
        assert_eq!(resolve_edge_sides(left, left, Some(Side::Top), None, true), (Side::Top, Side::Right));

        let mut canvas = Canvas::new();
        canvas.nodes.push(Node::text("a", NodeBounds::new(0, 0, 100, 100), "A"));
        canvas.nodes.push(Node::text("b", NodeBounds::new(110, 0, 100, 100), "B"));
        canvas.nodes.push(Node::text("c", NodeBounds::new(0, 0, 100, 100), "Overlap"));
        canvas.edges.push(Edge::new("short", "a", "b"));
        canvas.edges.push(Edge::new("overlap", "a", "c"));
        canvas.edges.push(Edge::new("loop", "a", "a"));

        let short = compute_edge_geometry(&canvas, &canvas.edges[0], ArrowConfig::default()).unwrap();
        assert!(short.curve.p1.x >= short.curve.p0.x && short.curve.p1.x <= short.curve.p3.x);
        assert!(short.curve.p2.x >= short.curve.p0.x && short.curve.p2.x <= short.curve.p3.x);
        assert!(short.from_arrow.is_none());
        assert!(short.to_arrow.is_some());

        let overlap = compute_edge_geometry(&canvas, &canvas.edges[1], ArrowConfig::default()).unwrap();
        assert!(overlap.curve.p0.x.is_finite() && overlap.curve.p3.y.is_finite());
        assert!(overlap.to_arrow.is_some());

        let self_loop = compute_edge_geometry(&canvas, &canvas.edges[2], ArrowConfig::default()).unwrap();
        assert!(self_loop.curve.bounding_box().width > 20.0);
        assert!(self_loop.curve.bounding_box().height > 20.0);
    }

    #[test]
    fn group_label_rect_floats_above_labeled_groups_and_skips_empty_labels() {
        use crate::engine::canvas::model::NodeBounds;

        let labeled = Node::group("g1", NodeBounds::new(10, 50, 200, 120), Some("Pipeline".into()));
        let rect = group_label_rect(labeled.as_group().unwrap()).expect("labeled group has label rect");
        assert_eq!(rect.x, 10.0);
        assert_eq!(rect.y, 50.0 - GROUP_LABEL_HEIGHT - GROUP_LABEL_GAP);
        assert_eq!(rect.height, GROUP_LABEL_HEIGHT);
        assert!(rect.width >= 48.0 && rect.width <= 200.0);

        let unlabeled = Node::group("g2", NodeBounds::new(10, 50, 200, 120), None);
        assert!(group_label_rect(unlabeled.as_group().unwrap()).is_none());
    }
}
