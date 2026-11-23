//! Input reservations, uploads and job pins (`media/inputs.ts`). The mutex
//! protects admission and pins, never a streaming read or attachment write.
use super::{q, validate};
use crate::{
    Hub,
    base::{ServerDb, Ticker},
    modules::content::attachment::Attachments,
};
use parking_lot::Mutex as SyncMutex;
use sha2::{Digest, Sha256};
use sqlx::{Connection, SqliteConnection};
use std::{
    collections::HashSet,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex as AsyncMutex;
use vibevalley_core::{SharedClock, system_clock};
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, AttachmentFile, BizCode, MediaInput, MediaInputKind, MediaInputPhase, MediaInputRequest, Preview, native_ops, ops};

const LIFETIME: i64 = 86_400_000;
const QUOTA: i64 = 2 * 1024 * 1024 * 1024;
pub(super) fn refused(key: &str) -> ApiError {
    ApiError::new(BizCode::MediaRefused, t(&format!("server.media.{key}"), &[]))
}
fn storage(_: impl std::fmt::Display) -> ApiError {
    refused("inputStorage")
}
struct Inner {
    uploading: HashSet<String>,
}
pub struct Inputs {
    db: Arc<ServerDb>,
    inner: AsyncMutex<Inner>,
    files: Arc<Attachments>,
    staging: PathBuf,
    sweeper: SyncMutex<Option<Ticker>>,
    clock: SharedClock,
}
fn input(row: q::GetInputRow, can_delete: bool) -> Result<MediaInput, ApiError> {
    let m: MediaInputRequest = serde_json::from_str(&row.metadata).map_err(storage)?;
    let phase = MediaInputPhase::ALL
        .into_iter()
        .find(|p| p.as_str() == row.phase)
        .ok_or_else(|| refused("inputStorage"))?;
    Ok(MediaInput {
        id: row.id,
        kind: m.kind,
        name: m.name,
        mime: m.mime,
        size: m.size,
        phase,
        hash: row.hash,
        created_at: row.created_at,
        expires_at: row.expires_at,
        can_delete,
    })
}
async fn find_db(db: &mut SqliteConnection, id: &str) -> Result<Option<MediaInput>, ApiError> {
    let row = match q::get_input(&mut *db, q::GetInputParams { id: id.into() }).await {
        Ok(row) => row,
        Err(sqlx::Error::RowNotFound) => return Ok(None),
        Err(e) => return Err(storage(e)),
    };
    let free = q::get_pin(db, q::GetPinParams { input_id: id.into() }).await.map_err(storage)?.pinned == 0;
    input(row, free).map(Some)
}
async fn find_read(db: &ServerDb, inner: &Inner, id: &str) -> Result<Option<MediaInput>, ApiError> {
    let mut conn = db.read_pool().acquire().await.map_err(storage)?;
    let mut record = find_db(&mut conn, id).await?;
    if let Some(r) = &mut record {
        r.can_delete &= !inner.uploading.contains(id);
    }
    Ok(record)
}
async fn found_read(db: &ServerDb, inner: &Inner, id: &str) -> Result<MediaInput, ApiError> {
    find_read(db, inner, id).await?.ok_or_else(|| refused("inputMissing"))
}
async fn find_write(db: &ServerDb, inner: &Inner, id: &str) -> Result<Option<MediaInput>, ApiError> {
    let mut conn = db.write_pool().acquire().await.map_err(storage)?;
    let mut record = find_db(&mut conn, id).await?;
    if let Some(r) = &mut record {
        r.can_delete &= !inner.uploading.contains(id);
    }
    Ok(record)
}
async fn found_write(db: &ServerDb, inner: &Inner, id: &str) -> Result<MediaInput, ApiError> {
    find_write(db, inner, id).await?.ok_or_else(|| refused("inputMissing"))
}
async fn phase_async(db: &ServerDb, id: &str, p: &str) -> Result<(), ApiError> {
    let mut conn = db.write_pool().acquire().await.map_err(storage)?;
    q::set_input_phase(
        &mut *conn,
        q::SetInputPhaseParams {
            id: id.into(),
            phase: p.into(),
        },
    )
    .await
    .map_err(storage)
}
fn stage_upload_blocking(staging: &Path, r: &MediaInput, mut source: Box<dyn Read + Send>) -> Result<(PathBuf, String), ApiError> {
    let directory = staging.join(&r.id);
    std::fs::create_dir_all(&directory).map_err(storage)?;
    let path = directory.join("content");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(storage)?;
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
    if r.kind == MediaInputKind::Audio {
        validate::audio(&path, &r.mime)?;
    }
    let hash = hash.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>();
    if r.hash.as_ref().is_some_and(|h| h != &hash) {
        return Err(refused("inputChanged"));
    }
    Ok((path, hash))
}
fn verify_content_blocking(path: &Path, expected_size: u64, expected_hash: &str) -> Result<(), ApiError> {
    let mut f = std::fs::File::open(path).map_err(storage)?;
    let mut digest = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buffer).map_err(storage)?;
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
impl Inputs {
    pub fn open(home: &Path, db: Arc<ServerDb>, files: Arc<Attachments>) -> Result<Arc<Self>, ApiError> {
        Self::open_with_clock(home, db, files, system_clock())
    }
    /// Same as [`Inputs::open`], injecting an explicit wall [`Clock`](vibevalley_core::Clock).
    pub fn open_with_clock(home: &Path, db: Arc<ServerDb>, files: Arc<Attachments>, clock: SharedClock) -> Result<Arc<Self>, ApiError> {
        let inputs = Arc::new(Self {
            db,
            inner: AsyncMutex::new(Inner { uploading: HashSet::new() }),
            files,
            staging: home.join("attachments/.staging/media"),
            sweeper: SyncMutex::new(None),
            clock,
        });
        vibevalley_runtime::rt::block_on(async {
            inputs.restore_async().await?;
            inputs.sweep_async().await
        })?;
        let weak = Arc::downgrade(&inputs);
        let ticker = Ticker::spawn_detached(Duration::from_secs(60), false, move || {
            let Some(inputs) = weak.upgrade() else { return false };
            // Tombstones survive storage failures and are retried next tick.
            if let Err(error) = inputs.sweep() {
                eprintln!("media input cleanup: {}", error.message);
            }
            true
        });
        *inputs.sweeper.lock() = Some(ticker);
        Ok(inputs)
    }
    pub fn close(&self) {
        if let Some(ticker) = self.sweeper.lock().take() {
            ticker.stop();
        }
    }
    pub async fn get_async(&self, id: &str) -> Result<MediaInput, ApiError> {
        let inner = self.inner.lock().await;
        found_read(&self.db, &inner, id).await
    }
    pub fn get(&self, id: &str) -> Result<MediaInput, ApiError> {
        vibevalley_runtime::rt::block_on(self.get_async(id))
    }
    pub async fn list_async(&self) -> Result<Vec<MediaInput>, ApiError> {
        let uploading: HashSet<String> = self.inner.lock().await.uploading.clone();
        let mut conn = self.db.read_pool().acquire().await.map_err(storage)?;
        let rows = q::list_inputs(&mut *conn).await.map_err(storage)?;
        let pins = q::pinned_inputs(&mut *conn).await.map_err(storage)?;
        drop(conn);
        let pinned: HashSet<_> = pins.into_iter().map(|r| r.input_id).collect();
        rows.into_iter()
            .map(|row| {
                let free = !pinned.contains(&row.id) && !uploading.contains(&row.id);
                input(row, free)
            })
            .collect()
    }
    pub fn list(&self) -> Result<Vec<MediaInput>, ApiError> {
        vibevalley_runtime::rt::block_on(self.list_async())
    }
    pub async fn create_async(&self, r: &MediaInputRequest) -> Result<MediaInput, ApiError> {
        validate::declared(r)?;
        self.sweep_async().await?;
        let id = uuid::Uuid::now_v7().to_string();
        let time = self.clock.now_ms();
        let _inner = self.inner.lock().await;
        let mut conn = self.db.write_pool().acquire().await.map_err(storage)?;
        let mut tx = conn.begin_with("BEGIN IMMEDIATE").await.map_err(storage)?;
        let quota = q::input_quota(&mut *tx).await.map_err(storage)?;
        if quota.entries >= 256 || quota.bytes + r.size > QUOTA {
            return Err(refused("inputQuota"));
        }
        q::reserve_input(
            &mut *tx,
            q::ReserveInputParams {
                id: id.clone(),
                metadata: serde_json::to_string(r).map_err(storage)?,
                size: r.size,
                created_at: time,
                expires_at: time + LIFETIME,
            },
        )
        .await
        .map_err(storage)?;
        let created = find_db(&mut tx, &id).await?.ok_or_else(|| refused("inputMissing"))?;
        tx.commit().await.map_err(storage)?;
        Ok(created)
    }
    pub fn create(&self, r: &MediaInputRequest) -> Result<MediaInput, ApiError> {
        vibevalley_runtime::rt::block_on(self.create_async(r))
    }
    async fn remove_async(&self, r: &MediaInput) -> Result<(), ApiError> {
        if !r.can_delete {
            return Err(refused("inputBusy"));
        }
        {
            let mut conn = self.db.write_pool().acquire().await.map_err(storage)?;
            if q::mark_input_deleting(&mut *conn, q::MarkInputDeletingParams { id: r.id.clone() })
                .await
                .map_err(storage)?
                == 0
            {
                return Err(refused("inputBusy"));
            }
        }
        remove_dir_async(self.staging.join(&r.id)).await?;
        let mut conn = self.db.write_pool().acquire().await.map_err(storage)?;
        q::forget_input(&mut *conn, q::ForgetInputParams { id: r.id.clone() }).await.map_err(storage)?;
        Ok(())
    }
    pub async fn delete_async(&self, id: &str) -> Result<(), ApiError> {
        let inner = self.inner.lock().await;
        if let Some(r) = find_write(&self.db, &inner, id).await? {
            self.remove_async(&r).await?;
        }
        Ok(())
    }
    pub fn delete(&self, id: &str) -> Result<(), ApiError> {
        vibevalley_runtime::rt::block_on(self.delete_async(id))
    }
    pub async fn preview_delete_async(&self, id: &str) -> Result<Preview, ApiError> {
        let inner = self.inner.lock().await;
        let Some(r) = find_read(&self.db, &inner, id).await? else {
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
        let ids = {
            let mut conn = self.db.write_pool().acquire().await.map_err(storage)?;
            q::expired_inputs(
                &mut *conn,
                q::ExpiredInputsParams {
                    expires_at: self.clock.now_ms(),
                },
            )
            .await
            .map_err(storage)?
        };
        for row in ids {
            let id = row.id;
            let r = found_write(&self.db, &inner, &id).await?;
            if r.can_delete
                && let Err(error) = self.remove_async(&r).await
            {
                eprintln!("media input cleanup pending for {id}: {}", error.message);
            }
        }
        Ok(())
    }
    pub fn sweep(&self) -> Result<(), ApiError> {
        vibevalley_runtime::rt::block_on(self.sweep_async())
    }
    async fn restore_async(&self) -> Result<(), ApiError> {
        let _inner = self.inner.lock().await;
        remove_dir_async(self.staging.clone()).await?;
        let rows = {
            let mut conn = self.db.write_pool().acquire().await.map_err(storage)?;
            q::interrupt_uploads(&mut *conn).await.map_err(storage)?;
            q::list_inputs(&mut *conn).await.map_err(storage)?
        };
        for row in rows {
            let r = input(row, false)?;
            if r.phase == MediaInputPhase::Ready {
                let exists = match r.hash.as_ref() {
                    Some(h) => tokio::fs::metadata(self.files.path_of(h)).await.is_ok_and(|m| m.is_file()),
                    None => false,
                };
                if !exists {
                    phase_async(&self.db, &r.id, "failed").await?;
                }
            }
        }
        Ok(())
    }
    /// Streams bounded chunks into a private file; only a complete verified
    /// file is promoted. Readers must enforce their own blocking-read timeout.
    pub async fn upload_async(&self, id: &str, source: Box<dyn Read + Send>) -> Result<MediaInput, ApiError> {
        let r = {
            let mut inner = self.inner.lock().await;
            let r = found_write(&self.db, &inner, id).await?;
            if r.phase == MediaInputPhase::Ready {
                return Ok(r);
            }
            if r.phase == MediaInputPhase::Deleting || inner.uploading.contains(id) || r.expires_at <= self.clock.now_ms() || inner.uploading.len() >= 8 {
                return Err(refused("inputBusy"));
            }
            remove_dir_async(self.staging.join(id)).await?;
            phase_async(&self.db, id, "uploading").await?;
            inner.uploading.insert(id.to_owned());
            r
        };
        let result = self.upload_inner_async(&r, source).await;
        // Always give back the slot, even when staging or promotion fails.
        let cleanup = remove_dir_async(self.staging.join(id)).await;
        let mut inner = self.inner.lock().await;
        inner.uploading.remove(id);
        if result.is_err() {
            phase_async(&self.db, id, "failed").await?;
        }
        result?;
        if let Err(error) = cleanup {
            eprintln!("media staging cleanup: {}", error.message);
        }
        found_write(&self.db, &inner, id).await
    }
    pub fn upload(&self, id: &str, source: impl Read + Send + 'static) -> Result<MediaInput, ApiError> {
        vibevalley_runtime::rt::block_on(self.upload_async(id, Box::new(source)))
    }
    async fn upload_inner_async(&self, r: &MediaInput, source: Box<dyn Read + Send>) -> Result<(), ApiError> {
        let staging = self.staging.clone();
        let record = r.clone();
        let (path, hash) = tokio::task::spawn_blocking(move || stage_upload_blocking(&staging, &record, source))
            .await
            .map_err(storage)??;
        {
            let _inner = self.inner.lock().await;
            let mut conn = self.db.write_pool().acquire().await.map_err(storage)?;
            q::save_input_hash(
                &mut *conn,
                q::SaveInputHashParams {
                    id: r.id.clone(),
                    hash: Some(hash.clone()),
                },
            )
            .await
            .map_err(storage)?;
        }
        self.files.keep_staged_async(path, hash, r.size, r.name.clone(), r.mime.clone()).await?;
        {
            let _inner = self.inner.lock().await;
            let mut conn = self.db.write_pool().acquire().await.map_err(storage)?;
            q::input_ready(
                &mut *conn,
                q::InputReadyParams {
                    id: r.id.clone(),
                    expires_at: self.clock.now_ms() + LIFETIME,
                },
            )
            .await
            .map_err(storage)?;
        }
        Ok(())
    }
    pub async fn adopt_async(&self, id: &str) -> Result<MediaInput, ApiError> {
        let files = self.files.of_async(&[id.to_owned()]).await.map_err(|_| refused("inputInvalid"))?;
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
        let source_path = self.files.path_of(id);
        let opened = tokio::task::spawn_blocking(move || std::fs::File::open(&source_path))
            .await
            .map_err(storage)?
            .map_err(storage)?;
        self.upload_async(&r.id, Box::new(opened)).await
    }
    pub fn adopt(&self, id: &str) -> Result<MediaInput, ApiError> {
        vibevalley_runtime::rt::block_on(self.adopt_async(id))
    }
    pub async fn upload_file_async(&self, id: &str, path: PathBuf) -> Result<MediaInput, ApiError> {
        if !path.is_absolute() {
            return Err(refused("inputInvalid"));
        }
        let (file, file_len) = tokio::task::spawn_blocking(move || -> Result<(std::fs::File, u64), ApiError> {
            if !std::fs::metadata(&path).map_err(storage)?.is_file() {
                return Err(refused("inputInvalid"));
            }
            let file = std::fs::File::open(&path).map_err(storage)?;
            let metadata = file.metadata().map_err(storage)?;
            if !metadata.is_file() {
                return Err(refused("inputInvalid"));
            }
            Ok((file, metadata.len()))
        })
        .await
        .map_err(storage)??;
        if file_len != self.get_async(id).await?.size as u64 {
            return Err(refused("inputInvalid"));
        }
        self.upload_async(id, Box::new(file)).await
    }
    pub fn upload_file(&self, id: &str, path: &Path) -> Result<MediaInput, ApiError> {
        vibevalley_runtime::rt::block_on(self.upload_file_async(id, path.to_path_buf()))
    }
    pub async fn content_async(&self, id: &str) -> Result<AttachmentFile, ApiError> {
        let r = self.get_async(id).await?;
        if r.phase != MediaInputPhase::Ready || (r.can_delete && r.expires_at <= self.clock.now_ms()) {
            return Err(refused("inputMissing"));
        }
        let hash = r.hash.clone().ok_or_else(|| refused("inputMissing"))?;
        let path = self.files.path_of(&hash);
        let verify_path = path.clone();
        let expected_size = r.size as u64;
        tokio::task::spawn_blocking(move || verify_content_blocking(&verify_path, expected_size, &hash))
            .await
            .map_err(storage)??;
        Ok(AttachmentFile {
            path: path.to_string_lossy().into_owned(),
            r#type: r.mime,
            name: r.name,
        })
    }
    pub fn content(&self, id: &str) -> Result<AttachmentFile, ApiError> {
        vibevalley_runtime::rt::block_on(self.content_async(id))
    }

    pub(super) async fn pin_in_async(&self, db: &mut SqliteConnection, ids: &[String], holder: &str) -> Result<(), ApiError> {
        if ids.is_empty() || ids.len() > 5 {
            return Err(refused("inputInvalid"));
        }
        for id in ids {
            let r = find_db(&mut *db, id).await?.ok_or_else(|| refused("inputMissing"))?;
            let has_file = match r.hash.as_ref() {
                Some(h) => tokio::fs::metadata(self.files.path_of(h)).await.is_ok_and(|m| m.is_file()),
                None => false,
            };
            if r.phase != MediaInputPhase::Ready || (r.can_delete && r.expires_at <= self.clock.now_ms()) || !has_file {
                return Err(refused("inputMissing"));
            }
            q::pin_input(
                &mut *db,
                q::PinInputParams {
                    input_id: id.clone(),
                    holder: holder.into(),
                },
            )
            .await
            .map_err(storage)?;
        }
        Ok(())
    }

    pub async fn pin_async(&self, ids: &[String], holder: &str) -> Result<(), ApiError> {
        let _inner = self.inner.lock().await;
        let mut conn = self.db.write_pool().acquire().await.map_err(storage)?;
        let mut tx = conn.begin_with("BEGIN IMMEDIATE").await.map_err(storage)?;
        self.pin_in_async(&mut tx, ids, holder).await?;
        tx.commit().await.map_err(storage)?;
        Ok(())
    }
    pub fn pin(&self, ids: &[String], holder: &str) -> Result<(), ApiError> {
        vibevalley_runtime::rt::block_on(self.pin_async(ids, holder))
    }
    pub async fn release_async(&self, holder: &str) -> Result<(), ApiError> {
        let _inner = self.inner.lock().await;
        let mut conn = self.db.write_pool().acquire().await.map_err(storage)?;
        q::release_pins(&mut *conn, q::ReleasePinsParams { holder: holder.into() })
            .await
            .map_err(storage)
    }
    pub fn release(&self, holder: &str) -> Result<(), ApiError> {
        vibevalley_runtime::rt::block_on(self.release_async(holder))
    }
}
async fn remove_dir_async(path: PathBuf) -> Result<(), ApiError> {
    tokio::task::spawn_blocking(move || match std::fs::remove_dir_all(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(storage(e)),
    })
    .await
    .map_err(storage)?
}
pub fn install(hub: &Hub, inputs: Arc<Inputs>) {
    hub.attach_media_inputs(inputs.clone());
    hub.on_async::<native_ops::MediaInputFile, _, _>({
        let i = inputs.clone();
        move |_, r| {
            let i = i.clone();
            async move { i.content_async(&r.id).await }
        }
    });
    hub.on_async::<native_ops::MediaInputUploadFile, _, _>({
        let i = inputs.clone();
        move |_, r| {
            let i = i.clone();
            async move { i.upload_file_async(&r.id, PathBuf::from(r.path)).await }
        }
    });

    hub.on_async::<ops::MediaInputCreate, _, _>({
        let i = inputs.clone();
        move |_, r| {
            let i = i.clone();
            async move { i.create_async(&r).await }
        }
    });
    hub.on_async::<ops::MediaInputAdopt, _, _>({
        let i = inputs.clone();
        move |_, r| {
            let i = i.clone();
            async move { i.adopt_async(&r.attachment).await }
        }
    });
    hub.on_async::<ops::MediaInputGet, _, _>({
        let i = inputs.clone();
        move |_, r| {
            let i = i.clone();
            async move { i.get_async(&r.id).await }
        }
    });
    hub.on_async::<ops::MediaInputList, _, _>({
        let i = inputs.clone();
        move |_, _| {
            let i = i.clone();
            async move { i.list_async().await }
        }
    });
    hub.on_async::<ops::MediaInputPreviewDelete, _, _>({
        let i = inputs.clone();
        move |_, r| {
            let i = i.clone();
            async move { i.preview_delete_async(&r.id).await }
        }
    });
    hub.on_async::<ops::MediaInputDelete, _, _>(move |_, r| {
        let i = inputs.clone();
        async move { i.delete_async(&r.id).await }
    });
}

impl crate::transport::api::media::MediaInputs for Inputs {
    fn upload(&self, id: &str, source: Box<dyn Read + Send>) -> Result<MediaInput, ApiError> {
        vibevalley_runtime::rt::block_on(self.upload_async(id, source))
    }
    fn content(&self, id: &str) -> Result<AttachmentFile, ApiError> {
        vibevalley_runtime::rt::block_on(self.content_async(id))
    }
    fn upload_async(self: Arc<Self>, id: String, source: Box<dyn Read + Send>) -> crate::BoxFuture<'static, Result<MediaInput, ApiError>> {
        Box::pin(async move { Inputs::upload_async(&self, &id, source).await })
    }
    fn content_async(self: Arc<Self>, id: String) -> crate::BoxFuture<'static, Result<AttachmentFile, ApiError>> {
        Box::pin(async move { Inputs::content_async(&self, &id).await })
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use serde_json::json;
    use vibevalley_core::{Clock, ManualClock};

