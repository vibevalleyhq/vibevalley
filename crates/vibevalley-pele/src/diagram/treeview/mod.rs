pub mod box_drawing;
pub mod icons;
pub mod model;
pub mod parser;
pub mod render;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use model::{NodeType, TreeNode, TreeViewModel};

pub struct TreeViewDiagram;

impl DiagramSpec for TreeViewDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::TreeView
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let ast = model::read_tree_view(src, ctx.origin)?;
        let model = model::build_tree_view(ast, ctx.title);
        Ok(ParsedModel::TreeView(model))
    }
}
