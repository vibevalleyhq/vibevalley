use serde_json::json;

use super::*;

fn store() -> Store {
    Store::open_in_memory().unwrap()
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
fn removing_a_project_removes_everything_it_owns() {
    let s = store();
    let p = s.add_project(Path::new("/w/a")).unwrap();
    let keep = s.add_project(Path::new("/w/keep")).unwrap();
    for id in [p.id, keep.id] {
        s.set_layout(id, &json!({"id": id})).unwrap();
        s.set_terminals(id, &[terminal("t", id)]).unwrap();
    }

    s.remove_project(p.id).unwrap();

    assert_eq!(s.projects().unwrap(), vec![keep.clone()]);
    assert_eq!(s.layout(p.id).unwrap(), None);
    assert!(s.terminals(p.id).unwrap().is_empty());
    let conn = s.conn.lock().unwrap();
    for table in ["layouts", "terminals"] {
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
                    s.set_layout(p.id, &json!({"t": t, "i": i})).unwrap();
                    s.set_setting(&format!("k{t}-{i}"), &json!(i)).unwrap();
                    s.projects().unwrap();
                }
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    assert_eq!(s.setting("k7-49").unwrap(), Some(json!(49)));
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
