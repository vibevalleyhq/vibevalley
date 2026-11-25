//! Clean Architecture topology IR, dependency rule checker, and UML viewer (`cargo xtask uml`).

#[path = "viewer.rs"]
mod viewer;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::qa::lang::{FileAnalysis, RelationKind, TypeDecl, analyze_file};
use crate::qa::{
    CrapEntry, CrapSnapshot, FormInfo, FormKind, Lang, MutateForm, MutateSnapshot, Visibility, collect_project_files, crap_snapshot_path, mutate_snapshot_dir,
    read_json, to_edn, uml_dir, write_json,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EdgeKind {
    Dependency,
    Implements,
    Inheritance,
    Association,
}

impl EdgeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dependency => "dependency",
            Self::Implements => "implements",
            Self::Inheritance => "inheritance",
            Self::Association => "association",
        }
    }
}

impl From<RelationKind> for EdgeKind {
    fn from(kind: RelationKind) -> Self {
        match kind {
            RelationKind::Dependency => Self::Dependency,
            RelationKind::Implements => Self::Implements,
            RelationKind::Association => Self::Association,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceSpec {
    pub lang: Lang,
    pub root: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Proposal {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub layers: Vec<Vec<String>>,
    #[serde(default)]
    pub omit: Vec<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Policy {
    pub title: String,
    #[serde(default)]
    pub prefix: String,
    #[serde(default = "default_true")]
    pub hierarchical: bool,
    #[serde(default)]
    pub sources: Vec<SourceSpec>,
    #[serde(default)]
    pub foreign: Vec<String>,
    #[serde(default)]
    pub order: Vec<String>,
    #[serde(default)]
    pub levels: Vec<Vec<String>>,
    #[serde(default)]
    pub omit: Vec<String>,
    #[serde(default)]
    pub edge_kinds: BTreeMap<String, EdgeKind>,
    #[serde(default)]
    pub proposals: Vec<Proposal>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Component,
    Class,
    Foreign,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComponentNode {
    pub id: String,
    pub name: String,
    pub node_kind: NodeKind,
    #[serde(default)]
    pub children: Vec<ComponentNode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemberField {
    pub name: String,
    pub visibility: Visibility,
    pub line: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemberOp {
    pub name: String,
    pub visibility: Visibility,
    pub kind: FormKind,
    pub line: usize,
    pub end_line: usize,
    pub file: String,
    pub raw_namespace: String,
    pub crap: Option<f64>,
    pub cc: Option<usize>,
    pub coverage: Option<f64>,
    pub has_mutation: bool,
    pub killed: usize,
    pub survived: usize,
    pub uncovered: usize,
    pub sites: usize,
    pub mutation_score: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodeMetrics {
    pub form_count: usize,
    pub crap_count: usize,
    pub crap_mu: Option<f64>,
    pub crap_max: Option<f64>,
    pub crap_sigma: Option<f64>,
    pub crap_grade: u8,
    pub crap_color: String,
    pub has_mutation: bool,
    pub killed: usize,
    pub survived: usize,
    pub uncovered: usize,
    pub sites: usize,
    pub mutation_score: Option<f64>,
    pub mutation_grade: u8,
    pub mutation_color: String,
    pub combined_grade: f64,
    pub fill_color: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IrNodeMeta {
    pub id: String,
    pub name: String,
    pub node_kind: NodeKind,
    pub parent: Option<String>,
    pub children: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lang: Option<Lang>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub type_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_namespace: Option<String>,
    #[serde(default)]
    pub fields: Vec<MemberField>,
    #[serde(default)]
    pub ops: Vec<MemberOp>,
    #[serde(default)]
    pub bases: Vec<String>,
    pub metrics: NodeMetrics,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IrEdge {
    pub from: String,
    pub to: String,
    pub kind: EdgeKind,
    pub violating: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_rank: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_rank: Option<usize>,
    pub file: String,
    pub line: usize,
    pub raw_target: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DependencyViolation {
    pub from: String,
    pub to: String,
    pub from_rank: usize,
    pub to_rank: usize,
    pub kind: EdgeKind,
    pub file: String,
    pub line: usize,
    pub raw_target: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TopologyStats {
    pub total_components: usize,
    pub total_classes: usize,
    pub total_foreign: usize,
    pub total_forms: usize,
    pub total_edges: usize,
    pub violating_edges: usize,
    pub crap_covered_forms: usize,
    pub mutation_covered_forms: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TopologyIr {
    pub version: u32,
    pub title: String,
    pub prefix: String,
    pub hierarchical: bool,
    pub root: ComponentNode,
    pub nodes: BTreeMap<String, IrNodeMeta>,
    pub edges: Vec<IrEdge>,
    pub violations: Vec<DependencyViolation>,
    pub stats: TopologyStats,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RolledEdgePair {
    pub from: String,
    pub to: String,
    pub kind: EdgeKind,
    pub violating: bool,
    pub file: String,
    pub line: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RolledEdge {
    pub from: String,
    pub to: String,
    pub kind: EdgeKind,
    pub violating: bool,
    pub pairs: Vec<RolledEdgePair>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProposalEval {
    pub id: String,
    pub name: String,
    pub violating_count: usize,
    pub violations: Vec<DependencyViolation>,
    pub edge_violations: Vec<bool>,
}

pub fn policy_path(root: &Path) -> PathBuf {
    uml_dir(root).join("policy.json")
}

pub fn topology_path(root: &Path) -> PathBuf {
    uml_dir(root).join("topology.json")
}

pub fn default_policy(root: &Path) -> Policy {
    let candidate_crates = ["protocol", "core", "git", "files", "rich", "runtime", "server", "cli"];
    let mut sources = Vec::new();
    let mut order = Vec::new();

    for crate_name in candidate_crates {
        let rel = format!("crates/{crate_name}");
        if root.join(&rel).is_dir() {
            sources.push(SourceSpec {
                lang: Lang::Rust,
                root: rel,
                prefix: Some(format!("vibevalley.{crate_name}")),
            });
            order.push(crate_name.to_owned());
        }
    }

    if root.join("apps/mac/ui").is_dir() {
        sources.push(SourceSpec {
            lang: Lang::TypeScript,
            root: "apps/mac/ui".to_owned(),
            prefix: Some("vibevalley.mac".to_owned()),
        });
        order.push("mac".to_owned());
    }

    if !sources.is_empty() {
        let levels_template: &[&[&str]] = &[&["protocol"], &["core"], &["git", "files", "rich"], &["runtime"], &["server"], &["cli", "mac"]];
        let present: BTreeSet<&str> = order.iter().map(String::as_str).collect();
        let levels: Vec<Vec<String>> = levels_template
            .iter()
            .map(|grp| grp.iter().copied().filter(|name| present.contains(name)).map(str::to_owned).collect())
            .filter(|grp: &Vec<String>| !grp.is_empty())
            .collect();

        return Policy {
            title: "VibeValley Architecture".to_owned(),
            prefix: "vibevalley".to_owned(),
            hierarchical: true,
            sources,
            foreign: vec![
                "serde".to_owned(),
                "serde_json".to_owned(),
                "tokio".to_owned(),
                "axum".to_owned(),
                "sea_orm".to_owned(),
                "jiff".to_owned(),
                "loro".to_owned(),
                "regex".to_owned(),
                "reqwest".to_owned(),
                "clap".to_owned(),
                "nsh".to_owned(),
                "@vibevalley/i18n".to_owned(),
            ],
            order,
            levels,
            omit: Vec::new(),
            edge_kinds: BTreeMap::new(),
            proposals: Vec::new(),
        };
    }

    // Fallback for generic workspaces/fixtures without `crates/*`
    let mut fallback_sources = Vec::new();
    if root.join("src").is_dir() {
        fallback_sources.push(SourceSpec {
            lang: Lang::Rust,
            root: "src".to_owned(),
            prefix: Some("app".to_owned()),
        });
    } else {
        fallback_sources.push(SourceSpec {
            lang: Lang::Rust,
            root: ".".to_owned(),
            prefix: Some("app".to_owned()),
        });
    }
    Policy {
        title: "Project Architecture".to_owned(),
        prefix: "app".to_owned(),
        hierarchical: true,
        sources: fallback_sources,
        foreign: Vec::new(),
        order: Vec::new(),
        levels: Vec::new(),
        omit: Vec::new(),
        edge_kinds: BTreeMap::new(),
        proposals: Vec::new(),
    }
}

pub fn load_or_init_policy(root: &Path) -> Result<Policy, String> {
    let path = policy_path(root);
    if path.exists() {
        read_json(&path)
    } else {
        let policy = default_policy(root);
        write_json(&path, &policy)?;
        Ok(policy)
    }
}

pub fn split_ns_segments(ns: &str) -> Vec<&str> {
    ns.split('.').flat_map(|part| part.split("::")).filter(|s| !s.is_empty()).collect()
}

pub fn qualify_namespace(raw_ns: &str, source_prefix: Option<&str>, lang: Lang) -> String {
    let clean_raw = raw_ns.replace("::", ".");
    let Some(pref) = source_prefix.map(str::trim).filter(|s| !s.is_empty()) else {
        return clean_raw;
    };
    match lang {
        Lang::Rust => {
            if clean_raw == "crate" {
                pref.to_owned()
            } else if let Some(rest) = clean_raw.strip_prefix("crate.") {
                format!("{pref}.{rest}")
            } else {
                format!("{pref}.{clean_raw}")
            }
        }
        Lang::TypeScript => {
            if clean_raw == "index" || clean_raw.is_empty() {
                pref.to_owned()
            } else {
                format!("{pref}.{clean_raw}")
            }
        }
    }
}

pub fn rank_for_namespace(ns: &str, prefix: &str, levels: &[Vec<String>]) -> Option<usize> {
    let ns_segs = split_ns_segments(ns);
    let pref_segs = split_ns_segments(prefix);
    let target_seg = if pref_segs.is_empty() {
        ns_segs.first().copied()?
    } else if ns_segs.len() > pref_segs.len() && ns_segs[..pref_segs.len()] == pref_segs[..] {
        ns_segs[pref_segs.len()]
    } else {
        return None;
    };
    levels.iter().position(|group| group.iter().any(|entry| entry == target_seg))
}

pub fn is_omitted(ns: &str, omit: &[String]) -> bool {
    let ns_segs = split_ns_segments(ns);
    omit.iter().any(|pattern| {
        let pat_segs = split_ns_segments(pattern);
        !pat_segs.is_empty() && ns_segs.len() >= pat_segs.len() && ns_segs[..pat_segs.len()] == pat_segs[..]
    })
}

fn match_foreign<'a>(target: &str, foreign_list: &'a [String]) -> Option<&'a str> {
    foreign_list.iter().find_map(|f| {
        let f_trim = f.trim();
        if f_trim.is_empty() {
            return None;
        }
        if target == f_trim
            || target.starts_with(&format!("{f_trim}."))
            || target.starts_with(&format!("{f_trim}::"))
            || target.starts_with(&format!("{f_trim}/"))
        {
            Some(f_trim)
        } else {
            None
        }
    })
}

fn lookup_edge_kind_override(from: &str, to: &str, overrides: &BTreeMap<String, EdgeKind>) -> Option<EdgeKind> {
    let exact = format!("{from}->{to}");
    if let Some(kind) = overrides.get(&exact) {
        return Some(*kind);
    }
    let mut best: Option<(usize, EdgeKind)> = None;
    for (pattern, &kind) in overrides {
        let Some((pat_from, pat_to)) = pattern.split_once("->") else {
            continue;
        };
        let pf = pat_from.trim();
        let pt = pat_to.trim();
        let from_match = from == pf || from.starts_with(&format!("{pf}."));
        let to_match = to == pt || to.starts_with(&format!("{pt}."));
        if from_match && to_match {
            let specificity = pf.len() + pt.len();
            if best.is_none_or(|(best_len, _)| specificity > best_len) {
                best = Some((specificity, kind));
            }
        }
    }
    best.map(|(_, k)| k)
}

#[derive(Debug, Default)]
struct MetricsOverlayData {
    crap_by_ns_name: BTreeMap<(String, String), Vec<CrapEntry>>,
    mutate_by_ns_name: BTreeMap<(String, String), Vec<MutateForm>>,
}

fn load_metrics_overlay(root: &Path) -> MetricsOverlayData {
    let mut data = MetricsOverlayData::default();
    let crap_path = crap_snapshot_path(root);
    if crap_path.exists()
        && let Ok(snap) = read_json::<CrapSnapshot>(&crap_path)
    {
        for entry in snap.entries {
            data.crap_by_ns_name
                .entry((entry.namespace.clone(), entry.name.clone()))
                .or_default()
                .push(entry);
        }
    }

    let mutate_dir = mutate_snapshot_dir(root);
    if mutate_dir.is_dir()
        && let Ok(entries) = fs::read_dir(&mutate_dir)
    {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(snap) = read_json::<MutateSnapshot>(&path) {
                for form in snap.forms.into_values() {
                    data.mutate_by_ns_name
                        .entry((form.namespace.clone(), form.name.clone()))
                        .or_default()
                        .push(form);
                }
            }
        }
    }
    data
}

fn find_crap_entry<'a>(overlay: &'a MetricsOverlayData, qualified_ns: &str, raw_ns: &str, name: &str, file: &str) -> Option<&'a CrapEntry> {
    if let Some(entries) = overlay.crap_by_ns_name.get(&(qualified_ns.to_owned(), name.to_owned()))
        && let Some(found) = entries.iter().find(|e| e.file == file || e.file.is_empty()).or_else(|| entries.first())
    {
        return Some(found);
    }
    if let Some(entries) = overlay.crap_by_ns_name.get(&(raw_ns.to_owned(), name.to_owned())) {
        return entries.iter().find(|e| e.file == file || e.file.is_empty()).or_else(|| entries.first());
    }
    None
}

fn find_mutate_form<'a>(overlay: &'a MetricsOverlayData, qualified_ns: &str, raw_ns: &str, name: &str, file: &str) -> Option<&'a MutateForm> {
    if let Some(forms) = overlay.mutate_by_ns_name.get(&(qualified_ns.to_owned(), name.to_owned()))
        && let Some(found) = forms.iter().find(|f| f.file == file || f.file.is_empty()).or_else(|| forms.first())
    {
        return Some(found);
    }
    if let Some(forms) = overlay.mutate_by_ns_name.get(&(raw_ns.to_owned(), name.to_owned())) {
        return forms.iter().find(|f| f.file == file || f.file.is_empty()).or_else(|| forms.first());
    }
    None
}

/// Maps CRAP (`mu + sigma`) onto Bob's `1..=10` grade (10 = <=5, 1 = >=30 or missing).
pub fn crap_to_grade(mu: Option<f64>, sigma: Option<f64>) -> u8 {
    let (Some(m), Some(s)) = (mu, sigma) else {
        return 1;
    };
    let val = m + s;
    if val <= 5.0 {
        10
    } else if val >= 30.0 {
        1
    } else {
        let t = ((val - 5.0) / 25.0).clamp(0.0, 1.0);
        ((10.0 - 9.0 * t).round() as u8).clamp(1, 10)
    }
}

/// Maps mutation kill ratio (`0.0..=1.0`) onto `1..=10` grade (missing -> 1).
pub fn mutation_to_grade(has_mutation: bool, score_pct: Option<f64>, sites: usize) -> u8 {
    if !has_mutation {
        return 1;
    }
    if sites == 0 {
        return 10;
    }
    let Some(pct) = score_pct else {
        return 1;
    };
    let ratio = (pct / 100.0).clamp(0.0, 1.0);
    ((1.0 + 9.0 * ratio).round() as u8).clamp(1, 10)
}

fn lerp_u8(a: u8, b: u8, t: f64) -> u8 {
    let v = f64::from(a) + (f64::from(b) - f64::from(a)) * t.clamp(0.0, 1.0);
    v.round().clamp(0.0, 255.0) as u8
}

fn lerp_rgb(c1: (u8, u8, u8), c2: (u8, u8, u8), t: f64) -> String {
    let r = lerp_u8(c1.0, c2.0, t);
    let g = lerp_u8(c1.1, c2.1, t);
    let b = lerp_u8(c1.2, c2.2, t);
    format!("#{r:02x}{g:02x}{b:02x}")
}

/// Soft red-yellow-green fill color for a `0.0..=10.0` combined score.
pub fn grade_to_fill_hex(score: f64) -> String {
    let t = ((score - 1.0) / 9.0).clamp(0.0, 1.0);
    let red = (245, 183, 177); // #f5b7b1
    let yellow = (249, 231, 159); // #f9e79f
    let green = (171, 235, 198); // #abebc6
    if t < 0.5 {
        lerp_rgb(red, yellow, t * 2.0)
    } else {
        lerp_rgb(yellow, green, (t - 0.5) * 2.0)
    }
}

/// Vivid red-yellow-green indicator dot color for `1..=10` `C`/`M` dots.
pub fn grade_to_dot_hex(grade: u8) -> String {
    let t = (f64::from(grade.saturating_sub(1)) / 9.0).clamp(0.0, 1.0);
    let red = (220, 38, 38); // #dc2626
    let yellow = (234, 179, 8); // #eab308
    let green = (22, 163, 74); // #16a34a
    if t < 0.5 {
        lerp_rgb(red, yellow, t * 2.0)
    } else {
        lerp_rgb(yellow, green, (t - 0.5) * 2.0)
    }
}

fn compute_metrics_from_ops(ops: &[MemberOp]) -> NodeMetrics {
    let mut crap_vals = Vec::new();
    let mut has_mutation = false;
    let mut killed = 0usize;
    let mut survived = 0usize;
    let mut uncovered = 0usize;
    let mut sites = 0usize;
    let mut fallback_scores = Vec::new();

    for op in ops {
        if let Some(c) = op.crap {
            crap_vals.push(c);
        }
        if op.has_mutation {
            has_mutation = true;
            killed += op.killed;
            survived += op.survived;
            uncovered += op.uncovered;
            sites += op.sites;
            if let Some(s) = op.mutation_score {
                fallback_scores.push(s);
            }
        }
    }

    build_node_metrics(ops.len(), &crap_vals, has_mutation, killed, survived, uncovered, sites, &fallback_scores)
}

#[allow(clippy::too_many_arguments)]
fn build_node_metrics(
    form_count: usize,
    crap_vals: &[f64],
    has_mutation: bool,
    killed: usize,
    survived: usize,
    uncovered: usize,
    sites: usize,
    fallback_scores: &[f64],
) -> NodeMetrics {
    let crap_count = crap_vals.len();
    let (crap_mu, crap_max, crap_sigma) = if crap_count > 0 {
        let sum: f64 = crap_vals.iter().sum();
        let mu = sum / (crap_count as f64);
        let max = crap_vals.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let var: f64 = crap_vals.iter().map(|c| (c - mu) * (c - mu)).sum::<f64>() / (crap_count as f64);
        (Some(round2(mu)), Some(round2(max)), Some(round2(var.sqrt())))
    } else {
        (None, None, None)
    };

    let denom = killed + survived + uncovered;
    let mutation_score = if !has_mutation {
        None
    } else if denom > 0 {
        Some(round2((killed as f64) * 100.0 / (denom as f64)))
    } else if sites > 0 {
        Some(round2((killed as f64) * 100.0 / (sites as f64)))
    } else if !fallback_scores.is_empty() {
        let avg = fallback_scores.iter().sum::<f64>() / (fallback_scores.len() as f64);
        Some(round2(if avg <= 1.0 { avg * 100.0 } else { avg }))
    } else {
        None
    };

    let crap_grade = crap_to_grade(crap_mu, crap_sigma);
    let mutation_grade = mutation_to_grade(has_mutation, mutation_score, sites);
    let combined_grade = round2((f64::from(crap_grade) + f64::from(mutation_grade)) / 2.0);

    NodeMetrics {
        form_count,
        crap_count,
        crap_mu,
        crap_max,
        crap_sigma,
        crap_grade,
        crap_color: grade_to_dot_hex(crap_grade),
        has_mutation,
        killed,
        survived,
        uncovered,
        sites,
        mutation_score,
        mutation_grade,
        mutation_color: grade_to_dot_hex(mutation_grade),
        combined_grade,
        fill_color: grade_to_fill_hex(combined_grade),
    }
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

struct PendingLeaf {
    id: String,
    name: String,
    file: String,
    lang: Lang,
    line: usize,
    type_kind: String,
    raw_namespace: String,
    fields: Vec<MemberField>,
    ops: Vec<MemberOp>,
    bases: Vec<String>,
}

struct AnalyzedSourceFile {
    source_prefix: Option<String>,
    qualified_mod_ns: String,
    analysis: FileAnalysis,
}

fn workspace_crate_source_map(policy: &Policy) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for src in &policy.sources {
        let Some(pref) = src.prefix.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
            continue;
        };
        if src.lang == Lang::Rust {
            let dir_name = src.root.trim_end_matches('/').rsplit('/').next().unwrap_or(&src.root);
            let crate_ident = format!("vibevalley_{}", dir_name.replace('-', "_"));
            map.insert(crate_ident, pref.to_owned());
        } else if src.lang == Lang::TypeScript {
            if src.root.ends_with("apps/mac/ui") {
                map.insert("@vibevalley/mac-ui".to_owned(), pref.to_owned());
            } else if let Some(pkg) = src.root.strip_prefix("packages/").and_then(|s| s.split('/').next()) {
                map.insert(format!("@vibevalley/{pkg}"), pref.to_owned());
            }
        }
    }
    if let Some(proto_pref) = map.get("vibevalley_protocol").cloned() {
        map.entry("@vibevalley/protocol".to_owned()).or_insert(proto_pref);
    }
    map
}

fn resolve_rust_external_or_crate_target(raw_target: &str, crate_map: &BTreeMap<String, String>) -> Option<String> {
    let segs: Vec<&str> = raw_target.split("::").filter(|s| !s.is_empty()).collect();
    let first = *segs.first()?;
    let pref = crate_map.get(first)?;
    let mod_segs: Vec<&str> = segs
        .iter()
        .skip(1)
        .copied()
        .take_while(|s| *s != "*" && s.chars().next().is_some_and(|c| c.is_ascii_lowercase()))
        .collect();
    if mod_segs.is_empty() {
        Some(pref.clone())
    } else {
        Some(format!("{pref}.{}", mod_segs.join(".")))
    }
}

fn resolve_ts_package_target(raw_target: &str, crate_map: &BTreeMap<String, String>) -> Option<String> {
    for (pkg, pref) in crate_map {
        if !pkg.starts_with('@') {
            continue;
        }
        if raw_target == pkg {
            return Some(pref.clone());
        }
        if let Some(rest) = raw_target.strip_prefix(&format!("{pkg}/")) {
            let stem = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs"]
                .into_iter()
                .find_map(|ext| rest.strip_suffix(ext))
                .unwrap_or(rest);
            let mut parts: Vec<&str> = stem.split('/').filter(|s| !s.is_empty()).collect();
            if parts.len() > 1 && parts.last().is_some_and(|&p| p == "index") {
                parts.pop();
            }
            if parts.is_empty() {
                return Some(pref.clone());
            }
            return Some(format!("{pref}.{}", parts.join(".")));
        }
    }
    None
}

fn build_member_op(form: &FormInfo, overlay: &MetricsOverlayData, qualified_ns: &str) -> MemberOp {
    let crap_entry = find_crap_entry(overlay, qualified_ns, &form.namespace, &form.name, &form.file);
    let mutate_form = find_mutate_form(overlay, qualified_ns, &form.namespace, &form.name, &form.file);

    let (has_mutation, killed, survived, uncovered, sites, mutation_score) = if let Some(mf) = mutate_form {
        let denom = mf.killed + mf.survived + mf.uncovered;
        let score = if denom > 0 {
            Some(round2((mf.killed as f64) * 100.0 / (denom as f64)))
        } else if mf.total_sites > 0 {
            Some(round2((mf.killed as f64) * 100.0 / (mf.total_sites as f64)))
        } else {
            mf.score.map(|s| round2(if s <= 1.0 { s * 100.0 } else { s }))
        };
        (true, mf.killed, mf.survived, mf.uncovered, mf.total_sites, score)
    } else {
        (false, 0, 0, 0, 0, None)
    };

    MemberOp {
        name: form.name.clone(),
        visibility: form.visibility,
        kind: form.kind,
        line: form.start_line,
        end_line: form.end_line,
        file: form.file.clone(),
        raw_namespace: form.namespace.clone(),
        crap: crap_entry.and_then(|c| c.crap),
        cc: crap_entry.map(|c| c.cc),
        coverage: crap_entry.and_then(|c| c.coverage),
        has_mutation,
        killed,
        survived,
        uncovered,
        sites,
        mutation_score,
    }
}

fn collect_type_ops(decl: &TypeDecl, file_forms: &[&FormInfo], overlay: &MetricsOverlayData, qualified_type_ns: &str) -> Vec<MemberOp> {
    let mut ops = Vec::new();
    let mut seen_names = BTreeSet::new();

    for form in file_forms {
        if form.namespace == decl.namespace {
            seen_names.insert(form.name.clone());
            ops.push(build_member_op(form, overlay, qualified_type_ns));
        }
    }

    for op_name in &decl.ops {
        if seen_names.insert(op_name.clone()) {
            let synthetic = FormInfo {
                namespace: decl.namespace.clone(),
                name: op_name.clone(),
                kind: FormKind::Method,
                visibility: if op_name.starts_with('#') { Visibility::Private } else { Visibility::Public },
                lang: Lang::TypeScript,
                file: decl.file.clone(),
                start_line: decl.line,
                end_line: decl.line,
                start_byte: 0,
                end_byte: 0,
                body_hash: String::new(),
            };
            ops.push(build_member_op(&synthetic, overlay, qualified_type_ns));
        }
    }

    ops
}

fn insert_tree_path(root: &mut ComponentNode, id_prefix: &[String], segments: &[String], leaf_id: &str, node_kind: NodeKind) {
    if segments.is_empty() {
        return;
    }
    let mut current = root;
    let mut prefix_acc: Vec<String> = id_prefix.to_vec();
    for (idx, seg) in segments.iter().enumerate() {
        prefix_acc.push(seg.clone());
        let is_last = idx + 1 == segments.len();
        let node_id = if is_last { leaf_id.to_owned() } else { prefix_acc.join(".") };

        if let Some(pos) = current.children.iter().position(|c| c.id == node_id) {
            current = &mut current.children[pos];
        } else {
            current.children.push(ComponentNode {
                id: node_id,
                name: seg.clone(),
                node_kind: if is_last { node_kind } else { NodeKind::Component },
                children: Vec::new(),
            });
            let last_idx = current.children.len() - 1;
            current = &mut current.children[last_idx];
        }
    }
}

fn sort_component_tree(node: &mut ComponentNode, order: &[String]) {
    for child in &mut node.children {
        sort_component_tree(child, order);
    }
    node.children.sort_by(|a, b| {
        let a_foreign = a.node_kind == NodeKind::Foreign;
        let b_foreign = b.node_kind == NodeKind::Foreign;
        if a_foreign != b_foreign {
            return a_foreign.cmp(&b_foreign);
        }
        let a_ord = order.iter().position(|o| o == &a.name);
        let b_ord = order.iter().position(|o| o == &b.name);
        match (a_ord, b_ord) {
            (Some(ia), Some(ib)) => ia.cmp(&ib),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.name.cmp(&b.name),
        }
    });
}

#[derive(Default)]
struct SubtreePool {
    crap_vals: Vec<f64>,
    form_count: usize,
    has_mutation: bool,
    killed: usize,
    survived: usize,
    uncovered: usize,
    sites: usize,
    fallback_scores: Vec<f64>,
}

fn compute_tree_metadata(
    node: &ComponentNode,
    parent: Option<&str>,
    leaf_map: &BTreeMap<String, PendingLeaf>,
    foreign_ids: &BTreeSet<String>,
    nodes_out: &mut BTreeMap<String, IrNodeMeta>,
) -> SubtreePool {
    if node.children.is_empty() {
        if foreign_ids.contains(&node.id) && !leaf_map.contains_key(&node.id) {
            let metrics = build_node_metrics(0, &[], true, 0, 0, 0, 0, &[]);
            nodes_out.insert(
                node.id.clone(),
                IrNodeMeta {
                    id: node.id.clone(),
                    name: node.name.clone(),
                    node_kind: NodeKind::Foreign,
                    parent: parent.map(str::to_owned),
                    children: Vec::new(),
                    file: None,
                    lang: None,
                    line: None,
                    type_kind: Some("foreign".to_owned()),
                    raw_namespace: None,
                    fields: Vec::new(),
                    ops: Vec::new(),
                    bases: Vec::new(),
                    metrics: NodeMetrics {
                        fill_color: "#e2e8f0".to_owned(),
                        crap_color: "#94a3b8".to_owned(),
                        mutation_color: "#94a3b8".to_owned(),
                        crap_grade: 10,
                        mutation_grade: 10,
                        combined_grade: 10.0,
                        ..metrics
                    },
                },
            );
            return SubtreePool::default();
        }

        if let Some(leaf) = leaf_map.get(&node.id) {
            let metrics = compute_metrics_from_ops(&leaf.ops);
            let mut pool = SubtreePool {
                form_count: leaf.ops.len(),
                ..SubtreePool::default()
            };
            for op in &leaf.ops {
                if let Some(c) = op.crap {
                    pool.crap_vals.push(c);
                }
                if op.has_mutation {
                    pool.has_mutation = true;
                    pool.killed += op.killed;
                    pool.survived += op.survived;
                    pool.uncovered += op.uncovered;
                    pool.sites += op.sites;
                    if let Some(s) = op.mutation_score {
                        pool.fallback_scores.push(s);
                    }
                }
            }
            nodes_out.insert(
                node.id.clone(),
                IrNodeMeta {
                    id: node.id.clone(),
                    name: node.name.clone(),
                    node_kind: NodeKind::Class,
                    parent: parent.map(str::to_owned),
                    children: Vec::new(),
                    file: Some(leaf.file.clone()),
                    lang: Some(leaf.lang),
                    line: Some(leaf.line),
                    type_kind: Some(leaf.type_kind.clone()),
                    raw_namespace: Some(leaf.raw_namespace.clone()),
                    fields: leaf.fields.clone(),
                    ops: leaf.ops.clone(),
                    bases: leaf.bases.clone(),
                    metrics,
                },
            );
            return pool;
        }
    }

    let mut agg = SubtreePool::default();
    let child_ids: Vec<String> = node.children.iter().map(|c| c.id.clone()).collect();
    for child in &node.children {
        let child_pool = compute_tree_metadata(child, Some(&node.id), leaf_map, foreign_ids, nodes_out);
        agg.form_count += child_pool.form_count;
        agg.crap_vals.extend(child_pool.crap_vals);
        if child_pool.has_mutation {
            agg.has_mutation = true;
            agg.killed += child_pool.killed;
            agg.survived += child_pool.survived;
            agg.uncovered += child_pool.uncovered;
            agg.sites += child_pool.sites;
            agg.fallback_scores.extend(child_pool.fallback_scores);
        }
    }

    let metrics = build_node_metrics(
        agg.form_count,
        &agg.crap_vals,
        agg.has_mutation,
        agg.killed,
        agg.survived,
        agg.uncovered,
        agg.sites,
        &agg.fallback_scores,
    );
    let kind = if node.children.is_empty() { NodeKind::Class } else { NodeKind::Component };
    nodes_out.insert(
        node.id.clone(),
        IrNodeMeta {
            id: node.id.clone(),
            name: node.name.clone(),
            node_kind: kind,
            parent: parent.map(str::to_owned),
            children: child_ids,
            file: None,
            lang: None,
            line: None,
            type_kind: Some("component".to_owned()),
            raw_namespace: None,
            fields: Vec::new(),
            ops: Vec::new(),
            bases: Vec::new(),
            metrics,
        },
    );
    agg
}

pub fn build_topology(root: &Path, policy: &Policy, path_filters: &[String]) -> Result<TopologyIr, String> {
    let overlay = load_metrics_overlay(root);
    let mut analyzed_files: Vec<AnalyzedSourceFile> = Vec::new();
    let mut seen_rel_files = BTreeSet::new();

    let sources_to_scan: Vec<SourceSpec> = if policy.sources.is_empty() {
        vec![SourceSpec {
            lang: Lang::Rust,
            root: ".".to_owned(),
            prefix: (!policy.prefix.is_empty()).then(|| policy.prefix.clone()),
        }]
    } else {
        policy.sources.clone()
    };

    for src in &sources_to_scan {
        let mut src_filters = Vec::new();
        if src.root != "." {
            src_filters.push(src.root.clone());
        }
        let files = collect_project_files(root, &src_filters, Some(&[src.lang]))?;
        for file in files {
            if !path_filters.is_empty()
                && !path_filters
                    .iter()
                    .any(|f| file.rel_path == *f || file.rel_path.starts_with(f) || file.rel_path.contains(f))
            {
                continue;
            }
            if !seen_rel_files.insert(file.rel_path.clone()) {
                continue;
            }
            let content = fs::read_to_string(&file.path).map_err(|err| format!("failed to read {}: {err}", file.path.display()))?;
            let analysis = analyze_file(root, &file.path, &content, file.lang);
            let qualified_mod_ns = qualify_namespace(&analysis.module_namespace, src.prefix.as_deref(), file.lang);
            if is_omitted(&qualified_mod_ns, &policy.omit) {
                continue;
            }
            analyzed_files.push(AnalyzedSourceFile {
                source_prefix: src.prefix.clone(),
                qualified_mod_ns,
                analysis,
            });
        }
    }

    let mut leaf_map: BTreeMap<String, PendingLeaf> = BTreeMap::new();
    let mut short_type_targets: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut known_internal_prefixes = BTreeSet::new();

    for af in &analyzed_files {
        known_internal_prefixes.insert(af.qualified_mod_ns.clone());
        let free_forms: Vec<&FormInfo> = af.analysis.forms.iter().filter(|f| f.namespace == af.analysis.module_namespace).collect();
        let has_types = !af.analysis.types.is_empty();

        for decl in &af.analysis.types {
            let qualified_type_ns = qualify_namespace(&decl.namespace, af.source_prefix.as_deref(), af.analysis.lang);
            if is_omitted(&qualified_type_ns, &policy.omit) {
                continue;
            }
            known_internal_prefixes.insert(qualified_type_ns.clone());
            short_type_targets.entry(decl.name.clone()).or_default().push(qualified_type_ns.clone());

            let all_forms: Vec<&FormInfo> = af.analysis.forms.iter().collect();
            let ops = collect_type_ops(decl, &all_forms, &overlay, &qualified_type_ns);
            let fields = decl
                .fields
                .iter()
                .map(|f| MemberField {
                    name: f.clone(),
                    visibility: if f.starts_with('#') { Visibility::Private } else { Visibility::Public },
                    line: decl.line,
                })
                .collect();

            leaf_map.insert(
                qualified_type_ns.clone(),
                PendingLeaf {
                    id: qualified_type_ns,
                    name: decl.name.clone(),
                    file: decl.file.clone(),
                    lang: af.analysis.lang,
                    line: decl.line,
                    type_kind: decl.kind.clone(),
                    raw_namespace: decl.namespace.clone(),
                    fields,
                    ops,
                    bases: decl.bases.clone(),
                },
            );
        }

        if !has_types || !free_forms.is_empty() {
            let leaf_id = if has_types {
                format!("{}._module", af.qualified_mod_ns)
            } else {
                af.qualified_mod_ns.clone()
            };
            let short_name = af.qualified_mod_ns.rsplit('.').next().unwrap_or(&af.qualified_mod_ns).to_owned();
            let display_name = if has_types { format!("{short_name} (module)") } else { short_name };
            let ops: Vec<MemberOp> = free_forms.iter().map(|f| build_member_op(f, &overlay, &af.qualified_mod_ns)).collect();
            let line = free_forms.first().map_or(1, |f| f.start_line);

            leaf_map.insert(
                leaf_id.clone(),
                PendingLeaf {
                    id: leaf_id,
                    name: display_name,
                    file: af.analysis.file.clone(),
                    lang: af.analysis.lang,
                    line,
                    type_kind: "module".to_owned(),
                    raw_namespace: af.analysis.module_namespace.clone(),
                    fields: Vec::new(),
                    ops,
                    bases: Vec::new(),
                },
            );
        }
    }

    let crate_map = workspace_crate_source_map(policy);
    let mut foreign_ids = BTreeSet::new();
    let mut dedup_edges: BTreeMap<(String, String, EdgeKind), IrEdge> = BTreeMap::new();

    for af in &analyzed_files {
        for rel in &af.analysis.relations {
            let from_ns = qualify_namespace(&rel.from_namespace, af.source_prefix.as_deref(), af.analysis.lang);
            if is_omitted(&from_ns, &policy.omit) {
                continue;
            }

            let mut target_foreign = false;
            let to_ns_opt: Option<String> = match af.analysis.lang {
                Lang::Rust => {
                    if rel.to_namespace == "crate" || rel.to_namespace.starts_with("crate::") {
                        Some(qualify_namespace(&rel.to_namespace, af.source_prefix.as_deref(), Lang::Rust))
                    } else if let Some(internal) = resolve_rust_external_or_crate_target(&rel.raw_target, &crate_map) {
                        Some(internal)
                    } else if rel.kind != RelationKind::Dependency {
                        let same_file = af
                            .analysis
                            .types
                            .iter()
                            .find(|t| t.name == rel.to_namespace)
                            .map(|t| qualify_namespace(&t.namespace, af.source_prefix.as_deref(), Lang::Rust));
                        if let Some(local) = same_file {
                            Some(local)
                        } else if let Some(cands) = short_type_targets.get(&rel.to_namespace)
                            && cands.len() == 1
                        {
                            Some(cands[0].clone())
                        } else if let Some(f) = match_foreign(&rel.to_namespace, &policy.foreign) {
                            target_foreign = true;
                            Some(format!("foreign.{f}"))
                        } else {
                            None
                        }
                    } else if let Some(f) = match_foreign(&rel.to_namespace, &policy.foreign) {
                        target_foreign = true;
                        Some(format!("foreign.{f}"))
                    } else {
                        None
                    }
                }
                Lang::TypeScript => {
                    if rel.raw_target.starts_with("./") || rel.raw_target.starts_with("../") {
                        Some(qualify_namespace(&rel.to_namespace, af.source_prefix.as_deref(), Lang::TypeScript))
                    } else if let Some(internal) = resolve_ts_package_target(&rel.raw_target, &crate_map) {
                        Some(internal)
                    } else if rel.kind != RelationKind::Dependency {
                        let same_file = af
                            .analysis
                            .types
                            .iter()
                            .find(|t| t.name == rel.to_namespace)
                            .map(|t| qualify_namespace(&t.namespace, af.source_prefix.as_deref(), Lang::TypeScript));
                        if let Some(local) = same_file {
                            Some(local)
                        } else if let Some(cands) = short_type_targets.get(&rel.to_namespace)
                            && cands.len() == 1
                        {
                            Some(cands[0].clone())
                        } else if let Some(f) = match_foreign(&rel.to_namespace, &policy.foreign) {
                            target_foreign = true;
                            Some(format!("foreign.{f}"))
                        } else {
                            None
                        }
                    } else if let Some(f) = match_foreign(&rel.raw_target, &policy.foreign) {
                        target_foreign = true;
                        Some(format!("foreign.{f}"))
                    } else {
                        None
                    }
                }
            };

            let Some(to_ns) = to_ns_opt else {
                continue;
            };
            if to_ns == from_ns || is_omitted(&to_ns, &policy.omit) {
                continue;
            }

            if target_foreign {
                foreign_ids.insert(to_ns.clone());
            }

            let base_kind = EdgeKind::from(rel.kind);
            let kind = lookup_edge_kind_override(&from_ns, &to_ns, &policy.edge_kinds).unwrap_or(base_kind);
            let from_rank = rank_for_namespace(&from_ns, &policy.prefix, &policy.levels);
            let to_rank = rank_for_namespace(&to_ns, &policy.prefix, &policy.levels);
            let violating = kind == EdgeKind::Dependency && matches!((from_rank, to_rank), (Some(f), Some(t)) if f < t);

            dedup_edges.entry((from_ns.clone(), to_ns.clone(), kind)).or_insert_with(|| IrEdge {
                from: from_ns,
                to: to_ns,
                kind,
                violating,
                from_rank,
                to_rank,
                file: rel.file.clone(),
                line: rel.line,
                raw_target: rel.raw_target.clone(),
            });
        }
    }

    let root_name = if policy.prefix.is_empty() { "root".to_owned() } else { policy.prefix.clone() };
    let mut tree_root = ComponentNode {
        id: "root".to_owned(),
        name: root_name,
        node_kind: NodeKind::Component,
        children: Vec::new(),
    };

    let pref_segs: Vec<String> = split_ns_segments(&policy.prefix).into_iter().map(str::to_owned).collect();

    for leaf in leaf_map.values() {
        let mut segs: Vec<String> = split_ns_segments(&leaf.id).into_iter().map(str::to_owned).collect();
        let id_prefix: &[String] = if !pref_segs.is_empty() && segs.len() > pref_segs.len() && segs[..pref_segs.len()] == pref_segs[..] {
            segs = segs[pref_segs.len()..].to_vec();
            &pref_segs
        } else {
            &[]
        };
        if segs.is_empty() {
            segs.push(leaf.name.clone());
        }
        insert_tree_path(&mut tree_root, id_prefix, &segs, &leaf.id, NodeKind::Class);
    }

    for fid in &foreign_ids {
        let display = fid.strip_prefix("foreign.").unwrap_or(fid).to_owned();
        insert_tree_path(&mut tree_root, &[], &[display], fid, NodeKind::Foreign);
    }

    // If hierarchical=false, flatten all classes directly under root
    if !policy.hierarchical {
        let mut flat_children = Vec::new();
        for leaf in leaf_map.values() {
            flat_children.push(ComponentNode {
                id: leaf.id.clone(),
                name: leaf.id.clone(),
                node_kind: NodeKind::Class,
                children: Vec::new(),
            });
        }
        for fid in &foreign_ids {
            flat_children.push(ComponentNode {
                id: fid.clone(),
                name: fid.strip_prefix("foreign.").unwrap_or(fid).to_owned(),
                node_kind: NodeKind::Foreign,
                children: Vec::new(),
            });
        }
        tree_root.children = flat_children;
    }

    sort_component_tree(&mut tree_root, &policy.order);

    let mut nodes = BTreeMap::new();
    compute_tree_metadata(&tree_root, None, &leaf_map, &foreign_ids, &mut nodes);

    let edges: Vec<IrEdge> = dedup_edges.into_values().collect();
    let violations: Vec<DependencyViolation> = edges
        .iter()
        .filter(|e| e.violating)
        .filter_map(|e| {
            Some(DependencyViolation {
                from: e.from.clone(),
                to: e.to.clone(),
                from_rank: e.from_rank?,
                to_rank: e.to_rank?,
                kind: e.kind,
                file: e.file.clone(),
                line: e.line,
                raw_target: e.raw_target.clone(),
            })
        })
        .collect();

    let total_components = nodes.values().filter(|n| n.node_kind == NodeKind::Component && n.id != "root").count();
    let total_classes = nodes.values().filter(|n| n.node_kind == NodeKind::Class).count();
    let total_foreign = nodes.values().filter(|n| n.node_kind == NodeKind::Foreign).count();
    let total_forms: usize = leaf_map.values().map(|l| l.ops.len()).sum();
    let crap_covered_forms: usize = leaf_map.values().flat_map(|l| &l.ops).filter(|op| op.crap.is_some()).count();
    let mutation_covered_forms: usize = leaf_map.values().flat_map(|l| &l.ops).filter(|op| op.has_mutation).count();

    Ok(TopologyIr {
        version: 1,
        title: policy.title.clone(),
        prefix: policy.prefix.clone(),
        hierarchical: policy.hierarchical,
        root: tree_root,
        nodes,
        stats: TopologyStats {
            total_components,
            total_classes,
            total_foreign,
            total_forms,
            total_edges: edges.len(),
            violating_edges: violations.len(),
            crap_covered_forms,
            mutation_covered_forms,
        },
        edges,
        violations,
    })
}

pub fn generate_ir(root: &Path, policy: &Policy, path_filters: &[String]) -> Result<TopologyIr, String> {
    let ir = build_topology(root, policy, path_filters)?;
    write_json(&topology_path(root), &ir)?;
    Ok(ir)
}

fn find_component<'a>(node: &'a ComponentNode, target_id: &str) -> Option<&'a ComponentNode> {
    if node.id == target_id {
        return Some(node);
    }
    for child in &node.children {
        if let Some(found) = find_component(child, target_id) {
            return Some(found);
        }
    }
    None
}

fn is_descendant_or_self(candidate: &str, ancestor: &str, nodes: &BTreeMap<String, IrNodeMeta>) -> bool {
    if candidate == ancestor {
        return true;
    }
    let mut cur = nodes.get(candidate).and_then(|n| n.parent.as_deref());
    while let Some(p) = cur {
        if p == ancestor {
            return true;
        }
        cur = nodes.get(p).and_then(|n| n.parent.as_deref());
    }
    false
}

fn map_to_direct_child<'a>(endpoint: &str, scope: &'a ComponentNode, nodes: &BTreeMap<String, IrNodeMeta>) -> Option<&'a str> {
    for child in &scope.children {
        if is_descendant_or_self(endpoint, &child.id, nodes) {
            return Some(child.id.as_str());
        }
    }
    None
}

/// Rolls up leaf edges onto visible direct children of `scope_id`, inheriting `violating: true`
/// when any bundled leaf edge violates the Dependency Rule.
pub fn roll_up_edges(ir: &TopologyIr, scope_id: &str, omit: &[String], levels: &[Vec<String>]) -> Vec<RolledEdge> {
    let Some(scope) = find_component(&ir.root, scope_id) else {
        return Vec::new();
    };
    let mut grouped: BTreeMap<(String, String, EdgeKind), Vec<RolledEdgePair>> = BTreeMap::new();

    for edge in &ir.edges {
        if is_omitted(&edge.from, omit) || is_omitted(&edge.to, omit) {
            continue;
        }
        let Some(from_child) = map_to_direct_child(&edge.from, scope, &ir.nodes) else {
            continue;
        };
        let to_child_opt = map_to_direct_child(&edge.to, scope, &ir.nodes);
        let to_child = match to_child_opt {
            Some(c) => c.to_owned(),
            None if ir.nodes.get(&edge.to).is_some_and(|n| n.node_kind == NodeKind::Foreign) => edge.to.clone(),
            None => continue,
        };
        if from_child == to_child {
            continue;
        }
        let from_rank = rank_for_namespace(&edge.from, &ir.prefix, levels);
        let to_rank = rank_for_namespace(&edge.to, &ir.prefix, levels);
        let violating = edge.kind == EdgeKind::Dependency && matches!((from_rank, to_rank), (Some(f), Some(t)) if f < t);

        grouped.entry((from_child.to_owned(), to_child, edge.kind)).or_default().push(RolledEdgePair {
            from: edge.from.clone(),
            to: edge.to.clone(),
            kind: edge.kind,
            violating,
            file: edge.file.clone(),
            line: edge.line,
        });
    }

    grouped
        .into_iter()
        .map(|((from, to, kind), pairs)| {
            let violating = pairs.iter().any(|p| p.violating);
            RolledEdge {
                from,
                to,
                kind,
                violating,
                pairs,
            }
        })
        .collect()
}

pub fn evaluate_proposals(ir: &TopologyIr, proposals: &[Proposal]) -> Vec<ProposalEval> {
    proposals
        .iter()
        .map(|prop| {
            let mut violations = Vec::new();
            let mut edge_violations = Vec::with_capacity(ir.edges.len());
            for edge in &ir.edges {
                if is_omitted(&edge.from, &prop.omit) || is_omitted(&edge.to, &prop.omit) {
                    edge_violations.push(false);
                    continue;
                }
                let from_rank = rank_for_namespace(&edge.from, &ir.prefix, &prop.layers);
                let to_rank = rank_for_namespace(&edge.to, &ir.prefix, &prop.layers);
                let violating = edge.kind == EdgeKind::Dependency && matches!((from_rank, to_rank), (Some(f), Some(t)) if f < t);
                edge_violations.push(violating);
                if violating && let (Some(fr), Some(tr)) = (from_rank, to_rank) {
                    violations.push(DependencyViolation {
                        from: edge.from.clone(),
                        to: edge.to.clone(),
                        from_rank: fr,
                        to_rank: tr,
                        kind: edge.kind,
                        file: edge.file.clone(),
                        line: edge.line,
                        raw_target: edge.raw_target.clone(),
                    });
                }
            }
            ProposalEval {
                id: prop.id.clone(),
                name: prop.name.clone(),
                violating_count: violations.len(),
                violations,
                edge_violations,
            }
        })
        .collect()
}

pub fn compute_metrics_mtime_stamp(root: &Path) -> String {
    let mut max_nanos: u128 = 0;
    let mut count: usize = 0;

    let mut check_path = |p: &Path| {
        if let Ok(meta) = fs::metadata(p)
            && let Ok(mtime) = meta.modified()
            && let Ok(dur) = mtime.duration_since(UNIX_EPOCH)
        {
            count += 1;
            max_nanos = max_nanos.max(dur.as_nanos());
        }
    };

    check_path(&crap_snapshot_path(root));
    check_path(&policy_path(root));
    check_path(&topology_path(root));

    let mutate_dir = mutate_snapshot_dir(root);
    if mutate_dir.is_dir()
        && let Ok(entries) = fs::read_dir(&mutate_dir)
    {
        for entry in entries.flatten() {
            check_path(&entry.path());
        }
    }

    format!("{count}:{max_nanos}")
}

fn sanitize_mermaid_id(id: &str) -> String {
    let mut out = String::with_capacity(id.len());
    for ch in id.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() || out.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        format!("n_{out}")
    } else {
        out
    }
}

pub fn render_mermaid(ir: &TopologyIr, policy: &Policy) -> String {
    let mut out = String::from("flowchart TD\n");
    for g in 1u8..=10 {
        let fill = grade_to_fill_hex(f64::from(g));
        out.push_str(&format!("  classDef grade{g} fill:{fill},stroke:#334155,stroke-width:1.5px,color:#0f172a;\n"));
    }
    out.push_str("  classDef foreign fill:#e2e8f0,stroke:#64748b,stroke-dasharray: 4 3,color:#334155;\n");

    let rolled = roll_up_edges(ir, "root", &policy.omit, &policy.levels);
    let mut visible_ids: Vec<String> = ir.root.children.iter().map(|c| c.id.clone()).collect();
    for edge in &rolled {
        if !visible_ids.contains(&edge.from) {
            visible_ids.push(edge.from.clone());
        }
        if !visible_ids.contains(&edge.to) {
            visible_ids.push(edge.to.clone());
        }
    }

    for id in &visible_ids {
        let mid = sanitize_mermaid_id(id);
        if let Some(meta) = ir.nodes.get(id) {
            if meta.node_kind == NodeKind::Foreign {
                out.push_str(&format!("  {mid}([\"{}\"])\n", meta.name));
                out.push_str(&format!("  class {mid} foreign;\n"));
            } else {
                let g = (meta.metrics.combined_grade.round() as u8).clamp(1, 10);
                out.push_str(&format!(
                    "  {mid}[\"{} (C{} M{})\"]\n",
                    meta.name, meta.metrics.crap_grade, meta.metrics.mutation_grade
                ));
                out.push_str(&format!("  class {mid} grade{g};\n"));
            }
        }
    }

    for (idx, edge) in rolled.iter().enumerate() {
        let from_id = sanitize_mermaid_id(&edge.from);
        let to_id = sanitize_mermaid_id(&edge.to);
        let arrow = match edge.kind {
            EdgeKind::Dependency => "-->",
            EdgeKind::Implements | EdgeKind::Inheritance => "-.->",
            EdgeKind::Association => "--o",
        };
        out.push_str(&format!("  {from_id} {arrow} {to_id}\n"));
        if edge.violating {
            out.push_str(&format!("  linkStyle {idx} stroke:#dc2626,stroke-width:3px;\n"));
        }
    }

    out
}

fn escape_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

#[derive(Clone)]
struct SvgBox {
    id: String,
    label: String,
    is_foreign: bool,
    fill: String,
    crap_color: String,
    mutation_color: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// Renders a clean, self-contained pure-Rust SVG layered diagram for `ir` at `scope_id`.
pub fn render_svg(ir: &TopologyIr, policy: &Policy, scope_id: &str) -> String {
    let scope = find_component(&ir.root, scope_id).unwrap_or(&ir.root);
    let rolled = roll_up_edges(ir, &scope.id, &policy.omit, &policy.levels);

    let mut visible_ids: Vec<String> = scope.children.iter().map(|c| c.id.clone()).collect();
    for edge in &rolled {
        if !visible_ids.contains(&edge.from) {
            visible_ids.push(edge.from.clone());
        }
        if !visible_ids.contains(&edge.to) {
            visible_ids.push(edge.to.clone());
        }
    }

    // Group visible nodes by Clean Architecture rank (rank 0 at bottom or top; use top-to-bottom layers: outer layers on top, rank 0 at bottom so arrows point down!)
    let mut layers: BTreeMap<usize, Vec<String>> = BTreeMap::new();
    let max_rank = policy.levels.len();
    for id in &visible_ids {
        let is_foreign = ir.nodes.get(id).is_some_and(|n| n.node_kind == NodeKind::Foreign);
        let layer_idx = if is_foreign {
            max_rank + 1
        } else if let Some(rank) = rank_for_namespace(id, &policy.prefix, &policy.levels) {
            max_rank.saturating_sub(rank)
        } else {
            max_rank
        };
        layers.entry(layer_idx).or_default().push(id.clone());
    }

    let box_w = 186.0f64;
    let box_h = 64.0f64;
    let h_gap = 36.0f64;
    let v_gap = 72.0f64;
    let margin_x = 40.0f64;
    let header_h = 54.0f64;

    let max_cols = layers.values().map(Vec::len).max().unwrap_or(1).max(1);
    let canvas_w = (max_cols as f64) * box_w + ((max_cols.saturating_sub(1)) as f64) * h_gap + margin_x * 2.0;
    let num_layers = layers.len().max(1);
    let canvas_h = header_h + (num_layers as f64) * box_h + ((num_layers.saturating_sub(1)) as f64) * v_gap + 48.0;

    let mut boxes = Vec::new();
    let mut box_map: BTreeMap<String, SvgBox> = BTreeMap::new();

    for (row_idx, (_, ids)) in layers.into_iter().enumerate() {
        let row_w = (ids.len() as f64) * box_w + ((ids.len().saturating_sub(1)) as f64) * h_gap;
        let start_x = (canvas_w - row_w) / 2.0;
        let y = header_h + (row_idx as f64) * (box_h + v_gap);
        for (col_idx, id) in ids.into_iter().enumerate() {
            let x = start_x + (col_idx as f64) * (box_w + h_gap);
            let meta = ir.nodes.get(&id);
            let is_foreign = meta.is_some_and(|m| m.node_kind == NodeKind::Foreign);
            let label = meta.map_or_else(|| id.clone(), |m| m.name.clone());
            let fill = meta.map_or_else(|| "#e2e8f0".to_owned(), |m| m.metrics.fill_color.clone());
            let crap_color = meta.map_or_else(|| "#dc2626".to_owned(), |m| m.metrics.crap_color.clone());
            let mutation_color = meta.map_or_else(|| "#dc2626".to_owned(), |m| m.metrics.mutation_color.clone());

            let b = SvgBox {
                id: id.clone(),
                label,
                is_foreign,
                fill,
                crap_color,
                mutation_color,
                x,
                y,
                w: box_w,
                h: box_h,
            };
            box_map.insert(id, b.clone());
            boxes.push(b);
        }
    }

    let mut out = String::new();
    out.push_str(&format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{canvas_w:.0}\" height=\"{canvas_h:.0}\" viewBox=\"0 0 {canvas_w:.0} {canvas_h:.0}\">\n"
    ));
    out.push_str(
        "  <defs>\n\
           <marker id=\"arrow-normal\" viewBox=\"0 0 10 10\" refX=\"9\" refY=\"5\" markerWidth=\"7\" markerHeight=\"7\" orient=\"auto-start-reverse\">\n\
             <path d=\"M 0 1 L 10 5 L 0 9 z\" fill=\"#64748b\"/>\n\
           </marker>\n\
           <marker id=\"arrow-violating\" viewBox=\"0 0 10 10\" refX=\"9\" refY=\"5\" markerWidth=\"8\" markerHeight=\"8\" orient=\"auto-start-reverse\">\n\
             <path d=\"M 0 1 L 10 5 L 0 9 z\" fill=\"#dc2626\"/>\n\
           </marker>\n\
         </defs>\n",
    );
    out.push_str("  <rect width=\"100%\" height=\"100%\" fill=\"#f8fafc\"/>\n");
    out.push_str(&format!(
        "  <text x=\"{margin_x:.0}\" y=\"32\" font-family=\"-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif\" font-size=\"18\" font-weight=\"700\" fill=\"#0f172a\">{} — {}</text>\n",
        escape_xml(&ir.title),
        escape_xml(&scope.name)
    ));

    // Layer 1: box shapes
    for b in &boxes {
        if b.is_foreign {
            let cx = b.x + b.w / 2.0;
            let cy = b.y + b.h / 2.0;
            let rx = b.w / 2.0;
            let ry = b.h / 2.0;
            out.push_str(&format!(
                "  <ellipse cx=\"{cx:.1}\" cy=\"{cy:.1}\" rx=\"{rx:.1}\" ry=\"{ry:.1}\" fill=\"{}\" stroke=\"#64748b\" stroke-width=\"1.5\" stroke-dasharray=\"5 3\"/>\n",
                b.fill
            ));
        } else {
            out.push_str(&format!(
                "  <rect x=\"{:.1}\" y=\"{:.1}\" width=\"{:.1}\" height=\"{:.1}\" rx=\"8\" fill=\"{}\" stroke=\"#334155\" stroke-width=\"1.5\"/>\n",
                b.x, b.y, b.w, b.h, b.fill
            ));
            let c_x = b.x + b.w - 28.0;
            let m_x = b.x + b.w - 13.0;
            let dot_y = b.y + 13.0;
            out.push_str(&format!(
                "  <circle cx=\"{c_x:.1}\" cy=\"{dot_y:.1}\" r=\"5.5\" fill=\"{}\" stroke=\"#0f172a\" stroke-width=\"0.8\"/>\n",
                b.crap_color
            ));
            out.push_str(&format!(
                "  <circle cx=\"{m_x:.1}\" cy=\"{dot_y:.1}\" r=\"5.5\" fill=\"{}\" stroke=\"#0f172a\" stroke-width=\"0.8\"/>\n",
                b.mutation_color
            ));
        }
    }

    // Layer 2: arrows (drawn below titles)
    for edge in &rolled {
        let (Some(from_b), Some(to_b)) = (box_map.get(&edge.from), box_map.get(&edge.to)) else {
            continue;
        };
        let x1 = from_b.x + from_b.w / 2.0;
        let y1 = if from_b.y <= to_b.y { from_b.y + from_b.h } else { from_b.y };
        let x2 = to_b.x + to_b.w / 2.0;
        let y2 = if from_b.y <= to_b.y { to_b.y } else { to_b.y + to_b.h };
        let mid_y = (y1 + y2) / 2.0;
        let (stroke, width, marker) = if edge.violating {
            ("#dc2626", "3", "url(#arrow-violating)")
        } else {
            ("#64748b", "1.6", "url(#arrow-normal)")
        };
        let dash = match edge.kind {
            EdgeKind::Implements | EdgeKind::Inheritance => " stroke-dasharray=\"6 4\"",
            EdgeKind::Dependency | EdgeKind::Association => "",
        };
        out.push_str(&format!(
            "  <path d=\"M {x1:.1} {y1:.1} C {x1:.1} {mid_y:.1}, {x2:.1} {mid_y:.1}, {x2:.1} {y2:.1}\" fill=\"none\" stroke=\"{stroke}\" stroke-width=\"{width}\"{dash} marker-end=\"{marker}\"/>\n"
        ));
    }

    // Layer 3: component titles painted above arrows
    for b in &boxes {
        let tx = b.x + b.w / 2.0;
        let ty = b.y + b.h / 2.0 + 5.0;
        out.push_str(&format!(
            "  <text x=\"{tx:.1}\" y=\"{ty:.1}\" text-anchor=\"middle\" font-family=\"-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif\" font-size=\"13\" font-weight=\"600\" fill=\"#0f172a\">{}</text>\n",
            escape_xml(&b.label)
        ));
    }

    out.push_str("</svg>\n");
    out
}

fn print_usage() {
    println!(
        "\
Usage: cargo xtask uml <subcommand> [options] [<path>...]

Subcommands:
  init-policy [--force] [--json]            Create default .uml/policy.json
  ir [<path>...] [--json] [--edn]           Build .uml/topology.json with .metrics/ overlay
  check [<path>...] [--json]                Check Clean Architecture dependency rule violations
  export [--mermaid <path>] [--svg <path>] [<path>...]
                                            Export layered Mermaid or pure-Rust SVG diagram
  viewer [--port <N>] [--open]              Start standalone local HTTP UML workbench"
    );
}

fn parse_paths_and_flags(args: &[String]) -> (Vec<String>, bool, bool, bool) {
    let mut paths = Vec::new();
    let mut json = false;
    let mut edn = false;
    let mut force = false;
    for arg in args {
        match arg.as_str() {
            "--json" => json = true,
            "--edn" => edn = true,
            "--force" => force = true,
            _ => paths.push(arg.clone()),
        }
    }
    (paths, json, edn, force)
}

fn cmd_init_policy(root: &Path, args: &[String]) -> Result<i32, String> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("Usage: cargo xtask uml init-policy [--force] [--json]");
        return Ok(0);
    }
    let (_, json, _, force) = parse_paths_and_flags(args);
    let path = policy_path(root);
    let policy = if path.exists() && !force {
        read_json::<Policy>(&path)?
    } else {
        let p = default_policy(root);
        write_json(&path, &p)?;
        p
    };
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&policy).map_err(|err| format!("failed to serialize policy: {err}"))?
        );
    } else {
        println!(
            "policy ready at {} ({} sources, {} levels)",
            path.display(),
            policy.sources.len(),
            policy.levels.len()
        );
    }
    Ok(0)
}

