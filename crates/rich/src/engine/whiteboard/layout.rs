use crate::engine::whiteboard::model::{Rect2, TextAlign};

#[derive(Debug, Clone, PartialEq)]
pub struct HighlightSpan {
    pub before: String,
    pub highlighted: String,
    pub after: String,
    pub box_offset_x: f64,
    pub box_width: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CardTextLayout {
    pub title_lines: Vec<String>,
    pub body_lines: Vec<String>,
    pub title_y: f64,
    pub body_y: f64,
    pub line_height_title: f64,
    pub line_height_body: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TableLayout {
    pub col_count: usize,
    pub col_width: f64,
    pub header_height: f64,
    pub row_height: f64,
}

/// Estimates advance width of mixed CJK + Latin text for consistent SVG and canvas alignment.
pub fn measure_text_span(text: &str, font_size: f64, bold: bool) -> f64 {
    let bold_scale = if bold { 1.04 } else { 1.0 };
    let mut width = 0.0;
    for ch in text.chars() {
        let code = ch as u32;
        if code > 0xff {
            width += font_size * 1.0;
        } else if matches!(
            ch,
            ' ' | '.' | ',' | ':' | ';' | '!' | '|' | '/' | '\\' | 'i' | 'l' | 'j' | 't' | '\'' | '"' | '(' | ')' | '[' | ']'
        ) {
            width += font_size * 0.34;
        } else if ch.is_ascii_uppercase() {
            width += font_size * 0.65;
        } else {
            width += font_size * 0.56;
        }
    }
    width * bold_scale
}

pub fn wrap_text(text: &str, max_width: f64, font_size: f64, bold: bool, max_lines: usize) -> Vec<String> {
    if text.trim().is_empty() || max_width <= font_size {
        return Vec::new();
    }
    let mut lines = Vec::new();
    for para in text.split('\n') {
        let trimmed = para.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut current = String::new();
        let mut current_w = 0.0;
        let mut token = String::new();
        let flush_token = |tok: &mut String, cur: &mut String, cur_w: &mut f64, out: &mut Vec<String>| {
            if tok.is_empty() {
                return;
            }
            let tw = measure_text_span(tok, font_size, bold);
            if !cur.is_empty() && *cur_w + tw > max_width {
                out.push(cur.trim_end().to_owned());
                cur.clear();
                *cur_w = 0.0;
            }
            if cur.is_empty() {
                let s = tok.trim_start();
                cur.push_str(s);
                *cur_w = measure_text_span(s, font_size, bold);
            } else {
                cur.push_str(tok);
                *cur_w += tw;
            }
            tok.clear();
        };

        for ch in trimmed.chars() {
            let is_cjk = (ch as u32) > 0xff;
            if is_cjk {
                flush_token(&mut token, &mut current, &mut current_w, &mut lines);
                let cw = measure_text_span(&ch.to_string(), font_size, bold);
                if !current.is_empty() && current_w + cw > max_width {
                    lines.push(current.trim_end().to_owned());
                    current.clear();
                    current_w = 0.0;
                }
                current.push(ch);
                current_w += cw;
            } else if ch.is_whitespace() {
                token.push(ch);
                flush_token(&mut token, &mut current, &mut current_w, &mut lines);
            } else {
                token.push(ch);
            }
        }
        flush_token(&mut token, &mut current, &mut current_w, &mut lines);
        if !current.trim().is_empty() {
            lines.push(current.trim_end().to_owned());
        }
    }
    lines.truncate(max_lines.max(1));
    lines
}

pub fn locate_highlight_span(text: &str, highlight: &str, font_size: f64, total_box_w: f64, align: TextAlign) -> Option<HighlightSpan> {
    let hl = highlight.trim();
    if hl.is_empty() {
        return None;
    }
    let idx = text.find(hl)?;
    let before = text[..idx].to_owned();
    let after = text[idx + hl.len()..].to_owned();
    let before_w = measure_text_span(&before, font_size, false);
    let hl_w = measure_text_span(hl, font_size, true).max(20.0);
    let full_w = measure_text_span(text, font_size, false);
    let base_x = match align {
        TextAlign::Left => 0.0,
        TextAlign::Center => ((total_box_w - full_w) * 0.5).max(0.0),
        TextAlign::Right => (total_box_w - full_w).max(0.0),
    };
    Some(HighlightSpan {
        before,
        highlighted: hl.to_owned(),
        after,
        box_offset_x: base_x + before_w - 5.0,
        box_width: hl_w + 10.0,
    })
}

pub fn layout_card(rect: Rect2, title: &str, body: &str, has_top_sticker: bool) -> CardTextLayout {
    let no_body = body.trim().is_empty();
    let is_compact = rect.h <= 44.0;
    let inner_w = if is_compact || rect.w < 130.0 {
        (rect.w - 14.0).max(32.0)
    } else {
        (rect.w - 24.0).max(48.0)
    };
    let font_size_title = if is_compact { 12.5 } else { 13.0 };
    let max_title_lines = if no_body { 4 } else { 3 };
    let title_lines = wrap_text(title, inner_w, font_size_title, !is_compact, max_title_lines);
    let body_lines = wrap_text(body, inner_w, 12.0, false, 4);
    let line_height_title = if is_compact { 15.0 } else { 17.0 };
    let line_height_body = 16.0;
    let content_h = title_lines.len() as f64 * line_height_title
        + if !title_lines.is_empty() && !body_lines.is_empty() { 4.0 } else { 0.0 }
        + body_lines.len() as f64 * line_height_body;
    let title_y = if has_top_sticker {
        let top_pad = 36.0;
        let avail_h = (rect.h - top_pad - 10.0).max(line_height_title);
        rect.y + top_pad + ((avail_h - content_h) * 0.42).max(0.0)
    } else {
        rect.y + ((rect.h - content_h) * 0.5).max(4.0)
    };
    let body_y = title_y + title_lines.len() as f64 * line_height_title + if title_lines.is_empty() { 0.0 } else { 4.0 };
    CardTextLayout {
        title_lines,
        body_lines,
        title_y,
        body_y,
        line_height_title,
        line_height_body,
    }
}

pub fn layout_table(rect: Rect2, headers: &[String], rows: &[Vec<String>]) -> TableLayout {
    let row_max = rows.iter().map(Vec::len).max().unwrap_or(0);
    let col_count = headers.len().max(row_max).max(1);
    let col_width = rect.w.max(60.0) / col_count as f64;
    let header_height = if headers.is_empty() { 0.0 } else { 30.0 };
    let avail_rows = rows.len().max(1) as f64;
    let row_height = ((rect.h - header_height) / avail_rows).clamp(24.0, 38.0);
    TableLayout {
        col_count,
        col_width,
        header_height,
        row_height,
    }
}
