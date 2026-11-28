use std::path::{Path, PathBuf};

use crate::Point;

use super::line::LogicalLine;
use super::url::{canonical_or_keep, is_cjk_or_fullwidth_punct};
use super::{LinkMatch, LinkResolveContext, LinkTarget, Resolver};

/// Maximum byte length searched for a quoted file path containing spaces.
pub(super) const MAX_QUOTED_PATH_BYTES: usize = 512;

/// Common extensionless filenames that may appear as bare tokens without `/`.
const EXTENSIONLESS_FILENAMES: &[&str] = &[
    "AUTHORS",
    "BUILD",
    "Brewfile",
    "CHANGELOG",
    "CODEOWNERS",
    "COPYING",
    "Containerfile",
    "Dockerfile",
    "Gemfile",
    "Jenkinsfile",
    "Justfile",
    "LICENSE",
    "Makefile",
    "NOTICE",
    "Procfile",
    "README",
    "Rakefile",
    "Vagrantfile",
    "WORKSPACE",
];

pub(super) fn file_match_at<F: FnOnce() -> LinkResolveContext>(
    logical: &LogicalLine,
    target_byte: usize,
    at: Point,
    resolver: &mut Resolver<'_, F>,
) -> Option<LinkMatch> {
    let text = &logical.text;

    if let Some((tok_start, tok_end)) = token_bounds_around(text, target_byte)
        && let Some((match_start, match_end, target)) = resolve_within_token(text, tok_start, tok_end, target_byte, resolver)
    {
        let spans = logical.spans_for_bytes(match_start, match_end);
        if spans.iter().any(|span| span.contains(at)) {
            return Some(LinkMatch { target, spans });
        }
    }

    if let Some((match_start, match_end, target)) = resolve_quoted_path_at(text, target_byte, resolver) {
        let spans = logical.spans_for_bytes(match_start, match_end);
        if spans.iter().any(|span| span.contains(at)) {
            return Some(LinkMatch { target, spans });
        }
    }

    None
}

/// Finds the whitespace-delimited token around `target_byte`, bridging a
/// single space inside a trailing `(line, col)` location suffix.
fn token_bounds_around(text: &str, target_byte: usize) -> Option<(usize, usize)> {
    let cur_char = text[target_byte..].chars().next()?;
    if cur_char.is_whitespace() {
        if cur_char == ' '
            && let Some((s, e)) = paren_space_bridge(text, target_byte)
        {
            return Some((s, e));
        }
        return None;
    }

    let mut start = text[..target_byte]
        .rfind(char::is_whitespace)
        .map_or(0, |i| i + text[i..].chars().next().map_or(1, char::len_utf8));
    let mut end = text[target_byte..].find(char::is_whitespace).map_or(text.len(), |off| target_byte + off);

    if text.as_bytes().get(end) == Some(&b' ')
        && let Some((s, e)) = paren_space_bridge(text, end)
        && s == start
    {
        end = e;
    }

    if start >= 1
        && text.as_bytes()[start - 1] == b' '
        && let Some((s, e)) = paren_space_bridge(text, start - 1)
        && e == end
    {
        start = s;
    }

    Some((start, end))
}

/// If `space_idx` points to the space in `<path>(<digits>, <digits>)`, returns
/// the full token range `(start, end)`.
fn paren_space_bridge(text: &str, space_idx: usize) -> Option<(usize, usize)> {
    let left_end = space_idx;
    let left_start = text[..left_end]
        .rfind(char::is_whitespace)
        .map_or(0, |i| i + text[i..].chars().next().map_or(1, char::len_utf8));
    let left = &text[left_start..left_end];
    let left_before_comma = left.strip_suffix(',')?;
    let open = left_before_comma.rfind('(')?;
    let line_part = &left_before_comma[open + 1..];
    if open == 0 || line_part.is_empty() || !line_part.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }

    let right_start = space_idx + 1;
    let right_end = text[right_start..].find(char::is_whitespace).map_or(text.len(), |off| right_start + off);
    let right = &text[right_start..right_end];
    let close = right.find(')')?;
    let col_part = &right[..close];
    if col_part.is_empty() || !col_part.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((left_start, right_end))
}

