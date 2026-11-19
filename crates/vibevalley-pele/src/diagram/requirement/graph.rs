use super::db::{REL_CONTAINS, RequirementDb};
use super::types::{Requirement, RequirementElement};

#[derive(Debug, Clone)]
pub enum ReqNodeKind<'a> {
    Requirement(&'a Requirement),
    Element(&'a RequirementElement),
}

#[derive(Debug, Clone)]
pub struct GraphNode<'a> {
    pub id: &'a str,
    pub kind: ReqNodeKind<'a>,
    pub css_styles: &'a [String],
    pub css_classes: String,
}

#[derive(Debug, Clone)]
pub struct GraphEdge {
    pub id: String,
    pub start: Option<String>,
    pub end: Option<String>,
    pub rel_type: String,
    pub contains: bool,
}

#[derive(Debug, Clone)]
pub struct RequirementGraph<'a> {
    pub nodes: Vec<GraphNode<'a>>,
    pub edges: Vec<GraphEdge>,
    pub direction: &'a str,
}

/// The nodes and edges to lay out: requirements first, then elements, as Mermaid orders them.
pub fn build_requirement_graph(model: &RequirementDb) -> RequirementGraph<'_> {
    let mut nodes: Vec<GraphNode<'_>> = Vec::with_capacity(model.requirements.len() + model.elements.len());
    for requirement in model.requirements.values() {
        nodes.push(GraphNode {
            id: &requirement.name,
            kind: ReqNodeKind::Requirement(requirement),
            css_styles: &requirement.css_styles,
            css_classes: requirement.classes.join(" "),
        });
    }
    for element in model.elements.values() {
        nodes.push(GraphNode {
            id: &element.name,
            kind: ReqNodeKind::Element(element),
            css_styles: &element.css_styles,
            css_classes: element.classes.join(" "),
        });
    }
    let has = |id: &str| -> Option<String> {
        if model.requirements.contains_key(id) || model.elements.contains_key(id) {
            Some(id.to_string())
        } else {
            None
        }
    };
    let edges: Vec<GraphEdge> = model
        .relations
        .iter()
        .enumerate()
        .map(|(index, relation)| GraphEdge {
            id: format!("{}-{}-{index}", relation.src, relation.dst),
            start: has(&relation.src),
            end: has(&relation.dst),
            rel_type: relation.rel_type.clone(),
            contains: relation.rel_type == REL_CONTAINS,
        })
        .collect();
    RequirementGraph {
        nodes,
        edges,
        direction: &model.direction,
    }
}
