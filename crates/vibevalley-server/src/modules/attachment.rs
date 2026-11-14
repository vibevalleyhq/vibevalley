//! Files the farm keeps (VibeValley `platform/attachment`): each once by
//! the sha256 of its bytes, at `<home>/attachments/<sha256>`, described in
//! `server.db`'s `attachment` table. `attachment.create` as VibeValley
//! serves it, and VibeValley's `attachment.file` (the file's absolute path).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::Engine;
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, Attachment, AttachmentFile, AttachmentUpload, BizCode, native_ops, ops};

use crate::base::{internal, open_db};
use crate::{Hub, now};

/// `attachmentMax`: 25 MB.
pub const ATTACHMENT_MAX: usize = 25 * 1024 * 1024;

pub struct Attachments {
    root: PathBuf,
    db: Mutex<Connection>,
}

fn refused(text: String) -> ApiError {
    ApiError::new(BizCode::AttachmentRefused, text)
}

/// `missing(…, [])`: a miss with nowhere to look is `NotFound`.
fn no_attachment(id: &str) -> ApiError {
    ApiError::new(BizCode::NotFound, t("server.attachment.noAttachment", &[("id", id.into())]))
}

impl Attachments {
    pub fn open(home: &Path) -> rusqlite::Result<Arc<Attachments>> {
        let conn = open_db(home)?;
        conn.execute_batch(
            "create table if not exists attachment (
               id text primary key, name text not null, type text not null, size integer not null, created_at integer not null
             );",
        )?;
        Ok(Arc::new(Attachments {
            root: home.join("attachments"),
            db: Mutex::new(conn),
        }))
    }

    /// `pathOf`: where an attachment's bytes are (or would be).
    pub fn path_of(&self, id: &str) -> PathBuf {
        self.root.join(id)
    }

    fn db(&self) -> std::sync::MutexGuard<'_, Connection> {
        crate::lock(&self.db)
    }

    /// `attach`: an upload, as base64, kept.
    pub fn attach(&self, upload: &AttachmentUpload) -> Result<Attachment, ApiError> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(upload.data.trim())
            .map_err(|e| ApiError::new(BizCode::InvalidInput, format!("data: {e}")))?;
        if bytes.len() > ATTACHMENT_MAX {
            return Err(refused(t(
                "server.attachment.fileTooBig",
                &[("mb", ((ATTACHMENT_MAX as f64) / 1024.0 / 1024.0).round().into())],
            )));
        }
        self.keep(&bytes, &upload.name, &upload.r#type)
    }

    /// `keep`: bytes kept once by their sha256; no size limit.
    pub fn keep(&self, bytes: &[u8], name: &str, kind: &str) -> Result<Attachment, ApiError> {
        if bytes.is_empty() {
            return Err(refused(t("server.attachment.emptyFile", &[])));
        }
        let id = Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect::<String>();
        self.write_once(&id, bytes).map_err(|e| refused(e.to_string()))?;
        self.record(&id, name, kind, bytes.len() as i64)
    }

    /// Promote a verified private staging file on the same filesystem. The
    /// media input row records the intended hash before this is called.
    pub(crate) fn keep_staged(&self, path: &Path, hash: &str, size: i64, name: &str, kind: &str) -> Result<Attachment, ApiError> {
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(refused("invalid content hash".into()));
        }
        std::fs::create_dir_all(&self.root).map_err(|e| refused(e.to_string()))?;
        std::fs::rename(path, self.path_of(hash)).map_err(|e| refused(e.to_string()))?;
        self.record(hash, name, kind, size)
    }

    /// `writeOnce`: a file already there with these bytes is left; a new
    /// one is written beside it first, so nobody reads half of it.
    fn write_once(&self, id: &str, bytes: &[u8]) -> std::io::Result<()> {
        let target = self.path_of(id);
        if std::fs::metadata(&target).is_ok_and(|m| m.len() == bytes.len() as u64) {
            return Ok(());
        }
        std::fs::create_dir_all(&self.root)?;
        let staging = self.root.join(format!(".put-{}", uuid::Uuid::new_v4()));
        let mut f = std::fs::File::create(&staging)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&staging, &target)
    }

    fn record(&self, id: &str, given: &str, given_type: &str, size: i64) -> Result<Attachment, ApiError> {
        let name = if given.trim().is_empty() { "file" } else { given.trim() };
        let kind = if given_type.trim().is_empty() {
            "application/octet-stream"
        } else {
            given_type.trim()
        };
        let db = self.db();
        db.execute(
            "insert into attachment (id, name, type, size, created_at) values (?1, ?2, ?3, ?4, ?5) on conflict (id) do nothing",
            params![id, name, kind, size, now()],
        )
        .map_err(internal)?;
        Ok(Attachment {
            id: id.into(),
            name: name.into(),
            r#type: kind.into(),
            size,
        })
    }

    fn by_id(&self, id: &str) -> Result<Option<Attachment>, ApiError> {
        self.db()
            .query_row("select id, name, type, size from attachment where id = ?1", [id], |r| {
                Ok(Attachment {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    r#type: r.get(2)?,
                    size: r.get(3)?,
                })
            })
            .optional()
            .map_err(internal)
    }

    /// `of`: the attachments with these ids, each once; one not kept is
    /// refused.
    pub fn of(&self, ids: &[String]) -> Result<Vec<Attachment>, ApiError> {
        let mut out: Vec<Attachment> = vec![];
        for id in ids {
            if out.iter().any(|a| &a.id == id) {
                continue;
            }
            out.push(self.by_id(id)?.ok_or_else(|| no_attachment(id))?);
        }
        Ok(out)
    }

    /// `get`: the file of a kept attachment.
    pub fn file(&self, id: &str) -> Result<AttachmentFile, ApiError> {
        let a = self.by_id(id)?.ok_or_else(|| no_attachment(id))?;
        let path = self.path_of(&a.id);
        if !path.is_file() {
            return Err(no_attachment(id));
        }
        Ok(AttachmentFile {
            path: path.to_string_lossy().into_owned(),
            r#type: a.r#type,
            name: a.name,
        })
    }
}

pub fn install(hub: &Hub, files: Arc<Attachments>) {
    hub.on::<ops::AttachmentCreate>({
        let files = files.clone();
        move |_, upload| files.attach(&upload)
    });
    hub.on::<native_ops::AttachmentFile>(move |_, i| files.file(&i.id));
}
