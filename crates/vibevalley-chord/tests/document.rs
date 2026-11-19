use serde::Deserialize;
use serde_json::{Value, json};
use vibevalley_chord::{
    delta::{Op, Snapshot},
    watch::Document,
};

#[derive(Deserialize)]
struct Case {
    input: Value,
    operations: Vec<Op>,
    #[serde(default)]
    result: Value,
    hash: Option<String>,
}

#[test]
fn delta_wire_results_and_hashes() {
    let cases: Vec<Case> = serde_json::from_str(include_str!("fixtures/delta.json")).unwrap();
    for case in cases {
        let original = Snapshot::new(case.input.clone());
        let applied = original.apply(&case.operations);
        assert_eq!(json!(original), case.input);
        if let Some(hash) = case.hash {
            let snapshot = applied.unwrap();
            assert!(vibevalley_chord::delta::equal(&json!(snapshot), &case.result));
            let computed: String = snapshot.hash().iter().map(|b| format!("{b:02x}")).collect();
            assert_eq!(computed, hash);
            let round_trip: Vec<Op> = serde_json::from_value(json!(case.operations)).unwrap();
            assert_eq!(round_trip, case.operations);
        } else {
            assert!(applied.is_err());
        }
    }
}

fn apply(doc: &Document, op: Value) {
    doc.mutate(|d| d.apply(serde_json::from_value(op).unwrap())).unwrap();
}

#[test]
fn slow_watchers_reconnect_retire_and_rebuild() {
    let doc = Document::with_limits(Snapshot::new(json!({"message":""})), 2, 2);
    let mut slow = doc.watch(0);
    assert_eq!(slow.recv().unwrap().rev, 1);
    apply(&doc, json!(["a", ["message"], "hel"]));
    apply(&doc, json!(["a", ["message"], "lo"]));
    let mut catchup = doc.watch(1);
    for subscriber in [&mut catchup, &mut slow] {
        let e = subscriber.recv().unwrap();
        assert_eq!(json!(e.ops), json!([["a", ["message"], "hello"]]));
        assert_eq!(e.rev, 3);
    }
    for n in 0..3 {
        apply(&doc, json!(["r", [n.to_string()], n]));
    }
    let overflow = slow.recv().unwrap();
    assert!(overflow.overflow);
    assert_eq!(json!(overflow.ops), json!([["r", overflow.snapshot]]));
    assert_eq!(json!(doc.watch(1).recv().unwrap().ops), json!([["r", overflow.snapshot]]));
    assert_eq!(doc.retire(), 6);
    assert!(slow.recv().unwrap().retired);
    assert!(doc.watch(6).recv().unwrap().retired);
    doc.rebuild(Snapshot::new(json!({"ready":true})));
    let rebuilt = slow.recv().unwrap();
    assert_eq!(rebuilt.rev, 7);
    assert_eq!(json!(rebuilt.ops), json!([["r",{"ready":true}]]));
    drop(doc);
    assert!(slow.recv().is_none());
}

#[test]
fn splice_is_a_barrier_to_pruning_array_index_writes() {
    let base = Snapshot::new(json!({"a":["x","y"]}));
    let doc = Document::new(base.clone());
    let mut sub = doc.watch(1);
    for op in [
        json!(["r", ["a", "0"], "before"]),
        json!(["s", ["a"], 0, 0, "inserted"]),
        json!(["r", ["a", "0"], "after"]),
    ] {
        apply(&doc, op);
    }
    let e = sub.recv().unwrap();
    assert_eq!(e.ops.len(), 3);
    assert_eq!(json!(base.apply(&e.ops).unwrap()), json!({"a":["after","before","y"]}));
}
