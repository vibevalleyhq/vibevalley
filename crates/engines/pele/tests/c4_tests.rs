mod support;

use std::collections::{BTreeSet, HashMap};
use std::time::Instant;

use regex::Regex;
use roxmltree::Document;
use vibevalley_pele::detect::DiagramType;
use vibevalley_pele::diagram::c4::lexer::tokenize;
use vibevalley_pele::diagram::c4::types::C4RelKind;
use vibevalley_pele::{ErrorCode, LinkInfo, ParseOptions, ParsedModel, RenderOptions, parse, render, render_model, supports};

use support::{Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, css_options, dark_options, load_fixture, resolved_options};

#[derive(Debug, Clone, Copy)]
struct BoxRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn count_sub(svg: &str, needle: &str) -> usize {
    svg.matches(needle).count()
}

fn c4_model(src: &str) -> vibevalley_pele::diagram::c4::C4Db {
    match parse(src, &ParseOptions::default()).unwrap().model {
        ParsedModel::C4(db) => db,
        other => panic!("expected c4, got {:?}", other.diagram_type()),
    }
}

fn box_of(svg: &str, id: &str) -> BoxRect {
    let re_node = Regex::new(&format!(
        r#"data-id="{}" transform="translate\(([-\d.]+),([-\d.]+)\)"><(?:a [^>]*><)?rect x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)""#,
        regex::escape(id)
    ))
    .unwrap();
    if let Some(c) = re_node.captures(svg) {
        return BoxRect {
            x: c[1].parse::<f64>().unwrap() + c[3].parse::<f64>().unwrap(),
            y: c[2].parse::<f64>().unwrap() + c[4].parse::<f64>().unwrap(),
            w: c[5].parse().unwrap(),
            h: c[6].parse().unwrap(),
        };
    }
    let re_group = Regex::new(&format!(
        r#"data-id="{}"><rect x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)""#,
        regex::escape(id)
    ))
    .unwrap();
    let c = re_group.captures(svg).unwrap_or_else(|| panic!("no box for {id}"));
    BoxRect {
        x: c[1].parse().unwrap(),
        y: c[2].parse().unwrap(),
        w: c[3].parse().unwrap(),
        h: c[4].parse().unwrap(),
    }
}

fn label_x(svg: &str, id: &str) -> f64 {
    let re = Regex::new(&format!(
        r#"class="pele-edge-label" data-id="{}">(?:<title>[^<]*</title>)?<rect x="([-\d.]+)""#,
        regex::escape(id)
    ))
    .unwrap();
    re.captures(svg).unwrap()[1].parse().unwrap()
}

fn label_y(svg: &str, id: &str) -> f64 {
    let re = Regex::new(&format!(
        r#"class="pele-edge-label" data-id="{}">(?:<title>[^<]*</title>)?<rect x="[-\d.]+" y="([-\d.]+)""#,
        regex::escape(id)
    ))
    .unwrap();
    re.captures(svg).unwrap()[1].parse().unwrap()
}

