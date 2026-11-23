use std::collections::HashSet;

use vibevalley_pele::layout::components::wrap_components;
use vibevalley_pele::layout::compound::{CEdge, CNode, Dir, RouteStyle, cedge, cnode, compound_layout, route_crossings};
use vibevalley_pele::layout::layered::{Groups, Kind, LayeredOptions, layered, ledge, lnode};

use crate::support::Lcg;

const DIRS: [Dir; 4] = [Dir::TB, Dir::BT, Dir::LR, Dir::RL];

fn base_options() -> LayeredOptions {
    LayeredOptions {
        node_sep: 40.0,
        edge_sep: 16.0,
        rank_sep: 48.0,
        port_sep: 20.0,
        ..LayeredOptions::default()
    }
}

fn edge(src: usize, dst: usize, label_w: f64, label_h: f64) -> CEdge {
    cedge(src, dst, 1, label_w, label_h)
}

fn plain_edge(src: usize, dst: usize) -> CEdge {
    edge(src, dst, 0.0, 0.0)
}

fn group(seq: usize) -> CNode {
    let mut node = cnode(0.0, 0.0, -1);
    node.is_group = true;
    node.pad_x = 20.0;
    node.pad_top = 40.0;
    node.pad_bottom = 20.0;
    node.span = f64::INFINITY;
    node.seq = seq;
    node
}

fn random_graph(seed: u32) -> (Vec<CNode>, Vec<CEdge>, Dir) {
    let mut rng = Lcg::new(seed);
    let mut nodes: Vec<CNode> = Vec::new();
    let mut groups: Vec<usize> = Vec::new();
    let group_count = rng.next_usize(5);
    for g in 0..group_count {
        let parent = if !groups.is_empty() && rng.next_f64() < 0.4 {
            groups[rng.next_usize(groups.len())] as i32
        } else {
            -1
        };
        let mut node = cnode(0.0, 0.0, parent);
        node.is_group = true;
        node.pad_x = 20.0;
        node.pad_top = 40.0;
        node.pad_bottom = 20.0;
        node.min_w = 60.0;
        node.dir = if rng.next_f64() < 0.3 { Some(DIRS[rng.next_usize(4)]) } else { None };
        node.seq = 1000 + g;
        if seed.is_multiple_of(2) {
            node.span = f64::INFINITY;
        }
        groups.push(nodes.len());
        nodes.push(node);
    }
    let leaves = 3 + rng.next_usize(30);
    for i in 0..leaves {
        let parent = if !groups.is_empty() && rng.next_f64() < 0.5 {
            groups[rng.next_usize(groups.len())] as i32
        } else {
            -1
        };
        let mut node = cnode(30.0 + rng.next_usize(120) as f64, 30.0 + rng.next_usize(50) as f64, parent);
        node.seq = i;
        if seed.is_multiple_of(2) {
            node.span = node.w.min(node.h) - 24.0;
        }
        nodes.push(node);
    }
    let mut edges = Vec::new();
    let count = rng.next_usize(leaves * 2);
    for _ in 0..count {
        let labelled = rng.next_f64() < 0.3;
        let src = rng.next_usize(nodes.len());
        let dst = rng.next_usize(nodes.len());
        let lw = if labelled { 20.0 + rng.next_usize(60) as f64 } else { 0.0 };
        let lh = if labelled { 24.0 } else { 0.0 };
        edges.push(edge(src, dst, lw, lh));
    }
    let dir = DIRS[rng.next_usize(4)];
    (nodes, edges, dir)
}

fn is_ancestor(nodes: &[CNode], a: usize, b: usize) -> bool {
    let mut p = nodes[b].parent;
    while p >= 0 {
        if p as usize == a {
            return true;
        }
        p = nodes[p as usize].parent;
    }
    false
}

fn on_border(node: &CNode, x: f64, y: f64) -> bool {
    let dx = (x - node.x).abs();
    let dy = (y - node.y).abs();
    let inside = dx <= node.w / 2.0 + 0.5 && dy <= node.h / 2.0 + 0.5;
    let edge_x = (dx - node.w / 2.0).abs() <= 0.5;
    let edge_y = (dy - node.h / 2.0).abs() <= 0.5;
    inside && (edge_x || edge_y)
}

fn assert_close(a: f64, b: f64, tol: f64, msg: &str) {
    assert!((a - b).abs() <= tol, "{msg}: expected {a} to be within {tol} of {b} (diff={})", (a - b).abs());
}

fn fan(children: usize, span: f64) -> (Vec<CNode>, Vec<CEdge>, f64) {
    let mut nodes = vec![cnode(100.0, 40.0, -1)];
    let mut edges = Vec::new();
    for i in 1..=children {
        nodes.push(cnode(100.0, 40.0, -1));
        edges.push(plain_edge(0, i));
    }
    for (i, node) in nodes.iter_mut().enumerate() {
        node.seq = i;
        node.span = span;
    }
    compound_layout(&mut nodes, &mut edges, Dir::TB, &base_options());
    let gap = nodes[1].y - nodes[0].y - 40.0;
    (nodes, edges, gap)
}

fn fan_in() -> (Vec<CNode>, Vec<CEdge>) {
    let mut nodes = vec![group(100), group(101), group(102), cnode(80.0, 60.0, 2)];
    let mut edges = Vec::new();
    for g in [0i32, 1] {
        for i in 0..5 {
            let v = nodes.len();
            let mut n = cnode(40.0, 40.0, g);
            n.seq = v;
            nodes.push(n);
            if i > 0 {
                edges.push(plain_edge(v - 1, v));
            }
            edges.push(plain_edge(v, 3));
        }
    }
    (nodes, edges)
}

