pub mod db;
pub mod lexer;
pub mod parser;
pub mod render;
pub(crate) mod scan;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use db::{TimelineDirection, TimelineModel, TimelinePeriod};

pub struct TimelineDiagram;

impl DiagramSpec for TimelineDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::Timeline
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let mut db = TimelineModel::new();
        db.title = ctx.title.map(str::to_string);
        parser::parse_timeline(src, &mut db, ctx.origin)?;
        Ok(ParsedModel::Timeline(db))
    }
}
