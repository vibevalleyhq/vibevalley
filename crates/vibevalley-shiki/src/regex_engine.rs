use std::ops::{BitAnd, BitOr, BitOrAssign};

use fancy_regex::{Regex, RegexBuilder, RegexInput};

use crate::error::RegexError;

const DEFAULT_BACKTRACK_LIMIT: usize = 1_000_000;
const DEFAULT_MAX_PROG_SIZE: usize = 100_000;

/// Search options passed to `RegexScanner::find_next_match`.
///
/// Mirrors `vibevalley_onig::FindOption` and `vscode-oniguruma`'s `FindOption` bitmask.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct FindOption(u32);

impl FindOption {
    pub const NONE: Self = Self(0);
    /// Equivalent to `ONIG_OPTION_NOT_BEGIN_STRING`: `\A` fails even at byte 0.
    pub const NOT_BEGIN_STRING: Self = Self(1 << 0);
    /// Equivalent to `ONIG_OPTION_NOT_END_STRING`: `\z` and `\Z` fail.
    pub const NOT_END_STRING: Self = Self(1 << 1);
    /// Equivalent to `ONIG_OPTION_NOT_BEGIN_POSITION`: `\G` fails at `start_byte`.
    pub const NOT_BEGIN_POSITION: Self = Self(1 << 2);

    pub const fn from_bits(bits: u32) -> Self {
        Self(bits)
    }

    pub const fn bits(self) -> u32 {
        self.0
    }

    pub const fn contains(self, other: Self) -> bool {
        (self.0 & other.0) == other.0
    }

    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }
}

impl BitOr for FindOption {
    type Output = Self;

    fn bitor(self, rhs: Self) -> Self::Output {
        Self(self.0 | rhs.0)
    }
}

impl BitOrAssign for FindOption {
    fn bitor_assign(&mut self, rhs: Self) {
        self.0 |= rhs.0;
    }
}

impl BitAnd for FindOption {
    type Output = Self;

    fn bitand(self, rhs: Self) -> Self::Output {
        Self(self.0 & rhs.0)
    }
}

/// Byte offset span of a matched capture group within a UTF-8 line string.
///
/// Matches `vibevalley_onig::CaptureIndex`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CaptureIndex {
    pub start: usize,
    pub end: usize,
}

impl CaptureIndex {
    pub const fn new(start: usize, end: usize) -> Self {
        Self { start, end }
    }

    pub const fn len(self) -> usize {
        self.end.saturating_sub(self.start)
    }

    pub const fn is_empty(self) -> bool {
        self.start >= self.end
    }
}

/// Winning pattern match returned by `RegexScanner::find_next_match`.
///
/// `Option<CaptureIndex>` distinguishes unmatched optional groups (`None`) from
/// zero-length matches (`Some(CaptureIndex { start, end })` with `start == end`).
/// Matches `vibevalley_onig::ScannerMatch`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScannerMatch {
    pub index: usize,
    pub capture_indices: Vec<Option<CaptureIndex>>,
}

impl ScannerMatch {
    pub fn full(&self) -> CaptureIndex {
        self.capture_indices.first().copied().flatten().unwrap_or(CaptureIndex::new(0, 0))
    }

    pub fn get(&self, index: usize) -> Option<CaptureIndex> {
        self.capture_indices.get(index).copied().flatten()
    }
}

/// Pre-indexed line string passed to `RegexScanner`.
///
/// Aligns 1:1 with `vibevalley_onig::OnigString`.
pub trait RegexString: Send + Sync {
    fn content(&self) -> &str;
}

impl RegexString for String {
    fn content(&self) -> &str {
        self.as_str()
    }
}

/// Multi-pattern regex scanner matching the earliest-starting pattern from `start_byte`
/// (breaking ties by earliest pattern index).
///
/// Aligns 1:1 with `vibevalley_onig::OnigScanner` + `vibevalley_onig::ScannerCache`.
pub trait RegexScanner: Send + Sync {
    type String: RegexString;
    type Cache: Send;

    fn create_cache(&self) -> Self::Cache;

    fn find_next_match(&self, haystack: &Self::String, start_byte: usize, options: FindOption, cache: &mut Self::Cache) -> Option<ScannerMatch>;
}

/// Regex backend factory for `Registry`, `Grammar`, and `Highlighter`.
///
/// Aligns 1:1 with `vibevalley_onig` (`OnigScanner` / `OnigString` / `ScannerCache`).
pub trait RegexEngine: Send + Sync {
    type String: RegexString;
    type Scanner: RegexScanner<String = Self::String>;

    fn create_scanner(&self, patterns: &[String]) -> Result<Self::Scanner, RegexError>;

    fn create_string(&self, content: String) -> Self::String;

    /// Whether `RegexScanner::find_next_match` natively honors `FindOption::NOT_BEGIN_STRING`
    /// and `FindOption::NOT_BEGIN_POSITION` (true for `vibevalley-onig` and `FancyRegexEngine`).
    ///
    /// When false, `Grammar` rewrites `\A` and `\G` anchors via `vscode-textmate`'s 4-slot
    /// anchor cache before compiling scanners.
    fn supports_find_options(&self) -> bool {
        false
    }
}

/// Pure-Rust fallback `RegexEngine` powered by `fancy-regex` in Oniguruma compatibility mode.
///
/// Uses `vscode-textmate`'s 4-slot anchor rewriting (`supports_find_options() == false`) because
/// `fancy-regex`'s `RegexInput::start_text(false)` suppresses both `^` and `\A`, whereas Oniguruma's
/// `NOT_BEGIN_STRING` suppresses only `\A` (`vibevalley-onig` separates `NOT_BEGIN_STRING` from
/// `NOTBOL` and can set `supports_find_options() == true`).
///
/// Patterns with unbounded recursive subroutines (e.g. Thrift's 4-way recursive `\g<ft>`) exceed
/// `max_prog_size` and await `vibevalley-onig`.
#[derive(Debug, Clone, Copy, Default)]
pub struct FancyRegexEngine;

