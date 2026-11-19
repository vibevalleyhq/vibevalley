pub mod builder;
pub mod model;
pub mod parser;
pub mod render;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use builder::{
    Flow, SourceStrategy, WardleyAnnotation, WardleyAxesConfig, WardleyBuildResult, WardleyBuilder, WardleyCoord, WardleyForce, WardleyLink, WardleyNode,
    WardleyNodeClass, WardleyNote, WardleyPipeline, WardleySize, WardleyTrend,
};
pub use model::WardleyModel;

pub struct WardleyDiagram;

impl DiagramSpec for WardleyDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::Wardley
    }

    fn section_name(&self) -> Option<&'static str> {
        Some("wardley-beta")
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let ast = parser::parse_wardley(src, ctx.origin)?;
        let model = model::build_wardley(ast, ctx.title)?;
        Ok(ParsedModel::Wardley(model))
    }
}
