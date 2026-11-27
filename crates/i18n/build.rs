// Embeds only Rust-consumed dictionaries as path-free literals so frontend-only
// `web.*` edits never invalidate workspace crates and cross-worktree sccache hits stay 100%.
use std::fmt::Write;

fn is_rust_catalog(stem: &str) -> bool {
    stem == "shared"
        || stem == "desktop"
        || stem == "server"
        || stem.starts_with("server.")
        || stem == "web.base"
        || stem == "web.note"
        || stem == "web.farm"
        || stem.starts_with("web.farm.")
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let dir = manifest_dir.join("locales");
    let mut out = String::from("pub(crate) static CATALOGS: &[(&str, &str, &str)] = &[\n");
    let mut entries = vec![];
    for lang in std::fs::read_dir(&dir).unwrap().flatten().filter(|e| e.path().is_dir()) {
        let lang_name = lang.file_name().to_string_lossy().into_owned();
        for file in std::fs::read_dir(lang.path()).unwrap().flatten() {
            let path = file.path();
            let Some(stem) = path.file_stem().map(|s| s.to_string_lossy().into_owned()) else {
                continue;
            };
            if path.extension().is_some_and(|e| e == "json") && is_rust_catalog(&stem) {
                let rel = path.strip_prefix(manifest_dir).unwrap_or(&path);
                println!("cargo:rerun-if-changed={}", rel.display());
                let content = std::fs::read_to_string(&path).unwrap();
                entries.push((lang_name.clone(), stem, content));
            }
        }
    }
    entries.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
    for (lang, ns, content) in entries {
        writeln!(out, "    ({lang:?}, {ns:?}, {content:?}),").unwrap();
    }
    out.push_str("];\n");
    let target = std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("catalogs.rs");
    if std::fs::read_to_string(&target).ok().as_deref() != Some(out.as_str()) {
        std::fs::write(target, out).unwrap();
    }
}
