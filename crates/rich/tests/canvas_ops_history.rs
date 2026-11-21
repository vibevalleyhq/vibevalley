use vibevalley_rich::engine::canvas::{
    AlignKind, BackgroundStyle, Canvas, CanvasColor, CanvasDocument, CanvasOp, DistributeAxis, Edge, EdgeId, EdgePatch, End, FieldPatch, Node, NodeBounds,
    NodeContentPatch, NodeId, NodeKind, NodePatch, OpError, PresetColor, Side, ZOrderTarget,
};

#[test]
fn ops_undo_redo_restore_exact_canvas_state() {
    let mut doc = CanvasDocument::default();
    let initial = doc.canvas().clone();

    assert!(
        doc.apply(CanvasOp::AddNode {
            node: Node::group("g1", NodeBounds::new(0, 0, 500, 300), Some("Group".into())),
            index: None,
        })
        .unwrap()
    );
    assert!(
        doc.apply(CanvasOp::AddNode {
            node: Node::text("n1", NodeBounds::new(20, 20, 180, 100), "First"),
            index: None,
        })
        .unwrap()
    );
    assert!(
        doc.apply(CanvasOp::AddNode {
            node: Node::file("n2", NodeBounds::new(240, 20, 180, 100), "notes.md"),
            index: None,
        })
        .unwrap()
    );
    assert!(
        doc.apply(CanvasOp::AddEdge {
            edge: Edge::new("e1", "n1", "n2").with_label("links"),
            index: None,
        })
        .unwrap()
    );

    let after_build = doc.canvas().clone();

    assert!(
        doc.apply(CanvasOp::UpdateNode {
            id: NodeId::from("n2"),
            patch: NodePatch {
                bounds: None,
                color: FieldPatch::Set(CanvasColor::Preset(PresetColor::Green)),
                content: Some(NodeContentPatch::File {
                    file: Some("01_Projects/notes.md".into()),
                    subpath: FieldPatch::Set("#overview".into()),
                }),
            },
        })
        .unwrap()
    );
    assert!(
        doc.apply(CanvasOp::UpdateEdge {
            id: EdgeId::from("e1"),
            patch: EdgePatch {
                from_side: FieldPatch::Set(Side::Right),
                to_side: FieldPatch::Set(Side::Left),
                from_end: FieldPatch::Set(End::Arrow),
                color: FieldPatch::Set(CanvasColor::Preset(PresetColor::Orange)),
                label: FieldPatch::Clear,
                ..EdgePatch::default()
            },
        })
        .unwrap()
    );
    assert!(
        doc.apply(CanvasOp::ResizeNode {
            id: NodeId::from("n1"),
            bounds: NodeBounds::new(20, 20, 220, 140),
        })
        .unwrap()
    );
    assert!(
        doc.apply(CanvasOp::ReorderNode {
            id: NodeId::from("g1"),
            target: ZOrderTarget::Front,
        })
        .unwrap()
    );
    assert_eq!(doc.canvas().nodes.last().unwrap().id(), "g1");

    let before_remove = doc.canvas().clone();
    assert!(doc.apply(CanvasOp::RemoveNode { id: NodeId::from("n1") }).unwrap());
    assert!(doc.canvas().node(&NodeId::from("n1")).is_none());
    assert!(doc.canvas().edges.is_empty());

    assert!(doc.undo());
    assert_eq!(doc.canvas(), &before_remove);

    assert!(doc.redo());
    assert!(doc.canvas().node(&NodeId::from("n1")).is_none());
    assert!(doc.canvas().edges.is_empty());

    assert!(doc.undo());
    assert!(doc.undo());
    assert!(doc.undo());
    assert!(doc.undo());
    assert!(doc.undo());
    assert_eq!(doc.canvas(), &after_build);

    while doc.undo() {}
    assert_eq!(doc.canvas(), &initial);
    assert!(!doc.can_undo());
    assert!(doc.can_redo());

    while doc.redo() {}
    assert!(doc.canvas().node(&NodeId::from("n1")).is_none());
}

