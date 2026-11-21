use std::cmp::Ordering;
use std::collections::BTreeSet;

use crate::engine::genui::error::GenUiError;
use crate::engine::genui::value::{FormatKind, StateStore, StateValue, format_value, normalize_zero};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EvalLimits {
    pub max_steps: usize,
    pub max_depth: usize,
    pub max_collection_len: usize,
    pub max_string_len: usize,
}

impl Default for EvalLimits {
    fn default() -> Self {
        Self {
            max_steps: 10_000,
            max_depth: 64,
            max_collection_len: 4_096,
            max_string_len: 65_536,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnaryOp {
    Neg,
    Not,
    Pos,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinaryOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Pow,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    And,
    Or,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuiltinFn {
    Min,
    Max,
    Clamp,
    Abs,
    Round,
    Floor,
    Ceil,
    Pow,
    Sqrt,
    Ln,
    Log10,
    Sum,
    Avg,
    Len,
    Range,
    Format,
    Contains,
    Lower,
    Upper,
    Trim,
    Concat,
    Coalesce,
    Str,
    Num,
    If,
}

impl BuiltinFn {
    fn from_name(name: &str) -> Option<Self> {
        match name {
            "min" => Some(Self::Min),
            "max" => Some(Self::Max),
            "clamp" => Some(Self::Clamp),
            "abs" => Some(Self::Abs),
            "round" => Some(Self::Round),
            "floor" => Some(Self::Floor),
            "ceil" => Some(Self::Ceil),
            "pow" => Some(Self::Pow),
            "sqrt" => Some(Self::Sqrt),
            "ln" => Some(Self::Ln),
            "log10" => Some(Self::Log10),
            "sum" => Some(Self::Sum),
            "avg" => Some(Self::Avg),
            "len" => Some(Self::Len),
            "range" => Some(Self::Range),
            "format" => Some(Self::Format),
            "contains" => Some(Self::Contains),
            "lower" => Some(Self::Lower),
            "upper" => Some(Self::Upper),
            "trim" => Some(Self::Trim),
            "concat" => Some(Self::Concat),
            "coalesce" => Some(Self::Coalesce),
            "str" => Some(Self::Str),
            "num" => Some(Self::Num),
            "if" => Some(Self::If),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Min => "min",
            Self::Max => "max",
            Self::Clamp => "clamp",
            Self::Abs => "abs",
            Self::Round => "round",
            Self::Floor => "floor",
            Self::Ceil => "ceil",
            Self::Pow => "pow",
            Self::Sqrt => "sqrt",
            Self::Ln => "ln",
            Self::Log10 => "log10",
            Self::Sum => "sum",
            Self::Avg => "avg",
            Self::Len => "len",
            Self::Range => "range",
            Self::Format => "format",
            Self::Contains => "contains",
            Self::Lower => "lower",
            Self::Upper => "upper",
            Self::Trim => "trim",
            Self::Concat => "concat",
            Self::Coalesce => "coalesce",
            Self::Str => "str",
            Self::Num => "num",
            Self::If => "if",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum TemplatePart {
    Literal(String),
    Expr(Expr),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Template {
    pub parts: Vec<TemplatePart>,
}

impl Template {
    pub fn parse(source: &str) -> Result<Self, GenUiError> {
        parse_template(source)
    }

    pub fn parse_with_limits(source: &str, limits: EvalLimits) -> Result<Self, GenUiError> {
        parse_template_with_limits(source, limits)
    }

    pub fn is_static(&self) -> bool {
        self.parts.iter().all(|part| match part {
            TemplatePart::Literal(_) => true,
            TemplatePart::Expr(_) => false,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Literal(StateValue),
    Var(String),
    Template(Vec<TemplatePart>),
    List(Vec<Expr>),
    Record(Vec<(String, Expr)>),
    Unary {
        op: UnaryOp,
        operand: Box<Expr>,
    },
    Binary {
        op: BinaryOp,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Ternary {
        cond: Box<Expr>,
        then_branch: Box<Expr>,
        else_branch: Box<Expr>,
    },
    Field {
        target: Box<Expr>,
        name: String,
    },
    Index {
        target: Box<Expr>,
        index: Box<Expr>,
    },
    Call {
        func: BuiltinFn,
        args: Vec<Expr>,
    },
    Map {
        list: Box<Expr>,
        param: String,
        index_param: Option<String>,
        body: Box<Expr>,
    },
    Filter {
        list: Box<Expr>,
        param: String,
        index_param: Option<String>,
        predicate: Box<Expr>,
    },
    SortBy {
        list: Box<Expr>,
        param: String,
        index_param: Option<String>,
        key_expr: Box<Expr>,
        descending: bool,
    },
    Any {
        list: Box<Expr>,
        param: String,
        index_param: Option<String>,
        predicate: Box<Expr>,
    },
    All {
        list: Box<Expr>,
        param: String,
        index_param: Option<String>,
        predicate: Box<Expr>,
    },
}

impl Expr {
    pub fn parse(source: &str) -> Result<Self, GenUiError> {
        parse_expr(source)
    }

    pub fn parse_with_limits(source: &str, limits: EvalLimits) -> Result<Self, GenUiError> {
        parse_expr_with_limits(source, limits)
    }
}

pub fn parse_expr(source: &str) -> Result<Expr, GenUiError> {
    parse_expr_with_limits(source, EvalLimits::default())
}

pub fn parse_expr_with_limits(source: &str, limits: EvalLimits) -> Result<Expr, GenUiError> {
    let trimmed = strip_leading_formula_eq(source);
    parse_expr_nested(trimmed, 0, limits)
}

pub fn parse_template(source: &str) -> Result<Template, GenUiError> {
    parse_template_with_limits(source, EvalLimits::default())
}

pub fn parse_template_with_limits(source: &str, limits: EvalLimits) -> Result<Template, GenUiError> {
    let raw_parts = scan_raw_template(source, false, limits.max_depth)?;
    let parts = compile_template_parts(raw_parts, 0, limits)?;
    Ok(Template { parts })
}

pub fn referenced_keys(expr: &Expr) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    let mut bound = Vec::new();
    collect_expr_keys(expr, &mut bound, &mut keys);
    keys
}

pub fn template_referenced_keys(template: &Template) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    let mut bound = Vec::new();
    for part in &template.parts {
        match part {
            TemplatePart::Literal(_) => {}
            TemplatePart::Expr(expr) => collect_expr_keys(expr, &mut bound, &mut keys),
        }
    }
    keys
}

pub fn eval_expr(expr: &Expr, state: &StateStore, limits: EvalLimits) -> Result<StateValue, GenUiError> {
    let mut ctx = EvalCtx {
        state,
        limits,
        steps: 0,
        depth: 0,
        locals: Vec::new(),
    };
    ctx.eval(expr)
}

pub fn eval_template(template: &Template, state: &StateStore, limits: EvalLimits) -> Result<String, GenUiError> {
    let mut ctx = EvalCtx {
        state,
        limits,
        steps: 0,
        depth: 0,
        locals: Vec::new(),
    };
    ctx.eval_template_parts(&template.parts)
}

fn strip_leading_formula_eq(source: &str) -> &str {
    let trimmed = source.trim();
    if let Some(rest) = trimmed.strip_prefix('=')
        && !rest.starts_with('=')
    {
        return rest;
    }
    trimmed
}

fn collect_expr_keys<'a>(expr: &'a Expr, bound: &mut Vec<&'a str>, keys: &mut BTreeSet<String>) {
    match expr {
        Expr::Literal(_) => {}
        Expr::Var(name) => {
            if !bound.contains(&name.as_str()) {
                keys.insert(name.clone());
            }
        }
        Expr::Template(parts) => {
            for part in parts {
                match part {
                    TemplatePart::Literal(_) => {}
                    TemplatePart::Expr(inner) => collect_expr_keys(inner, bound, keys),
                }
            }
        }
        Expr::List(items) => {
            for item in items {
                collect_expr_keys(item, bound, keys);
            }
        }
        Expr::Record(entries) => {
            for (_, value) in entries {
                collect_expr_keys(value, bound, keys);
            }
        }
        Expr::Unary { operand, .. } => collect_expr_keys(operand, bound, keys),
        Expr::Binary { left, right, .. } => {
            collect_expr_keys(left, bound, keys);
            collect_expr_keys(right, bound, keys);
        }
        Expr::Ternary {
            cond,
            then_branch,
            else_branch,
        } => {
            collect_expr_keys(cond, bound, keys);
            collect_expr_keys(then_branch, bound, keys);
            collect_expr_keys(else_branch, bound, keys);
        }
        Expr::Field { target, .. } => collect_expr_keys(target, bound, keys),
        Expr::Index { target, index } => {
            collect_expr_keys(target, bound, keys);
            collect_expr_keys(index, bound, keys);
        }
        Expr::Call { args, .. } => {
            for arg in args {
                collect_expr_keys(arg, bound, keys);
            }
        }
        Expr::Map {
            list,
            param,
            index_param,
            body,
        }
        | Expr::Filter {
            list,
            param,
            index_param,
            predicate: body,
        }
        | Expr::SortBy {
            list,
            param,
            index_param,
            key_expr: body,
            ..
        }
        | Expr::Any {
            list,
            param,
            index_param,
            predicate: body,
        }
        | Expr::All {
            list,
            param,
            index_param,
            predicate: body,
        } => {
            collect_expr_keys(list, bound, keys);
            let saved = bound.len();
            bound.push(param.as_str());
            if let Some(idx) = index_param {
                bound.push(idx.as_str());
            }
            collect_expr_keys(body, bound, keys);
            bound.truncate(saved);
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
enum RawTemplatePart {
    Literal(String),
    Expr { source: String, pos: usize },
}

#[derive(Debug, Clone, PartialEq)]
enum TokenKind {
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
struct Token {
    kind: TokenKind,
    pos: usize,
}

fn scan_raw_template(input: &str, stop_at_double_quote: bool, max_depth: usize) -> Result<Vec<RawTemplatePart>, GenUiError> {
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

fn tokenize(input: &str, max_depth: usize) -> Result<Vec<Token>, GenUiError> {
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

fn compile_template_parts(raw_parts: Vec<RawTemplatePart>, depth: usize, limits: EvalLimits) -> Result<Vec<TemplatePart>, GenUiError> {
    let mut compiled = Vec::with_capacity(raw_parts.len());
    for part in raw_parts {
        match part {
            RawTemplatePart::Literal(text) => compiled.push(TemplatePart::Literal(text)),
            RawTemplatePart::Expr { source, pos } => {
                let expr = parse_expr_nested(&source, depth + 1, limits).map_err(|err| {
                    if let GenUiError::ExprParse { pos: inner_pos, message } = err {
                        GenUiError::ExprParse { pos: pos + inner_pos, message }
                    } else {
                        err
                    }
                })?;
                compiled.push(TemplatePart::Expr(expr));
            }
        }
    }
    Ok(compiled)
}

fn parse_expr_nested(source: &str, depth: usize, limits: EvalLimits) -> Result<Expr, GenUiError> {
    if depth > limits.max_depth {
        return Err(GenUiError::DepthLimitExceeded { limit: limits.max_depth });
    }
    let tokens = tokenize(source, limits.max_depth)?;
    let mut parser = Parser {
        tokens,
        cursor: 0,
        depth,
        limits,
    };
    let expr = parser.parse_ternary()?;
    if parser.peek().kind != TokenKind::Eof {
        return Err(GenUiError::ExprParse {
            pos: parser.peek().pos,
            message: "unexpected trailing token in expression".to_owned(),
        });
    }
    Ok(expr)
}

struct Parser {
    tokens: Vec<Token>,
    cursor: usize,
    depth: usize,
    limits: EvalLimits,
}

impl Parser {
    fn enter_depth(&mut self) -> Result<(), GenUiError> {
        self.depth += 1;
        if self.depth > self.limits.max_depth {
            return Err(GenUiError::DepthLimitExceeded { limit: self.limits.max_depth });
        }
        Ok(())
    }

    fn leave_depth(&mut self) {
        self.depth = self.depth.saturating_sub(1);
    }

    fn peek(&self) -> &Token {
        &self.tokens[self.cursor.min(self.tokens.len() - 1)]
    }

    fn peek_at(&self, offset: usize) -> &Token {
        let idx = (self.cursor + offset).min(self.tokens.len() - 1);
        &self.tokens[idx]
    }

    fn advance(&mut self) -> Token {
        let tok = self.peek().clone();
        if self.cursor + 1 < self.tokens.len() {
            self.cursor += 1;
        }
        tok
    }

    fn expect(&mut self, expected: &TokenKind, label: &str) -> Result<(), GenUiError> {
        if &self.peek().kind == expected {
            self.advance();
            Ok(())
        } else {
            Err(GenUiError::ExprParse {
                pos: self.peek().pos,
                message: format!("expected {label}"),
            })
        }
    }

    fn parse_ternary(&mut self) -> Result<Expr, GenUiError> {
        self.enter_depth()?;
        let cond = self.parse_or()?;
        let result = if matches!(self.peek().kind, TokenKind::Question) {
            self.advance();
            let then_branch = self.parse_ternary()?;
            self.expect(&TokenKind::Colon, "`:` in ternary expression")?;
            let else_branch = self.parse_ternary()?;
            Ok(Expr::Ternary {
                cond: Box::new(cond),
                then_branch: Box::new(then_branch),
                else_branch: Box::new(else_branch),
            })
        } else {
            Ok(cond)
        };
        self.leave_depth();
        result
    }

    fn parse_or(&mut self) -> Result<Expr, GenUiError> {
        let mut left = self.parse_and()?;
        while matches!(self.peek().kind, TokenKind::OrOr) {
            self.advance();
            let right = self.parse_and()?;
            left = Expr::Binary {
                op: BinaryOp::Or,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn parse_and(&mut self) -> Result<Expr, GenUiError> {
        let mut left = self.parse_equality()?;
        while matches!(self.peek().kind, TokenKind::AndAnd) {
            self.advance();
            let right = self.parse_equality()?;
            left = Expr::Binary {
                op: BinaryOp::And,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn parse_equality(&mut self) -> Result<Expr, GenUiError> {
        let mut left = self.parse_comparison()?;
        loop {
            let op = if self.peek().kind == TokenKind::EqEq {
                BinaryOp::Eq
            } else if self.peek().kind == TokenKind::BangEq {
                BinaryOp::Ne
            } else {
                break;
            };
            self.advance();
            let right = self.parse_comparison()?;
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn parse_comparison(&mut self) -> Result<Expr, GenUiError> {
        let mut left = self.parse_additive()?;
        loop {
            let op = if self.peek().kind == TokenKind::Lt {
                BinaryOp::Lt
            } else if self.peek().kind == TokenKind::LtEq {
                BinaryOp::Le
            } else if self.peek().kind == TokenKind::Gt {
                BinaryOp::Gt
            } else if self.peek().kind == TokenKind::GtEq {
                BinaryOp::Ge
            } else {
                break;
            };
            self.advance();
            let right = self.parse_additive()?;
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn parse_additive(&mut self) -> Result<Expr, GenUiError> {
        let mut left = self.parse_multiplicative()?;
        loop {
            let op = if self.peek().kind == TokenKind::Plus {
                BinaryOp::Add
            } else if self.peek().kind == TokenKind::Minus {
                BinaryOp::Sub
            } else {
                break;
            };
            self.advance();
            let right = self.parse_multiplicative()?;
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn parse_multiplicative(&mut self) -> Result<Expr, GenUiError> {
        let mut left = self.parse_unary()?;
        loop {
            let op = if self.peek().kind == TokenKind::Star {
                BinaryOp::Mul
            } else if self.peek().kind == TokenKind::Slash {
                BinaryOp::Div
            } else if self.peek().kind == TokenKind::Percent {
                BinaryOp::Mod
            } else {
                break;
            };
            self.advance();
            let right = self.parse_unary()?;
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn parse_unary(&mut self) -> Result<Expr, GenUiError> {
        let op = if self.peek().kind == TokenKind::Minus {
            Some(UnaryOp::Neg)
        } else if self.peek().kind == TokenKind::Bang {
            Some(UnaryOp::Not)
        } else if self.peek().kind == TokenKind::Plus {
            Some(UnaryOp::Pos)
        } else {
            None
        };
        if let Some(op) = op {
            self.enter_depth()?;
            self.advance();
            let operand = self.parse_unary()?;
            self.leave_depth();
            return Ok(Expr::Unary {
                op,
                operand: Box::new(operand),
            });
        }
        self.parse_power()
    }

    fn parse_power(&mut self) -> Result<Expr, GenUiError> {
        let base = self.parse_postfix()?;
        if self.peek().kind == TokenKind::Caret {
            self.enter_depth()?;
            self.advance();
            let exponent = self.parse_unary()?;
            self.leave_depth();
            return Ok(Expr::Binary {
                op: BinaryOp::Pow,
                left: Box::new(base),
                right: Box::new(exponent),
            });
        }
        Ok(base)
    }

    fn parse_postfix(&mut self) -> Result<Expr, GenUiError> {
        let mut expr = self.parse_primary()?;
        loop {
            if self.peek().kind == TokenKind::Dot {
                self.advance();
                let tok = self.advance();
                let TokenKind::Ident(name) = tok.kind else {
                    return Err(GenUiError::ExprParse {
                        pos: tok.pos,
                        message: "expected field name after `.`".to_owned(),
                    });
                };
                expr = Expr::Field { target: Box::new(expr), name };
            } else if self.peek().kind == TokenKind::LBracket {
                self.advance();
                let index = self.parse_ternary()?;
                self.expect(&TokenKind::RBracket, "`]` after index expression")?;
                expr = Expr::Index {
                    target: Box::new(expr),
                    index: Box::new(index),
                };
            } else {
                break;
            }
        }
        Ok(expr)
    }

    fn parse_primary(&mut self) -> Result<Expr, GenUiError> {
        let tok = self.advance();
        match tok.kind {
            TokenKind::Null => Ok(Expr::Literal(StateValue::Null)),
            TokenKind::True => Ok(Expr::Literal(StateValue::Bool(true))),
            TokenKind::False => Ok(Expr::Literal(StateValue::Bool(false))),
            TokenKind::Number(n) => Ok(Expr::Literal(StateValue::Number(n))),
            TokenKind::Text(s) => Ok(Expr::Literal(StateValue::Text(s))),
            TokenKind::Template(raw_parts) => {
                let parts = compile_template_parts(raw_parts, self.depth, self.limits)?;
                Ok(Expr::Template(parts))
            }
            TokenKind::StateVar(name) => Ok(Expr::Var(name)),
            TokenKind::Ident(name) => {
                if matches!(self.peek().kind, TokenKind::LParen) {
                    self.advance();
                    self.parse_call(&name)
                } else {
                    Ok(Expr::Var(name))
                }
            }
            TokenKind::LParen => {
                let expr = self.parse_ternary()?;
                self.expect(&TokenKind::RParen, "`)`")?;
                Ok(expr)
            }
            TokenKind::LBracket => {
                let mut items = Vec::new();
                while !matches!(self.peek().kind, TokenKind::RBracket | TokenKind::Eof) {
                    items.push(self.parse_ternary()?);
                    if items.len() > self.limits.max_collection_len {
                        return Err(GenUiError::CollectionLimitExceeded {
                            limit: self.limits.max_collection_len,
                        });
                    }
                    if matches!(self.peek().kind, TokenKind::Comma) {
                        self.advance();
                    } else {
                        break;
                    }
                }
                self.expect(&TokenKind::RBracket, "`]`")?;
                Ok(Expr::List(items))
            }
            TokenKind::LBrace => {
                let mut entries = Vec::new();
                while !matches!(self.peek().kind, TokenKind::RBrace | TokenKind::Eof) {
                    let key_tok = self.advance();
                    let key = if let TokenKind::Ident(k) | TokenKind::Text(k) = key_tok.kind {
                        k
                    } else {
                        return Err(GenUiError::ExprParse {
                            pos: key_tok.pos,
                            message: "expected record field key".to_owned(),
                        });
                    };
                    self.expect(&TokenKind::Colon, "`:` after record key")?;
                    let value = self.parse_ternary()?;
                    entries.push((key, value));
                    if entries.len() > self.limits.max_collection_len {
                        return Err(GenUiError::CollectionLimitExceeded {
                            limit: self.limits.max_collection_len,
                        });
                    }
                    if matches!(self.peek().kind, TokenKind::Comma) {
                        self.advance();
                    } else {
                        break;
                    }
                }
                self.expect(&TokenKind::RBrace, "`}`")?;
                Ok(Expr::Record(entries))
            }
            TokenKind::Plus
            | TokenKind::Minus
            | TokenKind::Star
            | TokenKind::Slash
            | TokenKind::Percent
            | TokenKind::Caret
            | TokenKind::Bang
            | TokenKind::EqEq
            | TokenKind::BangEq
            | TokenKind::Lt
            | TokenKind::LtEq
            | TokenKind::Gt
            | TokenKind::GtEq
            | TokenKind::AndAnd
            | TokenKind::OrOr
            | TokenKind::Question
            | TokenKind::Colon
            | TokenKind::FatArrow
            | TokenKind::Dot
            | TokenKind::Comma
            | TokenKind::RParen
            | TokenKind::RBracket
            | TokenKind::RBrace
            | TokenKind::Eof => Err(GenUiError::ExprParse {
                pos: tok.pos,
                message: "expected expression".to_owned(),
            }),
        }
    }

    fn parse_call(&mut self, name: &str) -> Result<Expr, GenUiError> {
        match name {
            "map" => self.parse_higher_order(HigherOrderKind::Map),
            "filter" => self.parse_higher_order(HigherOrderKind::Filter),
            "sort_by" => self.parse_higher_order(HigherOrderKind::SortBy),
            "any" => self.parse_higher_order(HigherOrderKind::Any),
            "all" => self.parse_higher_order(HigherOrderKind::All),
            _ => {
                let Some(func) = BuiltinFn::from_name(name) else {
                    return Err(GenUiError::UnknownFunction { name: name.to_owned() });
                };
                let mut args = Vec::new();
                while !matches!(self.peek().kind, TokenKind::RParen | TokenKind::Eof) {
                    args.push(self.parse_ternary()?);
                    if matches!(self.peek().kind, TokenKind::Comma) {
                        self.advance();
                    } else {
                        break;
                    }
                }
                self.expect(&TokenKind::RParen, "`)` after function arguments")?;
                Ok(Expr::Call { func, args })
            }
        }
    }

    fn parse_higher_order(&mut self, kind: HigherOrderKind) -> Result<Expr, GenUiError> {
        let fn_name = kind.name();
        if matches!(self.peek().kind, TokenKind::RParen) {
            return Err(GenUiError::ArityMismatch {
                function: fn_name.to_owned(),
                expected: "2..=4".to_owned(),
                actual: 0,
            });
        }
        let list = self.parse_ternary()?;
        self.expect(&TokenKind::Comma, "`,` after list argument")?;

        let (param, index_param, body, mut trailing_order) = if let Some((p, idx)) = self.try_parse_lambda_header() {
            let expr = self.parse_ternary()?;
            let order = if matches!(kind, HigherOrderKind::SortBy) && matches!(self.peek().kind, TokenKind::Comma) {
                self.advance();
                Some(self.parse_sort_order()?)
            } else {
                None
            };
            (p, idx, expr, order)
        } else {
            let mut rest = Vec::new();
            while !matches!(self.peek().kind, TokenKind::RParen | TokenKind::Eof) {
                rest.push(self.parse_ternary()?);
                if matches!(self.peek().kind, TokenKind::Comma) {
                    self.advance();
                } else {
                    break;
                }
            }
            let order = if matches!(kind, HigherOrderKind::SortBy) && rest.len() >= 3 {
                if let Some(Expr::Literal(StateValue::Text(dir))) = rest.last()
                    && (dir == "asc" || dir == "desc")
                {
                    let desc = dir == "desc";
                    rest.pop();
                    Some(desc)
                } else {
                    None
                }
            } else {
                None
            };
            match rest.len() {
                1 => ("item".to_owned(), Some("index".to_owned()), rest.remove(0), order),
                2 => {
                    let second = rest.remove(0);
                    let body = rest.remove(0);
                    let Expr::Var(param) = second else {
                        return Err(GenUiError::ExprParse {
                            pos: self.peek().pos,
                            message: format!("`{fn_name}` expects a parameter identifier as its second argument"),
                        });
                    };
                    (param, None, body, order)
                }
                3 => {
                    let second = rest.remove(0);
                    let third = rest.remove(0);
                    let body = rest.remove(0);
                    let (Expr::Var(param), Expr::Var(idx_param)) = (second, third) else {
                        return Err(GenUiError::ExprParse {
                            pos: self.peek().pos,
                            message: format!("`{fn_name}` expects identifier parameter names before body"),
                        });
                    };
                    (param, Some(idx_param), body, order)
                }
                other => {
                    return Err(GenUiError::ArityMismatch {
                        function: fn_name.to_owned(),
                        expected: "2..=4".to_owned(),
                        actual: other + 1,
                    });
                }
            }
        };

        if matches!(self.peek().kind, TokenKind::Comma) {
            self.advance();
        }
        self.expect(&TokenKind::RParen, "`)` after higher-order call")?;

        let descending = trailing_order.take().unwrap_or(false);
        Ok(match kind {
            HigherOrderKind::Map => Expr::Map {
                list: Box::new(list),
                param,
                index_param,
                body: Box::new(body),
            },
            HigherOrderKind::Filter => Expr::Filter {
                list: Box::new(list),
                param,
                index_param,
                predicate: Box::new(body),
            },
            HigherOrderKind::SortBy => Expr::SortBy {
                list: Box::new(list),
                param,
                index_param,
                key_expr: Box::new(body),
                descending,
            },
            HigherOrderKind::Any => Expr::Any {
                list: Box::new(list),
                param,
                index_param,
                predicate: Box::new(body),
            },
            HigherOrderKind::All => Expr::All {
                list: Box::new(list),
                param,
                index_param,
                predicate: Box::new(body),
            },
        })
    }

    fn try_parse_lambda_header(&mut self) -> Option<(String, Option<String>)> {
        if let TokenKind::Ident(p) = &self.peek().kind
            && matches!(self.peek_at(1).kind, TokenKind::FatArrow)
        {
            let param = p.clone();
            self.advance();
            self.advance();
            return Some((param, None));
        }
        if self.peek().kind == TokenKind::LParen
            && let TokenKind::Ident(p) = &self.peek_at(1).kind
        {
            if self.peek_at(2).kind == TokenKind::RParen && self.peek_at(3).kind == TokenKind::FatArrow {
                let param = p.clone();
                for _ in 0..4 {
                    self.advance();
                }
                return Some((param, None));
            }
            if self.peek_at(2).kind == TokenKind::Comma
                && let TokenKind::Ident(idx) = &self.peek_at(3).kind
                && self.peek_at(4).kind == TokenKind::RParen
                && self.peek_at(5).kind == TokenKind::FatArrow
            {
                let param = p.clone();
                let idx_param = idx.clone();
                for _ in 0..6 {
                    self.advance();
                }
                return Some((param, Some(idx_param)));
            }
        }
        None
    }

    fn parse_sort_order(&mut self) -> Result<bool, GenUiError> {
        let tok = self.advance();
        if let TokenKind::Text(ref dir) = tok.kind {
            if dir == "asc" {
                return Ok(false);
            }
            if dir == "desc" {
                return Ok(true);
            }
        }
        Err(GenUiError::ExprParse {
            pos: tok.pos,
            message: "sort_by direction must be `'asc'` or `'desc'`".to_owned(),
        })
    }
}

#[derive(Debug, Clone, Copy)]
enum HigherOrderKind {
    Map,
    Filter,
    SortBy,
    Any,
    All,
}

impl HigherOrderKind {
    fn name(self) -> &'static str {
        match self {
            Self::Map => "map",
            Self::Filter => "filter",
            Self::SortBy => "sort_by",
            Self::Any => "any",
            Self::All => "all",
        }
    }
}

struct EvalCtx<'a> {
    state: &'a StateStore,
    limits: EvalLimits,
    steps: usize,
    depth: usize,
    locals: Vec<(String, StateValue)>,
}

impl<'a> EvalCtx<'a> {
    fn step(&mut self) -> Result<(), GenUiError> {
        self.steps += 1;
        if self.steps > self.limits.max_steps {
            return Err(GenUiError::StepLimitExceeded { limit: self.limits.max_steps });
        }
        Ok(())
    }

    fn enter_depth(&mut self) -> Result<(), GenUiError> {
        self.depth += 1;
        if self.depth > self.limits.max_depth {
            return Err(GenUiError::DepthLimitExceeded { limit: self.limits.max_depth });
        }
        Ok(())
    }

    fn leave_depth(&mut self) {
        self.depth = self.depth.saturating_sub(1);
    }

    fn lookup(&self, name: &str) -> Result<StateValue, GenUiError> {
        for (local_name, val) in self.locals.iter().rev() {
            if local_name == name {
                return Ok(val.clone());
            }
        }
        self.state
            .get(name)
            .cloned()
            .ok_or_else(|| GenUiError::UndefinedVariable { name: name.to_owned() })
    }

    fn eval_template_parts(&mut self, parts: &[TemplatePart]) -> Result<String, GenUiError> {
        let mut out = String::new();
        for part in parts {
            self.step()?;
            match part {
                TemplatePart::Literal(lit) => {
                    if out.len().saturating_add(lit.len()) > self.limits.max_string_len {
                        return Err(GenUiError::StringLimitExceeded {
                            limit: self.limits.max_string_len,
                        });
                    }
                    out.push_str(lit);
                }
                TemplatePart::Expr(expr) => {
                    let val = self.eval(expr)?;
                    let piece = val.to_display_string();
                    if out.len().saturating_add(piece.len()) > self.limits.max_string_len {
                        return Err(GenUiError::StringLimitExceeded {
                            limit: self.limits.max_string_len,
                        });
                    }
                    out.push_str(&piece);
                }
            }
        }
        Ok(out)
    }

    fn eval(&mut self, expr: &Expr) -> Result<StateValue, GenUiError> {
        self.step()?;
        self.enter_depth()?;
        let res = self.eval_inner(expr);
        self.leave_depth();
        res
    }

    fn eval_inner(&mut self, expr: &Expr) -> Result<StateValue, GenUiError> {
        match expr {
            Expr::Literal(val) => Ok(val.clone()),
            Expr::Var(name) => self.lookup(name),
            Expr::Template(parts) => Ok(StateValue::Text(self.eval_template_parts(parts)?)),
            Expr::List(items) => {
                if items.len() > self.limits.max_collection_len {
                    return Err(GenUiError::CollectionLimitExceeded {
                        limit: self.limits.max_collection_len,
                    });
                }
                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    out.push(self.eval(item)?);
                }
                Ok(StateValue::List(out))
            }
            Expr::Record(entries) => {
                if entries.len() > self.limits.max_collection_len {
                    return Err(GenUiError::CollectionLimitExceeded {
                        limit: self.limits.max_collection_len,
                    });
                }
                let mut out = Vec::with_capacity(entries.len());
                for (k, v) in entries {
                    out.push((k.clone(), self.eval(v)?));
                }
                Ok(StateValue::Record(out))
            }
            Expr::Unary { op, operand } => {
                let val = self.eval(operand)?;
                match op {
                    UnaryOp::Not => Ok(StateValue::Bool(!val.is_truthy())),
                    UnaryOp::Neg => {
                        let n = expect_number(&val, "unary `-`")?;
                        StateValue::number(-n)
                    }
                    UnaryOp::Pos => {
                        let n = expect_number(&val, "unary `+`")?;
                        StateValue::number(n)
                    }
                }
            }
            Expr::Binary { op, left, right } => self.eval_binary(*op, left, right),
            Expr::Ternary {
                cond,
                then_branch,
                else_branch,
            } => {
                let cond_val = self.eval(cond)?;
                if cond_val.is_truthy() {
                    self.eval(then_branch)
                } else {
                    self.eval(else_branch)
                }
            }
            Expr::Field { target, name } => {
                let val = self.eval(target)?;
                match val {
                    StateValue::Record(_) => Ok(val.get_field(name).cloned().unwrap_or(StateValue::Null)),
                    StateValue::Null => Ok(StateValue::Null),
                    StateValue::Bool(_) | StateValue::Number(_) | StateValue::Text(_) | StateValue::List(_) => Err(GenUiError::TypeMismatch {
                        context: format!("field access `.{name}`"),
                        expected: "record".to_owned(),
                        actual: val.type_name().to_owned(),
                    }),
                }
            }
            Expr::Index { target, index } => {
                let container = self.eval(target)?;
                let idx = self.eval(index)?;
                match container {
                    StateValue::List(items) => {
                        let n = expect_number(&idx, "list index")?;
                        if n < 0.0 || n.fract() != 0.0 {
                            return Err(GenUiError::TypeMismatch {
                                context: "list index".to_owned(),
                                expected: "non-negative integer".to_owned(),
                                actual: format!("{n}"),
                            });
                        }
                        Ok(items.get(n as usize).cloned().unwrap_or(StateValue::Null))
                    }
                    StateValue::Record(_) => {
                        let key = expect_text(&idx, "record index")?;
                        Ok(container.get_field(key).cloned().unwrap_or(StateValue::Null))
                    }
                    StateValue::Null => Ok(StateValue::Null),
                    StateValue::Bool(_) | StateValue::Number(_) | StateValue::Text(_) => Err(GenUiError::TypeMismatch {
                        context: "index access".to_owned(),
                        expected: "list or record".to_owned(),
                        actual: container.type_name().to_owned(),
                    }),
                }
            }
            Expr::Call { func, args } => self.eval_builtin(*func, args),
            Expr::Map {
                list,
                param,
                index_param,
                body,
            } => {
                let items = self.eval_list(list, "map")?;
                if items.len() > self.limits.max_collection_len {
                    return Err(GenUiError::CollectionLimitExceeded {
                        limit: self.limits.max_collection_len,
                    });
                }
                let mut out = Vec::with_capacity(items.len());
                for (i, item) in items.into_iter().enumerate() {
                    self.step()?;
                    let mapped = self.with_item_binding(param, index_param.as_deref(), item, i, |ctx| ctx.eval(body))?;
                    out.push(mapped);
                }
                Ok(StateValue::List(out))
            }
            Expr::Filter {
                list,
                param,
                index_param,
                predicate,
            } => {
                let items = self.eval_list(list, "filter")?;
                let mut out = Vec::new();
                for (i, item) in items.into_iter().enumerate() {
                    self.step()?;
                    let keep = self.with_item_binding(param, index_param.as_deref(), item.clone(), i, |ctx| ctx.eval(predicate))?;
                    if keep.is_truthy() {
                        out.push(item);
                    }
                }
                Ok(StateValue::List(out))
            }
            Expr::SortBy {
                list,
                param,
                index_param,
                key_expr,
                descending,
            } => {
                let items = self.eval_list(list, "sort_by")?;
                let mut keyed = Vec::with_capacity(items.len());
                for (i, item) in items.into_iter().enumerate() {
                    self.step()?;
                    let key = self.with_item_binding(param, index_param.as_deref(), item.clone(), i, |ctx| ctx.eval(key_expr))?;
                    keyed.push((key, item));
                }
                keyed.sort_by(|(ka, _), (kb, _)| {
                    let ord = compare_sort_keys(ka, kb);
                    if *descending { ord.reverse() } else { ord }
                });
                Ok(StateValue::List(keyed.into_iter().map(|(_, v)| v).collect()))
            }
            Expr::Any {
                list,
                param,
                index_param,
                predicate,
            } => {
                let items = self.eval_list(list, "any")?;
                for (i, item) in items.into_iter().enumerate() {
                    self.step()?;
                    let matched = self.with_item_binding(param, index_param.as_deref(), item, i, |ctx| ctx.eval(predicate))?;
                    if matched.is_truthy() {
                        return Ok(StateValue::Bool(true));
                    }
                }
                Ok(StateValue::Bool(false))
            }
            Expr::All {
                list,
                param,
                index_param,
                predicate,
            } => {
                let items = self.eval_list(list, "all")?;
                for (i, item) in items.into_iter().enumerate() {
                    self.step()?;
                    let matched = self.with_item_binding(param, index_param.as_deref(), item, i, |ctx| ctx.eval(predicate))?;
                    if !matched.is_truthy() {
                        return Ok(StateValue::Bool(false));
                    }
                }
                Ok(StateValue::Bool(true))
            }
        }
    }

    fn with_item_binding<T>(
        &mut self,
        param: &str,
        index_param: Option<&str>,
        item: StateValue,
        idx: usize,
        f: impl FnOnce(&mut Self) -> Result<T, GenUiError>,
    ) -> Result<T, GenUiError> {
        let saved = self.locals.len();
        self.locals.push((param.to_owned(), item));
        if let Some(idx_name) = index_param {
            self.locals.push((idx_name.to_owned(), StateValue::Number(idx as f64)));
        }
        let result = f(self);
        self.locals.truncate(saved);
        result
    }

    fn eval_list(&mut self, expr: &Expr, context: &str) -> Result<Vec<StateValue>, GenUiError> {
        let val = self.eval(expr)?;
        match val {
            StateValue::List(items) => Ok(items),
            StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) | StateValue::Text(_) | StateValue::Record(_) => Err(GenUiError::TypeMismatch {
                context: context.to_owned(),
                expected: "list".to_owned(),
                actual: val.type_name().to_owned(),
            }),
        }
    }

    fn eval_binary(&mut self, op: BinaryOp, left_expr: &Expr, right_expr: &Expr) -> Result<StateValue, GenUiError> {
        match op {
            BinaryOp::And => {
                let left = self.eval(left_expr)?;
                if !left.is_truthy() {
                    return Ok(StateValue::Bool(false));
                }
                let right = self.eval(right_expr)?;
                return Ok(StateValue::Bool(right.is_truthy()));
            }
            BinaryOp::Or => {
                let left = self.eval(left_expr)?;
                if left.is_truthy() {
                    return Ok(StateValue::Bool(true));
                }
                let right = self.eval(right_expr)?;
                return Ok(StateValue::Bool(right.is_truthy()));
            }
            BinaryOp::Add
            | BinaryOp::Sub
            | BinaryOp::Mul
            | BinaryOp::Div
            | BinaryOp::Mod
            | BinaryOp::Pow
            | BinaryOp::Eq
            | BinaryOp::Ne
            | BinaryOp::Lt
            | BinaryOp::Le
            | BinaryOp::Gt
            | BinaryOp::Ge => {}
        }

        let left = self.eval(left_expr)?;
        let right = self.eval(right_expr)?;

        match op {
            BinaryOp::Add => match (&left, &right) {
                (StateValue::Number(a), StateValue::Number(b)) => checked_finite(a + b, "`+`"),
                (
                    StateValue::Text(_),
                    StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) | StateValue::Text(_) | StateValue::List(_) | StateValue::Record(_),
                )
                | (StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) | StateValue::List(_) | StateValue::Record(_), StateValue::Text(_)) => {
                    let a = left.to_display_string();
                    let b = right.to_display_string();
                    if a.len().saturating_add(b.len()) > self.limits.max_string_len {
                        return Err(GenUiError::StringLimitExceeded {
                            limit: self.limits.max_string_len,
                        });
                    }
                    Ok(StateValue::Text(format!("{a}{b}")))
                }
                (
                    StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) | StateValue::List(_) | StateValue::Record(_),
                    StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) | StateValue::List(_) | StateValue::Record(_),
                ) => Err(GenUiError::TypeMismatch {
                    context: "`+`".to_owned(),
                    expected: "number or text".to_owned(),
                    actual: format!("{} and {}", left.type_name(), right.type_name()),
                }),
            },
            BinaryOp::Sub => {
                let a = expect_number(&left, "`-`")?;
                let b = expect_number(&right, "`-`")?;
                checked_finite(a - b, "`-`")
            }
            BinaryOp::Mul => {
                let a = expect_number(&left, "`*`")?;
                let b = expect_number(&right, "`*`")?;
                checked_finite(a * b, "`*`")
            }
            BinaryOp::Div => {
                let a = expect_number(&left, "`/`")?;
                let b = expect_number(&right, "`/`")?;
                if b == 0.0 {
                    return Err(GenUiError::DivisionByZero);
                }
                checked_finite(a / b, "`/`")
            }
            BinaryOp::Mod => {
                let a = expect_number(&left, "`%`")?;
                let b = expect_number(&right, "`%`")?;
                if b == 0.0 {
                    return Err(GenUiError::DivisionByZero);
                }
                checked_finite(a % b, "`%`")
            }
            BinaryOp::Pow => {
                let a = expect_number(&left, "`^`")?;
                let b = expect_number(&right, "`^`")?;
                checked_finite(a.powf(b), "`^`")
            }
            BinaryOp::Eq => Ok(StateValue::Bool(left.structural_eq(&right))),
            BinaryOp::Ne => Ok(StateValue::Bool(!left.structural_eq(&right))),
            BinaryOp::Lt => Ok(StateValue::Bool(compare_ordered(&left, &right, "`<`")? == Ordering::Less)),
            BinaryOp::Le => Ok(StateValue::Bool(compare_ordered(&left, &right, "`<=`")? != Ordering::Greater)),
            BinaryOp::Gt => Ok(StateValue::Bool(compare_ordered(&left, &right, "`>`")? == Ordering::Greater)),
            BinaryOp::Ge => Ok(StateValue::Bool(compare_ordered(&left, &right, "`>=`")? != Ordering::Less)),
            BinaryOp::And | BinaryOp::Or => unreachable!("short-circuited above"),
        }
    }

    fn eval_builtin(&mut self, func: BuiltinFn, args: &[Expr]) -> Result<StateValue, GenUiError> {
        let name = func.name();
        match func {
            BuiltinFn::If => {
                if args.len() != 3 {
                    return Err(GenUiError::ArityMismatch {
                        function: name.to_owned(),
                        expected: "3".to_owned(),
                        actual: args.len(),
                    });
                }
                let cond = self.eval(&args[0])?;
                if cond.is_truthy() { self.eval(&args[1]) } else { self.eval(&args[2]) }
            }
            BuiltinFn::Coalesce => {
                if args.is_empty() {
                    return Err(GenUiError::ArityMismatch {
                        function: name.to_owned(),
                        expected: ">= 1".to_owned(),
                        actual: 0,
                    });
                }
                for arg in args {
                    let val = self.eval(arg)?;
                    if !matches!(val, StateValue::Null) {
                        return Ok(val);
                    }
                }
                Ok(StateValue::Null)
            }
            BuiltinFn::Min => {
                let nums = self.eval_numeric_args(args, name)?;
                match nums.into_iter().reduce(f64::min) {
                    Some(v) => checked_finite(v, name),
                    None => Ok(StateValue::Null),
                }
            }
            BuiltinFn::Max => {
                let nums = self.eval_numeric_args(args, name)?;
                match nums.into_iter().reduce(f64::max) {
                    Some(v) => checked_finite(v, name),
                    None => Ok(StateValue::Null),
                }
            }
            BuiltinFn::Clamp => {
                let vals = self.eval_exact_args(args, 3, name)?;
                let x = expect_number(&vals[0], name)?;
                let lo = expect_number(&vals[1], name)?;
                let hi = expect_number(&vals[2], name)?;
                if lo > hi {
                    return Err(GenUiError::InvalidRange {
                        message: format!("clamp min ({lo}) exceeds max ({hi})"),
                    });
                }
                checked_finite(x.clamp(lo, hi), name)
            }
            BuiltinFn::Abs => {
                let vals = self.eval_exact_args(args, 1, name)?;
                checked_finite(expect_number(&vals[0], name)?.abs(), name)
            }
            BuiltinFn::Round => {
                if args.is_empty() || args.len() > 2 {
                    return Err(GenUiError::ArityMismatch {
                        function: name.to_owned(),
                        expected: "1..=2".to_owned(),
                        actual: args.len(),
                    });
                }
                let x = expect_number(&self.eval(&args[0])?, name)?;
                if args.len() == 1 {
                    return checked_finite(x.round(), name);
                }
                let decimals = expect_number(&self.eval(&args[1])?, name)?;
                if decimals < 0.0 || decimals > 12.0 || decimals.fract() != 0.0 {
                    return Err(GenUiError::InvalidRange {
                        message: format!("round precision must be an integer in 0..=12, got {decimals}"),
                    });
                }
                let factor = 10_f64.powi(decimals as i32);
                checked_finite((x * factor).round() / factor, name)
            }
            BuiltinFn::Floor => {
                let vals = self.eval_exact_args(args, 1, name)?;
                checked_finite(expect_number(&vals[0], name)?.floor(), name)
            }
            BuiltinFn::Ceil => {
                let vals = self.eval_exact_args(args, 1, name)?;
                checked_finite(expect_number(&vals[0], name)?.ceil(), name)
            }
            BuiltinFn::Pow => {
                let vals = self.eval_exact_args(args, 2, name)?;
                let base = expect_number(&vals[0], name)?;
                let exp = expect_number(&vals[1], name)?;
                checked_finite(base.powf(exp), name)
            }
            BuiltinFn::Sqrt => {
                let vals = self.eval_exact_args(args, 1, name)?;
                let x = expect_number(&vals[0], name)?;
                if x < 0.0 {
                    return Err(GenUiError::NonFiniteResult { context: name.to_owned() });
                }
                checked_finite(x.sqrt(), name)
            }
            BuiltinFn::Ln => {
                let vals = self.eval_exact_args(args, 1, name)?;
                let x = expect_number(&vals[0], name)?;
                if x <= 0.0 {
                    return Err(GenUiError::NonFiniteResult { context: name.to_owned() });
                }
                checked_finite(x.ln(), name)
            }
            BuiltinFn::Log10 => {
                let vals = self.eval_exact_args(args, 1, name)?;
                let x = expect_number(&vals[0], name)?;
                if x <= 0.0 {
                    return Err(GenUiError::NonFiniteResult { context: name.to_owned() });
                }
                checked_finite(x.log10(), name)
            }
            BuiltinFn::Sum => {
                let nums = self.eval_numeric_args(args, name)?;
                let total: f64 = nums.into_iter().sum();
                checked_finite(total, name)
            }
            BuiltinFn::Avg => {
                let nums = self.eval_numeric_args(args, name)?;
                if nums.is_empty() {
                    return Ok(StateValue::Number(0.0));
                }
                let count = nums.len() as f64;
                let total: f64 = nums.into_iter().sum();
                checked_finite(total / count, name)
            }
            BuiltinFn::Len => {
                let vals = self.eval_exact_args(args, 1, name)?;
                let length = match &vals[0] {
                    StateValue::List(items) => items.len(),
                    StateValue::Text(s) => s.chars().count(),
                    StateValue::Record(entries) => entries.len(),
                    StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) => {
                        return Err(GenUiError::TypeMismatch {
                            context: name.to_owned(),
                            expected: "list, text, or record".to_owned(),
                            actual: vals[0].type_name().to_owned(),
                        });
                    }
                };
                Ok(StateValue::Number(length as f64))
            }
            BuiltinFn::Range => {
                if args.is_empty() || args.len() > 3 {
                    return Err(GenUiError::ArityMismatch {
                        function: name.to_owned(),
                        expected: "1..=3".to_owned(),
                        actual: args.len(),
                    });
                }
                let (start, end, step) = match args.len() {
                    1 => (0.0, expect_number(&self.eval(&args[0])?, name)?, 1.0),
                    2 => (expect_number(&self.eval(&args[0])?, name)?, expect_number(&self.eval(&args[1])?, name)?, 1.0),
                    _ => (
                        expect_number(&self.eval(&args[0])?, name)?,
                        expect_number(&self.eval(&args[1])?, name)?,
                        expect_number(&self.eval(&args[2])?, name)?,
                    ),
                };
                if !step.is_finite() || step == 0.0 {
                    return Err(GenUiError::InvalidRange {
                        message: "step must be a finite non-zero number".to_owned(),
                    });
                }
                let mut out = Vec::new();
                let mut idx: usize = 0;
                loop {
                    let cur = normalize_zero(start + (idx as f64) * step);
                    let in_bounds = if step > 0.0 { cur < end } else { cur > end };
                    if !in_bounds {
                        break;
                    }
                    if out.len() >= self.limits.max_collection_len {
                        return Err(GenUiError::CollectionLimitExceeded {
                            limit: self.limits.max_collection_len,
                        });
                    }
                    self.step()?;
                    out.push(StateValue::Number(cur));
                    idx += 1;
                }
                Ok(StateValue::List(out))
            }
            BuiltinFn::Format => {
                if args.len() < 2 || args.len() > 3 {
                    return Err(GenUiError::ArityMismatch {
                        function: name.to_owned(),
                        expected: "2..=3".to_owned(),
                        actual: args.len(),
                    });
                }
                let val = self.eval(&args[0])?;
                let kind_val = self.eval(&args[1])?;
                let kind_name = expect_text(&kind_val, name)?;
                let fmt_kind = FormatKind::parse(kind_name)?;
                let precision = if args.len() == 3 {
                    let p_val = self.eval(&args[2])?;
                    let p = expect_number(&p_val, name)?;
                    if p < 0.0 || p > 8.0 || p.fract() != 0.0 {
                        return Err(GenUiError::InvalidRange {
                            message: format!("format precision must be an integer in 0..=8, got {p}"),
                        });
                    }
                    Some(p as u8)
                } else {
                    None
                };
                Ok(StateValue::Text(format_value(&val, fmt_kind, precision)?))
            }
            BuiltinFn::Contains => {
                let vals = self.eval_exact_args(args, 2, name)?;
                let found = match &vals[0] {
                    StateValue::Text(haystack) => {
                        let needle = expect_text(&vals[1], name)?;
                        haystack.contains(needle)
                    }
                    StateValue::List(items) => items.iter().any(|item| item.structural_eq(&vals[1])),
                    StateValue::Record(_) => {
                        let key = expect_text(&vals[1], name)?;
                        vals[0].get_field(key).is_some()
                    }
                    StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) => {
                        return Err(GenUiError::TypeMismatch {
                            context: name.to_owned(),
                            expected: "text, list, or record".to_owned(),
                            actual: vals[0].type_name().to_owned(),
                        });
                    }
                };
                Ok(StateValue::Bool(found))
            }
            BuiltinFn::Lower => {
                let vals = self.eval_exact_args(args, 1, name)?;
                Ok(StateValue::Text(expect_text(&vals[0], name)?.to_lowercase()))
            }
            BuiltinFn::Upper => {
                let vals = self.eval_exact_args(args, 1, name)?;
                Ok(StateValue::Text(expect_text(&vals[0], name)?.to_uppercase()))
            }
            BuiltinFn::Trim => {
                let vals = self.eval_exact_args(args, 1, name)?;
                Ok(StateValue::Text(expect_text(&vals[0], name)?.trim().to_owned()))
            }
            BuiltinFn::Concat => {
                if args.is_empty() {
                    return Ok(StateValue::Text(String::new()));
                }
                let first = self.eval(&args[0])?;
                if let StateValue::List(mut items) = first {
                    if items.len() > self.limits.max_collection_len {
                        return Err(GenUiError::CollectionLimitExceeded {
                            limit: self.limits.max_collection_len,
                        });
                    }
                    for arg in &args[1..] {
                        let next = self.eval(arg)?;
                        match next {
                            StateValue::List(more) => {
                                if items.len().saturating_add(more.len()) > self.limits.max_collection_len {
                                    return Err(GenUiError::CollectionLimitExceeded {
                                        limit: self.limits.max_collection_len,
                                    });
                                }
                                items.extend(more);
                            }
                            StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) | StateValue::Text(_) | StateValue::Record(_) => {
                                if items.len() >= self.limits.max_collection_len {
                                    return Err(GenUiError::CollectionLimitExceeded {
                                        limit: self.limits.max_collection_len,
                                    });
                                }
                                items.push(next);
                            }
                        }
                    }
                    return Ok(StateValue::List(items));
                }
                let mut out = first.to_display_string();
                if out.len() > self.limits.max_string_len {
                    return Err(GenUiError::StringLimitExceeded {
                        limit: self.limits.max_string_len,
                    });
                }
                for arg in &args[1..] {
                    let piece = self.eval(arg)?.to_display_string();
                    if out.len().saturating_add(piece.len()) > self.limits.max_string_len {
                        return Err(GenUiError::StringLimitExceeded {
                            limit: self.limits.max_string_len,
                        });
                    }
                    out.push_str(&piece);
                }
                Ok(StateValue::Text(out))
            }
            BuiltinFn::Str => {
                let vals = self.eval_exact_args(args, 1, name)?;
                Ok(StateValue::Text(vals[0].to_display_string()))
            }
            BuiltinFn::Num => {
                let vals = self.eval_exact_args(args, 1, name)?;
                match &vals[0] {
                    StateValue::Number(n) => checked_finite(*n, name),
                    StateValue::Bool(b) => Ok(StateValue::Number(if *b { 1.0 } else { 0.0 })),
                    StateValue::Text(s) => {
                        let parsed: f64 = s.trim().parse().map_err(|_| GenUiError::TypeMismatch {
                            context: name.to_owned(),
                            expected: "numeric text".to_owned(),
                            actual: s.clone(),
                        })?;
                        checked_finite(parsed, name)
                    }
                    StateValue::Null | StateValue::List(_) | StateValue::Record(_) => Err(GenUiError::TypeMismatch {
                        context: name.to_owned(),
                        expected: "number, bool, or numeric text".to_owned(),
                        actual: vals[0].type_name().to_owned(),
                    }),
                }
            }
        }
    }

    fn eval_exact_args(&mut self, args: &[Expr], expected: usize, fn_name: &str) -> Result<Vec<StateValue>, GenUiError> {
        if args.len() != expected {
            return Err(GenUiError::ArityMismatch {
                function: fn_name.to_owned(),
                expected: expected.to_string(),
                actual: args.len(),
            });
        }
        let mut out = Vec::with_capacity(expected);
        for arg in args {
            out.push(self.eval(arg)?);
        }
        Ok(out)
    }

    fn eval_numeric_args(&mut self, args: &[Expr], fn_name: &str) -> Result<Vec<f64>, GenUiError> {
        if args.is_empty() {
            return Err(GenUiError::ArityMismatch {
                function: fn_name.to_owned(),
                expected: ">= 1".to_owned(),
                actual: 0,
            });
        }
        let mut nums = Vec::new();
        if args.len() == 1 {
            let val = self.eval(&args[0])?;
            match val {
                StateValue::List(items) => {
                    for item in items {
                        self.step()?;
                        match item {
                            StateValue::Number(n) => nums.push(n),
                            StateValue::Null => {}
                            StateValue::Bool(_) | StateValue::Text(_) | StateValue::List(_) | StateValue::Record(_) => {
                                return Err(GenUiError::TypeMismatch {
                                    context: fn_name.to_owned(),
                                    expected: "number".to_owned(),
                                    actual: item.type_name().to_owned(),
                                });
                            }
                        }
                    }
                    return Ok(nums);
                }
                StateValue::Number(n) => return Ok(vec![n]),
                StateValue::Null | StateValue::Bool(_) | StateValue::Text(_) | StateValue::Record(_) => {
                    return Err(GenUiError::TypeMismatch {
                        context: fn_name.to_owned(),
                        expected: "number or list of numbers".to_owned(),
                        actual: val.type_name().to_owned(),
                    });
                }
            }
        }
        for arg in args {
            let val = self.eval(arg)?;
            nums.push(expect_number(&val, fn_name)?);
        }
        Ok(nums)
    }
}

fn expect_number(val: &StateValue, context: &str) -> Result<f64, GenUiError> {
    match val {
        StateValue::Number(n) => {
            if !n.is_finite() {
                return Err(GenUiError::NonFiniteResult { context: context.to_owned() });
            }
            Ok(*n)
        }
        StateValue::Null | StateValue::Bool(_) | StateValue::Text(_) | StateValue::List(_) | StateValue::Record(_) => Err(GenUiError::TypeMismatch {
            context: context.to_owned(),
            expected: "number".to_owned(),
            actual: val.type_name().to_owned(),
        }),
    }
}

fn expect_text<'a>(val: &'a StateValue, context: &str) -> Result<&'a str, GenUiError> {
    match val {
        StateValue::Text(s) => Ok(s.as_str()),
        StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) | StateValue::List(_) | StateValue::Record(_) => Err(GenUiError::TypeMismatch {
            context: context.to_owned(),
            expected: "text".to_owned(),
            actual: val.type_name().to_owned(),
        }),
    }
}

fn checked_finite(value: f64, context: &str) -> Result<StateValue, GenUiError> {
    if !value.is_finite() {
        return Err(GenUiError::NonFiniteResult { context: context.to_owned() });
    }
    Ok(StateValue::Number(normalize_zero(value)))
}

fn compare_ordered(left: &StateValue, right: &StateValue, context: &str) -> Result<Ordering, GenUiError> {
    let mismatch = || GenUiError::TypeMismatch {
        context: context.to_owned(),
        expected: "matching comparable types (number, text, or bool)".to_owned(),
        actual: format!("{} and {}", left.type_name(), right.type_name()),
    };
    match left {
        StateValue::Number(a) => match right {
            StateValue::Number(b) => a.partial_cmp(b).ok_or_else(|| GenUiError::NonFiniteResult { context: context.to_owned() }),
            StateValue::Null | StateValue::Bool(_) | StateValue::Text(_) | StateValue::List(_) | StateValue::Record(_) => Err(mismatch()),
        },
        StateValue::Text(a) => match right {
            StateValue::Text(b) => Ok(a.cmp(b)),
            StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) | StateValue::List(_) | StateValue::Record(_) => Err(mismatch()),
        },
        StateValue::Bool(a) => match right {
            StateValue::Bool(b) => Ok(a.cmp(b)),
            StateValue::Null | StateValue::Number(_) | StateValue::Text(_) | StateValue::List(_) | StateValue::Record(_) => Err(mismatch()),
        },
        StateValue::Null | StateValue::List(_) | StateValue::Record(_) => Err(mismatch()),
    }
}

fn compare_sort_keys(left: &StateValue, right: &StateValue) -> Ordering {
    let rank = |v: &StateValue| -> u8 {
        match v {
            StateValue::Null => 0,
            StateValue::Bool(_) => 1,
            StateValue::Number(_) => 2,
            StateValue::Text(_) => 3,
            StateValue::List(_) => 4,
            StateValue::Record(_) => 5,
        }
    };
    let ra = rank(left);
    let rb = rank(right);
    if ra != rb {
        return ra.cmp(&rb);
    }
    match left {
        StateValue::Null => Ordering::Equal,
        StateValue::Bool(a) => match right {
            StateValue::Bool(b) => a.cmp(b),
            StateValue::Null | StateValue::Number(_) | StateValue::Text(_) | StateValue::List(_) | StateValue::Record(_) => Ordering::Equal,
        },
        StateValue::Number(a) => match right {
            StateValue::Number(b) => a.total_cmp(b),
            StateValue::Null | StateValue::Bool(_) | StateValue::Text(_) | StateValue::List(_) | StateValue::Record(_) => Ordering::Equal,
        },
        StateValue::Text(a) => match right {
            StateValue::Text(b) => a.cmp(b),
            StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) | StateValue::List(_) | StateValue::Record(_) => Ordering::Equal,
        },
        StateValue::List(a) => match right {
            StateValue::List(b) => a.len().cmp(&b.len()),
            StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) | StateValue::Text(_) | StateValue::Record(_) => Ordering::Equal,
        },
        StateValue::Record(a) => match right {
            StateValue::Record(b) => a.len().cmp(&b.len()),
            StateValue::Null | StateValue::Bool(_) | StateValue::Number(_) | StateValue::Text(_) | StateValue::List(_) => Ordering::Equal,
        },
    }
}
