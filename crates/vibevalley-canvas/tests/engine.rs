use std::collections::HashSet;

use vibevalley_canvas::{
    AlignKind, ArrowConfig, Canvas, CubicBezier, DistributeAxis, Edge, EdgeId, End, HitConfig, HitTarget, MarqueeMode, Node, NodeBounds, NodeId, Point, Rect,
    ResizeHandle, Side, Size, SnapConfig, SnapGuide, Vec2, Viewport, anchor_point, anchor_port_position, compute_alignment, compute_distribution,
    compute_edge_geometry, enclosing_groups, expand_with_group_contents, group_contains_node, group_label_rect, hit_test, hit_test_edge, hit_test_node,
    marquee_select, nodes_in_group, resolve_edge_sides, snap_node_move, snap_node_resize, snap_point_to_grid,
};

fn approx(a: f64, b: f64, eps: f64) -> bool {
    (a - b).abs() <= eps
}

#[test]
fn viewport_screen_world_and_zoom_at_invariants() {
    let mut vp = Viewport::new(Vec2::new(120.0, -40.0), 1.5);
    let world = Point::new(80.0, 220.0);
    let screen = vp.world_to_screen(world);
    assert!(approx(screen.x, 80.0 * 1.5 + 120.0, 1e-9));
    assert!(approx(screen.y, 220.0 * 1.5 - 40.0, 1e-9));

    let back = vp.screen_to_world(screen);
    assert!(approx(back.x, world.x, 1e-9));
    assert!(approx(back.y, world.y, 1e-9));

    let pivot = Point::new(310.0, 190.0);
    let world_before = vp.screen_to_world(pivot);
    vp.zoom_at(pivot, 1.8);
    let world_after = vp.screen_to_world(pivot);
    assert!(approx(world_before.x, world_after.x, 1e-9));
    assert!(approx(world_before.y, world_after.y, 1e-9));

    vp.zoom_at(pivot, 1000.0);
    assert!(approx(vp.zoom, vp.max_zoom, 1e-9));
    vp.zoom_at(pivot, 0.0001);
    assert!(approx(vp.zoom, vp.min_zoom, 1e-9));

    vp.reset();
    vp.pan_by_screen(Vec2::new(30.0, -15.0));
    vp.pan_by_world(Vec2::new(10.0, 20.0));
    assert_eq!(vp.pan, Vec2::new(40.0, 5.0));
}

#[test]
fn viewport_fit_content_and_fit_selection() {
    let mut canvas = Canvas::new();
    let mut vp = Viewport::default();
    let size = Size::new(1000.0, 800.0);
    assert!(!vp.fit_content(&canvas, size, 40.0, Some(1.0)));

    canvas.nodes.push(Node::text("a", NodeBounds::new(-200, -100, 200, 100), "A"));
    canvas.nodes.push(Node::text("b", NodeBounds::new(600, 400, 200, 100), "B"));

    assert!(vp.fit_content(&canvas, size, 50.0, Some(1.0)));
    let visible = vp.visible_world_rect(size);
    let content = canvas.content_bounds().unwrap();
    assert!(visible.contains_rect(content));
    let screen_center = vp.world_to_screen(content.center());
    assert!(approx(screen_center.x, 500.0, 1e-6));
    assert!(approx(screen_center.y, 400.0, 1e-6));

    assert!(vp.fit_selection(&canvas, &[NodeId::from("b")], size, 40.0, Some(1.0)));
    let b_center = vp.world_to_screen(canvas.nodes[1].rect().center());
    assert!(approx(b_center.x, 500.0, 1e-6));
    assert!(approx(b_center.y, 400.0, 1e-6));
}

