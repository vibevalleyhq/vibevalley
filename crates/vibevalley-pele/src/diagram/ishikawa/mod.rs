pub mod db;
pub mod lexer;
pub mod parser;
pub mod render;
pub mod types;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use types::{IshikawaModel, IshikawaNode};

pub struct IshikawaDiagram;

impl DiagramSpec for IshikawaDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::Ishikawa
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let mut db = db::IshikawaDb::new(ctx.title.map(str::to_string));
        parser::parse_ishikawa(src, &mut db, ctx.origin)?;
        Ok(ParsedModel::Ishikawa(db.finish()))
    }
}
