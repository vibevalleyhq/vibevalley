use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;

use crate::util::yaml::YamlValue;

use super::db::FlowDb;
use super::types::{FlowNode, LabelType};

#[derive(Debug, Clone)]
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
    pub icon: Option<String>,
    pub pos: Option<String>,
    pub img: Option<String>,
    pub asset_width: Option<f64>,
    pub asset_height: Option<f64>,
    pub constraint: Option<String>,
    pub color_index: Option<usize>,
    pub metadata: Option<IndexMap<String, YamlValue>>,
}

#[derive(Debug, Clone)]
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
    pub minlen: Option<i32>,
    pub arrow_type_start: String,
    pub arrow_type_end: String,
    pub css_compiled_styles: Vec<String>,
    pub style: Vec<String>,
    pub classes: String,
    pub animate: Option<bool>,
    pub animation: Option<String>,
    pub curve: Option<String>,
}

#[derive(Debug, Clone)]
pub struct FlowGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

fn shape_of(vertex: &FlowNode) -> String {
    if vertex.img.is_some() {
        return "imageSquare".to_string();
    }
    if vertex.icon.is_some() {
        return match vertex.form.as_deref() {
            Some("circle") => "iconCircle".to_string(),
            Some("square") => "iconSquare".to_string(),
            Some("rounded") => "iconRounded".to_string(),
            _ => "icon".to_string(),
        };
    }
    match vertex.shape_type.as_deref() {
        None | Some("square") => "squareRect".to_string(),
        Some("round") => "roundedRect".to_string(),
        Some(other) => other.to_string(),
    }
}

fn arrows(edge_type: Option<&str>) -> (&'static str, &'static str) {
    match edge_type {
        Some("arrow_point") => ("none", "arrow_point"),
        Some("arrow_circle") => ("none", "arrow_circle"),
        Some("arrow_cross") => ("none", "arrow_cross"),
        Some("double_arrow_point") => ("arrow_point", "arrow_point"),
        Some("double_arrow_circle") => ("arrow_circle", "arrow_circle"),
        Some("double_arrow_cross") => ("arrow_cross", "arrow_cross"),
        _ => ("none", "arrow_point"),
    }
}

