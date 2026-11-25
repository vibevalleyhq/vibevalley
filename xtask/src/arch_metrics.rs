//! Architectural health metrics and unified diagnostic report (`cargo xtask diagnose`)
//! for analyzer-driven LLM refactoring loops.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, Write};
use std::path::Path;

use serde::Serialize;

use crate::arch_audit::{ArchAuditConfig, ArchAuditReport, ArchViolation, audit_server_architecture_report, audit_server_architecture_with_config};
use crate::rust_scan::{
    SourceFile, is_excluded_by_cfg_test, is_ident_char, is_ident_start, strip_cfg_test_and_collect_excluded, strip_rust_comments_and_literals,
    strip_rust_non_code, walk_matching_files,
};

/// Non-test code line threshold above which a file is reported as oversized.
pub const OVERSIZED_FILE_THRESHOLD: usize = 800;

/// Default number of ranked architectural hotspots included in `diagnose` output.
pub const DEFAULT_TOP_HOTSPOTS: usize = 10;

/// Depth ratio (`loc / max(1, pub_symbols)`) below which a non-entry server module
/// with enough exported symbols is flagged as a shallow wrapper hotspot.
pub const SHALLOW_DEPTH_RATIO_THRESHOLD: f64 = 15.0;

/// Minimum exported symbols required before flagging a module as shallow.
pub const SHALLOW_MIN_PUB_SYMBOLS: usize = 5;

/// Minimum non-test lock sites before flagging a module as a lock hotspot.
pub const LOCK_HOTSPOT_MIN_COUNT: usize = 5;

/// Minimum combined coupling degree (`fan_in + fan_out`) before flagging a coupling hotspot.
pub const COUPLING_HOTSPOT_MIN_DEGREE: usize = 6;

