pub mod db;
pub mod lexer;
pub mod parser;
pub mod render;
pub mod tokens;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use db::{PointStyle, QuadrantModel, QuadrantPoint, QuadrantText, QuadrantTextKind};

pub struct QuadrantDiagram;

impl DiagramSpec for QuadrantDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::QuadrantChart
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let mut model = QuadrantModel::new();
        model.title = ctx.title.map(str::to_string);
        parser::parse_quadrant(src, &mut model, ctx.origin)?;
        Ok(ParsedModel::QuadrantChart(model))
    }
}
