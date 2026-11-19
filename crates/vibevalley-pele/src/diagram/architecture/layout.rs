// Grid placement. Every service and junction takes a cell, an edge `a:R -- L:b` puts b in the
// cell to the right of a, and a group is a solid rectangle of cells, so a group never encloses
// a node that is not in it. Each container (the diagram, then every group) is laid out on its
// own, innermost first, and a finished group is placed in its parent as one block.

use std::collections::HashMap;

use super::db::{ArchEdge, ArchGroup, ArchLayoutHint, ArchNode};
use super::parser::{AlignDirection, Side};

#[derive(Debug, Clone)]
pub struct Grid {
    pub col: Vec<i32>,
    pub row: Vec<i32>,
    pub group_col: Vec<i32>,
    pub group_row: Vec<i32>,
    pub group_cols: Vec<i32>,
    pub group_rows: Vec<i32>,
    pub group_parent: Vec<i32>,
    pub group_empty: Vec<bool>,
    pub node_parent: Vec<i32>,
}

const DX: [i32; 4] = [-1, 1, 0, 0];
const DY: [i32; 4] = [0, 0, -1, 1];

pub const fn side_index(side: Side) -> usize {
    match side {
        Side::L => 0,
        Side::R => 1,
        Side::T => 2,
        Side::B => 3,
    }
}

// Blocks up to this many cells are found through the cell map; larger ones are compared one by one.
const SMALL: i32 = 64;

struct GridSolver {
    n: usize,
    parent: Vec<usize>,
    link_a: Vec<usize>,
    link_b: Vec<usize>,
    side_a: Vec<usize>,
    side_b: Vec<usize>,
    item_a: Vec<usize>,
    item_b: Vec<usize>,
    hint_links: Vec<Vec<usize>>,
    edge_links: Vec<Vec<usize>>,
    x: Vec<i32>,
    y: Vec<i32>,
    w: Vec<i32>,
    h: Vec<i32>,
    placed: Vec<bool>,
    order: Vec<usize>,
    cells: HashMap<(i32, i32), usize>,
    large: Vec<usize>,
    reach: HashMap<(i32, i32, i32, i32, i32, i32), i32>,
    first: usize,
}

impl GridSolver {
    fn anchor(&self, node: usize, item: usize) -> (i32, i32) {
        let mut ax = 0;
        let mut ay = 0;
        let mut cur = node;
        while cur != item {
            ax += self.x[cur];
            ay += self.y[cur];
            cur = self.n + self.parent[cur];
        }
        (ax, ay)
    }

    fn put(&mut self, item: usize, px: i32, py: i32) {
        self.x[item] = px;
        self.y[item] = py;
        self.placed[item] = true;
        self.order.push(item);
        if self.w[item].saturating_mul(self.h[item]) > SMALL {
            self.large.push(item);
            return;
        }
        for cy in py..(py + self.h[item]) {
            for cx in px..(px + self.w[item]) {
                self.cells.insert((cx, cy), item);
            }
        }
    }

    fn overlaps(&self, item: usize, rx: i32, ry: i32, rw: i32, rh: i32) -> bool {
        self.x[item] < rx + rw && rx < self.x[item] + self.w[item] && self.y[item] < ry + rh && ry < self.y[item] + self.h[item]
    }

    fn collide(&self, rx: i32, ry: i32, rw: i32, rh: i32) -> Option<usize> {
        if rw.saturating_mul(rh) > SMALL {
            for &item in &self.order[self.first..] {
                if self.overlaps(item, rx, ry, rw, rh) {
                    return Some(item);
                }
            }
            return None;
        }
        for cy in ry..(ry + rh) {
            for cx in rx..(rx + rw) {
                if let Some(&hit) = self.cells.get(&(cx, cy)) {
                    return Some(hit);
                }
            }
        }
        self.large.iter().find(|&&item| self.overlaps(item, rx, ry, rw, rh)).copied()
    }

