//! Integration tests for the pluggable [`StorageBackend`] layer (`LocalFsBackend`,
//! `MemoryBackend`, `S3Backend` over an in-process SigV4-verifying mock HTTP S3 server),
//! read-through attachment/media caching, note remote mirroring, and `create_app_with_storage`.

use std::collections::{BTreeMap, HashMap};
use std::io::Cursor;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use base64::Engine as _;
use jiff::Timestamp;
use parking_lot::RwLock;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio_util::sync::{CancellationToken, DropGuard};
use vibevalley_protocol::{AttachmentUpload, MediaInputPhase, MediaInputRequest, NoteFileEncoding, NoteFileWriteItem, NoteType};
use vibevalley_server::Config;
use vibevalley_server::app::create_app_with_storage;
use vibevalley_server::context::{Context, Http, LiveState, Outbox, PublicDownload, StateFeed, TaskGroup};
use vibevalley_server::service::Service;
use vibevalley_server::setting::Secret;
use vibevalley_server::storage::Storage;
use vibevalley_server::storage::backend::{
    LocalFsBackend, MemoryBackend, S3Backend, S3Config, StorageBackend, StorageConfig, StorageError, StorageKind, presign_v4_get, sign_v4_request,
};

const TEST_BUCKET: &str = "vv-test-bucket";
const TEST_REGION: &str = "us-east-1";
const TEST_ACCESS_KEY: &str = "AKIAVVTEST00000001";
const TEST_SECRET_KEY: &str = "vv-mock-s3-secret-key-do-not-leak-7788";

#[derive(Clone)]
struct MockObject {
    bytes: Vec<u8>,
    content_type: String,
    etag: String,
}

struct MockS3State {
    host: String,
    objects: RwLock<BTreeMap<String, MockObject>>,
    get_count: AtomicUsize,
    put_count: AtomicUsize,
    head_count: AtomicUsize,
    list_count: AtomicUsize,
    page_size: usize,
}

struct MockS3Server {
    endpoint: String,
    state: Arc<MockS3State>,
    _shutdown: DropGuard,
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn parse_amz_date(raw: &str) -> Option<Timestamp> {
    if raw.len() != 16 {
        return None;
    }
    let iso = format!(
        "{}-{}-{}T{}:{}:{}Z",
        &raw[0..4],
        &raw[4..6],
        &raw[6..8],
        &raw[9..11],
        &raw[11..13],
        &raw[13..15]
    );
    iso.parse::<Timestamp>().ok()
}

fn verify_sigv4_header(state: &MockS3State, method: &str, canonical_uri: &str, query_params: &[(String, String)], headers: &HeaderMap, body: &[u8]) -> bool {
    let Some(auth) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let Some(amz_date) = headers.get("x-amz-date").and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let Some(payload_hash) = headers.get("x-amz-content-sha256").and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let Some(ts) = parse_amz_date(amz_date) else {
        return false;
    };
    if payload_hash != sha256_hex(body) {
        return false;
    }
    let mut extra: Vec<(&str, &str)> = Vec::new();
    if let Some(ct) = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok())
        && auth.contains("content-type")
    {
        extra.push(("content-type", ct));
    }
    let expected = sign_v4_request(
        method,
        canonical_uri,
        query_params,
        &state.host,
        &extra,
        payload_hash,
        TEST_ACCESS_KEY,
        &Secret::new(TEST_SECRET_KEY),
        TEST_REGION,
        ts,
    );
    auth == expected.authorization
}

