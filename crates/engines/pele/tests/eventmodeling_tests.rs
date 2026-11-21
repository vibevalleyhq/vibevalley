mod support;

use std::time::Instant;

use regex::Regex;
use vibevalley_pele::detect::DiagramType;
use vibevalley_pele::diagram::eventmodeling::model::EmSpecification;
use vibevalley_pele::{ParseOptions, ParsedModel, RenderOptions, parse, render, supports};

use support::{Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, css_options, dark_options, load_fixture, resolved_options};

const BASIC: &str = "eventmodeling\ntf 01 ui CartUI\ntf 02 cmd AddItem\ntf 03 evt ItemAdded\n";

fn count_re(svg: &str, pat: &str) -> usize {
    Regex::new(pat).unwrap().find_iter(svg).count()
}

fn relations_of(src: &str) -> Vec<String> {
    match parse(src, &ParseOptions::default()).unwrap().model {
        ParsedModel::EventModeling(m) => m.relations.iter().map(|r| format!("{}>{}", r.source_id, r.target_id)).collect(),
        other => panic!("expected eventmodeling, got {:?}", other.diagram_type()),
    }
}

fn check_both_modes(src: &str) -> bool {
    let css = match render(src, &css_options()) {
        Ok(r) => r.svg,
        Err(_) => return false,
    };
    let ctx: String = src.chars().take(160).collect();
    assert_inert(&css, &ctx);
    assert!(!css.contains("NaN") && !css.contains("Infinity"), "non-finite coord in {ctx}");

    let resolved = render(src, &resolved_options()).expect("resolved render should succeed when css succeeded");
    assert_inert_resolved(&resolved.svg, &ctx);
    assert_resvg_parses(&resolved.svg, &ctx);
    true
}

