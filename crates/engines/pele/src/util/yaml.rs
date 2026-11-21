use indexmap::IndexMap;
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use std::fmt;

/// Boundary representation for YAML front matter and `@{ ... }` node/participant metadata.
/// Decoded immediately into typed domain structs (`DiagramConfig`, `NodeMetadata`, etc.).
#[derive(Debug, Clone, PartialEq)]
pub enum YamlValue {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Seq(Vec<YamlValue>),
    Map(IndexMap<String, YamlValue>),
}

impl<'de> Deserialize<'de> for YamlValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct YamlVisitor;

        impl<'de> Visitor<'de> for YamlVisitor {
            type Value = YamlValue;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a JSON/YAML value")
            }

            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(YamlValue::Null)
            }

            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Self::Value, E> {
                Ok(YamlValue::Bool(v))
            }

            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
                Ok(YamlValue::Number(v as f64))
            }

            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
                Ok(YamlValue::Number(v as f64))
            }

            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
                Ok(YamlValue::Number(v))
            }

            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(YamlValue::String(v.to_string()))
            }

            fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
                Ok(YamlValue::String(v))
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut out = Vec::new();
                while let Some(item) = seq.next_element()? {
                    out.push(item);
                }
                Ok(YamlValue::Seq(out))
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut out = IndexMap::new();
                while let Some((k, v)) = map.next_entry::<String, YamlValue>()? {
                    out.insert(k, v);
                }
                Ok(YamlValue::Map(out))
            }
        }

        deserializer.deserialize_any(YamlVisitor)
    }
}

impl YamlValue {
    pub fn as_map(&self) -> Option<&IndexMap<String, YamlValue>> {
        match self {
            Self::Map(m) => Some(m),
            Self::Null | Self::Bool(_) | Self::Number(_) | Self::String(_) | Self::Seq(_) => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(s) => Some(s),
            Self::Null | Self::Bool(_) | Self::Number(_) | Self::Seq(_) | Self::Map(_) => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(b) => Some(*b),
            Self::Null | Self::Number(_) | Self::String(_) | Self::Seq(_) | Self::Map(_) => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Self::Number(n) => Some(*n),
            Self::Null | Self::Bool(_) | Self::String(_) | Self::Seq(_) | Self::Map(_) => None,
        }
    }

    pub fn to_display_string(&self) -> String {
        match self {
            Self::Null => "null".to_string(),
            Self::Bool(b) => b.to_string(),
            Self::Number(n) => {
                if n.is_finite() && n.fract() == 0.0 && n.abs() < 1e16 {
                    format!("{}", *n as i64)
                } else {
                    n.to_string()
                }
            }
            Self::String(s) => s.clone(),
            Self::Seq(_) | Self::Map(_) => String::new(),
        }
    }

    pub fn is_truthy(&self) -> bool {
        match self {
            Self::Null => false,
            Self::Bool(b) => *b,
            Self::Number(n) => *n != 0.0 && !n.is_nan(),
            Self::String(s) => !s.is_empty(),
            Self::Seq(_) | Self::Map(_) => true,
        }
    }
}

#[derive(Debug, Clone)]
enum FlowErr {
    Incomplete(String),
    Error(String),
}

const MAX_DEPTH: usize = 64;

struct Reader {
    lines: Vec<String>,
    i: usize,
}

impl Reader {
    fn new(src: &str) -> Self {
        let normalized = if src.contains('\r') { normalize_crlf(src) } else { src.to_string() };
        let lines = normalized.split('\n').map(str::to_string).collect();
        Self { lines, i: 0 }
    }

    fn skip_blank(&mut self) {
        while self.i < self.lines.len() {
            let t = self.lines[self.i].trim();
            if !t.is_empty() && !t.starts_with('#') && t != "---" {
                break;
            }
            self.i += 1;
        }
    }

    fn indent(&self) -> Result<usize, String> {
        let line = self.lines[self.i].as_bytes();
        let mut k = 0;
        while k < line.len() && line[k] == b' ' {
            k += 1;
        }
        if k < line.len() && line[k] == b'\t' {
            return Err("YAML: tabs are not allowed for indentation".to_string());
        }
        Ok(k)
    }
}

