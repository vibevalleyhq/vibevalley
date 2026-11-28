use crate::engine::whiteboard::model::{
    AnchorSide, ArrowCurve, ArrowEndpoint, ArrowHead, BoardDoc, BoardMeta, ElementId, ElementKind, ElementRecord, GridStyle, Point2, Rect2, StrokeStyle, WbFill,
};

use super::TemplateCopy;
use super::helpers::{card, subtitle_el, title_el};

pub(super) fn build_architecture_doc(copy: &TemplateCopy) -> BoardDoc {
    BoardDoc {
        meta: BoardMeta {
            title: copy.arch_title.to_owned(),
            grid: GridStyle::Architectural,
            background: None,
        },
        elements: vec![
            title_el("ar-title", 72.0, 36.0, copy.arch_title),
            subtitle_el("ar-sub", 72.0, 84.0, copy.arch_subtitle, copy.arch_highlight),
            ElementRecord::new(
                "z-core",
                ElementKind::Container {
                    x: 72.0,
                    y: 152.0,
                    w: 540.0,
                    h: 260.0,
                    title: "Rust Native Layer (crates/rich)".to_owned(),
                    fill: WbFill::Side,
                    stroke: None,
                    collapsed: false,
                },
            ),
            ElementRecord::new(
                "z-store",
                ElementKind::Container {
                    x: 660.0,
                    y: 152.0,
                    w: 300.0,
                    h: 260.0,
                    title: "Server & SQLite Store".to_owned(),
                    fill: WbFill::Side,
                    stroke: None,
                    collapsed: false,
                },
            ),
            card(
                "n-ui",
                Rect2::new(104.0, 222.0, 190.0, 112.0),
                "VvWhiteboard",
                "Dual CanvasView + Native Dock",
                WbFill::Water,
                Some("terminal"),
            ),
            card(
                "n-eng",
                Rect2::new(366.0, 222.0, 200.0, 112.0),
                "Engine + Painter",
                "Spatial + Snap + Ink + Undo",
                WbFill::Leaf,
                Some("gear"),
            ),
            card(
                "n-srv",
                Rect2::new(710.0, 196.0, 200.0, 96.0),
                "artifact.entry.*",
                "SSE replay + rev guard",
                WbFill::Sun,
                Some("cloud"),
            ),
            card(
                "n-db",
                Rect2::new(710.0, 318.0, 200.0, 74.0),
                "SQLite Store",
                "sqlc + merge patch",
                WbFill::Peach,
                Some("database"),
            ),
            ElementRecord::new(
                "e-1",
                ElementKind::Arrow {
                    from: ArrowEndpoint::Bound {
                        id: ElementId::new("n-ui"),
                        side: Some(AnchorSide::E),
                    },
                    to: ArrowEndpoint::Bound {
                        id: ElementId::new("n-eng"),
                        side: Some(AnchorSide::W),
                    },
                    bends: Vec::new(),
                    curve: ArrowCurve::Smooth,
                    style: StrokeStyle::Solid,
                    start_head: ArrowHead::None,
                    end_head: ArrowHead::Arrow,
                    stroke: None,
                    stroke_width: 1.8,
                    label: Some("60fps".to_owned()),
                },
            ),
            ElementRecord::new(
                "e-2",
                ElementKind::Arrow {
                    from: ArrowEndpoint::Bound {
                        id: ElementId::new("n-eng"),
                        side: Some(AnchorSide::E),
                    },
                    to: ArrowEndpoint::Bound {
                        id: ElementId::new("n-srv"),
                        side: Some(AnchorSide::W),
                    },
                    bends: Vec::new(),
                    curve: ArrowCurve::Smooth,
                    style: StrokeStyle::Solid,
                    start_head: ArrowHead::None,
                    end_head: ArrowHead::Arrow,
                    stroke: None,
                    stroke_width: 1.8,
                    label: Some("ifRev batch".to_owned()),
                },
            ),
            ElementRecord::new(
                "e-3",
                ElementKind::Arrow {
                    from: ArrowEndpoint::Bound {
                        id: ElementId::new("n-srv"),
                        side: Some(AnchorSide::S),
                    },
                    to: ArrowEndpoint::Bound {
                        id: ElementId::new("n-db"),
                        side: Some(AnchorSide::N),
                    },
                    bends: Vec::new(),
                    curve: ArrowCurve::Orthogonal,
                    style: StrokeStyle::Dashed,
                    start_head: ArrowHead::None,
                    end_head: ArrowHead::Arrow,
                    stroke: None,
                    stroke_width: 1.8,
                    label: None,
                },
            ),
        ],
        presences: Vec::new(),
        seq: 0,
    }
}

