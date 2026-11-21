use indexmap::IndexMap;

use crate::detect::DiagramType;
use crate::error::{ErrorCode, PeleError};
use crate::util::chars::is_space_char;

use super::types::{Relation, Requirement, RequirementClass, RequirementElement};

pub const REQ_TYPE_REQUIREMENT: &str = "Requirement";
pub const REQ_TYPE_FUNCTIONAL: &str = "Functional Requirement";
pub const REQ_TYPE_INTERFACE: &str = "Interface Requirement";
pub const REQ_TYPE_PERFORMANCE: &str = "Performance Requirement";
pub const REQ_TYPE_PHYSICAL: &str = "Physical Requirement";
pub const REQ_TYPE_DESIGN_CONSTRAINT: &str = "Design Constraint";

pub const RISK_LOW: &str = "Low";
pub const RISK_MEDIUM: &str = "Medium";
pub const RISK_HIGH: &str = "High";

pub const VERIFY_ANALYSIS: &str = "Analysis";
pub const VERIFY_DEMONSTRATION: &str = "Demonstration";
pub const VERIFY_INSPECTION: &str = "Inspection";
pub const VERIFY_TEST: &str = "Test";

pub const REL_CONTAINS: &str = "contains";
pub const REL_COPIES: &str = "copies";
pub const REL_DERIVES: &str = "derives";
pub const REL_SATISFIES: &str = "satisfies";
pub const REL_VERIFIES: &str = "verifies";
pub const REL_REFINES: &str = "refines";
pub const REL_TRACES: &str = "traces";

// Applying a class copies its declarations onto each node, so a short text can ask for
// hundreds of millions of copies. Past this many the diagram is refused.
const MAX_STYLE_COPIES: usize = 1_000_000;

#[derive(Debug, Clone)]
pub struct RequirementDb {
    pub direction: String,
    pub requirements: IndexMap<String, Requirement>,
    pub elements: IndexMap<String, RequirementElement>,
    pub relations: Vec<Relation>,
    pub classes: IndexMap<String, RequirementClass>,
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,

    // The grammar reports a body's fields before the requirement or element they belong to.
    new_id: String,
    new_text: String,
    new_risk: String,
    new_verify_method: String,
    new_element_type: String,
    new_doc_ref: String,
    style_copies: usize,
}

impl Default for RequirementDb {
    fn default() -> Self {
        Self::new()
    }
}

impl RequirementDb {
    pub fn new() -> Self {
        Self {
            direction: "TB".to_string(),
            requirements: IndexMap::new(),
            elements: IndexMap::new(),
            relations: Vec::new(),
            classes: IndexMap::new(),
            title: None,
            acc_title: None,
            acc_descr: None,
            new_id: String::new(),
            new_text: String::new(),
            new_risk: String::new(),
            new_verify_method: String::new(),
            new_element_type: String::new(),
            new_doc_ref: String::new(),
            style_copies: 0,
        }
    }

    fn copy_styles(style_copies: &mut usize, target: &mut Vec<String>, styles: &[String]) -> Result<(), PeleError> {
        *style_copies += styles.len();
        if *style_copies > MAX_STYLE_COPIES {
            return Err(
                PeleError::new("Requirement diagram applies too many style declarations.", ErrorCode::Limit).with_diagram_type(DiagramType::Requirement)
            );
        }
        target.extend(styles.iter().cloned());
        Ok(())
    }

    pub fn set_direction(&mut self, dir: &str) {
        self.direction = dir.to_string();
    }

    pub fn add_requirement(&mut self, name: &str, req_type: &str) {
        if !self.requirements.contains_key(name) {
            let requirement = Requirement {
                name: name.to_string(),
                req_type: req_type.to_string(),
                requirement_id: std::mem::take(&mut self.new_id),
                text: std::mem::take(&mut self.new_text),
                risk: std::mem::take(&mut self.new_risk),
                verify_method: std::mem::take(&mut self.new_verify_method),
                css_styles: Vec::new(),
                classes: vec!["default".to_string()],
            };
            self.requirements.insert(name.to_string(), requirement);
        } else {
            self.new_id.clear();
            self.new_text.clear();
            self.new_risk.clear();
            self.new_verify_method.clear();
        }
    }

    pub fn set_new_req_id(&mut self, id: String) {
        self.new_id = id;
    }

    pub fn set_new_req_text(&mut self, text: String) {
        self.new_text = text;
    }

    pub fn set_new_req_risk(&mut self, risk: String) {
        self.new_risk = risk;
    }

