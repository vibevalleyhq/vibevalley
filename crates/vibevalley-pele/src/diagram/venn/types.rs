use indexmap::IndexMap;

/// A set (one id) or an overlap of sets (two or more sorted ids), with its relative area.
#[derive(Debug, Clone, PartialEq)]
pub struct VennSubset {
    pub sets: Vec<String>,
    pub size: f64,
    pub label: Option<String>,
}

/// A line of text shown inside the region of the given sets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VennText {
    pub sets: Vec<String>,
    pub id: String,
    pub label: Option<String>,
}

/// Targets are the sorted ids of a set or overlap, or the id of a text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VennStyle {
    pub targets: Vec<String>,
    pub styles: IndexMap<String, String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct VennModel {
    pub title: Option<String>,
    pub subsets: Vec<VennSubset>,
    pub text_nodes: Vec<VennText>,
    pub styles: Vec<VennStyle>,
}
