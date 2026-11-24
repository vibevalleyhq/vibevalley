//! Shared Rust source scanning utilities: comment/literal stripping,
//! `#[cfg(test)]` exclusion, line indexing, and workspace file collection.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceFile {
    /// POSIX path relative to repository root, e.g. `crates/server/src/lib.rs`.
    pub path: String,
    pub text: String,
}

pub struct StrippedRust {
    pub code: String,
    pub excluded_submodules: Vec<String>,
}

pub struct LineIndex {
    lines: Vec<String>,
    starts: Vec<usize>,
}

impl LineIndex {
    pub fn new(source: &str) -> Self {
        let lines = source.split('\n').map(str::to_owned).collect();
        let mut starts = vec![0];
        for (i, &b) in source.as_bytes().iter().enumerate() {
            if b == b'\n' {
                starts.push(i + 1);
            }
        }
        Self { lines, starts }
    }

    pub fn line_at(&self, byte_offset: usize) -> usize {
        self.starts.partition_point(|&start| start <= byte_offset).max(1)
    }

    pub fn snippet_at(&self, line: usize) -> &str {
        self.lines.get(line.saturating_sub(1)).map_or("", |s| s.trim())
    }

    pub fn lines(&self) -> &[String] {
        &self.lines
    }
}

pub fn is_ident_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_'
}

pub fn is_ident_char(b: u8) -> bool {
    is_ident_start(b) || b.is_ascii_digit()
}

fn blank_range(out: &mut Vec<u8>, source: &[u8], from: usize, to: usize) {
    let end = to.min(source.len());
    for &b in &source[from..end] {
        out.push(if b == b'\n' { b'\n' } else { b' ' });
    }
}

fn blank_in_place(buf: &mut [u8], from: usize, to: usize) {
    let end = to.min(buf.len());
    for b in &mut buf[from..end] {
        if *b != b'\n' {
            *b = b' ';
        }
    }
}

fn next_char_len(bytes: &[u8], idx: usize) -> usize {
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

/// Replaces Rust comments and string/char literals with spaces while preserving newlines
/// and byte offsets so 1-based line numbers stay exact.
pub fn strip_rust_comments_and_literals(source: &str) -> String {
    let bytes = source.as_bytes();
    let len = bytes.len();
    let mut out = Vec::with_capacity(len);
    let mut i = 0;

    while i < len {
        let ch = bytes[i];
        let next = bytes.get(i + 1).copied();

        if ch == b'/' && next == Some(b'/') {
            let start = i;
            i += 2;
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
            blank_range(&mut out, bytes, start, i);
            continue;
        }

        if ch == b'/' && next == Some(b'*') {
            let start = i;
            i += 2;
            let mut depth = 1usize;
            while i < len && depth > 0 {
                if bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'*') {
                    depth += 1;
                    i += 2;
                } else if bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/') {
                    depth -= 1;
                    i += 2;
                } else {
                    i += next_char_len(bytes, i);
                }
            }
            blank_range(&mut out, bytes, start, i);
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
                    cursor += next_char_len(bytes, cursor);
                }
                blank_range(&mut out, bytes, start, cursor);
                i = cursor;
                continue;
            }
        }

        if ch == b'"' || (!prev_is_ident && (ch == b'b' || ch == b'c') && next == Some(b'"')) {
            let start = i;
            i = if ch == b'"' { i + 1 } else { i + 2 };
            while i < len {
                if bytes[i] == b'\\' {
                    i += 1;
                    i += next_char_len(bytes, i);
                    continue;
                }
                if bytes[i] == b'"' {
                    i += 1;
                    break;
                }
                i += next_char_len(bytes, i);
            }
            blank_range(&mut out, bytes, start, i);
            continue;
        }

        if ch == b'\'' || (!prev_is_ident && ch == b'b' && next == Some(b'\'')) {
            let start = i;
            let quote_pos = if ch == b'\'' { i } else { i + 1 };
            let after_quote = bytes.get(quote_pos + 1).copied();
            if after_quote == Some(b'\\') {
                let mut cursor = quote_pos + 2;
                while cursor < len && bytes[cursor] != b'\n' {
                    if bytes[cursor] == b'\\' {
                        cursor += 1;
                        cursor += next_char_len(bytes, cursor);
                        continue;
                    }
                    if bytes[cursor] == b'\'' {
                        cursor += 1;
                        break;
                    }
                    cursor += next_char_len(bytes, cursor);
                }
                blank_range(&mut out, bytes, start, cursor);
                i = cursor;
                continue;
            }
            if let Some(after) = after_quote
                && after != b'\''
                && after != b'\n'
                && let Some(scalar) = source[quote_pos + 1..].chars().next()
            {
                let close_pos = quote_pos + 1 + scalar.len_utf8();
                if bytes.get(close_pos) == Some(&b'\'') {
                    let end = close_pos + 1;
                    blank_range(&mut out, bytes, start, end);
                    i = end;
                    continue;
                }
            }
        }

        let step = next_char_len(bytes, i);
        out.extend_from_slice(&bytes[i..i + step]);
        i += step;
    }

    String::from_utf8(out).expect("comment/literal stripper preserves valid UTF-8")
}