fn is_hard_path_delim(c: char) -> bool {
    matches!(c, '"' | '\'' | '`' | '<' | '>' | '{' | '}' | '[' | ']' | '|' | ';' | '=') || is_cjk_or_fullwidth_punct(c)
}

fn trim_path_wrappers(s: &str, base_offset: usize) -> (usize, usize) {
    let mut start = 0usize;
    let mut end = s.len();

    while start < end {
        let ch = s[start..end].chars().next().unwrap();
        if matches!(ch, '(' | '[' | '{' | '<' | '\'' | '"' | '`' | ',' | ';') || is_cjk_or_fullwidth_punct(ch) {
            start += ch.len_utf8();
        } else {
            break;
        }
    }

    while start < end {
        let slice = &s[start..end];
        let Some(ch) = slice.chars().next_back() else {
            break;
        };
        let should_trim = match ch {
            '.' | ',' | ';' | ':' | '!' | '?' | '\'' | '"' | '`' | '>' | '}' => true,
            ')' => {
                let open = slice.bytes().filter(|&b| b == b'(').count();
                let close = slice.bytes().filter(|&b| b == b')').count();
                close > open
            }
            ']' => {
                let open = slice.bytes().filter(|&b| b == b'[').count();
                let close = slice.bytes().filter(|&b| b == b']').count();
                close > open
            }
            c if is_cjk_or_fullwidth_punct(c) => true,
            _ => false,
        };
        if should_trim {
            end -= ch.len_utf8();
        } else {
            break;
        }
    }

    (base_offset + start, base_offset + end)
}

/// Splits a whitespace token into the sub-segment containing `target_byte`,
/// respecting hard delimiters (and commas outside trailing `(line,col)`).
fn split_subsegment(text: &str, tok_start: usize, tok_end: usize, target_byte: usize) -> (usize, usize) {
    let tok = &text[tok_start..tok_end];
    let rel = target_byte - tok_start;

    let mut seg_start = 0usize;
    for (idx, ch) in tok[..rel].char_indices().rev() {
        if is_hard_path_delim(ch) || (ch == ',' && !comma_inside_location_parens(tok, idx)) {
            seg_start = idx + ch.len_utf8();
            break;
        }
    }

    let mut seg_end = tok.len();
    for (off, ch) in tok[rel..].char_indices() {
        let idx = rel + off;
        if is_hard_path_delim(ch) || (ch == ',' && !comma_inside_location_parens(tok, idx)) {
            seg_end = idx;
            break;
        }
    }

    (tok_start + seg_start, tok_start + seg_end)
}

fn comma_inside_location_parens(tok: &str, comma_idx: usize) -> bool {
    let Some(open) = tok[..comma_idx].rfind('(') else {
        return false;
    };
    let before = tok[open + 1..comma_idx].trim();
    if before.is_empty() || !before.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let after = &tok[comma_idx + 1..];
    let Some(close) = after.find(')') else {
        return false;
    };
    let col_part = after[..close].trim();
    !col_part.is_empty() && col_part.bytes().all(|b| b.is_ascii_digit())
}

