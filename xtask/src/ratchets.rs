//! Async-concurrency & Tokio-slimming Rust ratchets.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use crate::rust_scan::{
    LineIndex, SourceFile, collect_cfg_test_submodules, is_excluded_by_cfg_test, is_ident_char, strip_rust_comments_and_literals, strip_rust_non_code,
    walk_matching_files,
};

const CONCURRENCY_DOC: &str = "docs/style/rust-async-concurrency.md";

/// Shrink-only ceiling for non-test `rt::block_on(` calls under `crates/server/src/`.
/// This ceiling may only decrease as sync wrappers migrate to async; never raise it.
pub const SERVER_BLOCK_ON_CEILING: usize = 71;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[allow(clippy::enum_variant_names)]
pub enum RustRatchetRule {
    NoPollster,
    NoThreadSleepInZeroedZones,
    NoMacRtHandle,
    NoRichSyncTryCurrent,
    NoRawTcpHttpMock,
    NoBlockOnInAsyncServer,
}

impl RustRatchetRule {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoPollster => "no-pollster",
            Self::NoThreadSleepInZeroedZones => "no-thread-sleep-in-zeroed-zones",
            Self::NoMacRtHandle => "no-mac-rt-handle",
            Self::NoRichSyncTryCurrent => "no-rich-sync-try-current",
            Self::NoRawTcpHttpMock => "no-raw-tcp-http-mock",
            Self::NoBlockOnInAsyncServer => "no-block-on-in-async-server",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RatchetViolation {
    pub rule: RustRatchetRule,
    pub file: String,
    pub line: usize,
    pub message: String,
    pub fix: String,
    pub see: &'static str,
    pub details: Vec<String>,
}

pub struct AuditRatchetsResult {
    pub files_scanned: usize,
    pub server_block_on_count: usize,
    pub server_block_on_ceiling: usize,
    pub violations: Vec<RatchetViolation>,
}

/// Strips TOML `#` comments outside string literals while keeping string values and line numbers intact.
pub fn strip_toml_comments(source: &str) -> String {
    let bytes = source.as_bytes();
    let len = bytes.len();
    let mut out = Vec::with_capacity(len);
    let mut i = 0usize;

    while i < len {
        let ch = bytes[i];
        if ch == b'"' && bytes.get(i + 1) == Some(&b'"') && bytes.get(i + 2) == Some(&b'"') {
            out.extend_from_slice(b"\"\"\"");
            i += 3;
            while i < len {
                if bytes[i] == b'\\' && i + 1 < len {
                    out.extend_from_slice(&bytes[i..i + 2]);
                    i += 2;
                    continue;
                }
                if bytes[i] == b'"' && bytes.get(i + 1) == Some(&b'"') && bytes.get(i + 2) == Some(&b'"') {
                    out.extend_from_slice(b"\"\"\"");
                    i += 3;
                    break;
                }
                out.push(bytes[i]);
                i += 1;
            }
            continue;
        }

        if ch == b'"' {
            out.push(b'"');
            i += 1;
            while i < len {
                if bytes[i] == b'\\' && i + 1 < len {
                    out.extend_from_slice(&bytes[i..i + 2]);
                    i += 2;
                    continue;
                }
                let b = bytes[i];
                out.push(b);
                i += 1;
                if b == b'"' || b == b'\n' {
                    break;
                }
            }
            continue;
        }

        if ch == b'\'' && bytes.get(i + 1) == Some(&b'\'') && bytes.get(i + 2) == Some(&b'\'') {
            out.extend_from_slice(b"'''");
            i += 3;
            while i < len {
                if bytes[i] == b'\'' && bytes.get(i + 1) == Some(&b'\'') && bytes.get(i + 2) == Some(&b'\'') {
                    out.extend_from_slice(b"'''");
                    i += 3;
                    break;
                }
                out.push(bytes[i]);
                i += 1;
            }
            continue;
        }

        if ch == b'\'' {
            out.push(b'\'');
            i += 1;
            while i < len {
                let b = bytes[i];
                out.push(b);
                i += 1;
                if b == b'\'' || b == b'\n' {
                    break;
                }
            }
            continue;
        }

        if ch == b'#' {
            while i < len && bytes[i] != b'\n' {
                out.push(b' ');
                i += 1;
            }
            continue;
        }

        out.push(ch);
        i += 1;
    }

    String::from_utf8(out).expect("TOML stripper preserves valid UTF-8")
}

fn has_word_boundary_before(bytes: &[u8], idx: usize) -> bool {
    idx == 0 || !is_ident_char(bytes[idx - 1])
}

fn has_word_boundary_after(bytes: &[u8], end: usize) -> bool {
    end >= bytes.len() || !is_ident_char(bytes[end])
}

fn find_word_matches(haystack: &str, needle: &str) -> Vec<usize> {
    let bytes = haystack.as_bytes();
    let mut matches = Vec::new();
    let mut cursor = 0usize;
    while let Some(rel) = haystack[cursor..].find(needle) {
        let start = cursor + rel;
        let end = start + needle.len();
        if has_word_boundary_before(bytes, start) && has_word_boundary_after(bytes, end) {
            matches.push(start);
        }
        cursor = end;
    }
    matches
}

fn find_prefixed_call_matches(haystack: &str, optional_prefix: &str, core: &str, require_paren: bool) -> Vec<usize> {
    let bytes = haystack.as_bytes();
    let mut matches = Vec::new();
    let mut cursor = 0usize;
    while let Some(rel) = haystack[cursor..].find(core) {
        let core_start = cursor + rel;
        let core_end = core_start + core.len();
        let after_ok = if require_paren {
            let mut p = core_end;
            while p < bytes.len() && bytes[p].is_ascii_whitespace() {
                p += 1;
            }
            bytes.get(p) == Some(&b'(')
        } else {
            has_word_boundary_after(bytes, core_end)
        };
        if after_ok {
            let mut match_start = core_start;
            if haystack[..core_start].ends_with(optional_prefix) {
                let pref_start = core_start - optional_prefix.len();
                if has_word_boundary_before(bytes, pref_start) {
                    match_start = pref_start;
                }
            }
            if match_start < core_start || has_word_boundary_before(bytes, core_start) {
                matches.push(match_start);
            }
        }
        cursor = core_end;
    }
    matches
}

fn is_crate_or_mac_cargo_toml(path: &str) -> bool {
    (path.starts_with("crates/") || path.starts_with("apps/mac/")) && path.ends_with("/Cargo.toml")
}

fn is_crate_or_mac_rust(path: &str) -> bool {
    (path.starts_with("crates/") || path.starts_with("apps/mac/")) && path.ends_with(".rs")
}

fn is_thread_sleep_zeroed_zone(path: &str) -> bool {
    (path.starts_with("crates/server/tests/")
        || path.starts_with("apps/mac/src/")
        || path.starts_with("crates/cli/src/")
        || path.starts_with("crates/runtime/src/"))
        && path.ends_with(".rs")
}

enum AllowanceStatus {
    Valid,
    MissingReason,
    None,
}

fn inspect_thread_sleep_allowance(text: &str) -> AllowanceStatus {
    let mut cursor = 0usize;
    while let Some(rel) = text[cursor..].find("//") {
        let after_slashes = text[cursor + rel + 2..].trim_start();
        if let Some(after_tag) = after_slashes.strip_prefix("ratchet-allow:") {
            let after_ws = after_tag.trim_start();
            if let Some(after_rule) = after_ws.strip_prefix("no-thread-sleep")
                && after_rule.as_bytes().first().is_none_or(|&b| !is_ident_char(b))
            {
                let reason = after_rule
                    .trim_start_matches(|c: char| c.is_whitespace() || c == ':' || c == '-' || c == '\u{2014}')
                    .trim();
                let valid = reason.chars().count() >= 3 && reason.chars().any(|c| c.is_ascii_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(&c));
                return if valid { AllowanceStatus::Valid } else { AllowanceStatus::MissingReason };
            }
        }
        cursor += rel + 2;
    }
    AllowanceStatus::None
}

fn has_documented_thread_sleep_allowance(raw_lines: &[String], line: usize) -> bool {
    match inspect_thread_sleep_allowance(raw_lines.get(line.saturating_sub(1)).map_or("", String::as_str)) {
        AllowanceStatus::Valid => return true,
        AllowanceStatus::MissingReason => return false,
        AllowanceStatus::None => {}
    }

    if line < 2 {
        return false;
    }
    for idx in (0..=line - 2).rev() {
        let trimmed = raw_lines[idx].trim();
        if trimmed.is_empty() {
            continue;
        }
        if !trimmed.starts_with("//") {
            break;
        }
        match inspect_thread_sleep_allowance(trimmed) {
            AllowanceStatus::Valid => return true,
            AllowanceStatus::MissingReason => return false,
            AllowanceStatus::None => {}
        }
    }
    false
}

fn check_pollster(file: &SourceFile, stripped_code: &str) -> Vec<RatchetViolation> {
    let index = LineIndex::new(&file.text);
    let mut seen_line = BTreeSet::new();
    let mut violations = Vec::new();
    for offset in find_word_matches(stripped_code, "pollster") {
        let line = index.line_at(offset);
        if !seen_line.insert(line) {
            continue;
        }
        violations.push(RatchetViolation {
            rule: RustRatchetRule::NoPollster,
            file: file.path.clone(),
            line,
            message: format!("`pollster` is forbidden in crates/ and apps/mac/ ({})", index.snippet_at(line)),
            fix: "Remove `pollster` from Cargo.toml and Rust code; use `vibevalley_runtime::rt::block_on` at sync boundaries or convert callers to async (`Hub::on_async`).".to_owned(),
            see: CONCURRENCY_DOC,
            details: Vec::new(),
        });
    }
    violations
}

fn check_thread_sleep(file: &SourceFile, stripped_rust: &str) -> Vec<RatchetViolation> {
    let index = LineIndex::new(&file.text);
    let mut seen_line = BTreeSet::new();
    let mut violations = Vec::new();
    for offset in find_prefixed_call_matches(stripped_rust, "std::", "thread::sleep", false) {
        let line = index.line_at(offset);
        if !seen_line.insert(line) {
            continue;
        }
        if has_documented_thread_sleep_allowance(index.lines(), line) {
            continue;
        }
        violations.push(RatchetViolation {
            rule: RustRatchetRule::NoThreadSleepInZeroedZones,
            file: file.path.clone(),
            line,
            message: format!("`std::thread::sleep` is forbidden in zeroed zones ({})", index.snippet_at(line)),
            fix: "Use virtual-clock `tokio::time::advance` / `tokio::time::sleep` (`#[tokio::test(start_paused = true)]`) or event-driven sync (`Notify`, channels); if an OS thread genuinely requires a sleep, add `// ratchet-allow: no-thread-sleep -- <reason>`.".to_owned(),
            see: CONCURRENCY_DOC,
            details: Vec::new(),
        });
    }
    violations
}

fn check_mac_rt_handle(file: &SourceFile, stripped_rust: &str) -> Vec<RatchetViolation> {
    let index = LineIndex::new(&file.text);
    let mut seen_line = BTreeSet::new();
    let mut violations = Vec::new();
    for offset in find_prefixed_call_matches(stripped_rust, "vibevalley_runtime::", "rt::handle", false) {
        let line = index.line_at(offset);
        if !seen_line.insert(line) {
            continue;
        }
        violations.push(RatchetViolation {
            rule: RustRatchetRule::NoMacRtHandle,
            file: file.path.clone(),
            line,
            message: format!("`rt::handle` is forbidden in `apps/mac/src/` ({})", index.snippet_at(line)),
            fix: "Use async `Server::call_with_async`, `Hub::call_with`, or GPUI `cx.spawn` instead of reaching for `vibevalley_runtime::rt::handle`."
                .to_owned(),
            see: CONCURRENCY_DOC,
            details: Vec::new(),
        });
    }
    violations
}

fn check_rich_sync_try_current(file: &SourceFile, stripped_rust: &str) -> Vec<RatchetViolation> {
    let index = LineIndex::new(&file.text);
    let mut seen_line = BTreeSet::new();
    let mut violations = Vec::new();
    for offset in find_word_matches(stripped_rust, "Handle::try_current") {
        let line = index.line_at(offset);
        if !seen_line.insert(line) {
            continue;
        }
        violations.push(RatchetViolation {
            rule: RustRatchetRule::NoRichSyncTryCurrent,
            file: file.path.clone(),
            line,
            message: format!("`Handle::try_current()` is forbidden outside `crates/rich/src/highlight.rs` ({})", index.snippet_at(line)),
            fix: "Move background CPU rendering behind `crate::highlight::run_offloaded` instead of probing `Handle::try_current()` and falling back synchronously on the UI thread.".to_owned(),
            see: CONCURRENCY_DOC,
            details: Vec::new(),
        });
    }
    violations
}

fn imports_tcp_listener(stripped_rust: &str, ns_prefix: &str) -> bool {
    let bytes = stripped_rust.as_bytes();
    let mut cursor = 0usize;
    while let Some(rel) = stripped_rust[cursor..].find("use") {
        let start = cursor + rel;
        let end = start + 3;
        if has_word_boundary_before(bytes, start) && bytes.get(end).is_some_and(u8::is_ascii_whitespace) {
            let rest = stripped_rust[end..].trim_start();
            if let Some(after_ns) = rest.strip_prefix(ns_prefix) {
                if let Some(after_brace) = after_ns.strip_prefix('{') {
                    if let Some(close) = after_brace.find('}')
                        && !find_word_matches(&after_brace[..close], "TcpListener").is_empty()
                    {
                        return true;
                    }
                } else if after_ns.starts_with("TcpListener") && has_word_boundary_after(after_ns.as_bytes(), "TcpListener".len()) {
                    return true;
                }
            }
        }
        cursor = end;
    }
    false
}

fn extract_path_prefix_before(code: &str, target_start: usize) -> &str {
    let bytes = code.as_bytes();
    let mut pos = target_start;
    while pos >= 2 && &bytes[pos - 2..pos] == b"::" {
        let mut seg_start = pos - 2;
        while seg_start > 0 && is_ident_char(bytes[seg_start - 1]) {
            seg_start -= 1;
        }
        if seg_start == pos - 2 || !crate::rust_scan::is_ident_start(bytes[seg_start]) {
            break;
        }
        pos = seg_start;
    }
    &code[pos..target_start]
}

fn check_raw_tcp_http_mock(file: &SourceFile, stripped_rust: &str) -> Vec<RatchetViolation> {
    let imports_tokio = imports_tcp_listener(stripped_rust, "tokio::net::");
    let imports_std = imports_tcp_listener(stripped_rust, "std::net::");

    let index = LineIndex::new(&file.text);
    let mut raw_sites = Vec::new();
    let mut seen_line = BTreeSet::new();

    let needle = "TcpListener::bind";
    let bytes = stripped_rust.as_bytes();
    let mut cursor = 0usize;
    while let Some(rel) = stripped_rust[cursor..].find(needle) {
        let start = cursor + rel;
        let end = start + needle.len();
        cursor = end;
        let mut paren = end;
        while paren < bytes.len() && bytes[paren].is_ascii_whitespace() {
            paren += 1;
        }
        if bytes.get(paren) != Some(&b'(') {
            continue;
        }
        let prefix = extract_path_prefix_before(stripped_rust, start);
        if prefix == "tokio::net::" {
            continue;
        }
        if prefix.is_empty() && imports_tokio && !imports_std {
            continue;
        }
        let line = index.line_at(start);
        if seen_line.insert(line) {
            raw_sites.push(line);
        }
    }

    if file.path == "crates/server/tests/connector.rs"
        && raw_sites.len() <= 1
        && stripped_rust.contains("serve_ws")
        && stripped_rust.contains("tungstenite::accept")
    {
        return Vec::new();
    }

    raw_sites
        .into_iter()
        .map(|line| RatchetViolation {
            rule: RustRatchetRule::NoRawTcpHttpMock,
            file: file.path.clone(),
            line,
            message: format!("raw `TcpListener::bind` test mock in `crates/server/tests/` ({})", index.snippet_at(line)),
            fix: "Replace raw `std::net::TcpListener::bind` HTTP mocks with `axum::Router` + `tokio::net::TcpListener::bind` + `axum::serve`.".to_owned(),
            see: CONCURRENCY_DOC,
            details: Vec::new(),
        })
        .collect()
}

struct BlockOnSite {
    file: String,
    line: usize,
    snippet: String,
}

fn collect_server_block_on_sites(files: &[SourceFile]) -> Vec<BlockOnSite> {
    let server_src_files: Vec<&SourceFile> = files
        .iter()
        .filter(|f| f.path.starts_with("crates/server/src/") && f.path.ends_with(".rs"))
        .collect();
    let mut excluded_targets = BTreeSet::new();

    for file in &server_src_files {
        let stripped = strip_rust_comments_and_literals(&file.text);
        for target in collect_cfg_test_submodules(&file.path, &file.text, &stripped) {
            excluded_targets.insert(target);
        }
    }

    let mut sites = Vec::new();
    for file in server_src_files {
        if is_excluded_by_cfg_test(&file.path, &excluded_targets) {
            continue;
        }
        let non_test_code = strip_rust_non_code(&file.text, &file.path);
        let index = LineIndex::new(&file.text);
        for offset in find_prefixed_call_matches(&non_test_code, "vibevalley_runtime::", "rt::block_on", true) {
            let line = index.line_at(offset);
            sites.push(BlockOnSite {
                file: file.path.clone(),
                line,
                snippet: index.snippet_at(line).to_owned(),
            });
        }
    }
    sites
}

fn run_ratchets(files: &[SourceFile], ceiling: usize) -> (usize, Vec<RatchetViolation>) {
    let mut sorted: Vec<SourceFile> = files
        .iter()
        .map(|f| SourceFile {
            path: f.path.replace('\\', "/"),
            text: f.text.clone(),
        })
        .collect();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));

    let mut violations = Vec::new();

    for file in &sorted {
        if is_crate_or_mac_cargo_toml(&file.path) {
            violations.extend(check_pollster(file, &strip_toml_comments(&file.text)));
            continue;
        }
        if !is_crate_or_mac_rust(&file.path) {
            continue;
        }
        let stripped_rust = strip_rust_comments_and_literals(&file.text);
        violations.extend(check_pollster(file, &stripped_rust));

        if is_thread_sleep_zeroed_zone(&file.path) {
            violations.extend(check_thread_sleep(file, &stripped_rust));
        }
        if file.path.starts_with("apps/mac/src/") {
            violations.extend(check_mac_rt_handle(file, &stripped_rust));
        }
        if file.path.starts_with("crates/rich/src/") && file.path != "crates/rich/src/highlight.rs" {
            violations.extend(check_rich_sync_try_current(file, &stripped_rust));
        }
        if file.path.starts_with("crates/server/tests/") {
            violations.extend(check_raw_tcp_http_mock(file, &stripped_rust));
        }
    }

    let block_on_sites = collect_server_block_on_sites(&sorted);
    if block_on_sites.len() > ceiling {
        let first = &block_on_sites[0];
        violations.push(RatchetViolation {
            rule: RustRatchetRule::NoBlockOnInAsyncServer,
            file: first.file.clone(),
            line: first.line,
            message: format!(
                "`crates/server/src/` has {} non-test `rt::block_on(` call(s), exceeding shrink-only ceiling {ceiling}",
                block_on_sites.len()
            ),
            fix: "Convert the new caller to `async fn` / `Hub::on_async` instead of adding `rt::block_on(`, or migrate existing sites to async and lower `SERVER_BLOCK_ON_CEILING` in `xtask/src/ratchets.rs`.".to_owned(),
            see: CONCURRENCY_DOC,
            details: block_on_sites.iter().map(|s| format!("{}:{}: {}", s.file, s.line, s.snippet)).collect(),
        });
    }

    (block_on_sites.len(), violations)
}

