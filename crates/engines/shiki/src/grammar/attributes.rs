use std::collections::BTreeMap;
use std::sync::RwLock;

use rustc_hash::FxHashMap;

use crate::encoded_attrs::{OptionalStandardTokenType, StandardTokenType};
use crate::matcher::{InjectionPriority, SelectorExpr, create_matchers};
use crate::rule::RuleId;

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

pub(super) struct TokenTypeMatcher {
    pub(super) matcher: SelectorExpr,
    pub(super) token_type: StandardTokenType,
}

/// Compiled injection rule attached to a [`super::Grammar`].
pub struct Injection {
    pub debug_selector: String,
    pub matcher: SelectorExpr,
    pub priority: InjectionPriority,
    pub rule_id: RuleId,
}
