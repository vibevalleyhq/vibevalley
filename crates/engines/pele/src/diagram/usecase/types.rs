use indexmap::IndexMap;

pub type Span = (usize, usize);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LabelType {
    Text,
    Markdown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActorType {
    Normal,
    Hollow,
    Awesome,
    Icon,
}

impl ActorType {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Hollow => "hollow",
            Self::Awesome => "awesome",
            Self::Icon => "icon",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UseCaseShape {
    Ellipse,
    Rect,
}

impl UseCaseShape {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ellipse => "ellipse",
            Self::Rect => "rect",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoundaryType {
    Rect,
    Package,
}

impl BoundaryType {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Rect => "rect",
            Self::Package => "package",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelationshipType {
    Association,
    Include,
    Extend,
    Generalization,
}

impl RelationshipType {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Association => "association",
            Self::Include => "include",
            Self::Extend => "extend",
            Self::Generalization => "generalization",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Animation {
    Fast,
    Slow,
}

impl Animation {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Fast => "fast",
            Self::Slow => "slow",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    TB,
    TD,
    BT,
    RL,
    LR,
}

impl Direction {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::TB => "TB",
            Self::TD => "TD",
            Self::BT => "BT",
            Self::RL => "RL",
            Self::LR => "LR",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SymbolKind {
    Actor,
    Usecase,
    Boundary,
    Json,
    Edge,
}

impl SymbolKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Actor => "actor",
            Self::Usecase => "usecase",
            Self::Boundary => "boundary",
            Self::Json => "json",
            Self::Edge => "edge",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Arrow {
    SolidArrow = 0,
    BackArrow = 1,
    LineSolid = 2,
    CircleArrow = 3,
    CrossArrow = 4,
    CircleArrowReversed = 5,
    CrossArrowReversed = 6,
}

impl Arrow {
    pub const fn is_json_allowed(self) -> bool {
        matches!(self, Self::SolidArrow | Self::BackArrow | Self::LineSolid)
    }

    pub const fn markers(self) -> (&'static str, &'static str) {
        match self {
            Self::SolidArrow => ("none", "arrow_point"),
            Self::BackArrow => ("arrow_point", "none"),
            Self::LineSolid => ("none", "none"),
            Self::CircleArrow => ("none", "arrow_circle"),
            Self::CrossArrow => ("none", "arrow_cross"),
            Self::CircleArrowReversed => ("arrow_circle", "none"),
            Self::CrossArrowReversed => ("arrow_cross", "none"),
        }
    }
}

/// Typed JSON value parsed iteratively with an explicit stack.
/// `Drop`, `Clone`, and `PartialEq` are iterative so deep nesting cannot overflow the stack.
#[derive(Debug)]
pub enum JsonValue {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<JsonValue>),
    Object(IndexMap<String, JsonValue>),
}

impl Drop for JsonValue {
    fn drop(&mut self) {
        let mut stack: Vec<JsonValue> = Vec::new();
        match self {
            Self::Array(arr) => stack.append(arr),
            Self::Object(map) => {
                for (_, v) in map.drain(..) {
                    stack.push(v);
                }
            }
            Self::Null | Self::Bool(_) | Self::Number(_) | Self::String(_) => return,
        }
        while let Some(mut val) = stack.pop() {
            match &mut val {
                Self::Array(arr) => stack.append(arr),
                Self::Object(map) => {
                    for (_, v) in map.drain(..) {
                        stack.push(v);
                    }
                }
                Self::Null | Self::Bool(_) | Self::Number(_) | Self::String(_) => {}
            }
        }
    }
}

impl Clone for JsonValue {
    fn clone(&self) -> Self {
        enum Task<'a> {
            Visit(&'a JsonValue),
            FinishArray(usize),
            FinishObject(Vec<String>),
        }
        let mut tasks: Vec<Task<'_>> = vec![Task::Visit(self)];
        let mut results: Vec<JsonValue> = Vec::new();
        while let Some(task) = tasks.pop() {
            match task {
                Task::Visit(val) => match val {
                    Self::Null => results.push(Self::Null),
                    Self::Bool(b) => results.push(Self::Bool(*b)),
                    Self::Number(n) => results.push(Self::Number(*n)),
                    Self::String(s) => results.push(Self::String(s.clone())),
                    Self::Array(arr) => {
                        tasks.push(Task::FinishArray(arr.len()));
                        for item in arr.iter().rev() {
                            tasks.push(Task::Visit(item));
                        }
                    }
                    Self::Object(map) => {
                        let keys: Vec<String> = map.keys().cloned().collect();
                        tasks.push(Task::FinishObject(keys));
                        for v in map.values().rev() {
                            tasks.push(Task::Visit(v));
                        }
                    }
                },
                Task::FinishArray(len) => {
                    let start = results.len() - len;
                    let items: Vec<JsonValue> = results.drain(start..).collect();
                    results.push(Self::Array(items));
                }
                Task::FinishObject(keys) => {
                    let start = results.len() - keys.len();
                    let mut map = IndexMap::with_capacity(keys.len());
                    for (k, v) in keys.into_iter().zip(results.drain(start..)) {
                        map.insert(k, v);
                    }
                    results.push(Self::Object(map));
                }
            }
        }
        results.pop().unwrap_or(Self::Null)
    }
}

impl PartialEq for JsonValue {
    fn eq(&self, other: &Self) -> bool {
        let mut stack: Vec<(&JsonValue, &JsonValue)> = vec![(self, other)];
        while let Some((a, b)) = stack.pop() {
            match (a, b) {
                (Self::Null, Self::Null) => {}
                (Self::Bool(x), Self::Bool(y)) if x == y => {}
                (Self::Number(x), Self::Number(y)) if x == y => {}
                (Self::String(x), Self::String(y)) if x == y => {}
                (Self::Array(x), Self::Array(y)) if x.len() == y.len() => {
                    for (xi, yi) in x.iter().zip(y.iter()) {
                        stack.push((xi, yi));
                    }
                }
                (Self::Object(x), Self::Object(y)) if x.len() == y.len() => {
                    for (k, xv) in x {
                        let Some(yv) = y.get(k) else {
                            return false;
                        };
                        stack.push((xv, yv));
                    }
                }
                _ => return false,
            }
        }
        true
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Actor {
    pub id: String,
    pub label: String,
    pub label_type: LabelType,
    pub actor_type: ActorType,
    pub icon: Option<String>,
    pub business: bool,
    pub stereotype: Option<String>,
    pub parent_id: Option<String>,
    pub classes: Vec<String>,
    pub styles: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UseCase {
    pub id: String,
    pub label: String,
    pub label_type: LabelType,
    pub shape: UseCaseShape,
    pub business: bool,
    pub stereotype: Option<String>,
    pub parent_id: Option<String>,
    pub classes: Vec<String>,
    pub styles: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemBoundary {
    pub id: String,
    pub label: String,
    pub label_type: LabelType,
    pub boundary_type: BoundaryType,
    pub members: Vec<String>,
    pub classes: Vec<String>,
    pub styles: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Relationship {
    pub id: String,
    pub explicit_id: bool,
    pub source: String,
    pub target: String,
    pub rel_type: RelationshipType,
    pub arrow_type: Arrow,
    pub label: Option<String>,
    pub label_type: Option<LabelType>,
    pub minlen: i32,
    pub classes: Vec<String>,
    pub styles: Vec<String>,
    pub animate: bool,
    pub animation: Option<Animation>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsecaseNote {
    pub id: String,
    pub target: String,
    pub label: String,
    pub label_type: LabelType,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UsecaseJsonNode {
    pub id: String,
    pub value: IndexMap<String, JsonValue>,
    /// Keys of each object in the order they were written, by JSON Pointer.
    pub property_order: IndexMap<String, Vec<String>>,
    pub classes: Vec<String>,
    pub styles: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassDef {
    pub id: String,
    pub styles: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetadataOccurrence {
    pub key: String,
    pub span: Span,
    pub key_span: Span,
    pub value_span: Span,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeOccurrence {
    pub id: String,
    pub span: Span,
    pub id_span: Span,
    pub label_span: Option<Span>,
    pub defines: bool,
    pub stereotype_span: Option<Span>,
    pub metadata: Option<Vec<MetadataOccurrence>>,
    pub class_spans: Option<Vec<Span>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EdgeOccurrence {
    pub id: String,
    pub span: Span,
    pub label_span: Option<Span>,
    pub id_span: Option<Span>,
    pub metadata: Option<Vec<MetadataOccurrence>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatementKind {
    Node,
    Edge,
    Group,
    Note,
    Json,
    Metadata,
    EdgeMetadata,
    ClassDef,
    ClassAssign,
    Style,
    Direction,
    AccTitle,
    AccDescr,
    Comment,
    Blank,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphStatement {
    pub kind: StatementKind,
    pub span: Span,
    pub nodes: Option<Vec<NodeOccurrence>>,
    pub edges: Option<Vec<EdgeOccurrence>>,
    pub group: Option<String>,
    pub id_span: Option<Span>,
    pub title_span: Option<Span>,
    pub end_span: Option<Span>,
    pub ref_id: Option<String>,
    pub ref_span: Option<Span>,
    pub children: Option<Vec<GraphStatement>>,
    pub metadata: Option<Vec<MetadataOccurrence>>,
    pub class_spans: Option<Vec<Span>>,
}

impl GraphStatement {
    pub fn new(kind: StatementKind, span: Span) -> Self {
        Self {
            kind,
            span,
            nodes: None,
            edges: None,
            group: None,
            id_span: None,
            title_span: None,
            end_span: None,
            ref_id: None,
            ref_span: None,
            children: None,
            metadata: None,
            class_spans: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct UsecaseModel {
    pub actors: IndexMap<String, Actor>,
    pub use_cases: IndexMap<String, UseCase>,
    pub system_boundaries: IndexMap<String, SystemBoundary>,
    pub relationships: Vec<Relationship>,
    pub notes: IndexMap<String, UsecaseNote>,
    pub json_nodes: IndexMap<String, UsecaseJsonNode>,
    pub class_defs: IndexMap<String, ClassDef>,
    pub direction: Direction,
    pub title: Option<String>,
    pub acc_title: String,
    pub acc_descr: String,
    pub acc_description: String,
    pub source: String,
    pub header_span: Span,
    pub statements: Vec<GraphStatement>,
}

impl Default for UsecaseModel {
    fn default() -> Self {
        Self::empty()
    }
}

impl UsecaseModel {
    pub fn empty() -> Self {
        Self {
            actors: IndexMap::new(),
            use_cases: IndexMap::new(),
            system_boundaries: IndexMap::new(),
            relationships: Vec::new(),
            notes: IndexMap::new(),
            json_nodes: IndexMap::new(),
            class_defs: IndexMap::new(),
            direction: Direction::LR,
            title: None,
            acc_title: String::new(),
            acc_descr: String::new(),
            acc_description: String::new(),
            source: String::new(),
            header_span: (0, 0),
            statements: Vec::new(),
        }
    }
}
