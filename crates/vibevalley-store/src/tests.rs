use serde_json::json;

use super::*;

fn store() -> Store {
    Store::open_in_memory().unwrap()
}

fn session(id: &str, project_id: ProjectId, created_ms: i64) -> AgentSessionRow {
    AgentSessionRow {
        id: id.into(),
        project_id,
        runtime_id: "claude".into(),
        session_id: None,
        title: format!("task {id}"),
        status: "running".into(),
        worktree_path: Some(PathBuf::from("/tmp/wt 一/x")),
        branch: Some("vibevalley/task".into()),
        record_path: None,
        created_ms,
        updated_ms: created_ms,
    }
}

fn terminal(id: &str, project_id: ProjectId) -> SavedTerminal {
    SavedTerminal {
        id: id.into(),
        project_id,
        cwd: PathBuf::from("/work/项目"),
        title: Some(format!("zsh {id}")),
        scrollback: "line 1\nline 2\n\u{1b}[31mred\u{1b}[0m".into(),
    }
}

#[test]
fn store_is_send_and_sync() {
    fn assert<T: Send + Sync>() {}
    assert::<Store>();
}

#[test]
fn default_path_is_under_application_support() {
    let path = Store::default_path();
    assert!(path.ends_with("Library/Application Support/VibeValley/state.db"));
}

#[test]
fn add_project_is_idempotent_and_ordered() {
    let s = store();
    let a = s.add_project(Path::new("/work/alpha")).unwrap();
    let b = s.add_project(Path::new("/work/beta 项目/")).unwrap();
    assert_eq!(a.name, "alpha");
    assert_eq!(b.name, "beta 项目");
    assert_eq!(b.path, PathBuf::from("/work/beta 项目"));
    assert_eq!((a.position, b.position), (0, 1));
    assert!(a.last_opened_ms > 0);

    let again = s.add_project(Path::new("/work/alpha/")).unwrap();
    assert_eq!(again, a);
    assert_eq!(s.projects().unwrap(), vec![a.clone(), b]);
    assert_eq!(s.project(a.id).unwrap(), a);
}

#[test]
fn rename_relocate_touch() {
    let s = store();
    let a = s.add_project(Path::new("/work/alpha")).unwrap();
    let b = s.add_project(Path::new("/work/beta")).unwrap();

    s.rename_project(a.id, "Alpha!").unwrap();
    s.relocate_project(a.id, Path::new("/moved/alpha")).unwrap();
    let got = s.project(a.id).unwrap();
    assert_eq!(got.name, "Alpha!");
    assert_eq!(got.path, PathBuf::from("/moved/alpha"));

    assert!(matches!(s.relocate_project(a.id, &b.path), Err(StoreError::Db(_))));

    s.conn.lock().unwrap().execute("UPDATE projects SET last_opened_ms = 1", []).unwrap();
    s.touch_project(a.id).unwrap();
    assert!(s.project(a.id).unwrap().last_opened_ms > 1);
    assert_eq!(s.project(b.id).unwrap().last_opened_ms, 1);
}

#[test]
fn missing_project_is_not_found() {
    let s = store();
    assert!(matches!(s.rename_project(99, "x"), Err(StoreError::NotFound)));
    assert!(matches!(s.relocate_project(99, Path::new("/x")), Err(StoreError::NotFound)));
    assert!(matches!(s.touch_project(99), Err(StoreError::NotFound)));
    assert!(matches!(s.remove_project(99), Err(StoreError::NotFound)));
    assert!(matches!(s.project(99), Err(StoreError::NotFound)));
    assert!(matches!(s.set_layout(99, &json!({})), Err(StoreError::NotFound)));
    assert!(matches!(s.set_terminals(99, &[]), Err(StoreError::NotFound)));
    assert!(matches!(s.upsert_agent_session(&session("a", 99, 1)), Err(StoreError::NotFound)));
    assert_eq!(s.layout(99).unwrap(), None);
    assert!(s.terminals(99).unwrap().is_empty());
}

#[test]
fn reorder_projects() {
    let s = store();
    let ids: Vec<ProjectId> = ["a", "b", "c", "d"]
        .iter()
        .map(|n| s.add_project(&Path::new("/w").join(n)).unwrap().id)
        .collect();
    let order = |s: &Store| s.projects().unwrap().iter().map(|p| p.id).collect::<Vec<_>>();

    s.reorder_projects(&[ids[3], ids[1], ids[0], ids[2]]).unwrap();
    assert_eq!(order(&s), vec![ids[3], ids[1], ids[0], ids[2]]);

    // Partial list, a duplicate and an unknown id.
    s.reorder_projects(&[ids[2], 12345, ids[2]]).unwrap();
    assert_eq!(order(&s), vec![ids[2], ids[3], ids[1], ids[0]]);
    let positions: Vec<i64> = s.projects().unwrap().iter().map(|p| p.position).collect();
    assert_eq!(positions, vec![0, 1, 2, 3]);

    // A project added after a reorder goes last.
    let e = s.add_project(Path::new("/w/e")).unwrap();
    assert_eq!(order(&s).last(), Some(&e.id));
}

