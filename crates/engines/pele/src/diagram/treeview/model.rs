use std::collections::HashMap;

use crate::error::{PeleError, SourceMap, locate};

use super::box_drawing::{char_to_byte_offset, line_start, preprocess_box_drawing, remap_error_lines};
use super::parser::{TreeViewAst, parse_tree_view};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeType {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeNode {
    pub id: usize,
    pub level: i32,
    pub name: String,
    pub node_type: NodeType,
    pub icon: Option<String>,
    pub css_class: Option<String>,
    pub description: Option<String>,
    pub children: Vec<TreeNode>,
}

impl Drop for TreeNode {
    fn drop(&mut self) {
        let mut stack = std::mem::take(&mut self.children);
        while let Some(mut node) = stack.pop() {
            stack.append(&mut node.children);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeViewModel {
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    pub root: TreeNode,
    pub count: usize,
}

pub struct TreeViewDb {
    pub count: usize,
    stack: Vec<TreeNode>,
}

impl Default for TreeViewDb {
    fn default() -> Self {
        Self::new()
    }
}

impl TreeViewDb {
    pub fn new() -> Self {
        let root = TreeNode {
            id: 0,
            level: -1,
            name: "/".to_string(),
            node_type: NodeType::Directory,
            icon: None,
            css_class: None,
            description: None,
            children: Vec::new(),
        };
        Self { count: 1, stack: vec![root] }
    }

    pub fn add_node(&mut self, level: i32, name: String, node_type: NodeType, css_class: Option<String>, icon: Option<String>, description: Option<String>) {
        while self.stack.len() > 1 && level <= self.stack.last().unwrap().level {
            let finished = self.stack.pop().unwrap();
            self.stack.last_mut().unwrap().children.push(finished);
        }
        let node = TreeNode {
            id: self.count,
            level,
            name,
            node_type,
            icon,
            css_class,
            description,
            children: Vec::new(),
        };
        self.count += 1;
        self.stack.push(node);
    }

    pub fn finish(mut self) -> (TreeNode, usize) {
        while self.stack.len() > 1 {
            let finished = self.stack.pop().unwrap();
            self.stack.last_mut().unwrap().children.push(finished);
        }
        (self.stack.pop().unwrap(), self.count)
    }
}

pub fn populate(ast: &TreeViewAst, db: &mut TreeViewDb) {
    for node in &ast.nodes {
        let level = node.indent.unwrap_or(0) as i32;
        let (name, node_type) = match node.name.strip_suffix('/') {
            Some(dir) => (dir.to_string(), NodeType::Directory),
            None => (node.name.clone(), NodeType::File),
        };
        let icon = node
            .icon_annotation
            .as_deref()
            .map(|raw| if raw.is_empty() { "none".to_string() } else { raw.to_string() });
        db.add_node(
            level,
            name,
            node_type,
            node.class_annotation.clone().filter(|s| !s.is_empty()),
            icon,
            node.description_opt(),
        );
    }
}

impl super::parser::TreeNodeAst {
    fn description_opt(&self) -> Option<String> {
        self.desc_annotation.clone().filter(|s| !s.is_empty())
    }
}

pub fn read_tree_view(source: &str, origin: Option<&SourceMap<'_>>) -> Result<TreeViewAst, PeleError> {
    let pre = preprocess_box_drawing(source, origin)?;
    if pre.text == source {
        return parse_tree_view(source, origin);
    }
    match parse_tree_view(&pre.text, None) {
        Ok(ast) => Ok(ast),
        Err(err) => {
            let Some(&orig_line) = pre.line_map.get(&err.line) else {
                return Err(err);
            };
            let at_chars = if err.column > 0 {
                pre.columns.get(&err.line).map_or(err.column - 1, |col_map| col_map.map(err.column - 1))
            } else {
                0
            };
            let byte_off = char_to_byte_offset(source, line_start(source, orig_line), at_chars);
            let written = locate(source, byte_off, origin);
            let head_end = err.message.find('\n').unwrap_or(err.message.len());
            let head = &err.message[..head_end];
            let rest = &err.message[head_end..];
            let single_map: HashMap<usize, usize> = HashMap::from([(err.line, written.line)]);
            let remapped_head = remap_error_lines(head, &single_map);
            let remapped_rest = if !err.snippet.is_empty() {
                rest.replacen(&err.snippet, &written.snippet, 1)
            } else {
                rest.to_string()
            };
            let mut mapped = PeleError::new(format!("{remapped_head}{remapped_rest}"), err.code);
            mapped.diagram_type = err.diagram_type;
            mapped.line = written.line;
            mapped.column = if err.column > 0 { written.column } else { 0 };
            mapped.snippet = if err.snippet.is_empty() { String::new() } else { written.snippet };
            Err(mapped)
        }
    }
}

pub fn build_tree_view(ast: TreeViewAst, title: Option<&str>) -> TreeViewModel {
    let mut db = TreeViewDb::new();
    populate(&ast, &mut db);
    let (root, count) = db.finish();
    TreeViewModel {
        title: ast.title.filter(|s| !s.is_empty()).or_else(|| title.map(str::to_string)),
        acc_title: crate::diagram::info::model::trim_acc_title(ast.acc_title),
        acc_descr: crate::diagram::info::model::trim_acc_descr(ast.acc_descr),
        root,
        count,
    }
}
