use std::ops::Range;

use vibevalley_files::{HighlightKind, HighlightSpan, Language};

pub struct Line {
    pub text: String,
    pub spans: Vec<HighlightSpan>,
}

fn matches_scope(scope: &str, prefix: &str) -> bool {
    scope == prefix || scope.strip_prefix(prefix).is_some_and(|rest| rest.starts_with('.'))
}

fn highlight_kind_from_scopes(scopes: &[String]) -> Option<HighlightKind> {
    for scope in scopes.iter().rev() {
        if matches_scope(scope, "meta.embedded") {
            return None;
        }
        if matches_scope(scope, "comment") {
            return Some(HighlightKind::Comment);
        }
        if matches_scope(scope, "markup.heading") {
            return Some(HighlightKind::Heading);
        }
        if matches_scope(scope, "markup.bold") || matches_scope(scope, "markup.italic") {
            return Some(HighlightKind::Emphasis);
        }
        if matches_scope(scope, "string.other.link") || matches_scope(scope, "markup.underline.link") {
            return Some(HighlightKind::Link);
        }
        if matches_scope(scope, "constant.character.escape") {
            return Some(HighlightKind::Constant);
        }
        if matches_scope(scope, "string") || matches_scope(scope, "markup.inline.raw") || matches_scope(scope, "markup.fenced_code") {
            return Some(HighlightKind::String);
        }
        if matches_scope(scope, "constant.numeric") {
            return Some(HighlightKind::Number);
        }
        if matches_scope(scope, "constant") {
            return Some(HighlightKind::Constant);
        }
        if matches_scope(scope, "keyword.operator") {
            return Some(HighlightKind::Operator);
        }
        if matches_scope(scope, "keyword") || matches_scope(scope, "storage") || matches_scope(scope, "variable.language") {
            return Some(HighlightKind::Keyword);
        }
        if matches_scope(scope, "entity.name.function") || matches_scope(scope, "support.function") {
            return Some(HighlightKind::Function);
        }
        if matches_scope(scope, "entity.name.tag") || matches_scope(scope, "meta.tag") {
            return Some(HighlightKind::Tag);
        }
        if matches_scope(scope, "entity.other.attribute-name") || matches_scope(scope, "meta.attribute") {
            return Some(HighlightKind::Attribute);
        }
        if matches_scope(scope, "support.type.property-name")
            || matches_scope(scope, "variable.other.property")
            || matches_scope(scope, "meta.object-literal.key")
        {
            return Some(HighlightKind::Property);
        }
        if matches_scope(scope, "entity.name.type")
            || matches_scope(scope, "support.type")
            || matches_scope(scope, "entity.name.class")
            || matches_scope(scope, "entity.name.struct")
        {
            return Some(HighlightKind::Type);
        }
        if matches_scope(scope, "variable") {
            return Some(HighlightKind::Variable);
        }
        if matches_scope(scope, "punctuation") {
            return Some(HighlightKind::Punctuation);
        }
    }
    None
}

fn highlight_lines(text: &str, language: &Language) -> Vec<Vec<HighlightSpan>> {
    vibevalley_rich::tokenize_scopes(text, &language.0)
        .into_iter()
        .map(|line_spans| {
            let mut merged: Vec<HighlightSpan> = Vec::new();
            for span in line_spans {
                let Some(kind) = highlight_kind_from_scopes(&span.scopes) else {
                    continue;
                };
                if let Some(last) = merged.last_mut()
                    && last.kind == kind
                    && last.range.end == span.range.start
                {
                    last.range.end = span.range.end;
                } else {
                    merged.push(HighlightSpan { range: span.range, kind });
                }
            }
            merged
        })
        .collect()
}

/// Splits `text` into lines with their highlight spans (blocking; run off
/// the UI thread).
pub fn prepare(text: &str, language: Option<&Language>) -> Vec<Line> {
    let spans = language.map(|l| highlight_lines(text, l)).unwrap_or_default();
    let mut spans = spans.into_iter();
    text.lines()
        .map(|line| Line {
            text: line.to_string(),
            spans: spans.next().unwrap_or_default(),
        })
        .collect()
}

/// Highlight ranges clipped to the line and to char boundaries.
pub fn clip_spans(text: &str, spans: &[HighlightSpan]) -> Vec<(Range<usize>, vibevalley_files::HighlightKind)> {
    spans
        .iter()
        .filter_map(|s| {
            let end = s.range.end.min(text.len());
            let start = s.range.start.min(end);
            (start < end && text.is_char_boundary(start) && text.is_char_boundary(end)).then_some((start..end, s.kind))
        })
        .collect()
}
