//! Pure, deterministic link detection and hit-testing on terminal snapshots.
//!
//! Recognizes OSC 8 hyperlinks, `http://` / `https://` / `file://` URLs, and
//! local file paths (absolute, `~/...`, relative) with optional `:line`,
//! `:line:col`, `(line,col)`, or `#Lline` suffixes across soft-wrapped rows.
//! File-path candidates only match when the resolved path exists on disk.

use std::ffi::OsString;
use std::os::unix::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::{Point, Row, Snapshot};

/// Maximum number of soft-wrapped rows scanned in either direction from the
/// target row, bounding work on pathological single-line output.
const MAX_WRAP_ROWS: usize = 32;

/// Maximum byte length searched for a quoted file path containing spaces.
const MAX_QUOTED_PATH_BYTES: usize = 512;

/// Common extensionless filenames that may appear as bare tokens without `/`.
const EXTENSIONLESS_FILENAMES: &[&str] = &[
    "AUTHORS",
    "BUILD",
    "Brewfile",
    "CHANGELOG",
    "CODEOWNERS",
    "COPYING",
    "Containerfile",
    "Dockerfile",
    "Gemfile",
    "Jenkinsfile",
    "Justfile",
    "LICENSE",
    "Makefile",
    "NOTICE",
    "Procfile",
    "README",
    "Rakefile",
    "Vagrantfile",
    "WORKSPACE",
];

/// Resolved target of a clickable terminal link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkTarget {
    Url(String),
    File { path: PathBuf, line: Option<u32>, col: Option<u32> },
}

/// One contiguous range of grid columns on a single visible row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinkSpan {
    pub row: u16,
    pub start_col: u16,
    /// Exclusive end column (`start_col < end_col`).
    pub end_col: u16,
}

impl LinkSpan {
    pub fn contains(&self, at: Point) -> bool {
        at.row == self.row && at.col >= self.start_col && at.col < self.end_col
    }
}

/// A matched link on the visible terminal viewport and the cell spans it covers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkMatch {
    pub target: LinkTarget,
    /// Non-empty, ordered by `(row, start_col)`.
    pub spans: Vec<LinkSpan>,
}

impl LinkMatch {
    pub fn contains(&self, at: Point) -> bool {
        self.spans.iter().any(|span| span.contains(at))
    }
}

/// Directories used to resolve relative and `~`-prefixed file paths.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LinkResolveContext {
    pub cwd: Option<PathBuf>,
    pub project_root: Option<PathBuf>,
    pub home: Option<PathBuf>,
}

impl LinkResolveContext {
    pub fn new(cwd: Option<PathBuf>, project_root: Option<PathBuf>) -> Self {
        Self {
            cwd,
            project_root,
            home: std::env::var_os("HOME").map(PathBuf::from),
        }
    }
}

/// Returns the clickable link under viewport cell `at`, if any.
pub fn link_at(snapshot: &Snapshot, at: Point, ctx: &LinkResolveContext) -> Option<LinkMatch> {
    link_at_rows(&snapshot.rows, snapshot.size.cols, at, ctx)
}

/// Like [`link_at`], but resolves `LinkResolveContext` lazily only when a
/// relative or `~`-prefixed file-path candidate is actually under `at`.
pub fn link_at_with(snapshot: &Snapshot, at: Point, resolve_ctx: impl FnOnce() -> LinkResolveContext) -> Option<LinkMatch> {
    link_at_rows_with(&snapshot.rows, snapshot.size.cols, at, resolve_ctx)
}

/// Hit-tests `rows` (with grid width `cols`) at viewport cell `at`.
pub fn link_at_rows(rows: &[Arc<Row>], cols: u16, at: Point, ctx: &LinkResolveContext) -> Option<LinkMatch> {
    let mut resolver: Resolver<'_, fn() -> LinkResolveContext> = Resolver::Borrowed(ctx);
    hit_test_rows(rows, cols, at, &mut resolver)
}

/// Like [`link_at_rows`], evaluating `resolve_ctx` only if needed for a relative
/// or home-dir path candidate.
pub fn link_at_rows_with(rows: &[Arc<Row>], cols: u16, at: Point, resolve_ctx: impl FnOnce() -> LinkResolveContext) -> Option<LinkMatch> {
    let mut resolver = Resolver::Lazy {
        init: Some(resolve_ctx),
        cached: None,
    };
    hit_test_rows(rows, cols, at, &mut resolver)
}

enum Resolver<'a, F> {
    Borrowed(&'a LinkResolveContext),
    Lazy { init: Option<F>, cached: Option<LinkResolveContext> },
}

impl<F: FnOnce() -> LinkResolveContext> Resolver<'_, F> {
    fn get(&mut self) -> &LinkResolveContext {
        match self {
            Self::Borrowed(ctx) => ctx,
            Self::Lazy { init, cached } => {
                if cached.is_none()
                    && let Some(f) = init.take()
                {
                    *cached = Some(f());
                }
                cached.as_ref().expect("lazy resolver initialized")
            }
        }
    }
}

fn grapheme_cols(g: &str) -> u16 {
    (g.width() as u16).clamp(1, 2)
}

fn hit_test_rows<F: FnOnce() -> LinkResolveContext>(rows: &[Arc<Row>], cols: u16, at: Point, resolver: &mut Resolver<'_, F>) -> Option<LinkMatch> {
    if usize::from(at.row) >= rows.len() {
        return None;
    }

    if let Some(hit) = osc8_link_at(rows, cols, at) {
        return Some(hit);
    }

    let logical = LogicalLine::from_rows(rows, cols, at.row);
    let target_byte = logical.byte_at(at)?;

    if let Some(hit) = url_match_at(&logical, target_byte, at) {
        return Some(hit);
    }

    file_match_at(&logical, target_byte, at, resolver)
}

// ---- OSC 8 hyperlinks -----------------------------------------------------

fn osc8_link_at(rows: &[Arc<Row>], cols: u16, at: Point) -> Option<LinkMatch> {
    let row = rows.get(usize::from(at.row))?;
    let hit_idx = row
        .runs
        .iter()
        .position(|run| at.col >= run.start_col && at.col < run.start_col + run.cols && run.hyperlink.is_some())?;
    let uri = row.runs[hit_idx].hyperlink.as_deref()?;
    let target = resolve_osc8_uri(uri)?;

    let (row_start, row_end) = contiguous_hyperlink_span(row, hit_idx, uri);
    let mut spans = vec![LinkSpan {
        row: at.row,
        start_col: row_start,
        end_col: row_end,
    }];

    let min_row = usize::from(at.row).saturating_sub(MAX_WRAP_ROWS);
    let mut cur_row = usize::from(at.row);
    let mut cur_start = row_start;
    while cur_start == 0 && cur_row > min_row && rows[cur_row - 1].wrapped {
        let prev = &rows[cur_row - 1];
        let Some(last_idx) = prev.runs.len().checked_sub(1) else {
            break;
        };
        let last = &prev.runs[last_idx];
        let reaches_wrap = last.start_col + last.cols >= cols.saturating_sub(1);
        if last.hyperlink.as_deref() != Some(uri) || !reaches_wrap {
            break;
        }
        let (s, e) = contiguous_hyperlink_span(prev, last_idx, uri);
        spans.insert(
            0,
            LinkSpan {
                row: (cur_row - 1) as u16,
                start_col: s,
                end_col: e,
            },
        );
        cur_row -= 1;
        cur_start = s;
    }

    let max_row = (usize::from(at.row) + MAX_WRAP_ROWS).min(rows.len() - 1);
    let mut cur_row = usize::from(at.row);
    let mut cur_end = row_end;
    while cur_row < max_row && rows[cur_row].wrapped && cur_end >= cols.saturating_sub(1) {
        let next = &rows[cur_row + 1];
        let Some(first) = next.runs.first() else {
            break;
        };
        if first.start_col != 0 || first.hyperlink.as_deref() != Some(uri) {
            break;
        }
        let (s, e) = contiguous_hyperlink_span(next, 0, uri);
        spans.push(LinkSpan {
            row: (cur_row + 1) as u16,
            start_col: s,
            end_col: e,
        });
        cur_row += 1;
        cur_end = e;
    }

    Some(LinkMatch { target, spans })
}

