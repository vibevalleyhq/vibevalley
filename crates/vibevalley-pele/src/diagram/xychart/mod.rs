pub mod db;
pub mod lexer;
pub mod parser;
pub mod render;
pub mod ticks;
pub mod tokens;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use db::{DataPoint, Orientation, Plot, PlotKind, XyAxis, XyChartModel, XyText, XyTextKind};

pub struct XyChartDiagram;

impl DiagramSpec for XyChartDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::XyChart
    }

    fn section_name(&self) -> Option<&'static str> {
        Some("xyChart")
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let mut model = XyChartModel::new();
        model.title = ctx.title.map(str::to_string);
        parser::parse_xychart(src, &mut model, ctx.origin)?;
        Ok(ParsedModel::XyChart(model))
    }
}
