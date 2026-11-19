use crate::detect::DiagramType;
use crate::error::{Edit, PeleError, SourceMap, input_offset, syntax_error};
use crate::text::entities::decode_entities;
use crate::util::chars::is_space_char;

use super::db::SankeyModel;
use super::lexer::{SankeyToken, tokenize};

fn is_blank_code(c: u32) -> bool {
    if c == 10 || c == 13 {
        return false;
    }
    if c < 128 {
        return matches!(c, 32 | 9 | 11 | 12);
    }
    matches!(c, 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

fn is_invalid_xml_char_sankey(c: char) -> bool {
    let u = c as u32;
    u <= 0x08 || u == 0x0b || u == 0x0c || (0x0e..=0x1f).contains(&u) || u == 0xfffe || u == 0xffff
}

fn trim_rows(text: &str, edits: &mut Vec<Edit>) -> String {
    let mut end = text.len();
    while end > 0 {
        let ch = text[..end].chars().next_back().unwrap();
        if is_blank_code(ch as u32) {
            end -= ch.len_utf8();
        } else {
            break;
        }
    }
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(end);
    let mut kept = 0usize;
    let mut quoted = false;
    let mut i = 0usize;
    while i < end {
        let ch = text[i..end].chars().next().unwrap();
        let len = ch.len_utf8();
        if quoted {
            if ch == '"' {
                if bytes.get(i + 1) == Some(&b'"') {
                    i += 1;
                } else {
                    quoted = false;
                }
            }
            i += len;
        } else if ch == '"' {
            quoted = true;
            i += 1;
        } else if is_blank_code(ch as u32) {
            let mut j = i + len;
            while j < end {
                let next_ch = text[j..end].chars().next().unwrap();
                if is_blank_code(next_ch as u32) {
                    j += next_ch.len_utf8();
                } else {
                    break;
                }
            }
            let prev_byte = if i > 0 { bytes[i - 1] } else { 0 };
            let next_byte = bytes.get(j).copied().unwrap_or(0);
            // Preserve blank first fields, which Mermaid accepts as empty names.
            if i == 0 || next_byte == b'\n' || next_byte == b'\r' || ((prev_byte == b'\n' || prev_byte == b'\r') && next_byte != b',') {
                out.push_str(&text[kept..i]);
                edits.push(Edit::new(i, j, 0));
                kept = j;
            }
            i = j;
        } else {
            i += len;
        }
    }
    if end < text.len() {
        edits.push(Edit::new(end, text.len(), 0));
    }
    out.push_str(&text[kept..end]);
    out
}

/// Trims row edges outside quoted fields and collapses consecutive line breaks.
pub fn prepare_text_for_parsing(text: &str, steps: Option<&mut Vec<Vec<Edit>>>) -> String {
    let mut row_edits = Vec::new();
    let rows = trim_rows(text, &mut row_edits);

    let mut collapsed = String::with_capacity(rows.len());
    let mut lb_edits = Vec::new();
    let rbytes = rows.as_bytes();
    let mut i = 0usize;
    while i < rbytes.len() {
        if rbytes[i] == b'\n' || rbytes[i] == b'\r' {
            let start = i;
            i += 1;
            while i < rbytes.len() && (rbytes[i] == b'\n' || rbytes[i] == b'\r') {
                i += 1;
            }
            collapsed.push('\n');
            lb_edits.push(Edit::new(start, i, 1));
        } else {
            let ch = rows[i..].chars().next().unwrap();
            collapsed.push(ch);
            i += ch.len_utf8();
        }
    }

    let trimmed_start = collapsed.trim_start_matches(is_space_char);
    let lead = collapsed.len() - trimmed_start.len();
    let trimmed = trimmed_start.trim_end_matches(is_space_char);

    if let Some(steps) = steps {
        steps.push(row_edits);
        steps.push(lb_edits);
        steps.push(vec![Edit::new(0, lead, 0), Edit::new(lead + trimmed.len(), collapsed.len(), 0)]);
    }
    trimmed.to_string()
}

/// ECMAScript `parseFloat` prefix parsing so values like `50%` or ` 2e1 kWh` work as in Mermaid.
fn js_parse_float(raw: &str) -> f64 {
    let s = raw.trim_start_matches(is_space_char);
    let bytes = s.as_bytes();
    let n = bytes.len();
    let mut p = 0usize;
    if p < n && matches!(bytes[p], b'+' | b'-') {
        p += 1;
    }
    let mut has_digits = false;
    while p < n && bytes[p].is_ascii_digit() {
        has_digits = true;
        p += 1;
    }
    if p < n && bytes[p] == b'.' {
        p += 1;
        while p < n && bytes[p].is_ascii_digit() {
            has_digits = true;
            p += 1;
        }
    }
    if !has_digits {
        return f64::NAN;
    }
    let before_exp = p;
    if p < n && matches!(bytes[p], b'e' | b'E') {
        p += 1;
        if p < n && matches!(bytes[p], b'+' | b'-') {
            p += 1;
        }
        let exp_start = p;
        while p < n && bytes[p].is_ascii_digit() {
            p += 1;
        }
        if p == exp_start {
            p = before_exp;
        }
    }
    s[..p].parse::<f64>().unwrap_or(f64::NAN)
}

pub fn parse_sankey(src: &str, db: &mut SankeyModel, raw_source: Option<&str>, origin: Option<&SourceMap<'_>>) -> Result<(), PeleError> {
    let source = raw_source.unwrap_or(src);
    let tokens = tokenize(src);
    let mut i = 0usize;

    let error = |at: usize, detail: &str| -> PeleError {
        let mut steps: Vec<Vec<Edit>> = Vec::new();
        if !std::ptr::eq(source.as_ptr(), src.as_ptr()) || source.len() != src.len() {
            prepare_text_for_parsing(source, Some(&mut steps));
        }
        let offset = if at > 0 && at >= src.len() {
            if let Some((last_idx, last_ch)) = src.char_indices().next_back() {
                input_offset(&steps, last_idx) + last_ch.len_utf8()
            } else {
                0
            }
        } else {
            input_offset(&steps, at)
        };
        syntax_error(DiagramType::Sankey, source, offset, detail, false, origin)
    };

    let fail = |i: usize, expected: &str| -> PeleError {
        let t = tokens.types[i];
        let got = if t == SankeyToken::Stuck && i > 0 {
            tokens.types[i - 1].name()
        } else {
            t.name()
        };
        error(tokens.starts[i], &format!("Expecting {expected}, got '{got}'"))
    };

    let expect = |i: &mut usize, expected: SankeyToken, also: &str| -> Result<(), PeleError> {
        if tokens.types[*i] != expected {
            return Err(fail(*i, &format!("'{}'{also}", expected.name())));
        }
        *i += 1;
        Ok(())
    };

    let field = |i: &mut usize| -> Result<&str, PeleError> {
        if tokens.types[*i] == SankeyToken::NonEscapedText {
            let s = tokens.texts[*i];
            *i += 1;
            return Ok(s);
        }
        if tokens.types[*i] != SankeyToken::Dquote {
            return Err(fail(*i, "'DQUOTE', 'NON_ESCAPED_TEXT'"));
        }
        *i += 1;
        if tokens.types[*i] != SankeyToken::EscapedText {
            return Err(fail(*i, "'ESCAPED_TEXT'"));
        }
        let s = tokens.texts[*i];
        *i += 1;
        expect(i, SankeyToken::Dquote, "")?;
        Ok(s)
    };

    let name = |i: &mut usize| -> Result<String, PeleError> {
        let start = tokens.starts[*i];
        let text = field(i)?.trim_matches(is_space_char).replace("\"\"", "\"");
        if decode_entities(&text).chars().any(is_invalid_xml_char_sankey) {
            return Err(error(start, "Invalid XML character in node name"));
        }
        Ok(text)
    };

    expect(&mut i, SankeyToken::Sankey, "")?;
    expect(&mut i, SankeyToken::Newline, "")?;
    loop {
        let from = name(&mut i)?;
        expect(&mut i, SankeyToken::Comma, ", 'NEWLINE', 'EOF'")?;
        let to = name(&mut i)?;
        expect(&mut i, SankeyToken::Comma, ", 'NEWLINE', 'EOF'")?;
        let start = tokens.starts[i];
        let value = js_parse_float(field(&mut i)?);
        if !value.is_finite() {
            return Err(error(start, "Expecting a number"));
        }
        let source_idx = db.find_or_create_node(&from);
        let target_idx = db.find_or_create_node(&to);
        db.add_link(source_idx, target_idx, value);
        if tokens.types[i] != SankeyToken::Newline {
            break;
        }
        i += 1;
    }
    if tokens.types[i] == SankeyToken::Eof {
        i += 1;
    }
    if tokens.types[i] != SankeyToken::End {
        return Err(fail(i, "'NEWLINE', 'EOF'"));
    }
    Ok(())
}
