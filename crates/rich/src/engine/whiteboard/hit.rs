use std::collections::{BTreeSet, HashMap};

use crate::engine::whiteboard::geometry::{anchor_point, dist_sq_point_segment, rotate_point, route_arrow, sample_polyline, unrotate_point};
use crate::engine::whiteboard::model::{AnchorSide, BoardDoc, ElementId, ElementKind, Point2, Rect2};
use crate::engine::whiteboard::spatial::SpatialIndex;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ResizeHandle8 {
    Nw,
    N,
    Ne,
    E,
    Se,
    S,
    Sw,
    W,
}

impl ResizeHandle8 {
    pub const ALL: [Self; 8] = [Self::Nw, Self::N, Self::Ne, Self::E, Self::Se, Self::S, Self::Sw, Self::W];

    pub fn position_on(self, r: Rect2) -> Point2 {
        match self {
            Self::Nw => Point2::new(r.x, r.y),
            Self::N => Point2::new(r.x + r.w * 0.5, r.y),
            Self::Ne => Point2::new(r.right(), r.y),
            Self::E => Point2::new(r.right(), r.y + r.h * 0.5),
            Self::Se => Point2::new(r.right(), r.bottom()),
            Self::S => Point2::new(r.x + r.w * 0.5, r.bottom()),
            Self::Sw => Point2::new(r.x, r.bottom()),
            Self::W => Point2::new(r.x, r.y + r.h * 0.5),
        }
    }

    pub fn opposite_anchor(self, r: Rect2) -> Point2 {
        self.opposite().position_on(r)
    }

