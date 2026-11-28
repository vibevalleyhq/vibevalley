use std::collections::BTreeMap;
use std::ops::Range;
use std::time::Duration;

use rustc_hash::FxHashMap;

use crate::encoded_attrs::{FontStyle, StandardTokenType};
use crate::grammar::StateStack;
use crate::theme::{RawTheme, RawThemeSetting, ResolvedTheme, Rgba};

const PLAIN_LANGS: &[&str] = &["text", "txt", "plain", "plaintext"];

/// Returns true if `lang` is a plain-text language that bypasses grammar tokenization.
pub fn is_plain_lang(lang: &str) -> bool {
    let lower = lang.to_ascii_lowercase();
    lower.is_empty() || PLAIN_LANGS.contains(&lower.as_str())
}

/// Returns true if `theme` selects Shiki's unstyled `"none"` theme.
pub fn is_none_theme_name(name: &str) -> bool {
    name == "none"
}

/// Theme reference accepted by [`super::Highlighter`] APIs.
#[derive(Debug, Clone)]
pub enum ThemeInput {
    /// Name of a theme previously registered via `Highlighter::load_theme`, or `"none"`.
    Named(String),
    /// Inline theme object (e.g. from `create_css_variables_theme`).
    Inline(Box<RawTheme>),
    /// Explicitly unstyled `"none"` theme.
    None,
}

impl From<&str> for ThemeInput {
    fn from(name: &str) -> Self {
        if is_none_theme_name(name) {
            Self::None
        } else {
            Self::Named(name.to_string())
        }
    }
}

impl From<String> for ThemeInput {
    fn from(name: String) -> Self {
        if is_none_theme_name(&name) { Self::None } else { Self::Named(name) }
    }
}

impl From<RawTheme> for ThemeInput {
    fn from(theme: RawTheme) -> Self {
        Self::Inline(Box::new(theme))
    }
}

/// Default inline color behavior for multi-theme rendering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DefaultColor {
    /// Emit the named variant (default `"light"`) directly as inline `color`/`background-color`.
    Key(String),
    /// Emit CSS `light-dark(<light>, <dark>)` (requires both `"light"` and `"dark"` variants).
    LightDark,
    /// Emit all themes purely as CSS variables (`defaultColor: false`).
    None,
}

impl Default for DefaultColor {
    fn default() -> Self {
        Self::Key("light".to_string())
    }
}

/// Controls whether multi-theme CSS variables (`--shiki-<theme>`) are emitted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ColorsRendering {
    #[default]
    CssVars,
    None,
}

/// Single or multi-theme selection for [`HighlightOptions`].
#[derive(Debug, Clone)]
pub enum ThemeSelection {
    Single(ThemeInput),
    Multi {
        /// Ordered `(variant_key, theme)` list (insertion order matches JS object key order).
        themes: Vec<(String, ThemeInput)>,
        default_color: DefaultColor,
        css_variable_prefix: String,
        colors_rendering: ColorsRendering,
    },
}

impl ThemeSelection {
    pub fn single(theme: impl Into<ThemeInput>) -> Self {
        Self::Single(theme.into())
    }

    pub fn dual(light: impl Into<ThemeInput>, dark: impl Into<ThemeInput>) -> Self {
        Self::Multi {
            themes: vec![("light".to_string(), light.into()), ("dark".to_string(), dark.into())],
            default_color: DefaultColor::default(),
            css_variable_prefix: "--shiki-".to_string(),
            colors_rendering: ColorsRendering::CssVars,
        }
    }
}

/// Optional explanation detail attached to output tokens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ExplanationMode {
    #[default]
    Off,
    ScopeName,
    Full,
    TokenType,
}

/// Single ordered color replacement rule (flat global or scoped to a theme name).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ColorReplacement {
    Global { from: String, to: String },
    Scoped { theme: String, from: String, to: String },
}

/// Ordered list of color replacements matching Shiki's `colorReplacements` semantics.
#[derive(Debug, Clone, Default)]
pub struct ColorReplacements {
    pub entries: Vec<ColorReplacement>,
}

impl ColorReplacements {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_global(mut self, from: impl Into<String>, to: impl Into<String>) -> Self {
        self.entries.push(ColorReplacement::Global {
            from: from.into(),
            to: to.into(),
        });
        self
    }

