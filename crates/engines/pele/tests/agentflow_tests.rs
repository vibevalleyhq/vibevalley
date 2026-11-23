use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::Instant;

use indexmap::IndexMap;
use regex::Regex;
use serde::Deserialize;
use vibevalley_pele::detect::DiagramType;
use vibevalley_pele::diagram::agentflow::color_slots::{KIND_COUNT, assign_color_slots, container_slot, container_slot_count};
use vibevalley_pele::diagram::agentflow::db::{AgentflowDb, AgentflowDbOptions, is_tool_definition};
use vibevalley_pele::diagram::agentflow::diagnostics::{EMITTED, RESERVED, is_emitted, is_reserved};
use vibevalley_pele::diagram::agentflow::graph::{GraphNode, build_agent_graph};
use vibevalley_pele::diagram::agentflow::lexer::tokenize;
use vibevalley_pele::diagram::agentflow::parser::parse_agentflow;
use vibevalley_pele::diagram::agentflow::types::{DiagnosticId, DiagnosticSeverity, StatementType};
use vibevalley_pele::util::yaml::YamlValue;
use vibevalley_pele::{ErrorCode, LinkInfo, METRICS_MEASURER, ParseOptions, ParsedModel, RenderOptions, ThemeMode, detect_type, parse, render, supports};

use crate::support::{Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, css_options, dark_options, load_fixture, resolved_options};

fn preview(s: &str) -> String {
    s.chars().take(120).collect()
}

fn svg_of(src: &str) -> String {
    render(src, &css_options()).unwrap().svg
}

fn model_of(src: &str) -> Box<AgentflowDb> {
    let parsed = parse(src, &ParseOptions::default()).unwrap();
    match parsed.model {
        ParsedModel::Agentflow(db) => db,
        other => panic!("expected Agentflow model, got {:?}", other.diagram_type()),
    }
}

fn parse_raw(src: &str) -> AgentflowDb {
    let mut db = AgentflowDb::new(AgentflowDbOptions::default());
    parse_agentflow(src, &mut db, false, None).unwrap();
    db
}

fn series(n: usize) -> String {
    format!("var(--pele-series-{n},")
}

struct NodeMatch {
    classes: String,
    x: f64,
    y: f64,
    body: String,
}

fn find_node(svg: &str, id: &str) -> NodeMatch {
    let re = Regex::new(&format!(
        r#"<g class="(pele-node[^"]*)" data-id="{}" transform="translate\(([-\d.]+),([-\d.]+)\)">(.*?)</g>"#,
        regex::escape(id)
    ))
    .unwrap();
    let cap = re.captures(svg).unwrap_or_else(|| panic!("no node {id} in SVG"));
    NodeMatch {
        classes: cap[1].to_string(),
        x: cap[2].parse().unwrap(),
        y: cap[3].parse().unwrap(),
        body: cap[4].to_string(),
    }
}

struct FrameMatch {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    rect: String,
}

fn find_frame(svg: &str, id: &str) -> FrameMatch {
    let re = Regex::new(&format!(
        r#"<g class="pele-cluster pele-flow[^"]*" data-id="{}">(<rect x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"[^>]*/>)"#,
        regex::escape(id)
    ))
    .unwrap();
    let cap = re.captures(svg).unwrap_or_else(|| panic!("no flow {id} in SVG"));
    FrameMatch {
        rect: cap[1].to_string(),
        x: cap[2].parse().unwrap(),
        y: cap[3].parse().unwrap(),
        w: cap[4].parse().unwrap(),
        h: cap[5].parse().unwrap(),
    }
}

struct EdgeMatch {
    classes: String,
    id: String,
    body: String,
}