#[test]
fn moving_group_moves_nested_children_once_and_undoes_cleanly() {
    let mut canvas = Canvas::new();
    canvas.nodes.push(Node::group("outer", NodeBounds::new(0, 0, 500, 400), Some("Outer".into())));
    canvas.nodes.push(Node::group("inner", NodeBounds::new(20, 20, 260, 200), Some("Inner".into())));
    canvas.nodes.push(Node::text("child", NodeBounds::new(40, 40, 120, 80), "Child"));
    canvas.nodes.push(Node::text("outside", NodeBounds::new(700, 0, 120, 80), "Outside"));

    let mut doc = CanvasDocument::new(canvas);
    let before = doc.canvas().clone();

    doc.apply(CanvasOp::MoveNodes {
        ids: vec![NodeId::from("outer"), NodeId::from("child")],
        dx: 50,
        dy: -30,
        include_group_contents: true,
    })
    .unwrap();

    assert_eq!(doc.canvas().node(&NodeId::from("outer")).unwrap().bounds(), NodeBounds::new(50, -30, 500, 400));
    assert_eq!(doc.canvas().node(&NodeId::from("inner")).unwrap().bounds(), NodeBounds::new(70, -10, 260, 200));
    assert_eq!(doc.canvas().node(&NodeId::from("child")).unwrap().bounds(), NodeBounds::new(90, 10, 120, 80));
    assert_eq!(doc.canvas().node(&NodeId::from("outside")).unwrap().bounds(), NodeBounds::new(700, 0, 120, 80));

    assert!(doc.undo());
    assert_eq!(doc.canvas(), &before);

    doc.apply(CanvasOp::MoveNodes {
        ids: vec![NodeId::from("outer")],
        dx: 10,
        dy: 10,
        include_group_contents: false,
    })
    .unwrap();
    assert_eq!(doc.canvas().node(&NodeId::from("outer")).unwrap().x(), 10);
    assert_eq!(doc.canvas().node(&NodeId::from("child")).unwrap().x(), 40);
}

#[test]
fn batch_rolls_back_atomically_on_error() {
    let mut doc = CanvasDocument::default();
    doc.apply(CanvasOp::AddNode {
        node: Node::text("a", NodeBounds::new(0, 0, 100, 100), "A"),
        index: None,
    })
    .unwrap();
    let snapshot = doc.canvas().clone();
    let rev_before = doc.revision();
    let undo_before = doc.undo_len();

    let err = doc
        .apply(CanvasOp::Batch {
            ops: vec![
                CanvasOp::AddNode {
                    node: Node::text("b", NodeBounds::new(200, 0, 100, 100), "B"),
                    index: None,
                },
                CanvasOp::MoveNodes {
                    ids: vec![NodeId::from("a")],
                    dx: 50,
                    dy: 50,
                    include_group_contents: false,
                },
                CanvasOp::AddEdge {
                    edge: Edge::new("bad", "a", "nonexistent"),
                    index: None,
                },
            ],
        })
        .expect_err("dangling edge must abort entire batch");

    assert!(matches!(err, OpError::DanglingEdgeNode { .. }));
    assert_eq!(doc.canvas(), &snapshot);
    assert_eq!(doc.revision(), rev_before);
    assert_eq!(doc.undo_len(), undo_before);
}

#[test]
fn transactions_coalesce_drags_and_support_cancel() {
    let mut doc = CanvasDocument::default();
    doc.apply(CanvasOp::AddNode {
        node: Node::text("n1", NodeBounds::new(0, 0, 100, 80), "Drag me"),
        index: None,
    })
    .unwrap();
    assert_eq!(doc.undo_len(), 1);

    doc.begin_transaction().unwrap();
    assert!(matches!(doc.begin_transaction(), Err(OpError::TransactionAlreadyOpen)));
    for _ in 0..10 {
        doc.apply(CanvasOp::MoveNodes {
            ids: vec![NodeId::from("n1")],
            dx: 5,
            dy: 3,
            include_group_contents: false,
        })
        .unwrap();
    }
    assert!(!doc.can_undo());
    assert!(doc.commit_transaction().unwrap());
    assert_eq!(doc.undo_len(), 2);
    assert_eq!(doc.canvas().node(&NodeId::from("n1")).unwrap().bounds(), NodeBounds::new(50, 30, 100, 80));

    assert!(doc.undo());
    assert_eq!(doc.canvas().node(&NodeId::from("n1")).unwrap().bounds(), NodeBounds::new(0, 0, 100, 80));

    doc.begin_transaction().unwrap();
    doc.apply(CanvasOp::MoveNodes {
        ids: vec![NodeId::from("n1")],
        dx: 200,
        dy: 200,
        include_group_contents: false,
    })
    .unwrap();
    doc.cancel_transaction().unwrap();
    assert_eq!(doc.canvas().node(&NodeId::from("n1")).unwrap().bounds(), NodeBounds::new(0, 0, 100, 80));
    assert_eq!(doc.undo_len(), 1);
    assert!(matches!(doc.commit_transaction(), Err(OpError::NoActiveTransaction)));
}

