use std::collections::HashMap;

use serde_json::Value;

use super::*;

fn golden() -> Value {
    serde_json::from_str(include_str!("golden/golden.json")).unwrap()
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect()
}

#[test]
fn cuts_and_terms_match_vibevalley() {
    for case in golden()["cuts"].as_array().unwrap() {
        let text = case["text"].as_str().unwrap();
        assert_eq!(cut_search(text), strings(&case["search"]), "cutSearch {text:?}");
        assert_eq!(cut_all(text), strings(&case["all"]), "cutAll {text:?}");
        assert_eq!(terms_list(text), strings(&case["terms"]), "termsList {text:?}");
    }
}

#[test]
fn recall_matches_vibevalley() {
    let g = golden();
    let memories: Vec<Memory> = serde_json::from_value(g["memories"].clone()).unwrap();
    let cue = &g["cue"];
    let cue = Cue {
        session: cue["session"].as_str(),
        repo: cue["repo"].as_str().unwrap(),
        text: cue["text"].as_str().unwrap(),
        skip: strings(&cue["skip"]).into_iter().collect(),
        now: cue["now"].as_i64().unwrap(),
        matches: serde_json::from_value::<HashMap<String, f64>>(cue["matches"].clone()).unwrap(),
    };
    let picked: Vec<String> = pick(&memories, &cue).into_iter().map(|m| m.id).collect();
    assert_eq!(picked, strings(&g["picked"]));
    let lines: Vec<String> = memories.iter().map(|m| line_of(m, "web")).collect();
    assert_eq!(lines, strings(&g["lines"]));
    let text = g["cuts"][0]["text"].as_str().unwrap();
    let l = likeness(&terms_of(text), &terms_of("修好登录页的时钟，时区按用户设置"));
    assert!((l - g["likeness"].as_f64().unwrap()).abs() < 1e-12, "{l}");
    let is_new: Vec<bool> = ["用户喜欢简短回答", "用户喜欢简短的回答", "完全不同的一句话"]
        .iter()
        .map(|t| is_new_note(&memories, t, None))
        .collect();
    let expected: Vec<bool> = g["isNew"].as_array().unwrap().iter().map(|b| b.as_bool().unwrap()).collect();
    assert_eq!(is_new, expected);
    assert_eq!(
        issue_memory_text(&"修好登录页的时钟显示".repeat(12), "改成按用户时区", true),
        g["issueText"].as_str().unwrap()
    );
}

#[test]
fn redaction_matches_vibevalley() {
    let g = golden();
    for (input, expected) in strings(&g["secrets"]).iter().zip(strings(&g["redacted"])) {
        assert_eq!(redact(input), expected, "{input}");
    }
}

#[test]
fn eviction_and_search() {
    let mk = |i: i64| Memory {
        id: format!("m{i}"),
        agent: "a".into(),
        kind: MemoryKind::Note,
        text: format!("第{i}条 数据库 迁移"),
        author: ActorKind::Agent,
        repo: None,
        session: None,
        at: i,
        recalled: 0,
        recalled_at: if i == 0 { Some(1_000) } else { None },
        fading: false,
        source: None,
        scope: None,
        title: None,
        importance: None,
        replaced_by: None,
    };
    let all: Vec<Memory> = (0..MEMORY_KEEP as i64).map(mk).collect();
    assert!(next_forgotten(&all[..10], 1).is_empty());
    // m0 was recalled recently, so m1 and m2 go first.
    assert_eq!(next_forgotten(&all, 2), vec!["m1".to_string(), "m2".to_string()]);
    let found = search(&all[..5], "", "数据库迁移", None, 3, &HashMap::new());
    assert_eq!(found.len(), 3);
    assert!(search(&all[..5], "", "没有这个词", None, 0, &HashMap::new()).is_empty());
    assert_eq!(search(&all[..5], "", "", None, 0, &HashMap::new()).len(), 5);
}

