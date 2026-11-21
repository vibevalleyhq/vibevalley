use crate::detect::DiagramType;
use crate::error::{ErrorCode, PeleError};

use super::outline::{NodeShape, OutlineDb};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MindmapNode {
    pub id: usize,
    pub node_id: String,
    pub level: isize,
    pub descr: String,
    pub shape: NodeShape,
    /// Indices into `MindmapModel::nodes`.
    pub children: Vec<usize>,
    pub is_root: bool,
    pub section: Option<usize>,
    pub class: Option<String>,
    pub icon: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MindmapModel {
    pub title: Option<String>,
    /// Nodes in source (depth-first) order. The first node is the root.
    pub nodes: Vec<MindmapNode>,
}

const SECTIONS: usize = 11;

pub struct MindmapDb {
    title: Option<String>,
    nodes: Vec<MindmapNode>,
    base_level: isize,
    open: Vec<usize>,
}

impl MindmapDb {
    pub fn new(title: Option<String>) -> Self {
        Self {
            title,
            nodes: Vec::new(),
            base_level: 0,
            open: Vec::new(),
        }
    }

    pub fn finish(self) -> MindmapModel {
        MindmapModel {
            title: self.title,
            nodes: self.nodes,
        }
    }
}

impl OutlineDb for MindmapDb {
    fn add_node(&mut self, raw_level: usize, id: String, descr: String, node_type: NodeShape, _shape_data: Option<String>) -> Result<(), PeleError> {
        let is_root = self.nodes.is_empty();
        if is_root {
            self.base_level = raw_level as isize;
        }
        let level = raw_level as isize - self.base_level;

        let mut depth = self.open.len();
        while depth > 0 && self.nodes[self.open[depth - 1]].level >= level {
            depth -= 1;
        }
        let parent_idx = if depth > 0 { Some(self.open[depth - 1]) } else { None };
        if parent_idx.is_none() && !is_root {
            return Err(PeleError::new(
                format!("There can be only one root. No parent could be found for (\"{descr}\")"),
                ErrorCode::Semantic,
            )
            .with_diagram_type(DiagramType::Mindmap));
        }
        let new_id = self.nodes.len();
        let section = parent_idx.and_then(|p| {
            let parent = &self.nodes[p];
            if parent.is_root {
                Some(parent.children.len() % SECTIONS)
            } else {
                parent.section
            }
        });
        if let Some(p) = parent_idx {
            self.nodes[p].children.push(new_id);
        }
        self.nodes.push(MindmapNode {
            id: new_id,
            node_id: id,
            level,
            descr,
            shape: node_type,
            children: Vec::new(),
            is_root,
            section,
            class: None,
            icon: None,
        });
        self.open.truncate(depth);
        self.open.push(new_id);
        Ok(())
    }

    fn decorate_node(&mut self, icon: Option<String>, class: Option<String>) {
        let Some(node) = self.nodes.last_mut() else {
            return;
        };
        if let Some(ic) = icon
            && !ic.is_empty()
        {
            node.icon = Some(ic);
        }
        if let Some(cl) = class
            && !cl.is_empty()
        {
            node.class = Some(cl);
        }
    }
}
