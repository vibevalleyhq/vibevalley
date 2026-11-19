mod support;

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use regex::Regex;
use vibevalley_pele::diagram::ParsedModel;
use vibevalley_pele::layout::compound::{CEdge, CNode, Dir, cedge, cnode};
use vibevalley_pele::layout::lanes::lane_layout;
use vibevalley_pele::layout::layered::LayeredOptions;
use vibevalley_pele::svg::shapes::end_side;
use vibevalley_pele::{DiagramType, LinkInfo, ParseOptions, RenderOptions, detect_type, parse, render, render_model, supports};

use support::{
    Lcg, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, assert_well_formed, css_options, dark_options, load_fixture, resolved_options,
};

fn lane_opts() -> LayeredOptions {
    LayeredOptions {
        node_sep: 40.0,
        edge_sep: 16.0,
        rank_sep: 48.0,
        port_sep: 20.0,
        tracks: false,
        straight: false,
        apart: false,
        head_room: 0.0,
        groups: None,
        order_only: false,
    }
}

const DIRS: [Dir; 4] = [Dir::TB, Dir::BT, Dir::LR, Dir::RL];

fn make_edge(src: usize, dst: usize, label_w: f64, label_h: f64) -> CEdge {
    cedge(src, dst, 1, label_w, label_h)
}

fn make_group(parent: i32) -> CNode {
    let mut node = cnode(0.0, 0.0, parent);
    node.is_group = true;
    node.pad_x = 20.0;
    node.pad_top = 36.0;
    node.pad_bottom = 20.0;
    node.min_w = 60.0;
    node
}

struct Sample {
    nodes: Vec<CNode>,
    edges: Vec<CEdge>,
    lanes: Vec<usize>,
    leaves: Vec<usize>,
    lane_of: Vec<usize>,
    inner: Vec<usize>,
    inner_lane: Vec<usize>,
    dir: Dir,
}

fn random_graph(seed: u32) -> Sample {
    let mut rng = Lcg::new(seed);
    let mut nodes: Vec<CNode> = Vec::new();
    let mut leaves: Vec<usize> = Vec::new();
    let mut lanes: Vec<usize> = Vec::new();
    let leaf_count = 1 + rng.next_usize(30);
    let lane_count = 1 + rng.next_usize(5);
    let mut inner: Vec<usize> = Vec::new();
    let mut inner_lane: Vec<usize> = Vec::new();

    for i in 0..leaf_count {
        let w = (30 + rng.next_usize(120)) as f64;
        let h = (24 + rng.next_usize(60)) as f64;
        nodes.push(cnode(w, h, -1));
        leaves.push(i);
    }
    for _ in 0..lane_count {
        lanes.push(nodes.len());
        nodes.push(make_group(-1));
    }
    let inner_count = rng.next_usize(4);
    for _ in 0..inner_count {
        let lane = lanes[rng.next_usize(lane_count)];
        inner.push(nodes.len());
        inner_lane.push(lane);
        nodes.push(make_group(lane as i32));
    }
    let mut lane_of = vec![0usize; leaf_count];
    for &i in &leaves {
        if !inner.is_empty() && rng.next_f64() < 0.25 {
            let g = rng.next_usize(inner.len());
            nodes[i].parent = inner[g] as i32;
            lane_of[i] = inner_lane[g];
        } else {
            let l = lanes[rng.next_usize(lane_count)];
            lane_of[i] = l;
            nodes[i].parent = l as i32;
        }
    }
    let mut edges: Vec<CEdge> = Vec::new();
    let edge_count = rng.next_usize(leaf_count * 2);
    for _ in 0..edge_count {
        let labelled = rng.next_f64() < 0.3;
        let a = rng.next_usize(leaf_count);
        let b = rng.next_usize(leaf_count);
        let lw = if labelled { (20 + rng.next_usize(80)) as f64 } else { 0.0 };
        let lh = if labelled { 18.0 } else { 0.0 };
        edges.push(make_edge(a, b, lw, lh));
    }
    if rng.next_f64() < 0.3 {
        edges.push(make_edge(lanes[0], leaves[0], 0.0, 0.0));
    }
    let dir = DIRS[rng.next_usize(4)];
    Sample {
        nodes,
        edges,
        lanes,
        leaves,
        lane_of,
        inner,
        inner_lane,
        dir,
    }
}

fn cbox(c: &CNode) -> [f64; 4] {
    [c.x - c.w / 2.0, c.y - c.h / 2.0, c.x + c.w / 2.0, c.y + c.h / 2.0]
}

