//! Rust <-> TS SSOT drift and structural clone radar (`cargo xtask ssot-check`).

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::rust_scan::{
    LineIndex, SourceFile, is_excluded_by_cfg_test, is_ident_char, is_ident_start, strip_cfg_test_and_collect_excluded, strip_rust_comments_and_literals,
    walk_matching_files,
};

const DEFAULT_MIN_LINES: usize = 25;
const CLONE_SIMILARITY_THRESHOLD: f64 = 0.80;
const CLONE_MIN_TOKENS_PER_LINE_AVG: usize = 3;
const CLONE_SHINGLE_LINES: usize = 5;
const CLONE_MAX_SHINGLE_FREQ: usize = 24;

const USAGE: &str = "\
Usage: cargo xtask ssot-check [--json] [--strict] [--dupes] [--min-lines N] [--rule <id>]

Audit Rust <-> TypeScript SSOT invariants and structural clones:
  - ts-enum-mirror          TS string literal arrays duplicating Rust contract enums (>= 3 variants)
  - host-dto-bypass         Serialize/Deserialize DTOs in apps/mac/src/** defined outside crates/protocol
  - env-registry-drift      Non-standard env vars in Rust/TS missing from crates/protocol/src/home.rs
  - structural-clone-radar  Identifier-normalized structural duplicate detector (with --dupes)";

/// Explicit internal-only allowlist for `Serialize`/`Deserialize` types in `apps/mac/src/**`
/// that represent local config/settings files, asset manifests, or external third-party wire formats
/// rather than desktop IPC/Bridge DTOs that belong in `crates/protocol`.
const INTERNAL_HOST_DTO_ALLOWLIST: &[(&str, &str, &str)] = &[
    ("apps/mac/src/theme.rs", "ThemeChoice", "local desktop settings.json enum"),
    ("apps/mac/src/theme.rs", "MotionChoice", "local desktop settings.json enum"),
    ("apps/mac/src/theme.rs", "Settings", "local desktop settings.json persistence struct"),
    (
        "apps/mac/src/hosted/connection.rs",
        "Secret",
        "local desktop-connection.json redacted token wrapper",
    ),
    ("apps/mac/src/hosted/connection.rs", "Mode", "local desktop-connection.json persistence enum"),
    ("apps/mac/src/update/releases.rs", "Build", "external updater release.json feed schema"),
    ("apps/mac/src/update/releases.rs", "Release", "external updater release.json feed schema"),
    ("apps/mac/src/update/releases.rs", "ListedRelease", "external GitHub Releases API schema"),
    ("apps/mac/src/update/releases.rs", "ListedAsset", "external GitHub Releases API schema"),
    ("apps/mac/src/live_voice.rs", "Attached", "external MOSS WebSocket protocol frame"),
    ("apps/mac/src/live_voice.rs", "Updated", "external MOSS WebSocket protocol frame"),
    ("apps/mac/src/live_voice.rs", "Piece", "external MOSS WebSocket protocol frame"),
    ("apps/mac/src/live_voice.rs", "Turn", "external MOSS WebSocket protocol frame"),
    ("apps/mac/src/live_voice.rs", "Transcript", "external MOSS WebSocket protocol frame"),
    ("apps/mac/src/live_voice.rs", "Event", "external MOSS WebSocket protocol frame"),
    (
        "apps/mac/src/applet/protocol.rs",
        "Modifiers",
        "frozen Swift VibeValleyShim Unix-socket NDJSON IPC protocol",
    ),
    (
        "apps/mac/src/applet/protocol.rs",
        "MouseButtonKind",
        "frozen Swift VibeValleyShim Unix-socket NDJSON IPC protocol",
    ),
    (
        "apps/mac/src/applet/protocol.rs",
        "ScrollPhaseKind",
        "frozen Swift VibeValleyShim Unix-socket NDJSON IPC protocol",
    ),
    (
        "apps/mac/src/applet/protocol.rs",
        "ShimToHost",
        "frozen Swift VibeValleyShim Unix-socket NDJSON IPC protocol",
    ),
    (
        "apps/mac/src/applet/protocol.rs",
        "HostToShim",
        "frozen Swift VibeValleyShim Unix-socket NDJSON IPC protocol",
    ),
    ("apps/mac/src/island.rs", "Row", "Swift VibeValleyIsland stdio NDJSON IPC protocol"),
    ("apps/mac/src/island.rs", "Glance", "Swift VibeValleyIsland stdio NDJSON IPC protocol"),
    ("apps/mac/src/island.rs", "Strip", "Swift VibeValleyIsland stdio NDJSON IPC protocol"),
    ("apps/mac/src/island.rs", "Open", "Swift VibeValleyIsland stdio NDJSON IPC protocol"),
    (
        "apps/mac/src/hosted/debug.rs",
        "DebugFrameRecord",
        "internal GPUI frame ring buffer entry mapped to protocol DebugSnapshot",
    ),
    (
        "apps/mac/src/hosted/debug.rs",
        "DebugCacheEntry",
        "internal GPUI cache ring buffer entry mapped to protocol DebugSnapshot",
    ),
];

const STANDARD_ENV_VARS: &[&str] = &[
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "CI",
    "NODE_ENV",
    "RUST_LOG",
    "RUST_BACKTRACE",
    "TERM",
    "TERM_PROGRAM",
    "SHELL",
    "USER",
    "USERNAME",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "PWD",
    "OLDPWD",
    "SHLVL",
    "HOSTNAME",
    "COMPUTERNAME",
    "DISPLAY",
    "EDITOR",
    "VISUAL",
    "COLORTERM",
    "NO_COLOR",
    "FORCE_COLOR",
    "OUT_DIR",
    "TARGET",
    "HOST",
    "PROFILE",
    "OPT_LEVEL",
    "DEBUG",
    "NUM_JOBS",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "HOMEBREW_PREFIX",
    "DEVELOPER_DIR",
    "SDKROOT",
    "APPLE_SDKROOT",
    "PNPM_HOME",
    "NPM_CONFIG_USERCONFIG",
];

const STANDARD_ENV_PREFIXES: &[&str] = &["CARGO_", "RUSTC_", "RUSTFLAGS", "GITHUB_", "CI_", "VITE_", "NEXT_", "NSH_", "MACOSX_", "APPLE_"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SsotRule {
    TsEnumMirror,
    HostDtoBypass,
    EnvRegistryDrift,
    StructuralCloneRadar,
}

impl SsotRule {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TsEnumMirror => "ts-enum-mirror",
            Self::HostDtoBypass => "host-dto-bypass",
            Self::EnvRegistryDrift => "env-registry-drift",
            Self::StructuralCloneRadar => "structural-clone-radar",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "ts-enum-mirror" => Some(Self::TsEnumMirror),
            "host-dto-bypass" => Some(Self::HostDtoBypass),
            "env-registry-drift" => Some(Self::EnvRegistryDrift),
            "structural-clone-radar" => Some(Self::StructuralCloneRadar),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Warning,
    Info,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SsotDiagnostic {
    pub rule: SsotRule,
    pub severity: Severity,
    pub file: String,
    pub line: usize,
    pub symbol: String,
    pub why: String,
    pub fix_hint: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CloneFinding {
    pub file: String,
    pub line: usize,
    pub peer_file: String,
    pub peer_line: usize,
    pub similarity: f64,
    pub fix_hint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SsotSummary {
    pub files_scanned: usize,
    pub total_findings: usize,
    pub diagnostic_count: usize,
    pub clone_count: usize,
    pub dupes_enabled: bool,
    pub min_lines: usize,
    pub strict: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SsotReport {
    pub summary: SsotSummary,
    pub counts_by_rule: BTreeMap<String, usize>,
    pub diagnostics: Vec<SsotDiagnostic>,
    pub clones: Vec<CloneFinding>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SsotConfig {
    pub json: bool,
    pub strict: bool,
    pub dupes: bool,
    pub min_lines: usize,
    pub rule_filter: Option<SsotRule>,
}

impl Default for SsotConfig {
    fn default() -> Self {
        Self {
            json: false,
            strict: false,
            dupes: false,
            min_lines: DEFAULT_MIN_LINES,
            rule_filter: None,
        }
    }
}

pub fn run(root: &Path, args: &[String]) -> Result<i32, String> {
    let mut cfg = SsotConfig::default();
    let mut i = 0usize;
    while i < args.len() {
        let arg = args[i].as_str();
        match arg {
            "--help" | "-h" => {
                println!("{USAGE}");
                return Ok(0);
            }
            "--json" => cfg.json = true,
            "--strict" => cfg.strict = true,
            "--dupes" => cfg.dupes = true,
            "--min-lines" => {
                let Some(val) = args.get(i + 1) else {
                    eprintln!("xtask ssot-check: --min-lines requires a positive integer\n\n{USAGE}");
                    return Ok(2);
                };
                cfg.min_lines = parse_positive_usize(val).ok_or_else(|| format!("invalid --min-lines value: {val}"))?;
                i += 1;
            }
            _ if arg.starts_with("--min-lines=") => {
                let val = &arg["--min-lines=".len()..];
                cfg.min_lines = parse_positive_usize(val).ok_or_else(|| format!("invalid --min-lines value: {val}"))?;
            }
            "--rule" => {
                let Some(val) = args.get(i + 1) else {
                    eprintln!("xtask ssot-check: --rule requires a rule id\n\n{USAGE}");
                    return Ok(2);
                };
                let Some(rule) = SsotRule::parse(val) else {
                    eprintln!("xtask ssot-check: unknown rule `{val}`\n\n{USAGE}");
                    return Ok(2);
                };
                cfg.rule_filter = Some(rule);
                i += 1;
            }
            _ if arg.starts_with("--rule=") => {
                let val = &arg["--rule=".len()..];
                let Some(rule) = SsotRule::parse(val) else {
                    eprintln!("xtask ssot-check: unknown rule `{val}`\n\n{USAGE}");
                    return Ok(2);
                };
                cfg.rule_filter = Some(rule);
            }
            other => {
                eprintln!("xtask ssot-check: unknown option `{other}`\n\n{USAGE}");
                return Ok(2);
            }
        }
        i += 1;
    }

    if cfg.rule_filter == Some(SsotRule::StructuralCloneRadar) {
        cfg.dupes = true;
    }

    let report = check_workspace(root, cfg)?;
    if cfg.json {
        let json = serde_json::to_string_pretty(&report).map_err(|err| format!("failed to serialize ssot-check JSON: {err}"))?;
        println!("{json}");
    } else {
        print!("{}", format_report(&report));
    }

    if cfg.strict && report.summary.total_findings > 0 { Ok(1) } else { Ok(0) }
}

fn parse_positive_usize(raw: &str) -> Option<usize> {
    raw.parse::<usize>().ok().filter(|&n| n >= 1)
}

pub fn check_workspace(root: &Path, cfg: SsotConfig) -> Result<SsotReport, String> {
    let mut diagnostics = Vec::new();
    let mut clones = Vec::new();
    let mut scanned_paths: BTreeSet<String> = BTreeSet::new();

    let run_rule = |rule: SsotRule| cfg.rule_filter.is_none_or(|f| f == rule);

    if run_rule(SsotRule::TsEnumMirror) {
        let (diags, files) = check_ts_enum_mirror(root)?;
        diagnostics.extend(diags);
        scanned_paths.extend(files);
    }

    if run_rule(SsotRule::HostDtoBypass) {
        let (diags, files) = check_host_dto_bypass(root)?;
        diagnostics.extend(diags);
        scanned_paths.extend(files);
    }

    if run_rule(SsotRule::EnvRegistryDrift) {
        let (diags, files) = check_env_registry_drift(root)?;
        diagnostics.extend(diags);
        scanned_paths.extend(files);
    }

    if cfg.dupes && run_rule(SsotRule::StructuralCloneRadar) {
        let (found_clones, files) = check_structural_clones(root, cfg.min_lines)?;
        scanned_paths.extend(files);
        for clone in &found_clones {
            diagnostics.push(SsotDiagnostic {
                rule: SsotRule::StructuralCloneRadar,
                severity: Severity::Info,
                file: clone.file.clone(),
                line: clone.line,
                symbol: format!("{}:{} ({:.0}%)", clone.peer_file, clone.peer_line, clone.similarity * 100.0),
                why: format!(
                    "structural clone ({:.0}% token similarity) matches {}:{}",
                    clone.similarity * 100.0,
                    clone.peer_file,
                    clone.peer_line
                ),
                fix_hint: clone.fix_hint.clone(),
            });
        }
        clones = found_clones;
    }

    diagnostics.sort_by(|a, b| {
        a.rule
            .cmp(&b.rule)
            .then_with(|| a.file.cmp(&b.file))
            .then_with(|| a.line.cmp(&b.line))
            .then_with(|| a.symbol.cmp(&b.symbol))
    });

    let mut counts_by_rule = BTreeMap::new();
    for rule in [
        SsotRule::TsEnumMirror,
        SsotRule::HostDtoBypass,
        SsotRule::EnvRegistryDrift,
        SsotRule::StructuralCloneRadar,
    ] {
        counts_by_rule.insert(rule.as_str().to_owned(), 0usize);
    }
    for d in &diagnostics {
        *counts_by_rule.entry(d.rule.as_str().to_owned()).or_default() += 1;
    }

    let total_findings = diagnostics.len();
    let clone_count = clones.len();
    Ok(SsotReport {
        summary: SsotSummary {
            files_scanned: scanned_paths.len(),
            total_findings,
            diagnostic_count: total_findings,
            clone_count,
            dupes_enabled: cfg.dupes,
            min_lines: cfg.min_lines,
            strict: cfg.strict,
        },
        counts_by_rule,
        diagnostics,
        clones,
    })
}

fn format_report(report: &SsotReport) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "ssot-check: {} files scanned, {} findings (ts-enum-mirror={}, host-dto-bypass={}, env-registry-drift={}, structural-clone-radar={})\n",
        report.summary.files_scanned,
        report.summary.total_findings,
        report.counts_by_rule.get("ts-enum-mirror").copied().unwrap_or(0),
        report.counts_by_rule.get("host-dto-bypass").copied().unwrap_or(0),
        report.counts_by_rule.get("env-registry-drift").copied().unwrap_or(0),
        report.counts_by_rule.get("structural-clone-radar").copied().unwrap_or(0),
    ));
    for d in &report.diagnostics {
        out.push_str(&format!(
            "  [{}] {}:{} `{}` — {}\n    fix: {}\n",
            d.rule.as_str(),
            d.file,
            d.line,
            d.symbol,
            d.why,
            d.fix_hint
        ));
    }
    out
}

// ============================================================================
// Shared Rust/TS Lexical Helpers (byte-offset & line-number preserving)
// ============================================================================

#[derive(Debug, Clone, PartialEq, Eq)]
struct SpanToken {
    start: usize,
    end: usize,
    text: String,
}

fn tokenize_rust_ident_and_punct(stripped: &str) -> Vec<SpanToken> {
    let bytes = stripped.as_bytes();
    let len = bytes.len();
    let mut tokens = Vec::new();
    let mut i = 0usize;
    while i < len {
        let b = bytes[i];
        if b.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if is_ident_start(b) {
            let start = i;
            i += 1;
            while i < len && is_ident_char(bytes[i]) {
                i += 1;
            }
            tokens.push(SpanToken {
                start,
                end: i,
                text: stripped[start..i].to_owned(),
            });
            continue;
        }
        if b.is_ascii_digit() {
            let start = i;
            i += 1;
            while i < len && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            tokens.push(SpanToken {
                start,
                end: i,
                text: stripped[start..i].to_owned(),
            });
            continue;
        }
        if b == b':' && bytes.get(i + 1) == Some(&b':') {
            tokens.push(SpanToken {
                start: i,
                end: i + 2,
                text: "::".to_owned(),
            });
            i += 2;
            continue;
        }
        if b == b'-' && bytes.get(i + 1) == Some(&b'>') {
            tokens.push(SpanToken {
                start: i,
                end: i + 2,
                text: "->".to_owned(),
            });
            i += 2;
            continue;
        }
        if b == b'=' && bytes.get(i + 1) == Some(&b'>') {
            tokens.push(SpanToken {
                start: i,
                end: i + 2,
                text: "=>".to_owned(),
            });
            i += 2;
            continue;
        }
        let ch = stripped[i..].chars().next().expect("valid utf-8");
        let end = i + ch.len_utf8();
        tokens.push(SpanToken {
            start: i,
            end,
            text: ch.to_string(),
        });
        i = end;
    }
    tokens
}

fn utf8_char_len(bytes: &[u8], idx: usize) -> usize {
    if idx >= bytes.len() {
        return 0;
    }
    let first = bytes[idx];
    if first < 0x80 {
        1
    } else if first & 0b1110_0000 == 0b1100_0000 {
        2.min(bytes.len() - idx)
    } else if first & 0b1111_0000 == 0b1110_0000 {
        3.min(bytes.len() - idx)
    } else {
        4.min(bytes.len() - idx)
    }
}

/// Strips `//` and `/* */` comments from TS/JS while keeping exact byte offsets, newlines, and string literals.
fn strip_ts_comments_preserving_offsets(source: &str) -> String {
    let bytes = source.as_bytes();
    let len = bytes.len();
    let mut out = Vec::with_capacity(len);
    let mut i = 0usize;
    let mut template_brace_depths: Vec<usize> = Vec::new();
    let mut brace_depth = 0usize;

    while i < len {
        let b = bytes[i];
        let next = bytes.get(i + 1).copied();

        if b == b'/' && next == Some(b'/') {
            let start = i;
            i += 2;
            while i < len && bytes[i] != b'\n' {
                i += utf8_char_len(bytes, i);
            }
            blank_ts_range(&mut out, bytes, start, i);
            continue;
        }

        if b == b'/' && next == Some(b'*') {
            let start = i;
            i += 2;
            while i < len {
                if bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/') {
                    i += 2;
                    break;
                }
                i += utf8_char_len(bytes, i);
            }
            blank_ts_range(&mut out, bytes, start, i);
            continue;
        }

        if b == b'\'' || b == b'"' {
            let quote = b;
            let start = i;
            i += 1;
            while i < len {
                if bytes[i] == b'\\' {
                    i += 1;
                    i += utf8_char_len(bytes, i);
                    continue;
                }
                if bytes[i] == quote {
                    i += 1;
                    break;
                }
                if bytes[i] == b'\n' {
                    break;
                }
                i += utf8_char_len(bytes, i);
            }
            out.extend_from_slice(&bytes[start..i]);
            continue;
        }

        if b == b'`' {
            out.push(b);
            i += 1;
            scan_ts_template_body(bytes, &mut i, &mut out, &mut template_brace_depths, brace_depth, false);
            continue;
        }

        if b == b'{' {
            brace_depth += 1;
            out.push(b);
            i += 1;
            continue;
        }

        if b == b'}' {
            if template_brace_depths.last().copied() == Some(brace_depth) {
                template_brace_depths.pop();
                out.push(b);
                i += 1;
                scan_ts_template_body(bytes, &mut i, &mut out, &mut template_brace_depths, brace_depth, false);
                continue;
            }
            brace_depth = brace_depth.saturating_sub(1);
            out.push(b);
            i += 1;
            continue;
        }

        if b == b'/' && looks_like_ts_regex_start(&out) {
            let start = i;
            i += 1;
            let mut in_class = false;
            while i < len {
                let c = bytes[i];
                if c == b'\\' {
                    i += 1;
                    i += utf8_char_len(bytes, i);
                    continue;
                }
                if c == b'\n' {
                    break;
                }
                if c == b'[' {
                    in_class = true;
                } else if c == b']' {
                    in_class = false;
                } else if c == b'/' && !in_class {
                    i += 1;
                    while i < len && bytes[i].is_ascii_alphabetic() {
                        i += 1;
                    }
                    break;
                }
                i += utf8_char_len(bytes, i);
            }
            out.extend_from_slice(&bytes[start..i]);
            continue;
        }

        let step = utf8_char_len(bytes, i);
        out.extend_from_slice(&bytes[i..i + step]);
        i += step;
    }

    String::from_utf8(out).expect("TS comment stripper preserves valid UTF-8")
}