fn contiguous_hyperlink_span(row: &Row, seed_idx: usize, uri: &str) -> (u16, u16) {
    let mut start = row.runs[seed_idx].start_col;
    let mut end = start + row.runs[seed_idx].cols;

    let mut i = seed_idx;
    while i > 0 {
        let prev = &row.runs[i - 1];
        if prev.hyperlink.as_deref() == Some(uri) && prev.start_col + prev.cols == start {
            start = prev.start_col;
            i -= 1;
        } else {
            break;
        }
    }
    let mut j = seed_idx + 1;
    while j < row.runs.len() {
        let next = &row.runs[j];
        if next.hyperlink.as_deref() == Some(uri) && next.start_col == end {
            end = next.start_col + next.cols;
            j += 1;
        } else {
            break;
        }
    }
    (start, end)
}

fn resolve_osc8_uri(raw: &str) -> Option<LinkTarget> {
    let uri = raw.trim();
    if starts_with_ignore_ascii_case(uri, "http://") || starts_with_ignore_ascii_case(uri, "https://") {
        return is_valid_http_url(uri).then(|| LinkTarget::Url(uri.to_string()));
    }
    if starts_with_ignore_ascii_case(uri, "file://") {
        return resolve_file_url(uri, true);
    }
    None
}

// ---- Logical line mapping -------------------------------------------------

struct CellMap {
    byte_start: usize,
    byte_end: usize,
    row: u16,
    start_col: u16,
    end_col: u16,
}

struct LogicalLine {
    text: String,
    cells: Vec<CellMap>,
}

impl LogicalLine {
    fn from_rows(rows: &[Arc<Row>], cols: u16, target_row: u16) -> Self {
        let target = usize::from(target_row);
        let min_row = target.saturating_sub(MAX_WRAP_ROWS);
        let max_row = (target + MAX_WRAP_ROWS).min(rows.len() - 1);

        let mut first_row = target;
        while first_row > min_row && rows[first_row - 1].wrapped {
            first_row -= 1;
        }
        let mut last_row = target;
        while last_row < max_row && rows[last_row].wrapped {
            last_row += 1;
        }

        let mut text = String::new();
        let mut cells = Vec::new();
        for (idx, row) in rows.iter().enumerate().take(last_row + 1).skip(first_row) {
            let row_u16 = idx as u16;
            let mut cur_col = 0u16;
            for run in &row.runs {
                if run.start_col > cur_col {
                    for c in cur_col..run.start_col {
                        let byte_start = text.len();
                        text.push(' ');
                        cells.push(CellMap {
                            byte_start,
                            byte_end: text.len(),
                            row: row_u16,
                            start_col: c,
                            end_col: c + 1,
                        });
                    }
                    cur_col = run.start_col;
                }
                for g in run.text.graphemes(true) {
                    let w = grapheme_cols(g);
                    let byte_start = text.len();
                    text.push_str(g);
                    cells.push(CellMap {
                        byte_start,
                        byte_end: text.len(),
                        row: row_u16,
                        start_col: cur_col,
                        end_col: cur_col.saturating_add(w),
                    });
                    cur_col = cur_col.saturating_add(w);
                }
            }
            // Restore trailing blanks trimmed by `screen.rs` on wrapped rows so
            // tokens separated by whitespace at the wrap edge do not fuse.
            if idx < last_row && cur_col < cols {
                for c in cur_col..cols {
                    let byte_start = text.len();
                    text.push(' ');
                    cells.push(CellMap {
                        byte_start,
                        byte_end: text.len(),
                        row: row_u16,
                        start_col: c,
                        end_col: c + 1,
                    });
                }
            }
        }
        Self { text, cells }
    }

    fn byte_at(&self, at: Point) -> Option<usize> {
        self.cells
            .iter()
            .find(|c| c.row == at.row && at.col >= c.start_col && at.col < c.end_col)
            .map(|c| c.byte_start)
    }

    fn spans_for_bytes(&self, start: usize, end: usize) -> Vec<LinkSpan> {
        if start >= end {
            return Vec::new();
        }
        let first_idx = self.cells.partition_point(|c| c.byte_end <= start);
        let mut spans: Vec<LinkSpan> = Vec::new();
        for cell in &self.cells[first_idx..] {
            if cell.byte_start >= end {
                break;
            }
            match spans.last_mut() {
                Some(last) if last.row == cell.row && last.end_col == cell.start_col => {
                    last.end_col = cell.end_col;
                }
                _ => spans.push(LinkSpan {
                    row: cell.row,
                    start_col: cell.start_col,
                    end_col: cell.end_col,
                }),
            }
        }
        spans
    }
}

// ---- URL matching ---------------------------------------------------------

fn starts_with_ignore_ascii_case(s: &str, prefix: &str) -> bool {
    s.len() >= prefix.len() && s.is_char_boundary(prefix.len()) && s[..prefix.len()].eq_ignore_ascii_case(prefix)
}

fn is_cjk_or_fullwidth_punct(c: char) -> bool {
    matches!(
        c,
        '\u{3000}'..='\u{303F}'
            | '\u{FF01}'..='\u{FF0F}'
            | '\u{FF1A}'..='\u{FF20}'
            | '\u{FF3B}'..='\u{FF40}'
            | '\u{FF5B}'..='\u{FF65}'
            | '\u{2018}'..='\u{201F}'
            | '\u{2026}'
            | '\u{2014}'
    )
}

fn is_url_stop(c: char) -> bool {
    c.is_whitespace() || c.is_control() || matches!(c, '<' | '>' | '"' | '`' | '\\' | '{' | '}' | '|' | '^') || is_cjk_or_fullwidth_punct(c)
}

fn trim_url_end(raw: &str) -> &str {
    let mut s = raw;
    while let Some(last) = s.chars().next_back() {
        let should_trim = match last {
            '.' | ',' | ';' | ':' | '!' | '?' | '\'' | '"' | '`' => true,
            ')' => {
                let open = s.bytes().filter(|&b| b == b'(').count();
                let close = s.bytes().filter(|&b| b == b')').count();
                close > open
            }
            ']' => {
                let open = s.bytes().filter(|&b| b == b'[').count();
                let close = s.bytes().filter(|&b| b == b']').count();
                close > open
            }
            _ => false,
        };
        if should_trim {
            s = &s[..s.len() - last.len_utf8()];
        } else {
            break;
        }
    }
    s
}

