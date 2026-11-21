mod support;

use std::collections::BTreeMap;

use regex::Regex;
use vibevalley_pele::config::{DiagramConfig, MessageAlign, SequenceConfig};
use vibevalley_pele::detect::DiagramType;
use vibevalley_pele::diagram::sequence::SeqDb;
use vibevalley_pele::diagram::sequence::types::{LineType, Placement, SeqMessageBody};
use vibevalley_pele::util::yaml::YamlValue;
use vibevalley_pele::{ErrorCode, MonospacePart, ParseOptions, ParsedModel, RenderOptions, detect_type, parse, render, supports};

use support::{Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, css_options, load_fixture, resolved_options};

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

fn seq_model(src: &str) -> SeqDb {
    let parsed = parse(src, &ParseOptions::default()).unwrap();
    match parsed.model {
        ParsedModel::Sequence(db) => db,
        other => panic!("expected Sequence model, got {other:?}"),
    }
}

fn lifelines(svg: &str) -> Vec<(String, f64)> {
    let re = Regex::new(r#"<path class="pele-lifeline" data-id="([^"]*)" d="M(-?[\d.]+),"#).unwrap();
    re.captures_iter(svg).map(|c| (c[1].to_string(), c[2].parse().unwrap())).collect()
}

fn lifeline_map(svg: &str) -> BTreeMap<String, f64> {
    lifelines(svg).into_iter().collect()
}

fn assert_close(a: f64, b: f64, tol: f64, msg: &str) {
    assert!((a - b).abs() <= tol, "{msg}: {a} vs {b} (tol={tol})");
}

#[test]
fn sequence_renders_full_upstream_corpus_in_css_and_resolved_resvg_modes() {
    let corpus = load_fixture("sequence-corpus.json");
    let mut rendered = 0usize;
    let re_shift = Regex::new(r#"<g transform="translate\((-?[\d.]+),(-?[\d.]+)\)">"#).unwrap();
    for src in &corpus {
        let Ok(res) = render(src, &css_options()) else {
            continue;
        };
        rendered += 1;
        let where_ctx = &src[..src.len().min(120)];
        assert_inert(&res.svg, where_ctx);
        assert!(!res.svg.contains("NaN"), "{where_ctx}: NaN");
        assert!(!res.svg.contains("undefined"), "{where_ctx}: undefined");
        assert!(!res.svg.contains("Infinity"), "{where_ctx}: Infinity");
        assert_eq!(try_render_css(src).as_deref(), Some(res.svg.as_str()), "determinism");

        // Every drawn rect stays inside reported size.
        if let Some(cap) = re_shift.captures(&res.svg) {
            let dx: f64 = cap[1].parse().unwrap();
            let dy: f64 = cap[2].parse().unwrap();
            let doc = roxmltree::Document::parse(&res.svg).unwrap();
            for node in doc.descendants().filter(|n| n.is_element() && n.tag_name().name() == "rect") {
                let Some(w_str) = node.attribute("width") else { continue };
                if w_str == "100%" {
                    continue;
                }
                let x: f64 = node.attribute("x").unwrap_or("0").parse().unwrap();
                let y: f64 = node.attribute("y").unwrap_or("0").parse().unwrap();
                let w: f64 = w_str.parse().unwrap();
                let h: f64 = node.attribute("height").unwrap().parse().unwrap();
                assert!(x + dx >= -0.01, "{where_ctx}: rect left {} < 0", x + dx);
                assert!(y + dy >= -0.01, "{where_ctx}: rect top {} < 0", y + dy);
                assert!(x + dx + w <= res.width + 0.01, "{where_ctx}: rect right > width");
                assert!(y + dy + h <= res.height + 0.01, "{where_ctx}: rect bottom > height");
            }
        }

        let res_svg = try_render_resolved(src).expect("resolved mode failed where css succeeded");
        assert_inert_resolved(&res_svg, where_ctx);
        assert_resvg_parses(&res_svg, where_ctx);
    }
    assert!(rendered > 150, "expected >150 rendered sequence samples, got {rendered}");
}

#[test]
fn sequence_basics_mirroring_spacing_arrows_and_self_loops() {
    let res = render("sequenceDiagram\n  Alice->>Bob: Hello", &css_options()).unwrap();
    assert_eq!(res.diagram_type, DiagramType::Sequence);
    assert!(res.width > 100.0);
    assert!(res.height > 100.0);
    assert!(res.links.is_empty());
    assert!(res.svg.contains(&format!("viewBox=\"0 0 {} {}\"", res.width, res.height)));
    assert!(res.svg.starts_with(r#"<svg xmlns="http://www.w3.org/2000/svg" class="pele pele-sequence""#));

    assert_eq!(detect_type("sequenceDiagram\n A->>B: hi"), Some(DiagramType::Sequence));
    assert!(supports("sequenceDiagram\n A->>B: hi"));
    let m = seq_model("sequenceDiagram\n participant A as Alice\n A->>B: hi");
    let keys: Vec<&str> = m.actors.keys().map(String::as_str).collect();
    assert_eq!(keys, vec!["A", "B"]);
    assert_eq!(m.actors["A"].description, "Alice");
    assert_eq!(m.messages.len(), 1);
    assert_eq!(m.messages[0].line_type, Some(LineType::Solid));

    // Empty & solo participant.
    assert!(render("sequenceDiagram", &resolved_options()).unwrap().width > 0.0);
    assert_eq!(
        render("sequenceDiagram\n participant Solo", &css_options())
            .unwrap()
            .svg
            .matches(r#"class="pele-node pele-actor"#)
            .count(),
        2
    );

    // Mirror actors on/off.
    let mirrored = render("sequenceDiagram\n  Alice->>Bob: Hi", &css_options()).unwrap();
    let mut no_mirror_cfg = DiagramConfig::default();
    no_mirror_cfg.sequence.mirror_actors = Some(false);
    let single = render(
        "sequenceDiagram\n  Alice->>Bob: Hi",
        &RenderOptions {
            config: Some(no_mirror_cfg),
            ..css_options()
        },
    )
    .unwrap();
    assert_eq!(mirrored.svg.matches(r#"class="pele-node pele-actor"#).count(), 4);
    assert_eq!(mirrored.svg.matches("pele-actor-footer").count(), 2);
    assert_eq!(single.svg.matches(r#"class="pele-node pele-actor"#).count(), 2);
    assert!(single.height < mirrored.height);
    let dir_off = render(
        "%%{init: {\"sequence\": {\"mirrorActors\": false}}}%%\nsequenceDiagram\n  Alice->>Bob: Hi",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert_eq!(dir_off.matches("pele-actor-footer").count(), 0);

    // Spacing by message text and shared across spans.
    let short = lifeline_map(&render("sequenceDiagram\n  A->>B: hi\n  B->>C: hi", &css_options()).unwrap().svg);
    let long = lifeline_map(
        &render(
            "sequenceDiagram\n  A->>B: a considerably longer message than before\n  B->>C: hi",
            &css_options(),
        )
        .unwrap()
        .svg,
    );
    assert!(long["B"] - long["A"] > short["B"] - short["A"] + 100.0);
    assert_close(long["C"] - long["B"], short["C"] - short["B"], 1.0, "untouched gap");

    let shared = lifeline_map(
        &render(
            "sequenceDiagram\n  participant A\n  participant B\n  participant C\n  A->>C: a message that is far too long for two default gaps to hold",
            &css_options(),
        )
        .unwrap()
        .svg,
    );
    assert_close(shared["B"] - shared["A"], shared["C"] - shared["B"], 1.0, "even share");
    assert!(shared["C"] - shared["A"] > 360.0);

    // All arrow types & half arrowheads.
    let one = |arrow: &str| -> String {
        let svg = render(&format!("sequenceDiagram\n  A{arrow}B: x"), &css_options()).unwrap().svg;
        Regex::new(r#"<g class="pele-edge pele-message"[^>]*>(.*?)</g>"#)
            .unwrap()
            .captures(&svg)
            .unwrap()[1]
            .to_string()
    };
    assert!(!one("->").contains("pele-marker"));
    assert!(!one("->").contains("stroke-dasharray"));
    assert!(one("-->").contains("stroke-dasharray"));
    assert_eq!(one("->>").matches("pele-marker").count(), 1);
    assert!(one("-->>").contains("stroke-dasharray"));
    assert_eq!(one("<<->>").matches("pele-marker").count(), 2);
    assert_eq!(one("<<-->>").matches("pele-marker").count(), 2);
    assert!(Regex::new(r#"pele-marker" d="M[^"]*M"#).unwrap().is_match(&one("-x")));
    assert!(one("-)").contains(r#"stroke-linejoin="round""#));
    for half in ["-|\\", "-|/", "-\\\\", "-//", "/|-", "\\|-", "//-", "\\\\-"] {
        assert_eq!(one(half).matches("pele-marker").count(), 1, "half={half}");
        assert!(one(&half.replacen('-', "--", 1)).contains("stroke-dasharray"), "half={half}");
    }

    // Self-loop rounded vs rightAngles.
    let loop_svg = render("sequenceDiagram\n  A->>A: think\n  A->>B: tell", &css_options()).unwrap().svg;
    let d = Regex::new(r#"data-id="i0"><path d="([^"]*)""#).unwrap().captures(&loop_svg).unwrap()[1].to_string();
    assert!(Regex::new(r"^M[\d.]+,[\d.]+H[\d.]+A6,6").unwrap().is_match(&d));
    let mut sq_cfg = DiagramConfig::default();
    sq_cfg.sequence.right_angles = true;
    let sq_svg = render(
        "sequenceDiagram\n  A->>A: think",
        &RenderOptions {
            config: Some(sq_cfg),
            ..css_options()
        },
    )
    .unwrap()
    .svg;
    assert!(!sq_svg.contains("A6,6"));
}

#[test]
fn sequence_max_width_monospace_activations_notes_and_blocks() {
    // Widens gaps within maxWidth before wrapping.
    let reported = "sequenceDiagram\n  participant U as UE\n  participant M as MeNB (LTE anchor)\n  participant S as SgNB (5G, NR leg)\n  M->>S: SgNB Addition Request (DRB-ID, CG-ConfigInfo)\n  M->>U: RRCConnectionReconfiguration (carries the NR SCG config)\n  U->>M: RRCConnectionReconfigurationComplete";
    let line_count = |svg: &str, id: &str| -> usize {
        let g = Regex::new(&format!(r#"<g class="pele-edge-label" data-id="{id}">(.*?)</g>"#))
            .unwrap()
            .captures(svg)
            .unwrap()[1]
            .to_string();
        g.matches("<tspan").count().max(1)
    };
    let r760 = render(
        reported,
        &RenderOptions {
            max_width: Some(760.0),
            ..css_options()
        },
    )
    .unwrap();
    assert!(r760.width <= 760.0);
    assert_eq!(line_count(&r760.svg, "i2"), 1);
    let r400 = render(
        reported,
        &RenderOptions {
            max_width: Some(400.0),
            ..css_options()
        },
    )
    .unwrap();
    assert!(r400.width <= 400.0);
    assert_eq!(line_count(&r400.svg, "i2"), 2);

    // Monospace messages.
    let mono_src = "sequenceDiagram\n  A->>B: a message in the monospace font\n  B->>B: a message to itself\n  Note over A,B: a note";
    let plain = render(mono_src, &css_options()).unwrap();
    let mono = render(
        mono_src,
        &RenderOptions {
            monospace: vec![MonospacePart::Messages],
            ..css_options()
        },
    )
    .unwrap();
    assert!(mono.svg.contains(r#"<g class="pele-edge-labels" font-size="14" font-family="var(--_fm)">"#));
    assert!(!plain.svg.contains(r#"font-family="var(--_fm)""#));
    assert_eq!(mono.svg.matches(r#"font-family="var(--_fm)""#).count(), 1);
    let gap = |s: &str| {
        let m = lifeline_map(s);
        m["B"] - m["A"]
    };
    assert!(gap(&mono.svg) > gap(&plain.svg));

    // Nested activations and error on inactive deactivation.
    let act_svg = render(
        "sequenceDiagram\n  A->>+B: one\n  A->>+B: two\n  B-->>-A: three\n  B-->>-A: four",
        &css_options(),
    )
    .unwrap()
    .svg;
    let x = lifeline_map(&act_svg);
    let re_act = Regex::new(r#"<rect class="pele-activation" data-id="B" x="(-?[\d.]+)" y="(-?[\d.]+)" width="10" height="([\d.]+)""#).unwrap();
    let rects: Vec<(f64, f64)> = re_act.captures_iter(&act_svg).map(|c| (c[1].parse().unwrap(), c[3].parse().unwrap())).collect();
    assert_eq!(rects.len(), 2);
    assert_close(rects[0].0, x["B"] - 5.0, 1e-4, "outer act x");
    assert_close(rects[1].0, x["B"] - 1.0, 1e-4, "inner act x");
    assert!(rects[0].1 > rects[1].1);

    assert!(
        render("sequenceDiagram\n  A->>B: go\n  deactivate B", &css_options())
            .unwrap_err()
            .message
            .contains("inactivate an inactive participant (B)")
    );
    assert!(render("sequenceDiagram\n  A->>-B: go", &css_options()).is_err());

    // Notes left/right/over.
    let note_src = "sequenceDiagram\n  participant A\n  participant B\n  Note left of A: L\n  Note right of B: R\n  Note over A: O\n  Note over A,B: AB";
    let note_svg = render(note_src, &css_options()).unwrap().svg;
    let nx = lifeline_map(&note_svg);
    let re_note = Regex::new(r#"<g class="pele-note" data-id="i\d+"><rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)""#).unwrap();
    let notes: Vec<(f64, f64, f64)> = re_note
        .captures_iter(&note_svg)
        .map(|c| {
            let l: f64 = c[1].parse().unwrap();
            let t: f64 = c[2].parse().unwrap();
            let w: f64 = c[3].parse().unwrap();
            (l, l + w, t)
        })
        .collect();
    assert_eq!(notes.len(), 4);
    assert!(notes[0].1 < nx["A"]);
    assert!(notes[1].0 > nx["B"]);
    assert_close((notes[2].0 + notes[2].1) / 2.0, nx["A"], 1.0, "note over A");
    assert!(notes[3].0 < nx["A"] && notes[3].1 > nx["B"]);

    let nm = seq_model("sequenceDiagram\n  Note over A,B: AB\n  Note left of A: L");
    assert_eq!(nm.notes[0].placement, Placement::Over);
    assert_eq!(nm.notes[1].placement, Placement::LeftOf);

    // All control-flow blocks: loop, alt, opt, par, par_over, critical, break.
    let blocks_svg = render(
        "sequenceDiagram\n  loop Every minute\n  A->>B: a\n  end\n  alt ok\n  A->>B: b\n  else bad\n  A->>B: c\n  else\n  A->>B: d\n  end\n  opt maybe\n  A->>B: e\n  end\n  par one\n  A->>B: f\n  and two\n  A->>B: g\n  end\n  par_over three\n  A->>B: h\n  end\n  critical must\n  A->>B: i\n  option fail\n  A->>B: j\n  end\n  break stop\n  A->>B: k\n  end",
        &css_options(),
    )
    .unwrap()
    .svg;
    for kind in ["loop", "alt", "opt", "par", "critical", "break"] {
        assert!(blocks_svg.contains(&format!(r#"class="pele-frame pele-frame-{kind}""#)), "kind={kind}");
        assert!(blocks_svg.contains(&format!(">{kind}</text>")), "kind={kind}");
    }
    assert_eq!(blocks_svg.matches(r#"class="pele-frame pele-frame-par""#).count(), 2);
    for title in [
        "[Every minute]",
        "[ok]",
        "[bad]",
        "[maybe]",
        "[one]",
        "[two]",
        "[three]",
        "[must]",
        "[fail]",
        "[stop]",
    ] {
        assert!(blocks_svg.contains(&format!(">{title}</text>")), "title={title}");
    }
}

#[test]
fn sequence_rects_boxes_contrast_autonumber_create_destroy_and_config() {
    // Shaded rect blocks & contrasting text/arrow ink.
    let rect_svg = render(
        "sequenceDiagram\n  rect rgb(191, 223, 255)\n  A->>B: x\n  rect rgba(0, 0, 255, .1)\n  B->>A: y\n  end\n  end\n  rect\n  A->>B: z\n  end",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert_eq!(rect_svg.matches(r#"<rect class="pele-rect""#).count(), 3);
    assert!(rect_svg.contains(r#"style="rx:var(--_r);fill:rgb(191, 223, 255);""#));
    assert!(rect_svg.contains(r#"style="rx:var(--_r);fill:rgba(0, 0, 255, .1);""#));
    assert!(rect_svg.find(r#"class="pele-rects""#).unwrap() < rect_svg.find(r#"class="pele-lifelines""#).unwrap());

    let contrast_svg = render(
        "sequenceDiagram\n  box rgb(34, 56, 0) Group\n  participant A\n  participant B\n  end\n  participant C\n  participant D\n  A->>B: boxed\n  C->>D: open\n  rect rgb(191, 223, 255)\n  C->>D: light\n  C->>C: self\n  loop Often\n  D->>C: looped\n  end\n  rect black\n  C->>D: dark\n  end\n  rect rgba(0, 0, 0, .2)\n  C->>D: faint\n  end\n  A->>D: crossing two of the lifelines\n  end",
        &css_options(),
    )
    .unwrap()
    .svg;
    let light = r#"fill="var(--pele-fg-on-light,#1f1f1f)""#;
    let dark = r#"fill="var(--pele-fg-on-dark,#fff)""#;
    let label_el = |t: &str| {
        Regex::new(&format!(r"<text[^>]*>(?:\[)?{t}(?:\])?</text>"))
            .unwrap()
            .find(&contrast_svg)
            .unwrap()
            .as_str()
            .to_string()
    };
    assert!(label_el("boxed").contains(dark));
    assert!(!label_el("open").contains("fill="));
    assert!(label_el("light").contains(light));
    assert!(label_el("self").contains(light));
    assert!(label_el("Often").contains(light));
    assert!(label_el("dark").contains(dark));
    assert!(!label_el("faint").contains("fill="));

    // Box colors & duplicate box error.
    let bm = seq_model(
        "sequenceDiagram\n  box Aqua Group One\n  participant A\n  participant B\n  end\n  box Group Two\n  participant C\n  end\n  box rgb(1, 2, 3)\n  participant D\n  end\n  A->>D: x",
    );
    assert_eq!(bm.boxes.len(), 3);
    assert_eq!(bm.boxes[0].name.as_deref(), Some("Group One"));
    assert_eq!(bm.boxes[0].fill, "Aqua");
    assert_eq!(bm.boxes[1].fill, "transparent");
    assert_eq!(bm.boxes[2].name, None);
    assert_eq!(bm.boxes[2].fill, "rgb(1, 2, 3)");
    assert!(
        render(
            "sequenceDiagram\n  box One\n  participant A\n  end\n  box Two\n  participant A\n  end",
            &css_options()
        )
        .unwrap_err()
        .message
        .contains("should only be defined in one Box")
    );

    // Autonumber start/step/off/invalid decimals.
    let nums = |src: &str| -> Vec<String> {
        let svg = render(src, &css_options()).unwrap().svg;
        Regex::new(r#"<g class="pele-sequence-number">.*?<text[^>]*>([^<]*)</text>"#)
            .unwrap()
            .captures_iter(&svg)
            .map(|c| c[1].to_string())
            .collect()
    };
    assert_eq!(
        nums("sequenceDiagram\n  autonumber\n  A->>B: one\n  B-->>A: two\n  A->>A: three"),
        vec!["1", "2", "3"]
    );
    assert_eq!(
        nums("sequenceDiagram\n  autonumber 10 5\n  A->>B: one\n  B-->>A: two\n  A->>A: three"),
        vec!["10", "15", "20"]
    );
    assert_eq!(
        nums("sequenceDiagram\n  autonumber 10.01 .01\n  A->>B: one\n  B-->>A: two\n  A->>A: three"),
        vec!["10.01", "10.02", "10.03"]
    );
    assert_eq!(
        nums("sequenceDiagram\n  autonumber\n  A->>B: one\n  autonumber off\n  B-->>A: two\n  autonumber\n  A->>B: three"),
        vec!["1", "3"]
    );
    assert!(render("sequenceDiagram\n  autonumber 10.001\n  A->>B: one", &css_options()).is_err());

    // Participant kinds & aliases.
    let kinds_src = "sequenceDiagram\n  participant P\n  actor A\n  participant boundary@{ \"type\": \"boundary\" }\n  participant control@{ \"type\": \"control\" }\n  participant entity@{ \"type\": \"entity\" }\n  participant database@{ \"type\": \"database\" }\n  participant collections@{ \"type\": \"collections\" }\n  participant queue@{ \"type\": \"queue\" }\n";
    let km = seq_model(kinds_src);
    let types: Vec<&str> = km.actors.values().map(|a| a.actor_type.as_str()).collect();
    assert_eq!(
        types,
        vec!["participant", "actor", "boundary", "control", "entity", "database", "collections", "queue"]
    );
    let ksvg = render(kinds_src, &resolved_options()).unwrap().svg;
    assert_resvg_parses(&ksvg, "all participant kinds");

    // Create & destroy rules.
    let cd_src = "sequenceDiagram\n  A->>B: hi\n  create participant C\n  A->>C: make\n  destroy C\n  A-xC: end\n  B->>A: bye";
    let cdm = seq_model(cd_src);
    assert_eq!(cdm.created_actors.get("C"), Some(&1));
    assert_eq!(cdm.destroyed_actors.get("C"), Some(&2));
    let cdsvg = render(cd_src, &css_options()).unwrap().svg;
    assert_eq!(cdsvg.matches(r#"class="pele-destroy" data-id="C""#).count(), 1);
    assert_eq!(cdsvg.matches(r#"pele-actor-footer" data-id="C""#).count(), 0);
    assert!(
        render("sequenceDiagram\n  A->>B: hi\n  create participant A\n  B->>A: x", &css_options())
            .unwrap_err()
            .message
            .contains("same id")
    );
    assert!(
        render("sequenceDiagram\n  create participant C\n  A->>B: x", &css_options())
            .unwrap_err()
            .message
            .contains("created participant C")
    );
    assert!(
        render("sequenceDiagram\n  A->>B: hi\n  destroy B\n  A->>C: x", &css_options())
            .unwrap_err()
            .message
            .contains("destroyed participant B")
    );

    // Central connections.
    let ccm = seq_model("sequenceDiagram\n  A->>()B: to\n  A()->>B: from\n  A()->>()B: both");
    let ccs: Vec<Option<LineType>> = ccm
        .messages
        .iter()
        .filter(|m| m.message != SeqMessageBody::Text(String::new()))
        .map(|m| m.central_connection)
        .collect();
    assert_eq!(
        ccs,
        vec![
            Some(LineType::CentralConnection),
            Some(LineType::CentralConnectionReverse),
            Some(LineType::CentralConnectionDual),
        ]
    );

    // Participant links, properties, details (non-interactive) & hideUnusedParticipants & messageAlign.
    let menu_src = "sequenceDiagram\n  participant A\n  participant B\n  links A: {\"Repo\": \"https://example.com/repo\", \"Docs\": \"https://example.com/docs\"}\n  link A: Tests @ https://example.com/?a=1&b=2@x\n  properties B: {\"class\": \"external svc\", \"icon\": \"@clock\"}\n  details B: some-element\n  A->>B: hi";
    let mm = seq_model(menu_src);
    assert_eq!(
        mm.actors["A"].links.get("Repo"),
        Some(&YamlValue::String("https://example.com/repo".to_string()))
    );
    assert_eq!(
        mm.actors["A"].links.get("Tests"),
        Some(&YamlValue::String("https://example.com/?a=1&b=2@x".to_string()))
    );
    assert_eq!(mm.actors["B"].details.as_deref(), Some("some-element"));
    let msvg = render(menu_src, &css_options()).unwrap().svg;
    assert!(!msvg.contains("<a"));
    assert!(!msvg.contains("example.com"));
    assert!(msvg.contains(r#"pele-actor-participant external svc" data-id="B""#));

    let hide_src = "sequenceDiagram\n  participant A\n  participant Unused\n  participant B\n  A->>B: x";
    let mut hide_cfg = DiagramConfig::default();
    hide_cfg.sequence.hide_unused_participants = true;
    let hidden_keys: Vec<String> = lifelines(
        &render(
            hide_src,
            &RenderOptions {
                config: Some(hide_cfg),
                ..css_options()
            },
        )
        .unwrap()
        .svg,
    )
    .into_iter()
    .map(|(k, _)| k)
    .collect();
    assert_eq!(hidden_keys, vec!["A", "B"]);

    // messageAlign left/center/right.
    let align_src = "sequenceDiagram\n  A->>B: a message that sets the width\n  A->>B: hi";
    let text_x = |align: Option<MessageAlign>| -> f64 {
        let mut cfg = DiagramConfig::default();
        cfg.sequence.message_align = align;
        let svg = render(
            align_src,
            &RenderOptions {
                config: Some(cfg),
                ..css_options()
            },
        )
        .unwrap()
        .svg;
        Regex::new(r#"data-id="i1"><text x="([\d.]+)""#).unwrap().captures(&svg).unwrap()[1]
            .parse()
            .unwrap()
    };
    let center = text_x(None);
    assert!(text_x(Some(MessageAlign::Left)) < center - 50.0);
    assert!(text_x(Some(MessageAlign::Right)) > center + 50.0);

    // Structured syntax errors.
    let err = render("sequenceDiagram\n  Alice->>Bob\n", &css_options()).unwrap_err();
    assert_eq!(err.code, ErrorCode::Syntax);
    assert_eq!(err.line, 2);
    assert!(err.message.contains("Expecting 'TXT', got 'NEWLINE'"));
    assert!(
        render("sequenceDiagram\n  participant\n", &css_options())
            .unwrap_err()
            .message
            .contains("Lexical error on line 2")
    );
    assert!(render("sequenceDiagram\n  loop x\n  A->>B: y", &css_options()).is_err());
}

#[test]
fn sequence_security_hostile_payloads_extreme_configs_and_mutated_fuzz() {
    let j = |p: &str| serde_json::to_string(p).unwrap();
    type TemplateFn = Box<dyn Fn(&str) -> String>;
    let templates: Vec<TemplateFn> = vec![
        Box::new(|p| format!("sequenceDiagram\n  participant {p}\n  A->>B: x")),
        Box::new(|p| format!("sequenceDiagram\n  actor {p}\n  A->>B: x")),
        Box::new(|p| format!("sequenceDiagram\n  participant A as {p}\n  A->>B: x")),
        Box::new(move |p| format!("sequenceDiagram\n  participant A@{{ \"type\": {} }}\n  A->>B: x", j(p))),
        Box::new(move |p| format!("sequenceDiagram\n  participant A@{{ \"type\": \"database\", \"alias\": {} }}\n  A->>B: x", j(p))),
        Box::new(|p| format!("sequenceDiagram\n  {p}->>B: x")),
        Box::new(|p| format!("sequenceDiagram\n  A->>{p}: x")),
        Box::new(|p| format!("sequenceDiagram\n  A->>B: {p}")),
        Box::new(|p| format!("sequenceDiagram\n  A->>B: wrap: {p} and some more words to wrap around the corner of the label")),
        Box::new(|p| format!("sequenceDiagram\n  A->>A: {p}")),
        Box::new(|p| format!("sequenceDiagram\n  Note left of A: {p}")),
        Box::new(|p| format!("sequenceDiagram\n  Note over A,B: {p}")),
        Box::new(|p| format!("sequenceDiagram\n  loop {p}\n  A->>B: x\n  end")),
        Box::new(|p| format!("sequenceDiagram\n  alt {p}\n  A->>B: x\n  else {p}\n  B->>A: y\n  end")),
        Box::new(|p| format!("sequenceDiagram\n  rect {p}\n  A->>B: x\n  end")),
        Box::new(|p| format!("sequenceDiagram\n  box {p}\n  participant A\n  end\n  A->>B: x")),
        Box::new(|p| format!("sequenceDiagram\n  title {p}\n  A->>B: x")),
        Box::new(|p| format!("sequenceDiagram\n  accTitle: {p}\n  accDescr: {p}\n  A->>B: x")),
        Box::new(move |p| format!("sequenceDiagram\n  participant A\n  links A: {{{}: {}}}\n  A->>B: x", j(p), j(p))),
        Box::new(move |p| {
            format!(
                "sequenceDiagram\n  participant A\n  properties A: {{\"class\": {}, {}: {}}}\n  A->>B: x",
                j(p),
                j(p),
                j(p)
            )
        }),
        Box::new(|p| format!("sequenceDiagram\n  autonumber {p}\n  A->>B: x")),
        Box::new(|p| format!("sequenceDiagram\n  A->>B: x\n  create participant {p}\n  A->>{p}: y")),
        Box::new(move |p| format!("---\ntitle: {}\n---\nsequenceDiagram\n  A->>B: x", j(p))),
    ];

    let mut rendered = 0usize;
    for tmpl in &templates {
        for &payload in PAYLOADS {
            let src = tmpl(payload);
            if let Some(svg) = try_render_css(&src) {
                assert_inert(&svg, &src);
                rendered += 1;
            }
            if let Some(svg) = try_render_resolved(&src) {
                assert_inert_resolved(&svg, &src);
                assert_resvg_parses(&svg, &src);
            }
        }
    }
    assert!(rendered > 400, "rendered={rendered}");

    // Extreme config numbers survive safely.
    for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0, 0.0, 1e308, 1e-308] {
        let cfg = DiagramConfig {
            sequence: SequenceConfig {
                width: Some(value),
                height: Some(value),
                actor_margin: Some(value),
                message_margin: Some(value),
                note_margin: Some(value),
                box_margin: Some(value),
                ..SequenceConfig::default()
            },
            ..DiagramConfig::default()
        };
        let src = "sequenceDiagram\n  box B\n  participant A\n  end\n  A->>C: x\n  Note over A,C: n\n  loop l\n  C->>C: y\n  end";
        let svg = render(
            src,
            &RenderOptions {
                config: Some(cfg),
                ..resolved_options()
            },
        )
        .unwrap()
        .svg;
        assert_inert_resolved(&svg, "extreme sequence config");
        assert_resvg_parses(&svg, "extreme sequence config");
    }

    // Overflowing autonumber survives safely.
    let big_num = format!("sequenceDiagram\n  autonumber {} {}\n  A->>B: x\n  B->>A: y", "9".repeat(400), "9".repeat(400));
    let svg = render(&big_num, &resolved_options()).unwrap().svg;
    assert_inert_resolved(&svg, "huge autonumber");
    assert_resvg_parses(&svg, "huge autonumber");

    // Prototype keys in links stay plain map keys.
    let m = seq_model("sequenceDiagram\n  participant A\n  links A: {\"__proto__\": \"x\", \"toString\": \"y\"}");
    let link_keys: Vec<&str> = m.actors["A"].links.keys().map(String::as_str).collect();
    assert_eq!(link_keys, vec!["__proto__", "toString"]);

    // Rect color goes through style filter.
    let rect_filter = render(
        "sequenceDiagram\n  rect url(javascript:alert(1))\n  A->>B: hi\n  end\n  rect red\n  B->>A: yo\n  end",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(!rect_filter.contains("url("));
    assert!(rect_filter.contains(r#"style="rx:var(--_r);fill:red;""#));

    // Mutated fuzzing over sequence corpus.
    let corpus = load_fixture("sequence-corpus.json");
    let mut frags: Vec<&str> = PAYLOADS.to_vec();
    frags.extend_from_slice(&[
        "\"",
        ":",
        "\n",
        "@{ \"type\": \"",
        "\" }",
        " as ",
        "rect ",
        "box ",
        "links A: {\"a\": \"",
        "properties A: {\"class\": \"",
        "Note over A: ",
        "title ",
        "end\n",
        "loop ",
        "<br/>",
        "wrap: ",
    ]);
    let mut mutator = Mutator::new(&corpus, frags, 3);
    for _ in 0..1000 {
        let src = mutator.next_sample();
        if src.len() <= 4000
            && let Some(svg) = try_render_css(&src)
        {
            assert_inert(&svg, &src[..src.len().min(120)]);
        }
    }
}
