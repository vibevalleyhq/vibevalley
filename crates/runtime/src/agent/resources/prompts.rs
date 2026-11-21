use std::path::{Path, PathBuf};

pub use crate::agent::core::pipeline::PromptSection;

/// Discovers `AGENTS.md` or `CLAUDE.md` files from repo root down to `cwd`.
pub fn discover_context_files(cwd: &Path) -> Vec<(PathBuf, String)> {
    let mut discovered = Vec::new();
    let mut cursor = Some(cwd);

    while let Some(dir) = cursor {
        for filename in ["AGENTS.md", "CLAUDE.md"] {
            let candidate = dir.join(filename);
            if candidate.is_file()
                && let Ok(content) = std::fs::read_to_string(&candidate)
                && !content.trim().is_empty()
            {
                discovered.push((candidate, content));
                break;
            }
        }
        // Stop at the git repository root so parent machine folders do not leak into repo runs.
        if dir.join(".git").exists() {
            break;
        }
        cursor = dir.parent();
    }

    discovered.reverse();
    discovered
}

pub fn assemble_system_prompt(base: &str, sections: &[PromptSection]) -> String {
    let mut parts = Vec::new();
    let base = base.trim();
    if !base.is_empty() {
        parts.push(base.to_string());
    }
    for section in sections {
        let body = section.content.trim();
        if body.is_empty() {
            continue;
        }
        let key = section.key.trim();
        if key.is_empty() || body.starts_with('#') {
            parts.push(body.to_string());
        } else {
            parts.push(format!("## {key}\n{body}"));
        }
    }
    parts.join("\n\n")
}
