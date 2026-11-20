use crate::detect::DiagramType;
use crate::error::{ErrorCode, PeleError};

#[derive(Debug, Clone)]
pub struct Cell {
    pub children: Vec<usize>,
    /// Grid width of this container: a positive count, or -1 to put every child on one row.
    pub columns: f64,
    pub span: usize,
    pub space: bool,
    /// Height reserved above a container's grid for its title.
    pub head: f64,
    /// Size the content needs. Set by the caller for leaves, computed here for containers.
    pub nw: f64,
    pub nh: f64,
    /// Placement: grid position, then center and size in pixels.
    pub col: usize,
    pub row: usize,
    pub cols: usize,
    pub heights: Vec<f64>,
    /// Extra space after each row or column.
    pub row_gaps: Vec<f64>,
    pub col_gaps: Vec<f64>,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

const MAX_SPAN: usize = 1000;

pub fn cell(nw: f64, nh: f64, span: usize) -> Cell {
    Cell {
        children: Vec::new(),
        columns: -1.0,
        span,
        space: false,
        head: 0.0,
        nw,
        nh,
        col: 0,
        row: 0,
        cols: 0,
        heights: Vec::new(),
        row_gaps: Vec::new(),
        col_gaps: Vec::new(),
        x: 0.0,
        y: 0.0,
        w: 0.0,
        h: 0.0,
    }
}

pub fn calculate_block_position(columns: f64, position: i64) -> Result<(usize, usize), PeleError> {
    if columns == 0.0 || !columns.is_finite() || columns.fract() != 0.0 {
        return Err(PeleError::new("Columns must be an integer !== 0.", ErrorCode::Semantic).with_diagram_type(DiagramType::Block));
    }
    if position < 0 {
        return Err(PeleError::new(format!("Position must be a non-negative integer.{position}"), ErrorCode::Semantic).with_diagram_type(DiagramType::Block));
    }
    if columns < 0.0 {
        return Ok((position as usize, 0));
    }
    let pos_f = position as f64;
    let px = (pos_f % columns) as usize;
    let py = (pos_f / columns).floor() as usize;
    Ok((px, py))
}

fn total(gaps: &[f64]) -> f64 {
    gaps.iter().copied().sum()
}

fn measure(cells: &mut [Cell], box_idx: usize, gap: f64, inset: f64) -> Result<(), PeleError> {
    let columns = cells[box_idx].columns;
    let children = cells[box_idx].children.clone();
    let mut heights: Vec<f64> = Vec::new();
    let mut position: i64 = 0;
    let mut cols: usize = 0;
    let mut cw: f64 = 0.0;
    let mut tallest: f64 = 0.0;

    for &child_idx in &children {
        let (px, py) = calculate_block_position(columns, position)?;
        let raw_span = cells[child_idx].span;
        let mut span = if raw_span >= 1 { raw_span.min(MAX_SPAN) } else { 1 };
        if columns > 0.0 {
            let rem = (columns - px as f64).max(0.0);
            if (span as f64) > rem {
                span = rem as usize;
            }
        }
        cells[child_idx].span = span;
        cells[child_idx].col = px;
        cells[child_idx].row = py;
        position += span as i64;
        if px + span > cols {
            cols = px + span;
        }
        if py == heights.len() {
            heights.push(0.0);
        }
        let child_has_children = !cells[child_idx].children.is_empty();
        let child_nh = cells[child_idx].nh;
        let child_nw = cells[child_idx].nw;
        let child_space = cells[child_idx].space;
        if !child_has_children {
            heights[py] = -1.0;
        } else if heights[py] >= 0.0 && child_nh > heights[py] {
            heights[py] = child_nh;
        }
        if child_space {
            continue;
        }
        let width = (child_nw - gap * (span.saturating_sub(1) as f64)) / (span.max(1) as f64);
        if width > cw {
            cw = width;
        }
        if child_nh > tallest {
            tallest = child_nh;
        }
    }

    let mut height = (heights.len().saturating_sub(1) as f64) * gap + total(&cells[box_idx].row_gaps);
    for h in &mut heights {
        if *h < 0.0 {
            *h = tallest;
        }
        height += *h;
    }

    let col_gap_sum = total(&cells[box_idx].col_gaps);
    let head = cells[box_idx].head;
    let b = &mut cells[box_idx];
    b.cols = cols;
    b.heights = heights;
    let needed_w = (cols as f64) * cw + (cols.saturating_sub(1) as f64) * gap + col_gap_sum + 2.0 * inset;
    b.nw = b.nw.max(needed_w);
    b.nh = height + 2.0 * inset + head;
    Ok(())
}

fn arrange(cells: &mut [Cell], box_idx: usize, gap: f64, inset: f64) {
    let cols = cells[box_idx].cols;
    let rows = cells[box_idx].heights.len();
    if cols == 0 || rows == 0 {
        return;
    }
    let heights = cells[box_idx].heights.clone();
    let row_gaps = cells[box_idx].row_gaps.clone();
    let col_gaps = cells[box_idx].col_gaps.clone();
    let box_w = cells[box_idx].w;
    let box_h = cells[box_idx].h;
    let box_x = cells[box_idx].x;
    let box_y = cells[box_idx].y;
    let head = cells[box_idx].head;
    let children = cells[box_idx].children.clone();

    let cw = (box_w - 2.0 * inset - ((cols - 1) as f64) * gap - total(&col_gaps)) / (cols as f64);
    let room = box_h - 2.0 * inset - head - ((rows - 1) as f64) * gap - total(&row_gaps);

    let mut offsets: Vec<f64> = Vec::new();
    if !col_gaps.is_empty() {
        let mut sum = 0.0;
        for col in 0..cols {
            offsets.push(sum);
            sum += col_gaps.get(col).copied().unwrap_or(0.0);
        }
    }

    let needed: f64 = heights.iter().copied().sum();
    let scale = if needed > 0.0 { room / needed } else { 0.0 };
    let share = if needed > 0.0 { 0.0 } else { room / (rows as f64) };
    let left = box_x - box_w / 2.0 + inset;
    let mut top = box_y - box_h / 2.0 + inset + head;
    let mut row = 0usize;

    for &child_idx in &children {
        let child_row = cells[child_idx].row;
        while row < child_row {
            top += heights[row] * scale + share + gap + row_gaps.get(row).copied().unwrap_or(0.0);
            row += 1;
        }
        let col = cells[child_idx].col;
        let span = cells[child_idx].span;
        let before = offsets.get(col).copied().unwrap_or(0.0);
        let end_offset = offsets.get(col + span - 1).copied().unwrap_or(0.0);
        let w = cw * (span as f64) + gap * ((span - 1) as f64) + end_offset - before;
        let h = heights[row] * scale + share;
        cells[child_idx].w = w;
        cells[child_idx].h = h;
        cells[child_idx].x = left + (col as f64) * (cw + gap) + before + w / 2.0;
        cells[child_idx].y = top + h / 2.0;
    }
}

/// Lays out an arena of cells in place starting at `root_idx`.
pub fn layout(cells: &mut [Cell], root_idx: usize, gap: f64) -> Result<(f64, f64), PeleError> {
    let mut order = vec![root_idx];
    let mut i = 0;
    while i < order.len() {
        let idx = order[i];
        order.extend_from_slice(&cells[idx].children);
        i += 1;
    }
    for pos in (0..order.len()).rev() {
        let idx = order[pos];
        if !cells[idx].children.is_empty() {
            measure(cells, idx, gap, if pos == 0 { 0.0 } else { gap })?;
        }
    }
    cells[root_idx].w = cells[root_idx].nw;
    cells[root_idx].h = cells[root_idx].nh;
    cells[root_idx].x = cells[root_idx].w / 2.0;
    cells[root_idx].y = cells[root_idx].h / 2.0;
    for (pos, &idx) in order.iter().enumerate() {
        if !cells[idx].children.is_empty() {
            arrange(cells, idx, gap, if pos == 0 { 0.0 } else { gap });
        }
    }
    Ok((cells[root_idx].w, cells[root_idx].h))
}
