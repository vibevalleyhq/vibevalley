use std::collections::HashMap;

use indexmap::IndexMap;

use crate::detect::DiagramType;
use crate::error::{ErrorCode, PeleError};

use super::lexer::trim_js;
use super::types::{StateClassDef, StateDescription, StateStmt, StateType, Stmt};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StateNodeShape {
    Rect,
    RectWithTitle,
    StateStart,
    StateEnd,
    Choice,
    Fork,
    Join,
    Divider,
    RoundedWithTitle,
    Note,
    NoteGroup,
}

impl StateNodeShape {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Rect => "rect",
            Self::RectWithTitle => "rectWithTitle",
            Self::StateStart => "stateStart",
            Self::StateEnd => "stateEnd",
            Self::Choice => "choice",
            Self::Fork => "fork",
            Self::Join => "join",
            Self::Divider => "divider",
            Self::RoundedWithTitle => "roundedWithTitle",
            Self::Note => "note",
            Self::NoteGroup => "noteGroup",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StateNodeType {
    Group,
    Node,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EdgePattern {
    Dashed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateNode {
    pub id: String,
    pub shape: Option<StateNodeShape>,
    pub label: Option<String>,
    pub description: Vec<String>,
    pub css_classes: String,
    pub css_compiled_styles: Vec<String>,
    pub css_styles: Vec<String>,
    pub node_type: Option<StateNodeType>,
    pub is_group: bool,
    pub parent_id: Option<String>,
    /// The direction inside a composite: its last `direction` statement, or TB.
    pub dir: Option<String>,
    pub position: Option<String>,
    pub note_for: Option<String>,
    pub color_index: Option<usize>,
}

/// Labels are markdown throughout, as in Mermaid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateEdge {
    pub id: String,
    pub start: String,
    pub end: String,
    pub label: String,
    pub classes: String,
    pub pattern: Option<EdgePattern>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StateGraph {
    pub nodes: Vec<StateNode>,
    pub edges: Vec<StateEdge>,
}

enum DraftDesc {
    Str(String),
    List(Vec<String>),
}

impl DraftDesc {
    fn len(&self) -> usize {
        match self {
            Self::Str(s) => s.chars().count(),
            Self::List(v) => v.len(),
        }
    }
}

struct Draft {
    shape: Option<StateNodeShape>,
    description: DraftDesc,
    css_classes: String,
    css_styles: Vec<String>,
    node_type: Option<StateNodeType>,
    dir: Option<String>,
    color_index: Option<usize>,
}

struct Frame<'a> {
    parent_id: Option<&'a str>,
    doc: &'a [Stmt],
    at: usize,
    alt: bool,
}

fn doc_direction(doc: &[Stmt]) -> String {
    let mut dir = "TB";
    for item in doc {
        if let Stmt::Direction(d) = item {
            dir = d.value.as_str();
        }
    }
    dir.to_string()
}

fn state_type_shape(st: Option<StateType>) -> Option<StateNodeShape> {
    match st {
        None => None,
        Some(StateType::Default) => Some(StateNodeShape::Rect),
        Some(StateType::Fork) => Some(StateNodeShape::Fork),
        Some(StateType::Join) => Some(StateNodeShape::Join),
        Some(StateType::Choice) => Some(StateNodeShape::Choice),
        Some(StateType::Divider) => Some(StateNodeShape::Divider),
    }
}

struct GraphBuilder<'a> {
    states: &'a IndexMap<String, StateStmt>,
    nodes: Vec<StateNode>,
    edges: Vec<StateEdge>,
    by_id: HashMap<String, usize>,
    drafts: HashMap<String, Draft>,
    slots: HashMap<String, Option<usize>>,
    counter: usize,
    next_slot: usize,
}

impl<'a> GraphBuilder<'a> {
    fn insert(&mut self, mut node: StateNode) {
        // The two literal ids are what DOMPurify leaves of `<<fork>>` and `<<choice>>` in Mermaid; kept for parity.
        if node.id.is_empty() || node.id == "</join></fork>" || node.id == "</choice>" {
            return;
        }
        if let Some(&idx) = self.by_id.get(&node.id) {
            let existing = &mut self.nodes[idx];
            if node.parent_id.is_none() {
                node.parent_id = existing.parent_id.take();
            }
            *existing = node;
        } else {
            let idx = self.nodes.len();
            self.by_id.insert(node.id.clone(), idx);
            self.nodes.push(node);
        }
    }

