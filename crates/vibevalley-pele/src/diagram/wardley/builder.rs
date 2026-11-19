use std::collections::HashMap;

use indexmap::IndexMap;

use crate::detect::DiagramType;
use crate::error::{ErrorCode, PeleError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceStrategy {
    Build,
    Buy,
    Outsource,
    Market,
}

impl SourceStrategy {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Build => "build",
            Self::Buy => "buy",
            Self::Outsource => "outsource",
            Self::Market => "market",
        }
    }

    pub fn from_str_opt(s: &str) -> Option<Self> {
        match s {
            "build" => Some(Self::Build),
            "buy" => Some(Self::Buy),
            "outsource" => Some(Self::Outsource),
            "market" => Some(Self::Market),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flow {
    Forward,
    Backward,
    Bidirectional,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WardleyNodeClass {
    Anchor,
    Component,
    PipelineComponent,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WardleyCoord {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WardleySize {
    pub width: f64,
    pub height: f64,
}

/// Coordinates are percentages: `x` is evolution, `y` is visibility.
#[derive(Debug, Clone, PartialEq)]
pub struct WardleyNode {
    pub id: String,
    pub label: String,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub class_name: Option<WardleyNodeClass>,
    pub label_offset_x: Option<f64>,
    pub label_offset_y: Option<f64>,
    pub in_pipeline: bool,
    pub is_pipeline_parent: bool,
    pub inertia: Option<bool>,
    pub source_strategy: Option<SourceStrategy>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WardleyLink {
    pub source: String,
    pub target: String,
    pub dashed: bool,
    pub label: Option<String>,
    pub flow: Option<Flow>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WardleyTrend {
    pub node_id: String,
    pub target_x: f64,
    pub target_y: f64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WardleyPipeline {
    pub node_id: String,
    pub component_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WardleyAnnotation {
    pub number: f64,
    pub coordinates: Vec<WardleyCoord>,
    pub text: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WardleyNote {
    pub text: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WardleyForce {
    pub name: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct WardleyAxesConfig {
    pub x_label: Option<String>,
    pub y_label: Option<String>,
    pub stages: Option<Vec<String>>,
    /// Right edge of each stage, from 0 to 1.
    pub stage_boundaries: Option<Vec<f64>>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct WardleyBuildResult {
    pub nodes: Vec<WardleyNode>,
    pub links: Vec<WardleyLink>,
    pub trends: Vec<WardleyTrend>,
    pub pipelines: Vec<WardleyPipeline>,
    pub annotations: Vec<WardleyAnnotation>,
    pub notes: Vec<WardleyNote>,
    pub accelerators: Vec<WardleyForce>,
    pub deaccelerators: Vec<WardleyForce>,
    pub annotations_box: Option<WardleyCoord>,
    pub axes: WardleyAxesConfig,
    pub size: Option<WardleySize>,
}

#[derive(Debug, Default)]
pub struct WardleyBuilder {
    nodes: IndexMap<String, WardleyNode>,
    labels: Option<HashMap<String, String>>,
    links: Vec<WardleyLink>,
    trends: IndexMap<String, WardleyTrend>,
    pipelines: IndexMap<String, WardleyPipeline>,
    annotations: Vec<WardleyAnnotation>,
    notes: Vec<WardleyNote>,
    accelerators: Vec<WardleyForce>,
    deaccelerators: Vec<WardleyForce>,
    annotations_box: Option<WardleyCoord>,
    axes: WardleyAxesConfig,
    size: Option<WardleySize>,
}

impl WardleyBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Re-adding a node keeps its previous class, label offsets, and pipeline flags unless overridden.
    pub fn add_node(&mut self, node: WardleyNode) {
        let merged = match self.nodes.get(&node.id) {
            Some(existing) => WardleyNode {
                id: node.id.clone(),
                label: node.label,
                x: node.x.or(existing.x),
                y: node.y.or(existing.y),
                class_name: node.class_name.or(existing.class_name),
                label_offset_x: node.label_offset_x.or(existing.label_offset_x),
                label_offset_y: node.label_offset_y.or(existing.label_offset_y),
                in_pipeline: node.in_pipeline || existing.in_pipeline,
                is_pipeline_parent: node.is_pipeline_parent || existing.is_pipeline_parent,
                inertia: node.inertia,
                source_strategy: node.source_strategy,
            },
            None => node,
        };
        self.nodes.insert(merged.id.clone(), merged);
        self.labels = None;
    }

    pub fn add_link(&mut self, link: WardleyLink) {
        self.links.push(link);
    }

    pub fn add_trend(&mut self, trend: WardleyTrend) {
        self.trends.insert(trend.node_id.clone(), trend);
    }

    pub fn start_pipeline(&mut self, node_id: &str) {
        self.pipelines.insert(
            node_id.to_string(),
            WardleyPipeline {
                node_id: node_id.to_string(),
                component_ids: Vec::new(),
            },
        );
        if let Some(node) = self.nodes.get_mut(node_id) {
            node.is_pipeline_parent = true;
        }
    }

    pub fn add_pipeline_component(&mut self, pipeline_node_id: &str, component_id: &str) {
        if let Some(p) = self.pipelines.get_mut(pipeline_node_id) {
            p.component_ids.push(component_id.to_string());
        }
        if let Some(node) = self.nodes.get_mut(component_id) {
            node.in_pipeline = true;
        }
    }

    pub fn add_annotation(&mut self, annotation: WardleyAnnotation) {
        self.annotations.push(annotation);
    }

    pub fn add_note(&mut self, note: WardleyNote) {
        self.notes.push(note);
    }

    pub fn add_accelerator(&mut self, accelerator: WardleyForce) {
        self.accelerators.push(accelerator);
    }

    pub fn add_deaccelerator(&mut self, deaccelerator: WardleyForce) {
        self.deaccelerators.push(deaccelerator);
    }

    pub fn set_annotations_box(&mut self, x: f64, y: f64) {
        self.annotations_box = Some(WardleyCoord { x, y });
    }

    pub fn set_axes(&mut self, partial: WardleyAxesConfig) {
        if partial.x_label.is_some() {
            self.axes.x_label = partial.x_label;
        }
        if partial.y_label.is_some() {
            self.axes.y_label = partial.y_label;
        }
        if partial.stages.is_some() {
            self.axes.stages = partial.stages;
        }
        if partial.stage_boundaries.is_some() {
            self.axes.stage_boundaries = partial.stage_boundaries;
        }
    }

    pub fn set_size(&mut self, width: f64, height: f64) {
        self.size = Some(WardleySize { width, height });
    }

    pub fn get_node(&self, id: &str) -> Option<&WardleyNode> {
        self.nodes.get(id)
    }

    pub fn resolve_node_id(&mut self, name: &str) -> String {
        if self.nodes.contains_key(name) {
            return name.to_string();
        }
        let labels = self.labels.get_or_insert_with(|| {
            let mut map = HashMap::new();
            for (id, node) in &self.nodes {
                map.entry(node.label.clone()).or_insert_with(|| id.clone());
            }
            map
        });
        labels.get(name).cloned().unwrap_or_else(|| name.to_string())
    }

    pub fn build(self) -> Result<WardleyBuildResult, PeleError> {
        let mut nodes = Vec::with_capacity(self.nodes.len());
        for (_, node) in self.nodes {
            if node.x.is_none() || node.y.is_none() {
                return Err(
                    PeleError::new(format!("Node \"{}\" is missing coordinates", node.label), ErrorCode::Semantic).with_diagram_type(DiagramType::Wardley)
                );
            }
            nodes.push(node);
        }
        Ok(WardleyBuildResult {
            nodes,
            links: self.links,
            trends: self.trends.into_values().collect(),
            pipelines: self.pipelines.into_values().collect(),
            annotations: self.annotations,
            notes: self.notes,
            accelerators: self.accelerators,
            deaccelerators: self.deaccelerators,
            annotations_box: self.annotations_box,
            axes: self.axes,
            size: self.size,
        })
    }
}