    pub fn with_scoped(mut self, theme: impl Into<String>, from: impl Into<String>, to: impl Into<String>) -> Self {
        self.entries.push(ColorReplacement::Scoped {
            theme: theme.into(),
            from: from.into(),
            to: to.into(),
        });
        self
    }

    pub(super) fn resolve_for(&self, theme: &ResolvedTheme) -> FxHashMap<String, String> {
        let mut out: FxHashMap<String, String> = theme.color_replacements.iter().map(|(k, v)| (k.to_ascii_lowercase(), v.clone())).collect();
        for entry in &self.entries {
            match entry {
                ColorReplacement::Global { from, to } => {
                    out.insert(from.to_ascii_lowercase(), to.clone());
                }
                ColorReplacement::Scoped { theme: target, from, to } if target == &theme.name => {
                    out.insert(from.to_ascii_lowercase(), to.clone());
                }
                ColorReplacement::Scoped { .. } => {}
            }
        }
        out
    }
}

pub(super) fn apply_color_replacement(color: Option<&str>, map: &FxHashMap<String, String>) -> Option<String> {
    let raw = color?;
    if raw.is_empty() {
        return Some(String::new());
    }
    let key = raw.to_ascii_lowercase();
    Some(map.get(&key).cloned().unwrap_or_else(|| raw.to_string()))
}

/// Incremental grammar state across consecutive code snippets, matching Shiki's `GrammarState`.
#[derive(Debug, Clone)]
pub struct GrammarState {
    pub lang: String,
    stacks: BTreeMap<String, StateStack>,
}

impl GrammarState {
    pub fn new(lang: impl Into<String>, theme_name: impl Into<String>, stack: StateStack) -> Self {
        let mut stacks = BTreeMap::new();
        stacks.insert(theme_name.into(), stack);
        Self { lang: lang.into(), stacks }
    }

    pub fn from_map(lang: impl Into<String>, stacks: BTreeMap<String, StateStack>) -> Self {
        Self { lang: lang.into(), stacks }
    }

    pub fn themes(&self) -> Vec<&str> {
        self.stacks.keys().map(String::as_str).collect()
    }

    pub fn stack_for(&self, theme_name: &str) -> Option<&StateStack> {
        self.stacks.get(theme_name)
    }

    pub fn scopes(&self) -> Vec<String> {
        self.stacks
            .values()
            .next()
            .and_then(|s| s.content_name_scopes())
            .map(|sc| {
                let mut names = sc.scope_names();
                names.reverse();
                names
            })
            .unwrap_or_default()
    }
}

/// Options for [`super::Highlighter::code_to_tokens`].
#[derive(Debug, Clone)]
pub struct HighlightOptions {
    pub lang: String,
    pub theme: ThemeSelection,
    pub color_replacements: ColorReplacements,
    pub include_explanation: ExplanationMode,
    pub grammar_state: Option<GrammarState>,
    pub grammar_context_code: Option<String>,
    pub tokenize_max_line_length: usize,
    pub tokenize_time_limit: Option<Duration>,
}

impl HighlightOptions {
    pub fn single(lang: impl Into<String>, theme: impl Into<ThemeInput>) -> Self {
        Self {
            lang: lang.into(),
            theme: ThemeSelection::single(theme),
            color_replacements: ColorReplacements::default(),
            include_explanation: ExplanationMode::Off,
            grammar_state: None,
            grammar_context_code: None,
            tokenize_max_line_length: 0,
            tokenize_time_limit: Some(Duration::from_millis(500)),
        }
    }

    pub fn dual(lang: impl Into<String>, light: impl Into<ThemeInput>, dark: impl Into<ThemeInput>) -> Self {
        Self {
            lang: lang.into(),
            theme: ThemeSelection::dual(light, dark),
            color_replacements: ColorReplacements::default(),
            include_explanation: ExplanationMode::Off,
            grammar_state: None,
            grammar_context_code: None,
            tokenize_max_line_length: 0,
            tokenize_time_limit: Some(Duration::from_millis(500)),
        }
    }
}

/// Scope explanation entry attached when `include_explanation` is enabled.
#[derive(Debug, Clone, PartialEq)]
pub struct ThemedTokenScopeExplanation {
    pub scope_name: String,
    pub theme_matches: Vec<RawThemeSetting>,
}