fn is_valid_http_url(url: &str) -> bool {
    let rest = if starts_with_ignore_ascii_case(url, "https://") {
        &url["https://".len()..]
    } else if starts_with_ignore_ascii_case(url, "http://") {
        &url["http://".len()..]
    } else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return false;
    }
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, hp)| hp);
    if host_port.is_empty() {
        return false;
    }
    if let Some(after_open) = host_port.strip_prefix('[') {
        let Some((ipv6, tail)) = after_open.split_once(']') else {
            return false;
        };
        if ipv6.is_empty() || !ipv6.bytes().all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.') {
            return false;
        }
        return tail.is_empty()
            || tail
                .strip_prefix(':')
                .is_some_and(|port| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()));
    }
    let host = match host_port.rsplit_once(':') {
        Some((h, port)) => {
            if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
                return false;
            }
            h
        }
        None => host_port,
    };
    if host.is_empty() || host.starts_with('.') || host.ends_with('.') || host.contains("..") {
        return false;
    }
    host.chars().any(char::is_alphanumeric) && host.chars().all(|c| c.is_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

fn find_next_scheme(text: &str, from: usize) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut i = from;
    while i + 7 <= bytes.len() {
        let scheme_len = if starts_with_ignore_ascii_case(&text[i..], "https://") {
            Some("https://".len())
        } else if starts_with_ignore_ascii_case(&text[i..], "http://") {
            Some("http://".len())
        } else if starts_with_ignore_ascii_case(&text[i..], "file://") {
            Some("file://".len())
        } else {
            None
        };
        if let Some(len) = scheme_len {
            let valid_left = i == 0 || !text[..i].chars().next_back().is_some_and(|c| c.is_ascii_alphanumeric());
            if valid_left {
                return Some((i, len));
            }
        }
        let step = text[i..].chars().next().map_or(1, char::len_utf8);
        i += step;
    }
    None
}

fn url_match_at(logical: &LogicalLine, target_byte: usize, at: Point) -> Option<LinkMatch> {
    let text = &logical.text;
    let mut cursor = 0;
    while let Some((start, scheme_len)) = find_next_scheme(text, cursor) {
        if start > target_byte {
            break;
        }
        let raw_end = text[start + scheme_len..].find(is_url_stop).map_or(text.len(), |off| start + scheme_len + off);
        let trimmed = trim_url_end(&text[start..raw_end]);
        let end = start + trimmed.len();
        cursor = end.max(start + scheme_len);
        if target_byte < start || target_byte >= end {
            continue;
        }
        let target = if starts_with_ignore_ascii_case(trimmed, "file://") {
            resolve_file_url(trimmed, true)?
        } else if is_valid_http_url(trimmed) {
            LinkTarget::Url(trimmed.to_string())
        } else {
            continue;
        };
        let spans = logical.spans_for_bytes(start, end);
        if spans.iter().any(|span| span.contains(at)) {
            return Some(LinkMatch { target, spans });
        }
    }
    None
}

fn resolve_file_url(url: &str, allow_dir: bool) -> Option<LinkTarget> {
    let rest = if starts_with_ignore_ascii_case(url, "file://") {
        &url["file://".len()..]
    } else {
        return None;
    };
    let slash = rest.find('/')?;
    let host = &rest[..slash];
    if host.chars().any(char::is_whitespace) {
        return None;
    }
    let path_part = &rest[slash..];
    let (without_frag, frag) = match path_part.split_once('#') {
        Some((p, f)) => (p, Some(f)),
        None => (path_part, None),
    };
    let without_query = without_frag.split_once('?').map_or(without_frag, |(p, _)| p);
    let decoded_bytes: Vec<u8> = percent_encoding::percent_decode(without_query.as_bytes()).collect();
    let decoded = PathBuf::from(OsString::from_vec(decoded_bytes));
    if decoded.as_os_str().len() <= 1 {
        return None;
    }
    let (frag_line, frag_col) = frag.and_then(parse_hash_location).unwrap_or((None, None));

    if path_matches_kind(&decoded, allow_dir) {
        let canonical = canonical_or_keep(decoded);
        return Some(LinkTarget::File {
            path: canonical,
            line: frag_line,
            col: frag_col,
        });
    }

    if frag_line.is_none()
        && let Some(decoded_str) = decoded.to_str()
    {
        let (base, line, col) = parse_path_and_location(decoded_str);
        if base.len() < decoded_str.len() {
            let candidate = PathBuf::from(base);
            if path_matches_kind(&candidate, allow_dir) {
                return Some(LinkTarget::File {
                    path: canonical_or_keep(candidate),
                    line,
                    col,
                });
            }
        }
    }
    None
}

fn path_matches_kind(path: &Path, allow_dir: bool) -> bool {
    std::fs::metadata(path).is_ok_and(|meta| meta.is_file() || (allow_dir && meta.is_dir()))
}

fn canonical_or_keep(path: PathBuf) -> PathBuf {
    std::fs::canonicalize(&path).unwrap_or(path)
}

// ---- File path matching ---------------------------------------------------

fn file_match_at<F: FnOnce() -> LinkResolveContext>(logical: &LogicalLine, target_byte: usize, at: Point, resolver: &mut Resolver<'_, F>) -> Option<LinkMatch> {
    let text = &logical.text;

    if let Some((tok_start, tok_end)) = token_bounds_around(text, target_byte)
        && let Some((match_start, match_end, target)) = resolve_within_token(text, tok_start, tok_end, target_byte, resolver)
    {
        let spans = logical.spans_for_bytes(match_start, match_end);
        if spans.iter().any(|span| span.contains(at)) {
            return Some(LinkMatch { target, spans });
        }
    }

    if let Some((match_start, match_end, target)) = resolve_quoted_path_at(text, target_byte, resolver) {
        let spans = logical.spans_for_bytes(match_start, match_end);
        if spans.iter().any(|span| span.contains(at)) {
            return Some(LinkMatch { target, spans });
        }
    }

    None
}

/// Finds the whitespace-delimited token around `target_byte`, bridging a
/// single space inside a trailing `(line, col)` location suffix.
fn token_bounds_around(text: &str, target_byte: usize) -> Option<(usize, usize)> {
    let cur_char = text[target_byte..].chars().next()?;
    if cur_char.is_whitespace() {
        // Allow hovering the single space in `path(42, 10)`.
        if cur_char == ' '
            && let Some((s, e)) = paren_space_bridge(text, target_byte)
        {
            return Some((s, e));
        }
        return None;
    }

    let mut start = text[..target_byte]
        .rfind(char::is_whitespace)
        .map_or(0, |i| i + text[i..].chars().next().map_or(1, char::len_utf8));
    let mut end = text[target_byte..].find(char::is_whitespace).map_or(text.len(), |off| target_byte + off);

    // If token ends with `(<digits>,` and is followed by ` <digits>)`, bridge across.
    if text.as_bytes().get(end) == Some(&b' ')
        && let Some((s, e)) = paren_space_bridge(text, end)
        && s == start
    {
        end = e;
    }

    // If token is `<digits>)...` immediately preceded by `(<digits>, `, bridge backwards.
    if start >= 1
        && text.as_bytes()[start - 1] == b' '
        && let Some((s, e)) = paren_space_bridge(text, start - 1)
        && e == end
    {
        start = s;
    }

    Some((start, end))
}

