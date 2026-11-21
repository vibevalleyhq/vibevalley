pub mod actors;
pub mod colors;
pub mod db;
pub mod lexer;
pub mod parser;
pub mod render;
pub mod tokens;
pub mod types;

use crate::detect::DiagramType;
use crate::diagram::{DiagramSpec, ParseContext, ParsedModel};
use crate::error::PeleError;

pub use db::{SeqDb, SeqDbOptions};
pub use render::{is_line_message, number_messages, render_sequence};

pub struct SequenceDiagram;

impl DiagramSpec for SequenceDiagram {
    fn diagram_type(&self) -> DiagramType {
        DiagramType::Sequence
    }

    fn supports_math(&self) -> bool {
        true
    }

    fn parse_model(&self, src: &str, ctx: &ParseContext<'_>) -> Result<ParsedModel, PeleError> {
        let mut db = SeqDb::new(SeqDbOptions {
            wrap: ctx.config.wrap,
            sequence_wrap: ctx.config.sequence.wrap,
        });
        if let Some(title) = ctx.title
            && !title.is_empty()
        {
            db.set_diagram_title(title);
        }
        parser::parse_sequence(src, &mut db, ctx.origin)?;
        Ok(ParsedModel::Sequence(db))
    }
}
