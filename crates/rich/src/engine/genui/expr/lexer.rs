use crate::engine::genui::error::GenUiError;
use crate::engine::genui::value::normalize_zero;

#[derive(Debug, Clone, PartialEq)]
pub(super) enum RawTemplatePart {
    Literal(String),
    Expr { source: String, pos: usize },
}

#[derive(Debug, Clone, PartialEq)]
pub(super) enum TokenKind {
    Null,
    True,
    False,
    Number(f64),
    Text(String),
    Template(Vec<RawTemplatePart>),
    Ident(String),
    StateVar(String),
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Caret,
    Bang,
    EqEq,
    BangEq,
    Lt,
    LtEq,
    Gt,
    GtEq,
    AndAnd,
    OrOr,
    Question,
    Colon,
    FatArrow,
    Dot,
    Comma,
    LParen,
    RParen,
    LBracket,
    RBracket,
    LBrace,
    RBrace,
    Eof,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct Token {
    pub(super) kind: TokenKind,
    pub(super) pos: usize,
}

pub(super) fn scan_raw_template(input: &str, stop_at_double_quote: bool, max_depth: usize) -> Result<Vec<RawTemplatePart>, GenUiError> {
    let bytes = input.as_bytes();
    let mut i = 0;
    let mut parts = Vec::new();
    let mut literal = String::new();

    while i < bytes.len() {
        let b = bytes[i];
        if stop_at_double_quote && b == b'"' {
            break;
        }
        if !stop_at_double_quote && b == b'\\' && i + 2 < bytes.len() && bytes[i + 1] == b'$' && bytes[i + 2] == b'{' {
            literal.push_str("${");
            i += 3;
            continue;
        }
        if stop_at_double_quote && b == b'\\' && i + 1 < bytes.len() {
            let next = bytes[i + 1];
            match next {
                b'$' => {
                    literal.push('$');
                    i += 2;
                    continue;
                }
                b'n' => {
                    literal.push('\n');
                    i += 2;
                    continue;
                }
                b't' => {
                    literal.push('\t');
                    i += 2;
                    continue;
                }
                b'r' => {
                    literal.push('\r');
                    i += 2;
                    continue;
                }
                b'"' => {
                    literal.push('"');
                    i += 2;
                    continue;
                }
                b'\\' => {
                    literal.push('\\');
                    i += 2;
                    continue;
                }
                _ => {}
            }
        }
        if b == b'$' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            if !literal.is_empty() {
                parts.push(RawTemplatePart::Literal(std::mem::take(&mut literal)));
            }
            let expr_start = i + 2;
            let expr_end = find_matching_brace(input, expr_start, 0, max_depth)?;
            let expr_src = input[expr_start..expr_end].to_owned();
            if expr_src.trim().is_empty() {
                return Err(GenUiError::ExprParse {
                    pos: i,
                    message: "empty template interpolation".to_owned(),
                });
            }
            parts.push(RawTemplatePart::Expr {
                source: expr_src,
                pos: expr_start,
            });
            i = expr_end + 1;
            continue;
        }
        let ch = input[i..].chars().next().ok_or(GenUiError::ExprParse {
            pos: i,
            message: "unexpected end of template".to_owned(),
        })?;
        literal.push(ch);
        i += ch.len_utf8();
    }

    if !literal.is_empty() || parts.is_empty() {
        parts.push(RawTemplatePart::Literal(literal));
    }
    Ok(parts)
}

