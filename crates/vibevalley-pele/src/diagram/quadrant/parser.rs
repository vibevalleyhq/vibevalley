use crate::detect::DiagramType;
use crate::error::{PeleError, SourceMap, syntax_error};

use super::db::{QuadrantModel, QuadrantText, QuadrantTextKind};
use super::lexer::tokenize;
use super::tokens::QuadrantToken;

const TEXT_TOKENS: &str = "'STR', 'MD_STR', 'ALPHA', 'NUM', 'UNICODE_TEXT', 'PUNCTUATION'";

pub fn parse_quadrant(src: &str, db: &mut QuadrantModel, origin: Option<&SourceMap<'_>>) -> Result<(), PeleError> {
    let tokens = tokenize(src);
    let mut i = 0usize;

    let fail = |i: usize, expected: &str| -> PeleError {
        let t = tokens.types[i];
        if t == QuadrantToken::Error {
            return syntax_error(DiagramType::QuadrantChart, src, tokens.starts[i], "", true, origin);
        }
        syntax_error(
            DiagramType::QuadrantChart,
            src,
            tokens.starts[i],
            &format!("Expecting {expected}, got '{}'", t.name()),
            false,
            origin,
        )
    };

    let expect = |i: &mut usize, expected: QuadrantToken| -> Result<&str, PeleError> {
        if tokens.types[*i] != expected {
            return Err(fail(*i, &format!("'{}'", expected.name())));
        }
        let s = tokens.texts[*i];
        *i += 1;
        Ok(s)
    };

    let read_text = |i: &mut usize| -> Result<QuadrantText, PeleError> {
        let first = tokens.types[*i];
        if !first.is_text() {
            return Err(fail(*i, TEXT_TOKENS));
        }
        let mut s = tokens.texts[*i].to_string();
        *i += 1;
        while tokens.types[*i].is_word() || matches!(tokens.types[*i], QuadrantToken::Space | QuadrantToken::Minus) {
            s.push_str(tokens.texts[*i]);
            *i += 1;
        }
        Ok(QuadrantText {
            text: s,
            kind: if first == QuadrantToken::MdStr {
                QuadrantTextKind::Markdown
            } else {
                QuadrantTextKind::Text
            },
        })
    };

    let read_styles = |i: &mut usize| -> Result<Vec<String>, PeleError> {
        let mut out = Vec::new();
        loop {
            if !tokens.types[*i].is_style() {
                return Err(fail(*i, "'ALPHA', 'NUM', 'COLON', 'SPACE', 'BRKT', 'MINUS'"));
            }
            let mut s = tokens.texts[*i].to_string();
            *i += 1;
            while tokens.types[*i].is_style() {
                s.push_str(tokens.texts[*i]);
                *i += 1;
            }
            out.push(s.trim().to_string());
            if tokens.types[*i] != QuadrantToken::Comma {
                return Ok(out);
            }
            *i += 1;
        }
    };

    while tokens.types[i].is_eol() || tokens.types[i] == QuadrantToken::Space {
        i += 1;
    }
    expect(&mut i, QuadrantToken::Quadrant)?;

    while tokens.types[i] != QuadrantToken::End {
        while tokens.types[i] == QuadrantToken::Space {
            i += 1;
        }
        let t = tokens.types[i];
        match t {
            QuadrantToken::ClassDef => {
                i += 1;
                expect(&mut i, QuadrantToken::Space)?;
                if !tokens.types[i].is_id() {
                    return Err(fail(i, "'ALPHA', 'NUM', 'UNICODE_TEXT'"));
                }
                let mut id = tokens.texts[i].to_string();
                i += 1;
                while tokens.types[i].is_id() {
                    id.push_str(tokens.texts[i]);
                    i += 1;
                }
                expect(&mut i, QuadrantToken::Space)?;
                let styles = read_styles(&mut i)?;
                db.add_class(id, &styles)?;
            }
            QuadrantToken::XAxis | QuadrantToken::YAxis => {
                i += 1;
                let mut from = read_text(&mut i)?;
                let mut to = None;
                if tokens.types[i] == QuadrantToken::Delimiter {
                    i += 1;
                    if tokens.types[i].is_text() {
                        to = Some(read_text(&mut i)?);
                    } else {
                        from.text.push_str(" ⟶ ");
                    }
                }
                if t == QuadrantToken::XAxis {
                    db.set_x_axis_left_text(from);
                    if let Some(right) = to {
                        db.set_x_axis_right_text(right);
                    }
                } else {
                    db.set_y_axis_bottom_text(from);
                    if let Some(top) = to {
                        db.set_y_axis_top_text(top);
                    }
                }
            }
            QuadrantToken::Quadrant1 => {
                i += 1;
                let label = read_text(&mut i)?;
                db.set_quadrant_text(0, label);
            }
            QuadrantToken::Quadrant2 => {
                i += 1;
                let label = read_text(&mut i)?;
                db.set_quadrant_text(1, label);
            }
            QuadrantToken::Quadrant3 => {
                i += 1;
                let label = read_text(&mut i)?;
                db.set_quadrant_text(2, label);
            }
            QuadrantToken::Quadrant4 => {
                i += 1;
                let label = read_text(&mut i)?;
                db.set_quadrant_text(3, label);
            }
            QuadrantToken::Title => {
                i += 1;
                let v = expect(&mut i, QuadrantToken::TitleValue)?;
                db.set_diagram_title(v.trim().to_string());
            }
            QuadrantToken::AccTitle => {
                i += 1;
                let v = expect(&mut i, QuadrantToken::AccTitleValue)?;
                db.set_acc_title(v.trim());
            }
            QuadrantToken::AccDescr => {
                i += 1;
                let v = expect(&mut i, QuadrantToken::AccDescrValue)?;
                db.set_acc_description(v.trim());
            }
            QuadrantToken::AccDescrMultilineValue => {
                db.set_acc_description(tokens.texts[i].trim());
                i += 1;
            }
            QuadrantToken::Str
            | QuadrantToken::MdStr
            | QuadrantToken::Punctuation
            | QuadrantToken::Amp
            | QuadrantToken::Num
            | QuadrantToken::Alpha
            | QuadrantToken::Comma
            | QuadrantToken::Plus
            | QuadrantToken::Equals
            | QuadrantToken::Mult
            | QuadrantToken::Dot
            | QuadrantToken::Brkt
            | QuadrantToken::Underscore
            | QuadrantToken::UnicodeText => {
                let label = read_text(&mut i)?;
                let class_name = if tokens.types[i] == QuadrantToken::ClassName {
                    let c = tokens.texts[i].to_string();
                    i += 1;
                    c
                } else {
                    String::new()
                };
                expect(&mut i, QuadrantToken::PointStart)?;
                let x = expect(&mut i, QuadrantToken::PointX)?;
                let y = expect(&mut i, QuadrantToken::PointY)?;
                let styles = if tokens.types[i].is_style() { read_styles(&mut i)? } else { Vec::new() };
                db.add_point(label, class_name, x, y, &styles)?;
            }
            QuadrantToken::End
            | QuadrantToken::Error
            | QuadrantToken::Newline
            | QuadrantToken::Semi
            | QuadrantToken::Eof
            | QuadrantToken::TitleValue
            | QuadrantToken::AccTitleValue
            | QuadrantToken::AccDescrValue
            | QuadrantToken::Delimiter
            | QuadrantToken::ClassName
            | QuadrantToken::PointStart
            | QuadrantToken::PointX
            | QuadrantToken::PointY
            | QuadrantToken::Quadrant
            | QuadrantToken::Colon
            | QuadrantToken::Minus
            | QuadrantToken::Space => {}
        }
        if !tokens.types[i].is_eol() {
            return Err(fail(i, "'NEWLINE', 'SEMI', 'EOF'"));
        }
        i += 1;
    }
    Ok(())
}
