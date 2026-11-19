//! VibeValley `modules/pkm/pkm.test.ts`, case by case, plus the endpoints
//! and the watcher through `start()`.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use serde_json::json;
use vibevalley_protocol::{
    ApiError, BizCode, PkmBlockOp, PkmClipRequest, PkmClipRequestHighlights, PkmClusterRequest, PkmMarker, PkmMoveRequest, PkmPageRequest, PkmProposalRequest,
    PkmRenameRequest, PkmResolveRequest, PkmSearchRequest, PkmSourceUpdate, PkmTier,
};
use vibevalley_server::modules::pkm::Pkm;
use vibevalley_server_api::Server;

struct Farm {
    pkm: Arc<Pkm>,
    _dir: tempfile::TempDir,
}

fn farm() -> Farm {
    let dir = tempfile::tempdir().expect("temp dir");
    let pkm = Pkm::open(dir.path(), &dir.path().join("pkm")).expect("the vault");
    Farm { pkm, _dir: dir }
}

/// A file written as another editor would, its time moved on so it reads as changed.
fn edit(root: &Path, file: &str, text: &str) {
    let at = root.join(file);
    std::fs::create_dir_all(at.parent().unwrap()).unwrap();
    std::fs::write(&at, text).unwrap();
    let later = SystemTime::UNIX_EPOCH + Duration::from_millis(1_893_456_000_000);
    std::fs::File::options().write(true).open(&at).unwrap().set_modified(later).unwrap();
}

fn on_disk(root: &Path, file: &str) -> String {
    std::fs::read_to_string(root.join(file)).unwrap()
}

fn req(title: &str, tier: Option<PkmTier>, markdown: &str) -> PkmPageRequest {
    PkmPageRequest {
        title: title.into(),
        tier,
        props: None,
        markdown: Some(markdown.into()),
    }
}

fn refusal<T: std::fmt::Debug>(r: Result<T, ApiError>) -> ApiError {
    r.expect_err("it was not refused")
}

#[test]
fn makes_a_page_moves_it_and_reads_what_another_editor_wrote() {
    let f = farm();
    let pkm = &f.pkm;
    let made = pkm
        .save(&PkmPageRequest {
            title: "Cetus Core".into(),
            tier: Some(PkmTier::Project),
            props: Some(BTreeMap::from([("status".into(), "active".into())])),
            markdown: Some("- TODO the parser\n- DOING the editor\n".into()),
        })
        .unwrap();
    assert_eq!(made.file, "01_Projects/Cetus-Core.md");
    assert_eq!(
        on_disk(pkm.root(), &made.file),
        "title:: Cetus Core\nstatus:: active\n\n- TODO the parser\n- DOING the editor\n"
    );
    let moved = pkm
        .move_page(&PkmMoveRequest {
            page: "cetus-core".into(),
            tier: PkmTier::Archive,
        })
        .unwrap();
    assert_eq!(moved.file, "04_Archives/Cetus-Core.md");
    assert!(!pkm.root().join("01_Projects/Cetus-Core.md").exists());

    let kept = moved.blocks[0].id.clone();
    edit(
        pkm.root(),
        &moved.file,
        "title:: Cetus Core\nstatus:: active\n\n- NOW written elsewhere\n- TODO the parser\n- DOING the editor\n",
    );
    let view = pkm.page("Cetus Core").unwrap();
    let bodies: Vec<&str> = view.page.blocks.iter().map(|b| b.body.as_str()).collect();
    assert_eq!(bodies, ["written elsewhere", "the parser", "the editor"]);
    assert_eq!(view.page.blocks[1].id, kept);
    let listed: Vec<(String, i64)> = pkm.list().unwrap().pages.into_iter().map(|p| (p.slug, p.open)).collect();
    assert_eq!(listed, [("cetus-core".to_string(), 3)]);
}

