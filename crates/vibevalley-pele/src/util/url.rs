use crate::svg::builder::{esc, is_invalid_xml_char};
use crate::text::entities::decode_entities;
use crate::{LinkInfo, RenderOptions};

const BLANK: &str = "about:blank";
const LINK_SCHEMES: &[&str] = &["http", "https", "mailto", "tel"];
const IMAGE_SCHEMES: &[&str] = &["http", "https"];

fn is_ctrl_char(c: char) -> bool {
    let code = c as u32;
    code <= 0x1f || (0x7f..=0x9f).contains(&code) || (0x2000..=0x200d).contains(&code) || code == 0xfeff || code == 0xfffe || code == 0xffff
}

fn decode_uri_component(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2]))
        {
            out.push((h << 4) | l);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn strip_ctrl(s: &str) -> (String, bool) {
    let mut changed = false;
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if is_ctrl_char(c) {
            changed = true;
        } else {
            out.push(c);
        }
    }
    (out, changed)
}

/// Replaces `&#(\w+)(^\w|;)?` the way `@braintree/sanitize-url` does.
fn replace_html_entities(s: &str) -> (String, bool) {
    let mut out = String::with_capacity(s.len());
    let mut changed = false;
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'&' && bytes.get(i + 1) == Some(&b'#') {
            let mut j = i + 2;
            while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_') {
                j += 1;
            }
            if j > i + 2 {
                let inner = &s[i + 2..j];
                let end = if bytes.get(j) == Some(&b';') { j + 1 } else { j };
                // JS `String.fromCharCode(dec)` coerces decimal strings to u16 (NaN -> 0 -> '\0').
                let code = if let Ok(n) = inner.parse::<u32>() { n & 0xffff } else { 0 };
                if let Some(ch) = char::from_u32(code) {
                    out.push(ch);
                }
                changed = true;
                i = end;
                continue;
            }
        }
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    (out, changed)
}