#[cfg(test)]
pub fn audit_rust_ratchets(files: &[SourceFile], ceiling: Option<usize>) -> Vec<RatchetViolation> {
    run_ratchets(files, ceiling.unwrap_or(SERVER_BLOCK_ON_CEILING)).1
}

pub fn audit_workspace_ratchets(root: &Path, ceiling: Option<usize>) -> Result<AuditRatchetsResult, String> {
    let files = walk_matching_files(root, &["crates", "apps/mac"], |rel| {
        is_crate_or_mac_cargo_toml(rel) || is_crate_or_mac_rust(rel)
    })?;
    let ceiling = ceiling.unwrap_or(SERVER_BLOCK_ON_CEILING);
    let (count, violations) = run_ratchets(&files, ceiling);
    Ok(AuditRatchetsResult {
        files_scanned: files.len(),
        server_block_on_count: count,
        server_block_on_ceiling: ceiling,
        violations,
    })
}

pub fn format_ratchet_violations(violations: &[RatchetViolation]) -> String {
    let mut lines = Vec::new();
    for v in violations {
        lines.push(format!("[{}] {}:{}: {}", v.rule.as_str(), v.file, v.line, v.message));
        for detail in &v.details {
            lines.push(format!("  site: {detail}"));
        }
        lines.push(format!("  Fix: {}", v.fix));
        lines.push(format!("  See: {}", v.see));
    }
    lines.join("\n")
}

