//! Shared quality-gate core (`crap`, `dry`, `mutate`, `uml`) for Rust and TypeScript/TSX.

#![allow(dead_code)]

pub mod crap;
pub mod dry;
pub mod lang;
pub mod mutate;
pub mod uml;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize, de::DeserializeOwned};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Lang {
    Rust,
    TypeScript,
}

impl Lang {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rust => "rust",
            Self::TypeScript => "typescript",
        }
    }

    pub fn from_path(path: &Path) -> Option<Self> {
        let ext = path.extension()?.to_str()?;
        match ext {
            "rs" => Some(Self::Rust),
            "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => Some(Self::TypeScript),
            _ => None,
        }
    }
}

impl fmt::Display for Lang {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Visibility {
    Public,
    Private,
}

impl Visibility {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Private => "private",
        }
    }

    pub fn symbol(self) -> &'static str {
        match self {
            Self::Public => "+",
            Self::Private => "-",
        }
    }

    pub fn defn_prefix(self) -> &'static str {
        match self {
            Self::Public => "defn",
            Self::Private => "defn-",
        }
    }
}

impl fmt::Display for Visibility {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FormKind {
    Function,
    Method,
    Arrow,
}

impl FormKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Function => "function",
            Self::Method => "method",
            Self::Arrow => "arrow",
        }
    }
}

impl fmt::Display for FormKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FormInfo {
    pub namespace: String,
    pub name: String,
    pub kind: FormKind,
    pub visibility: Visibility,
    pub lang: Lang,
    pub file: String,
    pub start_line: usize,
    pub end_line: usize,
    pub start_byte: usize,
    pub end_byte: usize,
    pub body_hash: String,
}

impl FormInfo {
    pub fn defn_key(&self) -> String {
        format!("{}/{}", self.visibility.defn_prefix(), self.name)
    }

    pub fn line_count(&self) -> usize {
        self.end_line.saturating_sub(self.start_line) + 1
    }
}

