pub mod model;
pub mod parser;
pub mod render;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use model::{Graticule, RadarAxis, RadarCurve, RadarModel, RadarOptions};

pub struct RadarDiagram;

impl DiagramSpec for RadarDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::Radar
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let ast = parser::parse_radar(src, ctx.origin)?;
        let model = model::build_radar(ast, ctx.title)?;
        Ok(ParsedModel::Radar(model))
    }
}