#[test]
fn layered_orders_groups_side_by_side_and_counts_crossings() {
    let mut nodes: Vec<_> = (0..6).map(|_| lnode(40.0, 40.0, Kind::Node)).collect();
    let of = vec![0, 1, 0, -1, 0, -1];
    let mut edges = vec![
        ledge(0, 4, 1, 0.0, 0.0),
        ledge(1, 4, 1, 0.0, 0.0),
        ledge(2, 5, 1, 0.0, 0.0),
        ledge(3, 4, 1, 0.0, 0.0),
        ledge(3, 5, 1, 0.0, 0.0),
    ];
    let mut opt = base_options();
    opt.groups = Some(Groups {
        of: of.clone(),
        parent: vec![-1, -1],
    });
    opt.order_only = true;
    let res = layered(&mut nodes, &mut edges, &opt);

    let mut pieces: Vec<(f64, f64, f64)> = Vec::new();
    for e in &edges {
        let mut k = 2;
        while k < e.points.len() {
            pieces.push((e.points[k - 2], e.points[k - 1], e.points[k + 1]));
            k += 2;
        }
    }
    let mut crossed = 0usize;
    for i in 0..pieces.len() {
        for j in (i + 1)..pieces.len() {
            let (r, a0, a1) = pieces[i];
            let (s, b0, b1) = pieces[j];
            if r == s && (a0 - b0) * (a1 - b1) < 0.0 {
                crossed += 1;
            }
        }
    }
    assert_eq!(res.crossings, Some(crossed));

    for i in 0..nodes.len() {
        for j in 0..nodes.len() {
            if of[i] < 0 || of[j] != of[i] || nodes[i].rank != nodes[j].rank || nodes[i].x >= nodes[j].x {
                continue;
            }
            for k in 0..nodes.len() {
                let between = nodes[k].rank == nodes[i].rank && nodes[k].x > nodes[i].x && nodes[k].x < nodes[j].x;
                assert!(!(between && of[k] != of[i]), "node {k} between {i} and {j}");
            }
        }
    }
}

#[test]
fn compound_keeps_300_random_graphs_well_formed() {
    let opt = base_options();
    for seed in 1..=300u32 {
        let (mut nodes, mut edges, dir) = random_graph(seed);
        let size = compound_layout(&mut nodes, &mut edges, dir, &opt);
        let w = format!("seed {seed}");
        assert!(size.width.is_finite() && size.height.is_finite(), "{w}");

        for (i, node) in nodes.iter().enumerate() {
            assert!(node.x.is_finite() && node.y.is_finite(), "{w} node {i}");
            assert!(node.x - node.w / 2.0 >= -0.5, "{w} node {i} left");
            assert!(node.y - node.h / 2.0 >= -0.5, "{w} node {i} top");
            assert!(node.x + node.w / 2.0 <= size.width + 0.5, "{w} node {i} right");
            assert!(node.y + node.h / 2.0 <= size.height + 0.5, "{w} node {i} bottom");
            if node.parent >= 0 {
                let parent = &nodes[node.parent as usize];
                assert!((node.x - parent.x).abs() + node.w / 2.0 <= parent.w / 2.0 + 0.5, "{w} node {i} x in parent");
                assert!((node.y - parent.y).abs() + node.h / 2.0 <= parent.h / 2.0 + 0.5, "{w} node {i} y in parent");
            }
        }

        for a in 0..nodes.len() {
            for b in (a + 1)..nodes.len() {
                if nodes[a].parent != nodes[b].parent {
                    continue;
                }
                let overlap_x = (nodes[a].w + nodes[b].w) / 2.0 - (nodes[a].x - nodes[b].x).abs();
                let overlap_y = (nodes[a].h + nodes[b].h) / 2.0 - (nodes[a].y - nodes[b].y).abs();
                assert!(!(overlap_x > 0.5 && overlap_y > 0.5), "{w} nodes {a} and {b} overlap");
            }
        }

        for (i, e) in edges.iter().enumerate() {
            if e.src == e.dst {
                continue;
            }
            assert_eq!(e.route.len() % 3, 0, "{w} edge {i}");
            assert!(e.route.len() >= 6, "{w} edge {i} has route");
            assert!(e.route.iter().all(|v| v.is_finite()), "{w} edge {i} finite");
            if is_ancestor(&nodes, e.src, e.dst) || is_ancestor(&nodes, e.dst, e.src) {
                continue;
            }
            let last = e.route.len() - 3;
            assert!(on_border(&nodes[e.src], e.route[0], e.route[1]), "{w} edge {i} starts on source");
            assert!(on_border(&nodes[e.dst], e.route[last], e.route[last + 1]), "{w} edge {i} ends on target");
        }
    }
}

#[test]
fn compound_is_deterministic() {
    let opt = base_options();
    for seed in 1..=40u32 {
        let (mut n1, mut e1, d1) = random_graph(seed);
        let (mut n2, mut e2, d2) = random_graph(seed);
        compound_layout(&mut n1, &mut e1, d1, &opt);
        compound_layout(&mut n2, &mut e2, d2, &opt);
        let g1: Vec<_> = n1.iter().map(|n| (n.x, n.y, n.w, n.h)).collect();
        let g2: Vec<_> = n2.iter().map(|n| (n.x, n.y, n.w, n.h)).collect();
        assert_eq!(g1, g2, "seed {seed} nodes");
        let r1: Vec<_> = e1.iter().map(|e| &e.route).collect();
        let r2: Vec<_> = e2.iter().map(|e| &e.route).collect();
        assert_eq!(r1, r2, "seed {seed} routes");
    }
}

