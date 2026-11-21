/// Measured bounding box of a single line of text in CSS/SVG pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextMetrics {
    pub width: f64,
    pub height: f64,
}

/// Pluggable text measurement hook so callers (e.g. macOS CoreText/GPUI) can plug
/// in exact shaped font metrics while keeping a deterministic pure-Rust default.
pub trait TextMeasurer: Send + Sync {
    fn measure(&self, text: &str, font_size: f64, bold: bool) -> TextMetrics;
}

/// Deterministic pure-Rust ASCII + CJK text measurer.
#[derive(Debug, Default, Clone, Copy)]
pub struct DefaultTextMeasurer;

impl TextMeasurer for DefaultTextMeasurer {
    fn measure(&self, text: &str, font_size: f64, bold: bool) -> TextMetrics {
        let mut units = 0.0_f64;
        for ch in text.chars() {
            units += char_em_width(ch);
        }
        let weight_factor = if bold { 1.05 } else { 1.0 };
        TextMetrics {
            width: units * font_size * weight_factor,
            height: font_size * 1.25,
        }
    }
}

/// Returns whether a character occupies a full-width CJK/wide cell.
pub fn is_wide_char(ch: char) -> bool {
    let cp = ch as u32;
    matches!(
        cp,
        0x1100..=0x115F
            | 0x2329..=0x232A
            | 0x2E80..=0x303E
            | 0x3040..=0x33FF
            | 0x3400..=0x4DBF
            | 0x4E00..=0xA4CF
            | 0xA960..=0xA97F
            | 0xAC00..=0xD7A3
            | 0xF900..=0xFAFF
            | 0xFE10..=0xFE19
            | 0xFE30..=0xFE6F
            | 0xFF00..=0xFF60
            | 0xFFE0..=0xFFE6
            | 0x1F300..=0x1FAFF
            | 0x20000..=0x3FFFD
    )
}

fn char_em_width(ch: char) -> f64 {
    if ch.is_control() {
        return 0.0;
    }
    if is_wide_char(ch) {
        return if (ch as u32) >= 0x1F300 && (ch as u32) <= 0x1FAFF { 1.15 } else { 1.02 };
    }
    match ch {
        ' ' => 0.28,
        'i' | 'l' | 'I' | '|' | '!' | '.' | ',' | ':' | ';' | '\'' | '`' => 0.28,
        'f' | 'j' | 'r' | 't' | '(' | ')' | '[' | ']' | '{' | '}' | '/' | '\\' | '-' => 0.36,
        '0'..='9' => 0.58,
        'm' | 'w' | 'M' | 'W' | '@' | '%' | '&' | 'Q' | 'G' | 'O' => 0.80,
        'A'..='Z' => 0.68,
        'a'..='z' => 0.54,
        _ => 0.58,
    }
}

fn is_kinsoku_no_line_start(ch: char) -> bool {
    matches!(
        ch,
        '，' | '。' | '、' | '！' | '？' | '：' | '；' | '）' | '】' | '》' | '」' | '』' | ',' | '.' | '!' | '?' | ':' | ';' | ')' | ']' | '}'
    )
}

/// Wraps text to fit `max_width`, breaking on spaces for Latin text and per-character
/// (with kinsoku punctuation rules) for CJK text.
pub fn wrap_text(text: &str, max_width: f64, font_size: f64, bold: bool, measurer: &dyn TextMeasurer) -> Vec<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if max_width <= font_size || measurer.measure(trimmed, font_size, bold).width <= max_width {
        return vec![trimmed.to_string()];
    }

    let mut lines = Vec::new();
    for raw_line in trimmed.split('\n') {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        wrap_paragraph(line, max_width, font_size, bold, measurer, &mut lines);
    }
    lines
}

fn wrap_paragraph(text: &str, max_width: f64, font_size: f64, bold: bool, measurer: &dyn TextMeasurer, out: &mut Vec<String>) {
    // Tokenize into words (ASCII/Latin runs) and individual CJK/wide chars.
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        if ch.is_whitespace() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            tokens.push(" ".to_string());
        } else if is_wide_char(ch) {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            if is_kinsoku_no_line_start(ch)
                && let Some(prev) = tokens.last_mut()
                && prev != " "
            {
                prev.push(ch);
            } else {
                tokens.push(ch.to_string());
            }
        } else {
            current.push(ch);
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }

    let mut line = String::new();
    for token in tokens {
        if token == " " {
            if !line.is_empty() && !line.ends_with(' ') {
                line.push(' ');
            }
            continue;
        }

        let candidate = if line.is_empty() { token.clone() } else { format!("{line}{token}") };

        if measurer.measure(&candidate, font_size, bold).width <= max_width {
            line = candidate;
            continue;
        }

        let trimmed_line = line.trim_end();
        if !trimmed_line.is_empty() {
            out.push(trimmed_line.to_string());
            line.clear();
        }

        // Single token wider than max_width: hard-wrap by character.
        if measurer.measure(&token, font_size, bold).width > max_width {
            let mut chunk = String::new();
            for ch in token.chars() {
                let mut next = chunk.clone();
                next.push(ch);
                if !chunk.is_empty() && measurer.measure(&next, font_size, bold).width > max_width {
                    out.push(chunk);
                    chunk = ch.to_string();
                } else {
                    chunk = next;
                }
            }
            line = chunk;
        } else {
            line = token;
        }
    }

    let final_line = line.trim();
    if !final_line.is_empty() {
        out.push(final_line.to_string());
    }
}

/// Truncates text with an ellipsis (`…`) so it fits within `max_width`.
pub fn truncate_text(text: &str, max_width: f64, font_size: f64, bold: bool, measurer: &dyn TextMeasurer) -> String {
    if measurer.measure(text, font_size, bold).width <= max_width {
        return text.to_string();
    }
    let ellipsis = "…";
    let ellipsis_w = measurer.measure(ellipsis, font_size, bold).width;
    if max_width <= ellipsis_w {
        return ellipsis.to_string();
    }
    let mut kept = String::new();
    for ch in text.chars() {
        let mut next = kept.clone();
        next.push(ch);
        if measurer.measure(&next, font_size, bold).width + ellipsis_w > max_width {
            break;
        }
        kept = next;
    }
    format!("{}{ellipsis}", kept.trim_end())
}
