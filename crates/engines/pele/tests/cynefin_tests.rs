mod support;

use std::time::Instant;

use vibevalley_pele::detect::DiagramType;
use vibevalley_pele::diagram::cynefin::DomainName;
use vibevalley_pele::diagram::cynefin::boundaries::{FOLD, HORIZON, cliff, curve_path, ellipse_path, hash_string, resolve_seed, seeded_random, wave};
use vibevalley_pele::{ParseOptions, ParsedModel, RenderOptions, parse, render, supports};

use support::{Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, css_options, dark_options, load_fixture, resolved_options};

const BASIC: &str = "cynefin-beta\n  title Incident Response\n  complex\n    \"Investigate root cause\"\n    \"Run chaos experiment\"\n  complicated\n    \"Expert review needed\"\n  clear\n    \"Restart service\"\n  chaotic\n    \"Page on-call immediately\"\n  confusion\n    \"Unknown failure mode\"\n";

fn check_both(src: &str) -> bool {
    let ok = match render(src, &css_options()) {
        Ok(r) => {
            assert_inert(&r.svg, src);
            true
        }
        Err(_) => false,
    };
    if let Ok(r) = render(src, &resolved_options()) {
        assert_inert_resolved(&r.svg, src);
        assert_resvg_parses(&r.svg, src);
    }
    ok
}

#[test]
fn cynefin_boundaries_are_deterministic_and_bounded() {
    assert_eq!(seeded_random(42.0), seeded_random(42.0));
    for i in 0..100 {
        let v = seeded_random(i as f64);
        assert!((0.0..1.0).contains(&v), "out of range: {v}");
    }
    assert_eq!(hash_string("pele"), hash_string("pele"));
    assert_ne!(hash_string("pele"), hash_string("other"));
    assert_eq!(resolve_seed(Some(7.0), "pele"), 7.0);
    assert_eq!(resolve_seed(Some(0.0), "pele"), hash_string("pele") as f64);
    assert_eq!(resolve_seed(None, "pele"), hash_string("pele") as f64);
    assert_eq!(resolve_seed(Some(f64::NAN), "pele"), hash_string("pele") as f64);
    assert_eq!(resolve_seed(Some(f64::INFINITY), "pele"), hash_string("pele") as f64);

    let f1 = curve_path(&wave(0.0, 200.0, 300.0, 42.0, 8.0, FOLD));
    let f2 = curve_path(&wave(0.0, 200.0, 300.0, 42.0, 8.0, FOLD));
    assert_eq!(f1, f2);
    assert!(f1.starts_with('M') && f1.contains('C'));
    assert!(curve_path(&wave(0.0, 300.0, 200.0, 42.0, 8.0, HORIZON)).contains('C'));
    assert!(curve_path(&cliff(300.0, 200.0, 400.0, 12.0)).contains('C'));
    assert!(ellipse_path(300.0, 200.0, 80.0, 60.0).ends_with('Z'));
}

