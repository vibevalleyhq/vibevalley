use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;

use crate::detect::DiagramType;
use crate::error::{ErrorCode, PeleError};
use crate::util::chars::is_space_char;

use super::parser::{AlignDirection, ArchitectureAst, Side};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchService {
    pub id: String,
    pub icon: Option<String>,
    pub icon_text: Option<String>,
    pub title: Option<String>,
    pub in_group: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchJunction {
    pub id: String,
    pub in_group: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArchNode {
    Service(ArchService),
    Junction(ArchJunction),
}

impl ArchNode {
    pub fn id(&self) -> &str {
        match self {
            Self::Service(s) => &s.id,
            Self::Junction(j) => &j.id,
        }
    }

    pub fn in_group(&self) -> Option<&str> {
        match self {
            Self::Service(s) => s.in_group.as_deref(),
            Self::Junction(j) => j.in_group.as_deref(),
        }
    }

    pub fn is_junction(&self) -> bool {
        matches!(self, Self::Junction(_))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchGroup {
    pub id: String,
    pub icon: Option<String>,
    pub title: Option<String>,
    pub in_group: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchEdge {
    pub lhs_id: String,
    pub lhs_dir: Side,
    pub lhs_into: bool,
    pub lhs_group: bool,
    pub rhs_id: String,
    pub rhs_dir: Side,
    pub rhs_into: bool,
    pub rhs_group: bool,
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchLayoutHint {
    pub direction: AlignDirection,
    pub members: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RegKind {
    Node,
    Group,
}

impl RegKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Node => "node",
            Self::Group => "group",
        }
    }
}

fn fail(message: String) -> PeleError {
    PeleError::new(message, ErrorCode::Semantic).with_diagram_type(DiagramType::Architecture)
}

#[derive(Debug, Clone, Default)]
pub struct ArchitectureDb {
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    pub nodes: IndexMap<String, ArchNode>,
    pub groups: IndexMap<String, ArchGroup>,
    pub edges: Vec<ArchEdge>,
    pub layout_hints: Vec<ArchLayoutHint>,
    registered: HashMap<String, RegKind>,
}

impl ArchitectureDb {
    pub fn new() -> Self {
        Self::default()
    }

    fn register(&mut self, kind_name: &str, reg_kind: RegKind, id: &str, parent: Option<&str>) -> Result<(), PeleError> {
        if let Some(&existing) = self.registered.get(id) {
            return Err(fail(format!("The {kind_name} id [{id}] is already in use by another {}", existing.as_str())));
        }
        if let Some(p) = parent {
            if id == p {
                return Err(fail(format!("The {kind_name} [{id}] cannot be placed within itself")));
            }
            match self.registered.get(p) {
                None => {
                    return Err(fail(format!(
                        "The {kind_name} [{id}]'s parent does not exist. Please make sure the parent is created before this {kind_name}"
                    )));
                }
                Some(RegKind::Node) => {
                    return Err(fail(format!("The {kind_name} [{id}]'s parent is not a group")));
                }
                Some(RegKind::Group) => {}
            }
        }
        self.registered.insert(id.to_string(), reg_kind);
        Ok(())
    }

    pub fn add_service(&mut self, service: ArchService) -> Result<(), PeleError> {
        self.register("service", RegKind::Node, &service.id, service.in_group.as_deref())?;
        self.nodes.insert(service.id.clone(), ArchNode::Service(service));
        Ok(())
    }

    pub fn add_junction(&mut self, junction: ArchJunction) -> Result<(), PeleError> {
        self.register("junction", RegKind::Node, &junction.id, junction.in_group.as_deref())?;
        self.nodes.insert(junction.id.clone(), ArchNode::Junction(junction));
        Ok(())
    }

    pub fn add_group(&mut self, group: ArchGroup) -> Result<(), PeleError> {
        self.register("group", RegKind::Group, &group.id, group.in_group.as_deref())?;
        self.groups.insert(group.id.clone(), group);
        Ok(())
    }

    pub fn add_edge(&mut self, edge: ArchEdge) -> Result<(), PeleError> {
        let ends = [("left", edge.lhs_id.as_str(), edge.lhs_group), ("right", edge.rhs_id.as_str(), edge.rhs_group)];
        for &(side, id, _) in &ends {
            if !self.registered.contains_key(id) {
                return Err(fail(format!(
                    "The {side}-hand id [{id}] does not yet exist. Please create the service/group before declaring an edge to it."
                )));
            }
        }
        for &(side, id, _) in &ends {
            if !self.nodes.contains_key(id) {
                return Err(fail(format!(
                    "The {side}-hand id [{id}] is a group. Add {{group}} to a service inside it instead."
                )));
            }
        }
        let parent = self.nodes.get(&edge.lhs_id).and_then(ArchNode::in_group);
        if parent.is_some() && parent == self.nodes.get(&edge.rhs_id).and_then(ArchNode::in_group) {
            for &(side, id, crosses) in &ends {
                if crosses {
                    return Err(fail(format!(
                        "The {side}-hand id [{id}] is modified to traverse the group boundary, but the edge does not pass through two groups."
                    )));
                }
            }
        }
        self.edges.push(edge);
        Ok(())
    }

    pub fn add_layout_hint(&mut self, hint: ArchLayoutHint) -> Result<(), PeleError> {
        if hint.members.len() < 2 {
            return Err(fail(format!("An align directive requires at least two members; got {}", hint.members.len())));
        }
        let mut seen: HashSet<&str> = HashSet::new();
        for id in &hint.members {
            if self.registered.get(id.as_str()) != Some(&RegKind::Node) {
                return Err(fail(format!(
                    "align {} references [{id}], which is not a service or junction",
                    hint.direction.as_str()
                )));
            }
            if !seen.insert(id.as_str()) {
                return Err(fail(format!("align {} lists [{id}] more than once", hint.direction.as_str())));
            }
        }
        self.layout_hints.push(hint);
        Ok(())
    }
}

fn normalize_acc_descr(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        out.push(ch);
        if ch == '\n' {
            while chars.peek().is_some_and(|&c| is_space_char(c)) {
                chars.next();
            }
        }
    }
    out
}

/// Mermaid's populateDb: every group, then services, junctions, edges, and alignments.
pub fn populate(ast: ArchitectureAst, db: &mut ArchitectureDb) -> Result<(), PeleError> {
    if let Some(descr) = ast.acc_descr
        && !descr.is_empty()
    {
        db.acc_descr = Some(normalize_acc_descr(&descr));
    }
    if let Some(title) = ast.acc_title
        && !title.is_empty()
    {
        db.acc_title = Some(title.trim_start_matches(is_space_char).to_string());
    }
    if let Some(title) = ast.title
        && !title.is_empty()
    {
        db.title = Some(title);
    }
    for g in ast.groups {
        db.add_group(ArchGroup {
            id: g.id,
            icon: g.icon,
            title: g.title,
            in_group: g.in_group,
        })?;
    }
    for s in ast.services {
        db.add_service(ArchService {
            id: s.id,
            icon: s.icon,
            icon_text: s.icon_text,
            title: s.title,
            in_group: s.in_group,
        })?;
    }
    for j in ast.junctions {
        db.add_junction(ArchJunction {
            id: j.id,
            in_group: j.in_group,
        })?;
    }
    for e in ast.edges {
        db.add_edge(ArchEdge {
            lhs_id: e.lhs_id,
            lhs_dir: e.lhs_dir,
            lhs_into: e.lhs_into,
            lhs_group: e.lhs_group,
            rhs_id: e.rhs_id,
            rhs_dir: e.rhs_dir,
            rhs_into: e.rhs_into,
            rhs_group: e.rhs_group,
            title: e.title,
        })?;
    }
    for a in ast.alignments {
        db.add_layout_hint(ArchLayoutHint {
            direction: a.direction,
            members: a.members,
        })?;
    }
    Ok(())
}
