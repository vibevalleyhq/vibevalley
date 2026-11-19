//! Pure-Rust TextMate grammar (`vscode-textmate`) and Shiki syntax highlighting engine.
//!
//! Built completely in pure Rust with no JavaScript/WASM runtime and no C FFI.
//! Powered by [`OnigEngine`] (`vibevalley-onig`) by default and pluggable over any
//! [`RegexEngine`] implementation.

pub mod encoded_attrs;
pub mod error;
pub mod grammar;
pub mod highlighter;
mod jsonc;
pub mod matcher;
mod plist;
pub mod raw_grammar;
pub mod regex_engine;
pub mod registry;
pub mod rule;
pub mod theme;

pub use encoded_attrs::{EncodedTokenAttributes, FontAttribute, FontStyle, OptionalStandardTokenType, StandardTokenType};
pub use error::{RegexError, ShikiError};
pub use grammar::{
    AttributedScopeStack, BalancedBracketSelectors, BasicScopeAttributes, BasicScopeAttributesProvider, EmbeddedLanguagesMap, FontInfo, Grammar,
    GrammarConfiguration, StateStack, Token, TokenTypeMap, TokenizeLineResult, TokenizeLineResult2,
};
pub use highlighter::{
    ColorReplacement, ColorReplacements, ColorsRendering, DefaultColor, ExplanationMode, GrammarState, HighlightOptions, Highlighter, HtmlOptions,
    HtmlStructure, MergeWhitespaces, RootStyleOption, StyledSpan, SvgOptions, ThemeInput, ThemeSelection, ThemedToken, ThemedTokenExplanation,
    ThemedTokenScopeExplanation, ThemedTokenWithVariants, TokenStyles, TokensResult, align_themes_tokenization, flat_token_variants, is_none_theme_name,
    is_plain_lang, split_lines, token_style_entries,
};
pub use matcher::{InjectionPriority, MatcherWithPriority, SelectorExpr, create_matchers, name_matcher};
pub use raw_grammar::{RawGrammar, RawRule, parse_grammar_json, parse_grammar_plist, parse_raw_grammar};
pub use regex_engine::{
    CaptureIndex, FindOption, OnigEngine, OnigScanner, OnigScannerAdapter, OnigString, RegexEngine, RegexScanner, RegexString, ScannerCache, ScannerConfig,
    ScannerMatch,
};
pub use registry::{FnGrammarLoader, GrammarLoader, Registry};
pub use rule::{MatchTarget, RuleId};
pub use theme::{
    ColorMap, CssVariablesThemeOptions, ParsedThemeRule, RawTheme, RawThemeSetting, RawTokenSettings, ResolvedTheme, Rgba, ScopePatternList, ScopeStack,
    SemanticTokenStyle, StyleAttributes, Theme, ThemeTrieElement, ThemeTrieElementRule, ThemeType, create_css_variables_theme, is_valid_hex_color,
    load_theme_from_file, normalize_theme, parse_raw_theme, parse_theme, parse_theme_json, parse_theme_plist, resolve_theme_includes, str_slice_cmp,
};
