use sea_orm::{DbBackend, PaginatorTrait, Statement};
use serde_json::json;

use super::*;

async fn store() -> Store {
    Store::open_in_memory().await.unwrap()
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
    assert!(Store::default_path_for("VibeValley-beta").ends_with("Library/Application Support/VibeValley-beta/state.db"));
    assert!(Store::default_path_for("VibeValley-alpha").ends_with("Library/Application Support/VibeValley-alpha/state.db"));
    assert!(Store::default_path_for("VibeValley-dev").ends_with("Library/Application Support/VibeValley-dev/state.db"));
}

#[tokio::test]
async fn add_project_is_idempotent_and_ordered() {
    let s = store().await;
    let a = s.add_project(Path::new("/work/alpha")).await.unwrap();
    let b = s.add_project(Path::new("/work/beta 项目/")).await.unwrap();
    assert_eq!(a.name, "alpha");
    assert_eq!(b.name, "beta 项目");
    assert_eq!(b.path, PathBuf::from("/work/beta 项目"));
    assert_eq!((a.position, b.position), (0, 1));
    assert!(a.last_opened_ms > 0);

    let again = s.add_project(Path::new("/work/alpha/")).await.unwrap();
    assert_eq!(again, a);
    assert_eq!(s.projects().await.unwrap(), vec![a.clone(), b]);
    assert_eq!(s.project(a.id).await.unwrap(), a);
}

#[tokio::test]
async fn rename_relocate_touch() {
    let s = store().await;
    let a = s.add_project(Path::new("/work/alpha")).await.unwrap();
    let b = s.add_project(Path::new("/work/beta")).await.unwrap();

    s.rename_project(a.id, "Alpha!").await.unwrap();
    s.relocate_project(a.id, Path::new("/moved/alpha")).await.unwrap();
    let got = s.project(a.id).await.unwrap();
    assert_eq!(got.name, "Alpha!");
    assert_eq!(got.path, PathBuf::from("/moved/alpha"));

    assert!(matches!(s.relocate_project(a.id, &b.path).await, Err(StoreError::Db(_))));

    s.run(async |conn| {
        projects::Entity::update_many()
            .col_expr(projects::Column::LastOpenedMs, Expr::value(1i64))
            .exec(conn)
            .await?;
        Ok(())
    })
    .await
    .unwrap();
    s.touch_project(a.id).await.unwrap();
    assert!(s.project(a.id).await.unwrap().last_opened_ms > 1);
    assert_eq!(s.project(b.id).await.unwrap().last_opened_ms, 1);
}

#[tokio::test]
async fn missing_project_is_not_found() {
    let s = store().await;
    assert!(matches!(s.rename_project(99, "x").await, Err(StoreError::NotFound)));
    assert!(matches!(s.relocate_project(99, Path::new("/x")).await, Err(StoreError::NotFound)));
    assert!(matches!(s.touch_project(99).await, Err(StoreError::NotFound)));
    assert!(matches!(s.remove_project(99).await, Err(StoreError::NotFound)));
    assert!(matches!(s.project(99).await, Err(StoreError::NotFound)));
    assert!(matches!(s.set_layout(99, &json!({})).await, Err(StoreError::NotFound)));
    assert!(matches!(s.set_terminals(99, &[]).await, Err(StoreError::NotFound)));
    assert_eq!(s.layout(99).await.unwrap(), None);
    assert!(s.terminals(99).await.unwrap().is_empty());
}

#[tokio::test]
async fn reorder_projects() {
    let s = store().await;
    let mut ids: Vec<ProjectId> = Vec::new();
    for n in ["a", "b", "c", "d"] {
        ids.push(s.add_project(&Path::new("/w").join(n)).await.unwrap().id);
    }

    s.reorder_projects(&[ids[3], ids[1], ids[0], ids[2]]).await.unwrap();
    let order: Vec<_> = s.projects().await.unwrap().iter().map(|p| p.id).collect();
    assert_eq!(order, vec![ids[3], ids[1], ids[0], ids[2]]);

    // Partial list, a duplicate and an unknown id.
    s.reorder_projects(&[ids[2], 12345, ids[2]]).await.unwrap();
    let projects = s.projects().await.unwrap();
    let order: Vec<_> = projects.iter().map(|p| p.id).collect();
    assert_eq!(order, vec![ids[2], ids[3], ids[1], ids[0]]);
    let positions: Vec<i64> = projects.iter().map(|p| p.position).collect();
    assert_eq!(positions, vec![0, 1, 2, 3]);

    // A project added after a reorder goes last.
    let e = s.add_project(Path::new("/w/e")).await.unwrap();
    let order: Vec<_> = s.projects().await.unwrap().iter().map(|p| p.id).collect();
    assert_eq!(order.last(), Some(&e.id));
}

