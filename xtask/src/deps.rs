//! Module dependency graph, Tarjan SCC cycle detector, and UI import layering inspector (`cargo xtask deps`).

use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, Write};
use std::path::Path;

use serde::Serialize;

use crate::rust_scan::{
    LineIndex, SourceFile, is_excluded_by_cfg_test, is_ident_char, is_ident_start, normalize_posix_path, strip_cfg_test_and_collect_excluded,
    strip_rust_comments_and_literals, walk_matching_files,
};

const USAGE: &str = "\
Usage: cargo xtask deps [crate|ui] [--cycles] [--dot] [--ui] [--json] [--strict]

Parse intra-crate `use crate::<mod>` dependencies across top-level modules,
compute fan-in/fan-out, detect cycles with Tarjan's SCC algorithm, flag reverse-layer
edges, and (with --ui or target `ui`) audit `apps/mac/ui` TS import layering.
With --strict, exits non-zero when reverse-layer or UI boundary violations > 0.";

const GATEWAY_ALLOWED_ROOT_FILES: &[&str] = &["router.rs", "app.rs", "main.rs", "lib.rs"];
const ENTRY_ALLOWED_ROOT_FILES: &[&str] = &["router.rs", "app.rs", "main.rs", "lib.rs"];
const FOUNDATION_MODULES: &[&str] = &["context", "log", "db", "config"];
const SERVER_HIGHER_MODULES: &[&str] = &[
    "agent",
    "issue",
    "cron",
    "game",
    "channel",
    "connector",
    "voice",
    "note",
    "runtime",
    "repo",
    "setting",
    "provider",
    "machine",
    "storage",
    "debug",
    "gateway",
    "app",
    "router",
];
const RUNTIME_FORBIDDEN_TARGETS: &[&str] = &["agent", "issue", "cron", "game", "gateway", "app", "router"];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModuleNodeMetrics {
    pub module: String,
    pub files: usize,
    pub fan_in: usize,
    pub fan_out: usize,
    pub instability: f64,
    pub depends_on: Vec<String>,
    pub depended_by: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EdgeSite {
    pub from_module: String,
    pub to_module: String,
    pub file: String,
    pub line: usize,
    pub snippet: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CycleReport {
    pub nodes: Vec<String>,
    pub path: String,
    pub edges: Vec<EdgeSite>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReverseLayerViolation {
    pub rule: String,
    pub from_module: String,
    pub to_module: String,
    pub file: String,
    pub line: usize,
    pub snippet: String,
    pub why: String,
    pub fix_hint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UiLayerViolation {
    pub rule: String,
    pub file: String,
    pub line: usize,
    pub from_layer: String,
    pub to_target: String,
    pub specifier: String,
    pub why: String,
    pub fix_hint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DepsSummary {
    pub target: Option<String>,
    pub modules: usize,
    pub edges: usize,
    pub scc_count: usize,
    pub cycle_count: usize,
    pub reverse_layer_count: usize,
    pub ui_files_scanned: usize,
    pub ui_violation_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DepsReport {
    pub summary: DepsSummary,
    pub modules: Vec<ModuleNodeMetrics>,
    pub cycles: Vec<CycleReport>,
    pub reverse_layer_violations: Vec<ReverseLayerViolation>,
    pub ui_violations: Vec<UiLayerViolation>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TokKind {
    Ident,
    Punct,
}

#[derive(Debug, Clone)]
struct Tok {
    kind: TokKind,
    text: String,
    offset: usize,
}

#[derive(Debug, Clone)]
struct PathRef {
    segments: Vec<String>,
    offset: usize,
    inline_mods: Vec<String>,
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn compute_instability(fan_in: usize, fan_out: usize) -> f64 {
    let total = fan_in + fan_out;
    if total == 0 { 0.0 } else { round2(fan_out as f64 / total as f64) }
}

fn is_snake_case_module_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    let Some(&first) = bytes.first() else {
        return false;
    };
    first.is_ascii_lowercase() && bytes[1..].iter().all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

fn tokenize_rust(code: &str) -> Vec<Tok> {
    let bytes = code.as_bytes();
    let len = bytes.len();
    let mut tokens = Vec::new();
    let mut i = 0usize;

    while i < len {
        let b = bytes[i];
        if matches!(b, b' ' | b'\t' | b'\r' | b'\n') {
            i += 1;
            continue;
        }
        if b == b'r' && bytes.get(i + 1) == Some(&b'#') && bytes.get(i + 2).copied().is_some_and(is_ident_start) {
            let start = i;
            i += 2;
            while i < len && is_ident_char(bytes[i]) {
                i += 1;
            }
            tokens.push(Tok {
                kind: TokKind::Ident,
                text: code[start + 2..i].to_owned(),
                offset: start,
            });
            continue;
        }
        if is_ident_start(b) {
            let start = i;
            i += 1;
            while i < len && is_ident_char(bytes[i]) {
                i += 1;
            }
            tokens.push(Tok {
                kind: TokKind::Ident,
                text: code[start..i].to_owned(),
                offset: start,
            });
            continue;
        }
        if b == b':' && bytes.get(i + 1) == Some(&b':') {
            tokens.push(Tok {
                kind: TokKind::Punct,
                text: "::".to_owned(),
                offset: i,
            });
            i += 2;
            continue;
        }
        let ch = code[i..].chars().next().expect("valid UTF-8 at token boundary");
        tokens.push(Tok {
            kind: TokKind::Punct,
            text: ch.to_string(),
            offset: i,
        });
        i += ch.len_utf8();
    }

    tokens
}

fn parse_use_tree(tokens: &[Tok], start_index: usize, prefix: &[String], inline_mods: &[String], start_offset: usize, out: &mut Vec<PathRef>) -> usize {
    let mut i = start_index;
    let mut segments = prefix.to_vec();

    if tokens.get(i).is_some_and(|t| t.text == "::") {
        i += 1;
    }

    while i < tokens.len() {
        let tok = &tokens[i];
        if tok.text == "{" {
            i += 1;
            while i < tokens.len() && tokens[i].text != "}" {
                i = parse_use_tree(tokens, i, &segments, inline_mods, start_offset, out);
                if tokens.get(i).is_some_and(|t| t.text == ",") {
                    i += 1;
                }
            }
            if tokens.get(i).is_some_and(|t| t.text == "}") {
                i += 1;
            }
            return i;
        }

        if tok.text == "*" {
            let mut star_segs = segments;
            star_segs.push("*".to_owned());
            out.push(PathRef {
                segments: star_segs,
                offset: tok.offset,
                inline_mods: inline_mods.to_vec(),
            });
            return i + 1;
        }

        if tok.kind == TokKind::Ident {
            if tok.text != "self" || segments.is_empty() {
                segments.push(tok.text.clone());
            }
            let ref_offset = if segments.len() == 1 { tok.offset } else { start_offset };
            i += 1;
            if tokens.get(i).is_some_and(|t| t.text == "::") {
                i += 1;
                continue;
            }
            if tokens.get(i).is_some_and(|t| t.kind == TokKind::Ident && t.text == "as") {
                i += 2;
            }
            if !segments.is_empty() {
                out.push(PathRef {
                    segments,
                    offset: ref_offset,
                    inline_mods: inline_mods.to_vec(),
                });
            }
            return i;
        }

        break;
    }

    i
}

fn is_use_statement_position(tokens: &[Tok], index: usize) -> bool {
    if index == 0 {
        return true;
    }
    let Some(prev) = tokens.get(index - 1) else {
        return true;
    };
    if matches!(prev.text.as_str(), ";" | "{" | "}" | "]") {
        return true;
    }
    if prev.kind == TokKind::Ident && prev.text == "pub" {
        return true;
    }
    if prev.text == ")" {
        let mut depth = 0usize;
        for k in (0..index).rev() {
            if tokens[k].text == ")" {
                depth += 1;
            } else if tokens[k].text == "(" {
                depth -= 1;
                if depth == 0 {
                    return k > 0 && tokens[k - 1].kind == TokKind::Ident && tokens[k - 1].text == "pub";
                }
            }
        }
    }
    false
}

fn extract_path_refs(tokens: &[Tok]) -> Vec<PathRef> {
    let mut refs = Vec::new();
    let mut brace_stack: Vec<Option<String>> = Vec::new();
    let active_inline_mods = |stack: &[Option<String>]| -> Vec<String> { stack.iter().filter_map(|m| m.clone()).collect() };

    let mut i = 0usize;
    while i < tokens.len() {
        let tok = &tokens[i];

        if tok.kind == TokKind::Ident
            && tok.text == "mod"
            && tokens.get(i + 1).is_some_and(|t| t.kind == TokKind::Ident)
            && tokens.get(i + 2).is_some_and(|t| t.text == "{")
        {
            brace_stack.push(Some(tokens[i + 1].text.clone()));
            i += 3;
            continue;
        }

        if tok.text == "{" {
            brace_stack.push(None);
            i += 1;
            continue;
        }

        if tok.text == "}" {
            brace_stack.pop();
            i += 1;
            continue;
        }

        if tok.kind == TokKind::Ident && tok.text == "use" && tokens.get(i + 1).is_none_or(|t| t.text != "<") && is_use_statement_position(tokens, i) {
            let mods = active_inline_mods(&brace_stack);
            i = parse_use_tree(tokens, i + 1, &[], &mods, tok.offset, &mut refs);
            while i < tokens.len() && tokens[i].text != ";" {
                i += 1;
            }
            if tokens.get(i).is_some_and(|t| t.text == ";") {
                i += 1;
            }
            continue;
        }

        let start_offset = tok.offset;
        let mut cursor = i;
        if tokens.get(cursor).is_some_and(|t| t.text == "::") {
            cursor += 1;
        }
        if let Some(head) = tokens.get(cursor)
            && head.kind == TokKind::Ident
            && matches!(head.text.as_str(), "crate" | "super" | "self")
            && tokens.get(cursor + 1).is_some_and(|t| t.text == "::")
        {
            let mut segments = vec![head.text.clone()];
            cursor += 1;
            while tokens.get(cursor).is_some_and(|t| t.text == "::") && tokens.get(cursor + 1).is_some_and(|t| t.kind == TokKind::Ident) {
                segments.push(tokens[cursor + 1].text.clone());
                cursor += 2;
            }
            refs.push(PathRef {
                segments,
                offset: start_offset,
                inline_mods: active_inline_mods(&brace_stack),
            });
            i = cursor;
            continue;
        }

        i += 1;
    }

    refs
}

fn resolve_crate_relative_segments(path_ref: &PathRef, file_mod_path: &[String]) -> Option<Vec<String>> {
    let segs = &path_ref.segments;
    if segs.first().is_some_and(|s| s == "crate") {
        return Some(segs[1..].to_vec());
    }
    if segs.first().is_some_and(|s| s == "super") {
        let mut base = file_mod_path.to_vec();
        base.extend(path_ref.inline_mods.iter().cloned());
        let mut idx = 0usize;
        while segs.get(idx).is_some_and(|s| s == "super") {
            base.pop()?;
            idx += 1;
        }
        base.extend(segs[idx..].iter().cloned());
        return Some(base);
    }
    None
}

fn crate_src_rel(file_path: &str, src_prefix: &str) -> Option<String> {
    file_path.strip_prefix(src_prefix).map(|s| s.trim_start_matches('/').to_owned())
}

fn top_level_module_of_file(rel: &str) -> Option<String> {
    let stem_rel = rel.strip_suffix(".rs")?;
    if stem_rel == "lib" || stem_rel == "main" {
        return None;
    }
    let first = stem_rel.split('/').next()?;
    (!first.is_empty()).then(|| first.to_owned())
}

fn file_module_path(rel: &str) -> Option<Vec<String>> {
    let stem_rel = rel.strip_suffix(".rs")?;
    if stem_rel == "lib" || stem_rel == "main" {
        return Some(Vec::new());
    }
    let mut parts: Vec<String> = stem_rel.split('/').map(str::to_owned).collect();
    if parts.last().is_some_and(|p| p == "mod") {
        parts.pop();
    }
    Some(parts)
}

/// Runs Tarjan's strongly connected components algorithm on a directed graph,
/// returning all SCCs with size > 1 sorted deterministically.
pub fn tarjan_scc(adj: &BTreeMap<String, BTreeSet<String>>) -> Vec<Vec<String>> {
    struct State<'a> {
        adj: &'a BTreeMap<String, BTreeSet<String>>,
        index: usize,
        indices: BTreeMap<String, usize>,
        lowlink: BTreeMap<String, usize>,
        stack: Vec<String>,
        on_stack: BTreeSet<String>,
        sccs: Vec<Vec<String>>,
    }

    impl State<'_> {
        fn strong_connect(&mut self, v: &str) {
            self.indices.insert(v.to_owned(), self.index);
            self.lowlink.insert(v.to_owned(), self.index);
            self.index += 1;
            self.stack.push(v.to_owned());
            self.on_stack.insert(v.to_owned());

            if let Some(neighbors) = self.adj.get(v) {
                for w in neighbors {
                    if !self.indices.contains_key(w.as_str()) {
                        self.strong_connect(w);
                        let low_w = self.lowlink[w.as_str()];
                        let low_v = self.lowlink[v];
                        if low_w < low_v {
                            self.lowlink.insert(v.to_owned(), low_w);
                        }
                    } else if self.on_stack.contains(w.as_str()) {
                        let idx_w = self.indices[w.as_str()];
                        let low_v = self.lowlink[v];
                        if idx_w < low_v {
                            self.lowlink.insert(v.to_owned(), idx_w);
                        }
                    }
                }
            }

            if self.lowlink[v] == self.indices[v] {
                let mut component = Vec::new();
                while let Some(w) = self.stack.pop() {
                    self.on_stack.remove(&w);
                    let is_root = w == v;
                    component.push(w);
                    if is_root {
                        break;
                    }
                }
                if component.len() > 1 {
                    component.sort();
                    self.sccs.push(component);
                }
            }
        }
    }

    let mut state = State {
        adj,
        index: 0,
        indices: BTreeMap::new(),
        lowlink: BTreeMap::new(),
        stack: Vec::new(),
        on_stack: BTreeSet::new(),
        sccs: Vec::new(),
    };

    for node in adj.keys() {
        if !state.indices.contains_key(node.as_str()) {
            state.strong_connect(node);
        }
    }

    state.sccs.sort();
    state.sccs
}

fn canonicalize_cycle(cycle: &[String]) -> Vec<String> {
    let Some((min_idx, _)) = cycle.iter().enumerate().min_by(|(_, a), (_, b)| a.cmp(b)) else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(cycle.len());
    out.extend_from_slice(&cycle[min_idx..]);
    out.extend_from_slice(&cycle[..min_idx]);
    out
}

fn extract_cycles_from_scc(
    scc: &[String],
    adj: &BTreeMap<String, BTreeSet<String>>,
    edge_sites: &BTreeMap<(String, String), Vec<EdgeSite>>,
) -> Vec<CycleReport> {
    let in_scc: BTreeSet<&str> = scc.iter().map(String::as_str).collect();
    let mut seen_paths: BTreeSet<Vec<String>> = BTreeSet::new();
    let mut reports = Vec::new();

    for start in scc {
        // BFS for shortest cycle starting and ending at `start` within this SCC.
        let mut queue: std::collections::VecDeque<Vec<String>> = std::collections::VecDeque::new();
        let mut visited: BTreeSet<String> = BTreeSet::new();
        if let Some(neighbors) = adj.get(start.as_str()) {
            for next in neighbors {
                if !in_scc.contains(next.as_str()) {
                    continue;
                }
                if next == start {
                    continue;
                }
                visited.insert(next.clone());
                queue.push_back(vec![start.clone(), next.clone()]);
            }
        }

        while let Some(path) = queue.pop_front() {
            let tail = path.last().expect("non-empty path");
            if let Some(neighbors) = adj.get(tail.as_str()) {
                for next in neighbors {
                    if !in_scc.contains(next.as_str()) {
                        continue;
                    }
                    if next == start {
                        let canonical = canonicalize_cycle(&path);
                        if seen_paths.insert(canonical.clone()) {
                            let mut edges = Vec::with_capacity(canonical.len());
                            for idx in 0..canonical.len() {
                                let from = &canonical[idx];
                                let to = &canonical[(idx + 1) % canonical.len()];
                                if let Some(sites) = edge_sites.get(&(from.clone(), to.clone()))
                                    && let Some(first) = sites.first()
                                {
                                    edges.push(first.clone());
                                }
                            }
                            let label = format!("{} -> {}", canonical.join(" -> "), canonical[0]);
                            reports.push(CycleReport {
                                nodes: canonical,
                                path: label,
                                edges,
                            });
                        }
                        break;
                    } else if visited.insert(next.clone()) {
                        let mut next_path = path.clone();
                        next_path.push(next.clone());
                        queue.push_back(next_path);
                    }
                }
            }
        }
    }

    reports.sort_by(|a, b| a.path.cmp(&b.path));
    reports
}

fn check_server_reverse_layer_edge(
    rel: &str,
    from_module: &str,
    to_module: &str,
    file_path: &str,
    line: usize,
    snippet: &str,
    out: &mut Vec<ReverseLayerViolation>,
) {
    if to_module == "gateway" && rel != "gateway.rs" && !rel.starts_with("gateway/") && !GATEWAY_ALLOWED_ROOT_FILES.contains(&rel) {
        out.push(ReverseLayerViolation {
            rule: "no-gateway-reverse-import".to_owned(),
            from_module: from_module.to_owned(),
            to_module: to_module.to_owned(),
            file: file_path.to_owned(),
            line,
            snippet: snippet.to_owned(),
            why: format!("non-gateway module `{from_module}` imports `crate::gateway`"),
            fix_hint: "Move shared ports/types into `context/` or pass dependencies downward from `app.rs`/`gateway/`.".to_owned(),
        });
        return;
    }

    if (to_module == "app" || to_module == "router") && !ENTRY_ALLOWED_ROOT_FILES.contains(&rel) {
        out.push(ReverseLayerViolation {
            rule: "no-entry-reverse-import".to_owned(),
            from_module: from_module.to_owned(),
            to_module: to_module.to_owned(),
            file: file_path.to_owned(),
            line,
            snippet: snippet.to_owned(),
            why: format!("module `{from_module}` imports entry-layer `crate::{to_module}`"),
            fix_hint: "Keep `app.rs` and `router.rs` as top-level composition roots; do not import them from domain modules.".to_owned(),
        });
        return;
    }

    if FOUNDATION_MODULES.contains(&from_module) && SERVER_HIGHER_MODULES.contains(&to_module) {
        out.push(ReverseLayerViolation {
            rule: "no-foundation-reverse-import".to_owned(),
            from_module: from_module.to_owned(),
            to_module: to_module.to_owned(),
            file: file_path.to_owned(),
            line,
            snippet: snippet.to_owned(),
            why: format!("foundation module `{from_module}` imports higher-layer `crate::{to_module}`"),
            fix_hint: "Keep foundation modules (`context`, `log`, `db`, `config`) leaf-only; invert dependencies via traits or `OutboxEvent`.".to_owned(),
        });
        return;
    }

    if from_module == "runtime" && RUNTIME_FORBIDDEN_TARGETS.contains(&to_module) {
        out.push(ReverseLayerViolation {
            rule: "no-runtime-domain-import".to_owned(),
            from_module: from_module.to_owned(),
            to_module: to_module.to_owned(),
            file: file_path.to_owned(),
            line,
            snippet: snippet.to_owned(),
            why: format!("`runtime` imports higher orchestration/domain module `crate::{to_module}`"),
            fix_hint: "Keep `runtime` decoupled from `agent`/`issue`/`cron`/`gateway`; communicate upward via events or ports.".to_owned(),
        });
    }
}

pub fn analyze_rust_crate_deps(
    files: &[SourceFile],
    src_prefix: &str,
    check_server_layers: bool,
) -> (Vec<ModuleNodeMetrics>, Vec<CycleReport>, Vec<ReverseLayerViolation>, usize) {
    let mut sorted: Vec<SourceFile> = files
        .iter()
        .map(|f| SourceFile {
            path: normalize_posix_path(&f.path),
            text: f.text.clone(),
        })
        .collect();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));

    let mut excluded_targets = BTreeSet::new();
    let mut non_test_codes: BTreeMap<String, String> = BTreeMap::new();
    let mut known_modules = BTreeSet::new();
    let mut file_counts: BTreeMap<String, usize> = BTreeMap::new();

    for file in &sorted {
        if let Some(rel) = crate_src_rel(&file.path, src_prefix)
            && let Some(top) = top_level_module_of_file(&rel)
        {
            known_modules.insert(top);
        }
        let no_comments = strip_rust_comments_and_literals(&file.text);
        let stripped = strip_cfg_test_and_collect_excluded(&file.text, &no_comments, &file.path);
        for target in stripped.excluded_submodules {
            excluded_targets.insert(target);
        }
        non_test_codes.insert(file.path.clone(), stripped.code);
    }

    let mut outgoing: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut incoming: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for m in &known_modules {
        outgoing.insert(m.clone(), BTreeSet::new());
        incoming.insert(m.clone(), BTreeSet::new());
    }

    let mut edge_sites: BTreeMap<(String, String), Vec<EdgeSite>> = BTreeMap::new();
    let mut reverse_violations = Vec::new();
    let mut seen_reverse_sites: BTreeSet<(String, usize, String)> = BTreeSet::new();

    for file in &sorted {
        if is_excluded_by_cfg_test(&file.path, &excluded_targets) {
            continue;
        }
        let Some(rel) = crate_src_rel(&file.path, src_prefix) else {
            continue;
        };
        let Some(source_mod) = top_level_module_of_file(&rel) else {
            continue;
        };
        *file_counts.entry(source_mod.clone()).or_default() += 1;

        let Some(mod_path) = file_module_path(&rel) else {
            continue;
        };
        let non_test_code = non_test_codes.get(&file.path).map_or("", String::as_str);
        let tokens = tokenize_rust(non_test_code);
        let index = LineIndex::new(&file.text);

        for path_ref in extract_path_refs(&tokens) {
            let Some(resolved) = resolve_crate_relative_segments(&path_ref, &mod_path) else {
                continue;
            };
            let Some(target_mod) = resolved.first() else {
                continue;
            };
            if !is_snake_case_module_name(target_mod) || target_mod == &source_mod {
                continue;
            }
            if !known_modules.contains(target_mod.as_str()) {
                continue;
            }

            let line = index.line_at(path_ref.offset);
            let snippet = index.snippet_at(line).to_owned();

            outgoing.entry(source_mod.clone()).or_default().insert(target_mod.clone());
            incoming.entry(target_mod.clone()).or_default().insert(source_mod.clone());
            edge_sites.entry((source_mod.clone(), target_mod.clone())).or_default().push(EdgeSite {
                from_module: source_mod.clone(),
                to_module: target_mod.clone(),
                file: file.path.clone(),
                line,
                snippet: snippet.clone(),
            });

            if check_server_layers && seen_reverse_sites.insert((file.path.clone(), line, target_mod.clone())) {
                check_server_reverse_layer_edge(&rel, &source_mod, target_mod, &file.path, line, &snippet, &mut reverse_violations);
            }
        }
    }

    let sccs = tarjan_scc(&outgoing);
    let mut cycles = Vec::new();
    for scc in &sccs {
        cycles.extend(extract_cycles_from_scc(scc, &outgoing, &edge_sites));
    }

    let mut modules = Vec::with_capacity(known_modules.len());
    for module in known_modules {
        let depends_on: Vec<String> = outgoing.remove(&module).unwrap_or_default().into_iter().collect();
        let depended_by: Vec<String> = incoming.remove(&module).unwrap_or_default().into_iter().collect();
        let fan_out = depends_on.len();
        let fan_in = depended_by.len();
        modules.push(ModuleNodeMetrics {
            files: file_counts.get(&module).copied().unwrap_or(0),
            module,
            fan_in,
            fan_out,
            instability: compute_instability(fan_in, fan_out),
            depends_on,
            depended_by,
        });
    }

    (modules, cycles, reverse_violations, sccs.len())
}

fn strip_ts_comments(source: &str) -> String {
    let bytes = source.as_bytes();
    let len = bytes.len();
    let mut out = Vec::with_capacity(len);
    let mut i = 0usize;

    while i < len {
        let ch = bytes[i];
        let next = bytes.get(i + 1).copied();

        if ch == b'/' && next == Some(b'/') {
            out.push(b' ');
            out.push(b' ');
            i += 2;
            while i < len && bytes[i] != b'\n' {
                out.push(b' ');
                i += 1;
            }
            continue;
        }
        if ch == b'/' && next == Some(b'*') {
            out.push(b' ');
            out.push(b' ');
            i += 2;
            while i < len {
                if bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/') {
                    out.push(b' ');
                    out.push(b' ');
                    i += 2;
                    break;
                }
                out.push(if bytes[i] == b'\n' { b'\n' } else { b' ' });
                i += 1;
            }
            continue;
        }
        if ch == b'"' || ch == b'\'' || ch == b'`' {
            let quote = ch;
            out.push(quote);
            i += 1;
            while i < len {
                let b = bytes[i];
                out.push(b);
                i += 1;
                if b == b'\\' && i < len {
                    out.push(bytes[i]);
                    i += 1;
                    continue;
                }
                if b == quote {
                    break;
                }
            }
            continue;
        }
        out.push(ch);
        i += 1;
    }

    String::from_utf8(out).expect("TS comment stripper preserves valid UTF-8")
}

fn extract_ts_import_specifiers(source: &str) -> Vec<(usize, String)> {
    let stripped = strip_ts_comments(source);
    let index = LineIndex::new(&stripped);
    let bytes = stripped.as_bytes();
    let len = bytes.len();
    let mut imports = Vec::new();
    let mut i = 0usize;

    while i < len {
        if !bytes[i].is_ascii() {
            i += 1;
            continue;
        }
        // Match `import` or `export` keyword at word boundary.
        let is_import = bytes[i..].starts_with(b"import") && (i == 0 || !is_ident_char(bytes[i - 1])) && bytes.get(i + 6).is_none_or(|&b| !is_ident_char(b));
        let is_export = bytes[i..].starts_with(b"export") && (i == 0 || !is_ident_char(bytes[i - 1])) && bytes.get(i + 6).is_none_or(|&b| !is_ident_char(b));

        if !is_import && !is_export {
            i += 1;
            continue;
        }

        let stmt_start = i;
        let mut cursor = i + 6;
        // Skip whitespace
        while cursor < len && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }

        // Side-effect import: `import "..."`
        if is_import && cursor < len && (bytes[cursor] == b'"' || bytes[cursor] == b'\'') {
            let quote = bytes[cursor];
            let spec_start = cursor + 1;
            cursor += 1;
            while cursor < len && bytes[cursor] != quote && bytes[cursor] != b'\n' {
                cursor += 1;
            }
            if cursor < len && bytes[cursor] == quote {
                imports.push((index.line_at(stmt_start), stripped[spec_start..cursor].to_owned()));
                i = cursor + 1;
                continue;
            }
        }

        // Look ahead within the statement (until `;` or unbraced newline or `{}` balanced `from "..."`)
        let mut brace_depth = 0usize;
        let mut found_from: Option<(usize, String)> = None;
        while cursor < len {
            let b = bytes[cursor];
            if b == b'{' {
                brace_depth += 1;
            } else if b == b'}' {
                brace_depth = brace_depth.saturating_sub(1);
            } else if b == b';' && brace_depth == 0 {
                cursor += 1;
                break;
            } else if b == b'"' || b == b'\'' || b == b'`' {
                let quote = b;
                cursor += 1;
                while cursor < len {
                    if bytes[cursor] == b'\\' && cursor + 1 < len {
                        cursor += 2;
                        continue;
                    }
                    if bytes[cursor] == quote {
                        break;
                    }
                    cursor += 1;
                }
            } else if brace_depth == 0
                && bytes[cursor..].starts_with(b"from")
                && (cursor == 0 || !is_ident_char(bytes[cursor - 1]))
                && bytes.get(cursor + 4).is_none_or(|&n| !is_ident_char(n))
            {
                let mut q = cursor + 4;
                while q < len && bytes[q].is_ascii_whitespace() {
                    q += 1;
                }
                if q < len && (bytes[q] == b'"' || bytes[q] == b'\'') {
                    let quote = bytes[q];
                    let spec_start = q + 1;
                    q += 1;
                    while q < len && bytes[q] != quote && bytes[q] != b'\n' {
                        q += 1;
                    }
                    if q < len && bytes[q] == quote {
                        found_from = Some((index.line_at(cursor), stripped[spec_start..q].to_owned()));
                        cursor = q + 1;
                        break;
                    }
                }
            } else if b == b'\n' && brace_depth == 0 && bytes[stmt_start..cursor].contains(&b'=') {
                // e.g. `export const x = ...` without `from`
                break;
            }
            cursor += 1;
        }

        if let Some(hit) = found_from {
            imports.push(hit);
        }
        i = cursor;
    }

    imports
}

fn strip_ts_ext(path: &str) -> &str {
    path.strip_suffix(".tsx")
        .or_else(|| path.strip_suffix(".ts"))
        .or_else(|| path.strip_suffix(".mts"))
        .or_else(|| path.strip_suffix(".cts"))
        .unwrap_or(path)
}

fn resolve_ui_import(importing_file: &str, specifier: &str) -> Option<String> {
    if specifier.starts_with("./") || specifier.starts_with("../") {
        let dir = importing_file.rsplit_once('/').map_or("", |(d, _)| d);
        let joined = if dir.is_empty() { specifier.to_owned() } else { format!("{dir}/{specifier}") };
        return Some(normalize_posix_path(&joined));
    }
    None
}

pub fn check_ui_layering(files: &[SourceFile]) -> (usize, Vec<UiLayerViolation>) {
    let mut violations = Vec::new();
    let mut scanned = 0usize;

    let mut sorted: Vec<&SourceFile> = files.iter().collect();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));

    for file in sorted {
        let norm = normalize_posix_path(&file.path);
        let Some(ui_rel) = norm.strip_prefix("apps/mac/ui/") else {
            continue;
        };
        if !(ui_rel.ends_with(".ts") || ui_rel.ends_with(".tsx")) {
            continue;
        }
        if ui_rel.ends_with(".test.ts")
            || ui_rel.ends_with(".test.tsx")
            || ui_rel.ends_with(".story.ts")
            || ui_rel.ends_with(".story.tsx")
            || ui_rel.starts_with("fixtures/")
        {
            continue;
        }
        scanned += 1;

        for (line, specifier) in extract_ts_import_specifiers(&file.text) {
            let Some(resolved) = resolve_ui_import(&norm, &specifier) else {
                continue;
            };
            let Some(target_rel) = resolved.strip_prefix("apps/mac/ui/") else {
                continue;
            };

            if ui_rel.starts_with("infra/") {
                if !target_rel.starts_with("infra/") && target_rel != "infra" {
                    let to_layer = target_rel.split('/').next().unwrap_or(target_rel);
                    violations.push(UiLayerViolation {
                        rule: "ui-infra-layer".to_owned(),
                        file: norm.clone(),
                        line,
                        from_layer: "infra/".to_owned(),
                        to_target: format!("apps/mac/ui/{target_rel}"),
                        specifier: specifier.clone(),
                        why: format!("infra module `{ui_rel}` imports upper-layer `{to_layer}/` ({specifier})"),
                        fix_hint: "Keep `apps/mac/ui/infra/` as a leaf foundation layer with zero imports from `design/`, `features/`, `workspace/`, `farm/`, or `app/`."
                            .to_owned(),
                    });
                }
                continue;
            }

            if ui_rel.starts_with("design/") {
                if !target_rel.starts_with("design/") && target_rel != "design" {
                    let to_layer = target_rel.split('/').next().unwrap_or(target_rel);
                    violations.push(UiLayerViolation {
                        rule: "ui-design-layer".to_owned(),
                        file: norm.clone(),
                        line,
                        from_layer: "design/".to_owned(),
                        to_target: format!("apps/mac/ui/{target_rel}"),
                        specifier: specifier.clone(),
                        why: format!("design primitive `{ui_rel}` imports outside `design/` from `{to_layer}/` ({specifier})"),
                        fix_hint: "Keep `apps/mac/ui/design/` self-contained with zero imports from `infra/`, `features/`, `workspace/`, `farm/`, or `app/`; inject host capabilities via `design/host.tsx` or props."
                            .to_owned(),
                    });
                }
                continue;
            }

            if ui_rel.starts_with("farm/") {
                if target_rel.starts_with("features/") || target_rel == "features" {
                    violations.push(UiLayerViolation {
                        rule: "ui-farm-layer".to_owned(),
                        file: norm.clone(),
                        line,
                        from_layer: "farm/".to_owned(),
                        to_target: format!("apps/mac/ui/{target_rel}"),
                        specifier: specifier.clone(),
                        why: format!("farm skin `{ui_rel}` imports from `features/` ({specifier})"),
                        fix_hint: "Keep `apps/mac/ui/farm/` decoupled from `features/`; sink shared reads/actions into `apps/mac/ui/infra/` or `@vibevalley/protocol/rules`."
                            .to_owned(),
                    });
                }
                continue;
            }

            if ui_rel.starts_with("workspace/") {
                if target_rel.starts_with("features/") || target_rel == "features" {
                    violations.push(UiLayerViolation {
                        rule: "ui-workspace-layer".to_owned(),
                        file: norm.clone(),
                        line,
                        from_layer: "workspace/".to_owned(),
                        to_target: format!("apps/mac/ui/{target_rel}"),
                        specifier: specifier.clone(),
                        why: format!("workspace shell `{ui_rel}` imports from `features/` ({specifier})"),
                        fix_hint: "Keep `apps/mac/ui/workspace/` decoupled from `features/`; sink shared helpers into `apps/mac/ui/infra/` or inject slots from `app/`."
                            .to_owned(),
                    });
                }
                continue;
            }

            if ui_rel.starts_with("app/") {
                if let Some(target_after_feat) = target_rel.strip_prefix("features/")
                    && let Some((dst_feature, dst_rest)) = target_after_feat.split_once('/')
                {
                    let dst_rest_clean = strip_ts_ext(dst_rest);
                    if !dst_rest_clean.is_empty() && dst_rest_clean != "index" {
                        violations.push(UiLayerViolation {
                            rule: "ui-app-feature-deep-import".to_owned(),
                            file: norm.clone(),
                            line,
                            from_layer: "app/".to_owned(),
                            to_target: format!("apps/mac/ui/{target_rel}"),
                            specifier: specifier.clone(),
                            why: format!("app composition file `{ui_rel}` deep-imports internal file `{dst_rest}` from feature `{dst_feature}`"),
                            fix_hint: format!(
                                "Import from `features/{dst_feature}` public barrel (`../features/{dst_feature}`) or move shared helpers to `infra/`."
                            ),
                        });
                    }
                }
                continue;
            }

            if let Some(after_feat) = ui_rel.strip_prefix("features/")
                && let Some((src_feature, _)) = after_feat.split_once('/')
                && let Some(target_after_feat) = target_rel.strip_prefix("features/")
                && let Some((dst_feature, dst_rest)) = target_after_feat.split_once('/')
            {
                let dst_rest_clean = strip_ts_ext(dst_rest);
                if src_feature != dst_feature && !dst_rest_clean.is_empty() && dst_rest_clean != "index" {
                    violations.push(UiLayerViolation {
                        rule: "ui-cross-feature-deep-import".to_owned(),
                        file: norm.clone(),
                        line,
                        from_layer: format!("features/{src_feature}/"),
                        to_target: format!("apps/mac/ui/{target_rel}"),
                        specifier: specifier.clone(),
                        why: format!("feature `{src_feature}` deep-imports internal file `{dst_rest}` from feature `{dst_feature}`"),
                        fix_hint: format!("Import from `features/{dst_feature}` barrel (`../{dst_feature}` or `../../{dst_feature}`) or extract shared code to `design/`/`infra/`."),
                    });
                }
            }
        }
    }

    (scanned, violations)
}

