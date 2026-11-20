use crate::detect::DiagramType;
use crate::error::{PeleError, SourceMap, syntax_error};

use super::db::{TimelineDirection, TimelineModel};
use super::lexer::{TimelineToken, tokenize};
use super::scan::strip_keyword_sep;

const STATEMENT: &str = "'EOF', 'SPACE', 'NEWLINE', 'title', 'acc_title', 'acc_descr', 'acc_descr_multiline_value', 'section', 'period', 'event'";

pub fn parse_timeline(src: &str, db: &mut TimelineModel, origin: Option<&SourceMap<'_>>) -> Result<(), PeleError> {
    let tokens = tokenize(src);
    let fail = |i: usize, expected: &str| -> PeleError {
        let got = tokens.types[i].name();
        syntax_error(
            DiagramType::Timeline,
            src,
            tokens.starts[i],
            &format!("Expecting {expected}, got '{got}'"),
            false,
            origin,
        )
    };

    let head = tokens.types[0];
    match head {
        TimelineToken::Timeline => {}
        TimelineToken::TimelineLr => db.set_direction(TimelineDirection::Lr),
        TimelineToken::TimelineTd => db.set_direction(TimelineDirection::Td),
        TimelineToken::End
        | TimelineToken::Eof
        | TimelineToken::Invalid
        | TimelineToken::Newline
        | TimelineToken::Title
        | TimelineToken::AccTitle
        | TimelineToken::AccTitleValue
        | TimelineToken::AccDescr
        | TimelineToken::AccDescrValue
        | TimelineToken::AccDescrMultilineValue
        | TimelineToken::Section
        | TimelineToken::Period
        | TimelineToken::Event => {
            return Err(fail(0, "'timeline', 'timeline_lr', 'timeline_td'"));
        }
    }

    let mut i = 1usize;
    loop {
        let text = &tokens.texts[i];
        match tokens.types[i] {
            TimelineToken::Newline => {}
            TimelineToken::Title => db.set_diagram_title(strip_keyword_sep(text, 5)),
            TimelineToken::AccTitle => {
                i += 1;
                db.set_acc_title(tokens.texts[i].trim());
            }
            TimelineToken::AccDescr => {
                i += 1;
                db.set_acc_description(tokens.texts[i].trim());
            }
            TimelineToken::AccDescrMultilineValue => db.set_acc_description(text.trim()),
            TimelineToken::Section => db.add_section(strip_keyword_sep(text, 7)),
            TimelineToken::Period => db.add_task(text, None),
            TimelineToken::Event => db.add_event(strip_keyword_sep(text, 1))?,
            TimelineToken::Eof => return Ok(()),
            TimelineToken::End
            | TimelineToken::Invalid
            | TimelineToken::Timeline
            | TimelineToken::TimelineLr
            | TimelineToken::TimelineTd
            | TimelineToken::AccTitleValue
            | TimelineToken::AccDescrValue => return Err(fail(i, STATEMENT)),
        }
        i += 1;
    }
}
