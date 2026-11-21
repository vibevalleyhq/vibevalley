use crate::detect::DiagramType;
use crate::diagram::common::{
    TokenReader, TokenStream, scan_acc_descr, scan_acc_title, scan_directive, scan_keyword, scan_newline, scan_single_line_comment, scan_yaml_block,
};
use crate::error::{PeleError, SourceMap, syntax_error};
use crate::util::chars::{is_line_end, is_space_char, is_word};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EmToken {
    Eventmodeling,
    Resetframe,
    Readmodel,
    Processor,
    Timeframe,
    Command,
    Entity,
    Event,
    Jsobj,
    Figma,
    Given,
    Json,
    Salt,
    Html,
    Text,
    Data,
    Note,
    When,
    Then,
    Rmo,
    Cmd,
    Evt,
    Pcr,
    Uri,
    Arrow,
    Gwt,
    Ui,
    Md,
    Tf,
    Open,
    Close,
    Rf,
    Tick,
    Dot,
    Id,
    FrameId,
    Inline,
    Block,
    AccDescr,
    AccTitle,
    Title,
}

impl EmToken {
    const fn name(self) -> &'static str {
        match self {
            Self::Eventmodeling => "eventmodeling",
            Self::Resetframe => "resetframe",
            Self::Readmodel => "readmodel",
            Self::Processor => "processor",
            Self::Timeframe => "timeframe",
            Self::Command => "command",
            Self::Entity => "entity",
            Self::Event => "event",
            Self::Jsobj => "jsobj",
            Self::Figma => "figma",
            Self::Given => "given",
            Self::Json => "json",
            Self::Salt => "salt",
            Self::Html => "html",
            Self::Text => "text",
            Self::Data => "data",
            Self::Note => "note",
            Self::When => "when",
            Self::Then => "then",
            Self::Rmo => "rmo",
            Self::Cmd => "cmd",
            Self::Evt => "evt",
            Self::Pcr => "pcr",
            Self::Uri => "uri",
            Self::Arrow => "->>",
            Self::Gwt => "gwt",
            Self::Ui => "ui",
            Self::Md => "md",
            Self::Tf => "tf",
            Self::Open => "[[",
            Self::Close => "]]",
            Self::Rf => "rf",
            Self::Tick => "`",
            Self::Dot => ".",
            Self::Id => "EM_ID",
            Self::FrameId => "EM_FID",
            Self::Inline => "EM_DATA_INLINE",
            Self::Block => "EM_DATA_BLOCK",
            Self::AccDescr => "EM_ACC_DESCR",
            Self::AccTitle => "EM_ACC_TITLE",
            Self::Title => "EM_TITLE",
        }
    }

    const fn is_time_frame(self) -> bool {
        matches!(self, Self::Tf | Self::Timeframe)
    }

    const fn is_reset_frame(self) -> bool {
        matches!(self, Self::Rf | Self::Resetframe)
    }

    const fn is_entity_type(self) -> bool {
        matches!(
            self,
            Self::Rmo | Self::Readmodel | Self::Ui | Self::Cmd | Self::Command | Self::Evt | Self::Event | Self::Pcr | Self::Processor
        )
    }

    const fn is_data_type(self) -> bool {
        matches!(
            self,
            Self::Json | Self::Jsobj | Self::Figma | Self::Salt | Self::Uri | Self::Md | Self::Html | Self::Text
        )
    }
}

const WORDS: &[(&str, EmToken)] = &[
    ("resetframe", EmToken::Resetframe),
    ("readmodel", EmToken::Readmodel),
    ("processor", EmToken::Processor),
    ("timeframe", EmToken::Timeframe),
    ("command", EmToken::Command),
    ("entity", EmToken::Entity),
    ("event", EmToken::Event),
    ("jsobj", EmToken::Jsobj),
    ("figma", EmToken::Figma),
    ("given", EmToken::Given),
    ("json", EmToken::Json),
    ("salt", EmToken::Salt),
    ("html", EmToken::Html),
    ("text", EmToken::Text),
    ("data", EmToken::Data),
    ("note", EmToken::Note),
    ("when", EmToken::When),
    ("then", EmToken::Then),
    ("rmo", EmToken::Rmo),
    ("cmd", EmToken::Cmd),
    ("evt", EmToken::Evt),
    ("pcr", EmToken::Pcr),
    ("uri", EmToken::Uri),
];