fn scan_ts_template_body(bytes: &[u8], i: &mut usize, out: &mut Vec<u8>, template_brace_depths: &mut Vec<usize>, brace_depth: usize, blank_literals: bool) {
    let len = bytes.len();
    while *i < len {
        let c = bytes[*i];
        if c == b'\\' {
            let start = *i;
            let end = (*i + 1 + utf8_char_len(bytes, *i + 1)).min(len);
            if blank_literals {
                blank_ts_range(out, bytes, start, end);
            } else {
                out.extend_from_slice(&bytes[start..end]);
            }
            *i = end;
            continue;
        }
        if c == b'`' {
            out.push(if blank_literals { b' ' } else { b'`' });
            *i += 1;
            return;
        }
        if c == b'$' && bytes.get(*i + 1) == Some(&b'{') {
            out.push(b'$');
            out.push(b'{');
            *i += 2;
            template_brace_depths.push(brace_depth);
            return;
        }
        let step = utf8_char_len(bytes, *i);
        if blank_literals {
            blank_ts_range(out, bytes, *i, *i + step);
        } else {
            out.extend_from_slice(&bytes[*i..*i + step]);
        }
        *i += step;
    }
}

fn blank_ts_range(out: &mut Vec<u8>, bytes: &[u8], from: usize, to: usize) {
    for &b in &bytes[from..to.min(bytes.len())] {
        out.push(if b == b'\n' { b'\n' } else { b' ' });
    }
}

