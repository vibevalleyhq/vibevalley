//! `vibevalley_core::note` golden & unit checks for the unified
//! directory-backed 4-type note layout, path validation, manifest codec,
//! and starter directory builder.

use serde_json::Value;
use vibevalley_core::note::{
    MANIFEST_FILE, NotePathZone, all_type_specs, apply_json_merge_patch, canonical_json, default_manifest, format_directory_summary, infer_encoding,
    infer_mime, parse_manifest, serialize_manifest, starter_directory, title_problem, type_spec, validate_deletable_path, validate_note_path, validate_prefix,
};
use vibevalley_protocol::{NoteFileMeta, NoteType};

fn golden_val(name: &str) -> Value {
    let path = format!("{}/tests/golden/note/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).expect("golden")).expect("golden json")
}

#[test]
fn valid_and_invalid_note_paths_and_mimes_match_golden() {
    let data = golden_val("directory");

    for case in data["validPaths"].as_array().unwrap() {
        let path = case["path"].as_str().unwrap();
        let zone = validate_note_path(path).unwrap_or_else(|e| panic!("expected valid path {path:?}: {e}"));
        assert_eq!(zone.as_str(), case["zone"].as_str().unwrap(), "zone for {path}");
        assert_eq!(infer_mime(path), case["mime"].as_str().unwrap(), "mime for {path}");
        assert_eq!(infer_encoding(path).as_str(), case["encoding"].as_str().unwrap(), "encoding for {path}");

        if zone == NotePathZone::Manifest {
            assert!(validate_deletable_path(path).is_err(), "manifest.json must not be deletable");
        } else {
            assert_eq!(validate_deletable_path(path), Ok(zone));
        }
    }

    for case in data["invalidPaths"].as_array().unwrap() {
        let path = case.as_str().unwrap();
        assert!(validate_note_path(path).is_err(), "expected invalid path to be rejected: {path:?}");
    }

    assert!(validate_prefix("").is_ok());
    assert!(validate_prefix("structure/").is_ok());
    assert!(validate_prefix("asset/frames/").is_ok());
    assert!(validate_prefix("../structure/").is_err());
    assert!(validate_prefix("/structure/").is_err());
    assert!(validate_prefix("other/").is_err());
}

#[test]
fn all_four_note_types_have_canonical_specs_manifests_and_starters() {
    let data = golden_val("directory");
    let expected = data["typeEntries"].as_array().unwrap();
    assert_eq!(NoteType::ALL.len(), 4);
    assert_eq!(all_type_specs().len(), 4);
    assert_eq!(expected.len(), 4);

    for (note_type, case) in NoteType::ALL.into_iter().zip(expected.iter()) {
        let slug = case["type"].as_str().unwrap();
        assert_eq!(note_type.as_str(), slug);
        assert_eq!(NoteType::parse(slug), Some(note_type));

        let spec = type_spec(note_type);
        assert_eq!(spec.slug, slug);
        assert_eq!(spec.entry_path, case["entry"].as_str().unwrap());
        assert_eq!(validate_note_path(spec.entry_path), Ok(NotePathZone::Structure));

        let dir = starter_directory("note_01", note_type, "Demo Title");
        assert_eq!(dir.manifest.id, "note_01");
        assert_eq!(dir.manifest.note_type, note_type);
        assert_eq!(dir.manifest.entry, spec.entry_path);
        assert!(dir.dirs.iter().any(|d| d == "structure"));
        assert!(dir.dirs.iter().any(|d| d == "asset"));
        assert_eq!(dir.files[0].path, MANIFEST_FILE);
        assert!(
            dir.files.iter().any(|f| f.path == spec.entry_path),
            "starter for {slug} must include entry {}",
            spec.entry_path
        );

        let parsed = parse_manifest(&dir.files[0].content).unwrap_or_else(|e| panic!("manifest for {slug}: {e}"));
        assert_eq!(parsed, dir.manifest);

        for file in &dir.files {
            assert!(validate_note_path(&file.path).is_ok(), "invalid starter path {} for {slug}", file.path);
            if file.mime == "application/json" {
                let _: Value = serde_json::from_str(&file.content).unwrap_or_else(|e| panic!("invalid JSON starter {} for {slug}: {e}", file.path));
            }
        }
    }
}

#[test]
fn manifest_validation_rejects_escape_paths_and_blank_titles() {
    assert!(title_problem("").is_some());
    assert!(title_problem("   ").is_some());
    assert!(title_problem("Valid Title").is_none());

    let mut bad = default_manifest("n1", NoteType::Doc, "Spec");
    bad.entry = "../escape.md".to_owned();
    assert!(serialize_manifest(&bad).is_err());

    let mut bad_asset_entry = default_manifest("n1", NoteType::Doc, "Spec");
    bad_asset_entry.entry = "asset/pic.png".to_owned();
    assert!(serialize_manifest(&bad_asset_entry).is_err());

    let mut bad_file = default_manifest("n1", NoteType::Doc, "Spec");
    bad_file.files.push("manifest.json".to_owned());
    assert!(serialize_manifest(&bad_file).is_err());
}

#[test]
fn merge_patch_canonical_json_and_directory_summary_work() {
    let data = golden_val("directory");
    for case in data["mergePatches"].as_array().unwrap() {
        let current = case["current"].as_str();
        let patch = case["patch"].as_str().unwrap();
        let merged = apply_json_merge_patch(current, patch).expect("merge patch");
        let parsed: Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(parsed, case["expected"]);
    }

    assert_eq!(canonical_json("{ \"a\": 1, \"b\": [2, 3] }").unwrap(), "{\"a\":1,\"b\":[2,3]}");

    let summary = format_directory_summary(
        "Launch Plan",
        NoteType::Doc,
        4,
        &[NoteFileMeta {
            path: "structure/doc.json".to_owned(),
            mime: "application/json".to_owned(),
            size: 128,
            hash: "abc".to_owned(),
            updated_at: 1000,
        }],
    );
    assert!(summary.contains("# Launch Plan"));
    assert!(summary.contains("type: doc · seq: 4 · files: 1"));
    assert!(summary.contains("`structure/doc.json`"));
}