/// Token-level scope explanation.
#[derive(Debug, Clone, PartialEq)]
pub struct ThemedTokenExplanation {
    pub content: String,
    pub scopes: Vec<ThemedTokenScopeExplanation>,
}

/// Resolved style fields for a single theme variant of a token.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TokenStyles {
    pub color: Option<String>,
    pub bg_color: Option<String>,
    pub font_style: Option<FontStyle>,
}

/// Output token produced by Shiki tokenization.
#[derive(Debug, Clone, PartialEq)]
pub struct ThemedToken {
    pub content: String,
    /// Byte offset of this token from the beginning of the input string.
    pub offset: usize,
    pub color: Option<String>,
    pub bg_color: Option<String>,
    pub font_style: Option<FontStyle>,
    pub token_type: Option<StandardTokenType>,
    /// Insertion-ordered CSS property pairs (`color`, `--shiki-dark`, `font-style`, ...).
    pub html_style: Option<Vec<(String, String)>>,
    pub explanation: Option<Vec<ThemedTokenExplanation>>,
}

/// Multi-theme aligned token carrying resolved styles for every theme variant.
#[derive(Debug, Clone, PartialEq)]
pub struct ThemedTokenWithVariants {
    pub content: String,
    pub offset: usize,
    pub variants: Vec<(String, TokenStyles)>,
    pub explanation: Option<Vec<ThemedTokenExplanation>>,
}

impl ThemedTokenWithVariants {
    pub fn variant(&self, key: &str) -> Option<&TokenStyles> {
        self.variants.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
}

/// High-level result returned by [`super::Highlighter::code_to_tokens`].
#[derive(Debug, Clone)]
pub struct TokensResult {
    pub tokens: Vec<Vec<ThemedToken>>,
    pub fg: String,
    pub bg: String,
    pub theme_name: String,
    pub root_style: Option<String>,
    pub grammar_state: Option<GrammarState>,
}

/// Compact per-line styled span tailored for VibeValley GPUI rendering (`apps/mac`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StyledSpan {
    /// UTF-8 byte range within the line.
    pub range: Range<usize>,
    pub fg: Option<Rgba>,
    pub bg: Option<Rgba>,
    pub font_style: FontStyle,
    pub token_type: StandardTokenType,
}

/// Whitespace merging mode for HTML rendering.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MergeWhitespaces {
    #[default]
    Always,
    Never,
    Preserve,
}

/// Root HTML layout structure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HtmlStructure {
    #[default]
    Classic,
    Inline,
}

/// Controls the `style` attribute on the outer `<pre>` element.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum RootStyleOption {
    #[default]
    Auto,
    Disabled,
    Custom(String),
}

/// Options for [`super::Highlighter::code_to_html`].
#[derive(Debug, Clone)]
pub struct HtmlOptions {
    pub highlight: HighlightOptions,
    pub structure: HtmlStructure,
    pub merge_whitespaces: MergeWhitespaces,
    pub merge_same_style_tokens: bool,
    pub tabindex: Option<String>,
    pub root_style: RootStyleOption,
}

impl HtmlOptions {
    pub fn new(highlight: HighlightOptions) -> Self {
        Self {
            highlight,
            structure: HtmlStructure::Classic,
            merge_whitespaces: MergeWhitespaces::Always,
            merge_same_style_tokens: false,
            tabindex: Some("0".to_string()),
            root_style: RootStyleOption::Auto,
        }
    }
}

/// Options for pure-Rust SVG code block rendering ([`super::Highlighter::code_to_svg`]).
#[derive(Debug, Clone)]
pub struct SvgOptions {
    pub highlight: HighlightOptions,
    pub font_family: String,
    pub font_size: f64,
    pub line_height: f64,
    pub padding_x: f64,
    pub padding_y: f64,
    pub border_radius: f64,
    pub char_width_ratio: f64,
}

impl SvgOptions {
    pub fn new(highlight: HighlightOptions) -> Self {
        Self {
            highlight,
            font_family: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace".to_string(),
            font_size: 14.0,
            line_height: 20.0,
            padding_x: 16.0,
            padding_y: 14.0,
            border_radius: 8.0,
            char_width_ratio: 0.6,
        }
    }
}