fn looks_like_ts_regex_start(preceding: &[u8]) -> bool {
    let mut idx = preceding.len();
    while idx > 0 && preceding[idx - 1].is_ascii_whitespace() {
        idx -= 1;
    }
    if idx == 0 {
        return true;
    }
    let prev = preceding[idx - 1];
    matches!(
        prev,
        b'(' | b'[' | b'{' | b',' | b';' | b':' | b'=' | b'!' | b'&' | b'|' | b'?' | b'~' | b'^' | b'+' | b'-' | b'*' | b'/'
    ) || preceding[..idx].ends_with(b"return")
        || preceding[..idx].ends_with(b"case")
        || preceding[..idx].ends_with(b"throw")
}

fn unquote_string_literal(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.len() >= 2 && ((trimmed.starts_with('"') && trimmed.ends_with('"')) || (trimmed.starts_with('\'') && trimmed.ends_with('\''))) {
        let inner = &trimmed[1..trimmed.len() - 1];
        let mut out = String::with_capacity(inner.len());
        let mut chars = inner.chars();
        while let Some(ch) = chars.next() {
            if ch == '\\' {
                if let Some(esc) = chars.next() {
                    match esc {
                        'n' => out.push('\n'),
                        'r' => out.push('\r'),
                        't' => out.push('\t'),
                        '\\' => out.push('\\'),
                        '"' => out.push('"'),
                        '\'' => out.push('\''),
                        other => out.push(other),
                    }
                }
            } else {
                out.push(ch);
            }
        }
        return Some(out);
    }
    None
}

fn collect_non_test_rust_files(root: &Path, subdirs: &[&str]) -> Result<Vec<(SourceFile, String)>, String> {
    let raw_files = walk_matching_files(root, subdirs, |rel| rel.ends_with(".rs"))?;
    let mut parsed = Vec::with_capacity(raw_files.len());
    let mut excluded_targets = BTreeSet::new();
    for file in raw_files {
        let no_comments = strip_rust_comments_and_literals(&file.text);
        let stripped = strip_cfg_test_and_collect_excluded(&file.text, &no_comments, &file.path);
        for target in stripped.excluded_submodules {
            excluded_targets.insert(target);
        }
        parsed.push((file, stripped.code));
    }
    Ok(parsed
        .into_iter()
        .filter(|(file, _)| !is_excluded_by_cfg_test(&file.path, &excluded_targets))
        .collect())
}

// ============================================================================
// Rule 1: ts-enum-mirror
// ============================================================================

#[derive(Debug, Clone)]
struct ProtocolEnum {
    name: String,
    file: String,
    variants: BTreeSet<String>,
}

fn check_ts_enum_mirror(root: &Path) -> Result<(Vec<SsotDiagnostic>, Vec<String>), String> {
    let contract_files = collect_non_test_rust_files(root, &["crates/protocol/src/contract"])?;
    let mut protocol_enums = Vec::new();
    let mut scanned = Vec::new();

    for (file, stripped) in &contract_files {
        scanned.push(file.path.clone());
        protocol_enums.extend(extract_contract_enums(file, stripped));
    }
    protocol_enums.retain(|e| e.variants.len() >= 3);

    let ts_files = walk_matching_files(root, &["apps/mac/ui", "apps/mobile"], |rel| {
        (rel.ends_with(".ts") || rel.ends_with(".tsx")) && !is_excluded_ts_path(rel)
    })?;

    let mut diagnostics = Vec::new();
    for file in &ts_files {
        scanned.push(file.path.clone());
        diagnostics.extend(scan_ts_file_for_enum_mirrors(file, &protocol_enums));
    }

    Ok((diagnostics, scanned))
}

fn is_excluded_ts_path(rel: &str) -> bool {
    rel.ends_with(".gen.ts")
        || rel.ends_with(".gen.tsx")
        || rel.contains(".test.")
        || rel.contains(".spec.")
        || rel.contains("/__tests__/")
        || rel.contains("/dist/")
        || rel.contains("/.tools/")
}

fn extract_contract_enums(file: &SourceFile, stripped: &str) -> Vec<ProtocolEnum> {
    let tokens = tokenize_rust_ident_and_punct(stripped);
    let mut enums = Vec::new();
    let mut i = 0usize;
    let mut brace_depth = 0usize;

    while i < tokens.len() {
        let tok = &tokens[i];
        if tok.text == "{" {
            brace_depth += 1;
            i += 1;
            continue;
        }
        if tok.text == "}" {
            brace_depth = brace_depth.saturating_sub(1);
            i += 1;
            continue;
        }
        if brace_depth == 0
            && tok.text == "pub"
            && tokens.get(i + 1).is_some_and(|t| t.text == "enum")
            && let Some(name_tok) = tokens.get(i + 2)
            && tokens.get(i + 3).is_some_and(|t| t.text == "{")
        {
            let attr_start = find_attr_block_start(&tokens, i);
            let attr_raw = &file.text[tokens[attr_start].start..tok.start];
            let open_brace_idx = i + 3;
            let close_brace_idx = find_matching_token_brace(&tokens, open_brace_idx);
            if !has_serde_tag_attr(attr_raw)
                && let Some(variants) = parse_unit_enum_variants(&file.text, &tokens[open_brace_idx + 1..close_brace_idx], parse_serde_rename_all(attr_raw))
            {
                enums.push(ProtocolEnum {
                    name: name_tok.text.clone(),
                    file: file.path.clone(),
                    variants,
                });
            }
            i = close_brace_idx + 1;
            continue;
        }
        i += 1;
    }

    enums
}

fn find_attr_block_start(tokens: &[SpanToken], item_idx: usize) -> usize {
    let mut idx = item_idx;
    while idx >= 2 && tokens[idx - 1].text == "]" {
        let mut depth = 0usize;
        let mut cur = idx - 1;
        loop {
            if tokens[cur].text == "]" {
                depth += 1;
            } else if tokens[cur].text == "[" {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    if cur > 0 && tokens[cur - 1].text == "#" {
                        idx = cur - 1;
                    }
                    break;
                }
            }
            if cur == 0 {
                break;
            }
            cur -= 1;
        }
        if cur == 0 || (tokens[cur].text != "[" && tokens[cur].text != "#") {
            break;
        }
        if idx == item_idx {
            break;
        }
        if idx > 0 && tokens[idx - 1].text != "]" {
            break;
        }
    }
    idx
}

fn find_matching_token_brace(tokens: &[SpanToken], open_idx: usize) -> usize {
    let mut depth = 0usize;
    for (idx, tok) in tokens.iter().enumerate().skip(open_idx) {
        if tok.text == "{" {
            depth += 1;
        } else if tok.text == "}" {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return idx;
            }
        }
    }
    tokens.len().saturating_sub(1)
}

fn has_serde_tag_attr(raw_attrs: &str) -> bool {
    raw_attrs.contains("tag =") || raw_attrs.contains("tag=")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SerdeRenameAll {
    None,
    SnakeCase,
    CamelCase,
    KebabCase,
    Lowercase,
    Uppercase,
    ScreamingSnakeCase,
    PascalCase,
}

fn parse_serde_rename_all(raw: &str) -> SerdeRenameAll {
    let Some(val) = extract_serde_kv(raw, "rename_all") else {
        return SerdeRenameAll::None;
    };
    match val.as_str() {
        "snake_case" => SerdeRenameAll::SnakeCase,
        "camelCase" => SerdeRenameAll::CamelCase,
        "kebab-case" => SerdeRenameAll::KebabCase,
        "lowercase" => SerdeRenameAll::Lowercase,
        "UPPERCASE" => SerdeRenameAll::Uppercase,
        "SCREAMING_SNAKE_CASE" => SerdeRenameAll::ScreamingSnakeCase,
        "PascalCase" => SerdeRenameAll::PascalCase,
        _ => SerdeRenameAll::None,
    }
}

fn extract_serde_kv(raw: &str, key: &str) -> Option<String> {
    let mut rest = raw;
    while let Some(pos) = rest.find(key) {
        let before_ok = pos == 0 || !is_ident_char(rest.as_bytes()[pos - 1]);
        let after = rest[pos + key.len()..].trim_start();
        if before_ok && let Some(after_eq) = after.strip_prefix('=') {
            let after_eq = after_eq.trim_start();
            if let Some(after_quote) = after_eq.strip_prefix('"')
                && let Some(end_quote) = after_quote.find('"')
            {
                return Some(after_quote[..end_quote].to_owned());
            }
        }
        rest = &rest[pos + key.len()..];
    }
    None
}

fn apply_serde_rename(ident: &str, rule: SerdeRenameAll) -> String {
    match rule {
        SerdeRenameAll::None | SerdeRenameAll::PascalCase => ident.to_owned(),
        SerdeRenameAll::Lowercase => ident.to_ascii_lowercase(),
        SerdeRenameAll::Uppercase => ident.to_ascii_uppercase(),
        SerdeRenameAll::CamelCase => {
            let mut chars = ident.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_ascii_lowercase(), chars.as_str()),
                None => String::new(),
            }
        }
        SerdeRenameAll::SnakeCase => split_pascal_words(ident).join("_").to_ascii_lowercase(),
        SerdeRenameAll::ScreamingSnakeCase => split_pascal_words(ident).join("_").to_ascii_uppercase(),
        SerdeRenameAll::KebabCase => split_pascal_words(ident).join("-").to_ascii_lowercase(),
    }
}

