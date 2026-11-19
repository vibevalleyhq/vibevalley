use crate::detect::DiagramType;
use crate::error::{ErrorCode, PeleError, SourceLocation, SourceMap};
use crate::util::chars::{is_blank, is_digit, is_hex, is_letter, is_word};

use super::tokens::UsecaseToken;

pub struct Tokens {
    pub types: Vec<UsecaseToken>,
    pub starts: Vec<usize>,
    pub ends: Vec<usize>,
}

fn is_css_punct(b: u8) -> bool {
    matches!(b, b'!' | b'#' | b'$' | b'&' | b'*' | b'+' | b'/' | b'=' | b'?' | b'^' | b'|' | b'~')
}

fn starts_with_ci(src: &str, at: usize, word: &[u8]) -> bool {
    src.len() >= at + word.len() && src.as_bytes()[at..at + word.len()].eq_ignore_ascii_case(word)
}

fn keyword_at(src: &str, at: usize, b: u8) -> Option<(UsecaseToken, usize)> {
    let rest = &src[at..];
    match b {
        b'a' if rest.starts_with("actor") => Some((UsecaseToken::Actor, 5)),
        b's' => {
            if rest.starts_with("systemBoundary") {
                Some((UsecaseToken::SystemBoundary, 14))
            } else if rest.starts_with("style") {
                Some((UsecaseToken::Style, 5))
            } else {
                None
            }
        }
        b'e' => {
            if rest.starts_with("end") {
                Some((UsecaseToken::End, 3))
            } else if starts_with_ci(src, at, b"extend") {
                Some((UsecaseToken::Extend, 6))
            } else {
                None
            }
        }
        b'E' if starts_with_ci(src, at, b"extend") => Some((UsecaseToken::Extend, 6)),
        b'd' if rest.starts_with("direction") => Some((UsecaseToken::Direction, 9)),
        b'T' => {
            if rest.starts_with("TD") {
                Some((UsecaseToken::Td, 2))
            } else if rest.starts_with("TB") {
                Some((UsecaseToken::Tb, 2))
            } else {
                None
            }
        }
        b'B' if rest.starts_with("BT") => Some((UsecaseToken::Bt, 2)),
        b'L' if rest.starts_with("LR") => Some((UsecaseToken::Lr, 2)),
        b'R' if rest.starts_with("RL") => Some((UsecaseToken::Rl, 2)),
        b'n' if rest.starts_with("note") => Some((UsecaseToken::Note, 4)),
        b'f' => {
            if rest.starts_with("for") {
                Some((UsecaseToken::For, 3))
            } else if rest.starts_with("false") {
                Some((UsecaseToken::False, 5))
            } else {
                None
            }
        }
        b'j' if rest.starts_with("json") => Some((UsecaseToken::Json, 4)),
        b'c' => {
            if rest.starts_with("classDef") {
                Some((UsecaseToken::ClassDef, 8))
            } else if rest.starts_with("class") {
                Some((UsecaseToken::Class, 5))
            } else {
                None
            }
        }
        b'i' | b'I' if starts_with_ci(src, at, b"include") => Some((UsecaseToken::Include, 7)),
        b't' if rest.starts_with("true") => Some((UsecaseToken::True, 4)),
        b'u' if rest.starts_with("usecase-beta") => Some((UsecaseToken::Usecase, 12)),
        _ => None,
    }
}

pub fn line_column(src: &str, offset: usize, origin: Option<&SourceMap<'_>>) -> (usize, usize) {
    let (resolved, off) = match origin {
        Some(map) => map.resolve(src, offset),
        None => (src, offset.min(src.len())),
    };
    let mut off = off.min(resolved.len());
    while off > 0 && !resolved.is_char_boundary(off) {
        off -= 1;
    }
    let mut line = 1usize;
    let mut col = 1usize;
    let mut prev_cr = false;
    for ch in resolved[..off].chars() {
        if ch == '\r' {
            line += 1;
            col = 1;
            prev_cr = true;
        } else if ch == '\n' {
            if !prev_cr {
                line += 1;
                col = 1;
            }
            prev_cr = false;
        } else {
            col += 1;
            prev_cr = false;
        }
    }
    (line, col)
}

fn char_offset(src: &str, offset: usize, origin: Option<&SourceMap<'_>>) -> usize {
    let (resolved, off) = match origin {
        Some(map) => map.resolve(src, offset),
        None => (src, offset.min(src.len())),
    };
    let mut off = off.min(resolved.len());
    while off > 0 && !resolved.is_char_boundary(off) {
        off -= 1;
    }
    resolved[..off].chars().count()
}

pub fn location_text(src: &str, start: usize, end: usize, origin: Option<&SourceMap<'_>>) -> String {
    let (line, column) = line_column(src, start, origin);
    let from = char_offset(src, start, origin);
    let to = char_offset(src, end, origin);
    format!("line {line}, column {column} [{from},{to})")
}

