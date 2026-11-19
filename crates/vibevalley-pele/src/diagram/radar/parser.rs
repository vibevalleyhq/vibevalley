use crate::detect::DiagramType;
use crate::diagram::common::{
    TokenReader, TokenStream, acc_descr_value, acc_title_value, scan_acc_title, scan_directive, scan_keyword, scan_newline, scan_single_line_comment,
    scan_string, scan_whitespace, scan_yaml_block, string_value, title_value,
};
use crate::error::{PeleError, SourceMap, syntax_error};
use crate::util::chars::{is_digit, is_word};

use super::model::Graticule;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RadarToken {
    RadarColon,
    Radar,
    ShowLegend,
    Graticule,
    Curve,
    Ticks,
    Axis,
    Max,
    Min,
    Colon,
    Comma,
    Open,
    Close,
    OpenBrace,
    CloseBrace,
    GraticuleValue,
    Boolean,
    AccDescr,
    AccTitle,
    Title,
    Number,
    String,
    Id,
    Newline,
}

fn token_name(k: RadarToken) -> &'static str {
    match k {
        RadarToken::RadarColon => "radar-beta:",
        RadarToken::Radar => "radar-beta",
        RadarToken::ShowLegend => "showLegend",
        RadarToken::Graticule => "graticule",
        RadarToken::Curve => "curve",
        RadarToken::Ticks => "ticks",
        RadarToken::Axis => "axis",
        RadarToken::Max => "max",
        RadarToken::Min => "min",
        RadarToken::Colon => ":",
        RadarToken::Comma => ",",
        RadarToken::Open => "[",
        RadarToken::Close => "]",
        RadarToken::OpenBrace => "{",
        RadarToken::CloseBrace => "}",
        RadarToken::GraticuleValue => "GRATICULE",
        RadarToken::Boolean => "BOOLEAN",
        RadarToken::AccDescr => "ACC_DESCR",
        RadarToken::AccTitle => "ACC_TITLE",
        RadarToken::Title => "TITLE",
        RadarToken::Number => "NUMBER",
        RadarToken::String => "STRING",
        RadarToken::Id => "ID",
        RadarToken::Newline => "NEWLINE",
    }
}

struct NumberScanner {
    run_from: usize,
    run_end: usize,
}

impl NumberScanner {
    fn new() -> Self {
        Self { run_from: 0, run_end: 0 }
    }

    fn scan(&mut self, src: &str, at: usize) -> Option<usize> {
        let bytes = src.as_bytes();
        if at < self.run_from || at >= self.run_end {
            self.run_from = at;
            let mut e = at;
            while e < bytes.len() && is_digit(bytes[e] as u32) {
                e += 1;
            }
            self.run_end = e;
        }
        let whole = self.run_end;
        if whole == at {
            return None;
        }
        let dot = bytes.get(whole) == Some(&b'.');
        if dot {
            let mut fraction = whole + 1;
            while fraction < bytes.len() && is_digit(bytes[fraction] as u32) {
                fraction += 1;
            }
            let length = fraction - whole - 1;
            if length > 0 && bytes.get(fraction) != Some(&b'.') {
                return Some(fraction);
            }
            if length > 1 {
                return Some(fraction - 1);
            }
        }
        if bytes[at] == b'0' {
            return Some(at + 1);
        }
        if !dot {
            return Some(whole);
        }
        if whole - 1 > at { Some(whole - 1) } else { None }
    }
}

fn scan_id(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    if !is_word(*bytes.get(at)? as u32) {
        return None;
    }
    let mut p = at + 1;
    let mut last_word = p;
    while p < bytes.len() && (is_word(bytes[p] as u32) || bytes[p] == b'-') {
        if is_word(bytes[p] as u32) {
            last_word = p + 1;
        }
        p += 1;
    }
    Some(last_word)
}

fn has_name_rest(src: &str, at: usize) -> bool {
    let bytes = src.as_bytes();
    let mut p = at;
    while p < bytes.len() && bytes[p] == b'-' {
        p += 1;
    }
    bytes.get(p).is_some_and(|&b| is_word(b as u32))
}

fn scan_title_before_name(src: &str, at: usize) -> Option<usize> {
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
        return Some(p);
    }
    if has_name_rest(src, p) { None } else { Some(p) }
}

fn scan_radar_acc_descr(src: &str, at: usize, last_brace: &mut Option<Option<usize>>) -> Option<usize> {
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
        let last = *last_brace.get_or_insert_with(|| src.rfind('}'));
        if last.is_none_or(|lb| ws + 1 > lb) {
            return None;
        }
        return src[ws + 1..].find('}').map(|rel| ws + 1 + rel + 1);
    }
    None
}

