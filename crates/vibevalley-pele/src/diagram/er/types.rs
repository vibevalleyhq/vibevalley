#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Cardinality {
    ZeroOrOne,
    ZeroOrMore,
    OneOrMore,
    OnlyOne,
    MdParent,
}

impl Cardinality {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ZeroOrOne => "ZERO_OR_ONE",
            Self::ZeroOrMore => "ZERO_OR_MORE",
            Self::OneOrMore => "ONE_OR_MORE",
            Self::OnlyOne => "ONLY_ONE",
            Self::MdParent => "MD_PARENT",
        }
    }

    pub const fn marker_name(self) -> &'static str {
        match self {
            Self::ZeroOrOne => "zero_or_one",
            Self::ZeroOrMore => "zero_or_more",
            Self::OneOrMore => "one_or_more",
            Self::OnlyOne => "only_one",
            Self::MdParent => "md_parent",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Identification {
    NonIdentifying,
    Identifying,
}

impl Identification {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NonIdentifying => "NON_IDENTIFYING",
            Self::Identifying => "IDENTIFYING",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErLabelType {
    Text,
    String,
    Markdown,
}

impl ErLabelType {
    pub fn from_opt(raw: Option<&str>) -> Self {
        match raw {
            Some("text") => Self::Text,
            Some("string") => Self::String,
            _ => Self::Markdown,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErAttribute {
    pub attr_type: String,
    pub name: String,
    pub keys: Vec<String>,
    pub comment: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAttribute {
    pub attr_type: String,
    pub name: String,
    pub keys: Option<Vec<String>>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErEntity {
    pub id: String,
    pub label: String,
    pub alias: String,
    pub attributes: Vec<ErAttribute>,
    pub css_classes: String,
    pub css_styles: Vec<String>,
}

/// `card_b` sits at `entity_a`'s end of the line and `card_a` at `entity_b`'s, as in Mermaid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RelSpec {
    pub card_a: Cardinality,
    pub rel_type: Identification,
    pub card_b: Cardinality,
}

/// `entity_a` and `entity_b` hold an entity's id, or a subgraph's id when the name was a subgraph at the time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErRelationship {
    pub entity_a: String,
    pub role_a: String,
    pub entity_b: String,
    pub rel_spec: RelSpec,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErClassDef {
    pub id: String,
    pub styles: Vec<String>,
    pub text_styles: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErSubgraph {
    pub id: String,
    pub nodes: Vec<String>,
    pub title: String,
    pub classes: Vec<String>,
    pub css_styles: Vec<String>,
    pub dir: Option<String>,
    pub label_type: ErLabelType,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocItem {
    Name(String),
    Dir(String),
}
