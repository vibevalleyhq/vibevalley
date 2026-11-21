pub mod model;
pub mod parser;
pub mod render;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use model::InfoModel;

pub struct InfoDiagram;

impl DiagramSpec for InfoDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::Info
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let ast = parser::parse_info(src, ctx.origin)?;
        let model = model::build_info(ast, ctx.title);
        Ok(ParsedModel::Info(model))
    }
}
