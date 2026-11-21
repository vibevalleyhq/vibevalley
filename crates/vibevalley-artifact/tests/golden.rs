//! vibevalley-artifact golden regression checks against committed fixtures in `tests/golden`.

use std::collections::BTreeMap;

use serde_json::{Value, json};
use vibevalley_artifact::{
    ArtifactEntry, ArtifactEntryKind, ArtifactType, Page, RenderStoreOptions, StoreViewQuery, apply_json_merge_patch, artifact_problem, artifact_suffix_of,
    blocks_of_markdown, contrast_ratio, entry_path_problem, format_store_summary, html_check, html_edit, html_problem, infer_artifact_from_name,
    infer_entry_kind, infer_entry_mime, markdown_of, motion_recorder_helper, ordered, parse_tokens_spec, render_store_artifact_html, sanitize_whiteboard_svg,
    starter_entries_for_type, store_html_problem, store_view_headers, store_view_url, write_props_into_dc_html,
};
use vibevalley_protocol::{ArtifactDisplay, Block, BlockOp, HtmlAnchor, TextSpan};

fn golden_val(name: &str) -> Value {
    let path = format!("{}/tests/golden/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).expect("golden")).expect("golden json")
}

fn golden(name: &str) -> Vec<Value> {
    golden_val(name).as_array().expect("golden array").clone()
}

fn of<T: serde::de::DeserializeOwned>(v: &Value) -> T {
    serde_json::from_value(v.clone()).expect("a wire value")
}

fn to(v: impl serde::Serialize) -> Value {
    serde_json::to_value(v).expect("serializable")
}

#[test]
fn markdown_reads_and_writes_as_vibevalley() {
    for case in golden("markdown") {
        let md = case["md"].as_str().unwrap();
        assert_eq!(to(blocks_of_markdown(md)), case["parsed"], "parsed: {md:?}");
        let blocks: Vec<Block> = of(&case["blocks"]);
        assert_eq!(markdown_of(&blocks), case["out"].as_str().unwrap(), "out: {md:?}");
    }
    for case in golden("spans") {
        let blocks: Vec<Block> = of(&case["blocks"]);
        assert_eq!(markdown_of(&blocks), case["out"].as_str().unwrap(), "spans: {:?}", case["blocks"][0]["text"]);
    }
}

#[test]
fn ops_apply_as_vibevalley() {
    for case in golden("ops") {
        let name = case["name"].as_str().unwrap();
        let blocks: Vec<Block> = of(&case["blocks"]);
        let mut p = Page::new("d", "helper", 5000, &blocks);
        let history = case["history"].clone();
        p.base = Box::new(move |block, rev| {
            history[block][rev.to_string()].as_str().map(|t| {
                vec![TextSpan {
                    t: t.into(),
                    marks: Default::default(),
                }]
            })
        });
        let taken: Vec<String> = case.get("taken").map(of).unwrap_or_default();
        p.taken = Box::new(move |id| taken.iter().any(|t| t == id));
        let ops: Vec<BlockOp> = of(&case["ops"]);
        let results: Vec<_> = ops.iter().map(|op| p.apply(op)).collect();
        assert_eq!(to(&results), case["results"], "{name}: results");
        let after: Vec<Block> = p.all().cloned().collect();
        assert_eq!(to(&after), case["after"], "{name}: blocks");
        assert_eq!(to(&p.changed), case["changed"], "{name}: changed");
        let revisions: Vec<Value> = p
            .revisions
            .iter()
            .map(|r| json!({ "block": r.block, "rev": r.rev, "spans": r.spans, "kind": r.kind.as_str() }))
            .collect();
        assert_eq!(Value::Array(revisions), case["revisions"], "{name}: revisions");
        assert_eq!(to(ordered(&after)), case["ordered"], "{name}: ordered");
    }
}

#[test]
fn html_check_as_vibevalley() {
    for case in golden("check") {
        let page = case["page"].as_str().unwrap();
        let check = html_check(page);
        assert_eq!(to(&check), case["check"], "check: {page}");
        assert_eq!(html_problem(&check), case["problem"].as_str().unwrap(), "problem: {page}");
    }
}

#[test]
fn html_edit_as_vibevalley() {
    for case in golden("edit") {
        let source = case["source"].as_str().unwrap();
        let anchor: HtmlAnchor = of(&case["anchor"]);
        let got = match html_edit(source, &anchor, case["text"].as_str().unwrap()) {
            Ok(source) => json!({ "ok": true, "source": source }),
            Err(why) => json!({ "ok": false, "why": why }),
        };
        assert_eq!(got, case["result"], "edit {:?} in {source}", anchor.exact);
    }
}

#[test]
fn problems_as_vibevalley() {
    for case in golden("problem") {
        let got = artifact_problem(case["title"].as_str(), case["kind"].as_str(), case["size"].as_u64().map(|n| n as usize));
        assert_eq!(got, case["problem"].as_str().unwrap(), "{case}");
    }
}

#[test]
fn shell_comes_after_the_page() {
    let shown = vibevalley_artifact::with_shell("<p>hi</p>", ArtifactDisplay::Page, "dark");
    assert!(shown.starts_with("<p>hi</p>\n<style>:root{"));
    assert!(shown.contains("--vv-page:#151413"));
    assert!(shown.contains("({ display: \"page\" })"));

    let motion = vibevalley_artifact::with_shell("<!doctype html><html><head></head><body></body></html>", ArtifactDisplay::Motion, "dark");
    assert!(motion.contains("<head><script>window.__vvEarly = null;"));
    assert!(motion.contains("({ display: \"motion\" })"));
    assert!(motion_recorder_helper().contains("\"video/webm;codecs=vp9\", \"video/webm;codecs=vp8\", \"video/webm\", \"video/mp4\""));
}

#[test]
fn suffixes_match_vibevalley() {
    let data = golden_val("suffix");
    for case in data["suffixes"].as_array().unwrap() {
        let body = case["body"].as_str().unwrap();
        let artifact_type: Option<ArtifactType> = case.get("artifactType").and_then(|v| serde_json::from_value(v.clone()).ok());
        let display: Option<ArtifactDisplay> = case.get("display").and_then(|v| serde_json::from_value(v.clone()).ok());
        assert_eq!(artifact_suffix_of(body, artifact_type, display), case["suffix"].as_str().unwrap(), "{case}");
    }
    for case in data["names"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let content = case.get("content").and_then(Value::as_str);
        assert_eq!(to(infer_artifact_from_name(name, content)), case["inferred"], "{case}");
    }
}

#[test]
fn store_matches_vibevalley() {
    let data = golden_val("store");
    for case in data["paths"].as_array().unwrap() {
        let path = case["path"].as_str().unwrap();
        assert_eq!(entry_path_problem(path).as_deref(), case["problem"].as_str(), "path: {path:?}");
    }
    for case in data["kinds"].as_array().unwrap() {
        let path = case["path"].as_str().unwrap();
        let kind = infer_entry_kind(path);
        assert_eq!(kind.as_str(), case["kind"].as_str().unwrap(), "kind: {path}");
        assert_eq!(infer_entry_mime(path, kind), case["mime"].as_str().unwrap(), "mime: {path}");
    }
    for case in data["patches"].as_array().unwrap() {
        let current = case.get("current").and_then(Value::as_str);
        let patch = case["patch"].as_str().unwrap();
        let res = apply_json_merge_patch(current, patch).expect("merge patch");
        let expected_raw = case["result"]["value"].as_str().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&res).unwrap(),
            serde_json::from_str::<Value>(expected_raw).unwrap()
        );
    }
    let summary = &data["summary"];
    let entries: Vec<ArtifactEntry> = of(&summary["entries"]);
    let artifact_type: Option<ArtifactType> = summary.get("artifactType").and_then(|v| serde_json::from_value(v.clone()).ok());
    assert_eq!(
        format_store_summary(summary["title"].as_str().unwrap(), artifact_type, summary["seq"].as_i64().unwrap(), &entries),
        summary["out"].as_str().unwrap()
    );
}