fn split_pascal_words(ident: &str) -> Vec<String> {
    let chars: Vec<char> = ident.chars().collect();
    let mut words = Vec::new();
    let mut cur = String::new();
    for (idx, &ch) in chars.iter().enumerate() {
        let prev_lower = idx > 0 && chars[idx - 1].is_ascii_lowercase();
        let next_lower = idx + 1 < chars.len() && chars[idx + 1].is_ascii_lowercase();
        let prev_upper = idx > 0 && chars[idx - 1].is_ascii_uppercase();
        if !cur.is_empty() && ch.is_ascii_uppercase() && (prev_lower || (prev_upper && next_lower)) {
            words.push(cur);
            cur = String::new();
        }
        cur.push(ch);
    }
    if !cur.is_empty() {
        words.push(cur);
    }
    words
}

fn parse_unit_enum_variants(raw_file: &str, body_tokens: &[SpanToken], rename_all: SerdeRenameAll) -> Option<BTreeSet<String>> {
    let mut variants = BTreeSet::new();
    let mut parts: Vec<&[SpanToken]> = Vec::new();
    let mut start = 0usize;
    let mut bracket_depth = 0usize;
    let mut paren_depth = 0usize;
    let mut brace_depth = 0usize;

    for (idx, tok) in body_tokens.iter().enumerate() {
        match tok.text.as_str() {
            "[" => bracket_depth += 1,
            "]" => bracket_depth = bracket_depth.saturating_sub(1),
            "(" => paren_depth += 1,
            ")" => paren_depth = paren_depth.saturating_sub(1),
            "{" => brace_depth += 1,
            "}" => brace_depth = brace_depth.saturating_sub(1),
            "," if bracket_depth == 0 && paren_depth == 0 && brace_depth == 0 => {
                parts.push(&body_tokens[start..idx]);
                start = idx + 1;
            }
            _ => {}
        }
    }
    if start < body_tokens.len() {
        parts.push(&body_tokens[start..]);
    }

    for part in parts {
        if part.is_empty() {
            continue;
        }
        // Any tuple/struct variant disqualifies the enum as a closed string-enum.
        let mut attr_bracket_depth = 0usize;
        for tok in part {
            if tok.text == "[" {
                attr_bracket_depth += 1;
            } else if tok.text == "]" {
                attr_bracket_depth = attr_bracket_depth.saturating_sub(1);
            } else if attr_bracket_depth == 0 && (tok.text == "(" || tok.text == "{") {
                return None;
            }
        }
        let variant_tok = part.last()?;
        if !variant_tok.text.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') {
            return None;
        }
        let raw_attrs = &raw_file[part[0].start..variant_tok.start];
        let wire = extract_serde_kv(raw_attrs, "rename").unwrap_or_else(|| apply_serde_rename(&variant_tok.text, rename_all));
        variants.insert(wire);
    }

    Some(variants)
}

fn scan_ts_file_for_enum_mirrors(file: &SourceFile, enums: &[ProtocolEnum]) -> Vec<SsotDiagnostic> {
    let stripped = strip_ts_comments_preserving_offsets(&file.text);
    let line_index = LineIndex::new(&file.text);
    let bytes = stripped.as_bytes();
    let len = bytes.len();
    let mut diagnostics = Vec::new();
    let mut i = 0usize;

    while i < len {
        let b = bytes[i];
        if b == b'\'' || b == b'"' || b == b'`' {
            i = skip_ts_string_or_template(bytes, i);
            continue;
        }
        if b != b'[' {
            i += utf8_char_len(bytes, i);
            continue;
        }

        // Skip type annotations or property access indexing (`foo[0]`, `arr["a"]`)
        if is_ts_indexing_or_type_bracket(bytes, i) {
            i += 1;
            continue;
        }

        if let Some((close_idx, items)) = parse_ts_string_literal_array(&stripped, i) {
            if items.len() >= 3 {
                let unique: BTreeSet<String> = items.into_iter().collect();
                if unique.len() >= 3
                    && let Some((matched_enum, overlap)) = best_matching_protocol_enum(&unique, enums)
                {
                    let line = line_index.line_at(i);
                    let symbol = infer_ts_binding_name(&stripped, i).unwrap_or_else(|| "<array>".to_owned());
                    let matched_list: Vec<&str> = overlap.iter().map(String::as_str).collect();
                    diagnostics.push(SsotDiagnostic {
                        rule: SsotRule::TsEnumMirror,
                        severity: Severity::Warning,
                        file: file.path.clone(),
                        line,
                        symbol,
                        why: format!(
                            "TS string array mirrors {}/{} variants of `{}::{}` ({})",
                            overlap.len(),
                            matched_enum.variants.len(),
                            matched_enum.file,
                            matched_enum.name,
                            matched_list.join(", ")
                        ),
                        fix_hint: format!(
                            "import `{}Values` / `{}` from `@vibevalley/protocol` instead of duplicating variants",
                            matched_enum.name, matched_enum.name
                        ),
                    });
                }
            }
            i = close_idx + 1;
            continue;
        }

        i += 1;
    }

    diagnostics
}

fn skip_ts_string_or_template(bytes: &[u8], start: usize) -> usize {
    let quote = bytes[start];
    let mut i = start + 1;
    let len = bytes.len();
    while i < len {
        if bytes[i] == b'\\' {
            i += 1;
            i += utf8_char_len(bytes, i);
            continue;
        }
        if bytes[i] == quote {
            return i + 1;
        }
        if quote != b'`' && bytes[i] == b'\n' {
            return i;
        }
        i += utf8_char_len(bytes, i);
    }
    len
}

fn is_ts_indexing_or_type_bracket(bytes: &[u8], open_idx: usize) -> bool {
    let mut idx = open_idx;
    while idx > 0 && bytes[idx - 1].is_ascii_whitespace() {
        idx -= 1;
    }
    if idx == 0 {
        return false;
    }
    let prev = bytes[idx - 1];
    is_ident_char(prev) || prev == b')' || prev == b']'
}

fn parse_ts_string_literal_array(source: &str, open_idx: usize) -> Option<(usize, Vec<String>)> {
    let bytes = source.as_bytes();
    let len = bytes.len();
    let mut i = open_idx + 1;
    let mut items = Vec::new();
    let mut expecting_item = true;

    while i < len {
        while i < len && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= len {
            return None;
        }
        if bytes[i] == b']' {
            return Some((i, items));
        }
        if !expecting_item {
            if bytes[i] == b',' {
                i += 1;
                expecting_item = true;
                continue;
            }
            return None;
        }
        let quote = bytes[i];
        if quote != b'"' && quote != b'\'' {
            return None;
        }
        let end = skip_ts_string_or_template(bytes, i);
        let raw_lit = &source[i..end];
        let val = unquote_string_literal(raw_lit)?;
        items.push(val);
        i = end;
        expecting_item = false;
    }
    None
}

fn best_matching_protocol_enum<'a>(ts_items: &BTreeSet<String>, enums: &'a [ProtocolEnum]) -> Option<(&'a ProtocolEnum, Vec<String>)> {
    let mut best: Option<(&ProtocolEnum, Vec<String>)> = None;
    for proto in enums {
        let overlap: Vec<String> = ts_items.intersection(&proto.variants).cloned().collect();
        if overlap.len() < 3 {
            continue;
        }
        let replace = match &best {
            None => true,
            Some((cur_enum, cur_overlap)) => {
                let new_score = (overlap.len(), overlap.len() * 1000 / proto.variants.len().max(1));
                let cur_score = (cur_overlap.len(), cur_overlap.len() * 1000 / cur_enum.variants.len().max(1));
                new_score > cur_score || (new_score == cur_score && proto.name < cur_enum.name)
            }
        };
        if replace {
            best = Some((proto, overlap));
        }
    }
    best
}

fn infer_ts_binding_name(source: &str, open_idx: usize) -> Option<String> {
    let prefix = source[..open_idx].trim_end();
    if let Some(before_eq) = prefix.strip_suffix('=') {
        let before_eq = before_eq.trim_end();
        // Skip optional type annotation `: Type`
        let head = if let Some(colon_idx) = before_eq.rfind(':') {
            let after_colon = &before_eq[colon_idx + 1..];
            if !after_colon.contains('=') && !after_colon.contains('{') && !after_colon.contains('(') {
                before_eq[..colon_idx].trim_end()
            } else {
                before_eq
            }
        } else {
            before_eq
        };
        return trailing_ident(head);
    }
    if let Some(before_colon) = prefix.strip_suffix(':') {
        return trailing_ident(before_colon.trim_end());
    }
    None
}

fn trailing_ident(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let end = bytes.len();
    let mut start = end;
    while start > 0 && is_ident_char(bytes[start - 1]) {
        start -= 1;
    }
    (start < end && is_ident_start(bytes[start])).then(|| text[start..end].to_owned())
}

// ============================================================================
// Rule 2: host-dto-bypass
// ============================================================================

