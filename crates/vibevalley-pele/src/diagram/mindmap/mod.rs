pub mod db;
pub mod outline;
pub mod parser;
pub mod render;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use db::{MindmapModel, MindmapNode};

pub struct MindmapDiagram;

impl DiagramSpec for MindmapDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::Mindmap
    }

    fn supports_math(&self) -> bool {
        true
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let mut db = db::MindmapDb::new(ctx.title.map(str::to_string));
        parser::parse_mindmap(src, &mut db, ctx.origin)?;
        Ok(ParsedModel::Mindmap(db.finish()))
    }
}
