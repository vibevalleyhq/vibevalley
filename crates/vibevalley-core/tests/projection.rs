//! VibeValley's TypeScript `reduce`, `effectsOf` and `frameOf` folded these
//! facts (`crates/vibevalley-protocol/golden/projection/*.json`, kept as they
//! were written before the server moved to Rust); ours must say, after
//! every fact, whether it changed anything, the effects it set off and the
//! state, and frame the end state the same.

use serde_json::Value;
use vibevalley_core::{empty_space_state, frame_of, game::effects_of, reduce};
use vibevalley_protocol::{Fact, GameEffect};

fn diff(path: &str, want: &Value, got: &Value, out: &mut Vec<String>) {
    match (want, got) {
        (Value::Object(a), Value::Object(b)) => {
            for k in a.keys().chain(b.keys().filter(|k| !a.contains_key(*k))) {
                diff(&format!("{path}.{k}"), a.get(k).unwrap_or(&Value::Null), b.get(k).unwrap_or(&Value::Null), out);
            }
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
            for (i, (x, y)) in a.iter().zip(b).enumerate() {
                diff(&format!("{path}[{i}]"), x, y, out);
            }
        }
        _ if want != got => out.push(format!("{path}: want {want}, got {got}")),
        _ => {}
    }
}

fn scenario(name: &str) {
    let path = format!("{}/../vibevalley-protocol/golden/projection/{name}.json", env!("CARGO_MANIFEST_DIR"));
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let mut state = empty_space_state();
    let mut seq = 0;
    let mut all_effects: Vec<GameEffect> = vec![];
    let mut problems = vec![];
    for (i, fold) in golden["folds"].as_array().unwrap().iter().enumerate() {
        let fact: Fact = serde_json::from_value(fold["fact"].clone()).unwrap();
        let before = state.clone();
        let changed = reduce(&mut state, &fact);
        let effects = if changed { effects_of(&before, &fact) } else { vec![] };
        let kind = fold["fact"]["type"].as_str().unwrap();
        if Value::Bool(changed) != fold["changed"] {
            problems.push(format!("fact {i} ({kind}): changed {changed}, want {}", fold["changed"]));
        }
        diff(
            &format!("fact {i} ({kind}) effects"),
            &fold["effects"],
            &serde_json::to_value(&effects).unwrap(),
            &mut problems,
        );
        diff(
            &format!("fact {i} ({kind}) state"),
            &fold["state"],
            &serde_json::to_value(&state).unwrap(),
            &mut problems,
        );
        if changed {
            seq += 1;
            all_effects.extend(effects);
        }
    }
    let frame = frame_of(&state, all_effects, seq);
    diff("frame", &golden["frame"], &serde_json::to_value(&frame).unwrap(), &mut problems);
    assert!(problems.is_empty(), "{name}: {} differences\n{}", problems.len(), problems.join("\n"));
}

#[test]
fn board() {
    scenario("board");
}

#[test]
fn sessions_and_farm() {
    scenario("sessions_and_farm");
}

#[test]
fn chat_crons_and_rest() {
    scenario("chat_crons_and_rest");
}

#[test]
fn families() {
    scenario("families");
}

#[test]
fn reviewed_and_answers() {
    scenario("reviewed_and_answers");
}
