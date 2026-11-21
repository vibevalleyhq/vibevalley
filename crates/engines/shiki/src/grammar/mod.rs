pub mod dependencies;
mod tokenize;

use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use rustc_hash::FxHashMap;

use crate::encoded_attrs::{EncodedTokenAttributes, FontAttribute, FontStyle, OptionalStandardTokenType, StandardTokenType, contains_rtl};
use crate::error::RegexError;
use crate::matcher::{InjectionPriority, SelectorExpr, create_matchers};
use crate::raw_grammar::RawGrammar;
use crate::regex_engine::RegexEngine;
use crate::rule::{Rule, RuleCompiler, RuleId};
use crate::theme::{ScopeStack, StyleAttributes, Theme};

use self::tokenize::{ActiveStack, tokenize_string};

/// Embedded language scope-to-language-id mapping (`0` is reserved for "unset").
pub type EmbeddedLanguagesMap = BTreeMap<String, u8>;

/// Selector-to-standard-token-type override mapping.
pub type TokenTypeMap = BTreeMap<String, StandardTokenType>;

/// Configuration passed when loading a grammar from [`crate::Registry`].
#[derive(Debug, Clone, Default)]
pub struct GrammarConfiguration {
    pub embedded_languages: EmbeddedLanguagesMap,
    pub token_types: TokenTypeMap,
    pub balanced_bracket_selectors: Vec<String>,
    pub unbalanced_bracket_selectors: Vec<String>,
}

/// Basic language ID and standard token type derived from a single scope name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BasicScopeAttributes {
    pub language_id: u8,
    pub token_type: OptionalStandardTokenType,
}

/// Maps scope names to embedded language IDs and `StandardTokenType` values.
pub struct BasicScopeAttributesProvider {
    default_attributes: BasicScopeAttributes,
    embedded_languages: Vec<(String, u8)>,
    cache: RwLock<FxHashMap<String, BasicScopeAttributes>>,
}

impl BasicScopeAttributesProvider {
    pub fn new(initial_language_id: u8, embedded_languages: &EmbeddedLanguagesMap) -> Self {
        let mut entries: Vec<(String, u8)> = embedded_languages.iter().map(|(k, &v)| (k.clone(), v)).collect();
        // Match longest prefix first, identically to `vscode-textmate`'s reverse-sorted ScopeMatcher.
        entries.sort_by(|a, b| b.0.cmp(&a.0));
        Self {
            default_attributes: BasicScopeAttributes {
                language_id: initial_language_id,
                token_type: OptionalStandardTokenType::NotSet,
            },
            embedded_languages: entries,
            cache: RwLock::new(FxHashMap::default()),
        }
    }

    pub fn default_attributes(&self) -> BasicScopeAttributes {
        self.default_attributes
    }

    pub fn basic_scope_attributes(&self, scope_name: &str) -> BasicScopeAttributes {
        if let Ok(guard) = self.cache.read()
            && let Some(&hit) = guard.get(scope_name)
        {
            return hit;
        }
        let attrs = BasicScopeAttributes {
            language_id: self.scope_to_language(scope_name),
            token_type: to_standard_token_type(scope_name),
        };
        if let Ok(mut guard) = self.cache.write() {
            guard.insert(scope_name.to_string(), attrs);
        }
        attrs
    }

    fn scope_to_language(&self, scope: &str) -> u8 {
        for (prefix, lang_id) in &self.embedded_languages {
            if scope == prefix || (scope.len() > prefix.len() && scope.as_bytes()[prefix.len()] == b'.' && scope.starts_with(prefix.as_str())) {
                return *lang_id;
            }
        }
        0
    }
}

/// Matches `\b(comment|string|regex|meta\.embedded)\b` identically to `vscode-textmate`.
fn to_standard_token_type(scope_name: &str) -> OptionalStandardTokenType {
    let bytes = scope_name.as_bytes();
    let len = bytes.len();
    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';

    let mut i = 0;
    while i < len {
        let left_ok = i == 0 || !is_word(bytes[i - 1]);
        if left_ok {
            for (needle, kind) in [
                ("comment", OptionalStandardTokenType::Comment),
                ("string", OptionalStandardTokenType::String),
                ("regex", OptionalStandardTokenType::RegEx),
                ("meta.embedded", OptionalStandardTokenType::Other),
            ] {
                if scope_name[i..].starts_with(needle) {
                    let end = i + needle.len();
                    let right_ok = end == len || !is_word(bytes[end]);
                    if right_ok {
                        return kind;
                    }
                }
            }
        }
        i += 1;
    }
    OptionalStandardTokenType::NotSet
}

