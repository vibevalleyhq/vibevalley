//! SEP-2640 skill catalog loading for MCP: combines embedded note guides,
//! built-in agent skills, and on-demand user skills from `$VIBEVALLEY_HOME/skills`.

use std::borrow::Cow;
use std::path::Path;
use std::sync::LazyLock;

use include_dir::{Dir, include_dir};
use vibevalley_mcp::SkillCatalog;

static NOTE_SKILL_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/assets/note/types");
static AGENT_SKILL_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/assets/agent/skills");

pub(super) static NOTE_SKILLS: LazyLock<SkillCatalog> = LazyLock::new(|| {
    let mut entries = Vec::new();
    collect_embedded_skill_files(&NOTE_SKILL_DIR, &mut entries);
    SkillCatalog::from_embedded_entries("note", &entries)
});

static BUILTIN_SKILLS: LazyLock<SkillCatalog> = LazyLock::new(|| {
    let mut catalog = NOTE_SKILLS.clone();
    let mut entries = Vec::new();
    collect_embedded_skill_files(&AGENT_SKILL_DIR, &mut entries);
    catalog.merge(SkillCatalog::from_embedded_entries("built-in", &entries));
    catalog
});

fn collect_embedded_skill_files<'a>(dir: &'a Dir<'a>, out: &mut Vec<(&'a str, &'a str)>) {
    for file in dir.files() {
        if let (Some(path), Some(body)) = (file.path().to_str(), file.contents_utf8()) {
            out.push((path, body));
        }
    }
    for sub in dir.dirs() {
        collect_embedded_skill_files(sub, out);
    }
}

/// Resolves the SEP-2640 skill catalog for `home`, merging `$VIBEVALLEY_HOME/skills`
/// on demand without blocking the Tokio runtime thread.
pub(super) async fn catalog_for_home(home: Option<&Path>) -> Cow<'static, SkillCatalog> {
    let Some(home) = home else {
        return Cow::Borrowed(&NOTE_SKILLS);
    };
    let mut catalog = BUILTIN_SKILLS.clone();
    let user_dir = home.join("skills");
    if tokio::fs::try_exists(&user_dir).await.unwrap_or(false)
        && let Ok(Ok(local)) = crate::log::spawn_blocking_traced(move || SkillCatalog::from_directory("local", &user_dir)).await
    {
        catalog.merge(local);
    }
    Cow::Owned(catalog)
}