fn cmd_ir(root: &Path, args: &[String]) -> Result<i32, String> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("Usage: cargo xtask uml ir [<path>...] [--json] [--edn]");
        return Ok(0);
    }
    let (paths, json, edn, _) = parse_paths_and_flags(args);
    let policy = load_or_init_policy(root)?;
    let ir = generate_ir(root, &policy, &paths)?;
    if edn {
        let val = serde_json::to_value(&ir).map_err(|err| format!("failed to convert IR to JSON value: {err}"))?;
        let edn_path = uml_dir(root).join("topology.edn");
        fs::write(&edn_path, format!("{}\n", to_edn(&val))).map_err(|err| format!("failed to write {}: {err}", edn_path.display()))?;
    }
    if json {
        println!("{}", serde_json::to_string_pretty(&ir).map_err(|err| format!("failed to serialize IR: {err}"))?);
    } else {
        println!(
            "uml ir: {} components, {} classes, {} forms, {} edges ({} violations) -> {}",
            ir.stats.total_components,
            ir.stats.total_classes,
            ir.stats.total_forms,
            ir.stats.total_edges,
            ir.stats.violating_edges,
            topology_path(root).display()
        );
    }
    Ok(0)
}

fn cmd_check(root: &Path, args: &[String]) -> Result<i32, String> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("Usage: cargo xtask uml check [<path>...] [--json]");
        return Ok(0);
    }
    let (paths, json, _, _) = parse_paths_and_flags(args);
    let policy = load_or_init_policy(root)?;
    let ir = generate_ir(root, &policy, &paths)?;

    if json {
        let report = serde_json::json!({
            "ok": ir.violations.is_empty(),
            "violating_edges": ir.stats.violating_edges,
            "total_edges": ir.stats.total_edges,
            "violations": ir.violations,
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&report).map_err(|err| format!("failed to serialize check report: {err}"))?
        );
    } else if ir.violations.is_empty() {
        println!("uml check: 0 dependency rule violations across {} edges", ir.stats.total_edges);
    } else {
        eprintln!("uml check: {} dependency rule violation(s):", ir.violations.len());
        for v in &ir.violations {
            eprintln!("  {} (rank {}) -> {} (rank {}) [{}:{}]", v.from, v.from_rank, v.to, v.to_rank, v.file, v.line);
        }
    }

    Ok(if ir.violations.is_empty() { 0 } else { 2 })
}

