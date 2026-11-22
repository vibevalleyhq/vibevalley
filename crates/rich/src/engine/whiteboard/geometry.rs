use std::collections::HashMap;

use crate::engine::whiteboard::model::{AnchorSide, ArrowCurve, ArrowEndpoint, ArrowHead, ElementId, Point2, Rect2, Vec2};

pub const MIN_ZOOM: f64 = 0.1;
pub const MAX_ZOOM: f64 = 4.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Camera {
    pub pan_x: f64,
    pub pan_y: f64,
    pub zoom: f64,
}

impl Default for Camera {
    fn default() -> Self {
        Self {
            pan_x: 36.0,
            pan_y: 28.0,
            zoom: 1.0,
        }
    }
}

impl Camera {
    pub fn screen_to_world(self, pt: Point2) -> Point2 {
        let z = self.zoom.clamp(MIN_ZOOM, MAX_ZOOM);
        Point2::new((pt.x - self.pan_x) / z, (pt.y - self.pan_y) / z)
    }

    pub fn world_to_screen(self, pt: Point2) -> Point2 {
        let z = self.zoom.clamp(MIN_ZOOM, MAX_ZOOM);
        Point2::new(pt.x * z + self.pan_x, pt.y * z + self.pan_y)
    }

    pub fn zoom_at(&mut self, screen_pt: Point2, factor: f64) {
        if !factor.is_finite() || factor <= 0.0 {
            return;
        }
        let world_before = self.screen_to_world(screen_pt);
        self.zoom = (self.zoom * factor).clamp(MIN_ZOOM, MAX_ZOOM);
        self.pan_x = screen_pt.x - world_before.x * self.zoom;
        self.pan_y = screen_pt.y - world_before.y * self.zoom;
    }

    pub fn set_zoom_centered(&mut self, viewport_w: f64, viewport_h: f64, next_zoom: f64) {
        let center = Point2::new(viewport_w * 0.5, viewport_h * 0.5);
        let factor = next_zoom.clamp(MIN_ZOOM, MAX_ZOOM) / self.zoom.max(MIN_ZOOM);
        self.zoom_at(center, factor);
    }

    pub fn visible_world_rect(self, viewport_w: f64, viewport_h: f64) -> Rect2 {
        let tl = self.screen_to_world(Point2::ZERO);
        let br = self.screen_to_world(Point2::new(viewport_w.max(1.0), viewport_h.max(1.0)));
        Rect2::from_corners(tl, br)
    }

