pub mod db;
pub mod icons;
pub mod layout;
pub mod parser;
pub mod render;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use db::ArchitectureDb;
pub use render::render_architecture;

pub struct ArchitectureDiagram;

impl DiagramSpec for ArchitectureDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::Architecture
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let mut db = ArchitectureDb::new();
        if let Some(title) = ctx.title
            && !title.is_empty()
        {
            db.title = Some(title.to_string());
        }
        let ast = parser::parse_architecture(src, ctx.origin)?;
        db::populate(ast, &mut db)?;
        Ok(ParsedModel::Architecture(db))
    }
}
