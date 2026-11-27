//! Incremental hash-cached, coverage-gated mutation tester (`cargo xtask mutate`).

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::qa::lang::{Token, TokenKind, analyze_file, form_tokens, tokenize};
use crate::qa::{self, CollectedFile, FormInfo, FormKind, Lang, MutantOutcome, MutantRecord, MutateForm, MutateSnapshot};

const USAGE: &str = "\
Usage: cargo xtask mutate [paths/fragments...] [options]

Options:
  --scan                   List discovered mutation sites without running tests
  --changed                Restrict to files changed relative to origin/main or working tree
  --since-last-run         Reuse prior Killed outcomes when form body_hash is unchanged (default)
  --mutate-all             Re-run all covered mutation sites ignoring cached outcomes
  --no-coverage            Ignore LCOV coverage files and test every mutation site
  --use-existing-coverage  Read existing LCOV coverage files without generating coverage
  --test-command <CMD>     Custom shell command to execute tests (run via sh -c)
  --max-workers <N>        Maximum parallel isolated workers (default: CPU count, max 8)
  --timeout-factor <F>     Mutant timeout multiplier over baseline (default: 10)
  --json                   Emit machine-readable JSON on stdout
  -h, --help               Show this help message";

#[derive(Debug, Clone)]
struct CliOptions {
    filters: Vec<String>,
    scan: bool,
    changed: bool,
    since_last_run: bool,
    no_coverage: bool,
    use_existing_coverage: bool,
    test_command: Option<String>,
    max_workers: usize,
    timeout_factor: f64,
    json: bool,
    help: bool,
}

impl Default for CliOptions {
    fn default() -> Self {
        let cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        Self {
            filters: Vec::new(),
            scan: false,
            changed: false,
            since_last_run: true,
            no_coverage: false,
            use_existing_coverage: false,
            test_command: None,
            max_workers: cpus.clamp(1, 8),
            timeout_factor: 10.0,
            json: false,
            help: false,
        }
    }
}

fn parse_args(args: &[String]) -> Result<CliOptions, String> {
    let mut opts = CliOptions::default();
    let mut idx = 0usize;
    while idx < args.len() {
        let arg = &args[idx];
        match arg.as_str() {
            "-h" | "--help" => {
                opts.help = true;
                return Ok(opts);
            }
            "--scan" => opts.scan = true,
            "--changed" => opts.changed = true,
            "--since-last-run" => opts.since_last_run = true,
            "--mutate-all" => opts.since_last_run = false,
            "--no-coverage" => opts.no_coverage = true,
            "--use-existing-coverage" => opts.use_existing_coverage = true,
            "--json" => opts.json = true,
            "--test-command" => {
                idx += 1;
                let cmd = args.get(idx).ok_or_else(|| "--test-command requires a command string".to_owned())?;
                opts.test_command = Some(cmd.clone());
            }
            "--max-workers" => {
                idx += 1;
                let raw = args.get(idx).ok_or_else(|| "--max-workers requires an integer".to_owned())?;
                opts.max_workers = parse_positive_usize(raw, "--max-workers")?;
            }
            "--timeout-factor" => {
                idx += 1;
                let raw = args.get(idx).ok_or_else(|| "--timeout-factor requires a number".to_owned())?;
                opts.timeout_factor = parse_positive_f64(raw, "--timeout-factor")?;
            }
            other => {
                if let Some(val) = other.strip_prefix("--test-command=") {
                    opts.test_command = Some(val.to_owned());
                } else if let Some(val) = other.strip_prefix("--max-workers=") {
                    opts.max_workers = parse_positive_usize(val, "--max-workers")?;
                } else if let Some(val) = other.strip_prefix("--timeout-factor=") {
                    opts.timeout_factor = parse_positive_f64(val, "--timeout-factor")?;
                } else if other.starts_with('-') {
                    return Err(format!("unknown option `{other}`\n\n{USAGE}"));
                } else {
                    opts.filters.push(other.to_owned());
                }
            }
        }
        idx += 1;
    }
    Ok(opts)
}

fn parse_positive_usize(raw: &str, flag: &str) -> Result<usize, String> {
    let parsed: usize = raw.parse().map_err(|err| format!("invalid {flag} value `{raw}`: {err}"))?;
    if parsed == 0 {
        return Err(format!("{flag} must be >= 1"));
    }
    Ok(parsed)
}

fn parse_positive_f64(raw: &str, flag: &str) -> Result<f64, String> {
    let parsed: f64 = raw.parse().map_err(|err| format!("invalid {flag} value `{raw}`: {err}"))?;
    if !parsed.is_finite() || parsed <= 0.0 {
        return Err(format!("{flag} must be a positive finite number"));
    }
    Ok(parsed)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MutationSite {
    pub id: String,
    pub file: String,
    pub namespace: String,
    pub form_name: String,
    pub defn_key: String,
    pub lang: Lang,
    pub line: usize,
    pub col: usize,
    pub start_byte: usize,
    pub end_byte: usize,
    pub original: String,
    pub replacement: String,
}

#[derive(Debug, Clone)]
struct FormAnalysisSites {
    form: FormInfo,
    defn_key: String,
    sites: Vec<MutationSite>,
}

#[derive(Debug, Clone)]
struct FileMutationPlan {
    file: CollectedFile,
    source: String,
    forms: Vec<FormAnalysisSites>,
}

#[derive(Debug, Clone, Serialize)]
struct ScanSiteJson {
    id: String,
    file: String,
    namespace: String,
    form: String,
    defn_key: String,
    lang: Lang,
    line: usize,
    col: usize,
    start_byte: usize,
    end_byte: usize,
    original: String,
    replacement: String,
    covered: bool,
}

#[derive(Debug, Clone, Serialize)]
struct ScanReport {
    version: u32,
    mode: &'static str,
    files_scanned: usize,
    forms_scanned: usize,
    total_sites: usize,
    covered_sites: usize,
    uncovered_sites: usize,
    sites: Vec<ScanSiteJson>,
}

#[derive(Debug, Clone, Serialize)]
struct SurvivorSummary {
    id: String,
    file: String,
    namespace: String,
    form: String,
    line: usize,
    col: usize,
    original: String,
    replacement: String,
}

#[derive(Debug, Clone, Serialize)]
struct RunReport {
    version: u32,
    mode: &'static str,
    baseline_passed: bool,
    baseline_ms: u128,
    timeout_ms: u128,
    files_scanned: usize,
    forms_scanned: usize,
    total_sites: usize,
    executed: usize,
    cached_skipped: usize,
    killed: usize,
    timeout: usize,
    compile_error: usize,
    survived: usize,
    uncovered: usize,
    score: Option<f64>,
    snapshots: Vec<String>,
    survivors: Vec<SurvivorSummary>,
}

#[derive(Debug, Clone)]
struct CoverageState {
    active: bool,
    lines_by_file: HashMap<PathBuf, HashMap<usize, u64>>,
}

impl CoverageState {
    fn load(root: &Path, no_coverage: bool) -> Result<Self, String> {
        if no_coverage {
            return Ok(Self {
                active: false,
                lines_by_file: HashMap::new(),
            });
        }
        let lcov_paths = discover_lcov_files(root);
        if lcov_paths.is_empty() {
            return Ok(Self {
                active: false,
                lines_by_file: HashMap::new(),
            });
        }
        let mut merged: HashMap<PathBuf, HashMap<usize, u64>> = HashMap::new();
        for path in &lcov_paths {
            let parsed = qa::parse_lcov(path)?;
            for (file, lines) in parsed {
                let target = merged.entry(file).or_default();
                for (line, hits) in lines {
                    let count = target.entry(line).or_insert(0);
                    *count = count.saturating_add(hits);
                }
            }
        }
        Ok(Self {
            active: !merged.is_empty(),
            lines_by_file: merged,
        })
    }

    fn is_line_covered(&self, root: &Path, rel_posix: &str, line: usize) -> bool {
        if !self.active {
            return true;
        }
        let Some(lines) = qa::lookup_lcov_lines(&self.lines_by_file, root, rel_posix) else {
            return false;
        };
        lines.get(&line).copied().unwrap_or(0) > 0
    }
}

fn discover_lcov_files(root: &Path) -> Vec<PathBuf> {
    let candidates = [
        ".metrics/lcov.info",
        ".metrics/rust.lcov",
        ".metrics/ts.lcov",
        "lcov.info",
        "coverage/lcov.info",
        "target/llvm-cov/lcov.info",
        "target/lcov.info",
        "apps/mac/ui/coverage/lcov.info",
    ];
    let mut found = Vec::new();
    for rel in candidates {
        let p = root.join(rel);
        if p.is_file() {
            found.push(p);
        }
    }
    for container in ["packages", "apps"] {
        let dir = root.join(container);
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path().join("coverage/lcov.info");
                if p.is_file() && !found.contains(&p) {
                    found.push(p);
                }
            }
        }
    }
    found
}

fn is_tsx_or_jsx(path: &Path) -> bool {
    matches!(path.extension().and_then(|e| e.to_str()), Some("tsx" | "jsx"))
}

fn find_matching_open_brace_from_end(tokens: &[Token]) -> Option<usize> {
    if tokens.last().is_none_or(|t| t.text != "}") {
        return None;
    }
    let mut depth = 0usize;
    for idx in (0..tokens.len()).rev() {
        match tokens[idx].text.as_str() {
            "}" => depth += 1,
            "{" | "${" => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(idx);
                }
            }
            _ => {}
        }
    }
    None
}

fn find_top_level_arrow(tokens: &[Token]) -> Option<usize> {
    let mut paren = 0usize;
    let mut bracket = 0usize;
    let mut brace = 0usize;
    for (idx, tok) in tokens.iter().enumerate() {
        match tok.text.as_str() {
            "(" => paren += 1,
            ")" => paren = paren.saturating_sub(1),
            "[" => bracket += 1,
            "]" => bracket = bracket.saturating_sub(1),
            "{" => brace += 1,
            "}" => brace = brace.saturating_sub(1),
            "=>" if paren == 0 && bracket == 0 && brace == 0 => return Some(idx),
            _ => {}
        }
    }
    None
}