fn resolve_within_token<F: FnOnce() -> LinkResolveContext>(
    text: &str,
    tok_start: usize,
    tok_end: usize,
    target_byte: usize,
    resolver: &mut Resolver<'_, F>,
) -> Option<(usize, usize, LinkTarget)> {
    let (seg_start, seg_end) = split_subsegment(text, tok_start, tok_end, target_byte);
    let (s, e) = trim_path_wrappers(&text[seg_start..seg_end], seg_start);
    if let Some(hit) = try_span(text, s, e, target_byte, resolver) {
        return Some(hit);
    }

    if s < e && target_byte >= s && target_byte < e {
        let segment = &text[s..e];
        let rel_target = target_byte - s;
        if let Some(open) = segment[..rel_target].rfind('(') {
            let (ns, ne) = trim_path_wrappers(&segment[open + 1..], s + open + 1);
            if let Some(hit) = try_span(text, ns, ne, target_byte, resolver) {
                return Some(hit);
            }
        }

        if (segment.starts_with("a/") || segment.starts_with("b/")) && segment.len() > 2 {
            let stripped_start = s + 2;
            if let Some(hit) = try_span(text, stripped_start, e, target_byte, resolver) {
                return Some(hit);
            }
        }

        for (colon_off, ch) in segment[..rel_target].char_indices().rev() {
            if ch == ':' {
                let after = s + colon_off + 1;
                let (ns, ne) = trim_path_wrappers(&text[after..e], after);
                if let Some(hit) = try_span(text, ns, ne, target_byte, resolver) {
                    return Some(hit);
                }
                if target_byte < ne
                    && let Some(next_colon) = text[target_byte..ne].find(':')
                {
                    let before_next = target_byte + next_colon;
                    if let Some(hit) = try_span(text, ns, before_next, target_byte, resolver) {
                        return Some(hit);
                    }
                }
            }
        }
        if let Some(next_colon) = text[target_byte..e].find(':') {
            let before_next = target_byte + next_colon;
            if let Some(hit) = try_span(text, s, before_next, target_byte, resolver) {
                return Some(hit);
            }
        }
    }

    None
}

fn try_span<F: FnOnce() -> LinkResolveContext>(
    text: &str,
    start: usize,
    end: usize,
    target_byte: usize,
    resolver: &mut Resolver<'_, F>,
) -> Option<(usize, usize, LinkTarget)> {
    if start >= end || target_byte < start || target_byte >= end {
        return None;
    }
    let target = resolve_file_candidate(&text[start..end], resolver)?;
    Some((start, end, target))
}

fn resolve_quoted_path_at<F: FnOnce() -> LinkResolveContext>(
    text: &str,
    target_byte: usize,
    resolver: &mut Resolver<'_, F>,
) -> Option<(usize, usize, LinkTarget)> {
    let min_left = target_byte.saturating_sub(MAX_QUOTED_PATH_BYTES);
    let max_right = text.floor_char_boundary(target_byte.saturating_add(MAX_QUOTED_PATH_BYTES).min(text.len()));
    for quote in ['"', '\''] {
        let Some(open_rel) = text[..target_byte].rfind(quote) else {
            continue;
        };
        if open_rel < min_left {
            continue;
        }
        let inner_start = open_rel + 1;
        let Some(close_off) = text[target_byte..max_right].find(quote) else {
            continue;
        };
        let inner_end = target_byte + close_off;
        if inner_start >= inner_end || inner_end - inner_start > MAX_QUOTED_PATH_BYTES {
            continue;
        }
        let inner = &text[inner_start..inner_end];
        if !inner.contains(' ') {
            continue;
        }
        if let Some(target) = resolve_file_candidate(inner, resolver) {
            return Some((inner_start, inner_end, target));
        }
    }
    None
}

fn resolve_file_candidate<F: FnOnce() -> LinkResolveContext>(raw: &str, resolver: &mut Resolver<'_, F>) -> Option<LinkTarget> {
    if raw.is_empty() || raw.contains('\0') || raw.contains("://") {
        return None;
    }

    let (base, line, col) = parse_path_and_location(raw);
    if looks_like_path_candidate(base)
        && let Some(path) = resolve_existing_file(base, resolver)
    {
        return Some(LinkTarget::File { path, line, col });
    }

    if base.len() < raw.len()
        && looks_like_path_candidate(raw)
        && let Some(path) = resolve_existing_file(raw, resolver)
    {
        return Some(LinkTarget::File { path, line: None, col: None });
    }

    None
}

fn looks_like_path_candidate(path: &str) -> bool {
    if path.is_empty() || matches!(path, "." | ".." | "/" | "~" | "~/" | "./" | "../") || path.starts_with("//") || path.ends_with('/') {
        return false;
    }
    if path.starts_with('/') || path.starts_with("~/") || path.starts_with("./") || path.starts_with("../") {
        return path.chars().any(char::is_alphanumeric);
    }
    if path.contains('/') {
        return path.chars().any(char::is_alphanumeric);
    }
    if EXTENSIONLESS_FILENAMES.contains(&path) {
        return true;
    }
    if let Some((stem, ext)) = path.rsplit_once('.')
        && (!stem.is_empty() || !ext.is_empty())
        && path.chars().any(char::is_alphabetic)
    {
        return true;
    }
    false
}

