use std::collections::{BTreeMap, HashSet};
use std::ops::Range;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use rustc_hash::FxHashMap;

use crate::encoded_attrs::{EncodedTokenAttributes, FontStyle, OptionalStandardTokenType, StandardTokenType};
use crate::error::ShikiError;
use crate::grammar::{Grammar, StateStack};
use crate::raw_grammar::{RawGrammar, parse_grammar_json, parse_grammar_plist};
use crate::regex_engine::{FancyRegexEngine, RegexEngine};
use crate::registry::Registry;
use crate::theme::{
    RawTheme, RawThemeSetting, ResolvedTheme, Rgba, ScopePatternList, ScopeStack, Theme, load_theme_from_file, normalize_theme, parse_theme_json,
    parse_theme_plist,
};

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

/// Theme reference accepted by [`Highlighter`] APIs.
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

    fn resolve_for(&self, theme: &ResolvedTheme) -> FxHashMap<String, String> {
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

fn apply_color_replacement(color: Option<&str>, map: &FxHashMap<String, String>) -> Option<String> {
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

/// Options for [`Highlighter::code_to_tokens`].
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

/// High-level result returned by [`Highlighter::code_to_tokens`].
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

/// Options for [`Highlighter::code_to_html`].
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

/// Options for pure-Rust SVG code block rendering ([`Highlighter::code_to_svg`]).
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

struct LoadedTheme {
    resolved: ResolvedTheme,
    compiled: Arc<Theme>,
}

struct LoadedLanguage<E: RegexEngine> {
    name: String,
    grammar: Arc<Grammar<E>>,
}

/// High-level Shiki highlighting engine supporting multiple grammars, themes, aliases,
/// injections, dual/multi-theme CSS variables, GPUI spans, HTML, and SVG output.
pub struct Highlighter<E: RegexEngine = FancyRegexEngine> {
    registry: Registry<E>,
    languages: BTreeMap<String, LoadedLanguage<E>>,
    lang_aliases: BTreeMap<String, String>,
    scope_to_lang: BTreeMap<String, String>,
    themes: BTreeMap<String, LoadedTheme>,
    theme_order: Vec<String>,
}

impl Highlighter<FancyRegexEngine> {
    /// Creates a highlighter backed by the built-in pure-Rust `FancyRegexEngine`.
    pub fn with_default_engine() -> Self {
        Self::new(FancyRegexEngine)
    }
}

impl<E: RegexEngine> Highlighter<E> {
    pub fn new(engine: E) -> Self {
        Self {
            registry: Registry::new(engine),
            languages: BTreeMap::new(),
            lang_aliases: default_lang_aliases(),
            scope_to_lang: BTreeMap::new(),
            themes: BTreeMap::new(),
            theme_order: Vec::new(),
        }
    }

    pub fn registry(&self) -> &Registry<E> {
        &self.registry
    }

    pub fn registry_mut(&mut self) -> &mut Registry<E> {
        &mut self.registry
    }

    /// Registers a language alias (e.g. `"rs"` -> `"rust"`, `"js"` -> `"javascript"`).
    pub fn register_lang_alias(&mut self, alias: impl Into<String>, target: impl Into<String>) {
        self.lang_aliases.insert(alias.into().to_ascii_lowercase(), target.into().to_ascii_lowercase());
    }

    pub fn resolve_lang_alias(&self, lang: &str) -> String {
        let mut current = lang.trim().to_ascii_lowercase();
        let mut seen = HashSet::new();
        while let Some(next) = self.lang_aliases.get(&current) {
            if !seen.insert(current.clone()) {
                break;
            }
            current = next.clone();
        }
        current
    }

    /// Registers a raw grammar and wires any `inject_to` targets declared in it.
    pub fn register_raw_grammar(&mut self, raw: RawGrammar, aliases: &[&str]) {
        let canonical = raw.name.as_deref().filter(|n| !n.is_empty()).unwrap_or(&raw.scope_name).to_ascii_lowercase();
        let scope_name = raw.scope_name.clone();

        let affected_targets = raw.inject_to.clone();
        for target in &affected_targets {
            self.registry.register_injection(target.clone(), scope_name.clone());
        }
        self.registry.register_grammar(raw, Vec::new());
        self.scope_to_lang.insert(scope_name, canonical.clone());
        for &alias in aliases {
            self.register_lang_alias(alias, canonical.clone());
        }
        self.languages.remove(&canonical);
        for target in &affected_targets {
            if let Some(target_lang) = self.scope_to_lang.get(target).cloned() {
                self.languages.remove(&target_lang);
            }
        }
    }

    /// Loads and compiles a TextMate grammar into this highlighter (recompiling any
    /// already-loaded target grammars affected by its `inject_to` declarations).
    pub fn load_grammar(&mut self, raw: RawGrammar) -> Result<String, ShikiError> {
        self.load_grammar_with_aliases(raw, &[])
    }

    /// Loads and compiles a grammar along with convenience aliases (e.g. `&["js"]`).
    pub fn load_grammar_with_aliases(&mut self, raw: RawGrammar, aliases: &[&str]) -> Result<String, ShikiError> {
        let canonical = raw.name.as_deref().filter(|n| !n.is_empty()).unwrap_or(&raw.scope_name).to_ascii_lowercase();
        let scope_name = raw.scope_name.clone();
        let inject_targets = raw.inject_to.clone();
        self.register_raw_grammar(raw, aliases);
        self.compile_registered_grammar(&canonical, &scope_name)?;
        for target in &inject_targets {
            if let Some(target_lang) = self.scope_to_lang.get(target).cloned() {
                self.compile_registered_grammar(&target_lang, target)?;
            }
        }
        Ok(canonical)
    }

    pub fn load_grammar_json(&mut self, json: &str, aliases: &[&str]) -> Result<String, ShikiError> {
        let raw = parse_grammar_json(json)?;
        self.load_grammar_with_aliases(raw, aliases)
    }

    pub fn load_grammar_plist(&mut self, xml: &str, aliases: &[&str]) -> Result<String, ShikiError> {
        let raw = parse_grammar_plist(xml)?;
        self.load_grammar_with_aliases(raw, aliases)
    }

    /// Registers an injection grammar scope against `target_scope` and recompiles affected grammars.
    pub fn register_injection(&mut self, target_scope: &str, injection_scope: &str) {
        self.registry.register_injection(target_scope.to_string(), injection_scope.to_string());
        self.languages.clear();
    }

    /// Compiles all registered grammars (useful after batch-registering interdependent grammars).
    pub fn compile_all_grammars(&mut self) -> Result<(), ShikiError> {
        let pairs: Vec<(String, String)> = self.scope_to_lang.iter().map(|(scope, lang)| (lang.clone(), scope.clone())).collect();
        for (lang, scope) in pairs {
            self.compile_registered_grammar(&lang, &scope)?;
        }
        Ok(())
    }

    fn compile_registered_grammar(&mut self, canonical: &str, scope_name: &str) -> Result<(), ShikiError> {
        let grammar = self.registry.load_grammar(scope_name)?;
        self.languages.insert(
            canonical.to_string(),
            LoadedLanguage {
                name: canonical.to_string(),
                grammar,
            },
        );
        Ok(())
    }

    /// Normalizes, compiles, and registers a theme.
    pub fn load_theme(&mut self, raw: RawTheme) -> String {
        let resolved = normalize_theme(&raw);
        let name = resolved.name.clone();
        let compiled = Arc::new(resolved.compile());
        if !self.themes.contains_key(&name) {
            self.theme_order.push(name.clone());
        }
        self.themes.insert(name.clone(), LoadedTheme { resolved, compiled });
        name
    }

    pub fn load_theme_json(&mut self, json: &str) -> Result<String, ShikiError> {
        let raw = parse_theme_json(json)?;
        Ok(self.load_theme(raw))
    }

    pub fn load_theme_plist(&mut self, xml: &str) -> Result<String, ShikiError> {
        let raw = parse_theme_plist(xml)?;
        Ok(self.load_theme(raw))
    }

    pub fn load_theme_file(&mut self, path: &Path) -> Result<String, ShikiError> {
        let raw = load_theme_from_file(path)?;
        Ok(self.load_theme(raw))
    }

    pub fn loaded_themes(&self) -> &[String] {
        &self.theme_order
    }

    pub fn loaded_languages(&self) -> Vec<&str> {
        self.languages.keys().map(String::as_str).collect()
    }

    pub fn get_theme(&self, name: &str) -> Option<&ResolvedTheme> {
        self.themes.get(name).map(|t| &t.resolved)
    }

    fn resolve_theme_input(&self, input: &ThemeInput) -> Result<Option<(ResolvedTheme, Arc<Theme>)>, ShikiError> {
        match input {
            ThemeInput::None => Ok(None),
            ThemeInput::Named(name) if is_none_theme_name(name) => Ok(None),
            ThemeInput::Named(name) => {
                let loaded = self.themes.get(name).ok_or_else(|| ShikiError::MissingTheme(name.clone()))?;
                Ok(Some((loaded.resolved.clone(), Arc::clone(&loaded.compiled))))
            }
            ThemeInput::Inline(raw) => {
                let resolved = normalize_theme(raw);
                let compiled = Arc::new(resolved.compile());
                Ok(Some((resolved, compiled)))
            }
        }
    }

    fn lookup_language(&self, lang: &str) -> Result<&LoadedLanguage<E>, ShikiError> {
        let resolved = self.resolve_lang_alias(lang);
        if let Some(loaded) = self.languages.get(&resolved) {
            return Ok(loaded);
        }
        if let Some(canonical) = self.scope_to_lang.get(lang)
            && let Some(loaded) = self.languages.get(canonical)
        {
            return Ok(loaded);
        }
        Err(ShikiError::MissingLanguage(lang.to_string()))
    }

    /// Low-level single-theme tokenization returning tokens + ending `GrammarState`.
    pub fn code_to_tokens_base(
        &self,
        code: &str,
        lang: &str,
        theme: &ThemeInput,
        options: &HighlightOptions,
    ) -> Result<(Vec<Vec<ThemedToken>>, Option<GrammarState>), ShikiError> {
        let resolved_lang = self.resolve_lang_alias(lang);
        if is_plain_lang(&resolved_lang) {
            let tokens = split_lines(code).into_iter().map(|(line, offset)| vec![plain_token(line, offset)]).collect();
            return Ok((tokens, None));
        }

        let Some((resolved_theme, compiled_theme)) = self.resolve_theme_input(theme)? else {
            let tokens = split_lines(code).into_iter().map(|(line, offset)| vec![plain_token(line, offset)]).collect();
            return Ok((tokens, None));
        };

        let language = self.lookup_language(&resolved_lang)?;
        if let Some(gs) = &options.grammar_state {
            if gs.lang != language.name {
                return Err(ShikiError::GrammarStateMismatch(format!(
                    "Grammar state language \"{}\" does not match highlight language \"{}\"",
                    gs.lang, language.name
                )));
            }
            if gs.stack_for(&resolved_theme.name).is_none() {
                return Err(ShikiError::GrammarStateMismatch(format!(
                    "Grammar state themes {:?} do not contain highlight theme \"{}\"",
                    gs.themes(),
                    resolved_theme.name
                )));
            }
        }

        let (tokens, stack) = tokenize_with_single_theme(code, &language.grammar, &resolved_theme, &compiled_theme, options)?;
        let grammar_state = GrammarState::new(language.name.clone(), resolved_theme.name.clone(), stack);
        Ok((tokens, Some(grammar_state)))
    }

    /// Tokenizes `code` across multiple themes and aligns token boundaries so every variant
    /// shares identical token spans. Uses single-scan tokenization when possible.
    pub fn code_to_tokens_with_themes(
        &self,
        code: &str,
        lang: &str,
        themes: &[(String, ThemeInput)],
        options: &HighlightOptions,
    ) -> Result<(Vec<Vec<ThemedTokenWithVariants>>, Option<GrammarState>), ShikiError> {
        if themes.is_empty() {
            return Err(ShikiError::InvalidOptions("`themes` option must not be empty".to_string()));
        }

        let single_scan = if themes.len() > 1 {
            self.try_tokenize_multi_single_scan(code, lang, themes, options)?
        } else {
            None
        };

        let mut per_theme_tokens: Vec<Vec<Vec<ThemedToken>>> = Vec::with_capacity(themes.len());
        let mut per_theme_states: Vec<(String, Option<GrammarState>)> = Vec::with_capacity(themes.len());

        if let Some(scanned) = single_scan {
            for ((_key, _input), (tokens, state, theme_name)) in themes.iter().zip(scanned) {
                per_theme_tokens.push(tokens);
                per_theme_states.push((theme_name, Some(state)));
            }
        } else {
            for (_key, theme_input) in themes {
                let theme_name = match theme_input {
                    ThemeInput::Named(n) => n.clone(),
                    ThemeInput::Inline(r) => r.name.clone().unwrap_or_default(),
                    ThemeInput::None => "none".to_string(),
                };
                let (tokens, state) = self.code_to_tokens_base(code, lang, theme_input, options)?;
                per_theme_tokens.push(tokens);
                per_theme_states.push((theme_name, state));
            }
        }

        let aligned = align_themes_tokenization(&per_theme_tokens);
        let Some(first_theme_lines) = aligned.first() else {
            return Ok((Vec::new(), None));
        };
        let mut merged_lines = Vec::with_capacity(first_theme_lines.len());

        for (line_idx, first_line) in first_theme_lines.iter().enumerate() {
            let mut merged_line = Vec::with_capacity(first_line.len());
            for (tok_idx, first) in first_line.iter().enumerate() {
                let mut variants = Vec::with_capacity(themes.len());
                for (theme_idx, (color_key, _)) in themes.iter().enumerate() {
                    let tok = &aligned[theme_idx][line_idx][tok_idx];
                    variants.push((
                        color_key.clone(),
                        TokenStyles {
                            color: tok.color.clone(),
                            bg_color: tok.bg_color.clone(),
                            font_style: tok.font_style,
                        },
                    ));
                }
                merged_line.push(ThemedTokenWithVariants {
                    content: first.content.clone(),
                    offset: first.offset,
                    variants,
                    explanation: if options.include_explanation != ExplanationMode::Off {
                        first.explanation.clone()
                    } else {
                        None
                    },
                });
            }
            merged_lines.push(merged_line);
        }

        let merged_state = if let Some(first_lang) = per_theme_states.iter().find_map(|(_, st)| st.as_ref().map(|s| s.lang.clone())) {
            let mut map = BTreeMap::new();
            for (theme_name, st_opt) in per_theme_states {
                if let Some(st) = st_opt
                    && let Some(stack) = st.stack_for(&theme_name)
                {
                    map.insert(theme_name, stack.clone());
                }
            }
            if map.is_empty() {
                None
            } else {
                Some(GrammarState::from_map(first_lang, map))
            }
        } else {
            None
        };

        Ok((merged_lines, merged_state))
    }

    /// High-level Shiki `codeToTokens` supporting both single-theme and dual/multi-theme modes.
    pub fn code_to_tokens(&self, code: &str, options: &HighlightOptions) -> Result<TokensResult, ShikiError> {
        match &options.theme {
            ThemeSelection::Single(theme_input) => {
                let (tokens, grammar_state) = self.code_to_tokens_base(code, &options.lang, theme_input, options)?;
                let (fg, bg, theme_name) = match self.resolve_theme_input(theme_input)? {
                    Some((resolved, _)) => {
                        let repl = options.color_replacements.resolve_for(&resolved);
                        let fg = apply_color_replacement(Some(&resolved.fg), &repl).unwrap_or_default();
                        let bg = apply_color_replacement(Some(&resolved.bg), &repl).unwrap_or_default();
                        (fg, bg, resolved.name)
                    }
                    None => (String::new(), String::new(), "none".to_string()),
                };
                Ok(TokensResult {
                    tokens,
                    fg,
                    bg,
                    theme_name,
                    root_style: None,
                    grammar_state,
                })
            }
            ThemeSelection::Multi {
                themes,
                default_color,
                css_variable_prefix,
                colors_rendering,
            } => {
                if themes.is_empty() {
                    return Err(ShikiError::InvalidOptions("`themes` option must not be empty".to_string()));
                }

                let mut ordered = themes.clone();
                if let DefaultColor::Key(default_key) = default_color {
                    if !ordered.iter().any(|(k, _)| k == default_key) {
                        return Err(ShikiError::InvalidOptions(format!(
                            "`themes` option must contain the defaultColor key `{default_key}`"
                        )));
                    }
                    if let Some(pos) = ordered.iter().position(|(k, _)| k == default_key)
                        && pos > 0
                    {
                        let item = ordered.remove(pos);
                        ordered.insert(0, item);
                    }
                } else if *default_color == DefaultColor::LightDark
                    && ordered.len() > 1
                    && (!ordered.iter().any(|(k, _)| k == "light") || !ordered.iter().any(|(k, _)| k == "dark"))
                {
                    return Err(ShikiError::InvalidOptions(
                        "When using `defaultColor: \"light-dark()\"`, you must provide both `light` and `dark` themes".to_string(),
                    ));
                }

                let (variant_tokens, grammar_state) = self.code_to_tokens_with_themes(code, &options.lang, &ordered, options)?;

                let resolved_themes: Vec<Option<ResolvedTheme>> = ordered
                    .iter()
                    .map(|(_, input)| Ok(self.resolve_theme_input(input)?.map(|(r, _)| r)))
                    .collect::<Result<_, ShikiError>>()?;

                let variants_order: Vec<String> = ordered.iter().map(|(k, _)| k.clone()).collect();
                let tokens: Vec<Vec<ThemedToken>> = variant_tokens
                    .into_iter()
                    .map(|line| {
                        line.into_iter()
                            .map(|tok| flat_token_variants(&tok, &variants_order, css_variable_prefix, default_color, *colors_rendering))
                            .collect()
                    })
                    .collect();

                let replacements: Vec<FxHashMap<String, String>> = resolved_themes
                    .iter()
                    .map(|t| t.as_ref().map(|r| options.color_replacements.resolve_for(r)).unwrap_or_default())
                    .collect();

                let fg = map_theme_colors(
                    &variants_order,
                    &resolved_themes,
                    &replacements,
                    css_variable_prefix,
                    default_color,
                    false,
                    *colors_rendering,
                )?;
                let bg = map_theme_colors(
                    &variants_order,
                    &resolved_themes,
                    &replacements,
                    css_variable_prefix,
                    default_color,
                    true,
                    *colors_rendering,
                )?;

                let names: Vec<&str> = resolved_themes.iter().map(|t| t.as_ref().map_or("none", |r| r.name.as_str())).collect();
                let theme_name = format!("shiki-themes {}", names.join(" "));
                let root_style = if *default_color == DefaultColor::None {
                    Some(format!("{fg};{bg}"))
                } else {
                    None
                };

                Ok(TokensResult {
                    tokens,
                    fg,
                    bg,
                    theme_name,
                    root_style,
                    grammar_state,
                })
            }
        }
    }

    /// Produces GPUI-ready per-line [`StyledSpan`]s with UTF-8 byte ranges and parsed [`Rgba`] colors.
    pub fn code_to_spans(&self, code: &str, lang: &str, theme: impl Into<ThemeInput>) -> Result<Vec<Vec<StyledSpan>>, ShikiError> {
        let mut opts = HighlightOptions::single(lang, theme);
        opts.include_explanation = ExplanationMode::TokenType;
        let result = self.code_to_tokens(code, &opts)?;
        let lines = split_lines(code);
        let mut out = Vec::with_capacity(result.tokens.len());

        for (line_idx, tokens) in result.tokens.into_iter().enumerate() {
            let line_offset = lines.get(line_idx).map_or(0, |&(_, off)| off);
            let mut spans = Vec::with_capacity(tokens.len());
            for tok in tokens {
                if tok.content.is_empty() {
                    continue;
                }
                let start = tok.offset.saturating_sub(line_offset);
                let end = start + tok.content.len();
                spans.push(StyledSpan {
                    range: start..end,
                    fg: tok.color.as_deref().and_then(Rgba::from_hex),
                    bg: tok.bg_color.as_deref().and_then(Rgba::from_hex),
                    font_style: tok.font_style.unwrap_or(FontStyle::NONE),
                    token_type: tok.token_type.unwrap_or(StandardTokenType::Other),
                });
            }
            out.push(spans);
        }

        Ok(out)
    }

    /// Computes only the final [`GrammarState`] for `code` (useful for stateful multi-block highlighting).
    pub fn get_last_grammar_state(&self, code: &str, options: &HighlightOptions) -> Result<GrammarState, ShikiError> {
        let res = self.code_to_tokens(code, options)?;
        res.grammar_state
            .ok_or_else(|| ShikiError::InvalidOptions("Plain language or `none` theme does not have grammar state".to_string()))
    }

    /// Renders `code` into Shiki-compatible HTML (`<pre class="shiki ..."><code>...</code></pre>`).
    pub fn code_to_html(&self, code: &str, options: &HtmlOptions) -> Result<String, ShikiError> {
        let mut result = self.code_to_tokens(code, &options.highlight)?;
        match options.merge_whitespaces {
            MergeWhitespaces::Always => result.tokens = merge_whitespace_tokens(result.tokens),
            MergeWhitespaces::Never => result.tokens = split_whitespace_tokens(result.tokens),
            MergeWhitespaces::Preserve => {}
        }
        if options.merge_same_style_tokens {
            result.tokens = merge_adjacent_styled_tokens(result.tokens);
        }
        Ok(render_tokens_to_html(&result, options))
    }

    /// Renders `code` into a pure-Rust SVG code block using `<rect>` + `<text>`/`<tspan>` (no `<foreignObject>`).
    pub fn code_to_svg(&self, code: &str, options: &SvgOptions) -> Result<String, ShikiError> {
        let result = self.code_to_tokens(code, &options.highlight)?;
        Ok(render_tokens_to_svg(&result, options))
    }

    /// Single-scan multi-theme optimization matching Shiki's `tokenizeWithThemes`.
    #[allow(clippy::type_complexity)]
    fn try_tokenize_multi_single_scan(
        &self,
        code: &str,
        lang: &str,
        themes: &[(String, ThemeInput)],
        options: &HighlightOptions,
    ) -> Result<Option<Vec<(Vec<Vec<ThemedToken>>, GrammarState, String)>>, ShikiError> {
        let resolved_lang = self.resolve_lang_alias(lang);
        if is_plain_lang(&resolved_lang) || options.include_explanation != ExplanationMode::Off {
            return Ok(None);
        }

        let mut loaded_themes = Vec::with_capacity(themes.len());
        for (_, input) in themes {
            let Some(pair) = self.resolve_theme_input(input)? else {
                return Ok(None);
            };
            loaded_themes.push(pair);
        }

        let language = self.lookup_language(&resolved_lang)?;
        if language.grammar.has_token_type_overrides() {
            return Ok(None);
        }

        if let Some(gs) = &options.grammar_state
            && (gs.lang != language.name || !loaded_themes.iter().all(|(r, _)| gs.stack_for(&r.name).is_some()))
        {
            return Ok(None);
        }

        let max_len = options.tokenize_max_line_length;
        let lines = split_lines(code);
        let context_lines = if options.grammar_state.is_none() {
            options.grammar_context_code.as_deref().map(split_lines).unwrap_or_default()
        } else {
            Vec::new()
        };

        let first_theme = &loaded_themes[0];
        let mut stack = if let Some(gs) = &options.grammar_state {
            gs.stack_for(&first_theme.0.name).cloned().unwrap_or_else(StateStack::initial)
        } else if !context_lines.is_empty() {
            let mut s = StateStack::initial();
            for (ctx_line, _) in &context_lines {
                if ctx_line.is_empty() || (max_len > 0 && ctx_line.len() >= max_len) {
                    continue;
                }
                let res = language
                    .grammar
                    .tokenize_line_with_theme(ctx_line, Some(&s), &first_theme.1, options.tokenize_time_limit)?;
                s = res.rule_stack;
            }
            s
        } else {
            StateStack::initial()
        };

        // Single grammar scan collecting raw scope tokens once for all themes.
        let mut scanned_lines: Vec<Option<Vec<(usize, Vec<String>)>>> = Vec::with_capacity(lines.len());
        for (line, _) in &lines {
            if line.is_empty() || (max_len > 0 && line.len() >= max_len) {
                scanned_lines.push(None);
                continue;
            }
            let res = language
                .grammar
                .tokenize_line_with_theme(line, Some(&stack), &first_theme.1, options.tokenize_time_limit)?;
            let line_tokens = res.tokens.into_iter().map(|t| (t.start_index, t.scopes)).collect();
            scanned_lines.push(Some(line_tokens));
            stack = res.rule_stack;
        }

        let brackets = language.grammar.balanced_bracket_selectors();
        let default_lang_id = language.grammar.default_basic_attributes().language_id;

        let mut outputs = Vec::with_capacity(loaded_themes.len());
        for (theme_idx, (resolved_theme, compiled_theme)) in loaded_themes.iter().enumerate() {
            let color_map = compiled_theme.color_map();
            let repl = options.color_replacements.resolve_for(resolved_theme);
            let defaults = compiled_theme.defaults();
            let root_attrs = EncodedTokenAttributes::default().set(
                default_lang_id,
                OptionalStandardTokenType::NotSet,
                None,
                defaults.font_style,
                defaults.foreground_id,
                defaults.background_id,
            );

            let mut scope_attr_cache: FxHashMap<Vec<String>, u32> = FxHashMap::default();
            let mut themed_lines = Vec::with_capacity(lines.len());

            for (i, (line, line_offset)) in lines.iter().enumerate() {
                let Some(line_tokens) = &scanned_lines[i] else {
                    if line.is_empty() {
                        themed_lines.push(Vec::new());
                    } else {
                        themed_lines.push(vec![ThemedToken {
                            content: (*line).to_string(),
                            offset: *line_offset,
                            color: Some(String::new()),
                            bg_color: None,
                            font_style: Some(FontStyle::NONE),
                            token_type: None,
                            html_style: None,
                            explanation: None,
                        }]);
                    }
                    continue;
                };

                let mut actual = Vec::new();
                let mut cur_start: Option<usize> = None;
                let mut cur_meta: u32 = 0;

                for (start_index, scopes) in line_tokens {
                    let meta = *scope_attr_cache.entry(scopes.clone()).or_insert_with(|| {
                        let mut attrs = root_attrs;
                        let mut path: Option<ScopeStack> = None;
                        for scope in scopes {
                            let basic = language.grammar.metadata_for_scope(scope);
                            path = Some(ScopeStack::new(path, scope.clone()));
                            let style = compiled_theme.match_scope(path.as_ref());
                            let (fs, fg, bg) = match style {
                                Some(st) => (st.font_style, st.foreground_id, st.background_id),
                                None => (FontStyle::NOT_SET, 0, 0),
                            };
                            attrs = attrs.set(basic.language_id, basic.token_type, None, fs, fg, bg);
                        }
                        if brackets.is_some_and(|b| b.matches_always() || b.matches(scopes)) {
                            attrs = attrs.set(0, OptionalStandardTokenType::NotSet, Some(true), FontStyle::NOT_SET, 0, 0);
                        }
                        attrs.to_raw()
                    });

                    if let Some(prev_start) = cur_start {
                        if meta == cur_meta {
                            continue;
                        }
                        if prev_start < *start_index {
                            actual.push(token_from_meta(
                                line,
                                *line_offset,
                                prev_start,
                                *start_index,
                                EncodedTokenAttributes(cur_meta),
                                color_map,
                                &repl,
                            ));
                        }
                    }
                    cur_start = Some(*start_index);
                    cur_meta = meta;
                }

                if let Some(prev_start) = cur_start
                    && prev_start < line.len()
                {
                    actual.push(token_from_meta(
                        line,
                        *line_offset,
                        prev_start,
                        line.len(),
                        EncodedTokenAttributes(cur_meta),
                        color_map,
                        &repl,
                    ));
                }
                themed_lines.push(actual);
            }

            let theme_stack = if theme_idx == 0 {
                stack.clone()
            } else {
                stack.restack_for_theme(&language.grammar, compiled_theme)
            };
            let state = GrammarState::new(language.name.clone(), resolved_theme.name.clone(), theme_stack);
            outputs.push((themed_lines, state, resolved_theme.name.clone()));
        }

        Ok(Some(outputs))
    }
}

fn plain_token(line: &str, offset: usize) -> ThemedToken {
    ThemedToken {
        content: line.to_string(),
        offset,
        color: None,
        bg_color: None,
        font_style: None,
        token_type: None,
        html_style: None,
        explanation: None,
    }
}

fn token_from_meta(
    line: &str,
    line_offset: usize,
    start: usize,
    end: usize,
    attrs: EncodedTokenAttributes,
    color_map: &[String],
    repl: &FxHashMap<String, String>,
) -> ThemedToken {
    let fg_raw = color_map.get(attrs.foreground() as usize).map(String::as_str);
    let color = apply_color_replacement(fg_raw, repl);
    ThemedToken {
        content: line[start..end].to_string(),
        offset: line_offset + start,
        color,
        bg_color: None,
        font_style: Some(attrs.font_style()),
        token_type: None,
        html_style: None,
        explanation: None,
    }
}

fn tokenize_with_single_theme<E: RegexEngine>(
    code: &str,
    grammar: &Grammar<E>,
    resolved_theme: &ResolvedTheme,
    compiled_theme: &Theme,
    options: &HighlightOptions,
) -> Result<(Vec<Vec<ThemedToken>>, StateStack), ShikiError> {
    let repl = options.color_replacements.resolve_for(resolved_theme);
    let color_map = compiled_theme.color_map();
    let lines = split_lines(code);

    let mut state_stack = if let Some(gs) = &options.grammar_state {
        gs.stack_for(&resolved_theme.name).cloned().unwrap_or_else(StateStack::initial)
    } else if let Some(ctx_code) = &options.grammar_context_code {
        let mut ctx_opts = options.clone();
        ctx_opts.grammar_state = None;
        ctx_opts.grammar_context_code = None;
        tokenize_with_single_theme(ctx_code, grammar, resolved_theme, compiled_theme, &ctx_opts)?.1
    } else {
        StateStack::initial()
    };

    let theme_selectors = if options.include_explanation == ExplanationMode::Full {
        build_theme_settings_selectors(&resolved_theme.settings)
    } else {
        Vec::new()
    };

    let mut final_lines = Vec::with_capacity(lines.len());

    for (line, line_offset) in lines {
        if line.is_empty() {
            final_lines.push(Vec::new());
            continue;
        }
        if options.tokenize_max_line_length > 0 && line.len() >= options.tokenize_max_line_length {
            final_lines.push(vec![ThemedToken {
                content: line.to_string(),
                offset: line_offset,
                color: Some(String::new()),
                bg_color: None,
                font_style: Some(FontStyle::NONE),
                token_type: None,
                html_style: None,
                explanation: None,
            }]);
            continue;
        }

        let need_scope_tokens = matches!(options.include_explanation, ExplanationMode::ScopeName | ExplanationMode::Full);
        let scope_tokens = if need_scope_tokens {
            Some(
                grammar
                    .tokenize_line_with_theme(line, Some(&state_stack), compiled_theme, options.tokenize_time_limit)?
                    .tokens,
            )
        } else {
            None
        };
        let mut scope_tok_idx = 0usize;

        let binary = grammar.tokenize_line2_with_theme(line, Some(&state_stack), compiled_theme, options.tokenize_time_limit)?;
        let token_count = binary.tokens.len() / 2;
        let mut actual = Vec::with_capacity(token_count);

        for j in 0..token_count {
            let start = binary.tokens[2 * j] as usize;
            let next_start = if j + 1 < token_count { binary.tokens[2 * j + 2] as usize } else { line.len() };
            if start >= next_start || start >= line.len() {
                continue;
            }
            let end = next_start.min(line.len());
            let attrs = EncodedTokenAttributes(binary.tokens[2 * j + 1]);
            let mut token = token_from_meta(line, line_offset, start, end, attrs, color_map, &repl);

            match options.include_explanation {
                ExplanationMode::Off => {}
                ExplanationMode::TokenType => {
                    token.token_type = Some(attrs.token_type());
                }
                ExplanationMode::ScopeName | ExplanationMode::Full => {
                    let mut explanations = Vec::new();
                    let mut covered = 0usize;
                    if let Some(s_tokens) = &scope_tokens {
                        while start + covered < end && scope_tok_idx < s_tokens.len() {
                            let st = &s_tokens[scope_tok_idx];
                            let piece = &line[st.start_index..st.end_index.min(line.len())];
                            covered += piece.len();
                            let scopes = if options.include_explanation == ExplanationMode::ScopeName {
                                st.scopes
                                    .iter()
                                    .map(|s| ThemedTokenScopeExplanation {
                                        scope_name: s.clone(),
                                        theme_matches: Vec::new(),
                                    })
                                    .collect()
                            } else {
                                explain_theme_scopes_full(&theme_selectors, &st.scopes)
                            };
                            explanations.push(ThemedTokenExplanation {
                                content: piece.to_string(),
                                scopes,
                            });
                            scope_tok_idx += 1;
                        }
                    }
                    token.explanation = Some(explanations);
                }
            }

            actual.push(token);
        }

        final_lines.push(actual);
        state_stack = binary.rule_stack;
    }

    Ok((final_lines, state_stack))
}

struct ThemeSettingsSelector {
    setting: RawThemeSetting,
    selectors: Vec<Vec<String>>,
}

fn build_theme_settings_selectors(settings: &[RawThemeSetting]) -> Vec<ThemeSettingsSelector> {
    let mut out = Vec::new();
    for setting in settings {
        let selectors: Vec<String> = match &setting.scope {
            Some(ScopePatternList::Single(s)) => s.split(',').map(|p| p.trim().to_string()).collect(),
            Some(ScopePatternList::Multiple(list)) => list.clone(),
            None => continue,
        };
        let parsed = selectors.into_iter().map(|sel| sel.split(' ').map(str::to_string).collect()).collect();
        out.push(ThemeSettingsSelector {
            setting: setting.clone(),
            selectors: parsed,
        });
    }
    out
}

fn explain_theme_scopes_full(selectors: &[ThemeSettingsSelector], scopes: &[String]) -> Vec<ThemedTokenScopeExplanation> {
    scopes
        .iter()
        .enumerate()
        .map(|(i, scope)| {
            let parents = &scopes[..i];
            let mut matches = Vec::new();
            for entry in selectors {
                if entry.selectors.iter().any(|pieces| scope_pieces_match(pieces, scope, parents)) {
                    matches.push(entry.setting.clone());
                }
            }
            ThemedTokenScopeExplanation {
                scope_name: scope.clone(),
                theme_matches: matches,
            }
        })
        .collect()
}

fn scope_pieces_match(pieces: &[String], scope: &str, parent_scopes: &[String]) -> bool {
    let Some(last) = pieces.last() else {
        return false;
    };
    if !matches_one_scope(last, scope) {
        return false;
    }
    if pieces.len() == 1 {
        return true;
    }
    let mut sel_idx: isize = pieces.len() as isize - 2;
    let mut par_idx: isize = parent_scopes.len() as isize - 1;
    while sel_idx >= 0 && par_idx >= 0 {
        if matches_one_scope(&pieces[sel_idx as usize], &parent_scopes[par_idx as usize]) {
            sel_idx -= 1;
        }
        par_idx -= 1;
    }
    sel_idx == -1
}

fn matches_one_scope(selector: &str, scope: &str) -> bool {
    selector == scope || (scope.len() > selector.len() && scope.as_bytes()[selector.len()] == b'.' && scope.starts_with(selector))
}

/// Splits `code` into `(line_slice, start_byte_offset)` pairs handling `\r\n`, `\n`, and `\r`,
/// matching Shiki's `splitLines`.
pub fn split_lines(code: &str) -> Vec<(&str, usize)> {
    let bytes = code.as_bytes();
    let len = bytes.len();
    let mut lines = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;

    while i < len {
        if bytes[i] == b'\r' {
            lines.push((&code[start..i], start));
            if i + 1 < len && bytes[i + 1] == b'\n' {
                i += 2;
            } else {
                i += 1;
            }
            start = i;
        } else if bytes[i] == b'\n' {
            lines.push((&code[start..i], start));
            i += 1;
            start = i;
        } else {
            i += 1;
        }
    }
    lines.push((&code[start..], start));
    lines
}

/// Aligns token boundaries across multiple theme tokenizations of the same code,
/// matching Shiki's `alignThemesTokenization`.
pub fn align_themes_tokenization(themes: &[Vec<Vec<ThemedToken>>]) -> Vec<Vec<Vec<ThemedToken>>> {
    let count = themes.len();
    if count == 0 {
        return Vec::new();
    }
    let line_count = themes[0].len();
    let mut out: Vec<Vec<Vec<ThemedToken>>> = (0..count).map(|_| Vec::with_capacity(line_count)).collect();

    for line_idx in 0..line_count {
        let mut out_lines: Vec<Vec<ThemedToken>> = (0..count).map(|_| Vec::new()).collect();
        let mut indexes = vec![0usize; count];
        let mut current: Vec<Option<ThemedToken>> = themes.iter().map(|t| t[line_idx].first().cloned()).collect();

        while current.iter().all(Option::is_some) {
            let min_len = current.iter().map(|t| t.as_ref().unwrap().content.len()).min().unwrap_or(0);
            if min_len == 0 {
                // Consume empty tokens cleanly to avoid spinning.
                for n in 0..count {
                    let tok = current[n].take().unwrap();
                    if tok.content.is_empty() {
                        out_lines[n].push(tok);
                        indexes[n] += 1;
                        current[n] = themes[n][line_idx].get(indexes[n]).cloned();
                    } else {
                        current[n] = Some(tok);
                    }
                }
                continue;
            }

            for n in 0..count {
                let tok = current[n].take().unwrap();
                if tok.content.len() == min_len {
                    out_lines[n].push(tok);
                    indexes[n] += 1;
                    current[n] = themes[n][line_idx].get(indexes[n]).cloned();
                } else {
                    let head = ThemedToken {
                        content: tok.content[..min_len].to_string(),
                        ..tok.clone()
                    };
                    let tail = ThemedToken {
                        content: tok.content[min_len..].to_string(),
                        offset: tok.offset + min_len,
                        ..tok
                    };
                    out_lines[n].push(head);
                    current[n] = Some(tail);
                }
            }
        }

        for n in 0..count {
            out[n].push(std::mem::take(&mut out_lines[n]));
        }
    }

    out
}

/// Flattens a multi-theme aligned token into a single [`ThemedToken`] with CSS variables
/// (or `light-dark()`), matching Shiki's `flatTokenVariants`.
pub fn flat_token_variants(
    merged: &ThemedTokenWithVariants,
    variants_order: &[String],
    css_variable_prefix: &str,
    default_color: &DefaultColor,
    colors_rendering: ColorsRendering,
) -> ThemedToken {
    let styles_per_variant: Vec<Vec<(String, String)>> = variants_order
        .iter()
        .map(|key| merged.variant(key).map(token_style_entries).unwrap_or_default())
        .collect();

    // Preserve first-seen CSS property key order across variants.
    let mut style_keys: Vec<String> = Vec::new();
    for entries in &styles_per_variant {
        for (k, _) in entries {
            if !style_keys.contains(k) {
                style_keys.push(k.clone());
            }
        }
    }

    let lookup_val = |entries: &[(String, String)], key: &str| -> String {
        entries
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
            .unwrap_or_else(|| "inherit".to_string())
    };

    let var_key = |idx: usize, key: &str| -> String {
        let suffix = match key {
            "color" => String::new(),
            "background-color" => "-bg".to_string(),
            other => format!("-{other}"),
        };
        format!("{css_variable_prefix}{}{suffix}", variants_order[idx])
    };

    let mut merged_styles: Vec<(String, String)> = Vec::new();

    for (idx, cur) in styles_per_variant.iter().enumerate() {
        for key in &style_keys {
            let value = lookup_val(cur, key);
            let is_color_key = matches!(key.as_str(), "color" | "background-color" | "font-style" | "font-weight" | "text-decoration");

            if idx == 0 && *default_color != DefaultColor::None && is_color_key {
                if *default_color == DefaultColor::LightDark && styles_per_variant.len() > 1 {
                    let light_idx = variants_order.iter().position(|k| k == "light").unwrap_or(0);
                    let dark_idx = variants_order.iter().position(|k| k == "dark").unwrap_or(1);
                    let light_val = lookup_val(&styles_per_variant[light_idx], key);
                    let dark_val = lookup_val(&styles_per_variant[dark_idx], key);
                    set_style_entry(&mut merged_styles, key.clone(), format!("light-dark({light_val}, {dark_val})"));
                    if colors_rendering == ColorsRendering::CssVars {
                        set_style_entry(&mut merged_styles, var_key(idx, key), value);
                    }
                } else {
                    set_style_entry(&mut merged_styles, key.clone(), value);
                }
            } else if colors_rendering == ColorsRendering::CssVars {
                set_style_entry(&mut merged_styles, var_key(idx, key), value);
            }
        }
    }

    ThemedToken {
        content: merged.content.clone(),
        offset: merged.offset,
        color: None,
        bg_color: None,
        font_style: None,
        token_type: None,
        html_style: Some(merged_styles),
        explanation: merged.explanation.clone(),
    }
}

fn set_style_entry(entries: &mut Vec<(String, String)>, key: String, val: String) {
    if let Some((_, existing)) = entries.iter_mut().find(|(k, _)| *k == key) {
        *existing = val;
    } else {
        entries.push((key, val));
    }
}

fn map_theme_colors(
    variants_order: &[String],
    resolved: &[Option<ResolvedTheme>],
    replacements: &[FxHashMap<String, String>],
    css_variable_prefix: &str,
    default_color: &DefaultColor,
    is_bg: bool,
    colors_rendering: ColorsRendering,
) -> Result<String, ShikiError> {
    let get_val = |idx: usize| -> String {
        resolved[idx]
            .as_ref()
            .and_then(|t| {
                let raw = if is_bg { &t.bg } else { &t.fg };
                apply_color_replacement(Some(raw), &replacements[idx])
            })
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "inherit".to_string())
    };

    let mut parts = Vec::new();
    for (idx, variant) in variants_order.iter().enumerate() {
        let value = get_val(idx);
        let suffix = if is_bg { "-bg" } else { "" };
        let css_var = format!("{css_variable_prefix}{variant}{suffix}:{value}");

        if idx == 0 && *default_color != DefaultColor::None {
            if *default_color == DefaultColor::LightDark && variants_order.len() > 1 {
                let light_idx = variants_order.iter().position(|k| k == "light").ok_or_else(|| {
                    ShikiError::InvalidOptions("When using `defaultColor: \"light-dark()\"`, you must provide both `light` and `dark` themes".to_string())
                })?;
                let dark_idx = variants_order.iter().position(|k| k == "dark").ok_or_else(|| {
                    ShikiError::InvalidOptions("When using `defaultColor: \"light-dark()\"`, you must provide both `light` and `dark` themes".to_string())
                })?;
                let light_val = get_val(light_idx);
                let dark_val = get_val(dark_idx);
                parts.push(format!("light-dark({light_val}, {dark_val});{css_var}"));
            } else {
                parts.push(value);
            }
        } else if colors_rendering == ColorsRendering::CssVars {
            parts.push(css_var);
        }
    }

    Ok(parts.join(";"))
}

/// Converts a token's foreground/background/fontStyle into ordered CSS property pairs.
pub fn token_style_entries(styles: &TokenStyles) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if let Some(color) = &styles.color
        && !color.is_empty()
    {
        out.push(("color".to_string(), color.clone()));
    }
    if let Some(bg) = &styles.bg_color
        && !bg.is_empty()
    {
        out.push(("background-color".to_string(), bg.clone()));
    }
    if let Some(fs) = styles.font_style
        && !fs.is_not_set()
    {
        if fs.is_italic() {
            out.push(("font-style".to_string(), "italic".to_string()));
        }
        if fs.is_bold() {
            out.push(("font-weight".to_string(), "bold".to_string()));
        }
        let mut decorations = Vec::new();
        if fs.is_underline() {
            decorations.push("underline");
        }
        if fs.is_strikethrough() {
            decorations.push("line-through");
        }
        if !decorations.is_empty() {
            out.push(("text-decoration".to_string(), decorations.join(" ")));
        }
    }
    out
}