/// If `space_idx` points to the space in `<path>(<digits>, <digits>)`, returns
/// the full token range `(start, end)`.
fn paren_space_bridge(text: &str, space_idx: usize) -> Option<(usize, usize)> {
    let left_end = space_idx;
    let left_start = text[..left_end]
        .rfind(char::is_whitespace)
        .map_or(0, |i| i + text[i..].chars().next().map_or(1, char::len_utf8));
    let left = &text[left_start..left_end];
    let left_before_comma = left.strip_suffix(',')?;
    let open = left_before_comma.rfind('(')?;
    let line_part = &left_before_comma[open + 1..];
    if open == 0 || line_part.is_empty() || !line_part.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }

    let right_start = space_idx + 1;
    let right_end = text[right_start..].find(char::is_whitespace).map_or(text.len(), |off| right_start + off);
    let right = &text[right_start..right_end];
    let close = right.find(')')?;
    let col_part = &right[..close];
    if col_part.is_empty() || !col_part.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((left_start, right_end))
}

fn is_hard_path_delim(c: char) -> bool {
    matches!(c, '"' | '\'' | '`' | '<' | '>' | '{' | '}' | '[' | ']' | '|' | ';' | '=') || is_cjk_or_fullwidth_punct(c)
}

fn trim_path_wrappers(s: &str, base_offset: usize) -> (usize, usize) {
    let mut start = 0usize;
    let mut end = s.len();

    while start < end {
        let ch = s[start..end].chars().next().unwrap();
        if matches!(ch, '(' | '[' | '{' | '<' | '\'' | '"' | '`' | ',' | ';') || is_cjk_or_fullwidth_punct(ch) {
            start += ch.len_utf8();
        } else {
            break;
        }
    }

    while start < end {
        let slice = &s[start..end];
        let Some(ch) = slice.chars().next_back() else {
            break;
        };
        let should_trim = match ch {
            '.' | ',' | ';' | ':' | '!' | '?' | '\'' | '"' | '`' | '>' | '}' => true,
            ')' => {
                let open = slice.bytes().filter(|&b| b == b'(').count();
                let close = slice.bytes().filter(|&b| b == b')').count();
                close > open
            }
            ']' => {
                let open = slice.bytes().filter(|&b| b == b'[').count();
                let close = slice.bytes().filter(|&b| b == b']').count();
                close > open
            }
            c if is_cjk_or_fullwidth_punct(c) => true,
            _ => false,
        };
        if should_trim {
            end -= ch.len_utf8();
        } else {
            break;
        }
    }

    (base_offset + start, base_offset + end)
}

/// Splits a whitespace token into the sub-segment containing `target_byte`,
/// respecting hard delimiters (and commas outside trailing `(line,col)`).
fn split_subsegment(text: &str, tok_start: usize, tok_end: usize, target_byte: usize) -> (usize, usize) {
    let tok = &text[tok_start..tok_end];
    let rel = target_byte - tok_start;

    let mut seg_start = 0usize;
    for (idx, ch) in tok[..rel].char_indices().rev() {
        if is_hard_path_delim(ch) || (ch == ',' && !comma_inside_location_parens(tok, idx)) {
            seg_start = idx + ch.len_utf8();
            break;
        }
    }

    let mut seg_end = tok.len();
    for (off, ch) in tok[rel..].char_indices() {
        let idx = rel + off;
        if is_hard_path_delim(ch) || (ch == ',' && !comma_inside_location_parens(tok, idx)) {
            seg_end = idx;
            break;
        }
    }

    (tok_start + seg_start, tok_start + seg_end)
}

fn comma_inside_location_parens(tok: &str, comma_idx: usize) -> bool {
    let Some(open) = tok[..comma_idx].rfind('(') else {
        return false;
    };
    let before = tok[open + 1..comma_idx].trim();
    if before.is_empty() || !before.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let after = &tok[comma_idx + 1..];
    let Some(close) = after.find(')') else {
        return false;
    };
    let col_part = after[..close].trim();
    !col_part.is_empty() && col_part.bytes().all(|b| b.is_ascii_digit())
}

fn resolve_within_token<F: FnOnce() -> LinkResolveContext>(
    text: &str,
    tok_start: usize,
    tok_end: usize,
    target_byte: usize,
    resolver: &mut Resolver<'_, F>,
) -> Option<(usize, usize, LinkTarget)> {
    let (seg_start, seg_end) = split_subsegment(text, tok_start, tok_end, target_byte);
    let (s, e) = trim_path_wrappers(&text[seg_start..seg_end], seg_start);
    if let Some(hit) = try_span(text, s, e, target_byte, resolver) {
        return Some(hit);
    }

    // Handle `fn(src/foo.rs:10)` or `at foo(/abs/path.js:12:3)` where `(` sits mid-segment.
    if s < e && target_byte >= s && target_byte < e {
        let segment = &text[s..e];
        let rel_target = target_byte - s;
        if let Some(open) = segment[..rel_target].rfind('(') {
            let (ns, ne) = trim_path_wrappers(&segment[open + 1..], s + open + 1);
            if let Some(hit) = try_span(text, ns, ne, target_byte, resolver) {
                return Some(hit);
            }
        }

        // Handle `git diff` prefixes (`a/src/foo.rs`, `b/src/foo.rs`).
        if (segment.starts_with("a/") || segment.starts_with("b/")) && segment.len() > 2 {
            let stripped_start = s + 2;
            if let Some(hit) = try_span(text, stripped_start, e, target_byte, resolver) {
                return Some(hit);
            }
        }

        // Handle `prefix:path/to/file.rs:42` or `PATH`-style colon lists.
        for (colon_off, ch) in segment[..rel_target].char_indices().rev() {
            if ch == ':' {
                let after = s + colon_off + 1;
                let (ns, ne) = trim_path_wrappers(&text[after..e], after);
                if let Some(hit) = try_span(text, ns, ne, target_byte, resolver) {
                    return Some(hit);
                }
                // Also try slicing before a later non-numeric colon (e.g. `/usr/bin:/bin`).
                if target_byte < ne
                    && let Some(next_colon) = text[target_byte..ne].find(':')
                {
                    let before_next = target_byte + next_colon;
                    if let Some(hit) = try_span(text, ns, before_next, target_byte, resolver) {
                        return Some(hit);
                    }
                }
            }
        }
        if let Some(next_colon) = text[target_byte..e].find(':') {
            let before_next = target_byte + next_colon;
            if let Some(hit) = try_span(text, s, before_next, target_byte, resolver) {
                return Some(hit);
            }
        }
    }

    None
}

fn try_span<F: FnOnce() -> LinkResolveContext>(
    text: &str,
    start: usize,
    end: usize,
    target_byte: usize,
    resolver: &mut Resolver<'_, F>,
) -> Option<(usize, usize, LinkTarget)> {
    if start >= end || target_byte < start || target_byte >= end {
        return None;
    }
    let target = resolve_file_candidate(&text[start..end], resolver)?;
    Some((start, end, target))
}

