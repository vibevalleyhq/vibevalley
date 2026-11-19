pub mod color_slots;
pub mod db;
pub mod diagnostics;
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

pub use db::{AgentflowDb, AgentflowDbOptions, is_tool_definition};
pub use graph::{AgentGraph, GraphEdge, GraphNode, build_agent_graph};
pub use render::{PALETTE, render_agentflow};

pub struct AgentflowDiagram;

impl DiagramSpec for AgentflowDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::Agentflow
    }

    fn keep_comments(&self) -> bool {
        true
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let mut db = AgentflowDb::new(AgentflowDbOptions {
            max_edges: Some(ctx.max_edges),
            inherit_dir: ctx.config.flowchart.inherit_dir,
            direction: None,
            line_offset: ctx.line_offset,
        });
        if let Some(title) = ctx.title
            && !title.is_empty()
        {
            db.title = Some(title.to_string());
        }
        parser::parse_agentflow(src, &mut db, false, ctx.origin)?;
        let graph = build_agent_graph(&mut db, PALETTE, ctx.config.flowchart.curve.as_deref());
        db.cached_graph = Some(graph);
        Ok(ParsedModel::Agentflow(Box::new(db)))
    }
}