    pub fn opposite(self) -> Self {
        match self {
            Self::Nw => Self::Se,
            Self::N => Self::S,
            Self::Ne => Self::Sw,
            Self::E => Self::W,
            Self::Se => Self::Nw,
            Self::S => Self::N,
            Self::Sw => Self::Ne,
            Self::W => Self::E,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HitTarget {
    RotateHandle(ElementId),
    ResizeHandle { id: ElementId, handle: ResizeHandle8 },
    AnchorPort { id: ElementId, side: AnchorSide },
    ArrowEndpoint { id: ElementId, is_start: bool },
    ArrowBend { id: ElementId, index: usize },
    TimelineControl { id: ElementId, index: usize },
    TimelineMilestone { id: ElementId, index: usize },
    ContainerHeader(ElementId),
    Element(ElementId),
    Background,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HitConfig {
    pub zoom: f64,
    pub handle_radius_px: f64,
    pub rotate_offset_px: f64,
    pub port_radius_px: f64,
    pub port_offset_px: f64,
    pub stroke_tolerance_px: f64,
    pub show_ports: bool,
}

impl Default for HitConfig {
    fn default() -> Self {
        Self {
            zoom: 1.0,
            handle_radius_px: 7.0,
            rotate_offset_px: 26.0,
            port_radius_px: 8.5,
            port_offset_px: 14.0,
            stroke_tolerance_px: 8.0,
            show_ports: true,
        }
    }
}

pub fn rotate_handle_pos(rect: Rect2, rotation_deg: f64, world_offset: f64) -> Point2 {
    let top_mid = Point2::new(rect.x + rect.w * 0.5, rect.y - world_offset);
    rotate_point(top_mid, rect.center(), rotation_deg)
}

pub fn anchor_port_pos(rect: Rect2, side: AnchorSide, world_outward_offset: f64) -> Point2 {
    anchor_point(rect, side) + side.normal().scale(world_outward_offset)
}

pub fn container_header_rect(rect: Rect2) -> Rect2 {
    Rect2::new(rect.x, rect.y - 26.0, rect.w.min(280.0), 44.0)
}

pub fn hit_test(
    doc: &BoardDoc,
    lookup: &HashMap<ElementId, Rect2>,
    selection: &[ElementId],
    hovered_element: Option<&ElementId>,
    world_pt: Point2,
    cfg: &HitConfig,
) -> HitTarget {
    let zoom = cfg.zoom.max(0.1);
    let handle_r_sq = (cfg.handle_radius_px / zoom).powi(2);
    let port_r_sq = (cfg.port_radius_px / zoom).powi(2);
    let port_offset = cfg.port_offset_px / zoom;
    let rotate_offset = cfg.rotate_offset_px / zoom;
    let stroke_tol = cfg.stroke_tolerance_px / zoom;

    // 1. Handles of currently selected elements (top priority).
    if selection.len() == 1
        && let Some(sel_id) = selection.first()
        && let Some(el) = doc.element(sel_id)
    {
        match &el.kind {
            ElementKind::Arrow { from, to, bends, curve, .. } => {
                if let Some(geom) = route_arrow(from, to, bends, *curve, lookup) {
                    if geom.start.distance_sq(world_pt) <= handle_r_sq * 1.4 {
                        return HitTarget::ArrowEndpoint {
                            id: el.id.clone(),
                            is_start: true,
                        };
                    }
                    if geom.end.distance_sq(world_pt) <= handle_r_sq * 1.4 {
                        return HitTarget::ArrowEndpoint {
                            id: el.id.clone(),
                            is_start: false,
                        };
                    }
                    for (idx, bend) in bends.iter().enumerate() {
                        if bend.distance_sq(world_pt) <= handle_r_sq * 1.3 {
                            return HitTarget::ArrowBend { id: el.id.clone(), index: idx };
                        }
                    }
                }
            }
            ElementKind::Timeline { points, milestones, .. } => {
                for (idx, m) in milestones.iter().enumerate() {
                    let pt = m
                        .pos
                        .unwrap_or_else(|| sample_polyline(points, m.t.unwrap_or((idx + 1) as f64 / (milestones.len() + 1) as f64)));
                    if pt.distance_sq(world_pt) <= (handle_r_sq * 2.0).max(169.0) {
                        return HitTarget::TimelineMilestone { id: el.id.clone(), index: idx };
                    }
                }
                for (idx, p) in points.iter().enumerate() {
                    if p.distance_sq(world_pt) <= handle_r_sq * 1.4 {
                        return HitTarget::TimelineControl { id: el.id.clone(), index: idx };
                    }
                }
            }
            _ if !el.locked => {
                if let Some(&rect) = lookup.get(&el.id) {
                    if !matches!(el.kind, ElementKind::Container { .. }) {
                        let rot_pos = rotate_handle_pos(rect, el.rotation_deg, rotate_offset);
                        if rot_pos.distance_sq(world_pt) <= handle_r_sq * 1.3 {
                            return HitTarget::RotateHandle(el.id.clone());
                        }
                    }
                    let local_pt = unrotate_point(world_pt, rect.center(), el.rotation_deg);
                    let mut best: Option<(ResizeHandle8, f64)> = None;
                    for handle in ResizeHandle8::ALL {
                        let d_sq = handle.position_on(rect).distance_sq(local_pt);
                        if d_sq <= handle_r_sq && best.is_none_or(|(_, bd)| d_sq < bd) {
                            best = Some((handle, d_sq));
                        }
                    }
                    if let Some((handle, _)) = best {
                        return HitTarget::ResizeHandle { id: el.id.clone(), handle };
                    }
                }
            }
            _ => {}
        }
    }

    // 2. Connection anchor ports on selected or hovered shapes/cards.
    if cfg.show_ports {
        for cand_id in selection.iter().chain(hovered_element) {
            let Some(el) = doc.element(cand_id) else {
                continue;
            };
            if !can_host_anchor_port(&el.kind) {
                continue;
            }
            let Some(&rect) = lookup.get(&el.id) else {
                continue;
            };
            let local_pt = unrotate_point(world_pt, rect.center(), el.rotation_deg);
            for side in AnchorSide::ALL {
                if anchor_port_pos(rect, side, port_offset).distance_sq(local_pt) <= port_r_sq {
                    return HitTarget::AnchorPort { id: el.id.clone(), side };
                }
            }
        }
    }

    // 3. Elements in reverse z-order (foreground first; containers checked only by header or last).
    for el in doc.elements.iter().rev() {
        if el.is_container() {
            continue;
        }
        match &el.kind {
            ElementKind::Arrow {
                from,
                to,
                bends,
                curve,
                stroke_width,
                ..
            } => {
                if let Some(geom) = route_arrow(from, to, bends, *curve, lookup) {
                    let tol = stroke_tol.max(f64::from(*stroke_width) * 0.5 + 3.0);
                    if geom.distance_to_point(world_pt) <= tol {
                        return HitTarget::Element(el.id.clone());
                    }
                }
            }
            ElementKind::Path { points, stroke_width, .. } => {
                let pts: Vec<Point2> = points.iter().map(|p| p.point2()).collect();
                let tol = stroke_tol.max(f64::from(*stroke_width) * 0.75 + 2.0);
                if crate::engine::whiteboard::geometry::distance_to_polyline(&pts, world_pt) <= tol {
                    return HitTarget::Element(el.id.clone());
                }
            }
            ElementKind::Timeline { points, milestones, .. } => {
                if points.len() >= 2 {
                    for (idx, m) in milestones.iter().enumerate() {
                        let pt = m
                            .pos
                            .unwrap_or_else(|| sample_polyline(points, m.t.unwrap_or((idx + 1) as f64 / (milestones.len() + 1) as f64)));
                        if pt.distance_sq(world_pt) <= 18.0_f64.powi(2) {
                            return HitTarget::TimelineMilestone { id: el.id.clone(), index: idx };
                        }
                    }
                    let dense: Vec<Point2> = (0..=40).map(|i| sample_polyline(points, i as f64 / 40.0)).collect();
                    if crate::engine::whiteboard::geometry::distance_to_polyline(&dense, world_pt) <= stroke_tol + 6.0 {
                        return HitTarget::Element(el.id.clone());
                    }
                }
            }
            _ => {
                if let Some(&rect) = lookup.get(&el.id) {
                    let local_pt = unrotate_point(world_pt, rect.center(), el.rotation_deg);
                    if rect.contains_point(local_pt) {
                        return HitTarget::Element(el.id.clone());
                    }
                }
            }
        }
    }

    // 4. Container headers and border edges (hollow interior falls through to Background for marquee selection).
    let border_tol = (8.0 / zoom).max(4.0);
    for el in doc.elements.iter().rev() {
        if let ElementKind::Container { .. } = &el.kind
            && let Some(&rect) = lookup.get(&el.id)
        {
            if container_header_rect(rect).contains_point(world_pt) {
                return HitTarget::ContainerHeader(el.id.clone());
            }
            let near_border = rect.expand(border_tol * 0.5).contains_point(world_pt) && !rect.expand(-border_tol).contains_point(world_pt);
            if near_border {
                return HitTarget::Element(el.id.clone());
            }
        }
    }

    HitTarget::Background
}

pub fn can_host_anchor_port(kind: &ElementKind) -> bool {
    matches!(
        kind,
        ElementKind::Shape { .. } | ElementKind::Text { .. } | ElementKind::Container { .. } | ElementKind::Table { .. } | ElementKind::Image { .. }
    )
}

pub fn snap_anchor_endpoint(
    doc: &BoardDoc,
    lookup: &HashMap<ElementId, Rect2>,
    world_pt: Point2,
    exclude_id: Option<&ElementId>,
    world_radius: f64,
) -> Option<(ElementId, AnchorSide, Point2)> {
    let r_sq = world_radius * world_radius;
    let mut best: Option<(ElementId, AnchorSide, Point2, f64)> = None;
    for el in doc.elements.iter().rev() {
        if Some(&el.id) == exclude_id || !can_host_anchor_port(&el.kind) {
            continue;
        }
        let Some(&rect) = lookup.get(&el.id) else {
            continue;
        };
        let local_pt = unrotate_point(world_pt, rect.center(), el.rotation_deg);
        for side in AnchorSide::ALL {
            let p_local = anchor_point(rect, side);
            let p_world = rotate_point(p_local, rect.center(), el.rotation_deg);
            let d_sq = p_local.distance_sq(local_pt);
            if d_sq <= r_sq && best.as_ref().is_none_or(|b| d_sq < b.3) {
                best = Some((el.id.clone(), side, p_world, d_sq));
            }
        }
        // Also snap to nearest side when hovering inside the element's interior.
        if rect.contains_point(local_pt) && best.is_none() {
            let side = AnchorSide::ALL
                .into_iter()
                .min_by(|a, b| {
                    let da = anchor_point(rect, *a).distance_sq(local_pt);
                    let db = anchor_point(rect, *b).distance_sq(local_pt);
                    da.total_cmp(&db)
                })
                .unwrap_or(AnchorSide::E);
            let p_world = rotate_point(anchor_point(rect, side), rect.center(), el.rotation_deg);
            return Some((el.id.clone(), side, p_world));
        }
    }
    best.map(|(id, side, pt, _)| (id, side, pt))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarqueeMode {
    Contained,
    Intersects,
}

pub fn marquee_select(doc: &BoardDoc, spatial: &SpatialIndex, lookup: &HashMap<ElementId, Rect2>, start: Point2, end: Point2) -> Vec<ElementId> {
    let box_rect = Rect2::from_corners(start, end);
    let mode = if end.x >= start.x { MarqueeMode::Contained } else { MarqueeMode::Intersects };
    let candidates = spatial.query_rect(box_rect);
    let mut selected = Vec::new();
    for idx in candidates {
        let Some(el) = doc.elements.get(idx) else {
            continue;
        };
        if el.is_container() {
            continue;
        }
        let rect = match mode {
            MarqueeMode::Contained => el.bbox(lookup),
            MarqueeMode::Intersects => el.visual_bbox(lookup),
        };
        let hits = match mode {
            MarqueeMode::Contained => box_rect.contains_rect(rect),
            MarqueeMode::Intersects => box_rect.intersects(rect),
        };
        if hits {
            selected.push(el.id.clone());
        }
    }
    selected
}

pub fn container_at_point(doc: &BoardDoc, lookup: &HashMap<ElementId, Rect2>, pt: Point2, exclude: &BTreeSet<ElementId>) -> Option<ElementId> {
    for el in doc.elements.iter().rev() {
        if el.is_container() && !exclude.contains(&el.id) && lookup.get(&el.id).is_some_and(|r| r.contains_point(pt)) {
            return Some(el.id.clone());
        }
    }
    None
}

pub fn expand_with_children(doc: &BoardDoc, ids: &[ElementId]) -> Vec<ElementId> {
    let mut set: BTreeSet<ElementId> = ids.iter().cloned().collect();
    let mut out = ids.to_vec();
    for el in &doc.elements {
        if let Some(parent) = &el.parent_id
            && set.contains(parent)
            && set.insert(el.id.clone())
        {
            out.push(el.id.clone());
        }
    }
    out
}

pub fn point_near_polyline_segment(points: &[Point2], pt: Point2, tol: f64) -> Option<usize> {
    let tol_sq = tol * tol;
    for (idx, pair) in points.windows(2).enumerate() {
        if dist_sq_point_segment(pt, pair[0], pair[1]) <= tol_sq {
            return Some(idx);
        }
    }
    None
}
