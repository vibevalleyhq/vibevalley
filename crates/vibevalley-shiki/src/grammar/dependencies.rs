use std::collections::{BTreeMap, HashSet};

use crate::raw_grammar::{RawGrammar, RawRule};

/// Parsed form of a TextMate `include` directive.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum IncludeReference {
    /// `$base`
    Base,
    /// `$self`
    SelfRef,
    /// `#ruleName`
    Relative(String),
    /// `source.ts`
    TopLevel(String),
    /// `source.ts#ruleName`
    TopLevelRepository { scope_name: String, rule_name: String },
}

/// Parses a TextMate `include` string into a typed [`IncludeReference`].
pub fn parse_include(include: &str) -> IncludeReference {
    if include == "$base" {
        return IncludeReference::Base;
    }
    if include == "$self" {
        return IncludeReference::SelfRef;
    }
    match include.find('#') {
        None => IncludeReference::TopLevel(include.to_string()),
        Some(0) => IncludeReference::Relative(include[1..].to_string()),
        Some(sharp) => IncludeReference::TopLevelRepository {
            scope_name: include[..sharp].to_string(),
            rule_name: include[sharp + 1..].to_string(),
        },
    }
}

/// Absolute reference to an external grammar or one of its repository entries.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum AbsoluteRuleReference {
    TopLevel(String),
    TopLevelRepository { scope_name: String, rule_name: String },
}

impl AbsoluteRuleReference {
    pub fn scope_name(&self) -> &str {
        match self {
            Self::TopLevel(scope) => scope,
            Self::TopLevelRepository { scope_name, .. } => scope_name,
        }
    }

    pub fn to_key(&self) -> String {
        match self {
            Self::TopLevel(scope) => scope.clone(),
            Self::TopLevelRepository { scope_name, rule_name } => format!("{scope_name}#{rule_name}"),
        }
    }
}

/// Collects transitive external grammar dependencies referenced by a root grammar,
/// matching `vscode-textmate`'s `ScopeDependencyProcessor`.
pub struct ScopeDependencyProcessor {
    seen_full_scopes: HashSet<String>,
    seen_partial_scopes: HashSet<String>,
    pub queue: Vec<AbsoluteRuleReference>,
    initial_scope_name: String,
}

impl ScopeDependencyProcessor {
    pub fn new(initial_scope_name: String) -> Self {
        let mut seen_full_scopes = HashSet::new();
        seen_full_scopes.insert(initial_scope_name.clone());
        let queue = vec![AbsoluteRuleReference::TopLevel(initial_scope_name.clone())];
        Self {
            seen_full_scopes,
            seen_partial_scopes: HashSet::new(),
            queue,
            initial_scope_name,
        }
    }

    pub fn process_queue<'a>(
        &mut self,
        lookup: &impl Fn(&str) -> Option<&'a RawGrammar>,
        injections_for: &impl Fn(&str) -> Option<&'a [String]>,
    ) -> Result<(), String> {
        let batch = std::mem::take(&mut self.queue);
        let mut collector = ExternalReferenceCollector::default();

        for dep in &batch {
            collect_references_of(dep, &self.initial_scope_name, lookup, injections_for, &mut collector)?;
        }

        for dep in collector.references {
            match &dep {
                AbsoluteRuleReference::TopLevel(scope) => {
                    if self.seen_full_scopes.insert(scope.clone()) {
                        self.queue.push(dep);
                    }
                }
                AbsoluteRuleReference::TopLevelRepository { scope_name, .. } => {
                    if self.seen_full_scopes.contains(scope_name) {
                        continue;
                    }
                    if self.seen_partial_scopes.insert(dep.to_key()) {
                        self.queue.push(dep);
                    }
                }
            }
        }
        Ok(())
    }
}

#[derive(Default)]
struct ExternalReferenceCollector {
    references: Vec<AbsoluteRuleReference>,
    seen_keys: HashSet<String>,
    visited_ptrs: HashSet<usize>,
}

impl ExternalReferenceCollector {
    fn add(&mut self, reference: AbsoluteRuleReference) {
        let key = reference.to_key();
        if self.seen_keys.insert(key) {
            self.references.push(reference);
        }
    }
}

