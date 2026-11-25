//! Cyclomatic complexity & coverage CRAP score gate (`cargo xtask crap`).

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::qa::{self, CollectedFile, CrapEntry, CrapSnapshot, CrapSummary, Lang};

const DEFAULT_THRESHOLD: f64 = 30.0;
const RUST_LCOV_REL: &str = "target/coverage/rust/lcov.info";
const TS_LCOV_RELS: &[&str] = &["coverage/lcov.info", "target/coverage/typescript/lcov.info"];

type LcovMap = HashMap<PathBuf, HashMap<usize, u64>>;

const USAGE: &str = "\
Usage: cargo xtask crap [paths/fragments...] [options]

Options:
  --no-coverage             Skip coverage execution and LCOV loading (coverage=null, crap=null)
  --use-existing-coverage   Reuse existing LCOV files without re-running tests
  --changed                 Analyze only changed Rust/TS source files from git status/diff
  --threshold <N>           Exit with status 2 if any CRAP score is strictly > N (default display threshold: 30)
  --coverage-command <CMD>  Shell command to generate TypeScript LCOV instead of `vp test run --coverage`
  --json                    Print the CRAP snapshot as JSON on stdout
  --edn                     Also write `.metrics/crap.edn` alongside `.metrics/crap.json`
  -h, --help                Show this help message";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CoverageMode {
    Run,
    UseExisting,
    NoCoverage,
}

impl CoverageMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Run => "full",
            Self::UseExisting => "existing",
            Self::NoCoverage => "none",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
struct CrapOptions {
    filters: Vec<String>,
    coverage_mode: CoverageMode,
    changed: bool,
    threshold: Option<f64>,
    coverage_command: Option<String>,
    json: bool,
    edn: bool,
    help: bool,
}

pub fn run(root: &Path, args: &[String]) -> Result<i32, String> {
    let mut stdout = io::stdout().lock();
    run_with_writer(root, args, &mut stdout)
}

fn run_with_writer(root: &Path, args: &[String], out: &mut dyn Write) -> Result<i32, String> {
    let opts = parse_args(args)?;
    if opts.help {
        writeln!(out, "{USAGE}").map_err(|err| format!("failed to write help output: {err}"))?;
        return Ok(0);
    }

    let files = collect_target_files(root, &opts.filters, opts.changed)?;
    let lcov = prepare_coverage(root, &files, &opts)?;
    let threshold = opts.threshold.unwrap_or(DEFAULT_THRESHOLD);

    let mut entries = Vec::new();
    for file in &files {
        let source = fs::read_to_string(&file.path).map_err(|err| format!("failed to read {}: {err}", file.path.display()))?;
        let analysis = qa::lang::analyze_file(root, &file.path, &source, file.lang);
        if analysis.forms.is_empty() {
            continue;
        }
        let tokens = qa::lang::tokenize(&source, file.lang);
        let file_lcov = lcov.as_ref().and_then(|map| qa::lookup_lcov_lines(map, root, &file.rel_path));

        for form in analysis.forms {
            let complexity = qa::lang::cyclomatic_complexity(&tokens, &form, file.lang);
            let (lines_total, lines_covered, coverage, crap) = evaluate_form_coverage(form.start_line, form.end_line, complexity.cc, lcov.is_some(), file_lcov);

            entries.push(CrapEntry {
                namespace: form.namespace,
                name: form.name,
                kind: form.kind,
                visibility: form.visibility,
                lang: form.lang,
                file: form.file,
                start_line: form.start_line,
                end_line: form.end_line,
                cc: complexity.cc,
                flat_match_arms: complexity.flat_match_arms,
                is_flat_match: complexity.is_flat_match,
                lines_total,
                lines_covered,
                coverage,
                crap,
            });
        }
    }

    sort_entries_worst_first(&mut entries);
    let summary = summarize_entries(&entries, threshold);
    let snapshot = CrapSnapshot {
        version: 1,
        threshold,
        coverage_mode: opts.coverage_mode.as_str().to_owned(),
        summary,
        entries,
    };

    qa::write_json(&qa::crap_snapshot_path(root), &snapshot)?;
    if opts.edn {
        let edn_path = qa::metrics_dir(root).join("crap.edn");
        write_crap_edn(&edn_path, &snapshot)?;
    }

    if opts.json {
        let rendered = serde_json::to_string_pretty(&snapshot).map_err(|err| format!("failed to serialize CRAP snapshot: {err}"))?;
        writeln!(out, "{rendered}").map_err(|err| format!("failed to write JSON output: {err}"))?;
    } else {
        let rendered = format_table(&snapshot);
        write!(out, "{rendered}").map_err(|err| format!("failed to write table output: {err}"))?;
    }

    if opts.threshold.is_some() && snapshot.summary.above_threshold > 0 {
        eprintln!(
            "crap: {} form(s) exceed CRAP threshold {:.2}",
            snapshot.summary.above_threshold, snapshot.threshold
        );
        return Ok(2);
    }

    Ok(0)
}