#[test]
fn compound_runs_ranks_along_requested_direction() {
    let opt = base_options();
    for dir in DIRS {
        let mut nodes = vec![cnode(60.0, 40.0, -1), cnode(60.0, 40.0, -1), cnode(60.0, 40.0, -1)];
        for (i, n) in nodes.iter_mut().enumerate() {
            n.seq = i;
        }
        let mut edges = vec![plain_edge(0, 1), plain_edge(1, 2)];
        compound_layout(&mut nodes, &mut edges, dir, &opt);
        let coord = |n: &CNode| if dir.is_vertical() { n.y } else { n.x };
        let sign = if dir.is_flipped() { -1.0 } else { 1.0 };
        assert!(sign * (coord(&nodes[1]) - coord(&nodes[0])) > 40.0);
        assert!(sign * (coord(&nodes[2]) - coord(&nodes[1])) > 40.0);
    }
}

#[test]
fn compound_keeps_long_edge_straight_through_skipped_ranks() {
    let mut nodes = vec![cnode(60.0, 40.0, -1), cnode(60.0, 40.0, -1), cnode(60.0, 40.0, -1)];
    for (i, n) in nodes.iter_mut().enumerate() {
        n.seq = i;
    }
    let mut edges = vec![plain_edge(0, 1), plain_edge(1, 2), plain_edge(0, 2)];
    compound_layout(&mut nodes, &mut edges, Dir::TB, &base_options());
    let route = &edges[2].route;
    let mut xs = HashSet::new();
    let mut i = 3;
    while i < route.len() - 3 {
        xs.insert(route[i].round() as i64);
        i += 3;
    }
    assert_eq!(xs.len(), 1);
}

#[test]
fn compound_runs_skip_edge_in_line_with_one_end() {
    let mut nodes: Vec<_> = (0..8)
        .map(|i| {
            let mut n = cnode(80.0, 40.0, -1);
            n.seq = i;
            n.span = 56.0;
            n
        })
        .collect();
    let mut edges = vec![
        plain_edge(0, 1),
        plain_edge(1, 2),
        plain_edge(2, 3),
        plain_edge(3, 4),
        plain_edge(4, 5),
        plain_edge(5, 6),
        plain_edge(6, 7),
        plain_edge(0, 3),
        plain_edge(0, 7),
        plain_edge(1, 5),
        plain_edge(2, 6),
        plain_edge(6, 1),
        plain_edge(7, 0),
    ];
    compound_layout(&mut nodes, &mut edges, Dir::TB, &base_options());
    let turns = |route: &[f64]| -> usize {
        let mut count = 0;
        let mut i = 3;
        while i < route.len() {
            if (route[i] - route[i - 3]).abs() > 0.01 {
                count += 1;
            }
            i += 3;
        }
        count
    };
    for e in &edges[7..] {
        assert_eq!(turns(&e.route), 1, "{} to {}", e.src, e.dst);
    }
    let down = &edges[9].route;
    let up = &edges[11].route;
    assert_close(down[3], down[0], 1e-4, "down");
    assert_close(up[up.len() - 6], up[up.len() - 3], 1e-4, "up");
}

#[test]
fn compound_edge_spreading_and_port_ordering() {
    // Without span, edges stay at center.
    {
        let mut nodes = vec![cnode(120.0, 40.0, -1), cnode(60.0, 40.0, -1), cnode(60.0, 40.0, -1), cnode(60.0, 40.0, -1)];
        for (i, n) in nodes.iter_mut().enumerate() {
            n.seq = i;
        }
        let mut edges = vec![plain_edge(0, 1), plain_edge(0, 2), plain_edge(0, 3)];
        compound_layout(&mut nodes, &mut edges, Dir::TB, &base_options());
        for e in &edges {
            assert_close(e.route[0], nodes[0].x, 1e-4, "center");
        }
    }

    // With span, spread in target order across all four directions.
    for dir in DIRS {
        let mut nodes = vec![cnode(120.0, 120.0, -1), cnode(60.0, 60.0, -1), cnode(60.0, 60.0, -1), cnode(60.0, 60.0, -1)];
        for (i, n) in nodes.iter_mut().enumerate() {
            n.seq = i;
        }
        nodes[0].span = 96.0;
        let mut edges = vec![plain_edge(0, 1), plain_edge(0, 2), plain_edge(0, 3)];
        compound_layout(&mut nodes, &mut edges, dir, &base_options());
        let across = if dir.is_vertical() { 0 } else { 1 };
        let center = if across == 0 { nodes[0].x } else { nodes[0].y };
        let starts: Vec<f64> = edges.iter().map(|e| e.route[across] - center).collect();
        let targets: Vec<f64> = edges.iter().map(|e| if across == 0 { nodes[e.dst].x } else { nodes[e.dst].y }).collect();
        let mut by_start = [0usize, 1, 2];
        by_start.sort_by(|&a, &b| starts[a].total_cmp(&starts[b]));
        let mut by_target = [0usize, 1, 2];
        by_target.sort_by(|&a, &b| targets[a].total_cmp(&targets[b]));
        assert_eq!(by_start, by_target, "dir={dir:?}");
        assert_close(starts[by_start[0]], -16.0, 1e-4, "first pitch");
        assert_close(starts[by_start[1]], 0.0, 1e-4, "middle pitch");
        assert_close(starts[by_start[2]], 16.0, 1e-4, "third pitch");
        for e in &edges {
            assert!(on_border(&nodes[0], e.route[0], e.route[1]), "dir={dir:?}");
        }
    }
}

