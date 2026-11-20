pub mod model;
pub mod parser;
pub mod render;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use model::{PacketBlock, PacketModel};

pub struct PacketDiagram;

impl DiagramSpec for PacketDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::Packet
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let ast = parser::parse_packet(src, ctx.origin)?;
        let model = model::build_packet(ast, ctx.config, ctx.title)?;
        Ok(ParsedModel::Packet(model))
    }
}
