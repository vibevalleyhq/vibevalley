pub mod db;
pub mod graph;
pub mod lexer;
pub mod markers;
pub mod members;
pub mod parser;
pub mod render;
pub mod tokens;
pub mod types;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use db::ClassDb;
pub use render::render_class;

pub struct ClassDiagram;

impl DiagramSpec for ClassDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::Class
    }

    fn supports_math(&self) -> bool {
        true
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let mut db = ClassDb::new();
        if let Some(title) = ctx.title
            && !title.is_empty()
        {
            db.title = Some(title.to_string());
        }
        parser::parse_class_diagram(src, &mut db, ctx.origin)?;
        Ok(ParsedModel::Class(db))
    }
}