pub fn build_flow_graph(db: &FlowDb, default_curve: Option<&str>) -> FlowGraph {
    let mut nodes: Vec<GraphNode> = Vec::new();
    let mut edges: Vec<GraphEdge> = Vec::new();
    let subgraphs = &db.subgraphs;

    let compiled = |class_names: &[&str]| -> Vec<String> {
        let mut out = Vec::new();
        for &name in class_names {
            let Some(def) = db.classes.get(name) else {
                continue;
            };
            for s in &def.styles {
                out.push(s.trim().to_string());
            }
            for s in &def.text_styles {
                out.push(s.trim().to_string());
            }
        }
        out
    };

    let mut subgraph_parent: HashMap<&str, &str> = HashMap::new();
    for sg in subgraphs {
        for child_id in &sg.nodes {
            if db.subgraph(child_id).is_some() {
                subgraph_parent.insert(child_id.as_str(), sg.id.as_str());
            }
        }
    }

    let mut declaration_index: HashMap<&str, usize> = HashMap::new();
    let mut children_of: HashMap<&str, Vec<&str>> = HashMap::new();
    for sg in subgraphs {
        if let Some(&parent) = subgraph_parent.get(sg.id.as_str()) {
            children_of.entry(parent).or_default().push(sg.id.as_str());
        }
    }
    let mut next_index = 0usize;
    for sg in subgraphs {
        if subgraph_parent.contains_key(sg.id.as_str()) {
            continue;
        }
        let mut pending = vec![sg.id.as_str()];
        while let Some(id) = pending.pop() {
            if declaration_index.contains_key(id) {
                continue;
            }
            declaration_index.insert(id, next_index);
            next_index += 1;
            if let Some(kids) = children_of.get(id) {
                for &kid in kids.iter().rev() {
                    pending.push(kid);
                }
            }
        }
    }

    let is_collapsed = |id: &str| -> bool {
        db.subgraph(id)
            .and_then(|s| s.metadata.as_ref())
            .and_then(|m| m.get("view"))
            .and_then(YamlValue::as_str)
            == Some("collapsed")
    };
    let any_collapsed = subgraphs.iter().any(|sg| is_collapsed(&sg.id));

    let mut outermost: HashMap<&str, Option<&str>> = HashMap::new();
    let mut hidden: HashSet<&str> = HashSet::new();
    let mut collapsed_into: HashMap<&str, &str> = HashMap::new();
    if any_collapsed {
        for sg in subgraphs {
            let mut chain: Vec<&str> = Vec::new();
            let mut seen: HashSet<&str> = HashSet::new();
            let mut current = Some(sg.id.as_str());
            while let Some(cur) = current {
                if outermost.contains_key(cur) || !seen.insert(cur) {
                    break;
                }
                chain.push(cur);
                current = subgraph_parent.get(cur).copied();
            }
            let mut result = current.and_then(|cur| outermost.get(cur).copied().flatten());
            for &id in chain.iter().rev() {
                if result.is_none() && is_collapsed(id) {
                    result = Some(id);
                }
                outermost.insert(id, result);
            }
            let Some(ancestor) = result else {
                continue;
            };
            if sg.id.as_str() != ancestor {
                hidden.insert(sg.id.as_str());
                collapsed_into.insert(sg.id.as_str(), ancestor);
            }
            for child_id in &sg.nodes {
                if child_id.as_str() == ancestor {
                    continue;
                }
                hidden.insert(child_id.as_str());
                collapsed_into.insert(child_id.as_str(), ancestor);
            }
        }
    }

    let mut parent_of: HashMap<&str, &str> = HashMap::new();
    let mut groups: HashSet<&str> = HashSet::new();
    for sg in subgraphs.iter().rev() {
        if hidden.contains(sg.id.as_str()) {
            continue;
        }
        if !sg.nodes.is_empty() {
            groups.insert(sg.id.as_str());
        }
        for id in &sg.nodes {
            parent_of.insert(id.as_str(), sg.id.as_str());
        }
    }

    let mut by_id: HashMap<String, usize> = HashMap::new();
    for sg in subgraphs.iter().rev() {
        if hidden.contains(sg.id.as_str()) {
            continue;
        }
        let collapsed = is_collapsed(&sg.id);
        let cls_refs: Vec<&str> = sg.classes.iter().map(String::as_str).collect();
        let idx = nodes.len();
        nodes.push(GraphNode {
            id: sg.id.clone(),
            label: Some(sg.title.clone()),
            label_type: sg.label_type,
            parent_id: parent_of.get(sg.id.as_str()).map(|s| (*s).to_string()),
            css_styles: Vec::new(),
            css_compiled_styles: compiled(&cls_refs),
            css_classes: sg.classes.join(" "),
            shape: if collapsed { "collapsedGroup".to_string() } else { "rect".to_string() },
            dir: sg.dir.clone(),
            is_group: !collapsed,
            color_index: declaration_index.get(sg.id.as_str()).copied(),
            metadata: if collapsed { None } else { sg.metadata.clone() },
            link: None,
            link_target: None,
            tooltip: None,
            icon: None,
            pos: None,
            img: None,
            asset_width: None,
            asset_height: None,
            constraint: None,
        });
        by_id.insert(sg.id.clone(), idx);
    }

    for vertex in db.nodes.values() {
        if hidden.contains(vertex.id.as_str()) {
            continue;
        }
        if let Some(&existing_idx) = by_id.get(&vertex.id) {
            let cls_refs: Vec<&str> = vertex.classes.iter().map(String::as_str).collect();
            let existing = &mut nodes[existing_idx];
            existing.css_styles = vertex.styles.clone();
            existing.css_compiled_styles = compiled(&cls_refs);
            existing.css_classes = vertex.classes.join(" ");
            continue;
        }
        let is_group = groups.contains(vertex.id.as_str());
        let mut cls_refs: Vec<&str> = Vec::with_capacity(vertex.classes.len() + 2);
        cls_refs.push("default");
        cls_refs.push("node");
        for c in &vertex.classes {
            cls_refs.push(c.as_str());
        }
        nodes.push(GraphNode {
            id: vertex.id.clone(),
            label: vertex.text.clone(),
            label_type: vertex.label_type,
            parent_id: parent_of.get(vertex.id.as_str()).map(|s| (*s).to_string()),
            css_styles: vertex.styles.clone(),
            css_compiled_styles: compiled(&cls_refs),
            css_classes: format!("default {}", vertex.classes.join(" ")),
            dir: vertex.dir.clone(),
            link: vertex.link.clone(),
            link_target: vertex.link_target.clone(),
            tooltip: db.tooltips.get(&vertex.id).cloned(),
            icon: vertex.icon.clone(),
            pos: vertex.pos.clone(),
            img: vertex.img.clone(),
            asset_width: vertex.asset_width,
            asset_height: vertex.asset_height,
            constraint: vertex.constraint.clone(),
            is_group,
            shape: if is_group { "rect".to_string() } else { shape_of(vertex) },
            color_index: None,
            metadata: None,
        });
    }

    for (index, raw) in db.edges.iter().enumerate() {
        let start = collapsed_into.get(raw.start.as_str()).copied().unwrap_or(raw.start.as_str());
        let end = collapsed_into.get(raw.end.as_str()).copied().unwrap_or(raw.end.as_str());
        if start == end && (collapsed_into.contains_key(raw.start.as_str()) || collapsed_into.contains_key(raw.end.as_str())) {
            continue;
        }
        let (arrow_start, arrow_end) = arrows(raw.edge_type.as_deref());
        let mut styles = db.default_edge_style.clone().unwrap_or_default();
        if let Some(ref raw_style) = raw.style {
            styles.extend(raw_style.iter().cloned());
        }
        let plain = raw.stroke.as_deref() == Some("invisible") || raw.edge_type.as_deref() == Some("arrow_open");
        let cls_refs: Vec<&str> = raw.classes.iter().map(String::as_str).collect();
        edges.push(GraphEdge {
            id: raw.id.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| format!("L_{start}_{end}_{index}")),
            is_user_defined_id: raw.is_user_defined_id,
            start: start.to_string(),
            end: end.to_string(),
            edge_type: raw.edge_type.clone().unwrap_or_else(|| "normal".to_string()),
            label: raw.text.clone(),
            label_type: raw.label_type,
            thickness: raw.stroke.clone(),
            pattern: raw.stroke.clone(),
            minlen: raw.length,
            classes: if raw.stroke.as_deref() == Some("invisible") {
                String::new()
            } else {
                "edge-thickness-normal edge-pattern-solid flowchart-link".to_string()
            },
            arrow_type_start: if plain { "none" } else { arrow_start }.to_string(),
            arrow_type_end: if plain { "none" } else { arrow_end }.to_string(),
            css_compiled_styles: compiled(&cls_refs),
            style: styles,
            animate: raw.animate,
            animation: raw.animation.clone(),
            curve: raw
                .interpolate
                .clone()
                .or_else(|| db.default_interpolate.clone())
                .or_else(|| default_curve.map(str::to_string)),
        });
    }

    FlowGraph { nodes, edges }
}