/// Evaluates whether a token's scope stack qualifies for balanced bracket matching.
#[derive(Debug, Clone, Default)]
pub struct BalancedBracketSelectors {
    balanced: Vec<SelectorExpr>,
    unbalanced: Vec<SelectorExpr>,
    allow_any: bool,
}

impl BalancedBracketSelectors {
    pub fn new(balanced_selectors: &[String], unbalanced_selectors: &[String]) -> Self {
        let mut allow_any = false;
        let mut balanced = Vec::new();
        for selector in balanced_selectors {
            if selector == "*" {
                allow_any = true;
            } else {
                for m in create_matchers(selector) {
                    balanced.push(m.matcher);
                }
            }
        }
        let mut unbalanced = Vec::new();
        for selector in unbalanced_selectors {
            for m in create_matchers(selector) {
                unbalanced.push(m.matcher);
            }
        }
        Self {
            balanced,
            unbalanced,
            allow_any,
        }
    }

    pub fn matches_always(&self) -> bool {
        self.allow_any && self.unbalanced.is_empty()
    }

    pub fn matches_never(&self) -> bool {
        self.balanced.is_empty() && !self.allow_any
    }

    pub fn matches(&self, scopes: &[String]) -> bool {
        if self.unbalanced.iter().any(|expr| expr.matches_scopes(scopes)) {
            return false;
        }
        if self.balanced.iter().any(|expr| expr.matches_scopes(scopes)) {
            return true;
        }
        self.allow_any
    }
}

struct TokenTypeMatcher {
    matcher: SelectorExpr,
    token_type: StandardTokenType,
}

/// Compiled injection rule attached to a [`Grammar`].
pub struct Injection {
    pub debug_selector: String,
    pub matcher: SelectorExpr,
    pub priority: InjectionPriority,
    pub rule_id: RuleId,
}

/// Immutable scope stack paired with resolved theme/language metadata.
#[derive(Debug, Clone)]
pub struct AttributedScopeStack {
    inner: Arc<AttributedScopeStackNode>,
}

#[derive(Debug)]
struct AttributedScopeStackNode {
    parent: Option<AttributedScopeStack>,
    scope_path: ScopeStack,
    token_attributes: EncodedTokenAttributes,
    font_attributes: FontAttribute,
}

impl PartialEq for AttributedScopeStack {
    fn eq(&self, other: &Self) -> bool {
        let mut a = Some(self);
        let mut b = Some(other);
        loop {
            match (a, b) {
                (None, None) => return true,
                (Some(x), Some(y)) => {
                    if Arc::ptr_eq(&x.inner, &y.inner) {
                        return true;
                    }
                    if x.scope_name() != y.scope_name() || x.token_attributes() != y.token_attributes() {
                        return false;
                    }
                    a = x.parent();
                    b = y.parent();
                }
                _ => return false,
            }
        }
    }
}

impl Eq for AttributedScopeStack {}

impl AttributedScopeStack {
    pub fn create_root(scope_name: impl Into<String>, token_attributes: EncodedTokenAttributes, font_attributes: FontAttribute) -> Self {
        Self {
            inner: Arc::new(AttributedScopeStackNode {
                parent: None,
                scope_path: ScopeStack::new(None, scope_name),
                token_attributes,
                font_attributes,
            }),
        }
    }

    pub fn create_root_and_lookup<E: RegexEngine>(
        scope_name: &str,
        token_attributes: EncodedTokenAttributes,
        font_attributes: FontAttribute,
        grammar: &Grammar<E>,
        theme: &Theme,
    ) -> Self {
        let basic = grammar.metadata_for_scope(scope_name);
        let scope_path = ScopeStack::new(None, scope_name);
        let root_style = theme.match_scope(Some(&scope_path));
        let merged = merge_attributes(token_attributes, basic, root_style.as_ref());
        let resolved_font = font_attributes.with(root_style.as_ref());
        Self {
            inner: Arc::new(AttributedScopeStackNode {
                parent: None,
                scope_path,
                token_attributes: merged,
                font_attributes: resolved_font,
            }),
        }
    }

    pub fn scope_name(&self) -> &str {
        self.inner.scope_path.scope_name()
    }

