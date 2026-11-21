use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;

use crate::detect::DiagramType;
use crate::error::{ErrorCode, PeleError};

use super::types::{Block, BlockClassDef, Statement};

const MAX_SPACES: usize = 100_000;

pub fn type_str_to_type(type_str: Option<&str>) -> &'static str {
    match type_str {
        Some("[]") => "square",
        Some("()") => "round",
        Some("(())") => "circle",
        Some(">]") => "rect_left_inv_arrow",
        Some("{}") => "diamond",
        Some("{{}}") => "hexagon",
        Some("([])") => "stadium",
        Some("[[]]") => "subroutine",
        Some("[()]") => "cylinder",
        Some("((()))") => "doublecircle",
        Some("[//]") => "lean_right",
        Some("[\\\\]") => "lean_left",
        Some("[/\\]") => "trapezoid",
        Some("[\\/]") => "inv_trapezoid",
        Some("<[]>") => "block_arrow",
        _ => "na",
    }
}

pub fn edge_str_to_edge_data(type_str: &str) -> &'static str {
    match type_str.trim().as_bytes().last() {
        Some(b'x') => "arrow_cross",
        Some(b'o') => "arrow_circle",
        Some(b'>') => "arrow_point",
        _ => "",
    }
}

pub fn edge_str_to_edge_start_data(type_str: &str) -> &'static str {
    match type_str.trim().as_bytes().first() {
        Some(b'x') => "arrow_cross",
        Some(b'o') => "arrow_circle",
        Some(b'<') => "arrow_point",
        _ => "arrow_open",
    }
}

pub fn edge_str_to_thickness(type_str: &str) -> &'static str {
    if type_str.contains("==") { "thick" } else { "normal" }
}

pub fn edge_str_to_pattern(type_str: &str) -> &'static str {
    if type_str.contains(".-") { "dotted" } else { "solid" }
}

struct Frame {
    list: Vec<Block>,
    at: usize,
    parent_idx: usize,
    children: Vec<usize>,
    columns: f64,
}

fn make_frame(statements: Vec<Statement>, parent_idx: usize) -> Frame {
    let mut list = Vec::new();
    for stmt in statements {
        match stmt {
            Statement::Single(b) => list.push(*b),
            Statement::Chain(mut vec) => list.append(&mut vec),
        }
    }
    let mut columns = -1.0;
    for block in &list {
        if block.block_type.as_deref() == Some("column-setting") {
            columns = block.columns.unwrap_or(-1.0);
            break;
        }
    }
    Frame {
        list,
        at: 0,
        parent_idx,
        children: Vec::new(),
        columns,
    }
}

#[derive(Debug, Clone)]
pub struct BlockDb {
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    /// Arena storing root at index 0 followed by all blocks and space copies.
    pub nodes: Vec<Block>,
    pub edges: Vec<Block>,
    pub classes: IndexMap<String, BlockClassDef>,
    /// Maps block id -> index in `nodes`. Root is deliberately kept out so a block named `root` works.
    pub by_id: IndexMap<String, usize>,
    pub warnings: Vec<String>,
    pending: HashSet<String>,
    edge_count: HashMap<String, usize>,
    ids: usize,
    colors: usize,
    spaces: usize,
}

impl Default for BlockDb {
    fn default() -> Self {
        Self::new()
    }
}

impl BlockDb {
    pub fn new() -> Self {
        let root = Block {
            id: "root".to_string(),
            has_id: true,
            block_type: Some("composite".to_string()),
            columns: Some(-1.0),
            ..Block::default()
        };
        Self {
            title: None,
            acc_title: None,
            acc_descr: None,
            nodes: vec![root],
            edges: Vec::new(),
            classes: IndexMap::new(),
            by_id: IndexMap::new(),
            warnings: Vec::new(),
            pending: HashSet::new(),
            edge_count: HashMap::new(),
            ids: 0,
            colors: 0,
            spaces: 0,
        }
    }

    pub fn root(&self) -> &Block {
        &self.nodes[0]
    }

