mod support;

use std::time::Instant;

use regex::Regex;
use vibevalley_pele::detect::DiagramType;
use vibevalley_pele::diagram::radar::model::Graticule;
use vibevalley_pele::diagram::radar::parser::parse_radar;
use vibevalley_pele::diagram::radar::render::{Point, closed_round_curve, relative_radius};
use vibevalley_pele::{ErrorCode, ParseOptions, ParsedModel, RenderOptions, parse, render, supports};

use support::{Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, css_options, dark_options, load_fixture, resolved_options};

const BASIC: &str = "radar-beta\n  axis A, B, C, D\n  curve one[\"First\"]{1,2,3,4}\n  curve two{4,3,2,1}";

fn configured(radar: &str, body: &str) -> String {
    format!("---\nconfig:\n  radar:\n{radar}\n---\n{body}")
}

fn count_in_group(svg: &str, tag: &str, class: &str) -> usize {
    let doc = roxmltree::Document::parse(svg).unwrap();
    doc.descendants()
        .find(|n| n.is_element() && n.attribute("class") == Some(class))
        .map_or(0, |g| g.descendants().filter(|n| n.is_element() && n.tag_name().name() == tag).count())
}

#[test]
fn radar_rendering_graticules_scaling_options_and_palette() {
    let res = render(BASIC, &css_options()).unwrap();
    assert_eq!(res.diagram_type, DiagramType::Radar);
    assert!(supports("radar-beta\naxis A"));
    assert_eq!(count_in_group(&res.svg, "circle", "pele-graticule"), 5);
    assert_eq!(res.svg.matches(r#"class="pele-axis-label""#).count(), 4);
    assert_eq!(res.svg.matches(r#"<path class="pele-curve""#).count(), 2);
    assert_eq!(res.svg.matches(r#"class="pele-legend-item""#).count(), 2);
    assert!(res.svg.contains(">First<"));
    assert!(res.svg.contains(">two<"));
    assert!(res.svg.contains(r#"data-id="one" fill="var(--pele-series-1,"#));
    assert!(res.svg.contains(r#"data-id="two" fill="var(--pele-series-2,"#));
    assert!(res.svg.contains(r#"fill-opacity="0.2""#));

    let light = render(BASIC, &resolved_options()).unwrap();
    assert_inert_resolved(&light.svg, "radar light");
    assert_resvg_parses(&light.svg, "radar light");
    let dark = render(BASIC, &dark_options()).unwrap();
    assert_inert_resolved(&dark.svg, "radar dark");
    assert_resvg_parses(&dark.svg, "radar dark");

    // Polygon graticule with custom ticks.
    let poly = render(&format!("{BASIC}\n  graticule polygon\n  ticks 3"), &css_options()).unwrap().svg;
    assert_eq!(count_in_group(&poly, "polygon", "pele-graticule"), 3);
    assert_eq!(count_in_group(&poly, "circle", "pele-graticule"), 0);
    assert_eq!(poly.matches(r#"<polygon class="pele-curve""#).count(), 2);
    assert!(!poly.contains(r#"<path class="pele-curve""#));

    // Hide legend.
    let hidden = render(&format!("{BASIC}\n  showLegend false"), &css_options()).unwrap();
    assert!(!hidden.svg.contains("pele-legend"));
    assert!(hidden.width < res.width);

    // Min/max scaling & clipping.
    let re_top = Regex::new(r#"<polygon class="pele-curve"[^>]* points="0,(-?[\d.]+) "#).unwrap();
    let top_of = |src: &str| -> f64 {
        let svg = render(&format!("{src}\n graticule polygon"), &css_options()).unwrap().svg;
        re_top.captures(&svg).unwrap()[1].parse().unwrap()
    };
    let body = "radar-beta\n axis A, B, C\n curve c{50, 0, 0}";
    assert_eq!(top_of(body), -160.0);
    assert_eq!(top_of(&format!("{body}\n max 100")), -80.0);
    assert_eq!(top_of(&format!("{body}\n max 100\n min 20")), -60.0);
    assert_eq!(top_of(&format!("{body}\n max 25")), -160.0);
    assert_eq!(top_of(&format!("{body}\n min 60\n max 100")), 0.0);

    // Config options: width/height/margins/axisScaleFactor/curveTension.
    let base = render(&format!("{BASIC}\n showLegend false"), &css_options()).unwrap();
    let large = render(
        &configured("    width: 600\n    height: 600", &format!("{BASIC}\n showLegend false")),
        &css_options(),
    )
    .unwrap();
    assert!(large.width - base.width >= 280.0 && large.width - base.width < 300.0);
    assert!(large.height - base.height >= 280.0);
    let short_spoke = render(&configured("    axisScaleFactor: 0.5", BASIC), &css_options()).unwrap().svg;
    assert!(short_spoke.contains("M0,0L0,-80"));
    assert!(res.svg.contains("M0,0L0,-160"));
    let straight = render(&configured("    curveTension: 0", BASIC), &css_options()).unwrap().svg;
    let re_d = Regex::new(r#"data-id="one"[^>]* d="([^"]*)""#).unwrap();
    assert!(re_d.captures(&straight).unwrap()[1].starts_with("M0,-40 C0,-40 80,0 80,0 "));

    // Short curve omitted from shapes but kept in legend.
    let partial = render("radar-beta\n axis A, B, C\n curve full{1,2,3}\n curve short{1,2}", &css_options())
        .unwrap()
        .svg;
    assert_eq!(partial.matches(r#"class="pele-curve""#).count(), 1);
    assert_eq!(partial.matches(r#"class="pele-legend-item""#).count(), 2);

    // Huge double scaling & palette overrides + max_width.
    let huge = format!("1{},5{},25{}", "0".repeat(308), "0".repeat(307), "0".repeat(306));
    let re_pts = Regex::new(r#"<polygon class="pele-curve"[^>]* points="([^"]*)""#).unwrap();
    let pts_huge = re_pts
        .captures(
            &render(&format!("radar-beta\n axis A, B, C\n curve c{{{huge}}}\n graticule polygon"), &css_options())
                .unwrap()
                .svg,
        )
        .unwrap()[1]
        .to_string();
    let pts_small = re_pts
        .captures(
            &render("radar-beta\n axis A, B, C\n curve c{4,2,1}\n graticule polygon", &css_options())
                .unwrap()
                .svg,
        )
        .unwrap()[1]
        .to_string();
    assert_eq!(pts_huge, pts_small);

    let pal = render(
        "---\nconfig:\n  themeVariables:\n    cScale0: '#ff0000'\n    cScale1: '#0000ff'\n---\nradar-beta\n axis a, b, c\n curve x{1,2,3}",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(pal.contains("--pele-series-1:#ff0000"));
    assert!(pal.contains("--pele-series-2:#0000ff"));

    let narrow = render(
        BASIC,
        &RenderOptions {
            max_width: Some(300.0),
            ..resolved_options()
        },
    )
    .unwrap();
    assert!(narrow.width <= 300.0);
    assert_resvg_parses(&narrow.svg, "narrow radar");
}

#[test]
fn radar_parser_compat_unit_helpers_and_degenerate_inputs() {
    // Unit helpers (radar.spec.ts).
    assert_eq!(relative_radius(5.0, 0.0, 10.0, 100.0), 50.0);
    assert_eq!(relative_radius(-5.0, 0.0, 10.0, 100.0), 0.0);
    assert_eq!(relative_radius(15.0, 0.0, 10.0, 100.0), 100.0);
    assert_eq!(relative_radius(5.0, -10.0, 10.0, 100.0), 75.0);
    let sq = [
        Point { x: 0.0, y: 0.0 },
        Point { x: 100.0, y: 0.0 },
        Point { x: 100.0, y: 100.0 },
        Point { x: 0.0, y: 100.0 },
    ];
    assert_eq!(
        closed_round_curve(&sq, 0.0),
        "M0,0 C0,0 100,0 100,0 C100,0 100,100 100,100 C100,100 0,100 0,100 C0,100 0,0 0,0 Z"
    );
    assert_eq!(
        closed_round_curve(&sq, 0.5),
        "M0,0 C50,-50 50,-50 100,0 C150,50 150,50 100,100 C50,150 50,150 0,100 C-50,50 -50,50 0,0 Z"
    );

    // Named entries reordering & errors.
    let ordered = parse("radar-beta\n axis A, B, C\n curve c{ C: 3, A: 1, B: 2 }", &ParseOptions::default()).unwrap();
    match ordered.model {
        ParsedModel::Radar(m) => assert_eq!(m.curves[0].entries, vec![1.0, 2.0, 3.0]),
        other => panic!("expected Radar, got {other:?}"),
    }
    assert!(
        render("radar-beta\n axis A[\"Alpha\"], B\n curve c{ B: 2 }", &css_options())
            .unwrap_err()
            .message
            .contains("Missing entry for axis Alpha")
    );
    assert!(
        render("radar-beta\n axis a[\"#35;x &amp;y\"], b\n curve c{ b: 1 }", &css_options())
            .unwrap_err()
            .message
            .contains("Missing entry for axis #35;x &amp;y")
    );
    let loc_err = render("radar-beta\ncurve a{1 %% c\n", &css_options()).unwrap_err();
    assert_eq!((loc_err.line, loc_err.column), (2, 10));
    assert!(
        render("radar-beta\n curve c{ B: 2 }", &css_options())
            .unwrap_err()
            .message
            .contains("Axes must be populated before curves for reference entries")
    );

    // Keyword-prefixed names & glued option values.
    let prefixed = parse(
        "radar-beta\n axis circles, polygonal, trueNorth, falsey, titles\n curve titles{1, 2, 3, 4, 5}, circles{ circles: 1, polygonal 2, trueNorth: 3, falsey 4, titles: 5 }",
        &ParseOptions::default(),
    )
    .unwrap();
    match prefixed.model {
        ParsedModel::Radar(m) => {
            assert_eq!(
                m.axes.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(),
                vec!["circles", "polygonal", "trueNorth", "falsey", "titles"]
            );
            assert_eq!(m.title, None);
        }
        other => panic!("expected Radar, got {other:?}"),
    }
    let glued = parse(
        "radar-beta\n axis a, b\n showLegend falsecurve x{1, 2}\n graticule polygonaxis c",
        &ParseOptions::default(),
    )
    .unwrap();
    match glued.model {
        ParsedModel::Radar(m) => {
            assert!(!m.options.show_legend);
            assert_eq!(m.options.graticule, Graticule::Polygon);
            assert_eq!(m.axes.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), vec!["a", "b", "c"]);
        }
        other => panic!("expected Radar, got {other:?}"),
    }
    assert!(parse("radar-beta\n axis circle, b", &ParseOptions::default()).is_err());

    // Repeated options & tick cap at 32.
    let opts_parsed = parse(
        "radar-beta\n ticks 3\n ticks 100\n max 5\n max 7\n graticule polygon\n showLegend false",
        &ParseOptions::default(),
    )
    .unwrap();
    match opts_parsed.model {
        ParsedModel::Radar(m) => {
            assert_eq!(m.options.ticks, 32.0);
            assert_eq!(m.options.max, Some(7.0));
            assert_eq!(m.options.min, 0.0);
            assert!(!m.options.show_legend);
            assert_eq!(m.options.graticule, Graticule::Polygon);
        }
        other => panic!("expected Radar, got {other:?}"),
    }

    // Degenerate ranges & empty cases must stay finite and resvg-valid.
    for src in [
        "radar-beta".to_string(),
        "radar-beta\n axis A, B, C".to_string(),
        "radar-beta\n axis A\n curve c{5}".to_string(),
        "radar-beta\n curve c{1,2,3}".to_string(),
        "radar-beta\n axis A, B\n curve c{1,1}\n min 1\n max 1".to_string(),
        "radar-beta\n axis A, B\n curve c{1,2}\n min 9\n max 2".to_string(),
        "radar-beta\n axis A, B\n curve c{0,0}".to_string(),
        "radar-beta\n axis A, B\n curve c{1,2}\n ticks 0".to_string(),
        "radar-beta\n axis A, B\n curve c{1,2}\n ticks 0.3\n graticule polygon".to_string(),
        format!("radar-beta\n axis A, B\n curve c{{1,2}}\n max {}", "9".repeat(400)),
        format!("radar-beta\n axis A, B\n curve c{{{},2}}", "9".repeat(400)),
        configured("    width: -5\n    height: \"tall\"\n    curveTension: 99\n    marginTop: -1", BASIC),
    ] {
        let r = render(&src, &resolved_options()).unwrap();
        assert!(!r.svg.contains("NaN") && !r.svg.contains("Infinity"), "{src}");
        assert_inert_resolved(&r.svg, &src);
        assert_resvg_parses(&r.svg, &src);
    }
}

#[test]
fn radar_corpus_hostile_and_fuzz_are_inert_and_resvg_safe() {
    let corpus = load_fixture("radar-corpus.json");
    assert_eq!(corpus.len(), 23);
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
    assert!(rendered_corpus >= 10, "rendered_corpus={rendered_corpus}");

    let mut rendered_hostile = 0usize;
    for &p in PAYLOADS {
        let templates = [
            format!("radar-beta\n axis a[\"{p}\"], b, c\n curve x{{1,2,3}}"),
            format!("radar-beta\n axis a['{p}'], b, c\n curve x{{1,2,3}}"),
            format!("radar-beta\n axis a, b, c\n curve x[\"{p}\"]{{1,2,3}}"),
            format!("radar-beta\n title {p}\n axis a, b\n curve x{{1,2}}"),
            format!("radar-beta\n accTitle: {p}\n accDescr: {p}\n axis a, b\n curve x{{1,2}}"),
            format!("radar-beta\n accDescr {{\n {p}\n }}\n axis a, b\n curve x{{1,2}}"),
            format!("---\ntitle: \"{p}\"\nconfig:\n  radar:\n    width: \"{p}\"\n    curveTension: \"{p}\"\n---\nradar-beta\n axis a, b\n curve x{{1,2}}"),
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
        let opts = RenderOptions {
            id_prefix: Some(p.to_string()),
            font_family: Some(p.to_string()),
            ..css_options()
        };
        assert_inert(&render("radar-beta\n accTitle: t\n axis a, b\n curve x{1,2}", &opts).unwrap().svg, p);
    }
    assert!(rendered_hostile > 120, "rendered_hostile={rendered_hostile}");

    let mut frags: Vec<&str> = PAYLOADS.to_vec();
    frags.extend_from_slice(&[
        "\"",
        "'",
        "[",
        "]",
        "{",
        "}",
        ":",
        ",",
        "\n",
        "title ",
        "axis ",
        "curve c{1,2}",
        "max 3",
        "graticule polygon",
    ]);
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
fn radar_worst_cases_stay_linear() {
    let big = RenderOptions {
        limit: Some(usize::MAX),
        ..css_options()
    };
    let n = 50_000usize;
    let parse_cases = [
        format!("radar-beta\ncurve c{{{}}}", "0".repeat(n)),
        format!("radar-beta\nmax {}.5", "0".repeat(n)),
        format!("radar-beta\ncurve c{{{}}}", "1.2".repeat(n / 3)),
        format!("radar-beta\naxis a{}", "-".repeat(n)),
        format!("radar-beta\n{}", "accDescr {".repeat(n / 10)),
        format!("radar-beta\naccDescr {{{}", " a\n".repeat(n / 3)),
        format!("radar-beta\naxis a[\"{}", "x".repeat(n)),
        format!("radar-beta\n{}", "%%{\n".repeat(n / 4)),
        format!("radar-beta\n{}", "---\n".repeat(n / 4)),
    ];
    for src in &parse_cases {
        let started = Instant::now();
        let _ = parse_radar(src, None);
        assert!(started.elapsed().as_millis() < 2000);
    }

    let axes_2k: String = (0..2000).map(|i| format!("a{i}")).collect::<Vec<_>>().join(",");
    let entries_2k: String = (0..2000).map(|i| format!("a{} {i}", 1999 - i)).collect::<Vec<_>>().join(",");
    let curves_2k: String = (0..2000).map(|i| format!("curve c{i}{{1,2,3}}\n")).collect();
    let render_cases = [
        format!("radar-beta\naxis {axes_2k}\ncurve x{{{entries_2k}}}\ncurve y{{{entries_2k}}}"),
        format!("radar-beta\naxis a,b,c\n{curves_2k}"),
        format!("radar-beta\naxis a\ncurve c{{1}}\nmax {}", "9".repeat(n)),
        format!("radar-beta\ntitle {}", "x".repeat(n)),
    ];
    for src in &render_cases {
        let started = Instant::now();
        let _ = render(src, &big);
        assert!(started.elapsed().as_millis() < 2000);
    }
    let over = render(&format!("radar-beta\n{}", "axis a\n".repeat(10000)), &css_options()).unwrap_err();
    assert_eq!(over.code, ErrorCode::Limit);
}
