use crate::detect::DiagramType;
use crate::diagram::common::{
    TokenReader, TokenStream, acc_descr_value, acc_title_value, scan_acc_descr, scan_acc_title, scan_directive, scan_keyword, scan_newline,
    scan_single_line_comment, scan_string, scan_title, scan_whitespace, scan_yaml_block, string_value, title_value,
};
use crate::error::{PeleError, SourceMap, syntax_error};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PieToken {
    ShowData,
    Pie,
    Colon,
    Number,
    AccDescr,
    AccTitle,
    Title,
    String,
    Newline,
}

fn token_name(k: PieToken) -> &'static str {
    match k {
        PieToken::ShowData => "showData",
        PieToken::Pie => "pie",
        PieToken::Colon => ":",
        PieToken::Number => "NUMBER_PIE",
        PieToken::AccDescr => "ACC_DESCR",
        PieToken::AccTitle => "ACC_TITLE",
        PieToken::Title => "TITLE",
        PieToken::String => "STRING",
        PieToken::Newline => "NEWLINE",
    }
}

struct NumberScanner {
    from: usize,
    end: usize,
    fraction: Option<usize>,
}

impl NumberScanner {
    fn new() -> Self {
        Self {
            from: 0,
            end: 0,
            fraction: None,
        }
    }

    fn scan(&mut self, src: &str, p: usize) -> Option<usize> {
        let bytes = src.as_bytes();
        let at = if bytes.get(p) == Some(&b'-') { p + 1 } else { p };
        if at < self.from || at >= self.end {
            self.from = at;
            let mut end = at;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
            self.end = end;
            self.fraction = None;
            if end > at && bytes.get(end) == Some(&b'.') {
                let mut stop = end + 1;
                while stop < bytes.len() && bytes[stop].is_ascii_digit() {
                    stop += 1;
                }
                let length = stop - end - 1;
                if length > 0 && bytes.get(stop) != Some(&b'.') {
                    self.fraction = Some(stop);
                } else if length > 1 {
                    self.fraction = Some(stop - 1);
                }
            }
        }
        if self.end == at {
            return None;
        }
        if let Some(frac) = self.fraction {
            return Some(frac);
        }
        if bytes.get(at) == Some(&b'0') {
            return if bytes.get(at + 1) == Some(&b'.') { None } else { Some(at + 1) };
        }
        if bytes.get(self.end) != Some(&b'.') {
            return Some(self.end);
        }
        if self.end > at + 1 { Some(self.end - 1) } else { None }
    }
}

fn tokenize_pie<'a>(src: &'a str, origin: Option<&SourceMap<'_>>) -> Result<TokenStream<'a, PieToken>, PeleError> {
    let mut kinds: Vec<Option<PieToken>> = Vec::new();
    let mut starts: Vec<usize> = Vec::new();
    let mut ends: Vec<usize> = Vec::new();
    let mut num_scanner = NumberScanner::new();
    let mut unclosed_descr = false;
    let mut yaml_dead = false;
    let mut dir_dead = false;
    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut p = 0;

    while p < n {
        let b = bytes[p];
        // Match rules in exact upstream PIE_TOKENS priority order.
        if b == b's'
            && let Some(end) = scan_keyword(src, p, "showData")
        {
            kinds.push(Some(PieToken::ShowData));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }
        if b == b'p'
            && let Some(end) = scan_keyword(src, p, "pie")
        {
            kinds.push(Some(PieToken::Pie));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }
        if b == b':' {
            kinds.push(Some(PieToken::Colon));
            starts.push(p);
            ends.push(p + 1);
            p += 1;
            continue;
        }
        if (b == b'-' || b.is_ascii_digit())
            && let Some(end) = num_scanner.scan(src, p)
        {
            kinds.push(Some(PieToken::Number));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }
        if matches!(b, b' ' | b'\t' | b'a') {
            if let Some(end) = scan_acc_descr(src, p, &mut unclosed_descr) {
                kinds.push(Some(PieToken::AccDescr));
                starts.push(p);
                ends.push(end);
                p = end;
                continue;
            }
            if let Some(end) = scan_acc_title(src, p) {
                kinds.push(Some(PieToken::AccTitle));
                starts.push(p);
                ends.push(end);
                p = end;
                continue;
            }
        }
        if matches!(b, b' ' | b'\t' | b't')
            && let Some(end) = scan_title(src, p)
        {
            kinds.push(Some(PieToken::Title));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }
        if matches!(b, b'"' | b'\'')
            && let Some(end) = scan_string(src, p)
        {
            kinds.push(Some(PieToken::String));
            starts.push(p);
            ends.push(end);
            p = end;
            continue;
        }
        if matches!(b, b'\r' | b'\n')
            && let Some(end) = scan_newline(src, p)
        {
            kinds.push(Some(PieToken::Newline));
            starts.push(p);
            ends.push(end);
            p = end;
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
        return Err(syntax_error(DiagramType::Pie, src, p, "", true, origin));
    }
    kinds.push(None);
    starts.push(n);
    ends.push(n);
    Ok(TokenStream { kinds, starts, ends, src })
}

#[derive(Debug, Clone)]
pub struct PieSection {
    pub label: String,
    pub value: f64,
}

#[derive(Debug, Clone)]
pub struct PieAst {
    pub show_data: bool,
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    pub sections: Vec<PieSection>,
}

pub fn parse_pie(src: &str, origin: Option<&SourceMap<'_>>) -> Result<PieAst, PeleError> {
    let tokens = tokenize_pie(src, origin)?;
    let mut r = TokenReader::new(tokens, DiagramType::Pie, origin, token_name);
    let mut ast = PieAst {
        show_data: false,
        title: None,
        acc_title: None,
        acc_descr: None,
        sections: Vec::new(),
    };

    let end_of_line = |r: &mut TokenReader<'_, PieToken>| -> Result<(), PeleError> {
        if r.kind().is_none() {
            return Ok(());
        }
        if r.kind() != Some(PieToken::Newline) {
            return Err(r.fail("a line break or the end of input"));
        }
        while r.kind() == Some(PieToken::Newline) {
            r.i += 1;
        }
        Ok(())
    };

    while r.kind() == Some(PieToken::Newline) {
        r.i += 1;
    }
    r.expect(PieToken::Pie)?;
    ast.show_data = r.accept(PieToken::ShowData);
    while let Some(k) = r.kind() {
        match k {
            PieToken::Newline => {
                r.i += 1;
            }
            PieToken::AccDescr => {
                ast.acc_descr = Some(acc_descr_value(r.take()));
                end_of_line(&mut r)?;
            }
            PieToken::AccTitle => {
                ast.acc_title = Some(acc_title_value(r.take()));
                end_of_line(&mut r)?;
            }
            PieToken::Title => {
                ast.title = Some(title_value(r.take()));
                end_of_line(&mut r)?;
            }
            PieToken::String => {
                let label = string_value(r.take());
                r.expect(PieToken::Colon)?;
                let num_text = r.expect(PieToken::Number)?;
                let value: f64 = num_text.parse().unwrap_or(0.0);
                ast.sections.push(PieSection { label, value });
                end_of_line(&mut r)?;
            }
            PieToken::ShowData | PieToken::Pie | PieToken::Colon | PieToken::Number => {
                return Err(r.fail("a section, a title, or a line break"));
            }
        }
    }
    Ok(ast)
}
