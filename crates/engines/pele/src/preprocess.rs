use indexmap::IndexMap;

use crate::config::DiagramConfig;
use crate::error::{Edit, ErrorCode, PeleError};
use crate::util::chars::{is_line_end, is_space, is_word};
use crate::util::yaml::{YamlValue, merge_yaml_maps, parse_yaml};

#[derive(Debug, Clone)]
pub struct Preprocessed {
    pub text: String,
    pub title: Option<String>,
    pub config: DiagramConfig,
    /// Raw YAML map collected from front matter and `%%{init: ...}%%` directives.
    pub raw_config: IndexMap<String, YamlValue>,
    pub with_comments: String,
    pub line_offset: usize,
}

pub fn normalize_line_breaks(text: &str) -> String {
    if !text.contains('\r') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push('\n');
        } else {
            out.push(c);
        }
    }
    out
}

pub fn cleanup_comments(text: &str, mut steps: Option<&mut Vec<Vec<Edit>>>) -> String {
    let without_comments = if text.contains("%%") {
        remove_comment_lines(text, steps.as_deref_mut())
    } else {
        text.to_string()
    };
    let trimmed = without_comments.trim_start();
    let dropped = without_comments.len() - trimmed.len();
    if let Some(steps) = steps {
        steps.push(vec![Edit::new(0, dropped, 0)]);
    }
    trimmed.to_string()
}

/// Removes lines matching `/^\s*%%(?!{)[^\n]+\n?/gm`.
fn remove_comment_lines(text: &str, steps: Option<&mut Vec<Vec<Edit>>>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut edits = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    let mut last = 0;
    while i < bytes.len() {
        let line_start = i;
        let line_end = text[i..].find('\n').map_or(bytes.len(), |rel| i + rel);
        let next = if line_end < bytes.len() { line_end + 1 } else { line_end };
        let line = &text[line_start..line_end];
        let trimmed = line.trim_start();
        if let Some(after) = trimmed.strip_prefix("%%")
            && !after.starts_with('{')
            && !after.is_empty()
        {
            out.push_str(&text[last..line_start]);
            edits.push(Edit::new(line_start, next, 0));
            last = next;
        }
        i = next;
    }
    if last == 0 {
        if let Some(s) = steps {
            s.push(edits);
        }
        return text.to_string();
    }
    out.push_str(&text[last..]);
    if let Some(s) = steps {
        s.push(edits);
    }
    out
}

struct FrontMatter {
    indent: String,
    body: String,
    length: usize,
}

fn match_front_matter(text: &str) -> Option<FrontMatter> {
    let mut cursor = 0;
    for (idx, ch) in text.char_indices() {
        if ch.is_whitespace() && ch != '\n' && ch != '\r' {
            cursor = idx + ch.len_utf8();
        } else {
            break;
        }
    }
    let indent = &text[..cursor];
    if !text[cursor..].starts_with("---") {
        return None;
    }
    let mut opening_ends = Vec::new();
    let mut i = cursor + 3;
    while i < text.len() {
        let ch = text[i..].chars().next()?;
        if !ch.is_whitespace() {
            break;
        }
        if ch == '\n' || ch == '\r' {
            opening_ends.push(i);
        }
        i += ch.len_utf8();
    }
    if opening_ends.is_empty() {
        return None;
    }
    let fence = format!("{indent}---");
    let closing_end = |at: usize| -> Option<usize> {
        let ch = text[at..].chars().next()?;
        if ch != '\n' && ch != '\r' {
            return None;
        }
        let after_nl = at + 1;
        if !text.get(after_nl..)?.starts_with(&fence) {
            return None;
        }
        let mut last = None;
        let mut j = after_nl + fence.len();
        while j < text.len() {
            let c = text[j..].chars().next()?;
            if !c.is_whitespace() {
                break;
            }
            if c == '\n' || c == '\r' {
                last = Some(j);
            }
            j += c.len_utf8();
        }
        last
    };
    let needle = format!("\n{fence}");
    let mut last_fence = None;
    let mut search_end = text.len();
    while let Some(idx) = text[..search_end].rfind(&needle) {
        if idx <= opening_ends[0] {
            break;
        }
        if closing_end(idx).is_some() {
            last_fence = Some(idx);
            break;
        }
        search_end = idx;
    }
    let last_fence = last_fence?;
    let mut opening_end = opening_ends[0];
    for &candidate in &opening_ends {
        if candidate < last_fence {
            opening_end = candidate;
        }
    }
    let body_start = opening_end + 1;
    let mut search_from = body_start.saturating_sub(1);
    while search_from <= last_fence {
        let Some(rel) = text[search_from..].find(&needle) else {
            break;
        };
        let idx = search_from + rel;
        if idx > last_fence {
            break;
        }
        if idx >= body_start
            && let Some(end) = closing_end(idx)
        {
            return Some(FrontMatter {
                indent: indent.to_string(),
                body: text[body_start..idx].to_string(),
                length: end + 1,
            });
        }
        search_from = idx + 1;
    }
    None
}

