#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Requirement {
    pub name: String,
    pub req_type: String,
    pub requirement_id: String,
    pub text: String,
    pub risk: String,
    pub verify_method: String,
    pub css_styles: Vec<String>,
    pub classes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequirementElement {
    pub name: String,
    pub elem_type: String,
    pub doc_ref: String,
    pub css_styles: Vec<String>,
    pub classes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Relation {
    pub rel_type: String,
    pub src: String,
    pub dst: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequirementClass {
    pub id: String,
    pub styles: Vec<String>,
    pub text_styles: Vec<String>,
}
