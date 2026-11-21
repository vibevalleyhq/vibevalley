use std::collections::{HashMap, HashSet};

use crate::util::yaml::YamlValue;

use super::color_slots::{SlotNode, assign_color_slots};
use super::db::AgentflowDb;
use super::shapes::{ShapedNode, normalise_node_shapes, resolve_shape_alias};
use super::types::{DiagnosticId, LabelType, Metadata, VertexKind};

#[derive(Debug, Clone, PartialEq)]
pub struct GraphNode {
    pub id: String,
    pub label: Option<String>,
    pub label_type: LabelType,
    pub shape: String,
    pub is_group: bool,
    pub parent_id: Option<String>,
    pub css_styles: Vec<String>,
    pub css_compiled_styles: Vec<String>,
    pub css_classes: String,
    pub dir: Option<String>,
    pub link: Option<String>,
    pub link_target: Option<String>,
    pub tooltip: Option<String>,
    pub color_index: Option<usize>,
    pub kind: Option<VertexKind>,
    pub metadata: Option<Metadata>,
}

impl ShapedNode for GraphNode {
    fn id(&self) -> &str {
        &self.id
    }
    fn is_group(&self) -> bool {
        self.is_group
    }
    fn shape(&self) -> &str {
        &self.shape
    }
    fn set_shape(&mut self, shape: String) {
        self.shape = shape;
    }
}