fn find_edges(svg: &str) -> Vec<EdgeMatch> {
    let re = Regex::new(r#"<g class="(pele-edge [^"]*)" data-id="([^"]*)"[^>]*>(.*?)</g>"#).unwrap();
    re.captures_iter(svg)
        .map(|cap| EdgeMatch {
            classes: cap[1].to_string(),
            id: cap[2].to_string(),
            body: cap[3].to_string(),
        })
        .collect()
}

fn inside(n: &NodeMatch, f: &FrameMatch) -> bool {
    n.x > f.x && n.x < f.x + f.w && n.y > f.y && n.y < f.y + f.h
}

#[derive(Deserialize)]
struct ReferenceEntry {
    src: String,
    model: Option<YamlValue>,
    error: Option<String>,
}

fn comparable(val: YamlValue) -> YamlValue {
    match val {
        YamlValue::String(s) => {
            if s.contains('<') || s.contains('>') || s.contains('&') {
                YamlValue::String("(markup)".to_string())
            } else {
                YamlValue::String(s)
            }
        }
        YamlValue::Seq(items) => YamlValue::Seq(items.into_iter().map(comparable).collect()),
        YamlValue::Map(map) => {
            let mut entries: Vec<(String, YamlValue)> = map
                .into_iter()
                .filter(|(k, _)| k != "domId" && k != "haveCallback")
                .map(|(k, v)| (k, comparable(v)))
                .collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            let mut out = IndexMap::with_capacity(entries.len());
            for (k, v) in entries {
                out.insert(k, v);
            }
            YamlValue::Map(out)
        }
        other => other,
    }
}

fn y_str(s: impl Into<String>) -> YamlValue {
    YamlValue::String(s.into())
}

fn y_num(n: usize) -> YamlValue {
    YamlValue::Number(n as f64)
}

fn y_strs(items: &[String]) -> YamlValue {
    YamlValue::Seq(items.iter().map(|s| y_str(s.clone())).collect())
}

fn y_meta(m: &IndexMap<String, YamlValue>) -> YamlValue {
    YamlValue::Map(m.clone())
}

fn y_pos(p: vibevalley_pele::diagram::agentflow::types::ElementPosition) -> YamlValue {
    let mut map = IndexMap::new();
    map.insert("startLine".to_string(), y_num(p.start_line));
    map.insert("startColumn".to_string(), y_num(p.start_column));
    map.insert("endLine".to_string(), y_num(p.end_line));
    map.insert("endColumn".to_string(), y_num(p.end_column));
    map.insert("startIndex".to_string(), y_num(p.start_index));
    map.insert("endIndex".to_string(), y_num(p.end_index));
    YamlValue::Map(map)
}

fn y_diag(d: &vibevalley_pele::diagram::agentflow::types::Diagnostic) -> YamlValue {
    let mut map = IndexMap::new();
    map.insert("id".to_string(), y_str(d.id.as_str()));
    map.insert("severity".to_string(), y_str(d.severity.as_str()));
    map.insert("message".to_string(), y_str(d.message.clone()));
    if let Some(ref nid) = d.node_id {
        map.insert("nodeId".to_string(), y_str(nid.clone()));
    }
    if let Some(ref eid) = d.edge_id {
        map.insert("edgeId".to_string(), y_str(eid.clone()));
    }
    if let Some(pos) = d.position {
        map.insert("position".to_string(), y_pos(pos));
    }
    YamlValue::Map(map)
}

/// Projects our parsed `AgentflowDb` into the exact JSON shape captured from Mermaid 12.1.0.
fn project_reference(src: &str) -> Result<YamlValue, String> {
    let opts = ParseOptions {
        limit: Some(usize::MAX),
        ..ParseOptions::default()
    };
    let parsed = parse(src, &opts).map_err(|e| e.message.lines().next().unwrap_or("").to_string())?;
    let ParsedModel::Agentflow(mut db) = parsed.model else {
        return Err("not an agentflow".to_string());
    };
    let graph = build_agent_graph(&mut db, 12, Some("basis"));

    let mut root = IndexMap::new();
    if let Some(ref dir) = db.direction {
        root.insert("direction".to_string(), y_str(dir.trim()));
    }
    root.insert("accTitle".to_string(), y_str(db.acc_title.as_deref().unwrap_or("")));
    root.insert("accDescr".to_string(), y_str(db.acc_descr.as_deref().unwrap_or("")));

    let vertices: Vec<YamlValue> = db
        .nodes
        .values()
        .map(|v| {
            let mut m = IndexMap::new();
            m.insert("id".to_string(), y_str(v.id.clone()));
            if let Some(ref text) = v.text {
                m.insert("text".to_string(), y_str(text.clone()));
            }
            m.insert("labelType".to_string(), y_str(v.label_type.as_str()));
            if let Some(ref t) = v.node_type {
                m.insert("type".to_string(), y_str(t.clone()));
            }
            m.insert("styles".to_string(), y_strs(&v.styles));
            m.insert("classes".to_string(), y_strs(&v.classes));
            if let Some(ref l) = v.link {
                m.insert("link".to_string(), y_str(l.clone()));
            }
            if let Some(ref lt) = v.link_target {
                m.insert("linkTarget".to_string(), y_str(lt.clone()));
            }
            if let Some(ref meta) = v.metadata {
                m.insert("metadata".to_string(), y_meta(meta));
            }
            if v.is_connector {
                m.insert("isConnector".to_string(), YamlValue::Bool(true));
            }
            if let Some(ref props) = v.props {
                let mut pm = IndexMap::new();
                for (k, val) in props {
                    pm.insert(k.clone(), y_str(val.clone()));
                }
                m.insert("props".to_string(), YamlValue::Map(pm));
            }
            YamlValue::Map(m)
        })
        .collect();
    root.insert("vertices".to_string(), YamlValue::Seq(vertices));

    let edges: Vec<YamlValue> = db
        .edges
        .iter()
        .map(|e| {
            let mut m = IndexMap::new();
            m.insert("start".to_string(), y_str(e.start.clone()));
            m.insert("end".to_string(), y_str(e.end.clone()));
            if let Some(ref t) = e.edge_type {
                m.insert("type".to_string(), y_str(t.clone()));
            }
            m.insert("text".to_string(), y_str(e.text.clone()));
            m.insert("labelType".to_string(), y_str(e.label_type.as_str()));
            if let Some(ref st) = e.stroke {
                m.insert("stroke".to_string(), y_str(st.clone()));
            }
            if let Some(sem) = e.edge_semantic {
                m.insert("edgeSemantic".to_string(), y_str(sem.as_str()));
            }
            if let Some(len) = e.length {
                m.insert("length".to_string(), y_num(len));
            }
            if let Some(ref s) = e.style {
                m.insert("style".to_string(), y_strs(s));
            }
            m.insert("classes".to_string(), y_strs(&e.classes));
            if let Some(ref id) = e.id {
                m.insert("id".to_string(), y_str(id.clone()));
            }
            m.insert("isUserDefinedId".to_string(), YamlValue::Bool(e.is_user_defined_id));
            if let Some(ref interp) = e.interpolate {
                m.insert("interpolate".to_string(), y_str(interp.clone()));
            }
            if let Some(ref anim) = e.animate {
                m.insert("animate".to_string(), anim.clone());
            }
            if let Some(ref anim) = e.animation {
                m.insert("animation".to_string(), anim.clone());
            }
            if let Some(ref meta) = e.metadata {
                m.insert("metadata".to_string(), y_meta(meta));
            }
            YamlValue::Map(m)
        })
        .collect();
    root.insert("edges".to_string(), YamlValue::Seq(edges));
    if let Some(ref ds) = db.default_edge_style {
        root.insert("defaultStyle".to_string(), y_strs(ds));
    }
    if let Some(ref di) = db.default_interpolate {
        root.insert("defaultInterpolate".to_string(), y_str(di.clone()));
    }

    let subgraphs: Vec<YamlValue> = db
        .subgraphs
        .iter()
        .map(|s| {
            let mut m = IndexMap::new();
            m.insert("id".to_string(), y_str(s.id.clone()));
            m.insert("nodes".to_string(), y_strs(&s.nodes));
            m.insert("title".to_string(), y_str(s.title.clone()));
            m.insert("classes".to_string(), y_strs(&s.classes));
            if let Some(ref d) = s.dir {
                m.insert("dir".to_string(), y_str(d.clone()));
            }
            m.insert("labelType".to_string(), y_str(s.label_type.as_str()));
            m.insert("type".to_string(), y_str(s.subgraph_type));
            if let Some(ref meta) = s.metadata {
                m.insert("metadata".to_string(), y_meta(meta));
            }
            YamlValue::Map(m)
        })
        .collect();
    root.insert("subGraphs".to_string(), YamlValue::Seq(subgraphs));

    let classes: Vec<YamlValue> = db
        .classes
        .values()
        .map(|c| {
            let mut m = IndexMap::new();
            m.insert("id".to_string(), y_str(c.id.clone()));
            m.insert("styles".to_string(), y_strs(&c.styles));
            m.insert("textStyles".to_string(), y_strs(&c.text_styles));
            YamlValue::Map(m)
        })
        .collect();
    root.insert("classes".to_string(), YamlValue::Seq(classes));

    let nodes: Vec<YamlValue> = graph
        .nodes
        .iter()
        .map(|n| {
            let mut m = IndexMap::new();
            m.insert("id".to_string(), y_str(n.id.clone()));
            if let Some(ref lbl) = n.label {
                m.insert("label".to_string(), y_str(lbl.clone()));
            }
            m.insert("labelType".to_string(), y_str(n.label_type.as_str()));
            m.insert("shape".to_string(), y_str(n.shape.clone()));
            m.insert("isGroup".to_string(), YamlValue::Bool(n.is_group));
            if let Some(ref pid) = n.parent_id {
                m.insert("parentId".to_string(), y_str(pid.clone()));
            }
            m.insert("cssCompiledStyles".to_string(), y_strs(&n.css_compiled_styles));
            let combined_cls = match n.kind {
                Some(k) => format!("{} af-kind-{}", n.css_classes, k.as_str()),
                None => n.css_classes.clone(),
            };
            let normalized_cls = combined_cls.split_whitespace().collect::<Vec<_>>().join(" ");
            m.insert("cssClasses".to_string(), y_str(normalized_cls));
            if let Some(ref d) = n.dir {
                m.insert("dir".to_string(), y_str(d.clone()));
            }
            if let Some(ref l) = n.link {
                m.insert("link".to_string(), y_str(l.clone()));
            }
            if let Some(ref lt) = n.link_target {
                m.insert("linkTarget".to_string(), y_str(lt.clone()));
            }
            if let Some(ref tip) = n.tooltip {
                m.insert("tooltip".to_string(), y_str(tip.clone()));
            }
            if let Some(ci) = n.color_index {
                m.insert("colorIndex".to_string(), y_num(ci));
            }
            if let Some(ref meta) = n.metadata {
                m.insert("metadata".to_string(), y_meta(meta));
            }
            YamlValue::Map(m)
        })
        .collect();
    root.insert("nodes".to_string(), YamlValue::Seq(nodes));

    let layout_edges: Vec<YamlValue> = graph
        .edges
        .iter()
        .map(|e| {
            let mut m = IndexMap::new();
            m.insert("id".to_string(), y_str(e.id.clone()));
            m.insert("start".to_string(), y_str(e.start.clone()));
            m.insert("end".to_string(), y_str(e.end.clone()));
            m.insert("type".to_string(), y_str(e.edge_type.clone()));
            m.insert("label".to_string(), y_str(e.label.clone()));
            m.insert("labelType".to_string(), y_str(e.label_type.as_str()));
            if let Some(ref th) = e.thickness {
                m.insert("thickness".to_string(), y_str(th.clone()));
            }
            if let Some(ml) = e.minlen {
                m.insert("minlen".to_string(), y_num(ml));
            }
            m.insert("arrowTypeStart".to_string(), y_str(e.arrow_type_start.clone()));
            m.insert("arrowTypeEnd".to_string(), y_str(e.arrow_type_end.clone()));
            m.insert("cssCompiledStyles".to_string(), y_strs(&e.css_compiled_styles));
            m.insert("style".to_string(), y_strs(&e.style));
            if let Some(ref c) = e.curve {
                m.insert("curve".to_string(), y_str(c.clone()));
            }
            if let Some(ref meta) = e.metadata {
                m.insert("metadata".to_string(), y_meta(meta));
            }
            m.insert("isUserDefinedId".to_string(), YamlValue::Bool(e.is_user_defined_id));
            YamlValue::Map(m)
        })
        .collect();
    root.insert("layoutEdges".to_string(), YamlValue::Seq(layout_edges));

    let mappings: Vec<YamlValue> = db
        .mappings
        .iter()
        .map(|m| {
            YamlValue::Seq(vec![
                y_str(m.id.clone()),
                y_str(m.stmt_type.as_str()),
                y_num(m.position.start_line),
                y_num(m.position.start_column),
                y_num(m.position.end_line),
                y_num(m.position.end_column),
                y_num(m.position.start_index),
                y_num(m.position.end_index),
            ])
        })
        .collect();
    root.insert("mappings".to_string(), YamlValue::Seq(mappings));

    let diagnostics: Vec<YamlValue> = db.diagnostics.iter().map(y_diag).collect();
    root.insert("diagnostics".to_string(), YamlValue::Seq(diagnostics));

    let sem = db.semantic_model();
    let mut sem_map = IndexMap::new();
    if let Some(ref d) = sem.direction {
        sem_map.insert("direction".to_string(), y_str(d.clone()));
    }
    let sem_vertices: Vec<YamlValue> = sem
        .vertices
        .iter()
        .map(|v| {
            let mut m = IndexMap::new();
            m.insert("id".to_string(), y_str(v.id.clone()));
            if let Some(ref l) = v.label {
                m.insert("label".to_string(), y_str(l.clone()));
            }
            if let Some(ref s) = v.shape {
                m.insert("shape".to_string(), y_str(s.clone()));
            }
            m.insert("vertexKind".to_string(), y_str(v.vertex_kind.as_str()));
            if let Some(ref meta) = v.metadata {
                m.insert("metadata".to_string(), y_meta(meta));
            }
            YamlValue::Map(m)
        })
        .collect();
    sem_map.insert("vertices".to_string(), YamlValue::Seq(sem_vertices));

    let sem_edges: Vec<YamlValue> = sem
        .edges
        .iter()
        .map(|e| {
            let mut m = IndexMap::new();
            m.insert("start".to_string(), y_str(e.start.clone()));
            m.insert("end".to_string(), y_str(e.end.clone()));
            if let Some(ref id) = e.id {
                m.insert("id".to_string(), y_str(id.clone()));
            }
            if let Some(ref l) = e.label {
                m.insert("label".to_string(), y_str(l.clone()));
            }
            if let Some(ref t) = e.edge_type {
                m.insert("type".to_string(), y_str(t.clone()));
            }
            if let Some(ref st) = e.stroke {
                m.insert("stroke".to_string(), y_str(st.clone()));
            }
            if let Some(s) = e.edge_semantic {
                m.insert("edgeSemantic".to_string(), y_str(s.as_str()));
            }
            if let Some(len) = e.length {
                m.insert("length".to_string(), y_num(len));
            }
            if let Some(ref meta) = e.metadata {
                m.insert("metadata".to_string(), y_meta(meta));
            }
            YamlValue::Map(m)
        })
        .collect();
    sem_map.insert("edges".to_string(), YamlValue::Seq(sem_edges));

    let sem_sgs: Vec<YamlValue> = sem
        .subgraphs
        .iter()
        .map(|s| {
            let mut m = IndexMap::new();
            m.insert("id".to_string(), y_str(s.id.clone()));
            m.insert("nodes".to_string(), y_strs(&s.nodes));
            m.insert("type".to_string(), y_str(s.subgraph_type));
            m.insert("title".to_string(), y_str(s.title.clone()));
            if let Some(ref d) = s.direction {
                m.insert("direction".to_string(), y_str(d.clone()));
            }
            if let Some(ref meta) = s.metadata {
                m.insert("metadata".to_string(), y_meta(meta));
            }
            YamlValue::Map(m)
        })
        .collect();
    sem_map.insert("subGraphs".to_string(), YamlValue::Seq(sem_sgs));

    let sem_conns: Vec<YamlValue> = sem
        .connectors
        .iter()
        .map(|c| {
            let mut m = IndexMap::new();
            m.insert("id".to_string(), y_str(c.id.clone()));
            if let Some(ref t) = c.title {
                m.insert("title".to_string(), y_str(t.clone()));
            }
            if let Some(ref meta) = c.metadata {
                m.insert("metadata".to_string(), y_meta(meta));
            }
            YamlValue::Map(m)
        })
        .collect();
    sem_map.insert("connectors".to_string(), YamlValue::Seq(sem_conns));
    sem_map.insert("diagnostics".to_string(), YamlValue::Seq(sem.diagnostics.iter().map(y_diag).collect()));
    root.insert("semantic".to_string(), YamlValue::Map(sem_map));

    Ok(YamlValue::Map(root))
}

#[test]
fn agentflow_matches_mermaid_reference_corpus_239_models() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("agentflow-reference.json");
    let raw = std::fs::read_to_string(&path).unwrap();
    let entries: Vec<ReferenceEntry> = serde_json::from_str(&raw).unwrap();
    assert!(entries.len() > 200, "expected >200 reference entries, got {}", entries.len());
    let accepted = entries.iter().filter(|e| e.model.is_some()).count();
    assert!(accepted > 150, "expected >150 accepted reference entries, got {accepted}");

    let lenient_yaml = Regex::new(r"alias|explicit mapping pair").unwrap();

    for (idx, entry) in entries.iter().enumerate() {
        let mine = project_reference(&entry.src);
        let where_ctx = format!("entry #{idx}: {}", preview(&entry.src));
        if let Some(ref err) = entry.error
            && lenient_yaml.is_match(err)
        {
            assert!(mine.is_ok(), "{where_ctx}: expected lenient YAML acceptance, got {:?}", mine.err());
            continue;
        }
        assert_eq!(
            mine.is_ok(),
            entry.model.is_some(),
            "{where_ctx}: Mermaid={:?}, Pele={:?}",
            entry.error,
            mine.as_ref().err()
        );
        if let Some(ref expected) = entry.model {
            let actual_norm = comparable(mine.unwrap());
            let expected_norm = comparable(expected.clone());
            assert_eq!(actual_norm, expected_norm, "{where_ctx}: model mismatch");
        }
    }
}

