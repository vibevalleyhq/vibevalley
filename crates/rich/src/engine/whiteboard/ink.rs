use crate::engine::whiteboard::geometry::{dist_sq_point_segment, distance_to_polyline};
use crate::engine::whiteboard::model::{BoardDoc, ElementId, ElementKind, InkMode, Point2, StrokePoint};

pub fn simplify_stroke_points(points: &[StrokePoint], tolerance: f64) -> Vec<StrokePoint> {
    if points.len() <= 2 {
        return points.to_vec();
    }
    let first = points[0];
    let last = *points.last().unwrap_or(&first);
    let tol_sq = tolerance * tolerance;
    let mut max_dist_sq = 0.0;
    let mut split_idx = 0usize;

    for (i, p) in points.iter().enumerate().take(points.len() - 1).skip(1) {
        let d_sq = dist_sq_point_segment(p.point2(), first.point2(), last.point2());
        if d_sq > max_dist_sq {
            max_dist_sq = d_sq;
            split_idx = i;
        }
    }

    if max_dist_sq > tol_sq && split_idx > 0 {
        let mut left = simplify_stroke_points(&points[..=split_idx], tolerance);
        let right = simplify_stroke_points(&points[split_idx..], tolerance);
        left.pop();
        left.extend(right);
        left
    } else {
        vec![first, last]
    }
}

/// Generates a closed smooth contour polygon whose local half-width varies with pen pressure and speed.
pub fn build_ink_outline(points: &[StrokePoint], base_width: f32, mode: InkMode) -> Vec<Point2> {
    if points.is_empty() {
        return Vec::new();
    }
    let size = f64::from(base_width.max(1.0));
    if points.len() == 1 {
        let c = points[0].point2();
        let r = size * 0.5;
        return (0..8)
            .map(|i| {
                let a = (i as f64) * std::f64::consts::TAU / 8.0;
                Point2::new(c.x + a.cos() * r, c.y + a.sin() * r)
            })
            .collect();
    }

    let mut left_pts = Vec::with_capacity(points.len() + 2);
    let mut right_pts = Vec::with_capacity(points.len() + 2);
    let count = points.len();

    for i in 0..count {
        let p = points[i];
        let prev = points[i.saturating_sub(1)];
        let next = points[(i + 1).min(count - 1)];
        let tx = next.x - prev.x;
        let ty = next.y - prev.y;
        let t_len = (tx * tx + ty * ty).sqrt().max(1e-6);
        let nx = -ty / t_len;
        let ny = tx / t_len;

        let seg_len = p.point2().distance(prev.point2());
        let progress = i as f64 / (count - 1).max(1) as f64;
        let taper = if mode == InkMode::Highlighter {
            1.0
        } else {
            let start_taper = (progress * 7.0).min(1.0);
            let end_taper = ((1.0 - progress) * 7.0).min(1.0);
            start_taper.min(end_taper).max(0.35)
        };
        let pressure_factor = if mode == InkMode::Highlighter {
            1.0
        } else {
            let speed_thinning = (1.0 - (seg_len / 48.0).min(0.45)) * 0.5 + 0.5;
            (0.55 + f64::from(p.pressure.clamp(0.1, 1.0)) * 0.85) * speed_thinning
        };

        let half_w = (size * 0.5) * pressure_factor * taper;
        left_pts.push(Point2::new(p.x + nx * half_w, p.y + ny * half_w));
        right_pts.push(Point2::new(p.x - nx * half_w, p.y - ny * half_w));
    }

    let mut polygon = Vec::with_capacity(left_pts.len() + right_pts.len());
    polygon.extend(left_pts);
    polygon.extend(right_pts.into_iter().rev());
    polygon
}

pub fn strokes_hit_by_eraser(doc: &BoardDoc, eraser_path: &[Point2], radius: f64) -> Vec<ElementId> {
    if eraser_path.is_empty() {
        return Vec::new();
    }
    let mut hit = Vec::new();
    for el in &doc.elements {
        if el.locked {
            continue;
        }
        if let ElementKind::Path { points, stroke_width, .. } = &el.kind {
            let pts: Vec<Point2> = points.iter().map(|p| p.point2()).collect();
            let tol = radius + f64::from(*stroke_width) * 0.5;
            let touched = eraser_path.iter().any(|ep| distance_to_polyline(&pts, *ep) <= tol);
            if touched {
                hit.push(el.id.clone());
            }
        }
    }
    hit
}
