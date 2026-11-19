use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

use crate::error::ShikiError;
use crate::grammar::dependencies::ScopeDependencyProcessor;
use crate::grammar::{EmbeddedLanguagesMap, Grammar, GrammarConfiguration};
use crate::raw_grammar::RawGrammar;
use crate::regex_engine::{FancyRegexEngine, RegexEngine};
use crate::theme::{RawTheme, Theme};

/// Optional loader callback used by [`Registry`] to fetch external grammars on demand.
pub trait GrammarLoader: Send + Sync {
    fn load_grammar(&self, scope_name: &str) -> Result<Option<RawGrammar>, ShikiError>;

    fn injections(&self, _scope_name: &str) -> Vec<String> {
        Vec::new()
    }
}

/// Closure-based [`GrammarLoader`].
pub struct FnGrammarLoader<F> {
    loader: F,
}

impl<F> FnGrammarLoader<F>
where
    F: Fn(&str) -> Result<Option<RawGrammar>, ShikiError> + Send + Sync,
{
    pub fn new(loader: F) -> Self {
        Self { loader }
    }
}

impl<F> GrammarLoader for FnGrammarLoader<F>
where
    F: Fn(&str) -> Result<Option<RawGrammar>, ShikiError> + Send + Sync,
{
    fn load_grammar(&self, scope_name: &str) -> Result<Option<RawGrammar>, ShikiError> {
        (self.loader)(scope_name)
    }
}

/// TextMate grammar registry managing raw grammars, external includes, injections, and active theme.
pub struct Registry<E: RegexEngine = FancyRegexEngine> {
    engine: Arc<E>,
    theme: Arc<RwLock<Arc<Theme>>>,
    raw_grammars: BTreeMap<String, RawGrammar>,
    injection_scopes: BTreeMap<String, Vec<String>>,
    compiled_grammars: BTreeMap<String, Arc<Grammar<E>>>,
    loader: Option<Box<dyn GrammarLoader>>,
}

impl Registry<FancyRegexEngine> {
    /// Creates a registry backed by the built-in pure-Rust `FancyRegexEngine`.
    pub fn with_default_engine() -> Self {
        Self::new(FancyRegexEngine)
    }
}

impl<E: RegexEngine> Registry<E> {
    pub fn new(engine: E) -> Self {
        Self {
            engine: Arc::new(engine),
            theme: Arc::new(RwLock::new(Arc::new(Theme::create_from_raw_theme(&RawTheme::default(), None)))),
            raw_grammars: BTreeMap::new(),
            injection_scopes: BTreeMap::new(),
            compiled_grammars: BTreeMap::new(),
            loader: None,
        }
    }

    pub fn with_loader(mut self, loader: impl GrammarLoader + 'static) -> Self {
        self.loader = Some(Box::new(loader));
        self
    }

    pub fn with_theme(self, theme: &RawTheme, color_map: Option<&[String]>) -> Self {
        self.set_theme(theme, color_map);
        self
    }

    /// Replaces the active theme for all grammars in this registry.
    pub fn set_theme(&self, theme: &RawTheme, color_map: Option<&[String]>) {
        let compiled = Arc::new(Theme::create_from_raw_theme(theme, color_map));
        self.set_compiled_theme(compiled);
    }

    pub fn set_compiled_theme(&self, theme: Arc<Theme>) {
        let mut slot = self.theme.write().expect("theme lock not poisoned");
        *slot = theme;
    }

    pub fn theme(&self) -> Arc<Theme> {
        self.theme.read().expect("theme lock not poisoned").clone()
    }

    pub fn color_map(&self) -> Vec<String> {
        self.theme().color_map().to_vec()
    }

    /// Registers a raw grammar and optional injection scope names without immediately compiling it.
    pub fn register_grammar(&mut self, raw: RawGrammar, injections: Vec<String>) {
        let scope_name = raw.scope_name.clone();
        self.compiled_grammars.remove(&scope_name);
        if !injections.is_empty() {
            self.injection_scopes.insert(scope_name.clone(), injections);
        }
        self.raw_grammars.insert(scope_name, raw);
    }