/// Normalizes `<tag attr="val">` to `<tag attr='val'>` up to the last `>`.
fn normalize_html_attr_quotes(text: &str) -> String {
    let Some(last_close) = text.rfind('>') else {
        return text.to_string();
    };
    if !text[..last_close].contains('<') {
        return text.to_string();
    }
    let prefix = &text[..=last_close];
    let mut out = String::with_capacity(text.len());
    let bytes = prefix.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            let mut j = i + 1;
            while j < bytes.len() && is_word(bytes[j] as u32) {
                j += 1;
            }
            if j > i + 1
                && let Some(rel) = prefix[j..].find('>')
            {
                let close = j + rel;
                out.push_str(&prefix[i..j]);
                let attrs = &prefix[j..close];
                let mut k = 0;
                let ab = attrs.as_bytes();
                while k < ab.len() {
                    if ab[k] == b'='
                        && ab.get(k + 1) == Some(&b'"')
                        && let Some(qrel) = attrs[k + 2..].find('"')
                    {
                        out.push_str("='");
                        out.push_str(&attrs[k + 2..k + 2 + qrel]);
                        out.push('\'');
                        k = k + 2 + qrel + 1;
                        continue;
                    }
                    let ch = attrs[k..].chars().next().unwrap();
                    out.push(ch);
                    k += ch.len_utf8();
                }
                out.push('>');
                i = close + 1;
                continue;
            }
        }
        let ch = prefix[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out.push_str(&text[last_close + 1..]);
    out
}