#[test]
fn cynefin_renders_domains_transitions_overflow_and_options() {
    let res = render(BASIC, &css_options()).unwrap();
    assert_eq!(res.diagram_type, DiagramType::Cynefin);
    assert!(supports(BASIC));
    assert_eq!(res.svg.matches(r#"class="pele-cynefin-region""#).count(), 5);
    assert_eq!(res.svg.matches(r#"class="pele-cynefin-domain""#).count(), 5);
    assert_eq!(res.svg.matches(r#"class="pele-node""#).count(), 6);
    for name in ["Complex", "Complicated", "Clear", "Chaotic", "Confusion"] {
        assert!(res.svg.contains(&format!(">{name}<")));
    }
    assert!(res.svg.contains("Probe → Sense → Respond"));
    assert!(res.svg.contains(">Disorder<"));
    assert!(res.svg.contains(r#"class="pele-cynefin-cliff""#));
    assert!(res.svg.contains(">Incident Response<"));
    for i in 1..=5 {
        assert!(res.svg.contains(&format!("var(--pele-series-{i},")));
    }
    assert!(!res.svg.contains("NaN"));

    let resolved = render(BASIC, &resolved_options()).unwrap();
    assert_inert_resolved(&resolved.svg, "cynefin basic resolved");
    assert_resvg_parses(&resolved.svg, "cynefin basic resolved");
    let dark = render(BASIC, &dark_options()).unwrap();
    assert_inert_resolved(&dark.svg, "cynefin basic dark");
    assert_resvg_parses(&dark.svg, "cynefin basic dark");

    // Empty cynefin still draws all 5 domains
    let empty = render("cynefin-beta", &resolved_options()).unwrap();
    assert_eq!(empty.svg.matches(r#"class="pele-cynefin-domain""#).count(), 5);
    assert_eq!(empty.svg.matches(r#"class="pele-node"#).count(), 0);
    assert_resvg_parses(&empty.svg, "cynefin empty");

    // Transitions + dropping self-loops
    let t_src = "cynefin-beta\ncomplex --> complicated : \"Pattern identified\"\nclear --> chaotic\nclear --> clear : \"ignored\"\ncomplex --> clear : \"diagonal\"\nconfusion --> chaotic\n";
    let t_res = render(t_src, &css_options()).unwrap();
    assert_eq!(t_res.svg.matches(r#"class="pele-edge""#).count(), 4);
    assert_eq!(t_res.svg.matches(r#"class="pele-marker""#).count(), 4);
    assert!(t_res.svg.contains(r#"data-id="complex-complicated""#));
    assert!(t_res.svg.contains(">Pattern identified</text>"));
    assert!(!t_res.svg.contains("ignored"));
    let parsed = parse(t_src, &ParseOptions::default()).unwrap();
    if let ParsedModel::Cynefin(m) = parsed.model {
        let pairs: Vec<String> = m.transitions.iter().map(|t| format!("{}>{}", t.from.as_str(), t.to.as_str())).collect();
        assert_eq!(pairs, vec!["complex>complicated", "clear>chaotic", "complex>clear", "confusion>chaotic"]);
    }

    // Confusion overflow cap at 3
    let ov = render("cynefin-beta\nconfusion\n\"a\"\n\"b\"\n\"c\"\n\"d\"\n\"e\"\n", &css_options()).unwrap();
    assert_eq!(ov.svg.matches(r#"class="pele-node""#).count(), 3);
    assert!(ov.svg.contains(r#"class="pele-node pele-cynefin-overflow""#));
    assert!(ov.svg.contains(">+2 more</text>"));

    // Duplicate domain replaces earlier
    let dup = parse("cynefin-beta\ncomplex\n\"first\"\ncomplex\n\"second\"\n", &ParseOptions::default()).unwrap();
    if let ParsedModel::Cynefin(m) = dup.model {
        let labels: Vec<&str> = m.domains[&DomainName::Complex].items.iter().map(|i| i.label.as_str()).collect();
        assert_eq!(labels, vec!["second"]);
    }

    // Long lists grow height, long labels wrap
    let base = render("cynefin-beta\ncomplex\n\"a\"\n", &css_options()).unwrap();
    let tall = render(&format!("cynefin-beta\ncomplex\n{}", "\"an item\"\n".repeat(20)), &css_options()).unwrap();
    let wide = render(&format!("cynefin-beta\ncomplex\n\"{}\"\n", "word ".repeat(30)), &css_options()).unwrap();
    assert!(tall.height > base.height);
    assert!(wide.width < base.width + 200.0);
    assert!(wide.svg.matches("<tspan").count() > 3);

    // Config options
    let front = |cfg: &str| format!("---\nconfig:\n  cynefin:\n{cfg}---\n{BASIC}");
    assert!(
        !render(&front("    showDomainDescriptions: false\n"), &css_options())
            .unwrap()
            .svg
            .contains("Probe")
    );
    assert!(render(&front("    width: 1200\n    height: 900\n"), &css_options()).unwrap().width > res.width);
    assert_ne!(render(&front("    boundaryAmplitude: 0\n"), &css_options()).unwrap().svg, res.svg);
    assert_ne!(
        render(&front("    seed: 5\n"), &css_options()).unwrap().svg,
        render(&front("    seed: 6\n"), &css_options()).unwrap().svg,
    );
    assert_ne!(
        render(
            BASIC,
            &RenderOptions {
                id_prefix: Some("other".into()),
                ..css_options()
            }
        )
        .unwrap()
        .svg,
        res.svg,
    );
    assert_eq!(render(BASIC, &css_options()).unwrap().svg, res.svg);

    // Titles + accessibility + rejections
    let acc = render(
        "---\ntitle: Front\n---\ncynefin-beta\naccTitle: Acc\naccDescr: Described\nclear\n\"a\"\n",
        &css_options(),
    )
    .unwrap();
    assert!(acc.svg.contains(">Front<"));
    assert!(acc.svg.contains(r#"<title id="pele-title">Acc</title>"#));
    assert!(acc.svg.contains(r#"<desc id="pele-desc">Described</desc>"#));
    assert!(
        render("---\ntitle: Front\n---\ncynefin-beta\ntitle Own\n", &css_options())
            .unwrap()
            .svg
            .contains(">Own<")
    );

    for bad in [
        "cynefin-beta\n\"orphan\"",
        "cynefin-beta\ncomplexity",
        "cynefin-beta\ncomplex --> nowhere",
        "cynefin-beta\ncomplex --> clear clear",
        "cynefin-betax",
    ] {
        assert!(render(bad, &css_options()).is_err(), "expected error for {bad}");
    }
}

#[test]
fn cynefin_is_inert_for_corpus_hostile_extreme_and_mutated_inputs() {
    let corpus = load_fixture("cynefin-corpus.json");
    assert!(corpus.len() >= 15);
    let mut corpus_ok = 0usize;
    for src in &corpus {
        if check_both(src) {
            corpus_ok += 1;
        }
    }
    assert!(corpus_ok > 0);

    let mut rendered = 0usize;
    for &p in PAYLOADS {
        let q: String = p.chars().filter(|&c| !matches!(c, '"' | '\\' | '\n')).collect();
        let s: String = p.chars().filter(|&c| !matches!(c, '\'' | '\\' | '\n')).collect();
        let templates = [
            format!("cynefin-beta\ncomplex\n\"{q}\""),
            format!("cynefin-beta\ncomplex\n'{s}'"),
            format!("cynefin-beta\nconfusion\n\"{q}\"\n\"{q}\"\n\"{q}\"\n\"{q}\""),
            format!("cynefin-beta\nclear\n\"a \\\"{q}\\\" \\\\ b\""),
            format!("cynefin-beta\ncomplex --> clear : \"{q}\""),
            format!("cynefin-beta\nconfusion --> chaotic : '{s}'"),
            format!("cynefin-beta\ntitle {p}\ncomplex"),
            format!("cynefin-beta\naccTitle: {p}\naccDescr: {p}\ncomplex"),
            format!("cynefin-beta\naccDescr {{\n {p}\n}}\ncomplex"),
            format!("cynefin-beta\n{p}"),
            format!("cynefin-beta\ncomplex --> {p}"),
            format!("---\ntitle: \"{q}\"\n---\ncynefin-beta\ncomplex\n\"a\""),
            format!(
                "---\nconfig:\n  cynefin:\n    width: '{s}'\n    height: 1e999\n    seed: .nan\n    boundaryAmplitude: '{s}'\n    showDomainDescriptions: '{s}'\n---\ncynefin-beta\ncomplex\n\"a\"\nclear --> chaotic : \"b\""
            ),
        ];
        for src in templates {
            if check_both(&src) {
                rendered += 1;
            }
        }
    }
    assert!(rendered > PAYLOADS.len() * 8, "rendered={rendered}");

    for body in [
        "width: 1\n    height: 1",
        "width: 10000\n    height: 10000",
        "seed: 1e300",
        "seed: -7",
        "boundaryAmplitude: 50",
        "boundaryAmplitude: -1",
    ] {
        assert!(check_both(&format!(
            "---\nconfig:\n  cynefin:\n    {body}\n---\ncynefin-beta\ncomplex\n\"a\"\ncomplex --> clear\n"
        )));
    }

    let mut frags: Vec<&str> = PAYLOADS.to_vec();
    frags.extend_from_slice(&["\"", "'", "\n", " --> ", " : ", "complex", "confusion", "title "]);
    let mut mutator = Mutator::new(&corpus, frags, 13);
    let mut fuzz_ok = 0usize;
    for _ in 0..2000 {
        let src = mutator.next_sample();
        if check_both(&src) {
            fuzz_ok += 1;
        }
    }
    assert!(fuzz_ok > 100, "fuzz_ok={fuzz_ok}");
}

#[test]
fn cynefin_stays_fast_on_stress_inputs() {
    const N: usize = 50_000;
    let head = "cynefin-beta\n";
    let big = RenderOptions {
        limit: Some(usize::MAX),
        output_limit: Some(usize::MAX),
        ..css_options()
    };
    let items_10k: String = (0..10_000).map(|i| format!("\"i{i}\"\n")).collect();
    let trans_5k: String = (0..5000).map(|i| format!("complex --> clear : \"t{i}\"\n")).collect();
    let cases = [
        format!("{head}complex\n{items_10k}"),
        format!("{head}confusion\n{}", "\"x\"\n".repeat(N / 4)),
        format!("{head}{}", "clear\n\"a\"\n".repeat(N / 10)),
        format!("{head}{trans_5k}"),
        format!("{head}complex\n\"{}\"", "word ".repeat(N / 5)),
        format!("{head}complex\n\"{}\"", "a".repeat(N)),
        format!("{head}title {}", "x".repeat(N)),
        format!("{head}complex\n\"{}", "a".repeat(N)),
        format!("{head}complex\n\"{}", "\\".repeat(N)),
        format!("{head}accDescr {{{}", " a\n".repeat(N / 3)),
        format!("{head}{}", "%%{\n".repeat(N / 4)),
        format!("{head}{}", "complex".repeat(N / 7)),
    ];
    for (i, src) in cases.iter().enumerate() {
        let started = Instant::now();
        let _ = render(src, &big);
        assert!(started.elapsed().as_millis() < 2000, "slow cynefin stress case #{i}: {:?}", started.elapsed());
    }
    let over = render(&format!("{head}complex\n{}", "\"a\"\n".repeat(15_000)), &css_options()).unwrap_err();
    assert!(over.message.contains("limit of 50000"));
}
