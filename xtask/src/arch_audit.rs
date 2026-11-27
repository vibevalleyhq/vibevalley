//! Deterministic architectural audit scanner for the flat `crates/server/src/` layout
//! and cross-crate concurrency/async ratchets (`crates/server`, `crates/runtime`, `apps/mac`).

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::Path;

use serde::Serialize;

use crate::rust_scan::{
    LineIndex, SourceFile, is_excluded_by_cfg_test, is_ident_char, is_ident_start, strip_cfg_test_and_collect_excluded, strip_rust_comments_and_literals,
    strip_rust_non_code, walk_matching_files,
};

const ARCH_DOC: &str = "docs/architecture.md";
const CONCURRENCY_DOC: &str = "docs/style/rust-async-concurrency.md";
const MODULE_DESIGN_DOC: &str = "docs/style/module-design.md";

/// Non-test code line ceiling for `crates/server/src/app.rs`.
pub const APP_RS_NON_TEST_LINE_CEILING: usize = 350;

/// Non-test code line ceiling for `crates/server/src/router.rs`.
pub const ROUTER_RS_NON_TEST_LINE_CEILING: usize = 350;

/// Non-test code line ceiling for `crates/server/src/boot.rs`.
pub const BOOT_RS_NON_TEST_LINE_CEILING: usize = 280;

/// Non-test code line ceiling for `crates/server/src/projection.rs`.
pub const PROJECTION_RS_NON_TEST_LINE_CEILING: usize = 310;

/// Non-test code line ceiling for `crates/server/src/router/glue.rs`.
pub const ROUTER_GLUE_RS_NON_TEST_LINE_CEILING: usize = 270;

/// Shrink-only ceiling for non-test `flume::` references under `crates/server/src/`.
/// Initialized to 0 for strict post-refactor gating; never raise this ceiling.
pub const SERVER_FLUME_CEILING: usize = 0;

/// Shrink-only ceiling for non-test `flume::` references under `crates/runtime/src/`.
/// Initialized to 0 for full Tokio adoption across `oar/` and `agent/`; never raise this ceiling.
pub const RUNTIME_FLUME_CEILING: usize = 0;

/// Shrink-only ceiling for same-file `pub fn <name>` + `pub async fn <name>_async`
/// pairs under `crates/server/src/` (excluding `#[cfg(test)]`).
/// Initialized to 0 for strict post-refactor gating; never raise this ceiling.
pub const SERVER_SYNC_ASYNC_DUP_CEILING: usize = 0;

/// Shrink-only ceiling for non-test `std::fs::` calls under `crates/server/src/`.
/// Initialized to 0 for strict post-refactor gating; never raise this ceiling.
pub const SERVER_SYNC_FS_CEILING: usize = 0;

/// Shrink-only ceiling for non-test `pub` / `pub(crate)` fn signatures containing
/// `serde_json::Value` / `Value` under `crates/server/src/` excluding `{router.rs, fake/, gateway/api/}`.
/// Initialized to 0 for strict post-refactor gating; never raise this ceiling.
pub const SERVER_INTERNAL_VALUE_CEILING: usize = 0;

/// Shrink-only ceiling for non-test `block_on(` calls under `crates/runtime/src/` (excluding `rt.rs` boundary helper).
/// Initialized to 0 for full Tokio adoption; never raise this ceiling.
pub const RUNTIME_BLOCK_ON_CEILING: usize = 0;

/// Shrink-only ceiling for non-test `thread::spawn` / `std::thread::Builder` sites under `crates/runtime/src/` (excluding `bin/` test fixtures).
/// Initialized to 0 for full Tokio adoption; never raise this ceiling.
pub const RUNTIME_OS_THREAD_CEILING: usize = 0;

/// Shrink-only ceiling for non-test `block_on(` calls under `apps/mac/src/` and `apps/mac/crates/workspace/src/`.
/// Locked at the current baseline; lower as sites migrate to async and never raise this ceiling.
pub const MAC_BLOCK_ON_CEILING: usize = 2;

/// Shrink-only ceiling for non-test `thread::spawn` / `std::thread::Builder` sites under `apps/mac/src/` and `apps/mac/crates/workspace/src/`.
/// Locked at the current baseline; lower as sites migrate to async and never raise this ceiling.
pub const MAC_OS_THREAD_CEILING: usize = 2;

/// Shrink-only ceiling for non-test `Command::new("git")` sites across workspace production source
/// (excluding `crates/git/src/`, `crates/runtime/src/bin/`, and `fake/`).
/// Initialized to 0 for strict post-refactor gating; never raise this ceiling.
pub const RAW_GIT_COMMAND_CEILING: usize = 0;

/// Shrink-only ceiling for non-test `std::process::Command` sites under `crates/server/src/` (excluding `fake/`).
/// Initialized to 0 for strict post-refactor gating; never raise this ceiling.
pub const SERVER_SYNC_PROCESS_CEILING: usize = 0;

/// Shrink-only ceiling for non-test `reqwest::blocking` references across workspace production source
/// (excluding `crates/runtime/src/bin/`).
/// Initialized to 0 for strict post-refactor gating; never raise this ceiling.
pub const BLOCKING_REQWEST_CEILING: usize = 0;

/// Default non-test code line ceiling for `mod.rs` facade files across `crates/**/src/` and `apps/mac/src/`.
pub const MOD_RS_NON_TEST_LINE_CEILING: usize = 200;

/// Legacy shrink-only grandfather list (now emptied — all `mod.rs` files across the repo must stay `<= MOD_RS_NON_TEST_LINE_CEILING`).
pub const LEGACY_FAT_MOD_RS_CEILINGS: &[(&str, usize)] = &[];