fn string_end(src: &str, at: usize, quote: u8) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut k = at + 1;
    while k < bytes.len() {
        let c = bytes[k];
        if c == quote {
            return Some(k + 1);
        }
        if c == b'\n' || c == b'\r' {
            return None;
        }
        k += 1;
    }
    None
}

fn starts_token(src: &str, at: usize) -> bool {
    let bytes = src.as_bytes();
    let c = bytes[at];
    if c != b'"' && c != b'\'' {
        return true;
    }
    (c == b'"' && bytes.get(at + 1) == Some(&b'`')) || string_end(src, at, c).is_some()
}

fn lex_error(src: &str, offset: usize, length: usize, origin: Option<&SourceMap<'_>>) -> PeleError {
    let (line, column) = line_column(src, offset, origin);
    let from = char_offset(src, offset, origin);
    let to = char_offset(src, offset + length, origin);
    let ch = src[offset..].chars().next().map_or(String::new(), |c| c.to_string());
    PeleError::new(
        format!(
            "Error lexing usecase diagram: unexpected character: ->{ch}<- at offset: {from}, skipped {} characters. at line {line}, column {column} [{from},{to})",
            to.saturating_sub(from)
        ),
        ErrorCode::Syntax,
    )
    .with_diagram_type(DiagramType::Usecase)
    .with_location(SourceLocation {
        line,
        column,
        snippet: String::new(),
    })
}