fn verify_presigned_query(state: &MockS3State, canonical_uri: &str, query: &HashMap<String, String>) -> bool {
    let Some(amz_date) = query.get("X-Amz-Date") else {
        return false;
    };
    let Some(expires) = query.get("X-Amz-Expires").and_then(|s| s.parse::<u64>().ok()) else {
        return false;
    };
    let Some(sig) = query.get("X-Amz-Signature") else {
        return false;
    };
    let Some(ts) = parse_amz_date(amz_date) else {
        return false;
    };
    let expected_url = presign_v4_get(
        "http",
        &state.host,
        canonical_uri,
        TEST_ACCESS_KEY,
        &Secret::new(TEST_SECRET_KEY),
        TEST_REGION,
        ts,
        expires,
    );
    expected_url.ends_with(&format!("&X-Amz-Signature={sig}"))
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

async fn mock_list_bucket(
    State(state): State<Arc<MockS3State>>,
    AxumPath(bucket): AxumPath<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if bucket != TEST_BUCKET {
        return (StatusCode::NOT_FOUND, "<Error><Code>NoSuchBucket</Code></Error>").into_response();
    }
    let canonical_uri = format!("/{bucket}");
    let query_vec: Vec<(String, String)> = query.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    if !verify_sigv4_header(&state, "GET", &canonical_uri, &query_vec, &headers, b"") {
        return (StatusCode::FORBIDDEN, "<Error><Code>SignatureDoesNotMatch</Code></Error>").into_response();
    }
    state.list_count.fetch_add(1, Ordering::Relaxed);

    let prefix = query.get("prefix").map(String::as_str).unwrap_or("");
    let start_offset = query
        .get("continuation-token")
        .and_then(|t| t.strip_prefix("offset:"))
        .and_then(|n| n.parse::<usize>().ok())
        .unwrap_or(0);

    let matched: Vec<(String, MockObject)> = state
        .objects
        .read()
        .iter()
        .filter(|(k, _)| k.starts_with(prefix))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    let end = (start_offset + state.page_size).min(matched.len());
    let is_truncated = end < matched.len();
    let page = if start_offset < matched.len() { &matched[start_offset..end] } else { &[] };

    let mut xml = String::from(r#"<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>"#);
    xml.push_str(&format!("<IsTruncated>{}</IsTruncated>", if is_truncated { "true" } else { "false" }));
    if is_truncated {
        xml.push_str(&format!("<NextContinuationToken>offset:{end}</NextContinuationToken>"));
    }
    for (key, obj) in page {
        xml.push_str("<Contents>");
        xml.push_str(&format!("<Key>{}</Key>", xml_escape(key)));
        xml.push_str("<LastModified>2026-11-26T12:00:00.000Z</LastModified>");
        xml.push_str(&format!("<ETag>&quot;{}&quot;</ETag>", obj.etag));
        xml.push_str(&format!("<Size>{}</Size>", obj.bytes.len()));
        xml.push_str("</Contents>");
    }
    xml.push_str("</ListBucketResult>");
    (StatusCode::OK, [(header::CONTENT_TYPE, "application/xml")], xml).into_response()
}

async fn mock_get_object(
    State(state): State<Arc<MockS3State>>,
    AxumPath((bucket, key)): AxumPath<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if bucket != TEST_BUCKET {
        return StatusCode::NOT_FOUND.into_response();
    }
    let canonical_uri = format!("/{bucket}/{key}");
    let authed = if query.contains_key("X-Amz-Signature") {
        verify_presigned_query(&state, &canonical_uri, &query)
    } else {
        verify_sigv4_header(&state, "GET", &canonical_uri, &[], &headers, b"")
    };
    if !authed {
        return (StatusCode::FORBIDDEN, "<Error><Code>SignatureDoesNotMatch</Code></Error>").into_response();
    }
    state.get_count.fetch_add(1, Ordering::Relaxed);
    let Some(obj) = state.objects.read().get(&key).cloned() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut resp = Response::new(axum::body::Body::from(obj.bytes));
    resp.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_str(&obj.content_type).unwrap());
    resp.headers_mut()
        .insert(header::ETAG, HeaderValue::from_str(&format!("\"{}\"", obj.etag)).unwrap());
    resp
}

async fn mock_head_object(State(state): State<Arc<MockS3State>>, AxumPath((bucket, key)): AxumPath<(String, String)>, headers: HeaderMap) -> Response {
    if bucket != TEST_BUCKET {
        return StatusCode::NOT_FOUND.into_response();
    }
    let canonical_uri = format!("/{bucket}/{key}");
    if !verify_sigv4_header(&state, "HEAD", &canonical_uri, &[], &headers, b"") {
        return StatusCode::FORBIDDEN.into_response();
    }
    state.head_count.fetch_add(1, Ordering::Relaxed);
    let Some(obj) = state.objects.read().get(&key).cloned() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut resp = StatusCode::OK.into_response();
    resp.headers_mut()
        .insert(header::CONTENT_LENGTH, HeaderValue::from_str(&obj.bytes.len().to_string()).unwrap());
    resp.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_str(&obj.content_type).unwrap());
    resp.headers_mut()
        .insert(header::ETAG, HeaderValue::from_str(&format!("\"{}\"", obj.etag)).unwrap());
    resp
}

