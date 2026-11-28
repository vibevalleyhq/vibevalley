use std::collections::HashMap;

use crate::layout::layered::{Groups, Kind, LEdge, LNode, LayeredOptions, layered, ledge, lnode};

use super::crossings::{route_crossings, style_of};
use super::placement::place;
use super::types::{CEdge, CNode, CachedLayout, CompoundResult, Dir, FlatGuide, IN_LINE, Level, LevelEdge, PortEdge, Side, restore, snapshot, start_side};

const MAX_PORTS: usize = 40_000;
const MAX_ORDERED_PORTS: usize = 400;
const MAX_ORDERED_EDGES: usize = 500;
const FLAT_SLACK: f64 = 1.5;
const FLAT_SPARE: f64 = 4.0;

pub fn compound_layout(nodes: &mut [CNode], edges: &mut [CEdge], root_dir: Dir, opt: &LayeredOptions) -> CompoundResult {
    let n = nodes.len();
    let mut order: Vec<Level> = Vec::new();
    let mut level_idx: HashMap<i32, usize> = HashMap::new();

    let mut children: Vec<Vec<usize>> = vec![Vec::new(); n];
    let mut root_items: Vec<usize> = Vec::new();
    for i in 0..n {
        let p = nodes[i].parent;
        if p >= 0 && (p as usize) < n && (p as usize) != i && nodes[p as usize].is_group {
            children[p as usize].push(i);
        } else {
            nodes[i].parent = -1;
            root_items.push(i);
        }
    }

    let mut root = Level::new(-1, root_dir);
    root.items = root_items;
    level_idx.insert(-1, 0);
    order.push(root);

    let mut depth = vec![0usize; n];
    let mut placed = vec![false; n];
    let descend = |from: usize,
                   order: &mut Vec<Level>,
                   level_idx: &mut HashMap<i32, usize>,
                   children: &[Vec<usize>],
                   nodes: &[CNode],
                   placed: &mut [bool],
                   depth: &mut [usize]| {
        let mut q = from;
        while q < order.len() {
            let level_id = order[q].id;
            let level_dir = order[q].dir;
            let items = order[q].items.clone();
            for item in items {
                placed[item] = true;
                depth[item] = if level_id < 0 { 0 } else { depth[level_id as usize] + 1 };
                if nodes[item].is_group {
                    let mut child = Level::new(item as i32, nodes[item].dir.unwrap_or(level_dir));
                    child.items = children[item].clone();
                    let idx = order.len();
                    level_idx.insert(item as i32, idx);
                    order.push(child);
                }
            }
            q += 1;
        }
    };
    descend(0, &mut order, &mut level_idx, &children, nodes, &mut placed, &mut depth);

    // Groups that contain each other are unreachable from the root; lift them out.
    for i in 0..n {
        if placed[i] {
            continue;
        }
        let former = nodes[i].parent as usize;
        children[former].retain(|&c| c != i);
        nodes[i].parent = -1;
        order[0].items.push(i);
        placed[i] = true;
        depth[i] = 0;
        if nodes[i].is_group {
            let from = order.len();
            let mut child = Level::new(i as i32, nodes[i].dir.unwrap_or(root_dir));
            child.items = children[i].clone();
            level_idx.insert(i as i32, from);
            order.push(child);
            descend(from, &mut order, &mut level_idx, &children, nodes, &mut placed, &mut depth);
        }
    }

    for q in (1..order.len()).rev() {
        let mut seq = usize::MAX;
        for &item in &order[q].items {
            if nodes[item].seq < seq {
                seq = nodes[item].seq;
            }
        }
        if seq != usize::MAX {
            nodes[order[q].id as usize].seq = seq;
        }
    }
    for level in &mut order {
        level.items.sort_by(|&a, &b| nodes[a].seq.cmp(&nodes[b].seq).then_with(|| a.cmp(&b)));
    }

    let mut ports = 0usize;
    for e in edges.iter_mut() {
        let mut a = e.src;
        let mut b = e.dst;
        let mut crossed = 0usize;
        while depth[a] > depth[b] {
            a = nodes[a].parent as usize;
            crossed += 1;
        }
        while depth[b] > depth[a] {
            b = nodes[b].parent as usize;
            crossed += 1;
        }
        while a != b && nodes[a].parent != nodes[b].parent {
            a = nodes[a].parent as usize;
            b = nodes[b].parent as usize;
            crossed += 2;
        }
        if a == b {
            continue;
        }
        if ports + crossed > MAX_PORTS {
            e.src = a;
            e.dst = b;
        } else {
            ports += crossed;
        }
    }

    let mut loops: Vec<usize> = Vec::new();
    let mut stray: Vec<usize> = Vec::new();
    for (ei, e) in edges.iter_mut().enumerate() {
        e.route.clear();
        if e.src == e.dst {
            loops.push(ei);
            continue;
        }
        let mut a = e.src;
        let mut b = e.dst;
        let mut a_path: Vec<usize> = Vec::new();
        let mut b_path: Vec<usize> = Vec::new();
        while depth[a] > depth[b] {
            a_path.push(a);
            a = nodes[a].parent as usize;
        }
        while depth[b] > depth[a] {
            b_path.push(b);
            b = nodes[b].parent as usize;
        }
        if a == b {
            stray.push(ei);
            continue;
        }
        while nodes[a].parent != nodes[b].parent {
            a_path.push(a);
            b_path.push(b);
            a = nodes[a].parent as usize;
            b = nodes[b].parent as usize;
        }
        let shared_idx = level_idx[&nodes[a].parent];
        order[shared_idx].edges.push(LevelEdge { e: ei, a, b });
        for (path, out) in [(&a_path, true), (&b_path, false)] {
            for &inner in path {
                let lv_idx = level_idx[&nodes[inner].parent];
                let lv = &mut order[lv_idx];
                let port_idx = lv.ports.len();
                lv.ports.push(PortEdge {
                    e: ei,
                    inner,
                    out,
                    side: Side::Top,
                    hint: f64::NAN,
                    px: 0.0,
                    py: 0.0,
                    route: Vec::new(),
                });
                lv.port_of.insert(ei * 2 + usize::from(!out), port_idx);
            }
        }
    }

    let ordered = ports > 1 && ports <= MAX_ORDERED_PORTS && edges.len() <= MAX_ORDERED_EDGES;
    let mut key = vec![f64::NAN; n];
    let mut flat_crossings = 0usize;
    let mut flat_guide: Option<FlatGuide> = None;
    let mut flat = order.len() > 1 && ordered;
    for level in &order {
        if level.dir != root_dir {
            flat = false;
        }
    }
    if flat {
        let vertical = root_dir.is_vertical();
        let mut leaf = vec![-1i32; n];
        let mut group = vec![-1i32; n];
        let mut lnodes: Vec<LNode> = Vec::new();
        let mut of: Vec<i32> = Vec::new();
        let mut parent: Vec<i32> = Vec::new();
        for i in 0..n {
            if !nodes[i].is_group {
                continue;
            }
            group[i] = parent.len() as i32;
            parent.push(-1);
        }
        for i in 0..n {
            let p = nodes[i].parent;
            if nodes[i].is_group {
                parent[group[i] as usize] = if p >= 0 { group[p as usize] } else { -1 };
            } else {
                leaf[i] = lnodes.len() as i32;
                let (w, h) = if vertical { (nodes[i].w, nodes[i].h) } else { (nodes[i].h, nodes[i].w) };
                lnodes.push(lnode(w, h, Kind::Node));
                of.push(if p >= 0 { group[p as usize] } else { -1 });
            }
        }
        let mut ledges: Vec<LEdge> = Vec::new();
        let mut ledge_of = vec![-1i32; edges.len()];
        for (ei, e) in edges.iter().enumerate() {
            if e.src == e.dst || leaf[e.src] < 0 || leaf[e.dst] < 0 {
                continue;
            }
            ledge_of[ei] = ledges.len() as i32;
            let (lw, lh) = if vertical { (e.label_w, e.label_h) } else { (e.label_h, e.label_w) };
            ledges.push(ledge(leaf[e.src] as usize, leaf[e.dst] as usize, e.minlen, lw, lh));
        }
        let mut flat_opt = opt.clone();
        flat_opt.groups = Some(Groups { of, parent });
        flat_opt.order_only = true;
        let flat_layout = layered(&mut lnodes, &mut ledges, &flat_opt);
        flat_crossings = flat_layout.crossings.unwrap_or(0).min(flat_layout.declared.unwrap_or(0));
        let mut sum = vec![0.0f64; n];
        let mut count = vec![0usize; n];
        let mut last = vec![-1i32; n];
        for i in 0..n {
            if leaf[i] < 0 {
                continue;
            }
            let li = leaf[i] as usize;
            key[i] = lnodes[li].x;
            let mut p = nodes[i].parent;
            while p >= 0 {
                let pu = p as usize;
                sum[pu] += key[i];
                count[pu] += 1;
                last[pu] = last[pu].max(lnodes[li].rank as i32);
                p = nodes[pu].parent;
            }
        }
        for i in 0..n {
            if count[i] > 0 {
                key[i] = sum[i] / (count[i] as f64);
            }
        }
        flat_guide = Some(FlatGuide { ledge_of, ledges, last });
    }

    let mut laid: HashMap<i32, Vec<CachedLayout>> = HashMap::new();
    let mut local = vec![0usize; n];
    let mut total = CompoundResult { width: 0.0, height: 0.0 };

    let style = style_of(opt);
    let mut keyed = flat;
    place(
        &mut order,
        &level_idx,
        nodes,
        edges,
        &mut local,
        opt,
        ordered,
        keyed,
        &key,
        flat_guide.as_ref(),
        &mut laid,
        &mut total,
    );
    let mut crossings: Option<usize> = None;
    if flat {
        let c = route_crossings(nodes, edges, style);
        crossings = Some(c);
        if (c as f64) > (flat_crossings as f64) * FLAT_SLACK + FLAT_SPARE {
            let first = snapshot(nodes, edges, &order, total);
            keyed = false;
            place(
                &mut order,
                &level_idx,
                nodes,
                edges,
                &mut local,
                opt,
                ordered,
                keyed,
                &key,
                flat_guide.as_ref(),
                &mut laid,
                &mut total,
            );
            let own = route_crossings(nodes, edges, style);
            if own >= c {
                keyed = true;
                total = restore(first, nodes, edges, &mut order);
            } else {
                crossings = Some(own);
            }
        }
    }

    if keyed == flat && ordered {
        let mut again = false;
        for level in &mut order {
            if level.id < 0 {
                continue;
            }
            let box_node = &nodes[level.id as usize];
            let vertical = level.dir.is_vertical();
            let end = start_side(level.dir).opposite();
            let mut seen: Vec<(f64, f64)> = Vec::new();
            for port in &mut level.ports {
                if port.side != end {
                    continue;
                }
                let route = &edges[port.e].route;
                let bx = level.x + port.px;
                let by = level.y + port.py;
                let mut at: Option<usize> = None;
                let mut k = 0;
                while k + 1 < route.len() && (at.is_none() || port.out) {
                    if (route[k] - bx).abs() < 0.01 && (route[k + 1] - by).abs() < 0.01 {
                        at = Some(k);
                    }
                    k += 3;
                }
                let Some(at_idx) = at else {
                    continue;
                };
                let a = usize::from(!vertical);
                let step_delta: isize = if port.out { 3 } else { -3 };
                let mut next = at_idx as isize + step_delta;
                while next >= 0 && (next as usize) < route.len() && (route[next as usize + a] - route[at_idx + a]).abs() < IN_LINE {
                    next += step_delta;
                }
                if next < 0 || (next as usize) >= route.len() {
                    continue;
                }
                let base = if vertical {
                    box_node.x - box_node.w / 2.0
                } else {
                    box_node.y - box_node.h / 2.0
                };
                port.hint = route[next as usize + a] - base;
                seen.push((if vertical { port.px } else { port.py }, port.hint));
            }
            seen.sort_by(|p, q| p.0.total_cmp(&q.0));
            for i in 1..seen.len() {
                if seen[i - 1].1 > seen[i].1 {
                    again = true;
                }
            }
        }
        if again {
            let before = crossings.unwrap_or_else(|| route_crossings(nodes, edges, style));
            if before > 0 {
                let first = snapshot(nodes, edges, &order, total);
                place(
                    &mut order,
                    &level_idx,
                    nodes,
                    edges,
                    &mut local,
                    opt,
                    ordered,
                    keyed,
                    &key,
                    flat_guide.as_ref(),
                    &mut laid,
                    &mut total,
                );
                if route_crossings(nodes, edges, style) >= before {
                    total = restore(first, nodes, edges, &mut order);
                }
            }
        }
    }

    for ei in stray {
        let (ax, ay, bx, by) = {
            let e = &edges[ei];
            let a = &nodes[e.src];
            let b = &nodes[e.dst];
            (a.x, a.y, b.x, b.y)
        };
        let e = &mut edges[ei];
        e.route = vec![ax, ay, 0.0, bx, by, 0.0];
        e.label_x = (ax + bx) / 2.0;
        e.label_y = (ay + by) / 2.0;
    }
    for ei in loops {
        let e = &mut edges[ei];
        let node = &nodes[e.src];
        e.label_x = node.x + node.w / 2.0 + 28.0 + e.label_w / 2.0;
        e.label_y = node.y;
    }

    total
}
