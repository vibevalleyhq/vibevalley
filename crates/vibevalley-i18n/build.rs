// Embeds the server, command line and shared dictionaries of locales/<lang>/.
use std::fmt::Write;

fn main() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("locales");
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut out = String::from("pub(crate) static CATALOGS: &[(&str, &str, &str)] = &[\n");
    let mut entries = vec![];
    for lang in std::fs::read_dir(&dir).unwrap().flatten().filter(|e| e.path().is_dir()) {
        for file in std::fs::read_dir(lang.path()).unwrap().flatten() {
            let path = file.path();
            let stem = path.file_stem().unwrap().to_string_lossy();
            if path.extension().is_some_and(|e| e == "json") && (stem == "shared" || stem == "cli" || stem == "server" || stem.starts_with("server.")) {
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
    std::fs::write(std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("catalogs.rs"), out).unwrap();
}
