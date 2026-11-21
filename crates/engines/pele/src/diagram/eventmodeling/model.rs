use std::collections::{HashMap, HashSet};

use crate::detect::DiagramType;
use crate::diagram::common::{acc_descr_value, acc_title_value, title_value};
use crate::diagram::timeline::scan::{collapse_newline_ws, trim_leading_ws};
use crate::error::{ErrorCode, PeleError, SourceMap, locate};

use super::parser::{EventModelAst, FrameKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EntityKind {
    Ui,
    Processor,
    Command,
    ReadModel,
    Event,
}

impl EntityKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ui => "ui",
            Self::Processor => "processor",
            Self::Command => "command",
            Self::ReadModel => "readmodel",
            Self::Event => "event",
        }
    }

    pub const fn series_slot(self) -> Option<usize> {
        match self {
            Self::Command => Some(0),
            Self::Event => Some(1),
            Self::ReadModel => Some(2),
            Self::Processor => Some(6),
            Self::Ui => None,
        }
    }

    fn from_keyword(kw: &str) -> Self {
        match kw {
            "ui" => Self::Ui,
            "pcr" | "processor" => Self::Processor,
            "rmo" | "readmodel" => Self::ReadModel,
            "cmd" | "command" => Self::Command,
            _ => Self::Event,
        }
    }

    const fn lane_group(self) -> LaneGroup {
        match self {
            Self::Ui | Self::Processor => LaneGroup::Trigger,
            Self::Command | Self::ReadModel => LaneGroup::State,
            Self::Event => LaneGroup::Stream,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LaneGroup {
    Trigger,
    State,
    Stream,
}

impl LaneGroup {
    const fn spec(self) -> (usize, &'static str, &'static str) {
        match self {
            Self::Trigger => (0, "UI/Automation", "UI/A: "),
            Self::State => (100, "Command/Read Model", "C/RM: "),
            Self::Stream => (200, "Events", "Stream: "),
        }
    }

    const fn key(self) -> &'static str {
        match self {
            Self::Trigger => "trigger",
            Self::State => "state",
            Self::Stream => "stream",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmLane {
    pub index: usize,
    pub label: String,
    pub group: LaneGroup,
    pub namespace: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmBox {
    pub id: String,
    pub kind: EntityKind,
    pub entity: String,
    pub name: String,
    pub namespace: Option<String>,
    pub reset: bool,
    pub lane_index: usize,
    pub data: Option<String>,
    pub data_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmRelation {
    pub source_index: usize,
    pub target_index: usize,
    pub source_id: String,
    pub target_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmNote {
    pub frame: String,
    pub text: String,
    pub data_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmSpecification {
    pub frame: String,
    pub given: Vec<String>,
    pub when: Vec<String>,
    pub then: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventModelingModel {
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    pub boxes: Vec<EmBox>,
    /// Sorted from top to bottom by `EmLane::index`.
    pub lanes: Vec<EmLane>,
    pub relations: Vec<EmRelation>,
    pub notes: Vec<EmNote>,
    pub specifications: Vec<EmSpecification>,
    pub entities: Vec<String>,
}

fn block_text(raw: &str) -> String {
    let inner = match (raw.find('{'), raw.rfind('}')) {
        (Some(open), Some(close)) if close > open => &raw[open + 1..close],
        (None, _) if raw.len() >= 2 => &raw[1..raw.len() - 1],
        _ => "",
    };
    let clean = inner.replace('\r', "");
    let mut lines: Vec<&str> = clean.split('\n').collect();
    while lines.first().is_some_and(|l| l.trim().is_empty()) {
        lines.remove(0);
    }
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    let mut indent = usize::MAX;
    for line in &lines {
        if line.trim().is_empty() {
            continue;
        }
        let leading = line.len() - line.trim_start().len();
        indent = indent.min(leading);
    }
    if indent == usize::MAX {
        indent = 0;
    }
    lines
        .into_iter()
        .map(|line| {
            let cut = indent.min(line.len());
            line[cut..].trim_end()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn build_event_model(ast: EventModelAst, src: &str, title: Option<&str>, origin: Option<&SourceMap<'_>>) -> Result<EventModelingModel, PeleError> {
    let mut ids: HashSet<&str> = HashSet::new();
    for frame in &ast.frames {
        if !ids.insert(frame.name.as_str()) {
            let loc = locate(src, frame.offset, origin);
            let mut err = PeleError::new(
                format!(r#"Duplicate event modeling frame ID "{}" on line {}"#, frame.name, loc.line),
                ErrorCode::Semantic,
            )
            .with_diagram_type(DiagramType::EventModeling);
            err.line = loc.line;
            return Err(err);
        }
    }

    let mut data: HashMap<&str, &str> = HashMap::new();
    for entity in &ast.data_entities {
        data.entry(entity.name.as_str()).or_insert(entity.data_block_value.as_str());
    }

    let mut lane_of: HashMap<String, EmLane> = HashMap::new();
    let mut next_idx: HashMap<LaneGroup, usize> = HashMap::new();
    let mut resolve_lane = |kind: EntityKind, namespace: Option<&str>| -> usize {
        let group = kind.lane_group();
        let key = match namespace {
            None => group.key().to_string(),
            Some(ns) => format!("{} {ns}", group.key()),
        };
        if let Some(found) = lane_of.get(&key) {
            return found.index;
        }
        let (first, label, prefix) = group.spec();
        let index = match namespace {
            None => first,
            Some(_) => {
                let idx = next_idx.get(&group).copied().unwrap_or(first + 1);
                next_idx.insert(group, idx + 1);
                idx
            }
        };
        let lane_label = match namespace {
            None => label.to_string(),
            Some(ns) => format!("{prefix}{ns}"),
        };
        lane_of.insert(
            key,
            EmLane {
                index,
                label: lane_label,
                group,
                namespace: namespace.map(str::to_string),
            },
        );
        index
    };

    let mut boxes: Vec<EmBox> = Vec::with_capacity(ast.frames.len());
    let mut relations: Vec<EmRelation> = Vec::new();
    for (index, frame) in ast.frames.iter().enumerate() {
        let parts: Vec<&str> = frame.entity_identifier.split('.').collect();
        let (namespace, name) = if parts.len() == 2 {
            (Some(parts[0]), parts[1])
        } else {
            (None, frame.entity_identifier.as_str())
        };
        let kind = EntityKind::from_keyword(&frame.model_entity_type);
        let mut text = frame.data_inline_value.as_deref().map(block_text);
        if let Some(ref_name) = &frame.data_reference
            && let Some(block) = data.get(ref_name.as_str())
        {
            text = Some(block_text(block));
        }
        let lane_index = resolve_lane(kind, namespace);
        let reset = frame.kind == FrameKind::ResetFrame;
        let box_id = frame.name.clone();
        boxes.push(EmBox {
            id: box_id.clone(),
            kind,
            entity: frame.entity_identifier.clone(),
            name: name.to_string(),
            namespace: namespace.map(str::to_string),
            reset,
            lane_index,
            data: text,
            data_type: frame.data_type.clone(),
        });

        if !frame.source_frames.is_empty() {
            let wanted: HashSet<&str> = frame.source_frames.iter().map(String::as_str).collect();
            for (src_idx, src_box) in boxes.iter().enumerate() {
                if wanted.contains(src_box.id.as_str()) {
                    relations.push(EmRelation {
                        source_index: src_idx,
                        target_index: index,
                        source_id: src_box.id.clone(),
                        target_id: box_id.clone(),
                    });
                }
            }
        } else if index > 0 && !reset {
            for i in (0..index).rev() {
                if boxes[i].lane_index != lane_index {
                    relations.push(EmRelation {
                        source_index: i,
                        target_index: index,
                        source_id: boxes[i].id.clone(),
                        target_id: box_id.clone(),
                    });
                    break;
                }
            }
        }
    }

    let mut lanes: Vec<EmLane> = lane_of.into_values().collect();
    lanes.sort_by_key(|l| l.index);

    let resolved_title = ast
        .title
        .as_deref()
        .map(title_value)
        .filter(|s| !s.is_empty())
        .or_else(|| title.map(str::to_string));

    Ok(EventModelingModel {
        title: resolved_title,
        acc_title: ast.acc_title.as_deref().map(|s| trim_leading_ws(&acc_title_value(s))),
        acc_descr: ast.acc_descr.as_deref().map(|s| collapse_newline_ws(&acc_descr_value(s))),
        boxes,
        lanes,
        relations,
        notes: ast
            .note_entities
            .into_iter()
            .map(|n| EmNote {
                frame: n.source_frame,
                text: block_text(&n.data_block_value),
                data_type: n.data_type,
            })
            .collect(),
        specifications: ast
            .gwt_entities
            .into_iter()
            .map(|g| EmSpecification {
                frame: g.source_frame,
                given: g.given_statements,
                when: g.when_statements,
                then: g.then_statements,
            })
            .collect(),
        entities: ast.model_entities,
    })
}