    pub fn parent(&self) -> Option<&Self> {
        self.inner.parent.as_ref()
    }

    pub fn scope_path(&self) -> &ScopeStack {
        &self.inner.scope_path
    }

    pub fn token_attributes(&self) -> EncodedTokenAttributes {
        self.inner.token_attributes
    }

    pub fn font_attributes(&self) -> &FontAttribute {
        &self.inner.font_attributes
    }

    pub fn scope_names(&self) -> Vec<String> {
        self.inner.scope_path.segments()
    }

    pub fn push_attributed<E: RegexEngine>(&self, scope_path: Option<&str>, grammar: &Grammar<E>, theme: &Theme) -> Self {
        let Some(scope_path) = scope_path else {
            return self.clone();
        };
        if !scope_path.contains(' ') {
            return self.push_single(scope_path, grammar, theme);
        }
        let mut current = self.clone();
        for segment in scope_path.split(' ') {
            current = current.push_single(segment, grammar, theme);
        }
        current
    }

    fn push_single<E: RegexEngine>(&self, scope_name: &str, grammar: &Grammar<E>, theme: &Theme) -> Self {
        let basic = grammar.metadata_for_scope(scope_name);
        let new_path = self.inner.scope_path.push(scope_name);
        let style = theme.match_scope(Some(&new_path));
        let metadata = merge_attributes(self.inner.token_attributes, basic, style.as_ref());
        let font = self.inner.font_attributes.with(style.as_ref());
        Self {
            inner: Arc::new(AttributedScopeStackNode {
                parent: Some(self.clone()),
                scope_path: new_path,
                token_attributes: metadata,
                font_attributes: font,
            }),
        }
    }

    pub(crate) fn rebuild_for_theme<E: RegexEngine>(&self, grammar: &Grammar<E>, theme: &Theme) -> Self {
        let segments = self.scope_names();
        let default_basic = grammar.basic_scope_attributes_provider.default_attributes();
        let default_style = theme.defaults();
        let default_meta = EncodedTokenAttributes::default().set(
            default_basic.language_id,
            default_basic.token_type,
            None,
            default_style.font_style,
            default_style.foreground_id,
            default_style.background_id,
        );
        let default_font = FontAttribute::from_parts(
            Some(default_style.font_family.clone()),
            Some(default_style.font_size),
            Some(default_style.line_height),
        );

        let mut iter = segments.iter();
        let first = iter.next().map(String::as_str).unwrap_or("unknown");
        let mut current = if first == "unknown" {
            Self::create_root(first, default_meta, default_font)
        } else {
            Self::create_root_and_lookup(first, default_meta, default_font, grammar, theme)
        };
        for seg in iter {
            current = current.push_single(seg, grammar, theme);
        }
        current
    }
}

fn merge_attributes(existing: EncodedTokenAttributes, basic: BasicScopeAttributes, style: Option<&StyleAttributes>) -> EncodedTokenAttributes {
    let (font_style, fg, bg) = match style {
        Some(s) => (s.font_style, s.foreground_id, s.background_id),
        None => (FontStyle::NOT_SET, 0, 0),
    };
    existing.set(basic.language_id, basic.token_type, None, font_style, fg, bg)
}

/// Immutable incremental rule stack returned by `Grammar::tokenize_line` and passed
/// into the subsequent line.
#[derive(Debug, Clone)]
pub struct StateStack {
    inner: Option<Arc<StateStackNode>>,
}

#[derive(Debug)]
struct StateStackNode {
    parent: Option<StateStack>,
    rule_id: RuleId,
    depth: usize,
    begin_rule_captured_eol: bool,
    end_rule: Option<String>,
    name_scopes: AttributedScopeStack,
    content_name_scopes: AttributedScopeStack,
}

impl PartialEq for StateStack {
    fn eq(&self, other: &Self) -> bool {
        if self.is_initial() && other.is_initial() {
            return true;
        }
        if !self.structural_eq(other) {
            return false;
        }
        self.content_name_scopes() == other.content_name_scopes()
    }
}

impl Eq for StateStack {}

impl Default for StateStack {
    fn default() -> Self {
        Self::initial()
    }
}

impl StateStack {
    /// Sentinel empty initial state equivalent to `vscode-textmate`'s `INITIAL`.
    pub const fn initial() -> Self {
        Self { inner: None }
    }

