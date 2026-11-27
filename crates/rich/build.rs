// Embeds UI-only `web.*` dictionaries directly into `vibevalley-rich` so editing
// frontend strings never invalidates `vibevalley-i18n`, `vibevalley-core`, or `vibevalley-server`.
use std::fmt::Write;

fn is_ui_only_web_catalog(stem: &str) -> bool {
    stem.starts_with("web.") && stem != "web.base" && stem != "web.note" && stem != "web.farm" && !stem.starts_with("web.farm.")
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let locales_dir = manifest_dir.join("../i18n/locales");
    let mut out = String::from("static WEB_CATALOGS: &[(&str, &str, &str)] = &[\n");
    let mut entries = vec![];
    for lang in std::fs::read_dir(&locales_dir).unwrap().flatten().filter(|e| e.path().is_dir()) {
        let lang_name = lang.file_name().to_string_lossy().into_owned();
        for file in std::fs::read_dir(lang.path()).unwrap().flatten() {
            let path = file.path();
            let Some(stem) = path.file_stem().map(|s| s.to_string_lossy().into_owned()) else {
                continue;
            };
            if path.extension().is_some_and(|e| e == "json") && is_ui_only_web_catalog(&stem) {
                println!("cargo:rerun-if-changed=../i18n/locales/{lang_name}/{stem}.json");
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
    let target = std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("web_catalogs.rs");
    if std::fs::read_to_string(&target).ok().as_deref() != Some(out.as_str()) {
        std::fs::write(target, out).unwrap();
    }
}
