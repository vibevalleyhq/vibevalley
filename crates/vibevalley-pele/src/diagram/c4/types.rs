use indexmap::IndexMap;

/// A `$key="value"` named argument in C4 statements.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct C4Named {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum C4Attr {
    Positional(String),
    Named(C4Named),
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct C4Element {
    pub alias: String,
    pub label: String,
    pub alias_attr: Option<C4Named>,
    pub label_attr: Option<C4Named>,
    /// Index into `C4Db::boundaries`, or `None` for the top-level `global` boundary.
    pub parent: Option<usize>,
    pub elem_type: Option<String>,
    pub descr: Option<String>,
    pub techn: Option<String>,
    pub sprite: Option<String>,
    pub tags: Option<String>,
    pub link: Option<String>,
    pub bg_color: Option<String>,
    pub font_color: Option<String>,
    pub border_color: Option<String>,
    pub shadowing: Option<String>,
    pub shape: Option<String>,
    pub legend_text: Option<String>,
    pub legend_sprite: Option<String>,
    /// Named arguments that set no known field.
    pub extra: IndexMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct C4Shape {
    /// Mermaid's `typeC4Shape`: `person`, `external_system_db`, `container_queue`, etc.
    pub kind: String,
    pub el: C4Element,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct C4Boundary {
    /// Set on deployment nodes: `"node"`, `"nodeL"`, or `"nodeR"`.
    pub node_type: Option<String>,
    pub el: C4Element,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum C4RelKind {
    Rel,
    BiRel,
    RelU,
    RelD,
    RelL,
    RelR,
    RelB,
}

impl C4RelKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Rel => "rel",
            Self::BiRel => "birel",
            Self::RelU => "rel_u",
            Self::RelD => "rel_d",
            Self::RelL => "rel_l",
            Self::RelR => "rel_r",
            Self::RelB => "rel_b",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct C4Rel {
    pub rel_type: C4RelKind,
    pub from: String,
    pub to: String,
    pub label: String,
    pub from_attr: Option<C4Named>,
    pub to_attr: Option<C4Named>,
    pub label_attr: Option<C4Named>,
    pub techn: Option<String>,
    pub descr: Option<String>,
    pub sprite: Option<String>,
    pub tags: Option<String>,
    pub link: Option<String>,
    pub text_color: Option<String>,
    pub line_color: Option<String>,
    pub offset_x: Option<f64>,
    pub offset_y: Option<f64>,
    pub extra: IndexMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum C4ElementRef {
    Shape(usize),
    Boundary(usize),
}