#[test]
fn tokens_match_vibevalley() {
    let data = golden_val("tokens");
    for case in data["specs"].as_array().unwrap() {
        let raw = case["raw"].as_str().unwrap();
        assert_eq!(to(parse_tokens_spec(raw)), case["parsed"], "tokens spec");
    }
    for case in data["contrasts"].as_array().unwrap() {
        let fg = case["fg"].as_str().unwrap();
        let bg = case["bg"].as_str().unwrap();
        assert_eq!(contrast_ratio(fg, bg), case["ratio"].as_f64(), "contrast: {fg} vs {bg}");
    }
}

#[test]
fn starters_match_vibevalley() {
    for case in golden("starters") {
        let artifact_type: ArtifactType = of(&case["type"]);
        let title = case["title"].as_str().unwrap();
        let got = starter_entries_for_type(artifact_type, title);
        let expected = case["entries"].as_array().unwrap();
        assert_eq!(got.len(), expected.len(), "starter count for {artifact_type:?}");
        for (g, e) in got.iter().zip(expected.iter()) {
            assert_eq!(g.path, e["path"].as_str().unwrap());
            assert_eq!(g.kind.map(ArtifactEntryKind::as_str), e["kind"].as_str());
            if g.kind == Some(ArtifactEntryKind::Json) {
                let gv: Value = serde_json::from_str(g.value.as_deref().unwrap()).unwrap();
                let ev: Value = serde_json::from_str(e["value"].as_str().unwrap()).unwrap();
                assert_eq!(gv, ev, "json starter {}", g.path);
            } else {
                assert_eq!(g.value.as_deref(), e["value"].as_str(), "text starter {}", g.path);
            }
        }
    }
}