fn cmd_export(root: &Path, args: &[String]) -> Result<i32, String> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("Usage: cargo xtask uml export [--mermaid <path>] [--svg <path>] [<path>...]");
        return Ok(0);
    }
    let mut mermaid_out: Option<PathBuf> = None;
    let mut svg_out: Option<PathBuf> = None;
    let mut scope_id = "root".to_owned();
    let mut paths = Vec::new();
    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "--mermaid" => {
                let next = args.get(i + 1).ok_or_else(|| "--mermaid requires a file path".to_owned())?;
                mermaid_out = Some(PathBuf::from(next));
                i += 2;
            }
            "--svg" => {
                let next = args.get(i + 1).ok_or_else(|| "--svg requires a file path".to_owned())?;
                svg_out = Some(PathBuf::from(next));
                i += 2;
            }
            "--scope" => {
                let next = args.get(i + 1).ok_or_else(|| "--scope requires a component id".to_owned())?;
                scope_id = next.clone();
                i += 2;
            }
            other => {
                paths.push(other.to_owned());
                i += 1;
            }
        }
    }
    if mermaid_out.is_none() && svg_out.is_none() {
        return Err("uml export requires at least one of --mermaid <path> or --svg <path>".to_owned());
    }

    let policy = load_or_init_policy(root)?;
    let ir = generate_ir(root, &policy, &paths)?;

    if let Some(path) = mermaid_out {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            fs::create_dir_all(parent).map_err(|err| format!("failed to create {}: {err}", parent.display()))?;
        }
        let mmd = render_mermaid(&ir, &policy);
        fs::write(&path, mmd).map_err(|err| format!("failed to write {}: {err}", path.display()))?;
        println!("wrote mermaid diagram to {}", path.display());
    }
    if let Some(path) = svg_out {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            fs::create_dir_all(parent).map_err(|err| format!("failed to create {}: {err}", parent.display()))?;
        }
        let svg = render_svg(&ir, &policy, &scope_id);
        fs::write(&path, svg).map_err(|err| format!("failed to write {}: {err}", path.display()))?;
        println!("wrote svg diagram to {}", path.display());
    }
    Ok(0)
}