    fn slide(&mut self, rx: i32, ry: i32, rw: i32, rh: i32, sx: i32, sy: i32) -> i32 {
        let key = (rx, ry, rw, rh, sx, sy);
        let mut k = self.reach.get(&key).copied().unwrap_or(0);
        while let Some(hit) = self.collide(rx + k * sx, ry + k * sy, rw, rh) {
            k = if sx > 0 {
                self.x[hit] + self.w[hit] - rx
            } else if sx < 0 {
                rx + rw - self.x[hit]
            } else if sy > 0 {
                self.y[hit] + self.h[hit] - ry
            } else {
                ry + rh - self.y[hit]
            };
        }
        self.reach.insert(key, k);
        k
    }

    fn follow(&mut self, from: usize, k: usize) {
        let forward = self.item_a[k] == from;
        let to = if forward { self.item_b[k] } else { self.item_a[k] };
        if self.placed[to] {
            return;
        }
        let sp = if forward { self.side_a[k] } else { self.side_b[k] };
        let sq = if forward { self.side_b[k] } else { self.side_a[k] };
        let (pax, pay) = self.anchor(if forward { self.link_a[k] } else { self.link_b[k] }, from);
        let (ax, ay) = self.anchor(if forward { self.link_b[k] } else { self.link_a[k] }, to);
        let mut dx = DX[sp];
        let mut dy = DY[sp];
        let mut shift_x = 0;
        let mut shift_y = 0;
        let facing = DX[sp] + DX[sq] == 0 && DY[sp] + DY[sq] == 0;
        if sp == sq {
            dx = if DX[sp] == 0 { 1 } else { 0 };
            dy = 1 - dx;
        } else if !facing {
            shift_x = -DX[sq];
            shift_y = -DY[sq];
        }
        let (mut bx, mut by) = if dx != 0 {
            let x_val = if dx > 0 { self.x[from] + self.w[from] } else { self.x[from] - self.w[to] };
            (x_val, self.y[from] + pay + shift_y - ay)
        } else {
            let y_val = if dy > 0 { self.y[from] + self.h[from] } else { self.y[from] - self.h[to] };
            (self.x[from] + pax + shift_x - ax, y_val)
        };
        if facing {
            if self.edge_links[to].len() > 1 {
                let mut wanted: Vec<i32> = Vec::new();
                for &j in &self.edge_links[to] {
                    let to_is_b = self.item_b[j] == to;
                    let other = if to_is_b { self.item_a[j] } else { self.item_b[j] };
                    let other_s = if to_is_b { self.side_a[j] } else { self.side_b[j] };
                    let to_s = if to_is_b { self.side_b[j] } else { self.side_a[j] };
                    if !self.placed[other] || other_s != sp || to_s != sq {
                        continue;
                    }
                    let (oax, oay) = self.anchor(if to_is_b { self.link_a[j] } else { self.link_b[j] }, other);
                    let at = if dx != 0 { self.y[other] + oay } else { self.x[other] + oax };
                    let (tax, tay) = self.anchor(if to_is_b { self.link_b[j] } else { self.link_a[j] }, to);
                    wanted.push(at - if dx != 0 { tay } else { tax });
                }
                if wanted.len() > 1 {
                    wanted.sort_unstable();
                    let mid = wanted[(wanted.len() - 1) >> 1];
                    if dx != 0 {
                        by = mid;
                    } else {
                        bx = mid;
                    }
                }
            }
            let px = if dx == 0 { 1 } else { 0 };
            let py = 1 - px;
            let forth = self.slide(bx, by, self.w[to], self.h[to], px, py);
            let back = if forth == 0 {
                0
            } else {
                self.slide(bx, by, self.w[to], self.h[to], -px, -py)
            };
            let near = if forth <= back { forth } else { -back };
            bx += px * near;
            by += py * near;
        } else {
            let far = self.slide(bx, by, self.w[to], self.h[to], dx, dy);
            bx += dx * far;
            by += dy * far;
        }
        self.put(to, bx, by);
    }

