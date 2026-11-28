use std::ffi::OsString;
use std::os::unix::ffi::OsStringExt;
use std::path::{Path, PathBuf};

use crate::Point;

use super::file::{parse_hash_location, parse_path_and_location};
use super::line::LogicalLine;
use super::{LinkMatch, LinkTarget};

pub(super) fn starts_with_ignore_ascii_case(s: &str, prefix: &str) -> bool {
    s.len() >= prefix.len() && s.is_char_boundary(prefix.len()) && s[..prefix.len()].eq_ignore_ascii_case(prefix)
}

pub(super) fn is_cjk_or_fullwidth_punct(c: char) -> bool {
    matches!(
        c,
        '\u{3000}'..='\u{303F}'
            | '\u{FF01}'..='\u{FF0F}'
            | '\u{FF1A}'..='\u{FF20}'
            | '\u{FF3B}'..='\u{FF40}'
            | '\u{FF5B}'..='\u{FF65}'
            | '\u{2018}'..='\u{201F}'
            | '\u{2026}'
            | '\u{2014}'
    )
}

fn is_url_stop(c: char) -> bool {
    c.is_whitespace() || c.is_control() || matches!(c, '<' | '>' | '"' | '`' | '\\' | '{' | '}' | '|' | '^') || is_cjk_or_fullwidth_punct(c)
}

fn trim_url_end(raw: &str) -> &str {
    let mut s = raw;
    while let Some(last) = s.chars().next_back() {
        let should_trim = match last {
            '.' | ',' | ';' | ':' | '!' | '?' | '\'' | '"' | '`' => true,
            ')' => {
                let open = s.bytes().filter(|&b| b == b'(').count();
                let close = s.bytes().filter(|&b| b == b')').count();
                close > open
            }
            ']' => {
                let open = s.bytes().filter(|&b| b == b'[').count();
                let close = s.bytes().filter(|&b| b == b']').count();
                close > open
            }
            _ => false,
        };
        if should_trim {
            s = &s[..s.len() - last.len_utf8()];
        } else {
            break;
        }
    }
    s
}

pub(super) fn is_valid_http_url(url: &str) -> bool {
    let rest = if starts_with_ignore_ascii_case(url, "https://") {
        &url["https://".len()..]
    } else if starts_with_ignore_ascii_case(url, "http://") {
        &url["http://".len()..]
    } else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return false;
    }
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, hp)| hp);
    if host_port.is_empty() {
        return false;
    }
    if let Some(after_open) = host_port.strip_prefix('[') {
        let Some((ipv6, tail)) = after_open.split_once(']') else {
            return false;
        };
        if ipv6.is_empty() || !ipv6.bytes().all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.') {
            return false;
        }
        return tail.is_empty()
            || tail
                .strip_prefix(':')
                .is_some_and(|port| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()));
    }
    let host = match host_port.rsplit_once(':') {
        Some((h, port)) => {
            if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
                return false;
            }
            h
        }
        None => host_port,
    };
    if host.is_empty() || host.starts_with('.') || host.ends_with('.') || host.contains("..") {
        return false;
    }
    host.chars().any(char::is_alphanumeric) && host.chars().all(|c| c.is_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

fn find_next_scheme(text: &str, from: usize) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut i = from;
    while i + 7 <= bytes.len() {
        let scheme_len = if starts_with_ignore_ascii_case(&text[i..], "https://") {
            Some("https://".len())
        } else if starts_with_ignore_ascii_case(&text[i..], "http://") {
            Some("http://".len())
        } else if starts_with_ignore_ascii_case(&text[i..], "file://") {
            Some("file://".len())
        } else {
            None
        };
        if let Some(len) = scheme_len {
            let valid_left = i == 0 || !text[..i].chars().next_back().is_some_and(|c| c.is_ascii_alphanumeric());
            if valid_left {
                return Some((i, len));
            }
        }
        let step = text[i..].chars().next().map_or(1, char::len_utf8);
        i += step;
    }
    None
}

pub(super) fn url_match_at(logical: &LogicalLine, target_byte: usize, at: Point) -> Option<LinkMatch> {
    let text = &logical.text;
    let mut cursor = 0;
    while let Some((start, scheme_len)) = find_next_scheme(text, cursor) {
        if start > target_byte {
            break;
        }
        let raw_end = text[start + scheme_len..].find(is_url_stop).map_or(text.len(), |off| start + scheme_len + off);
        let trimmed = trim_url_end(&text[start..raw_end]);
        let end = start + trimmed.len();
        cursor = end.max(start + scheme_len);
        if target_byte < start || target_byte >= end {
            continue;
        }
        let target = if starts_with_ignore_ascii_case(trimmed, "file://") {
            resolve_file_url(trimmed, true)?
        } else if is_valid_http_url(trimmed) {
            LinkTarget::Url(trimmed.to_string())
        } else {
            continue;
        };
        let spans = logical.spans_for_bytes(start, end);
        if spans.iter().any(|span| span.contains(at)) {
            return Some(LinkMatch { target, spans });
        }
    }
    None
}

pub(super) fn resolve_file_url(url: &str, allow_dir: bool) -> Option<LinkTarget> {
    let rest = if starts_with_ignore_ascii_case(url, "file://") {
        &url["file://".len()..]
    } else {
        return None;
    };
    let slash = rest.find('/')?;
    let host = &rest[..slash];
    if host.chars().any(char::is_whitespace) {
        return None;
    }
    let path_part = &rest[slash..];
    let (without_frag, frag) = match path_part.split_once('#') {
        Some((p, f)) => (p, Some(f)),
        None => (path_part, None),
    };
    let without_query = without_frag.split_once('?').map_or(without_frag, |(p, _)| p);
    let decoded_bytes: Vec<u8> = percent_encoding::percent_decode(without_query.as_bytes()).collect();
    let decoded = PathBuf::from(OsString::from_vec(decoded_bytes));
    if decoded.as_os_str().len() <= 1 {
        return None;
    }
    let (frag_line, frag_col) = frag.and_then(parse_hash_location).unwrap_or((None, None));

    if path_matches_kind(&decoded, allow_dir) {
        let canonical = canonical_or_keep(decoded);
        return Some(LinkTarget::File {
            path: canonical,
            line: frag_line,
            col: frag_col,
        });
    }

    if frag_line.is_none()
        && let Some(decoded_str) = decoded.to_str()
    {
        let (base, line, col) = parse_path_and_location(decoded_str);
        if base.len() < decoded_str.len() {
            let candidate = PathBuf::from(base);
            if path_matches_kind(&candidate, allow_dir) {
                return Some(LinkTarget::File {
                    path: canonical_or_keep(candidate),
                    line,
                    col,
                });
            }
        }
    }
    None
}

fn path_matches_kind(path: &Path, allow_dir: bool) -> bool {
    std::fs::metadata(path).is_ok_and(|meta| meta.is_file() || (allow_dir && meta.is_dir()))
}

pub(super) fn canonical_or_keep(path: PathBuf) -> PathBuf {
    std::fs::canonicalize(&path).unwrap_or(path)
}
