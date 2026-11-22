use std::time::Instant;

use regex::Regex;
use vibevalley_pele::diagram::requirement::db::RequirementDb;
use vibevalley_pele::diagram::requirement::graph::build_requirement_graph;
use vibevalley_pele::diagram::requirement::lexer::tokenize;
use vibevalley_pele::diagram::requirement::render::render_requirement;
use vibevalley_pele::diagram::{ParsedModel, RenderContext};
use vibevalley_pele::svg::palette::PaletteOverrides;
use vibevalley_pele::svg::theme::{SvgTheme, ThemeMode};
use vibevalley_pele::{DiagramConfig, DiagramType, METRICS_MEASURER, ParseOptions, RenderOptions, parse, render, supports};

use crate::support::{
    Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, assert_well_formed, css_options, dark_options, load_fixture, resolved_options,
};

const BASIC: &str = "requirementDiagram\n\nrequirement test_req {\nid: 1\ntext: the test text.\nrisk: high\nverifymethod: test\n}\n\nelement test_entity {\ntype: simulation\ndocRef: reqs/test_entity\n}\n\ntest_entity - satisfies -> test_req\n";

fn count_re(svg: &str, pattern: &str) -> usize {
    Regex::new(pattern).unwrap().find_iter(svg).count()
}

#[test]
fn requirement_renders_full_upstream_corpus_in_css_and_resolved_resvg_modes() {
    let corpus = load_fixture("requirement-corpus.json");
    assert_eq!(corpus.len(), 14);
    let mut rendered = 0usize;
    for (idx, src) in corpus.iter().enumerate() {
        let where_ctx = format!("requirement corpus #{idx}");
        let Ok(css) = render(src, &css_options()) else {
            continue;
        };
        rendered += 1;
        assert_inert(&css.svg, &format!("{where_ctx} css"));
        assert!(!css.svg.contains("NaN") && !css.svg.contains("undefined"));
        assert_eq!(render(src, &css_options()).unwrap().svg, css.svg);

        let resolved = render(src, &resolved_options()).unwrap_or_else(|e| panic!("{where_ctx} resolved failed: {e}"));
        assert_inert_resolved(&resolved.svg, &format!("{where_ctx} resolved"));
        assert_resvg_parses(&resolved.svg, &format!("{where_ctx} resvg"));

        let dark = render(src, &dark_options()).unwrap_or_else(|e| panic!("{where_ctx} dark failed: {e}"));
        assert_inert_resolved(&dark.svg, &format!("{where_ctx} dark"));
        assert_resvg_parses(&dark.svg, &format!("{where_ctx} dark resvg"));
    }
    assert!(rendered >= 10, "only rendered {rendered} of {} requirement corpus items", corpus.len());
}

