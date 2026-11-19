use crate::diagram::mindmap::outline::{OutlineDb, Tokens, parse_outline, tokenize as tokenize_outline};
use crate::error::{PeleError, SourceMap};

pub fn tokenize(src: &str) -> Tokens {
    tokenize_outline(src, true)
}

pub fn parse_kanban(src: &str, db: &mut dyn OutlineDb, origin: Option<&SourceMap<'_>>) -> Result<(), PeleError> {
    parse_outline(src, db, true, origin)
}
