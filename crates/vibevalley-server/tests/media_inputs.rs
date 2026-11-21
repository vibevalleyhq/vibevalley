use serde_json::{Value, json};
use std::{io::Cursor, path::Path, sync::Arc};
use vibevalley_protocol::{BizCode, Caller, MediaInputPhase, MediaInputRequest};
use vibevalley_server::{
    Hub,
    modules::content::{
        attachment::Attachments,
        media::inputs::{self, Inputs},
    },
};
fn database(root: &Path) -> sqlx::SqliteConnection {
    use sqlx::ConnectOptions;
    pollster::block_on(sqlx::sqlite::SqliteConnectOptions::new().filename(root.join("server.db")).connect()).unwrap()
}

fn setup() -> (tempfile::TempDir, Arc<Inputs>, Arc<Attachments>, Arc<Hub>) {
    let dir = tempfile::tempdir().unwrap();
    let files = Attachments::open(dir.path()).unwrap();
    let inputs = Inputs::open(dir.path(), files.clone()).unwrap();
    let hub = Hub::new(vibevalley_core::empty_space_state());
    inputs::install(&hub, inputs.clone());
    (dir, inputs, files, hub)
}
fn request() -> MediaInputRequest {
    serde_json::from_value(json!({"kind":"image","mime":"image/png","name":"猫.png","size":24})).unwrap()
}
fn png() -> Vec<u8> {
    let mut b = b"\x89PNG\r\n\x1a\n".to_vec();
    b.resize(24, 0);
    b
}
fn ok(h: &Hub, op: &str, p: Value) -> Value {
    let e = h.call_as(Caller::User, op, p);
    assert_eq!(e.biz_code, 0, "{}", e.message);
    e.data.unwrap_or(Value::Null)
}
#[test]
fn protocol_adopts_a_kept_attachment_and_delete_preserves_its_bytes() {
    let (_dir, inputs, files, hub) = setup();
    let file = files.keep(&png(), "猫.png", "image/png").unwrap();
    let r = ok(&hub, "media.input.adopt", json!({"attachment":file.id}));
    assert_eq!(r["phase"], "ready");
    assert_eq!(r["hash"], file.id);
    let id = r["id"].as_str().unwrap();
    assert_eq!(ok(&hub, "media.input.get", json!({"id":id})), r);
    assert_eq!(ok(&hub, "media.input.list", Value::Null).as_array().unwrap().len(), 1);
    assert_eq!(ok(&hub, "media.input.previewDelete", json!({"id":id}))["does"].as_array().unwrap().len(), 1);
    assert_eq!(std::fs::read(inputs.content(id).unwrap().path).unwrap(), png());
    ok(&hub, "media.input.delete", json!({"id":id}));
    ok(&hub, "media.input.delete", json!({"id":id}));
    assert!(files.path_of(&file.id).is_file());
    assert_eq!(ok(&hub, "media.input.previewDelete", json!({"id":id})), json!({"does":[]}));
    assert_ne!(
        hub.call_as(Caller::Orchestrator, "media.input.create", serde_json::to_value(request()).unwrap())
            .biz_code,
        0
    );
}
#[test]
fn invalid_metadata_sizes_and_disguised_files_are_refused_and_upload_can_retry() {
    let (_dir, inputs, _, hub) = setup();
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
        assert_eq!(hub.call_as(Caller::User, "media.input.create", r).biz_code, BizCode::MediaRefused.code());
    }
    let r = inputs.create(&request()).unwrap();
    for bytes in [vec![0; 24], png()[..20].to_vec(), vec![1; 25]] {
        assert!(inputs.upload(&r.id, Cursor::new(bytes)).is_err());
        assert_eq!(inputs.get(&r.id).unwrap().phase, MediaInputPhase::Failed);
    }
    let ready = inputs.upload(&r.id, Cursor::new(png())).unwrap();
    assert_eq!(ready.phase, MediaInputPhase::Ready);
    assert_eq!(inputs.upload(&r.id, Cursor::new(Vec::<u8>::new())).unwrap(), ready);
}
#[test]
fn pins_admission_rollback_expiry_and_restart() {
    let (dir, inputs, files, _) = setup();
    let r = inputs.create(&request()).unwrap();
    inputs.upload(&r.id, Cursor::new(png())).unwrap();
    let bad = inputs.pin(&[r.id.clone(), "missing".into()], "job");
    assert!(bad.is_err());
    assert!(inputs.get(&r.id).unwrap().can_delete);
    inputs.pin(&[r.id.clone(), r.id.clone()], "job").unwrap();
    assert!(!inputs.get(&r.id).unwrap().can_delete);
    assert!(inputs.delete(&r.id).is_err());
    let mut db = database(dir.path());
    pollster::block_on(sqlx::query("update media_input set expires_at=0").execute(&mut db)).unwrap();
    inputs.sweep().unwrap();
    assert!(inputs.content(&r.id).is_ok());
    let restored = Inputs::open(dir.path(), files.clone()).unwrap();
    assert!(!restored.get(&r.id).unwrap().can_delete);
    restored.release("job").unwrap();
    assert!(restored.content(&r.id).is_err());
    restored.sweep().unwrap();
    assert!(restored.list().unwrap().is_empty());
    let interrupted = restored.create(&request()).unwrap();
    pollster::block_on(
        sqlx::query("update media_input set phase='uploading' where id=?1")
            .bind(&interrupted.id)
            .execute(&mut db),
    )
    .unwrap();
    let reopened = Inputs::open(dir.path(), files).unwrap();
    assert_eq!(reopened.get(&interrupted.id).unwrap().phase, MediaInputPhase::Failed);
}
#[test]
fn quota_and_corrupted_content() {
    let (dir, inputs, files, _) = setup();
    let mut r = request();
    r.kind = vibevalley_protocol::MediaInputKind::Audio;
    r.mime = "audio/wav".into();
    r.size = 512_000_000;
    for _ in 0..4 {
        inputs.create(&r).unwrap();
    }
    assert!(inputs.create(&r).is_err());
    let mut db = database(dir.path());
    pollster::block_on(sqlx::query("update media_input set expires_at=0").execute(&mut db)).unwrap();
    inputs.sweep().unwrap();
    let input = inputs.create(&request()).unwrap();
    let ready = inputs.upload(&input.id, Cursor::new(png())).unwrap();
    std::fs::write(files.path_of(ready.hash.as_ref().unwrap()), vec![1; 24]).unwrap();
    assert!(inputs.content(&input.id).is_err());
    for _ in 1..256 {
        inputs.create(&request()).unwrap();
    }
    assert!(inputs.create(&request()).is_err());
}
#[test]
fn active_upload_cannot_be_deleted_or_pinned() {
    let (_dir, inputs, _, _) = setup();
    let r = inputs.create(&request()).unwrap();
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
        i.upload(
            &id,
            Paused {
                entered: tx,
                resume: wait,
                bytes: Cursor::new(png()),
                first: true,
            },
        )
    });
    rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
    assert!(!inputs.get(&r.id).unwrap().can_delete);
    assert!(inputs.delete(&r.id).is_err());
    assert!(inputs.pin(&[r.id], "job").is_err());
    go.send(()).unwrap();
    assert!(task.join().unwrap().is_ok());
}
#[test]
fn audio_requires_more_than_a_container_header() {
    let (_dir, inputs, _, _) = setup();
    let mut r = request();
    r.kind = vibevalley_protocol::MediaInputKind::Audio;
    r.mime = "audio/wav".into();
    let input = inputs.create(&r).unwrap();
    let mut fake = vec![0; 24];
    fake[..4].copy_from_slice(b"RIFF");
    fake[8..12].copy_from_slice(b"WAVE");
    assert!(inputs.upload(&input.id, Cursor::new(fake)).is_err());
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
    let broken = inputs.create(&r).unwrap();
    assert!(inputs.upload(&broken.id, Cursor::new(truncated)).is_err());
    r.size = wav.len() as i64;
    let input = inputs.create(&r).unwrap();
    assert_eq!(inputs.upload(&input.id, Cursor::new(wav)).unwrap().phase, MediaInputPhase::Ready);
}

