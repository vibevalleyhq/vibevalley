pub mod db;
pub mod layout;
pub mod lexer;
pub mod parser;
pub mod render;
pub mod types;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use db::{VennDb, normalize_text};
pub use types::{VennModel, VennStyle, VennSubset, VennText};

pub struct VennDiagram;

impl DiagramSpec for VennDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::Venn
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let mut db = VennDb::new();
        if let Some(title) = ctx.title
            && !title.is_empty()
        {
            db.set_diagram_title(title.to_string());
        }
        parser::parse_venn(src, &mut db, ctx.origin)?;
        Ok(ParsedModel::Venn(db.into_model()))
    }
}