fn parse_threshold(raw: &str) -> Result<f64, String> {
    let parsed: f64 = raw.trim().parse().map_err(|_| format!("invalid --threshold value `{raw}`"))?;
    if !parsed.is_finite() || parsed < 0.0 {
        return Err(format!("--threshold must be a finite non-negative number, got `{raw}`"));
    }
    Ok(parsed)
}

fn parse_args(args: &[String]) -> Result<CrapOptions, String> {
    let mut filters = Vec::new();
    let mut no_coverage = false;
    let mut use_existing = false;
    let mut changed = false;
    let mut threshold: Option<f64> = None;
    let mut coverage_command: Option<String> = None;
    let mut json = false;
    let mut edn = false;
    let mut help = false;

    let mut i = 0usize;
    while i < args.len() {
        let arg = &args[i];
        match arg.as_str() {
            "-h" | "--help" => {
                help = true;
                return Ok(CrapOptions {
                    filters,
                    coverage_mode: CoverageMode::Run,
                    changed,
                    threshold,
                    coverage_command,
                    json,
                    edn,
                    help,
                });
            }
            "--" => {
                filters.extend(args[i + 1..].iter().cloned());
                break;
            }
            "--no-coverage" => no_coverage = true,
            "--use-existing-coverage" => use_existing = true,
            "--changed" => changed = true,
            "--json" => json = true,
            "--edn" => edn = true,
            "--threshold" => {
                i += 1;
                let value = args.get(i).ok_or_else(|| format!("--threshold requires a numeric argument\n\n{USAGE}"))?;
                threshold = Some(parse_threshold(value)?);
            }
            "--coverage-command" => {
                i += 1;
                let value = args.get(i).ok_or_else(|| format!("--coverage-command requires a command string\n\n{USAGE}"))?;
                if value.trim().is_empty() {
                    return Err("--coverage-command cannot be empty".to_owned());
                }
                coverage_command = Some(value.clone());
            }
            other if other.starts_with("--threshold=") => {
                let raw = other.trim_start_matches("--threshold=");
                threshold = Some(parse_threshold(raw)?);
            }
            other if other.starts_with("--coverage-command=") => {
                let raw = other.trim_start_matches("--coverage-command=");
                if raw.trim().is_empty() {
                    return Err("--coverage-command cannot be empty".to_owned());
                }
                coverage_command = Some(raw.to_owned());
            }
            other if other.starts_with('-') => {
                return Err(format!("unknown option `{other}`\n\n{USAGE}"));
            }
            other => filters.push(other.to_owned()),
        }
        i += 1;
    }

    if no_coverage && use_existing {
        return Err("cannot combine --no-coverage with --use-existing-coverage".to_owned());
    }
    if no_coverage && coverage_command.is_some() {
        return Err("cannot combine --no-coverage with --coverage-command".to_owned());
    }
    if use_existing && coverage_command.is_some() {
        return Err("cannot combine --use-existing-coverage with --coverage-command".to_owned());
    }

    let coverage_mode = if no_coverage {
        CoverageMode::NoCoverage
    } else if use_existing {
        CoverageMode::UseExisting
    } else {
        CoverageMode::Run
    };

    Ok(CrapOptions {
        filters,
        coverage_mode,
        changed,
        threshold,
        coverage_command,
        json,
        edn,
        help,
    })
}

fn normalize_filter(root: &Path, raw: &str) -> String {
    let trimmed = raw.trim();
    let candidate = Path::new(trimmed);
    if candidate.is_absolute() {
        qa::to_rel_posix(root, candidate)
    } else {
        qa::normalize_posix_path(trimmed)
    }
}