#[test]
fn compound_separates_opposite_directions_and_shares_when_crowded() {
    // Opposite directions on same side stay a pitch apart.
    {
        let mut nodes = vec![cnode(60.0, 40.0, -1), cnode(60.0, 40.0, -1)];
        for (i, n) in nodes.iter_mut().enumerate() {
            n.seq = i;
            n.span = 36.0;
        }
        let mut edges = vec![plain_edge(0, 1), plain_edge(1, 0)];
        compound_layout(&mut nodes, &mut edges, Dir::TB, &base_options());
        let down = &edges[0].route;
        let up = &edges[1].route;
        assert_close((down[down.len() - 3] - up[0]).abs(), 16.0, 1e-4, "bottom");
        assert_close((down[0] - up[up.len() - 3]).abs(), 16.0, 1e-4, "top");
    }

    // 12 incoming + 1 outgoing on crowded side.
    {
        let mut nodes: Vec<_> = (0..=12)
            .map(|i| {
                let mut n = cnode(60.0, 40.0, -1);
                n.seq = i;
                n.span = 36.0;
                n
            })
            .collect();
        let mut edges: Vec<_> = (0..12).map(|i| plain_edge(i, 12)).collect();
        edges.push(plain_edge(12, 0));
        compound_layout(&mut nodes, &mut edges, Dir::TB, &base_options());
        let into: Vec<f64> = edges[..12].iter().map(|e| e.route[e.route.len() - 3]).collect();
        let unique: HashSet<i64> = into.iter().map(|x| (x * 100.0).round() as i64).collect();
        assert!(unique.len() <= 2);
        let back = &edges[12].route;
        assert_close(back[1], nodes[12].y - 20.0, 1e-4, "back y");
        for x in into {
            assert!((x - back[0]).abs() >= 8.0);
        }
    }
}

#[test]
fn compound_rank_alignment_gap_growth_and_levels() {
    let opt = base_options();

    // Rank alignment when spreading vs plain.
    let lay = |span: f64| -> Vec<CNode> {
        let mut nodes = vec![cnode(60.0, 40.0, -1), cnode(60.0, 120.0, -1), cnode(60.0, 30.0, -1), cnode(60.0, 90.0, -1)];
        for (i, n) in nodes.iter_mut().enumerate() {
            n.seq = i;
            n.span = span;
        }
        let mut edges = vec![plain_edge(0, 2), plain_edge(1, 2), plain_edge(0, 3), plain_edge(1, 3)];
        compound_layout(&mut nodes, &mut edges, Dir::TB, &opt);
        nodes
    };
    let spread = lay(36.0);
    assert_close(spread[0].y + 20.0, spread[1].y + 60.0, 1e-4, "send bottom");
    assert_close(spread[2].y - 15.0, spread[3].y - 45.0, 1e-4, "recv top");
    let plain = lay(0.0);
    assert_close(plain[0].y, plain[1].y, 1e-4, "plain top");
    assert_close(plain[2].y, plain[3].y, 1e-4, "plain bottom");

    // Gap growth without span.
    assert_close(fan(3, 0.0).2, opt.rank_sep, 1e-4, "fan 3");
    assert_close(fan(7, 0.0).2, 420.0 / 8.0, 1e-4, "fan 7");
    assert_close(fan(40, 0.0).2, 3.0 * opt.rank_sep, 1e-4, "fan 40");

    // Levels with span.
    let (_, few_edges, few_gap) = fan(3, 76.0);
    assert_close(few_gap, opt.rank_sep, 1e-4, "few gap");
    for e in &few_edges {
        assert_eq!(e.route.len(), 6);
    }
    let (nodes, edges, gap) = fan(7, 76.0);
    let level = |e: &CEdge| -> f64 {
        assert_eq!(e.route.len(), 12);
        assert_close(e.route[3], e.route[0], 1e-4, "v1");
        assert_close(e.route[7], e.route[4], 1e-4, "h");
        assert_close(e.route[9], e.route[6], 1e-4, "v2");
        e.route[4]
    };
    assert_close(level(&edges[1]) - level(&edges[0]), 12.0, 1e-4, "l1-l0");
    assert_close(level(&edges[2]) - level(&edges[1]), 12.0, 1e-4, "l2-l1");
    for i in 0..3 {
        assert_close(level(&edges[6 - i]), level(&edges[i]), 1e-4, "sym");
    }
    assert_eq!(edges[3].route.len(), 6);
    assert_close(edges[3].route[3], edges[3].route[0], 1e-4, "mid straight");
    assert_close(level(&edges[0]) - nodes[0].y - 20.0, 28.0, 1e-4, "clearance");
    assert_close(gap, 2.0 * 28.0 + 2.0 * 12.0, 1e-4, "total gap");

    // Complete K4,4 draws plain curves in taller gap.
    let mut k44_nodes: Vec<_> = (0..8)
        .map(|i| {
            let mut n = cnode(80.0, 40.0, -1);
            n.seq = i;
            n.span = 56.0;
            n
        })
        .collect();
    let mut k44_edges = Vec::new();
    for i in 0..4 {
        for j in 4..8 {
            k44_edges.push(plain_edge(i, j));
        }
    }
    compound_layout(&mut k44_nodes, &mut k44_edges, Dir::TB, &opt);
    for e in &k44_edges {
        assert_eq!(e.route.len(), 6);
    }
    let widest = k44_edges.iter().map(|e| (e.route[0] - e.route[3]).abs()).fold(0.0f64, f64::max);
    assert!(widest > 6.0 * opt.rank_sep);
    assert_close(k44_nodes[4].y - k44_nodes[0].y - 40.0, 3.0 * opt.rank_sep, 1e-4, "k44 gap");
}

