use crate::detect::DiagramType;
use crate::diagram::common::{
    TokenReader, TokenStream, acc_descr_value, acc_title_value, scan_acc_descr, scan_acc_title, scan_directive, scan_newline, scan_single_line_comment,
    scan_string, scan_whitespace, scan_yaml_block, string_value, title_value,
};
use crate::error::{PeleError, SourceMap, syntax_error};
use crate::util::chars::is_word;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchToken {
    Header,
    Junction,
    Service,
    Column,
    Group,
    Align,
    Row,
    Dashes,
    In,
    Colon,
    Dash,
    Direction,
    ArrowGroup,
    Into,
    AccDescr,
    AccTitle,
    Title,
    StringLit,
    Id,
    Newline,
    Icon,
    Label,
}

impl ArchToken {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Header => "architecture-beta",
            Self::Junction => "junction",
            Self::Service => "service",
            Self::Column => "column",
            Self::Group => "group",
            Self::Align => "align",
            Self::Row => "row",
            Self::Dashes => "--",
            Self::In => "in",
            Self::Colon => ":",
            Self::Dash => "-",
            Self::Direction => "ARROW_DIRECTION",
            Self::ArrowGroup => "ARROW_GROUP",
            Self::Into => "ARROW_INTO",
            Self::AccDescr => "ACC_DESCR",
            Self::AccTitle => "ACC_TITLE",
            Self::Title => "TITLE",
            Self::StringLit => "STRING",
            Self::Id => "ID",
            Self::Newline => "NEWLINE",
            Self::Icon => "ARCH_ICON",
            Self::Label => "ARCH_TITLE",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    L,
    R,
    T,
    B,
}