fn split_top_level_commas(expr: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0usize;
    let mut start = 0usize;
    for (i, ch) in expr.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => {
                parts.push(expr[start..i].trim());
                start = i + 1;
            }
            _ => {}
        }
    }
    let tail = expr[start..].trim();
    if !tail.is_empty() {
        parts.push(tail);
    }
    parts
}

/// True only when a `cfg(...)` predicate guarantees compilation is restricted to `#[cfg(test)]`.
pub fn is_cfg_test_predicate(raw: &str) -> bool {
    let expr = raw.trim();
    if expr == "test" {
        return true;
    }
    let Some(open) = expr.find('(') else {
        return false;
    };
    if !expr.ends_with(')') {
        return false;
    }
    let op = expr[..open].trim();
    let inner = &expr[open + 1..expr.len() - 1];
    if op == "not" {
        return false;
    }
    let parts = split_top_level_commas(inner);
    if parts.is_empty() {
        return false;
    }
    match op {
        "all" => parts.into_iter().any(is_cfg_test_predicate),
        "any" => parts.into_iter().all(is_cfg_test_predicate),
        _ => false,
    }
}

fn find_matching_bracket(bytes: &[u8], open_index: usize) -> usize {
    let mut depth = 0usize;
    for (i, &b) in bytes.iter().enumerate().skip(open_index) {
        if b == b'[' {
            depth += 1;
        } else if b == b']' {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return i;
            }
        }
    }
    bytes.len().saturating_sub(1)
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

fn posix_dirname(path: &str) -> &str {
    match path.rfind('/') {
        Some(0) => "/",
        Some(idx) => &path[..idx],
        None => ".",
    }
}

fn posix_basename(path: &str) -> &str {
    match path.rfind('/') {
        Some(idx) => &path[idx + 1..],
        None => path,
    }
}

fn posix_join(dir: &str, child: &str) -> String {
    if dir.is_empty() || dir == "." {
        child.to_owned()
    } else if dir.ends_with('/') {
        format!("{dir}{child}")
    } else {
        format!("{dir}/{child}")
    }
}

fn resolve_external_submodule_targets(file_path: &str, mod_name: &str, explicit_path: Option<&str>) -> Vec<String> {
    let dir = posix_dirname(file_path);
    if let Some(explicit) = explicit_path {
        return vec![normalize_posix_path(&posix_join(dir, explicit))];
    }
    let base = posix_basename(file_path);
    if base == "mod.rs" || base == "lib.rs" || base == "main.rs" {
        return vec![
            normalize_posix_path(&posix_join(dir, &format!("{mod_name}.rs"))),
            normalize_posix_path(&posix_join(dir, mod_name)),
        ];
    }
    let stem = base.strip_suffix(".rs").unwrap_or(base);
    vec![
        normalize_posix_path(&posix_join(dir, &format!("{stem}/{mod_name}.rs"))),
        normalize_posix_path(&posix_join(dir, &format!("{stem}/{mod_name}"))),
        normalize_posix_path(&posix_join(dir, &format!("{mod_name}.rs"))),
    ]
}

fn parse_cfg_inner(attr_content: &str) -> Option<&str> {
    let trimmed = attr_content.trim();
    let rest = trimmed.strip_prefix("cfg")?.trim_start();
    rest.strip_prefix('(')?.strip_suffix(')')
}

fn parse_path_attr(raw_attr: &str) -> Option<&str> {
    let trimmed = raw_attr.trim();
    let rest = trimmed.strip_prefix("path")?.trim_start();
    let rest = rest.strip_prefix('=')?.trim_start();
    let inner = rest.strip_prefix('"')?.strip_suffix('"')?;
    (!inner.contains('"')).then_some(inner)
}

