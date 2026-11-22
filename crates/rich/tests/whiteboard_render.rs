mod support;

use std::cell::RefCell;
use std::collections::{BTreeSet, HashSet};
use std::sync::{Arc, LazyLock};

use nsh_core::canvas::{CanvasOp, PathOp};
use nsh_core::element::Root;
use nsh_core::prelude::*;
use nsh_core::{EventKind, EventPayload};
use resvg::tiny_skia;
use support::TestHarness;
use vibevalley_protocol::{ArtifactEntry, ArtifactEntryKind};
use vibevalley_rich::engine::canvas::Canvas;
use vibevalley_rich::engine::whiteboard::{
    BoardAction, BoardDoc, Camera, ElementId, ElementKind, ElementRecord, FramePaintInput, GridStyle, InkMode, LayerPaintInput, MilestoneKind, Modifiers,
    Point2, PointerButton, PointerInput, Presence, PresenceColor, PresenceKind, PresenceViewport, Rect2, ShapeKind, SnapAxis, SnapGuide, StrokePoint,
    StrokeStyle, TemplateCopy, TemplateKind, TextAlign, TextVariant, TimelineMilestone, Tool, WbFill, WhiteboardController, WhiteboardPalette,
    build_export_painter, build_template_doc, encode_element_json, export_json, export_json_canvas, export_svg, import_json_canvas, paint_board_frame,
    paint_grid, paint_minimap, paint_overlay_layer, paint_static_layer,
};
use vibevalley_rich::{
    VvWhiteboardBatchEvent, VvWhiteboardChatEvent, VvWhiteboardCursorEvent, VvWhiteboardExportEvent, VvWhiteboardViewportEvent, vv_whiteboard,
};

static SYSTEM_FONTS: LazyLock<Arc<usvg::fontdb::Database>> = LazyLock::new(|| {
    let mut db = usvg::fontdb::Database::new();
    db.load_system_fonts();
    db.load_fonts_dir("/System/Library/Fonts");
    db.load_fonts_dir("/Library/Fonts");
    Arc::new(db)
});

fn render_svg_to_pixmap(svg: &str, scale: f32) -> (u32, u32, usize, tiny_skia::Pixmap) {
    let xml = roxmltree::Document::parse(svg).expect("SVG must be well-formed XML");
    assert_eq!(xml.root_element().tag_name().name(), "svg");
    assert!(
        !xml.descendants().any(|n| n.tag_name().name().eq_ignore_ascii_case("foreignObject")),
        "SVG export must never emit <foreignObject>"
    );
    assert!(!svg.contains("var("), "SVG export must resolve all theme tokens cleanly without CSS var()");

    let mut opts = usvg::Options {
        fontdb: SYSTEM_FONTS.clone(),
        ..usvg::Options::default()
    };
    opts.font_family = "PingFang SC".to_owned();

    let tree = usvg::Tree::from_str(svg, &opts).expect("usvg must parse exported whiteboard SVG");
    let sz = tree.size();
    let pw = ((sz.width() * scale).ceil() as u32).max(1);
    let ph = ((sz.height() * scale).ceil() as u32).max(1);
    let mut pixmap = tiny_skia::Pixmap::new(pw, ph).expect("allocate pixmap");
    resvg::render(&tree, tiny_skia::Transform::from_scale(scale, scale), &mut pixmap.as_mut());

    let mut distinct = HashSet::new();
    for px in pixmap.pixels() {
        distinct.insert((px.red(), px.green(), px.blue(), px.alpha()));
    }
    (pw, ph, distinct.len(), pixmap)
}

