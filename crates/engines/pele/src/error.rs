use std::cell::OnceCell;
use std::fmt;

use crate::detect::{Detected, DiagramType, MermaidType};
use crate::text::entities::written_codes;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    UnsupportedDiagram,
    Syntax,
    Semantic,
    Limit,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnsupportedDiagram => "unsupported-diagram",
            Self::Syntax => "syntax",
            Self::Semantic => "semantic",
            Self::Limit => "limit",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeleError {
    pub message: String,
    pub code: ErrorCode,
    pub diagram_type: Option<DiagramType>,
    pub mermaid_type: Option<MermaidType>,
    pub line: usize,
    pub column: usize,
    pub snippet: String,
}

impl PeleError {
    pub fn new(message: impl Into<String>, code: ErrorCode) -> Self {
        Self {
            message: message.into(),
            code,
            diagram_type: None,
            mermaid_type: None,
            line: 0,
            column: 0,
            snippet: String::new(),
        }
    }

    pub fn with_detected(mut self, detected: Detected) -> Self {
        if self.diagram_type.is_none() {
            self.diagram_type = Some(detected.diagram_type);
        }
        if self.mermaid_type.is_none() {
            self.mermaid_type = Some(detected.mermaid_type);
        }
        self
    }

    pub fn with_diagram_type(mut self, diagram_type: DiagramType) -> Self {
        self.diagram_type = Some(diagram_type);
        self
    }

    pub fn with_location(mut self, location: SourceLocation) -> Self {
        self.line = location.line;
        self.column = location.column;
        self.snippet = location.snippet;
        self
    }

    pub fn restore_written_codes(mut self) -> Self {
        let message = written_codes(&self.message);
        if message != self.message {
            self.message = message;
        }
        let snippet = written_codes(&self.snippet);
        if snippet != self.snippet {
            self.snippet = snippet;
        }
        self
    }
}

impl fmt::Display for PeleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for PeleError {}

/// Byte range `[from, to)` in the input replaced by `length` bytes in the output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Edit {
    pub from: usize,
    pub to: usize,
    pub length: usize,
}

impl Edit {
    pub const fn new(from: usize, to: usize, length: usize) -> Self {
        Self { from, to, length }
    }
}

fn step_input(edits: &[Edit], at: usize) -> usize {
    let mut shift: isize = 0;
    for edit in edits {
        let start = (edit.from as isize - shift) as usize;
        if at < start {
            break;
        }
        if at < start + edit.length {
            let max_delta = edit.to.saturating_sub(edit.from).saturating_sub(1);
            return edit.from + (at - start).min(max_delta);
        }
        shift += (edit.to as isize - edit.from as isize) - edit.length as isize;
    }
    (at as isize + shift).max(0) as usize
}

pub fn input_offset(steps: &[Vec<Edit>], mut at: usize) -> usize {
    for step in steps.iter().rev() {
        at = step_input(step, at);
    }
    at
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceLocation {
    pub line: usize,
    pub column: usize,
    pub snippet: String,
}

/// Lazily maps byte offsets in preprocessed source back to the user's original normalized text.
pub struct SourceMap<'a> {
    pub parsed: &'a str,
    raw_input: &'a str,
    keep_comments: bool,
    computed: OnceCell<(String, Vec<Vec<Edit>>)>,
}

impl<'a> SourceMap<'a> {
    pub fn new(parsed: &'a str, raw_input: &'a str, keep_comments: bool) -> Self {
        Self {
            parsed,
            raw_input,
            keep_comments,
            computed: OnceCell::new(),
        }
    }

    pub fn resolve(&self, src: &'a str, offset: usize) -> (&str, usize) {
        if std::ptr::eq(src.as_ptr(), self.parsed.as_ptr()) && src.len() == self.parsed.len() {
            let (original, steps) = self.computed.get_or_init(|| {
                let mut steps = Vec::new();
                if let Ok(pre) = crate::preprocess::preprocess(self.raw_input, Some(&mut steps)) {
                    let body = if self.keep_comments {
                        pre.with_comments
                    } else {
                        crate::preprocess::cleanup_comments(&pre.with_comments, Some(&mut steps))
                    };
                    let _ = crate::preprocess::encode_entities(&body, Some(&mut steps));
                }
                let mut orig = crate::preprocess::normalize_line_breaks(self.raw_input);
                orig.push('\n');
                (orig, steps)
            });
            let mapped = input_offset(steps, offset).min(original.len());
            (original.as_str(), mapped)
        } else {
            (src, offset.min(src.len()))
        }
    }
}

pub fn locate(src: &str, offset: usize, origin: Option<&SourceMap<'_>>) -> SourceLocation {
    // Keep EOF errors on the last content line.
    let trimmed_end = src.trim_end().len();
    let (resolved_src, resolved_offset) = if trimmed_end > 0 && offset >= trimmed_end {
        let last_char_start = prev_char_boundary(src, trimmed_end);
        let (s, off) = match origin {
            Some(map) => map.resolve(src, last_char_start),
            None => (src, last_char_start),
        };
        let next = next_char_boundary(s, off);
        (s, next)
    } else {
        match origin {
            Some(map) => map.resolve(src, offset),
            None => (src, offset.min(src.len())),
        }
    };

    let off = floor_char_boundary(resolved_src, resolved_offset);
    let mut line = 1usize;
    let mut line_start = 0usize;
    for (idx, ch) in resolved_src[..off].char_indices() {
        if ch == '\n' {
            line += 1;
            line_start = idx + 1;
        }
    }
    let line_end = resolved_src[off..].find('\n').map_or(resolved_src.len(), |rel| off + rel);
    let column = resolved_src[line_start..off].chars().count() + 1;
    let text = &resolved_src[line_start..line_end];
    let snippet = format!("{text}\n{}^", "-".repeat(column.saturating_sub(1)));
    SourceLocation { line, column, snippet }
}

pub fn syntax_error(diagram_type: DiagramType, src: &str, offset: usize, detail: &str, lexical: bool, origin: Option<&SourceMap<'_>>) -> PeleError {
    let loc = locate(src, offset, origin);
    let message = if lexical {
        format!("Lexical error on line {}. Unrecognized text.\n{}", loc.line, loc.snippet)
    } else {
        format!("Parse error on line {}:\n{}\n{detail}", loc.line, loc.snippet)
    };
    PeleError::new(message, ErrorCode::Syntax).with_diagram_type(diagram_type).with_location(loc)
}

fn floor_char_boundary(s: &str, mut idx: usize) -> usize {
    idx = idx.min(s.len());
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

fn prev_char_boundary(s: &str, idx: usize) -> usize {
    let mut i = idx.min(s.len()).saturating_sub(1);
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn next_char_boundary(s: &str, idx: usize) -> usize {
    let mut i = idx.min(s.len());
    if i < s.len() {
        i += 1;
        while i < s.len() && !s.is_char_boundary(i) {
            i += 1;
        }
    }
    i
}
