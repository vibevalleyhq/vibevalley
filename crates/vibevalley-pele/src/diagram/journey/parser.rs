use crate::detect::DiagramType;
use crate::diagram::timeline::scan::strip_keyword_sep;
use crate::error::{PeleError, SourceMap, syntax_error};

use super::db::JourneyModel;
use super::lexer::{JourneyToken, tokenize};

const STATEMENT: &str = "'EOF', 'SPACE', 'NEWLINE', 'title', 'acc_title', 'acc_descr', 'acc_descr_multiline_value', 'section', 'taskName'";

pub fn parse_journey(src: &str, db: &mut JourneyModel, origin: Option<&SourceMap<'_>>) -> Result<(), PeleError> {
    let tokens = tokenize(src);
    let fail = |i: usize, expected: &str| -> PeleError {
        let got = tokens.types[i].name();
        syntax_error(
            DiagramType::Journey,
            src,
            tokens.starts[i],
            &format!("Expecting {expected}, got '{got}'"),
            false,
            origin,
        )
    };

    if tokens.types[0] != JourneyToken::Journey {
        return Err(fail(0, "'journey'"));
    }

    let mut i = 1usize;
    loop {
        let text = &tokens.texts[i];
        match tokens.types[i] {
            JourneyToken::Newline => {}
            JourneyToken::Title => db.set_diagram_title(strip_keyword_sep(text, 5)),
            JourneyToken::AccTitle => {
                i += 1;
                db.set_acc_title(tokens.texts[i].trim());
            }
            JourneyToken::AccDescr => {
                i += 1;
                db.set_acc_description(tokens.texts[i].trim());
            }
            JourneyToken::AccDescrMultilineValue => db.set_acc_description(text.trim()),
            JourneyToken::Section => db.add_section(strip_keyword_sep(text, 7)),
            JourneyToken::TaskName => {
                i += 1;
                if tokens.types[i] != JourneyToken::TaskData {
                    return Err(fail(i, "'taskData'"));
                }
                db.add_task(text, &tokens.texts[i]);
            }
            JourneyToken::Eof => return Ok(()),
            JourneyToken::End
            | JourneyToken::Invalid
            | JourneyToken::Journey
            | JourneyToken::AccTitleValue
            | JourneyToken::AccDescrValue
            | JourneyToken::TaskData
            | JourneyToken::Colon => return Err(fail(i, STATEMENT)),
        }
        i += 1;
    }
}
