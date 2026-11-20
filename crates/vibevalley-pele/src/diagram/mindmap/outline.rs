use crate::detect::DiagramType;
use crate::error::{PeleError, SourceMap, syntax_error};
use crate::util::chars::{is_line_end, is_space_char, is_word};

/// Indented outline grammar shared by mindmap and kanban diagrams.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tok {
    End,
    Error,
    Spaceline,
    Nl,
    Eof,
    Keyword,
    Spacelist,
    Icon,
    Class,
    NodeDStart,
    NodeId,
    NodeDescr,
    NodeDEnd,
    ShapeData,
}

pub fn token_name(tok: Tok, kanban: bool) -> &'static str {
    match tok {
        Tok::End => "1",
        Tok::Error => "INVALID",
        Tok::Spaceline => "SPACELINE",
        Tok::Nl => "NL",
        Tok::Eof => "EOF",
        Tok::Keyword => {
            if kanban {
                "KANBAN"
            } else {
                "MINDMAP"
            }
        }
        Tok::Spacelist => "SPACELIST",
        Tok::Icon => "ICON",
        Tok::Class => "CLASS",
        Tok::NodeDStart => "NODE_DSTART",
        Tok::NodeId => "NODE_ID",
        Tok::NodeDescr => "NODE_DESCR",
        Tok::NodeDEnd => "NODE_DEND",
        Tok::ShapeData => "SHAPE_DATA",
    }
}

pub struct Tokens {
    pub types: Vec<Tok>,
    pub texts: Vec<String>,
    pub starts: Vec<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeShape {
    Default = 0,
    RoundedRect = 1,
    Rect = 2,
    Circle = 3,
    Cloud = 4,
    Bang = 5,
    Hexagon = 6,
}

/// Any opening delimiter pairs with any closing one, as in Mermaid.
pub fn get_type(start: &str, end: &str) -> NodeShape {
    match start {
        "[" => NodeShape::Rect,
        "(" => {
            if end == ")" {
                NodeShape::RoundedRect
            } else {
                NodeShape::Cloud
            }
        }
        "((" => NodeShape::Circle,
        ")" => NodeShape::Cloud,
        "))" => NodeShape::Bang,
        "{{" => NodeShape::Hexagon,
        _ => NodeShape::Default,
    }
}

pub trait OutlineDb {
    fn get_type(&self, start: &str, end: &str) -> NodeShape {
        get_type(start, end)
    }
    fn add_node(&mut self, level: usize, id: String, descr: String, node_type: NodeShape, shape_data: Option<String>) -> Result<(), PeleError>;
    fn decorate_node(&mut self, icon: Option<String>, class: Option<String>);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Initial,
    Class,
    Icon,
    Node,
    NStr,
    NStr2,
    Data,
    DataStr,
}

fn letters(src: &str, p: usize, word: &[u8]) -> bool {
    let bytes = src.as_bytes();
    if p + word.len() > bytes.len() {
        return false;
    }
    for (k, &w) in word.iter().enumerate() {
        if (bytes[p + k] | 32) != w {
            return false;
        }
    }
    true
}

fn scan_space(src: &str, from: usize) -> usize {
    let mut p = from;
    while p < src.len() {
        let ch = src[p..].chars().next().unwrap();
        if !is_space_char(ch) {
            break;
        }
        p += ch.len_utf8();
    }
    p
}

fn scan_line(src: &str, from: usize) -> Option<usize> {
    let mut p = from;
    while p < src.len() {
        let ch = src[p..].chars().next().unwrap();
        if is_line_end(ch as u32) {
            break;
        }
        p += ch.len_utf8();
    }
    (p > from).then_some(p)
}

fn scan_id(src: &str, from: usize, kanban: bool) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut p = from;
    while p < bytes.len() {
        let b = bytes[p];
        if matches!(b, b'(' | b'[' | b'\n' | b')' | b'{' | b'}') || (kanban && b == b'@') {
            break;
        }
        p += 1;
    }
    (p > from).then_some(p)
}

fn scan_descr(src: &str, from: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut p = from;
    while p < bytes.len() && !matches!(bytes[p], b')' | b']' | b'(' | b'}') {
        p += 1;
    }
    (p > from).then_some(p)
}

fn scan_md(src: &str, from: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut p = from;
    while p < bytes.len() && !matches!(bytes[p], b'`' | b'"') {
        p += 1;
    }
    (p > from).then_some(p)
}

