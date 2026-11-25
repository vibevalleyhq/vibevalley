//! Quantitative macro-architecture lenses over `TopologyIr` and optional `git log`
//! (`cargo xtask uml arch`). Zero external dependencies.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::path::Path;
use std::process::Command;

use serde::Serialize;

use super::{IrNodeMeta, NodeKind, Policy, TopologyIr, qualify_namespace, split_ns_segments};
use crate::qa::lang::{rust_module_namespace, ts_module_namespace};
use crate::qa::{Lang, is_qa_source_path, normalize_posix_path};

pub const DEFAULT_MIN_DELTA: f64 = 0.15;
pub const DEFAULT_GIT_COMMITS: usize = 200;
const MAX_MODULES_PER_COMMIT: usize = 12;
const ZONE_DISTANCE_THRESHOLD: f64 = 0.30;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ArchOptions {
    pub scope: Option<String>,
    pub min_delta: f64,
    pub git_commits: usize,
    pub no_git: bool,
}

impl Default for ArchOptions {
    fn default() -> Self {
        Self {
            scope: None,
            min_delta: DEFAULT_MIN_DELTA,
            git_commits: DEFAULT_GIT_COMMITS,
            no_git: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ArchZone {
    Pain,
    Uselessness,
    Balanced,
}

impl ArchZone {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pain => "pain",
            Self::Uselessness => "uselessness",
            Self::Balanced => "balanced",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModuleIad {
    pub module: String,
    pub crate_name: String,
    pub ca: usize,
    pub ce: usize,
    pub instability: f64,
    pub abstract_types: usize,
    pub total_types: usize,
    pub abstractness: f64,
    pub distance: f64,
    pub zone: ArchZone,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SdpInversion {
    pub scope: String,
    pub from: String,
    pub to: String,
    pub from_instability: f64,
    pub to_instability: f64,
    pub delta: f64,
    pub edge_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FeedbackArc {
    pub from: String,
    pub to: String,
    pub weight: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MutualCycle {
    pub a: String,
    pub b: String,
    pub forward_weight: usize,
    pub backward_weight: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScopeCycleAnalysis {
    pub scope: String,
    pub node_count: usize,
    pub edge_count: usize,
    pub sccs: Vec<Vec<String>>,
    pub mutual_cycles: Vec<MutualCycle>,
    pub dsm_order: Vec<String>,
    pub feedback_arcs: Vec<FeedbackArc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CyclesReport {
    pub crate_scope: ScopeCycleAnalysis,
    pub mod2_scope: ScopeCycleAnalysis,
    pub mod3_scope: ScopeCycleAnalysis,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MisplacedModule {
    pub module: String,
    pub crate_name: String,
    pub intra_coupling: usize,
    pub cross_coupling: usize,
    pub efferent_cross: usize,
    pub afferent_cross: usize,
    pub gravity_ratio: f64,
    pub top_external_crate: String,
    pub top_external_coupling: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BlastRadiusEntry {
    pub module: String,
    pub crate_name: String,
    pub impacted_count: usize,
    pub total_modules: usize,
    pub impacted_pct: f64,
    pub direct_dependents: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CoChangePair {
    pub module_a: String,
    pub module_b: String,
    pub co_changes: usize,
    pub commits_a: usize,
    pub commits_b: usize,
    pub jaccard: f64,
    pub has_static_edge: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CoChangeReport {
    pub enabled: bool,
    pub commits_scanned: usize,
    pub commits_mapped: usize,
    pub skipped_mechanical_commits: usize,
    pub pairs: Vec<CoChangePair>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FindingSeverity {
    High,
    Medium,
    Low,
}

impl FindingSeverity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::High => "high",
            Self::Medium => "medium",
            Self::Low => "low",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ArchFinding {
    pub severity: FindingSeverity,
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub modules: Vec<String>,
    pub score: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ArchSummary {
    pub total_modules: usize,
    pub total_edges: usize,
    pub sdp_repo_inversions: usize,
    pub sdp_intra_inversions: usize,
    pub zone_of_pain_count: usize,
    pub zone_of_uselessness_count: usize,
    pub crate_cycles: usize,
    pub mod2_cycles: usize,
    pub mod3_cycles: usize,
    pub misplaced_modules: usize,
    pub co_change_pairs: usize,
    pub finding_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ArchReport {
    pub version: u32,
    pub config: ArchOptions,
    pub summary: ArchSummary,
    pub modules: Vec<ModuleIad>,
    pub sdp_inversions_repo: Vec<SdpInversion>,
    pub sdp_inversions_intra: Vec<SdpInversion>,
    pub cycles: CyclesReport,
    pub misplaced: Vec<MisplacedModule>,
    pub blast_radius: Vec<BlastRadiusEntry>,
    pub co_change: CoChangeReport,
    pub findings: Vec<ArchFinding>,
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

fn is_abstract_type_kind(type_kind: Option<&str>) -> bool {
    matches!(type_kind, Some("trait" | "interface"))
}

fn is_counted_type_kind(type_kind: Option<&str>) -> bool {
    matches!(type_kind, Some("struct" | "enum" | "class" | "trait" | "interface"))
}

fn strip_module_suffix(id: &str) -> &str {
    id.strip_suffix("._module").unwrap_or(id)
}

fn is_ns_ancestor(ancestor: &str, candidate: &str) -> bool {
    ancestor == candidate || candidate.starts_with(&format!("{ancestor}."))
}

fn resolve_node_module(id: &str, nodes: &BTreeMap<String, IrNodeMeta>) -> Option<String> {
    if id == "root" || id.starts_with("foreign.") {
        return None;
    }
    let clean = strip_module_suffix(id);
    if let Some(meta) = nodes.get(id).or_else(|| nodes.get(clean)) {
        return match meta.node_kind {
            NodeKind::Foreign => None,
            NodeKind::Component => Some(meta.id.clone()),
            NodeKind::Class => {
                if meta.type_kind.as_deref() == Some("module") {
                    Some(strip_module_suffix(&meta.id).to_owned())
                } else {
                    Some(meta.id.rsplit_once('.').map_or_else(|| meta.id.clone(), |(p, _)| p.to_owned()))
                }
            }
        };
    }

    // Fallback for edge targets pointing at a re-exported fn inside a known module.
    let mut cur = clean;
    while let Some((parent, _)) = cur.rsplit_once('.') {
        if let Some(meta) = nodes.get(parent) {
            return match meta.node_kind {
                NodeKind::Foreign => None,
                NodeKind::Component => Some(meta.id.clone()),
                NodeKind::Class if meta.type_kind.as_deref() == Some("module") => Some(strip_module_suffix(&meta.id).to_owned()),
                NodeKind::Class => Some(parent.to_owned()),
            };
        }
        cur = parent;
    }
    None
}

fn project_scope_id(mod_ns: &str, prefix: &str, depth: usize) -> Option<(String, String)> {
    let mod_segs = split_ns_segments(mod_ns);
    let pref_segs = split_ns_segments(prefix);
    let rel = if pref_segs.is_empty() {
        mod_segs.as_slice()
    } else if mod_segs.len() > pref_segs.len() && mod_segs[..pref_segs.len()] == pref_segs[..] {
        &mod_segs[pref_segs.len()..]
    } else {
        return None;
    };
    if rel.is_empty() {
        return None;
    }
    let crate_name = rel[0].to_owned();
    let take_len = rel.len().min(depth);
    let mut full = pref_segs;
    full.extend_from_slice(&rel[..take_len]);
    Some((full.join("."), crate_name))
}

fn normalize_scope_filter(scope: Option<&str>, prefix: &str) -> Option<String> {
    let raw = scope.map(str::trim).filter(|s| !s.is_empty())?;
    let pref_segs = split_ns_segments(prefix);
    let raw_segs = split_ns_segments(raw);
    if !pref_segs.is_empty() && raw_segs.len() > pref_segs.len() && raw_segs[..pref_segs.len()] == pref_segs[..] {
        Some(raw_segs[pref_segs.len()].to_owned())
    } else {
        raw_segs.first().map(|s| (*s).to_owned())
    }
}

/// Filters out parent container modules (such as crate root `vibevalley.server` or `vibevalley.server.db`)
/// when deeper child modules exist at the requested depth, while preserving flat leaf modules.
fn prune_container_modules(all_mods: &BTreeSet<String>, target_depth: usize, prefix: &str) -> BTreeSet<String> {
    let pref_len = split_ns_segments(prefix).len();
    let mut kept = BTreeSet::new();
    for m in all_mods {
        let seg_count = split_ns_segments(m).len();
        let rel_depth = seg_count.saturating_sub(pref_len);
        if rel_depth >= target_depth {
            kept.insert(m.clone());
        } else {
            let prefix_dot = format!("{m}.");
            let has_deeper_child = all_mods.iter().any(|other| other.starts_with(&prefix_dot));
            if !has_deeper_child {
                kept.insert(m.clone());
            }
        }
    }
    kept
}

#[derive(Default)]
struct DirectedGraph {
    nodes: BTreeSet<String>,
    node_crates: BTreeMap<String, String>,
    edges: BTreeMap<(String, String), usize>,
    adj: BTreeMap<String, BTreeSet<String>>,
    rev_adj: BTreeMap<String, BTreeSet<String>>,
}

impl DirectedGraph {
    fn add_node(&mut self, id: String, crate_name: String) {
        self.nodes.insert(id.clone());
        self.node_crates.entry(id.clone()).or_insert(crate_name);
        self.adj.entry(id.clone()).or_default();
        self.rev_adj.entry(id).or_default();
    }

    fn add_edge(&mut self, from: String, to: String, weight: usize) {
        if from == to || is_ns_ancestor(&from, &to) || is_ns_ancestor(&to, &from) {
            return;
        }
        *self.edges.entry((from.clone(), to.clone())).or_insert(0) += weight;
        self.adj.entry(from.clone()).or_default().insert(to.clone());
        self.rev_adj.entry(to).or_default().insert(from);
    }
}

fn build_scoped_graph(ir: &TopologyIr, depth: usize, crate_filter: Option<&str>) -> DirectedGraph {
    let mut raw_mods: BTreeSet<String> = BTreeSet::new();
    let mut mod_crates: BTreeMap<String, String> = BTreeMap::new();

    for id in ir.nodes.keys() {
        let Some(mod_ns) = resolve_node_module(id, &ir.nodes) else {
            continue;
        };
        let Some((scoped_id, crate_name)) = project_scope_id(&mod_ns, &ir.prefix, depth) else {
            continue;
        };
        if let Some(filter) = crate_filter
            && crate_name != filter
        {
            continue;
        }
        raw_mods.insert(scoped_id.clone());
        mod_crates.insert(scoped_id, crate_name);
    }

    let kept_nodes = prune_container_modules(&raw_mods, depth, &ir.prefix);
    let mut graph = DirectedGraph::default();
    for id in &kept_nodes {
        if let Some(crate_name) = mod_crates.get(id) {
            graph.add_node(id.clone(), crate_name.clone());
        }
    }

    for edge in &ir.edges {
        let (Some(from_mod), Some(to_mod)) = (resolve_node_module(&edge.from, &ir.nodes), resolve_node_module(&edge.to, &ir.nodes)) else {
            continue;
        };
        let (Some((from_s, from_c)), Some((to_s, to_c))) = (project_scope_id(&from_mod, &ir.prefix, depth), project_scope_id(&to_mod, &ir.prefix, depth))
        else {
            continue;
        };
        if let Some(filter) = crate_filter
            && (from_c != filter || to_c != filter)
        {
            continue;
        }
        if kept_nodes.contains(&from_s) && kept_nodes.contains(&to_s) {
            graph.add_edge(from_s, to_s, 1);
        }
    }

    graph
}

fn compute_iad_for_graph(graph: &DirectedGraph, type_counts: &BTreeMap<String, (usize, usize)>) -> Vec<ModuleIad> {
    let mut out = Vec::with_capacity(graph.nodes.len());
    for module in &graph.nodes {
        let ca = graph.rev_adj.get(module).map_or(0, BTreeSet::len);
        let ce = graph.adj.get(module).map_or(0, BTreeSet::len);
        let instability = if ca + ce == 0 { 0.0 } else { round3(ce as f64 / (ca + ce) as f64) };
        let (abstract_types, total_types) = type_counts.get(module).copied().unwrap_or((0, 0));
        let abstractness = if total_types == 0 {
            0.0
        } else {
            round3(abstract_types as f64 / total_types as f64)
        };
        let distance = round3((abstractness + instability - 1.0).abs());
        let zone = if ca + ce == 0 {
            ArchZone::Balanced
        } else if distance > ZONE_DISTANCE_THRESHOLD && (abstractness + instability) < 1.0 && ca > 0 {
            ArchZone::Pain
        } else if distance > ZONE_DISTANCE_THRESHOLD && (abstractness + instability) > 1.0 {
            ArchZone::Uselessness
        } else {
            ArchZone::Balanced
        };
        let crate_name = graph.node_crates.get(module).cloned().unwrap_or_default();

        out.push(ModuleIad {
            module: module.clone(),
            crate_name,
            ca,
            ce,
            instability,
            abstract_types,
            total_types,
            abstractness,
            distance,
            zone,
        });
    }

    out.sort_by(|a, b| {
        b.distance
            .total_cmp(&a.distance)
            .then_with(|| b.ca.cmp(&a.ca))
            .then_with(|| a.module.cmp(&b.module))
    });
    out
}

fn collect_mod2_type_counts(ir: &TopologyIr, valid_mod2: &BTreeSet<String>) -> BTreeMap<String, (usize, usize)> {
    let mut counts: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for meta in ir.nodes.values() {
        if meta.node_kind != NodeKind::Class {
            continue;
        }
        let tk = meta.type_kind.as_deref();
        if !is_counted_type_kind(tk) {
            continue;
        }
        let Some(mod_ns) = resolve_node_module(&meta.id, &ir.nodes) else {
            continue;
        };
        let Some((mod2_id, _)) = project_scope_id(&mod_ns, &ir.prefix, 2) else {
            continue;
        };
        if !valid_mod2.contains(&mod2_id) {
            continue;
        }
        let entry = counts.entry(mod2_id).or_insert((0, 0));
        entry.1 += 1;
        if is_abstract_type_kind(tk) {
            entry.0 += 1;
        }
    }
    counts
}

fn find_sdp_inversions(graph: &DirectedGraph, iad_map: &BTreeMap<String, f64>, scope_label: &str, min_delta: f64) -> Vec<SdpInversion> {
    let mut inversions = Vec::new();
    for ((from, to), &edge_count) in &graph.edges {
        let Some(&i_from) = iad_map.get(from) else {
            continue;
        };
        let Some(&i_to) = iad_map.get(to) else {
            continue;
        };
        let delta = i_to - i_from;
        if i_from < i_to && delta + 1e-9 >= min_delta {
            inversions.push(SdpInversion {
                scope: scope_label.to_owned(),
                from: from.clone(),
                to: to.clone(),
                from_instability: i_from,
                to_instability: i_to,
                delta: round3(delta),
                edge_count,
            });
        }
    }
    inversions.sort_by(|a, b| {
        b.delta
            .total_cmp(&a.delta)
            .then_with(|| b.edge_count.cmp(&a.edge_count))
            .then_with(|| a.from.cmp(&b.from))
            .then_with(|| a.to.cmp(&b.to))
    });
    inversions
}

fn compute_intra_crate_sdp(ir: &TopologyIr, crate_filter: Option<&str>, min_delta: f64) -> Vec<SdpInversion> {
    let mut crates: BTreeSet<String> = BTreeSet::new();
    for id in ir.nodes.keys() {
        if let Some(mod_ns) = resolve_node_module(id, &ir.nodes)
            && let Some((_, crate_name)) = project_scope_id(&mod_ns, &ir.prefix, 2)
        {
            if let Some(filter) = crate_filter
                && crate_name != filter
            {
                continue;
            }
            crates.insert(crate_name);
        }
    }

    let mut all_inversions = Vec::new();
    for crate_name in crates {
        let sub_graph = build_scoped_graph(ir, 2, Some(&crate_name));
        let mut i_map = BTreeMap::new();
        for module in &sub_graph.nodes {
            let ca = sub_graph.rev_adj.get(module).map_or(0, BTreeSet::len);
            let ce = sub_graph.adj.get(module).map_or(0, BTreeSet::len);
            let inst = if ca + ce == 0 { 0.0 } else { round3(ce as f64 / (ca + ce) as f64) };
            i_map.insert(module.clone(), inst);
        }
        all_inversions.extend(find_sdp_inversions(&sub_graph, &i_map, &crate_name, min_delta));
    }

    all_inversions.sort_by(|a, b| {
        b.delta
            .total_cmp(&a.delta)
            .then_with(|| b.edge_count.cmp(&a.edge_count))
            .then_with(|| a.scope.cmp(&b.scope))
            .then_with(|| a.from.cmp(&b.from))
            .then_with(|| a.to.cmp(&b.to))
    });
    all_inversions
}

fn tarjan_sccs(graph: &DirectedGraph) -> Vec<Vec<String>> {
    struct State<'a> {
        adj: &'a BTreeMap<String, BTreeSet<String>>,
        index: usize,
        indices: HashMap<String, usize>,
        lowlink: HashMap<String, usize>,
        on_stack: BTreeMap<String, bool>,
        stack: Vec<String>,
        sccs: Vec<Vec<String>>,
    }

    fn strongconnect(v: &str, st: &mut State<'_>) {
        let v_idx = st.index;
        st.indices.insert(v.to_owned(), v_idx);
        st.lowlink.insert(v.to_owned(), v_idx);
        st.index += 1;
        st.stack.push(v.to_owned());
        st.on_stack.insert(v.to_owned(), true);

        if let Some(neighbors) = st.adj.get(v) {
            for w in neighbors {
                if !st.indices.contains_key(w) {
                    strongconnect(w, st);
                    let w_low = st.lowlink[w];
                    let v_low = st.lowlink[v];
                    if w_low < v_low {
                        st.lowlink.insert(v.to_owned(), w_low);
                    }
                } else if st.on_stack.get(w).copied().unwrap_or(false) {
                    let w_idx = st.indices[w];
                    let v_low = st.lowlink[v];
                    if w_idx < v_low {
                        st.lowlink.insert(v.to_owned(), w_idx);
                    }
                }
            }
        }

        if st.lowlink[v] == v_idx {
            let mut comp = Vec::new();
            while let Some(w) = st.stack.pop() {
                st.on_stack.insert(w.clone(), false);
                let is_root = w == v;
                comp.push(w);
                if is_root {
                    break;
                }
            }
            comp.sort();
            st.sccs.push(comp);
        }
    }

    let mut st = State {
        adj: &graph.adj,
        index: 0,
        indices: HashMap::new(),
        lowlink: HashMap::new(),
        on_stack: BTreeMap::new(),
        stack: Vec::new(),
        sccs: Vec::new(),
    };

    for node in &graph.nodes {
        if !st.indices.contains_key(node) {
            strongconnect(node, &mut st);
        }
    }
    st.sccs
}

fn analyze_scope_cycles(graph: &DirectedGraph, scope_name: &str) -> ScopeCycleAnalysis {
    let all_sccs = tarjan_sccs(graph);
    let mut node_to_scc: HashMap<String, usize> = HashMap::new();
    for (idx, comp) in all_sccs.iter().enumerate() {
        for n in comp {
            node_to_scc.insert(n.clone(), idx);
        }
    }

    // Condense SCCs into a provider-first DAG: edge u -> v (u depends on v) puts scc(v) before scc(u).
    let scc_count = all_sccs.len();
    let mut dag_adj: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); scc_count];
    let mut in_deg: Vec<usize> = vec![0; scc_count];
    for (u, v) in graph.edges.keys() {
        let su = node_to_scc[u];
        let sv = node_to_scc[v];
        if su != sv && dag_adj[sv].insert(su) {
            in_deg[su] += 1;
        }
    }

    let mut ready: BTreeSet<(String, usize)> = BTreeSet::new();
    for (idx, &deg) in in_deg.iter().enumerate() {
        if deg == 0 {
            let key = all_sccs[idx].first().cloned().unwrap_or_default();
            ready.insert((key, idx));
        }
    }

    let mut topo_sccs = Vec::with_capacity(scc_count);
    while let Some((_, scc_idx)) = ready.pop_first() {
        topo_sccs.push(scc_idx);
        for &next in &dag_adj[scc_idx] {
            in_deg[next] -= 1;
            if in_deg[next] == 0 {
                let key = all_sccs[next].first().cloned().unwrap_or_default();
                ready.insert((key, next));
            }
        }
    }

    let mut dsm_order = Vec::with_capacity(graph.nodes.len());
    for scc_idx in topo_sccs {
        let mut comp = all_sccs[scc_idx].clone();
        if comp.len() > 1 {
            let comp_set: BTreeSet<String> = comp.iter().cloned().collect();
            comp.sort_by(|a, b| {
                let a_total_bal = graph.rev_adj.get(a).map_or(0isize, |s| s.len() as isize) - graph.adj.get(a).map_or(0isize, |s| s.len() as isize);
                let b_total_bal = graph.rev_adj.get(b).map_or(0isize, |s| s.len() as isize) - graph.adj.get(b).map_or(0isize, |s| s.len() as isize);

                let a_scc_in = graph
                    .rev_adj
                    .get(a)
                    .map_or(0isize, |s| s.iter().filter(|n| comp_set.contains(*n)).count() as isize);
                let a_scc_out = graph.adj.get(a).map_or(0isize, |s| s.iter().filter(|n| comp_set.contains(*n)).count() as isize);
                let b_scc_in = graph
                    .rev_adj
                    .get(b)
                    .map_or(0isize, |s| s.iter().filter(|n| comp_set.contains(*n)).count() as isize);
                let b_scc_out = graph.adj.get(b).map_or(0isize, |s| s.iter().filter(|n| comp_set.contains(*n)).count() as isize);

                b_total_bal
                    .cmp(&a_total_bal)
                    .then_with(|| (b_scc_in - b_scc_out).cmp(&(a_scc_in - a_scc_out)))
                    .then_with(|| a.cmp(b))
            });
        }
        dsm_order.extend(comp);
    }

    let pos: HashMap<&str, usize> = dsm_order.iter().enumerate().map(|(i, n)| (n.as_str(), i)).collect();
    let mut feedback_arcs = Vec::new();
    for ((from, to), &weight) in &graph.edges {
        if let (Some(&pf), Some(&pt)) = (pos.get(from.as_str()), pos.get(to.as_str()))
            && pf < pt
        {
            feedback_arcs.push(FeedbackArc {
                from: from.clone(),
                to: to.clone(),
                weight,
            });
        }
    }
    feedback_arcs.sort_by(|a, b| b.weight.cmp(&a.weight).then_with(|| a.from.cmp(&b.from)).then_with(|| a.to.cmp(&b.to)));

    let mut mutual_cycles = Vec::new();
    for ((a, b), &fw) in &graph.edges {
        if a < b
            && let Some(&bw) = graph.edges.get(&(b.clone(), a.clone()))
        {
            mutual_cycles.push(MutualCycle {
                a: a.clone(),
                b: b.clone(),
                forward_weight: fw,
                backward_weight: bw,
            });
        }
    }
    mutual_cycles.sort_by(|x, y| {
        (y.forward_weight + y.backward_weight)
            .cmp(&(x.forward_weight + x.backward_weight))
            .then_with(|| x.a.cmp(&y.a))
            .then_with(|| x.b.cmp(&y.b))
    });

    let mut cyclic_sccs: Vec<Vec<String>> = all_sccs.into_iter().filter(|c| c.len() > 1).collect();
    cyclic_sccs.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.first().cmp(&b.first())));

    ScopeCycleAnalysis {
        scope: scope_name.to_owned(),
        node_count: graph.nodes.len(),
        edge_count: graph.edges.len(),
        sccs: cyclic_sccs,
        mutual_cycles,
        dsm_order,
        feedback_arcs,
    }
}

fn compute_misplaced_modules(ir: &TopologyIr, valid_mod2: &BTreeSet<String>, crate_filter: Option<&str>) -> Vec<MisplacedModule> {
    let mut intra: BTreeMap<String, usize> = BTreeMap::new();
    let mut efferent_cross: BTreeMap<String, usize> = BTreeMap::new();
    let mut afferent_cross: BTreeMap<String, usize> = BTreeMap::new();
    let mut cross_by_crate: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new();
    let mut module_crates: BTreeMap<String, String> = BTreeMap::new();

    for m in valid_mod2 {
        if let Some((_, crate_name)) = project_scope_id(m, &ir.prefix, 2) {
            module_crates.insert(m.clone(), crate_name);
        }
    }

    for edge in &ir.edges {
        let (Some(from_mod), Some(to_mod)) = (resolve_node_module(&edge.from, &ir.nodes), resolve_node_module(&edge.to, &ir.nodes)) else {
            continue;
        };
        let (Some((a, ca)), Some((b, cb))) = (project_scope_id(&from_mod, &ir.prefix, 2), project_scope_id(&to_mod, &ir.prefix, 2)) else {
            continue;
        };
        if a == b || is_ns_ancestor(&a, &b) || is_ns_ancestor(&b, &a) {
            continue;
        }
        if !valid_mod2.contains(&a) || !valid_mod2.contains(&b) {
            continue;
        }
        if ca == cb {
            *intra.entry(a).or_insert(0) += 1;
            *intra.entry(b).or_insert(0) += 1;
        } else {
            if cb != "protocol" {
                *efferent_cross.entry(a.clone()).or_insert(0) += 1;
                *cross_by_crate.entry(a).or_default().entry(cb).or_insert(0) += 1;
            }
            if ca != "protocol" {
                *afferent_cross.entry(b.clone()).or_insert(0) += 1;
                *cross_by_crate.entry(b).or_default().entry(ca).or_insert(0) += 1;
            }
        }
    }

    let mut misplaced = Vec::new();
    for (module, crate_name) in &module_crates {
        if crate_name == "protocol" {
            continue;
        }
        if let Some(filter) = crate_filter
            && crate_name != filter
        {
            continue;
        }
        let iw = intra.get(module).copied().unwrap_or(0);
        let eff = efferent_cross.get(module).copied().unwrap_or(0);
        let aff = afferent_cross.get(module).copied().unwrap_or(0);
        let cw = eff + aff;
        if cw > iw && cw > 0 {
            let (top_external_crate, top_external_coupling) = cross_by_crate
                .get(module)
                .and_then(|map| map.iter().max_by(|(k1, v1), (k2, v2)| v1.cmp(v2).then_with(|| k2.cmp(k1))))
                .map_or_else(|| (String::new(), 0), |(k, v)| (k.clone(), *v));
            let gravity_ratio = round3(cw as f64 / (iw + cw) as f64);
            misplaced.push(MisplacedModule {
                module: module.clone(),
                crate_name: crate_name.clone(),
                intra_coupling: iw,
                cross_coupling: cw,
                efferent_cross: eff,
                afferent_cross: aff,
                gravity_ratio,
                top_external_crate,
                top_external_coupling,
            });
        }
    }

    misplaced.sort_by(|a, b| {
        (b.cross_coupling - b.intra_coupling)
            .cmp(&(a.cross_coupling - a.intra_coupling))
            .then_with(|| b.cross_coupling.cmp(&a.cross_coupling))
            .then_with(|| a.module.cmp(&b.module))
    });
    misplaced
}

fn compute_blast_radius(graph: &DirectedGraph) -> Vec<BlastRadiusEntry> {
    let total_modules = graph.nodes.len();
    let mut entries = Vec::with_capacity(total_modules);

    for module in &graph.nodes {
        let mut visited: BTreeSet<&str> = BTreeSet::new();
        let mut queue: VecDeque<&str> = VecDeque::new();
        visited.insert(module.as_str());
        queue.push_back(module.as_str());

        while let Some(cur) = queue.pop_front() {
            if let Some(deps) = graph.rev_adj.get(cur) {
                for dep in deps {
                    if visited.insert(dep.as_str()) {
                        queue.push_back(dep.as_str());
                    }
                }
            }
        }

        let impacted_count = visited.len().saturating_sub(1);
        let impacted_pct = if total_modules == 0 {
            0.0
        } else {
            round1(impacted_count as f64 * 100.0 / total_modules as f64)
        };
        let direct_dependents = graph.rev_adj.get(module).map_or(0, BTreeSet::len);
        let crate_name = graph.node_crates.get(module).cloned().unwrap_or_default();

        entries.push(BlastRadiusEntry {
            module: module.clone(),
            crate_name,
            impacted_count,
            total_modules,
            impacted_pct,
            direct_dependents,
        });
    }

    entries.sort_by(|a, b| {
        b.impacted_count
            .cmp(&a.impacted_count)
            .then_with(|| b.direct_dependents.cmp(&a.direct_dependents))
            .then_with(|| a.module.cmp(&b.module))
    });
    entries
}

fn resolve_git_file_to_mod2(
    rel_posix: &str,
    file_to_mod2: &HashMap<String, String>,
    policy: &Policy,
    valid_mod2: &BTreeSet<String>,
    crate_filter: Option<&str>,
) -> Option<String> {
    if let Some(found) = file_to_mod2.get(rel_posix) {
        if let Some(filter) = crate_filter
            && project_scope_id(found, &policy.prefix, 2).is_none_or(|(_, c)| c != filter)
        {
            return None;
        }
        return Some(found.clone());
    }
    let lang = is_qa_source_path(rel_posix)?;
    for src in &policy.sources {
        if src.lang != lang {
            continue;
        }
        if src.root != "." && !rel_posix.starts_with(&format!("{}/", src.root.trim_end_matches('/'))) {
            continue;
        }
        let raw_ns = match lang {
            Lang::Rust => rust_module_namespace(rel_posix),
            Lang::TypeScript => ts_module_namespace(rel_posix),
        };
        let qual = qualify_namespace(&raw_ns, src.prefix.as_deref(), lang);
        if let Some((mod2_id, crate_name)) = project_scope_id(&qual, &policy.prefix, 2) {
            if let Some(filter) = crate_filter
                && crate_name != filter
            {
                continue;
            }
            if valid_mod2.contains(&mod2_id) {
                return Some(mod2_id);
            }
        }
    }
    None
}

fn compute_co_change(
    root: &Path,
    policy: &Policy,
    ir: &TopologyIr,
    mod2_graph: &DirectedGraph,
    crate_filter: Option<&str>,
    opts: &ArchOptions,
) -> CoChangeReport {
    if opts.no_git || opts.git_commits == 0 {
        return CoChangeReport {
            enabled: false,
            commits_scanned: 0,
            commits_mapped: 0,
            skipped_mechanical_commits: 0,
            pairs: Vec::new(),
        };
    }

    let limit_arg = opts.git_commits.to_string();
    let Ok(output) = Command::new("git")
        .args([
            "-c",
            "diff.renames=false",
            "log",
            "-n",
            &limit_arg,
            "--name-only",
            "--pretty=format:__COMMIT__%H",
        ])
        .current_dir(root)
        .output()
    else {
        return CoChangeReport {
            enabled: true,
            commits_scanned: 0,
            commits_mapped: 0,
            skipped_mechanical_commits: 0,
            pairs: Vec::new(),
        };
    };

    if !output.status.success() {
        return CoChangeReport {
            enabled: true,
            commits_scanned: 0,
            commits_mapped: 0,
            skipped_mechanical_commits: 0,
            pairs: Vec::new(),
        };
    }

    let mut file_to_mod2: HashMap<String, String> = HashMap::new();
    for meta in ir.nodes.values() {
        let Some(file) = meta.file.as_deref() else {
            continue;
        };
        let Some(mod_ns) = resolve_node_module(&meta.id, &ir.nodes) else {
            continue;
        };
        if let Some((mod2_id, _)) = project_scope_id(&mod_ns, &ir.prefix, 2)
            && mod2_graph.nodes.contains(&mod2_id)
        {
            file_to_mod2.insert(normalize_posix_path(file), mod2_id);
        }
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut commits_scanned = 0usize;
    let mut commit_sets: Vec<BTreeSet<String>> = Vec::new();
    let mut current: Option<BTreeSet<String>> = None;

    for raw_line in stdout.lines() {
        let line = raw_line.trim();
        if line.starts_with("__COMMIT__") {
            if let Some(prev) = current.take()
                && !prev.is_empty()
            {
                commit_sets.push(prev);
            }
            commits_scanned += 1;
            current = Some(BTreeSet::new());
        } else if !line.is_empty()
            && let Some(set) = current.as_mut()
        {
            let norm = normalize_posix_path(line);
            if let Some(mod2_id) = resolve_git_file_to_mod2(&norm, &file_to_mod2, policy, &mod2_graph.nodes, crate_filter) {
                set.insert(mod2_id);
            }
        }
    }
    if let Some(last) = current.take()
        && !last.is_empty()
    {
        commit_sets.push(last);
    }

    let commits_mapped = commit_sets.len();
    let mut skipped_mechanical_commits = 0usize;
    let mut mod_commits: BTreeMap<String, usize> = BTreeMap::new();
    let mut pair_counts: BTreeMap<(String, String), usize> = BTreeMap::new();

    for set in commit_sets {
        if set.len() > MAX_MODULES_PER_COMMIT {
            skipped_mechanical_commits += 1;
            continue;
        }
        let mods: Vec<String> = set.into_iter().collect();
        for m in &mods {
            *mod_commits.entry(m.clone()).or_insert(0) += 1;
        }
        for i in 0..mods.len() {
            for j in (i + 1)..mods.len() {
                *pair_counts.entry((mods[i].clone(), mods[j].clone())).or_insert(0) += 1;
            }
        }
    }

    let min_co = if commits_mapped >= 5 { 2 } else { 1 };
    let mut pairs = Vec::new();
    for ((a, b), co_changes) in pair_counts {
        if co_changes < min_co {
            continue;
        }
        let commits_a = mod_commits.get(&a).copied().unwrap_or(co_changes);
        let commits_b = mod_commits.get(&b).copied().unwrap_or(co_changes);
        let denom = commits_a + commits_b - co_changes;
        let jaccard = if denom == 0 { 0.0 } else { round3(co_changes as f64 / denom as f64) };
        let has_static_edge = mod2_graph.edges.contains_key(&(a.clone(), b.clone())) || mod2_graph.edges.contains_key(&(b.clone(), a.clone()));
        pairs.push(CoChangePair {
            module_a: a,
            module_b: b,
            co_changes,
            commits_a,
            commits_b,
            jaccard,
            has_static_edge,
        });
    }

    pairs.sort_by(|x, y| {
        y.co_changes
            .cmp(&x.co_changes)
            .then_with(|| y.jaccard.total_cmp(&x.jaccard))
            .then_with(|| x.module_a.cmp(&y.module_a))
            .then_with(|| x.module_b.cmp(&y.module_b))
    });

    CoChangeReport {
        enabled: true,
        commits_scanned,
        commits_mapped,
        skipped_mechanical_commits,
        pairs,
    }
}

fn build_ranked_findings(
    modules: &[ModuleIad],
    sdp_repo: &[SdpInversion],
    sdp_intra: &[SdpInversion],
    cycles: &CyclesReport,
    misplaced: &[MisplacedModule],
    blast_radius: &[BlastRadiusEntry],
    co_change: &CoChangeReport,
) -> Vec<ArchFinding> {
    let mut findings = Vec::new();

    for (scope_label, analysis, base_score) in [
        ("crate", &cycles.crate_scope, 90.0),
        ("mod2", &cycles.mod2_scope, 70.0),
        ("mod3", &cycles.mod3_scope, 40.0),
    ] {
        for scc in &analysis.sccs {
            let severity = if scope_label == "crate" || (scope_label == "mod2" && scc.len() >= 3) {
                FindingSeverity::High
            } else if scope_label == "mod2" {
                FindingSeverity::Medium
            } else {
                FindingSeverity::Low
            };
            findings.push(ArchFinding {
                severity,
                kind: "scc_cycle".to_owned(),
                title: format!("{scope_label} dependency cycle ({} modules)", scc.len()),
                detail: scc.join(" <-> "),
                modules: scc.clone(),
                score: round1(base_score + (scc.len() as f64) * 4.0),
            });
        }
    }

    for inv in sdp_repo.iter().chain(sdp_intra.iter()).take(20) {
        let severity = if inv.delta >= 0.50 && (inv.edge_count >= 2 || inv.scope == "repo") {
            FindingSeverity::High
        } else if inv.delta >= 0.30 {
            FindingSeverity::Medium
        } else {
            FindingSeverity::Low
        };
        findings.push(ArchFinding {
            severity,
            kind: "sdp_inversion".to_owned(),
            title: format!("SDP inversion [{}]: {} -> {}", inv.scope, inv.from, inv.to),
            detail: format!(
                "Stable {} (I={:.2}) depends on less-stable {} (I={:.2}, delta={:.2}, edges={})",
                inv.from, inv.from_instability, inv.to, inv.to_instability, inv.delta, inv.edge_count
            ),
            modules: vec![inv.from.clone(), inv.to.clone()],
            score: round1(inv.delta * 80.0 + (inv.edge_count as f64).min(10.0)),
        });
    }

    for m in modules {
        match m.zone {
            ArchZone::Pain => {
                let severity = if m.distance >= 0.70 && m.ca >= 3 {
                    FindingSeverity::High
                } else {
                    FindingSeverity::Medium
                };
                findings.push(ArchFinding {
                    severity,
                    kind: "zone_of_pain".to_owned(),
                    title: format!("Zone of Pain: {}", m.module),
                    detail: format!(
                        "Concrete & rigid (A={:.2}, I={:.2}, D={:.2}, Ca={}, Ce={})",
                        m.abstractness, m.instability, m.distance, m.ca, m.ce
                    ),
                    modules: vec![m.module.clone()],
                    score: round1(m.distance * 60.0 + (m.ca as f64).min(20.0)),
                });
            }
            ArchZone::Uselessness => {
                findings.push(ArchFinding {
                    severity: FindingSeverity::Low,
                    kind: "zone_of_uselessness".to_owned(),
                    title: format!("Zone of Uselessness: {}", m.module),
                    detail: format!(
                        "Abstract without dependents (A={:.2}, I={:.2}, D={:.2}, Ca={}, Ce={})",
                        m.abstractness, m.instability, m.distance, m.ca, m.ce
                    ),
                    modules: vec![m.module.clone()],
                    score: round1(m.distance * 40.0),
                });
            }
            ArchZone::Balanced => {}
        }
    }

    for mm in misplaced {
        let severity = if mm.cross_coupling >= mm.intra_coupling * 2 && mm.cross_coupling >= 5 {
            FindingSeverity::High
        } else {
            FindingSeverity::Medium
        };
        findings.push(ArchFinding {
            severity,
            kind: "misplaced_module".to_owned(),
            title: format!("Misplaced gravity: {}", mm.module),
            detail: format!(
                "Cross-crate coupling {} exceeds intra-crate {} (top target `{}`={})",
                mm.cross_coupling, mm.intra_coupling, mm.top_external_crate, mm.top_external_coupling
            ),
            modules: vec![mm.module.clone()],
            score: round1(mm.gravity_ratio * 60.0 + (mm.cross_coupling as f64).min(30.0)),
        });
    }

    for br in blast_radius.iter().take(5) {
        if br.impacted_pct >= 25.0 {
            let severity = if br.impacted_pct >= 50.0 {
                FindingSeverity::Medium
            } else {
                FindingSeverity::Low
            };
            findings.push(ArchFinding {
                severity,
                kind: "blast_radius".to_owned(),
                title: format!("Wide blast radius: {} ({:.1}%)", br.module, br.impacted_pct),
                detail: format!(
                    "Changing {} transitively impacts {}/{} modules ({} direct dependents)",
                    br.module, br.impacted_count, br.total_modules, br.direct_dependents
                ),
                modules: vec![br.module.clone()],
                score: round1(br.impacted_pct * 0.7),
            });
        }
    }

    for cc in co_change.pairs.iter().take(10) {
        if cc.co_changes >= 2 && cc.jaccard >= 0.30 {
            let severity = if !cc.has_static_edge && cc.jaccard >= 0.50 {
                FindingSeverity::Medium
            } else {
                FindingSeverity::Low
            };
            let edge_note = if cc.has_static_edge {
                "static edge exists"
            } else {
                "NO static edge (hidden coupling)"
            };
            findings.push(ArchFinding {
                severity,
                kind: "temporal_co_change".to_owned(),
                title: format!("Temporal coupling: {} <-> {}", cc.module_a, cc.module_b),
                detail: format!("Co-changed {}x (Jaccard={:.2}, {edge_note})", cc.co_changes, cc.jaccard),
                modules: vec![cc.module_a.clone(), cc.module_b.clone()],
                score: round1(cc.jaccard * 50.0 + (cc.co_changes as f64) * 2.0),
            });
        }
    }

    findings.sort_by(|a, b| {
        a.severity
            .cmp(&b.severity)
            .then_with(|| b.score.total_cmp(&a.score))
            .then_with(|| a.kind.cmp(&b.kind))
            .then_with(|| a.title.cmp(&b.title))
    });
    findings
}

pub fn analyze_architecture(root: &Path, policy: &Policy, ir: &TopologyIr, opts: &ArchOptions) -> ArchReport {
    let crate_filter = normalize_scope_filter(opts.scope.as_deref(), &ir.prefix);

    let crate_graph = build_scoped_graph(ir, 1, crate_filter.as_deref());
    let mod2_graph = build_scoped_graph(ir, 2, crate_filter.as_deref());
    let mod3_graph = build_scoped_graph(ir, 3, crate_filter.as_deref());

    let type_counts = collect_mod2_type_counts(ir, &mod2_graph.nodes);
    let modules = compute_iad_for_graph(&mod2_graph, &type_counts);
    let i_map: BTreeMap<String, f64> = modules.iter().map(|m| (m.module.clone(), m.instability)).collect();

    let sdp_inversions_repo = if crate_filter.is_some() {
        Vec::new()
    } else {
        find_sdp_inversions(&mod2_graph, &i_map, "repo", opts.min_delta)
    };
    let sdp_inversions_intra = compute_intra_crate_sdp(ir, crate_filter.as_deref(), opts.min_delta);

    let cycles = CyclesReport {
        crate_scope: analyze_scope_cycles(&crate_graph, "crate"),
        mod2_scope: analyze_scope_cycles(&mod2_graph, "mod2"),
        mod3_scope: analyze_scope_cycles(&mod3_graph, "mod3"),
    };

    let misplaced = compute_misplaced_modules(ir, &mod2_graph.nodes, crate_filter.as_deref());
    let blast_radius = compute_blast_radius(&mod2_graph);
    let co_change = compute_co_change(root, policy, ir, &mod2_graph, crate_filter.as_deref(), opts);
    let findings = build_ranked_findings(
        &modules,
        &sdp_inversions_repo,
        &sdp_inversions_intra,
        &cycles,
        &misplaced,
        &blast_radius,
        &co_change,
    );

    let zone_of_pain_count = modules.iter().filter(|m| m.zone == ArchZone::Pain).count();
    let zone_of_uselessness_count = modules.iter().filter(|m| m.zone == ArchZone::Uselessness).count();

    let summary = ArchSummary {
        total_modules: modules.len(),
        total_edges: mod2_graph.edges.len(),
        sdp_repo_inversions: sdp_inversions_repo.len(),
        sdp_intra_inversions: sdp_inversions_intra.len(),
        zone_of_pain_count,
        zone_of_uselessness_count,
        crate_cycles: cycles.crate_scope.sccs.len(),
        mod2_cycles: cycles.mod2_scope.sccs.len(),
        mod3_cycles: cycles.mod3_scope.sccs.len(),
        misplaced_modules: misplaced.len(),
        co_change_pairs: co_change.pairs.len(),
        finding_count: findings.len(),
    };

    ArchReport {
        version: 1,
        config: ArchOptions {
            scope: crate_filter,
            min_delta: opts.min_delta,
            git_commits: opts.git_commits,
            no_git: opts.no_git,
        },
        summary,
        modules,
        sdp_inversions_repo,
        sdp_inversions_intra,
        cycles,
        misplaced,
        blast_radius,
        co_change,
        findings,
    }
}

fn print_human_report(report: &ArchReport) {
    let s = &report.summary;
    println!(
        "Architecture Lenses (scope: {}, min-delta: {:.2}, git-commits: {})",
        report.config.scope.as_deref().unwrap_or("repo"),
        report.config.min_delta,
        if report.config.no_git { 0 } else { report.config.git_commits }
    );
    println!(
        "Summary: {} mod2 modules, {} mod2 edges | SDP repo={} intra={} | Pain={} Useless={} | SCC crate={} mod2={} mod3={} | Misplaced={} | Co-change={}",
        s.total_modules,
        s.total_edges,
        s.sdp_repo_inversions,
        s.sdp_intra_inversions,
        s.zone_of_pain_count,
        s.zone_of_uselessness_count,
        s.crate_cycles,
        s.mod2_cycles,
        s.mod3_cycles,
        s.misplaced_modules,
        s.co_change_pairs
    );

    println!("\n[1] Zone of Pain / Uselessness (top 15 by D):");
    let zone_offenders: Vec<&ModuleIad> = report.modules.iter().filter(|m| m.zone != ArchZone::Balanced).take(15).collect();
    if zone_offenders.is_empty() {
        println!("  (none)");
    } else {
        println!("  {:<38} {:<11} {:>4} {:>4} {:>5} {:>5} {:>5}", "Module", "Zone", "Ca", "Ce", "I", "A", "D");
        for m in zone_offenders {
            println!(
                "  {:<38} {:<11} {:>4} {:>4} {:>5.2} {:>5.2} {:>5.2}",
                m.module,
                m.zone.as_str(),
                m.ca,
                m.ce,
                m.instability,
                m.abstractness,
                m.distance
            );
        }
    }

    println!("\n[1b] SDP Inversions (I_from < I_to, top 15):");
    let all_sdp: Vec<&SdpInversion> = report.sdp_inversions_repo.iter().chain(report.sdp_inversions_intra.iter()).take(15).collect();
    if all_sdp.is_empty() {
        println!("  (none)");
    } else {
        for inv in all_sdp {
            println!(
                "  [{:<8}] {} ({:.2}) -> {} ({:.2})  delta=+{:.2} ({} edges)",
                inv.scope, inv.from, inv.from_instability, inv.to, inv.to_instability, inv.delta, inv.edge_count
            );
        }
    }

    println!("\n[2] Dependency Cycles (SCCs & DSM Feedback Arcs):");
    for scope in [&report.cycles.crate_scope, &report.cycles.mod2_scope, &report.cycles.mod3_scope] {
        println!(
            "  {:<5}: {} nodes, {} edges, {} SCCs, {} mutual 2-cycles, {} feedback arcs",
            scope.scope,
            scope.node_count,
            scope.edge_count,
            scope.sccs.len(),
            scope.mutual_cycles.len(),
            scope.feedback_arcs.len()
        );
        for scc in scope.sccs.iter().take(5) {
            println!("    SCC ({}): {}", scc.len(), scc.join(" <-> "));
        }
    }

    println!("\n[3] Misplaced Modules (cross-crate > intra-crate, excl. protocol):");
    if report.misplaced.is_empty() {
        println!("  (none)");
    } else {
        for m in report.misplaced.iter().take(15) {
            println!(
                "  {:<38} intra={} cross={} (ratio={:.2}, top={}:{})",
                m.module, m.intra_coupling, m.cross_coupling, m.gravity_ratio, m.top_external_crate, m.top_external_coupling
            );
        }
    }

    println!("\n[4] Transitive Blast Radius (top 10):");
    for br in report.blast_radius.iter().take(10) {
        println!(
            "  {:<38} {:>3}/{} ({:>5.1}%)  direct={}",
            br.module, br.impacted_count, br.total_modules, br.impacted_pct, br.direct_dependents
        );
    }

    println!(
        "\n[5] Temporal Co-Change Coupling (commits={}, mapped={}, skipped>{}={}):",
        report.co_change.commits_scanned, report.co_change.commits_mapped, MAX_MODULES_PER_COMMIT, report.co_change.skipped_mechanical_commits
    );
    if !report.co_change.enabled {
        println!("  (disabled via --no-git)");
    } else if report.co_change.pairs.is_empty() {
        println!("  (no qualifying pairs)");
    } else {
        for p in report.co_change.pairs.iter().take(15) {
            let tag = if p.has_static_edge { "static" } else { "hidden" };
            println!("  {:>2}x  J={:.2}  [{tag}]  {} <-> {}", p.co_changes, p.jaccard, p.module_a, p.module_b);
        }
    }
}

pub fn parse_arch_args(args: &[String]) -> Result<(ArchOptions, bool), String> {
    let mut opts = ArchOptions::default();
    let mut json = false;
    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "--json" => {
                json = true;
                i += 1;
            }
            "--no-git" => {
                opts.no_git = true;
                i += 1;
            }
            "--scope" => {
                let raw = args.get(i + 1).ok_or_else(|| "--scope requires a crate name".to_owned())?;
                opts.scope = Some(raw.clone());
                i += 2;
            }
            "--min-delta" => {
                let raw = args.get(i + 1).ok_or_else(|| "--min-delta requires a float value".to_owned())?;
                let val: f64 = raw.parse().map_err(|err| format!("invalid --min-delta `{raw}`: {err}"))?;
                if !(0.0..=1.0).contains(&val) {
                    return Err(format!("--min-delta `{raw}` must be between 0.0 and 1.0"));
                }
                opts.min_delta = val;
                i += 2;
            }
            "--git-commits" => {
                let raw = args.get(i + 1).ok_or_else(|| "--git-commits requires an integer".to_owned())?;
                let val: usize = raw.parse().map_err(|err| format!("invalid --git-commits `{raw}`: {err}"))?;
                opts.git_commits = val;
                i += 2;
            }
            other => {
                return Err(format!(
                    "unknown option `{other}` (expected --json, --scope <crate>, --min-delta <f64>, --git-commits <N>, --no-git)"
                ));
            }
        }
    }
    Ok((opts, json))
}

pub fn run(root: &Path, args: &[String]) -> Result<i32, String> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("Usage: cargo xtask uml arch [--json] [--scope <crate>] [--min-delta 0.15] [--git-commits 200] [--no-git]");
        return Ok(0);
    }
    let (opts, json) = parse_arch_args(args)?;
    let policy = super::load_or_init_policy(root)?;
    let ir = super::build_topology(root, &policy, &[])?;
    let report = analyze_architecture(root, &policy, &ir, &opts);
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&report).map_err(|err| format!("failed to serialize arch report: {err}"))?
        );
    } else {
        print_human_report(&report);
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::qa::uml::{EdgeKind, SourceSpec, build_topology};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("xtask-arch-{tag}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_file(root: &Path, rel: &str, body: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    fn make_multi_crate_policy(crates: &[&str]) -> Policy {
        let mut sources = Vec::new();
        let mut order = Vec::new();
        for &c in crates {
            sources.push(SourceSpec {
                lang: Lang::Rust,
                root: format!("crates/{c}"),
                prefix: Some(format!("vibevalley.{c}")),
            });
            order.push(c.to_owned());
        }
        Policy {
            title: "Test".to_owned(),
            prefix: "vibevalley".to_owned(),
            hierarchical: true,
            sources,
            foreign: Vec::new(),
            order,
            levels: Vec::new(),
            omit: Vec::new(),
            edge_kinds: BTreeMap::new(),
            proposals: Vec::new(),
        }
    }

    #[test]
    fn iad_zone_of_pain_and_sdp_inversion_detection() {
        let dir = temp_dir("iad-sdp");
        // Stable concrete module `app.concrete_util` (ca=3, ce=0 => I=0.0, A=0.0, D=1.0 -> Pain!)
        // Wait: make it ALSO depend on `app.unstable_leaf` (ce=1, ca=3 => I=0.25) so we test SDP inversion too!
        write_file(&dir, "crates/core/src/stable_core/mod.rs", "pub struct CoreA {}\npub struct CoreB {}\n");
        write_file(
            &dir,
            "crates/core/src/mid/mod.rs",
            "use crate::stable_core;\nuse crate::volatile;\npub struct Mid {}\n",
        );
        write_file(
            &dir,
            "crates/core/src/volatile/mod.rs",
            "use crate::leaf_a;\nuse crate::leaf_b;\npub struct Vol {}\n",
        );
        write_file(&dir, "crates/core/src/leaf_a/mod.rs", "pub trait Port { fn go(&self); }\n");
        write_file(&dir, "crates/core/src/leaf_b/mod.rs", "pub struct B {}\n");
        write_file(
            &dir,
            "crates/core/src/consumer1/mod.rs",
            "use crate::stable_core;\nuse crate::mid;\npub struct C1 {}\n",
        );
        write_file(
            &dir,
            "crates/core/src/consumer2/mod.rs",
            "use crate::stable_core;\nuse crate::mid;\npub struct C2 {}\n",
        );
        write_file(&dir, "crates/core/src/consumer3/mod.rs", "use crate::stable_core;\npub struct C3 {}\n");

        let policy = make_multi_crate_policy(&["core"]);
        let ir = build_topology(&dir, &policy, &[]).unwrap();
        let report = analyze_architecture(
            &dir,
            &policy,
            &ir,
            &ArchOptions {
                no_git: true,
                ..ArchOptions::default()
            },
        );

        let stable = report.modules.iter().find(|m| m.module == "vibevalley.core.stable_core").unwrap();
        assert_eq!(stable.ca, 4);
        assert_eq!(stable.ce, 0);
        assert_eq!(stable.instability, 0.0);
        assert_eq!(stable.abstractness, 0.0);
        assert_eq!(stable.distance, 1.0);
        assert_eq!(stable.zone, ArchZone::Pain);

        let leaf_a = report.modules.iter().find(|m| m.module == "vibevalley.core.leaf_a").unwrap();
        assert_eq!(leaf_a.abstract_types, 1);
        assert_eq!(leaf_a.total_types, 1);
        assert_eq!(leaf_a.abstractness, 1.0);

        // `mid` has ca=2 (consumer1, consumer2), ce=2 (stable_core, volatile) => I=0.50
        // `volatile` has ca=1 (mid), ce=2 (leaf_a, leaf_b) => I=0.667
        // mid -> volatile has delta = 0.667 - 0.50 = 0.167 >= 0.15 => SDP inversion!
        assert!(
            report
                .sdp_inversions_repo
                .iter()
                .any(|inv| inv.from == "vibevalley.core.mid" && inv.to == "vibevalley.core.volatile" && inv.delta >= 0.15),
            "expected SDP inversion mid -> volatile, got {:?}",
            report.sdp_inversions_repo
        );
        assert!(
            report
                .sdp_inversions_intra
                .iter()
                .any(|inv| inv.scope == "core" && inv.from == "vibevalley.core.mid" && inv.to == "vibevalley.core.volatile"),
            "expected intra-crate SDP inversion"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tarjan_scc_and_dsm_feedback_arcs() {
        let dir = temp_dir("tarjan-dsm");
        write_file(&dir, "crates/server/src/a/mod.rs", "use crate::b;\npub struct A {}\n");
        write_file(&dir, "crates/server/src/b/mod.rs", "use crate::c;\npub struct B {}\n");
        write_file(&dir, "crates/server/src/c/mod.rs", "use crate::a;\nuse crate::clean_leaf;\npub struct C {}\n");
        write_file(&dir, "crates/server/src/clean_leaf/mod.rs", "pub struct Leaf {}\n");

        let policy = make_multi_crate_policy(&["server"]);
        let ir = build_topology(&dir, &policy, &[]).unwrap();
        let report = analyze_architecture(
            &dir,
            &policy,
            &ir,
            &ArchOptions {
                no_git: true,
                ..ArchOptions::default()
            },
        );

        assert_eq!(report.cycles.mod2_scope.sccs.len(), 1);
        assert_eq!(
            report.cycles.mod2_scope.sccs[0],
            vec!["vibevalley.server.a", "vibevalley.server.b", "vibevalley.server.c"]
        );
        assert!(!report.cycles.mod2_scope.feedback_arcs.is_empty());

        // `clean_leaf` has no dependencies and is depended on by `c`, so in provider-first DSM order it precedes the cycle.
        let pos_leaf = report
            .cycles
            .mod2_scope
            .dsm_order
            .iter()
            .position(|m| m == "vibevalley.server.clean_leaf")
            .unwrap();
        let pos_c = report.cycles.mod2_scope.dsm_order.iter().position(|m| m == "vibevalley.server.c").unwrap();
        assert!(pos_leaf < pos_c, "provider clean_leaf must precede consumer c in DSM order");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn detects_misplaced_modules_excluding_protocol_and_blast_radius() {
        let dir = temp_dir("gravity-blast");
        write_file(&dir, "crates/protocol/src/wire/mod.rs", "pub struct WireMsg {}\n");
        write_file(
            &dir,
            "crates/core/src/shared/mod.rs",
            "use vibevalley_protocol::wire::WireMsg;\npub struct Shared {}\n",
        );
        // `server.helper` depends heavily on `runtime.engine` and `runtime.pool` (cross=2 > intra=0), plus `protocol` (excluded).
        write_file(
            &dir,
            "crates/runtime/src/engine/mod.rs",
            "use vibevalley_core::shared::Shared;\npub struct Engine {}\n",
        );
        write_file(
            &dir,
            "crates/runtime/src/pool/mod.rs",
            "use vibevalley_core::shared::Shared;\npub struct Pool {}\n",
        );
        write_file(
            &dir,
            "crates/server/src/helper/mod.rs",
            "use vibevalley_protocol::wire::WireMsg;\nuse vibevalley_runtime::engine::Engine;\nuse vibevalley_runtime::pool::Pool;\npub struct Helper {}\n",
        );
        write_file(&dir, "crates/server/src/api/mod.rs", "use crate::helper::Helper;\npub struct Api {}\n");

        let policy = make_multi_crate_policy(&["protocol", "core", "runtime", "server"]);
        let ir = build_topology(&dir, &policy, &[]).unwrap();
        let report = analyze_architecture(
            &dir,
            &policy,
            &ir,
            &ArchOptions {
                no_git: true,
                ..ArchOptions::default()
            },
        );

        // `server.helper` has cross_coupling=2 (runtime.engine, runtime.pool) > intra_coupling=1 (server.api) -> misplaced!
        let helper_misplaced = report.misplaced.iter().find(|m| m.module == "vibevalley.server.helper");
        assert!(
            helper_misplaced.is_some(),
            "expected server.helper to be flagged as misplaced: {:?}",
            report.misplaced
        );
        let hm = helper_misplaced.unwrap();
        assert_eq!(hm.top_external_crate, "runtime");
        assert!(hm.cross_coupling > hm.intra_coupling);
        // `protocol` must never be flagged as misplaced
        assert!(!report.misplaced.iter().any(|m| m.crate_name == "protocol"));

        // Blast radius of `core.shared`: runtime.engine, runtime.pool -> server.helper -> server.api (4 modules!)
        let shared_br = report.blast_radius.iter().find(|b| b.module == "vibevalley.core.shared").unwrap();
        assert_eq!(shared_br.impacted_count, 4);
        assert!(shared_br.impacted_pct > 50.0);

        // Verify JSON schema serialization includes ranked findings and all 5 lenses.
        let json_val = serde_json::to_value(&report).unwrap();
        assert!(json_val["summary"].is_object());
        assert!(json_val["modules"].is_array());
        assert!(json_val["sdp_inversions_repo"].is_array());
        assert!(json_val["sdp_inversions_intra"].is_array());
        assert!(json_val["cycles"]["crate_scope"].is_object());
        assert!(json_val["cycles"]["mod2_scope"].is_object());
        assert!(json_val["cycles"]["mod3_scope"].is_object());
        assert!(json_val["misplaced"].is_array());
        assert!(json_val["blast_radius"].is_array());
        assert!(json_val["co_change"].is_object());
        assert!(json_val["findings"].is_array());
        assert!(!json_val["findings"].as_array().unwrap().is_empty());
        let first_finding = &json_val["findings"][0];
        assert!(first_finding.get("severity").is_some());
        assert!(first_finding.get("kind").is_some());
        assert!(first_finding.get("title").is_some());
        assert!(first_finding.get("detail").is_some());
        assert!(first_finding.get("modules").is_some());
        assert!(first_finding.get("score").is_some());

        // Ensure EdgeKind import is referenced without unused warning in test cfg
        let _ = EdgeKind::Dependency;
        let _ = fs::remove_dir_all(&dir);
    }
}
