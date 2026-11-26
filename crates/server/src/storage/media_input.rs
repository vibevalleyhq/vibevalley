//! Staged media input reservations, streaming uploads, TTL sweep, and job pins.
//! The async mutex protects admission and pins, never a streaming read or CAS promotion.

use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex as SyncMutex;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex as AsyncMutex;
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, AttachmentFile, BizCode, MediaInput, MediaInputKind, MediaInputPhase, MediaInputRequest, Preview};

use super::attachment::AttachmentStorage;
use super::validate;
use crate::context::{Context, Ticker};
use crate::log::spawn_blocking_traced;
use crate::service::Tx;

const LIFETIME: i64 = 86_400_000;
const QUOTA_BYTES: i64 = 2 * 1024 * 1024 * 1024;
const QUOTA_ENTRIES: i64 = 256;

fn refused(key: &str) -> ApiError {
    ApiError::new(BizCode::MediaRefused, t(&format!("server.media.{key}"), &[]))
}

fn storage(_: impl std::fmt::Display) -> ApiError {
    refused("inputStorage")
}

struct Inner {
    uploading: HashSet<String>,
}

/// Manages temporary staged media inputs, quota enforcement, expiration sweeps, and job pins.
pub struct MediaInputStorage {
    ctx: Arc<Context>,
    inner: AsyncMutex<Inner>,
    attachment: Arc<AttachmentStorage>,
    staging: PathBuf,
    sweeper: SyncMutex<Option<Ticker>>,
}

fn stage_upload_blocking(path: &Path, file: tokio::fs::File, r: &MediaInput, mut source: Box<dyn Read + Send>) -> Result<(PathBuf, String), ApiError> {
    let mut file = file.try_into_std().map_err(|_| storage("media staging file busy"))?;
    let mut buffer = [0u8; 64 * 1024];
    let mut hash = Sha256::new();
    let mut size = 0i64;
    let mut prefix = Vec::with_capacity(16);
    let start = Instant::now();
    loop {
        if start.elapsed() > Duration::from_secs(300) {
            return Err(refused("inputTimeout"));
        }
        let n = source.read(&mut buffer).map_err(|e| {
            if e.kind() == std::io::ErrorKind::TimedOut {
                refused("inputTimeout")
            } else {
                refused("inputDisconnected")
            }
        })?;
        if n == 0 {
            break;
        }
        size += n as i64;
        if size > r.size {
            return Err(refused("inputInvalid"));
        }
        prefix.extend_from_slice(&buffer[..n.min(16 - prefix.len())]);
        if prefix.len() == 16 && !validate::container(&r.mime, &prefix) {
            return Err(refused("inputInvalid"));
        }
        hash.update(&buffer[..n]);
        file.write_all(&buffer[..n]).map_err(storage)?;
    }
    if size != r.size || !validate::container(&r.mime, &prefix) {
        return Err(refused("inputInvalid"));
    }
    file.sync_all().map_err(storage)?;
    drop(file);
    let hash = hash.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>();
    if r.hash.as_ref().is_some_and(|h| h != &hash) {
        return Err(refused("inputChanged"));
    }
    Ok((path.to_path_buf(), hash))
}

async fn verify_content_async(path: &Path, expected_size: u64, expected_hash: &str) -> Result<(), ApiError> {
    let mut f = tokio::fs::File::open(path).await.map_err(storage)?;
    let mut digest = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = tokio::io::AsyncReadExt::read(&mut f, &mut buffer).await.map_err(storage)?;
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > expected_size {
            return Err(refused("inputChanged"));
        }
        digest.update(&buffer[..n]);
    }
    if size != expected_size || digest.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>() != expected_hash {
        return Err(refused("inputChanged"));
    }
    Ok(())
}

impl MediaInputStorage {
    pub async fn open_async(home: &Path, ctx: Arc<Context>, attachment: Arc<AttachmentStorage>) -> Result<Arc<Self>, ApiError> {
        let inputs = Arc::new(Self {
            ctx: ctx.clone(),
            inner: AsyncMutex::new(Inner { uploading: HashSet::new() }),
            attachment,
            staging: home.join("attachments/.staging/media"),
            sweeper: SyncMutex::new(None),
        });
        inputs.restore_async().await?;
        inputs.sweep_async().await?;
        inputs.start_sweeper();
        Ok(inputs)
    }

