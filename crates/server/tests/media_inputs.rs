use serde_json::{Value, json};
use std::{io::Cursor, path::Path};
use vibevalley_protocol::{BizCode, Caller, MediaInputPhase, MediaInputRequest};
use vibevalley_runtime::rt::block_on;
use vibevalley_server::{App, Config, Router, create_app_blocking};

fn database(root: &Path) -> sqlx::SqliteConnection {
    use sqlx::ConnectOptions;
    block_on(sqlx::sqlite::SqliteConnectOptions::new().filename(root.join("server.db")).connect()).unwrap()
}

fn app_at(dir: &Path) -> App {
    create_app_blocking(Config {
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        orchestrator_listens: false,
        ..Config::under(dir)
    })
    .unwrap()
}

fn setup() -> (tempfile::TempDir, App) {
    let dir = tempfile::tempdir().unwrap();
    let app = app_at(dir.path());
    (dir, app)
}
fn request() -> MediaInputRequest {
    serde_json::from_value(json!({"kind":"image","mime":"image/png","name":"猫.png","size":24})).unwrap()
}
fn png() -> Vec<u8> {
    let mut b = b"\x89PNG\r\n\x1a\n".to_vec();
    b.resize(24, 0);
    b
}
fn ok(r: &Router, op: &str, p: Value) -> Value {
    let e = r.call_as(Caller::User, op, p);
    assert_eq!(e.biz_code, 0, "{}", e.message);
    e.data.unwrap_or(Value::Null)
}
#[test]
fn protocol_adopts_a_kept_attachment_and_delete_preserves_its_bytes() {
    let (_dir, app) = setup();
    let files = &app.test_internals().storage.attachment;
    let inputs = &app.test_internals().storage.media_input;
    let router = app.router();
    let file = vibevalley_runtime::rt::block_on(files.keep_async(png(), "猫.png".into(), "image/png".into())).unwrap();
    let r = ok(router, "media.input.adopt", json!({"attachment":file.id}));
    assert_eq!(r["phase"], "ready");
    assert_eq!(r["hash"], file.id);
    let id = r["id"].as_str().unwrap();
    assert_eq!(ok(router, "media.input.list", Value::Null), json!([r]));
    assert_eq!(ok(router, "media.input.previewDelete", json!({"id":id}))["does"].as_array().unwrap().len(), 1);
    assert_eq!(
        std::fs::read(vibevalley_runtime::rt::block_on(inputs.content_async(id)).unwrap().path).unwrap(),
        png()
    );
    ok(router, "media.input.delete", json!({"id":id}));
    ok(router, "media.input.delete", json!({"id":id}));
    assert!(files.path_of(&file.id).is_file());
    assert_eq!(ok(router, "media.input.previewDelete", json!({"id":id})), json!({"does":[]}));
    assert_ne!(
        router
            .call_as(Caller::Orchestrator, "media.input.create", serde_json::to_value(request()).unwrap())
            .biz_code,
        0
    );
    app.close_blocking();
}
#[test]
fn invalid_metadata_sizes_and_disguised_files_are_refused_and_upload_can_retry() {
    let (_dir, app) = setup();
    let inputs = &app.test_internals().storage.media_input;
    let router = app.router();
    for (field, value) in [
        ("size", json!(15)),
        ("size", json!(30_000_001)),
        ("mime", json!("audio/wav")),
        ("name", json!("../cat.png")),
        ("name", json!("\n")),
        ("name", json!(" ")),
    ] {
        let mut r = serde_json::to_value(request()).unwrap();
        r[field] = value;
        assert_eq!(router.call_as(Caller::User, "media.input.create", r).biz_code, BizCode::MediaRefused.code());
    }
    let r = block_on(inputs.create_async(&request())).unwrap();
    for bytes in [vec![0; 24], png()[..20].to_vec(), vec![1; 25]] {
        assert!(block_on(inputs.upload_async(&r.id, Box::new(Cursor::new(bytes)))).is_err());
        assert_eq!(block_on(inputs.get_async(&r.id)).unwrap().phase, MediaInputPhase::Failed);
    }
    let ready = block_on(inputs.upload_async(&r.id, Box::new(Cursor::new(png())))).unwrap();
    assert_eq!(ready.phase, MediaInputPhase::Ready);
    assert_eq!(block_on(inputs.upload_async(&r.id, Box::new(Cursor::new(Vec::<u8>::new())))).unwrap(), ready);
    app.close_blocking();
}
#[test]
fn pins_admission_rollback_expiry_and_restart() {
    let (dir, app) = setup();
    let r = block_on(app.test_internals().storage.media_input.create_async(&request())).unwrap();
    block_on(app.test_internals().storage.media_input.upload_async(&r.id, Box::new(Cursor::new(png())))).unwrap();
    let bad = block_on(app.test_internals().storage.media_input.pin_async(&[r.id.clone(), "missing".into()], "job"));
    assert!(bad.is_err());
    assert!(block_on(app.test_internals().storage.media_input.get_async(&r.id)).unwrap().can_delete);
    block_on(app.test_internals().storage.media_input.pin_async(&[r.id.clone(), r.id.clone()], "job")).unwrap();
    assert!(!block_on(app.test_internals().storage.media_input.get_async(&r.id)).unwrap().can_delete);
    assert!(block_on(app.test_internals().storage.media_input.delete_async(&r.id)).is_err());
    let mut conn = database(dir.path());
    block_on(sqlx::query("update media_input set expires_at=0").execute(&mut conn)).unwrap();
    block_on(app.test_internals().storage.media_input.sweep_async()).unwrap();
    assert!(block_on(app.test_internals().storage.media_input.content_async(&r.id)).is_ok());
    app.close_blocking();

    let restored = app_at(dir.path());
    let inputs = &restored.test_internals().storage.media_input;
    assert!(!block_on(inputs.get_async(&r.id)).unwrap().can_delete);
    block_on(inputs.release_async("job")).unwrap();
    assert!(block_on(inputs.content_async(&r.id)).is_err());
    block_on(inputs.sweep_async()).unwrap();
    assert!(block_on(inputs.list_async()).unwrap().is_empty());
    let interrupted = block_on(inputs.create_async(&request())).unwrap();
    block_on(
        sqlx::query("update media_input set phase='uploading' where id=?1")
            .bind(&interrupted.id)
            .execute(&mut conn),
    )
    .unwrap();
    restored.close_blocking();

    let reopened = app_at(dir.path());
    assert_eq!(
        block_on(reopened.test_internals().storage.media_input.get_async(&interrupted.id))
            .unwrap()
            .phase,
        MediaInputPhase::Failed
    );
    reopened.close_blocking();
}
#[test]
fn quota_and_corrupted_content() {
    let (dir, app) = setup();
    let inputs = &app.test_internals().storage.media_input;
    let files = &app.test_internals().storage.attachment;
    let mut r = request();
    r.kind = vibevalley_protocol::MediaInputKind::Audio;
    r.mime = "audio/wav".into();
    r.size = 512_000_000;
    for _ in 0..4 {
        block_on(inputs.create_async(&r)).unwrap();
    }
    assert!(block_on(inputs.create_async(&r)).is_err());
    let mut db = database(dir.path());
    block_on(sqlx::query("update media_input set expires_at=0").execute(&mut db)).unwrap();
    block_on(inputs.sweep_async()).unwrap();
    let input = block_on(inputs.create_async(&request())).unwrap();
    let ready = block_on(inputs.upload_async(&input.id, Box::new(Cursor::new(png())))).unwrap();
    std::fs::write(files.path_of(ready.hash.as_ref().unwrap()), vec![1; 24]).unwrap();
    assert!(block_on(inputs.content_async(&input.id)).is_err());
    for _ in 1..256 {
        block_on(inputs.create_async(&request())).unwrap();
    }
    assert!(block_on(inputs.create_async(&request())).is_err());
}
#[test]
fn active_upload_cannot_be_deleted_or_pinned() {
    let (_dir, app) = setup();
    let inputs = app.test_internals().storage.media_input.clone();
    let r = block_on(inputs.create_async(&request())).unwrap();
    struct Paused {
        entered: std::sync::mpsc::Sender<()>,
        resume: std::sync::mpsc::Receiver<()>,
        bytes: Cursor<Vec<u8>>,
        first: bool,
    }
    impl std::io::Read for Paused {
        fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
            if self.first {
                self.first = false;
                self.entered.send(()).unwrap();
                self.resume.recv().unwrap();
            }
            std::io::Read::read(&mut self.bytes, b)
        }
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let (go, wait) = std::sync::mpsc::channel();
    let i = inputs.clone();
    let id = r.id.clone();
    let task = std::thread::spawn(move || {
        block_on(i.upload_async(
            &id,
            Box::new(Paused {
                entered: tx,
                resume: wait,
                bytes: Cursor::new(png()),
                first: true,
            }),
        ))
    });
    rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
    assert!(!block_on(inputs.get_async(&r.id)).unwrap().can_delete);
    assert!(block_on(inputs.delete_async(&r.id)).is_err());
    assert!(block_on(inputs.pin_async(&[r.id], "job")).is_err());
    go.send(()).unwrap();
    assert!(task.join().unwrap().is_ok());
}
#[test]
fn audio_requires_more_than_a_container_header() {
    let (_dir, app) = setup();
    let inputs = &app.test_internals().storage.media_input;
    let mut r = request();
    r.kind = vibevalley_protocol::MediaInputKind::Audio;
    r.mime = "audio/wav".into();
    let input = block_on(inputs.create_async(&r)).unwrap();
    let mut fake = vec![0; 24];
    fake[..4].copy_from_slice(b"RIFF");
    fake[8..12].copy_from_slice(b"WAVE");
    assert!(block_on(inputs.upload_async(&input.id, Box::new(Cursor::new(fake)))).is_err());
    let mut wav = Vec::new();
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&196u32.to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&8000u32.to_le_bytes());
    wav.extend_from_slice(&16000u32.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&160u32.to_le_bytes());
    wav.resize(204, 0);
    let mut truncated = wav.clone();
    truncated[4..8].copy_from_slice(&200u32.to_le_bytes());
    r.size = truncated.len() as i64;
    let broken = block_on(inputs.create_async(&r)).unwrap();
    assert!(block_on(inputs.upload_async(&broken.id, Box::new(Cursor::new(truncated)))).is_err());
    r.size = wav.len() as i64;
    let input = block_on(inputs.create_async(&r)).unwrap();
    assert_eq!(
        block_on(inputs.upload_async(&input.id, Box::new(Cursor::new(wav)))).unwrap().phase,
        MediaInputPhase::Ready
    );
}