fn resolve_quoted_path_at<F: FnOnce() -> LinkResolveContext>(
    text: &str,
    target_byte: usize,
    resolver: &mut Resolver<'_, F>,
) -> Option<(usize, usize, LinkTarget)> {
    let min_left = target_byte.saturating_sub(MAX_QUOTED_PATH_BYTES);
    let max_right = text.floor_char_boundary(target_byte.saturating_add(MAX_QUOTED_PATH_BYTES).min(text.len()));
    for quote in ['"', '\''] {
        let Some(open_rel) = text[..target_byte].rfind(quote) else {
            continue;
        };
        if open_rel < min_left {
            continue;
        }
        let inner_start = open_rel + 1;
        let Some(close_off) = text[target_byte..max_right].find(quote) else {
            continue;
        };
        let inner_end = target_byte + close_off;
        if inner_start >= inner_end || inner_end - inner_start > MAX_QUOTED_PATH_BYTES {
            continue;
        }
        let inner = &text[inner_start..inner_end];
        if !inner.contains(' ') {
            continue;
        }
        if let Some(target) = resolve_file_candidate(inner, resolver) {
            return Some((inner_start, inner_end, target));
        }
    }
    None
}

fn resolve_file_candidate<F: FnOnce() -> LinkResolveContext>(raw: &str, resolver: &mut Resolver<'_, F>) -> Option<LinkTarget> {
    if raw.is_empty() || raw.contains('\0') || raw.contains("://") {
        return None;
    }

    let (base, line, col) = parse_path_and_location(raw);
    if looks_like_path_candidate(base)
        && let Some(path) = resolve_existing_file(base, resolver)
    {
        return Some(LinkTarget::File { path, line, col });
    }

    // Fallback: a file whose literal name contains a `:12` or `(1)` suffix.
    if base.len() < raw.len()
        && looks_like_path_candidate(raw)
        && let Some(path) = resolve_existing_file(raw, resolver)
    {
        return Some(LinkTarget::File { path, line: None, col: None });
    }

    None
}

fn looks_like_path_candidate(path: &str) -> bool {
    if path.is_empty() || matches!(path, "." | ".." | "/" | "~" | "~/" | "./" | "../") || path.starts_with("//") || path.ends_with('/') {
        return false;
    }
    if path.starts_with('/') || path.starts_with("~/") || path.starts_with("./") || path.starts_with("../") {
        return path.chars().any(char::is_alphanumeric);
    }
    if path.contains('/') {
        return path.chars().any(char::is_alphanumeric);
    }
    if EXTENSIONLESS_FILENAMES.contains(&path) {
        return true;
    }
    // Single filename without `/`: require a dot plus at least one letter so
    // plain prose words and bare version numbers (`1.2.3`) skip `stat`.
    if let Some((stem, ext)) = path.rsplit_once('.')
        && (!stem.is_empty() || !ext.is_empty())
        && path.chars().any(char::is_alphabetic)
    {
        return true;
    }
    false
}

fn resolve_existing_file<F: FnOnce() -> LinkResolveContext>(path_str: &str, resolver: &mut Resolver<'_, F>) -> Option<PathBuf> {
    if let Some(after_tilde) = path_str.strip_prefix("~/") {
        let home = resolver.get().home.as_ref()?;
        let candidate = home.join(after_tilde);
        return candidate.is_file().then(|| canonical_or_keep(candidate));
    }

    let path = Path::new(path_str);
    if path.is_absolute() {
        return path.is_file().then(|| canonical_or_keep(path.to_path_buf()));
    }

    let ctx = resolver.get();
    if let Some(cwd) = &ctx.cwd {
        let candidate = cwd.join(path);
        if candidate.is_file() {
            return Some(canonical_or_keep(candidate));
        }
    }
    if let Some(root) = &ctx.project_root
        && ctx.cwd.as_deref() != Some(root.as_path())
    {
        let candidate = root.join(path);
        if candidate.is_file() {
            return Some(canonical_or_keep(candidate));
        }
    }
    None
}

/// Splits an optional `(line,col)`, `(line)`, `#Lline[Ccol]`, `:line:col`, or
/// `:line` location suffix from a path string.
pub(crate) fn parse_path_and_location(raw: &str) -> (&str, Option<u32>, Option<u32>) {
    if let Some(without_close) = raw.strip_suffix(')')
        && let Some(open) = without_close.rfind('(')
        && open > 0
    {
        let base = &without_close[..open];
        let inside = &without_close[open + 1..];
        if let Some((l, c)) = inside.split_once(',') {
            let l = l.trim();
            let c = c.trim();
            if let (Some(line), Some(col)) = (parse_ascii_u32(l), parse_ascii_u32(c)) {
                return (base, positive_u32(line), positive_u32(col));
            }
        } else if let Some(line) = parse_ascii_u32(inside.trim()) {
            return (base, positive_u32(line), None);
        }
    }

    if let Some((base, frag)) = raw.rsplit_once('#')
        && !base.is_empty()
        && let Some((line, col)) = parse_hash_location(frag)
    {
        return (base, line, col);
    }

    if let Some((left, last)) = raw.rsplit_once(':')
        && !left.is_empty()
        && let Some(n1) = parse_ascii_u32(last)
    {
        if let Some((path, line_str)) = left.rsplit_once(':')
            && !path.is_empty()
            && let Some(line) = parse_ascii_u32(line_str)
        {
            return (path, positive_u32(line), positive_u32(n1));
        }
        return (left, positive_u32(n1), None);
    }

    (raw, None, None)
}

fn parse_hash_location(frag: &str) -> Option<(Option<u32>, Option<u32>)> {
    let body = frag.strip_prefix('L').or_else(|| frag.strip_prefix('l')).unwrap_or(frag);
    if let Some((line_part, col_part)) = body.split_once(['C', 'c']) {
        let line = parse_ascii_u32(line_part)?;
        let col = parse_ascii_u32(col_part)?;
        return Some((positive_u32(line), positive_u32(col)));
    }
    if let Some((start_part, end_part)) = body.split_once('-') {
        let line = parse_ascii_u32(start_part)?;
        let end_digits = end_part.strip_prefix('L').or_else(|| end_part.strip_prefix('l')).unwrap_or(end_part);
        let _ = parse_ascii_u32(end_digits)?;
        return Some((positive_u32(line), None));
    }
    let line = parse_ascii_u32(body)?;
    Some((positive_u32(line), None))
}

