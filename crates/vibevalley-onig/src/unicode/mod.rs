#[allow(dead_code)]
mod fold_data;
#[allow(dead_code)]
mod props_data;
pub mod segment;
#[allow(dead_code)]
mod segment_data;

use fold_data::{FOLD_MULTI, FOLD1_GROUPS, FOLD1_MAP, FOLD1_POOL};
use props_data::{CTYPE_EXTENDEDPICTOGRAPHIC, PROP_NAMES, PROP_RANGES, PROP_SLICES};

pub const MAX_CODEPOINT: u32 = 0x10_FFFF;

// Oniguruma standard POSIX/ctype indices in `CodeRanges[]`.
const CTYPE_ALPHA: u16 = 1;
const CTYPE_BLANK: u16 = 2;
const CTYPE_CNTRL: u16 = 3;
const CTYPE_DIGIT: u16 = 4;
const CTYPE_GRAPH: u16 = 5;
const CTYPE_LOWER: u16 = 6;
const CTYPE_PRINT: u16 = 7;
const CTYPE_POSIX_PUNCT: u16 = 8;
const CTYPE_SPACE: u16 = 9;
const CTYPE_UPPER: u16 = 10;
const CTYPE_XDIGIT: u16 = 11;
const CTYPE_WORD: u16 = 12;
const CTYPE_ALNUM: u16 = 13;
const CTYPE_ASCII: u16 = 14;

/// Sorted, non-overlapping inclusive Unicode code point ranges with an ASCII fast bitmap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CharSet {
    ascii_lo: u64,
    ascii_hi: u64,
    ranges: Vec<(u32, u32)>,
}

impl CharSet {
    pub fn full() -> Self {
        Self::from_ranges(vec![(0, MAX_CODEPOINT)])
    }

    pub fn from_sorted_slice(slice: &[(u32, u32)]) -> Self {
        let mut set = Self {
            ascii_lo: 0,
            ascii_hi: 0,
            ranges: slice.to_vec(),
        };
        set.rebuild_ascii_mask();
        set
    }

    pub fn from_ranges(mut ranges: Vec<(u32, u32)>) -> Self {
        ranges.retain(|&(lo, hi)| lo <= hi && lo <= MAX_CODEPOINT);
        for range in &mut ranges {
            if range.1 > MAX_CODEPOINT {
                range.1 = MAX_CODEPOINT;
            }
        }
        ranges.sort_unstable_by_key(|&(lo, hi)| (lo, hi));
        let mut merged: Vec<(u32, u32)> = Vec::with_capacity(ranges.len());
        for (lo, hi) in ranges {
            if let Some(last) = merged.last_mut()
                && lo <= last.1.saturating_add(1)
            {
                if hi > last.1 {
                    last.1 = hi;
                }
                continue;
            }
            merged.push((lo, hi));
        }
        let mut set = Self {
            ascii_lo: 0,
            ascii_hi: 0,
            ranges: merged,
        };
        set.rebuild_ascii_mask();
        set
    }

    fn rebuild_ascii_mask(&mut self) {
        let mut lo = 0u64;
        let mut hi = 0u64;
        for &(start, end) in &self.ranges {
            if start >= 128 {
                break;
            }
            let clamped_end = end.min(127);
            for cp in start..=clamped_end {
                if cp < 64 {
                    lo |= 1u64 << cp;
                } else {
                    hi |= 1u64 << (cp - 64);
                }
            }
        }
        self.ascii_lo = lo;
        self.ascii_hi = hi;
    }

    #[inline]
    pub fn contains(&self, c: char) -> bool {
        self.contains_cp(c as u32)
    }

    #[inline]
    pub fn contains_cp(&self, cp: u32) -> bool {
        if cp < 128 {
            return if cp < 64 {
                (self.ascii_lo & (1u64 << cp)) != 0
            } else {
                (self.ascii_hi & (1u64 << (cp - 64))) != 0
            };
        }
        self.ranges
            .binary_search_by(|&(lo, hi)| {
                if cp < lo {
                    std::cmp::Ordering::Greater
                } else if cp > hi {
                    std::cmp::Ordering::Less
                } else {
                    std::cmp::Ordering::Equal
                }
            })
            .is_ok()
    }

