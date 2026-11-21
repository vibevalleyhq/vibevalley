mod support;

use std::collections::HashMap;
use std::time::Instant;

use regex::Regex;
use vibevalley_pele::detect::DiagramType;
use vibevalley_pele::diagram::mindmap::MindmapModel;
use vibevalley_pele::diagram::mindmap::outline::NodeShape;
use vibevalley_pele::diagram::mindmap::parser::tokenize;
use vibevalley_pele::{METRICS_MEASURER, MathSvg, ParseOptions, ParsedModel, RenderOptions, TextMeasurer, TextStyle, parse, render, supports};

use support::{
    Lcg, Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, assert_well_formed, css_options, dark_options, load_fixture,
    resolved_options,
};

struct BoxRect {
    id: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn boxes(svg: &str) -> Vec<BoxRect> {
    let re = Regex::new(
        r#"<g class="pele-node[^"]*" data-id="([^"]*)" transform="translate\(([-\d.]+),([-\d.]+)\)"><rect x="[-\d.]+" y="[-\d.]+" width="([\d.]+)" height="([\d.]+)""#,
    )
    .unwrap();
    re.captures_iter(svg)
        .map(|c| BoxRect {
            id: c[1].to_string(),
            x: c[2].parse().unwrap(),
            y: c[3].parse().unwrap(),
            w: c[4].parse().unwrap(),
            h: c[5].parse().unwrap(),
        })
        .collect()
}

fn mindmap_model(src: &str) -> MindmapModel {
    match parse(src, &ParseOptions::default()).unwrap().model {
        ParsedModel::Mindmap(m) => m,
        other => panic!("expected MindmapModel, got {other:?}"),
    }
}

fn check_both(src: &str, id_prefix: Option<&str>, font_family: Option<&str>) -> bool {
    let icon_fn = |_name: &str| Some(r#"<path d="M0,0"/>"#.to_string());
    let mut css = css_options();
    css.icons = Some(&icon_fn);
    css.id_prefix = id_prefix.map(str::to_string);
    css.font_family = font_family.map(str::to_string);
    let ok = match render(src, &css) {
        Ok(r) => {
            assert_inert(&r.svg, src);
            true
        }
        Err(_) => false,
    };

    let mut res = resolved_options();
    res.icons = Some(&icon_fn);
    res.id_prefix = id_prefix.map(str::to_string);
    res.font_family = font_family.map(str::to_string);
    if let Ok(r) = render(src, &res) {
        assert_inert_resolved(&r.svg, src);
        assert_resvg_parses(&r.svg, src);
    }
    ok
}

#[test]
fn mindmap_renders_shapes_colors_balancing_non_overlap_and_narrow_mode() {
    let basic = render("mindmap\n  root((Center))\n    A\n      A1\n      A2\n    B", &css_options()).unwrap();
    assert_eq!(basic.diagram_type, DiagramType::Mindmap);
    assert!(supports("mindmap\n  root"));
    assert!(basic.links.is_empty());
    assert_eq!(basic.svg.matches(r#"class="pele-node"#).count(), 5);
    assert_eq!(basic.svg.matches(r#"class="pele-edge""#).count(), 4);
    for text in ["Center", "A", "A1", "A2", "B"] {
        assert!(basic.svg.contains(&format!(">{text}</text>")));
    }
    assert!(basic.svg.contains(r#"data-id="root""#));

    let light = render("mindmap\n  root((Center))\n    A\n      A1\n      A2\n    B", &resolved_options()).unwrap();
    assert_inert_resolved(&light.svg, "mindmap light");
    assert_resvg_parses(&light.svg, "mindmap light");
    let dark = render("mindmap\n  root((Center))\n    A\n      A1\n      A2\n    B", &dark_options()).unwrap();
    assert_inert_resolved(&dark.svg, "mindmap dark");
    assert_resvg_parses(&dark.svg, "mindmap dark");

    // All delimiter shapes + asymmetric pairs
    let shapes = render(
        "mindmap\n  root\n    a[Square]\n    b(Rounded)\n    c((Circle))\n    d))Bang((\n    e)Cloud(\n    f{{Hexagon}}\n    Plain",
        &css_options(),
    )
    .unwrap();
    for shape in ["stadium pele-root", "rect", "rounded", "circle", "bang", "cloud", "hex", "text"] {
        assert!(
            shapes.svg.contains(&format!(r#"class="pele-node pele-shape-{shape}""#)),
            "missing shape {shape}"
        );
    }
    let asym = mindmap_model("mindmap\n  root\n    a[x)\n    b(x]\n    c(-x-)\n    -)x(-").nodes;
    let asym_shapes: Vec<NodeShape> = asym.iter().map(|n| n.shape).collect();
    assert_eq!(
        asym_shapes,
        vec![NodeShape::Default, NodeShape::Rect, NodeShape::Cloud, NodeShape::Default, NodeShape::Default]
    );

    // Branch coloring & neutral root
    let colored = render("mindmap\n  [root]\n    [a]\n      [a1]\n    [b]\n    [c]", &css_options()).unwrap().svg;
    assert!(
        Regex::new(r#"pele-root" data-id="root"[^>]*><rect[^>]*stroke="var\(--_b\)""#)
            .unwrap()
            .is_match(&colored)
    );
    assert!(
        Regex::new(r#"class="pele-branch pele-section-0"><g class="pele-edges" fill="none" stroke="var\(--pele-series-1,"#)
            .unwrap()
            .is_match(&colored)
    );
    assert!(
        Regex::new(r#"data-id="a1"[^>]*><rect[^>]*fill="var\(--pele-series-1,[^"]*\)" fill-opacity="0.22" stroke="var\(--pele-series-1,"#)
            .unwrap()
            .is_match(&colored)
    );
    assert!(
        Regex::new(r#"data-id="b"[^>]*><rect[^>]*fill="var\(--pele-series-2,[^"]*\)" fill-opacity="0.22" stroke="var\(--pele-series-2,"#)
            .unwrap()
            .is_match(&colored)
    );
    assert!(
        Regex::new(r#"data-id="c"[^>]*><rect[^>]*fill="var\(--pele-series-3,[^"]*\)" fill-opacity="0.22" stroke="var\(--pele-series-3,"#)
            .unwrap()
            .is_match(&colored)
    );
    let pill = render("mindmap\n  root\n    a\n      b", &css_options()).unwrap().svg;
    assert!(
        Regex::new(r#"pele-shape-branch" data-id="a"[^>]*><rect[^>]*fill-opacity="0.22" stroke="var\(--pele-series-1,"#)
            .unwrap()
            .is_match(&pill)
    );

    // Section numbers wrap after 11 branches
    let sec_src = format!("mindmap\n  root\n{}", (0..13).map(|i| format!("    b{i}\n      leaf{i}\n")).collect::<String>());
    let sec_nodes = mindmap_model(&sec_src).nodes;
    assert_eq!(sec_nodes.iter().find(|n| n.node_id == "b10").unwrap().section, Some(10));
    assert_eq!(sec_nodes.iter().find(|n| n.node_id == "b11").unwrap().section, Some(0));
    assert_eq!(sec_nodes.iter().find(|n| n.node_id == "leaf12").unwrap().section, Some(1));
    assert_eq!(sec_nodes[0].section, None);

    // Two-sided balanced placement
    let bal_svg = render(
        "mindmap\n  [root]\n    [a]\n      [a1]\n      [a2]\n      [a3]\n    [b]\n    [c]\n    [d]",
        &css_options(),
    )
    .unwrap()
    .svg;
    let all = boxes(&bal_svg);
    let at = |id: &str| all.iter().find(|b| b.id == id).unwrap();
    assert!(at("a").x > at("root").x);
    assert!(at("a1").x > at("a").x);
    for id in ["b", "c", "d"] {
        assert!(at(id).x < at("root").x);
    }
    assert!(at("a1").y < at("a2").y);
    assert!((at("a2").y - at("a").y).abs() < 0.05);
    assert!(at("b").y < at("c").y);
    assert!((at("c").y - at("root").y).abs() < 0.05);

    let single = boxes(&render("mindmap\n  [root]\n    [a]\n      [b]", &css_options()).unwrap().svg);
    let s_ids: Vec<&str> = single.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(s_ids, vec!["a", "b", "root"]);
    assert!(single[2].x < single[0].x && single[0].x < single[1].x);

    // Tie stability
    let start = "mindmap\n  [root]\n    [Build]\n      [Prototype]\n      [Iterate]\n    [Review]\n      [Test]\n      [Refine]";
    for tail in [
        "",
        "\n    [Ship]",
        "\n    [Ship]\n      [Launch]",
        "\n    [Ship]\n      [Launch]\n      [Learn]",
    ] {
        let all = boxes(&render(&format!("{start}{tail}"), &css_options()).unwrap().svg);
        let x = |id: &str| all.iter().find(|b| b.id == id).unwrap().x;
        assert!(x("Build") > x("root"));
        assert!(x("Review") < x("root"));
        if !tail.is_empty() {
            assert!(x("Ship") < x("root"));
        }
    }

    // 30 random mindmaps never overlap nodes
    let mut rnd = Lcg::new(11);
    for _round in 0..30 {
        let mut src = String::from("mindmap\n[n0]\n");
        let mut depth = 1usize;
        let count = 2 + rnd.next_usize(60);
        for i in 1..count {
            depth = 1.max((depth + 1).min(1 + rnd.next_usize(depth + 1)));
            let label = "word ".repeat(1 + rnd.next_usize(12)).trim().to_string();
            src.push_str(&format!("{}n{i}[{label}]\n", " ".repeat(depth)));
        }
        let all = boxes(&render(&src, &css_options()).unwrap().svg);
        assert_eq!(all.len(), count);
        for i in 0..all.len() {
            for j in (i + 1)..all.len() {
                let a = &all[i];
                let b = &all[j];
                let apart = (a.x - b.x).abs() >= (a.w + b.w) / 2.0 - 1e-6 || (a.y - b.y).abs() >= (a.h + b.h) / 2.0 - 1e-6;
                assert!(apart, "{} and {} overlapped in {src:?}", a.id, b.id);
            }
        }
    }

    // Unclear indentation parent rules
    let ind_nodes = mindmap_model("mindmap\nRoot\n    A\n        B\n      C\n   D").nodes;
    let a_kids: Vec<&str> = ind_nodes[1].children.iter().map(|&idx| ind_nodes[idx].node_id.as_str()).collect();
    let r_kids: Vec<&str> = ind_nodes[0].children.iter().map(|&idx| ind_nodes[idx].node_id.as_str()).collect();
    let levels: Vec<isize> = ind_nodes.iter().map(|n| n.level).collect();
    assert_eq!(a_kids, vec!["B", "C"]);
    assert_eq!(r_kids, vec!["A", "D"]);
    assert_eq!(levels, vec![0, 4, 8, 6, 3]);

    // Second root error
    let err2 = render("mindmap\n  root\n  other", &css_options()).unwrap_err();
    assert!(err2.message.contains(r#"There can be only one root. No parent could be found for ("other")"#));
    assert!(
        render("mindmap\n    root\n  shallower", &css_options())
            .unwrap_err()
            .message
            .contains("only one root")
    );

    // Decoration before root ignored
    assert!(
        render("mindmap\n::icon(fa fa-book)\n:::big\nroot", &css_options())
            .unwrap()
            .svg
            .contains(">root</text>")
    );

    // Icons and classes
    let icon_src = "mindmap\n  root\n    A\n    ::icon(fa fa-book)\n    :::urgent large\n    B";
    let plain = render(icon_src, &css_options()).unwrap();
    assert!(plain.svg.contains(r#"class="pele-node pele-shape-text urgent large" data-id="A""#));
    assert!(!plain.svg.contains("pele-icon"));
    assert_eq!(plain.width, render("mindmap\n  root\n    A\n    B", &css_options()).unwrap().width);
    let icon_resolver = |name: &str| (name == "fa fa-book").then(|| r#"<path d="M0,0H24"/>"#.to_string());
    let drawn = render(
        icon_src,
        &RenderOptions {
            icons: Some(&icon_resolver),
            ..css_options()
        },
    )
    .unwrap();
    assert!(drawn.svg.contains(r#"<svg class="pele-icon" data-icon="fa fa-book""#));
    assert!(drawn.svg.contains(r#"stroke-linejoin="round"><path d="M0,0H24"/></svg>"#));
    assert!(drawn.width > plain.width);

    // Markdown & <br/>
    let md = render(
        "mindmap\n  id1[\"`**Root** with\na second line`\"]\n    id2[One<br/>Two]\n    id3[*emphasis*]",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(md.contains(r#" font-weight="var(--_w)">Root</tspan><tspan> with</tspan>"#));
    assert!(md.contains("a second line"));
    assert!(Regex::new(r">One</tspan><tspan[^>]*>Two<").unwrap().is_match(&md));
    assert!(
        Regex::new(r#"<text[^>]* font-style="italic"[^>]*><tspan[^>]*>emphasis<"#)
            .unwrap()
            .is_match(&md)
    );

    // maxNodeWidth
    let long_body = format!("mindmap\n  root[{}]", "several words that go on ".repeat(4));
    let normal = render(&long_body, &css_options()).unwrap();
    let narrow_node = render(&format!("---\nconfig:\n  mindmap:\n    maxNodeWidth: 80\n---\n{long_body}"), &css_options()).unwrap();
    assert!(normal.width < 260.0);
    assert!(narrow_node.width < normal.width);
    assert!(narrow_node.height > normal.height);

    // Trailing comments in shaped vs bare nodes
    assert_eq!(mindmap_model("mindmap\n  root(Root) %% note\n    a").nodes[0].descr, "Root");
    assert_eq!(mindmap_model("mindmap\n  root %% note\n    a").nodes[0].descr, "root %% note");

    // Front matter title & empty/root-only
    let plain_t = render("mindmap\n  root\n    A", &css_options()).unwrap();
    let titled = render("---\ntitle: Plans\n---\nmindmap\n  root\n    A", &css_options()).unwrap();
    assert!(titled.svg.contains(r#"class="pele-title" font-weight="var(--_tw)""#));
    assert!(titled.svg.contains(">Plans<"));
    assert!(titled.height > plain_t.height);
    assert!(render("mindmap\n\n", &css_options()).unwrap().svg.contains("<svg"));
    assert_eq!(render("mindmap\nroot", &css_options()).unwrap().svg.matches(r#"class="pele-node"#).count(), 1);

    // Branch pill vs leaf plain text & near-edge alignment
    let lvl = render(
        "mindmap\n  root\n    Plan\n      Research\n        Read\n        Ask\n      Build\n    Ship",
        &css_options(),
    )
    .unwrap()
    .svg;
    let re_kind = Regex::new(r#"class="pele-node pele-shape-(\w+)[^"]*" data-id="([^"]*)""#).unwrap();
    let kinds: HashMap<&str, &str> = re_kind
        .captures_iter(&lvl)
        .map(|c| (c.get(2).unwrap().as_str(), c.get(1).unwrap().as_str()))
        .collect();
    assert_eq!(kinds.get("Plan"), Some(&"branch"));
    assert_eq!(kinds.get("Research"), Some(&"branch"));
    for leaf in ["Read", "Ask", "Build", "Ship"] {
        assert_eq!(kinds.get(leaf), Some(&"text"), "leaf={leaf}");
    }
    assert!(
        Regex::new(r#"pele-shape-branch" data-id="Plan"[^>]*><rect[^>]* fill="var\(--pele-series-\d,[^"]*\)" fill-opacity="0.22" stroke="var\(--pele-series-\d,[^"]*\)"/>"#)
            .unwrap()
            .is_match(&lvl)
    );
    assert!(Regex::new(r#"pele-shape-text" data-id="Read"[^>]*><text"#).unwrap().is_match(&lvl));
    assert!(!lvl.contains("pele-marker"));

    let re_pos = Regex::new(r#"data-id="([^"]*)" transform="translate\((-?[\d.]+),[^)]*\)""#).unwrap();
    let xs: HashMap<&str, f64> = re_pos
        .captures_iter(&lvl)
        .map(|c| (c.get(1).unwrap().as_str(), c[2].parse().unwrap()))
        .collect();
    let side = (xs["Read"] - xs["Research"]).signum();
    assert_ne!(side, 0.0);
    let read_w = METRICS_MEASURER.width("Read", 16.0, TextStyle::NONE);
    let ask_w = METRICS_MEASURER.width("Ask", 16.0, TextStyle::NONE);
    let near_read = xs["Read"] - (side * (read_w + 12.0)) / 2.0;
    let near_ask = xs["Ask"] - (side * (ask_w + 12.0)) / 2.0;
    assert!((near_read - near_ask).abs() < 0.05);

    // Narrow outline mode & math support
    let wide_map = "mindmap\n  root((Central Hub))\n    Alpha\n      AlphaOne\n      AlphaTwo\n    Beta\n      BetaOne\n      BetaTwo";
    let outline = render(
        wide_map,
        &RenderOptions {
            max_width: Some(320.0),
            ..resolved_options()
        },
    )
    .unwrap();
    assert_inert_resolved(&outline.svg, "mindmap narrow outline");
    assert_resvg_parses(&outline.svg, "mindmap narrow outline");
    assert!(outline.width < render(wide_map, &resolved_options()).unwrap().width);

    let math_fn = |_tex: &str, _sz: f64| {
        Some(MathSvg {
            svg: r#"<path d="M0,0H30V14H0Z"/>"#.to_string(),
            width: 30.0,
            height: 14.0,
        })
    };
    let with_math = render(
        "mindmap\n  root[$$a+b$$]\n    leaf[$$c$$]",
        &RenderOptions {
            math: Some(&math_fn),
            ..resolved_options()
        },
    )
    .unwrap();
    assert!(with_math.svg.contains(r#"class="pele-math""#));
    assert_well_formed(&with_math.svg).unwrap();
    assert!(!with_math.svg.contains("var(--") && !with_math.svg.contains("<foreignObject"));
    assert_resvg_parses(&with_math.svg, "mindmap math");

    // Determinism & finite numbers
    let det_src = "mindmap\n  root((mindmap))\n    Origins\n      Long history\n      ::icon(fa fa-book)\n    Research\n      On effectiveness<br/>and features\n    Tools\n      Pen and paper";
    let first = render(det_src, &css_options()).unwrap().svg;
    assert_eq!(render(det_src, &css_options()).unwrap().svg, first);
    assert!(!first.contains("NaN") && !first.contains("Infinity") && !first.contains("undefined"));
}

#[test]
fn mindmap_is_inert_for_corpus_hostile_and_mutated_inputs() {
    let corpus = load_fixture("mindmap-corpus.json");
    assert!(corpus.len() >= 30);
    let mut corpus_ok = 0usize;
    for src in &corpus {
        if check_both(src, None, None) {
            corpus_ok += 1;
        }
    }
    assert!(corpus_ok > 30, "corpus_ok={corpus_ok}");

    let mut rendered = 0usize;
    for &p in PAYLOADS {
        let templates = [
            format!("mindmap\n  {p}\n    child"),
            format!("mindmap\n  root\n    {p}"),
            format!("mindmap\n  root[{p}]"),
            format!("mindmap\n  root\n    id({p})"),
            format!("mindmap\n  root\n    id(({p}))"),
            format!("mindmap\n  root\n    id)){p}(("),
            format!("mindmap\n  root\n    id){p}("),
            format!("mindmap\n  root\n    id{{{{{p}}}}}"),
            format!("mindmap\n  root\n    {p}[text]"),
            format!("mindmap\n  root\n    {p}((text))"),
            format!("mindmap\n  root[\"{p}\"]\n    [\"{p}\"]"),
            format!("mindmap\n  root[\"`{p}`\"]\n    a[\"`**{p}**\n{p}`\"]"),
            format!("mindmap\n  root\n    a\n    ::icon({p})"),
            format!("mindmap\n  root\n  ::icon({p})\n    a(b)\n    ::icon({p})"),
            format!("mindmap\n  root\n    a\n    :::{p}"),
            format!("mindmap\n  root\n  :::{p}\n    a[b]\n    :::{p} {p}"),
            format!("mindmap\n  root\n    a %% {p}\n    b(c) %% {p}"),
            format!("mindmap\n  root\n    fa:fa-{p} x"),
            format!("mindmap {p}\n  root"),
            format!("---\ntitle: \"{p}\"\n---\nmindmap\n  root\n    a"),
            format!("---\nconfig:\n  mindmap:\n    maxNodeWidth: \"{p}\"\n    padding: \"{p}\"\n---\nmindmap\n  root\n    a"),
            format!("%%{{init: {{\"mindmap\": {{\"maxNodeWidth\": \"{p}\"}}, \"themeVariables\": {{\"fontFamily\": \"{p}\"}}}}}}%%\nmindmap\n  root"),
        ];
        for src in templates {
            if check_both(&src, None, None) {
                rendered += 1;
            }
        }
    }
    assert!(rendered > 300, "rendered={rendered}");

    // Escaping text, ids, icons, classes
    let icon_fn = |_name: &str| Some(r#"<path d="M0,0"/>"#.to_string());
    let esc_svg = render(
        "mindmap\n  a<b>\"&[<i onload=x>\"&]\n  ::icon(x\" onload=\"y)\n  :::a\"b <c> d=e",
        &RenderOptions {
            icons: Some(&icon_fn),
            ..css_options()
        },
    )
    .unwrap()
    .svg;
    assert_inert(&esc_svg, "mindmap escape");
    assert!(esc_svg.contains(r#"data-id="a&lt;b&gt;&quot;&amp;""#));
    assert!(esc_svg.contains(r#"data-icon="x&quot; onload=&quot;y""#));
    assert!(esc_svg.contains(r#"class="pele-node pele-shape-rect pele-root a b c d e""#));
    assert!(!esc_svg.contains("<i"));

    for &p in PAYLOADS {
        assert!(check_both("mindmap\n  root\n    a\n    ::icon(x)", Some(p), Some(p)));
    }

    let mut frags: Vec<&str> = PAYLOADS.to_vec();
    frags.extend_from_slice(&[
        "\"", "[", "]", "(", ")", "((", "))", "{{", "}}", "\n", "\n    ", ":::", "::icon(", "\"`", "`\"", "%%",
    ]);
    let mut mutator = Mutator::new(&corpus, frags, 3);
    for _ in 0..2000 {
        let src = mutator.next_sample();
        if src.len() <= 4000 {
            check_both(&src, None, None);
        }
    }
}

#[test]
fn mindmap_stays_fast_and_handles_deep_and_wide_trees_without_overflow() {
    const N: usize = 50_000;
    let big_parse = ParseOptions {
        limit: Some(usize::MAX),
        ..ParseOptions::default()
    };
    let big = RenderOptions {
        limit: Some(usize::MAX),
        output_limit: Some(usize::MAX),
        ..css_options()
    };

    let tok_cases = [
        format!("mindmap\n{}", "(a) ".repeat(N / 4)),
        format!("mindmap\na(b){}x", " ".repeat(N)),
        format!("mindmap\nroot\n{} a", " \n".repeat(N / 2)),
        format!("mindmap\nroot{}", format!("\n{}a", " ".repeat(99)).repeat(N / 100)),
        format!("mindmap\nroot\n{}%", " \t\n".repeat(N / 3)),
        format!("mindmap\nroot\n{}", "%%".repeat(N / 2)),
        format!("mindmap\nroot\n{}", " %% c\n".repeat(N / 6)),
        format!("mindmap\nroot[{}]", "}\n".repeat(N / 2)),
        format!("mindmap\nroot[{}]", "} ".repeat(N / 2)),
        format!("mindmap\nroot[\"{}", "a".repeat(N)),
        format!("mindmap\nroot[\"`{}", "a\n".repeat(N / 2)),
        format!("mindmap\nroot[\"`{}", "a`".repeat(N / 2)),
        format!("mindmap\nroot\n::icon({}", "x\n".repeat(N / 2)),
        format!("mindmap\nroot\n{}", ":::\n".repeat(N / 4)),
        format!("mindmap\n{}", "-)(-".repeat(N / 4)),
        "mindma".repeat(N / 6),
    ];
    for (i, src) in tok_cases.iter().enumerate() {
        let started = Instant::now();
        let _ = tokenize(src);
        assert!(started.elapsed().as_millis() < 3000, "slow mindmap tok #{i}: {:?}", started.elapsed());
    }

    let wide_16k = format!("mindmap\nroot\n{}", " a\n".repeat(16_000));
    let started = Instant::now();
    let _ = parse(&wide_16k, &big_parse).unwrap();
    assert!(started.elapsed().as_millis() < 3000);

    let chain_310: String = (0..310).map(|i| format!("{}n\n", " ".repeat(i))).collect();
    let chain_3000: String = (0..3000).map(|i| format!("{}n\n", " ".repeat(i))).collect();
    let rise_fall: String = (0..2400).map(|i| format!("{}n\n", " ".repeat(1 + (i % 40)))).collect();
    let deep_br: String = (0..160)
        .map(|_| (0..24).map(|i| format!("{}n\n", " ".repeat(1 + i))).collect::<String>())
        .collect();

    let render_cases = [
        wide_16k.clone(),
        format!("mindmap\n{chain_310}"),
        format!("mindmap\n{chain_3000}"),
        format!("mindmap\nroot\n{rise_fall}"),
        format!("mindmap\nroot\n{deep_br}"),
        format!("mindmap\nroot\n{}", " b\n  l\n  l\n".repeat(5_000)),
        format!("mindmap\nroot\n{}", " a((b))\n ::icon(fa fa-x)\n :::c d\n".repeat(1_400)),
        format!("mindmap\nroot[{}]", "word ".repeat(N / 5)),
        format!("mindmap\nroot[{}]", "w".repeat(N)),
        format!("mindmap\nroot[\"`{}`\"]", "*a _b ".repeat(N / 6)),
        format!("mindmap\nroot[{}]", "#35;&amp;<br>".repeat(N / 13)),
        format!("mindmap\nroot\n:::{}", "a ".repeat(N / 2)),
        format!("mindmap\nroot\n::icon({})", "fa ".repeat(N / 3)),
        format!("mindmap\n root\n{} b\n", "  a\n".repeat(16_000)),
    ];
    for (i, src) in render_cases.iter().enumerate() {
        let started = Instant::now();
        let _ = render(src, &big);
        assert!(started.elapsed().as_millis() < 3000, "slow mindmap render #{i}: {:?}", started.elapsed());
    }

    let wide = render(&wide_16k, &big).unwrap();
    assert!(wide.height.is_finite());
    assert_eq!(wide.svg.matches(r#"class="pele-edge""#).count(), 16_000);
    let deep = render(&format!("mindmap\n{chain_3000}"), &big).unwrap();
    assert_eq!(deep.svg.matches(r#"class="pele-node"#).count(), 3_000);
}
