use crate::detect::DiagramType;
use crate::diagram::common::{
    TokenReader, TokenStream, acc_descr_value, acc_title_value, scan_acc_descr, scan_acc_title, scan_directive, scan_keyword, scan_newline,
    scan_single_line_comment, scan_string, scan_whitespace, scan_yaml_block, string_value, title_value,
};
use crate::error::{PeleError, SourceMap, syntax_error};
use crate::util::chars::is_word;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GitToken {
    CherryPick,
    GitGraphColon,
    Highlight,
    GitGraph,
    Checkout,
    Reverse,
    Parent,
    Commit,
    Normal,
    Branch,
    Order,
    Switch,
    Type,
    Merge,
    Msg,
    Tag,
    Id,
    Lr,
    Tb,
    Bt,
    Colon,
    AccDescr,
    AccTitle,
    Title,
    Int,
    String,
    Newline,
    Reference,
}

impl GitToken {
    const fn name(self) -> &'static str {
        match self {
            Self::CherryPick => "cherry-pick",
            Self::GitGraphColon => "gitGraph:",
            Self::Highlight => "HIGHLIGHT",
            Self::GitGraph => "gitGraph",
            Self::Checkout => "checkout",
            Self::Reverse => "REVERSE",
            Self::Parent => "parent:",
            Self::Commit => "commit",
            Self::Normal => "NORMAL",
            Self::Branch => "branch",
            Self::Order => "order:",
            Self::Switch => "switch",
            Self::Type => "type:",
            Self::Merge => "merge",
            Self::Msg => "msg:",
            Self::Tag => "tag:",
            Self::Id => "id:",
            Self::Lr => "LR",
            Self::Tb => "TB",
            Self::Bt => "BT",
            Self::Colon => ":",
            Self::AccDescr => "ACC_DESCR",
            Self::AccTitle => "ACC_TITLE",
            Self::Title => "TITLE",
            Self::Int => "INT",
            Self::String => "STRING",
            Self::Newline => "NEWLINE",
            Self::Reference => "REFERENCE",
        }
    }
}

/// Matches `/\w([-\./\w]*[-\w])?/y`.
fn scan_reference(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    if !bytes.get(at).is_some_and(|&b| is_word(b as u32)) {
        return None;
    }
    let mut p = at + 1;
    while p < bytes.len() && (is_word(bytes[p] as u32) || matches!(bytes[p], b'-' | b'.' | b'/')) {
        p += 1;
    }
    while p > at + 1 && matches!(bytes[p - 1], b'.' | b'/') {
        p -= 1;
    }
    Some(p)
}

/// Matches `titleBefore("[-./\\w]*[-\\w]")`.
fn scan_git_title(src: &str, at: usize) -> Option<usize> {
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
    // Negative lookahead `(?! [-./\w]*[-\w])`: reject if a run of [-./\w] contains any [-\w].
    let mut q = p;
    while q < bytes.len() {
        let b = bytes[q];
        if b == b'-' || is_word(b as u32) {
            return None;
        }
        if b == b'.' || b == b'/' {
            q += 1;
        } else {
            break;
        }
    }
    Some(p)
}

/// Matches `/0|[1-9][0-9]*(?!\.)/y`.
fn scan_int(src: &str, at: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let first = *bytes.get(at)?;
    if first == b'0' {
        return Some(at + 1);
    }
    if !(b'1'..=b'9').contains(&first) {
        return None;
    }
    let mut p = at + 1;
    while p < bytes.len() && bytes[p].is_ascii_digit() {
        p += 1;
    }
    if bytes.get(p) == Some(&b'.') {
        if p > at + 1 { Some(p - 1) } else { None }
    } else {
        Some(p)
    }
}

fn match_word_longer(src: &str, at: usize, word: &str, kind: GitToken) -> Option<(GitToken, usize)> {
    if !src[at..].starts_with(word) {
        return None;
    }
    let end = at + word.len();
    if let Some(ref_end) = scan_reference(src, at)
        && ref_end > end
    {
        return Some((GitToken::Reference, ref_end));
    }
    Some((kind, end))
}