#[test]
fn agentflow_renders_full_upstream_corpus_in_css_and_resolved_resvg_modes() {
    let corpus = load_fixture("agentflow-corpus.json");
    assert!(corpus.len() >= 180, "expected >=180 agentflow corpus entries, got {}", corpus.len());
    let re_bad = Regex::new(r"(?i)<script|<style|<foreignObject|<defs|<marker|\son\w+=|javascript:").unwrap();
    let mut rendered = 0usize;
    for src in &corpus {
        let Ok(css_res) = render(src, &css_options()) else {
            continue;
        };
        rendered += 1;
        let where_ctx = preview(src);
        assert_inert(&css_res.svg, &where_ctx);
        assert!(!re_bad.is_match(&css_res.svg), "{where_ctx}: unsafe markup");
        assert!(!css_res.svg.contains("NaN") && !css_res.svg.contains("Infinity"), "{where_ctx}");
        assert_eq!(render(src, &css_options()).unwrap().svg, css_res.svg, "non-deterministic: {where_ctx}");

        let res = render(src, &resolved_options()).unwrap_or_else(|e| panic!("resolved mode failed for {where_ctx}: {e}"));
        assert_inert_resolved(&res.svg, &where_ctx);
        assert_resvg_parses(&res.svg, &where_ctx);

        let dark = render(src, &dark_options()).unwrap();
        assert_inert_resolved(&dark.svg, &where_ctx);
        assert_resvg_parses(&dark.svg, &where_ctx);
    }
    assert!(rendered > 150, "expected >150 rendered agentflow corpus diagrams, got {rendered}");
}

