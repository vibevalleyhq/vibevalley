mod support;

use std::cell::RefCell;
use std::collections::{BTreeSet, HashSet};
use std::sync::{Arc, LazyLock};

use nsh_core::element::Root;
use nsh_core::prelude::*;
use resvg::tiny_skia;
use support::TestHarness;
use vibevalley_protocol::{ArtifactEntry, ArtifactEntryKind};
use vibevalley_rich::engine::canvas::Canvas;
use vibevalley_rich::engine::whiteboard::{
    BoardAction, BoardDoc, ElementId, ElementKind, ElementRecord, InkMode, LayerPaintInput, Modifiers, Point2, PointerButton, PointerInput, Presence,
    PresenceColor, PresenceKind, PresenceViewport, Rect2, ShapeKind, SnapAxis, SnapGuide, StrokePoint, StrokeStyle, TemplateCopy, TemplateKind, TextAlign,
    Tool, WbFill, WhiteboardController, build_export_painter, build_template_doc, encode_element_json, export_json, export_json_canvas, export_svg,
    import_json_canvas, paint_minimap, paint_overlay_layer, paint_static_layer,
};
use vibevalley_rich::{VvWhiteboardChatEvent, VvWhiteboardCursorEvent, VvWhiteboardExportEvent, VvWhiteboardViewportEvent, vv_whiteboard};

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
