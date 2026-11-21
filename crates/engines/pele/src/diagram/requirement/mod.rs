pub mod db;
pub mod graph;
pub mod lexer;
pub mod parser;
pub mod render;
pub mod tokens;
pub mod types;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use db::RequirementDb;
pub use render::render_requirement;

pub struct RequirementDiagram;

impl DiagramSpec for RequirementDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::Requirement
    }

    fn supports_math(&self) -> bool {
        true
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let mut db = RequirementDb::new();
        if let Some(title) = ctx.title
            && !title.is_empty()
        {
            db.title = Some(title.to_string());
        }
        parser::parse_requirement(src, &mut db, ctx.origin)?;
        Ok(ParsedModel::Requirement(db))
    }
}