    fn start_sweeper(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        let ticker = self.ctx.every("storage.media_input.sweep", Duration::from_secs(60), move || {
            let weak = weak.clone();
            async move {
                let Some(inputs) = weak.upgrade() else { return false };
                // Tombstones survive storage failures and are retried next tick.
                if let Err(error) = inputs.sweep_async().await {
                    eprintln!("media input cleanup: {}", error.message);
                }
                true
            }
        });
        *self.sweeper.lock() = Some(ticker);
    }

    pub async fn close_async(&self) {
        let ticker = self.sweeper.lock().take();
        if let Some(ticker) = ticker {
            ticker.stop().await;
        }
    }

    async fn find_read(&self, inner: &Inner, id: &str) -> Result<Option<MediaInput>, ApiError> {
        let mut record = self.ctx.service.storage.find_media_input(id).await.map_err(storage)?;
        if let Some(r) = &mut record {
            r.can_delete &= !inner.uploading.contains(id);
        }
        Ok(record)
    }

    async fn found_read(&self, inner: &Inner, id: &str) -> Result<MediaInput, ApiError> {
        self.find_read(inner, id).await?.ok_or_else(|| refused("inputMissing"))
    }

    async fn find_write(&self, inner: &Inner, id: &str) -> Result<Option<MediaInput>, ApiError> {
        let mut record = self.ctx.service.storage.find_media_input_write(id).await.map_err(storage)?;
        if let Some(r) = &mut record {
            r.can_delete &= !inner.uploading.contains(id);
        }
        Ok(record)
    }

    async fn found_write(&self, inner: &Inner, id: &str) -> Result<MediaInput, ApiError> {
        self.find_write(inner, id).await?.ok_or_else(|| refused("inputMissing"))
    }

    pub async fn get_async(&self, id: &str) -> Result<MediaInput, ApiError> {
        let inner = self.inner.lock().await;
        self.found_read(&inner, id).await
    }

    pub async fn list_async(&self) -> Result<Vec<MediaInput>, ApiError> {
        let uploading = self.inner.lock().await.uploading.clone();
        let mut rows = self.ctx.service.storage.list_media_inputs().await.map_err(storage)?;
        for r in &mut rows {
            r.can_delete &= !uploading.contains(&r.id);
        }
        Ok(rows)
    }

    pub async fn create_async(&self, r: &MediaInputRequest) -> Result<MediaInput, ApiError> {
        validate::declared(r)?;
        self.sweep_async().await?;
        let id = uuid::Uuid::now_v7().to_string();
        let time = self.ctx.now();
        let _inner = self.inner.lock().await;
        self.ctx
            .service
            .storage
            .reserve_media_input(&id, r, time, time + LIFETIME, QUOTA_ENTRIES, QUOTA_BYTES)
            .await
            .map_err(storage)?
            .ok_or_else(|| refused("inputQuota"))
    }

    async fn remove_async(&self, r: &MediaInput) -> Result<(), ApiError> {
        if !r.can_delete {
            return Err(refused("inputBusy"));
        }
        let marked = self.ctx.service.storage.mark_media_input_deleting_if_unpinned(&r.id).await.map_err(storage)?;
        if !marked {
            return Err(refused("inputBusy"));
        }
        remove_dir_async(self.staging.join(&r.id)).await?;
        self.ctx.service.storage.delete_media_input(&r.id).await.map_err(storage)?;
        Ok(())
    }

    pub async fn delete_async(&self, id: &str) -> Result<(), ApiError> {
        let inner = self.inner.lock().await;
        if let Some(r) = self.find_write(&inner, id).await? {
            self.remove_async(&r).await?;
        }
        Ok(())
    }

    pub async fn preview_delete_async(&self, id: &str) -> Result<Preview, ApiError> {
        let inner = self.inner.lock().await;
        let Some(r) = self.find_read(&inner, id).await? else {
            return Ok(Preview { does: vec![] });
        };
        if !r.can_delete {
            return Err(refused("inputBusy"));
        }
        Ok(Preview {
            does: vec![t("server.media.inputDeletePreview", &[("name", r.name.into())])],
        })
    }

    pub async fn sweep_async(&self) -> Result<(), ApiError> {
        let inner = self.inner.lock().await;
        let ids = self.ctx.service.storage.list_sweepable_media_input_ids(self.ctx.now()).await.map_err(storage)?;
        for id in ids {
            let r = self.found_write(&inner, &id).await?;
            if r.can_delete
                && let Err(error) = self.remove_async(&r).await
            {
                eprintln!("media input cleanup pending for {id}: {}", error.message);
            }
        }
        Ok(())
    }

