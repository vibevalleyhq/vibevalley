use crate::detect::DiagramType;
use crate::error::{PeleError, SourceMap, syntax_error};

use super::db::{DataPoint, XyChartModel, XyText};
use super::lexer::tokenize;
use super::tokens::XyToken;

pub fn parse_xychart(src: &str, db: &mut XyChartModel, origin: Option<&SourceMap<'_>>) -> Result<(), PeleError> {
    let tokens = tokenize(src);
    let mut i = 0usize;

    let fail = |i: usize, expected: &str| -> PeleError {
        let t = tokens.types[i];
        if t == XyToken::Error {
            return syntax_error(DiagramType::XyChart, src, tokens.starts[i], "", true, origin);
        }
        syntax_error(
            DiagramType::XyChart,
            src,
            tokens.starts[i],
            &format!("Expecting {expected}, got '{}'", t.name()),
            false,
            origin,
        )
    };

    let expect = |i: &mut usize, expected: XyToken| -> Result<&str, PeleError> {
        if tokens.types[*i] != expected {
            return Err(fail(*i, &format!("'{}'", expected.name())));
        }
        let s = tokens.texts[*i];
        *i += 1;
        Ok(s)
    };

    let read_text = |i: &mut usize| -> Result<XyText, PeleError> {
        if !tokens.types[*i].is_text() {
            return Err(fail(*i, "'STR', 'ALPHA', 'NUM'"));
        }
        let first = tokens.types[*i];
        let mut s = tokens.texts[*i].to_string();
        *i += 1;
        if first != XyToken::Str {
            while tokens.types[*i].is_word() {
                s.push_str(tokens.texts[*i]);
                *i += 1;
            }
        }
        Ok(XyText::plain(s))
    };

    let read_range = |i: &mut usize| -> Result<(f64, f64), PeleError> {
        let min: f64 = expect(i, XyToken::NumberWithDecimal)?.parse().unwrap_or(f64::NAN);
        expect(i, XyToken::ArrowDelimiter)?;
        let max: f64 = expect(i, XyToken::NumberWithDecimal)?.parse().unwrap_or(f64::NAN);
        Ok((min, max))
    };

    let read_points = |i: &mut usize| -> Result<Vec<DataPoint>, PeleError> {
        let mut out = Vec::new();
        expect(i, XyToken::SquareBracesStart)?;
        loop {
            let value: f64 = expect(i, XyToken::NumberWithDecimal)?.parse().unwrap_or(f64::NAN);
            let label = if tokens.types[*i] == XyToken::Str {
                let s = tokens.texts[*i].to_string();
                *i += 1;
                s
            } else {
                String::new()
            };
            out.push(DataPoint { value, label });
            if tokens.types[*i] != XyToken::Comma {
                break;
            }
            *i += 1;
        }
        expect(i, XyToken::SquareBracesEnd)?;
        Ok(out)
    };

    loop {
        if tokens.types[i].is_eol() {
            i += 1;
        } else if tokens.types[i] != XyToken::XyChart {
            break;
        } else {
            i += 1;
            if tokens.types[i] == XyToken::ChartOrientation {
                db.set_orientation(tokens.texts[i]);
                i += 1;
            }
        }
    }

    while tokens.types[i] != XyToken::End {
        let t = tokens.types[i];
        i += 1;
        match t {
            XyToken::Title => {
                let title = read_text(&mut i)?;
                db.set_diagram_title(title.text.trim().to_string());
            }
            XyToken::XAxis | XyToken::YAxis => {
                let title = if tokens.types[i].is_text() { Some(read_text(&mut i)?) } else { None };
                if t == XyToken::XAxis && tokens.types[i] == XyToken::SquareBracesStart {
                    let mut categories = Vec::new();
                    loop {
                        i += 1;
                        categories.push(read_text(&mut i)?);
                        if tokens.types[i] != XyToken::Comma {
                            break;
                        }
                    }
                    expect(&mut i, XyToken::SquareBracesEnd)?;
                    db.set_x_axis_band(categories);
                } else if tokens.types[i] == XyToken::NumberWithDecimal || title.is_none() {
                    let (min, max) = read_range(&mut i)?;
                    if t == XyToken::XAxis {
                        db.set_x_axis_range_data(min, max);
                    } else {
                        db.set_y_axis_range_data(min, max);
                    }
                }
                let final_title = title.unwrap_or_else(|| XyText::plain(""));
                if t == XyToken::XAxis {
                    db.set_x_axis_title(final_title);
                } else {
                    db.set_y_axis_title(final_title);
                }
            }
            XyToken::Line | XyToken::Bar => {
                let title = if tokens.types[i] == XyToken::SquareBracesStart {
                    XyText::plain("")
                } else {
                    read_text(&mut i)?
                };
                let data = read_points(&mut i)?;
                if t == XyToken::Line {
                    db.set_line_data(title, data);
                } else {
                    db.set_bar_data(title, data);
                }
            }
            XyToken::AccTitle => {
                let v = expect(&mut i, XyToken::AccTitleValue)?;
                db.set_acc_title(v.trim());
            }
            XyToken::AccDescr => {
                let v = expect(&mut i, XyToken::AccDescrValue)?;
                db.set_acc_description(v.trim());
            }
            XyToken::AccDescrMultilineValue => {
                db.set_acc_description(tokens.texts[i - 1].trim());
            }
            XyToken::End
            | XyToken::Error
            | XyToken::Newline
            | XyToken::AccTitleValue
            | XyToken::AccDescrValue
            | XyToken::XyChart
            | XyToken::ChartOrientation
            | XyToken::ArrowDelimiter
            | XyToken::NumberWithDecimal
            | XyToken::SquareBracesStart
            | XyToken::SquareBracesEnd
            | XyToken::Str
            | XyToken::Alpha
            | XyToken::Colon
            | XyToken::Plus
            | XyToken::Comma
            | XyToken::Equals
            | XyToken::Mult
            | XyToken::Brkt
            | XyToken::Underscore
            | XyToken::Dot
            | XyToken::Amp
            | XyToken::Minus
            | XyToken::Num
            | XyToken::Semi
            | XyToken::Eof => {
                i -= 1;
                return Err(fail(
                    i,
                    "'title', 'X_AXIS', 'Y_AXIS', 'LINE', 'BAR', 'acc_title', 'acc_descr', 'acc_descr_multiline_value'",
                ));
            }
        }
        while tokens.types[i].is_eol() {
            i += 1;
        }
    }
    Ok(())
}
