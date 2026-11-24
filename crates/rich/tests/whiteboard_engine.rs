use std::collections::BTreeMap;

use vibevalley_rich::engine::canvas::{Canvas, End, Node as CanvasNode, Side};
use vibevalley_rich::engine::whiteboard::{
    AlignOp, AnchorSide, ArrowCurve, ArrowEndpoint, ArrowHead, BoardAction, BoardCommand, BoardDoc, Camera, ControllerEffect, DEFAULT_HISTORY_LIMIT,
    DistributeAxis, ElementId, ElementKind, ElementRecord, ExtraFields, GridStyle, InkMode, MilestoneKind, Modifiers, Point2, PointerButton, PointerInput,
    Presence, PresenceColor, PresenceKind, PresenceViewport, Rect2, STICKERS, ShapeKind, SnapConfig, SnapGuide, SpatialIndex, StrokePoint, StrokeStyle,
    TemplateCopy, TemplateKind, TextAlign, TextVariant, TimelineMilestone, Tool, UndoHistory, Vec2, WbFill, WhiteboardController, WhiteboardEntry,
    WhiteboardEntryKind, WhiteboardEntryOp, apply_command, apply_remote_entries, build_ink_outline, build_template_doc, compute_align_deltas,
    compute_distribute_deltas, compute_move_snap, compute_resize_snap, compute_tidy_grid_deltas, decode_board_entries, decode_presences_json,
    encode_element_patch, encode_element_write, encode_meta_write, encode_presence_write, import_json_canvas, project_point_to_polyline, rotated_bbox,
    route_arrow, sample_polyline, simplify_stroke_points, sticker_drawing, strokes_hit_by_eraser,
};

fn make_entry(path: &str, rev: i64, value: &str) -> WhiteboardEntry {
    WhiteboardEntry {
        artifact_id: "art-test".to_owned(),
        path: path.to_owned(),
        kind: WhiteboardEntryKind::Json,
        mime: "application/json".to_owned(),
        size: value.len() as i64,
        rev,
        updated_by: "user".to_owned(),
        updated: 1_700_000_000,
        value: Some(value.to_owned()),
        attachment_id: None,
    }
}

