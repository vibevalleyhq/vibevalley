pub mod format;
pub mod layout;
pub mod model;
pub mod parser;
pub mod render;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use model::{TreemapItem, TreemapModel, TreemapNode};

pub struct TreemapDiagram;

impl DiagramSpec for TreemapDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::Treemap
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let ast = parser::parse_treemap(src, ctx.origin)?;
        let model = model::build_treemap(ast, ctx.title);
        Ok(ParsedModel::Treemap(model))
    }
}