fn resolve_crate_target(root: &Path, target: &str) -> Result<Option<(String, String)>, String> {
    let trimmed = target.trim_end_matches('/');
    if trimmed == "ui" || trimmed == "apps/mac/ui" {
        return Ok(None);
    }

    let candidates = [
        (trimmed.to_owned(), format!("{trimmed}/src")),
        (trimmed.to_owned(), trimmed.to_owned()),
        (format!("crates/{trimmed}"), format!("crates/{trimmed}/src")),
        (format!("apps/{trimmed}"), format!("apps/{trimmed}/src")),
    ];

    for (label, src_rel) in candidates {
        let dir = root.join(&src_rel);
        if dir.is_dir() && dir.join("lib.rs").exists() || dir.join("main.rs").exists() {
            return Ok(Some((label, normalize_posix_path(&src_rel))));
        }
    }

    // Fallback: if trimmed itself is a directory containing `.rs` files (useful in tests or custom dirs)
    let direct = root.join(trimmed);
    if direct.is_dir() {
        return Ok(Some((trimmed.to_owned(), normalize_posix_path(trimmed))));
    }

    Err(format!(
        "xtask deps: unknown target `{target}` (expected crate name like `server`, path like `crates/server`, or `ui`)"
    ))
}

pub fn inspect_deps(root: &Path, target: Option<&str>, include_ui: bool) -> Result<DepsReport, String> {
    let resolved_rust = match target {
        Some(t) => resolve_crate_target(root, t)?,
        None => resolve_crate_target(root, "server")?,
    };
    let inspect_ui = include_ui || resolved_rust.is_none();

    let (target_label, modules, cycles, reverse_layer_violations, scc_count) = if let Some((label, src_rel)) = resolved_rust {
        let files = walk_matching_files(root, &[&src_rel], |rel| rel.ends_with(".rs"))?;
        let is_server = src_rel == "crates/server/src" || src_rel.ends_with("/crates/server/src");
        let (modules, cycles, reverse_violations, sccs) = analyze_rust_crate_deps(&files, &src_rel, is_server);
        (Some(label), modules, cycles, reverse_violations, sccs)
    } else {
        (Some("apps/mac/ui".to_owned()), Vec::new(), Vec::new(), Vec::new(), 0)
    };

    let (ui_files_scanned, ui_violations) = if inspect_ui {
        let ui_files = walk_matching_files(root, &["apps/mac/ui"], |rel| {
            (rel.ends_with(".ts") || rel.ends_with(".tsx")) && !rel.contains("/.nsh/") && !rel.contains("/dist/")
        })?;
        check_ui_layering(&ui_files)
    } else {
        (0, Vec::new())
    };

    let edges: usize = modules.iter().map(|m| m.fan_out).sum();
    let summary = DepsSummary {
        target: target_label,
        modules: modules.len(),
        edges,
        scc_count,
        cycle_count: cycles.len(),
        reverse_layer_count: reverse_layer_violations.len(),
        ui_files_scanned,
        ui_violation_count: ui_violations.len(),
    };

    Ok(DepsReport {
        summary,
        modules,
        cycles,
        reverse_layer_violations,
        ui_violations,
    })
}