#[test]
fn codec_roundtrip_all_12_element_kinds_extra_fields_and_json_canvas() {
    let mut custom_extra = BTreeMap::new();
    custom_extra.insert("customTag".to_owned(), serde_json::json!("keep-me"));

    let mut card_with_extra = ElementRecord::new(
        "el-card",
        ElementKind::Shape {
            x: 100.0,
            y: 120.0,
            w: 180.0,
            h: 110.0,
            shape: ShapeKind::Card,
            title: "Launch Milestone".to_owned(),
            body: "Ship native whiteboard".to_owned(),
            fill: WbFill::Sun,
            stroke: Some("#1c1917".to_owned()),
            stroke_style: StrokeStyle::Dashed,
            corner_radius: Some(14.0),
            sticker: Some("mascot".to_owned()),
            sticker_svg: None,
            badge: Some("P0".to_owned()),
            align: TextAlign::Center,
        },
    );
    card_with_extra.extra = ExtraFields(custom_extra);

    let elements = vec![
        ElementRecord::new(
            "el-text-callout",
            ElementKind::Text {
                x: 40.0,
                y: 24.0,
                w: 240.0,
                h: 52.0,
                variant: TextVariant::Callout,
                label: "Wait on locked config".to_owned(),
                highlight: Some("locked config".to_owned()),
                icon: Some("!".to_owned()),
                align: TextAlign::Left,
                font_size: Some(14.0),
                fill: Some(WbFill::Peach),
                color: Some("#2a2520".to_owned()),
            },
        ),
        card_with_extra,
        ElementRecord::new(
            "el-sticky",
            ElementKind::Shape {
                x: 320.0,
                y: 120.0,
                w: 160.0,
                h: 120.0,
                shape: ShapeKind::Sticky,
                title: "Sticky note".to_owned(),
                body: "Action item".to_owned(),
                fill: WbFill::Leaf,
                stroke: None,
                stroke_style: StrokeStyle::Solid,
                corner_radius: None,
                sticker: None,
                sticker_svg: None,
                badge: None,
                align: TextAlign::Left,
            },
        ),
        ElementRecord::new(
            "el-diamond",
            ElementKind::Shape {
                x: 520.0,
                y: 120.0,
                w: 140.0,
                h: 96.0,
                shape: ShapeKind::Diamond,
                title: "Gate?".to_owned(),
                body: String::new(),
                fill: WbFill::Water,
                stroke: None,
                stroke_style: StrokeStyle::Solid,
                corner_radius: None,
                sticker: None,
                sticker_svg: None,
                badge: None,
                align: TextAlign::Center,
            },
        ),
        ElementRecord::new(
            "el-cylinder",
            ElementKind::Shape {
                x: 690.0,
                y: 120.0,
                w: 120.0,
                h: 96.0,
                shape: ShapeKind::Cylinder,
                title: "SQLite".to_owned(),
                body: "entries".to_owned(),
                fill: WbFill::Lavender,
                stroke: None,
                stroke_style: StrokeStyle::Solid,
                corner_radius: None,
                sticker: None,
                sticker_svg: None,
                badge: None,
                align: TextAlign::Center,
            },
        ),
        ElementRecord::new(
            "el-zone",
            ElementKind::Container {
                x: 20.0,
                y: 90.0,
                w: 820.0,
                h: 340.0,
                title: "Sprint Zone".to_owned(),
                fill: WbFill::Side,
                stroke: Some("#5e5852".to_owned()),
                collapsed: false,
            },
        ),
        ElementRecord::new(
            "el-timeline",
            ElementKind::Timeline {
                x: 60.0,
                y: 260.0,
                w: 720.0,
                h: 88.0,
                fill: WbFill::Peach,
                points: vec![Point2::new(60.0, 320.0), Point2::new(400.0, 290.0), Point2::new(760.0, 260.0)],
                milestones: vec![
                    TimelineMilestone {
                        t: Some(0.1),
                        pos: None,
                        label: "Day 1".to_owned(),
                        kind: MilestoneKind::Major,
                        tone: None,
                        caption: None,
                    },
                    TimelineMilestone {
                        t: Some(0.55),
                        pos: None,
                        label: "4".to_owned(),
                        kind: MilestoneKind::Minor,
                        tone: Some("peach".to_owned()),
                        caption: Some("On the road".to_owned()),
                    },
                ],
            },
        ),
        ElementRecord::new(
            "el-arrow",
            ElementKind::Arrow {
                from: ArrowEndpoint::Bound {
                    id: ElementId::new("el-card"),
                    side: Some(AnchorSide::E),
                },
                to: ArrowEndpoint::Bound {
                    id: ElementId::new("el-sticky"),
                    side: Some(AnchorSide::W),
                },
                bends: vec![Point2::new(300.0, 150.0)],
                curve: ArrowCurve::Orthogonal,
                style: StrokeStyle::Dotted,
                start_head: ArrowHead::Dot,
                end_head: ArrowHead::Diamond,
                stroke: Some("#4d7a2a".to_owned()),
                stroke_width: 2.0,
                label: Some("syncs".to_owned()),
            },
        ),
        ElementRecord::new(
            "el-ink",
            ElementKind::Path {
                points: vec![
                    StrokePoint::new(100.0, 380.0, 0.4),
                    StrokePoint::new(140.0, 392.0, 0.8),
                    StrokePoint::new(180.0, 384.0, 0.6),
                ],
                stroke: "#a83a2c".to_owned(),
                stroke_width: 3.5,
                mode: InkMode::Highlighter,
            },
        ),
        ElementRecord::new(
            "el-sticker",
            ElementKind::Sticker {
                x: 860.0,
                y: 80.0,
                w: 72.0,
                h: 72.0,
                sticker: "truck".to_owned(),
                svg: None,
                label: Some("Delivery".to_owned()),
            },
        ),
        ElementRecord::new(
            "el-svg",
            ElementKind::Svg {
                x: 860.0,
                y: 170.0,
                w: 96.0,
                h: 64.0,
                svg: r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="20" fill="#74a046"/></svg>"##.to_owned(),
                label: Some("Badge".to_owned()),
            },
        ),
        ElementRecord::new(
            "el-image",
            ElementKind::Image {
                x: 860.0,
                y: 250.0,
                w: 180.0,
                h: 120.0,
                attachment_id: Some("att-1".to_owned()),
                uri: "file:///tmp/diagram.png".to_owned(),
                alt: Some("Architecture diagram".to_owned()),
                crop: Some(Rect2::new(0.0, 0.0, 1.0, 1.0)),
            },
        ),
        ElementRecord::new(
            "el-table",
            ElementKind::Table {
                x: 60.0,
                y: 460.0,
                w: 420.0,
                h: 160.0,
                headers: vec!["Milestone".to_owned(), "Status".to_owned()],
                rows: vec![vec!["Engine".to_owned(), "Done".to_owned()], vec!["Painter".to_owned(), "WIP".to_owned()]],
                fill: WbFill::Default,
            },
        ),
        ElementRecord::new(
            "el-claim",
            ElementKind::Claim {
                x: 520.0,
                y: 460.0,
                w: 220.0,
                h: 120.0,
                label: "Active edit area".to_owned(),
                agent_id: Some("orchestrator".to_owned()),
                status: Some("active".to_owned()),
            },
        ),
        ElementRecord::new(
            "el-html",
            ElementKind::HtmlEmbed {
                x: 780.0,
                y: 460.0,
                w: 240.0,
                h: 140.0,
                html: "<div>Embedded widget</div>".to_owned(),
                title: Some("Widget".to_owned()),
            },
        ),
    ];

    let mut original = BoardDoc::new("Roundtrip Board");
    original.meta.grid = GridStyle::Dots;
    original.elements = elements;
    for (i, el) in original.elements.iter_mut().enumerate() {
        el.z = (i + 1) as i32;
        el.rev = (i + 1) as i64;
    }
    original.presences.push(Presence {
        id: "orchestrator".to_owned(),
        name: "Orchestrator".to_owned(),
        color: PresenceColor::Coral,
        x: 200.0,
        y: 160.0,
        status: Some("planning".to_owned()),
        selected_ids: vec![ElementId::new("el-card")],
        rev: 2,
        ..Presence::default()
    });

    let mut entries = Vec::new();
    let meta_write = encode_meta_write(&original.meta);
    entries.push(make_entry(&meta_write.path, 1, meta_write.value.as_deref().unwrap()));
    for el in &original.elements {
        let w = encode_element_write(el, true);
        assert_eq!(w.op, WhiteboardEntryOp::Set);
        assert_eq!(w.if_rev, Some(el.rev));
        entries.push(make_entry(&w.path, el.rev, w.value.as_deref().unwrap()));
    }
    for p in &original.presences {
        let w = encode_presence_write(p);
        entries.push(make_entry(&w.path, p.rev, w.value.as_deref().unwrap()));
    }

    let decoded = decode_board_entries(&entries, 42);
    assert_eq!(decoded.seq, 42);
    assert_eq!(decoded.meta, original.meta);
    assert_eq!(decoded.elements.len(), original.elements.len());
    assert_eq!(decoded.presences.len(), 1);
    assert_eq!(decoded.presences[0].color, PresenceColor::Coral);

    let decoded_card = decoded.element(&ElementId::new("el-card")).expect("card decoded");
    assert_eq!(decoded_card.extra.0.get("customTag"), Some(&serde_json::json!("keep-me")));
    assert_eq!(decoded_card.kind, original.element(&ElementId::new("el-card")).unwrap().kind);
    assert!(matches!(
        decoded.element(&ElementId::new("el-text-callout")).unwrap().kind,
        ElementKind::Text {
            variant: TextVariant::Callout,
            ..
        }
    ));
    assert!(matches!(decoded.element(&ElementId::new("el-table")).unwrap().kind, ElementKind::Table { .. }));
    assert!(matches!(decoded.element(&ElementId::new("el-claim")).unwrap().kind, ElementKind::Claim { .. }));
    assert!(matches!(
        decoded.element(&ElementId::new("el-html")).unwrap().kind,
        ElementKind::HtmlEmbed { .. }
    ));

    // Verify RFC 7396 merge patch only sends changed fields and keeps unchanged fields out.
    let mut updated_card = decoded_card.clone();
    updated_card.translate(25.0, 15.0);
    let patch = encode_element_patch(decoded_card, &updated_card, true);
    assert_eq!(patch.op, WhiteboardEntryOp::Patch);
    assert_eq!(patch.if_rev, Some(decoded_card.rev));
    let patch_obj = patch.value.as_deref().unwrap();
    assert!(patch_obj.contains("125"));
    assert!(patch_obj.contains("135"));
    assert!(!patch_obj.contains("Launch Milestone"));

    // Verify JSON Canvas import preserves groups, cards, and bound edges.
    let canvas_json = r#"{
        "nodes": [
            {"id":"g1","type":"group","x":0,"y":0,"width":500,"height":300,"label":"Group A"},
            {"id":"t1","type":"text","x":40,"y":40,"width":180,"height":100,"text":"Node A\nDetails","color":"3"},
            {"id":"t2","type":"text","x":280,"y":40,"width":180,"height":100,"text":"Node B","color":"4"}
        ],
        "edges": [
            {"id":"e1","fromNode":"t1","fromSide":"right","toNode":"t2","toSide":"left","fromEnd":"none","toEnd":"arrow","label":"links"}
        ]
    }"#;
    let jc = Canvas::from_json_str(canvas_json).unwrap();
    assert!(matches!(jc.nodes[0], CanvasNode::Group(_)));
    assert_eq!(jc.edges[0].from_side, Some(Side::Right));
    assert_eq!(jc.edges[0].from_end, Some(End::None));
    assert_eq!(jc.edges[0].to_end, Some(End::Arrow));
    let imported = import_json_canvas(&jc, "Imported");
    assert_eq!(imported.elements.len(), 4);
    assert_eq!(imported.element(&ElementId::new("t1")).unwrap().parent_id, Some(ElementId::new("g1")));
    assert_eq!(imported.element(&ElementId::new("t1")).unwrap().kind.as_shape_fill(), Some(&WbFill::Sun));
    assert_eq!(imported.element(&ElementId::new("t2")).unwrap().kind.as_shape_fill(), Some(&WbFill::Leaf));
}