#[test]
fn painter_static_overlay_and_minimap_cover_all_templates_and_nodes() {
    for kind in TemplateKind::ALL {
        for (lang_name, copy) in [("zh", TemplateCopy::zh()), ("en", TemplateCopy::en())] {
            let doc = build_template_doc(kind, &copy);
            let mut ctrl = WhiteboardController::new(doc);
            ctrl.set_viewport_size(1280.0, 800.0);

            if let Some(first_id) = ctrl.doc.elements.first().map(|e| e.id.clone()) {
                ctrl.selection = vec![first_id];
            }
            ctrl.active_guides = vec![
                SnapGuide::Align {
                    axis: SnapAxis::X,
                    coord: 240.0,
                    span_min: 100.0,
                    span_max: 420.0,
                },
                SnapGuide::Spacing {
                    axis: SnapAxis::X,
                    cross_coord: 220.0,
                    start: 220.0,
                    end: 260.0,
                    gap: 40.0,
                },
            ];

            let hidden = BTreeSet::new();
            let static_light = paint_static_layer(&LayerPaintInput {
                doc: &ctrl.doc,
                index: &ctrl.spatial,
                lookup: &ctrl.lookup,
                camera: ctrl.camera,
                viewport_size: (1280.0, 800.0),
                selection: &ctrl.selection,
                editing_id: None,
                dark: false,
                anim_hidden_ids: &hidden,
            });
            assert!(!static_light.ops.is_empty(), "{kind:?} {lang_name} static ops non-empty");
            assert!(
                static_light
                    .nodes
                    .iter()
                    .any(|n| n.test_id.as_deref().is_some_and(|id| id.starts_with("wb-el-"))),
                "{kind:?} {lang_name} emits wb-el-* CanvasNodes"
            );

            // Overlay while ink drawing is active + guides + selection handles + presences.
            ctrl.set_tool(Tool::Pen);
            ctrl.handle_pointer_down(PointerInput {
                screen_pos: Point2::new(260.0, 260.0),
                clicks: 1,
                button: PointerButton::Primary,
                modifiers: Modifiers::default(),
                pressure: 0.75,
            });
            ctrl.handle_pointer_move(PointerInput {
                screen_pos: Point2::new(340.0, 290.0),
                clicks: 1,
                button: PointerButton::Primary,
                modifiers: Modifiers::default(),
                pressure: 0.9,
            });
            let overlay = paint_overlay_layer(&ctrl, (1280.0, 800.0), true);
            assert!(!overlay.ops.is_empty(), "{kind:?} {lang_name} overlay ops non-empty");

            let minimap = paint_minimap(&ctrl.doc, &ctrl.lookup, ctrl.camera, (1280.0, 800.0), (168.0, 108.0), false);
            assert!(!minimap.ops.is_empty(), "{kind:?} {lang_name} minimap ops non-empty");
        }
    }
}

