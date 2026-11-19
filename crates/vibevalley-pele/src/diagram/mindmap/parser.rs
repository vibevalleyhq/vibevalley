use crate::error::{PeleError, SourceMap};

use super::outline::{OutlineDb, Tokens, parse_outline, tokenize as tokenize_outline};

pub fn tokenize(src: &str) -> Tokens {
    tokenize_outline(src, false)
}

pub fn parse_mindmap(src: &str, db: &mut dyn OutlineDb, origin: Option<&SourceMap<'_>>) -> Result<(), PeleError> {
    parse_outline(src, db, false, origin)
}
