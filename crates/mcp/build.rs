// Embeds the 4 canonical note type skill directories from `crates/server/assets/note/types/`
// for SEP-2640 Skills over MCP (`skill://note/<type>`).
use std::fmt::Write;
use std::path::Path;

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<(String, String)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        println!("cargo:rerun-if-changed={}", path.display());
        if path.is_dir() {
            collect_files(root, &path, out);
        } else if path.is_file()
            && let Ok(rel) = path.strip_prefix(root)
            && let Some(rel_str) = rel.to_str()
        {
            out.push((rel_str.replace('\\', "/"), path.display().to_string()));
        }
    }
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let types_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../server/assets/note/types");
    println!("cargo:rerun-if-changed={}", types_dir.display());
    let mut entries = Vec::new();
    collect_files(&types_dir, &types_dir, &mut entries);
    entries.sort();

    let mut out = String::from("pub(crate) static NOTE_SKILL_ENTRIES: &[(&str, &str)] = &[\n");
    for (rel, abs) in entries {
        writeln!(out, "    ({rel:?}, include_str!({abs:?})),").unwrap();
    }
    out.push_str("];\n");

    let target = Path::new(&std::env::var("OUT_DIR").unwrap()).join("note_skills.rs");
    if std::fs::read_to_string(&target).ok().as_deref() != Some(out.as_str()) {
        std::fs::write(target, out).unwrap();
    }
}
