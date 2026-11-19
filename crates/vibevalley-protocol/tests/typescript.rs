//! `packages/protocol/src/*/shapes.gen.ts` and `endpoints.gen.ts` are what `contract/` renders to.
//! With `VIBEVALLEY_WRITE_TS=1` (`vp run protocol:ts`) the test writes them instead.

use std::path::Path;

#[test]
fn typescript_matches_the_contract() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let files = vibevalley_protocol::typescript::files();
    let write = std::env::var_os("VIBEVALLEY_WRITE_TS").is_some();
    let src = root.join("packages/protocol/src");
    let mut stale = Vec::new();
    for entry in std::fs::read_dir(&src).unwrap() {
        let gen_file = entry.unwrap().path().join("shapes.gen.ts");
        let rel = format!(
            "packages/protocol/src/{}/shapes.gen.ts",
            gen_file.parent().unwrap().file_name().unwrap().to_string_lossy()
        );
        if gen_file.exists() && !files.iter().any(|(p, _)| *p == rel) {
            if write {
                std::fs::remove_file(&gen_file).unwrap();
            } else {
                stale.push(rel);
            }
        }
    }
    for (rel, text) in &files {
        let path = root.join(rel);
        if write {
            std::fs::write(&path, text).unwrap();
        } else if std::fs::read_to_string(&path).ok().as_deref() != Some(text.as_str()) {
            stale.push(rel.clone());
        }
    }
    assert!(
        stale.is_empty(),
        "these differ from crates/vibevalley-protocol/src/contract: {stale:?}\nFix: vp run protocol:ts\nSee crates/vibevalley-protocol/src/typescript.rs"
    );
}

/// A field holding an id is branded in TypeScript only when it says so (`#[ts(as = …)]`).
#[test]
fn every_id_field_is_branded_in_typescript() {
    const IDS: &[&str] = &["IssueId", "SessionId", "ArtifactId", "BlockId", "SuggestionId", "MessageId"];
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/contract");
    let mut bare = Vec::new();
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            let t = line.trim_start();
            let Some((_, ty)) = t.split_once(": ") else { continue };
            let is_field = !t.starts_with("//") && !t.starts_with("pub type") && !t.starts_with('"') && t.ends_with(',');
            let names_id = ty.split(|c: char| !c.is_alphanumeric()).any(|w| IDS.contains(&w));
            if is_field && names_id && !(i > 0 && lines[i - 1].contains("ts(as = \"")) {
                bare.push(format!("{}:{}: {t}", path.file_name().unwrap().to_string_lossy(), i + 1));
            }
        }
    }
    assert!(
        bare.is_empty(),
        "these fields hold an id but are a plain string in TypeScript:\n{}\nFix: put #[cfg_attr(feature = \"ts-gen\", ts(as = \"crate::typescript::<Id>\"))] (with the field's Option/Vec) above each.",
        bare.join("\n")
    );
}