#[test]
fn layout_round_trip() {
    let s = store();
    let p = s.add_project(Path::new("/w/a")).unwrap();
    assert_eq!(s.layout(p.id).unwrap(), None);
    let layout = json!({"split": "h", "ratio": 0.5, "children": [{"term": "t1"}, {"file": "读我.md"}]});
    s.set_layout(p.id, &layout).unwrap();
    assert_eq!(s.layout(p.id).unwrap(), Some(layout));
    s.set_layout(p.id, &json!(null)).unwrap();
    assert_eq!(s.layout(p.id).unwrap(), Some(json!(null)));
}

#[test]
fn terminals_are_replaced_and_keep_order() {
    let s = store();
    let p = s.add_project(Path::new("/w/a")).unwrap();
    let q = s.add_project(Path::new("/w/b")).unwrap();

    let first = vec![terminal("z", p.id), terminal("a", p.id), terminal("m", p.id)];
    s.set_terminals(p.id, &first).unwrap();
    s.set_terminals(q.id, &[terminal("z", q.id)]).unwrap();
    assert_eq!(s.terminals(p.id).unwrap(), first);

    // The argument wins over a stale project_id on the row.
    let second = vec![terminal("only", q.id)];
    s.set_terminals(p.id, &second).unwrap();
    let got = s.terminals(p.id).unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].project_id, p.id);
    assert_eq!(got[0].id, "only");
    assert_eq!(s.terminals(q.id).unwrap().len(), 1);

    s.set_terminals(p.id, &[]).unwrap();
    assert!(s.terminals(p.id).unwrap().is_empty());
}

#[test]
fn agent_sessions_upsert_list_delete() {
    let s = store();
    let p = s.add_project(Path::new("/w/a")).unwrap();
    let q = s.add_project(Path::new("/w/b")).unwrap();

    s.upsert_agent_session(&session("old", p.id, 100)).unwrap();
    s.upsert_agent_session(&session("new", p.id, 300)).unwrap();
    s.upsert_agent_session(&session("other", q.id, 200)).unwrap();

    let ids = |rows: Vec<AgentSessionRow>| rows.into_iter().map(|r| r.id).collect::<Vec<_>>();
    assert_eq!(ids(s.agent_sessions(None).unwrap()), ["new", "other", "old"]);
    assert_eq!(ids(s.agent_sessions(Some(p.id)).unwrap()), ["new", "old"]);
    assert_eq!(ids(s.agent_sessions(Some(q.id)).unwrap()), ["other"]);

    let mut updated = session("old", p.id, 100);
    updated.status = "done".into();
    updated.session_id = Some("sess-1".into());
    updated.record_path = Some(PathBuf::from("/records/old.jsonl"));
    updated.updated_ms = 999;
    s.upsert_agent_session(&updated).unwrap();
    assert_eq!(s.agent_session("old").unwrap(), Some(updated));
    assert_eq!(s.agent_sessions(None).unwrap().len(), 3);

    s.delete_agent_session("old").unwrap();
    s.delete_agent_session("never-existed").unwrap();
    assert_eq!(s.agent_session("old").unwrap(), None);
    assert_eq!(ids(s.agent_sessions(Some(p.id)).unwrap()), ["new"]);
}

#[test]
fn removing_a_project_removes_everything_it_owns() {
    let s = store();
    let p = s.add_project(Path::new("/w/a")).unwrap();
    let keep = s.add_project(Path::new("/w/keep")).unwrap();
    for id in [p.id, keep.id] {
        s.set_layout(id, &json!({"id": id})).unwrap();
        s.set_terminals(id, &[terminal("t", id)]).unwrap();
        s.upsert_agent_session(&session(&format!("s{id}"), id, 1)).unwrap();
    }

    s.remove_project(p.id).unwrap();

    assert_eq!(s.projects().unwrap(), vec![keep.clone()]);
    assert_eq!(s.layout(p.id).unwrap(), None);
    assert!(s.terminals(p.id).unwrap().is_empty());
    assert!(s.agent_sessions(Some(p.id)).unwrap().is_empty());
    let conn = s.conn.lock().unwrap();
    for table in ["layouts", "terminals", "agent_sessions"] {
        let n: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "{table}");
    }
    drop(conn);
    assert_eq!(s.layout(keep.id).unwrap(), Some(json!({"id": keep.id})));

    // Ids are never reused, so stale references cannot alias a new project.
    let again = s.add_project(Path::new("/w/a")).unwrap();
    assert!(again.id > keep.id);
}