#[test]
fn eventmodeling_lanes_boxes_colors_and_time_flow() {
    let res = render(BASIC, &css_options()).unwrap();
    assert_eq!(res.diagram_type, DiagramType::EventModeling);
    assert!(supports(BASIC));
    assert_eq!(count_re(&res.svg, r#"class="pele-cluster pele-em-lane""#), 3);
    for label in ["UI/Automation", "Command/Read Model", "Events", "CartUI", "AddItem", "ItemAdded"] {
        assert!(res.svg.contains(&format!(">{label}<")), "missing label {label}");
    }
    assert!(res.svg.contains(r#"class="pele-node pele-em-ui" data-id="01""#));
    assert!(res.svg.contains(r#"class="pele-node pele-em-command" data-id="02""#));
    assert!(res.svg.contains(r#"class="pele-node pele-em-event" data-id="03""#));
    assert_eq!(count_re(&res.svg, r#"class="pele-edge""#), 2);
    assert_eq!(count_re(&res.svg, r#"class="pele-marker""#), 2);
    assert!(res.svg.contains(r#"data-id="01-02""#));
    assert!(!res.svg.contains("NaN"));

    // Colors each kind from its own series slot and leaves UI plain
    let colored = render(
        "eventmodeling\ntf 01 ui A\ntf 02 cmd B\ntf 03 evt C\ntf 04 rmo D\ntf 05 pcr E\n",
        &css_options(),
    )
    .unwrap();
    for slot in [1, 2, 3, 7] {
        assert!(colored.svg.contains(&format!("var(--pele-series-{slot},")), "missing series {slot}");
    }
    assert_eq!(count_re(&colored.svg, r#"fill-opacity="0.22""#), 4);

    // Moves time to the right and keeps frames of a lane from overlapping
    let flow = render(
        "eventmodeling\ntf 01 cmd A\ntf 02 evt B\ntf 03 cmd C\ntf 04 cmd D\ntf 05 evt E\n",
        &css_options(),
    )
    .unwrap();
    let box_of = |id: &str| -> (f64, f64) {
        let re = Regex::new(&format!(r#"data-id="{id}"><rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)""#)).unwrap();
        let cap = re.captures(&flow.svg).unwrap();
        let x: f64 = cap[1].parse().unwrap();
        let w: f64 = cap[2].parse().unwrap();
        (x, x + w)
    };
    for (a, b) in [("01", "02"), ("02", "03"), ("03", "04"), ("04", "05")] {
        assert!(box_of(b).0 > box_of(a).0);
    }
    assert!(box_of("03").0 > box_of("01").1);
    assert!(box_of("04").0 > box_of("03").1);
    assert!(box_of("05").0 > box_of("02").1);

    // Deterministic + light/dark resvg
    assert_eq!(res.svg, render(BASIC, &css_options()).unwrap().svg);
    let light = render(BASIC, &resolved_options()).unwrap();
    assert_inert_resolved(&light.svg, "em light");
    assert_resvg_parses(&light.svg, "em light");
    let dark = render(BASIC, &dark_options()).unwrap();
    assert_inert_resolved(&dark.svg, "em dark");
    assert_resvg_parses(&dark.svg, "em dark");
}

#[test]
fn eventmodeling_relations_namespaces_data_notes_specs_and_errors() {
    // Inferred relations
    assert_eq!(relations_of(BASIC), vec!["01>02", "02>03"]);
    assert_eq!(
        relations_of("eventmodeling\ntf 01 evt A\ntf 02 evt B\ntf 03 rmo C\ntf 04 rmo D\n"),
        vec!["02>03", "02>04"]
    );

    // Reset frames and explicit sources
    assert_eq!(
        relations_of("eventmodeling\ntf 01 ui A\ntf 02 cmd B\nrf 03 evt C\ntf 04 pcr D\n"),
        vec!["01>02", "03>04"]
    );
    assert_eq!(
        relations_of("eventmodeling\ntf 01 evt A\ntf 02 ui B\nrf 03 rmo C ->> 01\n"),
        vec!["01>02", "01>03"]
    );
    assert_eq!(
        relations_of("eventmodeling\nrf 02 evt A\nrf 03 evt B\ntf 01 rmo C ->> 03 ->> 02 ->> 09\n"),
        vec!["02>01", "03>01"]
    );
    assert_eq!(relations_of("eventmodeling\ntf 01 evt A ->> 02\ntf 02 cmd B\n"), vec!["01>02"]);

    // Namespaces -> lanes
    let ns_src = "eventmodeling\ntf 01 cmd Cart.Add\ntf 02 evt Cart.Added\ntf 03 cmd Cart.Remove\ntf 04 evt Other.Seen\ntf 05 evt Plain\ntf 06 evt a.b.c\n";
    let ParsedModel::EventModeling(m) = parse(ns_src, &ParseOptions::default()).unwrap().model else {
        panic!("expected eventmodeling");
    };
    let lanes: Vec<(usize, &str)> = m.lanes.iter().map(|l| (l.index, l.label.as_str())).collect();
    assert_eq!(lanes, vec![(101, "C/RM: Cart"), (200, "Events"), (201, "Stream: Cart"), (202, "Stream: Other")]);
    let boxes: Vec<(&str, usize)> = m.boxes.iter().map(|b| (b.name.as_str(), b.lane_index)).collect();
    assert_eq!(
        boxes,
        vec![("Add", 101), ("Added", 201), ("Remove", 101), ("Seen", 202), ("Plain", 200), ("a.b.c", 200)]
    );
    assert_eq!(
        count_re(&render(ns_src, &css_options()).unwrap().svg, r#"class="pele-cluster pele-em-lane""#),
        4
    );

    // Inline data and data blocks (block wins over inline)
    let data_src = concat!(
        "eventmodeling\n",
        "tf 01 cmd A { productId: 7 }\n",
        "tf 02 evt B [[Payload]] { ignored: true }\n",
        "tf 03 evt C \"{ \"a\": 1 }\"\n",
        "tf 04 evt D [[Missing]]\n",
        "tf 05 evt E {x}\n",
        "data Payload {\n  description: string\n    nested: true\n}\n",
    );
    let ParsedModel::EventModeling(dm) = parse(data_src, &ParseOptions::default()).unwrap().model else {
        panic!("expected eventmodeling");
    };
    let datas: Vec<Option<&str>> = dm.boxes.iter().map(|b| b.data.as_deref()).collect();
    assert_eq!(
        datas,
        vec![
            Some("productId: 7"),
            Some("description: string\n  nested: true"),
            Some("\"a\": 1"),
            None,
            Some("x"),
        ]
    );
    let d_svg = render(data_src, &css_options()).unwrap().svg;
    assert!(d_svg.contains(">productId: 7</tspan>"));
    assert!(d_svg.contains(">  nested: true</tspan>"));
    assert!(!d_svg.contains("ignored"));
    assert_eq!(count_re(&d_svg, r#"class="pele-em-data""#), 4);

    // Wraps long data lines without splitting emoji
    let emj = render(&format!("eventmodeling\ntf 01 cmd A {{{}😀Z}}", "a".repeat(47)), &css_options())
        .unwrap()
        .svg;
    assert!(emj.contains(&format!(">{}😀</tspan>", "a".repeat(47))));
    assert!(emj.contains(">Z</tspan>"));

    // Keeps comment lines inside data blocks
    let cmt = render(
        "eventmodeling\n%% a real comment\ntf 01 evt A [[D]]\ndata D {\n  %% kept\n  a: 1\n}\n",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(cmt.contains(">%% kept</tspan>"));
    assert!(!cmt.contains("a real comment"));

    // Notes and specifications under the lanes
    let ns_spec = concat!(
        "eventmodeling\ntf 01 cmd Update\ntf 02 evt Updated\nentity Updated\nnote 02 `md` {\n  first line\n  second line\n}\n",
        "gwt 01\n given\n  evt Updated\n  evt Other\n when\n  cmd Update\n then\n  evt Updated\ngwt 02 given evt A then evt B\n",
    );
    let spec_res = render(ns_spec, &css_options()).unwrap();
    assert_eq!(count_re(&spec_res.svg, r#"class="pele-em-note""#), 1);
    assert_eq!(count_re(&spec_res.svg, r#"class="pele-em-specification""#), 2);
    assert!(spec_res.svg.contains("Note · 02 Updated"));
    assert!(spec_res.svg.contains(">second line</tspan>"));
    assert!(spec_res.svg.contains(">Given  Updated, Other</tspan>"));
    assert!(spec_res.svg.contains(">When  Update</tspan>"));
    let ParsedModel::EventModeling(sm) = parse(ns_spec, &ParseOptions::default()).unwrap().model else {
        panic!("expected eventmodeling");
    };
    assert_eq!(
        sm.specifications[1],
        EmSpecification {
            frame: "02".to_string(),
            given: vec!["A".to_string()],
            when: vec![],
            then: vec!["B".to_string()],
        }
    );
    assert_eq!(sm.entities, vec!["Updated"]);

    // Titles + accessibility + front matter
    let t = render(
        "eventmodeling title Checkout\ntf 01 ui A accTitle: Acc\ntf 02 cmd B accDescr: Described\n",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(t.contains(">Checkout<"));
    assert!(t.contains(r#"<title id="pele-title">Acc</title>"#));
    assert!(t.contains(r#"<desc id="pele-desc">Described</desc>"#));
    assert!(
        render("---\ntitle: Front\n---\neventmodeling\ntf 01 ui A\n", &css_options())
            .unwrap()
            .svg
            .contains(">Front<")
    );

    // Entity names starting with title
    let ParsedModel::EventModeling(tm) = parse("eventmodeling\ntf 01 ui titles\ntf 02 cmd title_x\nentity titles\n", &ParseOptions::default())
        .unwrap()
        .model
    else {
        panic!("expected eventmodeling");
    };
    assert_eq!(tm.boxes.iter().map(|b| b.name.as_str()).collect::<Vec<_>>(), vec!["titles", "title_x"]);
    assert_eq!(tm.entities, vec!["titles"]);

    // Empty model
    let empty = render("eventmodeling", &resolved_options()).unwrap();
    assert!(empty.svg.contains("<svg"));
    assert_inert_resolved(&empty.svg, "empty em");
    assert_resvg_parses(&empty.svg, "empty em");

    // Duplicate frame ID error with line number across comments
    let dup_err = render("eventmodeling\n  tf 01 ui UI\n  %% a comment line\n  rf 01 evt Event\n", &css_options()).unwrap_err();
    assert_eq!(dup_err.message, r#"Duplicate event modeling frame ID "01" on line 4"#);
    assert_eq!(dup_err.line, 4);

    let col_err = render("eventmodeling\ntf 01 cmd\n%% a comment line\n\n", &css_options()).unwrap_err();
    assert_eq!(col_err.line, 2);
    assert_eq!(col_err.column, 10);

    for bad in [
        "eventmodeling\ntitle T\n",
        "eventmodeling\ntf 01 evt data\n",
        "eventmodeling\ntf 01 evt A {\n",
        "eventmodeling\ntf 1234 evt A\n",
    ] {
        assert!(render(bad, &css_options()).is_err(), "expected error for {bad:?}");
    }

    // All entity types (compat spec)
    let all_types = "eventmodeling\n    tf 01 ui UI\n    tf 02 ui UI2\n    tf 03 cmd Command\n    tf 04 command Command2\n    tf 05 evt Event\n    tf 06 event Event2\n    tf 07 pcr Processor\n    tf 08 processor Processor2\n    tf 09 rmo ReadModel\n    tf 10 readmodel ReadModel2";
    let all_res = render(all_types, &resolved_options()).unwrap();
    assert_inert_resolved(&all_res.svg, "em all entity types");
    assert_resvg_parses(&all_res.svg, "em all entity types");
}

#[test]
fn eventmodeling_security_corpus_payloads_and_mutated_fuzz() {
    let line = |p: &str| p.replace(['\n', '\r'], " ");
    type TemplateFn = Box<dyn Fn(&str) -> String>;
    let templates: Vec<TemplateFn> = vec![
        Box::new(move |p| format!("eventmodeling\ntf 01 cmd A {{ {} }}", line(p))),
        Box::new(move |p| format!("eventmodeling\ntf 01 evt A \"{}\"", line(p))),
        Box::new(move |p| format!("eventmodeling\ntf 01 evt A '{}'", line(p))),
        Box::new(move |p| format!("eventmodeling\ntf 01 rmo A `json`{{ \"k\": \"{}\" }}", line(p))),
        Box::new(|p| format!("eventmodeling\ntf 01 evt A [[D]]\ndata D {{\n  {p}\n}}\n")),
        Box::new(|p| format!("eventmodeling\ntf 01 evt A\nnote 01 {{\n  {p}\n}}\n")),
        Box::new(|p| format!("eventmodeling\ntf 01 evt A\nnote 01 `html` {{\n  <div>{p}</div>\n}}\n")),
        Box::new(move |p| format!("eventmodeling title {}\ntf 01 ui A", line(p))),
        Box::new(move |p| format!("eventmodeling accTitle: {}\ntf 01 ui A accDescr: {}", line(p), line(p))),
        Box::new(|p| format!("eventmodeling accDescr {{\n {p}\n}}\ntf 01 ui A")),
        Box::new(|p| format!("eventmodeling\ntf 01 ui {p}")),
        Box::new(|p| format!("eventmodeling\ntf 01 ui A.{p}")),
        Box::new(|p| format!("eventmodeling\ntf 01 evt A\ngwt 01 given evt {p} then evt B")),
        Box::new(move |p| format!("eventmodeling\n/* {p} */\ntf 01 ui A // {}\n", line(p))),
        Box::new(|p| format!("---\ntitle: \"{}\"\n---\neventmodeling\ntf 01 ui A", p.replace(['"', '\\', '\n'], ""))),
    ];

    let mut payload_rendered = 0;
    for &payload in PAYLOADS {
        for tmpl in &templates {
            if check_both_modes(&tmpl(payload)) {
                payload_rendered += 1;
            }
        }
    }
    assert!(
        payload_rendered > PAYLOADS.len() * 8,
        "expected >{} payload renders, got {payload_rendered}",
        PAYLOADS.len() * 8
    );

    // Object keys
    for key in ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"] {
        let src = format!(
            "eventmodeling\ntf 01 cmd {key}.{key} [[{key}]]\ntf 02 evt {key}\ndata {key} {{\n x\n}}\nentity {key}\ngwt 01 given evt {key} then evt {key}\n"
        );
        assert!(check_both_modes(&src), "failed for key {key}");
    }

    // Full corpus + dark mode + mutated fuzzing
    let corpus = load_fixture("eventmodeling-corpus.json");
    let mut corpus_rendered = 0;
    for src in &corpus {
        if check_both_modes(src) {
            corpus_rendered += 1;
            let dark = render(src, &dark_options()).expect("dark mode");
            assert_inert_resolved(&dark.svg, src);
            assert_resvg_parses(&dark.svg, src);
        }
    }
    assert!(corpus_rendered >= 12, "expected >=12 eventmodeling corpus renders, got {corpus_rendered}");

    let mut frags: Vec<&str> = PAYLOADS.to_vec();
    frags.extend(["\"", "'", "\n", "{", "}", " ->> 01", "[[", "]]", "tf 09 evt Z", "note 01 {\n", "\n}\n"]);
    let mut mutator = Mutator::new(&corpus, frags, 19);
    let mut fuzz_rendered = 0;
    for _ in 0..1000 {
        let src = mutator.next_sample();
        if check_both_modes(&src) {
            fuzz_rendered += 1;
        }
    }
    assert!(fuzz_rendered > 50, "expected >50 em mutated renders, got {fuzz_rendered}");
}

#[test]
fn eventmodeling_stress_worst_cases() {
    const N: usize = 50_000;
    let big = RenderOptions {
        limit: Some(usize::MAX),
        output_limit: Some(usize::MAX),
        ..css_options()
    };
    let head = "eventmodeling\n";
    let kinds = ["ui", "cmd", "evt", "rmo", "pcr"];
    let mut s_lanes = String::from(head);
    for i in 0..1000 {
        s_lanes.push_str(&format!("tf {:03} {} E{i}\n", i % 1000, kinds[i % 5]));
    }
    let mut s_sources = format!("{head}tf 001 cmd A\ntf 002 evt B");
    s_sources.push_str(&" ->> 001".repeat(9000));
    s_sources.push('\n');

    let cases: Vec<(&str, String)> = vec![
        ("1,000 frames across lanes", s_lanes),
        ("one frame with 9,000 sources", s_sources),
        ("frame number reused 5,000 times", format!("{head}{}", "tf 01 evt A\n".repeat(5000))),
        (
            "data block of 10,000 lines",
            format!("{head}tf 01 evt A [[D]]\ndata D {{\n{}}}\n", "a: 1\n".repeat(10_000)),
        ),
        ("inline data 50k chars", format!("{head}tf 01 evt A {{ {} }}\n", "x".repeat(N))),
        (
            "inline data 25k braces",
            format!("{head}tf 01 evt A {}{}\n", "{".repeat(N / 2), "}".repeat(N / 2)),
        ),
        ("10k qualified parts", format!("{head}tf 01 evt {}z\n", "a.".repeat(10_000))),
        ("unclosed block comment", format!("{head}/*{}", " x\n".repeat(N / 3))),
        ("percent comments", format!("{head}{}", "%% c\n".repeat(N / 5))),
        ("keywords run together", format!("{head}{}", "tfevtuidatanote".repeat(N / 15))),
    ];
    for (name, src) in cases {
        let start = Instant::now();
        let _ = render(&src, &big);
        let elapsed = start.elapsed().as_millis();
        assert!(elapsed < 3000, "eventmodeling stress '{name}' took {elapsed}ms");
    }

    // Default limit refusal
    let err = render(&format!("{head}{}", "tf 01 evt A\n".repeat(5000)), &css_options()).unwrap_err();
    assert!(err.message.contains("limit of 50000"), "unexpected error: {}", err.message);
}