#[test]
fn compound_label_headroom_and_back_edge_clearance() {
    let lay = |head_room: f64| -> Vec<CEdge> {
        let mut nodes = vec![cnode(60.0, 40.0, -1), cnode(60.0, 40.0, -1)];
        for (i, n) in nodes.iter_mut().enumerate() {
            n.seq = i;
            n.span = 36.0;
        }
        let mut edges = vec![edge(0, 1, 40.0, 20.0), edge(0, 1, 50.0, 20.0), plain_edge(0, 1)];
        let mut opt = base_options();
        opt.head_room = head_room;
        compound_layout(&mut nodes, &mut edges, Dir::TB, &opt);
        edges
    };
    let plain = lay(0.0);
    assert_close(plain[0].label_y, (40.0 + 108.0) / 2.0, 1e-4, "no headroom");
    let with_head = lay(8.0);
    assert_close(with_head[0].label_y, (40.0 + 108.0 - 8.0) / 2.0, 1e-4, "headroom 8");
    assert_close(with_head[1].label_y, with_head[0].label_y, 1e-4, "same labelY");
    assert_close(with_head[0].route[7] - with_head[0].route[4], 20.0, 1e-4, "labelled run");
    assert_close(with_head[2].route[7] - with_head[2].route[4], 10.0, 1e-4, "bare run");
    assert_close((with_head[2].route[4] + with_head[2].route[7]) / 2.0, with_head[0].label_y, 1e-4, "bare center");

    // Back edge clearance beside shorter edge.
    let mut nodes: Vec<_> = (0..5)
        .map(|i| {
            let mut n = cnode(80.0, 40.0, -1);
            n.seq = i;
            n.span = 56.0;
            n
        })
        .collect();
    let mut edges = vec![
        plain_edge(0, 1),
        plain_edge(0, 2),
        plain_edge(0, 3),
        plain_edge(1, 4),
        plain_edge(2, 4),
        plain_edge(3, 4),
        plain_edge(4, 0),
    ];
    let opt = base_options();
    compound_layout(&mut nodes, &mut edges, Dir::TB, &opt);
    let back = &edges[6].route;
    let n = back.len();
    let level = back[n - 5];
    assert_close(back[n - 8], level, 1e-4, "back level");
    assert_close(back[n - 6], back[n - 3], 1e-4, "back final vertical");
    assert!((back[n - 9] - back[n - 6]).abs() > 2.0 * opt.rank_sep);
    let down = &edges[2].route;
    assert!((down[0] - back[n - 3]).abs() < 20.0);
    assert_eq!(down.len(), 9);
    assert_close(down[3], down[0], 1e-4, "down straight");
    assert!(down[4] > level - 0.01);
}

#[test]
fn compound_straight_alignment_crowding_and_twins() {
    let opt = base_options();

    // Wide node above 4 narrow ones -> straight edges.
    let mut nodes = vec![
        cnode(400.0, 40.0, -1),
        cnode(40.0, 40.0, -1),
        cnode(40.0, 40.0, -1),
        cnode(40.0, 40.0, -1),
        cnode(40.0, 40.0, -1),
    ];
    for (i, n) in nodes.iter_mut().enumerate() {
        n.seq = i;
        n.span = n.w - 24.0;
    }
    let mut edges = vec![plain_edge(0, 1), plain_edge(0, 2), plain_edge(0, 3), plain_edge(0, 4)];
    compound_layout(&mut nodes, &mut edges, Dir::TB, &opt);
    for e in &edges {
        assert_close(e.route[0], e.route[e.route.len() - 3], 1e-4, "straight");
    }

    let mut two_way = vec![cnode(200.0, 40.0, -1), cnode(40.0, 40.0, -1)];
    for (i, n) in two_way.iter_mut().enumerate() {
        n.seq = i;
        n.span = n.w - 24.0;
    }
    let mut pair = vec![plain_edge(0, 1), plain_edge(1, 0)];
    compound_layout(&mut two_way, &mut pair, Dir::TB, &opt);
    assert_close((pair[0].route[0] - pair[1].route[pair[1].route.len() - 3]).abs(), 16.0, 1e-4, "two-way pitch");

    // 7 leaving edges squeeze to 6px pitch across 36px span.
    let mut sq_nodes = vec![cnode(60.0, 40.0, -1)];
    let mut sq_edges = Vec::new();
    for i in 1..=7 {
        sq_nodes.push(cnode(60.0, 40.0, -1));
        sq_edges.push(plain_edge(0, i));
    }
    for (i, n) in sq_nodes.iter_mut().enumerate() {
        n.seq = i;
    }
    sq_nodes[0].span = 36.0;
    compound_layout(&mut sq_nodes, &mut sq_edges, Dir::TB, &opt);
    let mut starts: Vec<f64> = sq_edges.iter().map(|e| e.route[0]).collect();
    starts.sort_by(f64::total_cmp);
    for i in 1..starts.len() {
        assert_close(starts[i] - starts[i - 1], 6.0, 1e-4, "squeezed gap");
    }

    // Twin edge rank avoidance for unrelated edges.
    let lay_twin = |twin: bool| -> Vec<CEdge> {
        let mut tn: Vec<_> = (0..4)
            .map(|i| {
                let mut n = cnode(60.0, 40.0, -1);
                n.seq = i;
                n.span = 36.0;
                n
            })
            .collect();
        let mut te = vec![plain_edge(0, 1), plain_edge(0, 2), plain_edge(0, 3)];
        if twin {
            te.push(plain_edge(0, 3));
        }
        compound_layout(&mut tn, &mut te, Dir::TB, &opt);
        te
    };
    let plain = lay_twin(false);
    let twinned = lay_twin(true);
    for e in &twinned[..2] {
        assert_eq!(e.route.len(), 6);
    }
    assert_close(twinned[0].route[1], plain[0].route[1], 1e-4, "start y");
    assert_close(twinned[0].route[4], plain[0].route[4] + 2.0 * 28.0 + 12.0 - opt.rank_sep, 1e-4, "end y");
    let one = &twinned[2].route;
    let other = &twinned[3].route;
    assert!((one[0] - other[0]).abs() >= 8.0);
    assert!((one[one.len() - 3] - other[other.len() - 3]).abs() >= 8.0);
    let turns_at = |r: &[f64]| if (r[3] - r[0]).abs() < 0.01 { r[4] } else { r[1] };
    assert!((turns_at(one) - turns_at(other)).abs() >= 10.0);

    // Twin edges without span bend apart by edge_sep.
    let mut no_span = vec![cnode(60.0, 40.0, -1), cnode(60.0, 40.0, -1)];
    for (i, n) in no_span.iter_mut().enumerate() {
        n.seq = i;
    }
    let mut no_span_e = vec![plain_edge(0, 1), plain_edge(0, 1)];
    compound_layout(&mut no_span, &mut no_span_e, Dir::TB, &opt);
    assert_eq!(no_span_e[0].route.len(), 9);
    assert_eq!(no_span_e[1].route.len(), 9);
    assert_close(no_span_e[0].route[0], no_span_e[1].route[0], 1e-4, "same start");
    assert_close((no_span_e[0].route[3] - no_span_e[1].route[3]).abs(), opt.edge_sep, 1e-4, "edge sep");
}

