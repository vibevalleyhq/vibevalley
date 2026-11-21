use std::collections::{HashMap, HashSet};

use crate::measure::{TextMeasurer, TextStyle};
use crate::svg::edges::ARROW;
use crate::text::label::{Label, layout_label};

use super::db::C4Db;
use super::route::{C4Box, C4Form, HEAD, LABEL_PAD, LANE, NARROW};
use super::types::{C4ElementRef, C4Shape};

const SHAPE_W: f64 = 216.0;
const SHAPE_MIN_H: f64 = 64.0;
const PAD_X: f64 = 14.0;
const PAD_Y: f64 = 12.0;
const GAP_X: f64 = NARROW + LABEL_PAD + 3.0 * ARROW;
const GAP_Y: f64 = 88.0;
pub const GROUP_PAD: f64 = LANE + 8.0;
const GROUP_GAP: f64 = 48.0;
pub const HEAD_LEFT: f64 = 16.0;
pub const HEAD_TOP: f64 = 10.0;

fn parse_form(word: &str) -> Option<C4Form> {
    match word {
        "person" => Some(C4Form::Person),
        "box" | "rounded" | "component" => Some(C4Form::Rect),
        "cylinder" | "database" | "db" => Some(C4Form::Cyl),
        "queue" | "pipe" => Some(C4Form::HCyl),
        _ => None,
    }
}

fn form_of(shape: &C4Shape) -> C4Form {
    if let Some(s) = shape.el.shape.as_deref()
        && let Some(f) = parse_form(&s.to_ascii_lowercase())
    {
        return f;
    }
    if let Some(s) = shape.el.sprite.as_deref()
        && let Some(f) = parse_form(&s.to_ascii_lowercase())
    {
        return f;
    }
    if let Some(tags) = shape.el.tags.as_deref() {
        for tag in tags.split(',') {
            if let Some(f) = parse_form(&tag.trim().to_ascii_lowercase()) {
                return f;
            }
        }
    }
    if shape.kind.ends_with("person") {
        C4Form::Person
    } else if shape.kind.ends_with("_db") {
        C4Form::Cyl
    } else if shape.kind.ends_with("_queue") {
        C4Form::HCyl
    } else {
        C4Form::Rect
    }
}

pub struct C4Node {
    pub shape_idx: usize,
    pub box_rect: C4Box,
    pub labels: [Label; 4],
    pub text_h: f64,
}

pub struct C4Group {
    pub boundary_idx: usize,
    pub kids: Vec<usize>,
    pub nodes: Vec<C4Node>,
    pub labels: Vec<Label>,
    pub head: f64,
    pub head_w: f64,
    pub head_x: f64,
    pub box_rect: C4Box,
}

pub struct C4Layout {
    pub groups: Vec<C4Group>,
    /// Indices into `groups`, parents before children; `order[0]` is always the root `0`.
    pub order: Vec<usize>,
    pub boxes: HashMap<C4ElementRef, C4Box>,
}

fn measure_shape(shape_idx: usize, shape: &C4Shape, measurer: &dyn TextMeasurer, size: f64, small: f64, width: f64) -> C4Node {
    let form = form_of(shape);
    let cap_w = if form == C4Form::HCyl { 36.0 } else { 0.0 };
    let cap_h = match form {
        C4Form::Person => HEAD,
        C4Form::Cyl => 24.0,
        C4Form::Rect | C4Form::HCyl => 0.0,
    };
    let inner = width - 2.0 * PAD_X - cap_w;
    let kind_text = format!("«{}»", shape.kind.replace('_', " "));
    let techn_text = shape.el.techn.as_deref().filter(|s| !s.is_empty()).map(|t| format!("[{t}]"));
    let labels = [
        layout_label(Some(&kind_text), false, measurer, small - 1.0, inner, TextStyle::NONE, None, None),
        layout_label(Some(&shape.el.label), false, measurer, size, inner, TextStyle::BOLD, None, None),
        layout_label(techn_text.as_deref(), false, measurer, small, inner, TextStyle::NONE, None, None),
        layout_label(shape.el.descr.as_deref(), false, measurer, small, inner, TextStyle::NONE, None, None),
    ];
    let mut tw = 0.0f64;
    let mut text_h = if labels[3].height > 0.0 { 4.0 } else { 0.0 };
    for l in &labels {
        tw = tw.max(l.width);
        text_h += l.height;
    }
    C4Node {
        shape_idx,
        box_rect: C4Box {
            id: shape_idx,
            x: 0.0,
            y: 0.0,
            w: width.max(tw + 2.0 * PAD_X + cap_w),
            h: SHAPE_MIN_H.max(text_h + 2.0 * PAD_Y + cap_h),
            form,
        },
        labels,
        text_h,
    }
}