    async fn restore_async(&self) -> Result<(), ApiError> {
        let _inner = self.inner.lock().await;
        remove_dir_async(self.staging.clone()).await?;
        self.ctx.service.storage.fail_uploading_media_inputs().await.map_err(storage)?;
        let rows = self.ctx.service.storage.list_media_inputs_write().await.map_err(storage)?;
        for r in rows {
            if r.phase == MediaInputPhase::Ready {
                let exists = match r.hash.as_ref() {
                    Some(h) => self.attachment.exists_blob_async(h).await,
                    None => false,
                };
                if !exists {
                    self.ctx
                        .service
                        .storage
                        .set_media_input_phase(&r.id, MediaInputPhase::Failed)
                        .await
                        .map_err(storage)?;
                }
            }
        }
        Ok(())
    }

    /// Streams bounded chunks into a private file; only a complete verified file is promoted.
    pub async fn upload_async(&self, id: &str, source: Box<dyn Read + Send>) -> Result<MediaInput, ApiError> {
        let r = {
            let mut inner = self.inner.lock().await;
            let r = self.found_write(&inner, id).await?;
            if r.phase == MediaInputPhase::Ready {
                return Ok(r);
            }
            if r.phase == MediaInputPhase::Deleting || inner.uploading.contains(id) || r.expires_at <= self.ctx.now() || inner.uploading.len() >= 8 {
                return Err(refused("inputBusy"));
            }
            remove_dir_async(self.staging.join(id)).await?;
            self.ctx
                .service
                .storage
                .set_media_input_phase(id, MediaInputPhase::Uploading)
                .await
                .map_err(storage)?;
            inner.uploading.insert(id.to_owned());
            r
        };
        let result = self.upload_inner_async(&r, source).await;
        // Always release the upload slot even when staging or promotion fails.
        let cleanup = remove_dir_async(self.staging.join(id)).await;
        let mut inner = self.inner.lock().await;
        inner.uploading.remove(id);
        if result.is_err() {
            self.ctx
                .service
                .storage
                .set_media_input_phase(id, MediaInputPhase::Failed)
                .await
                .map_err(storage)?;
        }
        result?;
        if let Err(error) = cleanup {
            eprintln!("media staging cleanup: {}", error.message);
        }
        self.found_write(&inner, id).await
    }