#[test]
fn requirement_rendering_boxes_types_relationships_directions_styles_and_markdown() {
    // Draws a box per requirement and element with header and fields.
    let res = render(BASIC, &css_options()).unwrap();
    assert_eq!(res.diagram_type, DiagramType::Requirement);
    assert!(supports("requirementDiagram\n"));
    assert!(res.svg.starts_with(r#"<svg xmlns="http://www.w3.org/2000/svg" class="pele pele-requirement""#));
    assert_eq!(count_re(&res.svg, r#"class="pele-node pele-requirement""#), 1);
    assert_eq!(count_re(&res.svg, r#"class="pele-node pele-element""#), 1);
    assert!(res.svg.contains(r#"data-id="test_req""#));
    assert!(res.svg.contains(">«Requirement»<"));
    assert!(res.svg.contains(">«Element»<"));
    for text in [
        "ID",
        "Text",
        "Risk",
        "Verification",
        "Type",
        "Doc Ref",
        "1",
        "the test text.",
        "High",
        "Test",
        "simulation",
        "reqs/test_entity",
    ] {
        assert!(res.svg.contains(&format!(">{text}<")), "missing {text}");
    }
    assert_eq!(count_re(&res.svg, r#"class="pele-divider""#), 2);

    // Names each requirement type.
    for (kw, name) in [
        ("requirement", "Requirement"),
        ("functionalRequirement", "Functional Requirement"),
        ("interfaceRequirement", "Interface Requirement"),
        ("performanceRequirement", "Performance Requirement"),
        ("physicalRequirement", "Physical Requirement"),
        ("designConstraint", "Design Constraint"),
    ] {
        let svg = render(&format!("requirementDiagram\n{kw} r {{\n}}\n"), &css_options()).unwrap().svg;
        assert!(svg.contains(&format!(">«{name}»<")));
    }

    // Leaves out empty fields and divider of an empty body.
    let sparse = render("requirementDiagram\nrequirement r {\nid: 7\n}\nelement e {\n}\n", &css_options())
        .unwrap()
        .svg;
    assert!(sparse.contains(">ID<"));
    assert!(!sparse.contains(">Text<"));
    assert!(!sparse.contains(">Type<"));
    assert_eq!(count_re(&sparse, r#"class="pele-divider""#), 1);

    // Draws contains with circled plus at source and the rest as dashed arrows.
    let contains = render(
        "requirementDiagram\nrequirement a {\n}\nrequirement b {\n}\na - contains -> b\n",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(contains.contains(r#"class="pele-edge pele-relationship-contains" data-id="a-b-0""#));
    assert_eq!(count_re(&contains, r#"<circle class="pele-marker""#), 1);
    assert!(!contains.contains("stroke-dasharray"));
    assert!(contains.contains(">«contains»<"));
    let cy: f64 = Regex::new(r#"<circle class="pele-marker" cx="[\d.]+" cy="([\d.]+)""#)
        .unwrap()
        .captures(&contains)
        .unwrap()[1]
        .parse()
        .unwrap();
    let y_of = |id: &str| -> f64 {
        Regex::new(&format!(r#"data-id="{id}" transform="translate\([\d.]+,([\d.]+)\)""#))
            .unwrap()
            .captures(&contains)
            .unwrap()[1]
            .parse()
            .unwrap()
    };
    let (ay, by) = (y_of("a"), y_of("b"));
    assert!(ay < by);
    assert!((cy - ay).abs() < (cy - by).abs());

    for kind in ["copies", "derives", "satisfies", "verifies", "refines", "traces"] {
        let svg = render(
            &format!("requirementDiagram\nrequirement a {{\n}}\nrequirement b {{\n}}\na - {kind} -> b\n"),
            &css_options(),
        )
        .unwrap()
        .svg;
        assert!(svg.contains(r#"class="pele-edge pele-relationship-arrow""#), "{kind}");
        assert!(svg.contains(r#"stroke-dasharray="5 4""#), "{kind}");
        assert!(svg.contains(&format!(">«{kind}»<")), "{kind}");
        assert!(!svg.contains("<circle"), "{kind}");
    }

    // Left arrow equals reversed right arrow.
    let forward = render("requirementDiagram\nrequirement a {\n}\nelement b {\n}\nb - satisfies -> a\n", &css_options())
        .unwrap()
        .svg;
    let backward = render("requirementDiagram\nrequirement a {\n}\nelement b {\n}\na <- satisfies - b\n", &css_options())
        .unwrap()
        .svg;
    assert_eq!(backward, forward);

    // Lays out along declared direction.
    let body = "requirement a {\n}\nrequirement b {\n}\nrequirement c {\n}\na - contains -> b\nb - contains -> c\n";
    let tall = render(&format!("requirementDiagram\n{body}"), &css_options()).unwrap();
    let wide = render(&format!("requirementDiagram\ndirection LR\n{body}"), &css_options()).unwrap();
    assert!(tall.height > tall.width);
    assert!(wide.width > wide.height);
    assert_ne!(
        render(&format!("requirementDiagram\ndirection BT\n{body}"), &css_options()).unwrap().svg,
        tall.svg
    );
    assert_ne!(
        render(&format!("requirementDiagram\ndirection RL\n{body}"), &css_options()).unwrap().svg,
        wide.svg
    );

    // Self and parallel relationships.
    let multi = render(
        "requirementDiagram\nrequirement a {\n}\nrequirement b {\n}\na - contains -> a\na - traces -> b\na - refines -> b\n",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert_eq!(count_re(&multi, r#"class="pele-edge "#), 3);
    assert_eq!(count_re(&multi, r#"class="pele-edge-label""#), 3);
    assert!(multi.contains(r#"data-id="a-a-0""#));

    // Keeps ends sharing a side apart.
    let spread = render(
        "requirementDiagram\nrequirement a {\n}\nrequirement b {\n}\nrequirement c {\n}\na - contains -> b\na - contains -> c\n",
        &css_options(),
    )
    .unwrap()
    .svg;
    let xs: Vec<f64> = Regex::new(r#"<circle class="pele-marker" cx="([\d.]+)""#)
        .unwrap()
        .captures_iter(&spread)
        .map(|c| c[1].parse().unwrap())
        .collect();
    assert_eq!(xs.len(), 2);
    assert!((xs[0] - xs[1]).abs() > 12.0);

    // Ignores edges whose endpoint is undefined.
    let missing = render("requirementDiagram\nrequirement a {\n}\na - contains -> missing\n", &css_options())
        .unwrap()
        .svg;
    assert!(!missing.contains("pele-edge"));
    assert!(!missing.contains("missing"));

    // Applies style, classDef, class, and ::: shorthand.
    let styled = render(
        "requirementDiagram\nrequirement a:::hot {\nid: 1\n}\nelement b {\ntype: t\n}\nelement c {\n}\nclassDef hot fill:#f96,stroke:#333,stroke-width:4px\nclassDef cold color:blue\nclass b cold\nc:::hot,cold\nstyle c stroke:#0a0\n",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(
        Regex::new(r#"class="pele-node pele-requirement hot" data-id="a"[^>]*><rect[^>]*style="rx:var\(--_r\);fill:#f96;stroke:#333;stroke-width:4px;""#)
            .unwrap()
            .is_match(&styled)
    );
    assert!(Regex::new(r#"class="pele-node pele-element cold" data-id="b""#).unwrap().is_match(&styled));
    assert!(
        Regex::new(r#"class="pele-node pele-element hot cold" data-id="c"[^>]*><rect[^>]*style="rx:var\(--_r\);fill:#f96;stroke:#0a0;stroke-width:4px;""#)
            .unwrap()
            .is_match(&styled)
    );
    assert!(styled.contains(r#"style="fill:blue;""#));
    assert!(
        Regex::new(r#"class="pele-divider"[^>]*style="stroke:#333;stroke-width:4px;""#)
            .unwrap()
            .is_match(&styled)
    );

    // Contrasting text color on fills a style sets.
    let contrast = render(
        "requirementDiagram\nrequirement a {\nid: 1\ntext: words\n}\nelement b {\ntype: t\n}\nelement c {\n}\nstyle a fill:#1f3a5f\nstyle b fill:#1f3a5f,color:#eee\n",
        &css_options(),
    )
    .unwrap()
    .svg;
    let node_svg = |id: &str| -> String {
        Regex::new(&format!(r#"data-id="{id}"[^>]*>(.*?)</g></g>"#))
            .unwrap()
            .captures(&contrast)
            .unwrap()[1]
            .to_string()
    };
    let na = node_svg("a");
    for part in ["pele-stereotype", "pele-label", "pele-field", "pele-value"] {
        assert!(
            Regex::new(&format!(r#"<text class="{part}"[^>]* fill="var\(--pele-fg-on-dark,#fff\)""#))
                .unwrap()
                .is_match(&na),
            "missing contrasting ink for {part}"
        );
    }
    let nb = node_svg("b");
    assert!(Regex::new(r#"<text class="pele-label"[^>]* style="fill:#eee;""#).unwrap().is_match(&nb));
    assert!(!nb.contains("--pele-fg-on"));
    let nc = node_svg("c");
    assert!(Regex::new(r#"<text class="pele-stereotype"[^>]* fill="var\(--_m\)""#).unwrap().is_match(&nc));

    // Markdown emphasis in names and text.
    let md = render(
        "requirementDiagram\nrequirement \"__name__\" {\ntext: \"*slanted* and **heavy** words\"\n}\n",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(md.contains(r#"data-id="__name__""#));
    assert!(
        Regex::new(r#"<text[^>]* font-weight="var\(--_hw\)"[^>]*><tspan[^>]*>name</tspan>"#)
            .unwrap()
            .is_match(&md)
    );
    assert!(Regex::new(r#"<tspan[^>]*font-style="italic">slanted</tspan>"#).unwrap().is_match(&md));
    assert!(Regex::new(r#"<tspan[^>]*font-weight="var\(--_w\)">heavy</tspan>"#).unwrap().is_match(&md));
    assert!(!md.contains('*'));
    assert!(!md.contains("__name__<"));

    // Wraps long text.
    let short = render("requirementDiagram\nrequirement a {\ntext: short\n}\n", &css_options()).unwrap();
    let long = render(
        &format!("requirementDiagram\nrequirement a {{\ntext: \"{}\"\n}}\n", "many words in a row ".repeat(12)),
        &css_options(),
    )
    .unwrap();
    assert!(long.height > short.height + 60.0);
    assert!(long.width < 420.0);

    // Front-matter title and accessible title/descr.
    let acc = render(
        "---\ntitle: Checkout\n---\nrequirementDiagram\naccTitle: Short name\naccDescr: Longer text\nrequirement a {\n}\n",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(acc.contains(r#"class="pele-title""#));
    assert!(acc.contains(">Checkout<"));
    assert!(acc.contains(r#"<title id="pele-title">Short name</title>"#));
    assert!(acc.contains(r#"<desc id="pele-desc">Longer text</desc>"#));

    // Empty diagram.
    let empty = render("requirementDiagram\n", &resolved_options()).unwrap();
    assert!(empty.svg.contains("<svg"));
    assert_well_formed(&empty.svg).unwrap();
}

#[test]
fn requirement_compat_db_grammar_quirks_and_rejection() {
    // Exposes model + Mermaid quirks.
    let parsed = parse(BASIC, &ParseOptions::default()).unwrap();
    assert_eq!(parsed.diagram_type, DiagramType::Requirement);
    let ParsedModel::Requirement(db) = &parsed.model else {
        panic!("expected requirement model");
    };
    let req = &db.requirements["test_req"];
    assert_eq!(req.req_type, "Requirement");
    assert_eq!(req.requirement_id, "1");
    assert_eq!(req.risk, "High");
    assert_eq!(req.verify_method, "Test");
    let elem = &db.elements["test_entity"];
    assert_eq!(elem.elem_type, "simulation");
    assert_eq!(elem.doc_ref, "reqs/test_entity");
    assert_eq!(db.relations.len(), 1);
    assert_eq!(db.relations[0].rel_type, "satisfies");
    assert_eq!(db.relations[0].src, "test_entity");
    assert_eq!(db.relations[0].dst, "test_req");
    assert_eq!(db.direction, "TB");

    // Repeated fields: first wins; keywords ignore case.
    let quirk = parse(
        "requirementDiagram\nRequirement a {\nID: first\nid: second\nRISK: HIGH\n}\n",
        &ParseOptions::default(),
    )
    .unwrap();
    let ParsedModel::Requirement(qdb) = &quirk.model else {
        panic!();
    };
    assert_eq!(qdb.requirements["a"].requirement_id, "first");
    assert_eq!(qdb.requirements["a"].risk, "High");

    // All risks and verify methods.
    for (risk, expected) in [("low", "Low"), ("medium", "Medium"), ("high", "High")] {
        let p = parse(&format!("requirementDiagram\nrequirement r {{\nrisk: {risk}\n}}\n"), &ParseOptions::default()).unwrap();
        let ParsedModel::Requirement(d) = p.model else { panic!() };
        assert_eq!(d.requirements["r"].risk, expected);
    }
    for (vm, expected) in [
        ("analysis", "Analysis"),
        ("demonstration", "Demonstration"),
        ("inspection", "Inspection"),
        ("test", "Test"),
    ] {
        let p = parse(
            &format!("requirementDiagram\nrequirement r {{\nverifymethod: {vm}\n}}\n"),
            &ParseOptions::default(),
        )
        .unwrap();
        let ParsedModel::Requirement(d) = p.model else { panic!() };
        assert_eq!(d.requirements["r"].verify_method, expected);
    }

    // Multiline accDescr & directions.
    let acc_p = parse(
        "requirementDiagram\n  accTitle: test title\n  accDescr {\n    my chart description\n    line 2\n  }\n  element test_name {\n  type: test_type\n  docref: test_ref\n  }\n",
        &ParseOptions::default(),
    )
    .unwrap();
    let ParsedModel::Requirement(adb) = acc_p.model else { panic!() };
    assert_eq!(adb.acc_title.as_deref(), Some("test title"));
    assert_eq!(adb.acc_descr.as_deref(), Some("my chart description\nline 2"));

    for dir in ["TB", "BT", "LR", "RL"] {
        let p = parse(&format!("requirementDiagram\n\ndirection {dir}\n"), &ParseOptions::default()).unwrap();
        let ParsedModel::Requirement(d) = p.model else { panic!() };
        assert_eq!(d.direction, dir);
    }

    // RequirementDb unit API (compat requirementDb.spec.ts).
    let mut udb = RequirementDb::new();
    udb.add_requirement("src", "Requirement");
    udb.add_requirement("dst", "Requirement");
    udb.add_relationship("traces", "src", "dst");
    udb.add_relationship("contains", "src", "dst");
    let graph = build_requirement_graph(&udb);
    let edge_ids: Vec<&str> = graph.edges.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(edge_ids, vec!["src-dst-0", "src-dst-1"]);
    udb.define_class(&["a".to_string(), "b".to_string()], &["stroke-width: 8px".to_string()])
        .unwrap();
    assert_eq!(udb.classes["a"].styles, vec!["stroke-width: 8px"]);
    assert_eq!(udb.classes["b"].styles, vec!["stroke-width: 8px"]);
    udb.add_element("elem");
    udb.set_css_style(&["src".to_string()], &["color:red".to_string()]).unwrap();
    udb.set_css_style(&["elem".to_string()], &["stroke-width:4px".to_string(), "stroke: yellow".to_string()])
        .unwrap();
    assert_eq!(udb.requirements["src"].css_styles, vec!["color:red"]);
    assert_eq!(udb.elements["elem"].css_styles, vec!["stroke-width:4px", "stroke: yellow"]);
    udb.set_class(&["src".to_string(), "elem".to_string()], &["a".to_string()]).unwrap();
    assert_eq!(udb.requirements["src"].classes, vec!["default", "a"]);
    assert_eq!(udb.requirements["src"].css_styles, vec!["color:red", "stroke-width: 8px"]);

    // Rejects what Mermaid rejects.
    for bad in [
        "requirementDiagram\nrequirement a {\nid: REQ-1\n}\n",
        "requirementDiagram\nrequirement a { \n}\n",
        "requirementDiagram\nrequirement a {\ntext: test the thing\n}\n",
        "requirementDiagram\na - contains - b\n",
        "requirementDiagram\nstyle a stroke-width:1.5px\n",
        "requirementDiagram\ntitle My diagram\n",
        "requirement a {\n}\n",
    ] {
        assert!(render(bad, &css_options()).is_err(), "should reject: {bad}");
    }
    let err = render("requirementDiagram\nrequirement a {\nid: REQ-1\n}\n", &css_options()).unwrap_err();
    assert!(err.message.contains("Expecting 'NEWLINE', got 'LINE'"), "got: {}", err.message);

    // Refuses unbounded class style copying.
    let bomb = format!(
        "requirementDiagram\nrequirement a {{\n}}\nclassDef c {}a:b\n{}",
        "a:b,".repeat(2000),
        "class a c\n".repeat(600)
    );
    let err = render(&bomb, &css_options()).unwrap_err();
    assert!(err.message.contains("too many style declarations"), "got: {}", err.message);

    // Default source limit.
    let over = format!("requirementDiagram\n{}", "element a {\n}\n".repeat(5000));
    let err = render(&over, &css_options()).unwrap_err();
    assert!(err.message.contains("limit of 50000"), "got: {}", err.message);
}

#[test]
fn requirement_security_hostile_payloads_direct_db_and_mutated_fuzz() {
    let body = "requirement a {\nid: 1\n}\nelement b {\ntype: t\n}\n";
    type Template = Box<dyn Fn(&str) -> String>;
    let templates: Vec<Template> = vec![
        Box::new(|p| format!("requirementDiagram\nrequirement {p} {{\nid: 1\n}}\n")),
        Box::new(|p| format!("requirementDiagram\nrequirement \"{p}\" {{\nid: 1\n}}\n")),
        Box::new(|p| format!("requirementDiagram\nelement {p} {{\ntype: t\n}}\n")),
        Box::new(|p| format!("requirementDiagram\nelement \"{p}\" {{\ntype: t\n}}\n\"{p}\" - contains -> \"{p}\"\n")),
        Box::new(|p| format!("requirementDiagram\nrequirement a {{\nid: {p}\ntext: {p}\n}}\n")),
        Box::new(|p| format!("requirementDiagram\nrequirement a {{\nid: \"{p}\"\ntext: \"{p}\"\n}}\n")),
        Box::new(|p| format!("requirementDiagram\nrequirement a {{\nrisk: {p}\nverifymethod: {p}\n}}\n")),
        Box::new(|p| format!("requirementDiagram\nelement b {{\ntype: {p}\ndocref: {p}\n}}\n")),
        Box::new(|p| format!("requirementDiagram\nelement b {{\ntype: \"{p}\"\ndocRef: \"{p}\"\n}}\n")),
        Box::new(move |p| format!("requirementDiagram\n{body}a - {p} -> b\n")),
        Box::new(move |p| format!("requirementDiagram\n{body}a - contains -> {p}\n")),
        Box::new(move |p| format!("requirementDiagram\n{body}\"{p}\" <- traces - a\n")),
        Box::new(|p| format!("requirementDiagram\nrequirement a:::{p} {{\nid: 1\n}}\n")),
        Box::new(|p| format!("requirementDiagram\nrequirement a:::\"{p}\" {{\nid: 1\n}}\nelement b:::\"{p}\",\"{p}\" {{\n}}\n")),
        Box::new(move |p| format!("requirementDiagram\n{body}a:::{p}\n")),
        Box::new(move |p| format!("requirementDiagram\n{body}a:::\"{p}\"\n")),
        Box::new(move |p| format!("requirementDiagram\n{body}class a {p}\n")),
        Box::new(move |p| format!("requirementDiagram\n{body}class a,b \"{p}\"\n")),
        Box::new(move |p| format!("requirementDiagram\n{body}class \"{p}\" c\n")),
        Box::new(move |p| format!("requirementDiagram\n{body}classDef {p} fill:red\nclass a {p}\n")),
        Box::new(move |p| format!("requirementDiagram\n{body}classDef \"{p}\" fill:red\nclass a \"{p}\"\n")),
        Box::new(move |p| format!("requirementDiagram\n{body}classDef c fill:{p}\nclass a c\n")),
        Box::new(move |p| format!("requirementDiagram\n{body}classDef c {p}:red\nclass a c\n")),
        Box::new(move |p| format!("requirementDiagram\n{body}style a fill:{p}\n")),
        Box::new(move |p| format!("requirementDiagram\n{body}style a {p}\n")),
        Box::new(move |p| format!("requirementDiagram\n{body}style a color:{p},stroke:{p},font-family:{p}\n")),
        Box::new(move |p| format!("requirementDiagram\n{body}style \"{p}\" fill:red\n")),
        Box::new(move |p| format!("requirementDiagram\naccTitle: {p}\naccDescr: {p}\n{body}")),
        Box::new(move |p| format!("accTitle: {p}\nrequirementDiagram\n{body}")),
        Box::new(move |p| format!("requirementDiagram\naccDescr {{\n {p}\n }}\n{body}")),
        Box::new(move |p| format!("requirementDiagram\ndirection {p}\n{body}")),
        Box::new(move |p| format!("requirementDiagram\n{p} direction LR\n{body}")),
        Box::new(move |p| format!("requirementDiagram\n# {p}\n{body}")),
        Box::new(move |p| format!("requirementDiagram\n%% {p}\n{body}")),
        Box::new(move |p| format!("requirementDiagram {p}\n{body}")),
        Box::new(move |p| format!("---\ntitle: \"{p}\"\nconfig:\n  requirement:\n    fontSize: \"{p}\"\n  theme: \"{p}\"\n---\nrequirementDiagram\n{body}")),
        Box::new(move |p| {
            format!(
                "%%{{init: {{\"requirement\": {{\"rect_fill\": \"{p}\"}}, \"themeVariables\": {{\"fontFamily\": \"{p}\"}}}}}}%%\nrequirementDiagram\n{body}"
            )
        }),
    ];

    let mut rendered = 0usize;
    for (ti, tmpl) in templates.iter().enumerate() {
        for (pi, &payload) in PAYLOADS.iter().enumerate() {
            if let Ok(res) = render(&tmpl(payload), &resolved_options()) {
                assert_inert_resolved(&res.svg, &format!("req tmpl {ti} payload {pi}"));
                rendered += 1;
            }
        }
    }
    assert!(rendered > 550, "only rendered {rendered}");

    // Escaping check.
    let esc_svg = render(
        "requirementDiagram\nrequirement \"<script>alert(1)</script>\" {\ntext: \"<img src=x onerror=alert(1)>\"\n}\n",
        &resolved_options(),
    )
    .unwrap()
    .svg;
    assert!(!esc_svg.contains("<script"));
    assert!(!esc_svg.contains("<img"));
    assert!(esc_svg.contains(r#"data-id="&lt;script&gt;alert(1)&lt;/script&gt;""#));

    // Hostile option values.
    for &payload in PAYLOADS {
        let res = render(
            &format!("requirementDiagram\naccTitle: t\n{body}a - contains -> b\n"),
            &RenderOptions {
                id_prefix: Some(payload.to_string()),
                font_family: Some(payload.to_string()),
                ..resolved_options()
            },
        )
        .unwrap();
        assert_inert_resolved(&res.svg, payload);
    }

    // Direct model fill with hostile payloads.
    let config = DiagramConfig::default();
    let palette = PaletteOverrides::default();
    let opts = resolved_options();
    let theme = SvgTheme::new(ThemeMode::light(), None, None);
    let ctx = RenderContext {
        config: &config,
        options: &opts,
        responsive: true,
        theme: &theme,
        palette: &palette,
        measurer: &METRICS_MEASURER,
        icons: None,
        math: None,
    };
    for &payload in PAYLOADS {
        let mut db = RequirementDb::new();
        db.title = Some(payload.to_string());
        db.set_acc_title(payload);
        db.set_acc_description(payload);
        db.set_direction(payload);
        db.set_new_req_id(payload.to_string());
        db.set_new_req_text(payload.to_string());
        db.set_new_req_risk(payload.to_string());
        db.set_new_req_verify_method(payload.to_string());
        db.add_requirement(payload, payload);
        db.set_new_element_type(payload.to_string());
        db.set_new_element_doc_ref(payload.to_string());
        db.add_element("e");
        db.add_relationship(payload, payload, "e");
        db.add_relationship(payload, "e", "e");
        let _ = db.define_class(
            &[payload.to_string()],
            &[
                payload.to_string(),
                format!("fill:{payload}"),
                format!("stroke:{payload}"),
                format!("color:{payload}"),
                format!("font-family:{payload}"),
            ],
        );
        let _ = db.set_class(&[payload.to_string(), "e".to_string()], &[payload.to_string()]);
        let _ = db.set_css_style(
            &["e".to_string()],
            &[
                format!("fill:{payload},stroke-dasharray:{payload}"),
                format!("font-size:{payload}"),
                format!("{payload}:red"),
            ],
        );
        let rendered = render_requirement(&db, &ctx);
        assert_inert_resolved(&rendered.svg, payload);
    }

    // Mutated fuzzing (1,000 samples).
    let corpus = load_fixture("requirement-corpus.json");
    let mut frags: Vec<&str> = PAYLOADS.to_vec();
    frags.extend([
        "\"",
        "{",
        "}",
        ":",
        ":::",
        "\n",
        "style a fill:",
        "classDef c ",
        "class a ",
        " - contains -> ",
        "accTitle: ",
    ]);
    let mut mutator = Mutator::new(&corpus, frags, 3);
    let mut fuzz_rendered = 0usize;
    for i in 0..1000 {
        let src = mutator.next_sample();
        if src.len() <= 4000
            && let Ok(res) = render(&src, &resolved_options())
        {
            assert_inert_resolved(&res.svg, &format!("req fuzz #{i}"));
            fuzz_rendered += 1;
        }
    }
    assert!(fuzz_rendered > 50, "only rendered {fuzz_rendered}");

    // __proto__ / constructor as ids.
    let proto_res = render(
        "requirementDiagram\nrequirement __proto__ {\nid: constructor\n}\nelement constructor {\ntype: toString\n}\n__proto__ - contains -> constructor\nclassDef __proto__ fill:red\nclass __proto__,constructor __proto__,toString\n__proto__:::constructor\nstyle __proto__ fill:red\n",
        &resolved_options(),
    )
    .unwrap();
    assert_inert_resolved(&proto_res.svg, "proto");
    assert_resvg_parses(&proto_res.svg, "proto resvg");
}

#[test]
fn requirement_stress_worst_cases_stay_linear() {
    let n = 50_000usize;
    let head = "requirementDiagram\n";
    let big_parse = ParseOptions {
        limit: Some(usize::MAX),
        ..ParseOptions::default()
    };
    let big_render = RenderOptions {
        limit: Some(usize::MAX),
        ..resolved_options()
    };

    // Lexer stress cases.
    let lex_cases: Vec<(&str, String)> = vec![
        ("direction without end", format!("{head}{}direction XX", "a - contains -> b ".repeat(n / 18))),
        ("many tokens ending in direction", format!("{head}{}direction LR", ": ".repeat(n / 2))),
        (
            "direction followed by blank lines",
            format!("{head}{}TB", format!("direction{}", "\n".repeat(40)).repeat(n / 50)),
        ),
        ("many direction words", format!("{head}{}TB", "direction ".repeat(n / 10))),
        ("many direction statements", format!("{head}{}", "direction TB ".repeat(n / 13))),
        (
            "accTitle wall of spaces",
            format!("{head}{}", format!("accTitle{}\n", " ".repeat(100)).repeat(n / 110)),
        ),
        ("accDescr whitespace only", format!("{head}accDescr{}", " \n".repeat(n / 2))),
        ("unclosed accDescr block", format!("{head}accDescr {{{}", " a\n".repeat(n / 3))),
        ("title word on every line", format!("{head}{}", "title\n".repeat(n / 6))),
        ("title followed by hashes", format!("{head}{}", "title #".repeat(n / 7))),
        ("unquoted string of spaces", format!("{head}a{}b", " ".repeat(n))),
        ("unclosed quoted string", format!("{head}element \"{}", "x".repeat(n))),
        ("quotes only", format!("{head}{}", "\"".repeat(n))),
        ("runs of whitespace", format!("{head}{}", format!("a{}:", " \n\t".repeat(30)).repeat(n / 100))),
        ("spaces in style", format!("{head}style a{}fill:red\n", " ".repeat(n))),
    ];
    for (name, src) in lex_cases {
        let t0 = Instant::now();
        let _ = tokenize(&src);
        assert!(t0.elapsed().as_secs_f64() < 5.0, "lex {name} took {:?}", t0.elapsed());
    }

    // Parser stress cases.
    let parse_cases: Vec<(&str, String)> = vec![
        ("style 25k parts", format!("{head}style a {}\n", "f:#-;".repeat(n / 5))),
        ("class list 25k names", format!("{head}requirement a {{\n}}\nclass a {}c\n", "c,".repeat(n / 2))),
        ("body 10k repeated fields", format!("{head}requirement a {{\n{}}}\n", "id: 1\n".repeat(10_000))),
        ("unclosed body", format!("{head}requirement a {{\n{}", "text: x\n".repeat(6000))),
        ("25k blank lines", format!("{head}{}requirement a {{\n}}\n", "\n \n".repeat(n / 3))),
        ("comments every line", format!("{head}{}", "# c\n% d\n".repeat(n / 8))),
    ];
    for (name, src) in parse_cases {
        let t0 = Instant::now();
        let _ = parse(&src, &big_parse);
        assert!(t0.elapsed().as_secs_f64() < 5.0, "parse {name} took {:?}", t0.elapsed());
    }

    // Render stress cases.
    let render_cases: Vec<(&str, String)> = vec![
        (
            "class defined & applied 1,600 times",
            format!("{head}requirement a {{\n}}\n{}", "classDef c fill:red\nclass a c\n".repeat(1600)),
        ),
        (
            "class 6,000 decls x 2,500",
            format!(
                "{head}requirement a {{\n}}\nclassDef c {}a:b\n{}",
                "a:b,".repeat(6000),
                "class a c\n".repeat(2500)
            ),
        ),
        ("class 3,000 decls x 1,000 nodes", {
            let mut s = String::from(head);
            for i in 0..1000 {
                s.push_str(&format!("element e{i} {{\n}}\n"));
            }
            s.push_str(&format!("classDef c {}a:b\n", "a:b,".repeat(3000)));
            let all = (0..1000).map(|i| format!("e{i}")).collect::<Vec<_>>().join(",");
            s.push_str(&format!("class {all} c\n").repeat(3));
            s
        }),
        ("2,000 nodes + 600 classDefs", {
            let mut s = String::from(head);
            for i in 0..2000 {
                s.push_str(&format!("element e{i}:::c {{\n}}\n"));
            }
            s.push_str(&"classDef c a:b\n".repeat(600));
            s
        }),
        ("2,000 requirements", {
            let mut s = String::from(head);
            for i in 0..2000 {
                s.push_str(&format!("requirement r{i} {{\nid: {i}\nrisk: low\n}}\n"));
            }
            s
        }),
        ("chain of 1,500", {
            let mut s = String::from(head);
            for i in 0..1500 {
                s.push_str(&format!("element e{i} {{\n}}\n"));
            }
            for i in 0..1499 {
                s.push_str(&format!("e{i} - traces -> e{}\n", i + 1));
            }
            s
        }),
        ("star of 1,500", {
            let mut s = String::from(head);
            for i in 0..1500 {
                s.push_str(&format!("element e{i} {{\n}}\n"));
            }
            for i in 0..1499 {
                s.push_str(&format!("e0 - contains -> e{}\n", i + 1));
            }
            s
        }),
        (
            "2,500 parallel + 500 self",
            format!(
                "{head}element a {{\n}}\nelement b {{\n}}\n{}{}",
                "a - copies -> b\n".repeat(2500),
                "a - contains -> a\n".repeat(500)
            ),
        ),
        ("2,500 missing targets", {
            let mut s = format!("{head}element a {{\n}}\n");
            for i in 0..2500 {
                s.push_str(&format!("a - refines -> x{i}\n"));
            }
            s
        }),
        ("complete graph of 40", {
            let mut s = String::from(head);
            for i in 0..40 {
                s.push_str(&format!("element e{i} {{\n}}\n"));
            }
            for i in 0..40 {
                for j in (i + 1)..40 {
                    s.push_str(&format!("e{i} - derives -> e{j}\n"));
                }
            }
            s
        }),
        ("50k char text", format!("{head}requirement a {{\ntext: \"{}\"\n}}\n", "word ".repeat(n / 5))),
        (
            "emphasis markers text",
            format!("{head}requirement a {{\ntext: \"{}\"\n}}\n", "*a _b **c ".repeat(n / 10)),
        ),
        ("50k char name", format!("{head}requirement {} {{\n}}\n", "x".repeat(n))),
        (
            "entities and br text",
            format!("{head}requirement a {{\ntext: \"{}\"\n}}\n", "#35;&amp;<br>".repeat(n / 13)),
        ),
    ];
    for (name, src) in render_cases {
        let t0 = Instant::now();
        let _ = render(&src, &big_render);
        assert!(t0.elapsed().as_secs_f64() < 15.0, "render {name} took {:?}", t0.elapsed());
    }
}
