mod support;

use std::collections::HashSet;
use std::time::Instant;

use regex::Regex;
use vibevalley_pele::detect::DiagramType;
use vibevalley_pele::diagram::flowchart::parser::parse_flowchart;
use vibevalley_pele::diagram::flowchart::{FlowDb, FlowDbOptions};
use vibevalley_pele::svg::edges::{Fill, OverFill, over_fills};
use vibevalley_pele::svg::theme::{SvgTheme, ThemeMode, resolve_style};
use vibevalley_pele::{ErrorCode, LinkInfo, ParseOptions, ParsedModel, RenderOptions, parse, render};

use support::{Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, assert_well_formed, css_options, load_fixture, resolved_options};

fn parse_flow(src: &str) -> FlowDb {
    let mut db = FlowDb::new(FlowDbOptions::default());
    parse_flowchart(src, &mut db, None).unwrap();
    db
}

fn try_render_css(src: &str) -> Option<String> {
    match render(src, &css_options()) {
        Ok(r) => Some(r.svg),
        Err(_) => None,
    }
}

fn try_render_resolved(src: &str) -> Option<String> {
    match render(src, &resolved_options()) {
        Ok(r) => Some(r.svg),
        Err(_) => None,
    }
}

fn assert_close(a: f64, b: f64, tol: f64, msg: &str) {
    assert!((a - b).abs() <= tol, "{msg}: {a} vs {b} (tol={tol})");
}

#[test]
fn flowchart_parser_subgraphs_link_style_errors_and_huge_diagram() {
    // Merges repeated subgraph ID.
    let db = parse_flow("flowchart LR\nsubgraph S\n  x\nend\nsubgraph S\n  y\nend");
    assert_eq!(db.subgraphs.len(), 1);
    assert_eq!(db.subgraphs[0].nodes, vec!["x", "y"]);

    // Unnamed subgraph works.
    let db = parse_flow("flowchart TD\nsubgraph\n  a --> b\nend");
    assert_eq!(db.subgraphs.len(), 1);
    assert_eq!(db.subgraphs[0].id, "subGraph0");
    assert_eq!(db.subgraphs[0].nodes, vec!["b", "a"]);

    // Out-of-bounds linkStyle index.
    let mut db = FlowDb::new(FlowDbOptions::default());
    let err = parse_flowchart("graph TD\nA-->B\nlinkStyle 1 stroke-width:1px;", &mut db, None).unwrap_err();
    assert!(
        err.message
            .contains("The index 1 for linkStyle is out of bounds. Valid indices for linkStyle are between 0 and 0."),
        "msg={}",
        err.message
    );

    // Syntax error position.
    let mut db = FlowDb::new(FlowDbOptions::default());
    let err = parse_flowchart("graph TD\nA-->B\nB --> [oops]", &mut db, None).unwrap_err();
    assert_eq!(err.line, 3);
    assert_eq!(err.column, 7);
    assert!(err.message.contains("got 'SQS'"), "msg={}", err.message);

    // Huge 47,917-edge diagram parses quickly.
    let body = format!("{}{}", format!("{}A-->B;", "A-->B;B-->A;".repeat(415)).repeat(57), "A-->B;B-->A;".repeat(275));
    let started = Instant::now();
    let db = parse_flow(&format!("graph LR;{body}"));
    assert_eq!(db.edges[0].edge_type.as_deref(), Some("arrow_point"));
    assert_eq!(db.edges.len(), 47_917);
    assert_eq!(db.nodes.len(), 2);
    assert!(started.elapsed().as_millis() < 2000, "huge flowchart parse took {:?}", started.elapsed());

    // Edge limit enforced.
    let mut db = FlowDb::new(FlowDbOptions {
        max_edges: Some(2),
        ..FlowDbOptions::default()
    });
    let err = parse_flowchart("graph TD\nA-->B-->C-->D", &mut db, None).unwrap_err();
    assert!(err.message.contains("Edge limit exceeded"));
}

#[test]
fn flowchart_renders_full_upstream_corpus_in_css_and_resolved_resvg_modes() {
    let corpus = load_fixture("flowchart-corpus.json");
    let mut rendered = 0usize;
    let re_bad = Regex::new(r"(?i)<script|<style|<foreignObject|\son\w+=|javascript:").unwrap();
    for src in &corpus {
        let Some(svg) = try_render_css(src) else {
            continue;
        };
        rendered += 1;
        let where_ctx = &src[..src.len().min(120)];
        assert_inert(&svg, where_ctx);
        assert!(!re_bad.is_match(&svg), "{where_ctx}: unsafe markup");
        assert!(!svg.contains("NaN"), "{where_ctx}: NaN");
        assert!(!svg.contains("undefined"), "{where_ctx}: undefined");
        assert_eq!(try_render_css(src).as_deref(), Some(svg.as_str()), "determinism");

        let res_svg = try_render_resolved(src).expect("resolved mode failed where css mode succeeded");
        assert_inert_resolved(&res_svg, where_ctx);
        assert_resvg_parses(&res_svg, where_ctx);
    }
    assert!(rendered > 300, "expected >300 rendered flowchart samples, got {rendered}");
}