pub fn run(root: &Path) -> Result<i32, String> {
    let result = audit_workspace_ratchets(root, None)?;
    if !result.violations.is_empty() {
        let mut by_rule: BTreeMap<&str, usize> = BTreeMap::new();
        for v in &result.violations {
            *by_rule.entry(v.rule.as_str()).or_insert(0) += 1;
        }
        let summary = by_rule.iter().map(|(rule, count)| format!("{rule}={count}")).collect::<Vec<_>>().join(", ");
        eprintln!(
            "rust ratchets: {} violation(s) ({summary}; server block_on={}/{})\n\n{}",
            result.violations.len(),
            result.server_block_on_count,
            result.server_block_on_ceiling,
            format_ratchet_violations(&result.violations)
        );
        return Ok(1);
    }
    println!(
        "rust ratchets: {} files ok (server block_on={}/{})",
        result.files_scanned, result.server_block_on_count, result.server_block_on_ceiling
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
    fn no_pollster_forbids_cargo_and_rust_while_ignoring_comments_and_strings() {
        let files = vec![
            sf("crates/server/Cargo.toml", "[dependencies]\npollster = \"0.4\"\n"),
            sf("apps/mac/Cargo.toml", "[dependencies]\npollster.workspace = true\n"),
            sf("crates/runtime/src/lib.rs", "pub fn run() { pollster::block_on(async {}); }\n"),
            sf(
                "apps/mac/src/shell/mod.rs",
                "#[cfg(test)]\nmod tests { fn t() { let _ = pollster::block_on(async { 1 }); } }\n",
            ),
        ];
        let violations = audit_rust_ratchets(&files, None);
        let tags: Vec<String> = violations.iter().map(|v| format!("{}@{}:{}", v.rule.as_str(), v.file, v.line)).collect();
        assert_eq!(
            tags,
            vec![
                "no-pollster@apps/mac/Cargo.toml:2",
                "no-pollster@apps/mac/src/shell/mod.rs:2",
                "no-pollster@crates/runtime/src/lib.rs:1",
                "no-pollster@crates/server/Cargo.toml:2",
            ]
        );
        let formatted = format_ratchet_violations(&violations);
        assert!(formatted.contains("Fix:"));
        assert!(formatted.contains("See: docs/style/rust-async-concurrency.md"));

        let clean = vec![
            sf(
                "crates/server/Cargo.toml",
                "# Keep pollster out of dependencies.\n[dependencies]\ntokio = \"1\"\n",
            ),
            sf(
                "crates/server/src/lib.rs",
                "// Never call pollster::block_on.\nconst MSG: &str = \"pollster is banned\";\n",
            ),
        ];
        assert!(audit_rust_ratchets(&clean, None).is_empty());
    }

    #[test]
    fn no_thread_sleep_in_zeroed_zones_and_allows_documented_reason() {
        let files = vec![
            sf(
                "crates/server/tests/issue.rs",
                "fn wait() { std::thread::sleep(std::time::Duration::from_millis(10)); }\n",
            ),
            sf(
                "apps/mac/src/hosted/mod.rs",
                "use std::thread;\nfn pause() { thread::sleep(std::time::Duration::from_millis(5)); }\n",
            ),
            sf(
                "crates/cli/src/domains/work/issue.rs",
                "fn retry() { std::thread::sleep(std::time::Duration::from_secs(1)); }\n",
            ),
            sf(
                "crates/runtime/src/oar/scripted.rs",
                "fn step() { std::thread::sleep(std::time::Duration::from_millis(1)); }\n",
            ),
        ];
        let violations = audit_rust_ratchets(&files, None);
        let tags: Vec<String> = violations.iter().map(|v| format!("{}@{}:{}", v.rule.as_str(), v.file, v.line)).collect();
        assert_eq!(
            tags,
            vec![
                "no-thread-sleep-in-zeroed-zones@apps/mac/src/hosted/mod.rs:2",
                "no-thread-sleep-in-zeroed-zones@crates/cli/src/domains/work/issue.rs:1",
                "no-thread-sleep-in-zeroed-zones@crates/runtime/src/oar/scripted.rs:1",
                "no-thread-sleep-in-zeroed-zones@crates/server/tests/issue.rs:1",
            ]
        );
        let formatted = format_ratchet_violations(&violations);
        assert!(formatted.contains("tokio::time::advance"));

        let allowed = vec![
            sf(
                "apps/mac/src/speech_audio.rs",
                "// ratchet-allow: no-thread-sleep -- CoreAudio ring buffer drain waits for hardware callback\nstd::thread::sleep(std::time::Duration::from_millis(2));",
            ),
            sf(
                "crates/server/tests/watch.rs",
                "// ratchet-allow: no-thread-sleep\nstd::thread::sleep(std::time::Duration::from_millis(2));",
            ),
            sf(
                "crates/server/tests/clean.rs",
                "tokio::time::sleep(std::time::Duration::from_millis(2)).await;\n",
            ),
        ];
        let violations = audit_rust_ratchets(&allowed, None);
        let tags: Vec<String> = violations.iter().map(|v| format!("{}@{}:{}", v.rule.as_str(), v.file, v.line)).collect();
        assert_eq!(tags, vec!["no-thread-sleep-in-zeroed-zones@crates/server/tests/watch.rs:2"]);
    }

    #[test]
    fn no_mac_rt_handle_allows_current_or_global_handle() {
        let files = vec![
            sf(
                "apps/mac/src/island.rs",
                "fn spawn_bad() { vibevalley_runtime::rt::handle().spawn(async {}); }\n",
            ),
            sf(
                "apps/mac/src/hosted/remote.rs",
                "use vibevalley_runtime::rt;\nfn spawn_bad2() { rt::handle().spawn(async {}); }\n",
            ),
            sf(
                "apps/mac/src/live_voice.rs",
                "fn spawn_ok() { vibevalley_runtime::rt::current_or_global_handle().spawn(async {}); }\n",
            ),
        ];
        let violations = audit_rust_ratchets(&files, None);
        let tags: Vec<String> = violations.iter().map(|v| format!("{}@{}:{}", v.rule.as_str(), v.file, v.line)).collect();
        assert_eq!(
            tags,
            vec!["no-mac-rt-handle@apps/mac/src/hosted/remote.rs:2", "no-mac-rt-handle@apps/mac/src/island.rs:1",]
        );
        assert!(format_ratchet_violations(&violations).contains("Server::call_with_async"));
    }

    #[test]
    fn no_rich_sync_try_current_exempts_highlight_rs() {
        let files = vec![
            sf("crates/rich/src/code_block.rs", "if tokio::runtime::Handle::try_current().is_ok() {}\n"),
            sf(
                "crates/rich/src/mermaid.rs",
                "use tokio::runtime::Handle;\nlet ok = Handle::try_current().is_ok();\n",
            ),
            sf(
                "crates/rich/src/highlight.rs",
                "pub fn run_offloaded() { let _ = tokio::runtime::Handle::try_current(); }\n",
            ),
        ];
        let violations = audit_rust_ratchets(&files, None);
        let tags: Vec<String> = violations.iter().map(|v| format!("{}@{}:{}", v.rule.as_str(), v.file, v.line)).collect();
        assert_eq!(
            tags,
            vec![
                "no-rich-sync-try-current@crates/rich/src/code_block.rs:1",
                "no-rich-sync-try-current@crates/rich/src/mermaid.rs:2",
            ]
        );
        assert!(format_ratchet_violations(&violations).contains("crate::highlight::run_offloaded"));
    }

    #[test]
    fn no_raw_tcp_http_mock_and_connector_allowlist() {
        let files = vec![
            sf(
                "crates/server/tests/ai_mock.rs",
                "use std::net::TcpListener;\nfn mock() { let _ = TcpListener::bind(\"127.0.0.1:0\"); }\n",
            ),
            sf(
                "crates/server/tests/qualified_mock.rs",
                "fn mock() { let _ = std::net::TcpListener::bind(\"127.0.0.1:0\"); }\n",
            ),
            sf(
                "crates/server/tests/axum_good.rs",
                "use tokio::net::TcpListener;\nasync fn mock() { let _ = TcpListener::bind(\"127.0.0.1:0\").await; }",
            ),
            sf(
                "crates/server/tests/connector.rs",
                "use std::net::TcpListener;\nasync fn serve_http() { let _ = tokio::net::TcpListener::bind(\"127.0.0.1:0\").await; }\nfn serve_ws() { let l = TcpListener::bind(\"127.0.0.1:0\").unwrap(); let _ = tungstenite::accept(l.incoming().next().unwrap().unwrap()); }",
            ),
        ];
        let violations = audit_rust_ratchets(&files, None);
        let tags: Vec<String> = violations.iter().map(|v| format!("{}@{}:{}", v.rule.as_str(), v.file, v.line)).collect();
        assert_eq!(
            tags,
            vec![
                "no-raw-tcp-http-mock@crates/server/tests/ai_mock.rs:2",
                "no-raw-tcp-http-mock@crates/server/tests/qualified_mock.rs:1",
            ]
        );

        let extra_site = vec![sf(
            "crates/server/tests/connector.rs",
            "use std::net::TcpListener;\nfn serve_ws() { let _ = TcpListener::bind(\"127.0.0.1:0\"); let _ = tungstenite::accept; }\nfn serve_extra_http() { let _ = TcpListener::bind(\"127.0.0.1:0\"); }",
        )];
        let violations = audit_rust_ratchets(&extra_site, None);
        let tags: Vec<String> = violations.iter().map(|v| format!("{}@{}:{}", v.rule.as_str(), v.file, v.line)).collect();
        assert_eq!(
            tags,
            vec![
                "no-raw-tcp-http-mock@crates/server/tests/connector.rs:2",
                "no-raw-tcp-http-mock@crates/server/tests/connector.rs:3",
            ]
        );
    }

    #[test]
    fn block_on_ceiling_excludes_cfg_test() {
        assert_eq!(SERVER_BLOCK_ON_CEILING, 71);

        let files = vec![
            sf(
                "crates/server/src/db/mod.rs",
                "pub fn a() { vibevalley_runtime::rt::block_on(async {}); }\npub fn b() { rt::block_on(async {}); }\n// rt::block_on(ignored_comment)\n#[cfg(test)]\nmod tests { fn c() { vibevalley_runtime::rt::block_on(async {}); } }",
            ),
            sf("crates/server/src/transport/http/mod.rs", "#[cfg(test)]\nmod tests;\n"),
            sf(
                "crates/server/src/transport/http/tests.rs",
                "fn test_only() { vibevalley_runtime::rt::block_on(async {}); }\n",
            ),
        ];

        assert!(audit_rust_ratchets(&files, Some(2)).is_empty());

        let violations = audit_rust_ratchets(&files, Some(1));
        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].rule, RustRatchetRule::NoBlockOnInAsyncServer);
        assert!(
            violations[0]
                .message
                .contains("2 non-test `rt::block_on(` call(s), exceeding shrink-only ceiling 1")
        );
        assert_eq!(
            violations[0].details,
            vec![
                "crates/server/src/db/mod.rs:1: pub fn a() { vibevalley_runtime::rt::block_on(async {}); }",
                "crates/server/src/db/mod.rs:2: pub fn b() { rt::block_on(async {}); }",
            ]
        );
    }

    #[test]
    fn audits_workspace_ratchets_from_disk() {
        let dir = TempDir::new("vv-rust-ratchets");
        dir.write("crates/server/Cargo.toml", "[package]\nname = \"server\"\n");
        dir.write("crates/server/src/lib.rs", "pub fn ok() {}\n");
        dir.write(
            "crates/rich/src/highlight.rs",
            "pub fn run_offloaded() { let _ = tokio::runtime::Handle::try_current(); }\n",
        );
        dir.write("apps/mac/src/main.rs", "fn main() {}\n");

        let clean = audit_workspace_ratchets(&dir.0, None).unwrap();
        assert_eq!(clean.files_scanned, 4);
        assert_eq!(clean.server_block_on_count, 0);
        assert!(clean.violations.is_empty());

        dir.write("crates/rich/src/code_block.rs", "fn bad() { let _ = tokio::runtime::Handle::try_current(); }\n");
        let dirty = audit_workspace_ratchets(&dir.0, None).unwrap();
        assert_eq!(
            dirty.violations.iter().map(|v| v.rule).collect::<Vec<_>>(),
            vec![RustRatchetRule::NoRichSyncTryCurrent]
        );
    }
}