fn resolve_existing_file<F: FnOnce() -> LinkResolveContext>(path_str: &str, resolver: &mut Resolver<'_, F>) -> Option<PathBuf> {
    if let Some(after_tilde) = path_str.strip_prefix("~/") {
        let home = resolver.get().home.as_ref()?;
        let candidate = home.join(after_tilde);
        return candidate.is_file().then(|| canonical_or_keep(candidate));
    }

    let path = Path::new(path_str);
    if path.is_absolute() {
        return path.is_file().then(|| canonical_or_keep(path.to_path_buf()));
    }

    let ctx = resolver.get();
    if let Some(cwd) = &ctx.cwd {
        let candidate = cwd.join(path);
        if candidate.is_file() {
            return Some(canonical_or_keep(candidate));
        }
    }
    if let Some(root) = &ctx.project_root
        && ctx.cwd.as_deref() != Some(root.as_path())
    {
        let candidate = root.join(path);
        if candidate.is_file() {
            return Some(canonical_or_keep(candidate));
        }
    }
    None
}

/// Splits an optional `(line,col)`, `(line)`, `#Lline[Ccol]`, `:line:col`, or
/// `:line` location suffix from a path string.
pub(crate) fn parse_path_and_location(raw: &str) -> (&str, Option<u32>, Option<u32>) {
    if let Some(without_close) = raw.strip_suffix(')')
        && let Some(open) = without_close.rfind('(')
        && open > 0
    {
        let base = &without_close[..open];
        let inside = &without_close[open + 1..];
        if let Some((l, c)) = inside.split_once(',') {
            let l = l.trim();
            let c = c.trim();
            if let (Some(line), Some(col)) = (parse_ascii_u32(l), parse_ascii_u32(c)) {
                return (base, positive_u32(line), positive_u32(col));
            }
        } else if let Some(line) = parse_ascii_u32(inside.trim()) {
            return (base, positive_u32(line), None);
        }
    }

    if let Some((base, frag)) = raw.rsplit_once('#')
        && !base.is_empty()
        && let Some((line, col)) = parse_hash_location(frag)
    {
        return (base, line, col);
    }

    if let Some((left, last)) = raw.rsplit_once(':')
        && !left.is_empty()
        && let Some(n1) = parse_ascii_u32(last)
    {
        if let Some((path, line_str)) = left.rsplit_once(':')
            && !path.is_empty()
            && let Some(line) = parse_ascii_u32(line_str)
        {
            return (path, positive_u32(line), positive_u32(n1));
        }
        return (left, positive_u32(n1), None);
    }

    (raw, None, None)
}

pub(super) fn parse_hash_location(frag: &str) -> Option<(Option<u32>, Option<u32>)> {
    let body = frag.strip_prefix('L').or_else(|| frag.strip_prefix('l')).unwrap_or(frag);
    if let Some((line_part, col_part)) = body.split_once(['C', 'c']) {
        let line = parse_ascii_u32(line_part)?;
        let col = parse_ascii_u32(col_part)?;
        return Some((positive_u32(line), positive_u32(col)));
    }
    if let Some((start_part, end_part)) = body.split_once('-') {
        let line = parse_ascii_u32(start_part)?;
        let end_digits = end_part.strip_prefix('L').or_else(|| end_part.strip_prefix('l')).unwrap_or(end_part);
        let _ = parse_ascii_u32(end_digits)?;
        return Some((positive_u32(line), None));
    }
    let line = parse_ascii_u32(body)?;
    Some((positive_u32(line), None))
}

fn parse_ascii_u32(s: &str) -> Option<u32> {
    (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        .then(|| s.parse::<u32>().ok())
        .flatten()
}

fn positive_u32(n: u32) -> Option<u32> {
    (n > 0).then_some(n)
}
