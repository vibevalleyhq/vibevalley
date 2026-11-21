use std::collections::{HashSet, VecDeque};

use crate::geometry::{ArrowConfig, Point, Rect, ResizeHandle, Viewport, anchor_point, compute_edge_geometry};
use crate::model::{Canvas, EdgeId, GroupNode, Node, NodeId, Side};

/// Group labels float above the top-left corner of the group frame (Obsidian Canvas convention).
pub const GROUP_LABEL_HEIGHT: f64 = 24.0;
pub const GROUP_LABEL_GAP: f64 = 6.0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HitTarget {
    ResizeHandle { node: NodeId, handle: ResizeHandle },
    AnchorPort { node: NodeId, side: Side },
    Node(NodeId),
    Edge(EdgeId),
    Background,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HitConfig {
    pub handle_radius_px: f64,
    pub port_radius_px: f64,
    /// Screen-space distance outside each side midpoint where connection port handles sit,
    /// preventing overlap with mid-edge resize handles.
    pub port_offset_px: f64,
    pub edge_tolerance_px: f64,
    pub include_anchor_ports: bool,
    pub anchor_ports_on_all_nodes: bool,
    pub include_group_labels: bool,
}

impl Default for HitConfig {
    fn default() -> Self {
        Self {
            handle_radius_px: 6.0,
            port_radius_px: 7.0,
            port_offset_px: 12.0,
            edge_tolerance_px: 8.0,
            include_anchor_ports: true,
            anchor_ports_on_all_nodes: false,
            include_group_labels: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarqueeMode {
    Intersects,
    Contained,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MarqueeSelection {
    pub nodes: Vec<NodeId>,
    pub edges: Vec<EdgeId>,
}

pub fn group_label_rect(group: &GroupNode) -> Option<Rect> {
    let label = group.label.as_deref().filter(|s| !s.is_empty())?;
    let estimated_width = (label.chars().count() as f64 * 8.0 + 16.0).clamp(48.0, (group.width as f64).max(48.0));
    Some(Rect::new(
        group.x as f64,
        group.y as f64 - GROUP_LABEL_HEIGHT - GROUP_LABEL_GAP,
        estimated_width,
        GROUP_LABEL_HEIGHT,
    ))
}

pub fn hit_test_resize_handle(node: &Node, world_point: Point, world_radius: f64) -> Option<ResizeHandle> {
    let rect = node.rect();
    let r_sq = world_radius * world_radius;
    let mut best: Option<(ResizeHandle, f64)> = None;
    for handle in ResizeHandle::ALL {
        let dist_sq = handle.position_on(rect).distance_squared(world_point);
        if dist_sq <= r_sq && best.is_none_or(|(_, best_d)| dist_sq < best_d) {
            best = Some((handle, dist_sq));
        }
    }
    best.map(|(handle, _)| handle)
}

pub fn anchor_port_position(rect: Rect, side: Side, world_outward_offset: f64) -> Point {
    anchor_point(rect, side).offset(side.normal().scale(world_outward_offset))
}

pub fn hit_test_anchor_port(node: &Node, world_point: Point, world_radius: f64) -> Option<Side> {
    hit_test_anchor_port_with_offset(node, world_point, 0.0, world_radius)
}

pub fn hit_test_anchor_port_with_offset(node: &Node, world_point: Point, world_outward_offset: f64, world_radius: f64) -> Option<Side> {
    let rect = node.rect();
    let r_sq = world_radius * world_radius;
    let mut best: Option<(Side, f64)> = None;
    for side in Side::ALL {
        let dist_sq = anchor_port_position(rect, side, world_outward_offset).distance_squared(world_point);
        if dist_sq <= r_sq && best.is_none_or(|(_, best_d)| dist_sq < best_d) {
            best = Some((side, dist_sq));
        }
    }
    best.map(|(side, _)| side)
}

pub fn hit_test_node(canvas: &Canvas, world_point: Point, include_group_labels: bool) -> Option<NodeId> {
    hit_test_card_node(canvas, world_point).or_else(|| hit_test_group_node(canvas, world_point, include_group_labels))
}

fn hit_test_card_node(canvas: &Canvas, world_point: Point) -> Option<NodeId> {
    // Nodes are stored in ascending z-order: iterate in reverse so topmost card wins.
    for node in canvas.nodes.iter().rev() {
        if !node.is_group() && node.rect().contains_point(world_point) {
            return Some(node.id().clone());
        }
    }
    None
}

fn hit_test_group_label(canvas: &Canvas, world_point: Point) -> Option<NodeId> {
    for node in canvas.nodes.iter().rev() {
        if let Some(group) = node.as_group()
            && group_label_rect(group).is_some_and(|r| r.contains_point(world_point))
        {
            return Some(node.id().clone());
        }
    }
    None
}

fn hit_test_group_node(canvas: &Canvas, world_point: Point, include_group_labels: bool) -> Option<NodeId> {
    if include_group_labels && let Some(id) = hit_test_group_label(canvas, world_point) {
        return Some(id);
    }
    for node in canvas.nodes.iter().rev() {
        if node.is_group() && node.rect().contains_point(world_point) {
            return Some(node.id().clone());
        }
    }
    None
}

pub fn hit_test_edge(canvas: &Canvas, world_point: Point, world_tolerance: f64) -> Option<EdgeId> {
    let mut best: Option<(&EdgeId, f64)> = None;
    let arrow = ArrowConfig::default();
    for edge in canvas.edges.iter().rev() {
        let Some(geom) = compute_edge_geometry(canvas, edge, arrow) else {
            continue;
        };
        if !geom.curve.bounding_box().expand(world_tolerance).contains_point(world_point) {
            continue;
        }
        let dist = geom.curve.distance_to_point(world_point);
        if dist <= world_tolerance && best.is_none_or(|(_, best_d)| dist < best_d) {
            best = Some((&edge.id, dist));
        }
    }
    best.map(|(id, _)| id.clone())
}

pub fn hit_test(canvas: &Canvas, viewport: &Viewport, selected_nodes: &HashSet<NodeId>, screen_point: Point, config: &HitConfig) -> HitTarget {
    let world_point = viewport.screen_to_world(screen_point);
    hit_test_world(canvas, world_point, viewport.zoom, selected_nodes, config)
}

pub fn hit_test_world(canvas: &Canvas, world_point: Point, zoom: f64, selected_nodes: &HashSet<NodeId>, config: &HitConfig) -> HitTarget {
    let safe_zoom = zoom.max(1e-4);
    let handle_radius = config.handle_radius_px / safe_zoom;
    let port_radius = config.port_radius_px / safe_zoom;
    let port_offset = config.port_offset_px / safe_zoom;
    let edge_tolerance = config.edge_tolerance_px / safe_zoom;

    // When connecting an edge across nodes, anchor ports take priority over resize handles.
    if config.include_anchor_ports && config.anchor_ports_on_all_nodes {
        for node in canvas.nodes.iter().rev() {
            if let Some(side) = hit_test_anchor_port_with_offset(node, world_point, port_offset, port_radius) {
                return HitTarget::AnchorPort { node: node.id().clone(), side };
            }
        }
    }

    for node in canvas.nodes.iter().rev() {
        if !selected_nodes.contains(node.id()) {
            continue;
        }
        if let Some(handle) = hit_test_resize_handle(node, world_point, handle_radius) {
            return HitTarget::ResizeHandle {
                node: node.id().clone(),
                handle,
            };
        }
    }

    if config.include_anchor_ports && !config.anchor_ports_on_all_nodes {
        for node in canvas.nodes.iter().rev() {
            if !selected_nodes.contains(node.id()) {
                continue;
            }
            if let Some(side) = hit_test_anchor_port_with_offset(node, world_point, port_offset, port_radius) {
                return HitTarget::AnchorPort { node: node.id().clone(), side };
            }
        }
    }

    if let Some(id) = hit_test_card_node(canvas, world_point) {
        return HitTarget::Node(id);
    }

    if config.include_group_labels
        && let Some(id) = hit_test_group_label(canvas, world_point)
    {
        return HitTarget::Node(id);
    }

    // Edges sit above group backgrounds so connectors inside/crossing groups remain clickable.
    if let Some(id) = hit_test_edge(canvas, world_point, edge_tolerance) {
        return HitTarget::Edge(id);
    }

    if let Some(id) = hit_test_group_node(canvas, world_point, false) {
        return HitTarget::Node(id);
    }

    HitTarget::Background
}

pub fn marquee_select(canvas: &Canvas, marquee_world: Rect, mode: MarqueeMode) -> MarqueeSelection {
    let normalized = Rect::from_corners(
        Point::new(marquee_world.x, marquee_world.y),
        Point::new(marquee_world.right(), marquee_world.bottom()),
    );
    let mut nodes = Vec::new();
    for node in &canvas.nodes {
        let rect = node.rect();
        let matched = match mode {
            MarqueeMode::Intersects => normalized.intersects(rect),
            MarqueeMode::Contained => normalized.contains_rect(rect),
        };
        if matched {
            nodes.push(node.id().clone());
        }
    }

    let arrow = ArrowConfig::default();
    let mut edges = Vec::new();
    for edge in &canvas.edges {
        let Some(geom) = compute_edge_geometry(canvas, edge, arrow) else {
            continue;
        };
        let matched = match mode {
            MarqueeMode::Contained => normalized.contains_rect(geom.curve.bounding_box()),
            MarqueeMode::Intersects => {
                if !normalized.intersects(geom.curve.bounding_box()) {
                    false
                } else {
                    geom.curve.sample(24).into_iter().any(|p| normalized.contains_point(p))
                }
            }
        };
        if matched {
            edges.push(edge.id.clone());
        }
    }

    MarqueeSelection { nodes, edges }
}

/// True when `group` is a `Node::Group` whose bounds fully enclose `candidate`.
pub fn group_contains_node(group: &Node, candidate: &Node) -> bool {
    group.is_group() && group.id() != candidate.id() && group.bounds().contains_bounds(candidate.bounds())
}

pub fn nodes_in_group(canvas: &Canvas, group_id: &NodeId) -> Vec<NodeId> {
    let Some(group) = canvas.node(group_id) else {
        return Vec::new();
    };
    if !group.is_group() {
        return Vec::new();
    }
    canvas
        .nodes
        .iter()
        .filter(|candidate| group_contains_node(group, candidate))
        .map(|n| n.id().clone())
        .collect()
}

/// Expands a node set with every node enclosed by any group in `ids`, recursively
/// and deduplicated in deterministic canvas z-order.
pub fn expand_with_group_contents(canvas: &Canvas, ids: &[NodeId]) -> Vec<NodeId> {
    let mut included: HashSet<NodeId> = HashSet::new();
    let mut queue: VecDeque<NodeId> = VecDeque::new();

    for id in ids {
        if canvas.node(id).is_some() && included.insert(id.clone()) {
            queue.push_back(id.clone());
        }
    }

    while let Some(current_id) = queue.pop_front() {
        let Some(current) = canvas.node(&current_id) else {
            continue;
        };
        if !current.is_group() {
            continue;
        }
        for candidate in &canvas.nodes {
            if group_contains_node(current, candidate) && included.insert(candidate.id().clone()) {
                queue.push_back(candidate.id().clone());
            }
        }
    }

    canvas.nodes.iter().filter(|n| included.contains(n.id())).map(|n| n.id().clone()).collect()
}

/// Returns every group that encloses `node_id`, ordered innermost (smallest area) first.
pub fn enclosing_groups(canvas: &Canvas, node_id: &NodeId) -> Vec<NodeId> {
    let Some(target) = canvas.node(node_id) else {
        return Vec::new();
    };
    let mut groups: Vec<(&NodeId, i128)> = canvas
        .nodes
        .iter()
        .filter(|candidate| group_contains_node(candidate, target))
        .map(|g| (g.id(), i128::from(g.width()) * i128::from(g.height())))
        .collect();
    groups.sort_by_key(|(_, area)| *area);
    groups.into_iter().map(|(id, _)| id.clone()).collect()
}
