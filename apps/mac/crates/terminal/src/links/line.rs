use std::sync::Arc;

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::{Point, Row};

use super::url::{is_valid_http_url, resolve_file_url, starts_with_ignore_ascii_case};
use super::{LinkMatch, LinkSpan, LinkTarget};

/// Maximum number of soft-wrapped rows scanned in either direction from the
/// target row, bounding work on pathological single-line output.
const MAX_WRAP_ROWS: usize = 32;

pub(super) fn grapheme_cols(g: &str) -> u16 {
    (g.width() as u16).clamp(1, 2)
}

pub(super) fn osc8_link_at(rows: &[Arc<Row>], cols: u16, at: Point) -> Option<LinkMatch> {
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

struct CellMap {
    byte_start: usize,
    byte_end: usize,
    row: u16,
    start_col: u16,
    end_col: u16,
}

pub(super) struct LogicalLine {
    pub(super) text: String,
    cells: Vec<CellMap>,
}

impl LogicalLine {
    pub(super) fn from_rows(rows: &[Arc<Row>], cols: u16, target_row: u16) -> Self {
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

    pub(super) fn byte_at(&self, at: Point) -> Option<usize> {
        self.cells
            .iter()
            .find(|c| c.row == at.row && at.col >= c.start_col && at.col < c.end_col)
            .map(|c| c.byte_start)
    }

    pub(super) fn spans_for_bytes(&self, start: usize, end: usize) -> Vec<LinkSpan> {
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
