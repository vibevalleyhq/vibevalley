use indexmap::IndexMap;

use super::compound::{CEdge, CNode, CompoundResult};

struct Part {
    nodes: Vec<usize>,
    edges: Vec<usize>,
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

impl Part {
    fn new() -> Self {
        Self {
            nodes: Vec::new(),
            edges: Vec::new(),
            left: f64::INFINITY,
            top: f64::INFINITY,
            right: f64::NEG_INFINITY,
            bottom: f64::NEG_INFINITY,
        }
    }

    fn include(&mut self, x: f64, y: f64, w: f64, h: f64) {
        self.left = self.left.min(x - w / 2.0);
        self.top = self.top.min(y - h / 2.0);
        self.right = self.right.max(x + w / 2.0);
        self.bottom = self.bottom.max(y + h / 2.0);
    }
}

/// Moves disconnected parts into rows without changing the layout inside a part.
pub fn wrap_components(nodes: &mut [CNode], edges: &mut [CEdge], width: f64, gap: f64) -> Option<CompoundResult> {
    let mut parent: Vec<usize> = (0..nodes.len()).collect();
    let root = |parent: &mut [usize], mut i: usize| -> usize {
        while parent[i] != i {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        i
    };
    for (i, c) in nodes.iter().enumerate() {
        if c.parent >= 0 {
            let ra = root(&mut parent, i);
            let rb = root(&mut parent, c.parent as usize);
            parent[ra] = rb;
        }
    }
    for e in edges.iter() {
        let ra = root(&mut parent, e.src);
        let rb = root(&mut parent, e.dst);
        parent[ra] = rb;
    }

    let mut parts: IndexMap<usize, Part> = IndexMap::new();
    for (i, c) in nodes.iter().enumerate() {
        let id = root(&mut parent, i);
        let part = parts.entry(id).or_insert_with(Part::new);
        part.nodes.push(i);
        part.include(c.x, c.y, c.w, c.h);
    }
    if parts.len() < 2 {
        return None;
    }
    for (ei, e) in edges.iter().enumerate() {
        let id = root(&mut parent, e.src);
        let part = parts.get_mut(&id).unwrap();
        part.edges.push(ei);
        let mut i = 0;
        while i + 1 < e.route.len() {
            part.include(e.route[i], e.route[i + 1], 0.0, 0.0);
            i += 3;
        }
        if e.label_w > 0.0 {
            part.include(e.label_x, e.label_y, e.label_w, e.label_h);
        }
    }

    let mut x = 0.0f64;
    let mut y = 0.0f64;
    let mut row_height = 0.0f64;
    let mut right = 0.0f64;
    let mut from = f64::INFINITY;
    let mut to = f64::NEG_INFINITY;
    let mut shifts: Vec<(f64, f64)> = Vec::with_capacity(parts.len());
    for part in parts.values() {
        let w = part.right - part.left;
        let h = part.bottom - part.top;
        if x > 0.0 && x + w > width {
            y += row_height + gap;
            x = 0.0;
            row_height = 0.0;
        }
        shifts.push((x - part.left, y - part.top));
        from = from.min(part.left);
        to = to.max(part.right);
        right = right.max(x + w);
        row_height = row_height.max(h);
        x += w + gap;
    }
    if right >= to - from {
        return None;
    }
    for (part, (ox, oy)) in parts.values().zip(shifts) {
        for &ni in &part.nodes {
            nodes[ni].x += ox;
            nodes[ni].y += oy;
        }
        for &ei in &part.edges {
            let e = &mut edges[ei];
            let mut k = 0;
            while k + 1 < e.route.len() {
                e.route[k] += ox;
                e.route[k + 1] += oy;
                k += 3;
            }
            e.label_x += ox;
            e.label_y += oy;
        }
    }
    Some(CompoundResult {
        width: right,
        height: y + row_height,
    })
}
