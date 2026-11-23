use std::time::Instant;

use regex::Regex;
use vibevalley_pele::detect::DiagramType;
use vibevalley_pele::diagram::xychart::db::{DataPoint, Orientation, PlotKind, XyAxis, XyChartModel, XyText, js_number_string};
use vibevalley_pele::diagram::xychart::lexer::tokenize;
use vibevalley_pele::diagram::xychart::ticks::{tick_step, tick_value, ticks_between};
use vibevalley_pele::{ErrorCode, ParseOptions, ParsedModel, RenderOptions, parse, render, supports};

use crate::support::{Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, css_options, dark_options, load_fixture, resolved_options};

const CHART: &str = "xychart
  title \"Sales Revenue\"
  x-axis \"Month\" [jan, feb, mar]
  y-axis \"Revenue (in $)\" 4000 --> 10000
  bar \"2024\" [5000, 6000, 7500]
  line \"2025\" [5500, 7000, 9000]";

fn configured(body: &str, chart: &str) -> String {
    format!("---\nconfig:\n  xyChart:\n{body}\n---\n{chart}")
}

fn ticks(lo: f64, hi: f64, count: f64) -> Vec<f64> {
    ticks_between(lo, hi, tick_step(hi - lo, count))
}

fn texts(svg: &str) -> Vec<String> {
    let re = Regex::new(r"<text[^>]*>(?:<tspan[^>]*>)?([^<]*)").unwrap();
    re.captures_iter(svg).map(|c| c[1].to_string()).collect()
}

fn rect_boxes(svg: &str) -> Vec<[f64; 4]> {
    let doc = roxmltree::Document::parse(svg).unwrap();
    doc.descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "rect")
        .map(|n| {
            [
                n.attribute("x").unwrap().parse().unwrap(),
                n.attribute("y").unwrap().parse().unwrap(),
                n.attribute("width").unwrap().parse().unwrap(),
                n.attribute("height").unwrap().parse().unwrap(),
            ]
        })
        .collect()
}

fn circle_cxs(svg: &str) -> Vec<f64> {
    let doc = roxmltree::Document::parse(svg).unwrap();
    doc.descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "circle")
        .map(|n| n.attribute("cx").unwrap().parse().unwrap())
        .collect()
}

fn assert_close(actual: f64, expected: f64, tol: f64) {
    assert!((actual - expected).abs() <= tol, "expected {actual} to be within {tol} of {expected}");
}

#[test]
fn xychart_tick_selection_steps_decimals_and_extreme_ranges() {
    assert_eq!(ticks(0.0, 100.0, 10.0), vec![0.0, 10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0, 100.0]);
    assert_eq!(ticks(0.0, 100.0, 4.0), vec![0.0, 20.0, 40.0, 60.0, 80.0, 100.0]);
    assert_eq!(
        ticks(4000.0, 11000.0, 7.0),
        vec![4000.0, 5000.0, 6000.0, 7000.0, 8000.0, 9000.0, 10000.0, 11000.0]
    );
    assert_eq!(ticks(0.0, 198.2, 8.0), vec![0.0, 20.0, 40.0, 60.0, 80.0, 100.0, 120.0, 140.0, 160.0, 180.0]);
    assert_eq!(ticks(-6.0, 8.0, 7.0), vec![-6.0, -4.0, -2.0, 0.0, 2.0, 4.0, 6.0, 8.0]);
    assert_eq!(ticks(3.0, 7.0, 2.0), vec![4.0, 6.0]);

    assert_eq!(ticks(0.0, 1.0, 10.0), vec![0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]);
    assert_eq!(ticks(0.3, 0.7, 4.0), vec![0.3, 0.4, 0.5, 0.6, 0.7]);
    assert_eq!(ticks(-0.34, 2.4, 6.0), vec![0.0, 0.5, 1.0, 1.5, 2.0]);
    let tiny_strs: Vec<String> = ticks(0.0, 0.0005, 5.0).into_iter().map(js_number_string).collect();
    assert_eq!(tiny_strs, vec!["0", "0.0001", "0.0002", "0.0003", "0.0004", "0.0005"]);

    assert_eq!(ticks(0.0, 1e300, 5.0), vec![0.0, 2e299, 4e299, 6e299, 8e299, 1e300]);
    assert!(ticks(0.0, 1e-12, 2.0).len() > 1);
    assert!(ticks(1e15, 1e15 + 10.0, 5.0).len() > 1);
    assert_eq!(tick_value(tick_step(1.0, 10.0), 3.0), 0.3);
}

