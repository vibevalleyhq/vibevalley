//! Module facade, public API surface, and per-function complexity mapper (`cargo xtask map`).

use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, Write};
use std::path::Path;

use serde::Serialize;

use crate::rust_scan::{
    LineIndex, SourceFile, is_excluded_by_cfg_test, is_ident_char, is_ident_start, normalize_posix_path, strip_cfg_test_and_collect_excluded,
    strip_rust_comments_and_literals, walk_matching_files,
};

const USAGE: &str = "\
Usage: cargo xtask map [filter] [--surface] [--json] [--top <N>]

Extract pub/pub(crate) signatures and first /// doc-comment lines per Rust module/file,
compute pub-surface metrics (`pub_count`, `non_test_loc`, `pub_per_kloc`), and rank
wide-facade and nested branch complexity hotspots.";

pub const DEFAULT_TOP_HOTSPOTS: usize = 15;
pub const WIDE_FACADE_MIN_PUB_COUNT: usize = 5;
pub const WIDE_FACADE_MIN_PUB_PER_KLOC: f64 = 65.0;
pub const LARGE_FACADE_PUB_COUNT: usize = 20;
pub const COMPLEX_FN_MIN_SCORE: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Visibility {
    Pub,
    #[serde(rename = "pub(crate)")]
    PubCrate,
    #[serde(rename = "pub(super)")]
    PubRestricted,
}

