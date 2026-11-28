use super::raw::{Flags, GroupDecl, IntervalSpec, MAX_REPEAT_BOUND, RawExpr, SpecialGroup};
use super::resolve::resolve_ast;
use crate::ast::{Anchor, Expr, ParsedPattern, QuantifierMode};
use crate::options::{CompileError, CompileErrorKind, FindOption, Syntax};

pub fn parse(pattern: &str, options: FindOption, syntax: Syntax) -> Result<ParsedPattern, CompileError> {
    if syntax == Syntax::Asis {
        let flags = Flags::from_options(options, syntax);
        let expr = if pattern.is_empty() {
            Expr::Empty
        } else {
            Expr::Literal {
                text: pattern.to_string(),
                ignore_case: flags.ignore_case,
                ascii_icase: flags.ignore_case_ascii,
            }
        };
        return Ok(ParsedPattern {
            expr,
            num_captures: 0,
            named_groups: Vec::new(),
            has_g_anchor: false,
            whole_options: options,
        });
    }

    let mut parser = Parser {
        src: pattern,
        bytes: pattern.as_bytes(),
        pos: 0,
        syntax,
        flags: Flags::from_options(options, syntax),
        whole_options: options,
        groups: Vec::new(),
        has_named_group: false,
        depth: 0,
        at_pattern_start: true,
    };

    let raw = parser.parse_alt(false)?;
    if parser.pos < parser.bytes.len() {
        return Err(CompileError::new(CompileErrorKind::Syntax, parser.pos, "unmatched closing parenthesis"));
    }

    resolve_ast(raw, &parser.groups, parser.has_named_group, parser.whole_options)
}

pub(super) struct Parser<'a> {
    pub(super) src: &'a str,
    pub(super) bytes: &'a [u8],
    pub(super) pos: usize,
    pub(super) syntax: Syntax,
    pub(super) flags: Flags,
    pub(super) whole_options: FindOption,
    pub(super) groups: Vec<GroupDecl>,
    pub(super) has_named_group: bool,
    pub(super) depth: usize,
    pub(super) at_pattern_start: bool,
}

impl<'a> Parser<'a> {
    pub(super) fn is_eof(&self) -> bool {
        self.pos >= self.bytes.len()
    }

    pub(super) fn peek_byte(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    pub(super) fn peek_char(&self) -> Option<char> {
        self.src[self.pos..].chars().next()
    }

    pub(super) fn next_char(&mut self) -> Option<char> {
        let ch = self.peek_char()?;
        self.pos += ch.len_utf8();
        Some(ch)
    }

    pub(super) fn skip_extended(&mut self) {
        if !self.flags.extend {
            return;
        }
        loop {
            while let Some(b) = self.peek_byte() {
                if matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c) {
                    self.pos += 1;
                } else {
                    break;
                }
            }
            if self.peek_byte() == Some(b'#') {
                while let Some(b) = self.peek_byte() {
                    self.pos += 1;
                    if b == b'\n' {
                        break;
                    }
                }
            } else {
                break;
            }
        }
    }

    pub(super) fn parse_alt(&mut self, in_group: bool) -> Result<RawExpr, CompileError> {
        let mut branches = Vec::new();
        loop {
            branches.push(self.parse_seq(in_group)?);
            self.skip_extended();
            if self.peek_byte() == Some(b'|') {
                self.pos += 1;
                continue;
            }
            break;
        }
        if branches.len() == 1 {
            Ok(branches.pop().unwrap())
        } else {
            Ok(RawExpr::Alt(branches))
        }
    }