#[test]
fn edits_by_ops_keeps_ids_and_undoes_the_last_change() {
    let f = farm();
    let pkm = &f.pkm;
    let page = pkm.save(&req("Notes", None, "- one\n- two\n")).unwrap();
    let (one, two) = (page.blocks[0].id.clone(), page.blocks[1].id.clone());
    let ops: Vec<PkmBlockOp> = serde_json::from_value(json!([
        { "op": "update", "block": one, "body": "one, edited" },
        { "op": "insert_after", "block": one, "id": "0193e000-0000-7000-8000-000000000001", "body": "between" },
        { "op": "indent", "block": two },
    ]))
    .unwrap();
    let after = pkm.apply("notes", &ops).unwrap();
    let got: Vec<(String, i64, String)> = after.blocks.iter().map(|b| (b.id.clone(), b.depth, b.body.clone())).collect();
    assert_eq!(
        got,
        [
            (one.clone(), 0, "one, edited".to_string()),
            ("0193e000-0000-7000-8000-000000000001".to_string(), 0, "between".to_string()),
            (two.clone(), 1, "two".to_string()),
        ]
    );
    assert!(pkm.undo().unwrap().undone);
    let bodies: Vec<String> = pkm.page("notes").unwrap().page.blocks.into_iter().map(|b| b.body).collect();
    assert_eq!(bodies, ["one", "two"]);
    let undo2 = pkm.undo().unwrap();
    assert_eq!(
        serde_json::to_value(&undo2).unwrap(),
        json!({ "undone": true, "page": "notes", "what": "save" })
    );
    assert!(!pkm.root().join("00_Inbox/Notes.md").exists());
    assert!(pkm.list().unwrap().pages.is_empty());
}

