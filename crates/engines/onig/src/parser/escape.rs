use super::expr::Parser;
use super::raw::{ClassAtom, RawExpr, RawRef};
use crate::ast::Anchor;
use crate::options::{CompileError, CompileErrorKind, Syntax};
use crate::unicode::{self, CharSet, MAX_CODEPOINT, PosixClass, digit_charset, lookup_property, space_charset, word_charset, xdigit_charset};

impl<'a> Parser<'a> {
    pub(super) fn parse_escape(&mut self) -> Result<RawExpr, CompileError> {
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
    pub(super) fn parse_raw_byte_char(&mut self, esc_pos: usize) -> Result<char, CompileError> {
        let first = self.parse_single_raw_byte(esc_pos)?;
        if first < 0x80 {
            return Ok(first as char);
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
        Ok(s.chars().next().unwrap())
    }

    fn parse_raw_byte_sequence_from(&mut self, esc_pos: usize, _in_class: bool) -> Result<RawExpr, CompileError> {
        let ch = self.parse_raw_byte_char(esc_pos)?;
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
    pub(super) fn parse_braced_class_spec(&mut self, radix: u32, max_digits: usize, esc_pos: usize) -> Result<ClassAtom, CompileError> {
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

    pub(super) fn parse_char_escape_after_backslash(&mut self, esc_pos: usize, in_class: bool) -> Result<char, CompileError> {
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

    pub(super) fn parse_property(&mut self, outer_neg: bool, esc_pos: usize) -> Result<CharSet, CompileError> {
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

    pub(super) fn parse_ref_spec(&mut self, delim: u8, allow_level: bool, esc_pos: usize) -> Result<(RawRef, Option<i32>), CompileError> {
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

    pub(super) fn try_scan_level(&mut self) -> Option<i32> {
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

    pub(super) fn scan_uint(&mut self) -> Option<usize> {
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