impl SlotNode for GraphNode {
    fn id(&self) -> &str {
        &self.id
    }
    fn shape(&self) -> &str {
        &self.shape
    }
    fn is_group(&self) -> bool {
        self.is_group
    }
    fn set_color_index(&mut self, index: usize) {
        self.color_index = Some(index);
    }
    fn set_kind(&mut self, kind: VertexKind) {
        self.kind = Some(kind);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct GraphEdge {
    pub id: String,
    pub is_user_defined_id: bool,
    pub start: String,
    pub end: String,
    pub edge_type: String,
    pub label: String,
    pub label_type: LabelType,
    pub thickness: Option<String>,
    pub pattern: Option<String>,
    pub minlen: Option<usize>,
    pub arrow_type_start: String,
    pub arrow_type_end: String,
    pub css_compiled_styles: Vec<String>,
    pub style: Vec<String>,
    pub classes: String,
    pub animate: Option<YamlValue>,
    pub animation: Option<YamlValue>,
    pub curve: Option<String>,
    pub metadata: Option<Metadata>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

fn is_collapsed(metadata: Option<&Metadata>) -> bool {
    metadata.and_then(|m| m.get("view")).and_then(YamlValue::as_str) == Some("collapsed")
}

/// Resolves a parsed agentflow into drawable nodes and edges, recording shape and containment diagnostics.
pub fn build_agent_graph(db: &mut AgentflowDb, palette_length: usize, default_curve: Option<&str>) -> AgentGraph {
    let mut nodes: Vec<GraphNode> = Vec::new();
    let mut edges: Vec<GraphEdge> = Vec::new();

    let compiled = |db: &AgentflowDb, class_names: &[&str]| -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for &name in class_names {
            if let Some(def) = db.classes.get(name) {
                for s in &def.styles {
                    out.push(s.trim().to_string());
                }
                for s in &def.text_styles {
                    out.push(s.trim().to_string());
                }
            }
        }
        out
    };

    // Hide everything inside a collapsed flow, mapping each hidden id to its outermost collapsed flow.
    let mut hidden: HashSet<String> = HashSet::new();
    let mut owner: HashMap<String, String> = HashMap::new();
    let mut walked: HashSet<String> = HashSet::new();
    for sg in &db.subgraphs {
        if !is_collapsed(sg.metadata.as_ref()) || hidden.contains(&sg.id) {
            continue;
        }
        let mut pending = vec![sg.id.clone()];
        while let Some(cur) = pending.pop() {
            let Some(members) = db.subgraph(&cur).map(|s| &s.nodes) else {
                continue;
            };
            for child_id in members {
                if child_id == &sg.id || hidden.contains(child_id) {
                    continue;
                }
                hidden.insert(child_id.clone());
                owner.insert(child_id.clone(), sg.id.clone());
                if !walked.contains(child_id) {
                    pending.push(child_id.clone());
                }
            }
        }
        walked.insert(sg.id.clone());
    }

    let mut collapsed_into: HashMap<String, String> = HashMap::new();
    for id in &hidden {
        let mut path = vec![id.clone()];
        let mut top = owner.get(id).cloned().unwrap();
        loop {
            if let Some(known) = collapsed_into.get(&top) {
                top = known.clone();
                break;
            }
            let Some(up) = owner.get(&top).cloned() else {
                break;
            };
            path.push(top);
            top = up;
        }
        for p in path {
            collapsed_into.insert(p, top.clone());
        }
    }

    let mut position: HashMap<String, usize> = HashMap::with_capacity(db.subgraphs.len());
    for (i, sg) in db.subgraphs.iter().enumerate() {
        position.insert(sg.id.clone(), i);
    }

    let mut parent_of: HashMap<String, String> = HashMap::new();
    let mut containment_warnings: Vec<(String, String)> = Vec::new();
    let sg_len = db.subgraphs.len();
    for i in (0..sg_len).rev() {
        let sg = &db.subgraphs[i];
        if hidden.contains(&sg.id) {
            continue;
        }
        for id in &sg.nodes {
            let closes_loop = match position.get(id) {
                Some(&child_at) if child_at >= i => {
                    let mut current: Option<&str> = Some(sg.id.as_str());
                    let mut found = false;
                    let mut hops = 0;
                    while let Some(c) = current {
                        if hops > sg_len {
                            break;
                        }
                        if c == id.as_str() {
                            found = true;
                            break;
                        }
                        current = parent_of.get(c).map(String::as_str);
                        hops += 1;
                    }
                    found
                }
                _ => false,
            };
            if closes_loop {
                containment_warnings.push((
                    id.clone(),
                    format!(
                        r#"Container "{}" cannot contain "{id}" because "{id}" already contains it. The nesting that would close the loop is dropped."#,
                        sg.id
                    ),
                ));
                continue;
            }
            parent_of.insert(id.clone(), sg.id.clone());
        }
    }
    for (node_id, msg) in containment_warnings {
        db.emit_warning(DiagnosticId::ContainmentViolation, msg, Some(&node_id), None);
    }

    let mut by_id: HashMap<String, usize> = HashMap::new();
    for i in (0..db.subgraphs.len()).rev() {
        let sg = &db.subgraphs[i];
        if hidden.contains(&sg.id) {
            continue;
        }
        let collapsed = is_collapsed(sg.metadata.as_ref());
        let cls_refs: Vec<&str> = sg.classes.iter().map(String::as_str).collect();
        let metadata = if collapsed {
            let mut m = sg.metadata.clone().unwrap_or_default();
            m.insert("containerType".to_string(), YamlValue::String(sg.subgraph_type.to_string()));
            Some(m)
        } else {
            sg.metadata.clone()
        };
        let node = GraphNode {
            id: sg.id.clone(),
            label: Some(sg.title.clone()),
            label_type: sg.label_type,
            parent_id: parent_of.get(&sg.id).cloned(),
            css_styles: Vec::new(),
            css_compiled_styles: compiled(db, &cls_refs),
            css_classes: sg.classes.join(" "),
            shape: if collapsed { "collapsedGroup" } else { "flowGroup" }.to_string(),
            dir: sg.dir.clone(),
            is_group: !collapsed,
            link: None,
            link_target: None,
            tooltip: None,
            color_index: None,
            kind: None,
            metadata,
        };
        let idx = nodes.len();
        by_id.insert(sg.id.clone(), idx);
        nodes.push(node);
    }

    for vertex in db.nodes.values() {
        if hidden.contains(&vertex.id) {
            continue;
        }
        if let Some(&existing_idx) = by_id.get(&vertex.id) {
            let cls_refs: Vec<&str> = vertex.classes.iter().map(String::as_str).collect();
            let compiled_styles = compiled(db, &cls_refs);
            let existing = &mut nodes[existing_idx];
            existing.css_styles = vertex.styles.clone();
            existing.css_compiled_styles = compiled_styles;
            existing.css_classes = vertex.classes.join(" ");
            continue;
        }
        let resolved_type = vertex.node_type.as_deref().map(resolve_shape_alias);
        let mut cls_refs: Vec<&str> = Vec::with_capacity(vertex.classes.len() + 2);
        cls_refs.push("default");
        cls_refs.push("node");
        for c in &vertex.classes {
            cls_refs.push(c.as_str());
        }
        let shape = match resolved_type {
            None | Some("square") => "squareRect".to_string(),
            Some(other) => other.to_string(),
        };
        let node = GraphNode {
            id: vertex.id.clone(),
            label: vertex.text.clone(),
            label_type: vertex.label_type,
            parent_id: parent_of.get(&vertex.id).cloned(),
            css_styles: vertex.styles.clone(),
            css_compiled_styles: compiled(db, &cls_refs),
            css_classes: format!("default {}", vertex.classes.join(" ")),
            dir: vertex.dir.clone(),
            link: vertex.link.clone(),
            link_target: vertex.link_target.clone(),
            tooltip: db.tooltips.get(&vertex.id).cloned(),
            color_index: None,
            kind: None,
            metadata: vertex.metadata.clone(),
            is_group: false,
            shape,
        };
        let idx = nodes.len();
        by_id.insert(vertex.id.clone(), idx);
        nodes.push(node);
    }

    for (index, raw) in db.edges.iter().enumerate() {
        let start = collapsed_into.get(&raw.start).cloned().unwrap_or_else(|| raw.start.clone());
        let end = collapsed_into.get(&raw.end).cloned().unwrap_or_else(|| raw.end.clone());
        if start == end && raw.start != raw.end {
            continue;
        }
        let mut styles = db.default_edge_style.clone().unwrap_or_default();
        if let Some(ref s) = raw.style {
            styles.extend(s.iter().cloned());
        }
        let arrow = match raw.edge_type.as_deref() {
            Some("arrow_open") => "none",
            Some("arrow_cross") => "arrow_cross",
            Some("arrow_point") => "arrow_point",
            _ => "arrow_point",
        };
        let cls_refs: Vec<&str> = raw.classes.iter().map(String::as_str).collect();
        let edge_id = match raw.id.as_deref() {
            Some(id) if !id.is_empty() => id.to_string(),
            _ => format!("L_{start}_{end}_{index}"),
        };
        let curve = raw
            .interpolate
            .as_deref()
            .filter(|s| !s.is_empty())
            .or_else(|| db.default_interpolate.as_deref().filter(|s| !s.is_empty()))
            .or(default_curve)
            .map(str::to_string);
        edges.push(GraphEdge {
            id: edge_id,
            is_user_defined_id: raw.is_user_defined_id,
            start,
            end,
            edge_type: raw.edge_type.clone().unwrap_or_else(|| "normal".to_string()),
            label: raw.text.clone(),
            label_type: raw.label_type,
            thickness: raw.stroke.clone(),
            pattern: raw.stroke.clone(),
            minlen: raw.length,
            classes: "edge-thickness-normal edge-pattern-solid flowchart-link".to_string(),
            arrow_type_start: "none".to_string(),
            arrow_type_end: arrow.to_string(),
            css_compiled_styles: compiled(db, &cls_refs),
            style: styles,
            animate: raw.animate.clone(),
            animation: raw.animation.clone(),
            curve,
            metadata: raw.metadata.clone(),
        });
    }

    normalise_node_shapes(&mut nodes, db);

    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    for sg in &db.subgraphs {
        if let Some(parent) = parent_of.get(&sg.id) {
            children.entry(parent.clone()).or_default().push(sg.id.clone());
        }
    }
    let mut order: HashMap<String, usize> = HashMap::new();
    for sg in &db.subgraphs {
        if parent_of.contains_key(&sg.id) {
            continue;
        }
        let mut pending = vec![sg.id.clone()];
        while let Some(id) = pending.pop() {
            if order.contains_key(&id) {
                continue;
            }
            let next_idx = order.len();
            order.insert(id.clone(), next_idx);
            if let Some(kids) = children.get(&id) {
                for kid in kids.iter().rev() {
                    pending.push(kid.clone());
                }
            }
        }
    }

    assign_color_slots(
        &mut nodes,
        |id| {
            if db.connectors.contains_key(id) {
                return Some(VertexKind::Connector);
            }
            db.nodes.get(id).map(|v| db.vertex_kind(v))
        },
        &order,
        palette_length,
    );

    AgentGraph { nodes, edges }
}
