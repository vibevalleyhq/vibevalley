use std::cmp::Ordering;

use super::model::TreemapNode;

pub struct BoxNode<'a> {
    pub node: &'a TreemapNode,
    pub parent: Option<usize>,
    pub series: usize,
    pub value: f64,
    pub children: Vec<usize>,
    pub headed: bool,
    pub header: f64,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct Insets {
    pub gap: f64,
    pub header: f64,
    pub short: f64,
    pub side: f64,
}

pub struct TreemapLayout<'a> {
    pub boxes: Vec<BoxNode<'a>>,
    pub placed: Vec<usize>,
}

fn clamp(v: f64, low: f64, high: f64) -> f64 {
    if v >= low { v.min(high) } else { low }
}

#[derive(Debug, Clone, Copy)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn squarify(boxes: &mut [BoxNode<'_>], indices: &[usize], total: f64, mut rect: Rect, gap: f64) {
    let mut rest = total;
    let mut from = 0usize;
    while from < indices.len() {
        let scale = (rect.w * rect.h) / rest;
        let side = rect.w.min(rect.h);
        let mut sum = boxes[indices[from]].value * scale;
        let largest = sum;
        let mut worst = ((side * side * largest) / (sum * sum)).max((sum * sum) / (side * side * largest));
        let mut to = from + 1;
        while to < indices.len() {
            let smallest = boxes[indices[to]].value * scale;
            let next = sum + smallest;
            let ratio = ((side * side * largest) / (next * next)).max((next * next) / (side * side * smallest));
            if ratio > worst {
                break;
            }
            worst = ratio;
            sum = next;
            to += 1;
        }

        let thickness = sum / side;
        let mut offset = 0.0f64;
        for (k, &idx) in indices[from..to].iter().enumerate() {
            let val = boxes[idx].value;
            let length = if from + k == to - 1 { side - offset } else { (val * scale) / thickness };
            let (bx, by, bw, bh) = if rect.w >= rect.h {
                (rect.x, rect.y + offset, thickness, length)
            } else {
                (rect.x + offset, rect.y, length, thickness)
            };
            let gx = if (bx + bw - gap / 2.0).round() > (bx + gap / 2.0).round() {
                gap / 2.0
            } else {
                0.0
            };
            let gy = if (by + bh - gap / 2.0).round() > (by + gap / 2.0).round() {
                gap / 2.0
            } else {
                0.0
            };
            let b = &mut boxes[idx];
            b.x = (bx + gx).round();
            b.y = (by + gy).round();
            b.w = (bx + bw - gx).round() - b.x;
            b.h = (by + bh - gy).round() - b.y;
            offset += length;
            rest -= val;
        }
        if rect.w >= rect.h {
            rect.x += thickness;
            rect.w -= thickness;
        } else {
            rect.y += thickness;
            rect.h -= thickness;
        }
        from = to;
    }
}

pub fn layout_treemap<'a>(roots: &'a [TreemapNode], width: f64, height: f64, insets: Insets) -> TreemapLayout<'a> {
    let make_box = |node: &'a TreemapNode, parent: Option<usize>, series: usize| -> BoxNode<'a> {
        let value = match (node.children.is_none(), node.value) {
            (true, Some(v)) if v.is_finite() && v > 0.0 => v,
            _ => 0.0,
        };
        BoxNode {
            node,
            parent,
            series,
            value,
            children: Vec::new(),
            headed: false,
            header: 0.0,
            x: 0.0,
            y: 0.0,
            w: 0.0,
            h: 0.0,
        }
    };

    let mut boxes: Vec<BoxNode<'a>> = Vec::new();
    let mut top: Vec<usize> = Vec::with_capacity(roots.len());
    for (index, node) in roots.iter().enumerate() {
        let id = boxes.len();
        boxes.push(make_box(node, None, index));
        top.push(id);
    }

    let mut i = 0usize;
    while i < boxes.len() {
        let series = boxes[i].series;
        let children_nodes = boxes[i].node.children.as_deref().unwrap_or(&[]);
        let mut child_ids = Vec::with_capacity(children_nodes.len());
        for child_node in children_nodes {
            let cid = boxes.len();
            boxes.push(make_box(child_node, Some(i), series));
            child_ids.push(cid);
        }
        boxes[i].children = child_ids;
        i += 1;
    }

    for idx in (0..boxes.len()).rev() {
        let val = boxes[idx].value;
        if let Some(p) = boxes[idx].parent {
            boxes[p].value += val;
        }
    }

    let mut placed: Vec<usize> = Vec::new();
    let place = |boxes: &mut [BoxNode<'_>], placed: &mut Vec<usize>, children: &[usize], x: f64, y: f64, w: f64, h: f64| {
        let mut shown: Vec<usize> = children.iter().copied().filter(|&id| boxes[id].value > 0.0).collect();
        shown.sort_by(|&a, &b| boxes[b].value.partial_cmp(&boxes[a].value).unwrap_or(Ordering::Equal));
        let total: f64 = shown.iter().map(|&id| boxes[id].value).sum();
        if shown.is_empty() || !total.is_finite() {
            return;
        }
        let w = w.max(0.0);
        let h = h.max(0.0);
        if w > 0.0 && h > 0.0 {
            squarify(
                boxes,
                &shown,
                total,
                Rect {
                    x: x - insets.gap / 2.0,
                    y: y - insets.gap / 2.0,
                    w: w + insets.gap,
                    h: h + insets.gap,
                },
                insets.gap,
            );
        }
        for &id in &shown {
            let b = &mut boxes[id];
            let x0 = clamp(b.x, x, x + w);
            let y0 = clamp(b.y, y, y + h);
            b.w = clamp(b.x + b.w, x0, x + w) - x0;
            b.h = clamp(b.y + b.h, y0, y + h) - y0;
            b.x = x0;
            b.y = y0;
            placed.push(id);
        }
    };

    place(&mut boxes, &mut placed, &top, 0.0, 0.0, width, height);
    let mut cursor = 0usize;
    while cursor < placed.len() {
        let id = placed[cursor];
        cursor += 1;
        if boxes[id].children.is_empty() {
            continue;
        }
        let (bx, by, bw, bh) = (boxes[id].x, boxes[id].y, boxes[id].w, boxes[id].h);
        let top_inset = if bh - insets.header - insets.side >= 12.0 {
            insets.header
        } else {
            insets.short
        };
        let headed = bw > 24.0f64.max(2.0 * insets.side) && bh - top_inset - insets.side >= 8.0;
        boxes[id].headed = headed;
        boxes[id].header = if headed { top_inset } else { 0.0 };
        let kids = boxes[id].children.clone();
        if headed {
            place(
                &mut boxes,
                &mut placed,
                &kids,
                bx + insets.side,
                by + top_inset,
                bw - 2.0 * insets.side,
                bh - top_inset - insets.side,
            );
        } else {
            place(&mut boxes, &mut placed, &kids, bx, by, bw, bh);
        }
    }

    TreemapLayout { boxes, placed }
}