trait ShapeFillExt {
    fn as_shape_fill(&self) -> Option<&WbFill>;
}

impl ShapeFillExt for ElementKind {
    fn as_shape_fill(&self) -> Option<&WbFill> {
        match self {
            ElementKind::Shape { fill, .. } => Some(fill),
            _ => None,
        }
    }
}

#[test]
fn spatial_index_viewport_culling_and_point_queries() {
    let mut doc = BoardDoc::new("Spatial");
    doc.elements.push(ElementRecord::new(
        "near",
        ElementKind::Shape {
            x: 50.0,
            y: 60.0,
            w: 160.0,
            h: 90.0,
            shape: ShapeKind::Rect,
            title: "Near".to_owned(),
            body: String::new(),
            fill: WbFill::Default,
            stroke: None,
            stroke_style: StrokeStyle::Solid,
            corner_radius: None,
            sticker: None,
            sticker_svg: None,
            badge: None,
            align: TextAlign::Center,
        },
    ));
    doc.elements.push(ElementRecord::new(
        "far",
        ElementKind::Shape {
            x: 4200.0,
            y: 3600.0,
            w: 200.0,
            h: 120.0,
            shape: ShapeKind::Rect,
            title: "Far".to_owned(),
            body: String::new(),
            fill: WbFill::Default,
            stroke: None,
            stroke_style: StrokeStyle::Solid,
            corner_radius: None,
            sticker: None,
            sticker_svg: None,
            badge: None,
            align: TextAlign::Center,
        },
    ));
    let spatial = SpatialIndex::build(&doc);
    let visible = spatial.visible_element_ids(&doc, Rect2::new(0.0, 0.0, 800.0, 600.0), 32.0);
    assert_eq!(visible, vec![ElementId::new("near")]);

    let pt_hits = spatial.query_point(Point2::new(4250.0, 3650.0), 12.0);
    assert_eq!(pt_hits, vec![1]);
}

#[test]
fn geometry_camera_splines_arrow_routing_and_rotation_bbox() {
    let mut cam = Camera {
        pan_x: 100.0,
        pan_y: 80.0,
        zoom: 1.0,
    };
    let cursor = Point2::new(420.0, 290.0);
    let world_before = cam.screen_to_world(cursor);
    cam.zoom_at(cursor, 1.8);
    let world_after = cam.screen_to_world(cursor);
    assert!(world_before.distance(world_after) < 1e-6);

    let pts = vec![Point2::new(0.0, 0.0), Point2::new(100.0, -40.0), Point2::new(220.0, 20.0)];
    let sampled = sample_polyline(&pts, 0.5);
    assert!(sampled.x > 60.0 && sampled.x < 160.0);
    let t_proj = project_point_to_polyline(&pts, sampled);
    assert!((t_proj - 0.5).abs() < 0.15);

    let mut lookup = std::collections::HashMap::new();
    lookup.insert(ElementId::new("left"), Rect2::new(100.0, 100.0, 140.0, 80.0));
    lookup.insert(ElementId::new("right"), Rect2::new(400.0, 100.0, 140.0, 80.0));

    let smooth = route_arrow(
        &ArrowEndpoint::Bound {
            id: ElementId::new("left"),
            side: Some(AnchorSide::E),
        },
        &ArrowEndpoint::Bound {
            id: ElementId::new("right"),
            side: Some(AnchorSide::W),
        },
        &[],
        ArrowCurve::Smooth,
        &lookup,
    )
    .unwrap();
    assert!((smooth.start.x - 240.0).abs() < 1e-6);
    assert!((smooth.end.x - 400.0).abs() < 1e-6);

    // Opposite-facing orthogonal connector must detour around source/target boxes rather than backtracking through them.
    let ortho_detour = route_arrow(
        &ArrowEndpoint::Bound {
            id: ElementId::new("left"),
            side: Some(AnchorSide::W),
        },
        &ArrowEndpoint::Bound {
            id: ElementId::new("right"),
            side: Some(AnchorSide::E),
        },
        &[],
        ArrowCurve::Orthogonal,
        &lookup,
    )
    .unwrap();
    let poly = ortho_detour.sample_points();
    assert!(poly.len() >= 6);
    assert!(poly.iter().any(|p| p.y < 100.0 || p.y > 180.0));

    let straight = route_arrow(
        &ArrowEndpoint::Free(Point2::new(10.0, 10.0)),
        &ArrowEndpoint::Free(Point2::new(110.0, 60.0)),
        &[],
        ArrowCurve::Straight,
        &lookup,
    )
    .unwrap();
    assert_eq!(straight.sample_points().len(), 2);

    let r = Rect2::new(100.0, 100.0, 160.0, 80.0);
    let rot90 = rotated_bbox(r, 90.0);
    assert!((rot90.w - 80.0).abs() < 1e-4);
    assert!((rot90.h - 160.0).abs() < 1e-4);
}

