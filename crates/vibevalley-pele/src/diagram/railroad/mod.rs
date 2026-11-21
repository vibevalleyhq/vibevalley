pub mod abnf;
pub mod common;
pub mod db;
pub mod ebnf;
pub mod ir;
pub mod peg;
pub mod render;
pub mod types;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use types::{Notation, RailroadModel, RailroadNode, RailroadRule};

pub struct RailroadDiagram;

impl DiagramSpec for RailroadDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::Railroad
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let model = db::parse_railroad(src, ctx.title, ctx.origin)?;
        Ok(ParsedModel::Railroad(model))
    }
}
