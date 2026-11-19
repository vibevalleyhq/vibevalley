mod support;

use std::time::Instant;

use regex::Regex;
use vibevalley_pele::detect::DiagramType;
use vibevalley_pele::{ErrorCode, METRICS_MEASURER, ParseOptions, ParsedModel, RenderOptions, TextMeasurer, TextStyle, parse, render, supports};

use support::{Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, css_options, load_fixture, resolved_options};

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

#[test]
fn pie_draws_slices_percentages_and_legend() {
    let res = render("pie title Pets\n \"Dogs\" : 386\n \"Cats\" : 85\n \"Rats\" : 15", &css_options()).unwrap();
    assert_eq!(res.diagram_type, DiagramType::Pie);
    assert!(supports("pie\n \"a\": 1"));
    assert_eq!(res.svg.matches(r#"class="pele-slice""#).count(), 3);
    assert_eq!(res.svg.matches(r#"class="pele-legend-item""#).count(), 3);
    assert!(res.svg.contains(">79%<"));
    assert!(res.svg.contains(">Pets<"));
    assert!(res.svg.contains("var(--pele-series-1,"));

    // Also render in default Resolved mode and validate with resvg/usvg.
    let resolved = render("pie title Pets\n \"Dogs\" : 386\n \"Cats\" : 85\n \"Rats\" : 15", &resolved_options()).unwrap();
    assert_inert_resolved(&resolved.svg, "pie pets");
    assert_resvg_parses(&resolved.svg, "pie pets");
}

#[test]
fn pie_show_data_tiny_slices_empty_and_config_options() {
    assert!(
        render("pie showData\n \"A\" : 42.96\n \"B\" : 50", &css_options())
            .unwrap()
            .svg
            .contains("A [42.96]")
    );

    let tiny = render("pie\n \"Big\" : 1000\n \"Tiny\" : 1", &css_options()).unwrap();
    assert_eq!(tiny.svg.matches(r#"class="pele-slice""#).count(), 1);
    assert_eq!(tiny.svg.matches(r#"class="pele-legend-item""#).count(), 2);

    assert!(render("pie\n \"Only\" : 5", &css_options()).unwrap().svg.contains(">100%<"));
    assert!(!render("pie\n \"Zero\" : 0", &css_options()).unwrap().svg.contains("NaN"));
    let empty = render("pie", &resolved_options()).unwrap();
    assert!(empty.svg.contains("<svg"));
    assert_resvg_parses(&empty.svg, "empty pie");

    let plain = render("pie\n \"A\" : 1\n \"B\" : 1", &css_options()).unwrap();
    let donut = render("---\nconfig:\n  pie:\n    donutHole: 0.5\n---\npie\n \"A\" : 1\n \"B\" : 1", &css_options()).unwrap();
    let below = render(
        "---\nconfig:\n  pie:\n    legendPosition: bottom\n---\npie\n \"A\" : 1\n \"B\" : 1",
        &css_options(),
    )
    .unwrap();
    assert_ne!(donut.svg, plain.svg);
    assert!(below.height > plain.height);
    assert!(below.width < plain.width);
    assert_resvg_parses(
        &render(
            "---\nconfig:\n  pie:\n    donutHole: 0.5\n---\npie\n \"A\" : 1\n \"B\" : 1",
            &resolved_options(),
        )
        .unwrap()
        .svg,
        "donut pie",
    );
}

#[test]
fn pie_spreads_thin_slice_outside_labels_and_handles_max_width() {
    let svg = render(
        "pie\n \"Calcium\" : 2\n \"Potassium\" : 2.4\n \"Magnesium\" : 46\n \"Test\" : 50",
        &css_options(),
    )
    .unwrap()
    .svg;
    let re_group = Regex::new(r#"<g class="pele-slice-labels"[^>]*font-size="(\d+)" text-anchor="middle">(.*?)</g>"#).unwrap();
    let outside = re_group
        .captures_iter(&svg)
        .find(|c| !c[0].contains("fill="))
        .expect("missing outside slice labels group");
    let size: f64 = outside[1].parse().unwrap();
    let re_text = Regex::new(r#"<text x="([-\d.]+)" y="([-\d.]+)">([^<]*)</text>"#).unwrap();
    let boxes: Vec<(f64, f64, f64)> = re_text
        .captures_iter(&outside[2])
        .map(|c| {
            let x: f64 = c[1].parse().unwrap();
            let y: f64 = c[2].parse().unwrap();
            let w = METRICS_MEASURER.width(&c[3], size, TextStyle::NONE);
            (x, y, w)
        })
        .collect();
    assert_eq!(boxes.len(), 2);
    let (ax, ay, aw) = boxes[0];
    let (bx, by, bw) = boxes[1];
    let apart = (ax - bx).abs() >= (aw + bw) / 2.0 || (ay - by).abs() >= size;
    assert!(apart, "thin slice outside labels overlapped: {boxes:?}");

    // maxWidth moves legend below unless explicitly placed.
    let pets = "pie title Pets\n  \"Dogs\" : 386\n  \"Cats\" : 85\n  \"Rats\" : 15";
    let wide = render(pets, &css_options()).unwrap();
    let narrow = render(
        pets,
        &RenderOptions {
            max_width: Some(320.0),
            ..css_options()
        },
    )
    .unwrap();
    assert!(narrow.width <= 320.0);
    assert!(narrow.width < wide.width);
    assert!(narrow.height > wide.height);
    let placed = format!("---\nconfig:\n  pie:\n    legendPosition: bottom\n---\n{pets}");
    assert_eq!(
        render(
            &placed,
            &RenderOptions {
                max_width: Some(320.0),
                ..css_options()
            }
        )
        .unwrap()
        .svg,
        render(&placed, &css_options()).unwrap().svg
    );
}

#[test]
fn pie_title_negative_validation_and_parsed_model() {
    assert!(
        render("---\ntitle: From front matter\n---\npie\n \"A\" : 1", &css_options())
            .unwrap()
            .svg
            .contains("From front matter")
    );
    assert!(
        render("---\ntitle: From front matter\n---\npie title Own\n \"A\" : 1", &css_options())
            .unwrap()
            .svg
            .contains(">Own<")
    );

    let err1 = render("pie\n \"#35;x &amp;y\" : -1", &css_options()).unwrap_err();
    assert_eq!(err1.code, ErrorCode::Semantic);
    assert!(err1.message.contains("\"#35;x &amp;y\" has invalid value: -1."));

    let err2 = render("pie\n \"dogs\" : -60.67", &css_options()).unwrap_err();
    assert_eq!(
        err2.message,
        "\"dogs\" has invalid value: -60.67. Negative values are not allowed in pie charts. All slice values must be >= 0."
    );

    let parsed = parse("pie showData\n \"A\" : 1\n \"A\" : 2\n \"B\" : 3", &ParseOptions::default()).unwrap();
    assert_eq!(parsed.diagram_type, DiagramType::Pie);
    match &parsed.model {
        ParsedModel::Pie(m) => {
            let entries: Vec<(&str, f64)> = m.sections.iter().map(|(k, v)| (k.as_str(), *v)).collect();
            assert_eq!(entries, vec![("A", 1.0), ("B", 3.0)]);
            assert!(m.show_data);
        }
        other => panic!("expected Pie model, got {other:?}"),
    }
}

#[test]
fn pie_is_inert_for_corpus_hostile_and_mutated_inputs() {
    let corpus = load_fixture("pie-corpus.json");
    assert!(corpus.len() >= 20);
    for src in &corpus {
        if let Some(svg) = try_render_css(src) {
            assert_inert(&svg, src);
        }
        if let Some(svg) = try_render_resolved(src) {
            assert_inert_resolved(&svg, src);
            assert_resvg_parses(&svg, src);
        }
    }

    let mut rendered = 0usize;
    for &payload in PAYLOADS {
        let templates = [
            format!("pie title {payload}\n \"a\" : 1"),
            format!("pie\n \"{payload}\" : 1\n \"b\" : 2"),
            format!("pie\n accTitle: {payload}\n accDescr: {payload}\n \"a\" : 1"),
            format!("pie\n accDescr {{\n {payload}\n }}\n \"a\" : 1"),
            format!("---\ntitle: \"{payload}\"\nconfig:\n  pie:\n    legendPosition: \"{payload}\"\n    textPosition: \"{payload}\"\n---\npie\n \"a\" : 1"),
        ];
        for src in templates {
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
    assert!(rendered > 60, "rendered={rendered}");

    let mut frags: Vec<&str> = PAYLOADS.to_vec();
    frags.extend_from_slice(&["\"", ":", "\n", "title ", "showData"]);
    let mut mutator = Mutator::new(&corpus, frags, 5);
    for _ in 0..2000 {
        let src = mutator.next_sample();
        if let Some(svg) = try_render_css(&src) {
            assert_inert(&svg, &src);
        }
    }
}

#[test]
fn pie_stays_fast_on_oversized_and_digit_run_inputs() {
    let big = RenderOptions {
        limit: Some(usize::MAX),
        ..css_options()
    };
    let mut sections_5000 = String::from("pie\n");
    for i in 0..5000 {
        sections_5000.push_str(&format!("\"s{i}\" : {i}\n"));
    }
    let cases = [
        sections_5000,
        format!("pie title {}", "x".repeat(50_000)),
        format!("pie\n\"{}", "a".repeat(50_000)),
        format!("pie\n{}", "%%{\n".repeat(12_000)),
        format!("pie\n{}", "x ---\n".repeat(8_000)),
        format!("pie\naccDescr {{{}", " a\n".repeat(15_000)),
        format!("pie\n{}\"a\":1", " ".repeat(50_000)),
    ];
    for src in &cases {
        let started = Instant::now();
        let _ = render(src, &big);
        assert!(
            started.elapsed().as_millis() < 2000,
            "slow pie render on {:?}: {:?}",
            &src[..src.len().min(30)],
            started.elapsed()
        );
    }

    for tail in [
        "0".repeat(49_000),
        format!("{}.", "0".repeat(49_000)),
        format!("{}..", "9".repeat(49_000)),
        format!("-{}", "1.".repeat(24_000)),
    ] {
        let started = Instant::now();
        let res = render(&format!("pie\n\"a\": {tail}"), &css_options());
        assert!(res.is_err());
        assert!(started.elapsed().as_millis() < 500, "slow pie digit run: {:?}", started.elapsed());
    }
}