#[test]
fn compound_tracks_route_at_right_angles_on_120_random_graphs() {
    let mut opt = base_options();
    opt.tracks = true;
    for seed in 1..=120u32 {
        let mut rng = Lcg::new(seed.wrapping_mul(7919));
        let count = 3 + rng.next_usize(14);
        let mut nodes = Vec::with_capacity(count);
        for i in 0..count {
            let mut n = cnode(40.0 + rng.next_usize(120) as f64, 30.0 + rng.next_usize(60) as f64, -1);
            n.seq = i;
            n.span = n.w - 24.0;
            nodes.push(n);
        }
        let wanted = rng.next_usize((count as f64 * 2.5) as usize);
        let mut edges = Vec::new();
        for _ in 0..wanted {
            let src = rng.next_usize(count);
            let dst = rng.next_usize(count);
            if src != dst {
                let lw = if rng.next_f64() < 0.2 { 30.0 + rng.next_usize(40) as f64 } else { 0.0 };
                edges.push(edge(src, dst, lw, 20.0));
            }
        }
        compound_layout(&mut nodes, &mut edges, Dir::TB, &opt);
        let w = format!("seed {seed}");
        struct Run {
            y: f64,
            lo: f64,
            hi: f64,
            from: f64,
            to: f64,
        }
        let mut runs: Vec<Run> = Vec::new();
        for (ei, e) in edges.iter().enumerate() {
            let r = &e.route;
            assert!(on_border(&nodes[e.src], r[0], r[1]), "{w} edge {ei} start");
            assert!(on_border(&nodes[e.dst], r[r.len() - 3], r[r.len() - 2]), "{w} edge {ei} end");
            let mut k = 3;
            while k < r.len() {
                let across = (r[k + 1] - r[k - 2]).abs() < 0.01;
                let down = (r[k] - r[k - 3]).abs() < 0.5;
                assert!(across || down, "{w} edge {ei} right angles");
                if across && !down {
                    let before = if k >= 6 { r[k - 5] } else { r[k - 2] };
                    let from_first = before < r[k - 2] - 0.01 || (k + 4 < r.len() && r[k + 4] > r[k + 1] + 0.01);
                    runs.push(Run {
                        y: r[k + 1],
                        lo: r[k].min(r[k - 3]),
                        hi: r[k].max(r[k - 3]),
                        from: if from_first { r[k - 3] } else { r[k] },
                        to: if from_first { r[k] } else { r[k - 3] },
                    });
                }
                k += 3;
            }
        }
        for a in 0..runs.len() {
            for b in (a + 1)..runs.len() {
                if (runs[a].y - runs[b].y).abs() > 0.01 {
                    continue;
                }
                let overlap = runs[a].lo < runs[b].hi - 0.5 && runs[b].lo < runs[a].hi - 0.5;
                let mates = (runs[a].from - runs[b].from).abs() < 0.5 || (runs[a].to - runs[b].to).abs() < 0.5;
                assert!(!(overlap && !mates), "{w} runs {a} and {b} lie on one track");
            }
        }
        for run in &runs {
            for node in &nodes {
                let inside = (run.y - node.y).abs() < node.h / 2.0 - 0.5 && run.lo < node.x + node.w / 2.0 - 0.5 && run.hi > node.x - node.w / 2.0 + 0.5;
                assert!(!inside, "{w} run crosses a node");
            }
        }
    }
}