#[test]
fn snap_align_distribute_and_tidy_grid() {
    let mut doc = BoardDoc::new("Snap");
    for (id, x, y, w, h) in [
        ("a", 100.0, 100.0, 120.0, 80.0),
        ("b", 260.0, 100.0, 120.0, 80.0),
        ("c", 425.0, 104.0, 120.0, 80.0),
    ] {
        doc.elements.push(ElementRecord::new(
            id,
            ElementKind::Shape {
                x,
                y,
                w,
                h,
                shape: ShapeKind::Rect,
                title: id.to_owned(),
                body: String::new(),
                fill: WbFill::Default,
                stroke: None,
                stroke_style: StrokeStyle::Solid,
                corner_radius: None,
                sticker: None,
                sticker_svg: None,
                badge: None,
                align: TextAlign::Center,
            },
        ));
    }
    let lookup = doc.rect_lookup();
    let cfg = SnapConfig::default();
    let proposed = Rect2::new(420.0, 103.0, 120.0, 80.0);
    let (delta, guides) = compute_move_snap(&doc, &lookup, &[ElementId::new("c")], proposed, &cfg);
    assert!((delta.y - (-3.0)).abs() < 1e-6, "snap to top alignment y=100");
    assert!(guides.iter().any(|g| matches!(g, SnapGuide::Align { .. })));
    assert!(guides.iter().any(|g| matches!(g, SnapGuide::Spacing { gap, .. } if (*gap - 40.0).abs() < 2.0)));

    let (resized, res_guides) = compute_resize_snap(
        &doc,
        &lookup,
        &ElementId::new("c"),
        vibevalley_rich::engine::whiteboard::ResizeHandle8::Se,
        Rect2::new(425.0, 104.0, 120.0, 74.0),
        &cfg,
    );
    assert!((resized.bottom() - 180.0).abs() < 1e-6);
    assert!(!res_guides.is_empty());

    let ids = vec![ElementId::new("a"), ElementId::new("b"), ElementId::new("c")];
    let align_top = compute_align_deltas(&doc, &ids, AlignOp::Top);
    assert_eq!(align_top.len(), 3);
    assert!((align_top[2].1.y - (-4.0)).abs() < 1e-6);

    let dist_h = compute_distribute_deltas(&doc, &ids, DistributeAxis::Horizontal);
    assert_eq!(dist_h.len(), 3);
    let b_new_x = 260.0 + dist_h[1].1.x;
    assert!((b_new_x - 262.5).abs() < 1e-6);

    let tidy = compute_tidy_grid_deltas(&doc, &ids, 24.0);
    assert_eq!(tidy.len(), 3);
}

#[test]
fn ink_simplify_tapered_outline_and_eraser_hit() {
    let line: Vec<StrokePoint> = (0..12)
        .map(|i| StrokePoint::new(i as f64 * 20.0, 100.0 + (if i == 6 { 0.2 } else { 0.0 }), 0.7))
        .collect();
    let simplified = simplify_stroke_points(&line, 1.5);
    assert_eq!(simplified.len(), 2);

    let pen_outline = build_ink_outline(&simplified, 4.0, InkMode::Pen);
    let hl_outline = build_ink_outline(&simplified, 16.0, InkMode::Highlighter);
    assert_eq!(pen_outline.len(), 4);
    assert_eq!(hl_outline.len(), 4);

    let mut doc = BoardDoc::new("Ink");
    doc.elements.push(ElementRecord::new(
        "p-1",
        ElementKind::Path {
            points: simplified,
            stroke: "#a83a2c".to_owned(),
            stroke_width: 4.0,
            mode: InkMode::Pen,
        },
    ));
    let hits = strokes_hit_by_eraser(&doc, &[Point2::new(100.0, 104.0)], 8.0);
    assert_eq!(hits, vec![ElementId::new("p-1")]);
    let misses = strokes_hit_by_eraser(&doc, &[Point2::new(100.0, 160.0)], 8.0);
    assert!(misses.is_empty());
}

#[test]
fn stickers_and_templates_all_valid_and_bilingual() {
    assert!(STICKERS.len() >= 25);
    for spec in STICKERS {
        assert!(
            sticker_drawing(spec.id).is_some(),
            "sticker `{}` must compile via nsh_core::svg::drawing",
            spec.id
        );
    }

    for kind in TemplateKind::ALL {
        let zh = build_template_doc(kind, &TemplateCopy::zh());
        let en = build_template_doc(kind, &TemplateCopy::en());
        assert!(!zh.elements.is_empty(), "{kind:?} zh must be non-empty");
        assert!(!en.elements.is_empty(), "{kind:?} en must be non-empty");
        assert!(zh.content_bounds().is_some());
        assert!(en.content_bounds().is_some());
    }

    let ws_en = build_template_doc(TemplateKind::Workshop, &TemplateCopy::en());
    assert_eq!(ws_en.elements.iter().filter(|e| e.is_container()).count(), 5);
    assert_eq!(ws_en.presences.len(), 3);
    assert!(ws_en.presences.iter().any(|p| p.status.as_deref().is_some_and(|s| s.len() > 20)));
    assert!(ws_en.element(&ElementId::new("ws-who-1")).unwrap().parent_id == Some(ElementId::new("ws-c-who")));
}

