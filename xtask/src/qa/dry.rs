//! Normalized structural clone detector (`cargo xtask dry`).

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use crate::qa::{self, DryCandidate, DrySide, DrySnapshot, Lang};

const DEFAULT_THRESHOLD: f64 = 0.82;
const DEFAULT_MIN_LINES: usize = 4;
const DEFAULT_MIN_NODES: usize = 20;
const SHINGLE_K: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OutputFormat {
    Text,
    Json,
    Edn,
}

#[derive(Debug, Clone, PartialEq)]
struct DryOptions {
    threshold: f64,
    min_lines: usize,
    min_nodes: usize,
    changed: bool,
    format: OutputFormat,
    help: bool,
    filters: Vec<String>,
}

enum ArgError {
    Usage(String),
    UnknownFormat(String),
}

struct IndexedForm {
    side: DrySide,
    lang: Lang,
    shingles: Vec<(u128, usize)>,
    token_bag: Vec<(u128, usize)>,
    total_shingles: usize,
}

struct ScoredCandidate {
    candidate: DryCandidate,
    token_bag_similarity: f64,
}

fn usage_text() -> &'static str {
    "\
Usage: cargo xtask dry [paths/fragments...] [options]

Options:
  --threshold <F>   Minimum Jaccard similarity in [0.0, 1.0] (default: 0.82)
  --min-lines <N>   Minimum form line count (default: 4)
  --min-nodes <N>   Minimum normalized syntax tokens (default: 20)
  --changed         Compare git-changed files against all matching forms
  --format <FMT>    Output format: text | json | edn (default: text)
  --text            Shorthand for --format text
  --json            Shorthand for --format json
  --edn             Shorthand for --format edn (also writes .metrics/dry.edn)
  -h, --help        Show this help message"
}

fn parse_threshold(raw: &str) -> Result<f64, ArgError> {
    let val: f64 = raw
        .parse()
        .map_err(|_| ArgError::Usage(format!("dry: invalid --threshold `{raw}` (expected float in [0.0, 1.0])")))?;
    if !val.is_finite() || !(0.0..=1.0).contains(&val) {
        return Err(ArgError::Usage(format!("dry: --threshold `{raw}` must be finite and within [0.0, 1.0]")));
    }
    Ok(val)
}

fn parse_positive_usize(flag: &str, raw: &str) -> Result<usize, ArgError> {
    let val: usize = raw
        .parse()
        .map_err(|_| ArgError::Usage(format!("dry: invalid {flag} `{raw}` (expected positive integer)")))?;
    if val == 0 {
        return Err(ArgError::Usage(format!("dry: {flag} must be >= 1")));
    }
    Ok(val)
}

fn parse_format(raw: &str) -> Result<OutputFormat, ArgError> {
    match raw {
        "text" => Ok(OutputFormat::Text),
        "json" => Ok(OutputFormat::Json),
        "edn" => Ok(OutputFormat::Edn),
        other => Err(ArgError::UnknownFormat(format!(
            "dry: unknown --format `{other}` (expected text, json, or edn)"
        ))),
    }
}

fn take_value<'a>(args: &'a [String], idx: &mut usize, flag: &str) -> Result<&'a str, ArgError> {
    *idx += 1;
    args.get(*idx)
        .map(String::as_str)
        .ok_or_else(|| ArgError::Usage(format!("dry: {flag} requires a value")))
}

