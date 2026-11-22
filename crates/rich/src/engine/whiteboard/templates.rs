use vibevalley_protocol::ArtifactEntryWriteInput;

use crate::engine::whiteboard::codec::{encode_element_write, encode_meta_write, encode_presence_write};
use crate::engine::whiteboard::model::{
    AnchorSide, ArrowCurve, ArrowEndpoint, ArrowHead, BoardDoc, BoardMeta, ElementId, ElementKind, ElementRecord, GridStyle, MilestoneKind, Point2, Presence,
    PresenceColor, Rect2, ShapeKind, StrokeStyle, TextAlign, TextVariant, TimelineMilestone, WbFill,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TemplateKind {
    Timeline,
    Workshop,
    Architecture,
    UserJourney,
    Quadrant,
    Comparison,
}

impl TemplateKind {
    pub const ALL: [Self; 6] = [
        Self::Timeline,
        Self::Workshop,
        Self::Architecture,
        Self::UserJourney,
        Self::Quadrant,
        Self::Comparison,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Timeline => "timeline",
            Self::Workshop => "workshop",
            Self::Architecture => "architecture",
            Self::UserJourney => "user-journey",
            Self::Quadrant => "quadrant",
            Self::Comparison => "comparison",
        }
    }
}

#[derive(Debug, Clone)]
pub struct TemplateCopy {
    pub timeline_title: &'static str,
    pub timeline_subtitle: &'static str,
    pub timeline_highlight: &'static str,
    pub days: [&'static str; 5],
    pub road_caption: &'static str,
    pub steps: [(&'static str, &'static str); 6],
    pub callout: &'static str,
    pub arch_title: &'static str,
    pub arch_subtitle: &'static str,
    pub arch_highlight: &'static str,
    pub user_label: &'static str,
    pub orchestrator_label: &'static str,
    pub teammate_label: &'static str,
}

impl TemplateCopy {
    pub const fn zh() -> Self {
        Self {
            timeline_title: "产品发布时间线",
            timeline_subtitle: "从方案锁定到正式交付上线：全链路协同冲刺 12 天",
            timeline_highlight: "12 天",
            days: ["Day 1", "Day 2", "Day 3", "Day 7", "Day 8"],
            road_caption: "联调冲刺 4 天",
            steps: [
                ("锁定核心范围", "核心功能已拍板"),
                ("确认发布清单", "拆解到每天交付物"),
                ("确定资源预算", "算力与配额已就位"),
                ("批产核心模块", "23 项任务并发推进"),
                ("准点抵达验收", "进入主站发布通道"),
                ("灰度与全量验证", "先验 12 组，再放量 500"),
            ],
            callout: "合包检查需等待终版配置锁定",
            arch_title: "VibeValley 原生白板架构",
            arch_subtitle: "双层 Painter 渲染与并发 Entry 同步，端到端延迟 < 16 ms",
            arch_highlight: "< 16 ms",
            user_label: "研发",
            orchestrator_label: "主助手",
            teammate_label: "老周",
        }
    }