fn form_body_start_idx(tokens: &[Token], form: &FormInfo) -> usize {
    match form.kind {
        FormKind::Function | FormKind::Method => find_matching_open_brace_from_end(tokens).map_or(0, |idx| idx + 1),
        FormKind::Arrow => {
            if let Some(open_brace) = find_matching_open_brace_from_end(tokens)
                && open_brace > 0
                && tokens[open_brace - 1].text == "=>"
            {
                return open_brace + 1;
            }
            find_top_level_arrow(tokens).map_or(0, |idx| idx + 1)
        }
    }
}

fn is_expr_end(tok: Option<&Token>, lang: Lang) -> bool {
    let Some(t) = tok else {
        return false;
    };
    match t.kind {
        TokenKind::Ident | TokenKind::Lit => true,
        TokenKind::Punct => matches!(t.text.as_str(), ")" | "]"),
        TokenKind::Op => match lang {
            Lang::Rust => t.text == "?",
            Lang::TypeScript => matches!(t.text.as_str(), "++" | "--"),
        },
        TokenKind::Keyword => match lang {
            Lang::Rust => matches!(t.text.as_str(), "self" | "Self"),
            Lang::TypeScript => matches!(t.text.as_str(), "this" | "super"),
        },
    }
}

fn is_rust_or_prev_expr(tok: Option<&Token>) -> bool {
    let Some(t) = tok else {
        return false;
    };
    match t.kind {
        TokenKind::Ident | TokenKind::Lit => true,
        TokenKind::Punct => matches!(t.text.as_str(), ")" | "]" | "}"),
        TokenKind::Op => t.text == "?",
        TokenKind::Keyword => matches!(t.text.as_str(), "self" | "Self"),
    }
}

fn looks_like_generic_angle(tokens: &[Token], lt_idx: usize, lang: Lang) -> Option<usize> {
    let prev = lt_idx.checked_sub(1).map(|i| &tokens[i]);
    let can_start_generic = match lang {
        Lang::Rust => prev.is_some_and(|p| {
            p.text == "::"
                || matches!(p.text.as_str(), ":" | "as" | "impl" | "dyn")
                || (p.kind == TokenKind::Ident && p.text.chars().next().is_some_and(|c| c.is_ascii_uppercase()))
        }),
        Lang::TypeScript => prev.is_some_and(|p| p.kind == TokenKind::Ident),
    };
    if !can_start_generic {
        return None;
    }

    let mut depth = 0usize;
    let mut i = lt_idx;
    while i < tokens.len() {
        let text = tokens[i].text.as_str();
        match text {
            "<" => depth += 1,
            ">" => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    let after = tokens.get(i + 1).map(|t| t.text.as_str());
                    let valid_follow = matches!(
                        after,
                        None | Some("(" | "::" | "," | ";" | ")" | ">" | ">>" | "=" | "{" | "." | "[" | "|" | "&" | "?")
                    );
                    return valid_follow.then_some(i);
                }
            }
            ">>" if depth >= 2 => {
                depth -= 2;
                if depth == 0 {
                    let after = tokens.get(i + 1).map(|t| t.text.as_str());
                    let valid_follow = matches!(
                        after,
                        None | Some("(" | "::" | "," | ";" | ")" | ">" | ">>" | "=" | "{" | "." | "[" | "|" | "&" | "?")
                    );
                    return valid_follow.then_some(i);
                }
            }
            ";" | "{" | "}" | "=" | "&&" | "||" | "==" | "!=" | "===" | "!==" | "<=" | ">=" => return None,
            _ => {}
        }
        i += 1;
    }
    None
}

fn jsx_can_start_after(prev: Option<&Token>, prev_was_jsx_close_gt: bool) -> bool {
    if prev_was_jsx_close_gt {
        return true;
    }
    let Some(t) = prev else {
        return true;
    };
    match t.kind {
        TokenKind::Keyword => matches!(t.text.as_str(), "return" | "else" | "await" | "yield" | "case" | "throw"),
        TokenKind::Op => matches!(t.text.as_str(), "=>" | "=" | "?" | "&&" | "||" | "??" | "!"),
        TokenKind::Punct => matches!(t.text.as_str(), "(" | "[" | "{" | "," | ":" | ";" | "${"),
        TokenKind::Ident | TokenKind::Lit => false,
    }
}

fn compute_skipped_indices(tokens: &[Token], body_start: usize, lang: Lang, is_tsx: bool) -> HashSet<usize> {
    let mut skipped = HashSet::new();
    let mut i = body_start;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum JsxCtx {
        Children,
        Expr { brace_depth: usize },
    }
    let mut jsx_stack: Vec<JsxCtx> = Vec::new();
    let mut prev_was_jsx_close_gt = false;

    while i < tokens.len() {
        let tok = &tokens[i];
        let in_jsx_children = matches!(jsx_stack.last(), Some(JsxCtx::Children));

        if in_jsx_children {
            if tok.text == "{" {
                jsx_stack.push(JsxCtx::Expr { brace_depth: 1 });
                prev_was_jsx_close_gt = false;
                i += 1;
                continue;
            }
            if tok.text == "<" && tokens.get(i + 1).is_some_and(|n| n.text == "/") {
                skipped.insert(i);
                let mut k = i + 1;
                while k < tokens.len() && tokens[k].text != ">" {
                    skipped.insert(k);
                    k += 1;
                }
                if k < tokens.len() {
                    skipped.insert(k);
                }
                jsx_stack.pop();
                prev_was_jsx_close_gt = true;
                i = (k + 1).min(tokens.len());
                continue;
            }
            if tok.text == "<" && (tokens.get(i + 1).is_some_and(|n| n.text == ">") || tokens.get(i + 1).is_some_and(|n| n.kind == TokenKind::Ident)) {
                // Nested JSX opening tag inside JSX children; fall through to JSX tag scanner below.
            } else {
                // If closing the outer function/paren unexpectedly (e.g. apostrophe in JSX child text swallowed `</div>`), recover cleanly.
                if tok.text == "}" && i + 1 == tokens.len() {
                    jsx_stack.clear();
                    i += 1;
                    continue;
                }
                skipped.insert(i);
                prev_was_jsx_close_gt = false;
                i += 1;
                continue;
            }
        }

        if let Some(JsxCtx::Expr { brace_depth }) = jsx_stack.last_mut() {
            if tok.text == "{" || tok.text == "${" {
                *brace_depth += 1;
            } else if tok.text == "}" {
                *brace_depth = brace_depth.saturating_sub(1);
                if *brace_depth == 0 {
                    jsx_stack.pop();
                    prev_was_jsx_close_gt = false;
                    i += 1;
                    continue;
                }
            }
        }

        // Skip Rust inner/outer attributes (`#[...]`, `#![...]`).
        if lang == Lang::Rust && tok.text == "#" {
            let bracket_idx = if tokens.get(i + 1).is_some_and(|t| t.text == "!") { i + 2 } else { i + 1 };
            if tokens.get(bracket_idx).is_some_and(|t| t.text == "[") {
                let mut depth = 0usize;
                let mut k = bracket_idx;
                while k < tokens.len() {
                    if tokens[k].text == "[" {
                        depth += 1;
                    } else if tokens[k].text == "]" {
                        depth = depth.saturating_sub(1);
                        if depth == 0 {
                            for s in i..=k {
                                skipped.insert(s);
                            }
                            i = k + 1;
                            prev_was_jsx_close_gt = false;
                            break;
                        }
                    }
                    k += 1;
                }
                if k < tokens.len() {
                    continue;
                }
            }
        }

        // Skip generic type argument lists `<...>`.
        if tok.text == "<"
            && let Some(end_idx) = looks_like_generic_angle(tokens, i, lang)
        {
            for s in i..=end_idx {
                skipped.insert(s);
            }
            i = end_idx + 1;
            prev_was_jsx_close_gt = false;
            continue;
        }

        // Skip JSX tags (`<Tag ...>`, `</Tag>`, `<>`, `</>`) and JSX child text in TSX/JSX.
        if lang == Lang::TypeScript && is_tsx && tok.text == "<" {
            let prev = i.checked_sub(1).and_then(|p| (p >= body_start).then(|| &tokens[p]));
            let next = tokens.get(i + 1);
            let is_closing = next.is_some_and(|n| n.text == "/");
            let is_fragment_open = next.is_some_and(|n| n.text == ">");
            let is_tag_open = next.is_some_and(|n| n.kind == TokenKind::Ident) && (in_jsx_children || jsx_can_start_after(prev, prev_was_jsx_close_gt));

            if is_closing {
                skipped.insert(i);
                let mut k = i + 1;
                while k < tokens.len() && tokens[k].text != ">" {
                    skipped.insert(k);
                    k += 1;
                }
                if k < tokens.len() {
                    skipped.insert(k);
                }
                if matches!(jsx_stack.last(), Some(JsxCtx::Children)) {
                    jsx_stack.pop();
                }
                prev_was_jsx_close_gt = true;
                i = (k + 1).min(tokens.len());
                continue;
            }
            if is_fragment_open {
                skipped.insert(i);
                skipped.insert(i + 1);
                jsx_stack.push(JsxCtx::Children);
                prev_was_jsx_close_gt = true;
                i += 2;
                continue;
            }
            if is_tag_open {
                skipped.insert(i);
                skipped.insert(i + 1);
                let mut k = i + 2;
                let mut brace = 0usize;
                let mut self_closing = false;
                let mut closed = false;
                while k < tokens.len() {
                    let t = &tokens[k];
                    if t.text == "{" || t.text == "${" {
                        brace += 1;
                    } else if t.text == "}" && brace > 0 {
                        brace -= 1;
                    } else if brace == 0 {
                        if t.text == "/" && tokens.get(k + 1).is_some_and(|n| n.text == ">") {
                            skipped.insert(k);
                            skipped.insert(k + 1);
                            self_closing = true;
                            k += 1;
                            closed = true;
                            break;
                        }
                        if t.text == ">" {
                            skipped.insert(k);
                            closed = true;
                            break;
                        }
                        skipped.insert(k);
                    }
                    k += 1;
                }
                if closed {
                    if !self_closing {
                        jsx_stack.push(JsxCtx::Children);
                    }
                    prev_was_jsx_close_gt = true;
                    i = k + 1;
                    continue;
                }
            }
        }

        prev_was_jsx_close_gt = false;
        i += 1;
    }

    skipped
}

