pub mod db;
pub mod parser;
pub mod render;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use db::{KanbanModel, KanbanNode, KanbanSection};

pub struct KanbanDiagram;

impl DiagramSpec for KanbanDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::Kanban
    }

    fn supports_math(&self) -> bool {
        true
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let mut db = db::KanbanDb::new(ctx.title.map(str::to_string));
        parser::parse_kanban(src, &mut db, ctx.origin)?;
        Ok(ParsedModel::Kanban(db.finish()))
    }
}