#[test]
fn edge_routing_auto_sides_curves_and_arrowheads() {
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
    canvas.nodes.push(Node::text("a", NodeBounds::new(0, 0, 200, 100), "A"));
    canvas.nodes.push(Node::text("b", NodeBounds::new(400, 0, 200, 100), "B"));
    canvas.edges.push(Edge::new("e1", "a", "b"));
    canvas.edges.push(
        Edge::new("e2", "a", "b")
            .with_sides(Some(Side::Right), Some(Side::Right))
            .with_ends(Some(End::Arrow), Some(End::Arrow)),
    );
    canvas.edges.push(Edge::new("e3", "a", "a"));

    let g1 = compute_edge_geometry(&canvas, &canvas.edges[0], ArrowConfig::default()).unwrap();
    assert_eq!((g1.from_side, g1.to_side), (Side::Right, Side::Left));
    assert_eq!(g1.curve.p0, anchor_point(left, Side::Right));
    assert_eq!(g1.curve.p3, Point::new(400.0, 50.0));
    assert!(g1.from_arrow.is_none());
    let to_arrow = g1.to_arrow.expect("default toEnd is arrow");
    assert_eq!(to_arrow.tip, Point::new(400.0, 50.0));
    assert!(to_arrow.left.x < to_arrow.tip.x);
    assert!(to_arrow.right.x < to_arrow.tip.x);
    assert!(g1.curve.distance_to_point(g1.curve.midpoint()) < 0.05);
    assert!(approx(g1.curve.distance_to_point(Point::new(300.0, 75.0)), 25.0, 0.2));

    let g2 = compute_edge_geometry(&canvas, &canvas.edges[1], ArrowConfig::default()).unwrap();
    assert!(g2.from_arrow.is_some());
    assert!(g2.to_arrow.is_some());
    let bbox = g2.curve.bounding_box();
    for sample in g2.curve.sample(64) {
        assert!(bbox.expand(1e-6).contains_point(sample));
    }

    let g3 = compute_edge_geometry(&canvas, &canvas.edges[2], ArrowConfig::default()).unwrap();
    assert_eq!((g3.from_side, g3.to_side), (Side::Right, Side::Bottom));
    assert!(g3.curve.bounding_box().width > 20.0);
    assert!(g3.curve.bounding_box().height > 20.0);
}

#[test]
fn cubic_bezier_bounding_box_captures_bulge_beyond_endpoints() {
    let curve = CubicBezier {
        p0: Point::new(0.0, 0.0),
        p1: Point::new(100.0, 0.0),
        p2: Point::new(100.0, 100.0),
        p3: Point::new(0.0, 100.0),
    };
    let bbox = curve.bounding_box();
    assert!(approx(bbox.x, 0.0, 1e-6));
    assert!(approx(bbox.right(), 75.0, 1e-6));
    assert!(approx(bbox.y, 0.0, 1e-6));
    assert!(approx(bbox.bottom(), 100.0, 1e-6));
}

#[test]
fn hit_testing_respects_z_order_handles_ports_group_labels_and_edges() {
    let mut canvas = Canvas::new();
    canvas.nodes.push(Node::group("grp", NodeBounds::new(0, 0, 500, 300), Some("Cluster".into())));
    canvas.nodes.push(Node::text("back", NodeBounds::new(40, 40, 200, 120), "Back"));
    canvas.nodes.push(Node::text("front", NodeBounds::new(100, 80, 200, 120), "Front"));
    canvas.nodes.push(Node::text("far", NodeBounds::new(620, 80, 160, 120), "Far"));
    canvas.edges.push(Edge::new("e1", "front", "far"));

    let vp = Viewport::default();
    let cfg = HitConfig::default();
    let empty_sel = HashSet::new();

    assert_eq!(
        hit_test(&canvas, &vp, &empty_sel, Point::new(150.0, 110.0), &cfg),
        HitTarget::Node(NodeId::from("front"))
    );
    assert_eq!(
        hit_test(&canvas, &vp, &empty_sel, Point::new(60.0, 60.0), &cfg),
        HitTarget::Node(NodeId::from("back"))
    );
    assert_eq!(
        hit_test(&canvas, &vp, &empty_sel, Point::new(450.0, 260.0), &cfg),
        HitTarget::Node(NodeId::from("grp"))
    );
    let label_rect = group_label_rect(canvas.nodes[0].as_group().unwrap()).unwrap();
    assert_eq!(
        hit_test(&canvas, &vp, &empty_sel, label_rect.center(), &cfg),
        HitTarget::Node(NodeId::from("grp"))
    );
    assert_eq!(hit_test_node(&canvas, label_rect.center(), false), None);

    let mut sel = HashSet::new();
    sel.insert(NodeId::from("front"));
    assert_eq!(
        hit_test(&canvas, &vp, &sel, Point::new(300.0, 200.0), &cfg),
        HitTarget::ResizeHandle {
            node: NodeId::from("front"),
            handle: ResizeHandle::SouthEast,
        }
    );
    assert_eq!(
        hit_test(&canvas, &vp, &sel, Point::new(300.0, 140.0), &cfg),
        HitTarget::ResizeHandle {
            node: NodeId::from("front"),
            handle: ResizeHandle::East,
        }
    );
    let east_port = anchor_port_position(canvas.nodes[2].rect(), Side::Right, cfg.port_offset_px);
    assert_eq!(
        hit_test(&canvas, &vp, &sel, east_port, &cfg),
        HitTarget::AnchorPort {
            node: NodeId::from("front"),
            side: Side::Right,
        }
    );

    let geom = compute_edge_geometry(&canvas, &canvas.edges[0], ArrowConfig::default()).unwrap();
    assert_eq!(
        hit_test(&canvas, &vp, &empty_sel, geom.curve.midpoint(), &cfg),
        HitTarget::Edge(EdgeId::from("e1"))
    );
    assert_eq!(hit_test_edge(&canvas, Point::new(1000.0, 1000.0), 8.0), None);
    assert_eq!(hit_test(&canvas, &vp, &empty_sel, Point::new(-500.0, -500.0), &cfg), HitTarget::Background);
}

