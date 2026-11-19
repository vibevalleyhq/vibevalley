use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Arc, OnceLock, RwLock};

use rustc_hash::{FxHashMap, FxHashSet};

use crate::error::RegexError;
use crate::grammar::dependencies::{IncludeReference, parse_include};
use crate::raw_grammar::{RawGrammar, RawRule};
use crate::regex_engine::{CaptureIndex, FindOption, RegexEngine, RegexScanner, ScannerMatch};

static NEXT_COMPILED_RULE_ID: AtomicU64 = AtomicU64::new(1);

const MAX_DYNAMIC_BACKREF_CACHE: usize = 256;

/// 1-based identifier of a compiled TextMate rule within a `Grammar`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct RuleId(pub u32);

/// Outcome target of a regex pattern inside a `CompiledRule`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MatchTarget {
    Rule(RuleId),
    End,
    While,
}

/// Result of scanning a line against a `CompiledRule`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FindNextMatchResult {
    pub target: MatchTarget,
    pub capture_indices: Vec<Option<CaptureIndex>>,
}

/// Compiled multi-pattern scanner together with the `MatchTarget` corresponding to each pattern.
pub struct CompiledRule<E: RegexEngine> {
    pub id: u64,
    scanner: E::Scanner,
    targets: Vec<MatchTarget>,
}

impl<E: RegexEngine> CompiledRule<E> {
    pub fn compile(engine: &E, patterns: &[String], targets: Vec<MatchTarget>) -> Result<Self, RegexError> {
        let scanner = engine.create_scanner(patterns)?;
        Ok(Self {
            id: NEXT_COMPILED_RULE_ID.fetch_add(1, AtomicOrdering::Relaxed),
            scanner,
            targets,
        })
    }

    pub fn create_cache(&self) -> <E::Scanner as RegexScanner>::Cache {
        self.scanner.create_cache()
    }

    pub fn find_next_match(
        &self,
        haystack: &E::String,
        start_byte: usize,
        options: FindOption,
        cache: &mut <E::Scanner as RegexScanner>::Cache,
    ) -> Option<FindNextMatchResult> {
        let ScannerMatch { index, capture_indices } = self.scanner.find_next_match(haystack, start_byte, options, cache)?;
        let target = *self.targets.get(index)?;
        Some(FindNextMatchResult { target, capture_indices })
    }
}

/// Template for rule `name` or `contentName` supporting `$N`, `${N:/downcase}`, and `${N:/upcase}`.
#[derive(Debug, Clone)]
pub struct NameTemplate {
    raw: Option<String>,
    has_captures: bool,
}

impl NameTemplate {
    pub fn new(raw: Option<String>) -> Self {
        let raw = raw.filter(|s| !s.is_empty());
        let has_captures = raw.as_deref().is_some_and(has_name_captures);
        Self { raw, has_captures }
    }

    pub fn resolve(&self, line_text: Option<&str>, captures: Option<&[Option<CaptureIndex>]>) -> Option<String> {
        let template = self.raw.as_deref()?;
        if !self.has_captures {
            return Some(template.to_string());
        }
        let (Some(line_text), Some(captures)) = (line_text, captures) else {
            return Some(template.to_string());
        };
        Some(replace_name_captures(template, line_text, captures))
    }
}

/// Checks for `$N` or `${N:/downcase|upcase}` placeholders in a scope name template.
pub fn has_name_captures(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'$' {
            if i + 1 < bytes.len() && bytes[i + 1].is_ascii_digit() {
                return true;
            }
            if parse_braced_capture(text, i).is_some() {
                return true;
            }
        }
        i += 1;
    }
    false
}

/// Substitutes `$N`, `${N:/downcase}`, and `${N:/upcase}` placeholders in a scope name template,
/// matching `vscode-textmate`'s `RegexSource.replaceCaptures`.
pub fn replace_name_captures(template: &str, capture_source: &str, captures: &[Option<CaptureIndex>]) -> String {
    let bytes = template.as_bytes();
    let mut out = String::with_capacity(template.len());
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == b'$' {
            if i + 1 < bytes.len() && bytes[i + 1].is_ascii_digit() {
                let start = i;
                let mut j = i + 1;
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
                if let Ok(index) = template[i + 1..j].parse::<usize>()
                    && let Some(cap_opt) = captures.get(index)
                {
                    let slice = cap_opt.and_then(|c| capture_source.get(c.start..c.end)).unwrap_or("");
                    out.push_str(slice.trim_start_matches('.'));
                    i = j;
                    continue;
                }
                out.push_str(&template[start..j]);
                i = j;
                continue;
            }
            if let Some((end_idx, index, transform)) = parse_braced_capture(template, i) {
                if let Some(cap_opt) = captures.get(index) {
                    let slice = cap_opt.and_then(|c| capture_source.get(c.start..c.end)).unwrap_or("").trim_start_matches('.');
                    match transform {
                        CaseTransform::Downcase => out.push_str(&slice.to_lowercase()),
                        CaseTransform::Upcase => out.push_str(&slice.to_uppercase()),
                    }
                } else {
                    out.push_str(&template[i..end_idx]);
                }
                i = end_idx;
                continue;
            }
        }
        let ch = template[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }

    out
}