fn parse_args(args: &[String]) -> Result<DryOptions, ArgError> {
    let mut opts = DryOptions {
        threshold: DEFAULT_THRESHOLD,
        min_lines: DEFAULT_MIN_LINES,
        min_nodes: DEFAULT_MIN_NODES,
        changed: false,
        format: OutputFormat::Text,
        help: false,
        filters: Vec::new(),
    };

    let mut i = 0usize;
    let mut positional_only = false;
    while i < args.len() {
        let arg = args[i].as_str();
        if positional_only {
            opts.filters.push(args[i].clone());
            i += 1;
            continue;
        }
        match arg {
            "--" => positional_only = true,
            "--help" | "-h" => opts.help = true,
            "--changed" => opts.changed = true,
            "--text" => opts.format = OutputFormat::Text,
            "--json" => opts.format = OutputFormat::Json,
            "--edn" => opts.format = OutputFormat::Edn,
            "--threshold" => {
                let val = take_value(args, &mut i, "--threshold")?;
                opts.threshold = parse_threshold(val)?;
            }
            "--min-lines" => {
                let val = take_value(args, &mut i, "--min-lines")?;
                opts.min_lines = parse_positive_usize("--min-lines", val)?;
            }
            "--min-nodes" => {
                let val = take_value(args, &mut i, "--min-nodes")?;
                opts.min_nodes = parse_positive_usize("--min-nodes", val)?;
            }
            "--format" => {
                let val = take_value(args, &mut i, "--format")?;
                opts.format = parse_format(val)?;
            }
            _ if arg.starts_with("--threshold=") => {
                opts.threshold = parse_threshold(&arg["--threshold=".len()..])?;
            }
            _ if arg.starts_with("--min-lines=") => {
                opts.min_lines = parse_positive_usize("--min-lines", &arg["--min-lines=".len()..])?;
            }
            _ if arg.starts_with("--min-nodes=") => {
                opts.min_nodes = parse_positive_usize("--min-nodes", &arg["--min-nodes=".len()..])?;
            }
            _ if arg.starts_with("--format=") => {
                opts.format = parse_format(&arg["--format=".len()..])?;
            }
            _ if arg.starts_with('-') => {
                return Err(ArgError::Usage(format!("dry: unknown option `{arg}`\n\n{}", usage_text())));
            }
            _ => opts.filters.push(args[i].clone()),
        }
        i += 1;
    }

    Ok(opts)
}

fn fnv1a_128_tokens(tokens: &[String]) -> u128 {
    let mut h1: u64 = 0xcbf2_9ce4_8422_2325;
    let mut h2: u64 = 0xaf63_bd4c_8601_b7df;
    for (idx, tok) in tokens.iter().enumerate() {
        if idx > 0 {
            // 0xff never occurs in UTF-8, preventing ["a", "bc"] vs ["ab", "c"] collisions.
            h1 ^= 0xff;
            h1 = h1.wrapping_mul(0x0100_0000_01b3);
            h2 = h2.wrapping_mul(0x0100_0000_01b3);
            h2 ^= 0xff;
        }
        for &b in tok.as_bytes() {
            h1 ^= u64::from(b);
            h1 = h1.wrapping_mul(0x0100_0000_01b3);
            h2 = h2.wrapping_mul(0x0100_0000_01b3);
            h2 ^= u64::from(b);
        }
    }
    (u128::from(h1) << 64) | u128::from(h2)
}

fn compress_sorted_hashes(mut hashes: Vec<u128>) -> Vec<(u128, usize)> {
    hashes.sort_unstable();
    let mut out: Vec<(u128, usize)> = Vec::with_capacity(hashes.len());
    for h in hashes {
        if let Some(last) = out.last_mut()
            && last.0 == h
        {
            last.1 += 1;
        } else {
            out.push((h, 1));
        }
    }
    out
}

fn build_shingles(normalized: &[String]) -> (Vec<(u128, usize)>, usize) {
    if normalized.is_empty() {
        return (Vec::new(), 0);
    }
    let k = if normalized.len() >= SHINGLE_K { SHINGLE_K } else { 1 };
    let hashes: Vec<u128> = normalized.windows(k).map(fnv1a_128_tokens).collect();
    let total = hashes.len();
    (compress_sorted_hashes(hashes), total)
}

fn build_token_bag(normalized: &[String]) -> Vec<(u128, usize)> {
    let hashes: Vec<u128> = normalized.iter().map(|tok| fnv1a_128_tokens(std::slice::from_ref(tok))).collect();
    compress_sorted_hashes(hashes)
}

