use crate::detect::DiagramType;
use crate::diagram::common::{
    TokenReader, TokenStream, acc_descr_value, acc_title_value, scan_acc_descr, scan_acc_title, scan_directive, scan_newline, scan_single_line_comment,
    scan_string, scan_title, scan_whitespace, scan_yaml_block, string_value, title_value,
};
use crate::error::{PeleError, SourceMap, syntax_error};
use crate::util::chars::{is_digit, is_space, is_word};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WardleyToken {
    LBracket,
    Comma,
    RBracket,
    At,
    Slash,
    LParen,
    RParen,
    Minus,
    LBrace,
    RBrace,
    Number,
    Arrow,
    LinkPort,
    LinkArrow,
    LinkLabel,
    Strategy,
    Wardley,
    Size,
    Evolution,
    Anchor,
    Component,
    Label,
    Inertia,
    Evolve,
    Pipeline,
    Note,
    Annotations,
    Annotation,
    Accelerator,
    Deaccelerator,
    Name,
    AccDescr,
    AccTitle,
    Title,
    Int,
    String,
    Id,
    Newline,
}

fn token_name(k: WardleyToken) -> &'static str {
    match k {
        WardleyToken::LBracket => "[",
        WardleyToken::Comma => ",",
        WardleyToken::RBracket => "]",
        WardleyToken::At => "@",
        WardleyToken::Slash => "/",
        WardleyToken::LParen => "(",
        WardleyToken::RParen => ")",
        WardleyToken::Minus => "-",
        WardleyToken::LBrace => "{",
        WardleyToken::RBrace => "}",
        WardleyToken::Number => "WARDLEY_NUMBER",
        WardleyToken::Arrow => "ARROW",
        WardleyToken::LinkPort => "LINK_PORT",
        WardleyToken::LinkArrow => "LINK_ARROW",
        WardleyToken::LinkLabel => "LINK_LABEL",
        WardleyToken::Strategy => "STRATEGY",
        WardleyToken::Wardley => "KW_WARDLEY",
        WardleyToken::Size => "KW_SIZE",
        WardleyToken::Evolution => "KW_EVOLUTION",
        WardleyToken::Anchor => "KW_ANCHOR",
        WardleyToken::Component => "KW_COMPONENT",
        WardleyToken::Label => "KW_LABEL",
        WardleyToken::Inertia => "KW_INERTIA",
        WardleyToken::Evolve => "KW_EVOLVE",
        WardleyToken::Pipeline => "KW_PIPELINE",
        WardleyToken::Note => "KW_NOTE",
        WardleyToken::Annotations => "KW_ANNOTATIONS",
        WardleyToken::Annotation => "KW_ANNOTATION",
        WardleyToken::Accelerator => "KW_ACCELERATOR",
        WardleyToken::Deaccelerator => "KW_DEACCELERATOR",
        WardleyToken::Name => "NAME_WITH_SPACES",
        WardleyToken::AccDescr => "ACC_DESCR",
        WardleyToken::AccTitle => "ACC_TITLE",
        WardleyToken::Title => "TITLE",
        WardleyToken::Int => "INT",
        WardleyToken::String => "STRING",
        WardleyToken::Id => "ID",
        WardleyToken::Newline => "NEWLINE",
    }
}

struct DigitRunCache {
    from: usize,
    end: usize,
}

impl DigitRunCache {
    fn new() -> Self {
        Self { from: 0, end: 0 }
    }

    fn run_end(&mut self, bytes: &[u8], p: usize) -> usize {
        if p < self.from || p >= self.end {
            self.from = p;
            let mut e = p;
            while e < bytes.len() && is_digit(bytes[e] as u32) {
                e += 1;
            }
            self.end = e;
        }
        self.end
    }