#[test]
fn real_http_upload_preview_ranges_and_origin_checks() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let (_dir, app) = setup();
    let inputs = &app.test_internals().storage.media_input;
    let listener = vibevalley_server::gateway::http::serve(app.server(), "127.0.0.1:0".parse().unwrap()).unwrap();
    let client = reqwest::blocking::Client::builder().no_proxy().build().unwrap();
    let r = block_on(inputs.create_async(&request())).unwrap();
    let url = format!("{}/api/v1/media/input/{}/content", listener.url(), r.id);
    let ready: Value = client
        .put(&url)
        .header("content-type", "application/octet-stream")
        .body(png())
        .send()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(ready["data"]["phase"], "ready");
    let response = client.get(&url).send().unwrap();
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(response.headers()["content-security-policy"], "sandbox");
    assert_eq!(response.bytes().unwrap().as_ref(), png().as_slice());
    let range = client.get(&url).header("range", "bytes=2-7").send().unwrap();
    assert_eq!(range.status().as_u16(), 206);
    assert_eq!(range.headers()["content-range"], "bytes 2-7/24");
    assert_eq!(range.bytes().unwrap().as_ref(), &png()[2..8]);
    assert_eq!(client.get(&url).header("range", "bytes=30-").send().unwrap().status().as_u16(), 416);
    assert_eq!(client.get(&url).header("origin", "https://evil.example").send().unwrap().status().as_u16(), 403);
    assert_eq!(
        client
            .put(&url)
            .header("content-type", "text/plain")
            .body(png())
            .send()
            .unwrap()
            .status()
            .as_u16(),
        415
    );
    // A reserved upload interrupted before its declared size is failed, then
    // the same reservation can be retried over the real transport.
    let interrupted = block_on(inputs.create_async(&request())).unwrap();
    let retry = format!("{}/api/v1/media/input/{}/content", listener.url(), interrupted.id);
    assert!(
        !client
            .put(&retry)
            .header("content-type", "application/octet-stream")
            .body(png()[..20].to_vec())
            .send()
            .unwrap()
            .status()
            .is_success()
    );
    assert_eq!(block_on(inputs.get_async(&interrupted.id)).unwrap().phase, MediaInputPhase::Failed);
    assert!(
        client
            .put(&retry)
            .header("content-type", "application/octet-stream")
            .body(png())
            .send()
            .unwrap()
            .status()
            .is_success()
    );
    assert_eq!(block_on(inputs.get_async(&interrupted.id)).unwrap().phase, MediaInputPhase::Ready);
}