fn multiset_jaccard(a: &[(u128, usize)], b: &[(u128, usize)]) -> (usize, usize, f64) {
    let mut shared = 0usize;
    let mut union = 0usize;
    let (mut i, mut j) = (0usize, 0usize);

    while i < a.len() && j < b.len() {
        match a[i].0.cmp(&b[j].0) {
            Ordering::Less => {
                union += a[i].1;
                i += 1;
            }
            Ordering::Greater => {
                union += b[j].1;
                j += 1;
            }
            Ordering::Equal => {
                shared += a[i].1.min(b[j].1);
                union += a[i].1.max(b[j].1);
                i += 1;
                j += 1;
            }
        }
    }
    while i < a.len() {
        union += a[i].1;
        i += 1;
    }
    while j < b.len() {
        union += b[j].1;
        j += 1;
    }

    let similarity = if union == 0 { 0.0 } else { shared as f64 / union as f64 };
    (shared, union, similarity)
}

fn side_sort_key(side: &DrySide) -> (&str, usize, usize, &str, &str) {
    (&side.file, side.start_line, side.end_line, &side.namespace, &side.name)
}

fn orient_sides(a: DrySide, b: DrySide) -> (DrySide, DrySide) {
    if side_sort_key(&a) <= side_sort_key(&b) { (a, b) } else { (b, a) }
}

fn find_lang_duplicates(mut forms: Vec<IndexedForm>, threshold: f64, changed_files: Option<&HashSet<String>>, out: &mut Vec<ScoredCandidate>) {
    if forms.len() < 2 {
        return;
    }

    forms.sort_unstable_by(|a, b| {
        a.total_shingles
            .cmp(&b.total_shingles)
            .then_with(|| side_sort_key(&a.side).cmp(&side_sort_key(&b.side)))
    });

    let n = forms.len();
    let mut postings: HashMap<u128, Vec<usize>> = HashMap::new();
    for (idx, form) in forms.iter().enumerate() {
        for &(hash, _) in &form.shingles {
            postings.entry(hash).or_default().push(idx);
        }
    }

    let mut seen_stamp = vec![0usize; n];
    let mut peer_indices: Vec<usize> = Vec::new();
    let mut freq_ordered: Vec<(u128, usize, usize)> = Vec::new();

    for i in 0..n {
        let len_i = forms[i].total_shingles;
        if len_i == 0 {
            continue;
        }
        let i_changed = changed_files.is_none_or(|set| set.contains(&forms[i].side.file));

        peer_indices.clear();
        let stamp = i + 1;

        if threshold <= 0.0 {
            for (j, peer) in forms.iter().enumerate().skip(i + 1) {
                if i_changed || changed_files.is_none_or(|set| set.contains(&peer.side.file)) {
                    peer_indices.push(j);
                }
            }
        } else {
            // Exact multiset-Jaccard prefix filter: any pair with W_i <= W_j and similarity >= t
            // has shared >= 2*t*W_i / (1+t), so missing more than W_i*(1-t)/(1+t) weight in A is impossible.
            let need_weight = ((len_i as f64) * (1.0 - threshold) / (1.0 + threshold)).floor() as usize + 1;
            freq_ordered.clear();
            for &(hash, count) in &forms[i].shingles {
                let df = postings.get(&hash).map_or(0, Vec::len);
                freq_ordered.push((hash, count, df));
            }
            freq_ordered.sort_unstable_by(|a, b| a.2.cmp(&b.2).then_with(|| a.0.cmp(&b.0)));

            let mut cum = 0usize;
            for &(hash, count, _) in &freq_ordered {
                if let Some(list) = postings.get(&hash) {
                    let start = list.partition_point(|&idx| idx <= i);
                    for &j in &list[start..] {
                        let len_j = forms[j].total_shingles;
                        if (len_i as f64) < (len_j as f64) * threshold - 1e-12 {
                            break;
                        }
                        if seen_stamp[j] != stamp {
                            seen_stamp[j] = stamp;
                            if i_changed || changed_files.is_none_or(|set| set.contains(&forms[j].side.file)) {
                                peer_indices.push(j);
                            }
                        }
                    }
                }
                cum += count;
                if cum >= need_weight {
                    break;
                }
            }
        }

        for &j in &peer_indices {
            let (shared, union, similarity) = multiset_jaccard(&forms[i].shingles, &forms[j].shingles);
            if similarity + 1e-12 < threshold {
                continue;
            }
            let (_, _, token_bag_similarity) = multiset_jaccard(&forms[i].token_bag, &forms[j].token_bag);
            let (left, right) = orient_sides(forms[i].side.clone(), forms[j].side.clone());
            out.push(ScoredCandidate {
                candidate: DryCandidate {
                    lang: forms[i].lang,
                    similarity,
                    shared_fingerprints: shared,
                    union_fingerprints: union,
                    left,
                    right,
                },
                token_bag_similarity,
            });
        }
    }
}