fn matches_filters(rel_posix: &str, filters: &[String]) -> bool {
    if filters.is_empty() {
        return true;
    }
    filters.iter().any(|f| {
        if f.is_empty() {
            return false;
        }
        rel_posix == f || rel_posix.starts_with(&format!("{f}/")) || rel_posix.contains(f)
    })
}

fn collect_target_files(root: &Path, raw_filters: &[String], changed: bool) -> Result<Vec<CollectedFile>, String> {
    let filters: Vec<String> = raw_filters.iter().map(|raw| normalize_filter(root, raw)).collect();
    if !changed {
        return qa::collect_project_files(root, &filters, None);
    }

    let changed_paths = qa::changed_files(root)?;
    let mut by_rel = BTreeMap::new();
    for path in changed_paths {
        let rel_path = qa::normalize_posix_path(&path.to_string_lossy());
        let Some(lang) = qa::is_qa_source_path(&rel_path) else {
            continue;
        };
        let full_path = root.join(&rel_path);
        if !full_path.is_file() {
            continue;
        }
        if !matches_filters(&rel_path, &filters) {
            continue;
        }
        by_rel.insert(
            rel_path.clone(),
            CollectedFile {
                path: full_path,
                rel_path,
                lang,
            },
        );
    }
    Ok(by_rel.into_values().collect())
}

fn prepare_coverage(root: &Path, files: &[CollectedFile], opts: &CrapOptions) -> Result<Option<LcovMap>, String> {
    if opts.coverage_mode == CoverageMode::NoCoverage {
        return Ok(None);
    }

    let has_rust = files.iter().any(|f| f.lang == Lang::Rust);
    let has_ts = files.iter().any(|f| f.lang == Lang::TypeScript);

    if opts.coverage_mode == CoverageMode::Run {
        if has_rust {
            remove_stale_lcov(&root.join(RUST_LCOV_REL));
            run_rust_coverage(root);
        }
        if has_ts {
            for rel in TS_LCOV_RELS {
                remove_stale_lcov(&root.join(rel));
            }
            run_ts_coverage(root, opts.coverage_command.as_deref());
        }
    }

    let mut combined: LcovMap = HashMap::new();
    let mut found_any = false;
    for rel in std::iter::once(RUST_LCOV_REL).chain(TS_LCOV_RELS.iter().copied()) {
        let lcov_path = root.join(rel);
        if !lcov_path.is_file() {
            continue;
        }
        found_any = true;
        match qa::parse_lcov(&lcov_path) {
            Ok(parsed) => merge_lcov(&mut combined, parsed),
            Err(err) => {
                if opts.coverage_mode == CoverageMode::UseExisting {
                    return Err(err);
                }
                eprintln!("warning: ignoring unreadable LCOV {}: {err}", lcov_path.display());
            }
        }
    }

    if opts.coverage_mode == CoverageMode::UseExisting && !found_any && !files.is_empty() {
        eprintln!(
            "warning: no existing LCOV files found (checked {}, {}); treating coverage as 0%",
            RUST_LCOV_REL,
            TS_LCOV_RELS.join(", ")
        );
    }

    Ok(Some(combined))
}

fn remove_stale_lcov(path: &Path) {
    if let Err(err) = fs::remove_file(path)
        && err.kind() != io::ErrorKind::NotFound
    {
        eprintln!("warning: could not remove previous LCOV {}: {err}", path.display());
    }
}

fn run_rust_coverage(root: &Path) {
    let available = Command::new("cargo")
        .args(["llvm-cov", "--version"])
        .current_dir(root)
        .output()
        .is_ok_and(|out| out.status.success());

    if !available {
        eprintln!("warning: `cargo-llvm-cov` is not available; treating Rust coverage as 0%");
        return;
    }

    let out_path = root.join(RUST_LCOV_REL);
    if let Some(parent) = out_path.parent()
        && let Err(err) = fs::create_dir_all(parent)
    {
        eprintln!("warning: failed to create {}: {err}; treating Rust coverage as 0%", parent.display());
        return;
    }

    match Command::new("cargo")
        .args(["llvm-cov", "--lcov", "--output-path", RUST_LCOV_REL])
        .current_dir(root)
        .output()
    {
        Ok(out) if out.status.success() => {}
        Ok(out) => {
            let detail = stderr_tail(&out.stderr);
            eprintln!(
                "warning: `cargo llvm-cov` exited with {}; treating missing Rust coverage as 0%{detail}",
                out.status
            );
        }
        Err(err) => {
            eprintln!("warning: failed to execute `cargo llvm-cov`: {err}; treating Rust coverage as 0%");
        }
    }
}

