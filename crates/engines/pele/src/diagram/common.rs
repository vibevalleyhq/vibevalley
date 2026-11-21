use crate::detect::DiagramType;
use crate::error::{PeleError, SourceMap, syntax_error};
use crate::measure::{TextMeasurer, TextStyle};
use crate::svg::builder::{esc_text, num};
use crate::text::label::{Label, layout_label};
use crate::{IconResolver, RenderOptions, Rendered};

const BREAKPOINT: f64 = 640.0;

/// Draws a chart whose plot can be any width so the whole diagram fits `max_width`.
pub fn fit_width<F>(options: &RenderOptions<'_>, natural: f64, least: f64, mut draw: F) -> Rendered
where
    F: FnMut(f64, bool) -> Rendered,
{
    let mut result = draw(natural, false);
    let Some(available) = options.max_width else {
        return result;
    };
    if available.is_nan() || available <= 0.0 || result.width <= available {
        return result;
    }
    let floor = least.min(natural);
    let mut plot = natural;
    result = draw(plot, true);
    for _round in 0..3 {
        if result.width <= available || plot <= floor {
            break;
        }
        plot = floor.max(plot - (result.width - available));
        result = draw(plot, true);
    }
    result
}

/// The width a title may take before wrapping.
pub fn title_room(options: &RenderOptions<'_>) -> f64 {
    match options.max_width {
        Some(available) if available > 0.0 => 80.0f64.max(available - 2.0 * options.padding.unwrap_or(8.0)),
        _ => 4000.0,
    }
}

pub fn cap_width(options: &RenderOptions<'_>, natural: f64, least: f64, around: f64) -> f64 {
    match options.max_width {
        Some(available) if available > 0.0 => least.min(natural).max(natural.min(available - around)),
        _ => natural,
    }
}

pub fn turn_to_fit<F>(options: &RenderOptions<'_>, mut draw: F) -> Rendered
where
    F: FnMut(bool) -> Rendered,
{
    let across = draw(false);
    let Some(available) = options.max_width else {
        return across;
    };
    if options.auto_direction == Some(false) || available.is_nan() || available <= 0.0 || across.width <= available {
        return across;
    }
    let breakpoint = match options.direction_breakpoint {
        Some(bp) if bp > 0.0 => bp,
        _ => BREAKPOINT,
    };
    if available >= breakpoint {
        return across;
    }
    let down = draw(true);
    if down.width < across.width { down } else { across }
}

pub fn runs_across(dir: Option<&str>) -> bool {
    matches!(dir, Some("LR" | "RL"))
}

pub fn tighten<F>(options: &RenderOptions<'_>, mut draw: F) -> Rendered
where
    F: FnMut(bool) -> Rendered,
{
    let loose = draw(false);
    let Some(available) = options.max_width else {
        return loose;
    };
    if available.is_nan() || available <= 0.0 || loose.width <= available {
        return loose;
    }
    let tight = draw(true);
    if tight.width < loose.width { tight } else { loose }
}

#[derive(Debug, Clone)]
pub struct Fitted {
    pub text: String,
    pub size: f64,
    pub width: f64,
}

/// Fits one line of text into `max` width by shrinking down to `min`, then truncating with `…`.
pub fn fit_text(text: &str, max: f64, size: f64, min: f64, measurer: &dyn TextMeasurer, style: TextStyle) -> Option<Fitted> {
    if text.is_empty() || max <= 0.0 {
        return None;
    }
    let mut width = measurer.width(text, size, style);
    if width <= max {
        return Some(Fitted {
            text: text.to_string(),
            size,
            width,
        });
    }
    let mut fitted = min.max(((size * max) / width).floor());
    while fitted >= min {
        width = measurer.width(text, fitted, style);
        if width <= max {
            return Some(Fitted {
                text: text.to_string(),
                size: fitted,
                width,
            });
        }
        fitted -= 1.0;
    }

    let chars: Vec<char> = text.chars().collect();
    let mut low = 0usize;
    let mut high = chars.len().saturating_sub(1);
    while low < high {
        let mid = (low + high + 1) >> 1;
        let prefix: String = chars[..mid].iter().collect();
        let cand = format!("{}…", prefix.trim_end());
        if measurer.width(&cand, min, style) <= max {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    if low == 0 {
        return None;
    }
    let prefix: String = chars[..low].iter().collect();
    let cut = format!("{}…", prefix.trim_end());
    width = measurer.width(&cut, min, style);
    if width <= max { Some(Fitted { text: cut, size: min, width }) } else { None }
}

fn is_br_tag_at(s: &str, at: usize) -> Option<usize> {
    let rest = &s[at..];
    if rest.len() < 4 || !rest.as_bytes()[0..3].eq_ignore_ascii_case(b"<br") {
        return None;
    }
    let bytes = rest.as_bytes();
    let mut i = 3;
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if i < bytes.len() && bytes[i] == b'/' {
        i += 1;
    }
    if i < bytes.len() && bytes[i] == b'>' { Some(at + i + 1) } else { None }
}

/// Lays out text where only `<br>` is markup; other tags and `:fa-` icon names render literally.
pub fn plain_label(raw: Option<&str>, measurer: &dyn TextMeasurer, size: f64, max: f64, base: TextStyle) -> Label {
    let Some(raw) = raw else {
        return layout_label(None, false, measurer, size, max, base, None, None);
    };
    let mut owned;
    let text = if raw.contains('<') || raw.contains(":fa-") {
        owned = String::with_capacity(raw.len() + 16);
        let mut i = 0;
        while i < raw.len() {
            if raw.as_bytes()[i] == b'<' {
                if let Some(end) = is_br_tag_at(raw, i) {
                    owned.push_str(&raw[i..end]);
                    i = end;
                    continue;
                }
                owned.push_str("&lt;");
                i += 1;
            } else if raw[i..].starts_with(":fa-") {
                owned.push_str("&colon;fa-");
                i += 4;
            } else {
                let ch = raw[i..].chars().next().unwrap();
                owned.push(ch);
                i += ch.len_utf8();
            }
        }
        owned.as_str()
    } else {
        raw
    };
    layout_label(Some(text), false, measurer, size, max, base, None, None)
}

/// Like `plain_label`, also cutting any single word wider than `max`.
pub fn fit_label(raw: Option<&str>, measurer: &dyn TextMeasurer, size: f64, max: f64, base: TextStyle) -> Label {
    let label = plain_label(raw, measurer, size, max, base);
    let Some(raw) = raw else {
        return label;
    };
    if label.width <= max {
        return label;
    }
    let mut out = String::with_capacity(raw.len() + 16);
    let mut width = 0.0f64;
    let mut i = 0;
    while i < raw.len() {
        let unit_end = if let Some(end) = is_br_tag_at(raw, i) {
            end
        } else if let Some(end) = encoded_placeholder_end(raw, i) {
            end
        } else if let Some(end) = html_entity_end(raw, i) {
            end
        } else {
            let ch = raw[i..].chars().next().unwrap();
            i + ch.len_utf8()
        };
        let unit = &raw[i..unit_end];
        if unit.trim().is_empty() || (unit.len() > 2 && unit.starts_with('<')) {
            width = 0.0;
        } else {
            let sample = if unit.len() > 2 && unit.chars().count() > 1 { "x" } else { unit };
            let w = measurer.width(sample, size, base);
            if width > 0.0 && width + w > max {
                out.push('\n');
                width = 0.0;
            }
            width += w;
        }
        out.push_str(unit);
        i = unit_end;
    }
    plain_label(Some(&out), measurer, size, max, base)
}

fn encoded_placeholder_end(s: &str, at: usize) -> Option<usize> {
    let rest = s[at..].strip_prefix("ﬂ°")?;
    let rest = rest.strip_prefix('°').unwrap_or(rest);
    let word_len = rest.bytes().take_while(|b| b.is_ascii_alphanumeric() || *b == b'_').count();
    if word_len == 0 {
        return None;
    }
    let after = &rest[word_len..];
    if after.starts_with("¶ß") {
        let consumed = s[at..].len() - after.len() + "¶ß".len();
        Some(at + consumed)
    } else {
        None
    }
}

fn html_entity_end(s: &str, at: usize) -> Option<usize> {
    let rest = s[at..].strip_prefix('&')?;
    let rest = rest.strip_prefix('#').unwrap_or(rest);
    let word_len = rest.bytes().take_while(|b| b.is_ascii_alphanumeric() || *b == b'_').count();
    if word_len == 0 {
        return None;
    }
    if rest.as_bytes().get(word_len) == Some(&b';') {
        let consumed = s[at..].len() - rest.len() + word_len + 1;
        Some(at + consumed)
    } else {
        None
    }
}

/// Whether `word` (lowercase ASCII) appears at byte index `at`, matching ASCII letters case-insensitively.
pub fn word_at(src: &str, at: usize, word: &str) -> bool {
    let bytes = src.as_bytes();
    let wbytes = word.as_bytes();
    if at + wbytes.len() > bytes.len() {
        return false;
    }
    for k in 0..wbytes.len() {
        let c = bytes[at + k];
        let w = wbytes[k];
        if c != w && !(w.is_ascii_lowercase() && c == w - 32) {
            return false;
        }
    }
    true
}

fn count_tildes(text: &str) -> usize {
    text.bytes().filter(|&b| b == b'~').count()
}

fn pair_tildes(text: &str) -> String {
    let count = count_tildes(text);
    if count <= 1 {
        return text.to_string();
    }
    let lead = !count.is_multiple_of(2) && text.starts_with('~');
    let mut chars: Vec<char> = text.chars().collect();
    let mut at: Vec<usize> = Vec::new();
    for (i, &c) in chars.iter().enumerate().skip(usize::from(lead)) {
        if c == '~' {
            at.push(i);
        }
    }
    let mut lo = 0;
    let mut hi = at.len().saturating_sub(1);
    while lo < hi {
        chars[at[lo]] = '<';
        chars[at[hi]] = '>';
        lo += 1;
        hi -= 1;
    }
    chars.into_iter().collect()
}

/// Turns `List~int~` into `List<int>`, preserving Mermaid's comma pairing rules.
pub fn parse_generic_types(input: &str) -> String {
    if !input.contains('~') {
        return input.to_string();
    }
    let mut sets: Vec<&str> = Vec::new();
    let mut start = 0;
    for (idx, _) in input.match_indices(',') {
        sets.push(&input[start..idx]);
        sets.push(",");
        start = idx + 1;
    }
    sets.push(&input[start..]);

    let mut output: Vec<String> = Vec::with_capacity(sets.len());
    let mut i = 0;
    while i < sets.len() {
        let set = sets[i];
        if set == "," && i > 0 && i + 1 < sets.len() && count_tildes(sets[i - 1]) == 1 && count_tildes(sets[i + 1]) == 1 {
            let combined = format!("{},{}", sets[i - 1], sets[i + 1]);
            output.pop();
            output.push(pair_tildes(&combined));
            i += 2;
            continue;
        }
        output.push(pair_tildes(set));
        i += 1;
    }
    output.concat()
}

pub fn icon_svg(name: &str, x: f64, y: f64, side: f64, icons: Option<&IconResolver<'_>>) -> String {
    let inner = icons.and_then(|f| f(name)).unwrap_or_default();
    format!(
        r#"<svg class="pele-icon" data-icon="{}" x="{}" y="{}" width="{}" height="{}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{inner}</svg>"#,
        esc_text(name),
        num(x),
        num(y),
        num(side),
        num(side),
    )
}

// Shared Langium / Chevrotain token value extractors & linear-time scanners.

fn collapse_single(text: &str) -> String {
    let trimmed = text.trim();
    let mut out = String::with_capacity(trimmed.len());
    let mut in_space = false;
    for ch in trimmed.chars() {
        if ch == ' ' || ch == '\t' {
            if !in_space {
                out.push(' ');
                in_space = true;
            }
        } else {
            in_space = false;
            out.push(ch);
        }
    }
    out
}

pub fn title_value(text: &str) -> String {
    if let Some(idx) = text.find("title") {
        collapse_single(&text[idx + 5..])
    } else {
        String::new()
    }
}

pub fn acc_title_value(text: &str) -> String {
    if let Some(idx) = text.find("accTitle") {
        let rest = &text[idx + 8..];
        if let Some(colon) = rest.find(':') {
            return collapse_single(&rest[colon + 1..]);
        }
    }
    String::new()
}

pub fn acc_descr_value(text: &str) -> String {
    let Some(idx) = text.find("accDescr") else {
        return String::new();
    };
    let rest = &text[idx + 8..];
    let bytes = rest.as_bytes();
    let mut p = 0;
    while p < bytes.len() && matches!(bytes[p], b' ' | b'\t') {
        p += 1;
    }
    if bytes.get(p) == Some(&b':') {
        return collapse_single(&rest[p + 1..]);
    }
    if let Some(open) = rest.find('{')
        && let Some(close) = rest[open + 1..].find('}')
    {
        let inner = &rest[open + 1..open + 1 + close];
        let mut lines: Vec<String> = Vec::new();
        for line in inner.split(['\n', '\r']) {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                lines.push(collapse_single(trimmed));
            }
        }
        return lines.join("\n");
    }
    String::new()
}

pub fn string_value(text: &str) -> String {
    if text.len() < 2 {
        return String::new();
    }
    let inner = &text[1..text.len() - 1];
    if !inner.contains('\\') {
        return inner.to_string();
    }
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(next) = chars.next() {
                match next {
                    'b' => out.push('\u{0008}'),
                    'f' => out.push('\u{000C}'),
                    'n' => out.push('\n'),
                    'r' => out.push('\r'),
                    't' => out.push('\t'),
                    'v' => out.push('\u{000B}'),
                    '0' => out.push('\0'),
                    other => out.push(other),
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

pub fn scan_keyword(src: &str, at: usize, word: &str) -> Option<usize> {
    if !src[at..].starts_with(word) {
        return None;
    }
    let end = at + word.len();
    let rest = &src[end..];
    if rest.is_empty() || rest.starts_with("%%") || rest.chars().next().is_some_and(char::is_whitespace) {
        Some(end)
    } else {
        None
    }
}

pub fn scan_whitespace(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut p = at;
    while p < bytes.len() && matches!(bytes[p], b' ' | b'\t') {
        p += 1;
    }
    (p > at).then_some(p)
}

pub fn scan_newline(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    if bytes.get(at) == Some(&b'\r') && bytes.get(at + 1) == Some(&b'\n') {
        Some(at + 2)
    } else if bytes.get(at) == Some(&b'\n') {
        Some(at + 1)
    } else {
        None
    }
}

pub fn scan_single_line_comment(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut p = at;
    while p < bytes.len() && matches!(bytes[p], b' ' | b'\t') {
        p += 1;
    }
    if bytes.get(p) == Some(&b'%') && bytes.get(p + 1) == Some(&b'%') {
        p += 2;
        while p < bytes.len() && !matches!(bytes[p], b'\n' | b'\r') {
            p += 1;
        }
        Some(p)
    } else {
        None
    }
}

pub fn scan_string(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let quote = *bytes.get(at)?;
    if quote != b'"' && quote != b'\'' {
        return None;
    }
    let mut p = at + 1;
    while p < bytes.len() {
        let b = bytes[p];
        if b == quote {
            return Some(p + 1);
        }
        if b == b'\\' {
            // In JS regex `\\.`, `.` does not match `\n` or `\r`.
            let next = *bytes.get(p + 1)?;
            if next == b'\n' || next == b'\r' {
                return None;
            }
            let ch = src[p + 1..].chars().next()?;
            p += 1 + ch.len_utf8();
        } else {
            p += 1;
        }
    }
    None
}

pub fn scan_acc_title(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut p = at;
    while p < bytes.len() && matches!(bytes[p], b' ' | b'\t') {
        p += 1;
    }
    if !src[p..].starts_with("accTitle") {
        return None;
    }
    p += 8;
    while p < bytes.len() && matches!(bytes[p], b' ' | b'\t') {
        p += 1;
    }
    if bytes.get(p) != Some(&b':') {
        return None;
    }
    p += 1;
    while p < bytes.len() && !matches!(bytes[p], b'\n' | b'\r') {
        if bytes[p] == b'%' && bytes.get(p + 1) == Some(&b'%') {
            break;
        }
        p += 1;
    }
    Some(p)
}

pub fn scan_acc_descr(src: &str, at: usize, unclosed_brace: &mut bool) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut p = at;
    while p < bytes.len() && matches!(bytes[p], b' ' | b'\t') {
        p += 1;
    }
    if !src[p..].starts_with("accDescr") {
        return None;
    }
    p += 8;
    let mut q = p;
    while q < bytes.len() && matches!(bytes[q], b' ' | b'\t') {
        q += 1;
    }
    if bytes.get(q) == Some(&b':') {
        q += 1;
        while q < bytes.len() && !matches!(bytes[q], b'\n' | b'\r') {
            if bytes[q] == b'%' && bytes.get(q + 1) == Some(&b'%') {
                break;
            }
            q += 1;
        }
        return Some(q);
    }
    let mut ws = p;
    while ws < src.len() {
        let ch = src[ws..].chars().next().unwrap();
        if ch.is_whitespace() {
            ws += ch.len_utf8();
        } else {
            break;
        }
    }
    if bytes.get(ws) == Some(&b'{') {
        if *unclosed_brace {
            return None;
        }
        if let Some(rel) = src[ws + 1..].find('}') {
            return Some(ws + 1 + rel + 1);
        }
        *unclosed_brace = true;
    }
    None
}

pub fn scan_title(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut p = at;
    while p < bytes.len() && matches!(bytes[p], b' ' | b'\t') {
        p += 1;
    }
    if !src[p..].starts_with("title") {
        return None;
    }
    p += 5;
    if matches!(bytes.get(p), Some(b' ' | b'\t')) {
        p += 1;
        while p < bytes.len() && !matches!(bytes[p], b'\n' | b'\r') {
            if bytes[p] == b'%' && bytes.get(p + 1) == Some(&b'%') {
                break;
            }
            p += 1;
        }
    }
    Some(p)
}

pub fn scan_yaml_block(src: &str, at: usize, dead: &mut bool) -> Option<usize> {
    if *dead || !src[at..].starts_with("---") {
        return None;
    }
    let bytes = src.as_bytes();
    let mut p = at + 3;
    while p < bytes.len() && matches!(bytes[p], b' ' | b'\t') {
        p += 1;
    }
    let nl_end = scan_newline(src, p)?;
    let mut cur = nl_end;
    while cur < bytes.len() {
        if src[cur..].starts_with("---") {
            let after = cur + 3;
            if let Some(e) = scan_newline(src, after) {
                return Some(e);
            }
            if after == bytes.len() || src[after..].chars().next().is_some_and(char::is_whitespace) {
                return Some(after);
            }
        }
        match src[cur..].find('\n') {
            Some(rel) => cur += rel + 1,
            None => break,
        }
    }
    *dead = true;
    None
}

pub fn scan_directive(src: &str, at: usize, dead: &mut bool) -> Option<usize> {
    if *dead {
        return None;
    }
    let bytes = src.as_bytes();
    let mut p = at;
    while p < bytes.len() && matches!(bytes[p], b' ' | b'\t') {
        p += 1;
    }
    if !src[p..].starts_with("%%{") {
        return None;
    }
    if let Some(rel) = src[p + 3..].find("}%%") {
        let after = p + 3 + rel + 3;
        if let Some(e) = scan_newline(src, after) {
            return Some(e);
        }
        if after == bytes.len() || src[after..].chars().next().is_some_and(char::is_whitespace) {
            return Some(after);
        }
    }
    *dead = true;
    None
}

/// Token stream emitted by Chevrotain-style lexers.
pub struct TokenStream<'a, K: Copy + Eq> {
    pub kinds: Vec<Option<K>>,
    pub starts: Vec<usize>,
    pub ends: Vec<usize>,
    pub src: &'a str,
}

pub struct TokenReader<'a, K: Copy + Eq> {
    pub i: usize,
    pub tokens: TokenStream<'a, K>,
    pub diagram: DiagramType,
    pub origin: Option<&'a SourceMap<'a>>,
    pub name_of: fn(K) -> &'static str,
}

impl<'a, K: Copy + Eq> TokenReader<'a, K> {
    pub fn new(tokens: TokenStream<'a, K>, diagram: DiagramType, origin: Option<&'a SourceMap<'a>>, name_of: fn(K) -> &'static str) -> Self {
        Self {
            i: 0,
            tokens,
            diagram,
            origin,
            name_of,
        }
    }

    pub fn kind(&self) -> Option<K> {
        self.tokens.kinds[self.i]
    }

    pub fn text_at(&self, index: usize) -> &'a str {
        &self.tokens.src[self.tokens.starts[index]..self.tokens.ends[index]]
    }

    pub fn text(&self) -> &'a str {
        self.text_at(self.i)
    }

    pub fn take(&mut self) -> &'a str {
        let s = self.text_at(self.i);
        self.i += 1;
        s
    }

    pub fn accept(&mut self, kind: K) -> bool {
        if self.tokens.kinds[self.i] != Some(kind) {
            return false;
        }
        self.i += 1;
        true
    }

    pub fn expect(&mut self, kind: K) -> Result<&'a str, PeleError> {
        if self.tokens.kinds[self.i] != Some(kind) {
            return Err(self.fail(&format!("token of type '{}'", (self.name_of)(kind))));
        }
        Ok(self.take())
    }

    pub fn fail(&self, expected: &str) -> PeleError {
        let found = match self.kind() {
            None => "end of input".to_string(),
            Some(_) => format!("`{}`", self.text()),
        };
        let mut at = self.tokens.starts[self.i];
        if self.kind().is_none() {
            let mut k = self.i;
            while k > 0 && self.text_at(k - 1).trim().is_empty() {
                k -= 1;
            }
            if k > 0 {
                at = self.tokens.ends[k - 1];
            }
        }
        syntax_error(
            self.diagram,
            self.tokens.src,
            at,
            &format!("Expecting {expected} but found {found}."),
            false,
            self.origin,
        )
    }
}