#[test]
fn marquee_selection_modes_and_group_containment() {
    let mut canvas = Canvas::new();
    canvas.nodes.push(Node::group("outer", NodeBounds::new(0, 0, 600, 400), Some("Outer".into())));
    canvas.nodes.push(Node::group("inner", NodeBounds::new(40, 40, 300, 220), Some("Inner".into())));
    canvas.nodes.push(Node::text("child", NodeBounds::new(60, 60, 120, 80), "Inside"));
    canvas.nodes.push(Node::text("partial", NodeBounds::new(550, 50, 120, 80), "Half out"));
    canvas.edges.push(Edge::new("e1", "child", "partial"));

    assert!(group_contains_node(&canvas.nodes[0], &canvas.nodes[1]));
    assert!(group_contains_node(&canvas.nodes[0], &canvas.nodes[2]));
    assert!(group_contains_node(&canvas.nodes[1], &canvas.nodes[2]));
    assert!(!group_contains_node(&canvas.nodes[0], &canvas.nodes[3]));

    assert_eq!(nodes_in_group(&canvas, &NodeId::from("inner")), vec![NodeId::from("child")]);
    assert_eq!(
        enclosing_groups(&canvas, &NodeId::from("child")),
        vec![NodeId::from("inner"), NodeId::from("outer")]
    );
    assert_eq!(
        expand_with_group_contents(&canvas, &[NodeId::from("outer"), NodeId::from("child")]),
        vec![NodeId::from("outer"), NodeId::from("inner"), NodeId::from("child")]
    );

    let marquee = Rect::new(50.0, 50.0, 150.0, 110.0);
    let contained = marquee_select(&canvas, marquee, MarqueeMode::Contained);
    assert_eq!(contained.nodes, vec![NodeId::from("child")]);

    let intersected = marquee_select(&canvas, marquee, MarqueeMode::Intersects);
    assert!(intersected.nodes.contains(&NodeId::from("outer")));
    assert!(intersected.nodes.contains(&NodeId::from("inner")));
    assert!(intersected.nodes.contains(&NodeId::from("child")));
    assert!(!intersected.nodes.contains(&NodeId::from("partial")));
    assert_eq!(intersected.edges, vec![EdgeId::from("e1")]);
}

#[test]
fn snapping_alignment_and_distribution_helpers() {
    assert_eq!(snap_point_to_grid(29, -31, 20), (20, -40));

    let peer = NodeBounds::new(200, 100, 120, 80);
    let moving = NodeBounds::new(205, 250, 120, 80);
    let cfg = SnapConfig {
        grid_size: Some(20),
        snap_to_nodes: true,
        threshold: 8.0,
    };
    let snapped = snap_node_move(moving, &[peer], &cfg);
    assert_eq!(snapped.x, 200);
    assert_eq!(snapped.y, 260);
    assert!(snapped.guides.iter().any(|g| matches!(g, SnapGuide::Vertical { x: 200, .. })));

    let resized = snap_node_resize(
        NodeBounds::new(100, 100, 100, 80),
        ResizeHandle::NorthWest,
        95,
        75,
        60,
        40,
        &[],
        &SnapConfig {
            grid_size: None,
            snap_to_nodes: false,
            threshold: 0.0,
        },
    );
    assert_eq!(resized.bounds, NodeBounds::new(140, 140, 60, 40));

    let mut canvas = Canvas::new();
    canvas.nodes.push(Node::text("a", NodeBounds::new(0, 10, 100, 50), "A"));
    canvas.nodes.push(Node::text("b", NodeBounds::new(40, 120, 100, 50), "B"));
    canvas.nodes.push(Node::text("c", NodeBounds::new(400, 30, 100, 50), "C"));

    let ids = vec![NodeId::from("a"), NodeId::from("b"), NodeId::from("c")];
    let aligned_left = compute_alignment(&canvas, &ids, AlignKind::Left);
    assert_eq!(aligned_left, vec![(NodeId::from("b"), 0, 120), (NodeId::from("c"), 0, 30)]);

    let distributed_h = compute_distribution(&canvas, &ids, DistributeAxis::Horizontal);
    assert_eq!(distributed_h, vec![(NodeId::from("b"), 200, 120)]);

    let aligned_right = compute_alignment(&canvas, &ids, AlignKind::Right);
    assert_eq!(aligned_right, vec![(NodeId::from("a"), 400, 10), (NodeId::from("b"), 400, 120)]);
    let aligned_center_h = compute_alignment(&canvas, &ids, AlignKind::CenterHorizontal);
    assert_eq!(
        aligned_center_h,
        vec![(NodeId::from("a"), 200, 10), (NodeId::from("b"), 200, 120), (NodeId::from("c"), 200, 30)]
    );
    let aligned_bottom = compute_alignment(&canvas, &ids, AlignKind::Bottom);
    assert_eq!(aligned_bottom, vec![(NodeId::from("a"), 0, 120), (NodeId::from("c"), 400, 120)]);
    let aligned_center_v = compute_alignment(&canvas, &ids, AlignKind::CenterVertical);
    assert_eq!(
        aligned_center_v,
        vec![(NodeId::from("a"), 0, 65), (NodeId::from("b"), 40, 65), (NodeId::from("c"), 400, 65)]
    );

    let distributed_v = compute_distribution(&canvas, &ids, DistributeAxis::Vertical);
    assert_eq!(distributed_v, vec![(NodeId::from("c"), 400, 65)]);

    let resize_snapped = snap_node_resize(NodeBounds::new(0, 0, 100, 80), ResizeHandle::SouthEast, 218, 103, 60, 40, &[peer], &cfg);
    assert_eq!(resize_snapped.bounds, NodeBounds::new(0, 0, 320, 180));
    assert!(resize_snapped.guides.iter().any(|g| matches!(g, SnapGuide::Vertical { x: 320, .. })));
    assert!(resize_snapped.guides.iter().any(|g| matches!(g, SnapGuide::Horizontal { y: 180, .. })));
}