#[test]
fn svg_export_and_raster_all_templates_and_all_primitives_light_and_dark() {
    for kind in TemplateKind::ALL {
        let doc = build_template_doc(kind, &TemplateCopy::en());
        let light_svg = export_svg(&doc, false);
        let dark_svg = export_svg(&doc, true);
        let (lw, lh, l_colors, l_pix) = render_svg_to_pixmap(&light_svg, 1.0);
        let (dw, dh, d_colors, d_pix) = render_svg_to_pixmap(&dark_svg, 1.0);
        assert_eq!((lw, lh), (dw, dh));
        assert!(lw > 300 && lh > 200);
        assert!(l_colors >= 12, "{kind:?} light must contain rich distinct colors (got {l_colors})");
        assert!(d_colors >= 12, "{kind:?} dark must contain rich distinct colors (got {d_colors})");
        assert_ne!(l_pix.pixel(2, 2), d_pix.pixel(2, 2), "Light & Dark page backgrounds must differ");

        let (painter, ew, eh) = build_export_painter(&doc, false);
        assert!(ew > 300.0 && eh > 200.0);
        assert!(!painter.finish().ops.is_empty());
    }

    // Showcase doc exercising Timeline + CJK copy + Pen + Highlighter + Table + Claim + Diamond + Cylinder + Sticky + Presences.
    let mut doc = build_template_doc(TemplateKind::Timeline, &TemplateCopy::zh());
    doc.elements.push(ElementRecord::new(
        "extra-ink-pen",
        ElementKind::Path {
            points: vec![
                StrokePoint::new(476.0, 324.0, 0.4),
                StrokePoint::new(506.0, 314.0, 0.8),
                StrokePoint::new(538.0, 326.0, 0.9),
                StrokePoint::new(568.0, 316.0, 0.5),
            ],
            stroke: "#a83a2c".to_owned(),
            stroke_width: 3.5,
            mode: InkMode::Pen,
        },
    ));
    doc.elements.push(ElementRecord::new(
        "extra-ink-hl",
        ElementKind::Path {
            points: vec![StrokePoint::new(492.0, 404.0, 0.7), StrokePoint::new(660.0, 404.0, 0.7)],
            stroke: "#e5a93c".to_owned(),
            stroke_width: 14.0,
            mode: InkMode::Highlighter,
        },
    ));

    let light_svg = export_svg(&doc, false);
    let dark_svg = export_svg(&doc, true);
    let (_, _, l_colors, light_pix) = render_svg_to_pixmap(&light_svg, 2.0);
    let (_, _, d_colors, dark_pix) = render_svg_to_pixmap(&dark_svg, 2.0);
    assert!(l_colors >= 20);
    assert!(d_colors >= 20);

    // Also test a kitchen-sink geometric doc (Claim, Sticky, Diamond, Cylinder, Ellipse, Triangle, Table).
    let mut shapes_doc = BoardDoc::new("Shapes Showcase");
    shapes_doc.elements.extend([
        ElementRecord::new(
            "claim-1",
            ElementKind::Claim {
                x: 40.0,
                y: 40.0,
                w: 360.0,
                h: 200.0,
                label: "Agent editing zone".to_owned(),
                agent_id: Some("orchestrator".to_owned()),
                status: Some("active".to_owned()),
            },
        ),
        ElementRecord::new(
            "sticky-1",
            ElementKind::Shape {
                x: 60.0,
                y: 80.0,
                w: 150.0,
                h: 110.0,
                shape: ShapeKind::Sticky,
                title: "Sticky".to_owned(),
                body: "Folded corner".to_owned(),
                fill: WbFill::Sun,
                stroke: None,
                stroke_style: StrokeStyle::Solid,
                corner_radius: None,
                sticker: None,
                sticker_svg: None,
                badge: Some("NEW".to_owned()),
                align: TextAlign::Left,
            },
        ),
        ElementRecord::new(
            "dia-1",
            ElementKind::Shape {
                x: 240.0,
                y: 80.0,
                w: 130.0,
                h: 90.0,
                shape: ShapeKind::Diamond,
                title: "Ready?".to_owned(),
                body: String::new(),
                fill: WbFill::Water,
                stroke: None,
                stroke_style: StrokeStyle::Dashed,
                corner_radius: None,
                sticker: None,
                sticker_svg: None,
                badge: None,
                align: TextAlign::Center,
            },
        ),
        ElementRecord::new(
            "cyl-1",
            ElementKind::Shape {
                x: 430.0,
                y: 80.0,
                w: 130.0,
                h: 100.0,
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
            "tri-1",
            ElementKind::Shape {
                x: 590.0,
                y: 80.0,
                w: 120.0,
                h: 100.0,
                shape: ShapeKind::Triangle,
                title: "Delta".to_owned(),
                body: String::new(),
                fill: WbFill::Leaf,
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
            "tbl-1",
            ElementKind::Table {
                x: 40.0,
                y: 270.0,
                w: 440.0,
                h: 150.0,
                headers: vec!["Layer".to_owned(), "Tech".to_owned()],
                rows: vec![
                    vec!["Engine".to_owned(), "Pure Rust".to_owned()],
                    vec!["Canvas".to_owned(), "nsh_core Painter".to_owned()],
                ],
                fill: WbFill::Default,
            },
        ),
    ]);
    shapes_doc.presences.push(Presence {
        id: "w1".to_owned(),
        name: "Teammate".to_owned(),
        color: PresenceColor::Teal,
        x: 500.0,
        y: 260.0,
        status: None,
        selected_ids: vec![ElementId::new("tbl-1")],
        rev: 1,
        ..Presence::default()
    });
    shapes_doc.presences.push(Presence {
        id: "agent-hl".to_owned(),
        name: "Planner".to_owned(),
        color: PresenceColor::Blue,
        custom_color: Some("#3b82f6".to_owned()),
        kind: PresenceKind::Highlight,
        x: 520.0,
        y: 270.0,
        w: Some(220.0),
        h: Some(130.0),
        status: Some("排版中".to_owned()),
        viewport: Some(PresenceViewport {
            x: 40.0,
            y: 40.0,
            w: 720.0,
            h: 420.0,
            zoom: Some(1.0),
        }),
        updated_at: Some(1_732_000_000_000),
        has_cursor: true,
        ..Presence::default()
    });
    let shapes_svg = export_svg(&shapes_doc, false);
    let (_, _, s_colors, _) = render_svg_to_pixmap(&shapes_svg, 1.0);
    assert!(s_colors >= 15);

    if std::env::var_os("VV_DUMP_WB_PNG").is_some() {
        // Also dump Workshop (EN/ZH Light + Dark) and Timeline PNGs so we can visually inspect both modes.
        let _ = light_pix.save_png("/tmp/vv-rust-wb-timeline-zh-light.png");
        let _ = dark_pix.save_png("/tmp/vv-rust-wb-timeline-zh-dark.png");

        let en_doc = build_template_doc(TemplateKind::Timeline, &TemplateCopy::en());
        let (_, _, _, en_pix) = render_svg_to_pixmap(&export_svg(&en_doc, false), 2.0);
        let _ = en_pix.save_png("/tmp/vv-rust-wb-timeline-en-light.png");

        let ws_en = build_template_doc(TemplateKind::Workshop, &TemplateCopy::en());
        let (_, _, _, ws_en_light_pix) = render_svg_to_pixmap(&export_svg(&ws_en, false), 2.0);
        let _ = ws_en_light_pix.save_png("/tmp/vv-rust-wb-workshop-en-light.png");

        let ws_zh = build_template_doc(TemplateKind::Workshop, &TemplateCopy::zh());
        let (_, _, _, ws_zh_light_pix) = render_svg_to_pixmap(&export_svg(&ws_zh, false), 2.0);
        let (_, _, _, ws_zh_dark_pix) = render_svg_to_pixmap(&export_svg(&ws_zh, true), 2.0);
        let _ = ws_zh_light_pix.save_png("/tmp/vv-rust-wb-workshop-zh-light.png");
        let _ = ws_zh_dark_pix.save_png("/tmp/vv-rust-wb-workshop-zh-dark.png");
    }

    let _ = BoardAction::ResetZoom;
    let _ = Rect2::ZERO;
}

#[test]
fn json_and_json_canvas_export_validate_and_roundtrip() {
    let doc = build_template_doc(TemplateKind::Architecture, &TemplateCopy::en());
    let json = export_json(&doc).expect("export_json succeeds");
    assert!(json.contains("\"elements\""));
    assert!(json.contains("VvWhiteboard"));

    let jc_str = export_json_canvas(&doc).expect("export_json_canvas succeeds");
    let canvas = Canvas::from_json_str(&jc_str).expect("exported JSON Canvas 1.0 passes strict spec validation");
    assert!(!canvas.nodes.is_empty());
    assert!(!canvas.edges.is_empty());

    let reimported = import_json_canvas(&canvas, "Reimported");
    assert!(reimported.elements.len() >= canvas.nodes.len() + canvas.edges.len());
}

#[derive(Default)]
struct RecordedWbEvents {
    batches: Vec<String>,
    exports: Vec<VvWhiteboardExportEvent>,
    chats: Vec<String>,
    cursors: Vec<VvWhiteboardCursorEvent>,
    viewports: Vec<VvWhiteboardViewportEvent>,
}

thread_local! {
    static WB_EVENTS: RefCell<RecordedWbEvents> = RefCell::new(RecordedWbEvents::default());
    static WB_SEED_JSON: RefCell<String> = const { RefCell::new(String::new()) };
    static WB_PRESENCES_JSON: RefCell<String> = const { RefCell::new(String::new()) };
}

#[component]
fn WhiteboardTestRoot() -> impl IntoElement {
    let entries_json = WB_SEED_JSON.with(|s| s.borrow().clone());
    let presences_json = WB_PRESENCES_JSON.with(|s| s.borrow().clone());
    vv_whiteboard()
        .entries_json(entries_json)
        .presences_json(presences_json)
        .title("产品发布时间线")
        .locale("zh")
        .on_batch(|ev: &VvWhiteboardBatchEvent| {
            WB_EVENTS.with(|r| r.borrow_mut().batches.push(ev.writes_json.to_string()));
        })
        .on_export(|ev: &VvWhiteboardExportEvent| {
            WB_EVENTS.with(|r| r.borrow_mut().exports.push(ev.clone()));
        })
        .on_open_chat(|ev: &VvWhiteboardChatEvent| {
            WB_EVENTS.with(|r| r.borrow_mut().chats.push(ev.selected_ids_json.to_string()));
        })
        .on_cursor_move(|ev: &VvWhiteboardCursorEvent| {
            WB_EVENTS.with(|r| r.borrow_mut().cursors.push(ev.clone()));
        })
        .on_viewport_change(|ev: &VvWhiteboardViewportEvent| {
            WB_EVENTS.with(|r| r.borrow_mut().viewports.push(ev.clone()));
        })
}

#[test]
fn vv_whiteboard_component_mounts_and_emits_export_and_chat_events() {
    let doc = build_template_doc(TemplateKind::Timeline, &TemplateCopy::zh());
    let mut entries: Vec<ArtifactEntry> = Vec::new();
    let meta_val = serde_json::json!({
        "title": doc.meta.title,
        "mode": "board",
        "grid": "architectural",
    })
    .to_string();
    entries.push(ArtifactEntry {
        artifact_id: "art-wb-test".to_owned(),
        path: "board/meta".to_owned(),
        kind: ArtifactEntryKind::Json,
        mime: "application/json".to_owned(),
        size: meta_val.len() as i64,
        rev: 1,
        updated_by: "user".to_owned(),
        updated: 1,
        value: Some(meta_val),
        attachment_id: None,
    });
    for el in &doc.elements {
        let encoded = encode_element_json(el);
        entries.push(ArtifactEntry {
            artifact_id: "art-wb-test".to_owned(),
            path: format!("elements/{}", el.id.0),
            kind: ArtifactEntryKind::Json,
            mime: "application/json".to_owned(),
            size: encoded.len() as i64,
            rev: el.rev.max(1),
            updated_by: "user".to_owned(),
            updated: 1,
            value: Some(encoded),
            attachment_id: None,
        });
    }

    let entries_json = serde_json::to_string(&entries).expect("serialize entries");
    WB_EVENTS.with(|r| *r.borrow_mut() = RecordedWbEvents::default());
    WB_SEED_JSON.with(|s| *s.borrow_mut() = entries_json);
    WB_PRESENCES_JSON.with(|s| s.borrow_mut().clear());

    let mut harness = TestHarness::mount(Root::of::<WhiteboardTestRoot>());
    assert!(harness.find_test_id("wb-canvas").is_some(), "wb-canvas should mount");
    assert!(harness.find_test_id("wb-count").is_some(), "wb-count should mount");
    assert!(harness.find_test_id("wb-undo").is_some(), "wb-undo should mount");
    assert!(harness.find_test_id("wb-tool-sticky").is_some(), "wb-tool-sticky should mount");
    let timer_id = harness.find_test_id("wb-timer-toggle").expect("wb-timer-toggle should mount");
    let chat_id = harness.find_test_id("wb-chat").expect("wb-chat should mount");
    let export_svg_id = harness.find_test_id("wb-export-svg").expect("wb-export-svg should mount");

    assert!(harness.press(timer_id));
    assert!(harness.find_test_id("wb-timer-popover").is_some(), "timer popover should open on press");
    assert!(harness.press(export_svg_id));
    assert!(harness.press(chat_id));

    WB_EVENTS.with(|r| {
        let recorded = r.borrow();
        assert_eq!(recorded.exports.len(), 1);
        assert_eq!(recorded.exports[0].format.as_str(), "svg");
        assert!(recorded.exports[0].content.contains("<svg"));
        assert!(recorded.exports[0].content.contains("产品发布时间线"));
        assert_eq!(recorded.chats.len(), 1);
    });
}

#[test]
fn vv_whiteboard_presence_follow_banner_and_viewport_callbacks() {
    let entries_json = "[]".to_owned();
    let presences_json = r##"[
        {"id":"session-planner","name":"Planner","color":"#3b82f6","kind":"highlight","x":320,"y":180,"w":280,"h":160,"status":"排版中","viewport":{"x":120,"y":80,"w":800,"h":500,"zoom":1.35},"updatedAt":1732000001000},
        {"id":"session-coder","name":"Coder","color":"teal","kind":"cursor","x":640,"y":420,"status":"连线中","updatedAt":1732000002000}
    ]"##
    .to_owned();

    WB_EVENTS.with(|r| *r.borrow_mut() = RecordedWbEvents::default());
    WB_SEED_JSON.with(|s| *s.borrow_mut() = entries_json);
    WB_PRESENCES_JSON.with(|s| *s.borrow_mut() = presences_json);

    let mut harness = TestHarness::mount(Root::of::<WhiteboardTestRoot>());
    let planner_pill = harness
        .find_test_id("wb-presence-session-planner")
        .expect("live collaborator presence pill should mount");
    assert!(harness.find_test_id("wb-presence-session-coder").is_some());
    assert!(harness.find_test_id("wb-follow-banner").is_none(), "follow banner hidden initially");

    // Click collaborator pill -> enters Follow mode and shows banner.
    assert!(harness.press(planner_pill));
    let banner = harness
        .find_test_id("wb-follow-banner")
        .expect("follow banner should appear when following collaborator");
    assert!(
        harness.contains_text("正在跟随 Planner · 点击退出"),
        "follow banner should display collaborator name and exit hint"
    );

    // Clicking the banner immediately exits Follow mode.
    assert!(harness.press(banner));
    assert!(harness.find_test_id("wb-follow-banner").is_none(), "clicking follow banner exits follow");

    // Re-enter Follow mode, then click Reset View (wb-zoom-reset) -> exits Follow AND reports viewport change.
    let planner_pill = harness.find_test_id("wb-presence-session-planner").expect("pill present");
    assert!(harness.press(planner_pill));
    assert!(harness.find_test_id("wb-follow-banner").is_some());

    let zoom_in = harness.find_test_id("wb-zoom-in").expect("wb-zoom-in present");
    assert!(harness.press(zoom_in));
    assert!(harness.find_test_id("wb-follow-banner").is_none(), "zoom button exits follow");

    let planner_pill = harness.find_test_id("wb-presence-session-planner").expect("pill present");
    assert!(harness.press(planner_pill));
    assert!(harness.find_test_id("wb-follow-banner").is_some());

    let reset_zoom = harness.find_test_id("wb-zoom-reset").expect("wb-zoom-reset present");
    assert!(harness.press(reset_zoom));
    assert!(harness.find_test_id("wb-follow-banner").is_none(), "reset view exits follow immediately");

    // Re-enter Follow mode and click the same collaborator pill again to toggle off.
    let planner_pill = harness.find_test_id("wb-presence-session-planner").expect("pill present");
    assert!(harness.press(planner_pill));
    assert!(harness.find_test_id("wb-follow-banner").is_some());
    let planner_pill_again = harness.find_test_id("wb-presence-session-planner").expect("pill present");
    assert!(harness.press(planner_pill_again));
    assert!(harness.find_test_id("wb-follow-banner").is_none(), "re-clicking pill exits follow");

    WB_EVENTS.with(|r| {
        let recorded = r.borrow();
        assert!(!recorded.viewports.is_empty(), "onViewportChange should fire on zoom/reset");
        let last = recorded.viewports.last().unwrap();
        assert!((last.zoom - 1.0).abs() < 1e-4, "final viewport zoom after reset should be 1.0");
        assert!(last.w > 0.0 && last.h > 0.0);
    });
}

#[test]
fn atomic_board_frame_supports_batched_grid_fast_shadows_and_selective_inline_hiding() {
    let pal = WhiteboardPalette::light();
    let cam = Camera::default();

    // 1. Batched grid paths: Architectural emits exactly 2 Stroke ops (minor + major),
    // and Dots emits 1 Fill op with a disconnected MoveTo immediately before every dot Ellipse.
    let arch_grid = paint_grid(Painter::new(), GridStyle::Architectural, cam, 600.0, 400.0, &pal).finish();
    let arch_strokes = arch_grid.ops.iter().filter(|op| matches!(op, CanvasOp::Stroke(_))).count();
    assert_eq!(arch_strokes, 2, "Architectural grid should batch into 1 minor + 1 major stroke");

    let dot_grid = paint_grid(Painter::new(), GridStyle::Dots, cam, 300.0, 200.0, &pal).finish();
    let dot_fills = dot_grid.ops.iter().filter(|op| matches!(op, CanvasOp::Fill(_, _))).count();
    assert_eq!(dot_fills, 1, "Dots grid should batch into a single Fill");
    let mut prev_was_move = false;
    let mut ellipse_count = 0usize;
    for op in &dot_grid.ops {
        if matches!(op, CanvasOp::Path(PathOp::Ellipse { .. })) {
            assert!(prev_was_move, "each grid dot Ellipse must follow a MoveTo to avoid connecting chords");
            ellipse_count += 1;
        }
        prev_was_move = matches!(op, CanvasOp::Path(PathOp::MoveTo(_, _)));
    }
    assert!(ellipse_count > 10, "expected batched dots to emit ellipses (got {ellipse_count})");

    // 2. Atomic single-pass frame with fast_shadows = false vs true + selective text/milestone hiding.
    let mut doc = BoardDoc::new("Atomic Frame");
    doc.elements.extend([
        ElementRecord::new(
            "card-1",
            ElementKind::Shape {
                x: 80.0,
                y: 80.0,
                w: 180.0,
                h: 100.0,
                shape: ShapeKind::Card,
                title: "Card Title".to_owned(),
                body: "Card Body".to_owned(),
                fill: WbFill::Sun,
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
            "callout-1",
            ElementKind::Text {
                x: 80.0,
                y: 220.0,
                w: 240.0,
                h: 54.0,
                variant: TextVariant::Callout,
                label: "Callout Warning Text".to_owned(),
                highlight: None,
                icon: Some("!".to_owned()),
                align: TextAlign::Left,
                font_size: None,
                fill: Some(WbFill::Peach),
                color: None,
            },
        ),
        ElementRecord::new(
            "tl-1",
            ElementKind::Timeline {
                x: 80.0,
                y: 340.0,
                w: 520.0,
                h: 80.0,
                fill: WbFill::Peach,
                points: vec![Point2::new(80.0, 380.0), Point2::new(340.0, 370.0), Point2::new(600.0, 360.0)],
                milestones: vec![
                    TimelineMilestone {
                        t: Some(0.15),
                        pos: None,
                        label: "Milestone Alpha".to_owned(),
                        kind: MilestoneKind::Major,
                        tone: None,
                        caption: None,
                    },
                    TimelineMilestone {
                        t: Some(0.85),
                        pos: None,
                        label: "Milestone Beta".to_owned(),
                        kind: MilestoneKind::Major,
                        tone: None,
                        caption: None,
                    },
                ],
            },
        ),
        ElementRecord::new(
            "tbl-1",
            ElementKind::Table {
                x: 340.0,
                y: 80.0,
                w: 260.0,
                h: 110.0,
                headers: vec!["Col".to_owned()],
                rows: vec![vec!["Val".to_owned()]],
                fill: WbFill::Default,
            },
        ),
    ]);
    doc.presences.push(Presence {
        id: "peer-1".to_owned(),
        name: "Peer".to_owned(),
        color: PresenceColor::Teal,
        kind: PresenceKind::Cursor,
        x: 200.0,
        y: 160.0,
        status: Some("zooming".to_owned()),
        has_cursor: true,
        ..Presence::default()
    });

    let mut ctrl = WhiteboardController::new(doc);
    ctrl.set_viewport_size(900.0, 600.0);
    ctrl.selection = vec![ElementId::new("card-1")];
    let hidden = BTreeSet::new();
    let dismissed = BTreeSet::new();

    let crisp = paint_board_frame(&FramePaintInput {
        controller: &ctrl,
        viewport_size: (900.0, 600.0),
        editing_id: None,
        editing_milestone: None,
        dark: false,
        anim_hidden_ids: &hidden,
        dismissed_notes: &dismissed,
        fast_shadows: false,
    });
    let fast = paint_board_frame(&FramePaintInput {
        controller: &ctrl,
        viewport_size: (900.0, 600.0),
        editing_id: None,
        editing_milestone: None,
        dark: false,
        anim_hidden_ids: &hidden,
        dismissed_notes: &dismissed,
        fast_shadows: true,
    });

    let crisp_blurs = crisp.ops.iter().filter(|op| matches!(op, CanvasOp::ShadowBlur(b) if b.0 > 0.0)).count();
    let fast_blurs = fast.ops.iter().filter(|op| matches!(op, CanvasOp::ShadowBlur(b) if b.0 > 0.0)).count();
    assert!(
        crisp_blurs >= 4,
        "crisp mode should emit blur shadows on cards/pills/tables/presences (got {crisp_blurs})"
    );
    assert_eq!(fast_blurs, 0, "fast_shadows mode must emit zero blur shadows");
    assert!(
        fast.nodes.iter().any(|n| n.test_id.as_deref() == Some("wb-el-card-1")),
        "atomic frame must emit wb-el-* CanvasNodes"
    );

    // Editing timeline milestone 0 hides only Milestone Alpha while keeping Milestone Beta rendered.
    let tl_id = ElementId::new("tl-1");
    let tl_edit = paint_board_frame(&FramePaintInput {
        controller: &ctrl,
        viewport_size: (900.0, 600.0),
        editing_id: Some(&tl_id),
        editing_milestone: Some(0),
        dark: false,
        anim_hidden_ids: &hidden,
        dismissed_notes: &dismissed,
        fast_shadows: false,
    });
    let tl_texts: Vec<&str> = tl_edit
        .ops
        .iter()
        .filter_map(|op| match op {
            CanvasOp::FillText { text, .. } => Some(text.as_ref()),
            _ => None,
        })
        .collect();
    assert!(!tl_texts.iter().any(|t| t.contains("Milestone Alpha")), "edited milestone 0 text should hide");
    assert!(
        tl_texts.iter().any(|t| t.contains("Milestone Beta")),
        "unedited milestone 1 text should stay visible"
    );

    // Editing a Callout keeps the warning triangle badge (`!`) while hiding only the callout body text.
    let callout_id = ElementId::new("callout-1");
    let callout_edit = paint_board_frame(&FramePaintInput {
        controller: &ctrl,
        viewport_size: (900.0, 600.0),
        editing_id: Some(&callout_id),
        editing_milestone: None,
        dark: false,
        anim_hidden_ids: &hidden,
        dismissed_notes: &dismissed,
        fast_shadows: false,
    });
    let callout_texts: Vec<&str> = callout_edit
        .ops
        .iter()
        .filter_map(|op| match op {
            CanvasOp::FillText { text, .. } => Some(text.as_ref()),
            _ => None,
        })
        .collect();
    assert!(
        callout_texts.contains(&"!"),
        "Callout warning badge `!` must remain visible during inline editing"
    );
    assert!(
        !callout_texts.iter().any(|t| t.contains("Callout Warning")),
        "Callout label text must hide during inline editing"
    );
}

#[test]
fn vv_whiteboard_borderless_inline_editor_commits_on_outside_click_and_cancels_on_escape() {
    let card = ElementRecord::new(
        "card-inline",
        ElementKind::Shape {
            x: 120.0,
            y: 120.0,
            w: 220.0,
            h: 110.0,
            shape: ShapeKind::Card,
            title: "Original Title".to_owned(),
            body: "Original Body".to_owned(),
            fill: WbFill::Sun,
            stroke: None,
            stroke_style: StrokeStyle::Solid,
            corner_radius: None,
            sticker: None,
            sticker_svg: None,
            badge: None,
            align: TextAlign::Center,
        },
    );
    let encoded = encode_element_json(&card);
    let entries = vec![ArtifactEntry {
        artifact_id: "art-inline-test".to_owned(),
        path: "elements/card-inline".to_owned(),
        kind: ArtifactEntryKind::Json,
        mime: "application/json".to_owned(),
        size: encoded.len() as i64,
        rev: 1,
        updated_by: "user".to_owned(),
        updated: 1,
        value: Some(encoded),
        attachment_id: None,
    }];
    let entries_json = serde_json::to_string(&entries).expect("serialize inline test entry");

    WB_EVENTS.with(|r| *r.borrow_mut() = RecordedWbEvents::default());
    WB_SEED_JSON.with(|s| *s.borrow_mut() = entries_json);
    WB_PRESENCES_JSON.with(|s| s.borrow_mut().clear());

    let mut harness = TestHarness::mount(Root::of::<WhiteboardTestRoot>());
    let stage_id = harness.find_test_id("wb-stage").expect("wb-stage should mount");
    let root_id = harness.find_test_id("whiteboard-native-root").expect("root should mount");
    let canvas_id = harness.find_test_id("wb-canvas").expect("wb-canvas should mount");

    // Verify single atomic full-stage board canvas (the 17 toolbar `svg()` icons also mount as 14px Canvas views).
    let stage_canvases = harness
        .frames
        .iter()
        .filter(|(id, frame)| harness.kinds.get(id) == Some(&nsh_core::ViewKind::Canvas) && frame.size.width.0 > 100.0)
        .count();
    assert_eq!(stage_canvases, 1, "VvWhiteboard should mount exactly one full-stage atomic board canvas");
    assert_eq!(harness.find_all_test_ids("wb-canvas").len(), 1);

    // Locate the card center directly from the canvas's emitted accessibility node bounds.
    let card_bounds = harness
        .canvases
        .get(&canvas_id)
        .expect("canvas drawing present")
        .nodes
        .iter()
        .find(|n| n.test_id.as_deref() == Some("wb-el-card-inline"))
        .expect("wb-el-card-inline node present")
        .bounds;
    let card_center = point(
        px(card_bounds.origin.x.0 + card_bounds.size.width.0 * 0.5),
        px(card_bounds.origin.y.0 + card_bounds.size.height.0 * 0.5),
    );

    // Double-click card -> opens borderless inline editor (no save/cancel buttons).
    let dbl_click = PressEvent {
        position: card_center,
        page_position: card_center,
        clicks: 2,
        ..Default::default()
    };
    assert!(harness.core.component_event(stage_id, EventKind::PressDown, &EventPayload::Press(dbl_click)));
    harness.commit();

    assert!(harness.find_test_id("wb-inline-editor").is_some(), "inline editor should open on double click");
    assert!(harness.find_test_id("wb-inline-title").is_some(), "inline title input should mount");
    assert!(
        harness.find_test_id("wb-inline-save").is_none(),
        "borderless inline editor must not render wb-inline-save"
    );
    assert!(
        harness.find_test_id("wb-inline-cancel").is_none(),
        "borderless inline editor must not render wb-inline-cancel"
    );

    // Pressing Escape cancels inline edit cleanly without emitting a batch write.
    let mut esc = KeyEvent::default();
    esc.key = SharedString::from("Escape");
    assert!(harness.core.component_event(root_id, EventKind::KeyDown, &EventPayload::Key(esc)));
    harness.commit();
    assert!(harness.find_test_id("wb-inline-editor").is_none(), "Escape should cancel inline editing");
    WB_EVENTS.with(|r| assert!(r.borrow().batches.is_empty(), "Escape cancel must not emit a batch"));

    // Double-click again, type updated title, then click outside on the stage -> commits and emits batch.
    assert!(harness.core.component_event(stage_id, EventKind::PressDown, &EventPayload::Press(dbl_click)));
    harness.commit();
    let title_input_id = harness.find_test_id("wb-inline-title").expect("inline title input mounted");
    assert!(harness.core.component_event(
        title_input_id,
        EventKind::ChangeText,
        &EventPayload::Text {
            text: "Renamed In Place".to_owned(),
            count: 1,
        }
    ));
    harness.commit();

    let outside_pos = point(px(10.0), px(10.0));
    let outside_click = PressEvent {
        position: outside_pos,
        page_position: outside_pos,
        clicks: 1,
        ..Default::default()
    };
    assert!(
        harness
            .core
            .component_event(stage_id, EventKind::PressDown, &EventPayload::Press(outside_click))
    );
    harness.commit();

    assert!(
        harness.find_test_id("wb-inline-editor").is_none(),
        "outside click should commit and close inline editor"
    );
    WB_EVENTS.with(|r| {
        let batches = &r.borrow().batches;
        assert_eq!(batches.len(), 1, "outside click should commit inline edit and emit 1 batch");
        assert!(
            batches[0].contains("Renamed In Place"),
            "committed batch should contain updated title, got: {}",
            batches[0]
        );
    });
}