pub(super) fn build_journey_doc(_copy: &TemplateCopy) -> BoardDoc {
    BoardDoc {
        meta: BoardMeta {
            title: "User Journey".to_owned(),
            grid: GridStyle::Dots,
            background: None,
        },
        elements: vec![
            title_el("j-title", 72.0, 36.0, "Onboarding User Journey"),
            subtitle_el(
                "j-sub",
                72.0,
                84.0,
                "Discover -> Install -> First collaborative board in 3 minutes",
                "3 minutes",
            ),
            ElementRecord::new(
                "j-stage-1",
                ElementKind::Container {
                    x: 72.0,
                    y: 140.0,
                    w: 250.0,
                    h: 320.0,
                    title: "01 · Discover".to_owned(),
                    fill: WbFill::Water,
                    stroke: None,
                    collapsed: false,
                },
            ),
            ElementRecord::new(
                "j-stage-2",
                ElementKind::Container {
                    x: 348.0,
                    y: 140.0,
                    w: 250.0,
                    h: 320.0,
                    title: "02 · Setup".to_owned(),
                    fill: WbFill::Sun,
                    stroke: None,
                    collapsed: false,
                },
            ),
            ElementRecord::new(
                "j-stage-3",
                ElementKind::Container {
                    x: 624.0,
                    y: 140.0,
                    w: 250.0,
                    h: 320.0,
                    title: "03 · Ship".to_owned(),
                    fill: WbFill::Leaf,
                    stroke: None,
                    collapsed: false,
                },
            ),
            card(
                "j-c1",
                Rect2::new(96.0, 204.0, 202.0, 106.0),
                "Pick Starter Template",
                "Zero blank-page friction",
                WbFill::Default,
                Some("sparkles"),
            ),
            card(
                "j-c2",
                Rect2::new(372.0, 204.0, 202.0, 106.0),
                "Co-edit with Agent",
                "Live presence & claims",
                WbFill::Sun,
                Some("mascot"),
            ),
            card(
                "j-c3",
                Rect2::new(648.0, 204.0, 202.0, 106.0),
                "Export SVG / PNG",
                "Crisp editorial output",
                WbFill::Leaf,
                Some("rocket"),
            ),
            card(
                "j-pain",
                Rect2::new(372.0, 340.0, 202.0, 92.0),
                "Watchout",
                "Clarify dependencies early",
                WbFill::Berry,
                Some("warning"),
            ),
        ],
        presences: Vec::new(),
        seq: 0,
    }
}