/// Deterministic 128-bit FNV-1a digest encoded as 32 lowercase hex characters.
pub fn stable_hash_hex(text: &str) -> String {
    let mut h1: u64 = 0xcbf2_9ce4_8422_2325;
    let mut h2: u64 = 0xaf63_bd4c_8601_b7df;
    for &b in text.as_bytes() {
        h1 ^= u64::from(b);
        h1 = h1.wrapping_mul(0x0100_0000_01b3);
        h2 = h2.wrapping_mul(0x0100_0000_01b3);
        h2 ^= u64::from(b);
    }
    format!("{h1:016x}{h2:016x}")
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CrapSummary {
    pub total_forms: usize,
    pub scored_forms: usize,
    pub above_threshold: usize,
    pub mean_crap: Option<f64>,
    pub max_crap: Option<f64>,
    pub sigma_crap: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CrapEntry {
    pub namespace: String,
    pub name: String,
    pub kind: FormKind,
    pub visibility: Visibility,
    pub lang: Lang,
    pub file: String,
    pub start_line: usize,
    pub end_line: usize,
    pub cc: usize,
    pub flat_match_arms: usize,
    pub is_flat_match: bool,
    pub lines_total: usize,
    pub lines_covered: usize,
    pub coverage: Option<f64>,
    pub crap: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CrapSnapshot {
    pub version: u32,
    pub threshold: f64,
    pub coverage_mode: String,
    pub summary: CrapSummary,
    pub entries: Vec<CrapEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DrySide {
    pub namespace: String,
    pub name: String,
    pub kind: FormKind,
    pub visibility: Visibility,
    pub file: String,
    pub start_line: usize,
    pub end_line: usize,
    pub lines: usize,
    pub nodes: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DryCandidate {
    pub lang: Lang,
    pub similarity: f64,
    pub shared_fingerprints: usize,
    pub union_fingerprints: usize,
    pub left: DrySide,
    pub right: DrySide,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DrySnapshot {
    pub version: u32,
    pub threshold: f64,
    pub min_lines: usize,
    pub min_nodes: usize,
    pub scanned_forms: usize,
    pub candidates: Vec<DryCandidate>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MutantOutcome {
    Killed,
    Survived,
    Uncovered,
    Timeout,
    CompileError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MutantRecord {
    pub id: String,
    pub line: usize,
    pub col: usize,
    pub start_byte: usize,
    pub end_byte: usize,
    pub original: String,
    pub replacement: String,
    pub outcome: MutantOutcome,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MutateForm {
    pub namespace: String,
    pub name: String,
    pub kind: FormKind,
    pub visibility: Visibility,
    pub lang: Lang,
    pub file: String,
    pub start_line: usize,
    pub end_line: usize,
    pub body_hash: String,
    pub killed: usize,
    pub survived: usize,
    pub uncovered: usize,
    pub timeout: usize,
    pub compile_error: usize,
    pub total_sites: usize,
    pub score: Option<f64>,
    pub mutants: Vec<MutantRecord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MutateSnapshot {
    pub version: u32,
    pub namespace: String,
    pub lang: Lang,
    pub forms: BTreeMap<String, MutateForm>,
}

pub fn metrics_dir(root: &Path) -> PathBuf {
    root.join(".metrics")
}

pub fn uml_dir(root: &Path) -> PathBuf {
    root.join(".uml")
}

pub fn crap_snapshot_path(root: &Path) -> PathBuf {
    metrics_dir(root).join("crap.json")
}

pub fn dry_snapshot_path(root: &Path) -> PathBuf {
    metrics_dir(root).join("dry.json")
}

pub fn mutate_snapshot_dir(root: &Path) -> PathBuf {
    metrics_dir(root).join("mutate")
}

pub fn sanitize_namespace_filename(namespace: &str) -> String {
    let mut out = String::with_capacity(namespace.len());
    for ch in namespace.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() { "_root".to_owned() } else { out }
}

pub fn mutate_snapshot_path(root: &Path, namespace: &str) -> PathBuf {
    mutate_snapshot_dir(root).join(format!("{}.json", sanitize_namespace_filename(namespace)))
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    let raw = fs::read_to_string(path).map_err(|err| format!("failed to read {}: {err}", path.display()))?;
    serde_json::from_str(&raw).map_err(|err| format!("failed to parse JSON {}: {err}", path.display()))
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("cannot determine parent directory for {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|err| format!("failed to create {}: {err}", parent.display()))?;

    let payload = serde_json::to_string_pretty(value).map_err(|err| format!("failed to serialize {}: {err}", path.display()))?;
    let pid = std::process::id();
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("snapshot.json");
    let tmp_path = parent.join(format!(".{file_name}.{pid}.tmp"));

    fs::write(&tmp_path, format!("{payload}\n")).map_err(|err| format!("failed to write {}: {err}", tmp_path.display()))?;
    if let Err(err) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("failed to rename {} -> {}: {err}", tmp_path.display(), path.display()));
    }
    Ok(())
}

/// Formats a `serde_json::Value` as EDN for optional inspection parity with `@unclebob` tooling.
pub fn to_edn(value: &serde_json::Value) -> String {
    let mut out = String::new();
    write_edn(&mut out, value, 0);
    out
}

fn write_edn(out: &mut String, value: &serde_json::Value, indent: usize) {
    match value {
        serde_json::Value::Null => out.push_str("nil"),
        serde_json::Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        serde_json::Value::Number(n) => out.push_str(&n.to_string()),
        serde_json::Value::String(s) => write_edn_string(out, s),
        serde_json::Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (idx, item) in items.iter().enumerate() {
                if idx > 0 {
                    out.push(' ');
                }
                write_edn(out, item, indent + 1);
            }
            out.push(']');
        }
        serde_json::Value::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (idx, (k, v)) in map.iter().enumerate() {
                if idx > 0 {
                    out.push('\n');
                    for _ in 0..=indent {
                        out.push(' ');
                    }
                }
                write_edn_keyword(out, k);
                out.push(' ');
                write_edn(out, v, indent + 1);
            }
            out.push('}');
        }
    }
}

fn write_edn_string(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn write_edn_keyword(out: &mut String, key: &str) {
    if !key.is_empty() && key.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'/' | b'?')) {
        out.push(':');
        out.push_str(key);
    } else {
        write_edn_string(out, key);
    }
}

/// Parses an LCOV tracefile (`cargo llvm-cov --lcov` or Vitest `lcov.info`) into
/// `file -> (1-based line -> execution hits)`.
pub fn parse_lcov(path: &Path) -> Result<HashMap<PathBuf, HashMap<usize, u64>>, String> {
    let raw = fs::read_to_string(path).map_err(|err| format!("failed to read LCOV file {}: {err}", path.display()))?;
    let mut coverage: HashMap<PathBuf, HashMap<usize, u64>> = HashMap::new();
    let mut current_file: Option<PathBuf> = None;

    for (idx, raw_line) in raw.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(sf) = line.strip_prefix("SF:") {
            let normalized = normalize_posix_path(sf.trim());
            current_file = Some(PathBuf::from(normalized));
            continue;
        }
        if line == "end_of_record" {
            current_file = None;
            continue;
        }
        if let Some(da) = line.strip_prefix("DA:") {
            let Some(file) = current_file.as_ref() else {
                return Err(format!("{}:{}: DA record before SF", path.display(), idx + 1));
            };
            let mut parts = da.split(',');
            let line_str = parts
                .next()
                .ok_or_else(|| format!("{}:{}: malformed DA record `{line}`", path.display(), idx + 1))?;
            let hits_str = parts
                .next()
                .ok_or_else(|| format!("{}:{}: missing hit count in `{line}`", path.display(), idx + 1))?;
            let line_no: usize = line_str
                .trim()
                .parse()
                .map_err(|err| format!("{}:{}: invalid line number `{line_str}`: {err}", path.display(), idx + 1))?;
            let hits: u64 = hits_str
                .trim()
                .parse()
                .map_err(|err| format!("{}:{}: invalid hit count `{hits_str}`: {err}", path.display(), idx + 1))?;
            let entry = coverage.entry(file.clone()).or_default().entry(line_no).or_insert(0);
            *entry = entry.saturating_add(hits);
        }
    }

    Ok(coverage)
}

/// Resolves per-line coverage hits for a repository-relative POSIX path against an LCOV map
/// that may hold either relative or absolute `SF:` paths.
pub fn lookup_lcov_lines<'a>(lcov: &'a HashMap<PathBuf, HashMap<usize, u64>>, root: &Path, rel_posix: &str) -> Option<&'a HashMap<usize, u64>> {
    let rel_clean = normalize_posix_path(rel_posix);
    if let Some(found) = lcov.get(Path::new(&rel_clean)) {
        return Some(found);
    }
    let abs = normalize_posix_path(&root.join(&rel_clean).to_string_lossy());
    if let Some(found) = lcov.get(Path::new(&abs)) {
        return Some(found);
    }
    let suffix = format!("/{rel_clean}");
    lcov.iter()
        .find(|(k, _)| normalize_posix_path(&k.to_string_lossy()).ends_with(&suffix))
        .map(|(_, v)| v)
}

pub fn normalize_posix_path(path: &str) -> String {
    let replaced = path.replace('\\', "/");
    let is_abs = replaced.starts_with('/');
    let mut stack: Vec<&str> = Vec::new();
    for seg in replaced.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if stack.last().is_some_and(|&s| s != "..") {
                    stack.pop();
                } else if !is_abs {
                    stack.push("..");
                }
            }
            other => stack.push(other),
        }
    }
    if is_abs { format!("/{}", stack.join("/")) } else { stack.join("/") }
}