#[test]
fn captures_into_todays_journal_tagged_for_the_inbox() {
    let f = farm();
    let pkm = &f.pkm;
    pkm.capture("call the vet", None, None).unwrap();
    let journal = pkm.capture("buy milk #inbox", None, None).unwrap();
    assert_eq!(journal.tier, PkmTier::Journal);
    let got: Vec<(Option<PkmMarker>, String)> = journal.blocks.iter().map(|b| (b.marker, b.body.clone())).collect();
    assert_eq!(
        got,
        [
            (Some(PkmMarker::LATER), "call the vet #inbox".to_string()),
            (Some(PkmMarker::LATER), "buy milk #inbox".to_string())
        ]
    );
    let later = pkm
        .search(&PkmSearchRequest {
            marker: Some(PkmMarker::LATER),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(later.len(), 2);
}

fn marked(blocks: &[vibevalley_protocol::PkmBlock]) -> Vec<(i64, String, String)> {
    blocks
        .iter()
        .map(|b| (b.depth, b.marker.map(|m| m.as_str().to_string()).unwrap_or_default(), b.body.clone()))
        .collect()
}

fn s(depth: i64, marker: &str, body: &str) -> (i64, String, String) {
    (depth, marker.into(), body.into())
}

#[test]
fn captures_an_outline_into_the_journal_or_onto_a_page() {
    let f = farm();
    let pkm = &f.pkm;
    let journal = pkm.capture("读完第三章\n  记下两句\nTODO 还书", None, None).unwrap();
    assert_eq!(
        marked(&journal.blocks),
        [s(0, "LATER", "读完第三章 #inbox"), s(1, "", "记下两句"), s(0, "TODO", "还书 #inbox")]
    );
    pkm.save(&req("读书", None, "- 书单\n")).unwrap();
    let page = pkm.capture("- 《置身事内》\n  - 第四章", None, Some("读书")).unwrap();
    assert_eq!(marked(&page.blocks), [s(0, "", "书单"), s(0, "", "《置身事内》"), s(1, "", "第四章")]);
    let wrong = refusal(pkm.capture("x", None, Some("读")));
    assert_eq!(wrong.biz_code, BizCode::PkmNotFound);
    assert!(wrong.message.contains("读书"), "{}", wrong.message);
}

#[test]
fn a_file_is_read_as_written_and_not_written_over_a_change_made_since() {
    let f = farm();
    let pkm = &f.pkm;
    pkm.save(&req("Garden", None, "- bulbs\n  - tomatoes\n")).unwrap();
    let source = pkm.source("garden").unwrap();
    assert_eq!((source.page.as_str(), source.title.as_str()), ("garden", "Garden"));
    assert!(source.markdown.contains("- bulbs"));
    let edited = pkm
        .source_update(&PkmSourceUpdate {
            page: "garden".into(),
            markdown: source.markdown.replace("tomatoes", "tomatoes, basil"),
            updated: source.updated,
        })
        .unwrap();
    let bodies: Vec<&str> = edited.blocks.iter().map(|b| b.body.as_str()).collect();
    assert_eq!(bodies, ["bulbs", "tomatoes, basil"]);
    let stale = refusal(pkm.source_update(&PkmSourceUpdate {
        page: "garden".into(),
        markdown: "- gone\n".into(),
        updated: source.updated - 1,
    }));
    assert_eq!(stale.biz_code, BizCode::PkmRefused);
    let bodies: Vec<String> = pkm.page("garden").unwrap().page.blocks.into_iter().map(|b| b.body).collect();
    assert_eq!(bodies, ["bulbs", "tomatoes, basil"]);
}

#[test]
fn opens_a_days_journal_making_it_when_it_is_not_there() {
    let f = farm();
    let pkm = &f.pkm;
    let made = pkm.journal("2026-11-02").unwrap();
    assert_eq!(
        (made.title.as_str(), made.tier, made.file.as_str()),
        ("2026_11_02", PkmTier::Journal, "journals/2026_11_02.md")
    );
    assert_eq!(made.blocks.iter().map(|b| b.body.as_str()).collect::<Vec<_>>(), [""]);
    let again = pkm.journal("2026-11-02").unwrap();
    assert_eq!(
        again.blocks.iter().map(|b| &b.id).collect::<Vec<_>>(),
        made.blocks.iter().map(|b| &b.id).collect::<Vec<_>>()
    );
    let listed: Vec<(String, Option<String>)> = pkm.list().unwrap().pages.into_iter().map(|p| (p.slug, p.day)).collect();
    assert_eq!(listed, [("2026_11_02".to_string(), Some("2026-11-02".to_string()))]);
}

#[test]
fn a_rewrite_keeps_links_waits_for_the_user_and_comes_off_once_accepted() {
    let f = farm();
    let pkm = &f.pkm;
    let page = pkm
        .save(&req("Draft", None, "- this ==is rough==^[make it read better] about [[Engine]]\n"))
        .unwrap();
    let block = page.blocks[0].id.clone();
    let remarks = pkm.comments(Some("draft")).unwrap();
    let got: Vec<(Option<String>, String, &str)> = remarks.iter().map(|c| (c.span.clone(), c.body.clone(), c.status.as_str())).collect();
    assert_eq!(got, [(Some("is rough".to_string()), "make it read better".to_string(), "open")]);
    let proposal = pkm
        .suggest(
            &PkmProposalRequest {
                block: block.clone(),
                suggested: "a clean sentence".into(),
                ..Default::default()
            },
            "user",
        )
        .unwrap();
    assert_eq!(proposal.restored, ["[[Engine]]"]);
    assert_eq!(proposal.comment.id, remarks[0].id);
    assert_eq!(proposal.comment.status.as_str(), "suggested");
    assert_eq!(proposal.comment.suggested.as_deref(), Some("a clean sentence [[Engine]]"));
    let accepted = pkm
        .resolve(&PkmResolveRequest {
            id: proposal.comment.id.clone(),
            accept: true,
        })
        .unwrap();
    assert_eq!(accepted.blocks[0].body, "a clean sentence [[Engine]]");
    assert!(pkm.comments(Some("draft")).unwrap().is_empty());
    assert_eq!(
        on_disk(pkm.root(), "00_Inbox/Draft.md"),
        format!("- a clean sentence [[Engine]]\n  id:: {block}\n")
    );
}

#[test]
fn a_block_another_page_refers_to_keeps_its_id_in_its_file() {
    let f = farm();
    let pkm = &f.pkm;
    let target = pkm.save(&req("Ideas", Some(PkmTier::Resource), "- an idea about engines\n")).unwrap();
    let id = target.blocks[0].id.clone();
    pkm.save(&req("Roadmap", Some(PkmTier::Project), &format!("- builds on (({id}))\n"))).unwrap();
    assert!(on_disk(pkm.root(), "03_Resources/Ideas.md").contains(&format!("id:: {id}")));
    let view = pkm.page("roadmap").unwrap();
    assert_eq!(
        serde_json::to_value(&view.transclusions).unwrap(),
        json!([{ "block": id, "found": true, "circular": false, "page": "ideas", "pageTitle": "Ideas", "body": "an idea about engines" }])
    );
    let cluster = pkm
        .cluster(&PkmClusterRequest {
            topic: "engines".into(),
            title: "Engines".into(),
        })
        .unwrap();
    assert_eq!(cluster.blocks, [id]);
}

#[test]
fn renames_a_page_and_every_link_to_it_and_merges_into_one_already_named_so() {
    let f = farm();
    let pkm = &f.pkm;
    pkm.save(&req("Engine", Some(PkmTier::Resource), "- what it is\n")).unwrap();
    pkm.save(&req("Log", Some(PkmTier::Journal), "- read about [[Engine]]\n")).unwrap();
    let renamed = pkm
        .rename(&PkmRenameRequest {
            from: "Engine".into(),
            to: "Motor".into(),
        })
        .unwrap();
    assert_eq!(renamed.pages, ["log"]);
    assert_eq!(pkm.page("motor").unwrap().page.props.get("alias").map(String::as_str), Some("Engine"));
    assert_eq!(pkm.page("engine").unwrap().page.title, "Motor");
    assert_eq!(pkm.page("log").unwrap().page.blocks[0].body, "read about [[Motor]]");
    pkm.save(&req("Turbine", Some(PkmTier::Resource), "- spins\n")).unwrap();
    pkm.rename(&PkmRenameRequest {
        from: "Turbine".into(),
        to: "Motor".into(),
    })
    .unwrap();
    let bodies: Vec<String> = pkm.page("motor").unwrap().page.blocks.into_iter().map(|b| b.body).collect();
    assert_eq!(bodies, ["what it is", "spins"]);
    let mut slugs: Vec<String> = pkm.list().unwrap().pages.into_iter().map(|p| p.slug).collect();
    slugs.sort();
    assert_eq!(slugs, ["log", "motor"]);
}

#[test]
fn clips_a_url_once_and_adds_highlights_on_a_second_clip() {
    let f = farm();
    let pkm = &f.pkm;
    let first = pkm
        .clip(&PkmClipRequest {
            url: "https://example.com/a/".into(),
            title: "An Article".into(),
            content: "Para one.\n\nPara two.".into(),
            highlights: Some(vec![PkmClipRequestHighlights {
                text: "Para one.".into(),
                anchor: "p1".into(),
            }]),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        serde_json::to_value(&first).unwrap(),
        json!({ "duplicate": false, "page": "an-article", "snapshot": ".pkm/snapshots/An-Article.raw.md" })
    );
    assert_eq!(on_disk(pkm.root(), &first.snapshot), "Para one.\n\nPara two.");
    let again = pkm
        .clip(&PkmClipRequest {
            url: "https://example.com/a".into(),
            title: "Other".into(),
            content: String::new(),
            highlights: Some(vec![PkmClipRequestHighlights {
                text: "Para two.".into(),
                anchor: "p2".into(),
            }]),
            ..Default::default()
        })
        .unwrap();
    assert!(again.duplicate);
    let view = pkm.page("an-article").unwrap();
    assert_eq!(view.page.props.get("source-url").map(String::as_str), Some("https://example.com/a"));
    let bodies: Vec<&str> = view.page.blocks.iter().map(|b| b.body.as_str()).collect();
    assert_eq!(bodies.len(), 3);
    assert_eq!(&bodies[1..], ["> Para one.", "> Para two."]);
    assert!(pkm.markdown("an-article").unwrap().contains("> Para two."));
}

#[test]
fn searches_through_the_full_text_index_which_follows_the_files() {
    let f = farm();
    let pkm = &f.pkm;
    pkm.save(&req(
        "解析器",
        Some(PkmTier::Project),
        "- 单遍状态机的解析器\n  - 支持代码块\n- 渲染引擎 rendering engine\n",
    ))
    .unwrap();
    pkm.save(&req("旧方案", Some(PkmTier::Archive), "- 以前的解析器\n")).unwrap();
    let text = |t: &str| PkmSearchRequest {
        text: Some(t.into()),
        ..Default::default()
    };
    let found = pkm.search(&text("解析器")).unwrap();
    assert_eq!(found[0].body, "单遍状态机的解析器");
    assert_eq!(found[0].children.iter().map(|c| c.body.as_str()).collect::<Vec<_>>(), ["支持代码块"]);
    let pages: HashSet<String> = found.iter().map(|h| h.page.clone()).collect();
    assert_eq!(pages, HashSet::from(["解析器".to_string(), "旧方案".to_string()]));
    let render: Vec<String> = pkm.search(&text("render")).unwrap().into_iter().map(|h| h.body).collect();
    assert_eq!(render, ["渲染引擎 rendering engine"]);
    std::fs::remove_file(pkm.root().join("04_Archives/旧方案.md")).unwrap();
    pkm.list().unwrap();
    let pages: HashSet<String> = pkm.search(&text("解析器")).unwrap().into_iter().map(|h| h.page).collect();
    assert_eq!(pages, HashSet::from(["解析器".to_string()]));
    edit(pkm.root(), "02_Areas/写在外面.md", "- 外面写的解析器笔记\n");
    pkm.scan().unwrap();
    let outside: Vec<String> = pkm.search(&text("外面")).unwrap().into_iter().map(|h| h.body).collect();
    assert_eq!(outside, ["外面写的解析器笔记"]);
}

#[test]
fn answers_for_a_page_that_is_not_there_or_whose_file_is_gone() {
    let f = farm();
    let pkm = &f.pkm;
    assert_eq!(refusal(pkm.page("nowhere")).biz_code, BizCode::PkmNotFound);
    pkm.save(&PkmPageRequest {
        title: "Gone".into(),
        ..Default::default()
    })
    .unwrap();
    std::fs::remove_file(pkm.root().join("00_Inbox/Gone.md")).unwrap();
    assert_eq!(refusal(pkm.page("gone")).biz_code, BizCode::PkmNotFound);
    assert_eq!(
        refusal(pkm.save(&PkmPageRequest {
            title: " ".into(),
            ..Default::default()
        }))
        .biz_code,
        BizCode::PkmRefused
    );
}

#[test]
fn the_endpoints_are_served_and_the_watcher_follows_an_outside_editor() {
    let dir = tempfile::tempdir().unwrap();
    let started = vibevalley_server::start(vibevalley_server::ServerConfig {
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        orchestrator_listens: false,
        ..vibevalley_server::ServerConfig::under(dir.path())
    })
    .expect("started");
    let hub = started.hub.clone();
    let saved = hub.call("pkm.page.save", json!({ "title": "Inbox note", "markdown": "- first\n" }));
    assert_eq!(saved.data.as_ref().unwrap()["file"], "00_Inbox/Inbox-note.md", "{saved:?}");
    let list = hub.call("pkm.page.list", serde_json::Value::Null);
    assert_eq!(list.data.as_ref().unwrap()["root"], dir.path().join("pkm").to_string_lossy().as_ref());
    let missing = hub.call("pkm.page.get", json!({ "page": "nowhere" }));
    assert_eq!(missing.biz_code, BizCode::PkmNotFound.code());

    edit(&dir.path().join("pkm"), "03_Resources/Watched.md", "- 外面写的笔记 watched\n");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let hits = hub.call("pkm.search", json!({ "text": "watched" }));
        if hits.data.as_ref().and_then(|d| d.as_array()).is_some_and(|a| !a.is_empty()) {
            break;
        }
        assert!(Instant::now() < deadline, "the watcher never rescanned: {hits:?}");
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
fn regression_failed_index_refresh_keeps_old_terms_and_recovers_the_written_file_and_undo() {
    use sqlx::{ConnectOptions, sqlite::SqliteConnectOptions};

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("pkm");
    let pkm = Pkm::open(dir.path(), &root).unwrap();
    let page = pkm.save(&req("Notes", Some(PkmTier::Project), "- alder\n")).unwrap();
    let mut db = pollster::block_on(SqliteConnectOptions::new().filename(dir.path().join("server.db")).connect()).unwrap();
    let before: Vec<String> = pollster::block_on(
        sqlx::query_scalar("SELECT terms FROM pkm_term WHERE page=? ORDER BY block")
            .bind(page.slug.clone())
            .fetch_all(&mut db),
    )
    .unwrap();
    assert!(!before.is_empty());
    pollster::block_on(
        sqlx::raw_sql(
            "CREATE TRIGGER refuse_new_term BEFORE INSERT ON pkm_term WHEN instr(NEW.terms, 'juniper') > 0 BEGIN SELECT RAISE(ABORT,'index failure'); END;",
        )
        .execute(&mut db),
    )
    .unwrap();
    let ops: Vec<PkmBlockOp> = serde_json::from_value(json!([{"op":"update","block":page.blocks[0].id,"body":"juniper"}])).unwrap();
    let error = pkm.apply("notes", &ops).unwrap_err();
    assert_eq!(error.biz_code, BizCode::InternalError);
    assert_eq!(on_disk(&root, &page.file), "- juniper\n");
    let kept: Vec<String> = pollster::block_on(
        sqlx::query_scalar("SELECT terms FROM pkm_term WHERE page=? ORDER BY block")
            .bind(page.slug)
            .fetch_all(&mut db),
    )
    .unwrap();
    assert_eq!(kept, before);
    pollster::block_on(sqlx::raw_sql("DROP TRIGGER refuse_new_term").execute(&mut db)).unwrap();
    drop(pkm);
    let reopened = Pkm::open(dir.path(), &root).unwrap();
    let query = |text: &str| PkmSearchRequest {
        text: Some(text.into()),
        ..Default::default()
    };
    assert_eq!(reopened.search(&query("juniper")).unwrap()[0].body, "juniper");
    assert!(reopened.search(&query("alder")).unwrap().is_empty());
    assert!(reopened.undo().unwrap().undone);
    assert!(on_disk(&root, &page.file).contains("- alder"));
    assert_eq!(reopened.search(&query("alder")).unwrap()[0].body, "alder");
}