    pub fn is_initial(&self) -> bool {
        self.inner.is_none()
    }

    pub fn depth(&self) -> usize {
        self.inner.as_ref().map_or(0, |n| n.depth)
    }

    pub fn rule_id(&self) -> Option<RuleId> {
        self.inner.as_ref().map(|n| n.rule_id)
    }

    pub fn parent(&self) -> Option<&Self> {
        self.inner.as_ref().and_then(|n| n.parent.as_ref())
    }

    pub fn begin_rule_captured_eol(&self) -> bool {
        self.inner.as_ref().is_some_and(|n| n.begin_rule_captured_eol)
    }

    pub fn end_rule(&self) -> Option<&str> {
        self.inner.as_ref().and_then(|n| n.end_rule.as_deref())
    }

    pub fn name_scopes(&self) -> Option<&AttributedScopeStack> {
        self.inner.as_ref().map(|n| &n.name_scopes)
    }

    pub fn content_name_scopes(&self) -> Option<&AttributedScopeStack> {
        self.inner.as_ref().map(|n| &n.content_name_scopes)
    }

    pub fn root(rule_id: RuleId, name_scopes: AttributedScopeStack, content_name_scopes: AttributedScopeStack) -> Self {
        Self {
            inner: Some(Arc::new(StateStackNode {
                parent: None,
                rule_id,
                depth: 1,
                begin_rule_captured_eol: false,
                end_rule: None,
                name_scopes,
                content_name_scopes,
            })),
        }
    }

    pub fn push(
        &self,
        rule_id: RuleId,
        begin_rule_captured_eol: bool,
        end_rule: Option<String>,
        name_scopes: AttributedScopeStack,
        content_name_scopes: AttributedScopeStack,
    ) -> Self {
        let depth = self.depth() + 1;
        Self {
            inner: Some(Arc::new(StateStackNode {
                parent: if self.is_initial() { None } else { Some(self.clone()) },
                rule_id,
                depth,
                begin_rule_captured_eol,
                end_rule,
                name_scopes,
                content_name_scopes,
            })),
        }
    }

    pub fn with_content_name_scopes(&self, content_name_scopes: AttributedScopeStack) -> Self {
        let Some(node) = &self.inner else {
            return self.clone();
        };
        Self {
            inner: Some(Arc::new(StateStackNode {
                parent: node.parent.clone(),
                rule_id: node.rule_id,
                depth: node.depth,
                begin_rule_captured_eol: node.begin_rule_captured_eol,
                end_rule: node.end_rule.clone(),
                name_scopes: node.name_scopes.clone(),
                content_name_scopes,
            })),
        }
    }

    pub fn with_end_rule(&self, end_rule: String) -> Self {
        let Some(node) = &self.inner else {
            return self.clone();
        };
        Self {
            inner: Some(Arc::new(StateStackNode {
                parent: node.parent.clone(),
                rule_id: node.rule_id,
                depth: node.depth,
                begin_rule_captured_eol: node.begin_rule_captured_eol,
                end_rule: Some(end_rule),
                name_scopes: node.name_scopes.clone(),
                content_name_scopes: node.content_name_scopes.clone(),
            })),
        }
    }

    /// Rebuilds this stack's cached theme attributes against another theme while keeping
    /// all active rule IDs, `end_rule` backreferences, and scope paths intact.
    pub(crate) fn restack_for_theme<E: RegexEngine>(&self, grammar: &Grammar<E>, theme: &Theme) -> Self {
        if self.is_initial() {
            return Self::initial();
        }
        let mut frames = Vec::new();
        let mut cursor = Some(self);
        while let Some(node) = cursor {
            if let Some(inner) = &node.inner {
                frames.push(inner);
                cursor = inner.parent.as_ref();
            } else {
                break;
            }
        }
        let mut rebuilt: Option<StateStack> = None;
        for frame in frames.into_iter().rev() {
            let name_scopes = frame.name_scopes.rebuild_for_theme(grammar, theme);
            let content_scopes = frame.content_name_scopes.rebuild_for_theme(grammar, theme);
            rebuilt = Some(match rebuilt {
                None => StateStack::root(frame.rule_id, name_scopes, content_scopes),
                Some(parent) => parent.push(
                    frame.rule_id,
                    frame.begin_rule_captured_eol,
                    frame.end_rule.clone(),
                    name_scopes,
                    content_scopes,
                ),
            });
        }
        rebuilt.unwrap_or_else(StateStack::initial)
    }

