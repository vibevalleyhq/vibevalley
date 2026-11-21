pub mod db;
pub mod graph;
pub mod lexer;
pub mod parser;
pub mod render;
pub mod shapes;
pub mod tokens;
pub mod types;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use db::{FlowDb, FlowDbOptions};
pub use render::{FlowVariant, render_flowchart};
pub use shapes::{canonical_shape, is_valid_shape};

pub struct FlowchartDiagram;

impl DiagramSpec for FlowchartDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::Flowchart
    }

    fn supports_math(&self) -> bool {
        true
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let mut db = FlowDb::new(FlowDbOptions {
            max_edges: Some(ctx.max_edges),
            inherit_dir: ctx.config.flowchart.inherit_dir,
            direction: None,
        });
        if let Some(title) = ctx.title
            && !title.is_empty()
        {
            db.title = Some(title.to_string());
        }
        parser::parse_flowchart(src, &mut db, ctx.origin)?;
        Ok(ParsedModel::Flowchart(db))
    }
}