pub fn to_rel_posix(root: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path);
    normalize_posix_path(&rel.to_string_lossy())
}

/// Collects changed files in the workspace relative to `origin/main` (if present) plus
/// staged, unstaged, and untracked files from `git status --porcelain`.
pub fn changed_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut paths = BTreeSet::new();

    let status_out = Command::new("git")
        .args(["status", "--porcelain=v1", "-uall"])
        .current_dir(root)
        .output()
        .map_err(|err| format!("failed to run git status: {err}"))?;
    if !status_out.status.success() {
        let stderr = String::from_utf8_lossy(&status_out.stderr);
        return Err(format!("git status failed: {}", stderr.trim()));
    }
    for line in String::from_utf8_lossy(&status_out.stdout).lines() {
        if line.len() < 4 {
            continue;
        }
        let rest = line[3..].trim();
        let path_str = rest.rsplit_once(" -> ").map_or(rest, |(_, new)| new).trim_matches('"');
        if !path_str.is_empty() {
            paths.insert(PathBuf::from(normalize_posix_path(path_str)));
        }
    }

    let has_origin_main = Command::new("git")
        .args(["rev-parse", "--verify", "--quiet", "origin/main"])
        .current_dir(root)
        .output()
        .is_ok_and(|o| o.status.success());

    if has_origin_main {
        let diff_out = Command::new("git")
            .args(["diff", "--name-only", "origin/main...HEAD"])
            .current_dir(root)
            .output()
            .map_err(|err| format!("failed to run git diff: {err}"))?;
        if diff_out.status.success() {
            for line in String::from_utf8_lossy(&diff_out.stdout).lines() {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    paths.insert(PathBuf::from(normalize_posix_path(trimmed)));
                }
            }
        }
    }

    Ok(paths.into_iter().collect())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectedFile {
    pub path: PathBuf,
    pub rel_path: String,
    pub lang: Lang,
}