#[test]
fn controller_end_to_end_interactions_history_and_concurrency() {
    let mut ctrl = WhiteboardController::new(build_template_doc(TemplateKind::Architecture, &TemplateCopy::en()));
    ctrl.set_viewport_size(1200.0, 760.0);

    // Wheel & pinch zoom keep pointer anchor stable.
    let zoom_before = ctrl.camera.zoom;
    let _ = ctrl.handle_wheel(
        Point2::new(500.0, 320.0),
        0.0,
        -50.0,
        true,
        Modifiers {
            accel: true,
            ..Modifiers::default()
        },
    );
    assert!(ctrl.camera.zoom > zoom_before);
    let zoom_mid = ctrl.camera.zoom;
    let _ = ctrl.handle_pinch(Point2::new(500.0, 320.0), 0.25);
    assert!(ctrl.camera.zoom > zoom_mid);
    let _ = ctrl.run_action(BoardAction::ResetZoom);
    assert!((ctrl.camera.zoom - 1.0).abs() < 1e-6);

    // Directional marquee: left-to-right (Contain) vs right-to-left (Intersect).
    let n_ui = ctrl.lookup[&ElementId::new("n-ui")];
    let p_tl = ctrl.camera.world_to_screen(Point2::new(n_ui.x - 10.0, n_ui.y - 10.0));
    let p_mid = ctrl.camera.world_to_screen(Point2::new(n_ui.center().x, n_ui.center().y));
    let p_br = ctrl.camera.world_to_screen(Point2::new(n_ui.right() + 10.0, n_ui.bottom() + 10.0));
    let down_primary = |pos: Point2| PointerInput {
        screen_pos: pos,
        clicks: 1,
        button: PointerButton::Primary,
        modifiers: Modifiers::default(),
        pressure: 0.7,
    };

    // Tiny L->R marquee over only top-left corner of n-ui should NOT select it (Contain mode).
    ctrl.handle_pointer_down(down_primary(p_tl));
    ctrl.handle_pointer_move(down_primary(p_mid));
    ctrl.handle_pointer_up(down_primary(p_mid));
    assert!(!ctrl.selection.contains(&ElementId::new("n-ui")));

    // R->L marquee from empty background inside z-core intersecting corner of n-ui DOES select it (Intersect mode).
    ctrl.handle_pointer_down(down_primary(p_br));
    ctrl.handle_pointer_move(down_primary(p_mid));
    ctrl.handle_pointer_up(down_primary(p_mid));
    assert!(ctrl.selection.contains(&ElementId::new("n-ui")));

    // Full L->R marquee also selects n-ui cleanly.
    ctrl.handle_pointer_down(down_primary(p_tl));
    ctrl.handle_pointer_move(down_primary(p_br));
    ctrl.handle_pointer_up(down_primary(p_br));
    assert!(ctrl.selection.contains(&ElementId::new("n-ui")));

    // Drag with snap + Undo coalescing (3 incremental moves -> 1 undo step!).
    let start_rect = ctrl.lookup[&ElementId::new("n-ui")];
    let start_screen = ctrl.camera.world_to_screen(start_rect.center());
    ctrl.handle_pointer_down(down_primary(start_screen));
    ctrl.handle_pointer_move(down_primary(Point2::new(start_screen.x + 12.0, start_screen.y)));
    ctrl.handle_pointer_move(down_primary(Point2::new(start_screen.x + 28.0, start_screen.y)));
    let move_effects = ctrl.handle_pointer_up(down_primary(Point2::new(start_screen.x + 42.0, start_screen.y)));
    assert!(move_effects.iter().any(|e| matches!(e, ControllerEffect::FlushBatch(w) if !w.is_empty())));
    let moved_rect = ctrl.lookup[&ElementId::new("n-ui")];
    assert!(moved_rect.x > start_rect.x + 20.0);

    // 8-handle resize with Alt (from center) & Shift (aspect lock).
    ctrl.selection = vec![ElementId::new("n-ui")];
    let se_handle = ctrl.camera.world_to_screen(Point2::new(moved_rect.right(), moved_rect.bottom()));
    ctrl.handle_pointer_down(PointerInput {
        screen_pos: se_handle,
        clicks: 1,
        button: PointerButton::Primary,
        modifiers: Modifiers {
            shift: true,
            alt: true,
            ..Modifiers::default()
        },
        pressure: 0.5,
    });
    ctrl.handle_pointer_move(PointerInput {
        screen_pos: Point2::new(se_handle.x + 30.0, se_handle.y + 40.0),
        clicks: 1,
        button: PointerButton::Primary,
        modifiers: Modifiers {
            shift: true,
            alt: true,
            ..Modifiers::default()
        },
        pressure: 0.5,
    });
    ctrl.handle_pointer_up(down_primary(Point2::new(se_handle.x + 30.0, se_handle.y + 40.0)));
    let resized_rect = ctrl.lookup[&ElementId::new("n-ui")];
    assert!(resized_rect.w > moved_rect.w);
    assert!(((resized_rect.w / resized_rect.h) - (moved_rect.w / moved_rect.h)).abs() < 0.05);

    // Rotation handle with Shift snaps to 15-degree increments.
    let rot_pos = ctrl
        .camera
        .world_to_screen(Point2::new(resized_rect.center().x, resized_rect.y - 26.0 / ctrl.camera.zoom));
    ctrl.handle_pointer_down(down_primary(rot_pos));
    ctrl.handle_pointer_move(PointerInput {
        screen_pos: ctrl.camera.world_to_screen(Point2::new(resized_rect.right() + 40.0, resized_rect.center().y)),
        clicks: 1,
        button: PointerButton::Primary,
        modifiers: Modifiers {
            shift: true,
            ..Modifiers::default()
        },
        pressure: 0.5,
    });
    ctrl.handle_pointer_up(down_primary(rot_pos));
    let rot_deg = ctrl.doc.element(&ElementId::new("n-ui")).unwrap().rotation_deg;
    assert!((rot_deg % 15.0).abs() < 1e-4);

    // Container drag moves child elements with it.
    let z_core_rect = ctrl.lookup[&ElementId::new("z-core")];
    let n_eng_before = ctrl.lookup[&ElementId::new("n-eng")];
    let header_pt = ctrl.camera.world_to_screen(Point2::new(z_core_rect.x + 40.0, z_core_rect.y + 14.0));
    ctrl.handle_pointer_down(down_primary(header_pt));
    ctrl.handle_pointer_move(down_primary(Point2::new(header_pt.x + 40.0, header_pt.y + 20.0)));
    ctrl.handle_pointer_up(down_primary(Point2::new(header_pt.x + 40.0, header_pt.y + 20.0)));
    let n_eng_after = ctrl.lookup[&ElementId::new("n-eng")];
    assert!((n_eng_after.x - n_eng_before.x - 40.0).abs() < 12.0);

    // Arrow tool bound to anchor ports.
    ctrl.set_tool(Tool::Arrow);
    let srv_rect = ctrl.lookup[&ElementId::new("n-srv")];
    let db_rect = ctrl.lookup[&ElementId::new("n-db")];
    let from_pt = ctrl.camera.world_to_screen(Point2::new(srv_rect.x + 4.0, srv_rect.center().y));
    let to_pt = ctrl.camera.world_to_screen(Point2::new(db_rect.x + 4.0, db_rect.center().y));
    ctrl.handle_pointer_down(down_primary(from_pt));
    ctrl.handle_pointer_move(down_primary(to_pt));
    ctrl.handle_pointer_up(down_primary(to_pt));
    let bound_arrows = ctrl
        .doc
        .elements
        .iter()
        .filter(|e| matches!(&e.kind, ElementKind::Arrow { from: ArrowEndpoint::Bound { id: f, .. }, to: ArrowEndpoint::Bound { id: t, .. }, .. } if f == &ElementId::new("n-srv") && t == &ElementId::new("n-db")))
        .count();
    assert_eq!(bound_arrows, 2);

    // Inline edit commit.
    let edit_eff = ctrl.commit_inline_edit(&ElementId::new("n-srv"), "Updated Service".to_owned(), "SSE live".to_owned(), None);
    assert!(!edit_eff.is_empty());
    assert_eq!(ctrl.doc.element(&ElementId::new("n-srv")).unwrap().primary_label(), "Updated Service");

    // Duplicate selection remaps bound arrow endpoints to the duplicated copies.
    ctrl.selection = vec![ElementId::new("n-srv"), ElementId::new("n-db"), ElementId::new("e-3")];
    let _ = ctrl.run_action(BoardAction::DuplicateSelection);
    assert_eq!(ctrl.selection.len(), 3);
    let dup_arrow = ctrl.doc.element(&ctrl.selection[2]).unwrap();
    if let ElementKind::Arrow { from, to, .. } = &dup_arrow.kind {
        assert_eq!(
            from,
            &ArrowEndpoint::Bound {
                id: ctrl.selection[0].clone(),
                side: Some(AnchorSide::S)
            }
        );
        assert_eq!(
            to,
            &ArrowEndpoint::Bound {
                id: ctrl.selection[1].clone(),
                side: Some(AnchorSide::N)
            }
        );
    } else {
        panic!("expected duplicated arrow");
    }

    // Pen draw + eraser sweep.
    ctrl.set_tool(Tool::Pen);
    ctrl.handle_pointer_down(down_primary(Point2::new(120.0, 500.0)));
    ctrl.handle_pointer_move(down_primary(Point2::new(220.0, 510.0)));
    ctrl.handle_pointer_move(down_primary(Point2::new(320.0, 505.0)));
    ctrl.handle_pointer_up(down_primary(Point2::new(320.0, 505.0)));
    assert!(ctrl.doc.elements.iter().any(|e| matches!(e.kind, ElementKind::Path { .. })));

    ctrl.set_tool(Tool::Eraser);
    ctrl.handle_pointer_down(down_primary(Point2::new(220.0, 510.0)));
    ctrl.handle_pointer_up(down_primary(Point2::new(220.0, 510.0)));
    assert!(!ctrl.doc.elements.iter().any(|e| matches!(e.kind, ElementKind::Path { .. })));

    // Simulate remote rev bump on `n-ui` before undoing so Undo uses live rev!
    let mut remote_ui = ctrl.doc.element(&ElementId::new("n-ui")).unwrap().clone();
    remote_ui.rev = 77;
    let w_remote = encode_element_write(&remote_ui, false);
    ctrl.apply_remote_delta(&[make_entry(&w_remote.path, 77, w_remote.value.as_deref().unwrap())], &[], 99);

    // Undo / Redo across history + bounded 200-step cap check.
    while ctrl.history.can_undo() {
        let undo_eff = ctrl.run_action(BoardAction::Undo);
        assert!(undo_eff.iter().any(|e| matches!(e, ControllerEffect::FlushBatch(_))));
    }
    let after_undo_rev = ctrl.doc.element(&ElementId::new("n-ui")).unwrap().rev;
    assert_eq!(after_undo_rev, 77);
    let redo_eff = ctrl.run_action(BoardAction::Redo);
    assert!(!redo_eff.is_empty());

    // Verify bounded UndoHistory limit (200 steps).
    let mut doc = BoardDoc::new("Bounded");
    let mut hist = UndoHistory::default();
    let el = ElementRecord::new(
        "item",
        ElementKind::Shape {
            x: 0.0,
            y: 0.0,
            w: 100.0,
            h: 60.0,
            shape: ShapeKind::Rect,
            title: "Box".to_owned(),
            body: String::new(),
            fill: WbFill::Default,
            stroke: None,
            stroke_style: StrokeStyle::Solid,
            corner_radius: None,
            sticker: None,
            sticker_svg: None,
            badge: None,
            align: TextAlign::Center,
        },
    );
    apply_command(&mut doc, Some(&mut hist), BoardCommand::CreateElements(vec![el]), None, false);
    for _ in 0..(DEFAULT_HISTORY_LIMIT + 15) {
        apply_command(
            &mut doc,
            Some(&mut hist),
            BoardCommand::MoveElements {
                deltas: vec![(ElementId::new("item"), Vec2::new(2.0, 0.0))],
                include_container_children: false,
            },
            None,
            false,
        );
    }
    let mut popped = 0usize;
    while hist.pop_undo().is_some() {
        popped += 1;
    }
    assert_eq!(popped, DEFAULT_HISTORY_LIMIT);

    // Remote delete removes item cleanly.
    let rem = apply_remote_entries(&mut doc, &[], &["elements/item".to_owned()], 100);
    assert_eq!(rem, vec![ElementId::new("item")]);
    assert!(doc.elements.is_empty());
}

