use std::sync::{Arc, RwLock};

use crate::encoded_attrs::{EncodedTokenAttributes, FontAttribute, FontStyle};
use crate::matcher::create_matchers;
use crate::raw_grammar::RawGrammar;
use crate::regex_engine::RegexEngine;
use crate::rule::{Rule, RuleCompiler, RuleId};
use crate::theme::{ScopeStack, StyleAttributes, Theme};

use super::attributes::{BalancedBracketSelectors, BasicScopeAttributes, BasicScopeAttributesProvider, GrammarConfiguration, Injection, TokenTypeMatcher};

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

    pub(super) fn token_type_matchers(&self) -> &[TokenTypeMatcher] {
        &self.token_type_matchers
    }

    pub fn metadata_for_scope(&self, scope: &str) -> BasicScopeAttributes {
        self.basic_scope_attributes_provider.basic_scope_attributes(scope)
    }

    pub(super) fn current_theme(&self) -> Arc<Theme> {
        self.theme_slot.read().expect("theme lock not poisoned").clone()
    }

    pub(super) fn make_initial_state(&self, theme: &Theme) -> StateStack {
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