fn corners(svg: &str) -> Vec<(String, Vec<f64>)> {
    let re_edge = Regex::new(r#"class="pele-edge" data-id="([^"]+)"[^>]*><path d="([^"]+)""#).unwrap();
    let re_op = Regex::new(r"([MLHVQ])([^MLHVQ]+)").unwrap();
    let mut out = Vec::new();
    for cap in re_edge.captures_iter(svg) {
        let id = cap[1].to_string();
        let d = &cap[2];
        if d.contains('C') {
            continue;
        }
        let mut points: Vec<f64> = Vec::new();
        for op_cap in re_op.captures_iter(d) {
            let op = &op_cap[1];
            let nums: Vec<f64> = op_cap[2]
                .trim()
                .split(|c: char| c.is_ascii_whitespace() || c == ',')
                .filter(|s| !s.is_empty())
                .map(|s| s.parse().unwrap())
                .collect();
            let (x, y) = if points.len() >= 2 {
                (points[points.len() - 2], points[points.len() - 1])
            } else {
                (0.0, 0.0)
            };
            match op {
                "H" => points.extend_from_slice(&[nums[0], y]),
                "V" => points.extend_from_slice(&[x, nums[0]]),
                "Q" => points.extend_from_slice(&[nums[0], nums[1]]),
                _ => points.extend_from_slice(&[nums[nums.len() - 2], nums[nums.len() - 1]]),
            }
        }
        out.push((id, points));
    }
    out
}

fn check_both_modes(src: &str, extra_css: &RenderOptions<'_>, extra_res: &RenderOptions<'_>) -> bool {
    let css = match render(src, extra_css) {
        Ok(r) => r.svg,
        Err(_) => return false,
    };
    let ctx: String = src.chars().take(160).collect();
    assert_inert(&css, &ctx);
    assert!(!css.contains("NaN") && !css.contains("Infinity"), "non-finite coord in {ctx}");

    let resolved = render(src, extra_res).expect("resolved render should succeed when css succeeded");
    assert_inert_resolved(&resolved.svg, &ctx);
    assert_resvg_parses(&resolved.svg, &ctx);
    true
}

#[test]
fn c4_shapes_boundaries_relations_layout_and_kinds() {
    let basic = r#"C4Context
title System Context
Person(user, "User", "Uses the bank")
Enterprise_Boundary(bank, "Bank") {
  System(app, "Banking", "Moves money")
  SystemDb_Ext(ledger, "Ledger")
}
Rel(user, app, "Uses", "HTTPS")
BiRel(app, ledger, "Syncs")"#;
    let res = render(basic, &css_options()).unwrap();
    assert_eq!(res.diagram_type, DiagramType::C4);
    assert!(supports("C4Context\nPerson(a, \"A\")"));
    assert!(res.svg.contains(r#"class="pele pele-c4""#));
    assert_eq!(count_sub(&res.svg, r#"class="pele-node "#), 3);
    assert_eq!(count_sub(&res.svg, r#"class="pele-cluster "#), 1);
    assert_eq!(count_sub(&res.svg, r#"class="pele-edge""#), 2);
    assert_eq!(count_sub(&res.svg, r#"class="pele-edge-label""#), 2);
    assert_eq!(count_sub(&res.svg, r#"class="pele-marker""#), 3);
    assert!(res.svg.contains(">System Context<"));
    assert!(res.svg.contains("«person»"));
    assert!(res.svg.contains("«external system db»"));
    assert!(res.svg.contains(">[HTTPS]<"));
    assert!(res.svg.contains(">[ENTERPRISE]<"));
    assert_inert(&res.svg, "basic c4");

    // Light + dark resolved + resvg
    let light = render(basic, &resolved_options()).unwrap();
    assert_inert_resolved(&light.svg, "c4 light");
    assert_resvg_parses(&light.svg, "c4 light");
    let dark = render(basic, &dark_options()).unwrap();
    assert_inert_resolved(&dark.svg, "c4 dark");
    assert_resvg_parses(&dark.svg, "c4 dark");

    // All five diagram keywords
    for kw in ["C4Context", "C4Container", "C4Component", "C4Dynamic", "C4Deployment"] {
        let s = format!("{kw}\nPerson(a, \"A\")");
        assert_eq!(c4_model(&s).c4_type.as_deref(), Some(kw));
        assert!(render(&s, &css_options()).unwrap().svg.contains(r#"data-id="a""#));
    }

    // Element shapes + external dashed hollow vs filled
    let kinds_svg = render(
        "C4Container\nPerson(p, \"P\")\nPerson_Ext(pe, \"PE\")\nSystem(s, \"S\")\nSystemDb(sd, \"SD\")\nSystemQueue(sq, \"SQ\")\nContainer_Ext(ce, \"CE\", \"Go\")\nContainerDb_Ext(cde, \"CDE\")\nComponentQueue_Ext(cqe, \"CQE\")",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(
        Regex::new(r#"pele-shape-person pele-c4-person" data-id="p"[^>]*><rect[^>]*><circle"#)
            .unwrap()
            .is_match(&kinds_svg)
    );
    assert!(kinds_svg.contains(r#"pele-shape-person pele-c4-external_person pele-c4-external" data-id="pe""#));
    assert!(kinds_svg.contains(r#"pele-shape-rect pele-c4-system" data-id="s""#));
    assert!(kinds_svg.contains(r#"pele-shape-cyl pele-c4-system_db" data-id="sd""#));
    assert!(kinds_svg.contains(r#"pele-shape-h-cyl pele-c4-system_queue" data-id="sq""#));
    assert!(kinds_svg.contains(r#"pele-shape-cyl pele-c4-external_container_db pele-c4-external" data-id="cde""#));
    assert!(kinds_svg.contains(r#"pele-shape-h-cyl pele-c4-external_component_queue pele-c4-external" data-id="cqe""#));
    assert!(
        Regex::new(r#"data-id="ce"[^>]*><rect[^>]*fill="var\(--_bg\)" stroke="var\(--_b\)" stroke-dasharray="4 3""#)
            .unwrap()
            .is_match(&kinds_svg)
    );
    assert!(
        Regex::new(r#"data-id="s"[^>]*><rect[^>]*fill="var\(--_s\)" stroke="var\(--_b\)" style="rx:var\(--_r\)"\/>"#)
            .unwrap()
            .is_match(&kinds_svg)
    );

    // $shape, $sprite, $tags shape selection
    let tagged = render(
        "C4Context\nSystem(a, \"A\", $tags=\"v1, cylinder\")\nSystem(b, \"B\", $sprite=\"queue\")\nSystem(c, \"C\")\nUpdateElementStyle(c, $shape=\"Person\")\nSystem(d, \"D\", $tags=\"constructor\")",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(tagged.contains(r#"pele-shape-cyl pele-c4-system" data-id="a""#));
    assert!(tagged.contains(r#"pele-shape-h-cyl pele-c4-system" data-id="b""#));
    assert!(tagged.contains(r#"pele-shape-person pele-c4-system" data-id="c""#));
    assert!(tagged.contains(r#"pele-shape-rect pele-c4-system" data-id="d""#));

    // Rich inline HTML in description
    let rich = render(
        "C4Container\nContainer(api, \"API\", \"Node.js\", \"Serves <b>requests</b><br/>all day\")",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(rich.contains("«container»"));
    assert!(
        Regex::new(r#"class="pele-label" font-weight="var\(--_hw\)"[^>]*>(<tspan[^>]*>)?API<"#)
            .unwrap()
            .is_match(&rich)
    );
    assert!(rich.contains(">[Node.js]<"));
    assert!(rich.contains(r#"font-weight="var(--_w)">requests</tspan>"#));
    assert!(rich.contains("all day"));
    assert!(!rich.contains("&lt;br"));

    // Wrapping & widening
    let wrapped = render(&format!("C4Context\nSystem(a, \"A\", \"{}\")", "word ".repeat(40)), &css_options()).unwrap();
    assert_eq!(box_of(&wrapped.svg, "a").w, 216.0);
    assert!(box_of(&wrapped.svg, "a").h > 150.0);
    let wide = render(&format!("C4Context\nSystem(a, \"{}\")", "W".repeat(40)), &css_options()).unwrap();
    assert!(box_of(&wide.svg, "a").w > 400.0);

    // Rows of 4 shapes and 2 boundaries by default
    let mut grid_src = String::from("C4Context\n");
    for i in 1..=5 {
        grid_src.push_str(&format!("System(s{i}, \"S{i}\")\n"));
    }
    for i in 1..=3 {
        grid_src.push_str(&format!("Boundary(b{i}, \"B{i}\") {{\n System(i{i}, \"I{i}\")\n}}\n"));
    }
    let grid = render(&grid_src, &css_options()).unwrap().svg;
    let s: Vec<BoxRect> = (1..=5).map(|i| box_of(&grid, &format!("s{i}"))).collect();
    assert_eq!(s[0].y, s[1].y);
    assert_eq!(s[1].y, s[2].y);
    assert_eq!(s[2].y, s[3].y);
    assert!(s[1].x > s[0].x + s[0].w);
    assert_eq!(s[4].x, s[0].x);
    assert!(s[4].y > s[0].y + s[0].h);
    let b: Vec<BoxRect> = (1..=3).map(|i| box_of(&grid, &format!("b{i}"))).collect();
    assert!(b[0].y > s[4].y + s[4].h);
    assert_eq!(b[1].y, b[0].y);
    assert!(b[1].x > b[0].x + b[0].w);
    assert_eq!(b[2].x, b[0].x);
    assert!(b[2].y > b[0].y + b[0].h);

    // UpdateLayoutConfig
    let lay_src = |cfg: &str| {
        format!(
            "C4Context\nSystem(a, \"A\")\nSystem(b, \"B\")\nSystem(c, \"C\")\nBoundary(x, \"X\") {{\n System(d, \"D\")\n}}\nBoundary(y, \"Y\") {{\n System(e, \"E\")\n}}\n{cfg}"
        )
    };
    let stacked = render(&lay_src("UpdateLayoutConfig($c4ShapeInRow=\"1\", $c4BoundaryInRow=\"1\")"), &css_options())
        .unwrap()
        .svg;
    assert_eq!(box_of(&stacked, "b").x, box_of(&stacked, "a").x);
    assert!(box_of(&stacked, "b").y > box_of(&stacked, "a").y);
    assert_eq!(box_of(&stacked, "y").x, box_of(&stacked, "x").x);
    let pos = render(&lay_src("UpdateLayoutConfig(\"2\", \"2\")"), &css_options()).unwrap().svg;
    assert_eq!(box_of(&pos, "b").y, box_of(&pos, "a").y);
    assert!(box_of(&pos, "c").y > box_of(&pos, "a").y);
    assert_eq!(box_of(&pos, "y").y, box_of(&pos, "x").y);
    assert_eq!(c4_model(&lay_src("UpdateLayoutConfig(\"0\", \"-3\")")).shape_in_row, 4);
    assert_eq!(c4_model(&lay_src("UpdateLayoutConfig($c4BoundaryInRow=\"3\")")).shape_in_row, 3);
    assert_eq!(c4_model(&lay_src("UpdateLayoutConfig($c4BoundaryInRow=\"3\")")).boundary_in_row, 2);

    // Nested deployment boundaries + solid vs dashed border + boundary type labels
    let dep = render(
        "C4Deployment\nDeployment_Node(outer, \"Outer\", \"Linux\", \"A machine\") {\n  Node(inner, \"Inner\") {\n    Container(app, \"App\")\n  }\n  Node_L(left, \"Left\") {\n    Container(other, \"Other\")\n  }\n}",
        &css_options(),
    )
    .unwrap()
    .svg;
    let outer = box_of(&dep, "outer");
    let inner = box_of(&dep, "inner");
    let app = box_of(&dep, "app");
    let left = box_of(&dep, "left");
    let inside = |a: BoxRect, b: BoxRect| a.x > b.x && a.y > b.y && a.x + a.w < b.x + b.w && a.y + a.h < b.y + b.h;
    assert!(inside(inner, outer));
    assert!(inside(app, inner));
    assert!(inside(left, outer));
    assert!(dep.contains(">[Linux]<"));
    assert!(dep.contains(">A machine<"));
    assert!(dep.contains(">[node]<"));
    assert!(
        Regex::new(r#"class="pele-cluster pele-c4-node" data-id="outer"><rect[^>]*stroke="var\(--_b\)" style="rx:var\(--_r\)"\/>"#)
            .unwrap()
            .is_match(&dep)
    );
    let b_dash = render("C4Context\nBoundary(b, \"B\") {\nSystem(s, \"S\")\n}", &css_options()).unwrap().svg;
    assert!(
        Regex::new(r#"class="pele-cluster pele-c4-boundary" data-id="b"><rect[^>]*stroke-dasharray="6 4" style="rx:var\(--_r\)"\/>"#)
            .unwrap()
            .is_match(&b_dash)
    );

    let btypes = render(
        "C4Container\nEnterprise_Boundary(e, \"E\") {\n  System_Boundary(s, \"S\") {\n    Container_Boundary(c, \"C\") {\n      Boundary(b, \"B\") {\n        Boundary(t, \"T\", \"custom\") {\n          System(x, \"X\")\n        }\n      }\n    }\n  }\n}",
        &css_options(),
    )
    .unwrap()
    .svg;
    for t in ["ENTERPRISE", "SYSTEM", "CONTAINER", "system", "custom"] {
        assert!(btypes.contains(&format!(">[{t}]<")));
    }
}

#[test]
fn c4_routing_geometry_detours_docs_compact_and_styles() {
    // Arrowheads + Rel_Back + RelIndex + Dynamic numbering
    for name in ["Rel", "Rel_U", "Rel_Up", "Rel_D", "Rel_Down", "Rel_L", "Rel_Left", "Rel_R", "Rel_Right"] {
        let s = format!("C4Context\nSystem(a, \"A\")\nSystem(b, \"B\")\n{name}(a, b, \"x\")");
        assert_eq!(count_sub(&render(&s, &css_options()).unwrap().svg, "pele-marker"), 1);
    }
    assert_eq!(
        count_sub(
            &render("C4Context\nSystem(a, \"A\")\nSystem(b, \"B\")\nBiRel(a, b, \"x\")", &css_options())
                .unwrap()
                .svg,
            "pele-marker"
        ),
        2
    );
    let forward = render("C4Context\nSystem(a, \"A\")\nSystem(b, \"B\")\nRel(a, b, \"x\")", &css_options())
        .unwrap()
        .svg;
    let back = render("C4Context\nSystem(a, \"A\")\nSystem(b, \"B\")\nRel_Back(a, b, \"x\")", &css_options())
        .unwrap()
        .svg;
    let tip = |svg: &str| -> f64 {
        Regex::new(r#"class="pele-marker" d="M([\d.]+),"#).unwrap().captures(svg).unwrap()[1]
            .parse()
            .unwrap()
    };
    assert_eq!(tip(&forward), box_of(&forward, "b").x);
    assert_eq!(tip(&back), box_of(&back, "a").x + box_of(&back, "a").w);

    let m_dyn = c4_model("C4Dynamic\nSystem(a, \"A\")\nSystem(b, \"B\")\nRelIndex(7, a, b, \"x\")\nRel(b, \"a\")");
    assert_eq!(m_dyn.rels.len(), 1);
    assert_eq!(m_dyn.rels[0].rel_type, C4RelKind::Rel);
    assert_eq!(m_dyn.rels[0].from, "a");
    assert_eq!(m_dyn.rels[0].to, "b");
    assert_eq!(m_dyn.rels[0].label, "x");

    let dyn_src = "System(a, \"A\")\nSystem(b, \"B\")\nSystem(c, \"C\")\nRel(a, b, \"first\")\nRel(b, c, \"second\")";
    let dyn_svg = render(&format!("C4Dynamic\n{dyn_src}"), &css_options()).unwrap().svg;
    assert!(dyn_svg.contains(">1: first<") && dyn_svg.contains(">2: second<"));
    assert!(render(&format!("C4Context\n{dyn_src}"), &css_options()).unwrap().svg.contains(">first<"));

    // Straight neighbor line + label fits in gap
    let a = box_of(&forward, "a");
    let b = box_of(&forward, "b");
    let re_line = Regex::new(r#"class="pele-edge" data-id="a-b"><path d="M([\d.]+),([\d.]+)L([\d.]+),([\d.]+)""#).unwrap();
    let d = re_line.captures(&forward).unwrap();
    assert_eq!(d[1].parse::<f64>().unwrap(), a.x + a.w);
    assert_eq!(d[2].parse::<f64>().unwrap(), a.y + a.h / 2.0);
    assert!((d[3].parse::<f64>().unwrap() - (b.x - 7.0)).abs() < 1e-4);
    assert_eq!(d[4].parse::<f64>().unwrap(), d[2].parse::<f64>().unwrap());

    for args in [
        "\"Sends a fairly long description of the relationship\"",
        "\"Makes API calls to\", \"JSON/HTTPS\"",
    ] {
        let svg = render(&format!("C4Context\nSystem(a, \"A\")\nSystem(b, \"B\")\nRel(a, b, {args})"), &css_options())
            .unwrap()
            .svg;
        let ba = box_of(&svg, "a");
        let bb = box_of(&svg, "b");
        let lbl = box_of(&svg, "a-b");
        assert_eq!(bb.y, ba.y);
        assert!(lbl.x >= ba.x + ba.w);
        assert!(lbl.x + lbl.w <= bb.x);
    }

    // Person / cylinder / queue outline endpoints
    let shapes_svg = render(
        "C4Context\nUpdateLayoutConfig(\"1\", \"1\")\nPerson(p, \"P\")\nSystemDb(d, \"D\")\nSystemQueue(q, \"Q\")\nRel(p, d, \"x\")\nRel(d, q, \"y\")",
        &css_options(),
    )
    .unwrap()
    .svg;
    let bp = box_of(&shapes_svg, "p");
    let pd = Regex::new(r#"data-id="p-d"><path d="M([\d.]+),([\d.]+)L([\d.]+),([\d.]+)""#)
        .unwrap()
        .captures(&shapes_svg)
        .unwrap();
    assert_eq!(pd[2].parse::<f64>().unwrap(), bp.y + bp.h);
    let lid = Regex::new(r#"data-id="d" transform="translate\([\d.]+,([\d.]+)\)"><path d="M[-\d.]+,([-\d.]+)A[\d.]+,([\d.]+) "#)
        .unwrap()
        .captures(&shapes_svg)
        .unwrap();
    let top = lid[1].parse::<f64>().unwrap() + lid[2].parse::<f64>().unwrap() - lid[3].parse::<f64>().unwrap();
    assert!((pd[4].parse::<f64>().unwrap() - (top - 7.0)).abs() < 1e-4);
    let dq = Regex::new(r#"data-id="d-q"><path d="M([\d.]+),([\d.]+)L([\d.]+),([\d.]+)""#)
        .unwrap()
        .captures(&shapes_svg)
        .unwrap();
    assert_eq!(dq[1].parse::<f64>().unwrap(), dq[3].parse::<f64>().unwrap());
    assert!(dq[4].parse::<f64>().unwrap() > dq[2].parse::<f64>().unwrap() + 50.0);

    // Detours around intervening shapes in row or column
    let row = render(
        "C4Context\nSystem(a, \"A\")\nSystem(b, \"B\")\nSystem(c, \"C\")\nRel(a, c, \"over\")\nRel(c, a, \"under\")",
        &css_options(),
    )
    .unwrap()
    .svg;
    let ra = box_of(&row, "a");
    let over = Regex::new(r#"data-id="a-c"><path d="M[\d.]+,([-\d.]+)V([-\d.]+)Q"#)
        .unwrap()
        .captures(&row)
        .unwrap();
    assert_eq!(over[1].parse::<f64>().unwrap(), ra.y);
    assert!(over[2].parse::<f64>().unwrap() < ra.y);
    let under = Regex::new(r#"data-id="c-a"><path d="M[\d.]+,([-\d.]+)V([-\d.]+)Q"#)
        .unwrap()
        .captures(&row)
        .unwrap();
    assert!(under[2].parse::<f64>().unwrap() > ra.y + ra.h);
    let col = render(
        "C4Context\nUpdateLayoutConfig(\"1\", \"1\")\nSystem(a, \"A\")\nSystem(b, \"B\")\nSystem(c, \"C\")\nRel(a, c, \"x\")",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(Regex::new(r#"data-id="a-c"><path d="M[\d.]+,[\d.]+H[\d.]+Q"#).unwrap().is_match(&col));
    assert!(!forward.contains('Q'));

    // Every line clear of unrelated shapes across ALL c4-docs.json examples & widths
    let docs = load_fixture("c4-docs.json");
    let mut behind = BTreeSet::new();
    let re_shape = Regex::new(
        r#"class="pele-node[^"]*" data-id="([^"]+)" transform="translate\(([-\d.]+),([-\d.]+)\)">(?:<a [^>]*>)?<(rect|path d="M([-\d.]+),([-\d.]+)([HV])([-\d.]+))"#,
    )
    .unwrap();
    for source in &docs {
        let rels = c4_model(source).rels;
        let title_line = source.lines().nth(1).unwrap_or("").trim();
        for max_width in [None, Some(640.0), Some(480.0), Some(320.0)] {
            let mut opts = css_options();
            opts.max_width = max_width;
            let svg = render(source, &opts).unwrap().svg;
            let shapes: Vec<(String, BoxRect)> = re_shape
                .captures_iter(&svg)
                .map(|m| {
                    let id = m[1].to_string();
                    if &m[4] == "rect" {
                        (id.clone(), box_of(&svg, &id))
                    } else {
                        let cx: f64 = m[2].parse().unwrap();
                        let cy: f64 = m[3].parse().unwrap();
                        let mx: f64 = m[5].parse().unwrap();
                        let my: f64 = m[6].parse().unwrap();
                        let end: f64 = m[8].parse().unwrap();
                        let w = if &m[7] == "H" { end - mx } else { -2.0 * mx };
                        let h = if &m[7] == "V" { end - my } else { -2.0 * my };
                        (id, BoxRect { x: cx + mx, y: cy + my, w, h })
                    }
                })
                .collect();
            let lines = corners(&svg);
            for (index, (id, points)) in lines.iter().enumerate() {
                let rel = rels.iter().find(|r| format!("{}-{}", r.from, r.to) == *id).unwrap_or(&rels[index]);
                for (name, sb) in &shapes {
                    if *name == rel.from || *name == rel.to {
                        continue;
                    }
                    let mut i = 2;
                    while i < points.len() {
                        let (x0, y0, x1, y1) = (points[i - 2], points[i - 1], points[i], points[i + 1]);
                        let mut hit = false;
                        for step in 0..=50 {
                            let t = step as f64 * 0.02;
                            let x = x0 + (x1 - x0) * t;
                            let y = y0 + (y1 - y0) * t;
                            if x > sb.x + 1.0 && x < sb.x + sb.w - 1.0 && y > sb.y + 1.0 && y < sb.y + sb.h - 1.0 {
                                let wlbl = max_width.map_or_else(|| "full".to_string(), |w| format!("{w:.0}"));
                                behind.insert(format!("{id} behind {name} at {wlbl} width in {title_line}"));
                                hit = true;
                                break;
                            }
                        }
                        if hit {
                            break;
                        }
                        i += 2;
                    }
                }
            }
        }
    }
    assert_eq!(
        behind.into_iter().collect::<Vec<_>>(),
        vec!["backend_api-banking_system behind mobile_app at full width in title Container diagram for Internet Banking System"]
    );

    // Component diagram routing lanes & outside detours + compact layout offset reattachment
    let component = docs.iter().find(|s| s.contains("Accounts Summary Controller")).unwrap();
    let mut o640 = css_options();
    o640.max_width = Some(640.0);
    let comp_640 = render(component, &o640).unwrap().svg;
    let lines_map: HashMap<String, Vec<f64>> = corners(&comp_640).into_iter().collect();
    let lane_of = |id: &str| -> f64 {
        let pts = &lines_map[id];
        let mut i = 2;
        while i < pts.len() {
            assert!(pts[i] == pts[i - 2] || pts[i + 1] == pts[i - 1], "non-orthogonal segment in {id}");
            i += 2;
        }
        pts[4]
    };
    let spa = box_of(&comp_640, "spa");
    let accounts = box_of(&comp_640, "accounts");
    let mbs = box_of(&comp_640, "mbs");
    for id in ["spa-accounts", "ma-sign"] {
        assert!(lane_of(id) > spa.x + spa.w);
        assert!(lane_of(id) < accounts.x);
    }
    assert!((lane_of("spa-accounts") - lane_of("ma-sign")).abs() >= 10.0);
    assert!(lines_map["spa-sign"][4] < spa.x);
    assert!(lines_map["mbsfacade-mbs"][4] > mbs.x + mbs.w);

    // Reattaches manual offsets when compact without mutating parsed model
    let re_rel_style = Regex::new(r"(?m)^\s*UpdateRelStyle\([^\n]+\)\s*$").unwrap();
    let without_offsets = re_rel_style.replace_all(component, "").to_string();
    let parsed = parse(component, &ParseOptions::default()).unwrap();
    let before = format!("{:?}", parsed.model);
    for mw in [320.0, 480.0, 568.0] {
        let mut opts = css_options();
        opts.max_width = Some(mw);
        let compact = render_model(&parsed, &opts).unwrap();
        assert_eq!(compact.svg, render(&without_offsets, &opts).unwrap().svg);
    }
    assert_eq!(format!("{:?}", parsed.model), before);
    let mut o568 = css_options();
    o568.max_width = Some(568.0);
    let svg568 = render_model(&parsed, &o568).unwrap().svg;
    for (from, to) in [("sign", "security"), ("accounts", "mbsfacade")] {
        let ba = box_of(&svg568, from);
        let bb = box_of(&svg568, to);
        let id = format!("{from}-{to}");
        let lx = label_x(&svg568, &id);
        let ly = label_y(&svg568, &id);
        assert!(lx > ba.x && lx < ba.x + ba.w);
        assert!(ly > ba.y + ba.h && ly + 20.0 < bb.y);
    }
    let wide = render(component, &css_options()).unwrap();
    let mut o_wide = css_options();
    o_wide.max_width = Some(wide.width);
    assert_eq!(render_model(&parsed, &o_wide).unwrap().svg, wide.svg);
    assert_ne!(wide.svg, render(&without_offsets, &css_options()).unwrap().svg);

    // Opposite relations, self-loop, boundary endpoints, unknown endpoint error
    let opp = render(
        "C4Context\nSystem(a, \"A\")\nSystem(b, \"B\")\nRel(a, b, \"there\")\nRel(b, a, \"back\")",
        &css_options(),
    )
    .unwrap()
    .svg;
    let edge_y = |id: &str| -> f64 {
        Regex::new(&format!(r#"data-id="{id}"><path d="M[\d.]+,([\d.]+)L"#))
            .unwrap()
            .captures(&opp)
            .unwrap()[1]
            .parse()
            .unwrap()
    };
    assert_eq!((edge_y("a-b") - edge_y("b-a")).abs(), 14.0);
    assert!(label_y(&opp, "a-b") > edge_y("a-b"));
    assert!(label_y(&opp, "b-a") + 20.0 < edge_y("b-a"));

    let loop_svg = render("C4Context\nSystem(a, \"A\")\nRel(a, a, \"again\")", &css_options()).unwrap().svg;
    assert!(Regex::new(r#"data-id="a-a"><path d="M[\d.]+,[\d.]+C"#).unwrap().is_match(&loop_svg));
    assert!(label_x(&loop_svg, "a-a") > box_of(&loop_svg, "a").x + box_of(&loop_svg, "a").w);
    assert_inert(&loop_svg, "c4 loop");

    let brel = render(
        "C4Context\nSystem(out, \"Out\")\nBoundary(b, \"B\") {\n  System(in, \"In\")\n}\nRel(out, b, \"to boundary\")\nRel(b, in, \"into\")",
        &css_options(),
    )
    .unwrap()
    .svg;
    let bb = box_of(&brel, "b");
    let out_b = Regex::new(r#"data-id="out-b"><path d="M[\d.]+,[\d.]+L[\d.]+,([\d.]+)""#)
        .unwrap()
        .captures(&brel)
        .unwrap();
    assert!((out_b[1].parse::<f64>().unwrap() - (bb.y - 7.0)).abs() < 1e-4);
    let b_in = Regex::new(r#"data-id="b-in"><path d="M([\d.]+),([\d.]+)L"#).unwrap().captures(&brel).unwrap();
    assert_eq!(b_in[1].parse::<f64>().unwrap(), bb.x);

    let miss_err = render("C4Context\nSystem(a, \"A\")\nRel(a, missing, \"x\")", &css_options()).unwrap_err();
    assert_eq!(miss_err.message, r#"C4 rel "a" -> "missing" references an unknown shape or boundary"#);
    assert!(render("C4Context\nSystem(a, \"A\")\nRel($x=\"y\", a, \"x\")", &css_options()).is_err());

    // Element styles, contrast ink, casings, rel styles, heading nudging
    let styled = render(
        "C4Context\nPerson(a, \"A\", \"desc\")\nBoundary(b, \"B\") {\n  System(c, \"C\")\n}\nUpdateElementStyle(a, $fontColor=\"red\", $bgColor=\"grey\", $borderColor=\"blue\")\nUpdateElementStyle(b, \"#eee\", \"green\", \"orange\")\nUpdateElementStyle(nobody, \"red\")",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(
        Regex::new(r#"data-id="a"[^>]*><rect[^>]*style="fill:grey;stroke:blue;""#)
            .unwrap()
            .is_match(&styled)
    );
    assert!(
        Regex::new(r#"data-id="a"[^>]*>.*?<circle[^>]*style="fill:grey;stroke:blue;""#)
            .unwrap()
            .is_match(&styled)
    );
    assert_eq!(count_sub(&styled, r#"style="fill:red;""#), 3);
    assert!(
        Regex::new(r#"data-id="b"><rect[^>]*style="rx:var\(--_r\);fill:#eee;stroke:orange;""#)
            .unwrap()
            .is_match(&styled)
    );
    assert!(Regex::new(r#"class="pele-cluster-label"[^>]*style="fill:green;""#).unwrap().is_match(&styled));

    let contrast = render(
        "C4Context\nBoundary(b, \"B\", \"Kind\") {\n  System(c, \"C\", \"about c\")\n}\nSystem(d, \"D\", \"about d\")\nSystem(e, \"E\")\nUpdateElementStyle(b, $bgColor=\"lightyellow\")\nUpdateElementStyle(c, $bgColor=\"navy\")\nUpdateElementStyle(d, $bgColor=\"navy\", $fontColor=\"#ddd\")",
        &css_options(),
    )
    .unwrap()
    .svg;
    let group_of = |id: &str| -> String { Regex::new(&format!(r#"data-id="{id}"[^>]*>(.*?)</g>"#)).unwrap().captures(&contrast).unwrap()[1].to_string() };
    assert_eq!(count_sub(&group_of("c"), r#"fill="var(--pele-fg-on-dark,#fff)""#), 3);
    assert!(group_of("b").contains(r#"<text class="pele-cluster-label" font-weight="var(--_hw)" fill="var(--pele-fg-on-light,#1f1f1f)""#));
    assert!(
        Regex::new(r#"class="pele-c4-type"[^>]* fill="var\(--pele-fg-on-light,#1f1f1f\)""#)
            .unwrap()
            .is_match(&group_of("b"))
    );
    assert!(!group_of("d").contains("--pele-fg-on"));
    assert!(!group_of("e").contains("--pele-fg-on"));

    let cas_src = "C4Context\nBoundary(b, \"B\") {\n  System(x, \"X\")\n  System(y, \"Y\")\n}\nSystem(z, \"Z\")\nSystem(w, \"W\")\nRel(x, y, \"in\")\nRel(y, z, \"out\")\nRel(z, w, \"away\")\nUpdateElementStyle(b, $bgColor=\"lightyellow\")";
    let cas_svg = render(cas_src, &css_options()).unwrap().svg;
    let casings = &Regex::new(r#"<g class="pele-casings"[^>]*>(.*?)</g>"#).unwrap().captures(&cas_svg).unwrap()[1];
    let edge_d = |id: &str| -> String {
        Regex::new(&format!(r#"data-id="{id}"[^>]*><path d="([^"]+)""#))
            .unwrap()
            .captures(&cas_svg)
            .unwrap()[1]
            .to_string()
    };
    assert!(!casings.contains(&format!(r#"<path d="{}"/>"#, edge_d("x-y"))));
    assert!(
        Regex::new(
            r#"data-id="x-y" stroke="var\(--pele-fg-on-light,#1f1f1f\)"><path [^>]*\/><path class="pele-marker"[^>]* fill="var\(--pele-fg-on-light,#1f1f1f\)""#
        )
        .unwrap()
        .is_match(&cas_svg)
    );
    assert!(casings.contains(&format!(r#"<path d="{}"/>"#, edge_d("y-z"))));
    assert!(!casings.contains(&format!(r#"<path d="{}"/>"#, edge_d("z-w"))));

    // Rel styles & offsets
    let rbase = "C4Context\nUpdateLayoutConfig(\"1\", \"1\")\nSystem(a, \"A\")\nSystem(b, \"B\")\nRel(a, b, \"x\")\n";
    let plain = render(rbase, &css_options()).unwrap().svg;
    let rstyled = render(
        &format!("{rbase}UpdateRelStyle(a, b, $textColor=\"red\", $lineColor=\"blue\", $offsetX=\"30\", $offsetY=\"-10\")"),
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(rstyled.contains(r#"<g class="pele-edge" data-id="a-b" style="stroke:blue;">"#));
    assert!(Regex::new(r#"class="pele-marker"[^>]*fill="blue""#).unwrap().is_match(&rstyled));
    assert!(
        Regex::new(r#"class="pele-edge-label" data-id="a-b"><rect[^>]*><text style="fill:red;""#)
            .unwrap()
            .is_match(&rstyled)
    );
    assert_eq!(label_x(&rstyled, "a-b"), label_x(&plain, "a-b") + 30.0);
    assert_eq!(label_y(&rstyled, "a-b"), label_y(&plain, "a-b") - 10.0);
    assert_eq!(
        render(&format!("{rbase}UpdateRelStyle(a, b, \"red\", \"blue\", \"30\", \"-10\")"), &css_options())
            .unwrap()
            .svg,
        rstyled
    );
    assert_eq!(
        render(
            &format!("{rbase}UpdateRelStyle(a, b, $offsetX=\"30\", $offsetY=\"-10\", $lineColor=\"blue\", $textColor=\"red\")"),
            &css_options()
        )
        .unwrap()
        .svg,
        rstyled
    );

    // Offset collision & clamping
    let obase = "C4Context\nSystem(a, \"A\")\nSystem(b, \"B\")\nRel(a, b, \"x\")\n";
    let oplain = render(obase, &css_options()).unwrap().svg;
    assert_eq!(
        render(&format!("{obase}UpdateRelStyle(a, b, $offsetX=\"-120\")"), &css_options()).unwrap().svg,
        oplain
    );
    assert_eq!(
        label_y(
            &render(&format!("{obase}UpdateRelStyle(a, b, $offsetY=\"-60\")"), &css_options()).unwrap().svg,
            "a-b"
        ),
        label_y(&oplain, "a-b") - 60.0
    );
    assert!(
        render(&format!("{obase}UpdateRelStyle(a, b, $offsetX=\"9999999999\")"), &css_options())
            .unwrap()
            .width
            < 3000.0
    );
    assert_eq!(
        render(&format!("{obase}UpdateRelStyle(a, b, $offsetX=\"abc\", $offsetY=\"x1\")"), &css_options())
            .unwrap()
            .svg,
        oplain
    );

    // Boundary heading moves out of line's way
    let hsvg = render(
        "C4Context\nSystem(top, \"Top\")\nBoundary(b, \"Boundary name\") {\n  System(in, \"In\")\n  System(other, \"Other\")\n}\nRel(top, in, \"x\")",
        &css_options(),
    )
    .unwrap()
    .svg;
    let heading: f64 = Regex::new(r#"class="pele-cluster-label".*?x="([\d.]+)""#).unwrap().captures(&hsvg).unwrap()[1]
        .parse()
        .unwrap();
    let line_x: f64 = Regex::new(r#"data-id="top-in"><path d="M([\d.]+),"#).unwrap().captures(&hsvg).unwrap()[1]
        .parse()
        .unwrap();
    assert!((heading - line_x).abs() > 20.0);
    let alone = render(
        "C4Context\nBoundary(b, \"Boundary name\") {\n System(in, \"In\")\n System(other, \"Other\")\n}",
        &css_options(),
    )
    .unwrap()
    .svg;
    let alone_x: f64 = Regex::new(r#"class="pele-cluster-label".*?x="([\d.]+)""#).unwrap().captures(&alone).unwrap()[1]
        .parse()
        .unwrap();
    assert!(alone_x < heading);
}

#[test]
fn c4_links_titles_named_attrs_merges_cycles_errors_and_docs() {
    // Links
    let lres = render(
        "C4Context\nSystem(a, \"A\", $link=\"https://example.com/a\")\nBoundary(b, \"B\", $link=\"https://example.com/b\") {\n  System(c, \"C\", $link=\"javascript:alert(1)\")\n}\nRel(a, c, \"x\", $link=\"https://example.com/rel\")",
        &css_options(),
    )
    .unwrap();
    assert!(
        Regex::new(r#"data-id="a" transform="[^"]*"><a href="https://example\.com/a" rel="noopener"><rect"#)
            .unwrap()
            .is_match(&lres.svg)
    );
    assert!(
        Regex::new(r#"data-id="b"><rect[^>]*><a href="https://example\.com/b" rel="noopener"><text"#)
            .unwrap()
            .is_match(&lres.svg)
    );
    assert!(
        Regex::new(r#"class="pele-edge-label" data-id="a-c"><rect[^>]*><a href="https://example\.com/rel""#)
            .unwrap()
            .is_match(&lres.svg)
    );
    assert!(!lres.svg.contains("javascript"));
    assert_eq!(
        lres.links,
        vec![
            LinkInfo {
                id: "a-c".to_string(),
                href: "https://example.com/rel".to_string(),
                internal: false
            },
            LinkInfo {
                id: "a".to_string(),
                href: "https://example.com/a".to_string(),
                internal: false
            },
            LinkInfo {
                id: "b".to_string(),
                href: "https://example.com/b".to_string(),
                internal: false
            },
        ]
    );

    // Tooltips, titles, accTitle/accDescr, font size scaling
    assert!(
        render(
            "C4Context\nSystem(a, \"A\")\nSystem(b, \"B\")\nRel(a, b, \"x\", \"t\", \"why <it> matters\")",
            &css_options()
        )
        .unwrap()
        .svg
        .contains("<title>why &lt;it&gt; matters</title>")
    );
    let acc = render(
        "C4Context\naccTitle: Shown on top\naccDescr: For screen readers\nSystem(a, \"A\")",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(acc.contains("Shown on top</t"));
    assert!(acc.contains(r#"<desc id="pele-desc">For screen readers</desc>"#));
    assert!(!acc.contains("<title"));
    assert_eq!(
        c4_model("C4Context\naccDescr {\n  two\n  lines\n}\nSystem(a, \"A\")").acc_descr.as_deref(),
        Some("two\nlines")
    );
    assert_eq!(
        c4_model("C4Context\naccDescription one line\nSystem(a, \"A\")").acc_descr.as_deref(),
        Some("one line")
    );

    let bare = c4_model("C4Context\ntitle\nPerson(a, \"Alice\")\nPerson(b, \"Bob\")");
    assert_eq!(bare.title, None);
    assert_eq!(bare.shapes.iter().map(|s| s.el.label.as_str()).collect::<Vec<_>>(), vec!["Alice", "Bob"]);
    assert_eq!(c4_model("C4Context\ntitle\tOwn\nSystem(a, \"A\")").title.as_deref(), Some("Own"));

    // Named attributes compat matrix (c4NamedAttributes.spec.ts)
    for (header, tmpl, fields) in [
        ("C4Context", "System(x, \"L\", $F=\"V\")", &["descr", "tags", "sprite", "link"][..]),
        ("C4Context", "Person(x, \"L\", $F=\"V\")", &["descr", "tags", "sprite", "link"][..]),
        (
            "C4Container",
            "Container(x, \"L\", $F=\"V\")",
            &["descr", "techn", "tags", "sprite", "link"][..],
        ),
        (
            "C4Component",
            "Component(x, \"L\", $F=\"V\")",
            &["descr", "techn", "tags", "sprite", "link"][..],
        ),
    ] {
        for &field in fields {
            let db = c4_model(&format!("{header}\n{}", tmpl.replace("$F", &format!("${field}"))));
            let el = &db.shapes[0].el;
            let got = match field {
                "descr" => el.descr.as_deref(),
                "techn" => el.techn.as_deref(),
                "tags" => el.tags.as_deref(),
                "sprite" => el.sprite.as_deref(),
                "link" => el.link.as_deref(),
                _ => unreachable!(),
            };
            assert_eq!(got, Some("V"), "{tmpl} field {field}");
        }
    }
    for (header, tmpl, fields) in [
        ("C4Context", "System_Boundary(x, \"L\", $F=\"V\")", &["type", "tags", "link"][..]),
        ("C4Container", "Container_Boundary(x, \"L\", $F=\"V\")", &["type", "tags", "link"][..]),
        ("C4Deployment", "Node(x, \"L\", $F=\"V\")", &["type", "descr", "tags", "sprite", "link"][..]),
    ] {
        for &field in fields {
            let db = c4_model(&format!("{header}\n{} {{\nContainer(i, \"I\")\n}}", tmpl.replace("$F", &format!("${field}"))));
            let el = &db.boundaries[1].el;
            let got = match field {
                "type" => el.elem_type.as_deref(),
                "descr" => el.descr.as_deref(),
                "tags" => el.tags.as_deref(),
                "sprite" => el.sprite.as_deref(),
                "link" => el.link.as_deref(),
                _ => unreachable!(),
            };
            assert_eq!(got, Some("V"), "{tmpl} field {field}");
        }
    }
    for field in ["techn", "descr", "tags", "sprite", "link"] {
        let db = c4_model(&format!("C4Context\nPerson(a, \"A\")\nPerson(b, \"B\")\nRel(a, b, \"uses\", ${field}=\"V\")"));
        let r = &db.rels[0];
        let got = match field {
            "techn" => r.techn.as_deref(),
            "descr" => r.descr.as_deref(),
            "tags" => r.tags.as_deref(),
            "sprite" => r.sprite.as_deref(),
            "link" => r.link.as_deref(),
            _ => unreachable!(),
        };
        assert_eq!(got, Some("V"), "Rel field {field}");
    }

    // Container with $techn defaults descr to Some("")
    let c_techn = c4_model("C4Container\nContainer(c, \"C\", $techn=\"Java\")");
    assert_eq!(c_techn.shapes[0].el.techn.as_deref(), Some("Java"));
    assert_eq!(c_techn.shapes[0].el.descr.as_deref(), Some(""));
    // Container with $descr preserves descr and leaves techn None
    let c_descr = c4_model("C4Container\nContainer(c, \"C\", $descr=\"a description\")");
    assert_eq!(c_descr.shapes[0].el.descr.as_deref(), Some("a description"));
    assert_eq!(c_descr.shapes[0].el.techn, None);

    // Repeated alias merge + boundary named global + cyclic boundary pruning
    let merged = c4_model(
        "C4Context\nSystem(a, \"First\", \"d1\")\nSystem(b, \"B\")\nBoundary(x, \"X\") {\n  Person(a, \"Second\")\n}\nRel(a, b, \"one\", \"t\")\nBiRel(a, b, \"two\")",
    );
    assert_eq!(merged.shapes.iter().map(|s| s.el.alias.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
    assert_eq!(merged.shapes[0].el.label, "Second");
    assert_eq!(merged.shapes[0].el.descr.as_deref(), Some("d1"));
    assert_eq!(merged.shapes[0].kind, "person");
    assert_eq!(merged.boundaries[merged.shapes[0].el.parent.unwrap()].el.alias, "x");
    assert_eq!(merged.rels.len(), 1);
    assert_eq!(merged.rels[0].rel_type, C4RelKind::BiRel);
    assert_eq!(merged.rels[0].techn.as_deref(), Some("t"));

    let glob = render("C4Context\nBoundary(global, \"Everything\") {\n System(a, \"A\")\n}", &css_options())
        .unwrap()
        .svg;
    assert!(glob.contains(r#"data-id="global""#) && glob.contains(r#"data-id="a""#));

    let cyc = render("C4Context\nSystem(ok, \"OK\")\nBoundary(a, \"A\") {\n  Boundary(b, \"B\") {\n    Boundary(a, \"A again\") {\n      System(lost, \"Lost\")\n    }\n  }\n}", &css_options()).unwrap().svg;
    assert!(cyc.contains(r#"data-id="ok""#) && !cyc.contains(r#"data-id="lost""#) && !cyc.contains(r#"data-id="b""#));

    // Jison syntax errors + unquoted last arg
    assert!(
        render("C4Context\nPerson (a, \"A\")", &css_options())
            .unwrap_err()
            .message
            .starts_with("Lexical error on line 2. Unrecognized text.")
    );
    assert!(
        render("C4Context\nPerson(a, \"A\") Person(b, \"B\")", &css_options())
            .unwrap_err()
            .message
            .contains("Expecting 'NEWLINE', 'EOF', got 'PERSON'")
    );
    assert!(
        render("C4Context\nBoundary(b, \"B\")\nSystem(a, \"A\")", &css_options())
            .unwrap_err()
            .message
            .contains("Expecting 'LBRACE', got 'SYSTEM'")
    );
    assert!(
        render("C4Context\nBoundary(b, \"B\") {\nSystem(a, \"A\")", &css_options())
            .unwrap_err()
            .message
            .contains("got 'EOF'")
    );
    assert_eq!(render("C4Context\n", &css_options()).unwrap_err().code, ErrorCode::Syntax);
    assert!(
        render("C4Context\nPerson(a, \"A\", $link=\"\")", &css_options())
            .unwrap_err()
            .message
            .contains("Expecting 'STR_VALUE'")
    );
    assert_eq!(
        render("C4Context\nPerson(a, \"A\"", &css_options()).unwrap_err().diagram_type,
        Some(DiagramType::C4)
    );

    let unq = c4_model("C4Context\nPerson(a, plain label)\nSystem(b, \"B\")");
    assert_eq!(unq.shapes.len(), 1);
    assert_eq!(unq.shapes[0].el.label, "plain label)\nSystem(b");

    // Docs examples in CSS, Light, Dark + resvg + fontSize scaling
    let docs = load_fixture("c4-docs.json");
    assert!(docs.len() >= 5);
    for src in &docs {
        let r = render(src, &css_options()).unwrap();
        assert!(!r.svg.contains("NaN") && !r.svg.contains("Infinity") && !r.svg.contains("undefined"));
        assert!(r.width > 100.0 && r.height > 50.0);
        let doc = Document::parse(&r.svg).unwrap();
        for el in doc.descendants().filter(|n| n.is_element() && n.tag_name().name() == "text") {
            let x = el.attribute("x").unwrap_or("0");
            assert!(x.parse::<f64>().unwrap().is_finite());
        }
        assert_inert(&r.svg, &src[..src.len().min(60)]);
        let light = render(src, &resolved_options()).unwrap();
        assert_inert_resolved(&light.svg, &src[..src.len().min(60)]);
        assert_resvg_parses(&light.svg, &src[..src.len().min(60)]);
        let dark = render(src, &dark_options()).unwrap();
        assert_inert_resolved(&dark.svg, &src[..src.len().min(60)]);
        assert_resvg_parses(&dark.svg, &src[..src.len().min(60)]);
    }

    let fsrc = "C4Context\nSystem(a, \"A\", \"Some description text that wraps over lines\")";
    let mut big_font = css_options();
    big_font.font_size = Some(24.0);
    assert!(render(fsrc, &big_font).unwrap().height > render(fsrc, &css_options()).unwrap().height);
}

#[test]
fn c4_security_corpus_payloads_links_colors_and_mutated_fuzz() {
    let corpus = load_fixture("c4-corpus.json");
    let css = css_options();
    let res = resolved_options();

    let mut rendered = 0;
    for src in &corpus {
        if check_both_modes(src, &css, &res) {
            rendered += 1;
        }
    }
    assert!(rendered > 20, "expected >20 c4 corpus renders, got {rendered}");

    // Determinism across first 20 corpus items
    for src in corpus.iter().take(20) {
        if let Ok(first) = render(src, &css) {
            assert_eq!(render(src, &css).unwrap().svg, first.svg);
        }
    }

    let two = "System(a, \"A\")\nSystem(b, \"B\")\n";
    type TemplateFn = Box<dyn Fn(&str) -> String>;
    let templates: Vec<TemplateFn> = vec![
        Box::new(|p| format!("C4Context\nPerson({p}, \"L\")")),
        Box::new(|p| format!("C4Context\nPerson(\"{p}\", \"L\")")),
        Box::new(|p| format!("C4Context\nPerson(a, {p}, \"d\")")),
        Box::new(|p| format!("C4Context\nPerson(a, \"{p}\")")),
        Box::new(|p| format!("C4Context\nPerson_Ext(a, \"L\", \"{p}\")")),
        Box::new(|p| format!("C4Context\nSystem(a, \"L\", \"d\", \"{p}\", \"{p}\", \"{p}\")")),
        Box::new(|p| format!("C4Context\nSystemDb(a, \"L\", $link=\"{p}\")")),
        Box::new(|p| format!("C4Context\nSystemQueue_Ext(a, \"L\", $tags=\"{p}\", $sprite=\"{p}\")")),
        Box::new(|p| format!("C4Context\nSystem(a, \"L\", $descr=\"{p}\", $techn=\"{p}\", $type=\"{p}\", $label=\"{p}\")")),
        Box::new(|p| format!("C4Context\nSystem(a, \"L\", $bgColor=\"{p}\", $fontColor=\"{p}\", $borderColor=\"{p}\", $shape=\"{p}\")")),
        Box::new(|p| format!("C4Context\nSystem(a, \"L\", ${p}=\"x\")")),
        Box::new(|p| format!("C4Context\nSystem(${p}=\"x\", \"L\")")),
        Box::new(|p| format!("C4Context\nSystem(a, $link=\"{p}\")")),
        Box::new(|p| format!("C4Container\nContainer(a, \"{p}\", \"{p}\", \"{p}\")")),
        Box::new(|p| format!("C4Context\nBoundary({p}, \"L\") {{\nSystem(a, \"A\")\n}}")),
        Box::new(|p| format!("C4Context\nSystem_Boundary(b, \"L\", $link=\"{p}\", $tags=\"{p}\", $type=\"{p}\") {{\nSystem(a, \"A\")\n}}")),
        Box::new(|p| format!("C4Deployment\nDeployment_Node(n, \"{p}\", \"{p}\", \"{p}\", \"{p}\", \"{p}\", \"{p}\") {{\nContainer(a, \"A\")\n}}")),
        Box::new(move |p| format!("C4Context\n{two}Rel(a, b, \"{p}\", \"{p}\", \"{p}\")")),
        Box::new(move |p| format!("C4Context\n{two}Rel_Back(a, b, \"L\", $link=\"{p}\", $techn=\"{p}\", $descr=\"{p}\")")),
        Box::new(move |p| {
            format!("C4Context\n{two}Rel(a, b, \"L\")\nUpdateRelStyle(a, b, $textColor=\"{p}\", $lineColor=\"{p}\", $offsetX=\"{p}\", $offsetY=\"{p}\")")
        }),
        Box::new(move |p| format!("C4Context\n{two}UpdateElementStyle(a, $bgColor=\"{p}\", $fontColor=\"{p}\", $borderColor=\"{p}\")")),
        Box::new(move |p| format!("C4Context\n{two}UpdateLayoutConfig($c4ShapeInRow=\"{p}\", $c4BoundaryInRow=\"{p}\")")),
        Box::new(move |p| format!("C4Context\ntitle {p}\n{two}")),
        Box::new(move |p| format!("C4Context\naccTitle: {p}\naccDescr: {p}\n{two}")),
        Box::new(move |p| format!("C4Context\naccDescr {{\n {p}\n }}\n{two}")),
    ];

    let mut payload_rendered = 0;
    for tmpl in &templates {
        for &payload in PAYLOADS {
            if check_both_modes(&tmpl(payload), &css, &res) {
                payload_rendered += 1;
            }
        }
    }
    assert!(payload_rendered > 400, "expected >400 c4 payload renders, got {payload_rendered}");

    // Hostile options
    for &payload in PAYLOADS {
        let mut c = css_options();
        c.id_prefix = Some(payload.to_string());
        c.font_family = Some(payload.to_string());
        let mut r = resolved_options();
        r.id_prefix = Some(payload.to_string());
        r.font_family = Some(payload.to_string());
        assert!(check_both_modes(
            "C4Context\naccDescr: d\nSystem(a, \"A\")\nSystem(b, \"B\")\nRel(a, b, \"x\")",
            &c,
            &r
        ));
    }

    // Never emits unsafe links
    for url in [
        "javascript:alert(1)",
        " JaVaScRiPt:alert(1)",
        "data:text/html,x",
        "vbscript:x",
        "jav&#x09;ascript:alert(1)",
    ] {
        let r = render(
            &format!(
                "C4Context\nSystem(a, \"A\", $link=\"{url}\")\nBoundary(b, \"B\", $link=\"{url}\") {{\nSystem(c, \"C\")\n}}\nRel(a, c, \"x\", $link=\"{url}\")"
            ),
            &css,
        )
        .unwrap();
        assert!(!r.svg.contains("<a "));
        assert!(r.links.is_empty());
    }

    // Drops hostile colors
    let bad_col = render(
        "C4Context\nSystem(a, \"A\")\nSystem(b, \"B\")\nRel(a, b, \"x\")\nUpdateElementStyle(a, \"red;background:url(//evil.example/x)\", \"expression(alert(1))\", \"url(#x)\")\nUpdateRelStyle(a, b, \"red}\", \"blue<\")",
        &css,
    )
    .unwrap()
    .svg;
    assert!(!Regex::new(r"url\(|expression|evil|red|blue").unwrap().is_match(&bad_col));

    // Mutated fuzzing
    let mut frags: Vec<&str> = PAYLOADS.to_vec();
    frags.extend([
        "\"",
        "(",
        ")",
        ",",
        "\n",
        "{",
        "}",
        "$link=\"",
        "$bgColor=\"",
        "$offsetX=\"",
        "Rel(a, b, \"",
        "UpdateElementStyle(a, \"",
    ]);
    let mut mutator = Mutator::new(&corpus, frags, 3);
    for _ in 0..800 {
        let src = mutator.next_sample();
        if src.len() <= 4000 {
            check_both_modes(&src, &css, &res);
        }
    }
}

#[test]
fn c4_stress_worst_cases() {
    const N: usize = 50_000;
    let big = RenderOptions {
        limit: Some(usize::MAX),
        output_limit: Some(usize::MAX),
        ..css_options()
    };
    let big = &big;
    let h = "C4Context\n";

    let mut s_2500 = String::from(h);
    for i in 0..2500 {
        s_2500.push_str(&format!("System(s{i}, \"S{i}\")\n"));
    }
    let mut s_nested = String::from(h);
    for i in 0..2000 {
        s_nested.push_str(&format!("Boundary(b{i}, \"B{i}\") {{\n"));
    }
    s_nested.push_str("System(s, \"S\")\n");
    s_nested.push_str(&"}\n".repeat(2000));

    let mut s_rels = String::from(h);
    for i in 0..50 {
        s_rels.push_str(&format!("System(s{i},\"S\")\n"));
    }
    for i in 0..50 {
        for j in 0..50 {
            if i != j {
                s_rels.push_str(&format!("Rel(s{i},s{j},\"x\")\n"));
            }
        }
    }

    type StressCase<'a> = (&'a str, Box<dyn Fn() + 'a>);
    let cases: Vec<StressCase<'_>> = vec![
        (
            "direction long line",
            Box::new(move || {
                let _ = tokenize(&format!("{h}{} direction XX", "Rel(a,b,\"x\")".repeat(N / 12)));
            }),
        ),
        (
            "unclosed string",
            Box::new(move || {
                let _ = tokenize(&format!("{h}Person(a, \"{}", "x".repeat(N)));
            }),
        ),
        (
            "50k commas",
            Box::new(move || {
                let _ = parse(
                    &format!("{h}Person({})", ",".repeat(N)),
                    &ParseOptions {
                        limit: Some(usize::MAX),
                        ..Default::default()
                    },
                );
            }),
        ),
        (
            "2,500 shapes",
            Box::new(move || {
                assert_eq!(count_sub(&render(&s_2500, big).unwrap().svg, r#"class="pele-node "#), 2500);
            }),
        ),
        (
            "2,000 nested boundaries",
            Box::new(move || {
                assert!(render(&s_nested, big).unwrap().svg.contains(r#"data-id="b1999""#));
            }),
        ),
        (
            "2,450 relations among 50 shapes",
            Box::new(move || {
                let _ = render(&s_rels, big);
            }),
        ),
        (
            "2,000 self and reversed rels",
            Box::new(move || {
                let _ = render(
                    &format!(
                        "{h}System(a,\"A\")\nSystem(b,\"B\")\n{}",
                        "Rel(a,a,\"x\")\nRel(a,b,\"y\")\nRel(b,a,\"z\")\n".repeat(700)
                    ),
                    big,
                );
            }),
        ),
    ];
    for (name, run) in cases {
        let start = Instant::now();
        run();
        let elapsed = start.elapsed().as_millis();
        assert!(elapsed < 5000, "c4 stress '{name}' took {elapsed}ms");
    }

    // Default limit refusal
    let err = render(&format!("{h}{}", "System(a, \"A\")\n".repeat(5000)), &css_options()).unwrap_err();
    assert!(err.message.contains("limit of 50000"), "unexpected err: {}", err.message);
}
