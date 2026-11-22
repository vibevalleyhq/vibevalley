use std::collections::BTreeSet;
use std::time::Instant;

use regex::Regex;
use roxmltree::Document;
use vibevalley_pele::detect::DiagramType;
use vibevalley_pele::diagram::journey::{JourneyModel, lexer::tokenize};
use vibevalley_pele::{METRICS_MEASURER, ParseOptions, ParsedModel, RenderOptions, TextMeasurer, TextStyle, parse, render, supports};

use crate::support::{Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, css_options, dark_options, load_fixture, resolved_options};

const DAY: &str = "journey\n  title My working day\n  section Go to work\n    Make tea: 5: Me\n    Go upstairs: 3: Me\n    Do work: 1: Me, Cat\n  section Go home\n    Go downstairs: 5: Me\n    Sit down: 5: Me\n";

fn count_class(svg: &str, cls: &str) -> usize {
    svg.matches(&format!(r#"class="{cls}""#)).count()
}

fn texts(svg: &str) -> Vec<String> {
    let re = Regex::new(r">([^<>]+)<").unwrap();
    re.captures_iter(svg).map(|c| c[1].to_string()).collect()
}

fn face_y(svg: &str) -> Vec<f64> {
    let re = Regex::new(r#"class="pele-face pele-face-\w+" transform="translate\([-\d.]+,([-\d.]+)\)""#).unwrap();
    re.captures_iter(svg).map(|c| c[1].parse().unwrap()).collect()
}

fn moods(svg: &str) -> Vec<String> {
    let re = Regex::new(r#"class="pele-face pele-face-(\w+)""#).unwrap();
    re.captures_iter(svg).map(|c| c[1].to_string()).collect()
}

fn rects_of(svg: &str) -> Vec<(f64, f64, f64, f64)> {
    let doc = Document::parse(svg).expect("valid SVG XML");
    doc.descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "rect")
        .map(|n| {
            (
                n.attribute("x").unwrap_or("0").parse().unwrap_or(0.0),
                n.attribute("y").unwrap_or("0").parse().unwrap_or(0.0),
                n.attribute("width").unwrap_or("0").parse().unwrap_or(0.0),
                n.attribute("height").unwrap_or("0").parse().unwrap_or(0.0),
            )
        })
        .collect()
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
fn journey_draws_title_sections_faces_and_actors() {
    let res = render(DAY, &css_options()).unwrap();
    assert_eq!(res.diagram_type, DiagramType::Journey);
    assert!(supports(DAY));
    assert!(res.links.is_empty());
    assert!(res.svg.contains(r#"class="pele pele-journey""#));
    assert!(res.svg.contains(">My working day<"));
    assert_eq!(count_class(&res.svg, "pele-cluster pele-section"), 2);
    assert_eq!(count_class(&res.svg, "pele-node pele-task"), 5);
    assert_eq!(moods(&res.svg), vec!["happy", "neutral", "sad", "happy", "happy"]);
    assert_eq!(count_class(&res.svg, "pele-actor"), 6);
    assert_eq!(count_class(&res.svg, "pele-legend-item"), 2);
    assert!(res.svg.contains(r#"data-id="Go to work""#));
    assert!(res.svg.contains(r#"data-id="Make tea""#));
    assert!(res.svg.contains(">Do work<"));

    // Colors actors by sorted list and marks them on each task
    let re_legend = Regex::new(r#"class="pele-legend-item" data-id="(\w+)"><circle [^>]*fill="var\(--pele-series-(\d)"#).unwrap();
    let legend: Vec<(&str, &str)> = re_legend
        .captures_iter(&res.svg)
        .map(|c| (c.get(1).unwrap().as_str(), c.get(2).unwrap().as_str()))
        .collect();
    assert_eq!(legend, vec![("Cat", "1"), ("Me", "2")]);
    let re_dots = Regex::new(r#"class="pele-actor"[^>]*fill="var\(--pele-series-(\d),[^>]*><title>(\w+)</title>"#).unwrap();
    let dots: Vec<(&str, &str)> = re_dots
        .captures_iter(&res.svg)
        .map(|c| (c.get(2).unwrap().as_str(), c.get(1).unwrap().as_str()))
        .collect();
    assert_eq!(dots, vec![("Me", "2"), ("Me", "2"), ("Me", "2"), ("Cat", "1"), ("Me", "2"), ("Me", "2")]);

    // Deterministic + light/dark resvg
    assert_eq!(res.svg, render(DAY, &css_options()).unwrap().svg);
    let light = render(DAY, &resolved_options()).unwrap();
    assert_inert_resolved(&light.svg, "journey light");
    assert_resvg_parses(&light.svg, "journey light");
    let dark = render(DAY, &dark_options()).unwrap();
    assert_inert_resolved(&dark.svg, "journey dark");
    assert_resvg_parses(&dark.svg, "journey dark");
}

#[test]
fn journey_scores_faces_bands_and_wrapping() {
    // Places each face by its score
    let ys = face_y(&render("journey\n  a: 5\n  b: 4\n  c: 3\n  d: 2\n  e: 1\n", &css_options()).unwrap().svg);
    assert_eq!(ys.len(), 5);
    for i in 1..5 {
        assert!(((ys[i] - ys[i - 1]) - (ys[1] - ys[0])).abs() < 1e-6);
    }
    assert!(ys[1] > ys[0]);

    // Odd scores clamped / NaN neutral
    let odd = render(
        "journey\n  top: 5\n  mid: 3\n  low: 1\n  big: 100\n  neg: -7\n  zero: 0\n  word: abc\n  blank: \n  half: 3.5\n  inf: Infinity\n",
        &css_options(),
    )
    .unwrap();
    let oys = face_y(&odd.svg);
    let (top, mid, low) = (oys[0], oys[1], oys[2]);
    let expected = [top, low, low, mid, low, (top + mid) / 2.0 + (mid - top) / 4.0, top];
    for (got, exp) in oys[3..].iter().zip(expected.iter()) {
        assert!((got - exp).abs() < 1e-6, "got {got}, expected {exp}");
    }
    assert_eq!(
        moods(&odd.svg),
        vec!["happy", "neutral", "sad", "happy", "sad", "sad", "neutral", "sad", "happy", "happy"]
    );
    assert!(!odd.svg.contains("NaN") && !odd.svg.contains("Infinity"));

    // Draws faces from circles and paths only
    let faces = render("journey\n  a: 5\n  b: 3\n  c: 1\n", &css_options()).unwrap();
    let doc = Document::parse(&faces.svg).unwrap();
    let names: BTreeSet<&str> = doc.descendants().filter(|n| n.is_element()).map(|n| n.tag_name().name()).collect();
    assert_eq!(names.into_iter().collect::<Vec<_>>(), vec!["circle", "g", "path", "rect", "svg", "text"]);
    let re_mouth = Regex::new(r#"<path d="([^"]+)" fill="none" stroke="var\(--_l\)" stroke-linecap="round"/>"#).unwrap();
    let mouths: BTreeSet<&str> = re_mouth.captures_iter(&faces.svg).map(|c| c.get(1).unwrap().as_str()).collect();
    assert_eq!(mouths.len(), 3);

    // Leaves out nameless actor of trailing colon
    let trailing = render("journey\n  a: 5:\n  b: 3: , Real,\n", &css_options()).unwrap();
    assert_eq!(count_class(&trailing.svg, "pele-actor"), 1);
    assert_eq!(count_class(&trailing.svg, "pele-legend-item"), 1);
    assert!(!render("journey\n  a: 5:\n", &css_options()).unwrap().svg.contains("pele-legend"));

    // Section bands over runs, no band for empty or missing
    let bands = render(
        "journey\n  first: 3\n  section A\n  section B\n    b1: 3\n    b2: 3\n  section C\n    c1: 3\n  section D\n",
        &css_options(),
    )
    .unwrap();
    assert_eq!(count_class(&bands.svg, "pele-cluster pele-section"), 2);
    assert!(!bands.svg.contains(">A<"));
    assert!(!bands.svg.contains(">D<"));
    let rects = rects_of(&bands.svg);
    let (first, band, b1, b2) = (rects[0], rects[1], rects[2], rects[3]);
    assert_eq!(band.0, b1.0);
    assert_eq!(band.0 + band.2, b2.0 + b2.2);
    assert!(band.1 < b1.1);
    assert_eq!(first.1, b1.1);

    // Consecutive sections of same name merge
    let merged = render(
        "journey\n  section A\n    a: 3\n  section A\n    b: 3\n  section B\n    c: 3\n  section A\n    d: 3\n",
        &css_options(),
    )
    .unwrap();
    assert_eq!(count_class(&merged.svg, "pele-cluster pele-section"), 3);

    // Line breaks, wrapping, long word cuts
    let one = render("journey\n  first second: 3\n", &css_options()).unwrap();
    let two = render("journey\n  first<br>second: 3\n", &css_options()).unwrap();
    assert!(two.height > one.height);
    assert_eq!(texts(&two.svg)[5..], vec!["first", "second"]);
    let long = render(&format!("journey\n  {}: 3\n", "several words that go on ".repeat(4)), &css_options()).unwrap();
    assert_eq!(long.width, one.width);
    let cut = render(&format!("journey\n  {}: 3\n", "x".repeat(200)), &css_options()).unwrap();
    assert!(cut.width <= one.width + 80.0);
    let card = rects_of(&cut.svg)[0];
    let lines: Vec<String> = texts(&cut.svg).into_iter().filter(|l| l.starts_with('x')).collect();
    assert_eq!(lines.join(""), "x".repeat(200));
    for line in &lines {
        assert!(METRICS_MEASURER.width(line, 14.0, TextStyle::default()) <= card.2 - 20.0);
    }

    // Tags and icon names shown as written
    let lit = render("journey\n  title fa:fa-check <u>T</u>\n  <b>bold</b> a<T>: 3: <i>Me</i>\n", &css_options()).unwrap();
    assert!(lit.svg.contains("&lt;u&gt;T&lt;/u&gt;"));
    assert!(lit.svg.contains("&lt;b&gt;bold&lt;/b&gt;"));
    assert!(lit.svg.contains("fa:fa-check"));
    assert!(lit.svg.contains("a&lt;T&gt;"));
    assert!(lit.svg.contains(">&lt;i&gt;Me&lt;/i&gt;<"));
    assert!(!lit.svg.contains("pele-icon"));

    // Keeps many actors inside card
    let crowd_actors: Vec<String> = (0..60).map(|i| format!("p{i}")).collect();
    let crowd = render(&format!("journey\n  crowd: 3: {}\n", crowd_actors.join(",")), &css_options()).unwrap();
    let card = rects_of(&crowd.svg)[0];
    let x0 = card.0;
    let x1 = card.0 + card.2;
    let doc = Document::parse(&crowd.svg).unwrap();
    let dots: Vec<_> = doc
        .descendants()
        .filter(|n| n.is_element() && n.attribute("class") == Some("pele-actor"))
        .collect();
    assert_eq!(dots.len(), 60);
    for dot in dots {
        let cx: f64 = dot.attribute("cx").unwrap().parse().unwrap();
        assert!(cx - 5.0 >= x0 && cx + 5.0 <= x1);
    }

    // Keeps legend inside drawing
    let leg_actors: Vec<String> = (0..40).map(|i| format!("Person number {i}")).collect();
    let leg = render(&format!("journey\n  one: 3: {}\n", leg_actors.join(",")), &css_options()).unwrap();
    let doc = Document::parse(&leg.svg).unwrap();
    let mut rows = BTreeSet::new();
    for el in doc.descendants().filter(|n| n.is_element()) {
        if el.tag_name().name() != "circle" || el.attribute("class").is_some() || el.attribute("r") != Some("5") {
            continue;
        }
        rows.insert(el.attribute("cy").unwrap().to_string());
        let cx: f64 = el.attribute("cx").unwrap().parse().unwrap();
        assert!(cx > 0.0 && cx < leg.width);
    }
    assert!(rows.len() > 5);
}

#[test]
fn journey_accessibility_empty_errors_model_and_compat() {
    // Front matter title vs own title
    assert!(
        render("---\ntitle: From front matter\n---\njourney\n  a: 3\n", &css_options())
            .unwrap()
            .svg
            .contains(">From front matter<")
    );
    let own = render("---\ntitle: From front matter\n---\njourney\n  title Own\n  a: 3\n", &css_options()).unwrap();
    assert!(own.svg.contains(">Own<"));
    assert!(!own.svg.contains("From front matter"));

    // Accessible names
    let acc = render(
        "journey\n  accTitle: Short name\n  accDescr {\n    A longer\n    description\n  }\n  a: 3\n",
        &css_options(),
    )
    .unwrap();
    assert!(acc.svg.contains(r#"<title id="pele-title">Short name</title>"#));
    assert!(acc.svg.contains("<desc id=\"pele-desc\">A longer\ndescription</desc>"));

    // Empty / lone title / sections without tasks
    for src in ["journey", "journey\n  title Only", "journey\n  section S\n  section T"] {
        let r = render(src, &css_options()).unwrap();
        assert!(!r.svg.contains("NaN") && !r.svg.contains("Infinity") && !r.svg.contains("undefined"));
        assert!(r.width > 0.0 && r.height > 0.0);
        assert_eq!(count_class(&r.svg, "pele-grid"), 0);
        let rr = render(src, &resolved_options()).unwrap();
        assert_inert_resolved(&rr.svg, src);
        assert_resvg_parses(&rr.svg, src);
    }

    // Rejects what Mermaid rejects
    assert!(render("journey\n  A task\n", &css_options()).unwrap_err().message.contains("got 'NEWLINE'"));
    assert!(render("journey\n  A task:\n", &css_options()).unwrap_err().message.contains("got ':'"));
    assert!(render("journey\n  A; B: 3\n", &css_options()).unwrap_err().message.contains("got 'INVALID'"));
    assert!(render("journey\n  : 5\n", &css_options()).is_err());
    assert!(render("journey\n  accDescr {\n  never closed\n", &css_options()).is_err());

    // Bare title vs NBSP title
    let ParsedModel::Journey(m) = parse("journey\ntitle\nsection Work\nTask: 5: Me", &ParseOptions::default()).unwrap().model else {
        panic!("expected journey");
    };
    assert_eq!(m.title, None);
    assert_eq!(m.sections, vec!["Work"]);
    let ParsedModel::Journey(m_nbsp) = parse("journey\n  title\u{00a0}Kept\n  Task: 5: Me", &ParseOptions::default()).unwrap().model else {
        panic!("expected journey");
    };
    assert_eq!(m_nbsp.title.as_deref(), Some("Kept"));

    // Keeps character before comment
    let ParsedModel::Journey(m_cmt) = parse("journey\nA%% label: 5: Me", &ParseOptions::default()).unwrap().model else {
        panic!("expected journey");
    };
    assert_eq!(m_cmt.tasks.iter().map(|t| t.task.as_str()).collect::<Vec<_>>(), vec!["A%% label"]);
    assert!(
        render("journey\n  Task: 5: Me;%% c\n", &css_options())
            .unwrap_err()
            .message
            .contains("got 'INVALID'")
    );

    // Model + compat specs
    let ParsedModel::Journey(m_full) = parse(
        "journey\n  title T\n  First: 2\n  section S\n    A task: 5: Bob, Alice\n    B task: x:\n",
        &ParseOptions::default(),
    )
    .unwrap()
    .model
    else {
        panic!("expected journey");
    };
    assert_eq!(m_full.title.as_deref(), Some("T"));
    assert_eq!(m_full.sections, vec!["S"]);
    assert_eq!(m_full.tasks.len(), 3);
    assert_eq!(m_full.tasks[0].task, "First");
    assert_eq!(m_full.tasks[0].score, 2.0);
    assert!(m_full.tasks[0].people.is_empty());
    assert_eq!(m_full.tasks[1].people, vec!["Bob", "Alice"]);
    assert!(m_full.tasks[2].score.is_nan());
    assert_eq!(m_full.tasks[2].people, vec![""]);

    // journeyDb.spec.js
    let mut db = JourneyModel::new();
    db.acc_title = Some("Shopping".to_string());
    db.acc_descr = Some("A user journey for family shopping".to_string());
    db.add_section("Journey to the shops");
    db.add_task("Get car keys", ":5:Dad");
    db.add_task("Go to car", ":3:Dad, Mum, Child#1, Child#2");
    db.add_task("Drive to supermarket", ":4:Dad");
    db.add_section("Do shopping");
    db.add_task("Go shopping", ":5:Mum");
    assert_eq!(db.tasks.len(), 4);
    assert_eq!(db.get_actors(), vec!["Child#1", "Child#2", "Dad", "Mum"]);
    assert_eq!(db.sections, vec!["Journey to the shops", "Do shopping"]);
}

#[test]
fn journey_security_corpus_payloads_options_and_mutated_fuzz() {
    let mut corpus = load_fixture("journey-corpus.json");
    corpus.push("journey\n  title Day\n  section Work\n    Make tea: 5: Me\n    Do work: 1: Me, Cat\n  section Home\n    Sit down: 4: Me\n".to_string());
    corpus.push("journey\n  accTitle: a\n  accDescr { b }\n  First: 3\n  section S\n  One<br>two: 2: A, B, C\n".to_string());

    let css = css_options();
    let res = resolved_options();

    let mut rendered = 0;
    for src in &corpus {
        if check_both_modes(src, &css, &res) {
            rendered += 1;
            let dark = render(src, &dark_options()).expect("dark mode");
            assert_inert_resolved(&dark.svg, src);
            assert_resvg_parses(&dark.svg, src);
        }
    }
    assert!(rendered > 5, "expected >5 journey corpus renders, got {rendered}");

    let variants = |p: &str| -> Vec<String> {
        if p.contains(';') {
            vec![p.to_string(), p.replace(';', "")]
        } else {
            vec![p.to_string()]
        }
    };

    let templates: Vec<fn(&str) -> String> = vec![
        |p| format!("journey\n  title {p}\n  Task: 5: Me"),
        |p| format!("journey\n  {p}: 5: Me"),
        |p| format!("journey\n  {p}"),
        |p| format!("journey\n  Task: {p}"),
        |p| format!("journey\n  Task: {p}: Me"),
        |p| format!("journey\n  Task: 5: {p}"),
        |p| format!("journey\n  Task: 5: Me, {p}, You"),
        |p| format!("journey\n  Task: 5: Me: {p}"),
        |p| format!("journey\n  section {p}\n  Task: 5: Me"),
        |p| format!("journey\n  section {p}"),
        |p| format!("journey\n  title {p}\n  section {p}\n  x{p}: 3: y{p}, z{p}"),
        |p| format!("journey {p}\n  Task: 5: Me"),
        |p| format!("journey\n  accTitle: {p}\n  accDescr: {p}\n  Task: 5: Me"),
        |p| format!("journey\n  accDescr {{\n {p}\n }}\n  Task: 5: Me"),
        |p| format!("journey\n  a<br>{p}<br/>b: 5: Me<br>{p}"),
        |p| format!("journey\n  fa:fa-{p} x: 5: fa:fa-{p}"),
        |p| format!("journey\n  %% {p}\n  Task: 5: Me # {p}"),
        |p| format!("---\ntitle: \"{p}\"\n---\njourney\n  Task: 5: Me"),
        |p| {
            format!(
                "---\nconfig:\n  journey:\n    actorColours: [\"{p}\"]\n    sectionFills: [\"{p}\"]\n    taskFontFamily: \"{p}\"\n---\njourney\n  section S\n  Task: 5: Me"
            )
        },
        |p| format!("---\nconfig:\n  journey: \"{p}\"\n---\njourney\n  Task: 5: Me"),
        |p| {
            format!(
                "%%{{init: {{\"journey\": {{\"width\": \"{p}\", \"titleColor\": \"{p}\"}}, \"themeVariables\": {{\"fillType0\": \"{p}\"}}}}}}%%\njourney\n  Task: 5: Me"
            )
        },
    ];

    let mut payload_rendered = 0;
    for tmpl in &templates {
        for &payload in PAYLOADS {
            for text in variants(payload) {
                if check_both_modes(&tmpl(&text), &css, &res) {
                    payload_rendered += 1;
                }
            }
        }
    }
    assert!(payload_rendered > 500, "expected >500 journey payload renders, got {payload_rendered}");

    // Shows markup as escaped text
    let esc = render(
        r#"journey
  title <script>alert(1)</script>
  section "><img src=x onerror=alert(1)>
  <svg onload=alert(1)>: 5: </text><script>x</script>, "onload="alert(1)"#,
        &css,
    )
    .unwrap();
    assert!(!esc.svg.contains("<script"));
    assert!(!esc.svg.contains("<img"));
    assert!(esc.svg.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert!(esc.svg.contains(r#"data-id="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;""#));
    assert!(esc.svg.contains("<title>&lt;/text&gt;&lt;script&gt;x&lt;/script&gt;</title>"));
    assert!(esc.svg.contains(r#"data-id="&quot;onload=&quot;alert(1)""#));

    // Hostile option values
    for &payload in PAYLOADS {
        let mut c = css_options();
        c.id_prefix = Some(payload.to_string());
        c.font_family = Some(payload.to_string());
        let mut r = resolved_options();
        r.id_prefix = Some(payload.to_string());
        r.font_family = Some(payload.to_string());
        assert!(check_both_modes("journey\n  accTitle: t\n  accDescr: d\n  Task: 5: Me", &c, &r));
    }

    // Mutated inputs fuzzing
    let owned_frags: Vec<String> = PAYLOADS.iter().flat_map(|p| variants(p)).collect();
    let mut frags: Vec<&str> = owned_frags.iter().map(String::as_str).collect();
    frags.extend([
        ":",
        ": 5",
        ": 3: Me",
        ",",
        "\n",
        "title ",
        "section ",
        "accTitle: ",
        "accDescr {",
        "}",
        "<br>",
        "#",
        "%%",
    ]);
    let mut mutator = Mutator::new(&corpus, frags, 3);
    let mut fuzz_rendered = 0;
    for _ in 0..1000 {
        let src = mutator.next_sample();
        if src.len() <= 4000 && check_both_modes(&src, &css, &res) {
            fuzz_rendered += 1;
        }
    }
    assert!(fuzz_rendered > 50, "expected >50 journey mutated renders, got {fuzz_rendered}");

    // Proto-pollution names
    let proto = render(
        "journey\n  section __proto__\n  constructor: 5: __proto__, constructor, toString, hasOwnProperty\n  __proto__: 1: valueOf\n",
        &css,
    )
    .unwrap();
    assert_eq!(count_class(&proto.svg, "pele-legend-item"), 5);
    assert!(proto.svg.contains(r#"data-id="__proto__""#));
}

#[test]
fn journey_stress_worst_cases() {
    const N: usize = 50_000;
    let big = RenderOptions {
        limit: Some(usize::MAX),
        output_limit: Some(usize::MAX),
        ..css_options()
    };
    let big = &big;
    type StressCase<'a> = (&'a str, Box<dyn Fn() + 'a>);
    let cases: Vec<StressCase<'_>> = vec![
        (
            "6,000 tasks",
            Box::new(move || {
                let _ = render(&format!("journey\n{}", "t: 5: a\n".repeat(N / 8)), big);
            }),
        ),
        (
            "5,000 tasks unique actors",
            Box::new(move || {
                let mut s = String::from("journey\n");
                for i in 0..5000 {
                    s.push_str(&format!("t: {}: a{i}\n", i % 6));
                }
                let _ = render(&s, big);
            }),
        ),
        (
            "16,000 actors",
            Box::new(move || {
                let mut s = String::from("journey\nt: 3: ");
                for i in 0..16_000 {
                    s.push_str(&format!("a{},", i % 9000));
                }
                let _ = render(&s, big);
            }),
        ),
        (
            "25,000 duplicate actors",
            Box::new(move || {
                let _ = render(&format!("journey\nt: 3: {}", "a,".repeat(N / 2)), big);
            }),
        ),
        (
            "25,000 empty actors",
            Box::new(move || {
                let _ = render(&format!("journey\nt: 3: {}", ",".repeat(N / 2)), big);
            }),
        ),
        (
            "5,000 empty sections",
            Box::new(move || {
                let _ = render(&format!("journey\n{}", "section s\n".repeat(N / 10)), big);
            }),
        ),
        (
            "50k task name",
            Box::new(move || {
                let _ = render(&format!("journey\n{}: 5", "t".repeat(N)), big);
            }),
        ),
        (
            "50k score digits",
            Box::new(move || {
                let _ = render(&format!("journey\nt: {}", "9".repeat(N)), big);
            }),
        ),
        (
            "25k colons",
            Box::new(move || {
                let _ = render(&format!("journey\nt{}x", ":".repeat(N / 2)), big);
            }),
        ),
        (
            "repeated keyword",
            Box::new(move || {
                let _ = tokenize(&"journey ".repeat(N / 8));
            }),
        ),
        (
            "unclosed accDescr",
            Box::new(move || {
                let _ = render(&format!("journey\naccDescr {{{}", " a\n".repeat(N / 3)), big);
            }),
        ),
    ];
    for (name, run) in cases {
        let start = Instant::now();
        run();
        let elapsed = start.elapsed().as_millis();
        assert!(elapsed < 3000, "journey stress '{name}' took {elapsed}ms");
    }
}
