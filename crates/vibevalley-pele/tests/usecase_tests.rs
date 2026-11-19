mod support;

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use indexmap::IndexMap;
use regex::Regex;
use vibevalley_pele::diagram::ParsedModel;
use vibevalley_pele::diagram::usecase::graph::build_usecase_graph;
use vibevalley_pele::diagram::usecase::json::parse_ordered_json;
use vibevalley_pele::diagram::usecase::lexer::tokenize;
use vibevalley_pele::diagram::usecase::parser::parse_usecase;
use vibevalley_pele::diagram::usecase::tokens::UsecaseToken;
use vibevalley_pele::diagram::usecase::types::{
    ActorType, Animation, Arrow, BoundaryType, Direction, JsonValue, LabelType, RelationshipType, StatementKind, UseCaseShape,
};
use vibevalley_pele::{DiagramType, ErrorCode, METRICS_MEASURER, ParseOptions, RenderOptions, TextMeasurer, TextStyle, detect_type, parse, render, supports};

use support::{Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, css_options, dark_options, load_fixture, resolved_options};

fn svg_of(body: &str) -> String {
    render(&format!("usecase-beta\n{body}"), &css_options())
        .unwrap_or_else(|e| panic!("failed to render `{body}`: {e}"))
        .svg
}

fn at(svg: &str, id: &str) -> (f64, f64) {
    let pat = format!(
        r#"<g class="pele-node [^"]*" data-id="{}" transform="translate\(([-\d.]+),([-\d.]+)\)""#,
        regex::escape(id)
    );
    let caps = Regex::new(&pat).unwrap().captures(svg).unwrap_or_else(|| panic!("no node `{id}` in svg"));
    (caps[1].parse().unwrap(), caps[2].parse().unwrap())
}