    async fn upload_inner_async(&self, r: &MediaInput, source: Box<dyn Read + Send>) -> Result<(), ApiError> {
        let directory = self.staging.join(&r.id);
        tokio::fs::create_dir_all(&directory).await.map_err(storage)?;
        let stage_path = directory.join("content");
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            options.mode(0o600);
        }
        let file = options.open(&stage_path).await.map_err(storage)?;
        let record = r.clone();
        let stage_path_owned = stage_path.clone();
        let (path, hash) = spawn_blocking_traced(move || stage_upload_blocking(&stage_path_owned, file, &record, source))
            .await
            .map_err(storage)??;
        if r.kind == MediaInputKind::Audio {
            validate::audio_async(&path, &r.mime).await?;
        }
        {
            let _inner = self.inner.lock().await;
            self.ctx.service.storage.set_media_input_hash(&r.id, &hash).await.map_err(storage)?;
        }
        self.attachment.keep_staged_async(path, hash, r.size, r.name.clone(), r.mime.clone()).await?;
        {
            let _inner = self.inner.lock().await;
            self.ctx
                .service
                .storage
                .mark_media_input_ready(&r.id, self.ctx.now() + LIFETIME)
                .await
                .map_err(storage)?;
        }
        Ok(())
    }

    pub async fn adopt_async(&self, id: &str) -> Result<MediaInput, ApiError> {
        let files = self.attachment.of_async(&[id.to_owned()]).await.map_err(|_| refused("inputInvalid"))?;
        let file = &files[0];
        let kind = match file.r#type.split('/').next() {
            Some("image") => MediaInputKind::Image,
            Some("video") => MediaInputKind::Video,
            Some("audio") => MediaInputKind::Audio,
            _ => return Err(refused("inputInvalid")),
        };
        let r = self
            .create_async(&MediaInputRequest {
                kind,
                name: file.name.clone(),
                mime: file.r#type.clone(),
                size: file.size,
            })
            .await?;
        let source_path = self.attachment.materialize_local_async(id).await.map_err(|_| refused("inputInvalid"))?;
        let opened = tokio::fs::File::open(&source_path).await.map_err(storage)?.into_std().await;
        self.upload_async(&r.id, Box::new(opened)).await
    }

    pub async fn upload_file_async(&self, id: &str, path: PathBuf) -> Result<MediaInput, ApiError> {
        if !path.is_absolute() {
            return Err(refused("inputInvalid"));
        }
        if !tokio::fs::metadata(&path).await.map_err(storage)?.is_file() {
            return Err(refused("inputInvalid"));
        }
        let file = tokio::fs::File::open(&path).await.map_err(storage)?;
        let metadata = file.metadata().await.map_err(storage)?;
        if !metadata.is_file() {
            return Err(refused("inputInvalid"));
        }
        let file_len = metadata.len();
        if file_len != self.get_async(id).await?.size as u64 {
            return Err(refused("inputInvalid"));
        }
        self.upload_async(id, Box::new(file.into_std().await)).await
    }

    pub async fn content_async(&self, id: &str) -> Result<AttachmentFile, ApiError> {
        let r = self.get_async(id).await?;
        if r.phase != MediaInputPhase::Ready || (r.can_delete && r.expires_at <= self.ctx.now()) {
            return Err(refused("inputMissing"));
        }
        let hash = r.hash.clone().ok_or_else(|| refused("inputMissing"))?;
        let path = self.attachment.materialize_local_async(&hash).await.map_err(|_| refused("inputMissing"))?;
        verify_content_async(&path, r.size as u64, &hash).await?;
        Ok(AttachmentFile {
            path: path.to_string_lossy().into_owned(),
            r#type: r.mime,
            name: r.name,
        })
    }

    /// Pins ready media input ids to `holder` inside an existing write transaction.
    pub(crate) async fn pin_in_tx(&self, tx: &Tx, ids: &[String], holder: &str) -> Result<(), ApiError> {
        if ids.is_empty() || ids.len() > 5 {
            return Err(refused("inputInvalid"));
        }
        for id in ids {
            let r = self
                .ctx
                .service
                .storage
                .find_media_input_in_tx(tx, id)
                .await
                .map_err(storage)?
                .ok_or_else(|| refused("inputMissing"))?;
            let has_file = match r.hash.as_ref() {
                Some(h) => self.attachment.exists_blob_async(h).await,
                None => false,
            };
            if r.phase != MediaInputPhase::Ready || (r.can_delete && r.expires_at <= self.ctx.now()) || !has_file {
                return Err(refused("inputMissing"));
            }
            self.ctx.service.storage.pin_media_input_in_tx(tx, id, holder).await.map_err(storage)?;
        }
        Ok(())
    }

    pub async fn pin_async(&self, ids: &[String], holder: &str) -> Result<(), ApiError> {
        let _inner = self.inner.lock().await;
        let tx = self.ctx.service.begin_tx().await.map_err(storage)?;
        match self.pin_in_tx(&tx, ids, holder).await {
            Ok(()) => {
                self.ctx.service.commit_tx(tx).await.map_err(storage)?;
                Ok(())
            }
            Err(err) => {
                let _ = self.ctx.service.rollback_tx(tx).await;
                Err(err)
            }
        }
    }

    pub async fn release_async(&self, holder: &str) -> Result<(), ApiError> {
        let _inner = self.inner.lock().await;
        self.ctx.service.storage.release_media_input_pins(holder).await.map_err(storage)?;
        Ok(())
    }
}

async fn remove_dir_async(path: PathBuf) -> Result<(), ApiError> {
    match tokio::fs::remove_dir_all(&path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(storage(e)),
    }
}