#[test]
fn op_errors_enforce_domain_invariants() {
    let mut doc = CanvasDocument::default();
    doc.apply(CanvasOp::AddNode {
        node: Node::text("t1", NodeBounds::new(0, 0, 100, 100), "Text"),
        index: None,
    })
    .unwrap();

    assert!(matches!(
        doc.apply(CanvasOp::AddNode {
            node: Node::text("t1", NodeBounds::new(10, 10, 50, 50), "Dup"),
            index: None,
        }),
        Err(OpError::DuplicateNodeId(_))
    ));

    assert!(matches!(
        doc.apply(CanvasOp::UpdateNode {
            id: NodeId::from("t1"),
            patch: NodePatch {
                content: Some(NodeContentPatch::Group {
                    label: FieldPatch::Set("nope".into()),
                    background: FieldPatch::Keep,
                    background_style: FieldPatch::Set(BackgroundStyle::Cover),
                }),
                ..NodePatch::default()
            },
        }),
        Err(OpError::NodeKindMismatch {
            actual: NodeKind::Text,
            expected: NodeKind::Group,
            ..
        })
    ));

    assert!(matches!(
        doc.apply(CanvasOp::ResizeNode {
            id: NodeId::from("t1"),
            bounds: NodeBounds::new(0, 0, 0, 100),
        }),
        Err(OpError::NonPositiveDimensions { width: 0, height: 100 })
    ));

    assert!(matches!(
        doc.apply(CanvasOp::ReorderNode {
            id: NodeId::from("t1"),
            target: ZOrderTarget::Index(99),
        }),
        Err(OpError::IndexOutOfBounds { index: 99, len: 1 })
    ));
}

#[test]
fn selection_alignment_distribution_deletion_and_history_limit() {
    let mut doc = CanvasDocument::default();
    doc.set_history_limit(3);
    for (id, x, y) in [("a", 0, 0), ("b", 40, 80), ("c", 400, 20)] {
        doc.apply(CanvasOp::AddNode {
            node: Node::text(id, NodeBounds::new(x, y, 100, 60), id),
            index: None,
        })
        .unwrap();
    }
    doc.apply(CanvasOp::AddEdge {
        edge: Edge::new("e1", "a", "b"),
        index: None,
    })
    .unwrap();
    assert_eq!(doc.undo_len(), 3);

    doc.selection.nodes.insert(NodeId::from("a"));
    doc.selection.nodes.insert(NodeId::from("b"));
    doc.selection.nodes.insert(NodeId::from("c"));
    assert!(doc.align_selected(AlignKind::Top).unwrap());
    assert_eq!(doc.canvas().node(&NodeId::from("b")).unwrap().y(), 0);
    assert_eq!(doc.canvas().node(&NodeId::from("c")).unwrap().y(), 0);

    assert!(doc.distribute_selected(DistributeAxis::Horizontal).unwrap());
    assert_eq!(doc.canvas().node(&NodeId::from("b")).unwrap().x(), 200);

    doc.selection.clear();
    doc.selection.nodes.insert(NodeId::from("a"));
    doc.selection.edges.insert(EdgeId::from("e1"));
    assert!(doc.delete_selection().unwrap());
    assert!(doc.canvas().node(&NodeId::from("a")).is_none());
    assert!(doc.canvas().edge(&EdgeId::from("e1")).is_none());

    assert!(doc.undo());
    assert!(doc.canvas().node(&NodeId::from("a")).is_some());
    assert!(doc.canvas().edge(&EdgeId::from("e1")).is_some());
}