#[test]
fn compound_tracks_nest_fan_and_count_crossings() {
    let mut opt = base_options();
    opt.tracks = true;
    let mut nodes = vec![
        cnode(120.0, 40.0, -1),
        cnode(60.0, 40.0, -1),
        cnode(60.0, 40.0, -1),
        cnode(60.0, 40.0, -1),
        cnode(60.0, 40.0, -1),
    ];
    for (i, n) in nodes.iter_mut().enumerate() {
        n.seq = i;
    }
    nodes[0].span = 96.0;
    let mut edges = vec![plain_edge(0, 1), plain_edge(0, 2), plain_edge(0, 3), plain_edge(0, 4)];
    compound_layout(&mut nodes, &mut edges, Dir::TB, &opt);
    let mut left: Vec<&CEdge> = edges.iter().filter(|e| nodes[e.dst].x < nodes[0].x).collect();
    left.sort_by(|a, b| nodes[a.dst].x.total_cmp(&nodes[b.dst].x));
    let mut right: Vec<&CEdge> = edges.iter().filter(|e| nodes[e.dst].x > nodes[0].x).collect();
    right.sort_by(|a, b| nodes[b.dst].x.total_cmp(&nodes[a.dst].x));
    for side in [&left, &right] {
        for i in 1..side.len() {
            assert!(side[i - 1].route[4] < side[i].route[4]);
        }
    }

    // route_crossings on crossing vs fanning vs merged runs vs styles.
    let mut cnodes: Vec<_> = (0..4)
        .map(|i| {
            let mut n = cnode(40.0, 40.0, -1);
            n.x = 100.0 * (i % 2) as f64;
            n.y = 200.0 * (i / 2) as f64;
            n
        })
        .collect();
    let mut crossed = vec![plain_edge(0, 3), plain_edge(1, 2)];
    crossed[0].route = vec![0.0, 20.0, 0.0, 100.0, 180.0, 0.0];
    crossed[1].route = vec![100.0, 20.0, 0.0, 0.0, 180.0, 0.0];
    assert_eq!(route_crossings(&cnodes, &crossed, RouteStyle::Linear), 1);

    let mut fan_e = vec![plain_edge(0, 2), plain_edge(0, 3)];
    fan_e[0].route = vec![10.0, 20.0, 0.0, 0.0, 180.0, 0.0];
    fan_e[1].route = vec![-10.0, 20.0, 0.0, 100.0, 180.0, 0.0];
    assert_eq!(route_crossings(&cnodes, &fan_e, RouteStyle::Linear), 0);

    // Merged straight runs into one node.
    let mut mnodes = vec![cnode(40.0, 40.0, -1), cnode(40.0, 40.0, -1), cnode(40.0, 40.0, -1)];
    mnodes[1].x = 100.0;
    mnodes[2].x = 50.0;
    mnodes[2].y = 300.0;
    let mut medges = vec![plain_edge(0, 2), plain_edge(1, 2)];
    medges[0].route = vec![0.0, 20.0, 0.0, 0.0, 200.0, 0.0, 50.0, 200.0, 0.0, 50.0, 280.0, 0.0];
    medges[1].route = vec![100.0, 20.0, 0.0, 100.0, 150.0, 0.0, 50.0, 150.0, 0.0, 50.0, 280.0, 0.0];
    assert_eq!(route_crossings(&mnodes, &medges, RouteStyle::Linear), 0);

    let (mut fi_nodes, mut fi_edges) = fan_in();
    compound_layout(&mut fi_nodes, &mut fi_edges, Dir::TB, &opt);
    assert_eq!(route_crossings(&fi_nodes, &fi_edges, RouteStyle::Linear), 0);

    // Corner rounding clears crossing.
    cnodes[0].x = 0.0;
    cnodes[0].y = -20.0;
    cnodes[1].x = 120.0;
    cnodes[1].y = 100.0;
    cnodes[2].x = 5.0;
    cnodes[2].y = 170.0;
    cnodes[3].x = 5.0;
    cnodes[3].y = 40.0;
    let mut corner = vec![plain_edge(0, 1), plain_edge(2, 3)];
    corner[0].route = vec![0.0, 0.0, 0.0, 0.0, 100.0, 0.0, 100.0, 100.0, 1.0];
    corner[1].route = vec![5.0, 150.0, 0.0, 5.0, 60.0, 0.0];
    assert_eq!(route_crossings(&cnodes, &corner, RouteStyle::Curved), 0);
    assert_eq!(route_crossings(&cnodes, &corner, RouteStyle::Stepped), 1);
    assert_eq!(route_crossings(&cnodes, &corner, RouteStyle::Linear), 1);

    let (mut fi_nodes2, mut fi_edges2) = fan_in();
    compound_layout(&mut fi_nodes2, &mut fi_edges2, Dir::TB, &base_options());
    assert!(route_crossings(&fi_nodes2, &fi_edges2, RouteStyle::Curved) <= 4);
}

