pub mod db;
pub mod parser;
pub mod render;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use db::{BranchDb, CherryPickDb, CommitDb, CommitType, GitCommit, GitDbParseProvider, GitModel, MergeDb, build_git, parse_statement, populate};
pub use parser::{CommitTypeName, GitDirection, GitGraphAst, StatementAst, parse_git};

pub struct GitGraphDiagram;

impl DiagramSpec for GitGraphDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::GitGraph
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let ast = parser::parse_git(src, ctx.origin)?;
        let model = db::build_git(&ast, ctx.config, ctx.title)?;
        Ok(ParsedModel::GitGraph(model))
    }
}
