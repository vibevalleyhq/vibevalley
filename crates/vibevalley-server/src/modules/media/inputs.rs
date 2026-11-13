//! Input reservations, uploads and job pins (`media/inputs.ts`). The mutex
//! protects admission and pins, never a streaming read or attachment write.
use super::validate;
use crate::{
    Hub,
    modules::attachment::{Attachments, open_db},
    now,
};
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, AttachmentFile, BizCode, MediaInput, MediaInputKind, MediaInputPhase, MediaInputRequest, Preview, ops};

const LIFETIME: i64 = 86_400_000;
const QUOTA: i64 = 2 * 1024 * 1024 * 1024;
const SCHEMA: &str = "
create table if not exists media_input (
 id text primary key, metadata text not null, size integer not null,
 phase text not null, hash text, created_at integer not null, expires_at integer not null
);
create table if not exists media_input_pin (
 input_id text not null references media_input(id) on delete cascade,
 holder text not null, primary key(input_id, holder)
);";
const SELECT: &str = "select id, metadata, phase, hash, created_at, expires_at,
 exists(select 1 from media_input_pin where input_id=media_input.id) from media_input";
pub(super) fn refused(key: &str) -> ApiError {
    ApiError::new(BizCode::MediaRefused, t(&format!("server.media.{key}"), &[]))
}
fn storage(_: impl std::fmt::Display) -> ApiError {
    refused("inputStorage")
}
struct Inner {
    db: Connection,
    uploading: HashSet<String>,
}
pub struct Inputs {
    inner: Mutex<Inner>,
    files: Arc<Attachments>,
    staging: PathBuf,
    stop: Mutex<Option<flume::Sender<()>>>,
}
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<MediaInput> {
    let metadata: String = r.get(1)?;
    let m: MediaInputRequest =
        serde_json::from_str(&metadata).map_err(|e| rusqlite::Error::FromSqlConversionFailure(1, rusqlite::types::Type::Text, Box::new(e)))?;
    let phase: String = r.get(2)?;
    let phase = MediaInputPhase::ALL
        .into_iter()
        .find(|p| p.as_str() == phase)
        .ok_or(rusqlite::Error::InvalidQuery)?;
    Ok(MediaInput {
        id: r.get(0)?,
        kind: m.kind,
        name: m.name,
        mime: m.mime,
        size: m.size,
        phase,
        hash: r.get(3)?,
        created_at: r.get(4)?,
        expires_at: r.get(5)?,
        can_delete: !r.get::<_, bool>(6)?,
    })
}
fn find(inner: &Inner, id: &str) -> Result<Option<MediaInput>, ApiError> {
    let mut got = inner.db.query_row(&format!("{SELECT} where id=?1"), [id], row).optional().map_err(storage)?;
    if let Some(r) = &mut got {
        r.can_delete &= !inner.uploading.contains(id);
    }
    Ok(got)
}
fn found(inner: &Inner, id: &str) -> Result<MediaInput, ApiError> {
    find(inner, id)?.ok_or_else(|| refused("inputMissing"))
}
fn phase(inner: &Inner, id: &str, p: &str) -> Result<(), ApiError> {
    inner
        .db
        .execute("update media_input set phase=?2 where id=?1", params![id, p])
        .map_err(storage)?;
    Ok(())
}
impl Inputs {
    pub fn open(home: &Path, files: Arc<Attachments>) -> Result<Arc<Self>, ApiError> {
        let db = open_db(home).map_err(storage)?;
        db.execute_batch(SCHEMA).map_err(storage)?;
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
        found(&self.inner(), id)
    }
    pub fn list(&self) -> Result<Vec<MediaInput>, ApiError> {
        let inner = self.inner();
        let mut q = inner.db.prepare(&format!("{SELECT} order by created_at desc,id")).map_err(storage)?;
        q.query_map([], row)
            .map_err(storage)?
            .map(|r| {
                r.map(|mut r| {
                    r.can_delete &= !inner.uploading.contains(&r.id);
                    r
                })
                .map_err(storage)
            })
            .collect()
    }
    pub fn create(&self, r: &MediaInputRequest) -> Result<MediaInput, ApiError> {
        validate::declared(r)?;
        self.sweep()?;
        let inner = self.inner();
        let (bytes, count): (i64, i64) = inner
            .db
            .query_row("select coalesce(sum(size),0),count(*) from media_input", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(storage)?;
        if count >= 256 || bytes + r.size > QUOTA {
            return Err(refused("inputQuota"));
        }
        let id = uuid::Uuid::now_v7().to_string();
        let time = now();
        inner
            .db
            .execute(
                "insert into media_input (id,metadata,size,phase,created_at,expires_at) values (?1,?2,?3,'reserved',?4,?5)",
                params![id, serde_json::to_string(r).map_err(storage)?, r.size, time, time + LIFETIME],
            )
            .map_err(storage)?;
        found(&inner, &id)
    }
    fn remove(&self, inner: &Inner, r: &MediaInput) -> Result<(), ApiError> {
        if !r.can_delete {
            return Err(refused("inputBusy"));
        }
        phase(inner, &r.id, "deleting")?;
        remove_dir(&self.staging.join(&r.id))?;
        inner.db.execute("delete from media_input where id=?1", [&r.id]).map_err(storage)?;
        Ok(())
    }
    pub fn delete(&self, id: &str) -> Result<(), ApiError> {
        let inner = self.inner();
        if let Some(r) = find(&inner, id)? {
            self.remove(&inner, &r)?;
        }
        Ok(())
    }
    pub fn preview_delete(&self, id: &str) -> Result<Preview, ApiError> {
        let inner = self.inner();
        let Some(r) = find(&inner, id)? else {
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
        let inner = self.inner();
        let ids:Vec<String>=inner.db.prepare("select id from media_input where (expires_at<=?1 or phase='deleting') and not exists(select 1 from media_input_pin where input_id=media_input.id)").map_err(storage)?.query_map([now()],|r|r.get(0)).map_err(storage)?.collect::<Result<_,_>>().map_err(storage)?;
        for id in ids {
            let r = found(&inner, &id)?;
            if r.can_delete
                && let Err(error) = self.remove(&inner, &r)
            {
                eprintln!("media input cleanup pending for {id}: {}", error.message);
            }
        }
        Ok(())
    }
    fn restore(&self) -> Result<(), ApiError> {
        let inner = self.inner();
        remove_dir(&self.staging)?;
        inner
            .db
            .execute("update media_input set phase='failed' where phase='uploading'", [])
            .map_err(storage)?;
        let rows: Vec<MediaInput> = inner
            .db
            .prepare(SELECT)
            .map_err(storage)?
            .query_map([], row)
            .map_err(storage)?
            .collect::<Result<_, _>>()
            .map_err(storage)?;
        for r in rows {
            if r.phase == MediaInputPhase::Ready && !r.hash.as_ref().is_some_and(|h| self.files.path_of(h).is_file()) {
                phase(&inner, &r.id, "failed")?;
            }
        }
        Ok(())
    }
    /// Streams bounded chunks into a private file; only a complete verified
    /// file is promoted. Readers must enforce their own blocking-read timeout.
    pub fn upload(&self, id: &str, source: impl Read) -> Result<MediaInput, ApiError> {
        let r = {
            let mut inner = self.inner();
            let r = found(&inner, id)?;
            if r.phase == MediaInputPhase::Ready {
                return Ok(r);
            }
            if r.phase == MediaInputPhase::Deleting || inner.uploading.contains(id) || r.expires_at <= now() || inner.uploading.len() >= 8 {
                return Err(refused("inputBusy"));
            }
            remove_dir(&self.staging.join(id))?;
            phase(&inner, id, "uploading")?;
            inner.uploading.insert(id.to_owned());
            r
        };
        let result = self.upload_inner(&r, source);
        // Always give back the slot, even when staging or promotion fails.
        let cleanup = remove_dir(&self.staging.join(id));
        let mut inner = self.inner();
        inner.uploading.remove(id);
        if result.is_err() {
            phase(&inner, id, "failed")?;
        }
        result?;
        if let Err(error) = cleanup {
            eprintln!("media staging cleanup: {}", error.message);
        }
        found(&inner, id)
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
            let inner = self.inner();
            inner
                .db
                .execute("update media_input set hash=?2 where id=?1", params![r.id, hash])
                .map_err(storage)?;
        }
        self.files.keep_staged(&path, &hash, r.size, &r.name, &r.mime)?;
        let inner = self.inner();
        inner
            .db
            .execute(
                "update media_input set phase='ready',expires_at=?2 where id=?1",
                params![r.id, now() + LIFETIME],
            )
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
    /// Pins and the job admission commit together, on this database connection.
    /// The callback must not call Inputs or open another write transaction.
    pub fn pin<T>(&self, ids: &[String], holder: &str, admit: impl FnOnce(&Connection) -> Result<T, ApiError>) -> Result<T, ApiError> {
        if ids.is_empty() || ids.len() > 5 {
            return Err(refused("inputInvalid"));
        }
        let mut inner = self.inner();
        for id in ids {
            let r = found(&inner, id)?;
            if r.phase != MediaInputPhase::Ready || (r.can_delete && r.expires_at <= now()) || !r.hash.as_ref().is_some_and(|h| self.files.path_of(h).is_file())
            {
                return Err(refused("inputMissing"));
            }
        }
        let tx = inner.db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(storage)?;
        for id in ids {
            tx.execute("insert or ignore into media_input_pin(input_id,holder) values (?1,?2)", params![id, holder])
                .map_err(storage)?;
        }
        let result = admit(&tx)?;
        tx.commit().map_err(storage)?;
        Ok(result)
    }
    pub fn release(&self, holder: &str) -> Result<(), ApiError> {
        self.inner()
            .db
            .execute("delete from media_input_pin where holder=?1", [holder])
            .map_err(storage)?;
        Ok(())
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

impl vibevalley_server_api::media::MediaInputs for Inputs {
    fn upload(&self, id: &str, source: Box<dyn Read + Send>) -> Result<MediaInput, ApiError> {
        Inputs::upload(self, id, source)
    }
    fn content(&self, id: &str) -> Result<AttachmentFile, ApiError> {
        Inputs::content(self, id)
    }
}
