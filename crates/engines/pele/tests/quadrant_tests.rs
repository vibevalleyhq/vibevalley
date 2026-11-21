mod support;

use std::collections::HashSet;
use std::time::Instant;

use regex::Regex;
use vibevalley_pele::detect::DiagramType;
use vibevalley_pele::diagram::quadrant::db::{QuadrantText, QuadrantTextKind, parse_styles};
use vibevalley_pele::diagram::quadrant::lexer::tokenize;
use vibevalley_pele::{ErrorCode, METRICS_MEASURER, ParseOptions, ParsedModel, RenderOptions, TextMeasurer, TextStyle, parse, render, supports};

use support::{Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, css_options, dark_options, load_fixture, resolved_options};

const CHART: &str = "quadrantChart
  title Reach and engagement
  x-axis Low Reach --> High Reach
  y-axis Low Engagement --> High Engagement
  quadrant-1 Expand
  quadrant-2 Promote
  quadrant-3 Re-evaluate
  quadrant-4 Improve
  Campaign A: [0.25, 0.75]
  Campaign B: [0.75, 0.25]";

fn texts(svg: &str) -> Vec<String> {
    let re = Regex::new(r"<text[^>]*>(?:<tspan[^>]*>)?([^<]*)").unwrap();
    re.captures_iter(svg).map(|c| c[1].to_string()).collect()
}

struct DrawnPoint {
    id: String,
    cx: f64,
    cy: f64,
    r: f64,
    style: Option<String>,
    class: Option<String>,
    stroke: Option<String>,
}

fn circle_attrs(svg: &str) -> Vec<DrawnPoint> {
    let doc = roxmltree::Document::parse(svg).unwrap();
    doc.descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "circle")
        .map(|n| DrawnPoint {
            id: n.attribute("data-id").unwrap_or("").to_string(),
            cx: n.attribute("cx").unwrap().parse().unwrap(),
            cy: n.attribute("cy").unwrap().parse().unwrap(),
            r: n.attribute("r").unwrap().parse().unwrap(),
            style: n.attribute("style").map(str::to_string),
            class: n.attribute("class").map(str::to_string),
            stroke: n.attribute("stroke").map(str::to_string),
        })
        .collect()
}