fn collect_references_of<'a>(
    reference: &AbsoluteRuleReference,
    base_scope: &str,
    lookup: &impl Fn(&str) -> Option<&'a RawGrammar>,
    injections_for: &impl Fn(&str) -> Option<&'a [String]>,
    out: &mut ExternalReferenceCollector,
) -> Result<(), String> {
    let scope_name = reference.scope_name();
    let Some(self_grammar) = lookup(scope_name) else {
        if scope_name == base_scope {
            return Err(format!("No grammar provided for <{base_scope}>"));
        }
        return Ok(());
    };
    let Some(base_grammar) = lookup(base_scope) else {
        return Err(format!("No grammar provided for <{base_scope}>"));
    };

    match reference {
        AbsoluteRuleReference::TopLevel(_) => {
            collect_in_top_level_rule(base_grammar, self_grammar, out);
        }
        AbsoluteRuleReference::TopLevelRepository { rule_name, .. } => {
            collect_in_repo_rule(rule_name, base_grammar, self_grammar, &repo_refs(&self_grammar.repository), out);
        }
    }

    if let Some(injections) = injections_for(scope_name) {
        for inj in injections {
            out.add(AbsoluteRuleReference::TopLevel(inj.clone()));
        }
    }

    Ok(())
}

fn repo_refs(repo: &BTreeMap<String, RawRule>) -> BTreeMap<&str, &RawRule> {
    repo.iter().map(|(k, v)| (k.as_str(), v)).collect()
}

fn collect_in_top_level_rule<'a>(base_grammar: &'a RawGrammar, self_grammar: &'a RawGrammar, out: &mut ExternalReferenceCollector) {
    let repo = repo_refs(&self_grammar.repository);
    collect_in_rules(&self_grammar.patterns, base_grammar, self_grammar, &repo, out);
    for inj_rule in self_grammar.injections.values() {
        collect_in_single_rule(inj_rule, base_grammar, self_grammar, &repo, out);
    }
}

fn collect_in_repo_rule<'a>(
    rule_name: &str,
    base_grammar: &'a RawGrammar,
    self_grammar: &'a RawGrammar,
    repo: &BTreeMap<&'a str, &'a RawRule>,
    out: &mut ExternalReferenceCollector,
) {
    if let Some(&rule) = repo.get(rule_name) {
        collect_in_single_rule(rule, base_grammar, self_grammar, repo, out);
    }
}

fn collect_in_rules<'a>(
    rules: &'a [RawRule],
    base_grammar: &'a RawGrammar,
    self_grammar: &'a RawGrammar,
    repo: &BTreeMap<&'a str, &'a RawRule>,
    out: &mut ExternalReferenceCollector,
) {
    for rule in rules {
        collect_in_single_rule(rule, base_grammar, self_grammar, repo, out);
    }
}

fn collect_in_single_rule<'a>(
    rule: &'a RawRule,
    base_grammar: &'a RawGrammar,
    self_grammar: &'a RawGrammar,
    repo: &BTreeMap<&'a str, &'a RawRule>,
    out: &mut ExternalReferenceCollector,
) {
    let ptr = rule as *const RawRule as usize;
    if !out.visited_ptrs.insert(ptr) {
        return;
    }

    let merged_storage;
    let active_repo = if let Some(local_repo) = &rule.repository {
        let mut merged = repo.clone();
        for (k, v) in local_repo {
            merged.insert(k.as_str(), v);
        }
        merged_storage = merged;
        &merged_storage
    } else {
        repo
    };

    if let Some(patterns) = &rule.patterns {
        collect_in_rules(patterns, base_grammar, self_grammar, active_repo, out);
    }

    for captures in [&rule.captures, &rule.begin_captures, &rule.end_captures, &rule.while_captures]
        .into_iter()
        .flatten()
    {
        for cap_rule in captures.values() {
            collect_in_single_rule(cap_rule, base_grammar, self_grammar, active_repo, out);
        }
    }

    let Some(include) = &rule.include else {
        return;
    };

    match parse_include(include) {
        IncludeReference::Base => {
            collect_in_top_level_rule(base_grammar, base_grammar, out);
        }
        IncludeReference::SelfRef => {
            collect_in_top_level_rule(base_grammar, self_grammar, out);
        }
        IncludeReference::Relative(rule_name) => {
            collect_in_repo_rule(&rule_name, base_grammar, self_grammar, active_repo, out);
        }
        IncludeReference::TopLevel(scope_name) => {
            if scope_name == self_grammar.scope_name {
                collect_in_top_level_rule(base_grammar, self_grammar, out);
            } else if scope_name == base_grammar.scope_name {
                collect_in_top_level_rule(base_grammar, base_grammar, out);
            } else {
                out.add(AbsoluteRuleReference::TopLevel(scope_name));
            }
        }
        IncludeReference::TopLevelRepository { scope_name, rule_name } => {
            if scope_name == self_grammar.scope_name {
                collect_in_repo_rule(&rule_name, base_grammar, self_grammar, active_repo, out);
            } else if scope_name == base_grammar.scope_name {
                collect_in_repo_rule(&rule_name, base_grammar, base_grammar, &repo_refs(&base_grammar.repository), out);
            } else {
                out.add(AbsoluteRuleReference::TopLevelRepository { scope_name, rule_name });
            }
        }
    }
}
