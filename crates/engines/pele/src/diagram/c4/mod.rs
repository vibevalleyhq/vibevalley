pub mod db;
pub mod layout;
pub mod lexer;
pub mod parser;
pub mod render;
pub mod route;
pub mod tokens;
pub mod types;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use db::C4Db;
pub use types::{C4Attr, C4Boundary, C4Element, C4ElementRef, C4Named, C4Rel, C4RelKind, C4Shape};

pub struct C4Diagram;

impl DiagramSpec for C4Diagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::C4
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let mut db = C4Db::new();
        if let Some(title) = ctx.title
            && !title.is_empty()
        {
            db.title = Some(title.to_string());
        }
        parser::parse_c4(src, &mut db, ctx.origin)?;
        Ok(ParsedModel::C4(db))
    }
}