fn strip_html_ctrl_entities(s: &str) -> (String, bool) {
    let mut out = String::with_capacity(s.len());
    let mut changed = false;
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let rest_bytes = &bytes[i..];
        if rest_bytes.get(..9).is_some_and(|b| b.eq_ignore_ascii_case(b"&newline;")) {
            changed = true;
            i += 9;
        } else if rest_bytes.get(..5).is_some_and(|b| b.eq_ignore_ascii_case(b"&tab;")) {
            changed = true;
            i += 5;
        } else {
            let ch = s[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    (out, changed)
}

fn strip_ws_escapes(s: &str) -> (String, bool) {
    let mut out = String::with_capacity(s.len());
    let mut changed = false;
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let slash_len = if bytes[i] == b'\\' {
            Some(1)
        } else if i + 3 <= bytes.len() && bytes[i..i + 3].eq_ignore_ascii_case(b"%5c") {
            Some(3)
        } else {
            None
        };
        if let Some(slen) = slash_len {
            let after = i + slen;
            if after + 3 <= bytes.len()
                && (bytes[after..after + 3].eq_ignore_ascii_case(b"%6e")
                    || bytes[after..after + 3].eq_ignore_ascii_case(b"%72")
                    || bytes[after..after + 3].eq_ignore_ascii_case(b"%74"))
            {
                changed = true;
                i = after + 3;
                continue;
            }
            if matches!(bytes.get(after), Some(b'n' | b'r' | b't')) {
                changed = true;
                i = after + 1;
                continue;
            }
        }
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    (out, changed)
}

fn has_unwrap_artifacts(s: &str) -> bool {
    let (_, c1) = strip_ctrl(s);
    if c1 {
        return true;
    }
    let (_, c2) = replace_html_entities(s);
    if c2 {
        return true;
    }
    let (_, c3) = strip_html_ctrl_entities(s);
    if c3 {
        return true;
    }
    let (_, c4) = strip_ws_escapes(s);
    c4
}

fn unwrap_url(url: &str, percent: bool) -> Option<String> {
    let mut out = if percent { decode_uri_component(url.trim()) } else { url.trim().to_string() };
    let mut rounds = 0usize;
    loop {
        rounds += 1;
        if rounds > 32 {
            return None;
        }
        let (s, _) = strip_ctrl(&out);
        let (s, _) = replace_html_entities(&s);
        let (s, _) = strip_html_ctrl_entities(&s);
        let (s, _) = strip_ctrl(&s);
        let (s, _) = strip_ws_escapes(&s);
        out = s.trim().to_string();
        if percent {
            out = decode_uri_component(&out);
        }
        if !has_unwrap_artifacts(&out) {
            break;
        }
    }
    Some(out)
}

fn extract_scheme_prefix(s: &str) -> Option<&str> {
    let first_line = s.split('\n').next().unwrap_or(s);
    let mut best: Option<usize> = None;
    for (idx, _) in first_line.match_indices(':') {
        if idx > 0 {
            best = Some(idx + 1);
        }
    }
    let lower = first_line.to_ascii_lowercase();
    for (idx, _) in lower.match_indices("&colon;") {
        if idx > 0 {
            let end = idx + 7;
            if best.is_none_or(|b| end > b) {
                best = Some(end);
            }
        }
    }
    best.map(|end| &first_line[..end])
}

fn is_invalid_protocol(protocol: &str) -> bool {
    for line in protocol.split('\n') {
        let rest = line.trim_start_matches(|c: char| !(c.is_ascii_alphanumeric() || c == '_'));
        let lower = rest.to_ascii_lowercase();
        if lower.starts_with("javascript") || lower.starts_with("data") || lower.starts_with("vbscript") {
            return true;
        }
    }
    false
}

/// Minimal WHATWG normalization for `http:`/`https:` URLs without `://` matching JS `new URL(...)`.
fn normalize_http_url(raw: &str) -> Option<String> {
    let lower = raw.to_ascii_lowercase();
    let (scheme, rest) = if lower.starts_with("http:") {
        ("http", &raw[5..])
    } else {
        lower.strip_prefix("https:")?;
        ("https", &raw[6..])
    };
    let after_slashes = rest.trim_start_matches('/');
    if after_slashes.is_empty() {
        return None;
    }
    let auth_end = after_slashes.find(['/', '?', '#']).unwrap_or(after_slashes.len());
    let authority = &after_slashes[..auth_end];
    if authority.is_empty() || authority.contains(char::is_whitespace) {
        return None;
    }
    let tail = &after_slashes[auth_end..];
    let (host_part, port_part) = match authority.rfind(':') {
        Some(idx) if !authority[idx + 1..].is_empty() && authority[idx + 1..].bytes().all(|b| b.is_ascii_digit()) => {
            (&authority[..idx], Some(&authority[idx + 1..]))
        }
        Some(idx) if authority[idx + 1..].is_empty() => (&authority[..idx], None),
        _ => (authority, None),
    };
    if host_part.is_empty() {
        return None;
    }
    let host_lower = host_part.to_ascii_lowercase();
    let default_port = if scheme == "http" { "80" } else { "443" };
    let mut out = format!("{scheme}://{host_lower}");
    if let Some(p) = port_part
        && p != default_port
    {
        out.push(':');
        out.push_str(p);
    }
    let path_and_rest = if tail.is_empty() || tail.starts_with('?') || tail.starts_with('#') {
        format!("/{tail}")
    } else {
        tail.to_string()
    };
    for c in path_and_rest.chars() {
        if c == ' ' {
            out.push_str("%20");
        } else {
            out.push(c);
        }
    }
    Some(out)
}

/// Refuses what `@braintree/sanitize-url` refuses while preserving percent escapes.
pub fn sanitize_url(url: &str) -> String {
    if url.is_empty() {
        return BLANK.to_string();
    }
    let Some(decoded) = unwrap_url(url, true) else {
        return BLANK.to_string();
    };
    let Some(kept) = unwrap_url(url, false) else {
        return BLANK.to_string();
    };
    if decoded.is_empty() || kept.is_empty() {
        return BLANK.to_string();
    }
    if decoded.starts_with('.') || decoded.starts_with('/') {
        return kept;
    }
    let Some(scheme_raw) = extract_scheme_prefix(decoded.trim_start()) else {
        return kept;
    };
    let protocol = scheme_raw.to_ascii_lowercase();
    let protocol = protocol.trim();
    if is_invalid_protocol(protocol) {
        return BLANK.to_string();
    }
    let normalized = kept.trim_start().replace('\\', "/");
    if protocol == "mailto:" || protocol.contains("://") {
        return normalized;
    }
    if protocol == "http:" || protocol == "https:" {
        if let Some(norm) = normalize_http_url(&normalized) {
            return norm;
        }
        return BLANK.to_string();
    }
    normalized
}

pub fn safe_url(url: &str) -> String {
    sanitize_url(&decode_entities(url))
}

fn scheme_name(url: &str) -> Option<&str> {
    let bytes = url.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_alphabetic() {
        return None;
    }
    let mut i = 1;
    while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || matches!(bytes[i], b'+' | b'.' | b'-')) {
        i += 1;
    }
    if bytes.get(i) == Some(&b':') { Some(&url[..i]) } else { None }
}

fn is_allowed(url: &str, schemes: &[String]) -> bool {
    let bytes = url.as_bytes();
    if bytes.len() >= 2 && matches!(bytes[0], b'/' | b'\\') && matches!(bytes[1], b'/' | b'\\') {
        return false;
    }
    match scheme_name(url) {
        None => true,
        Some(s) => schemes.iter().any(|ok| ok.eq_ignore_ascii_case(s)),
    }
}

fn allow<'a>(url: &'a str, schemes: &[String]) -> Option<&'a str> {
    let decoded = unwrap_url(url, true)?;
    if is_allowed(url, schemes) && is_allowed(&decoded, schemes) {
        Some(url)
    } else {
        None
    }
}