fn find_matching_brace(input: &str, start: usize, depth: usize, max_depth: usize) -> Result<usize, GenUiError> {
    if depth > max_depth {
        return Err(GenUiError::DepthLimitExceeded { limit: max_depth });
    }
    let bytes = input.as_bytes();
    let mut i = start;
    let mut brace_depth: usize = 1;
    let mut in_single = false;
    let mut in_double = false;

    while i < bytes.len() {
        let b = bytes[i];
        if in_single {
            if b == b'\\' && i + 1 < bytes.len() {
                i += 2;
                continue;
            }
            if b == b'\'' {
                in_single = false;
            }
            i += 1;
            continue;
        }
        if in_double {
            if b == b'\\' && i + 1 < bytes.len() {
                i += 2;
                continue;
            }
            if b == b'"' {
                in_double = false;
            } else if b == b'$' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
                let inner_end = find_matching_brace(input, i + 2, depth + 1, max_depth)?;
                i = inner_end + 1;
                continue;
            }
            i += 1;
            continue;
        }
        match b {
            b'\'' => in_single = true,
            b'"' => in_double = true,
            b'{' => brace_depth += 1,
            b'}' => {
                brace_depth -= 1;
                if brace_depth == 0 {
                    return Ok(i);
                }
            }
            _ => {}
        }
        i += 1;
    }

    Err(GenUiError::ExprParse {
        pos: start.saturating_sub(2),
        message: "unterminated template interpolation `${...}`".to_owned(),
    })
}

