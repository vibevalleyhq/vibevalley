use indexmap::IndexMap;

use crate::util::yaml::YamlValue;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LabelType {
    Text,
    String,
    Markdown,
}

impl LabelType {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::String => "string",
            Self::Markdown => "markdown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlowText {
    pub text: String,
    pub label_type: LabelType,
}

/// Source span matching Jison's numbering: lines start at 1, columns at 0.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Loc {
    pub first_line: usize,
    pub first_column: usize,
    pub last_line: usize,
    pub last_column: usize,
    pub start_byte: usize,
}

pub type Metadata = IndexMap<String, YamlValue>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum VertexKind {
    Tool,
    Action,
    Input,
    Refdoc,
    Decision,
    Connector,
    Task,
}

impl VertexKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Tool => "tool",
            Self::Action => "action",
            Self::Input => "input",
            Self::Refdoc => "refdoc",
            Self::Decision => "decision",
            Self::Connector => "connector",
            Self::Task => "task",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EdgeSemantic {
    Sequence,
    Reference,
    Failure,
}

impl EdgeSemantic {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Sequence => "sequence",
            Self::Reference => "reference",
            Self::Failure => "failure",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentNode {
    pub id: String,
    pub text: Option<String>,
    pub label_type: LabelType,
    pub node_type: Option<String>,
    pub styles: Vec<String>,
    pub classes: Vec<String>,
    pub dir: Option<String>,
    pub props: Option<IndexMap<String, String>>,
    pub link: Option<String>,
    pub link_target: Option<String>,
    pub metadata: Option<Metadata>,
    pub is_connector: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentEdge {
    pub start: String,
    pub end: String,
    pub edge_type: Option<String>,
    pub text: String,
    pub label_type: LabelType,
    pub stroke: Option<String>,
    pub edge_semantic: Option<EdgeSemantic>,
    pub length: Option<usize>,
    pub style: Option<Vec<String>>,
    pub classes: Vec<String>,
    pub id: Option<String>,
    pub is_user_defined_id: bool,
    pub interpolate: Option<String>,
    pub animate: Option<YamlValue>,
    pub animation: Option<YamlValue>,
    pub metadata: Option<Metadata>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentClassDef {
    pub id: String,
    pub styles: Vec<String>,
    pub text_styles: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentSubgraph {
    pub id: String,
    pub nodes: Vec<String>,
    pub title: String,
    pub classes: Vec<String>,
    pub dir: Option<String>,
    pub label_type: LabelType,
    pub subgraph_type: &'static str,
    pub metadata: Option<Metadata>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkInfo {
    pub link_type: String,
    pub stroke: String,
    pub length: Option<usize>,
    pub edge_semantic: Option<EdgeSemantic>,
    pub text: Option<FlowText>,
    pub id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocItem {
    Single(String),
    List(Vec<String>),
    Dir(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ElementPosition {
    pub start_line: usize,
    pub start_column: usize,
    pub end_line: usize,
    pub end_column: usize,
    pub start_index: usize,
    pub end_index: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StatementType {
    Vertex,
    Edge,
    Subgraph,
    Connector,
    Attachment,
}

impl StatementType {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Vertex => "vertex",
            Self::Edge => "edge",
            Self::Subgraph => "subgraph",
            Self::Connector => "connector",
            Self::Attachment => "attachment",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ElementMapping {
    pub id: String,
    pub stmt_type: StatementType,
    pub position: ElementPosition,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DiagnosticId {
    ShapeUnsupported,
    ShapeRemoved,
    EdgeOperatorUnsupported,
    ReferenceEdgeLabelRejected,
    ConnectorRefUnresolved,
    ConnectorRefNotAConnector,
    MetadataKeyMisapplied,
    DuplicateIdNode,
    ReservedSyntheticId,
    ContainmentViolation,
    EdgeSemanticContradiction,
    FlowNoInput,
}

impl DiagnosticId {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ShapeUnsupported => "SHAPE_UNSUPPORTED",
            Self::ShapeRemoved => "SHAPE_REMOVED",
            Self::EdgeOperatorUnsupported => "EDGE_OPERATOR_UNSUPPORTED",
            Self::ReferenceEdgeLabelRejected => "REFERENCE_EDGE_LABEL_REJECTED",
            Self::ConnectorRefUnresolved => "CONNECTOR_REF_UNRESOLVED",
            Self::ConnectorRefNotAConnector => "CONNECTOR_REF_NOT_A_CONNECTOR",
            Self::MetadataKeyMisapplied => "METADATA_KEY_MISAPPLIED",
            Self::DuplicateIdNode => "DUPLICATE_ID_NODE",
            Self::ReservedSyntheticId => "RESERVED_SYNTHETIC_ID",
            Self::ContainmentViolation => "CONTAINMENT_VIOLATION",
            Self::EdgeSemanticContradiction => "EDGE_SEMANTIC_CONTRADICTION",
            Self::FlowNoInput => "FLOW_NO_INPUT",
        }
    }

    pub const ALL: [Self; 12] = [
        Self::ShapeUnsupported,
        Self::ShapeRemoved,
        Self::EdgeOperatorUnsupported,
        Self::ReferenceEdgeLabelRejected,
        Self::ConnectorRefUnresolved,
        Self::ConnectorRefNotAConnector,
        Self::MetadataKeyMisapplied,
        Self::DuplicateIdNode,
        Self::ReservedSyntheticId,
        Self::ContainmentViolation,
        Self::EdgeSemanticContradiction,
        Self::FlowNoInput,
    ];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DiagnosticSeverity {
    Warning,
    Error,
}

impl DiagnosticSeverity {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Warning => "warning",
            Self::Error => "error",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    pub id: DiagnosticId,
    pub severity: DiagnosticSeverity,
    pub message: String,
    pub node_id: Option<String>,
    pub edge_id: Option<String>,
    pub position: Option<ElementPosition>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SemanticVertex {
    pub id: String,
    pub label: Option<String>,
    pub shape: Option<String>,
    pub vertex_kind: VertexKind,
    pub metadata: Option<Metadata>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SemanticEdge {
    pub start: String,
    pub end: String,
    pub id: Option<String>,
    pub label: Option<String>,
    pub edge_type: Option<String>,
    pub stroke: Option<String>,
    pub edge_semantic: Option<EdgeSemantic>,
    pub length: Option<usize>,
    pub metadata: Option<Metadata>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SemanticSubgraph {
    pub id: String,
    pub subgraph_type: &'static str,
    pub title: String,
    pub nodes: Vec<String>,
    pub metadata: Option<Metadata>,
    pub direction: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SemanticConnector {
    pub id: String,
    pub title: Option<String>,
    pub metadata: Option<Metadata>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SemanticModel {
    pub direction: Option<String>,
    pub vertices: Vec<SemanticVertex>,
    pub edges: Vec<SemanticEdge>,
    pub subgraphs: Vec<SemanticSubgraph>,
    pub connectors: Vec<SemanticConnector>,
    pub diagnostics: Vec<Diagnostic>,
}