    fn structural_eq(&self, other: &Self) -> bool {
        let mut a = self.inner.as_deref();
        let mut b = other.inner.as_deref();
        loop {
            match (a, b) {
                (None, None) => return true,
                (Some(x), Some(y)) => {
                    if std::ptr::eq(x, y) {
                        return true;
                    }
                    if x.depth != y.depth || x.rule_id != y.rule_id || x.end_rule != y.end_rule {
                        return false;
                    }
                    a = x.parent.as_ref().and_then(|p| p.inner.as_deref());
                    b = y.parent.as_ref().and_then(|p| p.inner.as_deref());
                }
                _ => return false,
            }
        }
    }
}

/// A single scope-annotated token on a line (`start_index..end_index` in UTF-8 bytes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub start_index: usize,
    pub end_index: usize,
    pub scopes: Vec<String>,
}

/// Variable font span produced when a theme specifies `fontFamily`, `fontSize`, or `lineHeight`.
#[derive(Debug, Clone, PartialEq)]
pub struct FontInfo {
    pub start_index: usize,
    pub end_index: usize,
    pub font_family: Option<String>,
    pub font_size_multiplier: Option<f64>,
    pub line_height_multiplier: Option<f64>,
}

impl FontInfo {
    fn options_equal(&self, other: &Self) -> bool {
        self.font_family == other.font_family
            && self.font_size_multiplier == other.font_size_multiplier
            && self.line_height_multiplier == other.line_height_multiplier
    }
}

/// Output of [`Grammar::tokenize_line`].
#[derive(Debug, Clone)]
pub struct TokenizeLineResult {
    pub tokens: Vec<Token>,
    pub fonts: Vec<FontInfo>,
    pub rule_stack: StateStack,
    pub stopped_early: bool,
}

/// Output of [`Grammar::tokenize_line2`]: packed `(start_index, EncodedTokenAttributes)` pairs.
#[derive(Debug, Clone)]
pub struct TokenizeLineResult2 {
    /// Pairs of `[start_byte_offset, encoded_attributes]` (length is `2 * token_count`).
    pub tokens: Vec<u32>,
    pub fonts: Vec<FontInfo>,
    pub rule_stack: StateStack,
    pub stopped_early: bool,
}

pub(crate) struct TokenHandler<'a> {
    emit_binary: bool,
    tokens: Vec<Token>,
    binary_tokens: Vec<u32>,
    last_token_end: usize,
    token_type_overrides: &'a [TokenTypeMatcher],
    balanced_brackets: Option<&'a BalancedBracketSelectors>,
    merge_consecutive_binary: bool,
    fonts: Vec<FontInfo>,
    last_font_end: usize,
}

impl<'a> TokenHandler<'a> {
    fn new(emit_binary: bool, line_text: &str, token_type_overrides: &'a [TokenTypeMatcher], balanced_brackets: Option<&'a BalancedBracketSelectors>) -> Self {
        Self {
            emit_binary,
            tokens: Vec::new(),
            binary_tokens: Vec::new(),
            last_token_end: 0,
            token_type_overrides,
            balanced_brackets,
            merge_consecutive_binary: !contains_rtl(line_text),
            fonts: Vec::new(),
            last_font_end: 0,
        }
    }

    pub(crate) fn handle(&mut self, scopes: Option<&AttributedScopeStack>, end_index: usize) {
        self.produce_tokens(scopes, end_index);
        self.produce_fonts(scopes, end_index);
    }