impl Visibility {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pub => "pub",
            Self::PubCrate => "pub(crate)",
            Self::PubRestricted => "pub(super)",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SymbolKind {
    Struct,
    Enum,
    Trait,
    Fn,
    Type,
    Const,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PublicSymbol {
    pub visibility: Visibility,
    pub kind: SymbolKind,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    pub line: usize,
    pub signature: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Reexport {
    pub visibility: Visibility,
    pub line: usize,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FileSurface {
    pub file: String,
    pub module: String,
    pub non_test_loc: usize,
    pub pub_count: usize,
    pub pub_crate_count: usize,
    pub reexport_count: usize,
    pub pub_per_kloc: f64,
    pub symbols: Vec<PublicSymbol>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub reexports: Vec<Reexport>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModuleSurface {
    pub module: String,
    pub files: usize,
    pub non_test_loc: usize,
    pub pub_count: usize,
    pub pub_crate_count: usize,
    pub reexport_count: usize,
    pub pub_per_kloc: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WideFacadeHotspot {
    pub target: String,
    pub kind: String,
    pub pub_count: usize,
    pub pub_crate_count: usize,
    pub non_test_loc: usize,
    pub pub_per_kloc: f64,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FunctionComplexity {
    pub file: String,
    pub line: usize,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visibility: Option<Visibility>,
    pub loc: usize,
    pub complexity: usize,
    pub branches: usize,
    pub max_nesting: usize,
    pub match_arms: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MapSummary {
    pub files_scanned: usize,
    pub modules: usize,
    pub non_test_loc: usize,
    pub pub_count: usize,
    pub pub_crate_count: usize,
    pub reexport_count: usize,
    pub wide_facade_count: usize,
    pub complex_function_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MapReport {
    pub filter: Option<String>,
    pub summary: MapSummary,
    pub modules: Vec<ModuleSurface>,
    pub wide_facades: Vec<WideFacadeHotspot>,
    pub complex_functions: Vec<FunctionComplexity>,
    pub files: Vec<FileSurface>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TokKind {
    Ident,
    Punct,
}

#[derive(Debug, Clone)]
struct Tok {
    kind: TokKind,
    text: String,
    offset: usize,
}

#[derive(Debug, Clone)]
enum ScopeKind {
    Module,
    Impl(String),
    Function,
    Other,
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn compute_pub_per_kloc(pub_count: usize, non_test_loc: usize) -> f64 {
    if non_test_loc == 0 {
        0.0
    } else {
        round2((pub_count as f64 * 1000.0) / non_test_loc as f64)
    }
}

fn count_non_test_code_lines(non_test_code: &str) -> usize {
    non_test_code.split('\n').filter(|line| !line.trim().is_empty()).count()
}

fn tokenize_rust(code: &str) -> Vec<Tok> {
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
            tokens.push(Tok {
                kind: TokKind::Ident,
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
            tokens.push(Tok {
                kind: TokKind::Ident,
                text: code[start..i].to_owned(),
                offset: start,
            });
            continue;
        }
        let two = bytes.get(i + 1).map(|&next| [b, next]);
        if let Some(pair) = two
            && matches!(&pair, b"::" | b"=>" | b"->" | b"&&" | b"||")
        {
            tokens.push(Tok {
                kind: TokKind::Punct,
                text: std::str::from_utf8(&pair).expect("ASCII pair").to_owned(),
                offset: i,
            });
            i += 2;
            continue;
        }
        let ch = code[i..].chars().next().expect("valid UTF-8 at token boundary");
        tokens.push(Tok {
            kind: TokKind::Punct,
            text: ch.to_string(),
            offset: i,
        });
        i += ch.len_utf8();
    }

    tokens
}

fn parse_visibility(tokens: &[Tok], pub_idx: usize) -> (Visibility, usize) {
    if tokens.get(pub_idx + 1).is_some_and(|t| t.text == "(") {
        let mut depth = 0usize;
        let mut cursor = pub_idx + 1;
        let mut inner = Vec::new();
        while cursor < tokens.len() {
            let text = tokens[cursor].text.as_str();
            if text == "(" {
                depth += 1;
                if depth > 1 {
                    inner.push(text);
                }
            } else if text == ")" {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    let vis = if inner == ["crate"] {
                        Visibility::PubCrate
                    } else {
                        Visibility::PubRestricted
                    };
                    return (vis, cursor + 1);
                }
                inner.push(text);
            } else {
                inner.push(text);
            }
            cursor += 1;
        }
        (Visibility::PubRestricted, cursor)
    } else {
        (Visibility::Pub, pub_idx + 1)
    }
}

fn skip_balanced_parens(tokens: &[Tok], open_idx: usize) -> usize {
    let mut depth = 0usize;
    let mut idx = open_idx;
    while idx < tokens.len() {
        match tokens[idx].text.as_str() {
            "(" => depth += 1,
            ")" => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return idx + 1;
                }
            }
            _ => {}
        }
        idx += 1;
    }
    idx
}

fn skip_balanced_angles(tokens: &[Tok], open_idx: usize) -> usize {
    let mut depth = 0usize;
    let mut idx = open_idx;
    while idx < tokens.len() {
        match tokens[idx].text.as_str() {
            "<" => depth += 1,
            ">" => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return idx + 1;
                }
            }
            "{" | ";" => return idx,
            _ => {}
        }
        idx += 1;
    }
    idx
}

fn skip_fn_qualifiers(tokens: &[Tok], mut idx: usize) -> usize {
    while let Some(tok) = tokens.get(idx) {
        if tok.kind == TokKind::Ident {
            match tok.text.as_str() {
                "async" | "unsafe" | "extern" => {
                    idx += 1;
                    continue;
                }
                "const"
                    if tokens
                        .get(idx + 1)
                        .is_some_and(|next| next.kind == TokKind::Ident && matches!(next.text.as_str(), "fn" | "unsafe" | "extern")) =>
                {
                    idx += 1;
                    continue;
                }
                _ => {}
            }
        }
        break;
    }
    idx
}

fn extract_impl_target_name(tokens: &[Tok], impl_idx: usize) -> Option<(String, usize)> {
    let mut idx = impl_idx + 1;
    if tokens.get(idx).is_some_and(|t| t.text == "<") {
        idx = skip_balanced_angles(tokens, idx);
    }

    let mut brace_idx = idx;
    let mut for_idx = None;
    let mut paren_depth = 0usize;
    let mut angle_depth = 0usize;
    while brace_idx < tokens.len() {
        match tokens[brace_idx].text.as_str() {
            "(" => paren_depth += 1,
            ")" => paren_depth = paren_depth.saturating_sub(1),
            "<" => angle_depth += 1,
            ">" => angle_depth = angle_depth.saturating_sub(1),
            "for" if paren_depth == 0 && angle_depth == 0 && tokens[brace_idx].kind == TokKind::Ident => {
                for_idx = Some(brace_idx);
            }
            "{" if paren_depth == 0 => break,
            ";" if paren_depth == 0 => return None,
            _ => {}
        }
        brace_idx += 1;
    }
    if brace_idx >= tokens.len() {
        return None;
    }

    let type_start = for_idx.map_or(idx, |f| f + 1);
    let mut name_parts = Vec::new();
    let mut cursor = type_start;
    while cursor < brace_idx {
        let tok = &tokens[cursor];
        if tok.kind == TokKind::Ident && tok.text == "where" {
            break;
        }
        if tok.text == "<" {
            break;
        }
        if tok.kind == TokKind::Ident || tok.text == "::" {
            name_parts.push(tok.text.as_str());
        }
        cursor += 1;
    }
    let name = name_parts.concat();
    let final_name = if name.is_empty() { "impl".to_owned() } else { name };
    Some((final_name, brace_idx))
}

fn extract_first_doc_line(index: &LineIndex, item_line: usize) -> Option<String> {
    let lines = index.lines();
    if item_line <= 1 {
        return None;
    }
    let mut cursor = item_line - 2; // 0-based index of line immediately above item
    let mut doc_lines: Vec<String> = Vec::new();

    loop {
        let raw = lines.get(cursor).map_or("", String::as_str);
        let trimmed = raw.trim();

        if trimmed.starts_with("///") {
            let content = trimmed.trim_start_matches('/').trim();
            doc_lines.push(content.to_owned());
        } else if trimmed.starts_with("#[") {
            if !doc_lines.is_empty() {
                break;
            }
        } else if trimmed.ends_with("*/") && doc_lines.is_empty() {
            let mut block_top = cursor;
            let mut found_doc = false;
            loop {
                let b_trimmed = lines[block_top].trim();
                if b_trimmed.starts_with("/**") {
                    found_doc = true;
                    break;
                }
                if block_top == 0 || b_trimmed.starts_with("/*") {
                    break;
                }
                block_top -= 1;
            }
            if found_doc {
                for line in &lines[block_top..=cursor] {
                    let cleaned = line.trim().trim_start_matches("/**").trim_end_matches("*/").trim_start_matches('*').trim();
                    if !cleaned.is_empty() {
                        return Some(cleaned.to_owned());
                    }
                }
            }
            break;
        } else if trimmed.is_empty() && doc_lines.is_empty() {
            // Allow at most a blank line before attributes or skip? Only stop if we hit non-attribute code.
            break;
        } else {
            break;
        }

        if cursor == 0 {
            break;
        }
        cursor -= 1;
    }

    doc_lines.reverse();
    doc_lines.into_iter().find(|s| !s.is_empty())
}

fn extract_signature(index: &LineIndex, item_line: usize, kind: SymbolKind) -> String {
    let lines = index.lines();
    let start = item_line.saturating_sub(1);
    let mut joined = String::new();
    let max_lines = (start + 8).min(lines.len());

    for line in &lines[start..max_lines] {
        let code_part = line.split("//").next().unwrap_or("");
        let trimmed = code_part.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !joined.is_empty() {
            joined.push(' ');
        }
        joined.push_str(trimmed);

        let stop = match kind {
            SymbolKind::Struct | SymbolKind::Enum | SymbolKind::Trait | SymbolKind::Fn => joined.contains('{') || joined.contains(';'),
            SymbolKind::Type | SymbolKind::Const => joined.contains(';'),
        };
        if stop {
            break;
        }
    }

    let cut = match kind {
        SymbolKind::Struct | SymbolKind::Enum | SymbolKind::Trait | SymbolKind::Fn => {
            if let Some(pos) = joined.find('{') {
                joined[..pos].trim().to_owned()
            } else if let Some(pos) = joined.find(';') {
                joined[..pos].trim().to_owned()
            } else {
                joined.trim().to_owned()
            }
        }
        SymbolKind::Type | SymbolKind::Const => {
            if let Some(pos) = joined.find(';') {
                joined[..pos].trim().to_owned()
            } else {
                joined.trim().to_owned()
            }
        }
    };

    let collapsed: String = cut.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > 160 {
        let prefix: String = collapsed.chars().take(157).collect();
        format!("{prefix}...")
    } else {
        collapsed
    }
}

fn extract_use_path(tokens: &[Tok], use_idx: usize) -> (String, usize) {
    let mut parts = Vec::new();
    let mut idx = use_idx + 1;
    while idx < tokens.len() && tokens[idx].text != ";" {
        let t = tokens[idx].text.as_str();
        if matches!(t, "::" | "," | "{" | "}" | "*") {
            if t == "," {
                parts.push(", ".to_owned());
            } else {
                parts.push(t.to_owned());
            }
        } else {
            if let Some(last) = parts.last()
                && !matches!(last.as_str(), "::" | "{" | ", ")
            {
                parts.push(" ".to_owned());
            }
            parts.push(t.to_owned());
        }
        idx += 1;
    }
    if tokens.get(idx).is_some_and(|t| t.text == ";") {
        idx += 1;
    }
    (parts.concat(), idx)
}

fn find_fn_body_bounds(tokens: &[Tok], fn_idx: usize) -> Option<(usize, usize)> {
    let mut idx = fn_idx + 1;
    if !tokens.get(idx).is_some_and(|t| t.kind == TokKind::Ident) {
        return None;
    }
    idx += 1;
    if tokens.get(idx).is_some_and(|t| t.text == "<") {
        idx = skip_balanced_angles(tokens, idx);
    }
    if !tokens.get(idx).is_some_and(|t| t.text == "(") {
        return None;
    }
    idx = skip_balanced_parens(tokens, idx);

    let mut paren_depth = 0usize;
    let mut angle_depth = 0usize;
    while idx < tokens.len() {
        match tokens[idx].text.as_str() {
            "(" => paren_depth += 1,
            ")" => paren_depth = paren_depth.saturating_sub(1),
            "<" => angle_depth += 1,
            ">" => angle_depth = angle_depth.saturating_sub(1),
            ";" if paren_depth == 0 => return None,
            "{" if paren_depth == 0 => break,
            _ => {}
        }
        idx += 1;
    }
    if idx >= tokens.len() {
        return None;
    }

    let body_open = idx;
    let mut depth = 0usize;
    while idx < tokens.len() {
        match tokens[idx].text.as_str() {
            "{" => depth += 1,
            "}" => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some((body_open, idx));
                }
            }
            _ => {}
        }
        idx += 1;
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ControlBlock {
    Branch,
    MatchArmContainer,
    Plain,
}

struct FnHeader<'a> {
    file: &'a str,
    name: String,
    owner: Option<String>,
    visibility: Option<Visibility>,
    line: usize,
}

/// Computes nesting-aware branch complexity for a function body.
///
/// Flat enum `match` dispatch counts `+1` for the `match` itself (plus any `if` arm guards)
/// without inflating per-arm dispatch, while nested `if`/`else`/`for`/`while`/`loop`/`match`
/// blocks add `1 + nesting_depth` so deeply nested control logic surfaces clearly.
fn analyze_function_complexity(header: FnHeader<'_>, tokens: &[Tok], body_open: usize, body_close: usize, stripped_code: &str) -> FunctionComplexity {
    let start_off = tokens[body_open].offset;
    let end_off = tokens[body_close].offset;
    let slice = &stripped_code[start_off..=end_off];
    let body_loc = slice.split('\n').filter(|l| !l.trim().is_empty()).count().max(1);

    let mut branches = 0usize;
    let mut complexity = 1usize;
    let mut max_nesting = 0usize;
    let mut match_arms = 0usize;

    let mut control_nesting = 0usize;
    let mut block_stack: Vec<ControlBlock> = Vec::new();
    let mut pending_block: Option<ControlBlock> = None;

    let mut i = body_open + 1;
    while i < body_close {
        let tok = &tokens[i];
        if tok.kind == TokKind::Ident {
            match tok.text.as_str() {
                "if" => {
                    let is_else_if = i > body_open + 1 && tokens[i - 1].kind == TokKind::Ident && tokens[i - 1].text == "else";
                    branches += 1;
                    if is_else_if {
                        // `else if` stays at the enclosing `if`'s nesting level rather than double-nesting.
                        complexity += 1 + control_nesting;
                    } else {
                        complexity += 1 + control_nesting;
                    }
                    pending_block = Some(ControlBlock::Branch);
                }
                "else" => {
                    if !tokens.get(i + 1).is_some_and(|n| n.kind == TokKind::Ident && n.text == "if") {
                        complexity += 1;
                        pending_block = Some(ControlBlock::Branch);
                    }
                }
                "for" | "while" | "loop" => {
                    branches += 1;
                    complexity += 1 + control_nesting;
                    pending_block = Some(ControlBlock::Branch);
                }
                "match" => {
                    branches += 1;
                    complexity += 1 + control_nesting;
                    pending_block = Some(ControlBlock::MatchArmContainer);
                }
                _ => {}
            }
        } else {
            match tok.text.as_str() {
                "?" | "&&" | "||" => {
                    branches += 1;
                    complexity += 1;
                }
                "=>" if matches!(block_stack.last(), Some(ControlBlock::MatchArmContainer)) => {
                    match_arms += 1;
                }
                "{" => {
                    let kind = pending_block.take().unwrap_or(ControlBlock::Plain);
                    if kind == ControlBlock::Branch {
                        control_nesting += 1;
                        max_nesting = max_nesting.max(control_nesting);
                    }
                    block_stack.push(kind);
                }
                "}" => {
                    if let Some(ControlBlock::Branch) = block_stack.pop() {
                        control_nesting = control_nesting.saturating_sub(1);
                    }
                    pending_block = None;
                }
                ";" => {
                    pending_block = None;
                }
                _ => {}
            }
        }
        i += 1;
    }

    FunctionComplexity {
        file: header.file.to_owned(),
        line: header.line,
        name: header.name,
        owner: header.owner,
        visibility: header.visibility,
        loc: body_loc,
        complexity,
        branches,
        max_nesting,
        match_arms,
    }
}

fn analyze_rust_file(file: &SourceFile, stripped_code: &str) -> (FileSurface, Vec<FunctionComplexity>) {
    let index = LineIndex::new(&file.text);
    let non_test_loc = count_non_test_code_lines(stripped_code);
    let tokens = tokenize_rust(stripped_code);

    let mut symbols = Vec::new();
    let mut reexports = Vec::new();
    let mut functions = Vec::new();
    let mut pub_count = 0usize;
    let mut pub_crate_count = 0usize;

    let mut scope_stack: Vec<ScopeKind> = vec![ScopeKind::Module];
    let mut pending_scope: Option<ScopeKind> = None;

    let mut i = 0usize;
    while i < tokens.len() {
        let tok = &tokens[i];
        let in_module_or_impl = matches!(scope_stack.last(), Some(ScopeKind::Module | ScopeKind::Impl(_)));
        let current_owner = match scope_stack.last() {
            Some(ScopeKind::Impl(name)) => Some(name.clone()),
            _ => None,
        };

        if tok.text == "{" {
            let scope = pending_scope.take().unwrap_or(ScopeKind::Other);
            scope_stack.push(scope);
            i += 1;
            continue;
        }
        if tok.text == "}" {
            if scope_stack.len() > 1 {
                scope_stack.pop();
            }
            pending_scope = None;
            i += 1;
            continue;
        }
        if tok.text == ";" {
            pending_scope = None;
            i += 1;
            continue;
        }

        if in_module_or_impl && tok.kind == TokKind::Ident && tok.text == "mod" && tokens.get(i + 1).is_some_and(|t| t.kind == TokKind::Ident) {
            let mut cursor = i + 2;
            while cursor < tokens.len() && !matches!(tokens[cursor].text.as_str(), "{" | ";") {
                cursor += 1;
            }
            if tokens.get(cursor).is_some_and(|t| t.text == "{") {
                pending_scope = Some(ScopeKind::Module);
            }
            i += 2;
            continue;
        }

        if matches!(scope_stack.last(), Some(ScopeKind::Module))
            && tok.kind == TokKind::Ident
            && tok.text == "impl"
            && let Some((owner_name, brace_idx)) = extract_impl_target_name(&tokens, i)
        {
            pending_scope = Some(ScopeKind::Impl(owner_name));
            i = brace_idx;
            continue;
        }

        if in_module_or_impl && tok.kind == TokKind::Ident && tok.text == "pub" {
            let (vis, after_vis) = parse_visibility(&tokens, i);
            if tokens.get(after_vis).is_some_and(|t| t.kind == TokKind::Ident && t.text == "use") {
                let line = index.line_at(tok.offset);
                let (path, next_idx) = extract_use_path(&tokens, after_vis);
                reexports.push(Reexport { visibility: vis, line, path });
                i = next_idx;
                continue;
            }

            let kw_idx = skip_fn_qualifiers(&tokens, after_vis);
            if let Some(kw) = tokens.get(kw_idx)
                && kw.kind == TokKind::Ident
            {
                let kind = match kw.text.as_str() {
                    "struct" => Some(SymbolKind::Struct),
                    "enum" => Some(SymbolKind::Enum),
                    "trait" => Some(SymbolKind::Trait),
                    "fn" => Some(SymbolKind::Fn),
                    "type" => Some(SymbolKind::Type),
                    "const" => Some(SymbolKind::Const),
                    _ => None,
                };
                if let Some(kind) = kind
                    && let Some(name_tok) = tokens.get(kw_idx + 1)
                    && name_tok.kind == TokKind::Ident
                {
                    let line = index.line_at(tok.offset);
                    let doc = extract_first_doc_line(&index, line);
                    let signature = extract_signature(&index, line, kind);
                    match vis {
                        Visibility::Pub => pub_count += 1,
                        Visibility::PubCrate => pub_crate_count += 1,
                        Visibility::PubRestricted => {}
                    }
                    symbols.push(PublicSymbol {
                        visibility: vis,
                        kind,
                        name: name_tok.text.clone(),
                        owner: current_owner.clone(),
                        line,
                        signature,
                        doc,
                    });

                    if kind == SymbolKind::Fn
                        && let Some((body_open, body_close)) = find_fn_body_bounds(&tokens, kw_idx)
                    {
                        functions.push(analyze_function_complexity(
                            FnHeader {
                                file: &file.path,
                                name: name_tok.text.clone(),
                                owner: current_owner,
                                visibility: Some(vis),
                                line,
                            },
                            &tokens,
                            body_open,
                            body_close,
                            stripped_code,
                        ));
                        i = body_close + 1;
                        continue;
                    }
                    i = kw_idx + 2;
                    continue;
                }
            }
        }

        if in_module_or_impl
            && tok.kind == TokKind::Ident
            && tok.text == "fn"
            && let Some(name_tok) = tokens.get(i + 1)
            && name_tok.kind == TokKind::Ident
        {
            let line = index.line_at(tok.offset);
            if let Some((body_open, body_close)) = find_fn_body_bounds(&tokens, i) {
                functions.push(analyze_function_complexity(
                    FnHeader {
                        file: &file.path,
                        name: name_tok.text.clone(),
                        owner: current_owner,
                        visibility: None,
                        line,
                    },
                    &tokens,
                    body_open,
                    body_close,
                    stripped_code,
                ));
                i = body_close + 1;
                continue;
            }
            pending_scope = Some(ScopeKind::Function);
        }

        i += 1;
    }

    let module = module_group_for_path(&file.path);
    let reexport_count = reexports.len();
    let pub_per_kloc = compute_pub_per_kloc(pub_count, non_test_loc);
    let surface = FileSurface {
        file: file.path.clone(),
        module,
        non_test_loc,
        pub_count,
        pub_crate_count,
        reexport_count,
        pub_per_kloc,
        symbols,
        reexports,
    };

    (surface, functions)
}

fn module_group_for_path(rel_path: &str) -> String {
    let norm = normalize_posix_path(rel_path);
    if let Some(idx) = norm.find("/src/") {
        let prefix = &norm[..idx + 5];
        let rest = &norm[idx + 5..];
        let mut parts = rest.split('/');
        if let Some(first) = parts.next() {
            let stem = first.strip_suffix(".rs").unwrap_or(first);
            return format!("{prefix}{stem}");
        }
    }
    norm.rsplit_once('/').map_or(norm.clone(), |(dir, _)| dir.to_owned())
}

fn is_rust_source_path(rel: &str) -> bool {
    rel.ends_with(".rs") && !rel.starts_with("target/")
}

fn collect_target_files(root: &Path, filter: Option<&str>) -> Result<Vec<SourceFile>, String> {
    let mut search_roots: Vec<String> = Vec::new();
    let mut substring_filter: Option<&str> = None;

    match filter {
        None => {
            search_roots.push("crates".to_owned());
            search_roots.push("apps/mac".to_owned());
        }
        Some(raw) => {
            let trimmed = raw.trim_end_matches('/');
            let direct = root.join(trimmed);
            if direct.is_file() {
                let rel = normalize_posix_path(trimmed);
                let text = std::fs::read_to_string(&direct).map_err(|err| format!("failed to read {}: {err}", direct.display()))?;
                return Ok(vec![SourceFile { path: rel, text }]);
            } else if direct.is_dir() {
                if direct.join("src").is_dir() {
                    search_roots.push(format!("{trimmed}/src"));
                } else {
                    search_roots.push(trimmed.to_owned());
                }
            } else if root.join(format!("crates/{trimmed}/src")).is_dir() {
                search_roots.push(format!("crates/{trimmed}/src"));
            } else if root.join(format!("apps/{trimmed}/src")).is_dir() {
                search_roots.push(format!("apps/{trimmed}/src"));
            } else {
                search_roots.push("crates".to_owned());
                search_roots.push("apps/mac".to_owned());
                substring_filter = Some(trimmed);
            }
        }
    }

    let root_refs: Vec<&str> = search_roots.iter().map(String::as_str).collect();
    let files = walk_matching_files(root, &root_refs, |rel| {
        if !is_rust_source_path(rel) {
            return false;
        }
        if filter.is_none() && !rel.contains("/src/") {
            return false;
        }
        match substring_filter {
            Some(pat) => rel.contains(pat),
            None => true,
        }
    })?;

    Ok(files)
}

pub fn build_map_report_from_files(files: &[SourceFile], filter: Option<&str>, top_n: usize) -> MapReport {
    let mut sorted: Vec<SourceFile> = files
        .iter()
        .map(|f| SourceFile {
            path: normalize_posix_path(&f.path),
            text: f.text.clone(),
        })
        .collect();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));

    let mut excluded_targets = BTreeSet::new();
    let mut stripped_codes: BTreeMap<String, String> = BTreeMap::new();

    for file in &sorted {
        let no_comments = strip_rust_comments_and_literals(&file.text);
        let stripped = strip_cfg_test_and_collect_excluded(&file.text, &no_comments, &file.path);
        for target in stripped.excluded_submodules {
            excluded_targets.insert(target);
        }
        stripped_codes.insert(file.path.clone(), stripped.code);
    }

    let mut file_surfaces = Vec::new();
    let mut all_functions = Vec::new();

    #[derive(Default)]
    struct ModAccum {
        files: usize,
        non_test_loc: usize,
        pub_count: usize,
        pub_crate_count: usize,
        reexport_count: usize,
    }
    let mut mod_accums: BTreeMap<String, ModAccum> = BTreeMap::new();

    for file in &sorted {
        if is_excluded_by_cfg_test(&file.path, &excluded_targets) {
            continue;
        }
        let stripped_code = stripped_codes.get(&file.path).map_or("", String::as_str);
        let (surface, fns) = analyze_rust_file(file, stripped_code);

        let entry = mod_accums.entry(surface.module.clone()).or_default();
        entry.files += 1;
        entry.non_test_loc += surface.non_test_loc;
        entry.pub_count += surface.pub_count;
        entry.pub_crate_count += surface.pub_crate_count;
        entry.reexport_count += surface.reexport_count;

        file_surfaces.push(surface);
        all_functions.extend(fns);
    }

    let mut modules = Vec::with_capacity(mod_accums.len());
    let mut wide_facades = Vec::new();

    for (module, acc) in mod_accums {
        let pub_per_kloc = compute_pub_per_kloc(acc.pub_count, acc.non_test_loc);
        let is_wide = (acc.pub_count >= WIDE_FACADE_MIN_PUB_COUNT && pub_per_kloc >= WIDE_FACADE_MIN_PUB_PER_KLOC) || acc.pub_count >= LARGE_FACADE_PUB_COUNT;
        if is_wide {
            wide_facades.push(WideFacadeHotspot {
                target: module.clone(),
                kind: "module".to_owned(),
                pub_count: acc.pub_count,
                pub_crate_count: acc.pub_crate_count,
                non_test_loc: acc.non_test_loc,
                pub_per_kloc,
                reason: format!(
                    "{} pub symbols across {} non-test LOC ({:.1} pub/kloc)",
                    acc.pub_count, acc.non_test_loc, pub_per_kloc
                ),
            });
        }
        modules.push(ModuleSurface {
            module,
            files: acc.files,
            non_test_loc: acc.non_test_loc,
            pub_count: acc.pub_count,
            pub_crate_count: acc.pub_crate_count,
            reexport_count: acc.reexport_count,
            pub_per_kloc,
        });
    }

    wide_facades.sort_by(|a, b| {
        b.pub_count
            .cmp(&a.pub_count)
            .then_with(|| b.pub_per_kloc.total_cmp(&a.pub_per_kloc))
            .then_with(|| a.target.cmp(&b.target))
    });
    wide_facades.truncate(top_n);

    all_functions.retain(|f| f.complexity >= COMPLEX_FN_MIN_SCORE);
    all_functions.sort_by(|a, b| {
        b.complexity
            .cmp(&a.complexity)
            .then_with(|| b.max_nesting.cmp(&a.max_nesting))
            .then_with(|| b.branches.cmp(&a.branches))
            .then_with(|| a.file.cmp(&b.file))
            .then_with(|| a.line.cmp(&b.line))
    });
    all_functions.truncate(top_n);

    let summary = MapSummary {
        files_scanned: file_surfaces.len(),
        modules: modules.len(),
        non_test_loc: file_surfaces.iter().map(|f| f.non_test_loc).sum(),
        pub_count: file_surfaces.iter().map(|f| f.pub_count).sum(),
        pub_crate_count: file_surfaces.iter().map(|f| f.pub_crate_count).sum(),
        reexport_count: file_surfaces.iter().map(|f| f.reexport_count).sum(),
        wide_facade_count: wide_facades.len(),
        complex_function_count: all_functions.len(),
    };

    MapReport {
        filter: filter.map(str::to_owned),
        summary,
        modules,
        wide_facades,
        complex_functions: all_functions,
        files: file_surfaces,
    }
}

pub fn map_workspace(root: &Path, filter: Option<&str>, top_n: usize) -> Result<MapReport, String> {
    let files = collect_target_files(root, filter)?;
    Ok(build_map_report_from_files(&files, filter, top_n))
}

pub fn format_map_report(report: &MapReport, show_surface: bool) -> String {
    let mut out = Vec::new();
    let s = &report.summary;
    out.push(format!(
        "map: {} files, {} modules, {} non-test LOC, {} pub, {} pub(crate), {} re-exports",
        s.files_scanned, s.modules, s.non_test_loc, s.pub_count, s.pub_crate_count, s.reexport_count
    ));

    if show_surface {
        out.push(String::new());
        out.push("Module Pub-Surface Summary:".to_owned());
        out.push(format!(
            "  {:<36} {:>5} {:>7} {:>6} {:>10} {:>6} {:>9}",
            "MODULE", "FILES", "LOC", "PUB", "PUB(CRATE)", "REEXP", "PUB/KLOC"
        ));
        let mut sorted_mods = report.modules.clone();
        sorted_mods.sort_by(|a, b| b.pub_count.cmp(&a.pub_count).then_with(|| a.module.cmp(&b.module)));
        for m in &sorted_mods {
            out.push(format!(
                "  {:<36} {:>5} {:>7} {:>6} {:>10} {:>6} {:>9.2}",
                m.module, m.files, m.non_test_loc, m.pub_count, m.pub_crate_count, m.reexport_count, m.pub_per_kloc
            ));
        }

        out.push(String::new());
        out.push(format!("Wide-Facade Hotspots ({}):", report.wide_facades.len()));
        if report.wide_facades.is_empty() {
            out.push("  (none)".to_owned());
        } else {
            for w in &report.wide_facades {
                out.push(format!("  {} — {}", w.target, w.reason));
            }
        }

        out.push(String::new());
        out.push(format!(
            "Top Complex Functions (score >= {COMPLEX_FN_MIN_SCORE}, count={}):",
            report.complex_functions.len()
        ));
        if report.complex_functions.is_empty() {
            out.push("  (none)".to_owned());
        } else {
            for f in &report.complex_functions {
                let qual_name = match &f.owner {
                    Some(owner) => format!("{owner}::{}", f.name),
                    None => f.name.clone(),
                };
                out.push(format!(
                    "  [score={:<3} nest={} branches={} arms={} loc={}] {}:{} fn {}",
                    f.complexity, f.max_nesting, f.branches, f.match_arms, f.loc, f.file, f.line, qual_name
                ));
            }
        }
    } else {
        out.push(String::new());
        for f in &report.files {
            if f.symbols.is_empty() && f.reexports.is_empty() {
                continue;
            }
            out.push(format!(
                "{} ({} LOC, {} pub, {} pub(crate), {:.1} pub/kloc)",
                f.file, f.non_test_loc, f.pub_count, f.pub_crate_count, f.pub_per_kloc
            ));
            for re in &f.reexports {
                out.push(format!("  L{:<4} {} use {};", re.line, re.visibility.as_str(), re.path));
            }
            for sym in &f.symbols {
                let owner_prefix = sym.owner.as_deref().map_or(String::new(), |o| format!("[impl {o}] "));
                match &sym.doc {
                    Some(doc) => out.push(format!("  L{:<4} {}{}  // {}", sym.line, owner_prefix, sym.signature, doc)),
                    None => out.push(format!("  L{:<4} {}{}", sym.line, owner_prefix, sym.signature)),
                }
            }
        }
    }

    out.join("\n")
}

fn write_stdout_line(text: &str) -> Result<(), String> {
    let mut stdout = io::stdout().lock();
    match writeln!(stdout, "{text}") {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::BrokenPipe => Ok(()),
        Err(err) => Err(format!("failed to write map output: {err}")),
    }
}

pub fn run(root: &Path, args: &[String]) -> Result<i32, String> {
    let mut show_surface = false;
    let mut json_output = false;
    let mut top_n = DEFAULT_TOP_HOTSPOTS;
    let mut filter: Option<String> = None;

    let mut i = 0usize;
    while i < args.len() {
        let arg = args[i].as_str();
        match arg {
            "--help" | "-h" => {
                write_stdout_line(USAGE)?;
                return Ok(0);
            }
            "--surface" => show_surface = true,
            "--json" => json_output = true,
            "--top" => {
                let Some(val) = args.get(i + 1) else {
                    eprintln!("Usage: cargo xtask map [filter] [--surface] [--json] (--top requires a value)");
                    return Ok(2);
                };
                top_n = val.parse::<usize>().map_err(|_| format!("invalid --top value `{val}`"))?;
                i += 1;
            }
            _ if arg.starts_with("--top=") => {
                let val = &arg["--top=".len()..];
                top_n = val.parse::<usize>().map_err(|_| format!("invalid --top value `{val}`"))?;
            }
            _ if arg.starts_with('-') => {
                eprintln!("xtask map: unknown option `{arg}`\n\n{USAGE}");
                return Ok(2);
            }
            _ => {
                if filter.is_some() {
                    eprintln!("xtask map: unexpected extra positional argument `{arg}`\n\n{USAGE}");
                    return Ok(2);
                }
                filter = Some(arg.to_owned());
            }
        }
        i += 1;
    }

    let report = map_workspace(root, filter.as_deref(), top_n)?;
    if json_output {
        let serialized = serde_json::to_string_pretty(&report).map_err(|err| format!("failed to serialize map report: {err}"))?;
        write_stdout_line(&serialized)?;
    } else {
        write_stdout_line(&format_map_report(&report, show_surface))?;
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sf(path: &str, text: &str) -> SourceFile {
        SourceFile {
            path: path.to_owned(),
            text: text.to_owned(),
        }
    }

    #[test]
    fn help_returns_zero_and_unknown_flag_returns_two() {
        assert_eq!(run(Path::new("."), &["--help".to_owned()]), Ok(0));
        assert_eq!(run(Path::new("."), &["-h".to_owned()]), Ok(0));
        assert_eq!(run(Path::new("."), &["--bogus".to_owned()]), Ok(2));
    }

    #[test]
    fn extracts_pub_signatures_doc_comments_reexports_and_skips_cfg_test() {
        let src = [
            "/// Public module facade re-export.",
            "pub use inner::FacadeItem;",
            "",
            "/// Represents an issue ticket.",
            "#[derive(Debug, Clone)]",
            "pub struct Ticket {",
            "    pub id: u64,",
            "}",
            "",
            "/// Ticket lifecycle state.",
            "pub enum TicketState { Open, Closed }",
            "",
            "/// Store abstraction.",
            "pub trait TicketStore {",
            "    fn get(&self, id: u64) -> Option<Ticket>;",
            "}",
            "",
            "/// Fetch a ticket asynchronously.",
            "pub async fn fetch_ticket(id: u64) -> Option<Ticket> {",
            "    let _ = id;",
            "    None",
            "}",
            "",
            "/// Alias for ticket ID.",
            "pub type TicketId = u64;",
            "",
            "/// Default page limit.",
            "pub const DEFAULT_LIMIT: usize = 50;",
            "",
            "pub(crate) fn internal_helper() {}",
            "",
            "#[cfg(test)]",
            "mod tests {",
            "    /// Must be ignored.",
            "    pub struct TestOnlyStruct;",
            "    pub fn test_only_fn() {}",
            "}",
        ]
        .join("\n");

        let report = build_map_report_from_files(&[sf("crates/server/src/issue/mod.rs", &src)], None, 10);
        assert_eq!(report.summary.files_scanned, 1);
        let file = &report.files[0];

        assert_eq!(file.reexport_count, 1);
        assert_eq!(file.reexports[0].path, "inner::FacadeItem");
        assert_eq!(file.pub_count, 6);
        assert_eq!(file.pub_crate_count, 1);

        let names: Vec<&str> = file.symbols.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "Ticket",
                "TicketState",
                "TicketStore",
                "fetch_ticket",
                "TicketId",
                "DEFAULT_LIMIT",
                "internal_helper"
            ]
        );
        assert!(!names.contains(&"TestOnlyStruct"));
        assert!(!names.contains(&"test_only_fn"));

        assert_eq!(file.symbols[0].doc.as_deref(), Some("Represents an issue ticket."));
        assert_eq!(file.symbols[0].signature, "pub struct Ticket");
        assert_eq!(file.symbols[3].doc.as_deref(), Some("Fetch a ticket asynchronously."));
        assert_eq!(file.symbols[3].signature, "pub async fn fetch_ticket(id: u64) -> Option<Ticket>");
        assert_eq!(file.symbols[4].signature, "pub type TicketId = u64");
        assert_eq!(file.symbols[5].signature, "pub const DEFAULT_LIMIT: usize = 50");
        assert_eq!(file.symbols[6].visibility, Visibility::PubCrate);
    }

    #[test]
    fn computes_pub_surface_and_flags_wide_facades() {
        let mut wide_src = String::new();
        for i in 0..8 {
            wide_src.push_str(&format!("pub fn api_{i}() {{}}\n"));
        }
        let deep_src = [
            "pub fn narrow_entry() { helper_a(); helper_b(); }",
            &(0..200).map(|i| format!("fn h_{i}() {{ let _ = {i}; }}")).collect::<Vec<_>>().join("\n"),
        ]
        .join("\n");

        let report = build_map_report_from_files(
            &[sf("crates/server/src/wide/mod.rs", &wide_src), sf("crates/server/src/deep/mod.rs", &deep_src)],
            None,
            10,
        );

        let wide_mod = report.modules.iter().find(|m| m.module == "crates/server/src/wide").unwrap();
        assert_eq!(wide_mod.pub_count, 8);
        assert_eq!(wide_mod.non_test_loc, 8);
        assert_eq!(wide_mod.pub_per_kloc, 1000.0);

        let deep_mod = report.modules.iter().find(|m| m.module == "crates/server/src/deep").unwrap();
        assert_eq!(deep_mod.pub_count, 1);
        assert!(deep_mod.pub_per_kloc < 10.0);

        assert_eq!(report.wide_facades.len(), 1);
        assert_eq!(report.wide_facades[0].target, "crates/server/src/wide");

        let rendered = format_map_report(&report, true);
        assert!(rendered.contains("Wide-Facade Hotspots (1):"));
        assert!(rendered.contains("crates/server/src/wide"));
    }

    #[test]
    fn distinguishes_nested_branch_complexity_from_flat_enum_match() {
        let src = [
            "pub enum Kind { A, B, C, D, E, F, G, H, I, J, K, L }",
            "pub fn flat_dispatch(k: Kind) -> &'static str {",
            "    match k {",
            "        Kind::A => \"a\", Kind::B => \"b\", Kind::C => \"c\", Kind::D => \"d\",",
            "        Kind::E => \"e\", Kind::F => \"f\", Kind::G => \"g\", Kind::H => \"h\",",
            "        Kind::I => \"i\", Kind::J => \"j\", Kind::K => \"k\", Kind::L => \"l\",",
            "    }",
            "}",
            "pub fn nested_logic(items: &[i32], flag: bool) -> Result<i32, ()> {",
            "    let mut acc = 0;",
            "    for &x in items {",
            "        if x > 0 && (flag || x < 10) {",
            "            while acc < x {",
            "                if check(acc)? {",
            "                    acc += 1;",
            "                } else {",
            "                    acc += 2;",
            "                }",
            "            }",
            "        }",
            "    }",
            "    Ok(acc)",
            "}",
            "fn check(v: i32) -> Result<bool, ()> { Ok(v > 0) }",
        ]
        .join("\n");

        let report = build_map_report_from_files(&[sf("crates/server/src/logic.rs", &src)], None, 10);
        // Flat match dispatch scores below COMPLEX_FN_MIN_SCORE (1 base + 1 match = 2) and is not flagged.
        assert_eq!(report.complex_functions.len(), 1);
        let top = &report.complex_functions[0];
        assert_eq!(top.name, "nested_logic");
        assert!(top.complexity >= COMPLEX_FN_MIN_SCORE);
        assert_eq!(top.max_nesting, 4);
        assert!(top.branches >= 7);

        let json_str = serde_json::to_string_pretty(&report).unwrap();
        let val: serde_json::Value = serde_json::from_str(&json_str).unwrap();
        assert_eq!(val["complex_functions"][0]["name"], "nested_logic");
    }
}