fn ts_optional_call_or_index(tokens: &[Token], idx: usize) -> bool {
    let Some(next) = tokens.get(idx + 1) else {
        return false;
    };
    if matches!(next.text.as_str(), "(" | "[") {
        return true;
    }
    if next.text == "<"
        && let Some(close) = looks_like_generic_angle(tokens, idx + 1, Lang::TypeScript)
    {
        return tokens.get(close + 1).is_some_and(|t| t.text == "(");
    }
    false
}

fn removal_replacement(tokens: &[Token], idx: usize) -> String {
    let tok = &tokens[idx];
    if let Some(prev) = idx.checked_sub(1).map(|p| &tokens[p])
        && let Some(next) = tokens.get(idx + 1)
        && prev.end_byte == tok.start_byte
        && tok.end_byte == next.start_byte
        && prev.kind == TokenKind::Keyword
    {
        return " ".to_owned();
    }
    String::new()
}

fn token_mutation_replacement(tokens: &[Token], idx: usize, lang: Lang) -> Option<String> {
    let tok = &tokens[idx];
    let prev = idx.checked_sub(1).map(|p| &tokens[p]);
    let next = tokens.get(idx + 1);

    match tok.kind {
        TokenKind::Lit => match tok.text.as_str() {
            "true" => Some("false".to_owned()),
            "false" => Some("true".to_owned()),
            "0" => Some("1".to_owned()),
            "1" => Some("0".to_owned()),
            _ => None,
        },
        TokenKind::Op => match tok.text.as_str() {
            "==" => Some("!=".to_owned()),
            "!=" => Some("==".to_owned()),
            "<" => Some("<=".to_owned()),
            "<=" => Some("<".to_owned()),
            ">" => Some(">=".to_owned()),
            ">=" => Some(">".to_owned()),
            "+" => Some("-".to_owned()),
            "-" => {
                if is_expr_end(prev, lang) {
                    Some("+".to_owned())
                } else {
                    Some(removal_replacement(tokens, idx))
                }
            }
            "*" => {
                let is_rust_ptr_qual = lang == Lang::Rust && next.is_some_and(|n| matches!(n.text.as_str(), "mut" | "const"));
                if !is_rust_ptr_qual && is_expr_end(prev, lang) {
                    Some("/".to_owned())
                } else {
                    None
                }
            }
            "/" => Some("*".to_owned()),
            "&&" => Some("||".to_owned()),
            "||" => {
                if lang == Lang::Rust && !is_rust_or_prev_expr(prev) {
                    None
                } else {
                    Some("&&".to_owned())
                }
            }
            "!" => {
                if !is_expr_end(prev, lang) && prev.is_none_or(|p| p.text != "->") {
                    Some(removal_replacement(tokens, idx))
                } else {
                    None
                }
            }
            "===" if lang == Lang::TypeScript => Some("!==".to_owned()),
            "!==" if lang == Lang::TypeScript => Some("===".to_owned()),
            "??" if lang == Lang::TypeScript => Some("||".to_owned()),
            "?." if lang == Lang::TypeScript => {
                if ts_optional_call_or_index(tokens, idx) {
                    Some(String::new())
                } else {
                    Some(".".to_owned())
                }
            }
            _ => None,
        },
        TokenKind::Ident | TokenKind::Keyword | TokenKind::Punct => None,
    }
}

fn make_mutant_id(form: &FormInfo, site_start_byte: usize, site_end_byte: usize, original: &str, replacement: &str) -> String {
    let rel_start = site_start_byte.saturating_sub(form.start_byte);
    let rel_end = site_end_byte.saturating_sub(form.start_byte);
    let op_digest = qa::stable_hash_hex(&format!("{original}->{replacement}"));
    format!("{}:{}..{}:{}", form.name, rel_start, rel_end, &op_digest[..8])
}

/// Discovers mutation sites per form in a single source file using `qa::lang::tokenize` and `analyze_file`.
pub fn discover_file_sites(root: &Path, file: &Path, source: &str, lang: Lang) -> Vec<(FormInfo, Vec<MutationSite>)> {
    let rel_file = qa::to_rel_posix(root, file);
    let tokens = tokenize(source, lang);
    let analysis = analyze_file(root, file, source, lang);
    let is_tsx = is_tsx_or_jsx(file);

    let mut out = Vec::with_capacity(analysis.forms.len());
    for form in analysis.forms {
        let ftoks = form_tokens(&tokens, &form);
        let body_start = form_body_start_idx(ftoks, &form);
        let skipped = compute_skipped_indices(ftoks, body_start, lang, is_tsx);
        let defn_key = form.defn_key();

        let mut sites = Vec::new();
        for idx in body_start..ftoks.len() {
            if skipped.contains(&idx) {
                continue;
            }
            let Some(replacement) = token_mutation_replacement(ftoks, idx, lang) else {
                continue;
            };
            let tok = &ftoks[idx];
            sites.push(MutationSite {
                id: make_mutant_id(&form, tok.start_byte, tok.end_byte, &tok.text, &replacement),
                file: rel_file.clone(),
                namespace: form.namespace.clone(),
                form_name: form.name.clone(),
                defn_key: defn_key.clone(),
                lang,
                line: tok.line,
                col: tok.col,
                start_byte: tok.start_byte,
                end_byte: tok.end_byte,
                original: tok.text.clone(),
                replacement,
            });
        }
        out.push((form, sites));
    }
    out
}

fn assign_defn_keys(forms: Vec<(FormInfo, Vec<MutationSite>)>) -> Vec<FormAnalysisSites> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for (form, _) in &forms {
        *counts.entry(form.defn_key()).or_insert(0) += 1;
    }
    forms
        .into_iter()
        .map(|(form, mut sites)| {
            let base = form.defn_key();
            let defn_key = if counts.get(&base).copied().unwrap_or(0) > 1 {
                format!("{base}@L{}", form.start_line)
            } else {
                base
            };
            for s in &mut sites {
                s.defn_key = defn_key.clone();
            }
            FormAnalysisSites { form, defn_key, sites }
        })
        .collect()
}

fn apply_mutation(source: &str, site: &MutationSite) -> String {
    let mut out = String::with_capacity(source.len().saturating_sub(site.end_byte - site.start_byte) + site.replacement.len());
    out.push_str(&source[..site.start_byte]);
    out.push_str(&site.replacement);
    out.push_str(&source[site.end_byte..]);
    out
}

fn is_killed_like(outcome: MutantOutcome) -> bool {
    matches!(outcome, MutantOutcome::Killed | MutantOutcome::Timeout | MutantOutcome::CompileError)
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct TestCommandSpec {
    program: String,
    args: Vec<String>,
    rel_workdir: PathBuf,
    shell_command: Option<String>,
}

impl TestCommandSpec {
    fn from_custom(cmd: &str) -> Self {
        Self {
            program: "sh".to_owned(),
            args: vec!["-c".to_owned(), cmd.to_owned()],
            rel_workdir: PathBuf::new(),
            shell_command: Some(cmd.to_owned()),
        }
    }

    fn label(&self) -> String {
        if let Some(cmd) = &self.shell_command {
            cmd.clone()
        } else if self.rel_workdir.as_os_str().is_empty() {
            format!("{} {}", self.program, self.args.join(" "))
        } else {
            format!("(cd {} && {} {})", self.rel_workdir.display(), self.program, self.args.join(" "))
        }
    }
}

fn parse_cargo_package_name(cargo_toml: &Path) -> Option<String> {
    let content = fs::read_to_string(cargo_toml).ok()?;
    let mut in_package = false;
    for raw_line in content.lines() {
        let line = raw_line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('[') {
            in_package = line == "[package]";
            continue;
        }
        if in_package && let Some(rest) = line.strip_prefix("name") {
            let trimmed = rest.trim_start();
            if let Some(val) = trimmed.strip_prefix('=') {
                let name = val.trim().trim_matches('"').trim_matches('\'');
                if !name.is_empty() {
                    return Some(name.to_owned());
                }
            }
        }
    }
    None
}

fn find_nearest_file(root: &Path, start_file: &Path, target_name: &str) -> Option<PathBuf> {
    let mut dir = start_file.parent()?;
    loop {
        let candidate = dir.join(target_name);
        if candidate.is_file() {
            return Some(candidate);
        }
        if dir == root {
            break;
        }
        dir = dir.parent()?;
    }
    None
}

fn resolve_test_command(root: &Path, file: &CollectedFile, custom: Option<&str>) -> TestCommandSpec {
    if let Some(cmd) = custom {
        return TestCommandSpec::from_custom(cmd);
    }
    match file.lang {
        Lang::Rust => {
            if let Some(cargo_toml) = find_nearest_file(root, &file.path, "Cargo.toml") {
                let pkg_dir = cargo_toml.parent().unwrap_or(root);
                let root_manifest = root.join("Cargo.toml");
                if pkg_dir != root
                    && root_manifest.is_file()
                    && let Some(pkg_name) = parse_cargo_package_name(&cargo_toml)
                {
                    return TestCommandSpec {
                        program: "cargo".to_owned(),
                        args: vec!["test".to_owned(), "-p".to_owned(), pkg_name],
                        rel_workdir: PathBuf::new(),
                        shell_command: None,
                    };
                }
                let rel = pkg_dir.strip_prefix(root).unwrap_or(Path::new("")).to_path_buf();
                return TestCommandSpec {
                    program: "cargo".to_owned(),
                    args: vec!["test".to_owned()],
                    rel_workdir: rel,
                    shell_command: None,
                };
            }
            TestCommandSpec {
                program: "cargo".to_owned(),
                args: vec!["test".to_owned()],
                rel_workdir: PathBuf::new(),
                shell_command: None,
            }
        }
        Lang::TypeScript => {
            if let Some(pkg_json) = find_nearest_file(root, &file.path, "package.json") {
                let pkg_dir = pkg_json.parent().unwrap_or(root);
                let rel = pkg_dir.strip_prefix(root).unwrap_or(Path::new("")).to_path_buf();
                if let Ok(raw) = fs::read_to_string(&pkg_json)
                    && let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw)
                    && let Some(script) = val.get("scripts").and_then(|s| s.get("test")).and_then(|v| v.as_str())
                    && !script.contains("no test specified")
                {
                    return TestCommandSpec {
                        program: "sh".to_owned(),
                        args: vec!["-c".to_owned(), script.to_owned()],
                        rel_workdir: rel,
                        shell_command: Some(script.to_owned()),
                    };
                }
                return TestCommandSpec {
                    program: "vp".to_owned(),
                    args: vec!["test".to_owned(), "run".to_owned()],
                    rel_workdir: rel,
                    shell_command: None,
                };
            }
            TestCommandSpec {
                program: "vp".to_owned(),
                args: vec!["test".to_owned(), "run".to_owned()],
                rel_workdir: PathBuf::new(),
                shell_command: None,
            }
        }
    }
}