#[derive(Debug, Clone, Copy)]
struct Box2d {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn lanes_from_svg(svg: &str) -> Vec<(String, Box2d)> {
    let re =
        Regex::new(r#"<g class="pele-cluster pele-lane[^"]*" data-id="([^"]*)"><rect x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)""#).unwrap();
    re.captures_iter(svg)
        .map(|cap| {
            (
                cap[1].to_string(),
                Box2d {
                    x: cap[2].parse().unwrap(),
                    y: cap[3].parse().unwrap(),
                    w: cap[4].parse().unwrap(),
                    h: cap[5].parse().unwrap(),
                },
            )
        })
        .collect()
}

fn lanes_map(svg: &str) -> HashMap<String, Box2d> {
    lanes_from_svg(svg).into_iter().collect()
}

fn centers_from_svg(svg: &str) -> Vec<(String, (f64, f64))> {
    let re = Regex::new(r#"<g class="pele-node[^"]*" data-id="([^"]*)" transform="translate\(([-\d.]+),([-\d.]+)\)""#).unwrap();
    re.captures_iter(svg)
        .map(|cap| (cap[1].to_string(), (cap[2].parse().unwrap(), cap[3].parse().unwrap())))
        .collect()
}

fn centers_map(svg: &str) -> HashMap<String, (f64, f64)> {
    centers_from_svg(svg).into_iter().collect()
}

fn inside(p: (f64, f64), b: Box2d) -> bool {
    p.0 > b.x && p.0 < b.x + b.w && p.1 > b.y && p.1 < b.y + b.h
}

fn count_str(svg: &str, needle: &str) -> usize {
    svg.matches(needle).count()
}

const ORDER: &str = "swimlane-beta LR\n  subgraph Customer\n    browse[Browse] --> pay[Pay]\n  end\n  subgraph Warehouse\n    pick[Pick] --> ship[Ship]\n  end\n  pay -- paid --> pick";

#[test]
fn lane_layout_basics_directions_chains_and_handoff_routing() {
    let opts = lane_opts();

    // Empty graph.
    let empty = lane_layout(&mut [], &mut [], Dir::TB, &opts, None);
    assert_eq!(empty.width, 0.0);
    assert_eq!(empty.height, 0.0);

    // Lanes side by side across flow in written order.
    for dir in DIRS {
        let mut nodes = vec![cnode(60.0, 30.0, 3), cnode(60.0, 30.0, 2), make_group(-1), make_group(-1)];
        let mut edges = vec![make_edge(0, 1, 0.0, 0.0)];
        let result = lane_layout(&mut nodes, &mut edges, dir, &opts, None);
        let first = &nodes[3];
        let second = &nodes[2];
        if dir.is_vertical() {
            assert!(first.x < second.x);
            assert_eq!(first.h, result.height);
            assert!((first.w + second.w - result.width).abs() < 1e-6);
        } else {
            assert!(first.y < second.y);
            assert_eq!(first.w, result.width);
            assert!((first.h + second.h - result.height).abs() < 1e-6);
        }
    }

    // Flow direction.
    let at = |dir: Dir| -> Vec<CNode> {
        let mut nodes = vec![cnode(60.0, 30.0, 2), cnode(60.0, 30.0, 2), make_group(-1)];
        let mut edges = vec![make_edge(0, 1, 0.0, 0.0)];
        lane_layout(&mut nodes, &mut edges, dir, &opts, None);
        nodes
    };
    assert!(at(Dir::TB)[0].y < at(Dir::TB)[1].y);
    assert!(at(Dir::BT)[0].y > at(Dir::BT)[1].y);
    assert!(at(Dir::LR)[0].x < at(Dir::LR)[1].x);
    assert!(at(Dir::RL)[0].x > at(Dir::RL)[1].x);

    // Straight chain in one lane.
    {
        let mut nodes = vec![cnode(50.0, 30.0, 3), cnode(120.0, 30.0, 3), cnode(70.0, 30.0, 3), make_group(-1)];
        let mut edges = vec![make_edge(0, 1, 0.0, 0.0), make_edge(1, 2, 0.0, 0.0)];
        lane_layout(&mut nodes, &mut edges, Dir::TB, &opts, None);
        assert!((nodes[0].x - nodes[1].x).abs() < 1e-6);
        assert!((nodes[1].x - nodes[2].x).abs() < 1e-6);
    }

    // Approval decision separates incoming, accepted, and returned paths in all 4 directions.
    for dir in DIRS {
        let mut nodes = vec![
            cnode(60.0, 40.0, 8),
            cnode(80.0, 40.0, 7),
            cnode(70.0, 70.0, 7),
            cnode(80.0, 40.0, 6),
            cnode(80.0, 40.0, 6),
            cnode(60.0, 40.0, 8),
            make_group(-1),
            make_group(-1),
            make_group(-1),
        ];
        let mut edges = vec![
            make_edge(0, 1, 70.0, 20.0),
            make_edge(1, 2, 0.0, 0.0),
            make_edge(2, 3, 50.0, 20.0),
            make_edge(3, 4, 0.0, 0.0),
            make_edge(4, 5, 0.0, 0.0),
            make_edge(2, 0, 70.0, 20.0),
        ];
        lane_layout(&mut nodes, &mut edges, dir, &opts, None);
        let incoming = end_side(&edges[1].route, edges[1].route.len() - 3, &nodes[2]);
        let accepted = end_side(&edges[2].route, 0, &nodes[2]);
        let returned = end_side(&edges[5].route, 0, &nodes[2]);
        let set: HashSet<i32> = [incoming, accepted, returned].into_iter().collect();
        assert_eq!(set.len(), 3, "dir={dir:?}");
        assert!(!set.contains(&-1));
        let back = &edges[5];
        let mut corners = 0usize;
        let mut p = 6;
        while p < back.route.len() {
            if (back.route[p] == back.route[p - 3]) != (back.route[p - 3] == back.route[p - 6]) {
                corners += 1;
            }
            p += 3;
        }
        assert_eq!(corners, 1, "dir={dir:?}");
        let mut p = 3;
        while p < back.route.len() {
            assert!(back.route[p] == back.route[p - 3] || back.route[p + 1] == back.route[p - 2]);
            p += 3;
        }
        for node in &nodes[..6] {
            let [l, t, r, b] = cbox(node);
            let clear = back.label_x + back.label_w / 2.0 <= l
                || back.label_x - back.label_w / 2.0 >= r
                || back.label_y + back.label_h / 2.0 <= t
                || back.label_y - back.label_h / 2.0 >= b;
            assert!(clear, "dir={dir:?}");
        }
    }

    // Keeps handoff into a step apart from handoff out of it.
    for dir in DIRS {
        let mut nodes = vec![
            cnode(110.0, 38.0, 5),
            cnode(110.0, 38.0, 5),
            cnode(100.0, 38.0, 4),
            cnode(110.0, 38.0, 4),
            make_group(-1),
            make_group(-1),
        ];
        let mut edges = vec![make_edge(2, 3, 0.0, 0.0), make_edge(0, 3, 0.0, 0.0), make_edge(3, 1, 0.0, 0.0)];
        lane_layout(&mut nodes, &mut edges, dir, &opts, None);
        let into = &edges[1].route;
        let out = &edges[2].route;
        assert_ne!(end_side(into, into.len() - 3, &nodes[3]), end_side(out, 0, &nodes[3]));
        let mut p = 3;
        while p < into.len() {
            let mut q = 3;
            while q < out.len() {
                let upright = into[p] == into[p - 3] && out[q] == out[q - 3] && into[p] == out[q];
                let level = into[p + 1] == into[p - 2] && out[q + 1] == out[q - 2] && into[p + 1] == out[q + 1];
                if upright || level {
                    let k = if upright { 1 } else { 0 };
                    let shared = into[p + k].max(into[p - 3 + k]).min(out[q + k].max(out[q - 3 + k]))
                        - into[p + k].min(into[p - 3 + k]).max(out[q + k].min(out[q - 3 + k]));
                    assert!(shared <= 0.0);
                }
                q += 3;
            }
            p += 3;
        }
    }

    // Takes a return past intermediate steps around the margin of its lane.
    for dir in DIRS {
        let mut nodes = vec![
            cnode(140.0, 44.0, 8),
            cnode(140.0, 44.0, 8),
            cnode(140.0, 44.0, 7),
            cnode(120.0, 76.0, 7),
            cnode(140.0, 44.0, 6),
            cnode(140.0, 44.0, 6),
            make_group(-1),
            make_group(-1),
            make_group(-1),
        ];
        let mut edges = vec![
            make_edge(0, 1, 0.0, 0.0),
            make_edge(1, 2, 0.0, 0.0),
            make_edge(2, 3, 0.0, 0.0),
            make_edge(3, 4, 30.0, 20.0),
            make_edge(4, 5, 0.0, 0.0),
            make_edge(3, 0, 30.0, 20.0),
        ];
        lane_layout(&mut nodes, &mut edges, dir, &opts, None);
        let sideways = !dir.is_vertical();
        let across = |c: &CNode| if sideways { c.y } else { c.x };
        let along = |c: &CNode| if sideways { c.x } else { c.y };
        let depth = |c: &CNode| if sideways { c.w } else { c.h };
        assert!((across(&nodes[0]) - across(&nodes[1])).abs() < 1e-6);
        assert!((across(&nodes[4]) - across(&nodes[5])).abs() < 1e-6);
        let back = &edges[5].route;
        let sides: HashSet<i32> = [
            end_side(&edges[2].route, edges[2].route.len() - 3, &nodes[3]),
            end_side(&edges[3].route, 0, &nodes[3]),
            end_side(back, 0, &nodes[3]),
        ]
        .into_iter()
        .collect();
        assert_eq!(sides.len(), 3);
        assert_ne!(end_side(back, back.len() - 3, &nodes[0]), end_side(&edges[0].route, 0, &nodes[0]));
        let mut p = 3;
        while p < back.len() {
            assert!(back[p] == back[p - 3] || back[p + 1] == back[p - 2]);
            for (ni, node) in nodes[..6].iter().enumerate() {
                if ni == 0 || ni == 3 {
                    continue;
                }
                let [l, t, r, b] = cbox(node);
                assert!(
                    back[p].max(back[p - 3]) <= l || back[p].min(back[p - 3]) >= r || back[p + 1].max(back[p - 2]) <= t || back[p + 1].min(back[p - 2]) >= b
                );
            }
            p += 3;
        }
        let gap = |a: usize, b: usize| (along(&nodes[b]) - along(&nodes[a])).abs() - (depth(&nodes[a]) + depth(&nodes[b])) / 2.0;
        assert!(gap(1, 2) < gap(0, 1));
        assert!((gap(0, 1) - opts.rank_sep).abs() < 1e-6);
    }

    // Minlen=2 link beside a handoff.
    for dir in DIRS {
        let mut nodes = vec![
            cnode(80.0, 40.0, 5),
            cnode(80.0, 40.0, 5),
            cnode(80.0, 40.0, 5),
            cnode(80.0, 40.0, 4),
            make_group(-1),
            make_group(-1),
        ];
        let mut edges = vec![cedge(0, 1, 2, 0.0, 0.0), make_edge(1, 2, 0.0, 0.0), make_edge(2, 3, 0.0, 0.0)];
        lane_layout(&mut nodes, &mut edges, dir, &opts, None);
        let sideways = !dir.is_vertical();
        let gap = |a: usize, b: usize| {
            if sideways {
                (nodes[b].x - nodes[a].x).abs() - 80.0
            } else {
                (nodes[b].y - nodes[a].y).abs() - 40.0
            }
        };
        assert!((gap(0, 1) - 2.0 * opts.rank_sep).abs() < 1e-6);
        assert!((gap(1, 2) - opts.rank_sep).abs() < 1e-6);
    }

    // Routes a handoff clear of a lane-level edge label.
    {
        let mut nodes = vec![
            cnode(110.0, 38.0, 7),
            cnode(110.0, 38.0, 6),
            cnode(110.0, 38.0, 6),
            cnode(110.0, 38.0, 6),
            cnode(110.0, 38.0, 6),
            cnode(110.0, 38.0, 6),
            make_group(-1),
            make_group(-1),
        ];
        let mut edges = vec![
            make_edge(0, 1, 0.0, 0.0),
            make_edge(1, 2, 0.0, 0.0),
            make_edge(2, 3, 0.0, 0.0),
            make_edge(3, 4, 0.0, 0.0),
            make_edge(4, 5, 0.0, 0.0),
            make_edge(6, 5, 400.0, 200.0),
        ];
        lane_layout(&mut nodes, &mut edges, Dir::TB, &opts, None);
        let handoff = &edges[0].route;
        assert!(handoff.len() > 6);
        let mut p = 3;
        while p < handoff.len() {
            assert!(handoff[p] == handoff[p - 3] || handoff[p + 1] == handoff[p - 2]);
            p += 3;
        }
        let mut p = 1;
        while p < handoff.len() {
            assert!((handoff[p] - edges[5].label_y).abs() > 100.0);
            p += 3;
        }
    }
}

#[test]
fn lane_layout_keeps_600_random_graphs_well_formed_and_deterministic() {
    let opts = lane_opts();
    for lane_pad in [24.0, 12.0] {
        for seed in 1..=300 {
            let mut s = random_graph(seed);
            let result = lane_layout(&mut s.nodes, &mut s.edges, s.dir, &opts, Some(lane_pad));
            assert!(result.width.is_finite() && result.height.is_finite(), "seed {seed}");
            for c in &s.nodes {
                assert!(c.x.is_finite() && c.y.is_finite() && c.w.is_finite() && c.h.is_finite(), "seed {seed}");
            }
            for &i in &s.leaves {
                let [l, t, r, b] = cbox(&s.nodes[i]);
                let [ll, lt, lr, lb] = cbox(&s.nodes[s.lane_of[i]]);
                assert!(
                    l >= ll - 0.01 && r <= lr + 0.01 && t >= lt - 0.01 && b <= lb + 0.01,
                    "seed {seed}: node {i} in lane"
                );
            }
            for (k, &g) in s.inner.iter().enumerate() {
                if !s.leaves.iter().any(|&i| s.nodes[i].parent == g as i32) {
                    continue;
                }
                let [l, t, r, b] = cbox(&s.nodes[g]);
                let [ll, lt, lr, lb] = cbox(&s.nodes[s.inner_lane[k]]);
                assert!(
                    l >= ll - 0.01 && r <= lr + 0.01 && t >= lt - 0.01 && b <= lb + 0.01,
                    "seed {seed}: group {g} in lane"
                );
                for &i in &s.leaves {
                    if s.nodes[i].parent != g as i32 {
                        continue;
                    }
                    let [nl, nt, nr, nb] = cbox(&s.nodes[i]);
                    assert!(
                        nl >= l - 0.01 && nr <= r + 0.01 && nt >= t - 0.01 && nb <= b + 0.01,
                        "seed {seed}: node {i} in group"
                    );
                }
            }
            for a in 0..s.leaves.len() {
                for b in (a + 1)..s.leaves.len() {
                    let [al, at, ar, ab] = cbox(&s.nodes[s.leaves[a]]);
                    let [bl, bt, br, bb] = cbox(&s.nodes[s.leaves[b]]);
                    assert!(
                        ar <= bl + 0.01 || br <= al + 0.01 || ab <= bt + 0.01 || bb <= at + 0.01,
                        "seed {seed}: nodes {a} and {b} overlap"
                    );
                }
            }
            for a in 0..s.lanes.len() {
                let [l, t, r, b] = cbox(&s.nodes[s.lanes[a]]);
                assert!(
                    l >= -0.01 && t >= -0.01 && r <= result.width + 0.01 && b <= result.height + 0.01,
                    "seed {seed}: lane inside"
                );
                for k in (a + 1)..s.lanes.len() {
                    let [ol, ot, or, ob] = cbox(&s.nodes[s.lanes[k]]);
                    assert!(
                        r <= ol + 0.01 || or <= l + 0.01 || b <= ot + 0.01 || ob <= t + 0.01,
                        "seed {seed}: lanes overlap"
                    );
                }
            }
            for e in &s.edges {
                if e.src == e.dst {
                    continue;
                }
                assert!(e.route.len() >= 6 && e.route.len() % 3 == 0, "seed {seed}: route");
                for &v in &e.route {
                    assert!(v.is_finite(), "seed {seed}: route value");
                }
                let mut p = 0;
                while p < e.route.len() {
                    assert!(
                        e.route[p] >= -0.01 && e.route[p] <= result.width + 0.01 && e.route[p + 1] >= -0.01 && e.route[p + 1] <= result.height + 0.01,
                        "seed {seed}: route inside"
                    );
                    p += 3;
                }
                assert!(e.label_x.is_finite() && e.label_y.is_finite(), "seed {seed}: label");
            }
        }
    }

    // Determinism check.
    let mut a = random_graph(42);
    let mut b = random_graph(42);
    lane_layout(&mut a.nodes, &mut a.edges, a.dir, &opts, None);
    lane_layout(&mut b.nodes, &mut b.edges, b.dir, &opts, None);
    let a_pos: Vec<_> = a.nodes.iter().map(|c| (c.x, c.y, c.w, c.h)).collect();
    let b_pos: Vec<_> = b.nodes.iter().map(|c| (c.x, c.y, c.w, c.h)).collect();
    assert_eq!(a_pos, b_pos);
    let a_routes: Vec<_> = a.edges.iter().map(|e| &e.route).collect();
    let b_routes: Vec<_> = b.edges.iter().map(|e| &e.route).collect();
    assert_eq!(a_routes, b_routes);
}

#[test]
fn swimlane_detection_model_parity_lanes_directions_and_turning() {
    assert_eq!(detect_type(ORDER), Some(DiagramType::Swimlane));
    assert!(supports(ORDER));
    assert_eq!(render(ORDER, &css_options()).unwrap().diagram_type, DiagramType::Swimlane);
    assert_ne!(detect_type("swimlane-betax\n a --> b"), Some(DiagramType::Swimlane));

    // Same model as flowchart with same body.
    let lane_parsed = parse(ORDER, &ParseOptions::default()).unwrap();
    let flow_parsed = parse(&ORDER.replace("swimlane-beta", "flowchart"), &ParseOptions::default()).unwrap();
    let (ParsedModel::Swimlane(lane_db), ParsedModel::Flowchart(flow_db)) = (&lane_parsed.model, &flow_parsed.model) else {
        panic!("expected swimlane and flowchart models");
    };
    assert_eq!(lane_db.nodes.keys().collect::<Vec<_>>(), flow_db.nodes.keys().collect::<Vec<_>>());
    assert_eq!(
        lane_db.edges.iter().map(|e| (&e.start, &e.end, &e.text)).collect::<Vec<_>>(),
        flow_db.edges.iter().map(|e| (&e.start, &e.end, &e.text)).collect::<Vec<_>>()
    );
    assert_eq!(
        lane_db.subgraphs.iter().map(|s| (&s.id, &s.nodes)).collect::<Vec<_>>(),
        flow_db.subgraphs.iter().map(|s| (&s.id, &s.nodes)).collect::<Vec<_>>()
    );
    assert_eq!(lane_db.direction.as_deref(), Some("LR"));

    // Rejects invalid flowchart grammar.
    assert!(render("swimlane-beta LR\n  a --> ", &css_options()).is_err());
    assert!(render("swimlane-beta LR\n  subgraph x\n  a", &css_options()).is_err());

    // Draws one lane per top-level subgraph and keeps each node in its lane.
    let svg = render(ORDER, &css_options()).unwrap().svg;
    assert_well_formed(&svg).unwrap();
    assert!(svg.contains(r#"class="pele pele-swimlane""#));
    assert!(svg.contains(r#"aria-roledescription="swimlane""#));
    let lane_list = lanes_from_svg(&svg);
    let lane_ids: Vec<&str> = lane_list.iter().map(|(id, _)| id.as_str()).collect();
    assert_eq!(lane_ids, vec!["Warehouse", "Customer"]);
    let boxes = lanes_map(&svg);
    let at = centers_map(&svg);
    assert!(inside(at["browse"], boxes["Customer"]));
    assert!(inside(at["pay"], boxes["Customer"]));
    assert!(inside(at["pick"], boxes["Warehouse"]));
    assert!(inside(at["ship"], boxes["Warehouse"]));
    assert!(svg.contains(">paid<"));

    // Stacks down when sideways, across otherwise.
    assert!(boxes["Customer"].y < boxes["Warehouse"].y);
    assert_eq!(boxes["Customer"].x, boxes["Warehouse"].x);
    assert!(svg.contains(r#"transform="rotate(-90 "#));
    let down_svg = render(&ORDER.replace("LR", "TD"), &css_options()).unwrap().svg;
    let down = lanes_map(&down_svg);
    assert!(down["Customer"].x < down["Warehouse"].x);
    assert_eq!(down["Customer"].y, down["Warehouse"].y);
    assert!(!down_svg.contains("rotate("));

    // Lines up steps of the same rank across lanes.
    let aligned = centers_map(
        &render(
            "swimlane-beta TD\n  subgraph A\n    a1 --> a2\n  end\n  subgraph B\n    b1 --> b2\n  end\n  a1 --> b2",
            &css_options(),
        )
        .unwrap()
        .svg,
    );
    assert_eq!(aligned["a1"].1, aligned["b1"].1);
    assert_eq!(aligned["a2"].1, aligned["b2"].1);
    assert_eq!(aligned["a1"].0, aligned["a2"].0);

    // Turns long horizontal flows downward while retaining every lane, step, and relation.
    let examples = load_fixture("swimlane-corpus.json");
    let text_re = Regex::new(r"<text\b[^>]*>(.*?)</text>").unwrap();
    let tag_re = Regex::new(r"<[^>]+>|\s").unwrap();
    for src in [&examples[2], &examples[9]] {
        let parsed = parse(src, &ParseOptions::default()).unwrap();
        let wide = render_model(&parsed, &css_options()).unwrap();
        let mut narrow_opts = css_options();
        narrow_opts.max_width = Some(480.0);
        let narrow = render_model(&parsed, &narrow_opts).unwrap();
        assert!(narrow.width <= 480.0);
        assert!(narrow.height > wide.height);
        assert!(!narrow.svg.contains("rotate("));
        assert!(narrow.svg.contains("font:16px"));
        assert_eq!(
            lanes_from_svg(&narrow.svg).into_iter().map(|(id, _)| id).collect::<Vec<_>>(),
            lanes_from_svg(&wide.svg).into_iter().map(|(id, _)| id).collect::<Vec<_>>()
        );
        let narrow_boxes = lanes_map(&narrow.svg);
        let narrow_at = centers_map(&narrow.svg);
        if let ParsedModel::Swimlane(ref db) = parsed.model {
            for lane in &db.subgraphs {
                for id in &lane.nodes {
                    assert!(inside(narrow_at[id], narrow_boxes[&lane.id]));
                }
            }
        }
        assert_eq!(count_str(&narrow.svg, r#"class="pele-edge""#), count_str(&wide.svg, r#"class="pele-edge""#));
        assert_eq!(count_str(&narrow.svg, r#"class="pele-marker""#), count_str(&wide.svg, r#"class="pele-marker""#));
        let labels = |s: &str| -> Vec<String> { text_re.captures_iter(s).map(|c| tag_re.replace_all(&c[1], "").to_string()).collect() };
        assert_eq!(labels(&narrow.svg), labels(&wide.svg));
        let mut exact_opts = css_options();
        exact_opts.max_width = Some(wide.width);
        assert_eq!(render_model(&parsed, &exact_opts).unwrap().svg, wide.svg);
        assert_inert(&narrow.svg, "turned swimlane");
    }

    // autoDirection, directionBreakpoint, and already vertical direction.
    let src2 = &examples[2];
    let horizontal = render(
        src2,
        &RenderOptions {
            max_width: Some(480.0),
            auto_direction: Some(false),
            ..css_options()
        },
    )
    .unwrap()
    .svg;
    assert!(horizontal.contains("rotate(-90 "));
    assert_eq!(
        render(
            src2,
            &RenderOptions {
                max_width: Some(480.0),
                direction_breakpoint: Some(480.0),
                ..css_options()
            },
        )
        .unwrap()
        .svg,
        horizontal
    );
    assert!(
        render(
            src2,
            &RenderOptions {
                max_width: Some(700.0),
                ..css_options()
            },
        )
        .unwrap()
        .svg
        .contains("rotate(-90 ")
    );
    assert!(
        !render(
            src2,
            &RenderOptions {
                max_width: Some(700.0),
                direction_breakpoint: Some(800.0),
                ..css_options()
            },
        )
        .unwrap()
        .svg
        .contains("rotate(")
    );
    assert_eq!(
        render(
            src2,
            &RenderOptions {
                max_width: Some(480.0),
                ..css_options()
            },
        )
        .unwrap()
        .svg,
        render(
            &src2.replace("LR", "TB"),
            &RenderOptions {
                max_width: Some(480.0),
                ..css_options()
            },
        )
        .unwrap()
        .svg
    );
    assert_eq!(
        render(
            &src2.replace("LR", "RL"),
            &RenderOptions {
                max_width: Some(480.0),
                ..css_options()
            },
        )
        .unwrap()
        .svg,
        render(
            src2,
            &RenderOptions {
                max_width: Some(480.0),
                ..css_options()
            },
        )
        .unwrap()
        .svg
    );
    let up = centers_map(
        &render(
            &ORDER.replace("LR", "BT"),
            &RenderOptions {
                max_width: Some(160.0),
                ..css_options()
            },
        )
        .unwrap()
        .svg,
    );
    assert!(up["browse"].1 > up["pay"].1);

    // Keeps horizontal layout when turning would make it wider.
    let wide5 = format!(
        "swimlane-beta LR\n{}",
        (0..5).map(|i| format!("subgraph L{i}\n a{i} --> b{i}\nend")).collect::<Vec<_>>().join("\n")
    );
    let auto_wide5 = render(
        &wide5,
        &RenderOptions {
            max_width: Some(160.0),
            ..css_options()
        },
    )
    .unwrap()
    .svg;
    let fixed_wide5 = render(
        &wide5,
        &RenderOptions {
            max_width: Some(160.0),
            auto_direction: Some(false),
            ..css_options()
        },
    )
    .unwrap()
    .svg;
    assert_eq!(auto_wide5, fixed_wide5);
    assert!(auto_wide5.contains("rotate(-90 "));

    // Draws the changes branch from a separate side of the approval decision.
    let src9 = &examples[9];
    for max_width in [None, Some(320.0)] {
        let svg = render(src9, &RenderOptions { max_width, ..css_options() }).unwrap().svg;
        let (cx, cy) = centers_map(&svg)["decide"];
        let start_of = |id: &str| -> (f64, f64) {
            let re = Regex::new(&format!(r#"data-id="{id}"><path d="M([-\d.]+),([-\d.]+)"#)).unwrap();
            let cap = re.captures(&svg).unwrap();
            (cap[1].parse().unwrap(), cap[2].parse().unwrap())
        };
        let accepted = start_of("L_decide_create_0");
        let returned = start_of("L_decide_apply_0");
        if max_width.is_none() {
            assert_eq!(accepted.0, cx);
            assert_eq!(returned.0, cx);
            assert!(accepted.1 > cy);
            assert!(returned.1 < cy);
        } else {
            assert_eq!(accepted.1, cy);
            assert_eq!(returned.1, cy);
            assert!(accepted.0 > cx);
            assert!(returned.0 < cx);
        }
    }
}

#[test]
fn swimlane_features_styles_contrast_config_and_groups() {
    // Retains nested groups, unnamed/empty lanes, styles, links, and self-loops after turning.
    let rich = "---\ntitle: Delivery\n---\nswimlane-beta LR\naccTitle: Accessible delivery\naccDescr: Delivery process\nstart --> a\nsubgraph Team\n subgraph Inner\n a{Ready?} --> b[(Store)]\n b --> b\n end\n c --> d --> e\nend\nsubgraph Empty\nend\nb --> c\nclick a \"https://example.com\"\nstyle a fill:#f00\nclassDef hot stroke:#0f0\nclass b hot";
    let wide = render(rich, &css_options()).unwrap();
    let narrow = render(
        rich,
        &RenderOptions {
            max_width: Some(320.0),
            ..css_options()
        },
    )
    .unwrap();
    assert!(!narrow.svg.contains("rotate("));
    assert_eq!(lanes_map(&narrow.svg).len(), 3);
    let inner_re = Regex::new(r#"class="pele-cluster" data-id="Inner"><rect x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)""#).unwrap();
    let cap = inner_re.captures(&narrow.svg).unwrap();
    let inner_box = Box2d {
        x: cap[1].parse().unwrap(),
        y: cap[2].parse().unwrap(),
        w: cap[3].parse().unwrap(),
        h: cap[4].parse().unwrap(),
    };
    let at = centers_map(&narrow.svg);
    assert!(inside(at["a"], inner_box));
    assert!(inside(at["b"], inner_box));
    assert_eq!(narrow.links, wide.links);
    for val in [
        ">Delivery<",
        r#"<title id="pele-title">Accessible delivery</title>"#,
        "Delivery process",
        "fill:#f00",
        "stroke:#0f0",
        "pele-shape-diam",
        "pele-shape-cyl",
    ] {
        assert!(narrow.svg.contains(val), "missing {val}");
    }
    assert_eq!(count_str(&narrow.svg, r#"class="pele-edge""#), count_str(&wide.svg, r#"class="pele-edge""#));

    // All 4 directions.
    let y_of = |dir: &str, id: &str| {
        centers_map(
            &render(&format!("swimlane-beta {dir}\n  subgraph L\n    a --> b\n  end"), &css_options())
                .unwrap()
                .svg,
        )[id]
            .1
    };
    let x_of = |dir: &str, id: &str| {
        centers_map(
            &render(&format!("swimlane-beta {dir}\n  subgraph L\n    a --> b\n  end"), &css_options())
                .unwrap()
                .svg,
        )[id]
            .0
    };
    assert!(y_of("TB", "a") < y_of("TB", "b"));
    assert!(y_of("BT", "a") > y_of("BT", "b"));
    assert!(x_of("LR", "a") < x_of("LR", "b"));
    assert!(x_of("RL", "a") > x_of("RL", "b"));

    // Nodes outside every lane get their own lane.
    let loose_svg = render("swimlane-beta TD\n  start --> a\n  subgraph Team\n    a --> b\n  end", &css_options())
        .unwrap()
        .svg;
    let boxes = lanes_map(&loose_svg);
    assert_eq!(boxes.len(), 2);
    let loose_id = boxes.keys().find(|id| id.as_str() != "Team").unwrap();
    assert!(inside(centers_map(&loose_svg)["start"], boxes[loose_id]));
    assert!(boxes[loose_id].x < boxes["Team"].x);
    assert_eq!(lanes_map(&render("swimlane-beta TD\n  a --> b", &css_options()).unwrap().svg).len(), 1);

    // Empty lane + nested group.
    let nested_svg = render(
        "swimlane-beta TD\n  subgraph One\n    subgraph Inner\n      a --> b\n    end\n    c\n  end\n  subgraph Two\n  end\n  b --> c",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert_eq!(lanes_map(&nested_svg).len(), 2);
    assert_eq!(count_str(&nested_svg, r#"class="pele-cluster""#), 1);
    assert!(nested_svg.contains(">Inner<"));

    // Ignores direction inside a lane.
    let plain = render("swimlane-beta TD\n  subgraph L\n    a --> b\n  end", &css_options()).unwrap().svg;
    let turned = render("swimlane-beta TD\n  subgraph L\n    direction LR\n    a --> b\n  end", &css_options())
        .unwrap()
        .svg;
    assert_eq!(turned, plain);

    // Keeps flowchart features: shapes, styles, links, titles, accTitle/accDescr.
    let full_svg = render(
        "---\ntitle: Orders\n---\nswimlane-beta LR\n  accTitle: Order flow\n  accDescr: Who does what\n  subgraph L[Lane **one**]\n    a{Choice} --> b[(Store)]\n    b --> b\n  end\n  click a \"https://example.com\" \"tip\"\n  style a fill:#f00\n  classDef hot stroke:#0f0\n  class b hot\n  style L fill:#00f",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert_well_formed(&full_svg).unwrap();
    for needle in [
        "pele-shape-",
        ">Orders<",
        r#"<title id="pele-title">Order flow</title>"#,
        r#"href="https://example.com/""#,
        "fill:#f00",
        "fill:#00f",
    ] {
        assert!(full_svg.contains(needle));
    }
    assert_eq!(
        render("swimlane-beta LR\n  a\n  click a \"https://example.com\"", &css_options())
            .unwrap()
            .links,
        vec![LinkInfo {
            id: "a".to_string(),
            href: "https://example.com/".to_string(),
            internal: false,
        }]
    );

    // Contrasting lane title color on filled lanes.
    let contrast_svg = render(
        "swimlane-beta LR\n  subgraph L[Light]\n    a\n  end\n  subgraph D[Dark]\n    b\n  end\n  subgraph P[Plain]\n    c\n  end\n  style L fill:#BBDEFB\n  style D fill:#1f3a5f",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(contrast_svg.contains(r#"<text class="pele-cluster-label" fill="var(--pele-fg-on-light,#1f1f1f)""#));
    assert!(
        Regex::new(r#"data-id="D">.*?<text class="pele-cluster-label" fill="var\(--pele-fg-on-dark,#fff\)""#)
            .unwrap()
            .is_match(&contrast_svg)
    );
    assert!(
        Regex::new(r#"data-id="P">.*?<text class="pele-cluster-label" fill="var\(--_m\)""#)
            .unwrap()
            .is_match(&contrast_svg)
    );

    // Inks or cases edges on a filled lane band.
    let band_src =
        "swimlane-beta TB\nsubgraph S[\"one<br/>two<br/>three<br/>four<br/>five<br/>six<br/>seven<br/>eight\"]\n  A\nend\nS --> S\nstyle S fill:black";
    let band_svg = render(band_src, &css_options()).unwrap().svg;
    assert!(
        Regex::new(r#"class="pele-edge[^"]*" data-id="[^"]+" stroke="var\(--pele-fg-on-dark,#fff\)""#)
            .unwrap()
            .is_match(&band_svg)
    );
    let unstyled_band = render(&band_src.replace("\nstyle S fill:black", ""), &css_options()).unwrap().svg;
    assert!(!Regex::new(r"pele-casings|--pele-fg-on").unwrap().is_match(&unstyled_band));

    // Reads spacing from swimlane config, then flowchart config.
    let base_src = "swimlane-beta TD\n  subgraph L\n    a --> b\n  end";
    let base_h = render(base_src, &css_options()).unwrap().height;
    let swim_h = render(&format!("---\nconfig:\n  swimlane:\n    rankSpacing: 200\n---\n{base_src}"), &css_options())
        .unwrap()
        .height;
    let flow_h = render(&format!("---\nconfig:\n  flowchart:\n    rankSpacing: 200\n---\n{base_src}"), &css_options())
        .unwrap()
        .height;
    assert!(swim_h > base_h + 100.0);
    assert!(flow_h > base_h + 100.0);

    // Responsive & determinism.
    assert!(render(ORDER, &css_options()).unwrap().svg.contains("max-width:100%;height:auto;"));
    assert!(
        !render(
            ORDER,
            &RenderOptions {
                responsive: Some(false),
                ..css_options()
            },
        )
        .unwrap()
        .svg
        .contains("max-width")
    );
    assert_eq!(render(ORDER, &css_options()).unwrap().svg, render(ORDER, &css_options()).unwrap().svg);
}

#[test]
fn swimlane_renders_full_upstream_corpus_in_css_and_resolved_resvg_modes() {
    let corpus = load_fixture("swimlane-corpus.json");
    assert_eq!(corpus.len(), 13);
    for (idx, src) in corpus.iter().enumerate() {
        let where_ctx = format!("swimlane corpus #{idx}");
        let css = render(src, &css_options()).unwrap_or_else(|e| panic!("{where_ctx} css failed: {e}"));
        assert_inert(&css.svg, &format!("{where_ctx} css"));
        assert!(!lanes_map(&css.svg).is_empty(), "{where_ctx}: expected lanes");

        let resolved = render(src, &resolved_options()).unwrap_or_else(|e| panic!("{where_ctx} resolved failed: {e}"));
        assert_inert_resolved(&resolved.svg, &format!("{where_ctx} resolved"));
        assert_resvg_parses(&resolved.svg, &format!("{where_ctx} resvg"));

        let dark = render(src, &dark_options()).unwrap_or_else(|e| panic!("{where_ctx} dark failed: {e}"));
        assert_inert_resolved(&dark.svg, &format!("{where_ctx} dark"));
        assert_resvg_parses(&dark.svg, &format!("{where_ctx} dark resvg"));
    }
}

#[test]
fn swimlane_security_hostile_payloads_and_object_keys() {
    let templates: Vec<fn(&str) -> String> = vec![
        |p| format!("swimlane-beta TD\n  subgraph L[\"{p}\"]\n    a\n  end"),
        |p| format!("swimlane-beta LR\n  subgraph L[\"{p}\"]\n    a[\"{p}\"] -- \"{p}\" --> b\n  end"),
        |p| format!("swimlane-beta TD\n  subgraph {p}\n    a\n  end"),
        |p| format!("swimlane-beta {p}\n  a --> b"),
        |p| format!("swimlane-beta TD\n  subgraph L\n    a\n  end\n  style L {p}\n  class L {p}"),
        |p| format!("swimlane-beta LR\n  subgraph L\n    a\n  end\n  click a \"{p}\" \"{p}\"\n  L:::{p}"),
        |p| format!("---\ntitle: \"{p}\"\nconfig:\n  swimlane: \"{p}\"\n---\nswimlane-beta TD\n  a"),
        |p| format!("swimlane-beta RL\n  subgraph L[\"`**{p}**`\"]\n    a\n  end\n  accTitle: {p}\n  accDescr: {p}"),
    ];
    let mut rendered = 0usize;
    for (ti, tmpl) in templates.iter().enumerate() {
        for (pi, &payload) in PAYLOADS.iter().enumerate() {
            let src = tmpl(payload);
            if let Ok(res) = render(&src, &resolved_options()) {
                let ctx = format!("swimlane template {ti} payload {pi}");
                assert_inert_resolved(&res.svg, &ctx);
                assert!(!res.svg.contains("NaN") && !res.svg.contains("Infinity"), "{ctx}");
                rendered += 1;
            }
        }
    }
    assert!(rendered > 40);

    for name in ["__proto__", "constructor", "toString", "hasOwnProperty"] {
        let src = format!("swimlane-beta TD\n  subgraph {name}\n    a --> b\n  end\n  subgraph other\n    c\n  end\n  b --> c");
        let res = render(&src, &resolved_options()).unwrap();
        assert_inert_resolved(&res.svg, name);
        assert_resvg_parses(&res.svg, name);
        assert_eq!(lanes_map(&res.svg).len(), 2);
    }
}

#[test]
fn swimlane_stress_worst_cases_stay_fast() {
    let make_lanes = |count: usize, body: &dyn Fn(usize) -> String| -> String {
        (0..count)
            .map(|k| format!("  subgraph L{k}\n{}\n  end", body(k)))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let opts = RenderOptions {
        limit: Some(usize::MAX),
        ..resolved_options()
    };

    let cases: Vec<(&str, String)> = vec![
        ("2,000 nodes in 20 lanes with 3,000 edges", {
            let mut src = format!(
                "swimlane-beta TD\n{}\n",
                make_lanes(20, &|k| (0..100).map(|i| format!("    n{k}_{i}")).collect::<Vec<_>>().join("\n"))
            );
            let mut seed = 7u64;
            let mut next = |n: u64| -> u64 {
                seed = (seed.wrapping_mul(1103515245).wrapping_add(12345)) & 0x7fffffff;
                seed % n
            };
            for _ in 0..3000 {
                src.push_str(&format!("  n{}_{} --> n{}_{}\n", next(20), next(100), next(20), next(100)));
            }
            src
        }),
        ("one long chain that changes lane at every step", {
            let mut src = format!(
                "swimlane-beta LR\n{}\n",
                make_lanes(8, &|k| (0..250).map(|i| format!("    n{}", i * 8 + k)).collect::<Vec<_>>().join("\n"))
            );
            for i in 0..1999 {
                src.push_str(&format!("  n{i} --> n{}\n", i + 1));
            }
            src
        }),
        (
            "500 lanes",
            format!("swimlane-beta TD\n{}\n", make_lanes(500, &|k| format!("    a{k} --> b{k}"))),
        ),
        ("edges that span 1,500 ranks", {
            let mut src = String::from("swimlane-beta TD\n  subgraph A\n");
            for i in 0..1500 {
                src.push_str(&format!("    a{i} --> a{}\n", i + 1));
            }
            src.push_str("  end\n  subgraph B\n    b\n  end\n");
            for i in 0..40 {
                src.push_str(&format!("  a0 --> a{}\n  b --> a{}\n", 1500 - i, 1400 - i));
            }
            src
        }),
        (
            "3,000 labelled edges between two nodes",
            format!(
                "swimlane-beta TD\n  subgraph A\n    a\n  end\n  subgraph B\n    b\n  end\n{}",
                "  a -- label --> b\n".repeat(3000)
            ),
        ),
        (
            "3,000 self-loops",
            format!("swimlane-beta TD\n  subgraph A\n    a\n  end\n{}", "  a --> a\n".repeat(3000)),
        ),
        ("groups nested 2,000 deep in a lane", {
            let mut src = String::from("swimlane-beta TD\n  subgraph L\n");
            for i in 0..2000 {
                src.push_str(&format!("subgraph g{i}\n"));
            }
            src.push_str("a --> b\n");
            src.push_str(&"end\n".repeat(2001));
            src
        }),
        (
            "1,000 edges between lanes themselves",
            format!(
                "swimlane-beta TD\n{}\n{}\n",
                make_lanes(20, &|k| format!("    a{k}")),
                (0..1000)
                    .map(|i| format!("  L{} --> L{}", i % 20, (i * 7 + 3) % 20))
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
        ),
        ("a cycle through every node", {
            let mut src = format!(
                "swimlane-beta RL\n{}\n",
                make_lanes(10, &|k| (0..100).map(|i| format!("    n{}", k * 100 + i)).collect::<Vec<_>>().join("\n"))
            );
            for i in 0..1000 {
                let j = (i * 37 + 11) % 1000;
                src.push_str(&format!("  n{i} --> n{j}\n  n{j} --> n{i}\n"));
            }
            src
        }),
    ];

    for (name, src) in cases {
        let start = Instant::now();
        if let Ok(res) = render(&src, &opts) {
            assert!(!res.svg.contains("NaN") && !res.svg.contains("Infinity"), "{name}");
        }
        assert!(start.elapsed().as_secs_f64() < 15.0, "{name} took {:?}", start.elapsed());
    }
}