fn tokenize_git<'a>(src: &'a str, origin: Option<&SourceMap<'_>>) -> Result<TokenStream<'a, GitToken>, PeleError> {
    let mut kinds: Vec<Option<GitToken>> = Vec::new();
    let mut starts: Vec<usize> = Vec::new();
    let mut ends: Vec<usize> = Vec::new();
    let mut unclosed_descr = false;
    let mut yaml_dead = false;
    let mut dir_dead = false;

    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut p = 0usize;

    let push_tok = |kinds: &mut Vec<Option<GitToken>>, starts: &mut Vec<usize>, ends: &mut Vec<usize>, kind: GitToken, s: usize, e: usize| {
        kinds.push(Some(kind));
        starts.push(s);
        ends.push(e);
    };

    while p < n {
        let b = bytes[p];

        // Exact upstream GIT_TOKENS priority order.
        if b == b'c'
            && let Some((k, e)) = match_word_longer(src, p, "cherry-pick", GitToken::CherryPick)
        {
            push_tok(&mut kinds, &mut starts, &mut ends, k, p, e);
            p = e;
            continue;
        }
        if b == b'g' && src[p..].starts_with("gitGraph:") {
            push_tok(&mut kinds, &mut starts, &mut ends, GitToken::GitGraphColon, p, p + 9);
            p += 9;
            continue;
        }
        if b == b'H'
            && let Some((k, e)) = match_word_longer(src, p, "HIGHLIGHT", GitToken::Highlight)
        {
            push_tok(&mut kinds, &mut starts, &mut ends, k, p, e);
            p = e;
            continue;
        }
        if b == b'g'
            && let Some(end) = scan_keyword(src, p, "gitGraph")
        {
            if let Some(ref_end) = scan_reference(src, p)
                && ref_end > end
            {
                push_tok(&mut kinds, &mut starts, &mut ends, GitToken::Reference, p, ref_end);
                p = ref_end;
            } else {
                push_tok(&mut kinds, &mut starts, &mut ends, GitToken::GitGraph, p, end);
                p = end;
            }
            continue;
        }
        if b == b'c'
            && let Some((k, e)) = match_word_longer(src, p, "checkout", GitToken::Checkout)
        {
            push_tok(&mut kinds, &mut starts, &mut ends, k, p, e);
            p = e;
            continue;
        }
        if b == b'R'
            && let Some((k, e)) = match_word_longer(src, p, "REVERSE", GitToken::Reverse)
        {
            push_tok(&mut kinds, &mut starts, &mut ends, k, p, e);
            p = e;
            continue;
        }
        if b == b'p' && src[p..].starts_with("parent:") {
            push_tok(&mut kinds, &mut starts, &mut ends, GitToken::Parent, p, p + 7);
            p += 7;
            continue;
        }
        if b == b'c'
            && let Some((k, e)) = match_word_longer(src, p, "commit", GitToken::Commit)
        {
            push_tok(&mut kinds, &mut starts, &mut ends, k, p, e);
            p = e;
            continue;
        }
        if b == b'N'
            && let Some((k, e)) = match_word_longer(src, p, "NORMAL", GitToken::Normal)
        {
            push_tok(&mut kinds, &mut starts, &mut ends, k, p, e);
            p = e;
            continue;
        }
        if b == b'b'
            && let Some((k, e)) = match_word_longer(src, p, "branch", GitToken::Branch)
        {
            push_tok(&mut kinds, &mut starts, &mut ends, k, p, e);
            p = e;
            continue;
        }
        if b == b'o' && src[p..].starts_with("order:") {
            push_tok(&mut kinds, &mut starts, &mut ends, GitToken::Order, p, p + 6);
            p += 6;
            continue;
        }
        if b == b's'
            && let Some((k, e)) = match_word_longer(src, p, "switch", GitToken::Switch)
        {
            push_tok(&mut kinds, &mut starts, &mut ends, k, p, e);
            p = e;
            continue;
        }
        if b == b't' && src[p..].starts_with("type:") {
            push_tok(&mut kinds, &mut starts, &mut ends, GitToken::Type, p, p + 5);
            p += 5;
            continue;
        }
        if b == b'm' {
            if let Some((k, e)) = match_word_longer(src, p, "merge", GitToken::Merge) {
                push_tok(&mut kinds, &mut starts, &mut ends, k, p, e);
                p = e;
                continue;
            }
            if src[p..].starts_with("msg:") {
                push_tok(&mut kinds, &mut starts, &mut ends, GitToken::Msg, p, p + 4);
                p += 4;
                continue;
            }
        }
        if b == b't' && src[p..].starts_with("tag:") {
            push_tok(&mut kinds, &mut starts, &mut ends, GitToken::Tag, p, p + 4);
            p += 4;
            continue;
        }
        if b == b'i' && src[p..].starts_with("id:") {
            push_tok(&mut kinds, &mut starts, &mut ends, GitToken::Id, p, p + 3);
            p += 3;
            continue;
        }
        if b == b'L'
            && let Some((k, e)) = match_word_longer(src, p, "LR", GitToken::Lr)
        {
            push_tok(&mut kinds, &mut starts, &mut ends, k, p, e);
            p = e;
            continue;
        }
        if b == b'T'
            && let Some((k, e)) = match_word_longer(src, p, "TB", GitToken::Tb)
        {
            push_tok(&mut kinds, &mut starts, &mut ends, k, p, e);
            p = e;
            continue;
        }
        if b == b'B'
            && let Some((k, e)) = match_word_longer(src, p, "BT", GitToken::Bt)
        {
            push_tok(&mut kinds, &mut starts, &mut ends, k, p, e);
            p = e;
            continue;
        }
        if b == b':' {
            push_tok(&mut kinds, &mut starts, &mut ends, GitToken::Colon, p, p + 1);
            p += 1;
            continue;
        }
        if matches!(b, b' ' | b'\t' | b'a') {
            if let Some(e) = scan_acc_descr(src, p, &mut unclosed_descr) {
                push_tok(&mut kinds, &mut starts, &mut ends, GitToken::AccDescr, p, e);
                p = e;
                continue;
            }
            if let Some(e) = scan_acc_title(src, p) {
                push_tok(&mut kinds, &mut starts, &mut ends, GitToken::AccTitle, p, e);
                p = e;
                continue;
            }
        }
        if matches!(b, b' ' | b'\t' | b't')
            && let Some(e) = scan_git_title(src, p)
        {
            push_tok(&mut kinds, &mut starts, &mut ends, GitToken::Title, p, e);
            p = e;
            continue;
        }
        if b.is_ascii_digit()
            && let Some(e) = scan_int(src, p)
        {
            push_tok(&mut kinds, &mut starts, &mut ends, GitToken::Int, p, e);
            p = e;
            continue;
        }
        if matches!(b, b'"' | b'\'')
            && let Some(e) = scan_string(src, p)
        {
            push_tok(&mut kinds, &mut starts, &mut ends, GitToken::String, p, e);
            p = e;
            continue;
        }
        if matches!(b, b'\r' | b'\n')
            && let Some(e) = scan_newline(src, p)
        {
            push_tok(&mut kinds, &mut starts, &mut ends, GitToken::Newline, p, e);
            p = e;
            continue;
        }
        if matches!(b, b' ' | b'\t')
            && let Some(e) = scan_whitespace(src, p)
        {
            p = e;
            continue;
        }
        if b == b'-'
            && let Some(e) = scan_yaml_block(src, p, &mut yaml_dead)
        {
            p = e;
            continue;
        }
        if matches!(b, b' ' | b'\t' | b'%') {
            if let Some(e) = scan_directive(src, p, &mut dir_dead) {
                p = e;
                continue;
            }
            if let Some(e) = scan_single_line_comment(src, p) {
                p = e;
                continue;
            }
        }
        if let Some(e) = scan_reference(src, p) {
            push_tok(&mut kinds, &mut starts, &mut ends, GitToken::Reference, p, e);
            p = e;
            continue;
        }
        return Err(syntax_error(DiagramType::GitGraph, src, p, "", true, origin));
    }

    kinds.push(None);
    starts.push(n);
    ends.push(n);
    Ok(TokenStream { kinds, starts, ends, src })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitTypeName {
    Normal,
    Reverse,
    Highlight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitDirection {
    Lr,
    Tb,
    Bt,
}

#[derive(Debug, Clone, PartialEq)]
pub enum StatementAst {
    Commit {
        id: Option<String>,
        message: Option<String>,
        tags: Vec<String>,
        commit_type: Option<CommitTypeName>,
    },
    Branch {
        name: String,
        order: Option<f64>,
    },
    Merge {
        branch: String,
        id: Option<String>,
        tags: Vec<String>,
        commit_type: Option<CommitTypeName>,
    },
    Checkout {
        branch: String,
    },
    CherryPicking {
        id: Option<String>,
        tags: Vec<String>,
        parent: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct GitGraphAst {
    pub dir: Option<GitDirection>,
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    pub statements: Vec<StatementAst>,
}

pub fn parse_git(src: &str, origin: Option<&SourceMap<'_>>) -> Result<GitGraphAst, PeleError> {
    let tokens = tokenize_git(src, origin)?;
    let mut r = TokenReader::new(tokens, DiagramType::GitGraph, origin, GitToken::name);
    let mut ast = GitGraphAst {
        dir: None,
        title: None,
        acc_title: None,
        acc_descr: None,
        statements: Vec::new(),
    };

    let end_of_line = |r: &mut TokenReader<'_, GitToken>| -> Result<(), PeleError> {
        if r.kind().is_none() {
            return Ok(());
        }
        if r.kind() != Some(GitToken::Newline) {
            return Err(r.fail("a line break or the end of input"));
        }
        while r.kind() == Some(GitToken::Newline) {
            r.i += 1;
        }
        Ok(())
    };
    let read_name = |r: &mut TokenReader<'_, GitToken>| -> Result<String, PeleError> {
        match r.kind() {
            Some(GitToken::Reference) => Ok(r.take().to_string()),
            Some(GitToken::String) => Ok(string_value(r.take())),
            _ => Err(r.fail("a branch name")),
        }
    };
    let read_string = |r: &mut TokenReader<'_, GitToken>| -> Result<String, PeleError> { Ok(string_value(r.expect(GitToken::String)?)) };
    let read_commit_type = |r: &mut TokenReader<'_, GitToken>| -> Result<CommitTypeName, PeleError> {
        match r.kind() {
            Some(GitToken::Normal) => {
                r.i += 1;
                Ok(CommitTypeName::Normal)
            }
            Some(GitToken::Reverse) => {
                r.i += 1;
                Ok(CommitTypeName::Reverse)
            }
            Some(GitToken::Highlight) => {
                r.i += 1;
                Ok(CommitTypeName::Highlight)
            }
            _ => Err(r.fail("NORMAL, REVERSE, or HIGHLIGHT")),
        }
    };

    while r.kind() == Some(GitToken::Newline) {
        r.i += 1;
    }
    if !r.accept(GitToken::GitGraphColon) {
        r.expect(GitToken::GitGraph)?;
        let next = r.tokens.kinds.get(r.i + 1).copied().flatten();
        if next == Some(GitToken::Colon) {
            match r.kind() {
                Some(GitToken::Lr) => {
                    ast.dir = Some(GitDirection::Lr);
                    r.i += 2;
                }
                Some(GitToken::Tb) => {
                    ast.dir = Some(GitDirection::Tb);
                    r.i += 2;
                }
                Some(GitToken::Bt) => {
                    ast.dir = Some(GitDirection::Bt);
                    r.i += 2;
                }
                _ => {
                    r.accept(GitToken::Colon);
                }
            }
        } else {
            r.accept(GitToken::Colon);
        }
    }

    while let Some(k) = r.kind() {
        match k {
            GitToken::Newline => {
                r.i += 1;
            }
            GitToken::AccDescr => {
                ast.acc_descr = Some(acc_descr_value(r.take()));
                end_of_line(&mut r)?;
            }
            GitToken::AccTitle => {
                ast.acc_title = Some(acc_title_value(r.take()));
                end_of_line(&mut r)?;
            }
            GitToken::Title => {
                ast.title = Some(title_value(r.take()));
                end_of_line(&mut r)?;
            }
            GitToken::Commit => {
                r.i += 1;
                let mut id = None;
                let mut message = None;
                let mut tags = Vec::new();
                let mut commit_type = None;
                loop {
                    if r.accept(GitToken::Id) {
                        id = Some(read_string(&mut r)?);
                    } else if r.accept(GitToken::Tag) {
                        tags.push(read_string(&mut r)?);
                    } else if r.accept(GitToken::Type) {
                        commit_type = Some(read_commit_type(&mut r)?);
                    } else if r.accept(GitToken::Msg) || r.kind() == Some(GitToken::String) {
                        message = Some(read_string(&mut r)?);
                    } else {
                        break;
                    }
                }
                end_of_line(&mut r)?;
                ast.statements.push(StatementAst::Commit {
                    id,
                    message,
                    tags,
                    commit_type,
                });
            }
            GitToken::Branch => {
                r.i += 1;
                let name = read_name(&mut r)?;
                let order = if r.accept(GitToken::Order) {
                    Some(r.expect(GitToken::Int)?.parse::<f64>().unwrap_or(0.0))
                } else {
                    None
                };
                end_of_line(&mut r)?;
                ast.statements.push(StatementAst::Branch { name, order });
            }
            GitToken::Merge => {
                r.i += 1;
                let branch = read_name(&mut r)?;
                let mut id = None;
                let mut tags = Vec::new();
                let mut commit_type = None;
                loop {
                    if r.accept(GitToken::Id) {
                        id = Some(read_string(&mut r)?);
                    } else if r.accept(GitToken::Tag) {
                        tags.push(read_string(&mut r)?);
                    } else if r.accept(GitToken::Type) {
                        commit_type = Some(read_commit_type(&mut r)?);
                    } else {
                        break;
                    }
                }
                end_of_line(&mut r)?;
                ast.statements.push(StatementAst::Merge { branch, id, tags, commit_type });
            }
            GitToken::Checkout | GitToken::Switch => {
                r.i += 1;
                let branch = read_name(&mut r)?;
                end_of_line(&mut r)?;
                ast.statements.push(StatementAst::Checkout { branch });
            }
            GitToken::CherryPick => {
                r.i += 1;
                let mut id = None;
                let mut tags = Vec::new();
                let mut parent = None;
                loop {
                    if r.accept(GitToken::Id) {
                        id = Some(read_string(&mut r)?);
                    } else if r.accept(GitToken::Tag) {
                        tags.push(read_string(&mut r)?);
                    } else if r.accept(GitToken::Parent) {
                        parent = Some(read_string(&mut r)?);
                    } else {
                        break;
                    }
                }
                end_of_line(&mut r)?;
                ast.statements.push(StatementAst::CherryPicking { id, tags, parent });
            }
            GitToken::GitGraphColon
            | GitToken::Highlight
            | GitToken::GitGraph
            | GitToken::Reverse
            | GitToken::Parent
            | GitToken::Normal
            | GitToken::Order
            | GitToken::Type
            | GitToken::Msg
            | GitToken::Tag
            | GitToken::Id
            | GitToken::Lr
            | GitToken::Tb
            | GitToken::Bt
            | GitToken::Colon
            | GitToken::Int
            | GitToken::String
            | GitToken::Reference => {
                return Err(r.fail("a statement, a title, or a line break"));
            }
        }
    }
    Ok(ast)
}
