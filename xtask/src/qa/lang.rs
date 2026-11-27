//! Pure-Rust zero-dependency lexer, structural extractor, complexity calculator,
//! token normalizer, module relation extractor, and source locator for Rust and TypeScript/TSX.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::qa::{FormInfo, FormKind, Lang, Visibility, normalize_posix_path, stable_hash_hex, to_rel_posix};
use crate::rust_scan::{LineIndex, is_cfg_test_predicate, is_ident_char, is_ident_start};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TokenKind {
    Ident,
    Keyword,
    Op,
    Punct,
    Lit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub kind: TokenKind,
    pub text: String,
    pub start_byte: usize,
    pub end_byte: usize,
    pub line: usize,
    pub col: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ComplexityResult {
    pub cc: usize,
    pub flat_match_arms: usize,
    pub is_flat_match: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RelationKind {
    Dependency,
    Implements,
    Association,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModuleRelation {
    pub from_namespace: String,
    pub to_namespace: String,
    pub kind: RelationKind,
    pub file: String,
    pub line: usize,
    pub raw_target: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TypeDecl {
    pub namespace: String,
    pub name: String,
    pub kind: String,
    pub file: String,
    pub line: usize,
    pub fields: Vec<String>,
    pub ops: Vec<String>,
    pub bases: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileAnalysis {
    pub file: String,
    pub lang: Lang,
    pub module_namespace: String,
    pub forms: Vec<FormInfo>,
    pub types: Vec<TypeDecl>,
    pub relations: Vec<ModuleRelation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceLine {
    pub line: usize,
    pub text: String,
    pub highlight: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceLocation {
    pub file: String,
    pub lang: Lang,
    pub start_line: usize,
    pub end_line: usize,
    pub target_line: usize,
    pub snippet: Vec<SourceLine>,
}

struct LineTracker {
    line: usize,
    line_start_byte: usize,
}

impl LineTracker {
    fn new() -> Self {
        Self { line: 1, line_start_byte: 0 }
    }

    fn advance(&mut self, bytes: &[u8], from: usize, to: usize) {
        for (idx, &b) in bytes[from..to].iter().enumerate() {
            if b == b'\n' {
                self.line += 1;
                self.line_start_byte = from + idx + 1;
            }
        }
    }

    fn col_at(&self, byte_offset: usize) -> usize {
        byte_offset.saturating_sub(self.line_start_byte) + 1
    }
}

fn next_char_len(bytes: &[u8], idx: usize) -> usize {
    if idx >= bytes.len() {
        return 0;
    }
    let first = bytes[idx];
    if first < 0x80 {
        1
    } else if first & 0b1110_0000 == 0b1100_0000 {
        2.min(bytes.len() - idx)
    } else if first & 0b1111_0000 == 0b1110_0000 {
        3.min(bytes.len() - idx)
    } else {
        4.min(bytes.len() - idx)
    }
}

fn is_rust_keyword(word: &str) -> bool {
    matches!(
        word,
        "as" | "async"
            | "await"
            | "break"
            | "const"
            | "continue"
            | "crate"
            | "dyn"
            | "else"
            | "enum"
            | "extern"
            | "fn"
            | "for"
            | "if"
            | "impl"
            | "in"
            | "let"
            | "loop"
            | "match"
            | "mod"
            | "move"
            | "mut"
            | "pub"
            | "ref"
            | "return"
            | "self"
            | "Self"
            | "static"
            | "struct"
            | "super"
            | "trait"
            | "type"
            | "unsafe"
            | "use"
            | "where"
            | "while"
    )
}

fn is_ts_keyword(word: &str) -> bool {
    matches!(
        word,
        "abstract"
            | "as"
            | "async"
            | "await"
            | "break"
            | "case"
            | "catch"
            | "class"
            | "const"
            | "continue"
            | "debugger"
            | "declare"
            | "default"
            | "delete"
            | "do"
            | "else"
            | "enum"
            | "export"
            | "extends"
            | "finally"
            | "for"
            | "from"
            | "function"
            | "get"
            | "if"
            | "implements"
            | "import"
            | "in"
            | "instanceof"
            | "interface"
            | "let"
            | "namespace"
            | "new"
            | "of"
            | "override"
            | "private"
            | "protected"
            | "public"
            | "readonly"
            | "return"
            | "satisfies"
            | "set"
            | "static"
            | "super"
            | "switch"
            | "this"
            | "throw"
            | "try"
            | "type"
            | "typeof"
            | "var"
            | "void"
            | "while"
            | "with"
            | "yield"
    )
}

fn is_literal_word(word: &str, lang: Lang) -> bool {
    match lang {
        Lang::Rust => matches!(word, "true" | "false"),
        Lang::TypeScript => matches!(word, "true" | "false" | "null" | "undefined"),
    }
}

pub fn tokenize(source: &str, lang: Lang) -> Vec<Token> {
    match lang {
        Lang::Rust => tokenize_rust(source),
        Lang::TypeScript => tokenize_ts(source),
    }
}

fn scan_number(source: &str, start: usize, allow_bigint: bool) -> usize {
    let bytes = source.as_bytes();
    let len = bytes.len();
    let mut i = start;

    if bytes[i] == b'0' && matches!(bytes.get(i + 1), Some(b'x' | b'X' | b'b' | b'B' | b'o' | b'O')) {
        i += 2;
        while i < len && (bytes[i].is_ascii_hexdigit() || bytes[i] == b'_') {
            i += 1;
        }
    } else {
        while i < len && (bytes[i].is_ascii_digit() || bytes[i] == b'_') {
            i += 1;
        }
        if bytes.get(i) == Some(&b'.') && bytes.get(i + 1).is_some_and(u8::is_ascii_digit) {
            i += 1;
            while i < len && (bytes[i].is_ascii_digit() || bytes[i] == b'_') {
                i += 1;
            }
        }
        if matches!(bytes.get(i), Some(b'e' | b'E')) {
            let mut exp = i + 1;
            if matches!(bytes.get(exp), Some(b'+' | b'-')) {
                exp += 1;
            }
            if bytes.get(exp).is_some_and(u8::is_ascii_digit) {
                i = exp + 1;
                while i < len && (bytes[i].is_ascii_digit() || bytes[i] == b'_') {
                    i += 1;
                }
            }
        }
    }

    if allow_bigint && bytes.get(i) == Some(&b'n') {
        i += 1;
    } else if !allow_bigint && bytes.get(i).is_some_and(|&b| is_ident_start(b)) {
        while i < len && is_ident_char(bytes[i]) {
            i += 1;
        }
    }

    i
}

fn tokenize_rust(source: &str) -> Vec<Token> {
    let bytes = source.as_bytes();
    let len = bytes.len();
    let mut tokens = Vec::new();
    let mut tracker = LineTracker::new();
    let mut i = 0usize;

    while i < len {
        let ch = bytes[i];
        let next = bytes.get(i + 1).copied();

        if ch.is_ascii_whitespace() {
            let start = i;
            i += 1;
            while i < len && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            tracker.advance(bytes, start, i);
            continue;
        }

        if ch == b'/' && next == Some(b'/') {
            let start = i;
            i += 2;
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
            tracker.advance(bytes, start, i);
            continue;
        }

        if ch == b'/' && next == Some(b'*') {
            let start = i;
            i += 2;
            let mut depth = 1usize;
            while i < len && depth > 0 {
                if bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'*') {
                    depth += 1;
                    i += 2;
                } else if bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/') {
                    depth -= 1;
                    i += 2;
                } else {
                    i += next_char_len(bytes, i);
                }
            }
            tracker.advance(bytes, start, i);
            continue;
        }

        let prev_is_ident = i > 0 && is_ident_char(bytes[i - 1]);

        // Rust raw strings: r"...", r#"..."#, br#"..."#, cr#"..."#
        if !prev_is_ident && ((ch == b'r' && (next == Some(b'"') || next == Some(b'#'))) || ((ch == b'b' || ch == b'c') && next == Some(b'r'))) {
            let start = i;
            let mut cursor = if ch == b'r' { i + 1 } else { i + 2 };
            let mut hashes = 0usize;
            while cursor < len && bytes[cursor] == b'#' {
                hashes += 1;
                cursor += 1;
            }
            if bytes.get(cursor) == Some(&b'"') {
                let line = tracker.line;
                let col = tracker.col_at(start);
                cursor += 1;
                while cursor < len {
                    if bytes[cursor] == b'"' {
                        let mut matched = 0usize;
                        while matched < hashes && bytes.get(cursor + 1 + matched) == Some(&b'#') {
                            matched += 1;
                        }
                        if matched == hashes {
                            cursor += 1 + hashes;
                            break;
                        }
                    }
                    cursor += next_char_len(bytes, cursor);
                }
                tokens.push(Token {
                    kind: TokenKind::Lit,
                    text: source[start..cursor].to_owned(),
                    start_byte: start,
                    end_byte: cursor,
                    line,
                    col,
                });
                tracker.advance(bytes, start, cursor);
                i = cursor;
                continue;
            }
        }

        // Rust raw identifier: r#ident
        if !prev_is_ident && ch == b'r' && next == Some(b'#') && bytes.get(i + 2).copied().is_some_and(is_ident_start) {
            let start = i;
            let line = tracker.line;
            let col = tracker.col_at(start);
            i += 2;
            while i < len && is_ident_char(bytes[i]) {
                i += 1;
            }
            tokens.push(Token {
                kind: TokenKind::Ident,
                text: source[start..i].to_owned(),
                start_byte: start,
                end_byte: i,
                line,
                col,
            });
            continue;
        }

        // Rust normal/byte/c string literals
        if ch == b'"' || (!prev_is_ident && (ch == b'b' || ch == b'c') && next == Some(b'"')) {
            let start = i;
            let line = tracker.line;
            let col = tracker.col_at(start);
            i = if ch == b'"' { i + 1 } else { i + 2 };
            while i < len {
                if bytes[i] == b'\\' {
                    i += 1;
                    i += next_char_len(bytes, i);
                    continue;
                }
                if bytes[i] == b'"' {
                    i += 1;
                    break;
                }
                i += next_char_len(bytes, i);
            }
            tokens.push(Token {
                kind: TokenKind::Lit,
                text: source[start..i].to_owned(),
                start_byte: start,
                end_byte: i,
                line,
                col,
            });
            tracker.advance(bytes, start, i);
            continue;
        }

        // Rust char/byte literals (distinguished from lifetimes like 'a or 'static)
        if ch == b'\'' || (!prev_is_ident && ch == b'b' && next == Some(b'\'')) {
            let start = i;
            let quote_pos = if ch == b'\'' { i } else { i + 1 };
            let after_quote = bytes.get(quote_pos + 1).copied();
            if after_quote == Some(b'\\') {
                let line = tracker.line;
                let col = tracker.col_at(start);
                let mut cursor = quote_pos + 2;
                while cursor < len && bytes[cursor] != b'\n' {
                    if bytes[cursor] == b'\\' {
                        cursor += 1;
                        cursor += next_char_len(bytes, cursor);
                        continue;
                    }
                    if bytes[cursor] == b'\'' {
                        cursor += 1;
                        break;
                    }
                    cursor += next_char_len(bytes, cursor);
                }
                tokens.push(Token {
                    kind: TokenKind::Lit,
                    text: source[start..cursor].to_owned(),
                    start_byte: start,
                    end_byte: cursor,
                    line,
                    col,
                });
                tracker.advance(bytes, start, cursor);
                i = cursor;
                continue;
            }
            if let Some(after) = after_quote
                && after != b'\''
                && after != b'\n'
                && let Some(scalar) = source[quote_pos + 1..].chars().next()
            {
                let close_pos = quote_pos + 1 + scalar.len_utf8();
                if bytes.get(close_pos) == Some(&b'\'') {
                    let end = close_pos + 1;
                    let line = tracker.line;
                    let col = tracker.col_at(start);
                    tokens.push(Token {
                        kind: TokenKind::Lit,
                        text: source[start..end].to_owned(),
                        start_byte: start,
                        end_byte: end,
                        line,
                        col,
                    });
                    tracker.advance(bytes, start, end);
                    i = end;
                    continue;
                }
            }
        }

        if ch.is_ascii_digit() {
            let start = i;
            let line = tracker.line;
            let col = tracker.col_at(start);
            i = scan_number(source, start, false);
            tokens.push(Token {
                kind: TokenKind::Lit,
                text: source[start..i].to_owned(),
                start_byte: start,
                end_byte: i,
                line,
                col,
            });
            continue;
        }

        if is_ident_start(ch) {
            let start = i;
            let line = tracker.line;
            let col = tracker.col_at(start);
            i += 1;
            while i < len && is_ident_char(bytes[i]) {
                i += 1;
            }
            let text = &source[start..i];
            let kind = if is_literal_word(text, Lang::Rust) {
                TokenKind::Lit
            } else if is_rust_keyword(text) {
                TokenKind::Keyword
            } else {
                TokenKind::Ident
            };
            tokens.push(Token {
                kind,
                text: text.to_owned(),
                start_byte: start,
                end_byte: i,
                line,
                col,
            });
            continue;
        }

        let start = i;
        let line = tracker.line;
        let col = tracker.col_at(start);
        let rest = &source[i..];

        if let Some(op) = ["..=", "<<=", ">>=", "..."].into_iter().find(|op| rest.starts_with(op)) {
            i += op.len();
            tokens.push(Token {
                kind: TokenKind::Op,
                text: op.to_owned(),
                start_byte: start,
                end_byte: i,
                line,
                col,
            });
            continue;
        }

        if rest.starts_with("::") {
            i += 2;
            tokens.push(Token {
                kind: TokenKind::Punct,
                text: "::".to_owned(),
                start_byte: start,
                end_byte: i,
                line,
                col,
            });
            continue;
        }

        if let Some(op) = [
            "==", "!=", "<=", ">=", "&&", "||", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<", ">>", "=>", "->", "..",
        ]
        .into_iter()
        .find(|op| rest.starts_with(op))
        {
            i += op.len();
            tokens.push(Token {
                kind: TokenKind::Op,
                text: op.to_owned(),
                start_byte: start,
                end_byte: i,
                line,
                col,
            });
            continue;
        }

        let step = next_char_len(bytes, i);
        let text = source[i..i + step].to_owned();
        let kind = if matches!(
            ch,
            b'+' | b'-' | b'*' | b'/' | b'%' | b'!' | b'<' | b'>' | b'=' | b'&' | b'|' | b'^' | b'~' | b'?'
        ) {
            TokenKind::Op
        } else {
            TokenKind::Punct
        };
        i += step;
        tokens.push(Token {
            kind,
            text,
            start_byte: start,
            end_byte: i,
            line,
            col,
        });
    }

    tokens
}

fn ts_regex_allowed_after(prev: Option<&Token>) -> bool {
    let Some(tok) = prev else {
        return true;
    };
    match tok.kind {
        TokenKind::Punct => matches!(tok.text.as_str(), "(" | "[" | "{" | "," | ";" | ":" | "${"),
        TokenKind::Op => !matches!(tok.text.as_str(), "++" | "--"),
        TokenKind::Keyword => matches!(
            tok.text.as_str(),
            "return" | "throw" | "case" | "in" | "of" | "typeof" | "void" | "delete" | "await" | "yield" | "new" | "else" | "do" | "export" | "default"
        ),
        TokenKind::Ident | TokenKind::Lit => false,
    }
}

fn scan_ts_template_segment(source: &str, seg_start: usize, tracker: &mut LineTracker, tokens: &mut Vec<Token>) -> (usize, bool) {
    let bytes = source.as_bytes();
    let len = bytes.len();
    let line = tracker.line;
    let col = tracker.col_at(seg_start);
    let mut i = if bytes.get(seg_start) == Some(&b'`') || bytes.get(seg_start) == Some(&b'}') {
        seg_start + 1
    } else {
        seg_start
    };

    while i < len {
        if bytes[i] == b'\\' {
            i += 1;
            i += next_char_len(bytes, i);
            continue;
        }
        if bytes[i] == b'`' {
            i += 1;
            tokens.push(Token {
                kind: TokenKind::Lit,
                text: source[seg_start..i].to_owned(),
                start_byte: seg_start,
                end_byte: i,
                line,
                col,
            });
            tracker.advance(bytes, seg_start, i);
            return (i, false);
        }
        if bytes[i] == b'$' && bytes.get(i + 1) == Some(&b'{') {
            tokens.push(Token {
                kind: TokenKind::Lit,
                text: source[seg_start..i].to_owned(),
                start_byte: seg_start,
                end_byte: i,
                line,
                col,
            });
            tracker.advance(bytes, seg_start, i);
            let interp_line = tracker.line;
            let interp_col = tracker.col_at(i);
            tokens.push(Token {
                kind: TokenKind::Punct,
                text: "${".to_owned(),
                start_byte: i,
                end_byte: i + 2,
                line: interp_line,
                col: interp_col,
            });
            return (i + 2, true);
        }
        i += next_char_len(bytes, i);
    }

    tokens.push(Token {
        kind: TokenKind::Lit,
        text: source[seg_start..i].to_owned(),
        start_byte: seg_start,
        end_byte: i,
        line,
        col,
    });
    tracker.advance(bytes, seg_start, i);
    (i, false)
}

fn tokenize_ts(source: &str) -> Vec<Token> {
    let bytes = source.as_bytes();
    let len = bytes.len();
    let mut tokens = Vec::new();
    let mut tracker = LineTracker::new();
    let mut brace_depth = 0usize;
    let mut template_braces: Vec<usize> = Vec::new();
    let mut i = 0usize;

    while i < len {
        let ch = bytes[i];
        let next = bytes.get(i + 1).copied();

        if ch.is_ascii_whitespace() {
            let start = i;
            i += 1;
            while i < len && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            tracker.advance(bytes, start, i);
            continue;
        }

        if ch == b'/' && next == Some(b'/') {
            let start = i;
            i += 2;
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
            tracker.advance(bytes, start, i);
            continue;
        }

        if ch == b'/' && next == Some(b'*') {
            let start = i;
            i += 2;
            while i < len {
                if bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/') {
                    i += 2;
                    break;
                }
                i += next_char_len(bytes, i);
            }
            tracker.advance(bytes, start, i);
            continue;
        }

        // Template literal start
        if ch == b'`' {
            let (next_i, entered_interp) = scan_ts_template_segment(source, i, &mut tracker, &mut tokens);
            if entered_interp {
                brace_depth += 1;
                template_braces.push(brace_depth);
            }
            i = next_i;
            continue;
        }

        // Closing `}` of a `${ ... }` interpolation
        if ch == b'}' && template_braces.last() == Some(&brace_depth) {
            template_braces.pop();
            brace_depth = brace_depth.saturating_sub(1);
            let line = tracker.line;
            let col = tracker.col_at(i);
            tokens.push(Token {
                kind: TokenKind::Punct,
                text: "}".to_owned(),
                start_byte: i,
                end_byte: i + 1,
                line,
                col,
            });
            let (next_i, entered_interp) = scan_ts_template_segment(source, i, &mut tracker, &mut tokens);
            if entered_interp {
                brace_depth += 1;
                template_braces.push(brace_depth);
            }
            i = next_i;
            continue;
        }

        // String literals ('...' or "..."): bounded by raw newline so JSX text apostrophes never swallow code.
        if ch == b'"' || ch == b'\'' {
            let quote = ch;
            let start = i;
            let line = tracker.line;
            let col = tracker.col_at(start);
            i += 1;
            while i < len {
                if bytes[i] == b'\n' {
                    break;
                }
                if bytes[i] == b'\\' {
                    i += 1;
                    if i < len && bytes[i] == b'\n' {
                        i += 1;
                    } else {
                        i += next_char_len(bytes, i);
                    }
                    continue;
                }
                if bytes[i] == quote {
                    i += 1;
                    break;
                }
                i += next_char_len(bytes, i);
            }
            tokens.push(Token {
                kind: TokenKind::Lit,
                text: source[start..i].to_owned(),
                start_byte: start,
                end_byte: i,
                line,
                col,
            });
            tracker.advance(bytes, start, i);
            continue;
        }

        // Regex literal vs division
        if ch == b'/' && next != Some(b'=') && ts_regex_allowed_after(tokens.last()) {
            let start = i;
            let line = tracker.line;
            let col = tracker.col_at(start);
            let mut cursor = i + 1;
            let mut in_class = false;
            let mut closed = false;
            while cursor < len {
                let b = bytes[cursor];
                if b == b'\n' {
                    break;
                }
                if b == b'\\' {
                    cursor += 1;
                    if cursor < len && bytes[cursor] != b'\n' {
                        cursor += next_char_len(bytes, cursor);
                    }
                    continue;
                }
                if b == b'[' {
                    in_class = true;
                } else if b == b']' {
                    in_class = false;
                } else if b == b'/' && !in_class {
                    cursor += 1;
                    closed = true;
                    break;
                }
                cursor += next_char_len(bytes, cursor);
            }
            if closed {
                while cursor < len && bytes[cursor].is_ascii_alphabetic() {
                    cursor += 1;
                }
                tokens.push(Token {
                    kind: TokenKind::Lit,
                    text: source[start..cursor].to_owned(),
                    start_byte: start,
                    end_byte: cursor,
                    line,
                    col,
                });
                i = cursor;
                continue;
            }
        }

        if ch.is_ascii_digit() || (ch == b'.' && next.is_some_and(|b| b.is_ascii_digit())) {
            let start = i;
            let line = tracker.line;
            let col = tracker.col_at(start);
            i = scan_number(source, start, true);
            tokens.push(Token {
                kind: TokenKind::Lit,
                text: source[start..i].to_owned(),
                start_byte: start,
                end_byte: i,
                line,
                col,
            });
            continue;
        }

        // Private class member identifier `#name` or regular identifier / `$ident`
        if is_ident_start(ch) || ch == b'$' || (ch == b'#' && next.is_some_and(|b| is_ident_start(b) || b == b'$')) {
            let start = i;
            let line = tracker.line;
            let col = tracker.col_at(start);
            i += 1;
            while i < len && (is_ident_char(bytes[i]) || bytes[i] == b'$') {
                i += 1;
            }
            let text = &source[start..i];
            let kind = if is_literal_word(text, Lang::TypeScript) {
                TokenKind::Lit
            } else if is_ts_keyword(text) {
                TokenKind::Keyword
            } else {
                TokenKind::Ident
            };
            tokens.push(Token {
                kind,
                text: text.to_owned(),
                start_byte: start,
                end_byte: i,
                line,
                col,
            });
            continue;
        }

        let start = i;
        let line = tracker.line;
        let col = tracker.col_at(start);
        let rest = &source[i..];

        if let Some(op) = [
            ">>>=", "===", "!==", "??=", "**=", ">>>", "<<=", ">>=", "...", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "+=", "-=", "*=", "/=", "%=", "&=",
            "|=", "^=", "<<", ">>", "**", "++", "--", "=>",
        ]
        .into_iter()
        .find(|op| rest.starts_with(op))
        {
            i += op.len();
            tokens.push(Token {
                kind: TokenKind::Op,
                text: op.to_owned(),
                start_byte: start,
                end_byte: i,
                line,
                col,
            });
            continue;
        }

        if ch == b'{' {
            brace_depth += 1;
        } else if ch == b'}' {
            brace_depth = brace_depth.saturating_sub(1);
        }

        let step = next_char_len(bytes, i);
        let text = source[i..i + step].to_owned();
        let kind = if matches!(
            ch,
            b'+' | b'-' | b'*' | b'/' | b'%' | b'!' | b'<' | b'>' | b'=' | b'&' | b'|' | b'^' | b'~' | b'?'
        ) {
            TokenKind::Op
        } else {
            TokenKind::Punct
        };
        i += step;
        tokens.push(Token {
            kind,
            text,
            start_byte: start,
            end_byte: i,
            line,
            col,
        });
    }

    tokens
}

pub fn rust_module_namespace(rel_posix: &str) -> String {
    let normalized = normalize_posix_path(rel_posix);
    let after_src = if let Some((_, rest)) = normalized.split_once("/src/") {
        rest
    } else if let Some(rest) = normalized.strip_prefix("src/") {
        rest
    } else {
        normalized.as_str()
    };
    let stem = after_src.strip_suffix(".rs").unwrap_or(after_src);
    let parts: Vec<&str> = stem.split('/').filter(|p| !p.is_empty()).collect();
    let trimmed = if parts.last().is_some_and(|&p| p == "mod") {
        &parts[..parts.len() - 1]
    } else {
        &parts[..]
    };
    if trimmed.is_empty() || trimmed == ["lib"] || trimmed == ["main"] {
        "crate".to_owned()
    } else {
        format!("crate::{}", trimmed.join("::"))
    }
}

pub fn ts_module_namespace(rel_posix: &str) -> String {
    let normalized = normalize_posix_path(rel_posix);
    let stripped = if let Some(rest) = normalized.strip_prefix("apps/mac/ui/") {
        rest
    } else if let Some(rest) = normalized.strip_prefix("apps/mobile/src/") {
        rest
    } else if let Some(rest) = normalized.strip_prefix("apps/site/src/") {
        rest
    } else if let Some(rest) = normalized.strip_prefix("packages/") {
        if let Some((_, inner)) = rest.split_once("/src/") {
            inner
        } else if let Some((_, inner)) = rest.split_once('/') {
            inner
        } else {
            rest
        }
    } else if let Some((_, inner)) = normalized.split_once("/src/") {
        inner
    } else if let Some(inner) = normalized.strip_prefix("src/") {
        inner
    } else {
        normalized.as_str()
    };

    let stem = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs"]
        .into_iter()
        .find_map(|ext| stripped.strip_suffix(ext))
        .unwrap_or(stripped);
    let mut parts: Vec<&str> = stem.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() > 1 && parts.last().is_some_and(|&p| p == "index") {
        parts.pop();
    }
    if parts.is_empty() { "index".to_owned() } else { parts.join(".") }
}

pub fn extract_forms(root: &Path, file: &Path, source: &str, lang: Lang) -> Vec<FormInfo> {
    analyze_file(root, file, source, lang).forms
}

pub fn analyze_file(root: &Path, file: &Path, source: &str, lang: Lang) -> FileAnalysis {
    let rel = to_rel_posix(root, file);
    let tokens = tokenize(source, lang);
    match lang {
        Lang::Rust => analyze_rust(&rel, source, &tokens),
        Lang::TypeScript => analyze_ts(&rel, source, &tokens),
    }
}

fn find_matching_delim(tokens: &[Token], open_idx: usize, open: &str, close: &str) -> usize {
    let mut depth = 0usize;
    for (idx, tok) in tokens.iter().enumerate().skip(open_idx) {
        if tok.text == open {
            depth += 1;
        } else if tok.text == close {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return idx;
            }
        }
    }
    tokens.len().saturating_sub(1)
}

fn skip_angle_generics(tokens: &[Token], idx: usize) -> usize {
    if !tokens.get(idx).is_some_and(|t| t.text == "<") {
        return idx;
    }
    let mut depth = 0usize;
    let mut i = idx;
    while i < tokens.len() {
        match tokens[i].text.as_str() {
            "<" => depth += 1,
            ">" => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return i + 1;
                }
            }
            ">>" if depth >= 2 => {
                depth -= 2;
                if depth == 0 {
                    return i + 1;
                }
            }
            ";" | "{" if depth == 0 => return i,
            _ => {}
        }
        i += 1;
    }
    idx
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RustScope {
    Mod(String),
    Impl(String),
    FnBody,
    TestItem,
    Other,
}

fn has_file_cfg_test(source: &str, tokens: &[Token]) -> bool {
    let mut i = 0usize;
    while i < tokens.len() {
        if tokens[i].text == "#" && tokens.get(i + 1).is_some_and(|t| t.text == "!") && tokens.get(i + 2).is_some_and(|t| t.text == "[") {
            let close = find_matching_delim(tokens, i + 2, "[", "]");
            let inner = &source[tokens[i + 2].end_byte..tokens[close].start_byte];
            if let Some(cfg) = inner
                .trim()
                .strip_prefix("cfg")
                .and_then(|s| s.trim_start().strip_prefix('('))
                .and_then(|s| s.strip_suffix(')'))
                && is_cfg_test_predicate(cfg)
            {
                return true;
            }
            i = close + 1;
            continue;
        }
        if tokens[i].text == "#" && tokens.get(i + 1).is_some_and(|t| t.text == "[") {
            let close = find_matching_delim(tokens, i + 1, "[", "]");
            i = close + 1;
            continue;
        }
        break;
    }
    false
}

fn parse_rust_visibility_before(tokens: &[Token], mut idx: usize) -> (Visibility, usize) {
    // Walk back across fn qualifiers (`default`, `const`, `async`, `unsafe`, `extern "..."`)
    while idx > 0 {
        let prev = &tokens[idx - 1];
        if prev.kind == TokenKind::Keyword && matches!(prev.text.as_str(), "const" | "async" | "unsafe" | "extern") {
            idx -= 1;
            continue;
        }
        if prev.kind == TokenKind::Ident && prev.text == "default" {
            idx -= 1;
            continue;
        }
        if prev.kind == TokenKind::Lit && idx >= 2 && tokens[idx - 2].text == "extern" {
            idx -= 2;
            continue;
        }
        break;
    }
    if idx > 0 && tokens[idx - 1].text == "pub" {
        return (Visibility::Public, idx - 1);
    }
    if idx > 0 && tokens[idx - 1].text == ")" {
        let mut depth = 0usize;
        for k in (0..idx).rev() {
            if tokens[k].text == ")" {
                depth += 1;
            } else if tokens[k].text == "(" {
                depth -= 1;
                if depth == 0 {
                    if k > 0 && tokens[k - 1].text == "pub" {
                        return (Visibility::Public, k - 1);
                    }
                    break;
                }
            }
        }
    }
    (Visibility::Private, idx)
}

fn rust_item_start_line(tokens: &[Token], item_idx: usize) -> usize {
    tokens[item_idx].line
}

fn parse_rust_impl_target(tokens: &[Token], impl_idx: usize) -> (Option<(String, String)>, String, usize) {
    let mut i = impl_idx + 1;
    i = skip_angle_generics(tokens, i);
    let mut brace_idx = i;
    while brace_idx < tokens.len() && tokens[brace_idx].text != "{" && tokens[brace_idx].text != ";" {
        brace_idx += 1;
    }
    let header = &tokens[i..brace_idx];
    let mut depth = 0usize;
    let mut for_pos = None;
    for (pos, tok) in header.iter().enumerate() {
        match tok.text.as_str() {
            "<" | "(" | "[" => depth += 1,
            ">" | ")" | "]" => depth = depth.saturating_sub(1),
            "for" if depth == 0 => {
                for_pos = Some(pos);
                break;
            }
            "where" if depth == 0 => break,
            _ => {}
        }
    }

    let extract_type_path = |slice: &[Token]| -> (String, String) {
        let end = slice.iter().position(|t| t.text == "where").unwrap_or(slice.len());
        let before_where = &slice[..end];
        let mut segs: Vec<String> = Vec::new();
        let mut expect_seg = true;
        let mut angle = 0usize;
        let mut paren = 0usize;
        for tok in before_where {
            match tok.text.as_str() {
                "<" => {
                    angle += 1;
                    expect_seg = false;
                }
                ">" => {
                    angle = angle.saturating_sub(1);
                }
                "(" => {
                    paren += 1;
                    expect_seg = false;
                }
                ")" => {
                    paren = paren.saturating_sub(1);
                }
                _ if angle == 0 && paren == 0 => {
                    if tok.text == "::" {
                        expect_seg = true;
                    } else if tok.kind == TokenKind::Ident || (tok.kind == TokenKind::Keyword && matches!(tok.text.as_str(), "crate" | "super" | "self")) {
                        if !expect_seg {
                            segs.clear();
                        }
                        segs.push(tok.text.clone());
                        expect_seg = false;
                    } else {
                        segs.clear();
                        expect_seg = true;
                    }
                }
                _ => {}
            }
        }
        let short = segs.last().cloned().unwrap_or_default();
        let full = segs.join("::");
        (full, short)
    };

    if let Some(fp) = for_pos {
        let (trait_path, trait_short) = extract_type_path(&header[..fp]);
        let (_, type_name) = extract_type_path(&header[fp + 1..]);
        let trait_info = (!trait_short.is_empty()).then_some((trait_path, trait_short));
        (trait_info, type_name, brace_idx)
    } else {
        let (_, type_name) = extract_type_path(header);
        (None, type_name, brace_idx)
    }
}

fn resolve_rust_relative_type_path(base_ns: &str, raw_path: &str) -> String {
    let segs: Vec<&str> = raw_path.split("::").filter(|s| !s.is_empty()).collect();
    if segs.first().is_some_and(|&s| s == "super") {
        let mut parts: Vec<&str> = base_ns.split("::").collect();
        let mut idx = 0usize;
        while segs.get(idx).is_some_and(|&s| s == "super") {
            if parts.len() > 1 {
                parts.pop();
            }
            idx += 1;
        }
        parts.extend_from_slice(&segs[idx..]);
        return parts.join("::");
    }
    if segs.first().is_some_and(|&s| s == "self") {
        let mut parts: Vec<&str> = base_ns.split("::").collect();
        parts.extend_from_slice(&segs[1..]);
        return parts.join("::");
    }
    raw_path.to_owned()
}

fn parse_rust_use_targets(tokens: &[Token], start: usize, prefix: &[String], out: &mut Vec<Vec<String>>) -> usize {
    let mut i = start;
    let mut segs = prefix.to_vec();
    if tokens.get(i).is_some_and(|t| t.text == "::") {
        i += 1;
    }
    while i < tokens.len() {
        let tok = &tokens[i];
        if tok.text == "{" {
            i += 1;
            while i < tokens.len() && tokens[i].text != "}" {
                i = parse_rust_use_targets(tokens, i, &segs, out);
                if tokens.get(i).is_some_and(|t| t.text == ",") {
                    i += 1;
                }
            }
            if tokens.get(i).is_some_and(|t| t.text == "}") {
                i += 1;
            }
            return i;
        }
        if tok.text == "*" {
            let mut s = segs;
            s.push("*".to_owned());
            out.push(s);
            return i + 1;
        }
        if matches!(tok.kind, TokenKind::Ident | TokenKind::Keyword) && tok.text != "as" {
            if tok.text != "self" || segs.is_empty() {
                segs.push(tok.text.clone());
            }
            i += 1;
            if tokens.get(i).is_some_and(|t| t.text == "::") {
                i += 1;
                continue;
            }
            if tokens.get(i).is_some_and(|t| t.text == "as") {
                i += 2;
            }
            if !segs.is_empty() {
                out.push(segs);
            }
            return i;
        }
        break;
    }
    i
}

fn resolve_rust_use_namespace(base_ns: &str, segs: &[String]) -> (String, String) {
    let raw = segs.join("::");
    if segs.first().is_some_and(|s| s == "crate") {
        let mod_segs: Vec<&str> = segs
            .iter()
            .skip(1)
            .take_while(|s| s.as_str() != "*" && s.chars().next().is_some_and(|c| c.is_ascii_lowercase()))
            .map(String::as_str)
            .collect();
        let ns = if mod_segs.is_empty() {
            "crate".to_owned()
        } else {
            format!("crate::{}", mod_segs.join("::"))
        };
        return (ns, raw);
    }
    if segs.first().is_some_and(|s| s == "super") {
        let mut parts: Vec<&str> = base_ns.split("::").collect();
        let mut idx = 0usize;
        while segs.get(idx).is_some_and(|s| s == "super") {
            if parts.len() > 1 {
                parts.pop();
            }
            idx += 1;
        }
        for seg in &segs[idx..] {
            if seg == "*" || !seg.chars().next().is_some_and(|c| c.is_ascii_lowercase()) {
                break;
            }
            parts.push(seg);
        }
        return (parts.join("::"), raw);
    }
    if segs.first().is_some_and(|s| s == "self") {
        let mut parts: Vec<&str> = base_ns.split("::").collect();
        for seg in segs.iter().skip(1) {
            if seg == "*" || !seg.chars().next().is_some_and(|c| c.is_ascii_lowercase()) {
                break;
            }
            parts.push(seg);
        }
        return (parts.join("::"), raw);
    }
    let ns = segs.first().cloned().unwrap_or_default();
    (ns, raw)
}

fn current_rust_namespace(base_ns: &str, scopes: &[RustScope]) -> String {
    let mut parts = vec![base_ns.to_owned()];
    for scope in scopes {
        match scope {
            RustScope::Mod(name) | RustScope::Impl(name) if !name.is_empty() => parts.push(name.clone()),
            _ => {}
        }
    }
    parts.join("::")
}

fn current_rust_module_namespace(base_ns: &str, scopes: &[RustScope]) -> String {
    let mut parts = vec![base_ns.to_owned()];
    for scope in scopes {
        if let RustScope::Mod(name) = scope
            && !name.is_empty()
        {
            parts.push(name.clone());
        }
    }
    parts.join("::")
}

fn analyze_rust(rel_file: &str, source: &str, tokens: &[Token]) -> FileAnalysis {
    let base_ns = rust_module_namespace(rel_file);
    let mut forms = Vec::new();
    let mut types_map: BTreeMap<(String, String), TypeDecl> = BTreeMap::new();
    let mut relations = Vec::new();

    if has_file_cfg_test(source, tokens) {
        return FileAnalysis {
            file: rel_file.to_owned(),
            lang: Lang::Rust,
            module_namespace: base_ns,
            forms,
            types: Vec::new(),
            relations,
        };
    }

    let mut scopes: Vec<RustScope> = Vec::new();
    let mut pending_cfg_test = false;
    let mut i = 0usize;

    let in_ignored_scope = |scopes: &[RustScope]| scopes.iter().any(|s| matches!(s, RustScope::FnBody | RustScope::TestItem));
    let in_test_only = |scopes: &[RustScope]| scopes.iter().any(|s| matches!(s, RustScope::TestItem));

    while i < tokens.len() {
        let tok = &tokens[i];

        // Outer attributes #[...]
        if tok.text == "#" && tokens.get(i + 1).is_some_and(|t| t.text == "[") {
            let close = find_matching_delim(tokens, i + 1, "[", "]");
            let inner = &source[tokens[i + 1].end_byte..tokens[close].start_byte];
            if let Some(cfg) = inner
                .trim()
                .strip_prefix("cfg")
                .and_then(|s| s.trim_start().strip_prefix('('))
                .and_then(|s| s.strip_suffix(')'))
                && is_cfg_test_predicate(cfg)
            {
                pending_cfg_test = true;
            }
            i = close + 1;
            continue;
        }

        if tok.text == "}" {
            scopes.pop();
            pending_cfg_test = false;
            i += 1;
            continue;
        }

        if in_test_only(&scopes) {
            if tok.text == "{" {
                scopes.push(RustScope::Other);
            }
            i += 1;
            continue;
        }

        // Skip `#[cfg(test)]` items cleanly by consuming their balanced block or `;`
        if pending_cfg_test && !in_ignored_scope(&scopes) {
            let mut cursor = i;
            while cursor < tokens.len() {
                if tokens[cursor].text == "{" {
                    let close = find_matching_delim(tokens, cursor, "{", "}");
                    cursor = close + 1;
                    break;
                }
                if tokens[cursor].text == ";" {
                    cursor += 1;
                    break;
                }
                cursor += 1;
            }
            pending_cfg_test = false;
            i = cursor;
            continue;
        }

        if in_ignored_scope(&scopes) {
            if tok.text == "{" {
                scopes.push(RustScope::Other);
            }
            i += 1;
            continue;
        }

        // `use ...;`
        if tok.kind == TokenKind::Keyword && tok.text == "use" {
            let from_ns = current_rust_module_namespace(&base_ns, &scopes);
            let mut targets = Vec::new();
            let mut next = parse_rust_use_targets(tokens, i + 1, &[], &mut targets);
            while next < tokens.len() && tokens[next].text != ";" {
                next += 1;
            }
            for segs in targets {
                let (to_ns, raw_target) = resolve_rust_use_namespace(&from_ns, &segs);
                if !to_ns.is_empty() && to_ns != from_ns {
                    relations.push(ModuleRelation {
                        from_namespace: from_ns.clone(),
                        to_namespace: to_ns,
                        kind: RelationKind::Dependency,
                        file: rel_file.to_owned(),
                        line: tok.line,
                        raw_target,
                    });
                }
            }
            i = if tokens.get(next).is_some_and(|t| t.text == ";") { next + 1 } else { next };
            continue;
        }

        // `mod foo { ... }` or `mod tests { ... }`
        if tok.kind == TokenKind::Keyword
            && tok.text == "mod"
            && tokens.get(i + 1).is_some_and(|t| t.kind == TokenKind::Ident)
            && tokens.get(i + 2).is_some_and(|t| t.text == "{")
        {
            let mod_name = tokens[i + 1].text.clone();
            if mod_name == "tests" {
                scopes.push(RustScope::TestItem);
            } else {
                scopes.push(RustScope::Mod(mod_name));
            }
            i += 3;
            continue;
        }

        // `struct`, `enum`, `trait`
        if tok.kind == TokenKind::Keyword
            && matches!(tok.text.as_str(), "struct" | "enum" | "trait")
            && tokens.get(i + 1).is_some_and(|t| t.kind == TokenKind::Ident)
        {
            let kind_str = tok.text.clone();
            let name = tokens[i + 1].text.clone();
            let ns = format!("{}::{name}", current_rust_module_namespace(&base_ns, &scopes));
            let mut cursor = skip_angle_generics(tokens, i + 2);
            while cursor < tokens.len() && !matches!(tokens[cursor].text.as_str(), "{" | ";") {
                cursor += 1;
            }
            let mut fields = Vec::new();
            if kind_str == "struct" && tokens.get(cursor).is_some_and(|t| t.text == "{") {
                let close = find_matching_delim(tokens, cursor, "{", "}");
                let mut f = cursor + 1;
                let mut brace_depth = 0usize;
                while f < close {
                    if tokens[f].text == "{" {
                        brace_depth += 1;
                    } else if tokens[f].text == "}" {
                        brace_depth = brace_depth.saturating_sub(1);
                    } else if brace_depth == 0 && tokens[f].kind == TokenKind::Ident && tokens.get(f + 1).is_some_and(|t| t.text == ":") {
                        fields.push(tokens[f].text.clone());
                    }
                    f += 1;
                }
            }
            types_map.entry((ns.clone(), name.clone())).or_insert_with(|| TypeDecl {
                namespace: ns,
                name,
                kind: kind_str,
                file: rel_file.to_owned(),
                line: tok.line,
                fields,
                ops: Vec::new(),
                bases: Vec::new(),
            });
            if tokens.get(cursor).is_some_and(|t| t.text == "{") {
                scopes.push(RustScope::Other);
                i = cursor + 1;
            } else {
                i = cursor + 1;
            }
            continue;
        }

        // `impl [Trait for] Type { ... }`
        if tok.kind == TokenKind::Keyword && tok.text == "impl" {
            let (trait_opt, type_name, brace_idx) = parse_rust_impl_target(tokens, i);
            if tokens.get(brace_idx).is_some_and(|t| t.text == "{") {
                let mod_ns = current_rust_module_namespace(&base_ns, &scopes);
                let type_ns = if type_name.is_empty() {
                    mod_ns.clone()
                } else {
                    format!("{mod_ns}::{type_name}")
                };
                if let Some((trait_raw_path, trait_short)) = trait_opt {
                    let resolved_trait = resolve_rust_relative_type_path(&mod_ns, &trait_raw_path);
                    relations.push(ModuleRelation {
                        from_namespace: type_ns.clone(),
                        to_namespace: resolved_trait,
                        kind: RelationKind::Implements,
                        file: rel_file.to_owned(),
                        line: tok.line,
                        raw_target: trait_raw_path,
                    });
                    if !type_name.is_empty() {
                        let decl = types_map.entry((type_ns.clone(), type_name.clone())).or_insert_with(|| TypeDecl {
                            namespace: type_ns,
                            name: type_name.clone(),
                            kind: "struct".to_owned(),
                            file: rel_file.to_owned(),
                            line: tok.line,
                            fields: Vec::new(),
                            ops: Vec::new(),
                            bases: Vec::new(),
                        });
                        if !decl.bases.contains(&trait_short) {
                            decl.bases.push(trait_short);
                        }
                    }
                }
                scopes.push(RustScope::Impl(type_name));
                i = brace_idx + 1;
                continue;
            }
        }

        // `fn name(...) ... { ... }`
        if tok.kind == TokenKind::Keyword && tok.text == "fn" && tokens.get(i + 1).is_some_and(|t| t.kind == TokenKind::Ident) {
            let fn_name = tokens[i + 1].text.clone();
            let (visibility, vis_start_idx) = parse_rust_visibility_before(tokens, i);
            let mut cursor = skip_angle_generics(tokens, i + 2);
            if tokens.get(cursor).is_some_and(|t| t.text == "(") {
                cursor = find_matching_delim(tokens, cursor, "(", ")") + 1;
                while cursor < tokens.len() && !matches!(tokens[cursor].text.as_str(), "{" | ";") {
                    cursor += 1;
                }
                if tokens.get(cursor).is_some_and(|t| t.text == "{") {
                    let close = find_matching_delim(tokens, cursor, "{", "}");
                    let start_byte = tokens[vis_start_idx].start_byte;
                    let end_byte = tokens[close].end_byte;
                    let start_line = rust_item_start_line(tokens, vis_start_idx);
                    let end_line = tokens[close].line;
                    let ns = current_rust_namespace(&base_ns, &scopes);
                    let is_method = scopes.iter().any(|s| matches!(s, RustScope::Impl(_)));
                    let kind = if is_method { FormKind::Method } else { FormKind::Function };

                    forms.push(FormInfo {
                        namespace: ns.clone(),
                        name: fn_name.clone(),
                        kind,
                        visibility,
                        lang: Lang::Rust,
                        file: rel_file.to_owned(),
                        start_line,
                        end_line,
                        start_byte,
                        end_byte,
                        body_hash: stable_hash_hex(&source[start_byte..end_byte]),
                    });

                    if let Some(RustScope::Impl(type_name)) = scopes.iter().rev().find(|s| matches!(s, RustScope::Impl(_)))
                        && !type_name.is_empty()
                    {
                        let decl = types_map.entry((ns.clone(), type_name.clone())).or_insert_with(|| TypeDecl {
                            namespace: ns,
                            name: type_name.clone(),
                            kind: "struct".to_owned(),
                            file: rel_file.to_owned(),
                            line: start_line,
                            fields: Vec::new(),
                            ops: Vec::new(),
                            bases: Vec::new(),
                        });
                        if !decl.ops.contains(&fn_name) {
                            decl.ops.push(fn_name);
                        }
                    }

                    scopes.push(RustScope::FnBody);
                    i = cursor + 1;
                    continue;
                }
            }
        }

        if tok.text == "{" {
            scopes.push(RustScope::Other);
        }
        i += 1;
    }

    FileAnalysis {
        file: rel_file.to_owned(),
        lang: Lang::Rust,
        module_namespace: base_ns,
        forms,
        types: types_map.into_values().collect(),
        relations,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TsScope {
    Namespace(String),
    Class(String),
    FnBody,
    Other,
}

fn unquote_js_string(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.len() >= 2 && ((trimmed.starts_with('"') && trimmed.ends_with('"')) || (trimmed.starts_with('\'') && trimmed.ends_with('\''))) {
        trimmed[1..trimmed.len() - 1].to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn resolve_ts_import_namespace(rel_file: &str, specifier: &str) -> String {
    if specifier.starts_with("./") || specifier.starts_with("../") {
        let dir = rel_file.rsplit_once('/').map_or("", |(d, _)| d);
        let joined = if dir.is_empty() { specifier.to_owned() } else { format!("{dir}/{specifier}") };
        let norm = normalize_posix_path(&joined);
        return ts_module_namespace(&norm);
    }
    specifier.to_owned()
}

fn current_ts_namespace(base_ns: &str, scopes: &[TsScope]) -> String {
    let mut parts = vec![base_ns.to_owned()];
    for scope in scopes {
        match scope {
            TsScope::Namespace(name) | TsScope::Class(name) if !name.is_empty() => parts.push(name.clone()),
            _ => {}
        }
    }
    parts.join(".")
}

fn ts_arrow_body_end(tokens: &[Token], arrow_idx: usize) -> (usize, bool) {
    let body_idx = arrow_idx + 1;
    if tokens.get(body_idx).is_some_and(|t| t.text == "{") {
        let close = find_matching_delim(tokens, body_idx, "{", "}");
        return (close, true);
    }
    let mut paren = 0usize;
    let mut bracket = 0usize;
    let mut brace = 0usize;
    let mut i = body_idx;
    while i < tokens.len() {
        let t = &tokens[i];
        match t.text.as_str() {
            "(" => paren += 1,
            ")" => paren = paren.saturating_sub(1),
            "[" => bracket += 1,
            "]" => bracket = bracket.saturating_sub(1),
            "{" => brace += 1,
            "}" => {
                if brace == 0 && paren == 0 && bracket == 0 {
                    return (i.saturating_sub(1), false);
                }
                brace = brace.saturating_sub(1);
            }
            ";" if paren == 0 && bracket == 0 && brace == 0 => return (i, false),
            _ => {
                if paren == 0
                    && bracket == 0
                    && brace == 0
                    && i > body_idx
                    && tokens[i].line > tokens[i - 1].line
                    && matches!(
                        tokens[i].text.as_str(),
                        "export" | "import" | "const" | "let" | "var" | "function" | "class" | "interface" | "type"
                    )
                {
                    return (i - 1, false);
                }
            }
        }
        i += 1;
    }
    (tokens.len().saturating_sub(1), false)
}

fn try_parse_ts_arrow_after_eq(tokens: &[Token], eq_idx: usize) -> Option<(usize, usize, bool)> {
    let mut cursor = eq_idx + 1;
    if tokens.get(cursor).is_some_and(|t| t.text == "async") {
        cursor += 1;
    }
    // Single-param unparenthesized arrow: `x => ...`
    if tokens.get(cursor).is_some_and(|t| t.kind == TokenKind::Ident) && tokens.get(cursor + 1).is_some_and(|t| t.text == "=>") {
        let (end_idx, has_brace) = ts_arrow_body_end(tokens, cursor + 1);
        return Some((cursor + 1, end_idx, has_brace));
    }

    cursor = skip_angle_generics(tokens, cursor);
    if !tokens.get(cursor).is_some_and(|t| t.text == "(") {
        return None;
    }
    let close_paren = find_matching_delim(tokens, cursor, "(", ")");
    let mut after = close_paren + 1;
    // Skip optional `: ReturnType` before `=>`
    if tokens.get(after).is_some_and(|t| t.text == ":") {
        after += 1;
        let mut p = 0usize;
        let mut b = 0usize;
        let mut a = 0usize;
        let mut br = 0usize;
        while after < tokens.len() {
            match tokens[after].text.as_str() {
                "(" => p += 1,
                ")" => p = p.saturating_sub(1),
                "[" => b += 1,
                "]" => b = b.saturating_sub(1),
                "<" => a += 1,
                ">" => a = a.saturating_sub(1),
                "{" => br += 1,
                "}" => br = br.saturating_sub(1),
                "=>" if p == 0 && b == 0 && a == 0 && br == 0 => break,
                ";" | "=" if p == 0 && b == 0 && a == 0 && br == 0 => return None,
                _ => {}
            }
            after += 1;
        }
    }
    if tokens.get(after).is_some_and(|t| t.text == "=>") {
        let (end_idx, has_brace) = ts_arrow_body_end(tokens, after);
        return Some((after, end_idx, has_brace));
    }
    None
}

fn analyze_ts(rel_file: &str, source: &str, tokens: &[Token]) -> FileAnalysis {
    let base_ns = ts_module_namespace(rel_file);
    let mut forms = Vec::new();
    let mut types_map: BTreeMap<(String, String), TypeDecl> = BTreeMap::new();
    let mut relations = Vec::new();
    let mut scopes: Vec<TsScope> = Vec::new();
    let mut i = 0usize;

    let in_fn_body = |scopes: &[TsScope]| scopes.iter().any(|s| matches!(s, TsScope::FnBody));
    let in_class_body = |scopes: &[TsScope]| matches!(scopes.last(), Some(TsScope::Class(_)));

    while i < tokens.len() {
        let tok = &tokens[i];

        if tok.text == "}" {
            scopes.pop();
            i += 1;
            continue;
        }

        if in_fn_body(&scopes) {
            if tok.text == "{" || tok.text == "${" {
                scopes.push(TsScope::Other);
            }
            i += 1;
            continue;
        }

        // `import ... from "..."` or `import "..."`
        if tok.kind == TokenKind::Keyword && tok.text == "import" && !in_class_body(&scopes) {
            let mut cursor = i + 1;
            let mut spec_tok = None;
            while cursor < tokens.len() && tokens[cursor].text != ";" {
                if tokens[cursor].kind == TokenKind::Lit && tokens[cursor].text.starts_with(['"', '\'']) {
                    spec_tok = Some(&tokens[cursor]);
                }
                if cursor > i + 1 && tokens[cursor].line > tokens[cursor - 1].line && spec_tok.is_some() {
                    break;
                }
                cursor += 1;
            }
            if let Some(spec) = spec_tok {
                let raw_target = unquote_js_string(&spec.text);
                let to_ns = resolve_ts_import_namespace(rel_file, &raw_target);
                if !to_ns.is_empty() && to_ns != base_ns {
                    relations.push(ModuleRelation {
                        from_namespace: base_ns.clone(),
                        to_namespace: to_ns,
                        kind: RelationKind::Dependency,
                        file: rel_file.to_owned(),
                        line: tok.line,
                        raw_target,
                    });
                }
            }
            i = if tokens.get(cursor).is_some_and(|t| t.text == ";") {
                cursor + 1
            } else {
                cursor
            };
            continue;
        }

        // `namespace Foo { ... }`
        if tok.kind == TokenKind::Keyword
            && tok.text == "namespace"
            && tokens.get(i + 1).is_some_and(|t| t.kind == TokenKind::Ident)
            && tokens.get(i + 2).is_some_and(|t| t.text == "{")
        {
            scopes.push(TsScope::Namespace(tokens[i + 1].text.clone()));
            i += 3;
            continue;
        }

        // `interface Foo ... { ... }`
        if tok.kind == TokenKind::Keyword && tok.text == "interface" && tokens.get(i + 1).is_some_and(|t| t.kind == TokenKind::Ident) {
            let name = tokens[i + 1].text.clone();
            let ns = format!("{}.{name}", current_ts_namespace(&base_ns, &scopes));
            let mut cursor = skip_angle_generics(tokens, i + 2);
            let mut bases = Vec::new();
            while cursor < tokens.len() && tokens[cursor].text != "{" {
                if tokens[cursor].kind == TokenKind::Ident && tokens[cursor - 1].text != "." {
                    bases.push(tokens[cursor].text.clone());
                }
                cursor += 1;
            }
            if tokens.get(cursor).is_some_and(|t| t.text == "{") {
                let close = find_matching_delim(tokens, cursor, "{", "}");
                let mut fields = Vec::new();
                let mut ops = Vec::new();
                let mut k = cursor + 1;
                let mut depth = 0usize;
                while k < close {
                    match tokens[k].text.as_str() {
                        "{" | "(" => depth += 1,
                        "}" | ")" => depth = depth.saturating_sub(1),
                        _ if depth == 0 && tokens[k].kind == TokenKind::Ident => {
                            let next = tokens.get(k + 1).map(|t| t.text.as_str());
                            if next == Some("(") || next == Some("<") {
                                ops.push(tokens[k].text.clone());
                            } else if next == Some(":") || (next == Some("?") && tokens.get(k + 2).is_some_and(|t| t.text == ":")) {
                                fields.push(tokens[k].text.clone());
                            }
                        }
                        _ => {}
                    }
                    k += 1;
                }
                types_map.insert(
                    (ns.clone(), name.clone()),
                    TypeDecl {
                        namespace: ns,
                        name,
                        kind: "interface".to_owned(),
                        file: rel_file.to_owned(),
                        line: tok.line,
                        fields,
                        ops,
                        bases,
                    },
                );
                scopes.push(TsScope::Other);
                i = cursor + 1;
                continue;
            }
        }

        // `class Foo [extends Base] [implements I1, I2] { ... }`
        if tok.kind == TokenKind::Keyword && tok.text == "class" && tokens.get(i + 1).is_some_and(|t| t.kind == TokenKind::Ident) {
            let name = tokens[i + 1].text.clone();
            let class_ns = format!("{}.{name}", current_ts_namespace(&base_ns, &scopes));
            let mut cursor = skip_angle_generics(tokens, i + 2);
            let mut bases = Vec::new();
            let mut mode = "";
            while cursor < tokens.len() && tokens[cursor].text != "{" {
                let t = &tokens[cursor];
                if t.text == "extends" {
                    mode = "extends";
                } else if t.text == "implements" {
                    mode = "implements";
                } else if t.kind == TokenKind::Ident && !mode.is_empty() && tokens[cursor - 1].text != "." {
                    bases.push(t.text.clone());
                    let rel_kind = if mode == "implements" {
                        RelationKind::Implements
                    } else {
                        RelationKind::Association
                    };
                    relations.push(ModuleRelation {
                        from_namespace: class_ns.clone(),
                        to_namespace: t.text.clone(),
                        kind: rel_kind,
                        file: rel_file.to_owned(),
                        line: t.line,
                        raw_target: t.text.clone(),
                    });
                }
                cursor += 1;
            }
            if tokens.get(cursor).is_some_and(|t| t.text == "{") {
                types_map.insert(
                    (class_ns.clone(), name.clone()),
                    TypeDecl {
                        namespace: class_ns,
                        name: name.clone(),
                        kind: "class".to_owned(),
                        file: rel_file.to_owned(),
                        line: tok.line,
                        fields: Vec::new(),
                        ops: Vec::new(),
                        bases,
                    },
                );
                scopes.push(TsScope::Class(name));
                i = cursor + 1;
                continue;
            }
        }

        // Class methods & class field arrows inside `class ... { ... }`
        if in_class_body(&scopes) {
            let mut cursor = i;
            let mut is_private = false;
            let mut mod_start = i;
            let mut has_modifiers = false;
            while cursor < tokens.len()
                && tokens[cursor].kind == TokenKind::Keyword
                && matches!(
                    tokens[cursor].text.as_str(),
                    "public" | "private" | "protected" | "static" | "readonly" | "abstract" | "async" | "override" | "get" | "set"
                )
            {
                if tokens[cursor].text == "private" {
                    is_private = true;
                }
                if !has_modifiers {
                    mod_start = cursor;
                    has_modifiers = true;
                }
                cursor += 1;
            }
            if tokens.get(cursor).is_some_and(|t| t.text == "*") {
                cursor += 1;
            }
            if let Some(name_tok) = tokens.get(cursor)
                && name_tok.kind == TokenKind::Ident
            {
                let name = name_tok.text.clone();
                if name.starts_with('#') {
                    is_private = true;
                }
                let start_idx = if has_modifiers { mod_start } else { cursor };
                let after_name = skip_angle_generics(tokens, cursor + 1);
                let visibility = if is_private { Visibility::Private } else { Visibility::Public };
                let ns = current_ts_namespace(&base_ns, &scopes);

                // Standard method `name(...) { ... }`
                if tokens.get(after_name).is_some_and(|t| t.text == "(") {
                    let close_paren = find_matching_delim(tokens, after_name, "(", ")");
                    let mut body = close_paren + 1;
                    while body < tokens.len() && !matches!(tokens[body].text.as_str(), "{" | ";") {
                        body += 1;
                    }
                    if tokens.get(body).is_some_and(|t| t.text == "{") {
                        let close = find_matching_delim(tokens, body, "{", "}");
                        let start_byte = tokens[start_idx].start_byte;
                        let end_byte = tokens[close].end_byte;
                        let start_line = tokens[start_idx].line;
                        forms.push(FormInfo {
                            namespace: ns.clone(),
                            name: name.clone(),
                            kind: FormKind::Method,
                            visibility,
                            lang: Lang::TypeScript,
                            file: rel_file.to_owned(),
                            start_line,
                            end_line: tokens[close].line,
                            start_byte,
                            end_byte,
                            body_hash: stable_hash_hex(&source[start_byte..end_byte]),
                        });
                        if let Some(TsScope::Class(cname)) = scopes.last()
                            && let Some(decl) = types_map.get_mut(&(ns, cname.clone()))
                            && !decl.ops.contains(&name)
                        {
                            decl.ops.push(name);
                        }
                        scopes.push(TsScope::FnBody);
                        i = body + 1;
                        continue;
                    }
                }

                // Class arrow field: `private handler = (...) => { ... }`
                if tokens.get(cursor + 1).is_some_and(|t| t.text == "=" || t.text == ":") {
                    let mut eq_idx = cursor + 1;
                    if tokens[eq_idx].text == ":" {
                        while eq_idx < tokens.len() && !matches!(tokens[eq_idx].text.as_str(), "=" | ";") {
                            eq_idx += 1;
                        }
                    }
                    if tokens.get(eq_idx).is_some_and(|t| t.text == "=")
                        && let Some((arrow_idx, end_idx, has_brace)) = try_parse_ts_arrow_after_eq(tokens, eq_idx)
                    {
                        let start_byte = tokens[start_idx].start_byte;
                        let end_byte = tokens[end_idx].end_byte;
                        forms.push(FormInfo {
                            namespace: ns.clone(),
                            name: name.clone(),
                            kind: FormKind::Method,
                            visibility,
                            lang: Lang::TypeScript,
                            file: rel_file.to_owned(),
                            start_line: tokens[start_idx].line,
                            end_line: tokens[end_idx].line,
                            start_byte,
                            end_byte,
                            body_hash: stable_hash_hex(&source[start_byte..end_byte]),
                        });
                        if let Some(TsScope::Class(cname)) = scopes.last()
                            && let Some(decl) = types_map.get_mut(&(ns, cname.clone()))
                            && !decl.ops.contains(&name)
                        {
                            decl.ops.push(name);
                        }
                        if has_brace {
                            scopes.push(TsScope::FnBody);
                            i = arrow_idx + 2;
                        } else {
                            i = end_idx + 1;
                        }
                        continue;
                    }
                }
            }
        }

        // Top-level / namespace `function foo(...) { ... }`
        if tok.kind == TokenKind::Keyword && tok.text == "function" && !in_class_body(&scopes) {
            let mut start_idx = i;
            while start_idx > 0
                && tokens[start_idx - 1].kind == TokenKind::Keyword
                && matches!(tokens[start_idx - 1].text.as_str(), "export" | "default" | "async")
            {
                start_idx -= 1;
            }
            let mut cursor = i + 1;
            if tokens.get(cursor).is_some_and(|t| t.text == "*") {
                cursor += 1;
            }
            let name = if tokens.get(cursor).is_some_and(|t| t.kind == TokenKind::Ident) {
                let n = tokens[cursor].text.clone();
                cursor += 1;
                n
            } else {
                "default".to_owned()
            };
            cursor = skip_angle_generics(tokens, cursor);
            if tokens.get(cursor).is_some_and(|t| t.text == "(") {
                let close_paren = find_matching_delim(tokens, cursor, "(", ")");
                let mut body = close_paren + 1;
                while body < tokens.len() && !matches!(tokens[body].text.as_str(), "{" | ";") {
                    body += 1;
                }
                if tokens.get(body).is_some_and(|t| t.text == "{") {
                    let close = find_matching_delim(tokens, body, "{", "}");
                    let start_byte = tokens[start_idx].start_byte;
                    let end_byte = tokens[close].end_byte;
                    let visibility = if name.starts_with('#') { Visibility::Private } else { Visibility::Public };
                    forms.push(FormInfo {
                        namespace: current_ts_namespace(&base_ns, &scopes),
                        name,
                        kind: FormKind::Function,
                        visibility,
                        lang: Lang::TypeScript,
                        file: rel_file.to_owned(),
                        start_line: tokens[start_idx].line,
                        end_line: tokens[close].line,
                        start_byte,
                        end_byte,
                        body_hash: stable_hash_hex(&source[start_byte..end_byte]),
                    });
                    scopes.push(TsScope::FnBody);
                    i = body + 1;
                    continue;
                }
            }
        }

        // Top-level arrow or function expression: `[export] const|let|var foo = (...) => ...`
        if tok.kind == TokenKind::Keyword
            && matches!(tok.text.as_str(), "const" | "let" | "var")
            && !in_class_body(&scopes)
            && tokens.get(i + 1).is_some_and(|t| t.kind == TokenKind::Ident)
        {
            let mut start_idx = i;
            if start_idx > 0 && tokens[start_idx - 1].text == "export" {
                start_idx -= 1;
            }
            let name = tokens[i + 1].text.clone();
            let mut eq_idx = i + 2;
            if tokens.get(eq_idx).is_some_and(|t| t.text == ":") {
                let mut a = 0usize;
                let mut p = 0usize;
                let mut b = 0usize;
                let mut br = 0usize;
                eq_idx += 1;
                while eq_idx < tokens.len() {
                    match tokens[eq_idx].text.as_str() {
                        "<" => a += 1,
                        ">" => a = a.saturating_sub(1),
                        "(" => p += 1,
                        ")" => p = p.saturating_sub(1),
                        "[" => b += 1,
                        "]" => b = b.saturating_sub(1),
                        "{" => br += 1,
                        "}" => br = br.saturating_sub(1),
                        "=" | ";" if a == 0 && p == 0 && b == 0 && br == 0 => break,
                        _ => {}
                    }
                    eq_idx += 1;
                }
            }
            if tokens.get(eq_idx).is_some_and(|t| t.text == "=") {
                if let Some((arrow_idx, end_idx, has_brace)) = try_parse_ts_arrow_after_eq(tokens, eq_idx) {
                    let start_byte = tokens[start_idx].start_byte;
                    let end_byte = tokens[end_idx].end_byte;
                    forms.push(FormInfo {
                        namespace: current_ts_namespace(&base_ns, &scopes),
                        name,
                        kind: FormKind::Arrow,
                        visibility: Visibility::Public,
                        lang: Lang::TypeScript,
                        file: rel_file.to_owned(),
                        start_line: tokens[start_idx].line,
                        end_line: tokens[end_idx].line,
                        start_byte,
                        end_byte,
                        body_hash: stable_hash_hex(&source[start_byte..end_byte]),
                    });
                    if has_brace {
                        scopes.push(TsScope::FnBody);
                        i = arrow_idx + 2;
                    } else {
                        i = end_idx + 1;
                    }
                    continue;
                }

                // `const foo = [async] function(...) { ... }`
                let mut fn_idx = eq_idx + 1;
                if tokens.get(fn_idx).is_some_and(|t| t.text == "async") {
                    fn_idx += 1;
                }
                if tokens.get(fn_idx).is_some_and(|t| t.text == "function") {
                    let mut cursor = fn_idx + 1;
                    if tokens.get(cursor).is_some_and(|t| t.kind == TokenKind::Ident) {
                        cursor += 1;
                    }
                    cursor = skip_angle_generics(tokens, cursor);
                    if tokens.get(cursor).is_some_and(|t| t.text == "(") {
                        let close_paren = find_matching_delim(tokens, cursor, "(", ")");
                        let mut body = close_paren + 1;
                        while body < tokens.len() && !matches!(tokens[body].text.as_str(), "{" | ";") {
                            body += 1;
                        }
                        if tokens.get(body).is_some_and(|t| t.text == "{") {
                            let close = find_matching_delim(tokens, body, "{", "}");
                            let start_byte = tokens[start_idx].start_byte;
                            let end_byte = tokens[close].end_byte;
                            forms.push(FormInfo {
                                namespace: current_ts_namespace(&base_ns, &scopes),
                                name,
                                kind: FormKind::Function,
                                visibility: Visibility::Public,
                                lang: Lang::TypeScript,
                                file: rel_file.to_owned(),
                                start_line: tokens[start_idx].line,
                                end_line: tokens[close].line,
                                start_byte,
                                end_byte,
                                body_hash: stable_hash_hex(&source[start_byte..end_byte]),
                            });
                            scopes.push(TsScope::FnBody);
                            i = body + 1;
                            continue;
                        }
                    }
                }
            }
        }

        if tok.text == "{" || tok.text == "${" {
            scopes.push(TsScope::Other);
        }
        i += 1;
    }

    FileAnalysis {
        file: rel_file.to_owned(),
        lang: Lang::TypeScript,
        module_namespace: base_ns,
        forms,
        types: types_map.into_values().collect(),
        relations,
    }
}

pub fn form_tokens<'a>(tokens: &'a [Token], form: &FormInfo) -> &'a [Token] {
    let start = tokens.partition_point(|t| t.start_byte < form.start_byte);
    let end = tokens.partition_point(|t| t.end_byte <= form.end_byte);
    if start <= end { &tokens[start..end] } else { &[] }
}

/// Produces the normalized token stream used by `dry` (Bob `dryer` rules):
/// keeps operators, delimiters, keywords, and call identifiers (`ident(...)` / `.method(...)`),
/// while normalizing declared function name, local variables, field names, and literals.
pub fn normalize_form_tokens(tokens: &[Token], lang: Lang) -> Vec<String> {
    let mut out = Vec::with_capacity(tokens.len());
    let mut prev_was_fn_kw = false;

    for (idx, tok) in tokens.iter().enumerate() {
        match tok.kind {
            TokenKind::Lit => {
                out.push("LIT".to_owned());
                prev_was_fn_kw = false;
            }
            TokenKind::Op | TokenKind::Punct => {
                out.push(tok.text.clone());
                prev_was_fn_kw = false;
            }
            TokenKind::Keyword => {
                prev_was_fn_kw = matches!(tok.text.as_str(), "fn" | "function");
                out.push(tok.text.clone());
            }
            TokenKind::Ident => {
                if prev_was_fn_kw {
                    out.push("FN".to_owned());
                    prev_was_fn_kw = false;
                    continue;
                }
                prev_was_fn_kw = false;
                let next_text = tokens.get(idx + 1).map(|t| t.text.as_str());
                let next2_text = tokens.get(idx + 2).map(|t| t.text.as_str());
                let is_call_ident = match lang {
                    Lang::Rust => {
                        next_text == Some("(") || (next_text == Some("!") && next2_text == Some("(")) || (next_text == Some("::") && next2_text == Some("<"))
                    }
                    Lang::TypeScript => next_text == Some("("),
                };
                if is_call_ident {
                    out.push(tok.text.clone());
                } else {
                    out.push("ID".to_owned());
                }
            }
        }
    }

    out
}

pub fn cyclomatic_complexity(tokens: &[Token], form: &FormInfo, lang: Lang) -> ComplexityResult {
    let slice = form_tokens(tokens, form);
    let mut cc = 1usize;

    match lang {
        Lang::Rust => {
            let mut match_brace_depths: Vec<usize> = Vec::new();
            let mut brace_depth = 0usize;
            let mut awaiting_match_brace = false;

            let mut total_match_arms = 0usize;
            let mut complex_match_arms = 0usize;

            for (idx, tok) in slice.iter().enumerate() {
                if tok.kind == TokenKind::Keyword {
                    match tok.text.as_str() {
                        "if" | "while" | "for" | "loop" => {
                            cc += 1;
                            if !match_brace_depths.is_empty() {
                                complex_match_arms += 1;
                            }
                        }
                        "match" => {
                            if !match_brace_depths.is_empty() {
                                complex_match_arms += 1;
                            }
                            awaiting_match_brace = true;
                        }
                        _ => {}
                    }
                } else if tok.kind == TokenKind::Op {
                    match tok.text.as_str() {
                        "&&" | "||" | "?" => cc += 1,
                        "=>" => {
                            if match_brace_depths.last() == Some(&brace_depth) {
                                cc += 1;
                                total_match_arms += 1;
                            } else if !match_brace_depths.is_empty() {
                                cc += 1;
                            }
                        }
                        _ => {}
                    }
                } else if tok.text == "{" {
                    brace_depth += 1;
                    if awaiting_match_brace {
                        match_brace_depths.push(brace_depth);
                        awaiting_match_brace = false;
                    }
                } else if tok.text == "}" {
                    if match_brace_depths.last() == Some(&brace_depth) {
                        match_brace_depths.pop();
                    }
                    brace_depth = brace_depth.saturating_sub(1);
                }

                // Avoid unused index warning while keeping signature symmetrical
                let _ = idx;
            }

            let is_flat_match = total_match_arms >= 3 && complex_match_arms == 0;
            ComplexityResult {
                cc,
                flat_match_arms: if is_flat_match { total_match_arms } else { 0 },
                is_flat_match,
            }
        }
        Lang::TypeScript => {
            for (idx, tok) in slice.iter().enumerate() {
                if tok.kind == TokenKind::Keyword {
                    if matches!(tok.text.as_str(), "if" | "while" | "for" | "case" | "catch") {
                        cc += 1;
                    }
                } else if tok.kind == TokenKind::Op {
                    match tok.text.as_str() {
                        "&&" | "||" | "??" => cc += 1,
                        "?" if slice.get(idx + 1).is_none_or(|next| next.text != ":") => {
                            // Exclude TypeScript optional parameter/property syntax `x?: T`
                            cc += 1;
                        }
                        _ => {}
                    }
                }
            }
            ComplexityResult {
                cc,
                flat_match_arms: 0,
                is_flat_match: false,
            }
        }
    }
}

/// Locates a member (function/method/type or line fallback) in `file` for `uml viewer`,
/// returning a source snippet with exact line numbers and highlighted target lines.
pub fn locate_member(root: &Path, lang: Lang, file: &Path, name: &str, line_hint: Option<usize>) -> Result<SourceLocation, String> {
    let full_path = if file.is_absolute() { file.to_path_buf() } else { root.join(file) };
    let source = fs::read_to_string(&full_path).map_err(|err| format!("failed to read {}: {err}", full_path.display()))?;
    let rel_file = to_rel_posix(root, &full_path);
    let analysis = analyze_file(root, &full_path, &source, lang);
    let index = LineIndex::new(&source);
    let total_lines = index.lines().len().max(1);

    let matched_form = analysis
        .forms
        .iter()
        .filter(|f| f.name == name)
        .min_by_key(|f| line_hint.map_or(0, |hint| f.start_line.abs_diff(hint)));

    let (target_line, span_start, span_end) = if let Some(form) = matched_form {
        (form.start_line, form.start_line, form.end_line)
    } else if let Some(decl) = analysis.types.iter().find(|t| t.name == name) {
        (decl.line, decl.line, (decl.line + 15).min(total_lines))
    } else {
        let hint = line_hint
            .or_else(|| index.lines().iter().position(|line| line.contains(name)).map(|idx| idx + 1))
            .unwrap_or(1)
            .clamp(1, total_lines);
        (hint, hint, hint)
    };

    let ctx_start = span_start.saturating_sub(3).max(1);
    let ctx_end = (span_end + 3).min(total_lines);
    let mut snippet = Vec::with_capacity(ctx_end - ctx_start + 1);
    for line_no in ctx_start..=ctx_end {
        let text = index.lines().get(line_no - 1).cloned().unwrap_or_default();
        let highlight = if matched_form.is_some() {
            line_no == target_line
        } else {
            line_no >= span_start && line_no <= span_end
        };
        snippet.push(SourceLine {
            line: line_no,
            text,
            highlight,
        });
    }

    Ok(SourceLocation {
        file: rel_file,
        lang,
        start_line: ctx_start,
        end_line: ctx_end,
        target_line,
        snippet,
    })
}

pub fn collect_unique_targets(relations: &[ModuleRelation]) -> BTreeSet<String> {
    relations.iter().map(|r| r.to_namespace.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn rust_lexer_preserves_offsets_lines_and_complex_literals() {
        let src = [
            "fn demo<'a>(s: &'a str) -> bool {",
            "    // comment 'unclosed",
            "    /* outer /* inner */ still comment */",
            r##"    let r = r#"hello "world""#;"##,
            "    let c = '中';",
            "    s.len() >= 1 && true",
            "}",
        ]
        .join("\n");

        let tokens = tokenize(&src, Lang::Rust);
        assert!(tokens.iter().any(|t| t.kind == TokenKind::Lit && t.text.starts_with("r#\"")));
        assert!(tokens.iter().any(|t| t.kind == TokenKind::Lit && t.text == "'中'"));
        assert!(tokens.iter().any(|t| t.kind == TokenKind::Op && t.text == ">="));
        assert!(tokens.iter().any(|t| t.kind == TokenKind::Op && t.text == "&&"));
        assert!(!tokens.iter().any(|t| t.text == "inner"));
        // Lifetime `'a` must NOT be collapsed into a char literal
        assert!(tokens.iter().any(|t| t.kind == TokenKind::Ident && t.text == "a"));
        for tok in &tokens {
            assert_eq!(&src[tok.start_byte..tok.end_byte], tok.text);
        }
        let true_tok = tokens.iter().find(|t| t.text == "true").unwrap();
        assert_eq!(true_tok.line, 6);
    }

    #[test]
    fn ts_lexer_handles_templates_regex_operators_and_jsx_apostrophes() {
        let src = [
            "export function check(a?: string, b: number) {",
            "  const re = /[a/b]+/gi;",
            "  const x = b / 2;",
            "  const msg = `hi ${a ?? 'none'}!`;",
            "  const ok = a?.length === 3 && b !== 0;",
            "  return <div>It's fine</div>;",
            "}",
        ]
        .join("\n");

        let tokens = tokenize(&src, Lang::TypeScript);
        assert!(tokens.iter().any(|t| t.kind == TokenKind::Lit && t.text == "/[a/b]+/gi"));
        assert!(tokens.iter().any(|t| t.kind == TokenKind::Op && t.text == "/"));
        assert!(tokens.iter().any(|t| t.kind == TokenKind::Op && t.text == "??"));
        assert!(tokens.iter().any(|t| t.kind == TokenKind::Op && t.text == "?."));
        assert!(tokens.iter().any(|t| t.kind == TokenKind::Op && t.text == "==="));
        assert!(tokens.iter().any(|t| t.kind == TokenKind::Op && t.text == "!=="));
        // Inside `${a ?? 'none'}` tokens must be lexed properly
        assert!(tokens.iter().any(|t| t.kind == TokenKind::Lit && t.text == "'none'"));
        // Byte offsets exact (note JSX apostrophe line stops at newline so later `}` is still Punct)
        assert_eq!(tokens.last().unwrap().text, "}");
        assert_eq!(tokens.last().unwrap().line, 7);
    }

    #[test]
    fn extracts_rust_bob_identities_skips_cfg_test_and_closures() {
        let src = [
            "use crate::issue::Board;",
            "",
            "pub fn top(a: i32) -> i32 {",
            "    let f = |x: i32| {",
            "        if x > 0 { x } else { 0 }",
            "    };",
            "    fn nested_helper() -> i32 { 1 }",
            "    f(a) + nested_helper()",
            "}",
            "",
            "pub struct Runner { count: usize }",
            "",
            "impl Runner {",
            "    pub fn run(&self) -> usize { self.count }",
            "    fn helper(&self) -> usize { 0 }",
            "}",
            "",
            "#[cfg(test)]",
            "mod tests {",
            "    fn test_only() {}",
            "}",
        ]
        .join("\n");

        let analysis = analyze_file(Path::new("/repo"), Path::new("/repo/crates/server/src/runtime/runner.rs"), &src, Lang::Rust);
        let keys: Vec<(&str, &str, Visibility, FormKind)> = analysis
            .forms
            .iter()
            .map(|f| (f.namespace.as_str(), f.name.as_str(), f.visibility, f.kind))
            .collect();
        assert_eq!(
            keys,
            vec![
                ("crate::runtime::runner", "top", Visibility::Public, FormKind::Function),
                ("crate::runtime::runner::Runner", "run", Visibility::Public, FormKind::Method),
                ("crate::runtime::runner::Runner", "helper", Visibility::Private, FormKind::Method),
            ]
        );
        assert!(
            analysis
                .relations
                .iter()
                .any(|r| r.kind == RelationKind::Dependency && r.to_namespace == "crate::issue")
        );
    }

    #[test]
    fn extracts_ts_bob_identities_and_skips_nested_callbacks() {
        let src = [
            "import { Client } from './client';",
            "",
            "export const renderHtml = (items: string[]) => {",
            "  return items.map((item) => {",
            "    return item.trim();",
            "  });",
            "};",
            "",
            "export class HtmlView {",
            "  private cache: string = '';",
            "  public render(x?: string) { return x ?? this.cache; }",
            "  private reset() { this.cache = ''; }",
            "  #secret() { return 1; }",
            "}",
        ]
        .join("\n");

        let analysis = analyze_file(
            Path::new("/repo"),
            Path::new("/repo/apps/mac/ui/features/note/html.tsx"),
            &src,
            Lang::TypeScript,
        );
        let keys: Vec<(&str, &str, Visibility, FormKind)> = analysis
            .forms
            .iter()
            .map(|f| (f.namespace.as_str(), f.name.as_str(), f.visibility, f.kind))
            .collect();
        assert_eq!(
            keys,
            vec![
                ("features.note.html", "renderHtml", Visibility::Public, FormKind::Arrow),
                ("features.note.html.HtmlView", "render", Visibility::Public, FormKind::Method),
                ("features.note.html.HtmlView", "reset", Visibility::Private, FormKind::Method),
                ("features.note.html.HtmlView", "#secret", Visibility::Private, FormKind::Method),
            ]
        );
        assert!(
            analysis
                .relations
                .iter()
                .any(|r| r.kind == RelationKind::Dependency && r.to_namespace == "features.note.client")
        );
    }

    #[test]
    fn normalizes_fields_and_locals_while_preserving_calls_and_ops() {
        let a = "fn calc_a(order: Order) -> i32 { helper(order.total + 1) }";
        let b = "fn calc_b(row: Row) -> i32 { helper(row.amount + 2) }";
        let c = "fn calc_c(row: Row) -> i32 { other(row.amount + 2) }";

        let root = Path::new("/repo");
        let file = Path::new("/repo/src/lib.rs");
        let fa = extract_forms(root, file, a, Lang::Rust);
        let fb = extract_forms(root, file, b, Lang::Rust);
        let fc = extract_forms(root, file, c, Lang::Rust);

        let ta = tokenize(a, Lang::Rust);
        let tb = tokenize(b, Lang::Rust);
        let tc = tokenize(c, Lang::Rust);

        let na = normalize_form_tokens(form_tokens(&ta, &fa[0]), Lang::Rust);
        let nb = normalize_form_tokens(form_tokens(&tb, &fb[0]), Lang::Rust);
        let nc = normalize_form_tokens(form_tokens(&tc, &fc[0]), Lang::Rust);

        assert_eq!(na, nb);
        assert_ne!(na, nc);
    }

    #[test]
    fn calculates_cyclomatic_complexity_and_flat_match_annotation() {
        let rust_src = [
            "pub fn route(x: Kind, ok: bool) -> i32 {",
            "    if ok && true { return 1; }",
            "    match x {",
            "        Kind::A => 10,",
            "        Kind::B => 20,",
            "        Kind::C => 30,",
            "    }",
            "}",
        ]
        .join("\n");
        let forms = extract_forms(Path::new("/repo"), Path::new("/repo/src/lib.rs"), &rust_src, Lang::Rust);
        let tokens = tokenize(&rust_src, Lang::Rust);
        let cc = cyclomatic_complexity(&tokens, &forms[0], Lang::Rust);
        // base 1 + if(1) + &&(1) + 3 match arms = 6
        assert_eq!(cc.cc, 6);
        assert!(cc.is_flat_match);
        assert_eq!(cc.flat_match_arms, 3);

        let ts_src = "export function pick(a?: string, b?: string) { return (a && b) ? a : (b ?? 'x'); }";
        let ts_forms = extract_forms(Path::new("/repo"), Path::new("/repo/packages/p/src/a.ts"), ts_src, Lang::TypeScript);
        let ts_tokens = tokenize(ts_src, Lang::TypeScript);
        let ts_cc = cyclomatic_complexity(&ts_tokens, &ts_forms[0], Lang::TypeScript);
        // base 1 + &&(1) + ternary ?(1) + ??(1) = 4 (optional `a?:` and `b?:` ignored!)
        assert_eq!(ts_cc.cc, 4);
    }

    #[test]
    fn locates_member_source_lines_for_viewer() {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("xtask-locate-{}-{nanos}", std::process::id()));
        fs::create_dir_all(dir.join("src")).unwrap();
        let file = dir.join("src/lib.rs");
        fs::write(&file, "pub fn one() {}\n\npub fn target_fn(x: i32) -> i32 {\n    x + 1\n}\n").unwrap();

        let loc = locate_member(&dir, Lang::Rust, Path::new("src/lib.rs"), "target_fn", Some(3)).unwrap();
        assert_eq!(loc.target_line, 3);
        assert!(loc.snippet.iter().any(|l| l.line == 3 && l.highlight && l.text.contains("target_fn")));

        let _ = fs::remove_dir_all(&dir);
    }
}
