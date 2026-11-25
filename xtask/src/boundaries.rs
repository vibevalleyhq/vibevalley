//! Static module boundary enforcement for `crates/server` and `apps/mac`.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::Path;

use crate::rust_scan::{
    LineIndex, SourceFile, is_excluded_by_cfg_test, is_ident_char, is_ident_start, strip_cfg_test_and_collect_excluded, strip_rust_comments_and_literals,
    walk_matching_files,
};

const TOPOLOGY_DOC: &str = "docs/architecture.md";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum BoundaryRule {
    SpineNoModuleImport,
    MacNoServerModuleImport,
    ServerLayerDag,
    ServerModulesAcyclic,
    SeaOrmBoundary,
    ServerDbBoundary,
    OneTableOneEntityFile,
    LegacyServerDirs,
}

impl BoundaryRule {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SpineNoModuleImport => "spine-no-module-import",
            Self::MacNoServerModuleImport => "mac-no-server-module-import",
            Self::ServerLayerDag => "server-layer-dag",
            Self::ServerModulesAcyclic => "server-modules-acyclic",
            Self::SeaOrmBoundary => "no-sea-orm-outside-service",
            Self::ServerDbBoundary => "no-db-outside-service",
            Self::OneTableOneEntityFile => "one-table-one-entity-file",
            Self::LegacyServerDirs => "no-legacy-dirs",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundaryViolation {
    pub rule: BoundaryRule,
    pub file: String,
    pub line: usize,
    pub message: String,
    pub fix: String,
    pub details: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layer {
    L1,
    L2,
    L3,
}

impl Layer {
    fn as_str(self) -> &'static str {
        match self {
            Self::L1 => "L1",
            Self::L2 => "L2",
            Self::L3 => "L3",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerDomain {
    Issue,
    Artifact,
    Memory,
    Connector,
    Voice,
}

impl PeerDomain {
    fn as_str(self) -> &'static str {
        match self {
            Self::Issue => "issue",
            Self::Artifact => "artifact",
            Self::Memory => "agent/memory",
            Self::Connector => "connector",
            Self::Voice => "voice",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModuleClassification {
    pub layer: Layer,
    pub peer_domain: Option<PeerDomain>,
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
struct EdgeOccurrence {
    file: String,
    line: usize,
    snippet: String,
}

pub struct AuditBoundariesResult {
    pub files_scanned: usize,
    pub violations: Vec<BoundaryViolation>,
}

fn is_known_domain(domain: &str) -> bool {
    matches!(
        domain,
        "setting"
            | "provider"
            | "repo"
            | "storage"
            | "debug"
            | "machine"
            | "runtime"
            | "channel"
            | "connector"
            | "voice"
            | "artifact"
            | "issue"
            | "agent"
            | "cron"
            | "game"
    )
}

fn is_server_internal_module(name: &str) -> bool {
    is_known_domain(name) || matches!(name, "db" | "service" | "context" | "log" | "fake")
}

pub fn classify_server_module(module_id: &str) -> Option<ModuleClassification> {
    match module_id {
        "setting" | "provider" | "repo" | "storage" | "debug" | "machine" | "runtime" | "channel" | "agent/profile" => Some(ModuleClassification {
            layer: Layer::L1,
            peer_domain: None,
        }),
        "issue" => Some(ModuleClassification {
            layer: Layer::L2,
            peer_domain: Some(PeerDomain::Issue),
        }),
        "artifact" => Some(ModuleClassification {
            layer: Layer::L2,
            peer_domain: Some(PeerDomain::Artifact),
        }),
        "agent/memory" => Some(ModuleClassification {
            layer: Layer::L2,
            peer_domain: Some(PeerDomain::Memory),
        }),
        "connector" => Some(ModuleClassification {
            layer: Layer::L2,
            peer_domain: Some(PeerDomain::Connector),
        }),
        "voice" => Some(ModuleClassification {
            layer: Layer::L2,
            peer_domain: Some(PeerDomain::Voice),
        }),
        "cron" | "game" | "agent" | "agent/tool" | "agent/mcp" | "agent/orchestrator" => Some(ModuleClassification {
            layer: Layer::L3,
            peer_domain: None,
        }),
        _ => None,
    }
}

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
        // Handle `pub(crate) use ...`, `pub(super) use ...`, `pub(in ...) use ...`.
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

fn extract_path_refs(code: &str) -> Vec<PathRef> {
    let tokens = tokenize_rust(code);
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

        if tok.kind == TokenKind::Ident && tok.text == "use" && tokens.get(i + 1).is_none_or(|t| t.text != "<") && is_use_statement_position(&tokens, i) {
            let mods = active_inline_mods(&brace_stack);
            i = parse_use_tree(&tokens, i + 1, &[], &mods, &mut refs);
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
            && matches!(head.text.as_str(), "crate" | "vibevalley_server" | "super" | "self")
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

fn server_file_module_path(file_path: &str) -> Option<Vec<String>> {
    let prefix = "crates/server/src/";
    let rest = file_path.strip_prefix(prefix)?.strip_suffix(".rs")?;
    let mut parts: Vec<String> = rest.split('/').map(str::to_owned).collect();
    if parts.last().is_some_and(|p| p == "mod") {
        parts.pop();
    }
    let domain = parts.first()?;
    if !is_known_domain(domain) {
        return None;
    }
    Some(parts)
}

fn server_module_id_of_file(file_path: &str) -> Option<String> {
    let mod_path = server_file_module_path(file_path)?;
    let first = mod_path.first()?;
    if first == "agent" {
        return match mod_path.get(1) {
            Some(sub) => Some(format!("agent/{sub}")),
            None => Some("agent".to_owned()),
        };
    }
    Some(first.clone())
}

fn is_spine_file(file_path: &str) -> bool {
    file_path == "crates/server/src/lib.rs"
        || (file_path.starts_with("crates/server/src/log/") && file_path.ends_with(".rs"))
        || (file_path.starts_with("crates/server/src/db/") && file_path.ends_with(".rs"))
        || (file_path.starts_with("crates/server/src/service/") && file_path.ends_with(".rs"))
        || (file_path.starts_with("crates/server/src/context/") && file_path.ends_with(".rs"))
        || (file_path.starts_with("crates/server/src/gateway/") && file_path.ends_with(".rs"))
}

fn spine_target_domain_path(file_path: &str, path_ref: &PathRef) -> Option<String> {
    let segs = &path_ref.segments;
    if segs.first().is_some_and(|s| s == "crate") && segs.get(1).is_some_and(|s| is_known_domain(s)) {
        return Some(segs.join("::"));
    }
    if file_path == "crates/server/src/lib.rs"
        && ((segs.first().is_some_and(|s| s == "self") && segs.get(1).is_some_and(|s| is_known_domain(s))) || segs.first().is_some_and(|s| is_known_domain(s)))
    {
        return Some(segs.join("::"));
    }
    if segs.first().is_some_and(|s| s == "super")
        && let Some(rest) = file_path.strip_prefix("crates/server/src/").and_then(|r| r.strip_suffix(".rs"))
    {
        let mut base: Vec<String> = rest.split('/').map(str::to_owned).collect();
        if base.last().is_some_and(|p| p == "mod") {
            base.pop();
        }
        base.extend(path_ref.inline_mods.iter().cloned());
        let mut idx = 0usize;
        while segs.get(idx).is_some_and(|s| s == "super") {
            base.pop()?;
            idx += 1;
        }
        base.extend(segs[idx..].iter().cloned());
        if base.first().is_some_and(|s| is_known_domain(s)) {
            return Some(segs.join("::"));
        }
    }
    None
}

fn is_mac_source_file(file_path: &str) -> bool {
    (file_path.starts_with("apps/mac/src/") || file_path.starts_with("apps/mac/crates/")) && file_path.ends_with(".rs")
}

enum TargetResolution {
    Module(String),
    WildcardDomain(String),
}

fn resolve_target_server_module(path_ref: &PathRef, file_mod_path: &[String]) -> Option<TargetResolution> {
    let segs = &path_ref.segments;
    let resolved: Vec<String> = if segs.first().is_some_and(|s| s == "crate") {
        segs[1..].to_vec()
    } else if segs.first().is_some_and(|s| s == "super") {
        let mut base = file_mod_path.to_vec();
        base.extend(path_ref.inline_mods.iter().cloned());
        let mut idx = 0usize;
        while segs.get(idx).is_some_and(|s| s == "super") {
            base.pop()?;
            idx += 1;
        }
        base.extend(segs[idx..].iter().cloned());
        base
    } else {
        return None;
    };

    let domain = resolved.first()?;
    if !is_known_domain(domain) {
        return None;
    }
    let next = resolved.get(1);
    if next.is_some_and(|s| s == "*") {
        return Some(TargetResolution::WildcardDomain(domain.clone()));
    }
    if domain == "agent" {
        if let Some(sub) = next
            && is_snake_case_module_name(sub)
            && matches!(sub.as_str(), "profile" | "memory" | "tool" | "mcp" | "orchestrator")
        {
            return Some(TargetResolution::Module(format!("agent/{sub}")));
        }
        return Some(TargetResolution::Module("agent".to_owned()));
    }
    Some(TargetResolution::Module(domain.clone()))
}

const LEGACY_SERVER_DIRS: &[&str] = &[
    "app/",
    "infra/",
    "content/",
    "collab/",
    "team/",
    "work/",
    "skin/",
    "transport/",
    "fakes/",
    "db/entities/",
];

fn check_no_legacy_dirs(file_path: &str, violations: &mut Vec<BoundaryViolation>) {
    let Some(rel) = file_path.strip_prefix("crates/server/src/") else {
        return;
    };
    if let Some(dir) = LEGACY_SERVER_DIRS.iter().find(|prefix| rel.starts_with(*prefix)) {
        violations.push(BoundaryViolation {
            rule: BoundaryRule::LegacyServerDirs,
            file: file_path.to_owned(),
            line: 1,
            message: format!("legacy nested/plural directory `{dir}` is forbidden under `crates/server/src/`"),
            fix: format!("Place server modules flat and singular under `crates/server/src/`. See {TOPOLOGY_DOC}."),
            details: Vec::new(),
        });
    }
}

fn has_ident_boundaries(bytes: &[u8], start: usize, end: usize) -> bool {
    let before = start == 0 || !is_ident_char(bytes[start - 1]);
    let after = end >= bytes.len() || !is_ident_char(bytes[end]);
    before && after
}

fn check_no_sea_orm_outside_service(file_path: &str, code: &str, index: &LineIndex, violations: &mut Vec<BoundaryViolation>) {
    let Some(rel) = file_path.strip_prefix("crates/server/src/") else {
        return;
    };
    if !rel.ends_with(".rs") || rel.starts_with("db/") || rel.starts_with("service/") {
        return;
    }

    let bytes = code.as_bytes();
    let mut seen_lines = BTreeSet::new();
    for needle in ["sea_orm::", "sea_orm_migration::", "db::entity"] {
        let mut cursor = 0usize;
        while let Some(rel_idx) = code[cursor..].find(needle) {
            let start = cursor + rel_idx;
            let end = start + needle.len();
            cursor = end;
            let boundary_ok = if needle.ends_with("::") {
                start == 0 || !is_ident_char(bytes[start - 1])
            } else {
                has_ident_boundaries(bytes, start, end)
            };
            if !boundary_ok {
                continue;
            }
            let line = index.line_at(start);
            if seen_lines.insert(line) {
                violations.push(BoundaryViolation {
                    rule: BoundaryRule::SeaOrmBoundary,
                    file: file_path.to_owned(),
                    line,
                    message: format!("`{needle}` referenced outside `crates/server/src/{{db,service}}/` ({})", index.snippet_at(line)),
                    fix: "Move SeaORM / `db::entity` queries into `crates/server/src/service/` and call `ctx.db.*` methods instead.".to_owned(),
                    details: Vec::new(),
                });
            }
        }
    }
}

fn server_db_target_path(file_path: &str, path_ref: &PathRef) -> Option<String> {
    let segs = &path_ref.segments;
    if segs.first().is_some_and(|s| s == "crate") && segs.get(1).is_some_and(|s| s == "db") {
        // `db::entity` is already reported with a dedicated SeaORM message by `SeaOrmBoundary`.
        if segs.get(2).is_some_and(|s| s == "entity") {
            return None;
        }
        return Some(segs.join("::"));
    }
    if file_path == "crates/server/src/lib.rs" {
        if segs.first().is_some_and(|s| s == "self") && segs.get(1).is_some_and(|s| s == "db") {
            if segs.get(2).is_some_and(|s| s == "entity") {
                return None;
            }
            return Some(segs.join("::"));
        }
        if segs.first().is_some_and(|s| s == "db") {
            if segs.get(1).is_some_and(|s| s == "entity") {
                return None;
            }
            return Some(segs.join("::"));
        }
    }
    if segs.first().is_some_and(|s| s == "super")
        && let Some(rest) = file_path.strip_prefix("crates/server/src/").and_then(|r| r.strip_suffix(".rs"))
    {
        let mut base: Vec<String> = rest.split('/').map(str::to_owned).collect();
        if base.last().is_some_and(|p| p == "mod") {
            base.pop();
        }
        base.extend(path_ref.inline_mods.iter().cloned());
        let mut idx = 0usize;
        while segs.get(idx).is_some_and(|s| s == "super") {
            base.pop()?;
            idx += 1;
        }
        base.extend(segs[idx..].iter().cloned());
        if base.first().is_some_and(|s| s == "db") {
            if base.get(1).is_some_and(|s| s == "entity") {
                return None;
            }
            return Some(segs.join("::"));
        }
    }
    None
}

fn check_no_db_outside_service(file_path: &str, refs: &[PathRef], index: &LineIndex, violations: &mut Vec<BoundaryViolation>) {
    let Some(rel) = file_path.strip_prefix("crates/server/src/") else {
        return;
    };
    if !rel.ends_with(".rs") || rel.starts_with("db/") || rel.starts_with("service/") {
        return;
    }

    let mut seen_lines = BTreeSet::new();
    for path_ref in refs {
        let Some(target) = server_db_target_path(file_path, path_ref) else {
            continue;
        };
        let line = index.line_at(path_ref.offset);
        if seen_lines.insert(line) {
            violations.push(BoundaryViolation {
                rule: BoundaryRule::ServerDbBoundary,
                file: file_path.to_owned(),
                line,
                message: format!(
                    "direct `crate::db` import `{target}` outside `crates/server/src/{{db,service}}/` ({})",
                    index.snippet_at(line)
                ),
                fix: "Import `DbError`, `Tx`, `DatabaseConfig`, or `internal_db` from `crate::service::` instead of `crate::db::`.".to_owned(),
                details: Vec::new(),
            });
        }
    }
}

fn strip_comments_keep_strings(code: &str) -> String {
    let bytes = code.as_bytes();
    let len = bytes.len();
    let mut out = Vec::with_capacity(len);
    let mut i = 0usize;

    while i < len {
        let ch = bytes[i];
        if ch == b'/' && bytes.get(i + 1) == Some(&b'/') {
            while i < len && bytes[i] != b'\n' {
                out.push(b' ');
                i += 1;
            }
            continue;
        }
        if ch == b'/' && bytes.get(i + 1) == Some(&b'*') {
            out.push(b' ');
            out.push(b' ');
            i += 2;
            let mut depth = 1usize;
            while i < len && depth > 0 {
                if bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'*') {
                    depth += 1;
                    out.extend_from_slice(b"  ");
                    i += 2;
                } else if bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/') {
                    depth -= 1;
                    out.extend_from_slice(b"  ");
                    i += 2;
                } else {
                    out.push(if bytes[i] == b'\n' { b'\n' } else { b' ' });
                    i += 1;
                }
            }
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
                } else if b == b'"' {
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

fn check_one_table_one_entity_file(file_path: &str, raw: &str, index: &LineIndex, violations: &mut Vec<BoundaryViolation>) {
    let Some(file_name) = file_path.strip_prefix("crates/server/src/db/entity/") else {
        return;
    };
    if !file_name.ends_with(".rs") || file_name == "mod.rs" || file_name.contains('/') {
        return;
    }
    let stem = file_name.trim_end_matches(".rs");
    let stripped = strip_comments_keep_strings(raw);
    let mut tables: Vec<(usize, String)> = Vec::new();
    let mut cursor = 0usize;
    while let Some(rel_idx) = stripped[cursor..].find("table_name") {
        let start = cursor + rel_idx;
        let line = index.line_at(start);
        cursor = start + "table_name".len();
        let after_kw = stripped[cursor..].trim_start();
        if let Some(after_eq) = after_kw.strip_prefix('=') {
            let after_eq = after_eq.trim_start();
            if let Some(after_quote) = after_eq.strip_prefix('"')
                && let Some(end_quote) = after_quote.find('"')
            {
                tables.push((line, after_quote[..end_quote].to_owned()));
            }
        }
    }

    if tables.len() != 1 {
        let line = tables.first().map_or(1, |(l, _)| *l);
        violations.push(BoundaryViolation {
            rule: BoundaryRule::OneTableOneEntityFile,
            file: file_path.to_owned(),
            line,
            message: format!(
                "entity file `{file_name}` declares {} `table_name` attribute(s), expected exactly 1 (`{stem}`)",
                tables.len()
            ),
            fix: format!("Keep one `Model` with `#[sea_orm(table_name = \"{stem}\")]` in `db/entity/{file_name}`."),
            details: Vec::new(),
        });
    } else if tables[0].1 != stem {
        violations.push(BoundaryViolation {
            rule: BoundaryRule::OneTableOneEntityFile,
            file: file_path.to_owned(),
            line: tables[0].0,
            message: format!("entity file `{file_name}` declares `table_name = \"{}\"` instead of `\"{stem}\"`", tables[0].1),
            fix: format!("Rename the file or update `table_name` so `db/entity/{stem}.rs` owns table `{stem}`."),
            details: Vec::new(),
        });
    }
}

type ModuleGraph = BTreeMap<String, BTreeMap<String, Vec<EdgeOccurrence>>>;

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
                if scc.len() > 1 {
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

pub fn audit_files(files: &[SourceFile]) -> Vec<BoundaryViolation> {
    let mut sorted: Vec<SourceFile> = files
        .iter()
        .map(|f| SourceFile {
            path: f.path.replace('\\', "/"),
            text: f.text.clone(),
        })
        .collect();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));

    let mut preprocessed: BTreeMap<String, (String, String)> = BTreeMap::new();
    let mut excluded_targets = BTreeSet::new();

    for file in &sorted {
        if !file.path.ends_with(".rs") {
            continue;
        }
        let no_comments = strip_rust_comments_and_literals(&file.text);
        let stripped = strip_cfg_test_and_collect_excluded(&file.text, &no_comments, &file.path);
        for target in stripped.excluded_submodules {
            excluded_targets.insert(target);
        }
        preprocessed.insert(file.path.clone(), (stripped.code, file.text.clone()));
    }

    let mut violations = Vec::new();
    let mut graph: ModuleGraph = BTreeMap::new();

    for file in &sorted {
        if file.path.starts_with("apps/mac/crates/") && file.path.ends_with("/Cargo.toml") {
            if file.text.contains("vibevalley-server") {
                violations.push(BoundaryViolation {
                    rule: BoundaryRule::MacNoServerModuleImport,
                    file: file.path.clone(),
                    line: 1,
                    message: "desktop support crate depends on `vibevalley-server`".to_owned(),
                    fix: format!("Keep `apps/mac/crates/*` isolated from `vibevalley-server`. See {TOPOLOGY_DOC} Section 3.4."),
                    details: Vec::new(),
                });
            }
            continue;
        }

        if is_excluded_by_cfg_test(&file.path, &excluded_targets) {
            continue;
        }
        let Some((code, raw)) = preprocessed.get(&file.path) else {
            continue;
        };
        let index = LineIndex::new(raw);
        let refs = extract_path_refs(code);

        check_no_legacy_dirs(&file.path, &mut violations);
        check_no_sea_orm_outside_service(&file.path, code, &index, &mut violations);
        check_no_db_outside_service(&file.path, &refs, &index, &mut violations);
        check_one_table_one_entity_file(&file.path, raw, &index, &mut violations);

        if is_spine_file(&file.path) {
            let mut seen_lines = BTreeSet::new();
            for path_ref in &refs {
                let Some(target) = spine_target_domain_path(&file.path, path_ref) else {
                    continue;
                };
                let line = index.line_at(path_ref.offset);
                if !seen_lines.insert(line) {
                    continue;
                }
                violations.push(BoundaryViolation {
                    rule: BoundaryRule::SpineNoModuleImport,
                    file: file.path.clone(),
                    line,
                    message: format!("server spine/gateway imports concrete module `{target}` ({})", index.snippet_at(line)),
                    fix: format!(
                        "Move the narrow port trait into `crates/server/src/context/port.rs` or `crates/server/src/gateway/api/` and wire implementations in `app.rs`. See {TOPOLOGY_DOC}."
                    ),
                    details: Vec::new(),
                });
            }
            continue;
        }

        if is_mac_source_file(&file.path) {
            let mut seen_lines = BTreeSet::new();
            for path_ref in &refs {
                if path_ref.segments.first().is_none_or(|s| s != "vibevalley_server") || path_ref.segments.get(1).is_none_or(|s| !is_server_internal_module(s))
                {
                    continue;
                }
                let line = index.line_at(path_ref.offset);
                if !seen_lines.insert(line) {
                    continue;
                }
                violations.push(BoundaryViolation {
                    rule: BoundaryRule::MacNoServerModuleImport,
                    file: file.path.clone(),
                    line,
                    message: format!(
                        "desktop host imports server internal module `{}` ({})",
                        path_ref.segments.join("::"),
                        index.snippet_at(line)
                    ),
                    fix: format!(
                        "Consume narrow ports from `vibevalley_server::gateway::api` or protocol types from `vibevalley_protocol` instead of `vibevalley_server::<domain>::*`. See {TOPOLOGY_DOC}."
                    ),
                    details: Vec::new(),
                });
            }
            continue;
        }

        let Some(source_module) = server_module_id_of_file(&file.path) else {
            continue;
        };
        let Some(file_mod_path) = server_file_module_path(&file.path) else {
            continue;
        };

        graph.entry(source_module.clone()).or_default();
        let Some(source_class) = classify_server_module(&source_module) else {
            violations.push(BoundaryViolation {
                rule: BoundaryRule::ServerLayerDag,
                file: file.path.clone(),
                line: 1,
                message: format!("server module `{source_module}` is not classified in the L1-L3 architecture layers"),
                fix: format!("Classify `{source_module}` in xtask/src/boundaries.rs and document its layer in {TOPOLOGY_DOC} Section 3.2."),
                details: Vec::new(),
            });
            continue;
        };

        let mut seen_edge_on_line = BTreeSet::new();
        for path_ref in &refs {
            let Some(resolved) = resolve_target_server_module(path_ref, &file_mod_path) else {
                continue;
            };
            let line = index.line_at(path_ref.offset);
            let snippet = index.snippet_at(line).to_owned();

            match resolved {
                TargetResolution::WildcardDomain(wildcard_domain) => {
                    let key = format!("*:{wildcard_domain}:{line}");
                    if !seen_edge_on_line.insert(key) {
                        continue;
                    }
                    let source_domain = source_module.split('/').next().unwrap_or("");
                    if wildcard_domain != source_domain {
                        violations.push(BoundaryViolation {
                            rule: BoundaryRule::ServerLayerDag,
                            file: file.path.clone(),
                            line,
                            message: format!(
                                "`{source_module}` ({}) uses wildcard import from domain `{wildcard_domain}` ({snippet})",
                                source_class.layer.as_str()
                            ),
                            fix: format!(
                                "Replace wildcard domain imports with explicit L1 or same-domain imports, or route cross-domain calls through App / SliceProjector / app/port.rs. See {TOPOLOGY_DOC} Section 3.2.1."
                            ),
                            details: Vec::new(),
                        });
                    }
                }
                TargetResolution::Module(target_module) => {
                    if target_module == source_module {
                        continue;
                    }
                    let dedup_key = format!("{target_module}:{line}");
                    if !seen_edge_on_line.insert(dedup_key) {
                        continue;
                    }

                    graph
                        .entry(source_module.clone())
                        .or_default()
                        .entry(target_module.clone())
                        .or_default()
                        .push(EdgeOccurrence {
                            file: file.path.clone(),
                            line,
                            snippet: snippet.clone(),
                        });
                    graph.entry(target_module.clone()).or_default();

                    let Some(target_class) = classify_server_module(&target_module) else {
                        violations.push(BoundaryViolation {
                            rule: BoundaryRule::ServerLayerDag,
                            file: file.path.clone(),
                            line,
                            message: format!("`{source_module}` imports unclassified server module `{target_module}` ({snippet})"),
                            fix: format!("Classify `{target_module}` in xtask/src/boundaries.rs and {TOPOLOGY_DOC} Section 3.2."),
                            details: Vec::new(),
                        });
                        continue;
                    };

                    if source_class.layer == Layer::L1 && matches!(target_class.layer, Layer::L2 | Layer::L3) {
                        violations.push(BoundaryViolation {
                            rule: BoundaryRule::ServerLayerDag,
                            file: file.path.clone(),
                            line,
                            message: format!(
                                "L1 module `{source_module}` imports {} module `{target_module}` ({snippet})",
                                target_class.layer.as_str()
                            ),
                            fix: format!(
                                "L1 modules must have zero upward dependencies; inject a narrow port trait from crates/server/src/app/port.rs or mark slices dirty via SliceProjector. See {TOPOLOGY_DOC} Section 3.2."
                            ),
                            details: Vec::new(),
                        });
                    } else if source_class.layer == Layer::L2 && target_class.layer == Layer::L3 {
                        violations.push(BoundaryViolation {
                            rule: BoundaryRule::ServerLayerDag,
                            file: file.path.clone(),
                            line,
                            message: format!("L2 module `{source_module}` imports L3 module `{target_module}` ({snippet})"),
                            fix: format!(
                                "Invert the dependency with a narrow port trait in crates/server/src/app/port.rs or move shared pure helpers down to L1 (infra/text). See {TOPOLOGY_DOC} Section 3.2."
                            ),
                            details: Vec::new(),
                        });
                    } else if source_class.layer == Layer::L2
                        && target_class.layer == Layer::L2
                        && let (Some(src_peer), Some(dst_peer)) = (source_class.peer_domain, target_class.peer_domain)
                        && src_peer != dst_peer
                    {
                        violations.push(BoundaryViolation {
                            rule: BoundaryRule::ServerLayerDag,
                            file: file.path.clone(),
                            line,
                            message: format!(
                                "L2 cross-domain import `{source_module}` ({}) -> `{target_module}` ({}) ({snippet})",
                                src_peer.as_str(),
                                dst_peer.as_str()
                            ),
                            fix: format!(
                                "L2 peer domains (work, collab, content, team/memory) must not import each other directly; use App, Outbox, LiveOverlay, SliceProjector, or a narrow port in crates/server/src/app/port.rs. See {TOPOLOGY_DOC} Section 3.2.1."
                            ),
                            details: Vec::new(),
                        });
                    }
                }
            }
        }
    }

    let sccs = find_strongly_connected_components(&graph);
    for scc in sccs {
        let cycles = extract_cycles_from_scc(&scc, &graph);
        for cycle in cycles {
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
                hops.push(format!("{from} -> {to} ({where_str})"));
            }
            let cycle_label = format!("{} -> {}", cycle.join(" -> "), cycle[0]);
            violations.push(BoundaryViolation {
                rule: BoundaryRule::ServerModulesAcyclic,
                file: primary_file,
                line: primary_line,
                message: format!("directed cycle in server modules: {cycle_label}"),
                fix: format!(
                    "Break the module cycle by extracting shared data/ports downward or routing writes via App / Outbox / SliceProjector so crates/server/src/ domain modules form a strict DAG. See {TOPOLOGY_DOC} Section 3.2.2."
                ),
                details: hops,
            });
        }
    }

    violations
}

pub fn audit_workspace(root: &Path) -> Result<AuditBoundariesResult, String> {
    let files = walk_matching_files(root, &["crates/server/src", "apps/mac/src", "apps/mac/crates"], |rel| {
        rel.starts_with("crates/server/src/") && rel.ends_with(".rs")
            || rel.starts_with("apps/mac/src/") && rel.ends_with(".rs")
            || (rel.starts_with("apps/mac/crates/") && (rel.ends_with(".rs") || rel.ends_with("/Cargo.toml")))
    })?;
    let files_scanned = files.len();
    let violations = audit_files(&files);
    Ok(AuditBoundariesResult { files_scanned, violations })
}

pub fn format_violations(violations: &[BoundaryViolation]) -> String {
    let mut lines = Vec::new();
    for v in violations {
        lines.push(format!("[{}] {}:{}: {}", v.rule.as_str(), v.file, v.line, v.message));
        for detail in &v.details {
            lines.push(format!("  edge: {detail}"));
        }
        lines.push(format!("  Fix: {}", v.fix));
    }
    lines.join("\n")
}

pub fn run(root: &Path) -> Result<i32, String> {
    let result = audit_workspace(root)?;
    if !result.violations.is_empty() {
        let mut by_rule: BTreeMap<&str, usize> = BTreeMap::new();
        for v in &result.violations {
            *by_rule.entry(v.rule.as_str()).or_insert(0) += 1;
        }
        let summary = by_rule.iter().map(|(rule, count)| format!("{rule}={count}")).collect::<Vec<_>>().join(", ");
        eprintln!(
            "module boundaries: {} violation(s) ({summary})\n\n{}",
            result.violations.len(),
            format_violations(&result.violations)
        );
        return Ok(1);
    }
    println!(
        "module boundaries: {} files ok (spine, mac, L0-L3 DAG, acyclic, service/entity, flat layout)",
        result.files_scanned
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
    fn classifies_l1_l2_peer_domains_and_l3_modules() {
        for l1 in [
            "setting",
            "provider",
            "repo",
            "storage",
            "debug",
            "machine",
            "runtime",
            "channel",
            "agent/profile",
        ] {
            assert_eq!(
                classify_server_module(l1),
                Some(ModuleClassification {
                    layer: Layer::L1,
                    peer_domain: None
                })
            );
        }

        assert_eq!(
            classify_server_module("issue"),
            Some(ModuleClassification {
                layer: Layer::L2,
                peer_domain: Some(PeerDomain::Issue)
            })
        );
        assert_eq!(
            classify_server_module("artifact"),
            Some(ModuleClassification {
                layer: Layer::L2,
                peer_domain: Some(PeerDomain::Artifact)
            })
        );
        assert_eq!(
            classify_server_module("agent/memory"),
            Some(ModuleClassification {
                layer: Layer::L2,
                peer_domain: Some(PeerDomain::Memory)
            })
        );
        assert_eq!(
            classify_server_module("connector"),
            Some(ModuleClassification {
                layer: Layer::L2,
                peer_domain: Some(PeerDomain::Connector)
            })
        );
        assert_eq!(
            classify_server_module("voice"),
            Some(ModuleClassification {
                layer: Layer::L2,
                peer_domain: Some(PeerDomain::Voice)
            })
        );

        for l3 in ["cron", "game", "agent", "agent/tool", "agent/mcp", "agent/orchestrator"] {
            assert_eq!(
                classify_server_module(l3),
                Some(ModuleClassification {
                    layer: Layer::L3,
                    peer_domain: None
                })
            );
        }
    }

    #[test]
    fn spine_no_module_import_fails_on_lib_context_db_service_and_gateway() {
        let files = vec![
            sf("crates/server/src/lib.rs", "use crate::voice::Voice;\npub struct Server;"),
            sf(
                "crates/server/src/context/port.rs",
                "pub trait Recall { fn x(&self) -> crate::agent::memory::Note; }",
            ),
            sf("crates/server/src/service/issue.rs", "use crate::issue::Board;\n"),
            sf("crates/server/src/app.rs", "use crate::issue::Board;\n"),
            sf("crates/server/src/router.rs", "use crate::artifact::Manager;\n"),
            sf("crates/server/src/db/mod.rs", "pub fn bad() -> crate::runtime::Runtime { todo!() }"),
            sf(
                "crates/server/src/gateway/api/mod.rs",
                "pub trait Server {\n    fn voice(&self) -> Option<Arc<crate::voice::Voice>>;\n}",
            ),
        ];

        let violations = audit_files(&files);
        let tags: Vec<String> = violations.iter().map(|v| format!("{}@{}:{}", v.rule.as_str(), v.file, v.line)).collect();
        assert_eq!(
            tags,
            vec![
                "spine-no-module-import@crates/server/src/context/port.rs:1",
                "spine-no-module-import@crates/server/src/db/mod.rs:1",
                "spine-no-module-import@crates/server/src/gateway/api/mod.rs:2",
                "spine-no-module-import@crates/server/src/lib.rs:1",
                "spine-no-module-import@crates/server/src/service/issue.rs:1",
            ]
        );
        assert!(format_violations(&violations).contains("docs/architecture.md"));
    }

    #[test]
    fn spine_ignores_cfg_test_inline_and_external_submodules() {
        let files = vec![
            sf("crates/server/src/gateway/http/mod.rs", "use crate::Router;\n#[cfg(test)]\nmod tests;"),
            sf("crates/server/src/gateway/http/tests.rs", "use crate::storage::Storage;\n"),
            sf(
                "crates/server/src/lib.rs",
                "pub mod context;\n#[cfg(test)]\nmod tests { use crate::setting::Setting; }",
            ),
        ];
        assert!(audit_files(&files).is_empty());
    }

    #[test]
    fn mac_no_server_module_import_catches_use_and_inline_paths() {
        let files = vec![
            sf("apps/mac/src/live_voice.rs", "use vibevalley_server::voice::Voice;\n"),
            sf(
                "apps/mac/src/hosted/late.rs",
                "impl Server for LateServer {\n    fn voice(&self) -> Option<Arc<vibevalley_server::db::Database>> { None }\n}",
            ),
        ];
        let violations = audit_files(&files);
        let tags: Vec<String> = violations.iter().map(|v| format!("{}@{}:{}", v.rule.as_str(), v.file, v.line)).collect();
        assert_eq!(
            tags,
            vec![
                "mac-no-server-module-import@apps/mac/src/hosted/late.rs:2",
                "mac-no-server-module-import@apps/mac/src/live_voice.rs:1",
            ]
        );
    }

    #[test]
    fn mac_allows_gateway_api_and_ignores_comments() {
        let files = vec![
            sf(
                "apps/mac/src/live_voice.rs",
                "use vibevalley_server::gateway::api::SharedLiveVoice;\n// doc comment mentioning vibevalley_server::voice::Voice\npub fn start(_voice: SharedLiveVoice) {}",
            ),
            sf(
                "apps/mac/src/hosted/late.rs",
                "fn voice(&self) -> Option<vibevalley_server::gateway::api::SharedLiveVoice> { None }",
            ),
        ];
        assert!(audit_files(&files).is_empty());
    }

    #[test]
    fn server_layer_dag_fails_on_upward_and_cross_domain_imports() {
        let files = vec![
            sf("crates/server/src/agent/profile/mod.rs", "use crate::agent::memory::Memory;\n"),
            sf("crates/server/src/setting.rs", "use crate::agent::orchestrator::Orchestrator;\n"),
            sf("crates/server/src/voice/mod.rs", "use crate::agent::orchestrator::Orchestrator;\n"),
            sf("crates/server/src/artifact/mod.rs", "use crate::issue::Board;\n"),
            sf("crates/server/src/issue/board.rs", "use crate::connector::Connector;\n"),
        ];
        let violations: Vec<String> = audit_files(&files)
            .into_iter()
            .filter(|v| v.rule == BoundaryRule::ServerLayerDag)
            .map(|v| format!("{}:{}", v.file, v.line))
            .collect();
        assert_eq!(
            violations,
            vec![
                "crates/server/src/agent/profile/mod.rs:1",
                "crates/server/src/artifact/mod.rs:1",
                "crates/server/src/issue/board.rs:1",
                "crates/server/src/setting.rs:1",
                "crates/server/src/voice/mod.rs:1",
            ]
        );
    }

    #[test]
    fn resolves_relative_super_imports_and_grouped_use_trees() {
        let files = vec![
            sf("crates/server/src/runtime/session/mod.rs", "use super::super::cron::Scheduler;\n"),
            sf("crates/server/src/storage/mod.rs", "use super::{artifact::Manager, issue::Board};\n"),
        ];
        let violations = audit_files(&files);
        assert_eq!(violations.len(), 3);
        assert!(violations.iter().all(|v| v.rule == BoundaryRule::ServerLayerDag));
    }

    #[test]
    fn passes_valid_l0_to_l3_dag_and_excluded_cfg_test_files() {
        let files = vec![
            sf("crates/server/src/setting.rs", "pub struct Setting;\n"),
            sf("crates/server/src/provider.rs", "use crate::setting::Setting;\n"),
            sf("crates/server/src/storage/mod.rs", "pub struct Storage;\n"),
            sf("crates/server/src/agent/profile/mod.rs", "use crate::runtime::Runtime;\n"),
            sf("crates/server/src/runtime/mod.rs", "use crate::storage::Storage;\n"),
            sf("crates/server/src/channel/mod.rs", "use crate::storage::Storage;\n"),
            sf(
                "crates/server/src/issue/board.rs",
                "use crate::channel::Chat;\nuse crate::repo::Repo;\nuse crate::runtime::Runtime;\n",
            ),
            sf(
                "crates/server/src/artifact/mod.rs",
                "use crate::setting::Setting;\nuse crate::storage::Storage;\n",
            ),
            sf(
                "crates/server/src/connector/bridge.rs",
                "use crate::channel::Chat;\n#[cfg(test)]\n#[path = \"bridge_test.rs\"]\nmod tests;",
            ),
            sf("crates/server/src/connector/bridge_test.rs", "use crate::issue::Board;\n"),
            sf("crates/server/src/agent/tool/mod.rs", "use crate::agent::profile::Profile;\n"),
            sf("crates/server/src/agent/orchestrator/mod.rs", "use crate::agent::tool::ToolRegistry;\n"),
            sf("crates/server/src/agent/mcp/mod.rs", "use crate::context::port::ToolDispatchPort;\n"),
            sf("crates/server/src/game.rs", "use crate::repo::Repo;\n"),
            sf("crates/server/src/cron/mod.rs", "use crate::issue::Board;\n"),
        ];
        assert!(audit_files(&files).is_empty());
    }

    #[test]
    fn detects_2_node_and_3_node_module_cycles() {
        let two_node = vec![
            sf("crates/server/src/issue/mod.rs", "use crate::runtime::Runtime;\n"),
            sf("crates/server/src/runtime/mod.rs", "use crate::issue::Board;\n"),
        ];
        let violations: Vec<_> = audit_files(&two_node)
            .into_iter()
            .filter(|v| v.rule == BoundaryRule::ServerModulesAcyclic)
            .collect();
        assert_eq!(violations.len(), 1);
        assert!(violations[0].message.contains("issue -> runtime -> issue"));
        let formatted = format_violations(&violations);
        assert!(formatted.contains("crates/server/src/issue/mod.rs:1"));
        assert!(formatted.contains("crates/server/src/runtime/mod.rs:1"));

        let three_node = vec![
            sf("crates/server/src/agent/orchestrator/mod.rs", "use crate::agent::tool::ToolRegistry;\n"),
            sf("crates/server/src/agent/tool/mod.rs", "use crate::agent::mcp::Resource;\n"),
            sf("crates/server/src/agent/mcp/mod.rs", "use crate::agent::orchestrator::Orchestrator;\n"),
        ];
        let violations = audit_files(&three_node);
        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].rule, BoundaryRule::ServerModulesAcyclic);
        assert!(violations[0].message.contains("agent/mcp -> agent/orchestrator -> agent/tool -> agent/mcp"));
    }

    #[test]
    fn enforces_sea_orm_boundary_one_table_per_entity_and_no_legacy_dirs() {
        let files = vec![
            sf(
                "crates/server/src/service/issue.rs",
                "use sea_orm::EntityTrait;\nuse crate::db::entity::issue;\n",
            ),
            sf("crates/server/src/issue/board.rs", "use sea_orm::EntityTrait;\nuse crate::db::entity::issue;\n"),
            sf("crates/server/src/db/mod.rs", "#[cfg(test)]\nmod tests { use crate::db::entity::channel; }\n"),
            sf("crates/server/src/db/entity/issue.rs", "#[sea_orm(table_name = \"issue\")]\npub struct Model;"),
            sf(
                "crates/server/src/db/entity/wrong_name.rs",
                "#[sea_orm(table_name = \"other\")]\npub struct Model;",
            ),
            sf("crates/server/src/work/old.rs", "pub struct Old;\n"),
        ];
        let violations = audit_files(&files);
        let tags: Vec<String> = violations.iter().map(|v| format!("{}@{}:{}", v.rule.as_str(), v.file, v.line)).collect();
        assert_eq!(
            tags,
            vec![
                "one-table-one-entity-file@crates/server/src/db/entity/wrong_name.rs:1",
                "no-sea-orm-outside-service@crates/server/src/issue/board.rs:1",
                "no-sea-orm-outside-service@crates/server/src/issue/board.rs:2",
                "no-legacy-dirs@crates/server/src/work/old.rs:1",
            ]
        );
    }

    #[test]
    fn enforces_server_db_boundary_outside_service() {
        let files = vec![
            sf("crates/server/src/service/mod.rs", "pub(crate) use crate::db::{DatabaseConfig, DbError, Tx};\n"),
            sf("crates/server/src/db/mod.rs", "use crate::db::DbError;\n"),
            sf(
                "crates/server/src/agent/memory/mod.rs",
                "#[cfg(test)]\nmod tests {\n    use crate::db::DbBackend;\n}\n",
            ),
            sf("crates/server/src/issue/board.rs", "use crate::db::DbError;\n"),
            sf(
                "crates/server/src/runtime/mod.rs",
                "use super::db::Tx;\npub fn bad() { let _ = crate::db::DatabaseConfig::default(); }\n",
            ),
            sf("crates/server/src/context/mod.rs", "use crate::db::error::internal_db;\n"),
        ];
        let violations = audit_files(&files);
        let tags: Vec<String> = violations.iter().map(|v| format!("{}@{}:{}", v.rule.as_str(), v.file, v.line)).collect();
        assert_eq!(
            tags,
            vec![
                "no-db-outside-service@crates/server/src/context/mod.rs:1",
                "no-db-outside-service@crates/server/src/issue/board.rs:1",
                "no-db-outside-service@crates/server/src/runtime/mod.rs:1",
                "no-db-outside-service@crates/server/src/runtime/mod.rs:2",
            ]
        );
        assert!(format_violations(&violations).contains("crate::service::"));
    }

    #[test]
    fn audits_workspace_from_disk() {
        let dir = TempDir::new("vv-boundaries");
        dir.write("crates/server/src/lib.rs", "pub mod context;\n");
        dir.write("crates/server/src/context/port.rs", "pub trait LiveVoicePort {}\n");
        dir.write("crates/server/src/gateway/api/mod.rs", "pub trait Server {}\n");
        dir.write("crates/server/src/setting.rs", "pub struct Setting;\n");
        dir.write("crates/server/src/repo.rs", "use crate::context::Context;\n");
        dir.write("apps/mac/src/live_voice.rs", "use vibevalley_server::gateway::api::SharedLiveVoice;\n");

        let clean = audit_workspace(&dir.0).unwrap();
        assert_eq!(clean.files_scanned, 6);
        assert!(clean.violations.is_empty());

        dir.write(
            "apps/mac/src/hosted/late.rs",
            "fn voice(&self) -> Option<vibevalley_server::voice::Voice> { None }\n",
        );
        let dirty = audit_workspace(&dir.0).unwrap();
        assert_eq!(
            dirty.violations.iter().map(|v| v.rule).collect::<Vec<_>>(),
            vec![BoundaryRule::MacNoServerModuleImport]
        );
    }
}