pub(super) fn build_quadrant_doc(_copy: &TemplateCopy) -> BoardDoc {
    BoardDoc {
        meta: BoardMeta {
            title: "Impact / Effort Quadrant".to_owned(),
            grid: GridStyle::Architectural,
            background: None,
        },
        elements: vec![
            title_el("q-title", 72.0, 36.0, "Impact vs. Effort Quadrant"),
            subtitle_el("q-sub", 72.0, 84.0, "Prioritize high-leverage engineering work for Q4", "high-leverage"),
            ElementRecord::new(
                "q-x",
                ElementKind::Arrow {
                    from: ArrowEndpoint::Free(Point2::new(72.0, 350.0)),
                    to: ArrowEndpoint::Free(Point2::new(820.0, 350.0)),
                    bends: Vec::new(),
                    curve: ArrowCurve::Straight,
                    style: StrokeStyle::Solid,
                    start_head: ArrowHead::None,
                    end_head: ArrowHead::Arrow,
                    stroke: None,
                    stroke_width: 2.0,
                    label: Some("Effort ->".to_owned()),
                },
            ),
            ElementRecord::new(
                "q-y",
                ElementKind::Arrow {
                    from: ArrowEndpoint::Free(Point2::new(446.0, 560.0)),
                    to: ArrowEndpoint::Free(Point2::new(446.0, 130.0)),
                    bends: Vec::new(),
                    curve: ArrowCurve::Straight,
                    style: StrokeStyle::Solid,
                    start_head: ArrowHead::None,
                    end_head: ArrowHead::Arrow,
                    stroke: None,
                    stroke_width: 2.0,
                    label: Some("Impact".to_owned()),
                },
            ),
            card(
                "q-nw",
                Rect2::new(120.0, 170.0, 220.0, 120.0),
                "Quick Wins",
                "Native Rust stickers & themes",
                WbFill::Leaf,
                Some("check"),
            ),
            card(
                "q-ne",
                Rect2::new(540.0, 170.0, 220.0, 120.0),
                "Big Bets",
                "Dual-layer Painter engine",
                WbFill::Water,
                Some("rocket"),
            ),
            card(
                "q-sw",
                Rect2::new(120.0, 390.0, 220.0, 120.0),
                "Fill-ins",
                "Minor keyboard polish",
                WbFill::Sun,
                Some("lightbulb"),
            ),
            card(
                "q-se",
                Rect2::new(540.0, 390.0, 220.0, 120.0),
                "Reconsider",
                "WebView chrome workarounds",
                WbFill::Berry,
                Some("bug"),
            ),
        ],
        presences: Vec::new(),
        seq: 0,
    }
}

pub(super) fn build_comparison_doc(_copy: &TemplateCopy) -> BoardDoc {
    BoardDoc {
        meta: BoardMeta {
            title: "Architecture Comparison".to_owned(),
            grid: GridStyle::None,
            background: None,
        },
        elements: vec![
            title_el("cmp-title", 72.0, 36.0, "Whiteboard Runtime Comparison"),
            subtitle_el("cmp-sub", 72.0, 84.0, "Evaluating WebView vs. Pure-Rust nsh_core Canvas", "Pure-Rust"),
            ElementRecord::new(
                "cmp-table",
                ElementKind::Table {
                    x: 72.0,
                    y: 140.0,
                    w: 760.0,
                    h: 220.0,
                    headers: vec!["Dimension".to_owned(), "WKWebView Runtime".to_owned(), "Native Rust VvWhiteboard".to_owned()],
                    rows: vec![
                        vec![
                            "Rendering & DPI".to_owned(),
                            "Separate web process".to_owned(),
                            "Native Metal tile cache".to_owned(),
                        ],
                        vec!["Overlays & IME".to_owned(), "Occluded by NSView".to_owned(), "Unified GPUI overlays".to_owned()],
                        vec![
                            "Visual Testing".to_owned(),
                            "Blank in shot capture".to_owned(),
                            "Full pixel capture in ui:gallery".to_owned(),
                        ],
                        vec![
                            "Undo / Concurrency".to_owned(),
                            "UI string runtime".to_owned(),
                            "Typed Rust ops + rev guard".to_owned(),
                        ],
                    ],
                    fill: WbFill::Default,
                },
            ),
            card(
                "cmp-takeaway",
                Rect2::new(72.0, 392.0, 360.0, 108.0),
                "Decision",
                "Build once in crates/rich for desktop speed & full testability",
                WbFill::Leaf,
                Some("shield"),
            ),
        ],
        presences: Vec::new(),
        seq: 0,
    }
}