    pub const fn en() -> Self {
        Self {
            timeline_title: "Launch Timeline",
            timeline_subtitle: "From locked scope to holiday delivery in 12 days",
            timeline_highlight: "12 days",
            days: ["Day 1", "Day 2", "Day 3", "Day 7", "Day 8"],
            road_caption: "4 days integration",
            steps: [
                ("Lock scope", "Core milestones frozen"),
                ("Build forecast", "Break down deliverables"),
                ("Lock pricing", "Compute & budget set"),
                ("Produce core", "23 tasks in parallel"),
                ("Arrive on site", "Staging gate green"),
                ("Verification run", "12 canary, then 500"),
            ],
            callout: "Final packaging waits on locked configuration",
            arch_title: "Native Rust Whiteboard Architecture",
            arch_subtitle: "Dual-layer Painter rendering with entry concurrency < 16 ms",
            arch_highlight: "< 16 ms",
            user_label: "Dev",
            orchestrator_label: "Orchestrator",
            teammate_label: "Zhou",
        }
    }
}

pub fn build_template_doc(kind: TemplateKind, copy: &TemplateCopy) -> BoardDoc {
    let mut doc = match kind {
        TemplateKind::Timeline => build_timeline_doc(copy),
        TemplateKind::Workshop => build_workshop_doc(copy),
        TemplateKind::Architecture => build_architecture_doc(copy),
        TemplateKind::UserJourney => build_journey_doc(copy),
        TemplateKind::Quadrant => build_quadrant_doc(copy),
        TemplateKind::Comparison => build_comparison_doc(copy),
    };
    for (idx, el) in doc.elements.iter_mut().enumerate() {
        el.z = (idx + 1) as i32;
    }
    let lookup = doc.rect_lookup();
    let containers: Vec<(ElementId, Rect2)> = doc
        .elements
        .iter()
        .filter(|e| e.is_container())
        .filter_map(|e| lookup.get(&e.id).map(|r| (e.id.clone(), *r)))
        .collect();
    for el in &mut doc.elements {
        if el.is_container() || el.is_arrow() || el.parent_id.is_some() {
            continue;
        }
        if let Some(r) = lookup.get(&el.id) {
            let center = r.center();
            if let Some((cid, _)) = containers.iter().rev().find(|(_, cr)| cr.contains_point(center)) {
                el.parent_id = Some(cid.clone());
            }
        }
    }
    doc
}

pub fn build_template_writes(kind: TemplateKind, copy: &TemplateCopy) -> Vec<ArtifactEntryWriteInput> {
    let doc = build_template_doc(kind, copy);
    let mut writes = Vec::with_capacity(doc.elements.len() + doc.presences.len() + 1);
    writes.push(encode_meta_write(&doc.meta));
    for el in &doc.elements {
        writes.push(encode_element_write(el, false));
    }
    for p in &doc.presences {
        writes.push(encode_presence_write(p));
    }
    writes
}

fn card(id: &str, rect: Rect2, title: &str, body: &str, fill: WbFill, sticker: Option<&str>) -> ElementRecord {
    ElementRecord::new(
        id,
        ElementKind::Shape {
            x: rect.x,
            y: rect.y,
            w: rect.w,
            h: rect.h,
            shape: ShapeKind::Card,
            title: title.to_owned(),
            body: body.to_owned(),
            fill,
            stroke: None,
            stroke_style: StrokeStyle::Solid,
            corner_radius: None,
            sticker: sticker.map(str::to_owned),
            sticker_svg: None,
            badge: None,
            align: TextAlign::Center,
        },
    )
}

fn title_el(id: &str, x: f64, y: f64, text: &str) -> ElementRecord {
    ElementRecord::new(
        id,
        ElementKind::Text {
            x,
            y,
            w: 680.0,
            h: 48.0,
            variant: TextVariant::Title,
            label: text.to_owned(),
            highlight: None,
            icon: None,
            align: TextAlign::Left,
            font_size: None,
            fill: None,
            color: None,
        },
    )
}

fn subtitle_el(id: &str, x: f64, y: f64, text: &str, highlight: &str) -> ElementRecord {
    ElementRecord::new(
        id,
        ElementKind::Text {
            x,
            y,
            w: 700.0,
            h: 28.0,
            variant: TextVariant::Subtitle,
            label: text.to_owned(),
            highlight: Some(highlight.to_owned()),
            icon: None,
            align: TextAlign::Left,
            font_size: None,
            fill: None,
            color: None,
        },
    )
}

fn build_timeline_doc(copy: &TemplateCopy) -> BoardDoc {
    BoardDoc {
        meta: BoardMeta {
            title: copy.timeline_title.to_owned(),
            grid: GridStyle::Architectural,
            background: None,
        },
        elements: vec![
            title_el("t-title", 72.0, 36.0, copy.timeline_title),
            subtitle_el("t-sub", 72.0, 84.0, copy.timeline_subtitle, copy.timeline_highlight),
            ElementRecord::new(
                "tl-main",
                ElementKind::Timeline {
                    x: 72.0,
                    y: 264.0,
                    w: 840.0,
                    h: 96.0,
                    fill: WbFill::Peach,
                    points: vec![
                        Point2::new(76.0, 356.0),
                        Point2::new(240.0, 350.0),
                        Point2::new(430.0, 312.0),
                        Point2::new(640.0, 306.0),
                        Point2::new(890.0, 264.0),
                    ],
                    milestones: vec![
                        TimelineMilestone {
                            t: Some(0.04),
                            pos: None,
                            label: copy.days[0].to_owned(),
                            kind: MilestoneKind::Major,
                            tone: None,
                            caption: None,
                        },
                        TimelineMilestone {
                            t: Some(0.16),
                            pos: None,
                            label: copy.days[1].to_owned(),
                            kind: MilestoneKind::Major,
                            tone: None,
                            caption: None,
                        },
                        TimelineMilestone {
                            t: Some(0.27),
                            pos: None,
                            label: copy.days[2].to_owned(),
                            kind: MilestoneKind::Major,
                            tone: None,
                            caption: None,
                        },
                        TimelineMilestone {
                            t: Some(0.38),
                            pos: None,
                            label: "4".to_owned(),
                            kind: MilestoneKind::Minor,
                            tone: None,
                            caption: None,
                        },
                        TimelineMilestone {
                            t: Some(0.49),
                            pos: None,
                            label: "5".to_owned(),
                            kind: MilestoneKind::Minor,
                            tone: None,
                            caption: Some(copy.road_caption.to_owned()),
                        },
                        TimelineMilestone {
                            t: Some(0.60),
                            pos: None,
                            label: "6".to_owned(),
                            kind: MilestoneKind::Minor,
                            tone: None,
                            caption: None,
                        },
                        TimelineMilestone {
                            t: Some(0.72),
                            pos: None,
                            label: copy.days[3].to_owned(),
                            kind: MilestoneKind::Major,
                            tone: None,
                            caption: None,
                        },
                        TimelineMilestone {
                            t: Some(0.85),
                            pos: None,
                            label: copy.days[4].to_owned(),
                            kind: MilestoneKind::Major,
                            tone: None,
                            caption: None,
                        },
                        TimelineMilestone {
                            t: Some(0.96),
                            pos: None,
                            label: "9".to_owned(),
                            kind: MilestoneKind::Minor,
                            tone: None,
                            caption: None,
                        },
                    ],
                },
            ),
            card(
                "c-1",
                Rect2::new(64.0, 174.0, 160.0, 108.0),
                copy.steps[0].0,
                copy.steps[0].1,
                WbFill::Sun,
                Some("berry-lock"),
            ),
            card(
                "c-2",
                Rect2::new(112.0, 422.0, 168.0, 120.0),
                copy.steps[1].0,
                copy.steps[1].1,
                WbFill::Sun,
                Some("chart-board"),
            ),
            card(
                "c-3",
                Rect2::new(246.0, 146.0, 168.0, 110.0),
                copy.steps[2].0,
                copy.steps[2].1,
                WbFill::Sun,
                Some("price-tag"),
            ),
            card(
                "c-4",
                Rect2::new(298.0, 372.0, 170.0, 108.0),
                copy.steps[3].0,
                copy.steps[3].1,
                WbFill::Sun,
                Some("crate"),
            ),
            card(
                "c-5",
                Rect2::new(640.0, 114.0, 176.0, 114.0),
                copy.steps[4].0,
                copy.steps[4].1,
                WbFill::Peach,
                Some("storefront"),
            ),
            card(
                "c-6",
                Rect2::new(752.0, 356.0, 176.0, 118.0),
                copy.steps[5].0,
                copy.steps[5].1,
                WbFill::Peach,
                Some("bowl"),
            ),
            ElementRecord::new(
                "s-truck",
                ElementKind::Sticker {
                    x: 462.0,
                    y: 244.0,
                    w: 112.0,
                    h: 68.0,
                    sticker: "truck".to_owned(),
                    svg: None,
                    label: None,
                },
            ),
            ElementRecord::new(
                "s-mascot",
                ElementKind::Sticker {
                    x: 752.0,
                    y: 26.0,
                    w: 72.0,
                    h: 72.0,
                    sticker: "mascot".to_owned(),
                    svg: None,
                    label: None,
                },
            ),
            ElementRecord::new(
                "t-callout",
                ElementKind::Text {
                    x: 492.0,
                    y: 404.0,
                    w: 204.0,
                    h: 48.0,
                    variant: TextVariant::Callout,
                    label: copy.callout.to_owned(),
                    highlight: None,
                    icon: Some("!".to_owned()),
                    align: TextAlign::Left,
                    font_size: None,
                    fill: None,
                    color: None,
                },
            ),
            stem_arrow("a-1", "c-1", AnchorSide::S, Point2::new(112.0, 354.0)),
            stem_arrow("a-2", "c-2", AnchorSide::N, Point2::new(204.0, 352.0)),
            stem_arrow("a-3", "c-3", AnchorSide::S, Point2::new(298.0, 338.0)),
            stem_arrow("a-4", "c-4", AnchorSide::N, Point2::new(392.0, 320.0)),
            stem_arrow("a-5", "c-5", AnchorSide::S, Point2::new(676.0, 300.0)),
            stem_arrow("a-6", "c-6", AnchorSide::N, Point2::new(780.0, 282.0)),
            ElementRecord::new(
                "a-callout",
                ElementKind::Arrow {
                    from: ArrowEndpoint::Bound {
                        id: ElementId::new("t-callout"),
                        side: Some(AnchorSide::E),
                    },
                    to: ArrowEndpoint::Bound {
                        id: ElementId::new("c-6"),
                        side: Some(AnchorSide::W),
                    },
                    bends: Vec::new(),
                    curve: ArrowCurve::Smooth,
                    style: StrokeStyle::Solid,
                    start_head: ArrowHead::None,
                    end_head: ArrowHead::Arrow,
                    stroke: Some("#c96e52".to_owned()),
                    stroke_width: 1.75,
                    label: None,
                },
            ),
        ],
        presences: vec![
            Presence {
                id: "orchestrator".to_owned(),
                name: copy.orchestrator_label.to_owned(),
                color: PresenceColor::Coral,
                x: 495.0,
                y: 96.0,
                status: None,
                selected_ids: Vec::new(),
                rev: 1,
            },
            Presence {
                id: "w1".to_owned(),
                name: copy.teammate_label.to_owned(),
                color: PresenceColor::Teal,
                x: 826.0,
                y: 86.0,
                status: None,
                selected_ids: Vec::new(),
                rev: 1,
            },
            Presence {
                id: "user".to_owned(),
                name: copy.user_label.to_owned(),
                color: PresenceColor::Blue,
                x: 636.0,
                y: 454.0,
                status: None,
                selected_ids: Vec::new(),
                rev: 1,
            },
        ],
        seq: 0,
    }
}

fn stem_arrow(id: &str, from_id: &str, side: AnchorSide, to: Point2) -> ElementRecord {
    ElementRecord::new(
        id,
        ElementKind::Arrow {
            from: ArrowEndpoint::Bound {
                id: ElementId::new(from_id),
                side: Some(side),
            },
            to: ArrowEndpoint::Free(to),
            bends: Vec::new(),
            curve: ArrowCurve::Straight,
            style: StrokeStyle::Solid,
            start_head: ArrowHead::None,
            end_head: ArrowHead::None,
            stroke: Some("#c96e52".to_owned()),
            stroke_width: 1.6,
            label: None,
        },
    )
}

fn build_architecture_doc(copy: &TemplateCopy) -> BoardDoc {
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
fn build_journey_doc(_copy: &TemplateCopy) -> BoardDoc {
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
fn build_quadrant_doc(_copy: &TemplateCopy) -> BoardDoc {
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
fn build_comparison_doc(_copy: &TemplateCopy) -> BoardDoc {
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

fn sticky_el(id: &str, rect: Rect2, title: &str, fill: WbFill) -> ElementRecord {
    ElementRecord::new(
        id,
        ElementKind::Shape {
            x: rect.x,
            y: rect.y,
            w: rect.w,
            h: rect.h,
            shape: ShapeKind::Sticky,
            title: title.to_owned(),
            body: String::new(),
            fill,
            stroke: None,
            stroke_style: StrokeStyle::Solid,
            corner_radius: None,
            sticker: None,
            sticker_svg: None,
            badge: None,
            align: TextAlign::Center,
        },
    )
}

fn pill_el(id: &str, rect: Rect2, title: &str, fill: WbFill, rounded_bar: bool) -> ElementRecord {
    ElementRecord::new(
        id,
        ElementKind::Shape {
            x: rect.x,
            y: rect.y,
            w: rect.w,
            h: rect.h,
            shape: if rounded_bar { ShapeKind::Rounded } else { ShapeKind::Pill },
            title: title.to_owned(),
            body: String::new(),
            fill,
            stroke: None,
            stroke_style: StrokeStyle::Solid,
            corner_radius: None,
            sticker: None,
            sticker_svg: None,
            badge: None,
            align: TextAlign::Center,
        },
    )
}

fn connector_arrow(id: &str, from_id: &str, from_side: AnchorSide, to_id: &str, to_side: AnchorSide, head: ArrowHead) -> ElementRecord {
    ElementRecord::new(
        id,
        ElementKind::Arrow {
            from: ArrowEndpoint::Bound {
                id: ElementId::new(from_id),
                side: Some(from_side),
            },
            to: ArrowEndpoint::Bound {
                id: ElementId::new(to_id),
                side: Some(to_side),
            },
            bends: Vec::new(),
            curve: ArrowCurve::Straight,
            style: StrokeStyle::Solid,
            start_head: ArrowHead::None,
            end_head: head,
            stroke: Some("#4a4540".to_owned()),
            stroke_width: 1.5,
            label: None,
        },
    )
}

fn build_workshop_doc(copy: &TemplateCopy) -> BoardDoc {
    let is_en = copy.user_label == "Dev";
    let (board_title, board_sub, c1_t, c2_t, c3_t, c4_t, c5_t) = if is_en {
        (
            "Client Portal launch workshop",
            "Fernbrook",
            "Who it's for",
            "What we promise",
            "Where it shows up",
            "Open risks",
            "Launch plan",
        )
    } else {
        (
            "客户门户启动工作坊",
            "VibeValley Studio",
            "面向人群",
            "核心承诺",
            "触达渠道",
            "待解风险",
            "上线计划",
        )
    };

    let who_texts = if is_en {
        [
            "Ops leads at 50-500 person shops",
            "Teams texting job photos to clients",
            "Fernbrook Pro accounts",
            "Office managers who send quotes",
        ]
    } else {
        [
            "50–500 人规模服务机构负责人",
            "习惯发现场照片给客户的团队",
            "Fernbrook 专业版账号",
            "负责报价跟进的运营主管",
        ]
    };

    let promise_texts = if is_en {
        [
            "Clients see the tech on the way",
            "Approve and pay from one link",
            "No app to download",
            "Every job photo in one place",
        ]
    } else {
        [
            "客户实时查看技师在途进度",
            "单条链接完成确认与支付",
            "无需下载额外客户端",
            "现场交付照片集中归档",
        ]
    };

    let channel_texts = if is_en {
        [
            "Launch webinar, Nov 18",
            "In-app banner for Pro admins",
            "Email to 4,200 admins",
            "Founder post on LinkedIn",
        ]
    } else {
        [
            "11 月 18 日上线发布会",
            "专业版管理员应用内横幅",
            "向 4,200 位管理员发邮件",
            "创始人动态专栏宣发",
        ]
    };

    let risk_texts = if is_en {
        [
            "Payments not live in Canada",
            "Support load in week one",
            "Help articles not translated",
            "No lead for the status page",
            "Decide Canada go-live by Nov 4",
            "Canned replies ready by Nov 11",
        ]
    } else {
        [
            "加拿大地区支付尚未开通",
            "首周客服咨询压力",
            "帮助中心暂未翻译",
            "状态页尚未定负责人",
            "11 月 4 日前拍板加拿大上线",
            "11 月 11 日前备好标准话术",
        ]
    };

    let (dates, milestones, leads, proposal_note) = if is_en {
        (
            ["Nov 4", "Nov 11", "Nov 18"],
            [
                "Beta opens to 20 Pro customers",
                "Help center live, support trained",
                "Webinar, email and in-app banner",
            ],
            ["Theo", "Nadia", "Rosa"],
            "First moves and dates are my proposals, not agreed. Tell me which to change.",
        )
    } else {
        (
            ["11月4日", "11月11日", "11月18日"],
            ["向 20 位专业版客户开启内测", "帮助中心上线，客服培训完成", "发布会、邮件及应用内横幅上线"],
            ["林舟", "苏晴", "陈默"],
            "初版排期与方案是我先拟的建议，还没定稿，告诉我需要改哪几项。",
        )
    };

    let mut elements = vec![
        ElementRecord::new(
            "ws-title",
            ElementKind::Text {
                x: 56.0,
                y: 26.0,
                w: 720.0,
                h: 44.0,
                variant: TextVariant::Title,
                label: board_title.to_owned(),
                highlight: None,
                icon: None,
                align: TextAlign::Left,
                font_size: Some(26.0),
                fill: None,
                color: None,
            },
        ),
        ElementRecord::new(
            "ws-sub",
            ElementKind::Text {
                x: 56.0,
                y: 68.0,
                w: 360.0,
                h: 24.0,
                variant: TextVariant::Subtitle,
                label: board_sub.to_owned(),
                highlight: None,
                icon: None,
                align: TextAlign::Left,
                font_size: Some(14.0),
                fill: None,
                color: None,
            },
        ),
        ElementRecord::new(
            "ws-c-who",
            ElementKind::Container {
                x: 56.0,
                y: 136.0,
                w: 300.0,
                h: 244.0,
                title: c1_t.to_owned(),
                fill: WbFill::Side,
                stroke: None,
                collapsed: false,
            },
        ),
        ElementRecord::new(
            "ws-c-promise",
            ElementKind::Container {
                x: 386.0,
                y: 136.0,
                w: 300.0,
                h: 244.0,
                title: c2_t.to_owned(),
                fill: WbFill::Side,
                stroke: None,
                collapsed: false,
            },
        ),
        ElementRecord::new(
            "ws-c-channel",
            ElementKind::Container {
                x: 716.0,
                y: 136.0,
                w: 300.0,
                h: 244.0,
                title: c3_t.to_owned(),
                fill: WbFill::Side,
                stroke: None,
                collapsed: false,
            },
        ),
        ElementRecord::new(
            "ws-c-risks",
            ElementKind::Container {
                x: 56.0,
                y: 428.0,
                w: 436.0,
                h: 224.0,
                title: c4_t.to_owned(),
                fill: WbFill::Side,
                stroke: None,
                collapsed: false,
            },
        ),
        ElementRecord::new(
            "ws-c-plan",
            ElementKind::Container {
                x: 522.0,
                y: 428.0,
                w: 494.0,
                h: 224.0,
                title: c5_t.to_owned(),
                fill: WbFill::Side,
                stroke: None,
                collapsed: false,
            },
        ),
    ];

    for (i, label) in who_texts.iter().enumerate() {
        let col = (i % 2) as f64;
        let row = (i / 2) as f64;
        elements.push(sticky_el(
            &format!("ws-who-{}", i + 1),
            Rect2::new(70.0 + col * 142.0, 150.0 + row * 112.0, 130.0, 100.0),
            label,
            WbFill::Sun,
        ));
    }
    for (i, label) in promise_texts.iter().enumerate() {
        let col = (i % 2) as f64;
        let row = (i / 2) as f64;
        elements.push(sticky_el(
            &format!("ws-promise-{}", i + 1),
            Rect2::new(400.0 + col * 142.0, 150.0 + row * 112.0, 130.0, 100.0),
            label,
            WbFill::Leaf,
        ));
    }
    for (i, label) in channel_texts.iter().enumerate() {
        let col = (i % 2) as f64;
        let row = (i / 2) as f64;
        elements.push(sticky_el(
            &format!("ws-chan-{}", i + 1),
            Rect2::new(730.0 + col * 142.0, 150.0 + row * 112.0, 130.0, 100.0),
            label,
            WbFill::Water,
        ));
    }
    for (i, label) in risk_texts.iter().enumerate() {
        let col = (i % 3) as f64;
        let row = (i / 3) as f64;
        elements.push(sticky_el(
            &format!("ws-risk-{}", i + 1),
            Rect2::new(70.0 + col * 140.0, 442.0 + row * 102.0, 128.0, 90.0),
            label,
            WbFill::Berry,
        ));
    }

    for i in 0..3 {
        let row_y = 450.0 + i as f64 * 70.0;
        let tone = if i == 2 { WbFill::Lavender } else { WbFill::Side };
        elements.push(pill_el(
            &format!("ws-d-{}", i + 1),
            Rect2::new(540.0, row_y, 78.0, 36.0),
            dates[i],
            tone.clone(),
            false,
        ));
        elements.push(pill_el(
            &format!("ws-m-{}", i + 1),
            Rect2::new(642.0, row_y, 266.0, 36.0),
            milestones[i],
            tone.clone(),
            true,
        ));
        elements.push(pill_el(&format!("ws-l-{}", i + 1), Rect2::new(924.0, row_y, 74.0, 36.0), leads[i], tone, false));
        elements.push(connector_arrow(
            &format!("ws-hd-{}", i + 1),
            &format!("ws-d-{}", i + 1),
            AnchorSide::E,
            &format!("ws-m-{}", i + 1),
            AnchorSide::W,
            ArrowHead::None,
        ));
        elements.push(connector_arrow(
            &format!("ws-hl-{}", i + 1),
            &format!("ws-m-{}", i + 1),
            AnchorSide::E,
            &format!("ws-l-{}", i + 1),
            AnchorSide::W,
            ArrowHead::None,
        ));
    }
    elements.push(connector_arrow("ws-vd-1", "ws-d-1", AnchorSide::S, "ws-d-2", AnchorSide::N, ArrowHead::Arrow));
    elements.push(connector_arrow("ws-vd-2", "ws-d-2", AnchorSide::S, "ws-d-3", AnchorSide::N, ArrowHead::Arrow));

    let kenji_name = if is_en { "Kenji" } else { "林舟" };
    let rosa_name = if is_en { "Rosa" } else { "陈默" };

    BoardDoc {
        meta: BoardMeta {
            title: board_title.to_owned(),
            grid: GridStyle::Architectural,
            background: None,
        },
        elements,
        presences: vec![
            Presence {
                id: "kenji".to_owned(),
                name: kenji_name.to_owned(),
                color: PresenceColor::Leaf,
                x: 344.0,
                y: 388.0,
                status: None,
                selected_ids: Vec::new(),
                rev: 1,
            },
            Presence {
                id: "rosa".to_owned(),
                name: rosa_name.to_owned(),
                color: PresenceColor::Blue,
                x: 906.0,
                y: 388.0,
                status: None,
                selected_ids: Vec::new(),
                rev: 1,
            },
            Presence {
                id: "orchestrator".to_owned(),
                name: copy.orchestrator_label.to_owned(),
                color: PresenceColor::Coral,
                x: 212.0,
                y: 658.0,
                status: Some(proposal_note.to_owned()),
                selected_ids: Vec::new(),
                rev: 1,
            },
        ],
        seq: 0,
    }
}