    pub fn is_empty(&self) -> bool {
        self.ranges.is_empty()
    }

    pub fn ranges(&self) -> &[(u32, u32)] {
        &self.ranges
    }

    pub fn union(&self, other: &Self) -> Self {
        let mut combined = Vec::with_capacity(self.ranges.len() + other.ranges.len());
        combined.extend_from_slice(&self.ranges);
        combined.extend_from_slice(&other.ranges);
        Self::from_ranges(combined)
    }

    pub fn intersect(&self, other: &Self) -> Self {
        let mut out = Vec::new();
        let (mut i, mut j) = (0, 0);
        while i < self.ranges.len() && j < other.ranges.len() {
            let (a_lo, a_hi) = self.ranges[i];
            let (b_lo, b_hi) = other.ranges[j];
            let lo = a_lo.max(b_lo);
            let hi = a_hi.min(b_hi);
            if lo <= hi {
                out.push((lo, hi));
            }
            if a_hi < b_hi {
                i += 1;
            } else {
                j += 1;
            }
        }
        let mut set = Self {
            ascii_lo: 0,
            ascii_hi: 0,
            ranges: out,
        };
        set.rebuild_ascii_mask();
        set
    }

    pub fn complement(&self) -> Self {
        if self.ranges.is_empty() {
            return Self::full();
        }
        let mut out = Vec::with_capacity(self.ranges.len() + 1);
        let mut cursor = 0u32;
        for &(lo, hi) in &self.ranges {
            if cursor < lo {
                out.push((cursor, lo - 1));
            }
            if hi >= MAX_CODEPOINT {
                cursor = MAX_CODEPOINT + 1;
                break;
            }
            cursor = hi + 1;
        }
        if cursor <= MAX_CODEPOINT {
            out.push((cursor, MAX_CODEPOINT));
        }
        let mut set = Self {
            ascii_lo: 0,
            ascii_hi: 0,
            ranges: out,
        };
        set.rebuild_ascii_mask();
        set
    }

    /// Expands this character set to include all single-codepoint case-fold equivalents.
    pub fn case_fold(&self, ascii_only: bool) -> Self {
        if ascii_only {
            let mut extra = self.ranges.clone();
            for cp in b'A'..=b'Z' {
                if self.contains_cp(u32::from(cp)) {
                    let lo = u32::from(cp + 32);
                    extra.push((lo, lo));
                }
            }
            for cp in b'a'..=b'z' {
                if self.contains_cp(u32::from(cp)) {
                    let up = u32::from(cp - 32);
                    extra.push((up, up));
                }
            }
            return Self::from_ranges(extra);
        }

        let mut extra = self.ranges.clone();
        // Iterate FOLD1_MAP entries that overlap with `self.ranges` in O(N + M).
        let mut r_idx = 0usize;
        for &(cp, gid) in FOLD1_MAP {
            while r_idx < self.ranges.len() && self.ranges[r_idx].1 < cp {
                r_idx += 1;
            }
            if r_idx >= self.ranges.len() {
                break;
            }
            if self.ranges[r_idx].0 <= cp {
                let (off, cnt) = FOLD1_GROUPS[gid as usize];
                let slice = &FOLD1_POOL[off as usize..(off as usize + cnt as usize)];
                for &equiv in slice {
                    extra.push((equiv, equiv));
                }
            }
        }
        Self::from_ranges(extra)
    }