    pub(super) fn parse_seq(&mut self, in_group: bool) -> Result<RawExpr, CompileError> {
        let mut items: Vec<RawExpr> = Vec::new();
        loop {
            self.skip_extended();
            let Some(b) = self.peek_byte() else {
                break;
            };
            if b == b'|' {
                self.at_pattern_start = false;
                break;
            }
            if b == b')' {
                if in_group {
                    break;
                }
                return Err(CompileError::new(CompileErrorKind::Syntax, self.pos, "unmatched ')'"));
            }

            let atom_start = self.pos;
            // Handle comments `(?#...)` and isolated inline flags `(?i)` which implicitly scope
            // the entire remainder of the enclosing group/pattern (including any `|`).
            // e.g. `a(?i)b|c` === `a(?i:b|c)`.
            if b == b'(' && self.bytes.get(self.pos + 1) == Some(&b'?') {
                let saved_flags = self.flags;
                if let Some(handled) = self.try_parse_comment_or_isolated_flag()? {
                    match handled {
                        SpecialGroup::Comment => continue,
                        SpecialGroup::IsolatedFlags { has_whole } => {
                            if has_whole && !self.at_pattern_start {
                                return Err(CompileError::new(
                                    CompileErrorKind::InvalidGroupOption,
                                    atom_start,
                                    "whole option only allowed at start of pattern",
                                ));
                            }
                            // Quantifying an isolated option like `(?i)+` is forbidden.
                            self.skip_extended();
                            if matches!(self.peek_byte(), Some(b'*' | b'+' | b'?')) || self.peek_is_interval_quantifier() {
                                return Err(CompileError::new(
                                    CompileErrorKind::InvalidQuantifier,
                                    self.pos,
                                    "target of repeat operator is invalid",
                                ));
                            }
                            if self.syntax.uses_perl_ms_semantics() {
                                // In Perl/Java/Python, isolated flags affect the remainder of the
                                // enclosing group/alternation without implicitly grouping the tail.
                                continue;
                            }
                            let rest = self.parse_alt(in_group)?;
                            self.flags = saved_flags;
                            if !matches!(rest, RawExpr::Empty) {
                                items.push(rest);
                            }
                            break;
                        }
                    }
                }
            }

            let atom = self.parse_atom()?;
            self.at_pattern_start = false;
            let quantified = self.parse_quantifiers(atom, atom_start)?;
            items.push(quantified);
        }

        match items.len() {
            0 => Ok(RawExpr::Empty),
            1 => Ok(items.pop().unwrap()),
            _ => Ok(RawExpr::Seq(items)),
        }
    }

    fn parse_atom(&mut self) -> Result<RawExpr, CompileError> {
        let start = self.pos;
        let ch = self
            .peek_char()
            .ok_or_else(|| CompileError::new(CompileErrorKind::Syntax, start, "unexpected end of pattern"))?;

        match ch {
            '*' | '+' | '?' => Err(CompileError::new(
                CompileErrorKind::InvalidQuantifier,
                start,
                "target of repeat operator is not specified",
            )),
            '{' => {
                if self.peek_is_interval_quantifier() {
                    return Err(CompileError::new(
                        CompileErrorKind::InvalidQuantifier,
                        start,
                        "target of repeat operator is not specified",
                    ));
                }
                self.pos += 1;
                Ok(self.literal_char('{'))
            }
            '.' => {
                self.pos += 1;
                Ok(RawExpr::AnyChar { dot_all: self.flags.dot_all })
            }
            '^' => {
                self.pos += 1;
                let anchor = if self.flags.single_line { Anchor::BeginBuf } else { Anchor::BeginLine };
                Ok(RawExpr::Anchor(anchor))
            }
            '$' => {
                self.pos += 1;
                let anchor = if self.flags.single_line { Anchor::SemiEndBuf } else { Anchor::EndLine };
                Ok(RawExpr::Anchor(anchor))
            }
            '[' => self.parse_char_class(),
            '(' => self.parse_group(),
            '\\' => self.parse_escape(),
            _ => {
                self.pos += ch.len_utf8();
                Ok(self.literal_char(ch))
            }
        }
    }

    pub(super) fn literal_char(&self, ch: char) -> RawExpr {
        let mut s = String::with_capacity(ch.len_utf8());
        s.push(ch);
        RawExpr::Literal {
            text: s,
            ignore_case: self.flags.ignore_case,
            ascii_icase: self.flags.ignore_case_ascii,
        }
    }

    pub(super) fn literal_str(&self, s: String) -> RawExpr {
        RawExpr::Literal {
            text: s,
            ignore_case: self.flags.ignore_case,
            ascii_icase: self.flags.ignore_case_ascii,
        }
    }

