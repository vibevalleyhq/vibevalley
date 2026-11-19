use std::collections::HashSet;

use indexmap::IndexMap;

use crate::detect::DiagramType;
use crate::error::{ErrorCode, PeleError};
use crate::util::chars::is_space_char;

use super::lexer::IndentHost;
use super::types::{VennModel, VennStyle, VennSubset, VennText};

/// Strips surrounding whitespace and one pair of outer double quotes.
pub fn normalize_text(text: &str) -> String {
    let trimmed = text.trim_matches(is_space_char);
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        trimmed[1..trimmed.len() - 1].to_string()
    } else {
        trimmed.to_string()
    }
}

fn normalize_ids(ids: &[String]) -> Vec<String> {
    let mut out: Vec<String> = ids.iter().map(|id| normalize_text(id)).collect();
    out.sort();
    out
}

#[derive(Debug, Default)]
pub struct VennDb {
    pub title: Option<String>,
    pub subsets: Vec<VennSubset>,
    pub text_nodes: Vec<VennText>,
    pub styles: Vec<VennStyle>,
    known: HashSet<String>,
    current: Option<Vec<String>>,
    indent: bool,
}

impl VennDb {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn into_model(self) -> VennModel {
        VennModel {
            title: self.title,
            subsets: self.subsets,
            text_nodes: self.text_nodes,
            styles: self.styles,
        }
    }

    pub fn set_diagram_title(&mut self, title: String) {
        self.title = Some(title);
    }

    pub fn add_subset_data(&mut self, ids: &[String], label: Option<&str>, size: Option<f64>) {
        let sets = normalize_ids(ids);
        self.current = Some(sets.clone());
        if sets.len() == 1 {
            self.known.insert(sets[0].clone());
        }
        let default_size = 10.0 / ((ids.len() as f64).powi(2));
        self.subsets.push(VennSubset {
            sets,
            size: size.unwrap_or(default_size),
            label: label.filter(|l| !l.is_empty()).map(normalize_text),
        });
    }

    pub fn add_text_data(&mut self, ids: &[String], id: &str, label: Option<&str>) {
        self.text_nodes.push(VennText {
            sets: normalize_ids(ids),
            id: normalize_text(id),
            label: label.filter(|l| !l.is_empty()).map(normalize_text),
        });
    }

    pub fn add_style_data(&mut self, ids: &[String], data: &[(String, String)]) {
        let mut styles = IndexMap::new();
        for (key, value) in data {
            let norm = if value.is_empty() { String::new() } else { normalize_text(value) };
            styles.insert(key.clone(), norm);
        }
        self.styles.push(VennStyle {
            targets: normalize_ids(ids),
            styles,
        });
    }

    pub fn validate_union_identifiers(&self, ids: &[String]) -> Result<(), PeleError> {
        let unknown: Vec<String> = ids.iter().map(|id| normalize_text(id)).filter(|id| !self.known.contains(id)).collect();
        if !unknown.is_empty() {
            return Err(PeleError::new(format!("unknown set identifier: {}", unknown.join(", ")), ErrorCode::Semantic).with_diagram_type(DiagramType::Venn));
        }
        Ok(())
    }

    pub fn current_sets(&self) -> Option<&[String]> {
        self.current.as_deref()
    }
}

impl IndentHost for VennDb {
    fn indent_mode(&self) -> bool {
        self.indent
    }

    fn set_indent_mode(&mut self, enabled: bool) {
        self.indent = enabled;
    }
}