fn run_ts_coverage(root: &Path, custom_cmd: Option<&str>) {
    if let Some(cmd_str) = custom_cmd {
        let mut cmd = shell_command(cmd_str);
        cmd.current_dir(root);
        match cmd.output() {
            Ok(out) if out.status.success() => {}
            Ok(out) => {
                let detail = stderr_tail(&out.stderr);
                eprintln!(
                    "warning: coverage command `{cmd_str}` exited with {}; treating missing TypeScript coverage as 0%{detail}",
                    out.status
                );
            }
            Err(err) => {
                eprintln!("warning: failed to execute coverage command `{cmd_str}`: {err}; treating TypeScript coverage as 0%");
            }
        }
        return;
    }

    let vp_available = Command::new("vp")
        .arg("--version")
        .current_dir(root)
        .output()
        .is_ok_and(|out| out.status.success());

    if !vp_available {
        eprintln!("warning: `vp` is not available; treating TypeScript coverage as 0%");
        return;
    }

    match Command::new("vp").args(["test", "run", "--coverage"]).current_dir(root).output() {
        Ok(out) if out.status.success() => {}
        Ok(out) => {
            let detail = stderr_tail(&out.stderr);
            eprintln!(
                "warning: `vp test run --coverage` exited with {}; treating missing TypeScript coverage as 0%{detail}",
                out.status
            );
        }
        Err(err) => {
            eprintln!("warning: failed to execute `vp test run --coverage`: {err}; treating TypeScript coverage as 0%");
        }
    }
}

#[cfg(unix)]
fn shell_command(cmd_str: &str) -> Command {
    let mut cmd = Command::new("sh");
    cmd.args(["-c", cmd_str]);
    cmd
}

#[cfg(not(unix))]
fn shell_command(cmd_str: &str) -> Command {
    let mut cmd = Command::new("cmd");
    cmd.args(["/C", cmd_str]);
    cmd
}

fn stderr_tail(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let last = text.lines().rev().find(|l| !l.trim().is_empty()).map(str::trim);
    match last {
        Some(line) => format!(" ({line})"),
        None => String::new(),
    }
}

fn merge_lcov(dest: &mut LcovMap, src: LcovMap) {
    for (file, lines) in src {
        let entry = dest.entry(file).or_default();
        for (line_no, hits) in lines {
            let slot = entry.entry(line_no).or_insert(0);
            *slot = slot.saturating_add(hits);
        }
    }
}