#[test]
fn flowchart_size_direction_theme_escaping_and_inline_html() {
    let res = render("flowchart LR\n  A --> B", &css_options()).unwrap();
    assert_eq!(res.diagram_type, DiagramType::Flowchart);
    assert!(res.width > 100.0);
    assert!(res.height > 30.0);
    assert!(res.svg.contains(&format!("viewBox=\"0 0 {} {}\"", res.width, res.height)));
    assert!(res.svg.starts_with(r#"<svg xmlns="http://www.w3.org/2000/svg" class="pele pele-flowchart""#));
    for token in ["--pele-bg", "--pele-fg", "--pele-line", "--pele-surface", "--pele-border", "--pele-font"] {
        assert!(res.svg.contains(&format!("var({token},")), "missing {token}");
    }
    assert!(!res.svg.contains("<style"));

    let tall = render("flowchart TD\n  A --> B --> C", &css_options()).unwrap();
    let wide = render("flowchart LR\n  A --> B --> C", &css_options()).unwrap();
    assert!(tall.height > tall.width);
    assert!(wide.width > wide.height);

    // Escaping and literal angle brackets.
    let esc_svg = render("flowchart TD\n  A[\"<img src=x onerror=alert(1)> & more\"]", &css_options())
        .unwrap()
        .svg;
    assert!(!esc_svg.contains("<img"));
    assert!(esc_svg.contains("&amp; more"));
    assert_well_formed(&esc_svg).unwrap();

    assert!(render("flowchart LR\n  A[\"List<T>\"]", &css_options()).unwrap().svg.contains("List&lt;T&gt;"));
    assert!(render("flowchart LR\n  A[\"<T>\"]", &css_options()).unwrap().svg.contains("&lt;T&gt;"));

    // Underline and inline tags.
    let u_svg = render("flowchart LR\n  A[\"a <u>underlined</u> word\"]\n  B[\"<u>all of it</u>\"]", &css_options())
        .unwrap()
        .svg;
    assert!(u_svg.contains(r#"<tspan text-decoration="underline">underlined</tspan>"#));
    assert!(
        Regex::new(r#"<tspan[^>]* text-decoration="underline">all of it</tspan>"#)
            .unwrap()
            .is_match(&u_svg)
    );

    for (tag, attr) in [
        ("cite", r#"font-style="italic""#),
        ("dfn", r#"font-style="italic""#),
        ("var", r#"font-style="italic""#),
        ("kbd", r#"font-family="var(--_fm)""#),
        ("samp", r#"font-family="var(--_fm)""#),
        ("tt", r#"font-family="var(--_fm)""#),
        ("ins", r#"text-decoration="underline""#),
    ] {
        let svg = render(&format!("flowchart LR\n  A[\"plain <{tag}>tagged</{tag}> plain\"]"), &css_options())
            .unwrap()
            .svg;
        assert!(svg.contains(&format!("<tspan {attr}>tagged</tspan>")), "tag={tag}");
    }

    let dropped = render(
        "flowchart LR\n  A[\"<span title=x>red</span> and <small>print</small><img src=x>\"]",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(dropped.contains("red and print"));
    assert!(!Regex::new(r"&lt;(span|small|img)").unwrap().is_match(&dropped));

    let mixed = render("flowchart LR\n  A[\"<b>bold</b> and <T>\"]", &css_options()).unwrap().svg;
    assert!(Regex::new(r#"<tspan[^>]* font-weight="var\(--_w\)">bold</tspan>"#).unwrap().is_match(&mixed));
    assert!(mixed.contains("&lt;T&gt;"));

    // Entities, HTML5 aliases, single decode pass.
    let ent = render("flowchart TD\n  A[\"a #quot;b#quot; #35; #9829;<br/>second line\"]", &css_options())
        .unwrap()
        .svg;
    assert!(ent.contains("a &quot;b&quot; # ♥"));
    assert!(ent.contains("second line"));
    assert_eq!(ent.matches("<tspan").count(), 2);

    let alias = render(
        "flowchart LR\n  A[\"GET /plans/&lcub;id&rcub;\"] --> B[\"items#lsqb;0#rsqb; #verbar; none\"]",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(alias.contains("GET /plans/{id}"));
    assert!(alias.contains("items[0] | none"));

    let once = render("flowchart LR\n  A[\"x #amp;lt; y #38;gt; z\"]", &css_options()).unwrap().svg;
    assert!(once.contains("x &amp;lt; y &amp;gt; z"));

    // Wrapping, markdown, <code>, nested formatting across line breaks, sub/sup.
    let short = render("flowchart TD\n  A[one two]", &css_options()).unwrap();
    let long = render(
        "flowchart TD\n  A[one two three four five six seven eight nine ten eleven twelve]",
        &css_options(),
    )
    .unwrap();
    assert!(long.height > short.height);
    assert!(long.width < 300.0);

    let md = render("flowchart TD\n  A[\"`This **is** _Markdown_`\"]", &css_options()).unwrap().svg;
    assert!(md.contains(r#"<tspan font-weight="var(--_w)">is</tspan>"#));
    assert!(md.contains(r#"<tspan font-style="italic">Markdown</tspan>"#));

    let code_inline = render("flowchart TD\n  A[\"Call <code>render()</code> once\"]", &css_options()).unwrap().svg;
    assert!(
        Regex::new(r#"<tspan[^>]* font-family="var\(--_fm\)">render\(\)</tspan>"#)
            .unwrap()
            .is_match(&code_inline)
    );
    assert!(!code_inline.contains("font-family=\"var(--_fm)\">Call "));

    let code_whole = render("flowchart TD\n  A[\"<code>render()</code>\"]", &css_options()).unwrap().svg;
    assert!(Regex::new(r#"<text[^>]* font-family="var\(--_fm\)""#).unwrap().is_match(&code_whole));
    assert_eq!(code_whole.matches(r#"font-family="var(--_fm)""#).count(), 1);

    let bold_md = render("flowchart TD\n  A[\"`one **two** three`\"]\n  style A font-weight:bold", &css_options())
        .unwrap()
        .svg;
    assert!(!bold_md.contains("**"));
    assert!(bold_md.contains("two"));

    for tag in ["b", "strong", "i", "em"] {
        for br in ["<br/>", "<br>", "<BR />", "\\n", "\n"] {
            let src = format!("flowchart LR\n  A[\"<{tag}>First{br}Second</{tag}> plain{br}Third\"]");
            let reopened = format!("flowchart LR\n  A[\"<{tag}>First</{tag}>{br}<{tag}>Second</{tag}> plain{br}Third\"]");
            assert_eq!(
                render(&src, &css_options()).unwrap().svg,
                render(&reopened, &css_options()).unwrap().svg,
                "{tag} across {br:?}"
            );
        }
    }

    let nested = "flowchart LR\n  A[\"<b><i>First<br/><br/>Second</i> bold</b> plain\"] --> B[plain]";
    let nested_reopened = "flowchart LR\n  A[\"<b><i>First</i></b><br/><br/><b><i>Second</i> bold</b> plain\"] --> B[plain]";
    for suffix in ["", "\n  style A font-weight:bold"] {
        assert_eq!(
            render(&format!("{nested}{suffix}"), &css_options()).unwrap().svg,
            render(&format!("{nested_reopened}{suffix}"), &css_options()).unwrap().svg
        );
    }

    // <sub> and <sup> nesting.
    let subsup = render("flowchart LR\n  A[\"H<sub>2</sub>O\"] --> B[\"x<sup>2</sup>\"]", &css_options())
        .unwrap()
        .svg;
    assert!(Regex::new(r#"<tspan[^>]*baseline-shift="sub"[^>]*>2</tspan>"#).unwrap().is_match(&subsup));
    assert!(Regex::new(r#"<tspan[^>]*baseline-shift="super"[^>]*>2</tspan>"#).unwrap().is_match(&subsup));
    let nested_ss = render("flowchart LR\n  A[\"x<sup>a<sub>b</sub>c</sup>\"]", &css_options()).unwrap().svg;
    assert!(nested_ss.contains(r#"<tspan baseline-shift="super" font-size="smaller">a</tspan>"#));
    assert!(nested_ss.contains(r#"<tspan baseline-shift="sub" font-size="smaller">b</tspan>"#));
    assert!(nested_ss.contains(r#"<tspan baseline-shift="super" font-size="smaller">c</tspan>"#));
    let restore = render("flowchart LR\n  A[\"<sup>a<sub>b<sup>c</sup>d</sub>e</sup>\"]", &css_options())
        .unwrap()
        .svg;
    assert!(restore.contains(r#"<tspan baseline-shift="sub" font-size="smaller">d</tspan><tspan baseline-shift="super" font-size="smaller">e</tspan>"#));
    let across_br = render("flowchart LR\n  A[\"<sup>a<sub>b<br/>c</sub>d</sup>\"]", &css_options()).unwrap().svg;
    assert!(
        Regex::new(r#"<tspan x="0" y="[\d.-]+" baseline-shift="sub" font-size="smaller">c</tspan><tspan baseline-shift="super" font-size="smaller">d</tspan>"#)
            .unwrap()
            .is_match(&across_br)
    );
}

#[test]
fn flowchart_styles_contrast_casings_links_and_subgraphs() {
    let styled = render(
        "flowchart TD\n  A --> B\n  style A fill:#f9f,stroke:#333,stroke-width:4px,color:#fff\n  classDef warn fill:#ff0\n  class B warn\n  linkStyle 0 stroke:#f00,stroke-width:3px",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(styled.contains(r#"style="rx:var(--_r);fill:#f9f;stroke:#333;stroke-width:4px;""#));
    assert!(styled.contains(r#"style="fill:#fff;""#));
    assert!(Regex::new(r#"class="pele-node pele-shape-rect warn" data-id="B""#).unwrap().is_match(&styled));
    assert!(styled.contains(r#"style="stroke:#f00;stroke-width:3px;""#));
    assert!(styled.contains(r##"fill="#f00""##));

    // Subgraph fill full opacity when author sets fill.
    let sub_fill = render(
        "flowchart LR\n  subgraph S\n    A\n  end\n  subgraph T\n    B\n  end\n  style S fill:#BBDEFB",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(
        Regex::new(r#"data-id="S"><rect [^>]*fill="var\(--_a\)" stroke="var\(--_b\)" style="[^"]*fill:#BBDEFB;"#)
            .unwrap()
            .is_match(&sub_fill)
    );
    assert!(
        Regex::new(r#"data-id="T"><rect [^>]*fill="var\(--_a\)" fill-opacity="0\.5""#)
            .unwrap()
            .is_match(&sub_fill)
    );

    // Contrasting label ink on styled fills.
    let contrast_src = "flowchart LR\n  subgraph S[\"Cluster\"]\n    A[Start] -- Launch --> B[Worker]\n  end\n  C[Output]\n  D[Dark]\n  E[Own]\n  F[Plain]\n  G[Words]\n  B --> C\n  style S fill:#BBDEFB\n  style C fill:#BBDEFB\n  classDef dark fill:navy\n  class D dark\n  style E fill:#BBDEFB,color:#333\n  style G fill:#000\n  G@{ shape: text }";
    let contrast = render(contrast_src, &css_options()).unwrap().svg;
    assert!(
        Regex::new(r#"data-id="S">.*?<text class="pele-cluster-label" fill="var\(--pele-fg-on-light,#1f1f1f\)"[^>]*>Cluster<"#)
            .unwrap()
            .is_match(&contrast)
    );
    assert!(
        Regex::new(r#"data-id="C"[^>]*>.*?<text class="pele-label" fill="var\(--pele-fg-on-light,#1f1f1f\)"[^>]*>Output<"#)
            .unwrap()
            .is_match(&contrast)
    );
    assert!(
        Regex::new(r#"data-id="D"[^>]*>.*?<text class="pele-label" fill="var\(--pele-fg-on-dark,#fff\)"[^>]*>Dark<"#)
            .unwrap()
            .is_match(&contrast)
    );
    assert!(
        Regex::new(r#"data-id="E"[^>]*>.*?<text class="pele-label" style="fill:#333;"[^>]*>Own<"#)
            .unwrap()
            .is_match(&contrast)
    );
    assert!(
        Regex::new(r#"data-id="F"[^>]*>.*?<text class="pele-label" x=[^>]*>Plain<"#)
            .unwrap()
            .is_match(&contrast)
    );
    assert!(
        Regex::new(r#"data-id="G"[^>]*>.*?<text class="pele-label" x=[^>]*>Words<"#)
            .unwrap()
            .is_match(&contrast)
    );

    // Edge casings across filled subgraph borders & edge ink inside fills.
    let casing_src = "flowchart LR\n  subgraph S[\"Cluster\"]\n    A[Start] -- Launch --> B[Worker]\n    subgraph N\n      G --> H\n    end\n  end\n  subgraph T\n    D --> E\n  end\n  C[Output]\n  B --> C\n  C ==> D\n  B --> B\n  F --> C\n  B --> G\n  A --> H\n  style S fill:#BBDEFB\n  style N fill:navy\n  style C fill:#BBDEFB";
    let svg = render(casing_src, &css_options()).unwrap().svg;
    let casings = Regex::new(r#"<g class="pele-casings" fill="none" stroke="var\(--_bg\)" stroke-width="5"[^>]* pointer-events="none">(.*?)</g>"#)
        .unwrap()
        .captures(&svg)
        .unwrap()[1]
        .to_string();
    let group_of = |id: &str| {
        Regex::new(&format!(r#"<g class="pele-edge[^"]*" data-id="{id}"[^>]*>.*?</g>"#))
            .unwrap()
            .find(&svg)
            .unwrap()
            .as_str()
            .to_string()
    };
    let edge_d = |id: &str| {
        Regex::new(&format!(r#"data-id="{id}"[^>]*><path d="([^"]+)""#))
            .unwrap()
            .captures(&svg)
            .unwrap()[1]
            .to_string()
    };
    let is_cased = |id: &str| casings.contains(&format!(r#"<path d="{}"/>"#, edge_d(id)));
    let light = "var(--pele-fg-on-light,#1f1f1f)";
    for id in ["L_A_B_0", "L_B_B_0"] {
        assert!(!is_cased(id), "{id}");
        assert!(group_of(id).contains(&format!(r#" stroke="{light}""#)), "{id}");
    }
    assert!(group_of("L_G_H_0").contains(r#" stroke="var(--pele-fg-on-dark,#fff)""#));
    for id in ["L_B_C_0", "L_B_G_0", "L_A_H_0"] {
        assert!(is_cased(id), "{id}");
        assert!(!group_of(id).contains("--pele-fg-on"), "{id}");
    }
    for id in ["L_C_D_0", "L_D_E_0", "L_F_C_0"] {
        assert!(!is_cased(id), "{id}");
        assert!(!group_of(id).contains("--pele-fg-on"), "{id}");
    }
    assert!(svg.find(r#"class="pele-casings""#).unwrap() < svg.find(r#"class="pele-edges""#).unwrap());

    // Direct over_fills check.
    let css_theme = SvgTheme::new(ThemeMode::CssVariables, None, None);
    let fills = [
        Fill {
            bounds: [-20.0, -20.0, 100.0, 100.0],
            shape: r#" style="fill:white;""#.to_string(),
        },
        Fill {
            bounds: [10.0, 0.0, 50.0, 50.0],
            shape: r#" style="fill:navy;""#.to_string(),
        },
    ];
    assert_eq!(over_fills("M0,10L8,10", &[15.0, 10.0], &fills, "", None, &css_theme), OverFill::Casing);
    assert_eq!(
        over_fills("M0,10L8,10", &[9.0, 10.0], &fills, "", None, &css_theme),
        OverFill::Ink(light.to_string())
    );
    assert_eq!(
        over_fills("M-20,10L8,10", &[9.0, 10.0], &fills, "", None, &css_theme),
        OverFill::Ink(light.to_string())
    );

    // Unsafe CSS declarations dropped.
    assert_eq!(
        resolve_style(&["fill:url(http://example.com/x.png)".to_string(), "stroke:red".to_string()]).shape,
        r#" style="stroke:red;""#
    );
    assert_eq!(
        resolve_style(&["fill:red;background:blue".to_string(), "color:expression(alert(1))".to_string()]).shape,
        ""
    );

    // Links & internal links.
    let linked = render(
        "flowchart TD\n  A --> B --> C\n  click A \"https://example.com\" \"A tooltip\" _blank\n  click B \"javascript:alert(1)\"\n  click C call doSomething()",
        &css_options(),
    )
    .unwrap();
    assert!(linked.svg.contains(r#"<a href="https://example.com/" target="_blank" rel="noopener">"#));
    assert!(linked.svg.contains("<title>A tooltip</title>"));
    assert_eq!(linked.svg.matches("<a ").count(), 1);
    assert!(!linked.svg.contains("about:blank"));
    assert!(!linked.svg.contains("doSomething"));
    assert_eq!(
        linked.links,
        vec![LinkInfo {
            id: "A".to_string(),
            href: "https://example.com/".to_string(),
            internal: false,
        }]
    );

    let internal = render("flowchart TD\n  A[My note] --> B\n  class A internal-link;", &css_options()).unwrap();
    assert!(
        internal
            .svg
            .contains(r#"<a class="internal-link" href="My note" rel="noopener" data-href="My note">"#)
    );
    assert_eq!(
        internal.links,
        vec![LinkInfo {
            id: "A".to_string(),
            href: "My note".to_string(),
            internal: true,
        }]
    );
}

#[test]
fn flowchart_layout_geometry_markers_shapes_responsive_and_errors() {
    // Subgraph direction inherited when crossed.
    let groups = "flowchart LR\n  subgraph S\n    direction TB\n    s1\n    s2\n  end\n  subgraph P\n    direction TB\n    p1\n    p2\n  end\n";
    let edges = "  s1 --> p2\n  s2 --> p1\n";
    assert_eq!(
        render(&format!("{groups}{edges}"), &css_options()).unwrap().svg,
        render(&format!("{}{edges}", groups.replace("    direction TB\n", "")), &css_options())
            .unwrap()
            .svg
    );

    // Markers without <marker>/<defs>.
    let markers = render("flowchart LR\n  A --> B\n  B --- C\n  C --x D\n  D o--o E\n  E <--> F", &css_options())
        .unwrap()
        .svg;
    assert!(!markers.contains("<marker"));
    assert!(!markers.contains("<defs"));
    assert_eq!(markers.matches(r#"class="pele-marker""#).count(), 6);

    // Diamond and circle boundary attachment for spreading edges.
    let re_poly = Regex::new(r#"<polygon points="0,-([\d.]+) ([\d.]+),0"#).unwrap();
    let re_circle = Regex::new(r#"data-id="E"[^>]*><circle r="([\d.]+)""#).unwrap();
    let re_starts = Regex::new(r#"<g class="pele-edge"[^>]*><path d="M([-\d.]+),([-\d.]+)"#).unwrap();
    let re_tips = Regex::new(r#"class="pele-marker" d="M([-\d.]+),([-\d.]+)L"#).unwrap();
    for dir in ["TD", "LR"] {
        let svg = render(
            &format!("flowchart {dir}\n  D{{Decide}} --> A\n  D --> B\n  D --> C\n  A & B & C --> E((End))"),
            &css_options(),
        )
        .unwrap()
        .svg;
        let at = |id: &str| -> (f64, f64) {
            let cap = Regex::new(&format!(r#"data-id="{id}" transform="translate\(([-\d.]+),([-\d.]+)\)""#))
                .unwrap()
                .captures(&svg)
                .unwrap();
            (cap[1].parse().unwrap(), cap[2].parse().unwrap())
        };
        let (dx, dy) = at("D");
        let poly = re_poly.captures(&svg).unwrap();
        let h = poly[1].parse::<f64>().unwrap() * 2.0;
        let w = poly[2].parse::<f64>().unwrap() * 2.0;
        let (ex, ey) = at("E");
        let r: f64 = re_circle.captures(&svg).unwrap()[1].parse().unwrap();

        let starts: Vec<(f64, f64)> = re_starts.captures_iter(&svg).map(|c| (c[1].parse().unwrap(), c[2].parse().unwrap())).collect();
        let tips: Vec<(f64, f64)> = re_tips.captures_iter(&svg).map(|c| (c[1].parse().unwrap(), c[2].parse().unwrap())).collect();
        let unique_d: HashSet<String> = starts[..3].iter().map(|(x, y)| format!("{x},{y}")).collect();
        assert_eq!(unique_d.len(), 3, "dir={dir}");
        for &(x, y) in &starts[..3] {
            assert_close((x - dx).abs() / (w / 2.0) + (y - dy).abs() / (h / 2.0), 1.0, 0.1, "diamond border");
        }
        let unique_c: HashSet<String> = tips[3..].iter().map(|(x, y)| format!("{x},{y}")).collect();
        assert_eq!(unique_c.len(), 3, "dir={dir}");
        for &(x, y) in &tips[3..] {
            assert_close((x - ex).hypot(y - ey), r, 0.6, "circle border");
        }
    }

    // Stepped curve routes clear of nodes.
    let step_src = "---\nconfig:\n  flowchart:\n    curve: step\n---\nflowchart TD\n  A[Start] --> B[Parse]\n  A --> C[Measure]\n  A --> D[Theme]\n  B --> E[Fits]\n  C --> E\n  D --> E\n  E -->|Yes| F[Draw]\n  E -->|No| A";
    let step_svg = render(step_src, &css_options()).unwrap().svg;
    let re_path = Regex::new(r#"<g class="pele-edge"[^>]*><path d="([^"]+)""#).unwrap();
    let paths: Vec<&str> = re_path.captures_iter(&step_svg).map(|c| c.get(1).unwrap().as_str()).collect();
    assert_eq!(paths.len(), 8);
    let re_step_d = Regex::new(r"^M[-\d.]+,[-\d.]+(?:L[-\d.]+,[-\d.]+|Q[-\d.]+,[-\d.]+ [-\d.]+,[-\d.]+)+$").unwrap();
    for d in paths {
        assert!(re_step_d.is_match(d), "non-stepped d={d}");
    }

    // Declaration order preserved when crossings equal.
    let order_svg = render(
        "flowchart TD\n  A[Christmas] -->|Get money| B(Go shopping)\n  B --> C{Let me think}\n  C -->|One| D[Laptop]\n  C -->|Two| E[iPhone]\n  C -->|Three| F[Car]\n  D --> B\n  E --> A",
        &css_options(),
    )
    .unwrap()
    .svg;
    let x_of = |id: &str| -> f64 {
        Regex::new(&format!(r#"data-id="{id}" transform="translate\(([-\d.]+),"#))
            .unwrap()
            .captures(&order_svg)
            .unwrap()[1]
            .parse()
            .unwrap()
    };
    assert!(x_of("D") < x_of("F"));
    assert!(x_of("F") < x_of("E"));

    // Invisible links stay in layout, not drawn.
    let linked = render("flowchart LR\n  A ~~~ B", &css_options()).unwrap();
    let apart = render("flowchart LR\n  A\n  B", &css_options()).unwrap();
    assert!(!linked.svg.contains(r#"pele-edge""#));
    assert!(linked.width > apart.width - 1.0);
    assert!(linked.height < apart.height);

    // Accessible title/desc, responsive/useMaxWidth, autoDirection on narrow maxWidth.
    let acc = render(
        "flowchart TD\n  accTitle: A title\n  accDescr: A description\n  A --> B",
        &RenderOptions {
            id_prefix: Some("d1".to_string()),
            ..css_options()
        },
    )
    .unwrap()
    .svg;
    assert!(acc.contains(r#"<title id="d1-title">A title</title>"#));
    assert!(acc.contains(r#"<desc id="d1-desc">A description</desc>"#));
    assert!(acc.contains(r#"aria-labelledby="d1-title""#));

    let wide_chain = "flowchart LR\n  A[First step] --> B[Second step] --> C[Third step] --> D[Fourth step] --> E[Fifth step]";
    let across = render(wide_chain, &css_options()).unwrap();
    let turned = render(
        wide_chain,
        &RenderOptions {
            max_width: Some(320.0),
            ..css_options()
        },
    )
    .unwrap();
    assert!(across.width > 320.0);
    assert!(turned.width < across.width);
    assert!(turned.height > across.height);
    assert_eq!(
        turned.svg,
        render(&wide_chain.replace("flowchart LR", "flowchart TB"), &css_options()).unwrap().svg
    );

    // Source-mapped syntax & semantic error positions.
    let err = render("flowchart TD\nA[a#35;b] --> -->", &css_options()).unwrap_err();
    assert_eq!(err.code, ErrorCode::Syntax);
    assert_eq!(err.line, 2);
    assert_eq!(err.column, 15);
    assert_eq!(err.snippet, "A[a#35;b] --> -->\n--------------^");

    let sem = render("flowchart TD\na@{shape: \"#35;x\"}", &css_options()).unwrap_err();
    assert_eq!(sem.code, ErrorCode::Semantic);
    assert_eq!(sem.message, "No such shape: #35;x.");

    let fm_err = render("---\ntitle: T\n---\n\n%% A comment\nflowchart TD\n  A --> B\n  C --> --> D", &css_options()).unwrap_err();
    assert_eq!(fm_err.line, 8);
    assert_eq!(fm_err.column, 9);

    // Parsed model exposure.
    let parsed = parse("flowchart LR\n  A[Start] --> B{Choice}", &ParseOptions::default()).unwrap();
    assert_eq!(parsed.diagram_type, DiagramType::Flowchart);
    match &parsed.model {
        ParsedModel::Flowchart(db) => {
            assert_eq!(db.direction.as_deref(), Some("LR"));
            let ids: Vec<&str> = db.nodes.keys().map(String::as_str).collect();
            assert_eq!(ids, vec!["A", "B"]);
            assert_eq!(db.nodes["B"].shape_type.as_deref(), Some("diamond"));
            assert_eq!(db.edges[0].edge_type.as_deref(), Some("arrow_point"));
        }
        other => panic!("expected Flowchart model, got {other:?}"),
    }
}

#[test]
fn flowchart_security_hostile_payloads_options_and_mutated_fuzz() {
    type TemplateFn = Box<dyn Fn(&str) -> String>;
    let templates: Vec<TemplateFn> = vec![
        Box::new(|p| format!("flowchart TD\n  A[{p}] --> B")),
        Box::new(|p| format!("flowchart TD\n  A[\"{p}\"] --> B")),
        Box::new(|p| format!("flowchart TD\n  A[\"`{p}`\"] --> B")),
        Box::new(|p| format!("flowchart TD\n  A({p}) --> B{{{p}}}")),
        Box::new(|p| format!("flowchart TD\n  {p} --> B")),
        Box::new(|p| format!("flowchart TD\n  A -->|{p}| B")),
        Box::new(|p| format!("flowchart TD\n  A -- {p} --> B")),
        Box::new(|p| format!("flowchart TD\n  A -- \"{p}\" --> B")),
        Box::new(|p| format!("flowchart TD\n  subgraph {p}\n  A\n  end")),
        Box::new(|p| format!("flowchart TD\n  subgraph s [\"{p}\"]\n  A\n  end")),
        Box::new(|p| format!("flowchart TD\n  A:::{p} --> B")),
        Box::new(|p| format!("flowchart TD\n  A --> B\n  class A {p}")),
        Box::new(|p| format!("flowchart TD\n  A --> B\n  classDef {p} fill:red\n  class A {p}")),
        Box::new(|p| format!("flowchart TD\n  A --> B\n  classDef c fill:{p}\n  class A c")),
        Box::new(|p| format!("flowchart TD\n  A --> B\n  style A fill:{p}")),
        Box::new(|p| format!("flowchart TD\n  A --> B\n  style A {p}:red")),
        Box::new(|p| format!("flowchart TD\n  A --> B\n  style A color:{p},stroke:{p},font-family:{p}")),
        Box::new(|p| format!("flowchart TD\n  A --> B\n  linkStyle 0 stroke:{p}")),
        Box::new(|p| format!("flowchart TD\n  A --> B\n  click A \"{p}\"")),
        Box::new(|p| format!("flowchart TD\n  A --> B\n  click A href \"{p}\" \"{p}\" _blank")),
        Box::new(|p| format!("flowchart TD\n  A --> B\n  click A \"x\" \"{p}\"")),
        Box::new(|p| format!("flowchart TD\n  A --> B\n  click A call {p}()")),
        Box::new(|p| format!("flowchart TD\n  A --> B\n  click A \"https://example.com\" {p}")),
        Box::new(|p| format!("flowchart TD\n  A[\"{p}\"] --> B\n  class A internal-link")),
        Box::new(|p| format!("flowchart TD\n  A[{p}]:::internal-link --> B")),
        Box::new(|p| format!("flowchart TD\n  accTitle: {p}\n  accDescr: {p}\n  A --> B")),
        Box::new(|p| format!("flowchart TD\n  accDescr {{\n {p}\n }}\n  A --> B")),
        Box::new(|p| format!("flowchart TD\n  A@{{ label: \"{p}\" }} --> B")),
        Box::new(|p| format!("flowchart TD\n  A@{{ shape: {p} }} --> B")),
        Box::new(|p| format!("flowchart TD\n  A@{{ icon: \"{p}\", form: \"{p}\", pos: \"{p}\", label: \"x\" }} --> B")),
        Box::new(|p| format!("flowchart TD\n  A@{{ img: \"{p}\", label: \"x\", w: \"{p}\", h: \"{p}\", constraint: \"{p}\" }} --> B")),
        Box::new(|p| format!("flowchart TD\n  A@{{ {p}: 1 }} --> B")),
        Box::new(|p| format!("flowchart TD\n  A e1@--> B\n  e1@{{ animate: \"{p}\", curve: \"{p}\" }}")),
        Box::new(|p| format!("flowchart TD\n  A[fa:fa-{p} x] --> B")),
        Box::new(|p| format!("---\ntitle: \"{p}\"\nconfig:\n  flowchart:\n    curve: \"{p}\"\n---\nflowchart TD\n  A --> B")),
        Box::new(|p| {
            format!("%%{{init: {{\"flowchart\": {{\"curve\": \"{p}\"}}, \"themeVariables\": {{\"fontFamily\": \"{p}\"}}}}}}%%\nflowchart TD\n  A --> B")
        }),
        Box::new(|p| format!("flowchart {p}\n  A --> B")),
        Box::new(|p| format!("flowchart TD\n  %% {p}\n  A --> B")),
    ];

    let mut rendered = 0usize;
    for tmpl in &templates {
        for &payload in PAYLOADS {
            let src = tmpl(payload);
            if let Some(svg) = try_render_css(&src) {
                assert_inert(&svg, &src);
                rendered += 1;
            }
            if let Some(svg) = try_render_resolved(&src) {
                assert_inert_resolved(&svg, &src);
                assert_resvg_parses(&svg, &src);
            }
        }
    }
    assert!(rendered > 300, "rendered={rendered}");

    // Hostile option values.
    for &payload in PAYLOADS {
        let svg = render(
            "flowchart TD\n  accTitle: t\n  A --> B",
            &RenderOptions {
                id_prefix: Some(payload.to_string()),
                font_family: Some(payload.to_string()),
                ..resolved_options()
            },
        )
        .unwrap()
        .svg;
        assert_inert_resolved(&svg, payload);
        assert_resvg_parses(&svg, payload);
    }

    // Internal link never gets unsafe href.
    let unsafe_internal = render("flowchart TD\n  A[\"javascript:alert(1)\"]:::internal-link", &css_options())
        .unwrap()
        .svg;
    assert!(unsafe_internal.contains(r#"<a class="internal-link" data-href="javascript:alert(1)">"#));
    let with_about = render(
        "flowchart TD\n  A[\"javascript:alert(1)\"]:::internal-link",
        &RenderOptions {
            link_schemes: Some(vec!["about".to_string()]),
            ..css_options()
        },
    )
    .unwrap()
    .svg;
    assert!(!with_about.contains(" href="));

    // Mutated fuzzing over corpus.
    let corpus = load_fixture("flowchart-corpus.json");
    let mut frags: Vec<&str> = PAYLOADS.to_vec();
    frags.extend_from_slice(&["\"", "[", "]", "|", "\n", ":::", "click A \"", "style A fill:", "@{ label: \"", " }"]);
    let mut mutator = Mutator::new(&corpus, frags, 3);
    for _ in 0..1000 {
        let src = mutator.next_sample();
        if src.len() <= 4000
            && let Some(svg) = try_render_css(&src)
        {
            assert_inert(&svg, &src[..src.len().min(120)]);
        }
    }
}
