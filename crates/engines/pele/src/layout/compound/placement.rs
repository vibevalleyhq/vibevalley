use std::collections::HashMap;

use crate::layout::layered::{Kind, LEdge, LNode, LayeredOptions, layered, ledge, lnode, orient, rank};

use super::types::{CEdge, CNode, CachedLayout, CompoundResult, FlatGuide, Level, Side, endpoint_below, same_f64_bits, start_side};

#[allow(clippy::too_many_arguments)]
fn build_level(
    level: &Level,
    all_levels: &[Level],
    level_idx: &HashMap<i32, usize>,
    nodes: &[CNode],
    edges: &[CEdge],
    local: &mut [usize],
    keyed: bool,
    key: &[f64],
    flat_guide: Option<&FlatGuide>,
    sized: bool,
) -> (Vec<LNode>, Vec<LEdge>, Vec<i32>) {
    let vertical = level.dir.is_vertical();
    let start = start_side(level.dir);
    let mut lnodes: Vec<LNode> = Vec::with_capacity(level.items.len() + level.ports.len());
    let mut ledges: Vec<LEdge> = Vec::with_capacity(level.edges.len() + level.ports.len());
    for (i, &item) in level.items.iter().enumerate() {
        local[item] = i;
        let node = &nodes[item];
        let mut ln = if sized {
            lnode(if vertical { node.w } else { node.h }, if vertical { node.h } else { node.w }, Kind::Node)
        } else {
            lnode(0.0, 0.0, Kind::Node)
        };
        ln.span = if node.is_group { node.span.min(ln.w - 2.0 * node.pad_x) } else { node.span };
        ln.key = if keyed { key[item] } else { f64::NAN };
        lnodes.push(ln);
    }
    let held = |item: usize, ei: usize, out: bool| -> bool { nodes[item].is_group && endpoint_below(item, &edges[ei], out) };
    let offset = |item: usize, ei: usize, out: bool| -> f64 {
        if !sized || !nodes[item].is_group || !endpoint_below(item, &edges[ei], out) {
            return 0.0;
        }
        let child_lv = &all_levels[level_idx[&(item as i32)]];
        let p_idx = child_lv.port_of[&(ei * 2 + usize::from(!out))];
        let port = &child_lv.ports[p_idx];
        if vertical {
            port.px - nodes[item].w / 2.0
        } else {
            port.py - nodes[item].h / 2.0
        }
    };
    for le in &level.edges {
        let e = &edges[le.e];
        let mut edge = ledge(local[le.a], local[le.b], e.minlen, 0.0, 0.0);
        if sized {
            edge.label_w = if vertical { e.label_w } else { e.label_h };
            edge.label_h = if vertical { e.label_h } else { e.label_w };
            edge.tail_dx = offset(le.a, le.e, true);
            edge.head_dx = offset(le.b, le.e, false);
            edge.tail_fixed = held(le.a, le.e, true);
            edge.head_fixed = held(le.b, le.e, false);
        }
        ledges.push(edge);
    }
    let mut dummies = vec![-1i32; level.ports.len()];
    for (i, port) in level.ports.iter().enumerate() {
        if port.side == start || port.side == start.opposite() {
            let d = lnodes.len();
            let mut ln = lnode(0.0, 0.0, if port.side == start { Kind::StartPort } else { Kind::EndPort });
            ln.key = if keyed {
                key[if port.out { edges[port.e].dst } else { edges[port.e].src }]
            } else {
                f64::NAN
            };
            ln.hint = if port.hint.is_nan() && keyed {
                if let Some(fg) = flat_guide {
                    let le = fg.ledge_of[port.e];
                    if le < 0 || level.id < 0 || !port.out || port.side != start_side(level.dir).opposite() {
                        f64::NAN
                    } else {
                        let points = &fg.ledges[le as usize].points;
                        let mut inside = key[edges[port.e].src];
                        let mut outside = 0.0f64;
                        let last_r = fg.last[level.id as usize] as f64;
                        let mut k = 0;
                        while k + 1 < points.len() {
                            if points[k] == last_r {
                                inside = points[k + 1];
                            }
                            if points[k] == last_r + 1.0 {
                                outside = points[k + 1];
                            }
                            k += 2;
                        }
                        inside + outside * 1e-6
                    }
                } else {
                    f64::NAN
                }
            } else {
                port.hint
            };
            lnodes.push(ln);
            dummies[i] = d as i32;
            let mut edge = if port.out {
                ledge(local[port.inner], d, 1, 0.0, 0.0)
            } else {
                ledge(d, local[port.inner], 1, 0.0, 0.0)
            };
            if port.out {
                edge.tail_dx = offset(port.inner, port.e, true);
                edge.tail_fixed = held(port.inner, port.e, true);
            } else {
                edge.head_dx = offset(port.inner, port.e, false);
                edge.head_fixed = held(port.inner, port.e, false);
            }
            ledges.push(edge);
        } else {
            lnodes[local[port.inner]].pin = if port.side == Side::Top || port.side == Side::Left { -1 } else { 1 };
        }
    }
    (lnodes, ledges, dummies)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn place(
    order: &mut [Level],
    level_idx: &HashMap<i32, usize>,
    nodes: &mut [CNode],
    edges: &mut [CEdge],
    local: &mut [usize],
    opt: &LayeredOptions,
    ordered: bool,
    keyed: bool,
    key: &[f64],
    flat_guide: Option<&FlatGuide>,
    laid: &mut HashMap<i32, Vec<CachedLayout>>,
    total: &mut CompoundResult,
) {
    // Rank parents first to determine which group sides edges cross.
    for q in 0..order.len() {
        let ports_copy: Vec<(usize, usize, bool, Side)> = order[q].ports.iter().map(|p| (p.inner, p.e, p.out, p.side)).collect();
        for (inner, pe, pout, pside) in ports_copy {
            if nodes[inner].is_group && endpoint_below(inner, &edges[pe], pout) {
                let child_idx = level_idx[&(inner as i32)];
                let p_idx = order[child_idx].port_of[&(pe * 2 + usize::from(!pout))];
                order[child_idx].ports[p_idx].side = pside;
            }
        }
        if order[q].edges.is_empty() {
            continue;
        }
        let needed = order[q].edges.iter().any(|le| {
            let e = &edges[le.e];
            (nodes[le.a].is_group && e.src != le.a) || (nodes[le.b].is_group && e.dst != le.b)
        });
        if !needed {
            continue;
        }
        let (mut lnodes, mut ledges, _) = build_level(&order[q], order, level_idx, nodes, edges, local, keyed, key, flat_guide, false);
        orient(&lnodes, &mut ledges);
        rank(&mut lnodes, &ledges, 1);
        let start = start_side(order[q].dir);
        let level_edges = order[q].edges.clone();
        for (i, le) in level_edges.iter().enumerate() {
            let e = &edges[le.e];
            let a_above = !ledges[i].reversed;
            if nodes[le.a].is_group && e.src != le.a {
                let child_idx = level_idx[&(le.a as i32)];
                let p_idx = order[child_idx].port_of[&(le.e * 2)];
                order[child_idx].ports[p_idx].side = if a_above { start.opposite() } else { start };
            }
            if nodes[le.b].is_group && e.dst != le.b {
                let child_idx = level_idx[&(le.b as i32)];
                let p_idx = order[child_idx].port_of[&(le.e * 2 + 1)];
                order[child_idx].ports[p_idx].side = if a_above { start } else { start.opposite() };
            }
        }
    }

    // Lay out children first so their sizes are known.
    for q in (0..order.len()).rev() {
        let level_id = order[q].id;
        let level_dir = order[q].dir;
        let vertical = level_dir.is_vertical();
        let flip = level_dir.is_flipped();
        let (mut lnodes, mut ledges, dummies) = build_level(&order[q], order, level_idx, nodes, edges, local, keyed, key, flat_guide, true);

        let size = if !ordered {
            layered(&mut lnodes, &mut ledges, opt)
        } else {
            let mut given = Vec::with_capacity(lnodes.len() * 7 + ledges.len() * 9);
            for ln in &lnodes {
                given.push(ln.w);
                given.push(ln.h);
                given.push(ln.kind.as_u8() as f64);
                given.push(ln.pin as f64);
                given.push(ln.hint);
                given.push(ln.key);
                given.push(ln.span);
            }
            for le in &ledges {
                given.push(le.tail as f64);
                given.push(le.head as f64);
                given.push(le.minlen as f64);
                given.push(le.label_w);
                given.push(le.label_h);
                given.push(le.tail_dx);
                given.push(le.head_dx);
                given.push(f64::from(u8::from(le.tail_fixed)));
                given.push(f64::from(u8::from(le.head_fixed)));
            }
            let past = laid.entry(level_id).or_default();
            let cached = past
                .iter()
                .find(|p| p.given.len() == given.len() && p.given.iter().zip(given.iter()).all(|(&a, &b)| same_f64_bits(a, b)));
            if let Some(hit) = cached {
                lnodes = hit.lnodes.clone();
                ledges = hit.ledges.clone();
                hit.size
            } else {
                let s = layered(&mut lnodes, &mut ledges, opt);
                past.push(CachedLayout {
                    given,
                    lnodes: lnodes.clone(),
                    ledges: ledges.clone(),
                    size: s,
                });
                s
            }
        };

        let content_w = if vertical { size.width } else { size.height };
        let content_h = if vertical { size.height } else { size.width };
        let (pad_x, pad_top, pad_bottom, min_w) = if level_id >= 0 {
            let g = &nodes[level_id as usize];
            (g.pad_x, g.pad_top, g.pad_bottom, g.min_w)
        } else {
            (0.0, 0.0, 0.0, 0.0)
        };
        let box_w = (content_w + 2.0 * pad_x).max(min_w);
        let box_h = content_h + pad_top + pad_bottom;
        let off_x = (box_w - content_w) / 2.0;
        let off_y = pad_top;
        let tx = |lx: f64, ly: f64| -> f64 {
            off_x
                + if vertical {
                    lx
                } else if flip {
                    size.height - ly
                } else {
                    ly
                }
        };
        let ty = |lx: f64, ly: f64| -> f64 { off_y + if vertical { if flip { size.height - ly } else { ly } } else { lx } };
        let axis = if vertical { 0.0 } else { 1.0 };
        let convert = |points: &[f64]| -> Vec<f64> {
            let mut out = Vec::with_capacity((points.len() / 2) * 3);
            let mut i = 0;
            while i + 1 < points.len() {
                out.push(tx(points[i], points[i + 1]));
                out.push(ty(points[i], points[i + 1]));
                out.push(axis);
                i += 2;
            }
            out
        };

        for (i, &item) in order[q].items.iter().enumerate() {
            nodes[item].x = tx(lnodes[i].x, lnodes[i].y);
            nodes[item].y = ty(lnodes[i].x, lnodes[i].y);
        }
        let level_edges = order[q].edges.clone();
        for (i, le) in level_edges.iter().enumerate() {
            let edge = &ledges[i];
            order[q].routes.insert(le.e, convert(&edge.points));
            let e = &mut edges[le.e];
            if e.label_w > 0.0 {
                e.label_x = tx(edge.label_x, edge.label_y);
                e.label_y = ty(edge.label_x, edge.label_y);
            }
        }
        let mut k = level_edges.len();
        let port_count = order[q].ports.len();
        for (i, &dummy_id) in dummies.iter().enumerate().take(port_count) {
            let port_e = order[q].ports[i].e;
            let port_inner = order[q].ports[i].inner;
            let port_out = order[q].ports[i].out;
            let port_side = order[q].ports[i].side;
            if dummy_id >= 0 {
                let mut route = convert(&ledges[k].points);
                k += 1;
                let at = if port_out { route.len() - 3 } else { 0 };
                let mut bx = route[at];
                let mut by = route[at + 1];
                match port_side {
                    Side::Top => by = 0.0,
                    Side::Bottom => by = box_h,
                    Side::Left => bx = 0.0,
                    Side::Right => bx = box_w,
                }
                if port_out {
                    route.push(bx);
                    route.push(by);
                    route.push(axis);
                } else {
                    route.splice(0..0, [bx, by, axis]);
                }
                order[q].ports[i].px = bx;
                order[q].ports[i].py = by;
                order[q].ports[i].route = route;
                continue;
            }
            let item = &nodes[port_inner];
            let mut ix = item.x;
            let mut iy = item.y;
            if item.is_group && endpoint_below(port_inner, &edges[port_e], port_out) {
                let child_idx = level_idx[&(port_inner as i32)];
                let inner_p_idx = order[child_idx].port_of[&(port_e * 2 + usize::from(!port_out))];
                let inner_port = &order[child_idx].ports[inner_p_idx];
                ix += inner_port.px - item.w / 2.0;
                iy += inner_port.py - item.h / 2.0;
            } else {
                match port_side {
                    Side::Top => iy -= item.h / 2.0,
                    Side::Bottom => iy += item.h / 2.0,
                    Side::Left => ix -= item.w / 2.0,
                    Side::Right => ix += item.w / 2.0,
                }
            }
            let mut bx = ix;
            let mut by = iy;
            match port_side {
                Side::Top => by = 0.0,
                Side::Bottom => by = box_h,
                Side::Left => bx = 0.0,
                Side::Right => bx = box_w,
            }
            let a = match port_side {
                Side::Top | Side::Bottom => 0.0,
                Side::Left | Side::Right => 1.0,
            };
            order[q].ports[i].px = bx;
            order[q].ports[i].py = by;
            order[q].ports[i].route = if port_out { vec![ix, iy, a, bx, by, a] } else { vec![bx, by, a, ix, iy, a] };
        }

        if level_id >= 0 {
            let g = &mut nodes[level_id as usize];
            g.w = box_w;
            g.h = box_h;
        } else {
            *total = CompoundResult { width: box_w, height: box_h };
        }
    }

    for q in 0..order.len() {
        let ox = order[q].x;
        let oy = order[q].y;
        let items = order[q].items.clone();
        for item in items {
            nodes[item].x += ox;
            nodes[item].y += oy;
            if nodes[item].is_group {
                let child_idx = level_idx[&(item as i32)];
                order[child_idx].x = nodes[item].x - nodes[item].w / 2.0;
                order[child_idx].y = nodes[item].y - nodes[item].h / 2.0;
            }
        }
    }

    let append = |route: &mut Vec<f64>, part: &[f64], ox: f64, oy: f64| {
        let mut i = 0;
        while i + 2 < part.len() {
            let x = part[i] + ox;
            let y = part[i + 1] + oy;
            let len = route.len();
            if len >= 3 && (route[len - 3] - x).abs() < 0.01 && (route[len - 2] - y).abs() < 0.01 {
                i += 3;
                continue;
            }
            route.push(x);
            route.push(y);
            route.push(part[i + 2]);
            i += 3;
        }
    };

    for q in 0..order.len() {
        let level_id = order[q].id;
        let level_x = order[q].x;
        let level_y = order[q].y;
        for le in &order[q].edges {
            let e = &mut edges[le.e];
            let mut route: Vec<f64> = Vec::new();
            let mut outward: Vec<usize> = Vec::new();
            let mut item = e.src;
            while nodes[item].parent != level_id {
                let p = nodes[item].parent;
                outward.push(level_idx[&p]);
                item = p as usize;
            }
            for lv_idx in outward {
                let lv = &order[lv_idx];
                let p_idx = lv.port_of[&(le.e * 2)];
                append(&mut route, &lv.ports[p_idx].route, lv.x, lv.y);
            }
            append(&mut route, &order[q].routes[&le.e], level_x, level_y);
            let mut inward: Vec<usize> = Vec::new();
            let mut item = e.dst;
            while nodes[item].parent != level_id {
                let p = nodes[item].parent;
                inward.push(level_idx[&p]);
                item = p as usize;
            }
            for lv_idx in inward.into_iter().rev() {
                let lv = &order[lv_idx];
                let p_idx = lv.port_of[&(le.e * 2 + 1)];
                append(&mut route, &lv.ports[p_idx].route, lv.x, lv.y);
            }
            e.route = route;
            if e.label_w > 0.0 {
                e.label_x += level_x;
                e.label_y += level_y;
            }
        }
    }
}
