use std::time::Instant;

use vibevalley_pele::detect::DiagramType;
use vibevalley_pele::diagram::info::parser::parse_info;
use vibevalley_pele::diagram::info::render::VERSION;
use vibevalley_pele::{ParseOptions, ParsedModel, RenderOptions, parse, render, supports};

use crate::support::{Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, css_options, dark_options, load_fixture, resolved_options};

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
fn info_renders_version_title_and_accessibility() {
    let res = render("info", &css_options()).unwrap();
    assert_eq!(res.diagram_type, DiagramType::Info);
    assert!(supports("info showInfo"));
    assert!(res.svg.contains(&format!(">Pele v{VERSION}<")));
    assert!(res.svg.contains(r#"class="pele-version""#));
    assert!(res.width < 200.0);
    assert!(res.height < 60.0);
    assert_eq!(render("info\nshowInfo\n", &css_options()).unwrap().svg, res.svg);

    let resolved = render("info", &resolved_options()).unwrap();
    assert_inert_resolved(&resolved.svg, "info resolved");
    assert_resvg_parses(&resolved.svg, "info resolved");
    let dark = render("info", &dark_options()).unwrap();
    assert_inert_resolved(&dark.svg, "info dark");
    assert_resvg_parses(&dark.svg, "info dark");

    let titled = render("---\ntitle: From front matter\n---\ninfo", &css_options()).unwrap();
    assert!(titled.svg.contains(">From front matter<"));
    assert!(titled.height > res.height);
    let own = render("---\ntitle: From front matter\n---\ninfo\ntitle Own", &css_options()).unwrap().svg;
    assert!(own.contains(">Own<"));
    assert!(!own.contains("From front matter"));

    let src = "info showInfo\naccTitle: Name\naccDescr: Text";
    let acc = render(src, &css_options()).unwrap();
    assert!(acc.svg.contains(r#"<title id="pele-title">Name</title>"#));
    assert!(acc.svg.contains(r#"<desc id="pele-desc">Text</desc>"#));
    let parsed = parse(src, &ParseOptions::default()).unwrap();
    assert_eq!(parsed.diagram_type, DiagramType::Info);
    match parsed.model {
        ParsedModel::Info(m) => {
            assert_eq!(m.title, None);
            assert_eq!(m.acc_title.as_deref(), Some("Name"));
            assert_eq!(m.acc_descr.as_deref(), Some("Text"));
        }
        other => panic!("expected Info model, got {other:?}"),
    }

    let err1 = render("info unsupported", &css_options()).unwrap_err();
    assert!(err1.message.contains("Lexical error on line 1"), "err={err1}");
    let err2 = render("info\ntitle a\nshowInfo", &css_options()).unwrap_err();
    assert!(err2.message.contains("Parse error on line 3"), "err={err2}");
}

#[test]
fn info_is_inert_for_corpus_hostile_and_mutated_inputs() {
    let corpus = load_fixture("info-corpus.json");
    assert!(corpus.len() >= 8);
    for src in &corpus {
        check_both(src, None, None);
    }

    let mut rendered = 0usize;
    for &p in PAYLOADS {
        let templates = [
            format!("info\ntitle {p}"),
            format!("info showInfo title {p}"),
            format!("info\naccTitle: {p}\naccDescr: {p}"),
            format!("info\naccDescr {{\n {p}\n }}"),
            format!("info %% {p}"),
            format!("info {p}"),
            format!("---\ntitle: \"{p}\"\n---\ninfo"),
            format!(r#"%%{{init: {{"themeVariables": {{"fontFamily": "{p}"}}}}}}%%"#) + "\ninfo",
        ];
        for src in templates {
            if check_both(&src, None, None) {
                rendered += 1;
            }
        }
        assert!(check_both("info\naccTitle: t", Some(p), Some(p)));
    }
    assert!(rendered > 150, "rendered={rendered}");

    let mut seeds = corpus;
    seeds.push("info\ntitle T\naccTitle: A\naccDescr: D\n".to_string());
    seeds.push("---\ntitle: T\n---\ninfo showInfo\n".to_string());
    let mut frags: Vec<&str> = PAYLOADS.to_vec();
    frags.extend_from_slice(&["\n", "title ", "accTitle: ", "accDescr {", "}", "showInfo"]);
    let mut mutator = Mutator::new(&seeds, frags, 3);
    for _ in 0..2000 {
        let src = mutator.next_sample();
        if src.len() <= 4000 {
            check_both(&src, None, None);
        }
    }
}

#[test]
fn info_stays_fast_on_stress_inputs() {
    const N: usize = 50_000;
    let big = RenderOptions {
        limit: Some(usize::MAX),
        ..css_options()
    };
    let cases: Vec<Box<dyn Fn()>> = vec![
        Box::new(|| {
            let _ = render(&format!("info\ntitle {}", "word ".repeat(N / 5)), &big);
        }),
        Box::new(|| {
            let _ = render(&format!("info\n{}", "title t\n".repeat(N / 8)), &big);
        }),
        Box::new(|| {
            let _ = render(&format!("info\ntitle {}", "#35;&amp;<br>".repeat(N / 13)), &big);
        }),
        Box::new(|| {
            let _ = render(&format!("info{}showInfo", "\n ".repeat(N / 2)), &big);
        }),
        Box::new(|| {
            let _ = parse_info(&format!("info{}showInfo", " ".repeat(N)), None);
        }),
        Box::new(|| {
            let _ = parse_info(&format!("info\n{}", "%% c\n".repeat(N / 5)), None);
        }),
        Box::new(|| {
            let _ = parse_info(&format!("info\n{}", "%%{\n".repeat(N / 4)), None);
        }),
        Box::new(|| {
            let _ = parse_info(&format!("info\n{}", "---\n".repeat(N / 4)), None);
        }),
        Box::new(|| {
            let _ = parse_info(&format!("info\naccDescr {{{}", " a\n".repeat(N / 3)), None);
        }),
        Box::new(|| {
            let _ = render(&format!("info\naccDescr {{{}}}", " a\n".repeat(N / 3)), &big);
        }),
        Box::new(|| {
            let _ = render(&format!("info\naccTitle: {}", "x".repeat(N)), &big);
        }),
        Box::new(|| {
            let _ = parse_info(&"info ".repeat(N / 5), None);
        }),
        Box::new(|| {
            let _ = parse_info(&format!("info {}", "showInfo".repeat(N / 8)), None);
        }),
    ];
    for (i, run) in cases.iter().enumerate() {
        let started = Instant::now();
        run();
        assert!(started.elapsed().as_millis() < 3000, "slow info stress case #{i}: {:?}", started.elapsed());
    }
}
