use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Instant;

use regex::Regex;
use vibevalley_pele::detect::DiagramType;
use vibevalley_pele::diagram::sankey::db::SankeyModel;
use vibevalley_pele::diagram::sankey::layout::{Alignment, LayoutOptions, layout_sankey};
use vibevalley_pele::diagram::sankey::lexer::tokenize;
use vibevalley_pele::diagram::sankey::parser::prepare_text_for_parsing;
use vibevalley_pele::{ErrorCode, METRICS_MEASURER, ParseOptions, ParsedModel, RenderOptions, TextMeasurer, TextStyle, parse, render, supports};

use crate::support::{
    Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, assert_well_formed, css_options, dark_options, load_fixture, resolved_options,
};

const BASIC: &str = "sankey\na,b,5\na,c,3\nb,d,4\nc,d,1.239\n";

fn configured(sankey: &str, body: &str) -> String {
    let indented = sankey.lines().map(|l| format!("    {l}")).collect::<Vec<_>>().join("\n");
    format!("---\nconfig:\n  sankey:\n{indented}\n---\n{body}")
}

fn node_attr(svg: &str, id: &str, attr: &str) -> String {
    let doc = roxmltree::Document::parse(svg).unwrap();
    doc.descendants()
        .find(|n| n.is_element() && n.attribute("class") == Some("pele-sankey-node") && n.attribute("data-id") == Some(id))
        .unwrap_or_else(|| panic!("missing node {id}"))
        .attribute(attr)
        .unwrap_or_else(|| panic!("missing attr {attr} on node {id}"))
        .to_string()
}

fn assert_close(actual: f64, expected: f64, tol: f64) {
    assert!((actual - expected).abs() <= tol, "expected {actual} to be within {tol} of {expected}");
}

fn build_sankey(rows: &[(&str, &str, f64)]) -> SankeyModel {
    let mut db = SankeyModel::new();
    for &(s, t, v) in rows {
        let si = db.find_or_create_node(s);
        let ti = db.find_or_create_node(t);
        db.add_link(si, ti, v);
    }
    db
}

fn layout_opts(alignment: Alignment) -> LayoutOptions {
    LayoutOptions {
        width: 600.0,
        height: 400.0,
        node_width: 10.0,
        node_padding: 12.0,
        label_height: 0.0,
        alignment,
    }
}