#[derive(Debug)]
struct CommandOutcome {
    exit_code: Option<i32>,
    timed_out: bool,
    stderr: String,
    duration: Duration,
}

fn kill_process_tree(child: &mut std::process::Child) {
    let pid = child.id().to_string();
    let _ = Command::new("pkill")
        .args(["-KILL", "-P", &pid])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
    let _ = child.wait();
}

fn run_command_with_timeout(work_root: &Path, spec: &TestCommandSpec, timeout: Option<Duration>) -> Result<CommandOutcome, String> {
    let workdir = if spec.rel_workdir.as_os_str().is_empty() {
        work_root.to_path_buf()
    } else {
        work_root.join(&spec.rel_workdir)
    };
    let start = Instant::now();
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args).current_dir(&workdir).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|err| format!("failed to spawn `{}` in {}: {err}", spec.label(), workdir.display()))?;

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let stdout_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(ref mut pipe) = stdout_pipe {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });
    let stderr_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(ref mut pipe) = stderr_pipe {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });

    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if let Some(limit) = timeout
                    && start.elapsed() >= limit
                {
                    timed_out = true;
                    kill_process_tree(&mut child);
                    break None;
                }
                #[allow(clippy::disallowed_methods, reason = "synchronous CLI xtask child timeout poll")]
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(err) => {
                kill_process_tree(&mut child);
                let _ = stdout_handle.join();
                let _ = stderr_handle.join();
                return Err(format!("failed waiting on `{}`: {err}", spec.label()));
            }
        }
    };

    let duration = start.elapsed();
    let _ = stdout_handle.join();
    let stderr_bytes = stderr_handle.join().unwrap_or_default();
    let stderr = String::from_utf8_lossy(&stderr_bytes).into_owned();

    Ok(CommandOutcome {
        exit_code: status.and_then(|s| s.code()),
        timed_out,
        stderr,
        duration,
    })
}

fn is_compile_error(stderr: &str) -> bool {
    stderr.contains("could not compile")
        || stderr.contains("error[E")
        || stderr.contains("error: expected")
        || stderr.contains("error: mismatched types")
        || stderr.contains("error: cannot find")
        || stderr.contains("SyntaxError:")
        || stderr.contains("error TS")
        || stderr.contains("Transform failed")
}

fn classify_mutant_outcome(outcome: &CommandOutcome) -> MutantOutcome {
    if outcome.timed_out {
        return MutantOutcome::Timeout;
    }
    if outcome.exit_code == Some(0) {
        return MutantOutcome::Survived;
    }
    if is_compile_error(&outcome.stderr) {
        return MutantOutcome::CompileError;
    }
    MutantOutcome::Killed
}

fn unquote_js_string(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.len() >= 2 && ((trimmed.starts_with('"') && trimmed.ends_with('"')) || (trimmed.starts_with('\'') && trimmed.ends_with('\''))) {
        Some(trimmed[1..trimmed.len() - 1].to_owned())
    } else {
        None
    }
}

fn extract_ts_relative_specifiers(source: &str) -> Vec<String> {
    let tokens = tokenize(source, Lang::TypeScript);
    let mut specs = Vec::new();
    for (idx, tok) in tokens.iter().enumerate() {
        if tok.kind != TokenKind::Lit {
            continue;
        }
        let Some(spec) = unquote_js_string(&tok.text) else {
            continue;
        };
        if !(spec.starts_with("./") || spec.starts_with("../")) {
            continue;
        }
        let prev = idx.checked_sub(1).map(|p| tokens[p].text.as_str());
        let prev2 = idx.checked_sub(2).map(|p| tokens[p].text.as_str());
        let is_import_like = matches!(prev, Some("from" | "import")) || (prev == Some("(") && matches!(prev2, Some("import" | "require")));
        if is_import_like {
            specs.push(spec);
        }
    }
    specs
}

fn resolve_ts_relative_target(root: &Path, from_rel: &str, spec: &str) -> Option<String> {
    let dir = from_rel.rsplit_once('/').map_or("", |(d, _)| d);
    let joined = if dir.is_empty() { spec.to_owned() } else { format!("{dir}/{spec}") };
    let norm = qa::normalize_posix_path(&joined);
    if norm.starts_with("..") {
        return None;
    }

    let mut candidates = vec![norm.clone()];
    for (js_ext, ts_exts) in [
        (".js", &[".ts", ".tsx", ".mts"][..]),
        (".jsx", &[".tsx", ".ts"][..]),
        (".mjs", &[".mts", ".ts"][..]),
        (".cjs", &[".cts", ".ts"][..]),
    ] {
        if let Some(stem) = norm.strip_suffix(js_ext) {
            for ext in ts_exts {
                candidates.push(format!("{stem}{ext}"));
            }
        }
    }
    for ext in [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] {
        candidates.push(format!("{norm}{ext}"));
    }
    for idx_file in ["index.ts", "index.tsx", "index.js", "index.jsx"] {
        candidates.push(format!("{norm}/{idx_file}"));
    }

    candidates.into_iter().find(|cand| root.join(cand).is_file())
}

fn collect_ts_package_files(pkg_dir: &Path, root: &Path, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(pkg_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_dir() {
            if matches!(
                name_str.as_ref(),
                ".git" | ".metrics" | ".uml" | "node_modules" | "target" | "dist" | "build" | "build-shell"
            ) {
                continue;
            }
            collect_ts_package_files(&path, root, out);
        } else if ft.is_file() && Lang::from_path(&path) == Some(Lang::TypeScript) {
            out.push(qa::to_rel_posix(root, &path));
        }
    }
}

fn collect_relative_copy_closure(root: &Path, file: &CollectedFile) -> BTreeSet<String> {
    let mut copies = BTreeSet::new();
    copies.insert(file.rel_path.clone());

    if file.lang == Lang::TypeScript {
        // 1. Forward transitive closure along `./` and `../` imports.
        let mut queue = VecDeque::new();
        queue.push_back(file.rel_path.clone());
        while let Some(cur) = queue.pop_front() {
            let Ok(src) = fs::read_to_string(root.join(&cur)) else {
                continue;
            };
            for spec in extract_ts_relative_specifiers(&src) {
                if let Some(resolved) = resolve_ts_relative_target(root, &cur, &spec)
                    && copies.insert(resolved.clone())
                {
                    queue.push_back(resolved);
                }
            }
        }

        // 2. Reverse relative importers in the same package/dir (including test files) so Node/Vitest
        //    never resolves symlinks back into the unmutated live tree.
        let pkg_dir = find_nearest_file(root, &file.path, "package.json")
            .and_then(|p| p.parent().map(Path::to_path_buf))
            .unwrap_or_else(|| root.to_path_buf());
        let mut pkg_files = Vec::new();
        collect_ts_package_files(&pkg_dir, root, &mut pkg_files);
        let mut edges: HashMap<String, Vec<String>> = HashMap::new();
        for cand in &pkg_files {
            if let Ok(src) = fs::read_to_string(root.join(cand)) {
                for spec in extract_ts_relative_specifiers(&src) {
                    if let Some(target) = resolve_ts_relative_target(root, cand, &spec) {
                        edges.entry(target).or_default().push(cand.clone());
                    }
                }
            }
        }
        let mut rev_queue: VecDeque<String> = copies.iter().cloned().collect();
        while let Some(cur) = rev_queue.pop_front() {
            if let Some(importers) = edges.get(&cur) {
                for importer in importers {
                    if copies.insert(importer.clone()) {
                        rev_queue.push_back(importer.clone());
                    }
                }
            }
        }
    }

    // Include root & nearest manifests/configs as real files so `cargo`, `node`, or `vitest` never
    // canonicalizes a manifest symlink back to the live repository root.
    for manifest in [
        "Cargo.toml",
        "Cargo.lock",
        "package.json",
        "vite.config.ts",
        "vitest.config.ts",
        "tsconfig.json",
    ] {
        if root.join(manifest).is_file() {
            copies.insert(manifest.to_owned());
        }
        if let Some(found) = find_nearest_file(root, &file.path, manifest) {
            copies.insert(qa::to_rel_posix(root, &found));
        }
    }

    copies
}

struct WorkersGuard {
    workers_dir: PathBuf,
    run_dirs: Vec<PathBuf>,
}