/// Produces the tokens of Mermaid's Chevrotain lexer for use case diagrams: the first pattern in
/// its list that matches wins, a keyword gives way to a longer identifier, and `json id@` and `<<`
/// switch to modes that read a JSON object and a stereotype.
pub fn tokenize(src: &str, origin: Option<&SourceMap<'_>>) -> Result<Tokens, PeleError> {
    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut types: Vec<UsecaseToken> = Vec::new();
    let mut starts: Vec<usize> = Vec::new();
    let mut ends: Vec<usize> = Vec::new();
    let mut i = 0usize;
    let mut line_start = true;
    let mut no_brace = false;

    while i < n {
        let c = bytes[i];
        if c == b' ' || c == b'\t' {
            i += 1;
            continue;
        }
        let mut tok: Option<UsecaseToken> = None;
        let mut end = i + 1;
        let mut fresh = false;

        if c < 128 && is_word(c as u32) {
            if c == b'a' && line_start && src[i..].starts_with("acc") {
                let descr = src.get(i + 3..).is_some_and(|s| s.starts_with("Descr"));
                if descr || src.get(i + 3..).is_some_and(|s| s.starts_with("Title")) {
                    let mut j = i + 8;
                    while j < n && is_blank(bytes[j] as u32) {
                        j += 1;
                    }
                    let next = bytes.get(j).copied();
                    if next == Some(b':') {
                        tok = Some(if descr { UsecaseToken::AccDescrLine } else { UsecaseToken::AccTitleLine });
                        end = j + 1;
                        while end < n && bytes[end] != b'\n' && bytes[end] != b'\r' {
                            end += 1;
                        }
                    } else if next == Some(b'{') && descr && !no_brace {
                        if let Some(rel) = src[j + 1..].find('}') {
                            tok = Some(UsecaseToken::AccDescrBlock);
                            end = j + 1 + rel + 1;
                        } else {
                            no_brace = true;
                        }
                    }
                }
            } else if c == b'j' && src[i..].starts_with("json") && bytes.get(i + 4).is_some_and(|&b| is_blank(b as u32)) {
                let mut j = i + 5;
                while j < n && is_blank(bytes[j] as u32) {
                    j += 1;
                }
                let id_start = j;
                while j < n && is_word(bytes[j] as u32) {
                    j += 1;
                }
                if j > id_start {
                    while j < n && is_blank(bytes[j] as u32) {
                        j += 1;
                    }
                    if bytes.get(j) == Some(&b'@') {
                        j += 1;
                        while j < n && is_blank(bytes[j] as u32) {
                            j += 1;
                        }
                        if bytes.get(j) == Some(&b'{') {
                            types.push(UsecaseToken::JsonDeclarationStart);
                            starts.push(i);
                            ends.push(j);
                            let mut depth = 0usize;
                            let mut quoted = false;
                            let mut escaped = false;
                            let mut k = j;
                            while k < n {
                                let ch = bytes[k];
                                if quoted {
                                    if escaped {
                                        escaped = false;
                                    } else if ch == b'\\' {
                                        escaped = true;
                                    } else if ch == b'"' {
                                        quoted = false;
                                    }
                                } else if ch == b'"' {
                                    quoted = true;
                                } else if ch == b'{' {
                                    depth += 1;
                                } else if ch == b'}' {
                                    depth -= 1;
                                    if depth == 0 {
                                        break;
                                    }
                                }
                                k += 1;
                            }
                            types.push(if k < n {
                                UsecaseToken::JsonObjectLiteral
                            } else {
                                UsecaseToken::UnclosedJsonObjectLiteral
                            });
                            starts.push(j);
                            i = if k < n { k + 1 } else { n };
                            ends.push(i);
                            line_start = false;
                            continue;
                        }
                    }
                }
            }

            if tok.is_none() {
                while end < n && is_word(bytes[end] as u32) {
                    end += 1;
                }
                if let Some((kw, kw_len)) = keyword_at(src, i, c) {
                    if kw == UsecaseToken::Usecase || end - i == kw_len {
                        tok = Some(kw);
                        end = i + kw_len;
                    } else {
                        tok = Some(UsecaseToken::Identifier);
                    }
                } else if matches!(c, b'o' | b'x') && bytes.get(i + 1) == Some(&b'-') && bytes.get(i + 2) == Some(&b'-') {
                    tok = Some(if c == b'o' {
                        UsecaseToken::BackwardCircle
                    } else {
                        UsecaseToken::BackwardCross
                    });
                    end = i + 3;
                } else if is_digit(c as u32) {
                    let mut digits = i + 1;
                    while digits < n && is_digit(bytes[digits] as u32) {
                        digits += 1;
                    }
                    if bytes.get(digits) == Some(&b'.') && bytes.get(digits + 1).is_some_and(|&d| is_digit(d as u32)) {
                        tok = Some(UsecaseToken::Number);
                        end = digits + 2;
                        while end < n && is_digit(bytes[end] as u32) {
                            end += 1;
                        }
                        while end < n && is_letter(bytes[end] as u32) {
                            end += 1;
                        }
                    } else {
                        tok = Some(UsecaseToken::Identifier);
                    }
                } else {
                    let mut t = UsecaseToken::Identifier;
                    while bytes.get(end) == Some(&b'-') && bytes.get(end + 1).is_some_and(|&b| is_word(b as u32)) {
                        t = UsecaseToken::CssIdentifier;
                        end += 2;
                        while end < n && is_word(bytes[end] as u32) {
                            end += 1;
                        }
                    }
                    tok = Some(t);
                }
            }
        } else if c == b'\n' {
            tok = Some(UsecaseToken::Newline);
            fresh = true;
        } else if c == b'\r' {
            tok = Some(UsecaseToken::Newline);
            fresh = true;
            if bytes.get(end) == Some(&b'\n') {
                end += 1;
            }
        } else if c == b'"' || c == b'\'' {
            if c == b'"' && bytes.get(i + 1) == Some(&b'`') {
                if let Some(rel) = src[i + 2..].find("`\"") {
                    tok = Some(UsecaseToken::MarkdownString);
                    end = i + 2 + rel + 2;
                } else {
                    tok = Some(UsecaseToken::UnclosedMarkdownString);
                    end = n;
                }
            } else {
                match string_end(src, i, c) {
                    Some(e) => {
                        tok = Some(UsecaseToken::PlainString);
                        end = e;
                    }
                    None => {
                        let mut resume = i + 1;
                        while resume < n {
                            let ch = src[resume..].chars().next().unwrap();
                            if starts_token(src, resume) {
                                break;
                            }
                            resume += ch.len_utf8();
                        }
                        return Err(lex_error(src, i, resume - i, origin));
                    }
                }
            }
        } else if c == b'%' {
            if line_start && bytes.get(end) == Some(&b'%') {
                tok = Some(UsecaseToken::Comment);
                while end < n && bytes[end] != b'\n' && bytes[end] != b'\r' {
                    end += 1;
                }
            } else {
                tok = Some(UsecaseToken::Percent);
            }
        } else if c == b'-' {
            if bytes.get(end) != Some(&b'-') {
                tok = Some(UsecaseToken::Dash);
            } else {
                while end < n && bytes[end] == b'-' {
                    end += 1;
                }
                let next = bytes.get(end).copied();
                let two = end - i == 2;
                if two && next == Some(b'|') && bytes.get(end + 1) == Some(&b'>') {
                    tok = Some(UsecaseToken::Generalization);
                    end += 2;
                } else if next == Some(b'>') {
                    tok = Some(UsecaseToken::ForwardSolid);
                    end += 1;
                } else if two && matches!(next, Some(b'o' | b'x')) {
                    tok = Some(if next == Some(b'o') {
                        UsecaseToken::ForwardCircle
                    } else {
                        UsecaseToken::ForwardCross
                    });
                    end += 1;
                } else {
                    tok = Some(UsecaseToken::MarkerlessSolid);
                }
            }
        } else if c == b'.' {
            let next = bytes.get(end).copied();
            if next == Some(b'.') && bytes.get(end + 1) == Some(&b'>') {
                tok = Some(UsecaseToken::DependencyArrow);
                end += 2;
            } else if next.is_some_and(|b| is_digit(b as u32)) {
                tok = Some(UsecaseToken::Number);
                while end < n && is_digit(bytes[end] as u32) {
                    end += 1;
                }
                while end < n && is_letter(bytes[end] as u32) {
                    end += 1;
                }
            } else {
                tok = Some(UsecaseToken::Dot);
            }
        } else if c == b'<' {
            if bytes.get(end) == Some(&b'<') {
                types.push(UsecaseToken::StereotypeStart);
                starts.push(i);
                ends.push(i + 2);
                i += 2;
                if i >= n {
                    break;
                }
                if bytes.get(i) == Some(&b'>') && bytes.get(i + 1) == Some(&b'>') {
                    tok = Some(UsecaseToken::StereotypeEnd);
                    end = i + 2;
                } else {
                    let mut close = i;
                    let mut found = false;
                    while close < n {
                        let ch = bytes[close];
                        if ch == b'\n' || ch == b'\r' {
                            break;
                        }
                        if ch == b'>' && bytes.get(close + 1) == Some(&b'>') {
                            found = true;
                            break;
                        }
                        close += 1;
                    }
                    if found && !src[i..close].trim().is_empty() {
                        types.push(UsecaseToken::StereotypeText);
                        starts.push(i);
                        ends.push(close);
                        tok = Some(UsecaseToken::StereotypeEnd);
                        i = close;
                        end = close + 2;
                    } else {
                        while close < n && bytes[close] != b'\n' && bytes[close] != b'\r' {
                            close += 1;
                        }
                        if close == i {
                            while close < n && matches!(bytes[close], b'\n' | b'\r') {
                                close += 1;
                            }
                            return Err(lex_error(src, i, close - i, origin));
                        }
                        tok = Some(UsecaseToken::UnclosedStereotypeText);
                        end = close;
                    }
                }
            } else if bytes.get(end) == Some(&b'-') && bytes.get(end + 1) == Some(&b'-') {
                tok = Some(UsecaseToken::BackwardSolid);
                end += 2;
                while end < n && bytes[end] == b'-' {
                    end += 1;
                }
            } else {
                tok = Some(UsecaseToken::LabelPunctuation);
            }
        } else if c == b':' {
            if bytes.get(end) == Some(&b':') && bytes.get(end + 1) == Some(&b':') {
                tok = Some(UsecaseToken::ClassSeparator);
                end += 2;
            } else {
                tok = Some(UsecaseToken::Colon);
            }
        } else if c == b'@' {
            if bytes.get(end) == Some(&b'{') {
                tok = Some(UsecaseToken::MetadataStart);
                end += 1;
            } else {
                tok = Some(UsecaseToken::At);
            }
        } else if c == b'{' {
            tok = Some(UsecaseToken::LBrace);
        } else if c == b'}' {
            tok = Some(UsecaseToken::RBrace);
        } else if c == b'[' {
            tok = Some(UsecaseToken::LBracket);
        } else if c == b']' {
            tok = Some(UsecaseToken::RBracket);
        } else if c == b'(' {
            tok = Some(UsecaseToken::LParen);
        } else if c == b')' {
            tok = Some(UsecaseToken::RParen);
        } else if c == b',' {
            tok = Some(UsecaseToken::Comma);
        } else if c == b'#' {
            while end < n && is_hex(bytes[end] as u32) {
                end += 1;
            }
            tok = Some(if end > i + 1 { UsecaseToken::HashColor } else { UsecaseToken::CssPunctuation });
        } else if c == b'\\' {
            if bytes.get(end) == Some(&b',') {
                tok = Some(UsecaseToken::CssEscapedComma);
                end += 1;
            } else {
                tok = Some(UsecaseToken::LabelPunctuation);
            }
        } else if c < 127 && c > 32 {
            tok = Some(if is_css_punct(c) {
                UsecaseToken::CssPunctuation
            } else {
                UsecaseToken::LabelPunctuation
            });
        } else {
            tok = Some(UsecaseToken::LabelSymbol);
            let ch = src[i..].chars().next().unwrap();
            end = i + ch.len_utf8();
            while end < n {
                let next_ch = src[end..].chars().next().unwrap();
                let code = next_ch as u32;
                if (32..127).contains(&code) || matches!(code, 9 | 10 | 13) {
                    break;
                }
                end += next_ch.len_utf8();
            }
        }

        types.push(tok.unwrap());
        starts.push(i);
        ends.push(end);
        i = end;
        line_start = fresh;
    }

    for _ in 0..3 {
        types.push(UsecaseToken::Eof);
        starts.push(n);
        ends.push(n);
    }
    Ok(Tokens { types, starts, ends })
}