    fn visit(&mut self, parent_id: Option<&str>, item: &StateStmt, alt: bool) {
        let id = item.id.as_str();
        if id == "root" {
            return;
        }
        let known = self.states.get(id);

        let needs_class_str = !self.drafts.contains_key(id) || (self.drafts.get(id).is_some_and(|d| d.node_type.is_none()) && item.doc.is_some());
        let class_str = if needs_class_str {
            known.map(|k| k.classes.join(" ")).unwrap_or_default()
        } else {
            String::new()
        };

        let draft = self.drafts.entry(id.to_string()).or_insert_with(|| {
            let mut shape = Some(StateNodeShape::Rect);
            match item.start {
                Some(true) => shape = Some(StateNodeShape::StateStart),
                Some(false) => shape = Some(StateNodeShape::StateEnd),
                None => {}
            }
            if item.state_type != Some(StateType::Default) {
                shape = state_type_shape(item.state_type);
            }
            Draft {
                shape,
                description: DraftDesc::Str(id.to_string()),
                css_classes: format!("{class_str} statediagram-state"),
                css_styles: known.map(|k| k.styles.clone()).unwrap_or_default(),
                node_type: None,
                dir: None,
                color_index: None,
            }
        });

        if let Some(desc) = &item.description
            && desc.is_truthy()
        {
            match &mut draft.description {
                DraftDesc::List(list) => {
                    draft.shape = Some(StateNodeShape::RectWithTitle);
                    match desc {
                        StateDescription::Single(s) => list.push(s.clone()),
                        StateDescription::Multi(v) => list.extend(v.iter().cloned()),
                    }
                }
                DraftDesc::Str(existing) => {
                    if !existing.is_empty() {
                        draft.shape = Some(StateNodeShape::RectWithTitle);
                        let mut next = Vec::new();
                        if existing != id {
                            next.push(existing.clone());
                        }
                        match desc {
                            StateDescription::Single(s) => next.push(s.clone()),
                            StateDescription::Multi(v) => next.extend(v.iter().cloned()),
                        }
                        draft.description = DraftDesc::List(next);
                    } else {
                        draft.shape = Some(StateNodeShape::Rect);
                        draft.description = match desc {
                            StateDescription::Single(s) => DraftDesc::Str(s.clone()),
                            StateDescription::Multi(v) => DraftDesc::List(v.clone()),
                        };
                    }
                }
            }
        }
        if draft.description.len() == 1 && draft.shape == Some(StateNodeShape::RectWithTitle) {
            draft.shape = if draft.node_type == Some(StateNodeType::Group) {
                Some(StateNodeShape::RoundedWithTitle)
            } else {
                Some(StateNodeShape::Rect)
            };
        }

        if draft.node_type.is_none()
            && let Some(child_doc) = &item.doc
        {
            draft.node_type = Some(StateNodeType::Group);
            draft.dir = Some(doc_direction(child_doc));
            draft.shape = if item.state_type == Some(StateType::Divider) {
                Some(StateNodeShape::Divider)
            } else {
                Some(StateNodeShape::RoundedWithTitle)
            };
            // A container takes the next palette slot unless it is a region, which shares its composite's.
            if draft.shape == Some(StateNodeShape::Divider)
                && let Some(pid) = parent_id
                && let Some(&parent_slot) = self.slots.get(pid)
            {
                draft.color_index = parent_slot;
            } else {
                let slot = self.next_slot;
                self.next_slot += 1;
                let has_styles = known.is_some_and(|k| !k.styles.is_empty());
                draft.color_index = if !trim_js(&class_str).is_empty() || has_styles { None } else { Some(slot) };
            }
            self.slots.insert(id.to_string(), draft.color_index);
            let alt_cls = if alt { "statediagram-cluster-alt" } else { "" };
            draft.css_classes = format!("{} statediagram-cluster {alt_cls}", draft.css_classes);
        }

        let (mut label, description) = match &draft.description {
            DraftDesc::List(list) => (list.first().cloned(), list.get(1..).unwrap_or(&[]).to_vec()),
            DraftDesc::Str(s) => (Some(s.clone()), Vec::new()),
        };
        if draft.shape == Some(StateNodeShape::Divider) {
            label = Some(String::new());
        }
        let draft_css_classes = draft.css_classes.clone();
        let node = StateNode {
            id: id.to_string(),
            shape: draft.shape,
            label,
            description,
            css_classes: draft_css_classes.clone(),
            css_compiled_styles: Vec::new(),
            css_styles: draft.css_styles.clone(),
            node_type: draft.node_type,
            is_group: draft.node_type == Some(StateNodeType::Group),
            parent_id: parent_id.filter(|&pid| pid != "root").map(str::to_string),
            dir: draft.dir.clone(),
            position: None,
            note_for: None,
            color_index: draft.color_index,
        };

        let Some(note) = &item.note else {
            self.insert(node);
            return;
        };

        // Mermaid puts each note in a group of its own, named after the state. Pele keeps that
        // group in the model and lays the note out beside its state instead.
        let note_id = format!("{id}----note-{}", self.counter);
        self.counter += 1;
        let note_parent_id = format!("{id}----parent");

        let note_group = StateNode {
            id: note_parent_id.clone(),
            shape: Some(StateNodeShape::NoteGroup),
            label: Some(note.text.clone()),
            description: Vec::new(),
            css_classes: draft_css_classes,
            css_compiled_styles: Vec::new(),
            css_styles: Vec::new(),
            node_type: Some(StateNodeType::Group),
            is_group: true,
            parent_id: None,
            dir: None,
            position: note.position.clone(),
            note_for: None,
            color_index: None,
        };
        let note_node = StateNode {
            id: note_id.clone(),
            shape: Some(StateNodeShape::Note),
            label: Some(note.text.clone()),
            description: Vec::new(),
            css_classes: "statediagram-note".to_string(),
            css_compiled_styles: Vec::new(),
            css_styles: Vec::new(),
            node_type: Some(StateNodeType::Node),
            is_group: false,
            parent_id: Some(note_parent_id),
            dir: None,
            position: note.position.clone(),
            note_for: Some(id.to_string()),
            color_index: None,
        };
        self.insert(note_group);
        self.insert(note_node);
        self.insert(node);

        let left = note.position.as_deref() == Some("left of");
        let (from, to) = if left { (note_id, id.to_string()) } else { (id.to_string(), note_id) };
        let edge_id = format!("{from}-{to}");
        self.edges.push(StateEdge {
            id: edge_id,
            start: from,
            end: to,
            label: String::new(),
            classes: "transition note-edge".to_string(),
            pattern: Some(EdgePattern::Dashed),
        });
    }
}

/// Mermaid's `dataFetcher`: walks the documents and resolves them into the nodes and edges drawn.
pub fn build_state_graph(root_doc: &[Stmt], states: &IndexMap<String, StateStmt>, classes: &IndexMap<String, StateClassDef>) -> Result<StateGraph, PeleError> {
    let mut builder = GraphBuilder {
        states,
        nodes: Vec::new(),
        edges: Vec::new(),
        by_id: HashMap::new(),
        drafts: HashMap::new(),
        slots: HashMap::new(),
        counter: 0,
        next_slot: 0,
    };

    let mut stack: Vec<Frame<'_>> = vec![Frame {
        parent_id: None,
        doc: root_doc,
        at: 0,
        alt: true,
    }];
    while let Some(frame) = stack.last_mut() {
        if frame.at >= frame.doc.len() {
            stack.pop();
            continue;
        }
        let item = &frame.doc[frame.at];
        frame.at += 1;
        let parent_id = frame.parent_id;
        let alt = frame.alt;
        match item {
            Stmt::State(s) => {
                builder.visit(parent_id, s, alt);
                if let Some(child_doc) = &s.doc {
                    stack.push(Frame {
                        parent_id: Some(&s.id),
                        doc: child_doc,
                        at: 0,
                        alt: !alt,
                    });
                }
            }
            Stmt::Relation(rel) => {
                builder.visit(parent_id, &rel.state1, alt);
                builder.visit(parent_id, &rel.state2, alt);
                let edge_id = format!("edge{}", builder.counter);
                builder.counter += 1;
                builder.edges.push(StateEdge {
                    id: edge_id,
                    start: rel.state1.id.clone(),
                    end: rel.state2.id.clone(),
                    label: rel.description.clone().unwrap_or_default(),
                    classes: "transition".to_string(),
                    pattern: None,
                });
            }
            Stmt::Raw(_) | Stmt::ClassDef(_) | Stmt::Style(_) | Stmt::ApplyClass(_) | Stmt::Direction(_) | Stmt::Click(_) => {}
        }
    }

    // Compile class styles once per final node (matching overwrite semantics of insert()).
    if !classes.is_empty() {
        for node in &mut builder.nodes {
            if !node.css_classes.is_empty() {
                for name in node.css_classes.split(' ') {
                    if let Some(def) = classes.get(name) {
                        node.css_compiled_styles.extend(def.styles.iter().cloned());
                    }
                }
            }
        }
    }

    for node in &builder.nodes {
        if node.is_group && !node.description.is_empty() {
            return Err(PeleError::new(
                format!("Group nodes can only have label. Remove the additional description for node [{}]", node.id),
                ErrorCode::Semantic,
            )
            .with_diagram_type(DiagramType::State));
        }
    }

    Ok(StateGraph {
        nodes: builder.nodes,
        edges: builder.edges,
    })
}
