mod support;

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use regex::Regex;
use vibevalley_pele::detect::DiagramType;
use vibevalley_pele::diagram::state::lexer::tokenize;
use vibevalley_pele::diagram::state::parser::parse_state;
use vibevalley_pele::diagram::state::tokens::StateToken;
use vibevalley_pele::diagram::state::types::{ClickStmt, ClickTarget, Stmt};
use vibevalley_pele::diagram::state::{EdgePattern, StateDb, StateNodeShape};
use vibevalley_pele::{ErrorCode, LinkInfo, MathSvg, ParseOptions, ParsedModel, detect_type, parse, render, supports};

use support::{
    Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, assert_well_formed, css_options, dark_options, load_fixture, resolved_options,
};

fn parse_raw(src: &str) -> StateDb {
    let mut db = StateDb::new();
    parse_state(src, &mut db, None).unwrap_or_else(|e| panic!("parse failed for {src:?}: {e}"));
    db
}

fn model(body: &str) -> StateDb {
    let parsed = parse(&format!("stateDiagram-v2\n{body}"), &ParseOptions::default()).unwrap();
    match parsed.model {
        ParsedModel::State(db) => db,
        other => panic!("expected State model, got {:?}", other.diagram_type()),
    }
}

fn draw(body: &str) -> String {
    render(&format!("stateDiagram-v2\n{body}"), &css_options()).unwrap().svg
}

fn draw_resolved(body: &str) -> String {
    render(&format!("stateDiagram-v2\n{body}"), &resolved_options()).unwrap().svg
}

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

