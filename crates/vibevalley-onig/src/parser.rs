use std::collections::HashMap;

use crate::ast::{Anchor, BackrefTarget, ConditionKind, Expr, LookaroundKind, ParsedPattern, QuantifierMode};
use crate::options::{CompileError, CompileErrorKind, FindOption, Syntax};
use crate::unicode::segment::SegmentMode;
use crate::unicode::{
    self, CharSet, MAX_CODEPOINT, PosixClass, digit_charset, fold_multi_expansion, lookup_property, space_charset, word_charset, xdigit_charset,
};

const MAX_NESTING_DEPTH: usize = 256;
const MAX_REPEAT_BOUND: u32 = 100_000;

#[derive(Debug, Clone, Copy)]
struct Flags {
    ignore_case: bool,
    dot_all: bool,
    single_line: bool,
    extend: bool,
    ignore_case_ascii: bool,
    word_ascii: bool,
    digit_ascii: bool,
    space_ascii: bool,
    posix_ascii: bool,
    segment_mode: SegmentMode,
}

impl Flags {
    fn from_options(options: FindOption, syntax: Syntax) -> Self {
        let default_single_line = syntax.uses_perl_ms_semantics();
        let single_line = if options.contains(FindOption::NEGATE_SINGLELINE) {
            false
        } else if options.contains(FindOption::SINGLELINE) {
            true
        } else {
            default_single_line
        };
        let posix_ascii = options.contains(FindOption::POSIX_IS_ASCII);
        let segment_mode = if options.contains(FindOption::TEXT_SEGMENT_WORD) {
            SegmentMode::Word
        } else {
            SegmentMode::ExtendedGraphemeCluster
        };
        Self {
            ignore_case: options.contains(FindOption::IGNORECASE),
            dot_all: options.contains(FindOption::MULTILINE),
            single_line,
            extend: options.contains(FindOption::EXTEND),
            ignore_case_ascii: options.contains(FindOption::IGNORECASE_IS_ASCII),
            word_ascii: posix_ascii || options.contains(FindOption::WORD_IS_ASCII),
            digit_ascii: posix_ascii || options.contains(FindOption::DIGIT_IS_ASCII),
            space_ascii: posix_ascii || options.contains(FindOption::SPACE_IS_ASCII),
            posix_ascii,
            segment_mode,
        }
    }
}

#[derive(Debug, Clone)]
enum RawRef {
    Number { num: usize, offset: usize },
    Relative { delta: i32, groups_before: usize, offset: usize },
    Name { name: String, offset: usize },
}

#[derive(Debug, Clone)]
enum RawCondition {
    Ref { target: RawRef, level: Option<i32> },
    Expr(Box<RawExpr>),
}

#[derive(Debug, Clone)]
enum RawExpr {
    Empty,
    Fail,
    Literal {
        text: String,
        ignore_case: bool,
        ascii_icase: bool,
    },
    AnyChar {
        dot_all: bool,
    },
    GeneralNewline,
    TextSegment(SegmentMode),
    CharClass {
        set: CharSet,
        /// Multi-codepoint fold expansions (e.g. `(?i:[ß])` also matches `"ss"`).
        multi_folds: Vec<String>,
        ascii_icase: bool,
    },
    Anchor(Anchor),
    Keep,
    Seq(Vec<RawExpr>),
    Alt(Vec<RawExpr>),
    Repeat {
        expr: Box<RawExpr>,
        min: u32,
        max: Option<u32>,
        mode: QuantifierMode,
    },
    Group {
        raw_id: usize,
        expr: Box<RawExpr>,
    },
    NonCapturing(Box<RawExpr>),
    Atomic(Box<RawExpr>),
    Lookaround {
        kind: LookaroundKind,
        expr: Box<RawExpr>,
    },
    Backref {
        target: RawRef,
        level: Option<i32>,
        ignore_case: bool,
        ascii_icase: bool,
    },
    Call {
        target: RawRef,
    },
    Condition {
        cond: RawCondition,
        then_branch: Box<RawExpr>,
        else_branch: Option<Box<RawExpr>>,
    },
    AbsentRepeater(Box<RawExpr>),
    AbsentExpression {
        absent: Box<RawExpr>,
        expr: Box<RawExpr>,
    },
    AbsentStopper(Box<RawExpr>),
    RangeClear,
}

impl RawExpr {
    fn is_quantifiable(&self) -> bool {
        !matches!(self, Self::Anchor(_) | Self::Lookaround { .. } | Self::Keep)
    }
}

struct GroupDecl {
    name: Option<String>,
}

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

struct Parser<'a> {
    src: &'a str,
    bytes: &'a [u8],
    pos: usize,
    syntax: Syntax,
    flags: Flags,
    whole_options: FindOption,
    groups: Vec<GroupDecl>,
    has_named_group: bool,
    depth: usize,
    at_pattern_start: bool,
}

impl<'a> Parser<'a> {
    fn is_eof(&self) -> bool {
        self.pos >= self.bytes.len()
    }