fn normalize_crlf(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut chars = src.chars().peekable();
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

fn is_blank_byte(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r')
}

fn is_key_start_forbidden(c: char) -> bool {
    c.is_whitespace()
        || matches!(
            c,
            '#' | ':' | ',' | '[' | ']' | '{' | '}' | '&' | '*' | '!' | '|' | '>' | '\'' | '"' | '%' | '@' | '`'
        )
}

fn split_key(line: &str) -> Option<(&str, usize)> {
    let bytes = line.as_bytes();
    let first = *bytes.first()?;
    let end: usize;
    let mut colon: usize;
    if first == b'"' || first == b'\'' {
        let mut i = 1;
        loop {
            if i >= bytes.len() {
                return None;
            }
            let c = bytes[i];
            if first == b'"' && c == b'\\' {
                i += 2;
            } else if c == first {
                if first == b'"' || bytes.get(i + 1) != Some(&b'\'') {
                    break;
                }
                i += 2;
            } else {
                i += 1;
            }
        }
        end = i + 1;
        colon = end;
        while colon < bytes.len() && is_blank_byte(bytes[colon]) {
            colon += 1;
        }
        if bytes.get(colon) != Some(&b':') {
            return None;
        }
    } else {
        let first_char = line.chars().next()?;
        if is_key_start_forbidden(first_char) {
            return None;
        }
        if first == b'-' && (bytes.len() < 2 || is_blank_byte(bytes[1]) || bytes[1] == b':' || bytes[1] == b'#') {
            return None;
        }
        colon = 1;
        while colon < bytes.len() && bytes[colon] != b':' && bytes[colon] != b'#' {
            colon += 1;
        }
        if bytes.get(colon) != Some(&b':') {
            return None;
        }
        let mut e = colon;
        while e > 0 && is_blank_byte(bytes[e - 1]) {
            e -= 1;
        }
        end = e;
    }
    let mut length = colon + 1;
    if length < bytes.len() && !is_blank_byte(bytes[length]) {
        return None;
    }
    while length < bytes.len() && is_blank_byte(bytes[length]) {
        length += 1;
    }
    Some((&line[..end], length))
}

fn is_plain_int(s: &str) -> bool {
    let rest = s.strip_prefix(['+', '-']).unwrap_or(s);
    if rest == "0" {
        return true;
    }
    let bytes = rest.as_bytes();
    !bytes.is_empty() && (b'1'..=b'9').contains(&bytes[0]) && bytes[1..].iter().all(|b| b.is_ascii_digit())
}

fn is_plain_float(s: &str) -> bool {
    let rest = s.strip_prefix(['+', '-']).unwrap_or(s);
    let bytes = rest.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let mut i = 0;
    let mut has_digits = false;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        has_digits = true;
        i += 1;
    }
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        let mut frac_digits = false;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            frac_digits = true;
            i += 1;
        }
        if !has_digits && !frac_digits {
            return false;
        }
    } else if !has_digits {
        return false;
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        i += 1;
        if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
            i += 1;
        }
        let exp_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == exp_start {
            return false;
        }
    }
    i == bytes.len()
}

fn parse_radix(s: &str, prefix: &str, radix: u32) -> Option<f64> {
    let (neg, rest) = if let Some(r) = s.strip_prefix('-') {
        (true, r)
    } else if let Some(r) = s.strip_prefix('+') {
        (false, r)
    } else {
        (false, s)
    };
    let digits = rest.strip_prefix(prefix)?;
    if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
        return None;
    }
    let val = u64::from_str_radix(digits, radix).ok()? as f64;
    Some(if neg { -val } else { val })
}

fn scalar(raw: &str) -> YamlValue {
    let s = raw.trim();
    if s.is_empty() || matches!(s, "~" | "null" | "Null" | "NULL") {
        return YamlValue::Null;
    }
    if matches!(s, "true" | "True" | "TRUE") {
        return YamlValue::Bool(true);
    }
    if matches!(s, "false" | "False" | "FALSE") {
        return YamlValue::Bool(false);
    }
    let first = s.as_bytes()[0];
    if first != b'-' && first != b'+' && first != b'.' && !first.is_ascii_digit() {
        return YamlValue::String(s.to_string());
    }
    if (is_plain_int(s) || is_plain_float(s))
        && let Ok(n) = s.parse::<f64>()
    {
        return YamlValue::Number(n);
    }
    if let Some(v) = parse_radix(s, "0x", 16).or_else(|| parse_radix(s, "0o", 8)).or_else(|| parse_radix(s, "0b", 2)) {
        return YamlValue::Number(v);
    }
    let unsigned = s.strip_prefix(['+', '-']).unwrap_or(s);
    if matches!(unsigned, ".inf" | ".Inf" | ".INF") {
        return YamlValue::Number(if s.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY });
    }
    if matches!(s, ".nan" | ".NaN" | ".NAN") {
        return YamlValue::Number(f64::NAN);
    }
    YamlValue::String(s.to_string())
}