#[test]
fn agentflow_shapes_directions_edges_flows_collapsed_and_held_edges() {
    let src = "agentflow-beta TB\n  a[\"A\"] --> b[\"B\"]";
    assert_eq!(detect_type(src), Some(DiagramType::Agentflow));
    assert!(supports(src));
    let res = render(src, &css_options()).unwrap();
    assert_eq!(res.diagram_type, DiagramType::Agentflow);
    assert!(res.svg.starts_with(r#"<svg xmlns="http://www.w3.org/2000/svg" class="pele pele-agentflow""#));
    assert!(res.svg.contains(&format!(r#"viewBox="0 0 {} {}""#, res.width, res.height)));
    let m = model_of(src);
    let keys: Vec<&str> = m.nodes.keys().map(String::as_str).collect();
    assert_eq!(keys, vec!["a", "b"]);

    // Directions
    let tall = render("agentflow-beta TB\n  a --> b --> c", &css_options()).unwrap();
    let wide = render("agentflow-beta LR\n  a --> b --> c", &css_options()).unwrap();
    assert!(tall.height > tall.width);
    assert!(wide.width > wide.height);
    let up = svg_of("agentflow-beta BT\n  a --> b");
    assert!(find_node(&up, "a").y > find_node(&up, "b").y);
    let back = svg_of("agentflow-beta RL\n  a --> b");
    assert!(find_node(&back, "a").x > find_node(&back, "b").x);
    let none = svg_of("agentflow-beta\n  a --> b");
    assert!(find_node(&none, "b").y > find_node(&none, "a").y);

    // Six shapes + connector + plain task in their kind color slots
    let svg = svg_of(
        "agentflow-beta LR\n  t[\"T\"]@{ shape: task }\n  o[\"O\"]@{ shape: tool }\n  i[\"I\"]@{ shape: input }\n  d[\"D\"]@{ shape: decision }\n  r[\"R\"]@{ shape: refdoc }\n  c[\"C\"]@{ shape: action }\n  connector k[\"K\"]\n  plain",
    );
    let expected = [
        ("o", "fr-rect", "tool", 1),
        ("t", "rounded", "task", 2),
        ("plain", "rounded", "task", 2),
        ("d", "diam", "decision", 3),
        ("i", "lean-r", "input", 4),
        ("r", "lin-doc", "refdoc", 5),
        ("k", "rounded", "connector", 6),
        ("c", "hex", "action", 7),
    ];
    for (id, shape, kind, slot) in expected {
        let n = find_node(&svg, id);
        assert_eq!(n.classes, format!("pele-node pele-shape-{shape} pele-kind-{kind}"), "id={id}");
        assert!(n.body.contains(&format!(r#"fill="{}"#, series(slot))), "id={id}");
        assert!(n.body.contains(&format!(r#"stroke="{}"#, series(slot))), "id={id}");
        assert!(n.body.contains(r#"fill-opacity="0.14""#), "id={id}");
    }
    assert!(find_node(&svg, "d").body.contains("<polygon"));
    assert!(Regex::new(r"<rect[^>]*\/><path").unwrap().is_match(&find_node(&svg, "o").body));

    // Removed shapes & unsupported shapes
    let rem_src = "agentflow-beta TB\n  a((circle)) --> b([stadium]) --> c[(db)] --> d>odd] --> e(round)";
    let rem_svg = svg_of(rem_src);
    for id in ["a", "b", "c", "d", "e"] {
        assert_eq!(find_node(&rem_svg, id).classes, "pele-node pele-shape-rounded pele-kind-task");
    }
    let rem_model = model_of(rem_src);
    let rem_diags: Vec<(DiagnosticId, DiagnosticSeverity, Option<&str>)> =
        rem_model.diagnostics.iter().map(|d| (d.id, d.severity, d.node_id.as_deref())).collect();
    assert_eq!(
        rem_diags,
        vec![
            (DiagnosticId::ShapeRemoved, DiagnosticSeverity::Error, Some("a")),
            (DiagnosticId::ShapeRemoved, DiagnosticSeverity::Error, Some("b")),
            (DiagnosticId::ShapeRemoved, DiagnosticSeverity::Error, Some("c")),
            (DiagnosticId::ShapeRemoved, DiagnosticSeverity::Error, Some("d")),
        ]
    );
    assert_eq!(rem_model.diagnostics[0].message, r#"shape "circle" was removed in v0.8.1, using "roundedRect""#);
    assert_eq!(rem_model.diagnostics[0].position.unwrap().start_line, 2);
    assert_eq!(rem_model.diagnostics[0].position.unwrap().start_column, 2);

    let unsup_src = "agentflow-beta TB\n  a[\"A\"]\n  a@{ shape: \"triangle\" }\n  a --> b";
    let unsup_model = model_of(unsup_src);
    assert_eq!(unsup_model.diagnostics.len(), 1);
    assert_eq!(unsup_model.diagnostics[0].id, DiagnosticId::ShapeUnsupported);
    assert_eq!(unsup_model.diagnostics[0].severity, DiagnosticSeverity::Warning);
    assert_eq!(unsup_model.diagnostics[0].message, r#"shape "triangle" is not supported, using "roundedRect""#);
    assert_eq!(unsup_model.diagnostics[0].node_id.as_deref(), Some("a"));
    assert!(find_node(&svg_of(unsup_src), "a").classes.contains("pele-shape-rounded"));

    // Three edge kinds, fan-out, self-loop
    let e_svg = svg_of("agentflow-beta TB\n  a --> b\n  a --x c\n  a -.- d\n  a -- \"why\" --> e");
    let all = find_edges(&e_svg);
    assert_eq!(
        all.iter().map(|e| e.classes.as_str()).collect::<Vec<_>>(),
        vec![
            "pele-edge pele-edge-sequence",
            "pele-edge pele-edge-failure",
            "pele-edge pele-edge-reference",
            "pele-edge pele-edge-sequence",
        ]
    );
    assert!(
        Regex::new(r#"<path d="[^"]+"\/><path class="pele-marker" d="[^"]+Z" fill="#)
            .unwrap()
            .is_match(&all[0].body)
    );
    assert!(
        Regex::new(r#"<path d="[^"]+"\/><path class="pele-marker" d="M[^Z"]+"\/>$"#)
            .unwrap()
            .is_match(&all[1].body)
    );
    assert!(Regex::new(r#"^<path d="[^"]+" stroke-dasharray="3 4"\/>$"#).unwrap().is_match(&all[2].body));
    assert!(e_svg.contains(r#"<g class="pele-edge-label" data-id="L_a_e_0">"#));
    assert!(e_svg.contains(">why</text>"));

    let fan = find_edges(&svg_of("agentflow-beta TB\n  a & b --> c & d"));
    assert_eq!(
        fan.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
        vec!["L_a_c_0", "L_a_d_0", "L_b_c_0", "L_b_d_0"]
    );

    let lp = find_edges(&svg_of("agentflow-beta TB\n  a[\"Alpha\"]\n  a --> a"));
    assert_eq!(lp.len(), 1);
    assert!(Regex::new(r#"<path d="M[-\d.]+,[-\d.]+C"#).unwrap().is_match(&lp[0].body));

    // Flows, nesting, own direction, crossed-edge direction inheritance, global nodes
    let f_svg = svg_of("agentflow-beta TB\n  flow team[\"Content Team\"]\n    a[\"A\"] --> b[\"B\"]\n  end\n  c[\"C\"]\n  b --> c");
    let team = find_frame(&f_svg, "team");
    assert!(inside(&find_node(&f_svg, "a"), &team));
    assert!(inside(&find_node(&f_svg, "b"), &team));
    assert!(!inside(&find_node(&f_svg, "c"), &team));
    assert!(
        Regex::new(r#"<text class="pele-cluster-label"[^>]*>Content Team</text>"#)
            .unwrap()
            .is_match(&f_svg)
    );
    assert!(team.rect.contains(&format!(r#"stroke="{}"#, series(8))));
    assert!(team.rect.contains(r#"fill-opacity="0.06""#));

    let nest_svg = svg_of("agentflow-beta TB\n  flow outer[\"Outer\"]\n    flow inner\n      a --> b\n    end\n    c\n  end");
    let outer = find_frame(&nest_svg, "outer");
    let inner = find_frame(&nest_svg, "inner");
    assert!(inner.x > outer.x && inner.y > outer.y && inner.x + inner.w < outer.x + outer.w && inner.y + inner.h < outer.y + outer.h);
    assert!(inside(&find_node(&nest_svg, "a"), &inner));
    assert!(!inside(&find_node(&nest_svg, "c"), &inner));
    assert!(inside(&find_node(&nest_svg, "c"), &outer));
    assert_eq!(nest_svg.matches(r#"class="pele-cluster-label""#).count(), 1);

    let dir_svg = svg_of("agentflow-beta TB\n  flow f[\"F\"]\n    direction LR\n    a --> b\n  end\n  f --> c");
    assert!(find_node(&dir_svg, "b").x > find_node(&dir_svg, "a").x);
    assert!((find_node(&dir_svg, "a").y - find_node(&dir_svg, "b").y).abs() < 1.0);
    assert!(find_node(&dir_svg, "c").y > find_node(&dir_svg, "b").y);

    let flows = "agentflow-beta LR\nflow S\n direction TB\n s1\n s2\nend\nflow P\n direction TB\n p1\n p2\nend\n";
    let links_str = "s1 --> p2\ns2 --> p1\n";
    assert_eq!(
        svg_of(&format!("{flows}{links_str}")),
        svg_of(&format!("{}{links_str}", flows.replace(" direction TB\n", "")))
    );

    let glob_src = "agentflow-beta TB\n  global\n    corpus[\"Shared\"]@{ shape: refdoc }\n  end\n  flow one[\"One\"]\n    a -.- corpus\n  end\n  flow two[\"Two\"]\n    b -.- corpus\n  end";
    let glob_svg = svg_of(glob_src);
    let cn = find_node(&glob_svg, "corpus");
    assert!(!inside(&cn, &find_frame(&glob_svg, "one")));
    assert!(!inside(&cn, &find_frame(&glob_svg, "two")));
    assert_eq!(glob_svg.matches("pele-cluster pele-flow").count(), 2);
    let gm = model_of(glob_src);
    assert_eq!(gm.subgraphs.iter().map(|s| s.nodes.clone()).collect::<Vec<_>>(), vec![vec!["a"], vec!["b"]]);

    // Collapsed flow
    let col_src = "agentflow-beta TB\n  in[\"In\"] --> v\n  flow p[\"Processing\"]\n    v[\"Validate\"] --> e[\"Enrich\"]\n  end\n  p@{ view: \"collapsed\" }\n  e --> out[\"Out\"]";
    let col_svg = svg_of(col_src);
    let p = find_node(&col_svg, "p");
    assert_eq!(p.classes, "pele-node pele-shape-collapsed");
    assert!(p.body.contains(">Processing</text>"));
    assert!(p.body.contains(r#"class="pele-collapsed-mark""#));
    assert!(p.body.contains(&format!(r#"stroke="{}"#, series(8))));
    assert!(!col_svg.contains(r#"data-id="v""#));
    assert!(!col_svg.contains("pele-cluster"));
    assert_eq!(
        find_edges(&col_svg).iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
        vec!["L_in_v_0", "L_e_out_0"]
    );
    assert!(p.y > find_node(&col_svg, "in").y);
    assert!(find_node(&col_svg, "out").y > p.y);

    // Held edges between node and its own flow (including blocked sideways fallback)
    let re_num = Regex::new(r"-?\d+(?:\.\d+)?").unwrap();
    let re_path = Regex::new(r#"<path d="([^"]+)""#).unwrap();
    let ends_of = |body: &str| -> Vec<f64> {
        let d = &re_path.captures(body).unwrap()[1];
        re_num.find_iter(d).map(|m| m.as_str().parse().unwrap()).collect()
    };
    let held_svg = svg_of("agentflow-beta TB\n  flow f[\"My Flow\"]\n    a[\"Task A\"] --> b[\"Task B\"]\n    b --> f\n    f --> a\n  end");
    let f_frame = find_frame(&held_svg, "f");
    let held_e = find_edges(&held_svg);
    let out_e = ends_of(&held_e[1].body);
    let back_e = ends_of(&held_e[2].body);
    assert_eq!(out_e[0], find_node(&held_svg, "b").x);
    assert_eq!(out_e[1], find_node(&held_svg, "b").y + 24.0);
    assert!(out_e[3] > out_e[1] && out_e[3] < f_frame.y + f_frame.h);
    assert_eq!(back_e[1], f_frame.y);
    assert!(back_e[3] < find_node(&held_svg, "a").y - 24.0);

    let blk_svg = svg_of("agentflow-beta TB\n  flow f[\"My Flow\"]\n    a[\"Task A\"] --> b[\"Task B\"]\n    a --> f\n  end");
    let side_e = ends_of(&find_edges(&blk_svg)[1].body);
    assert_eq!(side_e[1], find_node(&blk_svg, "a").y);
    assert_eq!(side_e[3], side_e[1]);
    assert!(side_e[2] < side_e[0]);
}

#[test]
fn agentflow_styles_contrast_casings_links_metadata_positions_comments_and_errors() {
    // Title & accTitle / accDescr
    let plain = render("agentflow-beta TB\n  a --> b", &css_options()).unwrap();
    let titled = render("---\ntitle: Release pipeline\n---\nagentflow-beta TB\n  a --> b", &css_options()).unwrap();
    assert!(titled.svg.contains(r#"class="pele-title" font-weight="var(--_tw)""#));
    assert!(titled.svg.contains("Release pipeline"));
    assert!(titled.height > plain.height);

    let acc_svg = svg_of("agentflow-beta TB\n  accTitle: Review flow\n  accDescr: How a change is reviewed\n  a --> b");
    assert!(acc_svg.contains(r#"<title id="pele-title">Review flow</title>"#));
    assert!(acc_svg.contains(r#"<desc id="pele-desc">How a change is reviewed</desc>"#));

    // Styles, classes, linkStyle
    let sty_svg = svg_of(
        "agentflow-beta TB\n  classDef hot fill:#fdd,stroke:#c00,color:#900\n  a[\"A\"]:::hot --> b[\"B\"]\n  style b stroke-width:3px\n  linkStyle 0 stroke:#0a0",
    );
    let a = find_node(&sty_svg, "a");
    assert_eq!(a.classes, "pele-node pele-shape-rounded pele-kind-task hot");
    assert!(a.body.contains(r#"style="fill:#fdd;stroke:#c00;""#));
    assert!(!a.body.contains("fill-opacity"));
    assert!(a.body.contains(r#"style="fill:#900;""#));
    assert!(find_node(&sty_svg, "b").body.contains(r#"fill-opacity="0.14""#));
    assert!(find_node(&sty_svg, "b").body.contains(r#"style="stroke-width:3px;""#));
    assert!(sty_svg.contains(r#"<g class="pele-edge pele-edge-sequence" data-id="L_a_b_0" style="stroke:#0a0;">"#));

    // Contrast ink on fills
    let con_svg = svg_of(
        "agentflow-beta TB\n  flow f[\"Flow\"]\n    a[\"A\"] --> b[\"B\"]\n  end\n  flow p[\"Packed\"]\n    c[\"C\"]\n  end\n  p@{ view: \"collapsed\" }\n  b --> d[\"D\"]\n  style f fill:#FFF9C4\n  style a fill:#1f3a5f\n  style b fill:#1f3a5f,color:#eee\n  style p fill:navy",
    );
    assert!(
        Regex::new(r#"data-id="f">.*?<text class="pele-cluster-label" fill="var\(--pele-fg-on-light,#1f1f1f\)""#)
            .unwrap()
            .is_match(&con_svg)
    );
    assert!(
        find_node(&con_svg, "a")
            .body
            .contains(r#"<text class="pele-label" fill="var(--pele-fg-on-dark,#fff)""#)
    );
    assert!(!find_node(&con_svg, "b").body.contains("--pele-fg-on"));
    assert!(
        find_node(&con_svg, "p")
            .body
            .contains(r#"<text class="pele-label" fill="var(--pele-fg-on-dark,#fff)""#)
    );
    assert!(!find_node(&con_svg, "d").body.contains("--pele-fg-on"));

    // Casings & over-fill ink
    let case_src = "agentflow-beta TB\n  flow f[\"Flow\"]\n    a[\"A\"] --> b[\"B\"]\n  end\n  b --> c[\"C\"]\n  c --> d[\"D\"]\n  style f fill:#FFF9C4";
    let case_svg = svg_of(case_src);
    let casings = &Regex::new(r#"<g class="pele-casings"[^>]*>(.*?)</g>"#).unwrap().captures(&case_svg).unwrap()[1];
    let re_e = Regex::new(r#"class="pele-edge [^"]*" data-id="[^"]+"([^>]*)><path d="([^"]+)""#).unwrap();
    let es: Vec<(&str, &str)> = re_e
        .captures_iter(&case_svg)
        .map(|c| (c.get(1).unwrap().as_str(), c.get(2).unwrap().as_str()))
        .collect();
    assert_eq!(es.len(), 3);
    assert_eq!(
        es.iter().map(|(_, d)| casings.contains(&format!(r#"<path d="{d}"/>"#))).collect::<Vec<_>>(),
        vec![false, true, false]
    );
    assert_eq!(
        es.iter().map(|(a, _)| *a).collect::<Vec<_>>(),
        vec![r#" stroke="var(--pele-fg-on-light,#1f1f1f)""#, "", ""]
    );
    let held_fill = svg_of("agentflow-beta TB\n  flow f[Flow]\n    a[A]\n  end\n  f --> a\n  style f fill:white");
    assert!(held_fill.contains(r#"data-id="L_f_a_0" stroke="var(--pele-fg-on-light,#1f1f1f)""#));
    assert!(!held_fill.contains("pele-casings"));

    // Click links & no callbacks
    let clk = render(
        "agentflow-beta TB\n  a --> b\n  click a href \"https://example.com/x\" \"Open it\" _blank\n  click b call doIt()",
        &css_options(),
    )
    .unwrap();
    assert!(
        find_node(&clk.svg, "a")
            .body
            .starts_with(r#"<a href="https://example.com/x" target="_blank" rel="noopener"><title>Open it</title>"#)
    );
    assert_eq!(
        clk.links,
        vec![LinkInfo {
            id: "a".to_string(),
            href: "https://example.com/x".to_string(),
            internal: false,
        }]
    );
    assert!(find_node(&clk.svg, "b").classes.contains("clickable"));
    assert!(!clk.svg.contains("doIt"));

    // Wrapping, rankSpacing, minNodeWidth (except diamond)
    let long_svg = svg_of("agentflow-beta TB\n  a[\"A fairly long label that has to wrap over several lines to fit\"]");
    assert!(find_node(&long_svg, "a").body.matches("<tspan").count() > 1);
    let rank_base = render("agentflow-beta TB\n  a --> b", &css_options()).unwrap();
    let rank_wide = render(
        "---\nconfig:\n  agentflow:\n    rankSpacing: 150\n---\nagentflow-beta TB\n  a --> b",
        &css_options(),
    )
    .unwrap();
    assert!(rank_wide.height > rank_base.height + 80.0);

    let re_rw = Regex::new(r#"<rect[^>]* width="([\d.]+)""#).unwrap();
    let min_src = "agentflow-beta TB\n  a[\"A\"] --> b[\"Beta\"]@{ shape: tool }\n  b --> d{\"ok?\"}";
    let min_svg = svg_of(min_src);
    let wa: f64 = re_rw.captures(&find_node(&min_svg, "a").body).unwrap()[1].parse().unwrap();
    let wb: f64 = re_rw.captures(&find_node(&min_svg, "b").body).unwrap()[1].parse().unwrap();
    assert_eq!(wa, 156.0);
    assert!(wb > 156.0 && wb < 180.0);
    let narrow_svg = svg_of(&format!("---\nconfig:\n  agentflow:\n    minNodeWidth: 10\n---\n{min_src}"));
    let wa_narrow: f64 = re_rw.captures(&find_node(&narrow_svg, "a").body).unwrap()[1].parse().unwrap();
    assert!(wa_narrow < 60.0);

    // Reserved `connectors` id skipped
    let conn_skip = svg_of("agentflow-beta TB\n  connectors[\"Mine\"] --> b");
    assert!(!conn_skip.contains(r#"data-id="connectors""#));
    assert!(find_edges(&conn_skip).is_empty());
    assert!(find_node(&conn_skip, "b").classes.contains("pele-kind-task"));

    // Source-mapped positions, front matter, comments, blank-line fold regression, attachments
    let pos_src = "---\nconfig:\n  agentflow:\n    nodeSpacing: 40\n---\nagentflow-beta TB\n  %% a comment that occupies a line\n  alpha[\"Alpha\"]\n  beta[\"Beta\"]\n  alpha --> beta";
    let pos_m = model_of(pos_src);
    let alpha = pos_m.mappings.iter().find(|m| m.id == "alpha").unwrap();
    assert_eq!(alpha.stmt_type, StatementType::Vertex);
    assert_eq!(
        (
            alpha.position.start_line,
            alpha.position.start_column,
            alpha.position.end_line,
            alpha.position.end_column
        ),
        (8, 2, 8, 16)
    );
    assert_eq!(
        pos_m.mappings.iter().find(|m| m.stmt_type == StatementType::Edge).unwrap().position.start_line,
        10
    );

    let err_trail = render("---\ntitle: T\n---\nagentflow-beta TB\n  a@{ shape: rounded }  \n  b -.-> c", &css_options()).unwrap_err();
    assert_eq!((err_trail.line, err_trail.column), (6, 8));

    let meta_prefix = "%%{init:\n{}\n}%%\nagentflow-beta\na[\"#35;\"] --> b@{shape: ";
    let err_shape = parse(&format!("{meta_prefix}bad}}"), &ParseOptions::default()).unwrap_err();
    assert_eq!((err_shape.code, err_shape.line, err_shape.column), (ErrorCode::Semantic, 5, 16));
    let err_yaml = parse(&format!("{meta_prefix}[bad}}"), &ParseOptions::default()).unwrap_err();
    assert_eq!((err_yaml.code, err_yaml.line, err_yaml.column), (ErrorCode::Syntax, 5, 16));
    assert!(err_yaml.message.ends_with("(5:16)"), "msg={}", err_yaml.message);

    // Blank line fold regression (#56)
    let fold_m = parse_raw("agentflow-beta\nflow f[\"F\"]\n  a[\"A\"]@{ shape: rounded }\n\n\n  b[\"B\"]\nend");
    let b_map = fold_m.mappings.iter().find(|m| m.id == "b").unwrap();
    assert_eq!(b_map.position.start_line, 6);
    let fold_trail = parse_raw("agentflow-beta TB\n  a[\"A\"]@{ shape: rounded }   \n\n  b[\"B\"]");
    assert_eq!(fold_trail.mappings.iter().find(|m| m.id == "b").unwrap().position.start_line, 4);

    // Attachment mappings (#75)
    let map_m = model_of("agentflow-beta TB\n  flow f[\"F\"]\n    a[\"A\"]\n  end\n  f@{ view: collapsed }\n  connector k[\"K\"]");
    let summary: Vec<(&str, StatementType, usize, usize)> = map_m
        .mappings
        .iter()
        .map(|m| (m.id.as_str(), m.stmt_type, m.position.start_line, m.position.end_line))
        .collect();
    assert_eq!(
        summary,
        vec![
            ("a", StatementType::Vertex, 3, 3),
            ("f", StatementType::Subgraph, 2, 4),
            ("f", StatementType::Attachment, 5, 5),
            ("k", StatementType::Connector, 6, 7),
        ]
    );

    // Comments everywhere
    let com_src = "%% before the keyword\nagentflow-beta TB %% after the direction\n  a[Plain %% not part of the label\nlabel] --> b %% after a statement\n  %% a line of its own\n  b --> c";
    let com_m = model_of(com_src);
    assert_eq!(com_m.nodes.get("a").unwrap().text.as_deref(), Some("Plain \nlabel"));
    assert_eq!(com_m.edges.len(), 2);
    assert!(!svg_of(com_src).contains("not part"));

    // Grammar, shape, and YAML error reporting
    let open_err = render("agentflow-beta TB\n  flow orphan[\"Orphan\"]\n    a --> b", &css_options()).unwrap_err();
    assert_eq!(open_err.code, ErrorCode::Syntax);
    assert!(open_err.message.contains("Expecting 'end', got '$end'"));
    let trail_eof = render("agentflow-beta TB\n  flow f[\"F\"]\n    a --> b\n\n%% trailing\n", &css_options()).unwrap_err();
    assert_eq!((trail_eof.line, trail_eof.column), (3, 12));
    assert!(
        render("agentflow-beta TB\n  a[50% off]", &css_options())
            .unwrap_err()
            .message
            .starts_with("Lexical error on line 2")
    );
    assert!(
        render("agentflow-beta TB\n  a ==> b", &css_options())
            .unwrap_err()
            .message
            .starts_with("Lexical error on line 2")
    );
    assert!(
        render("agentflow-beta TB\n  a -.-> b", &css_options())
            .unwrap_err()
            .message
            .starts_with("Parse error on line 2")
    );
    assert!(
        render("agentflow-beta TB\n  a@{ label: a^b }", &css_options())
            .unwrap_err()
            .message
            .starts_with("Lexical error on line 2")
    );

    let bad_case = parse("---\ntitle: T\n---\nagentflow-beta TB\n  a[\"A\"]@{ shape: Rounded }", &ParseOptions::default()).unwrap_err();
    assert_eq!(bad_case.code, ErrorCode::Semantic);
    assert_eq!(bad_case.message, "No such shape: Rounded. Shape names should be lowercase.");
    assert_eq!((bad_case.line, bad_case.column), (5, 9));
    assert_eq!(
        parse("agentflow-beta TB\n  a@{ shape: nope }", &ParseOptions::default()).unwrap_err().message,
        "No such shape: nope."
    );
    assert_eq!(
        parse("agentflow-beta TB\n  a@{ shape: 123 }", &ParseOptions::default()).unwrap_err().message,
        "No such shape: 123."
    );
    let bad_tab = parse("agentflow-beta TB\n  b[\"B\"]\n  a[\"A\"]@{\n\tshape: rounded\n  }", &ParseOptions::default()).unwrap_err();
    assert_eq!((bad_tab.code, bad_tab.line, bad_tab.column), (ErrorCode::Syntax, 3, 9));
    assert!(bad_tab.message.starts_with(r#"Metadata of "a" is not valid YAML."#) && bad_tab.message.ends_with("(3:9)"));

    // Trailing commas in multi-line metadata & prototype key stripping
    let tc_m = model_of("agentflow-beta TB\n  connector gh[\"GitHub\"]@{\n    protocol: \"mcp\",\n    tools: [\"read\",\n      \"write\"],\n  }");
    let gh_meta = tc_m.connectors.get("gh").unwrap().metadata.as_ref().unwrap();
    assert_eq!(gh_meta.get("protocol").and_then(YamlValue::as_str), Some("mcp"));
    assert_eq!(gh_meta.get("tools"), Some(&YamlValue::Seq(vec![y_str("read"), y_str("write")])));

    let proto_m =
        model_of("agentflow-beta TB\n  a@{\n    __proto__:\n      polluted: true\n    params:\n      - constructor: x\n        name: first\n    kept: 1\n  }");
    let ameta = proto_m.nodes.get("a").unwrap().metadata.as_ref().unwrap();
    assert!(!ameta.contains_key("__proto__"));
    assert_eq!(ameta.get("kept"), Some(&YamlValue::Number(1.0)));
    if let Some(YamlValue::Seq(items)) = ameta.get("params") {
        let first = items[0].as_map().unwrap();
        assert!(!first.contains_key("constructor"));
        assert_eq!(first.get("name").and_then(YamlValue::as_str), Some("first"));
    } else {
        panic!("expected params seq");
    }
}

#[test]
fn agentflow_compat_color_slots_container_order_diagnostics_and_containment_cycles() {
    // Diagnostic vocabulary partition (diagnostics.spec.ts)
    let mut seen: HashSet<DiagnosticId> = HashSet::new();
    for &id in EMITTED {
        assert!(is_emitted(id) && !is_reserved(id));
        assert!(seen.insert(id));
    }
    for &id in RESERVED {
        assert!(is_reserved(id) && !is_emitted(id));
        assert!(seen.insert(id));
    }
    assert_eq!(seen.len(), DiagnosticId::ALL.len());
    assert_eq!(model_of("agentflow-beta TB\n  a[\"Alpha\"]\n  b[\"Beta\"]\n  a --> b").diagnostics.len(), 0);

    // Color slots invariants (colorSlots.spec.ts)
    for len in [1usize, 3, 6, 7, 8, 12, 24] {
        for i in 0..container_slot_count(len) {
            let slot = container_slot(i, len);
            assert!(slot < len.max(1), "palette {len}, container {i}");
            assert_eq!(slot, slot % len.max(1));
        }
    }
    assert_eq!(container_slot_count(3), 1);

    let mut mock_nodes: Vec<GraphNode> = (0..24)
        .map(|i| GraphNode {
            id: format!("g{i}"),
            label: None,
            label_type: vibevalley_pele::diagram::agentflow::types::LabelType::Text,
            shape: "flowGroup".to_string(),
            is_group: true,
            parent_id: None,
            css_styles: Vec::new(),
            css_compiled_styles: Vec::new(),
            css_classes: String::new(),
            dir: None,
            link: None,
            link_target: None,
            tooltip: None,
            color_index: None,
            kind: None,
            metadata: None,
        })
        .collect();
    let order: HashMap<String, usize> = mock_nodes.iter().enumerate().map(|(i, n)| (n.id.clone(), i)).collect();
    assign_color_slots(&mut mock_nodes, |_| None, &order, 12);
    for n in &mock_nodes {
        let ci = n.color_index.unwrap();
        assert!(ci >= KIND_COUNT && ci % 12 >= KIND_COUNT);
    }

    // Container order through real parse with 12-color palette (containerOrder.spec.ts)
    let slots_of = |src: &str| -> HashMap<String, usize> {
        let mut db = parse_raw(src);
        let g = build_agent_graph(&mut db, 12, None);
        g.nodes.into_iter().filter_map(|n| Some((n.id, n.color_index?))).collect()
    };
    let s1 = slots_of(
        "agentflow-beta TB\n  flow first[\"First\"]\n    a[\"a\"]\n  end\n  flow second[\"Second\"]\n    b[\"b\"]\n  end\n  flow third[\"Third\"]\n    c[\"c\"]\n  end",
    );
    assert_eq!((s1["first"], s1["second"], s1["third"]), (KIND_COUNT, KIND_COUNT + 1, KIND_COUNT + 2));
    let s2 = slots_of(
        "agentflow-beta TB\n  flow outer[\"Outer\"]\n    flow inner[\"Inner\"]\n      a[\"a\"]\n    end\n  end\n  flow sibling[\"Sibling\"]\n    b[\"b\"]\n  end",
    );
    assert_eq!((s2["outer"], s2["inner"], s2["sibling"]), (KIND_COUNT, KIND_COUNT + 1, KIND_COUNT + 2));
    let s3 = slots_of(
        "agentflow-beta TB\n  flow one[\"One\"]\n    a[\"a\"]\n  end\n  flow two[\"Two\"]\n    b[\"b\"]\n  end\n  two@{ view: \"collapsed\" }\n  flow three[\"Three\"]\n    c[\"c\"]\n  end",
    );
    assert_eq!((s3["one"], s3["two"], s3["three"]), (KIND_COUNT, KIND_COUNT + 1, KIND_COUNT + 2));

    // Mutual containment cycles (agentflow-containment-cycle.spec.ts)
    let mutual = |view_a: &str, view_b: &str| {
        format!(
            "agentflow-beta TB\n  flow A[\"Flow A\"]{view_a}\n    a1[\"Task A1\"]\n    a1 --> B\n  end\n  flow B[\"Flow B\"]{view_b}\n    b1[\"Task B1\"]\n    b1 --> A\n  end"
        )
    };
    let mut db = parse_raw(&mutual("", ""));
    let g = build_agent_graph(&mut db, 12, None);
    let parent_of: HashMap<&str, Option<&str>> = g.nodes.iter().map(|n| (n.id.as_str(), n.parent_id.as_deref())).collect();
    assert_eq!(parent_of["A"], Some("B"));
    assert_eq!(parent_of["B"], None);
    assert_eq!(parent_of["a1"], Some("A"));
    assert_eq!(parent_of["b1"], Some("B"));
    assert!(
        db.diagnostics
            .iter()
            .any(|d| d.id == DiagnosticId::ContainmentViolation && d.node_id.as_deref() == Some("B"))
    );

    let mut db_col_a = parse_raw(&mutual("@{ view: collapsed }", ""));
    let g_col_a = build_agent_graph(&mut db_col_a, 12, None);
    let col_a = g_col_a.nodes.iter().find(|n| n.id == "A").unwrap();
    assert_eq!(col_a.shape, "collapsedGroup");
    assert_eq!(col_a.parent_id, None);

    let mut db_both = parse_raw(&mutual("@{ view: collapsed }", "@{ view: collapsed }"));
    assert!(!build_agent_graph(&mut db_both, 12, None).nodes.is_empty());

    let tri = "agentflow-beta TB\n  flow A[\"A\"]@{ view: collapsed }\n    a1[\"a1\"]\n    a1 --> B\n  end\n  flow B[\"B\"]\n    b1[\"b1\"]\n    b1 --> C\n  end\n  flow C[\"C\"]\n    c1[\"c1\"]\n    c1 --> A\n  end";
    let tri_res = render(tri, &resolved_options()).unwrap();
    assert_inert_resolved(&tri_res.svg, "three-container cycle");
    assert_resvg_parses(&tri_res.svg, "three-container cycle");

    // is_tool_definition check
    let tool_db = model_of("agentflow-beta TB\n  t[\"T\"]@{ shape: tool }\n  n[\"N\"]@{ shape: task }");
    assert!(is_tool_definition(tool_db.nodes.get("t").unwrap()));
    assert!(!is_tool_definition(tool_db.nodes.get("n").unwrap()));
}

#[test]
fn agentflow_security_hostile_payloads_options_links_prototypes_and_mutated_fuzz() {
    let h = "agentflow-beta TB\n";
    let templates: Vec<fn(&str) -> String> = vec![
        |p| format!("agentflow-beta TB\n  {p}"),
        |p| format!("agentflow-beta TB\n  {p} --> b"),
        |p| format!("agentflow-beta TB\n  a --> {p}"),
        |p| format!("agentflow-beta TB\n  a[{p}]"),
        |p| format!("agentflow-beta TB\n  a[\"{p}\"]"),
        |p| format!("agentflow-beta TB\n  a[\"`{p}`\"]"),
        |p| format!("agentflow-beta TB\n  a({p})"),
        |p| format!("agentflow-beta TB\n  a{{{p}}}"),
        |p| format!("agentflow-beta TB\n  a{{\"{p}\"}}"),
        |p| format!("agentflow-beta TB\n  a{{{{{p}}}}}"),
        |p| format!("agentflow-beta TB\n  a[[{p}]]"),
        |p| format!("agentflow-beta TB\n  a[/{p}/]"),
        |p| format!("agentflow-beta TB\n  a[\\{p}\\]"),
        |p| format!("agentflow-beta TB\n  a(-{p}-)"),
        |p| format!("agentflow-beta TB\n  a>{p}]"),
        |p| format!("agentflow-beta TB\n  a(({p}))"),
        |p| format!("agentflow-beta TB\n  a([{p}])"),
        |p| format!("agentflow-beta TB\n  a[|{p}:{p}|x]"),
        |p| format!("agentflow-beta TB\n  a -- {p} --> b"),
        |p| format!("agentflow-beta TB\n  a -- \"{p}\" --> b"),
        |p| format!("agentflow-beta TB\n  a -->|{p}| b"),
        |p| format!("agentflow-beta TB\n  a -->|\"{p}\"| b"),
        |p| format!("agentflow-beta TB\n  a --x|\"{p}\"| a"),
        |p| format!("agentflow-beta TB\n  a {p}@--> b"),
        |p| format!("agentflow-beta TB\n  a e1@--> b\n  e1@{{ curve: \"{p}\", animate: \"{p}\", animation: \"{p}\", instruction: \"{p}\" }}"),
        |p| format!("agentflow-beta TB\n  a@{{ label: \"{p}\" }}"),
        |p| format!("agentflow-beta TB\n  a@{{ label: \"{p}\", labelType: \"{p}\" }}"),
        |p| format!("agentflow-beta TB\n  a@{{ shape: {p} }}"),
        |p| format!("agentflow-beta TB\n  a@{{ shape: \"{p}\" }}"),
        |p| format!("agentflow-beta TB\n  a@{{ \"{p}\": \"{p}\" }}"),
        |p| format!("agentflow-beta TB\n  a@{{ {p} }}"),
        |p| format!("agentflow-beta TB\n  a@{{\n    {p}\n  }}"),
        |p| format!("agentflow-beta TB\n  a@{{\n    label: |\n      {p}\n  }}"),
        |p| format!("agentflow-beta TB\n  a[\"A\"]@{{ shape: tool, icon: \"{p}\", img: \"{p}\", form: \"{p}\", pos: \"{p}\", w: \"{p}\", h: \"{p}\" }}"),
        |p| format!("agentflow-beta TB\n  a@{{ shape: tool, class: \"{p}\", style: \"{p}\", view: \"{p}\" }}"),
        |p| format!("agentflow-beta TB\n  flow {p}\n  a\n  end"),
        |p| format!("agentflow-beta TB\n  flow \"{p}\"\n  a\n  end"),
        |p| format!("agentflow-beta TB\n  flow f[{p}]\n  a\n  end"),
        |p| format!("agentflow-beta TB\n  flow f[\"{p}\"]\n  a --> f\n  end\n  f --> b"),
        |p| format!("agentflow-beta TB\n  flow f[\"{p}\"]@{{ view: collapsed, model: \"{p}\" }}\n  a\n  end\n  a --> b"),
        |p| format!("agentflow-beta TB\n  flow f\n  a\n  end\n  f@{{ view: \"{p}\", \"{p}\": 1 }}"),
        |p| format!("agentflow-beta TB\n  flow f\n  a\n  end\n  style f fill:{p}\n  class f {p}"),
        |p| format!("agentflow-beta TB\n  flow f\n  direction {p}\n  a\n  end"),
        |p| format!("agentflow-beta TB\n  connector {p}"),
        |p| format!("agentflow-beta TB\n  connector \"{p}\""),
        |p| format!("agentflow-beta TB\n  connector c[{p}]"),
        |p| format!("agentflow-beta TB\n  connector c[\"{p}\"]@{{ protocol: \"{p}\", \"{p}\": \"{p}\" }}\n  c --> a"),
        |p| format!("agentflow-beta TB\n  global\n  {p}\n  a[\"{p}\"]\n  end\n  flow f\n  a\n  end"),
        |p| format!("agentflow-beta TB\n  a:::{p}"),
        |p| format!("agentflow-beta TB\n  a:::{p} --> b:::{p}"),
        |p| format!("agentflow-beta TB\n  a\n  class a {p}"),
        |p| format!("agentflow-beta TB\n  a\n  class {p} x"),
        |p| format!("agentflow-beta TB\n  a\n  classDef {p} fill:red\n  class a {p}"),
        |p| format!("agentflow-beta TB\n  a\n  classDef c fill:{p}\n  class a c"),
        |p| format!("agentflow-beta TB\n  a\n  classDef c {p}:red\n  class a c"),
        |p| format!("agentflow-beta TB\n  a\n  classDef default fill:{p},color:{p},stroke:{p}\n"),
        |p| format!("agentflow-beta TB\n  a\n  style a fill:{p}\n"),
        |p| format!("agentflow-beta TB\n  a\n  style a {p}:red\n"),
        |p| format!("agentflow-beta TB\n  a\n  style a color:{p},stroke:{p},font-family:{p},font-size:{p}\n"),
        |p| format!("agentflow-beta TB\n  a\n  style {p} fill:red\n"),
        |p| format!("agentflow-beta TB\n  a --> b\n  linkStyle 0 stroke:{p},fill:{p}\n"),
        |p| format!("agentflow-beta TB\n  a --> b\n  linkStyle default {p}:{p}\n"),
        |p| format!("agentflow-beta TB\n  a --> b\n  linkStyle 0 interpolate {p}\n"),
        |p| format!("agentflow-beta TB\n  a --> b\n  linkStyle default interpolate {p} stroke:{p}\n"),
        |p| format!("agentflow-beta TB\n  a\n  click a \"{p}\"\n"),
        |p| format!("agentflow-beta TB\n  a\n  click a href \"{p}\"\n"),
        |p| format!("agentflow-beta TB\n  a\n  click a href \"{p}\" \"{p}\" _blank\n"),
        |p| format!("agentflow-beta TB\n  a\n  click a \"https://example.com\" \"{p}\"\n"),
        |p| format!("agentflow-beta TB\n  a\n  click a call {p}()\n"),
        |p| format!("agentflow-beta TB\n  a\n  click a call cb(\"{p}\") \"{p}\"\n"),
        |p| format!("agentflow-beta TB\n  a\n  click a {p}\n"),
        |p| format!("agentflow-beta TB\n  a\n  click {p} href \"https://example.com\"\n"),
        |p| format!("agentflow-beta TB\n  a[\"{p}\"]:::internal-link"),
        |p| format!("agentflow-beta TB\n  {p}:::internal-link"),
        |p| format!("agentflow-beta TB\n  accTitle: {p}\n  accDescr: {p}\n  a"),
        |p| format!("agentflow-beta TB\n  accDescr {{\n {p}\n }}\n  a"),
        |p| format!("agentflow-beta {p}\n  a"),
        |p| format!("agentflow-beta TB\n  direction {p}\n  a"),
        |p| format!("agentflow-beta TB\n  %% {p}\n  a %% {p}\n  b[x %% {p}\n y]"),
        |p| {
            format!(
                "---\ntitle: \"{p}\"\nconfig:\n  agentflow:\n    nodeSpacing: \"{p}\"\n    rankSpacing: \"{p}\"\n    wrappingWidth: \"{p}\"\n  flowchart:\n    curve: \"{p}\"\n    inheritDir: \"{p}\"\n---\nagentflow-beta TB\n  a --> b"
            )
        },
        |p| format!("---\ntitle: {p}\n---\nagentflow-beta TB\n  a"),
        |p| {
            format!(
                "%%{{init: {{\"agentflow\": {{\"nodeSpacing\": \"{p}\"}}, \"flowchart\": {{\"curve\": \"{p}\"}}, \"themeVariables\": {{\"fontFamily\": \"{p}\"}}}}}}%%\nagentflow-beta TB\n  a --> b"
            )
        },
    ];

    let re_bad_attr = Regex::new(r#" (?:d|transform|points|x|y|width|height|viewBox)="[^"]*(?:NaN|Infinity|undefined)"#).unwrap();
    let check = |src: &str| -> bool {
        let Ok(res) = render(src, &resolved_options()) else {
            return false;
        };
        let ctx = preview(src);
        assert_inert_resolved(&res.svg, &ctx);
        assert!(!re_bad_attr.is_match(&res.svg), "{ctx}: bad numeric attr");
        true
    };

    let mut rendered = 0usize;
    for tmpl in &templates {
        for &payload in PAYLOADS {
            if check(&tmpl(payload)) {
                rendered += 1;
            }
        }
    }
    assert!(rendered > 900, "expected >900 rendered hostile agentflow templates, got {rendered}");

    // Escaping & unsafe link blocking
    let esc_svg = render(
        &format!(
            "{h}  a[\"<img src=x onerror=alert(1)>\"] -- \"</text><script>alert(1)</script>\" --> b[\"a&b\"]\n  flow f[\"<svg onload=alert(1)>\"]\n   c\n  end"
        ),
        &resolved_options(),
    )
    .unwrap()
    .svg;
    assert!(!esc_svg.contains("<img") && !esc_svg.contains("<script") && !esc_svg.contains("<svg onload") && esc_svg.contains("a&amp;b"));
    assert_resvg_parses(&esc_svg, "escaped markup");

    let id_svg = render(&format!("{h}  flow q&r\n  a\n  end\n  connector 'x&y'"), &resolved_options())
        .unwrap()
        .svg;
    assert!(id_svg.contains(r#"data-id="q&amp;r""#) && id_svg.contains(r#"data-id="'x&amp;y'""#));

    let unsafe_href_re = Regex::new(r#"(?i)href="(?:\s*javascript|data|vbscript)"#).unwrap();
    let unsafe_scheme_re = Regex::new(r"(?i)^\s*(?:javascript|data|vbscript):").unwrap();
    for url in [
        "javascript:alert(1)",
        " JaVaScRiPt:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "vbscript:x",
    ] {
        let res = render(&format!("{h}  a\n  click a href \"{url}\""), &resolved_options()).unwrap();
        assert!(!unsafe_href_re.is_match(&res.svg));
        for link in &res.links {
            assert!(!unsafe_scheme_re.is_match(&link.href));
        }
    }

    let il = render(&format!("{h}  a[\"javascript:alert(1)\"]:::internal-link"), &resolved_options()).unwrap();
    assert!(il.svg.contains(r#"<a class="internal-link" data-href="javascript:alert(1)">"#));
    assert_eq!(
        il.links,
        vec![LinkInfo {
            id: "a".to_string(),
            href: "javascript:alert(1)".to_string(),
            internal: true,
        }]
    );

    // Hostile option values
    for &payload in PAYLOADS {
        let opts = RenderOptions {
            measurer: Some(&METRICS_MEASURER),
            theme_mode: ThemeMode::light(),
            id_prefix: Some(payload.to_string()),
            font_family: Some(payload.to_string()),
            ..RenderOptions::default()
        };
        let res = render(&format!("{h}  accTitle: t\n  flow f[\"F\"]\n  a --> b\n  end"), &opts).unwrap();
        assert_inert_resolved(&res.svg, payload);
        assert_resvg_parses(&res.svg, payload);
    }

    // Prototype names & constructor shape
    let ctor_m = model_of(&format!("{h}  a@{{ shape: constructor }}"));
    assert_eq!(
        ctor_m.diagnostics.iter().map(|d| d.id).collect::<Vec<_>>(),
        vec![DiagnosticId::ShapeUnsupported]
    );

    // Mutated fuzz
    let corpus = load_fixture("agentflow-corpus.json");
    let mut fragments: Vec<&str> = PAYLOADS.to_vec();
    fragments.extend([
        "\"",
        "`",
        "{",
        "}",
        "[",
        "]",
        "(",
        ")",
        "|",
        "\n",
        ":::",
        "-->",
        "--x",
        "-.-",
        " -- ",
        "@{ ",
        "label: ",
        "shape: ",
        "view: collapsed",
        "style a fill:",
        "classDef c ",
        "click a href \"",
        "flow ",
        "connector ",
        "global\n",
        "end\n",
        "%% ",
    ]);
    let mut mutator = Mutator::new(&corpus, fragments, 3);
    for _ in 0..1000 {
        let sample = mutator.next_sample();
        if sample.len() <= 4000 {
            let _ = check(&sample);
        }
    }
}

#[test]
fn agentflow_stress_linear_time_and_limits() {
    let h = "agentflow-beta TB\n";
    let err = render(&format!("{h}{}", "A --> B\n".repeat(7000)), &resolved_options()).unwrap_err();
    assert_eq!(err.code, ErrorCode::Limit);
    assert!(err.message.contains("limit of 50000"));

    let n = 50_000usize;
    let big = RenderOptions {
        measurer: Some(&METRICS_MEASURER),
        theme_mode: ThemeMode::light(),
        limit: Some(usize::MAX),
        output_limit: Some(usize::MAX),
        max_edges: Some(50_000),
        ..RenderOptions::default()
    };

    let started = Instant::now();
    let _ = tokenize(&format!("{h}{}direction XX", "A ".repeat(n / 2)));
    let _ = tokenize(&format!("{h}{}TB", format!("direction{}", "\n".repeat(9)).repeat(n / 18)));
    let _ = tokenize(&format!("{h}a{}-b", " ".repeat(n)));
    let _ = tokenize(&format!("{h}a -- {}-b", " ".repeat(n)));
    let _ = tokenize(&format!("{h}{}{{", "@".repeat(n)));
    let _ = tokenize(&format!("{h}a[{}]", "x %% c\n".repeat(n / 7)));
    let _ = render(
        &format!(
            "{h}{}A --> B\n{}",
            (0..1500).map(|i| format!("flow s{i}\n")).collect::<String>(),
            "end\n".repeat(1500)
        ),
        &big,
    )
    .unwrap();
    let _ = render(
        &format!(
            "{h}{}A --> B\n{}",
            (0..1500).map(|i| format!("flow s{i}@{{ view: collapsed }}\n")).collect::<String>(),
            "end\n".repeat(1500)
        ),
        &big,
    )
    .unwrap();
    let _ = render(
        &format!("{h}a@{{\n{}}}\n", (0..5000).map(|i| format!("  k{i}: \"v\",\n")).collect::<String>()),
        &big,
    )
    .unwrap();
    let _ = render(
        &format!("{h}flow f\n{}end\n", (0..1000).map(|i| format!("n{i} --> f\n")).collect::<String>()),
        &big,
    )
    .unwrap();
    assert!(started.elapsed().as_secs() < 10, "agentflow stress took {:?}", started.elapsed());
}
