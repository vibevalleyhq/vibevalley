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
    let src_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let l1_dirs = [
        "setting.rs",
        "provider.rs",
        "repo.rs",
        "storage",
        "debug",
        "machine",
        "runtime",
        "channel",
        "agent/profile",
    ];
    let l2_dirs = ["issue", "artifact", "agent/memory", "connector", "voice"];
    let l3_targets = [
        "crate::cron::",
        "crate::game::",
        "crate::agent::orchestrator::",
        "crate::agent::tool::",
        "crate::agent::mcp::",
    ];
    let mut violations = Vec::new();

    for entry in l1_dirs.iter().chain(l2_dirs.iter()) {
        let full = src_dir.join(entry);
        let paths = if full.is_file() { vec![full] } else { rs_files(&full) };
        for path in paths {
            let rel = path.strip_prefix(&src_dir).unwrap().to_string_lossy().replace('\\', "/");
            let text = std::fs::read_to_string(&path).unwrap();
            let is_l1 = l1_dirs.contains(entry);
            for (line_no, line) in prod_lines(&text) {
                for target in l3_targets {
                    if line.contains(target) {
                        violations.push(format!("{rel}:{line_no} imports L3 `{target}` from `{entry}`"));
                    }
                }
                if is_l1 {
                    for l2 in [
                        "crate::issue::",
                        "crate::artifact::",
                        "crate::agent::memory::",
                        "crate::connector::",
                        "crate::voice::",
                    ] {
                        if line.contains(l2) {
                            violations.push(format!("{rel}:{line_no} imports L2 `{l2}` from L1 `{entry}`"));
                        }
                    }
                }
            }
        }
    }

    assert!(violations.is_empty(), "server module boundary violations:\n{}", violations.join("\n"));
}

#[test]
fn server_sea_orm_and_entity_models_stay_inside_db_and_service() {
    let src_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut violations = Vec::new();

    for path in rs_files(&src_dir) {
        let rel = path.strip_prefix(&src_dir).unwrap().to_string_lossy().replace('\\', "/");
        if rel.starts_with("db/") || rel.starts_with("service/") {
            continue;
        }
        let text = std::fs::read_to_string(&path).unwrap();
        for (line_no, line) in prod_lines(&text) {
            if line.contains("sea_orm::") || line.contains("sea_orm_migration::") || line.contains("db::entity") {
                violations.push(format!("{rel}:{line_no} references SeaORM or `db::entity` outside `db/` and `service/`"));
            }
        }
    }

    assert!(violations.is_empty(), "server SeaORM boundary violations:\n{}", violations.join("\n"));
}

#[test]
fn server_spine_and_gateway_never_import_domain_modules() {
    let src_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = vec![src_dir.join("lib.rs")];
    for spine_dir in ["log", "db", "service", "context", "gateway"] {
        files.extend(rs_files(&src_dir.join(spine_dir)));
    }
    let domain_targets = [
        "crate::setting::",
        "crate::provider::",
        "crate::repo::",
        "crate::storage::",
        "crate::debug::",
        "crate::machine::",
        "crate::runtime::",
        "crate::channel::",
        "crate::connector::",
        "crate::voice::",
        "crate::artifact::",
        "crate::issue::",
        "crate::agent::",
        "crate::cron::",
        "crate::game::",
    ];
    let mut violations = Vec::new();

    for path in files {
        let rel = path.strip_prefix(&src_dir).unwrap().to_string_lossy().replace('\\', "/");
        let text = std::fs::read_to_string(&path).unwrap();
        for (line_no, line) in prod_lines(&text) {
            for pat in domain_targets {
                if line.contains(pat) {
                    violations.push(format!("{rel}:{line_no} references `{pat}` from L0 spine/gateway"));
                }
            }
        }
    }

    assert!(violations.is_empty(), "server spine boundary violations:\n{}", violations.join("\n"));
}
