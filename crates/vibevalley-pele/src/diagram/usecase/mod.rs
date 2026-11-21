pub mod db;
pub mod graph;
pub mod json;
pub mod lexer;
pub mod parser;
pub mod render;
pub mod tokens;
pub mod types;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use render::render_usecase;
pub use types::UsecaseModel;

pub struct UsecaseDiagram;

impl DiagramSpec for UsecaseDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::Usecase
    }

    fn supports_math(&self) -> bool {
        true
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let model = parser::parse_usecase(src, ctx.title, ctx.origin)?;
        Ok(ParsedModel::Usecase(model))
    }
}