fn check_host_dto_bypass(root: &Path) -> Result<(Vec<SsotDiagnostic>, Vec<String>), String> {
    let files = collect_non_test_rust_files(root, &["apps/mac/src"])?;
    let mut diagnostics = Vec::new();
    let mut scanned = Vec::with_capacity(files.len());

    for (file, stripped) in &files {
        scanned.push(file.path.clone());
        let line_index = LineIndex::new(&file.text);
        let tokens = tokenize_rust_ident_and_punct(stripped);
        let mut i = 0usize;

        while i < tokens.len() {
            if (tokens[i].text == "struct" || tokens[i].text == "enum")
                && let Some(name_tok) = tokens.get(i + 1)
                && is_ident_start(name_tok.text.as_bytes()[0])
            {
                let attr_start = find_item_attr_start(&tokens, i);
                if derive_has_serde(&tokens[attr_start..i]) && !is_allowlisted_host_dto(&file.path, &name_tok.text) {
                    let line = line_index.line_at(tokens[i].start);
                    diagnostics.push(SsotDiagnostic {
                        rule: SsotRule::HostDtoBypass,
                        severity: Severity::Warning,
                        file: file.path.clone(),
                        line,
                        symbol: name_tok.text.clone(),
                        why: format!(
                            "`{}` derives Serialize/Deserialize inside `apps/mac/src` outside `crates/protocol`",
                            name_tok.text
                        ),
                        fix_hint: "Move IPC/Bridge DTO definitions into `crates/protocol/src/contract/` and import from `vibevalley_protocol`".to_owned(),
                    });
                }
            }
            i += 1;
        }
    }

    Ok((diagnostics, scanned))
}

fn find_item_attr_start(tokens: &[SpanToken], item_kw_idx: usize) -> usize {
    let mut idx = item_kw_idx;
    while idx > 0 {
        let prev = &tokens[idx - 1].text;
        if prev == "pub" || prev == "async" || prev == "unsafe" {
            idx -= 1;
            continue;
        }
        if prev == ")" && idx >= 2 {
            // Skip visibility qualifier like `pub(crate)` or `pub(super)`
            let mut paren = 0usize;
            let mut cur = idx - 1;
            let mut found = false;
            loop {
                if tokens[cur].text == ")" {
                    paren += 1;
                } else if tokens[cur].text == "(" {
                    paren = paren.saturating_sub(1);
                    if paren == 0 {
                        if cur > 0 && tokens[cur - 1].text == "pub" {
                            idx = cur - 1;
                            found = true;
                        }
                        break;
                    }
                }
                if cur == 0 {
                    break;
                }
                cur -= 1;
            }
            if found {
                continue;
            }
        }
        break;
    }
    find_attr_block_start(tokens, idx)
}

fn derive_has_serde(attr_tokens: &[SpanToken]) -> bool {
    let mut i = 0usize;
    while i + 3 < attr_tokens.len() {
        if attr_tokens[i].text == "#" && attr_tokens[i + 1].text == "[" && attr_tokens[i + 2].text == "derive" && attr_tokens[i + 3].text == "(" {
            let mut depth = 0usize;
            let mut j = i + 3;
            while j < attr_tokens.len() {
                if attr_tokens[j].text == "(" {
                    depth += 1;
                } else if attr_tokens[j].text == ")" {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        break;
                    }
                } else if attr_tokens[j].text == "Serialize" || attr_tokens[j].text == "Deserialize" {
                    return true;
                }
                j += 1;
            }
            i = j + 1;
            continue;
        }
        i += 1;
    }
    false
}

fn is_allowlisted_host_dto(file_path: &str, symbol: &str) -> bool {
    INTERNAL_HOST_DTO_ALLOWLIST
        .iter()
        .any(|&(allowed_file, allowed_sym, _)| file_path == allowed_file && symbol == allowed_sym)
}

// ============================================================================
// Rule 3: env-registry-drift
// ============================================================================

fn check_env_registry_drift(root: &Path) -> Result<(Vec<SsotDiagnostic>, Vec<String>), String> {
    let mut scanned = Vec::new();
    let mut canonical = BTreeSet::new();

    let home_path = root.join("crates/protocol/src/home.rs");
    if home_path.exists() {
        let home_raw = fs::read_to_string(&home_path).map_err(|err| format!("failed to read {}: {err}", home_path.display()))?;
        scanned.push("crates/protocol/src/home.rs".to_owned());
        canonical = extract_canonical_env_keys(&home_raw);
    }

    let mut diagnostics = Vec::new();

    let rust_files = collect_non_test_rust_files(root, &["crates", "apps"])?;
    for (file, stripped) in &rust_files {
        if is_excluded_env_rust_path(&file.path) {
            continue;
        }
        scanned.push(file.path.clone());
        let line_index = LineIndex::new(&file.text);
        let consts = collect_rust_string_consts(&file.text, stripped);
        for (key, offset) in find_rust_env_var_keys(&file.text, stripped, &consts) {
            if canonical.contains(&key) || is_standard_env_var(&key) {
                continue;
            }
            diagnostics.push(SsotDiagnostic {
                rule: SsotRule::EnvRegistryDrift,
                severity: Severity::Warning,
                file: file.path.clone(),
                line: line_index.line_at(offset),
                symbol: key.clone(),
                why: format!("env var `{key}` is read via `std::env::var*` without being registered in `crates/protocol/src/home.rs`"),
                fix_hint: format!("Register `{key}` in `crates/protocol/src/home.rs` (canonical env registry) and share it across crates/scripts"),
            });
        }
    }

    let ts_files = walk_matching_files(root, &["apps", "packages", "scripts"], |rel| {
        (rel.ends_with(".ts") || rel.ends_with(".tsx") || rel.ends_with(".js") || rel.ends_with(".mjs") || rel.ends_with(".mts")) && !is_excluded_ts_path(rel)
    })?;
    for file in &ts_files {
        scanned.push(file.path.clone());
        let comment_stripped = strip_ts_comments_preserving_offsets(&file.text);
        let line_index = LineIndex::new(&file.text);
        for (key, offset) in find_ts_process_env_keys(&comment_stripped) {
            if canonical.contains(&key) || is_standard_env_var(&key) {
                continue;
            }
            diagnostics.push(SsotDiagnostic {
                rule: SsotRule::EnvRegistryDrift,
                severity: Severity::Warning,
                file: file.path.clone(),
                line: line_index.line_at(offset),
                symbol: key.clone(),
                why: format!("env var `{key}` is read via `process.env` without being registered in `crates/protocol/src/home.rs`"),
                fix_hint: format!("Register `{key}` in `crates/protocol/src/home.rs` so Rust and TypeScript/scripts share one canonical registry"),
            });
        }
    }

    Ok((diagnostics, scanned))
}

fn is_excluded_env_rust_path(rel: &str) -> bool {
    rel.contains("/tests/")
        || rel.contains("/examples/")
        || rel.ends_with("/tests.rs")
        || rel.ends_with("_test.rs")
        || rel.ends_with("/vv_test_fixture.rs")
        || rel == "crates/protocol/src/home.rs"
}

fn extract_canonical_env_keys(home_raw: &str) -> BTreeSet<String> {
    let no_comments = strip_rust_comments_and_literals(home_raw);
    let non_test = strip_cfg_test_and_collect_excluded(home_raw, &no_comments, "crates/protocol/src/home.rs").code;
    let mut keys = BTreeSet::new();
    let consts = collect_rust_string_consts(home_raw, &non_test);
    for (key, _) in find_rust_env_var_keys(home_raw, &non_test, &consts) {
        keys.insert(key);
    }

    // Also accept SCREAMING_SNAKE_CASE string literals declared in non-test `home.rs`
    // (for example, a canonical `CANONICAL_ENV_VARS` registry slice or `pub const ENV_*`).
    for (lit, offset) in scan_rust_string_literals_in_non_test(home_raw, &non_test) {
        let _ = offset;
        if is_env_key_literal(&lit) && lit.contains('_') {
            keys.insert(lit);
        }
    }
    keys
}

fn scan_rust_string_literals_in_non_test(raw: &str, non_test_stripped: &str) -> Vec<(String, usize)> {
    let raw_bytes = raw.as_bytes();
    let stripped_bytes = non_test_stripped.as_bytes();
    let len = raw_bytes.len().min(stripped_bytes.len());
    let mut out = Vec::new();
    let mut i = 0usize;

    while i < len {
        // Skip regions already blanked by cfg(test) or comments, except when raw has '"' and stripped has ' '
        if raw_bytes[i] == b'"' && stripped_bytes[i] == b' ' {
            // Confirm it wasn't inside a comment or cfg(test) by checking if preceding non-space in stripped is valid,
            // or simply parse the string literal and ignore comment text (comments are blanked in both, wait: raw has //!).
            // Easier: only inspect '"' that is not inside a comment/cfg(test) by checking raw vs comment lines!
            if is_inside_rust_comment_or_cfg_test(raw_bytes, stripped_bytes, i) {
                i += 1;
                continue;
            }
            let start = i;
            i += 1;
            while i < len {
                if raw_bytes[i] == b'\\' {
                    i += 1;
                    i += utf8_char_len(raw_bytes, i);
                    continue;
                }
                if raw_bytes[i] == b'"' {
                    i += 1;
                    break;
                }
                i += utf8_char_len(raw_bytes, i);
            }
            if let Some(val) = unquote_string_literal(&raw[start..i]) {
                out.push((val, start));
            }
            continue;
        }
        i += utf8_char_len(raw_bytes, i);
    }
    out
}

fn is_inside_rust_comment_or_cfg_test(raw: &[u8], stripped: &[u8], pos: usize) -> bool {
    // Check if the current line has `//` before `pos` outside strings, or if a previous token on the line wasn't blanked.
    // Even simpler: find nearest non-whitespace byte in `stripped` before `pos`. If that region between them in `raw`
    // starts with `//` or `/*` or `#`, or if `pos` is inside a `#[cfg(test)]` blanked region, it's excluded.
    let mut line_start = pos;
    while line_start > 0 && raw[line_start - 1] != b'\n' {
        line_start -= 1;
    }
    let line_has_code_in_stripped = stripped[line_start..pos].iter().any(|&b| !b.is_ascii_whitespace());
    if line_has_code_in_stripped {
        return false;
    }
    // Check up to 3 previous lines for non-whitespace in `stripped` (multiline array / call)
    let mut check_from = line_start;
    for _ in 0..4 {
        if check_from == 0 {
            break;
        }
        check_from -= 1;
        while check_from > 0 && raw[check_from - 1] != b'\n' {
            check_from -= 1;
        }
        if stripped[check_from..pos].iter().any(|&b| !b.is_ascii_whitespace()) {
            return false;
        }
    }
    true
}

