pub use vibevalley_onig::{CaptureIndex, FindOption, OnigRegExp, OnigScanner, OnigString, ScannerCache, ScannerConfig, ScannerMatch};

use crate::error::RegexError;

/// Pre-indexed line string passed to `RegexScanner`.
///
/// Implemented directly for `vibevalley_onig::OnigString` (and `String` for custom engines).
pub trait RegexString: Send + Sync {
    fn content(&self) -> &str;
}

impl RegexString for OnigString {
    fn content(&self) -> &str {
        OnigString::content(self)
    }
}

impl RegexString for String {
    fn content(&self) -> &str {
        self.as_str()
    }
}

/// Multi-pattern regex scanner matching the earliest-starting pattern from `start_byte`
/// (breaking ties by earliest pattern index).
pub trait RegexScanner: Send + Sync {
    type String: RegexString;
    type Cache: Send;

    fn create_cache(&self) -> Self::Cache;

    fn find_next_match(&self, haystack: &Self::String, start_byte: usize, options: FindOption, cache: &mut Self::Cache) -> Option<ScannerMatch>;
}

/// Regex backend factory for `Registry`, `Grammar`, and `Highlighter`.
pub trait RegexEngine: Send + Sync {
    type String: RegexString;
    type Scanner: RegexScanner<String = Self::String>;

    fn create_scanner(&self, patterns: &[String]) -> Result<Self::Scanner, RegexError>;

    fn create_string(&self, content: String) -> Self::String;

    /// Whether `RegexScanner::find_next_match` natively honors `FindOption::NOT_BEGIN_STRING`
    /// and `FindOption::NOT_BEGIN_POSITION` (true for [`OnigEngine`]).
    ///
    /// When false, `Grammar` rewrites `\A` and `\G` anchors via `vscode-textmate`'s 4-slot
    /// anchor cache before compiling scanners.
    fn supports_find_options(&self) -> bool {
        false
    }
}

/// Pure-Rust Oniguruma `RegexEngine` powered by `vibevalley-onig`.
///
/// Natively enforces `FindOption::NOT_BEGIN_STRING` / `NOT_END_STRING` / `NOT_BEGIN_POSITION`
/// while preserving `^`/`$` line semantics, and reuses per-line [`ScannerCache`] slots across
/// repeated scans of the same line.
#[derive(Debug, Clone, Copy, Default)]
pub struct OnigEngine {
    config: ScannerConfig,
}

impl OnigEngine {
    pub fn with_config(config: ScannerConfig) -> Self {
        Self { config }
    }
}

impl RegexEngine for OnigEngine {
    type String = OnigString;
    type Scanner = OnigScannerAdapter;

    fn create_scanner(&self, patterns: &[String]) -> Result<Self::Scanner, RegexError> {
        let scanner = OnigScanner::with_config(patterns, self.config).map_err(|err| {
            // Identify the exact offending pattern on the cold error path.
            for (index, pat) in patterns.iter().enumerate() {
                if let Err(pat_err) = OnigRegExp::with_options(pat, self.config.options, self.config.syntax) {
                    return RegexError::Compile {
                        index,
                        pattern: pat.clone(),
                        message: pat_err.to_string(),
                    };
                }
            }
            RegexError::Compile {
                index: 0,
                pattern: patterns.first().cloned().unwrap_or_default(),
                message: err.to_string(),
            }
        })?;
        Ok(OnigScannerAdapter(scanner))
    }

    fn create_string(&self, content: String) -> Self::String {
        OnigString::new(content)
    }

    fn supports_find_options(&self) -> bool {
        true
    }
}

/// `RegexScanner` adapter wrapping `vibevalley_onig::OnigScanner` with zero-copy cached search.
#[derive(Debug, Clone)]
pub struct OnigScannerAdapter(OnigScanner);

impl RegexScanner for OnigScannerAdapter {
    type String = OnigString;
    type Cache = ScannerCache;

    fn create_cache(&self) -> Self::Cache {
        ScannerCache::new(self.0.len())
    }

    fn find_next_match(&self, haystack: &Self::String, start_byte: usize, options: FindOption, cache: &mut Self::Cache) -> Option<ScannerMatch> {
        self.0.find_next_match_cached(haystack, start_byte, options, cache)
    }
}
