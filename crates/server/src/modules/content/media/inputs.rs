//! Input reservations, uploads and job pins (`media/inputs.ts`). The mutex
//! protects admission and pins, never a streaming read or attachment write.
use super::{q, validate};
use crate::{Hub, base::open_sqlx_db, modules::content::attachment::Attachments, now};
use pollster::block_on;
use sha2::{Digest, Sha256};
use sqlx::{Connection, SqliteConnection};
use std::{
    collections::HashSet,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
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
    db: SqliteConnection,
    uploading: HashSet<String>,
}
pub struct Inputs {
    inner: Mutex<Inner>,
    files: Arc<Attachments>,
    staging: PathBuf,
    stop: Mutex<Option<flume::Sender<()>>>,
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
fn find(inner: &mut Inner, id: &str) -> Result<Option<MediaInput>, ApiError> {
    let mut record = block_on(find_db(&mut inner.db, id))?;
    if let Some(r) = &mut record {
        r.can_delete &= !inner.uploading.contains(id);
    }
    Ok(record)
}
fn found(inner: &mut Inner, id: &str) -> Result<MediaInput, ApiError> {
    find(inner, id)?.ok_or_else(|| refused("inputMissing"))
}
fn phase(inner: &mut Inner, id: &str, p: &str) -> Result<(), ApiError> {
    block_on(q::set_input_phase(
        &mut inner.db,
        q::SetInputPhaseParams {
            id: id.into(),
            phase: p.into(),
        },
    ))
    .map_err(storage)
}
impl Inputs {
    pub fn open(home: &Path, files: Arc<Attachments>) -> Result<Arc<Self>, ApiError> {
        let mut db = block_on(open_sqlx_db(home)).map_err(storage)?;
        block_on(sqlx::raw_sql(include_str!("sql/inputs.sql")).execute(&mut db)).map_err(storage)?;
        let inputs = Arc::new(Self {
            inner: Mutex::new(Inner { db, uploading: HashSet::new() }),
            files,
            staging: home.join("attachments/.staging/media"),
            stop: Mutex::new(None),
        });
        inputs.restore()?;
        inputs.sweep()?;
        let (stop, stopped) = flume::bounded(1);
        *inputs.stop.lock().unwrap_or_else(|e| e.into_inner()) = Some(stop);
        let weak = Arc::downgrade(&inputs);
        std::thread::Builder::new()
            .name("media-input-sweep".into())
            .spawn(move || {
                while matches!(stopped.recv_timeout(Duration::from_secs(60)), Err(flume::RecvTimeoutError::Timeout)) {
                    let Some(inputs) = weak.upgrade() else { break };
                    // Tombstones survive storage failures and are retried next tick.
                    if let Err(error) = inputs.sweep() {
                        eprintln!("media input cleanup: {}", error.message);
                    }
                }
            })
            .map_err(storage)?;
        Ok(inputs)
    }
    pub fn close(&self) {
        self.stop.lock().unwrap_or_else(|e| e.into_inner()).take();
    }
    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn get(&self, id: &str) -> Result<MediaInput, ApiError> {
        found(&mut self.inner(), id)
    }
    pub fn list(&self) -> Result<Vec<MediaInput>, ApiError> {
        let mut inner = self.inner();
        let (rows, pins) = block_on(async {
            let mut tx = inner.db.begin().await?;
            let rows = q::list_inputs(&mut *tx).await?;
            let pins = q::pinned_inputs(&mut *tx).await?;
            tx.commit().await?;
            Ok::<_, sqlx::Error>((rows, pins))
        })
        .map_err(storage)?;
        let pinned: HashSet<_> = pins.into_iter().map(|r| r.input_id).collect();
        rows.into_iter()
            .map(|row| {
                let free = !pinned.contains(&row.id) && !inner.uploading.contains(&row.id);
                input(row, free)
            })
            .collect()
    }
    pub fn create(&self, r: &MediaInputRequest) -> Result<MediaInput, ApiError> {
        validate::declared(r)?;
        self.sweep()?;
        let id = uuid::Uuid::now_v7().to_string();
        let time = now();
        self.transaction(|db| {
            let quota = block_on(q::input_quota(&mut *db)).map_err(storage)?;
            if quota.entries >= 256 || quota.bytes + r.size > QUOTA {
                return Err(refused("inputQuota"));
            }
            block_on(q::reserve_input(
                &mut *db,
                q::ReserveInputParams {
                    id: id.clone(),
                    metadata: serde_json::to_string(r).map_err(storage)?,
                    size: r.size,
                    created_at: time,
                    expires_at: time + LIFETIME,
                },
            ))
            .map_err(storage)?;
            block_on(find_db(db, &id))?.ok_or_else(|| refused("inputMissing"))
        })
    }
    fn remove(&self, inner: &mut Inner, r: &MediaInput) -> Result<(), ApiError> {
        if !r.can_delete {
            return Err(refused("inputBusy"));
        }
        if block_on(q::mark_input_deleting(&mut inner.db, q::MarkInputDeletingParams { id: r.id.clone() })).map_err(storage)? == 0 {
            return Err(refused("inputBusy"));
        }
        remove_dir(&self.staging.join(&r.id))?;
        block_on(q::forget_input(&mut inner.db, q::ForgetInputParams { id: r.id.clone() })).map_err(storage)?;
        Ok(())
    }
    pub fn delete(&self, id: &str) -> Result<(), ApiError> {
        let mut inner = self.inner();
        if let Some(r) = find(&mut inner, id)? {
            self.remove(&mut inner, &r)?;
        }
        Ok(())
    }
    pub fn preview_delete(&self, id: &str) -> Result<Preview, ApiError> {
        let mut inner = self.inner();
        let Some(r) = find(&mut inner, id)? else {
            return Ok(Preview { does: vec![] });
        };
        if !r.can_delete {
            return Err(refused("inputBusy"));
        }
        Ok(Preview {
            does: vec![t("server.media.inputDeletePreview", &[("name", r.name.into())])],
        })
    }
    pub fn sweep(&self) -> Result<(), ApiError> {
        let mut inner = self.inner();
        let ids = block_on(q::expired_inputs(&mut inner.db, q::ExpiredInputsParams { expires_at: now() })).map_err(storage)?;
        for row in ids {
            let id = row.id;
            let r = found(&mut inner, &id)?;
            if r.can_delete
                && let Err(error) = self.remove(&mut inner, &r)
            {
                eprintln!("media input cleanup pending for {id}: {}", error.message);
            }
        }
        Ok(())
    }
    fn restore(&self) -> Result<(), ApiError> {
        let mut inner = self.inner();
        remove_dir(&self.staging)?;
        block_on(q::interrupt_uploads(&mut inner.db)).map_err(storage)?;
        for row in block_on(q::list_inputs(&mut inner.db)).map_err(storage)? {
            let r = input(row, false)?;
            if r.phase == MediaInputPhase::Ready && !r.hash.as_ref().is_some_and(|h| self.files.path_of(h).is_file()) {
                phase(&mut inner, &r.id, "failed")?;
            }
        }
        Ok(())
    }
    /// Streams bounded chunks into a private file; only a complete verified
    /// file is promoted. Readers must enforce their own blocking-read timeout.
    pub fn upload(&self, id: &str, source: impl Read) -> Result<MediaInput, ApiError> {
        let r = {
            let mut inner = self.inner();
            let r = found(&mut inner, id)?;
            if r.phase == MediaInputPhase::Ready {
                return Ok(r);
            }
            if r.phase == MediaInputPhase::Deleting || inner.uploading.contains(id) || r.expires_at <= now() || inner.uploading.len() >= 8 {
                return Err(refused("inputBusy"));
            }
            remove_dir(&self.staging.join(id))?;
            phase(&mut inner, id, "uploading")?;
            inner.uploading.insert(id.to_owned());
            r
        };
        let result = self.upload_inner(&r, source);
        // Always give back the slot, even when staging or promotion fails.
        let cleanup = remove_dir(&self.staging.join(id));
        let mut inner = self.inner();
        inner.uploading.remove(id);
        if result.is_err() {
            phase(&mut inner, id, "failed")?;
        }
        result?;
        if let Err(error) = cleanup {
            eprintln!("media staging cleanup: {}", error.message);
        }
        found(&mut inner, id)
    }
    fn upload_inner(&self, r: &MediaInput, mut source: impl Read) -> Result<(), ApiError> {
        let directory = self.staging.join(&r.id);
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
        {
            let mut inner = self.inner();
            block_on(q::save_input_hash(
                &mut inner.db,
                q::SaveInputHashParams {
                    id: r.id.clone(),
                    hash: Some(hash.clone()),
                },
            ))
            .map_err(storage)?;
        }
        self.files.keep_staged(&path, &hash, r.size, &r.name, &r.mime)?;
        block_on(q::input_ready(
            &mut self.inner().db,
            q::InputReadyParams {
                id: r.id.clone(),
                expires_at: now() + LIFETIME,
            },
        ))
        .map_err(storage)?;
        Ok(())
    }
    pub fn adopt(&self, id: &str) -> Result<MediaInput, ApiError> {
        let files = self.files.of(&[id.to_owned()]).map_err(|_| refused("inputInvalid"))?;
        let file = &files[0];
        let kind = match file.r#type.split('/').next() {
            Some("image") => MediaInputKind::Image,
            Some("video") => MediaInputKind::Video,
            Some("audio") => MediaInputKind::Audio,
            _ => return Err(refused("inputInvalid")),
        };
        let r = self.create(&MediaInputRequest {
            kind,
            name: file.name.clone(),
            mime: file.r#type.clone(),
            size: file.size,
        })?;
        self.upload(&r.id, std::fs::File::open(self.files.path_of(id)).map_err(storage)?)
    }
    pub fn upload_file(&self, id: &str, path: &Path) -> Result<MediaInput, ApiError> {
        if !path.is_absolute() || !std::fs::metadata(path).map_err(storage)?.is_file() {
            return Err(refused("inputInvalid"));
        }
        let file = std::fs::File::open(path).map_err(storage)?;
        let metadata = file.metadata().map_err(storage)?;
        if !metadata.is_file() || metadata.len() != self.get(id)?.size as u64 {
            return Err(refused("inputInvalid"));
        }
        self.upload(id, file)
    }
    pub fn content(&self, id: &str) -> Result<AttachmentFile, ApiError> {
        let r = self.get(id)?;
        if r.phase != MediaInputPhase::Ready || (r.can_delete && r.expires_at <= now()) {
            return Err(refused("inputMissing"));
        }
        let hash = r.hash.as_ref().ok_or_else(|| refused("inputMissing"))?;
        let path = self.files.path_of(hash);
        let mut f = std::fs::File::open(&path).map_err(storage)?;
        let mut digest = Sha256::new();
        let mut size = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let n = f.read(&mut buffer).map_err(storage)?;
            if n == 0 {
                break;
            }
            size += n as u64;
            if size > r.size as u64 {
                return Err(refused("inputChanged"));
            }
            digest.update(&buffer[..n]);
        }
        if size != r.size as u64 || digest.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>() != *hash {
            return Err(refused("inputChanged"));
        }
        Ok(AttachmentFile {
            path: path.to_string_lossy().into_owned(),
            r#type: r.mime,
            name: r.name,
        })
    }
    fn transaction<T>(&self, write: impl FnOnce(&mut SqliteConnection) -> Result<T, ApiError>) -> Result<T, ApiError> {
        let mut inner = self.inner();
        let mut tx = block_on(inner.db.begin_with("BEGIN IMMEDIATE")).map_err(storage)?;
        let value = write(&mut tx)?;
        block_on(tx.commit()).map_err(storage)?;
        Ok(value)
    }

    pub(super) fn pin_in(&self, db: &mut SqliteConnection, ids: &[String], holder: &str) -> Result<(), ApiError> {
        if ids.is_empty() || ids.len() > 5 {
            return Err(refused("inputInvalid"));
        }
        for id in ids {
            let r = block_on(find_db(&mut *db, id))?.ok_or_else(|| refused("inputMissing"))?;
            if r.phase != MediaInputPhase::Ready || (r.can_delete && r.expires_at <= now()) || !r.hash.as_ref().is_some_and(|h| self.files.path_of(h).is_file())
            {
                return Err(refused("inputMissing"));
            }
            block_on(q::pin_input(
                &mut *db,
                q::PinInputParams {
                    input_id: id.clone(),
                    holder: holder.into(),
                },
            ))
            .map_err(storage)?;
        }
        Ok(())
    }

    pub fn pin(&self, ids: &[String], holder: &str) -> Result<(), ApiError> {
        self.transaction(|db| self.pin_in(db, ids, holder))
    }
    pub fn release(&self, holder: &str) -> Result<(), ApiError> {
        block_on(q::release_pins(&mut self.inner().db, q::ReleasePinsParams { holder: holder.into() })).map_err(storage)
    }
}
fn remove_dir(path: &Path) -> Result<(), ApiError> {
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(storage(e)),
    }
}
pub fn install(hub: &Hub, inputs: Arc<Inputs>) {
    hub.attach_media_inputs(inputs.clone());
    hub.on::<native_ops::MediaInputFile>({
        let i = inputs.clone();
        move |_, r| i.content(&r.id)
    });
    hub.on::<native_ops::MediaInputUploadFile>({
        let i = inputs.clone();
        move |_, r| i.upload_file(&r.id, Path::new(&r.path))
    });

    hub.on::<ops::MediaInputCreate>({
        let i = inputs.clone();
        move |_, r| i.create(&r)
    });
    hub.on::<ops::MediaInputAdopt>({
        let i = inputs.clone();
        move |_, r| i.adopt(&r.attachment)
    });
    hub.on::<ops::MediaInputGet>({
        let i = inputs.clone();
        move |_, r| i.get(&r.id)
    });
    hub.on::<ops::MediaInputList>({
        let i = inputs.clone();
        move |_, _| i.list()
    });
    hub.on::<ops::MediaInputPreviewDelete>({
        let i = inputs.clone();
        move |_, r| i.preview_delete(&r.id)
    });
    hub.on::<ops::MediaInputDelete>(move |_, r| inputs.delete(&r.id));
}

impl crate::transport::api::media::MediaInputs for Inputs {
    fn upload(&self, id: &str, source: Box<dyn Read + Send>) -> Result<MediaInput, ApiError> {
        Inputs::upload(self, id, source)
    }
    fn content(&self, id: &str) -> Result<AttachmentFile, ApiError> {
        Inputs::content(self, id)
    }
}