const SHALLOW_EXEMPT_MODULES: &[&str] = &["lib", "main", "app", "router", "boot", "projection", "debug_sources"];
const COUPLING_EXEMPT_MODULES: &[&str] = &["lib", "main"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OversizedFile {
    pub file: String,
    pub loc: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModuleMetrics {
    pub module: String,
    pub files: usize,
    pub loc: usize,
    pub pub_symbols: usize,
    pub depth_ratio: f64,
    pub fan_in: usize,
    pub fan_out: usize,
    pub instability: f64,
    pub lock_count: usize,
    pub mutex_count: usize,
    pub rwlock_count: usize,
    pub oversized_files: Vec<OversizedFile>,
    pub depends_on: Vec<String>,
    pub depended_by: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CrateSummary {
    pub crate_root: String,
    pub files: usize,
    pub loc: usize,
    pub pub_symbols: usize,
    pub depth_ratio: f64,
    pub lock_count: usize,
    pub mutex_count: usize,
    pub rwlock_count: usize,
    pub oversized_file_count: usize,
    pub oversized_files: Vec<OversizedFile>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticSeverity {
    Error,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Diagnostic {
    pub rule: String,
    pub severity: DiagnosticSeverity,
    pub file: String,
    pub line: usize,
    pub why: String,
    pub fix: String,
    pub see: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub details: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HotspotKind {
    OversizedFile,
    LockHotspot,
    ShallowModule,
    HighCoupling,
}

impl HotspotKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OversizedFile => "oversized-file",
            Self::LockHotspot => "lock-hotspot",
            Self::ShallowModule => "shallow-module",
            Self::HighCoupling => "high-coupling",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Hotspot {
    pub rank: usize,
    pub score: usize,
    pub kind: HotspotKind,
    pub target: String,
    pub why: String,
    pub fix: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct RatchetStatus {
    pub current: usize,
    pub ceiling: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RatchetSummary {
    pub server_flume: RatchetStatus,
    pub runtime_flume: RatchetStatus,
    pub sync_async_dup: RatchetStatus,
    pub server_sync_fs: RatchetStatus,
    pub server_internal_value: RatchetStatus,
    pub runtime_block_on: RatchetStatus,
    pub runtime_os_thread: RatchetStatus,
    pub mac_block_on: RatchetStatus,
    pub mac_os_thread: RatchetStatus,
    pub app_rs_loc: Option<usize>,
    pub router_rs_loc: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiagnoseSummary {
    pub files_scanned: usize,
    pub server_modules: usize,
    pub total_loc: usize,
    pub total_pub_symbols: usize,
    pub total_locks: usize,
    pub oversized_file_count: usize,
    pub diagnostic_count: usize,
    pub hotspot_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DiagnoseReport {
    pub summary: DiagnoseSummary,
    pub crates: Vec<CrateSummary>,
    pub server_modules: Vec<ModuleMetrics>,
    pub ratchets: RatchetSummary,
    pub hotspots: Vec<Hotspot>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TokenKind {
    Ident,
    Punct,
}

#[derive(Debug, Clone)]
struct Token {
    kind: TokenKind,
    text: String,
}

#[derive(Debug, Clone)]
struct PathRef {
    segments: Vec<String>,
    inline_mods: Vec<String>,
}

#[derive(Default)]
struct ModuleAccum {
    files: usize,
    loc: usize,
    pub_symbols: usize,
    mutex_count: usize,
    rwlock_count: usize,
    oversized_files: Vec<OversizedFile>,
}

#[derive(Default)]
struct CrateAccum {
    files: usize,
    loc: usize,
    pub_symbols: usize,
    mutex_count: usize,
    rwlock_count: usize,
    oversized_files: Vec<OversizedFile>,
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn compute_depth_ratio(loc: usize, pub_symbols: usize) -> f64 {
    round2(loc as f64 / pub_symbols.max(1) as f64)
}

fn compute_instability(fan_in: usize, fan_out: usize) -> f64 {
    let total = fan_in + fan_out;
    if total == 0 { 0.0 } else { round2(fan_out as f64 / total as f64) }
}

fn is_audited_rust_path(path: &str) -> bool {
    path.ends_with(".rs") && (path.starts_with("crates/server/src/") || path.starts_with("crates/runtime/src/") || path.starts_with("apps/mac/src/"))
}

fn crate_root_of(path: &str) -> Option<&'static str> {
    if path.starts_with("crates/server/src/") {
        Some("crates/server/src")
    } else if path.starts_with("crates/runtime/src/") {
        Some("crates/runtime/src")
    } else if path.starts_with("apps/mac/src/") {
        Some("apps/mac/src")
    } else {
        None
    }
}

fn server_rel_path(file_path: &str) -> Option<&str> {
    file_path.strip_prefix("crates/server/src/")
}

fn top_level_module_of_server_file(file_path: &str) -> Option<String> {
    let rel = server_rel_path(file_path)?.strip_suffix(".rs")?;
    let first = rel.split('/').next()?;
    (!first.is_empty()).then(|| first.to_owned())
}

fn server_file_module_path(file_path: &str) -> Option<Vec<String>> {
    let rel = server_rel_path(file_path)?.strip_suffix(".rs")?;
    if rel == "lib" || rel == "main" {
        return Some(Vec::new());
    }
    let mut parts: Vec<String> = rel.split('/').map(str::to_owned).collect();
    if parts.last().is_some_and(|p| p == "mod") {
        parts.pop();
    }
    Some(parts)
}

fn is_snake_case_module_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    let Some(&first) = bytes.first() else {
        return false;
    };
    first.is_ascii_lowercase() && bytes[1..].iter().all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

fn count_non_test_code_lines(non_test_code: &str) -> usize {
    non_test_code.split('\n').filter(|line| !line.trim().is_empty()).count()
}

fn tokenize_rust(code: &str) -> Vec<Token> {
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
            tokens.push(Token {
                kind: TokenKind::Ident,
                text: code[start + 2..i].to_owned(),
            });
            continue;
        }
        if is_ident_start(b) {
            let start = i;
            i += 1;
            while i < len && is_ident_char(bytes[i]) {
                i += 1;
            }
            tokens.push(Token {
                kind: TokenKind::Ident,
                text: code[start..i].to_owned(),
            });
            continue;
        }
        if b == b':' && bytes.get(i + 1) == Some(&b':') {
            tokens.push(Token {
                kind: TokenKind::Punct,
                text: "::".to_owned(),
            });
            i += 2;
            continue;
        }
        let ch = code[i..].chars().next().expect("valid UTF-8 at token boundary");
        tokens.push(Token {
            kind: TokenKind::Punct,
            text: ch.to_string(),
        });
        i += ch.len_utf8();
    }

    tokens
}

fn parse_external_pub_visibility(tokens: &[Token], pub_idx: usize) -> Option<usize> {
    if tokens.get(pub_idx + 1).is_some_and(|t| t.text == "(") {
        if tokens.get(pub_idx + 2).is_some_and(|t| t.kind == TokenKind::Ident && t.text == "crate") && tokens.get(pub_idx + 3).is_some_and(|t| t.text == ")") {
            return Some(pub_idx + 4);
        }
        return None;
    }
    Some(pub_idx + 1)
}

/// Counts external `pub` / `pub(crate)` structs, enums, traits, and fns in stripped non-test Rust tokens.
fn count_pub_symbols(tokens: &[Token]) -> usize {
    let mut count = 0usize;
    let mut i = 0usize;

    while i < tokens.len() {
        if tokens[i].kind == TokenKind::Ident
            && tokens[i].text == "pub"
            && let Some(mut cursor) = parse_external_pub_visibility(tokens, i)
        {
            while let Some(kw) = tokens.get(cursor) {
                if kw.kind == TokenKind::Ident && matches!(kw.text.as_str(), "async" | "const" | "unsafe" | "extern") {
                    cursor += 1;
                } else {
                    break;
                }
            }
            if tokens
                .get(cursor)
                .is_some_and(|t| t.kind == TokenKind::Ident && matches!(t.text.as_str(), "struct" | "enum" | "trait" | "fn"))
                && tokens.get(cursor + 1).is_some_and(|t| t.kind == TokenKind::Ident)
            {
                count += 1;
                i = cursor + 2;
                continue;
            }
        }
        i += 1;
    }

    count
}

fn count_locks(tokens: &[Token]) -> (usize, usize) {
    let mut mutex_count = 0usize;
    let mut rwlock_count = 0usize;
    for i in 0..tokens.len() {
        if tokens[i].kind != TokenKind::Ident || tokens.get(i + 1).is_none_or(|t| t.text != "<") {
            continue;
        }
        match tokens[i].text.as_str() {
            "Mutex" => mutex_count += 1,
            "RwLock" => rwlock_count += 1,
            _ => {}
        }
    }
    (mutex_count, rwlock_count)
}

fn parse_use_tree(tokens: &[Token], start_index: usize, prefix: &[String], inline_mods: &[String], out: &mut Vec<PathRef>) -> usize {
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
                i = parse_use_tree(tokens, i, &segments, inline_mods, out);
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
                inline_mods: inline_mods.to_vec(),
            });
            return i + 1;
        }

        if tok.kind == TokenKind::Ident {
            if tok.text != "self" || segments.is_empty() {
                segments.push(tok.text.clone());
            }
            i += 1;
            if tokens.get(i).is_some_and(|t| t.text == "::") {
                i += 1;
                continue;
            }
            if tokens.get(i).is_some_and(|t| t.kind == TokenKind::Ident && t.text == "as") {
                i += 2;
            }
            if !segments.is_empty() {
                out.push(PathRef {
                    segments,
                    inline_mods: inline_mods.to_vec(),
                });
            }
            return i;
        }

        break;
    }

    i
}

fn is_use_statement_position(tokens: &[Token], index: usize) -> bool {
    if index == 0 {
        return true;
    }
    let Some(prev) = tokens.get(index - 1) else {
        return true;
    };
    if matches!(prev.text.as_str(), ";" | "{" | "}" | "]") {
        return true;
    }
    if prev.kind == TokenKind::Ident && prev.text == "pub" {
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
                    return k > 0 && tokens[k - 1].kind == TokenKind::Ident && tokens[k - 1].text == "pub";
                }
            }
        }
    }
    false
}

fn extract_path_refs(tokens: &[Token]) -> Vec<PathRef> {
    let mut refs = Vec::new();
    let mut brace_stack: Vec<Option<String>> = Vec::new();
    let active_inline_mods = |stack: &[Option<String>]| -> Vec<String> { stack.iter().filter_map(|m| m.clone()).collect() };

    let mut i = 0usize;
    while i < tokens.len() {
        let tok = &tokens[i];

        if tok.kind == TokenKind::Ident
            && tok.text == "mod"
            && tokens.get(i + 1).is_some_and(|t| t.kind == TokenKind::Ident)
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

        if tok.kind == TokenKind::Ident && tok.text == "use" && tokens.get(i + 1).is_none_or(|t| t.text != "<") && is_use_statement_position(tokens, i) {
            let mods = active_inline_mods(&brace_stack);
            i = parse_use_tree(tokens, i + 1, &[], &mods, &mut refs);
            while i < tokens.len() && tokens[i].text != ";" {
                i += 1;
            }
            if tokens.get(i).is_some_and(|t| t.text == ";") {
                i += 1;
            }
            continue;
        }

        let mut cursor = i;
        if tokens.get(cursor).is_some_and(|t| t.text == "::") {
            cursor += 1;
        }
        if let Some(head) = tokens.get(cursor)
            && head.kind == TokenKind::Ident
            && matches!(head.text.as_str(), "crate" | "super" | "self")
            && tokens.get(cursor + 1).is_some_and(|t| t.text == "::")
        {
            let mut segments = vec![head.text.clone()];
            cursor += 1;
            while tokens.get(cursor).is_some_and(|t| t.text == "::") && tokens.get(cursor + 1).is_some_and(|t| t.kind == TokenKind::Ident) {
                segments.push(tokens[cursor + 1].text.clone());
                cursor += 2;
            }
            refs.push(PathRef {
                segments,
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

fn map_violation_to_diagnostic(v: &ArchViolation) -> Diagnostic {
    Diagnostic {
        rule: v.rule.as_str().to_owned(),
        severity: DiagnosticSeverity::Error,
        file: v.file.clone(),
        line: v.line,
        why: v.message.clone(),
        fix: v.fix.clone(),
        see: v.see.to_owned(),
        details: v.details.clone(),
    }
}

fn build_ratchet_summary(report: &ArchAuditReport) -> RatchetSummary {
    RatchetSummary {
        server_flume: RatchetStatus {
            current: report.flume_count,
            ceiling: report.flume_ceiling,
        },
        runtime_flume: RatchetStatus {
            current: report.runtime_flume_count,
            ceiling: report.runtime_flume_ceiling,
        },
        sync_async_dup: RatchetStatus {
            current: report.sync_async_dup_count,
            ceiling: report.sync_async_dup_ceiling,
        },
        server_sync_fs: RatchetStatus {
            current: report.server_sync_fs_count,
            ceiling: report.server_sync_fs_ceiling,
        },
        server_internal_value: RatchetStatus {
            current: report.server_internal_value_count,
            ceiling: report.server_internal_value_ceiling,
        },
        runtime_block_on: RatchetStatus {
            current: report.runtime_block_on_count,
            ceiling: report.runtime_block_on_ceiling,
        },
        runtime_os_thread: RatchetStatus {
            current: report.runtime_os_thread_count,
            ceiling: report.runtime_os_thread_ceiling,
        },
        mac_block_on: RatchetStatus {
            current: report.mac_block_on_count,
            ceiling: report.mac_block_on_ceiling,
        },
        mac_os_thread: RatchetStatus {
            current: report.mac_os_thread_count,
            ceiling: report.mac_os_thread_ceiling,
        },
        app_rs_loc: report.app_rs_non_test_lines,
        router_rs_loc: report.router_rs_non_test_lines,
    }
}

fn rank_hotspots(crates: &[CrateSummary], server_modules: &[ModuleMetrics], top_n: usize) -> Vec<Hotspot> {
    let mut candidates: Vec<Hotspot> = Vec::new();

    for c in crates {
        for f in &c.oversized_files {
            let excess = f.loc.saturating_sub(OVERSIZED_FILE_THRESHOLD);
            let score = 100 + excess / 10;
            candidates.push(Hotspot {
                rank: 0,
                score,
                kind: HotspotKind::OversizedFile,
                target: f.file.clone(),
                why: format!("{} non-test lines (exceeds {OVERSIZED_FILE_THRESHOLD}-line threshold by {excess})", f.loc),
                fix: "Split cohesive sub-responsibilities into focused submodules with narrow public APIs.".to_owned(),
            });
        }
    }

    for m in server_modules {
        if m.lock_count >= LOCK_HOTSPOT_MIN_COUNT {
            candidates.push(Hotspot {
                rank: 0,
                score: m.lock_count * 12,
                kind: HotspotKind::LockHotspot,
                target: format!("crates/server/src/{}", m.module),
                why: format!(
                    "module `{}` holds {} non-test lock sites ({} Mutex<, {} RwLock<)",
                    m.module, m.lock_count, m.mutex_count, m.rwlock_count
                ),
                fix: "Replace shared coarse locks with single-owner Tokio tasks, `watch` channels, or `ArcSwap` snapshots.".to_owned(),
            });
        }

        if !SHALLOW_EXEMPT_MODULES.contains(&m.module.as_str()) && m.pub_symbols >= SHALLOW_MIN_PUB_SYMBOLS && m.depth_ratio < SHALLOW_DEPTH_RATIO_THRESHOLD {
            let gap = ((SHALLOW_DEPTH_RATIO_THRESHOLD - m.depth_ratio) * 5.0).round().max(1.0) as usize;
            candidates.push(Hotspot {
                rank: 0,
                score: gap + m.pub_symbols,
                kind: HotspotKind::ShallowModule,
                target: format!("crates/server/src/{}", m.module),
                why: format!(
                    "module `{}` exposes {} pub symbols for {} non-test lines (depth_ratio={:.2} < {:.1})",
                    m.module, m.pub_symbols, m.loc, m.depth_ratio, SHALLOW_DEPTH_RATIO_THRESHOLD
                ),
                fix: "Collapse pass-through wrappers and narrow exported symbols to a deeper domain facade.".to_owned(),
            });
        }

        let coupling_degree = m.fan_in + m.fan_out;
        if !COUPLING_EXEMPT_MODULES.contains(&m.module.as_str()) && coupling_degree >= COUPLING_HOTSPOT_MIN_DEGREE {
            candidates.push(Hotspot {
                rank: 0,
                score: coupling_degree * 10,
                kind: HotspotKind::HighCoupling,
                target: format!("crates/server/src/{}", m.module),
                why: format!(
                    "module `{}` has high coupling degree {coupling_degree} (fan_in={}, fan_out={}, instability={:.2})",
                    m.module, m.fan_in, m.fan_out, m.instability
                ),
                fix: "Reduce cross-module coupling by pulling shared types into leaf modules or inverting orchestration.".to_owned(),
            });
        }
    }

    candidates.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.kind.cmp(&b.kind)).then_with(|| a.target.cmp(&b.target)));
    candidates.truncate(top_n);
    for (idx, h) in candidates.iter_mut().enumerate() {
        h.rank = idx + 1;
    }
    candidates
}

fn compute_metrics_on_files(files: &[SourceFile], audit_report: &ArchAuditReport, top_n: usize) -> DiagnoseReport {
    let mut sorted: Vec<SourceFile> = files
        .iter()
        .map(|f| SourceFile {
            path: f.path.replace('\\', "/"),
            text: f.text.clone(),
        })
        .filter(|f| is_audited_rust_path(&f.path))
        .collect();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));

    let mut excluded_targets = BTreeSet::new();
    let mut non_test_codes: BTreeMap<String, String> = BTreeMap::new();
    let mut known_server_modules = BTreeSet::new();

    for file in &sorted {
        if let Some(top) = top_level_module_of_server_file(&file.path) {
            known_server_modules.insert(top);
        }
        let no_comments = strip_rust_comments_and_literals(&file.text);
        let stripped = strip_cfg_test_and_collect_excluded(&file.text, &no_comments, &file.path);
        for target in stripped.excluded_submodules {
            excluded_targets.insert(target);
        }
        non_test_codes.insert(file.path.clone(), stripped.code);
    }

    let mut crate_accums: BTreeMap<&'static str, CrateAccum> = BTreeMap::new();
    for root in ["crates/server/src", "crates/runtime/src", "apps/mac/src"] {
        crate_accums.insert(root, CrateAccum::default());
    }

    let mut server_accums: BTreeMap<String, ModuleAccum> = BTreeMap::new();
    let mut outgoing: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut incoming: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for module in &known_server_modules {
        outgoing.insert(module.clone(), BTreeSet::new());
        incoming.insert(module.clone(), BTreeSet::new());
    }

    let mut files_scanned = 0usize;

    for file in &sorted {
        if is_excluded_by_cfg_test(&file.path, &excluded_targets) {
            continue;
        }
        files_scanned += 1;

        let non_test_code = non_test_codes
            .get(&file.path)
            .map_or_else(|| strip_rust_non_code(&file.text, &file.path), Clone::clone);
        let loc = count_non_test_code_lines(&non_test_code);
        let tokens = tokenize_rust(&non_test_code);
        let pub_symbols = count_pub_symbols(&tokens);
        let (mutex_count, rwlock_count) = count_locks(&tokens);

        if let Some(crate_root) = crate_root_of(&file.path)
            && let Some(c) = crate_accums.get_mut(crate_root)
        {
            c.files += 1;
            c.loc += loc;
            c.pub_symbols += pub_symbols;
            c.mutex_count += mutex_count;
            c.rwlock_count += rwlock_count;
            if loc > OVERSIZED_FILE_THRESHOLD {
                c.oversized_files.push(OversizedFile { file: file.path.clone(), loc });
            }
        }

        if let Some(source_mod) = top_level_module_of_server_file(&file.path) {
            let entry = server_accums.entry(source_mod.clone()).or_default();
            entry.files += 1;
            entry.loc += loc;
            entry.pub_symbols += pub_symbols;
            entry.mutex_count += mutex_count;
            entry.rwlock_count += rwlock_count;
            if loc > OVERSIZED_FILE_THRESHOLD {
                entry.oversized_files.push(OversizedFile { file: file.path.clone(), loc });
            }

            if let Some(file_mod_path) = server_file_module_path(&file.path) {
                for path_ref in extract_path_refs(&tokens) {
                    let Some(resolved) = resolve_crate_relative_segments(&path_ref, &file_mod_path) else {
                        continue;
                    };
                    let Some(target_mod) = resolved.first() else {
                        continue;
                    };
                    if !is_snake_case_module_name(target_mod) || target_mod == &source_mod {
                        continue;
                    }
                    if !known_server_modules.contains(target_mod) {
                        continue;
                    }
                    outgoing.entry(source_mod.clone()).or_default().insert(target_mod.clone());
                    incoming.entry(target_mod.clone()).or_default().insert(source_mod.clone());
                }
            }
        }
    }

    let mut crates: Vec<CrateSummary> = Vec::with_capacity(crate_accums.len());
    for root in ["crates/server/src", "crates/runtime/src", "apps/mac/src"] {
        let mut accum = crate_accums.remove(root).unwrap_or_default();
        accum.oversized_files.sort_by(|a, b| b.loc.cmp(&a.loc).then_with(|| a.file.cmp(&b.file)));
        let lock_count = accum.mutex_count + accum.rwlock_count;
        let oversized_file_count = accum.oversized_files.len();
        crates.push(CrateSummary {
            crate_root: root.to_owned(),
            files: accum.files,
            loc: accum.loc,
            pub_symbols: accum.pub_symbols,
            depth_ratio: compute_depth_ratio(accum.loc, accum.pub_symbols),
            lock_count,
            mutex_count: accum.mutex_count,
            rwlock_count: accum.rwlock_count,
            oversized_file_count,
            oversized_files: accum.oversized_files,
        });
    }

    let mut server_modules: Vec<ModuleMetrics> = Vec::with_capacity(server_accums.len());
    for (module, mut accum) in server_accums {
        accum.oversized_files.sort_by(|a, b| b.loc.cmp(&a.loc).then_with(|| a.file.cmp(&b.file)));
        let depends_on: Vec<String> = outgoing.remove(&module).unwrap_or_default().into_iter().collect();
        let depended_by: Vec<String> = incoming.remove(&module).unwrap_or_default().into_iter().collect();
        let fan_out = depends_on.len();
        let fan_in = depended_by.len();
        let lock_count = accum.mutex_count + accum.rwlock_count;
        server_modules.push(ModuleMetrics {
            module,
            files: accum.files,
            loc: accum.loc,
            pub_symbols: accum.pub_symbols,
            depth_ratio: compute_depth_ratio(accum.loc, accum.pub_symbols),
            fan_in,
            fan_out,
            instability: compute_instability(fan_in, fan_out),
            lock_count,
            mutex_count: accum.mutex_count,
            rwlock_count: accum.rwlock_count,
            oversized_files: accum.oversized_files,
            depends_on,
            depended_by,
        });
    }

    let diagnostics: Vec<Diagnostic> = audit_report.violations.iter().map(map_violation_to_diagnostic).collect();
    let hotspots = rank_hotspots(&crates, &server_modules, top_n);
    let ratchets = build_ratchet_summary(audit_report);

    let total_loc = crates.iter().map(|c| c.loc).sum();
    let total_pub_symbols = crates.iter().map(|c| c.pub_symbols).sum();
    let total_locks = crates.iter().map(|c| c.lock_count).sum();
    let oversized_file_count = crates.iter().map(|c| c.oversized_file_count).sum();

    DiagnoseReport {
        summary: DiagnoseSummary {
            files_scanned,
            server_modules: server_modules.len(),
            total_loc,
            total_pub_symbols,
            total_locks,
            oversized_file_count,
            diagnostic_count: diagnostics.len(),
            hotspot_count: hotspots.len(),
        },
        crates,
        server_modules,
        ratchets,
        hotspots,
        diagnostics,
    }
}

pub fn diagnose_workspace_with_config(repo_root: &Path, config: ArchAuditConfig, top_n: usize) -> Result<DiagnoseReport, String> {
    let files = walk_matching_files(repo_root, &["crates/server/src", "crates/runtime/src", "apps/mac/src"], is_audited_rust_path)?;
    let audit_report = audit_server_architecture_with_config(repo_root, config)?;
    Ok(compute_metrics_on_files(&files, &audit_report, top_n))
}

pub fn diagnose_workspace(repo_root: &Path, top_n: usize) -> Result<DiagnoseReport, String> {
    let files = walk_matching_files(repo_root, &["crates/server/src", "crates/runtime/src", "apps/mac/src"], is_audited_rust_path)?;
    let audit_report = audit_server_architecture_report(repo_root)?;
    Ok(compute_metrics_on_files(&files, &audit_report, top_n))
}

pub fn format_diagnose_report(report: &DiagnoseReport) -> String {
    let mut out = Vec::new();
    out.push(format!(
        "diagnose: {} files, {} non-test LOC, {} pub symbols, {} locks, {} oversized (>{OVERSIZED_FILE_THRESHOLD} LOC), {} diagnostics, {} hotspots",
        report.summary.files_scanned,
        report.summary.total_loc,
        report.summary.total_pub_symbols,
        report.summary.total_locks,
        report.summary.oversized_file_count,
        report.summary.diagnostic_count,
        report.summary.hotspot_count,
    ));

    out.push(String::new());
    out.push("Crate Summaries:".to_owned());
    out.push(format!(
        "  {:<22} {:>6} {:>8} {:>8} {:>8} {:>7} {:>9}",
        "CRATE", "FILES", "LOC", "PUB", "DEPTH", "LOCKS", "OVERSIZED"
    ));
    for c in &report.crates {
        out.push(format!(
            "  {:<22} {:>6} {:>8} {:>8} {:>8.2} {:>7} {:>9}",
            c.crate_root, c.files, c.loc, c.pub_symbols, c.depth_ratio, c.lock_count, c.oversized_file_count
        ));
    }

    out.push(String::new());
    out.push("Server Top-Level Modules (crates/server/src/):".to_owned());
    out.push(format!(
        "  {:<14} {:>5} {:>7} {:>6} {:>7} {:>4} {:>4} {:>6} {:>6} {:>5}",
        "MODULE", "FILES", "LOC", "PUB", "DEPTH", "Ca", "Ce", "INSTAB", "LOCKS", ">800"
    ));
    for m in &report.server_modules {
        out.push(format!(
            "  {:<14} {:>5} {:>7} {:>6} {:>7.2} {:>4} {:>4} {:>6.2} {:>6} {:>5}",
            m.module,
            m.files,
            m.loc,
            m.pub_symbols,
            m.depth_ratio,
            m.fan_in,
            m.fan_out,
            m.instability,
            m.lock_count,
            m.oversized_files.len(),
        ));
    }

    let r = &report.ratchets;
    out.push(String::new());
    out.push(format!(
        "Ratchets: server(flume={}/{}, sync/async-dup={}/{}, sync-fs={}/{}, internal-value={}/{}) runtime(flume={}/{}, block_on={}/{}, os-thread={}/{}) mac(block_on={}/{}, os-thread={}/{})",
        r.server_flume.current,
        r.server_flume.ceiling,
        r.sync_async_dup.current,
        r.sync_async_dup.ceiling,
        r.server_sync_fs.current,
        r.server_sync_fs.ceiling,
        r.server_internal_value.current,
        r.server_internal_value.ceiling,
        r.runtime_flume.current,
        r.runtime_flume.ceiling,
        r.runtime_block_on.current,
        r.runtime_block_on.ceiling,
        r.runtime_os_thread.current,
        r.runtime_os_thread.ceiling,
        r.mac_block_on.current,
        r.mac_block_on.ceiling,
        r.mac_os_thread.current,
        r.mac_os_thread.ceiling,
    ));

    out.push(String::new());
    out.push(format!("Top {} Architectural Hotspots:", report.hotspots.len()));
    if report.hotspots.is_empty() {
        out.push("  (none)".to_owned());
    } else {
        for h in &report.hotspots {
            out.push(format!("  #{:<2} [score={:<4} {}] {}: {}", h.rank, h.score, h.kind.as_str(), h.target, h.why));
            out.push(format!("      Fix: {}", h.fix));
        }
    }

    out.push(String::new());
    out.push(format!("Prescriptive Diagnostics ({}):", report.diagnostics.len()));
    if report.diagnostics.is_empty() {
        out.push("  (0 arch-audit violations)".to_owned());
    } else {
        let mut by_rule: BTreeMap<&str, usize> = BTreeMap::new();
        for d in &report.diagnostics {
            *by_rule.entry(d.rule.as_str()).or_insert(0) += 1;
        }
        let summary = by_rule.into_iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(", ");
        out.push(format!("  by rule: {summary}"));
        for d in report.diagnostics.iter().take(10) {
            out.push(format!("  [{}] {}:{}: {}", d.rule, d.file, d.line, d.why));
            out.push(format!("    Fix: {}", d.fix));
            out.push(format!("    See: {}", d.see));
        }
        if report.diagnostics.len() > 10 {
            out.push(format!(
                "  ... and {} more (run `cargo xtask diagnose --json` for full list)",
                report.diagnostics.len() - 10
            ));
        }
    }

    out.join("\n")
}

fn write_stdout_line(text: &str) -> Result<(), String> {
    let mut stdout = io::stdout().lock();
    match writeln!(stdout, "{text}") {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::BrokenPipe => Ok(()),
        Err(err) => Err(format!("failed to write diagnose output: {err}")),
    }
}

pub fn run(root: &Path, args: &[String]) -> Result<i32, String> {
    let mut json_output = false;
    let mut top_n = DEFAULT_TOP_HOTSPOTS;
    let mut i = 0usize;

    while i < args.len() {
        match args[i].as_str() {
            "--json" => json_output = true,
            "--top" => {
                let Some(val) = args.get(i + 1) else {
                    eprintln!("Usage: cargo xtask diagnose [--json] [--top <N>] (--top requires a value)");
                    return Ok(2);
                };
                top_n = val
                    .parse::<usize>()
                    .map_err(|_| format!("Usage: cargo xtask diagnose [--json] [--top <N>] (invalid --top value `{val}`)"))?;
                i += 1;
            }
            arg if arg.starts_with("--top=") => {
                let val = &arg["--top=".len()..];
                top_n = val
                    .parse::<usize>()
                    .map_err(|_| format!("Usage: cargo xtask diagnose [--json] [--top <N>] (invalid --top value `{val}`)"))?;
            }
            "--help" | "-h" => {
                write_stdout_line("Usage: cargo xtask diagnose [--json] [--top <N>]")?;
                return Ok(0);
            }
            other => {
                eprintln!("Usage: cargo xtask diagnose [--json] [--top <N>] (unknown option {other})");
                return Ok(2);
            }
        }
        i += 1;
    }

    let report = diagnose_workspace(root, top_n)?;
    if json_output {
        let serialized = serde_json::to_string_pretty(&report).map_err(|err| format!("failed to serialize diagnose report: {err}"))?;
        write_stdout_line(&serialized)?;
    } else {
        write_stdout_line(&format_diagnose_report(&report))?;
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

    fn find_module<'a>(report: &'a DiagnoseReport, name: &str) -> &'a ModuleMetrics {
        report
            .server_modules
            .iter()
            .find(|m| m.module == name)
            .unwrap_or_else(|| panic!("module `{name}` not found in {:?}", report.server_modules))
    }

    #[test]
    fn depth_ratio_and_pub_symbols_ignore_comments_and_cfg_test() {
        let dir = TempDir::new("vv-diag-depth");
        dir.write(
            "crates/server/src/issue/mod.rs",
            [
                "// pub struct CommentedOut;",
                "const DOC: &str = \"pub fn in_string() {}\";",
                "pub struct Issue;",
                "pub enum State { Open, Closed }",
                "pub trait Repo {}",
                "pub async fn fetch() {}",
                "pub(crate) fn internal_api() {}",
                "pub(self) fn private_pub_self() {}",
                "fn helper_a() { let x = 1; let _ = x; }",
                "fn helper_b() { let y = 2; let _ = y; }",
                "fn helper_c() { let z = 3; let _ = z; }",
                "fn helper_d() { let w = 4; let _ = w; }",
                "#[cfg(test)]",
                "mod tests {",
                "    pub struct TestOnly;",
                "    pub fn test_helper() {}",
                "}",
                "#[cfg(test)]",
                "mod ext_tests;",
            ]
            .join("\n")
            .as_str(),
        );
        dir.write("crates/server/src/issue/ext_tests.rs", "pub struct ExternalTest;\npub fn ext() {}\n");

        let report = diagnose_workspace(&dir.0, 10).unwrap();
        let issue = find_module(&report, "issue");
        // Non-test non-empty lines:
        // DOC, Issue, State, Repo, fetch, internal_api, private_pub_self, helper_a..d = 11 lines
        assert_eq!(issue.loc, 11);
        // External pub/pub(crate) symbols: Issue, State, Repo, fetch, internal_api = 5
        assert_eq!(issue.pub_symbols, 5);
        assert_eq!(issue.depth_ratio, 2.2);
        assert_eq!(issue.files, 1);
    }

    #[test]
    fn fan_in_fan_out_and_instability_across_server_modules() {
        let dir = TempDir::new("vv-diag-coupling");
        // Leaf module: depended on by service, issue, gateway (Ca = 3, Ce = 0, I = 0.0)
        dir.write("crates/server/src/context.rs", "pub struct Ctx;\n");
        // Middle layer: depends on context (Ce = 1), depended on by issue and gateway (Ca = 2, I = 1/3 = 0.33)
        dir.write(
            "crates/server/src/service/mod.rs",
            "use crate::context::Ctx;\nuse crate::service::helper;\npub mod helper;\npub struct Svc(pub Ctx);\n",
        );
        dir.write("crates/server/src/service/helper.rs", "pub fn ok() {}\n");
        // Domain module: depends on context + service via grouped use + super (Ce = 2), depended on by gateway (Ca = 1, I = 2/3 = 0.67)
        dir.write(
            "crates/server/src/issue/mod.rs",
            "use crate::{context::Ctx, service::Svc};\npub fn run(_: Ctx, _: Svc) {}\n",
        );
        // Entry adapter: depends on context, service, issue via inline path + super (Ce = 3, Ca = 0, I = 1.0)
        dir.write(
            "crates/server/src/gateway/http.rs",
            "use super::super::issue::run;\npub fn handle() { let _ = crate::context::Ctx; let _ = crate::service::helper::ok(); let _ = run; }\n",
        );

        let report = diagnose_workspace(&dir.0, 10).unwrap();

        let context = find_module(&report, "context");
        assert_eq!(context.fan_in, 3);
        assert_eq!(context.fan_out, 0);
        assert_eq!(context.instability, 0.0);
        assert_eq!(context.depended_by, vec!["gateway", "issue", "service"]);

        let service = find_module(&report, "service");
        assert_eq!(service.fan_in, 2);
        assert_eq!(service.fan_out, 1);
        assert_eq!(service.instability, 0.33);
        assert_eq!(service.depends_on, vec!["context"]);
        assert_eq!(service.depended_by, vec!["gateway", "issue"]);

        let issue = find_module(&report, "issue");
        assert_eq!(issue.fan_in, 1);
        assert_eq!(issue.fan_out, 2);
        assert_eq!(issue.instability, 0.67);

        let gateway = find_module(&report, "gateway");
        assert_eq!(gateway.fan_in, 0);
        assert_eq!(gateway.fan_out, 3);
        assert_eq!(gateway.instability, 1.0);
        assert_eq!(gateway.depends_on, vec!["context", "issue", "service"]);
    }

    #[test]
    fn locks_oversized_files_crate_summaries_and_hotspot_ranking() {
        let dir = TempDir::new("vv-diag-hotspots");
        // Oversized file (850 lines) + 6 locks in server::issue
        let mut big = String::from("pub struct State {\n");
        for i in 0..4 {
            big.push_str(&format!("    m{i}: std::sync::Mutex<usize>,\n"));
        }
        for i in 0..2 {
            big.push_str(&format!("    r{i}: tokio::sync::RwLock<usize>,\n"));
        }
        big.push_str("}\n");
        for i in 0..842 {
            big.push_str(&format!("fn line_{i}() {{}}\n"));
        }
        dir.write("crates/server/src/issue/big.rs", &big);
        // Runtime and mac summary files
        dir.write("crates/runtime/src/oar.rs", "pub struct Oar { lock: Mutex<u8> }\npub fn run() {}\n");
        dir.write("apps/mac/src/host.rs", "pub struct Host { rw: RwLock<u8> }\n");

        let report = diagnose_workspace(&dir.0, 2).unwrap();
        let issue = find_module(&report, "issue");
        assert_eq!(issue.lock_count, 6);
        assert_eq!(issue.mutex_count, 4);
        assert_eq!(issue.rwlock_count, 2);
        assert_eq!(issue.oversized_files.len(), 1);
        assert_eq!(issue.oversized_files[0].file, "crates/server/src/issue/big.rs");
        assert_eq!(issue.oversized_files[0].loc, 850);

        let runtime = report.crates.iter().find(|c| c.crate_root == "crates/runtime/src").unwrap();
        assert_eq!(runtime.files, 1);
        assert_eq!(runtime.pub_symbols, 2);
        assert_eq!(runtime.lock_count, 1);

        let mac = report.crates.iter().find(|c| c.crate_root == "apps/mac/src").unwrap();
        assert_eq!(mac.files, 1);
        assert_eq!(mac.pub_symbols, 1);
        assert_eq!(mac.rwlock_count, 1);

        // Top 2 hotspots should be ranked by score descending: oversized-file (105) then lock-hotspot (72)
        assert_eq!(report.hotspots.len(), 2);
        assert_eq!(report.hotspots[0].rank, 1);
        assert_eq!(report.hotspots[0].kind, HotspotKind::OversizedFile);
        assert_eq!(report.hotspots[1].rank, 2);
        assert_eq!(report.hotspots[1].kind, HotspotKind::LockHotspot);
    }

    #[test]
    fn json_serialization_includes_prescriptive_diagnostics_and_metrics() {
        let dir = TempDir::new("vv-diag-json");
        dir.write("crates/server/src/issue/mod.rs", "use crate::gateway::http;\npub fn bad() {}\n");
        dir.write("crates/server/src/gateway/http.rs", "pub fn serve() {}\n");

        let report = diagnose_workspace(&dir.0, 5).unwrap();
        let json_str = serde_json::to_string_pretty(&report).unwrap();
        let val: serde_json::Value = serde_json::from_str(&json_str).unwrap();

        assert_eq!(val["summary"]["diagnostic_count"], 1);
        let diag = &val["diagnostics"][0];
        assert_eq!(diag["rule"], "no-gateway-reverse-import");
        assert_eq!(diag["severity"], "error");
        assert_eq!(diag["file"], "crates/server/src/issue/mod.rs");
        assert_eq!(diag["line"], 1);
        assert!(diag["why"].as_str().unwrap().contains("crate::gateway"));
        assert!(!diag["fix"].as_str().unwrap().is_empty());
        assert_eq!(diag["see"], "docs/architecture.md");

        assert!(val["server_modules"].is_array());
        assert!(val["crates"].is_array());
        assert!(val["ratchets"]["server_flume"]["ceiling"].is_number());
        assert!(val["hotspots"].is_array());

        let text = format_diagnose_report(&report);
        assert!(text.contains("Server Top-Level Modules"));
        assert!(text.contains("no-gateway-reverse-import"));
    }
}
