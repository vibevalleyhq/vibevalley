use indexmap::IndexMap;

use crate::util::yaml::YamlValue;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LabelType {
    Text,
    String,
    Markdown,
}

impl LabelType {
    pub fn from_opt(raw: Option<&str>) -> Self {
        match raw {
            Some("text") => Self::Text,
            Some("string") => Self::String,
            _ => Self::Markdown,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlowText {
    pub text: String,
    pub label_type: LabelType,
}

#[derive(Debug, Clone)]
pub struct FlowNode {
    pub id: String,
    pub text: Option<String>,
    pub label_type: LabelType,
    pub shape_type: Option<String>,
    pub styles: Vec<String>,
    pub classes: Vec<String>,
    pub dir: Option<String>,
    pub props: IndexMap<String, String>,
    pub link: Option<String>,
    pub link_target: Option<String>,
    pub icon: Option<String>,
    pub form: Option<String>,
    pub pos: Option<String>,
    pub img: Option<String>,
    pub constraint: Option<String>,
    pub asset_width: Option<f64>,
    pub asset_height: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct FlowEdge {
    pub start: String,
    pub end: String,
    pub edge_type: Option<String>,
    pub text: String,
    pub label_type: LabelType,
    pub stroke: Option<String>,
    pub length: Option<i32>,
    pub style: Option<Vec<String>>,
    pub classes: Vec<String>,
    pub id: Option<String>,
    pub is_user_defined_id: bool,
    pub interpolate: Option<String>,
    pub animate: Option<bool>,
    pub animation: Option<String>,
}

#[derive(Debug, Clone)]
pub struct FlowClassDef {
    pub id: String,
    pub styles: Vec<String>,
    pub text_styles: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct FlowSubgraph {
    pub id: String,
    pub nodes: Vec<String>,
    pub title: String,
    pub classes: Vec<String>,
    pub dir: Option<String>,
    pub label_type: LabelType,
    pub metadata: Option<IndexMap<String, YamlValue>>,
}

#[derive(Debug, Clone)]
pub struct FlowLinkInfo {
    pub link_type: String,
    pub stroke: String,
    pub length: Option<i32>,
    pub text: Option<FlowText>,
    pub id: Option<String>,
}

#[derive(Debug, Clone)]
pub enum DocItem {
    Single(String),
    Many(Vec<String>),
    Dir(String),
}
