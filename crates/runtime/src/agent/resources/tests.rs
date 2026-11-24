use serde_json::json;

use super::prompts::{PromptSection, assemble_system_prompt, discover_context_files};
use super::skills::{LoadSkill, front_matter, read_skill, scan_skills, skill_body, skill_index};
use crate::agent::tools::{Tool, TypedTool, TypedToolAdapter};

#[tokio::test]
async fn skills_scan_index_and_load_skill_typed_tool() {
    let fm = front_matter("---\nname: deploy\ndescription: >\n  Ships the app\n  to prod\nquoted: \"x y\"\n---\nbody");
    assert_eq!(fm["name"], "deploy");
    assert_eq!(fm["description"], "Ships the app to prod");
    assert_eq!(fm["quoted"], "x y");
    assert_eq!(skill_body("---\nname: a\n---\n\nThe body.\n"), "The body.");

    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    for (dir, folder, text) in [
        (a.path(), "deploy", "---\nname: deploy\ndescription: from a\n---\nA"),
        (b.path(), "deploy2", "---\nname: deploy\ndescription: from b\n---\nB"),
        (b.path(), "Lint", "---\ndescription: checks\n---\nL"),
    ] {
        std::fs::create_dir_all(dir.join(folder)).unwrap();
        std::fs::write(dir.join(folder).join("SKILL.md"), text).unwrap();
    }
    let skills = scan_skills(&[a.path().into(), b.path().into(), "/no/such".into()]);
    let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, vec!["deploy", "Lint"]);
    assert_eq!(skills[0].description, "from a");
    assert_eq!(skill_index(&skills, 160), "- deploy：from a\n- Lint：checks");
    assert!(read_skill(&skills, "deploy").unwrap().ends_with("\n\nA"));
    assert!(read_skill(&skills, "nope").unwrap_err().contains("有：deploy、Lint"));

    let dir_a = a.path().to_path_buf();
    let dir_b = b.path().to_path_buf();
    let loader = LoadSkill {
        skills: Box::new(move || scan_skills(&[dir_a.clone(), dir_b.clone()])),
    };
    assert_eq!(<LoadSkill as TypedTool>::replay(&loader), crate::agent::tools::ReplayPolicy::Safe);
    let tool = TypedToolAdapter(loader);
    assert!(tool.replay_safe());
    assert_eq!(tool.spec().name, "load_skill");
    assert_eq!(tool.spec().parameters["required"], json!(["name"]));

    let ok = tool.execute(&json!({"name": "deploy"})).await;
    assert!(!ok.is_error);
    assert!(ok.text.ends_with("\n\nA"));

    let bad = tool.execute(&json!({})).await;
    assert!(bad.is_error);
    assert!(bad.text.contains("invalid arguments for `load_skill`"));
}

#[test]
fn discover_context_files_walks_up_to_git_root_and_prefers_agents_md() {
    let outer = tempfile::tempdir().unwrap();
    std::fs::write(outer.path().join("AGENTS.md"), "outside repo").unwrap();

    let repo = outer.path().join("repo");
    let nested = repo.join("crates/app/src");
    std::fs::create_dir_all(repo.join(".git")).unwrap();
    std::fs::create_dir_all(&nested).unwrap();

    std::fs::write(repo.join("AGENTS.md"), "repo agents").unwrap();
    std::fs::write(repo.join("CLAUDE.md"), "@AGENTS.md").unwrap();
    std::fs::write(repo.join("crates/app/CLAUDE.md"), "app claude").unwrap();
    std::fs::write(nested.join("AGENTS.md"), "   \n  ").unwrap();

    let found = discover_context_files(&nested);
    let paths: Vec<_> = found.iter().map(|(p, _)| p.clone()).collect();
    let contents: Vec<_> = found.iter().map(|(_, c)| c.as_str()).collect();
    assert_eq!(paths, vec![repo.join("AGENTS.md"), repo.join("crates/app/CLAUDE.md")]);
    assert_eq!(contents, vec!["repo agents", "app claude"]);
}

#[test]
fn assemble_system_prompt_joins_non_empty_sections() {
    let prompt = assemble_system_prompt(
        "  You are helpful.  ",
        &[
            PromptSection::new("Context", "Follow AGENTS.md."),
            PromptSection::new("empty", "   \n "),
            PromptSection::new("skills", "## 技能\n- lint：checks"),
        ],
    );
    assert_eq!(prompt, "You are helpful.\n\n## Context\nFollow AGENTS.md.\n\n## 技能\n- lint：checks");
    assert_eq!(assemble_system_prompt("", &[PromptSection::new("", "Only body")]), "Only body");
}