fn analyze_dry(root: &Path, options: &DryOptions) -> Result<DrySnapshot, String> {
    let files = qa::collect_project_files(root, &options.filters, None)?;
    let changed_set = if options.changed {
        let paths = qa::changed_files(root)?;
        Some(
            paths
                .into_iter()
                .map(|p| qa::normalize_posix_path(&p.to_string_lossy()))
                .collect::<HashSet<String>>(),
        )
    } else {
        None
    };

    let mut rust_forms = Vec::new();
    let mut ts_forms = Vec::new();

    for file in &files {
        let source = fs::read_to_string(&file.path).map_err(|err| format!("failed to read {}: {err}", file.path.display()))?;
        let analysis = qa::lang::analyze_file(root, &file.path, &source, file.lang);
        let line_candidates: Vec<_> = analysis.forms.into_iter().filter(|f| f.line_count() >= options.min_lines).collect();
        if line_candidates.is_empty() {
            continue;
        }

        let tokens = qa::lang::tokenize(&source, file.lang);
        for form in line_candidates {
            let slice = qa::lang::form_tokens(&tokens, &form);
            let normalized = qa::lang::normalize_form_tokens(slice, form.lang);
            let nodes = normalized.len();
            if nodes < options.min_nodes {
                continue;
            }
            let (shingles, total_shingles) = build_shingles(&normalized);
            let token_bag = build_token_bag(&normalized);
            let indexed = IndexedForm {
                side: DrySide {
                    namespace: form.namespace.clone(),
                    name: form.name.clone(),
                    kind: form.kind,
                    visibility: form.visibility,
                    file: form.file.clone(),
                    start_line: form.start_line,
                    end_line: form.end_line,
                    lines: form.line_count(),
                    nodes,
                },
                lang: form.lang,
                shingles,
                token_bag,
                total_shingles,
            };
            match form.lang {
                Lang::Rust => rust_forms.push(indexed),
                Lang::TypeScript => ts_forms.push(indexed),
            }
        }
    }

    let scanned_forms = rust_forms.len() + ts_forms.len();
    let mut scored = Vec::new();
    find_lang_duplicates(rust_forms, options.threshold, changed_set.as_ref(), &mut scored);
    find_lang_duplicates(ts_forms, options.threshold, changed_set.as_ref(), &mut scored);

    scored.sort_by(|a, b| {
        b.candidate
            .similarity
            .total_cmp(&a.candidate.similarity)
            .then_with(|| b.candidate.shared_fingerprints.cmp(&a.candidate.shared_fingerprints))
            .then_with(|| b.token_bag_similarity.total_cmp(&a.token_bag_similarity))
            .then_with(|| side_sort_key(&a.candidate.left).cmp(&side_sort_key(&b.candidate.left)))
            .then_with(|| side_sort_key(&a.candidate.right).cmp(&side_sort_key(&b.candidate.right)))
    });

    Ok(DrySnapshot {
        version: 1,
        threshold: options.threshold,
        min_lines: options.min_lines,
        min_nodes: options.min_nodes,
        scanned_forms,
        candidates: scored.into_iter().map(|s| s.candidate).collect(),
    })
}

fn write_text_atomic(path: &Path, body: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("cannot determine parent directory for {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|err| format!("failed to create {}: {err}", parent.display()))?;

    let pid = std::process::id();
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("dry.edn");
    let tmp_path = parent.join(format!(".{file_name}.{pid}.tmp"));
    fs::write(&tmp_path, body).map_err(|err| format!("failed to write {}: {err}", tmp_path.display()))?;
    if let Err(err) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("failed to rename {} -> {}: {err}", tmp_path.display(), path.display()));
    }
    Ok(())
}

