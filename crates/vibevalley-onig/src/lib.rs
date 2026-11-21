mod ast;
mod compiler;
mod options;
mod parser;
mod string;
mod unicode;
mod vm;

pub use crate::options::{CompileError, CompileErrorKind, ExecError, ExecLimits, FindOption, ScannerConfig, Syntax};
pub use crate::string::OnigString;
pub use crate::vm::{CaptureIndex, RegExpMatch};

use crate::compiler::Program;

#[derive(Debug, Clone)]
pub struct OnigRegExp {
    pattern: String,
    program: Program,
    limits: ExecLimits,
}

impl OnigRegExp {
    pub fn new(pattern: &str) -> Result<Self, CompileError> {
        Self::with_options(pattern, FindOption::DEFAULT, Syntax::Oniguruma)
    }

    pub fn with_options(pattern: &str, options: FindOption, syntax: Syntax) -> Result<Self, CompileError> {
        let parsed = parser::parse(pattern, options, syntax)?;
        let program = compiler::compile(&parsed);
        Ok(Self {
            pattern: pattern.to_string(),
            program,
            limits: ExecLimits::default(),
        })
    }

    pub fn with_limits(mut self, limits: ExecLimits) -> Self {
        self.limits = limits;
        self
    }

    pub fn pattern(&self) -> &str {
        &self.pattern
    }

    pub fn capture_count(&self) -> usize {
        self.program.num_captures
    }

    pub fn named_group(&self, name: &str) -> Option<&[usize]> {
        self.program.named_groups.iter().find(|(n, _)| n == name).map(|(_, ids)| ids.as_slice())
    }

    pub fn has_g_anchor(&self) -> bool {
        self.program.has_g_anchor
    }

    pub fn find(&self, haystack: &str) -> Result<Option<RegExpMatch>, ExecError> {
        self.search(haystack, 0, FindOption::NONE)
    }

    pub fn is_match(&self, haystack: &str) -> Result<bool, ExecError> {
        Ok(self.find(haystack)?.is_some())
    }

    pub fn search(&self, haystack: &str, start_byte: usize, options: FindOption) -> Result<Option<RegExpMatch>, ExecError> {
        self.search_range(haystack, start_byte, haystack.len(), options)
    }

    pub fn search_range(&self, haystack: &str, start_byte: usize, end_byte: usize, options: FindOption) -> Result<Option<RegExpMatch>, ExecError> {
        vm::search(&self.program, haystack, start_byte, end_byte, options, self.limits)
    }