const SKIP_DIRS: &[&str] = &[
    ".git",
    ".metrics",
    ".nsh",
    ".tools",
    ".uml",
    ".vitest",
    "__tests__",
    "build",
    "build-shell",
    "dist",
    "node_modules",
    "spec",
    "specs",
    "target",
    "test",
    "testdata",
    "tests",
    "vendor",
];

pub fn should_skip_dir(dir_name: &str) -> bool {
    SKIP_DIRS.contains(&dir_name) || dir_name.starts_with("target-")
}

pub fn should_skip_file_name(file_name: &str) -> bool {
    file_name.contains(".test.")
        || file_name.contains(".spec.")
        || file_name.contains(".gen.")
        || file_name.ends_with(".d.ts")
        || file_name.ends_with(".min.js")
        || file_name.ends_with(".min.mjs")
}

pub fn is_qa_source_path(rel_posix: &str) -> Option<Lang> {
    let normalized = normalize_posix_path(rel_posix);
    for seg in normalized.split('/') {
        if should_skip_dir(seg) {
            return None;
        }
    }
    let file_name = normalized.rsplit('/').next()?;
    if should_skip_file_name(file_name) {
        return None;
    }
    Lang::from_path(Path::new(file_name))
}

fn matches_filters(rel_posix: &str, filters: &[String]) -> bool {
    if filters.is_empty() {
        return true;
    }
    filters.iter().any(|raw| {
        let f = normalize_posix_path(raw.trim());
        if f.is_empty() {
            return false;
        }
        rel_posix == f || rel_posix.starts_with(&format!("{f}/")) || rel_posix.contains(&f)
    })
}

/// Collects non-test Rust and TypeScript/TSX source files under `root`, honoring skip rules,
/// optional language selection, and explicit path/fragment filters.
pub fn collect_project_files(root: &Path, filters: &[String], langs: Option<&[Lang]>) -> Result<Vec<CollectedFile>, String> {
    let mut visited = BTreeSet::new();
    walk_qa_dir(root, root, filters, langs, &mut visited)?;

    let mut out = Vec::with_capacity(visited.len());
    for rel_path in visited {
        let Some(lang) = Lang::from_path(Path::new(&rel_path)) else {
            continue;
        };
        out.push(CollectedFile {
            path: root.join(&rel_path),
            rel_path,
            lang,
        });
    }
    Ok(out)
}

