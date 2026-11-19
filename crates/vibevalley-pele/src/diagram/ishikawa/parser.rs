use crate::detect::DiagramType;
use crate::error::{PeleError, SourceMap, syntax_error};

use super::db::IshikawaDb;
use super::lexer::{Tok, tokenize};

const STOP: &str = "'SPACELINE', 'NL', 'EOF'";

pub fn parse_ishikawa(src: &str, db: &mut IshikawaDb, origin: Option<&SourceMap<'_>>) -> Result<(), PeleError> {
    let tokens = tokenize(src);
    let types = &tokens.types;
    let starts = &tokens.starts;
    let ends = &tokens.ends;
    let mut i = 0usize;

    let fail = |idx: usize, expected: &str| -> PeleError {
        syntax_error(
            DiagramType::Ishikawa,
            src,
            starts[idx],
            &format!("Expecting {expected}, got '{}'", types[idx].name()),
            false,
            origin,
        )
    };

    if types[i] == Tok::Spaceline {
        i += 1;
        while matches!(types[i], Tok::Spaceline | Tok::Nl) {
            i += 1;
        }
        if types[i] != Tok::Ishikawa {
            return Err(fail(i, "'SPACELINE', 'NL', 'ISHIKAWA'"));
        }
    } else if types[i] != Tok::Ishikawa {
        return Err(fail(i, "'SPACELINE', 'ISHIKAWA'"));
    }
    i += 1;
    if types[i] == Tok::Nl {
        i += 1;
    }

    loop {
        let tok = types[i];
        if tok == Tok::Text || (tok == Tok::Spacelist && types[i + 1] == Tok::Text) {
            let text_idx = if tok == Tok::Text { i } else { i + 1 };
            i = text_idx + 1;
            if !matches!(types[i], Tok::Spaceline | Tok::Nl | Tok::Eof) {
                return Err(fail(i, STOP));
            }
            let indent = if tok == Tok::Text {
                0
            } else {
                src[starts[text_idx - 1]..ends[text_idx - 1]].chars().count()
            };
            db.add_node(indent, src[starts[text_idx]..ends[text_idx]].trim().to_string());
        } else if matches!(tok, Tok::Spaceline | Tok::Spacelist) {
            i += 1;
            if !matches!(types[i], Tok::Spaceline | Tok::Nl | Tok::Eof) {
                return Err(fail(i, if tok == Tok::Spacelist { "'SPACELINE', 'NL', 'EOF', 'TEXT'" } else { STOP }));
            }
        } else {
            return Err(fail(i, "'SPACELINE', 'SPACELIST', 'TEXT'"));
        }
        i += 1;
        while matches!(types[i], Tok::Nl | Tok::Eof) {
            i += 1;
        }
        if types[i] == Tok::End {
            return Ok(());
        }
    }
}
