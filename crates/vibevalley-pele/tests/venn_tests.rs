mod support;

use std::collections::HashMap;
use std::f64::consts::PI;
use std::time::Instant;

use regex::Regex;
use vibevalley_pele::detect::DiagramType;
use vibevalley_pele::diagram::venn::layout::{Circle, distance_for_overlap, find_spot, layout_circles, lens_area, region_path};
use vibevalley_pele::diagram::venn::lexer::{IndentHost, VennLexer, VennToken};
use vibevalley_pele::diagram::venn::types::VennSubset;
use vibevalley_pele::{ErrorCode, METRICS_MEASURER, ParseOptions, ParsedModel, RenderOptions, TextMeasurer, TextStyle, parse, render, supports};

use support::{Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, css_options, dark_options, load_fixture, resolved_options};

fn svg_of(body: &str) -> String {
    render(&format!("venn-beta\n{body}"), &css_options()).unwrap().svg
}

fn circles_of(svg: &str) -> HashMap<String, Circle> {
    let doc = roxmltree::Document::parse(svg).unwrap();
    let mut out = HashMap::new();
    for n in doc.descendants().filter(|n| n.is_element() && n.attribute("class") == Some("pele-venn-set")) {
        let id = n.attribute("data-id").unwrap().to_string();
        out.insert(
            id.clone(),
            Circle {
                id,
                x: n.attribute("cx").unwrap().parse().unwrap(),
                y: n.attribute("cy").unwrap().parse().unwrap(),
                r: n.attribute("r").unwrap().parse().unwrap(),
            },
        );
    }
    out
}

fn label_at(svg: &str, id: &str) -> (f64, f64, String) {
    let doc = roxmltree::Document::parse(svg).unwrap();
    let g = doc
        .descendants()
        .find(|n| n.is_element() && n.attribute("class") == Some("pele-venn-region") && n.attribute("data-id") == Some(id))
        .unwrap_or_else(|| panic!("no region {id}"));
    let text = g.children().find(|n| n.is_element() && n.tag_name().name() == "text").unwrap();
    let x: f64 = text.attribute("x").unwrap().parse().unwrap();
    let y: f64 = text.attribute("y").unwrap().parse().unwrap();
    let body = text.text().unwrap_or("").to_string();
    (x, y, body)
}

fn dist(ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    (ax - bx).hypot(ay - by)
}

fn area(c: &Circle) -> f64 {
    PI * c.r * c.r
}

fn assert_close(actual: f64, expected: f64, tol: f64) {
    assert!((actual - expected).abs() <= tol, "expected {actual} to be within {tol} of {expected}");
}