fn fold(text: &str) -> String {
    if !text.contains('\n') {
        return text.to_string();
    }
    let parts: Vec<&str> = text.split('\n').collect();
    let last = parts.len() - 1;
    let mut trimmed = Vec::with_capacity(parts.len());
    for (i, line) in parts.iter().enumerate() {
        let bytes = line.as_bytes();
        let mut from = 0;
        let mut to = bytes.len();
        if i > 0 {
            while from < to && (bytes[from] == b' ' || bytes[from] == b'\t') {
                from += 1;
            }
        }
        if i < last {
            while to > from && (bytes[to - 1] == b' ' || bytes[to - 1] == b'\t') {
                to -= 1;
            }
        }
        trimmed.push(&line[from..to]);
    }
    let joined = trimmed.join("\n");
    let mut out = String::with_capacity(joined.len());
    let mut chars = joined.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\n' {
            let mut count = 1usize;
            while chars.peek() == Some(&'\n') {
                chars.next();
                count += 1;
            }
            if count == 1 {
                out.push(' ');
            } else {
                for _ in 0..(count - 1) {
                    out.push('\n');
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn strip_escaped_newlines(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let bytes = body.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && bytes.get(i + 1) == Some(&b'\n') {
            i += 2;
            while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
                i += 1;
            }
        } else {
            let ch = body[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

fn unquote_double(body: &str) -> Result<String, String> {
    if !body.contains('\\') {
        return Ok(fold(body));
    }
    let s = fold(&strip_escaped_newlines(body));
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        let Some(e) = chars.next() else {
            return Err("YAML: unknown escape sequence".to_string());
        };
        match e {
            'x' | 'u' | 'U' => {
                let len = match e {
                    'x' => 2,
                    'u' => 4,
                    _ => 8,
                };
                let mut hex = String::with_capacity(len);
                for _ in 0..len {
                    if let Some(h) = chars.next() {
                        hex.push(h);
                    }
                }
                let code = u32::from_str_radix(&hex, 16).map_err(|_| "YAML: invalid unicode escape".to_string())?;
                let c = char::from_u32(code).ok_or_else(|| "YAML: invalid unicode scalar".to_string())?;
                out.push(c);
            }
            '0' => out.push('\0'),
            'a' => out.push('\x07'),
            'b' => out.push('\x08'),
            't' => out.push('\t'),
            'n' => out.push('\n'),
            'v' => out.push('\x0b'),
            'f' => out.push('\x0c'),
            'r' => out.push('\r'),
            'e' => out.push('\x1b'),
            ' ' => out.push(' '),
            '"' => out.push('"'),
            '/' => out.push('/'),
            '\\' => out.push('\\'),
            'N' => out.push('\u{0085}'),
            '_' => out.push('\u{00a0}'),
            'L' => out.push('\u{2028}'),
            'P' => out.push('\u{2029}'),
            _ => return Err("YAML: unknown escape sequence".to_string()),
        }
    }
    Ok(out)
}

fn skip_flow(s: &str, mut pos: usize) -> usize {
    let bytes = s.as_bytes();
    while pos < bytes.len() {
        let c = bytes[pos];
        if matches!(c, b' ' | b'\n' | b'\t' | b'\r') {
            pos += 1;
        } else if c == b'#' && (pos == 0 || s[..pos].chars().next_back().is_some_and(char::is_whitespace)) {
            match s[pos..].find('\n') {
                Some(rel) => pos += rel,
                None => pos = bytes.len(),
            }
        } else {
            break;
        }
    }
    pos
}

fn entry_start(ch: u8, separated: bool) -> Result<(), FlowErr> {
    if !separated {
        return Err(FlowErr::Error("YAML: missed comma between flow collection entries".to_string()));
    }
    if ch == b',' {
        return Err(FlowErr::Error("YAML: expected the node content, but found ','".to_string()));
    }
    Ok(())
}

fn flow(s: &str, mut pos: usize, stops: &str, depth: usize) -> Result<(YamlValue, usize), FlowErr> {
    if depth > MAX_DEPTH {
        return Err(FlowErr::Error("YAML: nesting is too deep".to_string()));
    }
    pos = skip_flow(s, pos);
    let bytes = s.as_bytes();
    let ch = bytes.get(pos).copied();
    if ch == Some(b'{') {
        let mut out = IndexMap::new();
        pos += 1;
        let mut separated = true;
        loop {
            pos = skip_flow(s, pos);
            if pos >= bytes.len() {
                return Err(FlowErr::Incomplete("YAML: unexpected end of the stream within a flow collection".to_string()));
            }
            if bytes[pos] == b'}' {
                return Ok((YamlValue::Map(out), pos + 1));
            }
            entry_start(bytes[pos], separated)?;
            let (key, next_pos) = flow(s, pos, ":,}", depth + 1)?;
            pos = skip_flow(s, next_pos);
            let value = if bytes.get(pos) == Some(&b':') {
                let (v, after) = flow(s, pos + 1, ",}", depth + 1)?;
                pos = after;
                v
            } else {
                YamlValue::Null
            };
            out.insert(key.to_display_string(), value);
            pos = skip_flow(s, pos);
            separated = bytes.get(pos) == Some(&b',');
            if separated {
                pos += 1;
            }
        }
    }
    if ch == Some(b'[') {
        let mut out = Vec::new();
        pos += 1;
        let mut separated = true;
        loop {
            pos = skip_flow(s, pos);
            if pos >= bytes.len() {
                return Err(FlowErr::Incomplete("YAML: unexpected end of the stream within a flow collection".to_string()));
            }
            if bytes[pos] == b']' {
                return Ok((YamlValue::Seq(out), pos + 1));
            }
            entry_start(bytes[pos], separated)?;
            let (value, next_pos) = flow(s, pos, ",]", depth + 1)?;
            out.push(value);
            pos = skip_flow(s, next_pos);
            separated = bytes.get(pos) == Some(&b',');
            if separated {
                pos += 1;
            }
        }
    }
    if ch == Some(b'"') {
        let mut end = pos + 1;
        while end < bytes.len() && bytes[end] != b'"' {
            if bytes[end] == b'\\' {
                end += 2;
            } else {
                end += 1;
            }
        }
        if end >= bytes.len() {
            return Err(FlowErr::Incomplete(
                "YAML: unexpected end of the stream within a double quoted scalar".to_string(),
            ));
        }
        let text = unquote_double(&s[pos + 1..end]).map_err(FlowErr::Error)?;
        return Ok((YamlValue::String(text), end + 1));
    }
    if ch == Some(b'\'') {
        let mut end = pos + 1;
        while end < bytes.len() {
            if bytes[end] == b'\'' {
                if bytes.get(end + 1) != Some(&b'\'') {
                    break;
                }
                end += 1;
            }
            end += 1;
        }
        if end >= bytes.len() {
            return Err(FlowErr::Incomplete(
                "YAML: unexpected end of the stream within a single quoted scalar".to_string(),
            ));
        }
        let text = fold(&s[pos + 1..end]).replace("''", "'");
        return Ok((YamlValue::String(text), end + 1));
    }
    let mut end = pos;
    while end < bytes.len() {
        let c = s[end..].chars().next().unwrap();
        if stops.contains(c)
            && (c != ':'
                || end + 1 >= bytes.len()
                || s[end + 1..]
                    .chars()
                    .next()
                    .is_some_and(|n| n.is_whitespace() || matches!(n, ',' | '[' | ']' | '{' | '}')))
        {
            break;
        }
        if c == '#' && end > pos && s[..end].chars().next_back().is_some_and(char::is_whitespace) {
            let nl = s[end..].find('\n').map_or(bytes.len(), |r| end + r);
            return Ok((scalar(&fold(s[pos..end].trim())), nl));
        }
        end += c.len_utf8();
    }
    Ok((scalar(&fold(s[pos..end].trim())), end))
}

fn strip_comment(s: &str) -> &str {
    let bytes = s.as_bytes();
    let mut quote: u8 = 0;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if quote != 0 {
            if c == b'\\' && quote == b'"' {
                i += 2;
                continue;
            } else if c == quote {
                quote = 0;
            }
        } else if c == b'"' || c == b'\'' {
            quote = c;
        } else if c == b'#' && (i == 0 || bytes[i - 1] == b' ' || bytes[i - 1] == b'\t') {
            return &s[..i];
        }
        i += 1;
    }
    s
}

fn is_block_scalar_header(rest: &str) -> bool {
    let bytes = rest.as_bytes();
    if bytes.is_empty() || (bytes[0] != b'|' && bytes[0] != b'>') {
        return false;
    }
    let mut i = 1;
    while i < bytes.len() && (bytes[i] == b'-' || bytes[i] == b'+' || bytes[i].is_ascii_digit()) {
        i += 1;
    }
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    i == bytes.len() || bytes[i] == b'#'
}

fn block_scalar(r: &mut Reader, header: &str, parent_indent: isize) -> String {
    let folded = header.starts_with('>');
    let chomp = if header.contains('-') {
        '-'
    } else if header.contains('+') {
        '+'
    } else {
        ' '
    };
    let explicit = header.bytes().find(|b| (b'1'..=b'9').contains(b)).map(|b| (b - b'0') as isize);
    let mut indent: isize = explicit.map_or(-1, |e| parent_indent + e);
    let mut out: Vec<String> = Vec::new();
    while r.i < r.lines.len() {
        let line = &r.lines[r.i];
        if line.trim().is_empty() {
            out.push(String::new());
            r.i += 1;
            continue;
        }
        let k = (line.len() - line.trim_start().len()) as isize;
        if indent == -1 {
            if k <= parent_indent {
                break;
            }
            indent = k;
        }
        if k < indent {
            break;
        }
        out.push(line[indent as usize..].to_string());
        r.i += 1;
    }
    let mut trailing = 0usize;
    while out.last().is_some_and(String::is_empty) {
        out.pop();
        trailing += 1;
    }
    let text = if folded {
        let mut t = String::new();
        for (i, cur) in out.iter().enumerate() {
            if i > 0 {
                let prev = &out[i - 1];
                if cur.is_empty() {
                    t.push('\n');
                } else if !prev.is_empty() {
                    let prev_ind = prev.starts_with([' ', '\t']);
                    let cur_ind = cur.starts_with([' ', '\t']);
                    t.push(if prev_ind || cur_ind { '\n' } else { ' ' });
                }
            }
            t.push_str(cur);
        }
        t
    } else {
        out.join("\n")
    };
    if out.is_empty() {
        return if chomp == '+' { "\n".repeat(trailing) } else { String::new() };
    }
    if chomp == '-' {
        return text;
    }
    if chomp == '+' {
        return format!("{text}{}", "\n".repeat(trailing + 1));
    }
    format!("{text}\n")
}

fn inline_value(r: &mut Reader, rest: &str, indent: isize) -> Result<YamlValue, String> {
    let first = rest.as_bytes().first().copied();
    if matches!(first, Some(b'|' | b'>')) && is_block_scalar_header(rest) {
        return Ok(YamlValue::String(block_scalar(r, rest, indent)));
    }
    if matches!(first, Some(b'{' | b'[' | b'"' | b'\'')) {
        let start = r.i;
        let mut text = rest.to_string();
        let mut taken = 0usize;
        let mut batch = 1usize;
        loop {
            match flow(&text, 0, "", 0) {
                Ok((value, end)) => {
                    let used = text[..end].bytes().filter(|&b| b == b'\n').count();
                    let line_end = text[end..].find('\n').map_or(text.len(), |rel| end + rel);
                    if !strip_comment(&text[end..line_end]).trim().is_empty() {
                        return Err("YAML: unexpected content after a value".to_string());
                    }
                    r.i = start + used;
                    return Ok(value);
                }
                Err(FlowErr::Error(msg)) => return Err(msg),
                Err(FlowErr::Incomplete(msg)) => {
                    if start + taken >= r.lines.len() {
                        return Err(msg);
                    }
                    let slice_end = (start + taken + batch).min(r.lines.len());
                    for line in &r.lines[start + taken..slice_end] {
                        text.push('\n');
                        text.push_str(line);
                    }
                    taken += slice_end - (start + taken);
                    batch *= 2;
                }
            }
        }
    }
    let mut text = strip_comment(rest).trim().to_string();
    while r.i < r.lines.len() {
        let line = &r.lines[r.i];
        if line.trim().is_empty() {
            let mut j = r.i;
            while j < r.lines.len() && r.lines[j].trim().is_empty() {
                j += 1;
            }
            if j >= r.lines.len() || (r.lines[j].len() - r.lines[j].trim_start().len()) as isize <= indent {
                break;
            }
            for _ in 0..(j - r.i) {
                text.push('\n');
            }
            r.i = j;
            continue;
        }
        if (line.len() - line.trim_start().len()) as isize <= indent {
            break;
        }
        let more = strip_comment(line).trim();
        if !text.ends_with('\n') {
            text.push(' ');
        }
        text.push_str(more);
        r.i += 1;
    }
    Ok(scalar(&text))
}

fn block(r: &mut Reader, min_indent: usize, depth: usize) -> Result<YamlValue, String> {
    if depth > MAX_DEPTH {
        return Err("YAML: nesting is too deep".to_string());
    }
    r.skip_blank();
    if r.i >= r.lines.len() {
        return Ok(YamlValue::Null);
    }
    let indent = r.indent()?;
    if indent < min_indent {
        return Ok(YamlValue::Null);
    }
    let line = r.lines[r.i][indent..].to_string();

    if line == "-" || line.starts_with("- ") {
        let mut out = Vec::new();
        while r.i < r.lines.len() {
            r.skip_blank();
            if r.i >= r.lines.len() || r.indent()? != indent {
                break;
            }
            let cur = r.lines[r.i][indent..].to_string();
            if cur != "-" && !cur.starts_with("- ") {
                break;
            }
            let rest = &cur[1..];
            let pad = rest.len() - rest.trim_start().len() + 1;
            let body = strip_comment(rest).trim();
            if body.is_empty() {
                r.i += 1;
                out.push(block(r, indent + 1, depth + 1)?);
            } else if split_key(body).is_some() {
                r.lines[r.i] = format!("{}{}", " ".repeat(indent + pad), rest.trim_start());
                out.push(block(r, indent + pad, depth + 1)?);
            } else {
                r.i += 1;
                out.push(inline_value(r, rest.trim(), indent as isize)?);
            }
        }
        return Ok(YamlValue::Seq(out));
    }

    if split_key(&line).is_none() {
        r.i += 1;
        return inline_value(r, line.trim(), indent as isize - 1);
    }

    let mut out = IndexMap::new();
    while r.i < r.lines.len() {
        r.skip_blank();
        if r.i >= r.lines.len() {
            break;
        }
        let k = r.indent()?;
        if k < indent {
            break;
        }
        if k > indent {
            return Err("YAML: bad indentation of a mapping entry".to_string());
        }
        let cur = r.lines[r.i][indent..].to_string();
        let Some((raw_key, val_offset)) = split_key(&cur) else {
            return Err("YAML: can not read a block mapping entry".to_string());
        };
        let (key_val, _) = flow(raw_key, 0, "", 0).map_err(|e| match e {
            FlowErr::Incomplete(m) | FlowErr::Error(m) => m,
        })?;
        let key = key_val.to_display_string();
        let rest = &cur[val_offset..];
        r.i += 1;
        if strip_comment(rest).trim().is_empty() {
            r.skip_blank();
            if r.i < r.lines.len() {
                let next = r.indent()?;
                let next_line = &r.lines[r.i][next..];
                let seq = next_line == "-" || next_line.starts_with("- ");
                let val = if next > indent || (seq && next == indent) {
                    block(r, if seq { indent } else { indent + 1 }, depth + 1)?
                } else {
                    YamlValue::Null
                };
                out.insert(key, val);
            } else {
                out.insert(key, YamlValue::Null);
            }
        } else {
            let val = inline_value(r, rest.trim(), indent as isize)?;
            out.insert(key, val);
        }
    }
    Ok(YamlValue::Map(out))
}

pub fn parse_yaml(src: &str) -> Result<YamlValue, String> {
    let trimmed = src.trim();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        match flow(trimmed, 0, "", 0) {
            Ok((value, end)) if skip_flow(trimmed, end) == trimmed.len() => return Ok(value),
            Ok(_) => {}
            Err(FlowErr::Incomplete(m) | FlowErr::Error(m)) => return Err(m),
        }
    }
    let mut r = Reader::new(src);
    let value = block(&mut r, 0, 0)?;
    r.skip_blank();
    if r.i < r.lines.len() && r.lines[r.i].trim() != "..." {
        return Err("YAML: end of the stream or a document separator is expected".to_string());
    }
    Ok(value)
}

pub fn merge_yaml_maps(target: &mut IndexMap<String, YamlValue>, source: &IndexMap<String, YamlValue>) {
    for (key, value) in source {
        if matches!(key.as_str(), "__proto__" | "constructor" | "prototype") {
            continue;
        }
        match (target.get_mut(key), value) {
            (Some(YamlValue::Map(cur)), YamlValue::Map(src)) => {
                merge_yaml_maps(cur, src);
            }
            (_, YamlValue::Map(src)) => {
                let mut cloned = IndexMap::new();
                merge_yaml_maps(&mut cloned, src);
                target.insert(key.clone(), YamlValue::Map(cloned));
            }
            _ => {
                target.insert(key.clone(), value.clone());
            }
        }
    }
}
