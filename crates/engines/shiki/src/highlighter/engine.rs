use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use rustc_hash::FxHashMap;

use super::options::{
    DefaultColor, ExplanationMode, GrammarState, HighlightOptions, HtmlOptions, MergeWhitespaces, StyledSpan, SvgOptions, ThemeInput, ThemeSelection,
    ThemedToken, ThemedTokenWithVariants, TokenStyles, TokensResult, apply_color_replacement, is_none_theme_name, is_plain_lang,
};
use super::render::{render_tokens_to_html, render_tokens_to_svg};
use super::tokenize::{plain_token, split_lines, tokenize_with_single_theme};
use super::transform::{
    align_themes_tokenization, flat_token_variants, map_theme_colors, merge_adjacent_styled_tokens, merge_whitespace_tokens, split_whitespace_tokens,
};
use crate::encoded_attrs::{FontStyle, StandardTokenType};
use crate::error::ShikiError;
use crate::grammar::Grammar;
use crate::raw_grammar::{RawGrammar, parse_grammar_json, parse_grammar_plist};
use crate::regex_engine::{OnigEngine, RegexEngine};
use crate::registry::Registry;
use crate::theme::{RawTheme, ResolvedTheme, Rgba, Theme, load_theme_from_file, normalize_theme, parse_theme_json, parse_theme_plist};

struct LoadedTheme {
    resolved: ResolvedTheme,
    compiled: Arc<Theme>,
}

pub(super) struct LoadedLanguage<E: RegexEngine> {
    pub(super) name: String,
    pub(super) grammar: Arc<Grammar<E>>,
}

/// High-level Shiki highlighting engine supporting multiple grammars, themes, aliases,
/// injections, dual/multi-theme CSS variables, GPUI spans, HTML, and SVG output.
pub struct Highlighter<E: RegexEngine = OnigEngine> {
    registry: Registry<E>,
    languages: BTreeMap<String, LoadedLanguage<E>>,
    lang_aliases: BTreeMap<String, String>,
    scope_to_lang: BTreeMap<String, String>,
    themes: BTreeMap<String, LoadedTheme>,
    theme_order: Vec<String>,
}

impl Highlighter<OnigEngine> {
    /// Creates a highlighter backed by the built-in pure-Rust `vibevalley-onig` engine.
    pub fn with_default_engine() -> Self {
        Self::new(OnigEngine::default())
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

    pub(super) fn resolve_theme_input(&self, input: &ThemeInput) -> Result<Option<(ResolvedTheme, Arc<Theme>)>, ShikiError> {
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

    pub(super) fn lookup_language(&self, lang: &str) -> Result<&LoadedLanguage<E>, ShikiError> {
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
