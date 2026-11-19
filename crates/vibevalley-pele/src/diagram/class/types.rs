use indexmap::IndexSet;

use super::members::ClassMember;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineType {
    Line,
    DottedLine,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelationType {
    Aggregation,
    Extension,
    Composition,
    Dependency,
    Lollipop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelationEnd {
    Type(RelationType),
    None,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelationSpec {
    pub type1: RelationEnd,
    pub type2: RelationEnd,
    pub line_type: LineType,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassNode {
    pub id: String,
    pub generic_type: String,
    pub label: String,
    pub css_classes: String,
    pub methods: Vec<ClassMember>,
    pub members: Vec<ClassMember>,
    pub annotations: Vec<String>,
    pub styles: Vec<String>,
    pub parent: Option<String>,
    pub link: Option<String>,
    pub link_target: Option<String>,
    pub have_callback: bool,
    pub tooltip: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassRelation {
    pub id1: String,
    pub id2: String,
    pub relation_title1: String,
    pub relation_title2: String,
    pub title: Option<String>,
    pub relation: RelationSpec,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassNote {
    pub id: String,
    pub class: Option<String>,
    pub text: String,
    pub index: usize,
    pub parent: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassInterface {
    pub id: String,
    pub label: String,
    pub class_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NamespaceNode {
    pub id: String,
    pub label: String,
    pub classes: IndexSet<String>,
    pub notes: IndexSet<String>,
    pub children: IndexSet<String>,
    pub parent: Option<String>,
    /// False for ancestors created on the way to a dotted name such as `A.B.C`.
    pub explicit: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StyleClass {
    pub id: String,
    pub styles: Vec<String>,
    pub text_styles: Vec<String>,
}
