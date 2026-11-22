//! Structural guard for server module layer boundaries.

use std::path::{Path, PathBuf};

fn rs_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(rs_files(&path));
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
    out.sort();
    out
}

fn prod_lines(text: &str) -> Vec<(usize, &str)> {
    let body = text.split("#[cfg(test)]").next().unwrap_or(text);
    body.lines()
        .enumerate()
        .map(|(i, l)| (i + 1, l))
        .filter(|(_, l)| !l.trim_start().starts_with("//"))
        .collect()
}

#[test]
fn server_modules_respect_layer_and_skin_boundaries() {
    let modules_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/modules");
    let mut violations = Vec::new();

    for path in rs_files(&modules_dir) {
        let rel = path.strip_prefix(&modules_dir).unwrap().to_string_lossy().replace('\\', "/");
        let text = std::fs::read_to_string(&path).unwrap();
        let top = rel.split('/').next().unwrap_or("");

        for (line_no, line) in prod_lines(&text) {
            if top != "skin" && (line.contains("crate::modules::skin::") || line.contains("modules::skin::")) {
                violations.push(format!(
                    "{rel}:{line_no} imports `skin` from a non-skin domain — pass a callback or subscribe to Hub transitions in start.rs"
                ));
            }
            if top == "infra" {
                for domain in ["work", "team", "collab", "content", "skin"] {
                    let pat = format!("crate::modules::{domain}::");
                    if line.contains(&pat) {
                        violations.push(format!(
                            "{rel}:{line_no} imports upward into `{domain}` from `infra` — keep `infra` free of business domain dependencies"
                        ));
                    }
                }
            }
            if rel.starts_with("collab/voice/") && line.contains("crate::modules::content::media::") {
                violations.push(format!(
                    "{rel}:{line_no} imports `content::media` from `collab/voice` — use shared primitives in `modules::infra::{{http, provider}}`"
                ));
            }
        }
    }

    assert!(violations.is_empty(), "server module boundary violations:\n{}", violations.join("\n"));
}

#[test]
fn server_db_generated_queries_are_private_to_their_owning_module() {
    let src_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let generated_dir = src_dir.join("db/generated");
    let mut violations = Vec::new();

    for path in rs_files(&src_dir) {
        if path.starts_with(&generated_dir) {
            continue;
        }
        let rel = path.strip_prefix(&src_dir).unwrap().to_string_lossy().replace('\\', "/");
        let text = std::fs::read_to_string(&path).unwrap();
        let owner = rel
            .strip_prefix("modules/")
            .and_then(|rest| {
                let mut parts = rest.split('/');
                Some((parts.next()?, parts.next()?))
            })
            .map(|(domain, module)| format!("{domain}_{module}"));

        for (line_no, line) in prod_lines(&text) {
            let mut rest = line;
            while let Some(idx) = rest.find("db::generated::") {
                rest = &rest[idx + "db::generated::".len()..];
                let target: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
                if target.is_empty() {
                    violations.push(format!("{rel}:{line_no} references `db::generated::` without a specific module"));
                } else if owner.as_deref() != Some(target.as_str()) {
                    violations.push(format!(
                        "{rel}:{line_no} accesses `db::generated::{target}` outside its owning module `modules/{}`",
                        target.replace('_', "/")
                    ));
                }
            }
        }
    }

    assert!(violations.is_empty(), "server db::generated privacy violations:\n{}", violations.join("\n"));
}