    fn produce_tokens(&mut self, scopes: Option<&AttributedScopeStack>, end_index: usize) {
        if self.last_token_end >= end_index {
            return;
        }

        if self.emit_binary {
            let mut metadata = scopes.map_or(EncodedTokenAttributes::default(), AttributedScopeStack::token_attributes);
            let mut contains_brackets = self.balanced_brackets.is_some_and(BalancedBracketSelectors::matches_always);

            let needs_scopes = !self.token_type_overrides.is_empty() || self.balanced_brackets.is_some_and(|b| !b.matches_always() && !b.matches_never());

            if needs_scopes {
                let scope_names = scopes.map(AttributedScopeStack::scope_names).unwrap_or_default();
                for override_rule in self.token_type_overrides {
                    if override_rule.matcher.matches_scopes(&scope_names) {
                        metadata = metadata.set(0, override_rule.token_type.into(), None, FontStyle::NOT_SET, 0, 0);
                    }
                }
                if let Some(bb) = self.balanced_brackets {
                    contains_brackets = bb.matches(&scope_names);
                }
            }

            if contains_brackets {
                metadata = metadata.set(0, OptionalStandardTokenType::NotSet, Some(true), FontStyle::NOT_SET, 0, 0);
            }

            let raw_meta = metadata.to_raw();
            if self.merge_consecutive_binary && self.binary_tokens.last().copied() == Some(raw_meta) {
                self.last_token_end = end_index;
                return;
            }

            self.binary_tokens.push(self.last_token_end as u32);
            self.binary_tokens.push(raw_meta);
            self.last_token_end = end_index;
            return;
        }

        let scope_names = scopes.map(AttributedScopeStack::scope_names).unwrap_or_default();
        self.tokens.push(Token {
            start_index: self.last_token_end,
            end_index,
            scopes: scope_names,
        });
        self.last_token_end = end_index;
    }

    fn produce_fonts(&mut self, scopes: Option<&AttributedScopeStack>, end_index: usize) {
        let Some(font_attrs) = scopes.map(AttributedScopeStack::font_attributes) else {
            self.last_font_end = end_index;
            return;
        };
        if font_attrs.font_family.is_none() && font_attrs.font_size.is_none() && font_attrs.line_height.is_none() {
            self.last_font_end = end_index;
            return;
        }
        let info = FontInfo {
            start_index: self.last_font_end,
            end_index,
            font_family: font_attrs.font_family.clone(),
            font_size_multiplier: font_attrs.font_size,
            line_height_multiplier: font_attrs.line_height,
        };
        if let Some(last) = self.fonts.last_mut()
            && last.end_index == self.last_font_end
            && last.options_equal(&info)
        {
            last.end_index = info.end_index;
        } else {
            self.fonts.push(info);
        }
        self.last_font_end = end_index;
    }

    fn finish_tokens(mut self, stack: &StateStack, line_length: usize) -> (Vec<Token>, Vec<FontInfo>) {
        let orig_len = line_length.saturating_sub(1);
        if self.tokens.last().is_some_and(|t| t.start_index == orig_len) {
            self.tokens.pop();
        }
        if self.tokens.is_empty() {
            let scopes = stack.content_name_scopes().map(AttributedScopeStack::scope_names).unwrap_or_default();
            self.tokens.push(Token {
                start_index: 0,
                end_index: orig_len,
                scopes,
            });
        } else {
            for tok in &mut self.tokens {
                if tok.end_index > orig_len {
                    tok.end_index = orig_len;
                }
            }
        }
        let fonts = clamp_fonts(self.fonts, orig_len);
        (self.tokens, fonts)
    }

    fn finish_binary(mut self, stack: &StateStack, line_length: usize) -> (Vec<u32>, Vec<FontInfo>) {
        let orig_len = line_length.saturating_sub(1);
        let len = self.binary_tokens.len();
        if len >= 2 && self.binary_tokens[len - 2] == orig_len as u32 {
            self.binary_tokens.pop();
            self.binary_tokens.pop();
        }
        if self.binary_tokens.is_empty() {
            self.last_token_end = 0;
            self.produce_tokens(stack.content_name_scopes(), line_length);
            if let Some(first) = self.binary_tokens.first_mut() {
                *first = 0;
            }
        }
        let fonts = clamp_fonts(self.fonts, orig_len);
        (self.binary_tokens, fonts)
    }
}

fn clamp_fonts(fonts: Vec<FontInfo>, orig_len: usize) -> Vec<FontInfo> {
    fonts
        .into_iter()
        .filter_map(|mut f| {
            f.end_index = f.end_index.min(orig_len);
            if f.start_index < f.end_index { Some(f) } else { None }
        })
        .collect()
}

/// Compiled TextMate grammar capable of incremental, thread-safe line tokenization.
pub struct Grammar<E: RegexEngine> {
    root_scope_name: String,
    root_id: RuleId,
    rules: Vec<Rule<E>>,
    injections: Vec<Injection>,
    basic_scope_attributes_provider: BasicScopeAttributesProvider,
    token_type_matchers: Vec<TokenTypeMatcher>,
    balanced_bracket_selectors: Option<BalancedBracketSelectors>,
    theme_slot: Arc<RwLock<Arc<Theme>>>,
    engine: Arc<E>,
}