    pub fn find_utf16(&self, haystack: &OnigString, start_utf16: usize, options: FindOption) -> Result<Option<RegExpMatch>, ExecError> {
        if start_utf16 > haystack.utf16_len() {
            return Ok(None);
        }
        let start_byte = haystack.utf16_to_utf8(start_utf16);
        let Some(mut m) = self.search(haystack.content(), start_byte, options)? else {
            return Ok(None);
        };
        for cap in m.captures.iter_mut().flatten() {
            cap.start = haystack.utf8_to_utf16(cap.start);
            cap.end = haystack.utf8_to_utf16(cap.end);
        }
        Ok(Some(m))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScannerMatch {
    /// Index of the winning pattern in `OnigScanner`.
    pub index: usize,
    /// Capture slots `0..=group_count` for the winning pattern.
    pub capture_indices: Vec<Option<CaptureIndex>>,
}

impl ScannerMatch {
    pub fn full(&self) -> CaptureIndex {
        self.capture_indices[0].expect("slot 0 always matched")
    }

    pub fn get(&self, group: usize) -> Option<CaptureIndex> {
        self.capture_indices.get(group).copied().flatten()
    }
}

#[derive(Debug, Clone, Default)]
struct PatternCacheEntry {
    string_id: u64,
    options: FindOption,
    last_position: usize,
    matched: Option<RegExpMatch>,
}

/// Per-line search cache for `OnigScanner`, mirroring `vscode-oniguruma`'s per-pattern cache.
#[derive(Debug, Clone)]
pub struct ScannerCache {
    entries: Vec<PatternCacheEntry>,
}

impl ScannerCache {
    pub fn new(pattern_count: usize) -> Self {
        Self {
            entries: vec![PatternCacheEntry::default(); pattern_count],
        }
    }

    pub fn clear(&mut self) {
        for entry in &mut self.entries {
            entry.string_id = 0;
            entry.matched = None;
        }
    }
}

#[derive(Debug, Clone)]
pub struct OnigScanner {
    regexes: Vec<OnigRegExp>,
    base_options: FindOption,
}

impl OnigScanner {
    pub fn new<S: AsRef<str>>(patterns: &[S]) -> Result<Self, CompileError> {
        Self::with_config(patterns, ScannerConfig::default())
    }

    pub fn with_config<S: AsRef<str>>(patterns: &[S], config: ScannerConfig) -> Result<Self, CompileError> {
        let mut regexes = Vec::with_capacity(patterns.len());
        for pat in patterns {
            let re = OnigRegExp::with_options(pat.as_ref(), config.options, config.syntax)?.with_limits(config.limits);
            regexes.push(re);
        }
        Ok(Self {
            regexes,
            base_options: config.options,
        })
    }

    pub fn len(&self) -> usize {
        self.regexes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.regexes.is_empty()
    }

    pub fn find_next_match(&self, haystack: &str, start_byte: usize, options: FindOption) -> Option<ScannerMatch> {
        if start_byte > haystack.len() {
            return None;
        }
        let start = snap_to_char_boundary(haystack, start_byte);
        let opts = self.base_options | options;
        let mut best: Option<(usize, usize, RegExpMatch)> = None;

        for (i, re) in self.regexes.iter().enumerate() {
            let Ok(Some(m)) = re.search(haystack, start, opts) else {
                continue;
            };
            let loc = m.start();
            if best.as_ref().is_none_or(|&(_, best_loc, _)| loc < best_loc) {
                best = Some((i, loc, m));
                if loc == start {
                    break;
                }
            }
        }

        best.map(|(index, _, m)| ScannerMatch {
            index,
            capture_indices: m.captures,
        })
    }

    pub fn try_find_next_match(&self, haystack: &str, start_byte: usize, options: FindOption) -> Result<Option<ScannerMatch>, ExecError> {
        if start_byte > haystack.len() {
            return Ok(None);
        }
        let start = snap_to_char_boundary(haystack, start_byte);
        let opts = self.base_options | options;
        let mut best: Option<(usize, usize, RegExpMatch)> = None;

        for (i, re) in self.regexes.iter().enumerate() {
            let Some(m) = re.search(haystack, start, opts)? else {
                continue;
            };
            let loc = m.start();
            if best.as_ref().is_none_or(|&(_, best_loc, _)| loc < best_loc) {
                best = Some((i, loc, m));
                if loc == start {
                    break;
                }
            }
        }

        Ok(best.map(|(index, _, m)| ScannerMatch {
            index,
            capture_indices: m.captures,
        }))
    }

    pub fn find_next_match_cached(&self, haystack: &OnigString, start_byte: usize, options: FindOption, cache: &mut ScannerCache) -> Option<ScannerMatch> {
        let content = haystack.content();
        if start_byte > content.len() {
            return None;
        }
        if cache.entries.len() < self.regexes.len() {
            cache.entries.resize(self.regexes.len(), PatternCacheEntry::default());
        }
        let start = snap_to_char_boundary(content, start_byte);
        let opts = self.base_options | options;
        let str_id = haystack.id();
        let mut best: Option<(usize, usize, RegExpMatch)> = None;

        for (i, re) in self.regexes.iter().enumerate() {
            let matched = if re.has_g_anchor() {
                re.search(content, start, opts).ok().flatten()
            } else {
                let entry = &mut cache.entries[i];
                let cache_valid = entry.string_id == str_id && entry.options == opts && entry.last_position <= start;
                if cache_valid {
                    match &entry.matched {
                        None => None,
                        Some(m) if m.start() >= start => Some(m.clone()),
                        Some(_) => {
                            let fresh = re.search(content, start, opts).ok().flatten();
                            entry.last_position = start;
                            entry.matched = fresh.clone();
                            fresh
                        }
                    }
                } else {
                    let fresh = re.search(content, start, opts).ok().flatten();
                    entry.string_id = str_id;
                    entry.options = opts;
                    entry.last_position = start;
                    entry.matched = fresh.clone();
                    fresh
                }
            };

            if let Some(m) = matched {
                let loc = m.start();
                if best.as_ref().is_none_or(|&(_, best_loc, _)| loc < best_loc) {
                    best = Some((i, loc, m));
                    if loc == start {
                        break;
                    }
                }
            }
        }

        best.map(|(index, _, m)| ScannerMatch {
            index,
            capture_indices: m.captures,
        })
    }

    pub fn find_next_match_utf16(&self, haystack: &OnigString, start_utf16: usize, options: FindOption) -> Option<ScannerMatch> {
        if start_utf16 > haystack.utf16_len() {
            return None;
        }
        let start_byte = haystack.utf16_to_utf8(start_utf16);
        let m = self.find_next_match(haystack.content(), start_byte, options)?;
        Some(convert_scanner_match_to_utf16(m, haystack))
    }

    pub fn try_find_next_match_utf16(&self, haystack: &OnigString, start_utf16: usize, options: FindOption) -> Result<Option<ScannerMatch>, ExecError> {
        if start_utf16 > haystack.utf16_len() {
            return Ok(None);
        }
        let start_byte = haystack.utf16_to_utf8(start_utf16);
        let Some(m) = self.try_find_next_match(haystack.content(), start_byte, options)? else {
            return Ok(None);
        };
        Ok(Some(convert_scanner_match_to_utf16(m, haystack)))
    }

    pub fn find_next_match_utf16_cached(
        &self,
        haystack: &OnigString,
        start_utf16: usize,
        options: FindOption,
        cache: &mut ScannerCache,
    ) -> Option<ScannerMatch> {
        if start_utf16 > haystack.utf16_len() {
            return None;
        }
        let start_byte = haystack.utf16_to_utf8(start_utf16);
        let m = self.find_next_match_cached(haystack, start_byte, options, cache)?;
        Some(convert_scanner_match_to_utf16(m, haystack))
    }
}

fn convert_scanner_match_to_utf16(mut m: ScannerMatch, haystack: &OnigString) -> ScannerMatch {
    for cap in m.capture_indices.iter_mut().flatten() {
        cap.start = haystack.utf8_to_utf16(cap.start);
        cap.end = haystack.utf8_to_utf16(cap.end);
    }
    m
}

fn snap_to_char_boundary(s: &str, mut pos: usize) -> usize {
    while pos > 0 && !s.is_char_boundary(pos) {
        pos -= 1;
    }
    pos
}
