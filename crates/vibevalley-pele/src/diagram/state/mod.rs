pub mod db;
pub mod graph;
pub mod lexer;
pub mod parser;
pub mod render;
pub mod tokens;
pub mod types;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use db::StateDb;
pub use graph::{EdgePattern, StateEdge, StateGraph, StateNode, StateNodeShape, StateNodeType};
pub use render::render_state;

pub struct StateDiagram;

impl DiagramSpec for StateDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::State
    }

    fn supports_math(&self) -> bool {
        true
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let mut db = StateDb::new();
        if let Some(title) = ctx.title
            && !title.is_empty()
        {
            db.title = Some(title.to_string());
        }
        parser::parse_state(src, &mut db, ctx.origin)?;
        Ok(ParsedModel::State(db))
    }
}