pub fn format_dot(report: &DepsReport) -> String {
    let mut out = Vec::new();
    let label = report.summary.target.as_deref().unwrap_or("deps");
    out.push(format!("digraph \"{label}\" {{"));
    out.push("  rankdir=LR;".to_owned());
    for m in &report.modules {
        out.push(format!("  \"{}\";", m.module));
        for dep in &m.depends_on {
            out.push(format!("  \"{}\" -> \"{}\";", m.module, dep));
        }
    }
    out.push("}".to_owned());
    out.join("\n")
}

pub fn format_deps_report(report: &DepsReport, cycles_only: bool) -> String {
    let mut out = Vec::new();
    let s = &report.summary;
    out.push(format!(
        "deps ({}): {} modules, {} edges, {} SCCs ({} cycles), {} reverse-layer edges, {} UI files ({} UI violations)",
        s.target.as_deref().unwrap_or("ui"),
        s.modules,
        s.edges,
        s.scc_count,
        s.cycle_count,
        s.reverse_layer_count,
        s.ui_files_scanned,
        s.ui_violation_count,
    ));

    if !cycles_only && !report.modules.is_empty() {
        out.push(String::new());
        out.push("Module Fan-In / Fan-Out:".to_owned());
        out.push(format!(
            "  {:<18} {:>5} {:>6} {:>7} {:>8}  {}",
            "MODULE", "FILES", "FAN_IN", "FAN_OUT", "INSTAB", "DEPENDS_ON"
        ));
        for m in &report.modules {
            let deps = if m.depends_on.is_empty() { "-".to_owned() } else { m.depends_on.join(", ") };
            out.push(format!(
                "  {:<18} {:>5} {:>6} {:>7} {:>8.2}  {}",
                m.module, m.files, m.fan_in, m.fan_out, m.instability, deps
            ));
        }
    }

    out.push(String::new());
    out.push(format!("Strongly Connected Cycles ({}):", report.cycles.len()));
    if report.cycles.is_empty() {
        out.push("  (0 cycles — strict DAG)".to_owned());
    } else {
        for c in &report.cycles {
            out.push(format!("  CYCLE: {}", c.path));
            for e in &c.edges {
                out.push(format!("    {} -> {} at {}:{} ({})", e.from_module, e.to_module, e.file, e.line, e.snippet));
            }
        }
    }

    if !report.reverse_layer_violations.is_empty() || !report.modules.is_empty() {
        out.push(String::new());
        out.push(format!("Reverse-Layer Edges ({}):", report.reverse_layer_violations.len()));
        if report.reverse_layer_violations.is_empty() {
            out.push("  (0 reverse-layer violations)".to_owned());
        } else {
            for v in &report.reverse_layer_violations {
                out.push(format!("  [{}] {}:{}: {}", v.rule, v.file, v.line, v.why));
                out.push(format!("    Fix: {}", v.fix_hint));
            }
        }
    }

    if report.summary.ui_files_scanned > 0 || !report.ui_violations.is_empty() {
        out.push(String::new());
        out.push(format!(
            "UI TS Import Layering ({} files scanned, {} violations):",
            report.summary.ui_files_scanned,
            report.ui_violations.len()
        ));
        if report.ui_violations.is_empty() {
            out.push("  (0 UI layering violations)".to_owned());
        } else {
            for v in &report.ui_violations {
                out.push(format!("  [{}] {}:{}: {}", v.rule, v.file, v.line, v.why));
                out.push(format!("    Fix: {}", v.fix_hint));
            }
        }
    }

    out.join("\n")
}