#[test]
fn venn_geometry_lens_distance_spot_and_region_path() {
    for &(r1, r2, wanted) in &[(1.0, 1.0, 0.5), (3.0, 1.0, 2.0), (2.0, 5.0, 0.01), (1.0, 1.0, 3.1)] {
        let d = distance_for_overlap(r1, r2, wanted);
        assert_close(lens_area(r1, r2, d), wanted, 1e-6);
    }
    assert_eq!(distance_for_overlap(2.0, 1.0, 0.0), 3.0);
    assert_eq!(distance_for_overlap(2.0, 1.0, -1.0), 3.0);
    assert_eq!(distance_for_overlap(2.0, 1.0, PI), 1.0);
    assert_eq!(distance_for_overlap(2.0, 1.0, 99.0), 1.0);
    assert_eq!(distance_for_overlap(2.0, 1.0, f64::NAN), 3.0);

    assert_eq!(lens_area(1.0, 1.0, 2.0), 0.0);
    assert_close(lens_area(1.0, 1.0, 0.0), PI, 1e-9);
    assert_close(lens_area(3.0, 1.0, 1.0), PI, 1e-9);
    assert_close(lens_area(1.0, 1.0, 1.0), (2.0 * PI) / 3.0 - 3.0f64.sqrt() / 2.0, 1e-9);

    let cs = vec![
        Circle {
            id: "a".to_string(),
            x: 0.0,
            y: 0.0,
            r: 10.0,
        },
        Circle {
            id: "b".to_string(),
            x: 12.0,
            y: 0.0,
            r: 10.0,
        },
    ];
    let alone = find_spot(&cs, &[0], &[]);
    assert_eq!((alone.x, alone.y, alone.margin), (0.0, 0.0, 10.0));
    let outside = find_spot(&cs, &[0], &[1]);
    assert_close(outside.x, -4.0, 0.1);
    assert_close(outside.y, 0.0, 0.1);
    assert_close(outside.margin, 6.0, 0.1);
    let lens = find_spot(&cs, &[0, 1], &[]);
    assert_close(lens.x, 6.0, 1e-3);
    assert_close(lens.margin, 4.0, 1e-3);
    assert!(
        find_spot(
            &[
                cs[0].clone(),
                Circle {
                    id: "c".to_string(),
                    x: 30.0,
                    y: 0.0,
                    r: 10.0
                }
            ],
            &[0, 1],
            &[]
        )
        .margin
            < 0.0
    );

    let f = |v: f64| -> String {
        let r = (v * 100.0).round() / 100.0;
        let r = if r == 0.0 { 0.0 } else { r };
        format!("{r}")
    };
    let a = Circle {
        id: "a".to_string(),
        x: 0.0,
        y: 0.0,
        r: 5.0,
    };
    assert_eq!(region_path(std::slice::from_ref(&a), f), "M-5,0A5,5 0 1 1 5,0A5,5 0 1 1 -5,0Z");
    assert_eq!(
        region_path(
            &[
                a.clone(),
                Circle {
                    id: "b".to_string(),
                    x: 6.0,
                    y: 0.0,
                    r: 5.0
                }
            ],
            f
        ),
        "M3,-4A5,5 0 0 1 3,4A5,5 0 0 1 3,-4Z"
    );
    assert_eq!(
        region_path(
            &[
                a.clone(),
                Circle {
                    id: "b".to_string(),
                    x: 20.0,
                    y: 0.0,
                    r: 5.0
                }
            ],
            f
        ),
        ""
    );
    assert_eq!(
        region_path(
            &[
                a,
                Circle {
                    id: "b".to_string(),
                    x: 1.0,
                    y: 0.0,
                    r: 2.0
                }
            ],
            f
        ),
        "M-1,0A2,2 0 1 1 3,0A2,2 0 1 1 -1,0Z"
    );

    let subsets = vec![
        VennSubset {
            sets: vec!["A".to_string()],
            size: 10.0,
            label: None,
        },
        VennSubset {
            sets: vec!["B".to_string()],
            size: 20.0,
            label: None,
        },
        VennSubset {
            sets: vec!["C".to_string()],
            size: 5.0,
            label: None,
        },
        VennSubset {
            sets: vec!["D".to_string()],
            size: 5.0,
            label: None,
        },
        VennSubset {
            sets: vec!["A".to_string(), "B".to_string()],
            size: 3.0,
            label: None,
        },
        VennSubset {
            sets: vec!["C".to_string(), "D".to_string()],
            size: 1.0,
            label: None,
        },
    ];
    assert_eq!(layout_circles(&subsets), layout_circles(&subsets));
}