fn node_group(svg: &str, id: &str) -> String {
    let needle = format!(r#"data-id="{id}" transform="#);
    let start = svg.find(&needle).unwrap_or_else(|| panic!("no node `{id}`"));
    let g_start = svg[..start].rfind(r#"<g class="pele-node"#).unwrap();
    let g_end = svg[start + 1..].find(r#"<g class="pele-node"#).map_or(svg.len(), |off| start + 1 + off);
    svg[g_start..g_end].to_string()
}

fn ellipse_of(svg: &str, id: &str) -> (f64, f64, f64, f64) {
    let grp = node_group(svg, id);
    let caps = Regex::new(r#"<ellipse rx="([\d.]+)" ry="([\d.]+)""#)
        .unwrap()
        .captures(&grp)
        .unwrap_or_else(|| panic!("no ellipse in `{id}`"));
    let (x, y) = at(svg, id);
    (x, y, caps[1].parse().unwrap(), caps[2].parse().unwrap())
}

#[derive(Debug, Clone, Copy)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn boundary_rects(svg: &str, id: &str) -> Vec<Rect> {
    let tag_needle = format!(r#"data-id="{id}">"#);
    let tag = svg.find(&tag_needle).unwrap_or_else(|| panic!("no boundary `{id}`"));
    let g_start = svg[..tag].rfind(r#"<g class="pele-cluster"#).unwrap();
    let g_end = tag + svg[tag..].find("</g>").unwrap();
    let group = &svg[g_start..g_end];
    Regex::new(r#"<rect[^>]*? x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)""#)
        .unwrap()
        .captures_iter(group)
        .map(|c| Rect {
            x: c[1].parse().unwrap(),
            y: c[2].parse().unwrap(),
            w: c[3].parse().unwrap(),
            h: c[4].parse().unwrap(),
        })
        .collect()
}

#[derive(Debug, Clone)]
struct EdgeMatch {
    id: String,
    classes: String,
    d: String,
    body: String,
}

fn edges_of(svg: &str) -> Vec<EdgeMatch> {
    Regex::new(r#"<g class="pele-edge ([^"]*)" data-id="([^"]*)"[^>]*><path d="([^"]+)"([^>]*)/>(.*?)</g>"#)
        .unwrap()
        .captures_iter(svg)
        .map(|c| EdgeMatch {
            classes: c[1].to_string(),
            id: c[2].to_string(),
            d: c[3].to_string(),
            body: format!("{}{}", &c[4], &c[5]),
        })
        .collect()
}

fn path_ends(d: &str) -> (f64, f64, f64, f64) {
    let nums: Vec<f64> = Regex::new(r"-?\d+(?:\.\d+)?")
        .unwrap()
        .find_iter(d)
        .map(|m| m.as_str().parse().unwrap())
        .collect();
    (nums[0], nums[1], nums[nums.len() - 2], nums[nums.len() - 1])
}

fn source_location(source: &str, start: usize, end: usize) -> String {
    let prefix = &source[..start];
    let mut line = 1usize;
    let mut line_start = 0usize;
    let bytes = prefix.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'\r' {
            line += 1;
            if i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
                i += 2;
            } else {
                i += 1;
            }
            line_start = i;
        } else if bytes[i] == b'\n' {
            line += 1;
            i += 1;
            line_start = i;
        } else {
            i += 1;
        }
    }
    let col = source[line_start..start].chars().count() + 1;
    let start_chars = source[..start].chars().count();
    let end_chars = source[..end].chars().count();
    format!("line {line}, column {col} [{start_chars},{end_chars})")
}

fn occurrence_location(source: &str, text: &str, occurrence: usize, trim_start: usize, trim_end: usize) -> String {
    let mut pos = 0usize;
    let mut found = None;
    for _ in 0..occurrence {
        let rel = source[pos..]
            .find(text)
            .unwrap_or_else(|| panic!("missing occurrence #{occurrence} of `{text}` in `{source}`"));
        found = Some(pos + rel);
        pos = pos + rel + 1;
    }
    let start = found.unwrap();
    source_location(source, start + trim_start, start + text.len() - trim_end)
}

#[test]
fn usecase_renders_full_upstream_corpus_in_css_and_resolved_resvg_modes() {
    let corpus = load_fixture("usecase-corpus.json");
    assert_eq!(corpus.len(), 105);
    let mut rendered = 0usize;
    for (idx, src) in corpus.iter().enumerate() {
        let where_ctx = format!("usecase corpus #{idx}");
        let Ok(css) = render(src, &css_options()) else {
            continue;
        };
        rendered += 1;
        assert_inert(&css.svg, &format!("{where_ctx} css"));
        assert!(!css.svg.contains("NaN"), "{where_ctx} had NaN");
        assert!(!css.svg.contains("undefined"), "{where_ctx} had undefined");
        assert_eq!(render(src, &css_options()).unwrap().svg, css.svg);

        let resolved = render(src, &resolved_options()).unwrap_or_else(|e| panic!("{where_ctx} resolved failed: {e}"));
        assert_inert_resolved(&resolved.svg, &format!("{where_ctx} resolved"));
        assert_resvg_parses(&resolved.svg, &format!("{where_ctx} resvg"));

        let dark = render(src, &dark_options()).unwrap_or_else(|e| panic!("{where_ctx} dark failed: {e}"));
        assert_inert_resolved(&dark.svg, &format!("{where_ctx} dark"));
        assert_resvg_parses(&dark.svg, &format!("{where_ctx} dark resvg"));
    }
    assert!(rendered > 60, "expected >60 rendered usecase corpus diagrams, got {rendered}");
}

#[test]
fn usecase_rendering_actors_usecases_boundaries_edges_notes_json_styles_and_errors() {
    // 1. Detected, supported, typed, and parsed model shape.
    let src = "usecase-beta\nactor User\nUser --> Login";
    assert_eq!(detect_type(src), Some(DiagramType::Usecase));
    assert!(supports(src));
    let res = render(src, &css_options()).unwrap();
    assert_eq!(res.diagram_type, DiagramType::Usecase);
    assert!(res.svg.starts_with(r#"<svg xmlns="http://www.w3.org/2000/svg" class="pele pele-usecase""#));
    assert!(res.svg.contains(&format!(r#"viewBox="0 0 {} {}""#, res.width, res.height)));
    assert!(res.links.is_empty());
    let parsed = parse(src, &ParseOptions::default()).unwrap();
    assert_eq!(parsed.diagram_type, DiagramType::Usecase);
    let ParsedModel::Usecase(model) = &parsed.model else {
        panic!("expected usecase model");
    };
    assert_eq!(model.actors.keys().cloned().collect::<Vec<_>>(), vec!["User"]);
    assert_eq!(model.use_cases.keys().cloned().collect::<Vec<_>>(), vec!["Login"]);
    assert_eq!(
        model.statements.iter().map(|s| s.kind).collect::<Vec<_>>(),
        vec![StatementKind::Node, StatementKind::Edge]
    );

    // 2. Directions: default LR, TB == TD, BT, RL.
    let chain = "actor A\nA --> B\nB --> C";
    let wide = render(&format!("usecase-beta\n{chain}"), &css_options()).unwrap();
    assert!(wide.width > wide.height);
    assert!(at(&wide.svg, "A").0 < at(&wide.svg, "B").0);
    let tall = render(&format!("usecase-beta\ndirection TB\n{chain}"), &css_options()).unwrap();
    assert!(tall.height > tall.width);
    assert!(at(&tall.svg, "A").1 < at(&tall.svg, "B").1);
    assert_eq!(render(&format!("usecase-beta\ndirection TD\n{chain}"), &css_options()).unwrap().svg, tall.svg);
    let up = svg_of(&format!("direction BT\n{chain}"));
    assert!(at(&up, "A").1 > at(&up, "B").1);
    let back = svg_of(&format!("direction RL\n{chain}"));
    assert!(at(&back, "A").0 > at(&back, "B").0);

    // 3. Actor figures (normal, hollow, awesome, icon) and label below figure.
    let actors_svg = svg_of("actor N(\"Normal one\")\nactor H@{ type: hollow }\nactor W@{ type: awesome }\nactor I@{ icon: \"fa:user\" }");
    let normal = node_group(&actors_svg, "N");
    assert!(normal.contains(r#"class="pele-node pele-actor usecase-actor usecase-actor-normal""#));
    assert!(normal.contains(r#"<circle cy="-21" r="9""#));
    assert!(normal.contains("M0,-12V10M-14,-3H14M0,10L-12,30M0,10L12,30"));
    assert!(normal.contains(">Normal one</text>"));
    let fig_y: f64 = Regex::new(r#"pele-actor-figure" transform="translate\(0,([-\d.]+)\)"#)
        .unwrap()
        .captures(&normal)
        .unwrap()[1]
        .parse()
        .unwrap();
    let label_y: f64 = Regex::new(r#"<text class="pele-label" x="0" y="([-\d.]+)""#)
        .unwrap()
        .captures(&normal)
        .unwrap()[1]
        .parse()
        .unwrap();
    assert!(label_y > fig_y + 30.0);

    let hollow = node_group(&actors_svg, "H");
    assert!(hollow.contains("usecase-actor-hollow"));
    assert_eq!(hollow.matches(r#"fill="var(--_bg)""#).count(), 2);
    let awesome = node_group(&actors_svg, "W");
    assert!(awesome.contains(r#"fill="var(--_b)""#));
    assert!(!awesome.contains("<circle"));
    let icon = node_group(&actors_svg, "I");
    assert!(icon.contains(r#"<svg class="pele-icon" data-icon="fa:user""#));
    assert!(icon.contains(r#"<rect x="-22" y="-26" width="44" height="44""#));

    // 4. Icon resolver fills icon actor.
    let icon_resolver = |name: &str| {
        if name == "fa:user" { Some(r#"<path d="M1,1"/>"#.to_string()) } else { None }
    };
    let icon_opts = RenderOptions {
        icons: Some(&icon_resolver),
        ..css_options()
    };
    let icon_svg = render("usecase-beta\nactor I@{ icon: \"fa:user\" }", &icon_opts).unwrap().svg;
    assert!(icon_svg.contains(r#"data-icon="fa:user""#));
    assert!(icon_svg.contains(r#"stroke-linejoin="round"><path d="M1,1"/></svg>"#));

    // 5. Business slash on actors and use cases.
    let biz_svg = svg_of("actor A@{ business: true }\nactor B@{ type: hollow, business: true }\nU(Use)@{ business: true }\nV(Plain)");
    assert_eq!(node_group(&biz_svg, "A").matches(r#"class="pele-business""#).count(), 1);
    assert_eq!(node_group(&biz_svg, "B").matches(r#"class="pele-business""#).count(), 1);
    assert_eq!(node_group(&biz_svg, "U").matches(r#"class="pele-business""#).count(), 1);
    assert_eq!(node_group(&biz_svg, "V").matches(r#"class="pele-business""#).count(), 0);
    let (_, _, rx, ry) = ellipse_of(&biz_svg, "U");
    let u_biz = node_group(&biz_svg, "U");
    let slash_d = &Regex::new(r#"class="pele-business" d="([^"]+)""#).unwrap().captures(&u_biz).unwrap()[1];
    let (x1, y1, x2, y2) = path_ends(slash_d);
    for (x, y) in [(x1, y1), (x2, y2)] {
        let on_oval = (x / rx).powi(2) + (y / ry).powi(2);
        assert!((on_oval - 1.0).abs() < 0.1, "business slash endpoint off oval: {on_oval}");
    }
    assert!(y1 > 0.0 && y2 < 0.0);

    // 6. Use case ovals vs boxes.
    let shapes_svg = svg_of("Login(\"Sign in\")\nReport[Generate report]\n\"Reset password\"");
    let oval = node_group(&shapes_svg, "Login");
    assert!(oval.contains(r#"class="pele-node pele-usecase usecase-element usecase-ellipse""#));
    assert_eq!(oval.matches("<ellipse").count(), 1);
    assert!(oval.contains(">Sign in</text>"));
    let box_node = node_group(&shapes_svg, "Report");
    assert!(box_node.contains("usecase-rect"));
    assert_eq!(box_node.matches("<rect").count(), 1);
    assert_eq!(box_node.matches("<ellipse").count(), 0);
    assert!(node_group(&shapes_svg, "Reset_password").contains(">Reset password</text>"));
    let (_, _, login_rx, _) = ellipse_of(&shapes_svg, "Login");
    assert!(login_rx * 2.0 > METRICS_MEASURER.width("Sign in", 16.0, TextStyle::default()) + 30.0);

    // 7. Stereotypes on use cases and actors.
    let stereo_svg = svg_of("actor A <<Human>>\nU(Use) <<Core>>");
    let y_of_cls = |grp: &str, cls: &str| -> f64 {
        let pat = format!(r#"<text class="{cls}"[^>]* y="([-\d.]+)""#);
        Regex::new(&pat).unwrap().captures(grp).unwrap()[1].parse().unwrap()
    };
    let u_grp = node_group(&stereo_svg, "U");
    assert!(u_grp.contains(">«Core»</text>"));
    assert!(y_of_cls(&u_grp, "pele-stereotype") < y_of_cls(&u_grp, "pele-label"));
    let a_grp = node_group(&stereo_svg, "A");
    assert!(a_grp.contains(">«Human»</text>"));
    assert!(y_of_cls(&a_grp, "pele-stereotype") < y_of_cls(&a_grp, "pele-label"));
    assert!(y_of_cls(&a_grp, "pele-stereotype") > 0.0);

    // 8. System boundary containment & exterior actors.
    let bound_svg = svg_of("actor User\nsystemBoundary Shop[\"The shop\"]\n  Browse\n  actor Clerk\nend\nUser --> Browse");
    let shop = boundary_rects(&bound_svg, "Shop")[0];
    assert!(bound_svg.contains(r#"<g class="pele-cluster pele-boundary system-boundary system-boundary-rect" data-id="Shop">"#));
    assert!(bound_svg.contains(">The shop</text>"));
    let inside = |id: &str| {
        let (x, y) = at(&bound_svg, id);
        x > shop.x && x < shop.x + shop.w && y > shop.y && y < shop.y + shop.h
    };
    assert!(inside("Browse"));
    assert!(inside("Clerk"));
    assert!(!inside("User"));
    assert!(at(&bound_svg, "User").0 < shop.x);

    // Actor pointed at placed on far side of boundary.
    let far_svg = svg_of("actor User\nactor Bank\nsystemBoundary Shop\n  Pay\nend\nUser --> Pay\nPay --> Bank");
    let shop2 = boundary_rects(&far_svg, "Shop")[0];
    assert!(at(&far_svg, "User").0 < shop2.x);
    assert!(at(&far_svg, "Bank").0 > shop2.x + shop2.w);

    // 9. Boundary fill opacity when styled vs unstyled.
    let op_svg = svg_of("systemBoundary S\n  U\nend\nsystemBoundary T\n  V\nend\nstyle S fill:#fee");
    let find_body_rect = |id: &str| -> String {
        let start = op_svg.find(&format!(r#"data-id="{id}">"#)).unwrap();
        Regex::new(r"<rect [^>]*>")
            .unwrap()
            .find_iter(&op_svg[start..])
            .map(|m| m.as_str().to_string())
            .find(|r| r.contains(r#"fill="var(--_a)""#))
            .unwrap()
    };
    assert!(!find_body_rect("S").contains("fill-opacity"));
    assert!(find_body_rect("T").contains(r#"fill-opacity="0.5""#));

    // 10. Contrasting text colors on styled fills.
    let contrast_svg = svg_of(
        "actor A <<Human>>\nU(Use) <<Core>>\nW(Own)\nX(Plain)\njson J@{ \"k\": \"v\" }\nsystemBoundary S\n  V\nend\nstyle U fill:#1f3a5f\nstyle A fill:#1f3a5f\nstyle W fill:#1f3a5f,color:#eee\nstyle J fill:navy\nstyle S fill:#FFF9C4",
    );
    let u_c = node_group(&contrast_svg, "U");
    assert!(
        Regex::new(r#"<text class="pele-stereotype"[^>]* fill="var\(--pele-fg-on-dark,#fff\)""#)
            .unwrap()
            .is_match(&u_c)
    );
    assert!(
        Regex::new(r#"<text class="pele-label" fill="var\(--pele-fg-on-dark,#fff\)"[^>]*>Use<"#)
            .unwrap()
            .is_match(&u_c)
    );
    let a_c = node_group(&contrast_svg, "A");
    assert!(Regex::new(r#"<text class="pele-stereotype"[^>]* fill="var\(--_m\)""#).unwrap().is_match(&a_c));
    assert!(Regex::new(r#"<text class="pele-label" x=[^>]*>A<"#).unwrap().is_match(&a_c));
    assert!(!node_group(&contrast_svg, "W").contains("--pele-fg-on"));
    let j_c = node_group(&contrast_svg, "J");
    assert!(j_c.contains(r#"<text class="pele-json-key" fill="var(--pele-fg-on-dark,#fff)""#));
    assert!(j_c.contains(r#"<text class="pele-json-value" fill="var(--pele-fg-on-dark,#fff)""#));
    assert!(
        Regex::new(r#"data-id="S">.*?<text class="pele-cluster-label" fill="var\(--pele-fg-on-light,#1f1f1f\)""#)
            .unwrap()
            .is_match(&contrast_svg)
    );
    assert!(!node_group(&contrast_svg, "X").contains("--pele-fg-on"));

    // 11. Edge casings and interior edge ink + hollow marker fill inside styled boundary.
    let case_src = "actor User\nsystemBoundary S\n  Pay\n  Ship\nend\nPay --> Ship\nUser --> Pay\nUser --> Other\nstyle S fill:#BBDEFB";
    let case_svg = svg_of(case_src);
    let casings = &Regex::new(r#"<g class="pele-casings"[^>]*>(.*?)</g>"#).unwrap().captures(&case_svg).unwrap()[1];
    let edge_caps: Vec<(String, String)> = Regex::new(r#"class="pele-edge [^"]*" data-id="[^"]+"([^>]*)><path d="([^"]+)""#)
        .unwrap()
        .captures_iter(&case_svg)
        .map(|c| (c[1].to_string(), c[2].to_string()))
        .collect();
    assert_eq!(edge_caps.len(), 3);
    assert_eq!(
        edge_caps
            .iter()
            .map(|(_, d)| casings.contains(&format!(r#"<path d="{d}"/>"#)))
            .collect::<Vec<_>>(),
        vec![false, true, false]
    );
    assert_eq!(
        edge_caps.iter().map(|(a, _)| a.as_str()).collect::<Vec<_>>(),
        vec![r#" stroke="var(--pele-fg-on-light,#1f1f1f)""#, "", ""]
    );
    let unstyled = svg_of(&case_src.replace("\nstyle S fill:#BBDEFB", ""));
    assert!(!unstyled.contains("pele-casings"));
    assert!(!unstyled.contains(r#"stroke="var(--pele-fg-on"#));

    let hollow_edge = svg_of("systemBoundary S\n  Pay\n  Ship\nend\nPay --|> Ship\nstyle S fill:black");
    assert!(
        Regex::new(r#"class="pele-marker"[^>]* fill="black" stroke="var\(--pele-fg-on-dark,#fff\)""#)
            .unwrap()
            .is_match(&hollow_edge)
    );

    // 12. Package boundary tab.
    let pkg_svg = svg_of("systemBoundary P[\"Payments\"]@{ type: package }\n  Pay\nend");
    let pkg_rects = boundary_rects(&pkg_svg, "P");
    let (tab, body) = (pkg_rects[0], pkg_rects[1]);
    assert!(pkg_svg.contains("system-boundary-package"));
    assert!(pkg_svg.contains(r#"class="pele-boundary-tab""#));
    assert_eq!(tab.x, body.x);
    assert!(((tab.y + tab.h) - body.y).abs() < 0.2);
    assert!(tab.w < body.w);
    let title_caps = Regex::new(r#"<text class="pele-cluster-label"[^>]* x="([-\d.]+)" y="([-\d.]+)""#)
        .unwrap()
        .captures(&pkg_svg)
        .unwrap();
    let tx: f64 = title_caps[1].parse().unwrap();
    let ty: f64 = title_caps[2].parse().unwrap();
    assert!(tx > tab.x && tx < tab.x + tab.w);
    assert!(ty < body.y);
    assert!(at(&pkg_svg, "Pay").1 > body.y);

    // 13. Association markers.
    let m_svg = svg_of("A a@--> B\nA b@<-- B\nA c@-- B\nA d@--o B\nA e@o-- B\nA f@--x B\nA g@x-- B");
    let m_edges = edges_of(&m_svg);
    let by_id: HashMap<&str, &str> = m_edges.iter().map(|e| (e.id.as_str(), e.body.as_str())).collect();
    let marker_re = Regex::new(r#"<(path|circle) class="pele-marker""#).unwrap();
    let kinds = |id: &str| -> Vec<String> { marker_re.captures_iter(by_id[id]).map(|c| c[1].to_string()).collect() };
    assert_eq!(kinds("a"), vec!["path"]);
    assert_eq!(kinds("b"), vec!["path"]);
    assert!(kinds("c").is_empty());
    assert_eq!(kinds("d"), vec!["circle"]);
    assert_eq!(kinds("e"), vec!["circle"]);
    assert_eq!(kinds("f"), vec!["path"]);
    assert_eq!(kinds("g"), vec!["path"]);
    assert!(by_id["a"].contains(r#"stroke="none""#));
    assert!(!by_id["f"].contains(r#"stroke="none""#));
    for e in &m_edges {
        assert!(!e.body.contains("stroke-dasharray"));
    }

    // 14. Forward marker at target, backward at source.
    let dir_m_svg = svg_of("A a@--> B\nC b@<-- D");
    let dir_edges = edges_of(&dir_m_svg);
    let tip_x = |id: &str| -> f64 {
        let body = &dir_edges.iter().find(|e| e.id == id).unwrap().body;
        Regex::new(r#"class="pele-marker" d="M([-\d.]+),"#).unwrap().captures(body).unwrap()[1]
            .parse()
            .unwrap()
    };
    assert!((tip_x("a") - at(&dir_m_svg, "B").0).abs() < (tip_x("a") - at(&dir_m_svg, "A").0).abs());
    assert!((tip_x("b") - at(&dir_m_svg, "C").0).abs() < (tip_x("b") - at(&dir_m_svg, "D").0).abs());

    // 15. Include and extend dashed with guillemets.
    let ie_svg = svg_of("A i@..> : include B\nC e@..> : EXTEND D");
    let ie_edges = edges_of(&ie_svg);
    assert_eq!(ie_edges[0].classes, "pele-include");
    assert_eq!(ie_edges[1].classes, "pele-extend");
    for e in &ie_edges {
        assert!(e.body.contains(r#"stroke-dasharray="5 4""#));
        assert_eq!(e.body.matches(r#"class="pele-marker""#).count(), 1);
    }
    assert!(ie_svg.contains(">«include»</text>"));
    assert!(ie_svg.contains(">«extend»</text>"));
    assert_eq!(ie_svg.matches(r#"class="pele-edge-label""#).count(), 2);

    // 16. Generalization solid line + hollow triangle with line stopping at base.
    let gen_svg = svg_of("actor Admin\nactor Person\nAdmin --|> Person");
    let gen_edge = &edges_of(&gen_svg)[0];
    assert_eq!(gen_edge.classes, "pele-generalization");
    assert!(!gen_edge.body.contains("stroke-dasharray"));
    assert!(
        Regex::new(r#"<path class="pele-marker" d="M[-\d.]+,[-\d.]+L[-\d.]+,[-\d.]+L[-\d.]+,[-\d.]+Z" fill="var\(--_bg\)" stroke="var\(--_l\)""#)
            .unwrap()
            .is_match(&gen_edge.body)
    );
    let (_, _, ex, _) = path_ends(&gen_edge.d);
    let gen_tip: f64 = Regex::new(r#"class="pele-marker" d="M([-\d.]+),"#).unwrap().captures(&gen_edge.body).unwrap()[1]
        .parse()
        .unwrap();
    assert!(((gen_tip - ex) - 12.0).abs() < 1.0);

    // 17. Association label kept off nodes.
    let lbl_svg = svg_of("actor User\nUser -- \"starts a session\" --> Login");
    assert!(lbl_svg.contains(">starts a session</text>"));
    let lbl_caps = Regex::new(r#"<g class="pele-edge-label" data-id="edge-0"><rect x="([-\d.]+)" y="[-\d.]+" width="([\d.]+)""#)
        .unwrap()
        .captures(&lbl_svg)
        .unwrap();
    let left: f64 = lbl_caps[1].parse().unwrap();
    let right = left + lbl_caps[2].parse::<f64>().unwrap();
    let (lx, _, lrx, _) = ellipse_of(&lbl_svg, "Login");
    assert!(left > at(&lbl_svg, "User").0 + 20.0);
    assert!(right < lx - lrx);

    // 18. Edges end on oval outline and beside actor figure.
    let out_svg = svg_of("actor User\nUser --> Login\nUser --> Logout\nOther -- Login");
    for edge in edges_of(&out_svg) {
        let (sx, sy, ex, ey) = path_ends(&edge.d);
        let target = if edge.id == "edge-1" { "Logout" } else { "Login" };
        let (x, y, rx, ry) = ellipse_of(&out_svg, target);
        let reach = if edge.id == "edge-2" { 0.0 } else { 7.0 };
        let on_outline = ((ex + reach - x) / rx).powi(2) + ((ey - y) / ry).powi(2);
        assert!(on_outline > 0.85 && on_outline < 1.15, "{} not on outline: {on_outline}", edge.id);
        if edge.id != "edge-2" {
            let (ux, uy) = at(&out_svg, "User");
            assert!(((sx - ux) - 23.0).abs() < 1.0);
            assert!(sy < uy);
        }
    }

    // 19. Spreads relationships meeting on one side of a use case.
    let fan_svg = svg_of("actor A\nactor B\nactor C\nA --> U\nB --> U\nC --> U");
    let mut ys: Vec<f64> = edges_of(&fan_svg).iter().map(|e| path_ends(&e.d).3).collect();
    let unique: HashSet<i64> = ys.iter().map(|y| y.round() as i64).collect();
    assert_eq!(unique.len(), 3);
    ys.sort_by(|a, b| a.total_cmp(b));
    assert!(ys[1] - ys[0] > 6.0);

    // 20. Longer operators give more ranks.
    let near = svg_of("A --> B");
    let far = svg_of("A ----> B");
    assert!(at(&far, "B").0 - at(&far, "A").0 > at(&near, "B").0 - at(&near, "A").0 + 100.0);

    // 21. Self-loop in LR and TB.
    let loop_d_re = Regex::new(r"^M[-\d.,]+C[-\d., ]+$").unwrap();
    let loop_lbl_re = Regex::new(r#"<g class="pele-edge-label" data-id="loop"><rect x="([-\d.]+)" y="([-\d.]+)""#).unwrap();
    for dir in ["LR", "TB"] {
        let loop_svg = svg_of(&format!("direction {dir}\nLogin loop@..> : include Login"));
        let edge = &edges_of(&loop_svg)[0];
        assert!(loop_d_re.is_match(&edge.d));
        let (x, y, rx, ry) = ellipse_of(&loop_svg, "Login");
        let lcaps = loop_lbl_re.captures(&loop_svg).unwrap();
        let lx: f64 = lcaps[1].parse().unwrap();
        let ly: f64 = lcaps[2].parse().unwrap();
        if dir == "LR" {
            assert!(ly > y + ry);
        } else {
            assert!(lx > x + rx);
        }
        assert!(!loop_svg.contains("NaN"));
    }

    // 22. Notes attached with dotted line and no marker.
    let note_svg = svg_of("actor User\nnote for User \"Starts the workflow\"\nnote for Login \"`Needs a **session**`\"\nUser --> Login");
    assert_eq!(note_svg.matches(r#"class="pele-node pele-note usecase-note""#).count(), 2);
    assert!(note_svg.contains(">Starts the workflow</text>"));
    assert!(note_svg.contains(r#"<tspan font-weight="var(--_w)">session</tspan>"#));
    let connectors: Vec<EdgeMatch> = edges_of(&note_svg).into_iter().filter(|e| e.classes == "pele-note").collect();
    assert_eq!(connectors.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), vec!["note-0-edge", "note-1-edge"]);
    for c in connectors {
        assert!(c.body.contains(r#"stroke-dasharray="2 3""#));
        assert!(!c.body.contains("pele-marker"));
    }

    // 23. JSON table in written order with aligned columns.
    let json_svg = svg_of(
        "json Payload@{\n  \"2\": \"second\",\n  \"1\": \"first\",\n  \"colors\": [\"Red\", \"Green\"],\n  \"address\": { \"city\": \"Oslo\" },\n  \"none\": null,\n  \"empty\": {}\n}",
    );
    let table = node_group(&json_svg, "Payload");
    assert!(table.contains(r#"class="pele-node pele-json usecase-json-table""#));
    assert!(
        Regex::new(r#"<text class="pele-label" font-weight="var\(--_hw\)"[^>]*><tspan x="0" y="-95.9">Payload</tspan>"#)
            .unwrap()
            .is_match(&table)
    );
    let keys: Vec<String> = Regex::new(r#"<text class="pele-json-key"[^>]*>([^<]*)</text>"#)
        .unwrap()
        .captures_iter(&table)
        .map(|c| c[1].to_string())
        .collect();
    let values: Vec<String> = Regex::new(r#"<text class="pele-json-value"[^>]*>([^<]*)</text>"#)
        .unwrap()
        .captures_iter(&table)
        .map(|c| c[1].to_string())
        .collect();
    assert_eq!(keys, vec!["2", "1", "colors", "address.city", "none", "empty"]);
    assert_eq!(values, vec!["second", "first", "Red", "Green", "Oslo", "null", "{}"]);
    let val_xs: Vec<f64> = Regex::new(r#"<text class="pele-json-value"[^>]* x="([-\d.]+)""#)
        .unwrap()
        .captures_iter(&table)
        .map(|c| c[1].parse().unwrap())
        .collect();
    let lefts: Vec<f64> = val_xs
        .iter()
        .enumerate()
        .map(|(i, x)| x - METRICS_MEASURER.width(&values[i], 14.0, TextStyle::default()) / 2.0)
        .collect();
    for l in &lefts {
        assert!((l - lefts[0]).abs() < 0.2);
    }

    // 24. Plain labels, entities, markdown labels, markdown line breaks.
    let fmt_svg = svg_of("A(\"*n* <b>x</b> \\n &amp;\")\nQ(\"a #quot;q#quot; #40;b#41;\")\nB(\"`**bold** and *italic*`\")\nC(*literal*)");
    assert!(node_group(&fmt_svg, "A").contains(">*n* &lt;b&gt;x&lt;/b&gt; \\n &amp;amp;</text>"));
    assert!(node_group(&fmt_svg, "Q").contains(">a &quot;q&quot; (b)</text>"));
    let b_grp = node_group(&fmt_svg, "B");
    assert!(b_grp.contains(r#" font-weight="var(--_w)">bold</tspan>"#));
    assert!(b_grp.contains(r#"<tspan font-style="italic">italic</tspan>"#));
    assert!(node_group(&fmt_svg, "C").contains(">*literal*</text>"));

    let br_svg = svg_of("A(\"`first\nsecond`\")");
    let br_grp = node_group(&br_svg, "A");
    assert_eq!(br_grp.matches("<tspan").count(), 2);
    assert!(br_grp.contains(">first</tspan>"));
    assert!(br_grp.contains(">second</tspan>"));

    // 25. Classes, styles, animated edge dashes, front matter & acc, empty diagram.
    let sty_svg = svg_of(
        "actor A:::hot\nU(Use)\nsystemBoundary S\n  V\nend\nA e@--> U\nclassDef hot fill:#fee,stroke:#c33,color:#900\nclassDef default stroke-width:2px\nclass U,S,e hot\nstyle U stroke:#06c\nstyle e stroke-width:4px",
    );
    let a_sty = node_group(&sty_svg, "A");
    assert!(a_sty.contains(r#"usecase-actor-normal hot""#));
    assert!(a_sty.contains(r#"style="stroke-width:2px;fill:#fee;stroke:#c33;""#));
    assert!(a_sty.contains(r#"style="fill:#900;""#));
    assert!(
        node_group(&sty_svg, "U").contains(r#"<ellipse rx="44" ry="26" fill="var(--_s)" stroke="var(--_b)" style="stroke-width:2px;fill:#fee;stroke:#06c;"/>"#)
    );
    assert!(
        Regex::new(r#"<g class="pele-cluster pele-boundary system-boundary system-boundary-rect hot" data-id="S"><rect[^>]* style="rx:var\(--_r\);stroke-width:2px;fill:#fee;stroke:#c33;""#)
            .unwrap()
            .is_match(&sty_svg)
    );
    assert!(sty_svg.contains(r#"<g class="pele-edge pele-association hot" data-id="e" style="stroke-width:4px;stroke:#c33;">"#));
    assert!(edges_of(&sty_svg)[0].body.contains(r##"fill="#c33" stroke="none""##));

    let anim_svg = svg_of("A e@--> B\ne@{ animation: slow }\nA f@--> B\nf@{ animate: false }");
    let anim_edges = edges_of(&anim_svg);
    assert_eq!(anim_edges[0].classes, "pele-association edge-animation-slow");
    assert!(anim_edges[0].body.contains(r#"stroke-dasharray="9 5""#));
    assert!(!anim_edges[1].body.contains("stroke-dasharray"));

    let acc_svg = render(
        "---\ntitle: Ordering\n---\nusecase-beta\naccTitle: Online ordering\naccDescr {\n  A customer orders.\n   Staff review.\n}\nactor A",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(acc_svg.contains(r#"<text class="pele-title" font-weight="var(--_tw)""#));
    assert!(acc_svg.contains(">Ordering</tspan>"));
    assert!(acc_svg.contains(r#"<title id="pele-title">Online ordering</title>"#));
    assert!(acc_svg.contains("<desc id=\"pele-desc\">A customer orders.\nStaff review.</desc>"));

    let empty = render("usecase-beta", &css_options()).unwrap();
    assert!(empty.svg.contains(r#"<g class="pele-nodes"></g>"#));
    assert!(empty.width > 0.0);

    // 26. Exact Mermaid-worded syntax, lexer, JSON, and semantic errors.
    let err_msg = |input: &str| -> String {
        let e = render(input, &css_options()).unwrap_err();
        let code = match e.code {
            ErrorCode::Syntax => "syntax",
            ErrorCode::Semantic => "semantic",
            ErrorCode::Limit => "limit",
            ErrorCode::UnsupportedDiagram => "unsupported-diagram",
        };
        format!("{code}: {}", e.message)
    };
    assert_eq!(
        err_msg("usecase-beta\nactor A actor B"),
        "syntax: Error parsing usecase diagram: Expecting: one of these possible Token sequences:\n  1. [NEWLINE]\n  2. [EOF]\nbut found: 'actor' at line 2, column 9 [21,26)"
    );
    assert_eq!(
        err_msg("usecase-beta\nsystemBoundary S\nA --> B\nend"),
        "syntax: Error parsing usecase diagram: Expecting: one of these possible Token sequences:\n  1. [NEWLINE]\n  2. [EOF]\nbut found: '-->' at line 3, column 3 [32,35)"
    );
    assert_eq!(
        err_msg("usecase-beta\nsystemBoundary S\nA"),
        "syntax: Error parsing usecase diagram: Expecting token of type --> END <-- but found --> '' <-- at line 4, column 1 [32,32)"
    );
    assert_eq!(
        err_msg("usecase-beta\nA \"b"),
        "syntax: Error lexing usecase diagram: unexpected character: ->\"<- at offset: 15, skipped 1 characters. at line 2, column 3 [15,16)"
    );
    assert_eq!(
        err_msg("usecase-beta\nnote for Ghost \"x\""),
        "semantic: Note target 'Ghost' is unresolved at line 2, column 10 [22,27)"
    );
    assert!(
        Regex::new(r"^syntax: Invalid JSON: .* \(line 2, column \d+\)$")
            .unwrap()
            .is_match(&err_msg("usecase-beta\njson P@{\"a\":}"))
    );
    let ent_err = render("usecase-beta\njson P@{\"a\":\"#35;\", \"b\":}", &css_options()).unwrap_err();
    assert_eq!((ent_err.line, ent_err.column), (2, 25));
    assert!(!ent_err.message.chars().any(|c| matches!(c, 'ﬂ' | '°' | '¶' | 'ß')));

    let loc_err = render("usecase-beta\nactor A\nA --> B\nstyle Z fill:red", &css_options()).unwrap_err();
    assert_eq!(loc_err.code, ErrorCode::Semantic);
    assert_eq!(loc_err.diagram_type, Some(DiagramType::Usecase));
    assert_eq!((loc_err.line, loc_err.column), (4, 7));
}

#[test]
fn usecase_compat_lexer_and_grammar() {
    fn token_images(input: &str) -> Vec<(&'static str, &str)> {
        let toks = tokenize(input, None).unwrap_or_else(|e| panic!("lex `{input}` failed: {e}"));
        let mut out = Vec::new();
        for i in 0..toks.types.len() {
            if toks.types[i] == UsecaseToken::Eof {
                break;
            }
            out.push((toks.types[i].name(), &input[toks.starts[i]..toks.ends[i]]));
        }
        out
    }

    // Longest operator and delimiter precedence.
    assert_eq!(
        token_images("--|> ..> <<Human>> ::: ---> <--- --o o-- --x x-- --"),
        vec![
            ("GENERALIZATION", "--|>"),
            ("DEPENDENCY_ARROW", "..>"),
            ("STEREOTYPE_START", "<<"),
            ("STEREOTYPE_TEXT", "Human"),
            ("STEREOTYPE_END", ">>"),
            ("CLASS_SEPARATOR", ":::"),
            ("FORWARD_SOLID", "--->"),
            ("BACKWARD_SOLID", "<---"),
            ("FORWARD_CIRCLE", "--o"),
            ("BACKWARD_CIRCLE", "o--"),
            ("FORWARD_CROSS", "--x"),
            ("BACKWARD_CROSS", "x--"),
            ("MARKERLESS_SOLID", "--"),
        ]
    );

    // Exact keywords vs identifiers and case-insensitive include/extend.
    assert_eq!(
        token_images("actor actorName include INCLUDE Include included extend EXTEND extended"),
        vec![
            ("ACTOR", "actor"),
            ("IDENTIFIER", "actorName"),
            ("INCLUDE", "include"),
            ("INCLUDE", "INCLUDE"),
            ("INCLUDE", "Include"),
            ("IDENTIFIER", "included"),
            ("EXTEND", "extend"),
            ("EXTEND", "EXTEND"),
            ("IDENTIFIER", "extended"),
        ]
    );

    // One token per physical newline for LF, CRLF, CR.
    for nl in ["\n", "\r\n", "\r"] {
        let input = format!("{nl}{nl}");
        let imgs = token_images(&input);
        assert_eq!(imgs.len(), 2);
        assert!(imgs.iter().all(|(name, _)| *name == "NEWLINE"));
    }

    // Multiline Markdown with comment lookalikes.
    assert_eq!(
        token_images("\"`first\n%% still markdown\nlast`\""),
        vec![("MARKDOWN_STRING", "\"`first\n%% still markdown\nlast`\"")]
    );

    // Indented whole-line comments vs inline percent pairs.
    assert_eq!(token_images("  %% comment\n"), vec![("COMMENT", "%% comment"), ("NEWLINE", "\n")]);
    assert_eq!(
        token_images("A %% data").into_iter().map(|(k, _)| k).collect::<Vec<_>>(),
        vec!["IDENTIFIER", "PERCENT", "PERCENT", "IDENTIFIER"]
    );

    // Nested JSON balancing.
    let json_src = "json Payload@{\n  \"text\": \"} \\\" {\",\n  \"nested\": {\"items\": [1, 2]}\n}:::data";
    assert_eq!(
        token_images(json_src).into_iter().map(|(k, _)| k).collect::<Vec<_>>(),
        vec!["JSON_DECLARATION_START", "JSON_OBJECT_LITERAL", "CLASS_SEPARATOR", "IDENTIFIER"]
    );

    // Unclosed JSON, Markdown, and stereotypes consumed once without quadratic rescanning.
    let unclosed_json = format!("json Payload@{{{}", "{".repeat(32_000));
    let ujson = tokenize(&unclosed_json, None).unwrap();
    let ujson_non_eof: Vec<usize> = (0..ujson.types.len()).filter(|&i| ujson.types[i] != UsecaseToken::Eof).collect();
    let last_non_eof = *ujson_non_eof.last().unwrap();
    assert_eq!(ujson.types[last_non_eof], UsecaseToken::UnclosedJsonObjectLiteral);
    assert_eq!(ujson.starts[last_non_eof], 13);

    let unclosed_md = "\"`x".repeat(32_000);
    let umd = tokenize(&unclosed_md, None).unwrap();
    let umd_non_eof: Vec<UsecaseToken> = umd.types.iter().copied().filter(|&t| t != UsecaseToken::Eof).collect();
    assert_eq!(umd_non_eof, vec![UsecaseToken::UnclosedMarkdownString]);

    let unclosed_st = format!("<<{}", "x".repeat(128_000));
    let ust = tokenize(&unclosed_st, None).unwrap();
    let ust_non_eof: Vec<UsecaseToken> = ust.types.iter().copied().filter(|&t| t != UsecaseToken::Eof).collect();
    assert_eq!(ust_non_eof, vec![UsecaseToken::StereotypeStart, UsecaseToken::UnclosedStereotypeText]);

    // Strings, colors, CSS units, escaped commas, leftover punctuation & non-ASCII, digit-leading IDs.
    assert_eq!(
        token_images("\"%%\" 'plain' #f96 4px 50% red\\,blue"),
        vec![
            ("PLAIN_STRING", "\"%%\""),
            ("PLAIN_STRING", "'plain'"),
            ("HASH_COLOR", "#f96"),
            ("IDENTIFIER", "4px"),
            ("IDENTIFIER", "50"),
            ("PERCENT", "%"),
            ("IDENTIFIER", "red"),
            ("CSS_ESCAPED_COMMA", "\\,"),
            ("IDENTIFIER", "blue"),
        ]
    );
    assert_eq!(
        token_images("*bold* ; < > ` \\ Ärlig 日本語"),
        vec![
            ("CSS_PUNCTUATION", "*"),
            ("IDENTIFIER", "bold"),
            ("CSS_PUNCTUATION", "*"),
            ("LABEL_PUNCTUATION", ";"),
            ("LABEL_PUNCTUATION", "<"),
            ("LABEL_PUNCTUATION", ">"),
            ("LABEL_PUNCTUATION", "`"),
            ("LABEL_PUNCTUATION", "\\"),
            ("LABEL_SYMBOL", "Ä"),
            ("IDENTIFIER", "rlig"),
            ("LABEL_SYMBOL", "日本語"),
        ]
    );
    assert_eq!(
        token_images("<-- --> ..> ::: @{ \\,"),
        vec![
            ("BACKWARD_SOLID", "<--"),
            ("FORWARD_SOLID", "-->"),
            ("DEPENDENCY_ARROW", "..>"),
            ("CLASS_SEPARATOR", ":::"),
            ("METADATA_START", "@{"),
            ("CSS_ESCAPED_COMMA", "\\,"),
        ]
    );
    assert_eq!(
        token_images("1 1mg a1 _x"),
        vec![("IDENTIFIER", "1"), ("IDENTIFIER", "1mg"), ("IDENTIFIER", "a1"), ("IDENTIFIER", "_x"),]
    );
    assert_eq!(token_images("1.5 1.5px .5"), vec![("NUMBER", "1.5"), ("NUMBER", "1.5px"), ("NUMBER", ".5")]);

    // Accepted canonical grammar samples (including all 25 canonical relations + oracle SEEDS).
    for accepted in [
        "usecase-beta",
        "usecase-beta\nactor User",
        "usecase-beta\r\nactor User\r\n",
        "usecase-beta\ractor User\r",
        "usecase-beta\n\n  %% retained\nLogin",
        "usecase-beta\nactor Admin(\"Main Administrator\")@{ type: hollow, business: true } <<Human>>:::external\nactor \"System Administrator\", \"`**Automation**`\"\nLogin(Sign in)@{ business: false } <<Primary>>:::critical\nReport[Generate report]\n\"Reset password\"\n\"`**Markdown** use case`\"",
        "usecase-beta\nUser@{\n  business: true\n  type: normal,\n}\nactor User",
        "usecase-beta\nA --> B\nA <-- B\nA -- B\nA --o B\nA o-- B\nA --x B\nA x-- B",
        "usecase-beta\nA -- \"starts session\" --> B\nA <-- \"reverse label\" -- B\nA -- label -- B\nA -- label --o B\nA o-- label -- B\nA -- label --x B\nA x-- label -- B",
        "usecase-beta\nA ..> : include B\nA ..> : INCLUDE B\nA ..> : ExTeNd B\nA --|> B",
        "usecase-beta\nA ---> B\nA <---- B\nA ---- B\nA -- longer ----> B\nA login@--> B\nA dependency@..> : include B",
        "usecase-beta\nsystemBoundary \"Authentication System\":::system\n  %% boundary comment\n  actor User, Admin(\"Administrator\")\n\n  Login(\"Sign in\"):::critical\n  Report[Generate report]\nend\nUser --> Login",
        "usecase-beta\nsystemBoundary sb1[\"Payment service\"]@{ type: package }:::system\n  Authorize(\"Authorize payment\")\nend\nsystemBoundary sb2(Billing)@{\n  type: rect\n}:::billing\n  Invoice[Create invoice]\nend\nsystemBoundary sb3(\"`**Support**`\")\n  Refund[Issue refund]\nend",
        "usecase-beta\ndirection LR\nsystemBoundary Auth\n  Login\nend\nAuth@{ type: package }\nnote for Login \"`Requires an **active session**`\"\njson Payload@{\n  \"fruit\": \"Apple\",\n  \"nested\": { \"brace\": \"}\", \"items\": [1, 2] }\n}:::data\nclassDef external,critical fill:#fff,stroke-width:3px\nclass Login,Payload external,critical\nstyle Login fill:#fee,stroke-dasharray:5\\,5",
        "usecase-beta\naccTitle: Authentication use cases\naccDescr: Actors and authentication flows",
        "usecase-beta\naccDescr {\n  Actors authenticate,\n  reset credentials, and sign out.\n}",
        // Oracle SEEDS from upstream tests/usecase/oracle.test.ts.
        "usecase-beta\nactor A, B(\"Bee\")@{ type: hollow } <<Role>>, \"C d\":::c\nA --> U\n",
        "usecase-beta\nactor A x@--> U(Use it)@{ business: true } <<S>>:::c\nx@{ animate: true }\nclass x,A,U c,d\nstyle x stroke:red\n",
        "usecase-beta\n\"A b\" --> \"C d\"\n\"`E *f*`\" -- \"g h\" --> I[Rect]\nI <-- \"j\" -- K\nK o-- l m -- M\nM x-- \"n\" -- N\nN -- o --o P\nP -- q --x Q\n",
        "usecase-beta\nA ---> B\nB <---- C\nC ----- D\nD -- e ----> F\nF -- g ---- H\nH <-- i ---- J\nJ -- \"\" --> K\n",
        "usecase-beta\nA ..> : include B\nB ..> : EXTEND C\nC ..> : eXtend D\nC --|> D\nactor E\nactor F\nE --|> F\n",
        "usecase-beta\nsystemBoundary S[\"T t\"]@{\n  type: package,\n}:::c,d\n  %% in\n\n  actor A, B\n  U(Use)\n  \"V w\"@{ business: true } <<S>>:::c\nend\nS@{ type: rect }\n",
        "usecase-beta\nsystemBoundary \"A b\"\nend\nA_b@{ type: package }\nnote for U \"n\"\nnote for U n o p\nU\n",
        "usecase-beta\njson P@{\"2\":\"b\",\"1\":\"a\",\"n\":{\"x\":[1,{\"y\":null}],\"e\":{}},\"n\":{\"z\":true}}:::c\njson Q @ {}\nU --> P\nP -- Q\nclassDef c,d fill:#eef,stroke:#369\nstyle P stroke-width:4px\n",
        "usecase-beta\nA@{ type: hollow }\nactor A\nB@{\n  business: true\n\n  , \"business\": false\n}\nB\nactor C@{ icon: \"fa:user\" }\nC@{ icon: \"x\", type: normal }\n",
        "usecase-beta\nclassDef a,b fill:#fff,stroke-width:3px,font-family:Arial Black,-- x:1,a-b:c\\,d,x:\"q\" 1.5px #f00 50% (a) [b] {c} @ -- !\nA\nclass A a,b\nstyle A stroke-dasharray:5\\,5,fill:red\n",
        "usecase-beta\naccTitle: T t\naccDescr: D d\naccDescr {\n  a\n   b\n}\ndirection TD\ndirection RL\n",
        "usecase-beta\r\nactor A\r\nA --> B\r%% c\r\n",
        "usecase-beta\nA <<x>>\nA <<x>>:::c\nB(l)\nB(l)\nactor C(\"l\")\nactor C(\"l\")\nD <<y>> --> E\nD[D]\n",
        "usecase-beta\n1 --> 2\n1mg --> 3rd\nactor 4(\"x\")\n5[y]\n",
        "usecase-beta\nA e@--> B\ne@{ animation: fast, animate: false }\nB --> C\nD\nC(C)\n",
    ] {
        parse_usecase(accepted, None, None).unwrap_or_else(|e| panic!("expected accepted `{accepted}`, got: {e}"));
    }

    // Rejected grammar samples (from usecase.parser.spec.ts + oracle REJECTED).
    for rejected in [
        "Usecase\nA",
        "usecase-beta\nactor A actor B",
        "usecase actor A",
        "usecase-beta\nactor A, B --> C",
        "usecase-beta\nunknown command",
        "usecase-beta\n// not a comment",
        "usecase-beta\n# not a comment",
        "usecase-beta\nA; B",
        "usecase-beta\n:User:",
        "usecase-beta\nactor User as U",
        "usecase-beta\nusecase \"Login\" as Login",
        "usecase-beta\nnewpage",
        "usecase-beta\npackage \"Auth\" {",
        "usecase-beta\nrectangle \"Auth\" {",
        "usecase-beta\nskinparam actorStyle awesome",
        "usecase-beta\nallowmixing",
        "usecase-beta\n== Section ==",
        "usecase-beta\nA \\n B",
        "usecase-beta\nA -left-> B",
        "usecase-beta\nnote left of Login \"text\"",
        "usecase-beta\nnote for Login as N \"text\"",
        "usecase-beta\nnote for Login,Report \"text\"",
        "usecase-beta\nsystemBoundary A\nsystemBoundary B\nend\nend",
        "usecase-beta\nsystemBoundary A\nUser --> Login\nend",
        "usecase-beta\nsystemBoundary A\nnote for User \"text\"\nend",
        "usecase-beta\nsystemBoundary A\njson Payload@{}\nend",
        "usecase-beta\nA ---o B",
        "usecase-beta\nA o--- B",
        "usecase-beta\nA ---x B",
        "usecase-beta\nA ---|> B",
        "usecase-beta\nA ...> : include B",
        "usecase-beta\nA <<>>",
        "usecase-beta\nA <<first\nsecond>>",
        "usecase-beta\nA <<primary",
        "usecase-beta\njson Payload@{\"nested\": {",
        "usecase-beta\nA(\"`unfinished\")",
        "usecase-beta\nstyle A fill:red;stroke:blue",
        "usecase-beta\nsystemBoundary A:::system@{ type: package }\nend",
        "usecase-beta\nsystemBoundary A <<S>>\nend",
        "usecase-beta\nsystemBoundary [Payment service]\nend",
        "usecase-beta\nA e@",
        "usecase-beta\nA -->",
        "usecase-beta\nA -- l m",
        "usecase-beta\nA <--- l -- B",
        "usecase-beta\nA --- l --> B",
        "usecase-beta\nA <-- l --> B",
        "usecase-beta\nA o-- l --o B",
        "usecase-beta\nA x-- \"l\" --x B",
        "usecase-beta\nA -- \"l\" \"m\" --> B",
        "usecase-beta\nactor",
        "usecase-beta\nA@{",
        "usecase-beta\nA@{ k: v,\n\n}",
        "usecase-beta\nstyle A fill:",
        "usecase-beta\nnote for",
        "usecase-beta\nsystemBoundary S\nA",
        "usecase-beta\nA <<",
        "usecase-beta\nA <<\n\r\nB",
        "usecase-beta\nA \"'\nB",
        "usecase-beta\nA '\"'\" x\nB",
        "usecase-beta\nA \"b\nC",
        "usecase-beta\njson P@{\"a\":",
        "usecase-beta\n\"`a",
    ] {
        assert!(parse_usecase(rejected, None, None).is_err(), "expected rejected: `{rejected}`");
    }
}

#[test]
fn usecase_compat_json_parser() {
    // 1. Escaped JSON Pointer order for nested objects and arrays.
    let res = parse_ordered_json(
        r#"{
        "a/b": {
          "items": [
            { "~name": "first", "id": 1 },
            { "id": 2, "details": { "enabled": true } }
          ]
        },
        "last": null
      }"#,
        || (1, 1),
    )
    .unwrap();
    assert_eq!(res.property_order[""], vec!["a/b", "last"]);
    assert_eq!(res.property_order["/a~1b"], vec!["items"]);
    assert_eq!(res.property_order["/a~1b/items/0"], vec!["~name", "id"]);
    assert_eq!(res.property_order["/a~1b/items/1"], vec!["id", "details"]);
    assert_eq!(res.property_order["/a~1b/items/1/details"], vec!["enabled"]);
    assert_eq!(res.value["last"], JsonValue::Null);

    // 2. Integer-like property names preserve source order.
    let res2 = parse_ordered_json(r#"{"10":"ten","2":"two","1":"one","plain":true}"#, || (1, 1)).unwrap();
    assert_eq!(res2.property_order[""], vec!["10", "2", "1", "plain"]);

    // 3. Duplicate key stays first in order, retains last value & nested order, discards old nested.
    let res3 = parse_ordered_json(
        r#"{
        "entry": { "discarded": { "old": true } },
        "tail": 0,
        "entry": { "second": 2, "first": 1, "\u0073econd": 3 }
      }"#,
        || (1, 1),
    )
    .unwrap();
    assert_eq!(res3.property_order[""], vec!["entry", "tail"]);
    assert_eq!(res3.property_order["/entry"], vec!["second", "first"]);
    assert!(!res3.property_order.contains_key("/entry/discarded"));
    let JsonValue::Object(entry) = &res3.value["entry"] else {
        panic!("expected object");
    };
    assert_eq!(entry["second"], JsonValue::Number(3.0));
    assert_eq!(entry["first"], JsonValue::Number(1.0));

    // 4. Empty objects, arrays, strings.
    let res4 = parse_ordered_json(r#"{"emptyObject":{},"emptyArray":[],"emptyString":""}"#, || (4, 9)).unwrap();
    assert_eq!(res4.property_order[""], vec!["emptyObject", "emptyArray", "emptyString"]);
    assert_eq!(res4.property_order["/emptyObject"], Vec::<String>::new());
    assert_eq!(res4.value["emptyArray"], JsonValue::Array(vec![]));
    assert_eq!(res4.value["emptyString"], JsonValue::String(String::new()));

    // 5. Braces, brackets, escaped quotes inside string values.
    let res5 = parse_ordered_json(
        r#"{"text":"a } and { plus [brackets] and \"quotes\"","nested":{"value":"{\"key\": 1}"}}"#,
        || (1, 1),
    )
    .unwrap();
    assert_eq!(res5.value["text"], JsonValue::String("a } and { plus [brackets] and \"quotes\"".to_string()));
    assert_eq!(res5.property_order["/nested"], vec!["value"]);

    // 6. Rejects scalar, null, array roots.
    for non_obj in ["true", "null", r#"[{"nested":true}]"#] {
        let err = parse_ordered_json(non_obj, || (12, 5)).unwrap_err();
        assert!(err.message.contains("JSON value must have an object root"));
        assert_eq!((err.line, err.column), (12, 5));
    }

    // 7. Maps malformed JSON offset across physical lines.
    let err_ml = parse_ordered_json("{\n  \"valid\": true,\n  \"invalid\":\n}", || (20, 7)).unwrap_err();
    assert!(err_ml.message.contains("Invalid JSON"));
    assert_eq!((err_ml.line, err_ml.column), (23, 1));

    // 8. Adds token start column on first line.
    let err_col = parse_ordered_json(r#"{"key":,}"#, || (8, 12)).unwrap_err();
    assert_eq!((err_col.line, err_col.column), (8, 19));

    // 9. Maps CRLF as one physical line break.
    let err_crlf = parse_ordered_json("{\r\n  \"key\": true,\r\n}", || (30, 4)).unwrap_err();
    assert_eq!((err_crlf.line, err_crlf.column), (32, 1));
}

#[test]
fn usecase_compat_parser_publication_ast_spans_and_semantic_errors() {
    // 1. Header at EOF -> empty model & header span.
    let empty = parse_usecase("usecase-beta", None, None).unwrap();
    assert!(empty.actors.is_empty());
    assert!(empty.use_cases.is_empty());
    assert_eq!(empty.direction, Direction::LR);
    assert_eq!(empty.header_span, (0, 12));
    assert!(empty.statements.is_empty());

    // 2. Accessibility text & spans.
    let acc_src = "usecase-beta\naccTitle: Authentication use cases\naccDescr {\n  First line\n  Second line\n}\nactor User";
    let acc = parse_usecase(acc_src, None, None).unwrap();
    assert_eq!(acc.acc_title, "Authentication use cases");
    assert_eq!(acc.acc_descr, "First line\nSecond line");
    assert_eq!(acc.acc_description, "First line\n  Second line");
    assert_eq!(acc.statements.len(), 3);
    assert_eq!(acc.statements[0].kind, StatementKind::AccTitle);
    assert_eq!(acc.statements[1].kind, StatementKind::AccDescr);
    assert_eq!(acc.statements[2].kind, StatementKind::Node);
    assert_eq!(acc.statements[2].span, (acc_src.find("actor User").unwrap(), acc_src.len()));

    // 3. Final statement without newline + exact spans.
    let fin_src = "usecase-beta\nactor User";
    let fin = parse_usecase(fin_src, None, None).unwrap();
    assert_eq!(fin.actors["User"].label, "User");
    let st = &fin.statements[0];
    assert_eq!(st.kind, StatementKind::Node);
    assert_eq!(st.span, (13, 23));
    let n = &st.nodes.as_ref().unwrap()[0];
    assert_eq!(
        (n.id.as_str(), n.span, n.id_span, n.label_span, n.defines),
        ("User", (19, 23), (19, 23), Some((19, 23)), true)
    );

    // 4. Forward refinement order independence (actor and rect use case).
    for (decl, rel) in [("actor User", "User --> Login"), ("Login[Sign in]", "User --> Login")] {
        let a = parse_usecase(&format!("usecase-beta\n{decl}\n{rel}"), None, None).unwrap();
        let b = parse_usecase(&format!("usecase-beta\n{rel}\n{decl}"), None, None).unwrap();
        assert_eq!(a.actors, b.actors);
        assert_eq!(a.use_cases, b.use_cases);
        assert_eq!(a.relationships, b.relationships);
    }

    // 5. Unresolved endpoints finalize as ellipse use cases without actor inference.
    let unres = parse_usecase("usecase-beta\nLeft --> Right", None, None).unwrap();
    assert!(unres.actors.is_empty());
    assert_eq!(unres.use_cases["Left"].shape, UseCaseShape::Ellipse);
    assert_eq!(unres.use_cases["Right"].shape, UseCaseShape::Ellipse);

    // 6. Equivalent repeated declarations merge cleanly.
    let merged = parse_usecase(
        "usecase-beta\nsystemBoundary Auth\nactor User(\"Person\")@{ type: hollow } <<Human>>\nactor User(\"Person\")@{ type: hollow } <<Human>>\nLogin[Sign in] <<Primary>>\nLogin[Sign in] <<Primary>>\nend",
        None,
        None,
    )
    .unwrap();
    assert_eq!(merged.actors.len(), 1);
    assert_eq!(merged.actors["User"].actor_type, ActorType::Hollow);
    assert_eq!(merged.actors["User"].parent_id.as_deref(), Some("Auth"));
    assert_eq!(merged.use_cases["Login"].shape, UseCaseShape::Rect);
    assert_eq!(merged.system_boundaries["Auth"].members, vec!["User", "Login"]);

    // 7. Conflicting declarations, collisions, unresolved targets.
    for (body, id) in [
        ("actor Shared\nShared", "Shared"),
        ("Login(Sign in)\nLogin[Sign in]", "Login"),
        ("Login(First label)\nLogin(Second label)", "Login"),
        ("Login <<Primary>>\nLogin <<Secondary>>", "Login"),
        ("systemBoundary First\nLogin\nend\nsystemBoundary Second\nLogin\nend", "Login"),
        ("\"A-B\"\n\"A B\"", "A_B"),
        ("\"A B\"\nA_B(Explicit)", "A_B"),
        ("actor Shared\njson Shared@{}", "Shared"),
        ("actor link\nA link@--> B", "link"),
        ("A link@--> B\nB link@--> C", "link"),
        ("note for Ghost \"Missing\"", "Ghost"),
        ("class Ghost important", "Ghost"),
        ("style Ghost fill:red", "Ghost"),
        ("Ghost@{ type: package }", "Ghost"),
    ] {
        let err = parse_usecase(&format!("usecase-beta\n{body}"), None, None).unwrap_err();
        assert!(err.message.contains(id), "expected `{id}` in `{}`", err.message);
    }

    // 8. Exact semantic error wording + spans for collisions, metadata, relations, notes, business, JSON, boundaries.
    let exact_cases: Vec<(&str, String)> = {
        let g1 = "usecase-beta\n\"A-B\"\n\"A B\"";
        let g2 = "usecase-beta\n\"A B\"\nA_B(Explicit)";
        let g3 = "usecase-beta\nactor \"A-B\"\n\"A B\"";
        let g4 = "usecase-beta\nA link@--> B\nB link@--> C";
        let m1 = "usecase-beta\nactor User@{ type: giant }";
        let m2 = "usecase-beta\nactor User@{ fillColor: red }";
        let m3 = "usecase-beta\nactor User@{ icon: \"fa:user\", type: awesome }";
        let r1 = "usecase-beta\nactor User\nLogin\nUser --|> Login";
        let r2 = "usecase-beta\nactor User\nactor Admin\nUser ..> : include Admin";
        let c1 = "usecase-beta\nA known@--> B\nclass missingEdge decorated";
        let s1 = "usecase-beta\nA known@--> B\nstyle missingEdge stroke:red";
        let a1 = "usecase-beta\nA link@--> B\nlink@{ animation: medium }";
        let a2 = "usecase-beta\nA link@--> B\nlink@{ animate: fast }";
        let n1 = "usecase-beta\njson Payload@{}\nnote for Payload \"invalid\"";
        let n2 = "usecase-beta\nsystemBoundary Auth\nLogin\nend\nnote for Auth \"invalid\"";
        let n3 = "usecase-beta\nA link@--> B\nnote for link \"invalid\"";
        let b1 = "usecase-beta\nactor Icon@{ icon: \"fa:user\", business: true }";
        let b2 = "usecase-beta\nactor Awesome@{ type: awesome, business: true }";
        let b3 = "usecase-beta\nReport[Generate report]@{ business: true }";
        let j1 = "usecase-beta\njson Payload@{}\nInspect\nPayload ..> : include Inspect";
        let j2 = "usecase-beta\njson Payload@{}\nInspect --o Payload";
        let bm = "usecase-beta\nsystemBoundary sb1[\"Payment service\"]@{ animate: true }\nAuthorize(\"Authorize payment\")\nend";
        vec![
            (
                g1,
                format!(
                    "Generated ID 'A_B' collides with another declaration at {} (label \"A B\"); previous declaration at {} (label \"A-B\")",
                    occurrence_location(g1, "\"A B\"", 1, 1, 1),
                    occurrence_location(g1, "\"A-B\"", 1, 1, 1)
                ),
            ),
            (
                g2,
                format!(
                    "Generated ID 'A_B' collides with another declaration at {}; previous declaration at {} (label \"A B\")",
                    occurrence_location(g2, "A_B", 1, 0, 0),
                    occurrence_location(g2, "\"A B\"", 1, 1, 1)
                ),
            ),
            (
                g3,
                format!(
                    "ID 'A_B' is declared as both actor and usecase at {} (label \"A B\"); previous declaration at {} (label \"A-B\")",
                    occurrence_location(g3, "\"A B\"", 1, 1, 1),
                    occurrence_location(g3, "\"A-B\"", 1, 1, 1)
                ),
            ),
            (
                g4,
                format!(
                    "ID 'link' is declared more than once (edge and edge) at {}; previous declaration at {}",
                    occurrence_location(g4, "link", 2, 0, 0),
                    occurrence_location(g4, "link", 1, 0, 0)
                ),
            ),
            (
                m1,
                format!(
                    "Metadata property 'type' is invalid for actor 'User' at {}",
                    occurrence_location(m1, "type", 1, 0, 0)
                ),
            ),
            (
                m2,
                format!(
                    "Metadata property 'fillColor' is invalid for actor 'User' at {}",
                    occurrence_location(m2, "fillColor", 1, 0, 0)
                ),
            ),
            (
                m3,
                format!(
                    "Actor 'User' cannot combine icon with type 'awesome' at {}",
                    occurrence_location(m3, "User", 1, 0, 0)
                ),
            ),
            (
                r1,
                format!(
                    "Generalization requires actor-to-actor or use-case-to-use-case endpoints at {}",
                    occurrence_location(r1, "--|> Login", 1, 0, 0)
                ),
            ),
            (
                r2,
                format!(
                    "include relationship requires use-case endpoints at {}",
                    occurrence_location(r2, "..> : include Admin", 1, 0, 0)
                ),
            ),
            (
                c1,
                format!(
                    "Class/style target 'missingEdge' is unresolved or anonymous at {}",
                    occurrence_location(c1, "missingEdge", 1, 0, 0)
                ),
            ),
            (
                s1,
                format!(
                    "Class/style target 'missingEdge' is unresolved or anonymous at {}",
                    occurrence_location(s1, "missingEdge", 1, 0, 0)
                ),
            ),
            (
                a1,
                format!(
                    "Metadata property 'animation' is invalid for edge 'link' at {}",
                    occurrence_location(a1, "animation", 1, 0, 0)
                ),
            ),
            (
                a2,
                format!(
                    "Metadata property 'animate' is invalid for edge 'link' at {}",
                    occurrence_location(a2, "animate", 1, 0, 0)
                ),
            ),
            (
                n1,
                format!(
                    "Note target 'Payload' must be an actor or use case, not json at {}; previous declaration at {}",
                    occurrence_location(n1, "Payload", 2, 0, 0),
                    occurrence_location(n1, "Payload", 1, 0, 0)
                ),
            ),
            (
                n2,
                format!(
                    "Note target 'Auth' must be an actor or use case, not boundary at {}; previous declaration at {}",
                    occurrence_location(n2, "Auth", 2, 0, 0),
                    occurrence_location(n2, "Auth", 1, 0, 0)
                ),
            ),
            (
                n3,
                format!(
                    "Note target 'link' must be an actor or use case, not edge at {}; previous declaration at {}",
                    occurrence_location(n3, "link", 2, 0, 0),
                    occurrence_location(n3, "link", 1, 0, 0)
                ),
            ),
            (
                b1,
                format!(
                    "Business actor 'Icon' must use normal or hollow geometry at {}",
                    occurrence_location(b1, "Icon", 1, 0, 0)
                ),
            ),
            (
                b2,
                format!(
                    "Business actor 'Awesome' must use normal or hollow geometry at {}",
                    occurrence_location(b2, "Awesome", 1, 0, 0)
                ),
            ),
            (
                b3,
                format!(
                    "Rectangular use case 'Report' cannot be a business use case at {}",
                    occurrence_location(b3, "Report", 1, 0, 0)
                ),
            ),
            (
                j1,
                format!(
                    "include relationship requires use-case endpoints at {}",
                    occurrence_location(j1, "..> : include Inspect", 1, 0, 0)
                ),
            ),
            (
                j2,
                format!(
                    "JSON relationship 'Inspect' to 'Payload' permits only point, reversed-point, or markerless solid association at {}",
                    occurrence_location(j2, "--o Payload", 1, 0, 0)
                ),
            ),
            (
                bm,
                format!(
                    "Metadata property 'animate' is invalid for boundary 'sb1' at {}",
                    occurrence_location(bm, "animate", 1, 0, 0)
                ),
            ),
        ]
    };
    for (src, expected) in exact_cases {
        let err = parse_usecase(src, None, None).unwrap_err();
        assert_eq!(err.message, expected, "mismatch for `{src}`");
    }

    // 9. Animation states, minlen, boundary metadata override, JSON id substrings, multi-word styles, digit-leading ids.
    let anim = parse_usecase(
        "usecase-beta\nA trueEdge@--> B\ntrueEdge@{ animate: true }\nA fastEdge@--> B\nfastEdge@{ animation: fast }\nA slowEdge@--> B\nslowEdge@{ animation: slow }\nA offEdge@--> B\noffEdge@{ animate: false }",
        None,
        None,
    )
    .unwrap();
    let got_anim: Vec<(&str, bool, Option<Animation>)> = anim.relationships.iter().map(|r| (r.id.as_str(), r.animate, r.animation)).collect();
    assert_eq!(
        got_anim,
        vec![
            ("trueEdge", true, None),
            ("fastEdge", true, Some(Animation::Fast)),
            ("slowEdge", true, Some(Animation::Slow)),
            ("offEdge", false, None),
        ]
    );

    let minlens = parse_usecase(
        "usecase-beta\nA base@--> B\nB two@---> C\nC many@-----> D\nD labelled@-- \"long\" ----> E",
        None,
        None,
    )
    .unwrap();
    assert_eq!(
        minlens
            .relationships
            .iter()
            .map(|r| (r.id.as_str(), r.label.as_deref(), r.minlen))
            .collect::<Vec<_>>(),
        vec![("base", None, 1), ("two", None, 2), ("many", None, 4), ("labelled", Some("long"), 3)]
    );

    let b_over = parse_usecase(
        "usecase-beta\nsystemBoundary \"Payment service\"@{ type: package }\n  Authorize(\"Authorize payment\")\nend\nPayment_service@{ type: rect }",
        None,
        None,
    )
    .unwrap();
    assert_eq!(b_over.system_boundaries["Payment_service"].boundary_type, BoundaryType::Rect);

    // Representative full AST with blank, comment, group, metadata, json, edge, edgeMetadata, note spans.
    let rep_src = "usecase-beta\n\n%% representative\nsystemBoundary Auth\nactor User@{ type: hollow } <<Human>>\nLogin[Sign in]\nend\nAuth@{ type: package }\njson Payload@{\"ok\": true}\nLogin includeEdge@..> : include Login\nincludeEdge@{ animation: fast }\nnote for Login \"Remember\"";
    let rep = parse_usecase(rep_src, None, None).unwrap();
    assert_eq!(
        rep.statements.iter().map(|s| (s.kind, s.span)).collect::<Vec<_>>(),
        vec![
            (StatementKind::Blank, (13, 14)),
            (StatementKind::Comment, (14, 31)),
            (StatementKind::Group, (32, 108)),
            (StatementKind::Metadata, (109, 131)),
            (StatementKind::Json, (132, 157)),
            (StatementKind::Edge, (158, 195)),
            (StatementKind::EdgeMetadata, (196, 227)),
            (StatementKind::Note, (228, 253)),
        ]
    );
    let grp = &rep.statements[2];
    assert_eq!(grp.group.as_deref(), Some("Auth"));
    assert_eq!(grp.id_span, Some((47, 51)));
    assert_eq!(grp.title_span, Some((47, 51)));
    assert_eq!(grp.end_span, Some((105, 108)));
    assert_eq!(rep.relationships[0].rel_type, RelationshipType::Include);
    assert_eq!(rep.relationships[0].arrow_type, Arrow::SolidArrow);

    // JSON id substrings of `json`.
    for id in ["o", "n", "s", "j", "jo", "so", "on", "son", "json"] {
        let src = format!("usecase-beta\njson {id} @{{\"a\": 1}}");
        let m = parse_usecase(&src, None, None).unwrap();
        let id_start = src.find(&format!("json {id}")).unwrap() + "json ".len();
        let last = m.statements.last().unwrap();
        assert_eq!(last.kind, StatementKind::Json);
        assert_eq!(last.nodes.as_ref().unwrap()[0].id_span, (id_start, id_start + id.len()));
    }

    // Multi-word style & classDef values + decimal style values + digit-leading IDs + unquoted labels.
    let sty_m = parse_usecase(
        "usecase-beta\nCheckout(\"Place order\")\nclassDef big font-family:Arial Black\nstyle Checkout border:1px solid red,fill:#eee,stroke-width:1.5px,opacity:0.5,margin:2",
        None,
        None,
    )
    .unwrap();
    assert_eq!(
        sty_m.use_cases["Checkout"].styles,
        vec!["border:1px solid red", "fill:#eee", "stroke-width:1.5px", "opacity:0.5", "margin:2"]
    );
    assert_eq!(sty_m.class_defs["big"].styles, vec!["font-family:Arial Black"]);

    let unq = parse_usecase(
        "usecase-beta\nactor Reviewer(*Reviewer*)\nLiteral(**Literal markers**)\nPriced[Costs 19.95 EUR, incl. VAT!]\nProgress(Ärende — 50% klart)\nReviewer -- opens **form** --> Literal\nnote for Literal Read the guide; then sign off.",
        None,
        None,
    )
    .unwrap();
    assert_eq!(unq.actors["Reviewer"].label, "*Reviewer*");
    assert_eq!(unq.use_cases["Literal"].label, "**Literal markers**");
    assert_eq!(unq.use_cases["Priced"].label, "Costs 19.95 EUR, incl. VAT!");
    assert_eq!(unq.use_cases["Progress"].label, "Ärende — 50% klart");
    assert_eq!(unq.relationships[0].label.as_deref(), Some("opens **form**"));
    assert_eq!(unq.notes["note-0"].label, "Read the guide; then sign off.");

    // Unquoted label rejects delimiters.
    for bad_lbl in [
        "Literal(Literal (nested) markers)",
        "Literal[Literal [nested] markers]",
        "Literal(Literal {nested} markers)",
        "Literal(Literal -- markers)",
        "Literal(Literal ::: markers)",
        "Literal(Literal @{ markers)",
        "Literal(Literal \"markers)",
        "Literal(Reviewer's markers)",
    ] {
        assert!(parse_usecase(&format!("usecase-beta\n{bad_lbl}"), None, None).is_err());
    }

    // Oval use case has extra label clearance over rectangular use case (usecaseDb.spec.ts).
    let cmp_m = parse_usecase("usecase-beta\nBrowse(Browse catalog)\nManage[Browse catalog]", None, None).unwrap();
    let graph = build_usecase_graph(&cmp_m);
    let browse = graph.nodes.iter().find(|n| n.id == "Browse").unwrap();
    let manage = graph.nodes.iter().find(|n| n.id == "Manage").unwrap();
    assert_eq!(browse.padding, 20.0);
    assert_eq!(manage.padding, 10.0);

    // JSON rows depth-first flattening in source property order (usecase.spec.ts).
    let flat_m = parse_usecase(
        "usecase-beta\njson Payload@{\n  \"2\": \"second\",\n  \"1\": \"first\",\n  \"colors\": [\"Red\", \"Green\"],\n  \"items\": [{ \"name\": \"A\" }, {}],\n  \"empty\": {},\n  \"duplicate\": \"old\",\n  \"duplicate\": \"new\"\n}",
        None,
        None,
    )
    .unwrap();
    let flat_g = build_usecase_graph(&flat_m);
    let payload_node = flat_g.nodes.iter().find(|n| n.id == "Payload").unwrap();
    let rows = payload_node.json_rows.as_ref().unwrap();
    assert_eq!(
        rows.iter().map(|r| (r.key.as_str(), r.value.as_str())).collect::<Vec<_>>(),
        vec![
            ("2", "second"),
            ("1", "first"),
            ("colors", "Red"),
            ("", "Green"),
            ("items[0].name", "A"),
            ("items[1]", "{}"),
            ("empty", "{}"),
            ("duplicate", "new"),
        ]
    );
    assert_eq!(flat_m.use_cases.len(), 0);
    assert_eq!(
        flat_m.json_nodes["Payload"].property_order[""],
        vec!["2", "1", "colors", "items", "empty", "duplicate"]
    );
    assert_eq!(flat_m.actors.len(), 0);
    // Verify Markdown labelType preserved.
    let md_m = parse_usecase("usecase-beta\nactor User(\"`**User**\nrole`\")", None, None).unwrap();
    assert_eq!(md_m.actors["User"].label_type, LabelType::Markdown);
    assert_eq!(md_m.actors["User"].label, "**User**\nrole");
    assert_eq!(IndexMap::<String, JsonValue>::new().len(), 0);
}

#[test]
fn usecase_security_hostile_payloads_options_proto_and_mutated_fuzz() {
    let u = "usecase-beta\n";
    type Template = Box<dyn Fn(&str) -> String>;
    let templates: Vec<Template> = vec![
        Box::new(move |p| format!("{u}{p}")),
        Box::new(move |p| format!("{u}actor {p}")),
        Box::new(move |p| format!("{u}actor A({p})")),
        Box::new(move |p| format!("{u}actor A(\"{p}\")")),
        Box::new(move |p| format!("{u}actor A('{p}')")),
        Box::new(move |p| format!("{u}actor A(\"`{p}`\")")),
        Box::new(move |p| format!("{u}actor \"{p}\"")),
        Box::new(move |p| format!("{u}actor \"`{p}`\"")),
        Box::new(move |p| format!("{u}actor A <<{p}>>")),
        Box::new(move |p| format!("{u}actor A:::{p}")),
        Box::new(move |p| format!("{u}actor A@{{ icon: \"{p}\" }}")),
        Box::new(move |p| format!("{u}actor A@{{ type: \"{p}\" }}")),
        Box::new(move |p| format!("{u}actor A@{{ \"{p}\": true }}")),
        Box::new(move |p| format!("{u}actor A, \"{p}\"")),
        Box::new(move |p| format!("{u}U({p})")),
        Box::new(move |p| format!("{u}U[{p}]")),
        Box::new(move |p| format!("{u}U(\"{p}\")")),
        Box::new(move |p| format!("{u}U[\"`{p}`\"]")),
        Box::new(move |p| format!("{u}\"{p}\"")),
        Box::new(move |p| format!("{u}'{p}'")),
        Box::new(move |p| format!("{u}\"`{p}`\"")),
        Box::new(move |p| format!("{u}U(x) <<{p}>>:::{p}")),
        Box::new(move |p| format!("{u}U(x)@{{ business: true }} <<{p}>>")),
        Box::new(move |p| format!("{u}A --> \"{p}\"")),
        Box::new(move |p| format!("{u}\"{p}\" --> \"{p} \"")),
        Box::new(move |p| format!("{u}A -- {p} --> B")),
        Box::new(move |p| format!("{u}A -- \"{p}\" --> B")),
        Box::new(move |p| format!("{u}A -- \"`{p}`\" --> B")),
        Box::new(move |p| format!("{u}A <-- \"{p}\" -- B")),
        Box::new(move |p| format!("{u}A o-- \"{p}\" -- B\nA x-- '{p}' -- B")),
        Box::new(move |p| format!("{u}A -- \"{p}\" --o B\nA -- \"{p}\" --x B")),
        Box::new(move |p| format!("{u}A -- \"{p}\" --> A")),
        Box::new(move |p| format!("{u}A {p}@--> B")),
        Box::new(move |p| format!("{u}A e@--> B\ne@{{ animation: \"{p}\" }}")),
        Box::new(move |p| format!("{u}A ..> : include B\nA ..> : {p} B")),
        Box::new(move |p| format!("{u}A {p} B")),
        Box::new(move |p| format!("{u}systemBoundary {p}\nend")),
        Box::new(move |p| format!("{u}systemBoundary \"{p}\"\n  U\nend")),
        Box::new(move |p| format!("{u}systemBoundary S[{p}]\n  U\nend")),
        Box::new(move |p| format!("{u}systemBoundary S(\"`{p}`\")@{{ type: package }}\n  U\nend")),
        Box::new(move |p| format!("{u}systemBoundary S[\"{p}\"]@{{ type: package }}:::{p}\n  actor \"{p}\"\n  \"{p} \"\nend")),
        Box::new(move |p| format!("{u}systemBoundary S@{{ type: \"{p}\" }}\nend")),
        Box::new(move |p| format!("{u}U\nnote for U {p}")),
        Box::new(move |p| format!("{u}U\nnote for U \"{p}\"")),
        Box::new(move |p| format!("{u}U\nnote for U \"`{p}`\"")),
        Box::new(move |p| format!("{u}U\nnote for {p} \"x\"")),
        Box::new(move |p| format!("{u}json P@{{\"{p}\": \"{p}\"}}")),
        Box::new(move |p| format!("{u}json P@{{\"a\": [\"{p}\", {{\"{p}\": null}}], \"b\": {{\"{p}\": 1}}}}")),
        Box::new(move |p| format!("{u}json {p}@{{}}")),
        Box::new(move |p| format!("{u}json P@{{}}:::{p}")),
        Box::new(move |p| format!("{u}json P@{p}")),
        Box::new(move |p| format!("{u}A\nclass A {p}")),
        Box::new(move |p| format!("{u}A\nclass {p} c")),
        Box::new(move |p| format!("{u}A\nclassDef {p} fill:red\nclass A {p}")),
        Box::new(move |p| format!("{u}A\nclassDef c fill:{p}\nclass A c")),
        Box::new(move |p| format!("{u}A\nclassDef c {p}:red\nclass A c")),
        Box::new(move |p| format!("{u}A\nclassDef default fill:{p},color:{p},stroke:{p}")),
        Box::new(move |p| format!("{u}A\nstyle A fill:{p}")),
        Box::new(move |p| format!("{u}A\nstyle A {p}:red")),
        Box::new(move |p| format!("{u}actor A\nstyle A color:{p},stroke:{p},font-family:{p},font-size:{p}")),
        Box::new(move |p| format!("{u}A e@--> B\nstyle e stroke:{p},stroke-width:{p}\nclass e {p}")),
        Box::new(move |p| format!("{u}systemBoundary S\nend\nstyle S fill:{p}\nclass S {p}")),
        Box::new(move |p| format!("{u}json P@{{}}\nstyle P fill:{p},stroke-width:{p}")),
        Box::new(move |p| format!("{u}A\nstyle {p} fill:red")),
        Box::new(move |p| format!("{u}accTitle: {p}\naccDescr: {p}\nA")),
        Box::new(move |p| format!("{u}accDescr {{\n {p}\n}}\nA")),
        Box::new(move |p| format!("{u}direction {p}\nA")),
        Box::new(move |p| format!("{u}direction TB {p}\nA")),
        Box::new(move |p| format!("{u}%% {p}\nA")),
        Box::new(move |p| format!("{u}A@{{ {p}: true }}\nA")),
        Box::new(move |p| format!("{u}A\nA@{{ business: \"{p}\" }}")),
        Box::new(move |p| format!("---\ntitle: \"{p}\"\nconfig:\n  usecase:\n    nodeSpacing: \"{p}\"\n    rankSpacing: \"{p}\"\n---\n{u}actor A\nA --> B")),
        Box::new(move |p| format!("---\ntitle: {p}\n---\n{u}A")),
        Box::new(move |p| format!("%%{{init: {{\"usecase\": {{\"nodeSpacing\": \"{p}\"}}, \"themeVariables\": {{\"fontFamily\": \"{p}\"}}}}}}%%\n{u}A")),
        Box::new(move |p| format!("usecase-beta {p}\nA")),
    ];

    let mut rendered = 0usize;
    for (ti, tmpl) in templates.iter().enumerate() {
        for (pi, &payload) in PAYLOADS.iter().enumerate() {
            if let Ok(res) = render(&tmpl(payload), &resolved_options()) {
                assert_inert_resolved(&res.svg, &format!("usecase tmpl {ti} payload {pi}"));
                rendered += 1;
            }
        }
    }
    assert!(rendered > 600, "only rendered {rendered}");

    // Escaping check.
    let esc_svg = render(
        &format!("{u}actor \"<img src=x onerror=alert(1)>\" <<</text><script>alert(1)</script >>\n'<script>a&b</script>'\njson P@{{\"<b>\": \"</text><script>alert(1)</script>\"}}\nnote for P2 \"<svg onload=alert(1)>\"\nP2"),
        &resolved_options(),
    )
    .unwrap()
    .svg;
    assert!(!esc_svg.contains("<img"));
    assert!(!esc_svg.contains("<script"));
    assert!(!esc_svg.contains("<svg onload"));
    assert!(esc_svg.contains("&lt;script&gt;a&amp;b&lt;/script&gt;"));
    assert!(esc_svg.contains(r#"data-id="_img_src_x_onerror_alert_1__""#));
    assert!(esc_svg.contains(">&lt;b&gt;</text>"));
    assert!(esc_svg.contains("«&lt;/text&gt;&lt;script&gt;alert(1)&lt;/script»"));

    // Icon name escaping.
    let icon_esc = render(&format!("{u}actor A@{{ icon: '\"><script>alert(1)</script>' }}"), &resolved_options())
        .unwrap()
        .svg;
    assert!(icon_esc.contains(r#"data-icon="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;""#));
    assert!(!icon_esc.contains("<script"));

    // Hostile option values.
    for &payload in PAYLOADS {
        let res = render(
            &format!("{u}accTitle: t\nactor A\nA -- \"l\" --> B\njson P@{{\"a\":1}}"),
            &RenderOptions {
                id_prefix: Some(payload.to_string()),
                font_family: Some(payload.to_string()),
                ..resolved_options()
            },
        )
        .unwrap();
        assert_inert_resolved(&res.svg, payload);
    }

    // __proto__ / constructor keys.
    for src in [
        format!("{u}actor __proto__\n__proto__ constructor@--> toString\nconstructor@{{ animate: true }}\nnote for toString \"__proto__\""),
        format!("{u}A\nclassDef __proto__ fill:red\nclass A __proto__\nstyle A fill:red\nA@{{ business: true }}"),
        format!("{u}systemBoundary __proto__[constructor]\n  hasOwnProperty\n  actor valueOf\nend\n__proto__@{{ type: package }}"),
        format!("{u}json __proto__@{{\"__proto__\": {{\"polluted\": true}}, \"constructor\": {{\"prototype\": {{\"polluted\": true}}}}}}\nA --> __proto__"),
    ] {
        let res = render(&src, &resolved_options()).unwrap();
        assert_inert_resolved(&res.svg, "proto");
        assert_resvg_parses(&res.svg, "proto resvg");
    }
    let json_proto = render(&format!("{u}json P@{{\"__proto__\": {{\"x\": 1}}, \"constructor\": 2}}"), &resolved_options())
        .unwrap()
        .svg;
    assert!(json_proto.contains(">__proto__.x</text>"));
    assert!(json_proto.contains(">constructor</text>"));

    // Mutated fuzzing (1,000 samples from 105-item corpus).
    let corpus = load_fixture("usecase-corpus.json");
    let mut frags: Vec<&str> = PAYLOADS.to_vec();
    frags.extend([
        "\"",
        "'",
        "`",
        "\"`",
        "`\"",
        "{",
        "}",
        "[",
        "]",
        "(",
        ")",
        "\n",
        ":::",
        "<<",
        ">>",
        "@{",
        " --> ",
        " -- ",
        "style A fill:",
        "classDef c ",
        "systemBoundary ",
        "end\n",
        "json P@",
        "note for A ",
    ]);
    let mut mutator = Mutator::new(&corpus, frags, 3);
    let mut fuzz_rendered = 0usize;
    for i in 0..1000 {
        let src = mutator.next_sample();
        if src.len() <= 4000
            && let Ok(res) = render(&src, &resolved_options())
        {
            assert_inert_resolved(&res.svg, &format!("usecase fuzz #{i}"));
            fuzz_rendered += 1;
        }
    }
    assert!(fuzz_rendered > 50, "only rendered {fuzz_rendered}");
}

#[test]
fn usecase_stress_worst_cases_stay_fast() {
    let n = 50_000usize;
    let u = "usecase-beta\n";
    let big_parse = ParseOptions {
        limit: Some(usize::MAX),
        ..ParseOptions::default()
    };
    let big_render = RenderOptions {
        limit: Some(usize::MAX),
        ..resolved_options()
    };
    let repeat_fn = |count: usize, f: &dyn Fn(usize) -> String| -> String {
        let mut s = String::new();
        for i in 0..count {
            s.push_str(&f(i));
        }
        s
    };

    // Lexer stress cases.
    let lex_cases: Vec<(&str, String)> = vec![
        ("50k dashes", format!("{u}A {} B", "-".repeat(n))),
        ("dash runs no arrow", format!("{u}{}", "-- ".repeat(n / 3))),
        ("unclosed stereotypes", format!("{u}{}", "A <<x\n".repeat(n / 6))),
        ("25k <<", format!("{u}A {}", "<<".repeat(n / 2))),
        ("stereotypes closed at end", format!("{u}{}>>", "A <<x\n".repeat(n / 6))),
        ("unclosed accDescr", format!("{u}{}", "accDescr {\n".repeat(n / 11))),
        ("accDescr closed at end", format!("{u}{}}}", "accDescr {\n".repeat(n / 11))),
        ("accTitle no colon", format!("{u}{}", format!("accTitle{}\n", " ".repeat(40)).repeat(n / 49))),
        ("unclosed markdown", format!("{u}{}", "\"`x".repeat(n / 3))),
        ("unclosed plain strings", format!("{u}{}", "A \"x".repeat(n / 4))),
        ("unclosed json braces", format!("{u}json P@{}", "{".repeat(n))),
        ("unclosed json decls", format!("{u}{}", "json P@{ \"a\": \n".repeat(n / 15))),
        (
            "comment markers after text",
            format!("{u}{}", format!("A{}%%\n", " ".repeat(40)).repeat(n / 44)),
        ),
        (
            "indented percent lines",
            format!("{u}{}", format!("{}{}\n", " ".repeat(100), "%".repeat(100)).repeat(n / 201)),
        ),
        ("keyword prefixes", format!("{u}{}", "endx forx notex truex classDefx jsonx ".repeat(n / 38))),
        ("50k unicode symbols", format!("{u}{}", "é日".repeat(n / 2))),
    ];
    for (name, src) in lex_cases {
        let t0 = Instant::now();
        let _ = tokenize(&src, None);
        assert!(t0.elapsed().as_secs_f64() < 5.0, "lex {name} took {:?}", t0.elapsed());
    }

    // Parser stress cases.
    let parse_cases: Vec<(&str, String)> = vec![
        ("quotes cannot start token", format!("{u}A {}", "\"'".repeat(n / 2))),
        ("20k word label", format!("{u}A({})", "word ".repeat(20_000))),
        ("unclosed edge label", format!("{u}A -- {}", "word ".repeat(n / 5))),
        (
            "10k statements looking for label",
            format!("{u}{}", repeat_fn(10_000, &|i| format!("A{i} -- x y z\n"))),
        ),
        ("10k metadata props", format!("{u}actor A\nA@{{\n{}}}", "business: true,\n".repeat(10_000))),
        ("metadata of 50k newlines", format!("{u}A@{{{}}}\nA", "\n".repeat(n))),
        (
            "class 2500 ids x 4000 classes",
            format!(
                "{u}{}class {}e0 {}z\n",
                repeat_fn(2500, &|i| format!("e{i}\n")),
                repeat_fn(2500, &|i| format!("e{i},")),
                repeat_fn(4000, &|i| format!("c{i},"))
            ),
        ),
        ("style colons and hashes", format!("{u}A\nstyle A fill:{}", ":#".repeat(n / 2))),
        (
            "10k members in boundary",
            format!("{u}systemBoundary S\n{}end", repeat_fn(10_000, &|i| format!("u{i}\n"))),
        ),
        ("5k metadata statements", format!("{u}actor A\n{}", "A@{ type: hollow }\n".repeat(5000))),
        ("invalid JSON at end of 50k", format!("{u}json P@{{\"a\":\"{}\",}}", "x".repeat(n))),
    ];
    for (name, src) in parse_cases {
        let t0 = Instant::now();
        let _ = parse(&src, &big_parse);
        assert!(t0.elapsed().as_secs_f64() < 10.0, "parse {name} took {:?}", t0.elapsed());
    }

    // Render stress cases.
    let render_cases: Vec<(&str, String)> = vec![
        ("8k classes on one element", format!("{u}A:::{}z\n", repeat_fn(8000, &|i| format!("c{i},")))),
        (
            "8k classDef names & styles",
            format!(
                "{u}A\nclassDef {}z {}fill:red\nclass A z\n",
                repeat_fn(8000, &|i| format!("c{i},")),
                repeat_fn(8000, &|i| format!("x{i}:1,"))
            ),
        ),
        ("10k decls of one element", format!("{u}{}", "A(A) <<S>>:::c\n".repeat(10_000))),
        (
            "3k boundaries",
            format!("{u}{}", repeat_fn(3000, &|i| format!("systemBoundary s{i}\n u{i}\nend\n"))),
        ),
        ("5k notes on one use case", format!("{u}A\n{}", "note for A \"n\"\n".repeat(5000))),
        (
            "JSON nested 12k objects deep",
            format!("{u}json P@{}1{}", "{\"a\":".repeat(12_000), "}".repeat(12_000)),
        ),
        (
            "JSON nested 20k arrays deep",
            format!("{u}json P@{{\"a\":{}{}}}", "[".repeat(20_000), "]".repeat(20_000)),
        ),
        (
            "JSON 8k keys",
            format!("{u}json P@{{{}{}}}", repeat_fn(8000, &|i| format!("\"k{i}\":{i},")), "\"z\":0"),
        ),
        (
            "JSON 8k duplicate keys",
            format!("{u}json P@{{{}{}}}", "\"k\":{\"a\":{}},".repeat(8000), "\"z\":0"),
        ),
        (
            "JSON 5k nested + 5k repeats",
            format!(
                "{u}json P@{{{}{}{}}}",
                repeat_fn(5000, &|i| format!("\"k{i}\":{{}},")),
                "\"d\":1,".repeat(5000),
                "\"z\":0"
            ),
        ),
        ("JSON array of 20k scalars", format!("{u}json P@{{\"a\":[{}1]}}", "1,".repeat(20_000))),
        ("50k char plain label", format!("{u}A(\"{}\")", "word ".repeat(n / 5))),
        ("50k char word", format!("{u}actor A(\"{}\")", "a".repeat(n))),
        ("entities and markup label", format!("{u}A(\"{}\")", "#35;&amp;<br>".repeat(n / 13))),
        ("markdown emphasis markers", format!("{u}A(\"`{}`\")", "*a _b ".repeat(n / 6))),
        ("50k char relationship label", format!("{u}A -- \"{}\" --> B", "word ".repeat(n / 5))),
        ("3k actors", format!("{u}{}", repeat_fn(3000, &|i| format!("actor a{i}\n")))),
        ("chain of 3k", format!("{u}{}", repeat_fn(3000, &|i| format!("n{i} --> n{}\n", i + 1)))),
        ("star of 3k", format!("{u}{}", repeat_fn(3000, &|i| format!("actor a{i}\na{i} --> hub\n")))),
        (
            "2k parallel + 1k loops",
            format!("{u}{}{}", "A --> B\n".repeat(2000), "A -- l --> A\n".repeat(1000)),
        ),
        ("complete graph of 40", {
            let mut s = String::from(u);
            for i in 0..40 {
                for j in (i + 1)..40 {
                    s.push_str(&format!("n{i} --o n{j}\n"));
                }
            }
            s
        }),
        ("10k dashes relationship", format!("{u}A {}> B", "-".repeat(10_000))),
        (
            "2k relationships into boundary",
            format!(
                "{u}systemBoundary S\n U\n V\nend\n{}",
                repeat_fn(1000, &|i| format!("actor a{i}\na{i} --> U\nV --> a{i}\n"))
            ),
        ),
    ];
    for (name, src) in render_cases {
        let t0 = Instant::now();
        let _ = render(&src, &big_render);
        assert!(t0.elapsed().as_secs_f64() < 15.0, "render {name} took {:?}", t0.elapsed());
    }

    // Default 50k character limit.
    let err = render(&format!("{u}{}", "A --> B\n".repeat(8000)), &css_options()).unwrap_err();
    assert!(err.message.contains("limit of 50000"), "got: {}", err.message);
}