#[test]
fn hit_testing_scales_tolerance_with_zoom_and_supports_edge_connection_mode() {
    let mut canvas = Canvas::new();
    canvas.nodes.push(Node::text("a", NodeBounds::new(0, 0, 100, 100), "A"));
    canvas.nodes.push(Node::text("b", NodeBounds::new(300, 0, 100, 100), "B"));
    canvas.edges.push(Edge::new("e1", "a", "b"));

    let vp = Viewport::new(Vec2::ZERO, 0.25);
    let mut sel = HashSet::new();
    sel.insert(NodeId::from("a"));
    let cfg = HitConfig::default();

    let world_near_corner = Point::new(115.0, 115.0);
    let screen_near_corner = vp.world_to_screen(world_near_corner);
    assert_eq!(
        hit_test(&canvas, &vp, &sel, screen_near_corner, &cfg),
        HitTarget::ResizeHandle {
            node: NodeId::from("a"),
            handle: ResizeHandle::SouthEast,
        }
    );

    let connect_cfg = HitConfig {
        anchor_ports_on_all_nodes: true,
        ..HitConfig::default()
    };
    let vp_one = Viewport::default();
    let b_left_port = anchor_port_position(canvas.nodes[1].rect(), Side::Left, connect_cfg.port_offset_px);
    assert_eq!(
        hit_test(&canvas, &vp_one, &sel, b_left_port, &connect_cfg),
        HitTarget::AnchorPort {
            node: NodeId::from("b"),
            side: Side::Left,
        }
    );

    let reversed_marquee = Rect::new(350.0, 120.0, -400.0, -150.0);
    let picked = marquee_select(&canvas, reversed_marquee, MarqueeMode::Intersects);
    assert_eq!(picked.nodes, vec![NodeId::from("a"), NodeId::from("b")]);
    assert_eq!(picked.edges, vec![EdgeId::from("e1")]);
}

#[test]
fn short_facing_and_overlapping_node_edges_do_not_degenerate() {
    let mut canvas = Canvas::new();
    canvas.nodes.push(Node::text("a", NodeBounds::new(0, 0, 100, 100), "A"));
    canvas.nodes.push(Node::text("b", NodeBounds::new(110, 0, 100, 100), "B"));
    canvas.nodes.push(Node::text("c", NodeBounds::new(0, 0, 100, 100), "Overlap"));
    canvas.edges.push(Edge::new("short", "a", "b"));
    canvas.edges.push(Edge::new("overlap", "a", "c"));

    let short = compute_edge_geometry(&canvas, &canvas.edges[0], ArrowConfig::default()).unwrap();
    assert_eq!((short.from_side, short.to_side), (Side::Right, Side::Left));
    assert!(short.curve.p1.x >= short.curve.p0.x && short.curve.p1.x <= short.curve.p3.x);
    assert!(short.curve.p2.x >= short.curve.p0.x && short.curve.p2.x <= short.curve.p3.x);

    let overlap = compute_edge_geometry(&canvas, &canvas.edges[1], ArrowConfig::default()).unwrap();
    assert!(overlap.curve.p0.x.is_finite() && overlap.curve.p3.y.is_finite());
    assert!(overlap.to_arrow.is_some());
}