impl WorkersGuard {
    fn new(root: &Path, count: usize) -> Result<Self, String> {
        let workers_dir = root.join("target").join("mutation-workers");
        fs::create_dir_all(&workers_dir).map_err(|err| format!("failed to create {}: {err}", workers_dir.display()))?;
        let pid = std::process::id();
        let mut run_dirs = Vec::with_capacity(count);
        for idx in 0..count {
            let dir = workers_dir.join(format!("worker-{pid}-{idx}"));
            if dir.exists() {
                let _ = fs::remove_dir_all(&dir);
            }
            run_dirs.push(dir);
        }
        Ok(Self { workers_dir, run_dirs })
    }
}

impl Drop for WorkersGuard {
    fn drop(&mut self) {
        for dir in &self.run_dirs {
            let _ = fs::remove_dir_all(dir);
        }
        if let Ok(mut entries) = fs::read_dir(&self.workers_dir)
            && entries.next().is_none()
        {
            let _ = fs::remove_dir(&self.workers_dir);
        }
    }
}

#[cfg(unix)]
fn symlink_path(src: &Path, dst: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(src, dst).map_err(|err| format!("failed to symlink {} -> {}: {err}", dst.display(), src.display()))
}

#[cfg(not(unix))]
fn symlink_path(src: &Path, dst: &Path) -> Result<(), String> {
    if src.is_dir() {
        fs::create_dir_all(dst).map_err(|err| format!("failed to create {}: {err}", dst.display()))?;
        for entry in fs::read_dir(src).map_err(|err| format!("failed to read {}: {err}", src.display()))? {
            let entry = entry.map_err(|err| format!("failed to read entry: {err}"))?;
            symlink_path(&entry.path(), &dst.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(src, dst).map(|_| ()).map_err(|err| format!("failed to copy {}: {err}", src.display()))
    }
}

fn populate_overlay_dir(src_dir: &Path, dst_dir: &Path, rel_prefix: &str, split_dirs: &HashSet<String>, copy_files: &BTreeSet<String>) -> Result<(), String> {
    fs::create_dir_all(dst_dir).map_err(|err| format!("failed to create {}: {err}", dst_dir.display()))?;
    let entries = fs::read_dir(src_dir).map_err(|err| format!("failed to read {}: {err}", src_dir.display()))?;

    for entry in entries {
        let entry = entry.map_err(|err| format!("failed to read dir entry in {}: {err}", src_dir.display()))?;
        let name_os = entry.file_name();
        let name = name_os.to_string_lossy();
        let src_path = entry.path();
        let dst_path = dst_dir.join(&name_os);
        let rel = if rel_prefix.is_empty() {
            name.to_string()
        } else {
            format!("{rel_prefix}/{name}")
        };

        // Never recurse into `target/mutation-workers` itself if mirroring `target`.
        if rel == "target/mutation-workers" {
            continue;
        }

        if copy_files.contains(&rel) && src_path.is_file() {
            fs::copy(&src_path, &dst_path).map_err(|err| format!("failed to copy {} -> {}: {err}", src_path.display(), dst_path.display()))?;
        } else if split_dirs.contains(&rel) && src_path.is_dir() {
            populate_overlay_dir(&src_path, &dst_path, &rel, split_dirs, copy_files)?;
        } else {
            symlink_path(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

fn build_worker_overlay(root: &Path, worker_dir: &Path, copy_files: &BTreeSet<String>) -> Result<(), String> {
    if worker_dir.exists() {
        fs::remove_dir_all(worker_dir).map_err(|err| format!("failed to clean {}: {err}", worker_dir.display()))?;
    }
    let mut split_dirs = HashSet::new();
    for rel in copy_files {
        let mut cur = Path::new(rel).parent();
        while let Some(p) = cur {
            let norm = qa::normalize_posix_path(&p.to_string_lossy());
            if norm.is_empty() {
                break;
            }
            split_dirs.insert(norm);
            cur = p.parent();
        }
    }
    populate_overlay_dir(root, worker_dir, "", &split_dirs, copy_files)
}

#[derive(Debug, Clone)]
struct PendingMutant {
    file_idx: usize,
    form_idx: usize,
    site_idx: usize,
    file_rel: String,
    site: MutationSite,
    spec: TestCommandSpec,
}

#[derive(Debug, Clone)]
enum SiteResolution {
    Uncovered,
    Cached(MutantOutcome),
    Pending,
}

fn load_prior_snapshots(root: &Path, namespaces: &BTreeSet<String>) -> HashMap<String, MutateSnapshot> {
    let mut out = HashMap::new();
    for ns in namespaces {
        let path = qa::mutate_snapshot_path(root, ns);
        if path.is_file()
            && let Ok(snap) = qa::read_json::<MutateSnapshot>(&path)
        {
            out.insert(ns.clone(), snap);
        }
    }
    out
}

fn execute_pending_mutants(
    root: &Path,
    plans: &[FileMutationPlan],
    pending: &[PendingMutant],
    copy_closures: &HashMap<String, BTreeSet<String>>,
    timeout: Duration,
    max_workers: usize,
) -> Result<Vec<MutantOutcome>, String> {
    let worker_count = max_workers.min(pending.len()).max(1);
    let guard = WorkersGuard::new(root, worker_count)?;
    let results: Vec<Mutex<Option<MutantOutcome>>> = (0..pending.len()).map(|_| Mutex::new(None)).collect();
    let next_idx = AtomicUsize::new(0);
    let first_error: Mutex<Option<String>> = Mutex::new(None);

    std::thread::scope(|scope| {
        for worker_dir in &guard.run_dirs {
            scope.spawn(|| {
                let mut current_closure_key: Option<String> = None;
                let mut current_mutated_rel: Option<String> = None;

                loop {
                    if first_error.lock().is_ok_and(|g| g.is_some()) {
                        break;
                    }
                    let idx = next_idx.fetch_add(1, Ordering::Relaxed);
                    if idx >= pending.len() {
                        break;
                    }
                    let task = &pending[idx];
                    let Some(closure) = copy_closures.get(&task.file_rel) else {
                        if let Ok(mut err_slot) = first_error.lock()
                            && err_slot.is_none()
                        {
                            *err_slot = Some(format!("missing copy closure for {}", task.file_rel));
                        }
                        break;
                    };

                    if current_closure_key.as_ref() != Some(&task.file_rel) {
                        if let Some(prev_rel) = current_mutated_rel.take() {
                            let _ = fs::copy(root.join(&prev_rel), worker_dir.join(&prev_rel));
                        }
                        if let Err(err) = build_worker_overlay(root, worker_dir, closure) {
                            if let Ok(mut err_slot) = first_error.lock()
                                && err_slot.is_none()
                            {
                                *err_slot = Some(err);
                            }
                            break;
                        }
                        current_closure_key = Some(task.file_rel.clone());
                    }

                    let original_source = &plans[task.file_idx].source;
                    let mutated_source = apply_mutation(original_source, &task.site);
                    let worker_file = worker_dir.join(&task.file_rel);
                    if let Err(err) = fs::write(&worker_file, &mutated_source) {
                        if let Ok(mut err_slot) = first_error.lock()
                            && err_slot.is_none()
                        {
                            *err_slot = Some(format!("failed to write mutant {}: {err}", worker_file.display()));
                        }
                        break;
                    }
                    current_mutated_rel = Some(task.file_rel.clone());

                    let outcome_res = run_command_with_timeout(worker_dir, &task.spec, Some(timeout));
                    let _ = fs::write(&worker_file, original_source);

                    match outcome_res {
                        Ok(cmd_out) => {
                            let classified = classify_mutant_outcome(&cmd_out);
                            if let Ok(mut slot) = results[idx].lock() {
                                *slot = Some(classified);
                            }
                        }
                        Err(err) => {
                            if let Ok(mut err_slot) = first_error.lock()
                                && err_slot.is_none()
                            {
                                *err_slot = Some(err);
                            }
                            break;
                        }
                    }
                }
            });
        }
    });

    drop(guard);

    if let Some(err) = first_error.into_inner().unwrap_or(None) {
        return Err(err);
    }

    let mut final_outcomes = Vec::with_capacity(pending.len());
    for (idx, cell) in results.into_iter().enumerate() {
        let outcome = cell
            .into_inner()
            .unwrap_or(None)
            .ok_or_else(|| format!("missing execution outcome for mutant index {idx}"))?;
        final_outcomes.push(outcome);
    }
    Ok(final_outcomes)
}

fn build_mutate_form(form: &FormInfo, records: Vec<MutantRecord>) -> MutateForm {
    let mut killed = 0usize;
    let mut survived = 0usize;
    let mut uncovered = 0usize;
    let mut timeout = 0usize;
    let mut compile_error = 0usize;

    for r in &records {
        match r.outcome {
            MutantOutcome::Killed => killed += 1,
            MutantOutcome::Survived => survived += 1,
            MutantOutcome::Uncovered => uncovered += 1,
            MutantOutcome::Timeout => timeout += 1,
            MutantOutcome::CompileError => compile_error += 1,
        }
    }
    let detected = killed + timeout + compile_error;
    let executed = detected + survived;
    let score = (executed > 0).then(|| detected as f64 / executed as f64);

    MutateForm {
        namespace: form.namespace.clone(),
        name: form.name.clone(),
        kind: form.kind,
        visibility: form.visibility,
        lang: form.lang,
        file: form.file.clone(),
        start_line: form.start_line,
        end_line: form.end_line,
        body_hash: form.body_hash.clone(),
        killed,
        survived,
        uncovered,
        timeout,
        compile_error,
        total_sites: records.len(),
        score,
        mutants: records,
    }
}

fn filter_files_for_run(root: &Path, opts: &CliOptions) -> Result<Vec<CollectedFile>, String> {
    let mut files = qa::collect_project_files(root, &opts.filters, None)?;
    if opts.changed {
        let changed_set: HashSet<String> = qa::changed_files(root)?
            .into_iter()
            .map(|p| qa::normalize_posix_path(&p.to_string_lossy()))
            .collect();
        files.retain(|f| changed_set.contains(&f.rel_path));
    }
    Ok(files)
}

pub fn run(root: &Path, args: &[String]) -> Result<i32, String> {
    let opts = parse_args(args)?;
    if opts.help {
        println!("{USAGE}");
        return Ok(0);
    }

    let files = filter_files_for_run(root, &opts)?;
    let coverage = CoverageState::load(root, opts.no_coverage)?;

    let mut plans = Vec::with_capacity(files.len());
    let mut namespaces = BTreeSet::new();
    for file in files {
        let source = fs::read_to_string(&file.path).map_err(|err| format!("failed to read {}: {err}", file.path.display()))?;
        let discovered = discover_file_sites(root, &file.path, &source, file.lang);
        let forms = assign_defn_keys(discovered);
        for f in &forms {
            namespaces.insert(f.form.namespace.clone());
        }
        plans.push(FileMutationPlan { file, source, forms });
    }

    if opts.scan {
        return emit_scan_output(root, &plans, &coverage, opts.json);
    }

    let prior_snapshots = load_prior_snapshots(root, &namespaces);

    let mut resolutions: Vec<Vec<Vec<SiteResolution>>> = Vec::with_capacity(plans.len());
    let mut pending: Vec<PendingMutant> = Vec::new();
    let mut cached_skipped = 0usize;

    for (file_idx, plan) in plans.iter().enumerate() {
        let spec = resolve_test_command(root, &plan.file, opts.test_command.as_deref());
        let mut file_res = Vec::with_capacity(plan.forms.len());
        for (form_idx, form_sites) in plan.forms.iter().enumerate() {
            let prior_form = if opts.since_last_run {
                prior_snapshots
                    .get(&form_sites.form.namespace)
                    .and_then(|snap| {
                        snap.forms.get(&form_sites.defn_key).or_else(|| {
                            snap.forms
                                .values()
                                .find(|pf| pf.file == form_sites.form.file && pf.name == form_sites.form.name)
                        })
                    })
                    .filter(|pf| pf.body_hash == form_sites.form.body_hash)
            } else {
                None
            };
            let prior_by_id: HashMap<&str, MutantOutcome> = prior_form
                .map(|pf| pf.mutants.iter().map(|m| (m.id.as_str(), m.outcome)).collect())
                .unwrap_or_default();

            let mut form_res = Vec::with_capacity(form_sites.sites.len());
            for (site_idx, site) in form_sites.sites.iter().enumerate() {
                if !coverage.is_line_covered(root, &plan.file.rel_path, site.line) {
                    form_res.push(SiteResolution::Uncovered);
                    continue;
                }
                if let Some(&prev_outcome) = prior_by_id.get(site.id.as_str())
                    && is_killed_like(prev_outcome)
                {
                    cached_skipped += 1;
                    form_res.push(SiteResolution::Cached(prev_outcome));
                    continue;
                }
                form_res.push(SiteResolution::Pending);
                pending.push(PendingMutant {
                    file_idx,
                    form_idx,
                    site_idx,
                    file_rel: plan.file.rel_path.clone(),
                    site: site.clone(),
                    spec: spec.clone(),
                });
            }
            file_res.push(form_res);
        }
        resolutions.push(file_res);
    }

    // Run baseline tests once per unique test command target when there is pending work.
    let mut baseline_ms = 0u128;
    let mut timeout = Duration::from_secs(2);
    if !pending.is_empty() {
        let mut unique_specs: Vec<TestCommandSpec> = Vec::new();
        for p in &pending {
            if !unique_specs.contains(&p.spec) {
                unique_specs.push(p.spec.clone());
            }
        }
        let mut max_baseline = Duration::ZERO;
        for spec in &unique_specs {
            let outcome = run_command_with_timeout(root, spec, None)?;
            baseline_ms = baseline_ms.saturating_add(outcome.duration.as_millis());
            if outcome.duration > max_baseline {
                max_baseline = outcome.duration;
            }
            if outcome.exit_code != Some(0) {
                if opts.json {
                    let report = RunReport {
                        version: 1,
                        mode: "run",
                        baseline_passed: false,
                        baseline_ms,
                        timeout_ms: 0,
                        files_scanned: plans.len(),
                        forms_scanned: plans.iter().map(|p| p.forms.len()).sum(),
                        total_sites: plans.iter().flat_map(|p| &p.forms).map(|f| f.sites.len()).sum(),
                        executed: 0,
                        cached_skipped,
                        killed: 0,
                        timeout: 0,
                        compile_error: 0,
                        survived: 0,
                        uncovered: 0,
                        score: None,
                        snapshots: Vec::new(),
                        survivors: Vec::new(),
                    };
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&report).map_err(|err| format!("JSON serialize error: {err}"))?
                    );
                }
                eprintln!(
                    "mutate: baseline test command `{}` failed (exit {:?}); aborting without updating .metrics/mutate/\n{}",
                    spec.label(),
                    outcome.exit_code,
                    outcome.stderr.trim()
                );
                return Ok(2);
            }
        }
        timeout = Duration::from_secs(2).max(max_baseline.mul_f64(opts.timeout_factor));
    }

    // Prepare copy closures once per unique file in `pending` and execute in parallel workers.
    let mut pending_outcomes = Vec::new();
    if !pending.is_empty() {
        let mut copy_closures = HashMap::new();
        for p in &pending {
            if !copy_closures.contains_key(&p.file_rel) {
                copy_closures.insert(p.file_rel.clone(), collect_relative_copy_closure(root, &plans[p.file_idx].file));
            }
        }
        pending.sort_by(|a, b| a.file_rel.cmp(&b.file_rel));
        // Re-map sorted indices cleanly by tracking original index or resolving directly via coordinates.
        pending_outcomes = execute_pending_mutants(root, &plans, &pending, &copy_closures, timeout, opts.max_workers)?;
    }

    let mut resolved_outcomes: Vec<Vec<Vec<MutantOutcome>>> = resolutions
        .iter()
        .map(|file_res| {
            file_res
                .iter()
                .map(|form_res| {
                    form_res
                        .iter()
                        .map(|r| match r {
                            SiteResolution::Uncovered => MutantOutcome::Uncovered,
                            SiteResolution::Cached(out) => *out,
                            SiteResolution::Pending => MutantOutcome::Killed,
                        })
                        .collect()
                })
                .collect()
        })
        .collect();

    for (p, outcome) in pending.iter().zip(pending_outcomes.iter().copied()) {
        resolved_outcomes[p.file_idx][p.form_idx][p.site_idx] = outcome;
    }

    // Group forms by namespace and update `.metrics/mutate/<ns>.json`.
    let mut ns_lang: HashMap<String, Lang> = HashMap::new();
    let mut analyzed_files_by_ns: HashMap<String, HashSet<String>> = HashMap::new();
    let mut new_forms_by_ns: HashMap<String, Vec<(String, MutateForm)>> = HashMap::new();

    let mut total_killed = 0usize;
    let mut total_timeout = 0usize;
    let mut total_compile_error = 0usize;
    let mut total_survived = 0usize;
    let mut total_uncovered = 0usize;
    let mut total_sites = 0usize;
    let mut forms_scanned = 0usize;
    let mut survivors = Vec::new();

    for (file_idx, plan) in plans.iter().enumerate() {
        for (form_idx, form_sites) in plan.forms.iter().enumerate() {
            forms_scanned += 1;
            ns_lang.entry(form_sites.form.namespace.clone()).or_insert(form_sites.form.lang);
            analyzed_files_by_ns
                .entry(form_sites.form.namespace.clone())
                .or_default()
                .insert(plan.file.rel_path.clone());

            let mut records = Vec::with_capacity(form_sites.sites.len());
            for (site_idx, site) in form_sites.sites.iter().enumerate() {
                let outcome = resolved_outcomes[file_idx][form_idx][site_idx];
                total_sites += 1;
                match outcome {
                    MutantOutcome::Killed => total_killed += 1,
                    MutantOutcome::Timeout => total_timeout += 1,
                    MutantOutcome::CompileError => total_compile_error += 1,
                    MutantOutcome::Uncovered => total_uncovered += 1,
                    MutantOutcome::Survived => {
                        total_survived += 1;
                        survivors.push(SurvivorSummary {
                            id: site.id.clone(),
                            file: site.file.clone(),
                            namespace: site.namespace.clone(),
                            form: site.form_name.clone(),
                            line: site.line,
                            col: site.col,
                            original: site.original.clone(),
                            replacement: site.replacement.clone(),
                        });
                    }
                }
                records.push(MutantRecord {
                    id: site.id.clone(),
                    line: site.line,
                    col: site.col,
                    start_byte: site.start_byte,
                    end_byte: site.end_byte,
                    original: site.original.clone(),
                    replacement: site.replacement.clone(),
                    outcome,
                });
            }

            let mutate_form = build_mutate_form(&form_sites.form, records);
            new_forms_by_ns
                .entry(form_sites.form.namespace.clone())
                .or_default()
                .push((form_sites.defn_key.clone(), mutate_form));
        }
    }

    let mut written_snapshots = Vec::new();
    for (ns, forms_list) in new_forms_by_ns {
        let snap_path = qa::mutate_snapshot_path(root, &ns);
        let mut merged_forms: BTreeMap<String, MutateForm> = prior_snapshots.get(&ns).map(|s| s.forms.clone()).unwrap_or_default();
        if let Some(analyzed_files) = analyzed_files_by_ns.get(&ns) {
            merged_forms.retain(|_, mf| !analyzed_files.contains(&mf.file) && root.join(&mf.file).is_file());
        }
        for (key, mf) in forms_list {
            merged_forms.insert(key, mf);
        }
        let snapshot = MutateSnapshot {
            version: 1,
            namespace: ns.clone(),
            lang: ns_lang[&ns],
            forms: merged_forms,
        };
        qa::write_json(&snap_path, &snapshot)?;
        written_snapshots.push(qa::to_rel_posix(root, &snap_path));
    }

    let detected = total_killed + total_timeout + total_compile_error;
    let total_scored = detected + total_survived;
    let score = (total_scored > 0).then(|| detected as f64 / total_scored as f64);

    let report = RunReport {
        version: 1,
        mode: "run",
        baseline_passed: true,
        baseline_ms,
        timeout_ms: timeout.as_millis(),
        files_scanned: plans.len(),
        forms_scanned,
        total_sites,
        executed: pending.len(),
        cached_skipped,
        killed: total_killed,
        timeout: total_timeout,
        compile_error: total_compile_error,
        survived: total_survived,
        uncovered: total_uncovered,
        score,
        snapshots: written_snapshots,
        survivors,
    };

    if opts.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&report).map_err(|err| format!("JSON serialize error: {err}"))?
        );
    } else {
        let score_pct = report.score.map_or_else(|| "n/a".to_owned(), |s| format!("{:.1}%", s * 100.0));
        println!(
            "mutate: {} files, {} forms, {} sites (executed: {}, cached: {}, killed: {}, timeout: {}, compile_error: {}, survived: {}, uncovered: {}, score: {})",
            report.files_scanned,
            report.forms_scanned,
            report.total_sites,
            report.executed,
            report.cached_skipped,
            report.killed,
            report.timeout,
            report.compile_error,
            report.survived,
            report.uncovered,
            score_pct
        );
        for s in &report.survivors {
            println!(
                "  SURVIVED {}:{}:{} `{}` -> `{}` ({} {})",
                s.file, s.line, s.col, s.original, s.replacement, s.namespace, s.form
            );
        }
    }

    Ok(if total_survived > 0 { 3 } else { 0 })
}

fn emit_scan_output(root: &Path, plans: &[FileMutationPlan], coverage: &CoverageState, json: bool) -> Result<i32, String> {
    let mut forms_scanned = 0usize;
    let mut covered_sites = 0usize;
    let mut uncovered_sites = 0usize;
    let mut sites = Vec::new();

    for plan in plans {
        for form_sites in &plan.forms {
            forms_scanned += 1;
            for site in &form_sites.sites {
                let covered = coverage.is_line_covered(root, &plan.file.rel_path, site.line);
                if covered {
                    covered_sites += 1;
                } else {
                    uncovered_sites += 1;
                }
                sites.push(ScanSiteJson {
                    id: site.id.clone(),
                    file: site.file.clone(),
                    namespace: site.namespace.clone(),
                    form: site.form_name.clone(),
                    defn_key: site.defn_key.clone(),
                    lang: site.lang,
                    line: site.line,
                    col: site.col,
                    start_byte: site.start_byte,
                    end_byte: site.end_byte,
                    original: site.original.clone(),
                    replacement: site.replacement.clone(),
                    covered,
                });
            }
        }
    }

    let report = ScanReport {
        version: 1,
        mode: "scan",
        files_scanned: plans.len(),
        forms_scanned,
        total_sites: sites.len(),
        covered_sites,
        uncovered_sites,
        sites,
    };

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&report).map_err(|err| format!("JSON serialize error: {err}"))?
        );
    } else {
        println!(
            "mutate --scan: {} files, {} forms, {} sites (covered: {}, uncovered: {})",
            report.files_scanned, report.forms_scanned, report.total_sites, report.covered_sites, report.uncovered_sites
        );
        for s in &report.sites {
            let cov = if s.covered { "covered" } else { "uncovered" };
            println!(
                "  {}:{}:{} [{}] `{}` -> `{}` ({} {})",
                s.file, s.line, s.col, cov, s.original, s.replacement, s.namespace, s.form
            );
        }
    }

    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_repo(tag: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("xtask-mutate-{tag}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn discovers_exact_rust_sites_and_ignores_strings_comments_and_generics() {
        let src = [
            "pub fn calc<T: Clone>(items: Vec<i32>, ok: bool) -> i32 {",
            "    // ignore == != + - && || true false 0 1 in comments",
            r#"    let msg = "ignore == != + - && || true false 0 1 in strings";"#,
            r##"    let raw = r#"ignore < > * / ! in raw string"#;"##,
            "    let ch = '0';",
            "    let mut v: Vec<i32> = Vec::<i32>::new();",
            "    let x = -1;",
            "    if !ok || items.len() == 0 {",
            "        println!(\"! + -\");",
            "        return 0;",
            "    }",
            "    let a = items[0] + 1 - 1;",
            "    let b = a * 1 / 1;",
            "    if b > 0 && b <= 1 && a != 0 && a >= 1 && a < 1 {",
            "        let f = || true;",
            "        if f() { *(&b) } else { 1 }",
            "    } else {",
            "        let _ = ch;",
            "        let _ = (msg, raw, &mut v);",
            "        0",
            "    }",
            "}",
        ]
        .join("\n");

        let root = Path::new("/repo");
        let file = Path::new("/repo/crates/core/src/calc.rs");
        let forms = discover_file_sites(root, file, &src, Lang::Rust);
        assert_eq!(forms.len(), 1);
        let pairs: Vec<(&str, &str)> = forms[0].1.iter().map(|s| (s.original.as_str(), s.replacement.as_str())).collect();

        // Expected mutations in body (skipping signature `Vec<i32>`, comments, strings, raw strings, char `'0'`,
        // generics `Vec<i32>` / `Vec::<i32>`, `println!`, closure `||`, deref `*(&b)`):
        // line 7: `-` -> `""`, `1` -> `0`
        // line 8: `!` -> `""`, `||` -> `&&`, `==` -> `!=`, `0` -> `1`
        // line 10: `0` -> `1`
        // line 12: `0` -> `1`, `+` -> `-`, `1` -> `0`, `-` -> `+`, `1` -> `0`
        // line 13: `*` -> `/`, `1` -> `0`, `/` -> `*`, `1` -> `0`
        // line 14: `>` -> `>=`, `0` -> `1`, `&&` -> `||`, `<=` -> `<`, `1` -> `0`, `&&` -> `||`, `!=` -> `==`, `0` -> `1`, `&&` -> `||`, `>=` -> `>`, `1` -> `0`, `&&` -> `||`, `<` -> `<=`, `1` -> `0`
        // line 15: `true` -> `false` (closure `||` skipped!)
        // line 16: `1` -> `0` (deref `*(&b)` skipped!)
        // line 20: `0` -> `1`
        assert_eq!(
            pairs,
            vec![
                ("-", ""),
                ("1", "0"),
                ("!", ""),
                ("||", "&&"),
                ("==", "!="),
                ("0", "1"),
                ("0", "1"),
                ("0", "1"),
                ("+", "-"),
                ("1", "0"),
                ("-", "+"),
                ("1", "0"),
                ("*", "/"),
                ("1", "0"),
                ("/", "*"),
                ("1", "0"),
                (">", ">="),
                ("0", "1"),
                ("&&", "||"),
                ("<=", "<"),
                ("1", "0"),
                ("&&", "||"),
                ("!=", "=="),
                ("0", "1"),
                ("&&", "||"),
                (">=", ">"),
                ("1", "0"),
                ("&&", "||"),
                ("<", "<="),
                ("1", "0"),
                ("true", "false"),
                ("1", "0"),
                ("0", "1"),
            ]
        );
        for site in &forms[0].1 {
            let mutated = apply_mutation(&src, site);
            assert_ne!(mutated, src);
        }
    }

    #[test]
    fn discovers_exact_ts_and_tsx_sites_including_optional_chaining_nullish_and_jsx() {
        let src = [
            "export const greet = (user?: { name?: string }) => `prefix ${user?.name ?? 'anon'} suffix`;",
            "",
            "export function check(user: { run?: () => number; items?: number[] } | null, x: number): number {",
            "  // ignore === !== ?? ?. in comments",
            "  const re = /a+b===c/gi;",
            "  const txt = 'ignore === ?? ?.';",
            "  const val = user?.run?.() ?? user?.items?.[0] ?? 1;",
            "  const ok = val === 0 || val !== 1;",
            "  const neg = !ok ? -x : x + 1;",
            "  const arr = useState<number>(0);",
            "  return <div data-id=\"a+b\">{ok && neg > 0 ? 1 : 0}</div>;",
            "}",
        ]
        .join("\n");

        let root = Path::new("/repo");
        let file = Path::new("/repo/apps/mac/ui/features/demo/view.tsx");
        let forms = discover_file_sites(root, file, &src, Lang::TypeScript);
        assert_eq!(forms.len(), 2);

        let greet_pairs: Vec<(&str, &str)> = forms[0].1.iter().map(|s| (s.original.as_str(), s.replacement.as_str())).collect();
        assert_eq!(greet_pairs, vec![("?.", "."), ("??", "||")]);

        let pairs: Vec<(&str, &str)> = forms[1].1.iter().map(|s| (s.original.as_str(), s.replacement.as_str())).collect();
        assert_eq!(
            pairs,
            vec![
                ("?.", "."),
                ("?.", ""),
                ("??", "||"),
                ("?.", "."),
                ("?.", ""),
                ("0", "1"),
                ("??", "||"),
                ("1", "0"),
                ("===", "!=="),
                ("0", "1"),
                ("||", "&&"),
                ("!==", "==="),
                ("1", "0"),
                ("!", ""),
                ("-", ""),
                ("+", "-"),
                ("1", "0"),
                ("0", "1"),
                ("&&", "||"),
                (">", ">="),
                ("0", "1"),
                ("1", "0"),
                ("0", "1"),
            ]
        );

        // Verify exact text transformation for `user?.run?.()` -> `user?.run()` and `user?.items?.[0]` -> `user?.items[0]`
        let call_site = forms[1].1.iter().find(|s| s.line == 7 && s.replacement.is_empty()).unwrap();
        assert!(apply_mutation(&src, call_site).contains("user?.run()"));
        let idx_site = forms[1].1.iter().filter(|s| s.line == 7 && s.replacement.is_empty()).nth(1).unwrap();
        assert!(apply_mutation(&src, idx_site).contains("user?.items[0]"));
    }

    #[test]
    fn scan_mode_outputs_valid_json_without_writing_metrics_or_running_tests() {
        let dir = temp_repo("scan");
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src/lib.rs"), "pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n").unwrap();

        let code = run(&dir, &["--scan".to_owned(), "--json".to_owned()]).unwrap();
        assert_eq!(code, 0);
        assert!(!dir.join(".metrics").exists(), "--scan must not write .metrics");
        assert!(!dir.join("target/mutation-workers").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn coverage_gating_skips_uncovered_lines_and_executes_covered_lines() {
        let dir = temp_repo("cov");
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::create_dir_all(dir.join("tests")).unwrap();
        fs::write(
            dir.join("Cargo.toml"),
            "[package]\nname = \"cov_demo\"\nversion = \"0.1.0\"\nedition = \"2024\"\n",
        )
        .unwrap();
        fs::write(
            dir.join("src/lib.rs"),
            [
                "pub fn pick(a: i32, b: i32, flag: bool) -> i32 {",
                "    if flag {",
                "        a + b",
                "    } else {",
                "        a - b",
                "    }",
                "}",
            ]
            .join("\n"),
        )
        .unwrap();
        fs::write(
            dir.join("tests/it.rs"),
            "use cov_demo::pick;\n#[test]\nfn covers_true_branch() {\n    assert_eq!(pick(2, 3, true), 5);\n}\n",
        )
        .unwrap();

        // Line 3 (`a + b`) has 1 hit; line 5 (`a - b`) has 0 hits.
        fs::write(
            dir.join("lcov.info"),
            ["SF:src/lib.rs", "DA:2,1", "DA:3,1", "DA:5,0", "end_of_record"].join("\n"),
        )
        .unwrap();

        let code = run(&dir, &["--use-existing-coverage".to_owned(), "--max-workers".to_owned(), "1".to_owned()]).unwrap();
        // Only covered `a + b` -> `a - b` executes and is killed; uncovered `a - b` is skipped (not executed, so not a survivor!).
        assert_eq!(code, 0);

        let snap: MutateSnapshot = qa::read_json(&qa::mutate_snapshot_path(&dir, "crate")).unwrap();
        let form = snap.forms.get("defn/pick").unwrap();
        assert_eq!(form.killed, 1);
        assert_eq!(form.uncovered, 1);
        assert_eq!(form.survived, 0);
        assert_eq!(form.mutants.iter().find(|m| m.line == 3).unwrap().outcome, MutantOutcome::Killed);
        assert_eq!(form.mutants.iter().find(|m| m.line == 5).unwrap().outcome, MutantOutcome::Uncovered);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn end_to_end_kill_survivor_baseline_failure_differential_cache_and_zero_live_mutation() {
        let dir = temp_repo("e2e");
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::create_dir_all(dir.join("tests")).unwrap();
        fs::write(
            dir.join("Cargo.toml"),
            "[package]\nname = \"e2e_demo\"\nversion = \"0.1.0\"\nedition = \"2024\"\n",
        )
        .unwrap();

        let original_src = [
            "pub fn sum(a: i32, b: i32) -> i32 {",
            "    a + b",
            "}",
            "",
            "pub fn weakly_tested(x: i32) -> i32 {",
            "    if x > 0 { 1 } else { 0 }",
            "}",
        ]
        .join("\n");
        let lib_path = dir.join("src/lib.rs");
        fs::write(&lib_path, &original_src).unwrap();

        // `sum` is tested properly (a+b -> a-b fails).
        // `weakly_tested(5)` returns 1 for both `x > 0` and `x >= 0`, so `>` -> `>=` SURVIVES!
        fs::write(
            dir.join("tests/it.rs"),
            [
                "use e2e_demo::{sum, weakly_tested};",
                "#[test]",
                "fn tests() {",
                "    assert_eq!(sum(2, 3), 5);",
                "    assert_eq!(weakly_tested(5), 1);",
                "    assert_eq!(weakly_tested(-1), 0);",
                "}",
            ]
            .join("\n"),
        )
        .unwrap();

        // 1. Run with survivor -> exit code 3, live file untouched, workers cleaned up.
        let code = run(&dir, &["--no-coverage".to_owned(), "--max-workers".to_owned(), "2".to_owned()]).unwrap();
        assert_eq!(code, 3);
        assert_eq!(fs::read_to_string(&lib_path).unwrap(), original_src);
        assert!(!dir.join("target/mutation-workers").exists());

        let snap_path = qa::mutate_snapshot_path(&dir, "crate");
        let snap1: MutateSnapshot = qa::read_json(&snap_path).unwrap();
        assert_eq!(snap1.forms["defn/sum"].killed, 1);
        assert_eq!(snap1.forms["defn/sum"].survived, 0);
        assert!(snap1.forms["defn/weakly_tested"].survived >= 1);

        // 2. Differential caching (--since-last-run): unchanged `sum` is skipped (cached Killed),
        //    only prior Survived mutant(s) rerun. Use a counter script to verify exact execution count!
        let counter_file = dir.join("exec_count.txt");
        fs::write(&counter_file, "").unwrap();
        // Run with custom command that logs each invocation, keeping tests passing/failing identically via cargo test.
        let cmd = format!("echo run >> {} && cargo test --quiet", counter_file.display());
        let code2 = run(
            &dir,
            &[
                "--no-coverage".to_owned(),
                "--since-last-run".to_owned(),
                "--max-workers".to_owned(),
                "1".to_owned(),
                "--test-command".to_owned(),
                cmd,
            ],
        )
        .unwrap();
        assert_eq!(code2, 3);
        let run_lines = fs::read_to_string(&counter_file).unwrap().lines().count();
        let expected_survived = snap1.forms.values().map(|f| f.survived).sum::<usize>();
        // 1 baseline + `expected_survived` reruns (all prior Killed sites were skipped!).
        assert_eq!(run_lines, 1 + expected_survived);

        // 3. Baseline failure -> exit code 2 AND snapshot on disk is NOT overwritten!
        let snap_before_fail = fs::read_to_string(&snap_path).unwrap();
        let fail_code = run(
            &dir,
            &[
                "--no-coverage".to_owned(),
                "--mutate-all".to_owned(),
                "--test-command".to_owned(),
                "exit 1".to_owned(),
            ],
        )
        .unwrap();
        assert_eq!(fail_code, 2);
        assert_eq!(fs::read_to_string(&snap_path).unwrap(), snap_before_fail);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn overlay_worker_copies_transitive_ts_relative_imports_and_cleans_up_on_drop() {
        let dir = temp_repo("ts-overlay");
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        fs::write(dir.join("package.json"), r#"{"name":"ts-demo","type":"module"}"#).unwrap();
        fs::write(dir.join("node_modules/pkg/index.js"), "export const x = 1;\n").unwrap();
        fs::write(dir.join("src/leaf.ts"), "export const leaf = (x: number) => x + 1;\n").unwrap();
        fs::write(
            dir.join("src/mid.ts"),
            "import { leaf } from './leaf';\nexport const mid = (x: number) => leaf(x);\n",
        )
        .unwrap();
        fs::write(
            dir.join("src/top.ts"),
            "import { mid } from './mid';\nexport const top = (x: number) => mid(x);\n",
        )
        .unwrap();
        fs::write(dir.join("src/top.test.ts"), "import { top } from './top';\nconsole.log(top(1));\n").unwrap();
        fs::write(dir.join("src/unrelated.ts"), "export const other = 42;\n").unwrap();

        let top_file = CollectedFile {
            path: dir.join("src/top.ts"),
            rel_path: "src/top.ts".to_owned(),
            lang: Lang::TypeScript,
        };
        let closure = collect_relative_copy_closure(&dir, &top_file);
        assert!(closure.contains("src/top.ts"));
        assert!(closure.contains("src/mid.ts"));
        assert!(closure.contains("src/leaf.ts"));
        assert!(closure.contains("src/top.test.ts"));
        assert!(!closure.contains("src/unrelated.ts"));

        let workers_dir = dir.join("target/mutation-workers");
        {
            let guard = WorkersGuard::new(&dir, 1).unwrap();
            let w0 = &guard.run_dirs[0];
            build_worker_overlay(&dir, w0, &closure).unwrap();

            assert!(!fs::symlink_metadata(w0.join("src/top.ts")).unwrap().file_type().is_symlink());
            assert!(!fs::symlink_metadata(w0.join("src/mid.ts")).unwrap().file_type().is_symlink());
            assert!(!fs::symlink_metadata(w0.join("src/leaf.ts")).unwrap().file_type().is_symlink());
            assert!(!fs::symlink_metadata(w0.join("src/top.test.ts")).unwrap().file_type().is_symlink());
            assert!(fs::symlink_metadata(w0.join("src/unrelated.ts")).unwrap().file_type().is_symlink());
            assert!(fs::symlink_metadata(w0.join("node_modules")).unwrap().file_type().is_symlink());
        }
        assert!(!workers_dir.exists(), "WorkersGuard Drop must remove target/mutation-workers");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn timeout_counts_as_killed_and_returns_zero() {
        let dir = temp_repo("timeout");
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src/lib.rs"), "pub fn check() -> bool {\n    true\n}\n").unwrap();

        // Test command passes on unmodified `true`, sleeps 5s (exceeding 2s min timeout) on mutated `false`.
        let cmd = r#"if grep -q "false" src/lib.rs; then sleep 5; else exit 0; fi"#;
        let code = run(
            &dir,
            &[
                "--no-coverage".to_owned(),
                "--max-workers".to_owned(),
                "1".to_owned(),
                "--timeout-factor".to_owned(),
                "1".to_owned(),
                "--test-command".to_owned(),
                cmd.to_owned(),
            ],
        )
        .unwrap();
        assert_eq!(code, 0);

        let snap: MutateSnapshot = qa::read_json(&qa::mutate_snapshot_path(&dir, "crate")).unwrap();
        let form = snap.forms.get("defn/check").unwrap();
        assert_eq!(form.timeout, 1);
        assert_eq!(form.survived, 0);
        assert_eq!(form.mutants[0].outcome, MutantOutcome::Timeout);

        let _ = fs::remove_dir_all(&dir);
    }
}