pub fn run(root: &Path, args: &[String]) -> Result<i32, String> {
    let Some((first, rest)) = args.split_first() else {
        return cmd_check(root, &[]);
    };

    match first.as_str() {
        "--help" | "-h" | "help" => {
            print_usage();
            Ok(0)
        }
        "init-policy" => cmd_init_policy(root, rest),
        "ir" => cmd_ir(root, rest),
        "check" => cmd_check(root, rest),
        "export" => cmd_export(root, rest),
        "viewer" => viewer::run(root, rest),
        "--svg" | "--mermaid" => cmd_export(root, args),
        other if other.starts_with('-') => {
            if args.iter().any(|a| a == "--help" || a == "-h") {
                print_usage();
                return Ok(0);
            }
            cmd_check(root, args)
        }
        _ => cmd_check(root, args),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("xtask-uml-{tag}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_file(root: &Path, rel: &str, body: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    #[test]
    fn dependency_rule_flags_only_outward_dependencies_and_rolls_up_to_parents() {
        let dir = temp_dir("dep-rule");
        write_file(
            &dir,
            "src/domain/order.rs",
            [
                "use crate::adapters::sql::Repo;",
                "pub trait Port { fn save(&self); }",
                "pub struct Order { id: i64 }",
            ]
            .join("\n")
            .as_str(),
        );
        write_file(
            &dir,
            "src/adapters/sql.rs",
            [
                "use crate::domain::order::Port;",
                "pub struct Repo {}",
                "impl Port for Repo { fn save(&self) {} }",
            ]
            .join("\n")
            .as_str(),
        );
        write_file(&dir, "src/domain/assoc.rs", "use crate::adapters::sql::Repo;\npub fn link() {}\n");

        let mut edge_kinds = BTreeMap::new();
        edge_kinds.insert("app.domain.assoc->app.adapters.sql".to_owned(), EdgeKind::Association);

        let policy = Policy {
            title: "Fixture".to_owned(),
            prefix: "app".to_owned(),
            hierarchical: true,
            sources: vec![SourceSpec {
                lang: Lang::Rust,
                root: "src".to_owned(),
                prefix: Some("app".to_owned()),
            }],
            foreign: Vec::new(),
            order: vec!["domain".to_owned(), "adapters".to_owned()],
            levels: vec![vec!["domain".to_owned()], vec!["adapters".to_owned()]],
            omit: Vec::new(),
            edge_kinds,
            proposals: Vec::new(),
        };

        let ir = build_topology(&dir, &policy, &[]).unwrap();

        // domain.order -> adapters.sql is :dependency with from_rank(0) < to_rank(1) -> MUST violate
        let order_dep = ir.edges.iter().find(|e| e.from == "app.domain.order" && e.to == "app.adapters.sql").unwrap();
        assert_eq!(order_dep.kind, EdgeKind::Dependency);
        assert!(order_dep.violating);

        // domain.assoc -> adapters.sql was remapped via edge_kinds to :association -> NEVER violates
        let assoc_edge = ir.edges.iter().find(|e| e.from == "app.domain.assoc" && e.to == "app.adapters.sql").unwrap();
        assert_eq!(assoc_edge.kind, EdgeKind::Association);
        assert!(!assoc_edge.violating);

        // adapters.sql -> domain.order is inward (rank 1 -> rank 0) -> NEVER violates
        let inward = ir.edges.iter().find(|e| e.from == "app.adapters.sql" && e.to == "app.domain.order").unwrap();
        assert!(!inward.violating);

        // impl Port for Repo is :implements -> NEVER violates
        let impl_edge = ir.edges.iter().find(|e| e.kind == EdgeKind::Implements).unwrap();
        assert!(!impl_edge.violating);

        // Collapsed component arrow domain -> adapters inherits violating: true
        let rolled = roll_up_edges(&ir, "root", &policy.omit, &policy.levels);
        let rolled_outward = rolled
            .iter()
            .find(|r| r.from == "app.domain" && r.to == "app.adapters" && r.kind == EdgeKind::Dependency)
            .unwrap();
        assert!(rolled_outward.violating);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn metrics_overlay_and_bob_grading_treat_missing_data_as_grade_one_and_pool_parents() {
        let dir = temp_dir("grading");
        write_file(&dir, "src/domain/clean.rs", "pub fn a() -> i32 { 1 }\npub fn b() -> i32 { 2 }\n");
        write_file(&dir, "src/domain/untested.rs", "pub fn c() -> i32 { 3 }\n");

        let crap = CrapSnapshot {
            version: 1,
            threshold: 10.0,
            coverage_mode: "full".to_owned(),
            summary: crate::qa::CrapSummary {
                total_forms: 2,
                scored_forms: 2,
                above_threshold: 0,
                mean_crap: Some(3.0),
                max_crap: Some(4.0),
                sigma_crap: Some(1.0),
            },
            entries: vec![
                CrapEntry {
                    namespace: "crate::domain::clean".to_owned(),
                    name: "a".to_owned(),
                    kind: FormKind::Function,
                    visibility: Visibility::Public,
                    lang: Lang::Rust,
                    file: "src/domain/clean.rs".to_owned(),
                    start_line: 1,
                    end_line: 1,
                    cc: 1,
                    flat_match_arms: 0,
                    is_flat_match: false,
                    lines_total: 1,
                    lines_covered: 1,
                    coverage: Some(100.0),
                    crap: Some(2.0),
                },
                CrapEntry {
                    namespace: "crate::domain::clean".to_owned(),
                    name: "b".to_owned(),
                    kind: FormKind::Function,
                    visibility: Visibility::Public,
                    lang: Lang::Rust,
                    file: "src/domain/clean.rs".to_owned(),
                    start_line: 2,
                    end_line: 2,
                    cc: 2,
                    flat_match_arms: 0,
                    is_flat_match: false,
                    lines_total: 1,
                    lines_covered: 1,
                    coverage: Some(100.0),
                    crap: Some(4.0),
                },
            ],
        };
        write_json(&crap_snapshot_path(&dir), &crap).unwrap();

        let mut forms = BTreeMap::new();
        forms.insert(
            "a".to_owned(),
            MutateForm {
                namespace: "crate::domain::clean".to_owned(),
                name: "a".to_owned(),
                kind: FormKind::Function,
                visibility: Visibility::Public,
                lang: Lang::Rust,
                file: "src/domain/clean.rs".to_owned(),
                start_line: 1,
                end_line: 1,
                body_hash: "h1".to_owned(),
                killed: 4,
                survived: 0,
                uncovered: 0,
                timeout: 0,
                compile_error: 0,
                total_sites: 4,
                score: Some(100.0),
                mutants: Vec::new(),
            },
        );
        forms.insert(
            "b".to_owned(),
            MutateForm {
                namespace: "crate::domain::clean".to_owned(),
                name: "b".to_owned(),
                kind: FormKind::Function,
                visibility: Visibility::Public,
                lang: Lang::Rust,
                file: "src/domain/clean.rs".to_owned(),
                start_line: 2,
                end_line: 2,
                body_hash: "h2".to_owned(),
                killed: 6,
                survived: 0,
                uncovered: 0,
                timeout: 0,
                compile_error: 0,
                total_sites: 6,
                score: Some(100.0),
                mutants: Vec::new(),
            },
        );
        write_json(
            &crate::qa::mutate_snapshot_path(&dir, "crate::domain::clean"),
            &MutateSnapshot {
                version: 1,
                namespace: "crate::domain::clean".to_owned(),
                lang: Lang::Rust,
                forms,
            },
        )
        .unwrap();

        let policy = Policy {
            title: "Grading".to_owned(),
            prefix: "app".to_owned(),
            hierarchical: true,
            sources: vec![SourceSpec {
                lang: Lang::Rust,
                root: "src".to_owned(),
                prefix: Some("app".to_owned()),
            }],
            foreign: Vec::new(),
            order: Vec::new(),
            levels: vec![vec!["domain".to_owned()]],
            omit: Vec::new(),
            edge_kinds: BTreeMap::new(),
            proposals: Vec::new(),
        };

        let ir = build_topology(&dir, &policy, &[]).unwrap();

        let clean = ir.nodes.get("app.domain.clean").unwrap();
        assert_eq!(clean.metrics.crap_mu, Some(3.0));
        assert_eq!(clean.metrics.crap_max, Some(4.0));
        assert_eq!(clean.metrics.crap_sigma, Some(1.0));
        assert_eq!(clean.metrics.crap_grade, 10);
        assert_eq!(clean.metrics.killed, 10);
        assert_eq!(clean.metrics.survived, 0);
        assert_eq!(clean.metrics.mutation_grade, 10);
        assert_eq!(clean.metrics.combined_grade, 10.0);

        // Missing CRAP and missing mutation MUST count as grade 1 (RED)
        let untested = ir.nodes.get("app.domain.untested").unwrap();
        assert_eq!(untested.metrics.crap_grade, 1);
        assert_eq!(untested.metrics.mutation_grade, 1);
        assert_eq!(untested.metrics.combined_grade, 1.0);
        assert_eq!(untested.metrics.fill_color, grade_to_fill_hex(1.0));

        // Parent `app.domain` pools CRAP by function count & sums mutation counts
        let domain = ir.nodes.get("app.domain").unwrap();
        assert_eq!(domain.metrics.form_count, 3);
        assert_eq!(domain.metrics.crap_count, 2);
        assert_eq!(domain.metrics.crap_mu, Some(3.0));
        assert_eq!(domain.metrics.killed, 10);
        assert_eq!(domain.metrics.sites, 10);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn exports_mermaid_with_heatmap_and_valid_pure_rust_svg() {
        let dir = temp_dir("export");
        write_file(&dir, "src/core/a.rs", "use crate::infra::b;\npub fn a() {}\n");
        write_file(&dir, "src/infra/b.rs", "pub fn b() {}\n");

        let policy = Policy {
            title: "ExportTest".to_owned(),
            prefix: "app".to_owned(),
            hierarchical: true,
            sources: vec![SourceSpec {
                lang: Lang::Rust,
                root: "src".to_owned(),
                prefix: Some("app".to_owned()),
            }],
            foreign: Vec::new(),
            order: vec!["core".to_owned(), "infra".to_owned()],
            levels: vec![vec!["core".to_owned()], vec!["infra".to_owned()]],
            omit: Vec::new(),
            edge_kinds: BTreeMap::new(),
            proposals: Vec::new(),
        };
        write_json(&policy_path(&dir), &policy).unwrap();

        let mmd_path = dir.join("out/arch.mmd");
        let svg_path = dir.join("out/arch.svg");
        let code = run(
            &dir,
            &[
                "export".to_owned(),
                "--mermaid".to_owned(),
                mmd_path.to_string_lossy().into_owned(),
                "--svg".to_owned(),
                svg_path.to_string_lossy().into_owned(),
            ],
        )
        .unwrap();
        assert_eq!(code, 0);

        let mmd = fs::read_to_string(&mmd_path).unwrap();
        assert!(mmd.starts_with("flowchart TD\n"));
        assert!(mmd.contains("classDef grade1"));
        assert!(mmd.contains("linkStyle 0 stroke:#dc2626"));

        let svg = fs::read_to_string(&svg_path).unwrap();
        assert!(svg.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\""));
        assert!(svg.contains("#dc2626"));
        assert!(svg.contains("</svg>"));

        let _ = fs::remove_dir_all(&dir);
    }
}