    use super::*;

    fn png_request() -> MediaInputRequest {
        serde_json::from_value(json!({ "kind": "image", "mime": "image/png", "name": "sample.png", "size": 24 })).unwrap()
    }

    fn png_bytes() -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.resize(24, 0);
        bytes
    }

    #[test]
    fn manual_clock_drives_input_ttl_expiry_and_pin_protection_without_sleep() {
        let dir = tempfile::tempdir().unwrap();
        let db = ServerDb::open(dir.path()).unwrap();
        let files = Attachments::open(dir.path(), db.clone());
        let clock = Arc::new(ManualClock::new(1_700_000_000_000));
        let inputs = Inputs::open_with_clock(dir.path(), db.clone(), files, clock.clone()).unwrap();

        // Reserve and upload; uploading refreshes `expires_at` from the current clock.
        let reserved = inputs.create(&png_request()).unwrap();
        assert_eq!(reserved.created_at, 1_700_000_000_000);
        assert_eq!(reserved.expires_at, 1_700_000_000_000 + LIFETIME);

        clock.advance(Duration::from_secs(60));
        let ready = inputs.upload(&reserved.id, Cursor::new(png_bytes())).unwrap();
        assert_eq!(ready.expires_at, clock.now_ms() + LIFETIME);

        // Just before expiry, the input stays readable and survives sweep.
        clock.advance(Duration::from_millis((LIFETIME - 1) as u64));
        inputs.sweep().unwrap();
        assert!(inputs.content(&ready.id).is_ok());

        // At expiry, content is refused and sweep deletes the unpinned record.
        clock.advance(Duration::from_millis(1));
        assert!(inputs.content(&ready.id).is_err());
        inputs.sweep().unwrap();
        assert!(inputs.list().unwrap().is_empty());

        // An unuploaded reservation expires past LIFETIME and refuses upload.
        let pending = inputs.create(&png_request()).unwrap();
        clock.advance(Duration::from_millis(LIFETIME as u64));
        assert!(inputs.upload(&pending.id, Cursor::new(png_bytes())).is_err());
        inputs.sweep().unwrap();
        assert!(inputs.list().unwrap().is_empty());

        // A pinned input survives sweep past LIFETIME until released.
        let pinned = inputs.create(&png_request()).unwrap();
        let pinned = inputs.upload(&pinned.id, Cursor::new(png_bytes())).unwrap();
        inputs.pin(std::slice::from_ref(&pinned.id), "job-1").unwrap();
        clock.advance(Duration::from_millis(LIFETIME as u64));
        inputs.sweep().unwrap();
        assert!(inputs.content(&pinned.id).is_ok());
        inputs.release("job-1").unwrap();
        assert!(inputs.content(&pinned.id).is_err());
        inputs.sweep().unwrap();
        assert!(inputs.list().unwrap().is_empty());

        inputs.close();
        db.close();
    }

    #[test]
    fn media_inputs_trait_upload_and_content_async_run_without_blocking() {
        use crate::transport::api::media::SharedMediaInputs;

        let dir = tempfile::tempdir().unwrap();
        let db = ServerDb::open(dir.path()).unwrap();
        let files = Attachments::open(dir.path(), db.clone());
        let clock = Arc::new(ManualClock::new(1_700_000_000_000));
        let inputs = Inputs::open_with_clock(dir.path(), db.clone(), files, clock).unwrap();

        let shared: SharedMediaInputs = inputs.clone();
        let inputs_async = inputs.clone();
        let file = vibevalley_runtime::rt::block_on(async move {
            vibevalley_runtime::rt::spawn(async move {
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
            .unwrap()
        });
        assert_eq!(file.r#type, "image/png");
        assert_eq!(file.name, "sample.png");
        assert!(Path::new(&file.path).is_file());

        inputs.close();
        db.close();
    }
}