fn effective_schemes(custom: Option<&[String]>, defaults: &[&str]) -> Vec<String> {
    match custom {
        Some(list) => list.to_vec(),
        None => defaults.iter().map(|s| (*s).to_string()).collect(),
    }
}

pub fn link_url<'a>(url: &'a str, options: &RenderOptions<'_>) -> Option<&'a str> {
    if !options.links {
        return None;
    }
    let schemes = effective_schemes(options.link_schemes.as_deref(), LINK_SCHEMES);
    allow(url, &schemes)
}

pub fn image_url<'a>(url: &'a str, options: &RenderOptions<'_>) -> Option<&'a str> {
    if !options.images {
        return None;
    }
    let schemes = effective_schemes(options.image_schemes.as_deref(), IMAGE_SCHEMES);
    allow(url, &schemes)
}

pub fn internal_link(name: &str, options: &RenderOptions<'_>) -> bool {
    let url = sanitize_url(name);
    if url == BLANK || link_url(&url, options).is_none() {
        return false;
    }
    let seen: String = name.chars().filter(|&c| !is_invalid_xml_char(c) && !matches!(c, '\t' | '\n' | '\r')).collect();
    let seen = seen.trim_start_matches(|c: char| (c as u32) <= 0x20);
    link_url(seen, options).is_some()
}

pub fn rel_attr(options: &RenderOptions<'_>) -> String {
    let rel = options.link_rel.as_deref().unwrap_or("noopener");
    if rel.is_empty() { String::new() } else { format!(r#" rel="{}""#, esc(rel)) }
}

pub fn linked(body: &str, url: &str, id: &str, links: &mut Vec<LinkInfo>, options: &RenderOptions<'_>, attrs: &str) -> String {
    let Some(href) = link_url(url, options) else {
        return body.to_string();
    };
    links.push(LinkInfo {
        id: id.to_string(),
        href: href.to_string(),
        internal: false,
    });
    format!(r#"<a href="{}"{}{}>{body}</a>"#, esc(href), attrs, rel_attr(options))
}
