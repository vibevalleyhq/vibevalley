use crate::detect::DiagramType;
use crate::diagram::timeline::scan::strip_keyword_sep;
use crate::error::{PeleError, SourceMap, syntax_error};

use super::db::GanttDb;
use super::lexer::tokenize;
use super::tokens::GanttToken;

const LINE: &str = "'EOF', 'SPACE', 'NL', 'weekday_monday', 'weekday_tuesday', 'weekday_wednesday', 'weekday_thursday', \
'weekday_friday', 'weekday_saturday', 'weekday_sunday', 'weekend_friday', 'weekend_saturday', 'dateFormat', \
'inclusiveEndDates', 'topAxis', 'axisFormat', 'tickInterval', 'excludes', 'includes', 'todayMarker', 'title', \
'acc_title', 'acc_descr', 'acc_descr_multiline_value', 'section', 'taskTxt', 'click'";

pub fn parse_gantt(src: &str, db: &mut GanttDb, origin: Option<&SourceMap<'_>>) -> Result<(), PeleError> {
    let tokens = tokenize(src);
    let mut i = 0usize;

    let fail = |at: usize, expected: &str| -> PeleError {
        let t = tokens.types[at];
        syntax_error(
            DiagramType::Gantt,
            src,
            tokens.starts[at],
            &format!("Expecting {expected}, got '{}'", t.name()),
            false,
            origin,
        )
    };

    let check_end = |at: usize, also: &str| -> Result<(), PeleError> {
        if !tokens.types[at].starts_line() {
            return Err(fail(at, &format!("{LINE}{also}")));
        }
        Ok(())
    };

    if tokens.types[i] != GanttToken::Gantt {
        return Err(fail(i, "'gantt'"));
    }
    i += 1;

    loop {
        let t = tokens.types[i];
        let text = &tokens.texts[i];
        if !t.starts_line() {
            return Err(fail(i, LINE));
        }
        i += 1;
        match t {
            GanttToken::Eof => {
                if tokens.types[i] == GanttToken::End {
                    return Ok(());
                }
                check_end(i, "")?;
            }
            GanttToken::Nl => {}
            GanttToken::DateFormat => {
                check_end(i, "")?;
                db.set_date_format(strip_keyword_sep(text, 10));
            }
            GanttToken::InclusiveEndDates => {
                check_end(i, "")?;
                db.enable_inclusive_end_dates();
            }
            GanttToken::TopAxis => {
                check_end(i, "")?;
                db.enable_top_axis();
            }
            GanttToken::AxisFormat => {
                check_end(i, "")?;
                db.set_axis_format(strip_keyword_sep(text, 10));
            }
            GanttToken::TickInterval => {
                check_end(i, "")?;
                db.set_tick_interval(strip_keyword_sep(text, 12));
            }
            GanttToken::Excludes => {
                check_end(i, "")?;
                db.set_excludes(strip_keyword_sep(text, 8));
            }
            GanttToken::Includes => {
                check_end(i, "")?;
                db.set_includes(strip_keyword_sep(text, 8));
            }
            GanttToken::TodayMarker => {
                check_end(i, "")?;
                db.set_today_marker(strip_keyword_sep(text, 11));
            }
            GanttToken::WeekendFriday => {
                check_end(i, "")?;
                db.set_weekend("friday");
            }
            GanttToken::WeekendSaturday => {
                check_end(i, "")?;
                db.set_weekend("saturday");
            }
            GanttToken::Title => {
                check_end(i, "")?;
                db.set_diagram_title(strip_keyword_sep(text, 5));
            }
            GanttToken::AccTitle => {
                if tokens.types[i] != GanttToken::AccTitleValue {
                    return Err(fail(i, "'acc_title_value'"));
                }
                let value = &tokens.texts[i];
                i += 1;
                check_end(i, "")?;
                db.set_acc_title(value.trim());
            }
            GanttToken::AccDescr => {
                if tokens.types[i] != GanttToken::AccDescrValue {
                    return Err(fail(i, "'acc_descr_value'"));
                }
                let value = &tokens.texts[i];
                i += 1;
                check_end(i, "")?;
                db.set_acc_description(value.trim());
            }
            GanttToken::AccDescrMultilineValue => {
                check_end(i, "")?;
                db.set_acc_description(text.trim());
            }
            GanttToken::Section => {
                check_end(i, "")?;
                db.add_section(strip_keyword_sep(text, 7));
            }
            GanttToken::TaskTxt => {
                if tokens.types[i] != GanttToken::TaskData {
                    return Err(fail(i, "'taskData'"));
                }
                let data = &tokens.texts[i];
                i += 1;
                check_end(i, "")?;
                db.add_task(text, data)?;
            }
            GanttToken::Click => {
                let mut name: Option<&str> = None;
                let mut args: Option<&str> = None;
                let mut href: Option<&str> = None;
                if tokens.types[i] == GanttToken::CallbackName {
                    name = Some(&tokens.texts[i]);
                    i += 1;
                    if tokens.types[i] == GanttToken::CallbackArgs {
                        args = Some(&tokens.texts[i]);
                        i += 1;
                    }
                    if tokens.types[i] == GanttToken::Href {
                        href = Some(&tokens.texts[i]);
                        i += 1;
                        check_end(i, "")?;
                    } else {
                        check_end(i, if args.is_none() { ", 'callbackargs', 'href'" } else { ", 'href'" })?;
                    }
                } else if tokens.types[i] == GanttToken::Href {
                    href = Some(&tokens.texts[i]);
                    i += 1;
                    if tokens.types[i] == GanttToken::CallbackName {
                        name = Some(&tokens.texts[i]);
                        i += 1;
                        if tokens.types[i] == GanttToken::CallbackArgs {
                            args = Some(&tokens.texts[i]);
                            i += 1;
                            check_end(i, "")?;
                        } else {
                            check_end(i, ", 'callbackargs'")?;
                        }
                    } else {
                        check_end(i, ", 'callbackname'")?;
                    }
                } else {
                    return Err(fail(i, "'callbackname', 'href'"));
                }
                if let Some(cb) = name {
                    db.set_click_event(text, cb, args);
                }
                if let Some(link) = href {
                    db.set_link(text, link);
                }
            }
            GanttToken::WeekdayMonday => {
                check_end(i, "")?;
                db.set_weekday("monday");
            }
            GanttToken::WeekdayTuesday => {
                check_end(i, "")?;
                db.set_weekday("tuesday");
            }
            GanttToken::WeekdayWednesday => {
                check_end(i, "")?;
                db.set_weekday("wednesday");
            }
            GanttToken::WeekdayThursday => {
                check_end(i, "")?;
                db.set_weekday("thursday");
            }
            GanttToken::WeekdayFriday => {
                check_end(i, "")?;
                db.set_weekday("friday");
            }
            GanttToken::WeekdaySaturday => {
                check_end(i, "")?;
                db.set_weekday("saturday");
            }
            GanttToken::WeekdaySunday => {
                check_end(i, "")?;
                db.set_weekday("sunday");
            }
            GanttToken::End
            | GanttToken::Error
            | GanttToken::OpenDirective
            | GanttToken::AccTitleValue
            | GanttToken::AccDescrValue
            | GanttToken::Href
            | GanttToken::CallbackName
            | GanttToken::CallbackArgs
            | GanttToken::Gantt
            | GanttToken::Date
            | GanttToken::AccDescription
            | GanttToken::TaskData
            | GanttToken::Colon => {
                return Err(fail(i - 1, LINE));
            }
        }
    }
}
