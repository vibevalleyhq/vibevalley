mod support;

use std::time::Instant;

use regex::Regex;
use vibevalley_pele::detect::DiagramType;
use vibevalley_pele::diagram::ishikawa::lexer::tokenize;
use vibevalley_pele::{METRICS_MEASURER, ParseOptions, ParsedModel, RenderOptions, TextMeasurer, TextStyle, detect_type, parse, render, supports};

use support::{Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, css_options, dark_options, load_fixture, resolved_options};

struct TextBox {
    left: f64,
    right: f64,
    top: f64,
    bottom: f64,
    text: String,
}

struct CatInfo {
    id: String,
    bones: String,
    body: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn svg_of(body: &str) -> String {
    render(&format!("ishikawa-beta\n{body}"), &css_options()).unwrap().svg
}

fn text_boxes(svg: &str) -> Vec<TextBox> {
    let re_g = Regex::new(r#"<g class="pele-ishikawa-causes" font-size="(\d+)">(.*?)</g>"#).unwrap();
    let re_t = Regex::new(r#"<text[^>]* x="([-\d.]+)" y="([-\d.]+)" text-anchor="middle">([^<]*)</text>"#).unwrap();
    let mut out = Vec::new();
    for g in re_g.captures_iter(svg) {
        let size: f64 = g[1].parse().unwrap();
        for m in re_t.captures_iter(&g[2]) {
            let text = m[3].replace("&amp;", "&");
            let half = METRICS_MEASURER.width(&text, size, TextStyle::NONE) / 2.0;
            let x: f64 = m[1].parse().unwrap();
            let y: f64 = m[2].parse::<f64>().unwrap() - size * 0.35;
            out.push(TextBox {
                left: x - half,
                right: x + half,
                top: y - size / 2.0,
                bottom: y + size / 2.0,
                text,
            });
        }
    }
    out
}

fn categories(svg: &str) -> Vec<CatInfo> {
    let doc = roxmltree::Document::parse(svg).unwrap();
    let mut out = Vec::new();
    for node in doc
        .descendants()
        .filter(|n| n.is_element() && n.attribute("class") == Some("pele-ishikawa-category"))
    {
        let id = node.attribute("data-id").unwrap_or("").to_string();
        let bones_el = node
            .children()
            .find(|n| n.is_element() && n.attribute("class") == Some("pele-ishikawa-bones"))
            .unwrap();
        let bones = bones_el.attribute("d").unwrap().to_string();
        let rect = node.children().find(|n| n.is_element() && n.tag_name().name() == "rect").unwrap();
        let range = node.range();
        out.push(CatInfo {
            id,
            bones,
            body: svg[range].to_string(),
            x: rect.attribute("x").unwrap().parse().unwrap(),
            y: rect.attribute("y").unwrap().parse().unwrap(),
            w: rect.attribute("width").unwrap().parse().unwrap(),
            h: rect.attribute("height").unwrap().parse().unwrap(),
        });
    }
    out
}

fn spine(svg: &str) -> (f64, f64, f64) {
    let re = Regex::new(r#"<path class="pele-ishikawa-spine" d="M([-\d.]+),([-\d.]+)H([-\d.]+)""#).unwrap();
    let cap = re.captures(svg).unwrap();
    (cap[1].parse().unwrap(), cap[2].parse().unwrap(), cap[3].parse().unwrap())
}

fn check_both(src: &str, id_prefix: Option<&str>, font_family: Option<&str>) -> bool {
    let opts_css = RenderOptions {
        id_prefix: id_prefix.map(str::to_string),
        font_family: font_family.map(str::to_string),
        ..css_options()
    };
    let opts_res = RenderOptions {
        id_prefix: id_prefix.map(str::to_string),
        font_family: font_family.map(str::to_string),
        ..resolved_options()
    };
    let ok = match render(src, &opts_css) {
        Ok(r) => {
            assert_inert(&r.svg, src);
            true
        }
        Err(_) => false,
    };
    if let Ok(r) = render(src, &opts_res) {
        assert_inert_resolved(&r.svg, src);
        assert_resvg_parses(&r.svg, src);
    }
    ok
}

#[test]
fn ishikawa_renders_keywords_head_spine_and_alternating_categories() {
    for kw in ["ishikawa-beta", "ishikawa", "Ishikawa-Beta"] {
        let src = format!("{kw}\n  Effect\n    Cause\n");
        assert_eq!(detect_type(&src), Some(DiagramType::Ishikawa));
        assert!(supports(&src));
        let res = render(&src, &css_options()).unwrap();
        assert_eq!(res.diagram_type, DiagramType::Ishikawa);
        assert!(res.svg.starts_with(r#"<svg xmlns="http://www.w3.org/2000/svg" class="pele pele-ishikawa""#));
        assert!(res.svg.contains(&format!(r#"viewBox="0 0 {} {}""#, res.width as i64, res.height as i64)));
        let r_res = render(&src, &resolved_options()).unwrap();
        assert_inert_resolved(&r_res.svg, &src);
        assert_resvg_parses(&r_res.svg, &src);
        let r_dark = render(&src, &dark_options()).unwrap();
        assert_inert_resolved(&r_dark.svg, &src);
        assert_resvg_parses(&r_dark.svg, &src);
    }

    let parsed = parse("ishikawa-beta\n  Effect\n    Cause\n      Sub\n", &ParseOptions::default()).unwrap();
    match parsed.model {
        ParsedModel::Ishikawa(m) => {
            let root = m.root.unwrap();
            assert_eq!(root.text, "Effect");
            assert_eq!(root.children[0].text, "Cause");
            assert_eq!(root.children[0].children[0].text, "Sub");
        }
        other => panic!("expected Ishikawa model, got {other:?}"),
    }

    // Head and spine
    let svg = svg_of("  Late delivery\n    People\n    Process\n");
    let (from, _sy, to) = spine(&svg);
    assert!(to > from);
    assert!(svg.contains(r#"<g class="pele-ishikawa-head" data-id="Late delivery">"#));
    assert_eq!(svg.matches(r#"class="pele-marker""#).count(), 3);

    // Effect only & comment only
    let solo = svg_of("  Just an effect\n");
    assert_eq!(solo.matches("pele-ishikawa-category").count(), 0);
    assert!(solo.contains("pele-ishikawa-head") && solo.contains("pele-ishikawa-spine"));
    let empty = render("ishikawa-beta%% only a comment", &resolved_options()).unwrap();
    assert!(!empty.svg.contains("pele-ishikawa-head"));
    assert!(empty.width > 0.0);
    assert_resvg_parses(&empty.svg, "empty ishikawa");

    // Alternating above/below categories
    let five = svg_of("  E\n    One\n    Two\n    Three\n    Four\n    Five\n");
    let (_, sy, _) = spine(&five);
    let cats = categories(&five);
    let ids: Vec<&str> = cats.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, vec!["One", "Two", "Three", "Four", "Five"]);
    let re_num = Regex::new(r"-?\d+(?:\.\d+)?").unwrap();
    let mut starts = Vec::new();
    for (i, cat) in cats.iter().enumerate() {
        let nums: Vec<f64> = re_num.find_iter(&cat.bones).map(|m| m.as_str().parse().unwrap()).collect();
        let (x0, y0, x1, y1) = (nums[0], nums[1], nums[2], nums[3]);
        starts.push(x0);
        assert!((y0 - sy).abs() < 8.0);
        assert!(x1 < x0);
        if i % 2 == 0 {
            assert!(y1 < sy);
            assert!(((cat.y + cat.h) - y1).abs() < 1.0);
        } else {
            assert!(y1 > sy);
            assert!((cat.y - y1).abs() < 1.0);
        }
        assert!(((cat.x + cat.w / 2.0) - x1).abs() < 1.0);
    }
    assert!((starts[0] - starts[1]).abs() < 1.0);
    assert!((starts[2] - starts[3]).abs() < 1.0);
    assert!(starts[2] < starts[0] - 20.0);
    assert!(starts[4] < starts[2] - 20.0);

    // Causes top-to-bottom on both sides + sub-cause twig check
    let sub = svg_of("  E\n    Cat\n      Cause\n        Sub one\n        Sub two\n      Other\n");
    let sub_cats = categories(&sub);
    assert_eq!(sub_cats.len(), 1);
    assert!(sub_cats[0].body.contains(">Cause</text>"));
    assert!(sub_cats[0].body.contains(">Sub one</text>"));

    let ordered = svg_of("  E\n    Above\n      first\n      second\n      third\n    Below\n      first\n      second\n      third\n");
    let tbs = text_boxes(&ordered);
    for side in [&tbs[0..3], &tbs[3..6]] {
        let mut sorted: Vec<&TextBox> = side.iter().collect();
        sorted.sort_by(|a, b| a.top.partial_cmp(&b.top).unwrap());
        let names: Vec<&str> = sorted.iter().map(|b| b.text.as_str()).collect();
        assert_eq!(names, vec!["first", "second", "third"]);
    }
}

#[test]
fn ishikawa_no_overlap_nesting_title_max_width_and_errors() {
    let corpus = load_fixture("ishikawa-corpus.json");
    assert!(!corpus.is_empty());
    let doc_sample = corpus.iter().find(|s| s.contains("Beautification")).unwrap().clone();
    let multi = format!(
        "ishikawa-beta\n  E\n{}",
        (0..9)
            .map(|c| {
                let causes: String = (0..1 + (c % 4))
                    .map(|k| format!("      Cause {c}.{k}\n        Sub {c}.{k}.a\n        Sub {c}.{k}.b\n"))
                    .collect();
                format!("    Category {c}\n{causes}")
            })
            .collect::<String>()
    );
    let outlines = [
        doc_sample,
        "ishikawa-beta\n  E\n    A\n      a1\n        a11\n          a111\n            a1111\n          a112\n        a12\n      a2\n    B\n      b1\n      b2\n      b3\n    C\n    D\n      d1\n        d11\n        d12\n        d13\n      d2\n        d21\n    F\n      a rather long cause that goes on\n        and a long sub cause as well\n".to_string(),
        multi,
    ];
    let re_shift = Regex::new(r#"<g transform="translate\(([-\d.]+),([-\d.]+)\)">"#).unwrap();
    for src in &outlines {
        let res = render(src, &css_options()).unwrap();
        let cap = re_shift.captures(&res.svg).unwrap();
        let ox: f64 = cap[1].parse().unwrap();
        let oy: f64 = cap[2].parse().unwrap();
        let boxes = text_boxes(&res.svg);
        let cats = categories(&res.svg);
        assert!(boxes.len() > 8);
        for (i, a) in boxes.iter().enumerate() {
            assert!(a.left + ox >= 0.0);
            assert!(a.bottom + oy <= res.height);
            assert!(a.top + oy >= 0.0);
            for b in &boxes[i + 1..] {
                let apart = a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
                assert!(apart, "{} and {} overlap", a.text, b.text);
            }
            for cat in &cats {
                let apart = a.right <= cat.x || cat.x + cat.w <= a.left || a.bottom <= cat.y || cat.y + cat.h <= a.top;
                assert!(apart, "{} overlaps category {}", a.text, cat.id);
            }
        }
        for (i, ca) in cats.iter().enumerate() {
            for cb in &cats[i + 1..] {
                let apart = ca.x + ca.w <= cb.x || cb.x + cb.w <= ca.x || ca.y + ca.h <= cb.y || cb.y + cb.h <= ca.y;
                assert!(apart, "categories {} and {} overlap", ca.id, cb.id);
            }
        }
        let r_res = render(src, &resolved_options()).unwrap();
        assert_inert_resolved(&r_res.svg, src);
        assert_resvg_parses(&r_res.svg, src);

        // Vertical narrow mode via max_width
        let narrow = render(
            src,
            &RenderOptions {
                max_width: Some(300.0),
                ..resolved_options()
            },
        )
        .unwrap();
        assert_inert_resolved(&narrow.svg, "ishikawa narrow");
        assert_resvg_parses(&narrow.svg, "ishikawa narrow");
    }

    // Relative nesting
    let nested = parse("ishikawa-beta\n        Problem\n  A\n      A1\n    A2\n  B\n C\n", &ParseOptions::default()).unwrap();
    if let ParsedModel::Ishikawa(m) = nested.model {
        let root = m.root.unwrap();
        assert_eq!(root.text, "Problem");
        let top_names: Vec<&str> = root.children.iter().map(|c| c.text.as_str()).collect();
        assert_eq!(top_names, vec!["A", "B", "C"]);
        let a_kids: Vec<&str> = root.children[0].children.iter().map(|c| c.text.as_str()).collect();
        assert_eq!(a_kids, vec!["A1", "A2"]);
    }

    // Front matter title
    let titled = render("---\ntitle: Root causes\n---\nishikawa-beta\n  Effect\n    Cause\n", &css_options()).unwrap();
    assert!(titled.svg.contains(r#"<text class="pele-title" font-weight="var(--_tw)""#));
    assert!(titled.svg.contains(">Root causes</tspan>"));

    // Rejections
    assert!(render("ishikawa-beta", &css_options()).is_err());
    assert!(render("ishikawa-beta\n\n  Effect\n", &css_options()).is_err());
    assert!(!render("ishikawa-beta\n", &css_options()).unwrap().svg.contains("pele-ishikawa-head"));
    let err = render("ishikawa-beta\n  Effect\n  ishikawa again\n", &css_options()).unwrap_err();
    assert!(err.message.contains("Expecting 'SPACELINE', 'NL', 'EOF', 'TEXT', got 'ISHIKAWA'"), "err={err}");
}

#[test]
fn ishikawa_is_inert_for_corpus_hostile_and_mutated_inputs() {
    let corpus = load_fixture("ishikawa-corpus.json");
    for src in &corpus {
        check_both(src, None, None);
    }

    let head = "ishikawa-beta\n";
    let mut rendered = 0usize;
    for &p in PAYLOADS {
        let templates = [
            format!("{head}{p}"),
            format!("{head}  {p}"),
            format!("{head}  Effect\n    {p}"),
            format!("{head}  Effect\n    Category\n      {p}"),
            format!("{head}  Effect\n    Category\n      Cause\n        {p}"),
            format!("{head}  Effect\n    Category\n      Cause\n        Sub\n          {p}\n            {p}"),
            format!("{head}  {p}\n    {p}\n      {p}\n    {p}\n      {p}\n        {p}"),
            format!("{head}  Effect {p}\n    Category {p}\n      Cause {p} more"),
            format!("{head}  Effect\n    A\n    B\n    {p}\n    C"),
            format!("{head}  Effect\n%% {p}\n    Category"),
            format!("{head}  Effect\n    Category %% {p}"),
            format!("ishikawa {p}"),
            format!("ishikawa-beta {p}\n  Cause"),
            format!("---\ntitle: \"{p}\"\n---\n{head}  Effect\n    Cause"),
            format!("---\ntitle: {p}\nconfig:\n  ishikawa:\n    diagramPadding: \"{p}\"\n---\n{head}  Effect"),
            format!(r#"%%{{init: {{"ishikawa": {{"useMaxWidth": "{p}"}}, "themeVariables": {{"lineColor": "{p}"}}}}}}%%"#)
                + &format!("\n{head}  Effect\n    Cause"),
        ];
        for src in templates {
            if check_both(&src, None, None) {
                rendered += 1;
            }
        }
        assert!(check_both(&format!("{head}  Effect\n    Category\n      Cause"), Some(p), Some(p)));
    }
    assert!(rendered > 450, "rendered={rendered}");

    let esc_svg = render(
        &format!(
            "{head}  <img src=x onerror=alert(1)>\n    <script>a&b</script>\n      </text></g></svg><script>alert(1)</script>\n        \" onload=\"alert(1)\n"
        ),
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(!esc_svg.contains("<img") && !esc_svg.contains("<script") && !esc_svg.contains("onload=\"alert"));
    assert!(esc_svg.contains(r#"data-id="&lt;img src=x onerror=alert(1)&gt;""#));
    assert!(esc_svg.contains(r#"data-id="&lt;script&gt;a&amp;b&lt;/script&gt;""#));
    assert!(esc_svg.contains("&quot; onload=&quot;alert(1)"));

    let mut frags: Vec<&str> = PAYLOADS.to_vec();
    frags.extend_from_slice(&["\n", "\n  ", "\n      ", "\t", " ", "%%", "<br>", "#35;", "ishikawa"]);
    let mut mutator = Mutator::new(&corpus, frags, 3);
    for _ in 0..2000 {
        let src = mutator.next_sample();
        if src.len() <= 4000 {
            check_both(&src, None, None);
        }
    }
}

#[test]
fn ishikawa_stays_fast_and_handles_deep_outlines() {
    const N: usize = 50_000;
    let head = "ishikawa-beta\n";
    let big = RenderOptions {
        limit: Some(usize::MAX),
        output_limit: Some(usize::MAX),
        ..css_options()
    };

    let deep400: String = (0..400).map(|i| format!("{}n{i}\n", " ".repeat(i + 1))).collect();
    let res400 = render(&format!("{head}{deep400}"), &big).unwrap();
    assert!(!res400.svg.contains("NaN") && !res400.svg.contains("Infinity"));
    assert!(res400.width.is_finite() && res400.height.is_finite());
    assert!(res400.svg.contains(">n399</text>"));

    let deep3000: String = (0..3000).map(|i| format!("{}n\n", " ".repeat(i + 1))).collect();
    let cases: Vec<Box<dyn Fn()>> = vec![
        Box::new(|| {
            let _ = tokenize(&format!("{head}{}", " ".repeat(N)));
        }),
        Box::new(|| {
            let _ = tokenize(&format!("{head}{}", "\n".repeat(N)));
        }),
        Box::new(|| {
            let _ = tokenize(&format!("{head}{}", " \n".repeat(N / 2)));
        }),
        Box::new(|| {
            let _ = tokenize(&format!("{head}{}%", " \t\r\u{00a0}\u{2028}\n".repeat(N / 6)));
        }),
        Box::new(|| {
            let _ = tokenize(&format!("{head}{}%% c", " \t\r\u{00a0}\u{2028}\n".repeat(N / 6)));
        }),
        Box::new(|| {
            let _ = render(&format!("{head}  {}", "a".repeat(N)), &big);
        }),
        Box::new(|| {
            let _ = render(&format!("{head}  Effect\n    {}", "word ".repeat(10_000)), &big);
        }),
        Box::new(|| {
            let _ = render(&format!("{head}  E\n{}", "    c\n".repeat(12_000)), &big);
        }),
        Box::new(|| {
            let _ = render(&format!("{head}  E\n    C\n{}", "      c\n".repeat(12_000)), &big);
        }),
        Box::new(|| {
            let _ = render(&format!("{head}{deep3000}"), &big);
        }),
    ];
    for (i, run) in cases.iter().enumerate() {
        let started = Instant::now();
        run();
        assert!(started.elapsed().as_millis() < 3000, "slow ishikawa stress case #{i}: {:?}", started.elapsed());
    }

    let over = render(&format!("{head}{}", "  cause\n".repeat(8000)), &css_options()).unwrap_err();
    assert!(over.message.contains("limit of 50000"));
}