const SHORT_WORDS: &[(&str, EmToken)] = &[("gwt", EmToken::Gwt), ("ui", EmToken::Ui), ("md", EmToken::Md), ("tf", EmToken::Tf)];

fn scan_em_id(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let first = *bytes.get(at)?;
    if !(first == b'_' || first.is_ascii_alphabetic()) {
        return None;
    }
    let mut p = at + 1;
    while p < bytes.len() && is_word(bytes[p] as u32) {
        p += 1;
    }
    Some(p)
}

fn scan_em_fid(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    if !bytes.get(at).is_some_and(u8::is_ascii_digit) {
        return None;
    }
    let mut p = at + 1;
    let max_end = (at + 3).min(bytes.len());
    while p < max_end && bytes[p].is_ascii_digit() {
        p += 1;
    }
    Some(p)
}

/// Matches JS `/\{(.*)\}|"(.*)"|'(.*)'/y`: greedy match to the last matching closer on the same line.
fn scan_data_inline(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let open = *bytes.get(at)?;
    let close = match open {
        b'{' => b'}',
        b'"' => b'"',
        b'\'' => b'\'',
        _ => return None,
    };
    let mut p = at + 1;
    let mut last_close: Option<usize> = None;
    while p < src.len() {
        let b = bytes[p];
        if b == b'\n' || b == b'\r' {
            break;
        }
        if b < 128 {
            if b == close {
                last_close = Some(p + 1);
            }
            p += 1;
        } else {
            let ch = src[p..].chars().next()?;
            if is_line_end(ch as u32) {
                break;
            }
            p += ch.len_utf8();
        }
    }
    last_close
}