    pub fn block(&self, idx: usize) -> &Block {
        &self.nodes[idx]
    }

    pub fn block_by_id(&self, id: &str) -> Option<&Block> {
        self.by_id.get(id).map(|&idx| &self.nodes[idx])
    }

    pub fn top_blocks(&self) -> Vec<&Block> {
        self.nodes[0].children.iter().map(|&idx| &self.nodes[idx]).collect()
    }

    pub fn columns_of(&self, id: &str) -> Option<f64> {
        if id == "root" {
            self.nodes[0].columns
        } else {
            self.block_by_id(id).and_then(|b| b.columns)
        }
    }

    pub fn generate_id(&mut self) -> String {
        self.ids += 1;
        format!("id-{}", self.ids)
    }

    pub fn add_style_class(&mut self, id: &str, style_attributes: &str) {
        let found = self.classes.entry(id.to_string()).or_insert_with(|| BlockClassDef {
            id: id.to_string(),
            styles: Vec::new(),
            text_styles: Vec::new(),
        });
        for attribute in style_attributes.split(',') {
            let fixed = match attribute.find(';') {
                None => attribute.trim().to_string(),
                Some(semi) => format!("{}{}", &attribute[..semi], &attribute[semi + 1..]).trim().to_string(),
            };
            if attribute.contains("color") {
                found.text_styles.push(fixed.replacen("fill", "bgFill", 1).replacen("color", "fill", 1));
            }
            found.styles.push(fixed);
        }
    }

    pub fn add_style_to_node(&mut self, id: &str, styles: &str) {
        let idx = self.named(id);
        self.nodes[idx].styles = styles.split(',').map(str::to_string).collect();
    }

    pub fn set_css_class(&mut self, item_ids: &str, css_class_name: &str) {
        for id in item_ids.split(',') {
            let idx = self.named(id.trim());
            self.nodes[idx].classes.push(css_class_name.to_string());
        }
    }

    fn named(&mut self, id: &str) -> usize {
        if let Some(&idx) = self.by_id.get(id) {
            return idx;
        }
        let idx = self.nodes.len();
        self.nodes.push(Block {
            id: id.to_string(),
            has_id: true,
            block_type: Some("na".to_string()),
            ..Block::default()
        });
        self.by_id.insert(id.to_string(), idx);
        self.pending.insert(id.to_string());
        idx
    }

