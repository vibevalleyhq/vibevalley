use std::collections::{HashMap, HashSet};

use super::db::ErDb;
use super::types::{Cardinality, ErAttribute, ErLabelType, Identification};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EdgePattern {
    Solid,
    Dashed,
}

#[derive(Debug, Clone)]
pub struct ErGraphNode {
    pub id: String,
    pub label: String,
    pub alias: String,
    pub attributes: Vec<ErAttribute>,
    pub is_group: bool,
    pub parent_id: Option<String>,
    pub css_styles: Vec<String>,
    pub css_compiled_styles: Vec<String>,
    pub css_classes: String,
    pub dir: Option<String>,
    pub label_type: ErLabelType,
}

#[derive(Debug, Clone)]
pub struct ErGraphEdge {
    pub id: String,
    pub start: String,
    pub end: String,
    pub label: String,
    pub arrow_type_start: Cardinality,
    pub arrow_type_end: Cardinality,
    pub pattern: EdgePattern,
}

#[derive(Debug, Clone)]
pub struct ErGraph {
    pub nodes: Vec<ErGraphNode>,
    pub edges: Vec<ErGraphEdge>,
}

/// Resolves a parsed ER diagram into what is drawn: subgraphs as groups, entities as nodes with
/// their class styles, and relationships as edges with a marker type at each end.
pub fn build_er_graph(model: &ErDb) -> ErGraph {
    let mut nodes: Vec<ErGraphNode> = Vec::with_capacity(model.subgraphs.len() + model.entities.len());
    let mut edges: Vec<ErGraphEdge> = Vec::with_capacity(model.relationships.len());

    let compiled = |names: &[&str]| -> Vec<String> {
        let mut out = Vec::new();
        for &name in names {
            let Some(def) = model.classes.get(name) else {
                continue;
            };
            for style in &def.styles {
                out.push(style.trim().to_string());
            }
            for style in &def.text_styles {
                out.push(style.trim().to_string());
            }
        }
        out
    };

    let mut parent_of: HashMap<&str, &str> = HashMap::new();
    let mut subgraph_ids: HashSet<&str> = HashSet::new();
    for subgraph in model.subgraphs.iter().rev() {
        subgraph_ids.insert(subgraph.id.as_str());
        for id in &subgraph.nodes {
            parent_of.insert(id.as_str(), subgraph.id.as_str());
        }
    }

    for subgraph in model.subgraphs.iter().rev() {
        let class_refs: Vec<&str> = subgraph.classes.iter().map(String::as_str).collect();
        nodes.push(ErGraphNode {
            id: subgraph.id.clone(),
            label: subgraph.title.clone(),
            alias: String::new(),
            attributes: Vec::new(),
            is_group: true,
            parent_id: parent_of.get(subgraph.id.as_str()).map(|s| (*s).to_string()),
            css_styles: subgraph.css_styles.clone(),
            css_compiled_styles: compiled(&class_refs),
            css_classes: subgraph.classes.join(" "),
            dir: subgraph.dir.clone(),
            label_type: subgraph.label_type,
        });
    }

    // A name that is also a subgraph id stands for the subgraph; redirect any relationships written before it.
    let mut moved: HashMap<&str, &str> = HashMap::new();
    for (name, entity) in &model.entities {
        if subgraph_ids.contains(name.as_str()) {
            moved.insert(entity.id.as_str(), name.as_str());
            continue;
        }
        let class_refs: Vec<&str> = entity.css_classes.split(' ').collect();
        nodes.push(ErGraphNode {
            id: entity.id.clone(),
            label: entity.label.clone(),
            alias: entity.alias.clone(),
            attributes: entity.attributes.clone(),
            is_group: false,
            parent_id: parent_of.get(name.as_str()).map(|s| (*s).to_string()),
            css_styles: entity.css_styles.clone(),
            css_compiled_styles: compiled(&class_refs),
            css_classes: entity.css_classes.clone(),
            dir: None,
            label_type: ErLabelType::Markdown,
        });
    }

    for (index, relationship) in model.relationships.iter().enumerate() {
        let start = moved
            .get(relationship.entity_a.as_str())
            .map_or_else(|| relationship.entity_a.clone(), |s| (*s).to_string());
        let end = moved
            .get(relationship.entity_b.as_str())
            .map_or_else(|| relationship.entity_b.clone(), |s| (*s).to_string());
        let pattern = match relationship.rel_spec.rel_type {
            Identification::Identifying => EdgePattern::Solid,
            Identification::NonIdentifying => EdgePattern::Dashed,
        };
        edges.push(ErGraphEdge {
            id: format!("id_{}_{}_{index}", relationship.entity_a, relationship.entity_b),
            start,
            end,
            label: relationship.role_a.clone(),
            arrow_type_start: relationship.rel_spec.card_b,
            arrow_type_end: relationship.rel_spec.card_a,
            pattern,
        });
    }

    ErGraph { nodes, edges }
}