fn format_report(snapshot: &DrySnapshot, format: OutputFormat) -> Result<String, String> {
    match format {
        OutputFormat::Text => {
            if snapshot.candidates.is_empty() {
                return Ok(format!(
                    "dry: 0 duplicates across {} forms (threshold {:.2})",
                    snapshot.scanned_forms, snapshot.threshold
                ));
            }
            let mut lines = Vec::with_capacity(snapshot.candidates.len() * 3);
            for cand in &snapshot.candidates {
                lines.push(format!("DUPLICATE score={:.2}", cand.similarity));
                lines.push(format!("  {}:{}-{}", cand.left.file, cand.left.start_line, cand.left.end_line));
                lines.push(format!("  {}:{}-{}", cand.right.file, cand.right.start_line, cand.right.end_line));
            }
            Ok(lines.join("\n"))
        }
        OutputFormat::Json => serde_json::to_string_pretty(snapshot).map_err(|err| format!("failed to serialize dry snapshot JSON: {err}")),
        OutputFormat::Edn => {
            let value = serde_json::to_value(snapshot).map_err(|err| format!("failed to convert dry snapshot to JSON value: {err}"))?;
            Ok(qa::to_edn(&value))
        }
    }
}

pub fn run(root: &Path, args: &[String]) -> Result<i32, String> {
    let options = match parse_args(args) {
        Ok(opts) => opts,
        Err(ArgError::Usage(msg)) => {
            eprintln!("{msg}");
            return Ok(1);
        }
        Err(ArgError::UnknownFormat(msg)) => {
            eprintln!("{msg}");
            return Ok(2);
        }
    };

    if options.help {
        println!("{}", usage_text());
        return Ok(0);
    }

    let snapshot = analyze_dry(root, &options)?;
    qa::write_json(&qa::dry_snapshot_path(root), &snapshot)?;

    let report = format_report(&snapshot, options.format)?;
    if options.format == OutputFormat::Edn {
        let edn_path = qa::metrics_dir(root).join("dry.edn");
        write_text_atomic(&edn_path, &format!("{report}\n"))?;
    }

    println!("{report}");
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("xtask-dry-{tag}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_file(root: &Path, rel: &str, body: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|v| (*v).to_owned()).collect()
    }

    #[test]
    fn detects_isomorphic_clones_with_renamed_locals_and_fields_in_rust_and_ts() {
        let dir = temp_dir("isomorphic");
        write_file(
            &dir,
            "src/orders.rs",
            r#"
pub fn score_orders(orders: &[Order]) -> i64 {
    let mut total = 0;
    for order in orders {
        if order.active && order.total > 10 {
            total += order.total;
        }
    }
    total
}

fn score_rows(rows: &[Row]) -> i64 {
    let mut acc = 100;
    for row in rows {
        if row.enabled && row.amount > 5 {
            acc += row.amount;
        }
    }
    acc
}
"#,
        );
        write_file(
            &dir,
            "src/calc.ts",
            r#"
export function sumOrders(orders: Order[]): number {
  let sum = 0;
  for (const order of orders) {
    if (order.active && order.total > 1) {
      sum += order.total;
    }
  }
  return sum;
}

export function sumRows(rows: Row[]): number {
  let acc = 99;
  for (const row of rows) {
    if (row.enabled && row.amount > 2) {
      acc += row.amount;
    }
  }
  return acc;
}
"#,
        );

        let code = run(&dir, &s(&[])).unwrap();
        assert_eq!(code, 0);

        let snap: DrySnapshot = qa::read_json(&qa::dry_snapshot_path(&dir)).unwrap();
        assert_eq!(snap.candidates.len(), 2);

        let ts_cand = snap.candidates.iter().find(|c| c.lang == Lang::TypeScript).unwrap();
        assert!((ts_cand.similarity - 1.0).abs() < 1e-9);
        assert_eq!(ts_cand.shared_fingerprints, ts_cand.union_fingerprints);

        let rs_cand = snap.candidates.iter().find(|c| c.lang == Lang::Rust).unwrap();
        assert!(rs_cand.similarity >= 0.82, "expected >= 0.82, got {}", rs_cand.similarity);

        let text = format_report(&snap, OutputFormat::Text).unwrap();
        assert!(text.contains("DUPLICATE score="));
        assert!(text.contains("  src/orders.rs:"));
        assert!(text.contains("  src/calc.ts:"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn skips_forms_below_min_lines_or_min_nodes_by_default() {
        let dir = temp_dir("thresholds");
        // Identical 3-line functions (< default min_lines = 4) and < 20 normalized nodes
        write_file(
            &dir,
            "src/small.rs",
            r#"
fn alpha(order: Order) -> i32 {
    order.total + 1
}

fn beta(row: Row) -> i32 {
    row.amount + 2
}
"#,
        );
        // 4 lines, but only 15 normalized tokens (< default min_nodes = 20)
        write_file(
            &dir,
            "src/short_nodes.rs",
            r#"
fn gamma(x: i32) -> i32 {
    let y = x;
    y
}

fn delta(a: i32) -> i32 {
    let b = a;
    b
}
"#,
        );

        let default_snap = analyze_dry(
            &dir,
            &DryOptions {
                threshold: DEFAULT_THRESHOLD,
                min_lines: DEFAULT_MIN_LINES,
                min_nodes: DEFAULT_MIN_NODES,
                changed: false,
                format: OutputFormat::Text,
                help: false,
                filters: Vec::new(),
            },
        )
        .unwrap();
        assert_eq!(default_snap.scanned_forms, 0);
        assert!(default_snap.candidates.is_empty());

        // Lowering min_lines and min_nodes picks both pairs up
        let lowered = analyze_dry(
            &dir,
            &DryOptions {
                threshold: DEFAULT_THRESHOLD,
                min_lines: 3,
                min_nodes: 10,
                changed: false,
                format: OutputFormat::Text,
                help: false,
                filters: Vec::new(),
            },
        )
        .unwrap();
        assert_eq!(lowered.scanned_forms, 4);
        assert!(lowered.candidates.iter().any(|c| c.left.name == "alpha" && c.right.name == "beta"));
        assert!(lowered.candidates.iter().any(|c| c.left.name == "gamma" && c.right.name == "delta"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn never_cross_matches_rust_and_typescript() {
        let dir = temp_dir("no-cross-lang");
        // Put one Rust file and one TypeScript file with highly similar bodies;
        // even at a permissive threshold, Rust and TypeScript must never cross-match.
        write_file(
            &dir,
            "src/only.rs",
            r#"
fn compute_shape(a: i32, b: i32) -> i32 {
    let mut sum = 0;
    if a > 0 {
        sum += helper(a + b) + 1;
    }
    sum + helper(b)
}
"#,
        );
        write_file(
            &dir,
            "src/only.ts",
            r#"
function compute_shape(a: number, b: number): number {
    let sum = 0;
    if (a > 0) {
        sum += helper(a + b) + 1;
    }
    return sum + helper(b);
}
"#,
        );

        let snap = analyze_dry(
            &dir,
            &DryOptions {
                threshold: 0.1,
                min_lines: 3,
                min_nodes: 5,
                changed: false,
                format: OutputFormat::Text,
                help: false,
                filters: Vec::new(),
            },
        )
        .unwrap();
        assert!(snap.scanned_forms == 2);
        assert!(snap.candidates.is_empty(), "expected zero cross-language matches, got {:?}", snap.candidates);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn changed_mode_pairs_changed_forms_against_all_repo_forms_only() {
        let dir = temp_dir("changed");
        Command::new("git").args(["init", "-q"]).current_dir(&dir).status().unwrap();
        Command::new("git")
            .args(["config", "user.email", "qa@example.com"])
            .current_dir(&dir)
            .status()
            .unwrap();
        Command::new("git").args(["config", "user.name", "QA"]).current_dir(&dir).status().unwrap();

        let body_template = |name: &str| {
            format!(
                "pub fn {name}(items: &[Item]) -> i64 {{\n    let mut total = 0;\n    for item in items {{\n        if item.active && item.count > 0 {{\n            total += item.count;\n        }}\n    }}\n    total\n}}\n"
            )
        };
        write_file(&dir, "src/base_one.rs", &body_template("base_one"));
        write_file(&dir, "src/base_two.rs", &body_template("base_two"));
        Command::new("git").args(["add", "."]).current_dir(&dir).status().unwrap();
        Command::new("git").args(["commit", "-q", "-m", "init"]).current_dir(&dir).status().unwrap();

        // Add an untracked/changed file duplicating base_one/base_two; base_one vs base_two should NOT be flagged.
        write_file(&dir, "src/new_clone.rs", &body_template("new_clone"));

        let code = run(&dir, &s(&["--changed", "--json"])).unwrap();
        assert_eq!(code, 0);
        let snap: DrySnapshot = qa::read_json(&qa::dry_snapshot_path(&dir)).unwrap();
        assert_eq!(snap.candidates.len(), 2);
        assert!(
            snap.candidates
                .iter()
                .all(|c| c.left.file == "src/new_clone.rs" || c.right.file == "src/new_clone.rs")
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cli_exit_codes_and_edn_output_match_spec() {
        let dir = temp_dir("cli");
        write_file(
            &dir,
            "src/dup.rs",
            r#"
pub fn first(order: Order) -> i64 {
    let mut sum = 0;
    for item in order.items {
        if item.ok && item.price > 0 {
            sum += item.price;
        }
    }
    sum
}

pub fn second(row: Row) -> i64 {
    let mut acc = 0;
    for entry in row.entries {
        if entry.valid && entry.cost > 0 {
            acc += entry.cost;
        }
    }
    acc
}
"#,
        );

        assert_eq!(run(&dir, &s(&["--help"])).unwrap(), 0);
        assert_eq!(run(&dir, &s(&["--unknown-flag"])).unwrap(), 1);
        assert_eq!(run(&dir, &s(&["--threshold", "1.5"])).unwrap(), 1);
        assert_eq!(run(&dir, &s(&["--min-lines", "0"])).unwrap(), 1);
        assert_eq!(run(&dir, &s(&["--format", "xml"])).unwrap(), 2);
        assert_eq!(run(&dir, &s(&["--format=yaml"])).unwrap(), 2);

        assert_eq!(run(&dir, &s(&["--format", "edn"])).unwrap(), 0);
        let json_snap: DrySnapshot = qa::read_json(&qa::dry_snapshot_path(&dir)).unwrap();
        let edn_text = fs::read_to_string(qa::metrics_dir(&dir).join("dry.edn")).unwrap();
        let expected_edn = qa::to_edn(&serde_json::to_value(&json_snap).unwrap());
        assert_eq!(edn_text.trim_end(), expected_edn);
        assert!(edn_text.contains(":candidates ["));
        assert!(edn_text.contains(":shared_fingerprints"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn real_repo_gateway_http_produces_valid_dry_snapshot_and_edn_parity() {
        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let options = DryOptions {
            threshold: DEFAULT_THRESHOLD,
            min_lines: DEFAULT_MIN_LINES,
            min_nodes: DEFAULT_MIN_NODES,
            changed: false,
            format: OutputFormat::Json,
            help: false,
            filters: s(&["crates/server/src/gateway/http"]),
        };

        let snapshot = analyze_dry(repo_root, &options).unwrap();
        assert!(snapshot.scanned_forms > 0, "expected forms in crates/server/src/gateway/http");
        assert_eq!(snapshot.version, 1);

        let dir = temp_dir("repo-smoke");
        let snap_path = qa::dry_snapshot_path(&dir);
        qa::write_json(&snap_path, &snapshot).unwrap();
        let roundtrip: DrySnapshot = qa::read_json(&snap_path).unwrap();
        assert_eq!(roundtrip, snapshot);

        let json_report = format_report(&snapshot, OutputFormat::Json).unwrap();
        let parsed_stdout: DrySnapshot = serde_json::from_str(&json_report).unwrap();
        assert_eq!(parsed_stdout, snapshot);

        let edn_report = format_report(&snapshot, OutputFormat::Edn).unwrap();
        assert!(edn_report.contains(":version 1"));
        assert!(edn_report.contains(":scanned_forms"));
        assert!(edn_report.contains(":candidates"));

        let _ = fs::remove_dir_all(&dir);
    }
}