    /// Registers an injection scope against `target_scope` (also invalidates compiled cache).
    pub fn register_injection(&mut self, target_scope: impl Into<String>, injection_scope: impl Into<String>) {
        let target = target_scope.into();
        let inj = injection_scope.into();
        self.compiled_grammars.remove(&target);
        let list = self.injection_scopes.entry(target).or_default();
        if !list.contains(&inj) {
            list.push(inj);
        }
    }

    /// Registers and compiles a grammar directly, matching `vscode-textmate`'s `Registry::addGrammar`.
    pub fn add_grammar(
        &mut self,
        raw: RawGrammar,
        injections: Vec<String>,
        initial_language: u8,
        embedded_languages: EmbeddedLanguagesMap,
    ) -> Result<Arc<Grammar<E>>, ShikiError> {
        let scope_name = raw.scope_name.clone();
        self.register_grammar(raw, injections);
        self.load_grammar_with_configuration(
            &scope_name,
            initial_language,
            &GrammarConfiguration {
                embedded_languages,
                ..GrammarConfiguration::default()
            },
        )
    }

    /// Resolves transitive dependencies and compiles the grammar for `scope_name`.
    pub fn load_grammar(&mut self, scope_name: &str) -> Result<Arc<Grammar<E>>, ShikiError> {
        self.load_grammar_with_configuration(scope_name, 0, &GrammarConfiguration::default())
    }

    /// Resolves transitive dependencies and compiles `scope_name` with embedded languages,
    /// token type overrides, and balanced bracket selectors.
    pub fn load_grammar_with_configuration(
        &mut self,
        scope_name: &str,
        initial_language: u8,
        config: &GrammarConfiguration,
    ) -> Result<Arc<Grammar<E>>, ShikiError> {
        self.ensure_dependencies(scope_name)?;

        let is_default_config = initial_language == 0
            && config.embedded_languages.is_empty()
            && config.token_types.is_empty()
            && config.balanced_bracket_selectors.is_empty()
            && config.unbalanced_bracket_selectors.is_empty();

        if is_default_config && let Some(cached) = self.compiled_grammars.get(scope_name) {
            return Ok(Arc::clone(cached));
        }

        let raw = self
            .raw_grammars
            .get(scope_name)
            .ok_or_else(|| ShikiError::MissingGrammar(scope_name.to_string()))?;

        let lookup = |s: &str| self.raw_grammars.get(s);
        let injections_for = |s: &str| self.injection_scopes.get(s).map(Vec::as_slice);

        let grammar = Arc::new(Grammar::compile(
            scope_name.to_string(),
            raw,
            initial_language,
            config,
            &lookup,
            &injections_for,
            Arc::clone(&self.theme),
            Arc::clone(&self.engine),
        ));

        if is_default_config {
            self.compiled_grammars.insert(scope_name.to_string(), Arc::clone(&grammar));
        }
        Ok(grammar)
    }

    pub fn raw_grammar(&self, scope_name: &str) -> Option<&RawGrammar> {
        self.raw_grammars.get(scope_name)
    }

    fn ensure_dependencies(&mut self, initial_scope_name: &str) -> Result<(), ShikiError> {
        let mut processor = ScopeDependencyProcessor::new(initial_scope_name.to_string());
        while !processor.queue.is_empty() {
            let pending_scopes: Vec<String> = processor.queue.iter().map(|r| r.scope_name().to_string()).collect();

            for scope in pending_scopes {
                if self.raw_grammars.contains_key(&scope) {
                    continue;
                }
                if let Some(loader) = &self.loader
                    && let Some(raw) = loader.load_grammar(&scope)?
                {
                    let injections = loader.injections(&scope);
                    if !injections.is_empty() {
                        self.injection_scopes.insert(scope.clone(), injections);
                    }
                    self.raw_grammars.insert(scope, raw);
                }
            }

            let lookup = |s: &str| self.raw_grammars.get(s);
            let injections_for = |s: &str| self.injection_scopes.get(s).map(Vec::as_slice);
            processor
                .process_queue(&lookup, &injections_for)
                .map_err(|_| ShikiError::MissingGrammar(initial_scope_name.to_string()))?;
        }
        Ok(())
    }
}