fn collect_rust_string_consts(raw: &str, stripped: &str) -> HashMap<String, String> {
    let tokens = tokenize_rust_ident_and_punct(stripped);
    let mut map = HashMap::new();
    let mut i = 0usize;
    while i + 5 < tokens.len() {
        if tokens[i].text == "const"
            && is_ident_start(tokens[i + 1].text.as_bytes()[0])
            && let Some(eq_idx) = tokens[i + 2..].iter().take(8).position(|t| t.text == "=")
        {
            let eq_pos = i + 2 + eq_idx;
            if let Some(semi_idx) = tokens[eq_pos + 1..].iter().take(4).position(|t| t.text == ";") {
                let expr_start = tokens[eq_pos].end;
                let expr_end = tokens[eq_pos + 1 + semi_idx].start;
                if let Some(val) = unquote_string_literal(&raw[expr_start..expr_end]) {
                    map.insert(tokens[i + 1].text.clone(), val);
                }
            }
        }
        i += 1;
    }
    map
}

fn find_rust_env_var_keys(raw: &str, stripped: &str, consts: &HashMap<String, String>) -> Vec<(String, usize)> {
    let tokens = tokenize_rust_ident_and_punct(stripped);
    let mut found = Vec::new();
    let mut i = 0usize;

    while i + 4 < tokens.len() {
        if tokens[i].text == "env" && tokens[i + 1].text == "::" && (tokens[i + 2].text == "var" || tokens[i + 2].text == "var_os") && tokens[i + 3].text == "("
        {
            let mut depth = 0usize;
            let mut close = None;
            for (idx, tok) in tokens.iter().enumerate().skip(i + 3) {
                if tok.text == "(" {
                    depth += 1;
                } else if tok.text == ")" {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        close = Some(idx);
                        break;
                    }
                }
            }
            if let Some(close_idx) = close {
                let arg_slice = raw[tokens[i + 3].end..tokens[close_idx].start].trim();
                if let Some(lit) = unquote_string_literal(arg_slice) {
                    if is_env_key_literal(&lit) {
                        found.push((lit, tokens[i].start));
                    }
                } else if close_idx == i + 5
                    && let Some(val) = consts.get(&tokens[i + 4].text)
                    && is_env_key_literal(val)
                {
                    found.push((val.clone(), tokens[i].start));
                }
                i = close_idx + 1;
                continue;
            }
        }
        i += 1;
    }

    found
}

fn find_ts_process_env_keys(comment_stripped: &str) -> Vec<(String, usize)> {
    let bytes = comment_stripped.as_bytes();
    let len = bytes.len();
    let mut found = Vec::new();
    let mut i = 0usize;

    while i < len {
        if bytes[i] == b'\'' || bytes[i] == b'"' || bytes[i] == b'`' {
            i = skip_ts_string_or_template(bytes, i);
            continue;
        }
        if bytes[i..].starts_with(b"process.env") {
            let prev_ok = i == 0 || !is_ident_char(bytes[i - 1]);
            let after_idx = i + "process.env".len();
            if prev_ok && after_idx < len {
                if bytes[after_idx] == b'.' {
                    let mut end = after_idx + 1;
                    if end < len && is_ident_start(bytes[end]) {
                        while end < len && is_ident_char(bytes[end]) {
                            end += 1;
                        }
                        let key = &comment_stripped[after_idx + 1..end];
                        if is_env_key_literal(key) {
                            found.push((key.to_owned(), i));
                        }
                        i = end;
                        continue;
                    }
                } else if bytes[after_idx] == b'[' {
                    let mut cur = after_idx + 1;
                    while cur < len && bytes[cur].is_ascii_whitespace() {
                        cur += 1;
                    }
                    if cur < len && (bytes[cur] == b'"' || bytes[cur] == b'\'') {
                        let lit_end = skip_ts_string_or_template(bytes, cur);
                        if let Some(key) = unquote_string_literal(&comment_stripped[cur..lit_end])
                            && is_env_key_literal(&key)
                        {
                            found.push((key, i));
                        }
                        i = lit_end;
                        continue;
                    }
                }
            }
        }
        i += utf8_char_len(bytes, i);
    }

    found
}

fn is_env_key_literal(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_') && s.bytes().any(|b| b.is_ascii_uppercase())
}

fn is_standard_env_var(key: &str) -> bool {
    STANDARD_ENV_VARS.contains(&key) || STANDARD_ENV_PREFIXES.iter().any(|prefix| key.starts_with(prefix))
}

// ============================================================================
// Rule 4: structural-clone-radar
// ============================================================================

#[derive(Debug, Clone)]
struct NormalizedLine {
    orig_line: usize,
    tokens: Vec<u32>,
    hash: u64,
    has_logic_marker: bool,
}

struct NormalizedFile {
    path: String,
    is_rust: bool,
    lines: Vec<NormalizedLine>,
}

#[derive(Default)]
struct TokenInterner {
    to_id: HashMap<String, u32>,
    logic_marker_ids: HashSet<u32>,
}

impl TokenInterner {
    fn new() -> Self {
        let mut interner = Self::default();
        for marker in [
            "fn", "function", "if", "match", "switch", "for", "while", "loop", "return", "=>", "=", "try", "catch",
        ] {
            let id = interner.intern(marker);
            interner.logic_marker_ids.insert(id);
        }
        interner
    }

    fn intern(&mut self, tok: &str) -> u32 {
        if let Some(&id) = self.to_id.get(tok) {
            return id;
        }
        let id = u32::try_from(self.to_id.len()).expect("token vocabulary fits u32");
        self.to_id.insert(tok.to_owned(), id);
        id
    }
}

fn check_structural_clones(root: &Path, min_lines: usize) -> Result<(Vec<CloneFinding>, Vec<String>), String> {
    let rust_files = collect_non_test_rust_files(root, &["crates/server/src"])?;
    let ts_files = walk_matching_files(root, &["apps/mac/ui", "apps/mobile"], |rel| {
        (rel.ends_with(".ts") || rel.ends_with(".tsx")) && !is_excluded_ts_path(rel)
    })?;

    let mut interner = TokenInterner::new();
    let mut norm_files = Vec::new();
    let mut scanned = Vec::new();

    for (file, stripped) in &rust_files {
        scanned.push(file.path.clone());
        let lines = normalize_rust_file_lines(&file.text, stripped, &mut interner);
        if lines.len() >= min_lines {
            norm_files.push(NormalizedFile {
                path: file.path.clone(),
                is_rust: true,
                lines,
            });
        }
    }

    for file in &ts_files {
        scanned.push(file.path.clone());
        let lines = normalize_ts_file_lines(&file.text, &mut interner);
        if lines.len() >= min_lines {
            norm_files.push(NormalizedFile {
                path: file.path.clone(),
                is_rust: false,
                lines,
            });
        }
    }

    let clones = detect_clones_across_files(&norm_files, min_lines);
    Ok((clones, scanned))
}

fn normalize_rust_file_lines(raw: &str, non_test_stripped: &str, interner: &mut TokenInterner) -> Vec<NormalizedLine> {
    // Blank comments & cfg(test) while preserving literals as `$STR` / `$NUM` using raw lines where non-test code lives.
    let raw_lines: Vec<&str> = raw.split('\n').collect();
    let stripped_lines: Vec<&str> = non_test_stripped.split('\n').collect();
    let mut out = Vec::new();

    for (idx, stripped_line) in stripped_lines.iter().enumerate() {
        let trimmed = stripped_line.trim();
        if trimmed.is_empty()
            || trimmed.starts_with("use ")
            || trimmed.starts_with("pub use ")
            || trimmed.starts_with("mod ")
            || trimmed.starts_with("pub mod ")
            || trimmed.starts_with("#[")
        {
            continue;
        }
        let raw_line = raw_lines.get(idx).copied().unwrap_or(stripped_line);
        let tokens = tokenize_normalized_line(raw_line, stripped_line, true, interner);
        if tokens.is_empty() {
            continue;
        }
        let has_logic_marker = tokens.iter().any(|t| interner.logic_marker_ids.contains(t));
        let hash = fnv1a_u32(&tokens);
        out.push(NormalizedLine {
            orig_line: idx + 1,
            tokens,
            hash,
            has_logic_marker,
        });
    }
    out
}

fn normalize_ts_file_lines(raw: &str, interner: &mut TokenInterner) -> Vec<NormalizedLine> {
    let no_comments = strip_ts_comments_preserving_offsets(raw);
    let mut out = Vec::new();

    for (idx, line) in no_comments.split('\n').enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("import ") || trimmed.starts_with("export type ") {
            continue;
        }
        let tokens = tokenize_normalized_line(line, line, false, interner);
        if tokens.is_empty() {
            continue;
        }
        let has_logic_marker = tokens.iter().any(|t| interner.logic_marker_ids.contains(t));
        let hash = fnv1a_u32(&tokens);
        out.push(NormalizedLine {
            orig_line: idx + 1,
            tokens,
            hash,
            has_logic_marker,
        });
    }
    out
}