fn walk_qa_dir(root: &Path, dir: &Path, filters: &[String], langs: Option<&[Lang]>, out: &mut BTreeSet<String>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|err| format!("failed to read directory {}: {err}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|err| format!("failed to read entry in {}: {err}", dir.display()))?;
        let file_name_os = entry.file_name();
        let file_name = file_name_os.to_string_lossy();
        let file_type = entry.file_type().map_err(|err| format!("failed to stat {}: {err}", entry.path().display()))?;

        if file_type.is_dir() {
            if should_skip_dir(&file_name) {
                continue;
            }
            walk_qa_dir(root, &entry.path(), filters, langs, out)?;
        } else if file_type.is_file() {
            if should_skip_file_name(&file_name) {
                continue;
            }
            let rel = to_rel_posix(root, &entry.path());
            let Some(lang) = is_qa_source_path(&rel) else {
                continue;
            };
            if let Some(allowed) = langs
                && !allowed.contains(&lang)
            {
                continue;
            }
            if matches_filters(&rel, filters) {
                out.insert(rel);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("xtask-qa-{tag}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parses_rust_and_vitest_lcov_files() {
        let dir = temp_dir("lcov");
        let lcov_path = dir.join("lcov.info");
        fs::write(
            &lcov_path,
            [
                "TN:",
                "SF:/repo/crates/core/src/lib.rs",
                "DA:10,3",
                "DA:11,0",
                "end_of_record",
                "SF:packages/protocol/src/api.ts",
                "DA:4,1,abcd",
                "DA:5,2,ef01",
                "end_of_record",
                "SF:packages/protocol/src/api.ts",
                "DA:4,2,abcd",
                "end_of_record",
            ]
            .join("\n"),
        )
        .unwrap();

        let parsed = parse_lcov(&lcov_path).unwrap();
        let rust_lines = lookup_lcov_lines(&parsed, Path::new("/repo"), "crates/core/src/lib.rs").unwrap();
        assert_eq!(rust_lines.get(&10), Some(&3));
        assert_eq!(rust_lines.get(&11), Some(&0));

        let ts_lines = lookup_lcov_lines(&parsed, Path::new("/repo"), "packages/protocol/src/api.ts").unwrap();
        assert_eq!(ts_lines.get(&4), Some(&3));
        assert_eq!(ts_lines.get(&5), Some(&2));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn skips_tests_generated_and_build_dirs_when_collecting_files() {
        let dir = temp_dir("collect");
        let write = |rel: &str| {
            let p = dir.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, "// src\n").unwrap();
        };

        write("crates/core/src/lib.rs");
        write("crates/core/tests/it.rs");
        write("packages/protocol/src/api.ts");
        write("packages/protocol/src/api.test.ts");
        write("packages/protocol/src/shapes.gen.ts");
        write("packages/protocol/src/types.d.ts");
        write("packages/protocol/dist/api.js");
        write("apps/mac/ui/features/artifact/HtmlView.tsx");
        write("apps/mac/ui/features/artifact/HtmlView.spec.tsx");
        write("apps/mac/ui/build/App.js");
        write("node_modules/pkg/index.ts");
        write("target/debug/build.rs");

        let all = collect_project_files(&dir, &[], None).unwrap();
        let rels: Vec<&str> = all.iter().map(|f| f.rel_path.as_str()).collect();
        assert_eq!(
            rels,
            vec![
                "apps/mac/ui/features/artifact/HtmlView.tsx",
                "crates/core/src/lib.rs",
                "packages/protocol/src/api.ts",
            ]
        );

        let filtered = collect_project_files(&dir, &["packages/protocol".to_owned()], Some(&[Lang::TypeScript])).unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].rel_path, "packages/protocol/src/api.ts");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn json_roundtrip_and_edn_formatting_work() {
        let dir = temp_dir("snapshot");
        let path = crap_snapshot_path(&dir);
        let snap = CrapSnapshot {
            version: 1,
            threshold: 10.0,
            coverage_mode: "full".to_owned(),
            summary: CrapSummary {
                total_forms: 1,
                scored_forms: 1,
                above_threshold: 0,
                mean_crap: Some(2.0),
                max_crap: Some(2.0),
                sigma_crap: Some(0.0),
            },
            entries: vec![CrapEntry {
                namespace: "crate::core".to_owned(),
                name: "score".to_owned(),
                kind: FormKind::Function,
                visibility: Visibility::Public,
                lang: Lang::Rust,
                file: "crates/core/src/lib.rs".to_owned(),
                start_line: 10,
                end_line: 20,
                cc: 2,
                flat_match_arms: 0,
                is_flat_match: false,
                lines_total: 8,
                lines_covered: 8,
                coverage: Some(1.0),
                crap: Some(2.0),
            }],
        };

        write_json(&path, &snap).unwrap();
        let read_back: CrapSnapshot = read_json(&path).unwrap();
        assert_eq!(read_back, snap);

        let edn = to_edn(&serde_json::to_value(&snap).unwrap());
        assert!(edn.contains(":namespace \"crate::core\""));
        assert!(edn.contains(":visibility \"public\""));

        let _ = fs::remove_dir_all(&dir);
    }
}