/// Computes the standard CRAP score: `CC^2 * (1 - cov)^3 + CC`, where `cov` is in `[0.0, 1.0]`.
pub fn compute_crap(cc: usize, cov_fraction: f64) -> f64 {
    let cov = cov_fraction.clamp(0.0, 1.0);
    let c = cc as f64;
    c * c * (1.0 - cov).powi(3) + c
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn evaluate_form_coverage(
    start_line: usize,
    end_line: usize,
    cc: usize,
    coverage_enabled: bool,
    file_lcov: Option<&HashMap<usize, u64>>,
) -> (usize, usize, Option<f64>, Option<f64>) {
    if !coverage_enabled {
        return (0, 0, None, None);
    }

    let Some(lines) = file_lcov else {
        return (0, 0, Some(0.0), Some(round2(compute_crap(cc, 0.0))));
    };

    let mut total = 0usize;
    let mut covered = 0usize;
    for (&line_no, &hits) in lines {
        if line_no >= start_line && line_no <= end_line {
            total += 1;
            if hits > 0 {
                covered += 1;
            }
        }
    }

    if total == 0 {
        return (0, 0, Some(0.0), Some(round2(compute_crap(cc, 0.0))));
    }

    let cov_fraction = covered as f64 / total as f64;
    let coverage_pct = round2(cov_fraction * 100.0);
    let crap_score = round2(compute_crap(cc, cov_fraction));
    (total, covered, Some(coverage_pct), Some(crap_score))
}

fn sort_entries_worst_first(entries: &mut [CrapEntry]) {
    entries.sort_by(|a, b| {
        match (b.crap, a.crap) {
            (Some(bc), Some(ac)) => bc.total_cmp(&ac),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        }
        .then_with(|| b.cc.cmp(&a.cc))
        .then_with(|| a.file.cmp(&b.file))
        .then_with(|| a.start_line.cmp(&b.start_line))
        .then_with(|| a.name.cmp(&b.name))
    });
}

fn summarize_entries(entries: &[CrapEntry], threshold: f64) -> CrapSummary {
    let scored: Vec<f64> = entries.iter().filter_map(|e| e.crap).collect();
    let total_forms = entries.len();
    let scored_forms = scored.len();
    let above_threshold = scored.iter().filter(|&&score| score > threshold).count();

    if scored.is_empty() {
        return CrapSummary {
            total_forms,
            scored_forms,
            above_threshold,
            mean_crap: None,
            max_crap: None,
            sigma_crap: None,
        };
    }

    let n = scored.len() as f64;
    let mean = scored.iter().sum::<f64>() / n;
    let max = scored.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let variance = scored.iter().map(|&x| (x - mean).powi(2)).sum::<f64>() / n;

    CrapSummary {
        total_forms,
        scored_forms,
        above_threshold,
        mean_crap: Some(round2(mean)),
        max_crap: Some(round2(max)),
        sigma_crap: Some(round2(variance.sqrt())),
    }
}

fn write_crap_edn(path: &Path, snapshot: &CrapSnapshot) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("cannot determine parent directory for {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|err| format!("failed to create {}: {err}", parent.display()))?;
    let json_val = serde_json::to_value(snapshot).map_err(|err| format!("failed to convert CRAP snapshot to JSON value: {err}"))?;
    let edn = qa::to_edn(&json_val);

    let pid = std::process::id();
    let tmp_path = parent.join(format!(".crap.edn.{pid}.tmp"));
    fs::write(&tmp_path, format!("{edn}\n")).map_err(|err| format!("failed to write {}: {err}", tmp_path.display()))?;
    if let Err(err) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("failed to rename {} -> {}: {err}", tmp_path.display(), path.display()));
    }
    Ok(())
}

fn qualified_name(entry: &CrapEntry) -> String {
    match entry.lang {
        Lang::Rust => format!("{}::{}", entry.namespace, entry.name),
        Lang::TypeScript => format!("{}.{}", entry.namespace, entry.name),
    }
}

