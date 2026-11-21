use std::collections::{HashMap, HashSet};
use std::fmt;

use crate::engine::canvas::model::{Canvas, Edge, EdgeId, Node, NodeId};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ValidationIssue {
    #[error("node at index {index} has an empty id")]
    EmptyNodeId { index: usize },
    #[error("duplicate node id {id:?} at index {duplicate_index} (first seen at {first_index})")]
    DuplicateNodeId { id: NodeId, first_index: usize, duplicate_index: usize },
    #[error("node {id:?} has non-positive dimensions ({width}x{height})")]
    NonPositiveNodeDimensions { id: NodeId, width: i64, height: i64 },
    #[error("node {id:?} has invalid color {value:?}")]
    InvalidNodeColor { id: NodeId, value: String },
    #[error("file node {id:?} has an empty file path")]
    EmptyFilePath { id: NodeId },
    #[error("file node {id:?} has invalid subpath {subpath:?}: must start with '#' followed by a heading or block target")]
    InvalidFileSubpath { id: NodeId, subpath: String },
    #[error("link node {id:?} has invalid url {url:?}")]
    InvalidLinkUrl { id: NodeId, url: String },
    #[error("group node {id:?} has an empty background path")]
    EmptyGroupBackground { id: NodeId },
    #[error("edge at index {index} has an empty id")]
    EmptyEdgeId { index: usize },
    #[error("duplicate edge id {id:?} at index {duplicate_index} (first seen at {first_index})")]
    DuplicateEdgeId { id: EdgeId, first_index: usize, duplicate_index: usize },
    #[error("edge {edge_id:?} references missing fromNode {missing_node:?}")]
    DanglingEdgeSource { edge_id: EdgeId, missing_node: NodeId },
    #[error("edge {edge_id:?} references missing toNode {missing_node:?}")]
    DanglingEdgeTarget { edge_id: EdgeId, missing_node: NodeId },
    #[error("edge {id:?} has invalid color {value:?}")]
    InvalidEdgeColor { id: EdgeId, value: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ValidationReport {
    issues: Vec<ValidationIssue>,
}

impl ValidationReport {
    pub fn issues(&self) -> &[ValidationIssue] {
        &self.issues
    }

    pub fn is_empty(&self) -> bool {
        self.issues.is_empty()
    }

    pub fn len(&self) -> usize {
        self.issues.len()
    }
}

impl fmt::Display for ValidationReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (idx, issue) in self.issues.iter().enumerate() {
            if idx > 0 {
                f.write_str("; ")?;
            }
            write!(f, "{issue}")?;
        }
        Ok(())
    }
}

impl std::error::Error for ValidationReport {}

pub fn is_valid_subpath(subpath: &str) -> bool {
    subpath.starts_with('#') && subpath.len() > 1
}

/// Validates RFC 3986 URI scheme syntax (`scheme:rest` with no whitespace or control characters),
/// accepting `https://`, `http://`, `obsidian://`, `vv://`, `mailto:`, etc.
pub fn is_valid_url(url: &str) -> bool {
    if url.is_empty() || url.bytes().any(|b| b.is_ascii_control() || b.is_ascii_whitespace()) {
        return false;
    }
    let Some((scheme, rest)) = url.split_once(':') else {
        return false;
    };
    if rest.is_empty() {
        return false;
    }
    let mut chars = scheme.bytes();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphabetic() {
        return false;
    }
    if !chars.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.')) {
        return false;
    }
    if let Some(after_slashes) = rest.strip_prefix("//") {
        !after_slashes.is_empty()
    } else {
        true
    }
}

pub fn validate_node(node: &Node, index: usize, out: &mut Vec<ValidationIssue>) {
    if node.id().is_empty() {
        out.push(ValidationIssue::EmptyNodeId { index });
    }
    if !node.bounds().is_positive() {
        out.push(ValidationIssue::NonPositiveNodeDimensions {
            id: node.id().clone(),
            width: node.width(),
            height: node.height(),
        });
    }
    if let Some(color) = node.color()
        && !color.is_valid()
    {
        out.push(ValidationIssue::InvalidNodeColor {
            id: node.id().clone(),
            value: color.as_str().to_owned(),
        });
    }
    match node {
        Node::Text(_) => {}
        Node::File(f) => {
            if f.file.is_empty() {
                out.push(ValidationIssue::EmptyFilePath { id: f.id.clone() });
            }
            if let Some(subpath) = &f.subpath
                && !is_valid_subpath(subpath)
            {
                out.push(ValidationIssue::InvalidFileSubpath {
                    id: f.id.clone(),
                    subpath: subpath.clone(),
                });
            }
        }
        Node::Link(l) => {
            if !is_valid_url(&l.url) {
                out.push(ValidationIssue::InvalidLinkUrl {
                    id: l.id.clone(),
                    url: l.url.clone(),
                });
            }
        }
        Node::Group(g) => {
            if let Some(bg) = &g.background
                && bg.is_empty()
            {
                out.push(ValidationIssue::EmptyGroupBackground { id: g.id.clone() });
            }
        }
    }
}

pub fn validate_edge(edge: &Edge, index: usize, node_ids: &HashSet<&NodeId>, out: &mut Vec<ValidationIssue>) {
    if edge.id.is_empty() {
        out.push(ValidationIssue::EmptyEdgeId { index });
    }
    if !node_ids.contains(&edge.from_node) {
        out.push(ValidationIssue::DanglingEdgeSource {
            edge_id: edge.id.clone(),
            missing_node: edge.from_node.clone(),
        });
    }
    if !node_ids.contains(&edge.to_node) {
        out.push(ValidationIssue::DanglingEdgeTarget {
            edge_id: edge.id.clone(),
            missing_node: edge.to_node.clone(),
        });
    }
    if let Some(color) = &edge.color
        && !color.is_valid()
    {
        out.push(ValidationIssue::InvalidEdgeColor {
            id: edge.id.clone(),
            value: color.as_str().to_owned(),
        });
    }
}

pub fn validate(canvas: &Canvas) -> Result<(), ValidationReport> {
    let mut issues = Vec::new();
    let mut seen_nodes: HashMap<&NodeId, usize> = HashMap::with_capacity(canvas.nodes.len());

    for (index, node) in canvas.nodes.iter().enumerate() {
        validate_node(node, index, &mut issues);
        if !node.id().is_empty()
            && let Some(&first_index) = seen_nodes.get(node.id())
        {
            issues.push(ValidationIssue::DuplicateNodeId {
                id: node.id().clone(),
                first_index,
                duplicate_index: index,
            });
        } else if !node.id().is_empty() {
            seen_nodes.insert(node.id(), index);
        }
    }

    let node_ids: HashSet<&NodeId> = seen_nodes.keys().copied().collect();
    let mut seen_edges: HashMap<&EdgeId, usize> = HashMap::with_capacity(canvas.edges.len());

    for (index, edge) in canvas.edges.iter().enumerate() {
        validate_edge(edge, index, &node_ids, &mut issues);
        if !edge.id.is_empty()
            && let Some(&first_index) = seen_edges.get(&edge.id)
        {
            issues.push(ValidationIssue::DuplicateEdgeId {
                id: edge.id.clone(),
                first_index,
                duplicate_index: index,
            });
        } else if !edge.id.is_empty() {
            seen_edges.insert(&edge.id, index);
        }
    }

    if issues.is_empty() { Ok(()) } else { Err(ValidationReport { issues }) }
}