impl RegexEngine for FancyRegexEngine {
    type String = String;
    type Scanner = FancyRegexScanner;

    fn create_scanner(&self, patterns: &[String]) -> Result<Self::Scanner, RegexError> {
        let mut compiled = Vec::with_capacity(patterns.len());
        for (index, pattern) in patterns.iter().enumerate() {
            // In Oniguruma, `^` never matches at EOF after a trailing `\n`, whereas `$` does.
            // `fancy-regex`'s `disallow_empty_match_at_eof_after_newline` suppresses both, so
            // rewrite unescaped `^` outside character classes to Oniguruma's exact BOL semantics.
            let adjusted = rewrite_onig_bol(pattern);
            let regex = RegexBuilder::new(&adjusted)
                .oniguruma_mode(true)
                .multi_line(true)
                .allow_input_assertion_overrides(true)
                .backtrack_limit(DEFAULT_BACKTRACK_LIMIT)
                .max_prog_size(DEFAULT_MAX_PROG_SIZE)
                .build()
                .map_err(|err| RegexError::Compile {
                    index,
                    pattern: pattern.clone(),
                    message: err.to_string(),
                })?;
            compiled.push(regex);
        }
        Ok(FancyRegexScanner { patterns: compiled })
    }

    fn create_string(&self, content: String) -> Self::String {
        content
    }

    fn supports_find_options(&self) -> bool {
        false
    }
}

/// Pure-Rust multi-pattern scanner backed by `fancy-regex` in Oniguruma mode.
pub struct FancyRegexScanner {
    patterns: Vec<Regex>,
}

impl RegexScanner for FancyRegexScanner {
    type String = String;
    type Cache = ();

    fn create_cache(&self) -> Self::Cache {}

    fn find_next_match(&self, haystack: &Self::String, start_byte: usize, options: FindOption, _cache: &mut Self::Cache) -> Option<ScannerMatch> {
        if start_byte > haystack.len() || !haystack.is_char_boundary(start_byte) {
            return None;
        }

        let start_text = !options.contains(FindOption::NOT_BEGIN_STRING);
        let end_text = !options.contains(FindOption::NOT_END_STRING);
        let allow_g = !options.contains(FindOption::NOT_BEGIN_POSITION);

        let mut best: Option<ScannerMatch> = None;
        let mut best_start = usize::MAX;

        for (index, regex) in self.patterns.iter().enumerate() {
            let input = RegexInput::new(haystack.as_str())
                .from_pos(start_byte)
                .start_text(start_text)
                .end_text(end_text)
                .continue_from_previous_match_end(allow_g);

            let Ok(Some(captures)) = regex.captures_input(input) else {
                continue;
            };
            let match_start = captures.get(0).map_or(usize::MAX, |m| m.start());
            if match_start < best_start {
                best_start = match_start;
                let mut indices = Vec::with_capacity(captures.len());
                for i in 0..captures.len() {
                    indices.push(captures.get(i).map(|m| CaptureIndex::new(m.start(), m.end())));
                }
                best = Some(ScannerMatch {
                    index,
                    capture_indices: indices,
                });
                if best_start == start_byte {
                    break;
                }
            }
        }
        best
    }
}

/// Rewrites unescaped `^` outside character classes to `(?:\A|(?<=\n)(?!\z))` to match
/// Oniguruma's `OP_BEGIN_LINE` (which never matches at EOF after a trailing `\n`).
fn rewrite_onig_bol(pattern: &str) -> String {
    if !pattern.contains('^') {
        return pattern.to_string();
    }
    let bytes = pattern.as_bytes();
    let len = bytes.len();
    let mut out = String::with_capacity(len + 16);
    let mut i = 0;
    let mut class_depth: usize = 0;
    let mut just_opened_class = false;

    while i < len {
        let b = bytes[i];
        if b == b'\\' && i + 1 < len {
            out.push('\\');
            let ch = pattern[i + 1..].chars().next().unwrap();
            out.push(ch);
            i += 1 + ch.len_utf8();
            just_opened_class = false;
            continue;
        }
        if class_depth > 0 {
            if b == b'^' && just_opened_class {
                out.push('^');
                i += 1;
                continue;
            }
            if b == b']' && !just_opened_class {
                class_depth -= 1;
                out.push(']');
                i += 1;
                continue;
            }
            if b == b'[' {
                if i + 1 < len
                    && bytes[i + 1] == b':'
                    && let Some(end_rel) = pattern[i + 2..].find(":]")
                {
                    let inner = &pattern[i + 2..i + 2 + end_rel];
                    if inner.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'^') {
                        out.push_str(&pattern[i..i + 2 + end_rel + 2]);
                        i = i + 2 + end_rel + 2;
                        just_opened_class = false;
                        continue;
                    }
                }
                class_depth += 1;
                just_opened_class = true;
                out.push('[');
                i += 1;
                continue;
            }
            let ch = pattern[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
            just_opened_class = false;
            continue;
        }

        if b == b'[' {
            class_depth = 1;
            just_opened_class = true;
            out.push('[');
            i += 1;
            continue;
        }
        if b == b'^' {
            out.push_str(r"(?:\A|(?<=\n)(?!\z))");
            i += 1;
            continue;
        }
        let ch = pattern[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}
