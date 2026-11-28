use super::expr::Parser;
use super::raw::{FlagTerminator, Flags, GroupDecl, MAX_NESTING_DEPTH, RawCondition, RawExpr, RawRef, SpecialGroup};
use crate::ast::LookaroundKind;
use crate::options::{CompileError, CompileErrorKind, FindOption, Syntax};
use crate::unicode;
use crate::unicode::segment::SegmentMode;

impl<'a> Parser<'a> {
    pub(super) fn try_parse_comment_or_isolated_flag(&mut self) -> Result<Option<SpecialGroup>, CompileError> {
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

    pub(super) fn parse_group(&mut self) -> Result<RawExpr, CompileError> {
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
}
