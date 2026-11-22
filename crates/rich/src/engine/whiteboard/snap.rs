use std::collections::{BTreeSet, HashMap};

use crate::engine::whiteboard::hit::ResizeHandle8;
use crate::engine::whiteboard::model::{BoardDoc, ElementId, Point2, Rect2, Vec2};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapAxis {
    X,
    Y,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SnapGuide {
    Align {
        axis: SnapAxis,
        coord: f64,
        span_min: f64,
        span_max: f64,
    },
    Spacing {
        axis: SnapAxis,
        cross_coord: f64,
        start: f64,
        end: f64,
        gap: f64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SnapConfig {
    pub snap_to_grid: bool,
    pub grid_step: f64,
    pub snap_to_objects: bool,
    pub threshold_world: f64,
}

impl Default for SnapConfig {
    fn default() -> Self {
        Self {
            snap_to_grid: false,
            grid_step: 24.0,
            snap_to_objects: true,
            threshold_world: 7.0,
        }
    }
}

pub fn snap_scalar(v: f64, step: f64) -> f64 {
    if step <= 0.0 || !v.is_finite() {
        return v;
    }
    (v / step).round() * step
}

pub fn compute_move_snap(
    doc: &BoardDoc,
    lookup: &HashMap<ElementId, Rect2>,
    moving_ids: &[ElementId],
    proposed_rect: Rect2,
    cfg: &SnapConfig,
) -> (Vec2, Vec<SnapGuide>) {
    let moving: BTreeSet<&ElementId> = moving_ids.iter().collect();
    let mut dx = 0.0;
    let mut dy = 0.0;
    let mut guides = Vec::new();

    if cfg.snap_to_objects {
        let mut best_x: Option<(f64, f64, f64, f64)> = None;
        let mut best_y: Option<(f64, f64, f64, f64)> = None;

        let prop_xs = [proposed_rect.x, proposed_rect.center().x, proposed_rect.right()];
        let prop_ys = [proposed_rect.y, proposed_rect.center().y, proposed_rect.bottom()];

        for el in &doc.elements {
            if moving.contains(&el.id) || el.is_arrow() {
                continue;
            }
            let Some(&other) = lookup.get(&el.id) else {
                continue;
            };
            let other_xs = [other.x, other.center().x, other.right()];
            let other_ys = [other.y, other.center().y, other.bottom()];

            for &px in &prop_xs {
                for &ox in &other_xs {
                    let delta = ox - px;
                    if delta.abs() <= cfg.threshold_world && best_x.is_none_or(|b| delta.abs() < b.0.abs()) {
                        let smin = proposed_rect.y.min(other.y) - 16.0;
                        let smax = proposed_rect.bottom().max(other.bottom()) + 16.0;
                        best_x = Some((delta, ox, smin, smax));
                    }
                }
            }
            for &py in &prop_ys {
                for &oy in &other_ys {
                    let delta = oy - py;
                    if delta.abs() <= cfg.threshold_world && best_y.is_none_or(|b| delta.abs() < b.0.abs()) {
                        let smin = proposed_rect.x.min(other.x) - 16.0;
                        let smax = proposed_rect.right().max(other.right()) + 16.0;
                        best_y = Some((delta, oy, smin, smax));
                    }
                }
            }
        }

        if let Some((d, coord, span_min, span_max)) = best_x {
            dx = d;
            guides.push(SnapGuide::Align {
                axis: SnapAxis::X,
                coord,
                span_min,
                span_max,
            });
        }
        if let Some((d, coord, span_min, span_max)) = best_y {
            dy = d;
            guides.push(SnapGuide::Align {
                axis: SnapAxis::Y,
                coord,
                span_min,
                span_max,
            });
        }

        let snapped_rect = Rect2::new(proposed_rect.x + dx, proposed_rect.y + dy, proposed_rect.w, proposed_rect.h);
        detect_spacing_guides(doc, lookup, &moving, snapped_rect, &mut guides);
    }

    if cfg.snap_to_grid {
        if dx == 0.0 {
            let sx = snap_scalar(proposed_rect.x, cfg.grid_step);
            dx = sx - proposed_rect.x;
        }
        if dy == 0.0 {
            let sy = snap_scalar(proposed_rect.y, cfg.grid_step);
            dy = sy - proposed_rect.y;
        }
    }

    (Vec2::new(dx, dy), guides)
}

fn detect_spacing_guides(doc: &BoardDoc, lookup: &HashMap<ElementId, Rect2>, moving: &BTreeSet<&ElementId>, snapped: Rect2, guides: &mut Vec<SnapGuide>) {
    let mut horiz_others: Vec<Rect2> = doc
        .elements
        .iter()
        .filter(|e| !moving.contains(&e.id) && !e.is_arrow() && !e.is_container())
        .filter_map(|e| lookup.get(&e.id).copied())
        .filter(|r| r.bottom() >= snapped.y - 20.0 && r.y <= snapped.bottom() + 20.0)
        .collect();
    horiz_others.sort_by(|a, b| a.x.total_cmp(&b.x));

    let left_idx = horiz_others.iter().rposition(|r| r.right() <= snapped.x + 1.0);
    let right_idx = horiz_others.iter().position(|r| r.x >= snapped.right() - 1.0);

    if let (Some(li), Some(ri)) = (left_idx, right_idx) {
        let l = horiz_others[li];
        let r = horiz_others[ri];
        let gap_l = snapped.x - l.right();
        let gap_r = r.x - snapped.right();
        if gap_l >= 4.0 && (gap_l - gap_r).abs() <= 4.0 {
            let cy = snapped.center().y;
            guides.push(SnapGuide::Spacing {
                axis: SnapAxis::X,
                cross_coord: cy,
                start: l.right(),
                end: snapped.x,
                gap: gap_l.round(),
            });
            guides.push(SnapGuide::Spacing {
                axis: SnapAxis::X,
                cross_coord: cy,
                start: snapped.right(),
                end: r.x,
                gap: gap_r.round(),
            });
            return;
        }
    }

    if let Some(li) = left_idx
        && li >= 1
    {
        let l2 = horiz_others[li - 1];
        let l1 = horiz_others[li];
        let gap_prev = l1.x - l2.right();
        let gap_cur = snapped.x - l1.right();
        if gap_prev >= 4.0 && (gap_prev - gap_cur).abs() <= 4.0 {
            let cy = snapped.center().y;
            guides.push(SnapGuide::Spacing {
                axis: SnapAxis::X,
                cross_coord: cy,
                start: l2.right(),
                end: l1.x,
                gap: gap_prev.round(),
            });
            guides.push(SnapGuide::Spacing {
                axis: SnapAxis::X,
                cross_coord: cy,
                start: l1.right(),
                end: snapped.x,
                gap: gap_cur.round(),
            });
            return;
        }
    }

    if let Some(ri) = right_idx
        && ri + 1 < horiz_others.len()
    {
        let r1 = horiz_others[ri];
        let r2 = horiz_others[ri + 1];
        let gap_cur = r1.x - snapped.right();
        let gap_next = r2.x - r1.right();
        if gap_next >= 4.0 && (gap_cur - gap_next).abs() <= 4.0 {
            let cy = snapped.center().y;
            guides.push(SnapGuide::Spacing {
                axis: SnapAxis::X,
                cross_coord: cy,
                start: snapped.right(),
                end: r1.x,
                gap: gap_cur.round(),
            });
            guides.push(SnapGuide::Spacing {
                axis: SnapAxis::X,
                cross_coord: cy,
                start: r1.right(),
                end: r2.x,
                gap: gap_next.round(),
            });
        }
    }
}

pub fn compute_resize_snap(
    doc: &BoardDoc,
    lookup: &HashMap<ElementId, Rect2>,
    id: &ElementId,
    handle: ResizeHandle8,
    mut proposed: Rect2,
    cfg: &SnapConfig,
) -> (Rect2, Vec<SnapGuide>) {
    let mut guides = Vec::new();
    let touches_left = matches!(handle, ResizeHandle8::Nw | ResizeHandle8::W | ResizeHandle8::Sw);
    let touches_right = matches!(handle, ResizeHandle8::Ne | ResizeHandle8::E | ResizeHandle8::Se);
    let touches_top = matches!(handle, ResizeHandle8::Nw | ResizeHandle8::N | ResizeHandle8::Ne);
    let touches_bottom = matches!(handle, ResizeHandle8::Sw | ResizeHandle8::S | ResizeHandle8::Se);

    if cfg.snap_to_objects {
        for el in &doc.elements {
            if &el.id == id || el.is_arrow() {
                continue;
            }
            let Some(&other) = lookup.get(&el.id) else {
                continue;
            };
            if touches_left {
                for ox in [other.x, other.right()] {
                    if (ox - proposed.x).abs() <= cfg.threshold_world {
                        let new_w = (proposed.right() - ox).max(24.0);
                        proposed.x = proposed.right() - new_w;
                        proposed.w = new_w;
                        guides.push(SnapGuide::Align {
                            axis: SnapAxis::X,
                            coord: ox,
                            span_min: proposed.y.min(other.y),
                            span_max: proposed.bottom().max(other.bottom()),
                        });
                        break;
                    }
                }
            } else if touches_right {
                for ox in [other.x, other.right()] {
                    if (ox - proposed.right()).abs() <= cfg.threshold_world {
                        proposed.w = (ox - proposed.x).max(24.0);
                        guides.push(SnapGuide::Align {
                            axis: SnapAxis::X,
                            coord: ox,
                            span_min: proposed.y.min(other.y),
                            span_max: proposed.bottom().max(other.bottom()),
                        });
                        break;
                    }
                }
            }
            if touches_top {
                for oy in [other.y, other.bottom()] {
                    if (oy - proposed.y).abs() <= cfg.threshold_world {
                        let new_h = (proposed.bottom() - oy).max(24.0);
                        proposed.y = proposed.bottom() - new_h;
                        proposed.h = new_h;
                        guides.push(SnapGuide::Align {
                            axis: SnapAxis::Y,
                            coord: oy,
                            span_min: proposed.x.min(other.x),
                            span_max: proposed.right().max(other.right()),
                        });
                        break;
                    }
                }
            } else if touches_bottom {
                for oy in [other.y, other.bottom()] {
                    if (oy - proposed.bottom()).abs() <= cfg.threshold_world {
                        proposed.h = (oy - proposed.y).max(24.0);
                        guides.push(SnapGuide::Align {
                            axis: SnapAxis::Y,
                            coord: oy,
                            span_min: proposed.x.min(other.x),
                            span_max: proposed.right().max(other.right()),
                        });
                        break;
                    }
                }
            }
        }
    }

    if cfg.snap_to_grid {
        if touches_right {
            proposed.w = (snap_scalar(proposed.right(), cfg.grid_step) - proposed.x).max(24.0);
        }
        if touches_bottom {
            proposed.h = (snap_scalar(proposed.bottom(), cfg.grid_step) - proposed.y).max(24.0);
        }
    }

    (proposed, guides)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlignOp {
    Left,
    CenterH,
    Right,
    Top,
    CenterV,
    Bottom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DistributeAxis {
    Horizontal,
    Vertical,
}

pub fn compute_align_deltas(doc: &BoardDoc, ids: &[ElementId], op: AlignOp) -> Vec<(ElementId, Vec2)> {
    if ids.len() < 2 {
        return Vec::new();
    }
    let lookup = doc.rect_lookup();
    let rects: Vec<(ElementId, Rect2)> = ids
        .iter()
        .filter_map(|id| {
            doc.element(id)
                .filter(|e| !e.locked)
                .and_then(|e| lookup.get(&e.id).map(|r| (e.id.clone(), *r)))
        })
        .collect();
    if rects.len() < 2 {
        return Vec::new();
    }

    let min_x = rects.iter().map(|(_, r)| r.x).fold(f64::INFINITY, f64::min);
    let max_r = rects.iter().map(|(_, r)| r.right()).fold(f64::NEG_INFINITY, f64::max);
    let min_y = rects.iter().map(|(_, r)| r.y).fold(f64::INFINITY, f64::min);
    let max_b = rects.iter().map(|(_, r)| r.bottom()).fold(f64::NEG_INFINITY, f64::max);
    let mid_x = (min_x + max_r) * 0.5;
    let mid_y = (min_y + max_b) * 0.5;

    rects
        .into_iter()
        .map(|(id, r)| {
            let delta = match op {
                AlignOp::Left => Vec2::new(min_x - r.x, 0.0),
                AlignOp::CenterH => Vec2::new(mid_x - r.center().x, 0.0),
                AlignOp::Right => Vec2::new(max_r - r.right(), 0.0),
                AlignOp::Top => Vec2::new(0.0, min_y - r.y),
                AlignOp::CenterV => Vec2::new(0.0, mid_y - r.center().y),
                AlignOp::Bottom => Vec2::new(0.0, max_b - r.bottom()),
            };
            (id, delta)
        })
        .collect()
}

pub fn compute_distribute_deltas(doc: &BoardDoc, ids: &[ElementId], axis: DistributeAxis) -> Vec<(ElementId, Vec2)> {
    if ids.len() < 3 {
        return Vec::new();
    }
    let lookup = doc.rect_lookup();
    let mut items: Vec<(ElementId, Rect2)> = ids
        .iter()
        .filter_map(|id| {
            doc.element(id)
                .filter(|e| !e.locked)
                .and_then(|e| lookup.get(&e.id).map(|r| (e.id.clone(), *r)))
        })
        .collect();
    if items.len() < 3 {
        return Vec::new();
    }

    match axis {
        DistributeAxis::Horizontal => {
            items.sort_by(|a, b| a.1.x.total_cmp(&b.1.x));
            let start_x = items.first().map_or(0.0, |i| i.1.x);
            let end_right = items.last().map_or(0.0, |i| i.1.right());
            let total_w: f64 = items.iter().map(|(_, r)| r.w).sum();
            let gap = ((end_right - start_x) - total_w) / ((items.len() - 1) as f64);
            let mut cursor = start_x;
            items
                .into_iter()
                .map(|(id, r)| {
                    let delta = Vec2::new(cursor - r.x, 0.0);
                    cursor += r.w + gap;
                    (id, delta)
                })
                .collect()
        }
        DistributeAxis::Vertical => {
            items.sort_by(|a, b| a.1.y.total_cmp(&b.1.y));
            let start_y = items.first().map_or(0.0, |i| i.1.y);
            let end_bottom = items.last().map_or(0.0, |i| i.1.bottom());
            let total_h: f64 = items.iter().map(|(_, r)| r.h).sum();
            let gap = ((end_bottom - start_y) - total_h) / ((items.len() - 1) as f64);
            let mut cursor = start_y;
            items
                .into_iter()
                .map(|(id, r)| {
                    let delta = Vec2::new(0.0, cursor - r.y);
                    cursor += r.h + gap;
                    (id, delta)
                })
                .collect()
        }
    }
}

pub fn compute_tidy_grid_deltas(doc: &BoardDoc, ids: &[ElementId], gap: f64) -> Vec<(ElementId, Vec2)> {
    if ids.len() < 2 {
        return Vec::new();
    }
    let lookup = doc.rect_lookup();
    let mut items: Vec<(ElementId, Rect2)> = ids
        .iter()
        .filter_map(|id| {
            doc.element(id)
                .filter(|e| !e.locked && !e.is_arrow())
                .and_then(|e| lookup.get(&e.id).map(|r| (e.id.clone(), *r)))
        })
        .collect();
    if items.len() < 2 {
        return Vec::new();
    }
    items.sort_by(|a, b| a.1.y.total_cmp(&b.1.y).then_with(|| a.1.x.total_cmp(&b.1.x)));
    let cols = (items.len() as f64).sqrt().ceil().max(1.0) as usize;
    let origin_x = items.iter().map(|(_, r)| r.x).fold(f64::INFINITY, f64::min);
    let origin_y = items.iter().map(|(_, r)| r.y).fold(f64::INFINITY, f64::min);
    let cell_w = items.iter().map(|(_, r)| r.w).fold(0.0_f64, f64::max);
    let cell_h = items.iter().map(|(_, r)| r.h).fold(0.0_f64, f64::max);

    items
        .into_iter()
        .enumerate()
        .map(|(idx, (id, r))| {
            let col = idx % cols;
            let row = idx / cols;
            let target_x = origin_x + col as f64 * (cell_w + gap);
            let target_y = origin_y + row as f64 * (cell_h + gap);
            (id, Vec2::new(target_x - r.x, target_y - r.y))
        })
        .collect()
}

pub fn nudge_step(shift: bool) -> f64 {
    if shift { 10.0 } else { 1.0 }
}

pub fn round_point(pt: Point2) -> Point2 {
    Point2::new(pt.x.round(), pt.y.round())
}