    fn peek_byte(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn peek_char(&self) -> Option<char> {
        self.src[self.pos..].chars().next()
    }

    fn next_char(&mut self) -> Option<char> {
        let ch = self.peek_char()?;
        self.pos += ch.len_utf8();
        Some(ch)
    }

    fn skip_extended(&mut self) {
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

    fn parse_alt(&mut self, in_group: bool) -> Result<RawExpr, CompileError> {
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

    fn parse_seq(&mut self, in_group: bool) -> Result<RawExpr, CompileError> {
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

    fn literal_char(&self, ch: char) -> RawExpr {
        let mut s = String::with_capacity(ch.len_utf8());
        s.push(ch);
        RawExpr::Literal {
            text: s,
            ignore_case: self.flags.ignore_case,
            ascii_icase: self.flags.ignore_case_ascii,
        }
    }

    fn literal_str(&self, s: String) -> RawExpr {
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

    fn try_parse_comment_or_isolated_flag(&mut self) -> Result<Option<SpecialGroup>, CompileError> {
        let start = self.pos;
        if self.bytes.get(start) != Some(&b'(') || self.bytes.get(start + 1) != Some(&b'?') {
            return Ok(None);
        }
        let next = self.bytes.get(start + 2).copied();
        if next == Some(b'#') {
            // Comment `(?#...)`, escapes like `\)` or `\\` are respected inside.
            let mut p = start + 3;
            while p < self.bytes.len() {
                match self.bytes[p] {
                    b'\\' => {
                        p += 2;
                    }
                    b')' => {
                        self.pos = p + 1;
                        return Ok(Some(SpecialGroup::Comment));
                    }
                    _ => p += 1,
                }
            }
            return Err(CompileError::new(CompileErrorKind::Syntax, start, "unclosed comment group"));
        }

        // Check if this is an isolated flag group `(?flags)` (ends with `)`, NOT `:`).
        if next == Some(b'P') && self.syntax.supports_python_named_groups() {
            return Ok(None);
        }
        if next == Some(b'-') && self.syntax == Syntax::PerlNg && self.bytes.get(start + 3).is_some_and(u8::is_ascii_digit) {
            return Ok(None);
        }
        if matches!(
            next,
            Some(b'-' | b'i' | b'm' | b's' | b'x' | b'W' | b'D' | b'S' | b'P' | b'y' | b'a' | b'C' | b'I' | b'L')
        ) {
            // Peek ahead to see if it terminates with `)` rather than `:`.
            let saved_pos = self.pos;
            let saved_flags = self.flags;
            let saved_whole = self.whole_options;
            self.pos = start + 2;
            match self.parse_flag_spec()? {
                (FlagTerminator::CloseParen, has_whole) => {
                    return Ok(Some(SpecialGroup::IsolatedFlags { has_whole }));
                }
                (FlagTerminator::Colon, _) => {
                    // Roll back and let `parse_group` handle scoped `(?flags:...)`.
                    self.pos = saved_pos;
                    self.flags = saved_flags;
                    self.whole_options = saved_whole;
                    return Ok(None);
                }
            }
        }

        Ok(None)
    }

    fn parse_flag_spec(&mut self) -> Result<(FlagTerminator, bool), CompileError> {
        let mut neg = false;
        let mut new_flags = self.flags;
        let mut whole = self.whole_options;
        let mut has_whole = false;

        while !self.is_eof() {
            let opt_pos = self.pos;
            let b = self.bytes[self.pos];
            self.pos += 1;
            match b {
                b':' => {
                    self.flags = new_flags;
                    self.whole_options = whole;
                    return Ok((FlagTerminator::Colon, has_whole));
                }
                b')' => {
                    self.flags = new_flags;
                    self.whole_options = whole;
                    return Ok((FlagTerminator::CloseParen, has_whole));
                }
                b'-' => neg = true,
                b'i' => new_flags.ignore_case = !neg,
                b'x' => new_flags.extend = !neg,
                b'm' => {
                    if self.syntax.uses_perl_ms_semantics() {
                        new_flags.single_line = neg;
                    } else {
                        new_flags.dot_all = !neg;
                    }
                }
                b's' => {
                    if self.syntax.uses_perl_ms_semantics() {
                        new_flags.dot_all = !neg;
                    } else {
                        return Err(CompileError::new(CompileErrorKind::InvalidGroupOption, opt_pos, "undefined group option 's'"));
                    }
                }
                b'W' if !self.syntax.uses_perl_ms_semantics() => new_flags.word_ascii = !neg,
                b'D' if !self.syntax.uses_perl_ms_semantics() => new_flags.digit_ascii = !neg,
                b'S' if !self.syntax.uses_perl_ms_semantics() => new_flags.space_ascii = !neg,
                b'P' if !self.syntax.uses_perl_ms_semantics() => {
                    new_flags.posix_ascii = !neg;
                    new_flags.word_ascii = !neg;
                    new_flags.digit_ascii = !neg;
                    new_flags.space_ascii = !neg;
                }
                b'a' if self.syntax == Syntax::Python => {
                    new_flags.posix_ascii = !neg;
                    new_flags.word_ascii = !neg;
                    new_flags.digit_ascii = !neg;
                    new_flags.space_ascii = !neg;
                }
                b'y' if !self.syntax.uses_perl_ms_semantics() && !neg => {
                    if self.bytes.get(self.pos) != Some(&b'{') {
                        return Err(CompileError::new(CompileErrorKind::InvalidGroupOption, opt_pos, "undefined group option 'y'"));
                    }
                    self.pos += 1;
                    let mode = self.bytes.get(self.pos).copied();
                    self.pos += 1;
                    if self.bytes.get(self.pos) != Some(&b'}') {
                        return Err(CompileError::new(
                            CompileErrorKind::InvalidGroupOption,
                            opt_pos,
                            "undefined group option in y{...}",
                        ));
                    }
                    match mode {
                        Some(b'g') => new_flags.segment_mode = SegmentMode::ExtendedGraphemeCluster,
                        Some(b'w') => new_flags.segment_mode = SegmentMode::Word,
                        _ => {
                            return Err(CompileError::new(
                                CompileErrorKind::InvalidGroupOption,
                                opt_pos,
                                "undefined group option in y{...}",
                            ));
                        }
                    }
                    self.pos += 1;
                }
                b'C' if !self.syntax.uses_perl_ms_semantics() && !neg => {
                    whole |= FindOption::DONT_CAPTURE_GROUP;
                    has_whole = true;
                }
                b'I' if !self.syntax.uses_perl_ms_semantics() && !neg => {
                    whole |= FindOption::IGNORECASE_IS_ASCII;
                    new_flags.ignore_case_ascii = true;
                    has_whole = true;
                }
                b'L' if !self.syntax.uses_perl_ms_semantics() && !neg => {
                    whole |= FindOption::FIND_LONGEST;
                    has_whole = true;
                }
                _ => {
                    return Err(CompileError::new(
                        CompileErrorKind::InvalidGroupOption,
                        opt_pos,
                        format!("undefined group option '{}'", b as char),
                    ));
                }
            }
        }
        Err(CompileError::new(CompileErrorKind::Syntax, self.pos, "end pattern in group"))
    }

    fn parse_group(&mut self) -> Result<RawExpr, CompileError> {
        let start = self.pos;
        if self.depth >= MAX_NESTING_DEPTH {
            return Err(CompileError::new(CompileErrorKind::PatternTooLarge, start, "pattern nesting depth exceeded"));
        }
        self.depth += 1;
        let res = self.parse_group_inner(start);
        self.depth -= 1;
        res
    }

    fn parse_group_inner(&mut self, start: usize) -> Result<RawExpr, CompileError> {
        let was_at_start = self.at_pattern_start;
        self.at_pattern_start = false;
        self.pos += 1; // consume '('
        let saved_flags = self.flags;

        // Check named callouts `(*FAIL)`, `(*SKIP)`, etc.
        if self.peek_byte() == Some(b'*') {
            return self.parse_named_callout(start);
        }

        if self.peek_byte() != Some(b'?') {
            // Plain capturing group `(...)`
            let raw_id = self.groups.len();
            self.groups.push(GroupDecl { name: None });
            let expr = self.parse_alt(true)?;
            self.flags = saved_flags;
            self.expect_close_paren(start)?;
            return Ok(RawExpr::Group { raw_id, expr: Box::new(expr) });
        }

        self.pos += 1; // consume '?'
        let Some(b) = self.peek_byte() else {
            return Err(CompileError::new(CompileErrorKind::Syntax, start, "end pattern in group"));
        };

        match b {
            b':' => {
                self.pos += 1;
                // A top-level non-capturing wrapper `(?:...)` covering the entire pattern
                // allows a whole option at its start (e.g. `(?:(?Ii)abc)`).
                let had_whole_before = self.whole_options;
                if was_at_start {
                    self.at_pattern_start = true;
                }
                let expr = self.parse_alt(true)?;
                self.flags = saved_flags;
                self.expect_close_paren(start)?;
                if self.whole_options != had_whole_before {
                    // Whole option was set inside this `(?:...)`: must cover to closing `)` / EOF.
                    self.skip_extended();
                    if !self.is_eof() && self.peek_byte() != Some(b')') {
                        return Err(CompileError::new(
                            CompileErrorKind::InvalidGroupOption,
                            start,
                            "whole option group must cover entire pattern",
                        ));
                    }
                }
                Ok(RawExpr::NonCapturing(Box::new(expr)))
            }
            b'>' => {
                self.pos += 1;
                let expr = self.parse_alt(true)?;
                self.flags = saved_flags;
                self.expect_close_paren(start)?;
                Ok(RawExpr::Atomic(Box::new(expr)))
            }
            b'=' => {
                self.pos += 1;
                let expr = self.parse_alt(true)?;
                self.flags = saved_flags;
                self.expect_close_paren(start)?;
                Ok(RawExpr::Lookaround {
                    kind: LookaroundKind::PosLookahead,
                    expr: Box::new(expr),
                })
            }
            b'!' => {
                self.pos += 1;
                let expr = self.parse_alt(true)?;
                self.flags = saved_flags;
                self.expect_close_paren(start)?;
                Ok(RawExpr::Lookaround {
                    kind: LookaroundKind::NegLookahead,
                    expr: Box::new(expr),
                })
            }
            b'<' => {
                self.pos += 1;
                match self.peek_byte() {
                    Some(b'=') => {
                        self.pos += 1;
                        let expr = self.parse_alt(true)?;
                        self.flags = saved_flags;
                        self.expect_close_paren(start)?;
                        Ok(RawExpr::Lookaround {
                            kind: LookaroundKind::PosLookbehind,
                            expr: Box::new(expr),
                        })
                    }
                    Some(b'!') => {
                        self.pos += 1;
                        let expr = self.parse_alt(true)?;
                        self.flags = saved_flags;
                        self.expect_close_paren(start)?;
                        Ok(RawExpr::Lookaround {
                            kind: LookaroundKind::NegLookbehind,
                            expr: Box::new(expr),
                        })
                    }
                    _ => self.parse_named_group(start, b'>', saved_flags),
                }
            }
            b'\'' => {
                self.pos += 1;
                self.parse_named_group(start, b'\'', saved_flags)
            }
            b'P' if self.syntax.supports_python_named_groups() => {
                self.pos += 1;
                match self.peek_byte() {
                    Some(b'<') => {
                        self.pos += 1;
                        self.parse_named_group(start, b'>', saved_flags)
                    }
                    Some(b'=') => {
                        self.pos += 1;
                        let name = self.read_group_name(b')')?;
                        Ok(RawExpr::Backref {
                            target: RawRef::Name { name, offset: start },
                            level: None,
                            ignore_case: self.flags.ignore_case,
                            ascii_icase: self.flags.ignore_case_ascii,
                        })
                    }
                    Some(b'>') => {
                        self.pos += 1;
                        let name = self.read_group_name(b')')?;
                        Ok(RawExpr::Call {
                            target: RawRef::Name { name, offset: start },
                        })
                    }
                    _ => Err(CompileError::new(CompileErrorKind::InvalidGroupOption, start + 2, "undefined group option 'P'")),
                }
            }
            b'+' | b'0'..=b'9' if self.syntax == Syntax::PerlNg => {
                let (target, _) = self.parse_ref_spec(b')', false, start)?;
                Ok(RawExpr::Call { target })
            }
            b'-' if self.syntax == Syntax::PerlNg && self.bytes.get(self.pos + 1).is_some_and(u8::is_ascii_digit) => {
                let (target, _) = self.parse_ref_spec(b')', false, start)?;
                Ok(RawExpr::Call { target })
            }
            b'~' => {
                self.pos += 1;
                self.parse_absent(start, saved_flags)
            }
            b'{' => self.parse_contents_callout(start),
            b'(' => self.parse_conditional(start, saved_flags),
            b'-' | b'i' | b'm' | b's' | b'x' | b'W' | b'D' | b'S' | b'P' | b'y' | b'a' | b'C' | b'I' | b'L' => match self.parse_flag_spec()? {
                (FlagTerminator::Colon, has_whole) => {
                    if has_whole && (!was_at_start || self.depth != 1) {
                        return Err(CompileError::new(
                            CompileErrorKind::InvalidGroupOption,
                            start,
                            "whole option only allowed at start of pattern",
                        ));
                    }
                    let expr = self.parse_alt(true)?;
                    self.flags = saved_flags;
                    self.expect_close_paren(start)?;
                    if has_whole {
                        self.skip_extended();
                        if !self.is_eof() {
                            return Err(CompileError::new(
                                CompileErrorKind::InvalidGroupOption,
                                start,
                                "whole option group must cover entire pattern",
                            ));
                        }
                    }
                    Ok(RawExpr::NonCapturing(Box::new(expr)))
                }
                (FlagTerminator::CloseParen, _) => Ok(RawExpr::Empty),
            },
            _ => Err(CompileError::new(
                CompileErrorKind::InvalidGroupOption,
                self.pos,
                format!("undefined group option '{}'", b as char),
            )),
        }
    }

    fn parse_named_group(&mut self, start: usize, delim: u8, saved_flags: Flags) -> Result<RawExpr, CompileError> {
        let name = self.read_group_name(delim)?;
        self.has_named_group = true;
        let raw_id = self.groups.len();
        self.groups.push(GroupDecl { name: Some(name.clone()) });
        let expr = self.parse_alt(true)?;
        self.flags = saved_flags;
        self.expect_close_paren(start)?;
        Ok(RawExpr::Group { raw_id, expr: Box::new(expr) })
    }

    fn read_group_name(&mut self, delim: u8) -> Result<String, CompileError> {
        let name_start = self.pos;
        let mut name = String::new();
        while let Some(ch) = self.peek_char() {
            if ch as u32 == u32::from(delim) {
                self.pos += 1;
                if name.is_empty() {
                    return Err(CompileError::new(CompileErrorKind::Syntax, name_start, "group name is empty"));
                }
                return Ok(name);
            }
            if !unicode::is_word_char(ch, false) {
                return Err(CompileError::new(
                    CompileErrorKind::Syntax,
                    self.pos,
                    format!("invalid char in group name '{}'", ch),
                ));
            }
            // First character of a group name cannot be a digit in Oniguruma.
            if name.is_empty() && ch.is_ascii_digit() {
                return Err(CompileError::new(CompileErrorKind::Syntax, self.pos, "group name cannot start with digit"));
            }
            name.push(ch);
            self.pos += ch.len_utf8();
        }
        Err(CompileError::new(CompileErrorKind::Syntax, name_start, "unterminated group name"))
    }

    fn parse_absent(&mut self, start: usize, saved_flags: Flags) -> Result<RawExpr, CompileError> {
        if self.peek_byte() == Some(b'|') {
            self.pos += 1;
            if self.peek_byte() == Some(b')') {
                self.pos += 1;
                self.flags = saved_flags;
                return Ok(RawExpr::RangeClear);
            }
            let absent = self.parse_seq(true)?;
            if self.peek_byte() == Some(b')') {
                self.pos += 1;
                self.flags = saved_flags;
                return Ok(RawExpr::AbsentStopper(Box::new(absent)));
            }
            if self.peek_byte() == Some(b'|') {
                self.pos += 1;
                let expr = self.parse_alt(true)?;
                self.flags = saved_flags;
                self.expect_close_paren(start)?;
                return Ok(RawExpr::AbsentExpression {
                    absent: Box::new(absent),
                    expr: Box::new(expr),
                });
            }
            return Err(CompileError::new(CompileErrorKind::Syntax, self.pos, "invalid absent expression"));
        }

        let absent = self.parse_alt(true)?;
        self.flags = saved_flags;
        self.expect_close_paren(start)?;
        Ok(RawExpr::AbsentRepeater(Box::new(absent)))
    }

    fn parse_conditional(&mut self, start: usize, saved_flags: Flags) -> Result<RawExpr, CompileError> {
        // `self.pos` is at the inner `(` of `(?(cond)...)`.
        let cond_start = self.pos;
        self.pos += 1; // consume inner '('

        let cond = if self.peek_byte() == Some(b'*') {
            let callout = self.parse_named_callout(cond_start)?;
            RawCondition::Expr(Box::new(callout))
        } else if self.peek_byte() == Some(b'?') && self.bytes.get(self.pos + 1) == Some(&b'{') {
            self.pos += 1;
            let callout = self.parse_contents_callout(cond_start)?;
            RawCondition::Expr(Box::new(callout))
        } else if let Some(ref_cond) = self.try_parse_condition_ref(cond_start)? {
            ref_cond
        } else {
            let cond_expr = self.parse_alt(true)?;
            self.expect_close_paren(cond_start)?;
            RawCondition::Expr(Box::new(cond_expr))
        };

        // Backreference validity checker `(?(1))` / `(?(<name>))` succeeds iff referenced group matched.
        if self.peek_byte() == Some(b')') {
            self.pos += 1;
            self.flags = saved_flags;
            if matches!(cond, RawCondition::Ref { .. }) {
                return Ok(RawExpr::Condition {
                    cond,
                    then_branch: Box::new(RawExpr::Empty),
                    else_branch: Some(Box::new(RawExpr::Fail)),
                });
            }
            return Err(CompileError::new(CompileErrorKind::Syntax, start, "conditional expression missing branches"));
        }

        let then_branch = self.parse_seq(true)?;
        let else_branch = if self.peek_byte() == Some(b'|') {
            self.pos += 1;
            let e = self.parse_alt(true)?;
            Some(Box::new(e))
        } else {
            None
        };
        self.flags = saved_flags;
        self.expect_close_paren(start)?;

        Ok(RawExpr::Condition {
            cond,
            then_branch: Box::new(then_branch),
            else_branch,
        })
    }

    fn try_parse_condition_ref(&mut self, cond_start: usize) -> Result<Option<RawCondition>, CompileError> {
        let saved = self.pos;
        match self.peek_byte() {
            Some(b'<') | Some(b'\'') => {
                let delim = if self.bytes[self.pos] == b'<' { b'>' } else { b'\'' };
                self.pos += 1;
                let (target, level) = self.parse_ref_spec(delim, true, cond_start)?;
                if self.peek_byte() == Some(b')') {
                    self.pos += 1;
                    return Ok(Some(RawCondition::Ref { target, level }));
                }
                self.pos = saved;
                Ok(None)
            }
            Some(b'+' | b'-' | b'1'..=b'9') => {
                let Some((target, level)) = self.try_parse_bare_cond_num(cond_start) else {
                    self.pos = saved;
                    return Ok(None);
                };
                if self.peek_byte() == Some(b')') {
                    self.pos += 1;
                    return Ok(Some(RawCondition::Ref { target, level }));
                }
                self.pos = saved;
                Ok(None)
            }
            _ => Ok(None),
        }
    }

    fn try_parse_bare_cond_num(&mut self, offset: usize) -> Option<(RawRef, Option<i32>)> {
        let sign = match self.peek_byte()? {
            b'+' => {
                self.pos += 1;
                Some(1i32)
            }
            b'-' => {
                self.pos += 1;
                Some(-1i32)
            }
            _ => None,
        };
        let num = self.scan_uint()?;
        if num == 0 {
            return None;
        }
        let target = if let Some(s) = sign {
            RawRef::Relative {
                delta: s * (num as i32),
                groups_before: self.groups.len(),
                offset,
            }
        } else {
            RawRef::Number { num, offset }
        };
        let level = self.try_scan_level();
        Some((target, level))
    }

    fn parse_contents_callout(&mut self, start: usize) -> Result<RawExpr, CompileError> {
        let mut braces = 0usize;
        while self.peek_byte() == Some(b'{') {
            braces += 1;
            self.pos += 1;
        }
        let mut closing = 0usize;
        while let Some(b) = self.peek_byte() {
            self.pos += 1;
            if b == b'}' {
                closing += 1;
                if closing == braces {
                    break;
                }
            } else {
                closing = 0;
            }
        }
        if closing != braces {
            return Err(CompileError::new(CompileErrorKind::Syntax, start, "unterminated callout of contents"));
        }
        if self.peek_byte() == Some(b'[') {
            while let Some(b) = self.peek_byte() {
                self.pos += 1;
                if b == b']' {
                    break;
                }
            }
        }
        if matches!(self.peek_byte(), Some(b'X' | b'<' | b'>')) {
            self.pos += 1;
        }
        self.expect_close_paren(start)?;
        // With no user callout callback installed, Oniguruma treats contents callouts as a no-op match.
        Ok(RawExpr::Empty)
    }

    fn parse_named_callout(&mut self, start: usize) -> Result<RawExpr, CompileError> {
        self.pos += 1; // consume '*'
        let name_start = self.pos;
        while let Some(b) = self.peek_byte() {
            if b.is_ascii_alphanumeric() || b == b'_' {
                self.pos += 1;
            } else {
                break;
            }
        }
        let name = &self.src[name_start..self.pos];
        // Skip optional `[tag]` or `{args}`
        if self.peek_byte() == Some(b'[') {
            while let Some(b) = self.peek_byte() {
                self.pos += 1;
                if b == b']' {
                    break;
                }
            }
        }
        if self.peek_byte() == Some(b'{') {
            while let Some(b) = self.peek_byte() {
                self.pos += 1;
                if b == b'}' {
                    break;
                }
            }
        }
        self.expect_close_paren(start)?;
        match name {
            "FAIL" => Ok(RawExpr::Fail),
            _ => Err(CompileError::new(
                CompileErrorKind::UnsupportedFeature,
                start,
                format!("unsupported named callout (*{name})"),
            )),
        }
    }

    fn expect_close_paren(&mut self, open_pos: usize) -> Result<(), CompileError> {
        if self.peek_byte() == Some(b')') {
            self.pos += 1;
            Ok(())
        } else {
            Err(CompileError::new(CompileErrorKind::Syntax, open_pos, "unmatched '('"))
        }
    }

    fn parse_escape(&mut self) -> Result<RawExpr, CompileError> {
        let esc_pos = self.pos;
        self.pos += 1; // consume '\\'
        let Some(ch) = self.peek_char() else {
            return Err(CompileError::new(CompileErrorKind::InvalidEscape, esc_pos, "end pattern at escape"));
        };

        match ch {
            'A' => {
                self.pos += 1;
                Ok(RawExpr::Anchor(Anchor::BeginBuf))
            }
            'z' => {
                if self.syntax == Syntax::Python {
                    return Err(CompileError::new(CompileErrorKind::InvalidEscape, esc_pos, "\\z is undefined in Python syntax"));
                }
                self.pos += 1;
                Ok(RawExpr::Anchor(Anchor::EndBuf))
            }
            'Z' => {
                self.pos += 1;
                if self.syntax == Syntax::Python {
                    Ok(RawExpr::Anchor(Anchor::EndBuf))
                } else {
                    Ok(RawExpr::Anchor(Anchor::SemiEndBuf))
                }
            }
            'G' => {
                self.pos += 1;
                Ok(RawExpr::Anchor(Anchor::BeginPosition))
            }
            'K' => {
                self.pos += 1;
                Ok(RawExpr::Keep)
            }
            'b' => {
                self.pos += 1;
                Ok(RawExpr::Anchor(Anchor::WordBoundary {
                    ascii_only: self.flags.word_ascii,
                }))
            }
            'B' => {
                self.pos += 1;
                Ok(RawExpr::Anchor(Anchor::NotWordBoundary {
                    ascii_only: self.flags.word_ascii,
                }))
            }
            'y' => {
                self.pos += 1;
                Ok(RawExpr::Anchor(Anchor::TextSegmentBoundary {
                    mode: self.flags.segment_mode,
                    negated: false,
                }))
            }
            'Y' => {
                self.pos += 1;
                Ok(RawExpr::Anchor(Anchor::TextSegmentBoundary {
                    mode: self.flags.segment_mode,
                    negated: true,
                }))
            }
            'w' => {
                self.pos += 1;
                Ok(RawExpr::CharClass {
                    set: word_charset(self.flags.word_ascii),
                    multi_folds: Vec::new(),
                    ascii_icase: self.flags.ignore_case_ascii,
                })
            }
            'W' => {
                self.pos += 1;
                Ok(RawExpr::CharClass {
                    set: word_charset(self.flags.word_ascii).complement(),
                    multi_folds: Vec::new(),
                    ascii_icase: self.flags.ignore_case_ascii,
                })
            }
            'd' => {
                self.pos += 1;
                Ok(RawExpr::CharClass {
                    set: digit_charset(self.flags.digit_ascii),
                    multi_folds: Vec::new(),
                    ascii_icase: self.flags.ignore_case_ascii,
                })
            }
            'D' => {
                self.pos += 1;
                Ok(RawExpr::CharClass {
                    set: digit_charset(self.flags.digit_ascii).complement(),
                    multi_folds: Vec::new(),
                    ascii_icase: self.flags.ignore_case_ascii,
                })
            }
            's' => {
                self.pos += 1;
                Ok(RawExpr::CharClass {
                    set: space_charset(self.flags.space_ascii),
                    multi_folds: Vec::new(),
                    ascii_icase: self.flags.ignore_case_ascii,
                })
            }
            'S' => {
                self.pos += 1;
                Ok(RawExpr::CharClass {
                    set: space_charset(self.flags.space_ascii).complement(),
                    multi_folds: Vec::new(),
                    ascii_icase: self.flags.ignore_case_ascii,
                })
            }
            'h' => {
                self.pos += 1;
                Ok(RawExpr::CharClass {
                    set: xdigit_charset(),
                    multi_folds: Vec::new(),
                    ascii_icase: self.flags.ignore_case_ascii,
                })
            }
            'H' => {
                self.pos += 1;
                Ok(RawExpr::CharClass {
                    set: xdigit_charset().complement(),
                    multi_folds: Vec::new(),
                    ascii_icase: self.flags.ignore_case_ascii,
                })
            }
            'R' => {
                self.pos += 1;
                Ok(RawExpr::GeneralNewline)
            }
            'N' => {
                self.pos += 1;
                Ok(RawExpr::AnyChar { dot_all: false })
            }
            'O' => {
                self.pos += 1;
                Ok(RawExpr::AnyChar { dot_all: true })
            }
            'X' => {
                self.pos += 1;
                Ok(RawExpr::TextSegment(self.flags.segment_mode))
            }
            'p' | 'P' => {
                let negated = ch == 'P';
                self.pos += 1;
                let set = self.parse_property(negated, esc_pos)?;
                Ok(RawExpr::CharClass {
                    set,
                    multi_folds: Vec::new(),
                    ascii_icase: self.flags.ignore_case_ascii,
                })
            }
            'k' => {
                self.pos += 1;
                match self.peek_byte() {
                    Some(b'<') | Some(b'\'') => {
                        let delim = if self.bytes[self.pos] == b'<' { b'>' } else { b'\'' };
                        self.pos += 1;
                        let (target, level) = self.parse_ref_spec(delim, true, esc_pos)?;
                        Ok(RawExpr::Backref {
                            target,
                            level,
                            ignore_case: self.flags.ignore_case,
                            ascii_icase: self.flags.ignore_case_ascii,
                        })
                    }
                    _ => Ok(self.literal_char('k')),
                }
            }
            'g' => {
                self.pos += 1;
                match self.peek_byte() {
                    Some(b'<') | Some(b'\'') => {
                        let delim = if self.bytes[self.pos] == b'<' { b'>' } else { b'\'' };
                        self.pos += 1;
                        let (target, _) = self.parse_ref_spec(delim, false, esc_pos)?;
                        Ok(RawExpr::Call { target })
                    }
                    _ => Ok(self.literal_char('g')),
                }
            }
            'Q' if self.syntax.supports_quote_escape() => {
                self.pos += 1;
                let mut quoted = String::new();
                while !self.is_eof() {
                    if self.bytes[self.pos] == b'\\' && self.bytes.get(self.pos + 1) == Some(&b'E') {
                        self.pos += 2;
                        break;
                    }
                    if let Some(c) = self.next_char() {
                        quoted.push(c);
                    }
                }
                if quoted.is_empty() {
                    Ok(RawExpr::Empty)
                } else {
                    Ok(self.literal_str(quoted))
                }
            }
            '1'..='9' => {
                // Oniguruma rule: scan decimal number; if `r <= groups_so_far || r <= 9`, backref;
                // otherwise octal (for digits 1..7) or literal char ('8'/'9').
                let num_start = self.pos;
                let num = self.scan_uint().unwrap_or(0);
                if num > 0 && (num <= self.groups.len() || num <= 9) {
                    Ok(RawExpr::Backref {
                        target: RawRef::Number { num, offset: esc_pos },
                        level: None,
                        ignore_case: self.flags.ignore_case,
                        ascii_icase: self.flags.ignore_case_ascii,
                    })
                } else {
                    self.pos = num_start;
                    if ch == '8' || ch == '9' {
                        self.pos += 1;
                        Ok(self.literal_char(ch))
                    } else {
                        self.parse_raw_byte_sequence_from(esc_pos, false)
                    }
                }
            }
            '0' => self.parse_raw_byte_sequence_from(esc_pos, false),
            'x' => {
                if self.bytes.get(self.pos + 1) == Some(&b'{') {
                    self.pos += 2;
                    let chars = self.parse_braced_codepoints(16, 8, esc_pos, false)?;
                    Ok(self.literal_str(chars))
                } else {
                    self.parse_raw_byte_sequence_from(esc_pos, false)
                }
            }
            'o' if self.bytes.get(self.pos + 1) == Some(&b'{') => {
                self.pos += 2;
                let chars = self.parse_braced_codepoints(8, 11, esc_pos, false)?;
                Ok(self.literal_str(chars))
            }
            _ => {
                let c = self.parse_char_escape_after_backslash(esc_pos, false)?;
                Ok(self.literal_char(c))
            }
        }
    }

    /// Parses one or more `\xHH` / `\nnn` raw byte escapes and decodes UTF-8 multi-byte sequences.
    fn parse_raw_byte_sequence_from(&mut self, esc_pos: usize, in_class: bool) -> Result<RawExpr, CompileError> {
        let first = self.parse_single_raw_byte(esc_pos)?;
        if first < 0x80 {
            return Ok(self.literal_char(first as char));
        }

        let expected_len = utf8_leading_len(first)
            .ok_or_else(|| CompileError::new(CompileErrorKind::InvalidEscape, esc_pos, format!("invalid UTF-8 leading byte 0x{first:02x}")))?;

        let mut buf = [0u8; 4];
        buf[0] = first;
        for slot in buf.iter_mut().take(expected_len).skip(1) {
            if self.peek_byte() != Some(b'\\') {
                return Err(CompileError::new(CompileErrorKind::InvalidEscape, self.pos, "too short multibyte sequence"));
            }
            let next_esc = self.pos;
            self.pos += 1;
            let b = match self.peek_byte() {
                Some(b'x') if self.bytes.get(self.pos + 1) != Some(&b'{') => self.parse_single_raw_byte(next_esc)?,
                Some(b'0'..=b'7') => self.parse_single_raw_byte(next_esc)?,
                _ => {
                    return Err(CompileError::new(CompileErrorKind::InvalidEscape, next_esc, "too short multibyte sequence"));
                }
            };
            *slot = b;
        }

        let s = std::str::from_utf8(&buf[..expected_len])
            .map_err(|_| CompileError::new(CompileErrorKind::InvalidEscape, esc_pos, "invalid UTF-8 code point in raw byte escape"))?;
        let ch = s.chars().next().unwrap();
        let _ = in_class;
        Ok(self.literal_char(ch))
    }

    fn parse_single_raw_byte(&mut self, esc_pos: usize) -> Result<u8, CompileError> {
        match self.peek_byte() {
            Some(b'x') => {
                self.pos += 1;
                let mut val = 0u32;
                let mut digits = 0;
                while digits < 2 {
                    let Some(b) = self.peek_byte() else { break };
                    let Some(d) = (b as char).to_digit(16) else {
                        break;
                    };
                    val = (val << 4) | d;
                    self.pos += 1;
                    digits += 1;
                }
                Ok(val as u8)
            }
            Some(b'0') => {
                self.pos += 1;
                let mut val = 0u32;
                let mut digits = 0;
                while digits < 2 {
                    let Some(b) = self.peek_byte() else { break };
                    if !(b'0'..=b'7').contains(&b) {
                        break;
                    }
                    val = (val << 3) | u32::from(b - b'0');
                    self.pos += 1;
                    digits += 1;
                }
                Ok(val as u8)
            }
            Some(b'1'..=b'7') => {
                let mut val = 0u32;
                let mut digits = 0;
                while digits < 3 {
                    let Some(b) = self.peek_byte() else { break };
                    if !(b'0'..=b'7').contains(&b) {
                        break;
                    }
                    val = (val << 3) | u32::from(b - b'0');
                    self.pos += 1;
                    digits += 1;
                }
                if val >= 256 {
                    return Err(CompileError::new(CompileErrorKind::InvalidEscape, esc_pos, "too big octal byte value"));
                }
                Ok(val as u8)
            }
            _ => Err(CompileError::new(CompileErrorKind::InvalidEscape, esc_pos, "invalid raw byte escape")),
        }
    }

    fn parse_braced_codepoints(&mut self, radix: u32, max_digits: usize, esc_pos: usize, _in_class: bool) -> Result<String, CompileError> {
        let mut out = String::new();
        let mut count = 0usize;
        loop {
            let val = self.scan_braced_number(radix, max_digits, esc_pos)?;
            if val > u64::from(MAX_CODEPOINT) {
                return Err(CompileError::new(CompileErrorKind::InvalidEscape, self.pos, "invalid code point value"));
            }
            let ch = char::from_u32(val as u32)
                .ok_or_else(|| CompileError::new(CompileErrorKind::InvalidEscape, self.pos, "surrogate code point not allowed in UTF-8"))?;
            out.push(ch);
            count += 1;

            match self.peek_byte() {
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(out);
                }
                Some(b' ' | b'\t' | b'\n' | b'\r') => {
                    while matches!(self.peek_byte(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
                        self.pos += 1;
                    }
                    if self.peek_byte() == Some(b'}') {
                        if count >= 2 {
                            self.pos += 1;
                            return Ok(out);
                        }
                        return Err(CompileError::new(CompileErrorKind::InvalidEscape, self.pos, "invalid code point value"));
                    }
                }
                _ => {
                    return Err(CompileError::new(CompileErrorKind::InvalidEscape, self.pos, "invalid code point value"));
                }
            }
        }
    }

    fn scan_braced_number(&mut self, radix: u32, max_digits: usize, esc_pos: usize) -> Result<u64, CompileError> {
        let mut val: u64 = 0;
        let mut digits = 0usize;
        while let Some(b) = self.peek_byte() {
            if let Some(d) = (b as char).to_digit(radix) {
                digits += 1;
                if digits > max_digits {
                    return Err(CompileError::new(CompileErrorKind::InvalidEscape, self.pos, "too long wide char value"));
                }
                val = val * u64::from(radix) + u64::from(d);
                self.pos += 1;
            } else {
                break;
            }
        }
        if digits == 0 {
            return Err(CompileError::new(CompileErrorKind::InvalidEscape, esc_pos, "invalid code point value"));
        }
        Ok(val)
    }

    /// Parses `\x{...}` / `\o{...}` inside `[...]`, supporting internal ranges like `\x{0030 - 0039 0063-0065}`.
    fn parse_braced_class_spec(&mut self, radix: u32, max_digits: usize, esc_pos: usize) -> Result<ClassAtom, CompileError> {
        let mut singles: Vec<u32> = Vec::new();
        let mut ranges: Vec<(u32, u32)> = Vec::new();
        let mut has_internal_range = false;

        loop {
            let lo = self.scan_braced_number(radix, max_digits, esc_pos)?;
            if lo > 0x7FFF_FFFF {
                return Err(CompileError::new(CompileErrorKind::InvalidEscape, self.pos, "invalid code point value"));
            }
            let lo_u32 = lo as u32;

            let had_ws_before = self.skip_braced_ws();
            if self.peek_byte() == Some(b'-') {
                // Internal range `lo - hi`
                self.pos += 1;
                self.skip_braced_ws();
                let hi = self.scan_braced_number(radix, max_digits, esc_pos)?;
                if hi > 0x7FFF_FFFF || lo > hi {
                    return Err(CompileError::new(CompileErrorKind::InvalidEscape, self.pos, "invalid code point value"));
                }
                let hi_clamped = hi.min(u64::from(MAX_CODEPOINT)) as u32;
                let lo_clamped = lo.min(u64::from(MAX_CODEPOINT)) as u32;
                if lo > u64::from(MAX_CODEPOINT) {
                    return Err(CompileError::new(CompileErrorKind::InvalidEscape, self.pos, "invalid code point value"));
                }
                if !has_internal_range {
                    has_internal_range = true;
                    for s in singles.drain(..) {
                        if s > MAX_CODEPOINT {
                            return Err(CompileError::new(CompileErrorKind::InvalidEscape, esc_pos, "invalid code point value"));
                        }
                        ranges.push((s, s));
                    }
                }
                ranges.push((lo_clamped, hi_clamped));
                let had_ws_after = self.skip_braced_ws();
                match self.peek_byte() {
                    Some(b'}') => {
                        self.pos += 1;
                        return Ok(ClassAtom::Set(CharSet::from_ranges(ranges)));
                    }
                    Some(b) if had_ws_after && (b as char).is_digit(radix) => continue,
                    _ => {
                        return Err(CompileError::new(CompileErrorKind::InvalidEscape, self.pos, "invalid code point value"));
                    }
                }
            }

            if has_internal_range {
                if lo_u32 > MAX_CODEPOINT {
                    return Err(CompileError::new(CompileErrorKind::InvalidEscape, esc_pos, "invalid code point value"));
                }
                ranges.push((lo_u32, lo_u32));
            } else {
                singles.push(lo_u32);
            }

            match self.peek_byte() {
                Some(b'}') => {
                    if had_ws_before && !has_internal_range && singles.len() == 1 {
                        return Err(CompileError::new(CompileErrorKind::InvalidEscape, self.pos, "invalid code point value"));
                    }
                    self.pos += 1;
                    if has_internal_range {
                        return Ok(ClassAtom::Set(CharSet::from_ranges(ranges)));
                    }
                    if singles.len() == 1 {
                        return Ok(ClassAtom::SingleCp(singles[0]));
                    }
                    return Ok(ClassAtom::MultiCp(singles));
                }
                Some(b) if had_ws_before && (b as char).is_digit(radix) => continue,
                _ => {
                    return Err(CompileError::new(CompileErrorKind::InvalidEscape, self.pos, "invalid code point value"));
                }
            }
        }
    }

    fn skip_braced_ws(&mut self) -> bool {
        let start = self.pos;
        while matches!(self.peek_byte(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
        self.pos > start
    }

    fn parse_char_escape_after_backslash(&mut self, esc_pos: usize, in_class: bool) -> Result<char, CompileError> {
        let ch = self
            .next_char()
            .ok_or_else(|| CompileError::new(CompileErrorKind::InvalidEscape, esc_pos, "end pattern at escape"))?;
        match ch {
            't' => Ok('\t'),
            'v' => Ok('\x0b'),
            'n' => Ok('\n'),
            'r' => Ok('\r'),
            'f' => Ok('\x0c'),
            'a' => Ok('\x07'),
            'e' => Ok('\x1b'),
            'b' if in_class => Ok('\x08'),
            'u' => {
                let mut val = 0u32;
                for _ in 0..4 {
                    let b = self
                        .peek_byte()
                        .ok_or_else(|| CompileError::new(CompileErrorKind::InvalidEscape, esc_pos, "incomplete \\u escape"))?;
                    let d = (b as char)
                        .to_digit(16)
                        .ok_or_else(|| CompileError::new(CompileErrorKind::InvalidEscape, self.pos, "invalid hex digit in \\u escape"))?;
                    val = (val << 4) | d;
                    self.pos += 1;
                }
                char::from_u32(val).ok_or_else(|| CompileError::new(CompileErrorKind::InvalidEscape, esc_pos, "invalid Unicode scalar in \\u escape"))
            }
            'U' if self.syntax == Syntax::Python => {
                let mut val = 0u32;
                for _ in 0..8 {
                    let b = self
                        .peek_byte()
                        .ok_or_else(|| CompileError::new(CompileErrorKind::InvalidEscape, esc_pos, "incomplete \\U escape"))?;
                    let d = (b as char)
                        .to_digit(16)
                        .ok_or_else(|| CompileError::new(CompileErrorKind::InvalidEscape, self.pos, "invalid hex digit in \\U escape"))?;
                    val = (val << 4) | d;
                    self.pos += 1;
                }
                char::from_u32(val).ok_or_else(|| CompileError::new(CompileErrorKind::InvalidEscape, esc_pos, "invalid Unicode scalar in \\U escape"))
            }
            'c' => self.parse_control_char(esc_pos),
            'C' => {
                if self.peek_byte() == Some(b'-') {
                    self.pos += 1;
                    self.parse_control_char(esc_pos)
                } else {
                    Ok('C')
                }
            }
            'M' => {
                if self.peek_byte() == Some(b'-') {
                    self.pos += 1;
                    let inner = self.parse_meta_or_ctrl_operand(esc_pos)?;
                    let cp = (inner as u32) | 0x80;
                    char::from_u32(cp).ok_or_else(|| CompileError::new(CompileErrorKind::InvalidEscape, esc_pos, "invalid meta char"))
                } else {
                    Ok('M')
                }
            }
            other => Ok(other),
        }
    }

    fn parse_control_char(&mut self, esc_pos: usize) -> Result<char, CompileError> {
        let inner = self.parse_meta_or_ctrl_operand(esc_pos)?;
        let cp = inner as u32;
        if cp == b'?' as u32 {
            return Ok('\x7f');
        }
        let ctrl = cp & 0x9f;
        char::from_u32(ctrl).ok_or_else(|| CompileError::new(CompileErrorKind::InvalidEscape, esc_pos, "invalid control char"))
    }

    fn parse_meta_or_ctrl_operand(&mut self, esc_pos: usize) -> Result<char, CompileError> {
        if self.peek_byte() == Some(b'\\') {
            self.pos += 1;
            self.parse_char_escape_after_backslash(esc_pos, true)
        } else {
            self.next_char()
                .ok_or_else(|| CompileError::new(CompileErrorKind::InvalidEscape, esc_pos, "end pattern at control/meta escape"))
        }
    }

    fn parse_property(&mut self, outer_neg: bool, esc_pos: usize) -> Result<CharSet, CompileError> {
        let set = if self.peek_byte() == Some(b'{') {
            self.pos += 1;
            let inner_neg = if self.peek_byte() == Some(b'^') {
                self.pos += 1;
                true
            } else {
                false
            };
            let name_start = self.pos;
            while let Some(b) = self.peek_byte() {
                if b == b'}' {
                    break;
                }
                self.pos += 1;
            }
            if self.peek_byte() != Some(b'}') {
                return Err(CompileError::new(CompileErrorKind::UnknownProperty, esc_pos, "unterminated character property"));
            }
            let raw_name = &self.src[name_start..self.pos];
            self.pos += 1; // consume '}'

            let base = self.resolve_property_name(raw_name, esc_pos)?;
            if outer_neg ^ inner_neg { base.complement() } else { base }
        } else {
            let Some(ch) = self.peek_char() else {
                return Err(CompileError::new(CompileErrorKind::UnknownProperty, esc_pos, "invalid character property name"));
            };
            if matches!(ch, 'C' | 'L' | 'M' | 'N' | 'P' | 'S' | 'Z') {
                self.pos += 1;
                let mut buf = [0u8; 1];
                let s = ch.encode_utf8(&mut buf);
                let base = lookup_property(s)
                    .ok_or_else(|| CompileError::new(CompileErrorKind::UnknownProperty, esc_pos, format!("unknown character property '{ch}'")))?;
                if outer_neg { base.complement() } else { base }
            } else {
                return Err(CompileError::new(
                    CompileErrorKind::UnknownProperty,
                    esc_pos,
                    format!("invalid character property name '{ch}'"),
                ));
            }
        };
        Ok(set)
    }

    fn resolve_property_name(&self, raw_name: &str, esc_pos: usize) -> Result<CharSet, CompileError> {
        let norm: String = raw_name
            .bytes()
            .filter(|b| !matches!(b, b' ' | b'-' | b'_'))
            .map(|b| b.to_ascii_lowercase() as char)
            .collect();
        // Respect ASCII-only flags for standard POSIX properties when set.
        if self.flags.posix_ascii {
            if let Some(posix) = PosixClass::from_name(&norm) {
                return Ok(posix.charset(true));
            }
        } else {
            if norm == "word" && self.flags.word_ascii {
                return Ok(word_charset(true));
            }
            if norm == "digit" && self.flags.digit_ascii {
                return Ok(digit_charset(true));
            }
            if norm == "space" && self.flags.space_ascii {
                return Ok(space_charset(true));
            }
        }
        lookup_property(raw_name).ok_or_else(|| {
            CompileError::new(
                CompileErrorKind::UnknownProperty,
                esc_pos,
                format!("invalid character property name '{raw_name}'"),
            )
        })
    }

    fn parse_ref_spec(&mut self, delim: u8, allow_level: bool, esc_pos: usize) -> Result<(RawRef, Option<i32>), CompileError> {
        let start = self.pos;
        let b = self
            .peek_byte()
            .ok_or_else(|| CompileError::new(CompileErrorKind::Syntax, esc_pos, "unterminated group reference"))?;

        let (target, level) = if matches!(b, b'+' | b'-' | b'0'..=b'9') {
            let sign = match b {
                b'+' => {
                    self.pos += 1;
                    Some(1i32)
                }
                b'-' => {
                    self.pos += 1;
                    Some(-1i32)
                }
                _ => None,
            };
            let num = self
                .scan_uint()
                .ok_or_else(|| CompileError::new(CompileErrorKind::Syntax, start, "invalid group number in reference"))?;
            let target = if let Some(s) = sign {
                if num == 0 {
                    return Err(CompileError::new(CompileErrorKind::UndefinedGroup, start, "relative group number cannot be 0"));
                }
                RawRef::Relative {
                    delta: s * (num as i32),
                    groups_before: self.groups.len(),
                    offset: esc_pos,
                }
            } else {
                RawRef::Number { num, offset: esc_pos }
            };
            let level = if allow_level { self.try_scan_level() } else { None };
            (target, level)
        } else {
            let name_start = self.pos;
            let mut name = String::new();
            while let Some(ch) = self.peek_char() {
                if ch as u32 == u32::from(delim) || (allow_level && (ch == '+' || ch == '-')) {
                    break;
                }
                if !unicode::is_word_char(ch, false) {
                    return Err(CompileError::new(
                        CompileErrorKind::Syntax,
                        self.pos,
                        format!("invalid char in group name '{ch}'"),
                    ));
                }
                name.push(ch);
                self.pos += ch.len_utf8();
            }
            if name.is_empty() {
                return Err(CompileError::new(CompileErrorKind::Syntax, name_start, "empty group name in reference"));
            }
            let level = if allow_level { self.try_scan_level() } else { None };
            (RawRef::Name { name, offset: esc_pos }, level)
        };

        if self.peek_byte() != Some(delim) {
            return Err(CompileError::new(CompileErrorKind::Syntax, self.pos, "unterminated group reference"));
        }
        self.pos += 1;
        Ok((target, level))
    }

    fn try_scan_level(&mut self) -> Option<i32> {
        let sign = match self.peek_byte()? {
            b'+' => 1i32,
            b'-' => -1i32,
            _ => return None,
        };
        let saved = self.pos;
        self.pos += 1;
        let Some(mag) = self.scan_uint() else {
            self.pos = saved;
            return None;
        };
        Some(sign * (mag as i32))
    }

    fn scan_uint(&mut self) -> Option<usize> {
        let start = self.pos;
        let mut val: usize = 0;
        while let Some(b) = self.peek_byte() {
            if b.is_ascii_digit() {
                val = val.saturating_mul(10).saturating_add(usize::from(b - b'0'));
                self.pos += 1;
            } else {
                break;
            }
        }
        if self.pos == start { None } else { Some(val) }
    }

    fn parse_char_class(&mut self) -> Result<RawExpr, CompileError> {
        let start = self.pos;
        if self.depth >= MAX_NESTING_DEPTH {
            return Err(CompileError::new(
                CompileErrorKind::PatternTooLarge,
                start,
                "character class nesting depth exceeded",
            ));
        }
        self.depth += 1;
        let res = self.parse_char_class_inner(start);
        self.depth -= 1;
        res
    }

    fn parse_char_class_inner(&mut self, start: usize) -> Result<RawExpr, CompileError> {
        let (set, multi_folds) = self.parse_char_class_set(start)?;
        Ok(RawExpr::CharClass {
            set,
            multi_folds,
            ascii_icase: self.flags.ignore_case_ascii,
        })
    }

    fn parse_char_class_set(&mut self, start: usize) -> Result<(CharSet, Vec<String>), CompileError> {
        self.pos += 1; // consume '['
        let negated = if self.peek_byte() == Some(b'^') {
            self.pos += 1;
            true
        } else {
            false
        };

        let mut intersection_terms: Vec<CharSet> = Vec::new();
        let mut current_ranges: Vec<(u32, u32)> = Vec::new();
        let mut current_sets: Vec<CharSet> = Vec::new();
        let mut first_in_class = true;
        let mut prev_single: Option<u32> = None;

        let flush_term = |ranges: &mut Vec<(u32, u32)>, sets: &mut Vec<CharSet>| -> CharSet {
            let mut acc = CharSet::from_ranges(std::mem::take(ranges));
            for s in sets.drain(..) {
                acc = acc.union(&s);
            }
            acc
        };

        loop {
            let Some(b) = self.peek_byte() else {
                return Err(CompileError::new(CompileErrorKind::InvalidCharacterClass, start, "premature end of char-class"));
            };

            if b == b']' && !first_in_class {
                self.pos += 1;
                break;
            }

            if b == b'&' && self.bytes.get(self.pos + 1) == Some(&b'&') {
                self.pos += 2;
                let term = flush_term(&mut current_ranges, &mut current_sets);
                intersection_terms.push(term);
                prev_single = None;
                first_in_class = false;
                continue;
            }

            first_in_class = false;

            // Range operator `-` when preceded by a single char and not followed by `]` or `&&`.
            if b == b'-' && prev_single.is_some() {
                let next_b = self.bytes.get(self.pos + 1).copied();
                let next_is_end = next_b == Some(b']') || (next_b == Some(b'&') && self.bytes.get(self.pos + 2) == Some(&b'&'));
                if !next_is_end {
                    let lo_cp = prev_single.take().unwrap();
                    let dash_pos = self.pos;
                    self.pos += 1; // consume '-'
                    let hi_item = self.parse_char_class_atom(start)?;
                    match hi_item {
                        ClassAtom::Single(hi_ch) => {
                            let hi_cp = hi_ch as u32;
                            if lo_cp > hi_cp {
                                return Err(CompileError::new(
                                    CompileErrorKind::InvalidCharacterClass,
                                    dash_pos,
                                    "empty range in char class",
                                ));
                            }
                            current_ranges.pop();
                            current_ranges.push((lo_cp, hi_cp));
                            continue;
                        }
                        ClassAtom::SingleCp(hi_cp) => {
                            if lo_cp > hi_cp {
                                return Err(CompileError::new(
                                    CompileErrorKind::InvalidCharacterClass,
                                    dash_pos,
                                    "empty range in char class",
                                ));
                            }
                            current_ranges.pop();
                            current_ranges.push((lo_cp, hi_cp.min(MAX_CODEPOINT)));
                            continue;
                        }
                        ClassAtom::MultiCp(cps) => {
                            let Some(&first_hi) = cps.first() else {
                                return Err(CompileError::new(CompileErrorKind::InvalidCharacterClass, dash_pos, "empty range endpoint"));
                            };
                            if lo_cp > first_hi {
                                return Err(CompileError::new(
                                    CompileErrorKind::InvalidCharacterClass,
                                    dash_pos,
                                    "empty range in char class",
                                ));
                            }
                            current_ranges.pop();
                            current_ranges.push((lo_cp, first_hi.min(MAX_CODEPOINT)));
                            for &rest_cp in cps.iter().skip(1) {
                                if rest_cp > MAX_CODEPOINT {
                                    return Err(CompileError::new(CompileErrorKind::InvalidEscape, dash_pos, "invalid code point value"));
                                }
                                current_ranges.push((rest_cp, rest_cp));
                            }
                            continue;
                        }
                        ClassAtom::Set(_) => {
                            return Err(CompileError::new(
                                CompileErrorKind::InvalidCharacterClass,
                                dash_pos,
                                "char-class value at end of range",
                            ));
                        }
                    }
                }
            }

            let atom_pos = self.pos;
            let atom = self.parse_char_class_atom(start)?;
            match atom {
                ClassAtom::Single(c) => {
                    let cp = c as u32;
                    current_ranges.push((cp, cp));
                    prev_single = Some(cp);
                }
                ClassAtom::SingleCp(cp) => {
                    if cp > MAX_CODEPOINT {
                        return Err(CompileError::new(CompileErrorKind::InvalidEscape, atom_pos, "invalid code point value"));
                    }
                    current_ranges.push((cp, cp));
                    prev_single = Some(cp);
                }
                ClassAtom::MultiCp(cps) => {
                    let mut last_cp = None;
                    for cp in cps {
                        if cp > MAX_CODEPOINT {
                            return Err(CompileError::new(CompileErrorKind::InvalidEscape, atom_pos, "invalid code point value"));
                        }
                        current_ranges.push((cp, cp));
                        last_cp = Some(cp);
                    }
                    prev_single = last_cp;
                }
                ClassAtom::Set(s) => {
                    current_sets.push(s);
                    prev_single = None;
                }
            }
        }

        let last_term = flush_term(&mut current_ranges, &mut current_sets);
        intersection_terms.push(last_term);

        let mut result = intersection_terms[0].clone();
        for term in intersection_terms.iter().skip(1) {
            result = result.intersect(term);
        }

        let mut multi_folds = Vec::new();
        if self.flags.ignore_case {
            if !negated && !self.flags.ignore_case_ascii {
                // Collect multi-codepoint fold expansions (e.g. `(?i:[ß])` also matches `"ss"`).
                collect_multi_folds(&result, &mut multi_folds);
            }
            result = result.case_fold(self.flags.ignore_case_ascii);
        }

        if negated {
            result = result.complement();
        }

        Ok((result, multi_folds))
    }

    fn parse_char_class_atom(&mut self, class_start: usize) -> Result<ClassAtom, CompileError> {
        let atom_pos = self.pos;
        let b = self.bytes[self.pos];
        match b {
            b'[' => {
                if self.bytes.get(self.pos + 1) == Some(&b':') && self.is_posix_bracket_start(self.pos + 2) {
                    let set = self.parse_posix_bracket(atom_pos)?;
                    return Ok(ClassAtom::Set(set));
                }
                // Nested character class `[...]`.
                let (nested_set, _) = self.parse_char_class_set(atom_pos)?;
                Ok(ClassAtom::Set(nested_set))
            }
            b'\\' => self.parse_char_class_escape(atom_pos),
            _ => {
                let ch = self
                    .next_char()
                    .ok_or_else(|| CompileError::new(CompileErrorKind::InvalidCharacterClass, class_start, "premature end of char-class"))?;
                Ok(ClassAtom::Single(ch))
            }
        }
    }

    /// Exact Oniguruma `is_posix_bracket_start` lookahead starting right after `[:`.
    fn is_posix_bracket_start(&self, from: usize) -> bool {
        let mut p = from;
        let mut n = 0usize;
        while p < self.bytes.len() {
            let ch = self.src[p..].chars().next().unwrap();
            p += ch.len_utf8();
            if ch == ':' {
                if self.bytes.get(p) == Some(&b']') {
                    return n > 0;
                }
                return false;
            } else if ch == '^' && n == 0 {
                // Leading `^` for negated POSIX bracket `[:^alpha:]`.
            } else if !unicode::is_alpha_char(ch) {
                break;
            }
            n += 1;
        }
        false
    }

    fn parse_posix_bracket(&mut self, bracket_pos: usize) -> Result<CharSet, CompileError> {
        self.pos += 2; // consume `[:`
        let negated = if self.peek_byte() == Some(b'^') {
            self.pos += 1;
            true
        } else {
            false
        };
        let name_start = self.pos;
        while let Some(b) = self.peek_byte() {
            if b == b':' && self.bytes.get(self.pos + 1) == Some(&b']') {
                break;
            }
            self.pos += 1;
        }
        let name = &self.src[name_start..self.pos];
        if self.bytes.get(self.pos) != Some(&b':') || self.bytes.get(self.pos + 1) != Some(&b']') {
            return Err(CompileError::new(CompileErrorKind::InvalidCharacterClass, bracket_pos, "invalid POSIX bracket"));
        }
        self.pos += 2; // consume `:]`

        let posix = PosixClass::from_name(name).ok_or_else(|| {
            CompileError::new(
                CompileErrorKind::InvalidCharacterClass,
                bracket_pos,
                format!("invalid POSIX bracket type '[:{name}:]'"),
            )
        })?;

        let ascii_only = match posix {
            PosixClass::Word => self.flags.word_ascii || self.flags.posix_ascii,
            PosixClass::Digit => self.flags.digit_ascii || self.flags.posix_ascii,
            PosixClass::Space => self.flags.space_ascii || self.flags.posix_ascii,
            _ => self.flags.posix_ascii,
        };

        let mut set = posix.charset(ascii_only);
        if negated {
            set = set.complement();
        }
        Ok(set)
    }

    fn parse_char_class_escape(&mut self, esc_pos: usize) -> Result<ClassAtom, CompileError> {
        self.pos += 1; // consume '\\'
        let Some(ch) = self.peek_char() else {
            return Err(CompileError::new(
                CompileErrorKind::InvalidEscape,
                esc_pos,
                "end pattern at escape in char-class",
            ));
        };
        match ch {
            'w' => {
                self.pos += 1;
                Ok(ClassAtom::Set(word_charset(self.flags.word_ascii)))
            }
            'W' => {
                self.pos += 1;
                Ok(ClassAtom::Set(word_charset(self.flags.word_ascii).complement()))
            }
            'd' => {
                self.pos += 1;
                Ok(ClassAtom::Set(digit_charset(self.flags.digit_ascii)))
            }
            'D' => {
                self.pos += 1;
                Ok(ClassAtom::Set(digit_charset(self.flags.digit_ascii).complement()))
            }
            's' => {
                self.pos += 1;
                Ok(ClassAtom::Set(space_charset(self.flags.space_ascii)))
            }
            'S' => {
                self.pos += 1;
                Ok(ClassAtom::Set(space_charset(self.flags.space_ascii).complement()))
            }
            'h' => {
                self.pos += 1;
                Ok(ClassAtom::Set(xdigit_charset()))
            }
            'H' => {
                self.pos += 1;
                Ok(ClassAtom::Set(xdigit_charset().complement()))
            }
            'p' | 'P' => {
                let negated = ch == 'P';
                self.pos += 1;
                let set = self.parse_property(negated, esc_pos)?;
                Ok(ClassAtom::Set(set))
            }
            'x' => {
                if self.bytes.get(self.pos + 1) == Some(&b'{') {
                    self.pos += 2;
                    self.parse_braced_class_spec(16, 8, esc_pos)
                } else {
                    match self.parse_raw_byte_sequence_from(esc_pos, true)? {
                        RawExpr::Literal { text, .. } => Ok(ClassAtom::Single(text.chars().next().unwrap())),
                        _ => unreachable!(),
                    }
                }
            }
            'o' if self.bytes.get(self.pos + 1) == Some(&b'{') => {
                self.pos += 2;
                self.parse_braced_class_spec(8, 11, esc_pos)
            }
            '0'..='7' => match self.parse_raw_byte_sequence_from(esc_pos, true)? {
                RawExpr::Literal { text, .. } => Ok(ClassAtom::Single(text.chars().next().unwrap())),
                _ => unreachable!(),
            },
            _ => {
                let c = self.parse_char_escape_after_backslash(esc_pos, true)?;
                Ok(ClassAtom::Single(c))
            }
        }
    }
}

struct IntervalSpec {
    lo: u32,
    hi: Option<u32>,
    has_comma: bool,
    end_pos: usize,
}

enum SpecialGroup {
    Comment,
    IsolatedFlags { has_whole: bool },
}

enum FlagTerminator {
    Colon,
    CloseParen,
}

enum ClassAtom {
    Single(char),
    SingleCp(u32),
    MultiCp(Vec<u32>),
    Set(CharSet),
}

fn utf8_leading_len(b: u8) -> Option<usize> {
    if b < 0x80 {
        Some(1)
    } else if (0xC2..=0xDF).contains(&b) {
        Some(2)
    } else if (0xE0..=0xEF).contains(&b) {
        Some(3)
    } else if (0xF0..=0xF4).contains(&b) {
        Some(4)
    } else {
        None
    }
}

fn collect_multi_folds(set: &CharSet, out: &mut Vec<String>) {
    // Check the ~72 multi-fold codepoints directly rather than scanning every range in `set`.
    for &(lo, hi) in set.ranges() {
        if hi < 0x00DF {
            continue;
        }
        // Only check codepoints in ranges that could overlap multi-fold chars (0x00DF..=0xFB06).
        let start = lo.max(0x00DF);
        let end = hi.min(0xFB06);
        if start > end {
            continue;
        }
        // Avoid scanning huge ranges (e.g. `[\x00-\uFFFF]`): only emit multi-folds for small
        // explicit sets; huge classes already match ASCII `s`/`f`/etc. on their own or via ranges.
        if end - start > 512 {
            continue;
        }
        for cp in start..=end {
            if let Some(seq) = fold_multi_expansion(cp) {
                let s: String = seq.iter().filter_map(|&c| char::from_u32(c)).collect();
                if !out.contains(&s) {
                    out.push(s);
                }
            }
        }
    }
}

/// Phase 2: resolve capture group numbering, backrefs, subroutines, lookbehind checks, and left-recursion checks.
fn resolve_ast(raw: RawExpr, groups: &[GroupDecl], has_named_group: bool, whole_options: FindOption) -> Result<ParsedPattern, CompileError> {
    let dont_capture_unnamed =
        whole_options.contains(FindOption::DONT_CAPTURE_GROUP) || (has_named_group && !whole_options.contains(FindOption::CAPTURE_GROUP));
    let forbid_numbered_ref = has_named_group && !whole_options.contains(FindOption::CAPTURE_GROUP);

    let mut raw_to_final: Vec<Option<usize>> = Vec::with_capacity(groups.len());
    let mut named_map: HashMap<String, Vec<usize>> = HashMap::new();
    let mut named_order: Vec<String> = Vec::new();
    let mut next_group = 1usize;

    for decl in groups {
        match &decl.name {
            Some(name) => {
                let idx = next_group;
                next_group += 1;
                raw_to_final.push(Some(idx));
                if !named_map.contains_key(name) {
                    named_order.push(name.clone());
                }
                named_map.entry(name.clone()).or_default().push(idx);
            }
            None => {
                if dont_capture_unnamed {
                    raw_to_final.push(None);
                } else {
                    let idx = next_group;
                    next_group += 1;
                    raw_to_final.push(Some(idx));
                }
            }
        }
    }

    let num_captures = next_group - 1;
    let ctx = ResolveCtx {
        raw_to_final: &raw_to_final,
        named_map: &named_map,
        num_captures,
        forbid_numbered_ref,
    };

    let expr = resolve_expr(raw, &ctx)?;

    // Validate lookbehind constraints and left-recursive subroutine calls.
    let mut group_bodies: Vec<Option<&Expr>> = vec![None; num_captures + 1];
    group_bodies[0] = Some(&expr);
    collect_group_bodies(&expr, &mut group_bodies);

    validate_expr(&expr, &group_bodies)?;
    check_left_recursion(&group_bodies)?;

    let has_g_anchor = expr.contains_g_anchor();
    let named_groups: Vec<(String, Vec<usize>)> = named_order
        .into_iter()
        .map(|name| {
            let ids = named_map.remove(&name).unwrap_or_default();
            (name, ids)
        })
        .collect();

    Ok(ParsedPattern {
        expr,
        num_captures,
        named_groups,
        has_g_anchor,
        whole_options,
    })
}

struct ResolveCtx<'a> {
    raw_to_final: &'a [Option<usize>],
    named_map: &'a HashMap<String, Vec<usize>>,
    num_captures: usize,
    forbid_numbered_ref: bool,
}

impl<'a> ResolveCtx<'a> {
    fn resolve_backref(&self, r: &RawRef) -> Result<Vec<usize>, CompileError> {
        match r {
            RawRef::Number { num, offset } => {
                if self.forbid_numbered_ref {
                    return Err(CompileError::new(
                        CompileErrorKind::NumberedRefWithNamedGroup,
                        *offset,
                        "numbered backref/call is not allowed (use name)",
                    ));
                }
                if *num == 0 || *num > self.num_captures {
                    return Err(CompileError::new(
                        CompileErrorKind::UndefinedGroup,
                        *offset,
                        format!("invalid backref number {num}"),
                    ));
                }
                Ok(vec![*num])
            }
            RawRef::Relative { delta, groups_before, offset } => {
                if self.forbid_numbered_ref {
                    return Err(CompileError::new(
                        CompileErrorKind::NumberedRefWithNamedGroup,
                        *offset,
                        "numbered backref/call is not allowed (use name)",
                    ));
                }
                let final_before = self.raw_to_final[..*groups_before].iter().filter(|x| x.is_some()).count();
                let target = if *delta < 0 {
                    (final_before as isize) + (*delta as isize) + 1
                } else {
                    (final_before as isize) + (*delta as isize)
                };
                if target < 1 || (target as usize) > self.num_captures {
                    return Err(CompileError::new(
                        CompileErrorKind::UndefinedGroup,
                        *offset,
                        format!("invalid relative backref {delta}"),
                    ));
                }
                Ok(vec![target as usize])
            }
            RawRef::Name { name, offset } => {
                let Some(ids) = self.named_map.get(name) else {
                    return Err(CompileError::new(
                        CompileErrorKind::UndefinedGroup,
                        *offset,
                        format!("undefined name <{name}> reference"),
                    ));
                };
                // Oniguruma checks duplicate named groups from last defined to first.
                let mut rev = ids.clone();
                rev.reverse();
                Ok(rev)
            }
        }
    }

    fn resolve_call(&self, r: &RawRef) -> Result<usize, CompileError> {
        match r {
            RawRef::Number { num, offset } => {
                if *num == 0 {
                    return Ok(0);
                }
                if self.forbid_numbered_ref {
                    return Err(CompileError::new(
                        CompileErrorKind::NumberedRefWithNamedGroup,
                        *offset,
                        "numbered backref/call is not allowed (use name)",
                    ));
                }
                if *num > self.num_captures {
                    return Err(CompileError::new(
                        CompileErrorKind::UndefinedGroup,
                        *offset,
                        format!("undefined group <{num}> reference"),
                    ));
                }
                Ok(*num)
            }
            RawRef::Relative { delta, groups_before, offset } => {
                if self.forbid_numbered_ref {
                    return Err(CompileError::new(
                        CompileErrorKind::NumberedRefWithNamedGroup,
                        *offset,
                        "numbered backref/call is not allowed (use name)",
                    ));
                }
                let final_before = self.raw_to_final[..*groups_before].iter().filter(|x| x.is_some()).count();
                let target = if *delta < 0 {
                    (final_before as isize) + (*delta as isize) + 1
                } else {
                    (final_before as isize) + (*delta as isize)
                };
                if target < 1 || (target as usize) > self.num_captures {
                    return Err(CompileError::new(
                        CompileErrorKind::UndefinedGroup,
                        *offset,
                        format!("undefined relative group <{delta}> reference"),
                    ));
                }
                Ok(target as usize)
            }
            RawRef::Name { name, offset } => {
                let Some(ids) = self.named_map.get(name) else {
                    return Err(CompileError::new(
                        CompileErrorKind::UndefinedGroup,
                        *offset,
                        format!("undefined name <{name}> reference"),
                    ));
                };
                if ids.len() > 1 {
                    return Err(CompileError::new(
                        CompileErrorKind::DuplicateNamedCall,
                        *offset,
                        format!("multiplex definition name <{name}> call"),
                    ));
                }
                Ok(ids[0])
            }
        }
    }
}

fn resolve_expr(raw: RawExpr, ctx: &ResolveCtx<'_>) -> Result<Expr, CompileError> {
    match raw {
        RawExpr::Empty => Ok(Expr::Empty),
        RawExpr::Fail => Ok(Expr::Fail),
        RawExpr::Literal {
            text,
            ignore_case,
            ascii_icase,
        } => Ok(Expr::Literal {
            text,
            ignore_case,
            ascii_icase,
        }),
        RawExpr::AnyChar { dot_all } => Ok(Expr::AnyChar { dot_all }),
        RawExpr::GeneralNewline => Ok(Expr::GeneralNewline),
        RawExpr::TextSegment(mode) => Ok(Expr::TextSegment(mode)),
        RawExpr::CharClass { set, multi_folds, ascii_icase } => {
            if set.is_empty() && multi_folds.is_empty() {
                return Ok(Expr::Fail);
            }
            if multi_folds.is_empty() {
                Ok(Expr::CharClass(set))
            } else {
                let mut alts = Vec::with_capacity(1 + multi_folds.len());
                alts.push(Expr::CharClass(set));
                for s in multi_folds {
                    alts.push(Expr::Literal {
                        text: s,
                        ignore_case: true,
                        ascii_icase,
                    });
                }
                Ok(Expr::Alt(alts))
            }
        }
        RawExpr::Anchor(a) => Ok(Expr::Anchor(a)),
        RawExpr::Keep => Ok(Expr::Keep),
        RawExpr::Seq(items) => {
            let mut out: Vec<Expr> = Vec::with_capacity(items.len());
            for item in items {
                let resolved = resolve_expr(item, ctx)?;
                match resolved {
                    Expr::Empty => {}
                    Expr::Literal {
                        text,
                        ignore_case,
                        ascii_icase,
                    } => {
                        if let Some(Expr::Literal {
                            text: prev_text,
                            ignore_case: prev_ic,
                            ascii_icase: prev_aic,
                        }) = out.last_mut()
                            && *prev_ic == ignore_case
                            && *prev_aic == ascii_icase
                        {
                            prev_text.push_str(&text);
                            continue;
                        }
                        out.push(Expr::Literal {
                            text,
                            ignore_case,
                            ascii_icase,
                        });
                    }
                    Expr::Seq(nested) => {
                        for sub in nested {
                            push_coalesced(&mut out, sub);
                        }
                    }
                    other => out.push(other),
                }
            }
            match out.len() {
                0 => Ok(Expr::Empty),
                1 => Ok(out.pop().unwrap()),
                _ => Ok(Expr::Seq(out)),
            }
        }
        RawExpr::Alt(branches) => {
            let mut out = Vec::with_capacity(branches.len());
            for b in branches {
                out.push(resolve_expr(b, ctx)?);
            }
            Ok(Expr::Alt(out))
        }
        RawExpr::Repeat { expr, min, max, mode } => Ok(Expr::Repeat {
            expr: Box::new(resolve_expr(*expr, ctx)?),
            min,
            max,
            mode,
        }),
        RawExpr::Group { raw_id, expr } => {
            let inner = resolve_expr(*expr, ctx)?;
            if let Some(index) = ctx.raw_to_final[raw_id] {
                Ok(Expr::Capture { index, expr: Box::new(inner) })
            } else {
                Ok(inner)
            }
        }
        RawExpr::NonCapturing(expr) => resolve_expr(*expr, ctx),
        RawExpr::Atomic(expr) => Ok(Expr::Atomic(Box::new(resolve_expr(*expr, ctx)?))),
        RawExpr::Lookaround { kind, expr } => Ok(Expr::Lookaround {
            kind,
            expr: Box::new(resolve_expr(*expr, ctx)?),
        }),
        RawExpr::Backref {
            target,
            level,
            ignore_case,
            ascii_icase,
        } => {
            let groups = ctx.resolve_backref(&target)?;
            let target = match level {
                Some(lv) => BackrefTarget::WithLevel { groups, level: lv },
                None => BackrefTarget::Groups(groups),
            };
            Ok(Expr::Backref {
                target,
                ignore_case,
                ascii_icase,
            })
        }
        RawExpr::Call { target } => {
            let target_group = ctx.resolve_call(&target)?;
            Ok(Expr::Call { target_group })
        }
        RawExpr::Condition {
            cond,
            then_branch,
            else_branch,
        } => {
            let cond = match cond {
                RawCondition::Ref { target, level } => {
                    let groups = ctx.resolve_backref(&target)?;
                    ConditionKind::BackrefValid { groups, level }
                }
                RawCondition::Expr(e) => ConditionKind::Expr(Box::new(resolve_expr(*e, ctx)?)),
            };
            let then_branch = Box::new(resolve_expr(*then_branch, ctx)?);
            let else_branch = match else_branch {
                Some(e) => Some(Box::new(resolve_expr(*e, ctx)?)),
                None => None,
            };
            Ok(Expr::Condition {
                cond,
                then_branch,
                else_branch,
            })
        }
        RawExpr::AbsentRepeater(e) => Ok(Expr::AbsentRepeater(Box::new(resolve_expr(*e, ctx)?))),
        RawExpr::AbsentExpression { absent, expr } => Ok(Expr::AbsentExpression {
            absent: Box::new(resolve_expr(*absent, ctx)?),
            expr: Box::new(resolve_expr(*expr, ctx)?),
        }),
        RawExpr::AbsentStopper(e) => Ok(Expr::AbsentStopper(Box::new(resolve_expr(*e, ctx)?))),
        RawExpr::RangeClear => Ok(Expr::RangeClear),
    }
}

fn push_coalesced(out: &mut Vec<Expr>, item: Expr) {
    if let Expr::Literal {
        text,
        ignore_case,
        ascii_icase,
    } = item
    {
        if let Some(Expr::Literal {
            text: prev_text,
            ignore_case: prev_ic,
            ascii_icase: prev_aic,
        }) = out.last_mut()
            && *prev_ic == ignore_case
            && *prev_aic == ascii_icase
        {
            prev_text.push_str(&text);
            return;
        }
        out.push(Expr::Literal {
            text,
            ignore_case,
            ascii_icase,
        });
    } else if !matches!(item, Expr::Empty) {
        out.push(item);
    }
}

fn collect_group_bodies<'a>(expr: &'a Expr, out: &mut [Option<&'a Expr>]) {
    match expr {
        Expr::Capture { index, expr, .. } => {
            out[*index] = Some(expr);
            collect_group_bodies(expr, out);
        }
        Expr::Seq(items) | Expr::Alt(items) => {
            for item in items {
                collect_group_bodies(item, out);
            }
        }
        Expr::Repeat { expr, .. } | Expr::Atomic(expr) | Expr::Lookaround { expr, .. } | Expr::AbsentRepeater(expr) | Expr::AbsentStopper(expr) => {
            collect_group_bodies(expr, out)
        }
        Expr::AbsentExpression { absent, expr } => {
            collect_group_bodies(absent, out);
            collect_group_bodies(expr, out);
        }
        Expr::Condition {
            cond,
            then_branch,
            else_branch,
        } => {
            if let ConditionKind::Expr(e) = cond {
                collect_group_bodies(e, out);
            }
            collect_group_bodies(then_branch, out);
            if let Some(e) = else_branch {
                collect_group_bodies(e, out);
            }
        }
        _ => {}
    }
}

fn validate_expr(expr: &Expr, group_bodies: &[Option<&Expr>]) -> Result<(), CompileError> {
    match expr {
        Expr::Lookaround {
            kind: LookaroundKind::PosLookbehind,
            expr,
        } => {
            let mut visited = vec![false; group_bodies.len()];
            validate_lookbehind_inner(expr, false, group_bodies, &mut visited)?;
        }
        Expr::Lookaround {
            kind: LookaroundKind::NegLookbehind,
            expr,
        } => {
            let mut visited = vec![false; group_bodies.len()];
            validate_lookbehind_inner(expr, true, group_bodies, &mut visited)?;
        }
        Expr::Seq(items) | Expr::Alt(items) => {
            for item in items {
                validate_expr(item, group_bodies)?;
            }
        }
        Expr::Repeat { expr, .. }
        | Expr::Capture { expr, .. }
        | Expr::Atomic(expr)
        | Expr::Lookaround { expr, .. }
        | Expr::AbsentRepeater(expr)
        | Expr::AbsentStopper(expr) => validate_expr(expr, group_bodies)?,
        Expr::AbsentExpression { absent, expr } => {
            validate_expr(absent, group_bodies)?;
            validate_expr(expr, group_bodies)?;
        }
        Expr::Condition {
            cond,
            then_branch,
            else_branch,
        } => {
            if let ConditionKind::Expr(e) = cond {
                validate_expr(e, group_bodies)?;
            }
            validate_expr(then_branch, group_bodies)?;
            if let Some(e) = else_branch {
                validate_expr(e, group_bodies)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_lookbehind_inner(expr: &Expr, is_negative: bool, group_bodies: &[Option<&Expr>], visited: &mut [bool]) -> Result<(), CompileError> {
    match expr {
        Expr::AbsentStopper(_) | Expr::RangeClear => {
            return Err(CompileError::new(
                CompileErrorKind::InvalidLookbehind,
                0,
                "absent stopper or range clear not allowed in look-behind",
            ));
        }
        Expr::Lookaround {
            kind: LookaroundKind::PosLookahead | LookaroundKind::NegLookahead,
            ..
        } => {
            return Err(CompileError::new(
                CompileErrorKind::InvalidLookbehind,
                0,
                "look-ahead not allowed in look-behind",
            ));
        }
        Expr::Lookaround {
            kind: LookaroundKind::NegLookbehind,
            ..
        } if !is_negative => {
            return Err(CompileError::new(
                CompileErrorKind::InvalidLookbehind,
                0,
                "negative look-behind not allowed in positive look-behind",
            ));
        }
        Expr::Capture { expr, .. } => {
            if is_negative {
                return Err(CompileError::new(
                    CompileErrorKind::InvalidLookbehind,
                    0,
                    "capturing group not allowed in negative look-behind",
                ));
            }
            validate_lookbehind_inner(expr, is_negative, group_bodies, visited)?;
        }
        Expr::Call { target_group } => {
            if !visited[*target_group] {
                visited[*target_group] = true;
                if let Some(body) = group_bodies[*target_group] {
                    validate_lookbehind_inner(body, is_negative, group_bodies, visited)?;
                }
            }
        }
        Expr::Seq(items) | Expr::Alt(items) => {
            for item in items {
                validate_lookbehind_inner(item, is_negative, group_bodies, visited)?;
            }
        }
        Expr::Repeat { expr, min, .. } => {
            if check_repeat_len_overflow(expr, u64::from(*min)) {
                return Err(CompileError::new(CompileErrorKind::InvalidLookbehind, 0, "look-behind repeat length overflow"));
            }
            validate_lookbehind_inner(expr, is_negative, group_bodies, visited)?;
        }
        Expr::Atomic(expr) | Expr::Lookaround { expr, .. } | Expr::AbsentRepeater(expr) => {
            validate_lookbehind_inner(expr, is_negative, group_bodies, visited)?;
        }
        Expr::AbsentExpression { absent, expr } => {
            validate_lookbehind_inner(absent, is_negative, group_bodies, visited)?;
            validate_lookbehind_inner(expr, is_negative, group_bodies, visited)?;
        }
        Expr::Condition {
            cond,
            then_branch,
            else_branch,
        } => {
            if let ConditionKind::Expr(e) = cond {
                validate_lookbehind_inner(e, is_negative, group_bodies, visited)?;
            }
            validate_lookbehind_inner(then_branch, is_negative, group_bodies, visited)?;
            if let Some(e) = else_branch {
                validate_lookbehind_inner(e, is_negative, group_bodies, visited)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Detects left-most recursive subroutine calls (e.g. `(?<name>a|\g<name>b)` or `(()(?(2)\g<1>))`).
fn check_left_recursion(group_bodies: &[Option<&Expr>]) -> Result<(), CompileError> {
    let n = group_bodies.len();
    for g in 0..n {
        if let Some(body) = group_bodies[g] {
            let mut visiting = vec![false; n];
            visiting[g] = true;
            if has_left_call_to(body, g, group_bodies, &mut visiting) {
                return Err(CompileError::new(
                    CompileErrorKind::LeftRecursiveCall,
                    0,
                    format!("never ending recursion in group {g}"),
                ));
            }
        }
    }
    Ok(())
}

fn has_left_call_to(expr: &Expr, target: usize, group_bodies: &[Option<&Expr>], visiting: &mut [bool]) -> bool {
    match expr {
        Expr::Call { target_group } => {
            if *target_group == target {
                return true;
            }
            if !visiting[*target_group] {
                visiting[*target_group] = true;
                let found = group_bodies[*target_group].is_some_and(|b| has_left_call_to(b, target, group_bodies, visiting));
                visiting[*target_group] = false;
                return found;
            }
            false
        }
        Expr::Seq(items) => {
            for item in items {
                if has_left_call_to(item, target, group_bodies, visiting) {
                    return true;
                }
                if !can_match_empty(item, group_bodies, &mut vec![false; group_bodies.len()]) {
                    break;
                }
            }
            false
        }
        Expr::Alt(branches) => branches.iter().any(|b| has_left_call_to(b, target, group_bodies, visiting)),
        Expr::Repeat { expr, max, .. } => {
            if *max == Some(0) {
                return false;
            }
            has_left_call_to(expr, target, group_bodies, visiting)
        }
        Expr::Capture { expr, .. } | Expr::Atomic(expr) | Expr::Lookaround { expr, .. } | Expr::AbsentRepeater(expr) | Expr::AbsentStopper(expr) => {
            has_left_call_to(expr, target, group_bodies, visiting)
        }
        Expr::AbsentExpression { expr, .. } => has_left_call_to(expr, target, group_bodies, visiting),
        Expr::Condition {
            cond,
            then_branch,
            else_branch,
        } => {
            let (cond_calls, cond_nullable) = match cond {
                ConditionKind::Expr(e) => (
                    has_left_call_to(e, target, group_bodies, visiting),
                    can_match_empty(e, group_bodies, &mut vec![false; group_bodies.len()]),
                ),
                ConditionKind::BackrefValid { .. } => (false, true),
            };
            cond_calls
                || (cond_nullable && has_left_call_to(then_branch, target, group_bodies, visiting))
                || else_branch.as_deref().is_some_and(|e| has_left_call_to(e, target, group_bodies, visiting))
        }
        _ => false,
    }
}

fn check_repeat_len_overflow(expr: &Expr, outer_min: u64) -> bool {
    const LIMIT: u64 = 100_000_000;
    fn min_bytes(e: &Expr) -> Option<u64> {
        match e {
            Expr::Literal { text, .. } => Some(text.len() as u64),
            Expr::AnyChar { .. } | Expr::CharClass(_) | Expr::GeneralNewline | Expr::TextSegment(_) => Some(1),
            Expr::Seq(items) => {
                let mut sum = 0u64;
                for i in items {
                    sum = sum.checked_add(min_bytes(i)?)?;
                    if sum > LIMIT {
                        return None;
                    }
                }
                Some(sum)
            }
            Expr::Alt(branches) => {
                let mut m = u64::MAX;
                for b in branches {
                    m = m.min(min_bytes(b)?);
                }
                Some(if m == u64::MAX { 0 } else { m })
            }
            Expr::Repeat { expr, min, .. } => {
                let prod = min_bytes(expr)?.checked_mul(u64::from(*min))?;
                if prod > LIMIT { None } else { Some(prod) }
            }
            Expr::Capture { expr, .. } | Expr::Atomic(expr) => min_bytes(expr),
            _ => Some(0),
        }
    }
    match min_bytes(expr) {
        None => true,
        Some(inner) => inner.checked_mul(outer_min).is_none_or(|p| p > LIMIT),
    }
}

fn can_match_empty(expr: &Expr, group_bodies: &[Option<&Expr>], visited: &mut [bool]) -> bool {
    match expr {
        Expr::Empty | Expr::Anchor(_) | Expr::Keep | Expr::Lookaround { .. } | Expr::RangeClear => true,
        Expr::Fail | Expr::AnyChar { .. } | Expr::GeneralNewline | Expr::TextSegment(_) | Expr::CharClass(_) => false,
        Expr::Literal { text, .. } => text.is_empty(),
        Expr::Backref { .. } => true,
        Expr::Seq(items) => items.iter().all(|i| can_match_empty(i, group_bodies, visited)),
        Expr::Alt(branches) => branches.iter().any(|b| can_match_empty(b, group_bodies, visited)),
        Expr::Repeat { expr, min, .. } => *min == 0 || can_match_empty(expr, group_bodies, visited),
        Expr::Capture { expr, .. } | Expr::Atomic(expr) => can_match_empty(expr, group_bodies, visited),
        Expr::Call { target_group } => {
            if visited[*target_group] {
                return true;
            }
            visited[*target_group] = true;
            let res = group_bodies[*target_group].is_some_and(|b| can_match_empty(b, group_bodies, visited));
            visited[*target_group] = false;
            res
        }
        Expr::Condition { then_branch, else_branch, .. } => {
            can_match_empty(then_branch, group_bodies, visited) || else_branch.as_deref().is_none_or(|e| can_match_empty(e, group_bodies, visited))
        }
        Expr::AbsentRepeater(_) | Expr::AbsentStopper(_) => true,
        Expr::AbsentExpression { expr, .. } => can_match_empty(expr, group_bodies, visited),
    }
}