#[test]
fn failed_promotion_keeps_hash_and_refuses_changed_retry() {
    let (dir, app) = setup();
    let inputs = &app.test_internals().storage.media_input;
    let r = block_on(inputs.create_async(&request())).unwrap();
    let mut db = database(dir.path());
    block_on(sqlx::raw_sql("create trigger fail_attachment before insert on attachment begin select raise(abort, 'disk failure'); end;").execute(&mut db))
        .unwrap();
    assert!(block_on(inputs.upload_async(&r.id, Box::new(Cursor::new(png())))).is_err());
    let failed = block_on(inputs.get_async(&r.id)).unwrap();
    assert_eq!(failed.phase, MediaInputPhase::Failed);
    assert!(failed.hash.is_some());
    block_on(sqlx::query("drop trigger fail_attachment").execute(&mut db)).unwrap();
    let mut changed = png();
    changed[23] = 1;
    assert!(block_on(inputs.upload_async(&r.id, Box::new(Cursor::new(changed)))).is_err());
    assert_eq!(
        block_on(inputs.upload_async(&r.id, Box::new(Cursor::new(png())))).unwrap().phase,
        MediaInputPhase::Ready
    );
}

#[test]
fn regression_native_media_paths_stream_validated_files_and_refuse_other_callers() {
    let (dir, app) = setup();
    let inputs = &app.test_internals().storage.media_input;
    let router = app.router();
    let file = dir.path().join("sample.png");
    std::fs::write(&file, png()).unwrap();
    let reserved = block_on(inputs.create_async(&request())).unwrap();
    for caller in [Caller::Orchestrator, Caller::Remote] {
        assert_ne!(
            router.call_as(caller, "media.input.uploadFile", json!({"id":reserved.id,"path":file})).biz_code,
            0
        );
    }
    assert!(block_on(inputs.upload_file_async(&reserved.id, Path::new("relative.png").to_path_buf())).is_err());
    assert!(block_on(inputs.upload_file_async(&reserved.id, dir.path().to_path_buf())).is_err());
    let ready = ok(router, "media.input.uploadFile", json!({"id":reserved.id,"path":file}));
    assert_eq!(ready["phase"], "ready");
    let stored = ok(router, "media.input.file", json!({"id":reserved.id}));
    assert_eq!(std::fs::read(stored["path"].as_str().unwrap()).unwrap(), png());
    std::fs::write(stored["path"].as_str().unwrap(), b"changed").unwrap();
    assert_ne!(router.call_as(Caller::User, "media.input.file", json!({"id":reserved.id})).biz_code, 0);
    app.close_blocking();
}

