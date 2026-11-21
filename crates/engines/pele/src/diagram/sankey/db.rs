use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SankeyNode {
    pub id: String,
    pub index: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SankeyLink {
    pub source: usize,
    pub target: usize,
    pub value: f64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SankeyModel {
    pub nodes: Vec<SankeyNode>,
    pub links: Vec<SankeyLink>,
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    lookup: HashMap<String, usize>,
}

impl SankeyModel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn find_or_create_node(&mut self, id: &str) -> usize {
        if let Some(&idx) = self.lookup.get(id) {
            return idx;
        }
        let index = self.nodes.len();
        self.lookup.insert(id.to_string(), index);
        self.nodes.push(SankeyNode { id: id.to_string(), index });
        index
    }

    pub fn add_link(&mut self, source: usize, target: usize, value: f64) {
        self.links.push(SankeyLink { source, target, value });
    }
}