    pub fn fit_bounds(&mut self, bounds: Rect2, viewport_w: f64, viewport_h: f64, padding: f64, max_zoom: f64) {
        let vw = viewport_w.max(64.0);
        let vh = viewport_h.max(64.0);
        let bw = bounds.w.max(40.0);
        let bh = bounds.h.max(40.0);
        let zx = (vw - padding * 2.0).max(40.0) / bw;
        let zy = (vh - padding * 2.0).max(40.0) / bh;
        self.zoom = zx.min(zy).min(max_zoom).clamp(MIN_ZOOM, MAX_ZOOM);
        let center = bounds.center();
        self.pan_x = vw * 0.5 - center.x * self.zoom;
        self.pan_y = vh * 0.5 - center.y * self.zoom;
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CubicSegment {
    pub p0: Point2,
    pub c1: Point2,
    pub c2: Point2,
    pub p3: Point2,
}

impl CubicSegment {
    pub fn eval(self, t: f64) -> Point2 {
        let t = t.clamp(0.0, 1.0);
        let u = 1.0 - t;
        let uu = u * u;
        let tt = t * t;
        let uuu = uu * u;
        let ttt = tt * t;
        Point2::new(
            uuu * self.p0.x + 3.0 * uu * t * self.c1.x + 3.0 * u * tt * self.c2.x + ttt * self.p3.x,
            uuu * self.p0.y + 3.0 * uu * t * self.c1.y + 3.0 * u * tt * self.c2.y + ttt * self.p3.y,
        )
    }

    pub fn tangent(self, t: f64) -> Vec2 {
        let t = t.clamp(0.0, 1.0);
        let u = 1.0 - t;
        let dx = 3.0 * u * u * (self.c1.x - self.p0.x) + 6.0 * u * t * (self.c2.x - self.c1.x) + 3.0 * t * t * (self.p3.x - self.c2.x);
        let dy = 3.0 * u * u * (self.c1.y - self.p0.y) + 6.0 * u * t * (self.c2.y - self.c1.y) + 3.0 * t * t * (self.p3.y - self.c2.y);
        Vec2::new(dx, dy)
    }

    pub fn sample(self, steps: usize) -> Vec<Point2> {
        let count = steps.max(4);
        (0..=count).map(|i| self.eval(i as f64 / count as f64)).collect()
    }
}

pub fn catmull_rom_cubics(points: &[Point2], tension: f64) -> Vec<CubicSegment> {
    if points.len() < 2 {
        return Vec::new();
    }
    if points.len() == 2 {
        let a = points[0];
        let b = points[1];
        return vec![CubicSegment {
            p0: a,
            c1: Point2::new(a.x + (b.x - a.x) / 3.0, a.y + (b.y - a.y) / 3.0),
            c2: Point2::new(a.x + (b.x - a.x) * 2.0 / 3.0, a.y + (b.y - a.y) * 2.0 / 3.0),
            p3: b,
        }];
    }
    let factor = tension / 3.0;
    let mut segs = Vec::with_capacity(points.len() - 1);
    for i in 0..(points.len() - 1) {
        let p0 = points[i.saturating_sub(1)];
        let p1 = points[i];
        let p2 = points[i + 1];
        let p3 = points[(i + 2).min(points.len() - 1)];
        let c1 = Point2::new(p1.x + (p2.x - p0.x) * factor * 0.5, p1.y + (p2.y - p0.y) * factor * 0.5);
        let c2 = Point2::new(p2.x - (p3.x - p1.x) * factor * 0.5, p2.y - (p3.y - p1.y) * factor * 0.5);
        segs.push(CubicSegment { p0: p1, c1, c2, p3: p2 });
    }
    segs
}

pub fn cubics_to_svg_path(segments: &[CubicSegment]) -> String {
    let Some(first) = segments.first() else {
        return String::new();
    };
    let mut d = format!("M {} {}", first.p0.x.round(), first.p0.y.round());
    for seg in segments {
        use std::fmt::Write as _;
        let _ = write!(
            d,
            " C {} {} {} {} {} {}",
            seg.c1.x.round(),
            seg.c1.y.round(),
            seg.c2.x.round(),
            seg.c2.y.round(),
            seg.p3.x.round(),
            seg.p3.y.round()
        );
    }
    d
}

/// Samples a Catmull-Rom spline or polyline along normalized arc length `t` in `[0, 1]`.
pub fn sample_polyline(points: &[Point2], t: f64) -> Point2 {
    if points.is_empty() {
        return Point2::ZERO;
    }
    if points.len() == 1 {
        return points[0];
    }
    let dense = if points.len() >= 3 {
        let segs = catmull_rom_cubics(points, 0.5);
        let mut out = Vec::with_capacity(segs.len() * 16 + 1);
        for (i, seg) in segs.iter().enumerate() {
            let pts = seg.sample(16);
            if i == 0 {
                out.extend(pts);
            } else {
                out.extend(pts.into_iter().skip(1));
            }
        }
        out
    } else {
        points.to_vec()
    };

    let clamped = t.clamp(0.0, 1.0);
    let mut lengths = Vec::with_capacity(dense.len().saturating_sub(1));
    let mut total = 0.0;
    for pair in dense.windows(2) {
        let len = pair[0].distance(pair[1]);
        lengths.push(len);
        total += len;
    }
    if total <= 1e-6 {
        return dense[0];
    }
    let target = clamped * total;
    let mut acc = 0.0;
    for (idx, len) in lengths.iter().copied().enumerate() {
        if acc + len >= target || idx == lengths.len() - 1 {
            let a = dense[idx];
            let b = dense[idx + 1];
            let local_t = if len <= 1e-9 { 0.0 } else { (target - acc) / len };
            return Point2::new(a.x + (b.x - a.x) * local_t, a.y + (b.y - a.y) * local_t);
        }
        acc += len;
    }
    *dense.last().unwrap_or(&Point2::ZERO)
}

/// Projects `pt` onto the ribbon polyline and returns normalized arc-length `t` in `[0, 1]`.
pub fn project_point_to_polyline(points: &[Point2], pt: Point2) -> f64 {
    if points.len() < 2 {
        return 0.5;
    }
    let mut seg_lengths = Vec::with_capacity(points.len() - 1);
    let mut total = 0.0;
    for pair in points.windows(2) {
        let len = pair[0].distance(pair[1]);
        seg_lengths.push(len);
        total += len;
    }
    if total <= 1e-6 {
        return 0.5;
    }
    let mut best_dist_sq = f64::INFINITY;
    let mut best_t = 0.5;
    let mut acc = 0.0;
    for (idx, pair) in points.windows(2).enumerate() {
        let a = pair[0];
        let b = pair[1];
        let ab = b - a;
        let len_sq = ab.x * ab.x + ab.y * ab.y;
        let local_t = if len_sq <= 1e-9 {
            0.0
        } else {
            (((pt.x - a.x) * ab.x + (pt.y - a.y) * ab.y) / len_sq).clamp(0.0, 1.0)
        };
        let proj = Point2::new(a.x + ab.x * local_t, a.y + ab.y * local_t);
        let d_sq = proj.distance_sq(pt);
        if d_sq < best_dist_sq {
            best_dist_sq = d_sq;
            best_t = (acc + seg_lengths[idx] * local_t) / total;
        }
        acc += seg_lengths[idx];
    }
    best_t.clamp(0.0, 1.0)
}

pub fn anchor_point(rect: Rect2, side: AnchorSide) -> Point2 {
    match side {
        AnchorSide::N => Point2::new(rect.x + rect.w * 0.5, rect.y),
        AnchorSide::E => Point2::new(rect.x + rect.w, rect.y + rect.h * 0.5),
        AnchorSide::S => Point2::new(rect.x + rect.w * 0.5, rect.y + rect.h),
        AnchorSide::W => Point2::new(rect.x, rect.y + rect.h * 0.5),
    }
}

pub fn auto_anchor_sides(from: Rect2, to: Rect2) -> (AnchorSide, AnchorSide) {
    let fc = from.center();
    let tc = to.center();
    let dx = tc.x - fc.x;
    let dy = tc.y - fc.y;
    if dx.abs() >= dy.abs() {
        if dx >= 0.0 {
            (AnchorSide::E, AnchorSide::W)
        } else {
            (AnchorSide::W, AnchorSide::E)
        }
    } else if dy >= 0.0 {
        (AnchorSide::S, AnchorSide::N)
    } else {
        (AnchorSide::N, AnchorSide::S)
    }
}

pub fn resolve_arrow_endpoints(
    from: &ArrowEndpoint,
    to: &ArrowEndpoint,
    lookup: &HashMap<ElementId, Rect2>,
) -> Option<(Point2, Option<AnchorSide>, Point2, Option<AnchorSide>)> {
    let (from_rect, explicit_from_side, from_free) = match from {
        ArrowEndpoint::Bound { id, side } => (lookup.get(id).copied()?, *side, None),
        ArrowEndpoint::Free(pt) => (Rect2::new(pt.x, pt.y, 0.0, 0.0), None, Some(*pt)),
    };
    let (to_rect, explicit_to_side, to_free) = match to {
        ArrowEndpoint::Bound { id, side } => (lookup.get(id).copied()?, *side, None),
        ArrowEndpoint::Free(pt) => (Rect2::new(pt.x, pt.y, 0.0, 0.0), None, Some(*pt)),
    };
    let (auto_from, auto_to) = auto_anchor_sides(from_rect, to_rect);
    let fs = explicit_from_side.unwrap_or(auto_from);
    let ts = explicit_to_side.unwrap_or(auto_to);
    let start = from_free.unwrap_or_else(|| anchor_point(from_rect, fs));
    let end = to_free.unwrap_or_else(|| anchor_point(to_rect, ts));
    Some((
        start,
        matches!(from, ArrowEndpoint::Bound { .. }).then_some(fs),
        end,
        matches!(to, ArrowEndpoint::Bound { .. }).then_some(ts),
    ))
}

#[derive(Debug, Clone, PartialEq)]
pub enum RouteShape {
    Polyline(Vec<Point2>),
    Cubics(Vec<CubicSegment>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ArrowGeometry {
    pub shape: RouteShape,
    pub start: Point2,
    pub end: Point2,
    pub start_dir: Vec2,
    pub end_dir: Vec2,
    pub label_pos: Point2,
}

impl ArrowGeometry {
    pub fn sample_points(&self) -> Vec<Point2> {
        match &self.shape {
            RouteShape::Polyline(pts) => pts.clone(),
            RouteShape::Cubics(segs) => {
                let mut out = Vec::with_capacity(segs.len() * 16 + 1);
                for (i, seg) in segs.iter().enumerate() {
                    let s = seg.sample(16);
                    if i == 0 {
                        out.extend(s);
                    } else {
                        out.extend(s.into_iter().skip(1));
                    }
                }
                out
            }
        }
    }

    pub fn distance_to_point(&self, pt: Point2) -> f64 {
        let pts = self.sample_points();
        distance_to_polyline(&pts, pt)
    }
}

pub fn distance_to_polyline(points: &[Point2], pt: Point2) -> f64 {
    if points.is_empty() {
        return f64::INFINITY;
    }
    if points.len() == 1 {
        return points[0].distance(pt);
    }
    let mut min_sq = f64::INFINITY;
    for pair in points.windows(2) {
        let d_sq = dist_sq_point_segment(pt, pair[0], pair[1]);
        if d_sq < min_sq {
            min_sq = d_sq;
        }
    }
    min_sq.sqrt()
}

pub fn dist_sq_point_segment(p: Point2, a: Point2, b: Point2) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let len_sq = dx * dx + dy * dy;
    if len_sq <= 1e-9 {
        return p.distance_sq(a);
    }
    let t = (((p.x - a.x) * dx + (p.y - a.y) * dy) / len_sq).clamp(0.0, 1.0);
    let proj = Point2::new(a.x + dx * t, a.y + dy * t);
    p.distance_sq(proj)
}

pub fn route_arrow(from: &ArrowEndpoint, to: &ArrowEndpoint, bends: &[Point2], curve: ArrowCurve, lookup: &HashMap<ElementId, Rect2>) -> Option<ArrowGeometry> {
    let (start, from_side, end, to_side) = resolve_arrow_endpoints(from, to, lookup)?;

    if curve == ArrowCurve::Straight {
        let mut pts = Vec::with_capacity(bends.len() + 2);
        pts.push(start);
        pts.extend(bends.iter().copied());
        pts.push(end);
        let label_pt = sample_polyline(&pts, 0.5);
        let start_dir = (pts[1] - pts[0]).normalized().unwrap_or(Vec2::new(1.0, 0.0));
        let last = pts[pts.len() - 1];
        let prev = pts[pts.len() - 2];
        let end_dir = (last - prev).normalized().unwrap_or(start_dir);
        return Some(ArrowGeometry {
            shape: RouteShape::Polyline(pts),
            start,
            end,
            start_dir,
            end_dir,
            label_pos: Point2::new(label_pt.x, label_pt.y - 10.0),
        });
    }

    if curve == ArrowCurve::Orthogonal {
        let pts = if bends.is_empty() {
            orthogonal_route(start, from_side, end, to_side, from, to, lookup)
        } else {
            let mut raw = Vec::with_capacity(bends.len() + 2);
            raw.push(start);
            raw.extend(bends.iter().copied());
            raw.push(end);
            raw
        };
        let label_pt = sample_polyline(&pts, 0.5);
        let start_dir = (pts.get(1).copied().unwrap_or(end) - start).normalized().unwrap_or(Vec2::new(1.0, 0.0));
        let last = *pts.last().unwrap_or(&end);
        let prev = pts.get(pts.len().saturating_sub(2)).copied().unwrap_or(start);
        let end_dir = (last - prev).normalized().unwrap_or(start_dir);
        return Some(ArrowGeometry {
            shape: RouteShape::Polyline(pts),
            start,
            end,
            start_dir,
            end_dir,
            label_pos: Point2::new(label_pt.x, label_pt.y - 10.0),
        });
    }

    if !bends.is_empty() {
        let mut pts = Vec::with_capacity(bends.len() + 2);
        pts.push(start);
        pts.extend(bends.iter().copied());
        pts.push(end);
        let segs = catmull_rom_cubics(&pts, 0.5);
        let mid_idx = segs.len() / 2;
        let label_pt = segs.get(mid_idx).map_or(start, |s| s.eval(0.5));
        let start_dir = segs.first().and_then(|s| s.tangent(0.0).normalized()).unwrap_or(Vec2::new(1.0, 0.0));
        let end_dir = segs.last().and_then(|s| s.tangent(1.0).normalized()).unwrap_or(start_dir);
        return Some(ArrowGeometry {
            shape: RouteShape::Cubics(segs),
            start,
            end,
            start_dir,
            end_dir,
            label_pos: Point2::new(label_pt.x, label_pt.y - 10.0),
        });
    }

    let dist = start.distance(end);
    let span = (dist * 0.42).clamp(32.0, 140.0);
    let v1 = match from_side {
        Some(side) => side.normal().scale(span),
        None => Vec2::new((end.x - start.x) * 0.35, 0.0),
    };
    let v2 = match to_side {
        Some(side) => side.normal().scale(span),
        None => Vec2::new(-(end.x - start.x) * 0.35, 0.0),
    };
    let seg = CubicSegment {
        p0: start,
        c1: start + v1,
        c2: end + v2,
        p3: end,
    };
    let mid = seg.eval(0.5);
    let start_dir = seg
        .tangent(0.0)
        .normalized()
        .unwrap_or_else(|| (end - start).normalized().unwrap_or(Vec2::new(1.0, 0.0)));
    let end_dir = seg.tangent(1.0).normalized().unwrap_or(start_dir);
    Some(ArrowGeometry {
        shape: RouteShape::Cubics(vec![seg]),
        start,
        end,
        start_dir,
        end_dir,
        label_pos: Point2::new(mid.x, mid.y - 10.0),
    })
}

fn orthogonal_route(
    start: Point2,
    from_side: Option<AnchorSide>,
    end: Point2,
    to_side: Option<AnchorSide>,
    from: &ArrowEndpoint,
    to: &ArrowEndpoint,
    lookup: &HashMap<ElementId, Rect2>,
) -> Vec<Point2> {
    let stub = 28.0;
    let fs = from_side.unwrap_or(if (end.x - start.x).abs() >= (end.y - start.y).abs() {
        if end.x >= start.x { AnchorSide::E } else { AnchorSide::W }
    } else if end.y >= start.y {
        AnchorSide::S
    } else {
        AnchorSide::N
    });
    let ts = to_side.unwrap_or(if (end.x - start.x).abs() >= (end.y - start.y).abs() {
        if end.x >= start.x { AnchorSide::W } else { AnchorSide::E }
    } else if end.y >= start.y {
        AnchorSide::N
    } else {
        AnchorSide::S
    });

    let p1 = start + fs.normal().scale(stub);
    let p2 = end + ts.normal().scale(stub);

    let from_box = match from {
        ArrowEndpoint::Bound { id, .. } => lookup.get(id).copied().map(|r| r.expand(14.0)),
        ArrowEndpoint::Free(_) => None,
    };
    let to_box = match to {
        ArrowEndpoint::Bound { id, .. } => lookup.get(id).copied().map(|r| r.expand(14.0)),
        ArrowEndpoint::Free(_) => None,
    };

    let horiz_first = matches!(fs, AnchorSide::E | AnchorSide::W);
    let horiz_end = matches!(ts, AnchorSide::E | AnchorSide::W);

    let mut pts = vec![start, p1];
    if horiz_first && horiz_end {
        let facing_ok = if fs == AnchorSide::E { p2.x >= p1.x } else { p2.x <= p1.x };
        if facing_ok {
            let mid_x = (p1.x + p2.x) * 0.5;
            pts.push(Point2::new(mid_x, p1.y));
            pts.push(Point2::new(mid_x, p2.y));
        } else {
            // Route cleanly above or below source+target obstacle bounds instead of cutting back through boxes.
            let combined = union_opt(from_box, to_box);
            let detour_y = combined.map_or((p1.y + p2.y) * 0.5, |b| {
                let top_dist = (p1.y - b.y).abs() + (p2.y - b.y).abs();
                let bot_dist = (b.bottom() - p1.y).abs() + (b.bottom() - p2.y).abs();
                if top_dist <= bot_dist { b.y - 20.0 } else { b.bottom() + 20.0 }
            });
            pts.push(Point2::new(p1.x, detour_y));
            pts.push(Point2::new(p2.x, detour_y));
        }
    } else if !horiz_first && !horiz_end {
        let facing_ok = if fs == AnchorSide::S { p2.y >= p1.y } else { p2.y <= p1.y };
        if facing_ok {
            let mid_y = (p1.y + p2.y) * 0.5;
            pts.push(Point2::new(p1.x, mid_y));
            pts.push(Point2::new(p2.x, mid_y));
        } else {
            let combined = union_opt(from_box, to_box);
            let detour_x = combined.map_or((p1.x + p2.x) * 0.5, |b| {
                let left_dist = (p1.x - b.x).abs() + (p2.x - b.x).abs();
                let right_dist = (b.right() - p1.x).abs() + (b.right() - p2.x).abs();
                if left_dist <= right_dist { b.x - 20.0 } else { b.right() + 20.0 }
            });
            pts.push(Point2::new(detour_x, p1.y));
            pts.push(Point2::new(detour_x, p2.y));
        }
    } else if horiz_first {
        pts.push(Point2::new(p2.x, p1.y));
    } else {
        pts.push(Point2::new(p1.x, p2.y));
    }
    pts.push(p2);
    pts.push(end);
    dedup_collinear(pts)
}

fn union_opt(a: Option<Rect2>, b: Option<Rect2>) -> Option<Rect2> {
    match (a, b) {
        (Some(ra), Some(rb)) => Some(ra.union(rb)),
        (Some(r), None) | (None, Some(r)) => Some(r),
        (None, None) => None,
    }
}

fn dedup_collinear(pts: Vec<Point2>) -> Vec<Point2> {
    let mut out: Vec<Point2> = Vec::with_capacity(pts.len());
    for &pt in &pts {
        if out.last().is_some_and(|p| p.distance_sq(pt) < 0.25) {
            continue;
        }
        if out.len() >= 2 {
            let a = out[out.len() - 2];
            let b = out[out.len() - 1];
            let collinear_x = (a.x - b.x).abs() < 0.1 && (b.x - pt.x).abs() < 0.1;
            let collinear_y = (a.y - b.y).abs() < 0.1 && (b.y - pt.y).abs() < 0.1;
            if collinear_x || collinear_y {
                out.pop();
            }
        }
        out.push(pt);
    }
    if out.len() < 2 { pts } else { out }
}

#[derive(Debug, Clone, PartialEq)]
pub enum HeadShape {
    Triangle([Point2; 3]),
    Diamond([Point2; 4]),
    Circle { center: Point2, radius: f64 },
}

pub fn arrowhead_geometry(tip: Point2, dir: Vec2, kind: ArrowHead, scale: f64) -> Option<HeadShape> {
    let unit = dir.normalized()?;
    let perp = unit.perp();
    match kind {
        ArrowHead::None => None,
        ArrowHead::Arrow => {
            let len = 10.5 * scale;
            let half_w = 4.6 * scale;
            let base = Point2::new(tip.x - unit.x * len, tip.y - unit.y * len);
            let left = Point2::new(base.x + perp.x * half_w, base.y + perp.y * half_w);
            let right = Point2::new(base.x - perp.x * half_w, base.y - perp.y * half_w);
            Some(HeadShape::Triangle([tip, left, right]))
        }
        ArrowHead::Diamond => {
            let len = 12.0 * scale;
            let half_w = 5.0 * scale;
            let mid = Point2::new(tip.x - unit.x * (len * 0.5), tip.y - unit.y * (len * 0.5));
            let back = Point2::new(tip.x - unit.x * len, tip.y - unit.y * len);
            let left = Point2::new(mid.x + perp.x * half_w, mid.y + perp.y * half_w);
            let right = Point2::new(mid.x - perp.x * half_w, mid.y - perp.y * half_w);
            Some(HeadShape::Diamond([tip, left, back, right]))
        }
        ArrowHead::Dot => {
            let radius = 3.8 * scale;
            let center = Point2::new(tip.x - unit.x * radius, tip.y - unit.y * radius);
            Some(HeadShape::Circle { center, radius })
        }
    }
}

pub fn rotate_point(pt: Point2, origin: Point2, angle_deg: f64) -> Point2 {
    if angle_deg.abs() <= 1e-6 {
        return pt;
    }
    let rad = angle_deg.to_radians();
    let (sin, cos) = rad.sin_cos();
    let dx = pt.x - origin.x;
    let dy = pt.y - origin.y;
    Point2::new(origin.x + dx * cos - dy * sin, origin.y + dx * sin + dy * cos)
}

pub fn unrotate_point(pt: Point2, origin: Point2, angle_deg: f64) -> Point2 {
    rotate_point(pt, origin, -angle_deg)
}

pub fn rotated_bbox(rect: Rect2, angle_deg: f64) -> Rect2 {
    if angle_deg.abs() <= 1e-6 {
        return rect;
    }
    let center = rect.center();
    let corners = [
        rotate_point(Point2::new(rect.x, rect.y), center, angle_deg),
        rotate_point(Point2::new(rect.right(), rect.y), center, angle_deg),
        rotate_point(Point2::new(rect.right(), rect.bottom()), center, angle_deg),
        rotate_point(Point2::new(rect.x, rect.bottom()), center, angle_deg),
    ];
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for c in corners {
        min_x = min_x.min(c.x);
        min_y = min_y.min(c.y);
        max_x = max_x.max(c.x);
        max_y = max_y.max(c.y);
    }
    Rect2::new(min_x, min_y, max_x - min_x, max_y - min_y)
}