    pub fn set_hierarchy(&mut self, statements: Vec<Statement>) -> Result<(), PeleError> {
        let mut stack = vec![make_frame(statements, 0)];
        while let Some(f) = stack.last_mut() {
            if f.at == f.list.len() {
                let finished = stack.pop().unwrap();
                self.nodes[finished.parent_idx].children = finished.children;
                continue;
            }
            let mut block = std::mem::take(&mut f.list[f.at]);
            f.at += 1;
            let frame_columns = f.columns;
            let frame_parent = f.parent_idx;

            if frame_columns > 0.0
                && block.block_type.as_deref() != Some("column-setting")
                && let Some(w) = block.width_in_columns
                && (w as f64) > frame_columns
            {
                let cols_display = if frame_columns.fract() == 0.0 && frame_columns.abs() < 1e16 {
                    format!("{}", frame_columns as i64)
                } else {
                    frame_columns.to_string()
                };
                self.warnings
                    .push(format!("Block {} width {w} exceeds configured column width {cols_display}", block.id));
            }

            match block.block_type.as_deref() {
                Some("classDef") => {
                    let css = block.css.as_deref().unwrap_or("");
                    self.add_style_class(&block.id, css);
                    continue;
                }
                Some("applyClass") => {
                    let cls = block.style_class.as_deref().unwrap_or("");
                    self.set_css_class(&block.id, cls);
                    continue;
                }
                Some("applyStyles") => {
                    if let Some(ref s) = block.styles_str
                        && !s.is_empty()
                    {
                        self.add_style_to_node(&block.id, s);
                    }
                    continue;
                }
                Some("column-setting") => {
                    self.nodes[frame_parent].columns = Some(block.columns.unwrap_or(-1.0));
                    continue;
                }
                Some("edge") => {
                    let count = self.edge_count.get(&block.id).copied().unwrap_or(0) + 1;
                    self.edge_count.insert(block.id.clone(), count);
                    block.id = format!("{count}-{}", block.id);
                    self.edges.push(block);
                    continue;
                }
                _ => {}
            }

            if !block.has_id {
                block.id = self.generate_id();
                block.has_id = true;
            }
            if block.label.as_deref().is_none_or(str::is_empty) {
                block.label = Some(if block.block_type.as_deref() == Some("composite") {
                    String::new()
                } else {
                    block.id.clone()
                });
            }

            let inner = std::mem::take(&mut block.raw_children.0);
            block.children.clear();

            let known_idx = self.by_id.get(&block.id).copied();
            let fresh = known_idx.is_none() || self.pending.remove(&block.id);

            let block_arena_idx = if !fresh {
                let idx = known_idx.unwrap();
                if block.block_type.as_deref() != Some("na") {
                    self.nodes[idx].block_type = block.block_type.clone();
                }
                if block.label.as_deref() != Some(block.id.as_str()) {
                    self.nodes[idx].label = block.label.clone();
                }
                if !inner.is_empty() {
                    let detached = self.nodes.len();
                    self.nodes.push(block);
                    detached
                } else {
                    idx
                }
            } else {
                if let Some(idx) = known_idx {
                    block.classes = std::mem::take(&mut self.nodes[idx].classes);
                    block.styles = std::mem::take(&mut self.nodes[idx].styles);
                }
                if block.block_type.as_deref() == Some("composite") {
                    block.color_index = Some(self.colors);
                    self.colors += 1;
                }
                if let Some(existing_idx) = known_idx {
                    self.nodes[existing_idx] = block;
                    existing_idx
                } else {
                    let new_idx = self.nodes.len();
                    self.by_id.insert(block.id.clone(), new_idx);
                    self.nodes.push(block);
                    new_idx
                }
            };

            let is_space = self.nodes[block_arena_idx].block_type.as_deref() == Some("space");
            if is_space {
                let width = self.nodes[block_arena_idx].width.unwrap_or(1);
                if width > MAX_SPACES.saturating_sub(self.spaces) {
                    return Err(
                        PeleError::new(format!("A block diagram can hold at most {MAX_SPACES} space blocks."), ErrorCode::Limit)
                            .with_diagram_type(DiagramType::Block),
                    );
                }
                self.spaces += width;
                let base_block = self.nodes[block_arena_idx].clone();
                let mut copies = Vec::with_capacity(width);
                for j in 0..width {
                    let mut copy = base_block.clone();
                    copy.id = format!("{}-{j}", base_block.id);
                    copy.children.clear();
                    copy.raw_children.0.clear();
                    let copy_idx = self.nodes.len();
                    self.by_id.insert(copy.id.clone(), copy_idx);
                    self.nodes.push(copy);
                    copies.push(copy_idx);
                }
                stack.last_mut().unwrap().children.extend(copies);
            } else if fresh {
                stack.last_mut().unwrap().children.push(block_arena_idx);
            }

            if !inner.is_empty() {
                stack.push(make_frame(inner, block_arena_idx));
            }
        }
        Ok(())
    }

    /// Validates that every container with children has a non-zero finite integer column count.
    pub fn validate_columns(&self) -> Result<(), PeleError> {
        let mut stack = vec![0usize];
        while let Some(idx) = stack.pop() {
            let b = &self.nodes[idx];
            if !b.children.is_empty() {
                let cols = b.columns.unwrap_or(-1.0);
                if cols == 0.0 || !cols.is_finite() || cols.fract() != 0.0 {
                    return Err(PeleError::new("Columns must be an integer !== 0.", ErrorCode::Semantic).with_diagram_type(DiagramType::Block));
                }
                stack.extend_from_slice(&b.children);
            }
        }
        Ok(())
    }
}