    fn parse_quantifiers(&mut self, mut expr: RawExpr, _atom_start: usize) -> Result<RawExpr, CompileError> {
        loop {
            self.skip_extended();
            let q_pos = self.pos;
            let Some(b) = self.peek_byte() else {
                break;
            };
            let (min, max, mut mode, is_interval, has_comma, was_reversed_interval) = match b {
                b'*' => {
                    self.pos += 1;
                    (0u32, None, QuantifierMode::Greedy, false, false, false)
                }
                b'+' => {
                    self.pos += 1;
                    (1u32, None, QuantifierMode::Greedy, false, false, false)
                }
                b'?' => {
                    self.pos += 1;
                    (0u32, Some(1), QuantifierMode::Greedy, false, false, false)
                }
                b'{' => {
                    let Some(spec) = self.try_scan_interval()? else {
                        break;
                    };
                    self.pos = spec.end_pos;
                    if let Some(hi_val) = spec.hi {
                        if spec.lo > hi_val {
                            if self.syntax.uses_perl_ms_semantics() {
                                return Err(CompileError::new(
                                    CompileErrorKind::InvalidQuantifier,
                                    q_pos,
                                    "upper is smaller than lower in repeat range",
                                ));
                            }
                            // In Oniguruma syntax, `{n,m}` with `n > m` means possessive `{m,n}+`.
                            (hi_val, Some(spec.lo), QuantifierMode::Possessive, true, spec.has_comma, true)
                        } else {
                            (spec.lo, Some(hi_val), QuantifierMode::Greedy, true, spec.has_comma, false)
                        }
                    } else {
                        (spec.lo, None, QuantifierMode::Greedy, true, spec.has_comma, false)
                    }
                }
                _ => break,
            };

            if !expr.is_quantifiable() {
                return Err(CompileError::new(
                    CompileErrorKind::InvalidQuantifier,
                    q_pos,
                    "target of repeat operator is invalid",
                ));
            }

            let next_b = self.peek_byte();
            if !was_reversed_interval {
                if next_b == Some(b'?') {
                    // In Oniguruma default syntax, `{n}?` (no comma) is `(?:X{n})?`, while `{n,n}?` is lazy.
                    let is_bare_exact_interval = is_interval && !has_comma;
                    if !is_bare_exact_interval || self.syntax.supports_interval_modifiers() {
                        self.pos += 1;
                        mode = QuantifierMode::Lazy;
                    }
                } else if next_b == Some(b'+') {
                    // In Oniguruma default syntax, `{n,m}+` is chained `(?:X{n,m})+`, NOT possessive!
                    if !is_interval || self.syntax.supports_interval_modifiers() {
                        self.pos += 1;
                        mode = QuantifierMode::Possessive;
                    }
                }
            }

            // Oniguruma folds chained exact repeats `X{a}{b}` into `X{a*b}` and rejects overflow > i32::MAX.
            if let RawExpr::Repeat {
                min: inner_min,
                max: Some(inner_max),
                ..
            } = &expr
                && *inner_min == *inner_max
                && max == Some(min)
                && u64::from(*inner_min).saturating_mul(u64::from(min)) > i32::MAX as u64
            {
                return Err(CompileError::new(CompileErrorKind::InvalidQuantifier, q_pos, "too big number for repeat range"));
            }

            expr = RawExpr::Repeat {
                expr: Box::new(expr),
                min,
                max,
                mode,
            };
        }
        Ok(expr)
    }

    fn peek_is_interval_quantifier(&self) -> bool {
        self.scan_interval_at(self.pos).is_some()
    }

    fn try_scan_interval(&self) -> Result<Option<IntervalSpec>, CompileError> {
        let Some(spec) = self.scan_interval_at(self.pos) else {
            return Ok(None);
        };
        if spec.lo > MAX_REPEAT_BOUND || spec.hi.is_some_and(|h| h > MAX_REPEAT_BOUND) {
            return Err(CompileError::new(
                CompileErrorKind::InvalidQuantifier,
                self.pos,
                "too big number for repeat range",
            ));
        }
        Ok(Some(spec))
    }

    /// Scans `{n}`, `{n,}`, `{,m}`, `{n,m}`. Returns `None` if malformed (so `{` is treated as literal).
    fn scan_interval_at(&self, start: usize) -> Option<IntervalSpec> {
        if self.bytes.get(start) != Some(&b'{') {
            return None;
        }
        let mut p = start + 1;
        let mut lo: Option<u32> = None;
        let mut digits = 0usize;
        while let Some(&b) = self.bytes.get(p) {
            if b.is_ascii_digit() {
                let d = u32::from(b - b'0');
                lo = Some(lo.unwrap_or(0).saturating_mul(10).saturating_add(d));
                digits += 1;
                p += 1;
            } else {
                break;
            }
        }
        match self.bytes.get(p) {
            Some(b'}') if digits > 0 => {
                let n = lo.unwrap();
                Some(IntervalSpec {
                    lo: n,
                    hi: Some(n),
                    has_comma: false,
                    end_pos: p + 1,
                })
            }
            Some(b',') => {
                p += 1;
                let mut hi: Option<u32> = None;
                let mut hi_digits = 0usize;
                while let Some(&b) = self.bytes.get(p) {
                    if b.is_ascii_digit() {
                        let d = u32::from(b - b'0');
                        hi = Some(hi.unwrap_or(0).saturating_mul(10).saturating_add(d));
                        hi_digits += 1;
                        p += 1;
                    } else {
                        break;
                    }
                }
                if self.bytes.get(p) != Some(&b'}') {
                    return None;
                }
                if digits == 0 && hi_digits == 0 {
                    // `{,}` is literal in Oniguruma.
                    return None;
                }
                let lo_val = lo.unwrap_or(0);
                let hi_val = if hi_digits > 0 { hi } else { None };
                Some(IntervalSpec {
                    lo: lo_val,
                    hi: hi_val,
                    has_comma: true,
                    end_pos: p + 1,
                })
            }
            _ => None,
        }
    }
}
