//! Every contract type against wire values built from the zod schema it had
//! when the contract was TypeScript (`golden/schema/*.json`, each accepted by
//! the schema's `safeParse`): read into the Rust type and written back, the
//! JSON must be the same.

use serde_json::Value;

#[test]
fn every_generated_type_round_trips_its_schemas_samples() {
    let dir = format!("{}/golden/schema", env!("CARGO_MANIFEST_DIR"));
    let mut types = 0;
    let mut values = 0;
    let mut failures = Vec::new();
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        let Value::Object(by_name) = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap() else {
            panic!("{} is not an object", path.display())
        };
        for (name, samples) in by_name {
            types += 1;
            for (i, want) in samples.as_array().unwrap().iter().enumerate() {
                values += 1;
                match vibevalley_protocol::registry::round_trip(&name, want.clone()) {
                    None => failures.push(format!("{name}: no such type")),
                    Some(Err(e)) => failures.push(format!("{name}[{i}]: {e}\n  {want}")),
                    Some(Ok(got)) if &got != want => failures.push(format!("{name}[{i}] changed:\n  want {want}\n  got  {got}")),
                    Some(Ok(_)) => {}
                }
            }
        }
    }
    assert!(failures.is_empty(), "{} of {values} samples failed:\n{}", failures.len(), failures.join("\n"));
    assert!(types > 450, "only {types} types sampled");
    eprintln!("{types} types, {values} samples");
}