    /// Computes a 256-bit leading UTF-8 byte mask for fast search prefiltering.
    pub fn first_utf8_byte_mask(&self) -> [u64; 4] {
        let mut mask = [0u64; 4];
        for &(lo, hi) in &self.ranges {
            let mut cp = lo;
            while cp <= hi {
                if cp < 0x80 {
                    let end = hi.min(0x7F);
                    for b in cp..=end {
                        set_byte(&mut mask, b as u8);
                    }
                    cp = end + 1;
                } else if cp < 0x800 {
                    let end = hi.min(0x7FF);
                    let b0 = (0xC0 | (cp >> 6)) as u8;
                    let b1 = (0xC0 | (end >> 6)) as u8;
                    for b in b0..=b1 {
                        set_byte(&mut mask, b);
                    }
                    cp = end + 1;
                } else if cp < 0x10000 {
                    let end = hi.min(0xFFFF);
                    let b0 = (0xE0 | (cp >> 12)) as u8;
                    let b1 = (0xE0 | (end >> 12)) as u8;
                    for b in b0..=b1 {
                        set_byte(&mut mask, b);
                    }
                    cp = end + 1;
                } else {
                    let end = hi.min(MAX_CODEPOINT);
                    let b0 = (0xF0 | (cp >> 18)) as u8;
                    let b1 = (0xF0 | (end >> 18)) as u8;
                    for b in b0..=b1 {
                        set_byte(&mut mask, b);
                    }
                    break;
                }
            }
        }
        mask
    }
}

#[inline]
pub fn set_byte(mask: &mut [u64; 4], byte: u8) {
    mask[(byte >> 6) as usize] |= 1u64 << (byte & 63);
}

#[inline]
pub fn test_byte(mask: &[u64; 4], byte: u8) -> bool {
    (mask[(byte >> 6) as usize] & (1u64 << (byte & 63))) != 0
}

fn ctype_ranges(ctype: u16) -> &'static [(u32, u32)] {
    let (off, cnt) = PROP_SLICES[ctype as usize];
    &PROP_RANGES[off as usize..(off as usize + cnt as usize)]
}

/// Looks up a Unicode property name (e.g. `\p{Letter}`, `\p{L}`, `\p{In_Basic_Latin}`, `\p{Word}`).
pub fn lookup_property(raw_name: &str) -> Option<CharSet> {
    if !raw_name.is_ascii() {
        return None;
    }
    let mut norm = String::with_capacity(raw_name.len());
    for b in raw_name.bytes() {
        if b == b' ' || b == b'-' || b == b'_' {
            continue;
        }
        norm.push(b.to_ascii_lowercase() as char);
    }
    let idx = PROP_NAMES.binary_search_by_key(&norm.as_str(), |&(name, _)| name).ok()?;
    let ctype = PROP_NAMES[idx].1;
    Some(CharSet::from_sorted_slice(ctype_ranges(ctype)))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PosixClass {
    Alnum,
    Alpha,
    Ascii,
    Blank,
    Cntrl,
    Digit,
    Graph,
    Lower,
    Print,
    Punct,
    Space,
    Upper,
    Word,
    XDigit,
}

impl PosixClass {
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "alnum" => Some(Self::Alnum),
            "alpha" => Some(Self::Alpha),
            "ascii" => Some(Self::Ascii),
            "blank" => Some(Self::Blank),
            "cntrl" => Some(Self::Cntrl),
            "digit" => Some(Self::Digit),
            "graph" => Some(Self::Graph),
            "lower" => Some(Self::Lower),
            "print" => Some(Self::Print),
            "punct" => Some(Self::Punct),
            "space" => Some(Self::Space),
            "upper" => Some(Self::Upper),
            "word" => Some(Self::Word),
            "xdigit" => Some(Self::XDigit),
            _ => None,
        }
    }

    pub fn charset(self, ascii_only: bool) -> CharSet {
        if ascii_only {
            return match self {
                Self::Alnum => CharSet::from_ranges(vec![(0x30, 0x39), (0x41, 0x5A), (0x61, 0x7A)]),
                Self::Alpha => CharSet::from_ranges(vec![(0x41, 0x5A), (0x61, 0x7A)]),
                Self::Ascii => CharSet::from_ranges(vec![(0x00, 0x7F)]),
                Self::Blank => CharSet::from_ranges(vec![(0x09, 0x09), (0x20, 0x20)]),
                Self::Cntrl => CharSet::from_ranges(vec![(0x00, 0x1F), (0x7F, 0x7F)]),
                Self::Digit => CharSet::from_ranges(vec![(0x30, 0x39)]),
                Self::Graph => CharSet::from_ranges(vec![(0x21, 0x7E)]),
                Self::Lower => CharSet::from_ranges(vec![(0x61, 0x7A)]),
                Self::Print => CharSet::from_ranges(vec![(0x20, 0x7E)]),
                Self::Punct => CharSet::from_ranges(vec![(0x21, 0x2F), (0x3A, 0x40), (0x5B, 0x60), (0x7B, 0x7E)]),
                Self::Space => CharSet::from_ranges(vec![(0x09, 0x0D), (0x20, 0x20)]),
                Self::Upper => CharSet::from_ranges(vec![(0x41, 0x5A)]),
                Self::Word => CharSet::from_ranges(vec![(0x30, 0x39), (0x41, 0x5A), (0x5F, 0x5F), (0x61, 0x7A)]),
                Self::XDigit => CharSet::from_ranges(vec![(0x30, 0x39), (0x41, 0x46), (0x61, 0x66)]),
            };
        }

        let ctype = match self {
            Self::Alnum => CTYPE_ALNUM,
            Self::Alpha => CTYPE_ALPHA,
            Self::Ascii => CTYPE_ASCII,
            Self::Blank => CTYPE_BLANK,
            Self::Cntrl => CTYPE_CNTRL,
            Self::Digit => CTYPE_DIGIT,
            Self::Graph => CTYPE_GRAPH,
            Self::Lower => CTYPE_LOWER,
            Self::Print => CTYPE_PRINT,
            Self::Punct => CTYPE_POSIX_PUNCT,
            Self::Space => CTYPE_SPACE,
            Self::Upper => CTYPE_UPPER,
            Self::Word => CTYPE_WORD,
            Self::XDigit => CTYPE_XDIGIT,
        };
        CharSet::from_sorted_slice(ctype_ranges(ctype))
    }
}