#[test]
fn quadrant_rendering_axes_points_styles_and_config() {
    let res = render(CHART, &css_options()).unwrap();
    assert_eq!(res.diagram_type, DiagramType::QuadrantChart);
    assert!(supports("quadrantChart"));
    assert_eq!((res.width, res.height), (500.0, 500.0));
    assert!(res.svg.contains(r#"class="pele pele-quadrantChart""#));
    assert_eq!(res.svg.matches(r#"class="pele-quadrant""#).count(), 4);
    let txts = texts(&res.svg);
    for expected in [
        "Reach and engagement",
        "Low Reach",
        "High Reach",
        "Low Engagement",
        "High Engagement",
        "Expand",
        "Promote",
        "Re-evaluate",
        "Improve",
        "Campaign A",
        "Campaign B",
    ] {
        assert!(txts.contains(&expected.to_string()), "missing {expected:?}");
    }
    assert_eq!(circle_attrs(&res.svg).len(), 2);
    assert!(res.svg.contains("var(--pele-series-1,"));

    let light = render(CHART, &resolved_options()).unwrap();
    assert_inert_resolved(&light.svg, "quadrant light");
    assert_resvg_parses(&light.svg, "quadrant light");
    let dark = render(CHART, &dark_options()).unwrap();
    assert_inert_resolved(&dark.svg, "quadrant dark");
    assert_resvg_parses(&dark.svg, "quadrant dark");

    // Coordinates: x right, y up; first point drawn on top (last in DOM).
    let dots = circle_attrs(&render("quadrantChart\n A: [0, 0]\n B: [1, 1]\n C: [0.5, 0.5]", &css_options()).unwrap().svg);
    let at = |id: &str| dots.iter().find(|d| d.id == id).map(|d| (d.cx, d.cy)).unwrap();
    let (ax, ay) = at("A");
    let (bx, by) = at("B");
    assert!(bx > ax && by < ay);
    assert_eq!(at("C"), ((ax + bx) / 2.0, (ay + by) / 2.0));

    let overlap_dots = circle_attrs(&render("quadrantChart\n First: [0.5, 0.5]\n Second: [0.5, 0.5]", &css_options()).unwrap().svg);
    let order: Vec<&str> = overlap_dots.iter().map(|d| d.id.as_str()).collect();
    assert_eq!(order, vec!["Second", "First"]);

    // Quadrant 1..4 positions anticlockwise from top-right.
    let qsvg = render("quadrantChart\n quadrant-1 q1\n quadrant-2 q2\n quadrant-3 q3\n quadrant-4 q4", &css_options())
        .unwrap()
        .svg;
    let doc = roxmltree::Document::parse(&qsvg).unwrap();
    let rects: Vec<(f64, f64)> = doc
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "rect")
        .map(|n| (n.attribute("x").unwrap().parse().unwrap(), n.attribute("y").unwrap().parse().unwrap()))
        .collect();
    assert!(rects[0].0 > rects[1].0 && rects[0].1 == rects[1].1);
    assert!(rects[2].0 == rects[1].0 && rects[2].1 > rects[1].1);
    assert_eq!(rects[3], (rects[0].0, rects[2].1));

    // x-axis moves below once points are present or xAxisPosition: bottom.
    let re_left = Regex::new(r#"<text[^>]* y="([\d.]+)"[^>]*>Left<"#).unwrap();
    let y_of = |src: &str| -> f64 { re_left.captures(&render(src, &css_options()).unwrap().svg).unwrap()[1].parse().unwrap() };
    assert!(y_of("quadrantChart\n x-axis Left --> Right") < 100.0);
    assert!(y_of("quadrantChart\n x-axis Left --> Right\n A: [0.5, 0.5]") > 400.0);
    assert!(y_of("---\nconfig:\n  quadrantChart:\n    xAxisPosition: bottom\n---\nquadrantChart\n x-axis Left --> Right") > 400.0);

    // Direct styles over class styles.
    let styled = render(
        "quadrantChart
        A: [0.1, 0.1] radius: 12
        B:::c1: [0.2, 0.2] color: #ff3300, radius: 10
        C:::c2: [0.3, 0.3]
        D: [0.4, 0.4] color: 00f, stroke-width: 3px
        E: [0.5, 0.5] stroke-color: #00ff00
        classDef c1 color: #109060
        classDef c2 color: #908342, radius : 9, stroke-color: #310085, stroke-width: 10px",
        &css_options(),
    )
    .unwrap()
    .svg;
    let sdots = circle_attrs(&styled);
    let dot = |id: &str| sdots.iter().find(|d| d.id == id).unwrap();
    assert_eq!(dot("A").r, 12.0);
    assert_eq!(dot("B").r, 10.0);
    assert_eq!(dot("B").style.as_deref(), Some("fill:#ff3300;"));
    assert_eq!(dot("B").class.as_deref(), Some("pele-point c1"));
    assert_eq!(dot("C").r, 9.0);
    assert_eq!(dot("C").style.as_deref(), Some("fill:#908342;stroke:#310085;stroke-width:10px;"));
    assert_eq!(dot("D").style.as_deref(), Some("fill:#00f;stroke-width:3px;"));
    assert!(dot("D").stroke.as_deref().unwrap().contains("--pele-series-1"));
    assert_eq!(dot("E").style, None);
    assert_eq!(dot("E").r, 5.0);

    // Non-numeric / out-of-range coordinates skipped.
    let filtered = circle_attrs(
        &render("quadrantChart\n A: [0x5, 0.5]\n B: [0,5, 0.5]\n C: [0.5, 0.5]", &css_options())
            .unwrap()
            .svg,
    );
    assert_eq!(filtered.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), vec!["C"]);

    // Font sizes & markdown labels.
    let sized = render(
        "---\nconfig:\n  quadrantChart:\n    titleFontSize: 30\n    quadrantLabelFontSize: 20\n    xAxisLabelFontSize: 11\n    yAxisLabelFontSize: 13\n    pointLabelFontSize: 9\n---\nquadrantChart\n title Garden\n x-axis L --> R\n y-axis B --> T\n quadrant-1 Big\n P: [0.3, 0.7]",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(sized.contains(r#"class="pele-title" font-size="30""#));
    assert!(sized.contains(r#"class="pele-label" font-size="20" fill="var(--_fg)""#));
    assert!(sized.contains(r#"<g class="pele-axis-labels" font-size="11""#));
    assert_eq!(sized.matches(r#"rotate(-90)" font-size="13""#).count(), 2);
    assert!(sized.contains(r#"<g class="pele-point-labels" font-size="9""#));

    let md = render("quadrantChart\n quadrant-1 \"`**Bold** text`\"\n \"two<br>lines\": [0.5, 0.5]", &css_options())
        .unwrap()
        .svg;
    assert!(md.contains(r#"font-weight="var(--_w)">Bold</tspan>"#));
    assert!(md.contains(">two</tspan>"));
    assert!(md.contains(">lines</tspan>"));
}

#[test]
fn quadrant_label_placement_model_validation_and_compat() {
    // Point labels stay inside the chart and avoid each other.
    let spread = render(
        "quadrantChart\n One: [0.5, 0]\n Two: [0.5, 0.02]\n Three: [1, 1]\n Four: [0, 0.5]",
        &css_options(),
    )
    .unwrap()
    .svg;
    let re_lbl = Regex::new(r#"<text class="pele-label" x="([\d.]+)" y="([\d.]+)""#).unwrap();
    let pts: Vec<(f64, f64)> = re_lbl.captures_iter(&spread).map(|c| (c[1].parse().unwrap(), c[2].parse().unwrap())).collect();
    assert_eq!(pts.len(), 4);
    for &(x, y) in &pts {
        assert!(x > 8.0 && x < 492.0 && y > 8.0 && y < 492.0);
    }
    let buckets: HashSet<String> = pts.iter().map(|&(x, y)| format!("{},{}", (x / 20.0).round(), (y / 10.0).round())).collect();
    assert_eq!(buckets.len(), 4);

    // Boundary point label goes below quadrant title inside quadrant 3.
    let q4 = "quadrantChart
      title Q4 candidates by effort and impact
      x-axis Low effort --> High effort
      y-axis Low impact --> High impact
      quadrant-1 Plan carefully
      quadrant-2 Do first
      quadrant-3 Reconsider
      quadrant-4 Quick wins
      Chart gallery editor: [0.72, 0.85]
      First-run onboarding: [0.35, 0.78]
      Shared folders: [0.88, 0.70]
      Export to PDF: [0.30, 0.55]
      Custom themes: [0.45, 0.20]
      Calendar sync: [0.65, 0.30]
      Keyboard shortcut sheet: [0.12, 0.48]";
    let q4_res = render(q4, &resolved_options()).unwrap();
    assert_resvg_parses(&q4_res.svg, "q4 quadrant");
    let doc = roxmltree::Document::parse(&q4_res.svg).unwrap();
    let q3 = doc
        .descendants()
        .find(|n| n.is_element() && n.attribute("class") == Some("pele-quadrant") && n.attribute("data-id") == Some("3"))
        .unwrap();
    let q3_rect = q3.children().find(|n| n.tag_name().name() == "rect").unwrap();
    let q3_title = q3.children().find(|n| n.tag_name().name() == "text").unwrap();
    let ks_label = doc
        .descendants()
        .find(|n| n.is_element() && n.tag_name().name() == "text" && n.text() == Some("Keyboard shortcut sheet"))
        .unwrap();
    let half_w = METRICS_MEASURER.width("Keyboard shortcut sheet", 12.0, TextStyle::NONE) / 2.0;
    let lx: f64 = ks_label.attribute("x").unwrap().parse().unwrap();
    let ly: f64 = ks_label.attribute("y").unwrap().parse().unwrap();
    let ty: f64 = q3_title.attribute("y").unwrap().parse().unwrap();
    let rx: f64 = q3_rect.attribute("x").unwrap().parse().unwrap();
    let rw: f64 = q3_rect.attribute("width").unwrap().parse().unwrap();
    assert!(ly > ty + 12.0);
    assert!(lx - half_w > rx && lx + half_w < rx + rw);

    // Style validation (quadrantDb.spec.ts).
    let parsed_st = parse_styles(&[
        "radius: 10".to_string(),
        "color: #ff0000".to_string(),
        "stroke-color: #ff00ff".to_string(),
        "stroke-width: 10px".to_string(),
    ])
    .unwrap();
    assert_eq!(parsed_st.radius, Some(10.0));
    assert_eq!(parsed_st.color.as_deref(), Some("#ff0000"));
    assert_eq!(parsed_st.stroke_color.as_deref(), Some("#ff00ff"));
    assert_eq!(parsed_st.stroke_width.as_deref(), Some("10px"));
    assert!(
        parse_styles(&["radius: f".to_string()])
            .unwrap_err()
            .message
            .contains("value for radius f is invalid, please use a valid number")
    );
    assert!(
        parse_styles(&["color: ffaa".to_string()])
            .unwrap_err()
            .message
            .contains("value for color ffaa is invalid, please use a valid hex code")
    );
    assert!(
        parse_styles(&["stroke-width: 30".to_string()])
            .unwrap_err()
            .message
            .contains("value for stroke-width 30 is invalid, please use a valid number of pixels (eg. 10px)")
    );
    assert!(
        parse_styles(&["fill: #fff".to_string()])
            .unwrap_err()
            .message
            .contains("style named fill is not supported.")
    );

    // Model exposure & comments.
    let parsed = parse(
        "quadrantChart\n x-axis a --> b\n quadrant-2 \"`Do`\"\n P:::k: [0.2, 0.8] radius: 3\n classDef k color: #abc",
        &ParseOptions::default(),
    )
    .unwrap();
    match parsed.model {
        ParsedModel::QuadrantChart(m) => {
            assert_eq!(
                m.x_axis_left,
                Some(QuadrantText {
                    text: "a".to_string(),
                    kind: QuadrantTextKind::Text
                })
            );
            assert_eq!(
                m.x_axis_right,
                Some(QuadrantText {
                    text: "b".to_string(),
                    kind: QuadrantTextKind::Text
                })
            );
            assert_eq!(
                m.quadrants[1],
                Some(QuadrantText {
                    text: "Do".to_string(),
                    kind: QuadrantTextKind::Markdown
                })
            );
            assert_eq!(m.points.len(), 1);
            assert_eq!(m.points[0].class_name, "k");
            assert_eq!(m.points[0].style.radius, Some(3.0));
            assert_eq!(m.classes.get("k").unwrap().color.as_deref(), Some("#abc"));
        }
        other => panic!("expected QuadrantChart, got {other:?}"),
    }
    assert!(parse("quadrantChart\nquadrant-1 A%% note", &ParseOptions::default()).is_ok());
    assert!(parse("quadrantChart\nquadrant-1 A:%% note", &ParseOptions::default()).is_err());
}

#[test]
fn quadrant_corpus_hostile_extreme_and_fuzz_are_inert_and_resvg_safe() {
    let corpus = load_fixture("quadrant-corpus.json");
    assert_eq!(corpus.len(), 60);
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
    assert!(rendered_corpus > 30, "rendered_corpus={rendered_corpus}");

    let mut rendered_hostile = 0usize;
    for &p in PAYLOADS {
        let templates = [
            format!("quadrantChart\n  title {p}\n  A: [0.5, 0.5]"),
            format!("quadrantChart\n  x-axis \"{p}\" --> \"{p}\"\n  A: [0.5, 0.5]"),
            format!("quadrantChart\n  quadrant-1 {p}\n  quadrant-2 \"{p}\""),
            format!("quadrantChart\n  quadrant-3 \"`{p}`\"\n  quadrant-4 \"`**{p}**`\"\n  A: [0.1, 0.9]"),
            format!("quadrantChart\n  \"{p}\": [0.5, 0.5]"),
            format!("quadrantChart\n  A:::{p}: [0.5, 0.5]"),
            format!("quadrantChart\n  A: [0.5, 0.5] color: {p}"),
            format!("quadrantChart\n  accTitle: {p}\n  accDescr: {p}\n  A: [0.5, 0.5]"),
            format!("---\nconfig:\n  quadrantChart:\n    chartWidth: \"{p}\"\n    xAxisPosition: \"{p}\"\n---\nquadrantChart\n  A: [0.5, 0.5]"),
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
    assert!(rendered_hostile > 150, "rendered_hostile={rendered_hostile}");

    // Extreme numbers & radius.
    let huge = "9".repeat(400);
    let big_r = render(
        &format!("quadrantChart\n  A: [0.5, 0.5] radius: {huge}, stroke-width: {huge}px"),
        &resolved_options(),
    )
    .unwrap();
    assert_inert_resolved(&big_r.svg, "quadrant huge radius");
    assert_resvg_parses(&big_r.svg, "quadrant huge radius");

    let mut frags: Vec<&str> = PAYLOADS.to_vec();
    frags.extend_from_slice(&["\"", "`", ":", ":::", ": [", "]", "\n", ", ", "classDef ", "color: #", "radius: ", "-->"]);
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
fn quadrant_worst_cases_stay_linear() {
    let big = RenderOptions {
        limit: Some(usize::MAX),
        ..css_options()
    };
    let n = 50_000usize;
    let lex_cases = [
        format!("quadrantChart\n{}!", " ".repeat(n)),
        format!("quadrantChart\nA{}:x", "\t".repeat(n)),
        format!("quadrantChart\n{}", format!("{}:", "\t".repeat(500)).repeat(100)),
        format!("quadrantChart\nx-axis a {}", "-".repeat(n)),
        format!("quadrantChart\nA: [0.{}, 1]", "5".repeat(n)),
    ];
    for src in &lex_cases {
        let started = Instant::now();
        let _ = tokenize(src);
        assert!(started.elapsed().as_millis() < 2000);
    }

    let pts_3500: String = (0..3500).map(|i| format!("P{i}: [0.{}, 0.{}]\n", i % 100, (i * 7) % 100)).collect();
    let pts_300: String = (0..300).map(|i| format!("Point {i}: [0.5, 0.5]\n")).collect();
    let cases = [
        format!("quadrantChart\n{pts_3500}"),
        format!("quadrantChart\n{pts_300}"),
        format!("quadrantChart\nA:::c: [0.5, 0.5]\nclassDef c {}radius: 6", "radius: 5,".repeat(8000)),
        format!("quadrantChart\n{} : [0.5, 0.5]", "word ".repeat(n / 5)),
        format!("quadrantChart\ntitle {}", "long title ".repeat(n / 11)),
        format!("quadrantChart\naccDescr {{{}", " a\n".repeat(n / 3)),
    ];
    for src in &cases {
        let started = Instant::now();
        let _ = render(src, &big);
        assert!(started.elapsed().as_millis() < 2000);
    }
    let over = render(&format!("quadrantChart\n{}", "A: [0.5, 0.5]\n".repeat(5000)), &css_options()).unwrap_err();
    assert_eq!(over.code, ErrorCode::Limit);
}