#[test]
fn sankey_layout_alignments_proportions_crossings_and_cycles() {
    let shape = [("a", "b", 4.0), ("b", "c", 3.0), ("c", "d", 3.0), ("x", "d", 2.0), ("a", "y", 1.0)];
    let layers_of = |alignment: Alignment| -> HashMap<String, usize> {
        let db = build_sankey(&shape);
        let lay = layout_sankey(&db, layout_opts(alignment)).unwrap();
        db.nodes.iter().enumerate().map(|(i, n)| (n.id.clone(), lay.nodes[i].layer)).collect()
    };
    let left = layers_of(Alignment::Left);
    assert_eq!((left["a"], left["b"], left["c"], left["d"], left["x"], left["y"]), (0, 1, 2, 3, 0, 1));
    let just = layers_of(Alignment::Justify);
    assert_eq!((just["x"], just["y"]), (0, 3));
    let right = layers_of(Alignment::Right);
    assert_eq!((right["x"], right["y"]), (2, 3));
    let center = layers_of(Alignment::Center);
    assert_eq!((center["x"], center["y"]), (2, 1));

    // Spread columns & proportional heights.
    let db_prop = build_sankey(&[("a", "b", 30.0), ("a", "c", 10.0), ("b", "d", 30.0)]);
    let lay = layout_sankey(&db_prop, layout_opts(Alignment::Justify)).unwrap();
    assert_eq!(lay.nodes[0].value, 40.0);
    assert_close(lay.nodes[0].height, 388.0, 1e-4);
    assert_close(lay.nodes[1].height / lay.nodes[2].height, 3.0, 1e-4);
    assert_close(lay.links[0].thickness / lay.links[1].thickness, 3.0, 1e-4);
    assert_close(lay.links[0].thickness + lay.links[1].thickness, lay.nodes[0].height, 1e-4);

    // Crossing reduction reorders column.
    let db_cross = build_sankey(&[("a", "low", 1.0), ("b", "high", 1.0), ("root", "high", 0.1), ("root", "low", 0.1)]);
    let lay_c = layout_sankey(&db_cross, layout_opts(Alignment::Justify)).unwrap();
    let s0 = lay_c.nodes[lay_c.links[0].source].y - lay_c.nodes[lay_c.links[1].source].y;
    let t0 = lay_c.nodes[lay_c.links[0].target].y - lay_c.nodes[lay_c.links[1].target].y;
    assert_eq!(s0.signum(), t0.signum());

    // Thin node label headroom.
    let mut rows = vec![("big", "t", 1000.0)];
    let thin_names: Vec<String> = (0..8).map(|i| format!("thin{i}")).collect();
    for name in &thin_names {
        rows.push((name.as_str(), "t", 1.0));
    }
    let roomy = layout_sankey(
        &build_sankey(&rows),
        LayoutOptions {
            node_padding: 2.0,
            label_height: 16.0,
            ..layout_opts(Alignment::Justify)
        },
    )
    .unwrap();
    let mut ys: Vec<f64> = std::iter::once(&roomy.nodes[0])
        .chain(roomy.nodes[2..].iter())
        .map(|n| n.y + n.height / 2.0)
        .collect();
    ys.sort_by(f64::total_cmp);
    for w in ys.windows(2) {
        assert!(w[1] - w[0] >= 16.0 - 1e-5);
    }

    // Cycles rejected with semantic error naming a node on the cycle.
    let err_self = layout_sankey(&build_sankey(&[("a", "a", 1.0)]), layout_opts(Alignment::Justify)).unwrap_err();
    assert_eq!(err_self.code, ErrorCode::Semantic);
    let err_cyc = layout_sankey(
        &build_sankey(&[("s", "a", 1.0), ("a", "b", 1.0), ("b", "c", 1.0), ("c", "a", 1.0), ("c", "tail", 1.0)]),
        layout_opts(Alignment::Justify),
    )
    .unwrap_err();
    assert!(
        err_cyc.message.contains("circular links")
            && (err_cyc.message.contains("\"a\"") || err_cyc.message.contains("\"b\"") || err_cyc.message.contains("\"c\""))
    );

    // Non-positive and huge values remain finite.
    let weird = build_sankey(&[
        ("a", "b", f64::NAN),
        ("a", "c", -5.0),
        ("a", "d", f64::INFINITY),
        ("b", "e", 0.0),
        ("x", "y", 1e308),
        ("x", "z", 1e308),
    ]);
    let lay_w = layout_sankey(&weird, layout_opts(Alignment::Justify)).unwrap();
    for node in &lay_w.nodes {
        assert!(node.x.is_finite() && node.y.is_finite() && node.height.is_finite());
    }
    assert_eq!(lay_w.nodes[0].value, 0.0);
    assert!(layout_sankey(&SankeyModel::new(), layout_opts(Alignment::Justify)).unwrap().nodes.is_empty());
}