async fn mock_put_object(
    State(state): State<Arc<MockS3State>>,
    AxumPath((bucket, key)): AxumPath<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if bucket != TEST_BUCKET {
        return StatusCode::NOT_FOUND.into_response();
    }
    let canonical_uri = format!("/{bucket}/{key}");
    if !verify_sigv4_header(&state, "PUT", &canonical_uri, &[], &headers, &body) {
        return (StatusCode::FORBIDDEN, "<Error><Code>SignatureDoesNotMatch</Code></Error>").into_response();
    }
    state.put_count.fetch_add(1, Ordering::Relaxed);
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    let etag = sha256_hex(&body);
    state.objects.write().insert(
        key,
        MockObject {
            bytes: body.to_vec(),
            content_type,
            etag: etag.clone(),
        },
    );
    let mut resp = StatusCode::OK.into_response();
    resp.headers_mut().insert(header::ETAG, HeaderValue::from_str(&format!("\"{etag}\"")).unwrap());
    resp
}

async fn mock_delete_object(State(state): State<Arc<MockS3State>>, AxumPath((bucket, key)): AxumPath<(String, String)>, headers: HeaderMap) -> Response {
    if bucket != TEST_BUCKET {
        return StatusCode::NOT_FOUND.into_response();
    }
    let canonical_uri = format!("/{bucket}/{key}");
    if !verify_sigv4_header(&state, "DELETE", &canonical_uri, &[], &headers, b"") {
        return StatusCode::FORBIDDEN.into_response();
    }
    if state.objects.write().remove(&key).is_some() {
        StatusCode::NO_CONTENT.into_response()
    } else {
        StatusCode::NOT_FOUND.into_response()
    }
}

impl MockS3Server {
    async fn start(page_size: usize) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind mock s3");
        let addr = listener.local_addr().expect("local addr");
        let host = format!("127.0.0.1:{}", addr.port());
        let endpoint = format!("http://{host}");
        let state = Arc::new(MockS3State {
            host,
            objects: RwLock::new(BTreeMap::new()),
            get_count: AtomicUsize::new(0),
            put_count: AtomicUsize::new(0),
            head_count: AtomicUsize::new(0),
            list_count: AtomicUsize::new(0),
            page_size,
        });
        let router = Router::new()
            .route("/{bucket}", get(mock_list_bucket))
            .route(
                "/{bucket}/{*key}",
                get(mock_get_object).head(mock_head_object).put(mock_put_object).delete(mock_delete_object),
            )
            .with_state(state.clone());

        let cancel = CancellationToken::new();
        let shutdown = cancel.clone();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async move { shutdown.cancelled().await })
                .await;
        });

        Self {
            endpoint,
            state,
            _shutdown: cancel.drop_guard(),
        }
    }

    fn s3_config(&self, prefix: Option<&str>) -> S3Config {
        S3Config {
            bucket: TEST_BUCKET.into(),
            region: TEST_REGION.into(),
            endpoint: Some(self.endpoint.clone()),
            prefix: prefix.map(str::to_owned),
            path_style: true,
            access_key_id: TEST_ACCESS_KEY.into(),
            secret_access_key: Secret::new(TEST_SECRET_KEY),
        }
    }
}

