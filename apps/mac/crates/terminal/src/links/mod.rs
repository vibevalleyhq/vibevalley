//! Pure, deterministic link detection and hit-testing on terminal snapshots.
//!
//! Recognizes OSC 8 hyperlinks, `http://` / `https://` / `file://` URLs, and
//! local file paths (absolute, `~/...`, relative) with optional `:line`,
//! `:line:col`, `(line,col)`, or `#Lline` suffixes across soft-wrapped rows.
//! File-path candidates only match when the resolved path exists on disk.

mod file;
mod line;
mod url;

#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::sync::Arc;

use crate::{Point, Row, Snapshot};

use self::file::file_match_at;
use self::line::{LogicalLine, osc8_link_at};
use self::url::url_match_at;

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

pub(super) enum Resolver<'a, F> {
    Borrowed(&'a LinkResolveContext),
    Lazy { init: Option<F>, cached: Option<LinkResolveContext> },
}

impl<F: FnOnce() -> LinkResolveContext> Resolver<'_, F> {
    pub(super) fn get(&mut self) -> &LinkResolveContext {
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