fn write_stdout_line(text: &str) -> Result<(), String> {
    let mut stdout = io::stdout().lock();
    match writeln!(stdout, "{text}") {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::BrokenPipe => Ok(()),
        Err(err) => Err(format!("failed to write deps output: {err}")),
    }
}

pub fn run(root: &Path, args: &[String]) -> Result<i32, String> {
    let mut cycles_only = false;
    let mut dot_output = false;
    let mut include_ui = false;
    let mut json_output = false;
    let mut strict = false;
    let mut target: Option<String> = None;

    for arg in args {
        match arg.as_str() {
            "--help" | "-h" => {
                write_stdout_line(USAGE)?;
                return Ok(0);
            }
            "--cycles" => cycles_only = true,
            "--dot" => dot_output = true,
            "--ui" => include_ui = true,
            "--json" => json_output = true,
            "--strict" => strict = true,
            other if other.starts_with('-') => {
                eprintln!("xtask deps: unknown option `{other}`\n\n{USAGE}");
                return Ok(2);
            }
            other => {
                if target.is_some() {
                    eprintln!("xtask deps: unexpected extra positional argument `{other}`\n\n{USAGE}");
                    return Ok(2);
                }
                target = Some(other.to_owned());
            }
        }
    }

    let report = inspect_deps(root, target.as_deref(), include_ui)?;
    if json_output {
        let serialized = serde_json::to_string_pretty(&report).map_err(|err| format!("failed to serialize deps report: {err}"))?;
        write_stdout_line(&serialized)?;
    } else if dot_output {
        write_stdout_line(&format_dot(&report))?;
    } else {
        write_stdout_line(&format_deps_report(&report, cycles_only))?;
    }
    if strict && (report.summary.reverse_layer_count > 0 || report.summary.ui_violation_count > 0) {
        return Ok(1);
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(prefix: &str) -> Self {
            let n = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("{prefix}-{}-{n}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn write(&self, rel: &str, content: &str) {
            let full = self.0.join(rel);
            if let Some(parent) = full.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(full, content).unwrap();
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn sf(path: &str, text: &str) -> SourceFile {
        SourceFile {
            path: path.to_owned(),
            text: text.to_owned(),
        }
    }

    #[test]
    fn help_returns_zero_and_unknown_flag_returns_two() {
        assert_eq!(run(Path::new("."), &["--help".to_owned()]), Ok(0));
        assert_eq!(run(Path::new("."), &["-h".to_owned()]), Ok(0));
        assert_eq!(run(Path::new("."), &["--unknown".to_owned()]), Ok(2));
    }

    #[test]
    fn detects_synthetic_cycle_and_computes_fan_in_fan_out() {
        let files = vec![
            sf("crates/server/src/context/mod.rs", "pub struct Ctx;\n"),
            sf(
                "crates/server/src/issue/mod.rs",
                "use crate::context::Ctx;\nuse crate::cron::Tick;\npub struct Issue;\n",
            ),
            sf("crates/server/src/cron/mod.rs", "use crate::agent::Agent;\npub struct Tick;\n"),
            sf("crates/server/src/agent/mod.rs", "use crate::issue::Issue;\npub struct Agent;\n"),
            sf(
                "crates/server/src/agent/tests.rs",
                "// #[cfg(test)] sibling not referenced here, inline test below\n",
            ),
            sf(
                "crates/server/src/gateway/http.rs",
                "use crate::issue::Issue;\n#[cfg(test)]\nmod tests {\n    use crate::context::Ctx;\n}\n",
            ),
        ];

        let (modules, cycles, reverse, scc_count) = analyze_rust_crate_deps(&files, "crates/server/src", true);
        assert_eq!(reverse.len(), 0);
        assert_eq!(scc_count, 1);
        assert_eq!(cycles.len(), 1);
        assert_eq!(cycles[0].nodes, vec!["agent", "issue", "cron"]);
        assert_eq!(cycles[0].path, "agent -> issue -> cron -> agent");
        assert_eq!(cycles[0].edges.len(), 3);

        let context = modules.iter().find(|m| m.module == "context").unwrap();
        assert_eq!(context.fan_in, 1);
        assert_eq!(context.fan_out, 0);
        assert_eq!(context.instability, 0.0);

        let gateway = modules.iter().find(|m| m.module == "gateway").unwrap();
        // `#[cfg(test)]` import of `context` must be excluded, leaving only `issue`.
        assert_eq!(gateway.depends_on, vec!["issue"]);
        assert_eq!(gateway.fan_out, 1);
    }

    #[test]
    fn detects_reverse_layer_edges_in_server() {
        let files = vec![
            sf("crates/server/src/gateway/http.rs", "pub fn serve() {}\n"),
            sf("crates/server/src/context/mod.rs", "use crate::issue::Board;\npub struct Ctx(Board);\n"),
            sf("crates/server/src/issue/mod.rs", "use crate::gateway::http::serve;\npub struct Board;\n"),
            sf("crates/server/src/runtime/mod.rs", "use crate::agent::Agent;\npub fn boot() {}\n"),
            sf("crates/server/src/agent/mod.rs", "pub struct Agent;\n"),
            sf("crates/server/src/app.rs", "use crate::gateway::http;\npub fn run() { let _ = http::serve; }\n"),
        ];

        let (_modules, _cycles, reverse, _scc_count) = analyze_rust_crate_deps(&files, "crates/server/src", true);
        let rules: Vec<(&str, &str, &str)> = reverse
            .iter()
            .map(|v| (v.rule.as_str(), v.from_module.as_str(), v.to_module.as_str()))
            .collect();

        assert!(rules.contains(&("no-foundation-reverse-import", "context", "issue")));
        assert!(rules.contains(&("no-gateway-reverse-import", "issue", "gateway")));
        assert!(rules.contains(&("no-runtime-domain-import", "runtime", "agent")));
        // `app.rs` is an allowed composition root for `gateway`.
        assert!(!rules.iter().any(|(_, from, _)| *from == "app"));
    }

    #[test]
    fn checks_ui_ts_import_layering_rules() {
        let files = vec![
            // Violation 1: app/ deep-importing feature internal file
            sf(
                "apps/mac/ui/app/BadRoute.tsx",
                "import { IssuesPage } from \"../features/issue/views/IssuesPage\";\n",
            ),
            // Violation 2: design/ importing features/
            sf("apps/mac/ui/design/BadCard.tsx", "import { IssueBadge } from \"../features/issue\";\n"),
            // Violation 3: design/ importing infra/
            sf("apps/mac/ui/design/BadHook.tsx", "import { api } from \"../infra/api\";\n"),
            // Violation 4: design/ importing workspace/
            sf("apps/mac/ui/design/BadPanel.tsx", "import { Sidebar } from \"../workspace/Sidebar\";\n"),
            // Violation 5: farm/ importing features/
            sf(
                "apps/mac/ui/farm/BadPhone.tsx",
                "import { useFollowed } from \"../features/channel/model/follow\";\n",
            ),
            // Violation 6: cross-feature deep import into internal non-barrel file
            sf("apps/mac/ui/features/content/Sidebar.tsx", "import { listing } from \"../media/listing\";\n"),
            // Violation 7: infra/ importing upper layer
            sf("apps/mac/ui/infra/badStore.ts", "import { Button } from \"../design/Button\";\n"),
            // Violation 8: workspace/ importing features/
            sf("apps/mac/ui/workspace/BadDetail.tsx", "import { sortRepos } from \"../features/repo/repos\";\n"),
            // Allowed: app/ importing feature barrel
            sf("apps/mac/ui/app/GoodRoute.tsx", "import { IssuesPage } from \"../features/issue\";\n"),
            // Allowed: farm/ and workspace/ importing infra/
            sf("apps/mac/ui/farm/GoodPhone.tsx", "import { useFollowed } from \"../infra/channelFollow\";\n"),
            sf("apps/mac/ui/workspace/GoodDetail.tsx", "import { sortRepos } from \"../infra/repos\";\n"),
            // Allowed: cross-feature barrel import
            sf(
                "apps/mac/ui/features/content/GoodSidebar.tsx",
                "import { useArtifacts } from \"../artifact\";\n",
            ),
            // Allowed: cross-feature explicit index barrel import
            sf("apps/mac/ui/features/agent/GoodPage.tsx", "import { runsHref } from \"../session/index\";\n"),
            // Allowed: same-feature internal import
            sf(
                "apps/mac/ui/features/channel/views/Panel.tsx",
                "import { markState } from \"../model/marks\";\n",
            ),
            // Allowed: design importing another design file, non-ASCII string literals, and commented-out import ignored
            sf(
                "apps/mac/ui/design/Button.tsx",
                "import { mix } from \"./tone\";\nconst LABEL = “中文”;\n// import { bad } from \"../features/issue\";\n",
            ),
            // Allowed: test file excluded from layering check
            sf("apps/mac/ui/design/Button.test.tsx", "import { x } from \"../features/issue/internal\";\n"),
        ];

        let (scanned, violations) = check_ui_layering(&files);
        assert_eq!(scanned, 15);
        assert_eq!(violations.len(), 8);

        assert_eq!(violations[0].rule, "ui-app-feature-deep-import");
        assert_eq!(violations[0].file, "apps/mac/ui/app/BadRoute.tsx");

        assert_eq!(violations[1].rule, "ui-design-layer");
        assert_eq!(violations[1].file, "apps/mac/ui/design/BadCard.tsx");
        assert_eq!(violations[1].line, 1);

        assert_eq!(violations[2].rule, "ui-design-layer");
        assert_eq!(violations[2].file, "apps/mac/ui/design/BadHook.tsx");

        assert_eq!(violations[3].rule, "ui-design-layer");
        assert_eq!(violations[3].file, "apps/mac/ui/design/BadPanel.tsx");

        assert_eq!(violations[4].rule, "ui-farm-layer");
        assert_eq!(violations[4].file, "apps/mac/ui/farm/BadPhone.tsx");

        assert_eq!(violations[5].rule, "ui-cross-feature-deep-import");
        assert_eq!(violations[5].file, "apps/mac/ui/features/content/Sidebar.tsx");
        assert_eq!(violations[5].specifier, "../media/listing");

        assert_eq!(violations[6].rule, "ui-infra-layer");
        assert_eq!(violations[6].file, "apps/mac/ui/infra/badStore.ts");

        assert_eq!(violations[7].rule, "ui-workspace-layer");
        assert_eq!(violations[7].file, "apps/mac/ui/workspace/BadDetail.tsx");
    }

    #[test]
    fn dot_and_json_formatting_include_graph_and_cycles() {
        let files = vec![
            sf("crates/server/src/a/mod.rs", "use crate::b::B;\npub struct A;\n"),
            sf("crates/server/src/b/mod.rs", "use crate::a::A;\npub struct B;\n"),
        ];
        let (modules, cycles, reverse_layer_violations, scc_count) = analyze_rust_crate_deps(&files, "crates/server/src", true);
        let report = DepsReport {
            summary: DepsSummary {
                target: Some("crates/server".to_owned()),
                modules: modules.len(),
                edges: 2,
                scc_count,
                cycle_count: cycles.len(),
                reverse_layer_count: reverse_layer_violations.len(),
                ui_files_scanned: 0,
                ui_violation_count: 0,
            },
            modules,
            cycles,
            reverse_layer_violations,
            ui_violations: Vec::new(),
        };

        let dot = format_dot(&report);
        assert!(dot.contains("\"a\" -> \"b\";"));
        assert!(dot.contains("\"b\" -> \"a\";"));

        let text = format_deps_report(&report, true);
        assert!(text.contains("CYCLE: a -> b -> a"));

        let json_str = serde_json::to_string(&report).unwrap();
        let val: serde_json::Value = serde_json::from_str(&json_str).unwrap();
        assert_eq!(val["summary"]["cycle_count"], 1);
    }

    #[test]
    fn strict_mode_exits_nonzero_on_reverse_or_ui_violations() {
        let dir = TempDir::new("vv-deps-strict");
        dir.write("crates/server/src/lib.rs", "pub mod context;\npub mod issue;\n");
        dir.write("crates/server/src/context/mod.rs", "pub struct Ctx;\n");
        dir.write("crates/server/src/issue/mod.rs", "use crate::context::Ctx;\npub struct Board;\n");
        dir.write("apps/mac/ui/features/runtime/index.ts", "export const useSkills = () => [];\n");
        dir.write("apps/mac/ui/features/runtime/SkillsPage.tsx", "export const useSkills = () => [];\n");
        dir.write("apps/mac/ui/features/agent/Good.tsx", "import { useSkills } from \"../runtime\";\n");

        assert_eq!(run(&dir.0, &["ui".to_owned(), "--strict".to_owned()]), Ok(0));
        assert_eq!(run(&dir.0, &["--strict".to_owned()]), Ok(0));

        dir.write("apps/mac/ui/features/agent/Bad.tsx", "import { useSkills } from \"../runtime/SkillsPage\";\n");
        assert_eq!(run(&dir.0, &["ui".to_owned(), "--strict".to_owned()]), Ok(1));
        assert_eq!(run(&dir.0, &["--ui".to_owned(), "--strict".to_owned()]), Ok(1));
        assert_eq!(run(&dir.0, &["ui".to_owned()]), Ok(0));

        dir.write("crates/server/src/context/mod.rs", "use crate::issue::Board;\npub struct Ctx(Board);\n");
        assert_eq!(run(&dir.0, &["--strict".to_owned()]), Ok(1));
        assert_eq!(run(&dir.0, &[]), Ok(0));
    }

    #[test]
    fn workspace_ui_complies_with_barrel_and_layer_rules() {
        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("workspace root");
        let report = inspect_deps(repo_root, Some("ui"), false).expect("inspect apps/mac/ui");
        assert!(report.summary.ui_files_scanned > 0);
        assert_eq!(
            report.summary.ui_violation_count, 0,
            "expected 0 UI layering violations, got: {:?}",
            report.ui_violations
        );
    }
}