#[tokio::test]
async fn layout_round_trip() {
    let s = store().await;
    let p = s.add_project(Path::new("/w/a")).await.unwrap();
    assert_eq!(s.layout(p.id).await.unwrap(), None);
    let layout = json!({"split": "h", "ratio": 0.5, "children": [{"term": "t1"}, {"file": "读我.md"}]});
    s.set_layout(p.id, &layout).await.unwrap();
    assert_eq!(s.layout(p.id).await.unwrap(), Some(layout));
    s.set_layout(p.id, &json!(null)).await.unwrap();
    assert_eq!(s.layout(p.id).await.unwrap(), Some(json!(null)));
}

#[tokio::test]
async fn terminals_are_replaced_and_keep_order() {
    let s = store().await;
    let p = s.add_project(Path::new("/w/a")).await.unwrap();
    let q = s.add_project(Path::new("/w/b")).await.unwrap();

    let first = vec![terminal("z", p.id), terminal("a", p.id), terminal("m", p.id)];
    s.set_terminals(p.id, &first).await.unwrap();
    s.set_terminals(q.id, &[terminal("z", q.id)]).await.unwrap();
    assert_eq!(s.terminals(p.id).await.unwrap(), first);

    // The argument wins over a stale project_id on the row.
    let second = vec![terminal("only", q.id)];
    s.set_terminals(p.id, &second).await.unwrap();
    let got = s.terminals(p.id).await.unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].project_id, p.id);
    assert_eq!(got[0].id, "only");
    assert_eq!(s.terminals(q.id).await.unwrap().len(), 1);

    s.set_terminals(p.id, &[]).await.unwrap();
    assert!(s.terminals(p.id).await.unwrap().is_empty());
}

