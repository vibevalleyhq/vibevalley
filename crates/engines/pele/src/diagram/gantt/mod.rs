pub mod axis;
pub mod dates;
pub mod db;
pub mod lexer;
pub mod parser;
pub mod render;
pub mod tokens;
pub mod types;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use db::GanttDb;
pub use types::{GanttRaw, GanttTask};

pub struct GanttDiagram;

impl DiagramSpec for GanttDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::Gantt
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let mut db = GanttDb::new();
        if let Some(title) = ctx.title
            && !title.is_empty()
        {
            db.title = Some(title.to_string());
        }
        if let Some(mode) = &ctx.config.gantt.display_mode {
            db.display_mode = mode.clone();
        }
        parser::parse_gantt(src, &mut db, ctx.origin)?;
        Ok(ParsedModel::Gantt(db))
    }
}