#[derive(Clone, Copy)]
enum CaseTransform {
    Downcase,
    Upcase,
}

fn parse_braced_capture(s: &str, start: usize) -> Option<(usize, usize, CaseTransform)> {
    let rest = s.get(start..)?.strip_prefix("${")?;
    let digits_end = rest.bytes().take_while(u8::is_ascii_digit).count();
    if digits_end == 0 {
        return None;
    }
    let index = rest[..digits_end].parse::<usize>().ok()?;
    let after_digits = &rest[digits_end..];
    if let Some(rem) = after_digits.strip_prefix(":/downcase}") {
        let consumed = s.len() - start - rem.len();
        Some((start + consumed, index, CaseTransform::Downcase))
    } else if let Some(rem) = after_digits.strip_prefix(":/upcase}") {
        let consumed = s.len() - start - rem.len();
        Some((start + consumed, index, CaseTransform::Upcase))
    } else {
        None
    }
}

/// Escapes regex metacharacters identically to `vscode-textmate`'s `escapeRegExpCharacters`.
pub fn escape_regexp_characters(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if matches!(ch, '\\' | '|' | '(' | '[' | '{' | '}' | ']' | ')' | '.' | '?' | '*' | '+' | '^' | '$') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

#[derive(Debug, Clone)]
struct AnchorCache {
    a0_g0: String,
    a0_g1: String,
    a1_g0: String,
    a1_g1: String,
}

/// TextMate regex source with `\z` rewriting, `\A`/`\G` anchor caching, and `\N` backreference resolution.
#[derive(Debug, Clone)]
pub struct RegExpSource {
    pub source: String,
    pub target: MatchTarget,
    pub has_anchor: bool,
    pub has_back_references: bool,
    anchor_cache: Option<AnchorCache>,
}

impl RegExpSource {
    pub fn new(raw_source: &str, target: MatchTarget) -> Self {
        let (source, has_anchor) = rewrite_z_and_detect_anchors(raw_source);
        let anchor_cache = if has_anchor { Some(build_anchor_cache(&source)) } else { None };
        let has_back_references = has_back_references(&source);
        Self {
            source,
            target,
            has_anchor,
            has_back_references,
            anchor_cache,
        }
    }

    pub fn with_resolved_source(&self, resolved: String) -> Self {
        let has_anchor = self.has_anchor || detect_anchors(&resolved);
        let anchor_cache = if has_anchor { Some(build_anchor_cache(&resolved)) } else { None };
        Self {
            source: resolved,
            target: self.target,
            has_anchor,
            has_back_references: false,
            anchor_cache,
        }
    }

    pub fn resolve_back_references(&self, line_text: &str, captures: &[Option<CaptureIndex>]) -> String {
        let bytes = self.source.as_bytes();
        let mut out = String::with_capacity(self.source.len());
        let mut i = 0;

        while i < bytes.len() {
            if bytes[i] == b'\\' && i + 1 < bytes.len() && bytes[i + 1].is_ascii_digit() {
                let mut j = i + 1;
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
                if let Ok(index) = self.source[i + 1..j].parse::<usize>() {
                    let captured = captures.get(index).copied().flatten().and_then(|c| line_text.get(c.start..c.end)).unwrap_or("");
                    out.push_str(&escape_regexp_characters(captured));
                    i = j;
                    continue;
                }
            }
            let ch = self.source[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }

        out
    }

    pub fn resolve_anchors(&self, allow_a: bool, allow_g: bool) -> &str {
        let Some(cache) = &self.anchor_cache else {
            return &self.source;
        };
        match (allow_a, allow_g) {
            (false, false) => &cache.a0_g0,
            (false, true) => &cache.a0_g1,
            (true, false) => &cache.a1_g0,
            (true, true) => &cache.a1_g1,
        }
    }
}

fn rewrite_z_and_detect_anchors(raw: &str) -> (String, bool) {
    if raw.is_empty() {
        return (String::new(), false);
    }
    let bytes = raw.as_bytes();
    let len = bytes.len();
    let mut out = String::new();
    let mut last_pushed = 0;
    let mut has_anchor = false;
    let mut pos = 0;

    while pos < len {
        if bytes[pos] == b'\\' && pos + 1 < len {
            match bytes[pos + 1] {
                b'z' => {
                    out.push_str(&raw[last_pushed..pos]);
                    out.push_str(r"$(?!\n)(?<!\n)");
                    last_pushed = pos + 2;
                    pos += 2;
                    continue;
                }
                b'A' | b'G' => {
                    has_anchor = true;
                    pos += 2;
                    continue;
                }
                _ => {
                    let ch = raw[pos + 1..].chars().next().unwrap();
                    pos += 1 + ch.len_utf8();
                    continue;
                }
            }
        }
        let ch = raw[pos..].chars().next().unwrap();
        pos += ch.len_utf8();
    }

    if last_pushed == 0 {
        (raw.to_string(), has_anchor)
    } else {
        out.push_str(&raw[last_pushed..]);
        (out, has_anchor)
    }
}

fn detect_anchors(source: &str) -> bool {
    let bytes = source.as_bytes();
    let mut pos = 0;
    while pos < bytes.len() {
        if bytes[pos] == b'\\' && pos + 1 < bytes.len() {
            if matches!(bytes[pos + 1], b'A' | b'G') {
                return true;
            }
            let ch = source[pos + 1..].chars().next().unwrap();
            pos += 1 + ch.len_utf8();
            continue;
        }
        let ch = source[pos..].chars().next().unwrap();
        pos += ch.len_utf8();
    }
    false
}

fn has_back_references(source: &str) -> bool {
    let bytes = source.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'\\' && bytes[i + 1].is_ascii_digit() {
            return true;
        }
        i += 1;
    }
    false
}

fn build_anchor_cache(source: &str) -> AnchorCache {
    // Disabling `\A` or `\G` replaces the 2-byte escape with literal U+FFFF (without a
    // leading backslash), which never occurs in normal source text and compiles cleanly
    // in both Oniguruma and strict Rust regex parsers.
    const NEVER_CHAR: char = '\u{FFFF}';

    let mut a0_g0 = String::with_capacity(source.len());
    let mut a0_g1 = String::with_capacity(source.len());
    let mut a1_g0 = String::with_capacity(source.len());
    let mut a1_g1 = String::with_capacity(source.len());

    let bytes = source.as_bytes();
    let mut pos = 0;
    while pos < bytes.len() {
        if bytes[pos] == b'\\' && pos + 1 < bytes.len() {
            match bytes[pos + 1] {
                b'A' => {
                    a0_g0.push(NEVER_CHAR);
                    a0_g1.push(NEVER_CHAR);
                    a1_g0.push_str(r"\A");
                    a1_g1.push_str(r"\A");
                    pos += 2;
                    continue;
                }
                b'G' => {
                    a0_g0.push(NEVER_CHAR);
                    a0_g1.push_str(r"\G");
                    a1_g0.push(NEVER_CHAR);
                    a1_g1.push_str(r"\G");
                    pos += 2;
                    continue;
                }
                _ => {
                    let ch = source[pos + 1..].chars().next().unwrap();
                    for buf in [&mut a0_g0, &mut a0_g1, &mut a1_g0, &mut a1_g1] {
                        buf.push('\\');
                        buf.push(ch);
                    }
                    pos += 1 + ch.len_utf8();
                    continue;
                }
            }
        }
        let ch = source[pos..].chars().next().unwrap();
        for buf in [&mut a0_g0, &mut a0_g1, &mut a1_g0, &mut a1_g1] {
            buf.push(ch);
        }
        pos += ch.len_utf8();
    }

    AnchorCache { a0_g0, a0_g1, a1_g0, a1_g1 }
}

type DynamicRuleCache<E> = RwLock<FxHashMap<(String, u8), Arc<CompiledRule<E>>>>;

/// Ordered list of regex sources with lazy compilation and 4-slot anchor caching.
pub struct CompiledSourceCache<E: RegexEngine> {
    items: OnceLock<(Vec<RegExpSource>, bool)>,
    plain: OnceLock<Result<Arc<CompiledRule<E>>, RegexError>>,
    anchors: [OnceLock<Result<Arc<CompiledRule<E>>, RegexError>>; 4],
    dynamic: DynamicRuleCache<E>,
}

impl<E: RegexEngine> Default for CompiledSourceCache<E> {
    fn default() -> Self {
        Self {
            items: OnceLock::new(),
            plain: OnceLock::new(),
            anchors: [const { OnceLock::new() }; 4],
            dynamic: RwLock::new(FxHashMap::default()),
        }
    }
}

impl<E: RegexEngine> CompiledSourceCache<E> {
    fn get_or_init_items(&self, build: impl FnOnce() -> Vec<RegExpSource>) -> &(Vec<RegExpSource>, bool) {
        self.items.get_or_init(|| {
            let list = build();
            let has_anchors = list.iter().any(|item| item.has_anchor);
            (list, has_anchors)
        })
    }

    pub fn compile_static(
        &self,
        engine: &E,
        allow_a: bool,
        allow_g: bool,
        use_find_options: bool,
        build: impl FnOnce() -> Vec<RegExpSource>,
    ) -> Result<Arc<CompiledRule<E>>, RegexError> {
        let (list, has_anchors) = self.get_or_init_items(build);
        if use_find_options || !*has_anchors {
            return self
                .plain
                .get_or_init(|| {
                    let patterns: Vec<String> = list.iter().map(|s| s.source.clone()).collect();
                    let targets: Vec<MatchTarget> = list.iter().map(|s| s.target).collect();
                    CompiledRule::compile(engine, &patterns, targets).map(Arc::new)
                })
                .clone();
        }
        let slot = anchor_slot(allow_a, allow_g);
        self.anchors[slot]
            .get_or_init(|| {
                let patterns: Vec<String> = list.iter().map(|s| s.resolve_anchors(allow_a, allow_g).to_string()).collect();
                let targets: Vec<MatchTarget> = list.iter().map(|s| s.target).collect();
                CompiledRule::compile(engine, &patterns, targets).map(Arc::new)
            })
            .clone()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn compile_dynamic(
        &self,
        engine: &E,
        dynamic_is_last: bool,
        resolved_source: &str,
        allow_a: bool,
        allow_g: bool,
        use_find_options: bool,
        build: impl FnOnce() -> Vec<RegExpSource>,
    ) -> Result<Arc<CompiledRule<E>>, RegexError> {
        let (base_list, base_has_anchors) = self.get_or_init_items(build);
        let dynamic_index = if dynamic_is_last { base_list.len() - 1 } else { 0 };
        let resolved_item = base_list[dynamic_index].with_resolved_source(resolved_source.to_string());
        let has_anchors = *base_has_anchors || resolved_item.has_anchor;
        let slot = if use_find_options || !has_anchors {
            4u8
        } else {
            anchor_slot(allow_a, allow_g) as u8
        };

        let key = (resolved_source.to_string(), slot);
        if let Ok(guard) = self.dynamic.read()
            && let Some(hit) = guard.get(&key)
        {
            return Ok(Arc::clone(hit));
        }

        let mut patterns = Vec::with_capacity(base_list.len());
        let mut targets = Vec::with_capacity(base_list.len());
        for (idx, item) in base_list.iter().enumerate() {
            let src = if idx == dynamic_index { &resolved_item } else { item };
            let pat = if slot == 4 {
                src.source.clone()
            } else {
                src.resolve_anchors(allow_a, allow_g).to_string()
            };
            patterns.push(pat);
            targets.push(src.target);
        }

        let compiled = Arc::new(CompiledRule::compile(engine, &patterns, targets)?);
        if let Ok(mut guard) = self.dynamic.write() {
            if guard.len() >= MAX_DYNAMIC_BACKREF_CACHE {
                guard.clear();
            }
            guard.insert(key, Arc::clone(&compiled));
        }
        Ok(compiled)
    }
}

const fn anchor_slot(allow_a: bool, allow_g: bool) -> usize {
    ((allow_a as usize) << 1) | (allow_g as usize)
}

/// Capture rule associated with a numbered capture group in `match`, `begin`, `end`, or `while`.
#[derive(Debug, Clone)]
pub struct CaptureRule {
    pub id: RuleId,
    pub name: NameTemplate,
    pub content_name: NameTemplate,
    pub retokenize_captured_with_rule_id: Option<RuleId>,
}

/// Single-regex match rule (`match` + `captures`).
pub struct MatchRule<E: RegexEngine> {
    pub id: RuleId,
    pub name: NameTemplate,
    pub match_source: RegExpSource,
    pub captures: Vec<Option<CaptureRule>>,
    cache: CompiledSourceCache<E>,
}

/// Grouping / include-only rule (`patterns` without `match`/`begin`).
pub struct IncludeOnlyRule<E: RegexEngine> {
    pub id: RuleId,
    pub name: NameTemplate,
    pub content_name: NameTemplate,
    pub patterns: Vec<RuleId>,
    pub has_missing_patterns: bool,
    cache: CompiledSourceCache<E>,
}

/// Region rule delimited by `begin` and `end` patterns.
pub struct BeginEndRule<E: RegexEngine> {
    pub id: RuleId,
    pub name: NameTemplate,
    pub content_name: NameTemplate,
    pub begin: RegExpSource,
    pub begin_captures: Vec<Option<CaptureRule>>,
    pub end: RegExpSource,
    pub end_has_back_references: bool,
    pub end_captures: Vec<Option<CaptureRule>>,
    pub apply_end_pattern_last: bool,
    pub patterns: Vec<RuleId>,
    pub has_missing_patterns: bool,
    cache: CompiledSourceCache<E>,
}

/// Multi-line region rule opened by `begin` and kept alive each line while `while` matches.
pub struct BeginWhileRule<E: RegexEngine> {
    pub id: RuleId,
    pub name: NameTemplate,
    pub content_name: NameTemplate,
    pub begin: RegExpSource,
    pub begin_captures: Vec<Option<CaptureRule>>,
    pub while_source: RegExpSource,
    pub while_has_back_references: bool,
    pub while_captures: Vec<Option<CaptureRule>>,
    pub patterns: Vec<RuleId>,
    pub has_missing_patterns: bool,
    cache: CompiledSourceCache<E>,
    while_cache: CompiledSourceCache<E>,
}

/// Closed union of all compiled TextMate rules inside a `Grammar`.
pub enum Rule<E: RegexEngine> {
    Capture(CaptureRule),
    Match(Box<MatchRule<E>>),
    IncludeOnly(Box<IncludeOnlyRule<E>>),
    BeginEnd(Box<BeginEndRule<E>>),
    BeginWhile(Box<BeginWhileRule<E>>),
}

impl<E: RegexEngine> Rule<E> {
    pub fn id(&self) -> RuleId {
        match self {
            Rule::Capture(r) => r.id,
            Rule::Match(r) => r.id,
            Rule::IncludeOnly(r) => r.id,
            Rule::BeginEnd(r) => r.id,
            Rule::BeginWhile(r) => r.id,
        }
    }

    pub fn name(&self, line_text: Option<&str>, captures: Option<&[Option<CaptureIndex>]>) -> Option<String> {
        match self {
            Rule::Capture(r) => r.name.resolve(line_text, captures),
            Rule::Match(r) => r.name.resolve(line_text, captures),
            Rule::IncludeOnly(r) => r.name.resolve(line_text, captures),
            Rule::BeginEnd(r) => r.name.resolve(line_text, captures),
            Rule::BeginWhile(r) => r.name.resolve(line_text, captures),
        }
    }

    pub fn collect_patterns(&self, rules: &[Rule<E>], out: &mut Vec<RegExpSource>, visiting: &mut FxHashSet<RuleId>) {
        match self {
            Rule::Capture(_) => {}
            Rule::Match(r) => out.push(r.match_source.clone()),
            Rule::BeginEnd(r) => out.push(r.begin.clone()),
            Rule::BeginWhile(r) => out.push(r.begin.clone()),
            Rule::IncludeOnly(r) => {
                if !visiting.insert(r.id) {
                    return;
                }
                for &pat_id in &r.patterns {
                    if let Some(child) = rules.get((pat_id.0 - 1) as usize) {
                        child.collect_patterns(rules, out, visiting);
                    }
                }
                visiting.remove(&r.id);
            }
        }
    }

    pub fn compile_for_search(
        &self,
        rules: &[Rule<E>],
        engine: &E,
        end_regex_source: Option<&str>,
        allow_a: bool,
        allow_g: bool,
    ) -> Result<Arc<CompiledRule<E>>, RegexError> {
        let use_find_options = engine.supports_find_options();
        match self {
            Rule::Capture(_) => Err(RegexError::Exec {
                message: "CaptureRule cannot be compiled as a search rule".to_string(),
            }),
            Rule::Match(r) => r
                .cache
                .compile_static(engine, allow_a, allow_g, use_find_options, || vec![r.match_source.clone()]),
            Rule::IncludeOnly(r) => r.cache.compile_static(engine, allow_a, allow_g, use_find_options, || {
                let mut out = Vec::new();
                let mut visiting = FxHashSet::default();
                visiting.insert(r.id);
                for &pat_id in &r.patterns {
                    if let Some(child) = rules.get((pat_id.0 - 1) as usize) {
                        child.collect_patterns(rules, &mut out, &mut visiting);
                    }
                }
                out
            }),
            Rule::BeginEnd(r) => {
                let build = || {
                    let mut out = Vec::new();
                    let mut visiting = FxHashSet::default();
                    for &pat_id in &r.patterns {
                        if let Some(child) = rules.get((pat_id.0 - 1) as usize) {
                            child.collect_patterns(rules, &mut out, &mut visiting);
                        }
                    }
                    if r.apply_end_pattern_last {
                        out.push(r.end.clone());
                    } else {
                        out.insert(0, r.end.clone());
                    }
                    out
                };

                if r.end_has_back_references {
                    let resolved = end_regex_source.unwrap_or(&r.end.source);
                    r.cache
                        .compile_dynamic(engine, r.apply_end_pattern_last, resolved, allow_a, allow_g, use_find_options, build)
                } else {
                    r.cache.compile_static(engine, allow_a, allow_g, use_find_options, build)
                }
            }
            Rule::BeginWhile(r) => r.cache.compile_static(engine, allow_a, allow_g, use_find_options, || {
                let mut out = Vec::new();
                let mut visiting = FxHashSet::default();
                for &pat_id in &r.patterns {
                    if let Some(child) = rules.get((pat_id.0 - 1) as usize) {
                        child.collect_patterns(rules, &mut out, &mut visiting);
                    }
                }
                out
            }),
        }
    }
}

impl<E: RegexEngine> BeginWhileRule<E> {
    pub fn compile_while(&self, engine: &E, while_regex_source: Option<&str>, allow_a: bool, allow_g: bool) -> Result<Arc<CompiledRule<E>>, RegexError> {
        let use_find_options = engine.supports_find_options();
        let build = || vec![self.while_source.clone()];
        if self.while_has_back_references {
            let resolved = while_regex_source.unwrap_or("");
            self.while_cache
                .compile_dynamic(engine, false, resolved, allow_a, allow_g, use_find_options, build)
        } else {
            self.while_cache.compile_static(engine, allow_a, allow_g, use_find_options, build)
        }
    }
}

/// Unique node identifier assigned to every `RawRule` within a `PreparedGrammar` arena
/// so recursive/shared includes compile once identically to `vscode-textmate`'s `desc.id`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct RawNodeId(u32);

#[derive(Debug, Clone)]
pub(crate) struct PreparedRule {
    pub node_id: RawNodeId,
    pub include: Option<String>,
    pub name: Option<String>,
    pub content_name: Option<String>,
    pub match_pattern: Option<String>,
    pub captures: Option<BTreeMap<usize, PreparedRule>>,
    pub begin: Option<String>,
    pub begin_captures: Option<BTreeMap<usize, PreparedRule>>,
    pub end: Option<String>,
    pub end_captures: Option<BTreeMap<usize, PreparedRule>>,
    pub while_pattern: Option<String>,
    pub while_captures: Option<BTreeMap<usize, PreparedRule>>,
    pub patterns: Option<Vec<PreparedRule>>,
    pub repository: Option<BTreeMap<String, PreparedRule>>,
    pub apply_end_pattern_last: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedGrammar {
    pub injection_selector: Option<String>,
    pub repository: BTreeMap<String, PreparedRule>,
    pub injections: BTreeMap<String, PreparedRule>,
}

/// Repository map passed during rule compilation (`$self`, `$base`, and named rules).
type RepoScope = BTreeMap<String, PreparedRule>;

/// Compiles raw grammars (root + transitive external grammars + injections) into a flat
/// arena of `Rule<E>` indexed by 1-based `RuleId`.
pub(crate) struct RuleCompiler<'a, E: RegexEngine> {
    next_raw_node: u32,
    compiled_by_node: FxHashMap<RawNodeId, RuleId>,
    slots: Vec<Option<Rule<E>>>,
    included_grammars: BTreeMap<String, PreparedGrammar>,
    lookup: &'a dyn Fn(&str) -> Option<&'a RawGrammar>,
}

impl<'a, E: RegexEngine> RuleCompiler<'a, E> {
    pub fn new(lookup: &'a dyn Fn(&str) -> Option<&'a RawGrammar>) -> Self {
        Self {
            next_raw_node: 1,
            compiled_by_node: FxHashMap::default(),
            slots: Vec::new(),
            included_grammars: BTreeMap::new(),
            lookup,
        }
    }

    pub fn prepare_grammar(&mut self, raw: &RawGrammar, base: Option<PreparedRule>) -> PreparedGrammar {
        let mut repository = BTreeMap::new();
        for (k, v) in &raw.repository {
            repository.insert(k.clone(), self.prepare_rule(v));
        }

        let patterns: Vec<PreparedRule> = raw.patterns.iter().map(|r| self.prepare_rule(r)).collect();
        let self_rule = PreparedRule {
            node_id: self.alloc_node(),
            include: None,
            name: Some(raw.scope_name.clone()),
            content_name: None,
            match_pattern: None,
            captures: None,
            begin: None,
            begin_captures: None,
            end: None,
            end_captures: None,
            while_pattern: None,
            while_captures: None,
            patterns: Some(patterns),
            repository: None,
            apply_end_pattern_last: false,
        };
        let base_rule = base.unwrap_or_else(|| self_rule.clone());
        repository.insert("$self".to_string(), self_rule);
        repository.insert("$base".to_string(), base_rule);

        let mut injections = BTreeMap::new();
        for (selector, rule) in &raw.injections {
            injections.insert(selector.clone(), self.prepare_rule(rule));
        }

        PreparedGrammar {
            injection_selector: raw.injection_selector.clone(),
            repository,
            injections,
        }
    }

    fn alloc_node(&mut self) -> RawNodeId {
        let id = RawNodeId(self.next_raw_node);
        self.next_raw_node += 1;
        id
    }

    fn prepare_rule(&mut self, raw: &RawRule) -> PreparedRule {
        let node_id = self.alloc_node();
        let captures = raw.captures.as_ref().map(|m| self.prepare_captures(m));
        let begin_captures = raw.begin_captures.as_ref().map(|m| self.prepare_captures(m));
        let end_captures = raw.end_captures.as_ref().map(|m| self.prepare_captures(m));
        let while_captures = raw.while_captures.as_ref().map(|m| self.prepare_captures(m));
        let patterns = raw.patterns.as_ref().map(|list| list.iter().map(|r| self.prepare_rule(r)).collect());
        let repository = raw
            .repository
            .as_ref()
            .map(|map| map.iter().map(|(k, v)| (k.clone(), self.prepare_rule(v))).collect());

        PreparedRule {
            node_id,
            include: raw.include.clone(),
            name: raw.name.clone(),
            content_name: raw.content_name.clone(),
            match_pattern: raw.match_pattern.clone(),
            captures,
            begin: raw.begin.clone(),
            begin_captures,
            end: raw.end.clone(),
            end_captures,
            while_pattern: raw.while_pattern.clone(),
            while_captures,
            patterns,
            repository,
            apply_end_pattern_last: raw.apply_end_pattern_last,
        }
    }

    fn prepare_captures(&mut self, raw: &BTreeMap<usize, RawRule>) -> BTreeMap<usize, PreparedRule> {
        raw.iter().map(|(&idx, r)| (idx, self.prepare_rule(r))).collect()
    }

    pub fn get_external_grammar(&mut self, scope_name: &str, repository: Option<&RepoScope>) -> Option<PreparedGrammar> {
        if let Some(existing) = self.included_grammars.get(scope_name) {
            return Some(existing.clone());
        }
        let raw = (self.lookup)(scope_name)?;
        let base = repository.and_then(|repo| repo.get("$base").cloned());
        let prepared = self.prepare_grammar(raw, base);
        self.included_grammars.insert(scope_name.to_string(), prepared.clone());
        Some(prepared)
    }

    fn reserve_rule_id(&mut self) -> RuleId {
        self.slots.push(None);
        RuleId(self.slots.len() as u32)
    }

    fn store_rule(&mut self, id: RuleId, rule: Rule<E>) {
        self.slots[(id.0 - 1) as usize] = Some(rule);
    }

    fn rule_is_empty_missing(&self, id: RuleId) -> bool {
        match self.slots.get((id.0 - 1) as usize).and_then(|s| s.as_ref()) {
            Some(Rule::IncludeOnly(r)) => r.has_missing_patterns && r.patterns.is_empty(),
            Some(Rule::BeginEnd(r)) => r.has_missing_patterns && r.patterns.is_empty(),
            Some(Rule::BeginWhile(r)) => r.has_missing_patterns && r.patterns.is_empty(),
            Some(Rule::Match(_)) | Some(Rule::Capture(_)) | None => false,
        }
    }

    pub fn compile_rule(&mut self, desc: &PreparedRule, repository: &RepoScope) -> RuleId {
        if let Some(&existing) = self.compiled_by_node.get(&desc.node_id) {
            return existing;
        }

        let id = self.reserve_rule_id();
        self.compiled_by_node.insert(desc.node_id, id);

        let rule = if let Some(match_pat) = desc.match_pattern.as_deref().filter(|s| !s.is_empty()) {
            let captures = self.compile_captures(desc.captures.as_ref(), repository);
            Rule::Match(Box::new(MatchRule {
                id,
                name: NameTemplate::new(desc.name.clone()),
                match_source: RegExpSource::new(match_pat, MatchTarget::Rule(id)),
                captures,
                cache: CompiledSourceCache::default(),
            }))
        } else if desc.begin.is_none() {
            let merged_repo;
            let active_repo = if let Some(local_repo) = &desc.repository {
                let mut merged = repository.clone();
                for (k, v) in local_repo {
                    merged.insert(k.clone(), v.clone());
                }
                merged_repo = merged;
                &merged_repo
            } else {
                repository
            };

            let synthesized;
            let patterns_slice = match (&desc.patterns, &desc.include) {
                (Some(p), _) => Some(p.as_slice()),
                (None, Some(inc)) => {
                    synthesized = [PreparedRule {
                        node_id: self.alloc_node(),
                        include: Some(inc.clone()),
                        name: None,
                        content_name: None,
                        match_pattern: None,
                        captures: None,
                        begin: None,
                        begin_captures: None,
                        end: None,
                        end_captures: None,
                        while_pattern: None,
                        while_captures: None,
                        patterns: None,
                        repository: None,
                        apply_end_pattern_last: false,
                    }];
                    Some(synthesized.as_slice())
                }
                (None, None) => None,
            };

            let (patterns, has_missing_patterns) = self.compile_patterns(patterns_slice, active_repo);
            Rule::IncludeOnly(Box::new(IncludeOnlyRule {
                id,
                name: NameTemplate::new(desc.name.clone()),
                content_name: NameTemplate::new(desc.content_name.clone()),
                patterns,
                has_missing_patterns,
                cache: CompiledSourceCache::default(),
            }))
        } else if let Some(while_pat) = desc.while_pattern.as_deref().filter(|s| !s.is_empty()) {
            let begin_pat = desc.begin.as_deref().unwrap_or("");
            let begin_captures = self.compile_captures(desc.begin_captures.as_ref().or(desc.captures.as_ref()), repository);
            let while_captures = self.compile_captures(desc.while_captures.as_ref().or(desc.captures.as_ref()), repository);
            let (patterns, has_missing_patterns) = self.compile_patterns(desc.patterns.as_deref(), repository);
            let while_source = RegExpSource::new(while_pat, MatchTarget::While);
            let while_has_back_references = while_source.has_back_references;
            Rule::BeginWhile(Box::new(BeginWhileRule {
                id,
                name: NameTemplate::new(desc.name.clone()),
                content_name: NameTemplate::new(desc.content_name.clone()),
                begin: RegExpSource::new(begin_pat, MatchTarget::Rule(id)),
                begin_captures,
                while_source,
                while_has_back_references,
                while_captures,
                patterns,
                has_missing_patterns,
                cache: CompiledSourceCache::default(),
                while_cache: CompiledSourceCache::default(),
            }))
        } else {
            let begin_pat = desc.begin.as_deref().unwrap_or("");
            let end_pat = desc.end.as_deref().unwrap_or("");
            let begin_captures = self.compile_captures(desc.begin_captures.as_ref().or(desc.captures.as_ref()), repository);
            let end_captures = self.compile_captures(desc.end_captures.as_ref().or(desc.captures.as_ref()), repository);
            let (patterns, has_missing_patterns) = self.compile_patterns(desc.patterns.as_deref(), repository);
            let end_source = RegExpSource::new(end_pat, MatchTarget::End);
            let end_has_back_references = end_source.has_back_references;
            Rule::BeginEnd(Box::new(BeginEndRule {
                id,
                name: NameTemplate::new(desc.name.clone()),
                content_name: NameTemplate::new(desc.content_name.clone()),
                begin: RegExpSource::new(begin_pat, MatchTarget::Rule(id)),
                begin_captures,
                end: end_source,
                end_has_back_references,
                end_captures,
                apply_end_pattern_last: desc.apply_end_pattern_last,
                patterns,
                has_missing_patterns,
                cache: CompiledSourceCache::default(),
            }))
        };

        self.store_rule(id, rule);
        id
    }

    fn compile_captures(&mut self, captures: Option<&BTreeMap<usize, PreparedRule>>, repository: &RepoScope) -> Vec<Option<CaptureRule>> {
        let Some(captures) = captures else {
            return Vec::new();
        };
        let Some(&max_id) = captures.keys().max() else {
            return Vec::new();
        };

        let mut out = vec![None; max_id + 1];
        for (&capture_idx, cap_desc) in captures {
            let retokenize_id = if cap_desc.patterns.is_some() {
                Some(self.compile_rule(cap_desc, repository))
            } else {
                None
            };
            let id = self.reserve_rule_id();
            let capture_rule = CaptureRule {
                id,
                name: NameTemplate::new(cap_desc.name.clone()),
                content_name: NameTemplate::new(cap_desc.content_name.clone()),
                retokenize_captured_with_rule_id: retokenize_id,
            };
            self.store_rule(id, Rule::Capture(capture_rule.clone()));
            out[capture_idx] = Some(capture_rule);
        }
        out
    }

    fn compile_patterns(&mut self, patterns: Option<&[PreparedRule]>, repository: &RepoScope) -> (Vec<RuleId>, bool) {
        let Some(patterns) = patterns else {
            return (Vec::new(), false);
        };

        let mut compiled = Vec::with_capacity(patterns.len());
        for pattern in patterns {
            let resolved_id = if let Some(include) = &pattern.include {
                match parse_include(include) {
                    IncludeReference::Base => repository.get("$base").cloned().map(|r| self.compile_rule(&r, repository)),
                    IncludeReference::SelfRef => repository.get("$self").cloned().map(|r| self.compile_rule(&r, repository)),
                    IncludeReference::Relative(rule_name) => repository.get(&rule_name).cloned().map(|r| self.compile_rule(&r, repository)),
                    IncludeReference::TopLevel(scope_name) => self
                        .get_external_grammar(&scope_name, Some(repository))
                        .and_then(|ext| ext.repository.get("$self").cloned().map(|r| self.compile_rule(&r, &ext.repository))),
                    IncludeReference::TopLevelRepository { scope_name, rule_name } => self
                        .get_external_grammar(&scope_name, Some(repository))
                        .and_then(|ext| ext.repository.get(&rule_name).cloned().map(|r| self.compile_rule(&r, &ext.repository))),
                }
            } else {
                Some(self.compile_rule(pattern, repository))
            };

            if let Some(rule_id) = resolved_id {
                if self.rule_is_empty_missing(rule_id) {
                    continue;
                }
                compiled.push(rule_id);
            }
        }

        let has_missing_patterns = compiled.len() != patterns.len();
        (compiled, has_missing_patterns)
    }

    pub fn finish(self) -> Vec<Rule<E>> {
        self.slots
            .into_iter()
            .map(|slot| slot.expect("every reserved RuleId is populated before finish"))
            .collect()
    }
}