fn scan_option_value(src: &str, at: usize, prev: Option<RadarToken>, option: RadarToken, words: &[&str]) -> Option<usize> {
    for &w in words {
        if src[at..].starts_with(w) {
            let end = at + w.len();
            if prev == Some(option) || !has_name_rest(src, end) {
                return Some(end);
            }
        }
    }
    None
}

fn tokenize_radar<'a>(src: &'a str, origin: Option<&SourceMap<'_>>) -> Result<TokenStream<'a, RadarToken>, PeleError> {
    let mut kinds: Vec<Option<RadarToken>> = Vec::new();
    let mut starts: Vec<usize> = Vec::new();
    let mut ends: Vec<usize> = Vec::new();
    let mut num_scanner = NumberScanner::new();
    let mut last_brace: Option<Option<usize>> = None;
    let mut yaml_dead = false;
    let mut dir_dead = false;
    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut p = 0usize;

    macro_rules! push_tok {
        ($kind:expr, $end:expr) => {{
            kinds.push(Some($kind));
            starts.push(p);
            ends.push($end);
            p = $end;
        }};
    }

    while p < n {
        let b = bytes[p];
        let prev = kinds.last().copied().flatten();

        // Exact upstream RADAR_TOKENS priority order with LONGER_ALT = [ID] on keywords.
        if b == b'r' {
            if src[p..].starts_with("radar-beta:") {
                push_tok!(RadarToken::RadarColon, p + 11);
                continue;
            }
            if let Some(end) = scan_keyword(src, p, "radar-beta") {
                if let Some(id_end) = scan_id(src, p)
                    && id_end > end
                {
                    push_tok!(RadarToken::Id, id_end);
                } else {
                    push_tok!(RadarToken::Radar, end);
                }
                continue;
            }
        }

        let kw_match: Option<(RadarToken, usize)> = match b {
            b's' if src[p..].starts_with("showLegend") => Some((RadarToken::ShowLegend, p + 10)),
            b'g' if src[p..].starts_with("graticule") => Some((RadarToken::Graticule, p + 9)),
            b'c' if src[p..].starts_with("curve") => Some((RadarToken::Curve, p + 5)),
            b't' if src[p..].starts_with("ticks") => Some((RadarToken::Ticks, p + 5)),
            b'a' if src[p..].starts_with("axis") => Some((RadarToken::Axis, p + 4)),
            b'm' if src[p..].starts_with("max") => Some((RadarToken::Max, p + 3)),
            b'm' if src[p..].starts_with("min") => Some((RadarToken::Min, p + 3)),
            _ => None,
        };
        if let Some((tok, end)) = kw_match {
            if let Some(id_end) = scan_id(src, p)
                && id_end > end
            {
                push_tok!(RadarToken::Id, id_end);
            } else {
                push_tok!(tok, end);
            }
            continue;
        }

        match b {
            b':' => {
                push_tok!(RadarToken::Colon, p + 1);
                continue;
            }
            b',' => {
                push_tok!(RadarToken::Comma, p + 1);
                continue;
            }
            b'[' => {
                push_tok!(RadarToken::Open, p + 1);
                continue;
            }
            b']' => {
                push_tok!(RadarToken::Close, p + 1);
                continue;
            }
            b'{' => {
                push_tok!(RadarToken::OpenBrace, p + 1);
                continue;
            }
            b'}' => {
                push_tok!(RadarToken::CloseBrace, p + 1);
                continue;
            }
            _ => {}
        }

        if matches!(b, b'c' | b'p')
            && let Some(end) = scan_option_value(src, p, prev, RadarToken::Graticule, &["circle", "polygon"])
        {
            push_tok!(RadarToken::GraticuleValue, end);
            continue;
        }
        if matches!(b, b't' | b'f')
            && let Some(end) = scan_option_value(src, p, prev, RadarToken::ShowLegend, &["true", "false"])
        {
            push_tok!(RadarToken::Boolean, end);
            continue;
        }
        if matches!(b, b' ' | b'\t' | b'a') {
            if let Some(end) = scan_radar_acc_descr(src, p, &mut last_brace) {
                push_tok!(RadarToken::AccDescr, end);
                continue;
            }
            if let Some(end) = scan_acc_title(src, p) {
                push_tok!(RadarToken::AccTitle, end);
                continue;
            }
        }
        if matches!(b, b' ' | b'\t' | b't')
            && let Some(end) = scan_title_before_name(src, p)
        {
            push_tok!(RadarToken::Title, end);
            continue;
        }
        if b.is_ascii_digit()
            && let Some(end) = num_scanner.scan(src, p)
        {
            push_tok!(RadarToken::Number, end);
            continue;
        }
        if matches!(b, b'"' | b'\'')
            && let Some(end) = scan_string(src, p)
        {
            push_tok!(RadarToken::String, end);
            continue;
        }
        if is_word(b as u32)
            && let Some(end) = scan_id(src, p)
        {
            push_tok!(RadarToken::Id, end);
            continue;
        }
        if matches!(b, b'\r' | b'\n')
            && let Some(end) = scan_newline(src, p)
        {
            push_tok!(RadarToken::Newline, end);
            continue;
        }
        if matches!(b, b' ' | b'\t')
            && let Some(end) = scan_whitespace(src, p)
        {
            p = end;
            continue;
        }
        if b == b'-'
            && let Some(end) = scan_yaml_block(src, p, &mut yaml_dead)
        {
            p = end;
            continue;
        }
        if matches!(b, b' ' | b'\t' | b'%') {
            if let Some(end) = scan_directive(src, p, &mut dir_dead) {
                p = end;
                continue;
            }
            if let Some(end) = scan_single_line_comment(src, p) {
                p = end;
                continue;
            }
        }

        return Err(syntax_error(DiagramType::Radar, src, p, "", true, origin));
    }

    kinds.push(None);
    starts.push(n);
    ends.push(n);
    Ok(TokenStream { kinds, starts, ends, src })
}

