pub mod arrows;
pub mod db;
pub mod layout;
pub mod lexer;
pub mod parser;
pub mod render;
pub mod tokens;
pub mod types;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use db::BlockDb;
pub use render::render_block;

pub struct BlockDiagram;

impl DiagramSpec for BlockDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::Block
    }

    fn supports_math(&self) -> bool {
        true
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let mut db = BlockDb::new();
        if let Some(title) = ctx.title
            && !title.is_empty()
        {
            db.title = Some(title.to_string());
        }
        parser::parse_block(src, &mut db, ctx.origin)?;
        db.validate_columns()?;
        Ok(ParsedModel::Block(db))
    }
}
