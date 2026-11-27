// Embeds dictionaries used by Rust services and native scenes.
use std::fmt::Write;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=CARGO_FEATURE_WEB");
    let include_all_web = std::env::var_os("CARGO_FEATURE_WEB").is_some();
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("locales");
    let mut out = String::from("pub(crate) static CATALOGS: &[(&str, &str, &str)] = &[\n");
    let mut entries = vec![];
    for lang in std::fs::read_dir(&dir).unwrap().flatten().filter(|e| e.path().is_dir()) {
        println!("cargo:rerun-if-changed={}", lang.path().display());
        for file in std::fs::read_dir(lang.path()).unwrap().flatten() {
            let path = file.path();
            let stem = path.file_stem().unwrap().to_string_lossy();
            if path.extension().is_some_and(|e| e == "json")
                && (stem == "shared"
                    || stem == "desktop"
                    || stem == "server"
                    || stem.starts_with("server.")
                    || (include_all_web && stem.starts_with("web."))
                    || stem == "web.base"
                    || stem == "web.note"
                    || stem == "web.farm"
                    || stem.starts_with("web.farm."))
            {
                println!("cargo:rerun-if-changed={}", path.display());
                entries.push((
                    lang.file_name().to_string_lossy().into_owned(),
                    path.file_stem().unwrap().to_string_lossy().into_owned(),
                    path.display().to_string(),
                ));
            }
        }
    }
    entries.sort();
    for (lang, ns, path) in entries {
        writeln!(out, "    ({lang:?}, {ns:?}, include_str!({path:?})),").unwrap();
    }
    out.push_str("];\n");
    let target = std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("catalogs.rs");
    if std::fs::read_to_string(&target).ok().as_deref() != Some(out.as_str()) {
        std::fs::write(target, out).unwrap();
    }
}
