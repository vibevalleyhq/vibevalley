//! Cross-layer tracer (`cargo xtask trace`) across the 6 protocol-to-client layers.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::rust_scan::{
    LineIndex, is_excluded_by_cfg_test, is_ident_char, is_ident_start, strip_cfg_test_and_collect_excluded, strip_rust_comments_and_literals,
    strip_rust_non_code, walk_matching_files,
};

const USAGE: &str = "\
Usage:
  cargo xtask trace op <name> [--layer <name>] [--json]
  cargo xtask trace slice <name> [--layer <name>] [--json]
  cargo xtask trace orphans [--json]
  cargo xtask trace <query> [--layer <name>] [--json]

Layers (--layer):
  1 | contract   crates/protocol/src/contract/
  2 | ts         packages/protocol/src/
  3 | gateway    crates/server/src/gateway/{http,bridge}/ & router.rs
  4 | server     crates/server/src/
  5 | core       crates/core/src/
  6 | client     apps/mac/ui/, apps/mobile/src/, crates/cli/src/";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Layer {
    Contract,
    Ts,
    Gateway,
    Server,
    Core,
    Client,
}

impl Layer {
    fn from_arg(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "1" | "contract" | "protocol" | "protocol-rust" => Some(Self::Contract),
            "2" | "ts" | "protocol-ts" | "packages" => Some(Self::Ts),
            "3" | "gateway" | "router" => Some(Self::Gateway),
            "4" | "server" | "service" | "services" => Some(Self::Server),
            "5" | "core" | "reducer" | "reducers" => Some(Self::Core),
            "6" | "client" | "clients" | "ui" | "cli" => Some(Self::Client),
            _ => None,
        }
    }

    fn allows(filter: Option<Self>, target: Self) -> bool {
        filter.is_none_or(|f| f == target)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Command {
    Op { query: String, layer: Option<Layer>, json: bool },
    Slice { query: String, layer: Option<Layer>, json: bool },
    Orphans { json: bool },
    Auto { query: String, layer: Option<Layer>, json: bool },
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct Loc {
    pub file: String,
    pub line: usize,
    pub symbol: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl Loc {
    fn new(file: impl Into<String>, line: usize, symbol: impl Into<String>, detail: Option<String>) -> Self {
        Self {
            file: file.into(),
            line,
            symbol: symbol.into(),
            detail,
        }
    }

    fn format_human(&self) -> String {
        match &self.detail {
            Some(d) if !d.is_empty() => format!("{}:{} ({} — {d})", self.file, self.line, self.symbol),
            _ => format!("{}:{} ({})", self.file, self.line, self.symbol),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ContractEndpoint {
    pub op: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    pub module: String,
    pub native: bool,
    pub about: Vec<String>,
    pub can: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    pub loc: Loc,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id_loc: Option<Loc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ContractSubscription {
    pub name: String,
    pub module: String,
    pub can: Vec<String>,
    pub payload: String,
    pub event: String,
    pub loc: Loc,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ContractSlice {
    name: String,
    variant: String,
    locs: Vec<Loc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TsGenEndpoint {
    can: Vec<String>,
    dry_run: Option<String>,
    loc: Loc,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TsApiEntry {
    kind: &'static str,
    input: Option<String>,
    result: Option<String>,
    can: Vec<String>,
    loc: Loc,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RouterArm {
    target_expr: String,
    loc: Loc,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ServerFn {
    name: String,
    impl_type: Option<String>,
    module_key: String,
    file: String,
    line: usize,
    body_calls: Vec<String>,
    core_calls: Vec<String>,
    dirty_slices: Vec<String>,
    outbox_events: Vec<String>,
    facts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ServerEmitter {
    loc: Loc,
    kind: &'static str,
    slices: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CoreReducer {
    fact_variant: String,
    slices: Vec<String>,
    loc: Loc,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct ClientCall {
    pub client: String,
    pub via: String,
    pub file: String,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl ClientCall {
    fn to_loc(&self) -> Loc {
        Loc::new(&self.file, self.line, format!("[{}] {}", self.client, self.via), self.detail.clone())
    }
}

#[derive(Debug, Default)]
struct Index {
    endpoints: Vec<ContractEndpoint>,
    op_to_idx: BTreeMap<String, usize>,
    variant_to_op: BTreeMap<String, String>,
    subscriptions: Vec<ContractSubscription>,
    sub_to_idx: BTreeMap<String, usize>,
    slices: BTreeMap<String, ContractSlice>,
    facts: BTreeMap<String, Loc>,

    ts_gen_endpoints: BTreeMap<String, TsGenEndpoint>,
    ts_gen_subscriptions: BTreeMap<String, Loc>,
    ts_api_entries: BTreeMap<String, Vec<TsApiEntry>>,
    ts_api_subscriptions: BTreeMap<String, Loc>,
    ts_client_calls: BTreeMap<String, Vec<Loc>>,
    ts_slices: BTreeMap<String, Vec<Loc>>,

    router_aliases: BTreeMap<String, String>,
    router_arms: BTreeMap<String, RouterArm>,
    router_meta: BTreeMap<String, Loc>,
    http_routes: Vec<(String, Loc)>,
    bridge_handlers: Vec<(String, Loc)>,

    server_fns: Vec<ServerFn>,
    server_emitters: Vec<ServerEmitter>,
    server_slice_projections: BTreeMap<String, Vec<Loc>>,
    server_subs: BTreeMap<String, Vec<Loc>>,

    core_reducers: Vec<CoreReducer>,
    core_slice_projections: BTreeMap<String, Vec<Loc>>,
    core_pub_fns: BTreeMap<String, Vec<Loc>>,

    client_ops: BTreeMap<String, Vec<ClientCall>>,
    client_subs: BTreeMap<String, Vec<ClientCall>>,
    client_slices: BTreeMap<String, Vec<ClientCall>>,
}

#[derive(Debug, Serialize)]
struct OpTraceReport {
    kind: &'static str,
    query: String,
    resolved_op: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    variant: Option<String>,
    module: String,
    native: bool,
    can: Vec<String>,
    about: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dry_run: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    input: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<String>,
    layers: OpLayers,
}

#[derive(Debug, Default, Serialize)]
struct OpLayers {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    contract: Vec<Loc>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    ts: Vec<Loc>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    gateway: Vec<Loc>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    server: Vec<Loc>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    core: Vec<Loc>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    clients: Vec<ClientCall>,
}

#[derive(Debug, Serialize)]
struct SliceTraceReport {
    kind: &'static str,
    slice: String,
    variant: String,
    layers: SliceLayers,
}

#[derive(Debug, Default, Serialize)]
struct SliceLayers {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    contract: Vec<Loc>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    ts: Vec<Loc>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    gateway: Vec<Loc>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    server: Vec<Loc>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    core: Vec<Loc>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    clients: Vec<ClientCall>,
}

#[derive(Debug, Serialize)]
struct OrphanEndpoint {
    op: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    variant: Option<String>,
    module: String,
    native: bool,
    can: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dry_run_of: Option<String>,
    file: String,
    line: usize,
}

#[derive(Debug, Serialize)]
struct SingleClientGap {
    op: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    variant: Option<String>,
    module: String,
    can: Vec<String>,
    present_in: String,
    missing_from: Vec<String>,
    callers: Vec<ClientCall>,
}

#[derive(Debug, Serialize)]
struct OrphansSummary {
    total_endpoints: usize,
    zero_caller_orphans: usize,
    single_client_gaps: usize,
    multi_client_covered: usize,
}

#[derive(Debug, Serialize)]
struct OrphansReport {
    kind: &'static str,
    summary: OrphansSummary,
    orphans: Vec<OrphanEndpoint>,
    single_client_gaps: Vec<SingleClientGap>,
}

/// Entry point for `cargo xtask trace`.
pub fn run(root: &Path, args: &[String]) -> Result<i32, String> {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{USAGE}");
        return Ok(0);
    }

    let cmd = match parse_args(args) {
        Ok(cmd) => cmd,
        Err(msg) => {
            eprintln!("xtask trace: {msg}\n\n{USAGE}");
            return Ok(2);
        }
    };

    let index = Index::build(root)?;
    match cmd {
        Command::Op { query, layer, json } => run_op(&index, &query, layer, json),
        Command::Slice { query, layer, json } => run_slice(&index, &query, layer, json),
        Command::Orphans { json } => run_orphans(&index, json),
        Command::Auto { query, layer, json } => {
            let norm = query.trim().to_ascii_lowercase();
            if index.slices.contains_key(&norm) {
                run_slice(&index, &norm, layer, json)
            } else {
                run_op(&index, &query, layer, json)
            }
        }
    }
}

fn parse_args(args: &[String]) -> Result<Command, String> {
    let Some((first, rest)) = args.split_first() else {
        return Err("missing subcommand or query".to_owned());
    };

    let mut json = false;
    let mut layer: Option<Layer> = None;
    let mut positionals: Vec<String> = Vec::new();
    let mut idx = 0usize;
    let tail = match first.as_str() {
        "op" | "slice" | "orphans" => rest,
        _ => args,
    };

    while idx < tail.len() {
        let arg = &tail[idx];
        match arg.as_str() {
            "--json" => json = true,
            "--layer" => {
                idx += 1;
                let Some(val) = tail.get(idx) else {
                    return Err("missing value after --layer".to_owned());
                };
                layer = Some(Layer::from_arg(val).ok_or_else(|| format!("unknown layer `{val}`"))?);
            }
            other if other.starts_with("--layer=") => {
                let val = &other["--layer=".len()..];
                layer = Some(Layer::from_arg(val).ok_or_else(|| format!("unknown layer `{val}`"))?);
            }
            other if other.starts_with('-') => return Err(format!("unknown option `{other}`")),
            pos => positionals.push(pos.to_owned()),
        }
        idx += 1;
    }

    match first.as_str() {
        "op" => {
            if positionals.len() != 1 {
                return Err("`trace op` requires exactly one <name>".to_owned());
            }
            Ok(Command::Op {
                query: positionals.into_iter().next().unwrap_or_default(),
                layer,
                json,
            })
        }
        "slice" => {
            if positionals.len() != 1 {
                return Err("`trace slice` requires exactly one <name>".to_owned());
            }
            Ok(Command::Slice {
                query: positionals.into_iter().next().unwrap_or_default(),
                layer,
                json,
            })
        }
        "orphans" => {
            if !positionals.is_empty() || layer.is_some() {
                return Err("`trace orphans` takes only [--json]".to_owned());
            }
            Ok(Command::Orphans { json })
        }
        _ => {
            if positionals.len() != 1 {
                return Err("expected `<query>` or `op|slice|orphans`".to_owned());
            }
            Ok(Command::Auto {
                query: positionals.into_iter().next().unwrap_or_default(),
                layer,
                json,
            })
        }
    }
}

impl Index {
    fn build(root: &Path) -> Result<Self, String> {
        let mut idx = Self::default();
        idx.index_contract(root)?;
        idx.index_ts_protocol(root)?;
        idx.index_gateway_and_router(root)?;
        idx.index_server_services(root)?;
        idx.index_core(root)?;
        idx.index_clients(root)?;
        Ok(idx)
    }

    fn resolve_op(&self, query: &str) -> Option<String> {
        let trimmed = query.trim();
        if self.op_to_idx.contains_key(trimmed) {
            return Some(trimmed.to_owned());
        }
        if let Some(op) = self.variant_to_op.get(trimmed) {
            return Some(op.clone());
        }
        if let Some(stripped) = trimmed.strip_prefix("EndpointId::").or_else(|| trimmed.strip_prefix("E::"))
            && let Some(op) = self.variant_to_op.get(stripped)
        {
            return Some(op.clone());
        }
        let lower = trimmed.to_ascii_lowercase();
        for ep in &self.endpoints {
            if ep.op.to_ascii_lowercase() == lower {
                return Some(ep.op.clone());
            }
            if let Some(v) = &ep.variant
                && v.to_ascii_lowercase() == lower
            {
                return Some(ep.op.clone());
            }
        }
        if self.sub_to_idx.contains_key(trimmed) {
            return Some(trimmed.to_owned());
        }
        None
    }

    fn index_contract(&mut self, root: &Path) -> Result<(), String> {
        let endpoints_path = "crates/protocol/src/contract/endpoints.rs";
        if let Some(raw) = read_optional_file(root, endpoints_path)? {
            let clean = strip_rust_comments_keep_strings_non_test(&raw, endpoints_path);
            let lines = LineIndex::new(&raw);
            self.parse_endpoint_table(&clean, &lines, endpoints_path, "ENDPOINTS", false);
            self.parse_endpoint_ids_macro(&clean, &lines, endpoints_path);
            self.parse_subscriptions_table(&clean, &lines, endpoints_path);
        }

        let native_path = "crates/protocol/src/native.rs";
        if let Some(raw) = read_optional_file(root, native_path)? {
            let clean = strip_rust_comments_keep_strings_non_test(&raw, native_path);
            let lines = LineIndex::new(&raw);
            self.parse_endpoint_table(&clean, &lines, native_path, "NATIVE_ENDPOINTS", true);
            self.parse_native_endpoint_ids(&clean, &lines, native_path);
        }

        let core_path = "crates/protocol/src/contract/core.rs";
        if let Some(raw) = read_optional_file(root, core_path)? {
            let clean = strip_rust_comments_keep_strings_non_test(&raw, core_path);
            let lines = LineIndex::new(&raw);
            self.parse_slice_kinds(&clean, &lines, core_path);
            self.parse_fact_enum(&clean, &lines, core_path);
        }

        let game_path = "crates/protocol/src/contract/game.rs";
        if let Some(raw) = read_optional_file(root, game_path)? {
            let clean = strip_rust_comments_keep_strings_non_test(&raw, game_path);
            let lines = LineIndex::new(&raw);
            if let Some(pos) = clean.find("pub struct FarmFrame") {
                let line = lines.line_at(pos);
                self.record_slice_loc("farm", "Farm", Loc::new(game_path, line, "struct FarmFrame", None));
            }
        }
        Ok(())
    }

    fn parse_endpoint_table(&mut self, clean: &str, lines: &LineIndex, file: &str, const_name: &str, native: bool) {
        let Some((slice_start, region)) = find_const_array_region(clean, const_name) else {
            return;
        };

        let mut cursor = 0usize;
        while let Some(rel) = region[cursor..].find("Endpoint") {
            let pos = cursor + rel;
            let after_kw = region[pos + "Endpoint".len()..].trim_start();
            if !after_kw.starts_with('{') {
                cursor = pos + "Endpoint".len();
                continue;
            }
            let brace_offset = region[pos..].find('{').unwrap_or(0);
            let brace_abs = pos + brace_offset;
            let Some(block_end) = find_matching_delim(region, brace_abs, b'{', b'}') else {
                break;
            };
            let block = &region[brace_abs..=block_end];
            if let Some(op_rel) = find_field_string_pos(block, "op") {
                let op = extract_quoted_at(block, op_rel).unwrap_or_default();
                let abs_byte = slice_start + brace_abs + op_rel;
                let line = lines.line_at(abs_byte);
                let module = find_field_string(block, "module").unwrap_or_default();
                let about = find_field_string_list(block, "about");
                let can = find_caller_list(block, "can");
                let dry_run = find_field_some_string(block, "dry_run");
                let input = find_field_some_string(block, "input");
                let result = find_field_some_string(block, "result");
                let ep_idx = self.endpoints.len();
                self.op_to_idx.insert(op.clone(), ep_idx);
                self.endpoints.push(ContractEndpoint {
                    op: op.clone(),
                    variant: None,
                    module,
                    native,
                    about,
                    can,
                    dry_run,
                    input,
                    result,
                    loc: Loc::new(file, line, format!("{const_name} op: \"{op}\""), None),
                    id_loc: None,
                });
            }
            cursor = block_end + 1;
        }
    }

    fn parse_endpoint_ids_macro(&mut self, clean: &str, lines: &LineIndex, file: &str) {
        let mut search_from = 0usize;
        while let Some(rel) = clean[search_from..].find("endpoint_ids!") {
            let pos = search_from + rel;
            let after = &clean[pos + "endpoint_ids!".len()..];
            let trimmed = after.trim_start();
            if trimmed.starts_with('{') {
                let brace_pos = pos + "endpoint_ids!".len() + (after.len() - trimmed.len());
                if let Some(end) = find_matching_delim(clean, brace_pos, b'{', b'}') {
                    let body = &clean[brace_pos + 1..end];
                    let base = brace_pos + 1;
                    self.parse_arrow_pairs(body, base, lines, file, "endpoint_ids!");
                }
                break;
            }
            search_from = pos + "endpoint_ids!".len();
        }
    }

    fn parse_native_endpoint_ids(&mut self, clean: &str, lines: &LineIndex, file: &str) {
        let Some(pos) = clean.find("impl NativeEndpointId") else { return };
        let Some(open) = clean[pos..].find('{').map(|o| pos + o) else { return };
        let Some(end) = find_matching_delim(clean, open, b'{', b'}') else { return };
        let body = &clean[open + 1..end];
        let Some(from_op_pos) = body.find("fn from_op") else { return };
        let Some(fn_open) = body[from_op_pos..].find('{').map(|o| from_op_pos + o) else {
            return;
        };
        let Some(fn_end) = find_matching_delim(body, fn_open, b'{', b'}') else {
            return;
        };
        let fn_body = &body[fn_open + 1..fn_end];
        let base = open + 1 + fn_open + 1;

        let mut cursor = 0usize;
        while let Some(q) = fn_body[cursor..].find('"') {
            let q_pos = cursor + q;
            let Some(op) = extract_quoted_at(fn_body, q_pos) else {
                cursor = q_pos + 1;
                continue;
            };
            let after = &fn_body[q_pos + op.len() + 2..];
            if let Some(arrow) = after.find("=>")
                && let Some(some_pos) = after[arrow..].find("Self::")
            {
                let v_start = arrow + some_pos + "Self::".len();
                let variant = read_ident(&after[v_start..]);
                if !variant.is_empty() && self.op_to_idx.contains_key(&op) {
                    let line = lines.line_at(base + q_pos);
                    self.attach_variant(&op, variant, Loc::new(file, line, format!("NativeEndpointId::{variant} => \"{op}\""), None));
                }
            }
            cursor = q_pos + op.len() + 2;
        }
    }

    fn parse_arrow_pairs(&mut self, body: &str, base_offset: usize, lines: &LineIndex, file: &str, macro_name: &str) {
        let bytes = body.as_bytes();
        let mut i = 0usize;
        while i < bytes.len() {
            if is_ident_start(bytes[i]) {
                let start = i;
                while i < bytes.len() && is_ident_char(bytes[i]) {
                    i += 1;
                }
                let variant = &body[start..i];
                let rest = body[i..].trim_start();
                if let Some(after_arrow) = rest.strip_prefix("=>") {
                    let after_trim = after_arrow.trim_start();
                    if after_trim.starts_with('"')
                        && let Some(op) = extract_quoted_at(after_trim, 0)
                    {
                        let line = lines.line_at(base_offset + start);
                        self.attach_variant(
                            variant_or_op_key(&op),
                            variant,
                            Loc::new(file, line, format!("{macro_name} {variant} => \"{op}\""), None),
                        );
                        let consumed = body[i..].len() - after_trim.len() + op.len() + 2;
                        i += consumed;
                        continue;
                    }
                }
            } else {
                i += 1;
            }
        }
    }

    fn attach_variant(&mut self, op: &str, variant: &str, loc: Loc) {
        self.variant_to_op.insert(variant.to_owned(), op.to_owned());
        if let Some(&idx) = self.op_to_idx.get(op) {
            self.endpoints[idx].variant = Some(variant.to_owned());
            self.endpoints[idx].id_loc = Some(loc);
        }
    }

    fn parse_subscriptions_table(&mut self, clean: &str, lines: &LineIndex, file: &str) {
        let Some((slice_start, region)) = find_const_array_region(clean, "SUBSCRIPTIONS") else {
            return;
        };

        let mut cursor = 0usize;
        while let Some(rel) = region[cursor..].find("SubscriptionSpec") {
            let pos = cursor + rel;
            let Some(brace_off) = region[pos..].find('{') else { break };
            let brace_abs = pos + brace_off;
            let Some(block_end) = find_matching_delim(region, brace_abs, b'{', b'}') else {
                break;
            };
            let block = &region[brace_abs..=block_end];
            if let Some(name_rel) = find_field_string_pos(block, "name") {
                let name = extract_quoted_at(block, name_rel).unwrap_or_default();
                let line = lines.line_at(slice_start + brace_abs + name_rel);
                let module = find_field_string(block, "module").unwrap_or_default();
                let can = find_caller_list(block, "can");
                let payload = find_field_string(block, "payload").unwrap_or_default();
                let event = find_field_string(block, "event").unwrap_or_default();
                let idx = self.subscriptions.len();
                self.sub_to_idx.insert(name.clone(), idx);
                self.subscriptions.push(ContractSubscription {
                    name: name.clone(),
                    module,
                    can,
                    payload,
                    event,
                    loc: Loc::new(file, line, format!("SUBSCRIPTIONS name: \"{name}\""), None),
                });
            }
            cursor = block_end + 1;
        }
    }

    fn record_slice_loc(&mut self, slice_name: &str, variant: &str, loc: Loc) {
        let entry = self.slices.entry(slice_name.to_owned()).or_insert_with(|| ContractSlice {
            name: slice_name.to_owned(),
            variant: variant.to_owned(),
            locs: Vec::new(),
        });
        if !entry.locs.contains(&loc) {
            entry.locs.push(loc);
        }
    }

    fn parse_slice_kinds(&mut self, clean: &str, lines: &LineIndex, file: &str) {
        if let Some(pos) = clean.find("pub enum SliceKind")
            && let Some(open) = clean[pos..].find('{').map(|o| pos + o)
            && let Some(end) = find_matching_delim(clean, open, b'{', b'}')
        {
            let body = &clean[open + 1..end];
            for item in body.split(',') {
                let ident = read_ident(item.trim());
                if !ident.is_empty()
                    && let Some(rel) = body.find(ident)
                {
                    let name = ident.to_ascii_lowercase();
                    let line = lines.line_at(open + 1 + rel);
                    self.record_slice_loc(&name, ident, Loc::new(file, line, format!("SliceKind::{ident}"), None));
                }
            }
        }

        for slice_struct in ["BoardSlice", "SessionsSlice", "CollabSlice", "InboxSlice", "OpsSlice"] {
            let needle = format!("pub struct {slice_struct}");
            if let Some(pos) = clean.find(&needle) {
                let line = lines.line_at(pos);
                let name = slice_struct.trim_end_matches("Slice").to_ascii_lowercase();
                let variant = capitalize_ascii(&name);
                self.record_slice_loc(&name, &variant, Loc::new(file, line, format!("struct {slice_struct}"), None));
            }
        }
    }

    fn parse_fact_enum(&mut self, clean: &str, lines: &LineIndex, file: &str) {
        let Some(pos) = clean.find("pub enum Fact") else { return };
        let Some(open) = clean[pos..].find('{').map(|o| pos + o) else { return };
        let Some(end) = find_matching_delim(clean, open, b'{', b'}') else { return };
        let body = &clean[open + 1..end];
        let mut cursor = 0usize;
        while cursor < body.len() {
            let bytes = body.as_bytes();
            if bytes[cursor] == b'#'
                && let Some(close) = body[cursor..].find(']')
            {
                cursor += close + 1;
                continue;
            }
            if is_ident_start(bytes[cursor]) {
                let start = cursor;
                while cursor < body.len() && is_ident_char(bytes[cursor]) {
                    cursor += 1;
                }
                let variant = &body[start..cursor];
                let rest = body[cursor..].trim_start();
                if rest.starts_with('(') {
                    let line = lines.line_at(open + 1 + start);
                    self.facts.insert(variant.to_owned(), Loc::new(file, line, format!("Fact::{variant}"), None));
                    if let Some(paren_end) = find_matching_delim(body, cursor + (body[cursor..].len() - rest.len()), b'(', b')') {
                        cursor = paren_end + 1;
                        continue;
                    }
                }
            } else {
                cursor += 1;
            }
        }
    }

    fn index_ts_protocol(&mut self, root: &Path) -> Result<(), String> {
        let gen_path = "packages/protocol/src/endpoints.gen.ts";
        if let Some(raw) = read_optional_file(root, gen_path)? {
            let clean = strip_ts_comments_keep_strings(&raw);
            let lines = LineIndex::new(&raw);
            self.parse_ts_gen_endpoints(&clean, &lines, gen_path);
            self.parse_ts_gen_subscriptions(&clean, &lines, gen_path);
        }

        let ts_files = walk_matching_files(root, &["packages/protocol/src"], |rel| rel.ends_with(".ts") && !rel.ends_with(".test.ts"))?;
        for file in ts_files {
            let clean = strip_ts_comments_keep_strings(&file.text);
            let lines = LineIndex::new(&file.text);

            if file.path.ends_with("/api.ts") {
                self.parse_ts_domain_api(&clean, &lines, &file.path);
            } else if file.path == "packages/protocol/src/api.ts" {
                self.parse_ts_root_subscriptions(&clean, &lines, &file.path);
            } else if file.path == "packages/protocol/src/client.ts" {
                self.parse_ts_client_methods(&clean, &lines, &file.path);
            } else if file.path == "packages/protocol/src/core/shapes.gen.ts"
                || file.path == "packages/protocol/src/core/schema.ts"
                || file.path == "packages/protocol/src/game/shapes.gen.ts"
            {
                self.parse_ts_slice_symbols(&clean, &lines, &file.path);
            }
        }
        Ok(())
    }

    fn parse_ts_gen_endpoints(&mut self, clean: &str, lines: &LineIndex, file: &str) {
        let Some(anchor) = clean.find("servedEndpoints") else { return };
        let Some(arr_start) = clean[anchor..].find('[').map(|o| anchor + o) else {
            return;
        };
        let Some(arr_end) = find_matching_delim(clean, arr_start, b'[', b']') else {
            return;
        };
        let body = &clean[arr_start..=arr_end];

        let mut cursor = 0usize;
        while let Some(rel) = body[cursor..].find('{') {
            let start = cursor + rel;
            let Some(end) = find_matching_delim(body, start, b'{', b'}') else { break };
            let obj = &body[start..=end];
            if let Some(op_rel) = find_ts_prop_string_pos(obj, "op") {
                let op = extract_quoted_at(obj, op_rel).unwrap_or_default();
                let line = lines.line_at(arr_start + start + op_rel);
                let can = find_ts_string_array_prop(obj, "can");
                let dry_run = find_ts_prop_string(obj, "dryRun");
                self.ts_gen_endpoints.insert(
                    op.clone(),
                    TsGenEndpoint {
                        can,
                        dry_run,
                        loc: Loc::new(file, line, format!("servedEndpoints op: \"{op}\""), None),
                    },
                );
            }
            cursor = end + 1;
        }
    }

    fn parse_ts_gen_subscriptions(&mut self, clean: &str, lines: &LineIndex, file: &str) {
        let Some(anchor) = clean.find("servedSubscriptions") else { return };
        let Some(arr_start) = clean[anchor..].find('[').map(|o| anchor + o) else {
            return;
        };
        let Some(arr_end) = find_matching_delim(clean, arr_start, b'[', b']') else {
            return;
        };
        let body = &clean[arr_start..=arr_end];

        let mut cursor = 0usize;
        while let Some(rel) = body[cursor..].find('{') {
            let start = cursor + rel;
            let Some(end) = find_matching_delim(body, start, b'{', b'}') else { break };
            let obj = &body[start..=end];
            if let Some(name_rel) = find_ts_prop_string_pos(obj, "name") {
                let name = extract_quoted_at(obj, name_rel).unwrap_or_default();
                let line = lines.line_at(arr_start + start + name_rel);
                self.ts_gen_subscriptions
                    .insert(name.clone(), Loc::new(file, line, format!("servedSubscriptions \"{name}\""), None));
            }
            cursor = end + 1;
        }
    }

    fn parse_ts_domain_api(&mut self, clean: &str, lines: &LineIndex, file: &str) {
        // Parse handler interface entries: `readonly "issue.list": (...) => Promise<...>`
        let mut cursor = 0usize;
        while let Some(rel) = clean[cursor..].find("interface ") {
            let pos = cursor + rel;
            let Some(open) = clean[pos..].find('{').map(|o| pos + o) else { break };
            let Some(end) = find_matching_delim(clean, open, b'{', b'}') else { break };
            let iface = &clean[open + 1..end];
            let mut inner = 0usize;
            while let Some(q_rel) = iface[inner..].find('"') {
                let q_pos = inner + q_rel;
                let Some(op) = extract_quoted_at(iface, q_pos) else {
                    inner = q_pos + 1;
                    continue;
                };
                let after = iface[q_pos + op.len() + 2..].trim_start();
                if after.starts_with(':') && op.contains('.') {
                    let line = lines.line_at(open + 1 + q_pos);
                    self.ts_api_entries.entry(op.clone()).or_default().push(TsApiEntry {
                        kind: "handler",
                        input: None,
                        result: None,
                        can: Vec::new(),
                        loc: Loc::new(file, line, format!("Handlers[\"{op}\"]"), None),
                    });
                }
                inner = q_pos + op.len() + 2;
            }
            cursor = end + 1;
        }

        // Parse endpoint array entries: `Endpoints: readonly Endpoint[] = [ { op: "...", ... } ]`
        let mut arr_cursor = 0usize;
        while let Some(rel) = clean[arr_cursor..].find("Endpoints") {
            let pos = arr_cursor + rel;
            let Some(eq_rel) = clean[pos..].find('=') else {
                arr_cursor = pos + "Endpoints".len();
                continue;
            };
            let eq_pos = pos + eq_rel;
            let Some(arr_rel) = clean[eq_pos..].find('[') else {
                arr_cursor = eq_pos + 1;
                continue;
            };
            let arr_start = eq_pos + arr_rel;
            let Some(arr_end) = find_matching_delim(clean, arr_start, b'[', b']') else {
                break;
            };
            let body = &clean[arr_start..=arr_end];

            let mut obj_cursor = 0usize;
            while let Some(obj_rel) = body[obj_cursor..].find('{') {
                let obj_start = obj_cursor + obj_rel;
                let Some(obj_end) = find_matching_delim(body, obj_start, b'{', b'}') else {
                    break;
                };
                let obj = &body[obj_start..=obj_end];
                if let Some(op_rel) = find_ts_prop_string_pos(obj, "op") {
                    let op = extract_quoted_at(obj, op_rel).unwrap_or_default();
                    let line = lines.line_at(arr_start + obj_start + op_rel);
                    let input = find_ts_prop_expr(obj, "input");
                    let result = find_ts_prop_expr(obj, "result");
                    let can = find_ts_string_array_prop(obj, "can");
                    let detail = format_ts_endpoint_detail(input.as_deref(), result.as_deref(), &can);
                    self.ts_api_entries.entry(op.clone()).or_default().push(TsApiEntry {
                        kind: "endpoint",
                        input,
                        result,
                        can,
                        loc: Loc::new(file, line, format!("Endpoint \"{op}\""), detail),
                    });
                }
                obj_cursor = obj_end + 1;
            }
            arr_cursor = arr_end + 1;
        }
    }

    fn parse_ts_root_subscriptions(&mut self, clean: &str, lines: &LineIndex, file: &str) {
        let Some(anchor) = clean.find("export const subscriptions") else { return };
        let Some(open) = clean[anchor..].find('{').map(|o| anchor + o) else { return };
        let Some(end) = find_matching_delim(clean, open, b'{', b'}') else { return };
        let body = &clean[open + 1..end];
        let mut cursor = 0usize;
        while let Some(rel) = body[cursor..].find('"') {
            let q_pos = cursor + rel;
            let Some(name) = extract_quoted_at(body, q_pos) else {
                cursor = q_pos + 1;
                continue;
            };
            let after = body[q_pos + name.len() + 2..].trim_start();
            if after.starts_with(':') && name.contains('.') {
                let line = lines.line_at(open + 1 + q_pos);
                self.ts_api_subscriptions
                    .insert(name.clone(), Loc::new(file, line, format!("subscriptions[\"{name}\"]"), None));
            }
            cursor = q_pos + name.len() + 2;
        }
    }

    fn parse_ts_client_methods(&mut self, clean: &str, lines: &LineIndex, file: &str) {
        let needle = "this.call";
        let mut cursor = 0usize;
        while let Some(rel) = clean[cursor..].find(needle) {
            let pos = cursor + rel;
            let Some(paren_rel) = clean[pos..].find('(') else { break };
            let paren = pos + paren_rel;
            let Some(paren_end) = find_matching_delim(clean, paren, b'(', b')') else {
                break;
            };
            let args_text = &clean[paren + 1..paren_end];
            if let Some(op) = extract_first_quoted(args_text)
                && op.contains('.')
            {
                let rest_start = args_text.find(&op).map_or(0, |i| i + op.len() + 1);
                let http_path = extract_first_quoted(&args_text[rest_start..]);
                let line = lines.line_at(pos);
                let detail = http_path.map(|p| format!("HTTP {p}"));
                self.ts_client_calls
                    .entry(op.clone())
                    .or_default()
                    .push(Loc::new(file, line, format!("VibeValleyApi(\"{op}\")"), detail));
            }
            cursor = paren_end + 1;
        }
    }

    fn parse_ts_slice_symbols(&mut self, clean: &str, lines: &LineIndex, file: &str) {
        for (slice_name, symbol) in [
            ("board", "BoardSlice"),
            ("sessions", "SessionsSlice"),
            ("collab", "CollabSlice"),
            ("inbox", "InboxSlice"),
            ("ops", "OpsSlice"),
            ("farm", "FarmFrame"),
        ] {
            for kw in ["export type ", "export interface ", "export const "] {
                let needle = format!("{kw}{symbol}");
                if let Some(pos) = clean.find(&needle) {
                    let line = lines.line_at(pos);
                    self.ts_slices
                        .entry(slice_name.to_owned())
                        .or_default()
                        .push(Loc::new(file, line, symbol, None));
                }
            }
        }

        if let Some(pos) = clean.find("export const SliceKindValues") {
            let line = lines.line_at(pos);
            for slice_name in ["board", "sessions", "collab", "inbox", "ops", "farm"] {
                self.ts_slices
                    .entry(slice_name.to_owned())
                    .or_default()
                    .push(Loc::new(file, line, "SliceKindValues", None));
            }
        }
    }

    fn index_gateway_and_router(&mut self, root: &Path) -> Result<(), String> {
        let router_path = "crates/server/src/router.rs";
        if let Some(raw) = read_optional_file(root, router_path)? {
            let clean = strip_rust_comments_keep_strings_non_test(&raw, router_path);
            let lines = LineIndex::new(&raw);
            self.parse_router(&clean, &lines, router_path);
        }

        let gw_files = walk_matching_files(root, &["crates/server/src/gateway"], |rel| {
            rel.ends_with(".rs") && !rel.ends_with("tests.rs") && !rel.ends_with("/fake.rs")
        })?;
        for file in gw_files {
            let clean = strip_rust_comments_keep_strings_non_test(&file.text, &file.path);
            let lines = LineIndex::new(&file.text);
            if file.path.starts_with("crates/server/src/gateway/http/") {
                self.parse_http_gateway(&clean, &lines, &file.path);
            } else if file.path.starts_with("crates/server/src/gateway/bridge/") {
                self.parse_bridge_gateway(&clean, &lines, &file.path);
            }
        }
        Ok(())
    }

    fn parse_router(&mut self, clean: &str, lines: &LineIndex, file: &str) {
        for fn_name in [
            "dispatch_op_async",
            "open_sub_async",
            "slice_snapshot_json_async",
            "subscribe_slice_async",
            "watch_slice",
        ] {
            if let Some(pos) = find_fn_def(clean, fn_name) {
                self.router_meta
                    .insert(fn_name.to_owned(), Loc::new(file, lines.line_at(pos), format!("Router::{fn_name}"), None));
            }
        }

        let Some(fn_pos) = find_fn_def(clean, "dispatch_endpoint_async") else {
            return;
        };
        let Some(open) = clean[fn_pos..].find('{').map(|o| fn_pos + o) else { return };
        let Some(end) = find_matching_delim(clean, open, b'{', b'}') else { return };
        let fn_body = &clean[open + 1..end];

        // Parse local alias destructuring like `let (pr, mem, ...) = (&c.agent.profile, &c.agent.memory, ...);`
        self.parse_router_aliases(fn_body);

        let Some(match_rel) = fn_body.find("match id") else { return };
        let Some(m_open) = fn_body[match_rel..].find('{').map(|o| match_rel + o) else {
            return;
        };
        let Some(m_end) = find_matching_delim(fn_body, m_open, b'{', b'}') else {
            return;
        };
        let match_body = &fn_body[m_open + 1..m_end];
        let base = open + 1 + m_open + 1;

        let mut cursor = 0usize;
        while cursor < match_body.len() {
            let rest = &match_body[cursor..];
            let Some((prefix, var_off)) = find_next_enum_arm(rest) else { break };
            let arm_start = cursor + var_off;
            let ident_start = arm_start + prefix.len();
            let variant = read_ident(&match_body[ident_start..]);
            if variant.is_empty() {
                cursor = ident_start + 1;
                continue;
            }
            let after_var = ident_start + variant.len();
            let trimmed = match_body[after_var..].trim_start();
            let Some(after_arrow) = trimmed.strip_prefix("=>") else {
                cursor = after_var;
                continue;
            };
            let expr_start = match_body.len() - after_arrow.len();
            let expr_end = find_match_arm_end(match_body, expr_start);
            let expr = match_body[expr_start..expr_end].trim();
            let line = lines.line_at(base + arm_start);
            let summary = summarize_router_expr(expr);
            self.router_arms.insert(
                variant.to_owned(),
                RouterArm {
                    target_expr: expr.to_owned(),
                    loc: Loc::new(file, line, format!("Router arm E::{variant}"), summary),
                },
            );
            cursor = (expr_end + 1).min(match_body.len());
        }
    }

    fn parse_router_aliases(&mut self, body: &str) {
        let mut cursor = 0usize;
        while let Some(rel) = body[cursor..].find("let (") {
            let pos = cursor + rel;
            let lhs_start = pos + "let ".len();
            let Some(lhs_end) = find_matching_delim(body, lhs_start, b'(', b')') else {
                break;
            };
            let after = body[lhs_end + 1..].trim_start();
            if let Some(rhs_after_eq) = after.strip_prefix('=')
                && rhs_after_eq.trim_start().starts_with('(')
            {
                let rhs_start = body.len() - rhs_after_eq.trim_start().len();
                if let Some(rhs_end) = find_matching_delim(body, rhs_start, b'(', b')') {
                    let names: Vec<&str> = body[lhs_start + 1..lhs_end].split(',').map(str::trim).collect();
                    let vals: Vec<&str> = body[rhs_start + 1..rhs_end].split(',').map(str::trim).collect();
                    for (n, v) in names.into_iter().zip(vals) {
                        if !n.is_empty() && !v.is_empty() {
                            self.router_aliases.insert(n.to_owned(), v.trim_start_matches('&').to_owned());
                        }
                    }
                    cursor = rhs_end + 1;
                    continue;
                }
            }
            cursor = lhs_end + 1;
        }
    }

    fn parse_http_gateway(&mut self, clean: &str, lines: &LineIndex, file: &str) {
        let mut cursor = 0usize;
        while let Some(rel) = clean[cursor..].find(".route(") {
            let pos = cursor + rel;
            let paren = pos + ".route".len();
            let Some(paren_end) = find_matching_delim(clean, paren, b'(', b')') else {
                break;
            };
            let args = &clean[paren + 1..paren_end];
            if let Some(route_path) = extract_first_quoted(args) {
                let line = lines.line_at(pos);
                let handler = args.split_once(',').map(|(_, r)| collapse_ws(r.trim())).unwrap_or_default();
                self.http_routes
                    .push((route_path.clone(), Loc::new(file, line, format!("HTTP route {route_path}"), Some(handler))));
            }
            cursor = paren_end + 1;
        }

        for fn_name in ["command", "slice", "subscribe", "issue_watch", "attachment", "content", "upload", "speech"] {
            if let Some(pos) = find_fn_def(clean, fn_name) {
                let line = lines.line_at(pos);
                let key = if file.ends_with("/media.rs") {
                    format!("http::media::{fn_name}")
                } else {
                    format!("http::{fn_name}")
                };
                self.http_routes.push((key.clone(), Loc::new(file, line, key, None)));
            }
        }
    }

    fn parse_bridge_gateway(&mut self, clean: &str, lines: &LineIndex, file: &str) {
        for (label, needle) in [
            ("bridge::call_with", "fn call_with("),
            ("bridge::client_call", "fn call(&self, id:"),
            ("bridge::subscribe", "fn subscribe(&self, id:"),
            ("bridge::watch", "pub fn watch(&self"),
            ("bridge::pump_slice", "fn pump_slice_subscription"),
        ] {
            if let Some(pos) = clean.find(needle) {
                self.bridge_handlers.push((label.to_owned(), Loc::new(file, lines.line_at(pos), label, None)));
            }
        }
    }

    fn index_server_services(&mut self, root: &Path) -> Result<(), String> {
        let server_files = walk_matching_files(root, &["crates/server/src"], |rel| {
            rel.ends_with(".rs") && !rel.starts_with("crates/server/src/fake/") && !rel.ends_with("/tests.rs")
        })?;

        let mut excluded = BTreeSet::new();
        for f in &server_files {
            let no_lit = strip_rust_comments_and_literals(&f.text);
            excluded.extend(strip_cfg_test_and_collect_excluded(&f.text, &no_lit, &f.path).excluded_submodules);
        }

        for file in server_files {
            if is_excluded_by_cfg_test(&file.path, &excluded) {
                continue;
            }
            let non_code = strip_rust_non_code(&file.text, &file.path);
            let lines = LineIndex::new(&file.text);
            let module_key = server_module_key(&file.path);

            self.parse_server_functions(&non_code, &lines, &file.path, &module_key);
            self.parse_server_emitters(&non_code, &lines, &file.path);

            if file.path == "crates/server/src/projection.rs" {
                self.parse_server_projection_file(&non_code, &lines, &file.path);
            } else if file.path == "crates/server/src/context/feed.rs" {
                self.parse_feed_slices(&non_code, &lines, &file.path);
            }
        }
        Ok(())
    }

    fn parse_server_functions(&mut self, non_code: &str, lines: &LineIndex, file: &str, module_key: &str) {
        let bytes = non_code.as_bytes();
        let mut impl_stack: Vec<(Option<String>, usize)> = Vec::new();
        let mut depth = 0usize;
        let mut i = 0usize;

        while i < bytes.len() {
            if bytes[i] == b'{' {
                depth += 1;
                i += 1;
                continue;
            }
            if bytes[i] == b'}' {
                depth = depth.saturating_sub(1);
                while let Some((_, d)) = impl_stack.last() {
                    if *d > depth {
                        impl_stack.pop();
                    } else {
                        break;
                    }
                }
                i += 1;
                continue;
            }
            if non_code[i..].starts_with("impl") && is_word_boundary_before(bytes, i) && bytes.get(i + 4).is_some_and(|b| b.is_ascii_whitespace() || *b == b'<')
            {
                if let Some(open) = non_code[i..].find('{').map(|o| i + o) {
                    let header = &non_code[i..open];
                    let target = extract_impl_type_name(header);
                    impl_stack.push((target, depth + 1));
                }
                i += 4;
                continue;
            }
            if non_code[i..].starts_with("fn ") && is_word_boundary_before(bytes, i) {
                let name_start = i + 3;
                let rest = non_code[name_start..].trim_start();
                let fn_name = read_ident(rest);
                if !fn_name.is_empty()
                    && let Some(paren_rel) = non_code[name_start..].find('(')
                {
                    let paren = name_start + paren_rel;
                    if let Some(paren_end) = find_matching_delim(non_code, paren, b'(', b')')
                        && let Some(body_open) = find_fn_body_open(non_code, paren_end + 1)
                        && let Some(body_end) = find_matching_delim(non_code, body_open, b'{', b'}')
                    {
                        let body = &non_code[body_open..=body_end];
                        let impl_type = impl_stack.last().and_then(|(t, _)| t.clone());
                        let line = lines.line_at(i);
                        let body_calls = collect_callee_names(body);
                        let core_calls = collect_core_calls(body);
                        let dirty_slices = extract_slice_mask_names(body);
                        let outbox_events = collect_prefixed_variants(body, "OutboxEvent::");
                        let facts = collect_prefixed_variants(body, "Fact::");
                        self.server_fns.push(ServerFn {
                            name: fn_name.to_owned(),
                            impl_type,
                            module_key: module_key.to_owned(),
                            file: file.to_owned(),
                            line,
                            body_calls,
                            core_calls,
                            dirty_slices,
                            outbox_events,
                            facts,
                        });
                    }
                }
                i += 3;
                continue;
            }
            i += 1;
        }
    }

    fn parse_server_emitters(&mut self, non_code: &str, lines: &LineIndex, file: &str) {
        let mut cursor = 0usize;
        while let Some(rel) = non_code[cursor..].find("mark_dirty(") {
            let pos = cursor + rel;
            let paren = pos + "mark_dirty".len();
            if let Some(paren_end) = find_matching_delim(non_code, paren, b'(', b')') {
                let arg = &non_code[paren + 1..paren_end];
                let mut slices = extract_slice_mask_names(arg);
                if slices.is_empty() {
                    let context_start = pos.saturating_sub(400);
                    slices = extract_slice_mask_names(&non_code[context_start..pos]);
                }
                if !slices.is_empty() {
                    let line = lines.line_at(pos);
                    let fn_ctx = self.enclosing_server_fn_name(file, line).unwrap_or_else(|| "mark_dirty".to_owned());
                    self.server_emitters.push(ServerEmitter {
                        loc: Loc::new(file, line, fn_ctx, Some(format!("mark_dirty({})", slices.join(" | ")))),
                        kind: "mark_dirty",
                        slices,
                    });
                }
                cursor = paren_end + 1;
                continue;
            }
            cursor = paren + 1;
        }
    }

    fn enclosing_server_fn_name(&self, file: &str, line: usize) -> Option<String> {
        self.server_fns
            .iter()
            .filter(|f| f.file == file && f.line <= line)
            .max_by_key(|f| f.line)
            .map(|f| match &f.impl_type {
                Some(ty) => format!("{ty}::{}", f.name),
                None => f.name.clone(),
            })
    }

    fn parse_server_projection_file(&mut self, non_code: &str, lines: &LineIndex, file: &str) {
        if let Some(fn_pos) = find_fn_def(non_code, "project_slice_json")
            && let Some(open) = non_code[fn_pos..].find('{').map(|o| fn_pos + o)
            && let Some(end) = find_matching_delim(non_code, open, b'{', b'}')
        {
            let body = &non_code[open + 1..end];
            let base = open + 1;
            for (slice, variant) in [
                ("board", "Board"),
                ("sessions", "Sessions"),
                ("collab", "Collab"),
                ("inbox", "Inbox"),
                ("ops", "Ops"),
                ("farm", "Farm"),
            ] {
                let needle = format!("SliceKind::{variant}");
                if let Some(rel) = body.find(&needle) {
                    let line = lines.line_at(base + rel);
                    self.server_slice_projections.entry(slice.to_owned()).or_default().push(Loc::new(
                        file,
                        line,
                        format!("project_slice_json({needle})"),
                        None,
                    ));
                }
            }
        }

        if let Some(fn_pos) = find_fn_def(non_code, "open_sub_domain_async")
            && let Some(open) = non_code[fn_pos..].find('{').map(|o| fn_pos + o)
            && let Some(end) = find_matching_delim(non_code, open, b'{', b'}')
        {
            let body = &non_code[open + 1..end];
            let base = open + 1;
            for (sub_name, variant) in [
                ("channel.follow", "ChannelFollow"),
                ("channel.reports", "ChannelReports"),
                ("artifact.follow", "ArtifactFollow"),
                ("artifact.suggestion.follow", "ArtifactSuggestionFollow"),
                ("artifact.presence.follow", "ArtifactPresenceFollow"),
                ("session.watch", "SessionWatch"),
                ("issue.watch", "IssueWatch"),
            ] {
                let needle = format!("DomainSubscription::{variant}");
                if let Some(rel) = body.find(&needle) {
                    let line = lines.line_at(base + rel);
                    let arm_end = find_match_arm_end(body, rel);
                    let target = collapse_ws(&body[rel..arm_end]);
                    self.server_subs.entry(sub_name.to_owned()).or_default().push(Loc::new(
                        file,
                        line,
                        format!("open_sub_domain_async({variant})"),
                        Some(target),
                    ));
                }
            }
        }
    }

    fn parse_feed_slices(&mut self, non_code: &str, lines: &LineIndex, file: &str) {
        for (slice, variant) in [
            ("board", "Board"),
            ("sessions", "Sessions"),
            ("collab", "Collab"),
            ("inbox", "Inbox"),
            ("ops", "Ops"),
            ("farm", "Farm"),
        ] {
            let needle = format!("SliceKind::{variant}");
            if let Some(pos) = non_code.find(&needle) {
                let line = lines.line_at(pos);
                self.server_slice_projections
                    .entry(slice.to_owned())
                    .or_default()
                    .push(Loc::new(file, line, format!("SliceFeed({needle})"), None));
            }
        }
    }

    fn index_core(&mut self, root: &Path) -> Result<(), String> {
        let core_files = walk_matching_files(root, &["crates/core/src"], |rel| rel.ends_with(".rs"))?;
        let mut excluded = BTreeSet::new();
        for f in &core_files {
            let no_lit = strip_rust_comments_and_literals(&f.text);
            excluded.extend(strip_cfg_test_and_collect_excluded(&f.text, &no_lit, &f.path).excluded_submodules);
        }

        for file in core_files {
            if is_excluded_by_cfg_test(&file.path, &excluded) {
                continue;
            }
            let non_code = strip_rust_non_code(&file.text, &file.path);
            let lines = LineIndex::new(&file.text);

            self.parse_core_pub_fns(&non_code, &lines, &file.path);

            if file.path == "crates/core/src/core.rs" {
                self.parse_core_reducers(&non_code, &lines, &file.path);
            }
            if file.path == "crates/core/src/projection.rs" || file.path == "crates/core/src/core.rs" {
                self.parse_core_slice_projections(&non_code, &lines, &file.path);
            }
        }
        Ok(())
    }

    fn parse_core_pub_fns(&mut self, non_code: &str, lines: &LineIndex, file: &str) {
        let mut cursor = 0usize;
        while let Some(rel) = non_code[cursor..].find("pub fn ") {
            let pos = cursor + rel;
            if is_word_boundary_before(non_code.as_bytes(), pos) {
                let name = read_ident(non_code[pos + "pub fn ".len()..].trim_start());
                if !name.is_empty() {
                    let line = lines.line_at(pos);
                    self.core_pub_fns
                        .entry(name.to_owned())
                        .or_default()
                        .push(Loc::new(file, line, format!("vibevalley_core::{name}"), None));
                }
            }
            cursor = pos + "pub fn ".len();
        }
    }

    fn parse_core_reducers(&mut self, non_code: &str, lines: &LineIndex, file: &str) {
        if let Some(fn_pos) = find_fn_def(non_code, "fold")
            && let Some(open) = non_code[fn_pos..].find('{').map(|o| fn_pos + o)
            && let Some(end) = find_matching_delim(non_code, open, b'{', b'}')
        {
            let body = &non_code[open + 1..end];
            let base = open + 1;
            let mut cursor = 0usize;
            while let Some(rel) = body[cursor..].find("Fact::") {
                let pos = cursor + rel;
                let variant = read_ident(&body[pos + "Fact::".len()..]);
                if variant.is_empty() {
                    cursor = pos + 6;
                    continue;
                }
                let after_var = pos + "Fact::".len() + variant.len();
                let arm_end = find_match_arm_end(body, after_var);
                let arm = &body[pos..arm_end];
                let mut slices = extract_slice_mask_names(arm);
                slices.retain(|s| s != "none");
                if !slices.is_empty() {
                    let line = lines.line_at(base + pos);
                    self.core_reducers.push(CoreReducer {
                        fact_variant: variant.to_owned(),
                        slices,
                        loc: Loc::new(file, line, format!("fold Fact::{variant}"), None),
                    });
                }
                cursor = arm_end.max(pos + 6);
            }
        }

        if let Some(fn_pos) = find_fn_def(non_code, "reduce")
            && let Some(open) = non_code[fn_pos..].find('{').map(|o| fn_pos + o)
            && let Some(end) = find_matching_delim(non_code, open, b'{', b'}')
        {
            let body = &non_code[open + 1..end];
            let base = open + 1;
            if let Some(rel) = body.find("Fact::SessionPhaseChanged") {
                let line = lines.line_at(base + rel);
                let slices = extract_slice_mask_names(&body[rel..body.len().min(rel + 200)]);
                if !slices.is_empty() {
                    self.core_reducers.push(CoreReducer {
                        fact_variant: "SessionPhaseChanged".to_owned(),
                        slices,
                        loc: Loc::new(file, line, "reduce Fact::SessionPhaseChanged (conditional)", None),
                    });
                }
            }
        }
    }

    fn parse_core_slice_projections(&mut self, non_code: &str, lines: &LineIndex, file: &str) {
        for (slice, fn_names) in [
            ("board", &["project_board", "board_slice", "derive_issues"][..]),
            ("sessions", &["project_sessions", "sessions_slice"][..]),
            ("collab", &["project_collab", "collab_slice"][..]),
            ("inbox", &["project_inbox", "inbox_slice"][..]),
            ("ops", &["project_ops", "ops_slice"][..]),
            ("farm", &["project_farm", "farm_frame"][..]),
        ] {
            for fn_name in fn_names {
                if let Some(pos) = find_fn_def(non_code, fn_name) {
                    self.core_slice_projections.entry(slice.to_owned()).or_default().push(Loc::new(
                        file,
                        lines.line_at(pos),
                        format!("vibevalley_core::{fn_name}"),
                        None,
                    ));
                }
            }
        }
    }

    fn index_clients(&mut self, root: &Path) -> Result<(), String> {
        let known_ops: BTreeSet<String> = self.op_to_idx.keys().cloned().collect();
        let known_subs: BTreeSet<String> = self.sub_to_idx.keys().cloned().collect();
        let known_modules: BTreeSet<String> = known_ops.iter().filter_map(|op| op.split('.').next().map(str::to_owned)).collect();

        // 1. Mac UI (`apps/mac/ui/**`)
        let mac_ui_files = walk_matching_files(root, &["apps/mac/ui"], |rel| {
            is_ts_source(rel) && !is_ts_test_or_fixture(rel) && rel != "apps/mac/ui/infra/api.ts"
        })?;
        for file in mac_ui_files {
            let clean = strip_ts_comments_keep_strings(&file.text);
            let lines = LineIndex::new(&file.text);
            self.scan_ts_client_file("mac", &clean, &lines, &file.path, &known_ops, &known_subs, &known_modules);
        }

        // 1b. Mac native host (`apps/mac/src/**`) slice subscriptions
        let mac_src_files = walk_matching_files(root, &["apps/mac/src"], |rel| rel.ends_with(".rs"))?;
        for file in mac_src_files {
            let non_code = strip_rust_non_code(&file.text, &file.path);
            let lines = LineIndex::new(&file.text);
            self.scan_rust_slice_kinds("mac-host", &non_code, &lines, &file.path);
        }

        // 2. Mobile (`apps/mobile/src/**`)
        let mobile_files = walk_matching_files(root, &["apps/mobile/src"], |rel| is_ts_source(rel) && !is_ts_test_or_fixture(rel))?;
        for file in mobile_files {
            let clean = strip_ts_comments_keep_strings(&file.text);
            let lines = LineIndex::new(&file.text);
            self.scan_ts_client_file("mobile", &clean, &lines, &file.path, &known_ops, &known_subs, &known_modules);
        }

        // 3. CLI (`crates/cli/src/**`)
        let cli_files = walk_matching_files(root, &["crates/cli/src"], |rel| rel.ends_with(".rs"))?;
        let mut excluded = BTreeSet::new();
        for f in &cli_files {
            let no_lit = strip_rust_comments_and_literals(&f.text);
            excluded.extend(strip_cfg_test_and_collect_excluded(&f.text, &no_lit, &f.path).excluded_submodules);
        }
        for file in cli_files {
            if is_excluded_by_cfg_test(&file.path, &excluded) {
                continue;
            }
            let clean = strip_rust_comments_keep_strings_non_test(&file.text, &file.path);
            let lines = LineIndex::new(&file.text);
            self.scan_cli_file(&clean, &lines, &file.path, &known_ops);
        }

        for list in self.client_ops.values_mut() {
            sort_and_dedup_calls(list);
        }
        for list in self.client_subs.values_mut() {
            sort_and_dedup_calls(list);
        }
        for list in self.client_slices.values_mut() {
            sort_and_dedup_calls(list);
        }

        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn scan_ts_client_file(
        &mut self,
        client: &str,
        clean: &str,
        lines: &LineIndex,
        file: &str,
        known_ops: &BTreeSet<String>,
        known_subs: &BTreeSet<String>,
        known_modules: &BTreeSet<String>,
    ) {
        let bytes = clean.as_bytes();

        // A. `api.<a.b.c>(` dotted invocations
        let mut cursor = 0usize;
        while let Some(rel) = clean[cursor..].find("api.") {
            let pos = cursor + rel;
            let before_ok = pos == 0 || (!is_ident_char(bytes[pos - 1]) && bytes[pos - 1] != b'.');
            if !before_ok {
                cursor = pos + 4;
                continue;
            }
            if let Some((op, after_chain)) = parse_dotted_call_chain(&clean[pos + 4..])
                && (known_ops.contains(&op) || op.split('.').next().is_some_and(|first| known_modules.contains(first) && op.contains('.')))
            {
                let line = lines.line_at(pos);
                self.client_ops.entry(op.clone()).or_default().push(ClientCall {
                    client: client.to_owned(),
                    via: format!("api.{op}()"),
                    file: file.to_owned(),
                    line,
                    detail: None,
                });
                cursor = pos + 4 + after_chain;
                continue;
            }
            cursor = pos + 4;
        }

        // B. `.call("op.name"` / `callData("op.name"`
        for needle in [".call(", "callData("] {
            let mut c = 0usize;
            while let Some(rel) = clean[c..].find(needle) {
                let pos = c + rel;
                let paren = pos + needle.len() - 1;
                if let Some(op) = extract_first_quoted(clean[paren + 1..].trim_start())
                    && (known_ops.contains(&op) || (op.contains('.') && !op.starts_with("host.") && !op.starts_with("keychain.")))
                {
                    let line = lines.line_at(pos);
                    let via = if needle.starts_with('.') {
                        format!("transport.call(\"{op}\")")
                    } else {
                        format!("callData(\"{op}\")")
                    };
                    self.client_ops.entry(op).or_default().push(ClientCall {
                        client: client.to_owned(),
                        via,
                        file: file.to_owned(),
                        line,
                        detail: None,
                    });
                }
                c = paren + 1;
            }
        }

        // C. `subscribe("sub.name"`
        let mut sc = 0usize;
        while let Some(rel) = clean[sc..].find("subscribe(") {
            let pos = sc + rel;
            let before_ok = pos == 0 || !is_ident_char(bytes[pos - 1]);
            let paren = pos + "subscribe".len();
            if before_ok
                && let Some(sub) = extract_first_quoted(clean[paren + 1..].trim_start())
                && (known_subs.contains(&sub) || sub.contains('.'))
            {
                let line = lines.line_at(pos);
                self.client_subs.entry(sub.clone()).or_default().push(ClientCall {
                    client: client.to_owned(),
                    via: format!("subscribe(\"{sub}\")"),
                    file: file.to_owned(),
                    line,
                    detail: None,
                });
            }
            sc = paren + 1;
        }

        // D. Slice subscriptions in TS UI
        for (hook, slice) in [
            ("useBoardSlice(", "board"),
            ("useSessionsSlice(", "sessions"),
            ("useCollabSlice(", "collab"),
            ("useInboxSlice(", "inbox"),
            ("useOpsSlice(", "ops"),
            ("useFarmSlice(", "farm"),
        ] {
            let mut hc = 0usize;
            while let Some(rel) = clean[hc..].find(hook) {
                let pos = hc + rel;
                let line = lines.line_at(pos);
                self.client_slices.entry(slice.to_owned()).or_default().push(ClientCall {
                    client: client.to_owned(),
                    via: hook.trim_end_matches('(').to_owned(),
                    file: file.to_owned(),
                    line,
                    detail: None,
                });
                hc = pos + hook.len();
            }
        }

        for fn_name in ["useSlice(", "ensureSlice(", "makeChannel(", "makeSlot(", ".slice("] {
            let mut fc = 0usize;
            while let Some(rel) = clean[fc..].find(fn_name) {
                let pos = fc + rel;
                let paren = pos + fn_name.len() - 1;
                let trimmed = clean[paren + 1..].trim_start();
                if let Some(slice) = extract_first_quoted(trimmed)
                    && self.slices.contains_key(&slice)
                {
                    let line = lines.line_at(pos);
                    self.client_slices.entry(slice.clone()).or_default().push(ClientCall {
                        client: client.to_owned(),
                        via: format!("{}(\"{slice}\")", fn_name.trim_start_matches('.').trim_end_matches('(')),
                        file: file.to_owned(),
                        line,
                        detail: None,
                    });
                }
                fc = paren + 1;
            }
        }

        // `defineIntent<..., "board">({ slice: "board", ... })`
        let mut dc = 0usize;
        while let Some(rel) = clean[dc..].find("slice:") {
            let pos = dc + rel;
            let after = clean[pos + "slice:".len()..].trim_start();
            if let Some(slice) = extract_first_quoted(after)
                && self.slices.contains_key(&slice)
            {
                let line = lines.line_at(pos);
                self.client_slices.entry(slice.clone()).or_default().push(ClientCall {
                    client: client.to_owned(),
                    via: format!("defineIntent slice: \"{slice}\""),
                    file: file.to_owned(),
                    line,
                    detail: None,
                });
            }
            dc = pos + "slice:".len();
        }
    }

    fn scan_rust_slice_kinds(&mut self, client: &str, non_code: &str, lines: &LineIndex, file: &str) {
        let mut cursor = 0usize;
        while let Some(rel) = non_code[cursor..].find("SliceKind::") {
            let pos = cursor + rel;
            let variant = read_ident(&non_code[pos + "SliceKind::".len()..]);
            let slice = variant.to_ascii_lowercase();
            if self.slices.contains_key(&slice) {
                let line = lines.line_at(pos);
                self.client_slices.entry(slice).or_default().push(ClientCall {
                    client: client.to_owned(),
                    via: format!("SliceKind::{variant}"),
                    file: file.to_owned(),
                    line,
                    detail: None,
                });
            }
            cursor = pos + "SliceKind::".len();
        }
    }

    fn scan_cli_file(&mut self, clean: &str, lines: &LineIndex, file: &str, known_ops: &BTreeSet<String>) {
        // 1. `ops::<Variant>`
        let mut cursor = 0usize;
        while let Some(rel) = clean[cursor..].find("ops::") {
            let pos = cursor + rel;
            let variant = read_ident(&clean[pos + "ops::".len()..]);
            if !variant.is_empty()
                && let Some(op) = self.variant_to_op.get(variant).cloned()
            {
                let line = lines.line_at(pos);
                let snippet = lines.snippet_at(line);
                if !snippet.starts_with("use ") {
                    let via = if snippet.contains("mutate::") {
                        format!("mutate::<ops::{variant}>")
                    } else if snippet.contains("ask::") {
                        format!("ask::<ops::{variant}>")
                    } else {
                        format!("ops::{variant}")
                    };
                    self.client_ops.entry(op).or_default().push(ClientCall {
                        client: "cli".to_owned(),
                        via,
                        file: file.to_owned(),
                        line,
                        detail: None,
                    });
                }
            }
            cursor = pos + "ops::".len();
        }

        // 2. `ask_raw("op.name"` (exclude `client.rs` helper definition itself)
        if file != "crates/cli/src/client.rs" {
            let mut rc = 0usize;
            while let Some(rel) = clean[rc..].find("ask_raw(") {
                let pos = rc + rel;
                let paren = pos + "ask_raw".len();
                if let Some(op) = extract_first_quoted(clean[paren + 1..].trim_start())
                    && known_ops.contains(&op)
                {
                    let line = lines.line_at(pos);
                    self.client_ops.entry(op.clone()).or_default().push(ClientCall {
                        client: "cli".to_owned(),
                        via: format!("ask_raw(\"{op}\")"),
                        file: file.to_owned(),
                        line,
                        detail: None,
                    });
                }
                rc = paren + 1;
            }
        }

        // 3. Slice watchers / snapshots in CLI: `/api/v1/slice/<name>` and `SliceArg::<Slice>` / `SliceKind::<Slice>`
        let mut sc = 0usize;
        while let Some(rel) = clean[sc..].find("/api/v1/slice/") {
            let pos = sc + rel;
            let rest = &clean[pos + "/api/v1/slice/".len()..];
            let slice = read_ident(rest);
            if self.slices.contains_key(slice) {
                let line = lines.line_at(pos);
                self.client_slices.entry(slice.to_owned()).or_default().push(ClientCall {
                    client: "cli".to_owned(),
                    via: format!("/api/v1/slice/{slice}"),
                    file: file.to_owned(),
                    line,
                    detail: None,
                });
            }
            sc = pos + "/api/v1/slice/".len();
        }

        if file != "crates/cli/src/domains/infra/state.rs" {
            self.scan_rust_slice_kinds("cli", clean, lines, file);
        } else {
            let mut ac = 0usize;
            while let Some(rel) = clean[ac..].find("SliceArg::") {
                let pos = ac + rel;
                let variant = read_ident(&clean[pos + "SliceArg::".len()..]);
                let slice = variant.to_ascii_lowercase();
                if self.slices.contains_key(&slice) {
                    let line = lines.line_at(pos);
                    self.client_slices.entry(slice).or_default().push(ClientCall {
                        client: "cli".to_owned(),
                        via: format!("SliceArg::{variant}"),
                        file: file.to_owned(),
                        line,
                        detail: None,
                    });
                }
                ac = pos + "SliceArg::".len();
            }
        }
    }

    fn resolve_server_chain(&self, arm_expr: &str) -> (Vec<Loc>, Vec<Loc>) {
        let mut server_locs = Vec::new();
        let mut core_locs = Vec::new();
        let mut visited_fns = BTreeSet::new();
        let mut queue: VecDeque<usize> = VecDeque::new();

        for (receiver, method) in extract_method_calls_with_receivers(arm_expr) {
            let module_hint = self.receiver_to_module_hint(receiver.as_deref());
            if let Some(fn_idx) = self.find_server_fn(&method, module_hint.as_deref())
                && visited_fns.insert(fn_idx)
            {
                queue.push_back(fn_idx);
            }
        }

        let mut hops = 0usize;
        while !queue.is_empty() && hops < 4 {
            let level_len = queue.len();
            for _ in 0..level_len {
                let Some(fn_idx) = queue.pop_front() else { break };
                let f = &self.server_fns[fn_idx];
                let sym = match &f.impl_type {
                    Some(ty) => format!("{ty}::{}", f.name),
                    None => f.name.clone(),
                };
                let mut details = Vec::new();
                if !f.dirty_slices.is_empty() {
                    details.push(format!("marks dirty: {}", f.dirty_slices.join(" | ")));
                }
                if !f.outbox_events.is_empty() {
                    details.push(format!("outbox: {}", f.outbox_events.join(", ")));
                }
                if !f.facts.is_empty() {
                    details.push(format!("facts: {}", f.facts.join(", ")));
                }
                let detail = (!details.is_empty()).then(|| details.join("; "));
                push_unique_loc(&mut server_locs, Loc::new(&f.file, f.line, sym, detail));

                for core_fn in &f.core_calls {
                    if let Some(locs) = self.core_pub_fns.get(core_fn) {
                        for loc in locs {
                            push_unique_loc(&mut core_locs, loc.clone());
                        }
                    }
                }

                for slice in &f.dirty_slices {
                    for reducer in &self.core_reducers {
                        if reducer.slices.iter().any(|s| s == slice) {
                            push_unique_loc(&mut core_locs, reducer.loc.clone());
                        }
                    }
                }

                for fact in &f.facts {
                    for reducer in &self.core_reducers {
                        if reducer.fact_variant == *fact {
                            push_unique_loc(&mut core_locs, reducer.loc.clone());
                        }
                    }
                }

                if hops < 3 {
                    for callee in &f.body_calls {
                        let next_hint = if f.file == "crates/server/src/projection.rs" {
                            None
                        } else {
                            Some(f.module_key.as_str())
                        };
                        if let Some(next_idx) = self.find_server_fn(callee, next_hint)
                            && visited_fns.insert(next_idx)
                        {
                            queue.push_back(next_idx);
                        }
                    }
                }
            }
            hops += 1;
        }

        (server_locs, core_locs)
    }

    fn receiver_to_module_hint(&self, receiver: Option<&str>) -> Option<String> {
        let raw = receiver?;
        let expanded = self.router_aliases.get(raw).map(String::as_str).unwrap_or(raw);
        let mapped = match expanded {
            s if s.contains("agent.profile") || s.contains("agent.orchestrator") || s == "pr" || s == "orch" => "agent",
            s if s.contains("agent.memory") || s == "mem" => "agent/memory",
            s if s.contains("artifact.media") || s == "med" => "artifact/media",
            s if s.contains("artifact.library") || s == "lib" => "artifact/library",
            s if s.contains("artifact") || s == "art" => "artifact",
            s if s.contains("channel") || s == "ch" => "channel",
            s if s.contains("runtime") || s == "rt" => "runtime",
            s if s.contains("board") || s == "brd" => "issue",
            s if s.contains("issue_chat") || s.contains("session_chat") => "issue",
            s if s.contains("pull") => "issue/pull",
            s if s.contains("storage") || s == "st" => "storage",
            s if s.contains("debug") || s == "dbg" => "debug",
            s if s.contains("repo") => "repo",
            s if s.contains("cron") => "cron",
            s if s.contains("connector") => "connector",
            s if s.contains("voice") => "voice",
            s if s.contains("provider") => "provider",
            s if s.contains("setting") => "setting",
            s if s.contains("game") => "game",
            s if s.contains("machine") => "machine",
            s if s.contains("remote") => "gateway/remote",
            "pj" => "projection",
            _ => return None,
        };
        Some(mapped.to_owned())
    }

    fn find_server_fn(&self, method: &str, module_hint: Option<&str>) -> Option<usize> {
        if let Some(hint) = module_hint
            && let Some(idx) = self
                .server_fns
                .iter()
                .position(|f| f.name == method && (f.module_key == hint || f.module_key.starts_with(&format!("{hint}/"))))
        {
            return Some(idx);
        }
        let matches: Vec<usize> = self.server_fns.iter().enumerate().filter(|(_, f)| f.name == method).map(|(i, _)| i).collect();
        if matches.len() == 1 {
            return Some(matches[0]);
        }
        None
    }
}

fn run_op(index: &Index, query: &str, layer: Option<Layer>, json: bool) -> Result<i32, String> {
    let Some(resolved) = index.resolve_op(query) else {
        if json {
            let err = serde_json::json!({ "found": false, "query": query, "error": format!("unknown protocol op `{query}`") });
            println!("{}", serde_json::to_string_pretty(&err).map_err(|e| e.to_string())?);
        } else {
            eprintln!("xtask trace: unknown op or subscription `{query}`");
        }
        return Ok(1);
    };

    if let Some(&ep_idx) = index.op_to_idx.get(&resolved) {
        let ep = &index.endpoints[ep_idx];
        let mut layers = OpLayers::default();

        if Layer::allows(layer, Layer::Contract) {
            layers.contract.push(ep.loc.clone());
            if let Some(id_loc) = &ep.id_loc {
                layers.contract.push(id_loc.clone());
            }
        }

        if Layer::allows(layer, Layer::Ts) {
            if let Some(gen_ep) = index.ts_gen_endpoints.get(&ep.op) {
                layers.ts.push(gen_ep.loc.clone());
            }
            if let Some(api_list) = index.ts_api_entries.get(&ep.op) {
                for entry in api_list {
                    layers.ts.push(entry.loc.clone());
                }
            }
            if let Some(client_locs) = index.ts_client_calls.get(&ep.op) {
                for loc in client_locs {
                    layers.ts.push(loc.clone());
                }
            }
        }

        let mut server_locs = Vec::new();
        let mut core_locs = Vec::new();
        if let Some(variant) = &ep.variant
            && let Some(arm) = index.router_arms.get(variant)
        {
            (server_locs, core_locs) = index.resolve_server_chain(&arm.target_expr);
        } else if ep.native {
            let native_expr = match ep.op.as_str() {
                "attachment.file" => "st.file_async()",
                "media.input.file" => "st.input_content_async()",
                "media.input.uploadFile" => "st.upload_input_file_async()",
                _ => "pj::dispatch_native_domain_async()",
            };
            (server_locs, core_locs) = index.resolve_server_chain(native_expr);
        }

        if Layer::allows(layer, Layer::Gateway) {
            if ep.native {
                if ep.op == "attachment.file" {
                    for (route, loc) in &index.http_routes {
                        if route == "/api/v1/attachment/{id}" || route == "http::attachment" {
                            layers.gateway.push(loc.clone());
                        }
                    }
                } else {
                    for (route, loc) in &index.http_routes {
                        if route.contains("/api/v1/media/input") || route == "http::command" {
                            layers.gateway.push(loc.clone());
                        }
                    }
                }
                if let Some(loc) = index.router_meta.get("dispatch_op_async") {
                    layers.gateway.push(loc.clone());
                }
            } else {
                for (route, loc) in &index.http_routes {
                    if route == "/api/v1/{*path}" || route == "http::command" {
                        layers.gateway.push(loc.clone());
                    }
                }
                for (label, loc) in &index.bridge_handlers {
                    if label == "bridge::call_with" || label == "bridge::client_call" {
                        layers.gateway.push(loc.clone());
                    }
                }
                if let Some(variant) = &ep.variant
                    && let Some(arm) = index.router_arms.get(variant)
                {
                    layers.gateway.push(arm.loc.clone());
                }
            }
        }

        if Layer::allows(layer, Layer::Server) {
            layers.server = server_locs;
        }
        if Layer::allows(layer, Layer::Core) {
            layers.core = core_locs;
        }
        if Layer::allows(layer, Layer::Client)
            && let Some(calls) = index.client_ops.get(&ep.op)
        {
            layers.clients = calls.clone();
        }

        let report = OpTraceReport {
            kind: "op",
            query: query.to_owned(),
            resolved_op: ep.op.clone(),
            variant: ep.variant.clone(),
            module: ep.module.clone(),
            native: ep.native,
            can: ep.can.clone(),
            about: ep.about.clone(),
            dry_run: ep.dry_run.clone(),
            input: ep.input.clone(),
            result: ep.result.clone(),
            layers,
        };

        if json {
            println!("{}", serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?);
        } else {
            print_op_human(&report);
        }
        return Ok(0);
    }

    // Subscription trace fallback when query names a subscription like `channel.follow`
    if let Some(&sub_idx) = index.sub_to_idx.get(&resolved) {
        let sub = &index.subscriptions[sub_idx];
        let mut layers = OpLayers::default();
        if Layer::allows(layer, Layer::Contract) {
            layers.contract.push(sub.loc.clone());
        }
        if Layer::allows(layer, Layer::Ts) {
            if let Some(loc) = index.ts_gen_subscriptions.get(&sub.name) {
                layers.ts.push(loc.clone());
            }
            if let Some(loc) = index.ts_api_subscriptions.get(&sub.name) {
                layers.ts.push(loc.clone());
            }
        }
        if Layer::allows(layer, Layer::Gateway) {
            for (route, loc) in &index.http_routes {
                if route == "/api/v1/subscribe/{name}" || route == "http::subscribe" || (sub.name == "issue.watch" && route.contains("issue/watch")) {
                    layers.gateway.push(loc.clone());
                }
            }
            for (label, loc) in &index.bridge_handlers {
                if label == "bridge::subscribe" {
                    layers.gateway.push(loc.clone());
                }
            }
            if let Some(loc) = index.router_meta.get("open_sub_async") {
                layers.gateway.push(loc.clone());
            }
        }
        if Layer::allows(layer, Layer::Server)
            && let Some(locs) = index.server_subs.get(&sub.name)
        {
            layers.server = locs.clone();
        }
        if Layer::allows(layer, Layer::Client)
            && let Some(calls) = index.client_subs.get(&sub.name)
        {
            layers.clients = calls.clone();
        }
        let report = OpTraceReport {
            kind: "subscription",
            query: query.to_owned(),
            resolved_op: sub.name.clone(),
            variant: None,
            module: sub.module.clone(),
            native: false,
            can: sub.can.clone(),
            about: Vec::new(),
            dry_run: None,
            input: Some(sub.payload.clone()),
            result: Some(sub.event.clone()),
            layers,
        };
        if json {
            println!("{}", serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?);
        } else {
            print_op_human(&report);
        }
        return Ok(0);
    }

    Ok(1)
}

fn run_slice(index: &Index, query: &str, layer: Option<Layer>, json: bool) -> Result<i32, String> {
    let norm = query.trim().to_ascii_lowercase();
    let Some(slice) = index.slices.get(&norm) else {
        if json {
            let err = serde_json::json!({ "found": false, "query": query, "error": format!("unknown slice `{query}`") });
            println!("{}", serde_json::to_string_pretty(&err).map_err(|e| e.to_string())?);
        } else {
            let known: Vec<&str> = index.slices.keys().map(String::as_str).collect();
            eprintln!("xtask trace: unknown slice `{query}` (known: {})", known.join(", "));
        }
        return Ok(1);
    };

    let mut layers = SliceLayers::default();
    if Layer::allows(layer, Layer::Contract) {
        layers.contract = slice.locs.clone();
    }
    if Layer::allows(layer, Layer::Ts)
        && let Some(locs) = index.ts_slices.get(&norm)
    {
        layers.ts = locs.clone();
    }
    if Layer::allows(layer, Layer::Gateway) {
        for (route, loc) in &index.http_routes {
            if route == "/api/v1/slice/{name}" || route == "http::slice" {
                layers.gateway.push(loc.clone());
            }
        }
        for (label, loc) in &index.bridge_handlers {
            if label == "bridge::watch" || label == "bridge::pump_slice" {
                layers.gateway.push(loc.clone());
            }
        }
        for key in ["slice_snapshot_json_async", "subscribe_slice_async", "watch_slice"] {
            if let Some(loc) = index.router_meta.get(key) {
                layers.gateway.push(loc.clone());
            }
        }
    }
    if Layer::allows(layer, Layer::Server) {
        if let Some(locs) = index.server_slice_projections.get(&norm) {
            for loc in locs {
                push_unique_loc(&mut layers.server, loc.clone());
            }
        }
        for emitter in &index.server_emitters {
            if emitter.slices.iter().any(|s| s == &norm || s == "all") {
                push_unique_loc(&mut layers.server, emitter.loc.clone());
            }
        }
    }
    if Layer::allows(layer, Layer::Core) {
        if let Some(locs) = index.core_slice_projections.get(&norm) {
            for loc in locs {
                push_unique_loc(&mut layers.core, loc.clone());
            }
        }
        for reducer in &index.core_reducers {
            if reducer.slices.iter().any(|s| s == &norm || s == "all") {
                let mut loc = reducer.loc.clone();
                loc.detail = Some(format!("-> SliceMask::{}", reducer.slices.join(" | ").to_ascii_uppercase()));
                push_unique_loc(&mut layers.core, loc);
            }
        }
    }
    if Layer::allows(layer, Layer::Client)
        && let Some(calls) = index.client_slices.get(&norm)
    {
        layers.clients = calls.clone();
    }

    let report = SliceTraceReport {
        kind: "slice",
        slice: slice.name.clone(),
        variant: slice.variant.clone(),
        layers,
    };

    if json {
        println!("{}", serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?);
    } else {
        print_slice_human(&report);
    }
    Ok(0)
}

fn run_orphans(index: &Index, json: bool) -> Result<i32, String> {
    let mut dry_run_reverse: BTreeMap<String, String> = BTreeMap::new();
    for ep in &index.endpoints {
        if let Some(dry) = &ep.dry_run {
            dry_run_reverse.insert(dry.clone(), ep.op.clone());
        }
    }

    let mut orphans = Vec::new();
    let mut gaps = Vec::new();
    let mut multi_covered = 0usize;

    for ep in &index.endpoints {
        let calls = index.client_ops.get(&ep.op).cloned().unwrap_or_default();
        let distinct_clients: BTreeSet<&str> = calls.iter().map(|c| c.client.as_str()).collect();
        if distinct_clients.is_empty() {
            orphans.push(OrphanEndpoint {
                op: ep.op.clone(),
                variant: ep.variant.clone(),
                module: ep.module.clone(),
                native: ep.native,
                can: ep.can.clone(),
                dry_run_of: dry_run_reverse.get(&ep.op).cloned(),
                file: ep.loc.file.clone(),
                line: ep.loc.line,
            });
        } else if distinct_clients.len() == 1 {
            let present = (*distinct_clients.iter().next().unwrap_or(&"unknown")).to_owned();
            let missing_from: Vec<String> = ["mac", "mobile", "cli"].into_iter().filter(|c| *c != present).map(str::to_owned).collect();
            gaps.push(SingleClientGap {
                op: ep.op.clone(),
                variant: ep.variant.clone(),
                module: ep.module.clone(),
                can: ep.can.clone(),
                present_in: present,
                missing_from,
                callers: calls,
            });
        } else {
            multi_covered += 1;
        }
    }

    let report = OrphansReport {
        kind: "orphans",
        summary: OrphansSummary {
            total_endpoints: index.endpoints.len(),
            zero_caller_orphans: orphans.len(),
            single_client_gaps: gaps.len(),
            multi_client_covered: multi_covered,
        },
        orphans,
        single_client_gaps: gaps,
    };

    if json {
        println!("{}", serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?);
    } else {
        print_orphans_human(&report);
    }
    Ok(0)
}

fn print_op_human(report: &OpTraceReport) {
    let header_id = report.variant.as_deref().map(|v| format!("EndpointId::{v}, ")).unwrap_or_default();
    let native_tag = if report.native { ", native" } else { "" };
    println!("{}: {} ({header_id}module: {}{native_tag})", report.kind, report.resolved_op, report.module);
    println!(
        "  can: [{}]  input: {}  result: {}{}",
        report.can.join(", "),
        report.input.as_deref().unwrap_or("none"),
        report.result.as_deref().unwrap_or("void"),
        report.dry_run.as_deref().map(|d| format!("  dryRun: {d}")).unwrap_or_default()
    );

    print_tree_layers(
        &report.layers.contract,
        &report.layers.ts,
        &report.layers.gateway,
        &report.layers.server,
        &report.layers.core,
        &report.layers.clients,
    );
}

fn print_slice_human(report: &SliceTraceReport) {
    println!("slice: {} (SliceKind::{})", report.slice, report.variant);
    print_tree_layers(
        &report.layers.contract,
        &report.layers.ts,
        &report.layers.gateway,
        &report.layers.server,
        &report.layers.core,
        &report.layers.clients,
    );
}

fn print_tree_layers(contract: &[Loc], ts: &[Loc], gateway: &[Loc], server: &[Loc], core: &[Loc], clients: &[ClientCall]) {
    let client_locs: Vec<Loc> = clients.iter().map(ClientCall::to_loc).collect();
    let client_summary = format!(
        "[6] Clients (mac: {}, mobile: {}, cli: {})",
        clients.iter().filter(|c| c.client.starts_with("mac")).count(),
        clients.iter().filter(|c| c.client == "mobile").count(),
        clients.iter().filter(|c| c.client == "cli").count(),
    );

    let sections: [(&str, &[Loc]); 6] = [
        ("[1] Contract (Rust)", contract),
        ("[2] Protocol (TS)", ts),
        ("[3] Gateway & Router", gateway),
        ("[4] Server Services & Emitters", server),
        ("[5] Core Reducers & Projections", core),
        (&client_summary, &client_locs),
    ];

    for (idx, (title, locs)) in sections.iter().enumerate() {
        let is_last_section = idx + 1 == sections.len();
        let branch = if is_last_section { "└─" } else { "├─" };
        let child_prefix = if is_last_section { "   " } else { "│  " };
        println!("{branch} {title}");
        if locs.is_empty() {
            println!("{child_prefix} └─ (none)");
            continue;
        }
        for (j, loc) in locs.iter().enumerate() {
            let item_branch = if j + 1 == locs.len() { "└─" } else { "├─" };
            println!("{child_prefix} {item_branch} {}", loc.format_human());
        }
    }
}

fn print_orphans_human(report: &OrphansReport) {
    println!(
        "orphans: {} endpoints total | {} zero-caller orphans | {} single-client gaps | {} multi-client",
        report.summary.total_endpoints, report.summary.zero_caller_orphans, report.summary.single_client_gaps, report.summary.multi_client_covered
    );

    println!("\nZero-caller orphans ({}):", report.orphans.len());
    for o in &report.orphans {
        let native_tag = if o.native { " [native]" } else { "" };
        let dry_tag = o.dry_run_of.as_deref().map(|p| format!(" [dryRun of {p}]")).unwrap_or_default();
        println!("  - {} ({}:{}, can=[{}]){native_tag}{dry_tag}", o.op, o.file, o.line, o.can.join(", "));
    }

    println!("\nSingle-client coverage gaps ({}):", report.single_client_gaps.len());
    for g in &report.single_client_gaps {
        let first_loc = g.callers.first().map(|c| format!("{}:{}", c.file, c.line)).unwrap_or_default();
        println!(
            "  - {} [only: {} ({}), missing: {}] (can=[{}])",
            g.op,
            g.present_in,
            first_loc,
            g.missing_from.join(", "),
            g.can.join(", ")
        );
    }
}

fn read_optional_file(root: &Path, rel: &str) -> Result<Option<String>, String> {
    let full = root.join(rel);
    if !full.is_file() {
        return Ok(None);
    }
    fs::read_to_string(&full)
        .map(Some)
        .map_err(|err| format!("failed to read {}: {err}", full.display()))
}

fn is_ts_source(rel: &str) -> bool {
    rel.ends_with(".ts") || rel.ends_with(".tsx")
}

fn is_ts_test_or_fixture(rel: &str) -> bool {
    rel.ends_with(".test.ts")
        || rel.ends_with(".test.tsx")
        || rel.ends_with(".spec.ts")
        || rel.ends_with(".spec.tsx")
        || rel.ends_with(".stories.ts")
        || rel.ends_with(".stories.tsx")
        || rel.contains("/fixtures/")
        || rel.contains("/__tests__/")
}

fn find_const_array_region<'a>(clean: &'a str, const_name: &str) -> Option<(usize, &'a str)> {
    let mut cursor = 0usize;
    while let Some(rel) = clean[cursor..].find(const_name) {
        let anchor = cursor + rel;
        let before_ok = is_word_boundary_before(clean.as_bytes(), anchor);
        let after = &clean[anchor + const_name.len()..];
        let after_ok = after.trim_start().starts_with(':') || after.trim_start().starts_with('=');
        if before_ok && after_ok {
            let eq = anchor + clean[anchor..].find('=')?;
            let slice_start = eq + clean[eq..].find('[')?;
            let slice_end = find_matching_delim(clean, slice_start, b'[', b']')?;
            return Some((slice_start, &clean[slice_start..=slice_end]));
        }
        cursor = anchor + const_name.len();
    }
    None
}

fn strip_rust_comments_keep_strings_non_test(raw: &str, file_path: &str) -> String {
    let no_comments = strip_rust_comments_keep_strings(raw);
    let no_lit = strip_rust_comments_and_literals(raw);
    let no_cfg = strip_cfg_test_and_collect_excluded(raw, &no_lit, file_path).code;
    // `no_cfg` has whitespace across every `#[cfg(test)]` item; advance until the next
    // non-whitespace byte in `no_cfg` so string literals inside `#[cfg(test)]` are blanked too.
    let mut out = no_comments.into_bytes();
    let nl = no_lit.as_bytes();
    let nc = no_cfg.as_bytes();
    let mut i = 0usize;
    while i < nl.len().min(nc.len()) {
        if nl[i] != nc[i] {
            while i < nc.len() && nc[i].is_ascii_whitespace() {
                if i < out.len() && out[i] != b'\n' {
                    out[i] = b' ';
                }
                i += 1;
            }
        } else {
            i += 1;
        }
    }
    String::from_utf8(out).expect("comment/test stripper preserves UTF-8")
}

/// Strips `//` and nested `/* ... */` comments while preserving string/char literals and 1-based line offsets.
fn strip_rust_comments_keep_strings(source: &str) -> String {
    let bytes = source.as_bytes();
    let len = bytes.len();
    let mut out = Vec::with_capacity(len);
    let mut i = 0usize;

    while i < len {
        let ch = bytes[i];
        let next = bytes.get(i + 1).copied();

        if ch == b'/' && next == Some(b'/') {
            while i < len && bytes[i] != b'\n' {
                out.push(b' ');
                i += 1;
            }
            continue;
        }
        if ch == b'/' && next == Some(b'*') {
            out.extend_from_slice(b"  ");
            i += 2;
            let mut depth = 1usize;
            while i < len && depth > 0 {
                if bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'*') {
                    out.extend_from_slice(b"  ");
                    depth += 1;
                    i += 2;
                } else if bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/') {
                    out.extend_from_slice(b"  ");
                    depth -= 1;
                    i += 2;
                } else {
                    out.push(if bytes[i] == b'\n' { b'\n' } else { b' ' });
                    i += 1;
                }
            }
            continue;
        }

        let prev_is_ident = i > 0 && is_ident_char(bytes[i - 1]);
        if !prev_is_ident && ((ch == b'r' && (next == Some(b'"') || next == Some(b'#'))) || ((ch == b'b' || ch == b'c') && next == Some(b'r'))) {
            let start = i;
            let mut cursor = if ch == b'r' { i + 1 } else { i + 2 };
            let mut hashes = 0usize;
            while cursor < len && bytes[cursor] == b'#' {
                hashes += 1;
                cursor += 1;
            }
            if bytes.get(cursor) == Some(&b'"') {
                cursor += 1;
                while cursor < len {
                    if bytes[cursor] == b'"' {
                        let mut matched = 0usize;
                        while matched < hashes && bytes.get(cursor + 1 + matched) == Some(&b'#') {
                            matched += 1;
                        }
                        if matched == hashes {
                            cursor += 1 + hashes;
                            break;
                        }
                    }
                    cursor += 1;
                }
                out.extend_from_slice(&bytes[start..cursor]);
                i = cursor;
                continue;
            }
        }

        if ch == b'"' || (!prev_is_ident && (ch == b'b' || ch == b'c') && next == Some(b'"')) {
            let start = i;
            i = if ch == b'"' { i + 1 } else { i + 2 };
            while i < len {
                if bytes[i] == b'\\' {
                    i = (i + 2).min(len);
                    continue;
                }
                if bytes[i] == b'"' {
                    i += 1;
                    break;
                }
                i += 1;
            }
            out.extend_from_slice(&bytes[start..i]);
            continue;
        }

        out.push(ch);
        i += 1;
    }

    String::from_utf8(out).expect("Rust comment stripper preserves UTF-8")
}

/// Strips TS `//` and `/* ... */` comments while preserving `'...'`, `"..."`, template literals, and line offsets.
fn strip_ts_comments_keep_strings(source: &str) -> String {
    let bytes = source.as_bytes();
    let len = bytes.len();
    let mut out = Vec::with_capacity(len);
    let mut i = 0usize;

    while i < len {
        let ch = bytes[i];
        let next = bytes.get(i + 1).copied();

        if ch == b'/' && next == Some(b'/') {
            while i < len && bytes[i] != b'\n' {
                out.push(b' ');
                i += 1;
            }
            continue;
        }
        if ch == b'/' && next == Some(b'*') {
            out.extend_from_slice(b"  ");
            i += 2;
            while i < len {
                if bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/') {
                    out.extend_from_slice(b"  ");
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
            let start = i;
            i += 1;
            while i < len {
                if bytes[i] == b'\\' {
                    i = (i + 2).min(len);
                    continue;
                }
                if bytes[i] == quote {
                    i += 1;
                    break;
                }
                i += 1;
            }
            out.extend_from_slice(&bytes[start..i]);
            continue;
        }

        out.push(ch);
        i += 1;
    }

    String::from_utf8(out).expect("TS comment stripper preserves UTF-8")
}

fn find_matching_delim(text: &str, open_pos: usize, open: u8, close: u8) -> Option<usize> {
    let bytes = text.as_bytes();
    if bytes.get(open_pos) != Some(&open) {
        return None;
    }
    let mut depth = 0usize;
    let mut i = open_pos;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'"' || b == b'\'' && is_single_char_or_ts_quote(bytes, i) {
            i = skip_quoted_literal(bytes, i, b);
            continue;
        }
        if b == open {
            depth += 1;
        } else if b == close {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

fn is_single_char_or_ts_quote(bytes: &[u8], pos: usize) -> bool {
    if bytes.get(pos) != Some(&b'\'') {
        return false;
    }
    let after = bytes.get(pos + 1).copied();
    after == Some(b'\\') || bytes.get(pos + 2) == Some(&b'\'')
}

fn skip_quoted_literal(bytes: &[u8], start: usize, quote: u8) -> usize {
    let mut i = start + 1;
    while i < bytes.len() {
        if bytes[i] == b'\\' {
            i = (i + 2).min(bytes.len());
            continue;
        }
        if bytes[i] == quote {
            return i + 1;
        }
        i += 1;
    }
    bytes.len()
}

fn variant_or_op_key(op: &str) -> &str {
    op
}

fn read_ident(text: &str) -> &str {
    let bytes = text.as_bytes();
    let Some(&first) = bytes.first() else { return "" };
    if !is_ident_start(first) {
        return "";
    }
    let mut end = 1usize;
    while end < bytes.len() && is_ident_char(bytes[end]) {
        end += 1;
    }
    &text[..end]
}

fn extract_quoted_at(text: &str, quote_pos: usize) -> Option<String> {
    let bytes = text.as_bytes();
    let quote = *bytes.get(quote_pos)?;
    if quote != b'"' && quote != b'\'' {
        return None;
    }
    let mut i = quote_pos + 1;
    let mut out = String::new();
    while i < bytes.len() {
        if bytes[i] == b'\\' {
            if let Some(&esc) = bytes.get(i + 1) {
                out.push(esc as char);
                i += 2;
                continue;
            }
            break;
        }
        if bytes[i] == quote {
            return Some(out);
        }
        let ch = text[i..].chars().next()?;
        out.push(ch);
        i += ch.len_utf8();
    }
    None
}

fn extract_first_quoted(text: &str) -> Option<String> {
    let trimmed = text.trim_start();
    if trimmed.starts_with('"') || trimmed.starts_with('\'') {
        return extract_quoted_at(trimmed, 0);
    }
    None
}

fn find_field_pos(block: &str, field: &str) -> Option<usize> {
    let mut cursor = 0usize;
    while let Some(rel) = block[cursor..].find(field) {
        let pos = cursor + rel;
        let before_ok = pos == 0 || !is_ident_char(block.as_bytes()[pos - 1]);
        let after = &block[pos + field.len()..];
        let trimmed = after.trim_start();
        if before_ok && trimmed.starts_with(':') {
            return Some(pos + field.len() + (after.len() - trimmed.len()) + 1);
        }
        cursor = pos + field.len();
    }
    None
}

fn find_field_string_pos(block: &str, field: &str) -> Option<usize> {
    let val_start = find_field_pos(block, field)?;
    let rest = block[val_start..].trim_start();
    if rest.starts_with('"') {
        Some(val_start + (block[val_start..].len() - rest.len()))
    } else {
        None
    }
}

fn find_field_string(block: &str, field: &str) -> Option<String> {
    let q_pos = find_field_string_pos(block, field)?;
    extract_quoted_at(block, q_pos)
}

fn find_field_some_string(block: &str, field: &str) -> Option<String> {
    let val_start = find_field_pos(block, field)?;
    let rest = block[val_start..].trim_start();
    let inner = rest.strip_prefix("Some(")?.trim_start();
    extract_first_quoted(inner)
}

fn find_field_string_list(block: &str, field: &str) -> Vec<String> {
    let Some(val_start) = find_field_pos(block, field) else { return Vec::new() };
    let rest = block[val_start..].trim_start();
    let Some(bracket) = rest.find('[') else { return Vec::new() };
    let Some(end) = find_matching_delim(rest, bracket, b'[', b']') else {
        return Vec::new();
    };
    let inner = &rest[bracket + 1..end];
    collect_all_quoted(inner)
}

fn find_caller_list(block: &str, field: &str) -> Vec<String> {
    let Some(val_start) = find_field_pos(block, field) else { return Vec::new() };
    let rest = block[val_start..].trim_start();
    let Some(bracket) = rest.find('[') else { return Vec::new() };
    let Some(end) = find_matching_delim(rest, bracket, b'[', b']') else {
        return Vec::new();
    };
    let inner = &rest[bracket + 1..end];
    let mut out = Vec::new();
    let mut cursor = 0usize;
    while let Some(rel) = inner[cursor..].find("Caller::") {
        let pos = cursor + rel + "Caller::".len();
        let role = read_ident(&inner[pos..]);
        if !role.is_empty() {
            out.push(role.to_ascii_lowercase());
        }
        cursor = pos + role.len();
    }
    out
}

fn find_ts_prop_string_pos(obj: &str, prop: &str) -> Option<usize> {
    let val_start = find_field_pos(obj, prop)?;
    let rest = obj[val_start..].trim_start();
    if rest.starts_with('"') || rest.starts_with('\'') {
        Some(val_start + (obj[val_start..].len() - rest.len()))
    } else {
        None
    }
}

fn find_ts_prop_string(obj: &str, prop: &str) -> Option<String> {
    let q_pos = find_ts_prop_string_pos(obj, prop)?;
    extract_quoted_at(obj, q_pos)
}

fn find_ts_string_array_prop(obj: &str, prop: &str) -> Vec<String> {
    let Some(val_start) = find_field_pos(obj, prop) else { return Vec::new() };
    let rest = obj[val_start..].trim_start();
    if !rest.starts_with('[') {
        return Vec::new();
    }
    let Some(end) = find_matching_delim(rest, 0, b'[', b']') else {
        return Vec::new();
    };
    collect_all_quoted(&rest[1..end])
}

fn find_ts_prop_expr(obj: &str, prop: &str) -> Option<String> {
    let val_start = find_field_pos(obj, prop)?;
    let rest = obj[val_start..].trim_start();
    let end = find_top_level_comma_or_brace(rest);
    let expr = collapse_ws(rest[..end].trim());
    (!expr.is_empty()).then_some(expr)
}

fn find_top_level_comma_or_brace(text: &str) -> usize {
    let bytes = text.as_bytes();
    let mut paren = 0usize;
    let mut brace = 0usize;
    let mut bracket = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'"' || b == b'\'' {
            i = skip_quoted_literal(bytes, i, b);
            continue;
        }
        match b {
            b'(' => paren += 1,
            b')' => paren = paren.saturating_sub(1),
            b'{' => brace += 1,
            b'}' => {
                if brace == 0 && paren == 0 && bracket == 0 {
                    return i;
                }
                brace = brace.saturating_sub(1);
            }
            b'[' => bracket += 1,
            b']' => bracket = bracket.saturating_sub(1),
            b',' if paren == 0 && brace == 0 && bracket == 0 => return i,
            _ => {}
        }
        i += 1;
    }
    bytes.len()
}

fn format_ts_endpoint_detail(input: Option<&str>, result: Option<&str>, can: &[String]) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(i) = input {
        parts.push(format!("input={i}"));
    }
    if let Some(r) = result {
        parts.push(format!("result={r}"));
    }
    if !can.is_empty() {
        parts.push(format!("can=[{}]", can.join(", ")));
    }
    (!parts.is_empty()).then(|| parts.join(", "))
}

fn collect_all_quoted(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'"' || bytes[i] == b'\'' {
            if let Some(val) = extract_quoted_at(text, i) {
                out.push(val);
            }
            i = skip_quoted_literal(bytes, i, bytes[i]);
        } else {
            i += 1;
        }
    }
    out
}

fn find_fn_def(text: &str, name: &str) -> Option<usize> {
    let needle = format!("fn {name}");
    let mut cursor = 0usize;
    while let Some(rel) = text[cursor..].find(&needle) {
        let pos = cursor + rel;
        let before_ok = pos == 0 || !is_ident_char(text.as_bytes()[pos - 1]);
        let after = text[pos + needle.len()..].trim_start();
        if before_ok && (after.starts_with('(') || after.starts_with('<')) {
            return Some(pos);
        }
        cursor = pos + needle.len();
    }
    None
}

fn find_fn_body_open(text: &str, from: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut i = from;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => return Some(i),
            b';' => return None,
            _ => i += 1,
        }
    }
    None
}

fn find_next_enum_arm(text: &str) -> Option<(&'static str, usize)> {
    let e_pos = text.find("E::");
    let full_pos = text.find("EndpointId::");
    match (e_pos, full_pos) {
        (Some(a), Some(b)) if a <= b => Some(("E::", a)),
        (Some(_), Some(b)) => Some(("EndpointId::", b)),
        (Some(a), None) => Some(("E::", a)),
        (None, Some(b)) => Some(("EndpointId::", b)),
        (None, None) => None,
    }
}

fn find_match_arm_end(text: &str, start: usize) -> usize {
    let bytes = text.as_bytes();
    let mut paren = 0usize;
    let mut brace = 0usize;
    let mut bracket = 0usize;
    let mut i = start;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'"' {
            i = skip_quoted_literal(bytes, i, b'"');
            continue;
        }
        match b {
            b'(' => paren += 1,
            b')' => paren = paren.saturating_sub(1),
            b'{' => brace += 1,
            b'}' => {
                if brace == 0 && paren == 0 && bracket == 0 {
                    return i;
                }
                brace = brace.saturating_sub(1);
                if brace == 0 && paren == 0 && bracket == 0 {
                    let after = text[i + 1..].trim_start();
                    if !after.starts_with('.') && !after.starts_with("else") {
                        return i + 1;
                    }
                }
            }
            b'[' => bracket += 1,
            b']' => bracket = bracket.saturating_sub(1),
            b',' if paren == 0 && brace == 0 && bracket == 0 => return i,
            _ => {}
        }
        i += 1;
    }
    bytes.len()
}

fn summarize_router_expr(expr: &str) -> Option<String> {
    let calls = extract_method_calls_with_receivers(expr);
    if calls.is_empty() {
        let collapsed = collapse_ws(expr);
        return (!collapsed.is_empty()).then_some(collapsed);
    }
    let summary: Vec<String> = calls
        .into_iter()
        .take(2)
        .map(|(recv, method)| match recv {
            Some(r) => format!("{r}.{method}"),
            None => method,
        })
        .collect();
    Some(summary.join(" -> "))
}

fn extract_method_calls_with_receivers(expr: &str) -> Vec<(Option<String>, String)> {
    let mut out = Vec::new();
    let bytes = expr.as_bytes();
    let mut i = 0usize;

    while i < bytes.len() {
        if expr[i..].starts_with("pj::") {
            let fn_start = i + "pj::".len();
            let name = read_ident(&expr[fn_start..]);
            if !name.is_empty() {
                out.push((Some("pj".to_owned()), name.to_owned()));
            }
            i = fn_start + name.len();
            continue;
        }
        if bytes[i] == b'.' {
            let method = read_ident(&expr[i + 1..]);
            if !method.is_empty() && expr[i + 1 + method.len()..].trim_start().starts_with('(') {
                let recv = read_receiver_before(expr, i);
                if method != "await" {
                    out.push((recv, method.to_owned()));
                }
                i += 1 + method.len();
                continue;
            }
        }
        i += 1;
    }
    out
}

fn read_receiver_before(expr: &str, dot_pos: usize) -> Option<String> {
    let bytes = expr.as_bytes();
    let mut end = dot_pos;
    while end > 0 && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    let mut start = end;
    while start > 0 && (is_ident_char(bytes[start - 1]) || bytes[start - 1] == b'.') {
        start -= 1;
    }
    let recv = expr[start..end].trim_matches('.');
    (!recv.is_empty()).then(|| recv.to_owned())
}

fn collect_callee_names(body: &str) -> Vec<String> {
    let mut out = BTreeSet::new();
    for (recv, method) in extract_method_calls_with_receivers(body) {
        if let Some(r) = recv
            && (r == "self"
                || r.starts_with("self.")
                || r.starts_with("c.")
                || r.starts_with("core.")
                || matches!(r.as_str(), "pj" | "s" | "art" | "pr" | "orch" | "dbg" | "ch" | "rt" | "med" | "lib" | "st"))
        {
            out.insert(method);
        }
    }
    out.into_iter().collect()
}

fn collect_core_calls(body: &str) -> Vec<String> {
    let mut out = BTreeSet::new();
    let mut cursor = 0usize;
    while let Some(rel) = body[cursor..].find("vibevalley_core::") {
        let pos = cursor + rel + "vibevalley_core::".len();
        let mut ident = read_ident(&body[pos..]);
        let mut scan = pos + ident.len();
        while body[scan..].starts_with("::") {
            scan += 2;
            let next = read_ident(&body[scan..]);
            if next.is_empty() {
                break;
            }
            ident = next;
            scan += next.len();
        }
        if !ident.is_empty() && ident.starts_with(|c: char| c.is_ascii_lowercase()) {
            out.insert(ident.to_owned());
        }
        cursor = scan.max(pos + 1);
    }
    out.into_iter().collect()
}

fn collect_prefixed_variants(body: &str, prefix: &str) -> Vec<String> {
    let mut out = BTreeSet::new();
    let mut cursor = 0usize;
    while let Some(rel) = body[cursor..].find(prefix) {
        let pos = cursor + rel + prefix.len();
        let variant = read_ident(&body[pos..]);
        if !variant.is_empty() {
            out.insert(variant.to_owned());
        }
        cursor = pos + variant.len().max(1);
    }
    out.into_iter().collect()
}

fn extract_slice_mask_names(text: &str) -> Vec<String> {
    let mut out = BTreeSet::new();
    let mut cursor = 0usize;
    while let Some(rel) = text[cursor..].find("SliceMask::") {
        let pos = cursor + rel + "SliceMask::".len();
        let mask = read_ident(&text[pos..]);
        let lower = match mask {
            "BOARD" => Some("board"),
            "SESSIONS" => Some("sessions"),
            "COLLAB" => Some("collab"),
            "INBOX" => Some("inbox"),
            "OPS" => Some("ops"),
            "FARM" => Some("farm"),
            "ALL" => Some("all"),
            "NONE" => Some("none"),
            _ => None,
        };
        if let Some(s) = lower {
            out.insert(s.to_owned());
        }
        cursor = pos + mask.len().max(1);
    }
    out.into_iter().collect()
}

fn server_module_key(file: &str) -> String {
    let trimmed = file.strip_prefix("crates/server/src/").unwrap_or(file);
    let trimmed = trimmed.strip_suffix(".rs").unwrap_or(trimmed);
    let trimmed = trimmed.strip_suffix("/mod").unwrap_or(trimmed);
    match trimmed {
        "issue/board" | "issue/store" | "issue/chat" | "issue/edit" | "issue/family" | "issue/refine" => "issue".to_owned(),
        _ if trimmed.starts_with("issue/pull") => "issue/pull".to_owned(),
        _ if trimmed.starts_with("agent/memory") => "agent/memory".to_owned(),
        _ if trimmed.starts_with("agent/") => "agent".to_owned(),
        _ if trimmed.starts_with("artifact/media") => "artifact/media".to_owned(),
        _ if trimmed.starts_with("artifact/library") => "artifact/library".to_owned(),
        _ if trimmed.starts_with("artifact/") => "artifact".to_owned(),
        _ if trimmed.starts_with("channel/") => "channel".to_owned(),
        _ if trimmed.starts_with("runtime/") => "runtime".to_owned(),
        _ if trimmed.starts_with("gateway/remote") => "gateway/remote".to_owned(),
        _ if trimmed.starts_with("connector/") => "connector".to_owned(),
        _ if trimmed.starts_with("cron/") => "cron".to_owned(),
        _ if trimmed.starts_with("debug/") => "debug".to_owned(),
        _ if trimmed.starts_with("machine/") => "machine".to_owned(),
        _ if trimmed.starts_with("provider/") => "provider".to_owned(),
        _ if trimmed.starts_with("repo/") => "repo".to_owned(),
        _ if trimmed.starts_with("setting/") => "setting".to_owned(),
        _ if trimmed.starts_with("storage/") => "storage".to_owned(),
        _ if trimmed.starts_with("voice/") => "voice".to_owned(),
        other => other.to_owned(),
    }
}

fn extract_impl_type_name(header: &str) -> Option<String> {
    let trimmed = header.trim();
    let after_impl = trimmed.strip_prefix("impl")?;
    let mut s = after_impl.trim_start();
    if s.starts_with('<')
        && let Some(end) = find_matching_delim(s, 0, b'<', b'>')
    {
        s = s[end + 1..].trim_start();
    }
    if let Some(for_pos) = s.find(" for ") {
        s = s[for_pos + " for ".len()..].trim_start();
    }
    let name = read_ident(s);
    (!name.is_empty()).then(|| name.to_owned())
}

fn parse_dotted_call_chain(rest: &str) -> Option<(String, usize)> {
    let mut parts = Vec::new();
    let mut cursor = 0usize;
    loop {
        let seg = read_ident(&rest[cursor..]);
        if seg.is_empty() {
            return None;
        }
        parts.push(seg);
        cursor += seg.len();
        let after = rest[cursor..].trim_start();
        let ws = rest[cursor..].len() - after.len();
        if let Some(after_dot) = after.strip_prefix('.') {
            let ws2 = after_dot.len() - after_dot.trim_start().len();
            cursor += ws + 1 + ws2;
            continue;
        }
        if after.starts_with('(') && parts.len() >= 2 {
            return Some((parts.join("."), cursor + ws));
        }
        return None;
    }
}

fn is_word_boundary_before(bytes: &[u8], pos: usize) -> bool {
    pos == 0 || !is_ident_char(bytes[pos - 1])
}

fn collapse_ws(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn capitalize_ascii(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
        None => String::new(),
    }
}

fn push_unique_loc(list: &mut Vec<Loc>, loc: Loc) {
    if !list.contains(&loc) {
        list.push(loc);
    }
}

fn sort_and_dedup_calls(list: &mut Vec<ClientCall>) {
    list.sort();
    list.dedup();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

    struct TempTree {
        root: PathBuf,
    }

    impl TempTree {
        fn new(name: &str) -> Self {
            let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!("vibevalley_trace_test_{name}_{}_{}", std::process::id(), seq));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).expect("create temp root");
            Self { root }
        }

        fn write(&self, rel: &str, content: &str) {
            let full = self.root.join(rel);
            if let Some(parent) = full.parent() {
                fs::create_dir_all(parent).expect("create temp parent dirs");
            }
            fs::write(full, content).expect("write temp file");
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn build_synthetic_repo() -> TempTree {
        let tree = TempTree::new("synthetic");

        // Layer 1: Rust contract
        tree.write(
            "crates/protocol/src/contract/endpoints.rs",
            r#"
pub const ENDPOINTS: &[Endpoint] = &[
    Endpoint {
        op: "issue.list",
        module: "issue",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("IssueFilter"),
        result: Some("Vec<Issue>"),
    },
    Endpoint {
        op: "issue.create",
        module: "issue",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("IssueRequest"),
        result: Some("AppliedIssue"),
    },
    Endpoint {
        op: "issue.delete",
        module: "issue",
        about: &["id"],
        can: &[Caller::User],
        dry_run: Some("issue.previewDelete"),
        input: Some("IssueDeleteInput"),
        result: None,
    },
    Endpoint {
        op: "issue.previewDelete",
        module: "issue",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("IssueDeleteInput"),
        result: Some("Preview"),
    },
    Endpoint {
        op: "unused.internal",
        module: "debug",
        about: &[],
        can: &[Caller::Orchestrator],
        dry_run: None,
        input: None,
        result: None,
    },
];

endpoint_ids! {
    IssueList => "issue.list",
    IssueCreate => "issue.create",
    IssueDelete => "issue.delete",
    IssuePreviewDelete => "issue.previewDelete",
    UnusedInternal => "unused.internal",
}

pub const SUBSCRIPTIONS: &[SubscriptionSpec] = &[
    SubscriptionSpec {
        name: "channel.follow",
        module: "channel",
        can: &[Caller::User],
        payload: "ChannelFollowPayload",
        event: "ChannelEvent",
    },
];
"#,
        );

        tree.write(
            "crates/protocol/src/native.rs",
            r#"
pub const NATIVE_ENDPOINTS: &[Endpoint] = &[
    Endpoint {
        op: "attachment.file",
        module: "attachment",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("AttachmentFileInput"),
        result: Some("AttachmentFile"),
    },
];
impl NativeEndpointId {
    pub fn from_op(op: &str) -> Option<Self> {
        match op {
            "attachment.file" => Some(Self::AttachmentFile),
            _ => None,
        }
    }
}
"#,
        );

        tree.write(
            "crates/protocol/src/contract/core.rs",
            r#"
pub enum SliceKind {
    Board,
    Inbox,
}
pub struct BoardSlice { pub seq: i64 }
pub struct InboxSlice { pub seq: i64 }
pub enum Fact {
    IssueChanged(FactIssueChanged),
    CallChanged(FactCallChanged),
}
"#,
        );

        // Layer 2: TS protocol
        tree.write(
            "packages/protocol/src/endpoints.gen.ts",
            r#"
export const servedEndpoints = [
  { op: "issue.list", can: ["user", "remote"], about: [] },
  { op: "issue.create", can: ["user"], about: [] },
  { op: "attachment.file", can: ["user", "remote"], about: [] },
] as const;
"#,
        );
        tree.write(
            "packages/protocol/src/issue/api.ts",
            r#"
export interface IssueHandlers {
  readonly "issue.list": (a: T.IssueFilter) => Promise<T.Issue[]>;
  readonly "issue.create": (a: T.IssueRequest) => Promise<T.AppliedIssue>;
}
export const issueEndpoints = [
  { op: "issue.list", about: [], input: S.IssueFilter, result: z.array(S.Issue), can: ["user", "remote"] },
  {
    op: "issue.create",
    about: [],
    input: S.IssueRequest,
    result: S.AppliedIssue,
    can: ["user"],
  },
];
"#,
        );
        tree.write(
            "packages/protocol/src/client.ts",
            r#"
export class VibeValleyApi {
  readonly issue = {
    list: (a: T.IssueFilter): Promise<T.Issue[]> => this.call<T.Issue[]>("issue.list", "/api/v1/issue/list", a),
    create: (a: T.IssueRequest): Promise<T.AppliedIssue> => this.call<T.AppliedIssue>("issue.create", "/api/v1/issue/create", a),
  };
}
"#,
        );
        tree.write(
            "packages/protocol/src/core/shapes.gen.ts",
            r#"
export const SliceKindValues = ["board", "inbox"] as const;
export type BoardSlice = { seq: number };
"#,
        );

        // Layer 3: Gateway & Router
        tree.write(
            "crates/server/src/gateway/http/mod.rs",
            r#"
fn authenticated_api_routes() -> Router<HttpState> {
    Router::new()
        .route("/api/v1/slice/{name}", get(slice).post(command))
        .route("/api/v1/attachment/{id}", get(attachment).post(command))
        .route("/api/v1/{*path}", post(command).get(not_allowed))
}
async fn command() {}
async fn slice() {}
async fn attachment() {}
"#,
        );
        tree.write(
            "crates/server/src/gateway/bridge/bridge.rs",
            r#"
impl BridgeRpc for Bridge {
    fn call_with(&self, ctx: CallerContext, op: String, payload: Value, reply: impl FnOnce(Envelope)) {}
}
impl Client {
    pub fn watch(&self, topic: &str) -> Result<(), String> { Ok(()) }
}
impl ClientRpc for Client {
    fn call(&self, id: &str, op: String, payload: Value) {}
    fn subscribe(&self, id: &str, name: &str, payload: Value) {}
}
"#,
        );
        tree.write(
            "crates/server/src/router.rs",
            r#"
impl Router {
    async fn dispatch_op_async(&self) {}
    fn dispatch_endpoint_async(&self, ctx: &CallerContext, id: EndpointId, p: Value) {
        let (brd, dbg) = (&c.board, &c.debug);
        match id {
            E::IssueList => on!(p, IssueList, |r| brd.issue_list_endpoint_async(&r).await?),
            E::IssueCreate => on!(p, IssueCreate, |r| brd.issue_create_endpoint_async(&r).await?),
            E::IssueDelete => void!(p, IssueDelete, |r| brd.issue_delete_endpoint_async(&r.id).await?),
            E::IssuePreviewDelete => on!(p, IssuePreviewDelete, |r| brd.issue_preview_delete_endpoint_async(&r.id).await?),
            E::UnusedInternal => ret!(ok_json(dbg.noop())),
        }
    }
}
"#,
        );

        // Layer 4: Server services & emitters
        tree.write(
            "crates/server/src/issue/mod.rs",
            r#"
impl Board {
    pub(crate) async fn issue_list_endpoint_async(&self, filter: &IssueFilter) -> Result<Vec<Issue>, ApiError> {
        Ok(vibevalley_core::pick_issues(&[], filter, 0))
    }
    pub(crate) async fn issue_create_endpoint_async(&self, req: &IssueRequest) -> Result<AppliedIssue, ApiError> {
        self.create_from_request_async(req).await
    }
    pub async fn create_from_request_async(&self, req: &IssueRequest) -> Result<AppliedIssue, ApiError> {
        self.ctx.mark_dirty(SliceMask::BOARD | SliceMask::INBOX);
        Ok(AppliedIssue::default())
    }
    pub(crate) async fn issue_delete_endpoint_async(&self, id: &str) -> Result<(), ApiError> {
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn ignored_test_emitter() {
        let _ = SliceMask::FARM;
    }
}
"#,
        );
        tree.write(
            "crates/server/src/projection.rs",
            r#"
pub(crate) async fn project_slice_json(core: &AppCore, kind: SliceKind, seq: i64) {
    match kind {
        SliceKind::Board => project_board(),
        SliceKind::Inbox => project_inbox(),
    }
}
pub(crate) async fn dispatch_native_domain_async(s: &Storage, input: NativeEndpointInput) {
    s.file_async(&id).await
}
"#,
        );
        tree.write(
            "crates/server/src/storage/mod.rs",
            r#"
impl Storage {
    pub async fn file_async(&self, id: &str) -> Result<AttachmentFile, ApiError> { Ok(Default::default()) }
}
"#,
        );

        // Layer 5: Core reducers & projections
        tree.write(
            "crates/core/src/core.rs",
            r#"
pub fn reduce(state: &mut SpaceState, fact: &Fact) -> SliceMask {
    SliceMask::NONE
}
fn fold(state: &mut SpaceState, f: &Fact) -> (SliceMask, bool) {
    match f {
        Fact::IssueChanged(f) => {
            let dirty = SliceMask::BOARD | SliceMask::INBOX;
            (dirty, true)
        }
        Fact::CallChanged(f) => (SliceMask::INBOX, false),
    }
}
pub fn board_slice() {}
"#,
        );
        tree.write(
            "crates/core/src/projection.rs",
            r#"
pub fn project_board() {}
pub fn project_inbox() {}
"#,
        );
        tree.write(
            "crates/core/src/status.rs",
            r#"
pub fn pick_issues(all: &[Issue]) -> Vec<Issue> { vec![] }
"#,
        );

        // Layer 6: Clients (Mac UI, Mobile, CLI)
        tree.write(
            "apps/mac/ui/features/issue/IssuesPage.tsx",
            r#"
// api.unused.internal() should be stripped
const rows = await api.issue.list({});
const created = await api.issue.create({ title: "hi" });
const board = useBoardSlice();
"#,
        );
        tree.write(
            "apps/mac/ui/infra/attachmentFile.ts",
            r#"
const f = await callData("attachment.file", { id });
"#,
        );
        tree.write(
            "apps/mac/ui/features/issue/IssuesPage.test.tsx",
            r#"
await api.unused.internal();
"#,
        );
        tree.write(
            "apps/mobile/src/features/IssuesTab.tsx",
            r#"
await props.session.call("issue.list", {});
session.slice("board", () => {});
"#,
        );
        tree.write(
            "crates/cli/src/domains/work/issue.rs",
            r#"
pub fn run(client: &Client) {
    let _ = client.ask::<ops::IssueList>(&());
    let _ = client.mutate::<ops::IssueDelete>("issue delete", &());
    client.sse("/api/v1/slice/board", None, |_| Ok(true));
}
#[cfg(test)]
mod tests {
    fn dummy() {
        let _ = client.ask::<ops::UnusedInternal>(&());
    }
}
"#,
        );

        tree
    }

    #[test]
    fn help_returns_zero() {
        assert_eq!(run(Path::new("."), &["--help".to_owned()]), Ok(0));
        assert_eq!(run(Path::new("."), &["-h".to_owned()]), Ok(0));
    }

    #[test]
    fn invalid_args_return_two() {
        assert_eq!(run(Path::new("."), &[]), Ok(2));
        assert_eq!(run(Path::new("."), &["op".to_owned()]), Ok(2));
        assert_eq!(run(Path::new("."), &["--unknown".to_owned()]), Ok(2));
        assert_eq!(
            run(Path::new("."), &["op".to_owned(), "x".to_owned(), "--layer".to_owned(), "bogus".to_owned()]),
            Ok(2)
        );
    }

    #[test]
    fn comment_stripping_preserves_strings_and_lines() {
        let src = [
            "// \"fake.op\"",
            "/* nested /* \"comment.op\" */ */",
            "const OP: &str = \"real.op // not comment\";",
            "#[cfg(test)]",
            "mod tests { const T: &str = \"test.op { }\"; }",
        ]
        .join("\n");
        let clean = strip_rust_comments_keep_strings_non_test(&src, "x.rs");
        assert_eq!(clean.split('\n').count(), src.split('\n').count());
        assert!(!clean.contains("fake.op"));
        assert!(!clean.contains("comment.op"));
        assert!(!clean.contains("test.op"));
        assert!(clean.contains("real.op // not comment"));
    }

    #[test]
    fn synthetic_repo_traces_all_six_layers_for_ops_slices_and_orphans() {
        let tree = build_synthetic_repo();
        let index = Index::build(&tree.root).expect("index synthetic repo");

        // 1. Contract endpoints & native endpoints
        assert_eq!(index.endpoints.len(), 6);
        assert_eq!(index.resolve_op("IssueList").as_deref(), Some("issue.list"));
        assert_eq!(index.resolve_op("EndpointId::IssueCreate").as_deref(), Some("issue.create"));
        assert_eq!(index.resolve_op("attachment.file").as_deref(), Some("attachment.file"));

        // 2. Server chain for issue.create traces into mark_dirty + core reducer
        let create_arm = index.router_arms.get("IssueCreate").expect("IssueCreate arm");
        let (srv_create, core_create) = index.resolve_server_chain(&create_arm.target_expr);
        assert!(srv_create.iter().any(|l| l.symbol.contains("issue_create_endpoint_async")));
        assert!(
            srv_create
                .iter()
                .any(|l| l.symbol.contains("create_from_request_async") && l.detail.as_deref().unwrap_or("").contains("board"))
        );
        assert!(core_create.iter().any(|l| l.symbol.contains("Fact::IssueChanged")));

        // 3. Read-only issue.list resolves to pick_issues and zero mark_dirty
        let list_arm = index.router_arms.get("IssueList").expect("IssueList arm");
        let (srv_list, core_list) = index.resolve_server_chain(&list_arm.target_expr);
        assert!(srv_list.iter().any(|l| l.symbol.contains("issue_list_endpoint_async") && l.detail.is_none()));
        assert!(core_list.iter().any(|l| l.symbol == "vibevalley_core::pick_issues"));

        // 4. Native endpoint attachment.file resolves to Storage::file_async
        let (srv_native, _) = index.resolve_server_chain("pj::dispatch_native_domain_async()");
        assert!(srv_native.iter().any(|l| l.symbol.contains("file_async")));

        // 5. Client callers exclude tests & comments
        let list_callers = index.client_ops.get("issue.list").expect("issue.list callers");
        let list_clients: BTreeSet<&str> = list_callers.iter().map(|c| c.client.as_str()).collect();
        assert_eq!(list_clients, BTreeSet::from(["cli", "mac", "mobile"]));
        assert!(!index.client_ops.contains_key("unused.internal"));

        // 6. Orphans & single-client gaps
        let create_clients: BTreeSet<&str> = index.client_ops["issue.create"].iter().map(|c| c.client.as_str()).collect();
        assert_eq!(create_clients, BTreeSet::from(["mac"]));

        // 7. Slice trace & CLI run exit codes
        assert_eq!(run(&tree.root, &["op".to_owned(), "issue.list".to_owned(), "--json".to_owned()]), Ok(0));
        assert_eq!(run(&tree.root, &["slice".to_owned(), "board".to_owned(), "--json".to_owned()]), Ok(0));
        assert_eq!(run(&tree.root, &["orphans".to_owned(), "--json".to_owned()]), Ok(0));
        assert_eq!(run(&tree.root, &["op".to_owned(), "does.not.exist".to_owned()]), Ok(1));
        assert_eq!(run(&tree.root, &["slice".to_owned(), "unknown".to_owned()]), Ok(1));

        // 8. Slice board emitters & core reducers stay isolated across block arms without commas
        assert!(
            index
                .server_emitters
                .iter()
                .any(|e| e.slices.contains(&"board".to_owned()) && !e.slices.contains(&"farm".to_owned()))
        );
        let call_reducer = index
            .core_reducers
            .iter()
            .find(|r| r.fact_variant == "CallChanged")
            .expect("CallChanged reducer");
        assert_eq!(call_reducer.slices, vec!["inbox".to_owned()]);
        let issue_reducer = index
            .core_reducers
            .iter()
            .find(|r| r.fact_variant == "IssueChanged")
            .expect("IssueChanged reducer");
        assert_eq!(issue_reducer.slices, vec!["board".to_owned(), "inbox".to_owned()]);
        let board_subs = index.client_slices.get("board").expect("board slice subs");
        let board_clients: BTreeSet<&str> = board_subs.iter().map(|c| c.client.as_str()).collect();
        assert_eq!(board_clients, BTreeSet::from(["cli", "mac", "mobile"]));
    }
}