#[test]
fn regression_list_reads_without_write_lock_during_concurrent_transaction() {
    let (dir, app) = setup();
    let inputs = &app.test_internals().storage.media_input;
    let ready = block_on(inputs.create_async(&request())).unwrap();
    block_on(inputs.upload_async(&ready.id, Box::new(Cursor::new(png())))).unwrap();
    block_on(inputs.pin_async(std::slice::from_ref(&ready.id), "job-1")).unwrap();
    let free = block_on(inputs.create_async(&request())).unwrap();

    // Hold a SQLite write lock open on a separate connection; `MediaInputStore::list_async()` must
    // use plain WAL reads without `BEGIN IMMEDIATE` and return immediately.
    let mut writer = database(dir.path());
    block_on(sqlx::raw_sql("BEGIN IMMEDIATE").execute(&mut writer)).unwrap();
    let started = std::time::Instant::now();
    let listed = block_on(inputs.list_async()).expect("list must succeed while another connection holds write lock");
    assert!(
        started.elapsed() < std::time::Duration::from_secs(1),
        "list blocked on writer lock for {:?}",
        started.elapsed()
    );
    vibevalley_runtime::rt::block_on(sqlx::raw_sql("ROLLBACK").execute(&mut writer)).unwrap();

    let ready_entry = listed.iter().find(|i| i.id == ready.id).expect("ready input listed");
    let free_entry = listed.iter().find(|i| i.id == free.id).expect("free input listed");
    assert!(!ready_entry.can_delete);
    assert!(free_entry.can_delete);
}