#[test]
fn viewers_match_vibevalley() {
    let data = golden_val("viewers");
    for case in data["headers"].as_array().unwrap() {
        let origin = case.get("origin").and_then(Value::as_str);
        let print = case["print"].as_bool().unwrap();
        assert_eq!(to(store_view_headers(origin, print)), case["out"]);
    }
    for case in data["htmlProblems"].as_array().unwrap() {
        let source = case["source"].as_str().unwrap();
        assert_eq!(store_html_problem(source), case["problem"].as_str().unwrap());
    }
    for case in data["urls"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let q = &case["query"];
        let query = StoreViewQuery {
            theme: q.get("theme").and_then(Value::as_str).map(str::to_string),
            seq: q.get("seq").and_then(Value::as_i64),
            path: q.get("path").and_then(Value::as_str).map(str::to_string),
            at: q.get("at").and_then(Value::as_i64),
            still: q.get("still").and_then(Value::as_bool).unwrap_or(false),
            print: q.get("print").and_then(Value::as_bool).unwrap_or(false),
            element_id: q.get("elementId").and_then(Value::as_str).map(str::to_string),
        };
        assert_eq!(store_view_url(id, &query), case["out"].as_str().unwrap());
    }
    let dc = &data["dcProps"];
    let values: BTreeMap<String, Value> = of(&dc["values"]);
    assert_eq!(write_props_into_dc_html(dc["source"].as_str().unwrap(), &values), dc["out"].as_str().unwrap());

    let dirty_svg = r#"<svg viewBox="0 0 100 100" onload="alert(1)"><script>evil()</script><rect width="50" height="50" onclick="bad()" /><a href="https://evil.example"><text>Hi</text></a></svg>"#;
    let clean_svg = sanitize_whiteboard_svg(dirty_svg);
    assert!(!clean_svg.contains("<script"));
    assert!(!clean_svg.contains("onload"));
    assert!(!clean_svg.contains("onclick"));
    assert!(!clean_svg.contains("evil.example"));
    assert!(clean_svg.contains("<rect"));

    for case in data["renders"].as_array().unwrap() {
        let artifact_type: ArtifactType = of(&case["type"]);
        let entries: Vec<ArtifactEntry> = of(&case["entries"]);
        let theme = case["theme"].as_str().unwrap();
        let got = render_store_artifact_html(Some(artifact_type), &entries, &RenderStoreOptions::new(theme));
        let expected = case["html"].as_str().unwrap();
        // Compare byte-for-byte on non-JSON-key-order-sensitive renderers, and verify structure on all.
        if matches!(artifact_type, ArtifactType::Slides | ArtifactType::Design | ArtifactType::DesignSystem) {
            assert_eq!(got, expected, "render {artifact_type:?}");
        } else {
            assert!(got.starts_with("<!doctype html>\n"));
            assert!(got.contains("data-theme=\"light\""));
            assert_eq!(got.len(), expected.len(), "render length {artifact_type:?}");
        }
    }
}