fn stringify_token_style(token: &ThemedToken) -> String {
    let owned;
    let entries: &[(String, String)] = if let Some(html_style) = &token.html_style {
        html_style.as_slice()
    } else {
        owned = token_style_entries(&TokenStyles {
            color: token.color.clone(),
            bg_color: token.bg_color.clone(),
            font_style: token.font_style,
        });
        &owned
    };
    entries.iter().map(|(k, v)| format!("{k}:{v}")).collect::<Vec<_>>().join(";")
}

fn is_decorated(token: &ThemedToken) -> bool {
    token.font_style.is_some_and(|fs| fs.is_underline() || fs.is_strikethrough())
}

fn is_whitespace_only(s: &str) -> bool {
    !s.is_empty() && s.chars().all(char::is_whitespace)
}

fn merge_whitespace_tokens(tokens: Vec<Vec<ThemedToken>>) -> Vec<Vec<ThemedToken>> {
    tokens
        .into_iter()
        .map(|line| {
            let len = line.len();
            let mut new_line = Vec::with_capacity(len);
            let mut carry = String::new();
            let mut first_offset: Option<usize> = None;

            for (idx, mut token) in line.into_iter().enumerate() {
                let could_merge = !is_decorated(&token);
                if could_merge && is_whitespace_only(&token.content) && idx + 1 < len {
                    if first_offset.is_none() {
                        first_offset = Some(token.offset);
                    }
                    carry.push_str(&token.content);
                } else if !carry.is_empty() {
                    let carried = std::mem::take(&mut carry);
                    let carried_offset = first_offset.take().unwrap_or(token.offset);
                    if could_merge {
                        token.content = format!("{carried}{}", token.content);
                        token.offset = carried_offset;
                        new_line.push(token);
                    } else {
                        new_line.push(plain_token(&carried, carried_offset));
                        new_line.push(token);
                    }
                } else {
                    new_line.push(token);
                }
            }
            new_line
        })
        .collect()
}