    fn layout_container(&mut self, c: usize, items: &[usize], g_count: usize) {
        if items.is_empty() {
            return;
        }
        self.order.clear();
        let mut starts: Vec<usize> = Vec::new();
        for &start in items {
            if self.placed[start] {
                continue;
            }
            self.first = self.order.len();
            starts.push(self.first);
            self.cells.clear();
            self.large.clear();
            self.reach.clear();
            self.put(start, 0, 0);
            let mut hint_at = self.first;
            let mut edge_at = self.first;
            let mut link_at = 0usize;
            loop {
                if hint_at < self.order.len() {
                    let from = self.order[hint_at];
                    hint_at += 1;
                    let list = self.hint_links[from].clone();
                    for k in list {
                        self.follow(from, k);
                    }
                    continue;
                }
                if edge_at >= self.order.len() {
                    break;
                }
                let cur = self.order[edge_at];
                if link_at >= self.edge_links[cur].len() {
                    edge_at += 1;
                    link_at = 0;
                    continue;
                }
                let k = self.edge_links[cur][link_at];
                link_at += 1;
                self.follow(cur, k);
            }
        }
        starts.push(self.order.len());

        let count = starts.len() - 1;
        let mut min_x = vec![0i32; count];
        let mut min_y = vec![0i32; count];
        let mut part_w = vec![0i32; count];
        let mut part_h = vec![0i32; count];
        let mut area = 0i64;
        let mut widest = 0i32;
        for p in 0..count {
            let mut x0 = i32::MAX;
            let mut y0 = i32::MAX;
            let mut x1 = i32::MIN;
            let mut y1 = i32::MIN;
            for &item in &self.order[starts[p]..starts[p + 1]] {
                x0 = x0.min(self.x[item]);
                y0 = y0.min(self.y[item]);
                x1 = x1.max(self.x[item] + self.w[item]);
                y1 = y1.max(self.y[item] + self.h[item]);
            }
            min_x[p] = x0;
            min_y[p] = y0;
            part_w[p] = x1 - x0;
            part_h[p] = y1 - y0;
            area += (part_w[p] as i64) * (part_h[p] as i64);
            widest = widest.max(part_w[p]);
        }
        let limit = widest.max(((area as f64) * 2.0).sqrt().ceil() as i32);
        let mut cx = 0i32;
        let mut cy = 0i32;
        let mut shelf = 0i32;
        let mut width = 0i32;
        for p in 0..count {
            if cx > 0 && cx + part_w[p] > limit {
                cy += shelf;
                cx = 0;
                shelf = 0;
            }
            for &item in &self.order[starts[p]..starts[p + 1]] {
                self.x[item] += cx - min_x[p];
                self.y[item] += cy - min_y[p];
            }
            cx += part_w[p];
            shelf = shelf.max(part_h[p]);
            width = width.max(cx);
        }
        if c < g_count {
            self.w[self.n + c] = width;
            self.h[self.n + c] = cy + shelf;
        }
    }
}