fn format_table(snapshot: &CrapSnapshot) -> String {
    let mut out = String::new();
    if snapshot.entries.is_empty() {
        out.push_str("No forms analyzed.\n");
    } else {
        out.push_str(&format!(
            "{:>8} {:>5} {:>7} {:>8}  {:<3} {:<44} {:<36} {}\n",
            "CRAP", "CC", "Cov%", "Lines", "Vis", "Function", "Location", "Notes"
        ));
        out.push_str(&"-".repeat(124));
        out.push('\n');

        for entry in &snapshot.entries {
            let crap_str = entry.crap.map_or_else(|| "-".to_owned(), |v| format!("{v:.2}"));
            let cov_str = entry.coverage.map_or_else(|| "-".to_owned(), |v| format!("{v:.1}%"));
            let lines_str = if entry.crap.is_some() {
                format!("{}/{}", entry.lines_covered, entry.lines_total)
            } else {
                "-".to_owned()
            };
            let func = qualified_name(entry);
            let loc = format!("{}:{}-{}", entry.file, entry.start_line, entry.end_line);
            let note = if entry.is_flat_match {
                format!("flat-match ({} arms)", entry.flat_match_arms)
            } else {
                String::new()
            };
            out.push_str(&format!(
                "{crap_str:>8} {:>5} {cov_str:>7} {lines_str:>8}  {:<3} {:<44} {:<36} {note}\n",
                entry.cc,
                entry.visibility.symbol(),
                func,
                loc
            ));
        }
    }

    let mean_str = snapshot.summary.mean_crap.map_or_else(|| "-".to_owned(), |v| format!("{v:.2}"));
    let max_str = snapshot.summary.max_crap.map_or_else(|| "-".to_owned(), |v| format!("{v:.2}"));
    let sigma_str = snapshot.summary.sigma_crap.map_or_else(|| "-".to_owned(), |v| format!("{v:.2}"));
    out.push_str(&format!(
        "Summary: {} forms ({} scored, mode={}), mean={mean_str}, max={max_str}, sigma={sigma_str}, above_threshold(>{:.1})={}\n",
        snapshot.summary.total_forms, snapshot.summary.scored_forms, snapshot.coverage_mode, snapshot.threshold, snapshot.summary.above_threshold
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_workspace(tag: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("xtask-crap-{tag}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_file(root: &Path, rel: &str, content: &str) {
        let full = root.join(rel);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, content).unwrap();
    }

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn crap_formula_matches_uncle_bob_definition() {
        // 100% coverage -> CRAP == CC
        assert!((compute_crap(5, 1.0) - 5.0).abs() < 1e-12);
        // 0% coverage -> CRAP == CC^2 + CC
        assert!((compute_crap(5, 0.0) - 30.0).abs() < 1e-12);
        // 75% coverage, CC=3 -> 3^2 * (0.25)^3 + 3 = 3.140625
        let mid = compute_crap(3, 0.75);
        assert!((mid - 3.140_625).abs() < 1e-9);
        assert!((round2(mid) * 100.0 - 314.0).abs() < 1e-9);
    }

    #[test]
    fn no_coverage_mode_sets_null_coverage_and_crap_and_writes_snapshot() {
        let root = temp_workspace("no-cov");
        write_file(
            &root,
            "crates/core/src/lib.rs",
            [
                "pub fn simple(x: i32) -> i32 {",
                "    x + 1",
                "}",
                "",
                "pub fn branched(x: i32, ok: bool) -> i32 {",
                "    if ok && x > 0 { 1 } else { 0 }",
                "}",
            ]
            .join("\n")
            .as_str(),
        );

        let mut out = Vec::new();
        let code = run_with_writer(&root, &args(&["--no-coverage", "--json"]), &mut out).unwrap();
        assert_eq!(code, 0);

        let stdout_snap: CrapSnapshot = serde_json::from_slice(&out).unwrap();
        assert_eq!(stdout_snap.coverage_mode, "none");
        assert_eq!(stdout_snap.summary.total_forms, 2);
        assert_eq!(stdout_snap.summary.scored_forms, 0);
        assert_eq!(stdout_snap.summary.mean_crap, None);
        assert!(stdout_snap.entries.iter().all(|e| e.coverage.is_none() && e.crap.is_none()));
        // Worst CC first
        assert_eq!(stdout_snap.entries[0].name, "branched");
        assert_eq!(stdout_snap.entries[0].cc, 3);
        assert_eq!(stdout_snap.entries[1].name, "simple");
        assert_eq!(stdout_snap.entries[1].cc, 1);

        let disk_snap: CrapSnapshot = qa::read_json(&qa::crap_snapshot_path(&root)).unwrap();
        assert_eq!(disk_snap, stdout_snap);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_lcov_scores_zero_coverage_without_crashing() {
        let root = temp_workspace("missing-lcov");
        write_file(&root, "crates/core/src/lib.rs", "pub fn calc(a: bool) -> i32 {\n    if a { 1 } else { 2 }\n}\n");

        let mut out = Vec::new();
        let code = run_with_writer(&root, &args(&["--use-existing-coverage", "--json"]), &mut out).unwrap();
        assert_eq!(code, 0);

        let snap: CrapSnapshot = serde_json::from_slice(&out).unwrap();
        assert_eq!(snap.coverage_mode, "existing");
        assert_eq!(snap.entries.len(), 1);
        let entry = &snap.entries[0];
        assert_eq!(entry.cc, 2);
        assert_eq!(entry.lines_total, 0);
        assert_eq!(entry.lines_covered, 0);
        assert_eq!(entry.coverage, Some(0.0));
        // CC=2, cov=0% -> 2^2 + 2 = 6.0
        assert_eq!(entry.crap, Some(6.0));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn use_existing_coverage_joins_rust_and_ts_lcov_and_detects_flat_match() {
        let root = temp_workspace("existing-lcov");
        write_file(
            &root,
            "crates/core/src/engine.rs",
            [
                "pub enum Kind { A, B, C }",
                "",
                "pub fn dispatch(k: Kind, ok: bool) -> i32 {",
                "    if !ok { return 0; }",
                "    match k {",
                "        Kind::A => 1,",
                "        Kind::B => 2,",
                "        Kind::C => 3,",
                "    }",
                "}",
                "",
                "fn uninstrumented(x: i32) -> i32 {",
                "    x + 1",
                "}",
            ]
            .join("\n")
            .as_str(),
        );
        write_file(
            &root,
            "packages/protocol/src/widget.ts",
            [
                "export class Widget {",
                "  public compute(a: number, b: number): number {",
                "    if (a > 0 && b > 0) {",
                "      return a + b;",
                "    }",
                "    return 0;",
                "  }",
                "}",
            ]
            .join("\n")
            .as_str(),
        );

        // Rust LCOV covers 3 of 4 executable lines in `dispatch` (75.0%), omits `uninstrumented` (0.0%).
        write_file(
            &root,
            RUST_LCOV_REL,
            [
                &format!("SF:{}/crates/core/src/engine.rs", root.display()),
                "DA:4,1",
                "DA:5,1",
                "DA:6,1",
                "DA:7,0",
                "end_of_record",
            ]
            .join("\n")
            .as_str(),
        );

        // TS LCOV covers 4 of 4 executable lines in `Widget.compute` (100.0%).
        write_file(
            &root,
            "coverage/lcov.info",
            ["SF:packages/protocol/src/widget.ts", "DA:3,2", "DA:4,1", "DA:5,1", "DA:6,1", "end_of_record"]
                .join("\n")
                .as_str(),
        );

        let mut out = Vec::new();
        let code = run_with_writer(&root, &args(&["--use-existing-coverage", "--edn"]), &mut out).unwrap();
        assert_eq!(code, 0);

        let table = String::from_utf8(out).unwrap();
        assert!(table.contains("crate::engine::dispatch"));
        assert!(table.contains("flat-match (3 arms)"));
        assert!(table.contains("protocol.widget.Widget") || table.contains("widget.Widget"));

        let snap: CrapSnapshot = qa::read_json(&qa::crap_snapshot_path(&root)).unwrap();
        assert_eq!(snap.entries.len(), 3);

        let dispatch = snap
            .entries
            .iter()
            .find(|e| e.namespace == "crate::engine" && e.name == "dispatch")
            .expect("dispatch entry");
        // base 1 + if(1) + 3 match arms = 5
        assert_eq!(dispatch.cc, 5);
        assert!(dispatch.is_flat_match);
        assert_eq!(dispatch.flat_match_arms, 3);
        assert_eq!(dispatch.lines_total, 4);
        assert_eq!(dispatch.lines_covered, 3);
        assert_eq!(dispatch.coverage, Some(75.0));
        // 5^2 * 0.25^3 + 5 = 25 * 0.015625 + 5 = 5.390625 -> 5.39
        assert_eq!(dispatch.crap, Some(5.39));

        let uninst = snap
            .entries
            .iter()
            .find(|e| e.namespace == "crate::engine" && e.name == "uninstrumented")
            .expect("uninstrumented entry");
        assert_eq!(uninst.cc, 1);
        assert_eq!(uninst.coverage, Some(0.0));
        assert_eq!(uninst.crap, Some(2.0));

        let widget = snap
            .entries
            .iter()
            .find(|e| e.namespace == "widget.Widget" && e.name == "compute")
            .expect("Widget.compute entry");
        // base 1 + if(1) + &&(1) = 3
        assert_eq!(widget.cc, 3);
        assert_eq!(widget.lines_total, 4);
        assert_eq!(widget.lines_covered, 4);
        assert_eq!(widget.coverage, Some(100.0));
        assert_eq!(widget.crap, Some(3.0));

        // Worst-first order: dispatch (5.39) > widget (3.0) > uninstrumented (2.0)
        assert_eq!(snap.entries[0].name, "dispatch");
        assert_eq!(snap.entries[1].name, "compute");
        assert_eq!(snap.entries[2].name, "uninstrumented");

        let edn_raw = fs::read_to_string(qa::metrics_dir(&root).join("crap.edn")).unwrap();
        assert!(edn_raw.contains(":coverage-mode") || edn_raw.contains(":coverage_mode \"existing\""));
        assert!(edn_raw.contains(":coverage 75.0"));
        assert!(edn_raw.contains(":namespace \"widget.Widget\""));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn threshold_exit_code_is_strictly_greater_than_and_replaces_snapshots() {
        let root = temp_workspace("threshold");
        write_file(
            &root,
            "packages/p/src/math.ts",
            [
                "export function branchy(a: boolean, b: boolean): number {",
                "  if (a && b) { return 1; }",
                "  return 0;",
                "}",
            ]
            .join("\n")
            .as_str(),
        );
        // CC = 3, 0% coverage -> CRAP = 12.0
        let mut out_eq = Vec::new();
        let code_eq = run_with_writer(&root, &args(&["--use-existing-coverage", "--threshold", "12.0", "--edn"]), &mut out_eq).unwrap();
        assert_eq!(code_eq, 0);

        let mut out_gt = Vec::new();
        let code_gt = run_with_writer(&root, &args(&["--use-existing-coverage", "--threshold", "11.99", "--json"]), &mut out_gt).unwrap();
        assert_eq!(code_gt, 2);

        let snap: CrapSnapshot = serde_json::from_slice(&out_gt).unwrap();
        assert_eq!(snap.threshold, 11.99);
        assert_eq!(snap.summary.above_threshold, 1);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn failed_coverage_command_deletes_stale_lcov_and_falls_back_to_zero() {
        let root = temp_workspace("cmd-fail");
        write_file(&root, "packages/p/src/a.ts", "export function ok(x: number) { return x + 1; }\n");
        // Plant stale LCOV that would have scored 100% if not deleted before running coverage.
        write_file(&root, "coverage/lcov.info", "SF:packages/p/src/a.ts\nDA:1,5\nend_of_record\n");

        let mut out = Vec::new();
        let code = run_with_writer(&root, &args(&["--coverage-command", "false", "--json"]), &mut out).unwrap();
        assert_eq!(code, 0);

        assert!(!root.join("coverage/lcov.info").exists());
        let snap: CrapSnapshot = serde_json::from_slice(&out).unwrap();
        assert_eq!(snap.entries.len(), 1);
        assert_eq!(snap.entries[0].coverage, Some(0.0));
        assert_eq!(snap.entries[0].crap, Some(2.0));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn changed_flag_analyzes_only_modified_or_untracked_qa_files() {
        let root = temp_workspace("changed");
        write_file(&root, "crates/core/src/unchanged.rs", "pub fn clean() -> i32 { 1 }\n");
        let git = |args: &[&str]| {
            let status = Command::new("git")
                .args(args)
                .current_dir(&root)
                .env("GIT_AUTHOR_NAME", "Test")
                .env("GIT_AUTHOR_EMAIL", "test@example.com")
                .env("GIT_COMMITTER_NAME", "Test")
                .env("GIT_COMMITTER_EMAIL", "test@example.com")
                .status()
                .unwrap();
            assert!(status.success(), "git {args:?} failed");
        };
        git(&["init", "-q"]);
        git(&["add", "crates/core/src/unchanged.rs"]);
        git(&["commit", "-q", "-m", "init"]);

        write_file(&root, "crates/core/src/touched.rs", "pub fn dirty(a: bool) -> i32 { if a { 1 } else { 0 } }\n");
        write_file(&root, "crates/core/tests/ignored.rs", "fn skipped() {}\n");

        let mut out = Vec::new();
        let code = run_with_writer(&root, &args(&["--changed", "--no-coverage", "--json"]), &mut out).unwrap();
        assert_eq!(code, 0);

        let snap: CrapSnapshot = serde_json::from_slice(&out).unwrap();
        assert_eq!(snap.entries.len(), 1);
        assert_eq!(snap.entries[0].name, "dirty");
        assert_eq!(snap.entries[0].file, "crates/core/src/touched.rs");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_conflicting_and_invalid_cli_flags() {
        let root = temp_workspace("bad-args");
        assert!(parse_args(&args(&["--no-coverage", "--use-existing-coverage"])).is_err());
        assert!(parse_args(&args(&["--no-coverage", "--coverage-command", "echo"])).is_err());
        assert!(parse_args(&args(&["--threshold", "-1"])).is_err());
        assert!(parse_args(&args(&["--threshold", "abc"])).is_err());
        assert!(parse_args(&args(&["--bogus"])).is_err());

        let mut out = Vec::new();
        let code = run_with_writer(&root, &args(&["--help"]), &mut out).unwrap();
        assert_eq!(code, 0);
        assert!(String::from_utf8(out).unwrap().contains("Usage: cargo xtask crap"));

        let _ = fs::remove_dir_all(&root);
    }
}
