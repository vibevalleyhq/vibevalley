mod support;

use std::time::Instant;

use indexmap::IndexMap;
use regex::Regex;
use roxmltree::Document;
use vibevalley_pele::config::DiagramConfig;
use vibevalley_pele::detect::DiagramType;
use vibevalley_pele::diagram::timeline::{TimelineDirection, TimelinePeriod, lexer::tokenize};
use vibevalley_pele::util::yaml::YamlValue;
use vibevalley_pele::{METRICS_MEASURER, ParseOptions, ParsedModel, RenderOptions, TextMeasurer, TextStyle, parse, render, supports};

use support::{Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, css_options, dark_options, load_fixture, resolved_options};

const SOCIAL: &str = "timeline\n  title History of Social Media\n  2002 : LinkedIn\n  2004 : Facebook : Google\n  2005 : YouTube\n";

fn count_class(svg: &str, cls: &str) -> usize {
    svg.matches(&format!(r#"class="{cls}""#)).count()
}

fn texts(svg: &str) -> Vec<String> {
    let re = Regex::new(r">([^<>]+)<").unwrap();
    re.captures_iter(svg).map(|c| c[1].to_string()).collect()
}

fn rects_of(svg: &str) -> Vec<(f64, f64, f64, f64, String)> {
    let doc = Document::parse(svg).expect("valid SVG XML");
    doc.descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "rect")
        .map(|n| {
            (
                n.attribute("x").unwrap_or("0").parse().unwrap_or(0.0),
                n.attribute("y").unwrap_or("0").parse().unwrap_or(0.0),
                n.attribute("width").unwrap_or("0").parse().unwrap_or(0.0),
                n.attribute("height").unwrap_or("0").parse().unwrap_or(0.0),
                n.attribute("fill").unwrap_or("").to_string(),
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
fn timeline_draws_title_periods_events_and_geometry() {
    let res = render(SOCIAL, &css_options()).unwrap();
    assert_eq!(res.diagram_type, DiagramType::Timeline);
    assert!(supports(SOCIAL));
    assert!(res.links.is_empty());
    assert!(res.svg.contains(r#"class="pele pele-timeline""#));
    assert!(res.svg.contains(">History of Social Media<"));
    assert_eq!(count_class(&res.svg, "pele-node pele-period"), 3);
    assert_eq!(count_class(&res.svg, "pele-node pele-event"), 4);
    assert_eq!(count_class(&res.svg, "pele-dot"), 3);
    assert_eq!(count_class(&res.svg, "pele-axis"), 1);
    assert_eq!(count_class(&res.svg, "pele-marker"), 1);
    assert_eq!(
        texts(&res.svg),
        vec!["History of Social Media", "2002", "LinkedIn", "2004", "Facebook", "Google", "2005", "YouTube"]
    );
    assert!(res.svg.contains(r#"data-id="2004""#));

    // Places periods left to right and events below their period
    let rects = rects_of(&res.svg);
    assert_eq!(rects[0].0, rects[1].0);
    assert!(rects[2].0 > rects[0].0);
    assert_eq!(rects[3].0, rects[2].0);
    assert_eq!(rects[4].0, rects[2].0);
    assert!(rects[5].0 > rects[2].0);
    assert_eq!(rects[2].1, rects[0].1);
    assert!(rects[1].1 > rects[0].1);
    assert!(rects[4].1 > rects[3].1);

    // Deterministic
    assert_eq!(res.svg, render(SOCIAL, &css_options()).unwrap().svg);

    // Light + dark resolved modes parse in resvg
    let light = render(SOCIAL, &resolved_options()).unwrap();
    assert_inert_resolved(&light.svg, "timeline light");
    assert_resvg_parses(&light.svg, "timeline light");
    let dark = render(SOCIAL, &dark_options()).unwrap();
    assert_inert_resolved(&dark.svg, "timeline dark");
    assert_resvg_parses(&dark.svg, "timeline dark");
}

#[test]
fn timeline_multicolor_sections_and_directions() {
    let multi = render(SOCIAL, &css_options()).unwrap().svg;
    assert!(multi.contains("var(--pele-series-1,"));
    assert!(multi.contains("var(--pele-series-2,"));
    assert!(multi.contains("var(--pele-series-3,"));

    let single = render(
        &format!("---\nconfig:\n  timeline:\n    disableMulticolor: true\n---\n{SOCIAL}"),
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(single.contains("var(--pele-series-1,"));
    assert!(!single.contains("var(--pele-series-2,"));

    let mut tl_cfg = IndexMap::new();
    tl_cfg.insert("disableMulticolor".to_string(), YamlValue::Bool(true));
    let mut cfg = DiagramConfig::default();
    cfg.sections.insert("timeline".to_string(), tl_cfg);
    let opts_with_cfg = RenderOptions {
        config: Some(cfg),
        ..css_options()
    };
    let directive = render(
        &format!("%%{{init: {{\"timeline\": {{\"disableMulticolor\": true}}}}}}%%\n{SOCIAL}"),
        &css_options(),
    )
    .unwrap()
    .svg;
    assert_eq!(directive, render(SOCIAL, &opts_with_cfg).unwrap().svg);
    assert!(!directive.contains("var(--pele-series-2,"));

    // Colors by section and draws header over each section
    let sec = render("timeline\n  section One\n    A : a\n    B : b\n  section Two\n    C : c\n", &css_options()).unwrap();
    assert_eq!(count_class(&sec.svg, "pele-cluster pele-section"), 2);
    assert!(sec.svg.contains(r#"data-id="One""#));
    assert!(sec.svg.contains(">One<"));
    assert!(!sec.svg.contains("var(--pele-series-3,"));
    let rects = rects_of(&sec.svg);
    let header = &rects[0];
    let a = &rects[1];
    let b = &rects[3];
    assert_eq!(header.0, a.0);
    assert_eq!(header.2, b.0 + b.2 - a.0);
    assert_eq!(a.4, header.4);
    assert_eq!(b.4, header.4);

    // Keeps periods before first section, empty sections, duplicate names
    let pre = render(
        "timeline\n  Early : e\n  section Same\n    A\n  section Empty\n  section Same\n    B\n",
        &css_options(),
    )
    .unwrap();
    assert_eq!(count_class(&pre.svg, "pele-node pele-period"), 3);
    assert_eq!(count_class(&pre.svg, "pele-cluster pele-section"), 3);
    assert!(pre.svg.contains(r#"fill="var(--_m)""#));
    assert!(pre.svg.find(">Early<").unwrap() < pre.svg.find(">Same<").unwrap());

    // TD vs LR
    let lr = render(SOCIAL, &css_options()).unwrap();
    let td = render(&SOCIAL.replace("timeline", "timeline TD"), &css_options()).unwrap();
    assert_eq!(render(&SOCIAL.replace("timeline", "timeline LR"), &css_options()).unwrap().svg, lr.svg);
    assert!(td.height > lr.height);
    assert!(td.width < lr.width);
    assert_eq!(count_class(&td.svg, "pele-node pele-period"), 3);
    assert_eq!(count_class(&td.svg, "pele-node pele-event"), 4);
    let td_rects = rects_of(&td.svg);
    assert!(td_rects[2].1 > td_rects[0].1);
    assert!(td_rects[1].0 > td_rects[0].0);

    // Straight line from period to first event in TD whichever box is taller
    let td_tall = render(
        "timeline TD\n  2002 : LinkedIn\n  2004 : Facebook : Google\n  2005<br>and on<br>and on : YouTube\n  2006 : first<br>second<br>third<br>fourth\n",
        &css_options(),
    )
    .unwrap();
    let re_rect = Regex::new(r#"<rect [^>]*y="([\d.]+)" width="[\d.]+" height="([\d.]+)""#).unwrap();
    let re_edge = Regex::new(r#"class="pele-edge" d="([^"]+)""#).unwrap();
    let re_stub = Regex::new(r"M[\d.]+,([\d.]+)H").unwrap();
    let rows: Vec<&str> = td_tall.svg.split(r#"<g class="pele-node pele-period""#).skip(1).collect();
    assert_eq!(rows.len(), 4);
    let mut above = 0.0f64;
    for row in rows {
        let boxes: Vec<(f64, f64, f64)> = re_rect
            .captures_iter(row)
            .map(|c| {
                let y: f64 = c[1].parse().unwrap();
                let h: f64 = c[2].parse().unwrap();
                (y, y + h, y + h / 2.0)
            })
            .collect();
        let period = boxes[0];
        let event = boxes[1];
        assert!((event.2 - period.2).abs() < 1e-6);
        let d = &re_edge.captures(row).unwrap()[1];
        let stubs: Vec<f64> = re_stub.captures_iter(d).take(2).map(|c| c[1].parse().unwrap()).collect();
        assert_eq!(stubs, vec![period.2, period.2]);
        let min_top = boxes.iter().map(|b| b.0).fold(f64::INFINITY, f64::min);
        assert!(min_top > above);
        above = boxes.iter().map(|b| b.1).fold(f64::NEG_INFINITY, f64::max);
    }

    let td_res = render(&SOCIAL.replace("timeline", "timeline TD"), &resolved_options()).unwrap();
    assert_inert_resolved(&td_res.svg, "timeline TD");
    assert_resvg_parses(&td_res.svg, "timeline TD");
}

#[test]
fn timeline_wrapping_entities_accessibility_empty_errors_and_model() {
    let one = render("timeline\n  2001 : first second\n", &css_options()).unwrap();
    let two = render("timeline\n  2001 : first<br>second\n", &css_options()).unwrap();
    assert!(two.height > one.height);
    assert_eq!(two.width, one.width);
    assert_eq!(texts(&two.svg), vec!["2001", "first", "second"]);
    assert_eq!(
        texts(&render("timeline\n  2001 : a<br/>b<br />c\n", &css_options()).unwrap().svg),
        vec!["2001", "a", "b", "c"]
    );
    let long = render(&format!("timeline\n  2001 : {}\n", "several words that go on ".repeat(6)), &css_options()).unwrap();
    assert_eq!(long.width, one.width);
    let long_texts = texts(&long.svg);
    assert!(long_texts.len() > 6);
    for line in &long_texts {
        assert!(METRICS_MEASURER.width(line, 14.0, TextStyle::default()) <= 152.0);
    }

    // Widens columns for long word, then cuts it
    let base = render("timeline\n  2001 : short\n", &css_options()).unwrap();
    let word = "Supercalifragilisticexpiali";
    assert!(METRICS_MEASURER.width(word, 14.0, TextStyle::default()) > 152.0);
    assert!(METRICS_MEASURER.width(word, 14.0, TextStyle::default()) < 216.0);
    let wider = render(&format!("timeline\n  2001 : {word}\n"), &css_options()).unwrap();
    let cut = render(&format!("timeline\n  2001 : {}\n", "x".repeat(300)), &css_options()).unwrap();
    assert!(wider.width > base.width);
    assert_eq!(texts(&wider.svg), vec!["2001", word]);
    assert!(cut.width <= base.width + 64.0);
    let cut_texts = texts(&cut.svg);
    assert_eq!(cut_texts[1..].join(""), "x".repeat(300));
    let cut_rects = rects_of(&cut.svg);
    for line in &cut_texts[1..] {
        assert!(METRICS_MEASURER.width(line, 14.0, TextStyle::default()) <= cut_rects[1].2 - 24.0);
    }

    // Entities, tags, links, icon names shown literally
    let lit = render(
        "timeline\n  2001 : #35;1 &amp; <b>bold</b> [link](http://example.com) fa:fa-check a<T>\n",
        &css_options(),
    )
    .unwrap();
    assert_eq!(
        texts(&lit.svg)[1..].join(" "),
        "#1 &amp; &lt;b&gt;bold&lt;/b&gt; [link](http://example.com) fa:fa-check a&lt;T&gt;"
    );
    assert!(!lit.svg.contains("<a"));
    assert!(!lit.svg.contains("pele-icon"));

    // Front matter title vs own title
    assert!(
        render("---\ntitle: From front matter\n---\ntimeline\n  2001\n", &css_options())
            .unwrap()
            .svg
            .contains(">From front matter<")
    );
    let own = render("---\ntitle: From front matter\n---\ntimeline\n  title Own\n  2001\n", &css_options()).unwrap();
    assert!(own.svg.contains(">Own<"));
    assert!(!own.svg.contains("From front matter"));

    // Accessible names
    let acc = render(
        "timeline\n  accTitle: Short name\n  accDescr {\n    A longer\n    description\n  }\n  2001\n",
        &css_options(),
    )
    .unwrap();
    assert!(acc.svg.contains(r#"<title id="pele-title">Short name</title>"#));
    assert!(acc.svg.contains("<desc id=\"pele-desc\">A longer\ndescription</desc>"));

    // Empty, lone title, sections without periods
    for src in [
        "timeline",
        "timeline TD",
        "timeline\n  title Only",
        "timeline\n  section S",
        "timeline TD\n  section S\n  section T",
    ] {
        let r = render(src, &css_options()).unwrap();
        assert!(!r.svg.contains("NaN") && !r.svg.contains("Infinity") && !r.svg.contains("undefined"));
        assert!(r.width > 0.0 && r.height > 0.0);
        assert_eq!(count_class(&r.svg, "pele-axis"), 0);
        let rr = render(src, &resolved_options()).unwrap();
        assert_inert_resolved(&rr.svg, src);
        assert_resvg_parses(&rr.svg, src);
    }

    // Rejects what Mermaid rejects
    assert!(render("timeline\n  : orphan event\n", &css_options()).is_err());
    let err = render("timeline\n  2001 :no space\n", &css_options()).unwrap_err();
    assert!(err.message.contains("got 'INVALID'"), "unexpected err: {}", err.message);
    let err2 = render("timeline\n  Timeline of things : x\n", &css_options()).unwrap_err();
    assert!(err2.message.contains("got 'timeline'"), "unexpected err: {}", err2.message);
    assert!(render("timeline\n  accDescr {\n  never closed\n", &css_options()).is_err());

    // Bare title vs NBSP title
    let ParsedModel::Timeline(m) = parse("timeline\ntitle\n2024 : Event\n2025 : Next", &ParseOptions::default()).unwrap().model else {
        panic!("expected timeline");
    };
    assert_eq!(m.title, None);
    let period_texts: Vec<&str> = m.periods.iter().map(|p| p.text.as_str()).collect();
    assert_eq!(period_texts, vec!["2024 ", "2025 "]);
    let ParsedModel::Timeline(m_nbsp) = parse("timeline\n  title\u{00a0}Kept\n  2024 : Event", &ParseOptions::default()).unwrap().model else {
        panic!("expected timeline");
    };
    assert_eq!(m_nbsp.title.as_deref(), Some("Kept"));

    // Keeps character before comment
    let ParsedModel::Timeline(m_cmt) = parse("timeline\nA%% label : event\nB : e2", &ParseOptions::default()).unwrap().model else {
        panic!("expected timeline");
    };
    let cmt_texts: Vec<&str> = m_cmt.periods.iter().map(|p| p.text.as_str()).collect();
    assert_eq!(cmt_texts, vec!["A%% label ", "B "]);
    let err3 = render("timeline\n  2024 :%% c\n", &css_options()).unwrap_err();
    assert!(err3.message.contains("got 'INVALID'"), "unexpected err: {}", err3.message);

    // Event after section header attaches to last period
    let ParsedModel::Timeline(m_sec) = parse("timeline\n  2001 : a\n  section S\n  : b\n", &ParseOptions::default()).unwrap().model else {
        panic!("expected timeline");
    };
    assert_eq!(m_sec.periods[0].events, vec!["a", "b"]);

    // Exposes full model
    let ParsedModel::Timeline(m_full) = parse(
        "timeline TD\n  title T\n  First\n  section S\n    2001 : a : b\n    2002\n",
        &ParseOptions::default(),
    )
    .unwrap()
    .model
    else {
        panic!("expected timeline");
    };
    assert_eq!(m_full.title.as_deref(), Some("T"));
    assert_eq!(m_full.direction, TimelineDirection::Td);
    assert_eq!(m_full.sections, vec!["S"]);
    assert_eq!(
        m_full.periods,
        vec![
            TimelinePeriod {
                text: "First".to_string(),
                events: vec![],
                section: String::new(),
                section_index: -1,
            },
            TimelinePeriod {
                text: "2001 ".to_string(),
                events: vec!["a ".to_string(), "b".to_string()],
                section: "S".to_string(),
                section_index: 0,
            },
            TimelinePeriod {
                text: "2002".to_string(),
                events: vec![],
                section: "S".to_string(),
                section_index: 0,
            },
        ]
    );
}

#[test]
fn timeline_compat_specs() {
    let parse_tl = |s: &str| match parse(s, &ParseOptions::default()).unwrap().model {
        ParsedModel::Timeline(m) => m,
        other => panic!("expected timeline, got {:?}", other.diagram_type()),
    };

    assert_eq!(parse_tl("timeline\n    section abc-123").direction, TimelineDirection::Lr);
    assert_eq!(parse_tl("timeline TD\n    section abc-123").direction, TimelineDirection::Td);
    assert_eq!(parse_tl("timeline LR\n    section abc-123").direction, TimelineDirection::Lr);
    assert_eq!(parse_tl("timeline\n    section abc-123").sections, vec!["abc-123"]);

    let m = parse_tl("timeline\n    section abc-123\n      task1: event1\n      task2: event2: event3\n           : event4: event5\n");
    assert_eq!(m.sections, vec!["abc-123"]);
    assert_eq!(m.periods[0].events, vec!["event1"]);
    assert_eq!(m.periods[1].events, vec!["event2", "event3", "event4", "event5"]);

    let m_semi = parse_tl("timeline\n      title ;my;title;\n      section ;a;bc-123;\n      ;ta;sk1;: ;ev;ent1; : ;ev;ent2; : ;ev;ent3;\n");
    assert_eq!(m_semi.title.as_deref(), Some(";my;title;"));
    assert_eq!(m_semi.sections, vec![";a;bc-123;"]);
    assert_eq!(m_semi.periods[0].events, vec![";ev;ent1; ", ";ev;ent2; ", ";ev;ent3;"]);

    let m_hash = parse_tl("timeline\n      title #my#title#\n      section #a#bc-123#\n      task1: #ev#ent1# : #ev#ent2# : #ev#ent3#\n");
    assert_eq!(m_hash.title.as_deref(), Some("#my#title#"));
    assert_eq!(m_hash.sections, vec!["#a#bc-123#"]);
    assert_eq!(m_hash.periods[0].text, "task1");
    assert_eq!(m_hash.periods[0].events, vec!["#ev#ent1# ", "#ev#ent2# ", "#ev#ent3#"]);
}

#[test]
fn timeline_security_corpus_payloads_options_and_mutated_fuzz() {
    let corpus = load_fixture("timeline-corpus.json");
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
    assert!(rendered > 15, "expected >15 timeline corpus renders, got {rendered}");

    let templates: Vec<fn(&str) -> String> = vec![
        |p| format!("timeline\n  title {p}\n  2001 : a"),
        |p| format!("timeline\n  {p}"),
        |p| format!("timeline\n  {p} : event"),
        |p| format!("timeline\n  2001 : {p}"),
        |p| format!("timeline\n  2001 : a : {p} : b"),
        |p| format!("timeline\n  2001 : a\n       : {p}"),
        |p| format!("timeline\n  section {p}\n  2001 : a"),
        |p| format!("timeline\n  section {p}"),
        |p| format!("timeline TD\n  title {p}\n  section {p}\n  {p} : {p}"),
        |p| format!("timeline TD\n  x{p} : y{p} : z{p}"),
        |p| format!("timeline {p}\n  2001 : a"),
        |p| format!("timeline\n  accTitle: {p}\n  accDescr: {p}\n  2001 : a"),
        |p| format!("timeline\n  accDescr {{\n {p}\n }}\n  2001 : a"),
        |p| format!("timeline\n  2001 : a<br>{p}<br/>b"),
        |p| format!("timeline\n  2001 : <b>{p}</b> <i>{p}"),
        |p| format!("timeline\n  2001 : fa:fa-{p} x"),
        |p| format!("timeline\n  %% {p}\n  2001 : a # {p}"),
        |p| format!("---\ntitle: \"{p}\"\n---\ntimeline\n  2001 : a"),
        |p| format!("---\nconfig:\n  timeline:\n    disableMulticolor: \"{p}\"\n---\ntimeline\n  2001 : a\n  2002 : b"),
        |p| format!("---\nconfig:\n  timeline: \"{p}\"\n---\ntimeline\n  2001 : a"),
        |p| {
            format!(
                "%%{{init: {{\"timeline\": {{\"disableMulticolor\": \"{p}\", \"padding\": \"{p}\"}}, \"themeVariables\": {{\"cScale0\": \"{p}\"}}}}}}%%\ntimeline\n  2001 : a"
            )
        },
    ];

    let mut payload_rendered = 0;
    for tmpl in &templates {
        for &payload in PAYLOADS {
            if check_both_modes(&tmpl(payload), &css, &res) {
                payload_rendered += 1;
            }
        }
    }
    assert!(payload_rendered > 500, "expected >500 payload renders, got {payload_rendered}");

    // Shows markup as escaped text
    let esc = render(
        r#"timeline
  title <script>alert(1)</script>
  section "><img src=x onerror=alert(1)>
  <svg onload=alert(1)> : </text><script>x</script>"#,
        &css,
    )
    .unwrap();
    assert!(!esc.svg.contains("<script"));
    assert!(!esc.svg.contains("<img"));
    assert!(esc.svg.contains("&lt;script&gt;"));
    assert!(esc.svg.contains(r#"data-id="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;""#));

    // Hostile option values
    for &payload in PAYLOADS {
        let mut c = css_options();
        c.id_prefix = Some(payload.to_string());
        c.font_family = Some(payload.to_string());
        let mut r = resolved_options();
        r.id_prefix = Some(payload.to_string());
        r.font_family = Some(payload.to_string());
        assert!(check_both_modes("timeline\n  accTitle: t\n  accDescr: d\n  2001 : a", &c, &r));
    }

    // Mutated inputs fuzzing
    let mut frags: Vec<&str> = PAYLOADS.to_vec();
    frags.extend([
        ":",
        " : ",
        "\n",
        "title ",
        "section ",
        "accTitle: ",
        "accDescr {",
        "}",
        "<br>",
        " TD",
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
    assert!(fuzz_rendered > 100, "expected >100 mutated renders, got {fuzz_rendered}");
}

#[test]
fn timeline_stress_worst_cases() {
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
            "8,000 periods",
            Box::new(move || {
                let _ = render(&format!("timeline\n{}", "p : e\n".repeat(N / 6)), big);
            }),
        ),
        (
            "8,000 periods TD",
            Box::new(move || {
                let _ = render(&format!("timeline TD\n{}", "p : e\n".repeat(N / 6)), big);
            }),
        ),
        (
            "12,000 events",
            Box::new(move || {
                let _ = render(&format!("timeline\np{}", " : e".repeat(N / 4)), big);
            }),
        ),
        (
            "12,000 events TD",
            Box::new(move || {
                let _ = render(&format!("timeline TD\np{}", " : e".repeat(N / 4)), big);
            }),
        ),
        (
            "5,000 sections",
            Box::new(move || {
                let _ = render(&format!("timeline\n{}", "section s\np\n".repeat(N / 10)), big);
            }),
        ),
        (
            "5,000 empty sections TD",
            Box::new(move || {
                let _ = render(&format!("timeline TD\n{}", "section s\n".repeat(N / 10)), big);
            }),
        ),
        (
            "50k period",
            Box::new(move || {
                let _ = render(&format!("timeline\n{}", "p".repeat(N)), big);
            }),
        ),
        (
            "50k event",
            Box::new(move || {
                let _ = render(&format!("timeline\np : {}", "e".repeat(N)), big);
            }),
        ),
        (
            "10k words",
            Box::new(move || {
                let _ = render(&format!("timeline\np : {}", "word ".repeat(N / 5)), big);
            }),
        ),
        (
            "12k br",
            Box::new(move || {
                let _ = render(&format!("timeline\np : {}", "a<br>".repeat(N / 5)), big);
            }),
        ),
        (
            "unclosed tags",
            Box::new(move || {
                let _ = render(&format!("timeline\np : {}", "<a".repeat(N / 2)), big);
            }),
        ),
        (
            "colons no space",
            Box::new(move || {
                let _ = render(&format!("timeline\np{}", ":".repeat(N)), big);
            }),
        ),
        (
            "colons with space",
            Box::new(move || {
                let _ = render(&format!("timeline\np{}", ": ".repeat(N / 2)), big);
            }),
        ),
        (
            "keyword spaces no dir",
            Box::new(move || {
                let _ = tokenize(&format!("timeline{}LX", " ".repeat(N)));
            }),
        ),
        (
            "accTitle spaces",
            Box::new(move || {
                let _ = render(&format!("timeline\naccTitle{}", " ".repeat(N)), big);
            }),
        ),
        (
            "unclosed accDescr",
            Box::new(move || {
                let _ = render(&format!("timeline\naccDescr {{{}", " a\n".repeat(N / 3)), big);
            }),
        ),
        (
            "percent comments",
            Box::new(move || {
                let _ = render(&format!("timeline\n{}", "x%%\n%\n%{\n".repeat(N / 9)), big);
            }),
        ),
    ];
    for (name, run) in cases {
        let start = Instant::now();
        run();
        let elapsed = start.elapsed().as_millis();
        assert!(elapsed < 3000, "timeline stress '{name}' took {elapsed}ms");
    }
}