fn tokenize_normalized_line(raw_line: &str, stripped_line: &str, is_rust: bool, interner: &mut TokenInterner) -> Vec<u32> {
    let bytes = raw_line.as_bytes();
    let sbytes = stripped_line.as_bytes();
    let len = bytes.len();
    let mut tokens = Vec::new();
    let mut i = 0usize;

    while i < len {
        // Skip comments or cfg(test)-blanked regions in Rust
        if is_rust && i < sbytes.len() && sbytes[i] == b' ' && bytes[i] == b'/' {
            if bytes.get(i + 1) == Some(&b'/') {
                break;
            }
            if bytes.get(i + 1) == Some(&b'*') {
                i += 2;
                while i < len && !(bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/')) {
                    i += utf8_char_len(bytes, i);
                }
                i = (i + 2).min(len);
                continue;
            }
        }
        let b = bytes[i];
        if b.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if b == b'"' || b == b'\'' || (!is_rust && b == b'`') {
            // In Rust, skip `'a` lifetime vs char literal
            if is_rust && b == b'\'' && bytes.get(i + 1).is_some_and(|&c| is_ident_start(c)) && bytes.get(i + 2) != Some(&b'\'') {
                i += 1;
                while i < len && is_ident_char(bytes[i]) {
                    i += 1;
                }
                tokens.push(interner.intern("$LT"));
                continue;
            }
            let end = skip_ts_string_or_template(bytes, i);
            tokens.push(interner.intern("$STR"));
            i = end;
            continue;
        }
        if b.is_ascii_digit() {
            while i < len && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'.') {
                i += 1;
            }
            tokens.push(interner.intern("$NUM"));
            continue;
        }
        if is_ident_start(b) {
            let start = i;
            i += 1;
            while i < len && is_ident_char(bytes[i]) {
                i += 1;
            }
            let ident = &raw_line[start..i];
            let norm = if is_preserved_keyword(ident, is_rust) { ident } else { "$ID" };
            tokens.push(interner.intern(norm));
            continue;
        }
        // Multi-char punctuation
        if b < 0x80 && i + 1 < len && bytes[i + 1] < 0x80 {
            let two = &raw_line[i..i + 2];
            if matches!(two, "::" | "=>" | "->" | "&&" | "||" | "==" | "!=" | "<=" | ">=" | "+=" | "-=") {
                tokens.push(interner.intern(two));
                i += 2;
                continue;
            }
        }
        let step = utf8_char_len(bytes, i);
        tokens.push(interner.intern(&raw_line[i..i + step]));
        i += step;
    }
    tokens
}

fn is_preserved_keyword(ident: &str, is_rust: bool) -> bool {
    if is_rust {
        matches!(
            ident,
            "fn" | "pub"
                | "async"
                | "await"
                | "let"
                | "mut"
                | "const"
                | "static"
                | "if"
                | "else"
                | "match"
                | "for"
                | "while"
                | "loop"
                | "in"
                | "return"
                | "break"
                | "continue"
                | "struct"
                | "enum"
                | "impl"
                | "trait"
                | "type"
                | "where"
                | "move"
                | "ref"
                | "as"
                | "self"
                | "Self"
                | "crate"
                | "super"
                | "true"
                | "false"
                | "Some"
                | "None"
                | "Ok"
                | "Err"
                | "Result"
                | "Option"
        )
    } else {
        matches!(
            ident,
            "function"
                | "const"
                | "let"
                | "var"
                | "if"
                | "else"
                | "switch"
                | "case"
                | "default"
                | "for"
                | "of"
                | "in"
                | "while"
                | "do"
                | "return"
                | "break"
                | "continue"
                | "try"
                | "catch"
                | "finally"
                | "throw"
                | "async"
                | "await"
                | "new"
                | "typeof"
                | "instanceof"
                | "export"
                | "import"
                | "from"
                | "as"
                | "interface"
                | "type"
                | "true"
                | "false"
                | "null"
                | "undefined"
                | "this"
        )
    }
}

