mod support;

use std::collections::HashMap;
use std::time::Instant;

use regex::Regex;
use vibevalley_pele::diagram::ParsedModel;
use vibevalley_pele::diagram::architecture::db::{ArchEdge, ArchGroup, ArchJunction, ArchLayoutHint, ArchService, ArchitectureDb};
use vibevalley_pele::diagram::architecture::parser::{AlignDirection, Side, parse_architecture};
use vibevalley_pele::{DiagramType, IconResolver, ParseOptions, RenderOptions, parse, render, supports};

use support::{Lcg, Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, css_options, dark_options, load_fixture, resolved_options};

#[derive(Debug, Clone, Copy)]
struct Box2d {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn node_boxes(svg: &str) -> HashMap<String, Box2d> {
    let size: f64 = Regex::new(r#"class="pele-node pele-service"[^>]*><rect x="[-\d.]+" width="([\d.]+)""#)
        .unwrap()
        .captures(svg)
        .map_or(48.0, |c| c[1].parse().unwrap());
    let re = Regex::new(r#"class="pele-node pele-(?:service|junction)" data-id="([^"]*)" transform="translate\(([-\d.]+),([-\d.]+)\)""#).unwrap();
    re.captures_iter(svg)
        .map(|c| {
            let cx: f64 = c[2].parse().unwrap();
            let y: f64 = c[3].parse().unwrap();
            (
                c[1].to_string(),
                Box2d {
                    x: cx - size / 2.0,
                    y,
                    w: size,
                    h: size,
                },
            )
        })
        .collect()
}

fn cluster_boxes(svg: &str) -> HashMap<String, Box2d> {
    let re = Regex::new(r#"class="pele-cluster" data-id="([^"]*)"><rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)""#).unwrap();
    re.captures_iter(svg)
        .map(|c| {
            (
                c[1].to_string(),
                Box2d {
                    x: c[2].parse().unwrap(),
                    y: c[3].parse().unwrap(),
                    w: c[4].parse().unwrap(),
                    h: c[5].parse().unwrap(),
                },
            )
        })
        .collect()
}

fn inside(a: Box2d, b: Box2d) -> bool {
    a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h
}

fn apart(a: Box2d, b: Box2d) -> bool {
    a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y
}

fn layout_boxes(body: &str) -> HashMap<String, Box2d> {
    node_boxes(&render(&format!("architecture-beta\n{body}"), &css_options()).unwrap().svg)
}

#[test]
fn architecture_renders_full_upstream_corpus_in_css_and_resolved_resvg_modes() {
    let docs = load_fixture("architecture-corpus.json");
    assert_eq!(docs.len(), 27);
    let mut rendered = 0usize;
    for (idx, src) in docs.iter().enumerate() {
        let where_ctx = format!("architecture corpus #{idx}");
        let Ok(css) = render(src, &css_options()) else {
            continue;
        };
        rendered += 1;
        assert_inert(&css.svg, &format!("{where_ctx} css"));
        assert_eq!(render(src, &css_options()).unwrap().svg, css.svg);

        let resolved = render(src, &resolved_options()).unwrap_or_else(|e| panic!("{where_ctx} resolved failed: {e}"));
        assert_inert_resolved(&resolved.svg, &format!("{where_ctx} resolved"));
        assert_resvg_parses(&resolved.svg, &format!("{where_ctx} resvg"));

        let dark = render(src, &dark_options()).unwrap_or_else(|e| panic!("{where_ctx} dark failed: {e}"));
        assert_inert_resolved(&dark.svg, &format!("{where_ctx} dark"));
        assert_resvg_parses(&dark.svg, &format!("{where_ctx} dark resvg"));
    }
    assert!(rendered >= 18, "only rendered {rendered} of {} architecture corpus items", docs.len());

    // Documentation example 0 specifics.
    let doc0 = docs
        .iter()
        .find(|s| s.contains("group api(cloud)[API]") && s.contains("service db(database)[Database]"))
        .expect("missing doc example 0 in architecture corpus");
    let res = render(doc0, &css_options()).unwrap();
    assert_eq!(res.diagram_type, DiagramType::Architecture);
    assert!(supports(doc0));
    assert_eq!(res.svg.matches(r#"class="pele-node pele-service""#).count(), 4);
    assert_eq!(res.svg.matches(r#"class="pele-cluster""#).count(), 1);
    assert_eq!(res.svg.matches(r#"class="pele-edge""#).count(), 3);
    assert!(res.svg.contains(">Database<"));
    assert!(res.svg.contains(r#"data-icon="database""#));
    assert!(res.width > 100.0 && res.height > 100.0);
}

#[test]
fn architecture_grid_placement_groups_align_edges_icons_and_config() {
    // Facing sides.
    let facing = layout_boxes("service a\nservice b\nservice c\nservice d\nservice e\na:R -- L:b\na:L -- R:c\na:T -- B:d\na:B -- T:e");
    let a = facing["a"];
    assert!(facing["b"].x > a.x && facing["b"].y == a.y);
    assert!(facing["c"].x < a.x && facing["c"].y == a.y);
    assert!(facing["d"].y < a.y && facing["d"].x == a.x);
    assert!(facing["e"].y > a.y && facing["e"].x == a.x);

    // Perpendicular sides.
    let bent = layout_boxes("service a\nservice b\nservice c\na:R -- T:b\na:T -- R:c");
    let a = bent["a"];
    assert!(bent["b"].x > a.x && bent["b"].y > a.y);
    assert!(bent["c"].x < a.x && bent["c"].y < a.y);
    let rev = layout_boxes("service a\nservice b\nb:T -- R:a");
    assert!(rev["b"].x > rev["a"].x && rev["b"].y > rev["a"].y);

    // Contested cell.
    let fan_body = format!(
        "service hub\n{}",
        (0..9).map(|i| format!("service n{i}\nhub:R -- L:n{i}")).collect::<Vec<_>>().join("\n")
    );
    let fan = layout_boxes(&fan_body);
    let hub = fan["hub"];
    let fan_list: Vec<Box2d> = fan.values().copied().collect();
    for i in 0..fan_list.len() {
        for j in (i + 1)..fan_list.len() {
            assert!(apart(fan_list[i], fan_list[j]));
        }
    }
    for i in 0..9 {
        assert!(fan[&format!("n{i}")].x > hub.x);
    }

    // Unconnected parts apart.
    let disc: Vec<Box2d> = layout_boxes("service a\nservice b\nservice c\nservice d\nservice e\njunction j\na:R -- L:b")
        .into_values()
        .collect();
    for i in 0..disc.len() {
        for j in (i + 1)..disc.len() {
            assert!(apart(disc[i], disc[j]));
        }
    }

    // Nested groups enclose exact members.
    let grp_svg = render(
        "architecture-beta\ngroup fe[Frontend]\ngroup be[Backend]\ngroup inner[Inner] in be\nservice web in fe\nservice gw in be\nservice auth in inner\nservice out\nservice mid\nweb:R -- L:mid\nmid:R -- L:gw\ngw:B -- T:auth\nauth:R -- L:out\nweb:B -- T:out",
        &css_options(),
    )
    .unwrap()
    .svg;
    let nodes = node_boxes(&grp_svg);
    let clusters = cluster_boxes(&grp_svg);
    let (fe, be, inner) = (clusters["fe"], clusters["be"], clusters["inner"]);
    assert!(inside(nodes["web"], fe));
    assert!(inside(nodes["gw"], be));
    assert!(inside(nodes["auth"], inner));
    assert!(inside(inner, be));
    assert!(apart(fe, be));
    assert!(!inside(nodes["gw"], inner));
    for id in ["out", "mid"] {
        for bx in [fe, be, inner] {
            assert!(apart(nodes[id], bx));
        }
    }

    // Align directives ahead of edges.
    let row = layout_boxes("service a\nservice b\nservice c\nservice p\na:B -- T:p\nb:B -- T:p\nc:B -- T:p\nalign row a b c");
    assert_eq!(row["a"].y, row["b"].y);
    assert_eq!(row["b"].y, row["c"].y);
    assert!(row["a"].x < row["b"].x && row["b"].x < row["c"].x);
    let col = layout_boxes("service a\nservice b\nservice c\nalign column c a b");
    assert_eq!(col["c"].x, col["a"].x);
    assert!(col["c"].y < col["a"].y && col["a"].y < col["b"].y);

    // Arrowheads.
    let marker_count = |edge: &str| {
        render(&format!("architecture-beta\nservice a\nservice b\n{edge}"), &css_options())
            .unwrap()
            .svg
            .matches(r#"class="pele-marker""#)
            .count()
    };
    assert_eq!(marker_count("a:R -- L:b"), 0);
    assert_eq!(marker_count("a:R --> L:b"), 1);
    assert_eq!(marker_count("a:R <-- L:b"), 1);
    assert_eq!(marker_count("a:R <--> L:b"), 2);

    // Orthogonal straight, bent, like-side, and looping paths.
    let path_of = |body: &str| -> String {
        let svg = render(&format!("architecture-beta\n{body}"), &css_options()).unwrap().svg;
        Regex::new(r#"class="pele-edge"[^>]*><path d="([^"]*)""#).unwrap().captures(&svg).unwrap()[1].to_string()
    };
    assert!(
        Regex::new(r"^M[-\d.]+,[-\d.]+L[-\d.]+,[-\d.]+$")
            .unwrap()
            .is_match(&path_of("service a\nservice b\na:R -- L:b"))
    );
    assert_eq!(path_of("service a\nservice b\na:R -- T:b").matches('Q').count(), 1);
    assert_eq!(path_of("service a\nservice b\na:R -- R:b").matches('Q').count(), 2);
    assert_eq!(path_of("service a\na:R -- L:a").matches('Q').count(), 4);

    // Edge labels, junctions, and titles.
    let lbl_svg = render(
        "architecture-beta\ntitle Platform\nservice a[Alpha]\nservice b[Beta]\njunction j\na:R -[calls]- L:j\nj:R --> L:b",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(lbl_svg.contains(r#"class="pele-edge-label""#));
    assert!(lbl_svg.contains(">calls<"));
    assert_eq!(lbl_svg.matches(r#"class="pele-node pele-junction""#).count(), 1);
    assert!(lbl_svg.contains(">Platform<"));
    assert!(
        render("---\ntitle: From front matter\n---\narchitecture-beta\nservice a", &css_options())
            .unwrap()
            .svg
            .contains("From front matter")
    );
    assert!(
        render("---\ntitle: From front matter\n---\narchitecture-beta\ntitle Own\nservice a", &css_options())
            .unwrap()
            .svg
            .contains(">Own<")
    );

    // Group edges start at group border.
    let gedge_svg = render(
        "architecture-beta\ngroup one\ngroup two\nservice a in one\nservice b in two\na{group}:B --> T:b{group}",
        &css_options(),
    )
    .unwrap()
    .svg;
    let gclusters = cluster_boxes(&gedge_svg);
    let cap = Regex::new(r#"class="pele-edge"[^>]*><path d="M[-\d.]+,([-\d.]+)L[-\d.]+,([-\d.]+)""#)
        .unwrap()
        .captures(&gedge_svg)
        .unwrap();
    let y0: f64 = cap[1].parse().unwrap();
    let y1: f64 = cap[2].parse().unwrap();
    assert!((y0 - (gclusters["one"].y + gclusters["one"].h)).abs() < 0.1);
    assert!((y1 - (gclusters["two"].y - 7.0)).abs() < 0.1);

    // Group edge carries on to a junction inside the group.
    let jwire_svg = render(
        "architecture-beta\ngroup one\ngroup two\njunction a in one\njunction b in two\na{group}:R --> L:b{group}",
        &css_options(),
    )
    .unwrap()
    .svg;
    let jnodes = node_boxes(&jwire_svg);
    let cap = Regex::new(r#"class="pele-edge"[^>]*><path d="M([-\d.]+),[-\d.]+L([-\d.]+),[-\d.]+""#)
        .unwrap()
        .captures(&jwire_svg)
        .unwrap();
    let x0: f64 = cap[1].parse().unwrap();
    let x1: f64 = cap[2].parse().unwrap();
    assert!((x0 - (jnodes["a"].x + 24.0)).abs() < 0.1);
    assert!((x1 - (jnodes["b"].x + 24.0)).abs() < 0.1);
    assert_eq!(jwire_svg.matches(r#"class="pele-marker""#).count(), 1);

    // Icons resolver + built-in outlines + icon text.
    let icon_src = "architecture-beta\ngroup g(cloud)[G]\nservice a(database)[A] in g\nservice b(logos:aws-lambda)[B] in g\nservice c \"S3\"[C]\nservice d";
    let plain_icon = render(icon_src, &css_options()).unwrap().svg;
    assert_eq!(plain_icon.matches(r#"class="pele-icon""#).count(), 3);
    assert!(Regex::new(r#"data-icon="database"[^>]*><path "#).unwrap().is_match(&plain_icon));
    assert!(Regex::new(r#"data-icon="logos:aws-lambda"[^>]*></svg>"#).unwrap().is_match(&plain_icon));
    assert!(plain_icon.contains(">S3<"));
    let resolver = |name: &str| (name == "logos:aws-lambda").then(|| r#"<circle r="4"/>"#.to_string());
    let resolver_ref: &IconResolver<'_> = &resolver;
    let resolved_icon = render(
        icon_src,
        &RenderOptions {
            icons: Some(resolver_ref),
            ..css_options()
        },
    )
    .unwrap()
    .svg;
    assert!(
        Regex::new(r#"data-icon="logos:aws-lambda"[^>]*><circle r="4"/></svg>"#)
            .unwrap()
            .is_match(&resolved_icon)
    );
    assert!(Regex::new(r#"data-icon="database"[^>]*><path "#).unwrap().is_match(&resolved_icon));

    // Config options: iconSize, fontSize, padding.
    let cfg_body = "architecture-beta\ngroup g[G]\nservice a[A] in g\nservice b[B] in g\na:R -- L:b";
    let plain_cfg = render(cfg_body, &css_options()).unwrap();
    let big_cfg = render(&format!("---\nconfig:\n  architecture:\n    iconSize: 96\n---\n{cfg_body}"), &css_options()).unwrap();
    assert!(big_cfg.width > plain_cfg.width);
    assert!(big_cfg.svg.contains(r#"width="96" height="96""#));
    let pad_cfg = render(&format!("---\nconfig:\n  architecture:\n    padding: 60\n---\n{cfg_body}"), &css_options()).unwrap();
    assert_eq!(pad_cfg.width, plain_cfg.width + 80.0);
    let font_cfg = render(&format!("---\nconfig:\n  architecture:\n    fontSize: 24\n---\n{cfg_body}"), &css_options()).unwrap();
    assert!(font_cfg.svg.contains("font:24px sans-serif;"));
    let neg_cfg = render(&format!("---\nconfig:\n  architecture:\n    iconSize: -5\n---\n{cfg_body}"), &css_options()).unwrap();
    assert!(!neg_cfg.svg.contains("NaN"));

    // Empty diagram and nested empty group.
    assert!(render("architecture-beta", &resolved_options()).unwrap().svg.contains("<svg"));
    let empty_grp = render("architecture-beta\ngroup g[Nothing here]\ngroup h in g", &resolved_options()).unwrap();
    assert_inert_resolved(&empty_grp.svg, "empty group");
    assert_resvg_parses(&empty_grp.svg, "empty group resvg");
    let ec = cluster_boxes(&empty_grp.svg);
    assert!(inside(ec["h"], ec["g"]));
}

#[test]
fn architecture_300_random_diagrams_stay_overlap_free_and_grouped() {
    let mut rng = Lcg::new(11);
    let sides = ["L", "R", "T", "B"];
    for round in 0..300 {
        let group_count = rng.next_usize(6);
        let node_count = 1 + rng.next_usize(14);
        let mut group_parent: Vec<i32> = Vec::with_capacity(group_count);
        let mut node_parent: Vec<i32> = Vec::with_capacity(node_count);
        let mut src = String::from("architecture-beta\n");
        for g in 0..group_count {
            let p = if g > 0 && rng.next_f64() < 0.5 { rng.next_usize(g) as i32 } else { -1 };
            group_parent.push(p);
            let title = if rng.next_f64() < 0.5 { "[Group title]" } else { "" };
            let in_p = if p >= 0 { format!(" in g{p}") } else { String::new() };
            src.push_str(&format!("group g{g}{title}{in_p}\n"));
        }
        for i in 0..node_count {
            let p = if group_count > 0 && rng.next_f64() < 0.7 {
                rng.next_usize(group_count) as i32
            } else {
                -1
            };
            node_parent.push(p);
            let in_p = if p >= 0 { format!(" in g{p}") } else { String::new() };
            if rng.next_f64() < 0.15 {
                src.push_str(&format!("junction n{i}{in_p}\n"));
            } else {
                let title = if rng.next_f64() < 0.5 { "[Name]" } else { "" };
                src.push_str(&format!("service n{i}{title}{in_p}\n"));
            }
        }
        let edge_count = rng.next_usize(node_count * 2);
        for _ in 0..edge_count {
            let a = rng.next_usize(node_count);
            let sa = sides[rng.next_usize(4)];
            let mid = if rng.next_f64() < 0.2 { "[label]-" } else { "-" };
            let arrow = if rng.next_f64() < 0.5 { ">" } else { "" };
            let sb = sides[rng.next_usize(4)];
            let b = rng.next_usize(node_count);
            src.push_str(&format!("n{a}:{sa} -{mid}{arrow} {sb}:n{b}\n"));
        }
        if node_count > 2 && rng.next_f64() < 0.3 {
            let dir = if rng.next_f64() < 0.5 { "row" } else { "column" };
            src.push_str(&format!("align {dir} n0 n1 n2\n"));
        }

        let res = render(&src, &resolved_options()).unwrap_or_else(|e| panic!("round {round} failed: {e}\n{src}"));
        let nodes = node_boxes(&res.svg);
        let clusters = cluster_boxes(&res.svg);
        assert_eq!(nodes.len(), node_count, "round {round}");
        assert_eq!(clusters.len(), group_count, "round {round}");

        let within = |mut g: i32, ancestor: usize| -> bool {
            while g >= 0 {
                if g as usize == ancestor {
                    return true;
                }
                g = group_parent[g as usize];
            }
            false
        };
        for i in 0..node_count {
            let bx = nodes[&format!("n{i}")];
            for j in (i + 1)..node_count {
                assert!(apart(bx, nodes[&format!("n{j}")]), "round {round}: n{i} overlaps n{j}");
            }
            for g in 0..group_count {
                let member = within(node_parent[i], g);
                let gb = clusters[&format!("g{g}")];
                assert!(if member { inside(bx, gb) } else { apart(bx, gb) }, "round {round}: n{i} vs g{g}");
            }
        }
        for g in 0..group_count {
            for k in 0..group_count {
                if g == k {
                    continue;
                }
                let (ga, gb) = (clusters[&format!("g{g}")], clusters[&format!("g{k}")]);
                if within(g as i32, k) {
                    assert!(inside(ga, gb), "round {round}: g{g} in g{k}");
                } else if !within(k as i32, g) {
                    assert!(apart(ga, gb), "round {round}: g{g} apart from g{k}");
                }
            }
        }
    }
}

#[test]
fn architecture_compat_parser_db_errors_quotes_unicode_and_align() {
    // Error messages matching Mermaid.
    let fails = |body: &str, needle: &str| {
        let err = render(&format!("architecture-beta\n{body}"), &css_options()).unwrap_err();
        assert!(err.message.contains(needle), "expected {needle:?}, got {:?}", err.message);
    };
    fails("service a\nservice a", "The service id [a] is already in use by another node");
    fails("group a\njunction a", "The junction id [a] is already in use by another group");
    fails(
        "service a in g",
        "The service [a]'s parent does not exist. Please make sure the parent is created before this service",
    );
    fails("group g in g", "The group [g] cannot be placed within itself");
    fails("service a\nservice b in a", "The service [b]'s parent is not a group");
    fails(
        "service a\na:R -- L:b",
        "The right-hand id [b] does not yet exist. Please create the service/group before declaring an edge to it.",
    );
    fails(
        "group g\nservice a in g\nservice b in g\na{group}:R -- L:b",
        "is modified to traverse the group boundary",
    );
    fails(
        "service a\nservice b\nalign row a b c",
        "align row references [c], which is not a service or junction",
    );
    fails("service a\nservice b\nalign column a a", "align column lists [a] more than once");
    fails("group g\nservice a\na:R -- L:g", "The right-hand id [g] is a group");

    // Header and ID rules.
    assert!(render("architecture\nservice a", &css_options()).is_err());
    assert!(render("architecture-beta\nservice Lambda", &css_options()).is_err());
    assert!(
        render("architecture-beta\nservice lambda", &css_options())
            .unwrap()
            .svg
            .contains(r#"data-id="lambda""#)
    );

    // IDs starting with title.
    let tp = parse(
        "architecture-beta\ngroup titles(cloud)[G]\nservice title-db(database)[DB] in titles\nservice title_2 in titles\ntitle-db:R -- L:title_2",
        &ParseOptions::default(),
    )
    .unwrap();
    let ParsedModel::Architecture(tdb) = tp.model else { panic!() };
    assert_eq!(tdb.title, None);
    assert_eq!(tdb.groups.keys().collect::<Vec<_>>(), vec!["titles"]);
    assert_eq!(tdb.nodes.keys().collect::<Vec<_>>(), vec!["title-db", "title_2"]);
    assert_eq!(tdb.edges.len(), 1);
    assert_eq!((tdb.edges[0].lhs_id.as_str(), tdb.edges[0].rhs_id.as_str()), ("title-db", "title_2"));

    // Model exposure.
    let mp = parse(
        "architecture-beta\ntitle T\ngroup g(cloud)[G]\nservice a(server)[A] in g\njunction j\na:R -[x]-> L:j\nalign row a j",
        &ParseOptions::default(),
    )
    .unwrap();
    let ParsedModel::Architecture(mdb) = mp.model else { panic!() };
    assert_eq!(mdb.title.as_deref(), Some("T"));
    assert_eq!(
        mdb.groups["g"],
        ArchGroup {
            id: "g".to_string(),
            icon: Some("cloud".to_string()),
            title: Some("G".to_string()),
            in_group: None,
        }
    );
    assert_eq!(mdb.nodes.keys().collect::<Vec<_>>(), vec!["a", "j"]);
    assert_eq!(
        mdb.edges,
        vec![ArchEdge {
            lhs_id: "a".to_string(),
            lhs_dir: Side::R,
            lhs_into: false,
            lhs_group: false,
            rhs_id: "j".to_string(),
            rhs_dir: Side::L,
            rhs_into: true,
            rhs_group: false,
            title: Some("x".to_string()),
        }]
    );
    assert_eq!(
        mdb.layout_hints,
        vec![ArchLayoutHint {
            direction: AlignDirection::Row,
            members: vec!["a".to_string(), "j".to_string()],
        }]
    );

    // Titles on first line, next line, accTitle/accDescr, quotes, non-ASCII.
    for src in [
        "architecture-beta title sample title",
        "  architecture-beta  title sample title  ",
        "\tarchitecture-beta\ttitle sample title\t",
        "architecture-beta\n\ttitle sample title\n",
    ] {
        let ast = parse_architecture(src, None).unwrap();
        assert_eq!(ast.title.as_deref(), Some("sample title"), "{src:?}");
    }
    let acc_ast = parse_architecture("architecture-beta\ntitle T\naccTitle: AT\naccDescr {\n  AD\n}\n", None).unwrap();
    assert_eq!(acc_ast.title.as_deref(), Some("T"));
    assert_eq!(acc_ast.acc_title.as_deref(), Some("AT"));
    assert_eq!(acc_ast.acc_descr.as_deref(), Some("AD"));

    assert_eq!(
        parse_architecture("architecture-beta\nservice db(database)[\"Database\"] in api\n", None)
            .unwrap()
            .services[0]
            .title
            .as_deref(),
        Some("Database")
    );
    assert_eq!(
        parse_architecture("architecture-beta\nservice db(database)['Database'] in api\n", None)
            .unwrap()
            .services[0]
            .title
            .as_deref(),
        Some("Database")
    );
    assert_eq!(
        parse_architecture("architecture-beta\nservice db(database)[\"John's Database\"] in api\n", None)
            .unwrap()
            .services[0]
            .title
            .as_deref(),
        Some("John's Database")
    );
    assert_eq!(
        parse_architecture("architecture-beta\nservice api(server)[\"The \\\"Main\\\" API\"] in cloud\n", None)
            .unwrap()
            .services[0]
            .title
            .as_deref(),
        Some("The \"Main\" API")
    );
    for title in [
        "采集器",
        "Hello 世界",
        "Сервер",
        "Café",
        "Structure + Src",
        "Multi-Agent",
        "A, B, C",
        "TCP/IP: v6",
    ] {
        let ast = parse_architecture(&format!("architecture-beta\nservice a(server)[{title}] in g1\n"), None).unwrap();
        assert_eq!(ast.services[0].title.as_deref(), Some(title));
    }
    assert_eq!(
        parse_architecture("architecture-beta\ngroup g1(server)[你好世界]\n", None).unwrap().groups[0]
            .title
            .as_deref(),
        Some("你好世界")
    );

    // Preserves numeric service insertion order (`a`, `20`, `10`).
    let ord = parse(
        "architecture-beta\nservice a(server)[A]\nservice 20(server)[B]\nservice 10(server)[C]",
        &ParseOptions::default(),
    )
    .unwrap();
    let ParsedModel::Architecture(odb) = ord.model else { panic!() };
    assert_eq!(odb.nodes.keys().collect::<Vec<_>>(), vec!["a", "20", "10"]);

    // Reserved align keywords rejected as exact service IDs, allowed as prefixes.
    for kw in ["align", "row", "column"] {
        assert!(parse_architecture(&format!("architecture-beta\nservice {kw}(database)[X]\n"), None).is_err());
    }
    let pref = parse(
        "architecture-beta\nservice rowspan(server)[Rowspan]\nservice columnar(server)[Columnar]\nalign row rowspan columnar",
        &ParseOptions::default(),
    )
    .unwrap();
    let ParsedModel::Architecture(pdb) = pref.model else { panic!() };
    assert_eq!(pdb.layout_hints[0].members, vec!["rowspan", "columnar"]);

    // DB-level addLayoutHint & addJunction validations.
    let mut db = ArchitectureDb::new();
    assert!(
        db.add_layout_hint(ArchLayoutHint {
            direction: AlignDirection::Row,
            members: vec![]
        })
        .is_err()
    );
    assert!(
        db.add_layout_hint(ArchLayoutHint {
            direction: AlignDirection::Column,
            members: vec!["one".to_string()]
        })
        .is_err()
    );
    db.add_group(ArchGroup {
        id: "g1".to_string(),
        icon: None,
        title: Some("Group".to_string()),
        in_group: None,
    })
    .unwrap();
    db.add_service(ArchService {
        id: "svc".to_string(),
        icon: Some("server".to_string()),
        icon_text: None,
        title: Some("Svc".to_string()),
        in_group: Some("g1".to_string()),
    })
    .unwrap();
    assert!(
        db.add_junction(ArchJunction {
            id: "svc".to_string(),
            in_group: None
        })
        .is_err()
    );
    assert!(
        db.add_junction(ArchJunction {
            id: "g1".to_string(),
            in_group: None
        })
        .is_err()
    );
    assert!(
        db.add_junction(ArchJunction {
            id: "j1".to_string(),
            in_group: Some("missing".to_string())
        })
        .is_err()
    );
    assert!(
        db.add_junction(ArchJunction {
            id: "j1".to_string(),
            in_group: Some("svc".to_string())
        })
        .is_err()
    );
    assert!(
        db.add_junction(ArchJunction {
            id: "j1".to_string(),
            in_group: Some("j1".to_string())
        })
        .is_err()
    );
    db.add_junction(ArchJunction {
        id: "mid".to_string(),
        in_group: Some("g1".to_string()),
    })
    .unwrap();
}

#[test]
fn architecture_security_hostile_payloads_extreme_settings_and_mutated_fuzz() {
    let head = "architecture-beta\n";
    type Template = Box<dyn Fn(&str) -> String>;
    let templates: Vec<Template> = vec![
        Box::new(move |p| format!("{head}service a(server)[{p}]")),
        Box::new(move |p| format!("{head}service a(server)[\"{p}\"]")),
        Box::new(move |p| format!("{head}service a(server)['{p}']")),
        Box::new(move |p| format!("{head}service a \"{p}\"[A]")),
        Box::new(move |p| format!("{head}service a '{p}'")),
        Box::new(move |p| format!("{head}service a({p})[A]")),
        Box::new(move |p| format!("{head}service {p}")),
        Box::new(move |p| format!("{head}group g(cloud)[{p}]\nservice a in g")),
        Box::new(move |p| format!("{head}group g(cloud)[\"{p}\"]\nservice a[{p}] in g")),
        Box::new(move |p| format!("{head}group g({p})[G]")),
        Box::new(move |p| format!("{head}group {p}")),
        Box::new(move |p| format!("{head}group g\nservice a in {p}")),
        Box::new(move |p| format!("{head}junction {p}")),
        Box::new(move |p| format!("{head}service a\nservice b\na:R -[{p}]-> L:b")),
        Box::new(move |p| format!("{head}service a\nservice b\na:R -[\"{p}\"]- L:b")),
        Box::new(move |p| format!("{head}service a\nservice b\na:B <-['{p}']-> T:b")),
        Box::new(move |p| format!("{head}service a\nservice b\na:{p} -- L:b")),
        Box::new(move |p| format!("{head}service a\nservice b\n{p}:R -- L:b")),
        Box::new(move |p| format!("{head}service a\nservice b\na{p}:R -- L:b{{group}}")),
        Box::new(move |p| format!("{head}service a\nservice b\nalign row a {p}")),
        Box::new(move |p| format!("{head}service a\nservice b\nalign {p} a b")),
        Box::new(move |p| format!("{head}title {p}\nservice a")),
        Box::new(move |p| format!("{head}accTitle: {p}\naccDescr: {p}\nservice a")),
        Box::new(move |p| format!("{head}accDescr {{\n {p}\n }}\nservice a")),
        Box::new(|p| format!("architecture-beta {p}\nservice a")),
        Box::new(move |p| format!("{head}%% {p}\nservice a")),
        Box::new(move |p| {
            format!(
                "---\ntitle: \"{p}\"\nconfig:\n  architecture:\n    iconSize: \"{p}\"\n    fontSize: \"{p}\"\n    padding: \"{p}\"\n---\n{head}group g[G]\nservice a[A] in g"
            )
        }),
        Box::new(move |p| {
            format!("%%{{init: {{\"architecture\": {{\"iconSize\": \"{p}\"}}, \"themeVariables\": {{\"fontFamily\": \"{p}\"}}}}}}%%\n{head}service a[A]")
        }),
        Box::new(move |p| format!("---\nconfig:\n  architecture: \"{p}\"\n---\n{head}service a[A]")),
    ];

    let mut rendered = 0usize;
    for (ti, tmpl) in templates.iter().enumerate() {
        for (pi, &payload) in PAYLOADS.iter().enumerate() {
            if let Ok(res) = render(&tmpl(payload), &resolved_options()) {
                assert_inert_resolved(&res.svg, &format!("arch tmpl {ti} payload {pi}"));
                rendered += 1;
            }
        }
    }
    assert!(rendered > 300, "only rendered {rendered}");

    // Hostile option values.
    let base = format!("{head}accTitle: t\ngroup g(cloud)[G]\nservice a(server)[A] in g\nservice b \"x\"[B]\na:R -[l]-> L:b");
    for &payload in PAYLOADS {
        let res = render(
            &base,
            &RenderOptions {
                id_prefix: Some(payload.to_string()),
                font_family: Some(payload.to_string()),
                ..resolved_options()
            },
        )
        .unwrap();
        assert_inert_resolved(&res.svg, payload);
    }

    // Extreme numeric settings.
    for value in ["0", "-1", "1e308", ".inf", ".nan", "1e-9", "99999999", "[1]", "{a: 1}", "null", "true"] {
        let src = format!(
            "---\nconfig:\n  architecture:\n    iconSize: {value}\n    fontSize: {value}\n    padding: {value}\n---\n{head}group g[G]\nservice a \"t\"[A] in g\nservice b[B]\na:R -[l]-> L:b"
        );
        let res = render(&src, &resolved_options()).unwrap();
        assert_inert_resolved(&res.svg, value);
    }

    // Mutated fuzzing (1,000 samples).
    let corpus = load_fixture("architecture-corpus.json");
    let mut frags: Vec<&str> = PAYLOADS.to_vec();
    frags.extend([
        "\"",
        "[",
        "]",
        "(",
        ")",
        "\n",
        " in ",
        "{group}",
        ":R --> L:",
        "service ",
        "group ",
        "junction ",
        "title ",
        "-[",
        "]-",
    ]);
    let mut mutator = Mutator::new(&corpus, frags, 3);
    for i in 0..1000 {
        let src = mutator.next_sample();
        if src.len() <= 4000
            && let Ok(res) = render(&src, &resolved_options())
        {
            assert_inert_resolved(&res.svg, &format!("arch fuzz #{i}"));
        }
    }

    // Object-key IDs.
    let proto_src = format!(
        "{head}group __proto__(cloud)[P]\ngroup constructor[C] in __proto__\nservice toString(server)[A] in __proto__\nservice hasOwnProperty[B] in constructor\njunction valueOf\ntoString:R -- L:hasOwnProperty\nhasOwnProperty:B -- T:valueOf\nalign row toString hasOwnProperty"
    );
    let proto = render(&proto_src, &resolved_options()).unwrap();
    assert_inert_resolved(&proto.svg, "arch proto");
    assert_resvg_parses(&proto.svg, "arch proto resvg");
    assert_eq!(proto.svg.matches(r#"class="pele-cluster""#).count(), 2);
    assert_eq!(proto.svg.matches(r#"class="pele-node "#).count(), 3);
    assert!(proto.svg.contains(r#"data-id="__proto__""#));
}

#[test]
fn architecture_stress_worst_cases_stay_fast() {
    let n = 50_000usize;
    let head = "architecture-beta\n";
    let big = RenderOptions {
        limit: Some(usize::MAX),
        ..resolved_options()
    };
    let services = |count: usize| -> String { (0..count).map(|i| format!("service n{i}\n")).collect() };
    let diag_group = |g: usize, side: &str| -> String {
        let mut s = format!("group g{g}\n");
        for i in 0..12 {
            s.push_str(&format!("service m{g}x{i} in g{g}\n"));
        }
        for i in 0..11 {
            s.push_str(&format!("m{g}x{i}:{side}:m{g}x{}\n", i + 1));
        }
        s
    };

    let valid: Vec<(&str, String)> = vec![
        ("4,500 unconnected services", format!("{head}{}", services(4500))),
        (
            "chain of 2,000",
            format!(
                "{head}{}{}",
                services(2000),
                (0..1999).map(|i| format!("n{i}:R -- L:n{}\n", i + 1)).collect::<String>()
            ),
        ),
        (
            "diagonal of 2,000",
            format!(
                "{head}{}{}",
                services(2000),
                (0..1999).map(|i| format!("n{i}:R -- T:n{}\n", i + 1)).collect::<String>()
            ),
        ),
        (
            "star of 2,000 facing",
            format!(
                "{head}{}{}",
                services(2000),
                (0..1999).map(|i| format!("n0:R -- L:n{}\n", i + 1)).collect::<String>()
            ),
        ),
        (
            "star of 2,000 bends",
            format!(
                "{head}{}{}",
                services(2000),
                (0..1999).map(|i| format!("n0:B -- L:n{}\n", i + 1)).collect::<String>()
            ),
        ),
        (
            "star of 2,000 like sides",
            format!(
                "{head}{}{}",
                services(2000),
                (0..1999).map(|i| format!("n0:R -- R:n{}\n", i + 1)).collect::<String>()
            ),
        ),
        (
            "column of hubs",
            format!(
                "{head}{}{}",
                services(1800),
                (0..599)
                    .map(|i| format!(
                        "n{}:B -- T:n{}\nn{}:R -- L:n{}\nn{}:R -- L:n{}\n",
                        i * 3,
                        i * 3 + 3,
                        i * 3,
                        i * 3 + 1,
                        i * 3,
                        i * 3 + 2
                    ))
                    .collect::<String>()
            ),
        ),
        (
            "3,000 edges between two",
            format!("{head}service a\nservice b\n{}", "a:R <-[x]-> L:b\n".repeat(3000)),
        ),
        ("2,500 self edges", format!("{head}service a\n{}", "a:R --> L:a\n".repeat(2500))),
        ("complete graph of 70", {
            let mut s = format!("{head}{}", services(70));
            for i in 0..70 {
                for j in (i + 1)..70 {
                    s.push_str(&format!("n{i}:R -- L:n{j}\n"));
                }
            }
            s
        }),
        (
            "2,000 nested groups",
            format!(
                "{head}group g0\n{}service a in g1999\n",
                (0..1999).map(|i| format!("group g{} in g{i}\n", i + 1)).collect::<String>()
            ),
        ),
        (
            "1,000 nested groups with edges",
            format!(
                "{head}group g0[T]\n{}service a in g999\nservice b\n{}",
                (0..999).map(|i| format!("group g{}[T] in g{i}\n", i + 1)).collect::<String>(),
                "a:R -- L:b\n".repeat(500)
            ),
        ),
        (
            "1,200 sibling groups",
            format!(
                "{head}{}{}",
                (0..1200).map(|i| format!("group g{i}\nservice n{i} in g{i}\n")).collect::<String>(),
                (0..1199).map(|i| format!("n{i}:R -- L:n{}\n", i + 1)).collect::<String>()
            ),
        ),
        (
            "1,000 groups wanting same place",
            format!(
                "{head}service hub\n{}",
                (0..1000)
                    .map(|i| format!("group g{i}\nservice n{i} in g{i}\nhub:R -- L:n{i}\n"))
                    .collect::<String>()
            ),
        ),
        (
            "large groups wanting same place",
            format!(
                "{head}service hub\n{}",
                (0..40).map(|g| format!("{}hub:R -- L:m{g}x0\n", diag_group(g, "R -- T"))).collect::<String>()
            ),
        ),
        (
            "large groups beside column of 1,500",
            format!(
                "{head}{}{}{}",
                services(1500),
                (0..1499).map(|i| format!("n{i}:B -- T:n{}\n", i + 1)).collect::<String>(),
                (0..20).map(|g| format!("{}n0:R -- L:m{g}x0\n", diag_group(g, "B -- R"))).collect::<String>()
            ),
        ),
        (
            "titled groups over long rows",
            format!(
                "{head}group g0[A title]\n{}{}{}",
                (0..300).map(|i| format!("group g{}[A title] in g{i}\n", i + 1)).collect::<String>(),
                (0..1500).map(|i| format!("service n{i} in g{}\n", i % 301)).collect::<String>(),
                (0..1499).map(|i| format!("n{i}:R -- L:n{}\n", i + 1)).collect::<String>()
            ),
        ),
        (
            "many groups crossed by vertical edges",
            format!(
                "{head}{}{}{}",
                (0..600).map(|i| format!("group g{i}[Title]\nservice n{i} in g{i}\n")).collect::<String>(),
                (0..599).map(|i| format!("n{i}:B --> T:n{}\n", i + 1)).collect::<String>(),
                "n0:B -- T:n599\n".repeat(800)
            ),
        ),
        (
            "align over 2,000 members",
            format!(
                "{head}{}align row {}\n{}",
                services(2000),
                (0..1000).map(|i| format!("n{i} ")).collect::<String>(),
                (0..1000).map(|i| format!("align column n{i} n{}\n", i + 1000)).collect::<String>()
            ),
        ),
        ("50k service title", format!("{head}service a[{}]", "word ".repeat(n / 5))),
        ("50k unbroken title", format!("{head}service a[{}]", "w".repeat(n))),
        ("50k icon text", format!("{head}service a \"{}\"", "word ".repeat(n / 5))),
        ("50k unbroken emoji icon text", format!("{head}service a \"{}\"", "😀".repeat(n / 2))),
        (
            "25k group title & edge label",
            format!(
                "{head}group g[{}]\nservice a in g\nservice b\na:R -[{}]- L:b",
                "word ".repeat(n / 10),
                "*a _b ".repeat(n / 12)
            ),
        ),
        ("entities and br title", format!("{head}service a[\"{}\"]", "#35;&amp;<br>".repeat(n / 13))),
        (
            "unclosed double-quoted titles",
            format!("{head}{}", (0..n / 20).map(|i| format!("service n{i}[\"a]\n")).collect::<String>()),
        ),
        (
            "unclosed single-quoted titles",
            format!("{head}{}", (0..n / 20).map(|i| format!("service n{i}['a]\n")).collect::<String>()),
        ),
        (
            "escaped quotes in titles",
            format!(
                "{head}service a[\"x]\n{}",
                (0..n / 20).map(|i| format!("service n{i}[\\\"\\']\n")).collect::<String>()
            ),
        ),
        ("title keyword every line", format!("{head}{}", "title a %% b\n".repeat(n / 13))),
        ("50k spaces", format!("{head}{}service a", " ".repeat(n))),
        ("50k identifier", format!("{head}service {}a", "a-".repeat(n / 2))),
        (
            "keywords glued to ids",
            format!(
                "{head}{}service in-in-in\n",
                (0..n / 20).map(|i| format!("service service{i}\n")).collect::<String>()
            ),
        ),
        (
            "50k line breaks around header",
            format!("{}{head}{}service a", "\n".repeat(3000), "\n".repeat(n)),
        ),
    ];
    for (name, src) in valid {
        let t0 = Instant::now();
        let res = render(&src, &big).unwrap_or_else(|e| panic!("valid stress {name} failed: {e}"));
        assert!(res.svg.contains("</svg>"), "{name}");
        assert!(t0.elapsed().as_secs_f64() < 15.0, "{name} took {:?}", t0.elapsed());
    }

    let any: Vec<(&str, String)> = vec![
        ("unclosed brackets", format!("{head}service a{}", "[".repeat(n))),
        ("unclosed parens", format!("{head}service a({}", "a:-".repeat(n / 3))),
        ("unclosed string", format!("{head}service a \"{}", "a\\\"".repeat(n / 3))),
        (
            "strings never end",
            format!("{head}{}", (0..n / 14).map(|i| format!("service n{i} \"a\n")).collect::<String>()),
        ),
        ("runs of dashes", format!("{head}service a\nservice b\na:R {} L:b", "-".repeat(n))),
        ("fence openers no closer", format!("{head}service a\nservice b\n{}", "a:R ---\n".repeat(n / 8))),
        ("unclosed directives", format!("{head}{}", "%%{\n".repeat(n / 4))),
        (
            "unclosed accDescr",
            format!("{head}{}accDescr {{{}", "accDescr\n".repeat(n / 12), " a\n".repeat(1000)),
        ),
        ("direction letters", format!("{head}{}", "L".repeat(n))),
        (
            "fences never close",
            format!("{head}{}", (0..n / 20).map(|i| format!("service n{i} ---\n")).collect::<String>()),
        ),
        (
            "accDescr before closed brace",
            format!("{head}{}accDescr {{ a }}\n", "accDescr\n".repeat(n / 12)),
        ),
        ("arrows", format!("{head}service a\nservice b\na:R {}", "<>".repeat(n / 2))),
        ("group modifiers", format!("{head}service a\na{}", "{group}".repeat(n / 7))),
    ];
    for (name, src) in any {
        let t0 = Instant::now();
        let _ = render(&src, &big);
        assert!(t0.elapsed().as_secs_f64() < 15.0, "{name} took {:?}", t0.elapsed());
    }

    // Default source limit.
    let err = render(&format!("{head}{}", services(6000)), &css_options()).unwrap_err();
    assert!(err.message.contains("limit of 50000"));
}