/// Matches JS `/\{[\t ]*\r?\n(?:[\S\s]*?\r?\n)?\}(?:\r?\n|(?!\S))/y`.
fn scan_data_block(src: &str, at: usize, dead: &mut bool) -> Option<usize> {
    if *dead {
        return None;
    }
    let bytes = src.as_bytes();
    if bytes.get(at) != Some(&b'{') {
        return None;
    }
    let mut p = at + 1;
    while p < bytes.len() && matches!(bytes[p], b' ' | b'\t') {
        p += 1;
    }
    let mut cur = scan_newline(src, p)?;
    while cur < bytes.len() {
        if bytes[cur] == b'}' {
            let after = cur + 1;
            if let Some(e) = scan_newline(src, after) {
                return Some(e);
            }
            if after == bytes.len() || src[after..].chars().next().is_some_and(is_space_char) {
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

/// Matches `titleBefore("\\w")`: `/[\t ]*title(?:[\t ][^\n\r]*?(?=%%)|[\t ][^\n\r]*|(?!\w))/y`.
fn scan_em_title(src: &str, at: usize) -> Option<usize> {
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
    if bytes.get(p).is_some_and(|&b| is_word(b as u32)) {
        return None;
    }
    Some(p)
}

fn scan_em_ws(src: &str, at: usize) -> Option<usize> {
    let mut p = at;
    while p < src.len() {
        let ch = src[p..].chars().next()?;
        if is_space_char(ch) {
            p += ch.len_utf8();
        } else {
            break;
        }
    }
    (p > at).then_some(p)
}

fn scan_ml_comment(src: &str, at: usize, dead: &mut bool) -> Option<usize> {
    if *dead || !src[at..].starts_with("/*") {
        return None;
    }
    if let Some(rel) = src[at + 2..].find("*/") {
        Some(at + 2 + rel + 2)
    } else {
        *dead = true;
        None
    }
}

fn scan_sl_comment(src: &str, at: usize) -> Option<usize> {
    if !src[at..].starts_with("//") {
        return None;
    }
    let bytes = src.as_bytes();
    let mut p = at + 2;
    while p < bytes.len() && !matches!(bytes[p], b'\n' | b'\r') {
        p += 1;
    }
    Some(p)
}

fn match_word_with_id_longer(src: &str, at: usize, word: &str, kind: EmToken) -> Option<(EmToken, usize)> {
    if !src[at..].starts_with(word) {
        return None;
    }
    let end = at + word.len();
    if let Some(id_end) = scan_em_id(src, at)
        && id_end > end
    {
        return Some((EmToken::Id, id_end));
    }
    Some((kind, end))
}

fn tokenize_eventmodeling<'a>(src: &'a str, origin: Option<&SourceMap<'_>>) -> Result<TokenStream<'a, EmToken>, PeleError> {
    let mut kinds: Vec<Option<EmToken>> = Vec::new();
    let mut starts: Vec<usize> = Vec::new();
    let mut ends: Vec<usize> = Vec::new();
    let mut unclosed_descr = false;
    let mut block_dead = false;
    let mut yaml_dead = false;
    let mut dir_dead = false;
    let mut ml_dead = false;

    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut p = 0usize;

    let push_tok = |kinds: &mut Vec<Option<EmToken>>, starts: &mut Vec<usize>, ends: &mut Vec<usize>, kind: EmToken, s: usize, e: usize| {
        kinds.push(Some(kind));
        starts.push(s);
        ends.push(e);
    };

    'scan: while p < n {
        let b = bytes[p];

        if b == b'e'
            && let Some(end) = scan_keyword(src, p, "eventmodeling")
        {
            if let Some(id_end) = scan_em_id(src, p)
                && id_end > end
            {
                push_tok(&mut kinds, &mut starts, &mut ends, EmToken::Id, p, id_end);
                p = id_end;
            } else {
                push_tok(&mut kinds, &mut starts, &mut ends, EmToken::Eventmodeling, p, end);
                p = end;
            }
            continue;
        }

        if b.is_ascii_lowercase() {
            for &(word, kind) in WORDS {
                if word.as_bytes()[0] == b
                    && let Some((resolved, end)) = match_word_with_id_longer(src, p, word, kind)
                {
                    push_tok(&mut kinds, &mut starts, &mut ends, resolved, p, end);
                    p = end;
                    continue 'scan;
                }
            }
        }

        if b == b'-' && src[p..].starts_with("->>") {
            push_tok(&mut kinds, &mut starts, &mut ends, EmToken::Arrow, p, p + 3);
            p += 3;
            continue;
        }

        if b.is_ascii_lowercase() {
            for &(word, kind) in SHORT_WORDS {
                if word.as_bytes()[0] == b
                    && let Some((resolved, end)) = match_word_with_id_longer(src, p, word, kind)
                {
                    push_tok(&mut kinds, &mut starts, &mut ends, resolved, p, end);
                    p = end;
                    continue 'scan;
                }
            }
        }

        if b == b'[' && src[p..].starts_with("[[") {
            push_tok(&mut kinds, &mut starts, &mut ends, EmToken::Open, p, p + 2);
            p += 2;
            continue;
        }
        if b == b']' && src[p..].starts_with("]]") {
            push_tok(&mut kinds, &mut starts, &mut ends, EmToken::Close, p, p + 2);
            p += 2;
            continue;
        }

        if b == b'r'
            && let Some((resolved, end)) = match_word_with_id_longer(src, p, "rf", EmToken::Rf)
        {
            push_tok(&mut kinds, &mut starts, &mut ends, resolved, p, end);
            p = end;
            continue;
        }

        if b == b'`' {
            push_tok(&mut kinds, &mut starts, &mut ends, EmToken::Tick, p, p + 1);
            p += 1;
            continue;
        }
        if b == b'.' {
            push_tok(&mut kinds, &mut starts, &mut ends, EmToken::Dot, p, p + 1);
            p += 1;
            continue;
        }

        if let Some(end) = scan_em_id(src, p) {
            push_tok(&mut kinds, &mut starts, &mut ends, EmToken::Id, p, end);
            p = end;
            continue;
        }
        if let Some(end) = scan_em_fid(src, p) {
            push_tok(&mut kinds, &mut starts, &mut ends, EmToken::FrameId, p, end);
            p = end;
            continue;
        }
        if let Some(end) = scan_data_inline(src, p) {
            push_tok(&mut kinds, &mut starts, &mut ends, EmToken::Inline, p, end);
            p = end;
            continue;
        }
        if let Some(end) = scan_data_block(src, p, &mut block_dead) {
            push_tok(&mut kinds, &mut starts, &mut ends, EmToken::Block, p, end);
            p = end;
            continue;
        }

        if matches!(b, b' ' | b'\t' | b'a') {
            if let Some(end) = scan_acc_descr(src, p, &mut unclosed_descr) {
                push_tok(&mut kinds, &mut starts, &mut ends, EmToken::AccDescr, p, end);
                p = end;
                continue;
            }
            if let Some(end) = scan_acc_title(src, p) {
                push_tok(&mut kinds, &mut starts, &mut ends, EmToken::AccTitle, p, end);
                p = end;
                continue;
            }
        }
        if matches!(b, b' ' | b'\t' | b't')
            && let Some(end) = scan_em_title(src, p)
        {
            push_tok(&mut kinds, &mut starts, &mut ends, EmToken::Title, p, end);
            p = end;
            continue;
        }
        // Hidden tokens (EM_WS, EM_YAML, EM_DIRECTIVE, EM_SINGLE_LINE_COMMENT, EM_ML_COMMENT, EM_SL_COMMENT).
        // Note: EM_WS is tried BEFORE EM_DIRECTIVE / EM_SINGLE_LINE_COMMENT just like upstream EVENTMODELING_TOKENS!
        if let Some(end) = scan_em_ws(src, p) {
            p = end;
            continue;
        }
        if b == b'-'
            && let Some(end) = scan_yaml_block(src, p, &mut yaml_dead)
        {
            p = end;
            continue;
        }
        if b == b'%' {
            if let Some(end) = scan_directive(src, p, &mut dir_dead) {
                p = end;
                continue;
            }
            if let Some(end) = scan_single_line_comment(src, p) {
                p = end;
                continue;
            }
        }
        if b == b'/' {
            if let Some(end) = scan_ml_comment(src, p, &mut ml_dead) {
                p = end;
                continue;
            }
            if let Some(end) = scan_sl_comment(src, p) {
                p = end;
                continue;
            }
        }
        return Err(syntax_error(DiagramType::EventModeling, src, p, "", true, origin));
    }

    kinds.push(None);
    starts.push(n);
    ends.push(n);
    Ok(TokenStream { kinds, starts, ends, src })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameKind {
    TimeFrame,
    ResetFrame,
}

#[derive(Debug, Clone)]
pub struct EmFrameAst {
    pub kind: FrameKind,
    pub name: String,
    pub model_entity_type: String,
    pub entity_identifier: String,
    pub source_frames: Vec<String>,
    pub data_reference: Option<String>,
    pub data_type: Option<String>,
    pub data_inline_value: Option<String>,
    pub offset: usize,
}

#[derive(Debug, Clone)]
pub struct EmDataEntityAst {
    pub name: String,
    pub data_type: Option<String>,
    pub data_block_value: String,
}

#[derive(Debug, Clone)]
pub struct EmNoteEntityAst {
    pub source_frame: String,
    pub data_type: Option<String>,
    pub data_block_value: String,
}

#[derive(Debug, Clone)]
pub struct EmGwtAst {
    pub source_frame: String,
    pub given_statements: Vec<String>,
    pub when_statements: Vec<String>,
    pub then_statements: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct EventModelAst {
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    pub model_entities: Vec<String>,
    pub frames: Vec<EmFrameAst>,
    pub data_entities: Vec<EmDataEntityAst>,
    pub note_entities: Vec<EmNoteEntityAst>,
    pub gwt_entities: Vec<EmGwtAst>,
}

pub fn parse_event_model(src: &str, origin: Option<&SourceMap<'_>>) -> Result<EventModelAst, PeleError> {
    let tokens = tokenize_eventmodeling(src, origin)?;
    let mut r = TokenReader::new(tokens, DiagramType::EventModeling, origin, EmToken::name);
    let mut ast = EventModelAst {
        title: None,
        acc_title: None,
        acc_descr: None,
        model_entities: Vec::new(),
        frames: Vec::new(),
        data_entities: Vec::new(),
        note_entities: Vec::new(),
        gwt_entities: Vec::new(),
    };

    let qualified_name = |r: &mut TokenReader<'_, EmToken>| -> Result<String, PeleError> {
        let mut name = r.expect(EmToken::Id)?.to_string();
        while r.accept(EmToken::Dot) {
            name.push('.');
            name.push_str(r.expect(EmToken::Id)?);
        }
        Ok(name)
    };

    let parse_entity_type = |r: &mut TokenReader<'_, EmToken>| -> Result<String, PeleError> {
        if r.kind().is_some_and(EmToken::is_entity_type) {
            Ok(r.take().to_string())
        } else {
            Err(r.fail("an entity type"))
        }
    };

    let parse_data_type = |r: &mut TokenReader<'_, EmToken>| -> Result<Option<String>, PeleError> {
        if !r.accept(EmToken::Tick) {
            return Ok(None);
        }
        let dt = if r.kind().is_some_and(EmToken::is_data_type) {
            r.take().to_string()
        } else {
            return Err(r.fail("a data type"));
        };
        r.expect(EmToken::Tick)?;
        Ok(Some(dt))
    };

    let parse_statements = |r: &mut TokenReader<'_, EmToken>| -> Result<Vec<String>, PeleError> {
        let mut out = Vec::new();
        loop {
            parse_entity_type(r)?;
            out.push(r.expect(EmToken::Id)?.to_string());
            if !r.kind().is_some_and(EmToken::is_entity_type) {
                break;
            }
        }
        Ok(out)
    };

    r.expect(EmToken::Eventmodeling)?;
    while let Some(kind) = r.kind() {
        if kind == EmToken::AccDescr {
            ast.acc_descr = Some(r.take().to_string());
        } else if kind == EmToken::AccTitle {
            ast.acc_title = Some(r.take().to_string());
        } else if kind == EmToken::Title {
            ast.title = Some(r.take().to_string());
        } else if kind == EmToken::Entity {
            r.i += 1;
            ast.model_entities.push(qualified_name(&mut r)?);
        } else if kind.is_time_frame() || kind.is_reset_frame() {
            let frame_kind = if kind.is_time_frame() { FrameKind::TimeFrame } else { FrameKind::ResetFrame };
            let offset = r.tokens.starts[r.i];
            r.i += 1;
            let name = r.expect(EmToken::FrameId)?.to_string();
            let model_entity_type = parse_entity_type(&mut r)?;
            let entity_identifier = qualified_name(&mut r)?;
            let mut source_frames = Vec::new();
            while r.accept(EmToken::Arrow) {
                source_frames.push(r.expect(EmToken::FrameId)?.to_string());
            }
            let data_reference = if r.accept(EmToken::Open) {
                let id = r.expect(EmToken::Id)?.to_string();
                r.expect(EmToken::Close)?;
                Some(id)
            } else {
                None
            };
            let (data_type, data_inline_value) = if matches!(r.kind(), Some(EmToken::Tick | EmToken::Inline)) {
                let dt = parse_data_type(&mut r)?;
                let val = r.expect(EmToken::Inline)?.to_string();
                (dt, Some(val))
            } else {
                (None, None)
            };
            ast.frames.push(EmFrameAst {
                kind: frame_kind,
                name,
                model_entity_type,
                entity_identifier,
                source_frames,
                data_reference,
                data_type,
                data_inline_value,
                offset,
            });
        } else if kind == EmToken::Data {
            r.i += 1;
            let name = r.expect(EmToken::Id)?.to_string();
            let data_type = parse_data_type(&mut r)?;
            let data_block_value = r.expect(EmToken::Block)?.to_string();
            ast.data_entities.push(EmDataEntityAst {
                name,
                data_type,
                data_block_value,
            });
        } else if kind == EmToken::Note {
            r.i += 1;
            let source_frame = r.expect(EmToken::FrameId)?.to_string();
            let data_type = parse_data_type(&mut r)?;
            let data_block_value = r.expect(EmToken::Block)?.to_string();
            ast.note_entities.push(EmNoteEntityAst {
                source_frame,
                data_type,
                data_block_value,
            });
        } else if kind == EmToken::Gwt {
            r.i += 1;
            let source_frame = r.expect(EmToken::FrameId)?.to_string();
            r.expect(EmToken::Given)?;
            let given_statements = parse_statements(&mut r)?;
            let when_statements = if r.accept(EmToken::When) { parse_statements(&mut r)? } else { Vec::new() };
            r.expect(EmToken::Then)?;
            let then_statements = parse_statements(&mut r)?;
            ast.gwt_entities.push(EmGwtAst {
                source_frame,
                given_statements,
                when_statements,
                then_statements,
            });
        } else {
            return Err(r.fail("a frame, an entity, a data block, a note, or a specification"));
        }
    }
    Ok(ast)
}