fn fnv1a_u32(values: &[u32]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &v in values {
        for b in v.to_le_bytes() {
            hash ^= u64::from(b);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    hash
}

fn shingle_hash(lines: &[NormalizedLine]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for line in lines {
        for b in line.hash.to_le_bytes() {
            hash ^= u64::from(b);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    hash
}

fn detect_clones_across_files(files: &[NormalizedFile], min_lines: usize) -> Vec<CloneFinding> {
    let shingle_len = CLONE_SHINGLE_LINES.min(min_lines.max(1));
    let mut index: HashMap<u64, Vec<(usize, usize)>> = HashMap::new();

    for (file_idx, file) in files.iter().enumerate() {
        if file.lines.len() < min_lines {
            continue;
        }
        for start in 0..=file.lines.len() - shingle_len {
            let slice = &file.lines[start..start + shingle_len];
            let tok_count: usize = slice.iter().map(|l| l.tokens.len()).sum();
            if tok_count < shingle_len * 3 {
                continue;
            }
            let h = shingle_hash(slice);
            index.entry(h).or_default().push((file_idx, start));
        }
    }

    // Deduplicate candidate window pairs by `(file_a, file_b, start_a_bucket, start_b_bucket)`
    let mut seen_diagonals: HashSet<(usize, usize, isize)> = HashSet::new();
    let mut raw_findings: Vec<(usize, usize, usize, usize, f64)> = Vec::new();

    for locations in index.values() {
        if locations.len() < 2 || locations.len() > CLONE_MAX_SHINGLE_FREQ {
            continue;
        }
        for (idx_a, &(fa, la)) in locations.iter().enumerate() {
            for &(fb, lb) in &locations[idx_a + 1..] {
                if files[fa].is_rust != files[fb].is_rust {
                    continue;
                }
                if fa == fb && lb < la + min_lines {
                    continue;
                }
                let diag = (lb as isize - la as isize) / 4;
                if !seen_diagonals.insert((fa, fb, diag)) {
                    continue;
                }

                // Expand backwards/forwards to align the window start on the earliest matching neighborhood
                let (win_a, win_b) = align_candidate_window(&files[fa].lines, la, &files[fb].lines, lb, min_lines);
                if win_a + min_lines > files[fa].lines.len() || win_b + min_lines > files[fb].lines.len() {
                    continue;
                }
                if fa == fb && win_b < win_a + min_lines {
                    continue;
                }

                let slice_a = &files[fa].lines[win_a..win_a + min_lines];
                let slice_b = &files[fb].lines[win_b..win_b + min_lines];
                if !window_has_enough_structure(slice_a, min_lines) || !window_has_enough_structure(slice_b, min_lines) {
                    continue;
                }

                let toks_a = flatten_window_tokens(slice_a);
                let toks_b = flatten_window_tokens(slice_b);
                let sim = normalized_token_similarity(&toks_a, &toks_b);
                if sim >= CLONE_SIMILARITY_THRESHOLD {
                    raw_findings.push((fa, win_a, fb, win_b, (sim * 100.0).round() / 100.0));
                }
            }
        }
    }

    // Suppress overlapping reports within the same (fa, fb) pair
    raw_findings.sort_by(|a, b| b.4.total_cmp(&a.4).then_with(|| a.0.cmp(&b.0)).then_with(|| a.1.cmp(&b.1)));
    let mut kept: Vec<(usize, usize, usize, usize, f64)> = Vec::new();
    for cand in raw_findings {
        let overlaps = kept
            .iter()
            .any(|prev| prev.0 == cand.0 && prev.2 == cand.2 && prev.1.abs_diff(cand.1) < min_lines && prev.3.abs_diff(cand.3) < min_lines);
        if !overlaps {
            kept.push(cand);
        }
    }

    let mut out: Vec<CloneFinding> = kept
        .into_iter()
        .map(|(fa, wa, fb, wb, sim)| {
            let line = files[fa].lines[wa].orig_line;
            let peer_line = files[fb].lines[wb].orig_line;
            let fix_hint = if files[fa].is_rust {
                "Extract shared helper or parameterize differences inside the domain module instead of duplicating logic".to_owned()
            } else {
                "Extract shared helper or component into a common module under `apps/mac/ui` or `@vibevalley/*`".to_owned()
            };
            CloneFinding {
                file: files[fa].path.clone(),
                line,
                peer_file: files[fb].path.clone(),
                peer_line,
                similarity: sim,
                fix_hint,
            }
        })
        .collect();

    out.sort_by(|a, b| {
        a.file
            .cmp(&b.file)
            .then_with(|| a.line.cmp(&b.line))
            .then_with(|| a.peer_file.cmp(&b.peer_file))
            .then_with(|| a.peer_line.cmp(&b.peer_line))
    });
    out
}

fn align_candidate_window(lines_a: &[NormalizedLine], mut pos_a: usize, lines_b: &[NormalizedLine], mut pos_b: usize, min_lines: usize) -> (usize, usize) {
    // Walk backwards while lines match (allowing small 1-line edits), stopping if we would exceed a reasonable lookback
    let mut back = 0usize;
    while pos_a > 0 && pos_b > 0 && back < min_lines {
        if lines_a[pos_a - 1].hash == lines_b[pos_b - 1].hash {
            pos_a -= 1;
            pos_b -= 1;
            back += 1;
        } else if pos_a > 1 && pos_b > 1 && lines_a[pos_a - 2].hash == lines_b[pos_b - 2].hash {
            pos_a -= 2;
            pos_b -= 2;
            back += 2;
        } else {
            break;
        }
    }
    (pos_a, pos_b)
}

fn window_has_enough_structure(lines: &[NormalizedLine], min_lines: usize) -> bool {
    let total_tokens: usize = lines.iter().map(|l| l.tokens.len()).sum();
    let logic_lines = lines.iter().filter(|l| l.has_logic_marker).count();
    total_tokens >= min_lines * CLONE_MIN_TOKENS_PER_LINE_AVG && logic_lines >= 2
}

fn flatten_window_tokens(lines: &[NormalizedLine]) -> Vec<u32> {
    let cap: usize = lines.iter().map(|l| l.tokens.len()).sum();
    let mut out = Vec::with_capacity(cap);
    for l in lines {
        out.extend_from_slice(&l.tokens);
    }
    out
}

fn normalized_token_similarity(a: &[u32], b: &[u32]) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let total = a.len() + b.len();
    let max_possible = 2.0 * a.len().min(b.len()) as f64 / total as f64;
    if max_possible < CLONE_SIMILARITY_THRESHOLD {
        return 0.0;
    }

    // 2-row DP LCS on normalized token IDs
    let (short, long) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    let mut prev = vec![0usize; short.len() + 1];
    let mut curr = vec![0usize; short.len() + 1];

    for &tok_l in long {
        curr[0] = 0;
        for (j, &tok_s) in short.iter().enumerate() {
            curr[j + 1] = if tok_l == tok_s { prev[j] + 1 } else { prev[j + 1].max(curr[j]) };
        }
        std::mem::swap(&mut prev, &mut curr);
    }

    let lcs = prev[short.len()];
    2.0 * lcs as f64 / total as f64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new(prefix: &str) -> Self {
            static SEQ: AtomicU64 = AtomicU64::new(0);
            let id = SEQ.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("{prefix}-{}-{id}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("create temp dir");
            Self(dir)
        }

        fn write(&self, rel: &str, content: &str) {
            let full = self.0.join(rel);
            if let Some(parent) = full.parent() {
                fs::create_dir_all(parent).expect("create parent dirs");
            }
            fs::write(full, content).expect("write fixture file");
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn help_returns_zero() {
        assert_eq!(run(Path::new("."), &["--help".to_owned()]), Ok(0));
        assert_eq!(run(Path::new("."), &["-h".to_owned()]), Ok(0));
    }

    #[test]
    fn rule1_ts_enum_mirror_catches_hand_written_arrays_and_ignores_generated_and_tests() {
        let dir = TempDir::new("vv-ssot-r1");
        dir.write(
            "crates/protocol/src/contract/issue.rs",
            r#"
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueStatus {
    Backlog,
    Todo,
    InProgress,
    InReview,
    Done,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum TaggedNotClosed {
    Alpha { id: String },
    Beta { id: String },
    Gamma { id: String },
}
"#,
        );
        dir.write(
            "apps/mac/ui/features/issue/filters.ts",
            r#"
// Ignored comment: ["backlog", "todo", "in_progress"]
export const ACTIVE_STATUSES = ["todo", "in_progress", "in_review", "done"] as const;
export const TOO_SHORT_OVERLAP = ["todo", "done", "other"] as const;
export const UNRELATED = ["alpha", "beta", "gamma"] as const;
"#,
        );
        dir.write(
            "apps/mobile/src/shapes.gen.ts",
            r#"export const IssueStatusValues = ["backlog", "todo", "in_progress", "in_review", "done"] as const;"#,
        );
        dir.write(
            "apps/mobile/src/filters.test.ts",
            r#"export const TEST_STATUSES = ["backlog", "todo", "in_progress"];"#,
        );

        let report = check_workspace(
            &dir.0,
            SsotConfig {
                rule_filter: Some(SsotRule::TsEnumMirror),
                ..SsotConfig::default()
            },
        )
        .unwrap();

        assert_eq!(report.diagnostics.len(), 1);
        let d = &report.diagnostics[0];
        assert_eq!(d.rule, SsotRule::TsEnumMirror);
        assert_eq!(d.file, "apps/mac/ui/features/issue/filters.ts");
        assert_eq!(d.line, 3);
        assert_eq!(d.symbol, "ACTIVE_STATUSES");
        assert!(d.why.contains("IssueStatus"));
    }

    #[test]
    fn rule2_host_dto_bypass_flags_unlisted_dtos_and_respects_allowlist_and_cfg_test() {
        let dir = TempDir::new("vv-ssot-r2");
        dir.write(
            "apps/mac/src/theme.rs",
            r#"
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub font_size: f32,
}
"#,
        );
        dir.write(
            "apps/mac/src/update/releases.rs",
            r#"
#[derive(Deserialize)]
struct Build {
    version: String,
}
"#,
        );
        dir.write(
            "apps/mac/src/bridge_leak.rs",
            r#"
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RogueBridgePayload {
    pub ok: bool,
}

#[derive(Deserialize)]
pub(crate) enum RogueBridgeEnum {
    Ping,
    Pong,
}

#[cfg(test)]
mod tests {
    #[derive(serde::Serialize)]
    struct TestOnlyDto {
        x: i32,
    }
}
"#,
        );

        let report = check_workspace(
            &dir.0,
            SsotConfig {
                rule_filter: Some(SsotRule::HostDtoBypass),
                ..SsotConfig::default()
            },
        )
        .unwrap();

        assert_eq!(report.diagnostics.len(), 2);
        assert_eq!(report.diagnostics[0].rule, SsotRule::HostDtoBypass);
        assert_eq!(report.diagnostics[0].file, "apps/mac/src/bridge_leak.rs");
        assert_eq!(report.diagnostics[0].line, 3);
        assert_eq!(report.diagnostics[0].symbol, "RogueBridgePayload");
        assert_eq!(report.diagnostics[1].symbol, "RogueBridgeEnum");
    }

    #[test]
    fn rule3_env_registry_drift_flags_unregistered_vars_and_allows_home_and_standard_vars() {
        let dir = TempDir::new("vv-ssot-r3");
        dir.write(
            "crates/protocol/src/home.rs",
            r#"
pub const CANONICAL_PORT_ENV: &str = "VIBEVALLEY_PORT";
pub fn channel() -> Option<String> {
    std::env::var("VIBEVALLEY_CHANNEL").ok()
}
"#,
        );
        dir.write(
            "crates/server/src/config.rs",
            r#"
const CUSTOM_CONST_ENV: &str = "VIBEVALLEY_CONST_DRIFT";
pub fn load() {
    let _ = std::env::var("VIBEVALLEY_CHANNEL");
    let _ = std::env::var("VIBEVALLEY_PORT");
    let _ = std::env::var("PATH");
    let _ = std::env::var("HOME");
    let _ = std::env::var("RUST_LOG");
    let _ = std::env::var("CARGO_MANIFEST_DIR");
    let _ = std::env::var("VIBEVALLEY_ROGUE_FLAG");
    let _ = std::env::var(CUSTOM_CONST_ENV);
}
#[cfg(test)]
mod tests {
    fn test_only() {
        let _ = std::env::var("VIBEVALLEY_TEST_ONLY");
    }
}
"#,
        );
        dir.write(
            "scripts/check.ts",
            r#"
// process.env.VIBEVALLEY_COMMENTED
const a = process.env.CI;
const b = process.env.NODE_ENV;
const c = process.env.VIBEVALLEY_PORT;
const d = process.env["VIBEVALLEY_TS_DRIFT"];
"#,
        );

        let report = check_workspace(
            &dir.0,
            SsotConfig {
                rule_filter: Some(SsotRule::EnvRegistryDrift),
                ..SsotConfig::default()
            },
        )
        .unwrap();

        assert_eq!(report.diagnostics.len(), 3);
        assert_eq!(report.diagnostics[0].symbol, "VIBEVALLEY_ROGUE_FLAG");
        assert_eq!(report.diagnostics[0].file, "crates/server/src/config.rs");
        assert_eq!(report.diagnostics[0].line, 10);
        assert_eq!(report.diagnostics[1].symbol, "VIBEVALLEY_CONST_DRIFT");
        assert_eq!(report.diagnostics[1].line, 11);
        assert_eq!(report.diagnostics[2].symbol, "VIBEVALLEY_TS_DRIFT");
        assert_eq!(report.diagnostics[2].file, "scripts/check.ts");
        assert_eq!(report.diagnostics[2].line, 6);
    }

    #[test]
    fn rule4_structural_clone_radar_catches_renamed_copies_and_ignores_dissimilar_and_test_code() {
        let dir = TempDir::new("vv-ssot-r4");
        let block_a = (0..26)
            .map(|i| format!("    if item_{i}.is_ready() {{ let next_{i} = repo.save_item(item_{i}.id(), \"ok\").await?; total += next_{i}.count(); }}"))
            .collect::<Vec<_>>()
            .join("\n");
        let block_b = (0..26)
            .map(|i| format!("    if task_{i}.is_ready() {{ let saved_{i} = store.persist_task(task_{i}.key(), \"done\").await?; acc += saved_{i}.len(); }}"))
            .collect::<Vec<_>>()
            .join("\n");
        let unrelated = (0..26)
            .map(|i| format!("    match step_{i} {{ 0 => alpha_{i}(), 1 => beta_{i}(), _ => gamma_{i}() }}"))
            .collect::<Vec<_>>()
            .join("\n");

        dir.write("crates/server/src/issue/a.rs", &format!("pub async fn sync_items() {{\n{block_a}\n}}\n"));
        dir.write("crates/server/src/cron/b.rs", &format!("pub async fn sync_tasks() {{\n{block_b}\n}}\n"));
        dir.write(
            "crates/server/src/agent/c.rs",
            &format!("pub fn dispatch() {{\n{unrelated}\n}}\n#[cfg(test)]\nmod tests {{\nasync fn dup_in_test() {{\n{block_a}\n}}\n}}\n"),
        );

        let no_dupes = check_workspace(&dir.0, SsotConfig::default()).unwrap();
        assert!(no_dupes.clones.is_empty());

        let report = check_workspace(
            &dir.0,
            SsotConfig {
                dupes: true,
                min_lines: 25,
                rule_filter: Some(SsotRule::StructuralCloneRadar),
                ..SsotConfig::default()
            },
        )
        .unwrap();

        assert_eq!(report.clones.len(), 1);
        let clone = &report.clones[0];
        assert_eq!(clone.file, "crates/server/src/cron/b.rs");
        assert_eq!(clone.peer_file, "crates/server/src/issue/a.rs");
        assert!(clone.similarity >= 0.99);
        assert_eq!(report.diagnostics.len(), 1);
        assert_eq!(report.diagnostics[0].rule, SsotRule::StructuralCloneRadar);
    }

    #[test]
    fn strict_mode_exits_nonzero_when_findings_exist_and_default_exits_zero() {
        let dir = TempDir::new("vv-ssot-strict");
        dir.write("crates/protocol/src/home.rs", "pub fn ok() {}\n");
        dir.write(
            "crates/server/src/main.rs",
            "fn main() { let _ = std::env::var(\"VIBEVALLEY_UNREGISTERED\"); }\n",
        );

        assert_eq!(run(&dir.0, &["--rule".to_owned(), "env-registry-drift".to_owned()]), Ok(0));
        assert_eq!(
            run(&dir.0, &["--strict".to_owned(), "--rule".to_owned(), "env-registry-drift".to_owned()]),
            Ok(1)
        );
        assert_eq!(
            run(
                &dir.0,
                &[
                    "--dupes".to_owned(),
                    "--min-lines".to_owned(),
                    "10".to_owned(),
                    "--json".to_owned(),
                    "--rule".to_owned(),
                    "structural-clone-radar".to_owned(),
                ]
            ),
            Ok(0)
        );
    }
}
