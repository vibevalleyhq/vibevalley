pub mod db;
pub mod layout;
pub mod lexer;
pub mod parser;
pub mod render;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use db::{SankeyLink, SankeyModel, SankeyNode};
pub use layout::{Alignment, LayoutOptions, PlacedLink, PlacedNode, SankeyLayout, layout_sankey};

pub struct SankeyDiagram;

impl DiagramSpec for SankeyDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::Sankey
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let mut model = SankeyModel::new();
        if let Some(title) = ctx.title
            && !title.is_empty()
        {
            model.title = Some(title.to_string());
        }
        let prepared = parser::prepare_text_for_parsing(src, None);
        parser::parse_sankey(&prepared, &mut model, Some(src), ctx.origin)?;
        Ok(ParsedModel::Sankey(model))
    }
}