async fn assert_backend_contract(backend: &dyn StorageBackend) {
    assert!(backend.get("attachments/none").await.unwrap().is_none());
    assert!(backend.head("attachments/none").await.unwrap().is_none());
    assert!(!backend.exists("attachments/none").await.unwrap());
    assert!(!backend.delete("attachments/none").await.unwrap());

    let meta = backend.put("attachments/k2", b"second".to_vec(), Some("text/plain")).await.unwrap();
    assert_eq!(meta.key, "attachments/k2");
    assert_eq!(meta.size, 6);

    backend.put("attachments/k1", b"first".to_vec(), Some("text/plain")).await.unwrap();
    backend
        .put("attachments/k3", b"third".to_vec(), Some("application/octet-stream"))
        .await
        .unwrap();
    backend
        .put("note/n1/structure/doc.json", b"{}".to_vec(), Some("application/json"))
        .await
        .unwrap();

    assert_eq!(backend.get("attachments/k1").await.unwrap(), Some(b"first".to_vec()));
    let head = backend.head("attachments/k2").await.unwrap().expect("head k2");
    assert_eq!(head.size, 6);
    assert!(backend.exists("attachments/k3").await.unwrap());

    let att_list = backend.list("attachments/").await.unwrap();
    let att_keys: Vec<&str> = att_list.iter().map(|m| m.key.as_str()).collect();
    assert_eq!(att_keys, vec!["attachments/k1", "attachments/k2", "attachments/k3"]);

    let all_list = backend.list("").await.unwrap();
    let all_keys: Vec<&str> = all_list.iter().map(|m| m.key.as_str()).collect();
    assert_eq!(
        all_keys,
        vec!["attachments/k1", "attachments/k2", "attachments/k3", "note/n1/structure/doc.json",]
    );

    // Overwrite works cleanly.
    backend.put("attachments/k1", b"updated".to_vec(), Some("text/plain")).await.unwrap();
    assert_eq!(backend.get("attachments/k1").await.unwrap(), Some(b"updated".to_vec()));

    assert!(backend.delete("attachments/k2").await.unwrap());
    assert!(!backend.exists("attachments/k2").await.unwrap());

    // Traversal rejected identically across every backend.
    for bad in ["../escape", "/abs/path", "a\\b", "a//b", "a/b\0c"] {
        assert!(matches!(backend.put(bad, b"x".to_vec(), None).await, Err(StorageError::InvalidKey { .. })));
        assert!(matches!(backend.get(bad).await, Err(StorageError::InvalidKey { .. })));
    }
}

async fn test_ctx(home: &Path) -> Arc<Context> {
    let service = Service::open(home).await.expect("open service");
    Arc::new(Context::new(
        service.clone(),
        TaskGroup::new(),
        Arc::new(LiveState::new()),
        Arc::new(Outbox::new(service)),
        Arc::new(StateFeed::new()),
        vibevalley_core::system_clock(),
        Arc::new(Http),
        Arc::new(PublicDownload),
    ))
}

#[tokio::test]
async fn all_storage_backends_satisfy_shared_contract() {
    let dir = tempfile::tempdir().unwrap();
    let local = LocalFsBackend::new(dir.path());
    assert_eq!(local.kind(), StorageKind::LocalFs);
    assert_backend_contract(&local).await;

    let memory = MemoryBackend::new();
    assert_eq!(memory.kind(), StorageKind::Memory);
    assert_backend_contract(&memory).await;

    // Mock S3 with page_size=2 to force multi-page ListObjectsV2 continuation tokens!
    let mock = MockS3Server::start(2).await;
    let s3 = S3Backend::new(mock.s3_config(Some("tenant-1"))).unwrap();
    assert_eq!(s3.kind(), StorageKind::S3);
    assert_backend_contract(&s3).await;
    assert!(mock.state.list_count.load(Ordering::Relaxed) >= 3, "expected paginated list requests");
}