/// Scans `%%{...}%%` directives, merges valid JSON init blocks into `raw_config`, and strips them.
fn extract_directives(text: &str, raw_config: &mut IndexMap<String, YamlValue>, steps: Option<&mut Vec<Vec<Edit>>>) -> String {
    if !text.contains("%%{") {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut edits = Vec::new();
    let mut cursor = 0;
    while let Some(rel) = text[cursor..].find("%%{") {
        let start = cursor + rel;
        let inner_start = start + 3;
        let (inner_end, end) = match text[inner_start..].find("}%%") {
            Some(r) => (inner_start + r, inner_start + r + 3),
            None => (text.len(), text.len()),
        };
        let body = text[inner_start..inner_end].trim();
        parse_directive_body(body, raw_config);
        out.push_str(&text[cursor..start]);
        edits.push(Edit::new(start, end, 0));
        cursor = end;
    }
    out.push_str(&text[cursor..]);
    if let Some(s) = steps {
        s.push(edits);
    }
    out
}

fn parse_directive_body(body: &str, raw_config: &mut IndexMap<String, YamlValue>) {
    let normalized = body.replace('\'', "\"");
    let bytes = normalized.as_bytes();
    let mut i = 0;
    while i < bytes.len() && is_word(bytes[i] as u32) {
        i += 1;
    }
    if i == 0 {
        return;
    }
    let kind = &normalized[..i];
    if kind.eq_ignore_ascii_case("wrap") {
        raw_config.insert("wrap".to_string(), YamlValue::Bool(true));
        return;
    }
    if kind.eq_ignore_ascii_case("init") || kind.eq_ignore_ascii_case("initialize") {
        let rest = normalized[i..].trim_start();
        let rest = rest.strip_prefix(':').unwrap_or(rest).trim();
        if !rest.is_empty()
            && let Ok(YamlValue::Map(map)) = serde_json::from_str::<YamlValue>(rest)
        {
            merge_yaml_maps(raw_config, &map);
        }
    }
}

pub fn preprocess(source: &str, mut steps: Option<&mut Vec<Vec<Edit>>>) -> Result<Preprocessed, PeleError> {
    let mut text = normalize_line_breaks(source);
    text = normalize_html_attr_quotes(&text);

    let mut raw_config = IndexMap::new();
    let mut title = None;
    let mut line_offset = 0usize;

    if text.contains("---")
        && let Some(front) = match_front_matter(&text)
    {
        let body = if !front.indent.is_empty() {
            front
                .body
                .split('\n')
                .map(|line| line.strip_prefix(&front.indent).unwrap_or(line))
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            front.body
        };
        let parsed = parse_yaml(&body).map_err(|msg| PeleError::new(format!("Front matter is not valid YAML. {msg}"), ErrorCode::Syntax))?;
        if let YamlValue::Map(map) = parsed {
            if let Some(t) = map.get("title")
                && t.is_truthy()
            {
                title = Some(t.to_display_string());
            }
            if let Some(YamlValue::Map(cfg)) = map.get("config") {
                merge_yaml_maps(&mut raw_config, cfg);
            }
            if let Some(dm) = map.get("displayMode")
                && dm.is_truthy()
            {
                let gantt = match raw_config.get_mut("gantt") {
                    Some(YamlValue::Map(m)) => m,
                    _ => {
                        raw_config.insert("gantt".to_string(), YamlValue::Map(IndexMap::new()));
                        match raw_config.get_mut("gantt") {
                            Some(YamlValue::Map(m)) => m,
                            _ => unreachable!(),
                        }
                    }
                };
                gantt.insert("displayMode".to_string(), YamlValue::String(dm.to_display_string()));
            }
        }
        line_offset = text[..front.length].bytes().filter(|&b| b == b'\n').count();
        text = text[front.length..].to_string();
        if let Some(s) = steps.as_deref_mut() {
            s.push(vec![Edit::new(0, front.length, 0)]);
        }
    }

    text = extract_directives(&text, &mut raw_config, steps);
    let cleaned = cleanup_comments(&text, None);
    let config = DiagramConfig::from_yaml_map(&raw_config);
    Ok(Preprocessed {
        text: cleaned,
        title,
        config,
        raw_config,
        with_comments: text,
        line_offset,
    })
}

fn find_line_end(text: &str, from: usize) -> usize {
    for (rel, ch) in text[from..].char_indices() {
        if is_line_end(ch as u32) {
            return from + rel;
        }
    }
    text.len()
}

fn drop_color_semicolons(text: &str, keyword: &str, steps: Option<&mut Vec<Vec<Edit>>>) -> String {
    let mut edits = Vec::new();
    let Some(mut from) = text.find(keyword) else {
        if let Some(s) = steps {
            s.push(edits);
        }
        return text.to_string();
    };
    let mut out = String::with_capacity(text.len());
    let mut last = 0usize;
    loop {
        let line_end = find_line_end(text, from);
        let mut after_colon = false;
        let mut hash: Option<usize> = None;
        for (rel, ch) in text[from + keyword.len()..line_end].char_indices() {
            let abs = from + keyword.len() + rel;
            if ch == ':' {
                after_colon = true;
            } else if ch == '#' {
                if after_colon {
                    hash = Some(abs);
                    break;
                }
            } else if is_space(ch as u32) {
                after_colon = false;
            }
        }
        if let Some(h) = hash
            && let Some(semi) = text[..line_end].rfind(';')
            && semi > h
        {
            edits.push(Edit::new(semi, semi + 1, 0));
            out.push_str(&text[last..semi]);
            last = semi + 1;
        }
        if line_end >= text.len() {
            break;
        }
        let next_start = line_end + text[line_end..].chars().next().map_or(1, char::len_utf8);
        if next_start >= text.len() {
            break;
        }
        match text[next_start..].find(keyword) {
            Some(rel) => from = next_start + rel,
            None => break,
        }
    }
    if let Some(s) = steps {
        s.push(edits);
    }
    if last == 0 {
        text.to_string()
    } else {
        out.push_str(&text[last..]);
        out
    }
}

/// Encodes Mermaid `#name;` / `#35;` codes behind placeholders so `#` and `;` survive lexing.
pub fn encode_entities(text: &str, mut steps: Option<&mut Vec<Vec<Edit>>>) -> String {
    if !text.contains('#') {
        return text.to_string();
    }
    let t1 = drop_color_semicolons(text, "style", steps.as_deref_mut());
    let t2 = drop_color_semicolons(&t1, "classDef", steps.as_deref_mut());
    let mut edits = Vec::new();
    let mut out = String::with_capacity(t2.len());
    let bytes = t2.as_bytes();
    let mut i = 0;
    let mut last = 0;
    while i < bytes.len() {
        if bytes[i] == b'#' {
            let mut j = i + 1;
            while j < bytes.len() && is_word(bytes[j] as u32) {
                j += 1;
            }
            if j > i + 1 && bytes.get(j) == Some(&b';') {
                let inner = &t2[i + 1..j];
                let is_int = {
                    let rest = inner.strip_prefix('+').unwrap_or(inner);
                    !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit())
                };
                let prefix = if is_int { "ﬂ°°" } else { "ﬂ°" };
                let code = format!("{prefix}{inner}¶ß");
                out.push_str(&t2[last..i]);
                out.push_str(&code);
                edits.push(Edit::new(i, j + 1, code.len()));
                i = j + 1;
                last = i;
                continue;
            }
        }
        i += 1;
    }
    if let Some(s) = steps {
        s.push(edits);
    }
    if last == 0 {
        t2
    } else {
        out.push_str(&t2[last..]);
        out
    }
}