fn place(svg: &str, id: &str) -> (f64, f64) {
    let re = Regex::new(&format!(r#"data-id="{}" transform="translate\(([-\d.]+),([-\d.]+)\)""#, regex::escape(id))).unwrap();
    let caps = re.captures(svg).unwrap_or_else(|| panic!("no node {id} in SVG"));
    (caps[1].parse().unwrap(), caps[2].parse().unwrap())
}

fn rect_of(svg: &str, id: &str) -> (f64, f64) {
    let needle = format!(r#"data-id="{id}""#);
    let at = svg.find(&needle).unwrap_or_else(|| panic!("no node {id} in SVG"));
    let re = Regex::new(r#"<rect x="[-\d.]+" y="[-\d.]+" width="([\d.]+)" height="([\d.]+)""#).unwrap();
    let caps = re.captures(&svg[at..]).unwrap_or_else(|| panic!("no rect in {id}"));
    (caps[1].parse().unwrap(), caps[2].parse().unwrap())
}

fn assert_close(a: f64, b: f64, tol: f64, msg: &str) {
    assert!((a - b).abs() <= tol, "{msg}: {a} vs {b} (tol={tol})");
}

#[test]
fn state_compat_parser_and_db_specs() {
    // Valid single-word composite name.
    let db = parse_raw("stateDiagram-v2\n state valid { X }");
    assert!(db.states.contains_key("valid"));

    // Invalid multi-word composite names.
    for bad in [
        "stateDiagram-v2\n state invalid syntax { Y }",
        "stateDiagram-v2\n state invalid syntax with more than 2 words { Z }",
    ] {
        let mut db = StateDb::new();
        let err = parse_state(bad, &mut db, None).unwrap_err();
        assert!(err.message.contains("Error: State name must be a single word."), "msg={}", err.message);
    }

    // Aliased and colon-described states.
    let db = parse_raw("stateDiagram-v2\n state \"Small State 1\" as namedState1");
    assert_eq!(db.states["namedState1"].descriptions.join(" "), "Small State 1");

    for src in ["stateDiagram-v2\n namedState1 : Small State 1", "stateDiagram-v2\n namedState1:Small State 1"] {
        let db = parse_raw(src);
        assert_eq!(db.states["namedState1"].descriptions.join(" "), "Small State 1");
    }

    // "as" in state names.
    let db = parse_raw("stateDiagram-v2\n assemble\n assemblies\n state assemble\n state assemblies\n");
    assert!(db.states.contains_key("assemble"));
    assert!(db.states.contains_key("assemblies"));

    let db = parse_raw("stateDiagram-v2\n state \"as\" as as\n");
    assert_eq!(db.states["as"].descriptions.join(" "), "as");

    // Groups (clusters/containers) and inner aliased/described states.
    let db = parse_raw(
        "stateDiagram-v2
        state \"Small State 1\" as namedState1
        %% Notice that this is named \"Big State 1\" with an \"as\"
        state \"Big State 1\" as bigState1 {
            bigState1InternalState
        }
        namedState1 --> bigState1: should point to \\nBig State 1 container

        state \"Small State 2\" as namedState2
        %% Notice that bigState2 does not have a name; no \"as\"
        state bigState2 {
            bigState2InternalState
        }
        namedState2 --> bigState2: should point to \\nbigState2 container",
    );
    assert!(db.states.contains_key("namedState1"));
    assert!(db.states.contains_key("bigState1"));
    match &db.states["bigState1"].doc.as_ref().unwrap()[0] {
        Stmt::State(s) => assert_eq!(s.id, "bigState1InternalState"),
        other => panic!("expected State stmt, got {other:?}"),
    }
    match &db.states["bigState2"].doc.as_ref().unwrap()[0] {
        Stmt::State(s) => assert_eq!(s.id, "bigState2InternalState"),
        other => panic!("expected State stmt, got {other:?}"),
    }
    assert_eq!(db.relations[0].id1, "namedState1");
    assert_eq!(db.relations[0].id2, "bigState1");
    assert_eq!(db.relations[1].id1, "namedState2");
    assert_eq!(db.relations[1].id2, "bigState2");

    // Colons in transition and state descriptions (issue #7418).
    let db = parse_raw("stateDiagram-v2\n locked --> pending : recoverable error (ex: timeout)");
    assert_eq!(db.relations.len(), 1);
    assert_eq!(db.relations[0].relation_title, "recoverable error (ex: timeout)");

    let db = parse_raw("stateDiagram-v2\n A --> B : info: key: value");
    assert_eq!(db.relations[0].relation_title, "info: key: value");

    let db = parse_raw("stateDiagram-v2\n myState : status: active");
    assert_eq!(db.states["myState"].descriptions.join(" "), "status: active");

    // Unsafe property names as state ids.
    for prop in ["__proto__", "constructor"] {
        let db = parse_raw(&format!("stateDiagram-v2\n[*] --> {prop}\n{prop} --> [*]"));
        assert!(db.states.contains_key(prop));
    }

    // Note parsing with "send note" / "end note" inside body (issue #7089).
    for phrase in ["send note inside the note text", "end note as part of the note text"] {
        let db = parse_raw(&format!(
            "stateDiagram-v2\n State1\n note right of State1\n   this sentence contains {phrase}\n end note\n State1 --> State2"
        ));
        assert_eq!(db.relations.len(), 1);
        assert_eq!(db.relations[0].id1, "State1");
        assert_eq!(db.relations[0].id2, "State2");
        assert!(db.states["State1"].note.as_ref().unwrap().text.contains(phrase));
    }

    // StateDb unit methods: addStyleClass & addDescription.
    let mut db = StateDb::new();
    db.add_style_class("newStyleClass", "font-weight:bold, border:blue;");
    assert_eq!(db.classes["newStyleClass"].styles, vec!["font-weight:bold", "border:blue"]);

    db.add_state("state1", None, None, None, None, None);
    db.add_description("state1", "rest of the description");
    db.add_description("state1", ":rest of the description");
    db.add_description("state1", "::rest of the description");
    assert_eq!(
        db.states["state1"].descriptions,
        vec!["rest of the description", "rest of the description", ":rest of the description"]
    );

    // Click statement manually passed to extract().
    let mut db = StateDb::new();
    db.add_state("S1", None, None, None, None, None);
    db.extract(&[Stmt::Click(ClickStmt {
        id: ClickTarget::Id("S1".to_string()),
        url: "https://example.com".to_string(),
        tooltip: "Go to Example".to_string(),
    })])
    .unwrap();
    assert_eq!(db.links["S1"].url, "https://example.com");
    assert_eq!(db.links["S1"].tooltip, "Go to Example");

    // Default & explicit diagram direction.
    let db = parse_raw("stateDiagram\n [*] --> Still\n Still --> [*]\n");
    assert_eq!(db.get_direction(), "TB");
    let db = parse_raw("stateDiagram\n direction LR\n [*] --> Still\n Still --> [*]\n");
    assert_eq!(db.get_direction(), "LR");
}

#[test]
fn state_compat_styles_classes_comments_and_notes() {
    // classDef single, multiple, dots, spaces, __proto__, constructor.
    let db = parse_raw("stateDiagram-v2\n classDef exampleClass background:#bbb;");
    assert_eq!(db.classes["exampleClass"].styles, vec!["background:#bbb"]);

    let db = parse_raw("stateDiagram-v2\n classDef exampleClass background:#bbb, font-weight:bold, font-style:italic;");
    assert_eq!(
        db.classes["exampleClass"].styles,
        vec!["background:#bbb", "font-weight:bold", "font-style:italic"]
    );

    let db = parse_raw("stateDiagram-v2\n classDef exampleStyleClass background:  #bbb,border:1.5px solid red;");
    assert_eq!(db.classes["exampleStyleClass"].styles, vec!["background:  #bbb", "border:1.5px solid red"]);

    let db = parse_raw(
        "stateDiagram-v2\n classDef __proto__ background:#bbb,border:1.5px solid red;\n classDef constructor background:#bbb,border:1.5px solid red;",
    );
    assert_eq!(db.classes["__proto__"].styles.len(), 2);
    assert_eq!(db.classes["constructor"].styles.len(), 2);

    // class applied via class keyword, ::: syntax, [*]:::, comma-separated with/without spaces, and inside composites.
    let db = parse_raw("stateDiagram-v2\n\nclassDef c background:#bbb;\na_a --> b_b\nclass a_a c");
    assert_eq!(db.states["a_a"].classes, vec!["c"]);

    let db = parse_raw("stateDiagram-v2\n\nclassDef c background:#bbb;\na --> b:::c\n");
    assert_eq!(db.states["b"].classes, vec!["c"]);

    let db = parse_raw("stateDiagram-v2\n\nclassDef c background:#bbb;\n[*]:::c --> b\n");
    assert_eq!(db.states["root_start"].classes, vec!["c"]);

    let db = parse_raw("stateDiagram-v2\n\nclassDef c background:#bbb;\na-->b\nclass a,b,c, d, e c");
    for id in ["a", "b", "c", "d", "e"] {
        assert_eq!(db.states[id].classes, vec!["c"]);
    }

    let db = parse_raw("stateDiagram-v2\nstate A {\n  [*]:::c --> a\n}\n");
    match &db.states["A"].doc.as_ref().unwrap()[0] {
        Stmt::Relation(r) => assert_eq!(r.state1.classes, vec!["c"]),
        other => panic!("expected relation, got {other:?}"),
    }

    // Comments parsing (inside composites, inline %%, single %, consecutive comments).
    let db = parse_raw("stateDiagram-v2\n%%initial\n[*] --> Moving %%inline\n%%final\n");
    assert_eq!(db.states.len(), 2);

    let db = parse_raw("stateDiagram-v2\n% not a comment\nMoving --> Still %inline\n");
    assert_eq!(db.states.len(), 7);
    assert!(db.states.contains_key("%inline"));

    let db = parse_raw("stateDiagram-v2\n[*] --> Moving%% this is a comment\nMoving --> Still%Active\n");
    assert!(db.states.contains_key("Moving"));
    assert!(db.states.contains_key("Still%Active"));

    // style statement for single and multiple ids.
    let db = parse_raw("stateDiagram-v2\n id1\n id2\n style id1,id2 background:#bbb, font-weight:bold, font-style:italic;");
    let expected = vec!["background:#bbb", "font-weight:bold", "font-style:italic"];
    assert_eq!(db.graph.nodes[0].css_styles, expected);
    assert_eq!(db.graph.nodes[1].css_styles, expected);

    // Note edge pattern & classes (stateNoteEdge.spec.ts).
    let db = parse_raw("stateDiagram-v2\n [*] --> Active\n Active --> Idle\n note right of Active\n   A note\n end note\n");
    let note_edge = db.graph.edges.iter().find(|e| e.classes.contains("note-edge")).unwrap();
    assert_eq!(note_edge.pattern, Some(EdgePattern::Dashed));
    assert!(note_edge.classes.contains("note-edge"));
    let transitions: Vec<_> = db.graph.edges.iter().filter(|e| !e.classes.contains("note-edge")).collect();
    assert!(!transitions.is_empty());
    assert!(transitions.iter().all(|e| e.pattern.is_none()));

    // Note node on composite is never a group; noteGroup wraps it (stateNoteNode.spec.js).
    let db = parse_raw("stateDiagram-v2\n state Composite {\n   A --> B\n }\n note right of Composite : hello\n");
    let note = db.graph.nodes.iter().find(|n| n.shape == Some(StateNodeShape::Note)).unwrap();
    assert!(!note.is_group);
    let note_group = db.graph.nodes.iter().find(|n| n.shape == Some(StateNodeShape::NoteGroup)).unwrap();
    assert!(note_group.is_group);
}

#[test]
fn state_compat_color_index_slots() {
    let slots = |src: &str| -> HashMap<String, Option<usize>> { parse_raw(src).graph.nodes.into_iter().map(|n| (n.id, n.color_index)).collect() };

    // 1. Pre-order containment slots.
    let by_id = slots(
        "stateDiagram-v2
          [*] --> Boot
          state Boot {
            [*] --> Firmware
            state Kernel {
              [*] --> Scheduler
              state Drivers {
                [*] --> Probe
              }
            }
          }
          Boot --> Running
          state Running {
            [*] --> Serving
          }",
    );
    assert_eq!(by_id["Boot"], Some(0));
    assert_eq!(by_id["Kernel"], Some(1));
    assert_eq!(by_id["Drivers"], Some(2));
    assert_eq!(by_id["Running"], Some(3));

    // 2. Plain states unslotted.
    let by_id = slots("stateDiagram-v2\n state Outer {\n [*] --> Inner\n Inner --> Done\n }");
    assert_eq!(by_id["Outer"], Some(0));
    assert_eq!(by_id["Inner"], None);
    assert_eq!(by_id["Done"], None);

    // 3. Concurrency regions share composite's own slot.
    let nodes = parse_raw("stateDiagram-v2\n state Active {\n [*] --> A\n --\n [*] --> B\n --\n [*] --> C\n }")
        .graph
        .nodes;
    let active_slot = nodes.iter().find(|n| n.id == "Active").unwrap().color_index;
    let regions: Vec<_> = nodes.iter().filter(|n| n.shape == Some(StateNodeShape::Divider)).collect();
    assert_eq!(regions.len(), 3);
    assert_eq!(active_slot, Some(0));
    assert!(regions.iter().all(|r| r.color_index == Some(0)));

    // 4. Adding a divider does not shift later composites.
    let without = slots("stateDiagram-v2\n state First { [*] --> A }\n state Second { [*] --> B }");
    let with = slots("stateDiagram-v2\n state First { [*] --> A\n --\n [*] --> C }\n state Second { [*] --> B }");
    assert_eq!(without["First"], with["First"]);
    assert_eq!(without["Second"], with["Second"]);
    assert_eq!(with["Second"], Some(1));

    // 5. Styled composite opt-out carries into concurrency regions.
    let nodes = parse_raw(
        "stateDiagram-v2
          classDef pinned fill:#111827,stroke:#F59E0B
          state Active {
            [*] --> A
            --
            [*] --> B
          }
          class Active pinned",
    )
    .graph
    .nodes;
    assert_eq!(nodes.iter().find(|n| n.id == "Active").unwrap().color_index, None);
    let regions: Vec<_> = nodes.iter().filter(|n| n.shape == Some(StateNodeShape::Divider)).collect();
    assert_eq!(regions.len(), 2);
    assert!(regions.iter().all(|r| r.color_index.is_none()));

    // 6. Separately divided composites don't share one slot.
    let nodes = parse_raw(
        "stateDiagram-v2
          state First { [*] --> A\n --\n [*] --> B }
          state Second { [*] --> C\n --\n [*] --> D }",
    )
    .graph
    .nodes;
    let first = nodes.iter().find(|n| n.id == "First").unwrap().color_index;
    let second = nodes.iter().find(|n| n.id == "Second").unwrap().color_index;
    assert_ne!(first, second);
    let regions: Vec<_> = nodes.iter().filter(|n| n.shape == Some(StateNodeShape::Divider)).collect();
    assert_eq!(regions.len(), 4);
    let distinct: HashSet<_> = regions.iter().map(|r| r.color_index).collect();
    assert_eq!(distinct.len(), 2);
    for r in &regions {
        match r.parent_id.as_deref() {
            Some("First") => assert_eq!(r.color_index, first),
            Some("Second") => assert_eq!(r.color_index, second),
            other => panic!("unexpected region parent {other:?}"),
        }
    }

    // 7. classDef unstamped still consumes slot.
    let by_id = slots(
        "stateDiagram-v2
          classDef pinned fill:#111827
          state First { [*] --> A }
          state Second { [*] --> B }
          state Third { [*] --> C }
          class Second pinned",
    );
    assert_eq!(by_id["First"], Some(0));
    assert_eq!(by_id["Second"], None);
    assert_eq!(by_id["Third"], Some(2));

    // 8. style statement unstamped.
    let by_id = slots("stateDiagram-v2\n state First { [*] --> A }\n state Second { [*] --> B }\n style Second fill:#111827");
    assert_eq!(by_id["First"], Some(0));
    assert_eq!(by_id["Second"], None);

    // 9. Composite named twice spends one slot.
    let by_id = slots(
        "stateDiagram-v2
          [*] --> Loop
          state Loop { [*] --> Spin }
          Loop --> Loop
          Loop --> Exit
          state Exit { [*] --> Bye }",
    );
    assert_eq!(by_id["Loop"], Some(0));
    assert_eq!(by_id["Exit"], Some(1));
}

#[test]
fn state_renders_full_upstream_corpus_in_css_resolved_and_dark_modes() {
    let corpus = load_fixture("state-corpus.json");
    assert!(corpus.len() > 100, "expected >100 corpus samples, got {}", corpus.len());

    let re_bad = Regex::new(r"(?i)<script|<style|<foreignObject|\son\w+=|javascript:").unwrap();
    let re_path = Regex::new(r"^(?:[ML]-?[\d.]+,-?[\d.]+|[HV]-?[\d.]+|C-?[\d.]+,-?[\d.]+ -?[\d.]+,-?[\d.]+ -?[\d.]+,-?[\d.]+|Z)+$").unwrap();
    let mut rendered = 0usize;

    for src in &corpus {
        let Some(svg) = try_render_css(src) else {
            continue;
        };
        rendered += 1;
        let where_ctx: String = src.chars().take(120).collect();
        assert_well_formed(&svg).unwrap_or_else(|e| panic!("{where_ctx}: {e}"));
        assert_inert(&svg, &where_ctx);
        assert!(!re_bad.is_match(&svg), "{where_ctx}: unsafe markup");
        assert!(!svg.contains("NaN"), "{where_ctx}: NaN");
        assert!(!svg.contains("undefined"), "{where_ctx}: undefined");
        assert!(!svg.contains("Infinity"), "{where_ctx}: Infinity");

        let doc = roxmltree::Document::parse(&svg).unwrap();
        for node in doc.descendants().filter(|n| n.is_element()) {
            if let Some(d) = node.attribute("d") {
                assert!(re_path.is_match(d), "{where_ctx}: unexpected path syntax d={d:?}");
            }
        }
        assert_eq!(try_render_css(src).as_deref(), Some(svg.as_str()), "{where_ctx}: determinism");

        let res_svg = try_render_resolved(src).expect("resolved mode failed where css mode succeeded");
        assert_inert_resolved(&res_svg, &where_ctx);
        assert_resvg_parses(&res_svg, &where_ctx);

        let dark_svg = render(src, &dark_options()).expect("dark mode failed where css mode succeeded").svg;
        assert_inert_resolved(&dark_svg, &where_ctx);
        assert_resvg_parses(&dark_svg, &where_ctx);
    }
    assert_eq!(corpus.len(), 119);
    assert_eq!(rendered, 113, "expected 113 rendered state corpus samples, got {rendered}");
}

#[test]
fn state_detection_theme_modes_and_directions() {
    assert_eq!(detect_type("stateDiagram\n a --> b"), Some(DiagramType::State));
    assert_eq!(detect_type("stateDiagram-v2\n a --> b"), Some(DiagramType::State));
    assert!(supports("stateDiagram-v2\n a --> b"));

    let result = render("stateDiagram-v2\n a --> b", &css_options()).unwrap();
    assert_eq!(result.diagram_type, DiagramType::State);
    assert!(result.svg.starts_with(r#"<svg xmlns="http://www.w3.org/2000/svg" class="pele pele-state""#));
    assert!(result.svg.contains(&format!("viewBox=\"0 0 {} {}\"", result.width, result.height)));
    assert!(result.height > result.width);

    // Theme tokens in CSS variable mode.
    let svg = draw("[*] --> a\n state a {\n x --> y : go\n }\n note right of a : n\n a --> [*]");
    assert!(!svg.contains("<style"));
    let re_token = Regex::new(r"^(?:none|var\(--_(?:bg|fg|m|l|s|a|b|c)\))$").unwrap();
    let doc = roxmltree::Document::parse(&svg).unwrap();
    for el in doc.descendants().filter(|n| n.is_element()) {
        if el.tag_name().name() == "svg" {
            continue;
        }
        for name in ["fill", "stroke"] {
            if let Some(val) = el.attribute(name) {
                assert!(re_token.is_match(val), "unexpected {name}={val:?} on <{}>", el.tag_name().name());
            }
        }
    }

    // Resolved light and dark modes emit concrete colors and parse with usvg.
    let light_svg = draw_resolved("[*] --> a\n state a {\n x --> y : go\n }\n note right of a : n\n a --> [*]");
    assert_inert_resolved(&light_svg, "resolved light");
    assert_resvg_parses(&light_svg, "resolved light");
    assert!(light_svg.contains("#f3f3f3"));
    assert!(light_svg.contains("#e6e6e6"));

    let dark_svg = render(
        "stateDiagram-v2\n [*] --> a\n state a {\n x --> y : go\n }\n note right of a : n\n a --> [*]",
        &dark_options(),
    )
    .unwrap()
    .svg;
    assert_inert_resolved(&dark_svg, "resolved dark");
    assert_resvg_parses(&dark_svg, "resolved dark");
    assert!(dark_svg.contains("#2a2a2a"));
    assert!(dark_svg.contains("#343434"));
    assert_ne!(light_svg, dark_svg);

    // Directions TB, LR, BT, RL.
    let tall = render("stateDiagram-v2\n a --> b\n b --> c", &css_options()).unwrap();
    let wide = render("stateDiagram-v2\n direction LR\n a --> b\n b --> c", &css_options()).unwrap();
    assert!(tall.height > tall.width);
    assert!(wide.width > wide.height);

    let up = draw("direction BT\n a --> b");
    assert!(place(&up, "a").1 > place(&up, "b").1);
    let leftward = draw("direction RL\n a --> b");
    assert!(place(&leftward, "a").0 > place(&leftward, "b").0);
}

#[test]
fn state_shapes_composites_dividers_notes_and_transitions() {
    // State with id, description, title over description lines.
    assert!(draw("s1").contains(">s1</text>"));
    let described = draw("state \"A long name\" as s1\n s2 : Other");
    assert!(described.contains(">A long name</text>"));
    assert!(described.contains(">Other</text>"));
    assert!(!described.contains(">s1</text>"));

    let lines = draw("s1 : Title\n s1 : first\n s1 : second");
    assert!(lines.contains(">Title</text>"));
    assert_eq!(lines.matches(r#"class="pele-state-description""#).count(), 2);
    assert!(rect_of(&lines, "s1").1 > rect_of(&draw("s1 : Title"), "s1").1 + 30.0);

    // [*] start dot and end ring separately in each composite.
    let svg = draw("[*] --> a\n a --> [*]\n state a {\n [*] --> b\n b --> [*]\n }");
    assert_eq!(svg.matches("pele-state-start").count(), 2);
    assert_eq!(svg.matches("pele-state-end").count(), 2);
    for id in ["root_start", "root_end", "a_start", "a_end"] {
        assert!(svg.contains(&format!(r#"data-id="{id}""#)));
    }
    assert_eq!(svg.matches(r#"class="pele-edge pele-transition""#).count(), 4);

    // Arriving and leaving transitions on same side stay separated.
    let svg = draw("Still --> Moving\n Moving --> Still");
    let re_tip = Regex::new(r#"class="pele-marker" d="M([-\d.]+),([-\d.]+)L"#).unwrap();
    let re_start = Regex::new(r#"<g class="pele-edge pele-transition"[^>]*><path d="M([-\d.]+),([-\d.]+)"#).unwrap();
    let tips: Vec<(f64, f64)> = re_tip.captures_iter(&svg).map(|c| (c[1].parse().unwrap(), c[2].parse().unwrap())).collect();
    let starts: Vec<(f64, f64)> = re_start.captures_iter(&svg).map(|c| (c[1].parse().unwrap(), c[2].parse().unwrap())).collect();
    assert_eq!(tips.len(), 2);
    assert_eq!(starts.len(), 2);
    for (tx, ty) in tips {
        let beside = starts.iter().find(|(_, sy)| (sy - ty).abs() < 1.0).expect("matching side start");
        assert!((beside.0 - tx).abs() >= 12.0);
    }

    // Choice diamond & fork/join bars across flow.
    let body =
        "state c <<choice>>\n state f <<fork>>\n state j <<join>>\n [*] --> f\n f --> x\n f --> y\n x --> j\n y --> j\n j --> c\n c --> p : yes\n c --> q : no";
    let down = draw(body);
    assert!(Regex::new(r#"pele-state-choice" data-id="c"[^>]*><polygon"#).unwrap().is_match(&down));
    assert!(!down.contains(">c</text>"));
    let (fw, fh) = rect_of(&down, "f");
    assert!(fw > fh * 4.0);
    assert!(down.contains(r#"pele-state-join" data-id="j""#));
    let across = draw(&format!("direction LR\n{body}"));
    let (fw, fh) = rect_of(&across, "f");
    assert!(fh > fw * 4.0);
    assert!(draw("state f [[fork]]\n f --> x").contains("pele-state-fork"));

    // Nested composites to depth 3.
    let svg = draw("[*] --> A\n state A {\n state B {\n state \"Deep name\" as C {\n x --> y\n }\n }\n }");
    assert_eq!(svg.matches("pele-state-composite").count(), 3);
    assert!(svg.contains(r#"class="pele-cluster-label""#));
    assert!(svg.contains(">Deep name</text>"));
    let (aw, ah) = rect_of(&svg, "A");
    let (bw, _) = rect_of(&svg, "B");
    let (cw, _) = rect_of(&svg, "C");
    assert!(aw > bw && bw > cw);
    assert!(ah > rect_of(&svg, "B").1);
    assert!(svg.find(r#"data-id="A""#).unwrap() < svg.find(r#"data-id="B""#).unwrap());

    // Per-composite direction independence.
    let svg = draw("state A {\n direction LR\n a1 --> a2\n }\n state B {\n b1 --> b2\n }\n A --> B");
    assert_eq!(place(&svg, "a1").1, place(&svg, "a2").1);
    assert!(place(&svg, "a1").0 < place(&svg, "a2").0);
    assert_eq!(place(&svg, "b1").0, place(&svg, "b2").0);

    let around = draw("direction LR\n state A {\n a1 --> a2\n }\n A --> z");
    assert_eq!(place(&around, "a1").0, place(&around, "a2").0);
    assert!(place(&around, "a1").1 < place(&around, "a2").1);
    assert!(place(&around, "z").1 > place(&around, "a1").1);
    assert!(place(&around, "z").1 < place(&around, "a2").1);

    // Concurrent regions with vertical, horizontal, and trailing dividers.
    let svg = draw("state A {\n [*] --> a1\n --\n [*] --> b1\n --\n [*] --> c1\n }");
    assert_eq!(svg.matches(r#"class="pele-divider""#).count(), 2);
    assert!(svg.contains(r#"stroke-dasharray="4 4""#));
    assert_eq!(svg.matches("pele-state-start").count(), 3);
    assert!(place(&svg, "a1").0 < place(&svg, "b1").0);
    assert!(place(&svg, "b1").0 < place(&svg, "c1").0);
    assert!(Regex::new(r#"class="pele-divider" d="M[\d.]+,[\d.]+V"#).unwrap().is_match(&svg));

    let stacked = draw("state A {\n a1\n --\n b1\n }\n a1 --> b1");
    assert!(Regex::new(r#"class="pele-divider" d="M[\d.]+,[\d.]+H"#).unwrap().is_match(&stacked));
    assert!(place(&stacked, "a1").1 < place(&stacked, "b1").1);

    let trailing = draw("state A {\n x\n --\n y\n --\n }");
    assert_eq!(trailing.matches(r#"class="pele-divider""#).count(), 1);
    assert!(place(&trailing, "x").0 < place(&trailing, "y").0);

    // Notes beside states (TB and LR, multiline, on composite).
    let svg = draw("a --> b\n note right of a : on the right\n note left of b\n first line\n second line\n end note");
    assert_eq!(svg.matches(r#"class="pele-note""#).count(), 2);
    assert_eq!(svg.matches("pele-note-edge").count(), 2);
    assert!(svg.contains(">on the right</text>"));
    assert!(svg.contains(">first line</tspan>"));
    assert!(svg.contains(">second line</tspan>"));
    assert!(place(&svg, "a----note-1").0 > place(&svg, "a").0);
    assert_eq!(place(&svg, "a----note-1").1, place(&svg, "a").1);
    assert!(place(&svg, "b----note-2").0 < place(&svg, "b").0);
    assert_eq!(place(&svg, "a").0, place(&svg, "b").0);

    let across = draw("direction LR\n a --> b\n note right of a : below\n note left of b : above");
    assert!(place(&across, "a----note-1").1 > place(&across, "a").1);
    assert!(place(&across, "b----note-2").1 < place(&across, "b").1);

    let on_composite = draw("state A {\n x --> y\n }\n note right of A : about A");
    assert!(on_composite.contains(">about A</text>"));
    assert_eq!(on_composite.matches("pele-note-edge").count(), 1);

    // Labels on self-transitions and across composite borders.
    let svg = draw("state A {\n in1 --> in2 : inner\n in2 --> in2 : again\n }\n out --> in1 : cross\n A --> A : whole\n A --> in1 : enter\n in2 --> A : leave");
    for label in ["inner", "again", "cross", "whole", "enter", "leave"] {
        assert!(svg.contains(&format!(">{label}</text>")), "missing label {label}");
    }
    assert_eq!(svg.matches(r#"class="pele-edge-label""#).count(), 6);
    assert_eq!(svg.matches(r#"class="pele-edge pele-transition""#).count(), 6);
    assert_eq!(svg.matches(r#"class="pele-marker""#).count(), 6);

    // Multiple self-transition labels kept apart.
    let label_y = |svg: &str, text: &str| -> f64 {
        let re = Regex::new(&format!(r#"y="([\d.]+)" text-anchor="middle">{text}<"#)).unwrap();
        re.captures(svg).unwrap()[1].parse().unwrap()
    };
    let down = draw("a --> a : one\n a --> a : two\n a --> b");
    assert!(label_y(&down, "two") - label_y(&down, "one") >= 20.0);
    let across = draw("direction LR\n a --> a : one\n a --> a : two\n a --> b");
    assert!(label_y(&across, "two") - label_y(&across, "one") >= 20.0);
    assert!(label_y(&across, "one") > place(&across, "a").1 + 22.0);

    // Initial state starts flow even when choice declared first.
    let svg = draw("state c <<choice>>\n [*] --> a\n a --> c\n c --> b\n b --> a");
    assert!(place(&svg, "root_start").1 < place(&svg, "a").1);
    assert!(place(&svg, "a").1 < place(&svg, "c").1);
    assert!(place(&svg, "c").1 < place(&svg, "b").1);
}

#[test]
fn state_styles_ink_casings_curves_links_markdown_math_and_config() {
    // Composite fill at full opacity when author sets fill.
    let svg = draw("state Busy {\n a\n }\n state Idle {\n b\n }\n classDef warm fill:#FFF9C4\n class Busy warm");
    let re_comp_rect = Regex::new(r#"<rect [^>]*fill="var\(--_a\)"[^>]*>"#).unwrap();
    let rects: Vec<&str> = re_comp_rect.find_iter(&svg).map(|m| m.as_str()).collect();
    assert_eq!(rects.iter().filter(|r| r.contains("fill:#FFF9C4")).count(), 1);
    assert!(!rects.iter().find(|r| r.contains("fill:#FFF9C4")).unwrap().contains("fill-opacity"));
    assert_eq!(rects.iter().filter(|r| r.contains(r#"fill-opacity="0.5""#)).count(), 1);

    // Contrasting label ink on styled fills (CSS and Resolved modes).
    let body = "direction TB\n classDef notMoving fill:white\n classDef badBadEvent fill:#f00,color:white,font-weight:bold\n [*] --> Still\n Still --> Moving\n Moving --> Crash\n class Still notMoving\n class Crash badBadEvent\n state \"Described\" as d : first line\n style d fill:#14201a\n state Busy {\n b\n }\n style Busy fill:#FFF9C4";
    let svg = draw(body);
    assert!(
        Regex::new(r#"data-id="Still"[^>]*><rect[^>]*\/><text class="pele-label" fill="var\(--pele-fg-on-light,#1f1f1f\)""#)
            .unwrap()
            .is_match(&svg)
    );
    assert!(
        Regex::new(r#"data-id="Crash"[^>]*><rect[^>]*\/><text class="pele-label" style="fill:white;font-weight:bold;""#)
            .unwrap()
            .is_match(&svg)
    );
    assert!(
        Regex::new(r#"data-id="Moving"[^>]*><rect[^>]*\/><text class="pele-label" x="#)
            .unwrap()
            .is_match(&svg)
    );
    assert!(
        Regex::new(r#"data-id="d"[^>]*><rect[^>]*\/><path[^>]*\/><text class="pele-label" fill="var\(--pele-fg-on-dark,#fff\)""#)
            .unwrap()
            .is_match(&svg)
    );
    assert!(
        Regex::new(r#"<text class="pele-state-description" font-size="\d+" fill="var\(--pele-fg-on-dark,#fff\)"[^>]*>first line<"#)
            .unwrap()
            .is_match(&svg)
    );
    assert!(
        Regex::new(r#"data-id="Busy">.*?<text class="pele-cluster-label" fill="var\(--pele-fg-on-light,#1f1f1f\)"[^>]*>Busy<"#)
            .unwrap()
            .is_match(&svg)
    );

    let res_svg = draw_resolved(body);
    assert_inert_resolved(&res_svg, "ink resolved");
    assert_resvg_parses(&res_svg, "ink resolved");
    assert!(res_svg.contains(r##"fill="#1f1f1f""##));
    assert!(res_svg.contains(r##"fill="#ffffff""##));

    // Casings on transitions crossing filled composite & ink on transitions inside it.
    let src = "state Busy {\n a --> b\n}\nstate Idle {\n c --> d\n}\nb --> e\ne --> c\nstyle Busy fill:#FFF9C4";
    let svg = draw(src);
    let casings = Regex::new(r#"<g class="pele-casings"[^>]*>(.*?)</g>"#).unwrap().captures(&svg).unwrap()[1].to_string();
    let group_of = |id: &str| -> String {
        Regex::new(&format!(r#"<g class="pele-edge[^"]*"[^>]* data-id="{id}">.*?</g>"#))
            .unwrap()
            .find(&svg)
            .unwrap()
            .as_str()
            .to_string()
    };
    let edge_d = |id: &str| -> String {
        let g = group_of(id);
        Regex::new(r#"<path d="([^"]+)""#).unwrap().captures(&g).unwrap()[1].to_string()
    };
    assert!(group_of("edge0").contains(r#"class="pele-edge pele-transition" stroke="var(--pele-fg-on-light,#1f1f1f)""#));
    assert!(group_of("edge0").contains(r#"fill="var(--pele-fg-on-light,#1f1f1f)""#));
    assert!(!casings.contains(&edge_d("edge0")));
    assert!(casings.contains(&format!(r#"<path d="{}"/>"#, edge_d("edge2"))));
    assert!(!group_of("edge2").contains("--pele-fg-on"));
    assert!(!casings.contains(&edge_d("edge3")));
    let plain = draw(&src.replace("\nstyle Busy fill:#FFF9C4", ""));
    assert!(!plain.contains("pele-casings"));
    assert!(!plain.contains(r#"stroke="var(--pele-fg-on"#));

    // Curves from flowchart.curve (linear, step, stepBefore, stepAfter) + ignoring state.curve.
    let re_linear = Regex::new(r"^M[-\d.]+,[-\d.]+(?:L[-\d.]+,[-\d.]+)+$").unwrap();
    let re_step = Regex::new(r"^M[-\d.]+,[-\d.]+(?:L[-\d.]+,[-\d.]+|Q[-\d.]+,[-\d.]+ [-\d.]+,[-\d.]+)+$").unwrap();
    let re_trans = Regex::new(r#"<g class="pele-edge pele-transition"[^>]*><path d="([^"]+)""#).unwrap();
    let re_tip = Regex::new(r#"class="pele-marker" d="M([-\d.]+),([-\d.]+)L"#).unwrap();
    let re_end = Regex::new(r"([-\d.]+),([-\d.]+)$").unwrap();

    let re_smooth = Regex::new(r#"<g class="pele-edge pele-transition"[^>]*><path d="[^"]*C"#).unwrap();
    for dir in ["TB", "LR"] {
        let body = format!("direction {dir}\n state A {{\n a --> b\n a --> c\n }}\n out --> a\n A --> out");
        let smooth = draw(&body);
        assert!(re_smooth.is_match(&smooth));
        for curve in ["linear", "step", "stepBefore", "stepAfter"] {
            let full = format!("---\nconfig:\n  flowchart:\n    curve: {curve}\n---\nstateDiagram-v2\n{body}");
            let svg = render(&full, &css_options()).unwrap().svg;
            assert_ne!(svg, smooth);
            assert_well_formed(&svg).unwrap();
            let paths: Vec<String> = re_trans.captures_iter(&svg).map(|c| c[1].to_string()).collect();
            assert_eq!(paths.len(), 4);
            if curve != "linear" {
                assert!(paths.iter().any(|d| d.contains('Q')));
            }
            for d in &paths {
                let re = if curve == "linear" { &re_linear } else { &re_step };
                assert!(re.is_match(d), "curve={curve} dir={dir} d={d}");
            }
            let tips: Vec<(f64, f64)> = re_tip.captures_iter(&svg).map(|c| (c[1].parse().unwrap(), c[2].parse().unwrap())).collect();
            assert_eq!(tips.len(), 4);
            for (k, d) in paths.iter().enumerate() {
                let end = re_end.captures(d).unwrap();
                let ex: f64 = end[1].parse().unwrap();
                let ey: f64 = end[2].parse().unwrap();
                assert_close((tips[k].0 - ex).hypot(tips[k].1 - ey), 7.0, 0.1, "arrowhead trim");
            }
        }
    }

    // Stepped arrowheads stay aligned with flow.
    let re_marker = Regex::new(r#"class="pele-marker" d="M[-\d.]+,[-\d.]+L([-\d.]+),([-\d.]+)L([-\d.]+),([-\d.]+)Z""#).unwrap();
    for dir in ["TB", "LR"] {
        for curve in ["step", "stepBefore", "stepAfter"] {
            let src = format!(
                "---\nconfig:\n  flowchart:\n    curve: {curve}\n---\nstateDiagram-v2\n direction {dir}\n A --> B\n A --> C\n A --> D\n B --> E\n C --> E\n D --> E\n E --> F : Yes\n E --> A : No"
            );
            let svg = render(&src, &css_options()).unwrap().svg;
            let markers: Vec<_> = re_marker.captures_iter(&svg).collect();
            assert_eq!(markers.len(), 8);
            for m in markers {
                let a: f64 = m[if dir == "TB" { 2 } else { 1 }].parse().unwrap();
                let b: f64 = m[if dir == "TB" { 4 } else { 3 }].parse().unwrap();
                assert_close(a, b, 1e-5, "marker alignment");
            }
        }
    }

    // Ignores state.curve and unknown/non-string flowchart.curve; self-loops stay curved.
    let body = "a --> b\n a --> c\n b --> d\n c --> d";
    let state_curve = render(
        &format!("---\nconfig:\n  state:\n    curve: step\n---\nstateDiagram-v2\n{body}"),
        &css_options(),
    )
    .unwrap()
    .svg;
    assert_eq!(state_curve, draw(body));

    for curve in ["basis", "unknown", "stepUnknown", "42", "true", "null", "{}"] {
        let svg = render(
            &format!("---\nconfig:\n  flowchart:\n    curve: {curve}\n---\nstateDiagram-v2\n{body}"),
            &css_options(),
        )
        .unwrap()
        .svg;
        assert_eq!(svg, draw(body), "curve={curve}");
    }

    for curve in ["linear", "basis", "step", "stepBefore", "stepAfter"] {
        let svg = render(
            &format!("---\nconfig:\n  flowchart:\n    curve: {curve}\n---\nstateDiagram-v2\na --> a : again"),
            &css_options(),
        )
        .unwrap()
        .svg;
        assert_eq!(svg, draw("a --> a : again"));
        assert_eq!(svg.matches(r#"class="pele-marker""#).count(), 1);
    }

    // classDef / class / ::: / style rendering.
    let svg = draw(
        "classDef hot fill:#f00,color:white,font-weight:bold\n classDef cool stroke:#00f\n a:::cool --> b\n class b hot\n style c fill:#0f0,stroke-width:4px\n b --> c\n state G {\n g1\n }\n class G cool",
    );
    assert!(
        Regex::new(r#"class="pele-node pele-state cool" data-id="a"[^>]*><rect[^>]* style="stroke:#00f;""#)
            .unwrap()
            .is_match(&svg)
    );
    assert!(
        Regex::new(r#"class="pele-node pele-state hot" data-id="b"[^>]*><rect[^>]* style="fill:#f00;""#)
            .unwrap()
            .is_match(&svg)
    );
    assert!(
        Regex::new(r#"data-id="b"[^>]*><rect[^>]*\/><text class="pele-label" style="fill:white;font-weight:bold;""#)
            .unwrap()
            .is_match(&svg)
    );
    assert!(
        Regex::new(r#"data-id="c"[^>]*><rect[^>]* style="fill:#0f0;stroke-width:4px;""#)
            .unwrap()
            .is_match(&svg)
    );
    assert!(
        Regex::new(r#"class="pele-cluster pele-state-composite cool" data-id="G"><rect[^>]* style="stroke:#00f;""#)
            .unwrap()
            .is_match(&svg)
    );

    // click links & URL sanitization.
    let result = render(
        "stateDiagram-v2\n a --> b\n b --> c\n click a \"https://example.com/x\" \"Go there\"\n click b href \"https://example.org\"\n click c \"javascript:alert(1)\" \"no\"\n",
        &css_options(),
    )
    .unwrap();
    assert!(
        result
            .svg
            .contains(r#"<a href="https://example.com/x" target="_blank" rel="noopener"><title>Go there</title>"#)
    );
    assert!(result.svg.contains(r#"<a href="https://example.org/" target="_blank" rel="noopener">"#));
    assert_eq!(result.svg.matches("<a ").count(), 2);
    assert!(result.svg.contains("<title>no</title>"));
    assert_eq!(
        result.links,
        vec![
            LinkInfo {
                id: "a".to_string(),
                href: "https://example.com/x".to_string(),
                internal: false,
            },
            LinkInfo {
                id: "b".to_string(),
                href: "https://example.org/".to_string(),
                internal: false,
            },
        ]
    );

    // Accessible title and description.
    let svg = draw("accTitle: The title\n accDescr: The description\n a --> b");
    assert!(svg.contains(r#"<title id="pele-title">The title</title>"#));
    assert!(svg.contains(r#"<desc id="pele-desc">The description</desc>"#));
    assert!(draw("accDescr {\n several\n lines\n }\n a --> b").contains("<desc id=\"pele-desc\">several\nlines</desc>"));

    // No-op statements & comments.
    let plain = draw("a --> b");
    assert_eq!(draw("hide empty description\n scale 350 width\n a --> b"), plain);
    assert_eq!(draw("%% a comment\n a --> b %% trailing"), plain);

    // Markdown, entities, and line breaks.
    let svg = draw("a : **bold** and *italic*\n a --> b : one<br>two\n b : x #35; y");
    assert!(svg.contains(r#"font-weight="var(--_w)">bold</tspan>"#));
    assert!(svg.contains(r#"font-style="italic">italic</tspan>"#));
    assert!(svg.contains(">one</tspan>"));
    assert!(svg.contains(">x # y</text>"));

    // Mermaid quirks.
    assert!(!draw("state lonely\n a --> b").contains("lonely"));
    assert!(draw("a --> c\n state c <<choice>>").contains(">c</text>"));
    assert_eq!(model("note right of a:text").states["a"].note.as_ref().unwrap().text, "ext");
    let moved = model("state A {\n a1\n }\n state B {\n b1 --> a1\n }");
    assert_eq!(moved.graph.nodes.iter().find(|n| n.id == "a1").unwrap().parent_id.as_deref(), Some("B"));

    // Rejected inputs.
    assert!(
        render("stateDiagram-v2\n state two words {\n a\n }", &css_options())
            .unwrap_err()
            .message
            .contains("Error: State name must be a single word.")
    );
    assert!(
        render("stateDiagram-v2\n state A {\n x\n }\n A : one\n A : two", &css_options())
            .unwrap_err()
            .message
            .contains("Group nodes can only have label.")
    );
    assert_eq!(render("stateDiagram-v2\n a --> b --> c", &css_options()).unwrap_err().code, ErrorCode::Syntax);
    assert_eq!(
        render("stateDiagram-v2\n classDef default fill:red", &css_options()).unwrap_err().code,
        ErrorCode::Syntax
    );
    assert!(
        render("stateDiagram-v2\n state A {\n x --> y", &css_options())
            .unwrap_err()
            .message
            .contains("Parse error on line")
    );
    assert!(
        render("stateDiagram-v2\n scale 350\n a --> b", &css_options())
            .unwrap_err()
            .message
            .contains("Lexical error on line 2")
    );

    // Exposed parsed model.
    let parsed = model("direction LR\n [*] --> a\n a --> b : go\n classDef c fill:red\n class a c\n click a \"https://example.com\" \"tip\"\n");
    assert_eq!(parsed.direction(), "LR");
    let state_keys: Vec<&str> = parsed.states.keys().map(String::as_str).collect();
    assert_eq!(state_keys, vec!["root_start", "a", "b"]);
    assert_eq!(parsed.relations.len(), 2);
    assert_eq!(parsed.relations[0].id1, "root_start");
    assert_eq!(parsed.relations[0].id2, "a");
    assert_eq!(parsed.relations[0].relation_title, "");
    assert_eq!(parsed.relations[1].id1, "a");
    assert_eq!(parsed.relations[1].id2, "b");
    assert_eq!(parsed.relations[1].relation_title, "go");
    assert_eq!(parsed.states["a"].classes, vec!["c"]);
    assert_eq!(parsed.classes["c"].styles, vec!["fill:red"]);
    assert_eq!(parsed.links["a"].url, "\"https://example.com\"");
    assert_eq!(parsed.links["a"].tooltip, "\"tip\"");

    // Math typesetting (all 5 slots) and plain diagram title.
    {
        let resolver = |tex: &str, _size: f64| -> Option<MathSvg> {
            Some(MathSvg {
                svg: format!(r#"<text data-tex="{tex}">m</text>"#),
                width: 24.0,
                height: 20.0,
            })
        };
        let src = "stateDiagram-v2\n  state \"$$a$$\" as s1\n  s1 : $$b$$\n  [*] --> s1 : $$c$$\n  note right of s1 : $$d$$\n  state \"$$e$$\" as C {\n    x --> y\n  }";
        let mut opts = css_options();
        opts.math = Some(&resolver);
        let svg = render(src, &opts).unwrap().svg;
        for sym in ["a", "b", "c", "d", "e"] {
            assert!(svg.contains(&format!(r#"data-tex="{sym}""#)), "missing math slot {sym}");
        }

        // Diagram title is NOT passed through math resolver.
        let title_src = "---\ntitle: $$t$$\n---\nstateDiagram-v2\n  [*] --> s1";
        let title_svg = render(title_src, &opts).unwrap().svg;
        assert!(title_svg.contains(">$$t$$<"), "title_svg={title_svg}");
        assert!(!title_svg.contains("pele-math"));
    }

    // max_width auto-direction turn-to-fit (LR -> TB).
    let lr_src = "stateDiagram-v2\n  direction LR\n  [*] --> Drafting\n  Drafting --> Reviewing\n  Reviewing --> Publishing\n  Publishing --> Archiving\n  Archiving --> [*]";
    let wide = render(lr_src, &css_options()).unwrap();
    let mut narrow_opts = css_options();
    narrow_opts.max_width = Some(360.0);
    let turned = render(lr_src, &narrow_opts).unwrap();
    assert!(turned.width < wide.width);
    assert!(turned.height > wide.height);

    // State config options (nodeSpacing, rankSpacing, wrappingWidth, useMaxWidth).
    let wide_rank = render(
        "---\nconfig:\n  state:\n    rankSpacing: 120\n    nodeSpacing: 100\n    useMaxWidth: false\n---\nstateDiagram-v2\n  a --> b\n  a --> c",
        &css_options(),
    )
    .unwrap();
    let normal = render("stateDiagram-v2\n  a --> b\n  a --> c", &css_options()).unwrap();
    assert!(wide_rank.height > normal.height);
    assert!(wide_rank.width > normal.width);
    assert!(!wide_rank.svg.contains("max-width:100%"));
}

#[test]
fn state_security_hostile_payloads_and_links() {
    let templates: Vec<fn(&str) -> String> = vec![
        |p| format!("stateDiagram-v2\n  {p} --> b"),
        |p| format!("stateDiagram-v2\n  a --> {p}"),
        |p| format!("stateDiagram-v2\n  {p}"),
        |p| format!("stateDiagram-v2\n  a : {p}"),
        |p| format!("stateDiagram-v2\n  a : title\n  a : {p}\n  a : {p}"),
        |p| format!("stateDiagram-v2\n  a --> b : {p}"),
        |p| format!("stateDiagram-v2\n  a --> a : {p}"),
        |p| format!("stateDiagram-v2\n  state \"{p}\" as a\n  a --> b"),
        |p| format!("stateDiagram-v2\n  state \"x\" as {p}\n"),
        |p| format!("stateDiagram-v2\n  state \"x\" as a:{p}\n"),
        |p| format!("stateDiagram-v2\n  state {p} {{\n  a --> b\n  }}"),
        |p| format!("stateDiagram-v2\n  state \"{p}\" as c {{\n  a --> b\n  }}\n  c --> c : {p}"),
        |p| format!("stateDiagram-v2\n  state c {{\n  a --> b : {p}\n  --\n  {p} --> d\n  }}\n  c --> a : {p}"),
        |p| format!("stateDiagram-v2\n  state {p} <<fork>>\n  state {p} <<join>>\n  [*] --> {p}"),
        |p| format!("stateDiagram-v2\n  state {p} <<choice>>\n  a --> {p}"),
        |p| format!("stateDiagram-v2\n  state {p} [[choice]]\n"),
        |p| format!("stateDiagram-v2\n  a --> b\n  note right of a : {p}"),
        |p| format!("stateDiagram-v2\n  a --> b\n  note left of a\n  {p}\n  {p}\n  end note"),
        |p| format!("stateDiagram-v2\n  note right of {p} : text"),
        |p| format!("stateDiagram-v2\n  a --> b\n  note \"{p}\" as {p}"),
        |p| format!("stateDiagram-v2\n  a:::{p} --> b"),
        |p| format!("stateDiagram-v2\n  [*]:::{p} --> b:::{p}"),
        |p| format!("stateDiagram-v2\n  a --> b\n  class a {p}"),
        |p| format!("stateDiagram-v2\n  a --> b\n  class a,{p} c"),
        |p| format!("stateDiagram-v2\n  a --> b\n  classDef {p} fill:red\n  class a {p}"),
        |p| format!("stateDiagram-v2\n  a --> b\n  classDef c fill:{p}\n  class a c"),
        |p| format!("stateDiagram-v2\n  a --> b\n  classDef c {p}:red,color:{p},font-family:{p},stroke:{p}\n  class a c"),
        |p| format!("stateDiagram-v2\n  state g {{\n  a --> b\n  }}\n  classDef c fill:{p},stroke:{p},color:{p}\n  class g c"),
        |p| format!("stateDiagram-v2\n  a --> b\n  style a fill:{p}"),
        |p| format!("stateDiagram-v2\n  a --> b\n  style a {p}:red"),
        |p| format!("stateDiagram-v2\n  a --> b\n  style a,{p} color:{p},stroke:{p},font-size:{p}"),
        |p| format!("stateDiagram-v2\n  a --> b\n  click a \"{p}\" \"{p}\"\n"),
        |p| format!("stateDiagram-v2\n  a --> b\n  click a href \"{p}\"\n"),
        |p| format!("stateDiagram-v2\n  state a {{\n  x\n  }}\n  click a \"{p}\" \"{p}\"\n"),
        |p| format!("stateDiagram-v2\n  {p} --> b\n  click {p} \"https://example.com\" \"{p}\"\n"),
        |p| format!("stateDiagram-v2\n  accTitle: {p}\n  accDescr: {p}\n  a --> b"),
        |p| format!("stateDiagram-v2\n  accDescr {{\n {p}\n }}\n  a --> b"),
        |p| format!("stateDiagram-v2\n  direction {p}\n  a --> b"),
        |p| format!("stateDiagram-v2\n  direction LR {p}\n  a --> b"),
        |p| format!("stateDiagram-v2\n  scale {p} width\n  a --> b"),
        |p| format!("stateDiagram-v2\n  hide empty description {p}\n  a --> b"),
        |p| format!("stateDiagram-v2\n  %% {p}\n  a --> b %% {p}"),
        |p| format!("stateDiagram-v2\n  a --> b # {p}"),
        |p| format!("stateDiagram {p}\n  a --> b"),
        |p| format!("---\ntitle: \"{p}\"\nconfig:\n  state:\n    nodeSpacing: \"{p}\"\n    wrappingWidth: \"{p}\"\n---\nstateDiagram-v2\n  a --> b"),
        |p| format!("%%{{init: {{\"state\": {{\"rankSpacing\": \"{p}\"}}, \"themeVariables\": {{\"fontFamily\": \"{p}\"}}}}}}%%\nstateDiagram-v2\n  a --> b"),
    ];

    let mut rendered = 0usize;
    for template in &templates {
        for payload in PAYLOADS {
            let src = template(payload);
            if let Ok(r) = render(&src, &css_options()) {
                rendered += 1;
                let where_ctx: String = src.chars().take(160).collect();
                assert_inert(&r.svg, &where_ctx);
                let res = render(&src, &resolved_options()).expect("resolved mode should match css mode");
                assert_inert_resolved(&res.svg, &where_ctx);
            }
        }
    }
    assert!(rendered > 500, "expected >500 rendered hostile templates, got {rendered}");

    // Hostile option values.
    for payload in PAYLOADS {
        let mut opts = css_options();
        opts.id_prefix = Some((*payload).to_string());
        opts.font_family = Some((*payload).to_string());
        let r = render("stateDiagram-v2\n  accTitle: t\n  a --> b", &opts).unwrap();
        assert_inert(&r.svg, payload);

        let mut ropts = resolved_options();
        ropts.id_prefix = Some((*payload).to_string());
        ropts.font_family = Some((*payload).to_string());
        let rr = render("stateDiagram-v2\n  accTitle: t\n  a --> b", &ropts).unwrap();
        assert_inert_resolved(&rr.svg, payload);
        assert_resvg_parses(&rr.svg, payload);
    }

    // Never emits a script-capable link.
    for url in [
        "javascript:alert(1)",
        " JaVaScRiPt:alert(1)",
        "data:text/html,x",
        "vbscript:x",
        "jav#9;ascript:alert(1)",
        "#106;avascript#colon;alert(1)",
    ] {
        let r = render(&format!("stateDiagram-v2\n  a --> b\n  click a \"{url}\" \"t\"\n"), &css_options()).unwrap();
        assert!(!r.svg.contains("<a "), "script link leaked for {url}");
        assert!(r.links.is_empty(), "links non-empty for {url}");
    }

    // Prototype-key names render cleanly.
    for src in [
        "stateDiagram-v2\n  __proto__ --> constructor\n  constructor --> toString\n  class __proto__ constructor\n  classDef constructor fill:red",
        "stateDiagram-v2\n  state __proto__ {\n  hasOwnProperty --> valueOf\n  }\n  note right of __proto__ : x\n  style __proto__ fill:red",
        "stateDiagram-v2\n  state \"x\" as __proto__:polluted\n  click __proto__ \"x\" \"y\"\n",
    ] {
        let r = render(src, &resolved_options()).unwrap();
        assert_inert_resolved(&r.svg, src);
        assert_resvg_parses(&r.svg, src);
    }
}

#[test]
fn state_mutated_fuzz_oracle_and_security() {
    let corpus = load_fixture("state-corpus.json");

    // Lexer edge-case token checks matching Jison oracle.
    let toks = tokenize("stateDiagram-v2\ndirection\nTB\n");
    assert!(toks.types.contains(&StateToken::DirectionTb));

    let toks = tokenize("stateDiagram-v2\nstate f <<fork>>\nstate j [[join]]\nstate c [[choice]]\n");
    assert!(toks.types.contains(&StateToken::Fork));
    assert!(toks.types.contains(&StateToken::Join));
    assert!(toks.types.contains(&StateToken::Choice));

    // Mutated inputs with oracle grammar fragments + security payloads.
    let mut fragments: Vec<&str> = PAYLOADS.to_vec();
    fragments.extend_from_slice(&[
        " ",
        "\n",
        "\n\n",
        "\t",
        "\r\n",
        "\r",
        "\u{2028}",
        "\u{00a0}",
        " \n",
        ";",
        ":",
        "::",
        ":::",
        " : ",
        "-->",
        "--",
        "-",
        "->",
        "[*]",
        "[*] --> ",
        " --> [*]",
        "{",
        "}",
        " {\n",
        "\n}\n",
        "{ ",
        " }",
        "\"",
        "\"\"",
        "\"a b\"",
        "%%",
        "%%{",
        "%% c\n",
        "#",
        "# c",
        "state ",
        "state",
        "State ",
        "STATE ",
        "state \"",
        "\" as ",
        " as ",
        "as ",
        "as",
        "AS ",
        "note ",
        "note",
        "Note ",
        "note left of ",
        "note right of ",
        "left of",
        "right of ",
        "end note",
        "\nend note",
        "\n  end note\n",
        "End Note",
        "note \"",
        "<<fork>>",
        "<<join>>",
        "<<choice>>",
        "[[fork]]",
        "[[join]]",
        "[[choice]]",
        " <<FORK>>",
        "<<",
        ">>",
        "direction ",
        "direction TB",
        "direction BT",
        "direction RL",
        "direction LR",
        "Direction lr",
        "direction\nTB",
        "direction TD",
        "direction",
        "TB",
        "LR",
        "scale ",
        "scale 350 width",
        " width",
        "width",
        "350",
        "accTitle: ",
        "accDescr: ",
        "accDescr { ",
        "accDescr {\n",
        "acctitle : ",
        "classDef ",
        "classDef c fill:#f00",
        "classdef ",
        "class ",
        "class a,b c",
        "Class ",
        "style ",
        "style a fill:#f00",
        "Style ",
        "default",
        "default ",
        "DEFAULT ",
        "click ",
        "click a \"u\" \"t\"",
        "click a href \"u\"",
        "href ",
        "href",
        "hide empty description",
        "Hide Empty Description",
        "hide empty",
        "stateDiagram",
        "stateDiagram ",
        "stateDiagram-v2",
        "stateDiagram-v2\n",
        "STATEDIAGRAM\n",
        "a",
        "b",
        "S1",
        "id_1",
        "nl",
        "é",
        "ö",
        "1",
        ",",
        ", ",
        "fill:#f9f",
        "stroke-width:2px",
        "a:b",
        "a::b",
        "x%%y",
        "x%%{y",
        " %%",
        ".",
        "*",
        "[",
        "]",
        "<",
        ">",
        "/",
        "\\",
        "(",
        ")",
    ]);

    let mut mutator = Mutator::new(&corpus, fragments, 3);
    let mut rendered = 0usize;
    for _ in 0..800 {
        let src = mutator.next_sample();
        if src.len() > 4000 {
            continue;
        }
        // Lexer must never panic on any mutated UTF-8 input.
        let _ = tokenize(&src);
        if let Ok(r) = render(&src, &css_options()) {
            rendered += 1;
            let where_ctx: String = src.chars().take(120).collect();
            assert_inert(&r.svg, &where_ctx);
            let res = render(&src, &resolved_options()).expect("resolved mode failed where css succeeded");
            assert_inert_resolved(&res.svg, &where_ctx);
            assert_resvg_parses(&res.svg, &where_ctx);
        }
    }
    assert!(rendered > 100, "expected >100 mutated samples to render, got {rendered}");
}

#[test]
fn state_stress_worst_cases() {
    const N: usize = 50_000;
    let head = "stateDiagram-v2\n";
    let big_render = |src: &str| {
        let mut opts = css_options();
        opts.limit = Some(usize::MAX);
        opts.output_limit = Some(usize::MAX);
        opts.max_edges = Some(usize::MAX);
        let _ = render(src, &opts);
    };
    let big_parse = |src: &str| {
        let opts = ParseOptions {
            limit: Some(usize::MAX),
            max_edges: Some(usize::MAX),
            config: None,
        };
        let _ = parse(src, &opts);
    };

    let repeat_fn = |count: usize, f: fn(usize) -> String| -> String { (0..count).map(f).collect() };

    type StressCase = (&'static str, Box<dyn FnOnce()>);
    let cases: Vec<StressCase> = vec![
        (
            "the same class statement and transitions 1,500 times",
            Box::new(move || {
                let s = format!(
                    "{head}classDef hot fill:#f00,color:white,font-weight:bold,stroke-width:2px,stroke:yellow\n{}",
                    "A --> B\nB --> A\nclass A hot\n".repeat(1500)
                );
                big_render(&s);
            }),
        ),
        (
            "one line that mentions direction 3,000 times",
            Box::new(move || {
                let _ = tokenize(&format!("{head}{}", "a direction XX ".repeat(N / 15)));
            }),
        ),
        (
            "one line of valid directions",
            Box::new(move || {
                let _ = tokenize(&format!("{head}{}", "direction TB direction lr ".repeat(N / 26)));
            }),
        ),
        (
            "direction followed by blank lines, 2,000 times",
            Box::new(move || {
                let _ = tokenize(&format!("{head}{}", format!("direction{}", "\n".repeat(24)).repeat(N / 33)));
            }),
        ),
        (
            "directions at the end of a long line of tokens",
            Box::new(move || {
                let _ = tokenize(&format!("{head}{}direction TB", "a b ".repeat(N / 4)));
            }),
        ),
        (
            "unterminated string after many tokens",
            Box::new(move || {
                let _ = tokenize(&format!("{head}{}\"{}", "a ".repeat(N / 2), "b ".repeat(N / 2)));
            }),
        ),
        (
            "stereotype look-alikes on one state line",
            Box::new(move || {
                let _ = tokenize(&format!("{head}state {}", "<<fork> [[join] ".repeat(N / 16)));
            }),
        ),
        (
            "stereotypes on one state line",
            Box::new(move || {
                let _ = tokenize(&format!("{head}state {}", "x <<choice>> ".repeat(N / 13)));
            }),
        ),
        (
            "state keyword 8,000 times",
            Box::new(move || {
                let _ = tokenize(&format!("{head}{}", "state ".repeat(N / 6)));
            }),
        ),
        (
            "state name followed by spaces",
            Box::new(move || {
                let _ = tokenize(&format!("{head}state a{}b", " ".repeat(N)));
            }),
        ),
        (
            "state names with no brace on the line",
            Box::new(move || {
                let _ = tokenize(&format!("{head}state {}", "w ".repeat(N / 2)));
            }),
        ),
        (
            "state names with a brace far along the line",
            Box::new(move || {
                let _ = tokenize(&format!("{head}{}state {} x {{", "state a\n".repeat(2000), "w".repeat(N / 2)));
            }),
        ),
        (
            "ids made of comment markers",
            Box::new(move || {
                let _ = tokenize(&format!("{head}{}", "a%%{".repeat(N / 4)));
            }),
        ),
        (
            "alias made of comment markers",
            Box::new(move || {
                let _ = tokenize(&format!("{head}state \"x\" as {}", "%%{".repeat(N / 3)));
            }),
        ),
        (
            "note that never ends, over blank lines",
            Box::new(move || {
                let _ = tokenize(&format!("{head}note right of a\n{}", "\n ".repeat(N / 2)));
            }),
        ),
        (
            "note with near-miss endings",
            Box::new(move || {
                let _ = tokenize(&format!("{head}note right of a\n{}", " end not\n".repeat(N / 9)));
            }),
        ),
        (
            "note id after a run of spaces",
            Box::new(move || {
                let _ = tokenize(&format!("{head}note left of{}: x", " ".repeat(N)));
            }),
        ),
        (
            "floating note of spaces",
            Box::new(move || {
                let _ = tokenize(&format!("{head}note \"{}x\" as n", " ".repeat(N)));
            }),
        ),
        (
            "class statement with dangling commas",
            Box::new(move || {
                let _ = tokenize(&format!("{head}class a{}", ", ".repeat(N / 2)));
            }),
        ),
        (
            "description of colons",
            Box::new(move || {
                let _ = tokenize(&format!("{head}a {}", ":x".repeat(N / 2)));
            }),
        ),
        (
            "runs of dashes and colons",
            Box::new(move || {
                let _ = tokenize(&format!("{head}{}{}", "-".repeat(N / 2), ":".repeat(N / 2)));
            }),
        ),
        (
            "unclosed accDescr block",
            Box::new(move || {
                big_parse(&format!("{head}accDescr {{{}", "x ".repeat(N / 2)));
            }),
        ),
        (
            "accTitle followed by spaces",
            Box::new(move || {
                let _ = tokenize(&format!("{head}accTitle{}x", " ".repeat(N)));
            }),
        ),
        (
            "scale followed by spaces",
            Box::new(move || {
                let _ = tokenize(&format!("{head}scale 1{}x", " ".repeat(N)));
            }),
        ),
        (
            "6,000 nested composites",
            Box::new(move || {
                big_parse(&format!("{head}{}{}", "state s{\n".repeat(6000), "}\n".repeat(6000)));
            }),
        ),
        (
            "3,000 nested composites, rendered",
            Box::new(move || {
                big_render(&format!(
                    "{head}{}a-->b\n{}",
                    repeat_fn(3000, |i| format!("state s{i}{{\n")),
                    "}\n".repeat(3000)
                ));
            }),
        ),
        (
            "2,500 nested composites, each split in two",
            Box::new(move || {
                big_render(&format!(
                    "{head}{}a\n{}",
                    repeat_fn(2500, |i| format!("state s{i}{{\nx{i}\n--\n")),
                    "}\n".repeat(2500)
                ));
            }),
        ),
        (
            "5,000 sibling composites",
            Box::new(move || {
                big_render(&format!("{head}{}", repeat_fn(5000, |i| format!("state s{i}{{\n}}\n"))));
            }),
        ),
        (
            "one composite with 8,000 regions",
            Box::new(move || {
                big_render(&format!("{head}state s{{\n{}z\n}}\n", repeat_fn(8000, |i| format!("a{i}\n--\n"))));
            }),
        ),
        (
            "chain of 5,000",
            Box::new(move || {
                big_render(&format!("{head}{}", repeat_fn(5000, |i| format!("n{i}-->n{}\n", i + 1))));
            }),
        ),
        (
            "star of 5,000",
            Box::new(move || {
                big_render(&format!("{head}{}", repeat_fn(5000, |i| format!("c-->n{i}\n"))));
            }),
        ),
        (
            "fork with 5,000 branches",
            Box::new(move || {
                big_render(&format!("{head}state f <<fork>>\n{}", repeat_fn(5000, |i| format!("f-->n{i}\n"))));
            }),
        ),
        (
            "complete graph of 60",
            Box::new(move || {
                let mut s = head.to_string();
                for i in 0..60 {
                    for j in (i + 1)..60 {
                        s.push_str(&format!("n{i}-->n{j}\n"));
                    }
                }
                big_render(&s);
            }),
        ),
        (
            "3,000 parallel transitions and 3,000 self-transitions",
            Box::new(move || {
                big_render(&format!("{head}{}{}", "a-->b\n".repeat(3000), "a-->a\n".repeat(3000)));
            }),
        ),
        (
            "4,000 start and end states",
            Box::new(move || {
                big_render(&format!("{head}{}", "[*]-->[*]\n".repeat(N / 12)));
            }),
        ),
        (
            "2,500 notes on one state",
            Box::new(move || {
                big_render(&format!(
                    "{head}{}",
                    repeat_fn(2500, |i| format!("note {} of a:n\n", if i % 2 == 1 { "left" } else { "right" }))
                ));
            }),
        ),
        (
            "2,000 states with a note each",
            Box::new(move || {
                big_render(&format!("{head}{}", repeat_fn(2000, |i| format!("note right of s{i}:n\n"))));
            }),
        ),
        (
            "8,000 description lines on one state",
            Box::new(move || {
                big_render(&format!("{head}{}", "a:x\n".repeat(N / 4)));
            }),
        ),
        (
            "one 50,000 character description",
            Box::new(move || {
                big_render(&format!("{head}a : {}", "word ".repeat(N / 5)));
            }),
        ),
        (
            "one 50,000 character note",
            Box::new(move || {
                big_render(&format!("{head}note right of a\n{}end note\n", "word *b _c\n".repeat(N / 11)));
            }),
        ),
        (
            "one 50,000 character transition label",
            Box::new(move || {
                big_render(&format!("{head}a --> b : {}", "#35;<br>x ".repeat(N / 10)));
            }),
        ),
        (
            "one 50,000 character composite title",
            Box::new(move || {
                big_render(&format!("{head}state \"{}\" as s {{\na\n}}\n", "w ".repeat(N / 2)));
            }),
        ),
        (
            "5,000 class statements for one state",
            Box::new(move || {
                big_render(&format!("{head}a\n{}", repeat_fn(5000, |i| format!("class a c{i}\n"))));
            }),
        ),
        (
            "class statement naming 8,000 states",
            Box::new(move || {
                big_render(&format!("{head}class {}z c\n", repeat_fn(8000, |i| format!("s{i},"))));
            }),
        ),
        (
            "classDef with 8,000 declarations",
            Box::new(move || {
                big_render(&format!("{head}a\nclassDef c {}x\nclass a c\n", "fill:red,".repeat(N / 9)));
            }),
        ),
        (
            "3,000 style statements",
            Box::new(move || {
                big_render(&format!("{head}a-->b\n{}", "style a,b fill:red\n".repeat(3000)));
            }),
        ),
        (
            "3,000 click statements",
            Box::new(move || {
                big_render(&format!("{head}a-->b\n{}", "click a \"u\" \"t\"\n".repeat(3000)));
            }),
        ),
        (
            "link of nested entity codes",
            Box::new(move || {
                big_render(&format!("{head}a\nclick a \"&{}x\" \"t\"\n", "#38;".repeat(N / 4)));
            }),
        ),
        (
            "transitions from 1,500 levels out to the innermost state",
            Box::new(move || {
                big_render(&format!(
                    "{head}{}z\n{}{}",
                    repeat_fn(1500, |i| format!("state s{i}{{\n")),
                    "}\n".repeat(1500),
                    repeat_fn(1500, |i| format!("s{i}-->z\n"))
                ));
            }),
        ),
        (
            "3,000 transitions into a state 1,500 levels deep",
            Box::new(move || {
                big_render(&format!(
                    "{head}{}z\n{}{}",
                    repeat_fn(1500, |i| format!("state s{i}{{\n")),
                    "}\n".repeat(1500),
                    repeat_fn(3000, |i| format!("o{i}-->z\n"))
                ));
            }),
        ),
        (
            "composites that contain each other",
            Box::new(move || {
                big_render(&format!(
                    "{head}{}",
                    repeat_fn(2000, |i| format!("state a{i}{{\nstate a{}{{\n}}\n}}\n", (i + 1) % 2000))
                ));
            }),
        ),
        (
            "3,000 transitions into a ring of 1,200 composites",
            Box::new(move || {
                big_render(&format!(
                    "{head}{}{}",
                    repeat_fn(1200, |i| format!("state a{i}{{\nstate a{}{{\nz{i}\n}}\n}}\n", (i + 1) % 1200)),
                    repeat_fn(3000, |i| format!("o{i}-->z{}\n", i % 1200))
                ));
            }),
        ),
        (
            "a composite named root",
            Box::new(move || {
                big_render(&format!("{head}state root {{\n a --> b\n}}\nroot --> root\n"));
            }),
        ),
    ];

    for (name, run) in cases {
        let started = Instant::now();
        run();
        let elapsed = started.elapsed();
        assert!(elapsed.as_secs() < 15, "stress case '{name}' took {elapsed:?}");
    }
}