pub fn word_charset(ascii_only: bool) -> CharSet {
    PosixClass::Word.charset(ascii_only)
}

pub fn digit_charset(ascii_only: bool) -> CharSet {
    PosixClass::Digit.charset(ascii_only)
}

pub fn space_charset(ascii_only: bool) -> CharSet {
    PosixClass::Space.charset(ascii_only)
}

pub fn xdigit_charset() -> CharSet {
    PosixClass::XDigit.charset(true)
}

#[inline]
pub fn is_alpha_char(c: char) -> bool {
    let cp = c as u32;
    if cp < 128 {
        return c.is_ascii_alphabetic();
    }
    in_ranges(ctype_ranges(CTYPE_ALPHA), cp)
}

#[inline]
pub fn is_word_char(c: char, ascii_only: bool) -> bool {
    if ascii_only {
        return c.is_ascii_alphanumeric() || c == '_';
    }
    let cp = c as u32;
    if cp < 128 {
        return c.is_ascii_alphanumeric() || c == '_';
    }
    in_ranges(ctype_ranges(CTYPE_WORD), cp)
}

#[inline]
fn in_ranges(ranges: &[(u32, u32)], cp: u32) -> bool {
    ranges
        .binary_search_by(|&(lo, hi)| {
            if cp < lo {
                std::cmp::Ordering::Greater
            } else if cp > hi {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

/// Returns the single-codepoint case-fold equivalence class of `cp`, if any.
#[inline]
pub fn fold1_equivalents(cp: u32) -> Option<&'static [u32]> {
    let idx = FOLD1_MAP.binary_search_by_key(&cp, |&(c, _)| c).ok()?;
    let gid = FOLD1_MAP[idx].1 as usize;
    let (off, cnt) = FOLD1_GROUPS[gid];
    Some(&FOLD1_POOL[off as usize..(off as usize + cnt as usize)])
}

/// Canonical single-codepoint fold value (minimum code point in the fold1 class, or `cp` itself).
#[inline]
pub fn fold1_canonical(cp: u32, ascii_only: bool) -> u32 {
    if ascii_only {
        if (b'A' as u32..=b'Z' as u32).contains(&cp) {
            return cp + 32;
        }
        return cp;
    }
    if cp < 128 {
        // Note: 'k'/'K' folds with U+212A (KELVIN SIGN) and 's'/'S' with U+017F (LONG S),
        // and the minimum codepoint in their fold1 groups is 'K'/'S' (0x4B/0x53),
        // so use the table lookup for full equivalence.
        if let Some(group) = fold1_equivalents(cp) {
            return group[0];
        }
        return cp;
    }
    if let Some(group) = fold1_equivalents(cp) {
        return group[0];
    }
    cp
}

/// Returns true if two single characters match under ignore-case.
#[inline]
pub fn chars_eq_icase(a: char, b: char, ascii_only: bool) -> bool {
    if a == b {
        return true;
    }
    if ascii_only {
        return a.is_ascii() && b.is_ascii() && a.eq_ignore_ascii_case(&b);
    }
    fold1_canonical(a as u32, false) == fold1_canonical(b as u32, false)
}

/// If `cp` has a multi-codepoint case fold expansion (e.g. `ß` -> `["s", "s"]`), returns it.
#[inline]
pub fn fold_multi_expansion(cp: u32) -> Option<&'static [u32]> {
    let idx = FOLD_MULTI.binary_search_by_key(&cp, |&(c, _)| c).ok()?;
    Some(FOLD_MULTI[idx].1)
}

/// Expands a UTF-8 slice into its Unicode case-folded sequence of canonical codepoints.
/// Used for case-insensitive backreference and multi-char literal matching.
pub fn fold_str_codepoints(s: &str, ascii_only: bool, out: &mut Vec<u32>) {
    out.clear();
    if ascii_only {
        for ch in s.chars() {
            out.push(fold1_canonical(ch as u32, true));
        }
        return;
    }
    for ch in s.chars() {
        let cp = ch as u32;
        if let Some(multi) = fold_multi_expansion(cp) {
            for &m in multi {
                out.push(fold1_canonical(m, false));
            }
        } else {
            out.push(fold1_canonical(cp, false));
        }
    }
}

/// Matches a case-insensitive literal `pat` against `haystack[pos..]`, supporting
/// Unicode 1-to-2 and 1-to-3 case folding (e.g. `ß` <-> `ss`/`SS`, `ﬃ` <-> `ffi`).
/// Returns the matched end byte offset in `haystack` if matched.
pub fn match_icase_str(haystack: &str, pos: usize, pat: &str, ascii_only: bool) -> Option<usize> {
    if ascii_only {
        let rem = haystack.get(pos..)?;
        if rem.len() < pat.len() {
            return None;
        }
        let mut h_iter = rem.char_indices();
        let mut last_end = 0;
        for p_ch in pat.chars() {
            let (idx, h_ch) = h_iter.next()?;
            if !chars_eq_icase(p_ch, h_ch, true) {
                return None;
            }
            last_end = idx + h_ch.len_utf8();
        }
        return Some(pos + last_end);
    }

    // Fast ASCII path when neither pattern nor matching prefix contains special fold chars.
    let mut p_buf = Vec::with_capacity(pat.len());
    fold_str_codepoints(pat, false, &mut p_buf);

    let rem = haystack.get(pos..)?;
    let mut h_iter = rem.char_indices();
    let mut p_idx = 0usize;
    let mut consumed = 0usize;
    while p_idx < p_buf.len() {
        let (idx, h_ch) = h_iter.next()?;
        let h_cp = h_ch as u32;
        if let Some(multi) = fold_multi_expansion(h_cp) {
            if p_idx + multi.len() > p_buf.len() {
                return None;
            }
            for &m in multi {
                if fold1_canonical(m, false) != p_buf[p_idx] {
                    return None;
                }
                p_idx += 1;
            }
        } else {
            if fold1_canonical(h_cp, false) != p_buf[p_idx] {
                return None;
            }
            p_idx += 1;
        }
        consumed = idx + h_ch.len_utf8();
    }
    Some(pos + consumed)
}

#[inline]
pub fn is_extended_pictographic(cp: u32) -> bool {
    in_ranges(ctype_ranges(CTYPE_EXTENDEDPICTOGRAPHIC), cp)
}

/// Returns true if `c` is a Unicode general newline character (`\n`, `\v`, `\f`, `\r`, U+0085, U+2028, U+2029).
#[inline]
pub fn is_general_newline(c: char) -> bool {
    matches!(c, '\n' | '\x0b' | '\x0c' | '\r' | '\u{0085}' | '\u{2028}' | '\u{2029}')
}
