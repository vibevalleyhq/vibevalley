pub mod model;
pub mod parser;
pub mod render;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use model::PieModel;

pub struct PieDiagram;

impl DiagramSpec for PieDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::Pie
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let ast = parser::parse_pie(src, ctx.origin)?;
        let model = model::build_pie(ast, ctx.title)?;
        Ok(ParsedModel::Pie(model))
    }
}