#[test]
fn settings_round_trip() {
    let s = store();
    assert_eq!(s.setting("theme").unwrap(), None);
    s.set_setting("theme", &json!("dark")).unwrap();
    s.set_setting("font", &json!({"family": "Berkeley Mono", "size": 13.5})).unwrap();
    s.set_setting("theme", &json!("light")).unwrap();
    assert_eq!(s.setting("theme").unwrap(), Some(json!("light")));
    assert_eq!(s.setting("font").unwrap().unwrap()["size"], json!(13.5));
    s.set_setting("theme", &json!(null)).unwrap();
    assert_eq!(s.setting("theme").unwrap(), None);
}

#[test]
fn concurrent_use_from_many_threads() {
    let s = std::sync::Arc::new(store());
    let p = s.add_project(Path::new("/w/a")).unwrap();
    let handles: Vec<_> = (0..8)
        .map(|t| {
            let s = s.clone();
            std::thread::spawn(move || {
                for i in 0..50 {
                    s.upsert_agent_session(&session(&format!("{t}-{i}"), p.id, i)).unwrap();
                    s.set_setting(&format!("k{t}"), &json!(i)).unwrap();
                    s.projects().unwrap();
                }
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    assert_eq!(s.agent_sessions(None).unwrap().len(), 400);
}

#[test]
fn on_disk_reopen_keeps_data_and_migrations_are_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nested/dirs/state.db");

    let (project, layout) = {
        let s = Store::open(&path).unwrap();
        let p = s.add_project(Path::new("/w/持久")).unwrap();
        let layout = json!({"tabs": [1, 2, 3]});
        s.set_layout(p.id, &layout).unwrap();
        s.set_terminals(p.id, &[terminal("t1", p.id), terminal("t2", p.id)]).unwrap();
        s.upsert_agent_session(&session("s1", p.id, 5)).unwrap();
        s.set_setting("k", &json!([true, null])).unwrap();
        let mode: String = s.conn.lock().unwrap().query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(mode, "wal");
        (p, layout)
    };

    for _ in 0..2 {
        let s = Store::open(&path).unwrap();
        let conn = s.conn.lock().unwrap();
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, Store::schema_version());
        let fk: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();
        assert_eq!(fk, 1);
        drop(conn);
        assert_eq!(s.projects().unwrap(), vec![project.clone()]);
        assert_eq!(s.layout(project.id).unwrap(), Some(layout.clone()));
        assert_eq!(s.terminals(project.id).unwrap(), vec![terminal("t1", project.id), terminal("t2", project.id)]);
        assert_eq!(s.agent_sessions(None).unwrap(), vec![session("s1", project.id, 5)]);
        assert_eq!(s.setting("k").unwrap(), Some(json!([true, null])));
    }
}

#[test]
fn refuses_a_database_from_a_newer_build() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    drop(Store::open(&path).unwrap());
    let conn = Connection::open(&path).unwrap();
    conn.pragma_update(None, "user_version", Store::schema_version() + 1).unwrap();
    drop(conn);
    assert!(matches!(Store::open(&path), Err(StoreError::Db(_))));
}

#[test]
fn docs_round_trip_by_kind_and_replace_in_place() {
    let store = Store::open_in_memory().unwrap();
    store.put_doc("issue", "a", &serde_json::json!({"n": 1})).unwrap();
    store.put_doc("issue", "b", &serde_json::json!({"n": 2})).unwrap();
    store.put_doc("session", "a", &serde_json::json!({"s": true})).unwrap();
    store.put_doc("issue", "a", &serde_json::json!({"n": 3})).unwrap();
    assert_eq!(store.doc("issue", "a").unwrap(), Some(serde_json::json!({"n": 3})));
    let issues = store.docs("issue").unwrap();
    assert_eq!(issues.len(), 2);
    assert!(issues.iter().any(|(id, v)| id == "b" && v["n"] == 2));
    store.delete_doc("issue", "a").unwrap();
    assert_eq!(store.doc("issue", "a").unwrap(), None);
    assert_eq!(store.docs("session").unwrap().len(), 1);
}
