use serde_json::{Value, json};
use std::{
    io::{Cursor, Write},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;
use vibevalley_server::{
    Server,
    modules::infra::http::{Fetch, FetchError, Request, Response},
};

struct Backend {
    generations: AtomicUsize,
    downloads: AtomicUsize,
    mode: &'static str,
}

impl Backend {
    fn new(mode: &'static str) -> Arc<Self> {
        Arc::new(Self {
            generations: AtomicUsize::new(0),
            downloads: AtomicUsize::new(0),
            mode,
        })
    }
}

struct VendorFetch(Arc<Backend>);

impl Fetch for VendorFetch {
    fn fetch(&self, r: Request) -> Result<Response, FetchError> {
        self.fetch_with_cancel(r, CancellationToken::new())
    }

    fn fetch_with_cancel(&self, _r: Request, cancel: CancellationToken) -> Result<Response, FetchError> {
        self.0.generations.fetch_add(1, Ordering::SeqCst);
        match self.0.mode {
            "wait" => {
                vibevalley_runtime::rt::block_on(cancel.cancelled());
                Err(FetchError::Network("cancelled".into()))
            }
            "reject" => Ok(Response {
                status: 400,
                headers: vec![("content-type".into(), "application/json".into())],
                body: Box::new(Cursor::new(br#"{"error":{"code":"invalid_request"}}"#.to_vec())),
            }),
            "unknown" => Ok(Response {
                status: 503,
                headers: vec![],
                body: Box::new(std::io::empty()),
            }),
            _ => {
                let body = json!({
                    "created": 1,
                    "data": [{ "url": "https://example.com/result.png?signed=secret" }],
                    "usage": { "generated_images": 1, "output_width": 256, "output_height": 256 }
                })
                .to_string()
                .into_bytes();
                Ok(Response {
                    status: 200,
                    headers: vec![("content-type".into(), "application/json".into())],
                    body: Box::new(Cursor::new(body)),
                })
            }
        }
    }
}

struct DownloadFetch(Arc<Backend>);

impl Fetch for DownloadFetch {
    fn fetch(&self, r: Request) -> Result<Response, FetchError> {
        self.fetch_with_cancel(r, CancellationToken::new())
    }

    fn fetch_with_cancel(&self, _r: Request, cancel: CancellationToken) -> Result<Response, FetchError> {
        let n = self.0.downloads.fetch_add(1, Ordering::SeqCst);
        if self.0.mode == "retry" && n == 0 {
            return Ok(Response {
                status: 503,
                headers: vec![],
                body: Box::new(std::io::empty()),
            });
        }
        if self.0.mode == "download-wait" {
            vibevalley_runtime::rt::block_on(cancel.cancelled());
            return Err(FetchError::Network("cancelled".into()));
        }
        Ok(Response {
            status: 200,
            headers: vec![("content-type".into(), "image/png".into())],
            body: Box::new(Cursor::new(png())),
        })
    }
}

fn png() -> Vec<u8> {
    let mut b = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut chunk = |kind: &[u8], data: &[u8]| {
        b.extend_from_slice(&(data.len() as u32).to_be_bytes());
        b.extend_from_slice(kind);
        b.extend_from_slice(data);
        let mut crc = crc32fast::Hasher::new();
        crc.update(kind);
        crc.update(data);
        b.extend_from_slice(&crc.finalize().to_be_bytes());
    };
    let mut header = Vec::new();
    header.extend_from_slice(&256u32.to_be_bytes());
    header.extend_from_slice(&256u32.to_be_bytes());
    header.extend_from_slice(&[8, 2, 0, 0, 0]);
    chunk(b"IHDR", &header);
    let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    z.write_all(&vec![0; (256 * 3 + 1) * 256]).unwrap();
    chunk(b"IDAT", &z.finish().unwrap());
    chunk(b"IEND", &[]);
    b
}

fn start(dir: &std::path::Path, backend: Arc<Backend>) -> vibevalley_server::Started {
    let mut registry = vibevalley_runtime::oar::Registry::new();
    registry.register(Arc::new(vibevalley_runtime::oar::scripted::ScriptedRuntime::demo()));
    let vendor: Arc<dyn Fetch> = Arc::new(VendorFetch(backend.clone()));
    let download: Arc<dyn Fetch> = Arc::new(DownloadFetch(backend));
    let started = vibevalley_server::start(vibevalley_server::ServerConfig {
        registry: Some(Arc::new(registry)),
        media_network: Some((vendor, download)),
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        orchestrator_listens: false,
        watch_pkm: false,
        ..vibevalley_server::ServerConfig::under(dir)
    })
    .unwrap();
    let status = ok(&started, "provider.get", Value::Null);
    if status["image"].is_null() {
        let rev = status["revision"].as_i64().unwrap();
        ok(
            &started,
            "provider.update",
            json!({
                "revision": rev,
                "connections": [{"id":"moss","name":"MOSS","adapter":"moss","enabled":true,"key":"never-persist-this-key"}],
                "image": {"connection":"moss","model":"moss-image-base-1.0"},
                "speech": null,
                "speakers": null,
                "voiceDesign": null,
                "transcription": null,
                "understanding": null,
                "dictation": null,
                "live": null,
                "vision": null,
            }),
        );
    }
    started
}

fn request(id: &str) -> Value {
    json!({"id":id,"prompt":"一只橘猫","format":"text","width":256,"height":256,"enhance":false,"watermark":true})
}

fn ok(s: &vibevalley_server::Started, op: &str, p: Value) -> Value {
    let e = s.hub.call(op, p);
    assert_eq!(e.biz_code, 0, "{}", e.message);
    e.data.unwrap_or(Value::Null)
}

fn wait(s: &vibevalley_server::Started, id: &str, phase: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let j = ok(s, "media.job.get", json!({"id":id}));
        if j["phase"] == phase {
            return j;
        }
        assert!(Instant::now() < deadline, "job did not reach {phase}: {j}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn generation_is_idempotent_download_retries_without_generating_again_and_library_records_result() {
    let dir = tempfile::tempdir().unwrap();
    let backend = Backend::new("retry");
    let s = start(dir.path(), backend.clone());
    ok(&s, "media.image.create", request("one"));
    wait(&s, "one", "download_failed");
    ok(&s, "media.image.create", request("one"));
    let mut changed = request("one");
    changed["prompt"] = json!("different");
    assert_ne!(s.hub.call("media.image.create", changed).biz_code, 0);
    ok(&s, "media.job.download", json!({"id":"one"}));
    let ready = wait(&s, "one", "ready");
    assert_eq!(backend.generations.load(Ordering::SeqCst), 1);
    assert_eq!(backend.downloads.load(Ordering::SeqCst), 2);
    assert_eq!(
        std::fs::read(s.attachments.file(ready["attachment"]["id"].as_str().unwrap()).unwrap().path).unwrap(),
        png()
    );
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let items = ok(&s, "library.item.list", json!({}));
        if items.as_array().unwrap().len() == 1 {
            assert_eq!(items[0]["origin"]["job"], "one");
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(!serde_json::to_string(&ready).unwrap().contains("signed=secret"));
    ok(&s, "library.item.delete", json!({"id": ready["attachment"]["id"]}));
    s.close();
    let reopened = start(dir.path(), backend.clone());
    assert_eq!(wait(&reopened, "one", "ready")["attachment"], ready["attachment"]);
    ok(&reopened, "media.image.create", request("one"));
    assert_eq!(backend.generations.load(Ordering::SeqCst), 1);
    // An explicit deletion is not undone by historical mediaChanged frames.
    std::thread::sleep(Duration::from_millis(30));
    assert_eq!(ok(&reopened, "library.item.list", json!({})), json!([]));
    reopened.close();
    let bytes = std::fs::read(dir.path().join("server.db")).unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("never-persist-this-key"));
}

#[test]
fn cancel_releases_execution_slot_and_admission_is_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let backend = Backend::new("wait");
    let s = start(dir.path(), backend.clone());
    for n in 0..8 {
        ok(&s, "media.image.create", request(&format!("j{n}")));
    }
    wait(&s, "j0", "generating");
    assert_ne!(s.hub.call("media.image.create", request("overflow")).biz_code, 0);
    ok(&s, "media.job.cancel", json!({"id":"j0"}));
    wait(&s, "j1", "generating");
    assert_eq!(wait(&s, "j0", "canceled")["canCancel"], false);
    ok(&s, "media.image.create", request("replacement"));
    let time = Instant::now();
    s.close();
    assert!(time.elapsed() < Duration::from_secs(2));
    let reopened = start(dir.path(), backend);
    wait(&reopened, "j1", "unknown");
    wait(&reopened, "j2", "canceled");
    reopened.close();
}

#[test]
fn canceled_download_can_retry_and_restart_resumes_download_without_regeneration() {
    let dir = tempfile::tempdir().unwrap();
    let backend = Backend::new("download-wait");
    let s = start(dir.path(), backend.clone());
    ok(&s, "media.image.create", request("retry"));
    wait(&s, "retry", "downloading");
    assert_eq!(ok(&s, "media.job.cancel", json!({"id":"retry"}))["canRetryDownload"], true);
    ok(&s, "media.job.download", json!({"id":"retry"}));
    wait(&s, "retry", "downloading");
    s.close();
    let fresh = Backend::new("ok");
    let reopened = start(dir.path(), fresh.clone());
    wait(&reopened, "retry", "ready");
    assert_eq!(fresh.generations.load(Ordering::SeqCst), 0);
    assert_eq!(fresh.downloads.load(Ordering::SeqCst), 1);
    reopened.close();
}

#[test]
fn known_rejections_and_unknown_results_stay_distinct() {
    for (mode, phase) in [("reject", "failed"), ("unknown", "unknown")] {
        let dir = tempfile::tempdir().unwrap();
        let b = Backend::new(mode);
        let s = start(dir.path(), b.clone());
        ok(&s, "media.image.create", request("job"));
        let j = wait(&s, "job", phase);
        assert_eq!(j["canRetryDownload"], false);
        assert_eq!(b.downloads.load(Ordering::SeqCst), 0);
        assert_ne!(s.hub.call("media.job.download", json!({"id":"job"})).biz_code, 0);
        s.close();
    }
}

#[test]
fn image_request_refinements_prevent_submission() {
    let dir = tempfile::tempdir().unwrap();
    let b = Backend::new("ok");
    let s = start(dir.path(), b.clone());
    for (key, value) in [
        ("width", json!(257)),
        ("height", json!(4096)),
        ("steps", json!(0)),
        ("guidance", json!(11)),
        ("prompt", json!(" ")),
    ] {
        let mut r = request("bad");
        r[key] = value;
        assert_ne!(s.hub.call("media.image.create", r).biz_code, 0);
    }
    assert_eq!(b.generations.load(Ordering::SeqCst), 0);
    s.close();
}

#[test]
fn orchestrator_image_tool_requires_user_intent_and_posts_once_to_its_channel() {
    use parking_lot::Mutex;
    use vibevalley_server::modules::team::tool::{Route, held};
    let dir = tempfile::tempdir().unwrap();
    let backend = Backend::new("ok");
    let s = start(dir.path(), backend);
    let channel = s.chat.default_channel();
    let route = Arc::new(Mutex::new(Route {
        agent: "orchestrator".into(),
        channel: channel.clone(),
        ..Route::default()
    }));
    let tools = held(&s.farm, &route);
    let tool = tools.iter().find(|t| t.spec().name == "media_image_create").unwrap();
    assert!(tool.execute(&request("asked")).is_error);
    assert_eq!(ok(&s, "media.job.list", Value::Null), json!([]));
    route.lock().user = true;
    let result = tool.execute(&request("asked"));
    assert!(!result.is_error, "{}", result.text);
    let ready = wait(&s, "asked", "ready");
    assert_eq!(ready["source"], json!({"kind":"orchestrator","agent":"orchestrator","channel":channel}));
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let messages = ok(&s, "channel.message.list", json!({"id":channel}));
        let made = messages
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["attachments"].as_array().is_some_and(|a| !a.is_empty()))
            .count();
        if made == 1 {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(!tool.execute(&request("asked")).is_error);
    s.close();
    let reopened = start(dir.path(), Backend::new("ok"));
    let messages = ok(&reopened, "channel.message.list", json!({"id":channel}));
    assert_eq!(
        messages
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["attachments"].as_array().is_some_and(|a| !a.is_empty()))
            .count(),
        1
    );
    reopened.close();
}
