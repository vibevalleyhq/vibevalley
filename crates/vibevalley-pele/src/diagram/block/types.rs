/// Statement list wrapper whose iterative `Drop` prevents stack overflow on deeply nested composites.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RawStatements(pub Vec<Statement>);

impl Drop for RawStatements {
    fn drop(&mut self) {
        if self.0.is_empty() {
            return;
        }
        let mut stack = std::mem::take(&mut self.0);
        while let Some(stmt) = stack.pop() {
            match stmt {
                Statement::Single(mut b) => stack.append(&mut b.raw_children.0),
                Statement::Chain(list) => {
                    for mut b in list {
                        stack.append(&mut b.raw_children.0);
                    }
                }
            }
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Block {
    pub id: String,
    pub has_id: bool,
    pub block_type: Option<String>,
    pub label: Option<String>,
    pub children: Vec<usize>,
    pub raw_children: RawStatements,
    pub columns: Option<f64>,
    pub width_in_columns: Option<usize>,
    pub width: Option<usize>,
    pub directions: Vec<String>,
    pub classes: Vec<String>,
    pub styles: Vec<String>,
    pub color_index: Option<usize>,
    pub start: Option<String>,
    pub end: Option<String>,
    pub arrow_type_start: Option<String>,
    pub arrow_type_end: Option<String>,
    pub thickness: Option<String>,
    pub pattern: Option<String>,
    pub css: Option<String>,
    pub style_class: Option<String>,
    pub styles_str: Option<String>,
}

/// A statement with links is a list: block, edge, block, and so on.
#[derive(Debug, Clone, PartialEq)]
pub enum Statement {
    Single(Box<Block>),
    Chain(Vec<Block>),
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BlockClassDef {
    pub id: String,
    pub styles: Vec<String>,
    pub text_styles: Vec<String>,
}
