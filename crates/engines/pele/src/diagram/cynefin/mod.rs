pub mod boundaries;
pub mod model;
pub mod parser;
pub mod render;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use model::{CynefinDomain, CynefinItem, CynefinModel, CynefinTransition, DomainName};

pub struct CynefinDiagram;

impl DiagramSpec for CynefinDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::Cynefin
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let ast = parser::parse_cynefin(src, ctx.origin)?;
        let model = model::build_cynefin(ast, ctx.title);
        Ok(ParsedModel::Cynefin(model))
    }
}