    fn scan_wardley_number(&mut self, bytes: &[u8], p: usize) -> Option<usize> {
        let end = self.run_end(bytes, p);
        if end == p || bytes.get(end) != Some(&b'.') {
            return None;
        }
        let mut stop = end + 1;
        while stop < bytes.len() && is_digit(bytes[stop] as u32) {
            stop += 1;
        }
        if stop > end + 1 { Some(stop) } else { None }
    }

    fn scan_int(&mut self, bytes: &[u8], p: usize) -> Option<usize> {
        let first = *bytes.get(p)?;
        if first == b'0' {
            return Some(p + 1);
        }
        if !first.is_ascii_digit() {
            return None;
        }
        let end = self.run_end(bytes, p);
        if bytes.get(end) != Some(&b'.') {
            Some(end)
        } else if end - 1 > p {
            Some(end - 1)
        } else {
            None
        }
    }
}

fn scan_link_arrow(src: &str, p: usize, last_single_quote: &mut Option<Option<usize>>) -> Option<usize> {
    let rest = &src[p..];
    if rest.starts_with("-->") {
        return Some(p + 3);
    }
    if rest.starts_with("-.->") {
        return Some(p + 4);
    }
    if rest.starts_with('>') {
        return Some(p + 1);
    }
    if rest.starts_with("+'") {
        let last_q = *last_single_quote.get_or_insert_with(|| src.rfind('\''));
        if last_q.is_none_or(|lq| p + 2 > lq) {
            return None;
        }
        let rel = src[p + 2..].find('\'')?;
        let after = p + 2 + rel + 1;
        let tail = &src[after..];
        if tail.starts_with("<>") {
            return Some(after + 2);
        }
        if tail.starts_with('<') || tail.starts_with('>') {
            return Some(after + 1);
        }
    }
    None
}

fn scan_name_word_tail(bytes: &[u8], mut i: usize) -> usize {
    let n = bytes.len();
    while i < n {
        let b = bytes[i];
        if b.is_ascii_alphanumeric() || matches!(b, b'_' | b'(' | b')' | b'&') || (b == b'-' && bytes.get(i + 1) != Some(&b'>')) {
            i += 1;
        } else {
            break;
        }
    }
    i
}

