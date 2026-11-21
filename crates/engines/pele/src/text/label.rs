use crate::measure::{TextMeasurer, TextStyle};
use crate::text::entities::decode_entities;
use crate::util::chars::is_word;
use crate::{IconResolver, MathResolver, MathSvg};

pub const LINE_HEIGHT: f64 = 1.5;
const WRAPPED_LINE_HEIGHT: f64 = 1.3;

#[derive(Debug, Clone, PartialEq)]
pub struct Span {
    pub text: String,
    pub style: TextStyle,
    pub icon: Option<String>,
    pub math: Option<MathSvg>,
    pub width: f64,
}

impl Span {
    pub fn plain(text: String, style: TextStyle, width: f64) -> Self {
        Self {
            text,
            style,
            icon: None,
            math: None,
            width,
        }
    }

    pub fn is_plain(&self) -> bool {
        self.icon.is_none() && self.math.is_none()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Label {
    pub lines: Vec<Vec<Span>>,
    pub widths: Vec<f64>,
    pub width: f64,
    pub height: f64,
    pub size: f64,
    pub line_height: f64,
    pub heights: Option<Vec<f64>>,
}

impl Label {
    pub fn empty() -> Self {
        Self {
            lines: Vec::new(),
            widths: Vec::new(),
            width: 0.0,
            height: 0.0,
            size: 0.0,
            line_height: 0.0,
            heights: None,
        }
    }

    pub fn line_middle(&self, i: usize) -> f64 {
        match &self.heights {
            None => (i as f64 + 0.5) * self.line_height,
            Some(heights) => {
                let top: f64 = heights[..i].iter().sum();
                top + heights[i] / 2.0
            }
        }
    }

    pub fn single_line(&self, i: usize) -> Self {
        let width = self.widths[i];
        let height = self.heights.as_ref().map_or(self.line_height, |h| h[i]);
        Self {
            lines: vec![self.lines[i].clone()],
            widths: vec![width],
            width,
            height,
            size: self.size,
            line_height: self.line_height,
            heights: if (height - self.line_height).abs() > f64::EPSILON {
                Some(vec![height])
            } else {
                None
            },
        }
    }
}

fn tag_style(tag: &str) -> TextStyle {
    match tag {
        "b" | "strong" => TextStyle::BOLD,
        "i" | "em" | "cite" | "dfn" | "var" => TextStyle::ITALIC,
        "code" | "kbd" | "samp" | "tt" => TextStyle::MONO,
        "sub" => TextStyle::SUB,
        "sup" => TextStyle::SUP,
        "u" | "ins" => TextStyle::UNDERLINE,
        _ => TextStyle::NONE,
    }
}

fn is_known_html_tag(tag: &str) -> bool {
    matches!(
        tag,
        "a" | "abbr"
            | "address"
            | "article"
            | "aside"
            | "audio"
            | "b"
            | "bdi"
            | "bdo"
            | "big"
            | "blockquote"
            | "body"
            | "br"
            | "button"
            | "caption"
            | "center"
            | "cite"
            | "code"
            | "col"
            | "colgroup"
            | "data"
            | "dd"
            | "del"
            | "details"
            | "dfn"
            | "dialog"
            | "div"
            | "dl"
            | "dt"
            | "em"
            | "embed"
            | "fieldset"
            | "figcaption"
            | "figure"
            | "font"
            | "footer"
            | "form"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "head"
            | "header"
            | "hr"
            | "html"
            | "i"
            | "iframe"
            | "img"
            | "input"
            | "ins"
            | "kbd"
            | "label"
            | "legend"
            | "li"
            | "link"
            | "main"
            | "map"
            | "mark"
            | "meta"
            | "meter"
            | "nav"
            | "noscript"
            | "object"
            | "ol"
            | "optgroup"
            | "option"
            | "output"
            | "p"
            | "picture"
            | "pre"
            | "progress"
            | "q"
            | "rp"
            | "rt"
            | "ruby"
            | "s"
            | "samp"
            | "script"
            | "section"
            | "select"
            | "small"
            | "source"
            | "span"
            | "strike"
            | "strong"
            | "style"
            | "sub"
            | "summary"
            | "sup"
            | "table"
            | "tbody"
            | "td"
            | "template"
            | "textarea"
            | "tfoot"
            | "th"
            | "thead"
            | "time"
            | "title"
            | "tr"
            | "track"
            | "tt"
            | "u"
            | "ul"
            | "var"
            | "video"
            | "wbr"
    )
}

#[inline]
fn is_cjk(c: char) -> bool {
    let code = c as u32;
    (0x2e80..=0x9fff).contains(&code) || (0xf900..=0xfaff).contains(&code) || (0xff00..=0xff60).contains(&code)
}

#[inline]
fn is_close_punct(c: char) -> bool {
    matches!(
        c,
        '、' | '。'
            | '，'
            | '．'
            | '：'
            | '；'
            | '！'
            | '？'
            | '）'
            | '］'
            | '｝'
            | '」'
            | '』'
            | '】'
            | '〕'
            | '〉'
            | '》'
            | '〙'
            | '〗'
            | 'ー'
            | '…'
            | '‥'
            | '・'
            | 'ゝ'
            | 'ゞ'
            | 'ぁ'
            | 'ぃ'
            | 'ぅ'
            | 'ぇ'
            | 'ぉ'
            | 'っ'
            | 'ゃ'
            | 'ゅ'
            | 'ょ'
            | 'ゎ'
            | 'ァ'
            | 'ィ'
            | 'ゥ'
            | 'ェ'
            | 'ォ'
            | 'ッ'
            | 'ャ'
            | 'ュ'
            | 'ョ'
            | 'ヮ'
            | ','
            | '.'
            | ':'
            | ';'
            | '!'
            | '?'
            | ')'
            | ']'
            | '}'
    )
}

#[inline]
fn is_open_punct(c: char) -> bool {
    matches!(c, '（' | '［' | '｛' | '「' | '『' | '【' | '〔' | '〈' | '《' | '〘' | '〖' | '(' | '[' | '{')
}

#[inline]
fn is_hint(c: char) -> bool {
    c == '\u{200b}' || c == '\u{00ad}'
}

/// Splits text into wrapping pieces matching pele's `RE_PIECE`:
/// `\s*(?:[OPEN]*[CJK][CLOSE]*|[^\sCJK HINT]+[HINT]*[CLOSE]*|[HINT]+)\s*|\s+`
fn split_pieces(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let n = chars.len();
    let mut idx = 0;

    while idx < n {
        let start = chars[idx].0;
        let ws_end = {
            let mut j = idx;
            while j < n && chars[j].1.is_whitespace() {
                j += 1;
            }
            j
        };
        if ws_end == n {
            out.push(&text[start..]);
            break;
        }
        let mut j = ws_end;
        // Branch 1: [OPEN]* [CJK] [CLOSE]*
        let mut k = j;
        while k < n && is_open_punct(chars[k].1) {
            k += 1;
        }
        if k < n && is_cjk(chars[k].1) {
            k += 1;
            while k < n && is_close_punct(chars[k].1) {
                k += 1;
            }
            j = k;
        } else if !chars[j].1.is_whitespace() && !is_cjk(chars[j].1) && !is_hint(chars[j].1) {
            // Branch 2: [^\s CJK HINT]+ [HINT]* [CLOSE]*
            while j < n && !chars[j].1.is_whitespace() && !is_cjk(chars[j].1) && !is_hint(chars[j].1) {
                j += 1;
            }
            while j < n && is_hint(chars[j].1) {
                j += 1;
            }
            while j < n && is_close_punct(chars[j].1) {
                j += 1;
            }
        } else if is_hint(chars[j].1) {
            // Branch 3: [HINT]+
            while j < n && is_hint(chars[j].1) {
                j += 1;
            }
        } else {
            // Fallback (should not happen since ws_end < n)
            j = ws_end + 1;
        }
        while j < n && chars[j].1.is_whitespace() {
            j += 1;
        }
        let end = if j < n { chars[j].0 } else { text.len() };
        out.push(&text[start..end]);
        idx = j;
    }
    out
}

const MARK_BASE: u32 = 0xe000;
const MAX_MARKS: usize = 0x1900;

struct Marks {
    tex: Vec<String>,
    math: Vec<Option<MathSvg>>,
}

fn has_mark(s: &str) -> bool {
    s.chars().any(|c| (0xe000..=0xf8ff).contains(&(c as u32)))
}

fn dedent(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut min = usize::MAX;
    for line in &lines {
        if line.trim().is_empty() {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        if indent < min {
            min = indent;
        }
    }
    if min == usize::MAX || min == 0 {
        return text.to_string();
    }
    lines
        .into_iter()
        .map(|line| {
            let leading = line.len() - line.trim_start().len();
            &line[min.min(leading)..]
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn push_plain(line: &mut Vec<Span>, text: &str, style: TextStyle) {
    let decoded = decode_entities(text);
    if let Some(last) = line.last_mut()
        && last.is_plain()
        && last.style == style
    {
        last.text.push_str(&decoded);
    } else {
        line.push(Span::plain(decoded, style, 0.0));
    }
}

fn push_text(line: &mut Vec<Span>, text: &str, style: TextStyle, marks: Option<&Marks>) {
    if text.is_empty() {
        return;
    }
    if let Some(found) = marks
        && has_mark(text)
    {
        let mut last = 0usize;
        for (idx, ch) in text.char_indices() {
            let code = ch as u32;
            if (0xe000..=0xf8ff).contains(&code) {
                if idx > last {
                    push_plain(line, &text[last..idx], style);
                }
                let at = (code - MARK_BASE) as usize;
                if let Some(Some(math)) = found.math.get(at) {
                    line.push(Span {
                        text: String::new(),
                        style,
                        icon: None,
                        math: Some(math.clone()),
                        width: math.width,
                    });
                } else if let Some(tex) = found.tex.get(at) {
                    push_plain(line, &format!("$${tex}$$"), style);
                }
                last = idx + ch.len_utf8();
            }
        }
        if last < text.len() {
            push_plain(line, &text[last..], style);
        }
        return;
    }
    push_plain(line, text, style);
}

fn match_fa_icon(text: &str, from: usize) -> Option<(usize, &str)> {
    let rest = &text[from..];
    let bytes = rest.as_bytes();
    if bytes.len() < 7 || bytes[0] != b'f' || bytes[1] != b'a' {
        return None;
    }
    let colon_at = if bytes[2] == b':' {
        2
    } else if matches!(bytes[2], b'b' | b'k' | b'l' | b'r' | b's') && bytes.get(3) == Some(&b':') {
        3
    } else {
        return None;
    };
    if !rest[colon_at + 1..].starts_with("fa-") {
        return None;
    }
    let name_start = colon_at + 4;
    let mut end = name_start;
    while end < bytes.len() && (is_word(bytes[end] as u32) || bytes[end] == b'-') {
        end += 1;
    }
    if end == name_start {
        return None;
    }
    Some((from + end, &rest[..end]))
}

fn push_icons(line: &mut Vec<Span>, text: &str, style: TextStyle, marks: Option<&Marks>, icons: Option<&IconResolver<'_>>) {
    if !text.contains(":fa-") {
        push_text(line, text, style, marks);
        return;
    }
    let mut last = 0usize;
    let mut i = 0usize;
    let bytes = text.as_bytes();
    while i < bytes.len() {
        if bytes[i] == b'f'
            && let Some((end, icon)) = match_fa_icon(text, i)
        {
            push_text(line, &text[last..i], style, marks);
            last = end;
            let markup = icons.and_then(|f| f(icon)).unwrap_or_default();
            if !markup.is_empty() {
                line.push(Span {
                    text: String::new(),
                    style,
                    icon: Some(icon.to_string()),
                    math: None,
                    width: 0.0,
                });
            } else if bytes.get(last) == Some(&b' ') {
                last += 1;
            } else if last == bytes.len()
                && let Some(before) = line.last_mut()
                && before.is_plain()
            {
                before.text = before.text.trim_end().to_string();
            }
            i = last;
            continue;
        }
        i += 1;
    }
    push_text(line, &text[last..], style, marks);
}

struct OpenState {
    style: TextStyle,
    shifts: Vec<TextStyle>,
}

fn match_html_tag(source: &str, at: usize) -> Option<(usize, &str, bool)> {
    let bytes = source.as_bytes();
    if bytes.get(at) != Some(&b'<') {
        return None;
    }
    let mut i = at + 1;
    let closing = bytes.get(i) == Some(&b'/');
    if closing {
        i += 1;
    }
    let name_start = i;
    if !bytes.get(i).is_some_and(u8::is_ascii_alphabetic) {
        return None;
    }
    i += 1;
    while i < bytes.len() && (is_word(bytes[i] as u32) || bytes[i] == b'-') {
        i += 1;
    }
    let name = &source[name_start..i];
    if i < bytes.len() {
        let next = bytes[i];
        if next.is_ascii_whitespace() {
            while i < bytes.len() && bytes[i] != b'<' && bytes[i] != b'>' {
                i += 1;
            }
        } else if next == b'/' {
            i += 1;
        }
    }
    if bytes.get(i) != Some(&b'>') {
        return None;
    }
    Some((i + 1, name, closing))
}

fn parse_inline(
    line: &mut Vec<Span>,
    source: &str,
    markdown: bool,
    base: TextStyle,
    open: &mut OpenState,
    marks: Option<&Marks>,
    icons: Option<&IconResolver<'_>>,
) {
    let shift_mask = TextStyle::SUB | TextStyle::SUP;
    let mut style = open.style;
    let mut marked = TextStyle::NONE;
    let mut text = String::new();
    let bytes = source.as_bytes();
    let n = bytes.len();
    let mut i = 0;

    let flush = |line: &mut Vec<Span>, text: &mut String, style: TextStyle, shifts: &[TextStyle]| {
        if !text.is_empty() {
            let shift = shifts.last().copied().unwrap_or(TextStyle::NONE);
            push_icons(line, text, style | shift, marks, icons);
            text.clear();
        }
    };

    while i < n {
        let b = bytes[i];
        if b == b'<'
            && let Some((end, tag_raw, closing)) = match_html_tag(source, i)
        {
            let tag = tag_raw.to_ascii_lowercase();
            let bit = tag_style(&tag);
            if bit.intersects(shift_mask) {
                flush(line, &mut text, style, &open.shifts);
                if !closing {
                    open.shifts.push(bit);
                } else if let Some(at) = open.shifts.iter().rposition(|&s| s == bit) {
                    open.shifts.remove(at);
                }
            } else if !bit.is_empty() {
                flush(line, &mut text, style, &open.shifts);
                if closing {
                    open.style = (open.style & !bit) | (base & bit);
                    style = (style & !bit) | (base & bit);
                } else {
                    open.style |= bit;
                    style |= bit;
                }
            }
            if !bit.is_empty() || is_known_html_tag(&tag) {
                i = end;
                continue;
            }
        } else if markdown && (b == b'*' || b == b'_') {
            let ch = b as char;
            let double = bytes.get(i + 1) == Some(&b);
            let bit = if double { TextStyle::BOLD } else { TextStyle::ITALIC };
            let len = if double { 2 } else { 1 };
            let is_open = !marked.intersects(bit);
            let prev = if i > 0 { source[..i].chars().next_back().unwrap_or(' ') } else { ' ' };
            let next = if i + len < n { source[i + len..].chars().next().unwrap_or(' ') } else { ' ' };
            let needle = if double {
                if b == b'*' { "**" } else { "__" }
            } else if b == b'*' {
                "*"
            } else {
                "_"
            };
            let can_open = is_open && !next.is_whitespace() && source[i + len..].contains(needle);
            let can_close = !is_open && !prev.is_whitespace();
            let wordy = ch == '_' && is_word(prev as u32) && is_word(next as u32);
            if (can_open || can_close) && !wordy {
                flush(line, &mut text, style, &open.shifts);
                if can_open {
                    marked |= bit;
                    style |= bit;
                } else {
                    marked = marked & !bit;
                    style = (style & !bit) | (base & bit);
                }
                i += len;
                continue;
            }
        }
        let ch = source[i..].chars().next().unwrap();
        text.push(ch);
        i += ch.len_utf8();
    }
    flush(line, &mut text, style, &open.shifts);
}

fn measure_spans(line: &mut [Span], measurer: &dyn TextMeasurer, size: f64) -> f64 {
    let mut total = 0.0;
    for span in line {
        span.width = if span.icon.is_some() {
            size * 1.25
        } else if let Some(math) = &span.math {
            math.width
        } else {
            measurer.width(&span.text, size, span.style)
        };
        total += span.width;
    }
    total
}

fn wrap(line: &[Span], measurer: &dyn TextMeasurer, size: f64, max: f64, out: &mut Vec<Vec<Span>>, widths: &mut Vec<f64>) {
    let mut current: Vec<Span> = Vec::new();
    let mut width = 0.0;

    let commit = |current: &mut Vec<Span>, width: &mut f64, out: &mut Vec<Vec<Span>>, widths: &mut Vec<f64>, hyphen: bool| {
        if let Some(last) = current.last_mut()
            && last.is_plain()
        {
            let mut trimmed = last.text.trim_end().to_string();
            if hyphen && last.text.ends_with('\u{00ad}') {
                trimmed.pop();
                trimmed.push('-');
            }
            if trimmed != last.text {
                last.text = trimmed;
                let w = measurer.width(&last.text, size, last.style);
                *width += w - last.width;
                last.width = w;
            }
        }
        out.push(std::mem::take(current));
        widths.push(*width);
        *width = 0.0;
    };

    for (span_idx, span) in line.iter().enumerate() {
        if span.icon.is_some() || span.math.is_some() {
            let w = span.math.as_ref().map_or(size * 1.25, |m| m.width);
            if width > 0.0 && width + w > max {
                commit(&mut current, &mut width, out, widths, false);
            }
            let mut cloned = span.clone();
            cloned.width = w;
            current.push(cloned);
            width += w;
            continue;
        }
        let pieces = split_pieces(&span.text);
        let soft = span.text.contains('\u{00ad}');
        let n = if soft { pieces.len() } else { 0 };
        let mut own = vec![0.0f64; n];
        let mut rest = vec![0.0f64; n + 1];
        if soft {
            for q in (0..n).rev() {
                let shy = pieces[q].ends_with('\u{00ad}');
                let end = pieces[q].trim_end();
                let clean = if shy { end.strip_suffix('\u{00ad}').unwrap_or(end) } else { end };
                own[q] = measurer.width(clean, size, span.style);
                rest[q] = if !shy {
                    own[q]
                } else if q == n - 1 {
                    if span_idx + 1 == line.len() { own[q] } else { f64::INFINITY }
                } else {
                    own[q] + rest[q + 1]
                };
            }
        }
        for (p, &raw_part) in pieces.iter().enumerate() {
            let mut part = raw_part;
            let part_width = if soft { own[p] } else { measurer.width(part.trim_end(), size, span.style) };
            let fits = if !soft || !part.ends_with('\u{00ad}') {
                width + part_width <= max
            } else {
                let with_hyphen = format!("{}-", part.strip_suffix('\u{00ad}').unwrap_or(part));
                width + measurer.width(&with_hyphen, size, span.style) <= max || width + rest[p] <= max
            };
            if width > 0.0 && !fits {
                commit(&mut current, &mut width, out, widths, part.trim_start() == part);
                part = part.trim_start();
            }
            let can_append = current.last().is_some_and(|last| last.is_plain() && last.style == span.style);
            if can_append {
                let last = current.last_mut().unwrap();
                last.text.push_str(part);
                if part_width > 0.0 || part.trim_end() != part {
                    let before = last.width;
                    last.width = measurer.width(&last.text, size, last.style);
                    width += last.width - before;
                }
            } else {
                let w = measurer.width(part, size, span.style);
                current.push(Span::plain(part.to_string(), span.style, w));
                width += w;
            }
        }
    }
    if !current.is_empty() || out.is_empty() {
        commit(&mut current, &mut width, out, widths, false);
    }
}

/// Splits on `<br>`, `<br/>`, `<br ...>`, literal `\n`, or newline.
fn split_breaks(source: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let bytes = source.as_bytes();
    let n = bytes.len();
    let mut start = 0;
    let mut i = 0;
    while i < n {
        if bytes[i] == b'\n' {
            parts.push(&source[start..i]);
            i += 1;
            start = i;
            continue;
        }
        if bytes[i] == b'\\' && bytes.get(i + 1) == Some(&b'n') {
            parts.push(&source[start..i]);
            i += 2;
            start = i;
            continue;
        }
        if bytes[i] == b'<' && i + 3 < n && bytes[i + 1].eq_ignore_ascii_case(&b'b') && bytes[i + 2].eq_ignore_ascii_case(&b'r') {
            let mut j = i + 3;
            while j < n && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if bytes.get(j) == Some(&b'/') {
                j += 1;
            }
            if bytes.get(j) == Some(&b'>') {
                parts.push(&source[start..i]);
                i = j + 1;
                start = i;
                continue;
            }
        }
        i += 1;
    }
    parts.push(&source[start..]);
    parts
}

fn has_markup(raw: &str) -> bool {
    raw.contains(['<', '\\', '\n', '*', '_']) || raw.contains(":fa-")
}

fn replace_math_markers(raw: &str, size: f64, math: &MathResolver<'_>) -> Option<(String, Marks)> {
    if !raw.contains("$$") || has_mark(raw) {
        return None;
    }
    let mut found = Marks {
        tex: Vec::new(),
        math: Vec::new(),
    };
    let mut out = String::with_capacity(raw.len());
    let mut cursor = 0;
    while let Some(rel) = raw[cursor..].find("$$") {
        let open = cursor + rel;
        let inner_start = open + 2;
        if let Some(close_rel) = raw[inner_start..].find("$$")
            && close_rel > 0
            && found.tex.len() < MAX_MARKS
        {
            let tex = &raw[inner_start..inner_start + close_rel];
            if !tex.contains('\n') {
                out.push_str(&raw[cursor..open]);
                let idx = found.tex.len();
                found.tex.push(tex.to_string());
                let marker = char::from_u32(MARK_BASE + idx as u32).unwrap();
                out.push(marker);
                cursor = inner_start + close_rel + 2;
                continue;
            }
        }
        out.push_str(&raw[cursor..inner_start]);
        cursor = inner_start;
    }
    if found.tex.is_empty() {
        return None;
    }
    out.push_str(&raw[cursor..]);
    for tex in &found.tex {
        let resolved = math(&decode_entities(tex), size).filter(|m| m.width.is_finite() && m.width > 0.0 && m.height.is_finite() && m.height > 0.0);
        found.math.push(resolved);
    }
    Some((out, found))
}

#[allow(clippy::too_many_arguments)]
pub fn layout_label(
    raw: Option<&str>,
    markdown: bool,
    measurer: &dyn TextMeasurer,
    size: f64,
    max_width: f64,
    base: TextStyle,
    icons: Option<&IconResolver<'_>>,
    math: Option<&MathResolver<'_>>,
) -> Label {
    let Some(raw) = raw else {
        return Label::empty();
    };
    if raw.is_empty() {
        return Label::empty();
    }
    let line_height = (size * LINE_HEIGHT).round();

    if let Some(math_resolver) = math
        && let Some((marked, found)) = replace_math_markers(raw, size, math_resolver)
    {
        let label = layout_lines(&marked, markdown, measurer, size, max_width, base, line_height, Some(&found), icons);
        return with_heights(label);
    }

    if !has_markup(raw) && !raw.contains('&') && !raw.contains('ﬂ') {
        let text = raw.trim();
        let width = measurer.width(text, size, base);
        if width <= max_width || !(text.contains(' ') || text.chars().any(|c| is_cjk(c) || is_hint(c))) {
            return Label {
                lines: vec![vec![Span::plain(text.to_string(), base, width)]],
                widths: vec![width],
                width,
                height: line_height,
                size,
                line_height,
                heights: None,
            };
        }
        let mut lines = Vec::new();
        let mut widths = Vec::new();
        let initial = [Span::plain(text.to_string(), base, width)];
        wrap(&initial, measurer, size, max_width, &mut lines, &mut widths);
        let widest = widths.iter().copied().fold(0.0f64, f64::max);
        let snug = if lines.len() > 1 { (size * WRAPPED_LINE_HEIGHT).round() } else { line_height };
        return Label {
            height: lines.len() as f64 * snug,
            lines,
            widths,
            width: widest,
            size,
            line_height: snug,
            heights: None,
        };
    }

    layout_lines(raw, markdown, measurer, size, max_width, base, line_height, None, icons)
}

#[allow(clippy::too_many_arguments)]
fn layout_lines(
    raw: &str,
    markdown: bool,
    measurer: &dyn TextMeasurer,
    size: f64,
    max_width: f64,
    base: TextStyle,
    line_height: f64,
    marks: Option<&Marks>,
    icons: Option<&IconResolver<'_>>,
) -> Label {
    let source = if markdown {
        let normalized = crate::preprocess::normalize_line_breaks(raw);
        dedent(&normalized).trim().to_string()
    } else {
        raw.trim().to_string()
    };
    let mut lines = Vec::new();
    let mut widths = Vec::new();
    let mut open = OpenState {
        style: base,
        shifts: Vec::new(),
    };
    for part in split_breaks(&source) {
        let mut line = Vec::new();
        parse_inline(&mut line, part.trim(), markdown, base, &mut open, marks, icons);
        let w = measure_spans(&mut line, measurer, size);
        if w > max_width {
            wrap(&line, measurer, size, max_width, &mut lines, &mut widths);
        } else {
            lines.push(line);
            widths.push(w);
        }
    }
    let width = widths.iter().copied().fold(0.0f64, f64::max);
    let snug = if lines.len() > 1 { (size * WRAPPED_LINE_HEIGHT).round() } else { line_height };
    Label {
        height: lines.len() as f64 * snug,
        lines,
        widths,
        width,
        size,
        line_height: snug,
        heights: None,
    }
}

pub fn with_heights(mut label: Label) -> Label {
    let mut heights: Option<Vec<f64>> = None;
    for (i, line) in label.lines.iter().enumerate() {
        let mut h = label.line_height;
        for span in line {
            if let Some(math) = &span.math {
                h = h.max((math.height + label.size / 4.0).ceil());
            }
        }
        if (h - label.line_height).abs() > f64::EPSILON && heights.is_none() {
            heights = Some(vec![label.line_height; label.lines.len()]);
        }
        if let Some(hs) = heights.as_mut() {
            hs[i] = h;
        }
    }
    match heights {
        None => {
            label.heights = None;
            label.height = label.lines.len() as f64 * label.line_height;
            label
        }
        Some(hs) => {
            label.height = hs.iter().sum();
            label.heights = Some(hs);
            label
        }
    }
}