fn parse_ascii_u32(s: &str) -> Option<u32> {
    (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        .then(|| s.parse::<u32>().ok())
        .flatten()
}

fn positive_u32(n: u32) -> Option<u32> {
    (n > 0).then_some(n)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::{CellStyle, Rgb, Run};

    fn default_style() -> CellStyle {
        CellStyle {
            fg: Rgb(220, 220, 220),
            bg: None,
            bold: false,
            italic: false,
            dim: false,
            underline: false,
            strikethrough: false,
        }
    }

    fn row(text: &str) -> Arc<Row> {
        row_wrapped(text, false)
    }

    fn row_wrapped(text: &str, wrapped: bool) -> Arc<Row> {
        let cols: u16 = text.graphemes(true).map(grapheme_cols).sum();
        Arc::new(Row {
            runs: vec![Run {
                start_col: 0,
                cols,
                text: text.to_string(),
                style: default_style(),
                hyperlink: None,
            }],
            wrapped,
        })
    }

    fn pt(row: u16, col: u16) -> Point {
        Point { row, col }
    }

    fn col_of(line: &str, needle: &str) -> u16 {
        let idx = line.find(needle).expect("needle in line");
        line[..idx].graphemes(true).map(grapheme_cols).sum()
    }

    #[test]
    fn url_matching_handles_ports_queries_balanced_parens_and_trailing_punctuation() {
        let ctx = LinkResolveContext::default();
        let line = concat!(
            "see (https://en.wikipedia.org/wiki/Rust_(programming_language)), ",
            "http://127.0.0.1:8787/api/v1/slice/board?foo=1&bar=2#top; ",
            "[http://[::1]:8080/a[0]]. ",
            "\"https://example.com/path!\""
        );
        let rows = vec![row(line)];

        let wiki_col = col_of(line, "https://en.wikipedia");
        let wiki = link_at_rows(&rows, 240, pt(0, wiki_col + 10), &ctx).expect("wiki url");
        assert_eq!(wiki.target, LinkTarget::Url("https://en.wikipedia.org/wiki/Rust_(programming_language)".into()));
        assert_eq!(
            wiki.spans,
            vec![LinkSpan {
                row: 0,
                start_col: wiki_col,
                end_col: wiki_col + "https://en.wikipedia.org/wiki/Rust_(programming_language)".len() as u16,
            }]
        );
        // Outer closing paren is excluded from the link span.
        assert_eq!(link_at_rows(&rows, 240, pt(0, wiki.spans[0].end_col), &ctx), None);

        let local_col = col_of(line, "http://127.0.0.1");
        let local = link_at_rows(&rows, 240, pt(0, local_col + 5), &ctx).expect("local url");
        assert_eq!(local.target, LinkTarget::Url("http://127.0.0.1:8787/api/v1/slice/board?foo=1&bar=2#top".into()));

        let ipv6_col = col_of(line, "http://[::1]");
        let ipv6 = link_at_rows(&rows, 240, pt(0, ipv6_col + 4), &ctx).expect("ipv6 url");
        assert_eq!(ipv6.target, LinkTarget::Url("http://[::1]:8080/a[0]".into()));

        let quoted_col = col_of(line, "https://example.com");
        let quoted = link_at_rows(&rows, 240, pt(0, quoted_col + 2), &ctx).expect("quoted url");
        assert_eq!(quoted.target, LinkTarget::Url("https://example.com/path".into()));
    }

    #[test]
    fn url_matching_handles_cjk_surrounding_punctuation_and_rejects_empty_hosts() {
        let ctx = LinkResolveContext::default();
        let line = "请打开（https://example.com/docs），或者 http:// 与 https://. 结束";
        let rows = vec![row(line)];

        let url_col = col_of(line, "https://example.com");
        let hit = link_at_rows(&rows, 120, pt(0, url_col + 3), &ctx).expect("cjk-wrapped url");
        assert_eq!(hit.target, LinkTarget::Url("https://example.com/docs".into()));
        assert_eq!(
            hit.spans,
            vec![LinkSpan {
                row: 0,
                start_col: url_col,
                end_col: url_col + "https://example.com/docs".len() as u16,
            }]
        );

        assert_eq!(link_at_rows(&rows, 120, pt(0, col_of(line, "http://") + 2), &ctx), None);
        assert_eq!(link_at_rows(&rows, 120, pt(0, col_of(line, "https://.") + 2), &ctx), None);
    }

    #[test]
    fn soft_wrapped_url_and_file_path_match_across_rows() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("crates/demo/src");
        fs::create_dir_all(&nested).unwrap();
        let file = nested.join("very_long_module.rs");
        fs::write(&file, "fn main() {}\n").unwrap();
        let canonical = fs::canonicalize(&file).unwrap();

        let ctx = LinkResolveContext {
            cwd: Some(dir.path().to_path_buf()),
            project_root: None,
            home: None,
        };

        // 24-column viewport where URL wraps across two rows.
        let r0 = row_wrapped("open https://example.com", true);
        let r1 = row_wrapped("/deep/path/page.html ok", false);
        let rows = vec![r0, r1];
        let hit_top = link_at_rows(&rows, 24, pt(0, 10), &ctx).expect("url top half");
        let hit_bot = link_at_rows(&rows, 24, pt(1, 5), &ctx).expect("url bottom half");
        assert_eq!(hit_top, hit_bot);
        assert_eq!(hit_top.target, LinkTarget::Url("https://example.com/deep/path/page.html".into()));
        assert_eq!(
            hit_top.spans,
            vec![
                LinkSpan {
                    row: 0,
                    start_col: 5,
                    end_col: 24,
                },
                LinkSpan {
                    row: 1,
                    start_col: 0,
                    end_col: 20,
                },
            ]
        );

        // Wrapped file path with `:line:col` split onto the second row.
        let f0 = row_wrapped("--> crates/demo/src/very", true);
        let f1 = row_wrapped("_long_module.rs:42:7 err", false);
        let frows = vec![f0, f1];
        let fhit = link_at_rows(&frows, 24, pt(1, 16), &ctx).expect("wrapped file hit on :line:col");
        assert_eq!(
            fhit.target,
            LinkTarget::File {
                path: canonical,
                line: Some(42),
                col: Some(7),
            }
        );
        assert_eq!(
            fhit.spans,
            vec![
                LinkSpan {
                    row: 0,
                    start_col: 4,
                    end_col: 24,
                },
                LinkSpan {
                    row: 1,
                    start_col: 0,
                    end_col: 20,
                },
            ]
        );
    }

    #[test]
    fn trimmed_trailing_space_on_wrapped_row_does_not_fuse_adjacent_tokens() {
        let ctx = LinkResolveContext::default();
        // `see ` wrapped at col 10 -> `screen.rs` trims trailing spaces on row 0, leaving cols 0..3.
        let r0 = row_wrapped("see", true);
        let r1 = row_wrapped("https://example.com", false);
        let rows = vec![r0, r1];
        let hit = link_at_rows(&rows, 10, pt(1, 2), &ctx).expect("url on second row");
        assert_eq!(hit.target, LinkTarget::Url("https://example.com".into()));
        assert_eq!(
            hit.spans,
            vec![LinkSpan {
                row: 1,
                start_col: 0,
                end_col: 19,
            }]
        );
        assert_eq!(link_at_rows(&rows, 10, pt(0, 1), &ctx), None);
    }

    #[test]
    fn file_paths_resolve_relative_project_root_home_absolute_and_reject_missing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        let sub = root.join("crates/sub");
        let home = dir.path().join("home");
        fs::create_dir_all(&sub).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(&home).unwrap();

        let root_lib = root.join("src/lib.rs");
        let sub_main = sub.join("main.rs");
        let sub_sibling = root.join("crates/other.md");
        let home_note = home.join("todo.md");
        let abs_file = dir.path().join("abs_file.ts");
        fs::write(&root_lib, "pub fn a() {}\n").unwrap();
        fs::write(&sub_main, "fn main() {}\n").unwrap();
        fs::write(&sub_sibling, "# sibling\n").unwrap();
        fs::write(&home_note, "# todo\n").unwrap();
        fs::write(&abs_file, "export {};\n").unwrap();

        let ctx = LinkResolveContext {
            cwd: Some(sub.clone()),
            project_root: Some(root.clone()),
            home: Some(home.clone()),
        };

        // 1. CWD-relative `./main.rs:12`
        let line = "./main.rs:12";
        let hit = link_at_rows(&[row(line)], 80, pt(0, 2), &ctx).expect("cwd relative");
        assert_eq!(
            hit.target,
            LinkTarget::File {
                path: fs::canonicalize(&sub_main).unwrap(),
                line: Some(12),
                col: None,
            }
        );

        // 2. Parent-relative `../other.md:3:8`
        let line = "see ../other.md:3:8;";
        let hit = link_at_rows(&[row(line)], 80, pt(0, 6), &ctx).expect("parent relative");
        assert_eq!(
            hit.target,
            LinkTarget::File {
                path: fs::canonicalize(&sub_sibling).unwrap(),
                line: Some(3),
                col: Some(8),
            }
        );

        // 3. Project-root fallback `src/lib.rs(42,10)` and `src/lib.rs(42, 10)`
        for sample in ["src/lib.rs(42,10): err", "src/lib.rs(42, 10): err"] {
            let hit = link_at_rows(&[row(sample)], 80, pt(0, 4), &ctx).expect(sample);
            assert_eq!(
                hit.target,
                LinkTarget::File {
                    path: fs::canonicalize(&root_lib).unwrap(),
                    line: Some(42),
                    col: Some(10),
                }
            );
            // Clicking on the column number inside `(42, 10)` hits the same link.
            let col_idx = col_of(sample, "10");
            assert_eq!(link_at_rows(&[row(sample)], 80, pt(0, col_idx), &ctx), Some(hit));
        }

        // 4. Home-dir `~/todo.md#L9`
        let line = "open ~/todo.md#L9 now";
        let hit = link_at_rows(&[row(line)], 80, pt(0, 7), &ctx).expect("home file");
        assert_eq!(
            hit.target,
            LinkTarget::File {
                path: fs::canonicalize(&home_note).unwrap(),
                line: Some(9),
                col: None,
            }
        );

        // 5. Absolute path wrapped in parens (node stack trace)
        let line = format!("at run ({}:7:3)", abs_file.display());
        let start = col_of(&line, &abs_file.display().to_string());
        let hit = link_at_rows(&[row(&line)], 200, pt(0, start + 1), &ctx).expect("abs file");
        assert_eq!(
            hit.target,
            LinkTarget::File {
                path: fs::canonicalize(&abs_file).unwrap(),
                line: Some(7),
                col: Some(3),
            }
        );

        // 6. Git diff `a/` / `b/` prefix
        let line = "+++ b/src/lib.rs";
        let hit = link_at_rows(&[row(line)], 80, pt(0, 8), &ctx).expect("git diff path");
        assert_eq!(
            hit.target,
            LinkTarget::File {
                path: fs::canonicalize(&root_lib).unwrap(),
                line: None,
                col: None,
            }
        );
        assert_eq!(
            hit.spans,
            vec![LinkSpan {
                row: 0,
                start_col: 6,
                end_col: 16,
            }]
        );

        // 7. Non-existent file and directories are rejected.
        let missing = "src/does_not_exist.rs:10 /no/such/file.rs ~/missing.md";
        let rows = vec![row(missing)];
        assert_eq!(link_at_rows(&rows, 100, pt(0, 4), &ctx), None);
        assert_eq!(link_at_rows(&rows, 100, pt(0, col_of(missing, "/no/such") + 2), &ctx), None);
        assert_eq!(link_at_rows(&rows, 100, pt(0, col_of(missing, "~/missing") + 2), &ctx), None);
        // Bare directory path in plain text is not matched as a file link.
        let dir_line = format!("{}", sub.display());
        assert_eq!(link_at_rows(&[row(&dir_line)], 120, pt(0, 2), &ctx), None);
    }

    #[test]
    fn cwd_takes_precedence_over_project_root_for_same_relative_name() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        let sub = root.join("pkg");
        fs::create_dir_all(&sub).unwrap();
        let root_toml = root.join("Cargo.toml");
        let sub_toml = sub.join("Cargo.toml");
        fs::write(&root_toml, "[workspace]\n").unwrap();
        fs::write(&sub_toml, "[package]\n").unwrap();

        let ctx = LinkResolveContext {
            cwd: Some(sub),
            project_root: Some(root),
            home: None,
        };
        let hit = link_at_rows(&[row("Cargo.toml")], 80, pt(0, 3), &ctx).expect("Cargo.toml");
        assert_eq!(
            hit.target,
            LinkTarget::File {
                path: fs::canonicalize(&sub_toml).unwrap(),
                line: None,
                col: None,
            }
        );
    }

    #[test]
    fn file_url_decodes_percent_escapes_and_checks_existence() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("my file.txt");
        fs::write(&file, "hi\n").unwrap();
        let canonical = fs::canonicalize(&file).unwrap();

        let encoded = format!("file://localhost{}/my%20file.txt:5:2", dir.path().display());
        let rows = vec![row(&encoded)];
        let ctx = LinkResolveContext::default();
        let hit = link_at_rows(&rows, 200, pt(0, 12), &ctx).expect("file url");
        assert_eq!(
            hit.target,
            LinkTarget::File {
                path: canonical,
                line: Some(5),
                col: Some(2),
            }
        );

        let missing = format!("file://{}/nope.txt", dir.path().display());
        assert_eq!(link_at_rows(&[row(&missing)], 200, pt(0, 5), &ctx), None);
    }

    #[test]
    fn osc8_hyperlinks_span_styled_runs_and_wrapped_rows() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("readme.md");
        fs::write(&file, "hi\n").unwrap();
        let canonical = fs::canonicalize(&file).unwrap();
        let ctx = LinkResolveContext::default();

        let url: Arc<str> = Arc::from("https://vibevalley.dev/docs");
        let bold = CellStyle { bold: true, ..default_style() };
        let r0 = Arc::new(Row {
            runs: vec![
                Run {
                    start_col: 0,
                    cols: 4,
                    text: "see ".into(),
                    style: default_style(),
                    hyperlink: None,
                },
                Run {
                    start_col: 4,
                    cols: 5,
                    text: "click".into(),
                    style: default_style(),
                    hyperlink: Some(url.clone()),
                },
                Run {
                    start_col: 9,
                    cols: 5,
                    text: " here".into(),
                    style: bold,
                    hyperlink: Some(url.clone()),
                },
            ],
            wrapped: true,
        });
        let r1 = Arc::new(Row {
            runs: vec![
                Run {
                    start_col: 0,
                    cols: 3,
                    text: "now".into(),
                    style: default_style(),
                    hyperlink: Some(url.clone()),
                },
                Run {
                    start_col: 3,
                    cols: 4,
                    text: " end".into(),
                    style: default_style(),
                    hyperlink: None,
                },
            ],
            wrapped: false,
        });
        let rows = vec![r0, r1];
        let hit = link_at_rows(&rows, 14, pt(0, 10), &ctx).expect("osc8 wrapped");
        assert_eq!(hit.target, LinkTarget::Url("https://vibevalley.dev/docs".into()));
        assert_eq!(
            hit.spans,
            vec![
                LinkSpan {
                    row: 0,
                    start_col: 4,
                    end_col: 14,
                },
                LinkSpan {
                    row: 1,
                    start_col: 0,
                    end_col: 3,
                },
            ]
        );
        assert_eq!(link_at_rows(&rows, 14, pt(1, 5), &ctx), None);

        // OSC 8 file:// hyperlink
        let file_uri: Arc<str> = Arc::from(format!("file://{}", file.display()));
        let file_row = Arc::new(Row {
            runs: vec![Run {
                start_col: 0,
                cols: 6,
                text: "readme".into(),
                style: default_style(),
                hyperlink: Some(file_uri),
            }],
            wrapped: false,
        });
        let fhit = link_at_rows(&[file_row], 80, pt(0, 2), &ctx).expect("osc8 file");
        assert_eq!(
            fhit.target,
            LinkTarget::File {
                path: canonical,
                line: None,
                col: None,
            }
        );

        // Unsafe OSC 8 scheme is ignored.
        let js_row = Arc::new(Row {
            runs: vec![Run {
                start_col: 0,
                cols: 3,
                text: "bad".into(),
                style: default_style(),
                hyperlink: Some(Arc::from("javascript:alert(1)")),
            }],
            wrapped: false,
        });
        assert_eq!(link_at_rows(&[js_row], 80, pt(0, 1), &ctx), None);
    }

    #[test]
    fn lazy_resolver_skips_cwd_lookup_for_urls_and_plain_words() {
        let mut called = 0usize;
        let rows = vec![row("hello https://example.com world")];
        let hit = link_at_rows_with(&rows, 80, pt(0, 10), || {
            called += 1;
            LinkResolveContext::default()
        });
        assert_eq!(hit.map(|h| h.target), Some(LinkTarget::Url("https://example.com".into())));
        assert_eq!(called, 0);

        let plain = link_at_rows_with(&rows, 80, pt(0, 1), || {
            called += 1;
            LinkResolveContext::default()
        });
        assert_eq!(plain, None);
        assert_eq!(called, 0);
    }

    #[test]
    fn quoted_path_with_spaces_and_flag_equals_paths_match() {
        let dir = tempfile::tempdir().unwrap();
        let spaced = dir.path().join("My Notes/hello world.md");
        fs::create_dir_all(spaced.parent().unwrap()).unwrap();
        fs::write(&spaced, "hi\n").unwrap();
        let cfg = dir.path().join("config.toml");
        fs::write(&cfg, "x = 1\n").unwrap();

        let ctx = LinkResolveContext {
            cwd: Some(dir.path().to_path_buf()),
            project_root: None,
            home: None,
        };

        let quoted_line = format!("File \"{}\" line 1", spaced.display());
        let col = col_of(&quoted_line, "hello");
        let hit = link_at_rows(&[row(&quoted_line)], 200, pt(0, col), &ctx).expect("quoted path");
        assert_eq!(
            hit.target,
            LinkTarget::File {
                path: fs::canonicalize(&spaced).unwrap(),
                line: None,
                col: None,
            }
        );

        let flag_line = "--config=config.toml";
        let hit = link_at_rows(&[row(flag_line)], 80, pt(0, 12), &ctx).expect("flag=path");
        assert_eq!(
            hit.target,
            LinkTarget::File {
                path: fs::canonicalize(&cfg).unwrap(),
                line: None,
                col: None,
            }
        );
        assert_eq!(
            hit.spans,
            vec![LinkSpan {
                row: 0,
                start_col: 9,
                end_col: 20,
            }]
        );
    }

    #[test]
    fn wide_cjk_prefixes_cjk_filenames_comma_lists_and_extensionless_files_match() {
        let dir = tempfile::tempdir().unwrap();
        let note_dir = dir.path().join("笔记");
        fs::create_dir_all(&note_dir).unwrap();
        let note = note_dir.join("说明.md");
        let makefile = dir.path().join("Makefile");
        fs::write(&note, "# 中文\n").unwrap();
        fs::write(&makefile, "all:\n").unwrap();

        let ctx = LinkResolveContext {
            cwd: Some(dir.path().to_path_buf()),
            project_root: None,
            home: None,
        };

        let line = "打开 笔记/说明.md:3 或 (foo,Makefile)";
        let rows = vec![row(line)];
        let note_col = col_of(line, "笔记");
        assert_eq!(note_col, 5);
        let note_hit = link_at_rows(&rows, 80, pt(0, note_col + 1), &ctx).expect("cjk file path");
        assert_eq!(
            note_hit.target,
            LinkTarget::File {
                path: fs::canonicalize(&note).unwrap(),
                line: Some(3),
                col: None,
            }
        );
        // `笔记` (4) + `/` (1) + `说明` (4) + `.md:3` (5) = 14 cols.
        assert_eq!(
            note_hit.spans,
            vec![LinkSpan {
                row: 0,
                start_col: 5,
                end_col: 19,
            }]
        );

        let mk_col = col_of(line, "Makefile");
        let mk_hit = link_at_rows(&rows, 80, pt(0, mk_col + 2), &ctx).expect("comma-delimited Makefile");
        assert_eq!(
            mk_hit.target,
            LinkTarget::File {
                path: fs::canonicalize(&makefile).unwrap(),
                line: None,
                col: None,
            }
        );
        assert_eq!(
            mk_hit.spans,
            vec![LinkSpan {
                row: 0,
                start_col: mk_col,
                end_col: mk_col + "Makefile".len() as u16,
            }]
        );

        // Bare `file:///` does not match as a clickable link.
        assert_eq!(link_at_rows(&[row("file:///")], 40, pt(0, 2), &ctx), None);
    }

    #[test]
    fn regression_quoted_path_scan_aligns_multibyte_utf8_boundary() {
        let ctx = LinkResolveContext::default();
        // `"` (1 byte) + `a` (1 byte, target_byte = 1) + 200 × `中` (3 bytes each = 600 bytes):
        // `target_byte + MAX_QUOTED_PATH_BYTES` = 513 lands inside a 3-byte CJK char.
        let mut line = String::from("\"a");
        for _ in 0..200 {
            line.push('中');
        }
        line.push('"');
        assert!(!line.is_char_boundary(1 + MAX_QUOTED_PATH_BYTES));

        let rows = vec![row(&line)];
        let cols: u16 = line.graphemes(true).map(grapheme_cols).sum();
        for col in [1u16, 2, 3, 4, 5, 10] {
            assert_eq!(link_at_rows(&rows, cols, pt(0, col), &ctx), None);
        }
    }

    #[test]
    fn regression_colon_segment_trailing_punctuation_does_not_panic() {
        let ctx = LinkResolveContext::default();
        for sample in ["foo:bar:.", "a:b:)))", "x:y:::"] {
            let rows = vec![row(sample)];
            for col in 0..sample.len() as u16 {
                assert_eq!(link_at_rows(&rows, 40, pt(0, col), &ctx), None);
            }
        }
    }
}