#[test]
fn presence_decode_smooth_interpolation_follow_viewport_and_manual_exit() {
    let raw = r##"[
        {"id":"legacy-1","name":"Legacy Peer","color":"teal","x":180,"y":220,"status":"审阅中"},
        {"id":"agent-hl","name":"Designer","color":"#3b82f6","kind":"highlight","x":400,"y":300,"w":260,"h":150,"status":"排版中","viewport":{"x":300,"y":200,"w":800,"h":500,"zoom":1.25},"updatedAt":100},
        {"id":"agent-hl","name":"Designer","color":"#3b82f6","kind":"highlight","x":420,"y":310,"w":260,"h":150,"status":"排版中","viewport":{"x":320,"y":210,"w":800,"h":500,"zoom":1.25},"updatedAt":200},
        {"id":"vp-only","name":"Observer","color":"lavender","kind":"viewport","viewport":{"x":900,"y":600,"w":600,"h":400,"zoom":0.9},"updatedAt":150},
        {"id":"claim-1","name":"Coder","color":"coral","kind":"claim","x":50,"y":80,"w":220,"h":120,"status":"重构模块"}
    ]"##;
    let decoded = decode_presences_json(raw);
    assert_eq!(decoded.len(), 4, "duplicate id must keep newer updatedAt");

    let legacy = decoded.iter().find(|p| p.id == "legacy-1").unwrap();
    assert_eq!(legacy.kind, PresenceKind::Cursor);
    assert_eq!(legacy.color, PresenceColor::Teal);
    assert!(legacy.has_cursor);

    let hl = decoded.iter().find(|p| p.id == "agent-hl").unwrap();
    assert_eq!(hl.kind, PresenceKind::Highlight);
    assert_eq!(hl.custom_color.as_deref(), Some("#3b82f6"));
    assert_eq!(hl.x, 420.0);
    assert_eq!(hl.region_rect(), Some(Rect2::new(420.0, 310.0, 260.0, 150.0)));
    assert_eq!(
        hl.viewport,
        Some(PresenceViewport {
            x: 320.0,
            y: 210.0,
            w: 800.0,
            h: 500.0,
            zoom: Some(1.25),
        })
    );

    let vp_only = decoded.iter().find(|p| p.id == "vp-only").unwrap();
    assert_eq!(vp_only.kind, PresenceKind::Viewport);
    assert!(!vp_only.has_cursor);
    assert_eq!(vp_only.focus_point(), Point2::new(1200.0, 800.0));

    let claim = decoded.iter().find(|p| p.id == "claim-1").unwrap();
    assert_eq!(claim.kind, PresenceKind::Claim);
    assert_eq!(claim.region_rect(), Some(Rect2::new(50.0, 80.0, 220.0, 120.0)));

    // Smooth cursor interpolation: initial spawn has zero animation; subsequent moves glide & settle cleanly.
    let mut ctrl = WhiteboardController::new(BoardDoc::new("Collab"));
    ctrl.set_viewport_size(1200.0, 760.0);
    ctrl.smooth_animations = true;

    let initial = decode_presences_json(r#"[{"id":"p1","name":"Planner","color":"coral","x":100,"y":100,"status":"规划中"}]"#);
    ctrl.apply_live_presences(&[], initial);
    assert!(!ctrl.needs_animation(), "first presence spawn must not spin idle animation");

    let moved = decode_presences_json(r#"[{"id":"p1","name":"Planner","color":"coral","x":400,"y":280,"status":"规划中"}]"#);
    ctrl.apply_live_presences(&[], moved);
    assert!(ctrl.needs_animation());

    let step1 = ctrl.step_animations(0.016, false);
    assert!(step1.presence_moved);
    assert!(!step1.camera_moved);
    let mid_pose = ctrl.displayed_pose(&ctrl.doc.presences[0]);
    assert!(mid_pose.x > 100.0 && mid_pose.x < 400.0, "cursor should interpolate smoothly");
    assert!(mid_pose.y > 100.0 && mid_pose.y < 280.0);

    for _ in 0..80 {
        if !ctrl.needs_animation() {
            break;
        }
        ctrl.step_animations(0.016, false);
    }
    assert!(!ctrl.needs_animation(), "cursor animation must settle with zero idle spins");
    let final_pose = ctrl.displayed_pose(&ctrl.doc.presences[0]);
    assert!((final_pose.x - 400.0).abs() < 1e-6);
    assert!((final_pose.y - 280.0).abs() < 1e-6);

    // Reduced-motion degradation (`instant = true`) snaps immediately in one step.
    let moved2 = decode_presences_json(r#"[{"id":"p1","name":"Planner","color":"coral","x":900,"y":600}]"#);
    ctrl.apply_live_presences(&[], moved2);
    let snap_res = ctrl.step_animations(0.016, true);
    assert!(snap_res.presence_moved);
    assert!(!snap_res.still_animating);
    assert!((ctrl.displayed_pose(&ctrl.doc.presences[0]).x - 900.0).abs() < 1e-6);

    // Follow mode tracks remote viewport smoothly (pan + zoom) and exits immediately on manual input.
    let with_vp =
        decode_presences_json(r#"[{"id":"p1","name":"Planner","color":"coral","x":1200,"y":800,"viewport":{"x":900,"y":600,"w":600,"h":400,"zoom":1.4}}]"#);
    ctrl.apply_live_presences(&[], with_vp);
    let follow_effs = ctrl.run_action(BoardAction::FollowActor(Some("p1".to_owned())));
    assert_eq!(ctrl.follow_actor.as_deref(), Some("p1"));
    assert!(follow_effs.contains(&ControllerEffect::FollowChanged(Some("p1".to_owned()))));
    assert!(ctrl.needs_animation(), "smooth follow queues camera interpolation");

    for _ in 0..100 {
        if !ctrl.needs_animation() {
            break;
        }
        ctrl.step_animations(0.016, false);
    }
    assert!(!ctrl.needs_animation());
    let vis = ctrl.camera.visible_world_rect(1200.0, 760.0);
    assert!((vis.center().x - 1200.0).abs() < 2.0, "camera centered on followed viewport X");
    assert!((vis.center().y - 800.0).abs() < 2.0, "camera centered on followed viewport Y");
    assert!((ctrl.camera.zoom - 1.4).abs() < 0.05, "camera zoom matches followed viewport");

    // Manual pan drag immediately exits Follow mode.
    let pan_effs = ctrl.handle_pointer_down(PointerInput {
        screen_pos: Point2::new(300.0, 300.0),
        clicks: 1,
        button: PointerButton::Middle,
        modifiers: Modifiers::default(),
        pressure: 0.5,
    });
    assert!(ctrl.follow_actor.is_none());
    assert!(pan_effs.contains(&ControllerEffect::FollowChanged(None)));
    ctrl.handle_pointer_up(PointerInput {
        screen_pos: Point2::new(340.0, 300.0),
        clicks: 1,
        button: PointerButton::Middle,
        modifiers: Modifiers::default(),
        pressure: 0.5,
    });

    // Re-enter Follow, then exit via wheel.
    ctrl.run_action(BoardAction::FollowActor(Some("p1".to_owned())));
    assert_eq!(ctrl.follow_actor.as_deref(), Some("p1"));
    let wheel_effs = ctrl.handle_wheel(Point2::new(400.0, 300.0), 10.0, 0.0, true, Modifiers::default());
    assert!(ctrl.follow_actor.is_none());
    assert!(wheel_effs.contains(&ControllerEffect::FollowChanged(None)));

    // Re-enter Follow, then exit via Reset View (ResetZoom).
    ctrl.run_action(BoardAction::FollowActor(Some("p1".to_owned())));
    let reset_effs = ctrl.run_action(BoardAction::ResetZoom);
    assert!(ctrl.follow_actor.is_none());
    assert!(reset_effs.contains(&ControllerEffect::FollowChanged(None)));
    assert!((ctrl.camera.zoom - 1.0).abs() < 1e-6);

    // Re-enter Follow, then exit via Escape key.
    ctrl.run_action(BoardAction::FollowActor(Some("p1".to_owned())));
    let esc_effs = ctrl.handle_key_down("Escape", Modifiers::default());
    assert!(ctrl.follow_actor.is_none());
    assert!(esc_effs.contains(&ControllerEffect::FollowChanged(None)));

    // Re-enter Follow, then followed peer goes offline -> auto-exits Follow.
    ctrl.run_action(BoardAction::FollowActor(Some("p1".to_owned())));
    let gone_effs = ctrl.apply_live_presences(&[], Vec::new());
    assert!(ctrl.follow_actor.is_none());
    assert!(gone_effs.contains(&ControllerEffect::FollowChanged(None)));
}

#[test]
fn wheel_zoom_scales_line_deltas_and_ignores_zero_deltas() {
    let mut ctrl = WhiteboardController::new(build_template_doc(TemplateKind::Architecture, &TemplateCopy::en()));
    ctrl.set_viewport_size(1200.0, 760.0);
    ctrl.follow_actor = Some("peer-1".to_owned());
    let initial_cam = ctrl.camera;

    // Zero wheel delta is a complete no-op (no effects, no camera drift, follow stays intact).
    let zero_wheel = ctrl.handle_wheel(
        Point2::new(600.0, 380.0),
        0.0,
        0.0,
        true,
        Modifiers {
            accel: true,
            ..Modifiers::default()
        },
    );
    assert!(zero_wheel.is_empty());
    assert_eq!(ctrl.camera, initial_cam);
    assert_eq!(ctrl.follow_actor.as_deref(), Some("peer-1"));

    // Zero pinch delta is also a complete no-op.
    let zero_pinch = ctrl.handle_pinch(Point2::new(600.0, 380.0), 0.0);
    assert!(zero_pinch.is_empty());
    assert_eq!(ctrl.camera, initial_cam);
    assert_eq!(ctrl.follow_actor.as_deref(), Some("peer-1"));

    // Non-precise (mouse wheel line-delta) Cmd/Ctrl+scroll scales delta_y by 22x to match precise trackpad zoom.
    let cursor = Point2::new(500.0, 320.0);
    let mut precise_ctrl = WhiteboardController::new(build_template_doc(TemplateKind::Architecture, &TemplateCopy::en()));
    precise_ctrl.set_viewport_size(1200.0, 760.0);
    let accel = Modifiers {
        accel: true,
        ..Modifiers::default()
    };
    let line_effs = ctrl.handle_wheel(cursor, 0.0, -3.0, false, accel);
    let precise_effs = precise_ctrl.handle_wheel(cursor, 0.0, -66.0, true, accel);
    assert!(line_effs.iter().any(|e| matches!(e, ControllerEffect::ViewportChanged { .. })));
    assert!(precise_effs.iter().any(|e| matches!(e, ControllerEffect::ViewportChanged { .. })));
    assert!(ctrl.camera.zoom > initial_cam.zoom * 1.25, "line-delta wheel zoom should zoom visibly");
    assert!(
        (ctrl.camera.zoom - precise_ctrl.camera.zoom).abs() < 1e-6,
        "line-delta (-3.0) must match precise (-66.0) zoom factor"
    );
}

#[test]
fn regression_creating_text_card_sticky_or_callout_emits_open_inline_editor() {
    let mut ctrl = WhiteboardController::new(BoardDoc::new("Create Inline"));
    ctrl.set_viewport_size(1200.0, 760.0);

    let click = |x: f64, y: f64| PointerInput {
        screen_pos: Point2::new(x, y),
        clicks: 1,
        button: PointerButton::Primary,
        modifiers: Modifiers::default(),
        pressure: 0.6,
    };

    for (idx, tool) in [Tool::Card, Tool::Text, Tool::Sticky, Tool::Callout].into_iter().enumerate() {
        ctrl.set_tool(tool.clone());
        let pos = click(200.0 + idx as f64 * 120.0, 240.0);
        let _ = ctrl.handle_pointer_down(pos);
        let up_effs = ctrl.handle_pointer_up(pos);
        assert_eq!(ctrl.tool, Tool::Select, "finish_create should still reset tool to Select for {tool:?}");
        let opened = up_effs.iter().find_map(|e| match e {
            ControllerEffect::OpenInlineEditor(target) => Some(target),
            _ => None,
        });
        let target = opened.unwrap_or_else(|| panic!("creating {tool:?} must emit OpenInlineEditor"));
        assert!(ctrl.doc.element(&target.id).is_some(), "inline target must reference the newly created element");
    }

    // Non-text tools (e.g., plain Rect) keep creating without auto-opening the inline editor.
    ctrl.set_tool(Tool::Shape(ShapeKind::Rect));
    let _ = ctrl.handle_pointer_down(click(400.0, 420.0));
    let rect_effs = ctrl.handle_pointer_up(click(520.0, 500.0));
    assert!(
        !rect_effs.iter().any(|e| matches!(e, ControllerEffect::OpenInlineEditor(_))),
        "plain Rect creation should not auto-open inline editor"
    );
}