impl crate::context::api::media::MediaInputs for MediaInputStorage {
    fn upload_async(self: Arc<Self>, id: String, source: Box<dyn Read + Send>) -> crate::BoxFuture<'static, Result<MediaInput, ApiError>> {
        Box::pin(async move { MediaInputStorage::upload_async(&self, &id, source).await })
    }

    fn content_async(self: Arc<Self>, id: String) -> crate::BoxFuture<'static, Result<AttachmentFile, ApiError>> {
        Box::pin(async move { MediaInputStorage::content_async(&self, &id).await })
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use serde_json::json;
    use vibevalley_core::{Clock, ManualClock};

    use super::*;
    use crate::context::{Http, LiveState, Outbox, PublicDownload, StateFeed, TaskGroup};
    use crate::service::Service;

    fn png_request() -> MediaInputRequest {
        serde_json::from_value(json!({ "kind": "image", "mime": "image/png", "name": "sample.png", "size": 24 })).unwrap()
    }

    fn png_bytes() -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.resize(24, 0);
        bytes
    }

    async fn test_inputs(clock: Arc<ManualClock>) -> (tempfile::TempDir, Arc<Context>, Arc<MediaInputStorage>) {
        let dir = tempfile::tempdir().unwrap();
        let service = Service::open(dir.path()).await.unwrap();
        let ctx = Arc::new(Context::new(
            service.clone(),
            TaskGroup::new(),
            Arc::new(LiveState::new()),
            Arc::new(Outbox::new(service)),
            Arc::new(StateFeed::new()),
            clock,
            Arc::new(Http),
            Arc::new(PublicDownload),
        ));
        let attachment = AttachmentStorage::open(dir.path(), ctx.clone());
        let inputs = MediaInputStorage::open_async(dir.path(), ctx.clone(), attachment).await.unwrap();
        (dir, ctx, inputs)
    }

    #[tokio::test]
    async fn manual_clock_drives_input_ttl_expiry_and_pin_protection_without_sleep() {
        let clock = Arc::new(ManualClock::new(1_700_000_000_000));
        let (_dir, ctx, inputs) = test_inputs(clock.clone()).await;

        let reserved = inputs.create_async(&png_request()).await.unwrap();
        assert_eq!(reserved.created_at, 1_700_000_000_000);
        assert_eq!(reserved.expires_at, 1_700_000_000_000 + LIFETIME);

        clock.advance(Duration::from_secs(60));
        let ready = inputs.upload_async(&reserved.id, Box::new(Cursor::new(png_bytes()))).await.unwrap();
        assert_eq!(ready.expires_at, clock.now_ms() + LIFETIME);

        clock.advance(Duration::from_millis((LIFETIME - 1) as u64));
        inputs.sweep_async().await.unwrap();
        assert!(inputs.content_async(&ready.id).await.is_ok());

        clock.advance(Duration::from_millis(1));
        assert!(inputs.content_async(&ready.id).await.is_err());
        inputs.sweep_async().await.unwrap();
        assert!(inputs.list_async().await.unwrap().is_empty());

        let pending = inputs.create_async(&png_request()).await.unwrap();
        clock.advance(Duration::from_millis(LIFETIME as u64));
        assert!(inputs.upload_async(&pending.id, Box::new(Cursor::new(png_bytes()))).await.is_err());
        inputs.sweep_async().await.unwrap();
        assert!(inputs.list_async().await.unwrap().is_empty());

        let pinned = inputs.create_async(&png_request()).await.unwrap();
        let pinned = inputs.upload_async(&pinned.id, Box::new(Cursor::new(png_bytes()))).await.unwrap();
        inputs.pin_async(std::slice::from_ref(&pinned.id), "job-1").await.unwrap();
        clock.advance(Duration::from_millis(LIFETIME as u64));
        inputs.sweep_async().await.unwrap();
        assert!(inputs.content_async(&pinned.id).await.is_ok());
        inputs.release_async("job-1").await.unwrap();
        assert!(inputs.content_async(&pinned.id).await.is_err());
        inputs.sweep_async().await.unwrap();
        assert!(inputs.list_async().await.unwrap().is_empty());

        inputs.close_async().await;
        ctx.shutdown(Duration::from_secs(2)).await;
        ctx.service.close().await;
    }

    #[tokio::test]
    async fn media_inputs_trait_upload_and_content_async_run_without_blocking() {
        use crate::gateway::api::media::SharedMediaInputs;

        let clock = Arc::new(ManualClock::new(1_700_000_000_000));
        let (_dir, ctx, inputs) = test_inputs(clock).await;

        let shared: SharedMediaInputs = inputs.clone();
        let inputs_async = inputs.clone();
        let file = tokio::spawn(async move {
            let reserved = inputs_async.create_async(&png_request()).await.unwrap();
            let uploaded = shared
                .clone()
                .upload_async(reserved.id.clone(), Box::new(Cursor::new(png_bytes())))
                .await
                .unwrap();
            assert_eq!(uploaded.phase, MediaInputPhase::Ready);
            shared.content_async(reserved.id).await.unwrap()
        })
        .await
        .unwrap();
        assert_eq!(file.r#type, "image/png");
        assert_eq!(file.name, "sample.png");
        assert!(Path::new(&file.path).is_file());

        inputs.close_async().await;
        ctx.shutdown(Duration::from_secs(2)).await;
        ctx.service.close().await;
    }
}