fn split_whitespace_tokens(tokens: Vec<Vec<ThemedToken>>) -> Vec<Vec<ThemedToken>> {
    tokens
        .into_iter()
        .map(|line| {
            let mut out = Vec::with_capacity(line.len());
            for token in line {
                if is_whitespace_only(&token.content) {
                    out.push(token);
                    continue;
                }
                let trimmed_start = token.content.trim_start();
                let leading_len = token.content.len() - trimmed_start.len();
                let trimmed = trimmed_start.trim_end();
                let trailing_len = trimmed_start.len() - trimmed.len();
                if leading_len == 0 && trailing_len == 0 {
                    out.push(token);
                    continue;
                }
                if leading_len > 0 {
                    out.push(plain_token(&token.content[..leading_len], token.offset));
                }
                out.push(ThemedToken {
                    content: trimmed.to_string(),
                    offset: token.offset + leading_len,
                    ..token.clone()
                });
                if trailing_len > 0 {
                    let trailing_start = leading_len + trimmed.len();
                    out.push(plain_token(&token.content[trailing_start..], token.offset + trailing_start));
                }
            }
            out
        })
        .collect()
}

fn merge_adjacent_styled_tokens(tokens: Vec<Vec<ThemedToken>>) -> Vec<Vec<ThemedToken>> {
    tokens
        .into_iter()
        .map(|line| {
            let mut out: Vec<ThemedToken> = Vec::with_capacity(line.len());
            for token in line {
                if let Some(prev) = out.last_mut()
                    && !is_decorated(prev)
                    && !is_decorated(&token)
                    && stringify_token_style(prev) == stringify_token_style(&token)
                {
                    prev.content.push_str(&token.content);
                    continue;
                }
                out.push(token);
            }
            out
        })
        .collect()
}