const GATEWAY_ALLOWED_ROOT_FILES: &[&str] = &["router.rs", "app.rs", "main.rs", "lib.rs"];
const DAG_IGNORED_BASE_MODULES: &[&str] = &["context", "log", "db", "service", "setting", "provider", "fake"];
const DAG_ROOT_MODULES: &[&str] = &["app", "router", "boot", "projection", "debug_sources", "main", "lib"];
const RUNTIME_FORBIDDEN_TARGETS: &[&str] = &["agent", "issue", "cron", "note", "connector", "voice", "game", "gateway", "app", "router"];
const SERVICE_ALLOWED_TARGETS: &[&str] = &["db", "context", "log"];
const GAME_ALLOWED_TARGETS: &[&str] = &["context", "repo"];
const LEGACY_SERVER_DIRS: &[&str] = &["app", "infra", "content", "collab", "team", "work", "skin", "transport"];
const LATE_BIND_HOOK_METHODS: &[&str] = &[
    "bind_server",
    "guard_removal",
    "set_remember",
    "attach_orchestrator",
    "attach_remote_auth",
    "attach_machine_bus",
];
const WELL_KNOWN_MODULES: &[&str] = &[
    "gateway",
    "runtime",
    "agent",
    "issue",
    "cron",
    "service",
    "game",
    "db",
    "context",
    "log",
    "repo",
    "setting",
    "provider",
    "fake",
    "app",
    "router",
    "boot",
    "projection",
    "debug_sources",
    "main",
    "lib",
];
const NON_JSON_VALUE_PREFIXES: &[&str] = &["sea_orm", "sea_query", "sqlx", "toml", "yaml", "serde_yaml"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ArchAuditRule {
    NoGatewayReverseImport,
    ServerDomainDag,
    NoSeaOrmOutsideService,
    OneTableOneEntityFile,
    NoLateBindHook,
    ThinAppAndRouter,
    ConcurrencyAndAsyncRatchets,
    NoLegacyServerLayout,
    NoSyncFsInServer,
    NoValueInInternalSig,
    RuntimeAndMacConcurrencyCeilings,
    NoRawGitCommand,
    NoSyncProcessInServer,
    NoBlockingReqwest,
    ThinModRs,
}

impl ArchAuditRule {
    pub const ALL: [Self; 15] = [
        Self::NoGatewayReverseImport,
        Self::ServerDomainDag,
        Self::NoSeaOrmOutsideService,
        Self::OneTableOneEntityFile,
        Self::NoLateBindHook,
        Self::ThinAppAndRouter,
        Self::ConcurrencyAndAsyncRatchets,
        Self::NoLegacyServerLayout,
        Self::NoSyncFsInServer,
        Self::NoValueInInternalSig,
        Self::RuntimeAndMacConcurrencyCeilings,
        Self::NoRawGitCommand,
        Self::NoSyncProcessInServer,
        Self::NoBlockingReqwest,
        Self::ThinModRs,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoGatewayReverseImport => "no-gateway-reverse-import",
            Self::ServerDomainDag => "server-domain-dag",
            Self::NoSeaOrmOutsideService => "no-sea-orm-outside-service",
            Self::OneTableOneEntityFile => "one-table-one-entity-file",
            Self::NoLateBindHook => "no-late-bind-hook",
            Self::ThinAppAndRouter => "thin-app-and-router",
            Self::ConcurrencyAndAsyncRatchets => "concurrency-and-async-ratchets",
            Self::NoLegacyServerLayout => "no-legacy-server-layout",
            Self::NoSyncFsInServer => "no-sync-fs-in-server",
            Self::NoValueInInternalSig => "no-value-in-internal-sig",
            Self::RuntimeAndMacConcurrencyCeilings => "runtime-and-mac-concurrency-ceilings",
            Self::NoRawGitCommand => "no-raw-git-command",
            Self::NoSyncProcessInServer => "no-sync-process-in-server",
            Self::NoBlockingReqwest => "no-blocking-reqwest",
            Self::ThinModRs => "thin-mod-rs",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ArchViolation {
    pub rule: ArchAuditRule,
    pub file: String,
    pub line: usize,
    pub message: String,
    pub fix: String,
    pub see: &'static str,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub details: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LockKind {
    Mutex,
    RwLock,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LockSite {
    pub kind: LockKind,
    pub file: String,
    pub line: usize,
    pub snippet: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DomainLockInventory {
    pub domain: String,
    pub mutex_count: usize,
    pub rwlock_count: usize,
    pub total: usize,
    pub sites: Vec<LockSite>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArchAuditConfig {
    pub app_rs_line_ceiling: usize,
    pub router_rs_line_ceiling: usize,
    pub flume_ceiling: usize,
    pub runtime_flume_ceiling: usize,
    pub sync_async_dup_ceiling: usize,
    pub server_sync_fs_ceiling: usize,
    pub server_internal_value_ceiling: usize,
    pub runtime_block_on_ceiling: usize,
    pub runtime_os_thread_ceiling: usize,
    pub mac_block_on_ceiling: usize,
    pub mac_os_thread_ceiling: usize,
    pub raw_git_command_ceiling: usize,
    pub server_sync_process_ceiling: usize,
    pub blocking_reqwest_ceiling: usize,
}

impl ArchAuditConfig {
    pub const fn strict() -> Self {
        Self {
            app_rs_line_ceiling: APP_RS_NON_TEST_LINE_CEILING,
            router_rs_line_ceiling: ROUTER_RS_NON_TEST_LINE_CEILING,
            flume_ceiling: SERVER_FLUME_CEILING,
            runtime_flume_ceiling: RUNTIME_FLUME_CEILING,
            sync_async_dup_ceiling: SERVER_SYNC_ASYNC_DUP_CEILING,
            server_sync_fs_ceiling: SERVER_SYNC_FS_CEILING,
            server_internal_value_ceiling: SERVER_INTERNAL_VALUE_CEILING,
            runtime_block_on_ceiling: RUNTIME_BLOCK_ON_CEILING,
            runtime_os_thread_ceiling: RUNTIME_OS_THREAD_CEILING,
            mac_block_on_ceiling: MAC_BLOCK_ON_CEILING,
            mac_os_thread_ceiling: MAC_OS_THREAD_CEILING,
            raw_git_command_ceiling: RAW_GIT_COMMAND_CEILING,
            server_sync_process_ceiling: SERVER_SYNC_PROCESS_CEILING,
            blocking_reqwest_ceiling: BLOCKING_REQWEST_CEILING,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ArchAuditReport {
    pub files_scanned: usize,
    pub violations: Vec<ArchViolation>,
    pub violations_by_rule: BTreeMap<String, Vec<ArchViolation>>,
    pub counts_by_rule: BTreeMap<String, usize>,
    pub flume_count: usize,
    pub flume_ceiling: usize,
    pub runtime_flume_count: usize,
    pub runtime_flume_ceiling: usize,
    pub sync_async_dup_count: usize,
    pub sync_async_dup_ceiling: usize,
    pub server_sync_fs_count: usize,
    pub server_sync_fs_ceiling: usize,
    pub server_internal_value_count: usize,
    pub server_internal_value_ceiling: usize,
    pub runtime_block_on_count: usize,
    pub runtime_block_on_ceiling: usize,
    pub runtime_os_thread_count: usize,
    pub runtime_os_thread_ceiling: usize,
    pub mac_block_on_count: usize,
    pub mac_block_on_ceiling: usize,
    pub mac_os_thread_count: usize,
    pub mac_os_thread_ceiling: usize,
    pub raw_git_command_count: usize,
    pub raw_git_command_ceiling: usize,
    pub server_sync_process_count: usize,
    pub server_sync_process_ceiling: usize,
    pub blocking_reqwest_count: usize,
    pub blocking_reqwest_ceiling: usize,
    pub app_rs_non_test_lines: Option<usize>,
    pub router_rs_non_test_lines: Option<usize>,
    pub lock_inventory: Vec<DomainLockInventory>,
    pub total_mutex_count: usize,
    pub total_rwlock_count: usize,
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
    offset: usize,
}

#[derive(Debug, Clone)]
struct PathRef {
    segments: Vec<String>,
    offset: usize,
    inline_mods: Vec<String>,
}

#[derive(Debug, Clone)]
struct CodeSite {
    file: String,
    line: usize,
    snippet: String,
}

#[derive(Debug, Clone)]
struct SyncAsyncDupSite {
    file: String,
    sync_name: String,
    sync_line: usize,
    async_line: usize,
}

#[derive(Debug, Clone)]
struct InternalValueSigSite {
    file: String,
    line: usize,
    fn_name: String,
    snippet: String,
}

type ModuleGraph = BTreeMap<String, BTreeMap<String, Vec<CodeSite>>>;

fn is_snake_case_module_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    let Some(&first) = bytes.first() else {
        return false;
    };
    first.is_ascii_lowercase() && bytes[1..].iter().all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
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
            tokens.push(Token {
                kind: TokenKind::Ident,
                text: code[start..i].to_owned(),
                offset: start,
            });
            continue;
        }
        if b == b':' && bytes.get(i + 1) == Some(&b':') {
            tokens.push(Token {
                kind: TokenKind::Punct,
                text: "::".to_owned(),
                offset: i,
            });
            i += 2;
            continue;
        }
        let ch = code[i..].chars().next().expect("valid UTF-8 at token boundary");
        tokens.push(Token {
            kind: TokenKind::Punct,
            text: ch.to_string(),
            offset: i,
        });
        i += ch.len_utf8();
    }

    tokens
}

fn parse_use_tree(tokens: &[Token], start_index: usize, prefix: &[String], inline_mods: &[String], out: &mut Vec<PathRef>) -> usize {
    let mut i = start_index;
    let mut segments = prefix.to_vec();
    let mut first_offset: Option<usize> = None;

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
                offset: first_offset.unwrap_or(tok.offset),
                inline_mods: inline_mods.to_vec(),
            });
            return i + 1;
        }

        if tok.kind == TokenKind::Ident {
            first_offset.get_or_insert(tok.offset);
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
                    offset: first_offset.unwrap_or(tok.offset),
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

        let start_offset = tok.offset;
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

fn is_dag_ignored_module(name: &str) -> bool {
    DAG_IGNORED_BASE_MODULES.contains(&name) || DAG_ROOT_MODULES.contains(&name)
}

fn skip_visibility_parens(tokens: &[Token], mut idx: usize) -> usize {
    if tokens.get(idx).is_some_and(|t| t.text == "(") {
        let mut depth = 0usize;
        while idx < tokens.len() {
            if tokens[idx].text == "(" {
                depth += 1;
            } else if tokens[idx].text == ")" {
                depth = depth.saturating_sub(1);
                idx += 1;
                if depth == 0 {
                    break;
                }
                continue;
            }
            idx += 1;
        }
    }
    idx
}

fn is_pub_or_pub_crate_visibility(tokens: &[Token], pub_idx: usize) -> Option<usize> {
    if tokens.get(pub_idx + 1).is_some_and(|t| t.text == "(") {
        if tokens.get(pub_idx + 2).is_some_and(|t| t.kind == TokenKind::Ident && t.text == "crate") && tokens.get(pub_idx + 3).is_some_and(|t| t.text == ")") {
            return Some(pub_idx + 4);
        }
        return None;
    }
    Some(pub_idx + 1)
}

fn is_gateway_import_allowed_file(rel: &str) -> bool {
    rel == "gateway.rs" || rel.starts_with("gateway/") || GATEWAY_ALLOWED_ROOT_FILES.contains(&rel)
}

fn is_sea_orm_allowed_file(rel: &str) -> bool {
    rel == "db.rs" || rel.starts_with("db/") || rel == "service.rs" || rel.starts_with("service/")
}

fn is_server_fake_rel(rel: &str) -> bool {
    rel == "fake.rs" || rel.starts_with("fake/") || rel == "gateway/bridge/fake.rs"
}

fn is_raw_git_exempt_file(path: &str) -> bool {
    path.starts_with("crates/git/src/") || path.starts_with("crates/runtime/src/bin/") || path.contains("/fake/") || path.ends_with("/fake.rs")
}

fn is_blocking_reqwest_exempt_file(path: &str) -> bool {
    path.starts_with("crates/runtime/src/bin/")
}

fn is_internal_value_sig_exempt_file(rel: &str) -> bool {
    rel == "router.rs" || is_server_fake_rel(rel) || rel == "gateway/api.rs" || rel.starts_with("gateway/api/")
}

fn check_no_gateway_reverse_import(file_path: &str, rel: &str, file_mod_path: &[String], refs: &[PathRef], index: &LineIndex, out: &mut Vec<ArchViolation>) {
    if is_gateway_import_allowed_file(rel) {
        return;
    }
    let mut seen_line = BTreeSet::new();
    for path_ref in refs {
        let Some(resolved) = resolve_crate_relative_segments(path_ref, file_mod_path) else {
            continue;
        };
        if resolved.first().is_some_and(|s| s == "gateway") {
            let line = index.line_at(path_ref.offset);
            if seen_line.insert(line) {
                out.push(ArchViolation {
                    rule: ArchAuditRule::NoGatewayReverseImport,
                    file: file_path.to_owned(),
                    line,
                    message: format!("reverse import of `crate::gateway` outside gateway/entry layer ({})", index.snippet_at(line)),
                    fix: "Keep `gateway/` strictly as an outer adapter; move shared contracts or port traits down to domain or `context` modules instead of importing `crate::gateway`.".to_owned(),
                    see: ARCH_DOC,
                    details: Vec::new(),
                });
            }
        }
    }
}

fn check_no_sea_orm_outside_service(
    file_path: &str,
    rel: &str,
    file_mod_path: &[String],
    tokens: &[Token],
    refs: &[PathRef],
    index: &LineIndex,
    out: &mut Vec<ArchViolation>,
) {
    if is_sea_orm_allowed_file(rel) {
        return;
    }
    let mut seen_line = BTreeSet::new();

    for tok in tokens {
        if tok.kind == TokenKind::Ident && tok.text == "sea_orm" {
            let line = index.line_at(tok.offset);
            if seen_line.insert(line) {
                out.push(ArchViolation {
                    rule: ArchAuditRule::NoSeaOrmOutsideService,
                    file: file_path.to_owned(),
                    line,
                    message: format!("`sea_orm` referenced outside `db/` and `service/` ({})", index.snippet_at(line)),
                    fix: "Encapsulate SeaORM queries and entity access inside `crates/server/src/service/` or `crates/server/src/db/` and expose typed domain service methods.".to_owned(),
                    see: MODULE_DESIGN_DOC,
                    details: Vec::new(),
                });
            }
        }
    }

    for path_ref in refs {
        let Some(resolved) = resolve_crate_relative_segments(path_ref, file_mod_path) else {
            continue;
        };
        if resolved.first().is_some_and(|s| s == "db") && resolved.get(1).is_some_and(|s| s == "entity") {
            let line = index.line_at(path_ref.offset);
            if seen_line.insert(line) {
                out.push(ArchViolation {
                    rule: ArchAuditRule::NoSeaOrmOutsideService,
                    file: file_path.to_owned(),
                    line,
                    message: format!("`crate::db::entity` referenced outside `db/` and `service/` ({})", index.snippet_at(line)),
                    fix: "Route database entity reads and writes through `crates/server/src/service/` instead of importing `crate::db::entity` directly."
                        .to_owned(),
                    see: MODULE_DESIGN_DOC,
                    details: Vec::new(),
                });
            }
        }
    }
}

fn strip_rust_comments_preserving_strings(source: &str) -> String {
    let bytes = source.as_bytes();
    let len = bytes.len();
    let mut out = Vec::with_capacity(len);
    let mut i = 0usize;

    while i < len {
        let ch = bytes[i];
        let next = bytes.get(i + 1).copied();

        if ch == b'/' && next == Some(b'/') {
            i += 2;
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if ch == b'/' && next == Some(b'*') {
            i += 2;
            let mut depth = 1usize;
            while i < len && depth > 0 {
                if bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'*') {
                    depth += 1;
                    i += 2;
                } else if bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/') {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            out.push(b' ');
            continue;
        }
        if ch == b'"' {
            out.push(b'"');
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
                if b == b'"' {
                    break;
                }
            }
            continue;
        }
        out.push(ch);
        i += 1;
    }

    String::from_utf8(out).expect("comment stripper preserves valid UTF-8")
}

fn parse_rust_string_literal(raw: &str) -> Option<&str> {
    let trimmed = raw.trim();
    if let Some(inner) = trimmed.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
        return (!inner.contains('"')).then_some(inner);
    }
    if let Some(after_r) = trimmed.strip_prefix('r') {
        let hashes = after_r.bytes().take_while(|&b| b == b'#').count();
        let after_hashes = &after_r[hashes..];
        if let Some(rest) = after_hashes.strip_prefix('"') {
            let suffix = format!("\"{}", "#".repeat(hashes));
            if let Some(inner) = rest.strip_suffix(&suffix) {
                return Some(inner);
            }
        }
    }
    None
}

fn split_top_level_commas_respecting_strings(expr: &str) -> Vec<&str> {
    let bytes = expr.as_bytes();
    let mut parts = Vec::new();
    let mut depth = 0usize;
    let mut in_str = false;
    let mut start = 0usize;
    let mut i = 0usize;

    while i < bytes.len() {
        let b = bytes[i];
        if in_str {
            if b == b'\\' {
                i += 2;
                continue;
            }
            if b == b'"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        match b {
            b'"' => in_str = true,
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth = depth.saturating_sub(1),
            b',' if depth == 0 => {
                parts.push(expr[start..i].trim());
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }

    let tail = expr[start..].trim();
    if !tail.is_empty() {
        parts.push(tail);
    }
    parts
}

fn extract_sea_orm_table_names(raw: &str, non_test_code: &str, index: &LineIndex) -> Vec<(usize, String)> {
    let bytes = non_test_code.as_bytes();
    let len = bytes.len();
    let mut found = Vec::new();
    let mut i = 0usize;

    while i < len {
        if bytes[i] == b'#' && bytes.get(i + 1) == Some(&b'[') {
            let bracket_open = i + 1;
            let mut depth = 0usize;
            let mut close = None;
            for (k, &b) in bytes.iter().enumerate().skip(bracket_open) {
                if b == b'[' {
                    depth += 1;
                } else if b == b']' {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        close = Some(k);
                        break;
                    }
                }
            }
            let Some(bracket_close) = close else {
                break;
            };
            let raw_attr = strip_rust_comments_preserving_strings(&raw[bracket_open + 1..bracket_close]);
            let trimmed = raw_attr.trim();
            if let Some(after_name) = trimmed.strip_prefix("sea_orm") {
                let after_ws = after_name.trim_start();
                if let Some(inner) = after_ws.strip_prefix('(').and_then(|s| s.strip_suffix(')')) {
                    for arg in split_top_level_commas_respecting_strings(inner) {
                        if let Some(after_key) = arg.strip_prefix("table_name") {
                            let rest = after_key.trim_start();
                            if let Some(after_eq) = rest.strip_prefix('=')
                                && let Some(table_name) = parse_rust_string_literal(after_eq)
                            {
                                found.push((index.line_at(i), table_name.to_owned()));
                            }
                        }
                    }
                }
            }
            i = bracket_close + 1;
            continue;
        }
        i += 1;
    }

    found
}

fn check_one_table_one_entity_file(file: &SourceFile, rel: &str, non_test_code: &str, index: &LineIndex, out: &mut Vec<ArchViolation>) {
    let Some(entity_rel) = rel.strip_prefix("db/entity/") else {
        return;
    };
    if entity_rel.contains('/') || !entity_rel.ends_with(".rs") || entity_rel == "mod.rs" {
        return;
    }
    let stem = entity_rel.strip_suffix(".rs").expect("checked .rs suffix");
    let found = extract_sea_orm_table_names(&file.text, non_test_code, index);

    match found.as_slice() {
        [] => {
            out.push(ArchViolation {
                rule: ArchAuditRule::OneTableOneEntityFile,
                file: file.path.clone(),
                line: 1,
                message: format!("entity file `{}` declares no `#[sea_orm(table_name = \"{stem}\")]` attribute", file.path),
                fix: format!("Declare exactly one `#[sea_orm(table_name = \"{stem}\")]` model in `{}`.", file.path),
                see: MODULE_DESIGN_DOC,
                details: Vec::new(),
            });
        }
        [(line, actual)] if actual == stem => {
            let _ = line;
        }
        [(line, actual)] => {
            out.push(ArchViolation {
                rule: ArchAuditRule::OneTableOneEntityFile,
                file: file.path.clone(),
                line: *line,
                message: format!("`#[sea_orm(table_name = \"{actual}\")]` does not match entity file stem `{stem}`"),
                fix: format!(
                    "Rename the file to `crates/server/src/db/entity/{actual}.rs` or fix `table_name` to `\"{stem}\"` so each file maps 1:1 to its table."
                ),
                see: MODULE_DESIGN_DOC,
                details: Vec::new(),
            });
        }
        many => {
            let names: Vec<String> = many.iter().map(|(_, n)| format!("\"{n}\"")).collect();
            let details: Vec<String> = many
                .iter()
                .map(|(ln, n)| format!("{}:{ln}: #[sea_orm(table_name = \"{n}\")]", file.path))
                .collect();
            out.push(ArchViolation {
                rule: ArchAuditRule::OneTableOneEntityFile,
                file: file.path.clone(),
                line: many[1].0,
                message: format!(
                    "entity file `{}` declares {} tables ({}); expected exactly one `#[sea_orm(table_name = \"{stem}\")]`",
                    file.path,
                    many.len(),
                    names.join(", ")
                ),
                fix: "Split each SeaORM entity into its own `crates/server/src/db/entity/<table_name>.rs` file matching `table_name` 1:1.".to_owned(),
                see: MODULE_DESIGN_DOC,
                details,
            });
        }
    }
}

fn skip_turbofish(tokens: &[Token], mut idx: usize) -> usize {
    if tokens.get(idx).is_some_and(|t| t.text == "::") && tokens.get(idx + 1).is_some_and(|t| t.text == "<") {
        let mut depth = 0usize;
        idx += 1;
        while idx < tokens.len() {
            if tokens[idx].text == "<" {
                depth += 1;
            } else if tokens[idx].text == ">" {
                depth = depth.saturating_sub(1);
                idx += 1;
                if depth == 0 {
                    break;
                }
                continue;
            }
            idx += 1;
        }
    }
    idx
}

fn check_no_late_bind_hook(file_path: &str, tokens: &[Token], index: &LineIndex, out: &mut Vec<ArchViolation>) {
    let mut seen: BTreeSet<(usize, &str)> = BTreeSet::new();

    for i in 0..tokens.len() {
        let tok = &tokens[i];
        // Match `OnceLock<...SharedExecution>` (including qualified paths).
        if tok.kind == TokenKind::Ident && tok.text == "OnceLock" && tokens.get(i + 1).is_some_and(|t| t.text == "<") {
            let mut cursor = i + 2;
            let mut last_ident: Option<&str> = None;
            while let Some(cur) = tokens.get(cursor) {
                if cur.kind == TokenKind::Ident {
                    last_ident = Some(cur.text.as_str());
                    cursor += 1;
                    if tokens.get(cursor).is_some_and(|t| t.text == "::") {
                        cursor += 1;
                        continue;
                    }
                }
                break;
            }
            if last_ident == Some("SharedExecution") && tokens.get(cursor).is_some_and(|t| t.text == ">") {
                let line = index.line_at(tok.offset);
                if seen.insert((line, "OnceLock<SharedExecution>")) {
                    out.push(ArchViolation {
                        rule: ArchAuditRule::NoLateBindHook,
                        file: file_path.to_owned(),
                        line,
                        message: format!("late-bind hook `OnceLock<SharedExecution>` is forbidden ({})", index.snippet_at(line)),
                        fix: "Inject `SharedExecution` (or narrow domain services) eagerly at construction time in `crates/server/src/app.rs` instead of using `OnceLock<SharedExecution>`.".to_owned(),
                        see: ARCH_DOC,
                        details: Vec::new(),
                    });
                }
            }
        }

        // Match `.bind_server(`, `.guard_removal(`, `.set_remember(`, `.attach_orchestrator(`,
        // `.attach_remote_auth(`, `.attach_machine_bus(`.
        if tok.text == "."
            && let Some(method_tok) = tokens.get(i + 1)
            && method_tok.kind == TokenKind::Ident
            && let Some(&hook) = LATE_BIND_HOOK_METHODS.iter().find(|&&m| m == method_tok.text)
        {
            let call_idx = skip_turbofish(tokens, i + 2);
            if tokens.get(call_idx).is_some_and(|t| t.text == "(") {
                let line = index.line_at(method_tok.offset);
                if seen.insert((line, hook)) {
                    out.push(ArchViolation {
                        rule: ArchAuditRule::NoLateBindHook,
                        file: file_path.to_owned(),
                        line,
                        message: format!("late-bind hook `.{hook}(` is forbidden ({})", index.snippet_at(line)),
                        fix: "Wire dependencies eagerly through constructors in `crates/server/src/app.rs` instead of mutating or attaching hooks after construction.".to_owned(),
                        see: ARCH_DOC,
                        details: Vec::new(),
                    });
                }
            }
        }
    }
}

fn count_non_test_code_lines(non_test_code: &str) -> usize {
    non_test_code.split('\n').filter(|line| !line.trim().is_empty()).count()
}

fn mod_rs_ceiling_for(path: &str) -> usize {
    LEGACY_FAT_MOD_RS_CEILINGS
        .iter()
        .find_map(|&(entry, ceiling)| (entry == path).then_some(ceiling))
        .unwrap_or(MOD_RS_NON_TEST_LINE_CEILING)
}

fn check_thin_mod_rs(file_path: &str, non_test_code: &str, out: &mut Vec<ArchViolation>) {
    if file_path != "mod.rs" && !file_path.ends_with("/mod.rs") {
        return;
    }
    let count = count_non_test_code_lines(non_test_code);
    let ceiling = mod_rs_ceiling_for(file_path);
    if count > ceiling {
        out.push(ArchViolation {
            rule: ArchAuditRule::ThinModRs,
            file: file_path.to_owned(),
            line: 1,
            message: format!("`{file_path}` has {count} non-test code lines, exceeding shrink-only `mod.rs` ceiling {ceiling}"),
            fix: format!(
                "Keep `mod.rs` a thin module facade (<= {ceiling} non-test code lines) by moving cohesive implementation bodies into sibling modules and keeping essential leaf complexity in leaf `.rs` files."
            ),
            see: MODULE_DESIGN_DOC,
            details: Vec::new(),
        });
    }
}

fn collect_flume_sites(file_path: &str, tokens: &[Token], index: &LineIndex, out: &mut Vec<CodeSite>) {
    for i in 0..tokens.len() {
        if tokens[i].kind == TokenKind::Ident && tokens[i].text == "flume" && tokens.get(i + 1).is_some_and(|t| t.text == "::") {
            let line = index.line_at(tokens[i].offset);
            out.push(CodeSite {
                file: file_path.to_owned(),
                line,
                snippet: index.snippet_at(line).to_owned(),
            });
        }
    }
}

fn collect_sync_fs_sites(file_path: &str, tokens: &[Token], index: &LineIndex, out: &mut Vec<CodeSite>) {
    for i in 0..tokens.len() {
        if tokens[i].kind == TokenKind::Ident
            && tokens[i].text == "std"
            && tokens.get(i + 1).is_some_and(|t| t.text == "::")
            && tokens.get(i + 2).is_some_and(|t| t.kind == TokenKind::Ident && t.text == "fs")
            && tokens.get(i + 3).is_some_and(|t| t.text == "::")
        {
            let line = index.line_at(tokens[i].offset);
            out.push(CodeSite {
                file: file_path.to_owned(),
                line,
                snippet: index.snippet_at(line).to_owned(),
            });
        }
    }
}

fn collect_internal_value_sig_sites(file_path: &str, rel: &str, tokens: &[Token], index: &LineIndex, out: &mut Vec<InternalValueSigSite>) {
    if is_internal_value_sig_exempt_file(rel) {
        return;
    }

    let mut i = 0usize;
    while i < tokens.len() {
        if tokens[i].kind == TokenKind::Ident
            && tokens[i].text == "pub"
            && let Some(mut cursor) = is_pub_or_pub_crate_visibility(tokens, i)
        {
            while let Some(kw) = tokens.get(cursor) {
                if kw.kind == TokenKind::Ident && matches!(kw.text.as_str(), "async" | "const" | "unsafe" | "extern") {
                    cursor += 1;
                } else {
                    break;
                }
            }
            if tokens.get(cursor).is_some_and(|t| t.kind == TokenKind::Ident && t.text == "fn")
                && let Some(name_tok) = tokens.get(cursor + 1)
                && name_tok.kind == TokenKind::Ident
            {
                let sig_start = cursor + 2;
                let mut sig_end = sig_start;
                let mut paren_depth = 0usize;
                let mut bracket_depth = 0usize;
                while sig_end < tokens.len() {
                    let t = &tokens[sig_end];
                    match t.text.as_str() {
                        "(" => paren_depth += 1,
                        ")" => paren_depth = paren_depth.saturating_sub(1),
                        "[" => bracket_depth += 1,
                        "]" => bracket_depth = bracket_depth.saturating_sub(1),
                        "{" | ";" if paren_depth == 0 && bracket_depth == 0 => break,
                        _ => {}
                    }
                    sig_end += 1;
                }

                let mut has_json_value = false;
                for k in sig_start..sig_end {
                    if tokens[k].kind == TokenKind::Ident && tokens[k].text == "Value" {
                        let non_json_qualified = k >= 2
                            && tokens[k - 1].text == "::"
                            && tokens[k - 2].kind == TokenKind::Ident
                            && NON_JSON_VALUE_PREFIXES.contains(&tokens[k - 2].text.as_str());
                        if !non_json_qualified {
                            has_json_value = true;
                            break;
                        }
                    }
                }

                if has_json_value {
                    let line = index.line_at(name_tok.offset);
                    out.push(InternalValueSigSite {
                        file: file_path.to_owned(),
                        line,
                        fn_name: name_tok.text.clone(),
                        snippet: index.snippet_at(line).to_owned(),
                    });
                }

                i = sig_end;
                continue;
            }
        }
        i += 1;
    }
}

fn collect_block_on_sites(file_path: &str, tokens: &[Token], index: &LineIndex, out: &mut Vec<CodeSite>) {
    for i in 0..tokens.len() {
        if tokens[i].kind == TokenKind::Ident && tokens[i].text == "block_on" {
            // Skip `fn block_on(...)` definitions; count only `block_on(` call sites.
            if i > 0 && tokens[i - 1].kind == TokenKind::Ident && tokens[i - 1].text == "fn" {
                continue;
            }
            let call_idx = skip_turbofish(tokens, i + 1);
            if tokens.get(call_idx).is_some_and(|t| t.text == "(") {
                let line = index.line_at(tokens[i].offset);
                out.push(CodeSite {
                    file: file_path.to_owned(),
                    line,
                    snippet: index.snippet_at(line).to_owned(),
                });
            }
        }
    }
}

fn collect_os_thread_sites(file_path: &str, tokens: &[Token], index: &LineIndex, out: &mut Vec<CodeSite>) {
    for i in 0..tokens.len() {
        if tokens[i].kind == TokenKind::Ident
            && tokens[i].text == "thread"
            && tokens.get(i + 1).is_some_and(|t| t.text == "::")
            && tokens
                .get(i + 2)
                .is_some_and(|t| t.kind == TokenKind::Ident && matches!(t.text.as_str(), "spawn" | "Builder"))
        {
            let line = index.line_at(tokens[i].offset);
            out.push(CodeSite {
                file: file_path.to_owned(),
                line,
                snippet: index.snippet_at(line).to_owned(),
            });
        }
    }
}

fn collect_raw_git_command_sites(file_path: &str, raw_source: &str, tokens: &[Token], index: &LineIndex, out: &mut Vec<CodeSite>) {
    let mut seen_line = BTreeSet::new();
    for i in 0..tokens.len() {
        if tokens[i].kind == TokenKind::Ident
            && tokens[i].text == "Command"
            && tokens.get(i + 1).is_some_and(|t| t.text == "::")
            && tokens.get(i + 2).is_some_and(|t| t.kind == TokenKind::Ident && t.text == "new")
            && let Some(open_paren) = tokens.get(i + 3).filter(|t| t.text == "(")
            && let Some(close_paren) = tokens.get(i + 4).filter(|t| t.text == ")")
        {
            let raw_arg = &raw_source[open_paren.offset + 1..close_paren.offset];
            let cleaned_arg = strip_rust_comments_preserving_strings(raw_arg);
            if parse_rust_string_literal(&cleaned_arg) == Some("git") {
                let line = index.line_at(tokens[i].offset);
                if seen_line.insert(line) {
                    out.push(CodeSite {
                        file: file_path.to_owned(),
                        line,
                        snippet: index.snippet_at(line).to_owned(),
                    });
                }
            }
        }
    }
}

fn collect_server_sync_process_sites(file_path: &str, tokens: &[Token], refs: &[PathRef], index: &LineIndex, out: &mut Vec<CodeSite>) {
    let mut seen_line = BTreeSet::new();
    let mut imports_std_process_mod = false;

    for path_ref in refs {
        let segs = path_ref.segments.as_slice();
        if segs == ["std", "process"] {
            imports_std_process_mod = true;
            continue;
        }
        let is_sync_command_import = segs.len() >= 3 && segs[0] == "std" && segs[1] == "process" && (segs[2] == "Command" || segs[2] == "*");
        if is_sync_command_import {
            let line = index.line_at(path_ref.offset);
            if seen_line.insert(line) {
                out.push(CodeSite {
                    file: file_path.to_owned(),
                    line,
                    snippet: index.snippet_at(line).to_owned(),
                });
            }
        }
    }

    for i in 0..tokens.len() {
        let is_qualified = tokens[i].kind == TokenKind::Ident
            && tokens[i].text == "std"
            && tokens.get(i + 1).is_some_and(|t| t.text == "::")
            && tokens.get(i + 2).is_some_and(|t| t.kind == TokenKind::Ident && t.text == "process")
            && tokens.get(i + 3).is_some_and(|t| t.text == "::")
            && tokens.get(i + 4).is_some_and(|t| t.kind == TokenKind::Ident && t.text == "Command");
        let is_mod_qualified = imports_std_process_mod
            && tokens[i].kind == TokenKind::Ident
            && tokens[i].text == "process"
            && !tokens.get(i.saturating_sub(1)).is_some_and(|t| t.text == "::" && i >= 1)
            && tokens.get(i + 1).is_some_and(|t| t.text == "::")
            && tokens.get(i + 2).is_some_and(|t| t.kind == TokenKind::Ident && t.text == "Command");
        if is_qualified || is_mod_qualified {
            let line = index.line_at(tokens[i].offset);
            if seen_line.insert(line) {
                out.push(CodeSite {
                    file: file_path.to_owned(),
                    line,
                    snippet: index.snippet_at(line).to_owned(),
                });
            }
        }
    }
}

fn collect_blocking_reqwest_sites(file_path: &str, tokens: &[Token], refs: &[PathRef], index: &LineIndex, out: &mut Vec<CodeSite>) {
    let mut seen_line = BTreeSet::new();

    for path_ref in refs {
        let segs = &path_ref.segments;
        if segs.len() >= 2 && segs[0] == "reqwest" && segs[1] == "blocking" {
            let line = index.line_at(path_ref.offset);
            if seen_line.insert(line) {
                out.push(CodeSite {
                    file: file_path.to_owned(),
                    line,
                    snippet: index.snippet_at(line).to_owned(),
                });
            }
        }
    }

    for i in 0..tokens.len() {
        if tokens[i].kind == TokenKind::Ident
            && tokens[i].text == "reqwest"
            && tokens.get(i + 1).is_some_and(|t| t.text == "::")
            && tokens.get(i + 2).is_some_and(|t| t.kind == TokenKind::Ident && t.text == "blocking")
        {
            let line = index.line_at(tokens[i].offset);
            if seen_line.insert(line) {
                out.push(CodeSite {
                    file: file_path.to_owned(),
                    line,
                    snippet: index.snippet_at(line).to_owned(),
                });
            }
        }
    }
}

fn collect_sync_async_dup_sites(file_path: &str, tokens: &[Token], index: &LineIndex, out: &mut Vec<SyncAsyncDupSite>) {
    let mut sync_fns: BTreeMap<String, usize> = BTreeMap::new();
    let mut async_fns: BTreeMap<String, usize> = BTreeMap::new();

    let mut i = 0usize;
    while i < tokens.len() {
        if tokens[i].kind == TokenKind::Ident && tokens[i].text == "pub" {
            let mut cursor = skip_visibility_parens(tokens, i + 1);
            let mut is_async = false;
            while let Some(kw) = tokens.get(cursor) {
                if kw.kind != TokenKind::Ident {
                    break;
                }
                match kw.text.as_str() {
                    "async" => {
                        is_async = true;
                        cursor += 1;
                    }
                    "const" | "unsafe" => {
                        cursor += 1;
                    }
                    _ => break,
                }
            }
            if tokens.get(cursor).is_some_and(|t| t.kind == TokenKind::Ident && t.text == "fn")
                && let Some(name_tok) = tokens.get(cursor + 1)
                && name_tok.kind == TokenKind::Ident
            {
                let line = index.line_at(name_tok.offset);
                if is_async {
                    async_fns.entry(name_tok.text.clone()).or_insert(line);
                } else {
                    sync_fns.entry(name_tok.text.clone()).or_insert(line);
                }
                i = cursor + 2;
                continue;
            }
        }
        i += 1;
    }

    for (sync_name, sync_line) in sync_fns {
        let async_name = format!("{sync_name}_async");
        if let Some(&async_line) = async_fns.get(&async_name) {
            out.push(SyncAsyncDupSite {
                file: file_path.to_owned(),
                sync_name,
                sync_line,
                async_line,
            });
        }
    }
}

fn collect_lock_sites(file_path: &str, domain: &str, tokens: &[Token], index: &LineIndex, by_domain: &mut BTreeMap<String, DomainLockInventory>) {
    for i in 0..tokens.len() {
        if tokens[i].kind != TokenKind::Ident || tokens.get(i + 1).is_none_or(|t| t.text != "<") {
            continue;
        }
        let kind = match tokens[i].text.as_str() {
            "Mutex" => LockKind::Mutex,
            "RwLock" => LockKind::RwLock,
            _ => continue,
        };
        let line = index.line_at(tokens[i].offset);
        let entry = by_domain.entry(domain.to_owned()).or_insert_with(|| DomainLockInventory {
            domain: domain.to_owned(),
            mutex_count: 0,
            rwlock_count: 0,
            total: 0,
            sites: Vec::new(),
        });
        match kind {
            LockKind::Mutex => entry.mutex_count += 1,
            LockKind::RwLock => entry.rwlock_count += 1,
        }
        entry.total += 1;
        entry.sites.push(LockSite {
            kind,
            file: file_path.to_owned(),
            line,
            snippet: index.snippet_at(line).to_owned(),
        });
    }
}

fn check_legacy_items_in_file(file_path: &str, rel: &str, tokens: &[Token], index: &LineIndex, out: &mut Vec<ArchViolation>) {
    let mut seen_quote_port = BTreeSet::new();
    let mut seen_bridge_hub = BTreeSet::new();

    let mut i = 0usize;
    while i < tokens.len() {
        if tokens[i].kind == TokenKind::Ident && tokens[i].text == "pub" {
            let cursor = skip_visibility_parens(tokens, i + 1);
            if tokens.get(cursor).is_some_and(|t| t.kind == TokenKind::Ident && t.text == "trait")
                && let Some(name_tok) = tokens.get(cursor + 1)
                && name_tok.kind == TokenKind::Ident
                && name_tok.text == "ChannelQuotePort"
            {
                let line = index.line_at(name_tok.offset);
                if seen_quote_port.insert(line) {
                    out.push(ArchViolation {
                        rule: ArchAuditRule::NoLegacyServerLayout,
                        file: file_path.to_owned(),
                        line,
                        message: format!("legacy `pub trait ChannelQuotePort` is forbidden ({})", index.snippet_at(line)),
                        fix: "Delete `ChannelQuotePort` and read channel/quote data directly through the flat service layer.".to_owned(),
                        see: ARCH_DOC,
                        details: Vec::new(),
                    });
                }
                i = cursor + 2;
                continue;
            }
            if rel == "gateway/bridge/hub.rs"
                && tokens.get(cursor).is_some_and(|t| t.kind == TokenKind::Ident && t.text == "struct")
                && let Some(name_tok) = tokens.get(cursor + 1)
                && name_tok.kind == TokenKind::Ident
                && name_tok.text == "Hub"
            {
                let line = index.line_at(name_tok.offset);
                if seen_bridge_hub.insert(line) {
                    out.push(ArchViolation {
                        rule: ArchAuditRule::NoLegacyServerLayout,
                        file: file_path.to_owned(),
                        line,
                        message: format!("legacy `pub struct Hub` in `gateway/bridge/hub.rs` is forbidden ({})", index.snippet_at(line)),
                        fix: "Remove `gateway/bridge/hub.rs` `Hub` and route bridge calls directly through `App` and `router`.".to_owned(),
                        see: ARCH_DOC,
                        details: Vec::new(),
                    });
                }
                i = cursor + 2;
                continue;
            }
        }
        i += 1;
    }
}

fn find_strongly_connected_components(graph: &ModuleGraph) -> Vec<Vec<String>> {
    struct Tarjan<'a> {
        graph: &'a ModuleGraph,
        next_index: usize,
        index_map: BTreeMap<String, usize>,
        lowlink: BTreeMap<String, usize>,
        on_stack: BTreeSet<String>,
        stack: Vec<String>,
        sccs: Vec<Vec<String>>,
    }

    impl<'a> Tarjan<'a> {
        fn strong_connect(&mut self, v: &str) {
            let v_idx = self.next_index;
            self.index_map.insert(v.to_owned(), v_idx);
            self.lowlink.insert(v.to_owned(), v_idx);
            self.next_index += 1;
            self.stack.push(v.to_owned());
            self.on_stack.insert(v.to_owned());

            let neighbors: Vec<String> = self.graph.get(v).map(|m| m.keys().cloned().collect()).unwrap_or_default();
            for w in neighbors {
                if !self.index_map.contains_key(&w) {
                    self.strong_connect(&w);
                    let w_low = self.lowlink[&w];
                    let v_low = self.lowlink.get_mut(v).expect("v inserted");
                    *v_low = (*v_low).min(w_low);
                } else if self.on_stack.contains(&w) {
                    let w_idx = self.index_map[&w];
                    let v_low = self.lowlink.get_mut(v).expect("v inserted");
                    *v_low = (*v_low).min(w_idx);
                }
            }

            if self.lowlink[v] == self.index_map[v] {
                let mut scc = Vec::new();
                while let Some(w) = self.stack.pop() {
                    self.on_stack.remove(&w);
                    let done = w == v;
                    scc.push(w);
                    if done {
                        break;
                    }
                }
                if scc.len() >= 2 {
                    scc.sort();
                    self.sccs.push(scc);
                }
            }
        }
    }

    let mut tarjan = Tarjan {
        graph,
        next_index: 0,
        index_map: BTreeMap::new(),
        lowlink: BTreeMap::new(),
        on_stack: BTreeSet::new(),
        stack: Vec::new(),
        sccs: Vec::new(),
    };

    let nodes: Vec<String> = graph.keys().cloned().collect();
    for node in nodes {
        if !tarjan.index_map.contains_key(&node) {
            tarjan.strong_connect(&node);
        }
    }
    tarjan.sccs
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

fn extract_cycles_from_scc(scc: &[String], graph: &ModuleGraph) -> Vec<Vec<String>> {
    let in_scc: BTreeSet<&str> = scc.iter().map(String::as_str).collect();
    let mut seen = BTreeSet::new();
    let mut cycles = Vec::new();

    for start in scc {
        let mut prev: BTreeMap<String, String> = BTreeMap::new();
        let mut queue = VecDeque::new();
        let mut visited = BTreeSet::new();

        if let Some(edges) = graph.get(start) {
            for hop in edges.keys() {
                if in_scc.contains(hop.as_str()) {
                    prev.insert(hop.clone(), start.clone());
                    visited.insert(hop.clone());
                    queue.push_back(hop.clone());
                }
            }
        }

        let mut found = false;
        while let Some(curr) = queue.pop_front() {
            if found {
                break;
            }
            let Some(edges) = graph.get(&curr) else {
                continue;
            };
            for next in edges.keys() {
                if !in_scc.contains(next.as_str()) {
                    continue;
                }
                if next == start {
                    let mut path = vec![curr.clone()];
                    let mut p = prev.get(&curr);
                    while let Some(parent) = p
                        && parent != start
                    {
                        path.push(parent.clone());
                        p = prev.get(parent);
                    }
                    path.push(start.clone());
                    path.reverse();
                    let canonical = canonicalize_cycle(&path);
                    let key = canonical.join(" -> ");
                    if seen.insert(key) {
                        cycles.push(canonical);
                    }
                    found = true;
                    break;
                }
                if visited.insert(next.clone()) {
                    prev.insert(next.clone(), curr.clone());
                    queue.push_back(next.clone());
                }
            }
        }
    }

    cycles.sort_by_key(|a| a.join(" -> "));
    cycles
}

fn is_audited_rust_path(path: &str) -> bool {
    path.ends_with(".rs") && (path.starts_with("crates/") || path.starts_with("apps/mac/")) && path.contains("/src/")
}

fn push_ratchet_ceiling_violation(out: &mut Vec<ArchViolation>, rule: ArchAuditRule, sites: &[CodeSite], ceiling: usize, zone: &str, subject: &str, fix: &str) {
    if sites.len() > ceiling {
        let first = &sites[0];
        let see = if rule == ArchAuditRule::NoRawGitCommand { ARCH_DOC } else { CONCURRENCY_DOC };
        out.push(ArchViolation {
            rule,
            file: first.file.clone(),
            line: first.line,
            message: format!("`{zone}` has {} non-test {subject}, exceeding shrink-only ceiling {ceiling}", sites.len()),
            fix: fix.to_owned(),
            see,
            details: sites.iter().map(|s| format!("site: {}:{}: {}", s.file, s.line, s.snippet)).collect(),
        });
    }
}

fn run_arch_audit_on_files(files: &[SourceFile], existing_legacy_dirs: &BTreeSet<String>, config: ArchAuditConfig) -> ArchAuditReport {
    let mut sorted: Vec<SourceFile> = files
        .iter()
        .map(|f| SourceFile {
            path: f.path.replace('\\', "/"),
            text: f.text.clone(),
        })
        .filter(|f| is_audited_rust_path(&f.path))
        .collect();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));

    let mut known_top_level_modules: BTreeSet<String> = WELL_KNOWN_MODULES.iter().map(|&s| s.to_owned()).collect();
    let mut legacy_dirs_found: BTreeSet<String> = existing_legacy_dirs.clone();
    let mut excluded_targets = BTreeSet::new();
    let mut non_test_codes: BTreeMap<String, String> = BTreeMap::new();

    for file in &sorted {
        if let Some(rel) = server_rel_path(&file.path)
            && let Some((first_seg, _)) = rel.split_once('/')
            && LEGACY_SERVER_DIRS.contains(&first_seg)
        {
            legacy_dirs_found.insert(first_seg.to_owned());
        }
        if let Some(top) = top_level_module_of_server_file(&file.path) {
            known_top_level_modules.insert(top);
        }

        let no_comments = strip_rust_comments_and_literals(&file.text);
        let stripped = strip_cfg_test_and_collect_excluded(&file.text, &no_comments, &file.path);
        for target in stripped.excluded_submodules {
            excluded_targets.insert(target);
        }
        non_test_codes.insert(file.path.clone(), stripped.code);
    }

    let mut violations = Vec::new();
    let mut graph: ModuleGraph = BTreeMap::new();
    let mut flume_sites = Vec::new();
    let mut runtime_flume_sites = Vec::new();
    let mut sync_async_dup_sites = Vec::new();
    let mut server_sync_fs_sites = Vec::new();
    let mut server_internal_value_sites = Vec::new();
    let mut runtime_block_on_sites = Vec::new();
    let mut runtime_os_thread_sites = Vec::new();
    let mut mac_block_on_sites = Vec::new();
    let mut mac_os_thread_sites = Vec::new();
    let mut raw_git_command_sites = Vec::new();
    let mut server_sync_process_sites = Vec::new();
    let mut blocking_reqwest_sites = Vec::new();
    let mut locks_by_domain: BTreeMap<String, DomainLockInventory> = BTreeMap::new();
    let mut app_rs_non_test_lines = None;
    let mut router_rs_non_test_lines = None;

    for dir in &legacy_dirs_found {
        violations.push(ArchViolation {
            rule: ArchAuditRule::NoLegacyServerLayout,
            file: format!("crates/server/src/{dir}"),
            line: 1,
            message: format!("legacy nested server directory `crates/server/src/{dir}/` is forbidden"),
            fix: format!("Flatten `crates/server/src/{dir}/` into top-level domain/service/gateway modules and remove the legacy directory."),
            see: ARCH_DOC,
            details: Vec::new(),
        });
    }

    for file in &sorted {
        if is_excluded_by_cfg_test(&file.path, &excluded_targets) {
            continue;
        }
        let non_test_code = non_test_codes
            .get(&file.path)
            .map_or_else(|| strip_rust_non_code(&file.text, &file.path), Clone::clone);
        let index = LineIndex::new(&file.text);
        let tokens = tokenize_rust(&non_test_code);
        let refs = extract_path_refs(&tokens);

        if !is_raw_git_exempt_file(&file.path) {
            collect_raw_git_command_sites(&file.path, &file.text, &tokens, &index, &mut raw_git_command_sites);
        }
        if !is_blocking_reqwest_exempt_file(&file.path) {
            collect_blocking_reqwest_sites(&file.path, &tokens, &refs, &index, &mut blocking_reqwest_sites);
        }

        // Rule 15: thin-mod-rs (applies across crates/**/src/** and apps/mac/src/**)
        check_thin_mod_rs(&file.path, &non_test_code, &mut violations);

        if file.path.starts_with("crates/runtime/src/") {
            // Standalone test fixture binaries under `crates/runtime/src/bin/` are excluded from production runtime ceilings.
            if !file.path.starts_with("crates/runtime/src/bin/") {
                collect_flume_sites(&file.path, &tokens, &index, &mut runtime_flume_sites);
                // `crates/runtime/src/rt.rs` implements the `rt::block_on` boundary helper itself.
                if file.path != "crates/runtime/src/rt.rs" {
                    collect_block_on_sites(&file.path, &tokens, &index, &mut runtime_block_on_sites);
                }
                collect_os_thread_sites(&file.path, &tokens, &index, &mut runtime_os_thread_sites);
            }
            continue;
        }
        if file.path.starts_with("apps/mac/src/") || file.path.starts_with("apps/mac/crates/workspace/src/") {
            collect_block_on_sites(&file.path, &tokens, &index, &mut mac_block_on_sites);
            collect_os_thread_sites(&file.path, &tokens, &index, &mut mac_os_thread_sites);
            continue;
        }

        let Some(rel) = server_rel_path(&file.path) else {
            continue;
        };
        let Some(file_mod_path) = server_file_module_path(&file.path) else {
            continue;
        };

        // Rule 1: no-gateway-reverse-import
        check_no_gateway_reverse_import(&file.path, rel, &file_mod_path, &refs, &index, &mut violations);

        // Rule 3: no-sea-orm-outside-service
        check_no_sea_orm_outside_service(&file.path, rel, &file_mod_path, &tokens, &refs, &index, &mut violations);

        // Rule 4: one-table-one-entity-file
        check_one_table_one_entity_file(file, rel, &non_test_code, &index, &mut violations);

        // Rule 5: no-late-bind-hook
        check_no_late_bind_hook(&file.path, &tokens, &index, &mut violations);

        // Rule 6: thin-app-and-router
        if rel == "app.rs" {
            let count = count_non_test_code_lines(&non_test_code);
            app_rs_non_test_lines = Some(count);
            if count > config.app_rs_line_ceiling {
                violations.push(ArchViolation {
                    rule: ArchAuditRule::ThinAppAndRouter,
                    file: file.path.clone(),
                    line: 1,
                    message: format!(
                        "`crates/server/src/app.rs` has {count} non-test code lines, exceeding ceiling {}",
                        config.app_rs_line_ceiling
                    ),
                    fix: format!(
                        "Keep `app.rs` a thin composition root (<= {} non-test code lines) by pushing domain logic into top-level modules and services.",
                        config.app_rs_line_ceiling
                    ),
                    see: ARCH_DOC,
                    details: Vec::new(),
                });
            }
        } else if rel == "router.rs" {
            let count = count_non_test_code_lines(&non_test_code);
            router_rs_non_test_lines = Some(count);
            if count > config.router_rs_line_ceiling {
                violations.push(ArchViolation {
                    rule: ArchAuditRule::ThinAppAndRouter,
                    file: file.path.clone(),
                    line: 1,
                    message: format!(
                        "`crates/server/src/router.rs` has {count} non-test code lines, exceeding ceiling {}",
                        config.router_rs_line_ceiling
                    ),
                    fix: format!(
                        "Keep `router.rs` a thin dispatch table (<= {} non-test code lines) by delegating request handling to domain modules.",
                        config.router_rs_line_ceiling
                    ),
                    see: ARCH_DOC,
                    details: Vec::new(),
                });
            }
        } else if let Some(ceiling) = match rel {
            "boot.rs" => Some(BOOT_RS_NON_TEST_LINE_CEILING),
            "projection.rs" => Some(PROJECTION_RS_NON_TEST_LINE_CEILING),
            "router/glue.rs" => Some(ROUTER_GLUE_RS_NON_TEST_LINE_CEILING),
            _ => None,
        } {
            let count = count_non_test_code_lines(&non_test_code);
            if count > ceiling {
                violations.push(ArchViolation {
                    rule: ArchAuditRule::ThinAppAndRouter,
                    file: file.path.clone(),
                    line: 1,
                    message: format!("`crates/server/src/{rel}` has {count} non-test code lines, exceeding ceiling {ceiling}"),
                    fix: format!("Keep `{rel}` thin (<= {ceiling} non-test code lines) by delegating domain logic to domain modules."),
                    see: ARCH_DOC,
                    details: Vec::new(),
                });
            }
        }

        // Rule 7 inputs: flume, sync/async duplicates, and lock inventory
        collect_flume_sites(&file.path, &tokens, &index, &mut flume_sites);
        collect_sync_async_dup_sites(&file.path, &tokens, &index, &mut sync_async_dup_sites);

        // Rule 8 file-level checks: ChannelQuotePort & gateway/bridge/hub.rs Hub
        check_legacy_items_in_file(&file.path, rel, &tokens, &index, &mut violations);

        // Rule 9 input: std::fs:: calls in server (excluding `fake/` test-runtime sync fixture)
        if !is_server_fake_rel(rel) {
            collect_sync_fs_sites(&file.path, &tokens, &index, &mut server_sync_fs_sites);
            collect_server_sync_process_sites(&file.path, &tokens, &refs, &index, &mut server_sync_process_sites);
        }

        // Rule 10 input: pub / pub(crate) fn signatures using serde_json::Value / Value
        collect_internal_value_sig_sites(&file.path, rel, &tokens, &index, &mut server_internal_value_sites);

        let Some(source_mod) = top_level_module_of_server_file(&file.path) else {
            continue;
        };
        collect_lock_sites(&file.path, &source_mod, &tokens, &index, &mut locks_by_domain);

        // Rule 2: server-domain-dag
        if !is_dag_ignored_module(&source_mod) {
            graph.entry(source_mod.clone()).or_default();
        }
        let mut seen_edge_on_line = BTreeSet::new();
        for path_ref in &refs {
            let Some(resolved) = resolve_crate_relative_segments(path_ref, &file_mod_path) else {
                continue;
            };
            let Some(target_mod) = resolved.first() else {
                continue;
            };
            if !is_snake_case_module_name(target_mod) {
                continue;
            }
            if resolved.len() < 2 && !known_top_level_modules.contains(target_mod) {
                continue;
            }
            if target_mod == &source_mod {
                continue;
            }

            let line = index.line_at(path_ref.offset);
            let dedup_key = format!("{target_mod}:{line}");
            if !seen_edge_on_line.insert(dedup_key) {
                continue;
            }
            let snippet = index.snippet_at(line).to_owned();

            // Hard edge bans
            if source_mod == "runtime" && RUNTIME_FORBIDDEN_TARGETS.contains(&target_mod.as_str()) {
                violations.push(ArchViolation {
                    rule: ArchAuditRule::ServerDomainDag,
                    file: file.path.clone(),
                    line,
                    message: format!("`runtime` depends on forbidden module `{target_mod}` ({snippet})"),
                    fix: "Keep `runtime` independent of `{agent, issue, cron}` by inverting orchestration or passing narrow inputs from callers.".to_owned(),
                    see: ARCH_DOC,
                    details: Vec::new(),
                });
            } else if source_mod == "service" && !SERVICE_ALLOWED_TARGETS.contains(&target_mod.as_str()) {
                violations.push(ArchViolation {
                    rule: ArchAuditRule::ServerDomainDag,
                    file: file.path.clone(),
                    line,
                    message: format!("`service` depends on forbidden module `{target_mod}` ({snippet})"),
                    fix: "Keep `service` strictly below business domains; `service` may only depend on `{db, context, log}`.".to_owned(),
                    see: ARCH_DOC,
                    details: Vec::new(),
                });
            } else if source_mod == "game" && !GAME_ALLOWED_TARGETS.contains(&target_mod.as_str()) {
                violations.push(ArchViolation {
                    rule: ArchAuditRule::ServerDomainDag,
                    file: file.path.clone(),
                    line,
                    message: format!("`game` depends on forbidden module `{target_mod}` ({snippet})"),
                    fix: "Keep `game` a thin projection skin depending only on `{context, repo}`.".to_owned(),
                    see: ARCH_DOC,
                    details: Vec::new(),
                });
            }

            if !is_dag_ignored_module(&source_mod) && !is_dag_ignored_module(target_mod) {
                graph
                    .entry(source_mod.clone())
                    .or_default()
                    .entry(target_mod.clone())
                    .or_default()
                    .push(CodeSite {
                        file: file.path.clone(),
                        line,
                        snippet,
                    });
                graph.entry(target_mod.clone()).or_default();
            }
        }
    }

    // Rule 2: Tarjan's SCC cycle detection
    for scc in find_strongly_connected_components(&graph) {
        for cycle in extract_cycles_from_scc(&scc, &graph) {
            let mut hops = Vec::with_capacity(cycle.len());
            let mut primary_file = "crates/server/src/lib.rs".to_owned();
            let mut primary_line = 1usize;
            for i in 0..cycle.len() {
                let from = &cycle[i];
                let to = &cycle[(i + 1) % cycle.len()];
                let occ = graph.get(from).and_then(|m| m.get(to)).and_then(|v| v.first());
                if i == 0
                    && let Some(first) = occ
                {
                    primary_file = first.file.clone();
                    primary_line = first.line;
                }
                let where_str = occ.map_or_else(|| "<unknown>".to_owned(), |o| format!("{}:{}: {}", o.file, o.line, o.snippet));
                hops.push(format!("edge: {from} -> {to} ({where_str})"));
            }
            let cycle_label = format!("{} -> {}", cycle.join(" -> "), cycle[0]);
            violations.push(ArchViolation {
                rule: ArchAuditRule::ServerDomainDag,
                file: primary_file,
                line: primary_line,
                message: format!("directed cycle in server top-level modules: {cycle_label}"),
                fix: "Break the module cycle by moving shared persistence into `service/` or shared contracts into `context/` so top-level domains form a strict DAG.".to_owned(),
                see: ARCH_DOC,
                details: hops,
            });
        }
    }

    // Rule 7: concurrency-and-async-ratchets
    push_ratchet_ceiling_violation(
        &mut violations,
        ArchAuditRule::ConcurrencyAndAsyncRatchets,
        &flume_sites,
        config.flume_ceiling,
        "crates/server/src/",
        "`flume::` reference(s)",
        "Replace `flume::` channels in `crates/server/src/` with `tokio::sync` channels (`mpsc`, `broadcast`, `oneshot`, `watch`).",
    );
    push_ratchet_ceiling_violation(
        &mut violations,
        ArchAuditRule::ConcurrencyAndAsyncRatchets,
        &runtime_flume_sites,
        config.runtime_flume_ceiling,
        "crates/runtime/src/",
        "`flume::` reference(s)",
        "Replace `flume::` channels in `crates/runtime/src/` with `tokio::sync` channels (`mpsc`, `broadcast`, `oneshot`, `watch`).",
    );

    if sync_async_dup_sites.len() > config.sync_async_dup_ceiling {
        let first = &sync_async_dup_sites[0];
        violations.push(ArchViolation {
            rule: ArchAuditRule::ConcurrencyAndAsyncRatchets,
            file: first.file.clone(),
            line: first.async_line,
            message: format!(
                "`crates/server/src/` has {} same-file `pub fn <name>` + `pub async fn <name>_async` duplicate pair(s), exceeding shrink-only ceiling {}",
                sync_async_dup_sites.len(),
                config.sync_async_dup_ceiling
            ),
            fix: "Delete the sync wrapper `pub fn <name>` and keep a single native `pub async fn <name>` API.".to_owned(),
            see: CONCURRENCY_DOC,
            details: sync_async_dup_sites
                .iter()
                .map(|s| {
                    format!(
                        "pair: {}:{}/{} (`pub fn {}` + `pub async fn {}_async`)",
                        s.file, s.sync_line, s.async_line, s.sync_name, s.sync_name
                    )
                })
                .collect(),
        });
    }

    // Rule 9: no-sync-fs-in-server
    push_ratchet_ceiling_violation(
        &mut violations,
        ArchAuditRule::NoSyncFsInServer,
        &server_sync_fs_sites,
        config.server_sync_fs_ceiling,
        "crates/server/src/",
        "`std::fs::` call(s)",
        "Replace blocking `std::fs::` calls on the Tokio runtime with `tokio::fs` (or offload heavy filesystem work via `tokio::task::spawn_blocking`).",
    );

    // Rule 10: no-value-in-internal-sig
    if server_internal_value_sites.len() > config.server_internal_value_ceiling {
        let first = &server_internal_value_sites[0];
        violations.push(ArchViolation {
            rule: ArchAuditRule::NoValueInInternalSig,
            file: first.file.clone(),
            line: first.line,
            message: format!(
                "`crates/server/src/` has {} non-test `pub`/`pub(crate)` fn signature(s) containing `serde_json::Value` / `Value`, exceeding shrink-only ceiling {}",
                server_internal_value_sites.len(),
                config.server_internal_value_ceiling
            ),
            fix: "Decode JSON once at the gateway/router boundary and pass typed structs/enums (e.g. `OutboxEvent`) inside `crates/server/src/`.".to_owned(),
            see: MODULE_DESIGN_DOC,
            details: server_internal_value_sites
                .iter()
                .map(|s| format!("sig: {}:{}: fn `{}` ({})", s.file, s.line, s.fn_name, s.snippet))
                .collect(),
        });
    }

    // Rule 11: runtime-and-mac-concurrency-ceilings
    push_ratchet_ceiling_violation(
        &mut violations,
        ArchAuditRule::RuntimeAndMacConcurrencyCeilings,
        &runtime_block_on_sites,
        config.runtime_block_on_ceiling,
        "crates/runtime/src/",
        "`block_on(` call(s)",
        "Keep `crates/runtime/src/` async-native instead of adding new `block_on(` bridges; lower `RUNTIME_BLOCK_ON_CEILING` as existing sites migrate.",
    );
    push_ratchet_ceiling_violation(
        &mut violations,
        ArchAuditRule::RuntimeAndMacConcurrencyCeilings,
        &runtime_os_thread_sites,
        config.runtime_os_thread_ceiling,
        "crates/runtime/src/",
        "`thread::spawn` / `std::thread::Builder` site(s)",
        "Use `tokio::spawn` / `tokio::task::spawn_blocking` instead of spawning raw OS threads in `crates/runtime/src/`; lower `RUNTIME_OS_THREAD_CEILING` as existing sites migrate.",
    );
    push_ratchet_ceiling_violation(
        &mut violations,
        ArchAuditRule::RuntimeAndMacConcurrencyCeilings,
        &mac_block_on_sites,
        config.mac_block_on_ceiling,
        "apps/mac/src/",
        "`block_on(` call(s)",
        "Use async `cx.spawn` or async `Server` calls instead of adding new `block_on(` calls in `apps/mac/src/`; lower `MAC_BLOCK_ON_CEILING` as existing sites migrate.",
    );
    push_ratchet_ceiling_violation(
        &mut violations,
        ArchAuditRule::RuntimeAndMacConcurrencyCeilings,
        &mac_os_thread_sites,
        config.mac_os_thread_ceiling,
        "apps/mac/src/",
        "`thread::spawn` / `std::thread::Builder` site(s)",
        "Use `cx.background_executor()` or Tokio tasks instead of spawning new OS threads in `apps/mac/src/`; lower `MAC_OS_THREAD_CEILING` as existing sites migrate.",
    );

    // Rule 12: no-raw-git-command
    push_ratchet_ceiling_violation(
        &mut violations,
        ArchAuditRule::NoRawGitCommand,
        &raw_git_command_sites,
        config.raw_git_command_ceiling,
        "workspace production source",
        "raw `Command::new(\"git\")` site(s)",
        "Route git reads and commands through `vibevalley_git` (`crates/git/src/read.rs` and `Repo` async methods) instead of spawning raw `Command::new(\"git\")`.",
    );

    // Rule 13: no-sync-process-in-server
    push_ratchet_ceiling_violation(
        &mut violations,
        ArchAuditRule::NoSyncProcessInServer,
        &server_sync_process_sites,
        config.server_sync_process_ceiling,
        "crates/server/src/",
        "`std::process::Command` reference(s)",
        "Replace blocking `std::process::Command` in `crates/server/src/` with `tokio::process::Command` or `vibevalley_git` async APIs.",
    );

    // Rule 14: no-blocking-reqwest
    push_ratchet_ceiling_violation(
        &mut violations,
        ArchAuditRule::NoBlockingReqwest,
        &blocking_reqwest_sites,
        config.blocking_reqwest_ceiling,
        "workspace production source",
        "`reqwest::blocking` reference(s)",
        "Use async `reqwest::Client` on the Tokio runtime instead of `reqwest::blocking`.",
    );

    violations.sort_by(|a, b| {
        a.rule
            .cmp(&b.rule)
            .then_with(|| a.file.cmp(&b.file))
            .then_with(|| a.line.cmp(&b.line))
            .then_with(|| a.message.cmp(&b.message))
    });

    let mut violations_by_rule: BTreeMap<String, Vec<ArchViolation>> = BTreeMap::new();
    let mut counts_by_rule: BTreeMap<String, usize> = BTreeMap::new();
    for rule in ArchAuditRule::ALL {
        violations_by_rule.insert(rule.as_str().to_owned(), Vec::new());
        counts_by_rule.insert(rule.as_str().to_owned(), 0);
    }
    for v in &violations {
        let key = v.rule.as_str().to_owned();
        violations_by_rule.entry(key.clone()).or_default().push(v.clone());
        *counts_by_rule.entry(key).or_insert(0) += 1;
    }

    let lock_inventory: Vec<DomainLockInventory> = locks_by_domain.into_values().collect();
    let total_mutex_count = lock_inventory.iter().map(|d| d.mutex_count).sum();
    let total_rwlock_count = lock_inventory.iter().map(|d| d.rwlock_count).sum();

    ArchAuditReport {
        files_scanned: sorted.len(),
        violations,
        violations_by_rule,
        counts_by_rule,
        flume_count: flume_sites.len(),
        flume_ceiling: config.flume_ceiling,
        runtime_flume_count: runtime_flume_sites.len(),
        runtime_flume_ceiling: config.runtime_flume_ceiling,
        sync_async_dup_count: sync_async_dup_sites.len(),
        sync_async_dup_ceiling: config.sync_async_dup_ceiling,
        server_sync_fs_count: server_sync_fs_sites.len(),
        server_sync_fs_ceiling: config.server_sync_fs_ceiling,
        server_internal_value_count: server_internal_value_sites.len(),
        server_internal_value_ceiling: config.server_internal_value_ceiling,
        runtime_block_on_count: runtime_block_on_sites.len(),
        runtime_block_on_ceiling: config.runtime_block_on_ceiling,
        runtime_os_thread_count: runtime_os_thread_sites.len(),
        runtime_os_thread_ceiling: config.runtime_os_thread_ceiling,
        mac_block_on_count: mac_block_on_sites.len(),
        mac_block_on_ceiling: config.mac_block_on_ceiling,
        mac_os_thread_count: mac_os_thread_sites.len(),
        mac_os_thread_ceiling: config.mac_os_thread_ceiling,
        raw_git_command_count: raw_git_command_sites.len(),
        raw_git_command_ceiling: config.raw_git_command_ceiling,
        server_sync_process_count: server_sync_process_sites.len(),
        server_sync_process_ceiling: config.server_sync_process_ceiling,
        blocking_reqwest_count: blocking_reqwest_sites.len(),
        blocking_reqwest_ceiling: config.blocking_reqwest_ceiling,
        app_rs_non_test_lines,
        router_rs_non_test_lines,
        lock_inventory,
        total_mutex_count,
        total_rwlock_count,
    }
}

fn collect_existing_legacy_dirs(repo_root: &Path) -> BTreeSet<String> {
    let server_src = repo_root.join("crates/server/src");
    let mut found = BTreeSet::new();
    for &dir in LEGACY_SERVER_DIRS {
        if server_src.join(dir).is_dir() {
            found.insert(dir.to_owned());
        }
    }
    found
}

pub fn audit_server_architecture_with_config(repo_root: &Path, config: ArchAuditConfig) -> Result<ArchAuditReport, String> {
    let files = walk_matching_files(repo_root, &["crates", "apps/mac"], is_audited_rust_path)?;
    let existing_legacy_dirs = collect_existing_legacy_dirs(repo_root);
    Ok(run_arch_audit_on_files(&files, &existing_legacy_dirs, config))
}

/// Runs all 15 deterministic architecture & full-stack concurrency rules and returns
/// the full structured report (per-rule violation lists, counts, ratchet metrics, and lock inventory).
pub fn audit_server_architecture_report(repo_root: &Path) -> Result<ArchAuditReport, String> {
    audit_server_architecture_with_config(repo_root, ArchAuditConfig::strict())
}

/// Strict architecture gate (all 15 rules using exported shrink-only ceilings).
pub fn audit_server_architecture_strict(repo_root: &Path) -> Result<ArchAuditReport, String> {
    audit_server_architecture_with_config(repo_root, ArchAuditConfig::strict())
}

pub fn format_violations(violations: &[ArchViolation]) -> String {
    let mut lines = Vec::new();
    for v in violations {
        lines.push(format!("[{}] {}:{}: {}", v.rule.as_str(), v.file, v.line, v.message));
        for detail in &v.details {
            lines.push(format!("  {detail}"));
        }
        lines.push(format!("  Fix: {}", v.fix));
        lines.push(format!("  See: {}", v.see));
    }
    lines.join("\n")
}

pub fn format_lock_inventory(report: &ArchAuditReport) -> String {
    let mut lines = Vec::new();
    lines.push(format!(
        "server lock inventory (non-test): total Mutex<={}, RwLock<={}, combined={}",
        report.total_mutex_count,
        report.total_rwlock_count,
        report.total_mutex_count + report.total_rwlock_count
    ));
    if report.lock_inventory.is_empty() {
        lines.push("  (no Mutex< or RwLock< declarations found under crates/server/src/)".to_owned());
    } else {
        for entry in &report.lock_inventory {
            lines.push(format!(
                "  {:<16} Mutex<={:<4} RwLock<={:<4} total={}",
                entry.domain, entry.mutex_count, entry.rwlock_count, entry.total
            ));
        }
    }
    lines.join("\n")
}

fn format_metrics_summary(report: &ArchAuditReport) -> String {
    format!(
        "server(flume={}/{}, sync/async-dup={}/{}, sync-fs={}/{}, sync-process={}/{}, internal-value={}/{}), runtime(flume={}/{}, block_on={}/{}, os-thread={}/{}), mac(block_on={}/{}, os-thread={}/{}), workspace(raw-git={}/{}, blocking-reqwest={}/{})",
        report.flume_count,
        report.flume_ceiling,
        report.sync_async_dup_count,
        report.sync_async_dup_ceiling,
        report.server_sync_fs_count,
        report.server_sync_fs_ceiling,
        report.server_sync_process_count,
        report.server_sync_process_ceiling,
        report.server_internal_value_count,
        report.server_internal_value_ceiling,
        report.runtime_flume_count,
        report.runtime_flume_ceiling,
        report.runtime_block_on_count,
        report.runtime_block_on_ceiling,
        report.runtime_os_thread_count,
        report.runtime_os_thread_ceiling,
        report.mac_block_on_count,
        report.mac_block_on_ceiling,
        report.mac_os_thread_count,
        report.mac_os_thread_ceiling,
        report.raw_git_command_count,
        report.raw_git_command_ceiling,
        report.blocking_reqwest_count,
        report.blocking_reqwest_ceiling,
    )
}

pub fn run(root: &Path, args: &[String]) -> Result<i32, String> {
    let mut report_locks = false;
    let mut json_output = false;

    for arg in args {
        match arg.as_str() {
            "--report-locks" => report_locks = true,
            "--json" => json_output = true,
            "--help" | "-h" => {
                println!("Usage: cargo xtask arch-audit [--report-locks] [--json]");
                return Ok(0);
            }
            other => {
                eprintln!("Usage: cargo xtask arch-audit [--report-locks] [--json] (unknown option {other})");
                return Ok(2);
            }
        }
    }

    let report = if report_locks || json_output {
        audit_server_architecture_report(root)?
    } else {
        audit_server_architecture_strict(root)?
    };

    if json_output {
        let serialized = serde_json::to_string_pretty(&report).map_err(|err| format!("failed to serialize arch-audit report: {err}"))?;
        println!("{serialized}");
        return Ok(if report.violations.is_empty() { 0 } else { 1 });
    }

    if report_locks {
        println!("{}", format_lock_inventory(&report));
    }

    let metrics = format_metrics_summary(&report);
    if !report.violations.is_empty() {
        let summary = report
            .counts_by_rule
            .iter()
            .filter(|(_, count)| **count > 0)
            .map(|(rule, count)| format!("{rule}={count}"))
            .collect::<Vec<_>>()
            .join(", ");
        eprintln!(
            "arch-audit: {} violation(s) across {} files ({summary}; {metrics})\n\n{}",
            report.violations.len(),
            report.files_scanned,
            format_violations(&report.violations)
        );
        return Ok(1);
    }

    println!(
        "arch-audit: {} files ok ({} rules passed; {metrics}, app.rs={:?}, router.rs={:?})",
        report.files_scanned,
        ArchAuditRule::ALL.len(),
        report.app_rs_non_test_lines,
        report.router_rs_non_test_lines
    );
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

        fn mkdir(&self, rel: &str) {
            fs::create_dir_all(self.0.join(rel)).unwrap();
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn tags(violations: &[ArchViolation]) -> Vec<String> {
        violations.iter().map(|v| format!("{}@{}:{}", v.rule.as_str(), v.file, v.line)).collect()
    }

    #[test]
    fn rule1_no_gateway_reverse_import_rejects_illegal_and_passes_clean() {
        let dir = TempDir::new("vv-arch-r1");
        dir.write("crates/server/src/gateway/http.rs", "use crate::gateway::bridge::send;\npub fn serve() {}\n");
        dir.write("crates/server/src/router.rs", "use crate::gateway::http::serve;\n");
        dir.write("crates/server/src/app.rs", "use crate::gateway::http;\n");
        dir.write("crates/server/src/main.rs", "use crate::gateway::http;\n");
        dir.write("crates/server/src/lib.rs", "pub mod gateway;\nuse crate::gateway::http;\n");
        dir.write(
            "crates/server/src/issue/mod.rs",
            "// use crate::gateway::ignored;\nconst DOC: &str = \"crate::gateway::ignored\";\n#[cfg(test)]\nmod tests {\n    use crate::gateway::http::serve;\n}\n#[cfg(test)]\nmod ext_tests;\n",
        );
        dir.write("crates/server/src/issue/ext_tests.rs", "use crate::gateway::http::serve;\n");

        let clean = audit_server_architecture_strict(&dir.0).unwrap();
        assert!(clean.violations.is_empty(), "expected 0 violations, got: {:?}", clean.violations);

        dir.write(
            "crates/server/src/channel/mod.rs",
            "use crate::context::Ctx;\nuse crate::gateway::http::serve;\npub fn f() { let _ = crate::gateway::bridge::send(); }\n",
        );
        dir.write("crates/server/src/agent.rs", "use crate::{context::Ctx, gateway::http};\n");
        dir.write("crates/server/src/cron.rs", "use super::gateway::http;\n");

        let dirty = audit_server_architecture_strict(&dir.0).unwrap();
        assert_eq!(
            tags(&dirty.violations),
            vec![
                "no-gateway-reverse-import@crates/server/src/agent.rs:1",
                "no-gateway-reverse-import@crates/server/src/channel/mod.rs:2",
                "no-gateway-reverse-import@crates/server/src/channel/mod.rs:3",
                "no-gateway-reverse-import@crates/server/src/cron.rs:1",
            ]
        );
    }

    #[test]
    fn rule2_server_domain_dag_detects_cycles_with_tarjan_and_ignores_base_and_root() {
        let clean_dir = TempDir::new("vv-arch-r2-clean");
        clean_dir.write("crates/server/src/context.rs", "pub struct Ctx;\n");
        clean_dir.write(
            "crates/server/src/issue/mod.rs",
            "use crate::context::Ctx;\nuse crate::service::issue::IssueSvc;\n",
        );
        clean_dir.write("crates/server/src/channel/mod.rs", "use crate::issue::Issue;\nuse crate::context::Ctx;\n");
        clean_dir.write("crates/server/src/app.rs", "use crate::channel::Channel;\nuse crate::issue::Issue;\n");
        clean_dir.write("crates/server/src/setting.rs", "use crate::issue::Issue;\n");
        clean_dir.write("crates/server/src/issue/settings.rs", "use crate::setting::Setting;\n");

        let clean = audit_server_architecture_strict(&clean_dir.0).unwrap();
        assert!(clean.violations.is_empty(), "expected 0 violations, got: {:?}", clean.violations);

        let two_cycle_dir = TempDir::new("vv-arch-r2-two");
        two_cycle_dir.write("crates/server/src/issue/mod.rs", "pub struct Issue;\nuse crate::channel::Channel;\n");
        two_cycle_dir.write("crates/server/src/channel/mod.rs", "pub struct Channel;\nuse crate::issue::Issue;\n");

        let two = audit_server_architecture_strict(&two_cycle_dir.0).unwrap();
        assert_eq!(two.violations.len(), 1);
        assert_eq!(two.violations[0].rule, ArchAuditRule::ServerDomainDag);
        assert_eq!(two.violations[0].file, "crates/server/src/channel/mod.rs");
        assert_eq!(two.violations[0].line, 2);
        assert!(two.violations[0].message.contains("channel -> issue -> channel"));
        let formatted = format_violations(&two.violations);
        assert!(formatted.contains("crates/server/src/channel/mod.rs:2"));
        assert!(formatted.contains("crates/server/src/issue/mod.rs:2"));

        let three_cycle_dir = TempDir::new("vv-arch-r2-three");
        three_cycle_dir.write("crates/server/src/alpha/mod.rs", "use crate::beta::B;\n");
        three_cycle_dir.write("crates/server/src/beta/mod.rs", "use crate::gamma::G;\n");
        three_cycle_dir.write("crates/server/src/gamma/mod.rs", "use crate::alpha::A;\n");

        let three = audit_server_architecture_strict(&three_cycle_dir.0).unwrap();
        assert_eq!(three.violations.len(), 1);
        assert_eq!(three.violations[0].rule, ArchAuditRule::ServerDomainDag);
        assert!(three.violations[0].message.contains("alpha -> beta -> gamma -> alpha"));
        assert_eq!(three.violations[0].details.len(), 3);
    }

    #[test]
    fn rule2_server_domain_dag_enforces_hard_edge_bans() {
        let clean_dir = TempDir::new("vv-arch-r2-bans-clean");
        clean_dir.write(
            "crates/server/src/service/issue.rs",
            "use crate::db::entity::issue;\nuse crate::context::Ctx;\nuse crate::log::Logger;\nuse crate::service::common;\n",
        );
        clean_dir.write("crates/server/src/game/mod.rs", "use crate::context::Ctx;\nuse crate::repo::Repo;\n");
        clean_dir.write(
            "crates/server/src/runtime/runner.rs",
            "use crate::channel::Channel;\nuse crate::context::Ctx;\n",
        );

        let clean = audit_server_architecture_strict(&clean_dir.0).unwrap();
        assert!(clean.violations.is_empty(), "expected 0 violations, got: {:?}", clean.violations);

        let bad_dir = TempDir::new("vv-arch-r2-bans-bad");
        bad_dir.write(
            "crates/server/src/runtime/runner.rs",
            "use crate::agent::Agent;\nuse crate::issue::Issue;\nuse crate::cron::Cron;\n",
        );
        bad_dir.write("crates/server/src/service/issue.rs", "use crate::issue::Issue;\nuse crate::setting::Setting;\n");
        bad_dir.write("crates/server/src/game/mod.rs", "use crate::issue::Issue;\nuse crate::db::Db;\n");

        let dirty = audit_server_architecture_strict(&bad_dir.0).unwrap();
        assert_eq!(
            tags(&dirty.violations),
            vec![
                "server-domain-dag@crates/server/src/game/mod.rs:1",
                "server-domain-dag@crates/server/src/game/mod.rs:2",
                "server-domain-dag@crates/server/src/runtime/runner.rs:1",
                "server-domain-dag@crates/server/src/runtime/runner.rs:2",
                "server-domain-dag@crates/server/src/runtime/runner.rs:3",
                "server-domain-dag@crates/server/src/service/issue.rs:1",
                "server-domain-dag@crates/server/src/service/issue.rs:2",
            ]
        );
    }

    #[test]
    fn rule3_no_sea_orm_outside_service_rejects_illegal_and_passes_clean() {
        let dir = TempDir::new("vv-arch-r3");
        dir.write(
            "crates/server/src/db/mod.rs",
            "use sea_orm::DatabaseConnection;\nuse crate::db::entity::issue;\n",
        );
        dir.write(
            "crates/server/src/service/issue.rs",
            "use sea_orm::EntityTrait;\nuse crate::db::entity::issue::Model;\n",
        );
        dir.write(
            "crates/server/src/issue/mod.rs",
            "// use sea_orm::EntityTrait;\nconst S: &str = \"crate::db::entity::issue\";\n#[cfg(test)]\nmod tests {\n    use sea_orm::EntityTrait;\n    use crate::db::entity::issue;\n}\n",
        );

        let clean = audit_server_architecture_strict(&dir.0).unwrap();
        assert!(clean.violations.is_empty(), "expected 0 violations, got: {:?}", clean.violations);

        dir.write("crates/server/src/issue/store.rs", "use sea_orm::EntityTrait;\nuse crate::db::entity::issue;\n");
        dir.write("crates/server/src/channel/mod.rs", "use crate::db::{self, entity::channel};\n");

        let dirty = audit_server_architecture_strict(&dir.0).unwrap();
        assert_eq!(
            tags(&dirty.violations),
            vec![
                "no-sea-orm-outside-service@crates/server/src/channel/mod.rs:1",
                "no-sea-orm-outside-service@crates/server/src/issue/store.rs:1",
                "no-sea-orm-outside-service@crates/server/src/issue/store.rs:2",
            ]
        );
    }

    #[test]
    fn rule4_one_table_one_entity_file_rejects_missing_mismatch_and_multiple() {
        let dir = TempDir::new("vv-arch-r4");
        dir.write("crates/server/src/db/entity/mod.rs", "pub mod issue;\n");
        dir.write(
            "crates/server/src/db/entity/issue.rs",
            "// #[sea_orm(table_name = \"wrong\")]\n#[derive(Clone)]\n#[sea_orm(schema_name = \"main\", table_name = \"issue\")]\npub struct Model {\n    #[sea_orm(primary_key)]\n    pub id: String,\n}\n#[cfg(test)]\nmod tests {\n    #[sea_orm(table_name = \"extra_in_test\")]\n    struct T;\n}\n",
        );

        let clean = audit_server_architecture_strict(&dir.0).unwrap();
        assert!(clean.violations.is_empty(), "expected 0 violations, got: {:?}", clean.violations);

        dir.write("crates/server/src/db/entity/missing.rs", "pub struct Model { pub id: String }\n");
        dir.write(
            "crates/server/src/db/entity/wrong_name.rs",
            "#[derive(Clone)]\n#[sea_orm(table_name = \"other_table\")]\npub struct Model;\n",
        );
        dir.write(
            "crates/server/src/db/entity/multi.rs",
            "#[sea_orm(table_name = \"multi\")]\npub struct ModelA;\n#[sea_orm(table_name = \"second\")]\npub struct ModelB;\n",
        );

        let dirty = audit_server_architecture_strict(&dir.0).unwrap();
        assert_eq!(
            tags(&dirty.violations),
            vec![
                "one-table-one-entity-file@crates/server/src/db/entity/missing.rs:1",
                "one-table-one-entity-file@crates/server/src/db/entity/multi.rs:3",
                "one-table-one-entity-file@crates/server/src/db/entity/wrong_name.rs:2",
            ]
        );
    }

    #[test]
    fn rule5_no_late_bind_hook_rejects_all_seven_hooks_and_passes_clean() {
        let dir = TempDir::new("vv-arch-r5");
        dir.write(
            "crates/server/src/app.rs",
            "// OnceLock<SharedExecution> .bind_server() .guard_removal()\nconst S: &str = \".set_remember(.attach_orchestrator(\";\n#[cfg(test)]\nmod tests {\n    fn t() { let _: OnceLock<SharedExecution>; x.bind_server(y); }\n}\npub struct App;\n",
        );

        let clean = audit_server_architecture_strict(&dir.0).unwrap();
        assert!(clean.violations.is_empty(), "expected 0 violations, got: {:?}", clean.violations);

        dir.write(
            "crates/server/src/runtime/wire.rs",
            [
                "struct S { exec: std::sync::OnceLock<SharedExecution> }",
                "fn f(x: &X) {",
                "    x.bind_server(1);",
                "    x.guard_removal(2);",
                "    x.set_remember(3);",
                "    x.attach_orchestrator(4);",
                "    x.attach_remote_auth(5);",
                "    x.attach_machine_bus(6);",
                "}",
            ]
            .join("\n")
            .as_str(),
        );

        let dirty = audit_server_architecture_strict(&dir.0).unwrap();
        assert_eq!(
            tags(&dirty.violations),
            vec![
                "no-late-bind-hook@crates/server/src/runtime/wire.rs:1",
                "no-late-bind-hook@crates/server/src/runtime/wire.rs:3",
                "no-late-bind-hook@crates/server/src/runtime/wire.rs:4",
                "no-late-bind-hook@crates/server/src/runtime/wire.rs:5",
                "no-late-bind-hook@crates/server/src/runtime/wire.rs:6",
                "no-late-bind-hook@crates/server/src/runtime/wire.rs:7",
                "no-late-bind-hook@crates/server/src/runtime/wire.rs:8",
            ]
        );
    }

    #[test]
    fn rule6_thin_app_and_router_enforces_350_non_test_line_ceiling() {
        let dir = TempDir::new("vv-arch-r6");
        let mut clean_350 = (0..350).map(|i| format!("pub fn f_{i}() {{}}")).collect::<Vec<_>>().join("\n");
        clean_350.push_str("\n// comment line\n\n#[cfg(test)]\nmod tests {\n");
        for i in 0..80 {
            clean_350.push_str(&format!("    fn test_{i}() {{}}\n"));
        }
        clean_350.push_str("}\n");

        dir.write("crates/server/src/app.rs", &clean_350);
        dir.write("crates/server/src/router.rs", &clean_350);

        let clean = audit_server_architecture_strict(&dir.0).unwrap();
        assert!(clean.violations.is_empty(), "expected 0 violations, got: {:?}", clean.violations);
        assert_eq!(clean.app_rs_non_test_lines, Some(350));
        assert_eq!(clean.router_rs_non_test_lines, Some(350));

        let too_long = (0..351).map(|i| format!("pub fn g_{i}() {{}}")).collect::<Vec<_>>().join("\n");
        dir.write("crates/server/src/app.rs", &too_long);
        dir.write("crates/server/src/router.rs", &too_long);

        let dirty = audit_server_architecture_strict(&dir.0).unwrap();
        assert_eq!(
            tags(&dirty.violations),
            vec![
                "thin-app-and-router@crates/server/src/app.rs:1",
                "thin-app-and-router@crates/server/src/router.rs:1",
            ]
        );
        assert_eq!(dirty.app_rs_non_test_lines, Some(351));
        assert_eq!(dirty.router_rs_non_test_lines, Some(351));
    }

    #[test]
    fn rule7_concurrency_ratchets_and_lock_inventory() {
        assert_eq!(SERVER_FLUME_CEILING, 0);
        assert_eq!(RUNTIME_FLUME_CEILING, 0);
        assert_eq!(SERVER_SYNC_ASYNC_DUP_CEILING, 0);

        let dir = TempDir::new("vv-arch-r7");
        dir.write(
            "crates/server/src/issue/mod.rs",
            [
                "// flume::unbounded()",
                "pub struct IssueStore {",
                "    state: std::sync::Mutex<usize>,",
                "    cache: tokio::sync::RwLock<usize>,",
                "}",
                "impl IssueStore {",
                "    pub async fn list(&self) {}",
                "}",
                "#[cfg(test)]",
                "mod tests {",
                "    fn t() { let _ = flume::unbounded::<u8>(); let _: Mutex<u8>; }",
                "    pub fn list() {}",
                "    pub async fn list_async() {}",
                "}",
            ]
            .join("\n")
            .as_str(),
        );
        dir.write(
            "crates/server/src/runtime/mod.rs",
            "pub struct Runtime { lock: parking_lot::RwLock<u8>, lock2: parking_lot::RwLock<u8> }\n",
        );
        dir.write(
            "crates/runtime/src/oar/mod.rs",
            "// flume::unbounded()\n#[cfg(test)]\nmod tests { fn t() { let _ = flume::unbounded::<u8>(); } }\npub fn ok() {}\n",
        );

        let clean = audit_server_architecture_report(&dir.0).unwrap();
        assert!(clean.violations.is_empty(), "expected 0 violations, got: {:?}", clean.violations);
        assert_eq!(clean.flume_count, 0);
        assert_eq!(clean.runtime_flume_count, 0);
        assert_eq!(clean.sync_async_dup_count, 0);
        assert_eq!(clean.total_mutex_count, 1);
        assert_eq!(clean.total_rwlock_count, 3);
        assert_eq!(clean.lock_inventory.len(), 2);
        assert_eq!(clean.lock_inventory[0].domain, "issue");
        assert_eq!(clean.lock_inventory[0].mutex_count, 1);
        assert_eq!(clean.lock_inventory[0].rwlock_count, 1);
        assert_eq!(clean.lock_inventory[1].domain, "runtime");
        assert_eq!(clean.lock_inventory[1].mutex_count, 0);
        assert_eq!(clean.lock_inventory[1].rwlock_count, 2);

        dir.write(
            "crates/server/src/channel/mod.rs",
            [
                "pub fn send() { let _ = flume::unbounded::<u8>(); }",
                "pub fn list() {}",
                "pub async fn list_async() {}",
            ]
            .join("\n")
            .as_str(),
        );
        dir.write("crates/runtime/src/oar/core.rs", "pub fn rx() { let _ = flume::unbounded::<u8>(); }\n");

        let dirty = audit_server_architecture_report(&dir.0).unwrap();
        assert_eq!(dirty.flume_count, 1);
        assert_eq!(dirty.runtime_flume_count, 1);
        assert_eq!(dirty.sync_async_dup_count, 1);
        assert_eq!(
            tags(&dirty.violations),
            vec![
                "concurrency-and-async-ratchets@crates/runtime/src/oar/core.rs:1",
                "concurrency-and-async-ratchets@crates/server/src/channel/mod.rs:1",
                "concurrency-and-async-ratchets@crates/server/src/channel/mod.rs:3",
            ]
        );
        assert_eq!(dirty.counts_by_rule.get("concurrency-and-async-ratchets"), Some(&3));
    }

    #[test]
    fn rule8_no_legacy_server_layout_rejects_dirs_quote_port_and_bridge_hub() {
        let dir = TempDir::new("vv-arch-r8");
        dir.write("crates/server/src/app.rs", "pub struct App;\n");
        dir.write("crates/server/src/router.rs", "pub fn router() {}\n");
        dir.write("crates/server/src/gateway/mod.rs", "pub mod bridge;\n");
        dir.write(
            "crates/server/src/gateway/bridge/hub.rs",
            "// pub struct Hub;\n#[cfg(test)]\nmod tests { pub struct Hub; }\npub struct Bridge;\n",
        );

        let clean = audit_server_architecture_strict(&dir.0).unwrap();
        assert!(clean.violations.is_empty(), "expected 0 violations, got: {:?}", clean.violations);

        for legacy in LEGACY_SERVER_DIRS {
            dir.mkdir(&format!("crates/server/src/{legacy}"));
        }
        dir.write("crates/server/src/channel/port.rs", "pub trait ChannelQuotePort {}\n");
        dir.write("crates/server/src/gateway/bridge/hub.rs", "pub struct Hub;\n");

        let dirty = audit_server_architecture_strict(&dir.0).unwrap();
        assert_eq!(
            tags(&dirty.violations),
            vec![
                "no-legacy-server-layout@crates/server/src/app:1",
                "no-legacy-server-layout@crates/server/src/channel/port.rs:1",
                "no-legacy-server-layout@crates/server/src/collab:1",
                "no-legacy-server-layout@crates/server/src/content:1",
                "no-legacy-server-layout@crates/server/src/gateway/bridge/hub.rs:1",
                "no-legacy-server-layout@crates/server/src/infra:1",
                "no-legacy-server-layout@crates/server/src/skin:1",
                "no-legacy-server-layout@crates/server/src/team:1",
                "no-legacy-server-layout@crates/server/src/transport:1",
                "no-legacy-server-layout@crates/server/src/work:1",
            ]
        );
    }

    #[test]
    fn rule9_no_sync_fs_in_server_rejects_std_fs_and_ignores_comments_and_tests() {
        assert_eq!(SERVER_SYNC_FS_CEILING, 0);

        let dir = TempDir::new("vv-arch-r9");
        dir.write(
            "crates/server/src/attachment.rs",
            "// std::fs::read_to_string(p)\nconst S: &str = \"std::fs::write\";\npub async fn load(p: &str) { let _ = tokio::fs::read(p).await; }\n#[cfg(test)]\nmod tests { fn t() { let _ = std::fs::read(\"x\"); } }\n",
        );

        let clean = audit_server_architecture_strict(&dir.0).unwrap();
        assert!(clean.violations.is_empty(), "expected 0 violations, got: {:?}", clean.violations);
        assert_eq!(clean.server_sync_fs_count, 0);

        dir.write(
            "crates/server/src/repo.rs",
            "pub fn inspect(p: &str) {\n    let _ = std::fs::read_to_string(p);\n    let _ = std::fs::create_dir_all(p);\n}\n",
        );

        let dirty = audit_server_architecture_strict(&dir.0).unwrap();
        assert_eq!(dirty.server_sync_fs_count, 2);
        assert_eq!(tags(&dirty.violations), vec!["no-sync-fs-in-server@crates/server/src/repo.rs:2"]);
        assert_eq!(dirty.violations[0].details.len(), 2);
        assert!(dirty.violations[0].details[1].contains("crates/server/src/repo.rs:3"));
    }

    #[test]
    fn rule10_no_value_in_internal_sig_rejects_untyped_sigs_and_exempts_boundaries() {
        assert_eq!(SERVER_INTERNAL_VALUE_CEILING, 0);

        let dir = TempDir::new("vv-arch-r10");
        dir.write(
            "crates/server/src/router.rs",
            "pub async fn dispatch(payload: serde_json::Value) -> Value { payload }\n",
        );
        dir.write("crates/server/src/fake/server.rs", "pub fn stub(v: Value) -> Value { v }\n");
        dir.write("crates/server/src/gateway/api/mod.rs", "pub fn call(v: serde_json::Value) -> Value { v }\n");
        dir.write(
            "crates/server/src/issue/mod.rs",
            [
                "// pub fn commented(v: Value) {}",
                "fn private_helper(v: serde_json::Value) -> Value { v }",
                "pub fn typed_fn(id: &str) -> String {",
                "    let _internal: serde_json::Value = serde_json::json!({});",
                "    id.to_owned()",
                "}",
                "#[cfg(test)]",
                "mod tests { pub fn test_helper(v: Value) -> Value { v } }",
            ]
            .join("\n")
            .as_str(),
        );
        dir.write(
            "crates/server/src/service/db_helper.rs",
            "pub fn sea_val(v: sea_orm::Value) -> sea_orm::Value { v }\n",
        );

        let clean = audit_server_architecture_strict(&dir.0).unwrap();
        assert!(clean.violations.is_empty(), "expected 0 violations, got: {:?}", clean.violations);
        assert_eq!(clean.server_internal_value_count, 0);

        dir.write(
            "crates/server/src/outbox.rs",
            [
                "use serde_json::Value;",
                "pub fn emit(&self, payload: &Value) {}",
                "pub(crate) async fn emit_raw(&self, payload: serde_json::Value) -> Result<Value, String> { Ok(payload) }",
            ]
            .join("\n")
            .as_str(),
        );

        let dirty = audit_server_architecture_strict(&dir.0).unwrap();
        assert_eq!(dirty.server_internal_value_count, 2);
        assert_eq!(tags(&dirty.violations), vec!["no-value-in-internal-sig@crates/server/src/outbox.rs:2"]);
        assert_eq!(dirty.violations[0].details.len(), 2);
        assert!(dirty.violations[0].details[0].contains("crates/server/src/outbox.rs:2: fn `emit`"));
        assert!(dirty.violations[0].details[1].contains("crates/server/src/outbox.rs:3: fn `emit_raw`"));
    }

    #[test]
    fn rule11_runtime_and_mac_concurrency_ceilings_enforce_all_four_buckets() {
        assert_eq!(RUNTIME_BLOCK_ON_CEILING, 0);
        assert_eq!(RUNTIME_OS_THREAD_CEILING, 0);
        assert_eq!(MAC_BLOCK_ON_CEILING, 2);
        assert_eq!(MAC_OS_THREAD_CEILING, 2);

        let dir = TempDir::new("vv-arch-r11");
        dir.write(
            "crates/runtime/src/rt.rs",
            [
                "pub fn block_on<F>(f: F) { handle().block_on(f) }",
                "// crate::rt::block_on(async {}); std::thread::spawn(|| {});",
                "#[cfg(test)]",
                "mod tests { fn t() { block_on(async {}); std::thread::spawn(|| {}); } }",
            ]
            .join("\n")
            .as_str(),
        );
        dir.write("crates/runtime/src/bin/vv_test_fixture.rs", "fn main() { std::thread::spawn(|| {}); }\n");
        dir.write(
            "apps/mac/src/shell/mod.rs",
            "#[cfg(test)]\nmod tests { fn t() { vibevalley_runtime::rt::block_on(async {}); std::thread::Builder::new(); } }\npub fn ok() {}\n",
        );

        let zero_cfg = ArchAuditConfig {
            runtime_block_on_ceiling: 0,
            runtime_os_thread_ceiling: 0,
            mac_block_on_ceiling: 0,
            mac_os_thread_ceiling: 0,
            ..ArchAuditConfig::strict()
        };
        let clean = audit_server_architecture_with_config(&dir.0, zero_cfg).unwrap();
        assert!(clean.violations.is_empty(), "expected 0 violations, got: {:?}", clean.violations);
        assert_eq!(clean.runtime_block_on_count, 0);
        assert_eq!(clean.runtime_os_thread_count, 0);
        assert_eq!(clean.mac_block_on_count, 0);
        assert_eq!(clean.mac_os_thread_count, 0);

        dir.write(
            "crates/runtime/src/oar/runner.rs",
            "pub fn run() {\n    crate::rt::block_on(async {});\n    std::thread::spawn(|| {});\n}\n",
        );
        dir.write(
            "apps/mac/src/hosted/remote.rs",
            "pub fn call() {\n    vibevalley_runtime::rt::block_on(async {});\n    let _ = std::thread::Builder::new();\n}\n",
        );
        dir.write(
            "apps/mac/crates/workspace/src/store/sqlite.rs",
            "pub fn bad() {\n    vibevalley_rt::block_on(async {});\n    std::thread::spawn(|| {});\n}\n",
        );

        let dirty = audit_server_architecture_with_config(&dir.0, zero_cfg).unwrap();
        assert_eq!(dirty.runtime_block_on_count, 1);
        assert_eq!(dirty.runtime_os_thread_count, 1);
        assert_eq!(dirty.mac_block_on_count, 2);
        assert_eq!(dirty.mac_os_thread_count, 2);
        assert_eq!(
            tags(&dirty.violations),
            vec![
                "runtime-and-mac-concurrency-ceilings@apps/mac/crates/workspace/src/store/sqlite.rs:2",
                "runtime-and-mac-concurrency-ceilings@apps/mac/crates/workspace/src/store/sqlite.rs:3",
                "runtime-and-mac-concurrency-ceilings@crates/runtime/src/oar/runner.rs:2",
                "runtime-and-mac-concurrency-ceilings@crates/runtime/src/oar/runner.rs:3",
            ]
        );
    }

    #[test]
    fn formatting_includes_prescriptive_fields_and_lock_inventory_summary() {
        let dir = TempDir::new("vv-arch-format");
        dir.write("crates/server/src/issue/mod.rs", "use crate::gateway::http;\npub struct S(Mutex<u8>);\n");

        let report = audit_server_architecture_report(&dir.0).unwrap();
        let formatted_v = format_violations(&report.violations);
        assert!(formatted_v.contains("[no-gateway-reverse-import] crates/server/src/issue/mod.rs:1:"));
        assert!(formatted_v.contains("Fix:"));
        assert!(formatted_v.contains("See: docs/architecture.md"));

        let formatted_locks = format_lock_inventory(&report);
        assert!(formatted_locks.contains("total Mutex<=1, RwLock<=0, combined=1"));
        assert!(formatted_locks.contains("issue"));
    }

    #[test]
    fn rule12_no_raw_git_command_rejects_production_and_exempts_git_fake_and_tests() {
        assert_eq!(RAW_GIT_COMMAND_CEILING, 0);

        let dir = TempDir::new("vv-arch-r12");
        // Allowed exemptions: crates/git/src, fake/, gateway/bridge/fake.rs, runtime/src/bin, #[cfg(test)], comments, strings, non-git commands.
        dir.write(
            "crates/git/src/cmd.rs",
            "pub fn run() { let _ = std::process::Command::new(\"git\"); let _ = tokio::process::Command::new(\"git\"); }\n",
        );
        dir.write(
            "crates/server/src/fake/runtime.rs",
            "pub fn stub() { let _ = std::process::Command::new(\"git\"); }\n",
        );
        dir.write(
            "crates/server/src/gateway/bridge/fake.rs",
            "pub fn stub_bridge() { let _ = tokio::process::Command::new(\"git\"); }\n",
        );
        dir.write(
            "crates/runtime/src/bin/vv_test_fixture.rs",
            "fn main() { let _ = std::process::Command::new(\"git\"); }\n",
        );
        dir.write(
            "crates/cli/src/auth.rs",
            [
                "// Command::new(\"git\")",
                "const S: &str = \"Command::new(\\\"git\\\")\";",
                "pub fn other(bin: &str) {",
                "    let _ = std::process::Command::new(\"cargo\");",
                "    let _ = std::process::Command::new(bin);",
                "}",
                "#[cfg(test)]",
                "mod tests { fn t() { let _ = std::process::Command::new(\"git\"); } }",
                "#[cfg(test)]",
                "mod ext_tests;",
            ]
            .join("\n")
            .as_str(),
        );
        dir.write(
            "crates/cli/src/auth/ext_tests.rs",
            "pub fn helper() { let _ = std::process::Command::new(\"git\"); }\n",
        );

        let clean = audit_server_architecture_strict(&dir.0).unwrap();
        assert!(clean.violations.is_empty(), "expected 0 violations, got: {:?}", clean.violations);
        assert_eq!(clean.raw_git_command_count, 0);

        // Positive rejections across crates/server, crates/cli, crates/runtime, and apps/mac/crates (both std & tokio Command).
        dir.write(
            "crates/server/src/agent/tool/issue.rs",
            "pub async fn diff() { let _ = tokio::process::Command::new(\"git\"); }\n",
        );
        dir.write(
            "crates/cli/src/machine_agent/worktree.rs",
            "use std::process::Command;\npub fn status() { let _ = Command::new(\"git\"); }\n",
        );
        dir.write(
            "crates/runtime/src/agent/eval/grader.rs",
            "use tokio::process::Command;\npub async fn check() { let _ = Command::new(r#\"git\"#); }\n",
        );
        dir.write(
            "apps/mac/crates/workspace/src/git.rs",
            "pub fn head() { let _ = std::process::Command::new(/* tool */ \"git\"); }\n",
        );

        let dirty = audit_server_architecture_strict(&dir.0).unwrap();
        assert_eq!(dirty.raw_git_command_count, 4);
        assert_eq!(tags(&dirty.violations), vec!["no-raw-git-command@apps/mac/crates/workspace/src/git.rs:1"]);
        let details = &dirty.violations[0].details;
        assert_eq!(details.len(), 4);
        assert!(details.iter().any(|d| d.contains("apps/mac/crates/workspace/src/git.rs:1")));
        assert!(details.iter().any(|d| d.contains("crates/cli/src/machine_agent/worktree.rs:2")));
        assert!(details.iter().any(|d| d.contains("crates/runtime/src/agent/eval/grader.rs:2")));
        assert!(details.iter().any(|d| d.contains("crates/server/src/agent/tool/issue.rs:1")));
    }

    #[test]
    fn rule13_no_sync_process_in_server_rejects_std_command_and_exempts_fake_tests_and_tokio() {
        assert_eq!(SERVER_SYNC_PROCESS_CEILING, 0);

        let dir = TempDir::new("vv-arch-r13");
        // Allowed: tokio::process::Command, std::process::Stdio, fake/, outside crates/server/src/, #[cfg(test)], comments/strings.
        dir.write(
            "crates/server/src/fake/runtime.rs",
            "use std::process::Command;\npub fn stub() { let _ = Command::new(\"sh\"); }\n",
        );
        dir.write(
            "crates/server/src/gateway/bridge/fake.rs",
            "pub fn stub() { let _ = std::process::Command::new(\"sh\"); }\n",
        );
        dir.write(
            "crates/cli/src/auth.rs",
            "use std::process::Command;\npub fn host() { let _ = Command::new(\"hostname\"); }\n",
        );
        dir.write(
            "crates/server/src/repo.rs",
            [
                "use std::process::Stdio;",
                "use tokio::process::Command;",
                "// use std::process::Command;",
                "const DOC: &str = \"std::process::Command::new\";",
                "pub async fn ok() { let _ = Command::new(\"sh\").stdin(Stdio::null()); }",
                "#[cfg(test)]",
                "mod tests { fn t() { let _ = std::process::Command::new(\"sh\"); } }",
                "#[cfg(test)]",
                "mod ext_tests;",
            ]
            .join("\n")
            .as_str(),
        );
        dir.write(
            "crates/server/src/repo/ext_tests.rs",
            "use std::process::Command;\npub fn t() { let _ = Command::new(\"sh\"); }\n",
        );

        let clean = audit_server_architecture_strict(&dir.0).unwrap();
        assert!(clean.violations.is_empty(), "expected 0 violations, got: {:?}", clean.violations);
        assert_eq!(clean.server_sync_process_count, 0);

        // Positive rejections inside crates/server/src/ (import, grouped import, inline qualified, module-qualified).
        dir.write(
            "crates/server/src/gateway/remote/mod.rs",
            "use std::process::{Command, Stdio};\npub fn name() { let _ = Command::new(\"hostname\").stdin(Stdio::null()); }\n",
        );
        dir.write(
            "crates/server/src/runtime/worktree/check.rs",
            "pub fn run() { let _ = std::process::Command::new(\"sh\"); }\n",
        );
        dir.write(
            "crates/server/src/issue/pull/mod.rs",
            "use std::process::{self, Stdio};\npub fn run() { let _ = process::Command::new(\"sh\").stdin(Stdio::null()); }\n",
        );

        let dirty = audit_server_architecture_strict(&dir.0).unwrap();
        assert_eq!(dirty.server_sync_process_count, 3);
        assert_eq!(
            tags(&dirty.violations),
            vec!["no-sync-process-in-server@crates/server/src/gateway/remote/mod.rs:1"]
        );
        let details = &dirty.violations[0].details;
        assert_eq!(details.len(), 3);
        assert!(details.iter().any(|d| d.contains("crates/server/src/gateway/remote/mod.rs:1")));
        assert!(details.iter().any(|d| d.contains("crates/server/src/issue/pull/mod.rs:2")));
        assert!(details.iter().any(|d| d.contains("crates/server/src/runtime/worktree/check.rs:1")));
    }

    #[test]
    fn rule14_no_blocking_reqwest_rejects_production_and_exempts_tests_comments_and_fixture_bin() {
        assert_eq!(BLOCKING_REQWEST_CEILING, 0);

        let dir = TempDir::new("vv-arch-r14");
        // Allowed: async reqwest::Client, comments (like scripted.rs:397), strings, #[cfg(test)], external test mod, runtime/src/bin fixture.
        dir.write(
            "crates/runtime/src/oar/scripted.rs",
            [
                "// Computed test callbacks may perform blocking git/HTTP work (e.g. `reqwest::blocking`).",
                "const DOC: &str = \"reqwest::blocking::Client\";",
                "pub fn ok() { let _ = reqwest::Client::new(); }",
            ]
            .join("\n")
            .as_str(),
        );
        dir.write(
            "crates/runtime/src/bin/vv_test_fixture.rs",
            "fn main() { let _ = reqwest::blocking::Client::new(); }\n",
        );
        dir.write("crates/server/src/gateway/http/mod.rs", "#[cfg(test)]\nmod tests;\npub fn ok() {}\n");
        dir.write(
            "crates/server/src/gateway/http/tests.rs",
            "fn agent() -> reqwest::blocking::Client { reqwest::blocking::Client::new() }\n",
        );
        dir.write(
            "crates/cli/src/lib.rs",
            "#[cfg(test)]\nmod tests { fn t() { let _ = reqwest::blocking::get(\"http://127.0.0.1\"); } }\n",
        );

        let clean = audit_server_architecture_strict(&dir.0).unwrap();
        assert!(clean.violations.is_empty(), "expected 0 violations, got: {:?}", clean.violations);
        assert_eq!(clean.blocking_reqwest_count, 0);

        // Positive rejections across workspace production source (qualified path + use tree, including fake/ and cli bin).
        dir.write(
            "crates/cli/src/client.rs",
            [
                "fn build_http_client() -> reqwest::blocking::Client {",
                "    reqwest::blocking::Client::new()",
                "}",
            ]
            .join("\n")
            .as_str(),
        );
        dir.write(
            "crates/cli/src/bin/vibevalley_eval.rs",
            "use reqwest::blocking::{Client, RequestBuilder};\nfn main() {}\n",
        );
        dir.write(
            "crates/server/src/fake/moss.rs",
            "use reqwest::blocking;\npub fn probe() { let _ = blocking::Client::new(); }\n",
        );

        let dirty = audit_server_architecture_strict(&dir.0).unwrap();
        assert_eq!(dirty.blocking_reqwest_count, 4);
        assert_eq!(tags(&dirty.violations), vec!["no-blocking-reqwest@crates/cli/src/bin/vibevalley_eval.rs:1"]);
        let details = &dirty.violations[0].details;
        assert_eq!(details.len(), 4);
        assert!(details.iter().any(|d| d.contains("crates/cli/src/bin/vibevalley_eval.rs:1")));
        assert!(details.iter().any(|d| d.contains("crates/cli/src/client.rs:1")));
        assert!(details.iter().any(|d| d.contains("crates/cli/src/client.rs:2")));
        assert!(details.iter().any(|d| d.contains("crates/server/src/fake/moss.rs:1")));
    }

    #[test]
    fn rule15_thin_mod_rs_enforces_ceiling_on_mod_rs_only_and_exempts_tests_and_leaf_files() {
        assert!(LEGACY_FAT_MOD_RS_CEILINGS.is_empty());
        let dir = TempDir::new("vv-arch-r15");
        let leaf_body: String = (0..260).map(|i| format!("pub fn leaf_{i}() -> usize {{ {i} }}\n")).collect();
        let test_body: String = (0..250).map(|i| format!("#[test] fn t_{i}() {{}}\n")).collect();

        // Large non-mod.rs leaf implementation file is intentionally allowed (essential complexity).
        dir.write("crates/server/src/runtime/session/engine.rs", &leaf_body);
        // Thin mod.rs with a large inline #[cfg(test)] mod tests stays well below the non-test ceiling.
        dir.write(
            "crates/server/src/issue/mod.rs",
            &format!("pub mod engine;\n#[cfg(test)]\nmod tests {{\n{test_body}}}\n"),
        );

        let clean = audit_server_architecture_strict(&dir.0).unwrap();
        assert!(clean.violations.is_empty(), "expected 0 violations, got: {:?}", clean.violations);

        // Exceeding the 200 non-test ceiling on any mod.rs triggers `thin-mod-rs`.
        let fat_mod: String = (0..205).map(|i| format!("pub fn f_{i}() -> usize {{ {i} }}\n")).collect();
        dir.write("crates/server/src/issue/mod.rs", &fat_mod);

        let dirty = audit_server_architecture_strict(&dir.0).unwrap();
        assert_eq!(tags(&dirty.violations), vec!["thin-mod-rs@crates/server/src/issue/mod.rs:1"]);
    }
}