fn parse_external_mod_decl(tail: &str) -> Option<&str> {
    let mut rest = tail;
    if let Some(after_pub) = rest.strip_prefix("pub") {
        let trimmed = after_pub.trim_start();
        if trimmed.starts_with('(') {
            let bytes = trimmed.as_bytes();
            let mut depth = 0usize;
            let mut close = None;
            for (idx, &b) in bytes.iter().enumerate() {
                if b == b'(' {
                    depth += 1;
                } else if b == b')' {
                    depth -= 1;
                    if depth == 0 {
                        close = Some(idx);
                        break;
                    }
                }
            }
            let close_idx = close?;
            rest = trimmed[close_idx + 1..].trim_start();
        } else if trimmed.len() < after_pub.len() {
            rest = trimmed;
        }
    }

    let after_mod = rest.strip_prefix("mod")?;
    let trimmed = after_mod.trim_start();
    if trimmed.len() == after_mod.len() {
        return None;
    }
    let bytes = trimmed.as_bytes();
    let first = *bytes.first()?;
    if !is_ident_start(first) {
        return None;
    }
    let mut end = 1usize;
    while end < bytes.len() && is_ident_char(bytes[end]) {
        end += 1;
    }
    let ident = &trimmed[..end];
    let after_ident = trimmed[end..].trim_start();
    after_ident.starts_with(';').then_some(ident)
}

/// Strips `#[cfg(test)]` items (and `#![cfg(test)]` files) while collecting any external
/// `#[cfg(test)] mod ...;` file/dir targets.
pub fn strip_cfg_test_and_collect_excluded(raw: &str, stripped: &str, file_path: &str) -> StrippedRust {
    let mut excluded_submodules = Vec::new();
    let mut buf = stripped.as_bytes().to_vec();
    let bytes = stripped.as_bytes();
    let len = bytes.len();

    let mut i = 0usize;
    while i < len {
        if bytes[i] != b'#' {
            i += 1;
            continue;
        }
        let is_inner = bytes.get(i + 1) == Some(&b'!');
        let bracket_pos = if is_inner { i + 2 } else { i + 1 };
        if bytes.get(bracket_pos) != Some(&b'[') {
            i += 1;
            continue;
        }
        let close_bracket = find_matching_bracket(bytes, bracket_pos);
        let attr_content = stripped[bracket_pos + 1..close_bracket].trim();
        let Some(cfg_inner) = parse_cfg_inner(attr_content) else {
            i = close_bracket + 1;
            continue;
        };
        if !is_cfg_test_predicate(cfg_inner) {
            i = close_bracket + 1;
            continue;
        }

        if is_inner {
            blank_in_place(&mut buf, 0, len);
            let code = String::from_utf8(buf).expect("cfg(test) stripper preserves valid UTF-8");
            return StrippedRust { code, excluded_submodules };
        }

        let mut cursor = close_bracket + 1;
        let mut explicit_path: Option<&str> = None;

        while cursor < len {
            while cursor < len && bytes[cursor].is_ascii_whitespace() {
                cursor += 1;
            }
            if bytes.get(cursor) == Some(&b'#') && bytes.get(cursor + 1) == Some(&b'[') {
                let next_close = find_matching_bracket(bytes, cursor + 1);
                let raw_attr = &raw[cursor + 2..next_close];
                if let Some(p) = parse_path_attr(raw_attr) {
                    explicit_path = Some(p);
                }
                cursor = next_close + 1;
                continue;
            }
            break;
        }

        let tail = &stripped[cursor..];
        if let Some(mod_name) = parse_external_mod_decl(tail) {
            excluded_submodules.extend(resolve_external_submodule_targets(file_path, mod_name, explicit_path));
        }

        let mut brace_depth = 0usize;
        let mut paren_depth = 0usize;
        let mut bracket_depth = 0usize;
        let mut end = cursor;
        while end < len {
            match bytes[end] {
                b'(' => paren_depth += 1,
                b')' => paren_depth = paren_depth.saturating_sub(1),
                b'[' => bracket_depth += 1,
                b']' => bracket_depth = bracket_depth.saturating_sub(1),
                b'{' => brace_depth += 1,
                b'}' => {
                    if brace_depth > 0 {
                        brace_depth -= 1;
                        if brace_depth == 0 && paren_depth == 0 && bracket_depth == 0 {
                            end += 1;
                            break;
                        }
                    }
                }
                b';' if brace_depth == 0 && paren_depth == 0 && bracket_depth == 0 => {
                    end += 1;
                    break;
                }
                _ => {}
            }
            end += 1;
        }

        blank_in_place(&mut buf, i, end);
        i = end;
    }

    let code = String::from_utf8(buf).expect("cfg(test) stripper preserves valid UTF-8");
    StrippedRust { code, excluded_submodules }
}

