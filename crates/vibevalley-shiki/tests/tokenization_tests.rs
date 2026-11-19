use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use serde::Deserialize;
use vibevalley_shiki::{
    CaptureIndex, FindOption, GrammarLoader, RawGrammar, RawRule, RegexEngine, RegexError, RegexScanner, RegexString, Registry, ScannerMatch, ShikiError,
    StateStack, parse_raw_grammar,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSuiteTest {
    desc: String,
    grammars: Vec<String>,
    grammar_path: Option<String>,
    grammar_scope_name: Option<String>,
    grammar_injections: Option<Vec<String>>,
    lines: Vec<RawSuiteLine>,
}

#[derive(Debug, Deserialize)]
struct RawSuiteLine {
    line: String,
    tokens: Vec<RawSuiteToken>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
struct RawSuiteToken {
    value: String,
    scopes: Vec<String>,
}

struct MapLoader {
    grammars: BTreeMap<String, RawGrammar>,
    root_scope: String,
    injections: Vec<String>,
}

impl GrammarLoader for MapLoader {
    fn load_grammar(&self, scope_name: &str) -> Result<Option<RawGrammar>, ShikiError> {
        Ok(self.grammars.get(scope_name).cloned())
    }

    fn injections(&self, scope_name: &str) -> Vec<String> {
        if scope_name == self.root_scope { self.injections.clone() } else { Vec::new() }
    }
}

fn load_suite(suite_rel: &str) -> (std::path::PathBuf, Vec<RawSuiteTest>) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(suite_rel);
    let base_dir = path.parent().expect("fixture dir").to_path_buf();
    let raw_json = std::fs::read_to_string(&path).expect("suite json exists");
    let cases: Vec<RawSuiteTest> = serde_json::from_str(&raw_json).expect("suite json valid");
    (base_dir, cases)
}

fn run_suite_test(base_dir: &Path, case: &RawSuiteTest) -> Result<(), String> {
    let mut grammar_scope_name = case.grammar_scope_name.clone();
    let mut grammars = BTreeMap::new();

    for rel in &case.grammars {
        let full = base_dir.join(rel);
        let content = std::fs::read_to_string(&full).map_err(|e| format!("failed reading {}: {e}", full.display()))?;
        let raw = parse_raw_grammar(&content, Some(rel)).map_err(|e| format!("failed parsing {rel}: {e}"))?;
        if grammar_scope_name.is_none() && case.grammar_path.as_deref() == Some(rel.as_str()) {
            grammar_scope_name = Some(raw.scope_name.clone());
        }
        grammars.insert(raw.scope_name.clone(), raw);
    }

    let root_scope = grammar_scope_name.ok_or_else(|| "missing root grammar scope".to_string())?;
    let loader = MapLoader {
        grammars,
        root_scope: root_scope.clone(),
        injections: case.grammar_injections.clone().unwrap_or_default(),
    };
    let mut registry = Registry::with_default_engine().with_loader(loader);
    let grammar = registry
        .load_grammar(&root_scope)
        .map_err(|e| format!("load_grammar({root_scope}) failed: {e}"))?;

    let mut prev_state: Option<StateStack> = None;
    for (line_idx, line_case) in case.lines.iter().enumerate() {
        let res = grammar
            .tokenize_line(&line_case.line, prev_state.as_ref(), Some(Duration::from_secs(2)))
            .map_err(|e| format!("line #{line_idx} `{}` regex error: {e}", line_case.line))?;
        if res.stopped_early {
            return Err(format!("line #{line_idx} `{}` timed out", line_case.line));
        }

        let actual: Vec<RawSuiteToken> = res
            .tokens
            .iter()
            .map(|tok| RawSuiteToken {
                value: line_case.line[tok.start_index..tok.end_index].to_string(),
                scopes: tok.scopes.clone(),
            })
            .collect();

        let expected: Vec<RawSuiteToken> = if !line_case.line.is_empty() {
            line_case
                .tokens
                .iter()
                .filter(|t| !t.value.is_empty())
                .map(|t| RawSuiteToken {
                    value: t.value.clone(),
                    scopes: t.scopes.clone(),
                })
                .collect()
        } else {
            line_case
                .tokens
                .iter()
                .map(|t| RawSuiteToken {
                    value: t.value.clone(),
                    scopes: t.scopes.clone(),
                })
                .collect()
        };

        if actual != expected {
            return Err(format!(
                "line #{line_idx} `{}` token mismatch:\n  actual:   {actual:?}\n  expected: {expected:?}",
                line_case.line
            ));
        }

        prev_state = Some(res.rule_stack);
    }

    Ok(())
}

/// Runs 63 of the 64 upstream `microsoft/vscode-textmate/test-cases/first-mate/tests.json`
/// suites with the built-in `FancyRegexEngine` fallback.
///
/// The single remaining case (`TEST #73`, Thrift) is tracked explicitly in
/// `upstream_first_mate_test_73_thrift_pending_vibevalley_onig` below.
#[test]
fn upstream_first_mate_suite_63_of_64() {
    let (base_dir, cases) = load_suite("first-mate/tests.json");
    assert_eq!(cases.len(), 64, "upstream first-mate suite has 64 cases");

    let mut passed = 0usize;
    let mut failures = Vec::new();
    for case in &cases {
        if case.desc == "TEST #73" {
            continue;
        }
        match run_suite_test(&base_dir, case) {
            Ok(()) => passed += 1,
            Err(err) => failures.push((case.desc.clone(), err)),
        }
    }
    assert!(failures.is_empty(), "first-mate had {} unexpected failures: {failures:#?}", failures.len());
    assert_eq!(passed, 63);
}

/// Verifies that Thrift's 4-way recursive `\g<ft>` subroutine fails fast with a clean
/// `RegexError::Compile` under `FancyRegexEngine` rather than hanging.
#[test]
fn upstream_first_mate_test_73_fails_fast_under_fancy_regex() {
    let (base_dir, cases) = load_suite("first-mate/tests.json");
    let test_73 = cases.iter().find(|c| c.desc == "TEST #73").expect("TEST #73 exists");
    let err = run_suite_test(&base_dir, test_73).expect_err("fancy-regex exceeds max_prog_size on Thrift");
    assert!(err.contains("max_prog_size"), "expected bounded compile error, got: {err}");
}

#[test]
#[ignore = "pending vibevalley-onig integration: Thrift uses 4-way recursive \\g<ft> subroutine exceeding fancy-regex compile-time inlining"]
fn upstream_first_mate_test_73_thrift_pending_vibevalley_onig() {
    let (base_dir, cases) = load_suite("first-mate/tests.json");
    let test_73 = cases.iter().find(|c| c.desc == "TEST #73").expect("TEST #73 exists");
    run_suite_test(&base_dir, test_73).expect("TEST #73 should pass with vibevalley-onig");
}

/// All 22 upstream `microsoft/vscode-textmate/test-cases/suite1/tests.json` suites.
#[test]
fn upstream_suite1_all_22_tests() {
    let (base_dir, cases) = load_suite("suite1/tests.json");
    assert_eq!(cases.len(), 22, "upstream suite1 has 22 cases");

    let mut passed = 0usize;
    let mut failures = Vec::new();
    for case in &cases {
        match run_suite_test(&base_dir, case) {
            Ok(()) => passed += 1,
            Err(err) => failures.push((case.desc.clone(), err)),
        }
    }
    assert!(failures.is_empty(), "suite1 had {} failures: {failures:#?}", failures.len());
    assert_eq!(passed, 22);
}

/// All 9 upstream `microsoft/vscode-textmate/test-cases/suite1/whileTests.json` suites.
#[test]
fn upstream_suite1_all_9_while_tests() {
    let (base_dir, cases) = load_suite("suite1/whileTests.json");
    assert_eq!(cases.len(), 9, "upstream whileTests has 9 cases");

    let mut passed = 0usize;
    let mut failures = Vec::new();
    for case in &cases {
        match run_suite_test(&base_dir, case) {
            Ok(()) => passed += 1,
            Err(err) => failures.push((case.desc.clone(), err)),
        }
    }
    assert!(failures.is_empty(), "whileTests had {} failures: {failures:#?}", failures.len());
    assert_eq!(passed, 9);
}

/// Exercises the `RegexEngine::supports_find_options() == true` + `ScannerCache` code path
/// that `vibevalley-onig` uses (single compilation per rule, runtime `FindOption` flags,
/// and per-line cache reuse across multiple tokens on the same line).
#[test]
fn custom_find_options_engine_passes_options_and_reuses_cache() {
    struct MockString(String);
    impl RegexString for MockString {
        fn content(&self) -> &str {
            &self.0
        }
    }

    struct MockScanner {
        patterns: Vec<String>,
        saw_not_begin_string: std::sync::Arc<AtomicUsize>,
        saw_not_begin_position: std::sync::Arc<AtomicUsize>,
        cache_hits: std::sync::Arc<AtomicUsize>,
    }

    struct MockCache {
        calls: usize,
    }

    impl RegexScanner for MockScanner {
        type String = MockString;
        type Cache = MockCache;

        fn create_cache(&self) -> Self::Cache {
            MockCache { calls: 0 }
        }

        fn find_next_match(&self, haystack: &Self::String, start_byte: usize, options: FindOption, cache: &mut Self::Cache) -> Option<ScannerMatch> {
            cache.calls += 1;
            if cache.calls > 1 {
                self.cache_hits.fetch_add(1, Ordering::Relaxed);
            }
            if options.contains(FindOption::NOT_BEGIN_STRING) {
                self.saw_not_begin_string.fetch_add(1, Ordering::Relaxed);
            }
            if options.contains(FindOption::NOT_BEGIN_POSITION) {
                self.saw_not_begin_position.fetch_add(1, Ordering::Relaxed);
            }

            let text = &haystack.0[start_byte..];
            let mut best: Option<(usize, usize, usize)> = None;
            for (idx, pat) in self.patterns.iter().enumerate() {
                if pat == r"\Afirst" {
                    if start_byte == 0 && !options.contains(FindOption::NOT_BEGIN_STRING) && text.starts_with("first") {
                        return Some(ScannerMatch {
                            index: idx,
                            capture_indices: vec![Some(CaptureIndex::new(0, 5))],
                        });
                    }
                    continue;
                }
                if let Some(rel) = text.find(pat.as_str()) {
                    let abs_start = start_byte + rel;
                    if best.is_none_or(|(b_start, _, _)| abs_start < b_start) {
                        best = Some((abs_start, abs_start + pat.len(), idx));
                    }
                }
            }
            best.map(|(s, e, index)| ScannerMatch {
                index,
                capture_indices: vec![Some(CaptureIndex::new(s, e))],
            })
        }
    }

    struct MockEngine {
        saw_not_begin_string: std::sync::Arc<AtomicUsize>,
        saw_not_begin_position: std::sync::Arc<AtomicUsize>,
        cache_hits: std::sync::Arc<AtomicUsize>,
        compilations: std::sync::Arc<AtomicUsize>,
    }

    impl RegexEngine for MockEngine {
        type String = MockString;
        type Scanner = MockScanner;

        fn create_scanner(&self, patterns: &[String]) -> Result<Self::Scanner, RegexError> {
            self.compilations.fetch_add(1, Ordering::Relaxed);
            Ok(MockScanner {
                patterns: patterns.to_vec(),
                saw_not_begin_string: std::sync::Arc::clone(&self.saw_not_begin_string),
                saw_not_begin_position: std::sync::Arc::clone(&self.saw_not_begin_position),
                cache_hits: std::sync::Arc::clone(&self.cache_hits),
            })
        }

        fn create_string(&self, content: String) -> Self::String {
            MockString(content)
        }

        fn supports_find_options(&self) -> bool {
            true
        }
    }

    let saw_not_begin_string = std::sync::Arc::new(AtomicUsize::new(0));
    let saw_not_begin_position = std::sync::Arc::new(AtomicUsize::new(0));
    let cache_hits = std::sync::Arc::new(AtomicUsize::new(0));
    let compilations = std::sync::Arc::new(AtomicUsize::new(0));

    let engine = MockEngine {
        saw_not_begin_string: std::sync::Arc::clone(&saw_not_begin_string),
        saw_not_begin_position: std::sync::Arc::clone(&saw_not_begin_position),
        cache_hits: std::sync::Arc::clone(&cache_hits),
        compilations: std::sync::Arc::clone(&compilations),
    };

    let mut registry = Registry::new(engine);
    let grammar = registry
        .add_grammar(
            RawGrammar {
                scope_name: "source.mock".to_string(),
                patterns: vec![
                    RawRule {
                        match_pattern: Some(r"\Afirst".to_string()),
                        name: Some("keyword.first".to_string()),
                        ..RawRule::default()
                    },
                    RawRule {
                        match_pattern: Some("tok".to_string()),
                        name: Some("entity.tok".to_string()),
                        ..RawRule::default()
                    },
                ],
                ..RawGrammar::default()
            },
            Vec::new(),
            0,
            BTreeMap::new(),
        )
        .unwrap();

    let line1 = grammar.tokenize_line("first tok tok", None, None).unwrap();
    assert_eq!(line1.tokens[0].scopes, vec!["source.mock", "keyword.first"]);
    assert_eq!(line1.tokens[2].scopes, vec!["source.mock", "entity.tok"]);
    assert_eq!(line1.tokens[4].scopes, vec!["source.mock", "entity.tok"]);

    // On line 2, `\Afirst` must NOT match because `NOT_BEGIN_STRING` is passed.
    let line2 = grammar.tokenize_line("first tok", Some(&line1.rule_stack), None).unwrap();
    assert_eq!(line2.tokens[0].scopes, vec!["source.mock"]);
    assert_eq!(line2.tokens[1].scopes, vec!["source.mock", "entity.tok"]);

    // Compiled only ONCE (not 4x via compileAG), runtime options passed, and cache reused!
    assert_eq!(compilations.load(Ordering::Relaxed), 1);
    assert!(saw_not_begin_string.load(Ordering::Relaxed) >= 2);
    assert!(saw_not_begin_position.load(Ordering::Relaxed) >= 2);
    assert!(cache_hits.load(Ordering::Relaxed) >= 2);
}