pub fn place_on_grid(nodes: &[&ArchNode], groups: &[&ArchGroup], edges: &[ArchEdge], hints: &[ArchLayoutHint]) -> Grid {
    let n = nodes.len();
    let g_count = groups.len();
    let root = g_count;
    let mut node_index: HashMap<&str, usize> = HashMap::with_capacity(n);
    let mut group_index: HashMap<&str, usize> = HashMap::with_capacity(g_count);

    let mut parent = vec![root; n + g_count];
    let mut depth = vec![0usize; g_count + 1];
    let mut kids: Vec<Vec<usize>> = (0..=g_count).map(|_| Vec::new()).collect();

    for (g, group) in groups.iter().enumerate() {
        group_index.insert(group.id.as_str(), g);
        if let Some(p_id) = group.in_group.as_deref()
            && let Some(&p) = group_index.get(p_id)
            && p != g
        {
            parent[n + g] = p;
            depth[g] = depth[p] + 1;
        } else {
            depth[g] = 1;
        }
    }
    for (i, node) in nodes.iter().enumerate() {
        node_index.insert(node.id(), i);
        if let Some(p_id) = node.in_group()
            && let Some(&p) = group_index.get(p_id)
        {
            parent[i] = p;
        }
        kids[parent[i]].push(i);
    }
    for g in 0..g_count {
        kids[parent[n + g]].push(n + g);
    }

    let mut link_a = Vec::new();
    let mut link_b = Vec::new();
    let mut side_a = Vec::new();
    let mut side_b = Vec::new();
    let mut item_a = Vec::new();
    let mut item_b = Vec::new();
    let mut hint_links: Vec<Vec<usize>> = (0..n + g_count).map(|_| Vec::new()).collect();
    let mut edge_links: Vec<Vec<usize>> = (0..n + g_count).map(|_| Vec::new()).collect();

    let mut add_link = |a: usize, b: usize, sa: usize, sb: usize, is_hint: bool| {
        if a == b {
            return;
        }
        let mut ia = a;
        let mut ib = b;
        let mut ca = parent[a];
        let mut cb = parent[b];
        while ca != cb {
            if depth[ca] >= depth[cb] {
                ia = n + ca;
                ca = parent[ia];
            } else {
                ib = n + cb;
                cb = parent[ib];
            }
        }
        let k = link_a.len();
        link_a.push(a);
        link_b.push(b);
        side_a.push(sa);
        side_b.push(sb);
        item_a.push(ia);
        item_b.push(ib);
        let target = if is_hint { &mut hint_links } else { &mut edge_links };
        target[ia].push(k);
        target[ib].push(k);
    };

    for hint in hints {
        let is_row = hint.direction == AlignDirection::Row;
        for pair in hint.members.windows(2) {
            if let (Some(&a), Some(&b)) = (node_index.get(pair[0].as_str()), node_index.get(pair[1].as_str())) {
                add_link(a, b, if is_row { 1 } else { 3 }, if is_row { 0 } else { 2 }, true);
            }
        }
    }
    for like_sides in [false, true] {
        for edge in edges {
            if (edge.lhs_dir == edge.rhs_dir) != like_sides {
                continue;
            }
            if let (Some(&a), Some(&b)) = (node_index.get(edge.lhs_id.as_str()), node_index.get(edge.rhs_id.as_str())) {
                add_link(a, b, side_index(edge.lhs_dir), side_index(edge.rhs_dir), false);
            }
        }
    }

    let mut solver = GridSolver {
        n,
        parent,
        link_a,
        link_b,
        side_a,
        side_b,
        item_a,
        item_b,
        hint_links,
        edge_links,
        x: vec![0; n + g_count],
        y: vec![0; n + g_count],
        w: vec![1; n + g_count],
        h: vec![1; n + g_count],
        placed: vec![false; n + g_count],
        order: Vec::new(),
        cells: HashMap::new(),
        large: Vec::new(),
        reach: HashMap::new(),
        first: 0,
    };

    for c in (0..g_count).rev() {
        solver.layout_container(c, &kids[c], g_count);
    }
    solver.layout_container(root, &kids[root], g_count);

    let mut group_col = vec![0i32; g_count];
    let mut group_row = vec![0i32; g_count];
    let mut group_parent = vec![-1i32; g_count];
    let mut group_empty = vec![false; g_count];
    for g in 0..g_count {
        let p = solver.parent[n + g];
        group_parent[g] = if p == root { -1 } else { p as i32 };
        group_col[g] = solver.x[n + g] + if p == root { 0 } else { group_col[p] };
        group_row[g] = solver.y[n + g] + if p == root { 0 } else { group_row[p] };
        if kids[g].is_empty() {
            group_empty[g] = true;
        }
    }
    let mut col = vec![0i32; n];
    let mut row = vec![0i32; n];
    let mut node_parent = vec![-1i32; n];
    for i in 0..n {
        let p = solver.parent[i];
        node_parent[i] = if p == root { -1 } else { p as i32 };
        col[i] = solver.x[i] + if p == root { 0 } else { group_col[p] };
        row[i] = solver.y[i] + if p == root { 0 } else { group_row[p] };
    }
    Grid {
        col,
        row,
        group_col,
        group_row,
        group_cols: solver.w[n..].to_vec(),
        group_rows: solver.h[n..].to_vec(),
        group_parent,
        group_empty,
        node_parent,
    }
}