#[tokio::test]
async fn removing_a_project_removes_everything_it_owns() {
    let s = store().await;
    let p = s.add_project(Path::new("/w/a")).await.unwrap();
    let keep = s.add_project(Path::new("/w/keep")).await.unwrap();
    for id in [p.id, keep.id] {
        s.set_layout(id, &json!({"id": id})).await.unwrap();
        s.set_terminals(id, &[terminal("t", id)]).await.unwrap();
    }

    s.remove_project(p.id).await.unwrap();

    assert_eq!(s.projects().await.unwrap(), vec![keep.clone()]);
    assert_eq!(s.layout(p.id).await.unwrap(), None);
    assert!(s.terminals(p.id).await.unwrap().is_empty());
    s.run(async |conn| {
        assert_eq!(layouts::Entity::find().count(conn).await?, 1);
        assert_eq!(terminals::Entity::find().count(conn).await?, 1);
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(s.layout(keep.id).await.unwrap(), Some(json!({"id": keep.id})));

    // Ids are never reused, so stale references cannot alias a new project.
    let again = s.add_project(Path::new("/w/a")).await.unwrap();
    assert!(again.id > keep.id);
}

#[tokio::test]
async fn settings_round_trip() {
    let s = store().await;
    assert_eq!(s.setting("theme").await.unwrap(), None);
    s.set_setting("theme", &json!("dark")).await.unwrap();
    s.set_setting("font", &json!({"family": "Berkeley Mono", "size": 13.5})).await.unwrap();
    s.set_setting("theme", &json!("light")).await.unwrap();
    assert_eq!(s.setting("theme").await.unwrap(), Some(json!("light")));
    assert_eq!(s.setting("font").await.unwrap().unwrap()["size"], json!(13.5));
    s.set_setting("theme", &json!(null)).await.unwrap();
    assert_eq!(s.setting("theme").await.unwrap(), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_use_from_many_tasks() {
    let s = std::sync::Arc::new(store().await);
    let p = s.add_project(Path::new("/w/a")).await.unwrap();
    let mut join_set = tokio::task::JoinSet::new();
    for t in 0..8 {
        let s = s.clone();
        join_set.spawn(async move {
            for i in 0..50 {
                s.set_layout(p.id, &json!({"t": t, "i": i})).await.unwrap();
                s.set_setting(&format!("k{t}-{i}"), &json!(i)).await.unwrap();
                s.projects().await.unwrap();
            }
        });
    }
    while let Some(res) = join_set.join_next().await {
        res.unwrap();
    }
    assert_eq!(s.setting("k7-49").await.unwrap(), Some(json!(49)));
}

#[tokio::test]
async fn on_disk_reopen_keeps_data_and_migrations_are_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nested/dirs/state.db");

    let (project, layout) = {
        let s = Store::open(&path).await.unwrap();
        let p = s.add_project(Path::new("/w/持久")).await.unwrap();
        let layout = json!({"tabs": [1, 2, 3]});
        s.set_layout(p.id, &layout).await.unwrap();
        s.set_terminals(p.id, &[terminal("t1", p.id), terminal("t2", p.id)]).await.unwrap();
        s.set_setting("k", &json!([true, null])).await.unwrap();
        let mode: String = s
            .run(async |conn| {
                let row = conn
                    .query_one_raw(Statement::from_string(DbBackend::Sqlite, "PRAGMA journal_mode"))
                    .await?
                    .unwrap();
                Ok(row.try_get_by_index(0)?)
            })
            .await
            .unwrap();
        assert_eq!(mode, "wal");
        s.close().await.unwrap();
        (p, layout)
    };

    for _ in 0..2 {
        let s = Store::open(&path).await.unwrap();
        s.run(async |conn| {
            for (sql, expected) in [
                ("PRAGMA user_version", Store::schema_version()),
                ("PRAGMA foreign_keys", 1),
                ("PRAGMA busy_timeout", 5000),
                ("PRAGMA synchronous", 1),
            ] {
                let row = conn.query_one_raw(Statement::from_string(DbBackend::Sqlite, sql)).await?.unwrap();
                let actual: i64 = row.try_get_by_index(0)?;
                assert_eq!(actual, expected, "{sql}");
            }
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(s.projects().await.unwrap(), vec![project.clone()]);
        assert_eq!(s.layout(project.id).await.unwrap(), Some(layout.clone()));
        assert_eq!(
            s.terminals(project.id).await.unwrap(),
            vec![terminal("t1", project.id), terminal("t2", project.id)]
        );
        assert_eq!(s.setting("k").await.unwrap(), Some(json!([true, null])));
        s.close().await.unwrap();
    }
}

#[tokio::test]
async fn opens_existing_legacy_user_version_1_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("legacy state#1?.db");
    let url = sqlite_file_url(&path);
    let conn = Database::connect(&url).await.unwrap();
    conn.execute_unprepared(
        r#"
        CREATE TABLE projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            position INTEGER NOT NULL,
            last_opened_ms INTEGER NOT NULL
        );
        CREATE TABLE layouts (
            project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
            json TEXT NOT NULL
        );
        CREATE TABLE terminals (
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            id TEXT NOT NULL,
            ord INTEGER NOT NULL,
            cwd TEXT NOT NULL,
            title TEXT,
            scrollback TEXT NOT NULL,
            PRIMARY KEY (project_id, id)
        );
        CREATE TABLE settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        INSERT INTO projects (id, path, name, position, last_opened_ms) VALUES (7, '/legacy/app', 'app', 0, 12345);
        INSERT INTO layouts (project_id, json) VALUES (7, '{"tabs":["main"]}');
        INSERT INTO terminals (project_id, id, ord, cwd, title, scrollback) VALUES (7, 't1', 0, '/legacy/app', NULL, 'hi');
        INSERT INTO settings (key, value) VALUES ('theme', '"warm"');
        PRAGMA user_version = 1;
        "#,
    )
    .await
    .unwrap();
    conn.close().await.unwrap();

    let s = Store::open(&path).await.unwrap();
    let projects = s.projects().await.unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].id, 7);
    assert_eq!(projects[0].path, PathBuf::from("/legacy/app"));
    assert_eq!(s.layout(7).await.unwrap(), Some(json!({"tabs": ["main"]})));
    assert_eq!(
        s.terminals(7).await.unwrap(),
        vec![SavedTerminal {
            id: "t1".into(),
            project_id: 7,
            cwd: PathBuf::from("/legacy/app"),
            title: None,
            scrollback: "hi".into(),
        }]
    );
    assert_eq!(s.setting("theme").await.unwrap(), Some(json!("warm")));
}

#[tokio::test]
async fn refuses_a_database_from_a_newer_build() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let store = Store::open(&path).await.unwrap();
    store
        .run(async |conn| {
            conn.execute_unprepared("PRAGMA user_version = 2147483647").await?;
            Ok(())
        })
        .await
        .unwrap();
    store.close().await.unwrap();
    assert!(matches!(Store::open(&path).await, Err(StoreError::Db(_))));
}

#[tokio::test]
async fn regression_failed_terminal_batch_preserves_previous_set_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let s = Store::open(&path).await.unwrap();
    let id = s.add_project(Path::new("/project")).await.unwrap().id;
    let original = terminal("saved", id);
    s.set_terminals(id, std::slice::from_ref(&original)).await.unwrap();
    let duplicate = terminal("duplicate", id);
    assert!(matches!(s.set_terminals(id, &[duplicate.clone(), duplicate]).await, Err(StoreError::Db(_))));
    s.close().await.unwrap();
    assert_eq!(Store::open(&path).await.unwrap().terminals(id).await.unwrap(), vec![original]);
}
