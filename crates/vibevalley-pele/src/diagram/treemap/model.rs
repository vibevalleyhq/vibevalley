use indexmap::IndexMap;

use super::parser::{TreemapAst, TreemapItemAst, TreemapStatementAst};

#[derive(Debug, Clone, PartialEq)]
pub struct TreemapNode {
    pub name: String,
    /// Sections have `Some(children)`, which may be empty; leaves have `None`.
    pub children: Option<Vec<TreemapNode>>,
    pub value: Option<f64>,
    pub class_selector: Option<String>,
    pub css_compiled_styles: Option<Vec<String>>,
}

impl Drop for TreemapNode {
    fn drop(&mut self) {
        let mut stack = self.children.take().unwrap_or_default();
        while let Some(mut node) = stack.pop() {
            if let Some(mut kids) = node.children.take() {
                stack.append(&mut kids);
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TreemapItem {
    pub level: usize,
    pub name: String,
    pub is_leaf: bool,
    pub value: Option<f64>,
    pub class_selector: Option<String>,
    pub css_compiled_styles: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TreemapModel {
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    pub roots: Vec<TreemapNode>,
    pub classes: IndexMap<String, Vec<String>>,
}

/// A row belongs to the nearest section above it that is indented less.
pub fn build_hierarchy(items: Vec<TreemapItem>) -> Vec<TreemapNode> {
    let mut roots: Vec<TreemapNode> = Vec::new();
    let mut stack: Vec<(usize, TreemapNode)> = Vec::new();

    let flush = |stack: &mut Vec<(usize, TreemapNode)>, roots: &mut Vec<TreemapNode>, min_len: usize| {
        while stack.len() > min_len {
            let (_, finished) = stack.pop().unwrap();
            if let Some((_, parent)) = stack.last_mut() {
                parent.children.as_mut().unwrap().push(finished);
            } else {
                roots.push(finished);
            }
        }
    };

    for item in items {
        let node = TreemapNode {
            name: item.name,
            children: if item.is_leaf { None } else { Some(Vec::new()) },
            value: if item.is_leaf { item.value } else { None },
            class_selector: item.class_selector,
            css_compiled_styles: item.css_compiled_styles,
        };
        while stack.last().is_some_and(|(lvl, _)| *lvl >= item.level) {
            let (_, finished) = stack.pop().unwrap();
            if let Some((_, parent)) = stack.last_mut() {
                parent.children.as_mut().unwrap().push(finished);
            } else {
                roots.push(finished);
            }
        }
        if item.is_leaf {
            if let Some((_, parent)) = stack.last_mut() {
                parent.children.as_mut().unwrap().push(node);
            } else {
                roots.push(node);
            }
        } else {
            stack.push((item.level, node));
        }
    }
    flush(&mut stack, &mut roots, 0);
    roots
}

pub fn build_treemap(ast: TreemapAst, title: Option<&str>) -> TreemapModel {
    let mut classes: IndexMap<String, Vec<String>> = IndexMap::new();
    for row in &ast.rows {
        if let TreemapStatementAst::ClassDef { class_name, style_text, .. } = row {
            let styles = classes.entry(class_name.clone()).or_default();
            let raw = style_text.as_deref().unwrap_or("");
            let normalized = raw.replace("\\,", "§§§").replace(',', ";").replace("§§§", ",");
            for decl in normalized.split(';') {
                styles.push(decl.to_string());
            }
        }
    }

    let mut items: Vec<TreemapItem> = Vec::new();
    for row in ast.rows {
        if let TreemapStatementAst::Row { indent, item } = row {
            match item {
                TreemapItemAst::Section { name, class_selector } => {
                    let styles = class_selector.as_deref().and_then(|sel| classes.get(sel)).filter(|s| !s.is_empty()).cloned();
                    items.push(TreemapItem {
                        level: indent.unwrap_or(0),
                        name,
                        is_leaf: false,
                        value: None,
                        class_selector,
                        css_compiled_styles: styles,
                    });
                }
                TreemapItemAst::Leaf { name, value, class_selector } => {
                    let styles = class_selector.as_deref().and_then(|sel| classes.get(sel)).filter(|s| !s.is_empty()).cloned();
                    items.push(TreemapItem {
                        level: indent.unwrap_or(0),
                        name,
                        is_leaf: true,
                        value: Some(value),
                        class_selector,
                        css_compiled_styles: styles,
                    });
                }
            }
        }
    }

    TreemapModel {
        title: ast.title.filter(|s| !s.is_empty()).or_else(|| title.map(str::to_string)),
        acc_title: crate::diagram::info::model::trim_acc_title(ast.acc_title),
        acc_descr: crate::diagram::info::model::trim_acc_descr(ast.acc_descr),
        roots: build_hierarchy(items),
        classes,
    }
}
