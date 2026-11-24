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
fn server_db_entities_are_private_to_their_owning_domain() {
    let src_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let entities_dir = src_dir.join("db/entities");
    let migration_dir = src_dir.join("db/migration");
    let mut violations = Vec::new();

    fn owner_allows(target: &str, rel: &str) -> Option<&'static str> {
        if target.starts_with("work_") {
            (!rel.starts_with("modules/work/")).then_some("modules/work/")
        } else if target.starts_with("collab_") {
            (!rel.starts_with("modules/collab/")).then_some("modules/collab/")
        } else if target.starts_with("content_") {
            (!rel.starts_with("modules/content/")).then_some("modules/content/")
        } else if target == "team_memory" {
            (!rel.starts_with("modules/team/memory/")).then_some("modules/team/memory/")
        } else if target == "infra_remote" {
            (!rel.starts_with("modules/infra/remote/")).then_some("modules/infra/remote/")
        } else if target == "shared" {
            (!(rel.starts_with("db/") || rel.starts_with("modules/work/"))).then_some("db/ or modules/work/")
        } else {
            Some("<classified owning domain>")
        }
    }

    for path in rs_files(&src_dir) {
        if path.starts_with(&entities_dir) || path.starts_with(&migration_dir) {
            continue;
        }
        let rel = path.strip_prefix(&src_dir).unwrap().to_string_lossy().replace('\\', "/");
        let text = std::fs::read_to_string(&path).unwrap();
        let prod = prod_lines(&text);
        let joined = prod.iter().map(|(_, l)| *l).collect::<Vec<_>>().join("\n");
        let bytes = joined.as_bytes();
        let mut cursor = 0;

        while let Some(rel_idx) = joined[cursor..].find("db::entities::") {
            let start = cursor + rel_idx + "db::entities::".len();
            let line_no = prod.get(joined[..start].matches('\n').count()).map_or(1, |(n, _)| *n);
            let rest = &joined[start..];
            if rest.starts_with('{')
                && let Some(close) = rest.find('}')
            {
                let inner = &rest[1..close];
                let mut depth = 0usize;
                for seg in inner.split(',') {
                    let trimmed = seg.trim();
                    if depth == 0 && !trimmed.is_empty() {
                        let target: String = trimmed.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
                        if target.is_empty() {
                            violations.push(format!("{rel}:{line_no} references `db::entities::{{...}}` without a domain module"));
                        } else if let Some(expected) = owner_allows(&target, &rel) {
                            violations.push(format!("{rel}:{line_no} accesses `db::entities::{target}` outside `{expected}`"));
                        }
                    }
                    depth = depth.saturating_add(seg.matches('{').count()).saturating_sub(seg.matches('}').count());
                }
                cursor = start + close + 1;
                continue;
            }
            let target: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
            if target.is_empty() {
                violations.push(format!("{rel}:{line_no} references `db::entities::` without a domain module"));
            } else if let Some(expected) = owner_allows(&target, &rel) {
                violations.push(format!("{rel}:{line_no} accesses `db::entities::{target}` outside `{expected}`"));
            }
            cursor = start.min(bytes.len());
        }

        // Catch `use entities::...` inside `src/db/`.
        if rel.starts_with("db/") {
            for (line_no, line) in &prod {
                if let Some(idx) = line.find("entities::") {
                    let prefix = &line[..idx];
                    if !prefix.ends_with("db::") {
                        let target: String = line[idx + "entities::".len()..]
                            .chars()
                            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                            .collect();
                        if !target.is_empty()
                            && let Some(expected) = owner_allows(&target, &rel)
                        {
                            violations.push(format!("{rel}:{line_no} accesses `entities::{target}` outside `{expected}`"));
                        }
                    }
                }
            }
        }
    }

    assert!(violations.is_empty(), "server db::entities privacy violations:\n{}", violations.join("\n"));
}

#[test]
fn server_spine_and_transport_never_import_domain_modules() {
    let src_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = vec![src_dir.join("lib.rs"), src_dir.join("ports.rs")];
    files.extend(rs_files(&src_dir.join("transport")));
    let mut violations = Vec::new();

    for path in files {
        let rel = path.strip_prefix(&src_dir).unwrap().to_string_lossy().replace('\\', "/");
        let text = std::fs::read_to_string(&path).unwrap();
        for (line_no, line) in prod_lines(&text) {
            if line.contains("crate::modules::") {
                violations.push(format!("{rel}:{line_no} references `crate::modules::` from L0 spine/transport"));
            }
        }
    }

    assert!(violations.is_empty(), "server spine boundary violations:\n{}", violations.join("\n"));
}