    pub fn set_new_req_verify_method(&mut self, verify_method: String) {
        self.new_verify_method = verify_method;
    }

    pub fn add_element(&mut self, name: &str) {
        if !self.elements.contains_key(name) {
            let element = RequirementElement {
                name: name.to_string(),
                elem_type: std::mem::take(&mut self.new_element_type),
                doc_ref: std::mem::take(&mut self.new_doc_ref),
                css_styles: Vec::new(),
                classes: vec!["default".to_string()],
            };
            self.elements.insert(name.to_string(), element);
        } else {
            self.new_element_type.clear();
            self.new_doc_ref.clear();
        }
    }

    pub fn set_new_element_type(&mut self, elem_type: String) {
        self.new_element_type = elem_type;
    }

    pub fn set_new_element_doc_ref(&mut self, doc_ref: String) {
        self.new_doc_ref = doc_ref;
    }

    pub fn add_relationship(&mut self, rel_type: &str, src: &str, dst: &str) {
        self.relations.push(Relation {
            rel_type: rel_type.to_string(),
            src: src.to_string(),
            dst: dst.to_string(),
        });
    }

    pub fn set_css_style(&mut self, ids: &[String], styles: &[String]) -> Result<(), PeleError> {
        for id in ids {
            let target = if let Some(req) = self.requirements.get_mut(id) {
                &mut req.css_styles
            } else if let Some(elem) = self.elements.get_mut(id) {
                &mut elem.css_styles
            } else {
                // Mermaid stops at the first unknown id, leaving the rest of the list unstyled.
                return Ok(());
            };
            for s in styles {
                if s.contains(',') {
                    let parts: Vec<String> = s.split(',').map(str::to_string).collect();
                    Self::copy_styles(&mut self.style_copies, target, &parts)?;
                } else {
                    Self::copy_styles(&mut self.style_copies, target, std::slice::from_ref(s))?;
                }
            }
        }
        Ok(())
    }

    pub fn set_class(&mut self, ids: &[String], class_names: &[String]) -> Result<(), PeleError> {
        for id in ids {
            let mut class_styles: Vec<Vec<String>> = Vec::with_capacity(class_names.len());
            for name in class_names {
                class_styles.push(self.classes.get(name).map(|c| c.styles.clone()).unwrap_or_default());
            }
            let (classes_vec, css_styles_vec) = if let Some(req) = self.requirements.get_mut(id) {
                (&mut req.classes, &mut req.css_styles)
            } else if let Some(elem) = self.elements.get_mut(id) {
                (&mut elem.classes, &mut elem.css_styles)
            } else {
                continue;
            };
            for (name, styles) in class_names.iter().zip(class_styles.iter()) {
                classes_vec.push(name.clone());
                if !styles.is_empty() {
                    Self::copy_styles(&mut self.style_copies, css_styles_vec, styles)?;
                }
            }
        }
        Ok(())
    }

    pub fn define_class(&mut self, ids: &[String], style: &[String]) -> Result<(), PeleError> {
        let split: Vec<String> = style.iter().flat_map(|s| s.split(',').map(str::to_string)).collect();
        for id in ids {
            let style_class = self.classes.entry(id.clone()).or_insert_with(|| RequirementClass {
                id: id.clone(),
                styles: Vec::new(),
                text_styles: Vec::new(),
            });
            for s in style {
                if s.contains("color") {
                    style_class.text_styles.push(s.replacen("fill", "bgFill", 1));
                }
                style_class.styles.push(s.clone());
            }
            for requirement in self.requirements.values_mut() {
                if requirement.classes.iter().any(|c| c == id) {
                    Self::copy_styles(&mut self.style_copies, &mut requirement.css_styles, &split)?;
                }
            }
            for element in self.elements.values_mut() {
                if element.classes.iter().any(|c| c == id) {
                    Self::copy_styles(&mut self.style_copies, &mut element.css_styles, &split)?;
                }
            }
        }
        Ok(())
    }

    pub fn set_acc_title(&mut self, text: &str) {
        self.acc_title = Some(text.trim_start_matches(is_space_char).to_string());
    }

    pub fn set_acc_description(&mut self, text: &str) {
        let mut out = String::with_capacity(text.len());
        let mut chars = text.chars().peekable();
        while let Some(ch) = chars.next() {
            out.push(ch);
            if ch == '\n' {
                while chars.peek().is_some_and(|&c| is_space_char(c)) {
                    chars.next();
                }
            }
        }
        self.acc_descr = Some(out);
    }
}