#[test]
fn venn_rendering_overlaps_styles_contrast_and_compat() {
    let basic = "venn-beta\n  set A\n  set B\n  union A,B";
    assert!(supports(basic));
    let res = render(basic, &css_options()).unwrap();
    assert_eq!(res.diagram_type, DiagramType::Venn);
    assert!(res.svg.starts_with(r#"<svg xmlns="http://www.w3.org/2000/svg" class="pele pele-venn""#));

    let light = render(basic, &resolved_options()).unwrap();
    assert_inert_resolved(&light.svg, "venn light");
    assert_resvg_parses(&light.svg, "venn light");
    let dark = render(basic, &dark_options()).unwrap();
    assert_inert_resolved(&dark.svg, "venn dark");
    assert_resvg_parses(&dark.svg, "venn dark");

    // Two-set proportional areas and lens overlap.
    for &(a, b, shared) in &[(20.0, 12.0, 3.0), (10.0, 10.0, 2.5), (30.0, 5.0, 1.0), (8.0, 40.0, 6.0)] {
        let cs = circles_of(&svg_of(&format!("set A:{a}\nset B:{b}\nunion A,B:{shared}")));
        let (ca, cb) = (&cs["A"], &cs["B"]);
        assert_close(area(ca) / area(cb), a / b, 0.15);
        assert_close(lens_area(ca.r, cb.r, dist(ca.x, ca.y, cb.x, cb.y)) / area(ca), shared / a, 0.02);
    }

    // Disjoint sets stay apart; full inclusion fits inside.
    let disjoint = circles_of(&svg_of("set A\nset B"));
    assert!(dist(disjoint["A"].x, disjoint["A"].y, disjoint["B"].x, disjoint["B"].y) > disjoint["A"].r + disjoint["B"].r);
    let inside = circles_of(&svg_of("set A:30\nset B:5\nunion A,B:5"));
    assert!(dist(inside["A"].x, inside["A"].y, inside["B"].x, inside["B"].y) + inside["B"].r <= inside["A"].r + 0.05);

    // Three-way union without explicit pairs adds pairwise overlaps and places label inside all 3.
    let tri_svg = svg_of("set A\nset B\nset C\nunion A,B,C[\"Innovation\"]");
    let tri = circles_of(&tri_svg);
    let mid = label_at(&tri_svg, "A|B|C");
    assert_eq!(mid.2, "Innovation");
    for c in [tri["A"].clone(), tri["B"].clone(), tri["C"].clone()] {
        assert!(dist(mid.0, mid.1, c.x, c.y) < c.r);
    }

    // 5-set relaxation separates non-overlapping pairs.
    let five = circles_of(&svg_of("set A\nset B\nset C\nset D\nset E\nunion A,B\nunion C,D\nunion D,E"));
    let overlaps = |p: &str, q: &str| dist(five[p].x, five[p].y, five[q].x, five[q].y) < five[p].r + five[q].r - 0.5;
    assert!(overlaps("A", "B") && overlaps("C", "D") && overlaps("D", "E"));
    for &(p, q) in &[("A", "C"), ("A", "D"), ("A", "E"), ("B", "C"), ("C", "E")] {
        assert!(!overlaps(p, q), "{p} and {q} should not overlap");
    }

    // Indented text nodes, styles, overlap path, and contrasting ink colors.
    let styled = svg_of(
        "set A\nset B\nset C\nunion A,B[\"ab\"]\n  text T[\"note\"]\nunion B,C[\"bc\"]\nstyle A,B fill:#1f3a5f\nstyle A fill:navy\nstyle B,C fill:#1f3a5f,color:#eee",
    );
    assert!(styled.contains(r#"fill="var(--pele-fg-on-dark,#fff)""#));
    assert!(styled.contains(r#"style="fill:#eee;""#));
    assert!(styled.contains(r#"class="pele-venn-overlap""#));

    let covered = svg_of(
        "set A: 100\nset B: 100\nset C: 100\nunion A,B,C[\"triple\"]: 50\nunion A,B[\"ab\"]: 70\nunion A,C[\"ac\"]: 70\nunion B,C[\"bc\"]: 70\nstyle A,B,C fill:black\nstyle A,B fill:white",
    );
    assert!(covered.contains(r#"fill="var(--pele-fg-on-light,#1f1f1f)""#));

    let overlap_svg = svg_of("set A\nset B\nset C\nunion A,B[\"ab\"]\nunion A,B,C[\"abc\"]\nstyle A,B fill:gold\nstyle A,B,C fill:#333");
    let re_ov = Regex::new(r#"<path class="pele-venn-overlap" data-id="([^"]*)" d="([^"]+)" fill="none" style="([^"]*)"/>"#).unwrap();
    let paths: Vec<(String, String, String)> = re_ov
        .captures_iter(&overlap_svg)
        .map(|c| (c[1].to_string(), c[2].to_string(), c[3].to_string()))
        .collect();
    assert_eq!(paths.len(), 2);
    assert_eq!(paths[0].1.matches('A').count(), 2);
    assert_eq!(paths[1].1.matches('A').count(), 3);

    // Long label wrapping stays inside width.
    let wrapped = render(
        "venn-beta\nset A[\"A very long label for a set that goes on and on\"]\nset B\nunion A,B[\"An intersection with a long label\"]",
        &resolved_options(),
    )
    .unwrap();
    assert_resvg_parses(&wrapped.svg, "wrapped venn");
    let re_ts = Regex::new(r#"<tspan x="([-\d.]+)" y="([-\d.]+)"[^>]*>([^<]*)<"#).unwrap();
    for cap in re_ts.captures_iter(&wrapped.svg) {
        let x: f64 = cap[1].parse().unwrap();
        let half = METRICS_MEASURER.width(&cap[3], 16.0, TextStyle::NONE) / 2.0;
        assert!(x - half >= 0.0 && x + half <= wrapped.width);
    }

    // Palette overrides repeat set venn colors.
    let pal = render(
        "---\nconfig:\n  themeVariables:\n    venn2: red\n    venn4: blue\n---\nvenn-beta\n  set A\n  set B",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(pal.contains("--pele-series-1:red"));
    assert!(pal.contains("--pele-series-2:blue"));
    assert!(pal.contains("--pele-series-3:red"));

    // Hyphenated keywords, bare title, comments, and error messages.
    let parsed = parse(
        "venn-beta\nset set-theory\nset union-x\nunion set-theory,union-x[\"both\"]\n  text-5\ntext set-theory text-books\nstyle set-theory fill:red,x:style-y",
        &ParseOptions::default(),
    )
    .unwrap();
    match parsed.model {
        ParsedModel::Venn(m) => {
            assert_eq!(m.text_nodes.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec!["-5", "text-books"]);
            assert_eq!(m.styles[0].styles.get("x").map(String::as_str), Some("style-y"));
        }
        other => panic!("expected Venn, got {other:?}"),
    }
    let bare_title = parse("venn-beta\ntitle\nset A\nset title\ntitle Kept\nset B", &ParseOptions::default()).unwrap();
    match bare_title.model {
        ParsedModel::Venn(m) => assert_eq!(m.title.as_deref(), Some("Kept")),
        other => panic!("expected Venn, got {other:?}"),
    }

    assert_eq!(
        render("venn-beta\nunion A", &css_options()).unwrap_err().message,
        "union requires multiple identifiers"
    );
    assert_eq!(
        render("venn-beta\nset A\nunion A,B", &css_options()).unwrap_err().message,
        "unknown set identifier: B"
    );
    assert_eq!(
        render("venn-beta\nset A\nunion A,\"B#35;x\"", &css_options()).unwrap_err().message,
        "unknown set identifier: B#35;x"
    );
    assert!(
        render("venn-beta\nset A,B", &css_options())
            .unwrap_err()
            .message
            .contains("Parse error on line 2:")
    );
    assert!(
        render("venn-beta\nset A $", &css_options())
            .unwrap_err()
            .message
            .contains("Lexical error on line 2.")
    );

    // Empty venn renders valid SVG.
    let empty = render("venn-beta\n", &resolved_options()).unwrap();
    assert!(empty.svg.contains(r#"<g class="pele-venn-sets"></g>"#));
    assert_resvg_parses(&empty.svg, "empty venn");
}

#[test]
fn venn_corpus_hostile_and_fuzz_are_inert_and_resvg_safe() {
    let corpus = load_fixture("venn-corpus.json");
    assert_eq!(corpus.len(), 25);
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
    assert!(rendered_corpus > 20, "rendered_corpus={rendered_corpus}");

    let mut rendered_hostile = 0usize;
    for &p in PAYLOADS {
        let templates = [
            format!("venn-beta\nset \"{p}\""),
            format!("venn-beta\nset A[\"{p}\"]"),
            format!("venn-beta\nset A\n  text \"{p}\"[\"{p}\"]"),
            format!("venn-beta\nset A\nset B\nunion A,B[\"{p}\"]\nstyle A,B fill:\"{p}\", color:\"{p}\""),
            format!("venn-beta\ntitle \"{p}\"\nset A"),
            format!("---\ntitle: \"{p}\"\n---\nvenn-beta\nset A"),
            format!("%%{{init: {{\"themeVariables\": {{\"venn1\": \"{p}\"}}}}}}%%\nvenn-beta\nset A"),
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

    let mut frags: Vec<&str> = PAYLOADS.to_vec();
    frags.extend_from_slice(&[
        "\"", "[", "]", "[\"", "\"]", "\n", "\n  ", ",", ":", "set ", "union ", "text ", "style ", "title ", "fill:",
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

struct DummyHost(bool);
impl IndentHost for DummyHost {
    fn indent_mode(&self) -> bool {
        self.0
    }
    fn set_indent_mode(&mut self, _enabled: bool) {}
}

#[test]
fn venn_worst_cases_stay_linear_and_finite() {
    let big = RenderOptions {
        limit: Some(usize::MAX),
        ..css_options()
    };
    let n = 50_000usize;
    for src in [
        format!("venn-beta\n{}", "set A[\"x".repeat(n / 8)),
        format!("venn-beta\nstyle A fill:{}", "rgb(1,2,".repeat(n / 8)),
        format!("venn-beta\nset A\n{}text x", " ".repeat(n)),
        format!("venn-beta\n{}", "title\n".repeat(n / 6)),
    ] {
        let started = Instant::now();
        let mut lex = VennLexer::new(&src);
        let mut host = DummyHost(true);
        loop {
            let t = lex.next(&mut host);
            if t == VennToken::End || t == VennToken::Error {
                break;
            }
        }
        assert!(started.elapsed().as_millis() < 2000);
    }

    let nonsense = format!(
        "venn-beta\nset A:0\nset B:-1000000000\nset C:{}\nset D:.{}1\nunion A,B:{}\nunion C,D:-5\nunion A,B,C,D[\"x\"]:0\n",
        "9".repeat(400),
        "0".repeat(300),
        "9".repeat(400)
    );
    let r = render(&nonsense, &resolved_options()).unwrap();
    assert!(!r.svg.contains("NaN") && !r.svg.contains("Infinity"));
    assert_resvg_parses(&r.svg, "venn nonsense");

    let sets_2k: String = (0..2000).map(|i| format!("set s{i}\n")).collect();
    let chain_300: String = (0..300)
        .map(|i| format!("set s{i}\n"))
        .chain((0..299).map(|i| format!("union s{i},s{}\n", i + 1)))
        .collect();
    for src in [
        format!("venn-beta\n{sets_2k}"),
        format!("venn-beta\n{chain_300}"),
        format!("venn-beta\nset A\n{}", "  text t\n".repeat(5000)),
        format!("venn-beta\nset A[\"{}\"]", "word ".repeat(n / 5)),
    ] {
        let started = Instant::now();
        let _ = render(&src, &big);
        assert!(started.elapsed().as_millis() < 2000);
    }
    let over = render(&format!("venn-beta\n{}", "set A\n".repeat(9000)), &css_options()).unwrap_err();
    assert_eq!(over.code, ErrorCode::Limit);
}