#[test]
fn sankey_rendering_options_gradients_labels_and_unicode() {
    let res = render(BASIC, &css_options()).unwrap();
    assert_eq!(res.diagram_type, DiagramType::Sankey);
    assert!(supports("sankey\na,b,1"));
    assert!(supports("sankey-beta\na,b,1"));
    assert_eq!((res.width, res.height), (616.0, 416.0));
    assert_eq!(res.svg.matches(r#"class="pele-sankey-node""#).count(), 4);
    assert_eq!(res.svg.matches(r#"class="pele-sankey-link""#).count(), 4);
    assert_eq!(res.svg.matches(r#"class="pele-label""#).count(), 4);
    assert!(res.svg.contains(r#"data-id="a-&gt;b""#));
    assert!(res.svg.contains("<title>a → b: 5</title>"));
    assert_eq!(node_attr(&res.svg, "a", "fill"), "var(--pele-series-1,#4c78a8)");
    assert_eq!(node_attr(&res.svg, "d", "fill"), "var(--pele-series-4,#e45756)");
    assert!(res.svg.contains(r#">a <tspan class="pele-sankey-value" fill="var(--_m)">8</tspan><"#));
    assert!(res.svg.contains(">5.24</tspan>"));

    // Resolved light & dark + gradients with idPrefix parse cleanly in resvg/usvg.
    let light = render(BASIC, &resolved_options()).unwrap();
    assert_inert_resolved(&light.svg, "sankey light");
    assert_resvg_parses(&light.svg, "sankey light");
    let dark = render(BASIC, &dark_options()).unwrap();
    assert_inert_resolved(&dark.svg, "sankey dark");
    assert_resvg_parses(&dark.svg, "sankey dark");

    // Gradients with valid idPrefix in both CSS and Resolved modes!
    let grad_css = render(
        BASIC,
        &RenderOptions {
            id_prefix: Some("p1".to_string()),
            ..css_options()
        },
    )
    .unwrap()
    .svg;
    assert_well_formed(&grad_css).unwrap();
    assert_eq!(grad_css.matches("<linearGradient ").count(), 4);
    assert!(grad_css.contains("fill=\"url(#p1-sankey-"));
    let grad_resolved = render(
        BASIC,
        &RenderOptions {
            id_prefix: Some("p1".to_string()),
            ..resolved_options()
        },
    )
    .unwrap()
    .svg;
    assert_well_formed(&grad_resolved).unwrap();
    assert!(!grad_resolved.contains("var(--"));
    assert_resvg_parses(&grad_resolved, "sankey gradient resolved");

    // Unsafe idPrefix falls back to flat fill.
    for bad_prefix in ["p\"1", "p)1", "p 1", ""] {
        let s = render(
            BASIC,
            &RenderOptions {
                id_prefix: Some(bad_prefix.to_string()),
                ..css_options()
            },
        )
        .unwrap()
        .svg;
        assert!(!s.contains("<defs") && !s.contains("url("));
    }

    // Custom prefix/suffix, showValues: false, outlined labels, nodeColors, linkColor.
    let money = render(&configured("prefix: \"$\"\nsuffix: \" M\"", BASIC), &css_options()).unwrap().svg;
    assert!(money.contains(">$8 M</tspan>"));
    assert!(money.contains("<title>a → b: $5 M</title>"));
    let hidden = render(&configured("showValues: false", BASIC), &css_options()).unwrap().svg;
    assert!(!hidden.contains("pele-sankey-value"));
    assert!(hidden.contains(">a</text>"));
    let outlined = render(&configured("labelStyle: outlined", BASIC), &resolved_options()).unwrap();
    assert!(outlined.width > 616.0);
    assert_resvg_parses(&outlined.svg, "sankey outlined");

    let node_colors = render(
        &configured("nodeColors:\n  a: \"#123456\"\n  b: \"url(#x)\"", BASIC),
        &RenderOptions {
            id_prefix: Some("p_1".to_string()),
            ..css_options()
        },
    )
    .unwrap()
    .svg;
    assert!(node_colors.contains(r##"<stop offset="0" stop-color="#123456"/><stop offset="1" stop-color="var(--pele-series-2,#f58518)"/>"##));
    assert!(!node_colors.contains("url(#x)"));

    // Adjacent-column label avoidance & label shrinking in crowded charts.
    let funnel = "sankey-beta
Visitors,Signed up,3200
Visitors,Bounced,9800
Signed up,Opened a folder,2100
Signed up,Never returned,1100
Opened a folder,Ran Agency,1450
Opened a folder,Write-only,650
Ran Agency,Upgraded to Pro,380
Ran Agency,Stayed free,1070
Upgraded to Pro,Upgraded to Team,96
Upgraded to Pro,Stayed on Pro,284";
    let funnel_svg = render(
        funnel,
        &RenderOptions {
            max_width: Some(664.0),
            ..css_options()
        },
    )
    .unwrap()
    .svg;
    let re_lbl = Regex::new(r#"data-id="([^"]+)"><text x="([\d.]+)" y="([\d.]+)" text-anchor="([^"]+)""#).unwrap();
    let bounds = |id: &str, val: usize| -> (f64, f64, f64) {
        let cap = re_lbl.captures_iter(&funnel_svg).find(|c| &c[1] == id).unwrap();
        let w = METRICS_MEASURER.width(&format!("{id} {val}"), 14.0, TextStyle::NONE);
        let x: f64 = cap[2].parse().unwrap();
        let y: f64 = cap[3].parse().unwrap();
        let left = if &cap[4] == "end" { x - w } else { x };
        (left, left + w, y)
    };
    let a = bounds("Opened a folder", 2100);
    let b = bounds("Ran Agency", 1450);
    assert!(a.1 <= b.0 || b.1 <= a.0 || (a.2 - b.2).abs() >= 14.0 * 1.5);

    // Unicode names, CSV escaping, entity decoding, and invalid XML rejection.
    for (from, to) in [
        ("Доход", "Расходы"),
        ("Café", "München"),
        ("収入", "支出"),
        ("☀️", "🏠"),
        ("Cafe\u{0301}", "Cafe\u{0300}"),
    ] {
        let src = format!("sankey\n\"{from}\",\"{to}\",100\n");
        let r = render(&src, &resolved_options()).unwrap();
        assert_inert_resolved(&r.svg, &src);
        assert_resvg_parses(&r.svg, &src);
        assert!(r.svg.contains(&format!(r#"data-id="{from}""#)));
    }
    let decoded = render("sankey\n\"Доход #35; #amp; #34;чистый#34;\",Расходы,1\n", &css_options()).unwrap().svg;
    assert!(decoded.contains(">Доход # &amp; &quot;чистый&quot; <tspan"));
    assert!(!decoded.contains("ﬂ°"));

    // Circular links parse ok, fail at render time.
    assert_eq!(
        parse("sankey\na,b,1\nb,a,1\n", &ParseOptions::default()).unwrap().diagram_type,
        DiagramType::Sankey
    );
    let cyc = render("sankey\na,b,1\nb,c,1\nc,a,1\n", &css_options()).unwrap_err();
    assert_eq!(cyc.code, ErrorCode::Semantic);
    assert!(cyc.message.contains("circular links"));

    // Numeric prefix values & exact error line/column tracking through blank lines & row-edge spaces.
    assert!(
        render("sankey\na,b,50%\nb,c, 2e1 kWh\n", &css_options())
            .unwrap()
            .svg
            .contains("<title>b → c: 20</title>")
    );
    let err_blank = parse("sankey\n\na,b,1\n\nb,c,abc", &ParseOptions::default()).unwrap_err();
    assert_eq!((err_blank.line, err_blank.column), (5, 5));
    let err_edge1 = parse("sankey \n\t a,b,1 \n  \n \tb,c,abc ", &ParseOptions::default()).unwrap_err();
    assert_eq!((err_edge1.line, err_edge1.column), (4, 7));
    let err_edge2 = parse("sankey\n \"a \n b\", c ,x", &ParseOptions::default()).unwrap_err();
    assert_eq!((err_edge2.line, err_edge2.column), (3, 9));
    let err_edge3 = parse("sankey\n a,b,1 \n c,d", &ParseOptions::default()).unwrap_err();
    assert_eq!((err_edge3.line, err_edge3.column), (3, 5));

    // Invalid XML entity rejected.
    for entity in ["#65534;", "#65535;", "&#65534;", "#1;"] {
        let err = parse(&format!("sankey\na{entity},b,1\n"), &ParseOptions::default()).unwrap_err();
        assert!(err.message.contains("Invalid XML character in node name"), "got: {}", err.message);
    }

    // Real upstream energy.csv parses and renders cleanly in resvg!
    let csv_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sankey-energy.csv");
    let csv = std::fs::read_to_string(csv_path).unwrap();
    let energy = render(&format!("sankey-beta\n\n {csv}"), &resolved_options()).unwrap();
    assert_inert_resolved(&energy.svg, "energy.csv");
    assert_resvg_parses(&energy.svg, "energy.csv");
    assert!(energy.svg.matches(r#"class="pele-sankey-node""#).count() > 30);

    // Issue #7528 sample (sankey.spec.ts).
    let sample = parse(
        "sankey-beta
      Agricultural 'waste',Bio-conversion,124.729
      Bio-conversion,Liquid,0.597
      Bio-conversion,Losses,26.862
      Bio-conversion,Solid,280.322
      Bio-conversion,Gas,81.144
      Biofuel imports,Liquid,35
      Biomass imports,Solid,35
      Coal imports,Coal,11.606
      Coal reserves,Coal,63.965
      Coal,Solid,75.571
      District heating,Industry,10.639
      District heating,Heating and cooling - homes,22.505
      District heating,Heating and cooling - commercial,46.184
      Electricity grid,Over generation / exports,104.453
      Electricity grid,Lighting & appliances - commercial,113.726
      Electricity grid,Lighting & appliances - homes,27.14",
        &ParseOptions::default(),
    )
    .unwrap();
    match sample.model {
        ParsedModel::Sankey(m) => {
            assert_eq!(m.nodes.len(), 19);
            assert_eq!(m.links.len(), 16);
        }
        other => panic!("expected Sankey, got {other:?}"),
    }
}

#[test]
fn sankey_corpus_hostile_and_fuzz_are_inert_and_resvg_safe() {
    let corpus = load_fixture("sankey-corpus.json");
    assert_eq!(corpus.len(), 19);
    let mut rendered_corpus = 0usize;
    for src in &corpus {
        if let Ok(r) = render(src, &css_options()) {
            assert_inert(&r.svg, src);
            rendered_corpus += 1;
        }
        if let Ok(r) = render(src, &resolved_options()) {
            assert_inert_resolved(&r.svg, src);
            assert_resvg_parses(&r.svg, src);
        }
        if let Ok(r) = render(src, &dark_options()) {
            assert_inert_resolved(&r.svg, src);
            assert_resvg_parses(&r.svg, src);
        }
    }
    assert!(rendered_corpus >= 8, "rendered_corpus={rendered_corpus}");

    let body = "a,b,2\nb,c,1\n";
    let mut rendered_hostile = 0usize;
    for &p in PAYLOADS {
        let q = format!("\"{}\"", p.replace('"', "\"\""));
        let j = serde_json::to_string(p).unwrap();
        let templates = [
            format!("sankey\n{q},b,1\n{body}"),
            format!("sankey\na,{q},1\n{q},c,2\n"),
            format!("---\ntitle: {j}\n---\nsankey\n{body}"),
            format!("---\nconfig:\n  sankey:\n    prefix: {j}\n    suffix: {j}\n    linkColor: {j}\n---\nsankey\n{body}"),
            format!("---\nconfig:\n  sankey:\n    nodeColors:\n      a: {j}\n---\nsankey\n{body}"),
            format!("---\nconfig:\n  sankey:\n    nodeAlignment: {j}\n    labelStyle: {j}\n---\nsankey\n{body}"),
        ];
        for src in templates {
            if let Ok(r) = render(&src, &css_options()) {
                assert_inert(&r.svg, &src);
                rendered_hostile += 1;
            }
            if let Ok(r) = render(&src, &resolved_options()) {
                assert_inert_resolved(&r.svg, &src);
                assert_resvg_parses(&r.svg, &src);
            }
        }
    }
    assert!(rendered_hostile > 200, "rendered_hostile={rendered_hostile}");

    let mut frags: Vec<&str> = PAYLOADS.to_vec();
    frags.extend_from_slice(&["\"", "\"\"", ",", "\n", "a,b,1", "1e308", "-1", "NaN", "sankey\n", "linkColor: ", "prefix: "]);
    let mut mutator = Mutator::new(&corpus, frags, 3);
    for _ in 0..1000 {
        let src = mutator.next_sample();
        if src.len() <= 4000 {
            if let Ok(r) = render(&src, &css_options()) {
                assert_inert(&r.svg, &src);
            }
            if let Ok(r) = render(&src, &resolved_options()) {
                assert_inert_resolved(&r.svg, &src);
            }
        }
    }
}

#[test]
fn sankey_worst_cases_stay_linear() {
    let big = RenderOptions {
        limit: Some(usize::MAX),
        ..css_options()
    };
    let n = 50_000usize;
    let started = Instant::now();
    let _ = prepare_text_for_parsing(&format!("sankey\na,b,1{}x", " ".repeat(n)), None);
    let _ = prepare_text_for_parsing(&format!("sankey\n{}a,b,1", "\r\n".repeat(n / 2)), None);
    let _ = tokenize(&format!("sankey\n\"{}\",b,1", "\"\"".repeat(n / 2)));
    let _ = tokenize(&format!("sankey\n{}\t", "x".repeat(n)));
    assert!(started.elapsed().as_millis() < 2000);

    let chain: String = (0..4000).map(|i| format!("{i},{},1\n", i + 1)).collect();
    let star: String = (0..3000).map(|i| format!("c,t{i},{}\n", i + 1)).collect();
    let cycle: String = (0..4000).map(|i| format!("{i},{},1\n", (i + 1) % 4000)).collect();
    for src in [
        format!("sankey\n{chain}"),
        format!("sankey\n{star}"),
        format!("sankey\n{cycle}"),
        format!("sankey\n{}", "a,b,1\n".repeat(4000)),
        format!("sankey\n\"{}\",b,1", "line\n".repeat(5000)),
    ] {
        let t = Instant::now();
        let _ = render(&src, &big);
        assert!(t.elapsed().as_millis() < 2000);
    }
    let over = render(&format!("sankey\n{}", "a,b,1\n".repeat(10_000)), &css_options()).unwrap_err();
    assert_eq!(over.code, ErrorCode::Limit);
}
