//! A block's text as spans of marked words (`blocks.ts` and the text part
//! of `ops.ts`). Offsets are code points, as the server counts them.

use vibevalley_protocol::{BlockType, SpanMarks, TextSpan};

pub(crate) fn span(t: impl Into<String>) -> TextSpan {
    TextSpan {
        t: t.into(),
        marks: SpanMarks::default(),
    }
}

/// The marks as the wire has them: only those set.
fn marks_of(m: &SpanMarks) -> SpanMarks {
    SpanMarks {
        bold: (m.bold == Some(true)).then_some(true),
        italic: (m.italic == Some(true)).then_some(true),
        code: (m.code == Some(true)).then_some(true),
        strike: (m.strike == Some(true)).then_some(true),
        link: m.link.clone(),
    }
}

/// Equal for marks that read the same: unset and false give one key.
fn marks_key(m: &SpanMarks) -> String {
    let b = |x: Option<bool>| if x == Some(true) { '1' } else { '0' };
    let mut k: String = [b(m.bold), b(m.italic), b(m.code), b(m.strike)].iter().collect();
    if let Some(link) = &m.link {
        k.push('|');
        k.push_str(link);
    }
    k
}

/// Drops empty spans and joins neighbours with the same marks, so one text
/// has one way to be written.
pub(crate) fn normal_spans<'a>(spans: impl IntoIterator<Item = &'a TextSpan>) -> Vec<TextSpan> {
    let mut out: Vec<TextSpan> = vec![];
    for s in spans {
        if s.t.is_empty() {
            continue;
        }
        if let Some(last) = out.last_mut()
            && marks_key(&last.marks) == marks_key(&s.marks)
        {
            last.t.push_str(&s.t);
            continue;
        }
        out.push(TextSpan {
            t: s.t.clone(),
            marks: marks_of(&s.marks),
        });
    }
    out
}

pub fn plain(spans: &[TextSpan]) -> String {
    spans.iter().map(|s| s.t.as_str()).collect()
}

pub(crate) fn rune_len(spans: &[TextSpan]) -> i64 {
    spans.iter().map(|s| s.t.chars().count() as i64).sum()
}

pub(crate) fn same_text(a: &[TextSpan], b: &[TextSpan]) -> bool {
    let x = normal_spans(a);
    let y = normal_spans(b);
    x.len() == y.len() && x.iter().zip(&y).all(|(s, o)| s.t == o.t && marks_key(&s.marks) == marks_key(&o.marks))
}

/// Cuts spans at a code-point offset, 0 ≤ at ≤ rune_len(spans).
pub(crate) fn split_at(spans: &[TextSpan], mut at: i64) -> (Vec<TextSpan>, Vec<TextSpan>) {
    let mut left = vec![];
    let mut right = vec![];
    for s in spans {
        let n = s.t.chars().count() as i64;
        if at <= 0 {
            right.push(s.clone());
        } else if at >= n {
            left.push(s.clone());
        } else {
            let cut = s.t.char_indices().nth(at as usize).map_or(s.t.len(), |(i, _)| i);
            left.push(TextSpan {
                t: s.t[..cut].to_string(),
                marks: s.marks.clone(),
            });
            right.push(TextSpan {
                t: s.t[cut..].to_string(),
                marks: s.marks.clone(),
            });
        }
        at -= n;
    }
    (normal_spans(&left), normal_spans(&right))
}

pub(crate) fn joined(a: &[TextSpan], b: &[TextSpan]) -> Vec<TextSpan> {
    normal_spans(a.iter().chain(b))
}

/// Code has no marks.
pub fn unmarked(spans: &[TextSpan]) -> Vec<TextSpan> {
    let t = plain(spans);
    if t.is_empty() { vec![] } else { vec![span(t)] }
}

/// The types that hold words.
pub(crate) fn has_text(t: BlockType) -> bool {
    !matches!(t, BlockType::Divider | BlockType::Image | BlockType::IssueRef)
}

pub(crate) fn text_for(t: BlockType, spans: &[TextSpan]) -> Vec<TextSpan> {
    if !has_text(t) {
        return vec![];
    }
    if t == BlockType::Code {
        return unmarked(spans);
    }
    normal_spans(spans)
}

/// JavaScript's `\s`.
pub(crate) fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// JavaScript's `trim()`.
pub(crate) fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}