fn render_tokens_to_html(result: &TokensResult, options: &HtmlOptions) -> String {
    let mut out = String::new();

    match options.structure {
        HtmlStructure::Classic => {
            out.push_str("<pre class=\"shiki");
            if !result.theme_name.is_empty() {
                out.push(' ');
                push_html_attr_escaped(&mut out, &result.theme_name);
            }
            out.push('"');

            match &options.root_style {
                RootStyleOption::Disabled => {}
                RootStyleOption::Custom(custom) => {
                    out.push_str(" style=\"");
                    push_html_attr_escaped(&mut out, custom);
                    out.push('"');
                }
                RootStyleOption::Auto => {
                    let style = result
                        .root_style
                        .clone()
                        .unwrap_or_else(|| format!("background-color:{};color:{}", result.bg, result.fg));
                    out.push_str(" style=\"");
                    push_html_attr_escaped(&mut out, &style);
                    out.push('"');
                }
            }

            if let Some(tabindex) = &options.tabindex {
                out.push_str(" tabindex=\"");
                push_html_attr_escaped(&mut out, tabindex);
                out.push('"');
            }
            out.push_str("><code>");

            for (idx, line) in result.tokens.iter().enumerate() {
                if idx > 0 {
                    out.push('\n');
                }
                out.push_str("<span class=\"line\">");
                for token in line {
                    render_span(&mut out, token);
                }
                out.push_str("</span>");
            }

            out.push_str("</code></pre>");
        }
        HtmlStructure::Inline => {
            for (idx, line) in result.tokens.iter().enumerate() {
                if idx > 0 {
                    out.push_str("<br>");
                }
                for token in line {
                    render_span(&mut out, token);
                }
            }
        }
    }

    out
}