#[test]
fn canvas_op_serializes_cleanly_for_bridge_transport() {
    let op = CanvasOp::Batch {
        ops: vec![
            CanvasOp::AddNode {
                node: Node::link("l1", NodeBounds::new(10, 20, 200, 80), "https://vibevalley.dev"),
                index: Some(0),
            },
            CanvasOp::MoveNodes {
                ids: vec![NodeId::from("l1")],
                dx: 15,
                dy: -5,
                include_group_contents: true,
            },
            CanvasOp::ReorderNode {
                id: NodeId::from("l1"),
                target: ZOrderTarget::Index(0),
            },
            CanvasOp::UpdateNode {
                id: NodeId::from("l1"),
                patch: NodePatch {
                    bounds: None,
                    color: FieldPatch::Clear,
                    content: Some(NodeContentPatch::Link {
                        url: Some("https://jsoncanvas.org".into()),
                    }),
                },
            },
        ],
    };
    let json = serde_json::to_string(&op).expect("serialize op");
    let decoded: CanvasOp = serde_json::from_str(&json).expect("deserialize op");
    assert_eq!(decoded, op);
}

#[test]
fn removing_node_with_interleaved_incident_edges_restores_exact_edge_order() {
    let mut doc = CanvasDocument::default();
    for id in ["a", "b", "c"] {
        doc.apply(CanvasOp::AddNode {
            node: Node::text(id, NodeBounds::new(0, 0, 100, 80), id),
            index: None,
        })
        .unwrap();
    }
    for (eid, from, to) in [("e0", "a", "c"), ("e1", "b", "a"), ("e2", "b", "b"), ("e3", "c", "a"), ("e4", "c", "b")] {
        doc.apply(CanvasOp::AddEdge {
            edge: Edge::new(eid, from, to),
            index: None,
        })
        .unwrap();
    }

    let snapshot = doc.canvas().clone();
    doc.selection.select_only_node(NodeId::from("b"));
    doc.apply(CanvasOp::RemoveNode { id: NodeId::from("b") }).unwrap();
    assert!(doc.selection.is_empty());
    let remaining_edges: Vec<&str> = doc.canvas().edges.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(remaining_edges, vec!["e0", "e3"]);

    assert!(doc.undo());
    assert_eq!(doc.canvas(), &snapshot);
}

#[test]
fn z_order_operations_cover_all_targets_and_noop_skip() {
    let mut doc = CanvasDocument::default();
    for id in ["n0", "n1", "n2"] {
        doc.apply(CanvasOp::AddNode {
            node: Node::text(id, NodeBounds::new(0, 0, 80, 60), id),
            index: None,
        })
        .unwrap();
    }
    let undo_before = doc.undo_len();
    assert!(
        !doc.apply(CanvasOp::ReorderNode {
            id: NodeId::from("n2"),
            target: ZOrderTarget::Front,
        })
        .unwrap()
    );
    assert_eq!(doc.undo_len(), undo_before);

    doc.apply(CanvasOp::ReorderNode {
        id: NodeId::from("n2"),
        target: ZOrderTarget::Back,
    })
    .unwrap();
    assert_eq!(doc.canvas().nodes.iter().map(|n| n.id().as_str()).collect::<Vec<_>>(), vec!["n2", "n0", "n1"]);

    doc.apply(CanvasOp::ReorderNode {
        id: NodeId::from("n2"),
        target: ZOrderTarget::Forward,
    })
    .unwrap();
    assert_eq!(doc.canvas().nodes.iter().map(|n| n.id().as_str()).collect::<Vec<_>>(), vec!["n0", "n2", "n1"]);

    doc.apply(CanvasOp::ReorderNode {
        id: NodeId::from("n1"),
        target: ZOrderTarget::Backward,
    })
    .unwrap();
    assert_eq!(doc.canvas().nodes.iter().map(|n| n.id().as_str()).collect::<Vec<_>>(), vec!["n0", "n1", "n2"]);

    doc.apply(CanvasOp::ReorderNode {
        id: NodeId::from("n0"),
        target: ZOrderTarget::Index(2),
    })
    .unwrap();
    assert_eq!(doc.canvas().nodes.iter().map(|n| n.id().as_str()).collect::<Vec<_>>(), vec!["n1", "n2", "n0"]);

    assert!(doc.undo());
    assert_eq!(doc.canvas().nodes.iter().map(|n| n.id().as_str()).collect::<Vec<_>>(), vec!["n0", "n1", "n2"]);
}
