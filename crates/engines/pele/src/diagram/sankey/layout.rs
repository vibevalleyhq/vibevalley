use std::cmp::Ordering;

use crate::detect::DiagramType;
use crate::error::{ErrorCode, PeleError};

use super::db::SankeyModel;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Alignment {
    Justify,
    Left,
    Right,
    Center,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LayoutOptions {
    pub width: f64,
    pub height: f64,
    pub node_width: f64,
    pub node_padding: f64,
    pub label_height: f64,
    pub alignment: Alignment,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlacedNode {
    pub layer: usize,
    pub value: f64,
    pub x: f64,
    pub y: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlacedLink {
    pub source: usize,
    pub target: usize,
    pub value: f64,
    pub thickness: f64,
    pub source_y: f64,
    pub target_y: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SankeyLayout {
    pub nodes: Vec<PlacedNode>,
    pub links: Vec<PlacedLink>,
}

const PASSES: usize = 6;

fn cmp_f64_then_idx(va: f64, vb: f64, ia: usize, ib: usize) -> Ordering {
    let diff = va - vb;
    if diff < 0.0 {
        Ordering::Less
    } else if diff > 0.0 {
        Ordering::Greater
    } else {
        ia.cmp(&ib)
    }
}

pub fn layout_sankey(model: &SankeyModel, options: LayoutOptions) -> Result<SankeyLayout, PeleError> {
    let n = model.nodes.len();
    let mut links: Vec<PlacedLink> = model
        .links
        .iter()
        .map(|link| PlacedLink {
            source: link.source,
            target: link.target,
            value: if link.value.is_finite() && link.value > 0.0 { link.value } else { 0.0 },
            thickness: 0.0,
            source_y: 0.0,
            target_y: 0.0,
        })
        .collect();

    let mut outgoing: Vec<Vec<usize>> = vec![Vec::new(); n];
    let mut incoming: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (k, link) in links.iter().enumerate() {
        outgoing[link.source].push(k);
        incoming[link.target].push(k);
    }

    let mut depth = vec![0usize; n];
    let mut pending: Vec<usize> = incoming.iter().map(Vec::len).collect();
    let mut order: Vec<usize> = Vec::with_capacity(n);
    for (i, &deg) in pending.iter().enumerate() {
        if deg == 0 {
            order.push(i);
        }
    }
    let mut q = 0usize;
    while q < order.len() {
        let i = order[q];
        q += 1;
        for &k in &outgoing[i] {
            let t = links[k].target;
            if depth[t] < depth[i] + 1 {
                depth[t] = depth[i] + 1;
            }
            pending[t] -= 1;
            if pending[t] == 0 {
                order.push(t);
            }
        }
    }

    if order.len() < n {
        let mut stuck = pending.iter().position(|&deg| deg > 0).unwrap_or(0);
        let mut seen = vec![false; n];
        while !seen[stuck] {
            seen[stuck] = true;
            for &k in &incoming[stuck] {
                if pending[links[k].source] > 0 {
                    stuck = links[k].source;
                    break;
                }
            }
        }
        return Err(PeleError::new(
            format!("Sankey diagrams cannot have circular links, and \"{}\" is part of one.", model.nodes[stuck].id),
            ErrorCode::Semantic,
        )
        .with_diagram_type(DiagramType::Sankey));
    }

    let mut layers = 1usize;
    for &d in &depth {
        if d + 1 > layers {
            layers = d + 1;
        }
    }
    let mut reach = vec![0usize; n];
    for &i in order.iter().rev() {
        for &k in &outgoing[i] {
            let r = reach[links[k].target] + 1;
            if reach[i] < r {
                reach[i] = r;
            }
        }
    }

    let largest = links.iter().map(|l| l.value).fold(0.0f64, f64::max);
    let unit = if largest > 0.0 { 1.0 / largest } else { 0.0 };

    let mut nodes: Vec<PlacedNode> = Vec::with_capacity(n);
    let mut flow = vec![0.0f64; n];
    let mut columns: Vec<Vec<usize>> = vec![Vec::new(); layers];
    let step = if layers > 1 {
        (options.width - options.node_width) / ((layers - 1) as f64)
    } else {
        0.0
    };

    for i in 0..n {
        let layer = match options.alignment {
            Alignment::Left => depth[i],
            Alignment::Right => layers - 1 - reach[i],
            Alignment::Center => {
                if incoming[i].is_empty() && !outgoing[i].is_empty() {
                    let mut best = layers;
                    for &k in &outgoing[i] {
                        let cand = depth[links[k].target].saturating_sub(1);
                        if cand < best {
                            best = cand;
                        }
                    }
                    best
                } else {
                    depth[i]
                }
            }
            Alignment::Justify => {
                if !outgoing[i].is_empty() {
                    depth[i]
                } else {
                    layers - 1
                }
            }
        };
        let mut into = 0.0f64;
        let mut out = 0.0f64;
        let mut val_in = 0.0f64;
        let mut val_out = 0.0f64;
        for &k in &incoming[i] {
            into += links[k].value * unit;
            val_in += links[k].value;
        }
        for &k in &outgoing[i] {
            out += links[k].value * unit;
            val_out += links[k].value;
        }
        flow[i] = into.max(out);
        nodes.push(PlacedNode {
            layer,
            value: val_in.max(val_out),
            x: (layer as f64) * step,
            y: 0.0,
            height: 0.0,
        });
        columns[layer].push(i);
    }

    let tallest = columns.iter().map(Vec::len).max().unwrap_or(1).max(1);
    let gap = if tallest > 1 {
        options.node_padding.min(options.height / ((tallest - 1) as f64))
    } else {
        options.node_padding
    };
    let mut scale = f64::INFINITY;
    for column in &columns {
        let sum: f64 = column.iter().map(|&i| flow[i]).sum();
        if sum > 0.0 {
            let room = options.height - ((column.len().saturating_sub(1)) as f64) * gap;
            scale = scale.min(room / sum);
        }
    }
    if !scale.is_finite() || scale < 0.0 {
        scale = 0.0;
    }

    let mut claim = (options.label_height - gap).max(0.0);
    let fits = |s: f64, claim: f64| -> bool {
        for column in &columns {
            let mut extent = (column.len().saturating_sub(1) as f64) * gap;
            for &i in column {
                extent += (flow[i] * s).max(claim);
            }
            if extent > options.height + 1e-6 {
                return false;
            }
        }
        true
    };
    if claim > 0.0 && !fits(scale, claim) {
        if fits(0.0, claim) {
            let mut low = 0.0f64;
            for _ in 0..40 {
                let mid = (low + scale) / 2.0;
                if fits(mid, claim) {
                    low = mid;
                } else {
                    scale = mid;
                }
            }
            scale = low;
        } else {
            claim = 0.0;
        }
    }

    let mut margin = vec![0.0f64; n];
    for link in &mut links {
        link.thickness = link.value * unit * scale;
    }
    for column in &columns {
        let mut y = 0.0f64;
        for &i in column {
            nodes[i].height = flow[i] * scale;
            margin[i] = (claim - nodes[i].height).max(0.0) / 2.0;
            nodes[i].y = y + margin[i];
            y += nodes[i].height + 2.0 * margin[i] + gap;
        }
        let spare = (options.height - y + gap) / ((column.len() + 1) as f64);
        for (k, &i) in column.iter().enumerate() {
            nodes[i].y += spare * ((k + 1) as f64);
        }
    }

    let mut source_offset = vec![0.0f64; links.len()];
    let mut target_offset = vec![0.0f64; links.len()];

    let stack_out = |i: usize, outgoing: &mut [Vec<usize>], nodes: &[PlacedNode], links: &[PlacedLink], source_offset: &mut [f64]| {
        outgoing[i].sort_by(|&a, &b| {
            let ca = nodes[links[a].target].y + nodes[links[a].target].height / 2.0;
            let cb = nodes[links[b].target].y + nodes[links[b].target].height / 2.0;
            cmp_f64_then_idx(ca, cb, a, b)
        });
        let mut y = 0.0f64;
        for &k in &outgoing[i] {
            source_offset[k] = y + links[k].thickness / 2.0;
            y += links[k].thickness;
        }
    };
    let stack_in = |i: usize, incoming: &mut [Vec<usize>], nodes: &[PlacedNode], links: &[PlacedLink], target_offset: &mut [f64]| {
        incoming[i].sort_by(|&a, &b| {
            let ca = nodes[links[a].source].y + nodes[links[a].source].height / 2.0;
            let cb = nodes[links[b].source].y + nodes[links[b].source].height / 2.0;
            cmp_f64_then_idx(ca, cb, a, b)
        });
        let mut y = 0.0f64;
        for &k in &incoming[i] {
            target_offset[k] = y + links[k].thickness / 2.0;
            y += links[k].thickness;
        }
    };

    for i in 0..n {
        stack_out(i, &mut outgoing, &nodes, &links, &mut source_offset);
        stack_in(i, &mut incoming, &nodes, &links, &mut target_offset);
    }

    for pass in 0..PASSES {
        let pull = 0.99f64.powi(pass as i32);
        for l in (0..layers.saturating_sub(1)).rev() {
            for &i in &columns[l] {
                if outgoing[i].is_empty() {
                    continue;
                }
                stack_out(i, &mut outgoing, &nodes, &links, &mut source_offset);
                let mut weighted = 0.0f64;
                let mut weight = 0.0f64;
                let mut plain = 0.0f64;
                for &k in &outgoing[i] {
                    let t = links[k].target;
                    let level = nodes[t].y + target_offset[k] - source_offset[k];
                    weighted += level * links[k].thickness;
                    weight += links[k].thickness;
                    plain += (nodes[t].y + nodes[t].height / 2.0) - nodes[i].height / 2.0;
                }
                let wanted = if weight > 0.0 {
                    weighted / weight
                } else {
                    plain / (outgoing[i].len() as f64)
                };
                nodes[i].y += (wanted - nodes[i].y) * pull;
            }
            columns[l].sort_by(|&a, &b| {
                let ca = nodes[a].y + nodes[a].height / 2.0;
                let cb = nodes[b].y + nodes[b].height / 2.0;
                cmp_f64_then_idx(ca, cb, a, b)
            });
            let mut y = 0.0f64;
            for &i in &columns[l] {
                if nodes[i].y - margin[i] < y {
                    nodes[i].y = y + margin[i];
                }
                y = nodes[i].y + nodes[i].height + margin[i] + gap;
            }
            let mut y = options.height;
            for &i in columns[l].iter().rev() {
                if nodes[i].y + nodes[i].height + margin[i] > y {
                    nodes[i].y = y - nodes[i].height - margin[i];
                }
                y = nodes[i].y - margin[i] - gap;
            }
        }
        for i in 0..n {
            stack_out(i, &mut outgoing, &nodes, &links, &mut source_offset);
            stack_in(i, &mut incoming, &nodes, &links, &mut target_offset);
        }

        for column in columns.iter_mut().take(layers).skip(1) {
            for &i in column.iter() {
                if incoming[i].is_empty() {
                    continue;
                }
                stack_in(i, &mut incoming, &nodes, &links, &mut target_offset);
                let mut weighted = 0.0f64;
                let mut weight = 0.0f64;
                let mut plain = 0.0f64;
                for &k in &incoming[i] {
                    let s = links[k].source;
                    let level = nodes[s].y + source_offset[k] - target_offset[k];
                    weighted += level * links[k].thickness;
                    weight += links[k].thickness;
                    plain += (nodes[s].y + nodes[s].height / 2.0) - nodes[i].height / 2.0;
                }
                let wanted = if weight > 0.0 {
                    weighted / weight
                } else {
                    plain / (incoming[i].len() as f64)
                };
                nodes[i].y += (wanted - nodes[i].y) * pull;
            }
            column.sort_by(|&a, &b| {
                let ca = nodes[a].y + nodes[a].height / 2.0;
                let cb = nodes[b].y + nodes[b].height / 2.0;
                cmp_f64_then_idx(ca, cb, a, b)
            });
            let mut y = 0.0f64;
            for &i in column.iter() {
                if nodes[i].y - margin[i] < y {
                    nodes[i].y = y + margin[i];
                }
                y = nodes[i].y + nodes[i].height + margin[i] + gap;
            }
            let mut y = options.height;
            for &i in column.iter().rev() {
                if nodes[i].y + nodes[i].height + margin[i] > y {
                    nodes[i].y = y - nodes[i].height - margin[i];
                }
                y = nodes[i].y - margin[i] - gap;
            }
        }
        for i in 0..n {
            stack_out(i, &mut outgoing, &nodes, &links, &mut source_offset);
            stack_in(i, &mut incoming, &nodes, &links, &mut target_offset);
        }
    }

    for k in 0..links.len() {
        links[k].source_y = nodes[links[k].source].y + source_offset[k];
        links[k].target_y = nodes[links[k].target].y + target_offset[k];
    }

    Ok(SankeyLayout { nodes, links })
}