impl<E: RegexEngine> Grammar<E> {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn compile<'a>(
        root_scope_name: String,
        raw_grammar: &'a RawGrammar,
        initial_language: u8,
        config: &GrammarConfiguration,
        lookup: &'a dyn Fn(&str) -> Option<&'a RawGrammar>,
        injections_for: &'a dyn Fn(&str) -> Option<&'a [String]>,
        theme_slot: Arc<RwLock<Arc<Theme>>>,
        engine: Arc<E>,
    ) -> Self {
        let mut compiler = RuleCompiler::<E>::new(lookup);
        let prepared_root = compiler.prepare_grammar(raw_grammar, None);
        let self_rule = prepared_root.repository.get("$self").cloned().expect("$self always exists in prepared grammar");
        let root_id = compiler.compile_rule(&self_rule, &prepared_root.repository);

        let mut injections = Vec::new();
        for (selector, inj_rule) in &prepared_root.injections {
            let rule_id = compiler.compile_rule(inj_rule, &prepared_root.repository);
            for m in create_matchers(selector) {
                injections.push(Injection {
                    debug_selector: selector.clone(),
                    matcher: m.matcher,
                    priority: m.priority,
                    rule_id,
                });
            }
        }

        if let Some(inj_scopes) = injections_for(&root_scope_name) {
            for inj_scope in inj_scopes {
                if let Some(inj_grammar) = compiler.get_external_grammar(inj_scope, None)
                    && let Some(selector) = &inj_grammar.injection_selector
                    && let Some(inj_self) = inj_grammar.repository.get("$self").cloned()
                {
                    let rule_id = compiler.compile_rule(&inj_self, &inj_grammar.repository);
                    for m in create_matchers(selector) {
                        injections.push(Injection {
                            debug_selector: selector.clone(),
                            matcher: m.matcher,
                            priority: m.priority,
                            rule_id,
                        });
                    }
                }
            }
        }

        injections.sort_by_key(|inj| inj.priority);

        let mut token_type_matchers = Vec::new();
        for (selector, &token_type) in &config.token_types {
            for m in create_matchers(selector) {
                token_type_matchers.push(TokenTypeMatcher {
                    matcher: m.matcher,
                    token_type,
                });
            }
        }

        let balanced_bracket_selectors = if config.balanced_bracket_selectors.is_empty() && config.unbalanced_bracket_selectors.is_empty() {
            None
        } else {
            Some(BalancedBracketSelectors::new(
                &config.balanced_bracket_selectors,
                &config.unbalanced_bracket_selectors,
            ))
        };

        Self {
            root_scope_name,
            root_id,
            rules: compiler.finish(),
            injections,
            basic_scope_attributes_provider: BasicScopeAttributesProvider::new(initial_language, &config.embedded_languages),
            token_type_matchers,
            balanced_bracket_selectors,
            theme_slot,
            engine,
        }
    }

    pub fn scope_name(&self) -> &str {
        &self.root_scope_name
    }

    pub(crate) fn engine(&self) -> &E {
        &self.engine
    }

    pub(crate) fn rules(&self) -> &[Rule<E>] {
        &self.rules
    }

    pub(crate) fn get_rule(&self, id: RuleId) -> &Rule<E> {
        &self.rules[(id.0 - 1) as usize]
    }

    pub(crate) fn injections(&self) -> &[Injection] {
        &self.injections
    }

    pub(crate) fn has_token_type_overrides(&self) -> bool {
        !self.token_type_matchers.is_empty()
    }

    pub(crate) fn default_basic_attributes(&self) -> BasicScopeAttributes {
        self.basic_scope_attributes_provider.default_attributes()
    }

    pub(crate) fn balanced_bracket_selectors(&self) -> Option<&BalancedBracketSelectors> {
        self.balanced_bracket_selectors.as_ref()
    }

    pub fn metadata_for_scope(&self, scope: &str) -> BasicScopeAttributes {
        self.basic_scope_attributes_provider.basic_scope_attributes(scope)
    }

    /// Tokenizes a single line (without trailing `\n`) into scope-annotated tokens using
    /// the registry's currently active theme.
    pub fn tokenize_line(&self, line_text: &str, prev_state: Option<&StateStack>, time_limit: Option<Duration>) -> Result<TokenizeLineResult, RegexError> {
        let theme = self.current_theme();
        self.tokenize_line_with_theme(line_text, prev_state, &theme, time_limit)
    }

    /// Tokenizes a single line into bit-packed binary tokens using the registry's active theme.
    pub fn tokenize_line2(&self, line_text: &str, prev_state: Option<&StateStack>, time_limit: Option<Duration>) -> Result<TokenizeLineResult2, RegexError> {
        let theme = self.current_theme();
        self.tokenize_line2_with_theme(line_text, prev_state, &theme, time_limit)
    }

    /// Tokenizes a single line into scope-annotated tokens against an explicit `Theme`
    /// without mutating shared registry state.
    pub fn tokenize_line_with_theme(
        &self,
        line_text: &str,
        prev_state: Option<&StateStack>,
        theme: &Theme,
        time_limit: Option<Duration>,
    ) -> Result<TokenizeLineResult, RegexError> {
        let (line_length, handler, rule_stack, stopped_early) = self.tokenize_inner(line_text, prev_state, theme, false, time_limit)?;
        let (tokens, fonts) = handler.finish_tokens(&rule_stack, line_length);
        Ok(TokenizeLineResult {
            tokens,
            fonts,
            rule_stack,
            stopped_early,
        })
    }

    /// Tokenizes a single line into bit-packed binary tokens against an explicit `Theme`.
    pub fn tokenize_line2_with_theme(
        &self,
        line_text: &str,
        prev_state: Option<&StateStack>,
        theme: &Theme,
        time_limit: Option<Duration>,
    ) -> Result<TokenizeLineResult2, RegexError> {
        let (line_length, handler, rule_stack, stopped_early) = self.tokenize_inner(line_text, prev_state, theme, true, time_limit)?;
        let (tokens, fonts) = handler.finish_binary(&rule_stack, line_length);
        Ok(TokenizeLineResult2 {
            tokens,
            fonts,
            rule_stack,
            stopped_early,
        })
    }

    fn current_theme(&self) -> Arc<Theme> {
        self.theme_slot.read().expect("theme lock not poisoned").clone()
    }

    fn tokenize_inner(
        &self,
        line_text: &str,
        prev_state: Option<&StateStack>,
        theme: &Theme,
        emit_binary: bool,
        time_limit: Option<Duration>,
    ) -> Result<(usize, TokenHandler<'_>, StateStack, bool), RegexError> {
        let (is_first_line, initial_stack) = match prev_state {
            None => (true, self.make_initial_state(theme)),
            Some(st) if st.is_initial() => (true, self.make_initial_state(theme)),
            Some(st) => (false, st.clone()),
        };

        let mut with_newline = String::with_capacity(line_text.len() + 1);
        with_newline.push_str(line_text);
        with_newline.push('\n');
        let line_length = with_newline.len();

        let mut token_handler = TokenHandler::new(emit_binary, &with_newline, &self.token_type_matchers, self.balanced_bracket_selectors.as_ref());
        let engine_string = self.engine.create_string(with_newline);
        let mut scanner_caches = FxHashMap::default();
        let active = ActiveStack::from_initial(initial_stack);

        let result = tokenize_string(
            self,
            theme,
            &engine_string,
            is_first_line,
            0,
            active,
            &mut token_handler,
            true,
            time_limit,
            &mut scanner_caches,
        )?;

        Ok((line_length, token_handler, result.stack, result.stopped_early))
    }

    fn make_initial_state(&self, theme: &Theme) -> StateStack {
        let default_basic = self.basic_scope_attributes_provider.default_attributes();
        let default_style = theme.defaults();
        let default_metadata = EncodedTokenAttributes::default().set(
            default_basic.language_id,
            default_basic.token_type,
            None,
            default_style.font_style,
            default_style.foreground_id,
            default_style.background_id,
        );
        let font_attribute = FontAttribute::from_parts(
            Some(default_style.font_family.clone()),
            Some(default_style.font_size),
            Some(default_style.line_height),
        );

        let root_scope_name = self.get_rule(self.root_id).name(None, None);
        let scope_list = match root_scope_name {
            Some(name) => AttributedScopeStack::create_root_and_lookup(&name, default_metadata, font_attribute, self, theme),
            None => AttributedScopeStack::create_root("unknown", default_metadata, font_attribute),
        };

        StateStack::root(self.root_id, scope_list.clone(), scope_list)
    }
}