#[test]
fn real_http_upload_preview_ranges_and_origin_checks() {
    let (_dir, inputs, _, hub) = setup();
    let listener = vibevalley_http::serve(hub, "127.0.0.1:0".parse().unwrap()).unwrap();
    let r = inputs.create(&request()).unwrap();
    let url = format!("{}/api/v1/media/input/{}/content", listener.url(), r.id);
    let ready: Value = ureq::put(&url)
        .header("content-type", "application/octet-stream")
        .send(png())
        .unwrap()
        .body_mut()
        .read_json()
        .unwrap();
    assert_eq!(ready["data"]["phase"], "ready");
    let mut response = ureq::get(&url).call().unwrap();
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(response.headers()["content-security-policy"], "sandbox");
    assert_eq!(response.body_mut().read_to_vec().unwrap(), png());
    let mut range = ureq::get(&url).header("range", "bytes=2-7").call().unwrap();
    assert_eq!(range.status().as_u16(), 206);
    assert_eq!(range.headers()["content-range"], "bytes 2-7/24");
    assert_eq!(range.body_mut().read_to_vec().unwrap(), png()[2..8]);
    assert!(matches!(ureq::get(&url).header("range", "bytes=30-").call(), Err(ureq::Error::StatusCode(416))));
    assert!(matches!(
        ureq::get(&url).header("origin", "https://evil.example").call(),
        Err(ureq::Error::StatusCode(403))
    ));
    assert!(matches!(
        ureq::put(&url).header("content-type", "text/plain").send(png()),
        Err(ureq::Error::StatusCode(415))
    ));
    // A reserved upload interrupted before its declared size is failed, then
    // the same reservation can be retried over the real transport.
    let interrupted = inputs.create(&request()).unwrap();
    let retry = format!("{}/api/v1/media/input/{}/content", listener.url(), interrupted.id);
    assert!(ureq::put(&retry).header("content-type", "application/octet-stream").send(&png()[..20]).is_err());
    assert_eq!(inputs.get(&interrupted.id).unwrap().phase, MediaInputPhase::Failed);
    ureq::put(&retry).header("content-type", "application/octet-stream").send(png()).unwrap();
    assert_eq!(inputs.get(&interrupted.id).unwrap().phase, MediaInputPhase::Ready);
}