#[test]
fn compound_group_ports_row_ordering_and_cyclic_groups() {
    let opt = base_options();

    // Port ordering on far side of groups for TB and LR.
    for dir in [Dir::TB, Dir::LR] {
        let mut nodes = vec![group(100), group(101), group(102), cnode(80.0, 40.0, 2)];
        let mut edges = Vec::new();
        for g in [0i32, 1] {
            for i in 0..5 {
                let v = nodes.len();
                nodes.push(cnode(100.0, 40.0, g));
                if i > 0 {
                    edges.push(plain_edge(v - 1, v));
                }
                edges.push(plain_edge(v, 3));
            }
        }
        for (i, node) in nodes.iter_mut().enumerate() {
            if node.is_group {
                continue;
            }
            node.seq = i;
            node.span = 72.0;
        }
        compound_layout(&mut nodes, &mut edges, dir, &opt);
        let across = if dir == Dir::TB { 0 } else { 1 };
        let at = |e: &CEdge, g: usize| -> f64 {
            let mut k = 0;
            while k < e.route.len() {
                if on_border(&nodes[g], e.route[k], e.route[k + 1]) {
                    return e.route[k + across];
                }
                k += 3;
            }
            f64::NAN
        };
        let fan_e: Vec<&CEdge> = edges.iter().filter(|e| e.dst == 3).collect();
        let leave: Vec<f64> = fan_e.iter().map(|e| at(e, nodes[e.src].parent as usize)).collect();
        let enter: Vec<f64> = fan_e.iter().map(|e| at(e, 2)).collect();
        let signum = |v: f64| {
            if v > 0.0 {
                1
            } else if v < 0.0 {
                -1
            } else {
                0
            }
        };
        for i in 0..fan_e.len() {
            assert!(!leave[i].is_nan() && !enter[i].is_nan(), "{dir:?} edge {i}");
            for j in (i + 1)..fan_e.len() {
                assert_eq!(signum(leave[i] - leave[j]), signum(enter[i] - enter[j]), "{dir:?} edges {i} and {j}");
            }
        }
    }

    // Straight across group border gap.
    for dir in [Dir::TB, Dir::LR] {
        let mut nodes = vec![group(100), group(101)];
        let from: Vec<usize> = (0..3)
            .map(|_| {
                let id = nodes.len();
                nodes.push(cnode(60.0, 30.0, 0));
                id
            })
            .collect();
        let to: Vec<usize> = (0..5)
            .map(|_| {
                let id = nodes.len();
                nodes.push(cnode(60.0, 30.0, 1));
                id
            })
            .collect();
        for (i, node) in nodes.iter_mut().enumerate() {
            if node.is_group {
                continue;
            }
            node.seq = i;
            node.span = node.w.min(node.h) - 8.0;
        }
        let mut edges = Vec::new();
        for &b in &to {
            for &a in &from {
                edges.push(edge(a, b, 40.0, 16.0));
            }
        }
        compound_layout(&mut nodes, &mut edges, dir, &opt);
        let across = if dir == Dir::TB { 0 } else { 1 };
        for (i, e) in edges.iter().enumerate() {
            let last = e.route.len() - 3;
            let mut k = 0;
            while k < last && !on_border(&nodes[1], e.route[k], e.route[k + 1]) {
                k += 3;
            }
            assert!(k < last, "{dir:?} edge {i} enters");
            assert_close(e.route[k + across], e.route[last + across], 1e-4, "enters straight");
            k = last;
            while k > 0 && !on_border(&nodes[0], e.route[k], e.route[k + 1]) {
                k -= 3;
            }
            assert!(k > 0, "{dir:?} edge {i} leaves");
            assert_close(e.route[k + across], e.route[across], 1e-4, "leaves straight");
        }
    }

    // Straight when ends are less than a twin apart.
    {
        let mut nodes = vec![group(100), cnode(48.0, 48.0, 0), cnode(70.0, 66.0, 0), cnode(48.0, 48.0, -1)];
        for (i, n) in nodes.iter_mut().enumerate() {
            if i > 0 {
                n.seq = i;
            }
        }
        nodes[1].span = 24.0;
        nodes[2].span = 0.995;
        nodes[3].span = 24.0;
        let mut edges = vec![edge(1, 2, 40.0, 16.0), plain_edge(2, 3), plain_edge(3, 2)];
        compound_layout(&mut nodes, &mut edges, Dir::TB, &opt);
        for e in &edges[1..] {
            let xs: Vec<f64> = e.route.iter().step_by(3).copied().collect();
            let lo = xs[0].min(*xs.last().unwrap());
            let hi = xs[0].max(*xs.last().unwrap());
            for x in xs {
                assert!(x >= lo - 1.0 && x <= hi + 1.0);
            }
        }
    }

    // Edge into a group runs straight when only bends need to move.
    {
        let mut nodes = vec![group(100), group(101)];
        let mut leaf = |parent: i32| -> usize {
            let v = nodes.len();
            let mut n = cnode(54.0, 48.0, parent);
            n.seq = v;
            n.span = 24.0;
            nodes.push(n);
            v
        };
        let (a1, a2, a3, b1, b2, c, d) = (leaf(0), leaf(0), leaf(0), leaf(1), leaf(1), leaf(-1), leaf(-1));
        let mut edges = vec![
            plain_edge(a1, a2),
            plain_edge(a1, a3),
            plain_edge(b1, b2),
            plain_edge(a2, b1),
            plain_edge(a3, b1),
            plain_edge(b2, a1),
            plain_edge(c, 0),
            plain_edge(c, 1),
            plain_edge(0, d),
            plain_edge(1, d),
        ];
        compound_layout(&mut nodes, &mut edges, Dir::TB, &opt);
        let route = &edges[7].route;
        let x = route[route.len() - 3];
        let mut k = 0;
        while k < route.len() {
            if route[k + 1] > nodes[c].y + nodes[c].h / 2.0 + 24.0 {
                assert_close(route[k], x, 1e-4, "straight into group");
            }
            k += 3;
        }
    }

    // Row of 3 groups ordered as one drawing -> 0 crossings.
    {
        let mut nodes = vec![group(100), group(101), group(102)];
        let mut stage = |g: i32| -> Vec<usize> {
            (0..5)
                .map(|_| {
                    let v = nodes.len();
                    let mut n = cnode(80.0, 40.0, g);
                    n.seq = v + 1;
                    nodes.push(n);
                    v
                })
                .collect()
        };
        let a = stage(0);
        let b = stage(1);
        let c = stage(2);
        let mut edges = Vec::new();
        for (i, &j) in [4usize, 2, 0, 3, 1].iter().enumerate() {
            edges.push(plain_edge(a[i], b[j]));
        }
        for (i, &j) in [1usize, 3, 0, 4, 2].iter().enumerate() {
            edges.push(plain_edge(b[i], c[j]));
        }
        compound_layout(&mut nodes, &mut edges, Dir::LR, &opt);
        assert_eq!(route_crossings(&nodes, &edges, RouteStyle::Linear), 0);
    }

    // Cyclic group containment survives without infinite recursion.
    {
        let mut a = cnode(0.0, 0.0, 1);
        let mut b = cnode(0.0, 0.0, 0);
        a.is_group = true;
        b.is_group = true;
        let leaf = cnode(40.0, 40.0, 0);
        let mut nodes = vec![a, b, leaf, cnode(40.0, 40.0, -1)];
        let mut edges = vec![plain_edge(2, 3)];
        let size = compound_layout(&mut nodes, &mut edges, Dir::TB, &opt);
        assert!(size.width.is_finite());
        assert!(edges[0].route.len() >= 6);
    }
}

#[test]
fn wrap_components_folds_disconnected_nodes_to_fit_width() {
    let mut nodes: Vec<CNode> = (0..6)
        .map(|i| {
            let mut n = cnode(100.0, 40.0, -1);
            n.seq = i;
            n
        })
        .collect();
    let mut edges: Vec<CEdge> = Vec::new();
    let natural = compound_layout(&mut nodes, &mut edges, Dir::TB, &base_options());
    assert!(natural.width > 500.0);
    let wrapped = wrap_components(&mut nodes, &mut edges, 280.0, 30.0);
    assert!(wrapped.is_some());
    let size = wrapped.unwrap();
    assert!(size.width <= 280.0);
    assert!(size.height > natural.height);
}