#[tokio::test]
async fn s3_backend_presigned_url_download_and_invalid_signature_rejection() {
    let mock = MockS3Server::start(10).await;
    let s3 = S3Backend::new(mock.s3_config(Some("farm"))).unwrap();

    let payload = b"presigned-payload-bytes-42";
    s3.put("attachments/sample.bin", payload.to_vec(), Some("application/octet-stream"))
        .await
        .unwrap();

    let url = s3.signed_url("attachments/sample.bin", 120).expect("presigned URL");
    let resp = reqwest::get(&url).await.expect("presigned GET");
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(resp.bytes().await.unwrap().as_ref(), payload);

    // Wrong secret key is rejected by SigV4 verification with HTTP 403.
    let mut bad_cfg = mock.s3_config(Some("farm"));
    bad_cfg.secret_access_key = Secret::new("wrong-secret-key");
    let bad_s3 = S3Backend::new(bad_cfg).unwrap();
    let err = bad_s3.get("attachments/sample.bin").await.unwrap_err();
    assert!(matches!(err, StorageError::Http { status: 403, .. }), "expected 403, got {err:?}");
}

#[tokio::test]
async fn s3_storage_attachment_read_through_cache_media_inputs_and_artifact_mirror() {
    let dir = tempfile::tempdir().unwrap();
    let mock = MockS3Server::start(2).await;
    let ctx = test_ctx(dir.path()).await;

    let cfg = StorageConfig::S3(mock.s3_config(Some("space-a")));
    let storage = Storage::open_with_config_async(dir.path(), &cfg, ctx.clone()).await.unwrap();
    assert_eq!(storage.backend_kind(), StorageKind::S3);

    // 1. Upload CAS attachment -> stored in S3 under `space-a/attachments/<sha256>`, not in `<home>/attachments/`.
    let png_bytes = b"\x89PNG\r\n\x1a\n0123456789abcdef".to_vec();
    let att = storage
        .attach_async(AttachmentUpload {
            name: "hero.png".into(),
            r#type: "image/png".into(),
            data: base64::engine::general_purpose::STANDARD.encode(&png_bytes),
        })
        .await
        .unwrap();
    assert!(!dir.path().join("attachments").join(&att.id).exists());
    assert!(mock.state.objects.read().contains_key(&format!("space-a/attachments/{}", att.id)));

    // 2. First `file_async` fetches from S3 and populates the local read-through cache.
    assert_eq!(mock.state.get_count.load(Ordering::Relaxed), 0);
    let file1 = storage.file_async(&att.id).await.unwrap();
    assert_eq!(mock.state.get_count.load(Ordering::Relaxed), 1);
    assert!(Path::new(&file1.path).is_file());
    assert_eq!(std::fs::read(&file1.path).unwrap(), png_bytes);

    // 3. Second `file_async` and `read_bytes_async` hit the local read-through cache (zero extra S3 GETs!).
    let file2 = storage.file_async(&att.id).await.unwrap();
    assert_eq!(file2.path, file1.path);
    assert_eq!(mock.state.get_count.load(Ordering::Relaxed), 1);

    let (mime, read_back) = storage.read_bytes_async(&att.id).await.unwrap();
    assert_eq!(mime, "image/png");
    assert_eq!(read_back, png_bytes);
    assert_eq!(mock.state.get_count.load(Ordering::Relaxed), 1);

    // 4. Presigned attachment URL works directly over HTTP.
    let presigned = storage.signed_attachment_url(&att.id, 60).expect("signed attachment url");
    let dl = reqwest::get(&presigned).await.unwrap();
    assert_eq!(dl.status(), StatusCode::OK);
    assert_eq!(dl.bytes().await.unwrap().as_ref(), png_bytes.as_slice());

    // 5. MediaInputStorage works seamlessly over S3Backend (upload -> pin -> content_async).
    let req: MediaInputRequest = serde_json::from_value(json!({
        "kind": "image",
        "mime": "image/png",
        "name": "input.png",
        "size": png_bytes.len()
    }))
    .unwrap();
    let reserved = storage.create_input_async(&req).await.unwrap();
    let ready = storage
        .upload_input_async(&reserved.id, Box::new(Cursor::new(png_bytes.clone())))
        .await
        .unwrap();
    assert_eq!(ready.phase, MediaInputPhase::Ready);
    storage.pin_inputs_async(std::slice::from_ref(&ready.id), "job-s3").await.unwrap();
    let media_file = storage.input_content_async(&ready.id).await.unwrap();
    assert_eq!(std::fs::read(&media_file.path).unwrap(), png_bytes);
    storage.release_input_pins_async("job-s3").await.unwrap();

    // 6. NoteStorage mirrors files + version snapshots to S3 and restores cleanly after local wipe.
    let (_metas, _raw) = storage.note.init_directory_async("note-1", NoteType::Doc, "Spec", None, &[]).await.unwrap();
    storage
        .note
        .write_files_async(
            "note-1",
            NoteType::Doc,
            "Spec",
            &[NoteFileWriteItem {
                path: "structure/notes.md".into(),
                content: "# Mirrored to S3\n".into(),
                encoding: Some(NoteFileEncoding::Utf8),
                mime: None,
                expected_hash: None,
            }],
        )
        .await
        .unwrap();
    let (snap_id, _) = storage.note.snapshot_version_async("note-1").await.unwrap();

    // Wipe local note dir and restore from S3 backend.
    std::fs::remove_dir_all(storage.note.note_dir("note-1")).unwrap();
    assert!(!storage.note.note_dir("note-1").exists());
    let restored_count = storage.note.restore_from_backend_async("note-1", None).await.unwrap();
    assert!(restored_count >= 2);
    let restored_note = storage.note.read_file_async("note-1", "Spec", "structure/notes.md", None).await.unwrap();
    assert_eq!(restored_note.content, "# Mirrored to S3\n");

    // Wipe local snapshot dir and restore snapshot from S3 backend.
    std::fs::remove_dir_all(storage.note.snapshot_dir("note-1", &snap_id)).unwrap();
    let restored_snap = storage.note.restore_from_backend_async("note-1", Some(&snap_id)).await.unwrap();
    assert!(restored_snap >= 2);
    let snap_note = storage
        .note
        .read_file_async("note-1", "Spec", "structure/notes.md", Some(&snap_id))
        .await
        .unwrap();
    assert_eq!(snap_note.content, "# Mirrored to S3\n");

    storage.close_async().await;
    ctx.shutdown(Duration::from_secs(2)).await;
    ctx.service.close().await;
}

#[tokio::test]
async fn create_app_with_storage_boots_cleanly_on_memory_backend() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = Config::under(dir.path());
    cfg.probe_runtimes = false;
    cfg.tick_crons = false;
    cfg.link_previews = false;
    cfg.orchestrator_listens = false;

    let app = create_app_with_storage(cfg, StorageConfig::Memory).await.expect("boot app with memory storage");
    let internals = app.test_internals();
    assert_eq!(internals.storage.backend_kind(), StorageKind::Memory);

    let att = internals
        .storage
        .keep_async(b"memory-backed-blob".to_vec(), "memo.txt".into(), "text/plain".into())
        .await
        .unwrap();
    let local_file = internals.storage.file_async(&att.id).await.unwrap();
    assert_eq!(std::fs::read(&local_file.path).unwrap(), b"memory-backed-blob");

    app.close().await;
}