pub(super) fn tokenize(input: &str, max_depth: usize) -> Result<Vec<Token>, GenUiError> {
    let bytes = input.as_bytes();
    let mut tokens = Vec::new();
    let mut i = 0;

    while i < bytes.len() {
        let b = bytes[i];
        if b.is_ascii_whitespace() {
            i += 1;
            continue;
        }

        let start = i;
        match b {
            b'+' => {
                tokens.push(Token {
                    kind: TokenKind::Plus,
                    pos: start,
                });
                i += 1;
            }
            b'-' => {
                tokens.push(Token {
                    kind: TokenKind::Minus,
                    pos: start,
                });
                i += 1;
            }
            b'*' => {
                tokens.push(Token {
                    kind: TokenKind::Star,
                    pos: start,
                });
                i += 1;
            }
            b'/' => {
                tokens.push(Token {
                    kind: TokenKind::Slash,
                    pos: start,
                });
                i += 1;
            }
            b'%' => {
                tokens.push(Token {
                    kind: TokenKind::Percent,
                    pos: start,
                });
                i += 1;
            }
            b'^' => {
                tokens.push(Token {
                    kind: TokenKind::Caret,
                    pos: start,
                });
                i += 1;
            }
            b'?' => {
                tokens.push(Token {
                    kind: TokenKind::Question,
                    pos: start,
                });
                i += 1;
            }
            b':' => {
                tokens.push(Token {
                    kind: TokenKind::Colon,
                    pos: start,
                });
                i += 1;
            }
            b'.' => {
                tokens.push(Token {
                    kind: TokenKind::Dot,
                    pos: start,
                });
                i += 1;
            }
            b',' => {
                tokens.push(Token {
                    kind: TokenKind::Comma,
                    pos: start,
                });
                i += 1;
            }
            b'(' => {
                tokens.push(Token {
                    kind: TokenKind::LParen,
                    pos: start,
                });
                i += 1;
            }
            b')' => {
                tokens.push(Token {
                    kind: TokenKind::RParen,
                    pos: start,
                });
                i += 1;
            }
            b'[' => {
                tokens.push(Token {
                    kind: TokenKind::LBracket,
                    pos: start,
                });
                i += 1;
            }
            b']' => {
                tokens.push(Token {
                    kind: TokenKind::RBracket,
                    pos: start,
                });
                i += 1;
            }
            b'{' => {
                tokens.push(Token {
                    kind: TokenKind::LBrace,
                    pos: start,
                });
                i += 1;
            }
            b'}' => {
                tokens.push(Token {
                    kind: TokenKind::RBrace,
                    pos: start,
                });
                i += 1;
            }
            b'=' => {
                if i + 1 < bytes.len() && bytes[i + 1] == b'=' {
                    tokens.push(Token {
                        kind: TokenKind::EqEq,
                        pos: start,
                    });
                    i += 2;
                } else if i + 1 < bytes.len() && bytes[i + 1] == b'>' {
                    tokens.push(Token {
                        kind: TokenKind::FatArrow,
                        pos: start,
                    });
                    i += 2;
                } else {
                    return Err(GenUiError::ExprParse {
                        pos: start,
                        message: "unexpected `=` (use `==` for equality or `=>` for lambda)".to_owned(),
                    });
                }
            }
            b'!' => {
                if i + 1 < bytes.len() && bytes[i + 1] == b'=' {
                    tokens.push(Token {
                        kind: TokenKind::BangEq,
                        pos: start,
                    });
                    i += 2;
                } else {
                    tokens.push(Token {
                        kind: TokenKind::Bang,
                        pos: start,
                    });
                    i += 1;
                }
            }
            b'<' => {
                if i + 1 < bytes.len() && bytes[i + 1] == b'=' {
                    tokens.push(Token {
                        kind: TokenKind::LtEq,
                        pos: start,
                    });
                    i += 2;
                } else {
                    tokens.push(Token {
                        kind: TokenKind::Lt,
                        pos: start,
                    });
                    i += 1;
                }
            }
            b'>' => {
                if i + 1 < bytes.len() && bytes[i + 1] == b'=' {
                    tokens.push(Token {
                        kind: TokenKind::GtEq,
                        pos: start,
                    });
                    i += 2;
                } else {
                    tokens.push(Token {
                        kind: TokenKind::Gt,
                        pos: start,
                    });
                    i += 1;
                }
            }
            b'&' => {
                if i + 1 < bytes.len() && bytes[i + 1] == b'&' {
                    tokens.push(Token {
                        kind: TokenKind::AndAnd,
                        pos: start,
                    });
                    i += 2;
                } else {
                    return Err(GenUiError::ExprParse {
                        pos: start,
                        message: "unexpected `&` (use `&&` for logical AND)".to_owned(),
                    });
                }
            }
            b'|' => {
                if i + 1 < bytes.len() && bytes[i + 1] == b'|' {
                    tokens.push(Token {
                        kind: TokenKind::OrOr,
                        pos: start,
                    });
                    i += 2;
                } else {
                    return Err(GenUiError::ExprParse {
                        pos: start,
                        message: "unexpected `|` (use `||` for logical OR)".to_owned(),
                    });
                }
            }
            b'\'' => {
                let (s, next_i) = lex_single_quoted(input, start)?;
                tokens.push(Token {
                    kind: TokenKind::Text(s),
                    pos: start,
                });
                i = next_i;
            }
            b'"' => {
                let (kind, next_i) = lex_double_quoted(input, start, max_depth)?;
                tokens.push(Token { kind, pos: start });
                i = next_i;
            }
            b'$' => {
                i += 1;
                let ident_start = i;
                while i < bytes.len() && is_ident_continue(bytes[i]) {
                    i += 1;
                }
                if i == ident_start {
                    return Err(GenUiError::ExprParse {
                        pos: start,
                        message: "expected variable name after `$`".to_owned(),
                    });
                }
                tokens.push(Token {
                    kind: TokenKind::StateVar(input[ident_start..i].to_owned()),
                    pos: start,
                });
            }
            b'0'..=b'9' => {
                let (num, next_i) = lex_number(input, start)?;
                tokens.push(Token {
                    kind: TokenKind::Number(num),
                    pos: start,
                });
                i = next_i;
            }
            _ if is_ident_start(b) => {
                while i < bytes.len() && is_ident_continue(bytes[i]) {
                    i += 1;
                }
                let word = &input[start..i];
                let kind = match word {
                    "null" => TokenKind::Null,
                    "true" => TokenKind::True,
                    "false" => TokenKind::False,
                    _ => TokenKind::Ident(word.to_owned()),
                };
                tokens.push(Token { kind, pos: start });
            }
            _ => {
                let ch = input[start..].chars().next().unwrap_or('?');
                return Err(GenUiError::ExprParse {
                    pos: start,
                    message: format!("unexpected character `{ch}`"),
                });
            }
        }
    }

    tokens.push(Token {
        kind: TokenKind::Eof,
        pos: bytes.len(),
    });
    Ok(tokens)
}

fn is_ident_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_'
}