impl Side {
    pub fn from_token(text: &str) -> Option<Self> {
        match text {
            "L" => Some(Self::L),
            "R" => Some(Self::R),
            "T" => Some(Self::T),
            "B" => Some(Self::B),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::L => "L",
            Self::R => "R",
            Self::T => "T",
            Self::B => "B",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlignDirection {
    Row,
    Column,
}

impl AlignDirection {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Row => "row",
            Self::Column => "column",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupAst {
    pub id: String,
    pub icon: Option<String>,
    pub title: Option<String>,
    pub in_group: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceAst {
    pub id: String,
    pub icon: Option<String>,
    pub icon_text: Option<String>,
    pub title: Option<String>,
    pub in_group: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JunctionAst {
    pub id: String,
    pub in_group: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EdgeAst {
    pub lhs_id: String,
    pub lhs_group: bool,
    pub lhs_dir: Side,
    pub lhs_into: bool,
    pub title: Option<String>,
    pub rhs_into: bool,
    pub rhs_dir: Side,
    pub rhs_id: String,
    pub rhs_group: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlignmentAst {
    pub direction: AlignDirection,
    pub members: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ArchitectureAst {
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    pub groups: Vec<GroupAst>,
    pub services: Vec<ServiceAst>,
    pub junctions: Vec<JunctionAst>,
    pub edges: Vec<EdgeAst>,
    pub alignments: Vec<AlignmentAst>,
}

fn scan_id(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    if at >= bytes.len() || !is_word(bytes[at] as u32) {
        return None;
    }
    let mut q = at + 1;
    let mut last_word = at;
    while q < bytes.len() {
        let b = bytes[q];
        if is_word(b as u32) {
            last_word = q;
            q += 1;
        } else if b == b'-' {
            q += 1;
        } else {
            break;
        }
    }
    Some(last_word + 1)
}

fn scan_title_before_id(src: &str, at: usize) -> Option<usize> {
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
    // Negative lookahead `(?![-\w]*\w)` so `title-foo` or `title1` stays an ID.
    let mut r = p;
    while r < bytes.len() && bytes[r] == b'-' {
        r += 1;
    }
    if r < bytes.len() && is_word(bytes[r] as u32) {
        return None;
    }
    Some(p)
}

fn scan_arch_icon(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    if bytes.get(at) != Some(&b'(') {
        return None;
    }
    let mut p = at + 1;
    while p < bytes.len() {
        let b = bytes[p];
        if is_word(b as u32) || b == b'-' || b == b':' {
            p += 1;
        } else {
            break;
        }
    }
    if p > at + 1 && bytes.get(p) == Some(&b')') { Some(p + 1) } else { None }
}

fn scan_arch_title(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    if bytes.get(at) != Some(&b'[') {
        return None;
    }
    if matches!(bytes.get(at + 1), Some(b'"' | b'\''))
        && let Some(str_end) = scan_string(src, at + 1)
        && bytes.get(str_end) == Some(&b']')
    {
        return Some(str_end + 1);
    }
    let mut p = at + 1;
    while p < bytes.len() {
        let b = bytes[p];
        if matches!(b, b'[' | b']' | b'\r' | b'\n') {
            break;
        }
        p += 1;
    }
    if p > at + 1 && bytes.get(p) == Some(&b']') { Some(p + 1) } else { None }
}

/// Mermaid's ArchitectureValueConverter for ARCH_TITLE.
fn label_value(text: &str) -> String {
    let mut result = text[1..text.len() - 1].trim().to_string();
    if result.len() >= 2 && ((result.starts_with('"') && result.ends_with('"')) || (result.starts_with('\'') && result.ends_with('\''))) {
        let inner = &result[1..result.len() - 1];
        result = inner.replace("\\\"", "\"").replace("\\'", "'");
    }
    result.trim().to_string()
}

fn tokenize<'a>(src: &'a str, origin: Option<&'a SourceMap<'a>>) -> Result<TokenStream<'a, ArchToken>, PeleError> {
    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut kinds: Vec<Option<ArchToken>> = Vec::new();
    let mut starts: Vec<usize> = Vec::new();
    let mut ends: Vec<usize> = Vec::new();
    let mut yaml_dead = false;
    let mut dir_dead = false;
    let mut acc_unclosed = false;

    const WORDS: [(&str, ArchToken); 8] = [
        ("architecture-beta", ArchToken::Header),
        ("junction", ArchToken::Junction),
        ("service", ArchToken::Service),
        ("column", ArchToken::Column),
        ("group", ArchToken::Group),
        ("align", ArchToken::Align),
        ("row", ArchToken::Row),
        ("in", ArchToken::In),
    ];

    let mut p = 0usize;
    while p < n {
        let b = bytes[p];
        let rest = &src[p..];

        // 1..7 + 9: keywords with LONGER_ALT = ID, ordered identically to ARCHITECTURE_TOKENS.
        // Note `--` sits between `row` and `in` (never overlaps words), `:` and `-` follow `in`.
        let mut word_match: Option<(ArchToken, usize)> = None;
        for &(kw, tok) in &WORDS[..7] {
            if rest.starts_with(kw) {
                word_match = Some((tok, p + kw.len()));
                break;
            }
        }
        if let Some((mut tok, mut end)) = word_match {
            if let Some(id_end) = scan_id(src, p)
                && id_end > end
            {
                tok = ArchToken::Id;
                end = id_end;
            }
            kinds.push(Some(tok));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }

        // 8: `--` with LONGER_ALT = YAML (hidden).
        if rest.starts_with("--") {
            if let Some(yaml_end) = scan_yaml_block(src, p, &mut yaml_dead)
                && yaml_end > p + 2
            {
                p = yaml_end;
                continue;
            }
            kinds.push(Some(ArchToken::Dashes));
            starts.push(p);
            ends.push(p + 2);
            p += 2;
            continue;
        }

        // 9: `in` with LONGER_ALT = ID.
        if rest.starts_with("in") {
            let mut tok = ArchToken::In;
            let mut end = p + 2;
            if let Some(id_end) = scan_id(src, p)
                && id_end > end
            {
                tok = ArchToken::Id;
                end = id_end;
            }
            kinds.push(Some(tok));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }

        // 10: `:`
        if b == b':' {
            kinds.push(Some(ArchToken::Colon));
            starts.push(p);
            ends.push(p + 1);
            p += 1;
            continue;
        }

        // 11: `-` with LONGER_ALT = YAML (hidden).
        if b == b'-' {
            if let Some(yaml_end) = scan_yaml_block(src, p, &mut yaml_dead)
                && yaml_end > p + 1
            {
                p = yaml_end;
                continue;
            }
            kinds.push(Some(ArchToken::Dash));
            starts.push(p);
            ends.push(p + 1);
            p += 1;
            continue;
        }

        // 12: ARROW_DIRECTION (L|R|T|B) — deliberately before ID with no longer alt.
        if matches!(b, b'L' | b'R' | b'T' | b'B') {
            kinds.push(Some(ArchToken::Direction));
            starts.push(p);
            ends.push(p + 1);
            p += 1;
            continue;
        }

        // 13: ARROW_GROUP ({group})
        if rest.starts_with("{group}") {
            kinds.push(Some(ArchToken::ArrowGroup));
            starts.push(p);
            ends.push(p + 7);
            p += 7;
            continue;
        }

        // 14: ARROW_INTO (<|>)
        if matches!(b, b'<' | b'>') {
            kinds.push(Some(ArchToken::Into));
            starts.push(p);
            ends.push(p + 1);
            p += 1;
            continue;
        }

        // 15..17: ACC_DESCR, ACC_TITLE, TITLE (may start with space/tab or 'a'/'t').
        if matches!(b, b' ' | b'\t' | b'a') {
            if let Some(end) = scan_acc_descr(src, p, &mut acc_unclosed) {
                kinds.push(Some(ArchToken::AccDescr));
                starts.push(p);
                ends.push(end);
                p = end;
                continue;
            }
            if let Some(end) = scan_acc_title(src, p) {
                kinds.push(Some(ArchToken::AccTitle));
                starts.push(p);
                ends.push(end);
                p = end;
                continue;
            }
        }
        if matches!(b, b' ' | b'\t' | b't')
            && let Some(end) = scan_title_before_id(src, p)
        {
            kinds.push(Some(ArchToken::Title));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }

        // 18: STRING
        if matches!(b, b'"' | b'\'')
            && let Some(end) = scan_string(src, p)
        {
            kinds.push(Some(ArchToken::StringLit));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }

        // 19: ID
        if let Some(end) = scan_id(src, p) {
            kinds.push(Some(ArchToken::Id));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }

        // 20: NEWLINE
        if let Some(end) = scan_newline(src, p) {
            kinds.push(Some(ArchToken::Newline));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }

        // 21: WHITESPACE (hidden)
        if let Some(end) = scan_whitespace(src, p) {
            p = end;
            continue;
        }

        // 22..24: YAML, DIRECTIVE, SINGLE_LINE_COMMENT (hidden)
        if let Some(end) = scan_yaml_block(src, p, &mut yaml_dead) {
            p = end;
            continue;
        }
        if let Some(end) = scan_directive(src, p, &mut dir_dead) {
            p = end;
            continue;
        }
        if let Some(end) = scan_single_line_comment(src, p) {
            p = end;
            continue;
        }

        // 25: ARCH_ICON
        if let Some(end) = scan_arch_icon(src, p) {
            kinds.push(Some(ArchToken::Icon));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }

        // 26: ARCH_TITLE
        if let Some(end) = scan_arch_title(src, p) {
            kinds.push(Some(ArchToken::Label));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }

        return Err(syntax_error(DiagramType::Architecture, src, p, "", true, origin));
    }

    kinds.push(None);
    starts.push(n);
    ends.push(n);
    Ok(TokenStream { kinds, starts, ends, src })
}

pub fn parse_architecture(src: &str, origin: Option<&SourceMap<'_>>) -> Result<ArchitectureAst, PeleError> {
    let tokens = tokenize(src, origin)?;
    let mut r = TokenReader::new(tokens, DiagramType::Architecture, origin, ArchToken::name);
    let mut ast = ArchitectureAst::default();

    let end_of_line = |r: &mut TokenReader<'_, ArchToken>| -> Result<(), PeleError> {
        if r.kind().is_none() {
            return Ok(());
        }
        if r.kind() != Some(ArchToken::Newline) {
            return Err(r.fail("a line break or the end of input"));
        }
        while r.kind() == Some(ArchToken::Newline) {
            r.i += 1;
        }
        Ok(())
    };

    while r.kind() == Some(ArchToken::Newline) {
        r.i += 1;
    }
    r.expect(ArchToken::Header)?;

    while let Some(kind) = r.kind() {
        match kind {
            ArchToken::Newline => {
                r.i += 1;
                continue;
            }
            ArchToken::AccDescr => {
                ast.acc_descr = Some(acc_descr_value(r.take()));
            }
            ArchToken::AccTitle => {
                ast.acc_title = Some(acc_title_value(r.take()));
            }
            ArchToken::Title => {
                ast.title = Some(title_value(r.take()));
            }
            ArchToken::Group => {
                r.i += 1;
                let id = r.expect(ArchToken::Id)?.to_string();
                let icon = if r.kind() == Some(ArchToken::Icon) {
                    let s = r.take();
                    Some(s[1..s.len() - 1].to_string())
                } else {
                    None
                };
                let title = if r.kind() == Some(ArchToken::Label) {
                    Some(label_value(r.take()))
                } else {
                    None
                };
                let in_group = if r.accept(ArchToken::In) {
                    Some(r.expect(ArchToken::Id)?.to_string())
                } else {
                    None
                };
                ast.groups.push(GroupAst { id, icon, title, in_group });
            }
            ArchToken::Service => {
                r.i += 1;
                let id = r.expect(ArchToken::Id)?.to_string();
                let (icon, icon_text) = if r.kind() == Some(ArchToken::StringLit) {
                    (None, Some(string_value(r.take())))
                } else if r.kind() == Some(ArchToken::Icon) {
                    let s = r.take();
                    (Some(s[1..s.len() - 1].to_string()), None)
                } else {
                    (None, None)
                };
                let title = if r.kind() == Some(ArchToken::Label) {
                    Some(label_value(r.take()))
                } else {
                    None
                };
                let in_group = if r.accept(ArchToken::In) {
                    Some(r.expect(ArchToken::Id)?.to_string())
                } else {
                    None
                };
                ast.services.push(ServiceAst {
                    id,
                    icon,
                    icon_text,
                    title,
                    in_group,
                });
            }
            ArchToken::Junction => {
                r.i += 1;
                let id = r.expect(ArchToken::Id)?.to_string();
                let in_group = if r.accept(ArchToken::In) {
                    Some(r.expect(ArchToken::Id)?.to_string())
                } else {
                    None
                };
                ast.junctions.push(JunctionAst { id, in_group });
            }
            ArchToken::Id => {
                let lhs_id = r.take().to_string();
                let lhs_group = r.accept(ArchToken::ArrowGroup);
                r.expect(ArchToken::Colon)?;
                let lhs_dir = Side::from_token(r.expect(ArchToken::Direction)?).unwrap();
                let lhs_into = r.accept(ArchToken::Into);
                let title = if !r.accept(ArchToken::Dashes) {
                    if r.kind() != Some(ArchToken::Dash) {
                        return Err(r.fail("'--' or '-'"));
                    }
                    r.i += 1;
                    let t = label_value(r.expect(ArchToken::Label)?);
                    r.expect(ArchToken::Dash)?;
                    Some(t)
                } else {
                    None
                };
                let rhs_into = r.accept(ArchToken::Into);
                let rhs_dir = Side::from_token(r.expect(ArchToken::Direction)?).unwrap();
                r.expect(ArchToken::Colon)?;
                let rhs_id = r.expect(ArchToken::Id)?.to_string();
                let rhs_group = r.accept(ArchToken::ArrowGroup);
                ast.edges.push(EdgeAst {
                    lhs_id,
                    lhs_group,
                    lhs_dir,
                    lhs_into,
                    title,
                    rhs_into,
                    rhs_dir,
                    rhs_id,
                    rhs_group,
                });
            }
            ArchToken::Align => {
                r.i += 1;
                let direction = match r.kind() {
                    Some(ArchToken::Row) => {
                        r.i += 1;
                        AlignDirection::Row
                    }
                    Some(ArchToken::Column) => {
                        r.i += 1;
                        AlignDirection::Column
                    }
                    _ => return Err(r.fail("'row' or 'column'")),
                };
                let mut members = vec![r.expect(ArchToken::Id)?.to_string(), r.expect(ArchToken::Id)?.to_string()];
                while r.kind() == Some(ArchToken::Id) {
                    members.push(r.take().to_string());
                }
                ast.alignments.push(AlignmentAst { direction, members });
            }
            ArchToken::Header
            | ArchToken::Column
            | ArchToken::Row
            | ArchToken::Dashes
            | ArchToken::In
            | ArchToken::Colon
            | ArchToken::Dash
            | ArchToken::Direction
            | ArchToken::ArrowGroup
            | ArchToken::Into
            | ArchToken::StringLit
            | ArchToken::Icon
            | ArchToken::Label => {
                return Err(r.fail("a group, a service, a junction, an edge, an alignment, a title, or a line break"));
            }
        }
        end_of_line(&mut r)?;
    }

    Ok(ast)
}
