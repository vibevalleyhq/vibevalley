pub mod db;
pub mod graph;
pub mod lexer;
pub mod markers;
pub mod parser;
pub mod render;
pub mod tokens;
pub mod types;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use db::ErDb;
pub use graph::{EdgePattern, ErGraph, ErGraphEdge, ErGraphNode, build_er_graph};
pub use parser::parse_er;
pub use render::render_er;
pub use types::{Cardinality, DocItem, ErAttribute, ErClassDef, ErEntity, ErLabelType, ErRelationship, ErSubgraph, Identification, ParsedAttribute, RelSpec};

pub struct ErDiagram;

impl DiagramSpec for ErDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::Er
    }

    fn supports_math(&self) -> bool {
        true
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let mut db = ErDb::new();
        if let Some(title) = ctx.title
            && !title.is_empty()
        {
            db.title = Some(title.to_string());
        }
        parser::parse_er(src, &mut db, ctx.origin)?;
        Ok(ParsedModel::Er(db))
    }
}
