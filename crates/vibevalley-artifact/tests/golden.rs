//! vibevalley-artifact against VibeValley's own packages/artifact: the goldens
//! in `tests/golden` are written by `gen/artifact.ts`.

use serde_json::{Value, json};
use vibevalley_artifact::{Page, artifact_problem, blocks_of_markdown, html_check, html_edit, html_problem, markdown_of, ordered};
use vibevalley_protocol::{Block, BlockOp, HtmlAnchor, TextSpan};

fn golden(name: &str) -> Vec<Value> {
    let path = format!("{}/tests/golden/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).expect("golden")).expect("golden json")
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
    let shown = vibevalley_artifact::with_shell("<p>hi</p>", vibevalley_protocol::ArtifactDisplay::Page, "dark");
    assert!(shown.starts_with("<p>hi</p>\n<style>:root{"));
    assert!(shown.contains("--vv-page:#151413"));
    assert!(shown.contains("({ display: \"page\" })"));
}
