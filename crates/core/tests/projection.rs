//! VibeValley's TypeScript `reduce`, `effectsOf` and `frameOf` folded these
//! facts (`crates/protocol/golden/projection/*.json`, kept as they
//! were written before the server moved to Rust); ours must say, after
//! every fact, whether it changed anything, the effects it set off and the
//! state, and project the end state into domain slices identically.

use serde_json::Value;
use vibevalley_core::{empty_space_state, game, reduce, slice_bundle};
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
    let path = format!("{}/../protocol/golden/projection/{name}.json", env!("CARGO_MANIFEST_DIR"));
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let mut state = empty_space_state();
    let mut seq = 0;
    let mut all_effects: Vec<GameEffect> = vec![];
    let mut problems = vec![];
    for (i, fold) in golden["folds"].as_array().unwrap().iter().enumerate() {
        let fact: Fact = serde_json::from_value(fold["fact"].clone()).unwrap();
        let before = state.clone();
        let dirty = reduce(&mut state, &fact);
        let changed = !dirty.is_empty();
        let effects = if changed { game::effects_of(&before, &fact) } else { vec![] };
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
    let bundle = slice_bundle(&state, all_effects, seq);
    let want_frame = &golden["frame"];
    let want_state = &want_frame["state"];
    let got_bundle = serde_json::to_value(&bundle).unwrap();

    assert!(bundle.board.board_summary.is_some(), "{name}: missing board_summary");
    assert!(bundle.collab.channel_summary.is_some(), "{name}: missing channel_summary");
    assert!(bundle.ops.media_summary.is_some(), "{name}: missing media_summary");

    diff("seq", &want_frame["seq"], &got_bundle["seq"], &mut problems);
    diff("board.issues", &want_state["issues"], &got_bundle["board"]["issues"], &mut problems);
    diff(
        "board.commits",
        want_state.get("commits").unwrap_or(&Value::Null),
        got_bundle["board"].get("commits").unwrap_or(&Value::Null),
        &mut problems,
    );
    diff("sessions.sessions", &want_state["sessions"], &got_bundle["sessions"]["sessions"], &mut problems);
    diff("sessions.machines", &want_state["machines"], &got_bundle["sessions"]["machines"], &mut problems);
    diff(
        "collab.chat",
        want_state.get("chat").unwrap_or(&Value::Null),
        got_bundle["collab"].get("chat").unwrap_or(&Value::Null),
        &mut problems,
    );
    diff(
        "collab.connectors",
        &want_state["connectors"],
        &got_bundle["collab"]["connectors"],
        &mut problems,
    );
    diff("inbox.items", &want_frame["inbox"], &got_bundle["inbox"]["items"], &mut problems);
    diff("inbox.call", &want_state["call"], &got_bundle["inbox"]["call"], &mut problems);
    diff("inbox.callReason", &want_state["callReason"], &got_bundle["inbox"]["callReason"], &mut problems);
    diff("ops.crons", &want_state["crons"], &got_bundle["ops"]["crons"], &mut problems);
    diff(
        "ops.media",
        want_state.get("media").unwrap_or(&Value::Null),
        got_bundle["ops"].get("media").unwrap_or(&Value::Null),
        &mut problems,
    );
    diff(
        "farm.progress",
        want_state.get("progress").unwrap_or(&Value::Null),
        got_bundle["farm"].get("progress").unwrap_or(&Value::Null),
        &mut problems,
    );
    diff("farm.effects", &want_frame["effects"], &got_bundle["farm"]["effects"], &mut problems);

    let mut want_view = want_frame["view"].clone();
    let want_achievements = want_view.as_object_mut().and_then(|o| o.remove("achievements")).unwrap_or(Value::Null);
    diff("farm.view", &want_view, &got_bundle["farm"]["view"], &mut problems);
    let got_standings = serde_json::to_value(game::standings_of(state.progress.as_ref())).unwrap();
    diff("achievements", &want_achievements, &got_standings, &mut problems);

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