fn scan_data(src: &str, from: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut p = from;
    while p < bytes.len() && !matches!(bytes[p], b'}' | b'^' | b'"') {
        p += 1;
    }
    (p > from).then_some(p)
}

fn replace_br(text: &str) -> String {
    if !text.contains('\n') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len() + 8);
    let mut i = 0usize;
    while i < text.len() {
        if text.as_bytes()[i] == b'\n' {
            out.push_str("<br/>");
            i += 1;
            while i < text.len() {
                let ch = text[i..].chars().next().unwrap();
                if is_space_char(ch) {
                    i += ch.len_utf8();
                } else {
                    break;
                }
            }
        } else {
            let ch = text[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

pub fn tokenize(src: &str, kanban: bool) -> Tokens {
    let n = src.len();
    let bytes = src.as_bytes();
    let mut types = Vec::new();
    let mut texts = Vec::new();
    let mut starts = Vec::new();
    let keyword: &[u8] = if kanban { b"kanban" } else { b"mindmap" };
    let mut state = State::Initial;
    let mut p = 0usize;
    let mut next_break: Option<usize> = None;

    let mut put = |tok: Tok, text: String, start: usize| {
        types.push(tok);
        texts.push(text);
        starts.push(start);
    };

    while p < n {
        let c = bytes[p];
        let d = bytes.get(p + 1).copied().unwrap_or(0);
        match state {
            State::Initial => {
                let w = if c <= 32 || c >= 128 { scan_space(src, p) } else { p };
                if kanban && c == b'@' && d == b'{' {
                    put(Tok::ShapeData, String::new(), p);
                    p += 2;
                    state = State::Data;
                } else if bytes.get(w) == Some(&b'%') && bytes.get(w + 1) == Some(&b'%') {
                    let end = scan_line(src, w).unwrap_or(w);
                    put(Tok::Spaceline, src[p..end].to_string(), p);
                    p = end;
                    state = State::Initial;
                } else if w > p {
                    let nb = match next_break {
                        Some(idx) if idx >= p => idx,
                        _ => {
                            let idx = src[p..].find('\n').map_or(n, |rel| p + rel);
                            next_break = Some(idx);
                            idx
                        }
                    };
                    if nb >= w {
                        put(Tok::Spacelist, src[p..w].to_string(), p);
                        p = w;
                    } else if let Some(rel) = src[p..w].rfind('\n')
                        && rel > 0
                    {
                        let end = p + rel + 1;
                        put(Tok::Spaceline, src[p..end].to_string(), p);
                        p = end;
                    } else {
                        put(Tok::Nl, src[p..p + 1].to_string(), p);
                        p += 1;
                    }
                    state = State::Initial;
                } else if letters(src, p, keyword) && bytes.get(p + keyword.len()).is_none_or(|&b| !is_word(b as u32)) {
                    let end = p + keyword.len();
                    put(Tok::Keyword, src[p..end].to_string(), p);
                    p = end;
                    state = State::Initial;
                } else if c == b':' && d == b':' && bytes.get(p + 2) == Some(&b':') {
                    p += 3;
                    state = State::Class;
                } else if c == b':' && d == b':' && letters(src, p + 2, b"icon") && bytes.get(p + 6) == Some(&b'(') {
                    p += 7;
                    state = State::Icon;
                } else if (c == b'-' && d == b')') || (c == b'(' && (d == b'-' || d == b'(')) || ((c == b')' || c == b'{') && d == c) {
                    let end = p + 2;
                    put(Tok::NodeDStart, src[p..end].to_string(), p);
                    p = end;
                    state = State::Node;
                } else if matches!(c, b')' | b'(' | b'[') {
                    let end = p + 1;
                    put(Tok::NodeDStart, src[p..end].to_string(), p);
                    p = end;
                    state = State::Node;
                } else if let Some(end) = scan_id(src, p, kanban) {
                    put(Tok::NodeId, src[p..end].to_string(), p);
                    p = end;
                    state = State::Initial;
                } else {
                    break;
                }
            }
            State::Node => {
                if c == b'"' {
                    if d == b'`' {
                        state = State::NStr2;
                        p += 2;
                    } else {
                        state = State::NStr;
                        p += 1;
                    }
                } else if c == b')' || c == b'(' {
                    let len = if d == c || (c == b'(' && d == b'-') { 2 } else { 1 };
                    let end = p + len;
                    put(Tok::NodeDEnd, src[p..end].to_string(), p);
                    p = end;
                    state = State::Initial;
                } else if c == b']' {
                    let end = p + 1;
                    put(Tok::NodeDEnd, src[p..end].to_string(), p);
                    p = end;
                    state = State::Initial;
                } else if (c == b'}' && d == b'}') || (c == b'-' && d == b')') {
                    let end = p + 2;
                    put(Tok::NodeDEnd, src[p..end].to_string(), p);
                    p = end;
                    state = State::Initial;
                } else {
                    let end = if c == b'}' {
                        scan_line(src, p).unwrap_or(p)
                    } else {
                        scan_descr(src, p).unwrap_or(p)
                    };
                    put(Tok::NodeDescr, src[p..end].to_string(), p);
                    p = end;
                    state = State::Node;
                }
            }
            State::NStr => {
                if c == b'"' {
                    p += 1;
                    state = State::Node;
                } else {
                    let end = src[p..].find('"').map_or(n, |rel| p + rel);
                    put(Tok::NodeDescr, src[p..end].to_string(), p);
                    p = end;
                    state = State::NStr;
                }
            }
            State::NStr2 => {
                if c == b'`' && d == b'"' {
                    p += 2;
                    state = State::Node;
                } else if let Some(end) = scan_md(src, p) {
                    put(Tok::NodeDescr, src[p..end].to_string(), p);
                    p = end;
                    state = State::NStr2;
                } else {
                    break;
                }
            }
            State::Class => {
                if let Some(end) = scan_line(src, p) {
                    put(Tok::Class, src[p..end].to_string(), p);
                    p = end;
                    state = State::Initial;
                } else if c == b'\n' {
                    p += 1;
                    state = State::Initial;
                } else {
                    break;
                }
            }
            State::Icon => {
                if c == b')' {
                    p += 1;
                    state = State::Initial;
                } else {
                    let end = src[p..].find(')').map_or(n, |rel| p + rel);
                    put(Tok::Icon, src[p..end].to_string(), p);
                    p = end;
                    state = State::Icon;
                }
            }
            State::Data => {
                if c == b'"' {
                    put(Tok::ShapeData, src[p..p + 1].to_string(), p);
                    p += 1;
                    state = State::DataStr;
                } else if c == b'}' {
                    p += 1;
                    state = State::Initial;
                } else if let Some(end) = scan_data(src, p) {
                    put(Tok::ShapeData, src[p..end].to_string(), p);
                    p = end;
                    state = State::Data;
                } else {
                    break;
                }
            }
            State::DataStr => {
                if c == b'"' {
                    put(Tok::ShapeData, src[p..p + 1].to_string(), p);
                    p += 1;
                    state = State::Data;
                } else {
                    let end = src[p..].find('"').map_or(n, |rel| p + rel);
                    put(Tok::ShapeData, replace_br(&src[p..end]), p);
                    p = end;
                    state = State::DataStr;
                }
            }
        }
    }

    if p < n {
        put(Tok::Error, String::new(), p);
    } else {
        if state == State::Initial {
            put(Tok::Eof, String::new(), n);
        }
        put(Tok::End, String::new(), n);
    }
    Tokens { types, texts, starts }
}

const STOP: &str = "'SPACELINE', 'NL', 'EOF'";

fn is_stop(tok: Tok) -> bool {
    matches!(tok, Tok::Spaceline | Tok::Nl | Tok::Eof)
}

fn is_start(tok: Tok) -> bool {
    matches!(tok, Tok::Spaceline | Tok::Spacelist | Tok::Icon | Tok::Class | Tok::NodeDStart | Tok::NodeId)
}

pub fn parse_outline(src: &str, db: &mut dyn OutlineDb, kanban: bool, origin: Option<&SourceMap<'_>>) -> Result<(), PeleError> {
    let diagram = if kanban { DiagramType::Kanban } else { DiagramType::Mindmap };
    let tokens = tokenize(src, kanban);
    let types = &tokens.types;
    let texts = &tokens.texts;
    let starts = &tokens.starts;
    let data = if kanban { ", 'SHAPE_DATA'" } else { "" };
    let mut i = 0usize;

    let fail = |idx: usize, expected: &str| -> PeleError {
        let t = types[idx];
        if t == Tok::Error {
            return syntax_error(diagram, src, starts[idx], "", true, origin);
        }
        syntax_error(
            diagram,
            src,
            starts[idx],
            &format!("Expecting {expected}, got '{}'", token_name(t, kanban)),
            false,
            origin,
        )
    };

    let kw_name = token_name(Tok::Keyword, kanban);
    if types[i] == Tok::Spaceline {
        i += 1;
        while matches!(types[i], Tok::Spaceline | Tok::Nl) {
            i += 1;
        }
        if types[i] != Tok::Keyword {
            return Err(fail(i, &format!("'SPACELINE', 'NL', '{kw_name}'")));
        }
    } else if types[i] != Tok::Keyword {
        return Err(fail(i, &format!("'SPACELINE', '{kw_name}'")));
    }
    i += 1;
    let mut first = "'SPACELINE', 'NL', 'SPACELIST', 'ICON', 'CLASS', 'NODE_DSTART', 'NODE_ID'";
    if types[i] == Tok::Nl {
        i += 1;
        first = "'SPACELINE', 'SPACELIST', 'ICON', 'CLASS', 'NODE_DSTART', 'NODE_ID'";
    }

    loop {
        let mut t = types[i];
        let mut level = 0usize;
        let indented = t == Tok::Spacelist;
        if indented {
            level = texts[i].chars().count();
            i += 1;
            t = types[i];
        }
        if matches!(t, Tok::NodeId | Tok::NodeDStart) {
            let mut id: Option<String> = None;
            let descr: String;
            let mut node_type = NodeShape::Default;
            if t == Tok::NodeId {
                id = Some(texts[i].clone());
                i += 1;
            }
            if types[i] == Tok::NodeDStart {
                let start = texts[i].as_str();
                i += 1;
                if types[i] != Tok::NodeDescr {
                    return Err(fail(i, "'NODE_DESCR'"));
                }
                descr = texts[i].clone();
                i += 1;
                if types[i] != Tok::NodeDEnd {
                    return Err(fail(i, "'NODE_DEND'"));
                }
                let end = texts[i].as_str();
                i += 1;
                if !is_stop(types[i]) && types[i] != Tok::ShapeData {
                    return Err(fail(i, &format!("{STOP}{data}")));
                }
                node_type = db.get_type(start, end);
            } else {
                if !is_stop(types[i]) && types[i] != Tok::ShapeData {
                    return Err(fail(i, &format!("{STOP}, 'NODE_DSTART'{data}")));
                }
                descr = id.clone().unwrap();
            }
            if types[i] == Tok::ShapeData {
                let mut shape_data = texts[i].clone();
                i += 1;
                while types[i] == Tok::ShapeData {
                    shape_data.push_str(&texts[i]);
                    i += 1;
                }
                if !is_stop(types[i]) {
                    return Err(fail(i, &format!("{STOP}{data}")));
                }
                db.add_node(level, id.unwrap_or_else(|| descr.clone()), descr, node_type, Some(shape_data))?;
            } else {
                db.add_node(level, id.unwrap_or_else(|| descr.clone()), descr, node_type, None)?;
            }
        } else if matches!(t, Tok::Icon | Tok::Class) {
            let text = texts[i].clone();
            i += 1;
            if !is_stop(types[i]) {
                return Err(fail(i, STOP));
            }
            if t == Tok::Icon {
                db.decorate_node(Some(text), None);
            } else {
                db.decorate_node(None, Some(text));
            }
        } else if indented {
            if !is_stop(t) {
                return Err(fail(i, &format!("{STOP}, 'ICON', 'CLASS', 'NODE_DSTART', 'NODE_ID'")));
            }
        } else if t == Tok::Spaceline {
            i += 1;
            if !is_stop(types[i]) {
                return Err(fail(i, STOP));
            }
        } else {
            return Err(fail(i, first));
        }

        i += 1;
        while matches!(types[i], Tok::Nl | Tok::Eof) {
            i += 1;
        }
        if types[i] == Tok::End {
            return Ok(());
        }
        if !is_start(types[i]) {
            return Err(fail(i, &format!("{STOP}, 'SPACELIST', 'ICON', 'CLASS', 'NODE_DSTART', 'NODE_ID'")));
        }
    }
}
