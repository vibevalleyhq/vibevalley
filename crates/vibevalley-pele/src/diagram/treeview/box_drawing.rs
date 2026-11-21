use std::collections::HashMap;

use crate::detect::DiagramType;
use crate::error::{ErrorCode, PeleError, SourceMap, locate};
use crate::util::chars::is_space_char;

const INDENT_UNIT: &str = "    ";

#[inline]
fn is_box_char(c: char) -> bool {
    matches!(c, '─' | '━' | '│' | '┃' | '└' | '┗' | '├' | '┣')
}

#[inline]
fn is_branch_char(c: char) -> bool {
    matches!(c, '└' | '┗' | '├' | '┣')
}

#[inline]
fn is_dash_char(c: char) -> bool {
    matches!(c, '─' | '━')
}

fn is_decoration_only(line: &str) -> bool {
    !line.is_empty() && line.chars().all(|c| is_space_char(c) || matches!(c, '│' | '┃'))
}

fn is_box_only(line: &str) -> bool {
    !line.is_empty() && line.chars().all(|c| is_space_char(c) || is_box_char(c))
}

fn is_comment_line(line: &str) -> bool {
    line.trim_start_matches(is_space_char).starts_with("%%")
}

fn is_metadata_line(line: &str) -> bool {
    let rest = line.trim_start_matches(is_space_char);
    if let Some(after) = rest.strip_prefix("title") {
        return after.starts_with([' ', '\t']);
    }
    if let Some(after) = rest.strip_prefix("accTitle") {
        return after.trim_start_matches([' ', '\t']).starts_with(':');
    }
    if let Some(after) = rest.strip_prefix("accDescr") {
        return after.trim_start_matches([' ', '\t']).starts_with([':', '{']);
    }
    false
}

pub struct ColumnMap {
    pub original_line: String,
    pub pos_chars: usize,
    pub indent_len: usize,
}

impl ColumnMap {
    pub fn map(&self, at_chars: usize) -> usize {
        before_tabs(&self.original_line, self.pos_chars + at_chars.saturating_sub(self.indent_len))
    }
}

pub struct PreprocessResult {
    pub text: String,
    pub line_map: HashMap<usize, usize>,
    pub columns: HashMap<usize, ColumnMap>,
}

pub fn is_box_drawing_format(lines: &[String]) -> bool {
    lines.iter().any(|line| line.chars().any(is_box_char))
}

fn find_branch_char(line: &str) -> Option<(usize, usize)> {
    for (char_idx, (byte_idx, ch)) in line.char_indices().enumerate() {
        if is_branch_char(ch) {
            return Some((char_idx, byte_idx));
        }
    }
    None
}

fn infer_segment_width(content_lines: &[String]) -> usize {
    for line in content_lines {
        if let Some((char_idx, _)) = find_branch_char(line)
            && char_idx > 0
        {
            return char_idx;
        }
    }
    4
}

