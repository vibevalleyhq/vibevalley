pub mod model;
pub mod parser;
pub mod render;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use model::{EmBox, EmLane, EmNote, EmRelation, EmSpecification, EntityKind, EventModelingModel, LaneGroup};

pub struct EventModelingDiagram;

impl DiagramSpec for EventModelingDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::EventModeling
    }

    fn keep_comments(&self) -> bool {
        true
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let ast = parser::parse_event_model(src, ctx.origin)?;
        let model = model::build_event_model(ast, src, ctx.title, ctx.origin)?;
        Ok(ParsedModel::EventModeling(model))
    }
}
