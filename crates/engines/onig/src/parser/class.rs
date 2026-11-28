use super::expr::Parser;
use super::raw::{ClassAtom, MAX_NESTING_DEPTH, RawExpr};
use crate::options::{CompileError, CompileErrorKind};
use crate::unicode::{self, CharSet, MAX_CODEPOINT, PosixClass, digit_charset, fold_multi_expansion, space_charset, word_charset, xdigit_charset};

impl<'a> Parser<'a> {
    pub(super) fn parse_char_class(&mut self) -> Result<RawExpr, CompileError> {
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
            PosixClass::Alnum
            | PosixClass::Alpha
            | PosixClass::Ascii
            | PosixClass::Blank
            | PosixClass::Cntrl
            | PosixClass::Graph
            | PosixClass::Lower
            | PosixClass::Print
            | PosixClass::Punct
            | PosixClass::Upper
            | PosixClass::XDigit => self.flags.posix_ascii,
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
                    Ok(ClassAtom::Single(self.parse_raw_byte_char(esc_pos)?))
                }
            }
            'o' if self.bytes.get(self.pos + 1) == Some(&b'{') => {
                self.pos += 2;
                self.parse_braced_class_spec(8, 11, esc_pos)
            }
            '0'..='7' => Ok(ClassAtom::Single(self.parse_raw_byte_char(esc_pos)?)),
            _ => {
                let c = self.parse_char_escape_after_backslash(esc_pos, true)?;
                Ok(ClassAtom::Single(c))
            }
        }
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
