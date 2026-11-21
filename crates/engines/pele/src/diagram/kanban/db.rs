use crate::detect::DiagramType;
use crate::diagram::mindmap::outline::{NodeShape, OutlineDb};
use crate::error::{ErrorCode, PeleError};
use crate::util::yaml::{YamlValue, parse_yaml};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KanbanNode {
    pub id: String,
    pub level: usize,
    pub label: String,
    pub icon: Option<String>,
    pub assigned: Option<String>,
    pub ticket: Option<String>,
    pub priority: Option<String>,
    pub css_classes: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KanbanSection {
    pub node: KanbanNode,
    pub items: Vec<KanbanNode>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KanbanModel {
    pub title: Option<String>,
    pub sections: Vec<KanbanSection>,
}

fn yaml_truthy_string(val: &YamlValue) -> Option<String> {
    match val {
        YamlValue::Null => None,
        YamlValue::Bool(false) => None,
        YamlValue::Bool(true) => Some("true".to_string()),
        YamlValue::Number(n) => {
            if *n == 0.0 || n.is_nan() {
                None
            } else if n.fract() == 0.0 && n.abs() < 1e15 {
                Some(format!("{}", *n as i64))
            } else {
                Some(format!("{n}"))
            }
        }
        YamlValue::String(s) => (!s.is_empty()).then(|| s.clone()),
        YamlValue::Seq(items) => {
            let parts: Vec<String> = items.iter().map(|v| yaml_truthy_string(v).unwrap_or_default()).collect();
            Some(parts.join(","))
        }
        YamlValue::Map(_) => Some("[object Object]".to_string()),
    }
}

enum LastRef {
    Section(usize),
    Item(usize, usize),
}

pub struct KanbanDb {
    title: Option<String>,
    sections: Vec<KanbanSection>,
    last: Option<LastRef>,
    section_level: usize,
    misplaced: Option<String>,
}

impl KanbanDb {
    pub fn new(title: Option<String>) -> Self {
        Self {
            title,
            sections: Vec::new(),
            last: None,
            section_level: 0,
            misplaced: None,
        }
    }

    pub fn finish(self) -> KanbanModel {
        KanbanModel {
            title: self.title,
            sections: self.sections,
        }
    }
}

impl OutlineDb for KanbanDb {
    fn add_node(&mut self, level: usize, id: String, descr: String, _node_type: NodeShape, shape_data: Option<String>) -> Result<(), PeleError> {
        let mut node = KanbanNode {
            id,
            level,
            label: descr,
            icon: None,
            assigned: None,
            ticket: None,
            priority: None,
            css_classes: None,
        };

        if let Some(raw_data) = shape_data {
            let yaml = if raw_data.contains('\n') {
                format!("{raw_data}\n")
            } else {
                format!("{{\n{raw_data}\n}}")
            };
            let doc = parse_yaml(&yaml).map_err(|msg| {
                PeleError::new(format!("Metadata of \"{}\" is not valid YAML. {msg}", node.id), ErrorCode::Syntax).with_diagram_type(DiagramType::Kanban)
            })?;
            if let Some(map) = doc.as_map() {
                if let Some(shape) = map.get("shape").and_then(yaml_truthy_string)
                    && (shape != shape.to_lowercase() || shape.contains('_'))
                {
                    return Err(
                        PeleError::new(format!("No such shape: {shape}. Shape names should be lowercase."), ErrorCode::Semantic)
                            .with_diagram_type(DiagramType::Kanban),
                    );
                }
                if let Some(label) = map.get("label").and_then(yaml_truthy_string) {
                    node.label = label;
                }
                if let Some(icon) = map.get("icon").and_then(yaml_truthy_string) {
                    node.icon = Some(icon);
                }
                if let Some(assigned) = map.get("assigned").and_then(yaml_truthy_string) {
                    node.assigned = Some(assigned);
                }
                if let Some(ticket) = map.get("ticket").and_then(yaml_truthy_string) {
                    node.ticket = Some(ticket);
                }
                if let Some(priority) = map.get("priority").and_then(yaml_truthy_string) {
                    node.priority = Some(priority);
                }
            }
        }

        if let Some(ref misplaced_label) = self.misplaced {
            return Err(PeleError::new(
                format!("Items without section detected, found section (\"{misplaced_label}\")"),
                ErrorCode::Semantic,
            )
            .with_diagram_type(DiagramType::Kanban));
        }

        if self.sections.is_empty() {
            self.section_level = level;
        }
        if level == self.section_level {
            let sec_idx = self.sections.len();
            self.sections.push(KanbanSection { node, items: Vec::new() });
            self.last = Some(LastRef::Section(sec_idx));
        } else {
            let sec_idx = self.sections.len() - 1;
            if level < self.section_level {
                self.misplaced = Some(node.label.clone());
            }
            let item_idx = self.sections[sec_idx].items.len();
            self.sections[sec_idx].items.push(node);
            self.last = Some(LastRef::Item(sec_idx, item_idx));
        }
        Ok(())
    }

    fn decorate_node(&mut self, icon: Option<String>, class: Option<String>) {
        let node = match self.last {
            Some(LastRef::Section(s)) => &mut self.sections[s].node,
            Some(LastRef::Item(s, i)) => &mut self.sections[s].items[i],
            None => return,
        };
        if let Some(ic) = icon
            && !ic.is_empty()
        {
            node.icon = Some(ic);
        }
        if let Some(cl) = class
            && !cl.is_empty()
        {
            node.css_classes = Some(cl);
        }
    }
}