fn scan_name_with_spaces(src: &str, p: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    if !bytes.get(p).is_some_and(u8::is_ascii_alphabetic) {
        return None;
    }
    let rest = &src[p..];
    if rest.starts_with("accTitle") || rest.starts_with("accDescr") {
        return None;
    }
    if rest.starts_with("title")
        && let Some(ch) = rest[5..].chars().next()
        && is_space(ch as u32)
    {
        return None;
    }
    let mut i = scan_name_word_tail(bytes, p + 1);
    loop {
        let commit = i;
        let mut j = i;
        while j < bytes.len() && matches!(bytes[j], b' ' | b'\t') {
            j += 1;
        }
        if j > commit && bytes.get(j).is_some_and(|&b| b.is_ascii_alphabetic() || b == b'(') {
            i = scan_name_word_tail(bytes, j + 1);
        } else {
            return Some(commit);
        }
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

fn tokenize_wardley<'a>(src: &'a str, origin: Option<&SourceMap<'_>>) -> Result<TokenStream<'a, WardleyToken>, PeleError> {
    let mut kinds: Vec<Option<WardleyToken>> = Vec::new();
    let mut starts: Vec<usize> = Vec::new();
    let mut ends: Vec<usize> = Vec::new();
    let mut digits = DigitRunCache::new();
    let mut last_single_quote: Option<Option<usize>> = None;
    let mut unclosed_descr = false;
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
        match b {
            b'[' => {
                push_tok!(WardleyToken::LBracket, p + 1);
                continue;
            }
            b',' => {
                push_tok!(WardleyToken::Comma, p + 1);
                continue;
            }
            b']' => {
                push_tok!(WardleyToken::RBracket, p + 1);
                continue;
            }
            b'@' => {
                push_tok!(WardleyToken::At, p + 1);
                continue;
            }
            b'/' => {
                push_tok!(WardleyToken::Slash, p + 1);
                continue;
            }
            b'(' => {
                push_tok!(WardleyToken::LParen, p + 1);
                continue;
            }
            b')' => {
                push_tok!(WardleyToken::RParen, p + 1);
                continue;
            }
            b'-' => {
                // Minus with LONGER_ALT = [ARROW, LINK_ARROW, YAML].
                if src[p..].starts_with("->") {
                    push_tok!(WardleyToken::Arrow, p + 2);
                } else if let Some(end) = scan_link_arrow(src, p, &mut last_single_quote)
                    && end > p + 1
                {
                    push_tok!(WardleyToken::LinkArrow, end);
                } else if let Some(end) = scan_yaml_block(src, p, &mut yaml_dead)
                    && end > p + 1
                {
                    p = end;
                } else {
                    push_tok!(WardleyToken::Minus, p + 1);
                }
                continue;
            }
            b'{' => {
                push_tok!(WardleyToken::LBrace, p + 1);
                continue;
            }
            b'}' => {
                push_tok!(WardleyToken::RBrace, p + 1);
                continue;
            }
            _ => {}
        }

        if b.is_ascii_digit()
            && let Some(end) = digits.scan_wardley_number(bytes, p)
        {
            push_tok!(WardleyToken::Number, end);
            continue;
        }
        if b == b'+' {
            let rest = &src[p..];
            if rest.starts_with("+<>") {
                push_tok!(WardleyToken::LinkPort, p + 3);
                continue;
            }
            if rest.starts_with("+>") || rest.starts_with("+<") {
                push_tok!(WardleyToken::LinkPort, p + 2);
                continue;
            }
            if let Some(end) = scan_link_arrow(src, p, &mut last_single_quote) {
                push_tok!(WardleyToken::LinkArrow, end);
                continue;
            }
        }
        if b == b'>' {
            push_tok!(WardleyToken::LinkArrow, p + 1);
            continue;
        }
        if b == b';' {
            let mut end = p + 1;
            while end < n && !matches!(bytes[end], b'\n' | b'\r') {
                end += 1;
            }
            if end > p + 1 {
                push_tok!(WardleyToken::LinkLabel, end);
                continue;
            }
        }

        // Exact upstream STRATEGY & keyword priority before NAME_WITH_SPACES.
        let rest = &src[p..];
        let fixed: Option<(WardleyToken, usize)> = match b {
            b'b' if rest.starts_with("build") => Some((WardleyToken::Strategy, p + 5)),
            b'b' if rest.starts_with("buy") => Some((WardleyToken::Strategy, p + 3)),
            b'o' if rest.starts_with("outsource") => Some((WardleyToken::Strategy, p + 9)),
            b'm' if rest.starts_with("market") => Some((WardleyToken::Strategy, p + 6)),
            b'w' if rest.starts_with("wardley-beta") => Some((WardleyToken::Wardley, p + 12)),
            b's' if rest.starts_with("size") => Some((WardleyToken::Size, p + 4)),
            b'e' if rest.starts_with("evolution") => Some((WardleyToken::Evolution, p + 9)),
            b'e' if rest.starts_with("evolve") => Some((WardleyToken::Evolve, p + 6)),
            b'a' if rest.starts_with("anchor") => Some((WardleyToken::Anchor, p + 6)),
            b'a' if rest.starts_with("annotations") => Some((WardleyToken::Annotations, p + 11)),
            b'a' if rest.starts_with("annotation") => Some((WardleyToken::Annotation, p + 10)),
            b'a' if rest.starts_with("accelerator") => Some((WardleyToken::Accelerator, p + 11)),
            b'c' if rest.starts_with("component") => Some((WardleyToken::Component, p + 9)),
            b'l' if rest.starts_with("label") => Some((WardleyToken::Label, p + 5)),
            b'i' if rest.starts_with("inertia") => Some((WardleyToken::Inertia, p + 7)),
            b'p' if rest.starts_with("pipeline") => Some((WardleyToken::Pipeline, p + 8)),
            b'n' if rest.starts_with("note") => Some((WardleyToken::Note, p + 4)),
            b'd' if rest.starts_with("deaccelerator") => Some((WardleyToken::Deaccelerator, p + 13)),
            _ => None,
        };
        if let Some((tok, end)) = fixed {
            push_tok!(tok, end);
            continue;
        }

        if b.is_ascii_alphabetic()
            && let Some(end) = scan_name_with_spaces(src, p)
        {
            push_tok!(WardleyToken::Name, end);
            continue;
        }
        if matches!(b, b' ' | b'\t')
            && let Some(end) = scan_whitespace(src, p)
        {
            p = end;
            continue;
        }
        if b == b'a' {
            if let Some(end) = scan_acc_descr(src, p, &mut unclosed_descr) {
                push_tok!(WardleyToken::AccDescr, end);
                continue;
            }
            if let Some(end) = scan_acc_title(src, p) {
                push_tok!(WardleyToken::AccTitle, end);
                continue;
            }
        }
        if b == b't'
            && let Some(end) = scan_title(src, p)
        {
            push_tok!(WardleyToken::Title, end);
            continue;
        }
        if b.is_ascii_digit()
            && let Some(end) = digits.scan_int(bytes, p)
        {
            push_tok!(WardleyToken::Int, end);
            continue;
        }
        if matches!(b, b'"' | b'\'')
            && let Some(end) = scan_string(src, p)
        {
            push_tok!(WardleyToken::String, end);
            continue;
        }
        if is_word(b as u32)
            && let Some(end) = scan_id(src, p)
        {
            push_tok!(WardleyToken::Id, end);
            continue;
        }
        if matches!(b, b'\r' | b'\n')
            && let Some(end) = scan_newline(src, p)
        {
            push_tok!(WardleyToken::Newline, end);
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

        return Err(syntax_error(DiagramType::Wardley, src, p, "", true, origin));
    }

    kinds.push(None);
    starts.push(n);
    ends.push(n);
    Ok(TokenStream { kinds, starts, ends, src })
}

#[derive(Debug, Clone)]
pub struct LabelAst {
    pub neg_x: bool,
    pub offset_x: f64,
    pub neg_y: bool,
    pub offset_y: f64,
}

#[derive(Debug, Clone)]
pub struct StageAst {
    pub name: String,
    pub boundary: Option<f64>,
    pub second_name: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ComponentAst {
    pub name: String,
    pub visibility: f64,
    pub evolution: f64,
    pub label: Option<LabelAst>,
    pub decorator: Option<String>,
    pub inertia: bool,
}

#[derive(Debug, Clone)]
pub struct PipelineComponentAst {
    pub name: String,
    pub evolution: f64,
    pub label: Option<LabelAst>,
}

#[derive(Debug, Clone)]
pub struct LinkAst {
    pub from: String,
    pub from_port: Option<String>,
    pub arrow: Option<String>,
    pub to: String,
    pub to_port: Option<String>,
    pub link_label: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SizeAst {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone)]
pub struct EvolutionAst {
    pub stages: Vec<StageAst>,
}

#[derive(Debug, Clone)]
pub struct AnchorAst {
    pub name: String,
    pub visibility: f64,
    pub evolution: f64,
}

#[derive(Debug, Clone)]
pub struct EvolveAst {
    pub component: String,
    pub target: f64,
}

#[derive(Debug, Clone)]
pub struct PipelineAst {
    pub parent: String,
    pub components: Vec<PipelineComponentAst>,
}

#[derive(Debug, Clone)]
pub struct NoteAst {
    pub text: String,
    pub visibility: f64,
    pub evolution: f64,
}

#[derive(Debug, Clone)]
pub struct AnnotationsBoxAst {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone)]
pub struct AnnotationAst {
    pub number: f64,
    pub x: f64,
    pub y: f64,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct PlacedForceAst {
    pub name: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Default)]
pub struct WardleyAst {
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    pub size: Option<SizeAst>,
    pub evolution: Option<EvolutionAst>,
    pub anchors: Vec<AnchorAst>,
    pub components: Vec<ComponentAst>,
    pub links: Vec<LinkAst>,
    pub evolves: Vec<EvolveAst>,
    pub pipelines: Vec<PipelineAst>,
    pub notes: Vec<NoteAst>,
    pub annotations: Vec<AnnotationsBoxAst>,
    pub annotation: Vec<AnnotationAst>,
    pub accelerators: Vec<PlacedForceAst>,
    pub deaccelerators: Vec<PlacedForceAst>,
}

fn is_name(k: Option<WardleyToken>) -> bool {
    matches!(k, Some(WardleyToken::String | WardleyToken::Id | WardleyToken::Name))
}

fn read_name(r: &mut TokenReader<'_, WardleyToken>) -> Result<String, PeleError> {
    if r.kind() == Some(WardleyToken::String) {
        Ok(string_value(r.take()))
    } else if matches!(r.kind(), Some(WardleyToken::Id | WardleyToken::Name)) {
        Ok(r.take().to_string())
    } else {
        Err(r.fail("a name"))
    }
}

fn read_number(r: &mut TokenReader<'_, WardleyToken>) -> Result<f64, PeleError> {
    Ok(r.expect(WardleyToken::Number)?.parse().unwrap_or(f64::INFINITY))
}

fn read_int(r: &mut TokenReader<'_, WardleyToken>) -> Result<f64, PeleError> {
    Ok(r.expect(WardleyToken::Int)?.parse().unwrap_or(f64::INFINITY))
}

fn read_coordinate(r: &mut TokenReader<'_, WardleyToken>) -> Result<f64, PeleError> {
    if r.kind() == Some(WardleyToken::Number) {
        Ok(r.take().parse().unwrap_or(f64::INFINITY))
    } else {
        read_int(r)
    }
}

fn end_of_line(r: &mut TokenReader<'_, WardleyToken>) -> Result<(), PeleError> {
    if r.kind().is_none() {
        return Ok(());
    }
    if r.kind() != Some(WardleyToken::Newline) {
        return Err(r.fail("a line break or the end of input"));
    }
    while r.kind() == Some(WardleyToken::Newline) {
        r.i += 1;
    }
    Ok(())
}

fn read_pair<F>(r: &mut TokenReader<'_, WardleyToken>, read: F) -> Result<(f64, f64), PeleError>
where
    F: Fn(&mut TokenReader<'_, WardleyToken>) -> Result<f64, PeleError>,
{
    r.expect(WardleyToken::LBracket)?;
    let first = read(r)?;
    r.expect(WardleyToken::Comma)?;
    let second = read(r)?;
    r.expect(WardleyToken::RBracket)?;
    Ok((first, second))
}

fn read_label(r: &mut TokenReader<'_, WardleyToken>) -> Result<LabelAst, PeleError> {
    r.expect(WardleyToken::Label)?;
    r.expect(WardleyToken::LBracket)?;
    let neg_x = r.accept(WardleyToken::Minus);
    let offset_x = read_int(r)?;
    r.expect(WardleyToken::Comma)?;
    let neg_y = r.accept(WardleyToken::Minus);
    let offset_y = read_int(r)?;
    r.expect(WardleyToken::RBracket)?;
    Ok(LabelAst {
        neg_x,
        offset_x,
        neg_y,
        offset_y,
    })
}

fn read_stage(r: &mut TokenReader<'_, WardleyToken>) -> Result<StageAst, PeleError> {
    let name = read_name(r)?;
    let boundary = if r.accept(WardleyToken::At) { Some(read_number(r)?) } else { None };
    let second_name = if r.accept(WardleyToken::Slash) { Some(read_name(r)?) } else { None };
    Ok(StageAst { name, boundary, second_name })
}

pub fn parse_wardley(src: &str, origin: Option<&SourceMap<'_>>) -> Result<WardleyAst, PeleError> {
    let tokens = tokenize_wardley(src, origin)?;
    let mut r = TokenReader::new(tokens, DiagramType::Wardley, origin, token_name);
    let mut ast = WardleyAst::default();

    while r.kind() == Some(WardleyToken::Newline) {
        r.i += 1;
    }
    r.expect(WardleyToken::Wardley)?;

    while let Some(k) = r.kind() {
        match k {
            WardleyToken::Newline => {
                r.i += 1;
            }
            WardleyToken::AccDescr => {
                ast.acc_descr = Some(acc_descr_value(r.take()));
                end_of_line(&mut r)?;
            }
            WardleyToken::AccTitle => {
                ast.acc_title = Some(acc_title_value(r.take()));
                end_of_line(&mut r)?;
            }
            WardleyToken::Title => {
                ast.title = Some(title_value(r.take()));
                end_of_line(&mut r)?;
            }
            WardleyToken::Size => {
                r.i += 1;
                let (width, height) = read_pair(&mut r, read_int)?;
                end_of_line(&mut r)?;
                ast.size = Some(SizeAst { width, height });
            }
            WardleyToken::Evolution => {
                r.i += 1;
                let mut stages = vec![read_stage(&mut r)?];
                r.expect(WardleyToken::Arrow)?;
                stages.push(read_stage(&mut r)?);
                while r.accept(WardleyToken::Arrow) {
                    stages.push(read_stage(&mut r)?);
                }
                end_of_line(&mut r)?;
                ast.evolution = Some(EvolutionAst { stages });
            }
            WardleyToken::Anchor => {
                r.i += 1;
                let name = read_name(&mut r)?;
                let (visibility, evolution) = read_pair(&mut r, read_number)?;
                end_of_line(&mut r)?;
                ast.anchors.push(AnchorAst { name, visibility, evolution });
            }
            WardleyToken::Component => {
                r.i += 1;
                let name = read_name(&mut r)?;
                let (visibility, evolution) = read_pair(&mut r, read_number)?;
                let label = if r.kind() == Some(WardleyToken::Label) {
                    Some(read_label(&mut r)?)
                } else {
                    None
                };
                let decorator = if r.kind() == Some(WardleyToken::LParen) && r.tokens.kinds.get(r.i + 1) == Some(&Some(WardleyToken::Strategy)) {
                    r.i += 1;
                    let s = r.take().to_string();
                    r.expect(WardleyToken::RParen)?;
                    Some(s)
                } else {
                    None
                };
                let inertia = if r.accept(WardleyToken::Inertia) {
                    true
                } else if r.accept(WardleyToken::LParen) {
                    r.expect(WardleyToken::Inertia)?;
                    r.expect(WardleyToken::RParen)?;
                    true
                } else {
                    false
                };
                end_of_line(&mut r)?;
                ast.components.push(ComponentAst {
                    name,
                    visibility,
                    evolution,
                    label,
                    decorator,
                    inertia,
                });
            }
            WardleyToken::Evolve => {
                r.i += 1;
                let component = read_name(&mut r)?;
                let target = read_number(&mut r)?;
                end_of_line(&mut r)?;
                ast.evolves.push(EvolveAst { component, target });
            }
            WardleyToken::Pipeline => {
                r.i += 1;
                let parent = read_name(&mut r)?;
                r.expect(WardleyToken::LBrace)?;
                r.expect(WardleyToken::Newline)?;
                while r.kind() == Some(WardleyToken::Newline) {
                    r.i += 1;
                }
                let mut components = Vec::new();
                loop {
                    r.expect(WardleyToken::Component)?;
                    let name = read_name(&mut r)?;
                    r.expect(WardleyToken::LBracket)?;
                    let evolution = read_number(&mut r)?;
                    r.expect(WardleyToken::RBracket)?;
                    let label = if r.kind() == Some(WardleyToken::Label) {
                        Some(read_label(&mut r)?)
                    } else {
                        None
                    };
                    end_of_line(&mut r)?;
                    components.push(PipelineComponentAst { name, evolution, label });
                    if r.kind() != Some(WardleyToken::Component) {
                        break;
                    }
                }
                r.expect(WardleyToken::RBrace)?;
                end_of_line(&mut r)?;
                ast.pipelines.push(PipelineAst { parent, components });
            }
            WardleyToken::Note => {
                r.i += 1;
                let text = string_value(r.expect(WardleyToken::String)?);
                let (visibility, evolution) = read_pair(&mut r, read_number)?;
                end_of_line(&mut r)?;
                ast.notes.push(NoteAst { text, visibility, evolution });
            }
            WardleyToken::Annotations => {
                r.i += 1;
                let (x, y) = read_pair(&mut r, read_coordinate)?;
                end_of_line(&mut r)?;
                ast.annotations.push(AnnotationsBoxAst { x, y });
            }
            WardleyToken::Annotation => {
                r.i += 1;
                let number = read_int(&mut r)?;
                r.expect(WardleyToken::Comma)?;
                let (x, y) = read_pair(&mut r, read_coordinate)?;
                let text = string_value(r.expect(WardleyToken::String)?);
                end_of_line(&mut r)?;
                ast.annotation.push(AnnotationAst { number, x, y, text });
            }
            WardleyToken::Accelerator | WardleyToken::Deaccelerator => {
                let slow = k == WardleyToken::Deaccelerator;
                r.i += 1;
                let name = read_name(&mut r)?;
                let (x, y) = read_pair(&mut r, read_number)?;
                end_of_line(&mut r)?;
                let force = PlacedForceAst { name, x, y };
                if slow {
                    ast.deaccelerators.push(force);
                } else {
                    ast.accelerators.push(force);
                }
            }
            WardleyToken::String | WardleyToken::Id | WardleyToken::Name => {
                let from = read_name(&mut r)?;
                let from_port = if r.kind() == Some(WardleyToken::LinkPort) {
                    Some(r.take().to_string())
                } else {
                    None
                };
                let arrow = if matches!(r.kind(), Some(WardleyToken::LinkArrow | WardleyToken::Arrow)) {
                    Some(r.take().to_string())
                } else {
                    None
                };
                let to = read_name(&mut r)?;
                let to_port = if r.kind() == Some(WardleyToken::LinkPort) {
                    Some(r.take().to_string())
                } else {
                    None
                };
                let link_label = if r.kind() == Some(WardleyToken::LinkLabel) {
                    let raw = r.take();
                    Some(raw[1..].trim().to_string())
                } else {
                    None
                };
                end_of_line(&mut r)?;
                ast.links.push(LinkAst {
                    from,
                    from_port,
                    arrow,
                    to,
                    to_port,
                    link_label,
                });
            }
            WardleyToken::LBracket
            | WardleyToken::Comma
            | WardleyToken::RBracket
            | WardleyToken::At
            | WardleyToken::Slash
            | WardleyToken::LParen
            | WardleyToken::RParen
            | WardleyToken::Minus
            | WardleyToken::LBrace
            | WardleyToken::RBrace
            | WardleyToken::Number
            | WardleyToken::Arrow
            | WardleyToken::LinkPort
            | WardleyToken::LinkArrow
            | WardleyToken::LinkLabel
            | WardleyToken::Strategy
            | WardleyToken::Wardley
            | WardleyToken::Label
            | WardleyToken::Inertia
            | WardleyToken::Int => {
                debug_assert!(!is_name(Some(k)));
                return Err(r.fail("a statement"));
            }
        }
    }
    Ok(ast)
}
