pub mod db;
pub mod lexer;
pub mod parser;
pub mod render;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use db::{JourneyModel, JourneyTask, journey_actors};

pub struct JourneyDiagram;

impl DiagramSpec for JourneyDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::Journey
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let mut db = JourneyModel::new();
        db.title = ctx.title.map(str::to_string);
        parser::parse_journey(src, &mut db, ctx.origin)?;
        Ok(ParsedModel::Journey(db))
    }
}