/// Strips comments, string/char literals, and `#[cfg(test)]` items while keeping 1-based line numbers intact.
pub fn strip_rust_non_code(source: &str, file_path: &str) -> String {
    let no_comments = strip_rust_comments_and_literals(source);
    strip_cfg_test_and_collect_excluded(source, &no_comments, file_path).code
}

pub fn collect_cfg_test_submodules(file_path: &str, raw: &str, stripped: &str) -> Vec<String> {
    strip_cfg_test_and_collect_excluded(raw, stripped, file_path).excluded_submodules
}

pub fn is_excluded_by_cfg_test(file_path: &str, excluded_targets: &BTreeSet<String>) -> bool {
    excluded_targets
        .iter()
        .any(|target| file_path == target || (file_path.starts_with(target.as_str()) && file_path.as_bytes().get(target.len()) == Some(&b'/')))
}

pub fn walk_matching_files(root: &Path, subdirs: &[&str], predicate: impl Fn(&str) -> bool) -> Result<Vec<SourceFile>, String> {
    let mut paths = BTreeSet::new();
    for subdir in subdirs {
        let dir = root.join(subdir);
        if !dir.exists() {
            continue;
        }
        walk_dir_recursive(root, &dir, &predicate, &mut paths)?;
    }

    let mut files = Vec::with_capacity(paths.len());
    for rel in paths {
        let full = root.join(&rel);
        let text = fs::read_to_string(&full).map_err(|err| format!("failed to read {}: {err}", full.display()))?;
        files.push(SourceFile { path: rel, text });
    }
    Ok(files)
}

fn walk_dir_recursive(root: &Path, dir: &Path, predicate: &impl Fn(&str) -> bool, out: &mut BTreeSet<String>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|err| format!("failed to read directory {}: {err}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|err| format!("failed to read dir entry in {}: {err}", dir.display()))?;
        let path = entry.path();
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        if name == "target" || name == "node_modules" || name == ".git" {
            continue;
        }
        let file_type = entry.file_type().map_err(|err| format!("failed to stat {}: {err}", path.display()))?;
        if file_type.is_dir() {
            walk_dir_recursive(root, &path, predicate, out)?;
        } else if file_type.is_file() {
            let rel = path
                .strip_prefix(root)
                .map_err(|err| format!("failed to relativize {}: {err}", path.display()))?
                .to_string_lossy()
                .replace('\\', "/");
            if predicate(&rel) {
                out.insert(rel);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_comments_literals_and_cfg_test_preserving_lines() {
        let source = [
            "use crate::Hub;",
            "// use crate::modules::work::issue::Board;",
            "/* outer /* inner use crate::modules::collab::channel::Chat; */ use crate::modules::team::tool::Farm; */",
            r#"const S: &str = "use crate::modules::work::session::Sessions;";"#,
            r##"const R: &str = r#"use crate::modules::collab::voice::Voice;"#;"##,
            r#"const CH: char = '"';"#,
            "#[cfg(test)]",
            "mod tests {",
            "    use crate::modules::work::issue::Board;",
            "    #[allow(dead_code)]",
            "    fn helper() { let _ = crate::modules::collab::voice::Voice::new(); }",
            "}",
            "#[cfg(not(test))]",
            "use crate::modules::infra::setting::Setting;",
        ]
        .join("\n");

        let stripped = strip_rust_non_code(&source, "<memory>.rs");
        assert_eq!(stripped.split('\n').count(), source.split('\n').count());
        assert!(!stripped.contains("Board"));
        assert!(!stripped.contains("Chat"));
        assert!(!stripped.contains("Farm"));
        assert!(!stripped.contains("Sessions"));
        assert!(!stripped.contains("Voice"));
        assert!(stripped.contains("crate::modules::infra::setting::Setting"));
    }

    #[test]
    fn preserves_lifetimes_while_stripping_unicode_char_literals() {
        let source = "fn f<'a>(x: &'a str) -> char { let c = '中'; c }\n";
        let stripped = strip_rust_comments_and_literals(source);
        assert!(stripped.contains("<'a>"));
        assert!(stripped.contains("&'a str"));
        assert!(!stripped.contains('中'));
    }
}
