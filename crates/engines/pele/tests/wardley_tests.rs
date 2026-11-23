use std::time::Instant;

use regex::Regex;
use vibevalley_pele::detect::DiagramType;
use vibevalley_pele::diagram::wardley::builder::{Flow, SourceStrategy, WardleyBuilder, WardleyNode, WardleyNodeClass};
use vibevalley_pele::{ErrorCode, ParseOptions, ParsedModel, RenderOptions, parse, render, supports};

use crate::support::{Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, css_options, dark_options, load_fixture, resolved_options};

const TEA: &str = "wardley-beta
title Tea Shop
anchor Business [0.95, 0.63]
component Cup of Tea [0.79, 0.61]
component Tea [0.63, 0.81]
component Kettle [0.43, 0.35]
component Power [0.10, 0.70]
Business -> Cup of Tea
Cup of Tea -> Tea
Cup of Tea -> Kettle
Kettle -> Power
evolve Kettle 0.62
evolve Power 0.89
note \"Standardising power\" [0.30, 0.49]
";

#[test]
fn wardley_rendering_stages_strategies_pipelines_annotations_and_forces() {
    let res = render(TEA, &css_options()).unwrap();
    assert_eq!(res.diagram_type, DiagramType::Wardley);
    assert!(supports(TEA));
    assert!(res.svg.contains(r#"class="pele-wardley-axis""#));
    assert_eq!(res.svg.matches(r#"class="pele-wardley-stage""#).count(), 3);
    for stage in ["Genesis", "Custom Built", "Product", "Commodity", "Evolution", "Visibility"] {
        assert!(res.svg.contains(&format!(">{stage}<")));
    }
    assert_eq!(res.svg.matches(r#"class="pele-node pele-wardley-component""#).count(), 4);
    assert_eq!(res.svg.matches(r#"class="pele-node pele-wardley-anchor""#).count(), 1);
    assert_eq!(res.svg.matches(r#"class="pele-edge""#).count(), 4);
    assert_eq!(res.svg.matches(r#"class="pele-wardley-trend""#).count(), 2);
    assert!(res.svg.contains(r#"class="pele-wardley-note""#));
    assert!(res.svg.contains(">Tea Shop<"));
    assert!(res.svg.contains(r#"data-id="Cup of Tea""#));
    assert!(!res.svg.contains("NaN"));

    let light = render(TEA, &resolved_options()).unwrap();
    assert_inert_resolved(&light.svg, "wardley light");
    assert_resvg_parses(&light.svg, "wardley light");
    let dark = render(TEA, &dark_options()).unwrap();
    assert_inert_resolved(&dark.svg, "wardley dark");
    assert_resvg_parses(&dark.svg, "wardley dark");

    // Evolution across, visibility up, decimal & percentage equivalence.
    let pos_svg = render(
        "wardley-beta\ncomponent Low [0.1, 0.2]\ncomponent High [0.9, 0.8]\ncomponent Percent [90.0, 80.0]\n",
        &css_options(),
    )
    .unwrap()
    .svg;
    let doc = roxmltree::Document::parse(&pos_svg).unwrap();
    let at = |id: &str| -> (f64, f64) {
        let g = doc.descendants().find(|n| n.is_element() && n.attribute("data-id") == Some(id)).unwrap();
        let c = g.children().find(|n| n.tag_name().name() == "circle").unwrap();
        (c.attribute("cx").unwrap().parse().unwrap(), c.attribute("cy").unwrap().parse().unwrap())
    };
    let low = at("Low");
    let high = at("High");
    assert!(high.0 > low.0 && high.1 < low.1);
    assert_eq!(at("Percent"), high);

    // Custom stages, dual labels, and stage boundaries.
    let stages = render(
        "wardley-beta\nevolution Genesis@0.3 / Concept -> Custom@0.5 -> Product@0.9 -> Utility@1.0\ncomponent A [0.5, 0.5]\n",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(stages.contains("Genesis / Concept"));
    assert!(stages.contains(">Utility<"));
    let re_stage = Regex::new(r#"class="pele-wardley-stage" d="M([\d.]+),"#).unwrap();
    let xs: Vec<f64> = re_stage.captures_iter(&stages).map(|c| c[1].parse().unwrap()).collect();
    assert_eq!(xs.len(), 3);
    assert!((xs[0] / xs[1] - 0.6).abs() < 1e-4);

    // Sourcing strategies & inertia.
    let strat = render(
        "wardley-beta\ncomponent A [0.9, 0.1] (build)\ncomponent B [0.7, 0.4] (buy) inertia\ncomponent C [0.5, 0.7] (outsource)\ncomponent D [0.3, 0.9] (market) (inertia)\n",
        &resolved_options(),
    )
    .unwrap()
    .svg;
    for s in ["build", "buy", "outsource", "market"] {
        assert!(strat.contains(&format!(r#"class="pele-wardley-{s}""#)));
    }
    assert_eq!(strat.matches(r#"class="pele-wardley-inertia""#).count(), 2);
    assert_resvg_parses(&strat, "wardley strategies");

    // Flows, dashed links, link labels.
    let flows = render(
        "wardley-beta\ncomponent A [0.9, 0.1]\ncomponent B [0.5, 0.5]\ncomponent C [0.1, 0.9]\nA +> B\nB +< C\nA +<> C\nA -.-> B; note here\nB +'cash'> C\nA -> Missing\nA -> A\n",
        &resolved_options(),
    )
    .unwrap()
    .svg;
    let re_edge = Regex::new(r#"class="pele-edge[ "]"#).unwrap();
    assert_eq!(re_edge.find_iter(&flows).count(), 5);
    assert_eq!(flows.matches(r#"class="pele-marker""#).count(), 5);
    assert_eq!(flows.matches(r#"class="pele-edge pele-wardley-dashed""#).count(), 1);
    assert!(flows.contains(">note here</text>"));
    assert!(flows.contains(">cash</text>"));
    assert_resvg_parses(&flows, "wardley flows");

    // Pipelines.
    let pipe_src = "wardley-beta\ncomponent Kettle [0.45, 0.57]\ncomponent Water [0.8, 0.8]\npipeline Kettle {\n  component Campfire Kettle [0.35]\n  component Electric Kettle [0.53]\n}\nWater -> Electric Kettle\nCampfire Kettle -> Kettle\n";
    let pipe = render(pipe_src, &resolved_options()).unwrap().svg;
    assert_eq!(pipe.matches(r#"class="pele-wardley-pipeline""#).count(), 1);
    assert_eq!(pipe.matches(r#"class="pele-node pele-wardley-pipeline-component""#).count(), 2);
    assert_eq!(pipe.matches(r#"class="pele-node pele-wardley-pipeline-parent""#).count(), 1);
    assert!(pipe.contains(r#"data-id="Water-Kettle_Electric Kettle""#));
    assert_eq!(pipe.matches(r#"class="pele-edge""#).count(), 1);
    assert_resvg_parses(&pipe, "wardley pipelines");

    // Annotations boxed vs below, label collision avoidance, accelerators/deaccelerators, grid, size, useMaxWidth, max_width.
    let ann_body = "annotation 2,[0.5, 0.5] \"Second\"\nannotation 1,[0.6, 0.65] \"First\"\n";
    let boxed = render(&format!("wardley-beta\nannotations [0.9, 0.1]\n{ann_body}"), &resolved_options()).unwrap();
    let below = render(&format!("wardley-beta\n{ann_body}"), &resolved_options()).unwrap();
    assert_eq!(boxed.svg.matches(r#"class="pele-wardley-annotation""#).count(), 2);
    assert!(boxed.svg.find("1. First").unwrap() < boxed.svg.find("2. Second").unwrap());
    assert!(below.height > boxed.height);
    assert_resvg_parses(&boxed.svg, "wardley annotations boxed");
    assert_resvg_parses(&below.svg, "wardley annotations below");

    let re_lbl_x = Regex::new(r#"data-id="A">.*?<text[^>]*><tspan x="([\d.-]+)""#).unwrap();
    let lbl_x = |src: &str| -> f64 { re_lbl_x.captures(&render(src, &css_options()).unwrap().svg).unwrap()[1].parse().unwrap() };
    let alone = lbl_x("wardley-beta\ncomponent A [0.5, 0.5]\ncomponent B [0.2, 0.2]\nA -> B\n");
    let blocked = lbl_x("wardley-beta\ncomponent A [0.5, 0.5]\ncomponent B [0.8, 0.8]\ncomponent C [0.2, 0.8]\nA -> B\nA -> C\n");
    let moved = lbl_x("wardley-beta\ncomponent A [0.5, 0.5] label [30, 30]\ncomponent B [0.8, 0.8]\nA -> B\n");
    assert!(blocked < alone);
    assert_eq!(moved, alone + 22.0);

    let forces = render(
        "wardley-beta\naccelerator \"AI Adoption\" [0.55, 0.25]\ndeaccelerator Legacy [0.15, 0.75]\n",
        &resolved_options(),
    )
    .unwrap()
    .svg;
    assert!(forces.contains(r#"class="pele-wardley-accelerator" data-id="AI Adoption""#));
    assert!(forces.contains(r#"class="pele-wardley-deaccelerator" data-id="Legacy""#));
    assert_resvg_parses(&forces, "wardley forces");

    let base = render("wardley-beta\ncomponent A [0.5, 0.5]\n", &css_options()).unwrap();
    let sized = render("wardley-beta\nsize [1100, 800]\ncomponent A [0.5, 0.5]\n", &css_options()).unwrap();
    assert_eq!((sized.width - base.width, sized.height - base.height), (200.0, 200.0));
    let grid = render(
        "---\nconfig:\n  wardley-beta:\n    showGrid: true\n    useMaxWidth: false\n---\nwardley-beta\ncomponent A [0.5, 0.5]\n",
        &resolved_options(),
    )
    .unwrap()
    .svg;
    assert!(grid.contains("pele-wardley-grid"));
    assert!(!grid.contains("max-width:100%"));
    let narrow = render(
        TEA,
        &RenderOptions {
            max_width: Some(360.0),
            ..resolved_options()
        },
    )
    .unwrap();
    assert!(narrow.width <= 360.0);
    assert_resvg_parses(&narrow.svg, "narrow wardley");
}

#[test]
fn wardley_parser_builder_compat_and_errors() {
    // Builder resolve_node_id (wardleyBuilder.spec.ts).
    let mut b = WardleyBuilder::new();
    b.add_node(WardleyNode {
        id: "Kettle_Campfire Kettle".to_string(),
        label: "Campfire Kettle".to_string(),
        x: Some(35.0),
        y: Some(45.0),
        class_name: Some(WardleyNodeClass::PipelineComponent),
        label_offset_x: None,
        label_offset_y: None,
        in_pipeline: false,
        is_pipeline_parent: false,
        inertia: None,
        source_strategy: None,
    });
    assert_eq!(b.resolve_node_id("Campfire Kettle"), "Kettle_Campfire Kettle");
    assert_eq!(b.resolve_node_id("Unknown"), "Unknown");

    // Hyphens, no-space arrows, quoted names, strategies, inertia (wardleyParser.spec.ts).
    let parsed = parse(
        "wardley-beta
title Coordinate Handling
component \"Mobile App\" [0.2, 0.4] (build) (inertia)
component foo-bar [0.3, 0.5]
component foo--bar [0.3, 0.4]
component foo- [0.2, 0.3]
\"Mobile App\" +<> foo-bar; constraint
foo-bar->foo--bar",
        &ParseOptions::default(),
    )
    .unwrap();
    match parsed.model {
        ParsedModel::Wardley(m) => {
            let mobile = m.data.nodes.iter().find(|n| n.label == "Mobile App").unwrap();
            assert_eq!((mobile.x, mobile.y), (Some(40.0), Some(20.0)));
            assert_eq!(mobile.source_strategy, Some(SourceStrategy::Build));
            assert_eq!(mobile.inertia, Some(true));
            assert_eq!(m.data.links.len(), 2);
            assert_eq!(m.data.links[0].flow, Some(Flow::Bidirectional));
            assert_eq!(m.data.links[0].label.as_deref(), Some("constraint"));
            assert_eq!((m.data.links[1].source.as_str(), m.data.links[1].target.as_str()), ("foo-bar", "foo--bar"));
        }
        other => panic!("expected Wardley, got {other:?}"),
    }

    // Semantic and syntax error parity.
    assert!(
        render("wardley-beta\ncomponent A [150.5, 0.5]\n", &css_options())
            .unwrap_err()
            .message
            .contains("Component \"A\" visibility must be between 0-1 (decimal) or 0-100 (percentage). Received: 150.5")
    );
    assert!(
        render("wardley-beta\npipeline Nope {\n component A [0.5]\n}\n", &css_options())
            .unwrap_err()
            .message
            .contains("Pipeline \"Nope\" must reference an existing component with coordinates.")
    );
    for bad in [
        "wardley-beta\ncomponent market [0.1, 0.2]",
        "wardley-beta\ncomponent A [1, 2]",
        "wardley-beta\nA B",
        "wardley-beta\nnote text [0.1, 0.2]",
    ] {
        assert!(render(bad, &css_options()).is_err(), "expected error for {bad}");
    }
}

#[test]
fn wardley_corpus_hostile_extreme_and_fuzz_are_inert_and_resvg_safe() {
    let corpus = load_fixture("wardley-corpus.json");
    assert_eq!(corpus.len(), 39);
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
    assert!(rendered_corpus >= 15, "rendered_corpus={rendered_corpus}");

    let mut rendered_hostile = 0usize;
    for &p in PAYLOADS {
        let q: String = p.chars().filter(|&c| !matches!(c, '"' | '\\' | '\n')).collect();
        let s: String = p.chars().filter(|&c| !matches!(c, '\'' | '\\' | '\n')).collect();
        let templates = [
            format!("wardley-beta\ncomponent \"{q}\" [0.5, 0.5]"),
            format!("wardley-beta\ncomponent '{s}' [0.5, 0.5] (buy) (inertia)"),
            format!("wardley-beta\nanchor \"{q}\" [0.9, 0.5]\ncomponent B [0.5, 0.5]\n\"{q}\" -> B"),
            format!("wardley-beta\ncomponent A [0.9, 0.1]\ncomponent B [0.5, 0.5]\nA -> B; {p}"),
            format!("wardley-beta\ncomponent A [0.9, 0.1]\ncomponent B [0.5, 0.5]\nA +'{s}'> B"),
            format!("wardley-beta\nnote \"{q}\" [0.5, 0.5]"),
            format!("wardley-beta\nannotations [0.9, 0.1]\nannotation 1,[0.5, 0.5] \"{q}\""),
            format!("wardley-beta\naccelerator \"{q}\" [0.5, 0.5]\ndeaccelerator \"{q}\" [0.2, 0.2]"),
            format!("wardley-beta\ntitle {p}\ncomponent A [0.5, 0.5]"),
            format!("wardley-beta\naccTitle: {p}\naccDescr: {p}\ncomponent A [0.5, 0.5]"),
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
    assert!(rendered_hostile > PAYLOADS.len() * 6, "rendered_hostile={rendered_hostile}");

    // Extreme numbers.
    let nines = "9".repeat(400);
    for src in [
        format!("wardley-beta\nsize [{nines}, {nines}]\ncomponent A [0.5, 0.5]"),
        "wardley-beta\nsize [0, 0]\ncomponent A [0.5, 0.5]".to_string(),
        format!("wardley-beta\ncomponent A [0.5, 0.5] label [-{nines}, {nines}]"),
        format!("wardley-beta\nannotation {nines},[0.5, 0.5] \"big\"\nannotations [1, 1]"),
        format!("wardley-beta\nevolution A@{nines}.0 -> B@0.0\ncomponent A [0.0, 1.0]"),
        "wardley-beta\ncomponent A [0.5, 0.5]\npipeline A {\n component B [0.5]\n component C [0.5]\n}\nevolve A 0.50".to_string(),
    ] {
        let r = render(&src, &resolved_options()).unwrap();
        assert_inert_resolved(&r.svg, &src);
        assert_resvg_parses(&r.svg, &src);
    }

    let mut frags: Vec<&str> = PAYLOADS.to_vec();
    frags.extend_from_slice(&["\"", "'", "\n", " -> ", "; ", "+'", "component ", " [0.5, 0.5]", "note ", "(buy)"]);
    let mut mutator = Mutator::new(&corpus, frags, 17);
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
fn wardley_worst_cases_stay_linear() {
    let big = RenderOptions {
        limit: Some(usize::MAX),
        ..css_options()
    };
    let n = 50_000usize;
    let frac = |i: usize| format!("{:.3}", 0.001 * ((i % 1000) as f64));
    let comps_1500: String = (0..1500).map(|i| format!("component c{i} [{}, {}]\n", frac(i), frac(i * 7))).collect();
    let links_1500: String = (0..1500).map(|i| format!("c{i} -> c{}\n", i + 1)).collect();
    let cases = [
        format!("wardley-beta\ncomponent A [0.5, 0.5]\n{}", "0".repeat(n - 100)),
        format!("wardley-beta\ncomponent A [0.5, 0.5]\n{}", "1.".repeat(n / 2 - 100)),
        format!("wardley-beta\n{comps_1500}{links_1500}"),
        format!("wardley-beta\ncomponent {} [0.5, 0.5]", "a".repeat(n)),
        format!("wardley-beta\n1{}!", "-".repeat(n)),
        format!("wardley-beta\n{}", "A +'x\n".repeat(n / 6)),
        format!("wardley-beta\nA +'{}", "x".repeat(n)),
        format!("wardley-beta\n{}", "accDescr {\n".repeat(n / 11)),
        format!("wardley-beta\n{}", "%%{\n".repeat(n / 4)),
        format!("wardley-beta\n{}", "---\n".repeat(n / 4)),
        format!("wardley-beta\n{}", format!("{}. ", "1".repeat(98)).repeat(n / 100)),
    ];
    for src in &cases {
        let started = Instant::now();
        let _ = render(src, &big);
        assert!(started.elapsed().as_millis() < 2000);
    }
    let over = render(&format!("wardley-beta\n{}", "component A [0.5, 0.5]\n".repeat(3000)), &css_options()).unwrap_err();
    assert_eq!(over.code, ErrorCode::Limit);
}