#[derive(Debug, Clone)]
pub struct AxisAst {
    pub name: String,
    pub label: Option<String>,
}

#[derive(Debug, Clone)]
pub struct EntryAst {
    pub axis: Option<String>,
    pub value: f64,
}

#[derive(Debug, Clone)]
pub struct CurveAst {
    pub name: String,
    pub label: Option<String>,
    pub entries: Vec<EntryAst>,
}

#[derive(Debug, Clone)]
pub enum OptionValue {
    ShowLegend(bool),
    Ticks(f64),
    Max(f64),
    Min(f64),
    Graticule(Graticule),
}

#[derive(Debug, Clone)]
pub struct RadarAst {
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    pub axes: Vec<AxisAst>,
    pub curves: Vec<CurveAst>,
    pub options: Vec<OptionValue>,
}

#[derive(Debug, Clone, Copy)]
enum OptionKind {
    ShowLegend,
    Graticule,
    Ticks,
    Max,
    Min,
}

pub fn parse_radar(src: &str, origin: Option<&SourceMap<'_>>) -> Result<RadarAst, PeleError> {
    let tokens = tokenize_radar(src, origin)?;
    let mut r = TokenReader::new(tokens, DiagramType::Radar, origin, token_name);
    let mut ast = RadarAst {
        title: None,
        acc_title: None,
        acc_descr: None,
        axes: Vec::new(),
        curves: Vec::new(),
        options: Vec::new(),
    };

    let skip_newlines = |r: &mut TokenReader<'_, RadarToken>| {
        while r.kind() == Some(RadarToken::Newline) {
            r.i += 1;
        }
    };

    let end_of_line = |r: &mut TokenReader<'_, RadarToken>| -> Result<(), PeleError> {
        if r.kind().is_none() {
            return Ok(());
        }
        if r.kind() != Some(RadarToken::Newline) {
            return Err(r.fail("a line break or the end of input"));
        }
        while r.kind() == Some(RadarToken::Newline) {
            r.i += 1;
        }
        Ok(())
    };

    let read_label = |r: &mut TokenReader<'_, RadarToken>| -> Result<Option<String>, PeleError> {
        if !r.accept(RadarToken::Open) {
            return Ok(None);
        }
        let text = string_value(r.expect(RadarToken::String)?);
        r.expect(RadarToken::Close)?;
        Ok(Some(text))
    };

    let read_entry = |r: &mut TokenReader<'_, RadarToken>, detailed: bool| -> Result<EntryAst, PeleError> {
        if !detailed {
            let value = r.expect(RadarToken::Number)?.parse().unwrap_or(f64::NAN);
            return Ok(EntryAst { axis: None, value });
        }
        let axis = r.expect(RadarToken::Id)?.to_string();
        r.accept(RadarToken::Colon);
        let value = r.expect(RadarToken::Number)?.parse().unwrap_or(f64::NAN);
        Ok(EntryAst { axis: Some(axis), value })
    };

    let read_curve = |r: &mut TokenReader<'_, RadarToken>| -> Result<CurveAst, PeleError> {
        let name = r.expect(RadarToken::Id)?.to_string();
        let label = read_label(r)?;
        r.expect(RadarToken::OpenBrace)?;
        skip_newlines(r);
        if !matches!(r.kind(), Some(RadarToken::Number | RadarToken::Id)) {
            return Err(r.fail("a number or an axis name"));
        }
        let detailed = r.kind() == Some(RadarToken::Id);
        let mut entries = vec![read_entry(r, detailed)?];
        while r.accept(RadarToken::Comma) {
            skip_newlines(r);
            entries.push(read_entry(r, detailed)?);
        }
        skip_newlines(r);
        r.expect(RadarToken::CloseBrace)?;
        Ok(CurveAst { name, label, entries })
    };

    let read_axis = |r: &mut TokenReader<'_, RadarToken>| -> Result<AxisAst, PeleError> {
        let name = r.expect(RadarToken::Id)?.to_string();
        let label = read_label(r)?;
        Ok(AxisAst { name, label })
    };

    let option_kind = |k: Option<RadarToken>| -> Option<OptionKind> {
        match k? {
            RadarToken::ShowLegend => Some(OptionKind::ShowLegend),
            RadarToken::Graticule => Some(OptionKind::Graticule),
            RadarToken::Ticks => Some(OptionKind::Ticks),
            RadarToken::Max => Some(OptionKind::Max),
            RadarToken::Min => Some(OptionKind::Min),
            RadarToken::Newline
            | RadarToken::AccDescr
            | RadarToken::AccTitle
            | RadarToken::Title
            | RadarToken::Axis
            | RadarToken::Curve
            | RadarToken::RadarColon
            | RadarToken::Radar
            | RadarToken::Colon
            | RadarToken::Comma
            | RadarToken::Open
            | RadarToken::Close
            | RadarToken::OpenBrace
            | RadarToken::CloseBrace
            | RadarToken::GraticuleValue
            | RadarToken::Boolean
            | RadarToken::Number
            | RadarToken::String
            | RadarToken::Id => None,
        }
    };

    let read_option = |r: &mut TokenReader<'_, RadarToken>, kind: OptionKind| -> Result<OptionValue, PeleError> {
        let _ = r.take();
        match kind {
            OptionKind::ShowLegend => Ok(OptionValue::ShowLegend(r.expect(RadarToken::Boolean)? == "true")),
            OptionKind::Graticule => Ok(OptionValue::Graticule(if r.expect(RadarToken::GraticuleValue)? == "polygon" {
                Graticule::Polygon
            } else {
                Graticule::Circle
            })),
            OptionKind::Ticks => Ok(OptionValue::Ticks(r.expect(RadarToken::Number)?.parse().unwrap_or(5.0))),
            OptionKind::Max => Ok(OptionValue::Max(r.expect(RadarToken::Number)?.parse().unwrap_or(f64::NAN))),
            OptionKind::Min => Ok(OptionValue::Min(r.expect(RadarToken::Number)?.parse().unwrap_or(0.0))),
        }
    };

    skip_newlines(&mut r);
    if !r.accept(RadarToken::RadarColon) {
        r.expect(RadarToken::Radar)?;
        r.accept(RadarToken::Colon);
    }
    skip_newlines(&mut r);

    while let Some(k) = r.kind() {
        match k {
            RadarToken::Newline => {
                r.i += 1;
            }
            RadarToken::AccDescr => {
                ast.acc_descr = Some(acc_descr_value(r.take()));
                end_of_line(&mut r)?;
            }
            RadarToken::AccTitle => {
                ast.acc_title = Some(acc_title_value(r.take()));
                end_of_line(&mut r)?;
            }
            RadarToken::Title => {
                ast.title = Some(title_value(r.take()));
                end_of_line(&mut r)?;
            }
            RadarToken::Axis => {
                r.i += 1;
                loop {
                    ast.axes.push(read_axis(&mut r)?);
                    if !r.accept(RadarToken::Comma) {
                        break;
                    }
                }
            }
            RadarToken::Curve => {
                r.i += 1;
                loop {
                    ast.curves.push(read_curve(&mut r)?);
                    if !r.accept(RadarToken::Comma) {
                        break;
                    }
                }
            }
            RadarToken::ShowLegend | RadarToken::Ticks | RadarToken::Max | RadarToken::Min | RadarToken::Graticule => {
                let first = option_kind(Some(k)).unwrap();
                ast.options.push(read_option(&mut r, first)?);
                while r.accept(RadarToken::Comma) {
                    let Some(next) = option_kind(r.kind()) else {
                        return Err(r.fail("an option"));
                    };
                    ast.options.push(read_option(&mut r, next)?);
                }
            }
            RadarToken::RadarColon
            | RadarToken::Radar
            | RadarToken::Colon
            | RadarToken::Comma
            | RadarToken::Open
            | RadarToken::Close
            | RadarToken::OpenBrace
            | RadarToken::CloseBrace
            | RadarToken::GraticuleValue
            | RadarToken::Boolean
            | RadarToken::Number
            | RadarToken::String
            | RadarToken::Id => {
                return Err(r.fail("an axis, a curve, an option, a title, or a line break"));
            }
        }
    }
    Ok(ast)
}