#[test]
fn sources_take_turns_and_drop_near_duplicates() {
    let line = |id: &str, text: &str| RecalledLine {
        id: id.into(),
        line: text.into(),
        score: 1.0,
    };
    let local = vec![line("1", "- 登录页的时钟用用户时区"), line("2", "- 迁移放在 db/migrations")];
    let other = vec![line("n:a", "- 登录页的时钟用用户时区"), line("n:b", "- 用户喜欢简短回答")];
    let merged = merge_recalled(&[local.clone(), other]);
    let ids: Vec<&str> = merged.iter().map(|l| l.id.as_str()).collect();
    assert_eq!(ids, vec!["1", "2", "n:b"]);
    assert_eq!(merge_recalled(&[local.clone(), vec![]]), local);

    assert_eq!(source_id(LOCAL, "7"), "7");
    assert_eq!(source_id("nowledge", "7"), "nowledge:7");
    assert_eq!(split_source_id(&["local", "nowledge"], "nowledge:7"), ("nowledge", "7"));
    assert_eq!(split_source_id(&["local", "nowledge"], "other:7"), ("local", "other:7"));
    let skip: HashSet<String> = ["1".to_string(), "nowledge:7".into(), "everos:9".into()].into();
    assert_eq!(skip_for(LOCAL, &skip), ["1".to_string()].into());
    assert_eq!(skip_for("nowledge", &skip), ["7".to_string()].into());
}

#[test]
fn profile_and_episode_recall_search_eviction_and_superseding_rules() {
    let mk = |id: &str, kind: MemoryKind, title: Option<&str>, text: &str, importance: Option<i64>, replaced_by: Option<&str>| Memory {
        id: id.into(),
        agent: "backend".into(),
        kind,
        text: text.into(),
        author: ActorKind::System,
        repo: Some("farm".into()),
        session: None,
        at: 100,
        recalled: 0,
        recalled_at: None,
        fading: false,
        source: None,
        scope: Some(if kind == MemoryKind::Profile { "farm" } else { "repo" }.into()),
        title: title.map(str::to_string),
        importance,
        replaced_by: replaced_by.map(str::to_string),
    };

    let profile = mk("p1", MemoryKind::Profile, Some("代码规范"), "禁止跳过静态检查", Some(90), None);
    let episode = mk("e1", MemoryKind::Episode, Some("#51 记忆迁移"), "完成记忆表扩展并验证压缩摘要", None, None);
    let superseded_note = mk("n_old", MemoryKind::Note, None, "用 cargo test 跑测试", None, Some("n_new"));
    let active_note = mk("n_new", MemoryKind::Note, None, "用 RUSTC_WRAPPER=\"\" cargo test 跑测试", None, None);

    let all = vec![profile.clone(), episode.clone(), superseded_note, active_note.clone()];
    let cue = Cue {
        session: None,
        repo: "farm",
        text: "记忆迁移 静态检查 cargo test",
        skip: HashSet::new(),
        now: 200,
        matches: HashMap::new(),
    };
    let picked: Vec<String> = pick(&all, &cue).into_iter().map(|m| m.id).collect();
    assert_eq!(
        picked,
        vec!["n_new".to_string()],
        "episode, profile, and superseded rows must not be auto-picked"
    );

    // Search retrieves episode by gse terms across title + body and skips superseded rows.
    let found = search(&all, "farm", "记忆迁移", None, 10, &HashMap::new());
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].0.id, "e1");
    assert!(line_of(&episode, "farm").contains("经历"));
    assert!(line_of(&profile, "farm").contains("[全局] 代码规范：禁止跳过静态检查"));

    // Profile memories are never evicted by next_forgotten even when count exceeds MEMORY_KEEP.
    let mut overflow: Vec<Memory> = (0..MEMORY_KEEP as i64)
        .map(|i| mk(&format!("n{i}"), MemoryKind::Note, None, &format!("第{i}条记录"), None, None))
        .collect();
    overflow.insert(0, profile);
    let evicted = next_forgotten(&overflow, 1);
    assert_eq!(evicted.len(), 1);
    assert_ne!(evicted[0], "p1");

    assert!(is_similar("用户喜欢简短回答", "用户喜欢简短的回答"));
    assert!(!is_similar("用户喜欢简短回答", "使用 PostgreSQL 作为生产数据库"));
}