fn render_span(out: &mut String, token: &ThemedToken) {
    let style = stringify_token_style(token);
    if style.is_empty() {
        out.push_str("<span>");
    } else {
        out.push_str("<span style=\"");
        push_html_attr_escaped(out, &style);
        out.push_str("\">");
    }
    push_html_text_escaped(out, &token.content);
    out.push_str("</span>");
}

fn render_tokens_to_svg(result: &TokensResult, options: &SvgOptions) -> String {
    let max_cols = result
        .tokens
        .iter()
        .map(|line| line.iter().map(|t| t.content.chars().count()).sum::<usize>())
        .max()
        .unwrap_or(0);
    let line_count = result.tokens.len().max(1);
    let char_w = options.font_size * options.char_width_ratio;
    let width = (max_cols as f64 * char_w + options.padding_x * 2.0).ceil();
    let height = (line_count as f64 * options.line_height + options.padding_y * 2.0).ceil();

    let bg = if result.bg.is_empty() { "#1e1e1e" } else { result.bg.as_str() };
    let fg = if result.fg.is_empty() { "#d4d4d4" } else { result.fg.as_str() };

    let mut out = String::new();
    out.push_str(&format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{width}\" height=\"{height}\" viewBox=\"0 0 {width} {height}\">"
    ));
    out.push_str(&format!(
        "<rect width=\"100%\" height=\"100%\" rx=\"{}\" fill=\"{}\"/>",
        options.border_radius,
        escape_xml_attr(bg),
    ));
    out.push_str(&format!(
        "<text font-family=\"{}\" font-size=\"{}\" fill=\"{}\" xml:space=\"preserve\">",
        escape_xml_attr(&options.font_family),
        options.font_size,
        escape_xml_attr(fg),
    ));

    for (line_idx, line) in result.tokens.iter().enumerate() {
        let y = options.padding_y + options.font_size + line_idx as f64 * options.line_height;
        out.push_str(&format!("<tspan x=\"{}\" y=\"{y}\">", options.padding_x));
        for token in line {
            out.push_str("<tspan");
            if let Some(color) = &token.color
                && !color.is_empty()
            {
                out.push_str(" fill=\"");
                push_html_attr_escaped(&mut out, color);
                out.push('"');
            }
            if let Some(fs) = token.font_style {
                if fs.is_bold() {
                    out.push_str(" font-weight=\"bold\"");
                }
                if fs.is_italic() {
                    out.push_str(" font-style=\"italic\"");
                }
                if fs.is_underline() && fs.is_strikethrough() {
                    out.push_str(" text-decoration=\"underline line-through\"");
                } else if fs.is_underline() {
                    out.push_str(" text-decoration=\"underline\"");
                } else if fs.is_strikethrough() {
                    out.push_str(" text-decoration=\"line-through\"");
                }
            }
            out.push('>');
            push_html_text_escaped(&mut out, &token.content);
            out.push_str("</tspan>");
        }
        out.push_str("</tspan>");
    }

    out.push_str("</text></svg>");
    out
}

fn push_html_text_escaped(out: &mut String, s: &str) {
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            _ => out.push(ch),
        }
    }
}

fn push_html_attr_escaped(out: &mut String, s: &str) {
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
    }
}

fn escape_xml_attr(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    push_html_attr_escaped(&mut out, s);
    out
}

fn default_lang_aliases() -> BTreeMap<String, String> {
    [
        ("js", "javascript"),
        ("mjs", "javascript"),
        ("cjs", "javascript"),
        ("ts", "typescript"),
        ("mts", "typescript"),
        ("cts", "typescript"),
        ("rs", "rust"),
        ("py", "python"),
        ("md", "markdown"),
        ("yml", "yaml"),
        ("sh", "shellscript"),
        ("bash", "shellscript"),
        ("zsh", "shellscript"),
        ("rb", "ruby"),
        ("c++", "cpp"),
        ("cc", "cpp"),
        ("cxx", "cpp"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}