fn is_ident_continue(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn lex_number(input: &str, start: usize) -> Result<(f64, usize), GenUiError> {
    let bytes = input.as_bytes();
    let mut i = start;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i + 1 < bytes.len() && bytes[i] == b'.' && bytes[i + 1].is_ascii_digit() {
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        let exp_pos = i;
        i += 1;
        if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
            i += 1;
        }
        let digits_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == digits_start {
            return Err(GenUiError::ExprParse {
                pos: exp_pos,
                message: "invalid exponent in number literal".to_owned(),
            });
        }
    }
    let slice = &input[start..i];
    let parsed: f64 = slice.parse().map_err(|_| GenUiError::ExprParse {
        pos: start,
        message: format!("invalid number literal `{slice}`"),
    })?;
    if !parsed.is_finite() {
        return Err(GenUiError::NonFiniteResult {
            context: format!("number literal `{slice}`"),
        });
    }
    Ok((normalize_zero(parsed), i))
}

fn lex_single_quoted(input: &str, start: usize) -> Result<(String, usize), GenUiError> {
    let bytes = input.as_bytes();
    let mut i = start + 1;
    let mut out = String::new();
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'\'' {
            return Ok((out, i + 1));
        }
        if b == b'\\' {
            if i + 1 >= bytes.len() {
                return Err(GenUiError::ExprParse {
                    pos: start,
                    message: "unterminated escape in string literal".to_owned(),
                });
            }
            let escaped = match bytes[i + 1] {
                b'\'' => '\'',
                b'"' => '"',
                b'\\' => '\\',
                b'n' => '\n',
                b't' => '\t',
                b'r' => '\r',
                b'$' => '$',
                other => other as char,
            };
            out.push(escaped);
            i += 2;
            continue;
        }
        let ch = input[i..].chars().next().ok_or(GenUiError::ExprParse {
            pos: start,
            message: "unterminated string literal".to_owned(),
        })?;
        out.push(ch);
        i += ch.len_utf8();
    }
    Err(GenUiError::ExprParse {
        pos: start,
        message: "unterminated single-quoted string literal".to_owned(),
    })
}

fn lex_double_quoted(input: &str, start: usize, max_depth: usize) -> Result<(TokenKind, usize), GenUiError> {
    let bytes = input.as_bytes();
    let mut i = start + 1;
    let mut parts = Vec::new();
    let mut literal = String::new();
    let mut has_expr = false;

    while i < bytes.len() {
        let b = bytes[i];
        if b == b'"' {
            if !has_expr {
                return Ok((TokenKind::Text(literal), i + 1));
            }
            if !literal.is_empty() {
                parts.push(RawTemplatePart::Literal(literal));
            }
            return Ok((TokenKind::Template(parts), i + 1));
        }
        if b == b'\\' {
            if i + 1 >= bytes.len() {
                return Err(GenUiError::ExprParse {
                    pos: start,
                    message: "unterminated escape in string literal".to_owned(),
                });
            }
            let escaped = match bytes[i + 1] {
                b'"' => '"',
                b'\'' => '\'',
                b'\\' => '\\',
                b'n' => '\n',
                b't' => '\t',
                b'r' => '\r',
                b'$' => '$',
                other => other as char,
            };
            literal.push(escaped);
            i += 2;
            continue;
        }
        if b == b'$' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            has_expr = true;
            if !literal.is_empty() {
                parts.push(RawTemplatePart::Literal(std::mem::take(&mut literal)));
            }
            let expr_start = i + 2;
            let expr_end = find_matching_brace(input, expr_start, 0, max_depth)?;
            let expr_src = input[expr_start..expr_end].to_owned();
            if expr_src.trim().is_empty() {
                return Err(GenUiError::ExprParse {
                    pos: i,
                    message: "empty template interpolation".to_owned(),
                });
            }
            parts.push(RawTemplatePart::Expr {
                source: expr_src,
                pos: expr_start,
            });
            i = expr_end + 1;
            continue;
        }
        let ch = input[i..].chars().next().ok_or(GenUiError::ExprParse {
            pos: start,
            message: "unterminated double-quoted string literal".to_owned(),
        })?;
        literal.push(ch);
        i += ch.len_utf8();
    }

    Err(GenUiError::ExprParse {
        pos: start,
        message: "unterminated double-quoted string literal".to_owned(),
    })
}