fn place_rows(boxes: &mut [&mut C4Box], per_row: usize, gap_x: f64, gap_y: f64, stretch: bool) -> (f64, f64) {
    let mut width = 0.0f64;
    let mut y = 0.0f64;
    let mut from = 0usize;
    while from < boxes.len() {
        let to = boxes.len().min(from.saturating_add(per_row));
        let mut x = 0.0f64;
        let mut row_h = 0.0f64;
        for b in &boxes[from..to] {
            row_h = row_h.max(b.h);
        }
        for b in &mut boxes[from..to] {
            b.x = x;
            b.y = y;
            if stretch {
                b.h = row_h;
            }
            x += b.w + gap_x;
        }
        width = width.max(x - gap_x);
        y += row_h + gap_y;
        from = to;
    }
    (width, if boxes.is_empty() { 0.0 } else { y - gap_y })
}

pub fn layout_c4(db: &C4Db, measurer: &dyn TextMeasurer, size: f64, small: f64, room: Option<f64>, gap: f64) -> C4Layout {
    let group_pad = if room.is_none() { GROUP_PAD } else { 12.0 };
    let shape_count = db.shapes.len();
    let label_room = match room {
        None => 4000.0,
        Some(r) => 80.0f64.max(r - 2.0 * HEAD_LEFT - 2.0 * GROUP_PAD * 2.0),
    };

    let mut groups: Vec<C4Group> = db
        .boundaries
        .iter()
        .enumerate()
        .map(|(idx, boundary)| {
            let labels = if boundary.el.parent.is_some() {
                let type_text = boundary.el.elem_type.as_deref().filter(|s| !s.is_empty()).map(|t| format!("[{t}]"));
                vec![
                    layout_label(Some(&boundary.el.label), false, measurer, size, label_room, TextStyle::BOLD, None, None),
                    layout_label(type_text.as_deref(), false, measurer, small, label_room, TextStyle::NONE, None, None),
                    layout_label(boundary.el.descr.as_deref(), false, measurer, small, label_room, TextStyle::NONE, None, None),
                ]
            } else {
                Vec::new()
            };
            let mut head = 0.0f64;
            let mut head_w = 0.0f64;
            for l in &labels {
                head += l.height;
                head_w = head_w.max(l.width);
            }
            C4Group {
                boundary_idx: idx,
                kids: Vec::new(),
                nodes: Vec::new(),
                labels,
                head: if head > 0.0 { head + HEAD_TOP + 6.0 + LANE } else { group_pad },
                head_w,
                head_x: HEAD_LEFT,
                box_rect: C4Box {
                    id: shape_count + idx,
                    x: 0.0,
                    y: 0.0,
                    w: 0.0,
                    h: 0.0,
                    form: C4Form::Rect,
                },
            }
        })
        .collect();

    for (idx, boundary) in db.boundaries.iter().enumerate() {
        if let Some(parent) = boundary.el.parent
            && parent < groups.len()
        {
            groups[parent].kids.push(idx);
        }
    }

    let mut order: Vec<usize> = vec![0];
    let mut visited: HashSet<usize> = HashSet::new();
    visited.insert(0);
    let mut depths: HashMap<usize, usize> = HashMap::new();
    depths.insert(0, 0);
    let mut cursor = 0usize;
    while cursor < order.len() {
        let cur = order[cursor];
        cursor += 1;
        let d = depths[&cur];
        let kids = groups[cur].kids.clone();
        for kid in kids {
            if visited.insert(kid) {
                depths.insert(kid, d + 1);
                order.push(kid);
            }
        }
    }

    for (shape_idx, shape) in db.shapes.iter().enumerate() {
        if let Some(parent) = shape.el.parent
            && parent < groups.len()
        {
            let depth = depths.get(&parent).copied().unwrap_or(0);
            let node_width = match room {
                None => SHAPE_W,
                Some(r) => 100.0f64.max(SHAPE_W.min(r - 2.0 * depth as f64 * group_pad - 32.0)),
            };
            groups[parent].nodes.push(measure_shape(shape_idx, shape, measurer, size, small, node_width));
        }
    }

    let per_row = db.shape_in_row.max(1);
    let groups_per_row = db.boundary_in_row.max(1);
    let mut kids_top: HashMap<usize, f64> = HashMap::new();

    for &g_idx in order.iter().rev() {
        let gap_x = if room.is_none() { GAP_X } else { gap };
        let node_count = {
            let limit = per_row;
            match room {
                None => limit,
                Some(r) => {
                    let widest = groups[g_idx].nodes.iter().map(|n| n.box_rect.w).fold(1.0f64, f64::max);
                    let fit = ((r + gap_x - 2.0 * group_pad) / (widest + gap_x)).floor();
                    let fit_u = if fit >= 1.0 { fit as usize } else { 1 };
                    fit_u.min(limit).max(1)
                }
            }
        };
        let (grid_w, grid_h) = {
            let mut refs: Vec<&mut C4Box> = groups[g_idx].nodes.iter_mut().map(|n| &mut n.box_rect).collect();
            place_rows(&mut refs, node_count, gap_x, GAP_Y, true)
        };

        let kid_indices = groups[g_idx].kids.clone();
        let kid_count = match room {
            None => groups_per_row,
            Some(r) => {
                let widest = kid_indices.iter().map(|&k| groups[k].box_rect.w).fold(1.0f64, f64::max);
                let fit = ((r + GROUP_GAP - 2.0 * group_pad) / (widest + GROUP_GAP)).floor();
                let fit_u = if fit >= 1.0 { fit as usize } else { 1 };
                fit_u.min(groups_per_row).max(1)
            }
        };
        let mut kid_boxes: Vec<C4Box> = kid_indices.iter().map(|&k| groups[k].box_rect).collect();
        let (kids_w, kids_h) = {
            let mut refs: Vec<&mut C4Box> = kid_boxes.iter_mut().collect();
            place_rows(&mut refs, kid_count, GROUP_GAP, GROUP_GAP, false)
        };
        for (&k_idx, kb) in kid_indices.iter().zip(kid_boxes) {
            groups[k_idx].box_rect = kb;
        }

        let between = if grid_h > 0.0 && kids_h > 0.0 { GROUP_GAP } else { 0.0 };
        let frame = if g_idx == 0 { 0.0 } else { group_pad };
        kids_top.insert(g_idx, grid_h + between);
        let head_w = groups[g_idx].head_w;
        let head = groups[g_idx].head;
        groups[g_idx].box_rect.w = grid_w.max(kids_w).max(head_w + 2.0 * HEAD_LEFT - 2.0 * frame) + 2.0 * frame;
        groups[g_idx].box_rect.h = (if frame != 0.0 { head } else { 0.0 }) + grid_h + between + kids_h + frame;
    }

    let mut boxes: HashMap<C4ElementRef, C4Box> = HashMap::new();
    for &g_idx in &order {
        let gx = groups[g_idx].box_rect.x;
        let gy = groups[g_idx].box_rect.y;
        let left = gx + if g_idx == 0 { 0.0 } else { group_pad };
        let top = gy + if g_idx == 0 { 0.0 } else { groups[g_idx].head };
        for node in &mut groups[g_idx].nodes {
            node.box_rect.x += left;
            node.box_rect.y += top;
            boxes.insert(C4ElementRef::Shape(node.shape_idx), node.box_rect);
        }
        let kt = kids_top[&g_idx];
        let kid_indices = groups[g_idx].kids.clone();
        for k_idx in kid_indices {
            groups[k_idx].box_rect.x += left;
            groups[k_idx].box_rect.y += top + kt;
        }
        if g_idx != 0 {
            boxes.insert(C4ElementRef::Boundary(g_idx), groups[g_idx].box_rect);
        }
    }

    C4Layout { groups, order, boxes }
}
