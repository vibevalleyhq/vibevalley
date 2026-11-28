mod diagrams;
mod helpers;
mod timeline;
mod workshop;

use crate::engine::whiteboard::codec::{WhiteboardWriteInput, encode_element_write, encode_meta_write, encode_presence_write};
use crate::engine::whiteboard::model::{BoardDoc, ElementId, Rect2};

use diagrams::{build_architecture_doc, build_comparison_doc, build_journey_doc, build_quadrant_doc};
use timeline::build_timeline_doc;
use workshop::build_workshop_doc;

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

pub fn build_template_writes(kind: TemplateKind, copy: &TemplateCopy) -> Vec<WhiteboardWriteInput> {
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