#[test]
fn xychart_rendering_bars_lines_orientation_labels_and_config() {
    let res = render(CHART, &css_options()).unwrap();
    assert_eq!(res.diagram_type, DiagramType::XyChart);
    assert!(supports("xychart-beta\nline [1]"));
    assert_eq!((res.width, res.height), (700.0, 500.0));
    assert!(res.svg.contains(r#"class="pele pele-xychart""#));
    assert!(res.svg.contains(r#"class="pele-grid""#));
    assert!(res.svg.contains(r#"class="pele-axis""#));
    assert_eq!(res.svg.matches(r#"class="pele-legend-item""#).count(), 2);
    let re_bars = Regex::new(r#"<g class="pele-series pele-bars" data-id="2024" fill="([^"]+)">(.*?)</g>"#).unwrap();
    let bars_cap = re_bars.captures(&res.svg).unwrap();
    assert!(bars_cap[1].contains("--pele-series-1"));
    assert_eq!(bars_cap[2].matches("<rect").count(), 3);
    let re_line = Regex::new(r#"<g class="pele-series pele-line" data-id="2025" fill="([^"]+)">(.*?)</g>"#).unwrap();
    let line_cap = re_line.captures(&res.svg).unwrap();
    assert!(line_cap[1].contains("--pele-series-2"));
    assert_eq!(line_cap[2].matches("<circle").count(), 3);
    let txts = texts(&res.svg);
    for expected in [
        "Sales Revenue",
        "Month",
        "Revenue (in $)",
        "jan",
        "feb",
        "mar",
        "4000",
        "7000",
        "10000",
        "2024",
        "2025",
    ] {
        assert!(txts.contains(&expected.to_string()), "missing text {expected:?} in {txts:?}");
    }

    // Light and dark resolved palettes parse cleanly in resvg/usvg.
    let light = render(CHART, &resolved_options()).unwrap();
    assert_inert_resolved(&light.svg, "xychart light");
    assert_resvg_parses(&light.svg, "xychart light");
    let dark = render(CHART, &dark_options()).unwrap();
    assert_inert_resolved(&dark.svg, "xychart dark");
    assert_resvg_parses(&dark.svg, "xychart dark");

    // Lines drawn over bars, preserving source series color indices.
    let order = render("xychart\n line [1, 2]\n bar [2, 1]\n line [3, 3]\n bar [1, 1]", &css_options())
        .unwrap()
        .svg;
    let re_series = Regex::new(r#"class="pele-series pele-(\w+)" fill="var\(--pele-series-(\d)"#).unwrap();
    let seq: Vec<String> = re_series.captures_iter(&order).map(|c| format!("{}{}", &c[1], &c[2])).collect();
    assert_eq!(seq, vec!["bars2", "bars4", "line1", "line3"]);

    // Side-by-side bar scaling.
    let side = render("xychart\n x-axis [a, b]\n y-axis 0 --> 100\n bar [50, 100]\n bar [25, 75]", &css_options())
        .unwrap()
        .svg;
    let rects = rect_boxes(&side);
    assert_eq!(rects.len(), 4);
    assert_close(rects[1][3], rects[0][3] * 2.0, 0.2);
    assert_close(rects[2][3], rects[0][3] / 2.0, 0.2);
    assert_close(rects[3][3], rects[0][3] * 1.5, 0.2);
    assert_close(rects[0][1] + rects[0][3], rects[3][1] + rects[3][3], 0.2);
    assert!(rects[2][0] >= rects[0][0] + rects[0][2]);
    assert!(rects[1][0] > rects[2][0] + rects[2][2]);

    // Bars stand on zero when range comes from data.
    let zero_base = rect_boxes(&render("xychart\n bar [5000, 10000]", &css_options()).unwrap().svg);
    assert_close(zero_base[1][3], zero_base[0][3] * 2.0, 0.2);
    assert!(zero_base[0][3] > 100.0);
    let mixed = rect_boxes(&render("xychart\n bar [4, -4]", &css_options()).unwrap().svg);
    assert!(mixed[1][1] > mixed[0][1]);

    // Explicit range clipping.
    let clipped = render(
        "xychart\n x-axis [a, b, c]\n y-axis 10 --> 20\n bar [5, 15, 40]\n line [0, 15, 30]",
        &css_options(),
    )
    .unwrap()
    .svg;
    let c_texts = texts(&clipped);
    assert!(c_texts.contains(&"10".to_string()));
    assert!(c_texts.contains(&"20".to_string()));
    assert!(!c_texts.contains(&"0".to_string()));
    assert!(!c_texts.contains(&"40".to_string()));
    let c_rects = rect_boxes(&clipped);
    assert_eq!(c_rects[0][3], 0.0);
    assert_close(c_rects[2][3], c_rects[1][3] * 2.0, 0.2);
    assert_eq!(circle_cxs(&clipped).len(), 1);

    // Numeric x-axis spreading.
    let num_x = render("xychart\n x-axis \"t\" 0 --> 10\n line [1, 2, 3]", &css_options()).unwrap().svg;
    let xs = circle_cxs(&num_x);
    assert_close(xs[1] - xs[0], xs[2] - xs[1], 0.2);
    for tick in ["0", "5", "10"] {
        assert!(texts(&num_x).contains(&tick.to_string()));
    }
    let auto_x = render("xychart\n line [5, 6, 7, 8]", &css_options()).unwrap().svg;
    for tick in ["1", "2", "3", "4"] {
        assert!(texts(&auto_x).contains(&tick.to_string()));
    }

    // Horizontal orientation & config override.
    let base_src = "x-axis [a, b]\n y-axis 0 --> 10\n bar [5, 10]";
    let v_boxes = rect_boxes(&render(&format!("xychart\n {base_src}"), &css_options()).unwrap().svg);
    assert_close(v_boxes[1][3], v_boxes[0][3] * 2.0, 0.2);
    assert_eq!(v_boxes[1][2], v_boxes[0][2]);
    assert!(v_boxes[1][0] > v_boxes[0][0]);
    let h_svg = render(&format!("xychart horizontal\n {base_src}"), &css_options()).unwrap().svg;
    let h_boxes = rect_boxes(&h_svg);
    assert_close(h_boxes[1][2], h_boxes[0][2] * 2.0, 0.2);
    assert_eq!(h_boxes[1][3], h_boxes[0][3]);
    assert_eq!(h_boxes[1][0], h_boxes[0][0]);
    assert!(h_boxes[1][1] > h_boxes[0][1]);
    let from_cfg = render(
        &configured("    chartOrientation: horizontal", &format!("xychart\n {base_src}")),
        &css_options(),
    )
    .unwrap()
    .svg;
    assert_eq!(from_cfg, h_svg);
    let overridden = render(
        &configured("    chartOrientation: horizontal", &format!("xychart vertical\n {base_src}")),
        &css_options(),
    )
    .unwrap()
    .svg;
    assert_eq!(overridden, render(&format!("xychart\n {base_src}"), &css_options()).unwrap().svg);

    // Point labels on lines (bar point labels ignored).
    let pl = render(
        "xychart\n x-axis [Q1, Q2, Q3]\n line [25 \"Launch\", 45, 72 \"Target\"]\n bar [1 \"ignored\", 2, 3]",
        &css_options(),
    )
    .unwrap()
    .svg;
    let re_pl = Regex::new(r#"<g class="pele-point-labels"[^>]*>(.*?)</g>"#).unwrap();
    assert_eq!(texts(&re_pl.captures(&pl).unwrap()[1]), vec!["Launch", "Target"]);
    assert!(!pl.contains("ignored"));

    // Size, show settings, showDataLabel, useMaxWidth, palette, and max_width.
    let sized = render(&configured("    width: 900\n    height: 400", CHART), &css_options()).unwrap();
    assert_eq!((sized.width, sized.height), (900.0, 400.0));
    assert!(
        !render(&configured("    showTitle: false", CHART), &css_options())
            .unwrap()
            .svg
            .contains("Sales Revenue")
    );
    assert!(
        !render(&configured("    showLegend: false", CHART), &css_options())
            .unwrap()
            .svg
            .contains("pele-legend")
    );
    let data_src = "xychart\n x-axis [a, b, c]\n y-axis 0 --> 30\n bar [12, 2, 25]\n bar [7, 30, 1]";
    let with_data = render(&configured("    showDataLabel: true", data_src), &css_options()).unwrap().svg;
    let re_dl = Regex::new(r#"<g class="pele-data-labels"[^>]*>(.*?)</g>"#).unwrap();
    let mut vals = texts(&re_dl.captures(&with_data).unwrap()[1]);
    vals.sort();
    assert_eq!(vals, vec!["1", "12", "2", "25", "30", "7"]);

    // Thinning 200 categories.
    let cats: Vec<String> = (0..200).map(|i| format!("category{i}")).collect();
    let nums: Vec<String> = (0..200).map(|i| i.to_string()).collect();
    let dense = render(&format!("xychart\n x-axis [{}]\n bar [{}]", cats.join(", "), nums.join(", ")), &css_options())
        .unwrap()
        .svg;
    let shown: Vec<String> = texts(&dense).into_iter().filter(|t| t.starts_with("category")).collect();
    assert!(shown.len() > 3 && shown.len() < 15);
    assert_eq!(rect_boxes(&dense).len(), 200);

    // Palette overrides + useMaxWidth: false + max_width.
    let pal = render(
        "---\nconfig:\n  themeVariables:\n    xyChart:\n      plotColorPalette: '#ff0000, #00ff00'\n---\nxychart\n bar [1, 2]\n line [2, 1]",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(pal.contains("--pele-series-1:#ff0000"));
    assert!(pal.contains("--pele-series-2:#00ff00"));
    assert!(pal.contains("--pele-series-3:#ff0000"));
    let fixed = render(&configured("    useMaxWidth: false", CHART), &resolved_options()).unwrap().svg;
    assert!(!fixed.contains("max-width:100%"));
    let narrow = render(
        CHART,
        &RenderOptions {
            max_width: Some(360.0),
            ..resolved_options()
        },
    )
    .unwrap();
    assert!(narrow.width <= 360.0);
    assert_resvg_parses(&narrow.svg, "narrow xychart");
}

#[test]
fn xychart_parser_model_compat_and_errors() {
    let err = render("xychart\n title \"Empty\"", &css_options()).unwrap_err();
    assert_eq!(err.code, ErrorCode::Semantic);
    assert_eq!(err.diagram_type, Some(DiagramType::XyChart));
    assert!(err.message.contains("No Plot to render, please provide a plot with some data"));
    assert!(render("xychart\n line [1, 2", &css_options()).is_err());
    assert!(render("xychart\n x-axis [é]\n line [1]", &css_options()).is_err());

    let parsed = parse(
        "xychart horizontal\n title \"T\"\n x-axis \"x\" [a, b]\n y-axis \"y\" 0 --> 5\n bar \"s\" [1, 2, 3]\n line [2 \"p\", 1]",
        &ParseOptions::default(),
    )
    .unwrap();
    match parsed.model {
        ParsedModel::XyChart(m) => {
            assert_eq!(m.title.as_deref(), Some("T"));
            assert_eq!(m.orientation, Some(Orientation::Horizontal));
            assert_eq!(
                m.x_axis,
                XyAxis::Band {
                    title: "x".to_string(),
                    categories: vec!["a".to_string(), "b".to_string()]
                }
            );
            assert_eq!((m.y_axis_title.as_str(), m.y_min, m.y_max), ("y", 0.0, 5.0));
            assert_eq!(m.plots.len(), 2);
            assert_eq!(m.plots[0].kind, PlotKind::Bar);
            assert_eq!(m.plots[0].title, "s");
            assert_eq!(m.plots[0].data, vec![("a".to_string(), Some(1.0)), ("b".to_string(), Some(2.0))]);
            assert_eq!(m.plots[1].kind, PlotKind::Line);
            assert_eq!(m.plots[1].point_labels, Some(vec!["p".to_string(), String::new()]));
        }
        other => panic!("expected XyChart, got {other:?}"),
    }

    // Comment handling.
    let comment = parse("xychart-beta\nx-axis [a, b]\nbar [1,2]%% note", &ParseOptions::default()).unwrap();
    assert_eq!(comment.diagram_type, DiagramType::XyChart);
    assert!(parse("xychart-beta\ntitle Sales:%% note\nbar [1,2]", &ParseOptions::default()).is_err());

    // Direct DB truncation & y-range from visible points (xychartDb.spec.ts).
    let mut db = XyChartModel::new();
    db.set_x_axis_band(vec![XyText::plain("Q1"), XyText::plain("Q2")]);
    db.set_bar_data(
        XyText::plain("sales"),
        vec![
            DataPoint {
                value: 10.0,
                label: String::new(),
            },
            DataPoint {
                value: 50.0,
                label: String::new(),
            },
            DataPoint {
                value: 999.0,
                label: String::new(),
            },
            DataPoint {
                value: 800.0,
                label: String::new(),
            },
        ],
    );
    assert_eq!(db.plots[0].data.len(), 2);
    assert_eq!(db.y_max, 50.0);

    // Accessibility + front matter title.
    let acc = render("xychart\n accTitle: Sales\n accDescr: By month\n line [1, 2]", &css_options())
        .unwrap()
        .svg;
    assert!(acc.contains(r#"<title id="pele-title">Sales</title>"#));
    assert!(acc.contains(r#"<desc id="pele-desc">By month</desc>"#));
    assert!(
        render("---\ntitle: From front matter\n---\nxychart\n line [1, 2]", &css_options())
            .unwrap()
            .svg
            .contains("From front matter")
    );
    assert!(
        render("---\ntitle: From front matter\n---\nxychart\n title Own\n line [1, 2]", &css_options())
            .unwrap()
            .svg
            .contains(">Own<")
    );
}

#[test]
fn xychart_corpus_hostile_extreme_and_fuzz_are_inert_and_resvg_safe() {
    let corpus = load_fixture("xychart-corpus.json");
    assert_eq!(corpus.len(), 74);
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
    assert!(rendered_corpus > 25, "rendered_corpus={rendered_corpus}");

    let mut rendered_hostile = 0usize;
    for &p in PAYLOADS {
        let templates = [
            format!("xychart\n  title \"{p}\"\n  line [1, 2]"),
            format!("xychart\n  x-axis \"{p}\" [\"{p}\", \"b\"]\n  bar [1, 2]"),
            format!("xychart\n  y-axis \"{p}\" 0 --> 10\n  bar [1, 2]"),
            format!("xychart\n  line \"{p}\" [1 \"{p}\", 2 \"{p}\"]\n  bar \"{p}\" [2, 1]"),
            format!("xychart horizontal\n  x-axis [\"{p}\", \"b\"]\n  line \"{p}\" [1 \"{p}\", 2]\n  bar [3, 4]"),
            format!("xychart\n  accTitle: {p}\n  accDescr: {p}\n  line [1, 2]"),
            format!("xychart\n  accDescr {{\n {p}\n }}\n  line [1, 2]"),
            format!("---\ntitle: \"{p}\"\nconfig:\n  xyChart:\n    width: \"{p}\"\n    chartOrientation: \"{p}\"\n---\nxychart\n  bar \"s\" [1, 2]"),
            format!(
                "%%{{init: {{\"xyChart\": {{\"width\": \"{p}\", \"showDataLabel\": true}}, \"themeVariables\": {{\"xyChart\": {{\"plotColorPalette\": \"{p}\"}}}}}}}}%%\nxychart\n  bar [1, 2]"
            ),
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
        let opts_css = RenderOptions {
            id_prefix: Some(p.to_string()),
            font_family: Some(p.to_string()),
            ..css_options()
        };
        assert_inert(&render("xychart\n accTitle: t\n line \"s\" [1, 2]", &opts_css).unwrap().svg, p);
    }
    assert!(rendered_hostile > 150, "rendered_hostile={rendered_hostile}");

    // Extreme numbers.
    let huge = "9".repeat(400);
    for src in [
        format!("xychart\n  line [{huge}, 1]"),
        format!("xychart\n  bar [-{huge}, {huge}]\n  line [1, 2]"),
        format!("xychart\n  y-axis {huge} --> -{huge}\n  bar [1, 2]"),
        format!("xychart\n  x-axis {huge} --> {huge}\n  line [1, 2]\n  bar [1, 2]"),
        "xychart\n  y-axis 5 --> 5\n  bar [5, 5]".to_string(),
        "xychart\n  y-axis 9 --> 1\n  x-axis 9 --> 1\n  bar [5, 3]\n  line [2, 8]".to_string(),
        "xychart\n  bar [0, 0, 0]".to_string(),
        "xychart\n  line [7]".to_string(),
        "xychart horizontal\n  x-axis 5 --> 5\n  bar [1]".to_string(),
    ] {
        let r = render(&src, &resolved_options()).unwrap();
        assert_inert_resolved(&r.svg, &src);
        assert_resvg_parses(&r.svg, &src);
    }

    // Mutated fuzzing.
    let mut frags: Vec<&str> = PAYLOADS.to_vec();
    frags.extend_from_slice(&["\"", "[", "]", ",", "\n", " --> ", "line ", "bar ", "x-axis ", "y-axis ", "title ", "-", "."]);
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
fn xychart_worst_cases_stay_linear() {
    let big = RenderOptions {
        limit: Some(usize::MAX),
        ..css_options()
    };
    let n = 50_000usize;
    let lex_cases = [
        format!("xychart\n{}line [1]", " \n".repeat(n / 2)),
        format!("xychart\nx-axis a {}", "-".repeat(n)),
        format!("xychart\nline [{}]", "+-".repeat(n / 2)),
        format!("xychart\nline [{}]", "1.".repeat(n / 2)),
        format!("xychart\n{}", format!("accTitle{}", " ".repeat(40)).repeat(1000)),
        format!("xychart\n{}", format!("`){} {{ this", " ".repeat(36)).repeat(1000)),
    ];
    for src in &lex_cases {
        let started = Instant::now();
        let _ = tokenize(src);
        assert!(started.elapsed().as_millis() < 2000);
    }
    let vals_5k: String = (0..5000).map(|i| (i % 97).to_string()).collect::<Vec<_>>().join(",");
    let cats_2k: String = (0..2000).map(|i| format!("c{i}")).collect::<Vec<_>>().join(",");
    let ones_2k = format!("{}1", "1,".repeat(1999));
    let render_cases = [
        format!("xychart\nline [{vals_5k}]"),
        format!("xychart\nbar [{vals_5k}]"),
        format!("xychart\nx-axis [{cats_2k}]\nbar [{ones_2k}]"),
        format!("xychart\nline [{}, 1]", "9".repeat(n)),
        format!("xychart\ntitle \"{}\"\nline [1, 2]", "long title ".repeat(n / 11)),
        format!("xychart\naccDescr {{{}", " a\n".repeat(n / 3)),
    ];
    for src in &render_cases {
        let started = Instant::now();
        let _ = render(src, &big);
        assert!(started.elapsed().as_millis() < 2000);
    }
    let over = render(&format!("xychart\n{}", "line [1, 2, 3]\n".repeat(5000)), &css_options()).unwrap_err();
    assert_eq!(over.code, ErrorCode::Limit);
}