#[test]
fn failed_promotion_keeps_hash_and_refuses_changed_retry() {
    let (dir, inputs, _, _) = setup();
    let r = inputs.create(&request()).unwrap();
    let mut db = database(dir.path());
    pollster::block_on(
        sqlx::raw_sql("create trigger fail_attachment before insert on attachment begin select raise(abort, 'disk failure'); end;").execute(&mut db),
    )
    .unwrap();
    assert!(inputs.upload(&r.id, Cursor::new(png())).is_err());
    let failed = inputs.get(&r.id).unwrap();
    assert_eq!(failed.phase, MediaInputPhase::Failed);
    assert!(failed.hash.is_some());
    pollster::block_on(sqlx::query("drop trigger fail_attachment").execute(&mut db)).unwrap();
    let mut changed = png();
    changed[23] = 1;
    assert!(inputs.upload(&r.id, Cursor::new(changed)).is_err());
    assert_eq!(inputs.upload(&r.id, Cursor::new(png())).unwrap().phase, MediaInputPhase::Ready);
}

#[test]
fn regression_native_media_paths_stream_validated_files_and_refuse_other_callers() {
    let (dir, inputs, _, hub) = setup();
    let file = dir.path().join("sample.png");
    std::fs::write(&file, png()).unwrap();
    let reserved = inputs.create(&request()).unwrap();
    for caller in [Caller::Orchestrator, Caller::Remote] {
        assert_ne!(hub.call_as(caller, "media.input.uploadFile", json!({"id":reserved.id,"path":file})).biz_code, 0);
    }
    assert!(inputs.upload_file(&reserved.id, Path::new("relative.png")).is_err());
    assert!(inputs.upload_file(&reserved.id, dir.path()).is_err());
    let ready = ok(&hub, "media.input.uploadFile", json!({"id":reserved.id,"path":file}));
    assert_eq!(ready["phase"], "ready");
    let stored = ok(&hub, "media.input.file", json!({"id":reserved.id}));
    assert_eq!(std::fs::read(stored["path"].as_str().unwrap()).unwrap(), png());
    std::fs::write(stored["path"].as_str().unwrap(), b"changed").unwrap();
    assert_ne!(hub.call_as(Caller::User, "media.input.file", json!({"id":reserved.id})).biz_code, 0);
}