pub fn remap_error_lines(message: &str, line_map: &HashMap<usize, usize>) -> String {
    let mut out = String::with_capacity(message.len());
    let bytes = message.as_bytes();
    let n = bytes.len();
    let mut i = 0usize;
    while i < n {
        let word_boundary_before = i == 0 || !(bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_');
        if word_boundary_before && i + 4 <= n && bytes[i..i + 4].eq_ignore_ascii_case(b"line") {
            let mut j = i + 4;
            while j < n && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if j > i + 4 && j < n && bytes[j].is_ascii_digit() {
                let num_start = j;
                while j < n && bytes[j].is_ascii_digit() {
                    j += 1;
                }
                let word_boundary_after = j == n || !(bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_');
                if word_boundary_after
                    && let Ok(parsed) = message[num_start..j].parse::<usize>()
                    && let Some(&orig) = line_map.get(&parsed)
                {
                    out.push_str(&format!("line {orig}"));
                    i = j;
                    continue;
                }
            }
        }
        let ch = message[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

pub fn line_start(text: &str, line: usize) -> usize {
    let mut at = 0usize;
    for _ in 1..line {
        match text[at..].find('\n') {
            Some(rel) => at += rel + 1,
            None => return text.len(),
        }
    }
    at
}

pub fn char_to_byte_offset(text: &str, line_byte_start: usize, char_col: usize) -> usize {
    let rest = &text[line_byte_start..];
    match rest.char_indices().nth(char_col) {
        Some((byte_rel, _)) => line_byte_start + byte_rel,
        None => text.len(),
    }
}

fn fail(input: &str, index: usize, message: &str, origin: Option<&SourceMap<'_>>) -> PeleError {
    let loc = locate(input, line_start(input, index + 1), origin);
    let mut err = PeleError::new(format!("Line {}: {message}", loc.line), ErrorCode::Syntax).with_diagram_type(DiagramType::TreeView);
    err.line = loc.line;
    err
}

/// Undo four-space tab expansion (in character coordinates).
fn before_tabs(line: &str, at: usize) -> usize {
    let mut i = 0usize;
    let mut n = 0usize;
    for ch in line.chars() {
        if n >= at {
            break;
        }
        n += if ch == '\t' { 4 } else { 1 };
        i += 1;
    }
    i
}

pub fn preprocess_box_drawing(input: &str, origin: Option<&SourceMap<'_>>) -> Result<PreprocessResult, PeleError> {
    let mut line_map = HashMap::new();
    let mut columns = HashMap::new();
    if !input.chars().any(is_box_char) {
        return Ok(PreprocessResult {
            text: input.to_string(),
            line_map,
            columns,
        });
    }
    let lines: Vec<&str> = input.split('\n').collect();
    let Some(keyword_idx) = lines.iter().position(|line| line.trim() == "treeView-beta") else {
        return Ok(PreprocessResult {
            text: input.to_string(),
            line_map,
            columns,
        });
    };

    let passes = |line: &str| line.trim().is_empty() || is_comment_line(line) || is_metadata_line(line);

    let mut content_lines: Vec<String> = Vec::new();
    for &line in &lines[keyword_idx + 1..] {
        if passes(line) || is_decoration_only(line) {
            continue;
        }
        content_lines.push(line.replace('\t', "    "));
    }
    if !is_box_drawing_format(&content_lines) {
        return Ok(PreprocessResult {
            text: input.to_string(),
            line_map,
            columns,
        });
    }

    let segment_width = infer_segment_width(&content_lines);
    let mut out: Vec<String> = Vec::new();

    for (i, &line) in lines.iter().enumerate().take(keyword_idx + 1) {
        out.push(line.to_string());
        line_map.insert(out.len(), i + 1);
    }

    for (i, &line) in lines.iter().enumerate().skip(keyword_idx + 1) {
        if passes(line) {
            out.push(line.to_string());
            line_map.insert(out.len(), i + 1);
            continue;
        }
        if is_decoration_only(line) {
            continue;
        }
        let normalized = line.replace('\t', "    ");
        if let Some((branch_chars, branch_bytes)) = find_branch_char(&normalized) {
            let depth = ((branch_chars as f64) / (segment_width as f64)).round() as usize + 1;
            let branch_ch = normalized[branch_bytes..].chars().next().unwrap();
            let mut pos_bytes = branch_bytes + branch_ch.len_utf8();
            let mut pos_chars = branch_chars + 1;
            while pos_bytes < normalized.len() {
                let ch = normalized[pos_bytes..].chars().next().unwrap();
                if is_dash_char(ch) {
                    pos_bytes += ch.len_utf8();
                    pos_chars += 1;
                } else {
                    break;
                }
            }
            while pos_bytes < normalized.len() && normalized.as_bytes()[pos_bytes] == b' ' {
                pos_bytes += 1;
                pos_chars += 1;
            }
            let content = normalized[pos_bytes..].trim_end();
            if content.is_empty() {
                return Err(fail(
                    input,
                    i,
                    "Empty node — expected a filename or directory name after the box-drawing prefix",
                    origin,
                ));
            }
            let indent = INDENT_UNIT.repeat(depth);
            let indent_len = indent.len();
            out.push(format!("{indent}{content}"));
            let out_line = out.len();
            line_map.insert(out_line, i + 1);
            columns.insert(
                out_line,
                ColumnMap {
                    original_line: line.to_string(),
                    pos_chars,
                    indent_len,
                },
            );
        } else if is_box_only(&normalized) {
            continue;
        } else if normalized.chars().any(is_box_char) {
            out.push(line.to_string());
            line_map.insert(out.len(), i + 1);
        } else if normalized.chars().next().is_some_and(is_space_char) {
            return Err(fail(
                input,
                i,
                "Unexpected indentation without box-drawing characters. In box-drawing format, use ├── or └── prefixes for indented nodes.",
                origin,
            ));
        } else {
            out.push(line.to_string());
            line_map.insert(out.len(), i + 1);
        }
    }

    Ok(PreprocessResult {
        text: out.join("\n"),
        line_map,
        columns,
    })
}
